# Issue 19

<!-- section:issue-16 -->
## Issue 16: Timeout-Fix Prognose + Kontrast Scorecard & News

* **Timeout-Fehler bei KI-Prognose (DeepSeek V4)**: Trotz Timeout-Erhöhung auf 150s und Retry-Logik tritt der Fehler weiterhin auf (siehe Notiz 1). Benötigt weitere Robustheit – z.B. längeren Per-Call-Timeout (180s+), Provider-Fallback auf anderen LLM-Endpunkt oder adaptive Timeout-Logik.
* **Kontrast bei Scorecard-Sub-Dimensionen (Qualität, Wachstum, Bewertung etc.) im Bright Mode**: Der Hintergrund dieser Karten ist zu dunkelgrau. Heller machen (hellgrau/weiß), sodass Text klar lesbar ist.
* **Kontrast bei News-Cards im Bright Mode**: Der News-Bereich hat aktuell einen dunkelgrauen Hintergrund, der im Bright Mode zu dunkel ist. Hintergrund heller machen (z.B. hellgrau oder weiß), sodass News-Cards klar lesbar sind.

<!-- section:issue-19 -->
## Issue 19: Scorecard-Verbesserungen und Konsistenz-Fixes

* **Risiko trennen**: Financial Safety (Bilanz, Cashflow, Verschuldung) vs. Investment Risk (Kursbewertung, Zyklus, Erwartungen) — zwei separate Scores statt eines gemischten.
* **Textlogik reparieren**: Entscheidungsmatrix darf „attraktive Bewertung“ nicht anzeigen, wenn Bewertungs-Score 42/100 und Fair-Value-Upside −38,6 % ist. Ersatzformulierung: „hochwertiges Unternehmen, aber aktuell nicht günstig bewertet“ o.ä.
* **Burggraben vereinheitlichen**: Scorecard-Burggraben von 100/100 auf 88–92 senken oder KI-Moat-Wert aus Tiefenanalyse direkt übernehmen. Zusätzliche Moat-Faktoren ergänzen: Wechselkosten, Netzwerkeffekte, IP/Patente, Marktanteil, Kundeneinbindung, Lieferkettenzugang, Replikationsrisiko.
* **Sentiment sauber trennen**: News-Sentiment, Markt-Sentiment, Price Momentum als separate Scores ausweisen, kombinierten Score transparent erklären. Label „positiv“ nur bei >60/100, sonst „gemischt“ oder „vorsichtig positiv“.
* **Datumslogik prüfen**: Vergangene Earnings (z.B. 20. Mai) nicht als nächsten Beobachtungspunkt anzeigen. Stattdessen „Letzte Quartalszahlen: 20. Mai 2026“ und „Nächste: voraussichtlich August 2026".
* **Peer-Matrix Validierung**: Pro Datenpunkt Quelle (yfinance), Datenstand (Datum/Uhrzeit), Validierungsstatus (OK / auffällig / fehlend) anzeigen. Bei auffälligen Werten Warnhinweis: „⚠ Peer-Datenpunkt auffällig: bitte gegen zweite Quelle prüfen".

Alle Prioritäten aus der beigelegten Verbesserungsliste von Sven übernommen.

<!-- section:issue-9 -->
## Issue 9: Mehrdimensionale Bewertungslogik & Verbesserungen

* Mehrdimensionale Aufschlüsselung für **alle Analysebereiche** (nicht nur Risiko): Qualität, Wachstum, Bewertung, Burggraben, Sentiment, Risiko – jeweils mit Unterdimensionen und Einzel-Scores.
* Agentenbasiertes Vorgehen: Ein KI-Agent definiert dynamisch die relevanten Dimensionen und Metriken pro Analyse (z.B. bei Risiko: Bilanz, Bewertung, Geschäftsmodell, Lieferkette, Wettbewerb, Regulierung, Volatilität, Schätzung).
* Score-Erklärung pro Punktzahl: Beitrag jedes Unterfaktors inkl. Schwellenwerten.
* Trennung von Business Quality vs. Stock Attractiveness (mit separaten Scores).
* Bewertungsabschlag stärker gewichten: Wenn Fair-Value-Median >25 % unter Kurs → max. Attraktivitäts-Score 75.
* Peer-Matrix mit Perzentilen (quantitativ).
* Quellenqualität bewerten (SEC hoch, Blog niedrig).
* Fakten vs. Schätzungen kennzeichnen (Typ/Sicherheit).
* Markterwartungs-Modul (Konsens, Revisionen, Guidance-Risiko).
* Backtesting historischer Score-Kombinationen.
* Zeitachsen trennen (1M, 3M, 12M, 5Y) mit getrennten Signalen.
* Entscheidungsmatrix mit klaren Fragen statt Punktzahl.
* Alpha-/Momentum-Modul (Danelfin-artig, 3-Monats-Outperformance).

