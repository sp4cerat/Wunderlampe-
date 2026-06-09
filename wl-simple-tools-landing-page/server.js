// Simple Tools — Express backend.
// Static files in /public, tool pages in /public/tools, index.html at repo root.
// Backend endpoints under /api/* for things that need server-side libs.

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const MarkdownIt = require('markdown-it');
const { customAlphabet } = require('nanoid');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const shortId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 7);

// Limits: total upload up to 30 MB per request, single field up to 25 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 25 }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Static: index.html at root, /public for everything else.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Allow `/tools/json-formatter` (no extension) to resolve.
app.use('/tools', express.static(path.join(__dirname, 'public/tools'), { extensions: ['html'] }));

// ---------------------------------------------------------------------------
// URL shortener — simple JSON file storage. Keys expire after `ttlHours`.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, '{}');

async function readLinks() {
  try {
    const raw = await fsp.readFile(LINKS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch { return {}; }
}
async function writeLinks(map) {
  await fsp.writeFile(LINKS_FILE, JSON.stringify(map, null, 2));
}
async function pruneExpired() {
  const links = await readLinks();
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(links)) {
    if (v.expiresAt && v.expiresAt < now) { delete links[k]; changed = true; }
  }
  if (changed) await writeLinks(links);
  return links;
}

app.post('/api/shorten', async (req, res) => {
  const { url, ttlHours } = req.body || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2048) {
    return res.status(400).json({ error: 'Bitte gültige http(s)-URL angeben (max 2048 Zeichen).' });
  }
  const ttl = Math.max(1, Math.min(24 * 30, parseInt(ttlHours, 10) || 24));
  const links = await pruneExpired();
  let id;
  do { id = shortId(); } while (links[id]);
  const expiresAt = Date.now() + ttl * 3600 * 1000;
  links[id] = { url, expiresAt, createdAt: Date.now() };
  await writeLinks(links);
  res.json({ id, expiresAt, ttlHours: ttl });
});

app.get('/s/:id', async (req, res) => {
  const links = await pruneExpired();
  const entry = links[req.params.id];
  if (!entry) return res.status(404).send('Link unbekannt oder abgelaufen.');
  res.redirect(302, entry.url);
});

app.get('/api/links', async (_req, res) => {
  const links = await pruneExpired();
  // Don't leak full URLs in a list endpoint — only return counts.
  res.json({ count: Object.keys(links).length });
});

