// ===================================================================
//  Stack — flashcards PWA
//  Plain ES2018 JS, no dependencies. Organized in clear sections.
// ===================================================================

// ----------- Constants -----------
const DB_NAME = 'stack-flashcards';
const DB_VERSION = 1;
const DAY = 24 * 60 * 60 * 1000;

// Leitner box intervals — indexed by box number (1–5)
const BOX_INTERVALS = {
  1:  1 * DAY,
  2:  2 * DAY,
  3:  4 * DAY,
  4:  8 * DAY,
  5: 16 * DAY,
};
const MAX_BOX = 5;
const SESSION_CAP = 50;  // safety cap per session

// ===================================================================
//  IndexedDB layer — Promise wrappers over the raw API
// ===================================================================

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('decks')) {
        const deckStore = db.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
        deckStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('cards')) {
        const cardStore = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
        cardStore.createIndex('deckId', 'deckId', { unique: false });
        cardStore.createIndex('nextReviewAt', 'nextReviewAt', { unique: false });
      }
    };
  });
}

function tx(stores, mode = 'readonly') {
  return openDB().then(db => db.transaction(stores, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ----------- Decks -----------
async function listDecks() {
  const t = await tx(['decks']);
  return reqToPromise(t.objectStore('decks').getAll());
}

async function createDeck(name) {
  const t = await tx(['decks'], 'readwrite');
  const id = await reqToPromise(
    t.objectStore('decks').add({ name, createdAt: Date.now() })
  );
  return id;
}

async function getDeck(id) {
  const t = await tx(['decks']);
  return reqToPromise(t.objectStore('decks').get(id));
}

async function renameDeck(id, name) {
  const t = await tx(['decks'], 'readwrite');
  const store = t.objectStore('decks');
  const deck = await reqToPromise(store.get(id));
  if (!deck) return;
  deck.name = name;
  await reqToPromise(store.put(deck));
}

async function deleteDeck(id) {
  // Delete deck + all its cards in one transaction
  const t = await tx(['decks', 'cards'], 'readwrite');
  t.objectStore('decks').delete(id);
  const cardStore = t.objectStore('cards');
  const idx = cardStore.index('deckId');
  const cardKeys = await reqToPromise(idx.getAllKeys(id));
  for (const k of cardKeys) cardStore.delete(k);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ----------- Cards -----------
async function bulkAddCards(deckId, rows) {
  const t = await tx(['cards'], 'readwrite');
  const store = t.objectStore('cards');
  const now = Date.now();
  for (const { front, back } of rows) {
    store.add({
      deckId,
      front,
      back,
      box: 1,
      nextReviewAt: now,  // new cards are immediately due
      createdAt: now,
    });
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(rows.length);
    t.onerror = () => reject(t.error);
  });
}

async function getCardsForDeck(deckId) {
  const t = await tx(['cards']);
  return reqToPromise(t.objectStore('cards').index('deckId').getAll(deckId));
}

async function updateCard(card) {
  const t = await tx(['cards'], 'readwrite');
  return reqToPromise(t.objectStore('cards').put(card));
}

async function deleteCard(cardId) {
  const t = await tx(['cards'], 'readwrite');
  return reqToPromise(t.objectStore('cards').delete(cardId));
}

async function addCard(deckId, front, back) {
  const t = await tx(['cards'], 'readwrite');
  const now = Date.now();
  return reqToPromise(t.objectStore('cards').add({
    deckId, front, back, box: 1, nextReviewAt: now, createdAt: now,
  }));
}

// ===================================================================
//  Leitner algorithm
// ===================================================================

function markCardKnown(card) {
  card.box = Math.min(MAX_BOX, card.box + 1);
  card.nextReviewAt = Date.now() + BOX_INTERVALS[card.box];
  return card;
}

function markCardForgotten(card) {
  card.box = 1;
  card.nextReviewAt = Date.now() + BOX_INTERVALS[1];
  return card;
}

/** Returns cards due now, sorted by lowest box first (most urgent), capped. */
function selectDueCards(allCards, now = Date.now()) {
  const due = allCards
    .filter(c => c.nextReviewAt <= now)
    .sort((a, b) => a.box - b.box || a.nextReviewAt - b.nextReviewAt);
  return due.slice(0, SESSION_CAP);
}

/** Box distribution for a deck — returns [box1count, ..., box5count]. */
function boxDistribution(cards) {
  const dist = [0, 0, 0, 0, 0];
  for (const c of cards) {
    if (c.box >= 1 && c.box <= MAX_BOX) dist[c.box - 1]++;
  }
  return dist;
}

// ===================================================================
//  CSV parser (handles quoted fields, escaped quotes, CRLF)
// ===================================================================

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (field !== '' || row.length > 0) { row.push(field); rows.push(row); row = []; field = ''; }
      }
      else field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Convert parsed CSV rows into card objects, skipping header if present. */
function csvToCards(rows) {
  const filtered = rows.filter(r => r.length >= 2 && (r[0].trim() || r[1].trim()));
  if (filtered.length === 0) return [];
  const first = filtered[0].map(c => c.toLowerCase().trim());
  const skip = (first[0] === 'front' && first[1] === 'back') ? 1 : 0;
  return filtered.slice(skip)
    .map(r => ({ front: r[0].trim(), back: r[1].trim() }))
    .filter(c => c.front || c.back);
}

// ===================================================================
//  PPTX parser — extracts text + bold/italic/underline/color from each
//  slide, then pairs slides (1+2, 3+4, …) into front/back cards.
// ===================================================================

/** Wrap a run's text in HTML tags based on its <a:rPr> properties. */
function pptxFormatRun(text, rPr) {
  if (!text) return '';
  if (!rPr) return text;

  const b = rPr.getAttribute('b');
  const i = rPr.getAttribute('i');
  const u = rPr.getAttribute('u');
  const isBold   = b === '1' || b === 'true';
  const isItalic = i === '1' || i === 'true';
  const isUnder  = u && u !== 'none' && u !== '0';

  // Direct sRGB color via <a:solidFill><a:srgbClr val="HHHHHH"/></a:solidFill>
  let color = null;
  const solidFills = rPr.getElementsByTagNameNS('*', 'solidFill');
  for (let k = 0; k < solidFills.length; k++) {
    const srgb = solidFills[k].getElementsByTagNameNS('*', 'srgbClr');
    if (srgb.length) {
      const val = srgb[0].getAttribute('val');
      if (val && /^[0-9a-fA-F]{6}$/.test(val)) color = '#' + val.toLowerCase();
      break;
    }
  }

  let s = text;
  if (isItalic) s = `<i>${s}</i>`;
  if (isUnder)  s = `<u>${s}</u>`;
  if (isBold)   s = `<b>${s}</b>`;
  if (color && SAFE_COLOR_RE.test(color)) s = `<span style="color:${color}">${s}</span>`;
  return s;
}

/** Extract text from one slide's XML, preserving paragraph breaks and formatting. */
function pptxExtractSlideContent(slideXml) {
  const doc = new DOMParser().parseFromString(slideXml, 'application/xml');
  const txBodies = doc.getElementsByTagNameNS('*', 'txBody');
  const paragraphs = [];

  for (let i = 0; i < txBodies.length; i++) {
    const aps = txBodies[i].getElementsByTagNameNS('*', 'p');
    for (let j = 0; j < aps.length; j++) {
      const ap = aps[j];
      const parts = [];
      const children = ap.childNodes;
      for (let k = 0; k < children.length; k++) {
        const node = children[k];
        if (!node.localName) continue;
        if (node.localName === 'r') {
          const ts = node.getElementsByTagNameNS('*', 't');
          const text = ts.length ? (ts[0].textContent || '') : '';
          const rPrs = node.getElementsByTagNameNS('*', 'rPr');
          const rPr = rPrs.length ? rPrs[0] : null;
          parts.push(pptxFormatRun(text, rPr));
        } else if (node.localName === 'br') {
          parts.push('\n');
        } else if (node.localName === 'fld') {
          const ts = node.getElementsByTagNameNS('*', 't');
          if (ts.length) parts.push(ts[0].textContent || '');
        }
      }
      const line = parts.join('').trim();
      if (line) paragraphs.push(line);
    }
  }
  return paragraphs.join('\n');
}

/** Read PPTX file → ordered array of slide text contents. */
async function parsePPTX(file) {
  if (typeof JSZip === 'undefined') {
    throw new Error('PPTX parser library not loaded');
  }
  const zip = await JSZip.loadAsync(file);

  // 1. Determine slide order from presentation.xml
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error('Not a valid PPTX file (missing presentation.xml)');
  const presXml = await presFile.async('string');
  const presDoc = new DOMParser().parseFromString(presXml, 'application/xml');

  const sldIds = presDoc.getElementsByTagNameNS('*', 'sldId');
  const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const ridList = [];
  for (let i = 0; i < sldIds.length; i++) {
    const rid = sldIds[i].getAttributeNS(RELS_NS, 'id') || sldIds[i].getAttribute('r:id');
    if (rid) ridList.push(rid);
  }

  // 2. Map r:id values → file paths via the relationships file
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!relsFile) throw new Error('Not a valid PPTX file (missing relationships)');
  const relsXml = await relsFile.async('string');
  const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
  const rels = relsDoc.getElementsByTagName('Relationship');
  const ridToPath = {};
  for (let i = 0; i < rels.length; i++) {
    const id = rels[i].getAttribute('Id');
    const target = rels[i].getAttribute('Target');
    if (id && target) {
      ridToPath[id] = target.startsWith('/') ? target.slice(1) : 'ppt/' + target;
    }
  }

  // 3. Extract each slide in order
  const slides = [];
  for (const rid of ridList) {
    const path = ridToPath[rid];
    if (!path) continue;
    const slideFile = zip.file(path);
    if (!slideFile) continue;
    const slideXml = await slideFile.async('string');
    slides.push(pptxExtractSlideContent(slideXml));
  }
  return slides;
}

/** Pair consecutive slides into front/back cards. Odd slide → front, even → back. */
function pptxSlidesToCards(slides) {
  const cards = [];
  for (let i = 0; i + 1 < slides.length; i += 2) {
    const front = slides[i].trim();
    const back = slides[i + 1].trim();
    if (!front && !back) continue;
    cards.push({ front, back });
  }
  const orphan = slides.length % 2 === 1;
  return { cards, orphan };
}

// ===================================================================
//  State + routing
// ===================================================================

const state = {
  view: 'home',         // 'home' | 'study' | 'complete' | 'editor'
  decks: [],            // list of decks (with .cardCount, .dueCount, .boxes computed)
  currentDeck: null,    // active deck object
  session: null,        // { cards: [...], idx, flipped, knew, again }
  editor: null,         // { deck, cards } when in editor view
};

// ===================================================================
//  Utilities
// ===================================================================

function $(id) { return document.getElementById(id); }

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

/**
 * Render rich text from a CSV cell. Supports:
 *   Markdown:  **bold**   *italic*   __underline__
 *   HTML:      <b>/<strong>   <i>/<em>   <u>   <span style="color:NAME_OR_HEX">
 *
 * Safety: everything is HTML-escaped by default. Only the patterns above
 * are converted to real tags. Color values are validated against a strict
 * regex (named colors or hex only — no rgb(), no url(), no expressions).
 */
const SAFE_COLOR_RE = /^(?:[a-z]+|#[0-9a-fA-F]{3,8})$/;
// Use private-use Unicode tokens as placeholders so we can safely escape
// everything else without mangling our own syntax.
const T_OPEN = '\uE000', T_CLOSE = '\uE001';

function renderRichText(text) {
  if (text == null) return '';
  let s = String(text);

  // ---- 1. Accept inline HTML for the whitelisted tags (convert to tokens) ----
  // <b>/<strong>
  s = s.replace(/<(b|strong)\s*>([\s\S]*?)<\/\1\s*>/gi,
    (_, _tag, inner) => `${T_OPEN}b${T_CLOSE}${inner}${T_OPEN}/b${T_CLOSE}`);
  // <i>/<em>
  s = s.replace(/<(i|em)\s*>([\s\S]*?)<\/\1\s*>/gi,
    (_, _tag, inner) => `${T_OPEN}i${T_CLOSE}${inner}${T_OPEN}/i${T_CLOSE}`);
  // <u>
  s = s.replace(/<u\s*>([\s\S]*?)<\/u\s*>/gi,
    (_, inner) => `${T_OPEN}u${T_CLOSE}${inner}${T_OPEN}/u${T_CLOSE}`);
  // <span style="color:VALUE">...</span> — strict color validation
  s = s.replace(
    /<span\s+style\s*=\s*["']\s*color\s*:\s*([^;"'<>]+?)\s*;?\s*["']\s*>([\s\S]*?)<\/span\s*>/gi,
    (whole, color, inner) => {
      const c = color.trim();
      if (!SAFE_COLOR_RE.test(c)) return inner; // invalid color → drop the span, keep the text
      return `${T_OPEN}c:${c}${T_CLOSE}${inner}${T_OPEN}/c${T_CLOSE}`;
    }
  );

  // ---- 2. Apply Markdown syntax (also to tokens) ----
  // Bold first (longest match), then italic, then underline.
  s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g,
    (_, inner) => `${T_OPEN}b${T_CLOSE}${inner}${T_OPEN}/b${T_CLOSE}`);
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    (_, pre, inner) => `${pre}${T_OPEN}i${T_CLOSE}${inner}${T_OPEN}/i${T_CLOSE}`);
  s = s.replace(/__([^_\n]+)__/g,
    (_, inner) => `${T_OPEN}u${T_CLOSE}${inner}${T_OPEN}/u${T_CLOSE}`);

  // ---- 3. Escape ALL remaining HTML special chars (tokens pass through) ----
  s = escapeHTML(s);

  // ---- 4. Replace tokens with real tags ----
  s = s
    .replace(new RegExp(T_OPEN + 'b' + T_CLOSE, 'g'), '<strong>')
    .replace(new RegExp(T_OPEN + '\\/b' + T_CLOSE, 'g'), '</strong>')
    .replace(new RegExp(T_OPEN + 'i' + T_CLOSE, 'g'), '<em>')
    .replace(new RegExp(T_OPEN + '\\/i' + T_CLOSE, 'g'), '</em>')
    .replace(new RegExp(T_OPEN + 'u' + T_CLOSE, 'g'), '<u>')
    .replace(new RegExp(T_OPEN + '\\/u' + T_CLOSE, 'g'), '</u>')
    .replace(new RegExp(T_OPEN + 'c:([^' + T_CLOSE + ']+)' + T_CLOSE, 'g'),
      (_, c) => `<span style="color:${c}">`)
    .replace(new RegExp(T_OPEN + '\\/c' + T_CLOSE, 'g'), '</span>');

  return s;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function formatDue(count) {
  if (count === 0) return 'all caught up';
  return `${count} due`;
}

function relTimeFuture(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'now';
  const days = Math.round(diff / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

// ===================================================================
//  Modal helpers (promise-based for clean async/await usage)
// ===================================================================

function showModal(html) {
  $('modal').innerHTML = html;
  $('modalBackdrop').classList.add('show');
}
function hideModal() {
  $('modalBackdrop').classList.remove('show');
  $('modal').innerHTML = '';
}

function promptText({ title, message, placeholder = '', initial = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    showModal(`
      <h3>${escapeHTML(title)}</h3>
      ${message ? `<p>${escapeHTML(message)}</p>` : ''}
      <input type="text" id="modalInput" placeholder="${escapeHTML(placeholder)}" value="${escapeHTML(initial)}" autocomplete="off">
      <div class="modal-actions">
        <button class="secondary" id="modalCancel">Cancel</button>
        <button class="primary" id="modalOK">${escapeHTML(okLabel)}</button>
      </div>
    `);
    const input = $('modalInput');
    input.focus();
    input.select();
    const ok = () => { const v = input.value.trim(); hideModal(); resolve(v || null); };
    const cancel = () => { hideModal(); resolve(null); };
    $('modalOK').addEventListener('click', ok);
    $('modalCancel').addEventListener('click', cancel);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') ok();
      else if (e.key === 'Escape') cancel();
    });
  });
}

