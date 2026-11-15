"""Test von NutriCoach im echten Chrome. Die KI wird simuliert (kein echter Key, keine Kosten).
Aufruf im Repo-Ordner: python3 tests/nutricoach.py [pfad/zu/altem-backup.json]   (Windows: py)
Ohne Pfad wird ein kleines Beispiel-Backup im alten Format erzeugt."""
import asyncio, json, os, pathlib, shutil, subprocess, sys, time
from playwright.async_api import async_playwright
HERE = pathlib.Path(__file__).resolve().parent; ROOT = HERE.parent
CHROME = os.environ.get('CHROME_PATH', '/usr/bin/google-chrome')
WWW = pathlib.Path('/tmp/nc-test-www'); TMP = pathlib.Path('/tmp/nc-test-files'); R = []
KEY = 'sk-ant-api03-' + 'T' * 40
URL = 'http://localhost:8181/app/'

def check(name, ok, info=''):
    R.append((name, bool(ok), str(info))); print(('OK   ' if ok else 'FAIL ') + name + (f'  ({info})' if info else ''))

async def wait_true(page, expr, timeout=15000):
    end = time.time() + timeout / 1000
    while time.time() < end:
        if await page.evaluate(expr): return
        await asyncio.sleep(0.15)
    raise TimeoutError(expr)

def meal(name, typ, mealprep=False):
    return {'type': typ, 'cuisine': 'deutsch', 'name': name, 'mealprep': mealprep, 'calories': 600, 'protein': 40, 'carbs': 50, 'fat': 20, 'time': 20,
            'difficulty': 'Einfach', 'servings': 2, 'ingredients': [{'name': 'Linsen', 'amount': '200g', 'alt': None}],
            'steps': ['Kochen.', 'Essen.'], 'mealprepTip': 'Hält 3 Tage' if mealprep else None}

PLAN = {'plan': [
    {'day': 'Montag', 'meals': [meal('Testgericht Mo <img src=x id=xss>', 'Mittag', True), meal('Quarkteller', 'Abend')]},
    {'day': 'Dienstag', 'meals': [meal('Linseneintopf', 'Mittag'), meal('Wrap', 'Abend')]},
    {'day': 'Mittwoch', 'meals': [meal('Ofengemüse', 'Mittag'), meal('Salat', 'Abend')]}],
    'shopping': {'byCategory': {'Trockenwaren & Konserven': [{'name': 'Rote Linsen', 'amount': '500g'}], 'Gemüse & Obst': [{'name': 'Paprika', 'amount': '3'}]},
                 'byRecipe': [{'recipe': 'Linseneintopf', 'items': [{'name': 'Rote Linsen', 'amount': '500g'}]}], 'estimatedCost': 'ca. 31€'}}

def receipt(price):
    return {'store': 'Testmarkt', 'date': '15.11.2026', 'total': 10.5, 'items': [{'name': 'Haferflocken', 'price': price, 'qty': 1, 'unit': 'Stück'}]}

def sample_old_backup():
    return {'version': 1, 'exported': '2026-11-14T10:00:00Z', 'nc_plan': PLAN['plan'][:2], 'nc_profile': {'goal': 'Abnehmen', 'days': '5', 'persons': '2', 'cuisines': ['deutsch']},
            'nc_shopping': {}, 'nc_library': [{'id': 'a1', 'name': 'Altrezept', 'type': 'Mittag'}], 'nc_pantry': [{'id': 'p1', 'name': 'Reis', 'amount': '1kg'}],
            'nc_receipts': [], 'nc_price_alerts': [], 'nc_meal_history': [{'date': '2026-11-01', 'names': ['Altrezept']}], 'nc_apikey': 'sk-ant-ALTER-KEY-DARF-NICHT-MIT'}