<!-- section:issue-16 -->
## Issue 16: Timeout-Fix Prognose + Kontrast Scorecast & News

* **Timeout-Fehler bei KI-Prognose (DeepSeek V4)**: Trotz Timeout-Erhöhung auf 150s und Retry-Logik tritt der Fehler weiterhin auf (siehe Notiz 1: "DeepSeek V4 ist gerade unter Last — wir versuchen es nochmal (bis zu 150s pro Versuch)."). Benötigt weitere Robustheit – z.B. längeren Per-Call-Timeout (180s+), Provider-Fallback auf anderen LLM-Endpunkt oder adaptive Timeout-Logik.
* **Kontrast bei Scorecast/Prognose-Snapshot im Bright Mode**: Die Angaben über der KI-Prognose (Kursziel, Konfidenzintervall, Bull/Base/Bear, KI-Fairness) sind im Bright Mode schwer lesbar. Textfarbe und/oder Hintergrundfarbe dieser Karten anpassen, sodass sie kontrastreich und gut lesbar sind – gleiche Behandlung wie in Issue 15 (Bright-Mode-Kontrast), aber spezifisch für den Prognose-Snapshot/Scorecast-Bereich.
* **Kontrast bei News-Cards im Bright Mode**: Der News-Bereich hat aktuell einen dunkelgrauen Hintergrund, der im Bright Mode zu dunkel ist. Hintergrund heller machen (z.B. hellgrau oder weiß), sodass News-Cards klar lesbar sind.
* **Kontrast bei aktuellen Karten/Scorecast im Bright Mode**: Auch die „aktuellen“ Karten (vermutlich Scorecast und Prognose-Snapshot) haben einen zu dunklen Hintergrund. Gemeinsam mit den News-Cards anpassen.

<!-- section:issue-15 -->
## Issue 15: Bright-Mode-Kontrast + Timeout in KI-Prognose

* **Kontrast im Bright Mode verbessern:** Hintergrund heller oder Text dunkler machen, sodass alle Elemente (Cards, Tabellen, Scorecard, Prognose, Fear & Greed) gut lesbar sind.
* **Timeout bei DeepSeek V4 in der Prognose:** Der LLM-Call für die Kursprognose läuft manchmal in einen Timeout (504/Timeout-Fehler). Ursache vermutlich Serverlast bei aimlapi. Timeout erhöhen, Retry-Logik einbauen und Fehlermeldung klar anzeigen.

<!-- section:issue-16 -->
## Issue 16: Timeout-Fix Prognose + Kontrast Scorecard & News

* **Timeout-Fehler bei KI-Prognose (DeepSeek V4)**: Trotz Timeout-Erhöhung auf 150s und Retry-Logik tritt der Fehler weiterhin auf (siehe Notiz 1: "DeepSeek V4 ist gerade unter Last — wir versuchen es nochmal (bis zu 150s pro Versuch)."). Benötigt weitere Robustheit – z.B. längeren Per-Call-Timeout (180s+), Provider-Fallback auf anderen LLM-Endpunkt oder adaptive Timeout-Logik.
* **Kontrast bei Scorecard-Sub-Dimensionen (Qualität, Wachstum, Bewertung etc.) im Bright Mode**: Der Hintergrund dieser Karten ist zu dunkelgrau. Heller machen (hellgrau/weiß), sodass Text klar lesbar ist.
* **Kontrast bei News-Cards im Bright Mode**: Der News-Bereich hat aktuell einen dunkelgrauen Hintergrund, der im Bright Mode zu dunkel ist. Hintergrund heller machen (z.B. hellgrau oder weiß), sodass News-Cards klar lesbar sind.

<!-- section:issue-16 -->
## Issue 16: Timeout-Fix Prognose + Kontrast Scorecast & News

