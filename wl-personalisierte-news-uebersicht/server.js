/**
 * Wunderlampe News — Backend-Proxy
 *
 * Schmaler Adapter zwischen Browser und dem loopback-only tools-server
 * (127.0.0.1:8780). Bietet zusätzlich einen RSS-Endpoint, weil der
 * tools-server kein RSS spricht (Trafilatura ist auf Artikel ausgelegt,
 * nicht auf Feed-XML).
 *
 *   GET  /api/health             → simple liveness
 *   GET  /api/rss?url=...        → parst RSS/Atom-Feed
 *   POST /api/llm/chat           → direkter aimlapi-Call (Issue 42)
 *   *    /api/tools/<sub>        → proxiet 1:1 nach 127.0.0.1:8780/<sub>
 *
 * Keys werden bewusst NICHT clientseitig benötigt: tools-server hängt
 * den AIMLAPI_KEY auf Server-Seite an LLM-Calls dran. Für Issue 42 hat
 * `server.js` zusätzlich seinen eigenen AIMLAPI_KEY (aus
 * /root/.secrets/api-keys.env), damit `/api/llm/chat` direkt gegen
 * aimlapi.com/v1 sprechen kann — nötig für Gemini 2.5 Flash, das pro
 * Call ~1500-2200 Reasoning-Tokens verbraucht und über das tools-server-
 * Schema (festes max_tokens-Mapping) leere Antworten produzierte.
 */
'use strict';

const express = require('express');
const Parser = require('rss-parser');
const { YoutubeTranscript } = require('youtube-transcript');
const fs = require('fs');
const path = require('path');

const TOOLS = process.env.TOOLS_URL || 'http://127.0.0.1:8780';
const PORT = parseInt(process.env.PORT || '3782', 10);
const HOST = process.env.HOST || '127.0.0.1';

// Issue 42: AIMLAPI-Key wird aus /root/.secrets/api-keys.env geladen (mode
// 600, root-only). Wir parsen die Datei manuell (KEY=value pro Zeile), um
// keine zusätzliche dotenv-Dependency einzuziehen. Wenn der Key fehlt,
// startet der Server trotzdem — der direkte LLM-Endpoint antwortet dann
// mit 500, alles andere (tools-server-Proxy, RSS, PubMed, …) bleibt
// funktional.
const SECRETS_PATH = process.env.SECRETS_PATH || '/root/.secrets/api-keys.env';
let AIMLAPI_KEY = process.env.AIMLAPI_KEY || '';
if (!AIMLAPI_KEY) {
  try {
    const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*AIMLAPI_KEY\s*=\s*(.+?)\s*$/);
      if (m) { AIMLAPI_KEY = m[1].replace(/^['"]|['"]$/g, ''); break; }
    }
  } catch (e) { /* Datei nicht lesbar — Key bleibt leer, /api/llm/chat 500et */ }
}
const AIMLAPI_BASE = process.env.AIMLAPI_BASE || 'https://api.aimlapi.com/v1';
const LLM_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
// Issue 42: Gemini 2.5 Flash ist ein Reasoning-Modell (Google's "thinking" /
// reasoning-tokens). Empirisch braucht es ~1500-2200 Tokens für internes
// Reasoning, BEVOR es überhaupt anfängt, sichtbaren Content auszugeben.
// aimlapi unterstützt KEIN reasoning_effort/thinking_budget für Gemini
// (mehrere Varianten getestet: thinking_budget, thinking_config,
// reasoning.effort, google.thinkingConfig — alle ignoriert). Einziger
// zuverlässiger Workaround: max_tokens großzügig erhöhen, damit nach dem
// Reasoning genug Budget für die eigentliche Antwort übrig bleibt. Wir
// addieren auf den vom Aufrufer angefragten Wert einen festen Reasoning-
// Headroom drauf. 3500 hat in Tests bei allen Prompts ≥1 Satz Output
// zuverlässig produziert (oft 2000-2200 reasoning_tokens).
const GEMINI_REASONING_HEADROOM_TOKENS = 3500;
const LLM_REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS, 10) || 180000;

