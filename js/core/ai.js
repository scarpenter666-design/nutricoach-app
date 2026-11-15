/* ============================================================
   ai.js – KI-Anbindung im Modus "personal".

     const ai = createAI({ store });
     await ai.setKey('sk-ant-…');          // prüft das Format, speichert
     const data = await ai.ask({ system, messages, maxTokens: 4000 });
     const json = ai.parseJson(data);      // Antwort als JSON lesen

   Der API-Key liegt nur im Speicher dieser App (Eintrag "apikey",
   in app.config.js unter storage.secretNames, also nie im Backup)
   und geht direkt vom Browser an die KI-Schnittstelle. Kein Server.
   Deshalb nur für Apps, die man selbst mit eigenem Key nutzt.

   Einstellungen in app.config.js unter "ai": endpoint, apiVersion,
   model, temperature, timeoutSeconds, keyPrefix.
   Die Adresse von endpoint muss in der CSP bei connect-src stehen.
   ============================================================ */

export class AIError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'AIError';
    this.code = code; // no-key | bad-key | auth | limit | overloaded | network | timeout | api | format | too-long
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {object} options.store         von openStore()
 * @param {string} [options.keyName]     Name des Speicher-Eintrags für den Key
 */
export function createAI({ store, keyName = 'apikey' }) {
  const cfg = (self.APP_CONFIG && self.APP_CONFIG.ai) || {};
  const endpoint = cfg.endpoint || 'https://api.anthropic.com/v1/messages';
  const keyPrefix = cfg.keyPrefix || 'sk-ant-';
  let key = null;

  async function getKey() {
    if (key === null) key = (await store.get(keyName, '')) || '';
    return key;
  }

  async function hasKey() {
    return (await getKey()).startsWith(keyPrefix);
  }

  /** Speichert einen neuen Key. Wirft AIError('bad-key'), wenn das Format nicht passt. */
  async function setKey(value) {
    const clean = String(value || '').trim();
    if (!clean) throw new AIError('bad-key', 'Bitte einen API-Key eingeben.');
    if (!clean.startsWith(keyPrefix) || clean.length < 30 || /\s/.test(clean)) {
      throw new AIError('bad-key', `Das sieht nicht wie ein gültiger Key aus. Er beginnt mit „${keyPrefix}“.`);
    }
    await store.set(keyName, clean);
    key = clean;
  }

  async function removeKey() {
    await store.remove(keyName);
    key = '';
  }

  /** Kurzform zum Anzeigen, z. B. "sk-ant-api03…x9Qz". Nie den ganzen Key zeigen. */
  async function keyHint() {
    const value = await getKey();
    if (!value) return '';
    return value.slice(0, 12) + '…' + value.slice(-4);
  }

  function messageFor(status, apiMessage) {
    const text = apiMessage || '';
    if (status === 401) return new AIError('auth', 'Der API-Key wurde abgelehnt. Ist er widerrufen oder falsch? Neuen Key unter Mehr → KI eintragen.', status);
    if (status === 403) return new AIError('auth', 'Der API-Key hat keine Berechtigung für diese Anfrage.', status);
    if (status === 429) return new AIError('limit', 'Zu viele Anfragen oder Limit erreicht. Bitte kurz warten und noch einmal versuchen.', status);
    if (status === 529 || status === 503) return new AIError('overloaded', 'Die KI ist gerade überlastet. Bitte in ein paar Minuten noch einmal versuchen.', status);
    if (status === 400 && /credit|balance/i.test(text)) return new AIError('limit', 'Dein KI-Guthaben ist aufgebraucht. Bitte in der Anthropic-Konsole aufladen.', status);
    if (status === 404 && /model/i.test(text)) return new AIError('api', `Das Modell „${cfg.model}“ gibt es nicht (mehr). Bitte in app.config.js anpassen.`, status);
    return new AIError('api', `Fehler der KI-Schnittstelle (${status})${text ? ': ' + text : ''}`, status);
  }

  async function send(body, timeoutSeconds) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': await getKey(),
          'anthropic-version': cfg.apiVersion || '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new AIError('timeout', 'Die KI hat zu lange gebraucht. Bitte noch einmal versuchen.');
      }
      throw new AIError('network', navigator.onLine === false
        ? 'Keine Internetverbindung. Die KI braucht Internet.'
        : 'Die KI-Schnittstelle ist nicht erreichbar. Bitte Verbindung prüfen.');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await response.json(); } catch { /* leere Antwort */ }
    return { response, data };
  }

  /**
   * Schickt eine Anfrage an die KI.
   * @param {object}  options
   * @param {string}  [options.system]
   * @param {Array}   options.messages     [{ role: 'user', content: '…' | [Blöcke] }]
   * @param {number}  [options.maxTokens=4000]
   * @param {number|null} [options.temperature]  Standard aus app.config.js
   * @returns {Promise<object>} Antwort der Schnittstelle (content, stop_reason, …)
   */
  async function ask({ system, messages, maxTokens = 4000, temperature = cfg.temperature ?? null }) {
    if (!(await hasKey())) throw new AIError('no-key', 'Es ist noch kein API-Key eingetragen.');
    const body = { model: cfg.model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    if (temperature !== null && temperature !== undefined) body.temperature = temperature;
    const timeout = cfg.timeoutSeconds || 180;

    let { response, data } = await send(body, timeout);
    // Manche Modelle nehmen "temperature" nicht an. Dann einmal ohne versuchen.
    if (response.status === 400 && 'temperature' in body && /temperature/i.test(data?.error?.message || '')) {
      delete body.temperature;
      ({ response, data } = await send(body, timeout));
    }
    if (!response.ok) throw messageFor(response.status, data?.error?.message);
    if (!data || !Array.isArray(data.content)) throw new AIError('format', 'Die KI hat eine leere Antwort geschickt.');
    return data;
  }

  /** Text der Antwort (alle Textblöcke zusammen). */
  function textOf(data) {
    return (data.content || []).filter(block => block && block.type === 'text').map(block => block.text).join('');
  }

  /** Liest die Antwort als JSON. Entfernt ```json-Zäune und Text rundherum. */
  function parseJson(data) {
    let raw = textOf(data).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const start = raw.search(/[[{]/);
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    if (start > 0 || (end >= 0 && end < raw.length - 1)) raw = raw.slice(Math.max(start, 0), end + 1);
    try {
      return JSON.parse(raw);
    } catch {
      if (data.stop_reason === 'max_tokens') {
        throw new AIError('too-long', 'Die KI-Antwort war zu lang und wurde abgeschnitten. Bitte noch einmal versuchen, evtl. mit weniger Tagen.');
      }
      throw new AIError('format', 'Die KI-Antwort war nicht im erwarteten Format. Bitte noch einmal versuchen.');
    }
  }

  return { getKey, hasKey, setKey, removeKey, keyHint, ask, textOf, parseJson };
}
