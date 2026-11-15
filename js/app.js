/* ============================================================
   app.js – NutriCoach, KI-Ernährungsberater.
   Neue Fassung auf dem zimmermannki-pwa-template (15.11.2026).
   Funktionen wie in der alten App: Wochenplan per KI, Nährwerte,
   Einkaufsliste, Meal-Prep, Rezeptbibliothek, Vorrat, Kassenzettel
   scannen mit Preisvergleich.

   Einträge im Speicher (Key "nutricoach.<name>"). Die Namen
   entsprechen den alten Keys ohne "nc_", deshalb lassen sich alte
   Backups direkt einspielen (legacyPrefixAdapter):
     plan, profile, shopping, library, pantry, receipts,
     price_alerts, meal_history, cuisine_idx
     apikey   nur auf dem Gerät, nie im Backup (storage.secretNames)

   Alles, was von der KI oder aus Eingaben kommt, wird vor der
   Anzeige maskiert (esc). Keine Inline-Handler, keine Inline-Styles.
   ============================================================ */
import { openStore, StorageError } from './core/storage.js';
import { createBackup, BackupError, legacyPrefixAdapter } from './core/backup.js';
import { initUpdates, getVersion } from './core/update-banner.js';
import { initInstall, isStandalone } from './core/install.js';
import { toast } from './core/notice.js';
import { createAI, AIError } from './core/ai.js';

const config = self.APP_CONFIG;
const $ = id => document.getElementById(id);

// ── 1. Speicher, Backup, KI ─────────────────────────────────
const store = await openStore();
const backup = createBackup({
  store,
  adapters: [legacyPrefixAdapter({ prefix: 'nc_', ignore: ['nc_apikey'] })]
});
const ai = createAI({ store });

const state = {
  plan: await store.get('plan', null),
  profile: await store.get('profile', null),
  shopping: await store.get('shopping', {}),
  library: await store.get('library', []),
  pantry: await store.get('pantry', []),
  receipts: await store.get('receipts', []),
  mpDays: await store.get('mealprep_days', {})
};
for (const name of ['library', 'pantry', 'receipts']) if (!Array.isArray(state[name])) state[name] = [];
if (!state.shopping || typeof state.shopping !== 'object') state.shopping = {};
if (!state.mpDays || typeof state.mpDays !== 'object') state.mpDays = {};
if (state.plan && !Array.isArray(state.plan)) state.plan = null;

async function save(name, value) {
  try {
    await store.set(name, value);
    return true;
  } catch (error) {
    toast(error instanceof StorageError ? error.message : 'Speichern fehlgeschlagen.', 6000);
    return false;
  }
}