// Issue 24: YouTube-Transkript-Cache. Captions sind teure HTTP-Scrapes gegen
// YouTube (Throttle-Risiko, gelegentliche 429er), und derselbe Video-Run
// kommt im typischen Tagesfluss mehrfach vor: User klickt mehrmals am Tag
// „Zusammenfassen", oder Browser refresht. Wir cachen pro `videoId|lang`-Key
// die Antwort sowohl in-memory (heißer Pfad) als auch auf Disk (überlebt den
// pm2/systemd-Restart). TTL: 7 Tage — passt zum YouTube-Lookback-Fenster
// von 5 Tagen (siehe app.js YOUTUBE_MAX_LOOKBACK_MS), mit Puffer.
const YT_CACHE_DIR = process.env.YT_CACHE_DIR || path.join(__dirname, '.yt-transcript-cache');
const YT_CACHE_TTL_MS = parseInt(process.env.YT_CACHE_TTL_MS, 10) || (7 * 24 * 3600 * 1000);
const _ytTranscriptMem = new Map(); // key → {payload, ts}
try { fs.mkdirSync(YT_CACHE_DIR, { recursive: true }); } catch (e) { /* directory bereits da oder readonly fs */ }

function ytCacheKey(videoId, langList) {
  const norm = (langList || []).map((s) => s.trim().toLowerCase()).filter(Boolean).sort().join(',');
  return `${videoId}__${norm || 'default'}`;
}
function ytCacheFile(key) {
  // Key besteht aus [A-Za-z0-9_,-] — safe als Dateiname.
  return path.join(YT_CACHE_DIR, `${key.replace(/[^A-Za-z0-9_,-]/g, '_')}.json`);
}
function ytCacheGet(key) {
  const mem = _ytTranscriptMem.get(key);
  if (mem && (Date.now() - mem.ts) < YT_CACHE_TTL_MS) return mem.payload;
  // Disk-Fallback
  try {
    const file = ytCacheFile(key);
    const stat = fs.statSync(file);
    if ((Date.now() - stat.mtimeMs) > YT_CACHE_TTL_MS) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const payload = JSON.parse(raw);
    _ytTranscriptMem.set(key, { payload, ts: stat.mtimeMs });
    return payload;
  } catch { return null; }
}
function ytCacheSet(key, payload) {
  _ytTranscriptMem.set(key, { payload, ts: Date.now() });
  try {
    fs.writeFileSync(ytCacheFile(key), JSON.stringify(payload));
  } catch (e) { /* Disk-Persistenz best-effort */ }
}
const UA = 'Mozilla/5.0 (compatible; WunderlampeNews/0.1; +https://test.svenforstmann.com)';
// Issue 10: Mehr Browser-ähnlicher UA für YouTube-HTML-Scraping, der RSS-Default-UA
// genügt nicht — YouTube liefert sonst eine schmale Mobile-Variante ohne canonical-Link.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const rss = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
});

const app = express();
app.disable('x-powered-by');

// Same-origin in production; CORS hier nur, damit lokales Frontend-Debugging
// (z.B. file://) ohne Drama läuft.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'wunderlampe-news', tools: TOOLS, ts: Date.now() });
});

// ---------------------------------------------------------------------------
// Issue 28: Server-Proxy für Open-Meteo UV-Index (vorher Issue 27 direkt aus
// dem Browser gefetcht — bricht bei Ad-Blockern, restriktiven CSPs und
// einigen Corporate-Firewalls. Symptom: Wetter-Pfad warf eine unbehandelte
// Exception, die hochblubbern konnte und runSummarize abbrach). Same-Origin-
// Proxy umgeht das komplett.
// ---------------------------------------------------------------------------
app.get('/api/uv-index', async (req, res) => {
  const lat = typeof req.query.lat === 'string' ? req.query.lat : '';
  const lng = typeof req.query.lng === 'string' ? req.query.lng : '';
  const timezone = typeof req.query.timezone === 'string' ? req.query.timezone : 'Europe/Berlin';
  const days = parseInt(req.query.days, 10) || 3;
  if (!/^-?\d+(\.\d+)?$/.test(lat) || !/^-?\d+(\.\d+)?$/.test(lng)) {
    return res.status(400).json({ ok: false, error: 'bad-coords' });
  }
  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lng,
      current: 'uv_index',
      daily: 'uv_index_max',
      timezone,
      forecast_days: String(Math.max(1, Math.min(7, days))),
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: ctrl.signal });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'open-meteo-failed', status: r.status });
      const data = await r.json();
      res.json({ ok: true, current: data.current || null, daily: data.daily || null });
    } finally { clearTimeout(t); }
  } catch (e) {
    res.status(502).json({ ok: false, error: 'uv-fetch-failed', message: String(e && e.message ? e.message : e) });
  }
});

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------
app.get('/api/rss', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'bad-url', message: 'Erwarte ?url=https://…' });
  }
  try {
    const feed = await rss.parseURL(url);
    const items = (feed.items || []).slice(0, 30).map((it) => ({
      title: (it.title || '').trim(),
      link: it.link || '',
      isoDate: it.isoDate || it.pubDate || '',
      contentSnippet: (it.contentSnippet || it.content || '').replace(/\s+/g, ' ').slice(0, 600),
      creator: it.creator || it.author || '',
      categories: it.categories || [],
    }));
    res.json({ ok: true, title: feed.title || url, link: feed.link || '', description: feed.description || '', items });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'rss-fetch-failed', url, message: String(e && e.message ? e.message : e) });
  }
});

