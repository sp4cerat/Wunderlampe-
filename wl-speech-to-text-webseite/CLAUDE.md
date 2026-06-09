# Implementierungs-Auftrag (Issue 2)

In diesem Verzeichnis liegt **bereits eine bestehende Webapp** (siehe vorhandene Dateien wie `index.html`, etc.). Diese wurde in vorigen Iterationen aufgebaut.

## Was du bekommst

- `concept.md` — **NUR das aktuelle Issue**, also die Sections die seit dem letzten Build neu hinzugekommen oder geändert wurden. **Das ist dein Auftrag.**
- `full-concept.md` — das vollständige Projekt-Konzept (Initial + alle Issues) **nur als Referenz**, falls du Kontext brauchst. **NICHT komplett neu umsetzen.**
- `history/` — frühere Konzept-Snapshots der vorigen Builds.

### NEU seit dem letzten Build (Fokus dieses Auftrags)
- `<!-- section:issue-2 -->`

Das sind die Sections die sich an das vorhandene Konzept angehängt haben — sie beschreiben das aktuelle Issue. Konzentriere dich auf deren Umsetzung.

## Strikte Vorgaben

- **Bestehende Architektur respektieren**: keine kompletten Rewrites, kein unnötiger Wechsel des Tech-Stacks, keine Datei-Strukturänderungen die nicht zwingend nötig sind.
- **Diff-orientiert arbeiten**: lies erst die existierenden Dateien, finde die richtigen Stellen, ändere/erweitere präzise.
- **`index.html` bleibt der Entrypoint** für die Seite. Tech-Stack-Erweiterungen (z.B. Backend-Skript, Cron-Job, Build-Tools) sind erlaubt, wenn das Issue sie verlangt.
- **Nicht halbfertig abbrechen**: das Issue muss vollständig integriert sein und die App weiter lauffähig.
- **Niemals API-Keys, Tokens oder Secrets in vom Browser geladene Dateien einbauen.** Keine String-Literale wie `const KEY = 'xyz…'` in `app.js`, `index.html` oder anderen client-geladenen Dateien — auch nicht aus `process.env` / `~/.secrets/*` reinrendern. Bei Backend-Komponenten bleibt der Key auf dem Server, Browser ruft einen Proxy-Endpoint auf. Bei pure Client-Side: Key zur Laufzeit vom User per Eingabefeld → `localStorage` abfragen. Falls der bestehende Code bereits einen Key hardcoded hat: das gilt als Bug — entfernen und auf eines der beiden Pattern umstellen.

## Server-Umgebung & verfügbare Ressourcen

Diese App läuft auf `test.svenforstmann.com` als Unter-Pfad `/wunderlampe/projects/<id>/` (Reverse-Proxy auf den Wunderlampe-Server, Port 3780). Du wirst als root in diesem Projekt-Verzeichnis ausgeführt und hast vollen Server-Zugriff — nutze ihn aktiv, damit das Endprodukt sofort live ist und der User keine manuellen Deployment-Schritte hinterherholen muss.

### LLM-API-Keys

- Liegen in `/root/.secrets/api-keys.env` (mode 600, root:root). Beispiel-Variablen: `AIMLAPI_KEY=…`, ggf. `SETTINGS_TOKEN=…`.
- Serverseitig laden (Node: `require('dotenv').config({ path: '/root/.secrets/api-keys.env' })`, Python: `python-dotenv` oder `os.environ`).
- **Niemals** in vom Browser geladene Dateien rendern — Pattern siehe Strikte Vorgaben oben.

### Default-LLM: DeepSeek V4

Wenn das Konzept kein anderes Modell vorgibt, nimm DeepSeek V4 über aimlapi.com:

- Endpoint: `https://api.aimlapi.com/v1/chat/completions` (OpenAI-kompatibel)
- Modell-ID: `deepseek/deepseek-v4-flash`
- Auth: `Authorization: Bearer ${AIMLAPI_KEY}`
- Nur abweichen, wenn das Konzept explizit z.B. Claude, Gemini oder ein lokales Modell verlangt.

### nginx & systemd – du darfst Server-State ändern

