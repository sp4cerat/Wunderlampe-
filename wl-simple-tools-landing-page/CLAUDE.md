# Implementierungs-Auftrag (Issue 4)

In diesem Verzeichnis liegt **bereits eine bestehende Webapp** (siehe vorhandene Dateien wie `index.html`, etc.). Diese wurde in vorigen Iterationen aufgebaut.

## Was du bekommst

- `concept.md` — **NUR das aktuelle Issue**, also die Sections die seit dem letzten Build neu hinzugekommen oder geändert wurden. **Das ist dein Auftrag.**
- `full-concept.md` — das vollständige Projekt-Konzept (Initial + alle Issues) **nur als Referenz**, falls du Kontext brauchst. **NICHT komplett neu umsetzen.**
- `history/` — frühere Konzept-Snapshots der vorigen Builds.

### NEU seit dem letzten Build (Fokus dieses Auftrags)
- `<!-- section:issue-4 -->`

Das sind die Sections die sich an das vorhandene Konzept angehängt haben — sie beschreiben das aktuelle Issue. Konzentriere dich auf deren Umsetzung.

## Strikte Vorgaben

- **Bestehende Architektur respektieren**: keine kompletten Rewrites, kein unnötiger Wechsel des Tech-Stacks, keine Datei-Strukturänderungen die nicht zwingend nötig sind.
- **Diff-orientiert arbeiten**: lies erst die existierenden Dateien, finde die richtigen Stellen, ändere/erweitere präzise.
- **`index.html` bleibt der Entrypoint** für die Seite. Tech-Stack-Erweiterungen (z.B. Backend-Skript, Cron-Job, Build-Tools) sind erlaubt, wenn das Issue sie verlangt.
- **Nicht halbfertig abbrechen**: das Issue muss vollständig integriert sein und die App weiter lauffähig.
- **Niemals API-Keys, Tokens oder Secrets in vom Browser geladene Dateien einbauen.** Keine String-Literale wie `const KEY = 'xyz…'` in `app.js`, `index.html` oder anderen client-geladenen Dateien — auch nicht aus `process.env` / `~/.secrets/*` reinrendern. Bei Backend-Komponenten bleibt der Key auf dem Server, Browser ruft einen Proxy-Endpoint auf. Bei pure Client-Side: Key zur Laufzeit vom User per Eingabefeld → `localStorage` abfragen. Falls der bestehende Code bereits einen Key hardcoded hat: das gilt als Bug — entfernen und auf eines der beiden Pattern umstellen.

## Workflow

1. `ls` den aktuellen Verzeichnisinhalt.
2. Lies `index.html` (und ggf. weitere Dateien) um den Status quo zu verstehen.
3. Lies `concept.md` — das ist der konkrete Auftrag (nur das Issue).
4. Bei Bedarf in `full-concept.md` nachsehen für Gesamtkontext.
5. Plane: welche Stellen im Code sind betroffen, welche Files werden geändert.
6. Wende die Änderungen an.
7. Kurze Zusammenfassung am Ende: was wurde geändert, was bleibt für später.