function confirmDialog({ title, message, okLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    showModal(`
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(message)}</p>
      <div class="modal-actions">
        <button class="secondary" id="modalCancel">Cancel</button>
        <button class="${danger ? 'primary' : 'primary'}" id="modalOK" ${danger ? 'style="background:#c14a3a;border-color:#c14a3a;"' : ''}>${escapeHTML(okLabel)}</button>
      </div>
    `);
    $('modalOK').addEventListener('click', () => { hideModal(); resolve(true); });
    $('modalCancel').addEventListener('click', () => { hideModal(); resolve(false); });
  });
}

// ===================================================================
//  Data loading
// ===================================================================

async function loadDeckSummaries() {
  const decks = await listDecks();
  const now = Date.now();
  const enriched = await Promise.all(decks.map(async (d) => {
    const cards = await getCardsForDeck(d.id);
    const futureTimes = cards.filter(c => c.nextReviewAt > now).map(c => c.nextReviewAt);
    return {
      ...d,
      cardCount: cards.length,
      dueCount: cards.filter(c => c.nextReviewAt <= now).length,
      boxes: boxDistribution(cards),
      nextDueAt: futureTimes.length ? Math.min(...futureTimes) : null,
    };
  }));
  // Most recent first
  enriched.sort((a, b) => b.createdAt - a.createdAt);
  state.decks = enriched;
}