* **Timeout-Fehler bei KI-Prognose (DeepSeek V4)**: Trotz Timeout-Erhöhung auf 150s und Retry-Logik tritt der Fehler weiterhin auf (siehe Notiz 1: "DeepSeek V4 ist gerade unter Last — wir versuchen es nochmal (bis zu 150s pro Versuch)."). Benötigt weitere Robustheit – z.B. längeren Per-Call-Timeout (180s+), Provider-Fallback auf anderen LLM-Endpunkt oder adaptive Timeout-Logik.
* **Kontrast bei Scorecast/Prognose-Snapshot im Bright Mode**: Die Angaben über der KI-Prognose (Kursziel, Konfidenzintervall, Bull/Base/Bear, KI-Fairness) sind im Bright Mode schwer lesbar. Textfarbe und/oder Hintergrundfarbe dieser Karten anpassen, sodass sie kontrastreich und gut lesbar sind – gleiche Behandlung wie in Issue 15 (Bright-Mode-Kontrast), aber spezifisch für den Prognose-Snapshot/Scorecast-Bereich.
* **Kontrast bei News-Cards im Bright Mode**: Der News-Bereich hat aktuell einen dunkelgrauen Hintergrund, der im Bright Mode zu dunkel ist. Hintergrund heller machen (z.B. hellgrau oder weiß), sodass News-Cards klar lesbar sind.
* **Kontrast bei aktuellen Karten/Scorecast im Bright Mode**: Auch die „aktuellen“ Karten (vermutlich Scorecast und Prognose-Snapshot) haben einen zu dunklen Hintergrund. Gemeinsam mit den News-Cards anpassen.

<!-- section:issue-14 -->
## Issue 14: Bright Mode als Standard + Dark Mode umschaltbar

* Die Webseite startet standardmäßig im Bright Mode (helle Farbgebung).
* Ein Schalter/Button im Header oder an gut sichtbarer Stelle erlaubt das Umschalten zwischen Bright Mode und Dark Mode.
* Der gewählte Modus wird im `localStorage` gespeichert, damit die Einstellung beim nächsten Besuch erhalten bleibt.
* Alle bestehenden UI-Komponenten (Charts, Tabellen, Scorecards, Prognose, Fear & Greed, etc.) müssen in beiden Modi korrekt und lesbar dargestellt werden.
* Bestehende Dark-Mode-Stile (falls vorhanden) werden als Basis für den Dark Mode genutzt, ggf. ergänzt/überarbeitet.
* **Bright Mode als Standard** – Webseite startet hell, Umschalter im Header, Auswahl bleibt in localStorage erhalten.
* **504-Fehler bei Prognose** (Notiz 1): Fehler „Prognose fehlgeschlagen: HTTP 504“ beheben. Ursache vermutlich Timeout im LLM-Call oder Backend-Hängler – Robustheit verbessern (Timeout erhöhen, Retry einbauen, Fehlermeldung anzeigen).
* **Layout-Hierarchie anpassen**: Prognose-Bereich (Kursziel, 1-Jahres-Wertschätzung) und KI-Bewertung der Fairness weiter nach oben verschieben – z.B. direkt unter die Scorecard oder in die Übersicht, damit diese Werte ohne Scrollen sichtbar sind.


<!-- section:issue-15 -->
## Issue 15: Bright-Mode-Kontrast + Prognose-Fehler

* **Kontrast im Bright Mode verbessern**: Hintergrund heller machen oder Text dunkler, sodass alle Elemente (Cards, Tabellen, Charts, Scorecard, Prognose, Fear & Greed, etc.) gut lesbar sind.
* **Fehler in der KI-Prognose**: (Details fehlen noch – User wird nach Beschreibung gefragt)

<!-- section:issue-14 -->
## Issue 14: Bright Mode als Standard + Dark Mode umschaltbar

* Die Webseite startet standardmäßig im Bright Mode (helle Farbgebung).
* Ein Schalter/Button im Header oder an gut sichtbarer Stelle erlaubt das Umschalten zwischen Bright Mode und Dark Mode.
* Der gewählte Modus wird im `localStorage` gespeichert, damit die Einstellung beim nächsten Besuch erhalten bleibt.
* Alle bestehenden UI-Komponenten (Charts, Tabellen, Scorecards, Prognose, Fear & Greed, etc.) müssen in beiden Modi korrekt und lesbar dargestellt werden.
* Bestehende Dark-Mode-Stile (falls vorhanden) werden als Basis für den Dark Mode genutzt, ggf. ergänzt/überarbeitet.

<!-- section:issue-11 -->
## Issue 11: KI-gestützte Prognose zukünftiger Kennzahlen

