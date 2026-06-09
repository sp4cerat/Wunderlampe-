/**
 * Aktienanalyse-Tool — Backend
 *
 * Orchestriert Daten aus dem tools-server (yfinance, SEC EDGAR, DDG-Web-Suche,
 * LLM-Proxy) zu einer einheitlichen Investment-Research-API. Keys liegen
 * zentral auf dem Server (im tools-server bzw. /root/.secrets), die Frontend-
 * App spricht nur dieses Backend an.
 */
'use strict';

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const PDFDocument = require('pdfkit');

// Python aus dem zentralen tools-server-venv — dort ist yfinance installiert.
// Falls der Pfad mal nicht existiert, fällt der Aufruf elegant durch (Cache: null).
const YF_PYTHON = process.env.YF_PYTHON || '/root/tools-server/venv/bin/python';

const TOOLS = process.env.TOOLS_URL || 'http://127.0.0.1:8780';
const PORT = parseInt(process.env.PORT || '3781', 10);
const HOST = process.env.HOST || '127.0.0.1';
const UA = 'Mozilla/5.0 (compatible; StockResearchCopilot/0.1; +https://test.svenforstmann.com)';

const app = express();
app.use(express.json({ limit: '4mb' }));

// ---------------------------------------------------------------------------
// In-memory cache (TTL pro Eintrag). Hält API-Kosten niedrig und macht
// Multi-Endpoint-Analysen für denselben Ticker schnell.
// ---------------------------------------------------------------------------
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) {
    cache.delete(key);
    return null;
  }
  return e.val;
}
function cacheSet(key, val, ttlMs) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const val = await fn();
  cacheSet(key, val, ttlMs);
  return val;
}

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
async function fetchJSON(url, opts = {}) {
  const { timeoutMs, ...rest } = opts;
  let signal = rest.signal;
  let timer = null;
  if (timeoutMs && !signal) {
    const ctl = new AbortController();
    signal = ctl.signal;
    timer = setTimeout(() => ctl.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, { ...rest, signal, headers: { 'User-Agent': UA, ...(rest.headers || {}) } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const te = new Error(`Timeout nach ${timeoutMs}ms — ${url}`);
      te.code = 'TIMEOUT';
      te.timeout = true;
      throw te;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(a, b) {
  const x = safeNumber(a), y = safeNumber(b);
  if (x === null || y === null || y === 0) return null;
  return (x - y) / Math.abs(y);
}

// ---------------------------------------------------------------------------
// Ticker-Suche (Yahoo Finance Autocomplete — kein Key)
// ---------------------------------------------------------------------------
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 1) return res.json({ results: [] });
  try {
    const data = await cached(`search:${q.toLowerCase()}`, 5 * 60 * 1000, async () => {
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=true`;
      return fetchJSON(url);
    });
    const results = (data.quotes || [])
      .filter(x => x.symbol)
      .map(x => ({
        symbol: x.symbol,
        name: x.shortname || x.longname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.quoteType || '',
        sector: x.sector || '',
        industry: x.industry || '',
      }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Kursdaten + Basis-Info
// ---------------------------------------------------------------------------
app.get('/api/quote', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  const range = (req.query.range || '1y').toString();
  const interval = (req.query.interval || '1d').toString();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const data = await cached(`quote:${ticker}:${range}:${interval}`, 10 * 60 * 1000, () =>
      fetchJSON(`${TOOLS}/stocks?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${interval}`)
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// ---------------------------------------------------------------------------
// yfinance-Extra — Forward EPS, Forward KGV, Trailing KGV, PEG, Sanity-Margen
// Holt Felder die der tools-server `/stocks`-Endpoint nicht zurückliefert,
// direkt aus yfinance via Python-Subprozess. Loopback only, kein neuer Service.
// ---------------------------------------------------------------------------
function fetchYfinanceExtra(ticker) {
  return new Promise((resolve) => {
    const py = `
import json, sys
try:
    import yfinance as yf
    t = yf.Ticker(sys.argv[1])
    info = t.info or {}
    keys = ['forwardPE', 'trailingPE', 'forwardEps', 'trailingEps',
            'pegRatio', 'priceToBook', 'priceToSalesTrailing12Months',
            'enterpriseToRevenue', 'enterpriseToEbitda',
            'grossMargins', 'operatingMargins', 'profitMargins',
            'revenueGrowth', 'earningsGrowth', 'freeCashflow',
            'totalRevenue', 'dividendYield']
    out = {k: info.get(k) for k in keys}
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({'_error': str(e)}))
`;
    const proc = spawn(YF_PYTHON, ['-c', py, ticker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 15000);
    proc.on('close', () => {
      clearTimeout(killer);
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed._error) return resolve(null);
        resolve(parsed);
      } catch {
        if (stderr) console.warn('[yfinance-extra]', ticker, stderr.slice(0, 200));
        resolve(null);
      }
    });
    proc.on('error', (e) => {
      clearTimeout(killer);
      console.warn('[yfinance-extra] spawn failed:', e.message);
      resolve(null);
    });
  });
}

app.get('/api/yfinance-extra', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const out = await cached(`yfx:${ticker}`, 6 * 60 * 60 * 1000, () => fetchYfinanceExtra(ticker));
    res.json({ ticker, extra: out || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// SEC-Filings (US-only, kein Key)
// ---------------------------------------------------------------------------
app.get('/api/filings', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  const form = (req.query.form || '10-K,10-Q,8-K').toString();
  const limit = parseInt(req.query.limit || '15', 10);
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const data = await cached(`filings:${ticker}:${form}:${limit}`, 60 * 60 * 1000, () =>
      fetchJSON(`${TOOLS}/sec/filings?ticker=${encodeURIComponent(ticker)}&form=${encodeURIComponent(form)}&limit=${limit}`)
    );
    res.json(data);
  } catch (e) {
    // 404 = Ticker hat kein SEC-Filing (z.B. nicht in US gelistet) — kein Hard-Error
    if (e.status === 404) return res.json({ ticker, filings: [], note: 'no-sec-data' });
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Fundamentaldaten via SEC XBRL — sucht passende Konzept-Namen automatisch,
// weil sie je Firma variieren (ASC 606: Revenues vs. RevenueFromContract...).
// ---------------------------------------------------------------------------
const CONCEPT_CANDIDATES = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'SalesRevenueGoodsNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  longTermDebt: ['LongTermDebt', 'LongTermDebtNoncurrent'],
  shortTermDebt: ['ShortTermBorrowings', 'LongTermDebtCurrent'],
  cashAndEquivalents: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  dilutedEps: ['EarningsPerShareDiluted'],
  basicEps: ['EarningsPerShareBasic'],
  sharesOutstanding: ['CommonStockSharesOutstanding', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
  rd: ['ResearchAndDevelopmentExpense'],
  sgna: ['SellingGeneralAndAdministrativeExpense'],
};

async function fetchConcept(ticker, candidates) {
  // Firmen wechseln Konzept-Namen über die Zeit (z.B. NVDA reportet seit FY2023
  // unter `Revenues` statt `RevenueFromContractWithCustomerExcludingAssessedTax`).
  // First-match liefert dann eingefrorene Altdaten — als Folge entstehen
  // Cross-Year-Quotienten wie GrossMargin = neuestes_GP / uraltes_Revenue → >100%.
  // Wir holen alle Kandidaten und wählen den mit der jüngsten FY-Reihe.
  let best = null;
  for (const c of candidates) {
    try {
      const data = await cached(`fact:${ticker}:${c}`, 24 * 60 * 60 * 1000, () =>
        fetchJSON(`${TOOLS}/sec/facts?ticker=${encodeURIComponent(ticker)}&concept=${encodeURIComponent(c)}&taxonomy=us-gaap`)
      );
      if (!data || !data.units) continue;
      const fy = pickFY(data);
      const maxFy = fy.length ? fy[0].fy : 0;
      const maxFiled = fy.length ? new Date(fy[0].filed).getTime() : 0;
      if (!best || maxFy > best.maxFy || (maxFy === best.maxFy && maxFiled > best.maxFiled)) {
        best = { concept: c, data, maxFy, maxFiled };
      }
    } catch (e) {
      // weiter probieren — 404 oder Throttle
    }
  }
  return best ? { concept: best.concept, ...best.data } : null;
}

function pickFY(facts) {
  // Liefert FY-Werte sortiert (neueste zuerst), aus units (USD bevorzugt, sonst erstes).
  if (!facts || !facts.units) return [];
  const unit = Object.keys(facts.units)[0];
  const rows = facts.units[unit] || [];
  // FY-only, eindeutig pro fy/end
  const fyRows = rows.filter(r => r.fp === 'FY' && r.form === '10-K');
  const byFY = new Map();
  for (const r of fyRows) {
    const k = r.fy;
    const prev = byFY.get(k);
    if (!prev || new Date(r.filed) > new Date(prev.filed)) byFY.set(k, r);
  }
  return Array.from(byFY.values()).sort((a, b) => b.fy - a.fy);
}

function pickTTM(facts) {
  // Annäherung: Summe der letzten 4 nicht-FY-Quartale (Q1+Q2+Q3+Q4-rekonstruiert)
  // — vereinfacht: nimm jüngste 4 Quartals-Daten mit start≠FY-Begin.
  if (!facts || !facts.units) return null;
  const unit = Object.keys(facts.units)[0];
  const rows = (facts.units[unit] || []).filter(r => r.form === '10-Q' || r.form === '10-K');
  // Quartalswerte: end-start ≈ 90 Tage
  const quarters = rows.filter(r => {
    if (!r.start || !r.end) return false;
    const days = (new Date(r.end) - new Date(r.start)) / 86400000;
    return days > 60 && days < 110;
  }).sort((a, b) => new Date(b.end) - new Date(a.end));
  // dedupe by end
  const seen = new Set();
  const unique = quarters.filter(q => seen.has(q.end) ? false : (seen.add(q.end), true));
  if (unique.length >= 4) return unique.slice(0, 4).reduce((s, q) => s + q.val, 0);
  return null;
}

app.get('/api/fundamentals', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const out = await cached(`fund:${ticker}`, 6 * 60 * 60 * 1000, async () => {
      const entries = await Promise.all(
        Object.entries(CONCEPT_CANDIDATES).map(async ([key, cands]) => {
          const f = await fetchConcept(ticker, cands);
          if (!f) return [key, null];
          return [key, { concept: f.concept, fy: pickFY(f), ttm: pickTTM(f) }];
        })
      );
      const fundamentals = Object.fromEntries(entries);

      // Abgeleitete Kennzahlen aus FY-Reihen
      const derived = {};
      const r = fundamentals.revenue?.fy || [];
      const ni = fundamentals.netIncome?.fy || [];
      const gp = fundamentals.grossProfit?.fy || [];
      const oi = fundamentals.operatingIncome?.fy || [];
      const ocf = fundamentals.operatingCashFlow?.fy || [];
      const capex = fundamentals.capex?.fy || [];

      derived.revenueGrowth1y = r.length >= 2 ? pct(r[0]?.val, r[1]?.val) : null;
      derived.revenueGrowth3y = r.length >= 4 ? pct(r[0]?.val, r[3]?.val) : null;
      derived.revenueGrowth5y = r.length >= 6 ? pct(r[0]?.val, r[5]?.val) : null;
      derived.epsGrowth1y = fundamentals.dilutedEps?.fy?.length >= 2
        ? pct(fundamentals.dilutedEps.fy[0]?.val, fundamentals.dilutedEps.fy[1]?.val)
        : null;
      derived.netIncomeGrowth1y = ni.length >= 2 ? pct(ni[0]?.val, ni[1]?.val) : null;

      // Margen IMMER auf das gleiche FY beziehen — wenn ein Konzept eine FY
      // (z.B. 2026) hat, das andere aber nur bis 2022, wäre die naive
      // [0]/[0]-Division ein Cross-Year-Quotient mit >100%-Ergebnissen.
      const refFy = r[0]?.fy;
      const findFy = (series, year) => year != null ? series.find(x => x?.fy === year) : null;
      if (refFy != null && r[0]) {
        const gpY = findFy(gp, refFy);
        const oiY = findFy(oi, refFy);
        const niY = findFy(ni, refFy);
        derived.grossMargin = gpY ? gpY.val / r[0].val : null;
        derived.operatingMargin = oiY ? oiY.val / r[0].val : null;
        derived.netMargin = niY ? niY.val / r[0].val : null;
        derived.marginsRefFy = refFy;
      } else {
        derived.grossMargin = null;
        derived.operatingMargin = null;
        derived.netMargin = null;
      }

      // FCF = OCF − CapEx (CapEx ist als Auszahlung gespeichert, je nach Firma positiv oder negativ)
      const ocfY = findFy(ocf, refFy);
      const capexY = findFy(capex, refFy);
      if (ocfY) {
        const cap = capexY ? Math.abs(capexY.val) : 0;
        derived.fcf = ocfY.val - cap;
        derived.fcfMargin = r[0] ? derived.fcf / r[0].val : null;
      }

      if (fundamentals.assets?.fy?.[0] && fundamentals.liabilities?.fy?.[0]) {
        const a = fundamentals.assets.fy[0].val;
        const l = fundamentals.liabilities.fy[0].val;
        derived.debtToAssets = l / a;
      }
      if (fundamentals.longTermDebt?.fy?.[0] && fundamentals.equity?.fy?.[0]) {
        derived.debtToEquity = fundamentals.longTermDebt.fy[0].val / fundamentals.equity.fy[0].val;
      }
      if (ni[0] && fundamentals.equity?.fy?.[0]) {
        derived.roe = ni[0].val / fundamentals.equity.fy[0].val;
      }
      if (ni[0] && fundamentals.assets?.fy?.[0]) {
        derived.roa = ni[0].val / fundamentals.assets.fy[0].val;
      }

      return { ticker, fundamentals, derived };
    });
    res.json(out);
  } catch (e) {
    if (e.status === 404) return res.json({ ticker, fundamentals: {}, derived: {}, note: 'no-sec-data' });
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// News-Suche
// ---------------------------------------------------------------------------
app.get('/api/news', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  const name = (req.query.name || '').toString().trim();
  const max = parseInt(req.query.max || '15', 10);
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const q = name ? `${name} (${ticker}) stock news` : `${ticker} stock news`;
    const data = await cached(`news:${q}:${max}`, 30 * 60 * 1000, () =>
      fetchJSON(`${TOOLS}/web/search?q=${encodeURIComponent(q)}&max_results=${max}&time=m`)
    );
    res.json({ ticker, query: q, results: data.results || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// LLM-Analyse — strukturiertes JSON aus Datenpaket
// ---------------------------------------------------------------------------
function trim(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function compactFinancials(fund) {
  // Erzeugt für den LLM-Prompt eine kompakte Markdown-Übersicht aus den FY-Reihen.
  const d = fund?.derived || {};
  const f = fund?.fundamentals || {};
  const fmtPct = v => v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%';
  const fmtMoney = v => v === null || v === undefined ? '—' : '$' + (v / 1e9).toFixed(2) + 'B';
  const lines = [];
  lines.push(`Umsatzwachstum: 1J ${fmtPct(d.revenueGrowth1y)}, 3J ${fmtPct(d.revenueGrowth3y)}, 5J ${fmtPct(d.revenueGrowth5y)}`);
  lines.push(`Margen: brutto ${fmtPct(d.grossMargin)}, operativ ${fmtPct(d.operatingMargin)}, netto ${fmtPct(d.netMargin)}, FCF ${fmtPct(d.fcfMargin)}`);
  lines.push(`Rendite: ROE ${fmtPct(d.roe)}, ROA ${fmtPct(d.roa)}`);
  lines.push(`Verschuldung: D/E ${d.debtToEquity?.toFixed(2) ?? '—'}, D/A ${fmtPct(d.debtToAssets)}`);
  if (f.revenue?.fy?.[0]) lines.push(`Letzter Umsatz (FY${f.revenue.fy[0].fy}): ${fmtMoney(f.revenue.fy[0].val)}`);
  if (f.netIncome?.fy?.[0]) lines.push(`Letzter Nettogewinn (FY${f.netIncome.fy[0].fy}): ${fmtMoney(f.netIncome.fy[0].val)}`);
  if (d.fcf) lines.push(`Free Cash Flow: ${fmtMoney(d.fcf)}`);
  return lines.join('\n');
}

function compactNews(news) {
  return (news || []).slice(0, 12).map((n, i) =>
    `${i + 1}. ${n.title}\n   ${trim(n.snippet, 220)}\n   Quelle: ${n.url}`
  ).join('\n');
}

function compactFilings(filings) {
  return (filings || []).slice(0, 6).map(f =>
    `- ${f.form} vom ${f.date} (Berichtsstichtag ${f.report_date || '?'}): ${f.url}`
  ).join('\n');
}

const LLM_SYSTEM = `Du bist ein nüchterner Equity-Research-Analyst. Deine Aufgabe ist eine strukturierte Investment-Analyse für private Anleger. WICHTIG:
- Keine Anlageberatung, keine Kursprognosen mit konkreten Zielen. Stattdessen Szenarien (Bull/Base/Bear).
- Jede Behauptung muss auf den gelieferten Daten beruhen. Wenn Daten fehlen, sage das explizit.
- Antworte ausschließlich mit gültigem JSON, exakt nach dem geforderten Schema. Keine Erklärungen davor oder danach, kein Markdown-Codefence.
- Schreibe auf Deutsch.`;

function llmPromptOverview({ ticker, info, fundamentals, filings, news, sec_status }) {
  // Issue 17: Wenn SEC-Daten unvollständig sind, MUSS die Analyse das in
  // datenqualitaet.luecken explizit benennen und vertrauen entsprechend
  // reduzieren — sonst entsteht der falsche Eindruck einer fundierten
  // Analyse trotz fehlender 10-K/10-Q-Daten.
  let secWarningBlock = '';
  if (sec_status && !sec_status.complete) {
    secWarningBlock = `
## ⚠ SEC-Datenreife (Issue 17)
- Status: ${sec_status.status?.toUpperCase() || 'unbekannt'}${sec_status.timed_out ? ' (Timeout)' : ''}
- Filings verfügbar: ${sec_status.filings_ok ? sec_status.filings_count + ' Stück' : 'NEIN'}
- XBRL FY-Reihen: ${sec_status.fundamentals_ok ? sec_status.fy_count + ' Jahre' : 'NEIN'}
${sec_status.message ? '- Hinweis: ' + sec_status.message : ''}

WICHTIG: Du musst datenqualitaet.vertrauen AUF "niedrig" setzen, falls XBRL-Fundamentaldaten fehlen, und in datenqualitaet.luecken explizit "${sec_status.missing ? 'Keine SEC-Historie (10-K/10-Q nicht verfügbar)' : 'SEC-Historie unvollständig'}" aufführen.
`;
  }
  return `Erzeuge eine strukturierte Analyse für ${info?.longName || info?.shortName || ticker} (${ticker}).

## Basisdaten
- Börse: ${info?.exchange || '—'}
- Sektor: ${info?.sector || '—'}
- Industrie: ${info?.industry || '—'}
- Marktkap.: ${info?.market_cap ? '$' + (info.market_cap / 1e9).toFixed(2) + 'B' : '—'}
- Letzter Kurs: ${info?.price ?? '—'} ${info?.currency || ''}
- 52W-Hoch: ${info?.year_high ?? '—'}, 52W-Tief: ${info?.year_low ?? '—'}
${secWarningBlock}
## Fundamentaldaten (aus SEC XBRL)
${compactFinancials(fundamentals)}

## Aktuelle SEC-Filings
${compactFilings(filings) || '— Keine Filings verfügbar (eventuell kein US-Listing) —'}

## Aktuelle News (Top 12)
${compactNews(news) || '— Keine News verfügbar —'}

## Auftrag
Liefere ein JSON-Objekt mit genau diesem Schema (alle Felder erforderlich, kein zusätzlicher Text):

{
  "steckbrief": {
    "kurzbeschreibung": "1-2 Sätze, was die Firma macht und womit sie Geld verdient",
    "geschaeftsmodell": "Detail (3-5 Sätze) zu Umsatzquellen, Kundenstruktur",
    "marktposition": "Position im Markt: Marktanteil-Hinweise, Konkurrenten, geographisch"
  },
  "burggraben": {
    "score": 0-100,
    "begruendung": "Detail (3-5 Sätze)",
    "faktoren": {
      "marken": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "..."},
      "wechselkosten": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "..."},
      "netzwerkeffekte": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "..."},
      "skaleneffekte": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "..."},
      "preissetzungsmacht": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "..."},
      "patente_ip": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "..."}
    }
  },
  "wachstumstreiber": ["Treiber 1", "Treiber 2", "Treiber 3"],
  "risiken": [
    {"risiko": "Kurzbezeichnung", "wahrscheinlichkeit": "niedrig|mittel|hoch", "auswirkung": "niedrig|mittel|hoch", "details": "..."}
  ],
  "katalysatoren": ["Kurzfristiger Auslöser 1", "..."],
  "bewertung_kommentar": "Einschätzung Bewertungsniveau aus Daten (KGV, Wachstum, Margen) — keine Kursziele",
  "szenarien": {
    "bull": {"these": "...", "wahrscheinlichkeit": 0-100, "treiber": ["...", "..."]},
    "base": {"these": "...", "wahrscheinlichkeit": 0-100, "treiber": ["...", "..."]},
    "bear": {"these": "...", "wahrscheinlichkeit": 0-100, "treiber": ["...", "..."]}
  },
  "investment_these": {
    "pro": ["Argument 1", "Argument 2", "Argument 3"],
    "contra": ["Gegenargument 1", "Gegenargument 2"],
    "fazit": "1-2 Sätze Gesamtbild — kein Kaufen/Verkaufen, nur Charakterisierung"
  },
  "peer_vorschlaege": ["TICKER1", "TICKER2", "TICKER3", "TICKER4", "TICKER5"],
  "datenqualitaet": {
    "vertrauen": "niedrig|mittel|hoch",
    "luecken": ["Was fehlt für eine vollständige Bewertung"]
  }
}

Antworte NUR mit dem JSON.`;
}

function extractJSON(s) {
  if (!s) return null;
  // strip codefences if any
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // find first { ... last }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

app.post('/api/analysis', async (req, res) => {
  const { ticker, info, fundamentals, filings, news, sec_status } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  // Issue 17: secStatus in Cache-Key, damit eine Schätz-Analyse nicht später
  // mit einer vollen Analyse verwechselt wird.
  const secKey = sec_status?.status || 'complete';
  const cacheKey = `analysis:${ticker}:${(fundamentals?.fundamentals?.revenue?.fy?.[0]?.filed) || ''}:${secKey}`;
  try {
    const out = await cached(cacheKey, 6 * 60 * 60 * 1000, async () => {
      const prompt = llmPromptOverview({ ticker, info, fundamentals, filings, news, sec_status });
      const r = await fetchJSON(`${TOOLS}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: LLM_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 3000,
        }),
      });
      const json = extractJSON(r.reply || '');
      return { ticker, model: r.model, usage: r.usage, analysis: json, raw_excerpt: !json ? trim(r.reply, 1500) : undefined };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Tiefenanalyse — eigener LLM-Pass über Geschäftsmodell, Zukunftsfähigkeit,
// Konkurrenz, Burggraben. Holt zusätzliche Web-Suchen (Competitors, Markt),
// damit die KI sich nicht nur auf SEC stützt. Bei fehlenden SEC-Daten muss die
// KI Schätzungen aus News/Web ableiten und Confidence pro Sektion angeben.
// ---------------------------------------------------------------------------
function compactCompetitorSearch(items, max = 8) {
  return (items || []).slice(0, max).map((r, i) =>
    `(${i + 1}) ${r.title}\n  ${trim(r.snippet, 200)}\n  Quelle: ${r.url}`
  ).join('\n');
}

function llmPromptDeep({ ticker, info, fundamentals, filings, news, competitorSearch, marketSearch }) {
  const name = info?.longName || info?.shortName || ticker;
  return `Erzeuge eine TIEFENANALYSE für ${name} (${ticker}).

Diese Analyse ergänzt die Kurzübersicht — sei detaillierter, strukturierter und gib pro Sektion
Quellen (URLs aus den gelieferten Daten, Filing-Referenzen oder den Vermerk "Schätzung aus öffentlich
zugänglichen Informationen") sowie ein Confidence-Level (niedrig|mittel|hoch) an.

## Basisdaten
- Börse: ${info?.exchange || '—'}
- Sektor: ${info?.sector || '—'}
- Industrie: ${info?.industry || '—'}
- Marktkap.: ${info?.market_cap ? '$' + (info.market_cap / 1e9).toFixed(2) + 'B' : '—'}
- Letzter Kurs: ${info?.price ?? '—'} ${info?.currency || ''}

## Fundamentaldaten (SEC XBRL)
${compactFinancials(fundamentals)}

## Aktuelle SEC-Filings
${compactFilings(filings) || '— Keine Filings verfügbar (eventuell kein US-Listing) —'}

## Aktuelle News
${compactNews(news) || '— Keine News verfügbar —'}

## Websuche: Wettbewerber & Marktanteile
${compactCompetitorSearch(competitorSearch) || '— Keine Websuche-Treffer —'}

## Websuche: Markttrends & Disruption
${compactCompetitorSearch(marketSearch) || '— Keine Websuche-Treffer —'}

## Auftrag — antworte AUSSCHLIESSLICH mit JSON, genau nach diesem Schema:

{
  "geschaeftsmodell": {
    "typ": "Plattform | Abo | Lizenz | Hardware-Verkauf | Werbung | Transaktionsgebühren | Marktplatz | Cloud-Services | Mischmodell — bitte konkret benennen",
    "wie_geld_verdient": "4-6 Sätze: detailliert, wie das Unternehmen Geld verdient, mit Kundenstruktur",
    "umsatzquellen": [
      {"name": "Segment-Name", "anteil_pct": 0-100 oder null, "beschreibung": "1-2 Sätze"}
    ],
    "skalierbarkeit": {"bewertung": "niedrig|mittel|hoch|sehr-hoch", "begruendung": "..."},
    "abhaengigkeiten": ["Schlüssel-Lieferant", "Konzentration auf Plattform X", "..."],
    "quellen": ["URL oder 10-K-Referenz", "..."],
    "confidence": "niedrig|mittel|hoch",
    "estimate_note": "leer, wenn auf SEC-Daten basierend; sonst kurze Notiz, was geschätzt wurde"
  },
  "zukunftsfaehigkeit": {
    "markttrends": [
      {"trend": "...", "richtung": "rueckenwind|gegenwind|neutral", "details": "..."}
    ],
    "technologie": {"bewertung": "fuehrend|wettbewerbsfaehig|hinterher|gefaehrdet", "details": "..."},
    "regulatorisch": {"bewertung": "rueckenwind|gegenwind|neutral", "details": "..."},
    "tam_wachstum": {"einschaetzung": "schrumpfend|stagnierend|wachsend|stark-wachsend", "begruendung": "..."},
    "disruptionsrisiko": {"niveau": "niedrig|mittel|hoch|sehr-hoch", "begruendung": "..."},
    "quellen": ["URL", "..."],
    "confidence": "niedrig|mittel|hoch",
    "estimate_note": ""
  },
  "konkurrenz": {
    "hauptwettbewerber": [
      {"name": "Firma", "ticker": "TICKER oder null", "marktanteil_pct": "0-100 als Zahl oder null", "staerken": "...", "schwaechen": "..."}
    ],
    "eigener_marktanteil_pct": "Schätzung 0-100 oder null",
    "wettbewerbsvorteile": ["Vorteil 1", "Vorteil 2", "..."],
    "preissetzungsmacht": {"bewertung": "niedrig|mittel|hoch|sehr-hoch", "begruendung": "1-2 Sätze"},
    "marktstruktur": "monopol|duopol|oligopol|fragmentiert",
    "quellen": ["URL", "..."],
    "confidence": "niedrig|mittel|hoch",
    "estimate_note": ""
  },
  "burggraben_detail": {
    "gesamtscore": 0-100,
    "gesamt_begruendung": "2-3 Sätze",
    "marken": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "wechselkosten": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "netzwerkeffekte": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "kostenvorteile": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "skaleneffekte": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "regulatorische_barrieren": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "ip_patente": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "...", "quelle": "SEC|News|Web|Schaetzung"},
    "marktanteil": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "Geschätzter Marktanteil + Trend (gewinnt/verliert)", "quelle": "SEC|News|Web|Schaetzung"},
    "kundeneinbindung": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "Vertragslaufzeiten, Abo-/Retention-Modell, NPS/Churn falls bekannt", "quelle": "SEC|News|Web|Schaetzung"},
    "lieferkettenzugang": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "Exklusive Lieferanten / vertikale Integration / Rohstoffsicherung", "quelle": "SEC|News|Web|Schaetzung"},
    "replikationsrisiko": {"staerke": "schwach|mittel|stark|sehr-stark", "beleg": "Wie leicht kann ein Konkurrent das Geschäftsmodell kopieren? (stark = schwer kopierbar = guter Schutz)", "quelle": "SEC|News|Web|Schaetzung"}
  },
  "datenqualitaet": {
    "vertrauen_overall": "niedrig|mittel|hoch",
    "sec_data_verwendet": true,
    "news_data_verwendet": true,
    "web_data_verwendet": true,
    "luecken": ["Was an SEC/öffentlichen Daten fehlt für eine vollständige Bewertung"],
    "schaetzungen": ["Konkrete Aussagen, die aus Schätzungen statt harten Daten stammen"]
  }
}

WICHTIG:
- Jede Sektion hat eine eigene "quellen"-Liste mit konkreten URLs aus den gelieferten Datenpaketen
  oder Filing-Referenzen wie "10-K FY2024 Item 1A". Erfinde KEINE URLs.
- Wenn SEC-Daten zu einem Punkt fehlen, schätze begründet aus News/Web und vermerke das im
  "estimate_note" der Sektion bzw. in "datenqualitaet.schaetzungen".
- Confidence-Level realistisch wählen: "hoch" nur wenn SEC-Daten + News übereinstimmen.
- Keine Markdown-Codefences, kein erklärender Text — NUR das JSON.`;
}