// ===================================================================
//  Rendering — home view
// ===================================================================

function renderHome() {
  $('brandHome').style.cursor = 'default';
  $('topMeta').innerHTML = `<span class="label">${state.decks.length} ${state.decks.length === 1 ? 'deck' : 'decks'}</span>`;

  const main = $('main');
  const footer = $('footer');

  if (state.decks.length === 0) {
    main.innerHTML = `
      <div class="home-intro">
        <h1>Begin a <em>stack</em>.</h1>
        <p>Import a <strong>CSV</strong> (front,back columns) or a <strong>PowerPoint</strong> (odd slides become fronts, even slides become backs).</p>
      </div>
      <div class="empty">
        <div class="csv-hint">
          <span class="head">CSV format</span>
          front,back<br>
          Defenestration,Throwing out a window<br>
          Ephemeral,Lasting a short time
        </div>
        <button class="primary" id="emptyImportBtn">Import file</button>
      </div>`;
    footer.innerHTML = '';
    $('emptyImportBtn').addEventListener('click', () => $('fileInput').click());
    return;
  }

  const deckCards = state.decks.map(d => {
    const pips = [1,2,3,4,5].map(b => {
      const has = d.boxes[b-1] > 0;
      return `<div class="box-pip ${has ? 'filled-' + b : ''}" title="Box ${b}: ${d.boxes[b-1]} cards"></div>`;
    }).join('');
    // Show next-due hint when nothing's currently due (and the deck isn't empty)
    const nextDueHint = (d.dueCount === 0 && d.nextDueAt && d.cardCount > 0)
      ? `<span class="next-due">next ${escapeHTML(relTimeFuture(d.nextDueAt))}</span>`
      : '';
    return `
      <div class="deck-card entering" data-id="${d.id}">
        <button class="deck-edit-btn" data-edit-id="${d.id}" aria-label="Edit deck" title="Edit deck">✎</button>
        <div class="deck-card-head">
          <div class="deck-name-display">${escapeHTML(d.name)}</div>
          <div class="deck-due-pill ${d.dueCount === 0 ? 'none' : ''}">${formatDue(d.dueCount)}</div>
        </div>
        <div class="deck-meta">
          <span><strong>${d.cardCount}</strong> ${d.cardCount === 1 ? 'card' : 'cards'}</span>
          ${d.boxes[4] > 0 ? `<span><strong>${d.boxes[4]}</strong> mastered</span>` : ''}
          ${nextDueHint}
        </div>
        <div class="box-bar">${pips}</div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="home-intro">
      <h1>Your <em>stacks</em>.</h1>
    </div>
    <div class="deck-list">${deckCards}</div>
    <div style="margin-top: 1.5rem; text-align: center;">
      <button class="text-btn" id="newDeckBtn">+ Import new deck</button>
    </div>`;

  footer.innerHTML = '';

  // Wire deck taps (tap = study, but edit button stops propagation)
  main.querySelectorAll('.deck-card').forEach(el => {
    el.addEventListener('click', (e) => {
      // Ignore clicks on the edit pencil
      if (e.target.closest('.deck-edit-btn')) return;
      startSession(parseInt(el.dataset.id, 10));
    });
  });
  // Wire edit buttons
  main.querySelectorAll('.deck-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(parseInt(btn.dataset.editId, 10));
    });
  });
  $('newDeckBtn').addEventListener('click', () => $('fileInput').click());
}