// ---------------------------------------------------------------------------
// Issue 10: YouTube — Channel-Auflösung, Video-Liste, Transkript
// ---------------------------------------------------------------------------
//
// `youtube-transcript` (npm) holt die Caption-Tracks direkt von YouTube ohne
// API-Key. Die Video-Liste pro Kanal kommt aus dem öffentlichen Atom-Feed
// `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`. Für @handle- /
// /c/- / /user/-URLs scrapen wir die HTML-Seite und ziehen aus dem
// `<link rel="canonical" href="…/channel/UC…">` die Channel-ID raus.

const _channelIdCache = new Map(); // url|handle → {channelId, channelTitle, ts}
const CHANNEL_CACHE_TTL_MS = 24 * 3600 * 1000;

function normalizeChannelInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // Wenn schon direkte channel_id (UC…), nimm sie.
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return { type: 'id', value: s, url: `https://www.youtube.com/channel/${s}` };
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); }
  catch { return null; }
  // Pfad-Parsing
  const path = u.pathname.replace(/^\/+/, '');
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'channel' && /^UC[A-Za-z0-9_-]{20,}$/.test(seg[1] || '')) {
    return { type: 'id', value: seg[1], url: `https://www.youtube.com/channel/${seg[1]}` };
  }
  // /@handle, /c/name, /user/name → muss aufgelöst werden
  if (/^@/.test(seg[0] || '') || seg[0] === 'c' || seg[0] === 'user') {
    return { type: 'scrape', value: u.toString(), url: u.toString() };
  }
  // Bare @handle ohne Pfad
  if (/^@[A-Za-z0-9._-]+$/.test(s)) {
    return { type: 'scrape', value: `https://www.youtube.com/${s}`, url: `https://www.youtube.com/${s}` };
  }
  // Fallback: behandele als ganze URL und versuche Scrape
  return { type: 'scrape', value: u.toString(), url: u.toString() };
}

async function resolveChannelId(input) {
  const norm = normalizeChannelInput(input);
  if (!norm) throw new Error('bad-input');
  const cacheKey = norm.value;
  const hit = _channelIdCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CHANNEL_CACHE_TTL_MS) return hit;

  if (norm.type === 'id') {
    const out = { channelId: norm.value, channelTitle: '', ts: Date.now() };
    _channelIdCache.set(cacheKey, out);
    return out;
  }

  // Scrape canonical link
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let html = '';
  try {
    const r = await fetch(norm.value, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.8,de;q=0.6' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`http-${r.status}`);
    html = await r.text();
  } finally { clearTimeout(t); }

  const canon = html.match(/<link rel="canonical"\s+href="https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})"/);
  const channelId = canon ? canon[1] : null;
  if (!channelId) throw new Error('channel-id-not-found');
  // Titel best-effort aus <title>
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  let channelTitle = titleMatch ? titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, '').trim() : '';
  const out = { channelId, channelTitle, ts: Date.now() };
  _channelIdCache.set(cacheKey, out);
  return out;
}

// Ein eigener Parser-Slot für YouTube-Atom — das custom-Schema `yt:videoId`
// brauchen wir, um zuverlässig die Video-IDs zu kriegen.
const ytRss = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': UA, Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
  customFields: {
    item: [['yt:videoId', 'videoId'], ['media:group', 'mediaGroup']],
  },
});