async def main():
    old_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    shutil.rmtree(TMP, ignore_errors=True); TMP.mkdir(parents=True)
    if not old_path:
        old_path = TMP / 'nutricoach-backup-alt.json'; old_path.write_text(json.dumps(sample_old_backup()))
    old = json.loads(old_path.read_text())
    out = subprocess.run(['node', str(ROOT / 'tools/stamp.mjs'), '--out', '_site'], capture_output=True, text=True, cwd=ROOT); assert out.returncode == 0, out.stderr
    check('stamp.mjs ohne Warnung', 'Warnung' not in out.stdout + out.stderr, (out.stdout + out.stderr).strip()[-200:])
    shutil.rmtree(WWW, ignore_errors=True); shutil.copytree(ROOT / '_site', WWW / 'app'); shutil.rmtree(ROOT / '_site')
    srv = subprocess.Popen([sys.executable, str(HERE / 'server.py'), str(WWW), '8181'], stderr=subprocess.DEVNULL); await asyncio.sleep(0.8)
    calls = []; mode = {'value': 'ok', 'price': 1.99}
    async def fake_ai(route):
        req = route.request; body = json.loads(req.post_data or '{}'); calls.append({'headers': req.headers, 'body': body})
        if mode['value'] == '401':
            await route.fulfill(status=401, content_type='application/json', body=json.dumps({'type': 'error', 'error': {'type': 'authentication_error', 'message': 'invalid x-api-key'}}), headers={'access-control-allow-origin': '*'}); return
        content = body['messages'][0]['content']
        is_image = isinstance(content, list)
        if not is_image and 'Ordne jedes Gericht' in content:
            import re as _re
            idx = _re.findall(r'^(\d+): ', content, _re.M)
            payload = {i: ('mediterran' if int(i) % 2 else 'deutsch') for i in idx}
        else:
            payload = receipt(mode['price']) if is_image else PLAN
        text = '```json\n' + json.dumps(payload) + '\n```'
        await route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                            body=json.dumps({'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn'}))
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
            ctx = await b.new_context(viewport={'width': 412, 'height': 915}, accept_downloads=True)
            await ctx.route('https://api.anthropic.com/**', fake_ai)
            page = await ctx.new_page(); errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            async def ls():
                return await page.evaluate("Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))")

            await page.goto(URL); await page.wait_for_selector('[data-view="setup"]:not([hidden])')
            check('Erststart: Key-Eingabe, Navigation versteckt', await page.is_hidden('#mainNav'))
            await page.fill('#setupKey', 'falsch'); await page.click('#setupForm button[type=submit]')
            check('Ungültiger Key wird abgelehnt', 'gültiger Key' in await page.text_content('#setupError'))

            # Umzug: altes Backup auf dem Startbildschirm einspielen
            async with page.expect_file_chooser() as fc: await page.click('[data-view="setup"] [data-action="import"]')
            await (await fc.value).set_files(str(old_path)); await page.wait_for_selector('#confirmDialog[open]')
            check('Import erkennt altes Format (nc_…)', 'altes Format' in await page.text_content('#confirmText'), await page.text_content('#confirmText'))
            await page.click('#confirmYes'); await page.wait_for_load_state('load'); await page.wait_for_selector('[data-view="setup"]:not([hidden])')
            data = await ls()
            lib = json.loads(data.get('nutricoach.library', '[]')); pantry = json.loads(data.get('nutricoach.pantry', '[]')); hist = json.loads(data.get('nutricoach.meal_history', '[]'))
            check('Altdaten übernommen: Bibliothek, Vorrat, Verlauf vollständig',
                  len(lib) == len(old.get('nc_library') or []) and len(pantry) == len(old.get('nc_pantry') or []) and len(hist) == len(old.get('nc_meal_history') or []),
                  f'{len(lib)} Rezepte, {len(pantry)} Vorrat, {len(hist)} Verlauf')
            check('Alter Key NICHT übernommen', 'nutricoach.apikey' not in data and not any('ALTER-KEY' in v for v in data.values()))
            check('Startbildschirm meldet vorhandene Daten', 'Daten sind schon da' in await page.text_content('#setupImportInfo'))
            check('Nur eigene Speicher-Keys (nutricoach.…)', all(k.startswith('nutricoach.') for k in data), [k for k in data if not k.startswith('nutricoach.')])

            await page.fill('#setupKey', KEY); await page.click('#setupForm button[type=submit]')
            has_plan = bool(old.get('nc_plan'))
            if has_plan:
                await page.wait_for_selector('[data-view="plan"]:not([hidden])')
                check('Mit Key: alter Plan wird angezeigt', await page.locator('#planContent .day').count() == len(old['nc_plan']))
                await page.locator('[data-recipe^="plan:"]').first.click(); await page.wait_for_selector('#recipeDialog[open]')
                check('Rezept-Dialog öffnet', len(await page.text_content('#recipeTitle')) > 0); await page.click('#recipeClose')
            else:
                await page.wait_for_selector('[data-view="form"]:not([hidden])'); check('Ohne Plan: Formular', True)

            # Meal-Prep aus dem alten Plan: Reste-Tag zählt mit
            old_plan = old.get('nc_plan') or []
            if any(m.get('leftover') and m.get('mealprep') for d in old_plan for m in d.get('meals', [])):
                await page.click('[data-sub="plan:mealprep"]')
                check('Meal-Prep zählt Reste-Tag mit (2 Tage)', 'im Plan: 2 Tage' in await page.text_content('#mealprepContent'), (await page.text_content('#mealprepContent'))[:160])
                await page.click('[data-sub="plan:week"]')

            # Bibliothek: Mittag/Abend, Küchen, KI-Einordnung
            await page.click('[data-nav="library"]')
            n_mittag = sum(1 for r in (old.get('nc_library') or []) if 'abend' not in str(r.get('type', '')).lower())
            check('Bibliothek: Reiter Mittagessen mit Anzahl', f'Mittagessen ({n_mittag})' in await page.text_content('[data-libtype="Mittag"]'))
            if not await page.is_hidden('#libClassify'):
                await page.click('#libClassifyBtn'); await wait_true(page, "document.getElementById('libClassify').hidden")
                lib_after = json.loads((await ls())['nutricoach.library'])
                check('KI ordnet alle alten Rezepte einer Küche zu', all(r.get('cuisine') in ('deutsch', 'mediterran', 'skandinavisch', 'franzoesisch', 'asiatisch', 'orientalisch', 'indisch', 'mexikanisch') for r in lib_after))
            groups = await page.locator('#libraryContent .lib-group').count()
            check('Bibliothek nach Küchen gruppiert', groups >= 1, f'{groups} Gruppen')
            await page.click('[data-libtype="Abend"]')
            check('Umschalten auf Abendessen', await page.get_attribute('[data-libtype="Abend"]', 'aria-pressed') == 'true')
            if await page.locator('#libraryContent .lib-group').count():
                await page.locator('#libraryContent .lib-group summary').first.click()
                await page.locator('#libraryContent [data-recipe^="lib:"]').first.click(); await page.wait_for_selector('#recipeDialog[open]')
                await page.select_option('#recipeCuisine', 'indisch'); await asyncio.sleep(0.3); await page.click('#recipeClose')
                check('Küche im Rezept von Hand ändern', 'Indisch' in await page.text_content('#libraryContent'))
            await page.click('[data-nav="plan"]')

            # Neuer Plan über die (simulierte) KI
            if has_plan: await page.click('[data-action="new-plan"]')
            await page.wait_for_selector('[data-view="form"]:not([hidden])')
            check('Formular mit altem Profil vorbelegt', (not old.get('nc_profile')) or await page.input_value('#pf-goal') == old['nc_profile'].get('goal', 'Muskelaufbau'))
            await page.select_option('#pf-days', '3'); await page.select_option('#pf-batch', 'aus'); await page.click('#generateBtn')
            await page.wait_for_selector('[data-view="plan"]:not([hidden])', timeout=20000)
            req = calls[-1]
            check('KI-Aufruf: Modell aus Konfiguration, Key im Header, Browser-Freigabe',
                  req['body'].get('model') == 'claude-sonnet-5-5' and req['headers'].get('x-api-key') == KEY and req['headers'].get('anthropic-dangerous-direct-browser-access') == 'true', req['body'].get('model'))
            check('Neuer Plan: 3 Tage angezeigt', await page.locator('#planContent .day').count() == 3)
            check('KI-Text wird als Text gezeigt, nicht als HTML', await page.locator('#xss').count() == 0 and '<img' in await page.text_content('#planContent'))
            data = await ls()
            libn = [r.get('name') for r in json.loads(data['nutricoach.library'])]; pan = [str(x.get('name')) for x in json.loads(data['nutricoach.pantry'])]
            check('Rezepte in Bibliothek, Grundzutat (Linsen) im Vorrat', 'Linseneintopf' in libn and any('Linsen' in n for n in pan), f'{len(libn)} Rezepte, letzte: {libn[-3:]}, Vorrat {len(pan)}')
            await page.click('[data-sub="plan:mealprep"]')
            check('Meal-Prep-Ansicht', 'Testgericht Mo' in await page.text_content('#mealprepContent'))
            await page.locator('[data-mp-days]').first.click(); await page.wait_for_selector('#daysDialog[open]')
            await page.fill('#daysInput', '4'); await page.click('#daysForm button[type=submit]')
            check('Meal-Prep: Kochen für 4 Tage gespeichert', 'Kochen für 4 Tage' in await page.text_content('#mealprepContent'))
            await page.locator('[data-recipe^="mp:"]').first.click(); await page.wait_for_selector('#recipeDialog[open]')
            body = await page.text_content('#recipeBody')
            check('Meal-Prep: Mengen umgerechnet (200g → 800g, 2 → 8 Portionen)', '800g' in body and '8 Portionen' in body, body[:200])
            await page.click('#recipeClose')
            check('Neue Rezepte bekommen die Küche', all(r.get('cuisine') for r in json.loads((await ls())['nutricoach.library']) if r.get('name') in ('Linseneintopf', 'Wrap')))
            await page.click('[data-sub="plan:nutrients"]')
            check('Nährwerte: 3 Tage à 1200 kcal = 3600', '3600' in await page.text_content('#nutrientsContent'))

            # Einkaufsliste abhaken bleibt nach Neuladen
            await page.click('[data-nav="shopping"]'); await page.locator('[data-item]').first.click()
            await page.reload(); await page.wait_for_selector('[data-view="plan"]:not([hidden])')
            await page.click('[data-nav="shopping"]')
            check('Abgehakter Artikel bleibt nach Neuladen abgehakt', await page.locator('[data-item][aria-pressed="true"]').count() == 1)
            await page.click('[data-sub="shop:pantry"]'); await page.click('[data-action="pantry-add"]')
            await page.fill('#pantryName', 'Testmehl'); await page.click('#pantryForm button[type=submit]')
            check('Vorrat: Artikel von Hand hinzufügen', 'Testmehl' in await page.text_content('#pantryContent'))

            # Kassenzettel zweimal scannen: Preisänderung wird erkannt
            await page.click('[data-nav="receipts"]')
            for price in (1.99, 2.49):
                mode['price'] = price
                async with page.expect_file_chooser() as fc: await page.click('[data-action="scan"]')
                await (await fc.value).set_files(str(ROOT / 'icons/icon-192.png'))
                await wait_true(page, f"document.querySelectorAll('[data-receipt-remove]').length >= {1 if price == 1.99 else 2}")
            check('Bild an KI geschickt (base64 JPEG)', calls[-1]['body']['messages'][0]['content'][0]['source']['media_type'] == 'image/jpeg')
            check('Preisänderung +25 % erkannt', '+25 %' in await page.text_content('#priceAlerts'), await page.text_content('#priceAlerts'))

            # Fehler der KI: Key abgelehnt
            mode['value'] = '401'
            await page.click('[data-nav="plan"]'); await page.click('[data-action="new-plan"]'); await page.click('#generateBtn')
            await page.wait_for_selector('[data-view="form"]:not([hidden])')
            await wait_true(page, "document.body.innerText.includes('abgelehnt')")
            check('KI-Fehler 401: verständliche Meldung, zurück zum Formular, alter Plan bleibt', await page.evaluate("JSON.parse(localStorage.getItem('nutricoach.plan')).length") == 3)
            mode['value'] = 'ok'

            # Backup: ohne Key
            await page.click('[data-nav="more"]')
            check('Mehr: Modell und gekürzter Key', await page.text_content('#factModel') == 'claude-sonnet-5-5' and KEY not in await page.text_content('#factKey'))
            async with page.expect_download() as dl: await page.click('[data-action="export"]')
            path = await (await dl.value).path(); text = pathlib.Path(path).read_text(); exp = json.loads(text)
            check('Backup: Format der neuen App, ohne API-Key', exp.get('app') == 'nutricoach' and 'apikey' not in exp['data'] and KEY not in text)

            # Offline
            await page.reload(); await page.wait_for_selector('[data-view="plan"]:not([hidden])')
            await wait_true(page, "navigator.serviceWorker && navigator.serviceWorker.controller !== null")
            await ctx.set_offline(True); await page.reload(); await page.wait_for_selector('[data-view="plan"]:not([hidden])')
            check('Startet offline mit Plan', await page.locator('#planContent .day').count() == 3)
            await ctx.set_offline(False)

            # CSP greift: eingeschleuster Inline-Code läuft nicht
            await page.evaluate("const s = document.createElement('script'); s.textContent = 'window.__inj = 1'; document.body.append(s)")
            await asyncio.sleep(0.3)
            check('CSP blockiert Inline-Script', await page.evaluate("window.__inj === undefined"))
            await page.screenshot(path=str(TMP / 'plan.png'))
            real = [e for e in errors if 'Content Security Policy' not in e and '401' not in e and 'ERR_INTERNET_DISCONNECTED' not in e]
            check('Keine unerwarteten Fehler in der Konsole', not real, real[:3])
            await b.close()
    finally:
        srv.terminate()
    ok = sum(1 for r in R if r[1]); print(f'\n{ok}/{len(R)} bestanden'); sys.exit(0 if ok == len(R) else 1)

asyncio.run(main())