// ===================================================================
//  Rendering — study view
// ===================================================================

function renderStudy() {
  const s = state.session;
  const deck = state.currentDeck;
  if (!s || !deck) return renderHome();

  $('brandHome').style.cursor = 'pointer';
  $('topMeta').innerHTML = `
    <span>stack &middot; ${s.idx + 1} / ${s.cards.length}</span>`;

  const card = s.cards[s.idx];
  // Detect multi-line content so we can switch to a left-aligned, list-friendly layout
  const frontMultiline = /\n/.test(card.front) ? ' multiline' : '';
  const backMultiline  = /\n/.test(card.back)  ? ' multiline' : '';
  const sideLabel = s.flipped ? 'Back' : 'Front';
  const sideLabelClass = s.flipped ? 'chrome-side-label is-back' : 'chrome-side-label';
  const hint = s.flipped ? 'Tap to flip back' : 'Tap to reveal';
  const main = $('main');
  main.innerHTML = `
    <div class="study-area">
      <div class="card-chrome-top">
        <span class="${sideLabelClass}">${sideLabel}</span>
        <span class="chrome-meta">
          <span class="box-tag">Box ${card.box}</span>
          <span class="num">№ ${String(s.idx + 1).padStart(2, '0')}</span>
        </span>
      </div>
      <div class="card-frame entering">
        <div class="card ${s.flipped ? 'flipped' : ''}" id="theCard">
          <div class="face front">
            <div class="face-content${frontMultiline}">${renderRichText(card.front)}</div>
          </div>
          <div class="face back">
            <div class="face-content${backMultiline}">${renderRichText(card.back)}</div>
          </div>
        </div>
      </div>
      <div class="card-chrome-bottom">
        <span class="chrome-hint">${hint}</span>
      </div>
    </div>`;

  $('footer').innerHTML = `
    <div class="review-row">
      <button class="review again" id="markAgain"><span class="glyph">×</span>Review again</button>
      <button class="review knew" id="markKnew"><span class="glyph">✓</span>Got it</button>
    </div>
    <div class="ctrl-row">
      <button class="icon-btn" id="prevBtn" ${s.idx === 0 ? 'disabled' : ''} aria-label="Previous">‹</button>
      <div class="center-ctrls">
        <button class="text-btn" id="skipBtn">Skip</button>
      </div>
      <button class="icon-btn" id="nextBtn" ${s.idx === s.cards.length - 1 ? 'disabled' : ''} aria-label="Next">›</button>
    </div>`;

  $('theCard').addEventListener('click', () => { s.flipped = !s.flipped; renderStudy(); });
  $('markAgain').addEventListener('click', () => markAndAdvance(false));
  $('markKnew').addEventListener('click', () => markAndAdvance(true));
  $('prevBtn').addEventListener('click', () => { if (s.idx > 0) { s.idx--; s.flipped = false; renderStudy(); } });
  $('nextBtn').addEventListener('click', () => { if (s.idx < s.cards.length - 1) { s.idx++; s.flipped = false; renderStudy(); } });
  $('skipBtn').addEventListener('click', () => {
    if (s.idx < s.cards.length - 1) { s.idx++; s.flipped = false; renderStudy(); }
    else completeSession();
  });
}

