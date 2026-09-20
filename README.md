# Jetplan → KNX Konverter

Web-App zur Analyse von Jetplan-Stromlaufplänen und Generierung von KNX-Projektdaten.

**Live:** https://knxtool.seed2peak.group

---

## Features

- Login per Magic Link (Supabase Auth), Projekte werden geteilt im Team verwaltet
- Jetplan JSON Datei einlesen und analysieren
- Schaltgruppen mit KNX-Gruppenadressen automatisch zuordnen (inkl. Dimmen/Jalousie/Messen)
- Tabellen sortier- und filterbar, Geräte/Projekte bearbeitbar
- KI-gestützte Empfehlungen (via Claude API, über eine Supabase Edge Function — der API-Key liegt nur serverseitig)
- Export: ETS-XML, Gruppenadressenliste (CSV), Geräteliste (CSV), HTML-Bericht, Projektstand (JSON)

---

## Deployment

Die App deployed automatisch auf `knxtool.seed2peak.group` bei jedem Push auf `main`.

### Einmalige Einrichtung (siehe SETUP.md)

1. SSH-Key auf Hetzner KonsoleH hinterlegen
2. GitHub Secrets anlegen
3. Subdomain in KonsoleH einrichten
4. Supabase-Schema aus `supabase/schema.sql` einmalig im Supabase SQL Editor ausführen
   und unter Authentication → URL Configuration die Site URL/Redirect URLs setzen
5. Edge Function für die KI-Analyse einmalig deployen (Key bleibt serverseitig, nie im
   Browser/Quellcode):
   ```bash
   npx supabase login
   npx supabase link --project-ref qmbmskthgxdmybvqyoax
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy ask-ai
   ```

---

## Lokale Entwicklung

Einfach `index.html` im Browser öffnen — keine Build-Tools nötig (Supabase-Client wird per CDN geladen).

---

## Projektstruktur

```
jetplan-knx-converter/
├── index.html              # Die komplette App (HTML/CSS/JS)
├── knx-reference/          # Von Paul (Neudecker Elektrotechnik) gelieferte KNX-Referenzdaten
├── supabase/
│   ├── schema.sql          # DB-Schema + RLS-Policies (manuell in Supabase SQL Editor ausführen)
│   ├── config.toml         # Edge-Function-Konfiguration (verify_jwt)
│   └── functions/
│       └── ask-ai/         # Server-Proxy für die Claude-Analyse (Key liegt nur hier)
├── .github/
│   └── workflows/
│       └── deploy.yml      # Auto-Deploy via GitHub Actions
├── README.md
└── SETUP.md                # Einrichtungsanleitung
```
