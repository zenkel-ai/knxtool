// Öffnet Stripes gehostetes Customer Portal (Zahlungsmethode ändern, Rechnungen einsehen,
// Abo kündigen) statt einer eigenen Rechnungs-UI — gleiche Absicherung wie
// create-checkout-session: verify_jwt = true (supabase/config.toml), nur eingeloggte
// Nutzer:innen können das aufrufen. Braucht dasselbe STRIPE_SECRET_KEY-Secret, kein
// zusätzliches. Muss einmalig im Stripe-Dashboard aktiviert werden (Settings -> Billing ->
// Customer Portal), sonst schlägt der stripe.billingPortal.sessions.create()-Aufruf fehl.

import Stripe from "npm:stripe@^22.6";
import { createClient } from "npm:@supabase/supabase-js@^2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Nur POST erlaubt." }, 405);

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

  const { data: org } = await admin
    .from("organizations").select("stripe_customer_id").eq("id", membership.organization_id).single();
  if (!org?.stripe_customer_id) {
    return jsonResponse({ error: "Noch kein Kauf getätigt — es gibt noch nichts zu verwalten." }, 400);
  }

  const appUrl = req.headers.get("origin") || "https://app.knx-toolbox.de";
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${appUrl}/`,
  });

  return jsonResponse({ url: portalSession.url });
});
