# Implementierung — Speech-to-Text

_Stand: nach Issue 2 (Dedup-Strategie aus dem personalisierten Nachrichtendienst übernommen)_

## File-Struktur
- `index.html` — Entrypoint, Wurzel-Verzeichnis. Lädt Tailwind via CDN (`cdn.tailwindcss.com`), `styles.css` und `app.js`. Enthält Header, Toolbar (Start/Stop-Button + Sprachauswahl), Textarea, Action-Row (Copy/Clear) und Footer. Keine externen Builds, kein Bundler.
- `app.js` — Komplette Client-Logik als IIFE. Web Speech API Recognizer mit der Dedup-Strategie aus dem News-Service-Projekt (`mpjq05ivukpa`), State `baseline`/`finalSoFar`, frische SR-Instanz pro Session, Wort-Dedup gegen committeten Stand.
- `styles.css` — Subtile Background-Gradients, Custom-Scrollbar für die Textarea, Styling für `<select>` (Tailwind reicht nicht für `option`-Hintergründe in dark mode).
- `concept.md` / `full-concept.md` / `CLAUDE.md` — Spec und Build-Anweisungen.

## Haupt-Funktionen & wo sie leben
- `normWord(w)` (app.js:48) — lowercase + alle Nicht-Letter/Nicht-Ziffer entfernt (Unicode-aware via `\p{L}\p{N}`). Vergleichsbasis für die Dedup.
- `basisWords(basis)` (app.js:55) — tokenisiert + normalisiert den Basis-Text, gecached gegen wiederholten Aufruf in derselben Tick-Phase.
- `appendDeduped(currentCommitted, candidate)` (app.js:69) — Zwei-Stufen-Dedup:
  - **Stage A**: längster Suffix-Prefix-Overlap auf Wortebene zwischen `commN` (basis) und `candN[0..k)` — fängt den Haupt-Bug (Chrome re-emittiert die letzten Worte beim Session-Restart komplett).
  - **Stage B**: konservative n-Gramm-Prüfung (Run-Länge ≥ 3) für Re-Emits irgendwo in der Mitte; harmlose Floskeln wie „und der" (Run-Länge 2) bleiben unangetastet.
- `handleResult(ev)` (app.js:175) — iteriert ab `ev.resultIndex` (NICHT ab 0), absorbiert vorab User-Edits via `absorbEditSync()`, dedupt neue Finals gegen `baseline+finalSoFar`, hängt das Ergebnis an `finalSoFar` an, schreibt mit `writeBack(interim)`.
- `absorbEditSync()` (app.js:202) — übernimmt `ta.value` als `baseline`, setzt `finalSoFar=''`. Wird unmittelbar vor jedem `handleResult` aufgerufen, falls der User editiert hat.
- `absorbEditAndRestart()` (app.js:211) — debounced-Variante (300ms): wie oben, zusätzlich `recognition.stop()` damit eine FRISCHE SR-Instanz die alten `ev.results` los ist.
- `createRec()` (app.js:220) — instanziiert eine NEUE `SpeechRecognition`. WICHTIG: pro Session frisch erzeugen — Chrome behält bei `rec.start()` auf derselben Instanz die alten Results in `ev.results`, was die Ursache der Duplikate war. Setzt `onstart`/`onresult`/`onerror`/`onend`.
- `r.onend` (app.js:251) — bei `listening=true` wird `ta.value` als neue `baseline` eingefroren (inkl. evtl. User-Edits), `finalSoFar=''`, und eine FRISCHE Instanz erzeugt + gestartet. Wenn `r !== recognition` (Instanz wurde durch Sprachwechsel/Reset ersetzt), nichts tun.
- `start()` (app.js:277) / `stop()` (app.js:292) — toggeln den Recognizer; `stop()` setzt `listening=false` damit `onend` _nicht_ auto-restartet, killt den Edit-Absorb-Timer.
- `writeBack(interim)` (app.js:159) — setzt `ta.value = baseline + finalSoFar`, schreibt `interim` in den Overlay-Span, aktualisiert `lastWritten` und den Zeichen-Counter.
- Textarea-`input`-Handler (app.js:317) — debounced (300ms) → `absorbEditAndRestart()`.
- `flashCopy(msg, ok)` (app.js:354) — 1.2s grünes/rotes Feedback am Copy-Button (über Tailwind `!`-prefixed classes).

