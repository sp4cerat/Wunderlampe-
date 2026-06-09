/**
 * Aktienanalyse-Tool — Frontend
 *
 * Vanilla JS, kein Bundler. Spricht ausschließlich das eigene Backend (./api/*) an —
 * keine Keys oder Secrets im Browser.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // API base — funktioniert sowohl via nginx-Subpfad
  // (/wunderlampe/projects/<id>/api/) als auch via lokalem Express (./api/).
  // Wir nehmen einfach relative URLs vom Dokument-Pfad aus.
  // ---------------------------------------------------------------------
  const API = (() => {
    let base = window.location.pathname;
    if (!base.endsWith('/')) base = base.replace(/[^/]*$/, '');
    return base + 'api';
  })();

  // ---------------------------------------------------------------------
  // Helfer
  // ---------------------------------------------------------------------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    }
    return n;
  };

  const fmt = {
    num(v, d = 2) {
      if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
      return Number(v).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });
    },
    pct(v, d = 1) {
      if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
      return (v * 100).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d }) + '%';
    },
    money(v, curr = 'USD') {
      if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
      const abs = Math.abs(v);
      let scaled, suf;
      if (abs >= 1e12) { scaled = v / 1e12; suf = 'T'; }
      else if (abs >= 1e9) { scaled = v / 1e9; suf = 'Mrd'; }
      else if (abs >= 1e6) { scaled = v / 1e6; suf = 'Mio'; }
      else if (abs >= 1e3) { scaled = v / 1e3; suf = 'K'; }
      else { scaled = v; suf = ''; }
      const sym = curr === 'USD' ? '$' : (curr === 'EUR' ? '€' : curr + ' ');
      return sym + scaled.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + (suf ? ' ' + suf : '');
    },
    date(s) {
      if (!s) return '—';
      const d = new Date(s);
      if (isNaN(d)) return s;
      return d.toLocaleDateString('de-DE', { year: 'numeric', month: 'short', day: '2-digit' });
    },
  };

  const toast = (msg, type = '') => {
    const t = el('div', { class: 'toast ' + type }, msg);
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 200ms'; }, 4200);
    setTimeout(() => t.remove(), 4600);
  };

  async function api(path, opts = {}) {
    const r = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
    if (!r.ok) {
      const err = new Error(data?.error || ('HTTP ' + r.status));
      err.status = r.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // Issue 17: harter Client-Timeout für SEC-Aufrufe. Wenn der tools-server
  // beim Abruf von Filings/XBRL hängt, würde der Pipeline-Lock auf
  // sec_data_ready niemals fallen — wir geben dem Promise eine feste
  // Obergrenze und behandeln den Timeout-Reject wie eine leere Antwort.
  function withTimeout(promise, ms, label) {
    let to;
    const timer = new Promise((_, reject) => {
      to = setTimeout(() => {
        const e = new Error(`Timeout nach ${ms}ms (${label || 'request'})`);
        e.code = 'TIMEOUT';
        e.timeout = true;
        reject(e);
      }, ms);
    });
    return Promise.race([
      promise.then(v => { clearTimeout(to); return v; },
                   e => { clearTimeout(to); throw e; }),
      timer,
    ]);
  }

  // ---------------------------------------------------------------------
  // Issue 14: Theme-Switching (Bright / Dark Mode).
  // Default ist "light". Wahl wird in localStorage gehalten, das Attribut
  // data-theme ist bereits durch das Pre-Paint-Script in index.html gesetzt
  // (kein FOUC). Hier:
  //  - Toggle-Button mit Icon & Label aktualisieren
  //  - bei Klick umschalten, persistieren, Chart neu zeichnen
  // ---------------------------------------------------------------------
  const THEME_KEY = 'alphaScope.theme.v1';

  function getTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch {}
    const icon = document.getElementById('theme-toggle-icon');
    const label = document.getElementById('theme-toggle-label');
    if (icon) icon.textContent = t === 'dark' ? '🌙' : '☀️';
    if (label) label.textContent = t === 'dark' ? 'Dunkel' : 'Hell';
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.title = t === 'dark'
      ? 'Aktuell: Dunkel — auf Hell umschalten'
      : 'Aktuell: Hell — auf Dunkel umschalten';
    // Chart neu zeichnen (Tick-Farben hängen am Theme, indirekt — wir
    // re-rendern komplett, falls eine Analyse aktiv ist).
    // Hinweis: currentState wird weiter unten per `let` deklariert; bei der
    // Init-Aufruf-Reihenfolge greift der TDZ. Daher try/catch um die ganze
    // Referenz, nicht nur drawPriceChart.
    try {
      if (currentState && currentState.quote?.history) {
        drawPriceChart(currentState.quote.history, currentState.quote?.info?.currency);
      }
    } catch {}
  }

  (function initTheme() {
    // Theme wurde bereits im Pre-Paint-Script gesetzt. Hier nur Icon/Label syncen
    // und Click-Handler verdrahten.
    applyTheme(getTheme());
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
      });
    }
  })();

  // ---------------------------------------------------------------------
  // Suche & Autocomplete (für jedes Such-Input + Dropdown wiederverwendbar)
  // ---------------------------------------------------------------------
  const searchEl = $('#search');             // kompakt im Header
  const heroSearchEl = $('#hero-search');    // groß auf der Landing-Page

  function makeSearchController(inputEl, dropEl) {
    let items = [];
    let idx = -1;
    let timer = null;
    let lastQ = '';

    const hide = () => { dropEl.classList.add('hidden'); idx = -1; };
    const show = () => dropEl.classList.remove('hidden');
    const paintFocus = () => {
      dropEl.querySelectorAll('.sug').forEach((n, i) => n.classList.toggle('focused', i === idx));
    };

    const run = async (q) => {
      if (q === lastQ) return;
      lastQ = q;
      try {
        const { results = [] } = await api('/search?q=' + encodeURIComponent(q));
        items = results.slice(0, 8);
        idx = -1;
        dropEl.innerHTML = '';
        if (!items.length) {
          dropEl.appendChild(el('div', { class: 'sug', style: 'color:#5a6378;cursor:default' }, 'Keine Treffer'));
          show();
          return;
        }
        items.forEach(s => {
          const row = el('div', { class: 'sug' },
            el('span', { class: 'sym' }, s.symbol),
            el('span', { class: 'nm' }, s.name),
            el('span', { class: 'ex' }, s.exchange + (s.type ? ' · ' + s.type : ''))
          );
          row.addEventListener('mousedown', evt => {
            evt.preventDefault();
            inputEl.value = s.symbol;
            hide();
            loadTicker(s.symbol, s);
          });
          dropEl.appendChild(row);
        });
        show();
      } catch (e) {
        console.warn('search failed', e);
      }
    };

    inputEl.addEventListener('input', () => {
      clearTimeout(timer);
      const q = inputEl.value.trim();
      if (q.length < 1) { hide(); return; }
      timer = setTimeout(() => run(q), 180);
    });

    inputEl.addEventListener('keydown', e => {
      if (dropEl.classList.contains('hidden')) {
        if (e.key === 'Enter') {
          const q = inputEl.value.trim();
          if (q) loadTicker(q.toUpperCase());
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(items.length - 1, idx + 1);
        paintFocus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(0, idx - 1);
        paintFocus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = items[idx >= 0 ? idx : 0];
        if (pick) {
          inputEl.value = pick.symbol;
          hide();
          loadTicker(pick.symbol, pick);
        } else {
          const q = inputEl.value.trim();
          if (q) loadTicker(q.toUpperCase());
        }
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    document.addEventListener('click', e => {
      if (!inputEl.contains(e.target) && !dropEl.contains(e.target)) hide();
    });
  }

  makeSearchController(searchEl, $('#suggestions'));
  makeSearchController(heroSearchEl, $('#hero-suggestions'));

  // Header-Suche nur einblenden, sobald eine Analyse offen ist — auf der
  // Landing-Page ist das Hero-Feld die einzige prominente Suchfläche.
  function toggleHeaderSearch(visible) {
    const wrap = $('#header-search-wrap');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !visible);
  }
  toggleHeaderSearch(false);

  // ---------------------------------------------------------------------
  // Beispiel-Buttons (Landing-Page)
  // ---------------------------------------------------------------------
  $$('.example-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const sym = btn.dataset.symbol;
      const nm = btn.dataset.name;
      searchEl.value = sym;
      loadTicker(sym, { symbol: sym, name: nm });
    });
  });

  // ---------------------------------------------------------------------
  // Watchlist (localStorage)
  // ---------------------------------------------------------------------
  const WL_KEY = 'alphaScope.watchlist.v1';
  const getWatchlist = () => {
    try { return JSON.parse(localStorage.getItem(WL_KEY) || '[]'); } catch { return []; }
  };
  const setWatchlist = list => { localStorage.setItem(WL_KEY, JSON.stringify(list)); paintWatchlistCount(); };
  const inWatchlist = sym => getWatchlist().some(x => x.symbol === sym);
  const addWatch = ({ symbol, name }) => {
    const wl = getWatchlist();
    if (wl.some(x => x.symbol === symbol)) return;
    wl.push({ symbol, name, added: new Date().toISOString() });
    setWatchlist(wl);
    toast(`${symbol} zur Watchlist hinzugefügt`, 'ok');
  };
  const removeWatch = symbol => {
    setWatchlist(getWatchlist().filter(x => x.symbol !== symbol));
    toast(`${symbol} entfernt`);
  };
  const paintWatchlistCount = () => {
    $('#watchlist-count').textContent = '(' + getWatchlist().length + ')';
  };
  paintWatchlistCount();

  $('#open-watchlist').addEventListener('click', e => {
    e.preventDefault();
    renderWatchlist();
  });

  function renderWatchlist() {
    $('#landing').classList.add('hidden');
    $('#analysis').classList.add('hidden');
    const panel = $('#watchlist-panel');
    panel.classList.remove('hidden');
    const wl = getWatchlist();
    panel.innerHTML = '';
    panel.appendChild(el('h2', { class: 'text-xl font-semibold mb-3' }, 'Watchlist'));
    if (!wl.length) {
      panel.appendChild(el('p', { class: 'text-ink-300' }, 'Noch keine Werte gespeichert. Öffne eine Analyse und klicke auf „★ Zur Watchlist".'));
      return;
    }
    const tbl = el('table', { class: 'data w-full' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Symbol'),
          el('th', {}, 'Name'),
          el('th', {}, 'Hinzugefügt'),
          el('th', {}, '')
        )
      ),
      el('tbody', {}, ...wl.map(item =>
        el('tr', {},
          el('td', {}, el('a', { href: '#', class: 'text-accent font-mono', onclick: e => { e.preventDefault(); searchEl.value = item.symbol; loadTicker(item.symbol, item); } }, item.symbol)),
          el('td', {}, item.name),
          el('td', {}, fmt.date(item.added)),
          el('td', {}, el('button', { class: 'text-xs text-ink-300 hover:text-accent-bad', onclick: () => { removeWatch(item.symbol); renderWatchlist(); } }, 'Entfernen'))
        )
      ))
    );
    panel.appendChild(tbl);
  }

  $('#clear-cache').addEventListener('click', e => {
    e.preventDefault();
    sessionStorage.clear();
    toast('Frontend-Cache geleert', 'ok');
  });

  // ---------------------------------------------------------------------
  // Section-Navigation (Issue 13: vertikales Layout, keine Tabs mehr)
  // switchTab(id) scrollt jetzt zur entsprechenden Section. Funktionssignatur
  // bleibt erhalten, damit existierende Aufrufer (jump-tabs, tab-jump-Links)
  // unverändert weiterarbeiten.
  // ---------------------------------------------------------------------
  function switchTab(id) {
    const sec = document.getElementById('sec-' + id);
    if (!sec) return;
    $$('#section-toc .toc-link').forEach(x => x.classList.remove('active'));
    const link = document.querySelector(`#section-toc .toc-link[data-tab="${id}"]`);
    if (link) link.classList.add('active');
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $$('#section-toc .toc-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      switchTab(a.dataset.tab);
    });
  });
  // Issue 9: Tab-Jump-Links (z.B. "→ Entscheidungsmatrix" aus der Übersicht)
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-jump-tab]');
    if (a) {
      e.preventDefault();
      switchTab(a.dataset.jumpTab);
    }
  });

  // Scroll-Spy: TOC-Link der aktuellen Section markieren
  let _tocScrollPending = false;
  function updateTocActive() {
    const links = $$('#section-toc .toc-link');
    if (!links.length) return;
    const headerBuffer = 160;
    let activeId = null;
    for (const link of links) {
      const id = link.dataset.tab;
      const sec = document.getElementById('sec-' + id);
      if (!sec) continue;
      const rect = sec.getBoundingClientRect();
      if (rect.top <= headerBuffer) activeId = id;
    }
    if (!activeId) activeId = links[0].dataset.tab;
    links.forEach(l => l.classList.toggle('active', l.dataset.tab === activeId));
  }
  window.addEventListener('scroll', () => {
    if (_tocScrollPending) return;
    _tocScrollPending = true;
    requestAnimationFrame(() => { _tocScrollPending = false; updateTocActive(); });
  }, { passive: true });

  // ---------------------------------------------------------------------
  // Analyse-Pipeline (Frontend)
  // ---------------------------------------------------------------------
  let priceChart = null;
  let currentState = null;

  async function loadTicker(ticker, meta = null) {
    ticker = (ticker || '').toUpperCase().trim();
    if (!ticker) return;

    $('#landing').classList.add('hidden');
    $('#watchlist-panel').classList.add('hidden');
    $('#analysis').classList.remove('hidden');
    toggleHeaderSearch(true);
    // Header-Suche mit dem aktiven Ticker vorbefüllen (so wechselt der User
    // einfach durch Überschreiben)
    if (searchEl && searchEl.value !== ticker) searchEl.value = ticker;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // History (Back-Button)
    if (history.replaceState) {
      const newUrl = new URL(window.location.href);
      newUrl.hash = ticker;
      history.replaceState({}, '', newUrl);
    }

    currentState = { ticker, meta, quote: null, fundamentals: null, news: null, filings: null, score: null, analysis: null, fairValue: null, webOverview: null, news6m: null, industry: null, conclusion: null, deep: null, yfExtra: null, technical: null, fearGreed: null, secStatus: null };

    paintHeaderSkeleton(ticker, meta);
    paintOverviewSkeleton();
    paintTabSkeletons();

    // 1. Schnelle Daten parallel: Kursdaten (5y) + Filings + News.
    //    Issue 17: SEC-Filings bekommen einen harten 90s-Timeout, damit der
    //    Pipeline-Lock auf sec_data_ready nicht durch einen hängenden
    //    tools-server-Aufruf blockiert wird.
    const SEC_TIMEOUT_MS = 90 * 1000;
    let filingsTimedOut = false;
    let fundamentalsTimedOut = false;
    try {
      const [quote, filingsR, newsR] = await Promise.allSettled([
        api('/quote?ticker=' + encodeURIComponent(ticker) + '&range=5y&interval=1wk'),
        withTimeout(api('/filings?ticker=' + encodeURIComponent(ticker)), SEC_TIMEOUT_MS, 'SEC filings'),
        api('/news?ticker=' + encodeURIComponent(ticker) + '&name=' + encodeURIComponent(meta?.name || '')),
      ]);
      currentState.quote = quote.status === 'fulfilled' ? quote.value : null;
      currentState.filings = filingsR.status === 'fulfilled' ? (filingsR.value.filings || []) : [];
      filingsTimedOut = filingsR.status === 'rejected' && (filingsR.reason?.timeout || filingsR.reason?.code === 'TIMEOUT');
      currentState.news = newsR.status === 'fulfilled' ? (newsR.value.results || []) : [];

      paintHeader(currentState);
      paintNews(currentState);
      paintFilings(currentState);
      paintOverviewPartial(currentState);

      // 1b. Web-Fallback, wenn yfinance offensichtlich keine Daten liefert
      //     (Ticker existiert dort nicht oder ist ein OTC/exotisches Listing)
      const noYahooData =
        !currentState.quote ||
        !currentState.quote.info ||
        (!safeNum(currentState.quote.info.price) && !safeNum(currentState.quote.info.market_cap));
      if (noYahooData) {
        try {
          const w = await api('/web-overview?ticker=' + encodeURIComponent(ticker) +
            '&name=' + encodeURIComponent(meta?.name || ''));
          currentState.webOverview = w;
          // Wenn LLM-Extraktion belastbare Werte fand, übernehmen wir sie
          // als Pseudo-Quote-Info, damit Header & Scorecard etwas zeigen.
          if (w?.extracted) {
            currentState.quote = currentState.quote || { info: {}, history: [] };
            const inf = currentState.quote.info || {};
            const ex = w.extracted;
            currentState.quote.info = {
              ...inf,
              longName: inf.longName || ex.longName || meta?.name || ticker,
              exchange: inf.exchange || ex.exchange || null,
              currency: inf.currency || ex.currency || null,
              price: inf.price || safeNum(ex.price),
              market_cap: inf.market_cap || safeNum(ex.market_cap),
              sector: inf.sector || ex.sector || null,
              industry: inf.industry || ex.industry || null,
              _from_web: true,
            };
          }
          paintHeader(currentState);
        } catch (e) {
          console.warn('web-overview failed', e);
        }
      }

      // 2. Fundamentaldaten (SEC XBRL) + yfinance-Extra (forward EPS/PE) parallel.
      //    Issue 17: XBRL-Fundamentaldaten ebenfalls mit 90s-Timeout absichern.
      const [fundR, yfxR] = await Promise.allSettled([
        withTimeout(api('/fundamentals?ticker=' + encodeURIComponent(ticker)), SEC_TIMEOUT_MS, 'SEC fundamentals'),
        api('/yfinance-extra?ticker=' + encodeURIComponent(ticker)),
      ]);
      currentState.fundamentals = fundR.status === 'fulfilled' ? fundR.value : { fundamentals: {}, derived: {} };
      fundamentalsTimedOut = fundR.status === 'rejected' && (fundR.reason?.timeout || fundR.reason?.code === 'TIMEOUT');
      currentState.yfExtra = yfxR.status === 'fulfilled' ? (yfxR.value.extra || null) : null;

      // Issue 17: sec_data_ready setzen. Ab hier dürfen Scorecard und
      // KI-Prognose mit den (vollen oder partiellen) SEC-Daten rechnen.
      // Bei Timeout/leerer Antwort markieren wir die Pipeline als partial
      // bzw. missing — UI- und LLM-Caveats greifen dann.
      currentState.secStatus = computeSecStatus(currentState, { filingsTimedOut, fundamentalsTimedOut });
      paintSecStatusBanner(currentState);

      paintFundamentals(currentState);

      // 3. Fair Value berechnen (rein server-seitig aus Marktkap. + Fundamentals)
      try {
        currentState.fairValue = await api('/fair-value', {
          method: 'POST',
          body: JSON.stringify({
            info: currentState.quote?.info || {},
            fundamentals: currentState.fundamentals,
          }),
        });
      } catch (e) {
        console.warn('fair-value failed', e);
      }
      paintValuation(currentState);

      // 4. KI-Analyse-Passes parallel starten. Die Scorecard wartet bewusst
      //    bis die ausführliche KI-Analyse (Geschäftsmodell, Burggraben, Risiken,
      //    Quellen) vollständig vorliegt — sonst würde der User eine
      //    Zwischen-Scorecard sehen, die später noch von der KI ergänzt wird
      //    (Issue 10).
      const pAnalysis = runLLMAnalysis(currentState).catch(e => { console.warn('LLM analysis failed', e); });
      const pDeep = runDeepAnalysis(currentState).catch(e => { console.warn('Deep analysis failed', e); });
      const pNews6m = runNews6m(currentState).catch(e => { console.warn('News6m failed', e); });
      const pIndustry = runIndustry(currentState).catch(e => { console.warn('Industry failed', e); });

      // Markterwartungs-Modul (Issue 9): Analyst-Konsens, Earnings-Surprise, Guidance.
      // Im Hintergrund — kein Block auf die Hauptpipeline.
      api('/expectations?ticker=' + encodeURIComponent(ticker)).then(r => {
        currentState.expectations = r.expectations || null;
        paintExpectations(currentState);
      }).catch(e => console.warn('expectations failed', e));

      // Issue 13: Technische Indikatoren (Tagesdaten) + Fear & Greed parallel laden.
      // Auf Abschluss warten, weil beide in die Scorecard (Sentiment-Subscore) einfließen.
      const pTechnical = api('/technical?ticker=' + encodeURIComponent(ticker)).then(r => {
        currentState.technical = r || null;
        paintTechnical(currentState);
      }).catch(e => { console.warn('technical failed', e); currentState.technical = null; });
      const pFearGreed = api('/fear-greed').then(r => {
        currentState.fearGreed = r || null;
        paintTechnical(currentState);
      }).catch(e => { console.warn('fear-greed failed', e); currentState.fearGreed = null; });

      // 5. Auf vollständige KI-Analyse warten, bevor die Scorecard berechnet
      //    wird (Issue 10). allSettled, damit ein einzelner Fehler die
      //    Scorecard nicht blockiert — Teil-Daten sind besser als gar keine
      //    Scorecard.
      await Promise.allSettled([pAnalysis, pDeep, pNews6m, pIndustry, pTechnical, pFearGreed]);

      // Übergang vom „Wartet auf KI-Analyse" zum „Berechne Scorecard" Skeleton.
      paintScorecardComputing();

      // 6. Scorecard berechnen — yfExtra für Forward-KGV, history für Momentum/Volatilität,
      //    fairValue für Bewertungs-Score & 25%-Attraktivitäts-Cap (Issue 9),
      //    fearGreed/technical für Sentiment-Subscore (Issue 13).
      try {
        // Issue 18: Mehr Kontext mitschicken, damit der Server bei fehlenden
        // SEC-Daten die fehlenden Dimensionen (Qualität, Wachstum, Burggraben
        // etc.) per LLM aus News, Analystenschätzungen, Branche und
        // Tiefenanalyse plausibel schätzen kann.
        currentState.score = await api('/score', {
          method: 'POST',
          body: JSON.stringify({
            ticker: currentState.ticker,
            fundamentals: currentState.fundamentals,
            info: currentState.quote?.info || {},
            news: currentState.news,
            yfExtra: currentState.yfExtra,
            history: currentState.quote?.history || [],
            fairValue: currentState.fairValue || null,
            fearGreed: currentState.fearGreed || null,
            technical: currentState.technical || null,
            expectations: currentState.expectations || null,
            industry: currentState.industry || null,
            deep: currentState.deep || null,
            webOverview: currentState.webOverview || null,
            sec_status: currentState.secStatus || null,
          }),
        });
      } catch (e) {
        console.warn('score failed', e);
      }
      paintScorecard(currentState);
      paintOverviewFinal(currentState);
      paintRisks(currentState);
      paintValuation(currentState); // Bewertungs-Tab refreshen — zeigt jetzt Sub-Scores
      paintDecisionMatrix(currentState); // Issue 9: Entscheidungsmatrix
      paintMomentum(currentState); // Issue 9: Alpha-/Momentum-Modul

      // 7. Conclusion erst nach Scorecard — sie braucht die finale Bewertung
      //    als Kontext (Score-Schwellen, Cap-Hinweise, Sub-Dimensionen).
      runConclusion(currentState).catch(e => console.warn('Conclusion failed', e));

      // 8. Issue 11: KI-Prognose (3J + 12M-Kursziel) parallel — braucht
      //    historische Fundamentaldaten, Forward-EPS, Analysten-Konsens,
      //    Branchen-Ausblick und Tiefenanalyse (Wettbewerb).
      runForecast(currentState).catch(e => console.warn('Forecast failed', e));

    } catch (e) {
      toast('Fehler: ' + e.message, 'err');
      console.error(e);
    }
  }

  const safeNum = v => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // -------------------------------------------------------------------------
  // Issue 17: SEC-Daten-Readiness
  //
  // Scorecard und KI-Prognose sollen erst rechnen, wenn die SEC-Datensammlung
  // abgeschlossen ist (vollständig oder per Timeout). Beide Verbraucher
  // werden in `loadTicker()` ohnehin sequentiell nach den SEC-Calls
  // gestartet — der `secStatus` ist also ein expliziter Status für UI- und
  // LLM-Caveats, kein zusätzliches Gate.
  //
  // status: 'complete'  → 10-K-Reihe + Filings vorhanden
  //         'partial'   → genau eines fehlt (z.B. Filings da, XBRL leer)
  //         'missing'   → beides leer (vermutlich kein US-Listing oder Provider-Ausfall)
  //         'timeout'   → wir haben den Client-Timeout gezogen, evtl. partielle Daten
  // -------------------------------------------------------------------------
  function computeSecStatus(state, { filingsTimedOut = false, fundamentalsTimedOut = false } = {}) {
    const filings = state.filings || [];
    const filingsCount = filings.length;
    const fyRevenue = state.fundamentals?.fundamentals?.revenue?.fy || [];
    const fyCount = fyRevenue.length;
    const note = state.fundamentals?.note || null; // z.B. 'no-sec-data' (404)
    const filingsOk = filingsCount > 0;
    const fundamentalsOk = fyCount > 0;
    const timedOut = filingsTimedOut || fundamentalsTimedOut;

    let status, message;
    if (filingsOk && fundamentalsOk) {
      status = 'complete';
      message = null;
    } else if (!filingsOk && !fundamentalsOk) {
      status = timedOut ? 'timeout' : 'missing';
      message = timedOut
        ? 'SEC-Datenabruf wurde nach Timeout abgebrochen. Scorecard und KI-Prognose laufen mit Schätzungen — ohne fundamentale 10-K/10-Q-Werte.'
        : (note === 'no-sec-data'
          ? 'Keine SEC-Daten gefunden — der Ticker hat vermutlich kein US-Listing. Scorecard und Prognose basieren auf Marktkennzahlen und Schätzungen.'
          : 'SEC-Daten sind nicht verfügbar. Scorecard und Prognose laufen mit Schätzungen — Ergebnisse mit Vorbehalt lesen.');
    } else {
      status = timedOut ? 'timeout' : 'partial';
      const which = !fundamentalsOk
        ? 'XBRL-Fundamentaldaten (10-K) fehlen'
        : '10-K/10-Q-Filings konnten nicht abgerufen werden';
      message = timedOut
        ? `${which} (Timeout). Scorecard und Prognose nutzen verfügbare Werte, fehlende Größen sind Schätzungen.`
        : `${which}. Scorecard und Prognose nutzen verfügbare Werte, fehlende Größen sind Schätzungen.`;
    }
    return {
      ready: true,
      status,            // 'complete' | 'partial' | 'missing' | 'timeout'
      complete: status === 'complete',
      partial: status === 'partial' || status === 'timeout',
      missing: status === 'missing',
      timed_out: timedOut,
      filings_ok: filingsOk,
      fundamentals_ok: fundamentalsOk,
      filings_count: filingsCount,
      fy_count: fyCount,
      note,
      message,
    };
  }

  function renderSecStatusBanner(state, { compact = false } = {}) {
    const s = state?.secStatus;
    if (!s || s.complete) return '';
    const tone = s.missing ? 'bad' : 'warm';
    const borderColor = tone === 'bad' ? 'rgba(239,68,68,0.45)' : 'rgba(245,158,11,0.45)';
    const tintFrom = tone === 'bad' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.10)';
    const icon = tone === 'bad' ? '⚠' : 'ⓘ';
    const headline = s.missing
      ? 'SEC-Daten nicht verfügbar — Berechnung basiert auf Schätzungen'
      : s.timed_out
        ? 'SEC-Datenabruf hat Timeout ausgelöst — Teilberechnung'
        : 'SEC-Daten unvollständig — Teilberechnung';
    const facts = [
      `Filings: ${s.filings_ok ? `${s.filings_count} verfügbar` : '0 (fehlend)'}`,
      `XBRL FY-Reihen: ${s.fundamentals_ok ? `${s.fy_count} Jahre` : '0 (fehlend)'}`,
      s.timed_out ? 'Status: Client-Timeout (90s)' : null,
    ].filter(Boolean).join(' · ');
    if (compact) {
      return `<div class="text-[11px] leading-snug rounded-md px-2.5 py-1.5 mb-3 border" style="border-color:${borderColor}; background:${tintFrom}; color:#0f172a">
        <span class="font-medium">${icon} ${escapeHtml(headline)}</span>
        <span class="text-ink-300 ml-1.5">· ${escapeHtml(facts)}</span>
      </div>`;
    }
    return `<div class="card mb-4" style="border-color:${borderColor}; background: linear-gradient(180deg, ${tintFrom} 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%);">
      <div class="flex items-start gap-3">
        <span class="text-${tone === 'bad' ? 'accent-bad' : 'accent-warm'} text-xl leading-none">${icon}</span>
        <div class="flex-1 min-w-0">
          <h2 class="!mb-1 !text-base" style="text-transform:none; letter-spacing:0;">${escapeHtml(headline)}</h2>
          <p class="text-sm text-ink-100 mb-1.5 leading-relaxed">${escapeHtml(s.message || '')}</p>
          <p class="text-[11px] text-ink-300 font-mono">${escapeHtml(facts)}</p>
        </div>
      </div>
    </div>`;
  }

  // Wenn die SEC-Daten als „bereit" markiert sind, blenden wir den Banner
  // direkt im aktuell sichtbaren Übersicht-/Scorecard-Skeleton ein. Sobald
  // paintOverviewFinal läuft, übernimmt der dortige Render-Pfad — diese
  // Funktion ist nur der frühe Hint, bevor die Scorecard fertig ist.
  function paintSecStatusBanner(state) {
    const s = state?.secStatus;
    if (!s) return;
    const tab = $('#tab-uebersicht');
    if (!tab) return;
    const html = renderSecStatusBanner(state);
    if (!html) return;
    // Falls Übersicht noch im Skeleton-Modus ist (keine `grid lg:grid-cols-3`
    // im DOM), prepend wir nicht — paintOverviewFinal kümmert sich gleich.
    // Andernfalls (z.B. Re-Run einer Analyse) ist der Banner einmalig oben.
    if (!tab.querySelector('#sec-status-banner')) {
      const wrap = document.createElement('div');
      wrap.id = 'sec-status-banner';
      wrap.innerHTML = html;
      tab.insertBefore(wrap, tab.firstChild);
    }
  }

  async function runLLMAnalysis(state) {
    paintKIAnalysisSkeleton();
    try {
      const r = await api('/analysis', {
        method: 'POST',
        body: JSON.stringify({
          ticker: state.ticker,
          info: state.quote?.info || {},
          fundamentals: state.fundamentals,
          filings: state.filings,
          news: state.news,
          // Issue 17: SEC-Status mitsenden, damit der Prompt
          // datenqualitaet.luecken bei partial/missing/timeout korrekt füllt.
          sec_status: state.secStatus || null,
        }),
      });
      state.analysis = r.analysis;
      state.analysisMeta = { model: r.model, usage: r.usage, raw_excerpt: r.raw_excerpt };
      paintKIAnalysis(state);
      // Issue 10: paintOverviewFinal hängt am state.score — der ist hier noch
      // nicht da. Risiken-Tab darf die identifizierten Risiken aber schon
      // zeigen (Score-Ring fehlt noch, das ist OK).
      paintRisks(state);

      // Peer-Vorschläge → Quotes laden
      if (r.analysis?.peer_vorschlaege?.length) {
        try {
          const p = await api('/peers', { method: 'POST', body: JSON.stringify({ tickers: r.analysis.peer_vorschlaege }) });
          state.peers = (p.peers || []).filter(x => x.ok);
          paintPeers(state);

          // Issue 9: Quantitative Peer-Matrix mit Perzentilen
          try {
            const pm = await api('/peer-matrix', {
              method: 'POST',
              body: JSON.stringify({
                ticker: state.ticker,
                peers: (state.peers || []).map(x => x.ticker),
              }),
            });
            state.peerMatrix = pm;
            paintPeers(state); // re-render mit Matrix
          } catch (e) { console.warn('peer-matrix failed', e); }
        } catch (e) { console.warn('peers failed', e); }
      }
    } catch (e) {
      $('#tab-ki').innerHTML = `<div class="card"><p class="text-accent-bad">KI-Analyse fehlgeschlagen: ${escapeHtml(e.message)}</p></div>`;
    }
  }

  async function runDeepAnalysis(state) {
    paintDeepAnalysisSkeleton();
    try {
      const r = await api('/deep-analysis', {
        method: 'POST',
        body: JSON.stringify({
          ticker: state.ticker,
          info: state.quote?.info || {},
          fundamentals: state.fundamentals,
          filings: state.filings,
          news: state.news,
        }),
      });
      state.deep = r;
      paintDeepAnalysis(state, r);
      // KI-Report aktualisieren (Quellen-Liste bezieht deep.sources ein)
      if (state.analysis) paintKIAnalysis(state);
    } catch (e) {
      $('#tab-tiefen').innerHTML = `<div class="card"><p class="text-accent-bad">KI-Tiefenanalyse fehlgeschlagen: ${escapeHtml(e.message)}</p></div>`;
    }
  }

  // ---------------------------------------------------------------------
  // 6-Monats-News-Analyse (Issue 3)
  // ---------------------------------------------------------------------
  async function runNews6m(state) {
    paintNews6mSkeleton(state);
    try {
      const name = state.meta?.name || state.quote?.info?.longName || state.quote?.info?.shortName || '';
      const r = await api('/news-6m?ticker=' + encodeURIComponent(state.ticker) +
        '&name=' + encodeURIComponent(name));
      state.news6m = r;
      paintNews(state); // News-Tab neu rendern mit 6m-Block oben
      // KI-Report aktualisieren — News-Zusammenfassung & Quellen einbinden
      if (state.analysis) paintKIAnalysis(state);
    } catch (e) {
      // Kein Hard-Fail — News-Tab zeigt einfach nur die Standard-News
      console.warn('news-6m failed', e);
      state.news6m = { error: e.message };
      paintNews(state);
    }
  }

  // ---------------------------------------------------------------------
  // Branchenanalyse (Issue 3)
  // ---------------------------------------------------------------------
  async function runIndustry(state) {
    paintIndustrySkeleton();
    try {
      const info = state.quote?.info || {};
      const r = await api('/industry', {
        method: 'POST',
        body: JSON.stringify({
          ticker: state.ticker,
          name: state.meta?.name || info.longName || info.shortName || '',
          sector: info.sector || '',
          industry: info.industry || '',
        }),
      });
      state.industry = r;
      paintIndustry(state);
      // KI-Report aktualisieren — Branche-Quellen einbeziehen
      if (state.analysis) paintKIAnalysis(state);
    } catch (e) {
      $('#tab-branche').innerHTML = `<div class="card"><p class="text-accent-bad">Branchenanalyse fehlgeschlagen: ${escapeHtml(e.message)}</p></div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Ausführliches Fazit (Issue 3)
  // Wird gestartet, sobald die Vor-Analysen verfügbar sind (best-effort).
  // ---------------------------------------------------------------------
  async function runConclusion(state) {
    paintConclusionSkeleton();
    try {
      const r = await api('/conclusion', {
        method: 'POST',
        body: JSON.stringify({
          ticker: state.ticker,
          displayName: state.meta?.name || state.quote?.info?.longName,
          info: state.quote?.info || {},
          fundamentals: state.fundamentals,
          score: state.score,
          analysis: state.analysis,
          deep: state.deep,
          news6m: state.news6m,
          industry: state.industry,
          news: state.news,
          filings: state.filings,
        }),
      });
      state.conclusion = r.conclusion;
      state.conclusionMeta = { model: r.model, usage: r.usage, raw_excerpt: r.raw_excerpt };
      paintConclusion(state);
      // Übersicht auch refreshen (KI-Kurzfazit wird durch Fazit-Highlight ersetzt)
      paintOverviewFinal(state);
      // KI-Report mit konsolidiertem Fazit & Handlungsempfehlung aktualisieren
      if (state.analysis) paintKIAnalysis(state);
    } catch (e) {
      $('#tab-fazit').innerHTML = `<div class="card"><p class="text-accent-bad">Fazit-Generierung fehlgeschlagen: ${escapeHtml(e.message)}</p></div>`;
    }
  }

  // ---------------------------------------------------------------------
  // KI-Prognose (Issue 11)
  // 3-Jahres-Bull/Base/Bear-Schätzungen + 12-Monats-Kursziel mit
  // Konfidenzintervall, basierend auf SEC-Historie, Analysten-Konsens,
  // Branchenausblick und Wettbewerbsanalyse.
  // ---------------------------------------------------------------------
  async function runForecast(state) {
    paintForecastSkeleton(state);
    const payload = {
      ticker: state.ticker,
      info: state.quote?.info || {},
      fundamentals: state.fundamentals,
      yfExtra: state.yfExtra,
      expectations: state.expectations,
      industry: state.industry,
      deep: state.deep,
      news: state.news,
      filings: state.filings,
      // Issue 17: SEC-Datenreife mitgeben — der LLM-Prompt nimmt das auf
      // und liefert bei partial/missing/timeout entsprechende Caveats
      // ("Vertrauen niedrig", explizite Limitierungen).
      sec_status: state.secStatus || null,
    };
    // Issue 14 + 15: Fehlerrobustheit gegen 504/Timeout. Bis zu 3 Versuche mit
    // exponentiellem Backoff. Transiente Fehler (5xx, NetworkError, Timeout)
    // werden retry'd, 4xx geht direkt durch. Status für den User wird zwischen
    // Versuchen mit Live-Countdown aktualisiert.
    const transientStatus = s => s === 0 || s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599);
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) paintForecastRetry(attempt, MAX_ATTEMPTS);
        const r = await api('/forecast', { method: 'POST', body: JSON.stringify(payload) });
        state.forecast = r.forecast;
        state.forecastMeta = { model: r.model, usage: r.usage, raw_excerpt: r.raw_excerpt };
        paintForecast(state);
        // Bewertungs-Tab refreshen — zeigt jetzt die Prognose-Implikation
        // (Fair-Value-Adjustment, Base-Kursziel) als Verbindung zur klassischen
        // TTM-Bewertung. Konzept (Issue 11): „Die Prognosen fließen in die
        // Bewertung ein".
        paintValuation(state);
        // Issue 14: Übersicht refreshen — Prognose-Snapshot direkt unter der Scorecard.
        paintOverviewFinal(state);
        return;
      } catch (e) {
        lastErr = e;
        const status = e.status || 0;
        const retryHint = e.body?.retry_recommended === true;
        const isTransient = retryHint || transientStatus(status) || /timeout|fetch|network|abort/i.test(e.message || '');
        console.warn(`[forecast] Versuch ${attempt}/${MAX_ATTEMPTS} fehlgeschlagen (status=${status}): ${e.message}`);
        if (!isTransient || attempt === MAX_ATTEMPTS) break;
        // Sichtbares Warten zwischen den Versuchen
        const waitMs = 1200 * attempt;
        await waitWithCountdown(waitMs, attempt + 1, MAX_ATTEMPTS);
      }
    }
    console.warn('forecast failed nach allen Versuchen', lastErr);

    // Issue 15 + 16: klarere Fehlermeldung. Server liefert
    // `error` (User-Text), `attempts`, `timeout`, `per_call_timeouts_s`,
    // `fallback_used`, `retry_recommended`. Wir nutzen diese Felder für
    // eine kuratierte Erklärung statt nur dem Roh-`error`-String.
    const body = lastErr?.body || {};
    const isTimeoutErr = !!body.timeout || /timeout/i.test(lastErr?.message || '') || (lastErr?.status === 504);
    const attemptsLabel = body.attempts ? `${body.attempts} Server-${body.attempts === 1 ? 'Versuch' : 'Versuche'} × ${MAX_ATTEMPTS} Browser-Versuche` : `${MAX_ATTEMPTS} Versuche`;
    const timeoutsList = Array.isArray(body.per_call_timeouts_s) && body.per_call_timeouts_s.length
      ? body.per_call_timeouts_s.join('s/') + 's'
      : (body.per_call_timeout_s ? body.per_call_timeout_s + 's' : '240s');
    const fallbackNote = body.fallback_used
      ? ' Auch die Fallback-Modelle (gpt-4o-mini, claude-haiku-4.5, gpt-4o) haben nicht geantwortet — aimlapi ist gerade systemweit unter Last.'
      : ' Der Server probiert automatisch DeepSeek V4 (240s) → gpt-4o-mini → claude-haiku-4.5 → gpt-4o.';
    const explainerText = isTimeoutErr
      ? `DeepSeek V4 (über aimlapi) hat in <strong>${timeoutsList}</strong> nicht geantwortet.${fallbackNote} Ein zweiter Versuch in 2–5 Minuten klappt meist.`
      : 'Beim Aufruf der KI-Prognose ist ein Fehler aufgetreten. Wenn der Fehler bleibt, prüfe die Server-Logs (pm2 logs mph700pj7706).';
    const headlineText = isTimeoutErr ? 'Prognose-Timeout' : 'Prognose fehlgeschlagen';
    const errMsg = body.error || lastErr?.message || 'Unbekannter Fehler';

    $('#tab-prognose').innerHTML = `<div class="card" style="border-color: rgba(239,68,68,0.45); background: linear-gradient(180deg, rgba(239,68,68,0.08) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%);">
      <div class="flex items-start gap-3">
        <span class="text-accent-bad text-2xl leading-none">⚠</span>
        <div class="flex-1 min-w-0">
          <h2 class="!mb-1 !text-base" style="text-transform:none; letter-spacing:0;">${headlineText}</h2>
          <p class="text-sm text-ink-100 mb-2"><strong class="text-accent-bad">Fehler:</strong> ${escapeHtml(errMsg)}</p>
          <p class="text-xs text-ink-300 mb-3 leading-relaxed">
            ${explainerText}
            <br><span class="text-ink-300">Bereits versucht: ${attemptsLabel}.</span>
          </p>
          <div class="flex gap-2 flex-wrap">
            <button id="forecast-retry-btn" class="text-sm border border-accent-info/40 text-accent-info hover:bg-accent-info/10 rounded-md px-3 py-1.5 transition">
              ↻ Erneut versuchen
            </button>
            <a href="https://status.aimlapi.com/" target="_blank" rel="noopener" class="text-sm border border-ink-500 text-ink-200 hover:text-ink-100 hover:border-ink-400 rounded-md px-3 py-1.5 transition">
              Provider-Status ↗
            </a>
          </div>
        </div>
      </div>
    </div>`;
    const btn = $('#forecast-retry-btn');
    if (btn) btn.addEventListener('click', () => runForecast(state));
    // Auch als Toast — der User sieht den Fehler ggf. nicht sofort, falls er
    // gerade in einer anderen Section liest.
    toast(`KI-Prognose ${isTimeoutErr ? 'timeout' : 'fehlgeschlagen'} — Retry verfügbar im Prognose-Tab.`, 'err');
    // Übersicht refreshen — Snapshot zeigt jetzt den Fehlerzustand mit Retry-Hinweis.
    paintOverviewFinal(state);
  }

  // Issue 15: Wartet `ms` Millisekunden und zeigt im Prognose-Tab einen
  // Live-Countdown bis zum nächsten Retry — User sieht, dass etwas läuft
  // und kann grob einschätzen wann es weitergeht.
  async function waitWithCountdown(ms, nextAttempt, maxAttempts) {
    const start = Date.now();
    const tab = $('#tab-prognose');
    const tick = () => {
      const left = Math.max(0, Math.ceil((ms - (Date.now() - start)) / 1000));
      const cd = tab ? tab.querySelector('#forecast-retry-countdown') : null;
      if (cd) cd.textContent = left + 's';
    };
    if (tab) {
      tab.innerHTML = `<div class="card">
        <h2>KI-Prognose · Warte auf Retry (${nextAttempt}/${maxAttempts})</h2>
        <div class="text-ink-300 text-sm">Nächster Versuch in <span id="forecast-retry-countdown" class="font-mono text-ink-100">${Math.ceil(ms / 1000)}s</span> <span class="spinner"></span></div>
        <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">DeepSeek V4 war gerade unter Last — wir warten kurz, dann nochmal.</p>
      </div>`;
    }
    const interval = setInterval(tick, 250);
    try { await new Promise(rs => setTimeout(rs, ms)); }
    finally { clearInterval(interval); }
  }

  function paintForecastRetry(attempt, max) {
    const tab = $('#tab-prognose');
    if (!tab) return;
    tab.innerHTML = `<div class="card">
      <h2>KI-Prognose · Wiederhole (${attempt}/${max})</h2>
      <div class="text-ink-300 text-sm">Erneuter Versuch nach Timeout/Serverfehler <span class="spinner"></span></div>
      <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">DeepSeek V4 ist gerade unter Last — wir versuchen es nochmal (bis zu ${150}s pro Versuch).</p>
    </div>`;
  }

  // ---------------------------------------------------------------------
  // PDF-Report (Issue 3)
  // ---------------------------------------------------------------------
  async function downloadPdfReport() {
    const state = currentState;
    if (!state || !state.ticker) {
      toast('Keine Analyse aktiv', 'err');
      return;
    }
    const btn = $('#pdf-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Erstelle PDF…'; }
    try {
      const payload = {
        ticker: state.ticker,
        displayName: state.meta?.name || state.quote?.info?.longName,
        info: state.quote?.info || {},
        history: state.quote?.history || [],
        fundamentals: state.fundamentals,
        score: state.score,
        analysis: state.analysis,
        deep: state.deep,
        news6m: state.news6m,
        industry: state.industry,
        conclusion: state.conclusion,
        news: state.news,
        filings: state.filings,
        fairValue: state.fairValue,
        yfExtra: state.yfExtra,
        // Issue 12: alle Webinhalte ins PDF — Markterwartung (Issue 9),
        // Peers + Peer-Matrix (Issue 9), KI-Prognose 3J + 12M-Kursziel (Issue 11).
        expectations: state.expectations,
        peers: state.peers,
        peerMatrix: state.peerMatrix,
        forecast: state.forecast,
        forecastMeta: state.forecastMeta,
        // Issue 13: Technische Analyse + Fear & Greed Index
        technical: state.technical,
        fearGreed: state.fearGreed,
      };
      const r = await fetch(API + '/report-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('HTTP ' + r.status + ' — ' + txt.slice(0, 200));
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Alpha-Scope_${state.ticker}_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('PDF heruntergeladen', 'ok');
    } catch (e) {
      toast('PDF fehlgeschlagen: ' + e.message, 'err');
      console.error(e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ PDF-Report'; }
    }
  }

  // ---------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------
  const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function paintHeaderSkeleton(ticker, meta) {
    $('#ticker-header').innerHTML = `
      <div class="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div class="flex items-center gap-3 mb-2">
            <h1 class="text-3xl font-bold tracking-tight">${escapeHtml(meta?.name || ticker)}</h1>
            <span class="font-mono text-ink-300 text-lg">${escapeHtml(ticker)}</span>
          </div>
          <div class="text-ink-300 text-sm">Lade Kursdaten <span class="spinner"></span></div>
        </div>
        <div class="text-right">
          <div class="skeleton" style="width: 8rem; height: 2.5rem;"></div>
        </div>
      </div>`;
  }

  function paintHeader(state) {
    const info = state.quote?.info || {};
    const change = info.price && info.previous_close ? info.price - info.previous_close : null;
    const changePct = change && info.previous_close ? change / info.previous_close : null;
    const dirCls = change > 0 ? 'pos' : (change < 0 ? 'neg' : '');
    const inWl = inWatchlist(state.ticker);
    const displayName = state.meta?.name || info.longName || info.shortName || state.ticker;
    $('#ticker-header').innerHTML = `
      <div class="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div class="flex items-center gap-3 mb-2">
            <h1 class="text-3xl font-bold tracking-tight">${escapeHtml(displayName)}</h1>
            <span class="font-mono text-ink-300 text-lg">${escapeHtml(state.ticker)}</span>
            ${info.exchange ? `<span class="text-xs text-ink-300 border border-ink-500 rounded px-2 py-0.5">${escapeHtml(info.exchange)}</span>` : ''}
            ${info._from_web ? `<span class="text-xs text-accent-warm border border-accent-warm/40 rounded px-2 py-0.5" title="Daten stammen aus Websuche-Fallback, nicht aus yfinance">via Websuche</span>` : ''}
          </div>
          <div class="text-ink-300 text-sm flex flex-wrap gap-x-4 gap-y-1">
            ${info.sector ? `<span>Sektor: <span class="text-ink-200">${escapeHtml(info.sector)}</span></span>` : ''}
            ${info.industry ? `<span>Industrie: <span class="text-ink-200">${escapeHtml(info.industry)}</span></span>` : ''}
            ${info.market_cap ? `<span>Marktkap.: <span class="text-ink-200">${fmt.money(info.market_cap, info.currency)}</span></span>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="text-right">
            <div class="text-3xl font-bold font-mono">${fmt.num(info.price, 2)} <span class="text-base font-normal text-ink-300">${info.currency || ''}</span></div>
            <div class="text-sm font-mono ${dirCls}">${change !== null ? (change > 0 ? '+' : '') + fmt.num(change, 2) : '—'} (${changePct !== null ? (changePct > 0 ? '+' : '') + fmt.pct(changePct) : '—'})</div>
          </div>
          <div class="flex flex-col gap-1.5">
            <button id="watch-btn" class="text-sm border border-ink-500 hover:border-accent rounded-md px-3 py-1.5 transition ${inWl ? 'text-accent' : 'text-ink-200'}">
              ${inWl ? '★ In Watchlist' : '☆ Zur Watchlist'}
            </button>
            <button id="pdf-btn" class="text-sm border border-accent-info/40 text-accent-info hover:bg-accent-info/10 rounded-md px-3 py-1.5 transition">
              ⬇ PDF-Report
            </button>
          </div>
        </div>
      </div>`;
    $('#watch-btn').addEventListener('click', () => {
      if (inWatchlist(state.ticker)) removeWatch(state.ticker);
      else addWatch({ symbol: state.ticker, name: state.meta?.name || info.longName || state.ticker });
      paintHeader(state);
    });
    $('#pdf-btn').addEventListener('click', () => downloadPdfReport());
  }

  function paintOverviewSkeleton() {
    $('#tab-uebersicht').innerHTML = `
      <div class="grid lg:grid-cols-3 gap-4">
        <div class="card lg:col-span-2">
          <h2>Kurs · 5 Jahre</h2>
          <div class="chart-3-2"><canvas id="price-chart"></canvas></div>
        </div>
        <div class="card">
          <h2>Investment-Ampel</h2>
          <div class="text-ink-300 text-sm">Wartet auf KI-Analyse <span class="spinner"></span></div>
          <div class="text-[11px] text-ink-300 mt-1.5 leading-snug">Ampel &amp; Dual-Score werden nach Abschluss der ausführlichen KI-Analyse berechnet (Issue 10).</div>
        </div>
        <div class="card lg:col-span-3" id="overview-scorecard-skeleton">
          <h2>Scorecard</h2>
          <div class="text-ink-300 text-sm">Wartet auf vollständige KI-Analyse (Geschäftsmodell, Burggraben, Risiken, Quellen) <span class="spinner"></span></div>
          <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">
            Die Scorecard wird erst nach Abschluss der KI-Analyse berechnet, damit qualitative Faktoren und Quellenqualität einfließen können — nicht eine vorläufige Zwischenversion (Issue 10).
          </p>
        </div>
        <div class="card lg:col-span-3">
          <h2>Ausführliches Fazit</h2>
          <div class="text-ink-300 text-sm">Folgt nach Scorecard <span class="spinner"></span></div>
        </div>
      </div>`;
  }

  // Issue 10: Wenn alle KI-Passes durch sind, kurzer Übergangs-Skeleton bevor
  // die Scorecard tatsächlich vom Server berechnet wurde.
  function paintScorecardComputing() {
    const el = $('#overview-scorecard-skeleton');
    if (el) {
      el.innerHTML = `
        <h2>Scorecard</h2>
        <div class="text-ink-300 text-sm">KI-Analyse fertig — berechne jetzt Scorecard <span class="spinner"></span></div>
        <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">
          Rule-based Sub-Scores (Qualität, Wachstum, Bewertung, Burggraben, Sentiment, Risiko) werden serverseitig aus den nun vollständig verfügbaren Daten aggregiert.
        </p>`;
    }
  }

  function paintTabSkeletons() {
    const sk = '<div class="card"><div class="text-ink-300 text-sm">Lade Daten <span class="spinner"></span></div></div>';
    // Issue 10: Tabs, die das Scoring brauchen, zeigen explizit, dass sie
    // auf die KI-Analyse warten — sonst wirken sie nur „träge".
    const skScore = `<div class="card">
      <div class="text-ink-300 text-sm">Wartet auf KI-Analyse <span class="spinner"></span></div>
      <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">Scorecard wird erst nach Abschluss der ausführlichen KI-Analyse berechnet (Issue 10).</p>
    </div>`;
    $('#tab-fundamental').innerHTML = sk;
    $('#tab-bewertung').innerHTML = sk;
    $('#tab-peers').innerHTML = sk;
    $('#tab-branche').innerHTML = sk;
    $('#tab-fazit').innerHTML = sk;
    $('#tab-news').innerHTML = sk;
    $('#tab-sec').innerHTML = sk;
    $('#tab-risiken').innerHTML = sk;
    $('#tab-ki').innerHTML = sk;
    $('#tab-tiefen').innerHTML = sk;
    // Issue 13: Technische Analyse hat eigenen Skeleton (lädt parallel)
    if ($('#tab-technical')) $('#tab-technical').innerHTML = sk;
    // Issue 9 / Issue 10: score-abhängige Tabs
    if ($('#tab-entscheidung')) $('#tab-entscheidung').innerHTML = skScore;
    if ($('#tab-momentum')) $('#tab-momentum').innerHTML = skScore;
    if ($('#tab-erwartung')) $('#tab-erwartung').innerHTML = sk;
    // Issue 11: Prognose-Tab wartet auf vollständige Vor-Analysen (Industry,
    // Deep, Expectations). Initial-Skeleton signalisiert das.
    if ($('#tab-prognose')) {
      $('#tab-prognose').innerHTML = `<div class="card">
        <h2>KI-Prognose (Issue 11)</h2>
        <div class="text-ink-300 text-sm">Wartet auf Tiefenanalyse, Branche &amp; Markterwartung <span class="spinner"></span></div>
        <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">
          Die Drei-Jahres-Prognose und das 12-Monats-Kursziel werden gerechnet, sobald historische
          Daten, Forward-EPS, Analysten-Konsens, Branchen-Ausblick und Wettbewerbslage vorliegen.
        </p>
      </div>`;
    }
  }

  function paintOverviewPartial(state) {
    // Chart sofort
    drawPriceChart(state.quote?.history || [], state.quote?.info?.currency);
  }

  function paintOverviewFinal(state) {
    const info = state.quote?.info || {};
    const sc = state.score?.scores || {};
    const verdict = state.score?.verdict || '—';
    const ampel = state.score?.ampel || 'gelb';
    const aIc = ampel === 'gruen' ? '🟢' : ampel === 'rot' ? '🔴' : ampel === 'orange' ? '🟠' : '🟡';
    // Issue 9: Dual-Score Business Quality vs Stock Attractiveness
    const bq = state.score?.business_quality_score;
    const sa = state.score?.stock_attractiveness_score;
    const capReason = state.score?.attractiveness_cap_reason;
    const capApplied = state.score?.attractiveness_cap_applied;

    const concl = state.conclusion;

    const histRange = chartRangeLabel(state.quote?.history);
    // Issue 7: Ausführliches Fazit ersetzt das Kurzfazit unter der Scorecard.
    // Wenn die Conclusion noch lädt, zeigen wir einen Skeleton-Block — der Block
    // wird durch den späteren paintOverviewFinal-Refresh aus runConclusion() ersetzt.
    const fazitBlock = concl
      ? buildConclusionFullHtml(concl, state, { idPrefix: 'overview-' })
      : `<div class="card">
           <h2>Ausführliches Fazit</h2>
           <p class="text-sm text-ink-200 mb-2">
             Konsolidierte Bewertung aus Fundamentaldaten, Scorecard, KI-Analyse, News &amp; Branche —
             mit Stärken/Schwächen, Chancen/Risiken, Handlungsempfehlung und Quellen.
           </p>
           <div class="text-ink-300 text-sm">DeepSeek V4 konsolidiert die Analyse <span class="spinner"></span></div>
         </div>`;

    // Issue 17: Wenn SEC-Daten fehlen/partiell sind, zeigen wir den Hinweis
    // einmal prominent oben in der Übersicht — vor Scorecard und Snapshot.
    const secBanner = renderSecStatusBanner(state);

    $('#tab-uebersicht').innerHTML = `
      ${secBanner}
      <div class="grid lg:grid-cols-3 gap-4">
        <div class="card lg:col-span-2">
          <div class="flex items-center justify-between mb-3">
            <h2 class="!mb-0">Kurs · ${histRange}</h2>
            <div class="text-xs text-ink-300">
              <span class="font-mono">52W: ${fmt.num(info.year_low, 2)} – ${fmt.num(info.year_high, 2)}</span>
            </div>
          </div>
          <div class="chart-3-2"><canvas id="price-chart"></canvas></div>
        </div>

        <div class="card">
          <h2>Investment-Ampel &amp; Dual-Score</h2>
          <div class="mb-3">
            <span class="ampel ampel-${ampel}"><span class="dot"></span> ${verdict}</span>
          </div>
          <div class="grid grid-cols-2 gap-3 mb-3">
            <div class="rounded-lg border border-ink-600 bg-ink-800/40 p-3">
              <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">Business Quality</div>
              <div class="flex items-baseline gap-1">
                <span class="text-2xl font-bold" style="color:${scoreColor(bq)}">${bq ?? '—'}</span>
                <span class="text-xs text-ink-300">/100</span>
              </div>
              <div class="text-[10px] text-ink-300 mt-1">Wie hochwertig ist das Unternehmen? (preis-unabh.)</div>
            </div>
            <div class="rounded-lg border border-ink-600 bg-ink-800/40 p-3 ${capApplied ? 'border-accent-warm/60' : ''}">
              <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">Stock Attractiveness ${capApplied ? '<span class="text-accent-warm">·gecappt</span>' : ''}</div>
              <div class="flex items-baseline gap-1">
                <span class="text-2xl font-bold" style="color:${scoreColor(sa)}">${sa ?? '—'}</span>
                <span class="text-xs text-ink-300">/100</span>
              </div>
              <div class="text-[10px] text-ink-300 mt-1">Wie attraktiv ist die Aktie aktuell? (preis-abh.)</div>
            </div>
          </div>
          ${capReason ? `<div class="text-[11px] text-accent-warm leading-snug border-l-2 border-accent-warm/60 pl-2 py-1 bg-accent-warm/5 rounded-r mb-3">⚠ ${escapeHtml(capReason)}</div>` : ''}
          <div class="border-t border-ink-600/60 pt-3 mb-1">
            <div class="flex items-baseline gap-2">
              <span class="text-3xl font-bold">${sc.total ?? '—'}</span>
              <span class="text-ink-300 text-xs">/100 Gesamtscore (klass. Gewichtung)</span>
            </div>
          </div>
          <div class="text-[10px] text-ink-300 mt-2 leading-snug">
            Gewichtung: Qualität 25% · Wachstum 20% · Bewertung 20% · Burggraben 15% · Sentiment 10% · Risiko 10%
          </div>
        </div>

        <div class="card lg:col-span-3">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="!mb-0">Scorecard mit Sub-Dimensionen</h2>
            <a href="#" data-jump-tab="entscheidung" class="text-xs text-accent-info hover:underline">→ Entscheidungsmatrix</a>
          </div>
          ${renderScorecardAIFallbackSummary(state)}
          ${renderScorecardGrid(sc, state.score?.breakdown)}
          ${renderScoreBreakdownAccordion(state)}
        </div>

        ${renderOverviewForecastSnapshot(state)}

        ${state.webOverview ? `
          <div class="card lg:col-span-3" style="border-color: rgba(251,191,36,0.4); background: linear-gradient(180deg, rgba(251,191,36,0.04) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%);">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-accent-warm">⚠</span>
              <h2 class="!mb-0">Yahoo Finance hat (fast) keine Daten — Webrecherche-Fallback</h2>
            </div>
            <p class="text-sm text-ink-200 leading-relaxed mb-3">
              Der Ticker ist in yfinance nicht (vollständig) verfügbar. Basisdaten wurden per Websuche
              ${state.webOverview.extracted ? 'und KI-Extraktion ' : ''}ermittelt — siehe Tab „Fundamentaldaten" für Details und Quellen.
            </p>
            ${state.webOverview.extracted?.summary ? `<p class="text-sm text-ink-100">${escapeHtml(state.webOverview.extracted.summary)}</p>` : ''}
          </div>` : ''}
      </div>

      <div class="mt-4">
        ${fazitBlock}
      </div>`;
    drawPriceChart(state.quote?.history || [], state.quote?.info?.currency);

    // PDF-Button im eingebetteten Fazit-Block (nur wenn Conclusion bereits da)
    if (concl) wireConclusionPdfButtons('overview-');
  }

  // Issue 14: Kompakter Prognose-Snapshot direkt unter der Scorecard, damit
  // Kursziel + KI-Bewertung der Fairness ohne Scrollen sichtbar sind. Verlinkt
  // bei Klick auf die volle Prognose-Section.
  function renderOverviewForecastSnapshot(state) {
    const f = state.forecast;
    const info = state.quote?.info || {};
    const cur = info.currency || 'USD';
    const symCur = cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'JPY' ? '¥' : '$';
    const price = safeNum(info.price);

    // Loading state: Prognose noch nicht da
    if (!f) {
      return `<div class="card lg:col-span-3" style="border-color: rgba(96,165,250,0.25); background: linear-gradient(180deg, rgba(96,165,250,0.04) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%);">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <div>
            <h2 class="!mb-1">🎯 KI-Prognose · 12-Monats-Kursziel &amp; Fairness</h2>
            <p class="text-xs text-ink-300">DeepSeek V4 berechnet Bull/Base/Bear-Kursziel und Bewertungs-Implikation — sichtbar ohne Scrollen.</p>
          </div>
          <a href="#" data-jump-tab="prognose" class="text-xs text-accent-info hover:underline">→ Volle Prognose</a>
        </div>
        <div class="text-ink-300 text-sm">Berechne 12-Monats-Kursziel <span class="spinner"></span></div>
      </div>`;
    }

    const kp = f.kurs_prognose_12m || {};
    const ks = f.kurs_konfidenz || kp.konfidenz_kurs || {};
    const bi = f.bewertungs_implikation || {};

    const bullKurs = safeNum(kp.bull?.kurs);
    const baseKurs = safeNum(kp.base?.kurs);
    const bearKurs = safeNum(kp.bear?.kurs);
    const konfLo = safeNum(ks.unten);
    const konfHi = safeNum(ks.oben);
    const konfPct = safeNum(ks.konfidenz_pct);

    const upside = (k) => (k !== null && price !== null && price !== 0) ? (k - price) / price : null;
    const fmtUp = (u) => u === null ? '—' : ((u > 0 ? '+' : '') + (u * 100).toFixed(1) + '%');
    const upCls = (u) => u === null ? '' : u > 0 ? 'pos' : 'neg';

    const bullUp = upside(bullKurs);
    const baseUp = upside(baseKurs);
    const bearUp = upside(bearKurs);

    // Mini-Skala wie in paintForecast, kompakter
    let priceBar = '';
    if (price !== null && bearKurs !== null && bullKurs !== null) {
      const lo = Math.min(bearKurs, price);
      const hi = Math.max(bullKurs, price);
      const span = hi - lo || 1;
      const at = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
      const pPrice = at(price);
      const pBear = at(bearKurs);
      const pBase = baseKurs !== null ? at(baseKurs) : null;
      const pBull = at(bullKurs);
      const konfLeft = konfLo !== null && konfHi !== null ? at(konfLo) : null;
      const konfRight = konfLo !== null && konfHi !== null ? at(konfHi) : null;
      priceBar = `
        <div class="relative mt-3 mb-2 h-12">
          <div class="absolute inset-y-4 left-0 right-0 rounded-full bg-ink-600/60"></div>
          ${konfLeft !== null && konfRight !== null ? `<div class="absolute inset-y-4 rounded-full"
            style="left:${konfLeft}%; right:${100 - konfRight}%; background: linear-gradient(90deg, rgba(96,165,250,0.45), rgba(110,231,183,0.45));"></div>` : `<div class="absolute inset-y-4 rounded-full"
            style="left:${pBear}%; right:${100 - pBull}%; background: linear-gradient(90deg, rgba(248,113,113,0.35), rgba(110,231,183,0.35));"></div>`}
          <div class="absolute top-1 bottom-1 flex flex-col items-center" style="left:calc(${pBear}% - 0.5rem)" title="Bear">
            <span class="w-2.5 h-2.5 rounded-sm bg-neg border border-ink-900"></span>
          </div>
          ${pBase !== null ? `<div class="absolute top-1 bottom-1 flex flex-col items-center" style="left:calc(${pBase}% - 0.5rem)" title="Base">
            <span class="w-2.5 h-2.5 rounded-full bg-accent-info border border-ink-900"></span>
          </div>` : ''}
          <div class="absolute top-1 bottom-1 flex flex-col items-center" style="left:calc(${pBull}% - 0.5rem)" title="Bull">
            <span class="w-2.5 h-2.5 rounded-sm bg-pos border border-ink-900"></span>
          </div>
          <div class="absolute -bottom-1 flex flex-col items-center" style="left:calc(${pPrice}% - 0.5rem)" title="Aktueller Kurs">
            <span class="w-2.5 h-2.5 rounded-sm bg-accent border-2 border-ink-900 shadow"></span>
          </div>
        </div>`;
    }

    const fairnessLabel = bi.fair_value_adjustment ? String(bi.fair_value_adjustment) : null;
    const fairnessChip = fairnessLabel ? fcOutlookChip(fairnessLabel) : '<span class="chip">—</span>';

    return `<div class="card lg:col-span-3" style="border-color: rgba(110,231,183,0.3); background: linear-gradient(180deg, rgba(110,231,183,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%);">
      <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
        <div>
          <h2 class="!mb-1">🎯 KI-Prognose · 12-Monats-Kursziel &amp; Fairness</h2>
          <p class="text-xs text-ink-300">Konkretes Bull/Base/Bear-Ziel auf 12 Monate plus KI-Bewertung der aktuellen Fairness.</p>
        </div>
        <a href="#" data-jump-tab="prognose" class="text-xs text-accent-info hover:underline">→ Volle Prognose</a>
      </div>
      <div class="grid md:grid-cols-4 gap-3 items-stretch">
        <div class="rounded-lg border border-pos/30 bg-pos/5 p-3">
          <div class="text-[10px] uppercase tracking-wider text-pos mb-1">Bull</div>
          <div class="text-xl font-bold font-mono">${bullKurs !== null ? symCur + fmt.num(bullKurs, 2) : '—'}</div>
          <div class="text-xs font-mono ${upCls(bullUp)}">${fmtUp(bullUp)}</div>
        </div>
        <div class="rounded-lg border border-accent-info/40 bg-accent-info/5 p-3">
          <div class="text-[10px] uppercase tracking-wider text-accent-info mb-1">Base</div>
          <div class="text-xl font-bold font-mono">${baseKurs !== null ? symCur + fmt.num(baseKurs, 2) : '—'}</div>
          <div class="text-xs font-mono ${upCls(baseUp)}">${fmtUp(baseUp)}</div>
        </div>
        <div class="rounded-lg border border-neg/30 bg-neg/5 p-3">
          <div class="text-[10px] uppercase tracking-wider text-neg mb-1">Bear</div>
          <div class="text-xl font-bold font-mono">${bearKurs !== null ? symCur + fmt.num(bearKurs, 2) : '—'}</div>
          <div class="text-xs font-mono ${upCls(bearUp)}">${fmtUp(bearUp)}</div>
        </div>
        <div class="rounded-lg border border-ink-600 bg-ink-800/40 p-3">
          <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">KI-Fairness</div>
          <div class="mb-1">${fairnessChip}</div>
          <div class="text-[10px] text-ink-300 leading-snug">Fair-Value-Adjustment ggü. heutigem Kurs</div>
        </div>
      </div>
      ${priceBar}
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-300 mt-1">
        <span><span class="inline-block w-2 h-2 rounded-sm bg-accent align-middle mr-1.5"></span>Heute: <span class="font-mono text-ink-100">${price !== null ? symCur + fmt.num(price, 2) : '—'}</span></span>
        ${konfLo !== null && konfHi !== null ? `<span><span class="inline-block w-3 h-2 align-middle mr-1.5" style="background: linear-gradient(90deg, rgba(96,165,250,0.5), rgba(110,231,183,0.5))"></span>Konfidenzintervall: <span class="font-mono text-ink-100">${symCur}${fmt.num(konfLo, 2)} – ${symCur}${fmt.num(konfHi, 2)}</span>${konfPct !== null ? ` (${konfPct.toFixed(0)}%)` : ''}</span>` : ''}
      </div>
      ${bi.begruendung ? `<p class="text-xs text-ink-200 mt-2 leading-snug border-l-2 border-accent-info/40 pl-2 py-0.5"><strong class="text-ink-300">Begründung:</strong> ${escapeHtml(String(bi.begruendung).slice(0, 280))}${String(bi.begruendung).length > 280 ? '…' : ''}</p>` : ''}
    </div>`;
  }

  function ringSvg(score, label, color, opts = {}) {
    const s = (score === null || score === undefined) ? 0 : score;
    const R = 38, C = 2 * Math.PI * R;
    const off = C - (s / 100) * C;
    // Issue 15: text fill via currentColor — CSS-Variable je Theme (bright/dark)
    // sorgt für lesbaren Kontrast (dunkler Text auf weiß, heller Text auf schwarz).
    // Issue 18: bei AI-geschätzten Werten dünnere/gestrichelte Linie + KI-Badge.
    const aiBadge = opts.aiEstimated
      ? `<div class="text-[9px] mt-0.5 leading-tight text-center" style="color:#2563eb;">🤖 KI · ${escapeHtml(opts.confidenceLabel || 'niedrig')}</div>`
      : '';
    const dash = opts.aiEstimated ? 'stroke-dasharray:6 4;' : '';
    return `
      <div class="ring-wrap flex flex-col items-center" ${opts.title ? `title="${escapeHtml(opts.title)}"` : ''}>
        <svg viewBox="0 0 100 100" class="w-24 h-24">
          <circle class="ring-bg" cx="50" cy="50" r="${R}" stroke-width="9"/>
          <circle class="ring-fg" cx="50" cy="50" r="${R}" stroke-width="9" style="stroke:${color}; ${dash} stroke-dasharray:${opts.aiEstimated ? '6 4' : C}; stroke-dashoffset:${opts.aiEstimated ? 0 : off}; stroke-opacity:${opts.aiEstimated ? 0.55 : 1}"/>
          ${opts.aiEstimated ? `<circle cx="50" cy="50" r="${R}" stroke-width="9" fill="none" style="stroke:${color}; stroke-dasharray:${C}; stroke-dashoffset:${off}; stroke-opacity:0.95"/>` : ''}
          <text class="ring-score-text" x="50" y="55" text-anchor="middle" font-size="22" font-weight="600" fill="currentColor" font-family="Inter">${score ?? '—'}</text>
        </svg>
        <span class="mt-1.5 text-xs uppercase tracking-wider text-ink-300">${label}</span>
        ${aiBadge}
      </div>`;
  }

  function scoreColor(s) {
    if (s === null || s === undefined) return '#5a6378';
    if (s >= 70) return '#6ee7b7';
    if (s >= 50) return '#60a5fa';
    if (s >= 30) return '#fbbf24';
    return '#f87171';
  }

  function renderScorecardGrid(sc, breakdown) {
    // Issue 19: Risiko und Sentiment getrennt anzeigen, sobald die Sub-Scores
    // verfügbar sind. Aggregat-Score bleibt im Header, die einzelnen Ringe
    // zeigen die spezifischen Dimensionen — verhindert dass z.B. ein gutes
    // Bilanz-Score ein hohes Bewertungsrisiko überdeckt.
    const dims = [
      { k: 'quality',          l: 'Qualität' },
      { k: 'growth',           l: 'Wachstum' },
      { k: 'valuation',        l: 'Bewertung' },
      { k: 'moat',             l: 'Burggraben' },
      { k: 'financial_safety', l: 'Bilanz-Sicherheit', fallback: 'risk' },
      { k: 'investment_risk',  l: 'Investment-Risiko', fallback: 'risk' },
      { k: 'news_sentiment',   l: 'News-Sentiment',    fallback: 'sentiment' },
      { k: 'market_sentiment', l: 'Markt-Sentiment',   fallback: 'sentiment' },
      { k: 'price_momentum',   l: 'Price Momentum',    fallback: 'sentiment' },
    ];
    return `<div class="flex flex-wrap justify-around gap-2">
      ${dims.map(({ k, l, fallback }) => {
        const s = sc[k] ?? (fallback ? sc[fallback] : null);
        const bdKey = (sc[k] !== undefined && sc[k] !== null) ? k : (fallback || k);
        const bd = breakdown?.[bdKey];
        const ai = !!bd?.ai_estimated;
        const conf = ai ? confidenceLabel(bd.ai_confidence).label : null;
        const title = ai && bd.ai_reasoning ? `KI-geschätzt (Konfidenz ${conf}): ${bd.ai_reasoning}` : null;
        return ringSvg(s, l, scoreColor(s), { aiEstimated: ai, confidenceLabel: conf, title });
      }).join('')}
    </div>`;
  }

  // Issue 18: Übersichts-Banner über der Scorecard, falls KI-Fallback aktiv war.
  function renderScorecardAIFallbackSummary(state) {
    const af = state.score?.ai_fallback;
    if (!af || !Array.isArray(af.applied_dims) || !af.applied_dims.length) {
      // Falls KI versucht wurde, aber gescheitert ist → Hinweis zeigen.
      if (af?.attempted && af?.error) {
        return `<div class="rounded-md border border-accent-warm/40 bg-accent-warm/5 p-2.5 mb-3 text-xs text-ink-200">
          <strong class="text-accent-warm">KI-Fallback fehlgeschlagen:</strong> ${escapeHtml(af.error)}.
          Fehlende Dimensionen werden als „—" angezeigt.
        </div>`;
      }
      return '';
    }
    const labels = { quality: 'Qualität', growth: 'Wachstum', valuation: 'Bewertung', moat: 'Burggraben', risk: 'Risiko', sentiment: 'Sentiment' };
    const list = af.applied_dims.map(k => `<span class="chip chip-medium">${escapeHtml(labels[k] || k)}</span>`).join(' ');
    return `<div class="rounded-md border border-accent-info/40 bg-accent-info/5 p-3 mb-3 text-sm">
      <div class="flex items-start gap-2 flex-wrap">
        <span class="text-accent-info text-base leading-none">🤖</span>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-ink-100 mb-1">KI-geschätzte Dimensionen (Issue 18)</div>
          <p class="text-xs text-ink-200 leading-relaxed mb-1.5">
            Für diese Dimensionen lagen keine ausreichenden Fundamentaldaten vor. DeepSeek V4 hat sie aus dem verfügbaren Kontext (Kursverlauf, News, Analystenkonsens, Branche, Tiefenanalyse) plausibel geschätzt — siehe Details unten.
          </p>
          <div class="flex flex-wrap gap-1 mb-0.5">${list}</div>
        </div>
      </div>
    </div>`;
  }

  function chartRangeLabel(history) {
    if (!history || !history.length) return '5 Jahre';
    const first = new Date(history[0].date);
    const last = new Date(history[history.length - 1].date);
    const years = (last - first) / (365.25 * 86400000);
    if (years >= 4.5) return '5 Jahre';
    if (years >= 1.2) return `${years.toFixed(1)} Jahre (max verfügbar)`;
    const months = (last - first) / (30.4 * 86400000);
    return `${Math.round(months)} Monate (max verfügbar)`;
  }

  function drawPriceChart(history, currency) {
    const c = document.getElementById('price-chart');
    if (!c) return;
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (!history || !history.length) {
      // Platzhalter ins Canvas zeichnen, statt nichts anzuzeigen
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#5a6378';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Keine historischen Kursdaten verfügbar', c.width / 2, c.height / 2);
      return;
    }
    const labels = history.map(h => h.date.slice(0, 10));
    const closes = history.map(h => h.close);
    const first = closes[0];
    const last = closes[closes.length - 1];
    const up = last >= first;
    // Issue 14: Bright Mode bekommt etwas dunklere Linienfarben für Kontrast.
    const isLight = (document.documentElement.getAttribute('data-theme') !== 'dark');
    const color = up
      ? (isLight ? 'rgba(5, 150, 105, 1)' : 'rgba(110, 231, 183, 1)')
      : (isLight ? 'rgba(220, 38, 38, 1)' : 'rgba(248, 113, 113, 1)');
    const fill = up
      ? (isLight ? 'rgba(16, 185, 129, 0.14)' : 'rgba(110, 231, 183, 0.12)')
      : (isLight ? 'rgba(220, 38, 38, 0.10)' : 'rgba(248, 113, 113, 0.12)');
    const tickColor = isLight ? '#64748b' : '#5a6378';
    const gridColor = isLight ? 'rgba(148, 163, 184, 0.20)' : 'rgba(58,66,86,0.2)';
    const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'JPY' ? '¥' : '$';
    priceChart = new Chart(c, {
      type: 'line',
      data: {
        labels,
        datasets: [{ data: closes, borderColor: color, backgroundColor: fill, fill: true, tension: 0.2, pointRadius: 0, borderWidth: 1.5 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // Container hat aspect-ratio 3/2 via CSS
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: { label: ctx => sym + Number(ctx.parsed.y).toLocaleString('de-DE', { maximumFractionDigits: 2 }) }
          }
        },
        scales: {
          x: { ticks: { color: tickColor, maxTicksLimit: 6, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: tickColor, font: { size: 10 }, callback: v => Number(v).toFixed(0) }, grid: { color: gridColor } },
        },
      }
    });
  }

  function paintFundamentals(state) {
    const f = state.fundamentals?.fundamentals || {};
    const d = state.fundamentals?.derived || {};
    const empty = !Object.values(f).some(x => x && x.fy && x.fy.length);

    if (empty) {
      $('#tab-fundamental').innerHTML = `
        <div class="card mb-4">
          <p class="text-ink-300">Keine SEC-Fundamentaldaten verfügbar (vermutlich kein US-Listing oder gerade nicht eingereicht). yfinance liefert nur Basiswerte.</p>
        </div>
        ${renderWebOverview(state.webOverview, 'Websuche-Fallback — Basisdaten aus dem Web')}`;
      return;
    }

    const fyYears = (f.revenue?.fy || []).slice(0, 5).map(r => r.fy).reverse();
    const revSeries = (f.revenue?.fy || []).slice(0, 5).map(r => r.val).reverse();
    const niSeries = (f.netIncome?.fy || []).slice(0, 5).map(r => r.val).reverse();
    const yx = state.yfExtra || {};
    const refFy = d.marginsRefFy ? ` (FY${d.marginsRefFy})` : '';

    $('#tab-fundamental').innerHTML = `
      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2>Wachstum</h2>
          <table class="data">
            <tbody>
              <tr><td>Umsatz 1J</td><td class="num ${(d.revenueGrowth1y ?? 0) > 0 ? 'pos' : 'neg'}">${fmt.pct(d.revenueGrowth1y)}</td></tr>
              <tr><td>Umsatz 3J</td><td class="num ${(d.revenueGrowth3y ?? 0) > 0 ? 'pos' : 'neg'}">${fmt.pct(d.revenueGrowth3y)}</td></tr>
              <tr><td>Umsatz 5J</td><td class="num ${(d.revenueGrowth5y ?? 0) > 0 ? 'pos' : 'neg'}">${fmt.pct(d.revenueGrowth5y)}</td></tr>
              <tr><td>EPS 1J</td><td class="num ${(d.epsGrowth1y ?? 0) > 0 ? 'pos' : 'neg'}">${fmt.pct(d.epsGrowth1y)}</td></tr>
              <tr><td>Nettogewinn 1J</td><td class="num ${(d.netIncomeGrowth1y ?? 0) > 0 ? 'pos' : 'neg'}">${fmt.pct(d.netIncomeGrowth1y)}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Profitabilität${refFy}</h2>
          <table class="data">
            <tbody>
              <tr><td>Bruttomarge</td><td class="num">${fmt.pct(d.grossMargin)}</td>${yx.grossMargins != null ? `<td class="num text-ink-300 text-xs pl-2">${fmt.pct(yx.grossMargins)} <span class="text-ink-400">TTM</span></td>` : ''}</tr>
              <tr><td>Operative Marge</td><td class="num">${fmt.pct(d.operatingMargin)}</td>${yx.operatingMargins != null ? `<td class="num text-ink-300 text-xs pl-2">${fmt.pct(yx.operatingMargins)} <span class="text-ink-400">TTM</span></td>` : ''}</tr>
              <tr><td>Nettomarge</td><td class="num">${fmt.pct(d.netMargin)}</td>${yx.profitMargins != null ? `<td class="num text-ink-300 text-xs pl-2">${fmt.pct(yx.profitMargins)} <span class="text-ink-400">TTM</span></td>` : ''}</tr>
              <tr><td>FCF-Marge</td><td class="num">${fmt.pct(d.fcfMargin)}</td><td></td></tr>
              <tr><td>ROE</td><td class="num">${fmt.pct(d.roe)}</td><td></td></tr>
              <tr><td>ROA</td><td class="num">${fmt.pct(d.roa)}</td><td></td></tr>
            </tbody>
          </table>
          ${yx.grossMargins != null ? '<p class="text-xs text-ink-300 mt-2">Linke Spalte: aus SEC-XBRL für ausgewiesenes FY. Rechte Spalte: yfinance-TTM (Plausi-Vergleich).</p>' : ''}
        </div>

        <div class="card">
          <h2>Bilanz</h2>
          <table class="data">
            <tbody>
              <tr><td>Aktiva</td><td class="num">${fmt.money(f.assets?.fy?.[0]?.val)}</td></tr>
              <tr><td>Eigenkapital</td><td class="num">${fmt.money(f.equity?.fy?.[0]?.val)}</td></tr>
              <tr><td>Verbindlichkeiten</td><td class="num">${fmt.money(f.liabilities?.fy?.[0]?.val)}</td></tr>
              <tr><td>Langfr. Schulden</td><td class="num">${fmt.money(f.longTermDebt?.fy?.[0]?.val)}</td></tr>
              <tr><td>Cash</td><td class="num">${fmt.money(f.cashAndEquivalents?.fy?.[0]?.val)}</td></tr>
              <tr><td>Debt/Equity</td><td class="num">${d.debtToEquity != null ? d.debtToEquity.toFixed(2) : '—'}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Cashflow</h2>
          <table class="data">
            <tbody>
              <tr><td>Operativer Cashflow</td><td class="num">${fmt.money(f.operatingCashFlow?.fy?.[0]?.val)}</td></tr>
              <tr><td>CapEx</td><td class="num">${fmt.money(f.capex?.fy?.[0]?.val)}</td></tr>
              <tr><td>Free Cash Flow</td><td class="num">${fmt.money(d.fcf)}</td></tr>
              <tr><td>Forschung &amp; Entwicklung</td><td class="num">${fmt.money(f.rd?.fy?.[0]?.val)}</td></tr>
              <tr><td>SG&amp;A</td><td class="num">${fmt.money(f.sgna?.fy?.[0]?.val)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Umsatz &amp; Nettogewinn — letzte 5 Geschäftsjahre</h2>
        ${renderBarSeries(fyYears, revSeries, niSeries)}
      </div>

      <div class="card mt-4">
        <h2>Datenherkunft</h2>
        <p class="text-xs text-ink-300">SEC EDGAR XBRL (us-gaap-Taxonomie) — automatische Konzept-Auflösung pro Firma. Letzte Filings:</p>
        <ul class="text-xs text-ink-200 mt-2 space-y-1">
          ${Object.entries(f).filter(([k, v]) => v && v.fy?.length).slice(0, 10).map(([k, v]) =>
            `<li><span class="text-ink-300">${escapeHtml(k)}:</span> ${escapeHtml(v.concept)} (FY${v.fy[0].fy} filed ${escapeHtml(v.fy[0].filed)})</li>`
          ).join('')}
        </ul>
      </div>
    `;
  }

  function renderWebOverview(wo, title) {
    if (!wo) return '';
    const ex = wo.extracted;
    const results = wo.results || [];
    const rows = [];
    if (ex) {
      const add = (label, val) => { if (val !== null && val !== undefined && val !== '') rows.push([label, val]); };
      add('Firma', ex.longName);
      add('Börse', ex.exchange);
      add('Sektor', ex.sector);
      add('Industrie', ex.industry);
      add('Kurs', ex.price ? (ex.currency ? ex.currency + ' ' : '') + ex.price : null);
      add('Marktkap.', ex.market_cap ? fmt.money(ex.market_cap, ex.currency || 'USD') : null);
      add('Umsatz (TTM)', ex.revenue_ttm ? fmt.money(ex.revenue_ttm, ex.currency || 'USD') : null);
      add('Nettogewinn (TTM)', ex.net_income_ttm ? fmt.money(ex.net_income_ttm, ex.currency || 'USD') : null);
      add('KGV', ex.pe);
      add('Vertrauen', ex.confidence);
    }
    const extractedTable = rows.length ? `
      <table class="data mb-4">
        <tbody>
          ${rows.map(([l, v]) => `<tr><td>${escapeHtml(l)}</td><td class="num">${escapeHtml(String(v))}</td></tr>`).join('')}
        </tbody>
      </table>
      ${ex?.summary ? `<p class="text-sm text-ink-200 leading-relaxed mb-3">${escapeHtml(ex.summary)}</p>` : ''}
    ` : '';

    return `
      <div class="card">
        <h2>${escapeHtml(title)}</h2>
        ${extractedTable}
        <div class="text-xs text-ink-300 mb-2">Quellen aus Websuche (${results.length})</div>
        <ul class="space-y-2 text-sm">
          ${results.slice(0, 6).map(r => `
            <li class="border-l-2 border-ink-500 pl-3 py-0.5">
              <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="block group">
                <div class="text-ink-100 group-hover:text-accent transition">${escapeHtml(r.title)}</div>
                <div class="text-xs text-ink-300 mt-0.5">${escapeHtml(r.snippet || '')}</div>
                <div class="text-xs text-ink-400 mt-0.5 font-mono">${escapeHtml(safeHostname(r.url))}</div>
              </a>
            </li>`).join('')}
        </ul>
        <p class="text-xs text-ink-300 mt-3">⚠ Aus Webtexten extrahiert — kann veraltet/ungenau sein. KI-Vertrauen siehe oben.</p>
      </div>`;
  }

  function safeHostname(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function renderBarSeries(years, revs, nis) {
    if (!years.length) return '<p class="text-ink-300 text-sm">Keine Daten</p>';
    const max = Math.max(...revs, ...nis.map(Math.abs));
    const rows = years.map((y, i) => {
      const r = revs[i] || 0, n = nis[i] || 0;
      return `
        <div class="grid grid-cols-[3rem_1fr_5rem_1fr_5rem] items-center gap-3 my-1.5 text-xs">
          <span class="font-mono text-ink-300">${y}</span>
          <div class="bar"><div style="width: ${(r / max) * 100}%; background: linear-gradient(90deg, #34d399, #6ee7b7)"></div></div>
          <span class="font-mono text-right">${fmt.money(r)}</span>
          <div class="bar"><div style="width: ${Math.abs(n) / max * 100}%; background: ${n < 0 ? 'linear-gradient(90deg, #ef4444, #fca5a5)' : 'linear-gradient(90deg, #60a5fa, #93c5fd)'}"></div></div>
          <span class="font-mono text-right ${n < 0 ? 'neg' : ''}">${fmt.money(n)}</span>
        </div>`;
    }).join('');
    return `
      <div class="grid grid-cols-[3rem_1fr_5rem_1fr_5rem] gap-3 text-xs text-ink-300 mb-1 uppercase tracking-wider">
        <span></span><span>Umsatz</span><span class="text-right"></span><span>Nettogewinn</span><span class="text-right"></span>
      </div>
      ${rows}`;
  }

  function paintValuation(state) {
    const f = state.fundamentals?.fundamentals || {};
    const d = state.fundamentals?.derived || {};
    const info = state.quote?.info || {};
    const yx = state.yfExtra || {};
    const ttmNi = f.netIncome?.ttm;
    const pe = info.market_cap && ttmNi ? info.market_cap / ttmNi : null;
    const ttmRev = f.revenue?.ttm;
    const psRatio = info.market_cap && ttmRev ? info.market_cap / ttmRev : null;
    const peGrowth = pe && d.revenueGrowth1y ? pe / (d.revenueGrowth1y * 100) : null;
    const fcf = d.fcf;
    const evToFCF = info.market_cap && fcf ? info.market_cap / fcf : null;

    // Forward-Werte aus yfinance — Analystenschätzungen für das nächste FY
    const forwardPE = safeNum(yx.forwardPE);
    const forwardEps = safeNum(yx.forwardEps);
    const trailingPE = safeNum(yx.trailingPE);
    const trailingEps = safeNum(yx.trailingEps);
    const peg = safeNum(yx.pegRatio);

    $('#tab-bewertung').innerHTML = `
      <div class="grid md:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2>Multiples</h2>
          <table class="data">
            <tbody>
              <tr><td>KGV (TTM, SEC-basiert)</td><td class="num">${fmt.num(pe, 1)}</td></tr>
              <tr><td>KGV (TTM, yfinance)</td><td class="num">${fmt.num(trailingPE, 1)}</td></tr>
              <tr><td><strong>Forward-KGV</strong></td><td class="num"><strong>${fmt.num(forwardPE, 1)}</strong></td></tr>
              <tr><td>EPS (TTM)</td><td class="num">${fmt.num(trailingEps, 2)}</td></tr>
              <tr><td><strong>Forward-EPS</strong></td><td class="num"><strong>${fmt.num(forwardEps, 2)}</strong></td></tr>
              <tr><td>PEG-Ratio (yfinance)</td><td class="num">${fmt.num(peg, 2)}</td></tr>
              <tr><td>Kurs-Umsatz (P/S, TTM)</td><td class="num">${fmt.num(psRatio, 2)}</td></tr>
              <tr><td>PEG (vereinfacht)</td><td class="num">${fmt.num(peGrowth, 2)}</td></tr>
              <tr><td>Marktkap. / FCF</td><td class="num">${fmt.num(evToFCF, 1)}</td></tr>
              <tr><td>52W-Range</td><td class="num">${fmt.num(info.year_low, 2)} – ${fmt.num(info.year_high, 2)}</td></tr>
            </tbody>
          </table>
          <p class="text-xs text-ink-300 mt-3">TTM = Trailing Twelve Months. Forward-KGV / -EPS sind Analysten-Schätzungen für das nächste Geschäftsjahr (Quelle: yfinance) — sie fließen in den Bewertungs-Score ein.</p>
        </div>

        <div class="card">
          <h2>KI-Einschätzung Bewertung</h2>
          <div id="valuation-comment" class="text-sm text-ink-200 leading-relaxed">
            ${state.analysis?.bewertung_kommentar ? escapeHtml(state.analysis.bewertung_kommentar) : '<span class="text-ink-300">Wird mit der KI-Analyse generiert <span class="spinner"></span></span>'}
          </div>
        </div>
      </div>

      ${renderFairValue(state.fairValue, info)}
      ${renderForecastValuationNote(state)}`;
  }

  // Issue 11: Kurzer Verweis vom Bewertungs-Tab auf den Prognose-Tab,
  // damit die KI-projizierten Kennzahlen sichtbar mit der TTM-Bewertung
  // verbunden sind. Wird nur gerendert, wenn die Prognose schon vorliegt.
  function renderForecastValuationNote(state) {
    const f = state.forecast;
    if (!f) return '';
    const kp = f.kurs_prognose_12m || {};
    const bi = f.bewertungs_implikation || {};
    const base = safeNum(kp.base?.kurs);
    const price = safeNum(state.quote?.info?.price);
    const upside = (base !== null && price) ? (base - price) / price : null;
    return `<div class="card mt-4" style="background: linear-gradient(180deg, rgba(110,231,183,0.04) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(110,231,183,0.25);">
      <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
        <div>
          <h2 class="!mb-1">KI-Prognose · Implikation für die Bewertung (Issue 11)</h2>
          <p class="text-xs text-ink-300">
            DeepSeek V4 projiziert auf 12 Monate ein Base-Kursziel ${base !== null ? `<span class="font-mono text-ink-100">${state.quote?.info?.currency === 'EUR' ? '€' : '$'}${fmt.num(base, 2)}</span>${upside !== null ? ` (${upside > 0 ? '+' : ''}${(upside * 100).toFixed(1)}% vs. Kurs)` : ''}` : '—'}.
          </p>
        </div>
        <a href="#" data-jump-tab="prognose" class="text-sm text-accent-info hover:underline">→ Volle Prognose</a>
      </div>
      ${bi.fair_value_adjustment ? `<div class="flex items-center gap-2 flex-wrap mb-2">
        <span class="text-xs text-ink-300 uppercase tracking-wider">Fair-Value-Adjustment:</span>
        ${fcOutlookChip(bi.fair_value_adjustment)}
      </div>` : ''}
      ${bi.begruendung ? `<p class="text-sm text-ink-100 leading-relaxed">${escapeHtml(bi.begruendung)}</p>` : ''}
    </div>`;
  }

  function renderFairValue(fv, info) {
    if (!fv) {
      return `<div class="card"><h2>Fairer Wert (mehrere Methoden)</h2>
        <div class="text-ink-300 text-sm">Berechnung läuft <span class="spinner"></span></div></div>`;
    }
    const sum = fv.summary;
    if (!sum) {
      return `<div class="card"><h2>Fairer Wert</h2>
        <p class="text-ink-300 text-sm">Für die Berechnung fehlen Fundamentaldaten (EPS, FCF oder Buchwert). Wenn der Ticker kein US-Listing hat, sind über SEC-XBRL keine Daten verfügbar.</p>
      </div>`;
    }
    const price = safeNum(info.price) ?? safeNum(fv.inputs?.price);
    const cur = info.currency || 'USD';
    const sym = cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'JPY' ? '¥' : '$';
    const fmtMoneyShare = v => v === null || v === undefined ? '—' : sym + Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 });

    const upsidePct = sum.upside;
    const upsideCls = upsidePct === null ? '' : upsidePct > 0.10 ? 'pos' : upsidePct < -0.10 ? 'neg' : '';
    const upsideStr = upsidePct === null ? '—' :
      ((upsidePct > 0 ? '+' : '') + (upsidePct * 100).toFixed(1) + '%');

    // Visualisierung: Kurs vs. Range
    let bar = '';
    if (price !== null && sum.low && sum.high) {
      const lo = Math.min(sum.low, price);
      const hi = Math.max(sum.high, price);
      const span = hi - lo || 1;
      const pricePct = ((price - lo) / span) * 100;
      const medianPct = ((sum.median - lo) / span) * 100;
      const rangeLo = ((sum.low - lo) / span) * 100;
      const rangeHi = ((sum.high - lo) / span) * 100;
      bar = `
        <div class="fv-bar relative mt-4 mb-2 h-10">
          <div class="absolute inset-y-3 left-0 right-0 rounded-full bg-ink-600/60"></div>
          <div class="absolute inset-y-3 rounded-full" style="left:${rangeLo}%; right:${100 - rangeHi}%; background: linear-gradient(90deg, rgba(96,165,250,0.5), rgba(110,231,183,0.5));"></div>
          <div class="absolute top-0 bottom-0 flex items-center" style="left:calc(${medianPct}% - 0.5rem)">
            <span class="w-3 h-3 rounded-full bg-accent-info border border-accent-info/60 shadow"></span>
          </div>
          <div class="absolute top-0 bottom-0 flex items-center" style="left:calc(${pricePct}% - 0.5rem)">
            <span class="w-3 h-3 rounded-sm bg-accent border-2 border-ink-900 shadow"></span>
          </div>
          <div class="absolute -bottom-1 text-[10px] font-mono text-ink-300" style="left:0">${fmtMoneyShare(sum.low)}</div>
          <div class="absolute -bottom-1 text-[10px] font-mono text-ink-300" style="right:0">${fmtMoneyShare(sum.high)}</div>
        </div>
        <div class="flex gap-5 text-xs text-ink-300 mt-3 flex-wrap">
          <span><span class="inline-block w-2.5 h-2.5 rounded-sm bg-accent align-middle mr-1.5"></span>Aktueller Kurs: <span class="font-mono text-ink-100">${fmtMoneyShare(price)}</span></span>
          <span><span class="inline-block w-2.5 h-2.5 rounded-full bg-accent-info align-middle mr-1.5"></span>Median fairer Wert: <span class="font-mono text-ink-100">${fmtMoneyShare(sum.median)}</span></span>
        </div>`;
    }

    const methodsRows = fv.methods.map(m => `
      <tr>
        <td>${escapeHtml(m.label)}</td>
        <td class="num">${fmtMoneyShare(m.value)}</td>
        <td class="text-xs text-ink-300">${escapeHtml(m.details)}</td>
      </tr>`).join('');

    return `
      <div class="card">
        <div class="flex items-start justify-between gap-4 flex-wrap mb-1">
          <div>
            <h2 class="!mb-1">Fairer Wert (mehrere Methoden)</h2>
            <p class="text-xs text-ink-300">Aus Fundamentaldaten + Marktkapitalisierung. Keine Anlageempfehlung — die Spanne zeigt nur, wo verschiedene Modelle landen.</p>
          </div>
          <div class="text-right">
            <div class="text-xs uppercase tracking-wider text-ink-300">Spanne ${sum.methods_count} Methoden</div>
            <div class="text-2xl font-bold font-mono">${fmtMoneyShare(sum.low)} – ${fmtMoneyShare(sum.high)}</div>
            <div class="text-sm font-mono">Median: <span class="text-ink-100">${fmtMoneyShare(sum.median)}</span> &middot; vs. Kurs: <span class="font-semibold ${upsideCls}">${upsideStr}</span></div>
          </div>
        </div>
        ${bar}
        <table class="data mt-4">
          <thead>
            <tr><th>Methode</th><th class="num">Fairer Wert / Aktie</th><th>Annahmen</th></tr>
          </thead>
          <tbody>${methodsRows}</tbody>
        </table>
        <div class="text-xs text-ink-300 mt-3 leading-relaxed">
          <strong class="text-ink-200">Inputs:</strong>
          EPS (TTM/FY): ${fmtMoneyShare(fv.inputs.eps_ttm)} ·
          BVPS: ${fmtMoneyShare(fv.inputs.bvps)} ·
          Wachstum (geclippt): ${fv.inputs.growth_used !== null ? (fv.inputs.growth_used * 100).toFixed(1) + '%' : '—'} ·
          Aktien: ${fv.inputs.shares ? Number(fv.inputs.shares).toLocaleString('de-DE') : '—'}
        </div>
      </div>`;
  }

  function paintPeers(state) {
    const peers = state.peers || [];
    const info = state.quote?.info || {};
    const pm = state.peerMatrix;

    const rows = peers.map(p => {
      const i = p.info || {};
      const change = i.price && i.previous_close ? (i.price - i.previous_close) / i.previous_close : null;
      return `<tr>
        <td><a href="#" class="text-accent font-mono" data-peer="${escapeHtml(p.ticker)}">${escapeHtml(p.ticker)}</a></td>
        <td class="num">${fmt.num(i.price, 2)} ${escapeHtml(i.currency || '')}</td>
        <td class="num ${change > 0 ? 'pos' : change < 0 ? 'neg' : ''}">${change !== null ? (change > 0 ? '+' : '') + fmt.pct(change) : '—'}</td>
        <td class="num">${fmt.money(i.market_cap, i.currency)}</td>
        <td class="num">${escapeHtml(i.exchange || '—')}</td>
      </tr>`;
    }).join('');

    // Highlight current
    const myI = info;
    const myChange = myI.price && myI.previous_close ? (myI.price - myI.previous_close) / myI.previous_close : null;
    const myRow = `<tr style="background: rgba(110,231,183,0.06)">
      <td><span class="font-mono text-accent">${escapeHtml(state.ticker)} ★</span></td>
      <td class="num">${fmt.num(myI.price, 2)} ${escapeHtml(myI.currency || '')}</td>
      <td class="num ${myChange > 0 ? 'pos' : myChange < 0 ? 'neg' : ''}">${myChange !== null ? (myChange > 0 ? '+' : '') + fmt.pct(myChange) : '—'}</td>
      <td class="num">${fmt.money(myI.market_cap, myI.currency)}</td>
      <td class="num">${escapeHtml(myI.exchange || '—')}</td>
    </tr>`;

    // Issue 9: Quantitative Peer-Matrix mit Perzentilen
    const matrixHtml = renderPeerMatrix(state, pm);

    $('#tab-peers').innerHTML = `
      <div class="card">
        <h2>Peer-Vergleich (Übersicht)</h2>
        <p class="text-xs text-ink-300 mb-3">Peer-Liste aus KI-Vorschlag, Quotes via yfinance. Klick auf einen Ticker öffnet die Analyse für den Peer.</p>
        <table class="data">
          <thead><tr><th>Ticker</th><th class="num">Kurs</th><th class="num">Δ Tag</th><th class="num">Marktkap.</th><th class="num">Börse</th></tr></thead>
          <tbody>${myRow}${rows}</tbody>
        </table>
      </div>
      ${matrixHtml}`;

    $$('#tab-peers a[data-peer]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const t = a.dataset.peer;
      searchEl.value = t;
      loadTicker(t);
    }));
  }

  // Issue 9: Quantitative Peer-Matrix mit Perzentilen pro Kennzahl
  function renderPeerMatrix(state, pm) {
    if (!pm) {
      if (state.peers?.length) {
        return `<div class="card mt-4">
          <h2>Peer-Matrix (Perzentile)</h2>
          <div class="text-ink-300 text-sm">Lade Peer-Kennzahlen <span class="spinner"></span></div>
        </div>`;
      }
      return '';
    }
    if (!pm.rows?.length || pm.note) {
      return `<div class="card mt-4">
        <h2>Peer-Matrix (Perzentile)</h2>
        <p class="text-ink-300 text-sm">${escapeHtml(pm.note === 'no-data' ? 'Keine Peer-Daten geladen.' : 'Mindestens 2 Peers nötig.')}</p>
      </div>`;
    }
    const spec = pm.metric_spec || {};
    const metricKeys = Object.keys(spec);
    const headerCells = metricKeys.map(k => {
      const s = spec[k];
      const dir = s.higher_is_better ? '↑' : '↓';
      return `<th class="num text-xs" title="${escapeHtml(k)} (${s.higher_is_better ? 'höher = besser' : 'niedriger = besser'})">${escapeHtml(s.label)} ${dir}</th>`;
    }).join('');

    const fmtMetric = (v, format) => {
      if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
      if (format === 'pct') return (Number(v) * 100).toFixed(1) + '%';
      return Number(v).toFixed(2);
    };
    const pColor = p => {
      if (p === null || p === undefined) return '#5a6378';
      if (p >= 75) return '#6ee7b7';
      if (p >= 50) return '#60a5fa';
      if (p >= 25) return '#fbbf24';
      return '#f87171';
    };

    // Issue 19: Validierungs-Status pro Datenpunkt anzeigen (OK / auffällig /
    // fehlend) plus Quelle + Datenstand als Tooltip.
    const validationGlyph = (st) => {
      if (!st) return '';
      if (st.status === 'auffaellig') return '<span class="text-accent-warm font-bold" style="font-size:11px" title="auffälliger Datenpunkt">⚠</span>';
      if (st.status === 'fehlend') return '<span class="text-ink-400" title="Wert fehlt" style="font-size:11px">∅</span>';
      return '<span class="text-pos" title="Plausibel im Peer-Median-Bereich" style="font-size:9px; opacity:0.65">●</span>';
    };
    const fmtTs = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const rowHtml = (r) => {
      const isMain = r.ticker === state.ticker;
      const cells = metricKeys.map(k => {
        const v = r.metrics?.[k];
        const p = r.percentiles?.[k];
        const val = r.validation?.[k];
        const glyph = validationGlyph(val);
        const tooltip = val
          ? `Quelle: ${val.source || 'yfinance'} · Stand: ${fmtTs(val.fetched_at)} · Status: ${val.status === 'auffaellig' ? 'auffällig — gegen zweite Quelle prüfen' : val.status === 'fehlend' ? 'fehlend' : 'OK'}${val.note ? ' · ' + val.note : ''}`
          : '';
        const cellWarn = val?.status === 'auffaellig'
          ? 'background: rgba(245,158,11,0.10); border-radius: 3px;'
          : '';
        return `<td class="num" title="${escapeHtml(tooltip)}" style="${cellWarn}">
          <div class="flex items-center justify-end gap-1.5">
            <span class="text-xs font-mono">${fmtMetric(v, spec[k].format)}</span>
            ${glyph}
          </div>
          ${p !== null && p !== undefined ? `<div class="text-[10px]" style="color:${pColor(p)}">P${p}</div>` : '<div class="text-[10px] text-ink-400">—</div>'}
        </td>`;
      }).join('');
      const rowStyle = isMain ? 'style="background: rgba(110,231,183,0.06); font-weight:500"' : '';
      return `<tr ${rowStyle}>
        <td><a href="#" class="text-accent font-mono text-sm" data-peer="${escapeHtml(r.ticker)}">${escapeHtml(r.ticker)}${isMain ? ' ★' : ''}</a>
          <div class="text-[10px] text-ink-400 truncate" style="max-width:140px">${escapeHtml(r.info?.longName || '')}</div>
        </td>
        ${cells}
      </tr>`;
    };

    // Aggregierte Status-Übersicht für die Card-Header
    const flagCount = (status) => pm.rows.reduce((acc, row) => {
      if (!row.validation) return acc;
      return acc + Object.values(row.validation).filter(v => v && v.status === status).length;
    }, 0);
    const okCount = flagCount('ok');
    const warnCount = flagCount('auffaellig');
    const missCount = flagCount('fehlend');

    const mainRow = pm.rows.find(r => r.ticker === state.ticker);
    const otherRows = pm.rows.filter(r => r.ticker !== state.ticker);

    // Aggregat-Score: Median des Perzentil-Vektors des Haupt-Tickers
    let mainAggregate = null;
    if (mainRow?.percentiles) {
      const ps = Object.values(mainRow.percentiles).filter(p => p !== null && p !== undefined);
      if (ps.length) {
        const sorted = [...ps].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        mainAggregate = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
      }
    }

    return `<div class="card mt-4">
      <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
        <div>
          <h2 class="!mb-1">Peer-Matrix mit Perzentilen (Issue 9 + Validierung Issue 19)</h2>
          <p class="text-xs text-ink-300">
            Für jede Kennzahl: <span class="font-mono">P</span>-Wert zeigt das Perzentil innerhalb der Peer-Gruppe (P50 = Median, höher = besser auf der Skala).
            Datenpunkte mit <span class="text-accent-warm">⚠</span> weichen stark vom Peer-Median ab — gegen zweite Quelle prüfen.
          </p>
        </div>
        <div class="flex flex-wrap gap-1.5 items-center">
          ${mainAggregate !== null ? `<span class="chip ${mainAggregate >= 60 ? 'chip-strong' : mainAggregate >= 40 ? 'chip-medium' : 'chip-weak'}">Aggregat: P${mainAggregate}</span>` : ''}
          <span class="chip chip-strong" title="Plausible Datenpunkte (im Peer-Median-Bereich)">${okCount} OK</span>
          ${warnCount > 0 ? `<span class="chip chip-medium" title="Auffällige Werte (Ausreißer vom Peer-Median)">⚠ ${warnCount} auffällig</span>` : ''}
          ${missCount > 0 ? `<span class="chip chip-weak" title="Werte, die yfinance nicht geliefert hat">∅ ${missCount} fehlend</span>` : ''}
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="data">
          <thead><tr>
            <th>Ticker</th>
            ${headerCells}
          </tr></thead>
          <tbody>
            ${mainRow ? rowHtml(mainRow) : ''}
            ${otherRows.map(rowHtml).join('')}
          </tbody>
        </table>
      </div>
      ${warnCount > 0 ? `<div class="estimate-note mt-3">
        <strong class="text-accent-warm">⚠ ${warnCount} auffällige Peer-Datenpunkt${warnCount === 1 ? '' : 'e'}</strong> — der Wert weicht um mehr als 3.5× MAD vom Peer-Median ab. yfinance liefert für Non-US-Listings, ETFs oder bei thin trading gelegentlich verzerrte Werte. <strong>Bitte gegen eine zweite Quelle prüfen</strong> (z.B. SEC EDGAR, Finanzbericht der Firma).
      </div>` : ''}
      <div class="text-xs text-ink-300 mt-3 leading-snug">
        <span class="font-mono text-pos">P75+ = Top-Quartil</span> ·
        <span class="font-mono text-accent-info">P50-75 = Über-Mittelfeld</span> ·
        <span class="font-mono" style="color:#fbbf24">P25-50 = Unter-Mittelfeld</span> ·
        <span class="font-mono text-neg">P0-25 = Unteres Quartil</span>.
        Pfeil ↑ = höhere Werte sind besser, ↓ = niedrigere sind besser.<br>
        <strong>Quelle:</strong> ${escapeHtml(pm.data_source || 'yfinance')} (TTM-basiert, kann von SEC-XBRL leicht abweichen) ·
        <strong>Stand:</strong> ${escapeHtml(fmtTs(pm.fetched_at))} ·
        <strong>Validierung:</strong> Median + MAD über alle Peers; Schwelle |z|>3.5.
      </div>
    </div>`;
  }

  function paintNews6mSkeleton(state) {
    // Erster Aufruf – malt nur, wenn der News-Tab noch leer ist
    const tab = $('#tab-news');
    if (!tab) return;
    if (!tab.querySelector('.news6m-card')) {
      const sk = el('div', {
        class: 'card news6m-card mb-4',
        html: `<h2>6-Monats-News · Zusammenfassung &amp; Sentiment</h2>
          <div class="text-ink-300 text-sm">DDG-Suche &amp; DeepSeek-Auswertung laufen <span class="spinner"></span></div>`
      });
      tab.prepend(sk);
    }
  }

  function sentimentChip(s) {
    if (!s) return '';
    const score = Number(s.score);
    let label = String(s.label || '').toLowerCase();
    // Issue 19: "positiv" nur ab >60/100. Wenn das LLM "positiv" liefert,
    // der Score aber niedrig ist, mappen wir auf "gemischt" oder "vorsichtig
    // positiv", damit Sub-Label und numerischer Score nicht widersprechen.
    // s.score kann je nach Pfad eine 0-100-Skala (News-Sentiment-Score) oder
    // ein −100/+100-Sentiment-Index sein. Wenn |score|<=1 vorhanden, gehen
    // wir von einer 0-100-Skala aus.
    if (Number.isFinite(score)) {
      const sc100 = (Math.abs(score) > 1) ? score : score * 100;
      if (sc100 > 75) label = 'sehr-positiv';
      else if (sc100 > 60) label = 'positiv';
      else if (sc100 > 50) label = 'vorsichtig-positiv';
      else if (sc100 >= 40) label = 'gemischt';
      else if (sc100 >= 25) label = 'vorsichtig-negativ';
      else label = 'negativ';
    }
    const lbl = ({
      'sehr-positiv': 'Sehr positiv', 'positiv': 'Positiv',
      'vorsichtig-positiv': 'Vorsichtig positiv',
      'gemischt': 'Gemischt',
      'neutral': 'Neutral',
      'vorsichtig-negativ': 'Vorsichtig negativ',
      'negativ': 'Negativ', 'sehr-negativ': 'Sehr negativ',
    })[label] || (s.label || '—');
    const cls = (label === 'sehr-positiv' || label === 'positiv') ? 'chip-strong'
      : (label === 'vorsichtig-positiv') ? 'chip-medium'
      : (label === 'gemischt' || label === 'neutral') ? 'chip-medium'
      : 'chip-weak';
    const arrow = score > 30 ? '↗' : score < -30 ? '↘' : '→';
    return `<span class="chip ${cls}" title="Issue 19: Label leitet sich aus dem Sub-Score ab (>60/100 = positiv).">${arrow} ${lbl} (${Number.isFinite(score) ? (score > 0 ? '+' : '') + score : '—'})</span>`;
  }

  function tendenzChip(t) {
    const v = String(t || '').toLowerCase();
    const map = {
      'positiv': ['chip-strong', '↗ positiv'],
      'negativ': ['chip-weak', '↘ negativ'],
      'neutral': ['chip-medium', '→ neutral'],
    };
    const [cls, lbl] = map[v] || ['chip-medium', escapeHtml(t || '—')];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function renderNews6mBlock(state) {
    const n6 = state.news6m;
    if (!n6) {
      return `<div class="card news6m-card mb-4">
        <h2>6-Monats-News · Zusammenfassung &amp; Sentiment</h2>
        <div class="text-ink-300 text-sm">Lädt <span class="spinner"></span></div>
      </div>`;
    }
    if (n6.error) {
      return `<div class="card news6m-card mb-4">
        <h2>6-Monats-News · Zusammenfassung &amp; Sentiment</h2>
        <p class="text-accent-bad text-sm">Suche fehlgeschlagen: ${escapeHtml(n6.error)}</p>
      </div>`;
    }
    const ai = n6.ai;
    const results = n6.results || [];

    const themes = (ai?.top_themen || []).map(t => {
      const idxs = Array.isArray(t.quellen) ? t.quellen : [];
      const refs = idxs.slice(0, 4).map(i => {
        const r = results[i - 1];
        return r ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="text-accent-info hover:underline text-[10px]">[${i}]</a>` : '';
      }).join(' ');
      return `<div class="rounded-md border border-ink-600 p-3 bg-ink-800/30">
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <span class="text-sm font-medium text-ink-100">${escapeHtml(t.thema || '—')}</span>
          ${tendenzChip(t.tendenz)}
        </div>
        <p class="text-xs text-ink-200 leading-relaxed mb-1.5">${escapeHtml(t.details || '')}</p>
        <div class="text-[10px] text-ink-300">${refs || ''}</div>
      </div>`;
    }).join('');

    const events = (ai?.wichtige_ereignisse || []).map(e => {
      const r = results[Number(e.quelle_index) - 1];
      const a = String(e.auswirkung || '').toLowerCase();
      const aChip = a === 'positiv' ? 'chip-strong' : a === 'negativ' ? 'chip-weak' : 'chip-medium';
      return `<li class="flex gap-2 text-sm items-start">
        <span class="text-ink-300 text-xs font-mono whitespace-nowrap mt-0.5">${escapeHtml(e.datum_kontext || '—')}</span>
        <span class="flex-1">
          ${escapeHtml(e.ereignis || '—')}
          ${r ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="text-accent-info hover:underline ml-1 text-[10px]">[${e.quelle_index}]</a>` : ''}
        </span>
        <span class="chip ${aChip}">${escapeHtml(e.auswirkung || '—')}</span>
      </li>`;
    }).join('');

    return `<div class="card news6m-card mb-4">
      <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
        <h2 class="!mb-0">6-Monats-News · Zusammenfassung &amp; Sentiment</h2>
        <div class="flex flex-wrap gap-1.5">${sentimentChip(ai?.sentiment)}</div>
      </div>
      ${ai?.summary ? `<p class="text-sm text-ink-100 leading-relaxed mb-3">${escapeHtml(ai.summary)}</p>` : ''}
      ${ai?.sentiment?.begruendung ? `<p class="text-xs text-ink-300 mb-4">${escapeHtml(ai.sentiment.begruendung)}</p>` : ''}

      ${themes ? `<div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Top-Themen</div>
        <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">${themes}</div>` : ''}

      ${events ? `<div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Wichtige Ereignisse</div>
        <ul class="space-y-1.5 mb-3">${events}</ul>` : ''}

      <div class="text-xs text-ink-300 mt-2">
        ${results.length} News-Treffer aus ${n6.queries?.length || '?'} Queries · Quellen unten (nummeriert).
      </div>
    </div>`;
  }

  function paintNews(state) {
    const news = state.news || [];
    const news6mBlock = renderNews6mBlock(state);

    const results6m = state.news6m?.results || [];
    const list6mHtml = results6m.length ? `
      <div class="card mb-4">
        <h2>News-Quellen (6 Monate · ${results6m.length})</h2>
        <ul class="space-y-2">
          ${results6m.map((n, i) => `
            <li class="border-l-2 border-ink-500 hover:border-accent pl-4 py-1 transition">
              <a href="${escapeHtml(n.url)}" target="_blank" rel="noopener" class="block group">
                <div class="font-medium text-ink-100 group-hover:text-accent transition">
                  <span class="text-ink-300 text-xs font-mono mr-1.5">[${i + 1}]</span>${escapeHtml(n.title)}
                </div>
                <div class="text-sm text-ink-300 mt-1">${escapeHtml(n.snippet || '')}</div>
                <div class="text-xs text-ink-400 mt-1 font-mono">${escapeHtml(safeHostname(n.url))}</div>
              </a>
            </li>`).join('')}
        </ul>
      </div>` : '';

    const list30dHtml = news.length ? `
      <div class="card">
        <h2>News der letzten 30 Tage (${news.length})</h2>
        <ul class="space-y-3">
          ${news.map(n => `
            <li class="border-l-2 border-ink-500 hover:border-accent pl-4 py-1 transition">
              <a href="${escapeHtml(n.url)}" target="_blank" rel="noopener" class="block group">
                <div class="font-medium text-ink-100 group-hover:text-accent transition">${escapeHtml(n.title)}</div>
                <div class="text-sm text-ink-300 mt-1">${escapeHtml(n.snippet || '')}</div>
                <div class="text-xs text-ink-300 mt-1 font-mono">${escapeHtml(safeHostname(n.url))}</div>
              </a>
            </li>`).join('')}
        </ul>
      </div>` : '';

    if (!news.length && !state.news6m) {
      $('#tab-news').innerHTML = `<div class="card"><p class="text-ink-300">Keine aktuellen News gefunden.</p></div>`;
      return;
    }

    $('#tab-news').innerHTML = `${news6mBlock}${list6mHtml}${list30dHtml}`;
  }

  function paintFilings(state) {
    const list = state.filings || [];
    if (!list.length) {
      $('#tab-sec').innerHTML = `<div class="card"><p class="text-ink-300">Keine SEC-Filings verfügbar (Ticker hat vermutlich kein US-Listing).</p></div>`;
      return;
    }
    $('#tab-sec').innerHTML = `
      <div class="card">
        <h2>SEC-Filings (${list.length})</h2>
        <table class="data">
          <thead><tr><th>Form</th><th>Eingereicht</th><th>Berichtsstichtag</th><th>Dokument</th></tr></thead>
          <tbody>
            ${list.map(f => `<tr>
              <td><span class="font-mono text-accent">${escapeHtml(f.form)}</span></td>
              <td>${fmt.date(f.date)}</td>
              <td>${fmt.date(f.report_date)}</td>
              <td><a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" class="text-accent-info hover:underline">${escapeHtml(f.primary_document || 'Öffnen')}</a></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function strengthChip(s) {
    const cls = ({ 'sehr-stark': 'chip-very-strong', 'stark': 'chip-strong', 'mittel': 'chip-medium', 'schwach': 'chip-weak' })[s] || 'chip-medium';
    const lbl = ({ 'sehr-stark': 'Sehr stark', 'stark': 'Stark', 'mittel': 'Mittel', 'schwach': 'Schwach' })[s] || (s || '—');
    return `<span class="chip ${cls}">${lbl}</span>`;
  }
  function probChip(p) {
    const cls = p === 'hoch' ? 'chip-weak' : p === 'mittel' ? 'chip-medium' : 'chip-strong';
    return `<span class="chip ${cls}">${escapeHtml(p || '—')}</span>`;
  }

  function paintRisks(state) {
    const ana = state.analysis;
    if (!ana) {
      $('#tab-risiken').innerHTML = `<div class="card"><div class="text-ink-300 text-sm">KI-Analyse läuft <span class="spinner"></span></div></div>`;
      return;
    }
    const risks = ana.risiken || [];
    const sc = state.score?.scores || {};
    const bd = state.score?.breakdown || {};
    // Issue 19: Risiko aufgesplittet in Bilanz-Sicherheit (Financial Safety)
    // und Investment-Risiko (Bewertung/Zyklus/Erwartungen). Beide haben
    // eigene Sub-Faktoren — bisher war alles in einem Score zusammengeworfen.
    const fsScore = sc.financial_safety;
    const irScore = sc.investment_risk;
    const fsBd = bd.financial_safety;
    const irBd = bd.investment_risk;
    $('#tab-risiken').innerHTML = `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(248,113,113,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(248,113,113,0.3);">
        <h2>Risiko-Profil · zwei Dimensionen (Issue 19)</h2>
        <p class="text-xs text-ink-300">
          <strong class="text-ink-200">Bilanz-Sicherheit</strong> bewertet die fundamentale Robustheit (Verschuldung, Cashflow, Margen).
          <strong class="text-ink-200">Investment-Risiko</strong> bewertet, wie riskant die Aktie aktuell ist (Bewertungs-Niveau, Volatilität, Drawdown-Erfahrung).
          Hoch = sicher.
        </p>
      </div>
      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2>Bilanz-Sicherheit (Financial Safety)</h2>
          ${ringSvg(fsScore, 'Bilanz-Sicherheit', scoreColor(fsScore))}
          <p class="text-xs text-ink-300 mt-3">
            Score aus Verschuldung (D/E, D/A), Margen-Stabilität (Nettomarge) und Cashflow-Robustheit (FCF-Marge).
            Beantwortet: <em>Wie robust ist das Unternehmen, wenn es schwierig wird?</em>
          </p>
          ${fsBd ? `<details class="mt-3"><summary class="text-xs text-accent-info cursor-pointer hover:underline">Sub-Faktoren anzeigen</summary><div class="mt-2 overflow-x-auto">${renderBreakdownTable('financial_safety', fsBd, '#a3e635')}</div></details>` : ''}
        </div>
        <div class="card">
          <h2>Investment-Risiko</h2>
          ${ringSvg(irScore, 'Investment-Risiko', scoreColor(irScore))}
          <p class="text-xs text-ink-300 mt-3">
            Score aus Bewertungsrisiko (Forward-KGV), Fair-Value-Discount, annualisierter Volatilität und Max Drawdown.
            Beantwortet: <em>Wie riskant ist es, die Aktie heute zu kaufen?</em>
          </p>
          ${irBd ? `<details class="mt-3"><summary class="text-xs text-accent-info cursor-pointer hover:underline">Sub-Faktoren anzeigen</summary><div class="mt-2 overflow-x-auto">${renderBreakdownTable('investment_risk', irBd, '#f87171')}</div></details>` : ''}
        </div>
      </div>
      <div class="grid lg:grid-cols-3 gap-4">
        <div class="card lg:col-span-1">
          <h2>Risiko-Aggregat (Gesamt)</h2>
          ${ringSvg(sc.risk, 'Risikoschutz', scoreColor(sc.risk))}
          <p class="text-xs text-ink-300 mt-3">Gemittelt aus beiden Sub-Dimensionen. Hoch = sicher, niedrig = riskant. Diese Aggregat-Zahl fließt unverändert in den Gesamtscore ein.</p>
        </div>
        <div class="card lg:col-span-2">
          <h2>Identifizierte Risiken (KI)</h2>
          ${risks.length ? `
            <table class="data">
              <thead><tr><th>Risiko</th><th>Wahrscheinlichkeit</th><th>Auswirkung</th></tr></thead>
              <tbody>
                ${risks.map(r => `
                  <tr><td>
                    <div class="font-medium">${escapeHtml(r.risiko)}</div>
                    <div class="text-xs text-ink-300 mt-0.5">${escapeHtml(r.details || '')}</div>
                  </td>
                  <td>${probChip(r.wahrscheinlichkeit)}</td>
                  <td>${probChip(r.auswirkung)}</td></tr>`).join('')}
              </tbody>
            </table>` : '<p class="text-ink-300">Keine spezifischen Risiken identifiziert.</p>'}
        </div>
      </div>`;
  }

  function paintScorecard(state) {
    // Triggers paintOverviewFinal which renders the scorecard
  }

  // ---------------------------------------------------------------------
  // Issue 9: Multi-dimensionale Score-Aufschlüsselung
  // Zeigt pro Bereich (Qualität/Wachstum/...) eine ausklappbare Tabelle mit
  // Sub-Dimension, Wert, Schwellenwerten, Beitrag und Quellenkategorie.
  // ---------------------------------------------------------------------
  function fmtThresholdValue(v, format) {
    if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
    if (format === 'pct') return (Number(v) * 100).toFixed(1) + '%';
    if (format === 'money') return fmt.money(v);
    return Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 });
  }
  function sourceQualityChip(src) {
    const v = String(src || '').toLowerCase();
    if (v.includes('sec')) return '<span class="chip chip-very-strong">SEC</span>';
    if (v.includes('yfinance') || v.includes('marktkap')) return '<span class="chip chip-strong">yfinance</span>';
    if (v.includes('multi') || v.includes('kursverlauf')) return '<span class="chip chip-strong">berechnet</span>';
    if (v.includes('web') || v.includes('news')) return '<span class="chip chip-medium">Web</span>';
    if (v.includes('schätz') || v.includes('schaetz')) return '<span class="chip chip-weak">Schätzung</span>';
    return '<span class="chip chip-medium">' + escapeHtml(src || '—') + '</span>';
  }
  function renderBreakdownTable(name, breakdown, headColor = '#60a5fa') {
    if (!breakdown || !breakdown.subdimensions?.length) {
      return `<div class="text-xs text-ink-300">Keine Sub-Dimensionen verfügbar.</div>`;
    }
    // Issue 18: Wenn der gesamte Breakdown von der KI geschätzt wurde, ein
    // Banner mit Konfidenz + Begründung darüber + value_text statt
    // threshold-Wert in der "Wert"-Spalte.
    const aiBanner = breakdown.ai_estimated ? renderAIFallbackBanner(breakdown) : '';
    const rows = breakdown.subdimensions.map(s => {
      const aiText = (s.ai_estimated && s.value_text) ? escapeHtml(s.value_text) : null;
      const valStr = aiText || fmtThresholdValue(s.value, s.threshold?.format);
      const hasThreshold = s.threshold && s.threshold.lo !== null && s.threshold.lo !== undefined && s.threshold.hi !== null && s.threshold.hi !== undefined;
      const thrLo = hasThreshold ? fmtThresholdValue(s.threshold.lo, s.threshold.format) : null;
      const thrHi = hasThreshold ? fmtThresholdValue(s.threshold.hi, s.threshold.format) : null;
      const dir = hasThreshold && s.threshold.lo > s.threshold.hi ? '↓' : '↑';
      const scoreVal = s.score === null ? '—' : s.score;
      const scoreColorStr = scoreColor(s.score);
      const barWidth = s.score === null ? 0 : s.score;
      return `<tr>
        <td>
          <div class="font-medium text-ink-100 text-sm">${escapeHtml(s.label)}${s.ai_estimated ? ' <span class="chip chip-weak ml-1" style="font-size:9px; padding:1px 4px">KI</span>' : ''}</div>
          ${s.note ? `<div class="text-[10px] text-ink-300">${escapeHtml(s.note)}</div>` : ''}
        </td>
        <td class="num text-sm">${valStr}</td>
        <td class="text-[10px] text-ink-300 font-mono whitespace-nowrap">
          ${hasThreshold ? `${thrLo} ${dir} ${thrHi}` : (s.ai_estimated ? '<span class="text-ink-400">geschätzt</span>' : '—')}
        </td>
        <td>
          <div class="flex items-center gap-2">
            <div class="bar flex-1" style="min-width:50px"><div style="width:${barWidth}%; background:${scoreColorStr}"></div></div>
            <span class="num text-xs font-mono" style="color:${scoreColorStr}; min-width:2.2rem; text-align:right">${scoreVal}</span>
          </div>
        </td>
        <td class="num text-xs text-ink-300">${s.contribution || 0}</td>
        <td>${sourceQualityChip(s.source)}</td>
      </tr>`;
    }).join('');
    return `${aiBanner}<table class="data">
      <thead><tr>
        <th>Sub-Dimension</th>
        <th class="num">Wert</th>
        <th>Schwellenwert</th>
        <th>Score / 100</th>
        <th class="num">Beitrag</th>
        <th>Quelle</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Issue 18: Banner für KI-geschätzte Breakdown-Sections.
  function confidenceLabel(c) {
    const v = String(c || '').toLowerCase();
    if (v === 'hoch' || v === 'high') return { label: 'hoch', cls: 'chip-strong' };
    if (v === 'mittel' || v === 'medium') return { label: 'mittel', cls: 'chip-medium' };
    return { label: 'niedrig', cls: 'chip-weak' };
  }
  function renderAIFallbackBanner(bd) {
    const c = confidenceLabel(bd.ai_confidence);
    const basis = Array.isArray(bd.ai_datenbasis) && bd.ai_datenbasis.length
      ? `<div class="text-[10px] text-ink-300 mt-1.5">Datenbasis: ${bd.ai_datenbasis.map(b => escapeHtml(b)).join(' · ')}</div>`
      : '';
    return `<div class="rounded-md border border-accent-info/40 bg-accent-info/5 p-3 mb-3 text-sm">
      <div class="flex items-center gap-2 mb-1.5 flex-wrap">
        <span class="text-accent-info font-medium">🤖 KI-geschätzt</span>
        <span class="chip ${c.cls}">Konfidenz: ${c.label}</span>
        <span class="text-[10px] text-ink-300">SEC-Daten fehlen — DeepSeek V4 hat diese Dimension aus dem verfügbaren Kontext geschätzt.</span>
      </div>
      ${bd.ai_reasoning ? `<p class="text-xs text-ink-200 leading-relaxed">${escapeHtml(bd.ai_reasoning)}</p>` : ''}
      ${basis}
    </div>`;
  }
  function renderScoreBreakdownAccordion(state) {
    const bd = state.score?.breakdown;
    if (!bd) return '';
    const scs = state.score.scores || {};
    // Issue 19: separate Accordion-Einträge für Bilanz-Sicherheit /
    // Investment-Risiko und News/Markt/Momentum, damit die Sub-Faktoren
    // sauber zuordenbar sind. Aggregat-Risk/Sentiment-Eintrag bleibt für
    // Rückwärtskompatibilität.
    const sections = [
      ['quality', 'Qualität', scs.quality, '#6ee7b7'],
      ['growth', 'Wachstum', scs.growth, '#34d399'],
      ['valuation', 'Bewertung', scs.valuation, '#60a5fa'],
      ['moat', 'Burggraben (Proxy)', scs.moat, '#a78bfa'],
      ['financial_safety', 'Bilanz-Sicherheit (Bilanz · Cashflow · Verschuldung)', scs.financial_safety, '#a3e635'],
      ['investment_risk', 'Investment-Risiko (Bewertung · Zyklus · Erwartung)', scs.investment_risk, '#f87171'],
      ['news_sentiment', 'News-Sentiment (30 Tage)', scs.news_sentiment, '#f59e0b'],
      ['market_sentiment', 'Markt-Sentiment (Fear&Greed · RSI)', scs.market_sentiment, '#fbbf24'],
      ['price_momentum', 'Price Momentum (1M-12M)', scs.price_momentum, '#fb923c'],
      ['sentiment', 'Sentiment-Aggregat (alle Faktoren)', scs.sentiment, '#f59e0b'],
      ['risk', 'Risiko-Aggregat (höher = sicherer)', scs.risk, '#f87171'],
    ];
    const blocks = sections.map(([k, label, score, color]) => {
      const item = bd[k];
      if (!item) return '';
      return `<details class="rounded-md border border-ink-600 bg-ink-800/30 mb-2 px-3 py-2 group">
        <summary class="cursor-pointer flex items-center justify-between gap-3 select-none">
          <span class="flex items-center gap-3">
            <span class="font-medium text-ink-100 text-sm">${label}</span>
            <span class="text-[10px] text-ink-300">${(item.subdimensions || []).length} Faktoren</span>
          </span>
          <span class="flex items-center gap-2">
            <div class="bar" style="width:90px"><div style="width:${score ?? 0}%; background:${color}"></div></div>
            <span class="font-mono text-sm" style="color:${color}; min-width:2.5rem; text-align:right">${score ?? '—'}<span class="text-ink-300 text-xs">/100</span></span>
            <span class="text-ink-300 group-open:hidden">▸</span>
            <span class="text-ink-300 hidden group-open:inline">▾</span>
          </span>
        </summary>
        <div class="mt-3 overflow-x-auto">
          ${renderBreakdownTable(k, item, color)}
        </div>
      </details>`;
    }).join('');
    return `<div class="mt-4 pt-3 border-t border-ink-600/60">
      <div class="text-xs text-ink-300 mb-2">
        Klicke auf eine Dimension, um die Sub-Faktoren mit Wert, Schwellenwert,
        Beitrag und Quellenqualität zu sehen — so wird transparent, wie jeder Score zustande kommt.
      </div>
      ${blocks}
    </div>`;
  }

  // ---------------------------------------------------------------------
  // Issue 9: Entscheidungsmatrix
  // ---------------------------------------------------------------------
  function paintDecisionMatrix(state) {
    const tab = $('#tab-entscheidung');
    if (!tab) return;
    const dm = state.score?.decision_matrix;
    const sc = state.score?.scores || {};
    const bq = state.score?.business_quality_score;
    const sa = state.score?.stock_attractiveness_score;
    const cap = state.score?.attractiveness_cap_reason;

    if (!dm) {
      tab.innerHTML = `<div class="card"><div class="text-ink-300 text-sm">Scorecard lädt <span class="spinner"></span></div></div>`;
      return;
    }

    const rowsHtml = dm.fragen.map((q, i) => {
      const a = String(q.antwort || 'unklar').toLowerCase();
      const cls = a === 'ja' ? 'chip-strong' : a === 'nein' ? 'chip-weak' : 'chip-medium';
      const icon = a === 'ja' ? '✓' : a === 'nein' ? '✗' : '?';
      const lbl = a === 'ja' ? 'Ja' : a === 'nein' ? 'Nein' : 'Unklar';
      return `<tr>
        <td class="text-ink-300 font-mono text-xs">Q${i + 1}</td>
        <td>
          <div class="font-medium text-ink-100">${escapeHtml(q.frage)}</div>
          <div class="text-xs text-ink-300 mt-0.5">${escapeHtml(q.begruendung)}</div>
        </td>
        <td><span class="chip ${cls} font-mono">${icon} ${lbl}</span></td>
        <td class="num">${q.score ?? '—'}</td>
      </tr>`;
    }).join('');

    tab.innerHTML = `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(96,165,250,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(96,165,250,0.3);">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <div>
            <h2 class="!mb-1">Entscheidungsmatrix</h2>
            <p class="text-xs text-ink-300">Klare Ja/Nein/Unklar-Fragen statt nur Punktzahl — direkt entscheidungsorientiert (Issue 9).</p>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span class="chip chip-strong">✓ ${dm.ja_count}× Ja</span>
            <span class="chip chip-weak">✗ ${dm.nein_count}× Nein</span>
            <span class="chip chip-medium">? ${dm.unklar_count}× Unklar</span>
          </div>
        </div>
        <p class="text-base text-ink-100 leading-relaxed font-medium">${escapeHtml(dm.gesamtfazit)}</p>
      </div>

      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2>Business Quality</h2>
          <div class="flex items-baseline gap-3 mb-2">
            <span class="text-4xl font-bold" style="color:${scoreColor(bq)}">${bq ?? '—'}</span>
            <span class="text-ink-300 text-sm">/100</span>
          </div>
          <p class="text-sm text-ink-200 leading-relaxed">
            Wie hochwertig ist das Unternehmen — unabhängig vom Kurs?
            Aggregat aus Qualität (40%), Burggraben (30%), Wachstum (20%), Risiko-Stabilität (10%).
          </p>
        </div>
        <div class="card ${state.score?.attractiveness_cap_applied ? 'border-accent-warm/60' : ''}">
          <h2>Stock Attractiveness ${state.score?.attractiveness_cap_applied ? '<span class="chip chip-medium ml-2">gecappt @75</span>' : ''}</h2>
          <div class="flex items-baseline gap-3 mb-2">
            <span class="text-4xl font-bold" style="color:${scoreColor(sa)}">${sa ?? '—'}</span>
            <span class="text-ink-300 text-sm">/100</span>
          </div>
          <p class="text-sm text-ink-200 leading-relaxed">
            Wie attraktiv ist die Aktie aktuell — preis-abhängig?
            Aggregat aus Bewertung (45%), Sentiment (20%), Wachstum (20%), Qualität (15%).
          </p>
          ${cap ? `<div class="estimate-note mt-3"><span class="text-accent-warm font-medium">⚠ Cap-Hinweis:</span> ${escapeHtml(cap)}</div>` : ''}
        </div>
      </div>

      <div class="card">
        <h2>Sechs entscheidungsrelevante Fragen</h2>
        <table class="data">
          <thead><tr>
            <th>#</th>
            <th>Frage</th>
            <th>Antwort</th>
            <th class="num">Score</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p class="text-xs text-ink-300 mt-3">
          Ableitung: regelbasiert aus Score-Schwellen + Fair-Value-Spielraum + 3-Monats-Momentum.
          Keine Anlageempfehlung — strukturierte Diskussionsbasis.
        </p>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Issue 9: Momentum-/Alpha-Modul
  // ---------------------------------------------------------------------
  function paintMomentum(state) {
    const tab = $('#tab-momentum');
    if (!tab) return;
    const mom = state.score?.momentum;
    const sc = state.score?.scores || {};
    const sentBreak = state.score?.breakdown?.sentiment;
    const riskBreak = state.score?.breakdown?.risk;

    if (!mom) {
      tab.innerHTML = `<div class="card">
        <h2>Momentum &amp; Alpha</h2>
        <p class="text-ink-300 text-sm">Keine Kursdaten verfügbar — Momentum-Analyse nicht möglich.</p>
      </div>`;
      return;
    }

    const retCard = (label, val, periodLbl) => {
      const v = val;
      const color = v === null || v === undefined ? '#5a6378' : v > 0.05 ? '#6ee7b7' : v < -0.05 ? '#f87171' : '#fbbf24';
      const sign = v > 0 ? '+' : '';
      return `<div class="rounded-lg border border-ink-600 bg-ink-800/40 p-4">
        <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">${label}</div>
        <div class="text-2xl font-bold font-mono" style="color:${color}">${v === null || v === undefined ? '—' : sign + (v * 100).toFixed(1) + '%'}</div>
        <div class="text-[10px] text-ink-300 mt-1">${periodLbl}</div>
      </div>`;
    };

    const volScore = sc.sentiment;
    const volPct = mom.volatility !== null && mom.volatility !== undefined ? (mom.volatility * 100).toFixed(1) + '%' : '—';
    const mddPct = mom.max_drawdown !== null && mom.max_drawdown !== undefined ? (mom.max_drawdown * 100).toFixed(1) + '%' : '—';

    // Time-axes Tabelle (Issue 9: Zeitachsen trennen)
    const timeAxesHtml = `
      <table class="data">
        <thead><tr>
          <th>Zeitachse</th>
          <th>Fokus / Signal-Typ</th>
          <th class="num">Wert</th>
          <th>Interpretation</th>
        </tr></thead>
        <tbody>
          <tr>
            <td><span class="font-mono text-accent">1 Monat</span></td>
            <td>News-Reaktion, Earnings-Effekt</td>
            <td class="num">${mom.ret1m === null || mom.ret1m === undefined ? '—' : ((mom.ret1m > 0 ? '+' : '') + (mom.ret1m * 100).toFixed(1) + '%')}</td>
            <td class="text-xs">${interpretReturn(mom.ret1m, 'kurzfristig')}</td>
          </tr>
          <tr>
            <td><span class="font-mono text-accent">3 Monate</span></td>
            <td>Earnings + Sentiment-Trend</td>
            <td class="num">${mom.ret3m === null || mom.ret3m === undefined ? '—' : ((mom.ret3m > 0 ? '+' : '') + (mom.ret3m * 100).toFixed(1) + '%')}</td>
            <td class="text-xs">${interpretReturn(mom.ret3m, 'mittelfristig')}</td>
          </tr>
          <tr>
            <td><span class="font-mono text-accent">6 Monate</span></td>
            <td>Trendrichtung, Sektor-Rotation</td>
            <td class="num">${mom.ret6m === null || mom.ret6m === undefined ? '—' : ((mom.ret6m > 0 ? '+' : '') + (mom.ret6m * 100).toFixed(1) + '%')}</td>
            <td class="text-xs">${interpretReturn(mom.ret6m, 'mittelfristig')}</td>
          </tr>
          <tr>
            <td><span class="font-mono text-accent">12 Monate</span></td>
            <td>Bewertungs-Rerating, Story</td>
            <td class="num">${mom.ret12m === null || mom.ret12m === undefined ? '—' : ((mom.ret12m > 0 ? '+' : '') + (mom.ret12m * 100).toFixed(1) + '%')}</td>
            <td class="text-xs">${interpretReturn(mom.ret12m, 'jahresfrist')}</td>
          </tr>
        </tbody>
      </table>`;

    tab.innerHTML = `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(245,158,11,0.06) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(245,158,11,0.3);">
        <h2>Momentum &amp; Alpha-Modul (Danelfin-artig)</h2>
        <p class="text-xs text-ink-300 mb-3">
          Kurzfristige Kurssignale getrennt nach Zeitachse — 1M/3M/6M/12M-Returns plus Volatilität &amp; Max Drawdown.
          Ergänzt die fundamentalen Scores um die aktuelle Markt-Reaktion.
        </p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          ${retCard('1 Monat', mom.ret1m, 'Kurzfristiges Momentum')}
          ${retCard('3 Monate', mom.ret3m, 'Mittelfristiges Momentum')}
          ${retCard('6 Monate', mom.ret6m, 'Trendrichtung')}
          ${retCard('12 Monate', mom.ret12m, 'Jahres-Performance')}
        </div>
      </div>

      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2>Risiko-Kennzahlen aus Kursverlauf</h2>
          <table class="data">
            <tbody>
              <tr><td>Annualisierte Volatilität</td><td class="num">${volPct}</td></tr>
              <tr><td>Max Drawdown (12M)</td><td class="num ${mom.max_drawdown < 0 ? 'neg' : ''}">${mddPct}</td></tr>
              <tr><td>Letzter Kurs</td><td class="num">${mom.last_price !== null && mom.last_price !== undefined ? fmt.num(mom.last_price, 2) : '—'}</td></tr>
              <tr><td>Datenstand</td><td class="num text-xs">${mom.last_date || '—'}</td></tr>
            </tbody>
          </table>
          <p class="text-xs text-ink-300 mt-3 leading-snug">
            Volatilität aus log-returns der letzten 26 Wochen, annualisiert (×√52).
            Max Drawdown = größter Peak-to-Trough-Verlust der letzten 52 Wochen.
          </p>
        </div>

        <div class="card">
          <h2>Sentiment-Score-Komposition</h2>
          ${sentBreak ? renderBreakdownTable('sentiment', sentBreak, '#f59e0b') : '<p class="text-ink-300 text-sm">—</p>'}
        </div>
      </div>

      <div class="card mb-4">
        <h2>Zeitachsen-Aufteilung (Issue 9)</h2>
        <p class="text-xs text-ink-300 mb-3">
          Verschiedene Zeitfenster reflektieren unterschiedliche Treiber.
          Ein positives 12M aber negatives 3M deutet z.B. auf eine aktuelle Schwächephase trotz starker Jahres-Story.
        </p>
        ${timeAxesHtml}
      </div>

      <div class="card">
        <h2>Risiko-Sub-Dimensionen (inkl. Kursvolatilität)</h2>
        ${riskBreak ? renderBreakdownTable('risk', riskBreak, '#f87171') : '<p class="text-ink-300 text-sm">—</p>'}
      </div>`;
  }
  function interpretReturn(v, horizon) {
    if (v === null || v === undefined) return '—';
    const p = v * 100;
    if (horizon === 'kurzfristig') {
      if (p > 10) return 'Sehr starkes Momentum';
      if (p > 3) return 'Positives Momentum';
      if (p < -10) return 'Scharfer Rückgang';
      if (p < -3) return 'Schwäche';
      return 'Seitwärts';
    }
    if (horizon === 'mittelfristig') {
      if (p > 20) return 'Starker Aufwärtstrend';
      if (p > 5) return 'Stabiler Aufwärtstrend';
      if (p < -20) return 'Starker Abwärtstrend';
      if (p < -5) return 'Abwärts';
      return 'Stagnation';
    }
    // jahresfrist
    if (p > 30) return 'Outperformance';
    if (p > 10) return 'Solide';
    if (p < -20) return 'Schwaches Jahr';
    if (p < -5) return 'Underperformance';
    return 'Marktähnlich';
  }

  // ---------------------------------------------------------------------
  // Issue 13: Technische Analyse (RSI, MACD, Bollinger, 12M/20M Momentum)
  //           + Fear & Greed Index (CNN/alternative.me)
  // ---------------------------------------------------------------------
  function paintTechnical(state) {
    const tab = $('#tab-technical');
    if (!tab) return;
    const t = state.technical;
    const fg = state.fearGreed;
    if (!t && !fg) {
      tab.innerHTML = `<div class="card">
        <h2>Technische Analyse</h2>
        <div class="text-ink-300 text-sm">Lade Indikatoren <span class="spinner"></span></div>
      </div>`;
      return;
    }

    const fmtPctSigned = v => (v === null || v === undefined) ? '—'
      : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

    // RSI Card
    const rsi = t?.rsi;
    const rsiCol = rsi == null ? '#5a6378'
      : rsi >= 70 ? '#f87171'
      : rsi <= 30 ? '#6ee7b7'
      : rsi >= 55 ? '#60a5fa'
      : rsi <= 45 ? '#fbbf24'
      : '#9aa3b6';
    const rsiCard = !t ? '' : `
      <div class="card">
        <h2>RSI (14 Tage)</h2>
        <div class="flex items-baseline gap-3 mb-2">
          <span class="text-4xl font-bold font-mono" style="color:${rsiCol}">${rsi == null ? '—' : rsi.toFixed(1)}</span>
          <span class="text-sm text-ink-300">${escapeHtml(t.rsi_interpretation || '')}</span>
        </div>
        <div class="bar mb-2"><div style="width:${rsi == null ? 0 : Math.min(100, Math.max(0, rsi))}%; background: linear-gradient(90deg, #6ee7b7 0%, #fbbf24 50%, #f87171 100%)"></div></div>
        <div class="flex justify-between text-[10px] text-ink-300 font-mono">
          <span>0 (überverkauft)</span><span>30</span><span>70</span><span>100 (überkauft)</span>
        </div>
        <p class="text-[11px] text-ink-300 mt-3 leading-snug">
          Wilder-RSI auf Tagesschlusskursen — &lt;30 = überverkauft (Mean-Reversion-Setup), &gt;70 = überkauft (Korrekturrisiko).
        </p>
      </div>`;

    // MACD Card
    const m = t?.macd;
    const macdCol = !m ? '#5a6378' : m.histogram > 0 ? '#6ee7b7' : '#f87171';
    const macdCard = !m ? '' : `
      <div class="card">
        <h2>MACD (12 / 26 / 9)</h2>
        <table class="data">
          <tbody>
            <tr><td>MACD-Linie</td><td class="num">${m.macd.toFixed(3)}</td></tr>
            <tr><td>Signal-Linie</td><td class="num">${m.signal.toFixed(3)}</td></tr>
            <tr><td>Histogramm</td><td class="num" style="color:${macdCol}; font-weight:600">${m.histogram > 0 ? '+' : ''}${m.histogram.toFixed(3)}</td></tr>
            <tr><td>Trend</td><td class="num" style="color:${macdCol}">${m.trend || '—'}</td></tr>
            ${m.cross ? `<tr><td>Cross</td><td class="num" style="color:${m.cross === 'bullish' ? '#6ee7b7' : '#f87171'}">${m.cross === 'bullish' ? '↑ Bullish' : '↓ Bearish'}</td></tr>` : ''}
          </tbody>
        </table>
        <p class="text-[11px] text-ink-300 mt-3 leading-snug">
          Histogramm &gt; 0 = MACD über Signal (bullisch). Vorzeichenwechsel = Cross-Signal.
        </p>
      </div>`;

    // Bollinger Card
    const b = t?.bollinger;
    const bbCard = !b ? '' : `
      <div class="card">
        <h2>Bollinger-Bänder (20, 2σ)</h2>
        <table class="data">
          <tbody>
            <tr><td>Oberes Band</td><td class="num">${b.upper.toFixed(2)}</td></tr>
            <tr><td>Mittel (SMA-20)</td><td class="num">${b.middle.toFixed(2)}</td></tr>
            <tr><td>Unteres Band</td><td class="num">${b.lower.toFixed(2)}</td></tr>
            <tr><td>%B (Position)</td><td class="num">${b.percent_b == null ? '—' : (b.percent_b * 100).toFixed(1) + '%'}</td></tr>
            <tr><td>Bandbreite</td><td class="num">${b.bandwidth == null ? '—' : (b.bandwidth * 100).toFixed(1) + '%'}</td></tr>
          </tbody>
        </table>
        ${b.interpretation ? `<p class="text-[11px] text-ink-200 mt-3 leading-snug">${escapeHtml(b.interpretation)}</p>` : ''}
      </div>`;

    // Long Momentum Card
    const lm = t?.momentum_long;
    const longMomCard = !lm ? '' : `
      <div class="card">
        <h2>Lang-Momentum</h2>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="rounded-lg border border-ink-600 bg-ink-800/40 p-3">
            <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">12 Monate</div>
            <div class="text-2xl font-bold font-mono" style="color:${lm.mom_12m == null ? '#5a6378' : lm.mom_12m > 0 ? '#6ee7b7' : '#f87171'}">
              ${fmtPctSigned(lm.mom_12m)}
            </div>
          </div>
          <div class="rounded-lg border border-ink-600 bg-ink-800/40 p-3">
            <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">20 Monate</div>
            <div class="text-2xl font-bold font-mono" style="color:${lm.mom_20m == null ? '#5a6378' : lm.mom_20m > 0 ? '#6ee7b7' : '#f87171'}">
              ${fmtPctSigned(lm.mom_20m)}
            </div>
          </div>
        </div>
        <p class="text-[11px] text-ink-300 leading-snug">
          Historischer Kursvergleich zum gleichen Tag vor 12 bzw. 20 Monaten.
          Robust gegen kurzfristiges Rauschen — gut für Trend-Folge-Strategien.
        </p>
      </div>`;

    // Fear & Greed Card
    const fgScore = fg?.score != null && Number.isFinite(+fg.score) ? Math.round(+fg.score) : null;
    const fgCol = fgScore == null ? '#5a6378'
      : fgScore >= 75 ? '#f87171'
      : fgScore >= 55 ? '#fbbf24'
      : fgScore >= 45 ? '#9aa3b6'
      : fgScore >= 25 ? '#fbbf24'
      : '#6ee7b7';
    const fgRating = fg?.rating ? String(fg.rating).toUpperCase() : '—';
    const fgCard = !fg ? `
      <div class="card lg:col-span-2">
        <h2>Fear &amp; Greed Index</h2>
        <div class="text-ink-300 text-sm">Lade Markt-Stimmung <span class="spinner"></span></div>
      </div>` : fg.error ? `
      <div class="card lg:col-span-2">
        <h2>Fear &amp; Greed Index</h2>
        <p class="text-ink-300 text-sm">Aktuell nicht verfügbar: ${escapeHtml(fg.error)}</p>
      </div>` : `
      <div class="card lg:col-span-2" style="background: linear-gradient(180deg, ${fgCol}1a 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color:${fgCol}66;">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h2 class="!mb-1">Fear &amp; Greed Index</h2>
            <p class="text-xs text-ink-300">${escapeHtml(fg.source || '—')}</p>
          </div>
          <a href="${escapeHtml(fg.source_url || '#')}" target="_blank" rel="noopener" class="text-xs text-accent-info hover:underline">→ Quelle</a>
        </div>
        <div class="flex flex-wrap items-end gap-6 mb-4">
          <div>
            <div class="flex items-baseline gap-2">
              <span class="text-6xl font-bold font-mono" style="color:${fgCol}">${fgScore ?? '—'}</span>
              <span class="text-ink-300 text-sm">/100</span>
            </div>
            <div class="text-sm font-semibold mt-1" style="color:${fgCol}">${escapeHtml(fgRating)}</div>
          </div>
          <div class="flex-1 min-w-[180px]">
            <div class="bar mb-2"><div style="width:${fgScore ?? 0}%; background: linear-gradient(90deg, #6ee7b7 0%, #fbbf24 50%, #f87171 100%)"></div></div>
            <div class="flex justify-between text-[10px] text-ink-300 font-mono">
              <span>0 (Panik)</span><span>50 (Neutral)</span><span>100 (Gier)</span>
            </div>
          </div>
        </div>
        ${(fg.previous_close != null || fg.previous_week != null || fg.previous_month != null || fg.previous_year != null) ? `
          <table class="data">
            <thead><tr><th>Zeitpunkt</th><th class="num">Index</th></tr></thead>
            <tbody>
              ${fg.previous_close != null ? `<tr><td>Vortag</td><td class="num">${Math.round(+fg.previous_close)}</td></tr>` : ''}
              ${fg.previous_week != null ? `<tr><td>Vor 1 Woche</td><td class="num">${Math.round(+fg.previous_week)}</td></tr>` : ''}
              ${fg.previous_month != null ? `<tr><td>Vor 1 Monat</td><td class="num">${Math.round(+fg.previous_month)}</td></tr>` : ''}
              ${fg.previous_year != null ? `<tr><td>Vor 1 Jahr</td><td class="num">${Math.round(+fg.previous_year)}</td></tr>` : ''}
            </tbody>
          </table>` : ''}
        ${fg.note ? `<p class="text-[11px] text-accent-warm mt-3 leading-snug">⚠ ${escapeHtml(fg.note)}</p>` : ''}
        <p class="text-[11px] text-ink-300 mt-3 leading-snug">
          Markt-Stimmungsindikator — fließt in den Sentiment-Score ein.
          Extreme Werte (&gt;75 oder &lt;25) gelten klassisch als Contrarian-Signale.
        </p>
      </div>`;

    const techMissing = !t || t.error;
    tab.innerHTML = `
      ${techMissing ? `
        <div class="card mb-4">
          <p class="text-ink-300 text-sm">
            ${t?.error ? 'Technische Indikatoren konnten nicht berechnet werden: ' + escapeHtml(t.error)
              : 'Lade technische Indikatoren <span class="spinner"></span>'}
          </p>
        </div>` : `
        <div class="grid lg:grid-cols-2 gap-4 mb-4">
          ${longMomCard}
          ${rsiCard}
          ${macdCard}
          ${bbCard}
        </div>`}
      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        ${fgCard}
      </div>
      ${(!techMissing && t?.closes_count) ? `
        <p class="text-[10px] text-ink-300 mt-2">
          Datenbasis: ${t.closes_count} Tagesschlusskurse · letzter Kurs ${fmt.num(t.last_price, 2)} · Quelle ${escapeHtml(t.source || 'yfinance')}.
        </p>` : ''}`;
  }

  // ---------------------------------------------------------------------
  // Issue 9: Markterwartungs-Modul
  // ---------------------------------------------------------------------
  function paintExpectations(state) {
    const tab = $('#tab-erwartung');
    if (!tab) return;
    const ex = state.expectations;
    const info = state.quote?.info || {};
    const yx = state.yfExtra || {};
    if (!ex) {
      tab.innerHTML = `<div class="card">
        <h2>Markterwartung</h2>
        <p class="text-ink-300 text-sm">Lade Analyst-Konsens, Earnings-Surprise &amp; Guidance-Daten <span class="spinner"></span></p>
      </div>`;
      return;
    }

    // Analyst-Empfehlung (Mean)
    const recMean = ex.recommendation_mean;
    const recKey = ex.recommendation_key;
    const recLbl = ({
      'strong_buy': 'Strong Buy', 'buy': 'Buy', 'hold': 'Hold', 'sell': 'Sell', 'strong_sell': 'Strong Sell',
    })[String(recKey || '').toLowerCase()] || (recKey || '—');
    const recCls = ['strong_buy', 'buy'].includes(String(recKey || '').toLowerCase()) ? 'chip-strong'
      : ['hold'].includes(String(recKey || '').toLowerCase()) ? 'chip-medium'
      : ['sell', 'strong_sell'].includes(String(recKey || '').toLowerCase()) ? 'chip-weak' : 'chip-medium';

    // Kursziel
    const tgt = ex.target_mean ?? ex.target_median;
    const price = safeNum(info.price);
    const tgtUpside = (tgt && price) ? (tgt - price) / price : null;

    // Earnings Surprise History
    const eh = Array.isArray(ex.earnings_history) ? ex.earnings_history : [];
    const surprises = eh.filter(e => e.surprise_pct !== null && e.surprise_pct !== undefined);
    const avgSurprise = surprises.length
      ? surprises.reduce((s, e) => s + Number(e.surprise_pct), 0) / surprises.length
      : null;

    // Issue 19: Letzte vergangene + nächste (geschätzte) Earnings auseinanderhalten.
    // Vergangene Earnings (z.B. 20. Mai 2026) dürfen nicht mehr als "nächster
    // Beobachtungspunkt" verkauft werden — sie sind bereits raus.
    const todayIso = new Date().toISOString().slice(0, 10);
    const pastEarnings = eh
      .filter(e => e.date && e.date <= todayIso)
      .sort((a, b) => b.date.localeCompare(a.date));
    const lastEarn = pastEarnings[0] || null;
    // Wenn yfinance einen offiziellen nächsten Termin liefert, nehmen wir den —
    // sonst schätzen wir auf last + ~91 Tage (Quartal). Monatsname in DE.
    const monthsDe = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    function fmtDeDate(iso) {
      if (!iso) return '—';
      const d = new Date(iso + 'T00:00:00Z');
      if (isNaN(d.getTime())) return iso;
      return `${d.getUTCDate()}. ${monthsDe[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    function fmtDeMonthYear(iso) {
      if (!iso) return '—';
      const d = new Date(iso + 'T00:00:00Z');
      if (isNaN(d.getTime())) return iso;
      return `${monthsDe[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    let nextEarnIso = ex.next_earnings_date || null;
    let nextEarnEstimated = false;
    if (!nextEarnIso && lastEarn?.date) {
      const last = new Date(lastEarn.date + 'T00:00:00Z');
      if (!isNaN(last.getTime())) {
        last.setUTCDate(last.getUTCDate() + 91);
        nextEarnIso = last.toISOString().slice(0, 10);
        nextEarnEstimated = true;
      }
    }
    const lastEarnDateStr = lastEarn?.date ? fmtDeDate(lastEarn.date) : '—';
    const nextEarnLabel = nextEarnIso
      ? (nextEarnEstimated ? `voraussichtlich ${fmtDeMonthYear(nextEarnIso)}` : fmtDeDate(nextEarnIso))
      : '—';
    const lastSurpriseChipCls = (lastEarn && lastEarn.surprise_pct !== null && lastEarn.surprise_pct !== undefined)
      ? (lastEarn.surprise_pct > 0 ? 'chip-strong' : lastEarn.surprise_pct < 0 ? 'chip-weak' : 'chip-medium')
      : 'chip-medium';
    const lastSurpriseTxt = (lastEarn && lastEarn.surprise_pct !== null && lastEarn.surprise_pct !== undefined)
      ? `${lastEarn.surprise_pct > 0 ? '+' : ''}${Number(lastEarn.surprise_pct).toFixed(1)}% Surprise`
      : 'kein Surprise-Wert';

    // Implizite Erwartung — Forward EPS, KGV, Growth
    const fwdEps = safeNum(yx.forwardEps);
    const fwdPE = safeNum(yx.forwardPE);
    const trailingEps = safeNum(yx.trailingEps);
    const epsImpliedGrowth = (fwdEps && trailingEps) ? (fwdEps - trailingEps) / Math.abs(trailingEps) : null;

    // Guidance-Risk Heuristik
    let guidanceRisk = 'mittel';
    let guidanceNote = '';
    if (fwdPE !== null && fwdPE > 30) { guidanceRisk = 'hoch'; guidanceNote = `Forward-KGV ${fwdPE.toFixed(1)} preist starkes Gewinnwachstum ein — Enttäuschung kann scharf abstrafen.`; }
    else if (fwdPE !== null && fwdPE < 12) { guidanceRisk = 'niedrig'; guidanceNote = `Forward-KGV ${fwdPE.toFixed(1)} preist wenig Wachstum ein — Guidance-Risiko begrenzt.`; }
    else if (fwdPE !== null) { guidanceNote = `Forward-KGV ${fwdPE.toFixed(1)} preist moderate Erwartungen ein.`; }
    const grCls = guidanceRisk === 'hoch' ? 'chip-weak' : guidanceRisk === 'niedrig' ? 'chip-strong' : 'chip-medium';

    // Rec-Counts (Strong Buy / Buy / Hold / Sell / Strong Sell)
    const rc = ex.rec_counts || {};
    const totalRecs = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].reduce((s, k) => s + (rc[k] || 0), 0);
    const recBars = totalRecs > 0 ? [
      ['Strong Buy', rc.strongBuy || 0, '#15803d'],
      ['Buy', rc.buy || 0, '#6ee7b7'],
      ['Hold', rc.hold || 0, '#fbbf24'],
      ['Sell', rc.sell || 0, '#fb923c'],
      ['Strong Sell', rc.strongSell || 0, '#b91c1c'],
    ].map(([lbl, n, c]) => `<div class="grid grid-cols-[6rem_1fr_2.5rem] gap-2 items-center text-xs mb-1">
        <span class="text-ink-300">${lbl}</span>
        <div class="bar"><div style="width:${(n / totalRecs) * 100}%; background:${c}"></div></div>
        <span class="font-mono text-right text-ink-100">${n}</span>
      </div>`).join('') : '<p class="text-xs text-ink-300">— Keine Analyst-Empfehlungen verfügbar —</p>';

    // Earnings History Tabelle
    const ehRows = eh.length ? eh.map(e => {
      const sp = e.surprise_pct;
      const spCls = sp === null || sp === undefined ? '' : sp > 0 ? 'pos' : sp < 0 ? 'neg' : '';
      const spStr = sp === null || sp === undefined ? '—' : (sp > 0 ? '+' : '') + sp.toFixed(1) + '%';
      return `<tr>
        <td>${escapeHtml(e.date)}</td>
        <td class="num">${e.eps_estimate === null || e.eps_estimate === undefined ? '—' : Number(e.eps_estimate).toFixed(2)}</td>
        <td class="num">${e.reported_eps === null || e.reported_eps === undefined ? '—' : Number(e.reported_eps).toFixed(2)}</td>
        <td class="num ${spCls}">${spStr}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" class="text-center text-ink-300 text-sm">— Keine Earnings-Historie verfügbar —</td></tr>';

    tab.innerHTML = `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(168,85,247,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(168,85,247,0.3);">
        <h2>Markterwartungs-Modul (Issue 9)</h2>
        <p class="text-xs text-ink-300">
          Analyst-Konsens, Earnings-Surprise-Historie und Guidance-Risiko —
          die Marktmeinung als eigenständige Datenebene neben den fundamentalen Scores.
        </p>
      </div>

      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2>Analyst-Konsens</h2>
          <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
            <span class="chip ${recCls}">${escapeHtml(recLbl)}</span>
            ${recMean !== null && recMean !== undefined ? `<span class="text-xs text-ink-300">Mean: <span class="font-mono text-ink-100">${Number(recMean).toFixed(2)}</span> · ${ex.num_analyst_opinions || '?'} Analysten</span>` : ''}
          </div>
          ${recBars}
          <div class="text-[10px] text-ink-300 mt-3 leading-snug">
            Skala: 1 = Strong Buy, 3 = Hold, 5 = Strong Sell. Quelle: yfinance.
          </div>
        </div>

        <div class="card">
          <h2>Kursziel-Spanne</h2>
          ${tgt ? `
            <div class="flex items-baseline gap-3 mb-2">
              <span class="text-2xl font-bold font-mono">${fmt.num(tgt, 2)}</span>
              <span class="text-sm text-ink-300">${info.currency || 'USD'}</span>
            </div>
            <div class="text-sm ${tgtUpside > 0 ? 'pos' : tgtUpside < 0 ? 'neg' : ''}">
              vs. Kurs: ${tgtUpside !== null ? ((tgtUpside > 0 ? '+' : '') + (tgtUpside * 100).toFixed(1) + '%') : '—'}
            </div>
            <div class="text-xs text-ink-300 mt-3">
              <div>Niedrig: <span class="font-mono text-ink-100">${ex.target_low !== null && ex.target_low !== undefined ? fmt.num(ex.target_low, 2) : '—'}</span></div>
              <div>Median: <span class="font-mono text-ink-100">${ex.target_median !== null && ex.target_median !== undefined ? fmt.num(ex.target_median, 2) : '—'}</span></div>
              <div>Hoch: <span class="font-mono text-ink-100">${ex.target_high !== null && ex.target_high !== undefined ? fmt.num(ex.target_high, 2) : '—'}</span></div>
            </div>
          ` : '<p class="text-ink-300 text-sm">— Kein Analysten-Kursziel verfügbar —</p>'}
        </div>

        <div class="card">
          <h2>Implizite Erwartung (Forward-EPS)</h2>
          <table class="data">
            <tbody>
              <tr><td>EPS (TTM)</td><td class="num">${trailingEps !== null ? trailingEps.toFixed(2) : '—'}</td></tr>
              <tr><td>Forward-EPS</td><td class="num font-bold">${fwdEps !== null ? fwdEps.toFixed(2) : '—'}</td></tr>
              <tr><td>Impl. EPS-Wachstum</td><td class="num ${epsImpliedGrowth > 0 ? 'pos' : epsImpliedGrowth < 0 ? 'neg' : ''}">${epsImpliedGrowth !== null ? ((epsImpliedGrowth > 0 ? '+' : '') + (epsImpliedGrowth * 100).toFixed(1) + '%') : '—'}</td></tr>
              <tr><td>Forward-KGV</td><td class="num">${fwdPE !== null ? fwdPE.toFixed(1) : '—'}</td></tr>
              <tr><td>PEG</td><td class="num">${ex.recommendation_mean !== undefined && yx.pegRatio !== undefined && yx.pegRatio !== null ? Number(yx.pegRatio).toFixed(2) : (yx.pegRatio !== null && yx.pegRatio !== undefined ? Number(yx.pegRatio).toFixed(2) : '—')}</td></tr>
            </tbody>
          </table>
          <p class="text-xs text-ink-300 mt-3 leading-snug">
            Forward-EPS = Analysten-Konsens für das nächste Geschäftsjahr.
            Das implizite Wachstum vergleicht damit den TTM-EPS — viel impliziertes Wachstum erhöht die Latte.
          </p>
        </div>

        <div class="card">
          <h2>Guidance-Risiko</h2>
          <div class="flex items-center gap-3 mb-3">
            <span class="chip ${grCls}">Guidance-Risiko: ${guidanceRisk}</span>
            ${avgSurprise !== null ? `<span class="text-xs text-ink-300">Ø Earnings-Surprise: <span class="font-mono ${avgSurprise > 0 ? 'pos' : avgSurprise < 0 ? 'neg' : ''}">${(avgSurprise > 0 ? '+' : '') + avgSurprise.toFixed(1)}%</span></span>` : ''}
          </div>
          <p class="text-sm text-ink-200 leading-relaxed">${escapeHtml(guidanceNote || 'Forward-KGV nicht verfügbar — Guidance-Einschätzung eingeschränkt.')}</p>
        </div>
      </div>

      <div class="card mb-4">
        <h2>Quartalszahlen-Kalender <span class="text-ink-300 text-xs font-normal ml-2">(Issue 19)</span></h2>
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="rounded-md border border-ink-600 p-3 bg-ink-800/30">
            <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">Letzte Quartalszahlen</div>
            <div class="font-mono text-lg text-ink-100">${escapeHtml(lastEarnDateStr)}</div>
            <div class="text-xs text-ink-300 mt-1">${escapeHtml(lastSurpriseTxt)}${lastEarn ? ` · EPS ${lastEarn.reported_eps !== null && lastEarn.reported_eps !== undefined ? Number(lastEarn.reported_eps).toFixed(2) : '—'} vs. ${lastEarn.eps_estimate !== null && lastEarn.eps_estimate !== undefined ? Number(lastEarn.eps_estimate).toFixed(2) : '—'} Schätz.` : ''}</div>
          </div>
          <div class="rounded-md border border-ink-600 p-3 bg-ink-800/30">
            <div class="text-[10px] uppercase tracking-wider text-ink-300 mb-1">Nächste Quartalszahlen</div>
            <div class="font-mono text-lg text-ink-100">${escapeHtml(nextEarnLabel)}</div>
            <div class="text-xs text-ink-300 mt-1">
              ${nextEarnEstimated
                ? 'Geschätzt aus letztem Termin + 1 Quartal (yfinance hat kein offizielles Datum).'
                : (nextEarnIso ? 'Quelle: yfinance earnings_dates.' : 'Kein nächster Termin gemeldet.')}
            </div>
          </div>
        </div>
        <p class="text-xs text-ink-300 mt-3 leading-snug">
          Vergangene Earnings (z.B. ${escapeHtml(lastEarnDateStr)}) werden nicht mehr als „Beobachtungspunkt" angezeigt — der nächste Termin ist der relevante Trigger.
        </p>
      </div>

      <div class="card">
        <h2>Earnings-Surprise-Historie</h2>
        <table class="data">
          <thead><tr>
            <th>Datum</th>
            <th class="num">EPS-Schätzung</th>
            <th class="num">EPS-Reportiert</th>
            <th class="num">Surprise</th>
          </tr></thead>
          <tbody>${ehRows}</tbody>
        </table>
        <p class="text-xs text-ink-300 mt-3 leading-snug">
          Konsistente Beats (Surprise &gt; 0) deuten auf konservatives Management,
          häufige Misses signalisieren Guidance-Probleme.
        </p>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Issue 11: KI-Prognose 3J + 12-Monats-Kursziel
  // ---------------------------------------------------------------------
  function paintForecastSkeleton(state) {
    const tab = $('#tab-prognose');
    if (!tab) return;
    // Issue 17: SEC-Status-Hinweis oben anzeigen, falls Daten fehlen
    const secBanner = renderSecStatusBanner(state);
    tab.innerHTML = `${secBanner}
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(110,231,183,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(110,231,183,0.25);">
        <h2>KI-Prognose · 3 Jahre &amp; 12-Monats-Kursziel (Issue 11)</h2>
        <p class="text-xs text-ink-300">
          DeepSeek V4 schätzt Umsatz, Gewinn, CAPEX und EPS für die nächsten drei Geschäftsjahre und leitet daraus
          ein Bull/Base/Bear-Kursziel auf 12 Monate ab. Inputs: SEC-Historie, Analysten-Konsens, Branchen-Ausblick und Wettbewerbsanalyse.
        </p>
      </div>
      <div class="card">
        <div class="text-ink-300 text-sm">Berechne Prognose <span class="spinner"></span></div>
        <p class="text-[11px] text-ink-300 mt-1.5 leading-snug">Kann 20-40 Sekunden dauern — die KI ankert auf historischen Daten und Analystenzielen.</p>
      </div>`;
  }

  function fcOutlookChip(label) {
    if (!label) return '';
    const l = String(label).toLowerCase();
    const cls = ({
      'deutlich-hoeher': 'chip-very-strong', 'hoeher': 'chip-strong',
      'neutral': 'chip-medium', 'niedriger': 'chip-weak', 'deutlich-niedriger': 'chip-weak',
    })[l] || 'chip-medium';
    const txt = ({
      'deutlich-hoeher': 'Deutlich höher', 'hoeher': 'Höher',
      'neutral': 'Neutral', 'niedriger': 'Niedriger', 'deutlich-niedriger': 'Deutlich niedriger',
    })[l] || label;
    return `<span class="chip ${cls}">${escapeHtml(txt)}</span>`;
  }

  function fcIntensityChip(label) {
    if (!label) return '<span class="chip">—</span>';
    const l = String(label).toLowerCase();
    const cls = ({
      'niedrig': 'chip-strong', 'mittel': 'chip-medium', 'hoch': 'chip-weak', 'sehr-hoch': 'chip-weak',
    })[l] || 'chip-medium';
    return `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
  }

  function fcDirChip(label) {
    if (!label) return '<span class="chip">—</span>';
    const l = String(label).toLowerCase();
    const cls = l.includes('steigend') ? 'chip-strong'
      : l.includes('fallend') ? 'chip-weak'
      : 'chip-medium';
    const txt = ({
      'stark-steigend': '↑↑ stark steigend', 'steigend': '↑ steigend',
      'stabil': '→ stabil',
      'fallend': '↓ fallend', 'stark-fallend': '↓↓ stark fallend',
    })[l] || label;
    return `<span class="chip ${cls}">${escapeHtml(txt)}</span>`;
  }

  function fmtBnum(v) {
    if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
    return Number(v).toFixed(2) + 'B';
  }
  function fmtPctNum(v, d = 1) {
    if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
    return (Number(v) * 100).toFixed(d) + '%';
  }

  function paintForecast(state) {
    const tab = $('#tab-prognose');
    if (!tab) return;
    const f = state.forecast;
    const meta = state.forecastMeta || {};
    const info = state.quote?.info || {};
    const cur = info.currency || 'USD';
    const symCur = cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'JPY' ? '¥' : '$';

    if (!f) {
      tab.innerHTML = `<div class="card">
        <h2>KI-Prognose</h2>
        <p class="text-accent-bad text-sm">JSON-Parsing fehlgeschlagen.</p>
        ${meta.raw_excerpt ? `<pre class="text-xs text-ink-300 bg-ink-900 p-3 rounded mt-2 overflow-auto max-h-64">${escapeHtml(meta.raw_excerpt)}</pre>` : ''}
      </div>`;
      return;
    }

    const md = f.metadaten || {};
    const pj = Array.isArray(f.prognose) ? f.prognose : [];
    const kp = f.kurs_prognose_12m || {};
    const mk = f.markt_kontext || {};
    const bi = f.bewertungs_implikation || {};
    const dq = f.datenqualitaet || {};
    const ks = f.kurs_konfidenz || kp.konfidenz_kurs || {};

    // Header / Kernaussage
    const headerHtml = `<div class="card mb-4" style="background: linear-gradient(180deg, rgba(110,231,183,0.06) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(110,231,183,0.3);">
      <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
        <div>
          <h2 class="!mb-1">KI-Prognose · 3 Jahre &amp; 12-Monats-Kursziel</h2>
          <p class="text-xs text-ink-300">
            DeepSeek V4 projiziert Umsatz, Gewinn, CAPEX und EPS bis ${md.prognose_jahre?.[2] || '+3 Jahre'} —
            plus ein konkretes Bull/Base/Bear-Kursziel auf 12 Monate. Inputs: SEC-Historie, Forward-EPS, Analysten-Konsens, Branchen-Ausblick, Wettbewerb.
          </p>
        </div>
        ${confidenceChip(dq.vertrauen_overall)}
      </div>
      ${md.modell_annahmen ? `<p class="text-sm text-ink-100 leading-relaxed border-l-2 pl-3 py-1" style="border-color: rgba(110,231,183,0.4)">${escapeHtml(md.modell_annahmen)}</p>` : ''}
    </div>`;

    // ---------- 12-Monats-Kursziel ----------
    const price = safeNum(info.price);
    const bullKurs = safeNum(kp.bull?.kurs);
    const baseKurs = safeNum(kp.base?.kurs);
    const bearKurs = safeNum(kp.bear?.kurs);
    const konfLo = safeNum(ks.unten);
    const konfHi = safeNum(ks.oben);

    const scenUpside = (s) => {
      const k = safeNum(s?.kurs);
      if (k === null || price === null || price === 0) return null;
      return (k - price) / price;
    };
    const bullUp = scenUpside(kp.bull);
    const baseUp = scenUpside(kp.base);
    const bearUp = scenUpside(kp.bear);

    let priceBar = '';
    if (price !== null && bearKurs !== null && bullKurs !== null) {
      const lo = Math.min(bearKurs, price);
      const hi = Math.max(bullKurs, price);
      const span = hi - lo || 1;
      const at = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
      const pPrice = at(price);
      const pBear = at(bearKurs);
      const pBase = baseKurs !== null ? at(baseKurs) : null;
      const pBull = at(bullKurs);
      const konfLeft = konfLo !== null && konfHi !== null ? at(konfLo) : null;
      const konfRight = konfLo !== null && konfHi !== null ? at(konfHi) : null;
      priceBar = `
        <div class="relative mt-5 mb-2 h-14">
          <div class="absolute inset-y-5 left-0 right-0 rounded-full bg-ink-600/60"></div>
          ${konfLeft !== null && konfRight !== null ? `<div class="absolute inset-y-5 rounded-full"
            style="left:${konfLeft}%; right:${100 - konfRight}%; background: linear-gradient(90deg, rgba(96,165,250,0.45), rgba(110,231,183,0.45));"></div>` : `<div class="absolute inset-y-5 rounded-full"
            style="left:${pBear}%; right:${100 - pBull}%; background: linear-gradient(90deg, rgba(248,113,113,0.35), rgba(110,231,183,0.35));"></div>`}
          <div class="absolute top-1 bottom-1 flex flex-col items-center" style="left:calc(${pBear}% - 0.5rem)" title="Bear">
            <span class="text-[10px] font-mono text-neg leading-none">${symCur}${fmt.num(bearKurs, 2)}</span>
            <span class="w-3 h-3 mt-1 rounded-sm bg-neg border border-ink-900"></span>
          </div>
          ${pBase !== null ? `<div class="absolute top-1 bottom-1 flex flex-col items-center" style="left:calc(${pBase}% - 0.5rem)" title="Base">
            <span class="text-[10px] font-mono text-accent-info leading-none">${symCur}${fmt.num(baseKurs, 2)}</span>
            <span class="w-3 h-3 mt-1 rounded-full bg-accent-info border border-ink-900"></span>
          </div>` : ''}
          <div class="absolute top-1 bottom-1 flex flex-col items-center" style="left:calc(${pBull}% - 0.5rem)" title="Bull">
            <span class="text-[10px] font-mono text-pos leading-none">${symCur}${fmt.num(bullKurs, 2)}</span>
            <span class="w-3 h-3 mt-1 rounded-sm bg-pos border border-ink-900"></span>
          </div>
          <div class="absolute -bottom-2 flex flex-col items-center" style="left:calc(${pPrice}% - 0.5rem)" title="Aktueller Kurs">
            <span class="w-3 h-3 rounded-sm bg-accent border-2 border-ink-900 shadow"></span>
            <span class="text-[10px] font-mono text-accent mt-0.5 leading-none">heute</span>
          </div>
        </div>`;
    }

    const renderScenarioCard = (label, s, color, upside) => {
      const wahrsch = safeNum(s?.wahrscheinlichkeit_pct);
      const kurs = safeNum(s?.kurs);
      const treiber = Array.isArray(s?.treiber) ? s.treiber : [];
      const upCls = upside !== null && upside > 0 ? 'pos' : upside !== null && upside < 0 ? 'neg' : '';
      const upStr = upside !== null ? ((upside > 0 ? '+' : '') + (upside * 100).toFixed(1) + '%') : '—';
      return `<div class="rounded-lg border p-4" style="border-color:${color}40; background: linear-gradient(180deg, ${color}08 0%, transparent 100%);">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold" style="color:${color}">${label}</span>
          ${wahrsch !== null ? `<span class="text-xs text-ink-300">P=${wahrsch.toFixed(0)}%</span>` : ''}
        </div>
        <div class="text-2xl font-bold font-mono mb-1">${kurs !== null ? symCur + fmt.num(kurs, 2) : '—'}</div>
        <div class="text-sm ${upCls} font-mono mb-2">${upStr}</div>
        <div class="text-[11px] text-ink-300 mb-2">${s?.implizites_kgv ? `Impl. KGV: ${Number(s.implizites_kgv).toFixed(1)}` : ''}</div>
        ${treiber.length ? `<ul class="text-xs text-ink-200 space-y-1 mb-2">${treiber.slice(0, 3).map(t => `<li class="flex gap-1.5"><span style="color:${color}">▸</span><span>${escapeHtml(t)}</span></li>`).join('')}</ul>` : ''}
        ${s?.kommentar ? `<p class="text-[11px] text-ink-300 leading-snug">${escapeHtml(s.kommentar)}</p>` : ''}
      </div>`;
    };

    const priceTargetHtml = `<div class="card mb-4">
      <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
        <div>
          <h2 class="!mb-1">12-Monats-Kursziel · Bull / Base / Bear</h2>
          <p class="text-xs text-ink-300">
            Konkretes Aktienkursziel auf 12 Monate, mit Wahrscheinlichkeit und Konfidenzintervall.
            ${ks.konfidenz_pct ? `Konfidenz: <span class="font-mono">${Number(ks.konfidenz_pct).toFixed(0)}%</span>.` : ''}
          </p>
        </div>
        ${ks.konfidenz_pct ? `<span class="chip chip-medium">Konfidenz ${Number(ks.konfidenz_pct).toFixed(0)}%</span>` : ''}
      </div>
      ${priceBar}
      <div class="text-xs text-ink-300 mt-3 flex flex-wrap gap-4">
        <span><span class="inline-block w-2.5 h-2.5 rounded-sm bg-accent align-middle mr-1.5"></span>Aktueller Kurs: <span class="font-mono text-ink-100">${price !== null ? symCur + fmt.num(price, 2) : '—'}</span></span>
        ${konfLo !== null && konfHi !== null ? `<span><span class="inline-block w-3 h-2.5 align-middle mr-1.5" style="background: linear-gradient(90deg, rgba(96,165,250,0.5), rgba(110,231,183,0.5))"></span>Konfidenzintervall: <span class="font-mono text-ink-100">${symCur}${fmt.num(konfLo, 2)} – ${symCur}${fmt.num(konfHi, 2)}</span></span>` : ''}
      </div>
      <div class="grid md:grid-cols-3 gap-3 mt-5">
        ${renderScenarioCard('Bull Case', kp.bull, '#6ee7b7', bullUp)}
        ${renderScenarioCard('Base Case', kp.base, '#60a5fa', baseUp)}
        ${renderScenarioCard('Bear Case', kp.bear, '#f87171', bearUp)}
      </div>
      ${ks.begruendung ? `<p class="text-xs text-ink-300 mt-4 leading-snug border-l-2 border-ink-500 pl-3 py-1"><strong class="text-ink-200">Konfidenz-Begründung:</strong> ${escapeHtml(ks.begruendung)}</p>` : ''}
      ${kp.vergleich_analystenziel ? `<p class="text-xs text-ink-200 mt-2 leading-snug"><strong class="text-ink-300">vs. Analysten-Ziel:</strong> ${escapeHtml(kp.vergleich_analystenziel)}</p>` : ''}
    </div>`;

    // ---------- Drei-Jahres-Tabelle ----------
    const tableHeaderYears = pj.map(p => `<th class="num">FY${escapeHtml(String(p.fy ?? '+?'))}</th>`).join('');

    const renderRow = (label, key, fmtFn, isPct = false) => {
      const cells = pj.map(p => {
        const obj = p[key] || {};
        const bull = obj.bull, base = obj.base, bear = obj.bear;
        const intv = obj.intervall || {};
        return `<td class="num align-top">
          <div class="text-xs text-pos font-mono">▲ ${fmtFn(bull)}</div>
          <div class="text-sm font-bold font-mono text-ink-100">${fmtFn(base)}</div>
          <div class="text-xs text-neg font-mono">▼ ${fmtFn(bear)}</div>
          ${(intv.unten !== undefined && intv.oben !== undefined) ? `<div class="text-[10px] text-ink-400 mt-1 font-mono">KI: ${fmtFn(intv.unten)}–${fmtFn(intv.oben)}</div>` : ''}
        </td>`;
      }).join('');
      const tooltip = pj.map(p => p[key]?.kommentar).filter(Boolean).join(' · ');
      return `<tr><td><div class="font-medium text-ink-100">${escapeHtml(label)}</div>${tooltip ? `<div class="text-[10px] text-ink-400 mt-0.5">${escapeHtml(tooltip.slice(0, 120))}${tooltip.length > 120 ? '…' : ''}</div>` : ''}</td>${cells}</tr>`;
    };

    const tableHtml = pj.length ? `<div class="card mb-4">
      <h2>3-Jahres-Prognose · Bull / Base / Bear pro Jahr</h2>
      <p class="text-xs text-ink-300 mb-3">
        Pro Zelle: <span class="text-pos">▲ Bull</span> · <span class="font-bold">Base</span> (fett) · <span class="text-neg">▼ Bear</span>. Darunter das Konfidenzintervall.
        Beträge in Milliarden ${escapeHtml(cur)} (B), Margen in % vom Umsatz, EPS pro Aktie.
      </p>
      <div class="overflow-x-auto">
        <table class="data">
          <thead><tr><th>Kennzahl</th>${tableHeaderYears}</tr></thead>
          <tbody>
            ${renderRow('Umsatz', 'umsatz_b', fmtBnum)}
            ${renderRow('Net Income', 'net_income_b', fmtBnum)}
            ${renderRow('CapEx', 'capex_b', fmtBnum)}
            ${renderRow('Free Cash Flow', 'fcf_b', fmtBnum)}
            ${renderRow('EPS', 'eps', v => v === null || v === undefined || !Number.isFinite(+v) ? '—' : Number(v).toFixed(2))}
            ${renderRow('Operating Margin', 'operating_margin', fmtPctNum, true)}
            ${renderRow('Net Margin', 'net_margin', fmtPctNum, true)}
          </tbody>
        </table>
      </div>
    </div>` : '';

    // ---------- Markt-Kontext (TAM, Marktanteil, Konkurrenz) ----------
    const kk = mk.konkurrenzstaerke || {};
    const ma = mk.marktanteilsentwicklung || {};
    const marketHtml = `<div class="card mb-4">
      <h2>Markt-Kontext · TAM, Marktanteil &amp; Konkurrenz</h2>
      <p class="text-xs text-ink-300 mb-3">
        Strukturierte Annahmen, die die Prognose tragen — TAM-Wachstum, eigene Marktanteilsentwicklung
        und Wettbewerbsstärke. Diese drei Hebel bestimmen, ob Base, Bull oder Bear realistisch sind.
      </p>
      <div class="grid md:grid-cols-3 gap-4">
        <div>
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">TAM-Wachstum p.a.</div>
          <div class="text-2xl font-bold font-mono mb-1">${mk.tam_wachstum_pa !== null && mk.tam_wachstum_pa !== undefined ? (Number(mk.tam_wachstum_pa) * 100).toFixed(1) + '%' : '—'}</div>
          <p class="text-xs text-ink-200 leading-snug">${escapeHtml(mk.tam_wachstum_begruendung || '—')}</p>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Marktanteilsentwicklung</div>
          <div class="mb-2">${fcDirChip(ma.richtung)}</div>
          ${ma.implizierter_anteil_in_3j_pct !== null && ma.implizierter_anteil_in_3j_pct !== undefined ? `<div class="text-xs text-ink-300 mb-1">In 3J: <span class="font-mono text-ink-100">${ma.implizierter_anteil_in_3j_pct}%</span></div>` : ''}
          <p class="text-xs text-ink-200 leading-snug">${escapeHtml(ma.begruendung || '—')}</p>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Konkurrenzstärke (Risiko)</div>
          <div class="mb-2">${fcIntensityChip(kk.bewertung)}</div>
          <div class="grid grid-cols-3 gap-1.5 text-[10px] mb-2">
            <div><div class="text-ink-300">Intensität</div><div class="mt-0.5">${fcIntensityChip(kk.wettbewerbsintensitaet)}</div></div>
            <div><div class="text-ink-300">Barrieren</div><div class="mt-0.5">${fcIntensityChip(kk.markteintrittsbarrieren)}</div></div>
            <div><div class="text-ink-300">Substitution</div><div class="mt-0.5">${fcIntensityChip(kk.substitutionsrisiko)}</div></div>
          </div>
          <p class="text-xs text-ink-200 leading-snug">${escapeHtml(kk.begruendung || '—')}</p>
        </div>
      </div>
    </div>`;

    // ---------- Implikation auf Bewertung & Scorecard ----------
    const impHtml = `<div class="card mb-4">
      <h2>Implikation für Bewertung &amp; Scorecard</h2>
      <div class="flex items-start gap-3 flex-wrap mb-3">
        <span class="text-xs text-ink-300 uppercase tracking-wider">Fair-Value-Adjustment:</span>
        ${fcOutlookChip(bi.fair_value_adjustment)}
      </div>
      ${bi.begruendung ? `<p class="text-sm text-ink-100 leading-relaxed mb-3">${escapeHtml(bi.begruendung)}</p>` : ''}
      ${bi.scorecard_impact ? `<div class="border-l-2 pl-3 py-1 text-sm text-ink-200" style="border-color: rgba(96,165,250,0.5)"><strong class="text-ink-300">Scorecard-Effekt:</strong> ${escapeHtml(bi.scorecard_impact)}</div>` : ''}
    </div>`;

    // ---------- Quellen & Limitierungen ----------
    const q = f.quellen || {};
    const primQ = Array.isArray(q['primär']) ? q['primär'] : (Array.isArray(q.primaer) ? q.primaer : []);
    const lim = Array.isArray(q.limitierungen) ? q.limitierungen : [];
    const sourcesHtml = `<div class="card">
      <h2>Datenbasis &amp; Limitierungen</h2>
      <div class="grid md:grid-cols-2 gap-4">
        <div>
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Primäre Quellen</div>
          <ul class="text-sm text-ink-100 space-y-1">
            ${primQ.length ? primQ.map(s => `<li class="flex gap-2"><span class="text-accent">▸</span><span>${escapeHtml(s)}</span></li>`).join('') : '<li class="text-ink-300">—</li>'}
          </ul>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Limitierungen / Datenlücken</div>
          <ul class="text-sm text-ink-100 space-y-1">
            ${lim.length ? lim.map(s => `<li class="flex gap-2"><span class="text-accent-warm">!</span><span>${escapeHtml(s)}</span></li>`).join('') : '<li class="text-ink-300">— keine vermerkt —</li>'}
          </ul>
        </div>
      </div>
      ${dq.begruendung ? `<p class="text-xs text-ink-300 mt-4 leading-snug border-t border-ink-600/60 pt-3"><strong class="text-ink-200">Vertrauen:</strong> ${escapeHtml(dq.vertrauen_overall || '—')} — ${escapeHtml(dq.begruendung)}</p>` : ''}
      <div class="text-xs text-ink-300 mt-3">
        <strong class="text-ink-200">KI-Modell:</strong> ${escapeHtml(meta.model || '?')} ·
        <strong class="text-ink-200">Tokens:</strong> ${meta.usage?.total_tokens ?? '?'} ·
        <strong class="text-ink-200">Hinweis:</strong> KI-gestützte Prognose, keine Anlageberatung.
        Zukünftige Ereignisse können stark abweichen.
      </div>
    </div>`;

    // Issue 17: SEC-Status-Hinweis vor der Prognose, falls Daten partial/missing/timeout
    const secBannerForecast = renderSecStatusBanner(state);

    tab.innerHTML = secBannerForecast + headerHtml + priceTargetHtml + tableHtml + marketHtml + impHtml + sourcesHtml;
  }

  function paintKIAnalysisSkeleton() {
    $('#tab-ki').innerHTML = `<div class="card">
      <h2>KI-Analyse</h2>
      <div class="text-ink-300 text-sm">DeepSeek V4 analysiert die Daten — kann 15-40 Sekunden dauern <span class="spinner"></span></div>
    </div>`;
  }

  // Konsolidierter KI-Report (Issue 6): spiegelt den PDF-Inhalt im Web wider —
  // Steckbrief, Investment-These, Burggraben, KI-Risiken, Szenarien, plus —
  // sobald geladen — das ausführliche Fazit (Stärken/Schwächen/Chancen/Risiken,
  // Handlungsempfehlung) und eine konsolidierte Quellen-Liste.
  // Wird mehrfach gerufen, wenn nachgelagerte Pässe (deep, news6m, industry,
  // conclusion) fertig werden, damit der Report inkrementell „aufpoppt".
  function paintKIAnalysis(state, resultArg) {
    const result = resultArg || state.analysisMeta || {};
    const ana = state.analysis;
    if (!ana) {
      $('#tab-ki').innerHTML = `<div class="card">
        <h2>KI-Analyse</h2>
        <p class="text-accent-bad">JSON-Parsing fehlgeschlagen. Roh-Antwort:</p>
        <pre class="text-xs text-ink-300 bg-ink-900 p-3 rounded mt-2 overflow-auto max-h-96">${escapeHtml(result.raw_excerpt || '')}</pre>
      </div>`;
      return;
    }

    const moat = ana.burggraben || {};
    const faktoren = moat.faktoren || {};
    // Issue 19: zusätzliche Moat-Faktoren (Marktanteil, Kundeneinbindung,
    // Lieferketten, Replikationsrisiko). Die KI-Übersichts-Analyse hat
    // i.d.R. nur die ersten 6 — wir fallen für die Detailliste auf die
    // Deep-Analysis-Burggraben-Sektion zurück, sodass kein Eintrag leer
    // bleibt, wenn die Tiefenanalyse schon vorliegt.
    const moatDetail = state.deep?.deep?.burggraben_detail || state.deep?.burggraben_detail || {};
    const faktorList = [
      ['marken', 'Markenstärke'],
      ['wechselkosten', 'Wechselkosten'],
      ['netzwerkeffekte', 'Netzwerkeffekte'],
      ['skaleneffekte', 'Skaleneffekte'],
      ['preissetzungsmacht', 'Preissetzungsmacht'],
      ['patente_ip', 'Patente / IP'],
      ['marktanteil', 'Marktanteil'],
      ['kundeneinbindung', 'Kundeneinbindung'],
      ['lieferkettenzugang', 'Lieferkettenzugang'],
      ['replikationsrisiko', 'Replikationsrisiko'],
    ];
    // Detail-Faktoren aus Tiefenanalyse mergen, falls in ana.burggraben.faktoren leer
    for (const [k] of faktorList) {
      if ((!faktoren[k] || !faktoren[k].staerke) && moatDetail[k]) {
        faktoren[k] = { staerke: moatDetail[k].staerke, beleg: moatDetail[k].beleg };
      }
    }
    const szen = ana.szenarien || {};
    const it = ana.investment_these || {};
    const concl = state.conclusion;

    // --- Header-Hero: Kernaussage (aus Conclusion, falls vorhanden) ---
    const heroHtml = concl?.kernaussage ? `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(96,165,250,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(96,165,250,0.3);">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <div>
            <h2 class="!mb-1">KI-Report — Konsolidierte Analyse</h2>
            <p class="text-xs text-ink-300">Alle KI-Aussagen aus Übersicht, Tiefenanalyse, News-Auswertung &amp; Fazit auf einen Blick — entspricht dem PDF-Report.</p>
          </div>
          ${concl.datenqualitaet?.vertrauen ? confidenceChip(concl.datenqualitaet.vertrauen) : ''}
        </div>
        <p class="text-base text-ink-100 leading-relaxed font-medium">${escapeHtml(concl.kernaussage)}</p>
      </div>` : `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(96,165,250,0.04) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(96,165,250,0.25);">
        <div class="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2 class="!mb-1">KI-Report — Konsolidierte Analyse</h2>
            <p class="text-xs text-ink-300">Alle KI-Aussagen aus Übersicht, Tiefenanalyse, News-Auswertung &amp; Fazit auf einen Blick — entspricht dem PDF-Report.</p>
          </div>
          ${state.conclusion ? '' : '<span class="text-xs text-ink-300">Konsolidiertes Fazit lädt <span class="spinner"></span></span>'}
        </div>
      </div>`;

    // --- Investment-These ---
    const itHtml = (it.pro?.length || it.contra?.length || it.fazit) ? `
      <div class="card lg:col-span-3">
        <h2>Investment-These</h2>
        ${it.fazit ? `<p class="text-sm text-ink-100 leading-relaxed mb-4 font-medium border-l-2 pl-3 py-1" style="border-color: rgba(96,165,250,0.6)">${escapeHtml(it.fazit)}</p>` : ''}
        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <div class="text-xs uppercase tracking-wider text-pos mb-2">Pro-Argumente</div>
            <ul class="space-y-1.5 text-sm">
              ${(it.pro || []).map(p => `<li class="flex gap-2"><span class="text-pos">+</span><span>${escapeHtml(p)}</span></li>`).join('') || '<li class="text-ink-300">—</li>'}
            </ul>
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider text-neg mb-2">Contra-Argumente</div>
            <ul class="space-y-1.5 text-sm">
              ${(it.contra || []).map(c => `<li class="flex gap-2"><span class="text-neg">−</span><span>${escapeHtml(c)}</span></li>`).join('') || '<li class="text-ink-300">—</li>'}
            </ul>
          </div>
        </div>
      </div>` : '';

    // --- KI-identifizierte Risiken (gespiegelt aus dem Risiken-Tab, damit der Report eigenständig vollständig ist) ---
    const risikenAna = ana.risiken || [];
    const risikenHtml = risikenAna.length ? `
      <div class="card lg:col-span-3">
        <h2>KI-identifizierte Risiken</h2>
        <table class="data">
          <thead><tr><th>Risiko</th><th>Wahrscheinlichkeit</th><th>Auswirkung</th></tr></thead>
          <tbody>
            ${risikenAna.map(r => `
              <tr>
                <td>
                  <div class="font-medium text-ink-100">${escapeHtml(r.risiko || '—')}</div>
                  <div class="text-xs text-ink-300 mt-0.5">${escapeHtml(r.details || '')}</div>
                </td>
                <td>${probChip(r.wahrscheinlichkeit)}</td>
                <td>${probChip(r.auswirkung)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    // --- Bewertungs-Kommentar ---
    const bkHtml = ana.bewertung_kommentar ? `
      <div class="card lg:col-span-3">
        <h2>Bewertungs-Einschätzung</h2>
        <p class="text-sm text-ink-100 leading-relaxed">${escapeHtml(ana.bewertung_kommentar)}</p>
      </div>` : '';

    // --- Konsolidiertes Fazit (Stärken / Schwächen / Chancen / Risiken) ---
    const fazitHtml = concl ? renderConclusionInKi(concl, state) : `
      <div class="card lg:col-span-3">
        <h2>Konsolidiertes Fazit — Stärken · Schwächen · Chancen · Risiken</h2>
        <p class="text-ink-300 text-sm">Wird mit dem ausführlichen Fazit generiert <span class="spinner"></span></p>
      </div>`;

    // --- News-Zusammenfassung (kompakt — Konzept verlangt Sichtbarkeit) ---
    const news6m = state.news6m;
    const newsSummaryHtml = (news6m && news6m.ai && !news6m.error) ? `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <h2 class="!mb-0">News-Zusammenfassung (6 Monate)</h2>
          ${sentimentChip(news6m.ai.sentiment)}
        </div>
        ${news6m.ai.summary ? `<p class="text-sm text-ink-100 leading-relaxed mb-3">${escapeHtml(news6m.ai.summary)}</p>` : ''}
        ${(news6m.ai.top_themen || []).length ? `
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Top-Themen</div>
          <ul class="space-y-1.5 text-sm mb-2">
            ${news6m.ai.top_themen.slice(0, 6).map(t => `<li class="flex gap-2 items-start">
              <span class="text-accent-info">▸</span>
              <span class="flex-1"><span class="font-medium">${escapeHtml(t.thema || '—')}</span> — ${escapeHtml(t.details || '')}</span>
              ${tendenzChip(t.tendenz)}
            </li>`).join('')}
          </ul>` : ''}
      </div>` : '';

    // --- Branche kompakt ---
    const industry = state.industry;
    const indHtml = (industry && industry.ai && (industry.ai.gesamteinschaetzung || industry.ai.fazit_fuer_firma)) ? `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <h2 class="!mb-0">Branchen-Kontext</h2>
          <div class="flex flex-wrap gap-1.5">
            ${outlookChip(industry.ai.gesamteinschaetzung?.ausblick)}
            ${phaseChip(industry.ai.gesamteinschaetzung?.wachstumsphase)}
          </div>
        </div>
        ${industry.ai.gesamteinschaetzung?.zusammenfassung ? `<p class="text-sm text-ink-100 leading-relaxed mb-2">${escapeHtml(industry.ai.gesamteinschaetzung.zusammenfassung)}</p>` : ''}
        ${industry.ai.fazit_fuer_firma ? `<p class="text-xs text-ink-200 italic">Bezug zur Firma: ${escapeHtml(industry.ai.fazit_fuer_firma)}</p>` : ''}
      </div>` : '';

    // --- Handlungsempfehlung (aus Conclusion) ---
    const h = concl?.handlungsempfehlung || null;
    const hTypMap = {
      'weiter-beobachten': 'Weiter beobachten',
      'tiefer-prüfen': 'Tiefer prüfen',
      'tiefer-pruefen': 'Tiefer prüfen',
      'warten-auf-katalysator': 'Auf Katalysator warten',
      'nicht-interessant': 'Aktuell nicht interessant',
    };
    const hTyp = h ? (hTypMap[String(h.typ || '').toLowerCase()] || (h.typ || '—')) : '';
    const handlungHtml = h ? `
      <div class="card lg:col-span-3">
        <h2>Handlungsempfehlung</h2>
        <div class="flex items-center gap-2 flex-wrap mb-2">
          <span class="chip chip-very-strong">${escapeHtml(hTyp)}</span>
        </div>
        <p class="text-sm text-ink-100 leading-relaxed mb-3">${escapeHtml(h.begruendung || '—')}</p>
        ${Array.isArray(h.beobachtungspunkte) && h.beobachtungspunkte.length ? `
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Beobachtungspunkte</div>
          <ul class="space-y-1.5 text-sm">
            ${h.beobachtungspunkte.map(b => `<li class="flex gap-2"><span class="text-accent">▸</span><span>${escapeHtml(b)}</span></li>`).join('')}
          </ul>` : ''}
        ${concl.gesamteinschaetzung ? `
          <div class="mt-4 pt-3 border-t border-ink-600/60">
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Gesamteinschätzung</div>
            <p class="text-sm text-ink-100 leading-relaxed">${escapeHtml(concl.gesamteinschaetzung)}</p>
          </div>` : ''}
      </div>` : '';

    // --- Quellen & Datenbasis (entspricht dem PDF-Quellenanhang) ---
    const sourcesHtml = renderKiReportSources(state);

    $('#tab-ki').innerHTML = `
      ${heroHtml}
      <div class="grid lg:grid-cols-3 gap-4">
        <div class="card lg:col-span-2">
          <h2>Steckbrief</h2>
          <p class="text-ink-100 mb-2"><strong class="text-accent">Kurzbeschreibung:</strong> ${escapeHtml(ana.steckbrief?.kurzbeschreibung || '—')}</p>
          <p class="text-sm text-ink-200 leading-relaxed mb-3"><strong class="text-ink-300">Geschäftsmodell:</strong> ${escapeHtml(ana.steckbrief?.geschaeftsmodell || '—')}</p>
          <p class="text-sm text-ink-200 leading-relaxed"><strong class="text-ink-300">Marktposition:</strong> ${escapeHtml(ana.steckbrief?.marktposition || '—')}</p>
        </div>

        <div class="card">
          <h2>Burggraben-Score</h2>
          ${ringSvg(moat.score, 'Moat', scoreColor(moat.score))}
          <p class="text-xs text-ink-200 mt-3">${escapeHtml(moat.begruendung || '—')}</p>
        </div>

        ${itHtml}

        <div class="card lg:col-span-3">
          <h2>Burggraben-Faktoren</h2>
          <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${faktorList.map(([k, label]) => `
              <div class="rounded-md border border-ink-600 p-3">
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-sm text-ink-100 font-medium">${label}</span>
                  ${strengthChip(faktoren[k]?.staerke)}
                </div>
                <p class="text-xs text-ink-300">${escapeHtml(faktoren[k]?.beleg || '—')}</p>
              </div>`).join('')}
          </div>
        </div>

        ${fazitHtml}

        <div class="card">
          <h2>Wachstumstreiber</h2>
          <ul class="space-y-2 text-sm">
            ${(ana.wachstumstreiber || []).map(w => `<li class="flex gap-2"><span class="text-accent">▸</span><span>${escapeHtml(w)}</span></li>`).join('') || '<li class="text-ink-300">—</li>'}
          </ul>
        </div>

        <div class="card">
          <h2>Katalysatoren</h2>
          <ul class="space-y-2 text-sm">
            ${(ana.katalysatoren || []).map(k => `<li class="flex gap-2"><span class="text-accent-info">▸</span><span>${escapeHtml(k)}</span></li>`).join('') || '<li class="text-ink-300">—</li>'}
          </ul>
        </div>

        <div class="card">
          <h2>Datenqualität (KI-Selbst-Einschätzung)</h2>
          <div class="flex items-center gap-2 mb-3">
            <span class="text-sm text-ink-300">Vertrauen:</span>
            ${probChip(ana.datenqualitaet?.vertrauen)}
          </div>
          <p class="text-xs text-ink-200 mb-1">Lücken:</p>
          <ul class="text-xs text-ink-300 space-y-1">
            ${(ana.datenqualitaet?.luecken || []).map(l => `<li>· ${escapeHtml(l)}</li>`).join('') || '<li>—</li>'}
          </ul>
        </div>

        ${risikenHtml}

        <div class="card lg:col-span-3">
          <h2>Szenarien</h2>
          <div class="grid md:grid-cols-3 gap-3">
            ${renderScenario('Bull Case', szen.bull, '#6ee7b7')}
            ${renderScenario('Base Case', szen.base, '#60a5fa')}
            ${renderScenario('Bear Case', szen.bear, '#f87171')}
          </div>
        </div>

        ${bkHtml}
        ${newsSummaryHtml}
        ${indHtml}
        ${handlungHtml}
        ${sourcesHtml}

        <div class="card lg:col-span-3 text-xs text-ink-300">
          <strong class="text-ink-200">KI-Modell (Übersicht):</strong> ${escapeHtml(result.model || '?')} ·
          <strong class="text-ink-200">Tokens:</strong> ${result.usage?.total_tokens ?? '?'}${state.conclusionMeta?.model ? ` · <strong class="text-ink-200">Fazit-Modell:</strong> ${escapeHtml(state.conclusionMeta.model)}` : ''} ·
          <strong class="text-ink-200">Hinweis:</strong> Diese Analyse ist eine Hypothese auf Basis öffentlicher Daten — keine Anlageberatung.
        </div>
      </div>`;

    // Update valuation comment if Bewertung-Tab visible
    const vc = document.getElementById('valuation-comment');
    if (vc && ana.bewertung_kommentar) vc.innerHTML = escapeHtml(ana.bewertung_kommentar);
  }

  // Stärken / Schwächen / Chancen / Risiken im KI-Report — kompakt 2x2,
  // mit Quellen-Badge pro Punkt (entspricht dem PDF-Layout).
  function renderConclusionInKi(c, state) {
    const list = (items, color) => {
      if (!Array.isArray(items) || !items.length) return '<p class="text-ink-300 text-sm">—</p>';
      return `<ul class="space-y-2">
        ${items.map(it => `<li class="border-l-2 pl-3 py-0.5" style="border-color:${color}80">
          <div class="flex items-start justify-between gap-3 flex-wrap mb-0.5">
            <span class="font-medium text-ink-100 text-sm">${escapeHtml(it.punkt || '—')}</span>
            ${quellenBadge(it.quelle)}
          </div>
          ${it.details ? `<p class="text-xs text-ink-300 leading-relaxed">${escapeHtml(it.details)}</p>` : ''}
        </li>`).join('')}
      </ul>`;
    };
    return `
      <div class="card lg:col-span-3">
        <h2>Konsolidiertes Fazit — Stärken · Schwächen · Chancen · Risiken</h2>
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div class="text-xs uppercase tracking-wider text-pos mb-2">Stärken</div>
            ${list(c.staerken, '#6ee7b7')}
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider text-neg mb-2">Schwächen</div>
            ${list(c.schwaechen, '#f87171')}
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider mb-2" style="color:#60a5fa">Chancen</div>
            ${list(c.chancen, '#60a5fa')}
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider mb-2" style="color:#fbbf24">Risiken</div>
            ${list(c.risiken, '#fbbf24')}
          </div>
        </div>
      </div>`;
  }

  // Konsolidierte Quellen-Liste — spiegelt den „Quellen & Datenbasis"-Anhang
  // des PDF-Reports. Bezieht News 6m, Branche, Tiefenanalyse-Suchen, SEC-Filings
  // und aktuelle News ein, jeweils kategorisiert + verlinkt.
  function renderKiReportSources(state) {
    const all = [];
    (state.news6m?.results || []).slice(0, 12).forEach(n => {
      if (n?.url) all.push({ kategorie: 'News 6m', title: n.title || n.url, url: n.url });
    });
    (state.industry?.sources || []).slice(0, 10).forEach(n => {
      if (n?.url) all.push({ kategorie: 'Branche', title: n.title || n.url, url: n.url });
    });
    (state.deep?.sources?.competitor_search || []).slice(0, 6).forEach(n => {
      if (n?.url) all.push({ kategorie: 'Tiefenanalyse: Wettbewerber', title: n.title || n.url, url: n.url });
    });
    (state.deep?.sources?.market_search || []).slice(0, 6).forEach(n => {
      if (n?.url) all.push({ kategorie: 'Tiefenanalyse: Markt', title: n.title || n.url, url: n.url });
    });
    (state.filings || []).slice(0, 8).forEach(f => {
      if (f?.url) all.push({
        kategorie: 'SEC ' + (f.form || ''),
        title: `Eingereicht ${fmt.date(f.date)} (Stichtag ${fmt.date(f.report_date)})`,
        url: f.url,
      });
    });
    (state.news || []).slice(0, 8).forEach(n => {
      if (n?.url) all.push({ kategorie: 'News (aktuell)', title: n.title || n.url, url: n.url });
    });

    if (!all.length) return '';

    // Kategorien-Reihenfolge stabil halten (gruppiert ausgeben)
    const order = ['News 6m', 'Branche', 'Tiefenanalyse: Wettbewerber', 'Tiefenanalyse: Markt', 'News (aktuell)'];
    const groups = new Map();
    for (const s of all) {
      const key = order.includes(s.kategorie) ? s.kategorie : (s.kategorie.startsWith('SEC') ? 'SEC-Filings' : s.kategorie);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const sortedKeys = [...groups.keys()].sort((a, b) => {
      const ai = order.indexOf(a); const bi = order.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });

    const groupsHtml = sortedKeys.map(k => {
      const items = groups.get(k);
      return `<div class="mb-3 last:mb-0">
        <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">${escapeHtml(k)} <span class="text-ink-400">(${items.length})</span></div>
        <ul class="space-y-1.5">
          ${items.map(s => `<li class="border-l-2 border-ink-500 pl-3 py-0.5">
            <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="block group">
              <div class="text-sm text-ink-100 group-hover:text-accent transition leading-snug">${escapeHtml(s.title)}</div>
              <div class="text-[10px] text-ink-400 mt-0.5 font-mono">${escapeHtml(safeHostname(s.url))}</div>
            </a>
          </li>`).join('')}
        </ul>
      </div>`;
    }).join('');

    return `<div class="card lg:col-span-3">
      <h2>Quellen &amp; Datenbasis (${all.length})</h2>
      <p class="text-xs text-ink-300 mb-3">Kategorisierte Quellen — entspricht dem Anhang im PDF-Report. Jeder Eintrag führt direkt zur Original-Quelle.</p>
      ${groupsHtml}
    </div>`;
  }

  // ---------------------------------------------------------------------
  // KI-Tiefenanalyse (Issue 2)
  // ---------------------------------------------------------------------
  function paintDeepAnalysisSkeleton() {
    $('#tab-tiefen').innerHTML = `
      <div class="card">
        <h2>KI-Tiefenanalyse</h2>
        <p class="text-sm text-ink-200 mb-2">
          Detaillierte Analyse zu Geschäftsmodell, Zukunftsfähigkeit, Konkurrenz und Burggraben —
          mit Quellenangaben (SEC, News, Web) und Confidence-Level je Sektion.
        </p>
        <div class="text-ink-300 text-sm">
          DeepSeek V4 sammelt Websuchen zu Wettbewerbern + Markttrends und erstellt die Tiefenanalyse —
          das kann 20-50 Sekunden dauern <span class="spinner"></span>
        </div>
      </div>`;
  }

  function confidenceChip(c) {
    const v = String(c || '').toLowerCase();
    const cls = v === 'hoch' ? 'chip-strong' : v === 'mittel' ? 'chip-medium' : v === 'niedrig' ? 'chip-weak' : 'chip-medium';
    const lbl = v === 'hoch' ? 'Confidence: hoch' : v === 'mittel' ? 'Confidence: mittel' : v === 'niedrig' ? 'Confidence: niedrig' : 'Confidence: —';
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function directionChip(d) {
    const v = String(d || '').toLowerCase();
    const map = {
      'rueckenwind': ['chip-strong', '↗ Rückenwind'],
      'positiv': ['chip-strong', '↗ Positiv'],
      'gegenwind': ['chip-weak', '↘ Gegenwind'],
      'negativ': ['chip-weak', '↘ Negativ'],
      'neutral': ['chip-medium', '→ Neutral'],
    };
    const [cls, lbl] = map[v] || ['chip-medium', escapeHtml(d || '—')];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function tamChip(v) {
    const x = String(v || '').toLowerCase();
    const map = {
      'stark-wachsend': ['chip-very-strong', 'TAM: stark wachsend'],
      'wachsend': ['chip-strong', 'TAM: wachsend'],
      'stagnierend': ['chip-medium', 'TAM: stagnierend'],
      'schrumpfend': ['chip-weak', 'TAM: schrumpfend'],
    };
    const [cls, lbl] = map[x] || ['chip-medium', 'TAM: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function disruptionChip(v) {
    const x = String(v || '').toLowerCase();
    const map = {
      'niedrig': ['chip-strong', 'Disruption: niedrig'],
      'mittel': ['chip-medium', 'Disruption: mittel'],
      'hoch': ['chip-weak', 'Disruption: hoch'],
      'sehr-hoch': ['chip-weak', 'Disruption: sehr hoch'],
    };
    const [cls, lbl] = map[x] || ['chip-medium', 'Disruption: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function powerChip(v) {
    const x = String(v || '').toLowerCase();
    const map = {
      'niedrig': ['chip-weak', 'Preissetzung: niedrig'],
      'mittel': ['chip-medium', 'Preissetzung: mittel'],
      'hoch': ['chip-strong', 'Preissetzung: hoch'],
      'sehr-hoch': ['chip-very-strong', 'Preissetzung: sehr hoch'],
    };
    const [cls, lbl] = map[x] || ['chip-medium', 'Preissetzung: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function scalabilityChip(v) {
    const x = String(v || '').toLowerCase();
    const map = {
      'niedrig': ['chip-weak', 'Skalierbarkeit: niedrig'],
      'mittel': ['chip-medium', 'Skalierbarkeit: mittel'],
      'hoch': ['chip-strong', 'Skalierbarkeit: hoch'],
      'sehr-hoch': ['chip-very-strong', 'Skalierbarkeit: sehr hoch'],
    };
    const [cls, lbl] = map[x] || ['chip-medium', 'Skalierbarkeit: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function techChip(v) {
    const x = String(v || '').toLowerCase();
    const map = {
      'fuehrend': ['chip-very-strong', 'Tech: führend'],
      'wettbewerbsfaehig': ['chip-strong', 'Tech: wettbewerbsfähig'],
      'hinterher': ['chip-weak', 'Tech: hinterher'],
      'gefaehrdet': ['chip-weak', 'Tech: gefährdet'],
    };
    const [cls, lbl] = map[x] || ['chip-medium', 'Tech: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function sourceChip(s) {
    const v = String(s || '').toLowerCase();
    const map = {
      'sec': ['chip-very-strong', 'SEC'],
      'news': ['chip-strong', 'News'],
      'web': ['chip-medium', 'Web'],
      'schaetzung': ['chip-weak', 'Schätzung'],
    };
    const [cls, lbl] = map[v] || ['chip-medium', escapeHtml(s || '—')];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function renderSourceList(urls, sectionId) {
    if (!Array.isArray(urls) || !urls.length) return '<p class="text-xs text-ink-300">— Keine Quellen verlinkt —</p>';
    return `<ul class="space-y-1 text-xs">
      ${urls.map(u => {
        const isUrl = /^https?:\/\//i.test(String(u));
        if (isUrl) {
          const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
          return `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener" class="text-accent-info hover:underline break-all">${escapeHtml(u)}</a> <span class="text-ink-400">${escapeHtml(host)}</span></li>`;
        }
        return `<li class="text-ink-200">· ${escapeHtml(String(u))}</li>`;
      }).join('')}
    </ul>`;
  }

  function estimateBanner(note) {
    if (!note) return '';
    return `<div class="estimate-note mt-3"><span class="text-accent-warm font-medium">⚠ Geschätzt:</span> ${escapeHtml(note)}</div>`;
  }

  function paintDeepAnalysis(state, result) {
    const d = result?.deep;
    if (!d) {
      $('#tab-tiefen').innerHTML = `<div class="card">
        <h2>KI-Tiefenanalyse</h2>
        <p class="text-accent-bad">JSON-Parsing fehlgeschlagen. Roh-Antwort:</p>
        <pre class="text-xs text-ink-300 bg-ink-900 p-3 rounded mt-2 overflow-auto max-h-96">${escapeHtml(result?.raw_excerpt || '')}</pre>
      </div>`;
      return;
    }

    const gm = d.geschaeftsmodell || {};
    const zf = d.zukunftsfaehigkeit || {};
    const kk = d.konkurrenz || {};
    const moat = d.burggraben_detail || {};
    const dq = d.datenqualitaet || {};
    const sources = result.sources || {};

    // --- Geschäftsmodell ---
    const umsatzRows = (gm.umsatzquellen || []).map(s => {
      const pct = s.anteil_pct === null || s.anteil_pct === undefined ? '—' : Number(s.anteil_pct).toFixed(0) + '%';
      const bar = s.anteil_pct ? `<div class="bar mt-1.5"><div style="width:${Math.min(100, Number(s.anteil_pct))}%"></div></div>` : '';
      return `<div class="border-l-2 border-ink-500 pl-3 py-1">
        <div class="flex items-baseline justify-between gap-3">
          <span class="font-medium text-ink-100">${escapeHtml(s.name || '—')}</span>
          <span class="font-mono text-sm text-accent-info">${pct}</span>
        </div>
        ${bar}
        <p class="text-xs text-ink-300 mt-1">${escapeHtml(s.beschreibung || '')}</p>
      </div>`;
    }).join('') || '<p class="text-ink-300 text-sm">— Keine Segmentaufteilung verfügbar —</p>';

    const dependsList = (gm.abhaengigkeiten || []).map(a =>
      `<li class="flex gap-2"><span class="text-accent-warm">⚠</span><span>${escapeHtml(a)}</span></li>`
    ).join('') || '<li class="text-ink-300">—</li>';

    const gmHtml = `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <h2 class="!mb-0">① Geschäftsmodell</h2>
          <div class="flex flex-wrap gap-1.5">
            ${gm.typ ? `<span class="chip chip-very-strong">${escapeHtml(gm.typ)}</span>` : ''}
            ${scalabilityChip(gm.skalierbarkeit?.bewertung)}
            ${confidenceChip(gm.confidence)}
          </div>
        </div>
        <p class="text-sm text-ink-100 leading-relaxed mb-4">${escapeHtml(gm.wie_geld_verdient || '—')}</p>

        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Umsatzquellen</div>
            <div class="space-y-2">${umsatzRows}</div>
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Skalierbarkeit</div>
            <p class="text-sm text-ink-200 mb-3">${escapeHtml(gm.skalierbarkeit?.begruendung || '—')}</p>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Schlüssel-Abhängigkeiten</div>
            <ul class="space-y-1.5 text-sm">${dependsList}</ul>
          </div>
        </div>

        ${estimateBanner(gm.estimate_note)}
        <div class="mt-4 pt-3 border-t border-ink-600/60">
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Quellen</div>
          ${renderSourceList(gm.quellen)}
        </div>
      </div>`;

    // --- Zukunftsfähigkeit ---
    const trendRows = (zf.markttrends || []).map(t => `
      <div class="border-l-2 border-ink-500 pl-3 py-1">
        <div class="flex items-baseline justify-between gap-3 flex-wrap">
          <span class="font-medium text-ink-100">${escapeHtml(t.trend || '—')}</span>
          ${directionChip(t.richtung)}
        </div>
        <p class="text-xs text-ink-300 mt-1">${escapeHtml(t.details || '')}</p>
      </div>
    `).join('') || '<p class="text-ink-300 text-sm">— Keine Markttrends erkannt —</p>';

    const zfHtml = `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
          <h2 class="!mb-0">② Zukunftsfähigkeit</h2>
          <div class="flex flex-wrap gap-1.5">
            ${tamChip(zf.tam_wachstum?.einschaetzung)}
            ${disruptionChip(zf.disruptionsrisiko?.niveau)}
            ${techChip(zf.technologie?.bewertung)}
            ${directionChip(zf.regulatorisch?.bewertung)}
            ${confidenceChip(zf.confidence)}
          </div>
        </div>

        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Markttrends</div>
            <div class="space-y-2">${trendRows}</div>
          </div>
          <div class="space-y-3">
            <div>
              <div class="text-xs uppercase tracking-wider text-ink-300 mb-1">Technologie-Position</div>
              <p class="text-sm text-ink-200">${escapeHtml(zf.technologie?.details || '—')}</p>
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-ink-300 mb-1">Regulatorisches Umfeld</div>
              <p class="text-sm text-ink-200">${escapeHtml(zf.regulatorisch?.details || '—')}</p>
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-ink-300 mb-1">TAM-Wachstum</div>
              <p class="text-sm text-ink-200">${escapeHtml(zf.tam_wachstum?.begruendung || '—')}</p>
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-ink-300 mb-1">Disruptionsrisiko</div>
              <p class="text-sm text-ink-200">${escapeHtml(zf.disruptionsrisiko?.begruendung || '—')}</p>
            </div>
          </div>
        </div>

        ${estimateBanner(zf.estimate_note)}
        <div class="mt-4 pt-3 border-t border-ink-600/60">
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Quellen</div>
          ${renderSourceList(zf.quellen)}
        </div>
      </div>`;

    // --- Konkurrenz ---
    const compRows = (kk.hauptwettbewerber || []).map(c => {
      const tk = c.ticker ? `<a href="#" class="text-accent font-mono text-xs ml-2" data-deep-peer="${escapeHtml(c.ticker)}">${escapeHtml(c.ticker)}</a>` : '';
      const share = c.marktanteil_pct === null || c.marktanteil_pct === undefined ? '—' : Number(c.marktanteil_pct).toFixed(1) + '%';
      return `
        <tr>
          <td>
            <span class="font-medium text-ink-100">${escapeHtml(c.name || '—')}</span>${tk}
          </td>
          <td class="num">${share}</td>
          <td class="text-xs">${escapeHtml(c.staerken || '—')}</td>
          <td class="text-xs text-ink-300">${escapeHtml(c.schwaechen || '—')}</td>
        </tr>`;
    }).join('');

    const ownShare = kk.eigener_marktanteil_pct === null || kk.eigener_marktanteil_pct === undefined ? '—' : Number(kk.eigener_marktanteil_pct).toFixed(1) + '%';

    const advList = (kk.wettbewerbsvorteile || []).map(v =>
      `<li class="flex gap-2"><span class="text-accent">▸</span><span>${escapeHtml(v)}</span></li>`
    ).join('') || '<li class="text-ink-300">—</li>';

    const kkHtml = `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
          <h2 class="!mb-0">③ Konkurrenz &amp; Marktstruktur</h2>
          <div class="flex flex-wrap gap-1.5">
            ${kk.marktstruktur ? `<span class="chip chip-medium">Markt: ${escapeHtml(kk.marktstruktur)}</span>` : ''}
            ${powerChip(kk.preissetzungsmacht?.bewertung)}
            <span class="chip chip-medium">Eigener Anteil: ${ownShare}</span>
            ${confidenceChip(kk.confidence)}
          </div>
        </div>

        <div class="grid md:grid-cols-3 gap-4 mb-4">
          <div class="md:col-span-2">
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Hauptwettbewerber</div>
            ${compRows ? `<table class="data">
              <thead><tr><th>Firma</th><th class="num">Marktanteil</th><th>Stärken</th><th>Schwächen</th></tr></thead>
              <tbody>${compRows}</tbody>
            </table>` : '<p class="text-ink-300 text-sm">— Keine Wettbewerber identifiziert —</p>'}
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">Eigene Wettbewerbsvorteile</div>
            <ul class="space-y-1.5 text-sm">${advList}</ul>
            <div class="text-xs uppercase tracking-wider text-ink-300 mt-4 mb-1">Preissetzungsmacht</div>
            <p class="text-sm text-ink-200">${escapeHtml(kk.preissetzungsmacht?.begruendung || '—')}</p>
          </div>
        </div>

        ${estimateBanner(kk.estimate_note)}
        <div class="mt-2 pt-3 border-t border-ink-600/60">
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Quellen</div>
          ${renderSourceList(kk.quellen)}
        </div>
      </div>`;

    // --- Burggraben (detailliert) — Issue 19: erweitert um Marktanteil,
    //     Kundeneinbindung, Lieferkettenzugang, Replikationsrisiko ---
    const moatItems = [
      ['marken', 'Markenwert'],
      ['wechselkosten', 'Wechselkosten'],
      ['netzwerkeffekte', 'Netzwerkeffekte'],
      ['kostenvorteile', 'Kostenvorteile'],
      ['skaleneffekte', 'Skaleneffekte'],
      ['regulatorische_barrieren', 'Regulatorische Barrieren'],
      ['ip_patente', 'IP / Patente'],
      ['marktanteil', 'Marktanteil'],
      ['kundeneinbindung', 'Kundeneinbindung'],
      ['lieferkettenzugang', 'Lieferkettenzugang'],
      ['replikationsrisiko', 'Replikationsrisiko'],
    ];
    const moatCards = moatItems.map(([k, label]) => {
      const f = moat[k] || {};
      return `
        <div class="rounded-md border border-ink-600 p-3 bg-ink-800/30">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <span class="text-sm text-ink-100 font-medium">${label}</span>
            ${strengthChip(f.staerke)}
          </div>
          <p class="text-xs text-ink-200 mb-2 leading-relaxed">${escapeHtml(f.beleg || '—')}</p>
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] uppercase tracking-wider text-ink-300">Quelle:</span>
            ${sourceChip(f.quelle)}
          </div>
        </div>`;
    }).join('');

    const moatScore = moat.gesamtscore;
    const moatHtml = `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-4 mb-3">
          <h2 class="!mb-0">④ Burggraben — Detail</h2>
          <div class="flex items-center gap-3">
            <div class="text-right">
              <div class="text-2xl font-bold font-mono">${moatScore ?? '—'}<span class="text-sm text-ink-300">/100</span></div>
              <div class="text-[10px] uppercase tracking-wider text-ink-300">Gesamt-Moat</div>
            </div>
          </div>
        </div>
        <p class="text-sm text-ink-200 leading-relaxed mb-4">${escapeHtml(moat.gesamt_begruendung || '—')}</p>
        <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${moatCards}
        </div>
      </div>`;

    // --- Datenqualität & Quellenleiste ---
    const luecken = (dq.luecken || []).map(l => `<li>· ${escapeHtml(l)}</li>`).join('') || '<li class="text-ink-300">—</li>';
    const schaetz = (dq.schaetzungen || []).map(s => `<li>· ${escapeHtml(s)}</li>`).join('') || '<li class="text-ink-300">—</li>';

    const usedChips = [
      dq.sec_data_verwendet ? '<span class="chip chip-very-strong">SEC</span>' : '<span class="chip chip-weak">SEC — fehlt</span>',
      dq.news_data_verwendet ? '<span class="chip chip-strong">News</span>' : '<span class="chip chip-weak">News — fehlt</span>',
      dq.web_data_verwendet ? '<span class="chip chip-medium">Web</span>' : '<span class="chip chip-weak">Web — fehlt</span>',
    ].join(' ');

    const compSources = sources.competitor_search || [];
    const mktSources = sources.market_search || [];
    const renderSearchBlock = (title, items) => items.length ? `
      <div>
        <div class="text-xs uppercase tracking-wider text-ink-300 mb-2">${escapeHtml(title)}</div>
        <ul class="space-y-1.5">
          ${items.slice(0, 6).map(r => `
            <li class="text-xs">
              <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="text-accent-info hover:underline">${escapeHtml(r.title || r.url)}</a>
              <div class="text-ink-400 font-mono text-[10px] mt-0.5">${escapeHtml(safeHostname(r.url))}</div>
            </li>`).join('')}
        </ul>
      </div>` : '';

    const dqHtml = `
      <div class="card lg:col-span-3">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
          <h2 class="!mb-0">Datenqualität &amp; verwendete Quellen</h2>
          <div class="flex flex-wrap gap-1.5">
            ${confidenceChip(dq.vertrauen_overall)}
            ${usedChips}
          </div>
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Lücken in der Datenlage</div>
            <ul class="text-sm text-ink-200 space-y-1">${luecken}</ul>
          </div>
          <div>
            <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Geschätzte Aussagen (kein Hard-Data-Beleg)</div>
            <ul class="text-sm text-ink-200 space-y-1">${schaetz}</ul>
          </div>
        </div>

        ${(compSources.length || mktSources.length) ? `
          <div class="mt-4 pt-3 border-t border-ink-600/60 grid md:grid-cols-2 gap-4">
            ${renderSearchBlock('Websuche: Wettbewerber', compSources)}
            ${renderSearchBlock('Websuche: Markttrends', mktSources)}
          </div>` : ''}

        <div class="text-xs text-ink-300 mt-4">
          <strong class="text-ink-200">KI-Modell:</strong> ${escapeHtml(result.model || '?')} ·
          <strong class="text-ink-200">Tokens:</strong> ${result.usage?.total_tokens ?? '?'} ·
          <strong class="text-ink-200">Hinweis:</strong> Schätzungen aus News/Web sind explizit markiert. Keine Anlageberatung.
        </div>
      </div>`;

    $('#tab-tiefen').innerHTML = `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(96,165,250,0.04) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(96,165,250,0.25);">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 class="!mb-1">KI-Tiefenanalyse</h2>
            <p class="text-xs text-ink-300">Geschäftsmodell · Zukunftsfähigkeit · Konkurrenz · Burggraben — mit Quellen &amp; Confidence pro Sektion.</p>
          </div>
          ${confidenceChip(dq.vertrauen_overall)}
        </div>
      </div>

      <div class="grid lg:grid-cols-3 gap-4">
        ${gmHtml}
        ${zfHtml}
        ${kkHtml}
        ${moatHtml}
        ${dqHtml}
      </div>`;

    // Peer-Ticker-Links: in dieselbe App laden
    $$('#tab-tiefen a[data-deep-peer]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const t = a.dataset.deepPeer;
      if (searchEl) searchEl.value = t;
      loadTicker(t);
    }));
  }

  function renderScenario(title, s, color) {
    if (!s) return '';
    return `
      <div class="rounded-md border p-4" style="border-color:${color}55">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold" style="color:${color}">${title}</span>
          <span class="text-xs text-ink-300">${s.wahrscheinlichkeit ?? '—'}%</span>
        </div>
        <p class="text-sm text-ink-100 leading-relaxed mb-2">${escapeHtml(s.these || '—')}</p>
        <ul class="text-xs text-ink-300 space-y-0.5">
          ${(s.treiber || []).map(t => `<li>· ${escapeHtml(t)}</li>`).join('')}
        </ul>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Branchenanalyse — Renderer (Issue 3)
  // ---------------------------------------------------------------------
  function paintIndustrySkeleton() {
    $('#tab-branche').innerHTML = `
      <div class="card">
        <h2>Branchenanalyse</h2>
        <p class="text-sm text-ink-200 mb-2">
          Automatische Branche-Erkennung &amp; Web-Recherche zu Trends, Prognosen und Risiken —
          KI-Zusammenfassung der Zukunftsaussichten.
        </p>
        <div class="text-ink-300 text-sm">
          Suche &amp; Auswertung läuft <span class="spinner"></span>
        </div>
      </div>`;
  }

  function outlookChip(o) {
    const v = String(o || '').toLowerCase();
    const map = {
      'stark-positiv': ['chip-very-strong', '★ Ausblick: stark positiv'],
      'positiv': ['chip-strong', '↗ Ausblick: positiv'],
      'neutral': ['chip-medium', '→ Ausblick: neutral'],
      'negativ': ['chip-weak', '↘ Ausblick: negativ'],
      'stark-negativ': ['chip-weak', '↘↘ Ausblick: stark negativ'],
    };
    const [cls, lbl] = map[v] || ['chip-medium', 'Ausblick: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }
  function phaseChip(p) {
    const v = String(p || '').toLowerCase();
    const map = {
      'stark-wachsend': ['chip-very-strong', 'Phase: stark wachsend'],
      'wachsend': ['chip-strong', 'Phase: wachsend'],
      'reif': ['chip-medium', 'Phase: reif'],
      'schrumpfend': ['chip-weak', 'Phase: schrumpfend'],
      'im-umbruch': ['chip-medium', 'Phase: im Umbruch'],
    };
    const [cls, lbl] = map[v] || ['chip-medium', 'Phase: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }
  function impactChip(i) {
    const v = String(i || '').toLowerCase();
    const map = {
      'niedrig': ['chip-strong', 'Auswirkung: niedrig'],
      'mittel': ['chip-medium', 'Auswirkung: mittel'],
      'hoch': ['chip-weak', 'Auswirkung: hoch'],
    };
    const [cls, lbl] = map[v] || ['chip-medium', 'Auswirkung: —'];
    return `<span class="chip ${cls}">${lbl}</span>`;
  }

  function paintIndustry(state) {
    const ind = state.industry;
    if (!ind) { paintIndustrySkeleton(); return; }
    const ai = ind.ai || {};
    const ges = ai.gesamteinschaetzung || {};
    const sources = ind.sources || [];

    const treiberRows = (ai.treiber || []).map(t => {
      const idx = Number(t.quelle_index);
      const src = Number.isFinite(idx) && idx > 0 ? sources[idx - 1] : null;
      return `<div class="border-l-2 border-ink-500 pl-3 py-1.5">
        <div class="flex items-center justify-between gap-2 flex-wrap mb-1">
          <span class="font-medium text-ink-100">${escapeHtml(t.thema || '—')}</span>
          ${tendenzChip(t.richtung)}
        </div>
        <p class="text-xs text-ink-300 leading-relaxed">${escapeHtml(t.details || '')}</p>
        ${src ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener" class="text-[10px] text-accent-info hover:underline">[${idx}] ${escapeHtml(safeHostname(src.url))}</a>` : ''}
      </div>`;
    }).join('');

    const risikenRows = (ai.risiken || []).map(r => {
      const idx = Number(r.quelle_index);
      const src = Number.isFinite(idx) && idx > 0 ? sources[idx - 1] : null;
      return `<div class="border-l-2 border-accent-warm/40 pl-3 py-1.5">
        <div class="flex items-center justify-between gap-2 flex-wrap mb-1">
          <span class="font-medium text-ink-100">${escapeHtml(r.risiko || '—')}</span>
          ${impactChip(r.auswirkung)}
        </div>
        <p class="text-xs text-ink-300 leading-relaxed">${escapeHtml(r.details || '')}</p>
        ${src ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener" class="text-[10px] text-accent-info hover:underline">[${idx}] ${escapeHtml(safeHostname(src.url))}</a>` : ''}
      </div>`;
    }).join('');

    if (!ai.gesamteinschaetzung && !ai.treiber && !sources.length) {
      $('#tab-branche').innerHTML = `
        <div class="card">
          <h2>Branchenanalyse</h2>
          <p class="text-accent-bad text-sm">JSON-Parsing oder Suche fehlgeschlagen.</p>
          ${ind.raw_excerpt ? `<pre class="text-xs text-ink-300 bg-ink-900 p-3 rounded mt-2 overflow-auto max-h-64">${escapeHtml(ind.raw_excerpt)}</pre>` : ''}
        </div>`;
      return;
    }

    $('#tab-branche').innerHTML = `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(110,231,183,0.04) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(110,231,183,0.25);">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-2">
          <div>
            <h2 class="!mb-1">Branchenanalyse</h2>
            <div class="text-sm text-ink-100">
              <span class="text-ink-300">Branche:</span> <span class="font-medium">${escapeHtml(ai.branche_label || ind.industry || ind.sector || '—')}</span>
              ${ind.detection_method ? `<span class="text-xs text-ink-300 ml-2">(${ind.detection_method === 'yahoo' ? 'aus Yahoo' : 'KI-Schätzung'})</span>` : ''}
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${outlookChip(ges.ausblick)}
            ${phaseChip(ges.wachstumsphase)}
            ${confidenceChip(ai.confidence)}
          </div>
        </div>
        ${ges.zusammenfassung ? `<p class="text-sm text-ink-100 leading-relaxed mt-3">${escapeHtml(ges.zusammenfassung)}</p>` : ''}
      </div>

      <div class="grid lg:grid-cols-2 gap-4">
        <div class="card">
          <h2>Treiber</h2>
          ${treiberRows ? `<div class="space-y-2">${treiberRows}</div>` : '<p class="text-ink-300 text-sm">— Keine Treiber erkannt —</p>'}
        </div>
        <div class="card">
          <h2>Risiken</h2>
          ${risikenRows ? `<div class="space-y-2">${risikenRows}</div>` : '<p class="text-ink-300 text-sm">— Keine spezifischen Branchenrisiken erkannt —</p>'}
        </div>
        <div class="card">
          <h2>Wettbewerb &amp; Disruption</h2>
          <table class="data">
            <tbody>
              <tr><td>Wettbewerbsintensität</td><td>${strengthLabel(ai.wettbewerb_intensitaet)}</td></tr>
              <tr><td>Disruptionspotenzial</td><td>${strengthLabel(ai.disruption_potenzial)}</td></tr>
              <tr><td>Regulatorisch</td><td>${escapeHtml(ai.regulatorisch?.bewertung || '—')}</td></tr>
            </tbody>
          </table>
          ${ai.regulatorisch?.details ? `<p class="text-xs text-ink-300 mt-2">${escapeHtml(ai.regulatorisch.details)}</p>` : ''}
        </div>
        <div class="card">
          <h2>Bezug zur Firma</h2>
          <p class="text-sm text-ink-100 leading-relaxed">${escapeHtml(ai.fazit_fuer_firma || '—')}</p>
        </div>
      </div>

      ${sources.length ? `
        <div class="card mt-4">
          <h2>Quellen (Web-Suche)</h2>
          <ol class="space-y-2 text-sm">
            ${sources.map((s, i) => `
              <li class="border-l-2 border-ink-500 pl-3 py-0.5">
                <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="block group">
                  <div class="text-ink-100 group-hover:text-accent transition">
                    <span class="text-ink-300 text-xs font-mono mr-1">[${i + 1}]</span>${escapeHtml(s.title || s.url)}
                  </div>
                  <div class="text-xs text-ink-300 mt-0.5">${escapeHtml(s.snippet || '')}</div>
                  <div class="text-xs text-ink-400 mt-0.5 font-mono">${escapeHtml(safeHostname(s.url))}</div>
                </a>
              </li>`).join('')}
          </ol>
        </div>` : ''}
    `;
  }

  function strengthLabel(v) {
    const lbl = ({
      'niedrig': 'Niedrig', 'mittel': 'Mittel', 'hoch': 'Hoch', 'sehr-hoch': 'Sehr hoch',
    })[String(v || '').toLowerCase()] || (v || '—');
    return `<span class="font-medium text-ink-100">${escapeHtml(lbl)}</span>`;
  }

  // ---------------------------------------------------------------------
  // Ausführliches Fazit — Renderer (Issue 3)
  // ---------------------------------------------------------------------
  function paintConclusionSkeleton() {
    $('#tab-fazit').innerHTML = `
      <div class="card">
        <h2>Ausführliches Fazit</h2>
        <p class="text-sm text-ink-200 mb-2">
          Konsolidierte Bewertung aus Fundamentaldaten, Scorecard, KI-Analyse, News &amp; Branche —
          mit Stärken/Schwächen, Chancen/Risiken, Handlungsempfehlung und Quellen.
        </p>
        <div class="text-ink-300 text-sm">DeepSeek V4 konsolidiert die Analyse <span class="spinner"></span></div>
      </div>`;
  }

  function quellenBadge(q) {
    const v = String(q || '').toLowerCase();
    const map = {
      'sec': 'chip-very-strong',
      'fundamentaldaten': 'chip-very-strong',
      'news': 'chip-strong',
      'branche': 'chip-strong',
      'ki-analyse': 'chip-medium',
      'ki-tiefenanalyse': 'chip-medium',
      'schätzung': 'chip-weak',
      'schaetzung': 'chip-weak',
    };
    const cls = map[v] || 'chip-medium';
    return `<span class="chip ${cls}">${escapeHtml(q || '—')}</span>`;
  }

  function renderConclusionList(items, color) {
    if (!Array.isArray(items) || !items.length) return '<p class="text-ink-300 text-sm">—</p>';
    return `<ul class="space-y-2.5">
      ${items.map(it => `<li class="border-l-2 pl-3 py-1" style="border-color:${color}80">
        <div class="flex items-start justify-between gap-3 flex-wrap mb-1">
          <span class="font-medium text-ink-100">${escapeHtml(it.punkt || '—')}</span>
          ${quellenBadge(it.quelle)}
        </div>
        <p class="text-xs text-ink-200 leading-relaxed">${escapeHtml(it.details || '')}</p>
      </li>`).join('')}
    </ul>`;
  }

  // Baut den gesamten Inhalt des Ausführlichen Fazits — wird im Fazit-Tab
  // UND in der Übersicht (Issue 7) verwendet. `idPrefix` macht die Element-IDs
  // (PDF-Button) eindeutig pro Render-Ort.
  function buildConclusionFullHtml(c, state, opts = {}) {
    const { idPrefix = '', headerHint = 'Konsolidierte Bewertung mit Quellenangaben pro Aussage.' } = opts;
    const dq = c.datenqualitaet || {};
    const usedChips = [
      dq.sec_data ? '<span class="chip chip-very-strong">SEC</span>' : '<span class="chip chip-weak">SEC fehlt</span>',
      dq.news_data ? '<span class="chip chip-strong">News</span>' : '<span class="chip chip-weak">News fehlt</span>',
      dq.branche_data ? '<span class="chip chip-strong">Branche</span>' : '<span class="chip chip-weak">Branche fehlt</span>',
    ].join(' ');

    const h = c.handlungsempfehlung || {};
    const hTyp = ({
      'weiter-beobachten': 'Weiter beobachten',
      'tiefer-prüfen': 'Tiefer prüfen',
      'tiefer-pruefen': 'Tiefer prüfen',
      'warten-auf-katalysator': 'Auf Katalysator warten',
      'nicht-interessant': 'Aktuell nicht interessant',
    })[String(h.typ || '').toLowerCase()] || (h.typ || '—');

    return `
      <div class="card mb-4" style="background: linear-gradient(180deg, rgba(96,165,250,0.05) 0%, var(--card-tint-bg, rgba(22,27,36,0.85)) 100%); border-color: rgba(96,165,250,0.3);">
        <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
          <div>
            <h2 class="!mb-1">Ausführliches Fazit</h2>
            <p class="text-xs text-ink-300">${escapeHtml(headerHint)}</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            ${confidenceChip(dq.vertrauen)}
            <button id="${idPrefix}fazit-pdf-btn" class="text-sm border border-accent-info/40 text-accent-info hover:bg-accent-info/10 rounded-md px-3 py-1.5 transition">
              ⬇ PDF-Report herunterladen
            </button>
          </div>
        </div>
        ${c.kernaussage ? `<p class="text-base text-ink-100 leading-relaxed font-medium">${escapeHtml(c.kernaussage)}</p>` : ''}
      </div>

      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <h2 class="text-pos">Stärken</h2>
          ${renderConclusionList(c.staerken, '#6ee7b7')}
        </div>
        <div class="card">
          <h2 class="text-neg">Schwächen</h2>
          ${renderConclusionList(c.schwaechen, '#f87171')}
        </div>
        <div class="card">
          <h2 style="color:#60a5fa">Chancen</h2>
          ${renderConclusionList(c.chancen, '#60a5fa')}
        </div>
        <div class="card">
          <h2 style="color:#fbbf24">Risiken</h2>
          ${renderConclusionList(c.risiken, '#fbbf24')}
        </div>
      </div>

      ${c.gesamteinschaetzung ? `
        <div class="card mb-4">
          <h2>Gesamteinschätzung</h2>
          <p class="text-sm text-ink-100 leading-relaxed">${escapeHtml(c.gesamteinschaetzung)}</p>
        </div>` : ''}

      <div class="card mb-4">
        <h2>Handlungsempfehlung</h2>
        <div class="flex items-center gap-2 flex-wrap mb-2">
          <span class="chip chip-very-strong">${escapeHtml(hTyp)}</span>
        </div>
        <p class="text-sm text-ink-100 leading-relaxed mb-3">${escapeHtml(h.begruendung || '—')}</p>
        ${Array.isArray(h.beobachtungspunkte) && h.beobachtungspunkte.length ? `
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Beobachtungspunkte</div>
          <ul class="space-y-1.5 text-sm">
            ${h.beobachtungspunkte.map(b => `<li class="flex gap-2"><span class="text-accent">▸</span><span>${escapeHtml(b)}</span></li>`).join('')}
          </ul>` : ''}
      </div>

      <div class="card">
        <h2>Datenqualität &amp; Lücken</h2>
        <div class="flex flex-wrap gap-1.5 mb-3">${usedChips}</div>
        ${Array.isArray(dq.luecken) && dq.luecken.length ? `
          <div class="text-xs uppercase tracking-wider text-ink-300 mb-1.5">Datenlücken</div>
          <ul class="text-xs text-ink-300 space-y-0.5">
            ${dq.luecken.map(l => `<li>· ${escapeHtml(l)}</li>`).join('')}
          </ul>` : '<p class="text-xs text-ink-300">Keine signifikanten Lücken vermerkt.</p>'}
        <div class="text-xs text-ink-300 mt-4 pt-3 border-t border-ink-600/60">
          <strong class="text-ink-200">Hinweis:</strong> Diese Bewertung ist eine Hypothese auf Basis öffentlich zugänglicher Daten — keine Anlageberatung.
          ${state.conclusionMeta?.model ? `KI-Modell: ${escapeHtml(state.conclusionMeta.model)}.` : ''}
        </div>
      </div>
    `;
  }

  // Bindet die PDF-Buttons an downloadPdfReport (kann mehrfach aufgerufen
  // werden, wenn die Conclusion an mehreren Stellen gerendert wird).
  function wireConclusionPdfButtons(idPrefix = '') {
    const btn = document.getElementById(`${idPrefix}fazit-pdf-btn`);
    if (btn) btn.addEventListener('click', () => downloadPdfReport());
  }

  function paintConclusion(state) {
    const c = state.conclusion;
    if (!c) {
      $('#tab-fazit').innerHTML = `<div class="card">
        <h2>Ausführliches Fazit</h2>
        <p class="text-accent-bad text-sm">JSON-Parsing fehlgeschlagen.</p>
        ${state.conclusionMeta?.raw_excerpt ? `<pre class="text-xs text-ink-300 bg-ink-900 p-3 rounded mt-2 overflow-auto max-h-64">${escapeHtml(state.conclusionMeta.raw_excerpt)}</pre>` : ''}
      </div>`;
      return;
    }
    $('#tab-fazit').innerHTML = buildConclusionFullHtml(c, state, { idPrefix: '' });
    wireConclusionPdfButtons('');
  }

  // ---------------------------------------------------------------------
  // Initial: auf Hash reagieren
  // ---------------------------------------------------------------------
  if (window.location.hash) {
    const ticker = window.location.hash.replace('#', '').toUpperCase();
    if (/^[A-Z0-9.\-]{1,10}$/.test(ticker)) {
      setTimeout(() => { searchEl.value = ticker; loadTicker(ticker); }, 100);
    }
  }
})();