// ---------------------------------------------------------------------------
// Image convert — accepts one upload, converts to target format.
// ---------------------------------------------------------------------------
app.post('/api/image/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
  const target = String(req.body.format || 'png').toLowerCase();
  const allowed = ['png', 'jpeg', 'jpg', 'webp', 'avif', 'tiff', 'gif'];
  if (!allowed.includes(target)) return res.status(400).json({ error: 'Format nicht unterstützt.' });
  const fmt = target === 'jpg' ? 'jpeg' : target;
  const quality = Math.max(1, Math.min(100, parseInt(req.body.quality, 10) || 85));
  try {
    const pipeline = sharp(req.file.buffer, { animated: fmt === 'gif' || fmt === 'webp' });
    const opts = (fmt === 'jpeg' || fmt === 'webp' || fmt === 'avif' || fmt === 'tiff') ? { quality } : {};
    const out = await pipeline.toFormat(fmt, opts).toBuffer();
    res.setHeader('Content-Type', `image/${fmt}`);
    res.setHeader('Content-Disposition', `attachment; filename="converted.${target}"`);
    res.send(out);
  } catch (e) {
    res.status(400).json({ error: 'Konvertierung fehlgeschlagen: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// EXIF strip — re-encodes without metadata.
// ---------------------------------------------------------------------------
app.post('/api/image/strip-exif', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
  try {
    // sharp drops metadata by default unless .withMetadata() is called.
    const meta = await sharp(req.file.buffer).metadata();
    const fmt = ['jpeg', 'png', 'webp', 'tiff', 'avif', 'gif'].includes(meta.format) ? meta.format : 'jpeg';
    const out = await sharp(req.file.buffer).toFormat(fmt).toBuffer();
    res.setHeader('Content-Type', `image/${fmt}`);
    res.setHeader('Content-Disposition', `attachment; filename="clean.${fmt === 'jpeg' ? 'jpg' : fmt}"`);
    res.send(out);
  } catch (e) {
    res.status(400).json({ error: 'EXIF-Strip fehlgeschlagen: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Transparent background — sample pixel (0,0), key out matching pixels.
// ---------------------------------------------------------------------------
app.post('/api/image/transparent', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
  const threshold = Math.max(0, Math.min(200, parseInt(req.body.threshold, 10) || 30));
  const exportFmt = String(req.body.format || 'png').toLowerCase() === 'webp' ? 'webp' : 'png';
  try {
    const img = sharp(req.file.buffer).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (channels !== 4) return res.status(400).json({ error: 'Bild konnte nicht in RGBA gewandelt werden.' });
    // Pixel (0,0) is the key color.
    const kr = data[0], kg = data[1], kb = data[2];
    const t2 = threshold * threshold;
    const out = Buffer.from(data); // copy; we'll mutate alpha
    for (let i = 0; i < out.length; i += 4) {
      const dr = out[i] - kr, dg = out[i + 1] - kg, db = out[i + 2] - kb;
      const dist2 = dr * dr + dg * dg + db * db;
      if (dist2 <= t2) out[i + 3] = 0;
    }
    const png = await sharp(out, { raw: { width, height, channels: 4 } }).toFormat(exportFmt).toBuffer();
    res.setHeader('Content-Type', `image/${exportFmt}`);
    res.setHeader('Content-Disposition', `attachment; filename="transparent.${exportFmt}"`);
    res.send(png);
  } catch (e) {
    res.status(400).json({ error: 'Transparenz-Verarbeitung fehlgeschlagen: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// PDF combine — accepts multiple uploads (in order), returns merged PDF.
// ---------------------------------------------------------------------------
app.post('/api/pdf/combine', upload.array('files', 25), async (req, res) => {
  const files = req.files || [];
  if (files.length < 2) return res.status(400).json({ error: 'Mindestens 2 PDFs nötig.' });
  try {
    const merged = await PDFDocument.create();
    for (const f of files) {
      let src;
      try { src = await PDFDocument.load(f.buffer, { ignoreEncryption: false }); }
      catch (e) { return res.status(400).json({ error: `Datei "${f.originalname}" konnte nicht geöffnet werden.` }); }
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    }
    const bytes = await merged.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="combined.pdf"');
    res.send(Buffer.from(bytes));
  } catch (e) {
    res.status(400).json({ error: 'PDF-Merge fehlgeschlagen: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// txt/md → PDF — basic typesetting with page wrapping.
// ---------------------------------------------------------------------------
function wrapText(text, font, fontSize, maxWidth) {
  const lines = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') { lines.push(''); continue; }
    const words = rawLine.split(/(\s+)/);
    let current = '';
    for (const w of words) {
      const candidate = current + w;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current.trim()) {
        lines.push(current.trimEnd());
        current = w.trimStart();
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current.trimEnd());
  }
  return lines;
}

// Strip markdown to plain text we can typeset (we don't need full HTML rendering for PDF).
function markdownToPlain(input) {
  // Render to HTML then strip tags, but preserve heading hierarchy via prefixes.
  const out = [];
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { out.push(''); out.push(m[2]); out.push(''); continue; }
    if ((m = line.match(/^[-*+]\s+(.*)$/))) { out.push('  • ' + m[1]); continue; }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) { out.push('  ' + line); continue; }
    if (line.trim().startsWith('```')) { continue; }
    // Strip inline formatting (bold/italic/code/links) — coarse but readable.
    const stripped = line
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    out.push(stripped);
  }
  return out.join('\n');
}

app.post('/api/text/to-pdf', async (req, res) => {
  const { text, mode, title } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Kein Text übergeben.' });
  if (text.length > 200_000) return res.status(400).json({ error: 'Text zu lang (max 200k Zeichen).' });
  try {
    const isMd = mode === 'markdown';
    const body = isMd ? markdownToPlain(text) : text;
    const doc = await PDFDocument.create();
    if (title) doc.setTitle(String(title).slice(0, 200));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontSize = 11;
    const lineHeight = fontSize * 1.4;
    const margin = 50;
    let page = doc.addPage();
    let { width, height } = page.getSize();
    let y = height - margin;
    const maxWidth = width - margin * 2;
    const wrapped = wrapText(body, font, fontSize, maxWidth);
    for (const line of wrapped) {
      if (y < margin) {
        page = doc.addPage();
        ({ width, height } = page.getSize());
        y = height - margin;
      }
      page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.1, 0.1, 0.1) });
      y -= lineHeight;
    }
    const bytes = await doc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(title || 'document').replace(/[^\w.-]/g, '_')}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (e) {
    res.status(400).json({ error: 'PDF-Erstellung fehlgeschlagen: ' + e.message });
  }
});

// Markdown → HTML preview (useful for the markdown tool's server-side render fallback).
app.post('/api/markdown/render', (req, res) => {
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  if (text.length > 200_000) return res.status(400).json({ error: 'Text zu lang.' });
  res.json({ html: md.render(text) });
});

// Multer / generic error handler.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Upload-Fehler: ' + err.message });
  }
  res.status(500).json({ error: err.message || 'Interner Fehler.' });
});

app.listen(PORT, () => {
  console.log(`Simple Tools läuft auf http://localhost:${PORT}`);
});
