/**
 * Wunderlampe News — Frontend-Logik
 *
 * Reine Browser-App, spricht nur unseren lokalen Backend-Proxy (./api/...).
 * Alle Daten leben in localStorage. Akzeptanzkriterien siehe concept.md.
 */
'use strict';

// =============================================================================
// Konstanten & API-Client
// =============================================================================

const API_BASE = './api';

// Issue 24/40/42: LLM-Backend ist umschaltbar. Default ist weiterhin DeepSeek
// V4 Flash (über aimlapi, Konzept-Default). Der User wählt im Setup-Tab aus
// fünf Modellen; die Auswahl liegt in LS.llmBackend und wird von api.llm()
// bei jedem Call frisch gelesen. Die ID-Strings sind exakt so, wie unser
// Backend-Proxy (POST /api/llm/chat in server.js) sie an aimlapi.com/v1
// durchreicht. Issue 42: Der Pfad geht jetzt direkt gegen aimlapi (vorher
// über den tools-server-Proxy auf 127.0.0.1:8780/llm/chat), weil das
// tools-server-Schema keine provider-spezifischen Reasoning-Parameter
// erlaubt und Gemini 2.5 Flash ohne ausreichenden max_tokens-Headroom leere
// Antworten liefert.
// Issue 40: Neben den zwei bestehenden Backends (deepseek/gemini) drei neue
// Optionen (qwen/nemotron/grok). Reihenfolge in der UI = Reihenfolge hier.
const LLM_MODELS = {
  deepseek: 'deepseek/deepseek-v4-flash',
  gemini: 'google/gemini-2.5-flash',
  qwen: 'alibaba/qwen3.5-flash',
  nemotron: 'nvidia/nemotron-3-super-120b-a12b',
  grok: 'x-ai/grok-4-1-fast-reasoning',
};
// Issue 40: User-sichtbare Metadaten je Modell — Label für Anzeige,
// Untertitel-Hinweis, und Kosten pro 1M Tokens (Input/Output, USD, ca.-Werte
// laut aimlapi-Preisliste; können sich beim Provider ändern, deshalb in der
// UI mit „ca." gekennzeichnet). Wird vom Settings-Block in index.html und
// von updateLlmBackendUi gelesen.
const LLM_MODEL_META = {
  deepseek: {
    label: 'DeepSeek V4 Flash',
    note: 'Default — schnell & günstig, gut für deutsche Nachrichten.',
    inputCostPerM: 0.07,
    outputCostPerM: 0.28,
  },
  gemini: {
    label: 'Gemini 2.5 Flash',
    note: 'Google — präzise, multilingual; Nachfolger von 2.0 Flash mit besserem Reasoning.',
    inputCostPerM: 0.30,
    outputCostPerM: 2.50,
  },
  qwen: {
    label: 'Qwen 3.5 Flash',
    note: 'Alibaba — solide multilinguale Ausgabe, ähnliche Klasse wie Gemini.',
    inputCostPerM: 0.20,
    outputCostPerM: 0.60,
  },
  nemotron: {
    label: 'Nemotron 3 Super 120B (A12B)',
    note: 'NVIDIA — sehr großes Modell, hohe Qualität bei komplexen Aufgaben, langsamer.',
    inputCostPerM: 1.00,
    outputCostPerM: 1.50,
  },
  grok: {
    label: 'Grok 4.1 Fast Reasoning',
    note: 'xAI — Reasoning-Modell, am teuersten; für anspruchsvolle Analysen.',
    inputCostPerM: 2.00,
    outputCostPerM: 10.00,
  },
};
const LLM_DEFAULT_BACKEND = 'deepseek';
function currentLlmBackend() {
  const choice = (typeof localStorage !== 'undefined'
    ? localStorage.getItem('wl:llmBackend')
    : null) || LLM_DEFAULT_BACKEND;
  return LLM_MODELS[choice] ? choice : LLM_DEFAULT_BACKEND;
}
function currentLlmModel() {
  return LLM_MODELS[currentLlmBackend()];
}
// Backwards-compat-Alias für bisherige Aufrufe.
const LLM_MODEL = LLM_MODELS[LLM_DEFAULT_BACKEND];
// Issue 40: Hilfsformatter für die Kosten-Anzeige in der UI.
// „ca. $0.07 / $0.28 pro 1M Tokens (Input/Output)".
function formatLlmCost(key) {
  const meta = LLM_MODEL_META[key];
  if (!meta) return '';
  const fmt = (n) => `$${n.toFixed(2)}`;
  return `ca. ${fmt(meta.inputCostPerM)} / ${fmt(meta.outputCostPerM)} pro 1M Tokens (Input / Output)`;
}

// =============================================================================
// Issue 35: LLM-Diagnose-Infrastruktur — Concurrency-Limiter + Telemetry
// =============================================================================
//
// Hintergrund: composeBriefing scheitert oft mit leerem Reply, wenn die App
// kurz zuvor 10+ scoreArticles-/Klassifikator-Calls parallel rausgejagt hat
// (Promise.allSettled-Bursts). aimlapi antwortet dann häufig mit 429/503,
// dem alten Code fehlte Sicht darauf — er fiel direkt auf das Alternativ-
// Modell, das ebenfalls ins Burst-Window rutschte. Drei Schichten Hilfe:
//
// 1. __llmInvoke: zentraler Pfad für alle api.llm-Calls. Beschränkt die
//    Concurrency auf LLM_MAX_CONCURRENCY (3) und schreibt pro Call einen
//    Telemetry-Eintrag in einen Ringpuffer (LLM_TELEMETRY_CAP=60). Eintrag:
//    {startedAt, durationMs, httpStatus, replyLen, model, error?}.
// 2. _briefingCall (siehe composeBriefing weiter unten): retried bei
//    transienten HTTP-Stati (429/503/502/504/Netzwerk-Fehler) mit
//    exponential backoff 1s→3s→8s, BEVOR der Aufrufer das Modell wechselt.
// 3. Cooldown vor dem ersten Briefing-Call (1.5s) plus Telemetry-Dump in
//    Console + Progress-Log, wenn beide Backends versagt haben.

const LLM_MAX_CONCURRENCY = 3;
let __llmActiveCalls = 0;
const __llmWaitQueue = [];

function __llmAcquire() {
  if (__llmActiveCalls < LLM_MAX_CONCURRENCY) {
    __llmActiveCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => __llmWaitQueue.push(resolve));
}
function __llmRelease() {
  const next = __llmWaitQueue.shift();
  if (next) {
    // Slot wird direkt weitergereicht — Counter bleibt unverändert.
    next();
  } else {
    __llmActiveCalls = Math.max(0, __llmActiveCalls - 1);
  }
}

const LLM_TELEMETRY_CAP = 60;
const __llmTelemetry = [];
function pushLlmTelemetry(entry) {
  __llmTelemetry.push(entry);
  if (__llmTelemetry.length > LLM_TELEMETRY_CAP) {
    __llmTelemetry.splice(0, __llmTelemetry.length - LLM_TELEMETRY_CAP);
  }
}
function recentLlmTelemetry(n = 12) {
  return __llmTelemetry.slice(-n);
}
function formatLlmTelemetryLine(t) {
  const ts = new Date(t.startedAt).toISOString().slice(11, 23);
  const model = (t.model || '?').split('/').pop();
  const status = t.httpStatus || (t.error ? 'net' : '?');
  const err = t.error ? ` · err: ${String(t.error).slice(0, 80)}` : '';
  return `[${ts}] ${model} → HTTP ${status} · ${t.durationMs}ms · reply ${t.replyLen}c${err}`;
}
// Kurz-Summary für User-sichtbare Fehlermeldung: zählt HTTP-Stati der letzten
// n Calls und gibt z.B. "5× HTTP 200, 2× HTTP 429" zurück.
function summarizeLlmTelemetry(n = 8) {
  const recent = recentLlmTelemetry(n);
  if (!recent.length) return '';
  const counts = new Map();
  for (const e of recent) {
    const key = e.httpStatus || (e.error ? 'net' : '?');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v}× HTTP ${k}`)
    .join(', ');
}

// Issue 39: Hartes Client-Timeout pro LLM-Aufruf via AbortController. Davor
// hing der fetch unbegrenzt — bei aimlapi-Stalls (Verbindung offen, aber
// Antwort kommt nicht) blieb der Slot im __llmAcquire-Semaphor stundenlang
// belegt und blockierte alle weiteren Calls. 180s sind großzügig dimensioniert
// (vorher implizit ~30-60s je nach Browser/Plattform-Default): DeepSeek-V4-
// Flash braucht bei langen Briefing-Inputs durchaus 60-90s, plus aimlapi-
// Server-side-Queue-Wait — Worst-Case ~150s. Bei 180s greift der Abort nur
// wirklich, wenn der Stream tot ist; ein gesunder LLM-Call returnt sofort
// danach. Aborts gehen mit `err.message='aborted'`/`'timeout'` als
// transient-Klasse durch _briefingCall-Retry.
const LLM_REQUEST_TIMEOUT_MS = 180000;

// Zentraler LLM-Pfad mit Concurrency-Limit + Telemetry. Wird ausschließlich
// von api.llm aufgerufen — die Signatur passt 1:1 zum bisherigen Verhalten
// (Rückgabe ist das geparste JSON-Body, throw mit err.status bei HTTP-Fehler).
// Issue 42: Pfad wurde von `/api/tools/llm/chat` (tools-server-Proxy) auf
// den eigenen Direkt-Endpoint `/api/llm/chat` umgestellt. Der tools-server
// strippt provider-spezifische Tuning-Parameter und reicht ein festes
// max_tokens 1:1 durch, was Gemini 2.5 Flash (Reasoning-Modell, verbrennt
// 1500-2200 Tokens für internes Thinking) zu leeren/abgeschnittenen
// Antworten zwingt. `/api/llm/chat` spricht direkt mit aimlapi.com/v1
// (exakt wie das funktionierende User-Python-Snippet) und addiert für
// Gemini 2.5 Flash automatisch Reasoning-Headroom auf max_tokens. Die
// Antwort-Shape ist identisch: { reply, model, usage }.
async function __llmInvoke({ system, messages, temperature, max_tokens, model }) {
  await __llmAcquire();
  const startedAt = Date.now();
  let httpStatus = 0;
  let replyLen = 0;
  let errorMsg = null;
  // Issue 39: AbortController für Timeout — wird in `finally` mit clearTimeout
  // aufgeräumt, damit kein Timer-Leak entsteht.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => {
    try { ctrl.abort(); } catch { /* noop */ }
  }, LLM_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, messages, temperature, max_tokens, model }),
      signal: ctrl.signal,
    });
    httpStatus = res.status;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} — /llm/chat`);
      err.status = res.status;
      err.body = data;
      errorMsg = `HTTP ${res.status}`;
      throw err;
    }
    replyLen = data && typeof data.reply === 'string' ? data.reply.length : 0;
    return data;
  } catch (e) {
    // Issue 39: Abort → eindeutiger Timeout-Marker in der Telemetry, damit
    // _briefingCall den Aufruf als transient klassifizieren kann (Match auf
    // /failed|network|timeout|abort|fetch/ greift bereits — wir setzen die
    // Message hier nur konsistent, statt sich auf die Browser-spezifische
    // AbortError-Message zu verlassen).
    if (e && e.name === 'AbortError') {
      const ae = new Error(`LLM-Aufruf abgebrochen nach ${LLM_REQUEST_TIMEOUT_MS}ms (timeout)`);
      ae.name = 'AbortError';
      errorMsg = ae.message;
      throw ae;
    }
    if (!errorMsg) errorMsg = e && e.message ? e.message : String(e);
    throw e;
  } finally {
    clearTimeout(timeoutId);
    pushLlmTelemetry({
      startedAt,
      durationMs: Date.now() - startedAt,
      httpStatus,
      replyLen,
      model: model || '?',
      error: errorMsg,
    });
    __llmRelease();
  }
}

const LS = {
  feeds: 'wl:rssFeeds',
  interests: 'wl:userInterests',
  portfolio: 'wl:portfolio',
  cache: 'wl:newsCache',
  cacheMeta: 'wl:newsCacheMeta',
  stockHistory: 'wl:stockHistory',
  settings: 'wl:settings',
  searchSites: 'wl:searchSites',
  searchSitesMode: 'wl:searchSitesMode', // 'additional' | 'exclusive'
  // Issue 27: User-konfigurierbares Höchstalter für Webseiten- und YouTube-Quellen
  // (Optionen 1|3|5 Tage). Greifen bei Extraktion/Verarbeitung — Items außerhalb
  // werden verworfen. Defaults: 3 Tage (Webseiten), 3 Tage (YouTube).
  siteMaxAgeDays: 'wl:siteMaxAgeDays', // 1 | 3 | 5
  ytMaxAgeDays: 'wl:ytMaxAgeDays',     // 1 | 3 | 5
  // Issue 8
  userProfile: 'wl:userProfile',
  seenUrls: 'wl:seenUrls',     // url → first-seen ts (für novelty-Score)
  weatherCache: 'wl:weather',  // {lat,lng,fetchedAt,data}
  // Issue 10
  youtubeChannels: 'wl:youtubeChannels', // string[] (URLs)
  lastSummarizeAt: 'wl:lastSummarizeAt', // number (ms)
  // Issue 24
  llmBackend: 'wl:llmBackend',           // 'deepseek' | 'gemini'
  calendar: 'wl:calendar',               // [{id,title,date,time,location,notes,source,addedAt}]
  assistantHistory: 'wl:assistantHistory', // [{role,content}]
  // Issue 30: Multiplikator für die Länge des täglichen Briefings.
  // 1 = Standard (6-9 Absätze), 2 = doppelt, 3 = dreifach, 4 = vierfach,
  // 5 = fünffach (Issue 43). Wirkt auf composeBriefing (mehr Sätze pro
  // Absatz + höheres max_tokens) und auf buildFallbackBriefing (mehr Items
  // pro Rubrik aufgelistet).
  briefingLength: 'wl:briefingLength',   // '1' | '2' | '3' | '4' | '5'
};

// Issue 16: max. Rückblick-Fenster für YouTube-Videos (5 Tage). Pro Kanal
// wird das neueste Video genommen, das nicht älter als 5 Tage ist — die
// 5-Tage-Regel hat Vorrang vor `lastSummarizeAt` (ältere Videos werden auch
// geliefert, wenn der letzte Run jünger war, aber maximal 5 Tage zurück).
// War in Issue 10 noch 3 Tage + max(lastSummarizeAt, …) — zu restriktiv,
// die Rubrik blieb leer, wenn an „heute" noch kein neues Video erschienen war.
const YOUTUBE_MAX_LOOKBACK_MS = 5 * 24 * 3600 * 1000;
// Issue 10: max. Anzahl Transkripte pro Run (Transcript-API-Calls können
// throtteln, und die LLM-Sum-Calls kosten Tokens).
const YOUTUBE_MAX_VIDEOS_PER_RUN = 8;

// Issue 27: konfigurierbare Höchstalter für Webseiten- und YouTube-Items.
// User wählt 1|3|5 Tage im Setup. Wir klemmen Eingaben hart auf diese Werte;
// Defaults sind 3 Tage. Die Werte überschreiben den allgemeinen
// MAX_ARTICLE_AGE_DAYS-Cap (31) für Web/RSS/User-Sites bzw. das
// YOUTUBE_MAX_LOOKBACK_MS-Konzept für YouTube.
const ALLOWED_MAX_AGE_DAYS = [1, 3, 5];
const SITE_MAX_AGE_DAYS_DEFAULT = 3;
const YT_MAX_AGE_DAYS_DEFAULT = 3;
function getSiteMaxAgeDays() {
  const raw = parseInt(
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wl:siteMaxAgeDays') : null) || '',
    10
  );
  return ALLOWED_MAX_AGE_DAYS.includes(raw) ? raw : SITE_MAX_AGE_DAYS_DEFAULT;
}
function getSiteMaxAgeMs() { return getSiteMaxAgeDays() * 86400000; }
function getYtMaxAgeDays() {
  const raw = parseInt(
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wl:ytMaxAgeDays') : null) || '',
    10
  );
  return ALLOWED_MAX_AGE_DAYS.includes(raw) ? raw : YT_MAX_AGE_DAYS_DEFAULT;
}
function getYtMaxAgeMs() { return getYtMaxAgeDays() * 86400000; }
// Issue 27: liefert true, wenn ein Datum jenseits des User-konfigurierten
// Webseiten-Höchstalters liegt (1|3|5 Tage). Unbekanntes Datum → false
// (durchlassen, wie bei isArticleTooOld).
function isArticleTooOldForSites(dateInput) {
  if (!dateInput) return false;
  let d;
  try { d = new Date(dateInput); } catch { return false; }
  if (!d || isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) > getSiteMaxAgeMs();
}

// Issue 30/43: User-konfigurierbare Länge der täglichen Zusammenfassung.
// Faktor 1 = Standard, 2 = doppelt, 3 = dreifach, 4 = vierfach, 5 = fünffach
// (Issue 43 erweitert die ursprünglich auf 3× begrenzte Skala auf 5×). Wirkt
// auf composeBriefing (Prompt-Anweisung + max_tokens + mehr Items pro Rubrik
// im LLM-Input) und auf buildFallbackBriefing (mehr Items pro Aufzählung).
const ALLOWED_BRIEFING_LENGTH_FACTORS = [1, 2, 3, 4, 5];
const BRIEFING_LENGTH_DEFAULT = 1;
function getBriefingLengthFactor() {
  const raw = parseInt(
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wl:briefingLength') : null) || '',
    10
  );
  return ALLOWED_BRIEFING_LENGTH_FACTORS.includes(raw) ? raw : BRIEFING_LENGTH_DEFAULT;
}

// Issue 8: Tagesrubriken — feste Reihenfolge. "Top 5" wird bei der Anzeige
// nicht als Bucket gefüllt, sondern als Querschnitt der Rubriken.
// Issue 20: Top 5 zieht pro Rubrik den besten Treffer (je bester Artikel
// pro Rubrik, round-robin nachgefüllt) — vorher nahm es slice(0,5) auf den
// Gesamt-Score-Pool und produzierte damit Übersichtsseiten-Treffer.
const BUCKETS = [
  { id: 'events',   label: 'Events',          icon: '📅', emptyMsg: 'Keine relevanten Treffer' },
  { id: 'lokal',    label: 'Lokal',           icon: '🏠', emptyMsg: 'Keine relevanten Treffer' },
  // Issue 13: YouTube ist jetzt eine eigene Rubrik (vorher Badge in anderen).
  // Alle Items mit origin==='youtube' landen hier, unabhängig von Modul-Match.
  { id: 'youtube',  label: 'YouTube',         icon: '▶', emptyMsg: 'Keine relevanten Treffer' },
  { id: 'tech',     label: 'Tech / KI / Hardware', icon: '💻', emptyMsg: 'Keine relevanten Treffer' },
  { id: 'watchlist', label: 'Watchlist',       icon: '📈', emptyMsg: 'Keine relevanten Treffer' },
  { id: 'medizin',  label: 'Medizin',         icon: '⚕', emptyMsg: 'Keine relevanten Treffer' },
  { id: 'beobachten', label: 'Beobachten',    icon: '👁', emptyMsg: 'Keine relevanten Treffer' },
];
const BUCKET_IDS = BUCKETS.map((b) => b.id);

// Issue 8: Bekannte Qualitätsquellen für source_quality. Skala 0..1.
// Liste bewusst kurz — Whitelist von Qualitätsmedien & öff.-rechtl. Quellen,
// alles andere bekommt einen neutralen Default (0.5) oder erbt von User-Konfig
// (RSS/Search-Sites = 0.85).
const KNOWN_QUALITY_HOSTS = new Map([
  ['tagesschau.de', 0.95], ['zdf.de', 0.95], ['deutschlandfunk.de', 0.92],
  ['zeit.de', 0.9], ['sueddeutsche.de', 0.9], ['faz.net', 0.9], ['spiegel.de', 0.88],
  ['heise.de', 0.92], ['golem.de', 0.88], ['t3n.de', 0.8],
  ['nature.com', 0.96], ['science.org', 0.96], ['nejm.org', 0.96], ['bmj.com', 0.94],
  ['who.int', 0.94], ['rki.de', 0.94], ['bundesregierung.de', 0.9],
  ['reuters.com', 0.92], ['apnews.com', 0.92], ['bbc.com', 0.9], ['bbc.co.uk', 0.9],
  ['ft.com', 0.9], ['economist.com', 0.9], ['nytimes.com', 0.88], ['wsj.com', 0.88],
  ['theguardian.com', 0.86], ['arxiv.org', 0.9],
  ['arstechnica.com', 0.88], ['wired.com', 0.85], ['technologyreview.com', 0.9],
  ['eur-lex.europa.eu', 0.95], ['europa.eu', 0.9],
]);

// Issue 8: harte Distanz-Schwelle für Events laut Konzept.
const EVENT_MAX_KM = 20;

// Issue 9: Artikel-Höchstalter. Items in Web-Search & RSS, deren Datum
// parsebar UND älter als dieses Fenster ist, werden hart aus den Ergebnissen
// gefiltert. Bei unbekanntem Datum wird durchgelassen (DDG `time=m`-Filter
// fängt den Großteil schon serverseitig ab; Snippet-Date-Parsing ist
// best-effort und greift wenn DDG eine Datumszeile mitliefert).
const MAX_ARTICLE_AGE_DAYS = 31;
const MAX_ARTICLE_AGE_MS = MAX_ARTICLE_AGE_DAYS * 86400000;

const api = {
  async json(path, init = {}) {
    const res = await fetch(`${API_BASE}${path}`, init);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} — ${path}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  },

  rss(url) {
    return this.json(`/rss?url=${encodeURIComponent(url)}`);
  },

  search(query, { max = 10, time = null, region = 'de-de' } = {}) {
    const params = new URLSearchParams({ q: query, max_results: String(max), region });
    // Issue 9: Datumseingrenzung — Web-Suche nie weiter als 1 Monat zurück.
    // d/w/m sind strenger oder gleich; alles andere (y, null, …) wird auf "m" gehoben.
    const safeTime = ['d', 'w', 'm'].includes(time) ? time : 'm';
    params.set('time', safeTime);
    return this.json(`/tools/web/search?${params}`);
  },

  events({ location, when = '', q = '' }) {
    const params = new URLSearchParams({ location, when, q });
    return this.json(`/tools/events/search?${params}`);
  },

  // Trafilatura-Extract auf einer URL (für Event-Seiten-Scraping)
  webExtract(url) {
    return this.json(`/tools/web/extract?url=${encodeURIComponent(url)}`);
  },

  // Issue 6: Headless-Chromium-Render (Playwright) als Fallback für
  // JS-rendered Event-Portale (Eventbrite, Meetup, Stadt-Kalender), bei
  // denen Trafilatura praktisch leeren Text liefert.
  webRender(url, opts = {}) {
    const body = { url, wait_ms: 1500, timeout: 25, ...opts };
    return this.json('/tools/web/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  stocks(ticker, { range = '1mo', interval = '1d' } = {}) {
    const params = new URLSearchParams({ ticker, range, interval });
    return this.json(`/tools/stocks?${params}`);
  },

  llm({ system, messages, temperature = 0.4, max_tokens = 2200, model } = {}) {
    // Issue 24: Wenn der Aufrufer kein explizites Modell vorgibt, ziehen wir
    // das aktuell ausgewählte Backend (deepseek|gemini) aus LS — so wirkt
    // ein Backend-Switch im Setup-Tab sofort auf alle nachfolgenden Calls,
    // ohne dass die hunderte api.llm()-Stellen einzeln angepasst werden müssen.
    // Issue 35: Aufruf läuft jetzt durch __llmInvoke — globaler Concurrency-
    // Limiter (max 3 parallel) + Telemetry-Ringpuffer. Signatur unverändert.
    const chosen = model || currentLlmModel();
    return __llmInvoke({ system, messages, temperature, max_tokens, model: chosen });
  },

  // Issue 24: RAG-Endpoints (über den existierenden /api/tools/*-Proxy).
  ragIndex({ namespace, documents, upsert = true }) {
    return this.json('/tools/rag/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, documents, upsert }),
    });
  },
  ragQuery({ namespace, q, top_k = 6, where }) {
    const params = new URLSearchParams({ namespace, q, top_k: String(top_k) });
    if (where) params.set('where', typeof where === 'string' ? where : JSON.stringify(where));
    return this.json(`/tools/rag/query?${params}`);
  },

  // Issue 8: für Profil-Standorte und Event-Geokoordinaten
  geocode(q, countries = 'de,at,ch') {
    const params = new URLSearchParams({ q, countrycodes: countries });
    return this.json(`/tools/geocode?${params}`);
  },

  // Issue 8: Wetter-Rubrik
  weather(lat, lng, days = 3) {
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng), days: String(days) });
    return this.json(`/tools/weather?${params}`);
  },

  // Issue 10: YouTube — Channel-Auflösung & Video-Liste in einem Call,
  // Transkript separat (weil pro-Video aufgerufen, manche Videos haben keins).
  youtubeVideos(url, { sinceMs = 0, maxAgeMs = YOUTUBE_MAX_LOOKBACK_MS } = {}) {
    const params = new URLSearchParams({ url, sinceMs: String(sinceMs), maxAgeMs: String(maxAgeMs) });
    return this.json(`/youtube/videos?${params}`);
  },
  youtubeTranscript(videoId, lang = 'de,en') {
    const params = new URLSearchParams({ videoId, lang });
    return this.json(`/youtube/transcript?${params}`);
  },

  // Issue 38: PubMed-Studien-Suche via NCBI E-utilities. Backend (server.js)
  // proxiet auf esearch.fcgi + efetch.fcgi und liefert JSON mit Titel/Abstract/
  // Datum/Journal. `days` ist ein Pub-Date-Fenster (hartes Backend-Limit: 30
  // Tage, das Frontend gibt typischerweise siteMaxAgeDays = 1|3|5).
  pubmed(query, { max = 8, days = 7 } = {}) {
    const params = new URLSearchParams({ q: query, max: String(max), days: String(days) });
    return this.json(`/pubmed/search?${params}`);
  },

  async ocr(file) {
    const form = new FormData();
    form.append('file', file);
    form.append('lang', 'deu+eng');
    return this.json('/tools/ocr', { method: 'POST', body: form });
  },

  // Issue 21: TTS — gibt einen MP3-Blob für genau einen Text-Chunk zurück.
  // Der tools-server-Endpoint /speech/tts antwortet mit Audio-Binary (default
  // mp3 via aimlapi gpt-4o-mini-tts) — kein JSON, also nicht über .json().
  //
  // Issue 31: bei Text nahe am 4000-Zeichen-Limit wechselt aimlapi gelegentlich
  // in einen asynchronen Modus und liefert ein JSON `{detail:{audio:{url}}}`
  // statt der Audio-Bytes (HTTP 201, Content-Type application/json). Der
  // tools-server reicht das 1:1 durch — ohne dass die Frontend-Pipeline es
  // merkt, was vorher bei 2x/3x-Briefings dazu führte, dass Chunks mit Junk
  // (=JSON-Text als „MP3") in den Player-Stream landeten und der Player nach
  // dem ersten gültigen Chunk stoppte. Wir erkennen den JSON-Fall, folgen der
  // CDN-URL (CORS offen, geprüft) und liefern auch dann einen sauberen Blob.
  async tts(text, { voice = 'alloy', format = 'mp3', model, speed } = {}) {
    const body = { text, voice, format };
    if (model) body.model = model;
    if (speed) body.speed = speed;
    const res = await fetch(`${API_BASE}/tools/speech/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`TTS HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      // Async-URL-Fallback (Issue 31). aimlapi schickt z.B. HTTP 201 mit
      // {"detail":{"audio":{"url":"https://cdn.aimlapi.com/..."}}}.
      const json = await res.json().catch(() => null);
      const url = json && json.detail && json.detail.audio && json.detail.audio.url;
      if (!url) {
        throw new Error(`TTS JSON ohne audio.url: ${JSON.stringify(json || {}).slice(0, 200)}`);
      }
      const audioRes = await fetch(url);
      if (!audioRes.ok) throw new Error(`TTS CDN HTTP ${audioRes.status}`);
      return audioRes.blob();
    }
    return res.blob();
  },

  async extract(file) {
    const form = new FormData();
    form.append('file', file);
    return this.json('/tools/extract', { method: 'POST', body: form });
  },
};

// =============================================================================
// localStorage-Wrapper
// =============================================================================

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.warn('store.set failed', key, e); }
  },
  remove(key) { localStorage.removeItem(key); },
};

// =============================================================================
// Helpers
// =============================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtDate(input) {
  if (!input) return '';
  try {
    const d = typeof input === 'string' ? new Date(input) : input;
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs = now - d;
    const diffH = diffMs / 36e5;
    if (diffH < 1) return `vor ${Math.max(1, Math.round(diffH * 60))} min`;
    if (diffH < 24) return `vor ${Math.round(diffH)} h`;
    const diffD = Math.round(diffH / 24);
    if (diffD < 7) return `vor ${diffD} Tag${diffD === 1 ? '' : 'en'}`;
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' }).format(d);
  } catch { return ''; }
}

function sourceFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

// Issue 17: Domains, die in der Lokal-Rubrik nichts verloren haben.
// Vor Issue 17 schlug der LLM-Scorer Wetter-Vorhersagen, Instagram-Posts,
// Tourismus-/Stadtportale und Event-Aggregator-Listen als bucket=lokal vor
// (sobald der Stadt-Name im Titel auftauchte). Außerdem leitete
// `bucketizeItems` jedes scorer-`events`-Item bei positivem localityScore
// nach `lokal` um — was z.B. `konstanz-info.com/events` direkt in der
// Lokal-Karte landen ließ.  Diese Liste filtert genau diese Domain-
// Familien aus dem Lokal-Bucket raus.
const NON_LOCAL_NEWS_HOST_PATTERNS = [
  // Social Media
  /(^|\.)instagram\.com$/, /(^|\.)facebook\.com$/, /(^|\.)twitter\.com$/,
  /(^|\.)x\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)pinterest\./,
  /(^|\.)threads\.net$/, /(^|\.)linkedin\.com$/, /(^|\.)reddit\.com$/,
  /(^|\.)snapchat\.com$/,
  // Wetter / Vorhersage
  /^wetter\./, /(^|\.)wetter\.com$/, /(^|\.)wetter\.de$/,
  /(^|\.)wetteronline\.de$/, /(^|\.)weather\.com$/,
  /(^|\.)kachelmannwetter\.com$/, /(^|\.)foreca\./,
  /(^|\.)meteoblue\.com$/, /(^|\.)windy\.com$/,
  // Tourismus / Stadt-SPA-Portale (SPAs ohne SSR — Issue 13 Caveat)
  /-info\.com$/, /-info\.de$/,
  /(^|\.)tourismus\./, /(^|\.)tourist-information\./,
  /(^|\.)visit-/, /(^|\.)visit[a-z-]+\.(com|de)$/,
  // Event-Aggregatoren (die Events-Rubrik wird separat befüllt)
  /(^|\.)eventbrite\./, /(^|\.)meetup\.com$/, /(^|\.)eventfrog\./,
  /(^|\.)eventfinder\./, /(^|\.)regioactive\./, /(^|\.)bandsintown\.com$/,
  /(^|\.)songkick\.com$/,
  // Issue 19: weitere Event-Übersichts-Portale, die als „Lokal-Treffer"
  // durchschlüpfen konnten (z.B. veranstaltungen.meinestadt.de/konstanz/alle/
  // alle — kommt bei „Lokalnachrichten <Stadt>" oft auf Seite 1, weil es
  // den Stadt-Namen im URL-Pfad führt). Generisch via Sub-Domain-Prefix
  // + meinestadt-Hostname.
  /^veranstaltungen\./, /^events\./, /^termine\./, /^kalender\./,
  /(^|\.)meinestadt\.de$/, /(^|\.)stadt-leben\./,
  // Karten, Booking, Reise — keine Nachrichten
  /(^|\.)booking\.com$/, /(^|\.)tripadvisor\./,
  /(^|\.)holidaycheck\./, /(^|\.)hrs\.de$/, /(^|\.)airbnb\./,
  /(^|\.)google\.com\/maps/, /(^|\.)maps\.google\./,
  // Wikis & Reise-Wikis
  /(^|\.)wikipedia\.org$/, /(^|\.)wikivoyage\.org$/,
];
function isNonLocalNewsHost(url) {
  if (!url) return false;
  const host = (sourceFromUrl(url) || '').toLowerCase();
  if (!host) return false;
  return NON_LOCAL_NEWS_HOST_PATTERNS.some((re) => re.test(host));
}

// Issue 17: Heuristik für „dieses Item ist eine Wetter-Vorhersage" — auch
// wenn die Domain nicht auf der Blacklist steht (z.B. eine Lokalzeitung
// kann eine Wetter-Sub-Seite haben). Greift bei eindeutigen Wetter-Begriffen
// im Titel oder Vorhersage-typischen Mustern im Snippet (°C, mm
// Niederschlag, „7-Tage", „Stundenvorhersage").
const WEATHER_TITLE_RE = /\b(wetter|wettervorhersage|wetterbericht|temperaturen?|niederschlag|regen(?:wetter)?|sonnenstunden|schneehöhe|17-tage|14-tage|7-tage|stundenvorhersage|wochenend(?:e|wetter)|wetter(?:prognose|trend))\b/i;
const WEATHER_SNIPPET_RE = /(\b\d{1,2}\s*°\s*c\b|grad celsius|mm niederschlag|niederschlagsmenge|sonnenscheindauer|aktuelles wetter|wetter heute|wetter (?:morgen|am wochenende))/i;
function looksLikeWeatherItem(item) {
  if (!item) return false;
  if (WEATHER_TITLE_RE.test(item.title || '')) return true;
  if (WEATHER_SNIPPET_RE.test(item.snippet || '')) return true;
  return false;
}

// Issue 13: DuckDuckGo liefert für manche Seiten den nackten URL-Pfad statt
// einer echten Headline als `title` (z.B. "konstanz-info.com/planen-buchen/
// top-events"). Solche Titel sind in der UI nutzlos — wir erkennen sie an
// (a) keine Whitespaces, (b) startet mit Hostname-Pattern (`xxx.tld/…` oder
// nur Pfad mit Slashes). Bei Hit ersetzen wir den Titel: 1. Wahl ist der
// erste vollständige Satz aus dem Snippet, 2. Wahl die titelcased-Form des
// letzten Pfadsegments. Sonst bleibt der Original-Titel.
function looksLikeUrlTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const t = title.trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;             // hat Leerzeichen → echte Headline
  // Hostname.tld/... oder reiner /pfad/...-Stil
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\/[^\s]*/i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+){1,}/i.test(t)) return true;
  return false;
}

function titleFromPath(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    const cleaned = last.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').trim();
    if (!cleaned) return '';
    return cleaned.replace(/\b(\w)/g, (c) => c.toUpperCase());
  } catch { return ''; }
}

function firstSentence(snippet, maxLen = 160) {
  if (!snippet) return '';
  const s = String(snippet).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^[^.!?\n]{4,}?[.!?](?:\s|$)/);
  const candidate = (m ? m[0] : s).trim().replace(/[.!?]$/, '');
  return candidate.length > maxLen ? candidate.slice(0, maxLen - 1) + '…' : candidate;
}

function sanitizeItemTitle(item) {
  if (!item || !looksLikeUrlTitle(item.title)) return item;
  const replacement = firstSentence(item.snippet) || titleFromPath(item.url) || sourceFromUrl(item.url);
  if (replacement && replacement !== item.title) {
    item.title = replacement;
  }
  return item;
}

// Issue 7: Wenn der User eine bestimmte Webseite explizit als Quelle angegeben
// hat (RSS-Feed-Host oder „Suche auf diesen Webseiten"), wollen wir in der UI
// den vollen Link mit Pfad anzeigen statt auf die nackte Domain zu kürzen —
// damit man z.B. bei `meine-lokalzeitung.de` sofort sieht, ob ein Artikel aus
// `/sport/` oder `/lokales/` kommt. Andere Quellen bleiben auf Domain-Ebene,
// sonst wird die Anzeige zu unruhig.
function getUserSiteHosts() {
  // Issue 23: searchSites enthält jetzt komplette URLs — Hostnames per
  // Helper extrahieren. Backwards-compat: alte Caches mit reinen Hostnames
  // werden vom Helper ebenfalls korrekt behandelt.
  const explicit = searchSitesToHosts(store.get(LS.searchSites, []) || []);
  const feeds = store.get(LS.feeds, []) || [];
  const feedHosts = [];
  for (const u of feeds) {
    try {
      feedHosts.push(new URL(u).hostname.replace(/^www\./, '').toLowerCase());
    } catch { /* ignore — Feed kann später kommen */ }
  }
  return new Set([...explicit, ...feedHosts]);
}

function displaySource(url, userHosts) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const hosts = userHosts || getUserSiteHosts();
    if (!hosts.has(host)) return host;
    // User hat diese Seite explizit als Quelle konfiguriert → vollständiger
    // Pfad bleibt erhalten. Query-String/Fragment lassen wir weg, damit
    // Tracking-Parameter (utm_…, fbclid, …) nicht im Source-Label landen.
    let path = u.pathname || '';
    if (path && path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
    if (!path || path === '/') return host;
    return host + path;
  } catch {
    return sourceFromUrl(url);
  }
}

// Issue 8: harter Fenster-Default jetzt 7 Tage (heute … +7), passend zum
// Konzept-Crawler ("Hartfilter ≤20 km, +7 Tage"). Vorher 21 Tage (Issue 6),
// jetzt zurückgenommen — Begründung: bei 7 Tagen wird die UX merklich
// präziser ("was passiert diese Woche?"), und der Distanz-Filter sortiert
// jetzt zusätzlich Listings raus, die früher mit dem 21-Tage-Fenster
// reingerutscht sind.
// UTC-Berechnung damit Datums-Strings auch über Mitternacht / DST-Wechsel
// hinweg deterministisch bleiben (wir vergleichen mit YYYY-MM-DD-Strings
// aus dem LLM).
const EVENT_WINDOW_DAYS = 7;

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function eventWindow(days = EVENT_WINDOW_DAYS) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return { start: isoDay(start), end: isoDay(end), days };
}

function toast(message, kind = 'info', ms = 3200) {
  const el = $('#toast');
  const content = $('#toast-content');
  if (!el || !content) return;
  const color = kind === 'error' ? 'border-rose-500/50 text-rose-200'
              : kind === 'success' ? 'border-emerald-500/50 text-emerald-200'
              : 'border-white/10 text-slate-100';
  content.className = `rounded-xl bg-ink-700 border ${color} shadow-lg px-4 py-3 text-sm`;
  content.textContent = message;
  el.classList.add('show');
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hidden');
  }, ms);
}

function setProgress(text, logLine = null, done = false) {
  const wrap = $('#progress');
  const txt = $('#progress-text');
  const log = $('#progress-log');
  if (done) {
    setTimeout(() => wrap.classList.add('hidden'), 600);
    return;
  }
  wrap.classList.remove('hidden');
  if (text) txt.textContent = text;
  if (logLine) {
    const li = document.createElement('li');
    li.textContent = `· ${logLine}`;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }
}

function clearProgressLog() { $('#progress-log').innerHTML = ''; }

function parseFeedsTextarea(text) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .filter((s, i, arr) => arr.indexOf(s) === i); // dedupe
}

// Parsed eine Liste aus dem "Suche auf diesen Webseiten"-Textfeld.
// Issue 23: URLs werden UNVERÄNDERT übernommen (vorher wurden sie auf
// nackte Hostnames gekürzt). Der User trägt jetzt komplette Webseiten-URLs
// ein (z.B. `https://www.suedkurier.de/region/konstanz/`), die für den
// Playwright-/Trafilatura-Crawl-Pfad (siehe crawlUserSites) genutzt werden.
// Für den DDG-`site:`-Operator extrahieren `searchSitesToHosts` /
// `buildSiteOperator` daraus zur Laufzeit den Hostnamen.
// Wir validieren nur leicht (URL muss parsebar sein, Schema ergänzen wenn
// fehlt) — der Original-String wird beibehalten, wenn er bereits ein Schema
// hat; sonst wird `https://` davorgesetzt, damit der String später parsebar
// bleibt.
function parseSearchSites(text) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => {
      const candidate = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
      try {
        // Smoke-Test: URL muss parsebar sein und einen Hostnamen mit Punkt
        // haben. Sonst rauswerfen (kein .tld → wahrscheinlich Tippfehler).
        const u = new URL(candidate);
        if (!u.hostname || !u.hostname.includes('.')) return '';
        return candidate;
      } catch {
        return '';
      }
    })
    .filter((s) => !!s)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

// Issue 23: Helper — aus der Liste der User-Webseiten-URLs die reinen
// Hostnames extrahieren (für DDG `site:`-Operator und Display-Source-Match).
function searchSitesToHosts(sites) {
  const out = [];
  const seen = new Set();
  for (const s of (sites || [])) {
    if (!s) continue;
    try {
      const host = new URL(s).hostname.replace(/^www\./, '').toLowerCase();
      if (host && !seen.has(host)) { seen.add(host); out.push(host); }
    } catch {
      // Letzter Versuch: rohe Regex (greift bei alten Cache-Einträgen, die
      // vor Issue 23 schon als Hostname statt URL gespeichert wurden).
      const m = String(s).toLowerCase().match(/[a-z0-9.-]+\.[a-z]{2,}/);
      if (m && !seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
    }
  }
  return out;
}

// Baut für DDG einen `(site:a.com OR site:b.com OR …)`-Block (für ≥2 Sites)
// oder ein einfaches `site:a.com` (bei genau 1).
// Issue 23: nimmt jetzt User-Site-URLs entgegen (vorher schon gekürzte Hosts)
// und extrahiert die Hostnames intern.
function buildSiteOperator(sites) {
  const hosts = searchSitesToHosts(sites);
  if (!hosts.length) return '';
  if (hosts.length === 1) return `site:${hosts[0]}`;
  return '(' + hosts.map((s) => `site:${s}`).join(' OR ') + ')';
}

function safeJsonExtract(s) {
  if (!s || typeof s !== 'string') return null;
  // Remove Markdown code fences
  let cleaned = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // Try full parse first
  try { return JSON.parse(cleaned); } catch {}
  // Fall back: find first {...} or [...] block (balanced bracket scan)
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = cleaned.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    // Issue 15: YouTube-Watch-URLs tragen die Video-ID im Query-String
    // (?v=ABC). Der generische `?…`-Strip unten würde ALLE Videos auf den
    // gleichen Key `https://www.youtube.com/watch` kollabieren — Folge: pro
    // Run überlebt nur EIN Video die Dedupe, der Rest fliegt raus. YouTube-
    // Items haben ihre videoId schon mit, also nehmen wir sie direkt als Key.
    let key;
    if (it.origin === 'youtube' && it.ytVideoId) {
      key = `yt:${it.ytVideoId}`;
    } else {
      key = (it.url || it.link || '').replace(/\?.*$/, '').replace(/\/+$/, '');
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// =============================================================================
// Issue 8 — Profil & Scoring-Helper
// =============================================================================

// FNV-1a-ähnlicher 32-bit-Hash, nur als Change-Detector für den Interessen-
// Freitext (haben wir den Text seit der letzten Profil-Generierung verändert?).
// Kein kryptographisch starker Hash nötig — Kollisionen sind im worst case
// "Profil wurde nicht neu generiert", was über den UI-Button manuell
// nachzuholen ist.
function textHash(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// Stellt sicher, dass ein Profil alle Felder hat (auch alte / unvollständige
// Profile aus älteren Versionen). Verändert das übergebene Objekt nicht.
function inflateProfile(p) {
  p = p || {};
  return {
    generatedAt: p.generatedAt || 0,
    rawTextHash: p.rawTextHash || '',
    rawText: p.rawText || '',
    age: typeof p.age === 'number' ? p.age : null,
    profession: typeof p.profession === 'string' ? p.profession : '',
    languages: Array.isArray(p.languages) ? p.languages : ['de'],
    locations: Array.isArray(p.locations) ? p.locations.map((l) => ({
      name: String(l.name || '').trim(),
      lat: typeof l.lat === 'number' ? l.lat : null,
      lng: typeof l.lng === 'number' ? l.lng : null,
      radiusKm: typeof l.radiusKm === 'number' ? l.radiusKm : 20,
      weight: typeof l.weight === 'number' ? l.weight : 1,
      geocodeFailed: !!l.geocodeFailed,
    })).filter((l) => l.name) : [],
    modules: Array.isArray(p.modules) ? p.modules.map((m) => ({
      id: String(m.id || ''),
      label: String(m.label || m.id || ''),
      keywords: Array.isArray(m.keywords) ? m.keywords.map(String).filter(Boolean) : [],
      weight: typeof m.weight === 'number' ? m.weight : 1,
      sourceTypes: Array.isArray(m.sourceTypes) ? m.sourceTypes.map(String) : [],
    })).filter((m) => m.id) : [],
    negativeFilters: Array.isArray(p.negativeFilters) ? p.negativeFilters.map(String).filter(Boolean) : [],
    watchlist: Array.isArray(p.watchlist) ? p.watchlist.map(String).filter(Boolean) : [],
    discoveredSources: Array.isArray(p.discoveredSources) ? p.discoveredSources.map(String).filter(Boolean) : [],
    bucketHints: p.bucketHints || {},
    // Issue 23: Vorab-Klassifikation der manuell eingetragenen Webseiten —
    // wird beim Profil-Generieren erzeugt, indem jede URL via Playwright
    // gecrawlt und der Inhalt per LLM in eine der vier Kategorien sortiert
    // wird: "lokalnachricht" | "lokal_event" | "wetter" | "andere".
    // Map { [url]: { category, reason, title, fetchedAt } }.
    siteClassifications: p.siteClassifications && typeof p.siteClassifications === 'object'
      ? p.siteClassifications
      : {},
  };
}

// Haversine-Distanz in km zwischen zwei lat/lng-Paaren.
function haversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Source-Quality 0..1. Whitelist > User-Konfig > neutraler Default.
function sourceQualityFor(url, userHosts) {
  const host = sourceFromUrl(url);
  if (!host) return 0.4;
  if (KNOWN_QUALITY_HOSTS.has(host)) return KNOWN_QUALITY_HOSTS.get(host);
  // Sub-Domain (z.B. blog.zeit.de) → Hauptdomain prüfen
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const sub = parts.slice(i).join('.');
    if (KNOWN_QUALITY_HOSTS.has(sub)) return KNOWN_QUALITY_HOSTS.get(sub) * 0.95;
  }
  if (userHosts && userHosts.has(host)) return 0.85;
  // Sehr typische SEO-/Aggregator-Endungen → leicht gedrückt
  if (/\.(blogspot|wordpress|medium|substack)\./.test(host) || /^news\d*\./.test(host)) return 0.45;
  return 0.55;
}

// Freshness 0..1, basierend auf ISO-Datum oder ms-Timestamp.
// Issue 22: deutlich steilere Kurve — Aktualität wird stärker gewichtet, damit
// Nachrichten/YouTube-Items vom heutigen/gestrigen Tag konsequent oben stehen
// und Artikel >1 Woche merklich abrutschen. Unbekanntes Datum → 0.3 (vorher
// 0.4) — wir wollen Items mit erkennbarem aktuellem Datum bevorzugen.
function freshnessScore(input) {
  if (!input) return 0.3;
  let d;
  try { d = typeof input === 'string' ? new Date(input) : new Date(input); } catch { return 0.3; }
  if (!d || isNaN(d.getTime())) return 0.3;
  const hours = (Date.now() - d.getTime()) / 36e5;
  if (hours < 0) return 0.9;          // Zukunfts-Datum (Events): hoch werten
  if (hours <= 12) return 1;
  if (hours <= 24) return 0.95;
  if (hours <= 48) return 0.85;
  if (hours <= 72) return 0.7;        // 3 Tage
  if (hours <= 24 * 7) return 0.45;   // 1 Woche
  if (hours <= 24 * 14) return 0.25;  // 2 Wochen
  if (hours <= 24 * 30) return 0.10;  // 1 Monat
  return 0.05;
}

// Issue 9: Best-Effort-Parser für Datums-Präfixe in DDG-Snippets.
// Issue 11: Suche nicht mehr nur am Anfang — DDG hängt das Datum mal vorn an
// ("2 days ago · …"), mal mittendrin ("Posted on Apr 22, 2026"), mal gar nicht
// (Beispiel-Bug: Spiegel-Artikel von 2017, Snippet pur thematisch, kein Datum).
// Wir scannen jetzt die ersten ~240 Zeichen, akzeptieren Treffer am Wort-Anfang
// (oder direkt nach DDG-Separatoren wie · | -), und der Aufrufer kombiniert das
// Ergebnis mit URL-Parsing + Trafilatura-Fallback (siehe detectArticleDate /
// verifyWebItemDates unten).
const _MONTH_EN = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const _MONTH_DE = { januar: 0, februar: 1, märz: 2, maerz: 2, april: 3, mai: 4, juni: 5, juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11 };
// Begrenzung: Datum muss plausibel sein (Jahr zwischen 2000 und next-year).
const _MIN_YEAR = 2000;
function _validYear(y) { return y >= _MIN_YEAR && y <= (new Date().getUTCFullYear() + 1); }
function _validMonth(m) { return m >= 1 && m <= 12; }
function _validDay(d) { return d >= 1 && d <= 31; }
// Wort-Anfang oder direkt nach DDG-Separatoren — verhindert, dass wir mitten
// in einer Zahl/URL einen Treffer landen.
const _LB = '(?:^|[\\s·\\|\\-–—\\(\\[,/])';
function parseSnippetDate(snippet) {
  if (!snippet || typeof snippet !== 'string') return null;
  const s = snippet.slice(0, 240);
  if (!s.trim()) return null;
  // ISO: 2017-04-12
  const iso = s.match(new RegExp(`${_LB}(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`));
  if (iso && _validYear(+iso[1]) && _validMonth(+iso[2]) && _validDay(+iso[3])) {
    return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  }
  // EN relativ: "2 days ago"
  const enRel = s.match(/\b(\d{1,3})\s+(minute|hour|day|week|month|year)s?\s+ago\b/i);
  if (enRel) {
    const n = parseInt(enRel[1], 10);
    const unit = enRel[2].toLowerCase();
    const mult = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }[unit];
    return new Date(Date.now() - n * mult);
  }
  // DE relativ: "vor 2 Tagen"
  const deRel = s.match(/\bvor\s+(\d{1,3})\s+(minute(?:n)?|stunde(?:n)?|tag(?:en|e)?|woche(?:n)?|monat(?:en|e)?|jahr(?:en|e)?)\b/i);
  if (deRel) {
    const n = parseInt(deRel[1], 10);
    const u = deRel[2].toLowerCase();
    let ms;
    if (u.startsWith('minute')) ms = 60000;
    else if (u.startsWith('stunde')) ms = 3600000;
    else if (u.startsWith('tag')) ms = 86400000;
    else if (u.startsWith('woche')) ms = 604800000;
    else if (u.startsWith('monat')) ms = 2592000000;
    else ms = 31536000000;
    return new Date(Date.now() - n * ms);
  }
  // EN absolut: "Apr 22, 2026" / "April 22, 2026"
  const enAbs = s.match(new RegExp(`${_LB}([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),\\s+(\\d{4})\\b`));
  if (enAbs) {
    const m = _MONTH_EN[enAbs[1].slice(0, 3).toLowerCase()];
    const y = +enAbs[3], d = +enAbs[2];
    if (m != null && _validYear(y) && _validDay(d)) return new Date(Date.UTC(y, m, d));
  }
  // EN absolut umgedreht: "22 Apr 2026"
  const enAbs2 = s.match(new RegExp(`${_LB}(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?\\s+(\\d{4})\\b`));
  if (enAbs2) {
    const m = _MONTH_EN[enAbs2[2].slice(0, 3).toLowerCase()];
    const y = +enAbs2[3], d = +enAbs2[1];
    if (m != null && _validYear(y) && _validDay(d)) return new Date(Date.UTC(y, m, d));
  }
  // DE absolut: "22. April 2026"
  const deAbs = s.match(new RegExp(`${_LB}(\\d{1,2})\\.\\s*([A-Za-zäöüÄÖÜ]{3,9})\\s+(\\d{4})\\b`));
  if (deAbs) {
    const m = _MONTH_DE[deAbs[2].toLowerCase()];
    const y = +deAbs[3], d = +deAbs[1];
    if (m != null && _validYear(y) && _validDay(d)) return new Date(Date.UTC(y, m, d));
  }
  // DE numerisch: "22.04.2026" oder "22.4.26" (2-stelliges Jahr → 20xx)
  const deNum = s.match(new RegExp(`${_LB}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{2,4})\\b`));
  if (deNum) {
    const d = +deNum[1], mo = +deNum[2];
    let y = +deNum[3];
    if (y < 100) y += 2000;
    if (_validYear(y) && _validMonth(mo) && _validDay(d)) return new Date(Date.UTC(y, mo - 1, d));
  }
  return null;
}

// Issue 11: Datum aus dem URL-Pfad ziehen. Viele Nachrichtenseiten codieren
// die Veröffentlichung in den URL-Pfad (z.B. /2017/04/12/, /2017-04/,
// /2017-04-12-…). Wir suchen ausschließlich im Pfad — Query-String/Host
// können willkürlich Zahlen enthalten. Tag fehlt? → Monatsmitte als Annäherung.
function parseUrlDate(url) {
  if (!url || typeof url !== 'string') return null;
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  if (!path) return null;
  // /YYYY/MM/DD/ oder /YYYY-MM-DD/
  let m = path.match(/\/(\d{4})[\/_-](\d{1,2})[\/_-](\d{1,2})(?:\/|[\-_]|$)/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (_validYear(y) && _validMonth(mo) && _validDay(d)) return new Date(Date.UTC(y, mo - 1, d));
  }
  // /YYYY/MM/ oder /YYYY-MM/ (Tag unbekannt → 15.)
  m = path.match(/\/(\d{4})[\/_-](\d{1,2})(?:\/|[\-_]|$)/);
  if (m) {
    const y = +m[1], mo = +m[2];
    if (_validYear(y) && _validMonth(mo)) return new Date(Date.UTC(y, mo - 1, 15));
  }
  // /YYYY/ — letzter Strohhalm; nur akzeptieren wenn das Segment für sich
  // steht (z.B. /archiv/2017/), nicht wenn es Teil einer ID ist.
  m = path.match(/\/(\d{4})\//);
  if (m) {
    const y = +m[1];
    if (_validYear(y)) return new Date(Date.UTC(y, 5, 30)); // Jahresmitte
  }
  return null;
}

// Issue 11: Kombiniert Snippet- und URL-Parser. Snippet hat Vorrang (genauer).
function detectArticleDate({ snippet, url }) {
  const fromSnippet = parseSnippetDate(snippet || '');
  if (fromSnippet) return fromSnippet;
  return parseUrlDate(url || '');
}

// Issue 9: liefert true, wenn ein bekanntes Datum jenseits des Höchstalters
// liegt. Unbekanntes/unleserliches Datum → false (durchlassen).
function isArticleTooOld(dateInput) {
  if (!dateInput) return false;
  let d;
  try { d = new Date(dateInput); } catch { return false; }
  if (!d || isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) > MAX_ARTICLE_AGE_MS;
}

// Issue 11: Backstop für Web-Items ohne erkennbares Datum — fragt Trafilatura
// (`/tools/web/extract`) den Artikel ab und liest das `date`-Feld. Concurrency
// gekappt, damit der Tools-Server nicht überfahren wird. Items mit Datum > 31
// Tage werden aus dem Array entfernt; Items ohne erkennbares Datum (Fehler,
// kein Date-Feld) bleiben drin (graceful: best-effort).
// Rückgabe: { kept, dropped, verified } — `kept` ersetzt das übergebene Array.
async function verifyWebItemDates(items, { concurrency = 6, onProgress } = {}) {
  if (!items || !items.length) return { kept: items || [], dropped: 0, verified: 0 };
  const todo = items.map((it, idx) => ({ idx, item: it }));
  const dropIdx = new Set();
  let verified = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const my = todo[cursor++];
      if (!my) break;
      try {
        const data = await api.webExtract(my.item.url);
        const rawDate = data && data.date;
        if (rawDate) {
          // Trafilatura liefert i.d.R. YYYY-MM-DD; selten ISO mit Zeit.
          const d = new Date(rawDate.length === 10 ? `${rawDate}T00:00:00Z` : rawDate);
          if (!isNaN(d.getTime())) {
            verified++;
            // Issue 27: hartes User-Höchstalter (1|3|5 Tage) — strenger als
            // die alte 31-Tage-Grenze.
            if (isArticleTooOldForSites(d)) {
              dropIdx.add(my.idx);
            } else {
              my.item.date = d.toISOString();
            }
          }
        }
      } catch { /* still skip — unbekanntes Datum, Item bleibt drin */ }
      if (onProgress) onProgress(cursor, todo.length);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, todo.length) }, () => worker());
  await Promise.all(workers);
  const kept = items.filter((_, i) => !dropIdx.has(i));
  return { kept, dropped: dropIdx.size, verified };
}

// Asset-Relevance: Portfolio-Symbol oder Name im Text → 1; sonst 0.
function assetRelevanceScore(item, portfolio) {
  if (!portfolio || !portfolio.length) return 0;
  const hay = ((item.title || '') + ' ' + (item.snippet || '')).toLowerCase();
  for (const p of portfolio) {
    const sym = (p.symbol || '').toLowerCase().replace(/\.[a-z]+$/i, '');
    const name = (p.name || '').toLowerCase();
    if (sym && sym.length >= 2 && new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)) return 1;
    if (name && name.length >= 4 && hay.includes(name)) return 1;
  }
  return 0;
}

// Locality 0..1: gewichteter Match auf User-Location-Namen im Text.
// Wenn ein User-Location-Name (Konstanz, Friedrichshafen, …) in Title/Snippet
// auftaucht, gilt das als lokales Item — gewichtet mit `weight` der Location.
function localityScore(item, profile) {
  if (!profile || !profile.locations.length) return 0;
  const hay = ((item.title || '') + ' ' + (item.snippet || '')).toLowerCase();
  let best = 0;
  for (const loc of profile.locations) {
    const name = (loc.name || '').toLowerCase();
    if (!name || name.length < 3) continue;
    const first = name.split(/[\s,]/)[0];
    if (first && hay.includes(first)) {
      best = Math.max(best, Math.min(1, loc.weight));
    }
  }
  return best;
}

// Novelty 0..1: 1 wenn URL noch nicht in `seenUrls` ist, sonst abklingend
// nach Tagen seit erstem Sehen (frische URLs auch nach Wieder-Sehen noch
// teilweise wertvoll, alte Wiederholungen kaum).
function noveltyScore(url, seenUrls) {
  if (!url) return 0.5;
  const seen = seenUrls && seenUrls[url];
  if (!seen) return 1;
  const days = (Date.now() - seen) / 86400000;
  if (days >= 7) return 0.5;
  return Math.max(0, 1 - days / 14);
}

// Gewichtete Komponenten laut Issue 8 (Hybrid-Scoring).
// Issue 22: freshness wurde von 0.05 → 0.18 angehoben (höchste Komponente nach
// interest_match), die übrigen Gewichte wurden proportional reduziert. Damit
// landen tagesaktuelle Nachrichten/YouTube-Transkripte konsequent oben statt
// 7-30-Tage-alter Übersichtsartikel — Konzept Issue 22 "Stärkere Gewichtung
// der Aktualität". Summe weiter = 1.0.
const SCORE_WEIGHTS = {
  locality: 0.20,
  interest_match: 0.20,
  freshness: 0.18,
  novelty: 0.12,
  actionability: 0.12,
  source_quality: 0.08,
  asset_relevance: 0.10,
};

// Issue 32: Primärschlüssel für News-Sortierung. Pro Item ist scoreSum =
// interestScore + affectednessScore (jeweils 1..10, also Summe 2..20). Für
// Items aus älteren Caches ohne diese Felder (oder aus Extraktoren, die
// scoreSum nicht setzen) wird die alte relevance-Skala (0..10) als 2× hochs-
// kalierter Fallback verwendet — damit bleibt die Sortierreihenfolge konsistent
// mit der vorherigen Skala.
function itemSortKey(it) {
  if (it && typeof it.scoreSum === 'number') return it.scoreSum;
  if (it && typeof it.relevance === 'number') return it.relevance * 2;
  return 0;
}

// Sammelt die berechneten Score-Komponenten zu einem Gesamtscore 0..1.
// noise_penalty (0..0.5) wird subtrahiert; das Ergebnis wird auf [0, 1]
// gedeckelt — siehe Konzept ("gedeckelt 0–0.5" bezieht sich auf den Penalty,
// nicht auf den Score).
function combineScore(components, noisePenalty) {
  let s = 0;
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) {
    s += w * Math.max(0, Math.min(1, components[k] || 0));
  }
  s -= Math.max(0, Math.min(0.5, noisePenalty || 0));
  return Math.max(0, Math.min(1, s));
}

// Heuristik-Fallback, falls die LLM keinen Bucket setzt. Geht ALLE Module
// durch und nimmt das mit dem stärksten Keyword-Match; mappt auf eine der
// festen Rubriken.
const MODULE_TO_BUCKET = {
  local_events: 'events',
  events: 'events',
  local_life: 'lokal',
  lokal: 'lokal',
  property_owner: 'lokal',
  professional_tech: 'tech',
  tech: 'tech',
  ki: 'tech',
  ai: 'tech',
  investor_watchlist: 'watchlist',
  finance: 'watchlist',
  watchlist: 'watchlist',
  health_watch: 'medizin',
  health: 'medizin',
  medizin: 'medizin',
};
function pickBucketHeuristic(item, profile) {
  // Issue 13: YouTube-Items haben ihre eigene Rubrik — Heuristik überspringt
  // die Modul-Match-Logik, sonst landen Tech-Videos im Tech-Bucket statt YouTube.
  if (item && item.origin === 'youtube') return 'youtube';
  const hay = ((item.title || '') + ' ' + (item.snippet || '')).toLowerCase();
  let bestId = null, bestHits = 0;
  for (const m of (profile.modules || [])) {
    let hits = 0;
    for (const kw of (m.keywords || [])) {
      const k = String(kw).toLowerCase();
      if (k.length >= 3 && hay.includes(k)) hits++;
    }
    if (hits > bestHits) { bestHits = hits; bestId = m.id; }
  }
  if (bestId) {
    const mapped = MODULE_TO_BUCKET[bestId.toLowerCase()];
    // Issue 12: heuristisch NIE auf `events` mappen — die Rubrik ist exklusiv
    // dem konkreten Event-Extraktor vorbehalten (bucketizeItems re-routet
    // alles andere nach lokal/beobachten).
    if (mapped && mapped !== 'events') return mapped;
  }
  if (assetRelevanceScore(item, store.get(LS.portfolio, []))) return 'watchlist';
  if (localityScore(item, profile) > 0) return 'lokal';
  return 'beobachten';
}

// Validiert den vom LLM gelieferten bucket-String gegen die feste Liste.
function normalizeBucket(b) {
  if (typeof b !== 'string') return null;
  const lower = b.toLowerCase().trim();
  if (BUCKET_IDS.includes(lower)) return lower;
  if (MODULE_TO_BUCKET[lower]) return MODULE_TO_BUCKET[lower];
  // Toleranter Match — z.B. „Lokal-Konstanz" → lokal
  for (const id of BUCKET_IDS) if (lower.startsWith(id)) return id;
  return null;
}

// =============================================================================
// Issue 8 — Profil-Generierung (LLM aus Freitext)
// =============================================================================

// Erkennt Triggerwörter im Interessen-Freitext, die typischerweise auf eine
// gesundheitliche Beobachtung hinweisen — dient als Hint für das LLM-Prompt,
// nicht als finale Entscheidung.
const HEALTH_HINTS = /\b(arzt|medizin|gesundheit|diabetes|herz|krebs|asthma|allerg|impf|studie|leitlin)/i;

async function generateProfile({ rawText, portfolio, existing }) {
  const portfolioHint = portfolio && portfolio.length
    ? portfolio.map((p) => `${p.symbol}${p.name ? ` (${p.name})` : ''}`).join(', ')
    : '(leer)';
  const healthHint = HEALTH_HINTS.test(rawText) ? ' Es scheint einen Gesundheits-Bezug zu geben.' : '';
  const existingKnown = existing && existing.locations && existing.locations.length
    ? ` Bestehende Standort-Geokoordinaten dürfen wiederverwendet werden (${existing.locations.map((l) => l.name).join(', ')}).`
    : '';

  const sys = `Du erstellst aus einem Freitext-Interessen-Profil eines deutschsprachigen Users ein strukturiertes JSON-Profil für eine personalisierte Nachrichten-App.

Modul-Vorgaben (nutze diese IDs wenn passend, ergänze eigene wo nötig):
- local_events   — lokale Veranstaltungen, Konzerte, Lesungen, Festivals
- local_life     — alles rund um den Heimatort: Verkehr, Wetter, Stadtpolitik, regionale Wirtschaft
- property_owner — Immobilien-Eigentümer-Themen: Mietrecht, Grundsteuer, Heizung, Sanierung, Energiepreise
- professional_tech — Beruf/Technologie: KI, Software, Hardware, IT-Industrie
- investor_watchlist — Aktien, Märkte, Quartalszahlen, makroökonomische Treiber
- health_watch   — Gesundheitsthemen: konkrete Diagnosen, Studien, Behörden-Empfehlungen

Gib AUSSCHLIESSLICH JSON zurück, kein Markdown, Struktur:
{
  "age": number|null,
  "profession": "kurze Berufsbezeichnung, leer wenn unklar",
  "languages": ["de","en", ...],
  "locations": [
    {"name":"Konstanz","radiusKm":20,"weight":1.0},
    ...
  ],
  "modules": [
    {
      "id":"local_events",
      "label":"Lokale Events",
      "keywords":["3-8 deutsche+englische Stichworte/Entitäten"],
      "weight":1.0,
      "sourceTypes":["event_portal","local_news"]
    },
    ...
  ],
  "negativeFilters": [
    "kurze Begründungen für noise_penalty — z.B. 'SEO-Ratgeber ohne Studie', 'generische Börsenkommentare', 'globale Politik ohne Bezug zu Deutschland/EU/Depot'"
  ],
  "watchlist": ["AAPL","SAP.DE", ...],
  "bucketHints": {
    "events":"freie 1-2-Wort Notiz, was den User in dieser Rubrik interessiert",
    "lokal":"…", "tech":"…", "watchlist":"…", "medizin":"…", "beobachten":"…"
  }
}

Regeln:
- LIES alles aus dem Freitext. NICHTS erfinden, was nicht angedeutet ist. Wenn unklar: leer / null lassen.
- locations: jeden klar genannten Ort als eigenen Eintrag. Hauptwohnort = weight 1.0, ein zweiter Heimatort 0.7, ein "ich beobachte auch" 0.4. radiusKm sinnvoll wählen (Stadt: 20, Landkreis: 40, Region: 80).
- modules: idealerweise 3-6 Module aus dem Freitext ableiten — ein Modul pro klarem Themen-Cluster.
- keywords: konkret und sucht-tauglich (Eigennamen, Produkt-/Personen-Namen, deutsch+englisch wenn sinnvoll). Keine generischen Wörter wie "interessant".
- negativeFilters: 2-5 kurze Beschreibungen, was als Rauschen herabzustufen ist. Konzept-Defaults wenn nichts spezifisches im Text: "generische Börsenkommentare", "SEO-Artikel ohne Primärquelle", "Gesundheitsratgeber ohne Studie", "globale Politik ohne DE/EU/Depot-Bezug".
- watchlist: NUR Symbole übernehmen, die im Portfolio enthalten sind ODER vom User namentlich genannt werden. Yahoo-Finance-Format.
- bucketHints: pro Rubrik 1-2 Wörter, was im jeweiligen Bucket NICHT-leer aussehen soll. Wenn der User zu einer Rubrik klar nichts beigetragen hat → leer lassen ("").${healthHint}${existingKnown}`;

  const user = `INTERESSEN-FREITEXT:
${rawText || '(leer)'}

PORTFOLIO (Symbole):
${portfolioHint}`;

  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 1800,
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  // Watchlist mit Portfolio-Symbolen ergänzen (Defensive — User-Erwartung).
  const wl = new Set(Array.isArray(parsed.watchlist) ? parsed.watchlist.map(String).filter(Boolean) : []);
  for (const p of (portfolio || [])) if (p.symbol) wl.add(p.symbol);
  const profile = inflateProfile({
    ...parsed,
    watchlist: Array.from(wl),
    rawText,
    rawTextHash: textHash(rawText),
    generatedAt: Date.now(),
    discoveredSources: (existing && existing.discoveredSources) || [],
  });
  return profile;
}

// Geocoded alle Locations des Profils. Wenn das Profil bereits Koordinaten
// hat, werden sie wiederverwendet — Nominatim wird nur für neu hinzugekommene
// Standorte aufgerufen.
async function enrichProfileGeocode(profile, prevProfile) {
  if (!profile.locations.length) return profile;
  const prevByName = new Map((prevProfile?.locations || []).map((l) => [l.name.toLowerCase(), l]));
  await Promise.all(profile.locations.map(async (loc) => {
    const prev = prevByName.get(loc.name.toLowerCase());
    if (prev && prev.lat != null && prev.lng != null) {
      loc.lat = prev.lat; loc.lng = prev.lng;
      return;
    }
    try {
      const r = await api.geocode(loc.name);
      const first = (r.results || r || [])[0];
      if (first && typeof first.lat === 'number' && typeof first.lng === 'number') {
        loc.lat = first.lat; loc.lng = first.lng;
      } else {
        loc.geocodeFailed = true;
      }
    } catch {
      loc.geocodeFailed = true;
    }
  }));
  return profile;
}

// Holt das aktuelle Profil oder generiert es. Re-Generation passiert, wenn
// der Hash des Freitexts sich geändert hat, oder wenn `force=true`.
async function getOrGenerateProfile({ rawText, portfolio, force = false, log }) {
  const prev = inflateProfile(store.get(LS.userProfile, null));
  const hash = textHash(rawText);
  // Issue 23: Re-Klassifikation der User-Sites auch dann nötig, wenn sich
  // die Liste der manuellen URLs seit der letzten Profil-Generierung
  // geändert hat (auch ohne neuen Interessen-Freitext). Wir vergleichen die
  // gespeicherten classification-URLs gegen die aktuelle searchSites-Liste.
  const currentSites = store.get(LS.searchSites, []) || [];
  const classifiedUrls = Object.keys(prev.siteClassifications || {});
  const sitesChanged = currentSites.length !== classifiedUrls.length
    || currentSites.some((u) => !prev.siteClassifications[u]);
  const fresh = !force && prev.rawTextHash === hash && prev.modules.length && !sitesChanged;
  if (fresh) return prev;
  let profile = prev;
  if (force || prev.rawTextHash !== hash || !prev.modules.length) {
    if (log) log('Generiere Profil aus Interessen-Freitext…');
    profile = await generateProfile({ rawText, portfolio, existing: prev });
    if (log) log(`Profil: ${profile.locations.length} Orte, ${profile.modules.length} Module`);
    await enrichProfileGeocode(profile, prev);
    if (log) {
      const geo = profile.locations.filter((l) => l.lat != null).length;
      if (profile.locations.length) log(`Geo: ${geo}/${profile.locations.length} Orte gefunden`);
    }
  }
  // Issue 23: Vorab-Klassifikation der manuell eingetragenen Webseiten.
  // Pro URL: Playwright-Crawl + LLM-Klassifikation in
  // {lokalnachricht, lokal_event, wetter, andere}.
  if (currentSites.length) {
    try {
      if (log) log(`Klassifiziere ${currentSites.length} eigene Webseite${currentSites.length === 1 ? '' : 'n'} (Playwright)…`);
      const { sources, rendered, skipped } = await crawlUserSitePages(currentSites);
      const classifications = await classifyUserSitePages(sources);
      // Map { [url]: { category, reason, title, fetchedAt } }
      const map = {};
      for (const c of classifications) {
        map[c.url] = {
          category: c.category,
          reason: c.reason || '',
          title: c.title || '',
          fetchedAt: Date.now(),
        };
      }
      // URLs, die wir nicht gecrawlt bekommen haben → Marker setzen.
      for (const u of currentSites) {
        if (!map[u]) map[u] = { category: 'unbekannt', reason: 'Crawl fehlgeschlagen', title: '', fetchedAt: Date.now() };
      }
      profile.siteClassifications = map;
      if (log) {
        const counts = { lokalnachricht: 0, lokal_event: 0, wetter: 0, andere: 0, unbekannt: 0 };
        for (const k of Object.keys(map)) counts[map[k].category] = (counts[map[k].category] || 0) + 1;
        const parts = Object.entries(counts).filter(([_, n]) => n > 0).map(([k, n]) => `${n}× ${k}`).join(', ');
        log(`✓ Klassifikation: ${parts} (${rendered} via Playwright${skipped ? `, ${skipped} ohne Text` : ''})`);
      }
    } catch (e) {
      console.warn('site pre-classification failed', e);
      if (log) log(`✗ Site-Klassifikation: ${e.message || e}`);
    }
  } else {
    profile.siteClassifications = {};
  }
  store.set(LS.userProfile, profile);
  return profile;
}

// =============================================================================
// Issue 8 — seenUrls-Tracking (für Novelty-Score) & Discovered-Sources
// =============================================================================

function loadSeenUrls() {
  const seen = store.get(LS.seenUrls, {}) || {};
  const cutoff = Date.now() - 14 * 86400000;
  for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
  return seen;
}

function persistSeenUrls(seen, newUrls) {
  const now = Date.now();
  for (const u of newUrls) if (u && !seen[u]) seen[u] = now;
  store.set(LS.seenUrls, seen);
}

function mergeDiscoveredSources(profile, items, cap = 200) {
  if (!profile) return;
  const set = new Set(profile.discoveredSources || []);
  for (const it of items) {
    const host = sourceFromUrl(it.url);
    if (host) set.add(host);
  }
  profile.discoveredSources = Array.from(set).slice(-cap);
  store.set(LS.userProfile, profile);
}

// =============================================================================
// Issue 8 — Wetter
// =============================================================================

const WEATHER_TTL_MS = 3 * 3600 * 1000;
async function fetchWeather(profile) {
  const loc = (profile.locations || []).find((l) => l.lat != null && l.lng != null);
  if (!loc) return null;
  const cache = store.get(LS.weatherCache, null);
  if (cache && cache.lat === loc.lat && cache.lng === loc.lng
      && Date.now() - (cache.fetchedAt || 0) < WEATHER_TTL_MS) {
    return { ...cache.data, locationName: loc.name };
  }
  try {
    const data = await api.weather(loc.lat, loc.lng, 3);
    // Issue 27 + Issue 28: UV-Index ergänzen. Issue 27 hatte einen direkten
    // browser → api.open-meteo.com-Fetch — Symptom (Issue 28): bei Adblockern,
    // restriktiven CSPs und manchen Corporate-Firewalls schlug der Call mit
    // einer Exception fehl, die in seltenen Fällen aus dem inneren try
    // entkam und den ganzen Wetter-/Briefing-/Render-Flow abbrach. Issue 28
    // routet den Call deshalb durch unseren Backend-Proxy `/api/uv-index`
    // (Same-Origin, kein CORS-Risiko mehr). Best-effort: bei Fehler bleibt
    // das Wetter weiterhin ohne UV-Badge, der restliche Flow ist nicht
    // betroffen.
    try {
      const params = new URLSearchParams({
        lat: String(loc.lat),
        lng: String(loc.lng),
        days: '3',
      });
      if (data.timezone) params.set('timezone', data.timezone);
      const uvRes = await fetch(`${API_BASE}/uv-index?${params}`);
      if (uvRes && uvRes.ok) {
        const uv = await uvRes.json();
        if (uv && uv.ok) {
          if (data.current && uv.current && typeof uv.current.uv_index === 'number') {
            data.current.uv_index = uv.current.uv_index;
          }
          if (Array.isArray(data.daily) && uv.daily && Array.isArray(uv.daily.time) && Array.isArray(uv.daily.uv_index_max)) {
            for (let i = 0; i < data.daily.length; i++) {
              const idx = uv.daily.time.indexOf(data.daily[i].date);
              if (idx >= 0 && typeof uv.daily.uv_index_max[idx] === 'number') {
                data.daily[i].uv_index_max = uv.daily.uv_index_max[idx];
              }
            }
          }
        }
      }
    } catch (e) { console.warn('uv-index fetch failed (non-fatal)', e); }
    store.set(LS.weatherCache, { lat: loc.lat, lng: loc.lng, fetchedAt: Date.now(), data });
    return { ...data, locationName: loc.name };
  } catch (e) {
    console.warn('weather fetch failed', e);
    return null;
  }
}

// Open-Meteo-Codes nach kurzer Beschreibung + Emoji.
const WEATHER_CODES = {
  0: ['☀️','klar'], 1: ['🌤','meist klar'], 2: ['⛅','teils bewölkt'], 3: ['☁️','bedeckt'],
  45: ['🌫','nebelig'], 48: ['🌫','Reifnebel'],
  51: ['🌦','Nieselregen'], 53: ['🌦','Niesel'], 55: ['🌦','starker Niesel'],
  61: ['🌧','Regen'], 63: ['🌧','Regen'], 65: ['🌧','starker Regen'],
  71: ['🌨','Schneefall'], 73: ['🌨','Schnee'], 75: ['❄️','starker Schnee'],
  80: ['🌦','Regenschauer'], 81: ['🌧','Schauer'], 82: ['⛈','starke Schauer'],
  95: ['⛈','Gewitter'], 96: ['⛈','Gewitter+Hagel'], 99: ['⛈','schweres Gewitter'],
};
function describeWeatherCode(code) {
  return WEATHER_CODES[code] || ['🌡', `Code ${code}`];
}

// =============================================================================
// Tabs
// =============================================================================

function activateTab(name) {
  $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  $$('.tab-btn').forEach((b) => b.classList.toggle('tab-active', b.dataset.tab === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initTabs() {
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-tab-link]');
    if (link) { e.preventDefault(); activateTab(link.dataset.tabLink); }
  });
  activateTab('news');
}

// =============================================================================
// Setup-Tab (Interessen, Feeds, Notifications, Reset)
// =============================================================================

function initSetup() {
  const taInterests = $('#ta-interests');
  const taFeeds = $('#ta-feeds');
  const taSites = $('#ta-search-sites');
  const taYoutube = $('#ta-youtube'); // Issue 10

  // Load
  const interests = store.get(LS.interests, { rawText: '' });
  taInterests.value = interests.rawText || '';
  $('#interest-chars').textContent = taInterests.value.length;

  const feeds = store.get(LS.feeds, []);
  taFeeds.value = feeds.join('\n');

  if (taSites) {
    const sites = store.get(LS.searchSites, []);
    taSites.value = sites.join('\n');
    const mode = store.get(LS.searchSitesMode, 'additional');
    const radio = document.querySelector(`input[name="sites-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    // Issue 27: Max-Alter-Auswahl für Webseiten (Setup → eigene Webseiten).
    const siteAgeRadio = document.querySelector(`input[name="site-max-age"][value="${getSiteMaxAgeDays()}"]`);
    if (siteAgeRadio) siteAgeRadio.checked = true;
    document.querySelectorAll('input[name="site-max-age"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        const v = parseInt(r.value, 10);
        if (ALLOWED_MAX_AGE_DAYS.includes(v)) {
          localStorage.setItem(LS.siteMaxAgeDays, String(v));
        }
      });
    });
  }

  if (taYoutube) {
    const yt = store.get(LS.youtubeChannels, []);
    taYoutube.value = yt.join('\n');
    // Issue 27: Max-Alter-Auswahl für YouTube-Videos.
    const ytAgeRadio = document.querySelector(`input[name="yt-max-age"][value="${getYtMaxAgeDays()}"]`);
    if (ytAgeRadio) ytAgeRadio.checked = true;
    document.querySelectorAll('input[name="yt-max-age"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        const v = parseInt(r.value, 10);
        if (ALLOWED_MAX_AGE_DAYS.includes(v)) {
          localStorage.setItem(LS.ytMaxAgeDays, String(v));
        }
      });
    });
  }

  // Persist
  taInterests.addEventListener('input', () => {
    store.set(LS.interests, { rawText: taInterests.value });
    $('#interest-chars').textContent = taInterests.value.length;
  });
  taFeeds.addEventListener('input', () => {
    store.set(LS.feeds, parseFeedsTextarea(taFeeds.value));
  });
  if (taYoutube) {
    taYoutube.addEventListener('input', () => {
      // gleiche Parser-Regeln wie RSS: # = Kommentar, dedup, trim.
      store.set(LS.youtubeChannels, parseFeedsTextarea(taYoutube.value));
    });
  }
  if (taSites) {
    taSites.addEventListener('input', () => {
      store.set(LS.searchSites, parseSearchSites(taSites.value));
    });
    document.querySelectorAll('input[name="sites-mode"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) store.set(LS.searchSitesMode, r.value);
      });
    });
  }

  // Beispiel-Feeds
  $('#btn-load-suggested').addEventListener('click', () => {
    const suggested = [
      'https://www.tagesschau.de/index~rss2.xml',
      'https://www.heise.de/rss/heise-atom.xml',
      'https://www.zeit.de/index',
      'https://rss.golem.de/rss.php?feed=RSS2.0',
    ];
    const existing = parseFeedsTextarea(taFeeds.value);
    const merged = Array.from(new Set([...existing, ...suggested]));
    taFeeds.value = merged.join('\n');
    store.set(LS.feeds, merged);
    toast('Beispiel-Feeds eingefügt', 'success');
  });

  // Test feeds
  $('#btn-test-feeds').addEventListener('click', async () => {
    const urls = parseFeedsTextarea(taFeeds.value);
    if (!urls.length) { toast('Keine Feeds zum Testen', 'error'); return; }
    const statusEl = $('#feeds-status');
    statusEl.textContent = `0/${urls.length} geprüft…`;
    let ok = 0, fail = 0;
    await Promise.all(urls.map(async (u, i) => {
      try {
        const r = await api.rss(u);
        if (r.ok) ok++;
      } catch { fail++; }
      statusEl.textContent = `${ok + fail}/${urls.length} geprüft · ${ok} ok, ${fail} fehler`;
    }));
    toast(`Feeds-Test: ${ok} ok, ${fail} fehler`, fail ? 'error' : 'success');
  });

  // Issue 10: YouTube-Kanäle testen — auflösen + Video-Count anzeigen.
  const btnTestYt = $('#btn-test-youtube');
  if (btnTestYt && taYoutube) {
    btnTestYt.addEventListener('click', async () => {
      const urls = parseFeedsTextarea(taYoutube.value);
      if (!urls.length) { toast('Keine YouTube-Kanäle zum Testen', 'error'); return; }
      const statusEl = $('#youtube-status');
      statusEl.textContent = `0/${urls.length} geprüft…`;
      let ok = 0, fail = 0;
      const details = [];
      await Promise.all(urls.map(async (u) => {
        try {
          // Schaut bewusst über die 3-Tage-Grenze hinaus, damit der Test auch
          // bei selten postenden Kanälen "Kanal erreichbar" bestätigt.
          const r = await api.youtubeVideos(u, { maxAgeMs: 90 * 24 * 3600 * 1000 });
          if (r.ok) {
            ok++;
            details.push(`${r.channelTitle || r.channelId}: ${r.videos.length} Videos (90d)`);
          } else { fail++; }
        } catch { fail++; }
        statusEl.textContent = `${ok + fail}/${urls.length} geprüft · ${ok} ok, ${fail} fehler`;
      }));
      if (details.length) console.log('YouTube-Test:', details);
      toast(`YouTube-Test: ${ok} ok, ${fail} fehler`, fail ? 'error' : 'success');
    });
  }

  // Notifications
  const updateNotifyStatus = () => {
    const s = typeof Notification === 'undefined' ? 'nicht unterstützt' : Notification.permission;
    $('#notify-status').textContent = `Status: ${s}`;
  };
  updateNotifyStatus();
  $('#btn-notify-perm').addEventListener('click', async () => {
    if (typeof Notification === 'undefined') { toast('Browser unterstützt keine Notifications', 'error'); return; }
    const perm = await Notification.requestPermission();
    updateNotifyStatus();
    toast(perm === 'granted' ? 'Benachrichtigungen aktiv' : `Status: ${perm}`, perm === 'granted' ? 'success' : 'info');
  });

  // Issue 24/40: LLM-Backend-Umschalter — fünf Modelle (DeepSeek, Gemini,
  // Qwen, Nemotron, Grok), jede Zeile mit Radio + Kosten-Chip + Test-Button.
  // Wirkt unmittelbar auf alle nachfolgenden api.llm()-Calls (siehe
  // currentLlmModel) — keine Page-Reload nötig.
  renderLlmBackendList();
  updateLlmBackendUi();

  // Issue 30: Längen-Multiplikator für das tägliche Briefing.
  // Wirkt beim NÄCHSTEN „Zusammenfassen" — bestehender Cache bleibt.
  const currentBriefingLen = getBriefingLengthFactor();
  document.querySelectorAll('input[name="briefing-length"]').forEach((r) => {
    r.checked = parseInt(r.value, 10) === currentBriefingLen;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      const v = parseInt(r.value, 10);
      if (!ALLOWED_BRIEFING_LENGTH_FACTORS.includes(v)) return;
      localStorage.setItem(LS.briefingLength, String(v));
      toast(`Briefing-Länge: ${v}× — wirkt beim nächsten „Zusammenfassen"`, 'success');
    });
  });

  // Issue 24: Kalender — Upload, Paste, Liste.
  initCalendarUi();

  // Reset
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Wirklich alle lokalen Daten löschen?')) return;
    Object.values(LS).forEach((k) => store.remove(k));
    location.reload();
  });

  // Issue 8: Profil-Regenerator. Wir zeigen das aktuelle Profil und einen
  // Button, um es aus dem aktuellen Freitext NEU zu generieren (ohne dass
  // der User extra "Zusammenfassen" klicken muss).
  const btnRegen = $('#btn-profile-regen');
  if (btnRegen) {
    btnRegen.addEventListener('click', async () => {
      const rawText = (taInterests.value || '').trim();
      if (!rawText) { toast('Bitte erst Interessen-Text eingeben', 'error'); return; }
      btnRegen.disabled = true;
      const old = btnRegen.textContent;
      btnRegen.textContent = 'Generiere…';
      try {
        const portfolio = store.get(LS.portfolio, []);
        await getOrGenerateProfile({ rawText, portfolio, force: true });
        renderProfileBox();
        toast('Profil neu generiert', 'success');
      } catch (e) {
        console.error(e);
        toast(`Fehler: ${e.message || e}`, 'error');
      } finally {
        btnRegen.disabled = false;
        btnRegen.textContent = old;
      }
    });
  }

  renderProfileBox();
}

// Issue 24/40: aktualisiert die Footer-Zeile und den Status-Hinweis unter dem
// LLM-Backend-Switch. Wird nach jedem Wechsel + beim Init gerufen.
function updateLlmBackendUi() {
  const choice = currentLlmBackend();
  const meta = LLM_MODEL_META[choice] || LLM_MODEL_META[LLM_DEFAULT_BACKEND];
  const label = meta.label;
  const footer = document.getElementById('footer-llm-line');
  if (footer) footer.textContent = `LLM: ${label} · Suche: DuckDuckGo · Kurse: Yahoo Finance`;
  const status = document.getElementById('llm-backend-status');
  if (status) status.textContent = `Aktuell: ${label} — ${formatLlmCost(choice)}. Wirkt sofort auf alle nachfolgenden Anfragen.`;
}

// Issue 40: rendert die Liste der 5 verfügbaren Modelle im Setup-Tab.
// Aufbau pro Zeile: Radio + Label + Untertitel + Kosten-Chip + Test-Button +
// Test-Status-Span. Wird einmal beim Mount des Setup-Tabs aufgerufen.
function renderLlmBackendList() {
  const host = document.getElementById('llm-backend-list');
  if (!host) return;
  const current = currentLlmBackend();
  host.innerHTML = '';
  for (const key of Object.keys(LLM_MODELS)) {
    const meta = LLM_MODEL_META[key];
    if (!meta) continue;
    const row = document.createElement('div');
    row.className = 'flex flex-col gap-2 rounded-xl border border-white/5 bg-ink-900/40 p-3 sm:flex-row sm:items-start sm:gap-4';
    row.dataset.backend = key;

    // Label-Block (Radio + Modellname + Untertitel).
    const labelWrap = document.createElement('label');
    labelWrap.className = 'flex grow items-start gap-2 cursor-pointer';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'llm-backend';
    radio.value = key;
    radio.className = 'mt-1 accent-ember-500';
    radio.checked = key === current;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      if (!LLM_MODELS[key]) return;
      localStorage.setItem(LS.llmBackend, key);
      updateLlmBackendUi();
      toast(`KI-Modell auf ${meta.label} umgestellt`, 'success');
    });
    const textWrap = document.createElement('span');
    textWrap.className = 'flex flex-col gap-0.5';
    const title = document.createElement('span');
    title.className = 'text-slate-200';
    title.textContent = meta.label;
    const sub = document.createElement('span');
    sub.className = 'text-xs text-slate-500';
    sub.textContent = meta.note;
    const slug = document.createElement('span');
    slug.className = 'text-[10px] text-slate-600 font-mono';
    slug.textContent = LLM_MODELS[key];
    const cost = document.createElement('span');
    cost.className = 'text-xs text-ember-300 mt-0.5';
    cost.textContent = formatLlmCost(key);
    textWrap.appendChild(title);
    textWrap.appendChild(sub);
    textWrap.appendChild(slug);
    textWrap.appendChild(cost);
    labelWrap.appendChild(radio);
    labelWrap.appendChild(textWrap);

    // Test-Button-Block (Button + Status-Span).
    const testWrap = document.createElement('div');
    testWrap.className = 'flex flex-col items-start sm:items-end gap-1 sm:min-w-[170px]';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-flex items-center justify-center rounded-lg border border-ember-500/40 bg-ember-500/10 px-3 py-1.5 text-xs font-semibold text-ember-200 hover:bg-ember-500/20 transition disabled:opacity-50 disabled:cursor-wait';
    btn.textContent = 'Testen';
    btn.dataset.backend = key;
    const stat = document.createElement('span');
    stat.className = 'text-[11px] text-slate-500';
    stat.textContent = 'noch nicht getestet';
    btn.addEventListener('click', () => testLlmBackend(key, btn, stat));
    testWrap.appendChild(btn);
    testWrap.appendChild(stat);

    row.appendChild(labelWrap);
    row.appendChild(testWrap);
    host.appendChild(row);
  }
}

// Issue 40: feuert einen minimalen LLM-Call gegen das gewählte Modell und
// rendert das Ergebnis (OK / Fehler + Latenz) inline neben dem Test-Button.
// Verändert KEINE Modell-Auswahl im LS — der Test ist unabhängig von der
// aktiven Wahl. Nutzt explizit `model: LLM_MODELS[key]`, damit der gewählte
// LS-Wert irrelevant ist.
async function testLlmBackend(key, btn, stat) {
  const meta = LLM_MODEL_META[key];
  const modelId = LLM_MODELS[key];
  if (!meta || !modelId) return;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Teste…';
  stat.className = 'text-[11px] text-slate-400';
  stat.textContent = 'läuft…';
  const startedAt = Date.now();
  try {
    const res = await api.llm({
      system: 'Antworte mit genau einem Wort: OK.',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0,
      max_tokens: 8,
      model: modelId,
    });
    const elapsed = Date.now() - startedAt;
    const reply = (res && typeof res.reply === 'string') ? res.reply.trim() : '';
    if (!reply) {
      stat.className = 'text-[11px] text-rose-300';
      stat.textContent = `⚠ Leerer Reply (HTTP-Erfolg, 0c) · ${elapsed} ms`;
    } else {
      stat.className = 'text-[11px] text-emerald-300';
      const shown = reply.length > 24 ? `${reply.slice(0, 24)}…` : reply;
      stat.textContent = `✓ OK · „${shown}" · ${elapsed} ms`;
    }
  } catch (e) {
    const elapsed = Date.now() - startedAt;
    const status = e && typeof e.status === 'number' ? `HTTP ${e.status}` : 'Netzwerk-/Timeout';
    const msg = e && e.message ? String(e.message).slice(0, 80) : 'Unbekannt';
    stat.className = 'text-[11px] text-rose-300';
    stat.textContent = `✗ ${status} · ${msg} · ${elapsed} ms`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// =============================================================================
// Issue 24 — Kalender: Datei-Upload, Clipboard-Paste, LLM-Extraktion, Liste
// =============================================================================
//
// Der User kann Text/PDFs mit Kalendereinträgen hochladen (z.B. Outlook-/
// Google-Calendar-Exporte, Vereinsplan, Konzert-Programm) ODER Text aus der
// Zwischenablage einfügen. Ein LLM-Call extrahiert daraus konkrete Einzel-
// termine (Titel, Datum, Uhrzeit, Ort, Notizen). Sie landen in `wl:calendar`
// und werden beim nächsten Summarize-Run als zusätzliche Events in
// `concreteEvents` prepended — d.h. sie tauchen in der Events-Rubrik auf
// und können auch im Briefing erwähnt werden.

function calendarStoreGet() {
  const arr = store.get(LS.calendar, []);
  return Array.isArray(arr) ? arr : [];
}
function calendarStoreSet(entries) {
  store.set(LS.calendar, entries);
}
function calendarAddEntries(newOnes) {
  if (!newOnes || !newOnes.length) return 0;
  const existing = calendarStoreGet();
  const seen = new Set(existing.map((e) => `${(e.title || '').toLowerCase().trim()}|${e.date || ''}|${e.time || ''}`));
  let added = 0;
  for (const e of newOnes) {
    const key = `${(e.title || '').toLowerCase().trim()}|${e.date || ''}|${e.time || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push({ ...e, id: `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, addedAt: Date.now() });
    added++;
  }
  // Sortierung: zukünftige Termine zuerst (asc), Vergangenes ans Ende (desc).
  const today = new Date().toISOString().slice(0, 10);
  existing.sort((a, b) => {
    const fa = (a.date || '') >= today;
    const fb = (b.date || '') >= today;
    if (fa !== fb) return fa ? -1 : 1;
    if (fa) return (a.date || '').localeCompare(b.date || '');
    return (b.date || '').localeCompare(a.date || '');
  });
  calendarStoreSet(existing);
  return added;
}
function calendarRemove(id) {
  const arr = calendarStoreGet().filter((e) => e.id !== id);
  calendarStoreSet(arr);
}

// Liefert nur die zukünftigen + heutigen Einträge (für die News-Integration).
function calendarUpcoming(maxDays = 14) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + maxDays * 86400000).toISOString().slice(0, 10);
  return calendarStoreGet().filter((e) => e.date && e.date >= today && e.date <= end);
}

async function extractCalendarEntriesFromText(rawText, sourceLabel = 'Manuelle Eingabe') {
  const text = (rawText || '').trim();
  if (!text) return [];
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const sys = `Du extrahierst aus rohem Text (Outlook-Export, ICS, Tabellen-Kopie, freie Notizen, PDF-OCR) KONKRETE EINZELTERMINE und gibst sie als JSON zurück. Heute ist ${today}.

OUTPUT NUR JSON (kein Markdown, kein Text davor/danach):
{
  "entries": [
    {
      "title": "Klare Bezeichnung des Termins (max 200 Zeichen)",
      "date": "YYYY-MM-DD",
      "time": "HH:MM",      // optional, sonst leer
      "location": "Ort / Adresse / Venue", // optional
      "notes": "1-2 sachliche Sätze Kontext"  // optional
    }
  ]
}

REGELN:
- Nur EINZELNE konkrete Termine — keine wiederkehrenden Serien ohne Datum, keine Sammelhinweise ("regelmäßig dienstags").
- date: striktes Format YYYY-MM-DD. Wenn nur Tag+Monat → das NÄCHSTE Vorkommen ab heute. Wenn nur Wochentag → das NÄCHSTE Vorkommen. Wenn überhaupt kein Datum erkennbar → Termin NICHT aufnehmen.
- Liegen erkannte Termine vor ${cutoff} → ÜBERSPRINGEN (alter Kalender-Dump, irrelevant).
- time: HH:MM 24h. „nachmittags" / „abends" ohne Uhrzeit → time leeren, nicht raten.
- location: nur wenn explizit im Text — keine Halluzination.
- notes: max 200 Zeichen, optional. Eigennamen, Teilnehmer, Anlass-Kontext.
- Maximal 30 Einträge GESAMT, sortiert nach Datum asc.

SELF-CHECK: Hat jeder Eintrag ein valides ISO-Datum ab ${cutoff}? Wenn nicht → raus.`;

  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: text.slice(0, 12000) }],
    temperature: 0.1,
    max_tokens: 2200,
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  const raw = Array.isArray(parsed.entries) ? parsed.entries : [];
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const out = [];
  for (const e of raw) {
    if (!e || typeof e.title !== 'string') continue;
    const title = e.title.trim().slice(0, 200);
    if (title.length < 3) continue;
    const date = String(e.date || '').trim().slice(0, 10);
    if (!isoRe.test(date)) continue;
    const articleDate = new Date(date + 'T00:00:00');
    if (isNaN(articleDate.getTime())) continue;
    out.push({
      title,
      date,
      time: String(e.time || '').trim().slice(0, 5),
      location: String(e.location || '').trim().slice(0, 200),
      notes: String(e.notes || '').trim().slice(0, 400),
      source: sourceLabel,
    });
  }
  return out;
}

function initCalendarUi() {
  const drop = $('#cal-drop-zone');
  const fileInput = $('#cal-file-input');
  const status = $('#cal-status');
  const list = $('#cal-list');
  const btnPaste = $('#btn-cal-paste');
  const pasteArea = $('#cal-paste-area');
  const pasteActions = $('#cal-paste-actions');
  const btnPasteSubmit = $('#btn-cal-paste-submit');
  const btnPasteCancel = $('#btn-cal-paste-cancel');
  const btnClear = $('#btn-cal-clear');

  if (!drop || !list) return;

  const setStatus = (msg) => { if (status) status.textContent = msg || ''; };

  const renderList = () => {
    const entries = calendarStoreGet();
    if (!entries.length) {
      list.innerHTML = `<div class="text-xs text-slate-500">Noch keine Termine gespeichert.</div>`;
      return;
    }
    list.innerHTML = entries.map((e) => {
      const dateStr = e.date ? new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(e.date + 'T00:00:00')) : '—';
      const past = e.date && e.date < new Date().toISOString().slice(0, 10);
      const dimCls = past ? 'opacity-60' : '';
      const timeStr = e.time ? ` · ${escapeHtml(e.time)}` : '';
      const locStr = e.location ? ` · 📍 ${escapeHtml(e.location)}` : '';
      const notesStr = e.notes ? `<div class="text-xs text-slate-400 mt-1">${escapeHtml(e.notes)}</div>` : '';
      return `<div class="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-ink-900/40 px-3 py-2 ${dimCls}">
        <div class="min-w-0">
          <div class="text-sm font-medium text-slate-100 truncate">${escapeHtml(e.title || '')}</div>
          <div class="text-xs text-slate-400">${escapeHtml(dateStr)}${timeStr}${locStr}</div>
          ${notesStr}
        </div>
        <button data-cal-del="${escapeHtml(e.id || '')}" class="text-xs text-rose-300 hover:text-rose-200 shrink-0" title="Löschen">✕</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-cal-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        calendarRemove(btn.getAttribute('data-cal-del'));
        renderList();
        toast('Termin gelöscht', 'info');
      });
    });
  };

  const handleFile = async (file) => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('Datei zu groß (>12 MB)', 'error'); return; }
    setStatus(`Verarbeite ${file.name}…`);
    try {
      let rawText = '';
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const isImage = /^image\//.test(file.type);
      if (isPdf) {
        const r = await api.extract(file);
        rawText = r.text || '';
      } else if (isImage) {
        const r = await api.ocr(file);
        rawText = r.text || '';
      } else {
        // Text/MD/CSV/ICS — direkt lesen.
        rawText = await file.text();
      }
      if (!rawText.trim()) { setStatus('Kein Text in der Datei erkannt.'); return; }
      setStatus(`Text extrahiert (${rawText.length} Zeichen) — KI sucht Termine…`);
      const entries = await extractCalendarEntriesFromText(rawText, file.name);
      if (!entries.length) { setStatus('Keine Termine erkannt.'); toast('Keine Termine erkannt', 'info'); return; }
      const added = calendarAddEntries(entries);
      setStatus(`${added} neue Termine hinzugefügt (${entries.length} insgesamt erkannt).`);
      toast(`${added} neue Termine aus ${file.name}`, 'success');
      renderList();
    } catch (e) {
      console.error(e);
      setStatus(`Fehler: ${e.message || e}`);
      toast('Termin-Extraktion fehlgeschlagen', 'error');
    }
  };

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag-over'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  // Clipboard-Paste-Pfad — entweder direkt aus Zwischenablage lesen
  // (Permission!), oder Textfeld zum Reinkopieren öffnen.
  if (btnPaste) {
    btnPaste.addEventListener('click', async () => {
      let txt = '';
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          txt = await navigator.clipboard.readText();
        }
      } catch { /* User hat Permission verweigert oder Browser unterstützt es nicht */ }
      if (txt && txt.trim().length > 5) {
        // Direkt extrahieren, ohne Textfeld zu zeigen.
        setStatus(`Aus Zwischenablage gelesen (${txt.length} Zeichen) — KI sucht Termine…`);
        try {
          const entries = await extractCalendarEntriesFromText(txt, 'Zwischenablage');
          if (!entries.length) { setStatus('Keine Termine im Clipboard-Text erkannt.'); toast('Keine Termine erkannt', 'info'); return; }
          const added = calendarAddEntries(entries);
          setStatus(`${added} neue Termine aus Zwischenablage hinzugefügt.`);
          toast(`${added} neue Termine`, 'success');
          renderList();
        } catch (e) {
          console.error(e);
          setStatus(`Fehler: ${e.message || e}`);
          toast('Extraktion fehlgeschlagen', 'error');
        }
      } else {
        // Fallback: Textfeld einblenden — Browser-Permission verweigert oder
        // Clipboard leer. Der User kann manuell reinpasten und „Termine
        // extrahieren" klicken.
        pasteArea.classList.remove('hidden');
        pasteActions.classList.remove('hidden');
        pasteActions.classList.add('flex');
        pasteArea.value = '';
        pasteArea.focus();
        setStatus('Bitte Text in das Feld einfügen (Strg+V) und auf „Termine extrahieren" klicken.');
      }
    });
  }
  if (btnPasteSubmit) {
    btnPasteSubmit.addEventListener('click', async () => {
      const txt = (pasteArea.value || '').trim();
      if (!txt) { toast('Kein Text zum Extrahieren', 'error'); return; }
      setStatus(`Verarbeite ${txt.length} Zeichen…`);
      try {
        const entries = await extractCalendarEntriesFromText(txt, 'Zwischenablage (manuell)');
        if (!entries.length) { setStatus('Keine Termine erkannt.'); toast('Keine Termine erkannt', 'info'); return; }
        const added = calendarAddEntries(entries);
        setStatus(`${added} neue Termine extrahiert.`);
        toast(`${added} neue Termine`, 'success');
        pasteArea.value = '';
        pasteArea.classList.add('hidden');
        pasteActions.classList.add('hidden');
        pasteActions.classList.remove('flex');
        renderList();
      } catch (e) {
        console.error(e);
        setStatus(`Fehler: ${e.message || e}`);
      }
    });
  }
  if (btnPasteCancel) {
    btnPasteCancel.addEventListener('click', () => {
      pasteArea.classList.add('hidden');
      pasteActions.classList.add('hidden');
      pasteActions.classList.remove('flex');
      pasteArea.value = '';
      setStatus('');
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (!calendarStoreGet().length) return;
      if (!confirm('Wirklich alle gespeicherten Termine löschen?')) return;
      calendarStoreSet([]);
      renderList();
      toast('Kalender geleert', 'info');
    });
  }

  renderList();
}

// Issue 8: rendert die Profil-Übersicht im Setup-Tab.
function renderProfileBox() {
  const box = $('#profile-box');
  if (!box) return;
  const profile = inflateProfile(store.get(LS.userProfile, null));
  const meta = $('#profile-meta');
  if (!profile.generatedAt) {
    if (meta) meta.textContent = 'Noch kein Profil — wird beim nächsten „Zusammenfassen" automatisch erzeugt.';
    box.innerHTML = `<p class="text-xs text-slate-500">Keine Profildaten vorhanden.</p>`;
    return;
  }
  const generated = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(profile.generatedAt));
  if (meta) meta.textContent = `Generiert ${generated}${profile.profession ? ` · Beruf: ${profile.profession}` : ''}${profile.age ? ` · Alter ${profile.age}` : ''}${profile.languages.length ? ` · Sprachen: ${profile.languages.join(', ')}` : ''}`;

  const locChips = profile.locations.length
    ? profile.locations.map((l) => `<span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-ember-500/15 text-ember-200 border border-ember-500/30">📍 ${escapeHtml(l.name)}${l.lat != null ? ` · ${l.lat.toFixed(2)}, ${l.lng.toFixed(2)}` : (l.geocodeFailed ? ' · (keine Geo)' : '')} · ${l.radiusKm}km · w${l.weight}</span>`).join('')
    : '<span class="text-xs text-slate-500">keine Standorte</span>';

  const moduleChips = profile.modules.length
    ? profile.modules.map((m) => `
        <div class="rounded-lg border border-white/10 bg-ink-900/60 px-3 py-2 text-xs">
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-slate-200">${escapeHtml(m.label || m.id)}</span>
            <span class="text-slate-500">w${m.weight}</span>
          </div>
          <div class="mt-1 text-slate-400 leading-snug">${escapeHtml(m.keywords.slice(0, 8).join(' · ')) || '—'}</div>
        </div>`).join('')
    : '<span class="text-xs text-slate-500">keine Module erkannt</span>';

  const negChips = profile.negativeFilters.length
    ? profile.negativeFilters.map((n) => `<span class="text-xs px-2 py-1 rounded-full bg-rose-500/15 text-rose-200 border border-rose-500/30">⛔ ${escapeHtml(n)}</span>`).join('')
    : '<span class="text-xs text-slate-500">keine</span>';

  const wlChips = profile.watchlist.length
    ? profile.watchlist.map((s) => `<span class="text-xs px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 font-mono">${escapeHtml(s)}</span>`).join('')
    : '<span class="text-xs text-slate-500">keine</span>';

  const discoChips = profile.discoveredSources.length
    ? profile.discoveredSources.slice(-12).map((s) => `<span class="text-xs px-2 py-0.5 rounded bg-ink-700/60 text-slate-300 border border-white/5 font-mono">${escapeHtml(s)}</span>`).join(' ')
    : '<span class="text-xs text-slate-500">noch keine entdeckt</span>';

  // Issue 23: Vorab-Klassifikation der manuell eingetragenen Webseiten.
  const classCfg = {
    lokalnachricht: { label: 'Lokal-News', color: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30', icon: '🏠' },
    lokal_event:    { label: 'Lokale Events', color: 'bg-ember-500/15 text-ember-200 border-ember-500/30', icon: '📅' },
    wetter:         { label: 'Wetter', color: 'bg-sky-500/15 text-sky-200 border-sky-500/30', icon: '🌤' },
    // Issue 27: Hub-/Themen-/Übersichts-Quelle — Crawl liefert nur Schlagzeilen-
    // Listen ohne Einzelartikel; Items werden in der Pipeline verworfen.
    'übersichtsseite': { label: 'Übersichtsseite', color: 'bg-amber-500/15 text-amber-200 border-amber-500/30', icon: '📑' },
    andere:         { label: 'Andere News', color: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/30', icon: '📰' },
    unbekannt:      { label: 'Unbekannt', color: 'bg-rose-500/15 text-rose-200 border-rose-500/30', icon: '❓' },
  };
  const siteRows = Object.entries(profile.siteClassifications || {});
  const siteList = siteRows.length
    ? siteRows.map(([url, info]) => {
        const cfg = classCfg[info.category] || classCfg.andere;
        const reason = info.reason ? ` <span class="text-slate-500">— ${escapeHtml(info.reason)}</span>` : '';
        return `<li class="flex items-start gap-2 text-xs">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${cfg.color} whitespace-nowrap shrink-0">${cfg.icon} ${escapeHtml(cfg.label)}</span>
          <span class="text-slate-300 break-all font-mono">${escapeHtml(url)}</span>${reason}
        </li>`;
      }).join('')
    : '<li class="text-xs text-slate-500">Keine eigenen Webseiten eingetragen — füge unter „Suche auf diesen Webseiten" URLs hinzu, dann werden sie beim nächsten „Profil generieren" automatisch klassifiziert.</li>';

  box.innerHTML = `
    <div class="space-y-4">
      <div>
        <div class="text-[0.7rem] uppercase tracking-wide text-slate-500 mb-1">Standorte</div>
        <div class="flex flex-wrap gap-2">${locChips}</div>
      </div>
      <div>
        <div class="text-[0.7rem] uppercase tracking-wide text-slate-500 mb-1">Themen-Module</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${moduleChips}</div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div class="text-[0.7rem] uppercase tracking-wide text-slate-500 mb-1">Watchlist</div>
          <div class="flex flex-wrap gap-1.5">${wlChips}</div>
        </div>
        <div>
          <div class="text-[0.7rem] uppercase tracking-wide text-slate-500 mb-1">Negative Filter</div>
          <div class="flex flex-wrap gap-1.5">${negChips}</div>
        </div>
      </div>
      <div>
        <div class="text-[0.7rem] uppercase tracking-wide text-slate-500 mb-1">Eigene Webseiten — Vorab-Klassifikation</div>
        <ul class="space-y-1.5">${siteList}</ul>
      </div>
      <div>
        <div class="text-[0.7rem] uppercase tracking-wide text-slate-500 mb-1">Entdeckte Quellen (still hinzugefügt, letzte 12)</div>
        <div class="flex flex-wrap gap-1.5">${discoChips}</div>
      </div>
    </div>
  `;
}

// =============================================================================
// Mikrofon (Web Speech API)
// =============================================================================

// Issue 3: Chrome feuert `onresult` über Session-Grenzen hinweg mehrfach für
// dieselbe Äußerung — statt die Ursache zu bekämpfen, deduplizieren wir den
// Kandidaten-Text gegen den bisher committeten Stand (baseline + finalSoFar).
//
// Helper unten werden in handleResult genutzt, sind aber pure functions und
// modulweit gehalten, damit handleResult kompakt bleibt.

// Normalisierung: lowercase, Satzzeichen entfernen. So matcht "Hallo, Welt!"
// gegen "hallo welt". Unicode-Letter/Zahlen bleiben (ä, ö, ü, ß).
function normWord(w) {
  return String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Cache der tokenisierten Vergleichsbasis. Bei langen Eingaben spart das die
// wiederholte Zerlegung pro Result-Event. Invalidiert durch writeBack via
// invalidateDedupCache().
let dedupBasisCache = { key: null, words: null };

function invalidateDedupCache() {
  dedupBasisCache = { key: null, words: null };
}

function basisWords(basis) {
  if (dedupBasisCache.key === basis) return dedupBasisCache.words;
  const words = (basis.match(/\S+/g) || []).map(normWord).filter((w) => w.length > 0);
  dedupBasisCache = { key: basis, words };
  return words;
}

// Zwei-Stufen-Dedup:
//   (a) Längster Suffix-Prefix-Overlap auf Wortebene — fängt den dominanten
//       Bug ab (Chrome re-emittiert beim Session-Restart die letzten Worte
//       erneut, oft die komplette vorige Äußerung).
//   (b) Konservative n-Gramm-Prüfung (≥3 Wörter, mit Run-Extension) für
//       nicht-angrenzende Wiederholungen irgendwo im Committed-Text.
// Vergleichsbasis ist `currentCommitted` (= baseline + finalSoFar), nicht
// ta.value — sonst würde laufender Interim-Text die Dedup-Basis verschmutzen.
function appendDeduped(currentCommitted, candidate) {
  if (!candidate) return '';
  const candTokensRaw = candidate.match(/\S+/g) || [];
  const candT = [];
  const candN = [];
  for (const t of candTokensRaw) {
    const n = normWord(t);
    if (n) { candT.push(t); candN.push(n); }
  }
  if (!candT.length) return '';

  const commN = basisWords(currentCommitted || '');

  // Stage A: längster k, sodass commN endet auf candN[0..k).
  let overlap = 0;
  const maxOv = Math.min(candN.length, commN.length);
  for (let k = maxOv; k >= 1; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (commN[commN.length - k + j] !== candN[j]) { ok = false; break; }
    }
    if (ok) { overlap = k; break; }
  }

  const remT = candT.slice(overlap);
  const remN = candN.slice(overlap);
  if (!remT.length) return '';

  // Stage B: pro Restposition den längsten zusammenhängenden Run finden, der
  // irgendwo in commN als Substring vorkommt. Ab Länge ≥ 3 verwerfen (sonst
  // würden harmlose Floskeln wie "und der" fälschlich gefiltert).
  const N = 3;
  const out = [];
  let i = 0;
  while (i < remT.length) {
    let best = 0;
    for (let s = 0; s < commN.length; s++) {
      let k = 0;
      while (s + k < commN.length && i + k < remN.length && commN[s + k] === remN[i + k]) k++;
      if (k > best) best = k;
      if (best >= remN.length - i) break;
    }
    if (best >= N) { i += best; }
    else { out.push(remT[i]); i++; }
  }

  if (!out.length) return '';
  return out.join(' ') + ' ';
}

function initMic() {
  const btn = $('#btn-mic');
  const ta = $('#ta-interests');
  const statusEl = $('#mic-status');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.disabled = true;
    btn.title = 'Spracheingabe wird in diesem Browser nicht unterstützt';
    btn.classList.add('opacity-40', 'cursor-not-allowed');
    return;
  }

  let rec = null;
  let listening = false;
  // Text der vor Mic-Start im Feld stand. Bleibt während einer Mic-Sitzung konstant.
  let baseline = '';
  // Finaler Transkript-Text dieser Mic-Sitzung, nur additiv.
  let finalSoFar = '';

  const writeBack = (interim) => {
    ta.value = baseline + finalSoFar + interim;
    store.set(LS.interests, { rawText: ta.value });
    $('#interest-chars').textContent = ta.value.length;
    // Vergleichsbasis hat sich potenziell geändert → Cache verwerfen.
    invalidateDedupCache();
  };

  const handleResult = (ev) => {
    // ev.resultIndex zeigt auf das ERSTE neue Result in diesem Event —
    // ohne diese Grenze würden wir bei jedem Event ALLE bisherigen Finals
    // erneut akkumulieren und so Duplikate erzeugen.
    let interim = '';
    let newFinal = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) {
        newFinal += t;
        if (!/[\s\n]$/.test(newFinal)) newFinal += ' ';
      } else {
        interim += t;
      }
    }
    if (newFinal) {
      // Issue 3: Chrome re-emittiert Finals über Session-Grenzen → vor dem
      // Anhängen gegen baseline+finalSoFar deduplizieren. Interim bleibt
      // unangetastet (wird beim nächsten Event ohnehin komplett ersetzt).
      const deduped = appendDeduped(baseline + finalSoFar, newFinal);
      if (deduped) finalSoFar += deduped;
    }
    writeBack(interim);
  };

  // Eine frische Recognition-Instanz pro Session.
  // Chrome behält bei rec.start() auf derselben Instanz die alten Results in
  // ev.results — neue Instanz garantiert sauberen Zustand.
  const createRec = () => {
    const r = new SR();
    r.lang = 'de-DE';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = handleResult;
    r.onerror = (e) => {
      statusEl.textContent = `Fehler: ${e.error || 'unbekannt'}`;
      stop();
    };
    r.onend = () => {
      if (!listening) return;
      // Sitzung lief natürlich aus (Stille/Timeout). Aktuellen Stand in
      // baseline einfrieren, Akkumulator zurücksetzen, NEUE Instanz starten.
      baseline = ta.value;
      if (baseline && !/[\s\n]$/.test(baseline)) baseline += ' ';
      finalSoFar = '';
      rec = createRec();
      try { rec.start(); } catch {}
    };
    return r;
  };

  const start = () => {
    baseline = ta.value;
    if (baseline && !/[\s\n]$/.test(baseline)) baseline += ' ';
    finalSoFar = '';
    rec = createRec();
    try { rec.start(); } catch (e) {
      statusEl.textContent = `Fehler: ${e.message || e}`;
      return;
    }
    listening = true;
    btn.classList.add('mic-recording');
    statusEl.textContent = '🎙 Höre zu… (klicke nochmal zum Stoppen)';
  };

  const stop = () => {
    listening = false;
    btn.classList.remove('mic-recording');
    statusEl.textContent = '';
    try { rec && rec.stop(); } catch {}
    rec = null;
  };

  btn.addEventListener('click', () => listening ? stop() : start());
}

// =============================================================================
// Portfolio
// =============================================================================

function renderPortfolio() {
  const tbody = $('#portfolio-rows');
  const portfolio = store.get(LS.portfolio, []);
  const history = store.get(LS.stockHistory, {});
  tbody.innerHTML = '';
  if (!portfolio.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="py-6 text-center text-sm text-slate-500">Noch keine Aktien — unten hinzufügen oder oben Dokument hochladen.</td>`;
    tbody.appendChild(tr);
    return;
  }
  portfolio.forEach((p, i) => {
    const last = history[p.symbol];
    const tr = document.createElement('tr');
    tr.className = 'border-b border-white/5 last:border-0';
    tr.innerHTML = `
      <td class="py-2.5 font-mono text-ember-300">${escapeHtml(p.symbol)}</td>
      <td class="py-2.5 text-slate-200">${escapeHtml(p.name || '')}</td>
      <td class="py-2.5 text-right font-mono ${last && last.lastPrice ? 'text-slate-200' : 'text-slate-600'}">
        ${last && last.lastPrice ? formatPrice(last.lastPrice, last.currency) : '—'}
      </td>
      <td class="py-2.5 text-right">
        <button data-remove="${i}" class="text-slate-500 hover:text-rose-400 transition" title="Entfernen">×</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  $$('#portfolio-rows [data-remove]').forEach((b) => b.addEventListener('click', () => {
    const idx = parseInt(b.dataset.remove, 10);
    const arr = store.get(LS.portfolio, []);
    arr.splice(idx, 1);
    store.set(LS.portfolio, arr);
    renderPortfolio();
  }));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatPrice(price, currency = 'USD') {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency, maximumFractionDigits: 2 }).format(price);
  } catch {
    return `${price.toFixed(2)} ${currency}`;
  }
}

function initPortfolio() {
  $('#btn-add-stock').addEventListener('click', () => {
    const symbol = $('#new-symbol').value.trim().toUpperCase();
    const name = $('#new-name').value.trim();
    if (!symbol) { toast('Symbol nötig', 'error'); return; }
    const arr = store.get(LS.portfolio, []);
    if (arr.find((p) => p.symbol === symbol)) { toast('Symbol existiert bereits', 'error'); return; }
    arr.push({ symbol, name });
    store.set(LS.portfolio, arr);
    $('#new-symbol').value = '';
    $('#new-name').value = '';
    renderPortfolio();
    toast(`${symbol} hinzugefügt`, 'success');
  });
  renderPortfolio();
}

// =============================================================================
// Upload (OCR / PDF) → Ticker-Extraktion
// =============================================================================

function initUpload() {
  const dropZone = $('#drop-zone');
  const fileInput = $('#file-input');
  const status = $('#upload-status');

  const handle = async (file) => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('Datei zu groß (>12 MB)', 'error'); return; }
    status.textContent = `Verarbeite ${file.name}…`;
    try {
      let text = '';
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const r = await api.extract(file);
        text = r.text || '';
      } else {
        const r = await api.ocr(file);
        text = r.text || '';
      }
      if (!text.trim()) { status.textContent = 'Kein Text erkannt.'; return; }
      status.textContent = `Text extrahiert (${text.length} Zeichen). KI sucht Aktien…`;
      const tickers = await extractTickersFromText(text);
      if (!tickers.length) { status.textContent = 'Keine Aktien-Ticker gefunden.'; return; }
      const arr = store.get(LS.portfolio, []);
      let added = 0;
      for (const t of tickers) {
        if (!t.symbol) continue;
        if (arr.find((p) => p.symbol === t.symbol.toUpperCase())) continue;
        arr.push({ symbol: t.symbol.toUpperCase(), name: t.name || '' });
        added++;
      }
      store.set(LS.portfolio, arr);
      renderPortfolio();
      status.textContent = `${added} neue Aktien hinzugefügt (${tickers.length} insgesamt erkannt).`;
      toast(`${added} neue Aktien aus ${file.name}`, 'success');
    } catch (e) {
      console.error(e);
      status.textContent = `Fehler: ${e.message || e}`;
      toast('Extraktion fehlgeschlagen', 'error');
    }
  };

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handle(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); }));
  dropZone.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
}

async function extractTickersFromText(text) {
  const trimmed = text.slice(0, 8000); // Tesseract kann viel ausgeben
  const sys = `Du extrahierst aus einem (oft schlecht formatierten) Depot-Ausdruck oder Screenshot-Text die enthaltenen Aktien.
Gib AUSSCHLIESSLICH JSON zurück, ohne Markdown, in genau dieser Struktur:
{"stocks":[{"symbol":"AAPL","name":"Apple Inc."}, ...]}
Regeln:
- Verwende Yahoo-Finance-konforme Ticker (NYSE/Nasdaq: AAPL; Xetra: SAP.DE; Schweiz: NESN.SW; Krypto: BTC-USD).
- Wenn du dir bei einem Symbol unsicher bist, lieber weglassen.
- Maximal 25 Einträge, keine Doppelten.`;
  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: trimmed }],
    temperature: 0.1,
    max_tokens: 1200,
  });
  const parsed = safeJsonExtract(res.reply || '');
  if (!parsed || !Array.isArray(parsed.stocks)) return [];
  return parsed.stocks.filter((s) => s && typeof s.symbol === 'string' && s.symbol.length <= 12);
}

// =============================================================================
// Zusammenfassen-Flow (Haupt-Funktion)
// =============================================================================

async function runSummarize(opts = {}) {
  const interests = store.get(LS.interests, { rawText: '' }).rawText.trim();
  const feedUrls = store.get(LS.feeds, []);
  const portfolio = store.get(LS.portfolio, []);
  const ytChannels = store.get(LS.youtubeChannels, []); // Issue 10
  // Issue 16: `lastSummarizeAt` wird weiterhin am Ende des Runs gesetzt
  // (siehe unten), beeinflusst aber den YouTube-Cutoff nicht mehr — die
  // 5-Tage-Regel hat Vorrang. Read entfernt; Save bleibt für künftige
  // Verwendungen erhalten.

  if (!interests && !feedUrls.length && !ytChannels.length) {
    toast('Bitte zuerst Interessen, RSS-Feeds oder YouTube-Kanäle eingeben.', 'error');
    activateTab('setup');
    return;
  }

  const btn = $('#btn-summarize');
  btn.disabled = true;
  clearProgressLog();
  setProgress('Plane deine Übersicht…', null);

  // Issue 8: Profil ist die Grundlage des ganzen Flows. Wenn Interessen-Text
  // sich geändert hat (oder force=true), neu generieren.
  let profile = null;
  try {
    profile = await getOrGenerateProfile({
      rawText: interests,
      portfolio,
      force: !!opts.forceProfile,
      log: (msg) => setProgress(null, msg),
    });
  } catch (e) {
    console.warn('profile generation failed', e);
    profile = inflateProfile(store.get(LS.userProfile, null));
    setProgress(null, `⚠ Profil-Gen fehlgeschlagen: ${e.message || e}`);
  }

  try {
    // 1) RSS in parallel
    let rssItems = [];
    let rssDroppedOld = 0;
    // Issue 27: User-konfiguriertes Webseiten-Höchstalter (1|3|5 Tage). Greift
    // hier statt der bisherigen 31-Tage-Grenze — RSS gehört zu „Webseiten".
    const siteMaxAgeDays = getSiteMaxAgeDays();
    if (feedUrls.length) {
      setProgress(`Lade ${feedUrls.length} RSS-Feeds (≤${siteMaxAgeDays} Tag${siteMaxAgeDays === 1 ? '' : 'e'})…`, `${feedUrls.length} Feeds: ${feedUrls.map(sourceFromUrl).join(', ')}`);
      const results = await Promise.allSettled(feedUrls.map((u) => api.rss(u)));
      results.forEach((r, i) => {
        const url = feedUrls[i];
        if (r.status === 'fulfilled' && r.value.ok) {
          let kept = 0;
          let dropped = 0;
          for (const it of (r.value.items || []).slice(0, 20)) {
            // Issue 27: Artikel max. siteMaxAgeDays Tage alt — hart filtern wenn isoDate bekannt.
            if (isArticleTooOldForSites(it.isoDate)) { dropped++; continue; }
            if (kept >= 12) break;
            rssItems.push({
              title: it.title,
              snippet: it.contentSnippet || '',
              url: it.link,
              source: r.value.title || sourceFromUrl(url),
              date: it.isoDate || '',
              origin: 'rss',
            });
            kept++;
          }
          rssDroppedOld += dropped;
          setProgress(null, `✓ ${sourceFromUrl(url)}: ${kept} Einträge${dropped ? ` (${dropped} älter als ${siteMaxAgeDays} Tag${siteMaxAgeDays === 1 ? '' : 'e'} verworfen)` : ''}`);
        } else {
          setProgress(null, `✗ ${sourceFromUrl(url)}: nicht erreichbar`);
        }
      });
    }

    // 1b) Issue 10 + Issue 16: YouTube-Kanäle — pro Kanal das neueste Video
    //     ≤ 5 Tage abholen, Transkript ziehen und per LLM zusammenfassen.
    //     Ergebnis fließt als ganz normale Items in den weiteren Flow
    //     (Scoring → Bucketize). Issue 16 hat die Selektion grundlegend
    //     geändert (war: heute-only via `lastSummarizeAt`-Diff, jetzt:
    //     festes 5-Tage-Fenster + max 1 Video pro Kanal). `lastSummarizeAt`
    //     wird weiterhin am Ende des Runs gesetzt, beeinflusst aber den
    //     Cutoff hier nicht mehr.
    let ytItems = [];
    // Issue 44: Roh-Transkripte sammeln, damit der RAG-Index nicht nur die
    // 3-4-Satz-Zusammenfassung sieht, sondern den vollständigen Transkript-
    // Text. Damit findet der KI-Assistent auch Detail-Fragen wie „Was hat
    // Kurzgesagt zu Mitochondrien gesagt?".
    let ytTranscripts = []; // [{videoId,title,channel,url,date,text}]
    if (ytChannels.length) {
      // Issue 27: User-konfiguriertes Höchstalter (1|3|5 Tage) — ersetzt die
      // bisherige 5-Tage-Konstante. Default bleibt 3 Tage.
      const ytMaxAgeMs = getYtMaxAgeMs();
      const ytMaxAgeDays = getYtMaxAgeDays();
      const cutoff = Date.now() - ytMaxAgeMs;
      setProgress(`Lade ${ytChannels.length} YouTube-Kanäle (neuestes Video pro Kanal, ≤${ytMaxAgeDays} Tag${ytMaxAgeDays === 1 ? '' : 'e'})…`, null);
      const ytResults = await Promise.allSettled(
        ytChannels.map((u) => api.youtubeVideos(u, { sinceMs: cutoff, maxAgeMs: ytMaxAgeMs }))
      );
      const newVideos = [];
      ytResults.forEach((r, i) => {
        const url = ytChannels[i];
        if (r.status === 'fulfilled' && r.value && r.value.ok) {
          const channelTitle = r.value.channelTitle || sourceFromUrl(url);
          const videos = (r.value.videos || []).slice().sort(
            (a, b) => (b.publishedTs || 0) - (a.publishedTs || 0)
          );
          if (videos.length) {
            // Issue 16: nur das NEUESTE Video pro Kanal — verhindert
            // Überflutung durch Kanäle mit vielen Kurzvideos und stellt
            // sicher, dass mind. 1 Item pro Kanal in die Rubrik kommt.
            const newest = videos[0];
            newVideos.push({ ...newest, channelTitle, channelUrl: url });
            const ageDays = newest.publishedTs
              ? ((Date.now() - newest.publishedTs) / (24 * 3600 * 1000)).toFixed(1)
              : '?';
            setProgress(null, `✓ YouTube ${channelTitle}: „${newest.title.slice(0, 70)}" (${ageDays}d alt)${videos.length > 1 ? ` · ${videos.length - 1} weitere im Fenster verworfen` : ''}`);
          } else {
            setProgress(null, `– YouTube ${channelTitle}: kein Video in den letzten ${ytMaxAgeDays} Tag${ytMaxAgeDays === 1 ? '' : 'en'}`);
          }
        } else {
          const msg = r.status === 'rejected'
            ? (r.reason && r.reason.message || 'Fehler')
            : (r.value && r.value.message || 'Fehler');
          setProgress(null, `✗ YouTube ${sourceFromUrl(url)}: ${msg}`);
        }
      });
      // Pro Kanal ist schon nur 1 Video drin — der globale Cap schützt nur
      // noch gegen Edge-Cases mit sehr vielen Kanälen (Transkript-Fetch und
      // LLM-Tokens). Sortierung trotzdem neueste-zuerst für faire Auswahl.
      newVideos.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
      const toProcess = newVideos.slice(0, YOUTUBE_MAX_VIDEOS_PER_RUN);
      if (newVideos.length > toProcess.length) {
        setProgress(null, `· ${newVideos.length - toProcess.length} Kanäle übersprungen (Cap ${YOUTUBE_MAX_VIDEOS_PER_RUN})`);
      }

      if (toProcess.length) {
        setProgress(`Hole Transkripte für ${toProcess.length} Video${toProcess.length === 1 ? '' : 's'}…`, null);
        const trResults = await Promise.allSettled(
          toProcess.map((v) => api.youtubeTranscript(v.videoId).catch((e) => ({ ok: false, _err: e })))
        );
        const transcribed = [];
        trResults.forEach((r, i) => {
          const v = toProcess[i];
          const ok = r.status === 'fulfilled' && r.value && r.value.ok && r.value.text;
          if (ok) {
            transcribed.push({ ...v, transcript: r.value.text });
            // Issue 44: Roh-Transkript für die RAG-Indexierung mitnehmen.
            ytTranscripts.push({
              videoId: v.videoId,
              title: v.title,
              channel: v.channelTitle,
              url: v.link,
              date: v.published || '',
              text: r.value.text,
            });
            setProgress(null, `✓ Transkript: „${v.title.slice(0, 70)}" (${r.value.text.length} Zeichen)`);
          } else {
            setProgress(null, `– Kein Transkript: „${v.title.slice(0, 70)}"`);
          }
        });

        if (transcribed.length) {
          setProgress(`Fasse ${transcribed.length} Video-Transkript${transcribed.length === 1 ? '' : 'e'} zusammen…`, null);
          try {
            const summaries = await summarizeYouTubeTranscripts(transcribed);
            let droppedOverview = 0;
            for (let i = 0; i < transcribed.length; i++) {
              const v = transcribed[i];
              const entry = summaries[i] || { summary: '', typ: 'video' };
              const sm = (entry.summary || '').trim();
              if (!sm) continue;
              // Issue 27: Übersichts-Videos (Wochenrückblicke, „Top-10"-Listen,
              // Reaktions-Roundups) verwerfen — wir wollen konkrete Einzelvideos.
              if (entry.typ === 'übersichtsseite') { droppedOverview++; continue; }
              ytItems.push({
                title: v.title,
                snippet: sm,
                url: v.link,
                source: `YouTube · ${v.channelTitle}`,
                date: v.published || '',
                origin: 'youtube',
                ytSummary: sm,
                ytChannel: v.channelTitle,
                ytVideoId: v.videoId,
              });
            }
            setProgress(null, `✓ ${ytItems.length} Video-Zusammenfassungen erstellt${droppedOverview ? ` (${droppedOverview} Übersichts-Videos verworfen)` : ''}`);
          } catch (e) {
            setProgress(null, `✗ Video-Zusammenfassung fehlgeschlagen: ${e.message || e}`);
          }
        }
      }
    }

    // 2) LLM: Suchqueries + Schwelle generieren
    setProgress('KI plant Web-Suchen…', null);
    const plan = await planSearches({ interests, portfolio, rssTitles: rssItems.slice(0, 30).map((x) => x.title) });
    const planSummary = `Plan: ${plan.queriesDe.length} DE${plan.queriesEn.length ? ` + ${plan.queriesEn.length} EN` : ''} Queries (${plan.timeFilter || 'alle'})${plan.alertThreshold != null ? ` · Kursschwelle ${plan.alertThreshold}%` : ''}${plan.eventQuery ? ` · Events in ${plan.eventQuery.location}` : ''}`;
    setProgress(null, planSummary);

    // Schwelle in Settings ablegen (für Aktien-Update)
    const settings = store.get(LS.settings, {});
    if (plan.alertThreshold != null) settings.alertThreshold = plan.alertThreshold;
    store.set(LS.settings, settings);

    // 3) Web-Suchen parallel — DE + EN (Issue 6), ggf. mit User-Site-Filter
    let webItems = [];
    const sites = store.get(LS.searchSites, []);
    const sitesMode = store.get(LS.searchSitesMode, 'additional'); // 'additional' | 'exclusive'
    const siteOp = buildSiteOperator(sites);

    // Plant pro Basis-Query welche tatsächlichen Such-Queries laufen sollen.
    //  - DE: keine Sites → Original; exclusive → site-restricted; additional → beide
    //  - EN: immer gegen den allgemeinen englischen Web-Index (region=us-en).
    //    User-Sites sind typischerweise deutsche Domains → kein Site-Filter auf EN,
    //    sonst hätten wir 0 Treffer.
    const plannedQueries = [];
    for (const q of plan.queriesDe.slice(0, 5)) {
      if (!siteOp) {
        plannedQueries.push({ q, display: q, scope: 'web', region: 'de-de', lang: 'de' });
      } else if (sitesMode === 'exclusive') {
        plannedQueries.push({ q: `${siteOp} ${q}`, display: `${q} (nur User-Sites)`, scope: 'sites', region: 'de-de', lang: 'de' });
      } else {
        plannedQueries.push({ q, display: q, scope: 'web', region: 'de-de', lang: 'de' });
        plannedQueries.push({ q: `${siteOp} ${q}`, display: `${q} (User-Sites)`, scope: 'sites', region: 'de-de', lang: 'de' });
      }
    }
    for (const q of plan.queriesEn.slice(0, 4)) {
      plannedQueries.push({ q, display: `🌐 ${q}`, scope: 'web-en', region: 'us-en', lang: 'en' });
    }

    let webDroppedOld = 0;
    if (plannedQueries.length) {
      const scopeNote = siteOp
        ? (sitesMode === 'exclusive'
            ? ` · nur ${sites.length} User-Seite${sites.length === 1 ? '' : 'n'}`
            : ` · + ${sites.length} User-Seite${sites.length === 1 ? '' : 'n'}`)
        : '';
      const langNote = plan.queriesEn.length ? ` · 🌐 ${plan.queriesEn.length} EN` : '';
      // Issue 27: DDG-time-Filter aus dem User-Maxalter ableiten (1d → 'd',
      // 3d → 'w', 5d → 'w'). Planner-Wert wird dabei höchstens enger gemacht.
      const ageDays = getSiteMaxAgeDays();
      const ageFilter = ageDays <= 1 ? 'd' : 'w';
      const plannerFilter = plan.timeFilter || 'm';
      const order = { d: 0, w: 1, m: 2 };
      const timeFilter = order[ageFilter] < order[plannerFilter] ? ageFilter : plannerFilter;
      setProgress(`Suche im Web (${plannedQueries.length} Anfragen${scopeNote}${langNote}, max. ${ageDays} Tag${ageDays === 1 ? '' : 'e'})…`, null);
      const results = await Promise.allSettled(
        plannedQueries.map((pq) => api.search(pq.q, { max: 8, time: timeFilter, region: pq.region }))
      );
      results.forEach((r, i) => {
        const pq = plannedQueries[i];
        if (r.status === 'fulfilled') {
          let kept = 0;
          let dropped = 0;
          for (const it of (r.value.results || []).slice(0, 8)) {
            // Issue 9 + 11 + 27: best-effort Datum aus DDG-Snippet ODER
            // URL-Pfad (z.B. /2017/04/12/). Items mit erkennbarem Datum
            // älter als das User-Höchstalter (1|3|5 Tage) sofort verwerfen.
            // Wenn beides nichts liefert, übernimmt weiter unten ein
            // Trafilatura-Backstop (verifyWebItemDates).
            const parsedDate = detectArticleDate({ snippet: it.snippet, url: it.url });
            if (parsedDate && isArticleTooOldForSites(parsedDate)) { dropped++; continue; }
            // Issue 13: URL-artige Titel ("hostname.tld/pfad/seite") aus
            // DDG sanitisieren — Lokal-Bug: solche Treffer landeten als
            // Karten mit URL-Headline statt der eigentlichen Schlagzeile.
            const item = sanitizeItemTitle({
              title: it.title,
              snippet: it.snippet || '',
              url: it.url,
              source: sourceFromUrl(it.url),
              date: parsedDate ? parsedDate.toISOString() : '',
              origin: pq.scope,
              query: pq.q,
              lang: pq.lang,
            });
            webItems.push(item);
            kept++;
          }
          webDroppedOld += dropped;
          setProgress(null, `✓ „${pq.display}": ${kept} Treffer${dropped ? ` (${dropped} älter als ${ageDays} Tag${ageDays === 1 ? '' : 'e'} verworfen)` : ''}`);
        } else {
          setProgress(null, `✗ „${pq.display}": Fehler`);
        }
      });
    }

    // 4) Optional: Events — Listings holen, dann pro Seite scrapen und per LLM
    //    konkrete Einzelevents (Titel, Datum, Ort, Beschreibung) extrahieren.
    let concreteEvents = [];
    if (plan.eventQuery && plan.eventQuery.location) {
      // Issue 5/6: harte Fenster-Grenze (heute … +21 Tage). Search-`when` wird
      // mit dem Fenster-Hinweis angereichert, damit DDG bevorzugt aktuelle
      // Events findet — die zeitliche Eingrenzung passiert beim LLM-Extract
      // und dem Post-Filter (siehe extractEventsFromListings).
      const win = eventWindow();
      const whenRaw = (plan.eventQuery.when || '').trim();
      const whenAllowed = /^(heute|morgen|diese woche|nächste tage|naechste tage|nächste woche|naechste woche|kommende tage|wochenende|am wochenende)$/i;
      const when = whenAllowed.test(whenRaw) ? whenRaw : 'nächste Tage';
      const topicDe = plan.eventQuery.topic || '';
      const topicEn = plan.eventQuery.topicEn || '';

      setProgress(`Suche lokale Events (${when})…`, `Fenster: ${win.start} bis ${win.end}`);
      try {
        // Issue 13: `when` NICHT an /events/search durchreichen — der tools-
        // server packt es in Anführungszeichen ("nächste Tage") und findet
        // dann Wetterseiten statt Veranstaltungen. Das Zeitfenster wird ohnehin
        // erst client-seitig in extractEventsFromListings hart durchgesetzt.
        // Issue 6: zwei parallele Event-Anfragen — eine mit dem deutschen Topic,
        // eine mit dem englischen (falls vorhanden).
        const evCalls = [api.events({ location: plan.eventQuery.location, when: '', q: topicDe })];
        if (topicEn && topicEn !== topicDe) {
          evCalls.push(api.events({ location: plan.eventQuery.location, when: '', q: topicEn }));
        }
        const evResults = await Promise.allSettled(evCalls);
        const mergedRaw = [];
        for (const r of evResults) {
          if (r.status === 'fulfilled') mergedRaw.push(...(r.value.results || []));
        }
        // Issue 13: profile-basierte Direkt-Seeds (z.B. konstanz-info.com/events)
        // VOR die Such-Treffer setzen — damit echte Stadt-Eventkalender garantiert
        // gecrawlt werden, auch wenn DDG sie weiter unten in den Ergebnissen hat.
        const profileSeeds = buildLocalEventSeeds(profile);
        const listings = dedupeByUrl([...profileSeeds, ...mergedRaw]).slice(0, 10);
        setProgress(null, `✓ Event-Quellen: ${listings.length} Seiten${profileSeeds.length ? ` (${profileSeeds.length} aus Profil)` : ''}${topicEn && topicEn !== topicDe ? ` · DE+EN` : ''}`);

        if (listings.length) {
          setProgress('Lade & analysiere Event-Seiten…', null);
          const extracted = await extractEventsFromListings({
            listings,
            location: plan.eventQuery.location,
            when,
            topic: topicDe,
            window: win,
            profile,
          });
          concreteEvents = extracted.events;
          const dropped = extracted.dropped || 0;
          const rendered = extracted.rendered || 0;
          const droppedDistance = extracted.droppedDistance || 0;
          setProgress(null, `✓ ${concreteEvents.length} konkrete Events extrahiert${rendered ? ` (${rendered} via Playwright)` : ''}${dropped ? `, ${dropped} außerhalb ${win.start}…${win.end} verworfen` : ''}${droppedDistance ? `, ${droppedDistance} >${EVENT_MAX_KM} km verworfen` : ''}`);
        }

        // Issue 12: kein Listing-Fallback mehr! Vorher haben wir bei leerer
        // Events-Extraktion die Listing-URLs (Eventbrite/Meetup/Stadt-
        // kalender-Übersichten) als normale Web-Items eingespeist — der
        // Scorer hat sie dann oft wieder als "events" eingestuft und sie
        // erschienen als Event-Karten OHNE Datum/Ort. Genau das wollte
        // Issue 12 los werden ("nur die Quellseite statt konkreter Termine").
        // Stattdessen bleibt die Events-Rubrik bei leerer Extraktion einfach
        // leer und wird in renderNews weggelassen.
      } catch (e) {
        setProgress(null, `✗ Events: ${e.message}`);
      }
    }

    // 4b) Issue 14: Lokal-News-Extraktion — analog zu den Events crawlen wir
    //     regionale News-Listings (z.B. suedkurier.de/region/konstanz) und
    //     lassen den LLM daraus konkrete Einzelmeldungen im Format
    //     {title, date, source, summary} ziehen. Vor Issue 14 war die Lokal-
    //     Rubrik in der Praxis fast immer leer, weil weder RSS noch Web-Suche
    //     den Stadtnamen in den Schlagzeilen tragen — und die Wetter-Karte
    //     darüber den Eindruck erweckte „Lokal zeigt nur Wetter".
    // Issue 44: gefolgte Einzelartikel pro Pipeline-Stage sammeln, damit der
    // Assistant-RAG sie als zusätzliche Roh-Texte indexieren kann.
    let deepCrawlArticles = []; // [{url,title,text,date,source,parentUrl}]
    let concreteLocalNews = [];
    if (profile && Array.isArray(profile.locations) && profile.locations.length) {
      const homeName = (profile.locations[0].name || '').split(',')[0].trim();
      if (homeName) {
        setProgress('Suche lokale Nachrichten…', null);
        try {
          // Issue 17: findLocalNewsSeeds liefert jetzt {seeds, filteredJunk} —
          // damit wir im Progress-Log sehen, wie viele Tourismus-/Wetter-/
          // Social-Domains rausgefiltert wurden.
          // Issue 19: zusätzlich `filteredByLLM` + `classBreakdown` aus der
          // LLM-Vorab-Klassifikation (event/wetter/lokalnachricht/irrelevant)
          // — wir zeigen die Aufschlüsselung im Progress-Log, damit man
          // sieht, wo die Treffer hingehen statt nur „N Junk".
          const { seeds, filteredJunk, filteredByLLM, classBreakdown } = await findLocalNewsSeeds(profile);
          const cbParts = classBreakdown
            ? [
                classBreakdown.event ? `${classBreakdown.event}× event` : null,
                classBreakdown.wetter ? `${classBreakdown.wetter}× wetter` : null,
                classBreakdown['übersichtsseite'] ? `${classBreakdown['übersichtsseite']}× übersichtsseite` : null,
                classBreakdown.irrelevant ? `${classBreakdown.irrelevant}× irrelevant` : null,
              ].filter(Boolean).join(', ')
            : '';
          setProgress(null, `✓ Lokal-Quellen: ${seeds.length} Seiten${filteredJunk ? ` (${filteredJunk} Junk-Domains)` : ''}${filteredByLLM ? ` (LLM-Filter: ${filteredByLLM} weg${cbParts ? ` — ${cbParts}` : ''})` : ''}`);
          if (seeds.length) {
            setProgress('Lade & analysiere Lokal-Seiten…', null);
            const ex = await extractLocalNewsFromListings({
              listings: seeds,
              location: homeName,
              profile,
            });
            concreteLocalNews = ex.news;
            // Issue 44: gefolgte Einzelartikel-Texte für RAG mitnehmen
            if (ex.followedArticles && ex.followedArticles.length) {
              deepCrawlArticles.push(...ex.followedArticles);
            }
            const followNote = ex.followedArticles && ex.followedArticles.length
              ? `, ${ex.followedArticles.length} Einzelartikel tiefgescannt`
              : '';
            setProgress(null, `✓ ${concreteLocalNews.length} Lokal-Meldungen extrahiert${ex.rendered ? ` (${ex.rendered} via Playwright)` : ''}${ex.dropped ? `, ${ex.dropped} verworfen (Datum/Fenster)` : ''}${followNote}`);
          }
        } catch (e) {
          setProgress(null, `✗ Lokal: ${e.message || e}`);
        }
      }
    }

    // 4c) Issue 23: User-Sites-Crawl. Die manuell eingetragenen URLs werden
    //     via Playwright/Trafilatura geladen und per LLM-JSON klassifiziert
    //     (lokalnachricht / event / wetter / andere). Lokal-Items und Events
    //     werden in die jeweiligen Pools (concreteLocalNews / concreteEvents)
    //     prepended; andere Items landen als „beobachten"-Synth-Items in der
    //     all-Liste (s.u.). DDG-Snippets bleiben unverändert — siehe Schritt 3.
    let userSiteOtherItems = [];
    try {
      const us = await runUserSitesPipeline(profile, {
        log: (msg) => setProgress(null, msg),
      });
      // Issue 44: gefolgte Einzelartikel-Texte für RAG mitnehmen
      if (us.followedArticles && us.followedArticles.length) {
        deepCrawlArticles.push(...us.followedArticles);
      }
      if (us.localNews && us.localNews.length) {
        // an den Anfang setzen — User-eigene Quellen haben Priorität.
        const existing = new Set(concreteLocalNews.map((n) => n.url));
        const fresh = us.localNews.filter((n) => !existing.has(n.url));
        concreteLocalNews = [...fresh, ...concreteLocalNews];
      }
      if (us.events && us.events.length) {
        const existing = new Set(concreteEvents.map((e) => e.url));
        const fresh = us.events.filter((e) => !existing.has(e.url));
        // an den Anfang — User-Quellen vor DDG-Listing-Events.
        concreteEvents = [...fresh, ...concreteEvents];
      }
      if (us.other && us.other.length) {
        // „andere"-Items landen als Synth-Items in der all-Liste und gehen
        // durch Scoring → Bucketize. Wir bauen sie analog zu Lokal-Synth.
        userSiteOtherItems = us.other.map((it) => ({
          title: it.title,
          snippet: it.summary || '',
          summary: it.summary || '',
          url: it.url,
          source: it.source,
          date: it.date,
          origin: 'user-site',
          // Hinweis fürs Scoring: wir setzen direkt eine moderate relevance,
          // damit sie nicht im 60-Item-Cap untergehen.
          location: it.location || '',
        }));
      }
    } catch (e) {
      setProgress(null, `✗ Eigene Webseiten: ${e.message || e}`);
    }

    // 4d) Issue 24: Kalender-Einträge des Users als zusätzliche Events
    //     einspeisen. Sie sind explizit gesetzt → werden VOR alle anderen
    //     gestellt, kein Distanz-Filter, keine LLM-Extraktion mehr nötig.
    //     URL bleibt leer (oder verweist auf den Setup-Tab — wir nehmen #setup
    //     als Anker, der greift via initTabs/Hash).
    try {
      const upcoming = calendarUpcoming(EVENT_WINDOW_DAYS);
      if (upcoming.length) {
        const win = eventWindow();
        const calEvents = upcoming
          .filter((c) => c.date >= win.start && c.date <= win.end)
          .map((c) => ({
            title: c.title,
            date: c.date,
            time: c.time || '',
            description: c.notes || '',
            summary: c.notes || '',
            location: c.location || '',
            event_name: c.title,
            event_date: c.date,
            event_time: c.time || '',
            event_summary: c.notes || '',
            event_location: c.location || '',
            url: '',
            source: c.source ? `Mein Kalender · ${c.source}` : 'Mein Kalender',
            distanceKm: null,
            origin: 'calendar',
          }));
        if (calEvents.length) {
          const existing = new Set(concreteEvents.map((e) => `${(e.title || e.event_name || '').toLowerCase()}|${e.date || e.event_date || ''}`));
          const fresh = calEvents.filter((e) => !existing.has(`${(e.title || '').toLowerCase()}|${e.date || ''}`));
          if (fresh.length) {
            concreteEvents = [...fresh, ...concreteEvents];
            setProgress(null, `✓ ${fresh.length} Termin${fresh.length === 1 ? '' : 'e'} aus deinem Kalender ergänzt`);
          }
        }
      }
    } catch (e) {
      console.warn('calendar merge failed', e);
    }

    // 4e) Issue 26: RSS-Artikel per LLM klassifizieren.
    //
    // Analog zu Issue 23 (User-Sites-Crawl) durchlaufen RSS-Items eine
    // JSON-Klassifikation in vier Kategorien: lokalnachricht / event /
    // wetter / andere. Items werden in die passenden Pools verteilt:
    //   - lokalnachricht → concreteLocalNews (Lokal-Rubrik)
    //   - event          → concreteEvents (Events-Rubrik, Datum im Fenster)
    //   - wetter         → verworfen (eigene Wetter-Karte)
    //   - andere         → bleibt in rssItems (Default-Flow, Scoring + Bucketize)
    //
    // Damit landet ein „Polizei warnt vor Trickbetrügern in Petershausen"-
    // RSS-Artikel direkt in der Lokal-Rubrik, statt im Beobachten-Bucket
    // unterzugehen — und ein „Konzert am 25.05. im K9"-Item kommt sauber
    // in die Events-Rubrik mit Event-Card-Rendering. Wetter-Wackel-Boxen
    // verschwinden, weil die App ihre eigene Wetter-Karte hat.
    let rssClassStats = null;
    if (rssItems.length) {
      try {
        setProgress(`Klassifiziere ${rssItems.length} RSS-Artikel per LLM…`, null);
        const classified = await classifyRssArticles(rssItems);
        const eventWin = eventWindow();
        const homeName = profile && profile.locations && profile.locations[0]
          ? (profile.locations[0].name || '').split(',')[0].trim()
          : '';
        const stats = { lokalnachricht: 0, event: 0, wetter: 0, übersichtsseite: 0, andere: 0, eventDroppedNoDate: 0 };
        const remainingRss = [];
        const newLocal = [];
        const newEvents = [];

        // Existing-Sets für URL-basierte Dedupe vorbereiten
        const existingLocalUrls = new Set(concreteLocalNews.map((n) => n.url));
        const existingEventUrls = new Set(concreteEvents.map((e) => e.url).filter(Boolean));

        for (const it of classified) {
          // Issue 27: Übersichtsseiten (Ressort-Hubs, Themen-Listen,
          // Newsticker ohne konkreten Einzelartikel) komplett verwerfen.
          if (it.typ === 'übersichtsseite') {
            stats['übersichtsseite']++;
            continue;
          }
          if (it.typ === 'lokalnachricht') {
            stats.lokalnachricht++;
            if (existingLocalUrls.has(it.url)) continue;
            newLocal.push({
              title: it.title,
              date: it.date || '',
              location: it.location || '',
              source: it.source || sourceFromUrl(it.url) || '',
              summary: it.snippet || '',
              url: it.url,
              typ: 'Nachricht',
              // Issue 34: Herkunfts-Tag, damit der Lokal-Bucket diese Items NICHT
              // wie die echte Karten-Quelle (lokal-extract) als Cluster behandelt
              // — sondern sie in den Round-Robin-Tail einreiht. So bricht der
              // Quellen-Wechsel die Dominanz eines einzelnen RSS-Feeds (z.B.
              // Polizei-Pressemitteilungen) auf.
              origin: 'rss',
            });
          } else if (it.typ === 'event') {
            // Event nur übernehmen, wenn ein konkretes Datum im Fenster
            // liegt — RSS-Items ohne Datum als Event sind selten sinnvoll
            // (echte Event-Ankündigungen tragen das Datum im Titel oder
            // Snippet, der Klassifikator hat es dann gesetzt).
            const evDate = (it.date || '').slice(0, 10);
            if (!evDate || evDate < eventWin.start || evDate > eventWin.end) {
              stats.eventDroppedNoDate++;
              // Item nicht als andere behandeln — es ist klar als Event
              // markiert. Wir lassen es raus, statt es in die Lokal-/
              // Beobachten-Rubrik zu drücken.
              continue;
            }
            stats.event++;
            if (existingEventUrls.has(it.url)) continue;
            newEvents.push({
              title: it.title,
              date: evDate,
              time: '',
              description: it.snippet || '',
              summary: it.snippet || '',
              location: it.location || homeName,
              event_name: it.title,
              event_date: evDate,
              event_time: '',
              event_summary: it.snippet || '',
              event_location: it.location || homeName,
              url: it.url,
              source: it.source || sourceFromUrl(it.url) || '',
              distanceKm: null,
              origin: 'rss',
            });
          } else if (it.typ === 'wetter') {
            stats.wetter++;
            // verworfen — Wetter hat eine eigene Karte
          } else {
            stats.andere++;
            remainingRss.push(it);
          }
        }

        if (newLocal.length) {
          concreteLocalNews = [...newLocal, ...concreteLocalNews];
        }
        if (newEvents.length) {
          concreteEvents = [...newEvents, ...concreteEvents];
        }
        // rssItems schrumpft auf die "andere"-Items + fail-open-Restmenge
        rssItems = remainingRss;
        rssClassStats = stats;

        const parts = [];
        if (stats.lokalnachricht) parts.push(`${stats.lokalnachricht}× lokal`);
        if (stats.event) parts.push(`${stats.event}× event`);
        if (stats.wetter) parts.push(`${stats.wetter}× wetter (verworfen)`);
        if (stats['übersichtsseite']) parts.push(`${stats['übersichtsseite']}× übersichtsseite (verworfen)`);
        if (stats.andere) parts.push(`${stats.andere}× andere`);
        if (stats.eventDroppedNoDate) parts.push(`${stats.eventDroppedNoDate}× event ohne Datum (verworfen)`);
        setProgress(null, `✓ RSS-Klassifikation: ${parts.join(', ') || 'keine Treffer'}`);
      } catch (e) {
        console.warn('rss classification failed', e);
        setProgress(null, `✗ RSS-Klassifikation: ${e.message || e} — Items laufen unklassifiziert weiter`);
      }
    }

    // 4f) Issue 38: PubMed-Studien für medizinisch interessierte User.
    //
    // Trigger: `health_watch`/`medizin`-Modul im Profil ODER HEALTH_HINTS-Match
    //          im Interessen-Freitext. Ohne medizinisches Interesse läuft
    //          die Pipeline nicht und wir verschwenden keinen LLM-Call.
    //
    // Datums-Fenster: identisch zu RSS/Web/User-Sites — `getSiteMaxAgeDays()`
    //          (User-Wahl 1|3|5 Tage). PubMed indexiert mit Verzögerung; bei
    //          1 Tag sind oft 0 Studien drin — der User kann den Wert hoch-
    //          setzen, wenn das stört. Konzept-Vorgabe: „den angegebenen
    //          Zeitrahmen aus den bestehenden Einstellungen berücksichtigen".
    //
    // Output: `pubmedItems` mit origin='pubmed', deutschem Summary, Score-
    //          Felder werden weiter unten in `bucketizeItems` gesetzt. Wir
    //          leiten sie NICHT durch `scoreArticles` — sie sind kuratierte
    //          Studien und sollen im Medizin-Bucket auch dann landen, wenn
    //          das Scoring-Budget (60-Items-Cap) eng wäre.
    let pubmedItems = [];
    let pubmedDebug = null;
    try {
      const pm = await runPubmedPipeline({
        profile,
        interests,
        log: (msg) => setProgress(null, msg),
      });
      pubmedItems = pm.items || [];
      pubmedDebug = pm;
    } catch (e) {
      console.warn('pubmed pipeline failed', e);
      setProgress(null, `✗ PubMed: ${e.message || e}`);
    }

    // 5) Dedupe & cap (Issue 10: YouTube-Items kommen hier mit rein)
    // Issue 15: ytItems an den Anfang der Dedupe — sonst landen sie hinter
    // 30-50 RSS + 50-70 Web-Treffern auf Position >60 und werden vom
    // `slice(0, 60)`-Cap (siehe `capped` weiter unten) abgeschnitten, bevor
    // sie überhaupt ins Scoring gehen. Konsequenz wäre: leere YouTube-Rubrik
    // trotz korrekt geladener Videos. ytItems sind durch YOUTUBE_MAX_VIDEOS_
    // PER_RUN ohnehin auf 8 gedeckelt, also kein Risiko, dass sie den Rest
    // verdrängen.
    // Issue 23: userSiteOtherItems (Items aus dem User-Sites-Crawl, die der
    // LLM als "andere" klassifiziert hat) ebenfalls weit nach vorn — der
    // User hat die Quellen selbst gewählt, sie sollen im Cap überleben.
    let all = dedupeByUrl([...ytItems, ...userSiteOtherItems, ...rssItems, ...webItems]);
    const totalDroppedOld = rssDroppedOld + webDroppedOld;

    // Issue 11: Backstop — Web-Items, die nach Snippet+URL-Parsing immer noch
    // KEIN Datum haben (Beispiel: Spiegel-Druckmagazin-URLs wie
    // /spiegel/…-a-1134102.html, die DDG ohne Datums-Snippet zurückgibt),
    // werden jetzt einzeln per Trafilatura verifiziert. Cap auf 40 Calls pro
    // Lauf, damit der Tools-Server bei großen Resultsets nicht überlastet wird.
    // RSS-Items haben ihren `isoDate` aus dem Feed, YouTube-Items ihr
    // `publishedTs`, Events bringen ihr Datum vom Extract mit — die werden
    // hier nicht angefasst. Nur klassische Web-Such-Items (`origin in {web,
    // sites, web-en}`) sind betroffen.
    const verifiable = all.filter((it) =>
      !it.date
      && it.url
      && (it.origin === 'web' || it.origin === 'sites' || it.origin === 'web-en')
    );
    let backstopDropped = 0;
    let backstopVerified = 0;
    if (verifiable.length) {
      const sliced = verifiable.slice(0, 40);
      setProgress(`Prüfe ${sliced.length} Artikel ohne Snippet-Datum (Trafilatura)…`, null);
      const { kept, dropped, verified } = await verifyWebItemDates(sliced);
      backstopDropped = dropped;
      backstopVerified = verified;
      if (dropped) {
        const dropUrls = new Set(sliced.map((it) => it.url));
        const keptUrls = new Set(kept.map((it) => it.url));
        all = all.filter((it) => !dropUrls.has(it.url) || keptUrls.has(it.url));
      }
      setProgress(null, `✓ Datums-Backstop: ${verified} bestätigt${dropped ? `, ${dropped} >${siteMaxAgeDays}d verworfen` : ''}${sliced.length < verifiable.length ? ` (${verifiable.length - sliced.length} ungeprüft, Cap erreicht)` : ''}`);
    }
    const totalDropped = totalDroppedOld + backstopDropped;

    setProgress(`Bewerte ${all.length} Artikel…`, `Gesamt: ${rssItems.length} RSS + ${webItems.length} Web${ytItems.length ? ` + ${ytItems.length} YouTube` : ''}${concreteEvents.length ? ` + ${concreteEvents.length} Events` : ''} → ${all.length} nach Dedupe${totalDropped ? ` (Issue 27: ${totalDropped} >${siteMaxAgeDays}d verworfen${backstopDropped ? `, davon ${backstopDropped} via Trafilatura-Backstop` : ''})` : ''}`);

    // Issue 28: bei leerem Item-Pool NICHT mehr hart abbrechen. Vor Issue 28
    // warf der Code hier `throw new Error('Keine Artikel gefunden')` — Folge:
    // ALLE bis hierhin gesammelten Daten (Events, Lokal-Extraktion,
    // User-Sites-Items, gerade neu erzeugtes Profil) gingen verloren, und
    // der User sah als Antwort eine rote Fehler-Toast. Nach Issue 27 ist
    // ein leerer scored-Pool deutlich wahrscheinlicher (3-Tage-Cutoff +
    // aggressive Übersichtsseiten-Filterung), und es war oft so, dass
    // Events oder Lokal-News durchaus vorhanden waren — nur die normalen
    // Web-/RSS-Items waren zu alt oder als Hub-Seiten klassifiziert.
    //
    // Neu: wir prüfen, ob nach den Extraktoren UND dem Scorer-Pool wirklich
    // KEIN Item übrig ist. Wenn doch noch Events oder Lokal-News da sind,
    // rendern wir damit weiter (kein Scoring/Briefing nötig — der Rest des
    // Flows läuft mit `scoredItems = []`). Wenn ALLES leer ist, zeigen wir
    // einen freundlichen Hinweis-Cache (nicht den harten Empty-State) und
    // brechen den Flow geordnet ab — so bleibt die Wetter-Karte, das Profil
    // und der Setup-Tab vollständig nutzbar.
    if (!all.length) {
      // Issue 38: auch der PubMed-Pool zählt als „nichtleere" Extractor-
      // Quelle. Sonst würde die App im Edge-Case „keine RSS/Web-Treffer,
      // aber 5 frische Studien" auf den Empty-State fallen und die
      // Studien verwerfen.
      const haveExtractor = concreteEvents.length || concreteLocalNews.length || pubmedItems.length;
      if (!haveExtractor) {
        $('#empty-state').classList.remove('hidden');
        // Wetter trotzdem laden, damit der User wenigstens das sieht.
        let fallbackWeather = null;
        try { fallbackWeather = await fetchWeather(profile); } catch {}
        const emptyCache = {
          generatedAt: Date.now(),
          greeting: '',
          items: [],
          events: [],
          localNews: [],
          buckets: null,
          top5: [],
          weather: fallbackWeather,
          profileSummary: profile ? {
            locations: profile.locations.map((l) => l.name),
            modules: profile.modules.map((m) => m.id),
          } : null,
          plan: {
            queriesDe: plan.queriesDe,
            queriesEn: plan.queriesEn,
            timeFilter: plan.timeFilter,
            eventQuery: plan.eventQuery,
          },
        };
        store.set(LS.cache, emptyCache);
        store.set(LS.cacheMeta, { generatedAt: emptyCache.generatedAt, count: 0 });
        store.set(LS.lastSummarizeAt, emptyCache.generatedAt);
        try { renderNews(emptyCache); } catch (e) { console.warn('renderNews failed', e); }
        try { renderProfileBox(); } catch (e) { console.warn('renderProfileBox failed', e); }
        setProgress('Keine frischen Artikel', null, true);
        const ageHint = `(Cutoff: ${siteMaxAgeDays} Tag${siteMaxAgeDays === 1 ? '' : 'e'})`;
        toast(`Keine Artikel im ${ageHint}-Fenster. Profil & Wetter sind aktualisiert — Quellen oder Zeitraum prüfen.`, 'info', 6000);
        return;
      }
      setProgress(null, `· Kein scored-Pool, aber ${concreteEvents.length} Events / ${concreteLocalNews.length} Lokal-News — rendern direkt aus den Extraktoren.`);
    }

    // 6) LLM-Scoring (in einem Call, max 60 Items) — Briefing wird separat erzeugt
    const capped = all.slice(0, 60);
    const seenUrls = loadSeenUrls();
    const userHosts = getUserSiteHosts();
    // Issue 28: Scorer-Aufruf nur wenn wir tatsächlich Items haben (sonst
    // unnötiger LLM-Call mit leerem Array, und manche Modelle reagieren mit
    // Parse-Fehler auf leeren Input). Wenn `capped.length === 0`, gehen wir
    // direkt mit `scoredItems=[]` weiter — Events/Lokal-News aus den
    // Extraktoren befüllen die Rubriken alleine.
    let scored = { items: [] };
    if (capped.length) {
      try {
        scored = await scoreArticles({
          interests, items: capped, profile, portfolio, seenUrls, userHosts,
        });
      } catch (e) {
        console.warn('scoreArticles failed', e);
        setProgress(null, `⚠ Scoring fehlgeschlagen: ${e.message || e}`);
      }
    }

    // 7) Merge & sort — Issue 8: jedes Item bekommt die hybride Score-Struktur
    //    und Felder relevance_type / evidence / bucket. relevance bleibt für
    //    UI-Kompat (Sortierung & Chip-Anzeige) erhalten.
    const scoredItems = (scored.items || []).map((s) => {
      const base = capped[s.index];
      // Issue 10: bei YouTube-Items zeigt die Karte/Briefing die längere
      // Video-Zusammenfassung statt der knappen Scorer-Summary.
      const isYt = base.origin === 'youtube' && !!base.ytSummary;
      return {
        ...base,
        relevance: typeof s.score === 'number' ? Math.max(0, Math.min(10, s.score)) : 5,
        score01: typeof s.score01 === 'number' ? s.score01 : 0.5,
        components: s.components || null,
        noise_penalty: s.noise_penalty || 0,
        // Issue 32: Interesse + Betroffenheit (1..10 jeweils) plus Summe.
        // Primäres Sortierkriterium ab Issue 32 ist scoreSum (vorher
        // relevance) — siehe Konzept Issue 32.
        interestScore: typeof s.interestScore === 'number' ? s.interestScore : 3,
        affectednessScore: typeof s.affectednessScore === 'number' ? s.affectednessScore : 2,
        affectednessNote: typeof s.affectednessNote === 'string' ? s.affectednessNote : '',
        scoreSum: typeof s.scoreSum === 'number' ? s.scoreSum : 5,
        summary: isYt ? base.ytSummary : (s.summary || base.snippet || ''),
        relevance_type: s.relevance_type || 'general',
        evidence: s.evidence || '',
        bucket: s.bucket || 'beobachten',
        // Issue 22: LLM-Backstop für `date` (bei Items ohne erkennbares Snippet/
        // URL-Datum) und `location` (nur bei lokalen Items gesetzt — siehe
        // scoreArticles). Bestehendes `base.date` gewinnt, das LLM-Datum dient
        // nur als Fallback.
        date: base.date || s.date || '',
        location: s.location || '',
      };
    }).filter((x) => x.title).sort((a, b) => (b.scoreSum || 0) - (a.scoreSum || 0));

    // Issue 8: seenUrls aktualisieren (für nächsten Novelty-Score)
    persistSeenUrls(seenUrls, scoredItems.map((x) => x.url));

    // Issue 8: Quell-Hosts still ins Profil übernehmen ("Webseitenvorschläge
    // automatisch"). Nur fortpflanzen, wenn das Profil existiert.
    if (profile) mergeDiscoveredSources(profile, scoredItems);

    // 7b) Issue 8 + 14 + 20: Items in Rubriken einsortieren. concreteLocalNews
    //     wird in den Lokal-Bucket vorangestellt (siehe bucketizeItems).
    //     Issue 20: Top 5 ist jetzt ein Querschnitt PRO Rubrik (je bester Treffer
    //     aus lokal/youtube/tech/watchlist/medizin/beobachten, round-robin
    //     nachgefüllt bei <5 gefüllten Rubriken). Vorher slice(0,5) auf dem
    //     Gesamt-Score-Pool → führte zu Übersichtsseiten in Top 5.
    // Issue 38: PubMed-Items als zusätzlicher Pool für die Medizin-Rubrik.
    // Werden in `bucketizeItems` als Kopf-Cluster mit Score 16 oben in
    // `medizin` eingehängt, analog zu lokal-extract in `lokal`.
    const buckets = bucketizeItems(scoredItems, concreteEvents, concreteLocalNews, profile, pubmedItems);
    const top5 = pickTop5FromBuckets(buckets);

    // 7c) Wetter parallel — kostet uns kaum was, Cache greift im 3h-Fenster.
    let weather = null;
    try { weather = await fetchWeather(profile); } catch {}

    // 7d) Briefing (Issue 8): bekommt Rubriken-Vorgabe; weniger spekulativ.
    // Issue 24 Bug-Fix: composeBriefing kann LEER zurückkommen, wenn der LLM
    // throwt oder ein leeres Reply liefert. Vor Issue 24 sah der User dann
    // gar keine Zusammenfassung — die #greeting-Box blieb hidden. Jetzt
    // fällt der Code auf eine lokal synthetisierte Kurz-Zusammenfassung
    // zurück, damit IMMER ein Briefing-Text da ist.
    // Issue 29: composeBriefing macht jetzt intern Retry+Modell-Switch.
    // Diese Aufrufstelle bleibt im Wesentlichen unverändert, aber die
    // Console-Warnings vom Briefing-Pfad helfen beim Debuggen wenn beide
    // Modelle leer zurückkommen (typischer Grund: extrem lange Prompts in
    // Kombination mit der Reasoning-Token-Eigenheit von DeepSeek V4 Flash).
    let briefing = '';
    let briefingFailureReason = '';
    // Issue 36: Snapshot der Telemetrie zum Failure-Zeitpunkt. Wird in den
    // Cache persistiert, damit der Debug-Knopf in der greeting-Box auch nach
    // einem Page-Reload sichtbar bleibt (in-Memory-Ringpuffer ist sonst leer).
    let briefingFailureTelemetry = null;
    if (plan.greetingDesired !== false && scoredItems.length) {
      setProgress('Schreibe Tages-Zusammenfassung…', null);
      try {
        briefing = await composeBriefing({
          interests,
          profile,
          buckets,
          top5,
          weather,
        });
        if (!briefing) {
          // Issue 35: Telemetry-Summary anhängen — der User sieht im
          // Progress-Log, ob aimlapi z.B. 429/503 gefeuert hat statt nur
          // „LLM lieferte keinen Text".
          const telem = summarizeLlmTelemetry(10);
          briefingFailureReason = `LLM lieferte trotz Retry + Modell-Wechsel keinen Text${telem ? ` · letzte 10 Calls: ${telem}` : ''}`;
          briefingFailureTelemetry = recentLlmTelemetry(15).slice();
        }
      } catch (e) {
        console.warn('briefing failed', e);
        briefing = '';
        const telem = summarizeLlmTelemetry(10);
        briefingFailureReason = `LLM-Aufruf warf: ${e && e.message ? e.message : e}${telem ? ` · letzte 10 Calls: ${telem}` : ''}`;
        briefingFailureTelemetry = recentLlmTelemetry(15).slice();
      }
    }
    if (!briefing && scoredItems.length) {
      briefing = buildFallbackBriefing({ buckets, top5, weather, concreteEvents });
      if (briefing) {
        const reason = briefingFailureReason || 'LLM lieferte keinen Text';
        setProgress(null, `· Fallback-Zusammenfassung lokal erzeugt (${reason})`);
        if (!briefingFailureReason) briefingFailureReason = reason;
        if (!briefingFailureTelemetry) briefingFailureTelemetry = recentLlmTelemetry(15).slice();
      }
    }

    // 8) Cache & render
    const cache = {
      generatedAt: Date.now(),
      greeting: briefing || '',
      items: scoredItems,
      events: concreteEvents,
      // Issue 14: extrahierte Lokal-News persistieren, damit eine reine
      // Cache-Anzeige (ohne neuen Run) die Lokal-Rubrik weiter zeigt. Wird
      // beim nächsten bucketizeItems-Aufruf nicht direkt verwendet — die
      // gerenderte Form lebt in cache.buckets.lokal —, ist aber als
      // separater Pool für künftige Auswertungen praktisch.
      localNews: concreteLocalNews,
      // Issue 38: PubMed-Studien separat persistieren (analog zu localNews).
      // Die gerenderte Form lebt in cache.buckets.medizin; der separate
      // Pool bleibt als Diagnose-Quelle (welche Queries lieferten was) und
      // für künftige Auswertungen erhalten.
      pubmedStudies: pubmedItems,
      pubmedQueries: pubmedDebug ? (pubmedDebug.queries || []) : [],
      buckets,
      top5,
      weather,
      profileSummary: profile ? {
        locations: profile.locations.map((l) => l.name),
        modules: profile.modules.map((m) => m.id),
      } : null,
      plan: {
        queriesDe: plan.queriesDe,
        queriesEn: plan.queriesEn,
        timeFilter: plan.timeFilter,
        eventQuery: plan.eventQuery,
      },
      // Issue 36: Failure-Kontext für den Debug-Knopf neben dem
      // „lokal erzeugt"-Hinweis. Nur gesetzt, wenn der Fallback-Pfad aktiv war.
      briefingFailureReason: briefingFailureReason || null,
      briefingFailureTelemetry: briefingFailureTelemetry || null,
    };
    store.set(LS.cache, cache);
    store.set(LS.cacheMeta, { generatedAt: cache.generatedAt, count: scoredItems.length });
    // Issue 10: lastSummarizeAt erst HIER setzen — der YouTube-Cutoff oben
    // basiert auf dem alten Wert, ab dem nächsten Run greift die neue Marke.
    store.set(LS.lastSummarizeAt, cache.generatedAt);
    // Issue 28: Render-Errors fangen, damit die bereits in LS persistierten
    // Daten nicht verloren wirken, wenn ein einzelner Renderer wirft (z.B.
    // ein unerwartetes Feld im Cache). Im ersten Schritt wird die News-View
    // gefüllt, im zweiten der Setup-Tab — bei Render-Fehler steht die
    // Information immer noch nach einem Page-Reload zur Verfügung.
    try { renderNews(cache); } catch (e) {
      console.warn('renderNews failed', e);
      setProgress(null, `⚠ Render-Fehler News: ${e.message || e} — gespeichert, Reload zeigt die Daten.`);
    }
    try { renderProfileBox(); } catch (e) {
      console.warn('renderProfileBox failed', e);
      setProgress(null, `⚠ Render-Fehler Profil: ${e.message || e} — gespeichert, Reload zeigt die Daten.`);
    }

    // Issue 24: KI-Assistent — alle frisch gescorten Items + Events in den
    // RAG-Namespace dieses Browsers indexieren. Der Assistent (siehe
    // initAssistant) liest später daraus. Best-effort; bei Fehler nur Log,
    // der Hauptflow geht weiter.
    // Issue 38: PubMed-Studien zusätzlich in den Assistant-RAG-Index legen,
    // damit Fragen wie „Was gibt es Neues zu meiner Diagnose?" semantisch
    // gefunden werden. Sie sind kein Teil von `scoredItems` (eigene Pipeline),
    // deshalb hier explizit dazumischen.
    //
    // Issue 44: ALLE heruntergeladenen Roh-Inhalte mit in den Index — sodass
    // der Assistent nicht nur über Titel/Kurzbeschreibung, sondern über die
    // vollständigen Transkript-/Artikel-Texte semantisch suchen kann:
    //   - `transcripts`: vollständige YouTube-Transkripte (oft 5000-30000 Zeichen)
    //   - `deepArticles`: per Tiefenscan gefolgte Einzelartikel (aus User-Sites
    //                     + Lokal-News-Pipeline)
    //   - `rssRaw`: RSS-Item-Snippets, damit auch nicht-rangierte RSS-Inhalte
    //                durchsuchbar werden (selbst wenn sie kein scoredItem wurden)
    // Indexierung passt darüber den Roh-Text in 1200-Zeichen-Chunks mit
    // 150-Zeichen-Overlap an, damit MiniLM-L12-v2 (max ~500 Tokens) sauber
    // embedden kann.
    const rssRawForIndex = [
      ...(rssItems || []).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        source: r.source || sourceFromUrl(r.url) || '',
        date: r.date || '',
        text: r.snippet || '',
      })),
    ].filter((r) => r.title && (r.text || r.url));
    // Issue 44: extrahierte Lokal-News in den Index aufnehmen — sie laufen
    // außerhalb des Scoring-Pfads (concreteLocalNews wird in den Lokal-Bucket
    // gerendert, taucht aber NICHT in scoredItems auf). Vor Issue 44 fielen
    // sie damit aus dem Assistant-Index raus. Wir bilden sie auf das Items-
    // Shape ab (title/summary/url/source/date/location), damit der bestehende
    // `kind:'news'`-Block sie unverändert mit-indexiert.
    const localNewsForIndex = (concreteLocalNews || []).map((n) => ({
      title: n.title || '',
      summary: n.summary || '',
      snippet: n.summary || '',
      url: n.url || '',
      source: n.source || sourceFromUrl(n.url) || '',
      date: n.date || '',
      location: n.location || '',
      bucket: 'lokal',
      origin: n.origin || 'lokal-extract',
    })).filter((n) => n.title);
    indexNewsForAssistant({
      items: [...scoredItems, ...pubmedItems, ...localNewsForIndex],
      events: concreteEvents,
      buckets,
      weather,
      transcripts: ytTranscripts,
      deepArticles: deepCrawlArticles,
      rssRaw: rssRawForIndex,
    }).catch((e) => console.warn('rag index failed', e));

    setProgress('Fertig', null, true);
    toast(`${scoredItems.length} Artikel ausgewertet`, 'success');
  } catch (e) {
    console.error(e);
    setProgress('Fehler', null, true);
    toast(`Fehler: ${e.message || e}`, 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

async function planSearches({ interests, portfolio, rssTitles }) {
  const today = new Date().toISOString().slice(0, 10);
  const win = eventWindow();
  // Issue 6: Plan-Output bekommt zwei Query-Listen — deutsch und englisch —
  // damit internationale Themen (AI, Märkte, Geopolitik) auch englische
  // Quellen treffen. Außerdem topicEn im eventQuery für englische Plattformen.
  const sys = `Du planst eine personalisierte News-Übersicht. Heute ist ${today}.
Eingaben:
- Freitext-Interessen des Users
- Aktien-Portfolio (Symbole)
- Titel aus den RSS-Feeds des Users (Kontext)

Gib AUSSCHLIESSLICH JSON zurück (kein Markdown), Struktur:
{
  "queriesDe": ["3-5 deutsche Web-Suchbegriffe, präzise & aktuell"],
  "queriesEn": ["2-4 englische Pendants — wichtig für internationale Themen"],
  "timeFilter": "d" | "w" | "m",
  "alertThreshold": number | null,
  "eventQuery": { "location": "Ort", "when": "heute|diese Woche|nächste Tage|nächste Woche", "topic": "", "topicEn": "" } | null,
  "greetingDesired": true|false
}
Regeln:
- queriesDe: kurze, deutsche Suchbegriffe, jeweils 2-7 Wörter, mit aktuellen Eigennamen/Themen aus den Interessen. Wenn das Portfolio relevante Aktien enthält, ergänze 1 Aktien-News-Query pro wichtiger Position.
- queriesEn: englische Übersetzung/Pendants der INTERNATIONALEN Themen. Beispiele: "KI"/"Künstliche Intelligenz" → "AI news", "artificial intelligence latest"; "EU-Politik" → "EU politics this week"; Aktien-News IMMER auch englisch (z.B. "AAPL earnings", "Tesla news"), weil Finanz-Tickermeldungen primär englischsprachig sind. Bei rein lokal-deutschen Themen (Stadtrat Konstanz, Wahl Bayern) kann das Array leer bleiben.
- ⚠️ NIEMALS Wetter-Queries generieren (kein „Wetter <Stadt>", kein „Wettervorhersage", kein „weather forecast"). Die App hat eine eigene Wetter-Karte oben in der Übersicht und braucht keine zusätzlichen Wetter-Treffer.
- timeFilter: "d"=letzte 24h (default für tagesaktuelle News), "w"=Woche, "m"=Monat (Hartlimit — Artikel sollen NIE älter als 1 Monat sein, Issue 9). Tipp: für Tech/AI/Forschungs-Themen lieber "w" als "d" — gute Analysen sind oft mehrere Tage alt. Für historisch wirkende Anfragen "m" wählen, nicht null.
- alertThreshold: Wenn der User eine Prozent-Schwelle für Kursänderungen nennt (z.B. "bei 5%"), gib die Zahl zurück, sonst null.
- eventQuery: NUR wenn der User lokale Events / Veranstaltungen / Konzerte erwähnt. Sonst null. WICHTIG: "when" muss zeitnah sein (heute, diese Woche, nächste Tage, nächste Woche) — niemals Monate oder Jahre voraus. Default bei Unsicherheit: "nächste Tage" (= heute bis ${win.end}, ca. ${win.days} Tage Fenster). topicEn = englische Übersetzung von topic ("Konzert" → "concert", "Lesung" → "reading", "Theater" → "theater"), leer wenn topic leer.
- greetingDesired: true wenn User positive/ermutigende Zusammenfassung wünscht, sonst true als sicherer Default.`;

  const user = `INTERESSEN:
${interests || '(keine angegeben)'}

PORTFOLIO:
${portfolio.length ? portfolio.map((p) => `- ${p.symbol}${p.name ? ` (${p.name})` : ''}`).join('\n') : '(leer)'}

RSS-FEED-TITEL (Auszug, Kontext):
${rssTitles.length ? rssTitles.slice(0, 20).map((t) => `- ${t}`).join('\n') : '(keine RSS-Feeds)'}`;

  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    max_tokens: 700,
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  // Issue 27: defensiv Wetter-Queries rausfiltern, falls der LLM die explizite
  // Verbots-Regel ignoriert (deutsch + englisch, einschließlich Schreibweisen).
  const WEATHER_QUERY_RE = /\b(wetter|wettervorhersage|wetterbericht|wetterprognose|niederschlag|temperaturen|weather|forecast|temperature|precipitation)\b/i;
  const cleanArr = (a, max) => Array.isArray(a)
    ? a
        .filter((x) => typeof x === 'string' && x.trim().length)
        .map((x) => x.trim())
        .filter((x) => !WEATHER_QUERY_RE.test(x))
        .slice(0, max)
    : [];
  // Issue 6: Backwards-compat — falls das LLM (oder ein älterer Cache) noch
  // das alte "queries"-Feld liefert, als deutsch interpretieren.
  const queriesDe = cleanArr(parsed.queriesDe, 6).length
    ? cleanArr(parsed.queriesDe, 6)
    : cleanArr(parsed.queries, 6);
  const queriesEn = cleanArr(parsed.queriesEn, 5);
  return {
    queriesDe,
    queriesEn,
    // Issue 9: "y" wird nicht mehr akzeptiert (Höchstalter 1 Monat); null/ungültig → "m".
    timeFilter: ['d', 'w', 'm'].includes(parsed.timeFilter) ? parsed.timeFilter : 'm',
    alertThreshold: typeof parsed.alertThreshold === 'number' ? parsed.alertThreshold : null,
    eventQuery: parsed.eventQuery && parsed.eventQuery.location ? parsed.eventQuery : null,
    greetingDesired: parsed.greetingDesired !== false,
  };
}

// Issue 8: Scoring komplett umgebaut.
//
// Das LLM liefert nur noch die SUBJEKTIVEN Signale (interest_match,
// actionability, noise_penalty) plus relevance_type, evidence, summary, bucket.
// Die OBJEKTIVEN Signale (locality, novelty, freshness, source_quality,
// asset_relevance) werden lokal berechnet — siehe combineScore + Helper oben.
// Das hält den Prompt fokussiert und macht die Gewichtung im Frontend
// nachvollziehbar (und änderbar, ohne neuen LLM-Roundtrip).
async function scoreArticles({ interests, items, profile, portfolio, seenUrls, userHosts }) {
  // Issue 22: Datum & URL werden mit ins Compact-Item gepackt — das LLM braucht
  // beides, um (a) die Aktualität in `interest_match`/`actionability` mit zu
  // berücksichtigen und (b) Datum/Ort aus Title/Snippet zu extrahieren, falls
  // wir vorgelagert noch keines haben (z.B. Spiegel-Druck-URLs). Das Frontend
  // berechnet `freshness` weiterhin lokal aus `it.date` — der LLM-Date dient
  // als Backstop, wenn das Item bisher datumslos ist.
  const compact = items.map((it, i) => ({
    i,
    title: (it.title || '').slice(0, 200),
    snippet: (it.snippet || '').slice(0, 280),
    source: it.source || sourceFromUrl(it.url),
    origin: it.origin,
    url: (it.url || '').slice(0, 220),
    date: it.date ? String(it.date).slice(0, 10) : '',
  }));

  const moduleHint = profile.modules.length
    ? profile.modules.map((m) => `${m.id}: ${m.keywords.slice(0, 6).join(', ')}`).join(' | ')
    : '(keine)';
  const locHint = profile.locations.length
    ? profile.locations.map((l) => l.name).join(', ')
    : '(keine)';
  const watchHint = profile.watchlist.length ? profile.watchlist.join(', ') : '(keine)';
  const negHint = profile.negativeFilters.length
    ? profile.negativeFilters.join(' · ')
    : 'generische Börsenkommentare · SEO-Artikel ohne Primärquelle · Gesundheitsratgeber ohne Studie · globale Politik ohne DE/EU/Depot-Bezug';

  const bucketList = BUCKETS.map((b) => b.id).join('|');

  const sys = `Du bewertest Nachrichten-Artikel für einen User mit strukturiertem Interessen-Profil. Halte dich strikt an EVIDENZ und das Profil — keine spekulativen Ketten, keine erfundenen Auswirkungen.

Gib AUSSCHLIESSLICH JSON zurück (kein Markdown), Struktur:
{
  "items": [
    {
      "index": 0,
      "interest_score": 1,
      "affectedness_score": 1,
      "affectedness_note": "",
      "interest_match": 0.0,
      "actionability": 0.0,
      "noise_penalty": 0.0,
      "summary": "…",
      "relevance_type": "local_proximity|property_asset|health_interest|tech_match|investor_signal|local_event|general",
      "evidence": "Kurzer Faktensatz aus der Quelle + Profilfeld-Bezug",
      "bucket": "${bucketList}",
      "date": "YYYY-MM-DD oder ''",
      "location": "Stadt, Ort oder ''"
    }
  ]
}

ZWEI HAUPT-SCORES (Issue 32 — Pflichtfelder, ganzzahlig 1..10):
- interest_score (Interesse / Themenaffinität): "Wie sehr interessiert das Thema den User?"
    1 = irrelevantes Rauschen, KEIN Bezug zu Profil/Modulen/Interessen-Freitext.
    3 = tangential, am Rand eines Moduls.
    5 = passt thematisch zu einem Modul, aber kein Eigenname/Highlight.
    7 = klarer Volltreffer auf ein Modul oder eine genannte Entität.
    9 = Eigenname/Watchlist-Hit oder Top-Thema des Users.
    10 = perfekter Match (Profil-Person/-Ort/-Aktie wörtlich genannt + aktuelle Entwicklung).
- affectedness_score (Betroffenheit, aktuell oder zukünftig): "Wie stark betrifft die Nachricht den User PERSÖNLICH und DIREKT — jetzt oder absehbar in der Zukunft?"
    KERN-FRAGE: Geht es um seinen Wohnort, sein Vermögen, seine Gesundheit, seinen Beruf, seine konkreten Lebensumstände — oder nur um etwas „allgemein Interessantes"? „Betrifft mich persönlich" zählt voll, „betrifft allgemein" zählt NICHT. Allgemein-thematisches Interesse gehört nach interest_score, NIE nach affectedness_score.
    Heuristik:
      • Ohne irgendeinen Anker im Profil (Wohnort, Watchlist, Asset-Klasse, Gesundheits-Modul, Beruf, Lebensumstände) → bleib im 1-2-Bereich. Default für News „aus der Welt" ist 1.
      • Allgemeine Branchen-/Politik-/Wirtschaftslage, die den User über lange Umwege erreichen könnte, aber kein konkreter Profilfeld-Treffer → 3.
      • Erst wenn ein Profilfeld klar berührt wird (Wohnort genannt, Watchlist-Symbol genannt, eigenes Gesundheits-/Berufs-/Asset-Thema genannt), ab 5 aufwärts.
    Skala:
    1 = betrifft den User in keiner Weise — fremde Region, fremde Branche, kein Lebens-/Vermögens-/Adress-/Gesundheits-Bezug. Standard für „allgemein interessant ohne Profil-Anker".
    3 = sehr indirekter, theoretischer Bezug — globale/nationale Lage, könnte irgendwann tangieren, aber kein konkreter Profilfeld-Treffer.
    5 = mittel — Branchen-Trend, der die Watchlist/das Modul perspektivisch tangiert, oder Region in der Nähe (nicht der eigene Wohnort).
    7 = klare persönliche Betroffenheit — eigener Wohnort/Region, Steuern, Portfolio-Wert, Gesundheits-Modul, lokaler Verkehr; oder erkennbare zukünftige Pflicht/Chance für den User.
    9 = akute persönliche Betroffenheit — Eingriff am Wohnort, Depot-Aktie crasht, Behörden-Empfehlung zum Profil-Gesundheitsthema, neue Pflicht für die eigene Asset-Klasse.
    10 = direkt + sofort handlungs-relevant — eigene Adresse / eigenes Watchlist-Symbol / eigene Krankheit / eigener Beruf wörtlich genannt, mit klarer Konsequenz für den User.
    WICHTIG: Betroffenheit ≠ Interesse. „Interessant" allein reicht NIE für einen Betroffenheits-Hoch-Score. Beispiele zur Eichung:
      • Globale KI-Forschung ohne Asset-/Berufs-Anker → interest kann 8 sein, affectedness bleibt 1-2.
      • Politik-/Krimi-Skandal im Ausland → interest kann hoch, affectedness 1.
      • Renovierungspflicht für die eigene Hausart → interest 4, affectedness 8 (Wohn-/Eigentums-Anker).
      • Neue Bahnstrecke durchs Heimatdorf → interest 5, affectedness 8 (Wohnort-Anker).
      • Quartalszahlen einer Watchlist-Aktie → interest 7, affectedness 8 (Depot-Anker).
    KEINE harten Ausnahmeregeln (z.B. „Verkehrsunfall ist automatisch hoch/niedrig"); die Gewichtung folgt allein der oben definierten Heuristik.
- affectedness_note: NUR ausfüllen, wenn affectedness_score > interest_score. In genau EINEM deutschen Satz (max ~220 Zeichen) konkret beschreiben, WIE die Nachricht den User aktuell ODER in Zukunft betreffen könnte — strikt EVIDENZ-basiert (Profilfeld nennen: Wohnort, Watchlist-Symbol, Gesundheits-Modul, Beruf, Asset-Klasse). Sonst leerer String "".

Zusatz-Skalen (Floats 0..1, weiterhin nötig für die interne Score-Heuristik):
- interest_match: identisch zu interest_score, aber als Float 0..1 (interest_score=7 → 0.7). Wird intern für die Gewichtung verwendet.
- actionability: 0=nur informativ, 0.3=Hintergrund, 0.6=lohnt aktive Beachtung, 1.0=konkrete Handlungs-/Termin-/Kauf-/Vermeidungs-Optionen für den User.
- noise_penalty (0..0.5, NICHT höher): 0 wenn solide Quelle/Primärinfo, ~0.2 wenn dünn aber okay, 0.3-0.5 wenn klar ein "Negative-Filter"-Muster (generischer Kommentar, SEO ohne Primärquelle, Ratgeber ohne Studie, globale Politik ohne Bezug zu DE/EU/Depot).

Pflichtfelder:
- summary: 1-2 deutsche Sätze, sachlich-knackig, NICHT die Headline wiederholen — ergänze Kontext/Konsequenz. Bei dünnem Snippet kurz. Falls affectedness_score > interest_score, KEIN Betroffenheits-Satz hier reinpacken — der gehört nach 'affectedness_note'.
- relevance_type: GENAU EINER aus der Liste, der am besten den Grund beschreibt, warum dieses Item für DEN User auftaucht. Wenn keiner passt → "general".
- evidence: EIN KURZER Satz (max ~220 Zeichen), formuliert als ZWEI Teile: (1) Fakt aus der Quelle, (2) Profil-Bezug. Beispiel: "Konstanzer Stadtrat beschließt 2026er Parkraum-Reform — passt zu deinem Wohnort Konstanz + Modul property_owner." KEINE Spekulation, KEINE Konjunktive über mögliche Auswirkungen. Nur belegbarer Bezug.
- date (Issue 22): Veröffentlichungsdatum im Format YYYY-MM-DD. Wenn das Input-Item bereits ein 'date' mitbringt → DIESES verwenden. Sonst aus Title/Snippet/URL extrahieren („vor 2 Stunden", „2 days ago", „22.05.2026", „/2026/05/22/"). Wenn KEIN Datum erkennbar → "" (leerer String).
- location (Issue 22): NUR bei bucket="lokal" oder relevance_type="local_proximity"/"local_event" — der Stadt-/Ortsname aus Title/Snippet (z.B. „Konstanz", „Bodenseekreis", „Stadtteil Petershausen"). Wenn der Artikel KEINEN klaren Ortsbezug hat oder das bucket nicht lokal ist → "" (leerer String). Format: kurzer Klartext, max 80 Zeichen.

⏰ AKTUALITÄTS-HINWEIS (Issue 22): Das Scoring gewichtet Aktualität stark — gib in 'interest_match' und 'actionability' aktuelleren Items KEINE künstliche Boni; die Aktualität fließt automatisch über das Frontend ein. Aber: stark veraltete Items (älter als 1 Woche, sichtbar im 'date'-Feld) sollten in 'interest_match' etwas niedriger gerated werden, sofern sie nicht ein zeitloses Hintergrund-Stück sind.
- bucket: in welche Rubrik gehört das Item (EINE der Vorgaben). Faustregel:
    lokal     → lokale Nachrichten (Stadt, Region, Verkehr, Stadtpolitik, lokale Wirtschaft) — AUCH lokale Veranstaltungs-Berichte/-Ankündigungen, die kein konkretes Einzel-Datum haben
    tech      → KI, Software, Hardware, IT-Industrie, Forschung
    watchlist → Aktien/Märkte/Quartalszahlen — speziell die in der Watchlist genannten
    medizin   → Studien, Behörden-Empfehlungen, konkrete Gesundheitsthemen
    beobachten → wichtig zu wissen, aber zu keiner anderen Rubrik klar zuordbar
  WICHTIG: gib NIEMALS "events" oder "youtube" zurück — die Events-Rubrik wird ausschließlich von einem separaten Extraktor mit konkreten Terminen gefüllt; die YouTube-Rubrik wird automatisch aus den Video-Items befüllt (origin=youtube). Für News-Items über YouTube/Videos/Streamer nimm "tech" oder "beobachten"; für News über Events "lokal" oder "beobachten".
  ⚠️ NIE als "lokal" markieren, auch wenn der Stadtname im Titel auftaucht:
    - Wetter-Vorhersagen / Wetterberichte / Klima-Karten (Wetter hat eine eigene App-Karte).
    - Social-Media-Posts (Instagram, Facebook, TikTok, X/Twitter, Threads, Snapchat) — auch wenn der Stadt-Hashtag drin ist.
    - Tourismus-/Stadt-Portale ohne konkrete Nachricht (z.B. xyz-info.com, /tourismus, /sehenswuerdigkeiten, /planen-buchen, /top-events).
    - Reine Event-Aggregator-Listen ohne konkrete Nachricht (Eventbrite, Meetup, eventfrog, eventfinder, regioactive).
    - Reise-/Hotel-Buchungsseiten (Booking, TripAdvisor, HolidayCheck, Airbnb).
    - Wikipedia/Wikivoyage-Stadtartikel.
  Diese gehören in "beobachten" (oder ggf. eine andere Rubrik, wenn sie thematisch passen) — KEINESFALLS in "lokal".

USER-PROFIL (zur Bewertung von interest_match & evidence):
- Standorte: ${locHint}
- Module: ${moduleHint}
- Watchlist: ${watchHint}
- Negative Filter (für noise_penalty): ${negHint}

WICHTIG:
- ALLE übergebenen Items bewerten (jeden index genau einmal).
- KEINE Spekulationen, keine "könnte", "möglicherweise", "denkbar"-Formulierungen.
- Wenn kein Profilfeld-Bezug konstruierbar ist → evidence dennoch ausfüllen mit Fakt + "kein direkter Profil-Bezug", und interest_match niedrig setzen.`;

  const user = `USER-FREITEXT (Original-Eingabe, falls Profil unvollständig):
${interests || '(leer)'}

ARTIKEL:
${JSON.stringify(compact, null, 0)}`;

  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    // ~110 Token/Item (kleiner als alte Hypothesen-Version, weil evidence
    // sachlich und kurz ist), Cap 7000 für 60-Item-Batches.
    max_tokens: Math.min(7000, 300 + compact.length * 120),
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  const list = Array.isArray(parsed.items) ? parsed.items : [];

  const portfolioList = portfolio || store.get(LS.portfolio, []);
  const hostsForQuality = userHosts || getUserSiteHosts();

  // Issue 22: Helfer zum Validieren des LLM-Datums.
  const _isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const normalizeLlmDate = (raw) => {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().slice(0, 10);
    if (!_isoRe.test(s)) return '';
    const d = new Date(s + 'T00:00:00Z');
    if (isNaN(d.getTime())) return '';
    // Zukunfts-Daten >2 Tage in der Zukunft sind LLM-Halluzinationen.
    if (d.getTime() > Date.now() + 2 * 86400000) return '';
    return s;
  };

  // Issue 32: Helfer zum Klemmen der beiden 1..10-Scores.
  const clampScore10 = (n, fallback) => {
    if (typeof n !== 'number' || !isFinite(n)) return fallback;
    const r = Math.round(n);
    return Math.max(1, Math.min(10, r));
  };

  // Pro Item die Komponenten zusammenrechnen.
  const out = [];
  const seenIdx = new Set();
  for (const x of list) {
    if (!x || !Number.isInteger(x.index)) continue;
    if (x.index < 0 || x.index >= items.length) continue;
    if (seenIdx.has(x.index)) continue;
    seenIdx.add(x.index);
    const it = items[x.index];
    // Issue 22: LLM-Datum als Backstop, wenn vorgelagerte Parser (Snippet/
    // URL/Trafilatura) nichts gefunden haben. Bestehendes `it.date` gewinnt.
    const llmDate = normalizeLlmDate(x.date);
    const effectiveDate = it.date || (llmDate ? new Date(llmDate + 'T00:00:00Z').toISOString() : '');
    if (!it.date && llmDate) it.date = effectiveDate;
    // Issue 32: zwei separate Scores aus dem LLM (Interesse + Betroffenheit,
    // 1..10). Wenn das LLM den interest_score nicht geliefert hat, aber den
    // alten interest_match-Float (0..1), leiten wir interest_score daraus ab.
    let interestScore;
    if (typeof x.interest_score === 'number') interestScore = clampScore10(x.interest_score, 3);
    else if (typeof x.interest_match === 'number') interestScore = clampScore10(x.interest_match * 10, 3);
    else interestScore = 3;
    const affectednessScore = clampScore10(x.affectedness_score, 2);
    const affectednessNote = typeof x.affectedness_note === 'string'
      ? x.affectedness_note.trim().slice(0, 260)
      : '';
    const components = {
      locality: localityScore(it, profile),
      interest_match: typeof x.interest_match === 'number'
        ? Math.max(0, Math.min(1, x.interest_match))
        : interestScore / 10,
      novelty: noveltyScore(it.url, seenUrls),
      actionability: typeof x.actionability === 'number' ? Math.max(0, Math.min(1, x.actionability)) : 0.3,
      source_quality: sourceQualityFor(it.url, hostsForQuality),
      asset_relevance: assetRelevanceScore(it, portfolioList),
      freshness: freshnessScore(effectiveDate),
    };
    const noise = typeof x.noise_penalty === 'number' ? Math.max(0, Math.min(0.5, x.noise_penalty)) : 0;
    const score01 = combineScore(components, noise);
    const bucket = normalizeBucket(x.bucket) || pickBucketHeuristic(it, profile);
    // Issue 22: Ortsangabe nur übernehmen, wenn (a) der LLM einen liefert UND
    // (b) das Item lokalen Charakter hat (Bucket lokal oder
    // relevance_type=local_*). Sonst verwerfen, damit „location" nicht auf
    // Tech/Watchlist-Karten landet.
    const llmLocation = typeof x.location === 'string' ? x.location.trim().slice(0, 80) : '';
    const isLocalish = bucket === 'lokal'
      || x.relevance_type === 'local_proximity'
      || x.relevance_type === 'local_event';
    out.push({
      index: x.index,
      score: score01 * 10,           // alte UI-Skala 0..10 wiederverwenden
      score01,
      components,
      noise_penalty: noise,
      // Issue 32: zwei separate Scores als Primär-Ordnung.
      interestScore,
      affectednessScore,
      affectednessNote: affectednessScore > interestScore ? affectednessNote : '',
      scoreSum: interestScore + affectednessScore,
      summary: typeof x.summary === 'string' ? x.summary : '',
      relevance_type: typeof x.relevance_type === 'string' ? x.relevance_type : 'general',
      evidence: typeof x.evidence === 'string' ? x.evidence.trim() : '',
      bucket,
      date: effectiveDate,
      location: (isLocalish && llmLocation) ? llmLocation : '',
    });
  }

  // Fehlende Items mit konservativen Defaults auffüllen (nur lokale Signale).
  for (let i = 0; i < items.length; i++) {
    if (seenIdx.has(i)) continue;
    const it = items[i];
    const components = {
      locality: localityScore(it, profile),
      interest_match: 0.25,
      novelty: noveltyScore(it.url, seenUrls),
      actionability: 0.2,
      source_quality: sourceQualityFor(it.url, hostsForQuality),
      asset_relevance: assetRelevanceScore(it, portfolioList),
      freshness: freshnessScore(it.date),
    };
    const score01 = combineScore(components, 0.1);
    out.push({
      index: i,
      score: score01 * 10,
      score01,
      components,
      noise_penalty: 0.1,
      // Issue 32: konservative Defaults für nicht-gescorte Items.
      interestScore: 3,
      affectednessScore: 2,
      affectednessNote: '',
      scoreSum: 5,
      summary: it.snippet || '',
      relevance_type: 'general',
      evidence: '',
      bucket: pickBucketHeuristic(it, profile),
      date: it.date || '',
      location: '',
    });
  }
  return { items: out };
}

// Issue 8: Items aufgrund von `bucket` in die festen Tagesrubriken aufteilen.
// Events sind eine eigene Rubrik (Quelle: konkrete Event-Liste, nicht aus
// dem regulären Item-Pool). Leere Rubriken werden bei der Anzeige
// ausgeblendet — "Keine relevanten Treffer" ist laut Konzept gültig.
// Issue 25: Mindestens 5 Items pro Rubrik. Wenn der LLM-Scorer einer Rubrik
// weniger als 5 Items zugewiesen hat, ziehen wir die bestbewerteten passenden
// Items aus dem Beobachten-Bucket nach (Overflow-Pool). Auswahl priorisiert
// thematische Passung (via `pickBucketHeuristic`) und fällt auf relevance-Sort
// zurück. Beobachten ist die Quelle (keine Selbstauffüllung), Events sind
// ausgenommen (eigener Extraktor-Pool).
const MIN_ITEMS_PER_BUCKET = 5;

// Issue 33: Round-Robin nach Herkunfts-Host. Verhindert, dass mehrere Items
// derselben Quelle direkt hintereinander erscheinen. Items werden nach
// Hostname gruppiert (sortiert innerhalb der Gruppe nach scoreSum desc durch
// den vorgelagerten Sort), dann reihum max ROUND_ROBIN_MAX_PER_SOURCE Items
// pro Quelle ausgegeben, bis alle Pools leer sind. Die Reihenfolge der
// Quellen-Gruppen richtet sich nach dem Top-Item pro Host (höchster
// scoreSum zuerst) — damit landet die stärkste Quelle vorn, aber kein
// einzelner Host monopolisiert die Liste.
//
// Ausnahmen (Konzept Issue 33): YouTube (origin==='youtube') und die lokale
// Karten-Quelle (origin==='lokal-extract') sind vom Round-Robin ausgenommen
// — dort dürfen weiterhin mehrere Items direkt hintereinander kommen. Die
// Helper-Funktion behandelt sie wie eine eigene unteilbare Block-Quelle
// (host-Schlüssel `__exempt:<origin>`), sodass sie zwar in der Round-Robin-
// Schlange einen Slot pro Runde bekommen, aber innerhalb des Slots ihre
// ursprüngliche Cluster-Reihenfolge behalten.
const ROUND_ROBIN_MAX_PER_SOURCE = 2;

function _itemHostKey(it) {
  // Issue 38: `pubmed`-Items werden wie `lokal-extract` als exempter Cluster
  // behandelt — sie sollen im Medizin-Bucket gebündelt oben stehen statt
  // pro Runde nur 2 zu zeigen.
  if (it && (it.origin === 'youtube' || it.origin === 'lokal-extract' || it.origin === 'pubmed')) {
    return `__exempt:${it.origin}`;
  }
  try {
    const h = new URL(it && it.url ? it.url : '').hostname.replace(/^www\./, '');
    return h || '__unknown';
  } catch { return '__unknown'; }
}

function applyRoundRobinByHost(items, opts) {
  if (!Array.isArray(items) || items.length < 2) return Array.isArray(items) ? items.slice() : [];
  const maxPerSource = (opts && typeof opts.maxPerSource === 'number') ? opts.maxPerSource : ROUND_ROBIN_MAX_PER_SOURCE;
  const groups = new Map();
  const order = [];
  for (const it of items) {
    const host = _itemHostKey(it);
    if (!groups.has(host)) { groups.set(host, []); order.push(host); }
    groups.get(host).push(it);
  }
  if (order.length < 2) return items.slice();
  // Quell-Reihenfolge: bestes Item pro Host (scoreSum desc) bestimmt den Slot
  // — die stärkste Quelle bekommt den ersten Round-Robin-Platz.
  order.sort((a, b) => {
    const ka = groups.get(a).length ? itemSortKey(groups.get(a)[0]) : 0;
    const kb = groups.get(b).length ? itemSortKey(groups.get(b)[0]) : 0;
    return kb - ka;
  });
  const out = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const host of order) {
      const arr = groups.get(host);
      if (!arr.length) continue;
      // Ausnahme-Hosts (__exempt:youtube / __exempt:lokal-extract) dürfen pro
      // Runde mehr Items ausgeben (effektiv kein Limit), damit ihre Cluster
      // erhalten bleiben.
      const isExempt = host.startsWith('__exempt:');
      const take = isExempt ? arr.length : Math.min(maxPerSource, arr.length);
      for (let i = 0; i < take; i++) out.push(arr.shift());
      progressed = true;
    }
  }
  return out;
}

function bucketizeItems(scoredItems, concreteEvents, concreteLocalNews, profile, pubmedItems = []) {
  const out = {};
  for (const b of BUCKETS) out[b.id] = [];
  for (const it of scoredItems) {
    let b = BUCKET_IDS.includes(it.bucket) ? it.bucket : 'beobachten';
    // Issue 13: YouTube-Items landen IMMER in der YouTube-Rubrik, egal was der
    // LLM-Scorer als Bucket ausgegeben hat. Damit hat der User pro Run alle
    // Video-Zusammenfassungen an einem Ort statt verstreut über tech/lokal/…
    if (it.origin === 'youtube') {
      b = 'youtube';
    } else if (b === 'youtube') {
      // Nicht-Video-Item, das der Scorer fälschlich nach youtube gelegt hat
      // → in beobachten umleiten (Defense-in-Depth, wie bei events).
      b = 'beobachten';
    }
    // Issue 12: die Rubrik `events` ist exklusiv für konkrete extrahierte
    // Termine (aus extractEventsFromListings) reserviert. News-Items, die der
    // LLM-Scorer fälschlich als "events" eingestuft hat (typisch: Listing-
    // Seiten von Eventbrite/Meetup ohne konkretes Datum), werden hier
    // umgeleitet — sonst tauchen sie als "Event-Karten" ohne Datum/Ort auf
    // und der User sieht nur einen Quellenlink statt eines Events.
    //
    // Issue 18: ALLE scorer-`events`-Items gehen jetzt nach `beobachten` —
    // nicht mehr nach `lokal`, auch nicht bei positivem localityScore. Vor
    // Issue 18 konnten Items mit Stadt-Bezug (z.B. `konstanz.de/events`,
    // Tourismus-Seiten) trotz Junk-Filter durchschlüpfen und die Lokal-
    // Rubrik mit Event-Übersichts­seiten füllen. Echte Lokal-Karten sollen
    // ausschließlich aus dem dedizierten Extraktor (`extractLocalNews­
    // FromListings`) kommen — Scorer-Heuristik ist hier nicht mehr Quelle.
    if (b === 'events') {
      b = 'beobachten';
    }
    // Issue 17: Defense-in-Depth für die Lokal-Rubrik — selbst wenn der LLM-
    // Scorer ein Item direkt nach `lokal` gelegt hat, prüfen wir die Domain.
    // Wetter-Vorhersagen, Instagram-/Facebook-Posts, Tourismus-/Stadtportale
    // und Event-Aggregator-Listen werden nach `beobachten` umgeleitet — sie
    // sind keine echten lokalen Nachrichten, sondern erzeugen den von User
    // gemeldeten „Lokal zeigt nur Wetter und Übersichtsseiten"-Effekt.
    if (b === 'lokal' && (isNonLocalNewsHost(it.url) || looksLikeWeatherItem(it))) {
      b = 'beobachten';
    }
    out[b].push(it);
  }
  // Events-Rubrik: aus dem dedizierten Event-Pool, sortiert nach Datum
  // (bereits in extractEventsFromListings sortiert). Wenn keine konkreten
  // Events extrahiert wurden, bleibt die Rubrik leer und wird beim Rendern
  // weggelassen — Issue 12: bewusst keine Fallback-Karten mit fehlendem
  // Datum, das war der Grund für die "Seiten-Link"-Optik vorher.
  out.events = (concreteEvents || []).map((e) => ({
    ...e,
    // Issue 24 Bug-Fix: einheitliche Card-Felder erzwingen — manche Quellen
    // (runUserSitesPipeline vor Issue 24) liefern nur die `event_*`-Aliase,
    // andere (extractEventsFromListings) liefern `title`/`date`. buildEventCard
    // liest aber genau `title`/`date`. Mit dem Backstop hier rendern Karten
    // garantiert mit Überschrift und Datum, auch wenn ein neuer Extraktor
    // wieder nur die event_*-Aliase setzt.
    title: e.title || e.event_name || '',
    date: e.date || e.event_date || '',
    time: e.time || e.event_time || '',
    location: e.location || e.event_location || '',
    description: e.description || e.event_summary || e.summary || '',
    isEvent: true,
    relevance: 8, // visuelles "wichtig"-Chip
    bucket: 'events',
  }));
  // Issue 14 + 23 + 26 + 34: Lokal-News-Pool zusammenführen. `concreteLocalNews`
  // enthält Items aus drei Quellen mit unterschiedlicher Herkunft:
  //   - `extractLocalNewsFromListings` — die echte „Karten-Quelle" (LLM-Extrakt
  //     aus regionalen Listings). Diese Items haben keinen `origin` und bekommen
  //     hier `origin: 'lokal-extract'` gesetzt — sie bilden den exempten Cluster
  //     am Kopf der Rubrik (kein Round-Robin, gemeinsame Karten-Optik).
  //   - `classifyRssArticles` (Issue 26) — RSS-Items, die als `lokalnachricht`
  //     klassifiziert wurden. Sie tragen `origin: 'rss'` (seit Issue 34).
  //   - `runUserSitesPipeline` (Issue 23) — manuell eingetragene Webseiten,
  //     deren Artikel als `lokalnachricht` klassifiziert wurden. Sie tragen
  //     `origin: 'user-site'` (seit Issue 34).
  // Issue 34: Nur die echte Karten-Quelle (`origin: 'lokal-extract'`) bleibt
  // vom Round-Robin ausgenommen. RSS- und User-Site-Items werden im Tail des
  // Lokal-Buckets per Hostname round-robinned, damit ein dominanter Polizei-
  // RSS-Feed nicht die ganze Rubrik füllt. URL-Doppler (Listing-Seite als
  // Web-Item gefangen) werden weiterhin zugunsten des Synth-Eintrags gefiltert.
  const lokalSynth = (concreteLocalNews || [])
    // Issue 17: zweiter Filter — falls trotz Seed-Filter (siehe
    // findLocalNewsSeeds) eine Junk-Domain in den extrahierten Lokal-News
    // landet, hier nochmal raus. Wetter-Snippets ebenfalls.
    .filter((n) => !isNonLocalNewsHost(n.url) && !looksLikeWeatherItem({ title: n.title, snippet: n.summary }))
    .map((n) => ({
      ...n,
      snippet: n.summary || '',
      // Issue 34: vorhandene Herkunft (`rss` / `user-site`) bewahren, sonst
      // Default auf die echte Karten-Quelle. `_itemHostKey` exemptiert weiterhin
      // nur `lokal-extract` und `youtube`.
      origin: n.origin || 'lokal-extract',
      relevance: 7.6,
      score01: 0.76,
      // Issue 32: extrahierte Lokal-News haben per Definition starken Profil-
      // bezug (Wohnort) — beide Scores hoch, damit sie auch in der globalen
      // Sortierung nach scoreSum (Issue 32) oben landen. Kein affectednessNote
      // erzwingen — bei sum=16 ist affectedness == interest, also keine
      // gesonderte Hervorhebung nötig.
      interestScore: 8,
      affectednessScore: 8,
      affectednessNote: '',
      scoreSum: 16,
      relevance_type: 'local_news',
      evidence: `Aus regionalem News-Listing (${n.source || sourceFromUrl(n.url)}) zum Stadt-Standort extrahiert.`,
      bucket: 'lokal',
    }));
  if (lokalSynth.length) {
    const synthUrls = new Set(lokalSynth.map((x) => x.url));
    // Issue 34: Reihenfolge erzwingen — echter Extractor-Cluster zuerst (oben,
    // exempt), dann RSS-/User-Site-klassifizierte Items (gehen in den RR-Tail),
    // dann die nicht-doppelten Scorer-Items.
    const lokalExtractCluster = lokalSynth.filter((n) => n.origin === 'lokal-extract');
    const lokalFeedClassified = lokalSynth.filter((n) => n.origin !== 'lokal-extract');
    out.lokal = [
      ...lokalExtractCluster,
      ...lokalFeedClassified,
      ...out.lokal.filter((it) => !synthUrls.has(it.url)),
    ];
  }
  // Issue 38: PubMed-Studien werden als kuratierter Cluster oben in der
  // Medizin-Rubrik geführt — analog zu lokal-extract in der Lokal-Rubrik.
  // Sie laufen nicht durch `scoreArticles`, deshalb müssen wir Interesse-/
  // Betroffenheits-Scores hier setzen. Werte 8/8 (Summe 16) sind dieselben
  // wie für `lokalSynth` — kuratierte Quellen mit starkem Profilbezug.
  // Es gibt keinen `affectednessNote`, weil Summe interest==aff (siehe
  // Issue 32-Regel: Note nur bei aff > int).
  const pubmedSynth = (pubmedItems || []).map((p) => ({
    ...p,
    snippet: p.summary || p.snippet || '',
    relevance: 8,
    score01: 0.8,
    interestScore: 8,
    affectednessScore: 8,
    affectednessNote: '',
    scoreSum: 16,
    relevance_type: 'medical_study',
    evidence: `Aktuelle PubMed-Studie zu ${(p.pubmedQueries || []).slice(0, 2).map((q) => `„${q}"`).join(' / ') || 'medizinischen Themen aus deinem Profil'}.`,
    bucket: 'medizin',
  }));
  if (pubmedSynth.length) {
    const pmUrls = new Set(pubmedSynth.map((p) => p.url));
    // Wenn ein PubMed-Treffer zufällig auch in scoredItems steckte (sehr
    // unwahrscheinlich, aber URL-Dedupe ist günstig): nehmen wir den PubMed-
    // Eintrag (mit Studien-Metadaten), nicht den Scorer-Eintrag.
    out.medizin = [
      ...pubmedSynth,
      ...out.medizin.filter((it) => !pmUrls.has(it.url)),
    ];
  }
  // Innerhalb jeder Rubrik nach Score sortieren (außer events, die nach Datum;
  // und außer lokal, wo die extrahierten Top-News bewusst vorne stehen).
  // Issue 32: Primärschlüssel ist scoreSum (Interesse+Betroffenheit), Fallback
  // weiterhin relevance, damit ältere Caches ohne scoreSum keine NaN-Reihenfolge
  // bekommen.
  for (const id of BUCKET_IDS) {
    if (id === 'events' || id === 'lokal') continue;
    // Issue 38: Medizin-Bucket — PubMed-Kopf-Cluster oben halten (Sortier-
    // Stabilität), Nicht-PubMed-Items im Tail nach scoreSum desc. Damit ist
    // die Reihenfolge robust auch dann, wenn ein zufälliger Medizin-Scorer-
    // Treffer ebenfalls scoreSum 16 hat — er rutscht nicht vor den
    // kuratierten PubMed-Cluster.
    if (id === 'medizin' && pubmedSynth.length) {
      const head = out.medizin.slice(0, pubmedSynth.length);
      const tail = out.medizin.slice(pubmedSynth.length).sort((a, b) => itemSortKey(b) - itemSortKey(a));
      out.medizin = [...head, ...tail];
      continue;
    }
    out[id].sort((a, b) => itemSortKey(b) - itemSortKey(a));
  }
  // Lokal: extrahierte News bleiben oben (nach Datum desc, schon sortiert),
  // dahinter die Scorer-Items nach scoreSum desc.
  if (lokalSynth.length) {
    const head = out.lokal.slice(0, lokalSynth.length);
    const tail = out.lokal.slice(lokalSynth.length).sort((a, b) => itemSortKey(b) - itemSortKey(a));
    out.lokal = [...head, ...tail];
  } else {
    out.lokal.sort((a, b) => itemSortKey(b) - itemSortKey(a));
  }
  // Issue 25: Backfill bis MIN_ITEMS_PER_BUCKET. Quelle ist `beobachten`
  // (Overflow-Pool), Ziele sind alle Nicht-events-Buckets. Reihenfolge:
  // deficitärste zuerst, damit knappe Pools gleichmäßig verteilt werden.
  backfillBucketsToMin5(out, profile);
  // Issue 33: Quellen-Round-Robin pro Rubrik. Verhindert Cluster derselben
  // Quelle (z.B. 5 SPIEGEL-Artikel in tech am Stück). Wirkt NACH dem
  // scoreSum-Sort und NACH dem Backfill, sodass die Reihenfolge innerhalb
  // einer Quell-Gruppe weiterhin scoreSum desc ist, aber Quellen abwechseln.
  // Ausgenommen: `events` (eigene Card-Shape), `youtube` (Konzept-Ausnahme —
  // alle Items derselben Quellfamilie). Für `lokal` bleibt der lokal-extract-
  // Kopf (Karten-Quelle) als Cluster oben — der Round-Robin wirkt nur auf den
  // Tail. Defense-in-Depth: `_itemHostKey` mappt lokal-extract/youtube selbst
  // auf einen __exempt-Bucket-Schlüssel, sodass mehrere solche Items auch in
  // gemischten Listen geclustert bleiben.
  // Issue 34: der Lokal-Tail enthält jetzt explizit auch RSS- und User-Site-
  // klassifizierte Lokal-Items (origin='rss' bzw. 'user-site'), die vorher
  // pauschal als `lokal-extract` getaggt waren und damit fälschlich vom RR
  // ausgenommen wurden. Damit bricht ein einzelner dominanter Feed (Polizei-
  // Pressemitteilungen) die Rubrik nicht mehr — der RR mischt sie pro Host
  // mit max. 2 Items am Stück zwischen die anderen Quellen.
  for (const id of BUCKET_IDS) {
    if (id === 'events' || id === 'youtube') continue;
    const arr = out[id] || [];
    if (arr.length < 2) continue;
    if (id === 'lokal') {
      let headLen = 0;
      while (headLen < arr.length && arr[headLen] && arr[headLen].origin === 'lokal-extract') headLen++;
      if (headLen >= arr.length - 1) continue;
      const head = arr.slice(0, headLen);
      const tail = applyRoundRobinByHost(arr.slice(headLen));
      out.lokal = [...head, ...tail];
    } else if (id === 'medizin') {
      // Issue 38: PubMed-Studien als Kopf-Cluster — analog zu lokal-extract
      // in der Lokal-Rubrik. RR wirkt nur auf den Tail (Nicht-PubMed-Items
      // aus dem Scorer-Pool und Backfill-Items aus beobachten).
      let headLen = 0;
      while (headLen < arr.length && arr[headLen] && arr[headLen].origin === 'pubmed') headLen++;
      if (headLen >= arr.length - 1) continue;
      const head = arr.slice(0, headLen);
      const tail = applyRoundRobinByHost(arr.slice(headLen));
      out.medizin = [...head, ...tail];
    } else {
      out[id] = applyRoundRobinByHost(arr);
    }
  }
  return out;
}

// Issue 25: füllt Rubriken mit <5 Items aus dem beobachten-Pool auf. Für jeden
// Ziel-Bucket werden Kandidaten aus beobachten gerankt: erste Wahl sind Items,
// die `pickBucketHeuristic` zu genau diesem Bucket zuordnen würde (thematische
// Passung). Zweite Wahl: höchstbewertete Items, egal welches Thema. Items
// werden physisch verschoben (kein Duplikat), beobachten schrumpft also.
function backfillBucketsToMin5(out, profile) {
  const targetIds = BUCKET_IDS.filter((id) => id !== 'events' && id !== 'beobachten');
  // Sortieren: deficitärste Rubrik zuerst, damit knappes beobachten gerecht verteilt.
  const deficient = targetIds
    .filter((id) => (out[id] || []).length < MIN_ITEMS_PER_BUCKET)
    .sort((a, b) => (out[a].length - out[b].length));
  if (!deficient.length) return;

  const prof = profile || { modules: [] };

  for (const id of deficient) {
    if (!out.beobachten || !out.beobachten.length) break;
    const need = MIN_ITEMS_PER_BUCKET - out[id].length;
    if (need <= 0) continue;

    // Ranking: thematisch passende zuerst, dann nach scoreSum (Issue 32).
    const ranked = out.beobachten
      .map((item, idx) => {
        let heur = null;
        try { heur = pickBucketHeuristic(item, prof); } catch { heur = null; }
        return {
          item, idx,
          themed: heur === id ? 1 : 0,
          rel: itemSortKey(item),
        };
      })
      .sort((a, b) => {
        if (b.themed !== a.themed) return b.themed - a.themed;
        return b.rel - a.rel;
      });

    const picked = ranked.slice(0, need);
    if (!picked.length) continue;
    const pickedIdxSet = new Set(picked.map((p) => p.idx));

    for (const p of picked) {
      out[id].push({ ...p.item, bucket: id, _backfilled: true });
    }
    out.beobachten = out.beobachten.filter((_, idx) => !pickedIdxSet.has(idx));

    // Ziel-Bucket neu sortieren — bei lokal die extrahierten News vorn lassen.
    // Issue 32: scoreSum statt relevance als Sortierschlüssel.
    if (id === 'lokal') {
      const synthCount = out.lokal.filter((x) => x.origin === 'lokal-extract').length;
      const head = out.lokal.slice(0, synthCount);
      const tail = out.lokal.slice(synthCount).sort((a, b) => itemSortKey(b) - itemSortKey(a));
      out.lokal = [...head, ...tail];
    } else {
      out[id].sort((a, b) => itemSortKey(b) - itemSortKey(a));
    }
  }
}

// Issue 20: Top 5 aus den Rubriken statt aus dem Gesamt-Score-Pool.
// Vorher (`scoredItems.slice(0, 5)`) konnten thematisch unscharfe
// Übersichtsseiten in Top 5 landen, sobald der Scorer ihnen einen hohen
// relevance-Wert gegeben hatte. Jetzt: pro Rubrik wird das beste Item gezogen,
// wenn nach einer Runde noch <5 Items zusammen sind, wird round-robin mit
// dem jeweils nächsten Item pro Rubrik nachgefüllt. So bleibt die Top-5-Box
// ein echter Querschnitt der Rubriken (lokal, youtube, tech, watchlist,
// medizin, beobachten).
//
// Events sind bewusst ausgenommen — sie haben event-spezifische Felder
// (event_date/-time/location/distanceKm), eine eigene prominente Rubrik mit
// `buildEventCard`-Rendering und passen nicht in den news-card-Renderer der
// Top-5-Sektion (`mode: 'card'`).
function pickTop5FromBuckets(buckets) {
  const pools = BUCKET_IDS
    .filter((id) => id !== 'events')
    .map((id) => [...((buckets && buckets[id]) || [])]);
  const picked = [];
  while (picked.length < 5) {
    let progressed = false;
    for (const pool of pools) {
      if (!pool.length) continue;
      picked.push(pool.shift());
      progressed = true;
      if (picked.length >= 5) break;
    }
    if (!progressed) break;
  }
  // Issue 32: scoreSum statt relevance als Sortierschlüssel.
  picked.sort((a, b) => itemSortKey(b) - itemSortKey(a));
  return picked;
}

// Issue 10: YouTube-Video-Transkripte in einem LLM-Call zu kompakten
// deutschsprachigen Zusammenfassungen verdichten. Output ist ein Array, das
// 1:1 zur Input-Reihenfolge passt (Index-basiert, damit auch teilweise
// Antworten verlustfrei gemappt werden können).
async function summarizeYouTubeTranscripts(videos) {
  if (!videos || !videos.length) return [];
  // Pro Video max. 6000 Zeichen Transkript (~1500 Tokens) — reicht für eine
  // dichte Zusammenfassung, hält die Gesamt-Kontextgröße im Rahmen.
  const compact = videos.map((v, i) => ({
    i,
    channel: (v.channelTitle || '').slice(0, 80),
    title: (v.title || '').slice(0, 200),
    transcript: (v.transcript || '').slice(0, 6000),
  }));

  const sys = `Du fasst YouTube-Video-Transkripte auf DEUTSCH zusammen — jeweils 3-5 dichte Sätze pro Video — UND klassifizierst, ob es sich um ein konkretes Einzelvideo oder eine reine Übersicht/Wochen-Sammlung handelt.

Gib AUSSCHLIESSLICH JSON zurück (kein Markdown), Struktur:
{ "summaries": [ { "index": 0, "typ": "video"|"übersichtsseite", "summary": "…" } ] }

Pro Eintrag:
- index: Position im Input (zwingend).
- typ: "video" für ein konkretes Einzelthema/eigenständige Story; "übersichtsseite" für Wochenrückblicke, „Top-10"-Listen, „Alle News der Woche", Reaktions-Roundups ohne eigene Story-Substanz, reine Schlagzeilen-Auflistungen. Bei Unsicherheit → "video". Hinweis: ein Channel-Trailer / „Best-of"-Compilation ist auch "übersichtsseite".
- summary: 3-5 deutsche Sätze. Konkrete Kernaussagen, Zahlen, Eigennamen, Schlussfolgerungen — KEINE Werbefloskeln ("Vergiss nicht zu liken / abonnieren / Patreon / Sponsor xy"), KEINE Selbstbezüge des Kanals.
- Sprache IMMER Deutsch, auch wenn das Originalvideo englisch ist (sinngemäß übersetzen).
- Wenn der Transkript-Text nur Musik, Werbung oder unverständliches Geplapper ist, schreibe einen einzigen Satz ("Video enthält im Wesentlichen Musik / Werbung — keine inhaltliche Zusammenfassung möglich.").
- Wiederhole NICHT den Titel.`;

  const userText = JSON.stringify(compact, null, 0);
  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: userText }],
    temperature: 0.3,
    max_tokens: Math.min(4000, 400 + compact.length * 300),
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  const list = Array.isArray(parsed.summaries) ? parsed.summaries : [];
  // Issue 27: Rückgabe als Array von {summary, typ}. Aufrufer kann
  // übersichtsseite-Items verwerfen. Bei fehlendem typ → 'video' (Default).
  const out = videos.map(() => ({ summary: '', typ: 'video' }));
  for (const s of list) {
    if (!s || !Number.isInteger(s.index)) continue;
    if (s.index < 0 || s.index >= videos.length) continue;
    if (typeof s.summary === 'string') out[s.index].summary = s.summary.trim();
    const rawTyp = String(s.typ || '').trim().toLowerCase();
    if (rawTyp === 'übersichtsseite' || rawTyp === 'uebersichtsseite' || rawTyp === 'overview' || rawTyp === 'roundup' || rawTyp === 'wochenrückblick') {
      out[s.index].typ = 'übersichtsseite';
    }
  }
  return out;
}

// Issue 8: Briefing nimmt jetzt die Rubrik-Struktur als Vorgabe, und es
// werden NUR EVIDENZ-belegte Items eingeordnet — kein spekulatives Spinnen
// mehr ("keine spekulativen Ketten" laut Konzept). Wetter fließt als
// kurzer Vorsatz mit ein, wenn vorhanden.
// Issue 10: ausführlicheres Format — mehr Absätze, detaillierte Einordnung
// jedes wichtigen Artikels pro Rubrik. Token-Budget entsprechend angehoben.
// Issue 24: lokaler Notfall-Briefing-Generator. Greift, wenn der LLM-Call
// (composeBriefing) wirft oder einen leeren String liefert (was z.B. bei
// Token-Limit-Überschreitung oder Gemini-Throttling vorkommt). Baut aus
// den vorhandenen Buckets + Top-5 + Events einen lesbaren Block ohne
// Halluzinationen — strikt nur Titel + Quelle + Datum, ein Absatz pro
// Rubrik. Besser ein nüchterner Auszug als ein leerer Greeting-Block.
function buildFallbackBriefing({ buckets, top5, weather, concreteEvents }) {
  const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  // Issue 30: Längen-Multiplikator wirkt auch auf den lokalen Fallback-Text.
  // Mehr Items pro Aufzählung — ohne LLM können wir keine Sätze "verlängern",
  // aber wir können MEHR Material listen.
  // Issue 43: Caps von 15/9/12 auf 25/15/20 angehoben, damit Faktor 4× und 5×
  // sich tatsächlich in mehr Items niederschlagen (vorher klemmten alle ≥3×
  // am alten Cap fest). 1×-3×-Verhalten bleibt unverändert (die Faktor-Werte
  // erreichen bei 3× das alte Cap weiterhin nicht).
  const lengthFactor = getBriefingLengthFactor();
  const topCount = Math.min(25, 5 * lengthFactor);
  const perBucketCount = Math.min(15, 3 * lengthFactor);
  const eventsCount = Math.min(20, 4 * lengthFactor);
  const lines = [];
  let intro = `Guten Tag — hier deine Übersicht für ${today}.`;
  // Issue 27 + 28: Wetter inkl. UV-Index zuerst, danach kein weiterer Wetter-
  // Teil. Issue 28: zusätzliches try/catch — wenn `weather.current` ein
  // unerwartetes Feld hat (z.B. fehlende `weather_code`), nicht den ganzen
  // Fallback-Briefing-Build umwerfen, sondern nur ohne Wetter-Satz weiter.
  try {
    if (weather && weather.current) {
      const [, label] = describeWeatherCode(weather.current.weather_code);
      const uvNow = typeof weather.current.uv_index === 'number' ? weather.current.uv_index : null;
      const uvMax = weather.daily && weather.daily[0] && typeof weather.daily[0].uv_index_max === 'number' ? weather.daily[0].uv_index_max : null;
      let uvTxt = '';
      if (uvNow != null) uvTxt = `, UV-Index ${uvNow.toFixed(1)}${uvMax != null ? ` (Tagesmax ${uvMax.toFixed(1)})` : ''}`;
      else if (uvMax != null) uvTxt = `, UV-Tagesmax ${uvMax.toFixed(1)}`;
      const temp = weather.current.temperature_2m != null ? `${weather.current.temperature_2m}°C, ` : '';
      intro += ` Wetter${weather.locationName ? ` in ${weather.locationName}` : ''}: ${temp}${label}${uvTxt}.`;
    }
  } catch (e) { console.warn('weather intro failed in fallback briefing', e); }
  lines.push(intro);

  if (top5 && top5.length) {
    // Issue 27: keine Quellenangaben mehr im Briefing — nur Titel + Datum.
    // Issue 30: Anzahl skaliert mit dem Längen-Faktor.
    const points = top5.slice(0, topCount).map((it) => {
      const date = it.date ? ` (${fmtDate(it.date)})` : '';
      return `„${(it.title || '').trim()}"${date}`;
    });
    lines.push('TOP HEUTE: ' + points.join('; ') + '.');
  }

  if (buckets) {
    for (const b of BUCKETS) {
      if (b.id === 'events') continue;
      // Issue 30: Items-pro-Rubrik skaliert mit dem Längen-Faktor.
      const arr = (buckets[b.id] || []).slice(0, perBucketCount);
      if (!arr.length) continue;
      // Issue 27: keine Quellen-Hinweise mehr — reine Titel-Liste.
      const points = arr.map((it) => `„${(it.title || '').trim()}"`);
      lines.push(`${b.label.toUpperCase()}: ${points.join('; ')}.`);
    }
  }

  const evs = (concreteEvents || []).slice(0, eventsCount);
  if (evs.length) {
    const points = evs.map((e) => {
      const t = e.title || e.event_name || '';
      const d = e.date || e.event_date || '';
      const loc = e.location || e.event_location || '';
      return `${t}${d ? ` (${d})` : ''}${loc ? ` @ ${loc}` : ''}`;
    });
    lines.push('EVENTS: ' + points.join('; ') + '.');
  }

  lines.push('Hinweis: Diese Zusammenfassung wurde lokal erzeugt, weil das Sprachmodell gerade keinen Text geliefert hat. Schau in die Rubriken für Details.');
  return lines.join('\n\n');
}

async function composeBriefing({ interests, profile, buckets, top5, weather }) {
  if (!buckets) return '';
  const filledBuckets = BUCKETS.filter((b) => (buckets[b.id] || []).length > 0);
  if (!filledBuckets.length && (!top5 || !top5.length)) return '';

  // Issue 30/43: Längen-Multiplikator (1|2|3|4|5) skaliert Satzanzahl,
  // Items-pro-Rubrik-Input und max_tokens. Bei Faktor ≥ 2 weisen wir den LLM
  // an, jeden Punkt ausführlicher einzuordnen (Hintergrund, Bedeutung,
  // Verknüpfung mit dem Profil) und mehr Items zu nennen.
  const lengthFactor = getBriefingLengthFactor();
  const topSentences = `${6 * lengthFactor}-${9 * lengthFactor}`;
  const bucketSentences = `${4 * lengthFactor}-${7 * lengthFactor}`;
  const totalParagraphs = `${6 * lengthFactor}-${9 * lengthFactor}`;
  // Items-pro-Sektion im LLM-Input — bei höherem Faktor mehr Material, damit
  // der LLM den längeren Text nicht aus dem Nichts strecken muss. Issue 43:
  // Cap von 12 auf 24 angehoben, damit Faktor 4× und 5× tatsächlich mehr
  // Input bekommen (vorher klemmten ≥2× am alten 12-er Cap fest).
  const itemsPerBucketInput = Math.min(24, 6 * lengthFactor);
  const top5InputCount = Math.min(24, 7 * lengthFactor);

  const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  // Issue 27: Wetter + UV-Index ZUERST im Briefing — danach kein weiterer
  // Wetter-Inhalt. uv_index liegt in weather.current (Issue-27-Erweiterung
  // in fetchWeather). uv_index_max in weather.daily[0].
  let weatherLine = '';
  // Issue 28: try/catch um die WETTER-HINT-Bildung — wenn weather.current ein
  // unerwartetes Format hat (z.B. ältere Cache-Variante), darf das nicht den
  // ganzen Briefing-Pfad killen.
  try {
    if (weather && weather.current) {
      const parts = [];
      if (weather.current.temperature_2m != null) parts.push(`${weather.current.temperature_2m}°C`);
      parts.push(describeWeatherCode(weather.current.weather_code)[1]);
      const uvNow = typeof weather.current.uv_index === 'number' ? weather.current.uv_index : null;
      const uvMax = weather.daily && weather.daily[0] && typeof weather.daily[0].uv_index_max === 'number' ? weather.daily[0].uv_index_max : null;
      if (uvNow != null) parts.push(`UV-Index ${uvNow.toFixed(1)}${uvMax != null ? ` (Tagesmax ${uvMax.toFixed(1)})` : ''}`);
      else if (uvMax != null) parts.push(`UV-Tagesmax ${uvMax.toFixed(1)}`);
      weatherLine = `Wetter in ${weather.locationName || 'deinem Ort'}: ${parts.join(', ')}.`;
    }
  } catch (e) { console.warn('weather hint build failed', e); }

  const sys = `Du schreibst ein AUSFÜHRLICHES, EVIDENZ-BASIERTES Tages-Briefing in DEUTSCH für einen User mit strukturiertem Profil. Heute ist ${today}.

Ziel: Der User soll nach dem Briefing einen umfassenden Überblick über alle wichtigen Themen des Tages haben, OHNE jede einzelne Karte anklicken zu müssen.

Form (mehrere Absätze, durch Leerzeilen getrennt):
1. Begrüßung (1-2 Sätze) UND — wenn WETTER-HINT übergeben — als erstes nach der Begrüßung 1-2 Sätze Wetter inkl. UV-Index. Wenn KEIN WETTER-HINT übergeben wird, lass den Wetter-Satz weg.
2. Absatz "Top heute" (${topSentences} Sätze): die wichtigsten Punkte des Tages, konkret mit Eigennamen / Zahlen / Orten. Sortiert nach Wichtigkeit. Jeder genannte Punkt bekommt 1-2 Sätze Einordnung — nicht nur Headlines aufzählen, sondern den Kontext erklären (was bedeutet das, warum jetzt relevant).${lengthFactor > 1 ? ` Bei Faktor ${lengthFactor}× greife pro Punkt 2-3 zusätzliche Sätze auf (Hintergrund, vorherige Entwicklung, möglicher Effekt auf das User-Profil) — bleib aber strikt bei der EVIDENZ-Regel unten.` : ''}
3. Pro GEFÜLLTER RUBRIK ein eigener Absatz, beginnend mit einem fett-ähnlichen Marker in Großbuchstaben + Doppelpunkt (z.B. "LOKAL: …", "TECH: …", "WATCHLIST: …"). ${bucketSentences} Sätze pro Rubrik. Bei mehreren wichtigen Items in einer Rubrik diese in 2-3 kurzen Sub-Sätzen mit Eigennamen einordnen — keine pauschalen Zusammenfassungen wie "Es gab mehrere Tech-News".${lengthFactor > 1 ? ` Bei Faktor ${lengthFactor}× nenne pro Rubrik MEHR Einzelmeldungen (so viele wie sinnvoll in den Input-Items vorhanden) und ordne sie jeweils ein — nicht künstlich zusammenpressen.` : ''}
4. Wenn die Rubrik "events" gefüllt ist, ein Absatz "EVENTS:" mit den 2-4 nächsten konkreten Terminen (Titel, Datum, Ort) in eigenen Sätzen.
5. Leere Rubriken weglassen (NICHT "keine Treffer" schreiben).
6. Abschluss-Satz (1 Satz): kompakte Empfehlung, was der User heute prioritär lesen sollte (Verweis auf den wichtigsten Punkt aus "Top heute").

⚠️ ISSUE 27 — KEINE QUELLENANGABEN UND KEIN ZWEITER WETTER-ABSATZ:
- NIEMALS Quellen, Hostnames, Domains oder Medien-Namen im Text nennen. Keine "laut suedkurier.de", keine "im Spiegel", keine "Quelle: …", keine Klammer-Quellen wie "(tagesschau)". Es geht NUR um den Inhalt.
- Nach dem Wetter-Satz in der Begrüßung NIEMALS noch einmal Wetter, Temperaturen, Niederschlag, UV-Index oder ähnliches im Briefing aufgreifen — die Wetter-Karte und der Begrüßungs-Satz reichen.

EVIDENZ-REGEL (sehr wichtig):
- Nur Fakten erwähnen, die in den übergebenen Items stehen. KEINE Spekulationen, KEINE "könnte/möglicherweise"-Auswirkungen.
- Wenn du eine Verbindung zum User-Profil ziehst, beziehe dich auf die mitgegebene "evidence" der Items — aber OHNE die Quelle namentlich zu nennen (siehe Issue-27-Regel oben).
- ⚠️ ISSUE 32 — BETROFFENHEIT > INTERESSE: Items im Format "[Int X/10 · Bet Y/10 …]" tragen zwei Scores. Wenn Bet > Int und das Item eine Zeile "Betroffenheit: …" enthält, GREIFE DIESEN SATZ IM BRIEFING AUF und formuliere ihn konkret aus — z.B. „Das könnte dich persönlich treffen, weil …" oder „Auch wenn dich das Thema bisher nicht beschäftigt hat: …". Diese Items sollen im Briefing-Text klar als „persönlich relevant" auftauchen, nicht nur als Hintergrund-Erwähnung. Wenn KEINE „Betroffenheit:"-Zeile mitgeliefert ist (also Int ≥ Bet), formuliere wie bisher — kein zusätzlicher Betroffenheits-Satz.
- ⚠️ ISSUE 31 — YOUTUBE-AUSNAHME: Bei YouTube-Items (gekennzeichnet durch 📺-Marker und „Kanal: <Name>") MUSST du im Briefing-Text den KANALNAMEN pro Video ausdrücklich nennen (z.B. „Auf dem Kanal Kurzgesagt geht es um …", „Veritasium erklärt, warum …"). Das ist die EINZIGE Ausnahme von der „keine Quellen"-Regel oben — der User möchte beim Hören wissen, von welchem Kanal jeder einzelne Beitrag stammt. Die Plattform „YouTube" musst du NICHT erwähnen, der Kanalname reicht. Wenn die YouTube-Rubrik mehrere Videos enthält, nenne pro Video den Kanal — keine pauschale „mehrere Kanäle berichten"-Sammelnennung.
- Keine Headlines wörtlich wiederholen — Kontext ergänzen, neu formulieren.
- Gib NUR Fließtext zurück. Kein JSON, kein Markdown, keine Aufzählungs-Bullets, keine URLs.

Länge: Der Gesamttext darf und soll deutlich länger sein als ein klassisches Kurz-Briefing — ziele auf ca. ${totalParagraphs} Absätze insgesamt, je nach Anzahl gefüllter Rubriken.${lengthFactor > 1 ? ` ⚠️ LÄNGEN-FAKTOR ${lengthFactor}× — der User hat im Setup eine ${lengthFactor === 2 ? 'doppelt' : lengthFactor === 3 ? 'dreifach' : lengthFactor === 4 ? 'vierfach' : 'fünffach'} so lange Zusammenfassung angefordert. Dehne JEDEN Absatz aus, statt nur Sätze knapp zu halten. Wenn du Material aus den Items wiederholt aufgreifst, mach es aus EINEM anderen Blickwinkel (z.B. Bedeutung, zeitliche Einordnung, Folge), nicht durch Umformulierung derselben Aussage.` : ''}`;

  // Issue 27: keine Quellen mehr im Item-Format — das Briefing-LLM darf
  // sie nicht erwähnen. Wir entfernen sie auch aus dem Input, damit
  // es nicht in Versuchung kommt.
  // Issue 31: Ausnahme für YouTube — der Kanalname (it.ytChannel) wird jetzt
  // mitgegeben und MUSS pro Video im Briefing vorkommen. Der Marker
  // "Kanal: <Name>" signalisiert dem LLM, welcher Eigenname zu welchem Item
  // gehört (vorher wusste er nur „YouTube-Video", ohne die Identität).
  const fmtItem = (it) => {
    const s = (it.summary || it.snippet || '').slice(0, 520);
    const ev = (it.evidence || '').slice(0, 240);
    let ytTag = '';
    if (it.origin === 'youtube') {
      const ch = (it.ytChannel || '').toString().trim();
      ytTag = ch ? ` · 📺 Kanal: ${ch.slice(0, 80)}` : ' · 📺';
    }
    // Issue 32: zwei Scores im Briefing-Input (statt der alten relevance).
    // affectedness_note nur dann anhängen, wenn affectedness > interest — das
    // signalisiert dem Briefing-LLM, dass diese Nachricht den User persönlich
    // betrifft und das in 1 Satz im Briefing-Text aufgreifen soll.
    const iv = typeof it.interestScore === 'number' ? it.interestScore : null;
    const av = typeof it.affectednessScore === 'number' ? it.affectednessScore : null;
    let scoreTag;
    if (iv != null && av != null) {
      scoreTag = `Int ${iv}/10 · Bet ${av}/10`;
    } else {
      scoreTag = `${(it.relevance || 0).toFixed(1)}/10`;
    }
    const affNote = (av != null && iv != null && av > iv && it.affectednessNote)
      ? `\n  Betroffenheit: ${String(it.affectednessNote).slice(0, 240)}`
      : '';
    return `[${scoreTag} · ${it.relevance_type || 'general'}${ytTag}] ${(it.title || '').slice(0, 200)}\n  Inhalt: ${s}${ev ? `\n  Evidenz: ${ev}` : ''}${affNote}`;
  };

  const sections = [];
  if (top5 && top5.length) {
    // Issue 10: mehr Top-Items mitgeben, damit der LLM einen längeren
    // "Top heute"-Absatz mit Konkretem füllen kann.
    // Issue 30: Anzahl skaliert mit dem Längen-Faktor (top5InputCount).
    sections.push(`TOP HEUTE:\n${top5.slice(0, top5InputCount).map(fmtItem).join('\n')}`);
  }
  for (const b of filledBuckets) {
    if (b.id === 'events') {
      const evs = buckets.events.slice(0, itemsPerBucketInput);
      sections.push(`RUBRIK ${b.label.toUpperCase()}:\n${evs.map((e) => `- ${e.title}${e.date ? ` (${e.date}${e.time ? ' ' + e.time : ''})` : ''}${e.location ? ` @ ${e.location}` : ''}${e.description ? ` — ${(e.description || '').slice(0, 200)}` : ''}`).join('\n')}`);
    } else {
      // Issue 10: mehr Items pro Rubrik (war 4) damit der LLM einen
      // längeren Absatz mit mehreren konkret genannten Punkten bauen kann.
      // Issue 30: Items-pro-Rubrik skaliert mit dem Längen-Faktor.
      const items = buckets[b.id].slice(0, itemsPerBucketInput);
      sections.push(`RUBRIK ${b.label.toUpperCase()}:\n${items.map(fmtItem).join('\n')}`);
    }
  }

  const userMsg = `USER-FREITEXT:
${interests || '(leer)'}

PROFIL (Standorte=${(profile?.locations || []).map((l) => l.name).join(', ') || '—'} · Module=${(profile?.modules || []).map((m) => m.id).join(', ') || '—'})

${weatherLine ? `WETTER-HINT: ${weatherLine}\n\n` : ''}${sections.join('\n\n')}`;

  // Issue 29: DeepSeek V4 Flash ist ein Reasoning-Modell — die `completion_tokens`
  // setzen sich aus internen `reasoning_tokens` PLUS dem sichtbaren Reply
  // zusammen. In Tests gegen den realen Briefing-Prompt schwanken die
  // reasoning_tokens stark (200 bis fast 2000) und schlucken bei
  // max_tokens=3500 gelegentlich das gesamte Budget — Resultat: `reply` ist
  // leerstring, der User sieht den lokalen Fallback. Drei Maßnahmen:
  //  (1) Token-Budget auf 6500 angehoben (max ist 8000 im tools-server).
  //  (2) Bei leerem oder absurd kurzem Reply (<200 chars) ein Retry mit dem
  //      Alternativ-Modell (Gemini hat keine reasoning_tokens und reagiert
  //      schneller). Welches "alternativ" ist, hängt vom aktuell gewählten
  //      Backend ab — wer Gemini eingestellt hat und einen leeren Reply
  //      bekommt, fällt umgekehrt auf DeepSeek zurück.
  //  (3) Klare Console-Logs für Post-Mortem-Debugging (siehe Aufruf-Stelle
  //      in runSummarize, die das `__briefingDiag` aus dem Wurf abfängt und
  //      ins Progress-Log streut).
  async function _briefingCall(modelOverride, maxTokens) {
    // Issue 35: HTTP-Status-bewusster Retry mit exponential Backoff bei
    // transienten Fehlern (429 Rate-Limit, 503 Service Unavailable, 502/504
    // Bad-Gateway/Timeout, Netzwerk-Abbruch ohne Status). Wir warten 1s → 3s
    // → 8s zwischen den Versuchen — die meisten aimlapi-Throttles entspannen
    // sich in dem Fenster. Erst danach werfen wir die Exception nach außen,
    // wo der Aufrufer ggf. das Modell wechselt.
    //
    // Issue 37: Zwei neue transient-Klassen:
    //   (a) HTTP 2xx mit leerem Reply (insbesondere HTTP 201/0c bei aimlapi —
    //       3 von 10 Calls in der gemeldeten Telemetry). `res.ok` ist true,
    //       also wirft __llmInvoke nicht, aber `reply` ist leer. Vorher fiel
    //       der Code direkt auf den Modell-Wechsel (composeBriefing-Ebene) —
    //       der zweite Backend rutschte oft in dasselbe Throttle-Fenster.
    //       Jetzt: erst innerhalb desselben Modells 3× retry mit Backoff.
    //   (b) HTTP 404 (1 von 10 Calls in der gemeldeten Telemetry) — wahrschein-
    //       lich kurzzeitige Endpoint-/Modell-Routing-Aussetzer bei aimlapi.
    //       Wenn es ein dauerhafter Konfig-Fehler wäre, kämen ALLE Calls als
    //       404 — die gemischte Telemetry zeigt, dass es transient ist.
    const backoffs = [1000, 3000, 8000];
    let lastErr;
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        const res = await api.llm({
          system: sys,
          messages: [{ role: 'user', content: userMsg }],
          temperature: 0.45,
          max_tokens: maxTokens,
          model: modelOverride,
        });
        const reply = (res && typeof res.reply === 'string' ? res.reply : '').trim();
        // Issue 37(a): leerer Reply trotz HTTP-Erfolg → transient retry.
        if (!reply && attempt < backoffs.length) {
          const wait = backoffs[attempt];
          console.warn(`[composeBriefing] empty LLM reply (HTTP-success/0c) — backoff ${wait}ms (attempt ${attempt + 1}/${backoffs.length})`, {
            model: modelOverride,
          });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        return {
          reply,
          usage: res ? res.usage : null,
          model: res ? res.model : modelOverride,
        };
      } catch (e) {
        lastErr = e;
        const status = e && typeof e.status === 'number' ? e.status : null;
        const msg = (e && e.message ? String(e.message) : '').toLowerCase();
        const isTransient =
          status === 429 ||
          // Issue 39: ALLE HTTP 5xx (500, 501, 502, 503, 504, 505, …) als
          // transient klassifizieren, nicht nur die zuvor explizit gelisteten
          // 502/503/504. Hintergrund: der gemeldete Failure-Run zeigte
          // weitere 5xx-Stati (500, 501) bei aimlapi-Backend-Aussetzern, die
          // vorher direkt durchwarfen und damit den Modell-Wechsel-Pfad in
          // dasselbe Throttle-Fenster lockten. Innerhalb der Klasse 5xx ist
          // ein Backoff-Retry der korrekte Reflex.
          (typeof status === 'number' && status >= 500 && status < 600) ||
          // Issue 37(b): 404 als transient klassifizieren.
          status === 404 ||
          (status == null && /failed|network|timeout|abort|fetch/.test(msg));
        if (isTransient && attempt < backoffs.length) {
          const wait = backoffs[attempt];
          console.warn(`[composeBriefing] transient LLM error — backoff ${wait}ms (attempt ${attempt + 1}/${backoffs.length})`, {
            model: modelOverride, status, message: e && e.message,
          });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // Issue 30: MIN_OK_LEN skaliert mit dem Längen-Faktor, damit ein 2×/3×-
  // Briefing nicht versehentlich als „zu kurz" gewertet wird, wenn der LLM
  // eine vernünftige 1×-Antwort liefert.
  const MIN_OK_LEN = 200 * lengthFactor;
  // Issue 30/43: max_tokens skaliert mit dem Faktor.
  // 1× = 6500 (Bestand seit Issue 29), 2× = 8000, 3× = 10000, 4× = 13000,
  // 5× = 16000. Seit Issue 42 läuft der Pfad direkt über aimlapi (kein
  // tools-server-8000-Cap mehr), die Provider-Output-Limits (DeepSeek 8K,
  // Gemini 65K, Grok 16K, Qwen 8K, Nemotron 4K) klemmen ggf. selber — das
  // ist akzeptiert, der Reply wird dann zwar abgeschnitten, aber MIN_OK_LEN
  // greift dank Skalierung weiter sauber.
  const briefingMaxTokens =
    lengthFactor === 1 ? 6500 :
    lengthFactor === 2 ? 8000 :
    lengthFactor === 3 ? 10000 :
    lengthFactor === 4 ? 13000 :
    16000;
  const primaryModel = currentLlmModel();

  // Issue 35: Cooldown vor dem ersten Briefing-Call. runSummarize hat gerade
  // einen Burst an Scoring-/Klassifikator-Calls gegen aimlapi geschickt
  // (Concurrency-Limit hält die Spitze flach, aber die Antworten kommen oft
  // in einem engen Zeitfenster zurück). 1.5s Pause sorgt dafür, dass der
  // teure composeBriefing-Call nicht direkt in das Burst-Window fällt.
  await new Promise((r) => setTimeout(r, 1500));

  // Modell explizit übergeben, damit das Fallback NICHT denselben Backend-
  // Switch nochmal nimmt (api.llm ohne `model` würde aus LS lesen).
  let first;
  try {
    first = await _briefingCall(primaryModel, briefingMaxTokens);
  } catch (e) {
    console.warn('[composeBriefing] primary LLM threw', { model: primaryModel, err: e && e.message });
    first = { reply: '', usage: null, model: primaryModel, _threw: e };
  }

  if (first.reply.length >= MIN_OK_LEN) return first.reply;

  // Issue 40: KEIN automatischer Wechsel auf ein alternatives Modell mehr.
  // Vorher fiel composeBriefing bei zu kurzem/leerem Reply automatisch von
  // DeepSeek auf Gemini (oder umgekehrt) zurück. Issue 40 verlangt explizit
  // „die automatische Modell-Umschaltung soll nicht implementiert werden" —
  // mit der Erweiterung auf 5 Modelle wäre ein einzelner Auto-Fallback ohnehin
  // willkürlich. Der User wählt sein Modell bewusst; wenn es scheitert,
  // greift der existierende lokale Fallback-Briefing-Pfad (runSummarize
  // erkennt den leeren Reply und ruft buildFallbackBriefing). Die Issue-35-
  // Retry-Logik (1s→3s→8s Backoff bei 429/5xx/leerem 2xx) sowie das Issue-36
  // Debug-Panel bleiben unverändert — sie wirken alle innerhalb DESSELBEN
  // gewählten Modells.
  console.warn('[composeBriefing] reply too short — no auto-switch (Issue 40); falling through to local fallback', {
    primaryModel,
    primaryReplyLen: first.reply.length,
    primaryUsage: first.usage,
    recentTelemetry: recentLlmTelemetry(15).map(formatLlmTelemetryLine),
  });

  return first.reply;
}

// =============================================================================
// Event-Extraktion (Issue 4)
// =============================================================================
//
// Die `events`-Suche liefert "Listings" — generische Eventportale, Stadt-
// Veranstaltungskalender, Eventbrite-Suchseiten etc. ("100.000 Events in …").
// Damit der User echte Events sieht, scrapen wir die Top-Listings mit
// Trafilatura (`/tools/web/extract`) und übergeben den extrahierten
// Fließtext-Block an die LLM mit der Aufforderung, daraus konkrete
// Einzel-Events (Titel, Datum, Uhrzeit, Ort, Beschreibung) zu extrahieren.

// Issue 13: aus dem User-Profil direkte Stadt-Event-Seiten ableiten — die
// werden als zusätzliche Seeds an extractEventsFromListings übergeben, damit
// echte lokale Event-Kalender garantiert gecrawlt werden. Pro Standort werden
// 1-2 Kandidaten-URLs gebaut: `<slug>-info.com/events` (typisch für Stadt-
// Tourismus-Seiten wie konstanz-info.com, das im Konzept als Beispiel genannt
// ist) und `eventfinder.de/<slug>/veranstaltungen/` (deckt viele deutsche
// Mittelstädte ab). Wenn eine der URLs nichts liefert, fällt der Trafilatura/
// Playwright-Crawl einfach mit leerem Text raus — kein Hard-Fail.
function buildLocalEventSeeds(profile) {
  if (!profile || !Array.isArray(profile.locations)) return [];
  const seen = new Set();
  const out = [];
  const slugify = (name) => String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // diakritische Zeichen
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  for (const loc of profile.locations.slice(0, 3)) {
    const city = (loc.name || '').split(',')[0].trim();
    const slug = slugify(city);
    if (!slug || slug.length < 3) continue;
    // Stadt-Tourismus-Eventkalender (Konzept-Beispiel: konstanz-info.com/events).
    const cityInfo = `https://www.${slug}-info.com/events`;
    if (!seen.has(cityInfo)) { seen.add(cityInfo); out.push({ url: cityInfo, title: `${city} Eventkalender (${slug}-info.com)` }); }
    // Generischer Stadt-Kalender — deckt viele Mittelstädte ab.
    const finder = `https://www.eventfinder.de/${slug}/veranstaltungen/`;
    if (!seen.has(finder)) { seen.add(finder); out.push({ url: finder, title: `Veranstaltungen ${city} (eventfinder.de)` }); }
  }
  return out;
}

async function extractEventsFromListings({ listings, location, when, topic, window, profile }) {
  if (!listings || !listings.length) return { events: [], dropped: 0, rendered: 0, droppedDistance: 0 };

  // Issue 12: bis zu 8 Quellen (war 6) — die meisten Listing-Seiten liefern
  // nur 0-2 konkrete Termine pro Crawl (viel Boilerplate, wenig Datum),
  // mehr Quellen erhöhen die Wahrscheinlichkeit, dass am Ende überhaupt
  // konkrete Events extrahiert werden statt nur Seiten-Links.
  const top = listings.slice(0, 8);

  // Issue 6: Trafilatura first, mit headless-Chromium-Fallback. Viele
  // Event-Portale (Eventbrite, Meetup, Stadt-Veranstaltungskalender) sind
  // JS-gerendert — Trafilatura sieht dann nur ein leeres Skelett. Wenn der
  // Extract weniger als 500 Zeichen lesbaren Text liefert, holen wir die
  // Seite per Playwright nach.
  let renderedCount = 0;
  const pages = await Promise.allSettled(
    top.map(async (l) => {
      let extractData = null;
      try { extractData = await api.webExtract(l.url); } catch {}
      const extractText = ((extractData && extractData.text) || '').trim();
      if (extractText.length >= 500) {
        return { data: extractData, fromRender: false };
      }
      // Render-Fallback. Wenn der auch fehlschlägt, nehmen wir den dünnen
      // Extract-Text trotzdem (immer noch besser als nichts).
      try {
        const r = await api.webRender(l.url, { wait_ms: 1800, timeout: 25 });
        const renderedText = (r.text || '').trim();
        if (renderedText.length > extractText.length) {
          renderedCount++;
          return {
            data: {
              title: (extractData && extractData.title) || r.title || '',
              text: renderedText,
            },
            fromRender: true,
          };
        }
      } catch {}
      return { data: extractData, fromRender: false };
    })
  );

  const sources = [];
  pages.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value || !r.value.data) return;
    const data = r.value.data;
    const text = (data.text || '').trim();
    // Issue 12: Schwellenwert von 100 → 80 Zeichen — sehr knapp formatierte
    // Stadt-Kalender-Seiten ("Sa 25.5. · 20:00 · Konzert XY") liegen oft
    // knapp unter 100 Zeichen pro Eintrag.
    if (text.length < 80) return;
    sources.push({
      url: top[i].url,
      source: sourceFromUrl(top[i].url),
      pageTitle: data.title || top[i].title || '',
      // Issue 12: 4500 → 6000 Zeichen, damit Stadt-Kalender mit vielen
      // Terminen pro Seite vollständig verarbeitet werden können.
      text: text.slice(0, 6000),
    });
  });

  if (!sources.length) return { events: [], dropped: 0, rendered: renderedCount, droppedDistance: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const win = window || eventWindow();
  const currentYear = new Date().getFullYear();

  // Issue 13: Prompt verlangt das schmalere Schema aus dem Konzept
  // ({event_name, event_date, event_time, event_summary}). event_location und
  // sourceIndex bleiben optional, weil wir sie für Distanz-Filter / Quellen-
  // Anzeige weiter brauchen — wenn das LLM sie weglässt, fallen wir auf die
  // Profil-Heimstadt bzw. die erste Quelle zurück. Beispiel kommt jetzt aus
  // konstanz-info.com (Konzept-Beispiel), inkl. typischer SPA-Boilerplate, die
  // korrekt ignoriert werden muss.
  const sys = `Du bist ein Event-Extraktor. Aus Roh-Text gescrapter Veranstaltungs-Webseiten (z.B. konstanz-info.com/events, Stadt-Kalender, Eventbrite, Meetup) ziehst du KONKRETE Einzel-Termine.

Heute ist ${today} (Jahr ${currentYear}). User sucht Events in „${location}"${when ? ` (Zeitraum: ${when})` : ''}${topic ? `, Thema: „${topic}"` : ''}.

⚠️ HARTE ZEITGRENZE: Nur Events mit konkretem Datum zwischen ${win.start} und ${win.end} (inklusive, ca. ${win.days} Tage). Alles davor/danach ODER ohne Einzeldatum komplett überspringen.

OUTPUT-FORMAT (NUR JSON, kein Markdown, keine Erklärungen davor/dahinter):
{
  "events": [
    {
      "event_name": "Konkreter Event-Name",
      "event_date": "YYYY-MM-DD",
      "event_time": "HH:MM",
      "event_summary": "1-2 Sätze: was läuft konkret?",
      "event_location": "Venue, Stadt (optional)",
      "sourceIndex": 0
    }
  ]
}

BEISPIEL 1 (Konstanzer Stadt-Eventkalender, Roh-Text → Extraktion):

Roh-Text aus konstanz-info.com/events: "Eventkalender Konstanz. Sa, 25.05.2026 · 20:00 Uhr · The Magic of ABBA — Europe's No. 1 Concert Show im Bodenseeforum Konstanz. // Fr 29.05. 19:30 Konzert Die Toten Hosen, Bodenseearena Konstanz, Tickets ab 45€. // Demnächst: viele weitere Veranstaltungen in Konstanz // Newsletter abonnieren"

Extraktion:
{"events":[
  {"event_name":"The Magic of ABBA","event_date":"2026-05-25","event_time":"20:00","event_summary":"Tribute-Show zur ABBA-Musik mit Originalsound und Bühnenoptik.","event_location":"Bodenseeforum, Konstanz","sourceIndex":0},
  {"event_name":"Die Toten Hosen — Live","event_date":"2026-05-29","event_time":"19:30","event_summary":"Konzert der Düsseldorfer Punkband; Tickets ab 45€.","event_location":"Bodenseearena, Konstanz","sourceIndex":0}
]}

(Den Sammeleintrag „viele weitere Veranstaltungen" und „Newsletter abonnieren" hast du korrekt IGNORIERT — keine Einzel-Daten / kein Event.)

DATUMS-ERKENNUNG — typische Muster im Roh-Text:
- "25.05.2026", "25.5.26", "25. Mai 2026", "Sa 25.05.", "May 25, 2026", "2026-05-25", "Sa, 25.5."
- Wenn nur Tag+Monat (z.B. "Sa 25.5.") → nimm das NÄCHSTE zukünftige Datum mit diesem Tag/Monat ab heute; nur akzeptieren wenn es in das Fenster ${win.start}…${win.end} passt.
- Wenn überhaupt kein konkretes Datum erkennbar → Event NICHT in Output aufnehmen.

REGELN:
- Nur EINZELNE konkrete Termine — KEINE Sammelwörter ("jeden Freitag", "diverse Konzerte", "über 100 Veranstaltungen", "tägliche Führungen ohne genaue Daten").
- event_date: striktes Format YYYY-MM-DD.
- event_time: HH:MM (24h). Wenn keine Uhrzeit angegeben → "".
- event_location: möglichst "Venue, Stadt". Wenn nur Stadt erkennbar → "${location}". Darf leer sein.
- event_summary: 1-2 sachliche Sätze. Wenn die Quelle nichts beschreibt → ein Satz wie "Veranstaltung im Rahmen [Reihe]" reicht; aber niemals den Titel wörtlich wiederholen.
- sourceIndex: Integer 0-${sources.length - 1}, MUSS gesetzt sein.
- Maximal 12 Events Gesamt-Output. Wenn die Quellen mehr hergeben, wähle die zeitlich NÄCHSTEN.
- KEINE generischen Plattform-Hinweise/Navi/Footer ("Auf Eventbrite findest du …", "Newsletter abonnieren", "Tickets jetzt sichern", "Cookie-Einstellungen").

SELF-CHECK vor Rückgabe: hat JEDES Event ein konkretes Datum im Fenster? Wenn nicht → raus.
Lieber 2 saubere Events als 10 erfundene — leere Liste ist OK, wenn die Roh-Texte wirklich nichts Konkretes hergeben.`;

  const userText = sources.map((s, i) => `=== QUELLE ${i}: ${s.source} ===
${s.pageTitle ? `Seitentitel: ${s.pageTitle}\n` : ''}URL: ${s.url}

${s.text}`).join('\n\n');

  let parsed;
  try {
    const res = await api.llm({
      system: sys,
      messages: [{ role: 'user', content: userText }],
      // Issue 12: temperature 0.2 → 0.15 für maximale Stabilität (das Format
      // ist sehr strikt, kreative Variation hilft nicht). max_tokens 2000 →
      // 2800 weil bei 8 Quellen + 12 Events das alte Limit knapp wurde.
      temperature: 0.15,
      max_tokens: 2800,
    });
    parsed = safeJsonExtract(res.reply || '') || {};
  } catch (e) {
    console.warn('event extraction failed', e);
    return { events: [], dropped: 0, rendered: renderedCount, droppedDistance: 0 };
  }

  const raw = Array.isArray(parsed.events) ? parsed.events : [];

  // Mapping + Datum-Sanity (Issue 5): wir trauen dem LLM nicht blind und
  // filtern hart auf das Fenster [win.start, win.end]. Events ohne valides
  // ISO-Datum fallen ebenfalls raus, weil "zeitliche Nähe" nicht garantiert
  // werden kann.
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  let dropped = 0;
  // Issue 13: das neue Konzept-Schema heißt `event_name/event_date/event_time/
  // event_summary` (+ optional `event_location`). Alte Antworten mit
  // `title/date/time/location/description` bleiben akzeptiert — kein Hard-Fail
  // wenn die LLM einmal zur alten Form rutscht.
  const pickStr = (e, ...keys) => {
    for (const k of keys) {
      const v = e && e[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  const candidates = raw
    .filter((e) => e && (typeof e.event_name === 'string' || typeof e.title === 'string'))
    .map((e) => {
      const srcIdx = Number.isInteger(e.sourceIndex) && e.sourceIndex >= 0 && e.sourceIndex < sources.length
        ? e.sourceIndex
        : 0;
      const src = sources[srcIdx] || sources[0];
      const title = pickStr(e, 'event_name', 'title').slice(0, 200);
      const date = pickStr(e, 'event_date', 'date').slice(0, 10);
      const time = pickStr(e, 'event_time', 'time').slice(0, 5);
      // event_location ist optional — wenn das LLM es weglässt, übernehmen wir
      // die User-Heimstadt (Funktions-Parameter `location`), damit der
      // Distanz-Filter weiter sinnvoll greift.
      const evLocation = (pickStr(e, 'event_location', 'location') || location || '').slice(0, 200);
      const description = pickStr(e, 'event_summary', 'description').slice(0, 400);
      return {
        title,
        date,
        time,
        location: evLocation,
        description,
        url: src.url,
        source: src.source,
      };
    })
    .filter((e) => {
      if (!e.title || e.title.length < 3) { dropped++; return false; }
      if (!isoRe.test(e.date)) { dropped++; return false; }
      if (e.date < win.start || e.date > win.end) { dropped++; return false; }
      return true;
    });

  // Issue 8: Geocoding + Distanz-Filter ≤ EVENT_MAX_KM (20 km) gegen den
  // ersten Profil-Standort mit Koordinaten. Wenn das Profil keinen geo-
  // codierten Standort hat (z.B. nicht generiert oder Geocoding fehlgeschlagen),
  // überspringen wir den Filter — sonst wäre die App ohne Profil leer.
  const home = (profile && profile.locations || []).find((l) => l.lat != null && l.lng != null);
  let droppedDistance = 0;
  let mapped = candidates;
  if (home) {
    // Reverse-Lookup-Cache pro Stadtname, damit wir nicht für jeden Event
    // einzeln Nominatim aufrufen. Wir extrahieren den Stadt-/Ortsteil aus
    // `location` als ersten Token vor Komma — typische Eingabe ist
    // "Stadthalle Konstanz, Bodanplatz 1, 78462 Konstanz".
    const geoCache = new Map();
    const queries = new Set();
    for (const e of candidates) {
      const q = pickPlaceQuery(e.location, location);
      if (q) queries.add(q);
    }
    await Promise.all(Array.from(queries).map(async (q) => {
      try {
        const r = await api.geocode(q);
        const first = (r.results || r || [])[0];
        if (first && typeof first.lat === 'number') {
          geoCache.set(q, { lat: first.lat, lng: first.lng });
        }
      } catch { /* ignore */ }
    }));

    mapped = candidates.filter((e) => {
      const q = pickPlaceQuery(e.location, location);
      const coords = q && geoCache.get(q);
      if (!coords) {
        // Kein Geo → fallback: wenn der User-Stadtname im event.location auftaucht,
        // halten wir es (sonst zu strikt). Sonst rauswerfen.
        const homeName = home.name.split(',')[0].trim().toLowerCase();
        if (homeName && (e.location || '').toLowerCase().includes(homeName)) {
          e.distanceKm = 0;
          return true;
        }
        droppedDistance++;
        return false;
      }
      const dist = haversineKm(home.lat, home.lng, coords.lat, coords.lng);
      e.distanceKm = Math.round(dist * 10) / 10;
      if (dist > EVENT_MAX_KM) { droppedDistance++; return false; }
      return true;
    });
  }

  mapped = mapped.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);

  return { events: mapped, dropped, rendered: renderedCount, droppedDistance };
}

// Hilfsfunktion: extrahiert aus der LLM-Location-String einen sinnvollen
// Geocode-Query — bevorzugt "Venue + Stadt", fällt auf User-Stadt zurück.
function pickPlaceQuery(eventLocation, fallbackCity) {
  const s = (eventLocation || '').trim();
  if (!s) return fallbackCity || '';
  // Wenn Komma drin: nimm letzten nicht-leeren Bestandteil (oft "Stadt"
  // oder "PLZ Stadt") + ersten (Venue/Adresse) für Präzision.
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}, ${parts[parts.length - 1]}`;
  }
  return s;
}

function renderEventDate(dateStr, timeStr) {
  if (!dateStr) return timeStr || '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr + (timeStr ? ` · ${timeStr}` : '');
    const datePart = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short' }).format(d);
    return datePart + (timeStr ? ` · ${timeStr}` : '');
  } catch {
    return dateStr + (timeStr ? ` · ${timeStr}` : '');
  }
}

// =============================================================================
// Issue 14: Lokal-News-Extraktion (analog zur Event-Extraktion)
// =============================================================================
//
// Bug-Hintergrund: Vor Issue 14 wurde die Lokal-Rubrik nur dadurch befüllt,
// dass der LLM-Scorer einzelnen RSS/Web-Items den Bucket `lokal` zuwies, bzw.
// die `localityScore`-Heuristik den Stadtnamen im Title/Snippet fand. In der
// Praxis hieß das: kaum Items in der Rubrik, weil regionale Tageszeitungen
// selten den Stadtnamen IN der Schlagzeile tragen — sondern als Rubrik-Label
// auf der Listing-Seite. Ergebnis: oben die Wetter-Karte (separate Sektion),
// und drunter eine fast leere bis komplett leere Lokal-Rubrik — was beim
// User den Eindruck erweckte, „Lokal zeigt nur Wetter".
//
// Fix analog zu Events: regionale Listing-Seiten direkt crawlen
// (Trafilatura + Playwright-Fallback) und per LLM in JSON ein Array von
// `{title, date, source, summary}` extrahieren. Diese Einträge werden in
// `bucketizeItems` an den Anfang von `out.lokal` gestellt. Wetter bleibt
// eine eigene Sektion oberhalb der Rubriken — unverändert.

// Sucht via DuckDuckGo regionale News-Listings für jede geocodierte Heim-
// Location aus dem Profil. Ein Crawl pro Stadt reicht — der LLM zieht
// danach Einzelmeldungen raus.
async function findLocalNewsSeeds(profile, { perCityCap = 5, maxCities = 2 } = {}) {
  if (!profile || !Array.isArray(profile.locations) || !profile.locations.length) {
    return { seeds: [], filteredJunk: 0, filteredByLLM: 0, classBreakdown: null };
  }
  const out = [];
  const seen = new Set();
  let filteredJunk = 0;
  for (const loc of profile.locations.slice(0, maxCities)) {
    const city = (loc.name || '').split(',')[0].trim();
    if (!city || city.length < 3) continue;
    // Issue 17: Eine zusätzliche, news-lastigere Query — die ursprünglichen
    // zwei Queries („Lokalnachrichten X aktuell" / „Nachrichten X heute") landen
    // bei DDG häufig auf Tourismus-Portalen (`xyz-info.com`), Wetter-Seiten oder
    // Instagram. Die dritte Query bevorzugt klassische News-Worte (Polizei,
    // Rathaus, Stadtrat) und produziert deutlich weniger Junk.
    const queries = [
      `Lokalnachrichten ${city} aktuell`,
      `Nachrichten ${city} heute`,
      `${city} Polizei Rathaus Stadtrat Meldung`,
    ];
    for (const q of queries) {
      try {
        // Issue 17: Mehr Roh-Treffer holen (8 statt 6), damit nach der
        // Junk-Filterung pro Query noch genug saubere News übrig bleiben.
        const r = await api.search(q, { max: 8, time: 'w' });
        let perQuery = 0;
        for (const it of (r.results || [])) {
          if (!it || !it.url || seen.has(it.url)) continue;
          // Issue 17: Tourismus-/Social-/Wetter-/Event-Aggregator-Domains
          // direkt verwerfen — sonst füttern wir den LLM-Extraktor mit
          // Seiten, aus denen er definitionsgemäß keine News ziehen kann.
          if (isNonLocalNewsHost(it.url)) {
            seen.add(it.url);
            filteredJunk++;
            continue;
          }
          seen.add(it.url);
          out.push({ url: it.url, title: it.title || '', snippet: it.snippet || '', city });
          perQuery++;
          if (perQuery >= perCityCap) break;
        }
      } catch { /* per Stadt+Query weiterprobieren */ }
    }
  }
  // Issue 19: LLM-Vorab-Klassifikation der Suchergebnisse anhand von Titel +
  // Snippet — VOR dem teuren Playwright/Trafilatura-Crawl. Statt immer mehr
  // Domain-Patterns zu pflegen (whack-a-mole), lässt der LLM jeden Treffer
  // in eine von vier Kategorien fallen: `lokalnachricht` (echte
  // Tageszeitungs-Artikel), `event` (Veranstaltungs-Übersichts­seiten wie
  // veranstaltungen.meinestadt.de/konstanz/alle/alle), `wetter` (Vorhersage-
  // Seiten), `irrelevant` (Tourismus, Wikipedia, Stadtmarketing, Social
  // Media). Nur `lokalnachricht` geht weiter in den Crawler-+-Extraktor-Pfad.
  // Wetter- und Event-Treffer landen NICHT in der Lokal-Pipeline — Wetter
  // hat eine eigene Karte, Events kommen aus dem dedizierten Extraktor.
  let filteredByLLM = 0;
  let classBreakdown = null;
  if (out.length) {
    try {
      const classes = await classifyLocalSearchResults(out);
      classBreakdown = { lokalnachricht: 0, event: 0, wetter: 0, irrelevant: 0, 'übersichtsseite': 0 };
      const kept = [];
      for (let i = 0; i < out.length; i++) {
        const c = classes[i] || 'lokalnachricht';
        classBreakdown[c] = (classBreakdown[c] || 0) + 1;
        if (c === 'lokalnachricht') kept.push(out[i]);
        else filteredByLLM++;
      }
      return { seeds: kept, filteredJunk, filteredByLLM, classBreakdown };
    } catch (e) {
      // Fail-open: LLM-Call fehlgeschlagen → vor Issue 19 verhalten und alle
      // Junk-Host-gefilterten Seeds durchreichen. Lieber etwas mehr Crawl-
      // Aufwand als gar keine Lokal-News in der Rubrik.
      console.warn('local seed classification failed, falling back to host-filter only', e);
    }
  }
  return { seeds: out, filteredJunk, filteredByLLM, classBreakdown };
}

// Issue 19: LLM-basierte Vorab-Klassifikation der DDG-Suchergebnisse für
// die Lokal-News-Pipeline. Input: Array von `{url, title, snippet}`. Output:
// Array gleicher Länge mit Kategorien `"lokalnachricht" | "event" | "wetter"
// | "irrelevant"`. Ein einziger LLM-Call für alle Items zusammen (typisch
// 15-30 Items pro Run, also <2k Tokens). Bei Parse-Fehlern oder fehlenden
// Index-Antworten fallen die betroffenen Items defensiv auf
// `lokalnachricht` zurück (fail-open — der nachgeschaltete extractLocalNews-
// Prompt klassifiziert nochmal mit `typ`-Feld und sortiert dort aus).
async function classifyLocalSearchResults(items) {
  if (!items || !items.length) return [];
  const compact = items.map((it, i) => ({
    i,
    title: (it.title || '').slice(0, 200),
    url: (it.url || '').slice(0, 200),
    snippet: (it.snippet || '').replace(/\s+/g, ' ').slice(0, 280),
  }));
  const sys = `Du klassifizierst DuckDuckGo-Suchergebnisse aus einer Lokal-News-Suche („Lokalnachrichten <Stadt> …"). Pro Treffer entscheidest du anhand von Titel + URL + Snippet, was das für eine Seite ist.

Kategorien (genau eine pro Treffer):
- "lokalnachricht" → klassische Lokalzeitungs-/Regionalzeitungs-EINZELARTIKEL (suedkurier.de/article/…, schwaebische.de/…, lokalkompass.de/…). Polizei-Berichte, Stadtrat, Schulen, Unfälle, Wirtschaft-Lokal, Kultur-Berichterstattung, Personen-Porträts, Gerichtsurteile, Bauprojekte. DAS ist was wir wollen.
- "übersichtsseite" → Ressort-/Hub-/Index-Seiten ohne konkrete Einzelmeldung (Listenseiten von Tageszeitungen, Tag-/Themen-Übersichten, „Alle Meldungen heute", Newsticker-Sammelseiten, „/region/konstanz/" als reine Listing-URL ohne Story). Hinweise: URL endet auf einem Kategorie-Slug oder „/news/" ohne Story-ID; Titel „Lokales | Suedkurier", „Region Konstanz — News-Übersicht"; Snippet listet Schlagzeilen ohne Story. Solche Treffer werden VERWORFEN — die App will nur Einzelartikel.
- "event" → Veranstaltungs-Übersichts­seiten, Eventkalender, Termin-Listen, Festival-Sites. Beispiele: "veranstaltungen.meinestadt.de/konstanz/alle/alle", "events.konstanz.de", "konstanz-info.com/events", "regioactive.de/konstanz/konzerte", "stadtkalender.<x>.de", "termine.<x>.de". Hinweise im Titel/Snippet: „Veranstaltungen", „Eventkalender", „Termine", „Was ist heute los", „Konzerte", „Programm".
- "wetter" → Wetter-Vorhersage, „Wetter heute", „°C", „Niederschlag", „7-Tage-Trend", „Wetterbericht", Wetterstation-Seiten.
- "irrelevant" → alles andere: Tourismus-Werbung ohne News-Inhalt, Wikipedia, Stadtmarketing-Portale, Social Media, Hotel-/Booking-Seiten, Foren, Forum-Posts, Karriere-Seiten, generische Stadt-Portale ohne Redaktion, Vereins-Webseiten.

Entscheidungs-Regeln:
- Wenn URL oder Titel das Wort „Veranstaltung", „Event", „Termin", „Kalender", „Konzert", „Festival" prominent enthält → „event".
- Wenn URL oder Titel das Wort „Wetter", „Vorhersage", „Klima" enthält → „wetter".
- Wenn die Domain eindeutig eine Regionalzeitung ist (z.B. „suedkurier", „schwaebische", „südkurier", „nordkurier", „rheinpfalz", „mz-web", „rp-online") UND das Snippet konkret eine Meldung andeutet → „lokalnachricht".
- Bei Unsicherheit zwischen „lokalnachricht" und „irrelevant": wenn die Seite überhaupt Redaktion / News-Struktur erkennen lässt → „lokalnachricht" (lieber durchlassen, der nächste Schritt filtert mit mehr Kontext nochmal).
- Bei Unsicherheit zwischen „lokalnachricht" und „event": wenn Event-Bezug klar überwiegt → „event" (Events werden in der App separat verarbeitet, kein Verlust).

Output AUSSCHLIESSLICH als JSON (kein Markdown, kein Text davor/danach):
{"classifications":[{"i":0,"c":"lokalnachricht"},{"i":1,"c":"event"},...]}

Pflicht: pro Input-Item GENAU ein Eintrag mit demselben "i".`;

  const userText = `Bitte klassifiziere diese ${compact.length} Suchergebnisse:

${JSON.stringify(compact, null, 1)}`;

  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: userText }],
    temperature: 0.0,
    max_tokens: 1400,
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  const arr = Array.isArray(parsed.classifications) ? parsed.classifications : [];
  const byIdx = new Map();
  for (const c of arr) {
    if (!c || !Number.isInteger(c.i)) continue;
    const raw = String(c.c || '').trim().toLowerCase();
    let norm = 'lokalnachricht';
    if (raw === 'event' || raw === 'veranstaltung' || raw === 'termin' || raw === 'events') norm = 'event';
    else if (raw === 'wetter' || raw === 'weather' || raw === 'vorhersage') norm = 'wetter';
    else if (raw === 'irrelevant' || raw === 'tourismus' || raw === 'wiki') norm = 'irrelevant';
    // Issue 27: Ressort-/Hub-Seiten — sortieren wir aktiv aus, damit die Lokal-
    // Rubrik nur Einzelartikel zeigt.
    else if (raw === 'übersichtsseite' || raw === 'uebersichtsseite' || raw === 'overview' || raw === 'hub' || raw === 'index' || raw === 'liste') norm = 'übersichtsseite';
    else if (raw === 'lokalnachricht' || raw === 'nachricht' || raw === 'news' || raw === 'lokal') norm = 'lokalnachricht';
    else norm = 'lokalnachricht';
    byIdx.set(c.i, norm);
  }
  return items.map((_, i) => byIdx.get(i) || 'lokalnachricht');
}

async function extractLocalNewsFromListings({ listings, location, profile }) {
  if (!listings || !listings.length) return { news: [], dropped: 0, rendered: 0, followedArticles: [] };

  // Wie bei Events: max. 8 Quellen — der LLM-Kontext skaliert sonst zu sehr,
  // und die meisten Listing-Seiten geben pro Crawl 0-3 saubere Einzel-News her.
  const top = listings.slice(0, 8);

  let renderedCount = 0;
  const pages = await Promise.allSettled(
    top.map(async (l) => {
      let extractData = null;
      try { extractData = await api.webExtract(l.url); } catch {}
      const extractText = ((extractData && extractData.text) || '').trim();
      if (extractText.length >= 500) {
        // Issue 44: HTML separat besorgen, damit der Link-Follower Anker
        // einsammeln kann — Trafilatura liefert keinen HTML-Body.
        return { data: extractData, fromRender: false, html: '' };
      }
      try {
        const r = await api.webRender(l.url, { wait_ms: 1800, timeout: 25 });
        const renderedText = (r.text || '').trim();
        if (renderedText.length > extractText.length) {
          renderedCount++;
          return {
            data: {
              title: (extractData && extractData.title) || r.title || '',
              text: renderedText,
            },
            fromRender: true,
            html: (r && r.html) || '',
          };
        }
      } catch {}
      return { data: extractData, fromRender: false, html: '' };
    })
  );

  const sources = [];
  pages.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value || !r.value.data) return;
    const data = r.value.data;
    const text = (data.text || '').trim();
    // Issue 18: Schwelle 200 Zeichen (vorher 80). Kürzere Texte sind in der
    // Praxis Cookie-Banner, Login-Walls oder leere SPA-Shells — der LLM
    // produziert daraus eher Halluzinationen als echte Meldungen.
    if (text.length < 200) return;
    sources.push({
      url: top[i].url,
      source: sourceFromUrl(top[i].url),
      pageTitle: data.title || top[i].title || '',
      text: text.slice(0, 6000),
      // Issue 44: HTML mitführen (oder leer wenn Trafilatura-Pfad) — der
      // Link-Follower nutzt es für die Anchor-Extraktion.
      html: typeof r.value.html === 'string' ? r.value.html.slice(0, 400000) : '',
    });
  });

  if (!sources.length) return { news: [], dropped: 0, rendered: renderedCount, followedArticles: [] };

  // Issue 44: Aus den Listenseiten Anchors zu Einzelartikeln folgen und den
  // jeweiligen Artikel-Body als zusätzliche Quelle in den LLM-Extraktor
  // geben. So sieht das LLM nicht nur die Listen-Snippets, sondern den
  // ausführlichen Artikel-Text — bessere Datums-Erkennung, präzisere
  // Zusammenfassungen, kleineres Halluzinations-Risiko. Die Roh-Texte
  // werden außerdem oben für den RAG-Index zurückgereicht.
  let followedArticles = [];
  try {
    const follow = await followArticleLinksFromPages(sources, {});
    followedArticles = follow.articles || [];
  } catch (e) {
    console.warn('local-news article follow failed', e);
  }
  for (const a of followedArticles) {
    sources.push({
      url: a.url,
      source: a.source || sourceFromUrl(a.url),
      pageTitle: a.title || '',
      text: (a.text || '').slice(0, 6000),
      html: '',
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // Issue 27: User-konfigurierbares Höchstalter (1|3|5 Tage) statt 31 — gilt
  // für Lokal-News, die ja Webseiten-Items sind.
  const siteAgeDays = getSiteMaxAgeDays();
  const cutoffDate = new Date(Date.now() - getSiteMaxAgeMs()).toISOString().slice(0, 10);
  const currentYear = new Date().getFullYear();

  // Issue 18: Output-Schema laut Konzept — pro Item zusätzlich ein `typ`-Feld
  // mit den Werten "Nachricht" | "event" | "wetter". Wetter- und Event-Items
  // werden NACH dem LLM-Call rausgefiltert: Wetter hat eine eigene Karte
  // oberhalb der Rubriken (fetchWeather), Events kommen aus dem dedizierten
  // extractEventsFromListings-Pfad. So bekommt die Lokal-Rubrik wirklich nur
  // noch klassische Nachrichten-Meldungen.
  //
  // Der `typ`-Default ist "Nachricht" — wir fragen den LLM aktiv nach der
  // Klassifizierung, damit Wetter-Boxen und Event-Stubs (die auf jeder
  // Lokalzeitungs-Listenseite stehen) sauber erkennbar sind.
  //
  // Output-Schema = `{title, typ, date, source, summary, sourceIndex}`. Die
  // Feldnamen orientieren sich am User-Notiz-Schema (Überschrift / typ /
  // Datum / 3-Sätze-Zusammenfassung), nutzen aber englische JSON-Keys, weil
  // das Downstream-Mapping (`bucketizeItems`) ohnehin englisch ist.
  const sys = `Du extrahierst LOKALE NACHRICHTEN aus dem Roh-Text gescrapter regionaler News-Seiten (Tageszeitungen, Stadt-Portale, Anzeiger). Ziel: einzelne, konkrete Meldungen aus „${location}" und der direkten Umgebung.

Heute ist ${today} (Jahr ${currentYear}).

⚠️ HARTE ZEITGRENZE: Nur Meldungen vom ${cutoffDate} bis ${today} (max. ${siteAgeDays} Tag${siteAgeDays === 1 ? '' : 'e'} alt). Ohne erkennbares Datum → komplett überspringen.

OUTPUT-FORMAT (NUR JSON, kein Markdown, keine Erklärungen davor/dahinter):
{
  "news": [
    {
      "title": "Konkrete Schlagzeile (Überschrift, max 200 Zeichen)",
      "typ": "Nachricht" | "event" | "wetter" | "übersichtsseite",
      "date": "YYYY-MM-DD",
      "location": "Stadt oder Stadtteil (z.B. „Konstanz", „Petershausen", „Bodenseekreis") — wenn erkennbar; sonst ''",
      "source": "kurzname.de oder Zeitungsname",
      "summary": "Genau 3 sachliche Sätze: was ist konkret passiert, wo, wer, wann/Hintergrund?",
      "sourceIndex": 0
    }
  ]
}

WAS IST WAS — typ-Klassifizierung:
- "Nachricht" → klassische Lokalmeldung (Polizei, Stadtrat, Schulen, Unfälle, Wirtschaft, Kultur-Berichterstattung, Personen, Gerichts­urteile, Bauprojekte). DAS ist der Default.
- "event" → reine Termin-Ankündigung ODER Event-Übersichts­seite (Konzert, Lesung, Markt, Festival, „findet am … statt", „Veranstaltungen heute/morgen/dieses Wochenende", Listen von kommenden Konzerten, „Was-ist-los"-Übersichten wie veranstaltungen.meinestadt.de/<stadt>/alle/alle). Solche Items werden NICHT in der Lokal-Rubrik gezeigt; sie gehören in die Events-Rubrik.
- "wetter" → Wetter-Vorhersage, Temperaturen, Niederschlag, „7-Tage-Trend", „Wetter heute". Solche Items werden NICHT in der Lokal-Rubrik gezeigt; Wetter hat eine eigene Karte oben in der App.
- "übersichtsseite" → Hub-/Themen-/Ressort-Listen ohne konkrete Einzelmeldung („Mehr aus der Region", „Alle Lokalnachrichten heute", Tag-/Schlagwort-Übersichten, „Top-Stories der Woche", reine Listen-Items ohne Story-Kontext). Diese Items werden komplett aus der Rubrik entfernt — wir wollen nur konkrete Einzelartikel.

→ Lass „event"-, „wetter"- und „übersichtsseite"-Items NICHT weg, sondern markiere sie korrekt — die App filtert sie selber raus. Du sollst sie NICHT zu „Nachricht" umetikettieren, nur weil sie regional sind.

⚠️ HARTE REGEL: Wenn die QUELLEN-URL Wörter wie "veranstaltungen", "events", "eventkalender", "termine", "kalender" oder den Pfad "/alle/alle" enthält, oder der Seiten-Titel „Veranstaltungen in <Stadt>", „Eventkalender", „Was ist los in …" lautet, dann ist die GESAMTE QUELLE eine Event-Übersicht — JEDES einzelne Item daraus muss typ:"event" bekommen, auch wenn der Roh-Text wie eine News-Liste aussieht. Diese Items werden danach komplett aus der Lokal-Rubrik entfernt.

BEISPIEL (Roh-Text aus suedkurier.de/region/konstanz):

Roh-Text: "Konstanz · 22.05.2026 — Stadtrat beschließt 2026 neue Fahrradzonen rund um die Marktstätte. Die Innenstadt soll bis Herbst verkehrsberuhigt werden. // Lokales Konstanz · Bodenseekreis · vor 2 Stunden: Polizei warnt vor Trickbetrügern in Petershausen — drei Vorfälle in der vergangenen Woche. // Wetter heute · Konstanz · 22°C · Sonnig, leichte Bewölkung am Abend, kein Niederschlag erwartet. // Konzert am 25.05.2026 um 20 Uhr: „Kammerphilharmonie Bodensee" spielt im Konzil. // Sport-Liveticker: SC Freiburg vs. Bayern · Anstoß 18:30. // Newsletter abonnieren"

Extraktion:
{"news":[
  {"title":"Stadtrat beschließt neue Fahrradzonen rund um die Marktstätte","typ":"Nachricht","date":"2026-05-22","location":"Konstanz","source":"suedkurier.de","summary":"Der Konstanzer Stadtrat hat die Einrichtung neuer Fahrradzonen rund um die Marktstätte beschlossen. Bis Herbst soll die Innenstadt damit deutlich verkehrsberuhigt werden. Hintergrund ist eine schrittweise Umsetzung des Mobilitätskonzepts der Stadt.","sourceIndex":0},
  {"title":"Polizei warnt vor Trickbetrügern in Petershausen","typ":"Nachricht","date":"${today}","location":"Petershausen","source":"suedkurier.de","summary":"In Konstanz-Petershausen sind in der letzten Woche drei Fälle von Trickbetrug an der Haustür gemeldet worden. Die Täter geben sich laut Polizei als Handwerker oder Stadtwerke-Mitarbeiter aus. Ältere Anwohner werden ausdrücklich um besondere Vorsicht gebeten.","sourceIndex":0},
  {"title":"Wetter heute in Konstanz: 22°C und sonnig","typ":"wetter","date":"${today}","location":"Konstanz","source":"suedkurier.de","summary":"Die Vorhersage nennt 22 Grad und überwiegend sonnige Bedingungen für Konstanz. Am Abend ziehen leichte Wolken auf, Niederschlag wird nicht erwartet. — (wird in der Lokal-Rubrik ausgefiltert, gehört zur Wetter-Karte).","sourceIndex":0},
  {"title":"Kammerphilharmonie Bodensee spielt am 25.05. im Konzil","typ":"event","date":"2026-05-22","location":"Konstanz","source":"suedkurier.de","summary":"Am 25. Mai um 20 Uhr tritt die Kammerphilharmonie Bodensee im Konstanzer Konzilgebäude auf. Auf dem Programm stehen klassische Stücke des 19. Jahrhunderts. — (wird in der Lokal-Rubrik ausgefiltert, gehört zur Events-Rubrik).","sourceIndex":0}
]}

(Sport-Liveticker und Newsletter-Hinweis sind korrekt komplett ignoriert — keine konkrete Nachricht.)

ZWEITES BEISPIEL (URL = veranstaltungen.meinestadt.de/konstanz/alle/alle, Seitentitel = „Veranstaltungen in Konstanz"):

Roh-Text: "Veranstaltungen in Konstanz — Heute, 22.05.2026 · Konzert „Bodensee Jazz Trio" um 20:00 Uhr im Kulturzentrum K9. // Morgen, 23.05. · Stadtführung „Konstanz historisch" um 14:00 Uhr ab Marktplatz. // Samstag, 25.05. · Flohmarkt Marktstätte 8-16 Uhr. // Sonntag · Lesung im Münster mit Autor X, 18 Uhr."

Extraktion:
{"news":[
  {"title":"Bodensee Jazz Trio im Kulturzentrum K9","typ":"event","date":"2026-05-22","location":"Konstanz","source":"meinestadt.de","summary":"Das Bodensee Jazz Trio spielt am Donnerstag, 22.05.2026 um 20 Uhr im Konstanzer Kulturzentrum K9. Im Programm stehen Jazz-Standards und Eigenkompositionen. — (Event-Übersicht, wird in Lokal ausgefiltert).","sourceIndex":1},
  {"title":"Stadtführung Konstanz historisch","typ":"event","date":"2026-05-23","location":"Konstanz","source":"meinestadt.de","summary":"Die Stadtführung „Konstanz historisch" startet am 23.05. um 14 Uhr am Marktplatz und führt durch die Altstadt. Anmeldung erforderlich. — (Event-Übersicht, wird in Lokal ausgefiltert).","sourceIndex":1}
]}

Wichtig: aus der Event-Übersichts-Quelle wird KEIN Item als „Nachricht" markiert — egal wie konkret die einzelnen Termine wirken. Die URL „veranstaltungen.*/alle/alle" ist das Signal, dass die GESAMTE Quelle Event-Listing ist.

DATUMS-ERKENNUNG — typische Muster im Roh-Text:
- Absolut: "22.05.2026", "22.5.26", "22. Mai 2026", "2026-05-22"
- Relativ: "vor 30 Minuten" / "vor X Stunden" → ${today}; "gestern" → ${yesterday}; "vor X Tagen" → ${today} minus X Tage.
- Wenn überhaupt kein konkretes Datum erkennbar → Meldung NICHT in Output aufnehmen.

REGELN:
- Nur EINZELNE konkrete Meldungen mit Ort/Person/Zahl/Sachverhalt — KEINE Sammeleinträge ("Mehr Nachrichten in unserem Newsletter").
- Themen MÜSSEN einen klaren Bezug zu „${location}" oder direkt umliegender Region haben (Stadt, Landkreis, Region).
- AUSSCHLIESSEN (komplett rauslassen, nicht klassifizieren): Cookie-Banner, „Newsletter abonnieren", reine Navigation, generische Plattform-Hinweise, Sport-Spielpläne ohne Bericht.
- title (Überschrift): knackige Schlagzeile, max 200 Zeichen, keine wörtliche Wiederholung im summary.
- typ: einer der drei Werte "Nachricht", "event", "wetter". Pflichtfeld.
- date: striktes Format YYYY-MM-DD.
- location (Issue 22): Stadt, Stadtteil oder Region, auf den sich die Meldung BEZIEHT (NICHT der Sitz der Zeitung). Bei Konstanz-Artikeln „Konstanz", bei Stadtteil-Meldungen wie „Konstanz-Petershausen" → „Petershausen", bei kreisweiten Meldungen „Bodenseekreis". Wenn keine klare Ortsangabe → leerer String "". Max 80 Zeichen.
- source: kurzer Name (z.B. "suedkurier.de" oder "Schwäbische Zeitung"). Bei Unklarheit den Hostnamen aus der Quelle übernehmen.
- summary: GENAU 3 sachliche Sätze, mit Eigennamen/Zahlen/Hintergrund. Nicht spekulieren.
- sourceIndex: Integer 0-${sources.length - 1}, MUSS gesetzt sein.
- Maximal 12 Meldungen Gesamt-Output (inkl. event/wetter-markierten — die App filtert die später raus, max. 10 echte Nachrichten landen in der Rubrik).

SELF-CHECK vor Rückgabe: Hat JEDE Meldung ein konkretes Datum im Fenster ${cutoffDate}…${today}? Klar lokaler Bezug? typ korrekt gesetzt? Wenn nicht → raus.
Lieber 2 saubere Meldungen als 10 erfundene — leere Liste ist OK, wenn die Roh-Texte wirklich nichts hergeben.`;

  const userText = sources.map((s, i) => `=== QUELLE ${i}: ${s.source} ===
${s.pageTitle ? `Seitentitel: ${s.pageTitle}\n` : ''}URL: ${s.url}

${s.text}`).join('\n\n');

  let parsed;
  try {
    const res = await api.llm({
      system: sys,
      messages: [{ role: 'user', content: userText }],
      temperature: 0.15,
      max_tokens: 2800,
    });
    parsed = safeJsonExtract(res.reply || '') || {};
  } catch (e) {
    console.warn('local news extraction failed', e);
    return { news: [], dropped: 0, rendered: renderedCount };
  }

  const raw = Array.isArray(parsed.news) ? parsed.news : [];
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  let dropped = 0;
  const candidates = raw
    .filter((n) => n && typeof n.title === 'string')
    .map((n) => {
      const srcIdx = Number.isInteger(n.sourceIndex) && n.sourceIndex >= 0 && n.sourceIndex < sources.length
        ? n.sourceIndex
        : 0;
      const src = sources[srcIdx] || sources[0];
      // Issue 18: typ-Feld normalisieren — der LLM kann gelegentlich
      // Großschreibungs- oder Sprach-Varianten zurückgeben ("EVENT",
      // "Wetter", "news"). Wir mappen Bekanntes auf den kanonischen Wert
      // ("Nachricht" | "event" | "wetter") und behandeln Unbekanntes als
      // "Nachricht" (Default), damit die Pipeline keinen Eintrag verliert,
      // nur weil der LLM kreativ war.
      const rawTyp = String(n.typ || '').trim().toLowerCase();
      let typ = 'Nachricht';
      if (rawTyp === 'event' || rawTyp === 'veranstaltung' || rawTyp === 'termin') typ = 'event';
      else if (rawTyp === 'wetter' || rawTyp === 'weather' || rawTyp === 'vorhersage') typ = 'wetter';
      // Issue 27: Übersichtsseite → wird unten verworfen.
      else if (rawTyp === 'übersichtsseite' || rawTyp === 'uebersichtsseite' || rawTyp === 'overview' || rawTyp === 'hub' || rawTyp === 'index' || rawTyp === 'liste') typ = 'übersichtsseite';
      return {
        title: (n.title || '').trim().slice(0, 200),
        typ,
        date: (n.date || '').trim().slice(0, 10),
        // Issue 22: extrahierten Ort übernehmen — wird in der Lokal-Karte als
        // Chip neben dem Datum angezeigt; bleibt leer, wenn der LLM nichts
        // zuordnen konnte.
        location: (n.location || '').trim().slice(0, 80),
        source: (n.source || src.source || '').trim().slice(0, 80) || src.source,
        summary: (n.summary || '').trim().slice(0, 600),
        url: src.url,
      };
    })
    .filter((n) => {
      if (!n.title || n.title.length < 3) { dropped++; return false; }
      // Issue 18: typ-Filter — Wetter- und reine Event-Ankündigungen werden
      // aus der Lokal-Rubrik komplett rausgefiltert. Wetter hat eine eigene
      // Karte (fetchWeather/renderWeather), Events kommen aus dem
      // dedizierten Event-Extraktor. So bleibt Lokal wirklich „Nachrichten".
      // Issue 27: Übersichtsseiten ebenfalls verwerfen — der Klassifikator
      // sortiert sie aktiv aus (keine konkreten Einzelartikel mehr).
      if (n.typ === 'wetter' || n.typ === 'event' || n.typ === 'übersichtsseite') { dropped++; return false; }
      if (!isoRe.test(n.date)) { dropped++; return false; }
      const articleDate = new Date(n.date + 'T00:00:00');
      if (isNaN(articleDate.getTime())) { dropped++; return false; }
      // Issue 27: User-Höchstalter (1|3|5 Tage) hart durchsetzen.
      if (isArticleTooOldForSites(articleDate)) { dropped++; return false; }
      // Zukünfts-Daten sind ein typischer LLM-Halluzinationsfall (z.B. Datum
      // aus dem Beispiel übernommen) — wir lassen 1 Tag Toleranz für lokale
      // Zeitzonen-Effekte, alles weiter in der Zukunft raus.
      if (n.date > new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)) {
        dropped++; return false;
      }
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

  // URL-Deduplikation in der Ergebnisliste — gleiche Schlagzeile aus mehreren
  // Quellen extrahiert? Erste Variante gewinnt (höchstes Datum durch Sort oben).
  const dedup = [];
  const seenTitles = new Set();
  for (const n of candidates) {
    const key = n.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    dedup.push(n);
  }

  return { news: dedup, dropped, rendered: renderedCount, followedArticles };
}

// =============================================================================
// Issue 26: RSS-Artikel per LLM klassifizieren
// =============================================================================
//
// RSS-Feeds liefern ein gemischtes Bündel aus echten Lokal-Nachrichten,
// Event-Ankündigungen, Wetter-Boxen und allgemeinen News. Vor Issue 26
// flossen alle in den gemeinsamen Scoring-Pool und wurden nur über den
// Scorer-Bucket einsortiert — Konsequenz: Lokal-/Events-Rubriken wurden
// vom RSS-Pfad praktisch nie befüllt, weil der Scorer Bucket=lokal/events
// für News-Items aus Defense-in-Depth-Gründen vermeidet (Issues 12/18).
//
// Neu: nach dem RSS-Fetch durchlaufen die Items dieselbe JSON-
// Klassifikationspipeline wie manuell eingetragene User-Sites (Issue 23):
// ein einziger LLM-Call ordnet jeden RSS-Artikel einer der vier Kategorien
// zu — lokalnachricht | event | wetter | andere. Routing analog zu
// runUserSitesPipeline:
//   lokalnachricht  → concreteLocalNews (Lokal-Rubrik)
//   event           → concreteEvents (Events-Rubrik, mit Datum im Fenster)
//   wetter          → verworfen (eigene Wetter-Karte)
//   andere          → bleibt in rssItems, läuft durch Scoring+Bucketize
async function classifyRssArticles(rssItems) {
  if (!rssItems || !rssItems.length) return [];

  const today = new Date().toISOString().slice(0, 10);
  // Issue 27: User-Höchstalter (1|3|5 Tage) statt der bisherigen 31 — RSS ist
  // eine Webseiten-Quelle und unterliegt damit der „Webseiten-Alter"-Wahl.
  const cutoffDate = new Date(Date.now() - getSiteMaxAgeMs()).toISOString().slice(0, 10);
  const eventWin = eventWindow();

  // Compact-Repräsentation pro Item — Titel + Snippet + Quelle + Datum
  // reichen für eine zuverlässige Kategorie-Entscheidung. Snippet wird
  // hart auf 320 Zeichen geklemmt, damit auch bei 60 RSS-Items der
  // Input-Tokenbudget moderat bleibt (~6k tokens).
  const compact = rssItems.map((it, i) => ({
    i,
    title: (it.title || '').slice(0, 200),
    snippet: (it.snippet || '').replace(/\s+/g, ' ').slice(0, 320),
    source: it.source || sourceFromUrl(it.url) || '',
    date: (it.date || '').slice(0, 10),
  }));

  const sys = `Du klassifizierst RSS-Artikel für eine personalisierte News-App. Heute ist ${today}. Pro Artikel entscheidest du anhand von Titel + Snippet + Quelle, welche der fünf Kategorien am besten passt.

Kategorien (genau EINE pro Artikel):
- "lokalnachricht" → klassische Lokal-/Regional-News mit Bezug zu einer konkreten Stadt/Region (Polizei, Stadtrat, Schulen, Unfälle, Wirtschaft, Kultur, Gericht, Bauprojekte, Personen). Erkennungszeichen: Stadt-/Stadtteilname im Titel oder Snippet, Lokalzeitungs-Quelle (suedkurier.de, schwaebische.de, südwestpresse.de, mvp.de/<stadt>/, lokalkompass.de etc.).
- "event" → konkrete Veranstaltungs-Ankündigung mit Datum (Konzert, Lesung, Markt, Festival, Stadtführung). Erkennungszeichen: „findet am … statt", „<Datum> um <Uhrzeit>", „Eintritt", „Tickets". KEINE allgemeinen Berichte ÜBER stattgefundene Events — die sind „lokalnachricht" oder „andere".
- "wetter" → reine Wetter-Vorhersage / aktuelle Wetterlage (Temperaturen, Niederschlag, „7-Tage-Trend", „Wetter heute"). Wird in der App separat als Karte gerendert.
- "übersichtsseite" → Ressort-/Hub-/Listen-/Übersichtsseite OHNE konkreten Einzelartikel. Beispiele: „Alle Sport-News der Woche", „Top-Stories", Tag-/Kategorie-Übersichten, RSS-Items, die nur die Startseite des Mediums verlinken („Neueste Artikel auf …"), „Mehr News" / „Newsticker"-Sammelposts, Rubrik-Indizes. Hinweis im Titel/Snippet: „Übersicht", „Alle Themen", „Zusammenfassung der Woche", „Newsticker", „Live-Blog", „Themenseite", oder Snippet listet nur Schlagwörter ohne klare Story.
- "andere" → ALLES andere: überregionale News (Politik, Wirtschaft, Tech, Wissenschaft, Sport, Magazin-Stücke), Hintergrund-Berichte ohne klaren Lokalbezug, allgemeine Tipps & Ratgeber. Auch der Default bei Unsicherheit zwischen lokalnachricht und andere.

Für lokalnachricht UND event optional:
- "date": YYYY-MM-DD wenn aus Titel/Snippet erkennbar (sonst weglassen oder leer)
- "location": Stadt/Stadtteil/Region wo das passiert ist/stattfindet (sonst weglassen oder leer)

⚠️ HARTE REGELN:
- typ "lokalnachricht": Datum (wenn gesetzt) muss zwischen ${cutoffDate} und ${today} liegen.
- typ "event": Datum (wenn gesetzt) muss zwischen ${eventWin.start} und ${eventWin.end} liegen (sonst → typ "lokalnachricht" oder "andere", je nach Lokalbezug).
- Wenn ein RSS-Artikel ein vergangenes Event reflektiert (Bericht NACH dem Termin) → NICHT typ "event" sondern "lokalnachricht" oder "andere".
- Wenn ein Artikel KEINE konkrete Einzelmeldung darstellt, sondern nur Hub-/Themen-/Listen-Charakter hat (z.B. „Alle News heute", „Top-Themen", Ressort-Übersicht) → typ "übersichtsseite". Solche Items werden komplett verworfen.
- Bei Unsicherheit: lieber "andere" als irreführend "lokalnachricht" / "event"; aber bei klarem Hub-Charakter "übersichtsseite".

OUTPUT NUR ALS JSON (kein Markdown, kein Text davor/danach):
{
  "classifications": [
    {"i":0, "typ":"lokalnachricht", "date":"2026-05-22", "location":"Konstanz"},
    {"i":1, "typ":"event", "date":"2026-05-25", "location":"Konstanz"},
    {"i":2, "typ":"wetter"},
    {"i":3, "typ":"übersichtsseite"},
    {"i":4, "typ":"andere"},
    ...
  ]
}

Regeln für die Klassifizierung:
- Pflicht: pro Input-Item GENAU ein Eintrag mit dem passenden "i".
- "typ" muss einer der fünf Werte sein.
- "date"/"location" nur setzen, wenn klar erkennbar. Nichts erfinden.`;

  const userText = `Klassifiziere diese ${compact.length} RSS-Artikel:\n\n${JSON.stringify(compact, null, 1)}`;

  let parsed;
  try {
    const res = await api.llm({
      system: sys,
      messages: [{ role: 'user', content: userText }],
      temperature: 0.0,
      max_tokens: 2200,
    });
    parsed = safeJsonExtract(res.reply || '') || {};
  } catch (e) {
    console.warn('rss classification failed', e);
    return rssItems.map((it) => ({ ...it, typ: 'andere' }));
  }

  const arr = Array.isArray(parsed.classifications) ? parsed.classifications : [];
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const byIdx = new Map();
  for (const c of arr) {
    if (!c || !Number.isInteger(c.i)) continue;
    const raw = String(c.typ || '').trim().toLowerCase();
    let typ = 'andere';
    if (raw === 'lokalnachricht' || raw === 'lokal' || raw === 'lokal_news' || raw === 'local_news' || raw === 'nachricht') typ = 'lokalnachricht';
    else if (raw === 'event' || raw === 'lokal_event' || raw === 'veranstaltung' || raw === 'termin') typ = 'event';
    else if (raw === 'wetter' || raw === 'weather' || raw === 'vorhersage') typ = 'wetter';
    // Issue 27: zusätzliche Klasse — Hub-/Listen-/Übersichts-Seiten ohne konkreten
    // Einzelartikel. Wird wie wetter komplett verworfen.
    else if (raw === 'übersichtsseite' || raw === 'uebersichtsseite' || raw === 'overview' || raw === 'hub' || raw === 'index' || raw === 'liste') typ = 'übersichtsseite';
    const date = isoRe.test(String(c.date || '')) ? c.date : '';
    const location = String(c.location || '').trim().slice(0, 80);
    byIdx.set(c.i, { typ, date, location });
  }

  // Fail-open: Items ohne Klassifikation laufen als „andere" weiter — sie
  // werden im normalen Scoring/Bucketize behandelt wie vor Issue 26.
  return rssItems.map((it, i) => {
    const hit = byIdx.get(i) || { typ: 'andere', date: '', location: '' };
    return {
      ...it,
      typ: hit.typ,
      // LLM-Datum NUR übernehmen, wenn das Item bisher kein Datum hat —
      // RSS isoDate ist verlässlicher als LLM-Halluzination.
      date: it.date || hit.date || '',
      location: hit.location || '',
    };
  });
}

// =============================================================================
// Issue 38: PubMed-Studien-Pipeline (Medizin-Rubrik)
// =============================================================================
//
// Aus der persönlichen Interessen-Beschreibung werden 2-4 englische PubMed-
// Suchbegriffe extrahiert (per LLM — PubMed indexiert primär englische
// biomedizinische Literatur). Pro Query werden Studien gegen den Backend-
// Adapter `/api/pubmed/search` geholt (NCBI E-utilities; Datum-Fenster =
// siteMaxAgeDays, also 1|3|5 Tage), de-dupliziert, dann in einem einzigen
// LLM-Call ins Deutsche zusammengefasst (3-4 Sätze pro Studie). Die fertigen
// Items werden mit `origin: 'pubmed'` markiert und in `bucketizeItems` hart
// in die Medizin-Rubrik gezwungen (analog zu YouTube → youtube-Bucket). Sie
// laufen NICHT durch `scoreArticles` — wie die Lokal-Extrakt-Items bekommen
// sie feste Interesse-/Betroffenheits-Scores (Summe 16), damit sie im
// globalen Sort oben landen und das LLM-Token-Budget nicht belasten.
//
// Trigger: nur wenn der User in seinem Profil ein `health_watch`/`medizin`-
// Modul hat ODER der Interessen-Freitext ein Health-Hint enthält (HEALTH_HINTS-
// Regex). Ohne medizinisches Interesse läuft die Pipeline nicht — kostet
// keinen LLM-Call, keinen PubMed-Roundtrip.

// Liefert ein Modul-Objekt aus dem Profil, das auf Gesundheitsthemen
// abzielt (id matched MODULE_TO_BUCKET[id] === 'medizin'), oder null.
function pickHealthModule(profile) {
  if (!profile || !Array.isArray(profile.modules)) return null;
  for (const m of profile.modules) {
    if (!m || !m.id) continue;
    if (MODULE_TO_BUCKET[String(m.id).toLowerCase()] === 'medizin') return m;
  }
  return null;
}

// Entscheidet, ob die PubMed-Pipeline überhaupt laufen soll. Vermeidet
// unnötige LLM-/Netzwerk-Calls bei Usern ohne medizinisches Interesse.
function hasMedicalInterest(profile, interests) {
  if (pickHealthModule(profile)) return true;
  if (typeof interests === 'string' && HEALTH_HINTS.test(interests)) return true;
  const bh = profile && profile.bucketHints;
  if (bh && typeof bh.medizin === 'string' && bh.medizin.trim().length >= 3) return true;
  return false;
}

// LLM extrahiert aus Interessen-Freitext + Profil-Modul-Keywords 2-4
// englische PubMed-Suchbegriffe. Englisch, weil PubMed-Treffer und MeSH-
// Terms englisch sind — eine deutsche Query liefert nur einen Bruchteil
// der Studien. Kurz halten (max ~6 Wörter pro Query), damit MeSH/Title-
// Matching greift; keine Bool-Operatoren erzwingen (PubMed kann sie selbst
// aus den Wörtern ableiten).
async function extractPubmedQueries({ interests, profile }) {
  const healthModule = pickHealthModule(profile);
  const moduleKeywords = healthModule && Array.isArray(healthModule.keywords)
    ? healthModule.keywords.filter(Boolean).slice(0, 12).join(', ')
    : '';
  const bucketHint = profile && profile.bucketHints && profile.bucketHints.medizin
    ? profile.bucketHints.medizin
    : '';

  const sys = `Du extrahierst aus dem Interessen-Profil eines deutschsprachigen Users 2-4 englische PubMed-Suchanfragen für aktuelle biomedizinische Studien.

Regeln:
- Pro Query 2-5 englische Wörter, MeSH/Title-tauglich (z.B. "atrial fibrillation anticoagulation", "type 2 diabetes GLP-1", "long covid cognition").
- KEINE Bool-Operatoren (kein AND/OR/NOT, keine Klammern, keine Anführungszeichen).
- Fokus auf konkrete medizinische Probleme/Diagnosen/Wirkstoffe/Verfahren — keine allgemeinen Lifestyle-Terms ("healthy eating").
- Wenn der User Medikamente nennt: deren generischer Wirkstoff-Name (z.B. "metformin" statt "Glucophage").
- Wenn der User chronische Erkrankungen nennt: die englische ICD-/MeSH-Bezeichnung (z.B. "rheumatoid arthritis", "ulcerative colitis").
- Wenn der User nur sehr allgemein "Gesundheit/Studien" interessiert: 2-3 hochrelevante Bereiche wählen, die zu Alter/Geschlecht/Beruf (falls bekannt) passen.
- Falls KEIN konkreter medizinischer Anker erkennbar ist, liefere ein leeres Array.

Gib AUSSCHLIESSLICH JSON zurück, kein Markdown:
{ "queries": ["...", "...", "..."] }`;

  const profileBits = [];
  if (profile && profile.age) profileBits.push(`Alter: ${profile.age}`);
  if (profile && profile.profession) profileBits.push(`Beruf: ${profile.profession}`);
  if (moduleKeywords) profileBits.push(`Health-Modul-Keywords: ${moduleKeywords}`);
  if (bucketHint) profileBits.push(`Medizin-Hint: ${bucketHint}`);
  const user = `INTERESSEN-FREITEXT:\n${interests || '(leer)'}\n\nPROFIL:\n${profileBits.length ? profileBits.join('\n') : '(keine Zusatzinfo)'}`;

  let parsed;
  try {
    const res = await api.llm({
      system: sys,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: 400,
    });
    parsed = safeJsonExtract(res.reply || '') || {};
  } catch (e) {
    console.warn('extractPubmedQueries failed', e);
    return [];
  }
  const raw = Array.isArray(parsed.queries) ? parsed.queries : [];
  const clean = [];
  const seen = new Set();
  for (const q of raw) {
    const s = String(q || '')
      .replace(/["()\[\]]/g, ' ')
      .replace(/\b(AND|OR|NOT)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length < 3 || s.length > 80) continue;
    // Mindestens ein lateinisches Wort — sonst hat der LLM deutsch geliefert.
    if (!/[A-Za-z]{3,}/.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(s);
    if (clean.length >= 4) break;
  }
  return clean;
}

// Holt zu jedem Query bis zu 6 Studien, dedupliziert nach PMID. Zeitfenster
// kommt aus den User-Einstellungen (`getSiteMaxAgeDays()` — 1|3|5 Tage).
// Liefert {studies, queryStats, queries}.
async function fetchPubmedStudies(queries, { days, log } = {}) {
  if (!queries.length) return { studies: [], queryStats: [], queries };
  const results = await Promise.allSettled(
    queries.map((q) => api.pubmed(q, { max: 6, days })),
  );
  const byPmid = new Map();
  const queryStats = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const q = queries[i];
    if (r.status !== 'fulfilled' || !r.value || !r.value.ok) {
      const msg = r.status === 'rejected'
        ? (r.reason && r.reason.message || 'Fehler')
        : (r.value && (r.value.error || r.value.message) || 'Fehler');
      queryStats.push({ q, added: 0, error: msg });
      continue;
    }
    let added = 0;
    for (const s of (r.value.results || [])) {
      if (!s || !s.pmid || !s.title) continue;
      if (!byPmid.has(s.pmid)) {
        byPmid.set(s.pmid, { ...s, queries: [q] });
        added++;
      } else {
        const existing = byPmid.get(s.pmid);
        if (!existing.queries.includes(q)) existing.queries.push(q);
      }
    }
    queryStats.push({ q, added });
  }
  if (log) {
    const parts = queryStats.map((qs) =>
      `„${qs.q}": ${qs.added}${qs.error ? ` (${qs.error})` : ''}`
    );
    log(`PubMed-Ergebnisse: ${parts.join(', ') || 'keine'} → ${byPmid.size} unique`);
  }
  return { studies: Array.from(byPmid.values()), queryStats, queries };
}

// LLM fasst alle Studien in einem Call zusammen — auf Deutsch, 3-4 Sätze pro
// Studie, mit Bezug zum vermuteten User-Anliegen. Pattern analog zu
// `summarizeYouTubeTranscripts`. Abstract wird auf 1800 Zeichen geklemmt, der
// Call hält sich damit unter ~6k Tokens Input auch bei 12 Studien.
async function summarizePubmedStudies(studies, { interests } = {}) {
  if (!studies || !studies.length) return [];
  const compact = studies.map((s, i) => ({
    i,
    title: (s.title || '').slice(0, 250),
    journal: (s.journal || '').slice(0, 80),
    pubdate: s.pubdate || '',
    abstract: (s.abstract || '').slice(0, 1800),
    queries: (s.queries || []).slice(0, 4),
  }));

  const interestsHint = interests
    ? `\nZUM PERSÖNLICHEN BEZUG: Der User hat in seinen Interessen geschrieben: „${interests.slice(0, 600)}". Wenn die Studie ein dort genanntes Thema trifft, sag das im 3./4. Satz konkret („Für deine Fragen zu X bedeutet das …").`
    : '';
  const sys = `Du fasst medizinische Studien aus PubMed auf DEUTSCH zusammen. Pro Studie 3-4 dichte Sätze.

Gib AUSSCHLIESSLICH JSON zurück (kein Markdown):
{ "summaries": [ { "index": 0, "summary": "…" }, ... ] }

Regeln pro Eintrag:
- index: zwingend, identisch mit dem Input-Index.
- summary: 3-4 deutsche Sätze. Erster Satz: Fragestellung/Studientyp (z.B. „Randomisierte Studie mit 312 Patient:innen testet, ob …"). Zweiter Satz: Ergebnis mit konkreten Zahlen (Effektgröße, p-Wert, Hazard Ratio o.ä. wenn im Abstract angegeben — sonst qualitativ).${interestsHint ? '\n- Dritter/Vierter Satz: Klinische Implikation in einfachen Worten — „Was bedeutet das für Betroffene?". Wenn der Studientyp/die Größe Limitationen impliziert (z.B. Mausmodell, In-vitro, kleine Kohorte): das ehrlich nennen.' : '\n- Dritter/Vierter Satz: Klinische Implikation in einfachen Worten — „Was bedeutet das für Betroffene?". Limitationen ehrlich nennen (z.B. Mausmodell, kleine Kohorte).'}
- Wenn das Abstract zu dünn ist (nur Title, keine Detail-Daten), schreibe einen einzigen Satz mit dem Studienthema und vermerke „(Abstract nicht öffentlich — Volltext nötig)".
- KEINE Werbephrasen, KEINE Selbstreferenzen auf PubMed/NCBI, kein „Diese Studie zeigt …" am Anfang (zu floskelhaft — fang direkt mit Sache an).${interestsHint}`;

  const userText = JSON.stringify(compact, null, 0);
  const res = await api.llm({
    system: sys,
    messages: [{ role: 'user', content: userText }],
    temperature: 0.3,
    max_tokens: Math.min(4000, 400 + compact.length * 350),
  });
  const parsed = safeJsonExtract(res.reply || '') || {};
  const list = Array.isArray(parsed.summaries) ? parsed.summaries : [];
  const out = studies.map(() => '');
  for (const s of list) {
    if (!s || !Number.isInteger(s.index)) continue;
    if (s.index < 0 || s.index >= studies.length) continue;
    if (typeof s.summary === 'string') out[s.index] = s.summary.trim();
  }
  return out;
}

// Orchestriert den ganzen PubMed-Schritt — von Trigger-Check bis fertige Items
// für den Medizin-Bucket. Liefert {items, queries, droppedNoSummary, queryStats}.
async function runPubmedPipeline({ profile, interests, log } = {}) {
  if (!hasMedicalInterest(profile, interests)) {
    return { items: [], queries: [], droppedNoSummary: 0, queryStats: [], skipped: 'no-medical-interest' };
  }
  const queries = await extractPubmedQueries({ interests, profile });
  if (!queries.length) {
    if (log) log('PubMed: keine medizinischen Suchbegriffe abgeleitet');
    return { items: [], queries: [], droppedNoSummary: 0, queryStats: [], skipped: 'no-queries' };
  }
  const days = getSiteMaxAgeDays();
  if (log) log(`PubMed-Suchbegriffe (≤${days} Tag${days === 1 ? '' : 'e'}): ${queries.join(' | ')}`);

  const { studies, queryStats } = await fetchPubmedStudies(queries, { days, log });
  if (!studies.length) {
    return { items: [], queries, droppedNoSummary: 0, queryStats, skipped: 'no-studies' };
  }

  // Pro Run max 12 Studien zusammenfassen (Token-Budget-Cap). Sortierung
  // primär nach Datum desc (frischeste Studien zuerst), bei Gleichstand
  // nach Anzahl Query-Treffer (Mehrfach-Match = robust relevant).
  const limited = studies
    .sort((a, b) => {
      const da = String(a.pubdate || ''); const db = String(b.pubdate || '');
      if (db !== da) return db.localeCompare(da);
      return (b.queries.length || 0) - (a.queries.length || 0);
    })
    .slice(0, 12);

  let summaries = [];
  try {
    summaries = await summarizePubmedStudies(limited, { interests });
  } catch (e) {
    if (log) log(`PubMed-Zusammenfassung fehlgeschlagen: ${e.message || e}`);
    return { items: [], queries, droppedNoSummary: limited.length, queryStats, skipped: 'summarize-failed' };
  }

  const items = [];
  let droppedNoSummary = 0;
  for (let i = 0; i < limited.length; i++) {
    const s = limited[i];
    const sm = (summaries[i] || '').trim();
    if (!sm) { droppedNoSummary++; continue; }
    const authorStr = (s.authors || []).length
      ? (s.authors.slice(0, 2).join(', ') + (s.authors.length > 2 ? ' et al.' : ''))
      : '';
    const sourceLabel = `PubMed${s.journal ? ` · ${s.journal}` : ''}`;
    items.push({
      title: s.title,
      snippet: sm,
      summary: sm,
      url: s.url,
      source: sourceLabel,
      date: s.pubdate || '',
      origin: 'pubmed',
      pubmedId: s.pmid,
      pubmedJournal: s.journal || '',
      pubmedAuthors: authorStr,
      pubmedQueries: s.queries || [],
    });
  }
  if (log) {
    log(`PubMed: ${items.length} Studie${items.length === 1 ? '' : 'n'} zusammengefasst${droppedNoSummary ? ` (${droppedNoSummary} ohne Summary verworfen)` : ''}`);
  }
  return { items, queries, droppedNoSummary, queryStats };
}

// =============================================================================
// Issue 23: Crawl-Pipeline für manuell eingetragene Webseiten
// =============================================================================
//
// Die "Suche auf diesen Webseiten"-Liste enthält jetzt komplette URLs (statt
// nur Hostnames, vgl. Bugfix in parseSearchSites). Für diese URLs gibt es
// eine eigene Pipeline:
//   1. Playwright-Render (Fallback Trafilatura) lädt die Seite und liefert
//      Roh-Text — DuckDuckGo-Snippets bleiben unverändert (separater Pfad).
//   2. Ein einziger LLM-Call zieht aus dem Roh-Text strukturierte Items im
//      Format {title, typ, date, location, summary, sourceIndex} — typ ist
//      "lokalnachricht" | "event" | "wetter" | "andere".
//   3. Items werden in die passenden Buckets gemappt:
//      lokalnachricht  → Lokal-Rubrik (zusätzlich zu extractLocalNews…),
//      event           → Events-Rubrik (zusätzlich zu extractEventsFromListings),
//      wetter          → verworfen (Wetter hat eigene Karte),
//      andere          → Beobachten-Rubrik.
//
// Vorab-Klassifikation beim Profil-Generieren nutzt denselben Crawl-Schritt
// (Schritt 1) und klassifiziert jede URL als Ganzes — die Klassifikation
// landet im Profil unter `siteClassifications` und wird in der UI als Hinweis
// gezeigt, was die App auf welcher Seite findet.

// Crawlt eine einzige User-URL und liefert {url, source, text, title, html}.
// Playwright-first (User-Sites sind oft SPAs / Stadt-Portale ohne SSR),
// Trafilatura-Fallback nur wenn Playwright kein Material zurückgibt.
//
// Issue 44: zusätzlich zum reinen Text wird das gerenderte HTML mit zurück-
// gegeben (falls Playwright zum Einsatz kam), damit der Link-Follower
// (`extractArticleLinksFromHtml`) Anker-Tags zu Einzelartikeln auslesen kann.
// Bei Trafilatura-Fallback bleibt `html` leer — der Follower ruft dann
// `/web/render` für die Anchor-Extraktion separat auf.
async function crawlUserSitePage(url) {
  let renderedText = '';
  let renderedHtml = '';
  let title = '';
  let fromRender = false;
  try {
    const r = await api.webRender(url, { wait_ms: 1800, timeout: 25 });
    renderedText = (r && r.text || '').trim();
    renderedHtml = (r && r.html) || '';
    title = (r && r.title) || '';
    fromRender = !!renderedText;
  } catch {}
  if (renderedText.length < 200) {
    // Fallback: Trafilatura-Extract — manche Seiten blocken Playwright
    // (Cookie-Walls), aber Trafilatura kommt mit static HTML zurecht.
    try {
      const ex = await api.webExtract(url);
      const exText = ((ex && ex.text) || '').trim();
      if (exText.length > renderedText.length) {
        renderedText = exText;
        title = title || (ex && ex.title) || '';
        fromRender = false;
        // Trafilatura liefert kein HTML — leer lassen, Follower rendert
        // bei Bedarf nach.
        renderedHtml = '';
      }
    } catch {}
  }
  return {
    url,
    source: sourceFromUrl(url) || url,
    title,
    text: renderedText,
    html: renderedHtml,
    fromRender,
  };
}

// Crawlt eine Liste von User-URLs parallel und liefert die Quellen, die genug
// Material für die LLM-Extraktion haben (text >= 200 Zeichen).
async function crawlUserSitePages(urls, { textMin = 200 } = {}) {
  if (!urls || !urls.length) return { sources: [], rendered: 0, skipped: 0 };
  const results = await Promise.allSettled(urls.map((u) => crawlUserSitePage(u)));
  const sources = [];
  let rendered = 0;
  let skipped = 0;
  results.forEach((r) => {
    if (r.status !== 'fulfilled') { skipped++; return; }
    const v = r.value;
    if (!v || !v.text || v.text.length < textMin) { skipped++; return; }
    if (v.fromRender) rendered++;
    sources.push({
      url: v.url,
      source: v.source,
      pageTitle: v.title || '',
      text: v.text.slice(0, 6000),
      // Issue 44: HTML mitführen, damit der Link-Follower Anker-Tags ohne
      // erneuten Render-Roundtrip durchforsten kann. Pro Page bis zu
      // ~500KB — wir kappen auf 400KB, damit ein einziges News-Portal mit
      // riesigem HTML nicht den ganzen JS-Heap füllt.
      html: typeof v.html === 'string' ? v.html.slice(0, 400000) : '',
    });
  });
  return { sources, rendered, skipped };
}

// =============================================================================
// Issue 44: Link-Follower — Nachrichtenseiten → Einzelartikel-Tiefenscan
// =============================================================================
//
// Wenn ein Crawl-Ziel eine Übersichts-/Listenseite ist (Stadt-Portal,
// Tageszeitungs-Ressort, Magazin-Hub), enthält ihr HTML zig Anchors zu
// EINZELNEN Nachrichtenartikeln. Bisher hat die App nur den Listentext
// extrahiert — Folge: das LLM sah Schlagzeilen-Stümpfe, aber NIE die
// vollständigen Artikel-Body-Texte. Issue 44 schließt diese Lücke:
//   1. `extractArticleLinksFromHtml` zieht Anker mit slug-ähnlichen Pfaden
//      aus dem HTML (gleicher Host, Navigation/Footer/Aside explizit
//      ausgemaskiert, generische Labels gefiltert).
//   2. `followArticleLinksFromPages` lädt die so entdeckten URLs per
//      Trafilatura (`/web/extract`) — viel günstiger als Playwright, und
//      bei Einzelartikeln ist Trafilatura ohnehin die bessere Wahl.
//      Caps: max ~5 Links pro Listenseite, max ~24 gesamt pro Pipeline-Lauf,
//      Concurrency wird durch `Promise.allSettled` plus die Caps gebändigt.
//   3. Jeder gefolgte Artikel wird zurück in den User-/Lokal-Extraktor
//      gespeist (mehr Material → präzisere LLM-Items) UND komplett für die
//      RAG-Indexierung zurückgegeben (siehe `indexNewsForAssistant`).
//
// HTML-Parsing erfolgt via Regex statt DOMParser, weil:
//  - wir aus dem Browser-Hauptthread ohne weiteren `iframe`/DOM-Sandbox-
//    Roundtrip arbeiten,
//  - das Markup bereits durch Playwright/Trafilatura validiert ist,
//  - wir nur eine kleine Anchor-Heuristik brauchen (kein vollständiges
//    HTML-Verständnis nötig).

// Anchor-Filter: URL muss „artikelhaft" aussehen. Heuristik ist bewusst
// konservativ — lieber 2 echte Artikel als 10 Tag-Übersichten.
function looksLikeArticleUrl(u) {
  if (!u || !u.pathname) return false;
  const path = u.pathname;
  if (path === '/' || path.length < 8) return false;
  // Pfad-Segmente prüfen
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return false;
  // Banned Segments — typische Nicht-Artikel-Pfade
  const banned = /^(login|signin|signup|register|impressum|datenschutz|cookies?|kontakt|agb|jobs|career|karriere|abo|abonnement|newsletter|werbung|mediadaten|account|profile|cart|checkout|search|suche|tag|tags|kategorie|category|topic|themen|autor|author|index|home|sitemap|rss|feed|robots\.txt|page|seite|video|gallery|galerie|bilder|fotos|live|ticker|liveticker)$/i;
  for (const seg of segs) {
    if (banned.test(seg)) return false;
  }
  // Datei-Extensions: erlauben sind html?/aspx?/php oder gar keine
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext && !/^(html?|aspx?|php|jsp)$/.test(ext)) return false;
  // Slug-Heuristik: irgendein Segment muss „artikelhaft" sein — also
  // entweder eine ID enthalten ODER mind. 12 Zeichen lang sein (typische
  // Slug-Länge), ODER mehrere Bindestriche/Unterstriche tragen.
  const slugLike = segs.some((s) =>
    /\d{3,}/.test(s) || s.length >= 16 || (s.match(/[-_]/g) || []).length >= 2
  );
  if (!slugLike) return false;
  // Reine Datum-Pfade (z.B. /2026/06/) ohne Slug-Tail filtern: dann
  // wäre der LETZTE Segment-String kurz und rein numerisch.
  const last = segs[segs.length - 1];
  if (/^\d{2,4}$/.test(last)) return false;
  return true;
}

// Anker-Label sanitisieren und auf Navigations-Boilerplate prüfen.
function isUselessAnchorLabel(label) {
  if (!label) return true;
  const t = label.toLowerCase().trim();
  if (t.length < 6) return true; // „Mehr", „Weiter", „News" rausfiltern
  if (/^(home|news|impressum|datenschutz|kontakt|login|mehr|weiter|zum artikel|next|more|read more|previous|zurück|nächste|teilen|share|kommentare|comments|abonnieren|subscribe|jetzt|hier|details|mehr lesen|weiterlesen|alle artikel|alle news|zur startseite|zur übersicht|zum thema|video|live)$/i.test(t)) return true;
  return false;
}

function extractArticleLinksFromHtml(html, baseUrl, { max = 6 } = {}) {
  if (!html || typeof html !== 'string' || !baseUrl) return [];
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const baseHost = base.hostname.replace(/^www\./, '');

  // Navigation, Footer, Aside und „related"-Container herausschneiden,
  // damit wir keine Header-/Footer-Links als Artikel-Treffer einsammeln.
  const masked = html
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, '');

  const seen = new Set();
  const baseKey = (base.origin + base.pathname).replace(/\/+$/, '');
  seen.add(baseKey);

  const out = [];
  const anchorRe = /<a\b[^>]*?\shref=["']([^"'#]+)["'][^>]*?>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(masked)) !== null) {
    const href = (m[1] || '').trim();
    const inner = m[2] || '';
    if (!href || /^(javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl); } catch { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    const host = abs.hostname.replace(/^www\./, '');
    if (host !== baseHost) continue;
    if (!looksLikeArticleUrl(abs)) continue;
    // Normalize: ohne Query/Fragment dedupen — viele Listen verlinken
    // denselben Artikel mit Tracking-Params (?utm=, ?ref=, ?from=).
    const key = (abs.origin + abs.pathname).replace(/\/+$/, '');
    if (seen.has(key)) continue;
    // Label aus dem Anker-Innenleben extrahieren
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (isUselessAnchorLabel(label)) continue;
    seen.add(key);
    // Saubere URL ohne UTM/Tracking-Params zurückgeben
    let cleanUrl;
    try {
      const u = new URL(abs.toString());
      // Tracking-Params raus
      for (const p of Array.from(u.searchParams.keys())) {
        if (/^(utm_|ref|from|share|src|cmpid|fbclid|gclid)/i.test(p)) u.searchParams.delete(p);
      }
      u.hash = '';
      cleanUrl = u.toString();
    } catch { cleanUrl = abs.toString(); }
    out.push({ url: cleanUrl, label: label.slice(0, 200) });
    if (out.length >= max) break;
  }
  return out;
}

// Fetch HTML einer URL für die Anchor-Extraktion (nur wenn `crawlUserSitePage`
// nichts geliefert hat, z.B. weil Trafilatura-Fallback griff). Geht über
// `/web/render` (Playwright) — wir sparen uns das HTML normal, holen es aber
// gezielt nach, wenn Link-Following auf dieser Seite gewünscht ist.
async function fetchHtmlForLinkFollow(url) {
  try {
    const r = await api.webRender(url, { wait_ms: 1200, timeout: 20 });
    return (r && r.html) || '';
  } catch { return ''; }
}

// Lädt einen Einzelartikel via Trafilatura und filtert Datum/Länge.
// Liefert `null`, wenn der Artikel zu dünn, zu alt oder ohne Text ist.
async function fetchArticleText(url) {
  if (!url) return null;
  let ex;
  try { ex = await api.webExtract(url); } catch { return null; }
  if (!ex) return null;
  const text = ((ex.text) || '').replace(/\s+/g, ' ').trim();
  if (text.length < 300) return null;
  // Datum bestimmen — Trafilatura liefert oft ein iso-Datum oder „YYYY-MM-DD".
  let dateRaw = (ex.date || '').trim();
  let dateIso = '';
  if (dateRaw) {
    const m = dateRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) dateIso = `${m[1]}-${m[2]}-${m[3]}`;
  }
  // Wenn das Datum bekannt ist UND es außerhalb des User-Höchstalters
  // (1|3|5 Tage) liegt → verwerfen. Unbekanntes Datum: passieren lassen
  // (der LLM-Extractor wird es im JSON-Schritt prüfen und ggf. droppen).
  if (dateIso && isArticleTooOldForSites(dateIso + 'T00:00:00')) return null;
  return {
    url,
    title: (ex.title || '').trim().slice(0, 200),
    text,
    date: dateIso,
    source: sourceFromUrl(url) || url,
  };
}

// Höchstwerte für den Issue-44-Tiefenscan. Klein gehalten, damit ein
// Pipeline-Lauf mit 4 User-Sites nicht plötzlich 40 zusätzliche
// Trafilatura-Calls absetzt. Werte aus Praxis: Stadt-Portale haben pro
// Listenseite 6-10 Artikel-Links, davon sind 3-5 thematisch relevant.
const ARTICLE_FOLLOW_MAX_PER_PAGE = 5;
const ARTICLE_FOLLOW_MAX_TOTAL = 24;
const ARTICLE_FOLLOW_TEXT_CAP = 8000; // Roh-Text-Cap pro gefolgtem Artikel

// Hauptfunktion: nimmt eine Liste von Listen-Seiten (Quellen mit URL + ggf.
// HTML + Text) und gibt eine flache Liste der gefolgten Einzelartikel
// zurück. Wird zum LLM-Extraktor durchgereicht (zusätzliche Quellen) UND
// in den RAG-Index gelegt (Roh-Text, nach Chunks).
async function followArticleLinksFromPages(pages, {
  maxLinksPerPage = ARTICLE_FOLLOW_MAX_PER_PAGE,
  maxTotal = ARTICLE_FOLLOW_MAX_TOTAL,
  log,
} = {}) {
  if (!pages || !pages.length) return { articles: [], stats: { discovered: 0, fetched: 0, dropped: 0 } };

  // Pro Seite Anker einsammeln. Wenn kein HTML vorhanden ist, einmal nach-
  // rendern (kostet ~1 Playwright-Call pro Seite ohne HTML — User-Sites
  // mit Trafilatura-Fallback laufen darüber).
  const collected = [];
  for (const p of pages) {
    if (!p || !p.url) continue;
    let html = (p.html || '').trim();
    if (!html) {
      html = await fetchHtmlForLinkFollow(p.url);
    }
    if (!html) continue;
    const links = extractArticleLinksFromHtml(html, p.url, { max: maxLinksPerPage });
    for (const l of links) {
      collected.push({
        url: l.url,
        label: l.label,
        parentUrl: p.url,
        parentSource: p.source || sourceFromUrl(p.url) || p.url,
      });
    }
  }

  // Dedup über alle Seiten
  const seenUrl = new Set();
  const queue = [];
  for (const c of collected) {
    const key = c.url.replace(/\/+$/, '');
    if (seenUrl.has(key)) continue;
    seenUrl.add(key);
    queue.push(c);
    if (queue.length >= maxTotal) break;
  }

  const discovered = collected.length;
  if (log) log(`Tiefenscan: ${queue.length} Einzelartikel-Links (von ${discovered} gefundenen) werden geladen…`);
  if (!queue.length) {
    return { articles: [], stats: { discovered, fetched: 0, dropped: 0 } };
  }

  // Trafilatura-Parallel-Fetch — Promise.allSettled, weil einzelne Artikel
  // 4xx/5xx werfen können (Paywalls, Login-Walls) und wir den Rest trotzdem
  // wollen.
  const results = await Promise.allSettled(queue.map((q) => fetchArticleText(q.url)));
  const articles = [];
  let dropped = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) { dropped++; return; }
    const v = r.value;
    const ctx = queue[i];
    articles.push({
      url: v.url,
      title: v.title || ctx.label || '',
      text: (v.text || '').slice(0, ARTICLE_FOLLOW_TEXT_CAP),
      date: v.date || '',
      source: v.source,
      parentUrl: ctx.parentUrl,
      parentSource: ctx.parentSource,
    });
  });
  if (log) log(`Tiefenscan: ${articles.length} Artikel erfolgreich geladen${dropped ? ` (${dropped} verworfen — Paywall/Login/zu alt/zu dünn)` : ''}`);
  return { articles, stats: { discovered, fetched: articles.length, dropped } };
}

// Splittet langen Roh-Text in semantisch sinnvolle Chunks für die RAG-
// Indexierung. Chroma's Default-Embedding-Modell (MiniLM-L12-v2) packt
// max. ~500 Tokens / ~2000 Zeichen pro Eintrag — wir wählen 1200 Zeichen
// Ziel-Länge mit 150 Zeichen Overlap (Kontextkontinuität zwischen Chunks).
function chunkTextForRag(text, { target = 1200, overlap = 150, max = 8 } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= target) return [t];
  const chunks = [];
  let i = 0;
  while (i < t.length && chunks.length < max) {
    let end = Math.min(t.length, i + target);
    // Versuche an Satzgrenze zu enden, damit Embeddings nicht in einem
    // Wortrumpf gekappt werden.
    if (end < t.length) {
      const slice = t.slice(i, end);
      const lastDot = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? ')
      );
      if (lastDot > target * 0.6) end = i + lastDot + 1;
    }
    chunks.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = Math.max(end - overlap, i + target - overlap);
  }
  return chunks;
}

// Pre-Klassifikation der User-Sites (für das Profil): pro Quelle eine
// Kategorie. EINEN LLM-Call für alle Quellen zusammen, niedrige Temperatur.
async function classifyUserSitePages(sources) {
  if (!sources || !sources.length) return [];
  const compact = sources.map((s, i) => ({
    i,
    url: s.url,
    source: s.source,
    title: (s.pageTitle || '').slice(0, 200),
    text_excerpt: (s.text || '').replace(/\s+/g, ' ').slice(0, 1200),
  }));
  const sys = `Du klassifizierst Webseiten, die ein User als „eigene Quellen" für eine personalisierte News-App eingetragen hat. Pro Seite entscheidest du anhand von URL + Titel + Text-Auszug, welche Hauptart Inhalte dort zu finden ist.

Kategorien (genau EINE pro Seite):
- "lokalnachricht" → klassische Lokal-/Regional-News (Polizei, Stadtrat, Schulen, Unfälle, Wirtschaft, Kultur, Gericht, Bauprojekte). Beispiele: suedkurier.de/region/konstanz, schwaebische.de, lokalkompass.de, suedwestpresse.de.
- "lokal_event" → Veranstaltungs-Übersicht, Eventkalender, Termin-Listen, Festival-Seiten. Beispiele: veranstaltungen.<x>.de, konstanz-info.com/events, eventfrog.de, regioactive.de/konzerte.
- "wetter" → Wetter-Vorhersage, „°C", „Niederschlag", „7-Tage-Trend", Wetterstation-Seiten.
- "übersichtsseite" → Reine Hub-/Themen-/Ressort-Seiten ohne eigenständige Story (Tag-Übersichten, „Mehr News"-Listen, Top-Stories-Hubs). Wenn die Seite nur eine Liste von Schlagzeilen ohne Einzelartikel-Inhalt zeigt.
- "andere" → alles andere: Tech-News, Wirtschaft, Politik, Wissenschaft, Magazine, Branchenportale, allgemeine Nachrichten ohne lokalen Bezug (spiegel.de, zeit.de, heise.de, etc.) ODER nicht eindeutig zuordenbar.

OUTPUT NUR ALS JSON (kein Markdown, kein Text davor/danach):
{
  "classifications": [
    {"i":0, "category":"lokalnachricht", "reason":"kurze Begründung (max 80 Zeichen)"},
    ...
  ]
}

Regeln:
- Pflicht: pro Input-Item GENAU ein Eintrag mit dem passenden "i".
- reason: 1 kurzer Satz (max 80 Zeichen), z.B. „Regionalzeitung, Polizeibericht erkennbar" oder „Eventkalender mit Konzert-Listen".
- Wenn nicht sicher: lieber „andere" als irreführende Lokal-/Event-Klassifizierung.`;

  const userText = `Bitte klassifiziere diese ${compact.length} Webseiten:\n\n${JSON.stringify(compact, null, 1)}`;

  let parsed;
  try {
    const res = await api.llm({
      system: sys,
      messages: [{ role: 'user', content: userText }],
      temperature: 0.0,
      max_tokens: 1400,
    });
    parsed = safeJsonExtract(res.reply || '') || {};
  } catch (e) {
    console.warn('user-site classification failed', e);
    return sources.map((s) => ({ url: s.url, category: 'andere', reason: 'LLM-Fehler' }));
  }

  const arr = Array.isArray(parsed.classifications) ? parsed.classifications : [];
  const byIdx = new Map();
  for (const c of arr) {
    if (!c || !Number.isInteger(c.i)) continue;
    const raw = String(c.category || '').trim().toLowerCase();
    let norm = 'andere';
    if (raw === 'lokalnachricht' || raw === 'lokal' || raw === 'lokal_news' || raw === 'local_news' || raw === 'nachricht') norm = 'lokalnachricht';
    else if (raw === 'lokal_event' || raw === 'event' || raw === 'events' || raw === 'veranstaltung' || raw === 'termin') norm = 'lokal_event';
    else if (raw === 'wetter' || raw === 'weather' || raw === 'vorhersage') norm = 'wetter';
    // Issue 27: pure Hub-/Übersichtsseiten markieren — UI zeigt das Chip im
    // Setup-Tab, der User kann die Quelle dann anpassen.
    else if (raw === 'übersichtsseite' || raw === 'uebersichtsseite' || raw === 'overview' || raw === 'hub' || raw === 'index' || raw === 'liste') norm = 'übersichtsseite';
    byIdx.set(c.i, { category: norm, reason: String(c.reason || '').slice(0, 80) });
  }
  return sources.map((s, i) => {
    const hit = byIdx.get(i) || { category: 'andere', reason: '' };
    return { url: s.url, category: hit.category, reason: hit.reason, title: s.pageTitle || '' };
  });
}

// Extraktion strukturierter Items aus den gecrawlten User-Sites — analog
// zu extractLocalNewsFromListings / extractEventsFromListings, aber mit
// einem breiteren Schema (alle vier typ-Werte werden zurückgegeben, weil
// der User auf seinen Sites sowohl Nachrichten als auch Events haben kann).
async function extractFromUserSites({ sources, profile, homeName }) {
  if (!sources || !sources.length) return { items: [] };

  const today = new Date().toISOString().slice(0, 10);
  // Issue 27: User-Höchstalter (1|3|5 Tage) statt 31 für lokalnachricht/andere.
  const userSiteAgeDays = getSiteMaxAgeDays();
  const cutoffDate = new Date(Date.now() - getSiteMaxAgeMs()).toISOString().slice(0, 10);
  const eventWin = eventWindow();
  const homeLine = homeName ? `Heim-Standort des Users: „${homeName}".` : '';

  const sys = `Du extrahierst strukturierte Inhalte aus dem Roh-Text gescrapter Webseiten, die ein User selbst als seine „eigenen Quellen" eingetragen hat. Heute ist ${today}. ${homeLine}

Pro QUELLE können Nachrichten, Events, Wetter ODER allgemeine Artikel stehen — du klassifizierst JEDES extrahierte Item mit dem Feld "typ":
- "lokalnachricht" → Lokal-/Regional-News mit Bezug zur Heimstadt (Polizei, Stadtrat, Schulen, Unfälle, Wirtschaft-Lokal, Kultur-Berichterstattung, Bauprojekte).
- "event" → Konkrete Veranstaltungs-Ankündigung mit Datum (Konzert, Lesung, Festival, Markt).
- "wetter" → Wetter-Vorhersage / aktuelle Wetterlage (wird in der App separat gerendert).
- "übersichtsseite" → Hub-/Themen-/Ressort-Sammlung ohne konkrete Einzelmeldung („Alle Sport-News heute", „Top-Stories", reine Schlagwort-/Tag-Listen, Newsticker-Sammelposts ohne eigenständige Story). Wird komplett verworfen — wir wollen nur konkrete Einzelartikel.
- "andere" → sonstige News-Artikel ohne lokalen Bezug (Tech, Politik, Wirtschaft, Wissenschaft, Magazin-Stücke).

⚠️ HARTE ZEITGRENZE — Nachrichten:
- typ "lokalnachricht" / "andere" mit Datum: nur akzeptieren wenn Datum ≥ ${cutoffDate} (max ${userSiteAgeDays} Tag${userSiteAgeDays === 1 ? '' : 'e'} alt).
- typ "event": nur Events mit konkretem Datum zwischen ${eventWin.start} und ${eventWin.end} (≈ ${eventWin.days} Tage).
- typ "wetter": Datum = ${today} (heute).
- Items ohne erkennbares Datum NICHT ausgeben.

OUTPUT NUR JSON (kein Markdown, kein Text davor/danach):
{
  "items": [
    {
      "title": "konkrete Schlagzeile / Event-Name (max 200 Zeichen)",
      "typ": "lokalnachricht" | "event" | "wetter" | "andere",
      "date": "YYYY-MM-DD",
      "time": "HH:MM" (nur bei typ=event, sonst ''),
      "location": "Ort/Stadt/Venue (optional; bei lokalnachricht/event möglichst gesetzt; bei andere/wetter leer wenn unklar)",
      "summary": "1-3 sachliche Sätze. Bei event: was, wo, Tickets? Bei nachricht: was ist konkret passiert?",
      "sourceIndex": 0
    }
  ]
}

BEISPIEL (Roh-Text aus suedkurier.de/region/konstanz):

Roh-Text: "Konstanz · 22.05.2026 — Stadtrat beschließt neue Fahrradzonen. // 25.05.2026 · Konzert „Bodensee Jazz Trio" 20 Uhr im K9. // Wetter heute Konstanz: 22°C, sonnig. // Tech: Apple stellt neues Vision Pro 3 vor (Quartalsbericht ${today})."

Extraktion:
{"items":[
  {"title":"Stadtrat beschließt neue Fahrradzonen","typ":"lokalnachricht","date":"2026-05-22","time":"","location":"Konstanz","summary":"Der Konstanzer Stadtrat hat neue Fahrradzonen rund um die Marktstätte beschlossen. Bis Herbst soll die Innenstadt verkehrsberuhigt werden.","sourceIndex":0},
  {"title":"Bodensee Jazz Trio im Kulturzentrum K9","typ":"event","date":"2026-05-25","time":"20:00","location":"Kulturzentrum K9, Konstanz","summary":"Das Bodensee Jazz Trio spielt am 25.05.2026 ab 20 Uhr im K9 — Jazz-Standards und Eigenkompositionen.","sourceIndex":0},
  {"title":"Wetter heute in Konstanz: 22°C, sonnig","typ":"wetter","date":"${today}","time":"","location":"Konstanz","summary":"Sonnig, 22 Grad, kein Niederschlag erwartet.","sourceIndex":0},
  {"title":"Apple stellt neues Vision Pro 3 vor","typ":"andere","date":"${today}","time":"","location":"","summary":"Apple hat das Vision Pro 3 mit größerem Sichtfeld und leichterem Gehäuse vorgestellt. Marktstart ist für Herbst angekündigt.","sourceIndex":0}
]}

DATUMS-ERKENNUNG: Absolut (22.05.2026, 22.5.26, 22. Mai 2026, May 22, 2026, 2026-05-22), Relativ ("vor 2 Stunden" → heute; "gestern" → ${new Date(Date.now() - 86400000).toISOString().slice(0,10)}; "vor X Tagen" → heute minus X). Ohne konkretes Datum: nicht aufnehmen.

REGELN:
- Nur EINZELNE konkrete Items — keine Sammelhinweise ("mehr in unserem Newsletter", "alle Events siehe Kalender").
- title: knackig, max 200 Zeichen, nicht wörtlich im summary wiederholen.
- typ: einer der vier Werte, Pflichtfeld. „lokalnachricht" nur bei klarem Lokalbezug (Stadt, Landkreis, Region passend zur Heimstadt); sonst „andere".
- date: striktes Format YYYY-MM-DD.
- location: bei lokalnachricht/event möglichst „Stadt" oder „Venue, Stadt"; bei andere/wetter leer wenn unklar (NICHT raten).
- summary: 1-3 Sätze, sachlich, mit Eigennamen/Zahlen.
- sourceIndex: Integer 0-${sources.length - 1}, MUSS gesetzt sein.
- KEINE Cookie-Banner, Newsletter-Hinweise, Navigation, Karriereseiten, generische Plattform-Texte.
- Maximal 15 Items GESAMT. Bei sehr produktiven Quellen die zeitlich nächsten / relevantesten.

SELF-CHECK vor Rückgabe: Hat jedes Item Datum im erlaubten Fenster? typ konsistent zum Inhalt? Wenn nicht → raus. Lieber 3 saubere Items als 12 erfundene.`;

  const userText = sources.map((s, i) => `=== QUELLE ${i}: ${s.source} ===
${s.pageTitle ? `Seitentitel: ${s.pageTitle}\n` : ''}URL: ${s.url}

${s.text}`).join('\n\n');

  let parsed;
  try {
    const res = await api.llm({
      system: sys,
      messages: [{ role: 'user', content: userText }],
      temperature: 0.15,
      max_tokens: 3200,
    });
    parsed = safeJsonExtract(res.reply || '') || {};
  } catch (e) {
    console.warn('user-site extraction failed', e);
    return { items: [] };
  }

  const raw = Array.isArray(parsed.items) ? parsed.items : [];
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const futureLimit = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const items = [];
  for (const it of raw) {
    if (!it || typeof it.title !== 'string') continue;
    const title = it.title.trim().slice(0, 200);
    if (title.length < 3) continue;
    const date = String(it.date || '').trim().slice(0, 10);
    if (!isoRe.test(date)) continue;
    const articleDate = new Date(date + 'T00:00:00');
    if (isNaN(articleDate.getTime())) continue;
    const srcIdx = Number.isInteger(it.sourceIndex) && it.sourceIndex >= 0 && it.sourceIndex < sources.length
      ? it.sourceIndex : 0;
    const src = sources[srcIdx] || sources[0];
    const rawTyp = String(it.typ || '').trim().toLowerCase();
    let typ = 'andere';
    if (rawTyp === 'lokalnachricht' || rawTyp === 'lokal_news' || rawTyp === 'local_news' || rawTyp === 'lokal' || rawTyp === 'nachricht') typ = 'lokalnachricht';
    else if (rawTyp === 'event' || rawTyp === 'lokal_event' || rawTyp === 'veranstaltung' || rawTyp === 'termin') typ = 'event';
    else if (rawTyp === 'wetter' || rawTyp === 'weather' || rawTyp === 'vorhersage') typ = 'wetter';
    // Issue 27: Hub-/Übersichtsseiten erkennen und (oben) komplett verwerfen.
    else if (rawTyp === 'übersichtsseite' || rawTyp === 'uebersichtsseite' || rawTyp === 'overview' || rawTyp === 'hub' || rawTyp === 'index' || rawTyp === 'liste') typ = 'übersichtsseite';

    // typ-spezifische Datums-Filter
    // Issue 27: Übersichtsseiten komplett rauswerfen — der LLM klassifiziert
    // Hub-/Listenseiten ohne konkreten Einzelinhalt aktiv mit typ='übersichtsseite'.
    if (typ === 'übersichtsseite') continue;
    if (typ === 'event') {
      if (date < eventWin.start || date > eventWin.end) continue;
    } else if (typ === 'lokalnachricht' || typ === 'andere') {
      // Issue 27: User-Höchstalter (1|3|5 Tage) statt 31.
      if (isArticleTooOldForSites(articleDate)) continue;
      if (date > futureLimit) continue;
    } else if (typ === 'wetter') {
      // Wetter sortieren wir später raus, aber wir lassen es hier rein, damit
      // der Caller die Statistik sieht (X Wetter-Treffer ignoriert).
      if (date > futureLimit) continue;
    }

    items.push({
      title,
      typ,
      date,
      time: String(it.time || '').trim().slice(0, 5),
      location: String(it.location || '').trim().slice(0, 80),
      summary: String(it.summary || '').trim().slice(0, 600),
      url: src.url,
      source: src.source,
      sourceIndex: srcIdx,
    });
  }
  // Title-Dedup pro Pipeline-Lauf
  const seenTitles = new Set();
  const dedup = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    dedup.push(it);
  }
  return { items: dedup };
}

// Hochlevel-Wrapper für den Runtime-Pfad: crawlen + extrahieren, gruppiert
// nach typ. Wird in `runSummarize` nach der Lokal-News-Extraktion aufgerufen.
async function runUserSitesPipeline(profile, { log } = {}) {
  const sites = store.get(LS.searchSites, []) || [];
  const empty = { localNews: [], events: [], other: [], weatherCount: 0, overviewCount: 0, rendered: 0, skipped: 0, followedArticles: [] };
  if (!sites.length) return empty;
  const homeName = profile && profile.locations && profile.locations[0]
    ? (profile.locations[0].name || '').split(',')[0].trim()
    : '';
  if (log) log(`Crawle ${sites.length} eigene Webseite${sites.length === 1 ? '' : 'n'} (Playwright)…`);
  const { sources, rendered, skipped } = await crawlUserSitePages(sites);
  if (!sources.length) {
    if (log) log(`– Eigene Webseiten: keine verwertbaren Texte (${skipped} übersprungen)`);
    return empty;
  }
  if (log) log(`✓ ${sources.length} Seiten gecrawlt (${rendered} via Playwright)${skipped ? `, ${skipped} ohne Text` : ''}`);

  // Issue 44: Nachrichtenseiten enthalten typischerweise Anchors zu
  // einzelnen Artikeln — wir laden die wichtigsten davon nach (Trafilatura)
  // und füttern den Roh-Text als ZUSÄTZLICHE Quellen in den LLM-Extraktor.
  // Dadurch sieht der Extraktor nicht nur die Listen-Headlines, sondern den
  // ausführlichen Artikel-Body — was zuverlässig zu präziseren Items
  // (richtiges Datum, vollständiger Kontext, sauberer typ) führt. Außerdem
  // werden die Roh-Texte oben an `runSummarize` zurückgereicht, damit sie
  // im RAG-Index landen.
  let followedArticles = [];
  try {
    const follow = await followArticleLinksFromPages(sources, { log });
    followedArticles = follow.articles || [];
  } catch (e) {
    console.warn('user-sites article follow failed', e);
  }

  // Einzelartikel-Texte als zusätzliche Quellen verfügbar machen — sie
  // bekommen einen separaten Source-Index hinter den Original-Seiten, damit
  // `extractFromUserSites` sie als eigenständige Inputs sieht. Der LLM
  // entscheidet dann per JSON, ob er sie als „lokalnachricht" / „andere"
  // / „event" einsortiert.
  const sourcesPlus = sources.slice();
  for (const a of followedArticles) {
    sourcesPlus.push({
      url: a.url,
      source: a.source || a.parentSource || sourceFromUrl(a.url) || a.url,
      pageTitle: a.title || '',
      // Cap: 6000 Zeichen (gleiche Größe wie crawlUserSitePages-Sources)
      text: (a.text || '').slice(0, 6000),
      html: '',
    });
  }

  const { items } = await extractFromUserSites({ sources: sourcesPlus, profile, homeName });
  if (!items.length) {
    if (log) log(`– Eigene Webseiten: 0 Items extrahiert`);
    return { ...empty, rendered, skipped, followedArticles };
  }
  const localNews = [];
  const events = [];
  const other = [];
  let weatherCount = 0;
  let overviewCount = 0; // Issue 27
  for (const it of items) {
    // Issue 27: Übersichtsseiten kommen aus extractFromUserSites bereits
    // ausgesiebt — Defense-in-Depth: hier nochmal überspringen, falls
    // Schema-Drift.
    if (it.typ === 'übersichtsseite') { overviewCount++; continue; }
    if (it.typ === 'lokalnachricht') {
      localNews.push({
        title: it.title,
        date: it.date,
        location: it.location,
        source: it.source,
        summary: it.summary,
        url: it.url,
        // typ/sourceIndex bleiben dran, schaden aber nicht
        typ: 'Nachricht',
        // Issue 34: Herkunfts-Tag analog zum RSS-Pfad — die manuell eingetragenen
        // Webseiten-URLs sind keine Karten-Quelle, sondern werden im Lokal-Bucket
        // in den Round-Robin-Tail einsortiert, damit eine einzelne User-Seite
        // nicht die ganze Rubrik füllt.
        origin: 'user-site',
      });
    } else if (it.typ === 'event') {
      // Issue 24 Bug-Fix: buildEventCard liest `title` und `date` (nicht
      // `event_name`/`event_date`). Vor dem Fix kamen User-Site-Events ohne
      // Überschrift und ohne Datum auf der Karte an — beide Felder waren
      // undefined, weil hier nur die event_*-Aliase gesetzt wurden.
      events.push({
        title: it.title,
        date: it.date,
        time: it.time || '',
        description: it.summary,
        summary: it.summary,
        location: it.location || homeName,
        // Aliase für Code, der das Konzept-Schema erwartet:
        event_name: it.title,
        event_date: it.date,
        event_time: it.time || '',
        event_summary: it.summary,
        event_location: it.location || homeName,
        url: it.url,
        source: it.source,
        // kein Distanz-Hartfilter — der User hat die Quelle selbst gewählt.
        distanceKm: null,
      });
    } else if (it.typ === 'wetter') {
      weatherCount++;
    } else {
      other.push(it);
    }
  }
  if (log) {
    const followNote = followedArticles && followedArticles.length
      ? ` · ${followedArticles.length} Einzelartikel tiefgescannt`
      : '';
    log(`✓ Eigene Webseiten — ${localNews.length} lokal, ${events.length} Events, ${other.length} andere${weatherCount ? `, ${weatherCount} Wetter ignoriert` : ''}${overviewCount ? `, ${overviewCount} Übersichtsseiten verworfen` : ''}${followNote}`);
  }
  return { localNews, events, other, weatherCount, overviewCount, rendered, skipped, followedArticles };
}

// =============================================================================
// News-Rendering
// =============================================================================

// Issue 36: aufklappbares Debug-Panel mit den Telemetrie-Ringpuffer-Daten
// aus Issue 35. Wird nur gerendert, wenn die Zusammenfassung tatsächlich
// fehlgeschlagen ist (Fallback-Pfad aktiv). Zeigt pro Call: Zeitstempel,
// Modell, HTTP-Status, Latenz, Reply-Länge, Fehler. Fehler-Zeilen (HTTP
// ≠ 200 oder error gesetzt) werden visuell rot hervorgehoben — der Rest
// dient als Kontext um den Fehler herum.
//
// Issue 39: Panel komplett überarbeitet, damit der Knopf direkt sichtbar ist
// und die wichtigsten Statusinformationen inline angezeigt werden — ohne
// dass der User erst klicken muss. Neuer Aufbau:
//   1. Headline-Zeile (immer sichtbar): rotes Banner mit „Sprachmodell
//      lieferte keinen Text" + Inline-Chips für letzten HTTP-Status, letzte
//      Reply-Länge, letztes Modell, plus Aggregat (z.B. „3× HTTP 500").
//   2. Aufklappbares Details-Element (`open` per Default), das die volle
//      Telemetrie-Tabelle zeigt. User kann es einklappen, wenn ihn die
//      Inline-Zusammenfassung schon ausreicht.
function buildBriefingFailureDebugPanel(reason, telemetry) {
  const wrap = document.createElement('div');
  wrap.className = 'mt-4 rounded-lg border border-rose-500/40 bg-rose-500/5 text-xs text-slate-200';

  // Inline-Headline mit Status-Chips — IMMER sichtbar, kein Klick nötig.
  const head = document.createElement('div');
  head.className = 'px-3 pt-3 pb-2 space-y-2';

  const failedCount = telemetry.filter((t) => (t && (t.httpStatus !== 200 || t.error))).length;
  const okCount = telemetry.length - failedCount;
  const last = telemetry[telemetry.length - 1] || null;
  const lastStatus = last ? (last.httpStatus || (last.error ? 'net' : '?')) : '?';
  const lastReplyLen = last && typeof last.replyLen === 'number' ? last.replyLen : 0;
  const lastModel = last ? (last.model || '?').split('/').pop() : '?';
  const aggregate = summarizeLlmTelemetry(telemetry.length);

  const title = document.createElement('div');
  title.className = 'flex items-center gap-2 text-rose-200 font-semibold text-sm';
  title.innerHTML = `<span>⚠</span><span>Sprachmodell lieferte keinen Text — lokaler Fallback aktiv.</span>`;
  head.appendChild(title);

  const chipRow = document.createElement('div');
  chipRow.className = 'flex flex-wrap gap-1.5 text-[11px] font-mono';
  const chip = (label, value, tone = 'neutral') => {
    const cls = tone === 'bad'
      ? 'bg-rose-500/20 text-rose-100 border-rose-400/40'
      : tone === 'ok'
        ? 'bg-emerald-500/20 text-emerald-100 border-emerald-400/40'
        : 'bg-white/10 text-slate-200 border-white/15';
    return `<span class="px-2 py-0.5 rounded border ${cls}"><span class="text-slate-400">${escapeHtml(label)}</span> <strong>${escapeHtml(String(value))}</strong></span>`;
  };
  const lastTone = (lastStatus === 200 && lastReplyLen > 0) ? 'ok' : 'bad';
  const chips = [
    chip('Letzter HTTP', lastStatus, lastTone),
    chip('Reply', `${lastReplyLen}c`, lastReplyLen > 0 ? 'ok' : 'bad'),
    chip('Modell', lastModel),
    chip('Calls', `${okCount} OK / ${failedCount} Fehler`, failedCount > 0 ? 'bad' : 'neutral'),
  ];
  if (aggregate) chips.push(chip('Verlauf', aggregate));
  chipRow.innerHTML = chips.join('');
  head.appendChild(chipRow);

  const reasonLine = document.createElement('p');
  reasonLine.className = 'text-rose-200/90 leading-snug text-[11px]';
  reasonLine.textContent = `Grund: ${reason}`;
  head.appendChild(reasonLine);

  wrap.appendChild(head);

  // Aufklappbare Detail-Tabelle. `open` per Default — der Konzept-Auftrag
  // verlangt direkte Sichtbarkeit; die Tabelle ist die ausführliche Sicht.
  const details = document.createElement('details');
  details.open = true;
  details.className = 'border-t border-rose-500/20';

  const summary = document.createElement('summary');
  summary.className = 'cursor-pointer select-none px-3 py-2 text-rose-200/90 hover:text-rose-100 text-[11px] font-medium';
  summary.textContent = `🔍 Telemetrie der letzten ${telemetry.length} LLM-Calls`;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'px-3 pb-3 pt-1 space-y-2';

  const table = document.createElement('div');
  table.className = 'space-y-1 font-mono text-[11px] leading-snug';
  for (const t of telemetry) {
    if (!t) continue;
    const failed = (t.httpStatus && t.httpStatus !== 200) || !!t.error;
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-x-3 gap-y-0.5 px-2 py-1 rounded ' +
      (failed ? 'bg-rose-500/10 text-rose-200' : 'bg-white/5 text-slate-300');
    const ts = t.startedAt ? new Date(t.startedAt).toISOString().slice(11, 23) : '?';
    const model = (t.model || '?').split('/').pop();
    const status = t.httpStatus || (t.error ? 'net' : '?');
    const dur = typeof t.durationMs === 'number' ? `${t.durationMs}ms` : '?';
    const replyLen = typeof t.replyLen === 'number' ? `${t.replyLen}c` : '0c';
    row.innerHTML =
      `<span class="text-slate-400">${escapeHtml(ts)}</span>` +
      `<span>HTTP <strong>${escapeHtml(String(status))}</strong></span>` +
      `<span>${escapeHtml(dur)}</span>` +
      `<span>reply ${escapeHtml(replyLen)}</span>` +
      `<span class="text-slate-400">${escapeHtml(model)}</span>` +
      (t.error ? `<span class="basis-full text-rose-300/90">⚠ ${escapeHtml(String(t.error).slice(0, 200))}</span>` : '');
    table.appendChild(row);
  }
  body.appendChild(table);
  details.appendChild(body);

  wrap.appendChild(details);
  return wrap;
}

// Issue 8: Rendering komplett umgebaut — feste Tagesrubriken statt
// Wichtig/Hintergrund-Split. Items werden aus dem buckets-Objekt im Cache
// pro Rubrik gerendert. Wetter bekommt eine eigene Karte oben drüber.
function renderNews(cache) {
  const buckets = (cache && cache.buckets) || null;
  const items = (cache && cache.items) || [];
  const events = (cache && cache.events) || [];

  // Greeting / Briefing
  if (cache && cache.greeting) {
    $('#greeting').classList.remove('hidden');
    const target = $('#greeting-text');
    target.innerHTML = '';
    const paragraphs = String(cache.greeting)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (!paragraphs.length) {
      target.textContent = cache.greeting;
    } else {
      paragraphs.forEach((p, i) => {
        const para = document.createElement('p');
        para.textContent = p;
        para.className = 'leading-relaxed' + (i > 0 ? ' mt-3' : '');
        target.appendChild(para);
      });
    }
    // Issue 36: Debug-Knopf nur dann, wenn die Zusammenfassung tatsächlich
    // fehlgeschlagen ist (Fallback-Pfad aktiv → briefingFailureReason gesetzt).
    // Knopf wird unter den Briefing-Paragraphen (also direkt unter dem
    // „Diese Zusammenfassung wurde lokal erzeugt…"-Hinweis) angehängt; der
    // Hinweistext selbst bleibt unverändert.
    if (cache.briefingFailureReason && Array.isArray(cache.briefingFailureTelemetry) && cache.briefingFailureTelemetry.length) {
      target.appendChild(buildBriefingFailureDebugPanel(cache.briefingFailureReason, cache.briefingFailureTelemetry));
    }
    // Issue 21: TTS-Bar an aktuellen Briefing-Text binden / zurücksetzen
    resetTTSBar(String(cache.greeting));
  } else {
    $('#greeting').classList.add('hidden');
    resetTTSBar('');
  }

  // Meta-Zeile
  const meta = $('#briefing-meta');
  if (cache && cache.generatedAt) {
    const dateStr = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(cache.generatedAt));
    meta.textContent = `Letzte Übersicht: ${dateStr} · ${items.length} Artikel${cache.profileSummary ? ` · Profil: ${(cache.profileSummary.modules || []).length} Module` : ''}`;
  } else {
    meta.textContent = 'Klick auf „Zusammenfassen", um die neueste Übersicht zu erstellen.';
  }

  // Wetter-Karte
  renderWeather(cache && cache.weather);

  // Rubriken-Container leeren
  const root = $('#news-buckets');
  root.innerHTML = '';

  // Empty state — Issue 38: auch ein gefüllter Medizin-Bucket aus reinen
  // PubMed-Studien soll als „nicht leer" zählen. Dasselbe gilt defensiv für
  // den Lokal-Bucket, falls der reine `concreteLocalNews`-Pfad ohne
  // Scorer-Items aktiv war (Edge-Case).
  const pubmedCount = (cache && Array.isArray(cache.pubmedStudies)) ? cache.pubmedStudies.length : 0;
  const localCount = (cache && Array.isArray(cache.localNews)) ? cache.localNews.length : 0;
  if ((!items.length) && (!events.length) && !pubmedCount && !localCount) {
    $('#empty-state').classList.remove('hidden');
    return;
  }
  $('#empty-state').classList.add('hidden');

  // Issue 8: Top-5-Block (Querschnitt über alle Rubriken)
  const top5 = (cache && cache.top5 && cache.top5.length) ? cache.top5 : items.slice(0, 5);
  if (top5 && top5.length) {
    root.appendChild(buildBucketSection({
      id: 'top5',
      label: 'Top 5',
      icon: '⭐',
      items: top5,
      mode: 'card',
    }));
  }

  // Feste Rubriken in fester Reihenfolge — leere weglassen
  for (const b of BUCKETS) {
    const arr = (buckets && buckets[b.id]) || [];
    if (!arr.length) continue;
    root.appendChild(buildBucketSection({
      id: b.id,
      label: b.label,
      icon: b.icon,
      items: arr,
      mode: b.id === 'events' ? 'event' : (arr.length > 4 ? 'mixed' : 'card'),
    }));
  }
}

// Erzeugt eine <section> mit Header + Karten-Grid für eine Rubrik.
function buildBucketSection({ id, label, icon, items, mode }) {
  const section = document.createElement('section');
  section.dataset.bucket = id;

  const header = document.createElement('header');
  header.className = 'flex items-baseline justify-between mb-3 mt-2';
  header.innerHTML = `
    <h3 class="font-display text-lg font-semibold text-slate-100 flex items-center gap-2">
      <span class="text-ember-400">${escapeHtml(icon || '·')}</span> ${escapeHtml(label)}
    </h3>
    <span class="text-xs text-slate-500">${items.length} Treffer</span>
  `;
  section.appendChild(header);

  if (mode === 'event') {
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';
    items.forEach((ev, i) => grid.appendChild(buildEventCard(ev, i)));
    section.appendChild(grid);
    return section;
  }

  // Mixed: erste 4 als Karte, Rest kompakt
  const userHosts = getUserSiteHosts();
  if (mode === 'mixed') {
    const headItems = items.slice(0, 4);
    const tailItems = items.slice(4);
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';
    headItems.forEach((it, i) => grid.appendChild(buildNewsCard(it, i, userHosts)));
    section.appendChild(grid);
    if (tailItems.length) {
      const tail = document.createElement('div');
      tail.className = 'space-y-2 mt-3';
      tailItems.forEach((it, i) => tail.appendChild(buildCompactRow(it, i, userHosts)));
      section.appendChild(tail);
    }
    return section;
  }

  // mode === 'card'
  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';
  items.forEach((it, i) => grid.appendChild(buildNewsCard(it, i, userHosts)));
  section.appendChild(grid);
  return section;
}

// Issue 8: News-Karte als DOM-Knoten — ersetzt die alte Template-Logik (das
// Template hatte noch die Hypothese-Box; jetzt zeigen wir Evidenz statt
// Hypothese und einen Chip für relevance_type).
function buildNewsCard(it, i, userHosts) {
  const art = document.createElement('article');
  art.className = 'rounded-2xl border border-white/10 bg-ink-800/60 hover:bg-ink-800 transition p-5 flex flex-col gap-3 pop-in';
  art.style.animationDelay = `${Math.min(i, 8) * 35}ms`;

  const typeLabel = (it.relevance_type || 'general').replace(/_/g, ' ');

  // Issue 10: YouTube-Items bevorzugen den Kanalnamen als Quelle, sonst hostname.
  // Issue 38: PubMed-Items bevorzugen das Journal + Autoren (kompakt) als Quelle.
  const isYouTube = it.origin === 'youtube';
  const isPubmed = it.origin === 'pubmed';
  let ds;
  if (isYouTube) {
    ds = `YouTube · ${it.ytChannel || sourceFromUrl(it.url)}`;
  } else if (isPubmed) {
    const jr = it.pubmedJournal ? ` · ${it.pubmedJournal}` : '';
    const au = it.pubmedAuthors ? ` · ${it.pubmedAuthors}` : '';
    ds = `PubMed${jr}${au}`;
  } else {
    ds = displaySource(it.url, userHosts) || it.source || sourceFromUrl(it.url);
  }
  const date = it.date ? ` · ${fmtDate(it.date)}` : '';
  const ytBadge = isYouTube
    ? `<span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-200 border border-rose-500/30 flex items-center gap-1">▶ Video</span>`
    : '';
  // Issue 38: PubMed-Studie-Badge (visuell vom News-Item unterscheidbar).
  const pubmedBadge = isPubmed
    ? `<span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-200 border border-sky-500/30 flex items-center gap-1" title="Wissenschaftliche Studie aus PubMed">⚕ Studie</span>`
    : '';

  // Issue 22: Datum-Chip (oben rechts) + Ortsangabe (eigene Zeile mit
  // Pin-Icon, wenn `it.location` gesetzt ist — typisch bei extrahierten
  // Lokal-News und LLM-bewerteten Items mit local_*-Typ).
  const dateChip = it.date
    ? `<span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">${escapeHtml(fmtDate(it.date))}</span>`
    : '';
  const locationLine = it.location
    ? `<div class="text-sm text-slate-300 flex items-center gap-1.5">
         <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-ember-400 shrink-0"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>
         <span>${escapeHtml(it.location)}</span>
       </div>`
    : '';

  // Issue 32: zwei Score-Chips (Interesse + Betroffenheit, 1..10). Ältere
  // Caches ohne Felder fallen sauber auf den alten relevance-Chip zurück, damit
  // bereits-gerenderte Karten beim Reload nicht plötzlich „1/10" zeigen.
  const hasNewScores = typeof it.interestScore === 'number' || typeof it.affectednessScore === 'number';
  let scoresHtml = '';
  if (hasNewScores) {
    const iv = typeof it.interestScore === 'number' ? it.interestScore : 1;
    const av = typeof it.affectednessScore === 'number' ? it.affectednessScore : 1;
    const tone = (v) => v >= 8 ? '30 text-' : v >= 6 ? '20 text-' : '10 text-';
    const intCls = `bg-ember-500/${tone(iv)}ember-100 border-ember-500/30`;
    const affCls = `bg-rose-500/${tone(av)}rose-100 border-rose-500/30`;
    scoresHtml = `
      <span class="text-xs px-2 py-0.5 rounded-full ${intCls} border whitespace-nowrap" title="Interesse / Themenaffinität (1–10)">★ Interesse ${iv}/10</span>
      <span class="text-xs px-2 py-0.5 rounded-full ${affCls} border whitespace-nowrap" title="Betroffenheit — wie sehr betrifft dich das persönlich (1–10)">❤ Betroffen ${av}/10</span>
    `;
  } else {
    const relColor = it.relevance >= 8 ? 'bg-ember-500/30 text-ember-200'
                    : it.relevance >= 6 ? 'bg-ember-500/20 text-ember-300'
                    : 'bg-slate-700/50 text-slate-300';
    scoresHtml = `<span class="text-xs px-2 py-0.5 rounded-full ${relColor} border border-white/10">★ ${(it.relevance || 0).toFixed(1)}/10</span>`;
  }

  // Issue 32: wenn Betroffenheit > Interesse, zeigt die Karte den vom LLM
  // gelieferten Betroffenheits-Satz als eigenen hervorgehobenen Block — der
  // erklärt konkret, wie/warum die Nachricht den User trifft (jetzt oder in
  // Zukunft). Konzept-Vorgabe Issue 32.
  const showAffNote = hasNewScores
    && typeof it.affectednessScore === 'number'
    && typeof it.interestScore === 'number'
    && it.affectednessScore > it.interestScore
    && it.affectednessNote && it.affectednessNote.trim();
  const affectednessNoteHtml = showAffNote ? `
      <div class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 leading-snug">
        <span class="inline-flex items-center gap-1 text-[0.7rem] uppercase tracking-wide text-rose-200 font-semibold mr-1">
          ❤ Betrifft dich
        </span>
        ${escapeHtml(it.affectednessNote)}
      </div>` : '';

  art.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <h4 class="font-display font-semibold text-lg leading-snug text-slate-100">${escapeHtml(it.title || '')}</h4>
      <div class="flex flex-col gap-1 items-end shrink-0">
        ${ytBadge}
        ${pubmedBadge}
        ${scoresHtml}
        ${dateChip}
      </div>
    </div>
    ${locationLine}
    <p class="text-sm text-slate-300 leading-relaxed">${escapeHtml(it.summary || it.snippet || '')}</p>
    ${affectednessNoteHtml}
    ${it.evidence ? `
      <div class="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-100/90 leading-snug">
        <span class="inline-flex items-center gap-1 text-[0.7rem] uppercase tracking-wide text-emerald-300/80 font-semibold mr-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          ${escapeHtml(typeLabel)}
        </span>
        ${escapeHtml(it.evidence)}
      </div>` : ''}
    <div class="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-white/5 mt-auto">
      <div class="flex items-center gap-2 min-w-0">
        <span class="truncate max-w-[16rem]" title="${escapeHtml(it.url || '')}">${escapeHtml(ds)}</span>
        <span class="shrink-0">${escapeHtml(date)}</span>
      </div>
      <a href="${escapeHtml(it.url || '#')}" target="_blank" rel="noopener noreferrer" class="text-ember-400 hover:text-ember-300 inline-flex items-center gap-1">
        Lesen
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3.5 h-3.5"><path d="M14 3v2h3.59L7.76 14.83l1.41 1.41L19 6.41V10h2V3z"/></svg>
      </a>
    </div>
  `;
  return art;
}

// Issue 25: Layout-Fix — in den Rubriken (unter Top 5) standen Titel und Link
// (Quellen-Label) nebeneinander, was bei längeren Titeln und langen Hostnames
// schnell eng wurde. Jetzt: Titel oben, Quelle/Link in einer eigenen Zeile
// darunter — beide bleiben in einem klickbaren <a> verpackt.
function buildCompactRow(it, i, userHosts) {
  const a = document.createElement('a');
  a.href = it.url || '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = 'flex items-start gap-3 rounded-xl border border-white/5 bg-ink-800/40 hover:bg-ink-800 transition px-4 py-2.5 text-sm pop-in';
  a.style.animationDelay = `${Math.min(i, 8) * 25}ms`;
  const ds = displaySource(it.url, userHosts) || it.source || sourceFromUrl(it.url);
  a.innerHTML = `
    <span class="text-slate-500 mt-0.5 shrink-0">•</span>
    <span class="grow min-w-0 flex flex-col gap-0.5">
      <span class="text-slate-200 leading-snug">${escapeHtml(it.title || '')}</span>
      <span class="text-xs text-ember-400/90 truncate" title="${escapeHtml(it.url || '')}">${escapeHtml(ds)}</span>
    </span>
  `;
  return a;
}

// Issue 8: Event-Karte mit Distanz-Chip (wenn vorhanden)
function buildEventCard(ev, i) {
  const userHosts = getUserSiteHosts();
  const card = document.createElement('article');
  card.className = 'rounded-2xl border border-white/10 bg-ink-800/60 hover:bg-ink-800 transition p-5 flex flex-col gap-2 pop-in';
  card.style.animationDelay = `${Math.min(i, 8) * 35}ms`;
  const dateLine = renderEventDate(ev.date, ev.time);
  const srcLabel = displaySource(ev.url, userHosts) || ev.source || sourceFromUrl(ev.url);
  const distChip = (typeof ev.distanceKm === 'number' && ev.distanceKm > 0.1)
    ? `<span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-500/30">${ev.distanceKm.toFixed(1)} km</span>`
    : '';
  card.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <h4 class="font-display font-semibold text-lg leading-snug text-slate-100">${escapeHtml(ev.title)}</h4>
      ${dateLine ? `<span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">${escapeHtml(dateLine)}</span>` : ''}
    </div>
    ${ev.location ? `<div class="text-sm text-slate-300 flex items-center gap-1.5">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-ember-400 shrink-0"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>
      <span>${escapeHtml(ev.location)}</span>
      ${distChip}
    </div>` : (distChip ? `<div>${distChip}</div>` : '')}
    ${ev.description ? `<p class="text-sm text-slate-300 leading-relaxed">${escapeHtml(ev.description)}</p>` : ''}
    <div class="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-white/5 mt-auto">
      <span class="truncate max-w-[18rem]" title="${escapeHtml(ev.url || '')}">${escapeHtml(srcLabel)}</span>
      <a href="${escapeHtml(ev.url || '#')}" target="_blank" rel="noopener noreferrer" class="text-ember-400 hover:text-ember-300 inline-flex items-center gap-1">
        Quelle
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3.5 h-3.5"><path d="M14 3v2h3.59L7.76 14.83l1.41 1.41L19 6.41V10h2V3z"/></svg>
      </a>
    </div>
  `;
  return card;
}

// Issue 8: Wetter-Karte. Wird oberhalb der Rubriken angezeigt, wenn der Cache
// einen Wetter-Block hat. Quelle: Open-Meteo via tools-server.
function renderWeather(weather) {
  const wrap = $('#weather-card');
  if (!wrap) return;
  if (!weather || !weather.current) {
    wrap.classList.add('hidden');
    return;
  }
  const cur = weather.current;
  const [icon, label] = describeWeatherCode(cur.weather_code);
  const days = (weather.daily || []).slice(0, 3);
  const fmtDay = (d) => {
    try { return new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(new Date(d.date + 'T00:00:00')); }
    catch { return d.date; }
  };
  // Issue 27: UV-Index direkt im Header zeigen — laut Konzept als
  // erstes Wetter-Detail neben Temperatur und Bedingungen. Mit Farbcode
  // (grün/gelb/orange/rot/violett analog WHO-UV-Skala).
  const uvNow = typeof cur.uv_index === 'number' ? cur.uv_index : null;
  const uvMax = days[0] && typeof days[0].uv_index_max === 'number' ? days[0].uv_index_max : null;
  const uvVal = uvNow != null ? uvNow : uvMax;
  let uvBadge = '';
  if (uvVal != null) {
    const lvl = uvVal < 3 ? { txt: 'niedrig', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40' }
              : uvVal < 6 ? { txt: 'mittel',  cls: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/40' }
              : uvVal < 8 ? { txt: 'hoch',    cls: 'bg-orange-500/15 text-orange-200 border-orange-500/40' }
              : uvVal < 11 ? { txt: 'sehr hoch', cls: 'bg-rose-500/15 text-rose-200 border-rose-500/40' }
              :              { txt: 'extrem',    cls: 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-500/40' };
    const lbl = uvNow != null ? 'UV' : 'UV-Tagesmax';
    uvBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${lvl.cls} text-xs font-medium ml-2 align-middle" title="UV-Index — ${escapeHtml(lvl.txt)}">☀ ${lbl} ${uvVal.toFixed(1)} · ${escapeHtml(lvl.txt)}</span>`;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="flex items-center gap-4 flex-wrap">
      <div class="text-4xl">${icon}</div>
      <div class="grow min-w-0">
        <div class="font-display text-lg font-semibold text-slate-100">Wetter${weather.locationName ? ` in ${escapeHtml(weather.locationName)}` : ''}</div>
        <div class="text-sm text-slate-300">${cur.temperature_2m}°C · ${escapeHtml(label)}${typeof cur.wind_speed_10m === 'number' ? ` · Wind ${cur.wind_speed_10m} km/h` : ''}${uvBadge}</div>
      </div>
      <div class="flex gap-3 text-xs text-slate-300 ml-auto">
        ${days.map((d) => `
          <div class="text-center">
            <div class="text-slate-400">${escapeHtml(fmtDay(d))}</div>
            <div>${describeWeatherCode(d.weather_code)[0]}</div>
            <div class="font-mono">${Math.round(d.tmin)}° / ${Math.round(d.tmax)}°</div>
            ${typeof d.uv_index_max === 'number' ? `<div class="text-[0.65rem] text-slate-500">UV ${d.uv_index_max.toFixed(1)}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>
  `;
}

// =============================================================================
// Aktien-Update-Flow
// =============================================================================

async function runStockCheck() {
  const portfolio = store.get(LS.portfolio, []);
  if (!portfolio.length) {
    toast('Kein Portfolio vorhanden. Füge im Tab „Portfolio" Aktien hinzu.', 'error');
    activateTab('portfolio');
    return;
  }

  const settings = store.get(LS.settings, {});
  const threshold = typeof settings.alertThreshold === 'number' ? settings.alertThreshold : 5;
  const btn = $('#btn-stocks');
  btn.disabled = true;
  setProgress(`Hole Kurse für ${portfolio.length} Aktien…`, `Benachrichtigungs-Schwelle: ${threshold}%`);

  try {
    const history = store.get(LS.stockHistory, {});
    const wrap = $('#stock-results-wrap');
    const list = $('#stock-results');
    wrap.classList.remove('hidden');
    list.innerHTML = '';

    const results = await Promise.allSettled(
      portfolio.map((p) => api.stocks(p.symbol, { range: '5d', interval: '1d' }).then((r) => ({ p, r })))
    );

    const alerts = [];

    for (const r of results) {
      if (r.status === 'rejected') {
        setProgress(null, `✗ Fehler bei einem Ticker`);
        continue;
      }
      const { p, r: data } = r.value;
      const info = data.info || {};
      const history_arr = data.history || [];
      const last = history_arr[history_arr.length - 1] || {};
      const prev = history_arr[history_arr.length - 2] || {};
      const currentPrice = (info.price ?? last.close) || null;
      const currency = info.currency || 'USD';
      const dayChange = (last.close && prev.close) ? ((last.close - prev.close) / prev.close) * 100 : null;
      const prevStored = history[p.symbol] || {};
      const sincePrevCheck = (prevStored.lastPrice && currentPrice)
        ? ((currentPrice - prevStored.lastPrice) / prevStored.lastPrice) * 100
        : null;

      // Notify-Schwelle: nehme den größeren der beiden (seit-letztem-Check ODER intraday)
      const checks = [
        { label: 'seit letztem Check', value: sincePrevCheck },
        { label: 'Tagesveränderung', value: dayChange },
      ].filter((c) => c.value != null);
      const triggered = checks.find((c) => Math.abs(c.value) >= threshold);

      if (triggered && prevStored.lastPrice) {
        alerts.push({ p, change: triggered.value, label: triggered.label, currentPrice, currency });
      }

      // Update history
      history[p.symbol] = {
        lastPrice: currentPrice,
        currency,
        lastCheckedAt: Date.now(),
        name: info.longName || info.shortName || p.name || '',
      };

      // Render card
      const change = dayChange;
      const chipClass = change == null ? 'chip-flat' : change > 0 ? 'chip-up' : change < 0 ? 'chip-down' : 'chip-flat';
      const chipSign = change == null ? '' : change > 0 ? '+' : '';
      const card = document.createElement('div');
      card.className = 'rounded-xl border border-white/10 bg-ink-800/60 p-4 flex flex-col gap-1 pop-in';
      card.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="font-mono text-ember-300 text-sm">${escapeHtml(p.symbol)}</span>
          <span class="text-xs ${chipClass} font-mono">${change == null ? '—' : `${chipSign}${change.toFixed(2)}%`}</span>
        </div>
        <div class="text-slate-200 text-sm truncate">${escapeHtml(info.longName || info.shortName || p.name || p.symbol)}</div>
        <div class="text-slate-100 font-mono text-base">${currentPrice ? formatPrice(currentPrice, currency) : '—'}</div>
        ${sincePrevCheck != null ? `<div class="text-xs text-slate-500">Seit letztem Check: <span class="${sincePrevCheck > 0 ? 'chip-up' : sincePrevCheck < 0 ? 'chip-down' : 'chip-flat'} font-mono">${sincePrevCheck > 0 ? '+' : ''}${sincePrevCheck.toFixed(2)}%</span></div>` : ''}
      `;
      list.appendChild(card);
      setProgress(null, `✓ ${p.symbol}: ${currentPrice ? formatPrice(currentPrice, currency) : 'n/a'}${change != null ? ` (${chipSign}${change.toFixed(2)}%)` : ''}`);
    }

    store.set(LS.stockHistory, history);

    $('#stock-meta').textContent = `Schwelle ${threshold}% · ${new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(new Date())}`;

    // Notify
    if (alerts.length) {
      const allowed = typeof Notification !== 'undefined' && Notification.permission === 'granted';
      for (const a of alerts) {
        const body = `${a.label}: ${a.change > 0 ? '+' : ''}${a.change.toFixed(2)}% · ${formatPrice(a.currentPrice, a.currency)}`;
        if (allowed) {
          try { new Notification(`📈 ${a.p.symbol}: Schwelle überschritten`, { body, tag: `wl-stock-${a.p.symbol}` }); }
          catch {}
        }
        toast(`${a.p.symbol}: ${body}`, 'success', 6000);
      }
      if (!allowed) {
        toast(`${alerts.length} Aktien-Alerts (Browser-Benachrichtigungen nicht erlaubt)`, 'info', 5000);
      }
    } else {
      toast(`${portfolio.length} Aktien geprüft · keine Schwellen-Überschreitung`, 'success');
    }
    renderPortfolio();
    setProgress('Fertig', null, true);
  } catch (e) {
    console.error(e);
    setProgress('Fehler', null, true);
    toast(`Aktien-Check fehlgeschlagen: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// =============================================================================
// Issue 21: Text-to-Speech für das Briefing
// =============================================================================
//
// Der tools-server-Endpoint /speech/tts liefert MP3 (MPEG ADTS, layer III) für
// einen Text-Chunk. Längere Briefings werden in Stücke zerlegt, parallel
// synthetisiert und im Browser sequenziell abgespielt.
//
// Issue 31: zwei Bug-Fixes für lange 2×/3×-Briefings.
//   (1) `TTS_CHUNK_MAX` von 4000 → 3500 gesenkt. Der tools-server hat ein
//       hartes Pydantic-Limit von 4000 Zeichen, ABER aimlapi gpt-4o-mini-tts
//       wechselt schon bei ~3900 Zeichen unkalkulierbar auf einen
//       Async-Modus: statt MP3-Bytes kommt dann `{"detail":{"audio":{"url"…}}}`
//       als HTTP 201/JSON zurück. `api.tts()` folgt diesem Async-Modus jetzt
//       zwar (URL → Audio-Blob), aber der Synchron-Pfad ist schneller und
//       liefert konsistentere Audio-Qualität — 3500 hält Abstand zur Grenze.
//   (2) Statt die Chunks als ein einziges, oft kaputtes `Blob([…])` an das
//       HTML-Audio-Element zu hängen, halten wir die Chunk-Blob-URLs in einem
//       Array und spielen sie sequenziell über das `ended`-Event. Browser
//       brachen vorher bei zusammengeklebten MP3-Streams nach dem ersten
//       Chunk ab (Symptom: bei 2× nur die Hälfte, bei 3× nur ein Drittel).
//       Für den Download bleibt der zusammengeklebte Blob — OS-Player
//       (VLC, iTunes, Foobar2000) handhaben ADTS-Concat zuverlässig.

const TTS_CHUNK_MAX = 3500;
const TTS_CONCURRENCY = 3; // parallele TTS-Calls; aimlapi mag selten >5

// Aktueller TTS-Zustand pro renderNews-Aufruf; wird in resetTTSBar gesetzt.
const tts = {
  text: '',          // gerade angezeigter Briefing-Text
  textHash: '',      // Hash davon (Cache-Key)
  audioUrl: '',      // Object-URL für den konkatenierten Download-Blob
  audioBlob: null,   // konkatenierter MP3-Blob (Download)
  chunkUrls: [],     // Issue 31: Object-URLs pro Chunk für sequenziellen Play
  chunkIdx: 0,       // Issue 31: nächster zu spielender Chunk-Index
  generating: false,
  inited: false,     // wurden die Event-Listener schon einmal verdrahtet?
};

// Stabiler 32bit-Hash (FNV-1a) — reicht als Cache-Key.
function ttsHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// Splittet Text in ≤max-Zeichen-Stücke an Satz-/Absatz-Grenzen. Greedy: füllt
// den aktuellen Chunk bis kurz vor das Limit, schneidet bevorzugt an einem
// Absatzbruch, sonst Satzende, sonst Wortgrenze, im Notfall harter Cut.
function chunkTextForTTS(text, max = TTS_CHUNK_MAX) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const chunks = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = -1;
    if (cut < 0) {
      // Satzende: ., !, ? gefolgt von Whitespace
      const slice = rest.slice(0, max);
      const m = slice.match(/[.!?…][\s)\]"„“»]*(?=\s|$)/g);
      if (m && m.length) {
        const last = m[m.length - 1];
        const idx = slice.lastIndexOf(last);
        if (idx >= max * 0.5) cut = idx + last.length;
      }
    }
    if (cut < 0) {
      const idx = rest.lastIndexOf(' ', max);
      cut = idx >= max * 0.5 ? idx : max;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

// Verarbeitet eine Liste von Items mit fester Parallelität, behält Reihenfolge.
async function ttsMapWithConcurrency(items, fn, concurrency = TTS_CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

function ttsSetStatus(text) {
  const el = $('#tts-status');
  if (el) el.textContent = text || '';
}

// Räumt alte Audio-URL ab und versteckt Player/Download-Button — wird sowohl
// beim Render eines neuen Briefings als auch nach Fehlern aufgerufen.
function clearTTSAudio() {
  if (tts.audioUrl) {
    try { URL.revokeObjectURL(tts.audioUrl); } catch {}
    tts.audioUrl = '';
  }
  // Issue 31: Per-Chunk-URLs einzeln revoken — Memory-Leak verhindern.
  for (const u of tts.chunkUrls) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  tts.chunkUrls = [];
  tts.chunkIdx = 0;
  tts.audioBlob = null;
  const audio = $('#tts-audio');
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.removeAttribute('src');
    audio.load();
    audio.classList.add('hidden');
  }
  const dl = $('#btn-tts-download');
  if (dl) dl.classList.add('hidden');
}

// Wird aus renderNews() aufgerufen. Bindet einmalig die Click-Handler und
// resettet den Bar-Zustand auf den neuen Briefing-Text.
function resetTTSBar(text) {
  const bar = $('#tts-bar');
  if (!bar) return;
  const playBtn = $('#btn-tts-play');
  const dlBtn = $('#btn-tts-download');
  const audio = $('#tts-audio');
  if (!playBtn) return;

  // Briefing leer → Bar ausblenden, Audio aufräumen
  if (!text || !text.trim()) {
    bar.classList.add('hidden');
    clearTTSAudio();
    tts.text = '';
    tts.textHash = '';
    return;
  }
  bar.classList.remove('hidden');

  const nextHash = ttsHash(text);
  if (nextHash !== tts.textHash) {
    // Neuer Briefing-Text — alten Audio-Stand wegwerfen.
    clearTTSAudio();
  }
  tts.text = text;
  tts.textHash = nextHash;
  ttsSetStatus('');
  playBtn.disabled = false;

  if (tts.inited) return;
  tts.inited = true;

  playBtn.addEventListener('click', () => {
    if (tts.chunkUrls.length) {
      // Schon generiert — sequenziell vom ersten Chunk an abspielen.
      playTTSFromStart();
      return;
    }
    generateBriefingAudio().catch((e) => {
      console.error('TTS generate failed', e);
      ttsSetStatus(`Fehler: ${e.message || e}`);
      toast(`Audio-Generierung fehlgeschlagen: ${e.message || e}`, 'error');
      playBtn.disabled = false;
    });
  });

  dlBtn.addEventListener('click', () => {
    if (!tts.audioBlob) return;
    const a = document.createElement('a');
    a.href = tts.audioUrl;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `meine-news-briefing-${stamp}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

// Issue 31: spielt die zwischengespeicherten Chunk-URLs sequenziell ab.
// Jeder Chunk ist ein eigenständiges, sauberes MP3 — wir lassen den Browser
// also nicht durch einen zusammengeklebten Stream stolpern (Bug: ältere
// Variante stoppte nach dem ersten Chunk-Header). Stattdessen hängen wir an
// `ended` und setzen `audio.src` auf den nächsten Chunk.
function playTTSFromStart() {
  const audio = $('#tts-audio');
  if (!audio || !tts.chunkUrls.length) return;
  tts.chunkIdx = 0;
  audio.classList.remove('hidden');
  audio.onended = () => {
    tts.chunkIdx += 1;
    if (tts.chunkIdx < tts.chunkUrls.length) {
      ttsSetStatus(`Wiedergabe Chunk ${tts.chunkIdx + 1}/${tts.chunkUrls.length}…`);
      audio.src = tts.chunkUrls[tts.chunkIdx];
      audio.play().catch(() => {});
    } else {
      ttsSetStatus(`Fertig · ${tts.chunkUrls.length} Chunk${tts.chunkUrls.length === 1 ? '' : 's'}`);
    }
  };
  ttsSetStatus(`Wiedergabe Chunk 1/${tts.chunkUrls.length}…`);
  audio.src = tts.chunkUrls[0];
  audio.play().catch(() => {});
}

async function generateBriefingAudio() {
  const text = tts.text;
  if (!text) return;
  if (tts.generating) return;

  const playBtn = $('#btn-tts-play');
  const dlBtn = $('#btn-tts-download');
  const audio = $('#tts-audio');

  tts.generating = true;
  playBtn.disabled = true;
  dlBtn.classList.add('hidden');

  try {
    const chunks = chunkTextForTTS(text, TTS_CHUNK_MAX);
    if (!chunks.length) throw new Error('Briefing leer');
    ttsSetStatus(`Erzeuge Audio (0/${chunks.length} Chunks)…`);

    let done = 0;
    const blobs = await ttsMapWithConcurrency(chunks, async (chunk) => {
      const blob = await api.tts(chunk, { format: 'mp3' });
      done += 1;
      ttsSetStatus(`Erzeuge Audio (${done}/${chunks.length} Chunks)…`);
      return blob;
    });

    // Issue 31: alte URLs revoken bevor wir neue erzeugen.
    for (const u of tts.chunkUrls) { try { URL.revokeObjectURL(u); } catch {} }
    if (tts.audioUrl) { try { URL.revokeObjectURL(tts.audioUrl); } catch {} }

    // Pro-Chunk-URLs für die sequenzielle Wiedergabe — ein einzelner sauberer
    // MP3-Stream je `<audio>.src` vermeidet die Probleme der Browser mit
    // konkatenierten MP3-Headern (Symptom vor Issue 31: nach erstem Chunk Stop).
    tts.chunkUrls = blobs.map((b) => URL.createObjectURL(b));
    tts.chunkIdx = 0;

    // Konkatenierter Blob nur für den Download — funktioniert in OS-Playern
    // (VLC, iTunes, Foobar2000) zuverlässig, selbst wenn der Browser
    // bei der Wiedergabe an Frame-Grenzen stockt.
    const merged = new Blob(blobs, { type: 'audio/mpeg' });
    tts.audioBlob = merged;
    tts.audioUrl = URL.createObjectURL(merged);

    audio.classList.remove('hidden');
    dlBtn.classList.remove('hidden');
    ttsSetStatus(`Bereit · ${tts.chunkUrls.length} Chunk${tts.chunkUrls.length === 1 ? '' : 's'} · ${(merged.size / 1024).toFixed(0)} KB`);
    playTTSFromStart();
  } finally {
    tts.generating = false;
    playBtn.disabled = false;
  }
}

// =============================================================================
// Issue 24 — KI-Assistent mit RAG über alle gesammelten News
// =============================================================================
//
// Der Floating-Button unten rechts öffnet ein Chat-Panel. Bei jeder Frage:
//  1. Eine semantische Suche (`/tools/rag/query`) im persönlichen Namespace
//     liefert die Top-K passendsten News-/Event-/Kalender-Einträge.
//  2. Ein LLM-Call (api.llm — respektiert den Backend-Switch) bekommt die
//     Treffer als Kontext und die Conversation-History, antwortet in einem
//     Absatz mit konkreten Verweisen (Quelle, Datum).
//
// Indexiert wird am Ende jedes runSummarize-Runs (siehe indexNewsForAssistant).

const ASSISTANT_NAMESPACE_KEY = 'wl:assistantNamespace';
// Issue 44: Top-K leicht angehoben (12 → 16), weil der Index jetzt auch
// Chunks von Transkripten und Tiefenscan-Artikeln enthält. Bei 12 würden
// 2-3 Treffer pro Quelle den Großteil belegen, die thematische Breite litte.
const ASSISTANT_LIMIT = 16;

function assistantNamespace() {
  let ns = localStorage.getItem(ASSISTANT_NAMESPACE_KEY);
  if (!ns) {
    // Chroma-Namespace muss alphanumerisch sein und mit Buchstabe/Zahl
    // beginnen (siehe tools-server-Spec). Wir nehmen ein zufälliges Suffix,
    // damit zwei Browser am gleichen Server nichts vermischen.
    ns = 'wlmeinenews' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(ASSISTANT_NAMESPACE_KEY, ns);
  }
  return ns;
}

// Issue 44: stable hash für Chunk-IDs. Reine Funktion (kein Crypto-Call,
// kein Browser-API), damit auch alte iOS-Browser bedient sind.
function _ragShortHash(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

async function indexNewsForAssistant({
  items, events, buckets, weather,
  // Issue 44: zusätzliche Roh-Content-Pools für den RAG-Index. Jeder
  // Eintrag wird in 1200-Zeichen-Chunks gesplittet (mit 150 Overlap), damit
  // die semantische Suche in „dichten" News-Karten passende Stellen
  // findet, statt nur Titel/Kurzbeschreibung.
  transcripts,    // [{videoId, title, channel, url, date, text}]
  deepArticles,   // [{url, title, text, date, source, parentUrl, parentSource}]
  rssRaw,         // [{title, url, source, date, text}]
} = {}) {
  const ns = assistantNamespace();
  const documents = [];

  // News-Items (alle scoredItems — Karten in den Rubriken).
  for (const it of (items || [])) {
    if (!it || !it.title) continue;
    const id = `news:${(it.url || it.title).slice(0, 200)}`;
    const text = [
      `Titel: ${it.title}`,
      it.summary ? `Zusammenfassung: ${it.summary}` : null,
      it.snippet && it.snippet !== it.summary ? `Snippet: ${it.snippet}` : null,
      it.evidence ? `Evidenz: ${it.evidence}` : null,
      // Issue 32: Betroffenheits-Satz mit in den RAG-Text — sonst findet
      // der Assistent ihn nicht über semantische Suche.
      it.affectednessNote ? `Betroffenheit: ${it.affectednessNote}` : null,
      it.location ? `Ort: ${it.location}` : null,
      it.ytChannel ? `YouTube-Kanal: ${it.ytChannel}` : null,
    ].filter(Boolean).join('\n');
    documents.push({
      id,
      text,
      metadata: {
        kind: 'news',
        bucket: it.bucket || 'beobachten',
        title: it.title.slice(0, 200),
        url: it.url || '',
        date: it.date || '',
        source: it.source || sourceFromUrl(it.url) || '',
        origin: it.origin || '',
      },
    });
  }

  // Konkrete Events (mit echtem Datum + Ort).
  for (const e of (events || [])) {
    const title = e.title || e.event_name || '';
    const date = e.date || e.event_date || '';
    if (!title || !date) continue;
    const id = `event:${date}:${title.slice(0, 80)}`;
    const text = [
      `Event: ${title}`,
      `Datum: ${date}${(e.time || e.event_time) ? ' ' + (e.time || e.event_time) : ''}`,
      e.location || e.event_location ? `Ort: ${e.location || e.event_location}` : null,
      e.description || e.event_summary || e.summary ? `Beschreibung: ${e.description || e.event_summary || e.summary}` : null,
    ].filter(Boolean).join('\n');
    documents.push({
      id,
      text,
      metadata: {
        kind: 'event',
        title: title.slice(0, 200),
        date,
        location: (e.location || e.event_location || '').slice(0, 120),
        url: e.url || '',
        source: e.source || '',
      },
    });
  }

  // Kalender-Einträge (User-eigene Termine) — separater "kind", damit der
  // Assistent sie auch unabhängig vom letzten Run findet.
  for (const c of calendarStoreGet()) {
    if (!c || !c.title || !c.date) continue;
    const id = `calendar:${c.id || (c.date + '|' + c.title)}`;
    const text = [
      `Eigener Termin: ${c.title}`,
      `Datum: ${c.date}${c.time ? ' ' + c.time : ''}`,
      c.location ? `Ort: ${c.location}` : null,
      c.notes ? `Notizen: ${c.notes}` : null,
    ].filter(Boolean).join('\n');
    documents.push({
      id,
      text,
      metadata: {
        kind: 'calendar',
        title: c.title.slice(0, 200),
        date: c.date,
        location: (c.location || '').slice(0, 120),
        source: c.source || 'Mein Kalender',
      },
    });
  }

  // Wetter-Zusammenfassung — auch indexieren, damit "wie wird das Wetter?"
  // funktioniert.
  if (weather && weather.current) {
    const [, label] = describeWeatherCode(weather.current.weather_code);
    const text = `Wetter${weather.locationName ? ' in ' + weather.locationName : ''}: ${weather.current.temperature_2m}°C, ${label}.`;
    documents.push({
      id: 'weather:current',
      text,
      metadata: { kind: 'weather', date: new Date().toISOString().slice(0, 10) },
    });
  }

  // -------------------------------------------------------------------------
  // Issue 44: Roh-Texte chunken und mitindexieren
  // -------------------------------------------------------------------------

  // YouTube-Transkripte: pro Video Header + Chunks. Der Header enthält
  // Titel/Kanal/Datum (semantische Anker), die Chunks den eigentlichen
  // Transkript-Body. So findet eine Frage wie „Was hat Kanal X zu Thema Y
  // gesagt?" sowohl über Metadaten als auch über Body-Sätze.
  for (const t of (transcripts || [])) {
    if (!t || !t.text || !t.videoId) continue;
    const dateIso = t.date ? new Date(t.date).toISOString().slice(0, 10) : '';
    const chunks = chunkTextForRag(t.text, { target: 1200, overlap: 150, max: 12 });
    chunks.forEach((c, idx) => {
      documents.push({
        id: `transcript:${t.videoId}:${idx}`,
        text: [
          `YouTube-Transkript (Teil ${idx + 1}/${chunks.length}): „${t.title}"`,
          t.channel ? `Kanal: ${t.channel}` : null,
          dateIso ? `Veröffentlicht: ${dateIso}` : null,
          '',
          c,
        ].filter((v) => v !== null).join('\n'),
        metadata: {
          kind: 'transcript',
          videoId: t.videoId,
          title: (t.title || '').slice(0, 200),
          channel: (t.channel || '').slice(0, 120),
          url: t.url || '',
          date: dateIso,
          chunkIndex: idx,
          chunkTotal: chunks.length,
        },
      });
    });
  }

  // Tiefenscan-Artikel (Issue 44): vollständiger Artikel-Body als
  // Roh-Quelle. Wir chunken pro Artikel, damit semantische Suche sauber
  // greift.
  for (const a of (deepArticles || [])) {
    if (!a || !a.text || !a.url) continue;
    const idKey = _ragShortHash(a.url);
    const dateIso = a.date ? String(a.date).slice(0, 10) : '';
    const chunks = chunkTextForRag(a.text, { target: 1200, overlap: 150, max: 6 });
    chunks.forEach((c, idx) => {
      documents.push({
        id: `article:${idKey}:${idx}`,
        text: [
          `Artikel (Teil ${idx + 1}/${chunks.length}): „${a.title || a.source || a.url}"`,
          a.source ? `Quelle: ${a.source}` : null,
          dateIso ? `Datum: ${dateIso}` : null,
          a.parentSource ? `Gefunden über: ${a.parentSource}` : null,
          '',
          c,
        ].filter((v) => v !== null).join('\n'),
        metadata: {
          kind: 'article',
          title: (a.title || '').slice(0, 200),
          url: a.url,
          source: (a.source || '').slice(0, 120),
          date: dateIso,
          parentUrl: a.parentUrl || '',
          chunkIndex: idx,
          chunkTotal: chunks.length,
        },
      });
    });
  }

  // RSS-Rohdaten: Snippets sind kurz (~600 Zeichen), oft passen sie in
  // einen einzigen Eintrag. Wir indexieren sie, damit auch nicht-rangierte
  // RSS-Inhalte semantisch findbar sind (z.B. wenn der Scorer-Cap von 60
  // greift). Eindeutig, dass der Assistent nicht „nur die Top-Hits sieht",
  // sondern den vollen Sammlung-State.
  for (const r of (rssRaw || [])) {
    if (!r || !r.title || (!r.text && !r.url)) continue;
    const idKey = _ragShortHash(r.url || r.title);
    const dateIso = r.date ? String(r.date).slice(0, 10) : '';
    documents.push({
      id: `rss:${idKey}`,
      text: [
        `RSS-Item: ${r.title}`,
        r.source ? `Quelle: ${r.source}` : null,
        dateIso ? `Datum: ${dateIso}` : null,
        r.text ? '' : null,
        r.text ? r.text : null,
      ].filter((v) => v !== null).join('\n'),
      metadata: {
        kind: 'rss-raw',
        title: (r.title || '').slice(0, 200),
        url: r.url || '',
        source: (r.source || '').slice(0, 120),
        date: dateIso,
      },
    });
  }

  if (!documents.length) return { added: 0 };
  // Chunked-Upsert: bei >50 Dokumenten teilen wir auf, damit der LLM-Embed-
  // Batch nicht in Timeout läuft.
  const CHUNK = 50;
  let added = 0;
  for (let i = 0; i < documents.length; i += CHUNK) {
    const slice = documents.slice(i, i + CHUNK);
    try {
      await api.ragIndex({ namespace: ns, documents: slice, upsert: true });
      added += slice.length;
    } catch (e) {
      console.warn('rag index chunk failed', e);
    }
  }
  return { added };
}

const assistantState = {
  open: false,
  busy: false,
  history: [], // [{role:'user'|'assistant', content:string}]
  inited: false,
};

function loadAssistantHistory() {
  try {
    const arr = store.get(LS.assistantHistory, []);
    assistantState.history = Array.isArray(arr) ? arr.slice(-20) : [];
  } catch { assistantState.history = []; }
}
function saveAssistantHistory() {
  store.set(LS.assistantHistory, assistantState.history.slice(-20));
}

function renderAssistantLog() {
  const log = $('#assistant-log');
  if (!log) return;
  if (!assistantState.history.length) return;
  log.innerHTML = '';
  for (const msg of assistantState.history) {
    const isUser = msg.role === 'user';
    const row = document.createElement('div');
    row.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;
    const bubble = document.createElement('div');
    bubble.className = isUser
      ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-ember-500/20 text-ember-50 px-3 py-2 whitespace-pre-wrap break-words'
      : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-ink-700/70 text-slate-100 px-3 py-2 whitespace-pre-wrap break-words border border-white/10';
    bubble.textContent = msg.content;
    row.appendChild(bubble);
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

function assistantSetStatus(text) {
  const s = $('#assistant-status');
  if (s) s.textContent = text || 'Fragt euch durch alle gesammelten News (RAG).';
}

async function assistantAsk(question) {
  if (assistantState.busy) return;
  assistantState.busy = true;
  $('#btn-assistant-send').disabled = true;
  assistantSetStatus('Suche relevante News…');

  // User-Message anzeigen
  assistantState.history.push({ role: 'user', content: question });
  renderAssistantLog();

  try {
    const ns = assistantNamespace();
    let hits = [];
    try {
      const r = await api.ragQuery({ namespace: ns, q: question, top_k: ASSISTANT_LIMIT });
      hits = Array.isArray(r.results) ? r.results : [];
    } catch (e) {
      // Bei Namespace-leer / RAG-Server tot fallen wir auf den lokalen Cache zurück.
      console.warn('rag query failed', e);
    }

    let contextLines = [];
    if (hits.length) {
      contextLines = hits.map((h, i) => {
        const m = h.metadata || {};
        // Issue 44: Chunk-Index mit anzeigen, damit der LLM sieht, wenn er
        // mehrere Teile desselben Artikels/Transkripts vor sich hat. Außerdem
        // YouTube-Kanal explizit in der Meta-Zeile, damit Quellenangaben in
        // der Antwort möglich sind.
        const metaParts = [m.kind, m.bucket, m.date, m.location, m.channel, m.source].filter(Boolean);
        if (m.chunkIndex != null && m.chunkTotal > 1) {
          metaParts.push(`Teil ${m.chunkIndex + 1}/${m.chunkTotal}`);
        }
        const meta = metaParts.join(' · ');
        return `[${i + 1}] (${meta})\n${(h.text || '').trim()}${m.url ? `\nQuelle: ${m.url}` : ''}`;
      });
    } else {
      // Fallback: nimm einfach den lokalen Cache der letzten Übersicht.
      const cache = store.get(LS.cache, null);
      const items = cache && Array.isArray(cache.items) ? cache.items.slice(0, ASSISTANT_LIMIT) : [];
      contextLines = items.map((it, i) => {
        const meta = [it.bucket, it.date, it.location, it.source || sourceFromUrl(it.url)].filter(Boolean).join(' · ');
        return `[${i + 1}] (${meta})\nTitel: ${it.title}\n${(it.summary || it.snippet || '').slice(0, 400)}${it.url ? `\nQuelle: ${it.url}` : ''}`;
      });
      const events = cache && Array.isArray(cache.events) ? cache.events.slice(0, 6) : [];
      events.forEach((e, i) => {
        const title = e.title || e.event_name || '';
        const date = e.date || e.event_date || '';
        const loc = e.location || e.event_location || '';
        if (!title || !date) return;
        contextLines.push(`[E${i + 1}] (event · ${date} · ${loc})\nEvent: ${title}\n${e.description || e.event_summary || e.summary || ''}`);
      });
      if (!contextLines.length) {
        contextLines.push('(Keine News indexiert. Bitte zuerst „Zusammenfassen" klicken.)');
      }
    }

    assistantSetStatus('Frage Sprachmodell…');
    const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    const sys = `Du bist der persönliche News-Assistent des Users. Heute ist ${today}.

Du bekommst eine Frage und einen KONTEXT aus den News, Events und Kalendereinträgen des Users (semantisch gesuchte Top-Treffer). Antworte:
- DEUTSCH, 2-6 Sätze, konkret mit Eigennamen / Datum / Quelle.
- Nur auf Basis des Kontextes — keine Halluzinationen, keine spekulativen Aussagen.
- Wenn der Kontext die Frage nicht beantwortet, sag das KLAR ("In den indexierten News finde ich dazu nichts; vielleicht hilft ein neues ‚Zusammenfassen‘ oder eine konkretere Frage.").
- Wenn mehrere Treffer relevant sind, zähle sie kurz auf (max 5).
- Bei Events / Kalender-Terminen: nenne Datum + Ort.
- Verweise auf die Quelle in Klammern (Quellen-Domain), KEINE rohen URLs ausgeben.
- Kein Markdown, kein JSON, kein „Hier sind…" oder ähnliches Boilerplate.`;

    const userPrompt = `KONTEXT (Top-Treffer aus deinen News):
${contextLines.join('\n\n')}

USER-FRAGE:
${question}`;

    // Conversation-History mitgeben, damit Rückfragen Sinn ergeben.
    const messages = [];
    for (const m of assistantState.history.slice(-6, -1)) {
      messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: userPrompt });

    const res = await api.llm({
      system: sys,
      messages,
      temperature: 0.3,
      max_tokens: 700,
    });
    const reply = (res.reply || '').trim() || 'Ich konnte gerade keine Antwort formulieren — bitte nochmal versuchen.';
    assistantState.history.push({ role: 'assistant', content: reply });
    saveAssistantHistory();
    renderAssistantLog();
    assistantSetStatus(`${hits.length} Treffer aus dem Index verwendet.`);
  } catch (e) {
    console.error('assistant failed', e);
    assistantState.history.push({ role: 'assistant', content: `Fehler: ${e.message || e}` });
    saveAssistantHistory();
    renderAssistantLog();
    assistantSetStatus('Fehler beim KI-Aufruf — siehe Konsole.');
  } finally {
    assistantState.busy = false;
    $('#btn-assistant-send').disabled = false;
    const input = $('#assistant-input');
    if (input) input.focus();
  }
}

function openAssistant() {
  const panel = $('#assistant-panel');
  const btn = $('#btn-assistant-toggle');
  if (!panel) return;
  panel.classList.remove('hidden');
  if (btn) btn.classList.add('hidden');
  assistantState.open = true;
  const input = $('#assistant-input');
  if (input) setTimeout(() => input.focus(), 50);
  // Lazy Re-Index: wenn der User noch nie summarisiert hat, aber der Cache
  // schon was hat (alte Session), indexieren wir asynchron, damit RAG sofort
  // sinnvoll antwortet.
  const cache = store.get(LS.cache, null);
  if (cache && Array.isArray(cache.items) && cache.items.length) {
    indexNewsForAssistant({
      items: cache.items,
      events: cache.events || [],
      buckets: cache.buckets || null,
      weather: cache.weather || null,
    }).catch(() => {});
  }
}
function closeAssistant() {
  const panel = $('#assistant-panel');
  const btn = $('#btn-assistant-toggle');
  if (panel) panel.classList.add('hidden');
  if (btn) btn.classList.remove('hidden');
  assistantState.open = false;
}

function initAssistant() {
  if (assistantState.inited) return;
  assistantState.inited = true;

  loadAssistantHistory();
  renderAssistantLog();

  $('#btn-assistant-toggle').addEventListener('click', openAssistant);
  $('#btn-assistant-close').addEventListener('click', closeAssistant);
  $('#btn-assistant-clear').addEventListener('click', () => {
    assistantState.history = [];
    saveAssistantHistory();
    const log = $('#assistant-log');
    if (log) {
      log.innerHTML = `<div class="text-xs text-slate-400">Verlauf gelöscht. Stell eine neue Frage.</div>`;
    }
  });
  $('#assistant-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#assistant-input');
    const q = (input.value || '').trim();
    if (!q || assistantState.busy) return;
    input.value = '';
    assistantAsk(q);
  });
}

// =============================================================================
// Init
// =============================================================================

function setHeaderDate() {
  const d = new Date();
  $('#header-date').textContent = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}

function initBootCache() {
  const cache = store.get(LS.cache, null);
  renderNews(cache);
}

document.addEventListener('DOMContentLoaded', () => {
  setHeaderDate();
  initTabs();
  initSetup();
  initMic();
  initPortfolio();
  initUpload();
  initBootCache();
  initAssistant();

  $('#btn-summarize').addEventListener('click', runSummarize);
  $('#btn-stocks').addEventListener('click', runStockCheck);

  // Initial leerer Zustand wenn nichts gecached
  const cache = store.get(LS.cache, null);
  if (!cache) $('#empty-state').classList.remove('hidden');
});