Wenn dein Projekt einen Backend-Dienst (eigener Port) oder einen eigenen API-Pfad unter `/wunderlampe/projects/<id>/api/` braucht, darfst du:

- `/etc/nginx/sites-enabled/sllm` editieren (das ist der vhost für test.svenforstmann.com). Vorher backuppen (`cp … /root/<name>.bak.$(date +%s)`).
- Snippets unter `/etc/nginx/snippets/*.conf` anlegen und per `include` in den passenden `server { … }` Block einhängen.
- `nginx -t && systemctl reload nginx` ausführen.
- systemd-Units in `/etc/systemd/system/` anlegen, `systemctl daemon-reload && systemctl enable --now <unit>` ausführen.
- **pm2** bedienen: `pm2 list`, `pm2 start <script> --name <n>`, `pm2 reload <n>`, `pm2 stop <n>`, `pm2 logs <n>`, sowie `/root/wunderlampe/ecosystem.config.cjs` editieren wenn dein Projekt einen Node-Daemon braucht (Alternative zu systemd für Node-Apps). Wunderlampe selbst läuft als pm2-Prozess `wunderlampe` — also Vorsicht beim Reload des eigenen Prozesses.

Konventionen für nginx-Locations in diesem vhost:
- API-Pfad spezifischer als `/wunderlampe/projects/` setzen (sonst gewinnt der allgemeine Proxy auf 3780).
- `auth_basic off;` in der Location, wenn die API aus dem öffentlich-zugänglichen Frontend gerufen wird (server-weit ist Basic-Auth aktiv; Schwester-Locations wie `/wunderlampe/projects/` schalten sie ab).
- Backend an `127.0.0.1:<PORT>` binden, nicht `0.0.0.0` — nginx ist der einzige öffentliche Eingang.

Wenn die Architektur das nicht braucht (pure Static-Site), lass es.

### Geteilte Tools-API (statt eigene Lib installieren)

Auf `http://127.0.0.1:8780` läuft ein zentraler `tools-server` (FastAPI) mit
gemeinsamen Schwergewichten — nutze ihn statt jedes Mal Trafilatura, DDG, TTS
oder PDF-Parser selbst zu installieren. Loopback-only, kein Auth, kein
Network-Tax. Endpoints:

- `GET  http://127.0.0.1:8780/health` – aktuelle Endpoint-Liste (Quelle der Wahrheit; check vor Verwendung).
- `GET  /web/search?q=…&max_results=10&time=d|w|m|y&region=de-de` – DuckDuckGo, JSON `{results:[{title,url,snippet}]}`.
- `GET  /web/extract?url=…` – Trafilatura: lädt URL, liefert `{title,author,date,text,language}`.
- `POST /speech/tts` – Body `{text,voice,format,model,speed}`, antwortet mit Audio-Binary (default mp3 via aimlapi gpt-4o-mini-tts).
- `POST /extract` – Multipart-Upload `file=@doc.pdf|docx|html|txt|md`, liefert `{text, pages[], metadata}`.
- `GET  /weather?lat=&lng=&days=` – Open-Meteo: `{current, daily[{date,tmin,tmax,precipitation,...}]}` (kein Key).
- `GET  /geocode?q=…&countrycodes=de,at,ch` – OSM Nominatim: `[{lat,lng,display_name,address}]` (kein Key).
- `GET  /reverse-geocode?lat=&lng=` – Adresse zu Koordinaten.
- `GET  /places/nearby?lat=&lng=&r=&q=cafe|restaurant|apotheke|…` – OSM Overpass; `q` ist Preset oder direkt `'amenity=pharmacy'`; `r` in Metern (50-20000).
- `GET  /stocks?ticker=AAPL&range=1mo&interval=1d` – yfinance: `{info:{price,currency,...}, history:[{date,open,high,low,close,volume}]}` (kein Key, aber Yahoo kann throttlen).
- `POST /ocr` – Multipart `file=@img.png`, Form-Fields `lang=deu+eng` (default), `blocks=true` für Wort-Bounding-Boxes. Tesseract lokal — keine Cloud.
- `POST /rag/index` – Body `{namespace, documents:[{id?,text,metadata?}], upsert?}`. Lokale Embeddings (paraphrase-multilingual-MiniLM-L12-v2, DE+EN+50 weitere), Chroma persistent. Namespace ist alphanumerisch, beginnt mit Buchstabe/Zahl. `upsert:true` (Default) → doppelte IDs überschreiben.
- `GET  /rag/query?namespace=&q=&top_k=5` – Top-k semantische Suche, liefert `{results:[{id,text,score,distance,metadata}]}`. `where=` als JSON für Metadata-Filter (Chroma-Syntax, z.B. `{"author":"Schmidt"}`).
- `GET  /rag/namespaces` – `[{name, count}]`.
- `DELETE /rag/namespace/{name}` – leert Namespace komplett.
- `POST /web/render` – Body `{url, wait_for?, wait_ms?, screenshot?, full_page?, timeout?, viewport_width?, viewport_height?, user_agent?}`. Headless Chromium für JS-heavy SPAs (React/Angular/Vue). Liefert `{title, html, text, final_url, screenshot_png_b64?}`. Für statische Seiten ist `/web/extract` (Trafilatura) schneller — nur wenn JS-Rendering nötig.
- `GET  /events/search?location=&when=&q=&max_per_query=8` – Web-Scraping für lokale Events. Komponiert mehrere deutsche+englische Suchqueries gegen DDG (veranstaltungen / events / was los / konzert | festival | ausstellung / eventbrite / meetup), mergt+dedupliziert. Liefert `{results:[{title,url,snippet,matched_queries}]}` sortiert nach Mehrfach-Treffern. Anschluss: pro URL `/web/extract` oder `/web/render` für Details, evtl. mit LLM-Parsing für strukturierte Event-Daten (Datum, Ort, Tickets).
- `GET  /sec/filings?ticker=AAPL&form=10-K|10-Q|8-K&limit=20` – SEC-EDGAR-Filings für US-Unternehmen (kein Key, nur US-Listings). Liefert Liste von Filings mit Datum, Accession-Nummer und direkter URL zum Filing-Dokument. `form` kommagetrennt für mehrere (`'10-K,10-Q'`).
- `GET  /sec/facts?ticker=AAPL&concept=Revenues&taxonomy=us-gaap&unit=USD` – strukturierte XBRL-Zeitreihen (Umsatz, Net Income, Assets, EPS, …) über alle Reporting-Perioden. Liefert `{units:{USD:[{end,val,fy,fp,form,filed}]}}`. **Wichtig:** Konzept-Namen sind US-GAAP-spezifisch und ändern sich je Unternehmen (Apple z.B. nutzt seit ASC 606 `RevenueFromContractWithCustomerExcludingAssessedTax` statt `Revenues`). Bei 404 erst `/sec/concepts` aufrufen.
- `GET  /sec/concepts?ticker=AAPL&contains=Revenue&limit=200` – discoverability: alle XBRL-Konzepte des Unternehmens, optional substring-gefiltert.
- `POST /llm/chat` – Body `{messages:[{role,content}], system?, model?, temperature?, max_tokens?}`. OpenAI-kompatibler LLM-Proxy via aimlapi; Default-Modell `deepseek/deepseek-v4-flash`. Liefert `{reply, model, usage}`. Nutzen, wenn dein Projekt einen Chat-Endpoint oder Q&A-Feature braucht — bau NICHT die LLM-Logik im Projekt selbst, der Key liegt zentral hier.

Beispiel (Node, Backend-Route, die Suchergebnisse durchreicht):
```js
const r = await fetch('http://127.0.0.1:8780/web/search?q=' + encodeURIComponent(query) + '&max_results=10');
const { results } = await r.json();
```

Wenn dir ein Tool fehlt (OCR, Playwright-Render, Wetter, Aktien, RAG, etc.) — frag den User. Der Service wird inkrementell erweitert; eigene Implementierung im Projekt nur, wenn das Konzept es explizit verlangt.

## IMPL.md — Implementierungs-Zusammenfassung schreiben (PFLICHT-Schritt am Ende)