// ===================================================================
//  Rendering — session complete view
// ===================================================================

function renderComplete() {
  const s = state.session;
  const deck = state.currentDeck;
  $('topMeta').innerHTML = `<span class="label">${escapeHTML(deck.name)}</span>`;
  $('brandHome').style.cursor = 'pointer';

  const total = s.knew + s.again;
  const pct = total ? Math.round((s.knew / total) * 100) : 0;
  const nextDue = s.nextSessionAt;

  $('main').innerHTML = `
    <div class="complete entering">
      <h2>Stack <em>cleared</em>.</h2>
      <p style="color: var(--ink-soft); margin-top: 0.4rem;">${total} ${total === 1 ? 'card' : 'cards'} reviewed · ${pct}% known</p>
      <div class="summary-grid">
        <div class="stat-tile knew">
          <div class="value">${s.knew}</div>
          <div class="lbl">Promoted</div>
        </div>
        <div class="stat-tile again">
          <div class="value">${s.again}</div>
          <div class="lbl">Back to box 1</div>
        </div>
      </div>
      ${nextDue ? `<p style="font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint);">Next review · ${relTimeFuture(nextDue)}</p>` : ''}
    </div>`;

  $('footer').innerHTML = `
    <div class="ctrl-row" style="justify-content: center;">
      <button class="secondary" id="backHome">Back to stacks</button>
    </div>`;

  $('backHome').addEventListener('click', exitToHome);
}

