# Speech-to-Text Webseite

<!-- section:ziel -->
## Ziel
Eine einfache Webseite, die per Mikrofon Sprache erkennt und als Text anzeigt – ohne Server, nur im Browser.
* Umsetzung basiert auf Code des personalisierten Nachrichtendienstes (Web Speech API, statischer Client).
<!-- section:user-flows -->
## User-Flows
### Flow 1: Sprache erfassen
1. User öffnet die App → sieht Start-Button und Textfeld.
2. Klickt auf Start → Mikrofon wird aktiviert (Berechtigungsanfrage), Transkription läuft in Echtzeit.
3. Text erscheint direkt im Textfeld.
4. Klickt auf Stop → Transkription endet, Text bleibt sichtbar.
### Flow 2: Text kopieren
1. Nach der Aufnahme klickt User auf Copy-Button.
2. Text wird in die Zwischenablage kopiert (Clipboard API).
3. Kurze visuelle Rückmeldung (z.B. Button kurz grün).
<!-- section:ui -->
## UI-Komponenten & Layout
* Header: App-Titel „Speech-to-Text"
* Hauptbereich: großer Textbereich (Textarea) mit Live-Transkription
* Steuerung: Start/Stop-Button (toggle), ggf. Sprachauswahl (optional)
* Footer: kurzer Hinweis („Sprache wird lokal im Browser verarbeitet“)
* Copy-Button: kopiert den aktuellen Text ins Clipboard.<!-- section:issue-1 -->
## Issue 1: Duplikate in der Live-Transkription beheben

* Aktuelle Umsetzung produziert viele doppelte Wörter/Segmente (siehe Screenshot des Nutzers)
* Soll sich verhalten wie die Transkription auf der personalisierten Nachrichtenseite – dort funktioniert die Segment-Deduplizierung korrekt
* Ursache vermutlich falsche Handhabung von `resultIndex` oder `isFinal` im Speech-Event
* Ziel: Jedes finale Segment erscheint exakt einmal im Textfeld<!-- section:issue-2 -->
## Issue 2: Doppelte Einträge wie im personalisierten Nachrichtendienst vermeiden

* Trotz des Fixes in Issue 1 treten weiterhin doppelte Wörter/Segmente auf
* Die Logik soll genauso funktionieren wie im personalisierten Nachrichtendienst (anderes Projekt) – dort tritt das Problem nicht auf
* Ansatz: möglicherweise die gesamte Event-Verarbeitung durch den bewährten Code aus dem Nachrichtendienst ersetzen oder dessen Deduplizierungs-Strategie übernehmen