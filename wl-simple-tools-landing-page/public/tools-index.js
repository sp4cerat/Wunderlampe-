// Renders the tool grid on the landing page and powers the filter input.

const TOOLS = [
  { slug: 'json-formatter', title: 'JSON Formatter', desc: 'Validieren, einrücken, minifizieren — direkt im Browser.', tag: 'Daten', icon: 'braces' },
  { slug: 'password-generator', title: 'Passwort-Generator', desc: 'Sichere Passwörter & Tokens via Web-Crypto.', tag: 'Sicherheit', icon: 'key' },
  { slug: 'crontab', title: 'Crontab-Generator', desc: 'Cron-Ausdrücke baukastenartig zusammenstellen.', tag: 'DevOps', icon: 'clock' },
  { slug: 'markdown', title: 'Markdown → HTML', desc: 'Live-Preview mit Sanitizing — auch HTML-Output zum Kopieren.', tag: 'Daten', icon: 'doc' },
  { slug: 'exif-remover', title: 'EXIF-Entferner', desc: 'Metadaten lokal via Canvas-Re-Encoding aus Fotos strippen.', tag: 'Bild', icon: 'shield' },
  { slug: 'csv-converter', title: 'CSV ↔ JSON / XML', desc: 'CSV in JSON oder XML umwandeln, mit Header-Optionen.', tag: 'Daten', icon: 'table' },
  { slug: 'diff-viewer', title: 'Diff-Viewer', desc: 'Zwei Texte zeilenweise vergleichen.', tag: 'Daten', icon: 'split' },
  { slug: 'unit-converter', title: 'Unit-Converter', desc: 'Nischen-Einheiten: Kochen, Computing, Astronomie, Garn.', tag: 'Utility', icon: 'arrows' },
  { slug: 'url-shortener', title: 'URL-Shortener', desc: 'Benötigt einen Backend-Server — in der statischen Variante nicht verfügbar.', tag: 'Web', icon: 'link', unavailable: true },
  { slug: 'base64', title: 'Base64', desc: 'Encoder & Decoder für Text und Dateien.', tag: 'Daten', icon: 'binary' },
  { slug: 'image-converter', title: 'Bild-Konverter', desc: 'PNG / JPG / WebP — direkt im Browser via Canvas.', tag: 'Bild', icon: 'image' },
  { slug: 'pdf-combine', title: 'PDFs kombinieren', desc: 'Mehrere PDFs clientseitig mit pdf-lib zusammenführen.', tag: 'PDF', icon: 'pdf' },
  { slug: 'color-picker', title: 'Color Picker', desc: 'RGB / HEX / HSL — mit Palette und Kontrast-Check.', tag: 'Web', icon: 'swatch' },
  { slug: 'txt-to-pdf', title: 'Text/Markdown → PDF', desc: 'PDF aus Text oder Markdown via pdf-lib im Browser.', tag: 'PDF', icon: 'pdf' },
  { slug: 'transparent-bg', title: 'Hintergrund transparent', desc: 'Pixel (0,0) als Schlüssel-Farbe, Threshold steuert Härte — clientseitig.', tag: 'Bild', icon: 'wand' }
];

const ICONS = {
  braces: '<path d="M8 4H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2v0a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2v0a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/>',
  key: '<circle cx="9" cy="15" r="3"/><path d="m12 13 6-6m-2 0 2 2m1-5 2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6Z"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  split: '<path d="M8 3v18M16 3v18M3 12h5M16 12h5"/>',
  arrows: '<path d="M3 7h13l-3-3M21 17H8l3 3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1"/>',
  binary: '<rect x="4" y="3" width="6" height="8" rx="1"/><rect x="14" y="13" width="6" height="8" rx="1"/><path d="M14 3h6v8M4 13h6v8"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h2a1.5 1.5 0 1 1 0 3H9zm0 0v5m4-5h2a2 2 0 0 1 0 4h-2zm6 0h-3v5"/>',
  swatch: '<path d="M12 22a4 4 0 0 0 4-4V8a4 4 0 0 0-8 0v10a4 4 0 0 0 4 4Z"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>',
  wand: '<path d="M14 7 7 14l3 3 7-7zM18 5l1 1m-1-3 .8.8M16 3l.5.5"/>'
};

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5">${ICONS[name] || ''}</svg>`;
}

function render(filter = '') {
  const grid = document.getElementById('grid');
  const q = filter.trim().toLowerCase();
  const filtered = TOOLS.filter(t =>
    !q || t.title.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) || t.tag.toLowerCase().includes(q)
  );
  grid.innerHTML = filtered.map(t => `
    <a href="public/tools/${t.slug}.html" class="group block rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 hover:border-zinc-700 transition p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="h-9 w-9 grid place-items-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-400/20 text-emerald-300 group-hover:bg-emerald-500/20 transition">
          ${iconSvg(t.icon)}
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">${t.tag}</span>
          ${t.unavailable
            ? '<span class="text-[10px] uppercase tracking-wider text-rose-300/80 bg-rose-300/10 ring-1 ring-rose-300/20 rounded px-1.5 py-0.5">offline</span>'
            : '<span class="text-[10px] uppercase tracking-wider text-emerald-300/80 bg-emerald-300/10 ring-1 ring-emerald-300/20 rounded px-1.5 py-0.5">browser</span>'}
        </div>
      </div>
      <h3 class="mt-4 font-medium text-zinc-100">${t.title}</h3>
      <p class="mt-1 text-sm text-zinc-400">${t.desc}</p>
    </a>
  `).join('') || `<p class="text-sm text-zinc-500 sm:col-span-2 lg:col-span-3">Keine Tools für „${filter}".</p>`;
}

document.addEventListener('DOMContentLoaded', () => {
  render();
  const input = document.getElementById('filter');
  if (input) input.addEventListener('input', e => render(e.target.value));
});
