# Issue 2

<!-- section:issue-2 -->
## Issue 2: Doppelte Einträge wie im personalisierten Nachrichtendienst vermeiden

* Trotz des Fixes in Issue 1 treten weiterhin doppelte Wörter/Segmente auf
* Die Logik soll genauso funktionieren wie im personalisierten Nachrichtendienst (anderes Projekt) – dort tritt das Problem nicht auf
* Ansatz: möglicherweise die gesamte Event-Verarbeitung durch den bewährten Code aus dem Nachrichtendienst ersetzen oder dessen Deduplizierungs-Strategie übernehmen