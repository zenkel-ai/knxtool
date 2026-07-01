# Setup-Anleitung: Hetzner + GitHub Deployment

Folge diesen Schritten **einmalig**, danach läuft alles automatisch.

---

## Schritt 1 — SSH-Key für GitHub Actions erstellen

Auf deinem lokalen Rechner (Terminal / Git Bash / PowerShell):

```bash
ssh-keygen -t ed25519 -C "github-actions-knxtool" -f ~/.ssh/knxtool_deploy
```

Das erstellt zwei Dateien:
- `~/.ssh/knxtool_deploy`     → **Private Key** (kommt zu GitHub)
- `~/.ssh/knxtool_deploy.pub` → **Public Key**  (kommt zu Hetzner)

---

## Schritt 2 — Public Key in Hetzner KonsoleH hinterlegen

1. Einloggen unter https://konsoleh.hetzner.com
2. Links im Menü: **SSH-Zugang** → „SSH-Key hinzufügen"
3. Inhalt von `~/.ssh/knxtool_deploy.pub` einfügen:
   ```bash
   cat ~/.ssh/knxtool_deploy.pub
   ```
4. Speichern

Verbindung testen:
```bash
ssh bzipjy@www728.your-server.de -p 222
```

---

## Schritt 3 — Subdomain in KonsoleH einrichten

1. In KonsoleH: **Domains** → `seed2peak.group`
2. **Subdomains** → „Subdomain hinzufügen"
3. Subdomain: `knxtool`
4. Zielverzeichnis: `/html/knxtool`  ← neuer Unterordner, **nicht** `/html/`
5. Speichern — DNS ist nach ca. 5–15 Minuten aktiv

> ⚠️ Das Verzeichnis `/html/knxtool` ist vollständig getrennt vom bestehenden
> Webroot `/html/` — die bestehende Website unter seed2peak.group bleibt unberührt.

---

## Schritt 4 — GitHub Secret anlegen

In deinem Repository https://github.com/zenkel-ai/knxtool:

**Settings → Secrets and variables → Actions → New repository secret**

Nur **1 Secret** nötig:

| Secret Name | Wert |
|---|---|
| `SSH_PRIVATE_KEY` | Kompletter Inhalt von `~/.ssh/knxtool_deploy` |

Private Key anzeigen:
```bash
cat ~/.ssh/knxtool_deploy
```
Alles kopieren — inkl. `-----BEGIN OPENSSH PRIVATE KEY-----` und `-----END OPENSSH PRIVATE KEY-----`.

---

## Schritt 5 — Code ins Repository pushen

```bash
# In den entpackten Projektordner wechseln
cd jetplan-knx-converter

# Git initialisieren
git init
git add .
git commit -m "Initial commit: Jetplan KNX Konverter"

# Mit GitHub verbinden
git remote add origin git@github.com:zenkel-ai/knxtool.git
git branch -M main
git push -u origin main
```

GitHub Actions startet jetzt automatisch und deployed auf `knxtool.seed2peak.group`.

---

## Schritt 6 — Deployment prüfen

1. GitHub → Tab **Actions** → grüner Haken = erfolgreich
2. https://knxtool.seed2peak.group aufrufen

---

## Ab jetzt: Weiterentwicklung

```bash
# Änderungen machen, dann:
git add .
git commit -m "Beschreibung der Änderung"
git push
```

→ GitHub Actions deployed automatisch innerhalb von ~30 Sekunden ✓

---

## Verbindungsdaten (zur Referenz)

| | |
|---|---|
| SSH Host | `www728.your-server.de` |
| SSH User | `bzipjy` |
| SSH Port | `222` |
| Deploy-Pfad | `~/html/knxtool` |
| Live-URL | https://knxtool.seed2peak.group |
| GitHub Repo | https://github.com/zenkel-ai/knxtool |

---

## Troubleshooting

**Workflow schlägt fehl (Permission denied)**
→ Public Key nochmal in KonsoleH prüfen. Testen: `ssh bzipjy@www728.your-server.de -p 222`

**Subdomain zeigt nichts**
→ DNS braucht manchmal bis zu 30 Min. Testen: `ping knxtool.seed2peak.group`

**git clone schlägt fehl auf Server**
→ Das Repo ist Private? Dann HTTPS-Clone mit Token oder Repo auf Public stellen.
