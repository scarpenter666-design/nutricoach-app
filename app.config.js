/* ============================================================
   app.config.js – die EINZIGE Konfiguration dieser App.
   Klassisches Script (kein ES-Modul), weil auch der Service
   Worker diese Datei per importScripts() lädt.
   Keine Geheimnisse hier eintragen: Die Datei ist öffentlich.
   ============================================================ */
self.APP_CONFIG = {
  // Kurzname: nur a–z, 0–9 und Bindestrich. Prefix für Speicher-Keys
  // ("nutricoach.…") und Cache-Namen. NIE mehr ändern.
  id: 'nutricoach',

  name: 'NutriCoach',
  shortName: 'NutriCoach',

  // Neue App auf eigener Subdomain: null lassen (Manifest-id ist "/").
  manifestId: null,

  storage: {
    schemaVersion: 1,

    // Ohne Passwort (Entscheidung Sven, 15.11.2026). Die App liegt auf
    // eigener Adresse, andere Apps kommen nicht an ihren Speicher.
    encryption: 'none',
    autoLockMinutes: 30,

    legacyKeys: {},
    legacySchemaVersion: 1,
    rawNames: [],

    // Der API-Key landet NIE im Backup.
    secretNames: ['apikey']
  },

  // KI-Anbindung (js/core/ai.js), Modus "personal": Der Key liegt nur im
  // Browser des Nutzers und geht direkt an die KI-Schnittstelle.
  // Die Adresse muss auch in index.html bei connect-src stehen.
  ai: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiVersion: '2023-06-01',
    model: 'claude-sonnet-5-5',   // Modell hier wechseln, nicht im Code
    temperature: 0.8,             // null = Standard des Modells
    timeoutSeconds: 180,
    keyPrefix: 'sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },

  backup: {
    remindAfterDays: 30,
    snoozeDays: 7
  },

  update: {
    checkEveryMinutes: 60
  },

  sw: {
    networkTimeoutMs: 3000
  }
};