* KI soll für die kommenden Jahre (z.B. +3 Jahre) Umsätze, Gewinne/Verluste, CAPEX und weitere relevante Kennzahlen abschätzen.
* Grundlage: Historische Daten, SEC-Filings (Forward-Guidance), Analystenschätzungen (Konsens), News, Web-Recherche.
* Die Prognosen fließen in die Bewertung ein: z.B. adjustierte Scorecard, Fair-Value-Schätzung, Szenarioanalyse.
* Offene Frage: Soll die KI auch Wahrscheinlichkeiten oder Konfidenzintervalle angeben?
* Die KI soll bei der Prognose folgende Faktoren einbeziehen: Marktentwicklung (TAM-Wachstum, Branchentrends), Marktanteilsentwicklung (historisch und erwartet), Konkurrenzstärke (Wettbewerbsintensität, Markteintrittsbarrieren, Substitutionsrisiko).
* **Ein-Jahres-Kursprognose**: KI schätzt einen konkreten Aktienkurs in 12 Monaten, basierend auf den prognostizierten Kennzahlen, Marktentwicklung, Konkurrenzanalyse und vorhandenen Analystenzielen. Ausgabe als erwarteter Kurs plus Konfidenzintervall oder als Bull/Base/Bear-Szenario.

<!-- section:issue-11 -->
## Issue 11: KI-gestützte Prognose zukünftiger Kennzahlen

* KI soll für die kommenden Jahre (z.B. +3 Jahre) Umsätze, Gewinne/Verluste, CAPEX und weitere relevante Kennzahlen abschätzen.
* Grundlage: Historische Daten, SEC-Filings (Forward-Guidance), Analystenschätzungen (Konsens), News, Web-Recherche.
* Die Prognosen fließen in die Bewertung ein: z.B. adjustierte Scorecard, Fair-Value-Schätzung, Szenarioanalyse.
* Offene Frage: Soll die KI auch Wahrscheinlichkeiten oder Konfidenzintervalle angeben?
* Die KI soll bei der Prognose folgende Faktoren einbeziehen: Marktentwicklung (TAM-Wachstum, Branchentrends), Marktanteilsentwicklung (historisch und erwartet), Konkurrenzstärke (Wettbewerbsintensität, Markteintrittsbarrieren, Substitutionsrisiko).
* **Ein-Jahres-Kursprognose**: KI schätzt einen konkreten Aktienkurs in 12 Monaten, basierend auf den prognostizierten Kennzahlen, Marktentwicklung, Konkurrenzanalyse und vorhandenen Analystenzielen. Ausgabe als erwarteter Kurs plus Konfidenzintervall oder als Bull/Base/Bear-Szenario.


<!-- section:issue-9 -->
## Issue 9: Verbesserungsvorschläge aus der Analyse

1. **Risiko-Score mehrdimensional**: Aufschlüsselung in Bilanz-, Bewertungs-, Geschäftsmodell-, Lieferketten-, Wettbewerbs-, Regulierungs-, Volatilitäts- und Schätzungsrisiko. Zwei getrennte Scores: Bilanzsicherheit und Investmentrisiko.
2. **Score-Handlungsempfehlung koppeln**: Zweistufig: Unternehmensqualität vs. Aktienattraktivität. Bei Fair-Value-Median >25% unter Kurs: max. Attraktivitäts-Score 75.
3. **Bewertungsabschlag stärker gewichten**: Negativer Fair-Value-Befund schlägt auf Gesamtscore durch. Quality Score kann 90+ sein, Investment Score nicht.
4. **Alpha-/Momentum-Modul (wie Danelfin)**: Kurzfristiges Signal mit Momentum, relative Stärke, Earnings-Revisions, News-Sentiment, Volatilität, Volumenanomalien.
5. **Peer-Matrix quantitativ**: Harte Kennzahlen-Tabelle mit Perzentilen (Umsatzwachstum, Margen, Multiples).
6. **Score-Erklärung pro Punktzahl**: Aufschlüsselung der Beiträge (+/-) mit Schwellenwerten.
7. **Quellenqualität bewerten**: Klassifikation (SEC hoch, Blog niedrig) und separater Qualitäts-Score.
8. **Fakten vs. Schätzungen trennen**: Jede Aussage mit Typ (Fakt/Berechnung/Schätzung/Modellannahme) und Sicherheitsgrad.
9. **Markterwartungen erfassen**: Modul mit Umsatz-/EPS-Konsens, Revisionen, impliziter Erwartung, Guidance-Risiko, Earnings Surprise.
10. **Backtesting**: Historische Performance ähnlicher Score-Kombinationen (Rendite, Win Rate, Drawdown).
11. **Zeitachsen trennen**: 1 Monat (News/Momentum), 3 Monate (Earnings/Sentiment), 12 Monate (Bewertung), 3–5 Jahre (Burggraben/TAM) – getrennte Signale.
12. **Entscheidungsmatrix**: Abschließende klare Fragen („Ist das Unternehmen hochwertig?“, „Ist die Aktie günstig?“, etc.) statt Punktzahl.
13. **Agentenbasierte Logik**: Ein Agent definiert dynamisch die relevanten Risikodimensionen und Bewertungsmetriken pro Analyse, statt festen Kategorien.