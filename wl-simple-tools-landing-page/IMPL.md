# Implementierung — Simple Tools Landing Page

_Stand: Backfill aus existierendem Code_

## File-Struktur
- `package.json` — NPM-Dependencies (express, sharp, pdf-lib, marked, multer, nanoid)
- `server.js` — Express-Backend (Port 3000), statische Auslieferung + API-Endpoints
- `index.html` — Landing-Page mit Hero, Tool-Grid und About-Sektion
- `data/links.json` — Persistenz für URL-Shortener (JSON-Objekt)
- `public/styles.css` — Custom CSS (Dark-Theme, Scrollbar, Toast, Diff-Highlights)
- `public/app.js` — Shared Client-Utilities: `toast`, `copy`, `download`, `el` (Toolkit-Objekt)
- `public/tools-index.js` — Rendert das Tool-Grid auf der Landing-Page, filtert live
- `public/tools/*.html` — 14 Tool-Seiten (jeweils eigenständig, mit Inline-CSS und Inline-JS)
- `public/favicon.svg` — Favicon

## Haupt-Funktionen & wo sie leben
- `Toolkit.toast(msg, ms)` (public/app.js) — Zeigt eine temporäre Benachrichtigung unten mittig
- `Toolkit.copy(text)` (public/app.js) — Kopiert Text in Zwischenablage, Fallback execCommand
- `Toolkit.download(filename, blobOrText, mime)` (public/app.js) — Erzeugt und klickt einen temporären Download-Link
- `TOOLS`-Array (public/tools-index.js) — Enthält Metadaten aller 15 Tools (Slug, Titel, Beschreibung, Tag, Icon, unavailable-Flag)
- `render(filter)` (public/tools-index.js) — Filtert `TOOLS` und rendert Karten in `#grid`
- `parseCSV(text, sep)` (public/tools/csv-converter.html) — RFC-4180-Parser mit Quoted Fields
- `diff(left, right)` (public/tools/diff-viewer.html) — LCS-basierter Zeilen-Diff (DP mit Uint16Array)
- `parseCron(s)` (public/tools/crontab.html) — Cron-Feld-Parser, unterstützt `@reboot` und Makros
- `nextRuns(sets, from, max)` (public/tools/crontab.html) — Brute-Force nächste Ausführungen (step-minute)
- `buildAlphabet()` (public/tools/password-generator.html) — Baut Zeichenpool aus Checkboxen
- `randomChar(alphabet)` (public/tools/password-generator.html) — crypto.getRandomValues-basierte Auswahl
- `makeTransparent(img, threshold)` (public/tools/transparent-bg.html) — Pixel-Operation auf Canvas, setzt Alpha = 0 bei RGB-Distanz ≤ Threshold
- `setFromRgb(rgb)` (public/tools/color-picker.html) — Aktualisiert alle Felder, Kontrast-Anzeige, Harmonien
- `buildPdf(text, mode, title)` (public/tools/txt-to-pdf.html) — Clientseitige PDF-Erzeugung mit pdf-lib, Markdown-Parsing
- `parseInline(line)` (public/tools/txt-to-pdf.html) — Extrahiert **bold**, *italic*, `code` aus Markdown-Zeile
- `wrapRuns(runs, size, maxW)` (public/tools/txt-to-pdf.html) — Zeilenumbruch für Styled-Tokens
- `/api/shorten`, `/s/:id`, `/api/links` (server.js) — URL-Shortener mit JSON-Datei-Speicher und TTL
- `/api/image/convert` (server.js) — Server-seitige Bildkonvertierung via sharp (multipart)
- `/api/image/strip-exif` (server.js) — EXIF-Entfernung via sharp (ohne .withMetadata)
- `/api/image/transparent` (server.js) — Transparent-Hintergrund via sharp (pixelweise Alpha)
- `/api/pdf/combine` (server.js) — PDF-Zusammenführung via pdf-lib (multipart)
- `/api/text/to-pdf` (server.js) — Text/Markdown → PDF (einfaches Typesetting)
- `/api/markdown/render` (server.js) — Markdown-zu-HTML-Rendering (via markdown-it)