// ===================================================================
//  Main render dispatcher
// ===================================================================

function render() {
  if (state.view === 'home') renderHome();
  else if (state.view === 'study') renderStudy();
  else if (state.view === 'complete') renderComplete();
  else if (state.view === 'editor') renderEditor();
}

// ===================================================================
//  Actions
// ===================================================================

async function startSession(deckId) {
  const deck = await getDeck(deckId);
  const cards = await getCardsForDeck(deckId);
  if (cards.length === 0) {
    toast('No cards in this deck');
    return;
  }

  let sessionCards = selectDueCards(cards);
  let mode = 'due';

  // No cards due? Offer to practice all.
  if (sessionCards.length === 0) {
    const yes = await confirmDialog({
      title: 'Nothing due',
      message: `Everything in "${deck.name}" is scheduled for later. Practice the whole deck anyway?`,
      okLabel: 'Practice all',
    });
    if (!yes) return;
    sessionCards = [...cards].sort(() => Math.random() - 0.5).slice(0, SESSION_CAP);
    mode = 'practice';
  }

  state.currentDeck = deck;
  state.session = {
    cards: sessionCards,
    idx: 0,
    flipped: false,
    knew: 0,
    again: 0,
    mode,
    nextSessionAt: null,
  };
  state.view = 'study';
  render();
}

async function markAndAdvance(knew) {
  const s = state.session;
  const card = s.cards[s.idx];
  if (knew) {
    markCardKnown(card);
    s.knew++;
  } else {
    markCardForgotten(card);
    s.again++;
  }
  // Persist if this was a real (due) session — practice mode doesn't update schedule
  if (s.mode === 'due') {
    await updateCard(card);
  }

  if (s.idx < s.cards.length - 1) {
    s.idx++;
    s.flipped = false;
    renderStudy();
  } else {
    completeSession();
  }
}

async function completeSession() {
  // Figure out next due time for the summary
  const cards = await getCardsForDeck(state.currentDeck.id);
  const futureDue = cards.filter(c => c.nextReviewAt > Date.now()).map(c => c.nextReviewAt);
  state.session.nextSessionAt = futureDue.length ? Math.min(...futureDue) : null;
  state.view = 'complete';
  render();
}

async function exitToHome() {
  state.session = null;
  state.currentDeck = null;
  state.editor = null;
  state.view = 'home';
  await loadDeckSummaries();
  render();
}

// ===================================================================
//  Editor view — edit cards, add cards, rename deck, export, delete
// ===================================================================

async function openEditor(deckId) {
  const deck = await getDeck(deckId);
  if (!deck) { toast('Deck not found'); return; }
  const cards = await getCardsForDeck(deckId);
  // Sort by creation order (most stable for the editor)
  cards.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  state.editor = { deck, cards };
  state.view = 'editor';
  render();
}