// ── 2. Hilfen ───────────────────────────────────────────────
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ESC[char]);
const num = value => { const n = Number(String(value ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const money = value => num(value).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const today = () => new Date().toLocaleDateString('de-DE');
const newId = () => crypto.randomUUID();
const meals = day => (day && Array.isArray(day.meals) ? day.meals : []);

function emptyState(icon, title, sub = '') {
  return `<div class="empty"><div class="empty__icon">${icon}</div><div class="empty__title">${esc(title)}</div>${sub ? `<div class="muted">${esc(sub)}</div>` : ''}</div>`;
}

function confirmDialog({ title, text, yes = 'OK', danger = false }) {
  return new Promise(resolve => {
    const dialog = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yes;
    $('confirmYes').className = danger ? 'btn btn--danger' : 'btn';
    const finish = answer => {
      $('confirmYes').removeEventListener('click', onYes);
      $('confirmNo').removeEventListener('click', onNo);
      dialog.removeEventListener('cancel', onNo);
      dialog.close();
      resolve(answer);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    $('confirmYes').addEventListener('click', onYes);
    $('confirmNo').addEventListener('click', onNo);
    dialog.addEventListener('cancel', onNo);
    dialog.showModal();
  });
}

// ── 3. Ansichten ────────────────────────────────────────────
let currentView = null;
function showView(name) {
  currentView = name;
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
  const navTarget = name === 'form' || name === 'loading' ? 'plan' : name;
  for (const button of document.querySelectorAll('[data-nav]')) {
    if (button.dataset.nav === navTarget) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('mainNav').hidden = name === 'setup';
  $('main').scrollTop = 0;
  if (name === 'plan') renderPlanArea();
  if (name === 'shopping') { renderShopping(); renderPantry(); }
  if (name === 'library') renderLibrary();
  if (name === 'receipts') renderReceipts();
  if (name === 'more') renderMore();
}

function showSub(key) {
  const [group] = key.split(':');
  for (const button of document.querySelectorAll(`[data-sub^="${group}:"]`)) button.setAttribute('aria-pressed', String(button.dataset.sub === key));
  for (const box of document.querySelectorAll(`[data-subview^="${group}:"]`)) box.hidden = box.dataset.subview !== key;
}

function openPlanOrForm() {
  if (state.plan) showView('plan');
  else openForm();
}

// ── 4. Plan-Formular ────────────────────────────────────────
const CUISINES = {
  deutsch: 'deutsche Hausmannskost, kalorienbewusst und leicht interpretiert (mageres Fleisch, viel Gemüse, Kartoffeln, Vollkorn; keine Sahnesoßen, nichts Frittiertes)',
  mediterran: 'mediterran (italienisch, griechisch, spanisch)',
  skandinavisch: 'skandinavisch',
  franzoesisch: 'französische Bistro-Küche, leicht',
  asiatisch: 'asiatisch (thailändisch, japanisch, koreanisch, vietnamesisch)',
  orientalisch: 'orientalisch (türkisch, libanesisch, persisch)',
  indisch: 'indisch',
  mexikanisch: 'mexikanisch'
};
const CUISINE_LABELS = {
  deutsch: 'Deutsch (leicht)', mediterran: 'Mediterran', skandinavisch: 'Skandinavisch', franzoesisch: 'Französisch',
  asiatisch: 'Asiatisch', orientalisch: 'Orientalisch', indisch: 'Indisch', mexikanisch: 'Mexikanisch'
};
const DEFAULT_CUISINES = ['deutsch', 'mediterran'];
const CUISINE_WORDS = [
  ['deutsch', /deutsch|hausmann/], ['mediterran', /mediterran|italien|griech|spanisch/], ['skandinavisch', /skandinav|schwed|dänisch|daenisch|norweg|nordisch/],
  ['franzoesisch', /franz|bistro/], ['asiatisch', /asiat|thai|japan|korea|vietnam|chines/], ['orientalisch', /orient|türk|tuerk|libanes|persisch|arab/],
  ['indisch', /indisch/], ['mexikanisch', /mexik/]
];
/** Küchen-Angabe (Schlüssel oder freier Text der KI) auf einen Schlüssel abbilden. null = unbekannt. */
function normalizeCuisine(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) return null;
  if (CUISINES[text]) return text;
  const hit = CUISINE_WORDS.find(([, pattern]) => pattern.test(text));
  return hit ? hit[0] : null;
}
const FIELDS = ['goal', 'budget', 'persons', 'days', 'diet', 'mealprep', 'dinner', 'batch', 'shopformat', 'gender', 'age', 'height', 'weight', 'activity', 'training', 'allergies', 'dislikes'];

function buildCuisineChips() {
  const box = $('cuisineChips');
  box.replaceChildren();
  for (const [value, label] of Object.entries(CUISINE_LABELS)) {
    const chip = document.createElement('label');
    chip.className = 'chip';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'pf-cuisine';
    input.value = value;
    input.checked = DEFAULT_CUISINES.includes(value);
    const span = document.createElement('span');
    span.textContent = label;
    chip.append(input, span);
    box.append(chip);
  }
}

function fillForm() {
  const p = state.profile;
  if (!p) return;
  for (const field of FIELDS) {
    const input = $('pf-' + field);
    if (!input || p[field] === undefined || p[field] === null) continue;
    let value = p[field];
    if ((field === 'allergies' || field === 'dislikes') && value === 'keine') value = '';
    if (field === 'training' && String(value) === '0') value = '';
    if (input.tagName === 'SELECT' && ![...input.options].some(option => option.value === String(value))) continue;
    input.value = value;
  }
  const chosen = Array.isArray(p.cuisines) && p.cuisines.length ? p.cuisines : DEFAULT_CUISINES;
  for (const box of document.querySelectorAll('input[name="pf-cuisine"]')) box.checked = chosen.includes(box.value);
}

function readForm() {
  const profile = {};
  for (const field of FIELDS) profile[field] = $('pf-' + field).value.trim();
  profile.allergies = profile.allergies || 'keine';
  profile.dislikes = profile.dislikes || 'keine';
  profile.training = profile.training || '0';
  const chosen = [...document.querySelectorAll('input[name="pf-cuisine"]:checked')].map(box => box.value);
  profile.cuisines = chosen.length ? chosen : DEFAULT_CUISINES;
  return profile;
}

function openForm() {
  const isNew = Boolean(state.plan);
  $('formTitle').textContent = isNew ? '✨ Neuen Plan erstellen' : '👋 Lass uns starten!';
  $('formIntro').textContent = isNew
    ? 'Passe deine Angaben an und erstelle einen neuen Plan. Der bisherige Plan wird ersetzt, seine Rezepte bleiben in der Bibliothek.'
    : 'Beantworte kurz ein paar Fragen, damit ich den passenden Plan für dich erstellen kann.';
  $('formCancel').hidden = !isNew;
  fillForm();
  showView('form');
}

// ── 5. Plan erstellen (KI) ──────────────────────────────────
const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const ACTIVITY = {
  'wenig aktiv (Bürojob, kaum Sport)': 1.2,
  'moderat aktiv (1-3x Sport/Woche)': 1.375,
  'sehr aktiv (4-5x Sport/Woche)': 1.55,
  'extrem aktiv (täglich intensiv)': 1.725
};
const cuisineShort = key => CUISINES[key].split(' (')[0].split(',')[0];
const batchFlags = batch => ({ lunch: batch === 'mittag' || batch === 'beide', dinner: batch === 'beide' });

async function recentMealNames() {
  const history = await store.get('meal_history', []);
  let names = (Array.isArray(history) ? history : []).slice(-3).flatMap(entry => entry.names || []);
  if (!names.length) names = state.library.slice(-30).map(recipe => recipe.name);
  return [...new Set(names)].slice(-40);
}

async function recordMealHistory(plan) {
  const names = [...new Set(plan.flatMap(day => meals(day).map(meal => meal.name)))];
  const history = await store.get('meal_history', []);
  const next = [...(Array.isArray(history) ? history : []), { date: new Date().toISOString().slice(0, 10), names }].slice(-6);
  await save('meal_history', next);
}

/** Feste Küchen-Zuteilung je Mahlzeit. Mittag und Abend unterscheiden sich, über die Tage wird rotiert. */
async function buildCuisineSchedule(selected, days, batch) {
  const sel = (selected && selected.length ? selected : DEFAULT_CUISINES).filter(key => CUISINES[key]);
  const count = Math.max(1, Math.min(7, parseInt(days, 10) || 5));
  const flags = batchFlags(batch);
  const offset = parseInt(await store.get('cuisine_idx', 0), 10) || 0;
  await save('cuisine_idx', (offset + 1) % Math.max(sel.length, 1));
  const schedule = [];
  for (let i = 0; i < count; i++) {
    const li = flags.lunch ? Math.floor(i / 2) : i;
    const di = flags.dinner ? Math.floor(i / 2) : i;
    const lunch = sel[(offset + li) % sel.length];
    let dinner = sel[(offset + di + 1) % sel.length];
    if (dinner === lunch && sel.length > 1) dinner = sel[(sel.indexOf(lunch) + 1) % sel.length];
    const leftover = i % 2 === 1;
    schedule.push({
      day: WEEKDAYS[i], lunch, dinner,
      lunchFrom: flags.lunch && leftover ? WEEKDAYS[i - 1] : null,
      dinnerFrom: flags.dinner && leftover ? WEEKDAYS[i - 1] : null
    });
  }
  return schedule;
}

/** Reste-Tage im Code befüllen: Kopie vom Kochtag, als Rest markiert. */
function applyLeftovers(plan, schedule) {
  const byDay = {};
  plan.forEach(day => { if (day && day.day) byDay[day.day] = day; });
  return schedule.map((slot, i) => {
    const src = byDay[slot.day] || plan[i] || { day: slot.day, meals: [] };
    const result = [];
    for (const [type, from] of [['Mittag', slot.lunchFrom], ['Abend', slot.dinnerFrom]]) {
      if (from) {
        const cook = meals(byDay[from] || plan[i - 1]).find(meal => meal.type === type && !meal.leftover);
        if (cook) { result.push({ ...cook, leftover: true, cookedOn: from }); continue; }
      }
      const own = meals(src).find(meal => meal.type === type);
      if (own) result.push(own);
    }
    return { ...src, day: slot.day, meals: result };
  });
}

function dinnerRule(dinner) {
  if (dinner === 'warm') return '- Abendessen: warme Gerichte erlaubt, aber leichter und schneller als das Mittagessen (max. 25 Min. Zubereitung)';
  if (dinner === 'gemischt') return '- Abendessen: an höchstens jedem zweiten Tag warm (dann leicht, max. 20 Min.); an den übrigen Tagen kalt (Brotzeit, Salat, Bowl, Wrap, Quark-/Joghurt-Gericht)';
  return '- Abendessen: IMMER kalte oder kaum gekochte, schnelle Gerichte (max. 15 Min.), z.B. Vollkornbrot mit Belag, Salat mit Eiweißquelle, kalte Bowl, Wrap, Quark-/Joghurt-Gericht, Hüttenkäse-Teller. KEINE Aufläufe, Pfannengerichte, Eintöpfe, Pasta- oder Reisgerichte am Abend – die gehören zum Mittag.';
}

const SYSTEM_PROMPT = `Du bist NutriCoach, ein spezialisierter KI-Ernährungsberater.
Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt. Kein Text davor oder danach.

WICHTIG: Jeder Tag MUSS exakt 2 Mahlzeiten enthalten: eine mit "type": "Mittag" UND eine mit "type": "Abend". Niemals nur eine Mahlzeit pro Tag!

Das JSON-Objekt muss exakt folgende Struktur haben:
{
  "plan": [
    {
      "day": "Montag",
      "meals": [
        {
          "type": "Mittag",
          "cuisine": "Schlüssel der zugeteilten Küche: deutsch | mediterran | skandinavisch | franzoesisch | asiatisch | orientalisch | indisch | mexikanisch",
          "name": "Gerichtname",
          "mealprep": true/false,
          "calories": 650,
          "protein": 45,
          "carbs": 60,
          "fat": 18,
          "time": 25,
          "difficulty": "Einfach",
          "servings": 2,
          "ingredients": [
            {"name": "Zutat 1", "amount": "300g", "alt": "Alternative"},
            {"name": "Zutat 2", "amount": "200g", "alt": null}
          ],
          "steps": [
            "Kurzer Zubereitungsschritt.",
            "Kurzer Zubereitungsschritt."
          ],
          "mealprepTip": "Haltbarkeit und Lagerhinweis (oder null)"
        }
      ]
    }
  ],
  "shopping": {
    "byCategory": {
      "Gemüse & Obst": [{"name": "Zutat", "amount": "500g"}],
      "Fleisch & Fisch": [],
      "Kühlregal": [],
      "Tiefkühl": [],
      "Trockenwaren & Konserven": [],
      "Gewürze & Sonstiges": []
    },
    "byRecipe": [
      {"recipe": "Gerichtname", "items": [{"name": "Zutat 1", "amount": "300g"}]}
    ],
    "estimatedCost": "ca. 38€"
  }
}`;

async function buildUserPrompt(profile) {
  let kcalInfo = '';
  if (profile.age && profile.height && profile.weight) {
    const age = parseInt(profile.age, 10);
    const height = parseInt(profile.height, 10);
    const weight = parseInt(profile.weight, 10);
    const training = parseInt(profile.training, 10) || 0;
    const bmr = profile.gender === 'männlich'
      ? 10 * weight + 6.25 * height - 5 * age + 5
      : 10 * weight + 6.25 * height - 5 * age - 161;
    const tdee = Math.round(bmr * (ACTIVITY[profile.activity] || 1.375)) + training;
    let target = tdee;
    if (profile.goal === 'Muskelaufbau') target = tdee + 300;
    if (profile.goal === 'Abnehmen') target = tdee - 500;
    kcalInfo = `
- Körperdaten: ${profile.gender}, ${age} Jahre, ${height} cm, ${weight} kg
- Aktivitätslevel: ${profile.activity}
- Ø Trainingsverbrauch: ${training} kcal/Tag (z.B. aus IronLog)
- Berechneter Gesamtbedarf (TDEE): ${tdee} kcal/Tag
- Ziel-Kalorienzufuhr über Ernährung: ca. ${target} kcal/Tag (aufgeteilt auf Mittag + Abend)
- Proteinziel: ca. ${Math.round(weight * (profile.goal === 'Muskelaufbau' ? 2.0 : 1.6))}g/Tag`;
  }

  const pantryInfo = state.pantry.length
    ? '\n- Bereits im Vorrat (bitte in Planung berücksichtigen, Einkaufsliste entsprechend reduzieren): ' + state.pantry.map(item => `${item.name} (${item.amount})`).join(', ')
    : '';
  const recent = await recentMealNames();
  const recentInfo = recent.length
    ? '\n- Diese Gerichte gab es zuletzt – NICHT wiederholen und auch keine Variante davon (gleiches Hauptgericht mit anderer Beilage oder anderem Gewürz zählt als Wiederholung): ' + recent.join(', ')
    : '';
  const selected = (profile.cuisines && profile.cuisines.length ? profile.cuisines : DEFAULT_CUISINES).filter(key => CUISINES[key]);
  const schedule = await buildCuisineSchedule(selected, profile.days, profile.batch);
  const scheduleText = schedule.map((day, i) => {
    const nextLunch = schedule[i + 1] && schedule[i + 1].lunchFrom === day.day;
    const nextDinner = schedule[i + 1] && schedule[i + 1].dinnerFrom === day.day;
    const lunch = day.lunchFrom ? `RESTE von ${day.lunchFrom} – nur {"type":"Mittag","leftover":true}` : cuisineShort(day.lunch) + (nextLunch ? ' – KOCHEN für 2 Tage' : '');
    const dinner = day.dinnerFrom ? `RESTE von ${day.dinnerFrom} – nur {"type":"Abend","leftover":true}` : cuisineShort(day.dinner) + (nextDinner ? ' – KOCHEN für 2 Tage' : '');
    return `  ${day.day}: Mittag = ${lunch}, Abend = ${dinner}`;
  }).join('\n');
  const hasBatch = schedule.some(day => day.lunchFrom || day.dinnerFrom);
  const batchRule = hasBatch ? `
- 2-Tage-Gerichte: Bei "KOCHEN für 2 Tage" das Rezept für BEIDE Tage schreiben (Zutatenmengen und "servings" verdoppelt, Nährwerte weiterhin pro Portion/Mahlzeit), "mealprepTip" mit Lagerung bis zum nächsten Tag. Nur Gerichte wählen, die sich gut aufwärmen bzw. am Folgetag noch gut schmecken (Eintopf, Schmorgericht, Auflauf, Curry, Ofengemüse; keine knusprigen oder frisch angerichteten Sachen).
- Bei "RESTE von …" KEIN neues Gericht erfinden, nur das kurze Platzhalter-Objekt ausgeben.
- Einkaufsliste: Reste-Tage nicht extra einkaufen, sie sind im Kochtag schon enthalten.` : '';
  const cuisineDefs = selected.map(key => `  ${cuisineShort(key)} = ${CUISINES[key]}`).join('\n');
  const excluded = Object.keys(CUISINES).filter(key => !selected.includes(key)).map(cuisineShort);

  const prompt = `Erstelle einen Ernährungsplan mit folgenden Vorgaben:
- Fitnessziel: ${profile.goal}
- Ernährungsweise: ${profile.diet}
- Budget: ${profile.budget}
- Personen: ${profile.persons}
- Tage: ${profile.days}
- Meal-Prep: ${profile.mealprep}
- Einkaufsliste-Format: ${profile.shopformat}
- Allergien: ${profile.allergies}
- Abneigungen: ${profile.dislikes}${kcalInfo}${pantryInfo}${recentInfo}

Wichtig:
- Jeder Tag MUSS genau 2 Mahlzeiten haben: type "Mittag" UND type "Abend" — niemals nur eine!
- Mittagessen: die warme Hauptmahlzeit des Tages
${dinnerRule(profile.dinner)}
- Mind. 30g Eiweiß pro Mahlzeit (abends z.B. über Quark, Hüttenkäse, Eier, Thunfisch, Räucherlachs, Hähnchenaufschnitt, Tofu, Bohnen)
- Eiweißquellen über die Woche variieren, nicht jeden Tag dieselbe; günstig bleiben
- Saisonale Zutaten
- Küchen-Zuteilung (VERBINDLICH, exakt so umsetzen, nicht tauschen, nicht mischen):
${scheduleText}${batchRule}
- Bedeutung der Küchen:
${cuisineDefs}
- Ein Gericht gilt nur dann als passend, wenn es typisch für die zugeteilte Küche ist (eine Bowl mit Sojasoße ist nicht "deutsch")${excluded.length ? '\n- KEINE Gerichte aus diesen Küchen, auch nicht als Fusion oder Gewürz-Variante: ' + excluded.join(', ') : ''}
- Bei Meal-Prep: vorgekochte Portionen dürfen nur an Tagen eingeplant werden, denen dieselbe Küche zugeteilt ist
- Innerhalb des Plans kein Gericht doppelt (außer bewusst als Meal-Prep markierte Portionen)
- Meal-Prep Gerichte entsprechend markieren
- JSON kompakt halten: pro Gericht maximal 6 Zutaten, maximal 4 kurze Zubereitungsschritte, keine langen Fließtexte
- Alle Rezepte vollständig, aber kurz mit Schritt-für-Schritt-Anleitung`;
  return { prompt, schedule };
}

function buildShoppingState(shopping) {
  const result = { byCategory: {}, byRecipe: [], estimatedCost: '', checked: {} };
  if (shopping && shopping.byCategory && typeof shopping.byCategory === 'object') {
    for (const [category, items] of Object.entries(shopping.byCategory)) {
      result.byCategory[category] = (Array.isArray(items) ? items : []).map(item => ({ ...item, id: newId() }));
    }
  }
  result.byRecipe = Array.isArray(shopping && shopping.byRecipe) ? shopping.byRecipe : [];
  result.estimatedCost = (shopping && shopping.estimatedCost) || '';
  return result;
}

const PANTRY_STAPLES = [
  'reis', 'linsen', 'kichererbsen', 'bohnen', 'erbsen', 'nudeln', 'spaghetti', 'haferflocken',
  'mehl', 'zucker', 'salz', 'öl', 'olivenöl', 'essig', 'tomaten', 'dosentomaten', 'kokosmilch',
  'quinoa', 'bulgur', 'couscous', 'dinkel', 'graupen', 'sonnenblumenkerne', 'kürbiskerne',
  'mandeln', 'nüsse', 'rosinen', 'honig', 'senf', 'sojasoße', 'worcester', 'gewürze', 'brühe',
  'tomatenmark', 'passata', 'roten linsen', 'gelben linsen'
];

/** Grundzutaten aus der Einkaufsliste in den Vorrat übernehmen. Gibt die Anzahl zurück. */
function autoEstimatePantry(shopping) {
  const all = [];
  if (shopping && shopping.byCategory) Object.values(shopping.byCategory).forEach(items => all.push(...(Array.isArray(items) ? items : [])));
  const known = new Set(state.pantry.map(item => String(item.name).toLowerCase()));
  let added = 0;
  for (const item of all) {
    const name = String(item.name || '').toLowerCase();
    if (!name || known.has(name) || !PANTRY_STAPLES.some(staple => name.includes(staple))) continue;
    state.pantry.push({ id: newId(), name: item.name, amount: item.amount || 'vorhanden', category: 'Trockenwaren & Konserven', shelf: 'lang', addedAt: today(), auto: true });
    known.add(name);
    added++;
  }
  return added;
}

function autoSaveToLibrary(plan) {
  const known = new Set(state.library.map(recipe => recipe.name));
  for (const day of plan) {
    for (const meal of meals(day)) {
      if (!meal.name || known.has(meal.name)) continue;
      state.library.push({
        id: newId(), name: meal.name, type: meal.type, cuisine: normalizeCuisine(meal.cuisine), calories: meal.calories, protein: meal.protein, carbs: meal.carbs, fat: meal.fat,
        time: meal.time, difficulty: meal.difficulty, servings: meal.servings, ingredients: meal.ingredients, steps: meal.steps,
        mealprepTip: meal.mealprepTip, savedAt: today()
      });
      known.add(meal.name);
    }
  }
}

let generating = false;
async function generatePlan(profile) {
  if (generating) return;
  if (!(await ai.hasKey())) { toast('Bitte zuerst einen API-Key eintragen.'); showView('more'); return; }
  generating = true;
  $('generateBtn').disabled = true;
  showView('loading');
  const steps = ['Analysiere deine Präferenzen …', 'Erstelle ausgewogene Mahlzeiten …', 'Berechne Nährwerte …', 'Optimiere fürs Budget …', 'Erstelle Rezepte …', 'Generiere Einkaufsliste …', 'Finalisiere den Plan …'];
  let step = 0;
  $('loadingStep').textContent = steps[0];
  const ticker = setInterval(() => { step++; $('loadingStep').textContent = steps[step % steps.length]; }, 2500);
  try {
    const { prompt, schedule } = await buildUserPrompt(profile);
    const data = await ai.ask({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }], maxTokens: 12000 });
    const parsed = ai.parseJson(data);
    if (!parsed || !Array.isArray(parsed.plan) || !parsed.plan.length) throw new AIError('format', 'Die KI hat keinen Plan geliefert. Bitte noch einmal versuchen.');

    state.plan = applyLeftovers(parsed.plan, schedule);
    state.profile = profile;
    state.shopping = buildShoppingState(parsed.shopping);
    autoSaveToLibrary(state.plan);
    const added = autoEstimatePantry(parsed.shopping);

    const ok = (await save('plan', state.plan)) && (await save('profile', state.profile)) && (await save('shopping', state.shopping))
      && (await save('library', state.library)) && (await save('pantry', state.pantry));
    await recordMealHistory(state.plan);
    showSub('plan:week');
    showView('plan');
    if (ok) toast(added ? `Plan erstellt. ${added} Grundzutaten in den Vorrat übernommen.` : 'Plan erstellt.');
  } catch (error) {
    showView('form');
    toast(error instanceof AIError ? error.message : 'Fehler: ' + (error && error.message ? error.message : 'unbekannt'), 8000);
    if (!(error instanceof AIError)) console.error(error);
  } finally {
    clearInterval(ticker);
    generating = false;
    $('generateBtn').disabled = false;
  }
}

// ── 6. Plan, Nährwerte, Meal-Prep ───────────────────────────
function renderPlanArea() {
  if (!state.plan) { $('planContent').innerHTML = emptyState('📅', 'Noch kein Plan', 'Tippe auf „Neuer Plan“.'); }
  else renderPlan();
  renderNutrients();
  renderMealprep();
}

function macrosHtml(meal, compact = false) {
  return `<div class="macros">
    <span class="macro"><span class="dot dot--protein"></span>${esc(meal.protein)}g${compact ? '' : ' Eiweiß'}</span>
    ${compact ? '' : `<span class="macro"><span class="dot dot--carbs"></span>${esc(meal.carbs)}g KH</span>
    <span class="macro"><span class="dot dot--fat"></span>${esc(meal.fat)}g Fett</span>`}
    <span class="macro">🔥 ${esc(meal.calories)} kcal</span>
    ${compact ? '' : `<span class="macro">⏱ ${meal.leftover ? 'aufwärmen' : esc(meal.time) + ' min'}</span>`}
  </div>`;
}

function renderPlan() {
  const p = state.profile || {};
  $('planTitle').textContent = `Ernährungsplan – ${p.days || state.plan.length} Tage`;
  const body = p.weight && p.height ? ` · ${p.weight} kg / ${p.height} cm` : '';
  const training = p.training && String(p.training) !== '0' ? ` · 🏋️ +${p.training} kcal Training` : '';
  $('planSubtitle').textContent = [p.goal, p.diet, p.budget, p.persons ? `${p.persons} Person(en)` : ''].filter(Boolean).join(' · ') + body + training;

  $('planContent').innerHTML = state.plan.map((day, di) => {
    const total = meals(day).reduce((sum, meal) => sum + num(meal.calories), 0);
    return `<div class="day" data-open="true">
      <button type="button" class="day__head" data-action="toggle-day" aria-expanded="true">
        <span class="day__name">${esc(day.day)}</span>
        <span class="row"><span class="day__kcal">${total} kcal gesamt</span><span class="day__toggle" aria-hidden="true">▼</span></span>
      </button>
      <div class="day__body">
        ${meals(day).map((meal, mi) => `<div class="meal">
          <div class="meal__type">${esc(meal.type)}</div>
          <div>
            <div class="meal__name">${esc(meal.name)}</div>
            ${macrosHtml(meal)}
            <div class="badges">
              ${meal.difficulty ? `<span class="badge">${esc(meal.difficulty)}</span>` : ''}
              ${meal.mealprep ? '<span class="badge badge--accent">🍱 Meal-Prep</span>' : ''}
              ${meal.leftover ? `<span class="badge badge--accent">♻️ Rest von ${esc(meal.cookedOn)}</span>` : ''}
            </div>
          </div>
          <div class="meal__actions"><button type="button" class="btn btn--ghost btn--small" data-recipe="plan:${di}:${mi}">📋 Rezept</button></div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderNutrients() {
  const box = $('nutrientsContent');
  if (!state.plan) { box.innerHTML = emptyState('📊', 'Noch kein Plan vorhanden'); return; }
  let cal = 0, protein = 0, carbs = 0, fat = 0;
  const cards = state.plan.map(day => {
    const sumOf = key => meals(day).reduce((sum, meal) => sum + num(meal[key]), 0);
    const d = { cal: sumOf('calories'), p: sumOf('protein'), c: sumOf('carbs'), f: sumOf('fat') };
    cal += d.cal; protein += d.p; carbs += d.c; fat += d.f;
    return `<div class="nutr">
      <div class="nutr__day">${esc(day.day)}</div>
      <div class="nutr__total">${d.cal} kcal</div>
      <div class="nutr__row"><span>Eiweiß</span><b class="c-protein">${d.p}g</b></div>
      <div class="nutr__row"><span>Kohlenhydrate</span><b class="c-carbs">${d.c}g</b></div>
      <div class="nutr__row"><span>Fett</span><b class="c-fat">${d.f}g</b></div>
    </div>`;
  }).join('');
  const days = state.plan.length || 1;
  box.innerHTML = `<div class="card stack">
      <h2>Gesamt (${state.plan.length} Tage)</h2>
      <div class="stats">
        <div class="stat"><div class="stat__val">${cal}</div><div class="stat__label">kcal gesamt</div></div>
        <div class="stat"><div class="stat__val c-protein">${protein}g</div><div class="stat__label">Eiweiß gesamt</div></div>
        <div class="stat"><div class="stat__val c-carbs">${carbs}g</div><div class="stat__label">Kohlenhydrate</div></div>
        <div class="stat"><div class="stat__val c-fat">${fat}g</div><div class="stat__label">Fett gesamt</div></div>
        <div class="stat"><div class="stat__val">${Math.round(cal / days)}</div><div class="stat__label">kcal / Tag</div></div>
        <div class="stat"><div class="stat__val c-protein">${Math.round(protein / days)}g</div><div class="stat__label">Eiweiß / Tag</div></div>
      </div>
    </div>
    <div class="nutr-grid">${cards}</div>`;
}

/** Meal-Prep-Gerichte, jedes nur einmal, mit allen Tagen (auch Reste-Tage). */
function mealprepList() {
  const seen = new Map();
  for (const day of state.plan || []) {
    for (const meal of meals(day)) {
      if (!meal.mealprep || !meal.name) continue;
      if (!seen.has(meal.name)) seen.set(meal.name, { meal: meal.leftover ? { ...meal, leftover: false } : meal, days: [] });
      const entry = seen.get(meal.name);
      if (!meal.leftover) entry.meal = meal;
      if (!entry.days.includes(day.day)) entry.days.push(day.day);
    }
  }
  return [...seen.values()].map(entry => {
    const baseDays = Math.max(1, entry.days.length);
    const wanted = parseInt(state.mpDays[entry.meal.name], 10) || baseDays;
    return { ...entry, baseDays, wanted, factor: wanted / baseDays };
  });
}

function renderMealprep() {
  const box = $('mealprepContent');
  if (!state.plan) { box.innerHTML = emptyState('🍱', 'Noch kein Plan vorhanden'); return; }
  const list = mealprepList();
  if (!list.length) { box.innerHTML = emptyState('🍱', 'Keine Meal-Prep-Gerichte im Plan', 'Erstelle einen neuen Plan mit Meal-Prep.'); return; }
  box.innerHTML = `<p class="muted">Diese ${list.length} Gerichte eignen sich zum Vorkochen. Tippe auf „Kochen für …“, um die Menge anzupassen.</p>
    <div class="tiles">${list.map((entry, i) => `<div class="tile tile--accent">
      <div class="tile__name">${esc(entry.meal.name)}</div>
      <div class="tile__meta">${esc(entry.meal.type)} · ⏱ ${esc(entry.meal.time)} min · im Plan: ${entry.baseDays} ${entry.baseDays === 1 ? 'Tag' : 'Tage'} (${esc(entry.days.join(', '))})</div>
      ${macrosHtml(entry.meal, true)}
      ${entry.meal.mealprepTip ? `<div class="tile__tip">💡 ${esc(entry.meal.mealprepTip)}</div>` : ''}
      <div class="tile__actions">
        <button type="button" class="btn btn--ghost btn--small" data-recipe="mp:${i}">📋 Rezept</button>
        <button type="button" class="btn btn--small${entry.factor === 1 ? ' btn--ghost' : ''}" data-mp-days="${i}">🍳 Kochen für ${entry.wanted} ${entry.wanted === 1 ? 'Tag' : 'Tage'} ✎</button>
      </div>
    </div>`).join('')}</div>`;
}

let mpEditIndex = null;
function openDaysDialog(index) {
  const entry = mealprepList()[index];
  if (!entry) return;
  mpEditIndex = index;
  $('daysDish').textContent = entry.meal.name;
  $('daysBase').textContent = `Das Rezept im Plan reicht für ${entry.baseDays} ${entry.baseDays === 1 ? 'Tag' : 'Tage'}. Die Mengen werden entsprechend umgerechnet.`;
  $('daysInput').value = entry.wanted;
  $('daysError').textContent = '';
  $('daysDialog').showModal();
  $('daysInput').select();
}

async function saveDays(reset = false) {
  const entry = mealprepList()[mpEditIndex];
  if (!entry) { $('daysDialog').close(); return; }
  const next = { ...state.mpDays };
  if (reset) delete next[entry.meal.name];
  else {
    const value = parseInt($('daysInput').value, 10);
    if (!(value >= 1 && value <= 14)) { $('daysError').textContent = 'Bitte 1 bis 14 Tage eingeben.'; return; }
    if (value === entry.baseDays) delete next[entry.meal.name]; else next[entry.meal.name] = value;
  }
  if (!(await save('mealprep_days', next))) return;
  state.mpDays = next;
  $('daysDialog').close();
  renderMealprep();
}

// ── Mengen umrechnen ──
const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
function formatAmount(value, unit) {
  let rounded;
  if (/^\s*(g|ml|gramm)\b/i.test(unit) && value >= 20) rounded = Math.round(value / 5) * 5;
  else if (value >= 10) rounded = Math.round(value);
  else rounded = Math.max(0.5, Math.round(value * 2) / 2);
  return rounded.toLocaleString('de-DE', { maximumFractionDigits: 1, useGrouping: false });
}
/** Alle Mengenzahlen in einer Angabe wie "2 Scheiben (80g)" mit dem Faktor multiplizieren. */
function scaleAmount(text, factor) {
  const raw = String(text ?? '');
  if (factor === 1 || !raw) return raw;
  return raw.replace(/(\d+(?:[.,]\d+)?\s*\/\s*\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])(\s*[a-zA-ZäöüÄÖÜ]*)/g, (match, number, unit) => {
    let value;
    if (FRACTIONS[number]) value = FRACTIONS[number];
    else if (number.includes('/')) { const [a, b] = number.split('/').map(part => num(part)); value = b ? a / b : a; }
    else value = num(number);
    if (!value) return match;
    return formatAmount(value * factor, unit) + unit;
  });
}

// ── 7. Rezept-Dialog ────────────────────────────────────────
function showRecipe(meal, { factor = 1, days = null, libId = null } = {}) {
  if (!meal) { toast('Rezept nicht gefunden.'); return; }
  $('recipeTitle').textContent = meal.name || 'Rezept';
  const ingredients = Array.isArray(meal.ingredients) ? meal.ingredients : [];
  const steps = Array.isArray(meal.steps) ? meal.steps : [];
  $('recipeBody').innerHTML = `
    <div class="recipe-badges">
      ${meal.type ? `<span class="badge">🍽 ${esc(meal.type)}</span>` : ''}
      ${meal.time ? `<span class="badge">⏱ ${esc(meal.time)} min</span>` : ''}
      ${meal.difficulty ? `<span class="badge">📊 ${esc(meal.difficulty)}</span>` : ''}
      ${meal.servings ? `<span class="badge">👥 ${esc(factor === 1 ? meal.servings : formatAmount(num(meal.servings) * factor, ''))} Portionen</span>` : ''}
      ${meal.mealprep ? '<span class="badge badge--accent">🍱 Meal-Prep</span>' : ''}
    </div>
    <div class="recipe-macros">
      <div class="stat"><div class="stat__val">🔥 ${esc(meal.calories)}</div><div class="stat__label">kcal</div></div>
      <div class="stat"><div class="stat__val c-protein">${esc(meal.protein)}g</div><div class="stat__label">Eiweiß</div></div>
      <div class="stat"><div class="stat__val c-carbs">${esc(meal.carbs)}g</div><div class="stat__label">Kohlenhydrate</div></div>
      <div class="stat"><div class="stat__val c-fat">${esc(meal.fat)}g</div><div class="stat__label">Fett</div></div>
    </div>
    ${days ? `<div class="hint">🍳 Mengen umgerechnet für <b>${days.wanted} ${days.wanted === 1 ? 'Tag' : 'Tage'}</b> (Rezept im Plan: ${days.baseDays}). Nährwerte gelten weiter pro Mahlzeit.</div>` : ''}
    ${libId ? `<div class="recipe-cuisine"><label class="label" for="recipeCuisine">Küche</label>
      <select class="input" id="recipeCuisine" data-lib-cuisine="${esc(libId)}">
        <option value="">Ohne Zuordnung</option>
        ${Object.entries(CUISINE_LABELS).map(([key, label]) => `<option value="${key}"${meal.cuisine === key ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select></div>` : ''}
    <div class="recipe-section">🥦 Zutaten${factor === 1 ? '' : ` (für ${days ? days.wanted + ' Tage' : '×' + formatAmount(factor, '')})`}</div>
    <ul class="ingredients">${ingredients.map(ing => `<li><span>${esc(ing && ing.name)}</span>
      <span class="ingredients__amount"><span>${esc(scaleAmount(ing && ing.amount, factor))}</span>${ing && ing.alt ? `<span class="ingredients__alt">Alt: ${esc(ing.alt)}</span>` : ''}</span></li>`).join('')}</ul>
    <div class="recipe-section">👨‍🍳 Zubereitung</div>
    <ol class="steps">${steps.map(step => `<li><span>${esc(step)}</span></li>`).join('')}</ol>
    ${meal.mealprepTip ? `<div class="recipe-section">🍱 Meal-Prep-Hinweise</div><div class="hint">💡 ${esc(meal.mealprepTip)}</div>` : ''}`;
  $('recipeDialog').showModal();
}

function openRecipeRef(ref) {
  const [kind, a, b] = ref.split(':');
  if (kind === 'plan') return showRecipe(meals(state.plan && state.plan[Number(a)])[Number(b)]);
  if (kind === 'mp') {
    const entry = mealprepList()[Number(a)];
    return showRecipe(entry && entry.meal, entry ? { factor: entry.factor, days: entry } : {});
  }
  if (kind === 'lib') return showRecipe(state.library.find(recipe => String(recipe.id) === a), { libId: a });
  showRecipe(null);
}

// ── 8. Einkaufsliste ────────────────────────────────────────
function renderShopping() {
  const box = $('shoppingContent');
  const shop = state.shopping || {};
  const categories = Object.entries(shop.byCategory || {}).filter(([, items]) => Array.isArray(items) && items.length);
  const recipes = Array.isArray(shop.byRecipe) ? shop.byRecipe : [];
  if (!categories.length && !recipes.length) { box.innerHTML = emptyState('🛒', 'Noch keine Einkaufsliste', 'Erstelle zuerst einen Plan.'); return; }
  const format = (state.profile && state.profile.shopformat) || 'Beides';
  const checked = shop.checked || {};
  let html = '';
  if (shop.estimatedCost) html += `<div class="card cost"><span class="muted">Geschätzte Kosten</span><span class="cost__val">${esc(shop.estimatedCost)}</span></div>`;
  if (format !== 'Rezept' && categories.length) {
    html += `<div class="card"><h2>📦 Nach Kategorien</h2>${categories.map(([category, items]) => `<div class="shop-cat">
      <div class="shop-cat__title">${esc(category)}</div>
      ${items.map(item => `<button type="button" class="shop-item" data-item="${esc(item.id)}" aria-pressed="${checked[item.id] ? 'true' : 'false'}">
        <span class="shop-item__box" aria-hidden="true"></span><span class="shop-item__name">${esc(item.name)}</span><span class="shop-item__amount">${esc(item.amount)}</span>
      </button>`).join('')}
    </div>`).join('')}</div>`;
  }
  if (format !== 'Kategorien' && recipes.length) {
    html += `<div class="card"><h2>📋 Nach Rezept</h2>${recipes.map(recipe => `<div class="shop-cat">
      <div class="shop-cat__title">${esc(recipe.recipe)}</div>
      ${(Array.isArray(recipe.items) ? recipe.items : []).map(item => `<div class="shop-item shop-item--static"><span class="shop-item__name">${esc(item.name)}</span><span class="shop-item__amount">${esc(item.amount)}</span></div>`).join('')}
    </div>`).join('')}</div>`;
  }
  box.innerHTML = html;
}

// ── 9. Vorrat ───────────────────────────────────────────────
const SHELF_ICON = { lang: '🟢', mittel: '🟡', kurz: '🔴' };
function renderPantry() {
  const box = $('pantryContent');
  if (!state.pantry.length) { box.innerHTML = emptyState('🏪', 'Noch nichts im Vorrat', 'Beim nächsten Plan werden Grundzutaten automatisch erkannt.'); return; }
  const groups = {};
  for (const item of state.pantry) (groups[item.category || 'Sonstiges'] ||= []).push(item);
  box.innerHTML = Object.entries(groups).map(([category, items]) => `<div class="card">
    <div class="shop-cat__title">${esc(category)} (${items.length})</div>
    ${items.map(item => `<div class="pantry-item">
      <span aria-hidden="true">${SHELF_ICON[item.shelf] || '⚪'}</span>
      <div class="pantry-item__info"><div>${esc(item.name)}</div><div class="pantry-item__meta">${item.auto ? 'Auto' : 'Manuell'} · ${esc(item.addedAt)}</div></div>
      <input class="input pantry-item__amount" type="text" value="${esc(item.amount)}" data-pantry-amount="${esc(item.id)}" aria-label="Menge ${esc(item.name)}" maxlength="30">
      <button type="button" class="icon-btn icon-btn--danger" data-pantry-remove="${esc(item.id)}" aria-label="${esc(item.name)} entfernen">✕</button>
    </div>`).join('')}
  </div>`).join('');
}

// ── 10. Bibliothek ──────────────────────────────────────────
let libType = 'Mittag';
const libTypeOf = recipe => (/abend/i.test(String(recipe.type || '')) ? 'Abend' : 'Mittag');
const CUISINE_ORDER = [...Object.keys(CUISINE_LABELS), null];

/** Küche aus dem aktuellen Plan übernehmen, wo die Bibliothek sie noch nicht kennt. */
async function backfillLibraryCuisine() {
  const fromPlan = new Map();
  for (const day of state.plan || []) for (const meal of meals(day)) { const key = normalizeCuisine(meal.cuisine); if (key) fromPlan.set(meal.name, key); }
  let changed = false;
  for (const recipe of state.library) {
    const known = normalizeCuisine(recipe.cuisine);
    if (recipe.cuisine && known !== recipe.cuisine) { recipe.cuisine = known; changed = true; }
    if (!known && fromPlan.has(recipe.name)) { recipe.cuisine = fromPlan.get(recipe.name); changed = true; }
  }
  if (changed) await save('library', state.library);
}

function libraryGroupsHtml(list, open) {
  const groups = new Map(CUISINE_ORDER.map(key => [key, []]));
  for (const recipe of list) groups.get(CUISINES[recipe.cuisine] ? recipe.cuisine : null).push(recipe);
  return [...groups.entries()].filter(([, items]) => items.length).map(([key, items]) => `<details class="lib-group"${open ? ' open' : ''}>
    <summary class="lib-group__head"><span>${esc(key ? CUISINE_LABELS[key] : 'Ohne Zuordnung')}</span><span class="lib-group__count">${items.length}</span></summary>
    <div class="tiles">${items.slice().sort((x, y) => String(x.name).localeCompare(String(y.name), 'de')).map(recipe => `<div class="tile">
      <div class="tile__name">${esc(recipe.name)}</div>
      <div class="tile__meta">⏱ ${esc(recipe.time)} min · ${esc(recipe.difficulty)} · ${esc(recipe.savedAt)}</div>
      <div class="macros"><span class="macro c-protein">${esc(recipe.protein)}g Eiweiß</span><span class="macro">🔥 ${esc(recipe.calories)} kcal</span></div>
      <div class="tile__actions">
        <button type="button" class="btn btn--ghost btn--small" data-recipe="lib:${esc(recipe.id)}">📋 Rezept</button>
        <button type="button" class="icon-btn icon-btn--danger" data-lib-remove="${esc(recipe.id)}" aria-label="${esc(recipe.name)} löschen">🗑</button>
      </div>
    </div>`).join('')}</div>
  </details>`).join('');
}

function renderLibrary() {
  const box = $('libraryContent');
  $('libCount').textContent = `${state.library.length} Rezepte`;
  for (const button of document.querySelectorAll('[data-libtype]')) {
    const count = state.library.filter(recipe => libTypeOf(recipe) === button.dataset.libtype).length;
    button.textContent = `${button.dataset.libtype === 'Mittag' ? 'Mittagessen' : 'Abendessen'} (${count})`;
    button.setAttribute('aria-pressed', String(button.dataset.libtype === libType));
  }
  const missing = state.library.filter(recipe => !CUISINES[recipe.cuisine]).length;
  $('libClassify').hidden = missing === 0;
  $('libClassifyText').textContent = `${missing} ${missing === 1 ? 'Rezept ist' : 'Rezepte sind'} noch keiner Küche zugeordnet.`;
  if (!state.library.length) { box.innerHTML = emptyState('📚', 'Bibliothek ist leer', 'Rezepte werden beim Erstellen eines Plans automatisch gespeichert.'); return; }

  const query = $('libSearch').value.trim().toLowerCase();
  if (query) {
    const hits = state.library.filter(recipe => String(recipe.name).toLowerCase().includes(query));
    if (!hits.length) { box.innerHTML = emptyState('🔍', 'Kein Rezept gefunden'); return; }
    box.innerHTML = ['Mittag', 'Abend'].map(type => {
      const list = hits.filter(recipe => libTypeOf(recipe) === type);
      return list.length ? `<h3 class="subhead lib-type">${type === 'Mittag' ? 'Mittagessen' : 'Abendessen'}</h3>${libraryGroupsHtml(list, true)}` : '';
    }).join('');
    return;
  }
  const list = state.library.filter(recipe => libTypeOf(recipe) === libType);
  box.innerHTML = list.length ? libraryGroupsHtml(list, false) : emptyState('📚', `Noch keine ${libType === 'Mittag' ? 'Mittagessen' : 'Abendessen'} gespeichert`);
}

let classifying = false;
async function classifyLibrary() {
  if (classifying) return;
  const missing = state.library.filter(recipe => !CUISINES[recipe.cuisine]);
  if (!missing.length) return;
  if (!(await ai.hasKey())) { toast('Bitte zuerst einen API-Key eintragen.'); return; }
  classifying = true;
  const button = $('libClassifyBtn');
  button.disabled = true;
  button.textContent = 'KI ordnet ein …';
  try {
    const keys = Object.keys(CUISINES);
    const prompt = `Ordne jedes Gericht genau einer Küche zu. Erlaubte Schlüssel: ${keys.join(', ')}.
Wenn keine passt, nimm die ähnlichste. Antworte NUR mit einem JSON-Objekt {"Nummer": "schlüssel"}, z.B. {"0": "deutsch"}.

${missing.map((recipe, i) => `${i}: ${recipe.name}`).join('\n')}`;
    const data = await ai.ask({ messages: [{ role: 'user', content: prompt }], maxTokens: 3000, temperature: null });
    const result = ai.parseJson(data);
    let done = 0;
    missing.forEach((recipe, i) => {
      const key = normalizeCuisine(result && result[String(i)]);
      if (key) { recipe.cuisine = key; done++; }
    });
    if (await save('library', state.library)) toast(`${done} von ${missing.length} Rezepten eingeordnet. Falsch? Im Rezept unter „Küche“ ändern.`, 6000);
  } catch (error) {
    toast(error instanceof AIError ? error.message : 'Einordnen fehlgeschlagen.', 6000);
  } finally {
    classifying = false;
    button.disabled = false;
    button.textContent = 'Von der KI einordnen lassen';
    renderLibrary();
  }
}

// ── 11. Kassenzettel ────────────────────────────────────────
const RECEIPT_PROMPT = `Analysiere diesen Kassenzettel und extrahiere alle Artikel mit Preisen.
Antworte NUR mit einem JSON-Objekt, kein Text davor oder danach:
{
  "store": "Marktname (z.B. Rewe, Aldi, Lidl)",
  "date": "Datum vom Bon (TT.MM.JJJJ oder leer)",
  "total": 12.34,
  "items": [
    {"name": "Artikelname", "price": 1.99, "qty": 1, "unit": "Stück/kg/l/g"}
  ]
}
Nur Lebensmittel-relevante Artikel. Pfand, Rabatte und Summen weglassen.`;

/** Bild verkleinern (max. 1600 px) und als JPEG-Base64 liefern. */
function imageToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      const MAX = 1600;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Das Bild konnte nicht gelesen werden. Bitte JPG oder PNG verwenden.')); };
    img.src = url;
  });
}

let scanning = false;
async function scanReceipt(file) {
  if (scanning) return;
  if (!(await ai.hasKey())) { toast('Bitte zuerst einen API-Key eintragen.'); showView('more'); return; }
  scanning = true;
  $('scanLoading').hidden = false;
  $('scanError').innerHTML = '';
  try {
    const base64 = await imageToBase64(file);
    const data = await ai.ask({
      maxTokens: 2000,
      temperature: null,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: RECEIPT_PROMPT }
      ] }]
    });
    const parsed = ai.parseJson(data);
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter(item => item && item.name)
      .map(item => ({ name: String(item.name), price: num(item.price), qty: num(item.qty) || 1, unit: item.unit || '' }));
    const receipt = {
      id: newId(), store: parsed.store || 'Unbekannt', date: parsed.date || today(),
      total: num(parsed.total), items, scannedAt: today()
    };
    const next = [receipt, ...state.receipts];
    if (!(await save('receipts', next))) return;
    state.receipts = next;
    await checkPriceChanges(receipt);
    renderReceipts();
    toast(`${items.length} Artikel aus ${receipt.store} gespeichert.`);
  } catch (error) {
    const text = error instanceof AIError || (error && error.message) ? error.message : 'unbekannter Fehler';
    $('scanError').innerHTML = `<div class="card card--alert stack"><b>❌ Scan fehlgeschlagen</b><p class="muted">${esc(text)}</p></div>`;
  } finally {
    $('scanLoading').hidden = true;
    scanning = false;
  }
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function checkPriceChanges(receipt) {
  const alerts = [];
  for (const item of receipt.items) {
    for (const old of state.receipts.slice(1)) {
      const match = (old.items || []).find(entry => sameName(entry.name, item.name));
      if (match && num(match.price) && item.price) {
        const pct = Math.round((item.price - num(match.price)) / num(match.price) * 100);
        if (Math.abs(pct) >= 5) alerts.push({ name: item.name, oldPrice: num(match.price), newPrice: item.price, pct, store: receipt.store, oldDate: old.date });
      }
    }
  }
  if (alerts.length) await save('price_alerts', alerts);
}

function priceChange(name, receiptId, price) {
  const index = state.receipts.findIndex(receipt => receipt.id === receiptId);
  for (let i = index + 1; i < state.receipts.length; i++) {
    const match = (state.receipts[i].items || []).find(entry => sameName(entry.name, name));
    if (match && num(match.price)) {
      const pct = Math.round((num(price) - num(match.price)) / num(match.price) * 100);
      return Math.abs(pct) >= 5 ? pct : null;
    }
  }
  return null;
}

function receiptMonthTotal() {
  const now = new Date();
  return state.receipts.filter(receipt => {
    const parts = String(receipt.date || '').split('.');
    if (parts.length !== 3) return false;
    const year = Number(parts[2].length === 2 ? '20' + parts[2] : parts[2]);
    return Number(parts[1]) - 1 === now.getMonth() && year === now.getFullYear();
  }).reduce((sum, receipt) => sum + num(receipt.total), 0);
}

async function renderReceipts() {
  const stats = $('receiptStats');
  if (!state.receipts.length) stats.innerHTML = '';
  else {
    const total = state.receipts.reduce((sum, receipt) => sum + num(receipt.total), 0);
    const byStore = {};
    state.receipts.forEach(receipt => { byStore[receipt.store] = (byStore[receipt.store] || 0) + num(receipt.total); });
    const top = Object.entries(byStore).sort((a, b) => b[1] - a[1])[0];
    stats.innerHTML = `
      <div class="stat"><div class="stat__val c-accent">${money(total)}</div><div class="stat__label">Gesamt ausgegeben</div></div>
      <div class="stat"><div class="stat__val">${money(total / state.receipts.length)}</div><div class="stat__label">Ø pro Einkauf</div></div>
      <div class="stat"><div class="stat__val c-carbs">${money(receiptMonthTotal())}</div><div class="stat__label">Diesen Monat</div></div>
      <div class="stat"><div class="stat__val stat__val--small">${esc(top ? top[0] : '–')}</div><div class="stat__label">Meistgenutzter Markt</div></div>
      <div class="stat"><div class="stat__val">${state.receipts.length}</div><div class="stat__label">Bons gespeichert</div></div>`;
  }

  const alerts = await store.get('price_alerts', []);
  $('priceAlerts').innerHTML = Array.isArray(alerts) && alerts.length ? `<div class="card stack ${alerts.some(a => a.pct > 0) ? 'card--alert' : 'card--ok'}">
      <b>⚠️ Preisänderungen erkannt</b>
      <div>${alerts.map(a => `<div class="alert-row"><span>${esc(a.name)}</span><span><span class="alert-row__old">${money(a.oldPrice)} → </span><b class="${a.pct > 0 ? 'is-pos' : 'is-neg'}">${money(a.newPrice)} (${a.pct > 0 ? '+' : ''}${esc(a.pct)} %)</b></span></div>`).join('')}</div>
      <div class="row"><button type="button" class="btn btn--ghost btn--small" data-action="alerts-ok">✓ Verstanden</button></div>
    </div>` : '';

  const box = $('receiptsContent');
  if (!state.receipts.length) { box.innerHTML = emptyState('🧾', 'Noch keine Kassenbons', 'Tippe auf „📷 Scannen“, um loszulegen.'); return; }
  box.innerHTML = state.receipts.map(receipt => `<div class="card">
    <div class="receipt__head">
      <div><div class="receipt__store">${esc(receipt.store)}</div><div class="receipt__meta">${esc(receipt.date)} · ${(receipt.items || []).length} Artikel · gescannt ${esc(receipt.scannedAt)}</div></div>
      <div class="row"><span class="receipt__total">${money(receipt.total)}</span>
        <button type="button" class="icon-btn icon-btn--danger" data-receipt-remove="${esc(receipt.id)}" aria-label="Kassenzettel löschen">🗑</button></div>
    </div>
    <div class="receipt__items">${(receipt.items || []).map(item => {
      const pct = priceChange(item.name, receipt.id, item.price);
      return `<div class="receipt__name">${esc(item.name)}${num(item.qty) > 1 ? ` <span class="receipt__qty">×${esc(item.qty)}</span>` : ''}</div>
        <div class="receipt__price">${pct !== null ? `<span class="change ${pct > 0 ? 'change--up' : 'change--down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)} %</span>` : ''}<span>${money(item.price)}</span></div>`;
    }).join('')}</div>
  </div>`).join('');
}

// ── 12. Mehr ────────────────────────────────────────────────
const STATUS_TEXT = {
  ok: 'in Ordnung', fresh: 'neu angelegt', legacy: 'alte Daten übernommen', migrated: 'auf neue Datenversion umgestellt',
  newer: 'Daten sind neuer als die App (nur lesen)', locked: 'gesperrt', 'migration-failed': 'Umstellung fehlgeschlagen (nur lesen)'
};
const formatStamp = iso => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

async function renderMore() {
  $('factModel').textContent = (config.ai && config.ai.model) || '–';
  $('factKey').textContent = (await ai.keyHint()) || 'kein Key';
  const meta = store.getMeta();
  $('backupInfo').textContent = meta.lastBackupAt ? `Letztes Backup: ${formatStamp(meta.lastBackupAt)}` : 'Noch kein Backup erstellt.';
  $('undoRow').hidden = !(await store.restorePointInfo());
  $('factVersion').textContent = getVersion();
  $('factInstalled').textContent = isStandalone() ? 'ja' : 'nein, läuft im Browser';
  $('factStatus').textContent = STATUS_TEXT[store.status] || store.status;
  const problem = $('problemInfo');
  problem.hidden = store.problems.length === 0;
  if (store.problems.length) problem.textContent = `Hinweis: ${store.problems.length} Problem(e) beim Lesen der Daten. Die Originale wurden gesichert und nicht überschrieben.`;
  const updates = await updatesReady;
  $('factSw').textContent = updates.supported ? 'aktiv' : 'nicht verfügbar';
}

async function exportBackup() {
  const result = await backup.download();
  if (!result.cancelled) toast('Backup erstellt: ' + result.filename);
  if (currentView === 'more') renderMore();
  return result;
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const check = await backup.inspect(text);
    const names = Object.keys(check.data);
    const ok = await confirmDialog({
      title: 'Backup einspielen?',
      text: `${check.source}${check.exported ? ' vom ' + formatStamp(check.exported) : ''}, ${names.length} Bereiche (${names.join(', ')}). Deine aktuellen Daten werden ersetzt, dein API-Key bleibt. Der jetzige Stand wird vorher gesichert.`,
      yes: 'Einspielen'
    });
    if (!ok) return;
    const key = await ai.getKey();
    await backup.importText(text);
    if (key && !(await store.get('apikey', ''))) await store.set('apikey', key);
    location.reload();
  } catch (error) {
    const known = error instanceof BackupError || error instanceof StorageError;
    toast(known ? error.message : 'Import fehlgeschlagen.', 6000);
  }
}

// ── 13. Start ───────────────────────────────────────────────
document.title = config.name;
await backfillLibraryCuisine();
$('setupKeyLink').href = (config.ai && config.ai.keyUrl) || 'https://console.anthropic.com';
buildCuisineChips();

const updatesReady = initUpdates({ canUpdateNow: () => !generating && !scanning && !$('recipeDialog').open });
initInstall({ button: $('installBtn'), store });

if (!(await ai.hasKey())) {
  const hasData = Boolean(state.plan || state.library.length || state.pantry.length || state.receipts.length);
  if (hasData) $('setupImportInfo').textContent = `Daten sind schon da (${state.library.length} Rezepte, ${state.pantry.length} Vorrat, ${state.receipts.length} Bons). Es fehlt nur noch dein API-Key.`;
  showView('setup');
} else {
  openPlanOrForm();
  backup.remindIfDue({ onBackupRequested: exportBackup });
}

// ── 14. Bedienung ───────────────────────────────────────────
$('mainNav').addEventListener('click', event => {
  const button = event.target.closest('[data-nav]');
  if (!button) return;
  if (button.dataset.nav === 'plan') { if (generating) showView('loading'); else openPlanOrForm(); }
  else showView(button.dataset.nav);
});

document.addEventListener('click', async event => {
  const sub = event.target.closest('[data-sub]');
  if (sub) { showSub(sub.dataset.sub); return; }

  const typeButton = event.target.closest('[data-libtype]');
  if (typeButton) { libType = typeButton.dataset.libtype; renderLibrary(); return; }

  const mpDays = event.target.closest('[data-mp-days]');
  if (mpDays) { openDaysDialog(Number(mpDays.dataset.mpDays)); return; }

  const recipe = event.target.closest('[data-recipe]');
  if (recipe) { openRecipeRef(recipe.dataset.recipe); return; }

  const dayHead = event.target.closest('[data-action="toggle-day"]');
  if (dayHead) {
    const day = dayHead.closest('.day');
    const open = day.dataset.open !== 'true';
    day.dataset.open = String(open);
    dayHead.setAttribute('aria-expanded', String(open));
    return;
  }

  const item = event.target.closest('[data-item]');
  if (item) {
    const id = item.dataset.item;
    state.shopping.checked = state.shopping.checked || {};
    state.shopping.checked[id] = !state.shopping.checked[id];
    item.setAttribute('aria-pressed', String(state.shopping.checked[id]));
    await save('shopping', state.shopping);
    return;
  }

  const pantryRemove = event.target.closest('[data-pantry-remove]');
  if (pantryRemove) {
    const next = state.pantry.filter(entry => String(entry.id) !== pantryRemove.dataset.pantryRemove);
    if (await save('pantry', next)) { state.pantry = next; renderPantry(); toast('Artikel entfernt.'); }
    return;
  }

  const libRemove = event.target.closest('[data-lib-remove]');
  if (libRemove) {
    const entry = state.library.find(recipeEntry => String(recipeEntry.id) === libRemove.dataset.libRemove);
    if (!entry || !(await confirmDialog({ title: 'Rezept löschen?', text: `„${entry.name}“ aus der Bibliothek löschen?`, yes: 'Löschen', danger: true }))) return;
    const next = state.library.filter(recipeEntry => recipeEntry !== entry);
    if (await save('library', next)) { state.library = next; renderLibrary(); }
    return;
  }

  const receiptRemove = event.target.closest('[data-receipt-remove]');
  if (receiptRemove) {
    if (!(await confirmDialog({ title: 'Kassenzettel löschen?', text: 'Der Bon und seine Preise werden entfernt.', yes: 'Löschen', danger: true }))) return;
    const next = state.receipts.filter(receipt => String(receipt.id) !== receiptRemove.dataset.receiptRemove);
    if (await save('receipts', next)) { state.receipts = next; renderReceipts(); }
    return;
  }

  const action = event.target.closest('[data-action]');
  if (action) await runAction(action.dataset.action);
});

async function clearData(name, value, { title, text, done }) {
  if (!(await confirmDialog({ title, text, yes: 'Löschen', danger: true }))) return false;
  if (value === undefined) await store.remove(name); else if (!(await save(name, value))) return false;
  toast(done);
  return true;
}

async function runAction(name) {
  switch (name) {
    case 'new-plan': openForm(); break;
    case 'classify': await classifyLibrary(); break;
    case 'import': $('importFile').click(); break;
    case 'export': await exportBackup(); break;
    case 'scan': $('receiptFile').click(); break;
    case 'pantry-add': $('pantryForm').hidden = false; $('pantryName').focus(); break;
    case 'pantry-cancel': $('pantryForm').hidden = true; $('pantryForm').reset(); break;
    case 'alerts-ok': await store.remove('price_alerts'); renderReceipts(); break;
    case 'clear-checked': {
      const checked = state.shopping.checked || {};
      const ids = Object.keys(checked).filter(id => checked[id]);
      if (!ids.length) { toast('Nichts abgehakt.'); break; }
      for (const [category, items] of Object.entries(state.shopping.byCategory || {})) state.shopping.byCategory[category] = items.filter(entry => !ids.includes(entry.id));
      ids.forEach(id => delete checked[id]);
      if (await save('shopping', state.shopping)) { renderShopping(); toast('Abgehakte Artikel entfernt.'); }
      break;
    }
    case 'clear-shopping':
      if (await clearData('shopping', {}, { title: 'Einkaufsliste löschen?', text: 'Die ganze Einkaufsliste wird geleert.', done: 'Einkaufsliste geleert.' })) { state.shopping = {}; renderShopping(); }
      break;
    case 'clear-pantry':
      if (await clearData('pantry', [], { title: 'Vorrat leeren?', text: 'Alle Artikel im Vorrat werden gelöscht.', done: 'Vorrat geleert.' })) { state.pantry = []; renderPantry(); }
      break;
    case 'clear-plan':
      if (await clearData('plan', undefined, { title: 'Plan löschen?', text: 'Der aktuelle Plan wird gelöscht. Rezepte bleiben in der Bibliothek.', done: 'Plan gelöscht.' })) state.plan = null;
      break;
    case 'clear-library':
      if (await clearData('library', [], { title: 'Bibliothek löschen?', text: 'Alle gespeicherten Rezepte werden gelöscht.', done: 'Bibliothek geleert.' })) state.library = [];
      break;
    case 'clear-receipts':
      if (await clearData('receipts', [], { title: 'Ausgaben löschen?', text: 'Alle Kassenbons und Preisvergleiche werden gelöscht.', done: 'Ausgaben geleert.' })) { state.receipts = []; await store.remove('price_alerts'); }
      break;
    case 'remove-key':
      if (await confirmDialog({ title: 'API-Key entfernen?', text: 'Ohne Key kann die App keine Pläne erstellen und keine Bons lesen. Deine Daten bleiben.', yes: 'Entfernen', danger: true })) {
        await ai.removeKey();
        location.reload();
      }
      break;
    case 'undo':
      if (await confirmDialog({ title: 'Rückgängig machen?', text: 'Der Stand vor dem letzten Import oder Löschen wird wiederhergestellt.', yes: 'Zurückholen' })) {
        await store.undoRestore();
        location.reload();
      }
      break;
    case 'check-update': {
      const updates = await updatesReady;
      if (!updates.supported) toast('Offline-Modus ist hier nicht verfügbar.');
      else if (!(await updates.checkNow())) toast('Du hast die aktuelle Version.');
      break;
    }
    case 'reset':
      if (await confirmDialog({ title: 'Alle Daten löschen?', text: 'Gelöscht werden nur die Daten dieser App, auch der API-Key. Der jetzige Stand (ohne Key) lässt sich einmal zurückholen.', yes: 'Löschen', danger: true })) {
        await store.reset();
        location.reload();
      }
      break;
  }
}

$('setupForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await ai.setKey($('setupKey').value);
    $('setupKey').value = '';
    toast('API-Key gespeichert.');
    openPlanOrForm();
  } catch (error) {
    $('setupError').textContent = error instanceof AIError ? error.message : 'Speichern fehlgeschlagen.';
  }
});

$('keyForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await ai.setKey($('newKey').value);
    $('newKey').value = '';
    $('keyError').textContent = '';
    toast('API-Key gespeichert.');
    renderMore();
  } catch (error) {
    $('keyError').textContent = error instanceof AIError ? error.message : 'Speichern fehlgeschlagen.';
  }
});

$('planForm').addEventListener('submit', event => {
  event.preventDefault();
  generatePlan(readForm());
});
$('formCancel').addEventListener('click', () => showView('plan'));

$('pantryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('pantryName').value.trim();
  if (!name) { $('pantryError').textContent = 'Bitte einen Artikel eingeben.'; return; }
  const next = [...state.pantry, {
    id: newId(), name, amount: $('pantryAmount').value.trim() || 'vorhanden', category: $('pantryCat').value,
    shelf: $('pantryShelf').value, addedAt: today(), auto: false
  }];
  if (!(await save('pantry', next))) return;
  state.pantry = next;
  $('pantryError').textContent = '';
  $('pantryForm').reset();
  $('pantryForm').hidden = true;
  renderPantry();
  toast('Zum Vorrat hinzugefügt.');
});

$('pantryContent').addEventListener('change', async event => {
  const id = event.target.dataset.pantryAmount;
  if (!id) return;
  const entry = state.pantry.find(item => String(item.id) === id);
  if (!entry) return;
  entry.amount = event.target.value.trim() || 'vorhanden';
  await save('pantry', state.pantry);
});

$('libSearch').addEventListener('input', renderLibrary);

$('receiptFile').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) scanReceipt(file);
});

$('importFile').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) importBackup(file);
});

$('recipeClose').addEventListener('click', () => $('recipeDialog').close());
$('recipeDialog').addEventListener('click', event => { if (event.target === $('recipeDialog')) $('recipeDialog').close(); });

$('recipeBody').addEventListener('change', async event => {
  const id = event.target.dataset.libCuisine;
  if (!id) return;
  const recipe = state.library.find(entry => String(entry.id) === id);
  if (!recipe) return;
  recipe.cuisine = normalizeCuisine(event.target.value);
  if (await save('library', state.library)) { toast('Küche geändert.'); renderLibrary(); }
});

$('daysForm').addEventListener('submit', event => { event.preventDefault(); saveDays(); });
$('daysReset').addEventListener('click', () => saveDays(true));
$('daysCancel').addEventListener('click', () => $('daysDialog').close());
