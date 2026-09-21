// Server-seitiger Proxy für "KI-Analyse mit Claude" im KNX-Empfehlungen-Tab.
//
// Der Anthropic API-Key lebt NUR hier (Supabase Function Secret), nie im Browser -
// die alte Variante in index.html ließ jeden Nutzer seinen eigenen Key ins Browser-UI
// einfügen und rief api.anthropic.com direkt auf; da index.html als statische Datei
// ohne jede Zugriffskontrolle ausgeliefert wird, wäre ein dort hinterlegter fester Key
// für jeden Besucher der Seite sichtbar gewesen (Seitenquelltext genügt, kein Login
// nötig - Supabase Auth schützt nur die App-Ansicht, nicht die Auslieferung der Datei).
//
// Der Client schickt nur strukturierte Projektdaten (summary), nie fertigen Prompt-Text
// - der Prompt entsteht ausschließlich hier auf dem Server. Gleiches Prinzip wie in
// NormTracker (server/lib/aiPrompts.js): sonst wäre dieser Endpunkt ein Allzweck-LLM-
// Proxy für jeden mit gültiger Supabase-Session, nicht nur für die KNX-Analyse.
//
// Zugriffsschutz: Supabase Edge Functions verifizieren das Aufrufer-JWT standardmäßig
// (verify_jwt, siehe supabase/config.toml) - nur eingeloggte KNX-Tool-Nutzer:innen
// erreichen diese Funktion überhaupt. CORS bleibt bewusst offen (Access-Control-Allow-
// Origin: *), weil CORS nur eine Browser-Höflichkeit ist, keine echte Zugriffsschranke -
// die JWT-Prüfung ist die eigentliche Grenze, ein curl-Aufruf ohne gültiges Token schlägt
// unabhängig von CORS fehl.
//
// Rate-Limit (aus dem Sicherheitsaudit vom 2026-09-21, A04): jeder Aufruf kostet echtes
// Anthropic-Guthaben auf Stefans Konto, ohne Deckel könnte ein Bug im Client oder
// absichtlicher Missbrauch unkontrolliert Kosten verursachen. DAILY_LIMIT pro
// Organisation (nicht pro Nutzer:in - mehrere Logins einer Firma teilen sich das
// Kontingent, gleiches Prinzip wie die Projekt-Credits), rollierendes 24h-Fenster über
// ai_analysis_events (schema.sql) statt eines Reset-Zählers - kein Cronjob nötig.

import Anthropic from "npm:@anthropic-ai/sdk@^0.127";
import { createClient } from "npm:@supabase/supabase-js@^2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAILY_LIMIT = 20;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Exakt derselbe Prompt-Text, der vorher client-seitig in index.html stand - nur der
// Ausführungsort ändert sich (Server statt Browser), nicht der Inhalt/das Verhalten.
function buildPrompt(summary: unknown): string {
  return `Du bist ein erfahrener KNX-Elektroingenieur und Planungsspezialist. Analysiere diesen Jetplan-Stromlaufplan und gib konkrete KNX-Empfehlungen auf Deutsch.

Projektdaten (aus Jetplan-Export):
${JSON.stringify(summary, null, 2)}

Erstelle eine strukturierte technische Analyse mit folgenden Abschnitten:

## 1. Bewertung der KNX-Eignung
Kurze Einschätzung des Plans (2–3 Sätze).

## 2. Empfohlene KNX-Komponenten
Top 5 konkrete Komponenten mit:
- Funktion im Projekt
- Produktbeispiel (Hersteller, Bestellnummer)
- Warum hier notwendig

## 3. Empfohlene Gruppenadressenstruktur
Schlage eine sinnvolle Struktur vor:
- Hauptgruppe X/–/– : [Funktion]
  - Mittelgruppe X/Y/– : [Etage/Bereich]
    - X/Y/Z : Konkrete Gruppe

## 4. Fehlende oder ergänzende Komponenten
Was fehlt noch für ein vollständiges KNX-System?

## 5. Energiemanagement-Potential
Welche Einsparungen sind realistisch? Welche KNX-Funktionen helfen?

Antworte technisch präzise, max. 500 Wörter. Verwende Fachbegriffe korrekt.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Nur POST erlaubt." }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonResponse({ error: "ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt." }, 500);

  let summary: unknown;
  try {
    ({ summary } = await req.json());
  } catch {
    return jsonResponse({ error: "Ungültiger Request-Body (JSON erwartet)." }, 400);
  }
  if (!summary || typeof summary !== "object") {
    return jsonResponse({ error: "Feld 'summary' fehlt oder ist ungültig." }, 400);
  }

  // Aufrufer identifizieren (gleiches Muster wie create-checkout-session): eigener
  // Client nur zum Auslesen von auth.uid(), alle privilegierten Zugriffe (Org-Zuordnung,
  // Rate-Limit-Zähler) über den separaten Service-Role-Client.
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

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin
    .from("ai_analysis_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", membership.organization_id)
    .gte("created_at", since);
  if (countError) {
    console.error("ask-ai: Rate-Limit-Zähler konnte nicht gelesen werden", countError);
    return jsonResponse({ error: "Interner Fehler bei der Kontingentprüfung." }, 500);
  }
  if ((count ?? 0) >= DAILY_LIMIT) {
    return jsonResponse({
      error: `Tageslimit von ${DAILY_LIMIT} KI-Analysen pro Team erreicht. Bitte morgen erneut versuchen.`,
    }, 429);
  }

  // Zähler-Eintrag VOR dem eigentlichen Anthropic-Aufruf schreiben, nicht erst danach -
  // der Aufruf kostet Geld, sobald er raus geht, unabhängig davon ob die Antwort den
  // Client noch erreicht. Kein Row-Lock hier (anders als der Projekt-Kontingent-Trigger):
  // das ist eine weiche Kosten-Bremse, kein hartes Geschäftsregel-Limit - ein knapper
  // Overshoot bei zwei zeitgleichen Requests ist ein akzeptabler Kompromiss.
  const { error: logError } = await admin.from("ai_analysis_events").insert({ organization_id: membership.organization_id });
  if (logError) {
    console.error("ask-ai: Rate-Limit-Zähler konnte nicht geschrieben werden", logError);
    return jsonResponse({ error: "Interner Fehler bei der Kontingentprüfung." }, 500);
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      // Claude Opus 5 denkt standardmäßig (adaptive thinking) - die Denk-Token zählen
      // mit ins selbe max_tokens-Budget wie die sichtbare Antwort, deshalb Puffer über
      // den ca. 500 Wörtern (~700-1000 Tokens), die der Prompt anfordert.
      max_tokens: 8192,
      messages: [{ role: "user", content: buildPrompt(summary) }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    return jsonResponse({ text: textBlock?.text ?? "Keine Antwort erhalten." });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error("ask-ai: Anthropic-API-Fehler", error.status, error.message);
      return jsonResponse({ error: error.message }, error.status ?? 500);
    }
    console.error("ask-ai: unerwarteter Fehler", error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unbekannter Fehler bei der Analyse." }, 500);
  }
});