function renderEditor() {
  const { deck, cards } = state.editor;
  $('brandHome').style.cursor = 'pointer';
  $('topMeta').innerHTML = `
    <span><button class="back-btn" id="backToHome">← stacks</button></span>
    <span class="label">edit</span>`;
  $('backToHome').addEventListener('click', exitToHome);

  // Build the card rows. Each row: front textarea, back textarea, delete button.
  const cardRows = cards.map((c, i) => `
    <div class="editor-row" data-id="${c.id}">
      <div class="editor-row-head">
        <span class="editor-row-num">№ ${String(i + 1).padStart(2, '0')}</span>
        <span class="editor-row-meta">Box ${c.box}</span>
        <button class="editor-row-delete" data-del="${c.id}" aria-label="Delete card" title="Delete card">×</button>
      </div>
      <textarea class="editor-input editor-front" data-field="front" data-id="${c.id}"
        placeholder="Front…" rows="2">${escapeHTML(c.front)}</textarea>
      <textarea class="editor-input editor-back" data-field="back" data-id="${c.id}"
        placeholder="Back…" rows="2">${escapeHTML(c.back)}</textarea>
    </div>`).join('');

  $('main').innerHTML = `
    <div class="editor-deck-head">
      <button class="editor-name-btn" id="renameDeckBtn" title="Rename deck">
        <span class="editor-name">${escapeHTML(deck.name)}</span>
        <span class="editor-name-edit">✎</span>
      </button>
      <div class="editor-deck-stats">${cards.length} ${cards.length === 1 ? 'card' : 'cards'}</div>
    </div>
    ${cards.length === 0
      ? `<div class="editor-empty">No cards yet. Tap "+ Add card" to start.</div>`
      : `<div class="editor-list">${cardRows}</div>`}
    <div class="editor-add-row">
      <button class="secondary" id="addCardBtn">+ Add card</button>
    </div>
    <div class="editor-tools">
      <button class="text-btn" id="exportCsvBtn">Export CSV</button>
      <button class="text-btn danger" id="deleteDeckBtn">Delete deck</button>
    </div>`;

  $('footer').innerHTML = '';

  // ----- Wire up handlers -----
  // Live save on textarea blur (debounce by saving only when the user stops editing)
  $('main').querySelectorAll('.editor-input').forEach(ta => {
    ta.addEventListener('change', async (e) => {
      const id = parseInt(e.target.dataset.id, 10);
      const field = e.target.dataset.field;
      const value = e.target.value;
      const card = cards.find(c => c.id === id);
      if (!card) return;
      if (card[field] === value) return;  // no change
      card[field] = value;
      try {
        await updateCard(card);
        // Subtle save indicator: briefly flash the textarea border
        e.target.classList.add('saved');
        setTimeout(() => e.target.classList.remove('saved'), 600);
      } catch (err) {
        console.error(err);
        toast('Save failed');
      }
    });
  });

  // Delete card buttons
  $('main').querySelectorAll('.editor-row-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.del, 10);
      const ok = await confirmDialog({
        title: 'Delete this card?',
        message: 'The card will be permanently removed from the deck.',
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteCard(id);
        state.editor.cards = cards.filter(c => c.id !== id);
        toast('Card deleted');
        renderEditor();
      } catch (err) {
        console.error(err);
        toast('Delete failed');
      }
    });
  });

  // Add card button
  $('addCardBtn').addEventListener('click', async () => {
    try {
      const newId = await addCard(deck.id, '', '');
      // Reload cards so we have the persisted record with id
      const fresh = await getCardsForDeck(deck.id);
      fresh.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      state.editor.cards = fresh;
      renderEditor();
      // Focus the new card's front field after render
      setTimeout(() => {
        const ta = document.querySelector(`textarea[data-id="${newId}"][data-field="front"]`);
        if (ta) {
          ta.focus();
          ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50);
    } catch (err) {
      console.error(err);
      toast('Could not add card');
    }
  });

  // Rename deck
  $('renameDeckBtn').addEventListener('click', async () => {
    const newName = await promptText({
      title: 'Rename deck',
      initial: deck.name,
      placeholder: 'Deck name',
      okLabel: 'Save',
    });
    if (!newName || newName === deck.name) return;
    try {
      await renameDeck(deck.id, newName);
      state.editor.deck.name = newName;
      toast('Renamed');
      renderEditor();
    } catch (err) {
      console.error(err);
      toast('Rename failed');
    }
  });

  // Export CSV
  $('exportCsvBtn').addEventListener('click', () => {
    exportDeckToCSV(deck, cards);
  });

  // Delete deck
  $('deleteDeckBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this deck?',
      message: `"${deck.name}" and all ${cards.length} of its cards will be permanently deleted.`,
      okLabel: 'Delete deck',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDeck(deck.id);
      toast('Deck deleted');
      exitToHome();
    } catch (err) {
      console.error(err);
      toast('Delete failed');
    }
  });
}

// ===================================================================
//  CSV export
// ===================================================================

