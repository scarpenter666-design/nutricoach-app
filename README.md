# NutriCoach

Persönlicher KI-Ernährungsberater als installierbare Web-App (PWA). Neue Fassung auf dem
[zimmermannki-pwa-template](https://github.com/scarpenter666-design/zimmermannki-pwa-template).

- Adresse: `https://nutricoach.zimmermannki.de` (eigene Subdomain, eigener Speicher)
- Funktionen: Wochenplan per KI, Nährwerte, Meal-Prep, Einkaufsliste, Vorrat, Rezeptbibliothek, Kassenzettel scannen mit Preisvergleich
- KI: Modus „personal“. Der Anthropic-API-Key liegt nur im Browser des Geräts und kommt nie ins Backup (`js/core/ai.js`)
- Modell: in `app.config.js` unter `ai.model`

## Umzug aus der alten App

Alte Backup-Dateien (`nutricoach-backup-….json`, Keys `nc_…`) lassen sich direkt einspielen,
auf dem Startbildschirm oder unter **Mehr → Backup einspielen**. Der alte Key wird nicht übernommen.

## Entwickeln und testen

Lokal starten (Windows): im Ordner `py -m http.server 8000`, dann `http://localhost:8000`.

Automatischer Test im echten Chrome, die KI wird dabei nur simuliert (keine Kosten):

```
py tests/nutricoach.py                        # mit Beispieldaten
py tests/nutricoach.py pfad\zu\backup.json    # mit einem echten alten Backup
```

Backup-Dateien mit echten Daten nie ins Repo legen.

## Veröffentlichen

Push auf `main` → GitHub Action `Deploy` (Settings → Pages → Source: GitHub Actions).
Eigene Domain: `docs/eigene-subdomain.md`.