// GET /api/youtube/videos?url=…&sinceMs=…&maxAgeMs=…
//   → { ok, channelId, channelTitle, videos: [{videoId, title, link, published, description}] }
// Filter: nur Videos mit published >= max(sinceMs, now-maxAgeMs); default
// maxAgeMs entspricht dem Issue-16-Cap von 5 Tagen (war Issue 10: 3 Tage).
app.get('/api/youtube/videos', async (req, res) => {
  const input = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const sinceMs = parseInt(req.query.sinceMs, 10) || 0;
  const maxAgeMs = parseInt(req.query.maxAgeMs, 10) || (5 * 24 * 3600 * 1000);
  if (!input) return res.status(400).json({ ok: false, error: 'bad-input', message: 'Erwarte ?url=https://www.youtube.com/@…' });
  try {
    const { channelId, channelTitle } = await resolveChannelId(input);
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const feed = await ytRss.parseURL(feedUrl);
    const cutoff = Math.max(sinceMs || 0, Date.now() - maxAgeMs);
    const videos = (feed.items || []).map((it) => {
      const publishedTs = it.isoDate ? Date.parse(it.isoDate) : (it.pubDate ? Date.parse(it.pubDate) : NaN);
      const desc = (it.mediaGroup && it.mediaGroup['media:description'] && it.mediaGroup['media:description'][0]) || '';
      return {
        videoId: it.videoId || (it.link || '').split('v=')[1] || '',
        title: (it.title || '').trim(),
        link: it.link || '',
        published: it.isoDate || it.pubDate || '',
        publishedTs: isNaN(publishedTs) ? 0 : publishedTs,
        description: typeof desc === 'string' ? desc.slice(0, 1500) : '',
      };
    }).filter((v) => v.videoId && v.publishedTs >= cutoff);
    res.json({ ok: true, channelId, channelTitle: channelTitle || feed.title || channelId, feedTitle: feed.title || '', videos });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'youtube-videos-failed', url: input, message: String(e && e.message ? e.message : e) });
  }
});

// GET /api/youtube/transcript?videoId=…&lang=de,en
//   → { ok, videoId, text, lang, segments }
// Fällt durch die `lang`-Liste, nimmt das erste Transkript, das verfügbar ist.
// Wenn nichts passt, versucht YoutubeTranscript ohne `lang` (Default-Track).
app.get('/api/youtube/transcript', async (req, res) => {
  const videoId = typeof req.query.videoId === 'string' ? req.query.videoId.trim() : '';
  const langList = (typeof req.query.lang === 'string' ? req.query.lang : 'de,en').split(',').map((s) => s.trim()).filter(Boolean);
  if (!videoId || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
    return res.status(400).json({ ok: false, error: 'bad-videoId' });
  }

  // Issue 24: Cache-Lookup. Wenn frisch, sofort zurückgeben — kein
  // YouTube-Scrape, kein Throttle-Risiko, ~0ms Latenz.
  const cacheKey = ytCacheKey(videoId, langList);
  const cached = ytCacheGet(cacheKey);
  if (cached && cached.ok) {
    return res.json({ ...cached, cached: true });
  }
  // Negative-Cache (auch das ist eine Info: "dieses Video hat kein
  // Transkript"). TTL gleich — verhindert, dass wir bei jedem Run wieder
  // versuchen, ein nicht-existentes Transkript zu scrapen.
  if (cached && cached.ok === false) {
    return res.status(404).json({ ...cached, cached: true });
  }

  const attempts = [...langList.map((l) => ({ lang: l })), {}];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId, opts);
      if (!segments || !segments.length) continue;
      const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
      const payload = {
        ok: true,
        videoId,
        lang: opts.lang || (segments[0] && segments[0].lang) || '',
        text,
        segments: segments.length,
      };
      ytCacheSet(cacheKey, payload);
      return res.json(payload);
    } catch (e) { lastErr = e; }
  }
  const errPayload = {
    ok: false,
    error: 'transcript-unavailable',
    videoId,
    message: String(lastErr && lastErr.message ? lastErr.message : lastErr || 'no-transcript'),
  };
  ytCacheSet(cacheKey, errPayload);
  res.status(404).json(errPayload);
});

