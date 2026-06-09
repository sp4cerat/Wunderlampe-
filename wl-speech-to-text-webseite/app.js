(() => {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const $ = (id) => document.getElementById(id);
  const els = {
    unsupported: $('unsupported'),
    toggleBtn:   $('toggleBtn'),
    toggleLabel: $('toggleLabel'),
    toggleIcon:  $('toggleIcon'),
    langSelect:  $('langSelect'),
    output:      $('output'),
    interim:     $('interim'),
    copyBtn:     $('copyBtn'),
    copyLabel:   $('copyLabel'),
    clearBtn:    $('clearBtn'),
    charCount:   $('charCount'),
    statusDot:   $('statusDot'),
    statusLabel: $('statusLabel'),
  };

  if (!SR) {
    els.unsupported.classList.remove('hidden');
    els.toggleBtn.disabled = true;
    els.langSelect.disabled = true;
  }

  // Persisted language
  const LANG_KEY = 's2t.lang';
  const savedLang = localStorage.getItem(LANG_KEY);
  if (savedLang && [...els.langSelect.options].some(o => o.value === savedLang)) {
    els.langSelect.value = savedLang;
  } else {
    const nav = navigator.language || 'de-DE';
    const match = [...els.langSelect.options].find(o => o.value === nav)
               || [...els.langSelect.options].find(o => o.value.startsWith(nav.split('-')[0]));
    if (match) els.langSelect.value = match.value;
  }

  // =============================================================================
  // Dedup-Helper — 1:1 portiert aus dem personalisierten Nachrichtendienst.
  // Chrome re-emittiert über Session-Grenzen hinweg dieselbe Äußerung; statt
  // die Ursache zu bekämpfen wird der Kandidaten-Text gegen den committeten
  // Stand (baseline + finalSoFar) auf Wortebene dedupliziert.
  // =============================================================================
  function normWord(w) {
    return String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  let dedupBasisCache = { key: null, words: null };
  function invalidateDedupCache() { dedupBasisCache = { key: null, words: null }; }

  function basisWords(basis) {
    if (dedupBasisCache.key === basis) return dedupBasisCache.words;
    const words = (basis.match(/\S+/g) || []).map(normWord).filter((w) => w.length > 0);
    dedupBasisCache = { key: basis, words };
    return words;
  }

  // Stage A: längster Suffix-Prefix-Overlap auf Wortebene (fängt den dominanten
  // Bug — Chrome wiederholt die letzten Worte beim Session-Restart komplett).
  // Stage B: ≥3-Wort-Runs aus dem Rest, die irgendwo im Basis-Text als
  // Substring stehen, werden verworfen (konservativ gegen Re-Emit irgendwo in
  // der Mitte; kürzere Treffer wie "und der" bleiben unangetastet).
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

  // =============================================================================
  // State
  // =============================================================================
  // recognition = aktuell laufende SR-Instanz. WICHTIG: pro Session frisch
  // erzeugen — Chrome behält bei rec.start() auf derselben Instanz die alten
  // Results in ev.results, was die Ursache der Duplikate ist.
  let recognition = null;
  let listening = false;
  // baseline = Text der vor dem Start dieser SR-Instanz im Feld stand; bleibt
  // während einer SR-Sitzung konstant. Beim onend-Restart wird ta.value
  // eingefroren.
  let baseline = '';
  // finalSoFar = additiver Final-Text der AKTUELLEN SR-Instanz.
  let finalSoFar = '';
  // lastWritten = letzter Wert, den writeBack ins Textarea geschrieben hat.
  // Wenn ta.value davon abweicht, hat der User manuell editiert → absorbieren.
  let lastWritten = '';
  let editAbsorbTimer = null;

  function setStatus(state) {
    const map = {
      idle:      { dot: 'bg-slate-600',                  label: 'bereit' },
      listening: { dot: 'bg-emerald-400 animate-pulse',  label: 'höre zu…' },
      error:     { dot: 'bg-rose-500',                   label: 'Fehler' },
      denied:    { dot: 'bg-rose-500',                   label: 'Mikrofon blockiert' },
    };
    const s = map[state] || map.idle;
    els.statusDot.className = 'h-2 w-2 rounded-full ' + s.dot;
    els.statusLabel.textContent = s.label;
  }

  function setToggleUI(active) {
    if (active) {
      els.toggleLabel.textContent = 'Aufnahme stoppen';
      els.toggleBtn.classList.remove('bg-indigo-500', 'hover:bg-indigo-400', 'shadow-indigo-500/20');
      els.toggleBtn.classList.add('bg-rose-500', 'hover:bg-rose-400', 'shadow-rose-500/20');
      els.toggleIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2" />';
    } else {
      els.toggleLabel.textContent = 'Aufnahme starten';
      els.toggleBtn.classList.remove('bg-rose-500', 'hover:bg-rose-400', 'shadow-rose-500/20');
      els.toggleBtn.classList.add('bg-indigo-500', 'hover:bg-indigo-400', 'shadow-indigo-500/20');
      els.toggleIcon.innerHTML = `
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      `;
    }
  }

  function updateCount() {
    els.charCount.textContent = `${els.output.value.length} Zeichen`;
  }

  // writeBack schreibt baseline+finalSoFar ins Textfeld; Interim rendert separat
  // als Overlay unter dem Textarea (Issue: Interim soll nicht editierbar sein).
  function writeBack(interim) {
    const newVal = baseline + finalSoFar;
    if (els.output.value !== newVal) {
      els.output.value = newVal;
    }
    lastWritten = newVal;
    els.interim.textContent = interim || '';
    invalidateDedupCache();
    updateCount();
  }

  function handleResult(ev) {
    // Wenn der User seit dem letzten writeBack manuell editiert hat: jetzt
    // absorbieren, sonst würde writeBack die User-Eingabe sofort überschreiben.
    if (els.output.value !== lastWritten) {
      absorbEditSync();
    }

    let interim = '';
    let newFinal = '';
    // ev.resultIndex zeigt auf das ERSTE neue Result in diesem Event — ohne
    // diese Grenze würden wir bei jedem Event ALLE bisherigen Finals erneut
    // akkumulieren und so Duplikate erzeugen.
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
      // Safety-Net: Chrome re-emittiert Finals manchmal trotz resultIndex →
      // Wort-Dedup gegen baseline+finalSoFar.
      const deduped = appendDeduped(baseline + finalSoFar, newFinal);
      if (deduped) finalSoFar += deduped;
    }
    writeBack(interim);
  }

  // Synchrone Variante (nicht-debounced) — wird von handleResult gerufen, um
  // unmittelbar vor dem Verarbeiten neuer Finals den User-Edit aufzunehmen.
  function absorbEditSync() {
    baseline = els.output.value;
    finalSoFar = '';
    lastWritten = baseline;
    invalidateDedupCache();
  }

  // Debounced Variante — wird vom input-Listener nach 300ms gerufen. Stoppt
  // zusätzlich den Recognizer, damit dessen ev.results nicht weiter mit
  // alten Finals "vergiftet" sind.
  function absorbEditAndRestart() {
    absorbEditSync();
    if (listening && recognition) {
      // recognition.stop() löst onend aus, dort wird eine NEUE Instanz erzeugt
      // und gestartet (s. r.onend in createRec).
      try { recognition.stop(); } catch (_) {}
    }
  }

  function createRec() {
    const r = new SR();
    r.lang = els.langSelect.value;
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      listening = true;
      setStatus('listening');
      setToggleUI(true);
    };

    r.onresult = handleResult;

    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setStatus('denied');
        listening = false;
      } else if (e.error === 'no-speech' || e.error === 'aborted') {
        // benign — onend setzt zurück bzw. restartet
      } else {
        setStatus('error');
        els.statusLabel.textContent = 'Fehler: ' + e.error;
      }
    };

    r.onend = () => {
      // Wenn diese Instanz mittlerweile durch eine andere ersetzt wurde
      // (z.B. Sprachwechsel → stop+setTimeout(start)), nichts tun.
      if (r !== recognition) return;

      if (!listening) {
        setStatus('idle');
        setToggleUI(false);
        els.interim.textContent = '';
        return;
      }

      // Sitzung ist natürlich ausgelaufen (Stille/Timeout) oder wurde durch
      // absorbEditAndRestart/Clear gestoppt. Aktuellen sichtbaren Stand
      // einfrieren — der enthält ggf. User-Edits zusätzlich zu baseline+finalSoFar.
      baseline = els.output.value;
      if (baseline && !/[\s\n]$/.test(baseline)) baseline += ' ';
      finalSoFar = '';
      lastWritten = baseline;
      invalidateDedupCache();

      // Frische Instanz! Chrome behält sonst die alten ev.results und liefert
      // Finals immer wieder neu aus.
      recognition = createRec();
      try {
        recognition.start();
      } catch (_) {
        // start() unmittelbar nach stop() kann InvalidStateError werfen → 200ms warten
        setTimeout(() => { try { recognition && recognition.start(); } catch {} }, 200);
      }
    };

    return r;
  }

  function start() {
    if (!SR || listening) return;
    baseline = els.output.value;
    if (baseline && !/[\s\n]$/.test(baseline)) baseline += ' ';
    finalSoFar = '';
    lastWritten = baseline;
    invalidateDedupCache();
    recognition = createRec();
    try {
      recognition.start();
    } catch (_) {
      setTimeout(() => { try { recognition && recognition.start(); } catch {} }, 200);
    }
  }

  function stop() {
    if (!recognition && !listening) return;
    listening = false; // verhindert Auto-Restart in onend
    if (editAbsorbTimer) { clearTimeout(editAbsorbTimer); editAbsorbTimer = null; }
    try { recognition && recognition.stop(); } catch (_) {}
  }

  // =============================================================================
  // Events
  // =============================================================================
  els.toggleBtn.addEventListener('click', () => {
    if (listening) stop(); else start();
  });

  els.langSelect.addEventListener('change', () => {
    localStorage.setItem(LANG_KEY, els.langSelect.value);
    if (listening) {
      stop();
      setTimeout(start, 250);
    }
  });

  // Manuelle Edits am Textarea während des Hörens → debounced absorbieren.
  // Wenn nicht aktiv, lassen wir die Textarea unangefasst (User tippt frei).
  els.output.addEventListener('input', () => {
    updateCount();
    if (!listening) {
      lastWritten = els.output.value;
      return;
    }
    if (editAbsorbTimer) clearTimeout(editAbsorbTimer);
    editAbsorbTimer = setTimeout(() => {
      editAbsorbTimer = null;
      if (listening) absorbEditAndRestart();
    }, 300);
  });

  els.copyBtn.addEventListener('click', async () => {
    const text = els.output.value;
    if (!text) { flashCopy('Nichts zu kopieren', false); return; }
    try {
      await navigator.clipboard.writeText(text);
      flashCopy('Kopiert!', true);
    } catch (_) {
      els.output.select();
      try {
        document.execCommand('copy');
        flashCopy('Kopiert!', true);
      } catch (e) {
        flashCopy('Kopie fehlgeschlagen', false);
      }
      els.output.setSelectionRange(els.output.value.length, els.output.value.length);
    }
  });

  function flashCopy(msg, ok) {
    const btn = els.copyBtn;
    const prev = els.copyLabel.textContent;
    els.copyLabel.textContent = msg;
    if (ok) {
      btn.classList.add('!border-emerald-500/60', '!bg-emerald-500/15', '!text-emerald-300');
    } else {
      btn.classList.add('!border-rose-500/60', '!bg-rose-500/15', '!text-rose-300');
    }
    setTimeout(() => {
      els.copyLabel.textContent = prev;
      btn.classList.remove(
        '!border-emerald-500/60', '!bg-emerald-500/15', '!text-emerald-300',
        '!border-rose-500/60', '!bg-rose-500/15', '!text-rose-300'
      );
    }, 1200);
  }

  els.clearBtn.addEventListener('click', () => {
    if (!els.output.value && !finalSoFar && !baseline) return;
    if (els.output.value.length > 40 && !confirm('Text wirklich leeren?')) return;
    baseline = '';
    finalSoFar = '';
    lastWritten = '';
    els.output.value = '';
    els.interim.textContent = '';
    invalidateDedupCache();
    updateCount();
    // Wenn live: Recognizer neu erzeugen, sonst rendert das nächste onresult
    // den alten ev.results-Stream wieder als finalSoFar rein.
    if (listening && recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    els.output.focus();
  });

  // Cmd/Ctrl+Enter zum Starten/Stoppen
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!SR) return;
      if (listening) stop(); else start();
    }
  });

  setStatus('idle');
  updateCount();
  lastWritten = els.output.value;
})();