app.post('/api/deep-analysis', async (req, res) => {
  const { ticker, info, fundamentals, filings, news } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const name = info?.longName || info?.shortName || '';
  const filedStamp = fundamentals?.fundamentals?.revenue?.fy?.[0]?.filed || '';
  const cacheKey = `deep:${ticker}:${filedStamp}:${name}`;

  try {
    const hit = cacheGet(cacheKey);
    if (hit) return res.json(hit);

    const q1 = name ? `${name} (${ticker}) main competitors market share` : `${ticker} stock competitors market share`;
    const q2 = name ? `${name} industry trends growth disruption regulation` : `${ticker} industry trends growth outlook`;
    // Beide Suchen parallel + tolerant gegen Fehler — Suche soll Tiefenanalyse nicht blocken
    const [compR, mktR] = await Promise.allSettled([
      fetchJSON(`${TOOLS}/web/search?q=${encodeURIComponent(q1)}&max_results=8&time=y`),
      fetchJSON(`${TOOLS}/web/search?q=${encodeURIComponent(q2)}&max_results=8&time=y`),
    ]);
    const competitorSearch = compR.status === 'fulfilled' ? (compR.value.results || []) : [];
    const marketSearch = mktR.status === 'fulfilled' ? (mktR.value.results || []) : [];

    const prompt = llmPromptDeep({ ticker, info, fundamentals, filings, news, competitorSearch, marketSearch });

    // Bei leerer/unparsbarer LLM-Antwort einmal retryen — DeepSeek liefert
    // gelegentlich eine leere Reply, ein zweiter Versuch reicht meistens.
    let r, json;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await fetchJSON(`${TOOLS}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: LLM_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4500,
        }),
      });
      json = extractJSON(r.reply || '');
      if (json) break;
    }

    const out = {
      ticker,
      model: r?.model,
      usage: r?.usage,
      deep: json,
      sources: {
        competitor_search: competitorSearch.slice(0, 8),
        market_search: marketSearch.slice(0, 8),
      },
      raw_excerpt: !json ? trim(r?.reply, 1800) : undefined,
    };

    // Nur cachen, wenn die KI sauberes JSON geliefert hat — Fehlversuche
    // sollen den Cache nicht 6h lang blockieren.
    if (json) cacheSet(cacheKey, out, 6 * 60 * 60 * 1000);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Scorecard — regelbasiert aus Fundamentals + Marktdaten + History.
//
// Issue 9: Mehrdimensionale Bewertungslogik.
// Statt einer einzelnen Score-Zahl pro Bereich liefern wir je Bereich eine
// transparente Sub-Dimensions-Liste mit Wert, Schwellenwerten, Gewichtung,
// Beitrag und Quellen-Tag. Zusätzlich:
//   - Business-Quality-Score (preis-unabhängig) vs Stock-Attractiveness-Score
//     (preis-abhängig, mit Fair-Value-Cap >25%)
//   - Momentum-/Alpha-Modul (1M/3M/6M/12M-Returns, Volatilität, Drawdown)
//   - Decision-Matrix (klare Ja/Nein/unklar-Fragen statt nur Zahlen)
// ---------------------------------------------------------------------------

// Berechnet einen Sub-Score linear zwischen lo (=0) und hi (=100). hi<lo
// bedeutet "kleiner = besser" (z.B. KGV, D/E). Liefert volle Transparenz
// (Wert, Threshold, Gewicht, Quelle) damit das UI die Punktherkunft zeigen kann.
function subScore({ key, label, value, lo, hi, format = 'pct', weight = 1, source = 'Fundamentaldaten', note = '' }) {
  const v = (value === null || value === undefined || !Number.isFinite(+value)) ? null : Number(value);
  if (v === null) {
    return { key, label, value: null, score: null, threshold: { lo, hi, format }, weight, source, note, contribution: 0 };
  }
  // lo<hi: höhere Werte sind besser. lo>hi: kleinere Werte sind besser.
  const denom = (hi - lo) || 1e-9;
  const t = (v - lo) / denom;
  const score = Math.max(0, Math.min(100, Math.round(t * 100)));
  return { key, label, value: v, score, threshold: { lo, hi, format }, weight, source, note, contribution: 0 };
}

function aggregateSubs(subs) {
  const valid = subs.filter(s => s.score !== null);
  if (!valid.length) return { score: null, subdimensions: subs };
  const wSum = valid.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(valid.reduce((s, x) => s + x.score * x.weight, 0) / wSum);
  // Beitrag jedes Subs zur Aggregat-Score in Punkten (für UI-Erklärung)
  for (const s of subs) {
    s.contribution = s.score === null ? 0 : Math.round((s.score * s.weight / wSum) * 10) / 10;
  }
  return { score, subdimensions: subs };
}

// Aus history (Array {date, close, ...}) Kurs-Performance-Signale ableiten.
// history kommt vom yfinance-Endpoint via /api/quote (5Y, Wochenbasis).
function computeMomentumSignals(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const rows = history.filter(h => h && h.date && Number.isFinite(+h.close));
  if (rows.length < 2) return null;
  const closes = rows.map(h => +h.close);
  const dates = rows.map(h => new Date(h.date));
  const last = closes[closes.length - 1];
  const lastDate = dates[dates.length - 1];

  // Index, der am nächsten an N Tagen vor letztem Datum liegt
  const findIdxBefore = (days) => {
    const target = lastDate.getTime() - days * 86400000;
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < dates.length; i++) {
      const diff = Math.abs(dates[i].getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    // Nur wenn historisch genug Daten vorhanden sind (toleranz +/- 30%)
    if (Math.abs(dates[bestIdx].getTime() - target) > days * 0.40 * 86400000) return -1;
    return bestIdx;
  };

  const ret = (days) => {
    const idx = findIdxBefore(days);
    if (idx < 0 || idx >= closes.length - 1) return null;
    const old = closes[idx];
    if (!Number.isFinite(old) || old <= 0) return null;
    return (last - old) / old;
  };

  // Volatilität (ann.) aus log-returns der letzten ~26 Datenpunkte (Wochenbasis: 6 Monate)
  let volatility = null;
  if (closes.length >= 10) {
    const recent = closes.slice(-26);
    const logRets = [];
    for (let i = 1; i < recent.length; i++) {
      if (recent[i - 1] > 0 && recent[i] > 0) logRets.push(Math.log(recent[i] / recent[i - 1]));
    }
    if (logRets.length >= 4) {
      const mean = logRets.reduce((a, b) => a + b, 0) / logRets.length;
      const variance = logRets.reduce((a, b) => a + (b - mean) ** 2, 0) / logRets.length;
      // Wochen-Vola → annualisiert (52 Wochen)
      volatility = Math.sqrt(variance * 52);
    }
  }

  // Max Drawdown 12M (oder so lange Daten reichen)
  let maxDrawdown = null;
  if (closes.length >= 4) {
    const recent = closes.slice(-52);
    let peak = recent[0];
    let mdd = 0;
    for (const c of recent) {
      if (c > peak) peak = c;
      const dd = (c - peak) / peak;
      if (dd < mdd) mdd = dd;
    }
    maxDrawdown = mdd;
  }

  return {
    ret1m: ret(30),
    ret3m: ret(91),
    ret6m: ret(182),
    ret12m: ret(365),
    volatility,
    max_drawdown: maxDrawdown,
    last_price: last,
    last_date: lastDate.toISOString().slice(0, 10),
  };
}

// News-Sentiment-Score aus Schlagwort-Heuristik (0-100, 50=neutral)
function newsSentimentScore(news) {
  if (!news?.length) return null;
  const pos = ['beats', 'beat', 'soars', 'jumps', 'gains', 'upgrade', 'record', 'strong', 'profit', 'rises', 'outperform', 'buy'];
  const neg = ['miss', 'misses', 'falls', 'plunge', 'drop', 'downgrade', 'lawsuit', 'probe', 'warns', 'cut', 'underperform', 'sell', 'loss', 'fraud', 'sec investigation'];
  let p = 0, n = 0;
  for (const item of news) {
    const txt = ((item.title || '') + ' ' + (item.snippet || '')).toLowerCase();
    pos.forEach(k => { if (txt.includes(k)) p++; });
    neg.forEach(k => { if (txt.includes(k)) n++; });
  }
  const total = p + n;
  if (total === 0) return 50;
  return Math.round(50 + ((p - n) / total) * 40);
}

// ---------------------------------------------------------------------------
// Technische Indikatoren (Issue 13): RSI(14), MACD(12/26/9), Bollinger(20, 2),
// 12-Monats- und 20-Monats-Momentum. Berechnet aus Tagesschlusskursen.
// ---------------------------------------------------------------------------
function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function ema(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const k = 2 / (n + 1);
  // Initial: SMA der ersten n Werte
  let e = 0;
  for (let i = 0; i < n; i++) e += arr[i];
  e /= n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// EMA-Serie zurück geben (nicht nur letzten Wert) — für MACD/Signal nötig
function emaSeries(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return [];
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += arr[i];
  e /= n;
  const out = new Array(n - 1).fill(null);
  out.push(e);
  for (let i = n; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signal) return null;
  const efast = emaSeries(closes, fast);
  const eslow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => (efast[i] !== null && eslow[i] !== null) ? efast[i] - eslow[i] : null);
  // Signal-EMA über die nicht-null MACD-Werte
  const macdValid = macdLine.filter(v => v !== null);
  if (macdValid.length < signal) return null;
  const sigSeries = emaSeries(macdValid, signal);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSig = sigSeries[sigSeries.length - 1];
  if (lastMacd == null || lastSig == null) return null;
  const hist = lastMacd - lastSig;
  // Vorheriges Histogramm zur Trend-Beurteilung (Bullish/Bearish-Cross)
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSig = sigSeries[sigSeries.length - 2];
  const prevHist = (prevMacd != null && prevSig != null) ? prevMacd - prevSig : null;
  let cross = null;
  if (prevHist !== null) {
    if (prevHist < 0 && hist >= 0) cross = 'bullish';
    else if (prevHist > 0 && hist <= 0) cross = 'bearish';
  }
  return { macd: lastMacd, signal: lastSig, histogram: hist, prev_histogram: prevHist, cross };
}

function computeBollinger(closes, period = 20, mult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  const last = closes[closes.length - 1];
  const bandwidth = mean !== 0 ? (upper - lower) / mean : null;
  const pctB = (upper - lower) !== 0 ? (last - lower) / (upper - lower) : null;
  return { middle: mean, upper, lower, last, bandwidth, percent_b: pctB };
}

// 12- und 20-Monats-Momentum aus Tages-Closes (~21 Trading-Tage pro Monat)
function computeLongMomentum(closes) {
  if (!Array.isArray(closes) || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const at = (back) => {
    const idx = closes.length - 1 - back;
    if (idx < 0) return null;
    const old = closes[idx];
    if (!Number.isFinite(old) || old <= 0) return null;
    return (last - old) / old;
  };
  return {
    mom_12m: at(252),       // ~12 Monate
    mom_20m: at(420),       // ~20 Monate
  };
}

function interpretRSI(r) {
  if (r === null) return null;
  if (r >= 70) return 'überkauft';
  if (r <= 30) return 'überverkauft';
  if (r >= 55) return 'bullish';
  if (r <= 45) return 'bearish';
  return 'neutral';
}

function interpretBB(bb) {
  if (!bb) return null;
  const p = bb.percent_b;
  if (p == null) return null;
  if (p >= 1.0) return 'oberhalb oberes Band — möglicher Squeeze nach oben oder Überhitzung';
  if (p <= 0.0) return 'unterhalb unteres Band — möglicher Squeeze nach unten oder Überverkauf';
  if (p >= 0.8) return 'nahe oberes Band — starkes Momentum';
  if (p <= 0.2) return 'nahe unteres Band — schwaches Momentum';
  return 'in mittlerer Bandbreite — neutral';
}

function buildTechnical(history, dailyHistory) {
  // Bevorzugt Tagesdaten (daily) für RSI/MACD/BB; fällt zurück auf gegebenes
  // history-Array (oft Wochenkurse). 20-Monats-Momentum braucht daily, sonst null.
  const closes = (Array.isArray(dailyHistory) && dailyHistory.length > 30
    ? dailyHistory
    : Array.isArray(history) ? history : []
  ).filter(h => h && Number.isFinite(+h.close)).map(h => +h.close);

  if (closes.length < 30) {
    return { error: 'unzureichend Kursdaten', closes_count: closes.length };
  }
  const rsi = computeRSI(closes, 14);
  const macd = computeMACD(closes, 12, 26, 9);
  const bb = computeBollinger(closes, 20, 2);
  const longMom = computeLongMomentum(closes);

  return {
    closes_count: closes.length,
    last_price: closes[closes.length - 1],
    rsi: rsi !== null ? +rsi.toFixed(2) : null,
    rsi_interpretation: interpretRSI(rsi),
    macd: macd ? {
      macd: +macd.macd.toFixed(4),
      signal: +macd.signal.toFixed(4),
      histogram: +macd.histogram.toFixed(4),
      cross: macd.cross,
      trend: macd.histogram > 0 ? 'bullish' : 'bearish',
    } : null,
    bollinger: bb ? {
      middle: +bb.middle.toFixed(2),
      upper: +bb.upper.toFixed(2),
      lower: +bb.lower.toFixed(2),
      bandwidth: bb.bandwidth != null ? +bb.bandwidth.toFixed(4) : null,
      percent_b: bb.percent_b != null ? +bb.percent_b.toFixed(3) : null,
      interpretation: interpretBB(bb),
    } : null,
    momentum_long: longMom ? {
      mom_12m: longMom.mom_12m != null ? +longMom.mom_12m.toFixed(4) : null,
      mom_20m: longMom.mom_20m != null ? +longMom.mom_20m.toFixed(4) : null,
    } : null,
  };
}

// Eigener Endpoint: zieht Tagesdaten via tools-server, rechnet Indikatoren.
app.get('/api/technical', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const data = await cached(`technical:${ticker}`, 30 * 60 * 1000, async () => {
      // 2 Jahre tagesgenau reicht für 20-Monats-Momentum (~420 TT) + alle Indikatoren
      const quote = await fetchJSON(`${TOOLS}/stocks?ticker=${encodeURIComponent(ticker)}&range=2y&interval=1d`).catch(() => null);
      const daily = Array.isArray(quote?.history) ? quote.history : [];
      const t = buildTechnical(null, daily);
      return { ticker, source: 'yfinance (1d, 2y)', ...t };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Fear & Greed Index (Issue 13)
// Primär: CNN production.dataviz.cnn.io (mit Referer/Origin als Bot-Bypass).
// Fallback: alternative.me (Crypto-F&G — generischer Marktstimmungs-Proxy).
// ---------------------------------------------------------------------------
async function fetchCnnFearGreed() {
  const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
  const data = await fetchJSON(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://edition.cnn.com/',
      'Origin': 'https://edition.cnn.com',
    },
  });
  const fg = data?.fear_and_greed;
  if (!fg || fg.score == null) throw new Error('CNN: kein fear_and_greed-Feld');
  const score = Math.round(+fg.score);
  return {
    source: 'CNN Fear & Greed Index',
    source_url: 'https://edition.cnn.com/markets/fear-and-greed',
    score,
    rating: fg.rating || classifyFearGreed(score),
    timestamp: fg.timestamp || null,
    previous_close: fg.previous_close != null ? +fg.previous_close : null,
    previous_week: fg.previous_1_week != null ? +fg.previous_1_week : null,
    previous_month: fg.previous_1_month != null ? +fg.previous_1_month : null,
    previous_year: fg.previous_1_year != null ? +fg.previous_1_year : null,
  };
}

async function fetchAlternativeFearGreed() {
  const url = 'https://api.alternative.me/fng/?limit=1';
  const data = await fetchJSON(url);
  const d = Array.isArray(data?.data) ? data.data[0] : null;
  if (!d) throw new Error('alternative.me: leere Antwort');
  const score = +d.value;
  return {
    source: 'alternative.me Crypto Fear & Greed (Fallback)',
    source_url: 'https://alternative.me/crypto/fear-and-greed-index/',
    score,
    rating: (d.value_classification || classifyFearGreed(score)).toLowerCase(),
    timestamp: d.timestamp ? new Date(+d.timestamp * 1000).toISOString() : null,
    note: 'CNN-Daten nicht verfügbar — alternative.me liefert Crypto-Stimmung als Markt-Proxy.',
  };
}

function classifyFearGreed(score) {
  if (score == null) return 'unknown';
  if (score >= 75) return 'extreme greed';
  if (score >= 55) return 'greed';
  if (score >= 45) return 'neutral';
  if (score >= 25) return 'fear';
  return 'extreme fear';
}

app.get('/api/fear-greed', async (_req, res) => {
  try {
    const data = await cached('fear_greed:current', 30 * 60 * 1000, async () => {
      try { return await fetchCnnFearGreed(); }
      catch (e1) {
        console.warn('CNN F&G failed:', e1.message);
        try { return await fetchAlternativeFearGreed(); }
        catch (e2) {
          console.warn('alternative.me F&G failed:', e2.message);
          return { error: 'Fear & Greed nicht erreichbar', detail: e1.message + ' / ' + e2.message };
        }
      }
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Decision-Matrix (Issue 9): klare Ja/Nein/unklar-Fragen statt reiner Punktzahl.
function buildDecisionMatrix({ quality, growth, valuation, moat, sentiment, risk, businessQuality, stockAttractiveness, mom, fairValue }) {
  const yes = (s, t) => s !== null && s !== undefined && s >= t;
  const no = (s, t) => s !== null && s !== undefined && s < t;
  const tri = (j, n) => j ? 'ja' : (n ? 'nein' : 'unklar');

  const upside = fairValue?.summary?.upside;
  const m3 = mom?.ret3m;

  const fragen = [
    {
      key: 'hochwertig',
      frage: 'Ist das Unternehmen hochwertig?',
      antwort: tri(yes(businessQuality, 65), no(businessQuality, 45)),
      score: businessQuality,
      begruendung: businessQuality === null
        ? 'Keine ausreichende Datenbasis.'
        : (businessQuality >= 65 ? `Business-Quality-Score ${businessQuality}/100: solide Margen, Burggraben-Proxy und Wachstum.`
          : businessQuality < 45 ? `Business-Quality-Score nur ${businessQuality}/100: schwache fundamentale Qualität.`
          : `Business-Quality-Score ${businessQuality}/100 — Stärken und Schwächen ungefähr ausgeglichen.`),
    },
    {
      key: 'guenstig',
      frage: 'Ist die Aktie aktuell günstig?',
      // Issue 19: "ja" nur wenn BEIDE Indikatoren positiv sind (Score ≥ 60
      // UND Upside > +10%) ODER der Score sehr hoch ist (≥75). "nein" sobald
      // einer der beiden Indikatoren klar negativ ist (Score <30 ODER
      // Upside <-20%) — vorher wurde "günstig" gezeigt bei Score 42 und
      // Upside −38.6%, weil ODER-Logik im "nein"-Pfad zwar griff, das "ja"
      // aber auch fälschlich positiv konnotiert wurde.
      antwort: (() => {
        const hasV = valuation !== null && valuation !== undefined;
        const hasU = upside !== null && upside !== undefined;
        // Klare "nein"-Trigger: Score deutlich niedrig ODER Upside stark negativ
        if ((hasV && valuation < 30) || (hasU && upside < -0.20)) return 'nein';
        // "ja" nur bei klaren Belegen aus BEIDEN Quellen oder sehr hohem Score
        if ((hasV && valuation >= 60 && (!hasU || upside > 0.05))
          || (hasV && valuation >= 75)
          || (hasU && upside > 0.15 && (!hasV || valuation >= 50))) return 'ja';
        return 'unklar';
      })(),
      score: valuation,
      begruendung: (() => {
        if (valuation === null) return 'Bewertungsdaten unvollständig.';
        const upTxt = (upside !== null && upside !== undefined)
          ? ` · Fair-Value-Upside ${(upside * 100).toFixed(1)}%` : '';
        // Issue 19: Textlogik reparieren — wenn Score niedrig oder Upside
        // stark negativ ist, NICHT von "attraktiver Bewertung" sprechen.
        const negUp = (upside !== null && upside !== undefined && upside < -0.10);
        if (valuation < 40 || negUp) {
          // Hochwertiges Unternehmen, aber teure Aktie? Margen/ROE landen im
          // Quality-Score — wir formulieren neutral statt positiv.
          if (negUp && valuation < 60) {
            return `Bewertungs-Score ${valuation}/100${upTxt}: aktuell nicht günstig bewertet (Aktie über Fair-Value-Median).`;
          }
          return `Bewertungs-Score ${valuation}/100${upTxt}: keine attraktive Bewertung erkennbar.`;
        }
        if (valuation >= 60) return `Bewertungs-Score ${valuation}/100${upTxt}: solide Multiples relativ zu Sektor.`;
        return `Bewertungs-Score ${valuation}/100${upTxt}.`;
      })(),
    },
    {
      key: 'burggraben',
      frage: 'Hat das Unternehmen einen Burggraben?',
      antwort: tri(yes(moat, 65), no(moat, 40)),
      score: moat,
      begruendung: moat === null ? 'Burggraben-Proxy nicht berechenbar.'
        : `Moat-Proxy ${moat}/100 (aus Margen + Kapitaleffizienz; KI-Tiefenanalyse verfeinert).`,
    },
    {
      key: 'wachstum',
      frage: 'Wächst das Unternehmen?',
      antwort: tri(yes(growth, 55), no(growth, 30)),
      score: growth,
      begruendung: growth === null ? 'Wachstumsdaten fehlen.'
        : `Wachstums-Score ${growth}/100 (Umsatz 1J/3J/5J + EPS/Net-Income).`,
    },
    {
      key: 'momentum',
      frage: 'Hat die Aktie Momentum?',
      antwort: (m3 === null || m3 === undefined) ? 'unklar'
        : (m3 > 0.10 ? 'ja' : m3 < -0.10 ? 'nein' : 'unklar'),
      score: sentiment,
      begruendung: (m3 === null || m3 === undefined)
        ? 'Kursdaten unvollständig.'
        : `3-Monats-Performance ${(m3 * 100).toFixed(1)}%${sentiment !== null ? `, Sentiment-Score ${sentiment}/100` : ''}.`,
    },
    {
      key: 'risiko',
      frage: 'Ist das Risiko überschaubar?',
      antwort: tri(yes(risk, 60), no(risk, 35)),
      score: risk,
      begruendung: risk === null ? 'Risikoindikatoren fehlen.'
        : `Risiko-Schutz-Score ${risk}/100 (höher = geringeres Risiko).`,
    },
  ];

  const jaCount = fragen.filter(q => q.antwort === 'ja').length;
  const neinCount = fragen.filter(q => q.antwort === 'nein').length;
  const unklarCount = fragen.length - jaCount - neinCount;

  let gesamtfazit;
  if (jaCount >= 5) gesamtfazit = 'Starkes Profil — hochwertiges Unternehmen mit attraktiver Bewertung.';
  else if (jaCount >= 4 && neinCount <= 1) gesamtfazit = 'Solides Profil — leichte Bedenken in einzelnen Dimensionen.';
  else if (neinCount >= 4) gesamtfazit = 'Schwaches Profil — mehrere Dimensionen sprechen aktuell dagegen.';
  else if (jaCount === neinCount) gesamtfazit = 'Gemischtes Profil — Stärken und Schwächen halten sich die Waage.';
  else if (jaCount >= 3 && neinCount <= 1) gesamtfazit = 'Tendenziell positiv — die meisten Dimensionen liefern grünes Licht.';
  else gesamtfazit = 'Tendenziell skeptisch — mehr Bedenken als Bestätigungen.';

  return { fragen, ja_count: jaCount, nein_count: neinCount, unklar_count: unklarCount, gesamtfazit };
}

// ---------------------------------------------------------------------------
// Issue 18: KI-Fallback für fehlende Scorecard-Dimensionen.
// Wenn Sub-Dimensions komplett aus SEC-Daten kommen (Qualität, Wachstum,
// Burggraben), schlagen sie bei fehlenden 10-K/10-Q-Daten auf null durch.
// Damit die Scorecard immer Werte zeigt, schätzt der LLM aus dem
// verfügbaren Kontext (Kurs/Momentum, News, Analystenschätzungen, Branche,
// Tiefenanalyse, yfinance-Multiples, Fair-Value, Web-Overview) plausible
// Werte mit Konfidenz-Level und kurzer Begründung.
// ---------------------------------------------------------------------------
const SCORECARD_DIM_DEFS = {
  quality:  { label: 'Qualität',  description: 'Profitabilität, Margen, Kapitalrenditen, Effizienz.', high: '>30% Bruttomarge, hohe ROE/ROA, stabile Margen', low: 'Verlustträchtig, niedrige Renditen, instabile Margen' },
  growth:   { label: 'Wachstum',  description: 'Umsatz- und Gewinnwachstum (1J/3J/5J) sowie Forward-Ausblick.', high: '>20% Umsatzwachstum p.a., positive EPS-Trends', low: 'Schrumpfend oder stagnierend' },
  valuation:{ label: 'Bewertung', description: 'Wie günstig/teuer relativ zu Fundamentaldaten und Fair-Value.', high: 'KGV unter Sektorschnitt, Fair-Value-Upside positiv', low: 'KGV/PEG/KBV deutlich über Sektor, Fair-Value-Discount negativ' },
  moat:     { label: 'Burggraben',description: 'Wettbewerbsvorteile: Marken, Wechselkosten, Netzwerk-/Skaleneffekte, IP.', high: 'Monopol/Oligopol mit Preissetzungsmacht', low: 'Austauschbar, kein erkennbarer Vorteil' },
  risk:     { label: 'Risiko (Schutz)', description: 'Höherer Score = niedrigeres Risiko. Bilanz, Volatilität, Geschäftsmodell-Stabilität.', high: 'Sehr solide Bilanz, niedrige Vola, robustes Geschäft', low: 'Hohe Verschuldung, hohe Vola, Lieferketten-/Regulierungsrisiko' },
  sentiment:{ label: 'Sentiment', description: 'News-Sentiment, Momentum, Markt-Stimmung.', high: 'Positive News, starkes Kursmomentum, Fear&Greed Greed', low: 'Schlechte News, fallender Kurs, panische Marktstimmung' },
};

function compactScorecardContext({ ticker, info, news, yfExtra, history, fairValue, fearGreed, technical, mom, expectations, industry, deep, webOverview, sec_status, partialScores, partialBreakdowns }) {
  const name = info?.longName || info?.shortName || ticker;
  const cur = info?.currency || 'USD';
  const pct = v => (v === null || v === undefined || !Number.isFinite(+v)) ? '—' : (+v * 100).toFixed(1) + '%';
  const num = (v, dp = 2) => (v === null || v === undefined || !Number.isFinite(+v)) ? '—' : (+v).toFixed(dp);
  const money = v => (v === null || v === undefined || !Number.isFinite(+v)) ? '—' : '$' + (+v / 1e9).toFixed(2) + 'B';

  const lines = [];
  lines.push(`# ${name} (${ticker})`);
  lines.push(`Börse ${info?.exchange || '—'} · Sektor ${info?.sector || '—'} · Industrie ${info?.industry || '—'}`);
  lines.push(`Marktkap. ${money(info?.market_cap)} · Kurs ${num(info?.price)} ${cur} · 52W ${num(info?.year_low)}–${num(info?.year_high)} ${cur}`);

  lines.push('\n## yfinance-Multiples & TTM-Margen');
  if (yfExtra) {
    lines.push(`- Forward-KGV: ${num(yfExtra.forwardPE)} · Trailing-KGV: ${num(yfExtra.trailingPE)} · PEG: ${num(yfExtra.pegRatio)}`);
    lines.push(`- KBV: ${num(yfExtra.priceToBook)} · P/S: ${num(yfExtra.priceToSalesTrailing12Months)}`);
    lines.push(`- Bruttomarge TTM: ${pct(yfExtra.grossMargins)} · Op-Marge TTM: ${pct(yfExtra.operatingMargins)} · Nettomarge TTM: ${pct(yfExtra.profitMargins)}`);
    lines.push(`- Umsatzwachstum: ${pct(yfExtra.revenueGrowth)} · Gewinnwachstum: ${pct(yfExtra.earningsGrowth)}`);
    lines.push(`- Dividende: ${pct(yfExtra.dividendYield)}`);
  } else {
    lines.push('— Keine yfinance-Multiples verfügbar —');
  }

  lines.push('\n## Kurs-Momentum (aus History)');
  if (mom) {
    lines.push(`- 1M: ${pct(mom.ret1m)} · 3M: ${pct(mom.ret3m)} · 6M: ${pct(mom.ret6m)} · 12M: ${pct(mom.ret12m)}`);
    lines.push(`- Volatilität (ann.): ${pct(mom.volatility)} · Max Drawdown 12M: ${pct(mom.max_drawdown)}`);
  } else {
    lines.push('— Keine Momentum-Daten —');
  }

  if (technical) {
    lines.push(`- RSI(14): ${num(technical.rsi, 1)} (${technical.rsi_interpretation || '—'})`);
    if (technical.macd) lines.push(`- MACD: ${num(technical.macd.histogram, 3)} (Trend ${technical.macd.trend || '—'})`);
  }

  lines.push('\n## News-Sentiment (Heuristik)');
  const ns = newsSentimentScore(news);
  lines.push(`- Sentiment-Score: ${ns === null ? '—' : ns + '/100'} (50 = neutral)`);
  if (Array.isArray(news) && news.length) {
    lines.push(`- ${news.length} News-Items in den letzten 30T:`);
    lines.push(news.slice(0, 8).map(n => `  - ${n.title || ''}`).join('\n'));
  }

  if (fearGreed && fearGreed.score != null) {
    lines.push(`\n## Fear & Greed Index\n- ${fearGreed.score}/100 (${fearGreed.rating || '—'})`);
  }

  if (fairValue?.summary) {
    lines.push('\n## Fair-Value (Multi-Methode)');
    const fv = fairValue.summary;
    lines.push(`- Median Fair Value: ${num(fv.median)} · Upside vs. Kurs: ${pct(fv.upside)}`);
    if (fv.methods) lines.push(`- Methoden: ${fv.methods.join(', ')}`);
  }

  if (expectations) {
    lines.push('\n## Analystenschätzungen (Konsens)');
    const e = expectations;
    if (e.recommendations) lines.push(`- Recommendations: ${JSON.stringify(e.recommendations).slice(0, 200)}`);
    if (e.earnings_estimate) lines.push(`- Earnings Estimate: ${JSON.stringify(e.earnings_estimate).slice(0, 300)}`);
    if (e.revenue_estimate) lines.push(`- Revenue Estimate: ${JSON.stringify(e.revenue_estimate).slice(0, 300)}`);
    if (e.price_targets) lines.push(`- Kursziele: ${JSON.stringify(e.price_targets).slice(0, 200)}`);
  }

  if (industry) {
    lines.push('\n## Branchen-Ausblick');
    lines.push(trim(typeof industry === 'string' ? industry : (industry.summary || JSON.stringify(industry).slice(0, 600)), 800));
  }

  if (deep) {
    lines.push('\n## KI-Tiefenanalyse (Auszug)');
    const dx = deep.deep || deep;
    if (dx?.geschaeftsmodell) lines.push(`- Geschäftsmodell: ${trim(dx.geschaeftsmodell.zusammenfassung || JSON.stringify(dx.geschaeftsmodell), 400)}`);
    if (dx?.burggraben) lines.push(`- Burggraben: ${trim(dx.burggraben.gesamteinschaetzung || JSON.stringify(dx.burggraben), 400)}`);
    if (dx?.konkurrenz) lines.push(`- Konkurrenz: ${trim(dx.konkurrenz.zusammenfassung || JSON.stringify(dx.konkurrenz), 400)}`);
    if (dx?.zukunftsfaehigkeit) lines.push(`- Zukunft: ${trim(dx.zukunftsfaehigkeit.fazit || JSON.stringify(dx.zukunftsfaehigkeit), 400)}`);
  }

  if (webOverview?.extracted) {
    lines.push('\n## Web-Overview (Fallback, da SEC fehlt)');
    lines.push(trim(webOverview.extracted.summary || JSON.stringify(webOverview.extracted), 500));
  }

  if (sec_status) {
    lines.push(`\n## SEC-Daten-Status: ${sec_status.status?.toUpperCase() || 'unbekannt'}`);
    if (sec_status.message) lines.push(`- ${sec_status.message}`);
  }

  // Bereits berechnete (regelbasierte) Werte mitliefern, damit der LLM
  // konsistent dazu schätzt, statt davon abweichende Werte zu produzieren.
  if (partialScores && Object.values(partialScores).some(v => v !== null && v !== undefined)) {
    lines.push('\n## Bereits berechnete Sub-Scores (regelbasiert, nicht überschreiben)');
    for (const [k, v] of Object.entries(partialScores)) {
      if (v !== null && v !== undefined) lines.push(`- ${SCORECARD_DIM_DEFS[k]?.label || k}: ${v}/100`);
    }
  }

  return lines.join('\n');
}

function buildScorecardAIFillPrompt({ ticker, info, missingDims, context }) {
  const name = info?.longName || info?.shortName || ticker;
  const dimsSpec = missingDims.map(k => {
    const d = SCORECARD_DIM_DEFS[k];
    return `- "${k}" (${d.label}): ${d.description}\n  Hoch (~85-100): ${d.high}\n  Niedrig (~0-25): ${d.low}`;
  }).join('\n');

  const skeleton = missingDims.map(k =>
    `  "${k}": {
    "score": 0-100,
    "confidence": "niedrig" | "mittel" | "hoch",
    "reasoning": "1-3 Sätze: Warum dieser Score? Welche Daten wurden genutzt?",
    "datenbasis": ["Kursverlauf 12M", "yfinance-Margen", "News-Sentiment", "Analystenkonsens", "Branche", "..."],
    "sub_faktoren": [
      { "label": "Kurzlabel des Faktors", "wert": "geschätzter Wert/Trend (z.B. '~28% Op-Marge', 'Premium-Bewertung', 'starke Marke')", "score": 0-100 }
    ]
  }`).join(',\n');

  return `Du sollst fehlende Scorecard-Dimensionen für ${name} (${ticker}) plausibel schätzen, weil die SEC-Daten unvollständig sind.

# Kontextdaten
${context}

# Dimensionen, die du schätzen sollst
${dimsSpec}

# Vorgehen
1. Nutze ALLE verfügbaren Daten: Multiples, Margen-TTM, Kursverlauf, News, Analystenkonsens, Branchenausblick, Tiefenanalyse, Web-Overview.
2. Wenn quasi keine Daten für eine Dimension da sind → confidence "niedrig", score nahe 50 (neutral) mit klarer Begründung.
3. Wenn Marktkennzahlen (TTM-Margen, Multiples) vorhanden sind → confidence "mittel".
4. Wenn zusätzlich Tiefenanalyse + Branchenausblick passen → confidence "hoch".
5. Sub-Faktoren: 2-4 pro Dimension, mit aus den Daten ableitbarem Wert. Falls geschätzt, klar als "geschätzt" markieren.

# Antwortformat (NUR JSON, kein Markdown, keine Erklärungstexte)
{
${skeleton}
}`;
}

async function aiFillMissingScorecardDims({ ticker, info, missingDims, contextPayload }) {
  if (!missingDims.length) return { filled: {}, model: null, error: null };
  const context = compactScorecardContext(contextPayload);
  const prompt = buildScorecardAIFillPrompt({ ticker, info, missingDims, context });
  const ATTEMPTS = [
    { model: undefined,     timeoutMs: 90 * 1000, label: 'deepseek/deepseek-v4-flash' },
    { model: 'gpt-4o-mini', timeoutMs: 60 * 1000, label: 'gpt-4o-mini (fallback)' },
  ];
  let lastErr = null;
  for (let i = 0; i < ATTEMPTS.length; i++) {
    const cfg = ATTEMPTS[i];
    try {
      const body = {
        system: 'Du bist ein nüchterner Equity-Research-Analyst. Antworte ausschließlich mit gültigem JSON nach dem geforderten Schema, kein Markdown, keine Erklärung davor oder danach.',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2200,
      };
      if (cfg.model) body.model = cfg.model;
      console.log(`[scorecard-ai] ${ticker}: Versuch ${i + 1}/${ATTEMPTS.length} → ${cfg.label} für ${missingDims.join(',')}`);
      const r = await fetchJSON(`${TOOLS}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify(body),
      });
      const json = extractJSON(r.reply || '');
      if (!json) { lastErr = new Error('LLM-Antwort enthielt kein JSON'); continue; }
      return { filled: json, model: r.model, error: null };
    } catch (e) {
      lastErr = e;
      console.warn(`[scorecard-ai] ${ticker}: Versuch ${i + 1} fehlgeschlagen — ${e.message}`);
    }
  }
  return { filled: {}, model: null, error: lastErr?.message || 'unbekannt' };
}

// Baut einen synthetischen "Breakdown" aus AI-geschätzten Sub-Faktoren, damit
// die Frontend-Rendering-Logik (renderBreakdownTable) ihn wie einen normalen
// Breakdown anzeigen kann. Threshold ist null = keine numerische Skala — wir
// zeigen den geschätzten Wert als String in der "Wert"-Spalte.
function buildAIBreakdown(dimKey, aiResult) {
  const subs = Array.isArray(aiResult?.sub_faktoren) ? aiResult.sub_faktoren : [];
  const subdimensions = subs.map((s, i) => ({
    key: `${dimKey}_ai_${i}`,
    label: s.label || `Faktor ${i + 1}`,
    value: null,
    value_text: s.wert != null ? String(s.wert) : null,
    score: Number.isFinite(+s.score) ? Math.max(0, Math.min(100, Math.round(+s.score))) : null,
    threshold: { lo: null, hi: null, format: 'text' },
    weight: 1,
    source: 'KI · DeepSeek V4',
    note: '',
    contribution: 0,
    ai_estimated: true,
  }));
  // Beitrag = Score-Anteil (gleichgewichtet)
  const valid = subdimensions.filter(s => s.score !== null);
  if (valid.length) {
    valid.forEach(s => { s.contribution = Math.round((s.score / valid.length) * 10) / 10; });
  }
  return {
    score: Number.isFinite(+aiResult?.score) ? Math.max(0, Math.min(100, Math.round(+aiResult.score))) : null,
    subdimensions,
    ai_estimated: true,
    ai_confidence: aiResult?.confidence || 'niedrig',
    ai_reasoning: aiResult?.reasoning || '',
    ai_datenbasis: Array.isArray(aiResult?.datenbasis) ? aiResult.datenbasis : [],
  };
}

app.post('/api/score', async (req, res) => {
  const { fundamentals = {}, info = {}, news = [], yfExtra = null, history = null, fairValue = null,
          fearGreed = null, technical = null, expectations = null, industry = null, deep = null,
          webOverview = null, sec_status = null, ticker = null } = req.body || {};
  const d = fundamentals.derived || {};
  const f = fundamentals.fundamentals || {};

  // === Qualität ===
  const qBreak = aggregateSubs([
    subScore({ key: 'grossMargin', label: 'Bruttomarge', value: d.grossMargin, lo: 0.15, hi: 0.65, format: 'pct', weight: 1.2, source: 'SEC XBRL' }),
    subScore({ key: 'operatingMargin', label: 'Operative Marge', value: d.operatingMargin, lo: 0.02, hi: 0.30, format: 'pct', weight: 1.4, source: 'SEC XBRL' }),
    subScore({ key: 'netMargin', label: 'Nettomarge', value: d.netMargin, lo: 0.02, hi: 0.25, format: 'pct', weight: 1.2, source: 'SEC XBRL' }),
    subScore({ key: 'fcfMargin', label: 'FCF-Marge', value: d.fcfMargin, lo: 0.02, hi: 0.30, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'roe', label: 'Eigenkapitalrendite (ROE)', value: d.roe, lo: 0.05, hi: 0.35, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'roa', label: 'Gesamtkapitalrendite (ROA)', value: d.roa, lo: 0.02, hi: 0.20, format: 'pct', weight: 0.8, source: 'SEC XBRL' }),
  ]);

  // === Wachstum ===
  const gBreak = aggregateSubs([
    subScore({ key: 'rev1y', label: 'Umsatzwachstum 1J', value: d.revenueGrowth1y, lo: -0.05, hi: 0.30, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'rev3y', label: 'Umsatzwachstum 3J', value: d.revenueGrowth3y, lo: 0.00, hi: 0.80, format: 'pct', weight: 1.2, source: 'SEC XBRL' }),
    subScore({ key: 'rev5y', label: 'Umsatzwachstum 5J', value: d.revenueGrowth5y, lo: 0.00, hi: 1.50, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'eps1y', label: 'EPS-Wachstum 1J', value: d.epsGrowth1y, lo: -0.10, hi: 0.40, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'ni1y', label: 'Nettogewinn-Wachstum 1J', value: d.netIncomeGrowth1y, lo: -0.10, hi: 0.40, format: 'pct', weight: 0.8, source: 'SEC XBRL' }),
  ]);

  // === Bewertung ===
  let pe = null;
  const ttmNi = f.netIncome?.ttm;
  if (info.market_cap && ttmNi) pe = info.market_cap / ttmNi;
  const forwardPE = safeNumber(yfExtra?.forwardPE);
  const forwardEps = safeNumber(yfExtra?.forwardEps);
  const trailingPE = safeNumber(yfExtra?.trailingPE);
  const peg = safeNumber(yfExtra?.pegRatio);
  const pb = safeNumber(yfExtra?.priceToBook);
  const ps = safeNumber(yfExtra?.priceToSalesTrailing12Months);

  // Hinweis: Bei diesen Sub-Scores ist lo>hi → kleinerer Wert ergibt höheren Score.
  const vBreak = aggregateSubs([
    subScore({ key: 'peTtm', label: 'KGV (TTM)', value: pe ?? trailingPE, lo: 60, hi: 8, format: 'num', weight: 1.0, source: 'SEC + Marktkap.', note: 'niedriger = besser' }),
    subScore({ key: 'peFwd', label: 'Forward-KGV', value: forwardPE, lo: 50, hi: 8, format: 'num', weight: 1.5, source: 'yfinance', note: 'niedriger = besser' }),
    subScore({ key: 'peg', label: 'PEG-Ratio', value: peg, lo: 3.5, hi: 0.5, format: 'num', weight: 1.0, source: 'yfinance', note: 'niedriger = besser' }),
    subScore({ key: 'pb', label: 'Kurs-Buchwert', value: pb, lo: 12, hi: 1.0, format: 'num', weight: 0.6, source: 'yfinance', note: 'niedriger = besser' }),
    subScore({ key: 'ps', label: 'Kurs-Umsatz (P/S)', value: ps, lo: 15, hi: 1.0, format: 'num', weight: 0.6, source: 'yfinance', note: 'niedriger = besser' }),
    subScore({ key: 'fvDiscount', label: 'Fair-Value-Spielraum (Upside)', value: fairValue?.summary?.upside, lo: -0.30, hi: 0.30, format: 'pct', weight: 1.4, source: 'Multi-Methode', note: '>0 = Aktie unter Fair-Value' }),
  ]);

  // === Risiko (Issue 19: getrennt in Financial Safety + Investment Risk) ===
  // Financial Safety = Bilanz, Cashflow, Verschuldung — beantwortet "Wie robust
  // ist das Unternehmen?". Investment Risk = Bewertungsrisiko, Kurszyklus,
  // Erwartungs-Volatilität — beantwortet "Wie riskant ist die Aktie aktuell?".
  // Höherer Score = niedrigeres Risiko in beiden Dimensionen.
  const mom = computeMomentumSignals(history);
  const fsBreak = aggregateSubs([
    subScore({ key: 'debtToEquity', label: 'Bilanzrisiko (D/E)', value: d.debtToEquity, lo: 3.5, hi: 0.0, format: 'num', weight: 1.3, source: 'SEC XBRL', note: 'niedriger D/E = besser' }),
    subScore({ key: 'debtToAssets', label: 'Verschuldungsgrad (D/A)', value: d.debtToAssets, lo: 0.85, hi: 0.20, format: 'pct', weight: 0.9, source: 'SEC XBRL', note: 'niedriger = besser' }),
    subScore({ key: 'marginStability', label: 'Margen-Stabilität (Nettomarge)', value: d.netMargin, lo: -0.02, hi: 0.25, format: 'pct', weight: 1.0, source: 'SEC XBRL', note: 'höhere Marge = robuster' }),
    subScore({ key: 'fcfStability', label: 'Cashflow-Stabilität (FCF-Marge)', value: d.fcfMargin, lo: -0.05, hi: 0.25, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
  ]);
  const irBreak = aggregateSubs([
    subScore({ key: 'valuationRisk', label: 'Bewertungsrisiko (Forward-KGV)', value: forwardPE ?? pe ?? trailingPE, lo: 60, hi: 8, format: 'num', weight: 1.4, source: 'KGV-basiert', note: 'hohes KGV → höheres Risiko' }),
    subScore({ key: 'fvDownside', label: 'Fair-Value-Discount-Risiko', value: fairValue?.summary?.upside, lo: -0.30, hi: 0.30, format: 'pct', weight: 1.2, source: 'Multi-Methode', note: 'negatives Upside = Aktie über Fair-Value' }),
    subScore({ key: 'volatility', label: 'Volatilität (ann.)', value: mom?.volatility, lo: 0.80, hi: 0.10, format: 'pct', weight: 1.0, source: 'Kursverlauf', note: 'niedriger = stabiler' }),
    subScore({ key: 'maxDrawdown', label: 'Max Drawdown 12M', value: mom?.max_drawdown, lo: -0.50, hi: 0.0, format: 'pct', weight: 0.8, source: 'Kursverlauf' }),
  ]);
  // Aggregat-Risk-Score (für Backward-Kompatibilität mit Decision-Matrix
  // und Gesamtscore): Mittelwert aus beiden Dimensionen, falls beide
  // vorhanden, sonst der vorhandene Wert.
  const rBreak = (() => {
    const subs = [];
    if (fsBreak?.subdimensions) subs.push(...fsBreak.subdimensions.map(s => ({ ...s, weight: (s.weight || 1) * 0.5 })));
    if (irBreak?.subdimensions) subs.push(...irBreak.subdimensions.map(s => ({ ...s, weight: (s.weight || 1) * 0.5 })));
    return aggregateSubs(subs);
  })();

  // === Sentiment (Issue 19: getrennt in News / Markt / Price Momentum) ===
  // Drei eigenständige Sub-Scores statt ein gemischter Block:
  //   - News-Sentiment: nur News-Heuristik (30T)
  //   - Markt-Sentiment: Fear & Greed + RSI (Mean-Reversion)
  //   - Price Momentum: 1M/3M/6M/12M-Returns
  // Aggregat-Sentiment-Score = Mittel der drei für Backward-Compat.
  const newsSent = newsSentimentScore(news);
  const fgScore = (fearGreed && fearGreed.score != null && Number.isFinite(+fearGreed.score))
    ? +fearGreed.score : null;
  const rsiVal = (technical && Number.isFinite(+technical.rsi)) ? +technical.rsi : null;

  const newsSentBreak = aggregateSubs([
    subScore({ key: 'newsSentiment', label: 'News-Sentiment (30T)', value: newsSent, lo: 0, hi: 100, format: 'num', weight: 1.0, source: 'Web-Suche', note: '0=stark negativ, 100=stark positiv' }),
  ]);
  const marketSentBreak = aggregateSubs([
    subScore({ key: 'fearGreed', label: 'Fear & Greed Index', value: fgScore, lo: 0, hi: 100, format: 'num', weight: 1.4, source: fearGreed?.source || 'CNN/alternative.me', note: 'Markt-Stimmung (0=Panik, 100=Gier)' }),
    subScore({ key: 'rsi14', label: 'RSI(14) Mean-Reversion', value: rsiVal, lo: 80, hi: 30, format: 'num', weight: 0.8, source: 'Tageskurse', note: 'überverkauft <30 = besseres Setup' }),
  ]);
  const momentumBreak = aggregateSubs([
    subScore({ key: 'mom1m', label: 'Kursmomentum 1 Monat', value: mom?.ret1m, lo: -0.15, hi: 0.20, format: 'pct', weight: 0.8, source: 'Kursverlauf' }),
    subScore({ key: 'mom3m', label: 'Kursmomentum 3 Monate', value: mom?.ret3m, lo: -0.20, hi: 0.30, format: 'pct', weight: 1.4, source: 'Kursverlauf' }),
    subScore({ key: 'mom6m', label: 'Kursmomentum 6 Monate', value: mom?.ret6m, lo: -0.30, hi: 0.50, format: 'pct', weight: 1.0, source: 'Kursverlauf' }),
    subScore({ key: 'mom12m', label: 'Kursmomentum 12 Monate', value: mom?.ret12m, lo: -0.30, hi: 0.80, format: 'pct', weight: 0.8, source: 'Kursverlauf' }),
  ]);
  // Aggregat-Sentiment-Breakdown enthält alle Sub-Faktoren beider Säulen,
  // damit die alte Anzeige (Sentiment-Komposition im Momentum-Tab) und die
  // Aggregat-Score-Logik weiterarbeiten.
  const sBreak = aggregateSubs([
    subScore({ key: 'newsSentiment', label: 'News-Sentiment (30T)', value: newsSent, lo: 0, hi: 100, format: 'num', weight: 1.0, source: 'Web-Suche' }),
    subScore({ key: 'fearGreed', label: 'Fear & Greed Index', value: fgScore, lo: 0, hi: 100, format: 'num', weight: 1.0, source: fearGreed?.source || 'CNN/alternative.me', note: 'Markt-Stimmung (0=Panik, 100=Gier)' }),
    subScore({ key: 'rsi14', label: 'RSI(14) Mean-Reversion', value: rsiVal, lo: 80, hi: 30, format: 'num', weight: 0.6, source: 'Tageskurse', note: 'überverkauft <30 = besseres Setup' }),
    subScore({ key: 'mom1m', label: 'Kursmomentum 1 Monat', value: mom?.ret1m, lo: -0.15, hi: 0.20, format: 'pct', weight: 0.8, source: 'Kursverlauf' }),
    subScore({ key: 'mom3m', label: 'Kursmomentum 3 Monate', value: mom?.ret3m, lo: -0.20, hi: 0.30, format: 'pct', weight: 1.2, source: 'Kursverlauf' }),
    subScore({ key: 'mom6m', label: 'Kursmomentum 6 Monate', value: mom?.ret6m, lo: -0.30, hi: 0.50, format: 'pct', weight: 0.8, source: 'Kursverlauf' }),
    subScore({ key: 'mom12m', label: 'Kursmomentum 12 Monate', value: mom?.ret12m, lo: -0.30, hi: 0.80, format: 'pct', weight: 0.6, source: 'Kursverlauf' }),
  ]);
  // Label-Logik (Issue 19): "positiv" nur >60/100, sonst differenziert.
  function sentimentLabel(score) {
    if (score === null || score === undefined) return { label: '—', tone: 'neutral' };
    if (score > 75) return { label: 'sehr positiv', tone: 'positiv' };
    if (score > 60) return { label: 'positiv', tone: 'positiv' };
    if (score > 50) return { label: 'vorsichtig positiv', tone: 'neutral' };
    if (score >= 40) return { label: 'gemischt', tone: 'neutral' };
    if (score >= 25) return { label: 'vorsichtig negativ', tone: 'negativ' };
    return { label: 'negativ', tone: 'negativ' };
  }

  // === Burggraben (Moat) — Proxy aus Margen, Kapitaleffizienz, Skala ===
  // Issue 19: Score wird auf ~92 gedeckelt, da Proxies alleine kein echtes
  // "perfektes" Moat (100/100) belegen können — Soft-Cap signalisiert
  // Unsicherheit gegenüber der KI-Tiefenanalyse, die die Detail-Faktoren
  // bewertet. Wenn die Tiefenanalyse einen Score liefert, kommt der unten
  // statt des Proxies zum Einsatz.
  const mBreak = aggregateSubs([
    subScore({ key: 'pricingPower', label: 'Preissetzungsmacht-Proxy (Bruttomarge)', value: d.grossMargin, lo: 0.20, hi: 0.70, format: 'pct', weight: 1.2, source: 'SEC XBRL' }),
    subScore({ key: 'opLeverage', label: 'Operativer Hebel (Op-Marge)', value: d.operatingMargin, lo: 0.05, hi: 0.35, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'capEfficiency', label: 'Kapitaleffizienz (ROE)', value: d.roe, lo: 0.05, hi: 0.40, format: 'pct', weight: 1.0, source: 'SEC XBRL' }),
    subScore({ key: 'scale', label: 'Skaleneffekt (Umsatz absolut)', value: f.revenue?.ttm || f.revenue?.fy?.[0]?.val, lo: 1e9, hi: 1e11, format: 'money', weight: 0.6, source: 'SEC XBRL' }),
  ]);
  // Soft-Cap auf 92: Proxies können niemals einen echten Burggraben mit 100%
  // Sicherheit belegen — die KI-Detailanalyse hat das letzte Wort (siehe unten).
  if (mBreak && mBreak.score !== null && mBreak.score > 92) mBreak.score = 92;

  let quality = qBreak.score;
  let growth = gBreak.score;
  let valuation = vBreak.score;
  let risk = rBreak.score;
  let sentiment = sBreak.score;
  let moat = mBreak.score;

  // Issue 19: Wenn die KI-Tiefenanalyse einen Moat-Score liefert, übernehmen
  // wir den als Wahrheit — der Proxy aus Margen ist nur Notlösung, wenn die
  // KI-Daten noch fehlen. Damit verschwindet die Diskrepanz zwischen
  // Scorecard-Moat (Proxy) und KI-Detail-Moat (qualitativ).
  let moatSource = 'proxy';
  const rawDeepMoat = deep?.deep?.burggraben_detail?.gesamtscore
    ?? deep?.burggraben_detail?.gesamtscore;
  if (rawDeepMoat !== null && rawDeepMoat !== undefined && Number.isFinite(+rawDeepMoat)) {
    moat = Math.max(0, Math.min(100, Math.round(+rawDeepMoat)));
    moatSource = 'ki-tiefenanalyse';
  }

  const breakdownByKey = {
    quality: qBreak, growth: gBreak, valuation: vBreak, moat: mBreak,
    sentiment: sBreak, risk: rBreak,
    // Issue 19: zusätzliche granulare Breakdowns ohne den Aggregat-Score zu
    // verändern — Frontend kann sie eigenständig anzeigen.
    financial_safety: fsBreak,
    investment_risk: irBreak,
    news_sentiment: newsSentBreak,
    market_sentiment: marketSentBreak,
    price_momentum: momentumBreak,
  };

  // === Issue 18: KI-Fallback für fehlende Dimensionen ===
  // Wenn eine Dimension komplett null ist (alle Sub-Dims null, z.B. weil
  // SEC-Daten fehlen), bitten wir den LLM um eine kontextbasierte Schätzung.
  // Auch wenn nur ein einziger Sub-Score valid ist, ist der Aggregat-Score
  // wenig aussagekräftig — wir behandeln eine Dimension daher als "missing",
  // wenn weniger als 30% des Gewichts durch echte Sub-Scores abgedeckt ist.
  const aiFallback = { applied_dims: [], model: null, error: null, attempted: false };
  const allDims = ['quality', 'growth', 'valuation', 'moat', 'sentiment', 'risk'];
  function isWeaklyCovered(bd) {
    if (!bd || bd.score === null) return true;
    const subs = bd.subdimensions || [];
    if (!subs.length) return true;
    let valid = 0, total = 0;
    for (const s of subs) {
      total += s.weight || 1;
      if (s.score !== null && s.score !== undefined) valid += s.weight || 1;
    }
    return total > 0 && (valid / total) < 0.30;
  }
  const missingDims = allDims.filter(k => isWeaklyCovered(breakdownByKey[k]));
  if (missingDims.length) {
    aiFallback.attempted = true;
    try {
      const tk = (ticker || info?.symbol || '').toString().toUpperCase() || 'UNKNOWN';
      const cacheKey = `score-ai:${tk}:${missingDims.sort().join(',')}:${sec_status?.status || 'unknown'}:${(info?.price ?? '').toString().slice(0,8)}`;
      const cached = cacheGet(cacheKey);
      let aiOut;
      if (cached) {
        aiOut = cached;
      } else {
        aiOut = await aiFillMissingScorecardDims({
          ticker: tk,
          info,
          missingDims,
          contextPayload: {
            ticker: tk, info, news, yfExtra, history, fairValue, fearGreed, technical,
            mom, expectations, industry, deep, webOverview, sec_status,
            partialScores: { quality, growth, valuation, moat, sentiment, risk },
          },
        });
        if (aiOut.filled && Object.keys(aiOut.filled).length) cacheSet(cacheKey, aiOut, 2 * 60 * 60 * 1000);
      }
      aiFallback.model = aiOut.model;
      aiFallback.error = aiOut.error;
      for (const k of missingDims) {
        const r = aiOut.filled?.[k];
        if (!r || !Number.isFinite(+r.score)) continue;
        const aiBd = buildAIBreakdown(k, r);
        breakdownByKey[k] = aiBd;
        const s = aiBd.score;
        if (k === 'quality') quality = s;
        else if (k === 'growth') growth = s;
        else if (k === 'valuation') valuation = s;
        else if (k === 'moat') moat = s;
        else if (k === 'sentiment') sentiment = s;
        else if (k === 'risk') risk = s;
        aiFallback.applied_dims.push(k);
      }
    } catch (e) {
      aiFallback.error = e.message;
      console.warn('[scorecard-ai] unerwarteter Fehler:', e.message);
    }
  }

  // === Gesamtscore (Standard-Gewichtung aus concept.md) ===
  const weights = { quality: 0.25, growth: 0.20, valuation: 0.20, moat: 0.15, sentiment: 0.10, risk: 0.10 };
  const subs = { quality, growth, valuation, moat, sentiment, risk };
  let totalNum = 0, totalDen = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (subs[k] !== null && subs[k] !== undefined) { totalNum += subs[k] * w; totalDen += w; }
  }
  const total = totalDen > 0 ? Math.round(totalNum / totalDen) : null;

  // === Business Quality vs Stock Attractiveness (Issue 9) ===
  // Business Quality: Wie hochwertig ist das Unternehmen? (preis-unabhängig)
  const bqWeights = { quality: 0.40, moat: 0.30, growth: 0.20, risk: 0.10 };
  let bqNum = 0, bqDen = 0;
  for (const [k, w] of Object.entries(bqWeights)) {
    if (subs[k] !== null && subs[k] !== undefined) { bqNum += subs[k] * w; bqDen += w; }
  }
  const businessQuality = bqDen > 0 ? Math.round(bqNum / bqDen) : null;

  // Stock Attractiveness: Wie attraktiv ist die Aktie aktuell? (preis-abhängig)
  const saWeights = { valuation: 0.45, sentiment: 0.20, growth: 0.20, quality: 0.15 };
  let saNum = 0, saDen = 0;
  for (const [k, w] of Object.entries(saWeights)) {
    if (subs[k] !== null && subs[k] !== undefined) { saNum += subs[k] * w; saDen += w; }
  }
  let stockAttractiveness = saDen > 0 ? Math.round(saNum / saDen) : null;

  // Fair-Value-Cap: wenn Fair-Value-Median >25% unter Kurs (upside < -0.25),
  // wird die Aktien-Attraktivität auf max. 75 gedeckelt — Quality-Score kann
  // 90+ sein, eine teure Aktie ist trotzdem nicht "sehr attraktiv".
  const upside = fairValue?.summary?.upside;
  let attractivenessCapReason = null;
  let attractivenessCapApplied = false;
  if (upside !== null && upside !== undefined && upside < -0.25 && stockAttractiveness !== null) {
    const overpricedPct = (Math.abs(upside) * 100).toFixed(1);
    if (stockAttractiveness > 75) {
      attractivenessCapReason = `Fair-Value-Median liegt ${overpricedPct}% unter Kurs (>25%) — Attraktivität wurde von ${stockAttractiveness} auf 75 gedeckelt.`;
      stockAttractiveness = 75;
      attractivenessCapApplied = true;
    } else {
      attractivenessCapReason = `Fair-Value-Median liegt ${overpricedPct}% unter Kurs (>25%) — Bewertungsabschlag fließt bereits über den Bewertungs-Score ein.`;
    }
  }

  // === Decision Matrix (Issue 9) ===
  const decisionMatrix = buildDecisionMatrix({
    quality, growth, valuation, moat, sentiment, risk,
    businessQuality, stockAttractiveness, mom, fairValue,
  });

  // === Verdict + Ampel ===
  let verdict = 'Beobachten';
  let ampel = 'gelb';
  if (total !== null) {
    if (total >= 75 && (risk ?? 0) >= 40) { verdict = 'Attraktiv'; ampel = 'gruen'; }
    else if (total < 40 || (risk !== null && risk < 25)) { verdict = 'Riskant'; ampel = 'rot'; }
    else if (valuation !== null && valuation < 25 && quality !== null && quality >= 60) { verdict = 'Überbewertet'; ampel = 'orange'; }
  }

  // Issue 19: getrennte Sentiment-Sub-Scores im JSON ausweisen (Label-Logik
  // bleibt im Frontend einheitlich, damit ältere Konsumenten der API nicht
  // brechen).
  const newsSentLabel = sentimentLabel(newsSentBreak?.score);
  const marketSentLabel = sentimentLabel(marketSentBreak?.score);
  const momLabel = sentimentLabel(momentumBreak?.score);
  const combinedLabel = sentimentLabel(sentiment);

  res.json({
    scores: {
      quality, growth, valuation, moat, sentiment, risk, total,
      // Issue 19: getrennte Sub-Scores für Risiko und Sentiment
      financial_safety: fsBreak.score,
      investment_risk: irBreak.score,
      news_sentiment: newsSentBreak.score,
      market_sentiment: marketSentBreak.score,
      price_momentum: momentumBreak.score,
    },
    sentiment_labels: {
      combined: combinedLabel,
      news: newsSentLabel,
      market: marketSentLabel,
      momentum: momLabel,
    },
    moat_source: moatSource,
    business_quality_score: businessQuality,
    stock_attractiveness_score: stockAttractiveness,
    attractiveness_cap_applied: attractivenessCapApplied,
    attractiveness_cap_reason: attractivenessCapReason,
    breakdown: breakdownByKey,
    momentum: mom,
    decision_matrix: decisionMatrix,
    weights,
    bq_weights: bqWeights,
    sa_weights: saWeights,
    derived_pe: pe,
    forward_pe: forwardPE,
    forward_eps: forwardEps,
    trailing_pe: trailingPE,
    verdict,
    ampel,
    ai_fallback: aiFallback,
  });
});

// ---------------------------------------------------------------------------
// Peer-Matrix mit Perzentilen (Issue 9)
// Holt für jeden Peer-Ticker die wichtigsten Kennzahlen, normalisiert sie und
// berechnet Perzentile (0-100) innerhalb der Peer-Gruppe inkl. dem Haupt-Ticker.
// ---------------------------------------------------------------------------
function percentileOf(values, target) {
  const vs = values.filter(v => v !== null && v !== undefined && Number.isFinite(+v)).map(Number);
  if (!vs.length || target === null || target === undefined || !Number.isFinite(+target)) return null;
  const t = Number(target);
  let below = 0;
  for (const v of vs) if (v < t) below++;
  return Math.round((below / vs.length) * 100);
}

async function fetchPeerMatrixRow(ticker) {
  const tk = String(ticker).toUpperCase().trim();
  if (!tk) return { ticker: tk, error: 'empty' };
  try {
    // Quote + yfinance-extra parallel — Fundamentaldaten würden SEC-XBRL-Fetches
    // erfordern, was bei 10 Peers viel Zeit kostet. yfinance-extra hat Margins,
    // Growth, Multiples bereits in einem Call.
    const [qR, yxR] = await Promise.allSettled([
      cached(`quote:${tk}:1mo:1d`, 30 * 60 * 1000, () =>
        fetchJSON(`${TOOLS}/stocks?ticker=${encodeURIComponent(tk)}&range=1mo&interval=1d`)
      ),
      cached(`yfx:${tk}`, 6 * 60 * 60 * 1000, () => fetchYfinanceExtra(tk)),
    ]);
    const info = qR.status === 'fulfilled' ? (qR.value.info || {}) : {};
    const yx = yxR.status === 'fulfilled' ? (yxR.value || {}) : {};

    return {
      ticker: tk,
      info: {
        longName: info.longName || info.shortName || tk,
        price: safeNumber(info.price),
        market_cap: safeNumber(info.market_cap),
        currency: info.currency || 'USD',
        exchange: info.exchange || '',
      },
      metrics: {
        revenueGrowth: safeNumber(yx?.revenueGrowth),
        earningsGrowth: safeNumber(yx?.earningsGrowth),
        grossMargin: safeNumber(yx?.grossMargins),
        operatingMargin: safeNumber(yx?.operatingMargins),
        netMargin: safeNumber(yx?.profitMargins),
        forwardPE: safeNumber(yx?.forwardPE),
        trailingPE: safeNumber(yx?.trailingPE),
        peg: safeNumber(yx?.pegRatio),
        priceToBook: safeNumber(yx?.priceToBook),
        priceToSales: safeNumber(yx?.priceToSalesTrailing12Months),
        dividendYield: safeNumber(yx?.dividendYield),
      },
    };
  } catch (e) {
    return { ticker: tk, error: e.message };
  }
}

app.post('/api/peer-matrix', async (req, res) => {
  const main = (req.body?.ticker || '').toString().toUpperCase().trim();
  const peers = Array.isArray(req.body?.peers) ? req.body.peers : [];
  if (!main) return res.status(400).json({ error: 'ticker required' });

  const all = Array.from(new Set([main, ...peers.map(p => String(p).toUpperCase().trim())])).filter(Boolean).slice(0, 12);
  if (all.length < 2) return res.json({ ticker: main, rows: [], note: 'no-peers' });

  try {
    const cacheKey = `peerMatrix:${all.join(',')}`;
    const out = await cached(cacheKey, 30 * 60 * 1000, async () => {
      const rows = await Promise.all(all.map(fetchPeerMatrixRow));
      const valid = rows.filter(r => r && !r.error);
      if (!valid.length) return { ticker: main, rows: [], note: 'no-data' };

      // Metriken: definiere Richtung (higher_is_better: true|false)
      const metricSpec = {
        revenueGrowth: { label: 'Umsatzwachstum', format: 'pct', higher_is_better: true },
        earningsGrowth: { label: 'Gewinnwachstum', format: 'pct', higher_is_better: true },
        grossMargin: { label: 'Bruttomarge', format: 'pct', higher_is_better: true },
        operatingMargin: { label: 'Op. Marge', format: 'pct', higher_is_better: true },
        netMargin: { label: 'Nettomarge', format: 'pct', higher_is_better: true },
        forwardPE: { label: 'Forward-KGV', format: 'num', higher_is_better: false },
        trailingPE: { label: 'KGV (TTM)', format: 'num', higher_is_better: false },
        peg: { label: 'PEG', format: 'num', higher_is_better: false },
        priceToBook: { label: 'KBV', format: 'num', higher_is_better: false },
        priceToSales: { label: 'P/S', format: 'num', higher_is_better: false },
      };

      // Sammle Werte je Metrik aus allen Rows (incl. main) → Percentile berechenbar
      const distribution = {};
      for (const k of Object.keys(metricSpec)) {
        distribution[k] = valid.map(r => r.metrics?.[k]).filter(v => v !== null && v !== undefined && Number.isFinite(+v));
      }

      // Issue 19: Pro Metrik die typische Bandbreite (Median + MAD) bestimmen,
      // damit "auffällige" Werte erkannt werden — Werte > 3.5×MAD vom Median
      // gelten als Ausreißer und bekommen ein Warnsignal in der Frontend-Anzeige.
      const metricStats = {};
      for (const [k, vals] of Object.entries(distribution)) {
        if (!vals.length) { metricStats[k] = null; continue; }
        const sorted = [...vals].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[(sorted.length - 1) / 2];
        const deviations = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
        const mad = deviations.length % 2 === 0
          ? (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2
          : deviations[(deviations.length - 1) / 2];
        metricStats[k] = { median, mad, n: vals.length };
      }

      function validationStatus(metricKey, value) {
        if (value === null || value === undefined || !Number.isFinite(+value)) {
          return { status: 'fehlend', note: 'Wert von yfinance nicht geliefert' };
        }
        const st = metricStats[metricKey];
        if (!st || st.mad === 0 || st.n < 3) return { status: 'ok', note: '' };
        const v = Number(value);
        const z = Math.abs(v - st.median) / Math.max(st.mad, 1e-9);
        if (z > 3.5) {
          return {
            status: 'auffaellig',
            note: `Wert weicht stark vom Peer-Median ab (|Δ| ≈ ${z.toFixed(1)}× MAD) — gegen zweite Quelle prüfen.`,
          };
        }
        return { status: 'ok', note: '' };
      }

      // Datenstand: Cache läuft 30 Min, also "fetched_at" als Snapshot
      const fetchedAt = new Date().toISOString();

      // Pro Row: percentile + validation_status pro Metrik anhängen
      const enriched = valid.map(r => {
        const percentiles = {};
        const validation = {};
        for (const [k, spec] of Object.entries(metricSpec)) {
          const v = r.metrics?.[k];
          let p = percentileOf(distribution[k], v);
          if (p !== null && !spec.higher_is_better) p = 100 - p;
          percentiles[k] = p;
          validation[k] = {
            ...validationStatus(k, v),
            source: 'yfinance',
            fetched_at: fetchedAt,
          };
        }
        return { ...r, percentiles, validation };
      });

      return {
        ticker: main,
        main_row: enriched.find(r => r.ticker === main) || null,
        rows: enriched,
        metric_spec: metricSpec,
        peer_count: enriched.length,
        // Issue 19: globale Metadaten zur Validierung
        data_source: 'yfinance',
        fetched_at: fetchedAt,
        metric_stats: metricStats,
      };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Markterwartungs-Modul (Issue 9) — Konsens, Earnings-Surprise, Guidance-Risk.
// Holt erweiterte yfinance-Felder, die analyst recommendations und earnings
// estimates abdecken, soweit die Bibliothek sie liefert.
// ---------------------------------------------------------------------------
function fetchYfinanceExpectations(ticker) {
  return new Promise((resolve) => {
    const py = `
import json, sys, math
try:
    import yfinance as yf
    t = yf.Ticker(sys.argv[1])
    info = t.info or {}
    out = {
      'recommendation_mean': info.get('recommendationMean'),
      'recommendation_key':  info.get('recommendationKey'),
      'num_analyst_opinions': info.get('numberOfAnalystOpinions'),
      'target_mean': info.get('targetMeanPrice'),
      'target_high': info.get('targetHighPrice'),
      'target_low':  info.get('targetLowPrice'),
      'target_median': info.get('targetMedianPrice'),
      'earnings_growth': info.get('earningsGrowth'),
      'revenue_growth': info.get('revenueGrowth'),
      'earnings_quarterly_growth': info.get('earningsQuarterlyGrowth'),
    }
    # earnings_dates: enthält BEIDE vergangene und kommende Termine.
    # Wir splitten in 'earnings_history' (Vergangenheit, reported_eps vorhanden)
    # und 'next_earnings_date' (Zukunft, reported_eps fehlt).
    try:
        ed = t.earnings_dates
        if ed is not None and len(ed) > 0:
            # Mehr Zeilen einsammeln, damit wir vergangene+zukünftige sauber trennen
            ed = ed.head(8).copy()
            ed.index = ed.index.astype(str)
            recs = []
            for idx, row in ed.iterrows():
                recs.append({
                  'date': str(idx)[:10],
                  'eps_estimate': float(row.get('EPS Estimate')) if row.get('EPS Estimate') == row.get('EPS Estimate') else None,
                  'reported_eps': float(row.get('Reported EPS')) if row.get('Reported EPS') == row.get('Reported EPS') else None,
                  'surprise_pct': float(row.get('Surprise(%)')) if row.get('Surprise(%)') == row.get('Surprise(%)') else None,
                })
            # Vergangene Earnings (mit reported_eps oder Datum in der Vergangenheit)
            today = __import__('datetime').date.today().isoformat()
            past = [r for r in recs if (r['reported_eps'] is not None) or (r['date'] and r['date'] <= today)]
            future = [r for r in recs if (r['reported_eps'] is None) and (r['date'] and r['date'] > today)]
            # earnings_history: max. 4 jüngste Vergangenheit
            out['earnings_history'] = past[:4]
            # Nächster offizieller Termin (falls von yfinance gemeldet) — sonst null
            out['next_earnings_date'] = future[0]['date'] if future else None
    except Exception:
        out['earnings_history'] = None
        out['next_earnings_date'] = None
    # recommendations summary (analyst counts strong-buy/buy/hold/sell/strong-sell)
    try:
        rs = t.recommendations_summary
        if rs is not None and len(rs) > 0:
            r0 = rs.iloc[0].to_dict()
            out['rec_counts'] = {k: (int(v) if v == v else None) for k, v in r0.items() if k in ('strongBuy','buy','hold','sell','strongSell')}
    except Exception:
        pass
    print(json.dumps(out, default=str))
except Exception as e:
    print(json.dumps({'_error': str(e)}))
`;
    const proc = spawn(YF_PYTHON, ['-c', py, ticker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 20000);
    proc.on('close', () => {
      clearTimeout(killer);
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed._error) return resolve(null);
        resolve(parsed);
      } catch {
        if (stderr) console.warn('[yfinance-expect]', ticker, stderr.slice(0, 200));
        resolve(null);
      }
    });
    proc.on('error', (e) => {
      clearTimeout(killer);
      console.warn('[yfinance-expect] spawn failed:', e.message);
      resolve(null);
    });
  });
}

app.get('/api/expectations', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const out = await cached(`expect:${ticker}`, 6 * 60 * 60 * 1000, () => fetchYfinanceExpectations(ticker));
    res.json({ ticker, expectations: out || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Fair Value — Multi-Methoden-Schätzung aus Fundamentaldaten
// Liefert eine Spanne, kein Punktziel. Methoden werden ausgewiesen, damit
// User die Annahmen nachvollziehen kann.
// ---------------------------------------------------------------------------
function computeFairValue({ info = {}, fundamentals = {} }) {
  const f = fundamentals.fundamentals || {};
  const d = fundamentals.derived || {};
  const methods = [];
  const price = safeNumber(info.price);
  const shares = safeNumber(info.shares) || safeNumber(f.sharesOutstanding?.fy?.[0]?.val);
  const marketCap = safeNumber(info.market_cap);

  // EPS bevorzugt TTM, sonst letztes FY-EPS
  let epsTtm = null;
  const epsFy = f.dilutedEps?.fy?.[0]?.val ?? f.basicEps?.fy?.[0]?.val ?? null;
  if (f.netIncome?.ttm && shares) epsTtm = f.netIncome.ttm / shares;
  else if (epsFy !== null) epsTtm = epsFy;

  // Buchwert pro Aktie
  const equity = safeNumber(f.equity?.fy?.[0]?.val);
  const bvps = equity && shares ? equity / shares : null;

  // Wachstumsrate (1-Jahres-Umsatzwachstum als Proxy; geclippt auf -10..+30%)
  let g = safeNumber(d.revenueGrowth1y);
  if (g === null) g = safeNumber(d.revenueGrowth3y);
  const gClip = g === null ? 0.05 : Math.max(-0.10, Math.min(0.30, g));

  // 1) Erwartetes KGV × EPS: KGV-Ziel adaptiert an Wachstum (Bereich 10–25)
  if (epsTtm !== null && epsTtm > 0) {
    const peTarget = Math.max(10, Math.min(25, 12 + gClip * 50));
    const fv = peTarget * epsTtm;
    methods.push({
      key: 'pe_x_eps',
      label: 'KGV × EPS',
      value: fv,
      details: `Ziel-KGV ${peTarget.toFixed(1)} × EPS ${epsTtm.toFixed(2)} (KGV adaptiert an Wachstum ${(gClip * 100).toFixed(1)}%)`,
    });
  }

  // 2) Graham-Number: √(22.5 × EPS × BVPS) — klassische Substanzformel
  if (epsTtm !== null && epsTtm > 0 && bvps !== null && bvps > 0) {
    const fv = Math.sqrt(22.5 * epsTtm * bvps);
    methods.push({
      key: 'graham_number',
      label: 'Graham-Zahl',
      value: fv,
      details: `√(22.5 × EPS ${epsTtm.toFixed(2)} × BVPS ${bvps.toFixed(2)})`,
    });
  }

  // 3) Graham-Formel mit Wachstum: EPS × (8.5 + 2g%)  (Klassiker für Growth-Stocks)
  if (epsTtm !== null && epsTtm > 0 && g !== null) {
    const fv = epsTtm * (8.5 + 2 * (gClip * 100));
    methods.push({
      key: 'graham_growth',
      label: 'Graham-Wachstum',
      value: fv,
      details: `EPS × (8.5 + 2·g) mit g=${(gClip * 100).toFixed(1)}%`,
    });
  }

  // 4) DCF-Light: 5-Jahres-FCF-Projektion mit decay, Terminal-Multiple 15×, Discount 10%
  if (d.fcf && d.fcf > 0 && shares) {
    const fcf0 = d.fcf;
    const discount = 0.10;
    let pv = 0;
    let fcfN = fcf0;
    const growthDecay = [gClip, gClip * 0.85, gClip * 0.70, gClip * 0.55, gClip * 0.40];
    for (let i = 0; i < 5; i++) {
      fcfN = fcfN * (1 + growthDecay[i]);
      pv += fcfN / Math.pow(1 + discount, i + 1);
    }
    const terminal = fcfN * 15;
    pv += terminal / Math.pow(1 + discount, 5);
    const fv = pv / shares;
    methods.push({
      key: 'dcf_light',
      label: 'DCF (vereinfacht)',
      value: fv,
      details: `5y FCF-Projektion (g geclippt, decay), Discount 10%, Terminal 15×FCF₅`,
    });
  }

  // 5) Marktkap-Sanity: Median P/S vs. Sektor — vereinfacht: zielt P/S = 3 an
  if (f.revenue?.ttm && shares) {
    const revPerShare = f.revenue.ttm / shares;
    const psTarget = gClip > 0.15 ? 5 : (gClip > 0.05 ? 3 : 2);
    const fv = psTarget * revPerShare;
    methods.push({
      key: 'ps_target',
      label: 'P/S × Umsatz',
      value: fv,
      details: `Ziel-P/S ${psTarget} × Umsatz/Aktie ${revPerShare.toFixed(2)} (Wachstums-Bucket)`,
    });
  }

  // Aggregat: Median + Range (nur valide Werte)
  const values = methods.map(m => m.value).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  let summary = null;
  if (values.length) {
    const median = values.length % 2 === 0
      ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
      : values[(values.length - 1) / 2];
    const low = values[0];
    const high = values[values.length - 1];
    const upsidePct = price ? (median - price) / price : null;
    summary = { low, median, high, upside: upsidePct, methods_count: values.length };
  }

  return {
    inputs: {
      price, eps_ttm: epsTtm, bvps, growth_used: gClip, shares, market_cap: marketCap,
    },
    methods,
    summary,
  };
}

app.post('/api/fair-value', (req, res) => {
  try {
    const { info, fundamentals } = req.body || {};
    const out = computeFairValue({ info, fundamentals });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Forecast (Issue 11) — KI-Prognose zukünftiger Kennzahlen + 12-Monats-Kursziel
//
// Liefert für FY+1, +2, +3 Bull/Base/Bear-Szenarien für Umsatz, Net Income,
// CAPEX, FCF, EPS, Margen (jeweils mit Konfidenzintervall) und einen konkreten
// 12-Monats-Aktienkursziel als Bull/Base/Bear. Inputs: SEC-Fundamentaldaten
// (Historie), yfinance-Forward-EPS, Analysten-Konsens (expectations), Branchen-
// Ausblick, Deep-Analyse-Wettbewerb. Modell: DeepSeek V4 via tools-server.
// ---------------------------------------------------------------------------
function compactHistoricalSeries(fund) {
  const f = fund?.fundamentals || {};
  const series = (key) => {
    const rows = f[key]?.fy || [];
    return rows.slice(0, 5).reverse().map(r => ({ fy: r.fy, val: r.val })); // älteste zuerst
  };
  const fmtRow = (label, rows, unit) => {
    if (!rows.length) return `- ${label}: — keine Historie`;
    const parts = rows.map(r => {
      if (r.val === null || r.val === undefined || !Number.isFinite(+r.val)) return `FY${r.fy}: —`;
      if (unit === 'B') return `FY${r.fy}: $${(r.val / 1e9).toFixed(2)}B`;
      if (unit === 'eps') return `FY${r.fy}: ${Number(r.val).toFixed(2)}`;
      return `FY${r.fy}: ${r.val}`;
    });
    return `- ${label}: ${parts.join(' · ')}`;
  };
  return [
    fmtRow('Umsatz', series('revenue'), 'B'),
    fmtRow('Net Income', series('netIncome'), 'B'),
    fmtRow('Operating Income', series('operatingIncome'), 'B'),
    fmtRow('CapEx', series('capex'), 'B'),
    fmtRow('Operating Cash Flow', series('operatingCashFlow'), 'B'),
    fmtRow('EPS (verwässert)', series('dilutedEps'), 'eps'),
  ].join('\n');
}

function compactExpectations(ex) {
  if (!ex) return '— Keine Analysten-Erwartungen verfügbar —';
  const lines = [];
  if (ex.recommendation_key) lines.push(`- Empfehlung: ${ex.recommendation_key} (Mean ${ex.recommendation_mean ?? '—'}, ${ex.num_analyst_opinions || '?'} Analysten)`);
  if (ex.target_mean || ex.target_median) {
    lines.push(`- Kursziel: Mean ${ex.target_mean ?? '—'} · Median ${ex.target_median ?? '—'} · Low ${ex.target_low ?? '—'} · High ${ex.target_high ?? '—'}`);
  }
  if (Array.isArray(ex.earnings_history) && ex.earnings_history.length) {
    const surprises = ex.earnings_history.filter(e => e.surprise_pct !== null && e.surprise_pct !== undefined);
    if (surprises.length) {
      const avg = surprises.reduce((s, e) => s + Number(e.surprise_pct), 0) / surprises.length;
      lines.push(`- Earnings-Surprise (Ø ${surprises.length} Quartale): ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`);
    }
  }
  return lines.join('\n') || '— Analysten-Daten unvollständig —';
}

function compactIndustryForForecast(industry) {
  if (!industry?.ai) return '— Keine Branchenanalyse —';
  const ai = industry.ai;
  const lines = [];
  if (ai.gesamteinschaetzung?.zusammenfassung) lines.push(`- Branche: ${ai.gesamteinschaetzung.zusammenfassung}`);
  if (ai.gesamteinschaetzung?.wachstumsphase) lines.push(`- Wachstumsphase: ${ai.gesamteinschaetzung.wachstumsphase}`);
  if (ai.wettbewerb_intensitaet) lines.push(`- Wettbewerbsintensität: ${ai.wettbewerb_intensitaet}`);
  if (ai.disruption_potenzial) lines.push(`- Disruptionspotenzial: ${ai.disruption_potenzial}`);
  if (ai.fazit_fuer_firma) lines.push(`- Position Firma in Branche: ${ai.fazit_fuer_firma}`);
  return lines.join('\n') || '— Branchen-Daten unvollständig —';
}

function compactDeepForForecast(deep) {
  if (!deep?.deep) return '— Keine KI-Tiefenanalyse —';
  const d = deep.deep;
  const lines = [];
  if (d.geschaeftsmodell?.typ) lines.push(`- Geschäftsmodell: ${d.geschaeftsmodell.typ}`);
  if (d.konkurrenz?.marktstruktur) lines.push(`- Marktstruktur: ${d.konkurrenz.marktstruktur}`);
  if (d.konkurrenz?.eigener_marktanteil_pct !== null && d.konkurrenz?.eigener_marktanteil_pct !== undefined) {
    lines.push(`- Eigener Marktanteil (Schätzung): ${d.konkurrenz.eigener_marktanteil_pct}%`);
  }
  if (d.konkurrenz?.preissetzungsmacht?.bewertung) lines.push(`- Preissetzungsmacht: ${d.konkurrenz.preissetzungsmacht.bewertung}`);
  if (d.zukunftsfaehigkeit?.tam_wachstum?.einschaetzung) lines.push(`- TAM-Wachstum: ${d.zukunftsfaehigkeit.tam_wachstum.einschaetzung}`);
  if (d.zukunftsfaehigkeit?.disruptionsrisiko?.niveau) lines.push(`- Disruptionsrisiko: ${d.zukunftsfaehigkeit.disruptionsrisiko.niveau}`);
  if (Array.isArray(d.konkurrenz?.hauptwettbewerber) && d.konkurrenz.hauptwettbewerber.length) {
    const comp = d.konkurrenz.hauptwettbewerber.slice(0, 4).map(c =>
      `${c.name}${c.marktanteil_pct ? ` (${c.marktanteil_pct}%)` : ''}`
    ).join(', ');
    lines.push(`- Hauptwettbewerber: ${comp}`);
  }
  return lines.join('\n') || '— Tiefenanalyse-Daten unvollständig —';
}

function buildForecastPrompt({ ticker, info, fundamentals, yfExtra, expectations, industry, deep, news, filings, sec_status }) {
  const name = info?.longName || info?.shortName || ticker;
  const lastFy = fundamentals?.fundamentals?.revenue?.fy?.[0]?.fy;
  const projFy1 = lastFy ? lastFy + 1 : 'FY+1';
  const projFy2 = lastFy ? lastFy + 2 : 'FY+2';
  const projFy3 = lastFy ? lastFy + 3 : 'FY+3';
  const currency = info?.currency || 'USD';
  const price = info?.price ?? '—';

  // Issue 17: Wenn die Pipeline meldet, dass SEC-Daten partial/missing/timeout
  // sind, muss die KI das in ihrer Antwort transparent machen — Vertrauen
  // niedrig setzen, Limitierungen explizit benennen, keine Scheingenauigkeit.
  let secWarningBlock = '';
  if (sec_status && !sec_status.complete) {
    const lines = [
      `Status: ${sec_status.status?.toUpperCase() || 'unbekannt'}${sec_status.timed_out ? ' (Timeout)' : ''}`,
      `Filings verfügbar: ${sec_status.filings_ok ? sec_status.filings_count + ' Stück' : 'NEIN'}`,
      `XBRL FY-Reihen: ${sec_status.fundamentals_ok ? sec_status.fy_count + ' Jahre' : 'NEIN'}`,
    ];
    if (sec_status.message) lines.push(`Hinweis: ${sec_status.message}`);
    secWarningBlock = `
## ⚠ SEC-Datenreife (Issue 17)
${lines.map(l => `- ${l}`).join('\n')}

**WICHTIG für die Prognose**:
- Die fundamentalen SEC-Daten sind ${sec_status.missing ? 'NICHT verfügbar' : 'unvollständig'}. Du musst dich stärker auf Analysten-Konsens, Forward-EPS und Branchen-Schätzungen stützen.
- Setze datenqualitaet.vertrauen_overall AUF "niedrig" und begründe explizit, welche SEC-Werte fehlen.
- Nenne in quellen.limitierungen mindestens "${sec_status.missing ? 'Keine SEC-Historie (10-K/10-Q nicht verfügbar)' : 'SEC-Historie unvollständig'}".
- Markiere im Feld modell_annahmen, dass die Zahlen Schätzungen sind, nicht aus SEC-Filings abgeleitet.
`;
  }

  return `Erstelle eine KI-gestützte Drei-Jahres-Prognose für ${name} (${ticker}).

## Basisdaten (Stichtag: heute)
- Sektor: ${info?.sector || '—'} · Industrie: ${info?.industry || '—'}
- Marktkap.: ${info?.market_cap ? '$' + (info.market_cap / 1e9).toFixed(2) + 'B' : '—'}
- Aktueller Kurs: ${price} ${currency}
- Letztes berichtetes Geschäftsjahr: ${lastFy ?? '—'}
${secWarningBlock}
## Historische Kennzahlen (SEC XBRL, älteste→neueste)
${compactHistoricalSeries(fundamentals)}

## Forward-Daten (yfinance / Analysten-Konsens)
- Forward EPS: ${yfExtra?.forwardEps ?? '—'} · Trailing EPS: ${yfExtra?.trailingEps ?? '—'}
- Forward KGV: ${yfExtra?.forwardPE ?? '—'} · Trailing KGV: ${yfExtra?.trailingPE ?? '—'}
- PEG: ${yfExtra?.pegRatio ?? '—'} · Umsatz-Wachstum (yfin): ${yfExtra?.revenueGrowth ?? '—'} · Earnings-Wachstum (yfin): ${yfExtra?.earningsGrowth ?? '—'}

## Markterwartung (Analysten-Konsens, Earnings-Surprise)
${compactExpectations(expectations)}

## Branchen-Ausblick (Issue 10)
${compactIndustryForForecast(industry)}

## KI-Tiefenanalyse (Wettbewerb / Marktposition)
${compactDeepForForecast(deep)}

## Aktuelle News (Top 8)
${compactNews((news || []).slice(0, 8)) || '— Keine News —'}

## Aktuelle SEC-Filings (für Forward-Guidance der Firma)
${compactFilings(filings) || '— Keine —'}

## Auftrag
Erzeuge eine drei-Jahres-Prognose (${projFy1}, ${projFy2}, ${projFy3}) sowie ein 12-Monats-Aktienkursziel.
Jede Größe MUSS in Bull/Base/Bear ausgegeben werden, mit explizitem Konfidenzintervall (untere/obere Grenze)
und einer Wahrscheinlichkeit pro Szenario (Summe Bull+Base+Bear = 100). Die Prognose muss konsistent zu den
historischen Daten, Analystenschätzungen, der Branchenentwicklung und der Wettbewerbsposition sein.

Antworte AUSSCHLIESSLICH mit JSON nach folgendem Schema. Beträge in Milliarden ${currency} (B) bzw. Prozent
(als Dezimal, z.B. 0.15 = 15%). EPS und Kurs in ${currency} pro Aktie.

{
  "metadaten": {
    "letztes_fy": ${lastFy ?? 'null'},
    "prognose_jahre": [${projFy1 ? `"FY${projFy1}"` : '"FY+1"'}, ${projFy2 ? `"FY${projFy2}"` : '"FY+2"'}, ${projFy3 ? `"FY${projFy3}"` : '"FY+3"'}],
    "waehrung": "${currency}",
    "modell_annahmen": "2-4 Sätze: zentrale Treiber-Annahmen (z.B. 'Base geht von TAM-Wachstum von X% aus, leicht steigendem Marktanteil und stabilen Margen')"
  },
  "prognose": [
    {
      "fy": ${projFy1 || 'null'},
      "umsatz_b": {"bull": Zahl, "base": Zahl, "bear": Zahl, "intervall": {"unten": Zahl, "oben": Zahl}, "kommentar": "1 Satz"},
      "net_income_b": {"bull": Zahl, "base": Zahl, "bear": Zahl, "intervall": {"unten": Zahl, "oben": Zahl}, "kommentar": "1 Satz"},
      "capex_b": {"bull": Zahl, "base": Zahl, "bear": Zahl, "intervall": {"unten": Zahl, "oben": Zahl}, "kommentar": "1 Satz"},
      "fcf_b": {"bull": Zahl, "base": Zahl, "bear": Zahl, "intervall": {"unten": Zahl, "oben": Zahl}, "kommentar": "1 Satz"},
      "eps": {"bull": Zahl, "base": Zahl, "bear": Zahl, "intervall": {"unten": Zahl, "oben": Zahl}, "kommentar": "1 Satz"},
      "operating_margin": {"bull": Dezimal, "base": Dezimal, "bear": Dezimal, "kommentar": "1 Satz"},
      "net_margin": {"bull": Dezimal, "base": Dezimal, "bear": Dezimal, "kommentar": "1 Satz"}
    },
    { "fy": ${projFy2 || 'null'}, "umsatz_b": {...}, "net_income_b": {...}, "capex_b": {...}, "fcf_b": {...}, "eps": {...}, "operating_margin": {...}, "net_margin": {...} },
    { "fy": ${projFy3 || 'null'}, "umsatz_b": {...}, "net_income_b": {...}, "capex_b": {...}, "fcf_b": {...}, "eps": {...}, "operating_margin": {...}, "net_margin": {...} }
  ],
  "kurs_prognose_12m": {
    "horizont_monate": 12,
    "aktueller_kurs": ${typeof price === 'number' ? price : 'null'},
    "waehrung": "${currency}",
    "bull": {"kurs": Zahl, "wahrscheinlichkeit_pct": Zahl, "treiber": ["...", "...", "..."], "implizites_kgv": Zahl, "kommentar": "1-2 Sätze"},
    "base": {"kurs": Zahl, "wahrscheinlichkeit_pct": Zahl, "treiber": ["...", "...", "..."], "implizites_kgv": Zahl, "kommentar": "1-2 Sätze"},
    "bear": {"kurs": Zahl, "wahrscheinlichkeit_pct": Zahl, "treiber": ["...", "...", "..."], "implizites_kgv": Zahl, "kommentar": "1-2 Sätze"},
    "konfidenz_kurs": {"unten": Zahl, "oben": Zahl, "konfidenz_pct": 50-95, "begruendung": "Wie eng/weit ist das Intervall und warum?"},
    "vergleich_analystenziel": "Wie steht eure Base-Schätzung zum Analysten-Mean-Target? (1-2 Sätze)"
  },
  "markt_kontext": {
    "tam_wachstum_pa": "Erwartetes TAM-Wachstum p.a. (Dezimal, z.B. 0.08) oder null",
    "tam_wachstum_begruendung": "1-2 Sätze",
    "marktanteilsentwicklung": {
      "richtung": "stark-steigend|steigend|stabil|fallend|stark-fallend",
      "begruendung": "1-2 Sätze",
      "implizierter_anteil_in_3j_pct": "0-100 oder null"
    },
    "konkurrenzstaerke": {
      "bewertung": "niedrig|mittel|hoch|sehr-hoch",
      "wettbewerbsintensitaet": "niedrig|mittel|hoch|sehr-hoch",
      "markteintrittsbarrieren": "niedrig|mittel|hoch|sehr-hoch",
      "substitutionsrisiko": "niedrig|mittel|hoch|sehr-hoch",
      "begruendung": "2-3 Sätze"
    }
  },
  "bewertungs_implikation": {
    "fair_value_adjustment": "deutlich-niedriger|niedriger|neutral|hoeher|deutlich-hoeher",
    "begruendung": "2-3 Sätze: Wie verändert die Prognose die Fair-Value-Spanne gegenüber der reinen TTM-Bewertung?",
    "scorecard_impact": "Welche Sub-Scores (Wachstum/Bewertung/Burggraben) sollten sich wie verschieben? (2-3 Sätze)"
  },
  "quellen": {
    "primär": ["SEC-Historie", "Analysten-Konsens", "Branchen-Ausblick", "..."],
    "limitierungen": ["Konkrete Datenlücke 1", "Konkrete Datenlücke 2"]
  },
  "datenqualitaet": {
    "vertrauen_overall": "niedrig|mittel|hoch",
    "begruendung": "Warum dieses Vertrauensniveau?"
  }
}

WICHTIG:
- Bull > Base > Bear in jeder Zeile. Konfidenzintervall (unten/oben) ungefähr Bear/Bull oder enger.
- Verwende historische CAGR und Analysten-Forward-Daten als Anker — keine Fantasiezahlen.
- Branchen-Disruption und Konkurrenzstärke MÜSSEN die Marge- und Marktanteilsprognose beeinflussen.
- Wahrscheinlichkeiten Bull+Base+Bear = 100. Realistisch verteilen (Base meist 40-60).
- Implizites KGV beim Kursziel = projizierter Kurs / projizierter FY+1-EPS.
- Konfidenz-Prozent beim Kursziel zwischen 50-95 (höher = engerer Bereich, mehr Vertrauen).
- Wenn keine sauberen Historiedaten vorliegen (z.B. Non-US-Listing ohne SEC), Vertrauen "niedrig" und limitierungen sauber benennen.
- Keine Markdown-Codefences, kein Text außerhalb des JSON.`;
}

app.post('/api/forecast', async (req, res) => {
  const { ticker, info, fundamentals, yfExtra, expectations, industry, deep, news, filings, sec_status } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const filed = fundamentals?.fundamentals?.revenue?.fy?.[0]?.filed || '';
  const hasInd = !!industry;
  const hasDeep = !!deep;
  const hasExp = !!expectations;
  // Issue 17: secStatus in Cache-Key, damit eine "Schätz-Prognose" (partial/missing)
  // nicht mit einer späteren vollständigen Prognose verwechselt wird, sobald
  // die SEC-Daten doch noch da sind.
  const secKey = sec_status?.status || (filed ? 'complete' : 'unknown');
  const cacheKey = `forecast:${ticker}:${filed}:${hasInd}:${hasDeep}:${hasExp}:${secKey}`;
  try {
    const hit = cacheGet(cacheKey);
    if (hit) return res.json(hit);

    const prompt = buildForecastPrompt({ ticker, info, fundamentals, yfExtra, expectations, industry, deep, news, filings, sec_status });

    // Issue 14 + 15 + 16 (re-iteriert): Robustheit gegen DeepSeek-V4-Überlast.
    // Strategie (Issue 16-Update Build 19, weil 200s + 2 Fallbacks immer noch zu
    // Komplett-Fehlschlägen führten):
    //   1. DeepSeek-Primary auf 240s — gibt dem Provider auch unter Last die
    //      Chance, eine lange JSON-Antwort fertig zu streamen.
    //   2. Diversifizierter Provider-Fallback mit Eskalation auf 4 Stufen:
    //      gpt-4o-mini (schnell) → claude-haiku (anderer Anbieter, kein
    //      gemeinsamer aimlapi-Pool für DeepSeek+OpenAI-Hänger) → gpt-4o.
    //      Wenn aimlapi auf OpenAI-Endpoint hängt, ist Claude meist noch frei.
    //   3. Adaptiver Backoff zwischen Versuchen wächst (1.5s, 2.5s, 3.5s, 4.5s) —
    //      gibt Provider-Spitzen Zeit zum Ausklingen, ohne das Gesamtbudget zu
    //      sprengen (Gesamt ≈ 240+90+90+150 + Backoff ≈ 580s, knapp unter nginx 600s).
    //   4. Adaptiv: ein NICHT-transienter Fehler (4xx, Prompt-Bug, Auth) bricht
    //      die Schleife sofort ab — vermeidet Vergeudung bei Eingabefehlern.
    //   5. Wenn JSON aus einer Antwort extrahierbar ist, akzeptieren wir es —
    //      selbst wenn das Modell ein anderes als geplant war.
    const ATTEMPTS = [
      { model: undefined,                  timeoutMs: 240 * 1000, label: 'deepseek/deepseek-v4-flash (primary)', max_tokens: 4500 },
      { model: 'gpt-4o-mini',              timeoutMs:  90 * 1000, label: 'gpt-4o-mini (fast fallback)',          max_tokens: 4000 },
      { model: 'claude-haiku-4-5-20251001',timeoutMs:  90 * 1000, label: 'claude-haiku-4.5 (cross-provider)',    max_tokens: 4000 },
      { model: 'gpt-4o',                   timeoutMs: 150 * 1000, label: 'gpt-4o (heavy fallback)',              max_tokens: 4000 },
    ];
    let r = null;
    let json = null;
    let lastErr = null;
    let actualAttempts = 0;
    let usedFallback = false;
    for (let attempt = 0; attempt < ATTEMPTS.length; attempt++) {
      actualAttempts = attempt + 1;
      const cfg = ATTEMPTS[attempt];
      if (cfg.model) usedFallback = true;
      try {
        const body = {
          system: LLM_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: cfg.max_tokens || 4500,
        };
        if (cfg.model) body.model = cfg.model;
        console.log(`[forecast] Versuch ${actualAttempts}/${ATTEMPTS.length} → ${cfg.label} (Timeout ${cfg.timeoutMs / 1000}s)`);
        r = await fetchJSON(`${TOOLS}/llm/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: cfg.timeoutMs,
          body: JSON.stringify(body),
        });
        json = extractJSON(r.reply || '');
        if (json) break;
        // kein JSON extrahierbar — nächster Versuch (z.B. Modell halluzinierte Markdown)
        lastErr = new Error('LLM-Antwort enthielt kein verwertbares JSON');
      } catch (e) {
        lastErr = e;
        const transient = e?.timeout || e?.code === 'TIMEOUT' || (e?.status && e.status >= 500);
        console.warn(`[forecast] Versuch ${actualAttempts}/${ATTEMPTS.length} (${cfg.label}) fehlgeschlagen: ${e.message}${transient ? ' (transient — retry)' : ''}`);
        if (!transient) break;
      }
      // Backoff (2s, 3s) — aimlapi-Spitzen ausschwingen lassen, aber kurz
      // halten, da wir bereits den Provider gewechselt haben.
      if (attempt < ATTEMPTS.length - 1) await new Promise(rs => setTimeout(rs, 1500 + 1000 * attempt));
    }

    if (!r || !json) {
      // Komplett-Fehlschlag → klare Fehlermeldung statt 500/504, inkl. Hinweis
      // dass auch Fallback-Modelle betroffen waren (das deutet auf aimlapi-weite Last).
      const isTimeout = lastErr?.timeout || lastErr?.code === 'TIMEOUT' || /timeout/i.test(lastErr?.message || '');
      const userMsg = isTimeout
        ? `Die KI-Prognose hat ${actualAttempts}× nicht rechtzeitig geantwortet — DeepSeek V4 (240s), gpt-4o-mini, claude-haiku-4.5 und gpt-4o sind alle in Timeouts gelaufen. aimlapi steht vermutlich gerade unter starker Last. Bitte in 2-5 Minuten erneut versuchen.`
        : `Prognose-LLM nicht erreichbar nach ${actualAttempts} Versuch${actualAttempts === 1 ? '' : 'en'}: ${lastErr?.message || 'unbekannter Fehler'}`;
      return res.status(502).json({
        error: userMsg,
        retry_recommended: true,
        attempts: actualAttempts,
        timeout: isTimeout,
        fallback_used: usedFallback,
        per_call_timeouts_s: ATTEMPTS.map(a => a.timeoutMs / 1000),
      });
    }

    const out = {
      ticker,
      model: r?.model,
      usage: r?.usage,
      forecast: json,
      fallback_used: usedFallback,
      attempts: actualAttempts,
      raw_excerpt: !json ? trim(r?.reply, 1800) : undefined,
    };
    if (json) cacheSet(cacheKey, out, 6 * 60 * 60 * 1000);
    res.json(out);
  } catch (e) {
    console.error('[forecast] Unerwarteter Fehler:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Web-Overview — Fallback, wenn yfinance/SEC keine Daten haben.
// Sucht das Web nach Basisdaten und (optional) lässt der LLM strukturiert
// Kennzahlen extrahieren.
// ---------------------------------------------------------------------------
app.get('/api/web-overview', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().trim();
  const name = (req.query.name || '').toString().trim();
  const extract = req.query.extract !== '0';
  if (!ticker && !name) return res.status(400).json({ error: 'ticker or name required' });
  const q = name ? `${name} (${ticker || ''}) stock price market cap revenue financials` : `${ticker} stock price market cap revenue`;
  const cacheKey = `weboverview:${ticker}:${name}:${extract}`;
  try {
    const out = await cached(cacheKey, 60 * 60 * 1000, async () => {
      const search = await fetchJSON(`${TOOLS}/web/search?q=${encodeURIComponent(q)}&max_results=8`);
      const results = search.results || [];

      let extracted = null;
      if (extract && results.length) {
        // Top 3 Snippets als Kontext an LLM
        const snippets = results.slice(0, 6).map((r, i) =>
          `(${i + 1}) ${r.title}\n${r.snippet || ''}\nURL: ${r.url}`
        ).join('\n\n');
        const prompt = `Aus den folgenden Websuchergebnissen für ${name || ticker}${ticker ? ` (${ticker})` : ''} extrahiere — falls erkennbar — Basisdaten als JSON.

${snippets}

Antworte nur mit JSON nach diesem Schema (Felder die du nicht sicher belegen kannst auf null):
{
  "longName": "vollständiger Firmenname oder null",
  "exchange": "Börse oder null",
  "currency": "ISO-Code oder null",
  "price": "letzter Kurs als Zahl oder null",
  "market_cap": "Marktkapitalisierung in USD/EUR als Zahl oder null (z.B. 250000000000)",
  "revenue_ttm": "letzter Umsatz TTM oder null",
  "net_income_ttm": "letzter Nettogewinn TTM oder null",
  "pe": "KGV oder null",
  "sector": "Sektor oder null",
  "industry": "Industrie oder null",
  "summary": "1-2 Sätze Charakterisierung",
  "confidence": "niedrig|mittel|hoch",
  "sources_used": [URLs die du tatsächlich verwendet hast]
}`;
        try {
          const r = await fetchJSON(`${TOOLS}/llm/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system: 'Du extrahierst strukturiert Daten aus Webtexten. Antworte ausschließlich mit gültigem JSON, kein Markdown.',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.1,
              max_tokens: 700,
            }),
          });
          extracted = extractJSON(r.reply || '');
        } catch (e) {
          // LLM-Fehler ist kein Hard-Fail; Suchergebnisse genügen schon
        }
      }

      return { ticker, name, query: q, results, extracted };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Peers — quotes für eine Liste von Tickern (parallel)
// ---------------------------------------------------------------------------
app.post('/api/peers', async (req, res) => {
  const list = Array.isArray(req.body?.tickers) ? req.body.tickers.slice(0, 10) : [];
  if (!list.length) return res.json({ peers: [] });
  try {
    const peers = await Promise.all(list.map(async t => {
      const tk = String(t).toUpperCase().trim();
      try {
        const q = await cached(`quote:${tk}:1mo:1d`, 30 * 60 * 1000, () =>
          fetchJSON(`${TOOLS}/stocks?ticker=${encodeURIComponent(tk)}&range=1mo&interval=1d`)
        );
        return { ticker: tk, info: q.info, ok: true };
      } catch (e) {
        return { ticker: tk, error: e.message, ok: false };
      }
    }));
    res.json({ peers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Filing-Text-Extraktion (auf Anfrage)
// ---------------------------------------------------------------------------
app.get('/api/extract', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const data = await cached(`extract:${url}`, 24 * 60 * 60 * 1000, () =>
      fetchJSON(`${TOOLS}/web/extract?url=${encodeURIComponent(url)}`)
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 6-Monats-News + KI-Sentiment/Themen (Issue 3)
// Aggregiert mehrere DDG-Queries, dedupliziert per URL, lässt LLM die News
// zusammenfassen, Sentiment einschätzen und Top-Themen extrahieren.
// ---------------------------------------------------------------------------
app.get('/api/news-6m', async (req, res) => {
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
  const name = (req.query.name || '').toString().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const cacheKey = `news6m:${ticker}:${name}`;
  try {
    const out = await cached(cacheKey, 2 * 60 * 60 * 1000, async () => {
      const label = name ? `${name} (${ticker})` : ticker;
      // Mehrere Queries → diverse Themen, kein einseitiger Fokus
      const queries = [
        `${label} news`,
        `${label} earnings revenue results`,
        `${label} announcement deal product launch`,
        `${label} guidance outlook forecast`,
      ];
      const settled = await Promise.allSettled(queries.map(q =>
        fetchJSON(`${TOOLS}/web/search?q=${encodeURIComponent(q)}&max_results=10&time=y`)
      ));
      const seen = new Set();
      const merged = [];
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        for (const item of (s.value.results || [])) {
          if (!item.url || seen.has(item.url)) continue;
          seen.add(item.url);
          merged.push(item);
        }
      }
      // Auf 25 cappen, damit der LLM-Prompt überschaubar bleibt
      const top = merged.slice(0, 25);
      const snippets = top.map((n, i) =>
        `[${i + 1}] ${n.title}\n  ${trim(n.snippet, 220)}\n  ${n.url}`
      ).join('\n');

      const prompt = `Du erhältst News-Schlagzeilen + Snippets der letzten ~6-12 Monate für ${label}.
Fokus auf die letzten 6 Monate (priorisiere aktuelle Ereignisse).

${snippets || '— Keine News gefunden —'}

Liefere AUSSCHLIESSLICH JSON nach diesem Schema:
{
  "summary": "4-7 Sätze: Was waren die wichtigsten Entwicklungen der letzten ~6 Monate? Was bewegte den Kurs/das Geschäft?",
  "sentiment": {
    "score": -100 bis +100 (Zahl, -100=sehr negativ, 0=neutral, +100=sehr positiv),
    "label": "sehr-negativ|negativ|neutral|positiv|sehr-positiv",
    "begruendung": "1-2 Sätze, warum dieses Sentiment"
  },
  "top_themen": [
    {"thema": "Kurzbezeichnung", "tendenz": "positiv|negativ|neutral", "details": "1-2 Sätze", "quellen": [Indices als Zahlen aus der obigen Liste]}
  ],
  "wichtige_ereignisse": [
    {"datum_kontext": "Q3 2025 / Mai 2025 / kürzlich", "ereignis": "...", "auswirkung": "positiv|negativ|neutral", "quelle_index": Zahl}
  ],
  "anzahl_verwertet": Zahl,
  "anzahl_letzte_6_monate": "best-effort Zahl"
}

Keine Markdown-Codefences. Erfinde keine Quellen — verweise nur per Index auf die obige Liste.`;

      let aiJson = null;
      let aiRaw = null;
      if (top.length) {
        try {
          const r = await fetchJSON(`${TOOLS}/llm/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system: 'Du bist News-Analyst. Antworte ausschließlich mit JSON.',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.2,
              max_tokens: 2200,
            }),
          });
          aiJson = extractJSON(r.reply || '');
          aiRaw = r;
        } catch (e) {
          // LLM-Fehler ist nicht tödlich — Listen-Ansicht funktioniert auch ohne
        }
      }
      return {
        ticker, name,
        queries,
        results: top,
        results_total: merged.length,
        ai: aiJson,
        model: aiRaw?.model,
        usage: aiRaw?.usage,
        raw_excerpt: !aiJson && aiRaw ? trim(aiRaw.reply, 1200) : undefined,
      };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Branchenanalyse (Issue 3)
// Ermittelt Branche (aus Yahoo info → sector/industry, ggf. LLM-Fallback),
// sucht aktuelle Trends & Prognosen im Web, lässt LLM eine
// Branchen-Zukunfts-Einschätzung formulieren.
// ---------------------------------------------------------------------------
app.post('/api/industry', async (req, res) => {
  const ticker = (req.body?.ticker || '').toString().toUpperCase().trim();
  const name = (req.body?.name || '').toString().trim();
  const sector = (req.body?.sector || '').toString().trim();
  const industry = (req.body?.industry || '').toString().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const cacheKey = `industry:${ticker}:${sector}:${industry}`;
  try {
    const out = await cached(cacheKey, 12 * 60 * 60 * 1000, async () => {
      // 1. Branche bestimmen — wenn aus Yahoo nicht da, LLM-Fallback
      let detectedSector = sector;
      let detectedIndustry = industry;
      let detectionMethod = (sector || industry) ? 'yahoo' : null;

      if (!detectedIndustry && !detectedSector) {
        // LLM kennt die meisten bekannten Firmen → reicht meist
        try {
          const r = await fetchJSON(`${TOOLS}/llm/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system: 'Du klassifizierst Aktien in Sektor/Industrie. Antworte ausschließlich mit JSON.',
              messages: [{
                role: 'user',
                content: `Welcher Sektor und welche Industrie passt am besten zur Firma "${name || ticker}" (Ticker ${ticker})?
Antworte als JSON: {"sektor": "z.B. Technology / Healthcare / Financial Services / ...", "industrie": "spezifischer (z.B. Software-Application / Biotech / Semiconductors)", "confidence": "niedrig|mittel|hoch"}`,
              }],
              temperature: 0.2,
              max_tokens: 200,
            }),
          });
          const j = extractJSON(r.reply || '');
          if (j) {
            detectedSector = j.sektor || detectedSector;
            detectedIndustry = j.industrie || detectedIndustry;
            detectionMethod = 'llm';
          }
        } catch (e) { /* nicht tödlich */ }
      }

      const industryLabel = detectedIndustry || detectedSector || 'allgemeiner Markt';

      // 2. Web-Suche zu Trends/Prognosen
      const queries = [
        `${industryLabel} industry trends 2026 outlook forecast`,
        `${industryLabel} market growth disruption regulation`,
      ];
      const settled = await Promise.allSettled(queries.map(q =>
        fetchJSON(`${TOOLS}/web/search?q=${encodeURIComponent(q)}&max_results=8&time=y`)
      ));
      const seen = new Set();
      const merged = [];
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        for (const item of (s.value.results || [])) {
          if (!item.url || seen.has(item.url)) continue;
          seen.add(item.url);
          merged.push(item);
        }
      }
      const top = merged.slice(0, 12);
      const snippets = top.map((n, i) =>
        `[${i + 1}] ${n.title}\n  ${trim(n.snippet, 220)}\n  ${n.url}`
      ).join('\n');

      const prompt = `Du bist Branchen-Analyst. Bewerte die Zukunftsaussichten der Branche/Industrie "${industryLabel}".
Kontext: ${name || ticker} (${ticker}) ist in dieser Branche tätig.

## Aktuelle Web-Funde (Snippets)
${snippets || '— Keine Web-Funde —'}

Liefere AUSSCHLIESSLICH JSON nach diesem Schema:
{
  "branche_label": "${industryLabel}",
  "gesamteinschaetzung": {
    "ausblick": "stark-positiv|positiv|neutral|negativ|stark-negativ",
    "wachstumsphase": "stark-wachsend|wachsend|reif|schrumpfend|im-umbruch",
    "zusammenfassung": "4-6 Sätze: Was steht der Branche bevor in den nächsten 1-3 Jahren?"
  },
  "treiber": [
    {"thema": "...", "richtung": "positiv|negativ|neutral", "details": "1-2 Sätze", "quelle_index": Zahl-aus-Liste-oben-oder-null}
  ],
  "risiken": [
    {"risiko": "...", "auswirkung": "niedrig|mittel|hoch", "details": "1-2 Sätze", "quelle_index": Zahl-oder-null}
  ],
  "regulatorisch": {"bewertung": "rueckenwind|gegenwind|neutral", "details": "..."},
  "wettbewerb_intensitaet": "niedrig|mittel|hoch|sehr-hoch",
  "disruption_potenzial": "niedrig|mittel|hoch|sehr-hoch",
  "fazit_fuer_firma": "Wie steht ${name || ticker} in dieser Branche da? Profiteur oder Risiko-Träger? (2-3 Sätze)",
  "confidence": "niedrig|mittel|hoch"
}

Keine Markdown-Codefences. Verweise nur per Index auf die obige Liste.`;

      let aiJson = null, aiRaw = null;
      try {
        const r = await fetchJSON(`${TOOLS}/llm/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system: 'Du bist Branchen-/Industrie-Analyst. Antworte ausschließlich mit JSON.',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 2000,
          }),
        });
        aiJson = extractJSON(r.reply || '');
        aiRaw = r;
      } catch (e) { /* nicht tödlich */ }

      return {
        ticker, name,
        sector: detectedSector || null,
        industry: detectedIndustry || null,
        detection_method: detectionMethod,
        sources: top,
        ai: aiJson,
        model: aiRaw?.model,
        usage: aiRaw?.usage,
        raw_excerpt: !aiJson && aiRaw ? trim(aiRaw.reply, 1200) : undefined,
      };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Ausführliches Fazit (Issue 3)
// Konsolidiert alle bisherigen Daten (Fundamentals, Scorecard, Analyse,
// Tiefenanalyse, News 6m, Branche) zu einer detaillierten Schlussbewertung
// mit Stärken/Schwächen, Chancen/Risiken, Handlungsempfehlung und Quellen.
// ---------------------------------------------------------------------------
function compactSourceList(items, max = 6) {
  return (items || []).slice(0, max).map((r, i) =>
    `[${i + 1}] ${r.title || r.url}\n     ${r.url || ''}`
  ).join('\n');
}

function buildConclusionPrompt(state) {
  const { ticker, info = {}, fundamentals = {}, score = {}, analysis = null, deep = null, news6m = null, industry = null, filings = [] } = state;
  const d = fundamentals.derived || {};
  const sc = score.scores || {};
  const fundLines = compactFinancials(fundamentals);
  const newsSummary = news6m?.ai?.summary || '— Keine 6-Monats-News-Zusammenfassung —';
  const sent = news6m?.ai?.sentiment;
  const indSummary = industry?.ai?.gesamteinschaetzung?.zusammenfassung || '— Keine Branchenanalyse —';
  const indFazit = industry?.ai?.fazit_fuer_firma || '';
  const verdict = score.verdict || '—';

  return `Erzeuge ein AUSFÜHRLICHES Investment-Fazit für ${info.longName || info.shortName || ticker} (${ticker}).

## Basisdaten
- Sektor: ${info.sector || industry?.sector || '—'} · Industrie: ${info.industry || industry?.industry || '—'}
- Marktkap.: ${info.market_cap ? '$' + (info.market_cap / 1e9).toFixed(2) + 'B' : '—'} · Letzter Kurs: ${info.price ?? '—'} ${info.currency || ''}

## Fundamentaldaten
${fundLines}

## Scorecard (regelbasiert)
- Gesamt: ${sc.total ?? '—'}/100 · Verdict: ${verdict}
- Qualität ${sc.quality ?? '—'} · Wachstum ${sc.growth ?? '—'} · Bewertung ${sc.valuation ?? '—'} · Burggraben ${sc.moat ?? '—'} · Sentiment ${sc.sentiment ?? '—'} · Risiko ${sc.risk ?? '—'}

## KI-Analyse (Steckbrief)
${analysis ? `- Steckbrief: ${analysis.steckbrief?.kurzbeschreibung || '—'}
- Pro: ${(analysis.investment_these?.pro || []).join(' | ') || '—'}
- Contra: ${(analysis.investment_these?.contra || []).join(' | ') || '—'}
- Burggraben-Score: ${analysis.burggraben?.score ?? '—'}/100
- Wachstumstreiber: ${(analysis.wachstumstreiber || []).join(', ') || '—'}` : '— Keine KI-Analyse —'}

## KI-Tiefenanalyse
${deep?.deep ? `- Geschäftsmodell-Typ: ${deep.deep.geschaeftsmodell?.typ || '—'}
- Wettbewerbsumfeld: ${deep.deep.konkurrenz?.marktstruktur || '—'} · Preissetzungsmacht: ${deep.deep.konkurrenz?.preissetzungsmacht?.bewertung || '—'}
- Disruptionsrisiko: ${deep.deep.zukunftsfaehigkeit?.disruptionsrisiko?.niveau || '—'} · TAM: ${deep.deep.zukunftsfaehigkeit?.tam_wachstum?.einschaetzung || '—'}
- Moat-Detail-Score: ${deep.deep.burggraben_detail?.gesamtscore ?? '—'}/100` : '— Keine Tiefenanalyse —'}

## 6-Monats-News (Zusammenfassung)
${newsSummary}
${sent ? `Sentiment: ${sent.label} (${sent.score}). ${sent.begruendung || ''}` : ''}

## Branchen-Ausblick
${indSummary}
${indFazit ? `Firma in Branche: ${indFazit}` : ''}

## Aktuelle Filings
${compactFilings(filings) || '— Keine —'}

## Auftrag
Liefere AUSSCHLIESSLICH JSON nach folgendem Schema. Jede zentrale Aussage MUSS mit einer
Quellen-Kategorie versehen werden:
- "SEC" für SEC-Filing / XBRL
- "Fundamentaldaten" für Scorecard/Margen/Wachstum
- "News" für 6-Monats-News
- "Branche" für Branchen-Ausblick
- "KI-Analyse" / "KI-Tiefenanalyse" für die LLM-Vorpassen
- "Schätzung" wenn ohne harten Beleg

{
  "kernaussage": "1-2 Sätze, der zentrale Befund — kein Kaufen/Verkaufen, nur Charakter",
  "staerken": [
    {"punkt": "...", "details": "1-2 Sätze", "quelle": "SEC|Fundamentaldaten|News|Branche|KI-Analyse|KI-Tiefenanalyse|Schätzung"}
  ],
  "schwaechen": [
    {"punkt": "...", "details": "1-2 Sätze", "quelle": "..."}
  ],
  "chancen": [
    {"punkt": "...", "details": "1-2 Sätze", "quelle": "..."}
  ],
  "risiken": [
    {"punkt": "...", "details": "1-2 Sätze", "quelle": "..."}
  ],
  "gesamteinschaetzung": "5-8 Sätze Fließtext: Wie passt das alles zusammen? Bewertung vs. Qualität vs. Wachstum vs. Branche vs. Stimmung. Keine Kursziele.",
  "handlungsempfehlung": {
    "typ": "weiter-beobachten|tiefer-prüfen|warten-auf-katalysator|nicht-interessant",
    "begruendung": "2-4 Sätze: was wäre der Trigger oder die nächste Frage, die User klären sollte?",
    "beobachtungspunkte": ["Konkreter Beobachtungspunkt 1", "...", "..."]
  },
  "datenqualitaet": {
    "sec_data": true|false,
    "news_data": true|false,
    "branche_data": true|false,
    "vertrauen": "niedrig|mittel|hoch",
    "luecken": ["..."]
  }
}

WICHTIG:
- Beziehe dich konkret auf die gelieferten Datenpunkte (nicht generisch).
- Trennscharf: Stärken = aktuell, Chancen = zukünftig. Schwächen = aktuell, Risiken = zukünftig.
- Quelle pro Aussage = OBLIGATORISCH, sonst Aussage weglassen.
- Keine Anlageberatung, kein "kaufen/verkaufen". Stattdessen Beobachtungspunkte.
- Kein Markdown-Codefence, NUR JSON.`;
}

app.post('/api/conclusion', async (req, res) => {
  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  // Cache-Key: Ticker + grobe Datenversion (Filing-Datum + ob KI-Daten dabei sind)
  const filed = req.body?.fundamentals?.fundamentals?.revenue?.fy?.[0]?.filed || '';
  const hasAnalysis = !!req.body?.analysis;
  const hasDeep = !!req.body?.deep;
  const cacheKey = `concl:${ticker}:${filed}:${hasAnalysis}:${hasDeep}`;
  try {
    const hit = cacheGet(cacheKey);
    if (hit) return res.json(hit);

    const prompt = buildConclusionPrompt(req.body);

    let r, json;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await fetchJSON(`${TOOLS}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: LLM_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 3500,
        }),
      });
      json = extractJSON(r.reply || '');
      if (json) break;
    }

    const out = {
      ticker,
      model: r?.model,
      usage: r?.usage,
      conclusion: json,
      raw_excerpt: !json ? trim(r?.reply, 1500) : undefined,
    };
    if (json) cacheSet(cacheKey, out, 6 * 60 * 60 * 1000);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PDF-Report (Issue 3)
// Generiert einen mehrseitigen Report aus dem im Frontend gesammelten State.
// Nimmt alle Daten als JSON-Body entgegen, damit kein erneuter Fetch nötig ist.
// ---------------------------------------------------------------------------
function pdfStr(v, fallback = '—') {
  if (v === null || v === undefined || v === '') return fallback;
  // Floats mit > 2 Nachkommastellen rendert PDFKit ungekürzt — Kurse wie
  // 215.2799987792968 sprengen die Spalte und überlappen die nächste Zeile.
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (Number.isInteger(v)) return String(v);
    const abs = Math.abs(v);
    const dec = abs >= 1000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
    return v.toFixed(dec);
  }
  if (typeof v === 'string') {
    // String-Repräsentationen langer Floats ebenfalls trimmen
    if (/^-?\d+\.\d{4,}$/.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) return pdfStr(n, fallback);
    }
  }
  return String(v);
}
function pdfPct(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  return (Number(v) * 100).toFixed(1) + '%';
}
// Bricht URLs (oder beliebige Tokens ohne Whitespace) so um, dass pdfkit
// garantiert eine Umbruchstelle findet — wir können uns nicht darauf
// verlassen, dass pdfkits Linebreaker an Zero-Width-Spaces bricht. Misst die
// tatsächliche Textbreite mit doc.font/widthOfString und teilt die URL bei
// Bedarf an char-level in Stücke, getrennt durch echte Spaces.
function pdfBreakUrl(url, maxWidth, doc) {
  if (!url) return '—';
  const s = String(url);
  doc.save();
  try {
    doc.font('Sans').fontSize(8);
    if (doc.widthOfString(s) <= maxWidth) return s;

    // Schätzung: durchschnittliche Glyph-Breite × Zeichenanzahl pro Zeile
    const avg = doc.widthOfString(s) / s.length;
    const charsPerLine = Math.max(20, Math.floor((maxWidth - 4) / Math.max(avg, 1)));
    // An URL-Trennzeichen splitten, dann zu Zeilen ≤ charsPerLine packen
    const tokens = s.split(/(?<=[\/?&=._\-])/);
    const lines = [];
    let cur = '';
    for (const tok of tokens) {
      if ((cur + tok).length <= charsPerLine) {
        cur += tok;
      } else {
        if (cur) lines.push(cur);
        if (tok.length > charsPerLine) {
          // Token selbst zu lang → hart zerschneiden
          for (let i = 0; i < tok.length; i += charsPerLine) {
            lines.push(tok.slice(i, i + charsPerLine));
          }
          cur = '';
        } else {
          cur = tok;
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.join('\n');
  } finally { doc.restore(); }
}

function pdfMoney(v, curr = 'USD') {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  const abs = Math.abs(v);
  let scaled, suf;
  if (abs >= 1e12) { scaled = v / 1e12; suf = 'T'; }
  else if (abs >= 1e9) { scaled = v / 1e9; suf = 'Mrd'; }
  else if (abs >= 1e6) { scaled = v / 1e6; suf = 'Mio'; }
  else if (abs >= 1e3) { scaled = v / 1e3; suf = 'K'; }
  else { scaled = v; suf = ''; }
  const sym = curr === 'USD' ? '$' : (curr === 'EUR' ? '€' : (curr || '') + ' ');
  return sym + scaled.toFixed(2) + (suf ? ' ' + suf : '');
}

// Unicode-fähige TTF-Fonts (DejaVu Sans deckt Umlaute, Bullets, Pfeile, € usw.
// vollständig ab — pdfkits Standard-Helvetica nutzt WinAnsi und mangelt z.B.
// '▸ Stärke' zu '%Ï Stärke').
const PDF_FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PDF_FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// 5-Jahres-Chart als nativer PDF-Vektor — gleiche Datenbasis wie die Chart.js-
// Anzeige im Web-UI, aber serverseitig gerendert (kein Canvas-Roundtrip nötig).
function drawPriceChart(doc, history, currency, LEFT, W, C, ensureRoom, heading) {
  if (!Array.isArray(history) || history.length < 2) {
    heading('Kursverlauf (5 Jahre)');
    doc.fillColor(C.muted).font('Sans').fontSize(9.5).text(
      'Keine historischen Kursdaten verfügbar.', LEFT, doc.y, { width: W });
    doc.moveDown(0.4);
    return;
  }
  const closes = history.map(h => +h.close).filter(Number.isFinite);
  if (closes.length < 2) {
    heading('Kursverlauf (5 Jahre)');
    doc.fillColor(C.muted).font('Sans').fontSize(9.5).text(
      'Kursreihe enthält keine verwertbaren Schlusskurse.', LEFT, doc.y, { width: W });
    doc.moveDown(0.4);
    return;
  }

  // Range-Label analog zur Web-UI ableiten
  const first = closes[0];
  const last = closes[closes.length - 1];
  const firstDate = new Date(history[0].date);
  const lastDate = new Date(history[history.length - 1].date);
  const yearsSpan = (lastDate - firstDate) / (365.25 * 86400000);
  let rangeLabel;
  if (yearsSpan >= 4.5) rangeLabel = '5 Jahre';
  else if (yearsSpan >= 1.2) rangeLabel = `${yearsSpan.toFixed(1)} Jahre (max verfügbar)`;
  else rangeLabel = `${Math.round((lastDate - firstDate) / (30.4 * 86400000))} Monate (max verfügbar)`;

  heading(`Kursverlauf · ${rangeLabel}`);

  // Höhe: kompakt für PDF (~2.4:1 statt 3:2, sonst sprengt es Seite 1)
  const chartH = 180;
  ensureRoom(chartH + 30);

  const x0 = LEFT;
  const y0 = doc.y;
  const padTop = 8, padBot = 18, padLeft = 42, padRight = 8;
  const plotX = x0 + padLeft;
  const plotY = y0 + padTop;
  const plotW = W - padLeft - padRight;
  const plotH = chartH - padTop - padBot;

  let min = Infinity, max = -Infinity;
  for (const v of closes) { if (v < min) min = v; if (v > max) max = v; }
  const range = (max - min) || Math.abs(max) || 1;
  // Etwas Headroom oben/unten, damit Linie nicht am Rand klebt
  const pad = range * 0.05;
  const yMin = min - pad;
  const yMax = max + pad;
  const yRange = yMax - yMin;

  // Hintergrund
  doc.save();
  doc.rect(x0, y0, W, chartH).fillAndStroke('#f8fafc', C.line);
  doc.restore();

  // Y-Gridlines + Achsenwerte
  for (let i = 0; i <= 4; i++) {
    const yy = plotY + (plotH * i) / 4;
    const val = yMax - (yRange * i) / 4;
    doc.save();
    doc.strokeColor(C.line).lineWidth(0.5).moveTo(plotX, yy).lineTo(plotX + plotW, yy).stroke();
    doc.restore();
    doc.fillColor(C.muted).font('Sans').fontSize(7).text(
      val >= 1000 ? val.toFixed(0) : val.toFixed(2),
      x0 + 2, yy - 4, { width: padLeft - 6, align: 'right', lineBreak: false }
    );
  }

  const up = last >= first;
  const lineColor = up ? '#047857' : '#b91c1c';
  const fillColor = up ? '#dcfce7' : '#fee2e2';

  const pointX = i => plotX + (plotW * i) / (closes.length - 1);
  const pointY = i => plotY + plotH - ((closes[i] - yMin) / yRange) * plotH;

  // Flächen-Fill unter der Linie
  doc.save();
  doc.moveTo(plotX, plotY + plotH);
  for (let i = 0; i < closes.length; i++) doc.lineTo(pointX(i), pointY(i));
  doc.lineTo(plotX + plotW, plotY + plotH);
  doc.closePath();
  doc.fillOpacity(0.45).fillColor(fillColor).fill();
  doc.restore();

  // Linie
  doc.save();
  doc.moveTo(pointX(0), pointY(0));
  for (let i = 1; i < closes.length; i++) doc.lineTo(pointX(i), pointY(i));
  doc.strokeColor(lineColor).lineWidth(1.1).stroke();
  doc.restore();

  // X-Achse: 5 Datums-Ticks
  const nTicks = 5;
  for (let i = 0; i < nTicks; i++) {
    const idx = Math.round(((closes.length - 1) * i) / (nTicks - 1));
    const h = history[idx];
    if (!h) continue;
    const dateStr = String(h.date).slice(0, 10);
    const xx = plotX + (plotW * i) / (nTicks - 1);
    doc.fillColor(C.muted).font('Sans').fontSize(7).text(
      dateStr, xx - 28, plotY + plotH + 4, { width: 56, align: 'center', lineBreak: false }
    );
  }

  doc.y = y0 + chartH + 6;

  // Caption mit Performance-Zahl
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'JPY' ? '¥' : '$';
  const change = ((last - first) / first) * 100;
  const changeStr = (change >= 0 ? '+' : '') + change.toFixed(1) + '%';
  doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
    `${sym}${first.toFixed(2)}  →  ${sym}${last.toFixed(2)}  ·  ${changeStr}  ·  Schlusskurse, ${closes.length} Datenpunkte`,
    LEFT, doc.y, { width: W }
  );
  doc.moveDown(0.4);
}

function buildPDF(doc, state) {
  const {
    ticker, info = {}, fundamentals = {}, score = {}, analysis = null, deep = null,
    news6m = null, industry = null, conclusion = null, news = [], filings = [],
    fairValue = null, history = [], yfExtra = null,
    // Issue 12: zusätzliche Webinhalte für vollständige PDF-Spiegelung
    expectations = null, peers = null, peerMatrix = null,
    forecast = null, forecastMeta = null,
    // Issue 13: Technische Analyse + Fear & Greed
    technical = null, fearGreed = null,
  } = state;
  const d = fundamentals.derived || {};
  const f = fundamentals.fundamentals || {};
  const sc = score.scores || {};
  const verdict = score.verdict || '—';
  const ampel = score.ampel || 'gelb';
  const displayName = info.longName || info.shortName || state.displayName || ticker;
  const currency = info.currency || 'USD';
  const generated = new Date().toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' });

  // Fonts registrieren (Unicode!)
  doc.registerFont('Sans', PDF_FONT_REGULAR);
  doc.registerFont('Sans-Bold', PDF_FONT_BOLD);
  doc.font('Sans');

  // Palette (dark theme komplett vermeiden — PDF auf Weiß für Druck/Lesbarkeit)
  const C = {
    text: '#0f131a',
    muted: '#5a6378',
    accent: '#0d9488',     // teal-600 — robust gegen Druck
    info: '#1d4ed8',       // blue-700
    pos: '#047857',        // green-700
    neg: '#b91c1c',        // red-700
    warn: '#b45309',       // amber-700
    line: '#cbd5e1',       // slate-300
    bgSoft: '#f1f5f9',     // slate-100
    bgAmpel: ampel === 'gruen' ? '#dcfce7' : ampel === 'rot' ? '#fee2e2' : ampel === 'orange' ? '#ffedd5' : '#fef3c7',
    fgAmpel: ampel === 'gruen' ? '#15803d' : ampel === 'rot' ? '#b91c1c' : ampel === 'orange' ? '#c2410c' : '#a16207',
  };

  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const LEFT = doc.page.margins.left;
  const RIGHT = doc.page.width - doc.page.margins.right;
  const ensureRoom = (need) => {
    if (doc.y + need > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
  };

  const heading = (text, opts = {}) => {
    ensureRoom(50);
    doc.moveDown(opts.gap ?? 0.6);
    doc.x = LEFT;
    doc.fillColor(C.text).font('Sans-Bold').fontSize(14).text(text, LEFT, doc.y, { width: W });
    doc.moveTo(LEFT, doc.y + 2).lineTo(RIGHT, doc.y + 2).strokeColor(C.accent).lineWidth(1).stroke();
    doc.moveDown(0.4);
    doc.x = LEFT;
  };
  const subheading = (text) => {
    ensureRoom(28);
    doc.moveDown(0.3);
    doc.x = LEFT;
    doc.fillColor(C.muted).font('Sans-Bold').fontSize(9).text(text.toUpperCase(), LEFT, doc.y, { width: W, characterSpacing: 1 });
    doc.moveDown(0.1);
    doc.x = LEFT;
  };
  const para = (text, opts = {}) => {
    if (!text) return;
    ensureRoom(20);
    doc.x = LEFT;
    doc.fillColor(opts.color || C.text).font(opts.bold ? 'Sans-Bold' : 'Sans').fontSize(opts.size || 10)
      .text(String(text), LEFT, doc.y, { width: W, align: opts.align || 'left', lineGap: 1 });
    doc.moveDown(opts.after ?? 0.25);
  };
  // Schreibt mehrere Text-Blöcke nebeneinander und setzt doc.y am Ende auf den
  // jeweils größten y-Endpunkt aller Blöcke — sonst überschreiben sich die
  // Folgezeilen mit dem höheren von beiden (z.B. zweizeiliger Wert bei Label).
  const sideBySide = (segments) => {
    const y0 = doc.y;
    let maxY = y0;
    for (const s of segments) {
      doc.fillColor(s.color || C.text)
         .font(s.font || 'Sans')
         .fontSize(s.size ?? 10);
      doc.text(String(s.text ?? '—'), s.x, y0, {
        width: s.w,
        align: s.align || 'left',
        lineGap: s.lineGap ?? 1,
        lineBreak: s.lineBreak !== false,
      });
      if (doc.y > maxY) maxY = doc.y;
    }
    doc.y = maxY;
  };
  const kv = (label, value, opts = {}) => {
    ensureRoom(18);
    sideBySide([
      { x: LEFT, w: 160, color: C.muted, size: 9, text: label },
      { x: LEFT + 165, w: W - 165, color: opts.color || C.text,
        font: opts.bold ? 'Sans-Bold' : 'Sans', size: 10, text: value ?? '—' },
    ]);
    doc.moveDown(0.1);
  };
  const bulletList = (items, opts = {}) => {
    if (!items || !items.length) {
      para('—', { color: C.muted });
      return;
    }
    items.forEach(item => {
      ensureRoom(22);
      const y0 = doc.y;
      doc.fillColor(opts.bulletColor || C.accent).font('Sans-Bold').fontSize(10).text('▸', LEFT, y0, { width: 12, continued: false });
      doc.fillColor(C.text).font('Sans').fontSize(10)
        .text(String(item), LEFT + 16, y0, { width: W - 16, lineGap: 1 });
      doc.moveDown(0.15);
    });
  };

  // ----- Titelseite / Header -----
  doc.fillColor(C.accent).font('Sans-Bold').fontSize(10).text('ALPHA-SCOPE · INVESTMENT-RESEARCH-REPORT', { align: 'left' });
  doc.moveDown(0.3);
  doc.fillColor(C.text).font('Sans-Bold').fontSize(22).text(displayName);
  doc.fillColor(C.muted).font('Sans').fontSize(12).text(`${ticker}${info.exchange ? '  ·  ' + info.exchange : ''}${info.sector ? '  ·  ' + info.sector : ''}`);
  doc.moveDown(0.5);

  // Ampel-Block
  const ampelY = doc.y;
  const ampelText = `${verdict}  ·  Gesamtscore ${sc.total ?? '—'}/100`;
  doc.rect(LEFT, ampelY, W, 36).fill(C.bgAmpel).fillColor(C.fgAmpel);
  doc.font('Sans-Bold').fontSize(13).text(ampelText, LEFT + 14, ampelY + 11, { width: W - 28 });
  doc.fillColor(C.text);
  doc.y = ampelY + 44;

  // Quick-Facts Tabelle
  const quickFactsLeft = [
    ['Letzter Kurs', info.price !== undefined && info.price !== null ? `${pdfStr(info.price)} ${currency}` : '—'],
    ['Marktkap.', pdfMoney(info.market_cap, currency)],
    ['52W-Hoch / Tief', `${pdfStr(info.year_high)} / ${pdfStr(info.year_low)}`],
    ['Industrie', pdfStr(info.industry || industry?.industry)],
  ];
  const quickFactsRight = [
    ['Umsatz (TTM)', pdfMoney(f.revenue?.ttm, currency)],
    ['Nettogewinn (TTM)', pdfMoney(f.netIncome?.ttm, currency)],
    ['FCF (FY)', pdfMoney(d.fcf, currency)],
    ['Verschuldungsgrad (D/E)', d.debtToEquity != null ? d.debtToEquity.toFixed(2) : '—'],
  ];
  const colW = (W - 20) / 2;
  const factY = doc.y;
  // Pro Zeile dynamisch die größere Höhe von Label und Value nehmen, sonst
  // kollidiert "Industrie: Semiconductors" mit dem Wert direkt darunter, wenn
  // der Wert auf zwei Zeilen umbricht.
  const drawCol = (rows, x) => {
    let yy = factY;
    rows.forEach(([k, v]) => {
      const labelH = doc.font('Sans').fontSize(9).heightOfString(k, { width: colW / 2 });
      const valueH = doc.font('Sans-Bold').fontSize(10).heightOfString(String(v ?? '—'), { width: colW / 2 });
      doc.fillColor(C.muted).font('Sans').fontSize(9).text(k, x, yy, { width: colW / 2 });
      doc.fillColor(C.text).font('Sans-Bold').fontSize(10).text(String(v ?? '—'), x + colW / 2, yy, { width: colW / 2, align: 'right' });
      yy += Math.max(labelH, valueH) + 4;
    });
    return yy;
  };
  const y1 = drawCol(quickFactsLeft, LEFT);
  const y2 = drawCol(quickFactsRight, LEFT + colW + 20);
  doc.y = Math.max(y1, y2) + 6;

  // ----- Kursverlauf (5 Jahre) -----
  drawPriceChart(doc, history, currency, LEFT, W, C, ensureRoom, heading);

  // ----- Scorecard -----
  heading('Scorecard');
  const scKeys = [
    ['Qualität', sc.quality],
    ['Wachstum', sc.growth],
    ['Bewertung', sc.valuation],
    ['Burggraben', sc.moat],
    ['Sentiment', sc.sentiment],
    ['Risiko', sc.risk],
  ];
  const cellW = (W - 10) / 3;
  const startY = doc.y;
  scKeys.forEach((row, i) => {
    const col = i % 3;
    const r = Math.floor(i / 3);
    const x = LEFT + col * (cellW + 5);
    const y = startY + r * 46;
    doc.rect(x, y, cellW, 40).fillAndStroke(C.bgSoft, C.line);
    doc.fillColor(C.muted).font('Sans').fontSize(8).text(row[0].toUpperCase(), x + 8, y + 6, { characterSpacing: 0.5 });
    const val = row[1] ?? '—';
    const color = (typeof val === 'number') ? (val >= 70 ? C.pos : val >= 50 ? C.info : val >= 30 ? C.warn : C.neg) : C.muted;
    doc.fillColor(color).font('Sans-Bold').fontSize(18).text(String(val) + (typeof val === 'number' ? '/100' : ''), x + 8, y + 18);
  });
  doc.y = startY + 2 * 46 + 6;
  doc.fillColor(C.muted).font('Sans').fontSize(8).text(
    'Gewichtung: Qualität 25% · Wachstum 20% · Bewertung 20% · Burggraben 15% · Sentiment 10% · Risiko 10%'
  );

  // ----- Dual-Score (Issue 9): Business Quality vs Stock Attractiveness -----
  const bq = score?.business_quality_score;
  const sa = score?.stock_attractiveness_score;
  if (bq !== null && bq !== undefined && sa !== null && sa !== undefined) {
    doc.moveDown(0.4);
    subheading('Dual-Score: Business Quality vs Stock Attractiveness (Issue 9)');
    const yDual = doc.y;
    const cellW2 = (W - 10) / 2;
    const drawDualCell = (x, label, val, sub) => {
      const cellH = 56;
      doc.rect(x, yDual, cellW2, cellH).fillAndStroke(C.bgSoft, C.line);
      doc.fillColor(C.muted).font('Sans').fontSize(8).text(label.toUpperCase(), x + 8, yDual + 6, { characterSpacing: 0.5, width: cellW2 - 16 });
      const v = Number.isFinite(+val) ? val : null;
      const color = v === null ? C.muted : v >= 70 ? C.pos : v >= 50 ? C.info : v >= 30 ? C.warn : C.neg;
      doc.fillColor(color).font('Sans-Bold').fontSize(22).text(String(v ?? '—') + (v !== null ? '/100' : ''), x + 8, yDual + 18, { width: cellW2 - 16 });
      doc.fillColor(C.muted).font('Sans').fontSize(8).text(sub, x + 8, yDual + 44, { width: cellW2 - 16, lineBreak: false });
    };
    drawDualCell(LEFT, 'Business Quality', bq, 'Preis-unabh. Unternehmens-Qualität');
    drawDualCell(LEFT + cellW2 + 10, 'Stock Attractiveness' + (score.attractiveness_cap_applied ? ' (gecappt)' : ''), sa, 'Preis-abh. Aktien-Attraktivität');
    doc.y = yDual + 64;
    if (score.attractiveness_cap_reason) {
      doc.fillColor(C.warn).font('Sans').fontSize(8.5).text('⚠ ' + score.attractiveness_cap_reason, LEFT, doc.y, { width: W, lineGap: 1 });
      doc.moveDown(0.3);
    }
  }

  // ----- Score-Aufschlüsselung (Issue 9): Sub-Dimensionen pro Bereich -----
  if (score?.breakdown) {
    heading('Score-Aufschlüsselung (Sub-Dimensionen)');
    para('Pro Bereich: Sub-Dimensionen mit Wert, Schwellenwert, Sub-Score und Beitrag — macht transparent, wie jeder Score zustande kommt.', { color: C.muted, size: 9 });
    const sections = [
      ['quality', 'Qualität'],
      ['growth', 'Wachstum'],
      ['valuation', 'Bewertung'],
      ['moat', 'Burggraben (Proxy)'],
      ['sentiment', 'Sentiment & Momentum'],
      ['risk', 'Risiko'],
    ];
    const fmtVal = (v, format) => {
      if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
      if (format === 'pct') return (Number(v) * 100).toFixed(1) + '%';
      if (format === 'money') return pdfMoney(v, currency);
      return Number(v).toFixed(2);
    };
    for (const [k, label] of sections) {
      const bd = score.breakdown[k];
      if (!bd || !bd.subdimensions?.length) continue;
      ensureRoom(80);
      subheading(`${label} — Aggregat: ${bd.score ?? '—'}/100`);
      // Tabelle: Sub | Wert | Threshold | Score | Beitrag
      const colW = [W * 0.34, W * 0.16, W * 0.18, W * 0.12, W * 0.20];
      const xs = [LEFT, LEFT + colW[0], LEFT + colW[0] + colW[1], LEFT + colW[0] + colW[1] + colW[2], LEFT + colW[0] + colW[1] + colW[2] + colW[3]];
      // Header
      const yHead = doc.y;
      doc.fillColor(C.muted).font('Sans').fontSize(8);
      doc.text('Sub-Dimension', xs[0], yHead, { width: colW[0], lineBreak: false });
      doc.text('Wert', xs[1], yHead, { width: colW[1], align: 'right', lineBreak: false });
      doc.text('Schwelle', xs[2], yHead, { width: colW[2], lineBreak: false });
      doc.text('Score', xs[3], yHead, { width: colW[3], align: 'right', lineBreak: false });
      doc.text('Quelle', xs[4], yHead, { width: colW[4], lineBreak: false });
      doc.y = yHead + 12;
      doc.moveTo(LEFT, doc.y - 2).lineTo(RIGHT, doc.y - 2).strokeColor(C.line).lineWidth(0.5).stroke();
      for (const s of bd.subdimensions) {
        ensureRoom(20);
        const yRow = doc.y + 2;
        const lh = doc.font('Sans').fontSize(9).heightOfString(s.label, { width: colW[0] - 4 });
        doc.fillColor(C.text).font('Sans').fontSize(9).text(s.label, xs[0], yRow, { width: colW[0] - 4, lineGap: 0 });
        doc.fillColor(C.text).font('Sans').fontSize(9).text(fmtVal(s.value, s.threshold?.format), xs[1], yRow, { width: colW[1], align: 'right', lineBreak: false });
        const dir = s.threshold && s.threshold.lo > s.threshold.hi ? '↓' : '↑';
        doc.fillColor(C.muted).font('Sans').fontSize(8).text(
          `${fmtVal(s.threshold?.lo, s.threshold?.format)} ${dir} ${fmtVal(s.threshold?.hi, s.threshold?.format)}`,
          xs[2], yRow, { width: colW[2], lineBreak: false }
        );
        const scV = s.score === null ? '—' : `${s.score} (${s.contribution || 0})`;
        const scColor = s.score === null ? C.muted : s.score >= 70 ? C.pos : s.score >= 50 ? C.info : s.score >= 30 ? C.warn : C.neg;
        doc.fillColor(scColor).font('Sans-Bold').fontSize(9).text(scV, xs[3], yRow, { width: colW[3], align: 'right', lineBreak: false });
        doc.fillColor(C.muted).font('Sans').fontSize(8).text(s.source || '—', xs[4], yRow, { width: colW[4], lineBreak: false });
        doc.y = yRow + Math.max(lh, 10) + 2;
      }
      doc.moveDown(0.2);
    }
  }

  // ----- Entscheidungsmatrix (Issue 9) -----
  if (score?.decision_matrix) {
    const dm = score.decision_matrix;
    ensureRoom(160);
    heading('Entscheidungsmatrix (Issue 9)');
    para(dm.gesamtfazit || '—', { bold: true });
    para(`✓ ${dm.ja_count}× Ja  ·  ✗ ${dm.nein_count}× Nein  ·  ? ${dm.unklar_count}× Unklar`, { color: C.muted, size: 9 });
    doc.moveDown(0.2);
    (dm.fragen || []).forEach((q, i) => {
      ensureRoom(48);
      const a = String(q.antwort || 'unklar').toLowerCase();
      const acolor = a === 'ja' ? C.pos : a === 'nein' ? C.neg : C.warn;
      const aLbl = a === 'ja' ? 'JA' : a === 'nein' ? 'NEIN' : 'UNKLAR';
      // Q-Nummer + Frage + Antwort-Label nebeneinander — sideBySide trackt
      // den höchsten Endpunkt, sodass mehrzeilige Fragen das Label nicht
      // überschreiben (vorher: doc.y - 13 → Überlappung bei Umbruch).
      sideBySide([
        { x: LEFT, w: 22, color: C.muted, size: 8, text: `Q${i + 1}` },
        { x: LEFT + 22, w: W - 22 - 90, color: C.text, font: 'Sans-Bold', size: 10, text: q.frage || '—' },
        { x: LEFT + W - 90, w: 90, color: acolor, font: 'Sans-Bold', size: 10,
          text: `${aLbl} (${q.score ?? '—'}/100)`, align: 'right' },
      ]);
      if (q.begruendung) {
        doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
          q.begruendung, LEFT + 22, doc.y, { width: W - 22, lineGap: 0 }
        );
      }
      doc.moveDown(0.3);
    });
  }

  // ----- Momentum / Alpha (Issue 9) -----
  if (score?.momentum) {
    const mom = score.momentum;
    ensureRoom(140);
    heading('Momentum & Alpha-Modul (Issue 9)');
    para('Kurssignale getrennt nach Zeitachse — 1M/3M/6M/12M plus Volatilität & Max Drawdown.', { color: C.muted, size: 9 });
    const fmtPctSigned = v => v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
    kv('Kursmomentum 1 Monat', fmtPctSigned(mom.ret1m));
    kv('Kursmomentum 3 Monate', fmtPctSigned(mom.ret3m));
    kv('Kursmomentum 6 Monate', fmtPctSigned(mom.ret6m));
    kv('Kursmomentum 12 Monate', fmtPctSigned(mom.ret12m));
    kv('Volatilität (ann.)', fmtPctSigned(mom.volatility));
    kv('Max Drawdown 12M', fmtPctSigned(mom.max_drawdown));
  }

  // ----- Technische Analyse (Issue 13) -----
  if (technical && !technical.error) {
    ensureRoom(220);
    heading('Technische Analyse (Issue 13)');
    para('RSI(14), MACD(12/26/9), Bollinger-Bänder(20, 2σ) und 12-/20-Monats-Momentum aus Tagesschlusskursen — Mean-Reversion und Trend-Signale neben den Fundamentaldaten.',
      { color: C.muted, size: 9 });
    const fmtPctSigned = v => v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
    // 20M / 12M Momentum
    if (technical.momentum_long) {
      subheading('Lang-Momentum');
      kv('12-Monats-Momentum', fmtPctSigned(technical.momentum_long.mom_12m));
      kv('20-Monats-Momentum', fmtPctSigned(technical.momentum_long.mom_20m));
    }
    // RSI
    subheading('RSI (14 Tage)');
    const rsiVal = technical.rsi;
    const rsiCol = rsiVal == null ? C.muted : rsiVal >= 70 ? C.neg : rsiVal <= 30 ? C.pos : C.info;
    kv('RSI(14)', rsiVal == null ? '—' : rsiVal.toFixed(1), { color: rsiCol, bold: true });
    if (technical.rsi_interpretation) {
      kv('Interpretation', technical.rsi_interpretation);
    }
    // MACD
    if (technical.macd) {
      subheading('MACD (12 / 26 / 9)');
      const m = technical.macd;
      kv('MACD-Linie', m.macd != null ? m.macd.toFixed(3) : '—');
      kv('Signal', m.signal != null ? m.signal.toFixed(3) : '—');
      const histCol = m.histogram == null ? C.muted : m.histogram > 0 ? C.pos : C.neg;
      kv('Histogramm', m.histogram != null ? (m.histogram > 0 ? '+' : '') + m.histogram.toFixed(3) : '—',
        { color: histCol, bold: true });
      kv('Trend', m.trend || '—', { color: m.trend === 'bullish' ? C.pos : C.neg });
      if (m.cross) {
        kv('Cross', m.cross === 'bullish' ? 'Bullish Cross (Signal-Übertritt nach oben)' : 'Bearish Cross (Signal-Übertritt nach unten)',
          { color: m.cross === 'bullish' ? C.pos : C.neg });
      }
    }
    // Bollinger
    if (technical.bollinger) {
      subheading('Bollinger-Bänder (20, 2σ)');
      const b = technical.bollinger;
      kv('Oberes Band', b.upper != null ? b.upper.toFixed(2) : '—');
      kv('Mittel (SMA-20)', b.middle != null ? b.middle.toFixed(2) : '—');
      kv('Unteres Band', b.lower != null ? b.lower.toFixed(2) : '—');
      kv('%B (Position im Band)', b.percent_b != null ? (b.percent_b * 100).toFixed(1) + '%' : '—');
      kv('Bandbreite', b.bandwidth != null ? (b.bandwidth * 100).toFixed(1) + '%' : '—');
      if (b.interpretation) para('Interpretation: ' + b.interpretation, { size: 9 });
    }
  }

  // ----- Fear & Greed Index (Issue 13) -----
  if (fearGreed && fearGreed.score != null) {
    ensureRoom(110);
    heading('Fear & Greed Index (Issue 13)');
    para('Markt-Sentiment-Indikator (0 = extreme Panik · 100 = extreme Gier). Fließt zusätzlich in den Sentiment-Score ein.',
      { color: C.muted, size: 9 });
    const score = Math.round(+fearGreed.score);
    const ratingLbl = String(fearGreed.rating || classifyFearGreed(score)).toUpperCase();
    const sCol = score >= 75 ? C.neg : score >= 55 ? C.warn : score >= 45 ? C.info : score >= 25 ? C.warn : C.pos;
    // Anzeige als Karte: großer Wert links, Rating rechts, Vergleichswerte darunter
    const yFG = doc.y;
    const cardH = 56;
    doc.rect(LEFT, yFG, W, cardH).fillAndStroke(C.bgSoft, C.line);
    doc.fillColor(sCol).font('Sans-Bold').fontSize(28).text(String(score), LEFT + 14, yFG + 14, { width: 90, lineBreak: false });
    doc.fillColor(C.muted).font('Sans').fontSize(8).text('/100', LEFT + 14 + 60, yFG + 24, { width: 30, lineBreak: false });
    doc.fillColor(sCol).font('Sans-Bold').fontSize(13).text(ratingLbl, LEFT + 120, yFG + 18, { width: W - 130, lineBreak: false });
    doc.fillColor(C.muted).font('Sans').fontSize(8).text(fearGreed.source || '—', LEFT + 120, yFG + 36, { width: W - 130, lineBreak: false });
    doc.y = yFG + cardH + 6;
    // Vergleichswerte
    if (fearGreed.previous_close != null || fearGreed.previous_week != null || fearGreed.previous_month != null || fearGreed.previous_year != null) {
      kv('Vortag', fearGreed.previous_close != null ? Math.round(+fearGreed.previous_close).toString() : '—');
      kv('Vorwoche', fearGreed.previous_week != null ? Math.round(+fearGreed.previous_week).toString() : '—');
      kv('Vor 1 Monat', fearGreed.previous_month != null ? Math.round(+fearGreed.previous_month).toString() : '—');
      kv('Vor 1 Jahr', fearGreed.previous_year != null ? Math.round(+fearGreed.previous_year).toString() : '—');
    }
    if (fearGreed.note) para(fearGreed.note, { size: 9, color: C.warn });
    if (fearGreed.timestamp) para('Stand: ' + fearGreed.timestamp, { size: 8.5, color: C.muted });
  }

  // ----- Markterwartungs-Modul (Issue 9 / Issue 12) -----
  // Spiegelt den Tab "Markterwartung" 1:1 ins PDF: Analyst-Konsens, Kursziel-
  // Spanne, implizite Erwartung (Forward-EPS), Guidance-Risiko-Heuristik,
  // Earnings-Surprise-Historie.
  if (expectations) {
    const ex = expectations;
    ensureRoom(200);
    heading('Markterwartung (Issue 9)');
    para('Analyst-Konsens, Earnings-Surprise-Historie und Guidance-Risiko — die Marktmeinung als eigenständige Datenebene neben den fundamentalen Scores.',
      { color: C.muted, size: 9 });

    // Analyst-Konsens
    subheading('Analyst-Konsens');
    const recKey = String(ex.recommendation_key || '').toLowerCase();
    const recLbl = ({
      'strong_buy': 'Strong Buy', 'buy': 'Buy', 'hold': 'Hold',
      'sell': 'Sell', 'strong_sell': 'Strong Sell',
    })[recKey] || (ex.recommendation_key || '—');
    kv('Empfehlung', `${recLbl}${ex.recommendation_mean != null ? `  (Mean ${Number(ex.recommendation_mean).toFixed(2)})` : ''}`);
    kv('Anzahl Analysten', ex.num_analyst_opinions != null ? String(ex.num_analyst_opinions) : '—');

    // Rec-Counts als horizontale Balken-Liste (rein textuell, damit PDF-stabil)
    const rc = ex.rec_counts || {};
    const totalRecs = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].reduce((s, k) => s + (rc[k] || 0), 0);
    if (totalRecs > 0) {
      const barRow = (label, n, color) => {
        ensureRoom(14);
        const yRow = doc.y;
        const labelW = 90;
        const valW = 30;
        const trackX = LEFT + labelW;
        const trackW = W - labelW - valW;
        doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(label, LEFT, yRow, { width: labelW, lineBreak: false });
        // Track
        doc.save();
        doc.rect(trackX, yRow + 2, trackW, 7).fill(C.bgSoft);
        const w = Math.max(1, (n / totalRecs) * trackW);
        doc.rect(trackX, yRow + 2, w, 7).fill(color);
        doc.restore();
        doc.fillColor(C.text).font('Sans').fontSize(8.5).text(String(n), trackX + trackW + 4, yRow, { width: valW, align: 'right', lineBreak: false });
        doc.y = yRow + 12;
      };
      barRow('Strong Buy', rc.strongBuy || 0, '#15803d');
      barRow('Buy', rc.buy || 0, '#34d399');
      barRow('Hold', rc.hold || 0, '#fbbf24');
      barRow('Sell', rc.sell || 0, '#fb923c');
      barRow('Strong Sell', rc.strongSell || 0, '#b91c1c');
      doc.moveDown(0.2);
    }

    // Kursziel-Spanne
    if (ex.target_mean != null || ex.target_median != null) {
      subheading('Kursziel-Spanne');
      const tgt = ex.target_mean ?? ex.target_median;
      const price = info.price;
      const upside = (tgt && price) ? ((tgt - price) / price) : null;
      kv('Mean / Median', `${pdfMoney(ex.target_mean, currency)} / ${pdfMoney(ex.target_median, currency)}`);
      kv('Spanne (Low – High)', `${pdfMoney(ex.target_low, currency)} – ${pdfMoney(ex.target_high, currency)}`);
      if (upside !== null) {
        const ucol = upside > 0 ? C.pos : upside < 0 ? C.neg : C.muted;
        kv('vs. aktueller Kurs', `${(upside > 0 ? '+' : '') + (upside * 100).toFixed(1)}%`, { color: ucol, bold: true });
      }
    }

    // Implizite Erwartung
    if (yfExtra && (yfExtra.forwardEps != null || yfExtra.forwardPE != null || yfExtra.trailingEps != null)) {
      subheading('Implizite Erwartung (Forward-EPS)');
      kv('EPS (TTM)', yfExtra.trailingEps != null ? Number(yfExtra.trailingEps).toFixed(2) : '—');
      kv('Forward-EPS', yfExtra.forwardEps != null ? Number(yfExtra.forwardEps).toFixed(2) : '—', { bold: true });
      if (yfExtra.forwardEps != null && yfExtra.trailingEps != null && Math.abs(yfExtra.trailingEps) > 0.0001) {
        const g = (yfExtra.forwardEps - yfExtra.trailingEps) / Math.abs(yfExtra.trailingEps);
        kv('Impl. EPS-Wachstum', (g > 0 ? '+' : '') + (g * 100).toFixed(1) + '%',
          { color: g > 0 ? C.pos : g < 0 ? C.neg : C.muted });
      }
      kv('Forward-KGV', yfExtra.forwardPE != null ? Number(yfExtra.forwardPE).toFixed(1) : '—');
      kv('PEG-Ratio', yfExtra.pegRatio != null ? Number(yfExtra.pegRatio).toFixed(2) : '—');
    }

    // Guidance-Risiko-Heuristik (gleich wie im Web-UI)
    const fwdPE = Number.isFinite(+yfExtra?.forwardPE) ? +yfExtra.forwardPE : null;
    let guidanceRisk = 'mittel', guidanceNote = '';
    if (fwdPE != null && fwdPE > 30) {
      guidanceRisk = 'hoch';
      guidanceNote = `Forward-KGV ${fwdPE.toFixed(1)} preist starkes Gewinnwachstum ein — Enttäuschung kann scharf abstrafen.`;
    } else if (fwdPE != null && fwdPE < 12) {
      guidanceRisk = 'niedrig';
      guidanceNote = `Forward-KGV ${fwdPE.toFixed(1)} preist wenig Wachstum ein — Guidance-Risiko begrenzt.`;
    } else if (fwdPE != null) {
      guidanceNote = `Forward-KGV ${fwdPE.toFixed(1)} preist moderate Erwartungen ein.`;
    } else {
      guidanceNote = 'Forward-KGV nicht verfügbar — Guidance-Einschätzung eingeschränkt.';
    }
    subheading('Guidance-Risiko');
    const grColor = guidanceRisk === 'hoch' ? C.neg : guidanceRisk === 'niedrig' ? C.pos : C.warn;
    kv('Einstufung', guidanceRisk.toUpperCase(), { color: grColor, bold: true });
    para(guidanceNote, { size: 9.5 });

    // Earnings-Surprise-Historie
    const eh = Array.isArray(ex.earnings_history) ? ex.earnings_history : [];
    if (eh.length) {
      subheading('Earnings-Surprise-Historie');
      // Tabellenkopf
      ensureRoom(30 + eh.length * 14);
      const colsEH = [W * 0.28, W * 0.24, W * 0.24, W * 0.24];
      const xsEH = [LEFT, LEFT + colsEH[0], LEFT + colsEH[0] + colsEH[1], LEFT + colsEH[0] + colsEH[1] + colsEH[2]];
      const yH = doc.y;
      doc.fillColor(C.muted).font('Sans').fontSize(8);
      doc.text('Datum', xsEH[0], yH, { width: colsEH[0], lineBreak: false });
      doc.text('EPS-Schätzung', xsEH[1], yH, { width: colsEH[1], align: 'right', lineBreak: false });
      doc.text('EPS-Reportiert', xsEH[2], yH, { width: colsEH[2], align: 'right', lineBreak: false });
      doc.text('Surprise', xsEH[3], yH, { width: colsEH[3], align: 'right', lineBreak: false });
      doc.y = yH + 11;
      doc.moveTo(LEFT, doc.y - 1).lineTo(RIGHT, doc.y - 1).strokeColor(C.line).lineWidth(0.5).stroke();
      let surprises = [];
      for (const e of eh) {
        ensureRoom(14);
        const yR = doc.y + 2;
        const sp = e.surprise_pct;
        const spStr = sp == null ? '—' : (sp > 0 ? '+' : '') + Number(sp).toFixed(1) + '%';
        const spCol = sp == null ? C.muted : sp > 0 ? C.pos : sp < 0 ? C.neg : C.muted;
        if (sp != null && Number.isFinite(+sp)) surprises.push(+sp);
        doc.fillColor(C.text).font('Sans').fontSize(9).text(String(e.date || '—'), xsEH[0], yR, { width: colsEH[0], lineBreak: false });
        doc.fillColor(C.text).font('Sans').fontSize(9).text(e.eps_estimate == null ? '—' : Number(e.eps_estimate).toFixed(2), xsEH[1], yR, { width: colsEH[1], align: 'right', lineBreak: false });
        doc.fillColor(C.text).font('Sans').fontSize(9).text(e.reported_eps == null ? '—' : Number(e.reported_eps).toFixed(2), xsEH[2], yR, { width: colsEH[2], align: 'right', lineBreak: false });
        doc.fillColor(spCol).font('Sans-Bold').fontSize(9).text(spStr, xsEH[3], yR, { width: colsEH[3], align: 'right', lineBreak: false });
        doc.y = yR + 11;
      }
      if (surprises.length) {
        const avg = surprises.reduce((a, b) => a + b, 0) / surprises.length;
        doc.moveDown(0.15);
        doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
          `Ø Earnings-Surprise: ${(avg > 0 ? '+' : '') + avg.toFixed(1)}%  ·  Konsistente Beats deuten auf konservatives Management, häufige Misses signalisieren Guidance-Probleme.`,
          LEFT, doc.y, { width: W, lineGap: 0 }
        );
      }
    }
  }

  // ----- KI-Prognose 3 Jahre + 12-Monats-Kursziel (Issue 11 / Issue 12) -----
  if (forecast) {
    const f12 = forecast;
    const md = f12.metadaten || {};
    const pj = Array.isArray(f12.prognose) ? f12.prognose : [];
    const kp = f12.kurs_prognose_12m || {};
    const mk = f12.markt_kontext || {};
    const bi = f12.bewertungs_implikation || {};
    const dq = f12.datenqualitaet || {};
    const ks = f12.kurs_konfidenz || kp.konfidenz_kurs || {};

    ensureRoom(220);
    heading('KI-Prognose · 3 Jahre & 12-Monats-Kursziel (Issue 11)');
    para('DeepSeek V4 projiziert Umsatz, Gewinn, CAPEX und EPS für drei Geschäftsjahre und leitet daraus ein Bull/Base/Bear-Kursziel auf 12 Monate ab. Inputs: SEC-Historie, Forward-EPS, Analysten-Konsens, Branchen-Ausblick, Wettbewerb.',
      { color: C.muted, size: 9 });
    if (md.modell_annahmen) {
      doc.fillColor(C.text).font('Sans').fontSize(10).text(md.modell_annahmen, LEFT, doc.y, { width: W, lineGap: 1 });
      doc.moveDown(0.3);
    }
    if (dq.vertrauen_overall) {
      kv('Vertrauen overall', String(dq.vertrauen_overall));
    }

    // 12-Monats-Kursziel: drei Szenarien als Karten
    if (kp.bull || kp.base || kp.bear) {
      subheading('12-Monats-Kursziel (Bull / Base / Bear)');
      ensureRoom(110);
      const yCard = doc.y;
      const cardW = (W - 16) / 3;
      const cardH = 92;
      const scens = [
        ['Bull Case', kp.bull, C.pos],
        ['Base Case', kp.base, C.info],
        ['Bear Case', kp.bear, C.neg],
      ];
      scens.forEach(([label, s, col], idx) => {
        const x = LEFT + idx * (cardW + 8);
        doc.rect(x, yCard, cardW, cardH).fillAndStroke(C.bgSoft, C.line);
        doc.fillColor(col).font('Sans-Bold').fontSize(9).text(label.toUpperCase(), x + 8, yCard + 6, { width: cardW - 16, characterSpacing: 0.5 });
        const k = s?.kurs;
        const ws = s?.wahrscheinlichkeit_pct;
        const price = info.price;
        const upside = (k != null && price && price !== 0) ? ((k - price) / price) : null;
        doc.fillColor(C.text).font('Sans-Bold').fontSize(16).text(
          k != null ? pdfMoney(k, currency) : '—', x + 8, yCard + 22, { width: cardW - 16 }
        );
        const upStr = upside != null ? ((upside > 0 ? '+' : '') + (upside * 100).toFixed(1) + '%') : '—';
        const upCol = upside != null && upside > 0 ? C.pos : upside != null && upside < 0 ? C.neg : C.muted;
        doc.fillColor(upCol).font('Sans-Bold').fontSize(10).text(upStr, x + 8, yCard + 44, { width: cardW - 16 });
        doc.fillColor(C.muted).font('Sans').fontSize(8).text(
          ws != null ? `P = ${Number(ws).toFixed(0)}%` : '', x + 8, yCard + 58, { width: cardW - 16 }
        );
        if (s?.implizites_kgv != null) {
          doc.fillColor(C.muted).font('Sans').fontSize(8).text(
            `impl. KGV: ${Number(s.implizites_kgv).toFixed(1)}`, x + 8, yCard + 70, { width: cardW - 16 }
          );
        }
      });
      doc.y = yCard + cardH + 6;

      if (ks.unten != null && ks.oben != null) {
        kv('Konfidenzintervall', `${pdfMoney(ks.unten, currency)} – ${pdfMoney(ks.oben, currency)}${ks.konfidenz_pct != null ? `  (${Number(ks.konfidenz_pct).toFixed(0)}%)` : ''}`);
      }
      if (ks.begruendung) {
        para('Konfidenz-Begründung: ' + ks.begruendung, { size: 9.5 });
      }
      if (kp.vergleich_analystenziel) {
        para('vs. Analysten-Ziel: ' + kp.vergleich_analystenziel, { size: 9.5 });
      }

      // Bull/Base/Bear Treiber + Kommentare
      ['bull', 'base', 'bear'].forEach((k) => {
        const s = kp[k];
        if (!s) return;
        const label = k === 'bull' ? 'Bull' : k === 'base' ? 'Base' : 'Bear';
        const col = k === 'bull' ? C.pos : k === 'base' ? C.info : C.neg;
        if ((s.treiber && s.treiber.length) || s.kommentar) {
          ensureRoom(40);
          doc.fillColor(col).font('Sans-Bold').fontSize(10).text(label + ' — Treiber & Kommentar', LEFT, doc.y, { width: W });
          if (s.treiber?.length) {
            doc.fillColor(C.muted).font('Sans').fontSize(9).text(
              'Treiber: ' + s.treiber.join(' · '), LEFT, doc.y, { width: W, lineGap: 1 }
            );
          }
          if (s.kommentar) {
            doc.fillColor(C.text).font('Sans').fontSize(9.5).text(s.kommentar, LEFT, doc.y, { width: W, lineGap: 1 });
          }
          doc.moveDown(0.25);
        }
      });
    }

    // 3-Jahres-Tabelle: Bull/Base/Bear je Jahr für jede Kennzahl
    if (pj.length) {
      subheading('3-Jahres-Prognose · Bull / Base / Bear pro Jahr');
      para(`Pro Zelle: ▲ Bull · Base (fett) · ▼ Bear. Beträge in Milliarden ${currency} (B), Margen in % vom Umsatz, EPS pro Aktie.`,
        { color: C.muted, size: 8.5 });
      ensureRoom(80);

      const labelCol = W * 0.28;
      const yearCol = (W - labelCol) / pj.length;
      const xLabel = LEFT;

      // Tabellenkopf: Jahre — `fy` kann bereits "FY2026" oder nur "2026" sein,
      // wir präfixen nur, wenn nicht schon vorhanden.
      const yHead = doc.y;
      doc.fillColor(C.muted).font('Sans').fontSize(8).text('Kennzahl', xLabel, yHead, { width: labelCol, lineBreak: false });
      const fyLabel = (fy) => {
        const s = String(fy ?? '+?');
        return /^fy/i.test(s) ? s : 'FY' + s;
      };
      pj.forEach((p, i) => {
        doc.fillColor(C.muted).font('Sans-Bold').fontSize(9).text(
          fyLabel(p.fy), xLabel + labelCol + i * yearCol, yHead, { width: yearCol, align: 'right', lineBreak: false }
        );
      });
      doc.y = yHead + 12;
      doc.moveTo(LEFT, doc.y - 1).lineTo(RIGHT, doc.y - 1).strokeColor(C.line).lineWidth(0.5).stroke();

      const fmtBnum = v => v == null || !Number.isFinite(+v) ? '—' : Number(v).toFixed(2) + 'B';
      const fmtPctNum = v => v == null || !Number.isFinite(+v) ? '—' : (Number(v) * 100).toFixed(1) + '%';
      const fmtEps = v => v == null || !Number.isFinite(+v) ? '—' : Number(v).toFixed(2);
      const rows = [
        ['Umsatz', 'umsatz_b', fmtBnum],
        ['Net Income', 'net_income_b', fmtBnum],
        ['CapEx', 'capex_b', fmtBnum],
        ['Free Cash Flow', 'fcf_b', fmtBnum],
        ['EPS', 'eps', fmtEps],
        ['Operating Margin', 'operating_margin', fmtPctNum],
        ['Net Margin', 'net_margin', fmtPctNum],
      ];
      rows.forEach(([label, key, fmtFn]) => {
        ensureRoom(50);
        const yRow = doc.y;
        doc.fillColor(C.text).font('Sans-Bold').fontSize(9.5).text(label, xLabel, yRow, { width: labelCol - 4, lineBreak: false });
        pj.forEach((p, i) => {
          const obj = p[key] || {};
          const x = xLabel + labelCol + i * yearCol;
          // Bull (klein/oben)
          doc.fillColor(C.pos).font('Sans').fontSize(8).text(
            '▲ ' + fmtFn(obj.bull), x, yRow, { width: yearCol - 2, align: 'right', lineBreak: false }
          );
          // Base (fett, größer)
          doc.fillColor(C.text).font('Sans-Bold').fontSize(10).text(
            fmtFn(obj.base), x, yRow + 11, { width: yearCol - 2, align: 'right', lineBreak: false }
          );
          // Bear
          doc.fillColor(C.neg).font('Sans').fontSize(8).text(
            '▼ ' + fmtFn(obj.bear), x, yRow + 25, { width: yearCol - 2, align: 'right', lineBreak: false }
          );
          // Konfidenzintervall
          const intv = obj.intervall || {};
          if (intv.unten != null && intv.oben != null) {
            doc.fillColor(C.muted).font('Sans').fontSize(7).text(
              `KI: ${fmtFn(intv.unten)}–${fmtFn(intv.oben)}`, x, yRow + 38, { width: yearCol - 2, align: 'right', lineBreak: false }
            );
          }
        });
        doc.y = yRow + 50;
      });
    }

    // Markt-Kontext: TAM, Marktanteilsentwicklung, Konkurrenzstärke
    if (mk && (mk.tam_wachstum_pa != null || mk.marktanteilsentwicklung || mk.konkurrenzstaerke)) {
      subheading('Markt-Kontext · TAM, Marktanteil & Konkurrenz');
      if (mk.tam_wachstum_pa != null) {
        kv('TAM-Wachstum p.a.', (Number(mk.tam_wachstum_pa) * 100).toFixed(1) + '%');
      }
      if (mk.tam_wachstum_begruendung) para(mk.tam_wachstum_begruendung, { size: 9.5 });

      const ma = mk.marktanteilsentwicklung || {};
      if (ma.richtung || ma.begruendung || ma.implizierter_anteil_in_3j_pct != null) {
        subheading('Marktanteilsentwicklung');
        if (ma.richtung) kv('Richtung', String(ma.richtung));
        if (ma.implizierter_anteil_in_3j_pct != null) kv('Anteil in 3J', Number(ma.implizierter_anteil_in_3j_pct).toFixed(1) + '%');
        if (ma.begruendung) para(ma.begruendung, { size: 9.5 });
      }

      const kk = mk.konkurrenzstaerke || {};
      if (kk.bewertung || kk.wettbewerbsintensitaet || kk.markteintrittsbarrieren || kk.substitutionsrisiko) {
        subheading('Konkurrenzstärke (Risiko)');
        if (kk.bewertung) kv('Bewertung', String(kk.bewertung));
        if (kk.wettbewerbsintensitaet) kv('Wettbewerbsintensität', String(kk.wettbewerbsintensitaet));
        if (kk.markteintrittsbarrieren) kv('Markteintrittsbarrieren', String(kk.markteintrittsbarrieren));
        if (kk.substitutionsrisiko) kv('Substitutionsrisiko', String(kk.substitutionsrisiko));
        if (kk.begruendung) para(kk.begruendung, { size: 9.5 });
      }
    }

    // Bewertungs-Implikation
    if (bi && (bi.fair_value_adjustment || bi.begruendung || bi.scorecard_impact)) {
      subheading('Implikation für Bewertung & Scorecard');
      if (bi.fair_value_adjustment) kv('Fair-Value-Adjustment', String(bi.fair_value_adjustment));
      if (bi.begruendung) para(bi.begruendung, { size: 9.5 });
      if (bi.scorecard_impact) para('Scorecard-Effekt: ' + bi.scorecard_impact, { size: 9.5, color: C.muted });
    }

    // Primärquellen & Limitierungen
    const q = f12.quellen || {};
    const primQ = Array.isArray(q['primär']) ? q['primär'] : (Array.isArray(q.primaer) ? q.primaer : []);
    const lim = Array.isArray(q.limitierungen) ? q.limitierungen : [];
    if (primQ.length || lim.length) {
      subheading('Datenbasis & Limitierungen');
      if (primQ.length) {
        para('Primäre Quellen:', { color: C.muted, bold: true });
        bulletList(primQ);
      }
      if (lim.length) {
        para('Limitierungen / Datenlücken:', { color: C.muted, bold: true });
        bulletList(lim, { bulletColor: C.warn });
      }
    }
    if (dq.begruendung) {
      para('Vertrauen: ' + (dq.vertrauen_overall || '—') + ' — ' + dq.begruendung, { size: 9, color: C.muted });
    }
    if (forecastMeta?.model) {
      doc.fillColor(C.muted).font('Sans').fontSize(8).text(
        `KI-Modell: ${forecastMeta.model}${forecastMeta.usage?.total_tokens ? '  ·  Tokens: ' + forecastMeta.usage.total_tokens : ''}  ·  KI-gestützte Prognose, keine Anlageberatung.`,
        LEFT, doc.y, { width: W, lineGap: 0 }
      );
      doc.moveDown(0.3);
    }
  }

  // ----- Ausführliches Fazit (Konklusion) -----
  if (conclusion) {
    heading('Ausführliches Fazit');
    if (conclusion.kernaussage) {
      doc.fillColor(C.text).font('Sans-Bold').fontSize(11).text(conclusion.kernaussage, { lineGap: 1 });
      doc.moveDown(0.4);
    }

    const pairs = [
      ['Stärken', conclusion.staerken, C.pos],
      ['Schwächen', conclusion.schwaechen, C.neg],
      ['Chancen', conclusion.chancen, C.info],
      ['Risiken', conclusion.risiken, C.warn],
    ];
    pairs.forEach(([title, list, color]) => {
      subheading(title);
      if (!Array.isArray(list) || !list.length) {
        para('—', { color: C.muted });
        return;
      }
      list.forEach(item => {
        ensureRoom(40);
        // Punkt + Quelle nebeneinander — max-y tracken, sonst überschreibt der
        // nächste Bullet die Detailzeile, wenn der Punkt zweizeilig ist.
        sideBySide([
          { x: LEFT, w: W - 90, color, font: 'Sans-Bold', size: 10, text: '●  ' + (item.punkt || '—') },
          ...(item.quelle ? [{ x: LEFT + W - 90, w: 90, color: C.muted, size: 8,
              text: `[${item.quelle}]`, align: 'right' }] : []),
        ]);
        if (item.details) {
          doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
            item.details, LEFT + 12, doc.y, { width: W - 12, lineGap: 1 }
          );
        }
        doc.moveDown(0.25);
      });
    });

    if (conclusion.gesamteinschaetzung) {
      subheading('Gesamteinschätzung');
      para(conclusion.gesamteinschaetzung);
    }
    if (conclusion.handlungsempfehlung) {
      const h = conclusion.handlungsempfehlung;
      subheading('Handlungsempfehlung');
      para(`Typ: ${h.typ || '—'}`, { bold: true });
      para(h.begruendung || '');
      if (h.beobachtungspunkte?.length) {
        para('Beobachtungspunkte:', { color: C.muted, bold: true });
        bulletList(h.beobachtungspunkte);
      }
    }
  }

  // ----- Fundamentaldaten -----
  // Kein erzwungener Seitenumbruch — nur wenn die Sektion nicht mehr passt.
  // Sonst entstehen riesige Leerräume (Issue: "uneinheitliche Abstände").
  ensureRoom(280);
  heading('Fundamentaldaten');
  subheading('Wachstum');
  kv('Umsatzwachstum 1J', pdfPct(d.revenueGrowth1y));
  kv('Umsatzwachstum 3J', pdfPct(d.revenueGrowth3y));
  kv('Umsatzwachstum 5J', pdfPct(d.revenueGrowth5y));
  kv('EPS-Wachstum 1J', pdfPct(d.epsGrowth1y));
  kv('Nettogewinn-Wachstum 1J', pdfPct(d.netIncomeGrowth1y));

  subheading('Profitabilität');
  kv('Bruttomarge', pdfPct(d.grossMargin));
  kv('Operative Marge', pdfPct(d.operatingMargin));
  kv('Nettomarge', pdfPct(d.netMargin));
  kv('FCF-Marge', pdfPct(d.fcfMargin));
  kv('ROE', pdfPct(d.roe));
  kv('ROA', pdfPct(d.roa));

  // Forward-Multiples (yfinance) — zeigt die Erwartung statt nur des Rückblicks.
  if (yfExtra && (yfExtra.forwardPE != null || yfExtra.forwardEps != null || yfExtra.trailingPE != null)) {
    subheading('Bewertungs-Multiples');
    if (yfExtra.trailingPE != null) kv('KGV (TTM)', Number(yfExtra.trailingPE).toFixed(1));
    if (yfExtra.forwardPE != null)  kv('Forward-KGV', Number(yfExtra.forwardPE).toFixed(1));
    if (yfExtra.trailingEps != null) kv('EPS (TTM)', Number(yfExtra.trailingEps).toFixed(2));
    if (yfExtra.forwardEps != null) kv('Forward-EPS', Number(yfExtra.forwardEps).toFixed(2));
    if (yfExtra.pegRatio != null)   kv('PEG-Ratio', Number(yfExtra.pegRatio).toFixed(2));
  }

  subheading('Bilanz / Verschuldung');
  kv('Aktiva', pdfMoney(f.assets?.fy?.[0]?.val, currency));
  kv('Eigenkapital', pdfMoney(f.equity?.fy?.[0]?.val, currency));
  kv('Langfr. Schulden', pdfMoney(f.longTermDebt?.fy?.[0]?.val, currency));
  kv('Cash & Äquivalente', pdfMoney(f.cashAndEquivalents?.fy?.[0]?.val, currency));
  kv('Debt/Equity', d.debtToEquity != null ? d.debtToEquity.toFixed(2) : '—');
  kv('Debt/Assets', pdfPct(d.debtToAssets));

  // ----- Fairer Wert -----
  if (fairValue?.summary) {
    heading('Fairer Wert (Multi-Methode)');
    const fv = fairValue;
    kv('Median', pdfMoney(fv.summary.median, currency));
    kv('Spanne', `${pdfMoney(fv.summary.low, currency)} – ${pdfMoney(fv.summary.high, currency)}`);
    if (fv.summary.upside !== null && fv.summary.upside !== undefined) {
      kv('vs. Kurs (Upside)', `${(fv.summary.upside * 100).toFixed(1)}%`);
    }
    subheading('Methoden im Detail');
    (fv.methods || []).forEach(m => {
      ensureRoom(30);
      doc.fillColor(C.text).font('Sans-Bold').fontSize(10).text(m.label + ':  ' + pdfMoney(m.value, currency), { continued: false });
      doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(m.details, { width: W, lineGap: 1 });
      doc.moveDown(0.2);
    });
  }

  // ----- Peer-Vergleich (Issue 9 / Issue 12) -----
  // Übersichtstabelle: Ticker · Kurs · Δ · Marktkap · Börse
  // Peer-Matrix mit Perzentilen pro Kennzahl
  if ((Array.isArray(peers) && peers.length) || (peerMatrix && peerMatrix.rows?.length)) {
    ensureRoom(200);
    heading('Peer-Vergleich');

    // Übersichtstabelle
    if (Array.isArray(peers) && peers.length) {
      subheading('Peer-Übersicht');
      para('Peer-Liste aus KI-Vorschlag, Quotes via yfinance.', { color: C.muted, size: 9 });

      // Spalten: Ticker | Kurs | Δ Tag | Marktkap | Börse
      const cw = [W * 0.18, W * 0.18, W * 0.16, W * 0.28, W * 0.20];
      const cx = [LEFT, LEFT + cw[0], LEFT + cw[0] + cw[1], LEFT + cw[0] + cw[1] + cw[2], LEFT + cw[0] + cw[1] + cw[2] + cw[3]];

      // Header
      ensureRoom(20);
      const yHead = doc.y;
      doc.fillColor(C.muted).font('Sans').fontSize(8);
      doc.text('Ticker', cx[0], yHead, { width: cw[0], lineBreak: false });
      doc.text('Kurs', cx[1], yHead, { width: cw[1], align: 'right', lineBreak: false });
      doc.text('Δ Tag', cx[2], yHead, { width: cw[2], align: 'right', lineBreak: false });
      doc.text('Marktkap.', cx[3], yHead, { width: cw[3], align: 'right', lineBreak: false });
      doc.text('Börse', cx[4], yHead, { width: cw[4], align: 'right', lineBreak: false });
      doc.y = yHead + 12;
      doc.moveTo(LEFT, doc.y - 2).lineTo(RIGHT, doc.y - 2).strokeColor(C.line).lineWidth(0.5).stroke();

      // Eigene Zeile zuerst (highlighted)
      const drawPeerRow = (tickerCol, infoObj, isMain) => {
        ensureRoom(14);
        const yR = doc.y + 2;
        if (isMain) {
          doc.save();
          doc.rect(LEFT - 4, yR - 2, W + 8, 14).fill(C.bgSoft);
          doc.restore();
        }
        const i = infoObj || {};
        const change = (i.price && i.previous_close) ? ((i.price - i.previous_close) / i.previous_close) : null;
        doc.fillColor(isMain ? C.accent : C.text).font('Sans-Bold').fontSize(9).text(
          tickerCol + (isMain ? ' ★' : ''), cx[0], yR, { width: cw[0], lineBreak: false }
        );
        doc.fillColor(C.text).font('Sans').fontSize(9).text(
          i.price != null ? pdfStr(i.price) + ' ' + (i.currency || '') : '—', cx[1], yR, { width: cw[1], align: 'right', lineBreak: false }
        );
        const chCol = change == null ? C.muted : change > 0 ? C.pos : change < 0 ? C.neg : C.muted;
        doc.fillColor(chCol).font('Sans').fontSize(9).text(
          change == null ? '—' : (change > 0 ? '+' : '') + (change * 100).toFixed(2) + '%',
          cx[2], yR, { width: cw[2], align: 'right', lineBreak: false }
        );
        doc.fillColor(C.text).font('Sans').fontSize(9).text(
          pdfMoney(i.market_cap, i.currency), cx[3], yR, { width: cw[3], align: 'right', lineBreak: false }
        );
        doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
          i.exchange || '—', cx[4], yR, { width: cw[4], align: 'right', lineBreak: false }
        );
        doc.y = yR + 12;
      };

      drawPeerRow(ticker, info, true);
      peers.forEach(p => drawPeerRow(p.ticker, p.info, false));
      doc.moveDown(0.2);
    }

    // Peer-Matrix mit Perzentilen (Issue 9)
    if (peerMatrix && peerMatrix.rows?.length) {
      ensureRoom(120);
      subheading('Peer-Matrix mit Perzentilen (Issue 9)');
      para('Pro Kennzahl: Perzentil-Wert (P) zeigt die relative Position innerhalb der Peer-Gruppe. P75+ = Top-Quartil, P50-75 = über Mittel, P25-50 = unter Mittel, P0-25 = unteres Quartil. Pfeil ↑ = höher besser, ↓ = niedriger besser.',
        { color: C.muted, size: 8.5 });

      const spec = peerMatrix.metric_spec || {};
      // Wir splitten die Metriken in zwei Tabellen, damit ~5 Spalten + Ticker
      // pro Tabelle Platz finden — sonst wird's auf A4 zu eng.
      const allKeys = Object.keys(spec);
      const groups = [allKeys.slice(0, Math.ceil(allKeys.length / 2)), allKeys.slice(Math.ceil(allKeys.length / 2))];

      const fmtMetric = (v, format) => {
        if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
        if (format === 'pct') return (Number(v) * 100).toFixed(1) + '%';
        return Number(v).toFixed(2);
      };
      const pColor = p => {
        if (p === null || p === undefined) return C.muted;
        if (p >= 75) return C.pos;
        if (p >= 50) return C.info;
        if (p >= 25) return C.warn;
        return C.neg;
      };

      groups.forEach((keys, gi) => {
        if (!keys.length) return;
        ensureRoom(80);
        const colWFirst = W * 0.18;
        const colWRest = (W - colWFirst) / keys.length;
        const xCol = (i) => LEFT + colWFirst + i * colWRest;

        // Header
        const yHead = doc.y;
        doc.fillColor(C.muted).font('Sans').fontSize(7.5).text(
          gi === 0 ? 'Ticker' : 'Ticker (Fortsetzung)', LEFT, yHead, { width: colWFirst, lineBreak: false }
        );
        keys.forEach((k, i) => {
          const s = spec[k] || {};
          const dir = s.higher_is_better ? '↑' : '↓';
          doc.fillColor(C.muted).font('Sans').fontSize(7.5).text(
            (s.label || k) + ' ' + dir, xCol(i), yHead, { width: colWRest, align: 'right', lineBreak: false }
          );
        });
        doc.y = yHead + 11;
        doc.moveTo(LEFT, doc.y - 1).lineTo(RIGHT, doc.y - 1).strokeColor(C.line).lineWidth(0.5).stroke();

        // Hauptzeile zuerst
        const mainRow = peerMatrix.rows.find(r => r.ticker === ticker);
        const otherRows = peerMatrix.rows.filter(r => r.ticker !== ticker);
        const drawMatrixRow = (r, isMain) => {
          ensureRoom(22);
          const yR = doc.y + 2;
          if (isMain) {
            doc.save();
            doc.rect(LEFT - 4, yR - 2, W + 8, 22).fill(C.bgSoft);
            doc.restore();
          }
          doc.fillColor(isMain ? C.accent : C.text).font('Sans-Bold').fontSize(9).text(
            r.ticker + (isMain ? ' ★' : ''), LEFT, yR, { width: colWFirst, lineBreak: false }
          );
          keys.forEach((k, i) => {
            const v = r.metrics?.[k];
            const p = r.percentiles?.[k];
            doc.fillColor(C.text).font('Sans').fontSize(8.5).text(
              fmtMetric(v, spec[k]?.format), xCol(i), yR, { width: colWRest, align: 'right', lineBreak: false }
            );
            doc.fillColor(pColor(p)).font('Sans-Bold').fontSize(7.5).text(
              p == null ? '—' : 'P' + p, xCol(i), yR + 11, { width: colWRest, align: 'right', lineBreak: false }
            );
          });
          doc.y = yR + 22;
        };
        if (mainRow) drawMatrixRow(mainRow, true);
        otherRows.forEach(r => drawMatrixRow(r, false));
        doc.moveDown(0.3);
      });

      // Aggregat-Score (Median der Perzentile der Hauptzeile)
      const mainRow = peerMatrix.rows.find(r => r.ticker === ticker);
      if (mainRow?.percentiles) {
        const ps = Object.values(mainRow.percentiles).filter(p => p !== null && p !== undefined);
        if (ps.length) {
          const sorted = [...ps].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const med = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
          const medCol = med >= 60 ? C.pos : med >= 40 ? C.info : C.warn;
          kv('Aggregat-Perzentil', 'P' + med, { color: medCol, bold: true });
        }
      }
    }
  }

  // ----- KI-Analyse -----
  if (analysis) {
    ensureRoom(320);
    heading('KI-Analyse — Steckbrief & Investment-These');
    if (analysis.steckbrief?.kurzbeschreibung) {
      subheading('Kurzbeschreibung');
      para(analysis.steckbrief.kurzbeschreibung);
    }
    if (analysis.steckbrief?.geschaeftsmodell) {
      subheading('Geschäftsmodell');
      para(analysis.steckbrief.geschaeftsmodell);
    }
    if (analysis.steckbrief?.marktposition) {
      subheading('Marktposition');
      para(analysis.steckbrief.marktposition);
    }
    if (analysis.investment_these) {
      subheading('Pro-Argumente');
      bulletList(analysis.investment_these.pro || [], { bulletColor: C.pos });
      subheading('Contra-Argumente');
      bulletList(analysis.investment_these.contra || [], { bulletColor: C.neg });
    }
    if (analysis.wachstumstreiber?.length) {
      subheading('Wachstumstreiber');
      bulletList(analysis.wachstumstreiber);
    }
    if (analysis.risiken?.length) {
      subheading('Risiken (KI-identifiziert)');
      analysis.risiken.forEach(r => {
        ensureRoom(48);
        doc.x = LEFT;
        doc.fillColor(C.text).font('Sans-Bold').fontSize(10).text('●  ' + (r.risiko || '—'), LEFT, doc.y, { width: W });
        doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
          `Wahrscheinlichkeit: ${r.wahrscheinlichkeit || '—'}  ·  Auswirkung: ${r.auswirkung || '—'}`,
          LEFT, doc.y, { width: W }
        );
        if (r.details) {
          doc.fillColor(C.text).font('Sans').fontSize(9.5).text(r.details, LEFT, doc.y, { width: W, lineGap: 1 });
        }
        doc.moveDown(0.3);
      });
    }
    if (analysis.szenarien) {
      const sz = analysis.szenarien;
      subheading('Szenarien (Bull / Base / Bear)');
      ['bull', 'base', 'bear'].forEach(k => {
        if (sz[k]) {
          ensureRoom(60);
          doc.x = LEFT;
          const label = k === 'bull' ? 'Bull' : k === 'base' ? 'Base' : 'Bear';
          const col = k === 'bull' ? C.pos : k === 'base' ? C.info : C.neg;
          doc.fillColor(col).font('Sans-Bold').fontSize(10).text(
            `${label} Case  (${sz[k].wahrscheinlichkeit ?? '—'}%)`, LEFT, doc.y, { width: W }
          );
          doc.fillColor(C.text).font('Sans').fontSize(9.5).text(sz[k].these || '—', LEFT, doc.y, { width: W, lineGap: 1 });
          if (sz[k].treiber?.length) {
            doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
              'Treiber: ' + sz[k].treiber.join(' · '), LEFT, doc.y, { width: W }
            );
          }
          doc.moveDown(0.3);
        }
      });
    }
  }

  // ----- KI-Tiefenanalyse -----
  if (deep?.deep) {
    ensureRoom(280);
    heading('KI-Tiefenanalyse');
    const dp = deep.deep;
    if (dp.geschaeftsmodell) {
      subheading('Geschäftsmodell');
      kv('Typ', dp.geschaeftsmodell.typ || '—');
      kv('Skalierbarkeit', dp.geschaeftsmodell.skalierbarkeit?.bewertung || '—');
      kv('Confidence', dp.geschaeftsmodell.confidence || '—');
      para(dp.geschaeftsmodell.wie_geld_verdient || '');
    }
    if (dp.zukunftsfaehigkeit) {
      subheading('Zukunftsfähigkeit');
      kv('TAM-Wachstum', dp.zukunftsfaehigkeit.tam_wachstum?.einschaetzung || '—');
      kv('Disruptionsrisiko', dp.zukunftsfaehigkeit.disruptionsrisiko?.niveau || '—');
      kv('Technologie', dp.zukunftsfaehigkeit.technologie?.bewertung || '—');
      kv('Regulatorisch', dp.zukunftsfaehigkeit.regulatorisch?.bewertung || '—');
    }
    if (dp.konkurrenz) {
      subheading('Konkurrenz & Marktstruktur');
      kv('Marktstruktur', dp.konkurrenz.marktstruktur || '—');
      kv('Preissetzungsmacht', dp.konkurrenz.preissetzungsmacht?.bewertung || '—');
      kv('Eigener Marktanteil', dp.konkurrenz.eigener_marktanteil_pct ? Number(dp.konkurrenz.eigener_marktanteil_pct).toFixed(1) + '%' : '—');
      if (dp.konkurrenz.hauptwettbewerber?.length) {
        para('Hauptwettbewerber:', { bold: true, color: C.muted });
        dp.konkurrenz.hauptwettbewerber.forEach(c => {
          ensureRoom(20);
          doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
            `• ${c.name || '—'}${c.ticker ? ' (' + c.ticker + ')' : ''}${c.marktanteil_pct != null ? '  — Marktanteil ~' + Number(c.marktanteil_pct).toFixed(1) + '%' : ''}`,
            { width: W }
          );
        });
      }
    }
    if (dp.burggraben_detail) {
      subheading(`Burggraben (Gesamt ${dp.burggraben_detail.gesamtscore ?? '—'}/100)`);
      para(dp.burggraben_detail.gesamt_begruendung || '');
    }
  }

  // ----- 6-Monats-News -----
  if (news6m) {
    ensureRoom(220);
    heading('News der letzten 6 Monate');
    if (news6m.ai?.summary) {
      subheading('Zusammenfassung');
      para(news6m.ai.summary);
    }
    if (news6m.ai?.sentiment) {
      const s = news6m.ai.sentiment;
      subheading('Sentiment');
      kv('Score', `${s.score}/100`);
      kv('Label', s.label || '—');
      if (s.begruendung) para(s.begruendung);
    }
    if (news6m.ai?.top_themen?.length) {
      subheading('Top-Themen');
      news6m.ai.top_themen.forEach(t => {
        ensureRoom(22);
        doc.fillColor(C.text).font('Sans-Bold').fontSize(10).text(
          '● ' + (t.thema || '—') + `  [${t.tendenz || '—'}]`,
          LEFT, doc.y, { width: W }
        );
        if (t.details) {
          doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
            t.details, LEFT, doc.y, { width: W, lineGap: 1 }
          );
        }
        doc.moveDown(0.15);
      });
    }
    if (news6m.ai?.wichtige_ereignisse?.length) {
      subheading('Wichtige Ereignisse');
      news6m.ai.wichtige_ereignisse.forEach(e => {
        ensureRoom(18);
        doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
          `• ${e.datum_kontext || ''} — ${e.ereignis || '—'} [${e.auswirkung || '—'}]`,
          LEFT, doc.y, { width: W }
        );
      });
    }

    // Detail-Liste aller 6-Monats-News-Treffer mit Snippet + Quelle.
    // Pre-measure jede Karte und reserviere passenden Platz, damit nichts
    // mitten zwischen Titel und URL umbricht und keine Karte hinten verschluckt
    // wird.
    const res6m = Array.isArray(news6m.results) ? news6m.results : [];
    if (res6m.length) {
      subheading(`Detail-Quellen (${res6m.length} Treffer)`);
      res6m.slice(0, 25).forEach((n, idx) => {
        const title = `[${idx + 1}] ${n.title || '—'}`;
        const snippet = n.snippet ? String(n.snippet) : '';
        const urlStr = n.url ? pdfBreakUrl(n.url, W, doc) : '';
        const hTitle = doc.font('Sans-Bold').fontSize(9.5).heightOfString(title, { width: W, lineGap: 1 });
        const hSnip = snippet ? doc.font('Sans').fontSize(9).heightOfString(snippet, { width: W, lineGap: 1 }) : 0;
        const hUrl = urlStr ? doc.font('Sans').fontSize(7.5).heightOfString(urlStr, { width: W, lineGap: 0 }) : 0;
        ensureRoom(hTitle + hSnip + hUrl + 12);

        doc.fillColor(C.info).font('Sans-Bold').fontSize(9.5).text(
          title, LEFT, doc.y, { width: W, link: n.url || null, underline: false, lineGap: 1 }
        );
        if (snippet) {
          doc.fillColor(C.text).font('Sans').fontSize(9).text(
            snippet, LEFT, doc.y, { width: W, lineGap: 1 }
          );
        }
        if (urlStr) {
          doc.fillColor(C.muted).font('Sans').fontSize(7.5).text(
            urlStr, LEFT, doc.y, { width: W, lineGap: 0 }
          );
        }
        doc.moveDown(0.35);
      });
    }
  }

  // ----- Branche -----
  if (industry) {
    ensureRoom(260);
    heading('Branchenanalyse');
    const i = industry.ai || {};
    kv('Sektor', industry.sector || '—');
    kv('Industrie', industry.industry || '—');
    if (i.gesamteinschaetzung) {
      kv('Ausblick', i.gesamteinschaetzung.ausblick || '—');
      kv('Wachstumsphase', i.gesamteinschaetzung.wachstumsphase || '—');
      subheading('Zusammenfassung');
      para(i.gesamteinschaetzung.zusammenfassung || '');
    }
    if (i.treiber?.length) {
      subheading('Treiber');
      i.treiber.forEach(t => {
        ensureRoom(20);
        doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
          `• ${t.thema || '—'} [${t.richtung || '—'}]: ${t.details || ''}`,
          { width: W, lineGap: 1 }
        );
      });
    }
    if (i.risiken?.length) {
      subheading('Risiken');
      i.risiken.forEach(r => {
        ensureRoom(20);
        doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
          `• ${r.risiko || '—'} [Auswirkung: ${r.auswirkung || '—'}]: ${r.details || ''}`,
          { width: W, lineGap: 1 }
        );
      });
    }
    if (i.fazit_fuer_firma) {
      subheading('Bezug zu ' + (info.longName || ticker));
      para(i.fazit_fuer_firma);
    }
  }

  // ----- Quellenanhang -----
  ensureRoom(200);
  heading('Quellen & Datenbasis');
  const allSources = [];
  (news6m?.results || []).slice(0, 12).forEach((n, i) => allSources.push({ kategorie: 'News 6m', title: n.title, url: n.url }));
  (industry?.sources || []).slice(0, 10).forEach((n, i) => allSources.push({ kategorie: 'Branche', title: n.title, url: n.url }));
  (deep?.sources?.competitor_search || []).slice(0, 6).forEach((n) => allSources.push({ kategorie: 'Tiefenanalyse: Wettbewerber', title: n.title, url: n.url }));
  (deep?.sources?.market_search || []).slice(0, 6).forEach((n) => allSources.push({ kategorie: 'Tiefenanalyse: Markt', title: n.title, url: n.url }));
  (filings || []).slice(0, 8).forEach(f => allSources.push({ kategorie: 'SEC ' + (f.form || ''), title: `Eingereicht ${f.date} (Stichtag ${f.report_date || '?'})`, url: f.url }));
  (news || []).slice(0, 8).forEach(n => allSources.push({ kategorie: 'News (aktuell)', title: n.title, url: n.url }));

  if (!allSources.length) {
    para('Keine Quellen-Links verfügbar.', { color: C.muted });
  } else {
    allSources.forEach(s => {
      const kat = (s.kategorie || '').toUpperCase();
      const title = s.title || s.url || '—';
      const urlStr = s.url && /^https?:/i.test(s.url) ? pdfBreakUrl(s.url, W, doc) : '';
      // Höhe vorab messen, damit komplette Quell-Einträge nie auseinanderbrechen
      // und auch der letzte Eintrag noch auf eine neue Seite passt.
      const hKat = doc.font('Sans').fontSize(8).heightOfString(kat, { width: W });
      const hTitle = doc.font('Sans').fontSize(9.5).heightOfString(title, { width: W, lineGap: 1 });
      const hUrl = urlStr ? doc.font('Sans').fontSize(8).heightOfString(urlStr, { width: W }) : 0;
      ensureRoom(hKat + hTitle + hUrl + 10);

      doc.fillColor(C.muted).font('Sans').fontSize(8).text(
        kat, LEFT, doc.y, { width: W, characterSpacing: 0.5 }
      );
      if (urlStr) {
        doc.fillColor(C.info).font('Sans').fontSize(9.5).text(
          title, LEFT, doc.y, { link: s.url, underline: false, width: W, lineGap: 1 }
        );
        doc.fillColor(C.muted).font('Sans').fontSize(8).text(
          urlStr, LEFT, doc.y, { width: W, lineGap: 0 }
        );
      } else {
        doc.fillColor(C.text).font('Sans').fontSize(9.5).text(
          title, LEFT, doc.y, { width: W, lineGap: 1 }
        );
      }
      doc.moveDown(0.3);
    });
  }

  // Footer auf jeder Seite (post-hoc, mit Range)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 30;
    // height + lineBreak:false verhindert PDFKit's Auto-Pagebreak — der Footer
    // sitzt bewusst unterhalb der Bottom-Margin und würde sonst je Schreibvorgang
    // eine zusätzliche Leerseite anhängen.
    doc.fillColor(C.muted).font('Sans').fontSize(8).text(
      `Alpha-Scope · ${ticker} · ${displayName}  ·  Erstellt ${generated}`,
      LEFT, y, { width: W, align: 'left', lineGap: 0, lineBreak: false, height: 12 }
    );
    doc.fillColor(C.muted).font('Sans').fontSize(8).text(
      `Seite ${i - range.start + 1} / ${range.count}`,
      LEFT, y, { width: W, align: 'right', lineBreak: false, height: 12 }
    );
  }
}

app.post('/api/report-pdf', async (req, res) => {
  try {
    const state = req.body || {};
    if (!state.ticker) return res.status(400).json({ error: 'ticker required' });

    const fileName = `Alpha-Scope_${state.ticker}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      bufferPages: true,
      info: {
        Title: `Alpha-Scope Report — ${state.ticker}`,
        Author: 'Alpha-Scope',
        Subject: 'Investment-Research-Report',
      },
    });
    doc.pipe(res);
    try {
      buildPDF(doc, state);
    } catch (innerErr) {
      console.error('PDF build error', innerErr);
      // Bei spätem Fehler: Fehler-Seite einfügen statt Response abreißen
      try {
        doc.addPage();
        doc.fillColor('#b91c1c').font('Sans-Bold').fontSize(14).text('PDF-Generierung fehlgeschlagen');
        doc.fillColor('#0f131a').font('Sans').fontSize(10).text(String(innerErr.message || innerErr));
      } catch {}
    }
    doc.end();
  } catch (e) {
    console.error('report-pdf failed', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// KI-Assistent mit RAG (Issue 8)
// Indiziert die gesammelten Analyse-Texte (KI-Analyse, Tiefenanalyse, News,
// Branche, Fazit, Filings, Fundamentaldaten) im tools-server (Chroma + lokale
// Embeddings) und beantwortet Fragen per Retrieval + LLM-Chat.
// ---------------------------------------------------------------------------
function ragNamespace(ticker) {
  // Chroma-Namespace muss alphanumerisch sein und mit Buchstabe/Zahl starten.
  const t = String(ticker || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return 'alphascope_' + (t || 'unknown');
}

function pushDoc(docs, id, text, metadata) {
  if (!text || !String(text).trim()) return;
  // Chroma-Limit ~ einige Tausend Tokens pro Embedding — wir kappen großzügig
  const clean = String(text).replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4500);
  docs.push({ id, text: clean, metadata: metadata || {} });
}

function buildRagDocuments(state) {
  // state ist das Frontend-Sammel-Objekt: ticker, info, fundamentals, analysis,
  // deep, news6m, industry, conclusion, news, filings, score, yfExtra.
  const ticker = state.ticker;
  const info = state.info || {};
  const docs = [];
  const name = state.displayName || info.longName || info.shortName || ticker;

  // ----- Übersicht / Steckbrief -----
  const headerText = [
    `Unternehmen: ${name} (${ticker})`,
    info.exchange ? `Börse: ${info.exchange}` : '',
    info.sector ? `Sektor: ${info.sector}` : '',
    info.industry ? `Industrie: ${info.industry}` : '',
    info.market_cap ? `Marktkapitalisierung: ${(info.market_cap / 1e9).toFixed(2)} Mrd ${info.currency || ''}` : '',
    info.price ? `Letzter Kurs: ${info.price} ${info.currency || ''}` : '',
    info.year_high ? `52-Wochen-Hoch: ${info.year_high}` : '',
    info.year_low ? `52-Wochen-Tief: ${info.year_low}` : '',
  ].filter(Boolean).join('\n');
  pushDoc(docs, `header_${ticker}`, headerText, { type: 'header', ticker, title: name });

  // ----- Fundamentaldaten (kompakt) -----
  if (state.fundamentals) {
    pushDoc(docs, `fundamentals_${ticker}`,
      'Fundamentaldaten (aus SEC XBRL):\n' + compactFinancials(state.fundamentals),
      { type: 'fundamentals', ticker, title: 'Fundamentaldaten' });
    // FY-Reihen einzeln einlegen, damit Fragen wie "Wie war der Umsatz 2022?" treffen
    const f = state.fundamentals.fundamentals || {};
    for (const [key, label] of [
      ['revenue', 'Umsatz'], ['netIncome', 'Nettogewinn'], ['grossProfit', 'Bruttogewinn'],
      ['operatingIncome', 'Operatives Ergebnis'], ['operatingCashFlow', 'Operativer Cashflow'],
      ['capex', 'CapEx'], ['assets', 'Aktiva'], ['equity', 'Eigenkapital'],
      ['longTermDebt', 'Langfristige Schulden'], ['dilutedEps', 'EPS verwässert'],
    ]) {
      const fy = f[key]?.fy || [];
      if (!fy.length) continue;
      const lines = fy.slice(0, 6).map(r => `FY${r.fy}: ${r.val?.toLocaleString?.('de-DE') || r.val} (gemeldet ${r.filed})`);
      pushDoc(docs, `fund_${key}_${ticker}`, `${label} ${name} — letzte Geschäftsjahre:\n${lines.join('\n')}`,
        { type: 'fundamentals_series', ticker, title: `${label} (FY-Reihe)` });
    }
  }

  // ----- Scorecard -----
  if (state.score?.scores) {
    const sc = state.score.scores;
    const sLines = [
      `Gesamtscore: ${sc.total ?? '—'}/100, Verdict: ${state.score.verdict || '—'}, Ampel: ${state.score.ampel || '—'}`,
      `Qualität: ${sc.quality ?? '—'}/100`,
      `Wachstum: ${sc.growth ?? '—'}/100`,
      `Bewertung: ${sc.valuation ?? '—'}/100`,
      `Burggraben: ${sc.moat ?? '—'}/100`,
      `Sentiment: ${sc.sentiment ?? '—'}/100`,
      `Risiko: ${sc.risk ?? '—'}/100 (höhere Werte = weniger Risiko)`,
      state.score.forward_pe ? `Forward-KGV: ${state.score.forward_pe?.toFixed?.(2) || state.score.forward_pe}` : '',
      state.score.derived_pe ? `Trailing-KGV (aus Marktkap./TTM-NI): ${state.score.derived_pe?.toFixed?.(2) || state.score.derived_pe}` : '',
    ].filter(Boolean).join('\n');
    pushDoc(docs, `score_${ticker}`, `Scorecard ${name} (${ticker}):\n${sLines}`,
      { type: 'scorecard', ticker, title: 'Scorecard' });
  }

  // ----- KI-Analyse (Übersicht) -----
  if (state.analysis) {
    const a = state.analysis;
    if (a.steckbrief) {
      const s = a.steckbrief;
      pushDoc(docs, `analysis_steckbrief_${ticker}`,
        `Steckbrief ${name}:\nKurzbeschreibung: ${s.kurzbeschreibung || ''}\nGeschäftsmodell: ${s.geschaeftsmodell || ''}\nMarktposition: ${s.marktposition || ''}`,
        { type: 'analysis', section: 'steckbrief', ticker, title: 'Steckbrief' });
    }
    if (a.burggraben) {
      const b = a.burggraben;
      const fakt = Object.entries(b.faktoren || {}).map(([k, v]) =>
        `- ${k}: ${v?.staerke || '—'} — ${v?.beleg || ''}`).join('\n');
      pushDoc(docs, `analysis_moat_${ticker}`,
        `Burggraben/Moat ${name} (Score ${b.score ?? '—'}/100):\nBegründung: ${b.begruendung || ''}\n\nFaktoren:\n${fakt}`,
        { type: 'analysis', section: 'burggraben', ticker, title: 'Burggraben' });
    }
    if (Array.isArray(a.wachstumstreiber) && a.wachstumstreiber.length) {
      pushDoc(docs, `analysis_growth_${ticker}`,
        `Wachstumstreiber ${name}:\n- ${a.wachstumstreiber.join('\n- ')}`,
        { type: 'analysis', section: 'wachstum', ticker, title: 'Wachstumstreiber' });
    }
    if (Array.isArray(a.risiken) && a.risiken.length) {
      const r = a.risiken.map(x => `- ${x.risiko}: Wahrscheinlichkeit ${x.wahrscheinlichkeit || '?'}, Auswirkung ${x.auswirkung || '?'}. ${x.details || ''}`).join('\n');
      pushDoc(docs, `analysis_risks_${ticker}`,
        `Risiken ${name}:\n${r}`,
        { type: 'analysis', section: 'risiken', ticker, title: 'Risiken (KI)' });
    }
    if (Array.isArray(a.katalysatoren) && a.katalysatoren.length) {
      pushDoc(docs, `analysis_cat_${ticker}`,
        `Kurzfristige Katalysatoren ${name}:\n- ${a.katalysatoren.join('\n- ')}`,
        { type: 'analysis', section: 'katalysatoren', ticker, title: 'Katalysatoren' });
    }
    if (a.szenarien) {
      const sz = a.szenarien;
      pushDoc(docs, `analysis_scen_${ticker}`,
        `Szenarien ${name}:\nBull (${sz.bull?.wahrscheinlichkeit ?? '?'}%): ${sz.bull?.these || ''} — Treiber: ${(sz.bull?.treiber || []).join('; ')}\nBase (${sz.base?.wahrscheinlichkeit ?? '?'}%): ${sz.base?.these || ''} — Treiber: ${(sz.base?.treiber || []).join('; ')}\nBear (${sz.bear?.wahrscheinlichkeit ?? '?'}%): ${sz.bear?.these || ''} — Treiber: ${(sz.bear?.treiber || []).join('; ')}`,
        { type: 'analysis', section: 'szenarien', ticker, title: 'Bull/Base/Bear' });
    }
    if (a.investment_these) {
      const it = a.investment_these;
      pushDoc(docs, `analysis_thesis_${ticker}`,
        `Investment-These ${name}:\nPro:\n- ${(it.pro || []).join('\n- ')}\nContra:\n- ${(it.contra || []).join('\n- ')}\nFazit: ${it.fazit || ''}`,
        { type: 'analysis', section: 'these', ticker, title: 'Investment-These' });
    }
    if (a.bewertung_kommentar) {
      pushDoc(docs, `analysis_val_${ticker}`,
        `Bewertungskommentar ${name}:\n${a.bewertung_kommentar}`,
        { type: 'analysis', section: 'bewertung', ticker, title: 'Bewertung' });
    }
  }

  // ----- KI-Tiefenanalyse -----
  if (state.deep?.deep) {
    const dp = state.deep.deep;
    if (dp.geschaeftsmodell) {
      const gm = dp.geschaeftsmodell;
      const us = (gm.umsatzquellen || []).map(u => `  · ${u.name}${u.anteil_pct != null ? ` (${u.anteil_pct}%)` : ''}: ${u.beschreibung || ''}`).join('\n');
      pushDoc(docs, `deep_gm_${ticker}`,
        `Geschäftsmodell ${name} (Typ: ${gm.typ || '—'}):\n${gm.wie_geld_verdient || ''}\n\nUmsatzquellen:\n${us}\n\nSkalierbarkeit: ${gm.skalierbarkeit?.bewertung || '—'} — ${gm.skalierbarkeit?.begruendung || ''}\nAbhängigkeiten: ${(gm.abhaengigkeiten || []).join(', ')}\nQuellen: ${(gm.quellen || []).join(' | ')}`,
        { type: 'deep', section: 'geschaeftsmodell', ticker, title: 'Geschäftsmodell (Tiefenanalyse)' });
    }
    if (dp.zukunftsfaehigkeit) {
      const z = dp.zukunftsfaehigkeit;
      const tr = (z.markttrends || []).map(t => `- ${t.trend} (${t.richtung}): ${t.details || ''}`).join('\n');
      pushDoc(docs, `deep_future_${ticker}`,
        `Zukunftsfähigkeit ${name}:\nMarkttrends:\n${tr}\n\nTechnologie: ${z.technologie?.bewertung || '—'} — ${z.technologie?.details || ''}\nRegulatorisch: ${z.regulatorisch?.bewertung || '—'} — ${z.regulatorisch?.details || ''}\nTAM-Wachstum: ${z.tam_wachstum?.einschaetzung || '—'} — ${z.tam_wachstum?.begruendung || ''}\nDisruptionsrisiko: ${z.disruptionsrisiko?.niveau || '—'} — ${z.disruptionsrisiko?.begruendung || ''}`,
        { type: 'deep', section: 'zukunft', ticker, title: 'Zukunftsfähigkeit' });
    }
    if (dp.konkurrenz) {
      const k = dp.konkurrenz;
      const comp = (k.hauptwettbewerber || []).map(c => `- ${c.name}${c.ticker ? ` (${c.ticker})` : ''}${c.marktanteil_pct != null ? ` — Marktanteil ~${c.marktanteil_pct}%` : ''}: Stärken: ${c.staerken || '—'}; Schwächen: ${c.schwaechen || '—'}`).join('\n');
      pushDoc(docs, `deep_comp_${ticker}`,
        `Konkurrenz / Marktstruktur (${k.marktstruktur || '—'}) ${name}:\nEigener Marktanteil: ${k.eigener_marktanteil_pct ?? '—'}\nWettbewerbsvorteile: ${(k.wettbewerbsvorteile || []).join('; ')}\nPreissetzungsmacht: ${k.preissetzungsmacht?.bewertung || '—'} — ${k.preissetzungsmacht?.begruendung || ''}\n\nHauptwettbewerber:\n${comp}`,
        { type: 'deep', section: 'konkurrenz', ticker, title: 'Konkurrenz' });
    }
    if (dp.burggraben_detail) {
      const bd = dp.burggraben_detail;
      const lines = ['marken', 'wechselkosten', 'netzwerkeffekte', 'kostenvorteile', 'skaleneffekte', 'regulatorische_barrieren', 'ip_patente']
        .map(k => bd[k] ? `- ${k}: ${bd[k].staerke || '—'} — ${bd[k].beleg || ''} (Quelle: ${bd[k].quelle || '—'})` : null)
        .filter(Boolean).join('\n');
      pushDoc(docs, `deep_moat_${ticker}`,
        `Burggraben-Detail ${name} (Gesamtscore ${bd.gesamtscore ?? '—'}/100):\n${bd.gesamt_begruendung || ''}\n\n${lines}`,
        { type: 'deep', section: 'burggraben', ticker, title: 'Burggraben-Detail' });
    }
  }

  // ----- 6-Monats-News -----
  if (state.news6m?.ai) {
    const ai = state.news6m.ai;
    pushDoc(docs, `news6m_summary_${ticker}`,
      `6-Monats-News-Zusammenfassung ${name}:\n${ai.summary || ''}\n\nSentiment: ${ai.sentiment?.label || '—'} (Score ${ai.sentiment?.score ?? '—'}). ${ai.sentiment?.begruendung || ''}`,
      { type: 'news6m_summary', ticker, title: '6-Monats-News (Zusammenfassung)' });
    if (Array.isArray(ai.top_themen) && ai.top_themen.length) {
      const themen = ai.top_themen.map(t => `- ${t.thema} (${t.tendenz}): ${t.details || ''}`).join('\n');
      pushDoc(docs, `news6m_themen_${ticker}`,
        `Top-Themen ${name} (6 Monate):\n${themen}`,
        { type: 'news6m_themes', ticker, title: 'Top-Themen' });
    }
    if (Array.isArray(ai.wichtige_ereignisse) && ai.wichtige_ereignisse.length) {
      const ev = ai.wichtige_ereignisse.map(e => `- ${e.datum_kontext}: ${e.ereignis} (Auswirkung: ${e.auswirkung || '—'})`).join('\n');
      pushDoc(docs, `news6m_events_${ticker}`,
        `Wichtige Ereignisse ${name}:\n${ev}`,
        { type: 'news6m_events', ticker, title: 'Wichtige Ereignisse' });
    }
  }
  // News-Items einzeln einlegen, damit man konkrete Nachrichten retrieven kann
  const allNews = (state.news6m?.results || state.news || []).slice(0, 24);
  allNews.forEach((n, i) => {
    if (!n.title) return;
    pushDoc(docs, `news_${ticker}_${i}`,
      `${n.title}\n${n.snippet || ''}\nQuelle: ${n.url || ''}`,
      { type: 'news', ticker, title: n.title, url: n.url || '' });
  });

  // ----- Branche -----
  if (state.industry?.ai) {
    const ind = state.industry.ai;
    pushDoc(docs, `industry_${ticker}`,
      `Branchenanalyse für ${ind.branche_label || state.industry.industry || '—'} (relevant für ${name}):\nAusblick: ${ind.gesamteinschaetzung?.ausblick || '—'}, Wachstumsphase: ${ind.gesamteinschaetzung?.wachstumsphase || '—'}\n${ind.gesamteinschaetzung?.zusammenfassung || ''}\n\nWettbewerbsintensität: ${ind.wettbewerb_intensitaet || '—'}, Disruptionspotenzial: ${ind.disruption_potenzial || '—'}\nRegulatorisch: ${ind.regulatorisch?.bewertung || '—'} — ${ind.regulatorisch?.details || ''}\n\nBezug zur Firma: ${ind.fazit_fuer_firma || ''}`,
      { type: 'industry', ticker, title: 'Branchenanalyse' });
    const tr = (ind.treiber || []).map(t => `- ${t.thema} (${t.richtung}): ${t.details || ''}`).join('\n');
    if (tr) pushDoc(docs, `industry_drivers_${ticker}`, `Branchen-Treiber:\n${tr}`, { type: 'industry', ticker, title: 'Branchen-Treiber' });
    const rsk = (ind.risiken || []).map(t => `- ${t.risiko} (Auswirkung ${t.auswirkung || '—'}): ${t.details || ''}`).join('\n');
    if (rsk) pushDoc(docs, `industry_risks_${ticker}`, `Branchen-Risiken:\n${rsk}`, { type: 'industry', ticker, title: 'Branchen-Risiken' });
  }

  // ----- Conclusion / Ausführliches Fazit -----
  if (state.conclusion) {
    const c = state.conclusion;
    pushDoc(docs, `conclusion_main_${ticker}`,
      `Ausführliches Fazit ${name}:\nKernaussage: ${c.kernaussage || ''}\n\nGesamteinschätzung:\n${c.gesamteinschaetzung || ''}`,
      { type: 'conclusion', section: 'main', ticker, title: 'Ausführliches Fazit (Kern)' });
    for (const [k, label] of [['staerken', 'Stärken'], ['schwaechen', 'Schwächen'], ['chancen', 'Chancen'], ['risiken', 'Risiken']]) {
      const arr = c[k];
      if (Array.isArray(arr) && arr.length) {
        const t = arr.map(x => `- ${x.punkt}: ${x.details || ''} [Quelle: ${x.quelle || '—'}]`).join('\n');
        pushDoc(docs, `conclusion_${k}_${ticker}`, `${label} ${name} (Fazit):\n${t}`,
          { type: 'conclusion', section: k, ticker, title: `Fazit: ${label}` });
      }
    }
    if (c.handlungsempfehlung) {
      const h = c.handlungsempfehlung;
      pushDoc(docs, `conclusion_action_${ticker}`,
        `Handlungsempfehlung ${name}:\nTyp: ${h.typ || '—'}\nBegründung: ${h.begruendung || ''}\nBeobachtungspunkte:\n- ${(h.beobachtungspunkte || []).join('\n- ')}`,
        { type: 'conclusion', section: 'action', ticker, title: 'Handlungsempfehlung' });
    }
  }

  // ----- Filings (Liste) -----
  if (Array.isArray(state.filings) && state.filings.length) {
    const filingsList = state.filings.slice(0, 10).map(f =>
      `- ${f.form} eingereicht ${f.date} (Berichtsstichtag ${f.report_date || '—'}): ${f.url || ''}`
    ).join('\n');
    pushDoc(docs, `filings_${ticker}`,
      `Aktuelle SEC-Filings ${name}:\n${filingsList}`,
      { type: 'filings', ticker, title: 'SEC-Filings' });
  }

  return docs;
}

// Sessions-Speicher: pro Ticker, welche Dokumente haben wir indiziert?
// (Damit das Frontend bei jedem Datenupdate re-indexen kann, ohne dass alte
// Dokumente liegen bleiben.)
const ragSessions = new Map();

app.post('/api/rag/build', async (req, res) => {
  const state = req.body || {};
  const ticker = (state.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const namespace = ragNamespace(ticker);
    const docs = buildRagDocuments({ ...state, ticker });
    if (!docs.length) {
      return res.json({ ticker, namespace, indexed: 0, note: 'no-documents' });
    }

    // Alte Doks für Sektionen entfernen, die nicht mehr existieren, ist umständlich.
    // Stattdessen: bei jedem Build neuen Namespace verwenden (per Ticker) und
    // upsert=true setzen — das überschreibt vorhandene IDs.
    const r = await fetchJSON(`${TOOLS}/rag/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, documents: docs, upsert: true }),
    });
    ragSessions.set(ticker, { namespace, indexed: r.indexed, ids: r.ids, updated: Date.now() });
    res.json({ ticker, namespace, indexed: r.indexed, ids: r.ids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/rag/:ticker', async (req, res) => {
  const ticker = (req.params.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const namespace = ragNamespace(ticker);
    await fetchJSON(`${TOOLS}/rag/namespace/${encodeURIComponent(namespace)}`, { method: 'DELETE' });
    ragSessions.delete(ticker);
    res.json({ ticker, namespace, deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const ASSISTANT_SYSTEM = `Du bist der KI-Assistent von Alpha-Scope, einem Aktienanalyse-Tool. Du beantwortest Fragen zu einer konkreten Aktie auf Basis der gesammelten Analyse-Texte (SEC-Filings, News, Webscrapes, KI-Analysen).

Regeln:
- Nutze ausschließlich die im Kontext gelieferten Informationen. Wenn dort keine Antwort enthalten ist, sage das ehrlich.
- Gib bei jeder belegten Aussage in eckigen Klammern die Quellen-Nummer an (z.B. [1], [2,3]).
- Keine Anlageberatung, keine Kursziele. Statt "kaufen/verkaufen" Charakterisierungen verwenden.
- Antworte auf Deutsch, knapp und sachlich. Nutze kurze Absätze oder Stichpunkte für Übersichten.
- Wenn der User nach Zahlen fragt (Umsatz, Margen, KGV), gib den genauen Wert aus dem Kontext zusammen mit der Quelle [n].
- Wenn die Frage außerhalb des Scopes liegt (z.B. allgemeines Marktwissen ohne Bezug zur analysierten Firma), sage das.`;

function formatContextBlock(items) {
  return items.map((r, i) => {
    const meta = r.metadata || {};
    const head = `[${i + 1}] (${meta.type || 'doc'}) ${meta.title || r.id}${meta.url ? ' — ' + meta.url : ''}`;
    return `${head}\n${r.text}`;
  }).join('\n\n---\n\n');
}

app.post('/api/assistant', async (req, res) => {
  const { ticker, message, history = [] } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message required' });

  const namespace = ragNamespace(ticker);
  try {
    // 1. RAG-Retrieval: Top-8 relevante Dokumente
    let retrieved = [];
    try {
      const q = await fetchJSON(`${TOOLS}/rag/query?namespace=${encodeURIComponent(namespace)}&q=${encodeURIComponent(message)}&top_k=8`);
      retrieved = (q.results || []).filter(r => r.text);
    } catch (e) {
      // Namespace existiert evtl. noch nicht (frisch aufgerufene Analyse). Frontend
      // soll dann zuerst /api/rag/build aufrufen. Wir antworten freundlich.
      if (e.status === 404) {
        return res.json({
          reply: 'Ich habe für diesen Ticker noch keine Wissensbasis. Bitte warte, bis die Analyse fertig ist (oder lade die Seite neu) — dann lege ich automatisch los.',
          sources: [],
          retrieved_count: 0,
          namespace,
          warning: 'namespace-missing',
        });
      }
      throw e;
    }

    if (!retrieved.length) {
      // Auch wenn der Namespace existiert: evtl. matcht nichts. Trotzdem
      // dem LLM eine Antwort versuchen lassen, aber mit Hinweis.
      retrieved = [];
    }

    // 2. Prompt zusammenbauen
    const ctx = retrieved.length
      ? formatContextBlock(retrieved)
      : '— (kein relevanter Kontext gefunden — antworte ehrlich, dass du dazu in der Analyse nichts findest) —';

    const userPrompt = `## Verfügbarer Kontext zur analysierten Aktie

${ctx}

## Frage des Nutzers
${message}

Antworte auf Basis des obigen Kontexts. Verweise auf Quellen mit [1], [2] usw.`;

    // 3. Chat-Historie (kurz): die letzten max. 6 Turns
    const recentHistory = (Array.isArray(history) ? history : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-6)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

    const messages = [
      ...recentHistory,
      { role: 'user', content: userPrompt },
    ];

    const r = await fetchJSON(`${TOOLS}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: ASSISTANT_SYSTEM,
        messages,
        temperature: 0.3,
        max_tokens: 1200,
      }),
    });

    // 4. Quellen-Metadaten zurückgeben, damit das Frontend die [n] auflösen kann
    const sources = retrieved.map((s, i) => ({
      n: i + 1,
      id: s.id,
      type: s.metadata?.type || 'doc',
      title: s.metadata?.title || s.id,
      url: s.metadata?.url || null,
      score: s.score,
    }));

    res.json({
      reply: r.reply || '',
      model: r.model,
      usage: r.usage,
      sources,
      retrieved_count: retrieved.length,
      namespace,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Health & static
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'stock-research-copilot', cache_size: cache.size, uptime_s: Math.round(process.uptime()), rag_sessions: ragSessions.size });
});

// Static-Fallback — nicht zwingend nötig (nginx serviert die HTML direkt via
// wunderlampe), aber praktisch für direkte localhost-Tests.
app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'] }));

app.listen(PORT, HOST, () => {
  console.log(`[stock-research] listening on http://${HOST}:${PORT} (tools=${TOOLS})`);
});
