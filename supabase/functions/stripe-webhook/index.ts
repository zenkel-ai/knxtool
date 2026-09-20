// Stripe ruft diesen Endpunkt auf (Checkout abgeschlossen, Rechnung bezahlt, Abo
// gekündigt, ...). verify_jwt = false (supabase/config.toml) ist hier BEWUSST richtig,
// nicht unsicher: Stripe hat kein Supabase-JWT, würde also von der normalen Prüfung immer
// abgelehnt. Die echte Absicherung ist Stripes eigene Signaturprüfung unten
// (STRIPE_WEBHOOK_SECRET) — ohne die könnte jeder beliebige POST-Request an diese URL
// kostenlos Kontingent gutschreiben.

import Stripe from "npm:stripe@^22.6";
import { createClient } from "npm:@supabase/supabase-js@^2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function orgIdForCustomer(customerId: string): Promise<string | null> {
  const { data } = await admin.from("organizations").select("id").eq("stripe_customer_id", customerId).maybeSingle();
  return data?.id ?? null;
}

// Idempotenz: jede Credits-verändernde Aktion protokolliert ihre stripe_event_id
// (unique) in credit_events. Ein Konflikt heißt "schon verarbeitet" (Stripe liefert
// Webhooks at-least-once, Wiederholungen sind normal) — dann nichts weiter tun statt
// einen Fehler zu werfen. Rückgabe true = neu, false = bereits bekannt.
async function recordEventOnce(organizationId: string, eventId: string, delta: number, reason: string): Promise<boolean> {
  const { error } = await admin.from("credit_events").insert({
    organization_id: organizationId, delta, reason, stripe_event_id: eventId,
  });
  if (error) {
    if (error.code === "23505") return false; // unique_violation
    throw error;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Nur POST erlaubt.", { status: 405 });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Fehlende Signatur.", { status: 400 });
  const rawBody = await req.text(); // roh, NICHT req.json() re-serialisiert — sonst bricht die Signaturprüfung

  let event: Stripe.Event;
  try {
    // constructEventAsync statt constructEvent: Deno hat kein Node-crypto-Modul, die
    // async-Variante nutzt stattdessen SubtleCrypto (Web Crypto) — Stripes eigene,
    // dokumentierte Empfehlung für Edge-/Deno-Umgebungen.
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("stripe-webhook: Signaturprüfung fehlgeschlagen", err);
    return new Response("Ungültige Signatur.", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = session.customer as string;
        const orgId = await orgIdForCustomer(customerId);
        if (!orgId) { console.error("stripe-webhook: keine Org für customer", customerId); break; }

        if (session.mode === "payment") {
          const isNew = await recordEventOnce(orgId, event.id, 1, "one_time_purchase");
          if (isNew) {
            const { error } = await admin.rpc("increment_one_time_credits", { p_org_id: orgId, p_delta: 1 });
            if (error) throw error;
          }
        } else if (session.mode === "subscription") {
          // Nur die Subscription-ID merken — Credits werden bewusst NICHT hier vergeben,
          // sondern einheitlich bei invoice.paid (deckt Erst- und Folgerechnung gleich ab,
          // verhindert eine doppelte Erstgutschrift). In Phase 2 ungenutzt (kein
          // Abo-Button live), Code steht schon für Phase 3 bereit.
          await admin.from("organizations").update({ stripe_subscription_id: session.subscription as string }).eq("id", orgId);
        }
        break;
      }

      case "invoice.paid": {
        // Einzige Stelle, die Abo-Credits vergibt/zurücksetzt — deckt Erst- und
        // Folgerechnung einheitlich ab. Phase 2: noch unerreichbar (kein Abo-Button live),
        // Handler steht schon für Phase 3 bereit.
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const orgId = await orgIdForCustomer(customerId);
        if (!orgId) { console.error("stripe-webhook: keine Org für customer", customerId); break; }

        const isNew = await recordEventOnce(orgId, event.id, 10, "subscription_renewed");
        if (isNew) {
          // period.end wird defensiv gelesen (optional) - falls sich die Stripe-API hier
          // je anders formt als angenommen, geht dabei nur current_period_end verloren
          // (Anzeige-Detail), nicht die eigentliche Kontingent-Gutschrift.
          const periodEnd = invoice.lines?.data?.[0]?.period?.end;
          const { error } = await admin.from("organizations").update({
            subscription_credits: 10,
            subscription_status: "active",
            current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            updated_at: new Date().toISOString(),
          }).eq("id", orgId);
          if (error) throw error;
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const orgId = await orgIdForCustomer(sub.customer as string);
        if (!orgId) break;
        const { error } = await admin.from("organizations").update({
          subscription_status: sub.status,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        }).eq("id", orgId);
        if (error) throw error;
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const orgId = await orgIdForCustomer(sub.customer as string);
        if (!orgId) break;
        const { error } = await admin.from("organizations").update({
          subscription_credits: 0, subscription_status: "canceled", updated_at: new Date().toISOString(),
        }).eq("id", orgId);
        if (error) throw error;
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const orgId = await orgIdForCustomer(invoice.customer as string);
        if (!orgId) break;
        const { error } = await admin.from("organizations")
          .update({ subscription_status: "past_due", updated_at: new Date().toISOString() }).eq("id", orgId);
        if (error) throw error;
        break;
      }

      default:
        // andere Events (z.B. weitere invoice.*-Varianten) ignorieren wir bewusst
        break;
    }
  } catch (err) {
    console.error(`stripe-webhook: Fehler bei ${event.type}`, err);
    return new Response("Interner Fehler.", { status: 500 }); // Stripe wiederholt automatisch
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