## Datenflüsse
1. **Landing-Page Filter**: User tippt in `#filter` → Input-Event → `render(value)` → filtert `TOOLS` → rebuildt `#grid.innerHTML`
2. **Crontab**: User ändert Feld oder Preset → `update()` → setzt `expr.value` → `render()` → `parseCron()` → `combine()`/`nextRuns()` → füllt `#desc` und `#next`
3. **Color Picker**: User interagiert mit Slider/Input → `setFromRgb()` → aktualisiert alle Komponenten → berechnet Kontrast und Harmonien → schreibt `#onWhite`/`#onBlack`
4. **Bild-Tools (EXIF/Converter/Transparent)**: User wählt Datei oder Drag&Drop → `loadImage()` → Canvas-Operation → `canvasToBlob()` → `Toolkit.download()`
5. **URL-Shortener (Backend)**: POST `/api/shorten` mit `{url, ttlHours}` → `pruneExpired()` → `shortId()` → schreibt `links.json` → Antwort `{id, expiresAt}`; GET `/s/:id` → prüft `links.json`, redirect

## localStorage-Keys
- Keine genutzt

## Tools-Server-Endpoints in Verwendung
- `POST /api/shorten` (URL-Shortener)
- `GET /s/:id` (URL-Shortener Redirect)
- `GET /api/links` (Anzahl der aktiven Links)
- `POST /api/image/convert`
- `POST /api/image/strip-exif`
- `POST /api/image/transparent`
- `POST /api/pdf/combine`
- `POST /api/text/to-pdf`
- `POST /api/markdown/render`

## Externe Abhängigkeiten
- Tailwind CSS via CDN (`cdn.tailwindcss.com` mit Plugins forms, typography)
- marked via CDN (`cdn.jsdelivr.net/npm/marked@13.0.3`)
- DOMPurify via CDN (`cdn.jsdelivr.net/npm/dompurify@3.1.7`)
- pdf-lib via CDN (`cdn.jsdelivr.net/npm/pdf-lib@1.17.1`)
- NPM: express, sharp, pdf-lib, markdown-it, multer, nanoid

## Bekannte Caveats / Bug-Quellen
- URL-Shortener Tool-Seite zeigt Hinweis „Nicht verfügbar“ – funktioniert nur wenn `server.js` läuft
- EXIF-Entferner nutzt Canvas-Re-Encoding → kein EXIF mehr, aber Bildqualität leidet (JPEG-Re-Kompression)
- `transparent-bg` verwendet Pixel (0,0) als Referenz; bei Bildern mit schwarzem Rand (z.B. screenshots) kann dies zu unerwünschter Transparenz führen
- `csv-converter` erwartet RFC-4180; Zeilenumbrüche in Feldern werden nur bei doppelten Anführungszeichen korrekt behandelt
- Crontab-Generator: Brute-Force bis 2 Jahre, kann bei seltenen Cron-Ausdrücken lange brauchen (kein Timeout)
- Password-Generator: `excludeSimilar` entfernt nur statisch definierte Zeichen (0/O/1/l/I), keine Konfiguration
- Diff-Viewer: LCS-basiert, keine Wort-Diffs, keine semantischen Optimierungen
- `txt-to-pdf` (client): Markdown-Parsing rudimentär (nur **bold**, *italic*, `code`); Tabellen, Links werden als Text dargestellt; Unicode außerhalb WinAnsi wird durch `?` ersetzt
- PDF-combine (client): `ignoreEncryption: true` – verschlüsselte PDFs werden trotzdem geladen, aber Warnung unterdrückt
- Server-Endpoints nutzen einfache Fehlerbehandlung (kein Logging, kein Rate-Limiting)
- Keine offensichtlichen Caveats im Code sichtbar.

## Nicht implementiert / Out of Scope
- QR-Code-Generator (in url-shortener-Info erwähnt, aber nicht gebaut)
- User-Authentifizierung, Session-Management
- Progressive Web App (kein Service Worker, kein Manifest)
- Barrierefreiheit (keine ARIA-Labels, keine Skip-Links)
- Mehrsprachigkeit (nur Deutsch)
- Server-seitige Caching-Strategien (kein Cache-Control)
- PDF-Text extrahieren (nicht gefordert)
- Bildbearbeitung mit Filtern oder Zuschneiden (nur Formatkonvertierung und Transparenz)