// ---------------------------------------------------------------------------
// Issue 38: PubMed-Studien-Suche via NCBI E-utilities (ESearch + EFetch).
//
// Der zentrale tools-server (Port 8780) hat aktuell kein PubMed-Tool. Wir
// implementieren den Adapter hier lokal, weil:
//   - PubMed E-utilities ist key-frei (NCBI bittet nur um `tool`+`email` als
//     Identifikation, kein Auth-Header). Damit gibt es kein Secret-Problem.
//   - NCBI verlangt 3 req/s Limit ohne API-Key — wir batchen ohnehin nur 3-4
//     Queries pro „Zusammenfassen"-Klick.
//   - XML-Parsing (ohne neue Lib) bleibt im Backend, der Browser kriegt JSON.
//
// Endpoint: GET /api/pubmed/search?q=<query>&max=<N>&days=<N>
//   q     — PubMed-Suchanfrage (englisch funktioniert am zuverlässigsten;
//           PubMed indexiert primär englischsprachige biomedizinische Literatur).
//   max   — Max. Treffer pro Query (Default 8, hartes Limit 20).
//   days  — Datum-Fenster in Tagen rückblickend (Default 7, hartes Limit 30).
//           Auf den Tag genau ausgewertet via `datetype=pdat`+`mindate`+`maxdate`.
//
// Antwort: { ok, query, days, results: [{pmid, title, abstract, journal,
//                                         pubdate, authors[], url}] }
// ---------------------------------------------------------------------------
const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_TOOL = 'wunderlampe-news';
const PUBMED_EMAIL = process.env.PUBMED_EMAIL || 'sternentraeumer@gmail.com';

app.get('/api/pubmed/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
  const max = Math.max(1, Math.min(20, parseInt(req.query.max, 10) || 8));
  if (!q) return res.status(400).json({ ok: false, error: 'bad-query', message: 'Erwarte ?q=…' });
  try {
    // 1) ESearch — PMIDs für die Query holen, hart auf Pub-Date-Fenster geklemmt.
    const fmt = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const fromDate = new Date(Date.now() - days * 86400000);
    const esParams = new URLSearchParams({
      db: 'pubmed',
      term: q,
      retmax: String(max),
      retmode: 'json',
      // pdat = "Date - Publication". Pubmed kennt auch `edat` (Entry-Date) —
      // für „was wurde wann veröffentlicht?" ist pdat die richtige Wahl.
      datetype: 'pdat',
      mindate: fmt(fromDate),
      maxdate: fmt(today),
      sort: 'pub_date',
      tool: PUBMED_TOOL,
      email: PUBMED_EMAIL,
    });
    const esCtrl = new AbortController();
    const esT = setTimeout(() => esCtrl.abort(), 15000);
    let ids = [];
    try {
      const esRes = await fetch(`${PUBMED_BASE}/esearch.fcgi?${esParams}`, {
        headers: { 'User-Agent': `${PUBMED_TOOL} (+${PUBMED_EMAIL})` },
        signal: esCtrl.signal,
      });
      if (!esRes.ok) {
        return res.status(502).json({ ok: false, error: 'esearch-failed', status: esRes.status });
      }
      const esData = await esRes.json();
      ids = (esData && esData.esearchresult && Array.isArray(esData.esearchresult.idlist))
        ? esData.esearchresult.idlist : [];
    } finally { clearTimeout(esT); }

    if (!ids.length) {
      return res.json({ ok: true, query: q, days, max, results: [] });
    }

    // 2) EFetch — vollständige Datensätze als XML (PubMed-Standardformat).
    // Wir parsen mit Regex, weil die Strukturen flach genug sind und wir
    // keine zusätzliche XML-Lib einführen wollen (saml/xml2js/etc.). Bei
    // unbekannten/abweichenden Feldern bleiben sie leer — fail-open.
    const efParams = new URLSearchParams({
      db: 'pubmed',
      id: ids.join(','),
      retmode: 'xml',
      tool: PUBMED_TOOL,
      email: PUBMED_EMAIL,
    });
    const efCtrl = new AbortController();
    const efT = setTimeout(() => efCtrl.abort(), 20000);
    let xml = '';
    try {
      const efRes = await fetch(`${PUBMED_BASE}/efetch.fcgi?${efParams}`, {
        headers: { 'User-Agent': `${PUBMED_TOOL} (+${PUBMED_EMAIL})` },
        signal: efCtrl.signal,
      });
      if (!efRes.ok) {
        return res.status(502).json({ ok: false, error: 'efetch-failed', status: efRes.status });
      }
      xml = await efRes.text();
    } finally { clearTimeout(efT); }

    const results = parsePubmedXml(xml);
    // Reihenfolge stabilisieren: PubMed sortiert ESearch nach pub_date desc,
    // EFetch gibt die Records in derselben ID-Reihenfolge zurück. Wir
    // sortieren noch einmal nach pubdate desc als Sicherheitsnetz.
    results.sort((a, b) => String(b.pubdate || '').localeCompare(String(a.pubdate || '')));
    res.json({ ok: true, query: q, days, max, results });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: 'pubmed-failed',
      message: String(e && e.message ? e.message : e),
    });
  }
});