## Datenflüsse
- **User klickt „Aufnahme starten"** → `start()` setzt `baseline = ta.value` (mit Trailing-Space-Garantie), `finalSoFar=''`, erzeugt FRISCHE `recognition = createRec()` und ruft `.start()` → Browser fragt Mic-Permission → `onstart` setzt Status `listening` und UI auf rot.
- **Sprache → Web Speech API → `onresult`** iteriert ab `ev.resultIndex`, sammelt neue Finals, dedupt sie via `appendDeduped()` gegen `baseline+finalSoFar`, hängt das Ergebnis an `finalSoFar` an. `writeBack(interim)` rendert.
- **Session-Auto-Pause (Stille)** → `onend` → `baseline = ta.value`, `finalSoFar=''`, **NEUE** `recognition = createRec()` → `.start()` (alte ev.results bleiben auf der toten Instanz; neue Instanz startet mit leerem ev.results).
- **User editiert die Textarea während des Hörens** → input-Listener debounced 300ms → `absorbEditAndRestart()` → `baseline = ta.value`, `finalSoFar=''`, `recognition.stop()` → `onend` erzeugt frische Instanz und startet sie.
- **User klickt „Kopieren"** → `navigator.clipboard.writeText(ta.value)` mit `execCommand`-Fallback → Erfolg/Fehler-Flash am Button.
- **User wechselt Sprache** → in `localStorage[s2t.lang]` → wenn live: `stop() → setTimeout(start, 250)`. Sprachwechsel zur Laufzeit braucht Neustart, der Recognizer übernimmt `lang`-Änderungen nicht live.
- **User klickt „Leeren"** → confirm (wenn >40 Zeichen) → `baseline='', finalSoFar='', ta.value=''`. Wenn live: `recognition.stop()` (onend-Hook spawnt eine frische Instanz auf leerer baseline).

## State-Variablen
- `recognition: SpeechRecognition | null` — aktuelle SR-Instanz. WICHTIG: pro Session frisch erzeugt (Chrome leakt sonst `ev.results`).
- `listening: boolean` — Steuert Auto-Restart in `onend`.
- `baseline: string` — Text der vor dem Start dieser SR-Instanz im Feld stand. Bleibt während der Instanz-Sitzung konstant; beim onend-Restart wird `ta.value` eingefroren.
- `finalSoFar: string` — additiver Final-Text der AKTUELLEN SR-Instanz. Wird in jedem `onresult` durch `appendDeduped()` gewachsen.
- `lastWritten: string` — letzter Wert, den `writeBack` ins Textarea geschrieben hat. Wenn `ta.value` davon abweicht, hat der User manuell editiert → absorbieren.
- `dedupBasisCache` — Cache der tokenisierten/normalisierten `basisWords()`; invalidiert durch `invalidateDedupCache()` nach jedem writeBack.
- `editAbsorbTimer: number | null` — `setTimeout`-Handle für die 300ms-debouncte Edit-Absorption.

## localStorage-Keys
- `s2t.lang`: string — BCP-47 Locale (z.B. `de-DE`, `en-US`). Beim Laden: gespeicherter Wert oder `navigator.language` Match, sonst `de-DE`.

## Tools-Server-Endpoints in Verwendung
- **Keine.** Pure Client-Side App. Web Speech API ist Browser-nativ. Kein Backend, kein nginx-Patching, keine systemd-Unit, keine pm2-Registrierung nötig — wird über den Default-Proxy `/wunderlampe/projects/<id>/` ausgeliefert.