/** Escape a single field for CSV: wrap in quotes and double any internal quotes. */
function csvEscape(value) {
  const s = String(value == null ? '' : value);
  // Quote if it contains comma, quote, newline, or leading/trailing space
  if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportDeckToCSV(deck, cards) {
  const lines = ['front,back'];
  for (const c of cards) {
    lines.push(csvEscape(c.front) + ',' + csvEscape(c.back));
  }
  // Use CRLF for maximum compatibility with Excel
  const csv = lines.join('\r\n') + '\r\n';
  // Prepend UTF-8 BOM so Excel correctly detects encoding for non-ASCII chars
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const safeName = (deck.name || 'deck')
    .replace(/[^a-z0-9 _-]/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40) || 'deck';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  toast(`Exported ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`);
}

// ===================================================================
//  File import — handles CSV and PPTX
// ===================================================================

async function handleImport(file) {
  const lower = file.name.toLowerCase();
  const isPPTX = lower.endsWith('.pptx');
  const isCSV = lower.endsWith('.csv') || file.type === 'text/csv';

  if (!isPPTX && !isCSV) {
    toast('Unsupported file type');
    return;
  }

  try {
    let newCards;
    let summary;

    if (isPPTX) {
      toast('Reading PowerPoint…');
      const slides = await parsePPTX(file);
      if (slides.length === 0) {
        toast('No slides found in that file');
        return;
      }
      const { cards, orphan } = pptxSlidesToCards(slides);
      newCards = cards;
      summary = `${slides.length} ${slides.length === 1 ? 'slide' : 'slides'} → ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}` +
                (orphan ? ' (last slide unpaired, skipped)' : '');
    } else {
      const text = await file.text();
      const rows = parseCSV(text);
      newCards = csvToCards(rows);
      summary = `${newCards.length} ${newCards.length === 1 ? 'card' : 'cards'} ready to import.`;
    }

    if (!newCards || newCards.length === 0) {
      toast(isPPTX ? 'No usable slide pairs in that deck' : 'No usable rows in that CSV');
      return;
    }

    // Suggest a deck name from the filename
    const suggested = file.name.replace(/\.(csv|pptx)$/i, '').slice(0, 40);
    const name = await promptText({
      title: 'Name this deck',
      message: summary,
      initial: suggested,
      placeholder: isPPTX ? 'e.g. Biology lecture 3' : 'e.g. Spanish vocab',
      okLabel: 'Create deck',
    });
    if (!name) return;

    const deckId = await createDeck(name);
    await bulkAddCards(deckId, newCards);
    toast(`Imported ${newCards.length} cards`);
    await loadDeckSummaries();
    render();
  } catch (err) {
    console.error(err);
    toast(isPPTX ? 'Couldn\u2019t read that PowerPoint' : 'Import failed');
  }
}

// ===================================================================
//  Long-press to delete deck
// ===================================================================

let longPressTimer = null;
function setupLongPressDelete() {
  // We attach handlers on parent; check delegated target
  const main = $('main');
  let pressedEl = null;

  const start = (e) => {
    const card = e.target.closest('.deck-card');
    if (!card) return;
    pressedEl = card;
    longPressTimer = setTimeout(async () => {
      const id = parseInt(card.dataset.id, 10);
      const deck = state.decks.find(d => d.id === id);
      if (!deck) return;
      const confirmed = await confirmDialog({
        title: 'Delete deck?',
        message: `"${deck.name}" and all ${deck.cardCount} of its cards will be permanently deleted.`,
        okLabel: 'Delete',
        danger: true,
      });
      if (confirmed) {
        await deleteDeck(id);
        toast('Deck deleted');
        await loadDeckSummaries();
        render();
      }
    }, 700);
  };
  const cancel = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    pressedEl = null;
  };

  main.addEventListener('mousedown', start);
  main.addEventListener('touchstart', start, { passive: true });
  main.addEventListener('mouseup', cancel);
  main.addEventListener('mouseleave', cancel);
  main.addEventListener('touchend', cancel);
  main.addEventListener('touchcancel', cancel);
}

// ===================================================================
//  Install prompt (Android Chrome)
// ===================================================================

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (localStorage.getItem('install-dismissed') !== '1') {
    $('installBanner').classList.add('show');
  }
});

// ===================================================================
//  Keyboard shortcuts
// ===================================================================

document.addEventListener('keydown', (e) => {
  if (state.view !== 'study') return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const s = state.session;
  if (!s) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    s.flipped = !s.flipped;
    renderStudy();
  } else if (e.key === 'ArrowRight') {
    if (s.idx < s.cards.length - 1) { s.idx++; s.flipped = false; renderStudy(); }
  } else if (e.key === 'ArrowLeft') {
    if (s.idx > 0) { s.idx--; s.flipped = false; renderStudy(); }
  } else if (e.key === '1' || e.key.toLowerCase() === 'n') {
    markAndAdvance(false);
  } else if (e.key === '2' || e.key.toLowerCase() === 'y') {
    markAndAdvance(true);
  }
});

// ===================================================================
//  Init
// ===================================================================

async function init() {
  try {
    await openDB();
  } catch (err) {
    console.error('IndexedDB failed to open:', err);
    toast('Storage unavailable');
    return;
  }
  await loadDeckSummaries();
  render();
  setupLongPressDelete();

  // File input
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await handleImport(file);
    e.target.value = '';
  });

  // Brand click → home
  $('brandHome').addEventListener('click', () => {
    if (state.view !== 'home') exitToHome();
  });

  // Install banner
  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('installBanner').classList.remove('show');
  });
  $('installDismiss').addEventListener('click', () => {
    $('installBanner').classList.remove('show');
    try { localStorage.setItem('install-dismissed', '1'); } catch {}
  });
}

init();