function parsePubmedXml(xml) {
  const out = [];
  // PubmedArticle UND PubmedBookArticle existieren — wir nehmen aktuell nur
  // die regulären Artikel (Bücher haben andere Struktur, ist für die App
  // ohnehin uninteressant — der User will Studien-Updates).
  const articleRe = /<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g;
  let m;
  while ((m = articleRe.exec(xml)) !== null) {
    const block = m[0];
    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch ? pmidMatch[1] : '';
    const titleMatch = block.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/);
    const title = titleMatch ? stripPubmedXml(titleMatch[1]).trim() : '';
    // Abstracts können in mehrere <AbstractText Label="BACKGROUND">… aufgeteilt
    // sein — wir joinen sie, optional mit dem Label als Prefix.
    const absChunks = [];
    const absRe = /<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g;
    let am;
    while ((am = absRe.exec(block)) !== null) {
      const attrs = am[1] || '';
      const txt = stripPubmedXml(am[2]).trim();
      if (!txt) continue;
      const labelMatch = attrs.match(/Label="([^"]+)"/);
      if (labelMatch) absChunks.push(`${labelMatch[1]}: ${txt}`);
      else absChunks.push(txt);
    }
    const abstractText = absChunks.join(' ').replace(/\s+/g, ' ').trim();
    const jrMatch = block.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/);
    const journal = jrMatch ? stripPubmedXml(jrMatch[1]).trim() : '';
    const pdMatch = block.match(/<PubDate>([\s\S]*?)<\/PubDate>/);
    let pubdate = '';
    if (pdMatch) {
      const inner = pdMatch[1];
      const y = (inner.match(/<Year>(\d{4})<\/Year>/) || [])[1];
      const mo = (inner.match(/<Month>([\w\d]+)<\/Month>/) || [])[1];
      const dy = (inner.match(/<Day>(\d{1,2})<\/Day>/) || [])[1];
      pubdate = buildPubmedIsoDate(y, mo, dy);
    }
    // Bis zu 3 Autoren — Nachname reicht für die Kurz-Anzeige.
    const authors = [];
    const authRe = /<Author\b[\s\S]*?<\/Author>/g;
    let aa;
    while ((aa = authRe.exec(block)) !== null && authors.length < 3) {
      const blockAuthor = aa[0];
      const lastName = (blockAuthor.match(/<LastName>([\s\S]*?)<\/LastName>/) || [])[1];
      if (lastName) authors.push(stripPubmedXml(lastName).trim());
    }
    if (pmid && title) {
      out.push({
        pmid,
        title,
        abstract: abstractText,
        journal,
        pubdate,
        authors,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      });
    }
  }
  return out;
}