## Externe Abhängigkeiten
- Tailwind via CDN: `https://cdn.tailwindcss.com` (JIT im Browser, kein Build).
- Keine NPM-Deps, keine `package.json`.
- Browser-APIs: Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`), Clipboard API (`navigator.clipboard`), localStorage.

## Bekannte Caveats / Bug-Quellen
- **Web Speech API Browser-Support** ist Chromium-only (Chrome/Edge/Brave/Opera). Firefox + Safari Desktop liefern weder `SpeechRecognition` noch `webkitSpeechRecognition` — wir zeigen dann ein gelbes Warning-Banner und deaktivieren die Buttons.
- **[Issue 1, Approach verworfen]** Der ursprüngliche Fix iterierte von 0 bis `e.results.length` und rebuildete `sessionFinal` komplett bei jedem Event. Das vermied Duplikate INNERHALB einer SR-Instanz, aber sobald die Instanz ihren internen Session-State zurücksetzt (auto-pause bei Stille, weiter `continuous=true`), liefert Chrome bei der gleichen Instanz neue Events mit den ALTEN Results unter neuen Indizes — was die Duplikate weiter erzeugte. Issue 2 ersetzt das durch die News-Service-Strategie.
- **[Issue 2, gefixt]** **Duplikate trotz Issue-1-Fix**: Wurzel ist, dass Chrome auf derselben `SpeechRecognition`-Instanz die alten `ev.results` über Session-Grenzen hinweg beibehält und Finals dadurch wiederholt liefert. Fix in zwei Teilen:
  1. **Pro auto-Restart eine FRISCHE SR-Instanz** erzeugen statt `rec.start()` auf der alten — neue Instanz hat leeres `ev.results`.
  2. **`appendDeduped()`-Safety-Net**: zwei-stufiger Wort-Dedup (Suffix-Prefix-Overlap + n-Gramm-≥3) gegen `baseline+finalSoFar`. Fängt auch Chrome-Re-Emits innerhalb einer Instanz ab.
  Beide Strategien sind 1:1 aus `mpjq05ivukpa/app.js` (`appendDeduped`, `initMic.createRec`) übernommen. **Wichtig für nächste Iterationen**: nicht zurück zum „rebuild-from-0"-Pattern oder zum naiven Append wechseln — beides hatte den Duplikat-Bug.
- **`recognition.start()` direkt nach `stop()`** kann `InvalidStateError` werfen. Wir fangen ab und retryen einmal mit 200ms-Delay (app.js:283 / app.js:271).
- **Clipboard API braucht https oder localhost**. `document.execCommand('copy')`-Fallback (app.js:344) — funktioniert auf älteren Browsern und unsicheren Origins.
- **Mic-Permission persistiert nicht über Pageloads** in manchen Browsern → User muss ggf. erneut bestätigen.
- **Sprachwechsel zur Laufzeit** funktioniert nur via Stop+Start (app.js:311) — der Recognizer übernimmt `lang`-Änderungen nicht live.
- **Manueller Edit der Finals während des Hörens**: debounced 300ms, dann `baseline = ta.value`, `finalSoFar=''`, Recognizer-Neustart (sonst leaken die alten `ev.results` die schon committeten Phrases zurück in `finalSoFar`).
- **Dedup-Tradeoff**: Wenn der User absichtlich „Hallo Welt" zweimal hintereinander sagt, schluckt Stage A das zweite Vorkommen (Suffix-Prefix-Overlap=2 → komplett verworfen). Das ist der bewusste Tradeoff der News-Service-Strategie — Fehlalarme sind selten und der Schutz gegen Chrome-Re-Emits ist robuster.

## Nicht implementiert / Out of Scope
- Kein Speichern der Transkription über Pageloads hinweg (Text wird beim Reload geleert; nur die Spracheinstellung persistiert).
- Kein Server-side Speech-to-Text (z.B. Whisper, AIMLAPI) — Konzept verlangt explizit Browser-only.
- Keine Speaker-Diarization, kein Timestamping, keine Multi-Speaker-Erkennung.
- Kein Export (Download als .txt) — Copy reicht laut Konzept.
- Keine Themes/Lightmode-Toggle — dark theme nur.
- Keine Mobile-Optimierungen über das Tailwind-Responsive-Layout hinaus (Mic-Permission auf iOS Safari sowieso nicht verfügbar).
