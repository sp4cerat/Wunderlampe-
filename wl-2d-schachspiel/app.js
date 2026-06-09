'use strict';

/* ===========================================================
   2D Schach — Client-Logik
   - Spielregeln via chess.js (v0.13.4 globales `Chess`)
   - KI: 4 Stufen (Random+Capture / Minimax d2 / d3 / d4)
   - Click-to-Move, Animationen, Promo-Dialog, Undo, Hint
   =========================================================== */

(function () {
  // ====== Konstanten ======
  const FILES = ['a','b','c','d','e','f','g','h'];

  // Issue 3: Inline-SVGs statt Unicode-Glyphen.
  // Grund: System-Fonts (Apple Symbols, Noto Sans Symbols, Samsung One UI…)
  // rendern die gefüllten Unicode-Symbole ♚♛♜♝♞♟ mit eigener Innenzeichnung,
  // die CSS-`color` nur teilweise greifen lässt — die weißen Figuren wirkten
  // daher grau/dunkel. Mit SVG bestimmen wir Fill+Stroke selbst über die
  // CSS-Variablen --p-fill und --p-stroke (gesetzt in .piece-w/.piece-b).
  //
  // Eigene, bewusst flächige Geometrie (viewBox 0 0 100 100): jede Figur
  // besteht aus klaren Grundformen (Kreise, Polygone, einfache Pfade),
  // sodass die Pieces auch auf 36-px-Squares lesbar bleiben.
  const SVG_PIECES = {
    p:
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="var(--p-fill)" stroke="var(--p-stroke)" stroke-width="3" stroke-linejoin="round">' +
          '<circle cx="50" cy="24" r="12"/>' +
          '<path d="M38 36 Q34 44 39 52 L27 76 H73 L61 52 Q66 44 62 36 Z"/>' +
          '<rect x="18" y="76" width="64" height="10" rx="3"/>' +
        '</g>' +
      '</svg>',

    r:
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="var(--p-fill)" stroke="var(--p-stroke)" stroke-width="3" stroke-linejoin="round">' +
          '<path d="M22 22 V10 H32 V16 H42 V10 H58 V16 H68 V10 H78 V22 L70 30 V62 L78 74 H22 L30 62 V30 Z"/>' +
          '<path d="M30 30 H70 M30 62 H70" stroke-width="2" fill="none"/>' +
          '<rect x="16" y="76" width="68" height="10" rx="3"/>' +
        '</g>' +
      '</svg>',

    n:
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="var(--p-fill)" stroke="var(--p-stroke)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">' +
          '<path d="M46 10 Q74 16 76 50 V74 H30 Q30 60 46 54 Q42 46 42 38 L32 42 Q22 38 28 28 Q34 18 44 12 L42 22 L52 18 L50 10 Z"/>' +
          '<circle cx="56" cy="30" r="2.4" fill="var(--p-stroke)" stroke="none"/>' +
          '<rect x="18" y="74" width="64" height="10" rx="3"/>' +
        '</g>' +
      '</svg>',

    b:
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="var(--p-fill)" stroke="var(--p-stroke)" stroke-width="3" stroke-linejoin="round">' +
          '<circle cx="50" cy="13" r="5"/>' +
          '<path d="M50 20 Q70 28 68 50 Q66 58 62 64 H38 Q34 58 32 50 Q30 28 50 20 Z"/>' +
          '<path d="M42 38 L58 50 M58 38 L42 50" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
          '<path d="M28 64 H72 L78 76 H22 Z"/>' +
          '<rect x="16" y="76" width="68" height="10" rx="3"/>' +
        '</g>' +
      '</svg>',

    q:
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="var(--p-fill)" stroke="var(--p-stroke)" stroke-width="3" stroke-linejoin="round">' +
          '<circle cx="14" cy="24" r="4"/>' +
          '<circle cx="32" cy="16" r="4"/>' +
          '<circle cx="50" cy="12" r="4"/>' +
          '<circle cx="68" cy="16" r="4"/>' +
          '<circle cx="86" cy="24" r="4"/>' +
          '<path d="M14 28 L22 50 L32 22 L40 50 L50 18 L60 50 L68 22 L78 50 L86 28 L74 60 H26 Z"/>' +
          '<path d="M26 60 Q50 68 74 60 L78 76 H22 Z"/>' +
          '<rect x="16" y="76" width="68" height="10" rx="3"/>' +
        '</g>' +
      '</svg>',

    k:
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="var(--p-fill)" stroke="var(--p-stroke)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">' +
          '<path d="M50 22 V6 M42 12 H58" fill="none" stroke-width="3.5"/>' +
          '<path d="M50 26 L62 36 L72 28 L80 44 L74 60 H26 L20 44 L28 28 L38 36 Z"/>' +
          '<path d="M26 60 Q50 68 74 60 L78 76 H22 Z"/>' +
          '<rect x="16" y="76" width="68" height="10" rx="3"/>' +
        '</g>' +
      '</svg>'
  };

  const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

  // Piece-square tables (aus Sicht von Weiß, index 0 = a8, 63 = h1)
  // Quelle: Chess Programming Wiki "Simplified Evaluation Function".
  const PST = {
    p: [
       0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0
    ],
    n: [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50
    ],
    b: [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20
    ],
    r: [
       0,  0,  0,  0,  0,  0,  0,  0,
       5, 10, 10, 10, 10, 10, 10,  5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
       0,  0,  0,  5,  5,  0,  0,  0
    ],
    q: [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20
    ],
    k: [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ]
  };

  // ====== Zustand ======
  const game = new Chess();

  let playerColor = 'w';      // 'w' | 'b'
  let orientation = 'w';      // welche Seite "unten"?
  let difficulty  = 2;        // 1..4
  let animationsEnabled = true;

  let selectedSquare   = null;        // 'e2' etc.
  let legalForSelected = [];          // verbose moves
  let lastMove         = null;        // { from, to }
  let pendingPromotion = null;        // { from, to }
  let aiBusy           = false;
  let aiSearchToken    = 0;

  // ====== DOM-Referenzen ======
  const boardEl    = document.getElementById('board');
  const filesEl    = document.getElementById('files');
  const ranksEl    = document.getElementById('ranks');
  const turnDot    = document.getElementById('turnDot');
  const turnText   = document.getElementById('turnText');
  const aiStateEl  = document.getElementById('aiState');
  const evalEl     = document.getElementById('evalDisplay');
  const moveListEl = document.getElementById('moveList');
  const moveCountEl= document.getElementById('moveCount');
  const capTopEl   = document.getElementById('capturedTop');
  const capBotEl   = document.getElementById('capturedBottom');
  const thinkOver  = document.getElementById('thinkingOverlay');

  // ====== Hilfsfunktionen ======
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ====== Bewertung & KI ======
  function evaluateBoard(chess) {
    if (chess.in_checkmate()) {
      // Spieler am Zug ist matt: schlecht für ihn.
      return chess.turn() === 'w' ? -99999 : 99999;
    }
    if (chess.in_stalemate() || chess.in_draw() || chess.insufficient_material()) {
      return 0;
    }
    const board = chess.board();
    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (!p) continue;
        const v = PIECE_VALUE[p.type];
        // board[0] = rank 8 → PST index 0 (a8) bei Weiß; für Schwarz spiegeln (7-r).
        const pstIdx = (p.color === 'w' ? r : (7 - r)) * 8 + f;
        const pos = PST[p.type][pstIdx];
        const total = v + pos;
        score += (p.color === 'w' ? total : -total);
      }
    }
    return score;
  }

  function orderMoves(moves) {
    // Captures zuerst (MVV-LVA-ish), dann Promotionen, dann Rest.
    const scored = moves.map(m => {
      let s = 0;
      if (m.captured) s += PIECE_VALUE[m.captured] * 10 - PIECE_VALUE[m.piece];
      if (m.promotion) s += PIECE_VALUE[m.promotion] * 8;
      if (m.flags.includes('e')) s += PIECE_VALUE.p * 10; // en passant
      return { m, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.m);
  }

  // Minimax mit Alpha-Beta. `maximizing` = true → Weiß maximiert.
  function search(chess, depth, alpha, beta, maximizing) {
    if (depth === 0 || chess.game_over()) {
      return evaluateBoard(chess);
    }
    const moves = orderMoves(chess.moves({ verbose: true }));
    if (moves.length === 0) {
      return evaluateBoard(chess);
    }
    if (maximizing) {
      let best = -Infinity;
      for (const mv of moves) {
        chess.move(mv);
        const val = search(chess, depth - 1, alpha, beta, false);
        chess.undo();
        if (val > best) best = val;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const mv of moves) {
        chess.move(mv);
        const val = search(chess, depth - 1, alpha, beta, true);
        chess.undo();
        if (val < best) best = val;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
      return best;
    }
  }

  function pickAIMove() {
    const aiColor = game.turn();
    const moves = game.moves({ verbose: true });
    if (moves.length === 0) return null;

    // Stufe 1: meist zufällig, mit milder Capture-Präferenz.
    if (difficulty === 1) {
      const weighted = [];
      for (const mv of moves) {
        let w = 1;
        if (mv.captured) w += 3;
        if (mv.flags.includes('c') || mv.flags.includes('e')) w += 1;
        // gelegentlich "Checks" bevorzugen — billiger Probe-Push:
        for (let i = 0; i < w; i++) weighted.push(mv);
      }
      return weighted[Math.floor(Math.random() * weighted.length)];
    }

    const depth = { 2: 2, 3: 3, 4: 4 }[difficulty] || 2;
    const ordered = orderMoves(moves);
    const maximizing = aiColor === 'w';
    let bestVal = maximizing ? -Infinity : Infinity;
    let bestMoves = [];
    for (const mv of ordered) {
      game.move(mv);
      const val = search(game, depth - 1, -Infinity, Infinity, !maximizing);
      game.undo();
      if (maximizing) {
        if (val > bestVal) { bestVal = val; bestMoves = [mv]; }
        else if (val === bestVal) bestMoves.push(mv);
      } else {
        if (val < bestVal) { bestVal = val; bestMoves = [mv]; }
        else if (val === bestVal) bestMoves.push(mv);
      }
    }
    // kleine Random-Auswahl unter gleichwertigen Zügen sorgt für Abwechslung
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }

  // ====== Rendering ======
  function renderBoard() {
    const board = game.board();
    const ranksOrder = orientation === 'w' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
    const filesOrder = orientation === 'w' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];

    // Inhalt komplett neu aufbauen
    const frag = document.createDocumentFragment();
    for (const rank of ranksOrder) {
      for (const file of filesOrder) {
        const sq = document.createElement('div');
        const isLight = (file + rank) % 2 === 1;
        sq.className = 'sq selectable ' + (isLight ? 'light' : 'dark');
        sq.dataset.square = FILES[file] + (rank + 1);

        // board[0] = rank 8, board[7] = rank 1 ⇒ r' = 7 - rank
        const p = board[7 - rank][file];
        if (p) {
          const span = document.createElement('span');
          span.className = 'piece piece-' + p.color;
          span.innerHTML = SVG_PIECES[p.type];
          sq.appendChild(span);
        }
        frag.appendChild(sq);
      }
    }
    boardEl.innerHTML = '';
    boardEl.appendChild(frag);

    applyHighlights();
    renderCoords();
    renderCaptured();
    renderHistory();
    renderTurnIndicator();
    updateEval();
  }

  function applyHighlights() {
    for (const sq of boardEl.querySelectorAll('.sq')) {
      sq.classList.remove('selected','hint','capture','lastmove','check');
    }
    if (lastMove) {
      const a = boardEl.querySelector(`[data-square="${lastMove.from}"]`);
      const b = boardEl.querySelector(`[data-square="${lastMove.to}"]`);
      if (a) a.classList.add('lastmove');
      if (b) b.classList.add('lastmove');
    }
    if (selectedSquare) {
      const a = boardEl.querySelector(`[data-square="${selectedSquare}"]`);
      if (a) a.classList.add('selected');
      for (const mv of legalForSelected) {
        const t = boardEl.querySelector(`[data-square="${mv.to}"]`);
        if (!t) continue;
        if (mv.captured || mv.flags.includes('e')) t.classList.add('capture');
        else t.classList.add('hint');
      }
    }
    if (game.in_check()) {
      const turn = game.turn();
      const board = game.board();
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (p && p.type === 'k' && p.color === turn) {
            const sqEl = boardEl.querySelector(`[data-square="${FILES[f]}${8-r}"]`);
            if (sqEl) sqEl.classList.add('check');
          }
        }
      }
    }
  }

  function renderCoords() {
    const filesOrder = orientation === 'w' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];
    const ranksOrder = orientation === 'w' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
    filesEl.innerHTML = filesOrder.map(f => `<span>${FILES[f]}</span>`).join('');
    ranksEl.innerHTML = ranksOrder.map(r => `<span>${r+1}</span>`).join('');
  }

  function renderTurnIndicator() {
    const t = game.turn();
    turnDot.style.background = t === 'w' ? '#fafaf7' : '#171717';
    turnDot.style.boxShadow = t === 'w' ? 'inset 0 0 0 1px #333' : 'inset 0 0 0 1px #555';
    turnText.textContent = (t === 'w' ? 'Weiß' : 'Schwarz') + ' am Zug';
    if (game.in_check() && !game.game_over()) {
      turnText.textContent += ' — Schach';
    }
  }

  function renderHistory() {
    const hist = game.history();
    moveListEl.innerHTML = '';
    for (let i = 0; i < hist.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        `<span class="num">${(i/2 + 1)}.</span>` +
        `<span class="move">${escapeHtml(hist[i] || '')}</span>` +
        `<span class="move${hist[i+1] ? '' : ' muted'}">${escapeHtml(hist[i+1] || '')}</span>`;
      moveListEl.appendChild(row);
    }
    moveCountEl.textContent = hist.length + ' Halbzug' + (hist.length === 1 ? '' : 'e');
    moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  function renderCaptured() {
    const captured = { w: [], b: [] };
    const hist = game.history({ verbose: true });
    for (const m of hist) {
      if (m.captured) {
        const lostColor = m.color === 'w' ? 'b' : 'w';
        captured[lostColor].push(m.captured);
      }
    }

    // Material-Bilanz aus Spieler-Sicht
    let pts = { w: 0, b: 0 };
    for (const p of captured.b) pts.w += PIECE_VALUE[p];   // Weiß schlug Schwarz
    for (const p of captured.w) pts.b += PIECE_VALUE[p];
    const diff = (pts.w - pts.b) / 100;

    const compColor   = playerColor === 'w' ? 'b' : 'w';

    // Top zeigt was der Computer dem Spieler weggenommen hat (Spieler-Figuren).
    capTopEl.innerHTML = renderCapturedList(captured[playerColor], playerColor);
    capBotEl.innerHTML = renderCapturedList(captured[compColor], compColor);

    // Material-Vorteil als +x.y am Rand des Vorteilhabers
    const showBottom = (playerColor === 'w' ? diff > 0 : diff < 0);
    const adv = Math.abs(diff);
    if (adv > 0.05) {
      const text = `<span class="adv">+${adv.toFixed(1)}</span>`;
      if (showBottom) capBotEl.insertAdjacentHTML('beforeend', text);
      else capTopEl.insertAdjacentHTML('beforeend', text);
    }
  }

  function renderCapturedList(pieces, color) {
    const order = ['q','r','b','n','p'];
    const sorted = pieces.slice().sort((a,b) => order.indexOf(a) - order.indexOf(b));
    const cls = color === 'w' ? 'cap-white' : 'cap-black';
    return sorted.map(p => `<span class="${cls}">${SVG_PIECES[p]}</span>`).join('');
  }

  function updateEval() {
    // Reine Material-/Stellungsbewertung (nicht die Tiefen-Suche), ist immer schnell.
    const v = evaluateBoard(game) / 100;
    const sign = v > 0 ? '+' : '';
    evalEl.textContent = sign + v.toFixed(1);
  }

  // ====== Interaktion ======
  function handleBoardClick(ev) {
    if (aiBusy) return;
    if (game.game_over()) return;
    if (game.turn() !== playerColor) return;
    if (pendingPromotion) return;

    const sqEl = ev.target.closest('.sq');
    if (!sqEl) return;
    const square = sqEl.dataset.square;

    // Klick auf gültiges Zielfeld?
    if (selectedSquare) {
      const match = legalForSelected.find(m => m.to === square);
      if (match) {
        attemptMove(selectedSquare, square);
        return;
      }
    }

    // Sonst: neue Auswahl (eigene Figur?) oder abwählen
    const piece = game.get(square);
    if (piece && piece.color === playerColor) {
      selectedSquare = square;
      legalForSelected = game.moves({ square, verbose: true });
    } else {
      selectedSquare = null;
      legalForSelected = [];
    }
    applyHighlights();
  }

  function attemptMove(from, to) {
    const variants = legalForSelected.filter(m => m.to === to);
    const isPromo = variants.some(m => m.promotion);
    if (isPromo) {
      pendingPromotion = { from, to };
      showPromotionDialog();
      return;
    }
    applyMove({ from, to });
  }

  function applyMove(moveSpec) {
    const fromSq = moveSpec.from;
    const toSq   = moveSpec.to;
    const result = game.move({ from: fromSq, to: toSq, promotion: moveSpec.promotion || undefined });
    if (!result) return;
    lastMove = { from: result.from, to: result.to };
    selectedSquare = null;
    legalForSelected = [];

    // Effektive Glyphe nach evtl. Promotion
    const glyphType = result.promotion ? result.promotion : result.piece;
    animateMove(result.from, result.to, result.color, glyphType, () => {
      renderBoard();
      if (game.game_over()) {
        handleGameOver();
      } else if (game.turn() !== playerColor) {
        scheduleAIMove();
      }
    });
  }

  function animateMove(from, to, color, type, done) {
    if (!animationsEnabled) {
      if (done) done();
      return;
    }
    const fromEl = boardEl.querySelector(`[data-square="${from}"]`);
    const toEl   = boardEl.querySelector(`[data-square="${to}"]`);
    if (!fromEl || !toEl) { if (done) done(); return; }
    const fr = fromEl.getBoundingClientRect();
    const tr = toEl.getBoundingClientRect();
    const dx = tr.left - fr.left;
    const dy = tr.top  - fr.top;

    // Original verstecken
    const orig = fromEl.querySelector('.piece');
    if (orig) orig.style.opacity = '0';

    const clone = document.createElement('span');
    clone.className = 'piece piece-' + color + ' moving';
    clone.innerHTML = SVG_PIECES[type];
    Object.assign(clone.style, {
      position: 'fixed',
      left: fr.left + 'px',
      top:  fr.top  + 'px',
      width:  fr.width  + 'px',
      height: fr.height + 'px',
      display: 'grid',
      placeItems: 'center',
      zIndex: '100',
      pointerEvents: 'none',
      transition: 'transform 220ms cubic-bezier(.22,.61,.36,1)'
    });
    document.body.appendChild(clone);
    // im nächsten Frame Transform setzen, damit die Transition feuert
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    setTimeout(() => {
      clone.remove();
      if (done) done();
    }, 240);
  }

  // ====== KI-Aufruf ======
  function scheduleAIMove() {
    if (game.game_over()) return;
    if (game.turn() === playerColor) return;

    aiBusy = true;
    aiStateEl.textContent = 'Denkt nach…';
    thinkOver.classList.remove('hidden');
    const myToken = ++aiSearchToken;

    // Kurze Pause, damit Overlay sicher gemalt wird, bevor die (synchrone) Suche läuft.
    const minThinkMs = difficulty === 1 ? 350 : (difficulty === 2 ? 250 : 120);
    const start = performance.now();

    setTimeout(() => {
      if (myToken !== aiSearchToken) return;
      let move = null;
      try {
        move = pickAIMove();
      } catch (e) {
        console.error('AI error', e);
      }
      if (myToken !== aiSearchToken) return;

      const elapsed = performance.now() - start;
      const wait = Math.max(0, minThinkMs - elapsed);
      setTimeout(() => {
        if (myToken !== aiSearchToken) return;
        if (!move) {
          aiBusy = false;
          thinkOver.classList.add('hidden');
          aiStateEl.textContent = 'Bereit';
          if (game.game_over()) handleGameOver();
          return;
        }
        const r = game.move(move);
        lastMove = { from: r.from, to: r.to };
        const glyphType = r.promotion || r.piece;
        animateMove(r.from, r.to, r.color, glyphType, () => {
          aiBusy = false;
          thinkOver.classList.add('hidden');
          aiStateEl.textContent = 'Bereit';
          renderBoard();
          if (game.game_over()) handleGameOver();
        });
      }, wait);
    }, 30);
  }

  // ====== Promotion-Dialog ======
  function showPromotionDialog() {
    const modal = document.getElementById('promoModal');
    const choices = document.getElementById('promoChoices');
    choices.innerHTML = '';
    const color = playerColor;
    const types = ['q','r','b','n'];
    for (const t of types) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.innerHTML = `<span class="piece piece-${color} promo-piece">${SVG_PIECES[t]}</span>`;
      btn.title = ({ q:'Dame', r:'Turm', b:'Läufer', n:'Springer' })[t];
      btn.addEventListener('click', () => {
        modal.classList.add('hidden');
        const { from, to } = pendingPromotion;
        pendingPromotion = null;
        applyMove({ from, to, promotion: t });
      });
      choices.appendChild(btn);
    }
    modal.classList.remove('hidden');
  }

  // ====== Game-Over ======
  function handleGameOver() {
    const modal = document.getElementById('overModal');
    const title = document.getElementById('overTitle');
    const desc  = document.getElementById('overDesc');
    const icon  = document.getElementById('overIcon');

    if (game.in_checkmate()) {
      const loser = game.turn();
      const playerLost = loser === playerColor;
      icon.textContent = playerLost ? '♚' : '♛';
      title.textContent = playerLost ? 'Schachmatt' : 'Gewonnen!';
      desc.textContent  = playerLost
        ? 'Der Computer hat dich matt gesetzt.'
        : 'Glückwunsch — du hast den Computer matt gesetzt.';
    } else if (game.in_stalemate()) {
      icon.textContent = '♟';
      title.textContent = 'Patt';
      desc.textContent  = 'Keine legalen Züge — die Partie endet remis.';
    } else if (game.in_threefold_repetition()) {
      icon.textContent = '♟';
      title.textContent = 'Remis (Zugwiederholung)';
      desc.textContent  = 'Dieselbe Stellung trat dreimal auf.';
    } else if (game.insufficient_material()) {
      icon.textContent = '♟';
      title.textContent = 'Remis';
      desc.textContent  = 'Kein ausreichendes Mattmaterial.';
    } else if (game.in_draw()) {
      icon.textContent = '♟';
      title.textContent = 'Remis';
      desc.textContent  = '50-Züge-Regel oder ähnliches Remis.';
    }
    modal.classList.remove('hidden');
  }

  // ====== Undo / Tipp ======
  function doUndo() {
    if (aiBusy) {
      aiSearchToken++;
      aiBusy = false;
      thinkOver.classList.add('hidden');
      aiStateEl.textContent = 'Bereit';
    }
    // Versuche genau zwei Halbzüge zurück (Spieler + Computer).
    let undone = 0;
    while (undone < 2 && game.history().length > 0) {
      game.undo();
      undone++;
    }
    const verbose = game.history({ verbose: true });
    lastMove = verbose.length
      ? { from: verbose[verbose.length-1].from, to: verbose[verbose.length-1].to }
      : null;
    selectedSquare = null;
    legalForSelected = [];
    pendingPromotion = null;
    document.getElementById('promoModal').classList.add('hidden');
    document.getElementById('overModal').classList.add('hidden');
    renderBoard();
    if (!game.game_over() && game.turn() !== playerColor) {
      scheduleAIMove();
    }
  }

  function doHint() {
    if (game.turn() !== playerColor || game.game_over() || aiBusy) return;
    const moves = game.moves({ verbose: true });
    if (moves.length === 0) return;
    const maximizing = playerColor === 'w';
    let bestVal = maximizing ? -Infinity : Infinity;
    let bestMv = null;
    aiStateEl.textContent = 'Tipp suchen…';
    // Kurz UI atmen lassen, dann suchen.
    setTimeout(() => {
      for (const mv of orderMoves(moves)) {
        game.move(mv);
        const val = search(game, 2, -Infinity, Infinity, !maximizing);
        game.undo();
        if (maximizing ? val > bestVal : val < bestVal) {
          bestVal = val; bestMv = mv;
        }
      }
      aiStateEl.textContent = 'Bereit';
      if (!bestMv) return;
      const a = boardEl.querySelector(`[data-square="${bestMv.from}"]`);
      const b = boardEl.querySelector(`[data-square="${bestMv.to}"]`);
      if (a) a.classList.add('tipfrom');
      if (b) b.classList.add('tipto');
      setTimeout(() => {
        if (a) a.classList.remove('tipfrom');
        if (b) b.classList.remove('tipto');
      }, 1800);
    }, 20);
  }

  // ====== Settings ======
  function setDifficulty(level) {
    difficulty = level;
    for (const b of document.querySelectorAll('.diff-btn')) {
      b.classList.toggle('active', +b.dataset.level === level);
    }
    const hints = {
      1: 'Sehr leicht — fast zufällige Züge, ideal zum Aufwärmen.',
      2: 'Schaut 2 Halbzüge voraus — vernünftig, aber übersieht Mehrzüger.',
      3: 'Schaut 3 Halbzüge voraus mit Stellungsbewertung.',
      4: 'Schaut 4 Halbzüge voraus — Pausen von 1–3 s sind normal.'
    };
    document.getElementById('diffHint').textContent = hints[level] || '';
    try { localStorage.setItem('chess.difficulty', String(level)); } catch {}
  }

  function setColor(color, opts) {
    opts = opts || {};
    let resolved = color;
    if (color === 'random') resolved = Math.random() < 0.5 ? 'white' : 'black';
    for (const b of document.querySelectorAll('.color-btn')) {
      b.classList.toggle('active', b.dataset.color === color);
    }
    playerColor = resolved === 'white' ? 'w' : 'b';
    if (!opts.keepOrientation) orientation = playerColor;
    try { localStorage.setItem('chess.color', color); } catch {}
  }

  function newGame() {
    aiSearchToken++;
    aiBusy = false;
    thinkOver.classList.add('hidden');
    aiStateEl.textContent = 'Bereit';
    game.reset();
    selectedSquare = null;
    legalForSelected = [];
    lastMove = null;
    pendingPromotion = null;
    document.getElementById('promoModal').classList.add('hidden');
    document.getElementById('overModal').classList.add('hidden');
    renderBoard();
    if (game.turn() !== playerColor) {
      scheduleAIMove();
    }
  }

  function confirmDiscard() {
    if (game.history().length === 0) return true;
    return confirm('Aktuelle Partie verwerfen und neu starten?');
  }

  // ====== Init ======
  function init() {
    // Gespeicherte Einstellungen laden
    let savedDiff = 2;
    try { savedDiff = parseInt(localStorage.getItem('chess.difficulty') || '2', 10); } catch {}
    if (!(savedDiff >= 1 && savedDiff <= 4)) savedDiff = 2;
    let savedColor = 'white';
    try { savedColor = localStorage.getItem('chess.color') || 'white'; } catch {}

    setDifficulty(savedDiff);
    setColor(savedColor);

    // Difficulty-Buttons
    document.querySelectorAll('.diff-btn').forEach(b => {
      b.addEventListener('click', () => setDifficulty(+b.dataset.level));
    });

    // Color-Buttons → starten neue Partie nach Bestätigung
    document.querySelectorAll('.color-btn').forEach(b => {
      b.addEventListener('click', () => {
        const target = b.dataset.color;
        if (!confirmDiscard()) return;
        setColor(target);
        newGame();
      });
    });

    document.getElementById('btnNew').addEventListener('click', () => {
      if (!confirmDiscard()) return;
      // Bei "random" jedes Mal neu würfeln:
      const saved = (function(){ try { return localStorage.getItem('chess.color'); } catch { return null; } })();
      if (saved === 'random') setColor('random');
      newGame();
    });
    document.getElementById('btnUndo').addEventListener('click', doUndo);
    document.getElementById('btnFlip').addEventListener('click', () => {
      orientation = orientation === 'w' ? 'b' : 'w';
      renderBoard();
    });
    document.getElementById('btnHint').addEventListener('click', doHint);

    const optA = document.getElementById('optAnimate');
    try {
      const stored = localStorage.getItem('chess.animate');
      if (stored !== null) optA.checked = stored === '1';
      animationsEnabled = optA.checked;
    } catch {}
    optA.addEventListener('change', () => {
      animationsEnabled = optA.checked;
      try { localStorage.setItem('chess.animate', animationsEnabled ? '1' : '0'); } catch {}
    });

    // Regeln / Game-Over Modale
    document.getElementById('btnRules').addEventListener('click', () => {
      document.getElementById('rulesModal').classList.remove('hidden');
    });
    document.getElementById('rulesClose').addEventListener('click', () => {
      document.getElementById('rulesModal').classList.add('hidden');
    });
    document.getElementById('overClose').addEventListener('click', () => {
      document.getElementById('overModal').classList.add('hidden');
    });
    document.getElementById('overNew').addEventListener('click', () => {
      document.getElementById('overModal').classList.add('hidden');
      newGame();
    });

    // Brett-Click & Resize
    boardEl.addEventListener('click', handleBoardClick);
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderBoard, 100);
    });

    // ESC schließt Promo-Auswahl ist nicht erlaubt (Pflicht zur Wahl),
    // aber ESC schließt Regeln + Game-Over.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('rulesModal').classList.add('hidden');
        document.getElementById('overModal').classList.add('hidden');
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doUndo();
      }
    });

    // Erstes Rendering und ggf. AI-Eröffnung
    renderBoard();
    if (game.turn() !== playerColor) {
      scheduleAIMove();
    }
  }

  // chess.js bietet `Chess` als globalen Konstruktor (UMD-Build).
  if (typeof Chess !== 'function') {
    document.body.innerHTML =
      '<div style="padding:2rem;color:#fff;font-family:sans-serif">' +
      'Fehler: chess.js konnte nicht geladen werden. Bitte Verbindung prüfen.' +
      '</div>';
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