Bevor du fertig bist, schreibe `IMPL.md` im Projekt-Wurzelverzeichnis. Diese Datei beschreibt dem nächsten Brainstorm-Lauf (kleines LLM, sieht KEINEN Code), wie die App **tatsächlich gebaut** ist. Damit das Brainstorming für das nächste Issue informiert geschieht statt blind zu raten.

**Wenn IMPL.md schon existiert**: lies sie zuerst, aktualisiere die geänderten Stellen, ergänze was durch dieses Issue neu/anders ist. Keinen kompletten Rewrite — die Historie der Caveats ist wertvoll.

**Format** (Markdown, ziel ~100–250 Zeilen, knapp & konkret):

```md
# Implementierung — <Projekt-Titel>

_Stand: nach <versionLabel>_

## File-Struktur
- `index.html` — Entrypoint, lädt …
- `app.js` — Haupt-Logik (Klasse/Modul X)
- `server.js` — Backend-Proxy für API-Y (Port Z)
- `styles.css` — …
- (alle relevanten Files; node_modules/uploads/history überspringen)

## Haupt-Funktionen & wo sie leben
- `renderNewsList(items)` (app.js:120) — baut die News-Karten aus dem Cache, ruft `relevanceColor()` …
- `fetchAndSummarize()` (app.js:340) — orchestriert RSS-Fetch + Web-Suche + LLM-Summary
- `POST /api/llm` (server.js:45) — Proxy zu tools-server `/llm/chat`, fügt Key serverseitig dran
- (key Funktionen, mit File:Zeilennummer)

## Datenflüsse
- User klickt „Zusammenfassen" → `fetchAndSummarize()` → RSS via `/web/extract` + Suche via `/web/search` → Ergebnisse an `/llm/chat` → JSON-Response in `newsCache` (localStorage) → `renderNewsList()`.
- (2–4 Hauptflüsse als kurze Pfeil-Ketten)

## localStorage-Keys
- `rssFeeds`: string[] — RSS-URLs
- `portfolio`: {symbol,name}[]
- (alle persistierten Keys + Shape)

## Tools-Server-Endpoints in Verwendung
- `/web/search`, `/web/extract`, `/llm/chat`, `/stocks`
- (die tatsächlich aufgerufenen — nicht die theoretisch verfügbaren)

## Externe Abhängigkeiten
- Tailwind via CDN
- (CDN-Pakete, NPM-Deps falls Backend)

## Bekannte Caveats / Bug-Quellen
- Web Speech API feuert `onresult` über Session-Grenzen mehrfach — Workaround in Issue 3 via Text-Dedup (`appendDeduped` in app.js:200).
- DDG kann throtteln — Retry-Logik in app.js:480 (max 2 Retries, dann leeres Ergebnis).
- (Stolpersteine, die der nächste Brainstorm-Lauf wissen muss, sonst gibt es Vorschläge die schon ausprobiert wurden oder die mit der Realität kollidieren)

## Nicht implementiert / Out of Scope
- Echte User-Auth (App ist static-client)
- Server-seitiger Cron für Auto-Updates
- (was im Konzept stand, aber bewusst weggelassen wurde)
```

Pflicht: `IMPL.md` MUSS am Ende des Builds existieren und den aktuellen Stand widerspiegeln. Wenn etwas inkrementell unklar bleibt, schreib es offen rein (z.B. „TODO: Datenfluss für Aktien-Update prüfen") — besser als zu lügen.

## Workflow

1. `ls` den aktuellen Verzeichnisinhalt.
2. Lies `index.html` (und ggf. weitere Dateien) um den Status quo zu verstehen.
3. Lies `IMPL.md` (falls vorhanden) — Schnell-Überblick was schon da ist und wo Caveats sitzen.
4. Lies `concept.md` — das ist der konkrete Auftrag (nur das Issue).
5. Bei Bedarf in `full-concept.md` nachsehen für Gesamtkontext.
6. Plane: welche Stellen im Code sind betroffen, welche Files werden geändert.
7. Wende die Änderungen an.
8. Aktualisiere `IMPL.md` (oder lege neu an) gemäß Spec oben — Pflicht-Schritt.
9. Kurze Zusammenfassung am Ende: was wurde geändert, was bleibt für später.