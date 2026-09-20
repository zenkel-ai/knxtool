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

import Anthropic from "npm:@anthropic-ai/sdk@^0.71";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: buildPrompt(summary) }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    return jsonResponse({ text: textBlock?.text ?? "Keine Antwort erhalten." });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return jsonResponse({ error: error.message }, error.status ?? 500);
    }
    console.error("ask-ai: unerwarteter Fehler", error);
    return jsonResponse({ error: "Unbekannter Fehler bei der Analyse." }, 500);
  }
});
