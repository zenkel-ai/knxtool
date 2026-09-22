// Startet einen Stripe-Checkout für den Kauf von Projekt-Kontingent (Einmalkauf oder
// Jahresplan). Secrets liegen nur hier (STRIPE_SECRET_KEY, STRIPE_PRICE_ONE_TIME,
// STRIPE_PRICE_SUBSCRIPTION) — gleiche Absicherung wie bei ask-ai: verify_jwt = true
// (supabase/config.toml), nur eingeloggte Nutzer:innen können das aufrufen.
//
// Zuordnungslogik (wichtig für den Webhook): spätestens hier bekommt jede Org ihre erste
// stripe_customer_id. Der Webhook ordnet jedes spätere Stripe-Event über genau diese
// customer_id der richtigen Org zu (organizations.stripe_customer_id ist unique-
// indexiert) — metadata/client_reference_id werden zusätzlich gesetzt, aber nur zur
// Nachvollziehbarkeit im Stripe-Dashboard, nicht als das, worauf sich der Webhook stützt.

import Stripe from "npm:stripe@^22.6";
import { createClient } from "npm:@supabase/supabase-js@^2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// Stripe.createFetchHttpClient(): Stripes Standard-HTTP-Client setzt auf Node-eigene
// http/https-Module, die es in Deno nicht gibt — dieser fetch-basierte Client ist Stripes
// eigene, dokumentierte Lösung für Deno/Edge-Umgebungen. Kein apiVersion-Pin gesetzt —
// bewusst, um keine geratene/veraltete Versions-Zeichenkette festzuschreiben (siehe
// ask-ai's SDK-Versions-Bug); ohne Angabe nutzt das SDK seinen eigenen eingebauten
// Default, garantiert konsistent mit der installierten Paketversion.
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});

const PRICE_IDS: Record<string, string | undefined> = {
  one_time: Deno.env.get("STRIPE_PRICE_ONE_TIME"),
  subscription: Deno.env.get("STRIPE_PRICE_SUBSCRIPTION"),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Nur POST erlaubt." }, 405);

  let planType: string;
  try {
    ({ planType } = await req.json());
  } catch {
    return jsonResponse({ error: "Ungültiger Request-Body." }, 400);
  }
  if (planType !== "one_time" && planType !== "subscription") {
    return jsonResponse({ error: "planType muss 'one_time' oder 'subscription' sein." }, 400);
  }
  const priceId = PRICE_IDS[planType];
  if (!priceId) {
    const envName = planType === "one_time" ? "STRIPE_PRICE_ONE_TIME" : "STRIPE_PRICE_SUBSCRIPTION";
    return jsonResponse({ error: `${envName} ist auf dem Server nicht gesetzt.` }, 500);
  }

  // Aufrufer identifizieren: eigener Client mit dem Authorization-Header des Aufrufers,
  // nur zum Auslesen von auth.uid()/E-Mail. Alle privilegierten Lese-/Schreibzugriffe
  // (organizations/organization_members sind für "authenticated" per RLS nicht
  // schreibbar) laufen über den separaten Service-Role-Client.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Nicht angemeldet." }, 401);
  const callerClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: "Nicht angemeldet." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: membership } = await admin
    .from("organization_members").select("organization_id").eq("user_id", userData.user.id).maybeSingle();
  if (!membership) return jsonResponse({ error: "Keinem Team zugeordnet." }, 400);

  const { data: org, error: orgError } = await admin
    .from("organizations").select("id, stripe_customer_id, subscription_status")
    .eq("id", membership.organization_id).single();
  if (orgError || !org) return jsonResponse({ error: "Team nicht gefunden." }, 404);

  if (planType === "subscription" && org.subscription_status === "active") {
    return jsonResponse({ error: "Dieses Team hat bereits einen aktiven Jahresplan." }, 400);
  }

  let customerId = org.stripe_customer_id as string | null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userData.user.email,
      metadata: { organization_id: org.id },
    });
    customerId = customer.id;
    await admin.from("organizations").update({ stripe_customer_id: customerId }).eq("id", org.id);
  }

  const appUrl = req.headers.get("origin") || "https://knxtool.seed2peak.group";
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: planType === "one_time" ? "payment" : "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: org.id,
    metadata: { organization_id: org.id },
    // Checkout-Session-Metadata vererbt sich NICHT automatisch auf das Subscription-/
    // Invoice-Objekt, das spätere Verlängerungs-Webhooks tragen — deshalb hier zusätzlich
    // explizit auf subscription_data gesetzt (nur relevant für planType 'subscription',
    // in Phase 2 ungenutzt, schon für Phase 3 vorbereitet).
    ...(planType === "subscription" ? { subscription_data: { metadata: { organization_id: org.id } } } : {}),
    // Ohne das erzeugt ein mode:'payment'-Checkout standardmäßig KEINE Stripe-Rechnung -
    // nur mit dieser Option taucht ein Einzelkauf im Stripe-Kundenportal ("Abo verwalten")
    // unter Rechnungsverlauf auf. Nur für 'payment' gültig, Abos bekommen ohnehin pro
    // Abrechnungszyklus automatisch eine Rechnung, diese Option existiert für sie nicht.
    ...(planType === "one_time" ? { invoice_creation: { enabled: true } } : {}),
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/?checkout=cancel`,
  });

  return jsonResponse({ url: session.url });
});
