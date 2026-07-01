# Jetplan → KNX Konverter

Web-App zur Analyse von Jetplan-Stromlaufplänen und Generierung von KNX-Projektdaten.

**Live:** https://knxtool.seed2peak.group

---

## Features

- Jetplan JSON Datei einlesen und analysieren
- Schaltgruppen mit KNX-Gruppenadressen automatisch zuordnen
- KI-gestützte Empfehlungen (via Claude API)
- Export: ETS-XML, Gruppenadressenliste (CSV), Geräteliste (CSV), HTML-Bericht

---

## Deployment

Die App deployed automatisch auf `knxtool.seed2peak.group` bei jedem Push auf `main`.

### Einmalige Einrichtung (siehe SETUP.md)

1. SSH-Key auf Hetzner KonsoleH hinterlegen
2. GitHub Secrets anlegen
3. Subdomain in KonsoleH einrichten

---

## Lokale Entwicklung

Einfach `index.html` im Browser öffnen — keine Build-Tools nötig.

---

## Projektstruktur

```
jetplan-knx-converter/
├── index.html              # Die komplette App (HTML/CSS/JS)
├── .github/
│   └── workflows/
│       └── deploy.yml      # Auto-Deploy via GitHub Actions
├── README.md
└── SETUP.md                # Einrichtungsanleitung
```
