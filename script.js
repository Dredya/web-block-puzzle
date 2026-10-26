/*!
 * Block Blast — a colorful 8×8 block puzzle
 * Vanilla HTML + CSS + JavaScript. No frameworks, no build tools, no dependencies.
 *
 * Architecture (top to bottom):
 *   1. Pure game logic — board math, piece shapes, line clears, solvability, scoring.
 *   2. Persistence helpers and the Web Audio sound engine.
 *   3. DOM references and game state.
 *   4. Rendering — board, tray, overlays, particles.
 *   5. Pointer input (mouse + touch) with a snapped ghost preview.
 *   6. Game flow — placement, clears, combos, game over.
 *   7. Bootstrap.
 */
(() => {
  'use strict';

  /* ====================================================================== */
  /* 1. PURE GAME LOGIC                                                     */
  /* Everything in this block is DOM-free and unit-testable.                */
  /* ====================================================================== */

  /* CORE:START */
  const SIZE = 8;
  const CELL_COUNT = SIZE * SIZE;
  const CELL_POINTS = 2;         // points awarded for every block placed
  const MAX_SET_ATTEMPTS = 24;   // rejection-sampling limit for fair piece sets
  const SOLVE_BUDGET = 4000;     // max search nodes for the solvability check

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  const boardIndex = (row, col) => row * SIZE + col;
  const insideBoard = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;

  /**
   * Piece families. `weight` is the relative chance of drawing the family;
   * rotations split that weight evenly. Small pieces are heavily favoured so
   * the board stays playable, while every shape from the brief is included.
   */
  const PIECE_FAMILIES = [
    { id: 'dot', name: 'Dot', weight: 10, color: '#ffd166', bases: [[[0, 0]]] },
    { id: 'domino', name: 'Domino', weight: 22, color: '#4cc9f0', bases: [[[0, 0], [0, 1]]] },
    { id: 'triple', name: 'Triple', weight: 16, color: '#4ade80', bases: [[[0, 0], [0, 1], [0, 2]]] },
    { id: 'quad', name: 'Quad', weight: 10, color: '#fb923c', bases: [[[0, 0], [0, 1], [0, 2], [0, 3]]] },
    { id: 'quint', name: 'Quint', weight: 5, color: '#c084fc', bases: [[[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]] },
    { id: 'square2', name: 'Square', weight: 12, color: '#f472b6', bases: [[[0, 0], [0, 1], [1, 0], [1, 1]]] },
    {
      id: 'square3',
      name: 'Big square',
      weight: 3,
      color: '#f87171',
      bases: [[[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]]],
    },
    { id: 'L4', name: 'L', weight: 9, color: '#38bdf8', bases: [[[0, 0], [1, 0], [2, 0], [2, 1]]] },
    { id: 'corner3', name: 'Corner', weight: 18, color: '#facc15', bases: [[[0, 0], [1, 0], [1, 1]]] },
    { id: 'T4', name: 'T', weight: 7, color: '#a3e635', bases: [[[0, 0], [0, 1], [0, 2], [1, 1]]] },
    {
      id: 'SZ',
      name: 'S/Z',
      weight: 7,
      color: '#22d3ee',
      bases: [
        [[0, 1], [0, 2], [1, 0], [1, 1]],
        [[0, 0], [0, 1], [1, 1], [1, 2]],
      ],
    },
  ];

  /** Move a shape so its bounding box starts at (0, 0) and sort its cells. */
  function normalizeCells(cells) {
    const minRow = Math.min(...cells.map(([row]) => row));
    const minCol = Math.min(...cells.map(([, col]) => col));
    return cells
      .map(([row, col]) => [row - minRow, col - minCol])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  /** Rotate a normalized shape 90° clockwise inside its bounding box. */
  function rotateClockwise(cells) {
    const height = Math.max(...cells.map(([row]) => row)) + 1;
    return normalizeCells(cells.map(([row, col]) => [col, height - 1 - row]));
  }

  function cellsKey(cells) {
    return cells.map(([row, col]) => `${row},${col}`).join(';');
  }

  /** All distinct rotations of a shape (1–4), including the original. */
  function uniqueRotations(cells) {
    const rotations = [];
    const seen = new Set();
    let current = normalizeCells(cells);
    for (let i = 0; i < 4; i += 1) {
      const key = cellsKey(current);
      if (!seen.has(key)) {
        seen.add(key);
        rotations.push(current);
      }
      current = rotateClockwise(current);
    }
    return rotations;
  }

  /**
   * Expand families into concrete piece types. Each type has a stable key,
   * bounding box, color and weight; pieces are never rotated during play.
   */
  const PIECE_TYPES = [];
  for (const family of PIECE_FAMILIES) {
    const unique = [];
    const seen = new Set();
    for (const base of family.bases) {
      for (const cells of uniqueRotations(base)) {
        const key = cellsKey(cells);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(cells);
      }
    }
    for (const cells of unique) {
      const width = Math.max(...cells.map(([, col]) => col)) + 1;
      const height = Math.max(...cells.map(([row]) => row)) + 1;
      PIECE_TYPES.push({
        key: `${family.id}:${cellsKey(cells)}`,
        family: family.id,
        name: family.name,
        color: family.color,
        cells,
        width,
        height,
        weight: family.weight / unique.length,
      });
    }
  }

  const TOTAL_WEIGHT = PIECE_TYPES.reduce((sum, piece) => sum + piece.weight, 0);

  /** Pick a random piece type using the weighted table. */
  function randomPiece() {
    let ticket = Math.random() * TOTAL_WEIGHT;
    for (const piece of PIECE_TYPES) {
      ticket -= piece.weight;
      if (ticket <= 0) return piece;
    }
    return PIECE_TYPES[PIECE_TYPES.length - 1];
  }

  function createEmptyBoard() {
    return new Array(CELL_COUNT).fill(null);
  }

  /** True when every cell of `piece` is on the board and on an empty square. */
  function canPlace(board, piece, row, col) {
    if (row < 0 || col < 0 || row + piece.height > SIZE || col + piece.width > SIZE) return false;
    for (const [cellRow, cellCol] of piece.cells) {
      if (board[boardIndex(row + cellRow, col + cellCol)]) return false;
    }
    return true;
  }

  /** Every legal top-left position for a piece, in row-major order. */
  function findPlacements(board, piece) {
    const placements = [];
    for (let row = 0; row <= SIZE - piece.height; row += 1) {
      for (let col = 0; col <= SIZE - piece.width; col += 1) {
        if (canPlace(board, piece, row, col)) placements.push([row, col]);
      }
    }
    return placements;
  }

  /** All full rows and full columns on the board. */
  function getFullLines(board) {
    const rows = [];
    const cols = [];
    for (let row = 0; row < SIZE; row += 1) {
      let full = true;
      for (let col = 0; col < SIZE; col += 1) {
        if (!board[boardIndex(row, col)]) {
          full = false;
          break;
        }
      }
      if (full) rows.push(row);
    }
    for (let col = 0; col < SIZE; col += 1) {
      let full = true;
      for (let row = 0; row < SIZE; row += 1) {
        if (!board[boardIndex(row, col)]) {
          full = false;
          break;
        }
      }
      if (full) cols.push(col);
    }
    return { rows, cols };
  }

  /** Flat indices covered by the supplied rows and columns (deduplicated). */
  function getClearedIndices(rows, cols) {
    const indices = new Set();
    for (const row of rows) {
      for (let col = 0; col < SIZE; col += 1) indices.add(boardIndex(row, col));
    }
    for (const col of cols) {
      for (let row = 0; row < SIZE; row += 1) indices.add(boardIndex(row, col));
    }
    return indices;
  }

  /** Immutable "what if" placement used by the solvability search. */
  function simulatePlacement(board, piece, row, col) {
    const next = board.slice();
    for (const [cellRow, cellCol] of piece.cells) {
      next[boardIndex(row + cellRow, col + cellCol)] = 1;
    }
    const { rows, cols } = getFullLines(next);
    if (rows.length || cols.length) {
      for (const index of getClearedIndices(rows, cols)) next[index] = null;
    }
    return next;
  }

  /**
   * Depth-first search: can all pieces be placed in some order, with lines
   * clearing as they normally would? Memoisation plus a node budget keeps this
   * fast enough to run whenever a fresh trio is generated. A false negative
   * only costs a slightly less fair set, never a broken game.
   */
  function isSetSolvable(board, pieces, budget = SOLVE_BUDGET) {
    let nodes = 0;
    const deadEnds = new Set();

    function search(currentBoard, remaining) {
      if (remaining.length === 0) return true;
      nodes += 1;
      if (nodes > budget) return false;

      const memoKey =
        currentBoard.map((cell) => (cell ? '1' : '0')).join('') +
        '|' +
        remaining.map((piece) => piece.key).sort().join(',');
      if (deadEnds.has(memoKey)) return false;
      deadEnds.add(memoKey);

      const options = [];
      for (let index = 0; index < remaining.length; index += 1) {
        const placements = findPlacements(currentBoard, remaining[index]);
        if (placements.length > 0) {
          options.push({ index, piece: remaining[index], placements });
        }
      }
      // Trying the most constrained piece first prunes the tree dramatically.
      options.sort((a, b) => a.placements.length - b.placements.length);

      for (const option of options) {
        const rest = remaining.filter((_, index) => index !== option.index);
        for (const [row, col] of option.placements) {
          const nextBoard = simulatePlacement(currentBoard, option.piece, row, col);
          if (search(nextBoard, rest)) return true;
        }
      }
      return false;
    }

    return search(board.slice(), pieces.slice());
  }

  /**
   * Build a fair trio. Try random sets and accept the first one that can be
   * fully played out; if the board is too crowded for any trio to be solvable,
   * fall back to the candidate with the most placeable pieces. A short time cap
   * guarantees generation never stalls a turn.
   */
  function generatePieceSet(board) {
    let fallback = null;
    let fallbackFit = -1;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

    for (let attempt = 0; attempt < MAX_SET_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const elapsed =
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
        if (elapsed > 150) break;
      }

      const set = [randomPiece(), randomPiece(), randomPiece()];
      const fitCount = set.reduce(
        (count, piece) => count + (findPlacements(board, piece).length > 0 ? 1 : 0),
        0,
      );
      if (fitCount === 0) {
        if (!fallback) fallback = set;
        continue;
      }
      if (isSetSolvable(board, set)) return set;
      if (fitCount > fallbackFit) {
        fallback = set;
        fallbackFit = fitCount;
      }
    }

    return fallback || [randomPiece(), randomPiece(), randomPiece()];
  }

  // Bonus for clearing N lines at once, before the combo multiplier is applied.
  const LINE_SCORES = [0, 20, 50, 90, 140, 200, 270, 350, 440];

  function lineClearBase(lineCount) {
    if (lineCount <= 0) return 0;
    if (lineCount < LINE_SCORES.length) return LINE_SCORES[lineCount];
    return LINE_SCORES[LINE_SCORES.length - 1] + (lineCount - LINE_SCORES.length + 1) * 100;
  }
  /* CORE:END */

  /* ====================================================================== */
  /* 2. PERSISTENCE + SOUND                                                 */
  /* ====================================================================== */

  const STORAGE_BEST = 'blockblast.best.v1';
  const STORAGE_MUTED = 'blockblast.muted.v1';

  function readStoredNumber(key, fallback) {
    try {
      const parsed = Number.parseInt(window.localStorage.getItem(key), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function readStoredFlag(key) {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* Storage can be unavailable (private mode, disabled cookies). */
    }
  }

  function formatNumber(value) {
    return Number(value).toLocaleString('en-US');
  }

  /**
   * Tiny Web Audio synthesizer. Every sound is generated from oscillators, so
   * the game ships without audio files. The context is created lazily on the
   * first user gesture, as required by browser autoplay policies.
   */
  const Sound = (() => {
    let ctx = null;
    let muted = readStoredFlag(STORAGE_MUTED);

    function getContext() {
      if (muted) return null;
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      if (!ctx) {
        try {
          ctx = new AudioCtor();
        } catch {
          return null;
        }
      }
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      return ctx;
    }

    function tone(frequency, duration, options = {}) {
      const audio = getContext();
      if (!audio) return;
      const { type = 'sine', gain = 0.08, delay = 0, endFrequency = null } = options;
      const startAt = audio.currentTime + delay;
      const oscillator = audio.createOscillator();
      const amplifier = audio.createGain();

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, startAt);
      if (endFrequency) {
        oscillator.frequency.exponentialRampToValueAtTime(
          Math.max(20, endFrequency),
          startAt + duration,
        );
      }

      amplifier.gain.setValueAtTime(0.0001, startAt);
      amplifier.gain.exponentialRampToValueAtTime(gain, startAt + 0.012);
      amplifier.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

      oscillator.connect(amplifier).connect(audio.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration + 0.03);
    }

    return {
      unlock() {
        getContext();
      },
      place() {
        tone(300, 0.1, { type: 'triangle', gain: 0.055, endFrequency: 140 });
        tone(620, 0.06, { type: 'sine', gain: 0.022, delay: 0.01 });
      },
      clear(lines, combo) {
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        const count = Math.min(notes.length, Math.max(1, lines));
        const shift = Math.min(0.25, (Math.max(1, combo) - 1) * 0.05);
        for (let i = 0; i < count; i += 1) {
          tone(notes[i] * (1 + shift), 0.17, {
            type: 'triangle',
            gain: 0.055,
            delay: i * 0.055,
          });
        }
      },
      gameOver() {
        [392, 311.13, 233.08].forEach((frequency, index) => {
          tone(frequency, 0.34, {
            type: 'sawtooth',
            gain: 0.03,
            delay: index * 0.15,
            endFrequency: frequency * 0.94,
          });
        });
      },
      ui() {
        tone(880, 0.05, { type: 'sine', gain: 0.02 });
      },
      isMuted() {
        return muted;
      },
      toggle() {
        muted = !muted;
        writeStorage(STORAGE_MUTED, muted ? '1' : '0');
        if (!muted) {
          tone(880, 0.06, { type: 'sine', gain: 0.025 });
        }
        return muted;
      },
    };
  })();

  /* ====================================================================== */
  /* 3. DOM REFERENCES AND STATE                                            */
  /* ====================================================================== */

  const appEl = document.getElementById('app');
  const boardEl = document.getElementById('board');
  const boardWrap = document.getElementById('boardWrap');
  const boardArea = document.getElementById('boardArea');
  const fxLayer = document.getElementById('fxLayer');
  const trayEl = document.getElementById('tray');
  const scoreEl = document.getElementById('scoreValue');
  const bestEl = document.getElementById('bestValue');
  const overlayEl = document.getElementById('gameOverOverlay');
  const finalScoreEl = document.getElementById('finalScore');
  const finalBestEl = document.getElementById('finalBest');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const restartBtn = document.getElementById('restartBtn');
  const soundBtn = document.getElementById('soundBtn');
  const dragLayer = document.getElementById('dragLayer');
  const liveRegion = document.getElementById('liveRegion');

  const cellEls = [];
  const slotEls = [];

  const state = {
    board: createEmptyBoard(),
    pieces: [null, null, null],
    score: 0,
    shownScore: 0,
    best: readStoredNumber(STORAGE_BEST, 0),
    bestAtStart: 0,
    combo: 0,
    busy: false,
    gameOver: false,
    drag: null,
    metrics: null,
    session: 0,
  };

  let boardObserver = null;
  let layoutRaf = 0;
  let scoreRaf = 0;
  let finalScoreRaf = 0;

  /* ====================================================================== */
  /* 4. LAYOUT + RENDERING                                                  */
  /* ====================================================================== */

  function buildBoard() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const fill = document.createElement('div');
      fill.className = 'cell-fill';
      cell.appendChild(fill);
      cellEls.push(cell);
      fragment.appendChild(cell);
    }
    boardEl.appendChild(fragment);
  }

  function buildTray() {
    for (let index = 0; index < 3; index += 1) {
      const slot = document.createElement('div');
      slot.className = 'tray-slot';
      slot.dataset.slot = String(index);
      slot.setAttribute('role', 'group');
      slot.setAttribute('aria-label', `Piece slot ${index + 1}`);
      trayEl.appendChild(slot);
      slotEls.push(slot);
    }
  }

  /** Measure the live board grid so drag snapping always matches the screen. */
  function measureBoard() {
    if (!cellEls.length) return null;
    const first = cellEls[0].getBoundingClientRect();
    const second = cellEls[1].getBoundingClientRect();
    const last = cellEls[CELL_COUNT - 1].getBoundingClientRect();
    if (!first.width) return null;
    const gap = Math.max(0, second.left - first.right);
    return {
      cell: first.width,
      gap,
      stride: first.width + gap,
      originX: first.left,
      originY: first.top,
      right: last.right,
      bottom: last.bottom,
    };
  }

  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = window.requestAnimationFrame(() => {
      layoutRaf = 0;
      layout();
    });
  }

  /**
   * Fit the board into the space left over by the HUD and tray. Using the live
   * flex box (instead of manual viewport math) keeps portrait, landscape,
   * tablets and desktop all correct without media-query guesswork.
   */
  function layout() {
    cancelDrag();
    const area = boardArea.getBoundingClientRect();
    if (!area.width || !area.height) return;

    const size = Math.floor(Math.min(area.width, area.height, 600));
    const nextSize = `${Math.max(180, size)}px`;
    const sizeChanged = boardWrap.style.getPropertyValue('--size') !== nextSize;
    boardWrap.style.setProperty('--size', nextSize);

    const metrics = measureBoard();
    if (!metrics) return;
    state.metrics = metrics;

    // Re-rendering the tray is only needed when the board geometry changed.
    // Skipping it otherwise preserves the tray's entrance animation.
    if (sizeChanged && state.pieces.some(Boolean)) renderTray();
  }

  function renderBoard() {
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const color = state.board[index];
      const cell = cellEls[index];
      if (color) {
        cell.firstElementChild.style.setProperty('--c', color);
        cell.classList.add('filled');
      } else {
        cell.classList.remove('filled');
      }
    }
  }

  /** Smallest grid of square cells representing a piece (used by tray + ghost). */
  function createPieceGrid(piece, cellSize, gap, radius, className) {
    const filled = new Set(piece.cells.map(([row, col]) => row * piece.width + col));
    const grid = document.createElement('div');
    grid.className = className;
    grid.style.gridTemplateColumns = `repeat(${piece.width}, ${cellSize}px)`;
    grid.style.gridTemplateRows = `repeat(${piece.height}, ${cellSize}px)`;
    grid.style.gap = `${gap}px`;

    for (let row = 0; row < piece.height; row += 1) {
      for (let col = 0; col < piece.width; col += 1) {
        const cell = document.createElement('div');
        cell.className = 'piece-cell';
        if (filled.has(row * piece.width + col)) {
          cell.classList.add('on');
          cell.style.setProperty('--c', piece.color);
        }
        cell.style.borderRadius = `${radius}px`;
        grid.appendChild(cell);
      }
    }
    return grid;
  }

  function renderTray(animateIn = false) {
    const metrics = state.metrics || measureBoard();
    if (!metrics) return;
    const cellSize = Math.max(9, Math.min(28, metrics.cell * 0.46));
    const gap = Math.max(1, cellSize * 0.09);
    const radius = Math.max(3, cellSize * 0.22);

    for (let index = 0; index < slotEls.length; index += 1) {
      const slot = slotEls[index];
      const piece = state.pieces[index];
      slot.classList.remove('slot-active');
      slot.classList.toggle('slot-empty', !piece);
      slot.replaceChildren();
      if (!piece) continue;

      const pieceEl = createPieceGrid(piece, cellSize, gap, radius, 'tray-piece');
      pieceEl.dataset.slot = String(index);
      pieceEl.setAttribute('role', 'img');
      pieceEl.setAttribute('aria-label', `${piece.name} piece, ${piece.cells.length} blocks`);
      if (findPlacements(state.board, piece).length === 0) {
        pieceEl.classList.add('unplaceable');
      }
      if (animateIn) {
        pieceEl.classList.add('tray-in');
        pieceEl.style.animationDelay = `${index * 55}ms`;
      }
      slot.appendChild(pieceEl);
    }
  }

  function clearPreview() {
    for (const cell of cellEls) {
      if (cell.classList.contains('preview-ok') || cell.classList.contains('preview-bad')) {
        cell.classList.remove('preview-ok', 'preview-bad');
        cell.style.removeProperty('--preview-color');
      }
    }
  }

  function showPreview(piece, row, col, valid) {
    clearPreview();
    for (const [cellRow, cellCol] of piece.cells) {
      const boardRow = row + cellRow;
      const boardCol = col + cellCol;
      if (!insideBoard(boardRow, boardCol)) continue;
      const cell = cellEls[boardIndex(boardRow, boardCol)];
      cell.classList.add(valid ? 'preview-ok' : 'preview-bad');
      cell.style.setProperty('--preview-color', piece.color);
    }
  }

  /** Centre of the given cell indices, in board-wrap coordinates (for popups). */
  function pointFromCells(indices) {
    const wrapRect = boardWrap.getBoundingClientRect();
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const index of indices) {
      const rect = cellEls[index].getBoundingClientRect();
      sumX += rect.left + rect.width / 2 - wrapRect.left;
      sumY += rect.top + rect.height / 2 - wrapRect.top;
      count += 1;
    }
    if (!count) return { x: wrapRect.width / 2, y: wrapRect.height / 2 };
    return { x: sumX / count, y: sumY / count };
  }

  function showScorePopup(x, y, text) {
    const el = document.createElement('div');
    el.className = 'score-pop';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    fxLayer.appendChild(el);
    window.setTimeout(() => el.remove(), 960);
  }

  function showComboPopup(combo) {
    const el = document.createElement('div');
    el.className = 'combo-pop';
    el.textContent = `Combo x${combo}!`;
    fxLayer.appendChild(el);
    window.setTimeout(() => el.remove(), 960);
  }

  function announce(message) {
    liveRegion.textContent = message;
  }

  /* ====================================================================== */
  /* 5. SCORING                                                             */
  /* ====================================================================== */

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
  }

  function animateScore() {
    window.cancelAnimationFrame(scoreRaf);
    const target = state.score;
    const from = state.shownScore;
    if (from === target) {
      scoreEl.textContent = formatNumber(target);
      return;
    }
    if (prefersReducedMotion()) {
      state.shownScore = target;
      scoreEl.textContent = formatNumber(target);
      return;
    }

    const startedAt = performance.now();
    const duration = Math.min(650, 180 + Math.abs(target - from) * 1.4);

    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      state.shownScore = Math.round(from + (target - from) * eased);
      scoreEl.textContent = formatNumber(state.shownScore);
      if (progress < 1) {
        scoreRaf = window.requestAnimationFrame(tick);
      } else {
        state.shownScore = target;
        scoreEl.textContent = formatNumber(target);
      }
    };

    scoreRaf = window.requestAnimationFrame(tick);
  }

  function addScore(points) {
    if (points <= 0) return;
    state.score += points;

    if (state.score > state.best) {
      state.best = state.score;
      bestEl.textContent = formatNumber(state.best);
      writeStorage(STORAGE_BEST, String(state.best));
      bestEl.classList.remove('bump');
      // Force a reflow so the animation restarts on every new record.
      void bestEl.offsetWidth;
      bestEl.classList.add('bump');
    }
    animateScore();
  }

  /* ====================================================================== */
  /* 6. GAME FLOW — placement, clears, combos, game over                    */
  /* ====================================================================== */

  function newGame() {
    state.session += 1;
    const wasOverlayOpen = !overlayEl.hidden;
    cancelDrag();
    window.cancelAnimationFrame(scoreRaf);
    window.cancelAnimationFrame(finalScoreRaf);

    state.board = createEmptyBoard();
    state.score = 0;
    state.shownScore = 0;
    state.combo = 0;
    state.busy = false;
    state.gameOver = false;
    state.bestAtStart = state.best;

    overlayEl.classList.remove('is-visible');
    overlayEl.hidden = true;
    appEl.removeAttribute('inert');
    scoreEl.textContent = '0';
    bestEl.textContent = formatNumber(state.best);
    bestEl.classList.remove('bump');
    finalScoreEl.textContent = '0';

    for (const cell of cellEls) {
      cell.classList.remove('pop', 'clearing', 'preview-ok', 'preview-bad');
      cell.style.removeProperty('--preview-color');
    }
    boardEl.classList.remove('shake');
    fxLayer.replaceChildren();
    clearPreview();

    state.pieces = generatePieceSet(state.board);
    renderBoard();
    renderTray(true);
    updateSoundButton();
    checkGameOver();

    if (wasOverlayOpen) {
      restartBtn.focus({ preventScroll: true });
    }
  }

  function commitPlacement(slotIndex, piece, row, col) {
    const session = state.session;
    state.busy = true;
    state.pieces[slotIndex] = null;

    const placedCells = [];
    for (const [cellRow, cellCol] of piece.cells) {
      const index = boardIndex(row + cellRow, col + cellCol);
      state.board[index] = piece.color;
      placedCells.push(index);
    }

    renderBoard();
    renderTray();
    for (const index of placedCells) cellEls[index].classList.add('pop');
    window.setTimeout(() => {
      if (session !== state.session) return;
      for (const index of placedCells) cellEls[index].classList.remove('pop');
    }, 280);

    Sound.place();
    addScore(piece.cells.length * CELL_POINTS);

    const { rows, cols } = getFullLines(state.board);
    const lineCount = rows.length + cols.length;

    if (lineCount > 0) {
      state.combo += 1;
      const bonus = lineClearBase(lineCount) * Math.max(1, state.combo);
      const clearSet = getClearedIndices(rows, cols);
      window.setTimeout(() => {
        if (session !== state.session) return;
        startClearAnimation(clearSet, lineCount, bonus, state.combo);
      }, 110);
    } else {
      state.combo = 0;
      window.setTimeout(() => {
        if (session !== state.session) return;
        finishTurn();
      }, 150);
    }
  }

  function startClearAnimation(clearSet, lineCount, bonus, combo) {
    const session = state.session;
    const popupPoint = pointFromCells(clearSet);

    for (const index of clearSet) {
      cellEls[index].classList.remove('pop');
      cellEls[index].classList.add('clearing');
    }

    if (lineCount >= 2) {
      boardEl.classList.add('shake');
      window.setTimeout(() => boardEl.classList.remove('shake'), 420);
    }

    Sound.clear(lineCount, combo);
    if (navigator.vibrate) {
      try {
        navigator.vibrate(lineCount >= 2 ? [35, 35, 70] : [30]);
      } catch {
        /* Vibration is optional and may be blocked. */
      }
    }

    window.setTimeout(() => {
      if (session !== state.session) return;

      for (const index of clearSet) {
        state.board[index] = null;
        cellEls[index].classList.remove('clearing');
      }
      renderBoard();
      addScore(bonus);
      showScorePopup(popupPoint.x, popupPoint.y, `+${bonus}`);
      if (combo >= 2) showComboPopup(combo);
      announce(`${lineCount} line${lineCount > 1 ? 's' : ''} cleared. ${bonus} points.`);

      window.setTimeout(() => {
        if (session !== state.session) return;
        finishTurn();
      }, 150);
    }, 330);
  }

  function finishTurn() {
    if (state.gameOver) {
      state.busy = false;
      return;
    }

    if (state.pieces.every((piece) => piece === null)) {
      state.pieces = generatePieceSet(state.board);
      renderTray(true);
    } else {
      renderTray();
    }

    if (!checkGameOver()) {
      state.busy = false;
    }
  }

  function checkGameOver() {
    const remaining = state.pieces.filter(Boolean);
    if (remaining.length === 0) return false;
    const anyFit = remaining.some((piece) => findPlacements(state.board, piece).length > 0);
    if (anyFit) return false;
    endGame();
    return true;
  }

  function endGame() {
    if (state.gameOver) return;
    state.gameOver = true;
    state.busy = true;
    state.combo = 0;
    Sound.gameOver();
    if (navigator.vibrate) {
      try {
        navigator.vibrate([80, 60, 130]);
      } catch {
        /* Vibration is optional and may be blocked. */
      }
    }
    announce(`Game over. Final score ${state.score}.`);

    const session = state.session;
    window.setTimeout(() => {
      if (session !== state.session || !state.gameOver) return;
      showGameOver();
    }, 480);
  }

  function showGameOver() {
    const isNewBest = state.score > state.bestAtStart;
    finalScoreEl.textContent = '0';
    finalBestEl.textContent = isNewBest ? 'New best score!' : `Best: ${formatNumber(state.best)}`;
    finalBestEl.classList.toggle('new-best', isNewBest);

    // Keep keyboard focus inside the dialog while it is open.
    appEl.setAttribute('inert', '');
    overlayEl.hidden = false;
    overlayEl.classList.remove('is-visible');
    void overlayEl.offsetWidth;
    window.requestAnimationFrame(() => overlayEl.classList.add('is-visible'));

    animateFinalScore();
    playAgainBtn.focus({ preventScroll: true });
  }

  function animateFinalScore() {
    window.cancelAnimationFrame(finalScoreRaf);
    const target = state.score;
    if (prefersReducedMotion()) {
      finalScoreEl.textContent = formatNumber(target);
      return;
    }
    const startedAt = performance.now();
    const duration = 650;
    finalScoreEl.textContent = '0';

    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      finalScoreEl.textContent = formatNumber(Math.round(target * eased));
      if (progress < 1) {
        finalScoreRaf = window.requestAnimationFrame(tick);
      } else {
        finalScoreEl.textContent = formatNumber(target);
      }
    };
    finalScoreRaf = window.requestAnimationFrame(tick);
  }

  /* ====================================================================== */
  /* 7. POINTER INPUT — drag & drop with ghost preview                      */
  /* ====================================================================== */

  function getTrayPieceFromEvent(event) {
    const target = event.target instanceof Element ? event.target : null;
    return target ? target.closest('.tray-piece') : null;
  }

  function startDrag(event, slotIndex) {
    const piece = state.pieces[slotIndex];
    const slot = slotEls[slotIndex];
    const trayPiece = slot.querySelector('.tray-piece');
    if (!piece || !trayPiece) return;

    const metrics = measureBoard();
    if (!metrics) return;

    const rect = trayPiece.getBoundingClientRect();
    const grabX = clamp((event.clientX - rect.left) / rect.width, 0.02, 0.98);
    const grabY = clamp((event.clientY - rect.top) / rect.height, 0.02, 0.98);
    const ghostWidth = piece.width * metrics.cell + (piece.width - 1) * metrics.gap;
    const ghostHeight = piece.height * metrics.cell + (piece.height - 1) * metrics.gap;

    const ghost = createPieceGrid(
      piece,
      metrics.cell,
      metrics.gap,
      Math.max(4, metrics.cell * 0.18),
      'drag-piece',
    );
    ghost.style.width = `${ghostWidth}px`;
    ghost.style.height = `${ghostHeight}px`;
    dragLayer.appendChild(ghost);

    trayPiece.classList.add('is-dragging');
    slot.classList.add('slot-active');
    document.body.classList.add('dragging');

    const drag = {
      slotIndex,
      piece,
      pointerId: event.pointerId,
      ghost,
      ghostWidth,
      ghostHeight,
      grabX,
      grabY,
      metrics,
      // Touch drags are lifted so the finger does not hide the preview.
      lift: event.pointerType === 'mouse' ? 0 : metrics.cell * 1.1,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      preview: null,
    };
    state.drag = drag;

    event.preventDefault();
    Sound.unlock();
    updateDragPosition(drag, event.clientX, event.clientY);

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function updateDragPosition(drag, clientX, clientY) {
    const { metrics, piece, ghost } = drag;
    const anchorX = clientX;
    const anchorY = clientY - drag.lift;
    const rawLeft = anchorX - drag.grabX * drag.ghostWidth;
    const rawTop = anchorY - drag.grabY * drag.ghostHeight;

    // Until the pointer has actually moved, just show the piece hovering.
    if (!drag.moved) {
      ghost.classList.add('free');
      ghost.classList.remove('invalid');
      ghost.style.left = `${rawLeft}px`;
      ghost.style.top = `${rawTop}px`;
      drag.preview = null;
      clearPreview();
      return;
    }

    const margin = metrics.cell;
    const overBoard =
      anchorX >= metrics.originX - margin &&
      anchorX <= metrics.right + margin &&
      anchorY >= metrics.originY - margin &&
      anchorY <= metrics.bottom + margin;

    if (!overBoard) {
      ghost.classList.add('free');
      ghost.classList.remove('invalid');
      ghost.style.left = `${rawLeft}px`;
      ghost.style.top = `${rawTop}px`;
      drag.preview = null;
      clearPreview();
      return;
    }

    // Snap the top-left corner to the nearest grid cell, clamped inside the
    // board so edge drops still land fully on the board.
    const rawCol = (rawLeft - metrics.originX) / metrics.stride;
    const rawRow = (rawTop - metrics.originY) / metrics.stride;
    const col = clamp(Math.round(rawCol), 0, SIZE - piece.width);
    const row = clamp(Math.round(rawRow), 0, SIZE - piece.height);
    const valid = canPlace(state.board, piece, row, col);

    ghost.classList.remove('free');
    ghost.classList.toggle('invalid', !valid);
    ghost.style.left = `${metrics.originX + col * metrics.stride}px`;
    ghost.style.top = `${metrics.originY + row * metrics.stride}px`;

    drag.preview = { row, col, valid };
    showPreview(piece, row, col, valid);
  }

  function onPointerMove(event) {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    if (!drag.moved) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (dx * dx + dy * dy > 36) drag.moved = true;
    }
    updateDragPosition(drag, event.clientX, event.clientY);
  }

  function teardownDrag(drag, keepPieceHidden = false) {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    document.body.classList.remove('dragging');
    clearPreview();

    if (!keepPieceHidden) {
      const trayPiece = slotEls[drag.slotIndex].querySelector('.tray-piece');
      if (trayPiece) trayPiece.classList.remove('is-dragging');
    }
    slotEls[drag.slotIndex].classList.remove('slot-active');

    if (state.drag === drag) state.drag = null;
  }

  function returnGhostToSlot(drag) {
    const ghost = drag.ghost;
    const slot = slotEls[drag.slotIndex];
    const slotRect = slot.getBoundingClientRect();
    const targetLeft = slotRect.left + (slotRect.width - drag.ghostWidth) / 2;
    const targetTop = slotRect.top + (slotRect.height - drag.ghostHeight) / 2;

    const trayPiece = slot.querySelector('.tray-piece');
    if (trayPiece) trayPiece.classList.add('is-dragging');

    ghost.classList.remove('invalid', 'free');
    ghost.classList.add('returning');
    ghost.style.left = `${targetLeft}px`;
    ghost.style.top = `${targetTop}px`;
    ghost.style.transform = 'scale(0.55)';
    ghost.style.opacity = '0';

    window.setTimeout(() => {
      ghost.remove();
      const newerDragOnSameSlot = state.drag && state.drag.slotIndex === drag.slotIndex;
      if (trayPiece && trayPiece.isConnected && !newerDragOnSameSlot) {
        trayPiece.classList.remove('is-dragging');
      }
    }, 230);
  }

  function onPointerUp(event) {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const isCancel = event.type === 'pointercancel';

    // Re-evaluate using the release coordinates: the final pointermove can be
    // coalesced or missing, so a stale preview must not decide the drop.
    if (!isCancel) updateDragPosition(drag, event.clientX, event.clientY);

    const placement = drag.preview;
    const shouldPlace =
      !isCancel &&
      drag.moved &&
      placement !== null &&
      placement.valid &&
      !state.busy &&
      !state.gameOver;

    teardownDrag(drag, !shouldPlace);
    if (shouldPlace) {
      drag.ghost.remove();
      commitPlacement(drag.slotIndex, drag.piece, placement.row, placement.col);
    } else {
      returnGhostToSlot(drag);
    }
  }

  function cancelDrag() {
    const drag = state.drag;
    if (!drag) return;
    teardownDrag(drag, true);
    returnGhostToSlot(drag);
  }

  /* ====================================================================== */
  /* 8. EVENT WIRING + BOOTSTRAP                                            */
  /* ====================================================================== */

  function updateSoundButton() {
    const muted = Sound.isMuted();
    soundBtn.classList.toggle('is-muted', muted);
    soundBtn.setAttribute('aria-pressed', String(muted));
    soundBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    soundBtn.title = muted ? 'Unmute sound (M)' : 'Mute sound (M)';
  }

  function onTrayPointerDown(event) {
    if (state.busy || state.gameOver || state.drag) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    // Start the drag from anywhere in the slot, so small pieces (like the
    // single dot) still have a comfortable touch target.
    let trayPiece = getTrayPieceFromEvent(event);
    if (!trayPiece) {
      const target = event.target instanceof Element ? event.target : null;
      const slot = target ? target.closest('.tray-slot') : null;
      trayPiece = slot ? slot.querySelector('.tray-piece') : null;
    }
    if (!trayPiece) return;
    startDrag(event, Number(trayPiece.dataset.slot));
  }

  function toggleMute() {
    Sound.toggle();
    updateSoundButton();
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.key === 'm' || event.key === 'M') {
      toggleMute();
    } else if (event.key === 'r' || event.key === 'R') {
      newGame();
    } else if (event.key === 'Escape') {
      cancelDrag();
    }
  }

  function bindEvents() {
    trayEl.addEventListener('pointerdown', onTrayPointerDown);
    trayEl.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('dragstart', (event) => event.preventDefault());

    soundBtn.addEventListener('click', toggleMute);
    restartBtn.addEventListener('click', () => {
      Sound.unlock();
      newGame();
    });
    playAgainBtn.addEventListener('click', () => {
      Sound.unlock();
      newGame();
    });

    window.addEventListener('pointerdown', () => Sound.unlock(), { once: true, passive: true });
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('orientationchange', scheduleLayout);
    window.addEventListener('load', scheduleLayout);
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelDrag();
    });
    window.addEventListener('keydown', onKeyDown);

    if (typeof ResizeObserver === 'function') {
      boardObserver = new ResizeObserver(scheduleLayout);
      boardObserver.observe(boardArea);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleLayout).catch(() => {});
    }
  }

  function init() {
    buildBoard();
    buildTray();
    bindEvents();
    updateSoundButton();
    layout();
    newGame();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
