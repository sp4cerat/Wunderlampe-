# Simple Tools Landing Page

<!-- section:ziel -->
## Ziel
Eine Webseite mit Landing Pages für einfache Tools, gehostet auf Hardware mit 6 vCPU und 8 GB RAM. Fokus auf SEO-Nischen. Die 13 Tool-Ideen:
1. JSON Formatter/Validator
2. Passwort/Token Generator
3. Crontab Generator
4. Markdown zu HTML Konverter
5. Exif-Daten Entferner
6. CSV zu JSON/XML Konverter
7. Diff-Viewer
8. Unit Converter für Nischen
9. URL Shortener (Privat/Temporär)
10. Base64 Encoder/Decoder
11. Bild Converter: Nutzt Standard-Unix-Bildkonvertierungstools (z.B. ImageMagick) im Hintergrund zur Konvertierung zwischen Formaten.
12. PDFs kombinieren: mehrere PDFs hochladen und zu einer zusammenführen.
13. Color Picker mit RGB/HEX für Webentwickler.
- Zentrale Übersichtsseite, die alle 13 Tools auflistet und verlinkt.
- txt / markdown zu PDF Konverter
15. Hintergrund transparent machen: Farbe von Pixel (0,0) nehmen, mit Threshold als Alphakanal setzen. Export als PNG oder WebP (falls transparent unterstützt).
<!-- section:tech-stack -->
## Tech-Stack
Nicht spezifiziert. Annahme: Statische HTML-Seiten? (offene Frage)

<!-- section:offene-fragen -->
## Offene Fragen
- Werden die Tools clientseitig oder serverseitig betrieben?
- Welche UI-Framework? Keine Angabe.<!-- section:issue-1-fix-paths -->
## Issue 1: Pfad-Fix für statische Assets
- **Problem:** Absolute Pfade (z.B. `/styles.css`, `/tools-index.js`) funktionieren nicht unter Wunderlampe (Projekt wird unter `/projects/<sid>/` gemountet, eigener Server läuft nicht).
- **Lösung:** Alle Links in `index.html` relativ zum Projekt-Ordner machen:
  - `favicon` → `public/favicon.svg`
  - `styles.css` → `public/styles.css`
  - `tools-index.js` → `public/tools-index.js`
- **Zusätzlich:** In `public/tools-index.js` die Tool-Card-Links (`href="/tools/${slug}"`) ersetzen durch `href="public/tools/${slug}"`.
- **Server-Tools:** Sind ohne laufenden `node server.js` nicht nutzbar – muss später auf rein clientseitige Implementierung umgestellt werden (offene Frage).<!-- section:issue-2 -->
## Issue 2: Fix fehlende .html-Endung in Tool-Links

* In `public/tools-index.js` Zeile 49 die URL von `href="public/tools/${t.slug}"` auf `href="public/tools/${t.slug}.html"` ändern.<!-- section:issue-3 -->
## Issue 3: Tool-Seiten Pfad-Fix (Assets, Navigation, Client-seitige Tools)

- **Problem:** Alle 15 Tool-HTML-Dateien (z.B. `public/tools/password-generator.html`) referenzieren Assets und Links mit absoluten Pfaden (`/styles.css`, `/app.js`, `href="/"`). Unter Wunderlampe (statisches Mounting unter `/projects/<sid>/`) führen diese Pfade zum Host-Root → 404.
- **Fix-Aufgaben:**
  - In jeder Tool-HTML: CSS/JS-Pfade von `/styles.css` → `../styles.css` (relativ zum `public/tools/`-Ordner)
  - Zurück-Links (`<a href="/">`) → `../../index.html` oder `../` (je nach Struktur)
  - API-Endpunkte (z.B. `/api/remove-background`) durch clientseitige Canvas-Implementierung ersetzen, da der Node-Server nicht läuft. Betrifft:
    - Tool 10 (Bild-Konverter) → Canvas mit FileReader/Image
    - Tool 11 (EXIF-Entferner) → FileReader ohne EXIF (oder strip via Canvas)
    - Tool 12 (Hintergrund transparent) → Canvas: Pixel (0,0) lesen, Threshold, ImageData.set
    - Tool 13 (PDFs kombinieren) → pdf-lib clientseitig im Browser
    - Tool 14 (Text/Markdown → PDF) → pdf-lib clientseitig
    - Tool 15 (URL-Shortener) → entfällt (braucht Server) – als "nicht verfügbar" anzeigen oder komplett entfernen
- **Akzeptanzkriterien:**
  1. Keine 404 für CSS/JS beim Aufruf eines beliebigen Tools
  2. Zurück-Button führt zur Landing-Page
  3. Hintergrund transparent Tool: lädt Bild → wählt Farbe (0,0) → wendet Threshold an → zeigt PNG-Vorschau / Download (alles im Browser, kein Server) → funktioniert auch ohne Netz
  4. Andere Server-Tools analog clientseitig<!-- section:issue-4 -->
## Issue 4: Bugs im Markdown→PDF-Tool

- Tabellen werden nicht korrekt in das PDF übernommen.
- Fettschrift (`**text**` oder `__text__`) funktioniert nicht innerhalb von Bulletpoint-Auflistungen.
- Tabellen werden nicht korrekt in das PDF übernommen.
- Fettschrift (`**text**` oder `__text__`) funktioniert nicht innerhalb von Bulletpoint-Auflistungen.
- **Allgemeiner Review:** Alle anderen Markdown→PDF-Features (Überschriften, normale Absätze, Codeblöcke, horizontale Linien, Links, Listen ohne Fettschrift) sollen auf korrekte Wiedergabe geprüft werden.