function stripPubmedXml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function buildPubmedIsoDate(y, m, d) {
  if (!y) return '';
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const mm = /^\d+$/.test(m || '') ? String(m).padStart(2, '0') : (months[m] || '01');
  const dd = /^\d+$/.test(d || '') ? String(d).padStart(2, '0') : '01';
  return `${y}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Issue 42: Direkter LLM-Endpoint gegen aimlapi.com/v1
//
// Vorher lief jeder Browser-LLM-Call über `/api/tools/llm/chat` →
// 127.0.0.1:8780 (tools-server) → aimlapi. Der tools-server akzeptiert nur
// ein festes Param-Schema (`messages, system, model, temperature,
// max_tokens`) — alle anderen Provider-spezifischen Tuning-Parameter werden
// gestripped. Das ist für DeepSeek/Qwen/Nemotron/Grok unproblematisch, aber
// für Gemini 2.5 Flash tödlich: das Modell verbrennt 1500-2200 Tokens für
// internes Reasoning (Google "thinking"), bevor es überhaupt Output
// generiert. Mit dem App-Default `max_tokens=2200` bleibt nach dem Reasoning
// 0-200 Tokens für die Antwort übrig → leerer/abgeschnittener Reply.
//
// User-Auftrag: dem funktionierenden Python-Snippet entsprechen, das direkt
// gegen `https://api.aimlapi.com/v1` spricht. Dieser Endpoint repliziert
// genau das Muster (OpenAI-kompatibel, Bearer-Auth) und passt für Gemini
// 2.5 Flash das `max_tokens` automatisch nach oben an, damit Reasoning +
// User-Output beide Platz haben.
//
// Body 1:1 wie der tools-server-Endpoint: { messages, system?, model?,
// temperature?, max_tokens? }. Antwort ebenfalls identisch: { reply, model,
// usage } — damit `__llmInvoke` im Browser nichts anpassen muss außer der
// Pfad-Wahl.
// ---------------------------------------------------------------------------
app.post('/api/llm/chat', express.json({ limit: '4mb' }), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = typeof body.system === 'string' ? body.system : '';
  const model = (typeof body.model === 'string' && body.model.trim()) || LLM_DEFAULT_MODEL;
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.4;
  const requestedMaxTokens = parseInt(body.max_tokens, 10) || 2200;

  if (!AIMLAPI_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'aimlapi-key-missing',
      message: `AIMLAPI_KEY nicht gesetzt (geprüft: env + ${SECRETS_PATH}).`,
    });
  }
  if (!messages.length) {
    return res.status(400).json({ ok: false, error: 'bad-body', message: 'Erwarte messages:[…]' });
  }

  // Issue 42: Reasoning-Headroom für Gemini 2.5 Flash dazuaddieren. Andere
  // Modelle bekommen den User-Wert 1:1 (kein versehentliches Token-Inflate,
  // kein Quota-Risiko bei kleinen Classifier-Calls).
  let effectiveMaxTokens = requestedMaxTokens;
  if (/^google\/gemini-2\.5/i.test(model)) {
    effectiveMaxTokens = requestedMaxTokens + GEMINI_REASONING_HEADROOM_TOKENS;
  }

  // OpenAI-kompatibler Body. System-Prompt als erste system-message
  // dazustellen — exakt wie der tools-server das macht und wie das
  // funktionierende Python-Snippet aus dem Issue.
  const oaMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  const upstreamBody = {
    model,
    messages: oaMessages,
    temperature,
    max_tokens: effectiveMaxTokens,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch { /* noop */ } }, LLM_REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${AIMLAPI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIMLAPI_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
    const text = await upstream.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }

    if (!upstream.ok) {
      // aimlapi-Status durchreichen, damit das clientseitige Retry-Schema
      // (429/5xx → backoff) unverändert greift.
      return res.status(upstream.status).json({
        ok: false,
        error: 'aimlapi-error',
        status: upstream.status,
        body: data,
      });
    }

    // Same shape as tools-server: { reply, model, usage }.
    const choice = data && Array.isArray(data.choices) && data.choices[0] ? data.choices[0] : null;
    const reply = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content : '';
    res.json({
      reply,
      model: data && data.model ? data.model : model,
      usage: data && data.usage ? data.usage : null,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: 'llm-timeout',
        message: `aimlapi-Call abgebrochen nach ${LLM_REQUEST_TIMEOUT_MS}ms`,
      });
    }
    res.status(502).json({
      ok: false,
      error: 'llm-failed',
      message: String(e && e.message ? e.message : e),
    });
  } finally {
    clearTimeout(t);
  }
});

// ---------------------------------------------------------------------------
// Generic tools-server proxy (streaming, multipart-safe)
// ---------------------------------------------------------------------------
app.all('/api/tools/*', async (req, res) => {
  // /api/tools/web/search?q=x → /web/search?q=x
  const subpath = req.url.replace(/^\/api\/tools/, '') || '/';
  const upstream = TOOLS + subpath;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
    headers[k] = v;
  }
  headers['user-agent'] = UA;

  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = req;
    init.duplex = 'half';
  }

  try {
    const upRes = await fetch(upstream, init);
    res.status(upRes.status);
    upRes.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (lk === 'transfer-encoding' || lk === 'content-encoding' || lk === 'content-length') return;
      res.setHeader(key, value);
    });
    if (!upRes.body) return res.end();
    const reader = upRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: 'proxy-failed', upstream, message: String(e && e.message ? e.message : e) });
    } else {
      res.end();
    }
  }
});

// Fallback 404 für /api/* (alles andere darf nginx/wunderlampe übernehmen)
app.use('/api', (_req, res) => res.status(404).json({ error: 'not-found' }));

app.listen(PORT, HOST, () => {
  console.log(`[wunderlampe-news] listening on ${HOST}:${PORT}, tools=${TOOLS}`);
});
