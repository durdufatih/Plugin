'use strict';

let allTalks = {};
let currentSlug = null;

// Flashcard state
let fcDeck = [];
let fcIndex = 0;
let fcCorrect = 0;
let fcWrong = 0;
let fcFlipped = false;

const $ = (id) => document.getElementById(id);

// ── Listening constants ───────────────────────────────────────────────────────
const WPM = 130;
const CHUNK_MINS = 5;
const WORDS_PER_CHUNK = WPM * CHUNK_MINS;
const SHORT_THRESHOLD = WORDS_PER_CHUNK;
const PASSIVE_SESSIONS = 3;
const ACTIVE_SESSIONS = 5;
const DICTATION_SESSIONS = 3;
const MASTERY_THRESHOLD = 70; // % to unlock mastery tab
const MASTERY_SESSIONS = 2;
const MAX_BLANKS = 12;
const MIN_BLANKS = 4;
const BLANK_RATIO = 0.22;

// Stop words excluded from blank selection
const STOP_WORDS_SET = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'to','of','in','on','at','by','for','with','from','up','about','into','through',
  'and','but','or','nor','so','yet','not','just','than','then','now','here','there',
  'also','well','even','still','very','too','only','such','both','all','each',
  'that','this','these','those','i','me','my','we','our','you','your',
  'he','him','his','she','her','it','its','they','them','their',
  'what','which','who','when','where','why','how','some','any','more','most',
  'other','same','own','like','as','if','though','because','since','unless',
  'after','before','while','during','until','over','under','between','upon',
]);

// Per-chunk expanded sub-tab (in-memory)
const chunkSubTab = {};

// Active exercise in-memory state
let alState = null;

// Dictation in-memory state
let dictState = null;

// Mastery exercise in-memory state
let masteryState = null;

// ── helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('tr-TR', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseTedSlug(raw) {
  let url = raw.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('ted.com')) return null;
    const match = u.pathname.match(/^\/talks\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch { return null; }
}


// ── Fetch status ──────────────────────────────────────────────────────────────

function setFetchStatus(msg, type = 'info') {
  const el = $('fetch-status');
  el.textContent = msg;
  el.className = `fetch-status status-${type}`;
  el.classList.remove('hidden');
}

// ── Listening helpers ─────────────────────────────────────────────────────────

function wordCount(text) {
  return (text.match(/\b[a-zA-Z']+\b/g) || []).length;
}

function splitIntoChunks(transcript) {
  const sentences = transcript.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let buf = '', bufWords = 0;
  for (const sent of sentences) {
    const sw = wordCount(sent);
    if (bufWords + sw > WORDS_PER_CHUNK && buf) {
      chunks.push(buf.trim()); buf = sent + ' '; bufWords = sw;
    } else { buf += sent + ' '; bufWords += sw; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function fmtTime(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

function sessionsDone(arr) { return (arr || []).filter(Boolean).length; }

// ── Blank generation ──────────────────────────────────────────────────────────

function generateChunkBlanks(text) {
  const tokenRe = /([a-zA-Z']{4,})|([^a-zA-Z']+|[a-zA-Z']{1,3})/g;
  const tokens = [];
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const isContent = !!m[1] && !STOP_WORDS_SET.has(m[1].toLowerCase());
    tokens.push({ text: m[0], lower: m[0].toLowerCase(), isContent });
  }

  const seen = new Set();
  const unique = [];
  tokens.forEach((t, i) => {
    if (t.isContent && !seen.has(t.lower)) { seen.add(t.lower); unique.push(t.lower); }
  });

  const count = Math.min(MAX_BLANKS, Math.max(MIN_BLANKS, Math.floor(unique.length * BLANK_RATIO)));
  const shuffled = [...unique].sort(() => Math.random() - 0.5);
  const blankWordSet = new Set(shuffled.slice(0, count));
  const pool = unique.filter(w => !blankWordSet.has(w));

  const blanks = [];
  const assigned = new Set();
  tokens.forEach(t => {
    if (t.isContent && blankWordSet.has(t.lower) && !assigned.has(t.lower)) {
      assigned.add(t.lower);
      const opts = [t.lower, ...[...pool].sort(() => Math.random() - 0.5).slice(0, 3)].sort(() => Math.random() - 0.5);
      blanks.push({ word: t.lower, options: opts });
      t.blankIdx = blanks.length - 1;
    }
  });
  return blanks;
}

// Reconstruct blank tokens from stored blank list (deterministic, no random)
function getBlankTokens(text, blanks) {
  const blankWordSet = new Set(blanks.map(b => b.word));
  const lookup = Object.fromEntries(blanks.map((b, i) => [b.word, i]));
  const tokenRe = /([a-zA-Z']{4,})|([^a-zA-Z']+|[a-zA-Z']{1,3})/g;
  const tokens = [];
  const assigned = new Set();
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const lw = m[0].toLowerCase();
    if (m[1] && blankWordSet.has(lw) && !assigned.has(lw)) {
      assigned.add(lw);
      tokens.push({ text: m[0], isBlank: true, blankIdx: lookup[lw] });
    } else {
      tokens.push({ text: m[0], isBlank: false });
    }
  }
  return tokens;
}

// ── Listening data init ───────────────────────────────────────────────────────

function initListeningData(talk) {
  let changed = false;
  if (!talk.listening) {
    const wc = wordCount(talk.transcript);
    if (wc <= SHORT_THRESHOLD) {
      talk.listening = {
        mode: 'short',
        durationMins: Math.max(1, Math.round(wc / WPM)),
        sessions: [false, false, false],
      };
    } else {
      talk.listening = {
        mode: 'chunks',
        durationMins: Math.round(wc / WPM),
        chunks: splitIntoChunks(talk.transcript).map((text, i) => ({
          index: i, text,
          timeStart: i * CHUNK_MINS, timeEnd: (i + 1) * CHUNK_MINS,
          passive: [false, false, false],
          active: null,
        })),
      };
    }
    changed = true;
  }
  // Migrate old format
  if (talk.listening.mode === 'chunks') {
    talk.listening.chunks.forEach(c => {
      if (c.sessions && !c.passive) { c.passive = c.sessions; delete c.sessions; changed = true; }
      if (!c.passive) { c.passive = [false, false, false]; changed = true; }
    });
  }
  if (changed) chrome.storage.local.set({ talks: allTalks });
}

function initChunkActive(chunk) {
  if (chunk.active) return;
  chunk.active = {
    blanks: generateChunkBlanks(chunk.text),
    sessions: Array(ACTIVE_SESSIONS).fill(null).map(() => ({ done: false, score: null, total: 0 })),
  };
  chunk.active.sessions.forEach(s => { s.total = chunk.active.blanks.length; });
  chrome.storage.local.set({ talks: allTalks });
}

// ── Main listening view ───────────────────────────────────────────────────────

function buildListeningView() {
  const talk = allTalks[currentSlug];
  if (!talk) return;
  initListeningData(talk);

  const container = $('listen-content');
  container.innerHTML = '';
  const ld = talk.listening;

  const hdr = document.createElement('div');
  hdr.className = 'listen-header';
  hdr.innerHTML = `
    <div class="listen-duration">⏱ Tahmini süre: <strong>~${fmtTime(ld.durationMins)}</strong></div>
    <div class="listen-mode-badge ${ld.mode === 'short' ? 'mode-short' : 'mode-chunks'}">
      ${ld.mode === 'short' ? 'Kısa (<5dk) · Pasif ×3' : `${ld.chunks.length} parça · 5dk`}
    </div>`;
  container.appendChild(hdr);

  if (ld.mode === 'short') renderShortListening(container, ld);
  else renderChunkListening(container, ld);
}

function renderShortListening(container, ld) {
  const done = sessionsDone(ld.sessions);
  const wrap = document.createElement('div');
  wrap.className = 'short-listen-wrap';
  wrap.innerHTML = `
    <p class="listen-instruction">Kısa konuşma — tam metni <strong>${PASSIVE_SESSIONS} kez pasif dinleyin</strong>.</p>
    <div class="session-dots"></div>
    <div class="listen-progress-text">${done}/${PASSIVE_SESSIONS} tamamlandı ${done >= PASSIVE_SESSIONS ? '🎉' : ''}</div>`;
  container.appendChild(wrap);
  const dots = wrap.querySelector('.session-dots');
  ld.sessions.forEach((isDone, i) => {
    const btn = document.createElement('button');
    btn.className = `session-dot ${isDone ? 'done' : ''}`;
    btn.innerHTML = isDone ? '✅' : `${i + 1}. Dinleme`;
    btn.addEventListener('click', () => {
      allTalks[currentSlug].listening.sessions[i] = !isDone;
      chrome.storage.local.set({ talks: allTalks }, buildListeningView);
    });
    dots.appendChild(btn);
  });
}

function renderChunkListening(container, ld) {
  const total = ld.chunks.length;
  const completed = ld.chunks.filter(c => chunkFullyDone(c)).length;
  const summary = document.createElement('div');
  summary.className = 'chunks-summary';
  summary.innerHTML = `
    <span>${completed}/${total} parça tamamlandı</span>
    <div class="chunks-overall-bar">
      <div class="chunks-overall-fill" style="width:${Math.round(completed / total * 100)}%"></div>
    </div>`;
  container.appendChild(summary);
  ld.chunks.forEach((chunk, ci) => container.appendChild(renderChunkBlock(chunk, ci)));
}

function chunkFullyDone(chunk) {
  const p = sessionsDone(chunk.passive) >= PASSIVE_SESSIONS;
  const a = chunk.active   ? chunk.active.sessions.filter(s => s.done).length >= ACTIVE_SESSIONS : false;
  const d = chunk.dictation ? chunk.dictation.sessions.filter(s => s.done).length >= DICTATION_SESSIONS : false;
  const m = chunk.mastery  ? chunk.mastery.sessions.filter(s => s.done).length >= MASTERY_SESSIONS : false;
  return p && a && d && m;
}

// ── Chunk block ───────────────────────────────────────────────────────────────

function renderChunkBlock(chunk, ci) {
  const pDone = sessionsDone(chunk.passive);
  const aDone = chunk.active ? chunk.active.sessions.filter(s => s.done).length : 0;
  const dDone = chunk.dictation ? chunk.dictation.sessions.filter(s => s.done).length : 0;
  const mDone = chunk.mastery ? chunk.mastery.sessions.filter(s => s.done).length : 0;
  const pct   = chunkProgressPct(chunk);
  const done  = chunkFullyDone(chunk);

  const block = document.createElement('div');
  block.className = `chunk-block ${done ? 'chunk-done' : ''}`;

  const hdr = document.createElement('div');
  hdr.className = 'chunk-header';
  hdr.innerHTML = `
    <span class="chunk-num">Parça ${ci + 1}</span>
    <span class="chunk-time">${chunk.timeStart}:00–${chunk.timeEnd}:00</span>
    <div class="chunk-status-pills">
      <span class="pill ${pDone >= PASSIVE_SESSIONS ? 'pill-done' : ''}">P ${pDone}/${PASSIVE_SESSIONS}</span>
      <span class="pill ${aDone >= ACTIVE_SESSIONS ? 'pill-done' : ''}">A ${aDone}/${ACTIVE_SESSIONS}</span>
      <span class="pill ${dDone >= DICTATION_SESSIONS ? 'pill-done' : ''}">D ${dDone}/${DICTATION_SESSIONS}</span>
      ${pct >= MASTERY_THRESHOLD
        ? `<span class="pill ${mDone >= MASTERY_SESSIONS ? 'pill-done' : 'pill-mastery'}">🏆 ${mDone}/${MASTERY_SESSIONS}</span>`
        : `<span class="pill pill-locked">🔒 %${pct}</span>`}
    </div>
    <button class="chunk-toggle btn-link">▼</button>`;

  const body = document.createElement('div');
  body.className = 'chunk-body hidden';
  body.id = `chunk-body-${ci}`;
  renderChunkStudy(body, chunk, ci);

  block.appendChild(hdr);
  block.appendChild(body);

  const toggleBtn = hdr.querySelector('.chunk-toggle');
  const toggle = (e) => {
    if (e) e.stopPropagation();
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    toggleBtn.textContent = open ? '▼' : '▲';
  };
  toggleBtn.addEventListener('click', toggle);
  hdr.addEventListener('click', toggle);
  return block;
}

function renderChunkStudy(container, chunk, ci) {
  if (!chunkSubTab[ci]) chunkSubTab[ci] = 'passive';

  const tabBar = document.createElement('div');
  tabBar.className = 'chunk-tabs';
  const pct = chunkProgressPct(chunk);
  const subTabs = [
    { key: 'vocab',     label: '📚 Kelimeler' },
    { key: 'passive',   label: '🔈 Pasif' },
    { key: 'active',    label: '✍️ Aktif' },
    { key: 'dictation', label: '🎤 Dikte' },
    { key: 'mastery',   label: `🏆${pct >= MASTERY_THRESHOLD ? '' : ' 🔒'}` },
  ];

  const contentArea = document.createElement('div');
  contentArea.className = 'chunk-tab-content';

  subTabs.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    btn.className = `chunk-tab-btn ${chunkSubTab[ci] === key ? 'active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      chunkSubTab[ci] = key;
      tabBar.querySelectorAll('.chunk-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderChunkTabContent(contentArea, chunk, ci, key);
    });
    tabBar.appendChild(btn);
  });

  container.appendChild(tabBar);
  container.appendChild(contentArea);
  renderChunkTabContent(contentArea, chunk, ci, chunkSubTab[ci]);
}

function renderChunkTabContent(container, chunk, ci, tab) {
  container.innerHTML = '';
  if (tab === 'vocab')     renderChunkVocab(container, chunk);
  if (tab === 'passive')   renderChunkPassive(container, chunk, ci);
  if (tab === 'active')    renderChunkActive(container, chunk, ci);
  if (tab === 'dictation') renderChunkDictation(container, chunk, ci);
  if (tab === 'mastery')   renderChunkMastery(container, chunk, ci);
}

// ── Chunk: Vocabulary ─────────────────────────────────────────────────────────

function renderChunkVocab(container, chunk) {
  const studyList = getStudyList();
  const textDiv = document.createElement('div');
  textDiv.className = 'chunk-vocab-text';

  chunk.text.split(/([^a-zA-Z']+)/).forEach(tok => {
    if (!tok) return;
    const clean = tok.toLowerCase().replace(/[^a-z]/g, '');
    const level = clean.length >= 3 ? CEFR_LEVELS.getLevel(clean) : null;
    if (!level || /^[^a-zA-Z]+$/.test(tok)) {
      textDiv.appendChild(document.createTextNode(tok)); return;
    }
    const color = CEFR_LEVELS.COLORS[level] || '#aaa';
    const span = document.createElement('span');
    span.textContent = tok;
    span.className = `vocab-word ${studyList[clean] ? 'in-study' : ''}`;
    span.dataset.word = clean;
    span.style.color = color;
    span.style.borderBottom = `2px solid ${color}`;
    span.addEventListener('click', () => {
      toggleStudyWord(clean, level, chunk.text);
      span.classList.toggle('in-study', !!getStudyList()[clean]);
    });
    textDiv.appendChild(span);
  });
  container.appendChild(textDiv);
}

// ── Chunk: Passive listening ──────────────────────────────────────────────────

function renderChunkPassive(container, chunk, ci) {
  const passive = chunk.passive || [false, false, false];
  const done = sessionsDone(passive);
  const wrap = document.createElement('div');
  wrap.className = 'chunk-passive-wrap';
  wrap.innerHTML = `
    <p class="listen-instruction">Bu 5dk parçayı <strong>${PASSIVE_SESSIONS} kez pasif dinleyin</strong>.</p>
    <div class="session-dots"></div>
    <div class="listen-progress-text">${done}/${PASSIVE_SESSIONS} tamamlandı ${done >= PASSIVE_SESSIONS ? '✅' : ''}</div>`;
  container.appendChild(wrap);
  wrap.querySelector('.session-dots') && passive.forEach((isDone, si) => {
    const btn = document.createElement('button');
    btn.className = `session-dot ${isDone ? 'done' : ''}`;
    btn.innerHTML = isDone ? '✅' : `${si + 1}. Dinleme`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = allTalks[currentSlug].listening.chunks[ci];
      if (!c.passive) c.passive = [false, false, false];
      c.passive[si] = !isDone;
      chrome.storage.local.set({ talks: allTalks }, buildListeningView);
    });
    wrap.querySelector('.session-dots').appendChild(btn);
  });
}

// ── Chunk: Active listening ───────────────────────────────────────────────────

function renderChunkActive(container, chunk, ci) {
  initChunkActive(chunk);
  const activeData = chunk.active;
  const doneCount = activeData.sessions.filter(s => s.done).length;

  const hdr = document.createElement('div');
  hdr.className = 'active-session-header';
  hdr.innerHTML = `<span>${ACTIVE_SESSIONS} oturum gerekli &nbsp;·&nbsp; <strong>${doneCount}/${ACTIVE_SESSIONS}</strong> tamamlandı</span>`;
  container.appendChild(hdr);

  const sessionRow = document.createElement('div');
  sessionRow.className = 'active-session-row';

  activeData.sessions.forEach((sess, si) => {
    const isActive = alState && alState.chunkIdx === ci && alState.sessionIdx === si;
    const pill = document.createElement('button');
    pill.className = `session-pill ${sess.done ? 'pill-sess-done' : ''} ${isActive ? 'pill-sess-active' : ''}`;
    pill.textContent = sess.done ? `✅ ${sess.score}/${sess.total}` : `${si + 1}. Oturum`;
    pill.title = sess.done ? 'Tekrar yapmak için tıkla' : 'Bu oturumu başlat';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      alState = { slug: currentSlug, chunkIdx: ci, sessionIdx: si, answers: {}, currentBlank: 0 };
      // Re-render active tab
      const body = document.getElementById(`chunk-body-${ci}`);
      if (body) renderChunkTabContent(body.querySelector('.chunk-tab-content'), chunk, ci, 'active');
    });
    sessionRow.appendChild(pill);
  });
  container.appendChild(sessionRow);

  const exerciseArea = document.createElement('div');
  exerciseArea.className = 'active-exercise-area';
  container.appendChild(exerciseArea);

  if (alState && alState.chunkIdx === ci) {
    renderFillInBlank(exerciseArea, chunk, ci);
  } else {
    exerciseArea.innerHTML = `<p class="active-start-hint">Yukarıdan bir oturum seçip başlayın.</p>`;
  }
}

// ── Fill-in-the-blank ─────────────────────────────────────────────────────────

function renderFillInBlank(container, chunk, ci) {
  if (!alState) return;
  const { blanks } = chunk.active;
  const { answers, currentBlank } = alState;
  container.innerHTML = '';

  // Transcript with blank slots
  const textDiv = document.createElement('div');
  textDiv.className = 'fill-blank-text';

  getBlankTokens(chunk.text, blanks).forEach(tok => {
    if (!tok.isBlank) {
      textDiv.appendChild(document.createTextNode(tok.text));
    } else {
      const bi = tok.blankIdx;
      const answer = answers[bi];
      const isCorrect = answer === blanks[bi].word;
      const slot = document.createElement('span');
      slot.className = [
        'blank-slot',
        bi === currentBlank ? 'blank-focused' : '',
        answer ? (isCorrect ? 'blank-correct' : 'blank-wrong') : 'blank-empty',
      ].join(' ');
      slot.textContent = answer || `[${bi + 1}]`;
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        // Focus this blank (only if unanswered)
        if (!answers[bi]) { alState.currentBlank = bi; renderFillInBlank(container, chunk, ci); }
      });
      textDiv.appendChild(slot);
    }
  });
  container.appendChild(textDiv);

  // Check if all answered
  const unanswered = blanks.filter((_, bi) => !answers[bi]);
  if (unanswered.length === 0) { showActiveResult(container, chunk, ci); return; }

  // Word bank for current blank
  const currBlank = blanks[currentBlank] || blanks[blanks.findIndex((_, bi) => !answers[bi])];
  if (!currBlank) return;

  const bank = document.createElement('div');
  bank.className = 'word-bank';
  bank.innerHTML = `<div class="word-bank-label">Boşluk [${currentBlank + 1}] için seçin:</div>`;
  const opts = document.createElement('div');
  opts.className = 'word-bank-options';
  currBlank.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'word-bank-btn';
    btn.textContent = opt;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      alState.answers[currentBlank] = opt;
      // Advance to next unanswered
      let next = blanks.findIndex((_, bi) => bi > currentBlank && !alState.answers[bi]);
      if (next === -1) next = blanks.findIndex((_, bi) => !alState.answers[bi]);
      if (next !== -1) alState.currentBlank = next;
      renderFillInBlank(container, chunk, ci);
    });
    opts.appendChild(btn);
  });
  bank.appendChild(opts);
  container.appendChild(bank);
}

function showActiveResult(container, chunk, ci) {
  const { blanks } = chunk.active;
  const { answers, sessionIdx } = alState;
  const correct = blanks.filter((b, bi) => answers[bi] === b.word).length;
  const total = blanks.length;
  const pct = Math.round(correct / total * 100);
  const wrongs = blanks.filter((b, bi) => answers[bi] !== b.word);

  const result = document.createElement('div');
  result.className = 'active-result';
  result.innerHTML = `
    <div class="result-score">
      <span class="score-big">${pct}%</span>
      <span class="score-sub">${correct}/${total} doğru</span>
    </div>
    ${wrongs.length
      ? `<div class="wrong-list">${wrongs.map(b => {
          const bi = blanks.indexOf(b);
          return `<div class="wrong-item">
            <span class="wrong-given">${answers[bi] || '—'}</span>
            <span class="wrong-arrow">→</span>
            <span class="wrong-correct">${b.word}</span>
          </div>`;
        }).join('')}</div>`
      : `<div class="result-perfect">Mükemmel! Tüm boşluklar doğru 🎉</div>`}
    <button class="btn-primary btn-complete-session">Oturumu Tamamla</button>`;
  container.appendChild(result);

  result.querySelector('.btn-complete-session').addEventListener('click', (e) => {
    e.stopPropagation();
    allTalks[currentSlug].listening.chunks[ci].active.sessions[sessionIdx] = { done: true, score: correct, total };
    alState = null;
    chrome.storage.local.set({ talks: allTalks }, buildListeningView);
  });
}

// ── Dictation ─────────────────────────────────────────────────────────────────

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 15 && /[a-zA-Z]{3,}/.test(s));
}

function initChunkDictation(chunk) {
  if (chunk.dictation) return;
  const sentences = splitSentences(chunk.text);
  chunk.dictation = {
    sentences,
    sessions: Array(DICTATION_SESSIONS).fill(null).map(() => ({
      done: false, score: null, total: sentences.length,
    })),
  };
  chrome.storage.local.set({ talks: allTalks });
}

function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-US';
  utt.rate = 0.85;
  window.speechSynthesis.speak(utt);
}

function compareWords(original, userInput) {
  const normalize = s => s.toLowerCase().replace(/[^a-z\s']/g, '').trim();
  const origWords = normalize(original).split(/\s+/).filter(Boolean);
  const userWords = normalize(userInput).split(/\s+/).filter(Boolean);
  const results = origWords.map((word, i) => ({
    original: word,
    user: userWords[i] || null,
    correct: userWords[i] === word,
  }));
  const correct = results.filter(r => r.correct).length;
  return { results, correct, total: origWords.length, pct: Math.round(correct / origWords.length * 100) };
}

function renderChunkDictation(container, chunk, ci) {
  initChunkDictation(chunk);
  const { sentences, sessions } = chunk.dictation;
  const doneCount = sessions.filter(s => s.done).length;

  const hdr = document.createElement('div');
  hdr.className = 'active-session-header';
  hdr.innerHTML = `<span>${sentences.length} cümle &nbsp;·&nbsp; <strong>${doneCount}/${DICTATION_SESSIONS}</strong> tur tamamlandı</span>`;
  container.appendChild(hdr);

  const sessionRow = document.createElement('div');
  sessionRow.className = 'active-session-row';
  sessions.forEach((sess, si) => {
    const isActive = dictState && dictState.chunkIdx === ci && dictState.sessionIdx === si;
    const pill = document.createElement('button');
    pill.className = `session-pill ${sess.done ? 'pill-sess-done' : ''} ${isActive ? 'pill-sess-active' : ''}`;
    pill.textContent = sess.done ? `✅ %${Math.round(sess.score / sess.total * 100)}` : `${si + 1}. Tur`;
    pill.title = sess.done ? 'Tekrar yapmak için tıkla' : 'Bu turu başlat';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      dictState = {
        slug: currentSlug, chunkIdx: ci, sessionIdx: si,
        sentences,
        currentSentence: 0,
        answers: sentences.map(() => ({ input: '', result: null, checked: false })),
        complete: false,
      };
      refreshDictTab(chunk, ci);
    });
    sessionRow.appendChild(pill);
  });
  container.appendChild(sessionRow);

  const exerciseArea = document.createElement('div');
  exerciseArea.className = 'active-exercise-area';
  exerciseArea.id = `dict-area-${ci}`;
  container.appendChild(exerciseArea);

  if (dictState && dictState.chunkIdx === ci) {
    renderDictationExercise(exerciseArea, chunk, ci);
  } else {
    exerciseArea.innerHTML = `<p class="active-start-hint">Bir tur seçin. Her cümle okunacak, siz yazacaksınız.</p>`;
  }
}

function refreshDictTab(chunk, ci) {
  const body = document.getElementById(`chunk-body-${ci}`);
  if (body) renderChunkTabContent(body.querySelector('.chunk-tab-content'), chunk, ci, 'dictation');
}

function renderDictationExercise(container, chunk, ci) {
  if (!dictState) return;
  const { sentences, currentSentence, answers, complete } = dictState;
  container.innerHTML = '';

  if (complete) { showDictationResult(container, chunk, ci); return; }

  const sent = sentences[currentSentence];
  const answer = answers[currentSentence];

  // Progress bar
  const prog = document.createElement('div');
  prog.className = 'dict-progress';
  const pct = Math.round(currentSentence / sentences.length * 100);
  prog.innerHTML = `
    <span>Cümle <strong>${currentSentence + 1}</strong> / ${sentences.length}</span>
    <div class="dict-prog-bar"><div class="dict-prog-fill" style="width:${pct}%"></div></div>`;
  container.appendChild(prog);

  // Listen buttons
  const listenRow = document.createElement('div');
  listenRow.className = 'dict-listen-row';
  const btnListen = document.createElement('button');
  btnListen.className = 'btn-listen';
  btnListen.innerHTML = '🔊 Dinle';
  btnListen.addEventListener('click', (e) => { e.stopPropagation(); speakText(sent); });
  const btnRepeat = document.createElement('button');
  btnRepeat.className = 'btn-secondary btn-sm';
  btnRepeat.innerHTML = '🔄 Yavaş';
  btnRepeat.addEventListener('click', (e) => {
    e.stopPropagation();
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(sent);
    utt.lang = 'en-US'; utt.rate = 0.65;
    window.speechSynthesis.speak(utt);
  });
  listenRow.appendChild(btnListen);
  listenRow.appendChild(btnRepeat);
  container.appendChild(listenRow);

  if (answer.checked) {
    renderSentenceResult(container, sent, answer, currentSentence, chunk, ci);
    return;
  }

  // Input
  const textarea = document.createElement('textarea');
  textarea.className = 'dict-textarea';
  textarea.placeholder = 'Duyduğunuzu buraya yazın…';
  textarea.value = answer.input;
  textarea.addEventListener('input', () => { dictState.answers[currentSentence].input = textarea.value; });
  // Auto-play on first view
  if (!answer.input) speakText(sent);
  container.appendChild(textarea);

  const btnCheck = document.createElement('button');
  btnCheck.className = 'btn-primary';
  btnCheck.textContent = 'Kontrol Et';
  btnCheck.addEventListener('click', (e) => {
    e.stopPropagation();
    const val = textarea.value.trim();
    if (!val) return;
    dictState.answers[currentSentence].input = val;
    dictState.answers[currentSentence].result = compareWords(sent, val);
    dictState.answers[currentSentence].checked = true;
    refreshDictTab(chunk, ci);
  });
  container.appendChild(btnCheck);
}

function renderSentenceResult(container, sent, answer, sentIdx, chunk, ci) {
  const { result } = answer;
  const { sentences } = dictState;

  // Word-by-word comparison
  const resultDiv = document.createElement('div');
  resultDiv.className = 'dict-result';
  resultDiv.append(
    ...result.results.map(r => {
      const span = document.createElement('span');
      span.className = `dict-word ${r.correct ? 'dict-ok' : 'dict-fail'}`;
      span.textContent = r.original;
      if (!r.correct) span.title = r.user ? `Yazdınız: "${r.user}"` : '(boş bıraktınız)';
      return span;
    })
  );
  container.appendChild(resultDiv);

  // Score line
  const scoreDiv = document.createElement('div');
  scoreDiv.className = 'dict-sentence-score';
  scoreDiv.textContent = `${result.pct}% doğru (${result.correct}/${result.total} kelime)`;
  container.appendChild(scoreDiv);

  // Retry wrong answer
  if (result.pct < 100) {
    const btnRetry = document.createElement('button');
    btnRetry.className = 'btn-secondary btn-sm';
    btnRetry.textContent = '✏️ Tekrar Dene';
    btnRetry.style.marginBottom = '8px';
    btnRetry.addEventListener('click', (e) => {
      e.stopPropagation();
      dictState.answers[sentIdx] = { input: dictState.answers[sentIdx].input, result: null, checked: false };
      refreshDictTab(chunk, ci);
    });
    container.appendChild(btnRetry);
  }

  // Navigation
  const navRow = document.createElement('div');
  navRow.className = 'dict-nav-row';

  if (sentIdx > 0) {
    const btnPrev = document.createElement('button');
    btnPrev.className = 'btn-secondary btn-sm';
    btnPrev.textContent = '← Geri';
    btnPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      dictState.currentSentence = sentIdx - 1;
      refreshDictTab(chunk, ci);
    });
    navRow.appendChild(btnPrev);
  }

  if (sentIdx < sentences.length - 1) {
    const btnNext = document.createElement('button');
    btnNext.className = 'btn-primary';
    btnNext.textContent = 'Sonraki →';
    btnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      dictState.currentSentence = sentIdx + 1;
      refreshDictTab(chunk, ci);
    });
    navRow.appendChild(btnNext);
  } else {
    // Last sentence — offer to complete if all checked
    const allChecked = dictState.answers.every(a => a.checked);
    if (allChecked) {
      const btnFinish = document.createElement('button');
      btnFinish.className = 'btn-primary';
      btnFinish.textContent = 'Turu Bitir ✓';
      btnFinish.addEventListener('click', (e) => {
        e.stopPropagation();
        dictState.complete = true;
        refreshDictTab(chunk, ci);
      });
      navRow.appendChild(btnFinish);
    }
  }
  container.appendChild(navRow);
}

function showDictationResult(container, chunk, ci) {
  const { answers, sessionIdx } = dictState;
  const totalWords = answers.reduce((s, a) => s + (a.result ? a.result.total : 0), 0);
  const correctWords = answers.reduce((s, a) => s + (a.result ? a.result.correct : 0), 0);
  const pct = totalWords > 0 ? Math.round(correctWords / totalWords * 100) : 0;

  const result = document.createElement('div');
  result.className = 'active-result';
  result.innerHTML = `
    <div class="result-score">
      <span class="score-big">${pct}%</span>
      <span class="score-sub">${correctWords}/${totalWords} kelime doğru · ${dictState.sentences.length} cümle</span>
    </div>
    ${pct === 100 ? '<div class="result-perfect">Mükemmel dikte! 🎉</div>' : ''}
    <button class="btn-primary btn-complete-session">Turu Kaydet</button>`;
  container.appendChild(result);

  result.querySelector('.btn-complete-session').addEventListener('click', (e) => {
    e.stopPropagation();
    allTalks[currentSlug].listening.chunks[ci].dictation.sessions[sessionIdx] = {
      done: true, score: correctWords, total: totalWords,
    };
    dictState = null;
    chrome.storage.local.set({ talks: allTalks }, buildListeningView);
  });
}

// ── Mastery ───────────────────────────────────────────────────────────────────

function chunkProgressPct(chunk) {
  const pDone = sessionsDone(chunk.passive);
  const aDone = chunk.active ? chunk.active.sessions.filter(s => s.done).length : 0;
  const dDone = chunk.dictation ? chunk.dictation.sessions.filter(s => s.done).length : 0;
  const total = PASSIVE_SESSIONS + ACTIVE_SESSIONS + DICTATION_SESSIONS;
  return Math.round((pDone + aDone + dDone) / total * 100);
}

// Build word-selection question for one sentence:
// blanks 1-2 key content words, provide 4 options each.
function buildWordSelQuestion(sentence, allChunkWords) {
  const tokenRe = /([a-zA-Z']{4,})|([^a-zA-Z']+|[a-zA-Z']{1,3})/g;
  const tokens = [];
  let m;
  while ((m = tokenRe.exec(sentence)) !== null) {
    const isContent = !!m[1] && !STOP_WORDS_SET.has(m[1].toLowerCase());
    tokens.push({ text: m[0], lower: m[1] ? m[1].toLowerCase() : null, isContent });
  }
  const contentIdxs = tokens.map((t, i) => t.isContent ? i : -1).filter(i => i >= 0);
  if (contentIdxs.length < 2) return null;

  // Pick 1-2 words to blank (prioritise middle of sentence)
  const mid = Math.floor(contentIdxs.length / 2);
  const picks = contentIdxs.length >= 4
    ? [contentIdxs[mid - 1], contentIdxs[mid + 1]]
    : [contentIdxs[mid]];

  const blanks = picks.map(idx => {
    const word = tokens[idx].lower;
    const pool = allChunkWords.filter(w => w !== word);
    const opts = [word, ...[...pool].sort(() => Math.random() - 0.5).slice(0, 3)]
      .sort(() => Math.random() - 0.5);
    return { tokenIdx: idx, word, opts };
  });

  return { tokens, blanks };
}

// Build sentence-completion question: show first ~40% of words, user types rest.
function buildSentCompQuestion(sentence) {
  const words = sentence.trim().split(/\s+/);
  const cutoff = Math.max(2, Math.floor(words.length * 0.4));
  return {
    prefix: words.slice(0, cutoff).join(' '),
    suffix: words.slice(cutoff).join(' '),
    full: sentence,
  };
}

function initChunkMastery(chunk) {
  if (chunk.mastery) return;
  const sentences = splitSentences(chunk.text);
  const allWords = [...new Set(
    (chunk.text.match(/[a-zA-Z']{4,}/g) || []).map(w => w.toLowerCase())
      .filter(w => !STOP_WORDS_SET.has(w))
  )];

  chunk.mastery = {
    questions: sentences.map(sent => ({
      sentence: sent,
      wordSel: buildWordSelQuestion(sent, allWords),
      sentComp: buildSentCompQuestion(sent),
    })).filter(q => q.wordSel),
    sessions: Array(MASTERY_SESSIONS).fill(null).map(() => ({
      done: false, score: null, total: 0,
    })),
  };
  chunk.mastery.sessions.forEach(s => { s.total = chunk.mastery.questions.length * 2; });
  chrome.storage.local.set({ talks: allTalks });
}

function renderChunkMastery(container, chunk, ci) {
  const pct = chunkProgressPct(chunk);
  const locked = pct < MASTERY_THRESHOLD;

  if (locked) {
    container.innerHTML = `
      <div class="mastery-locked">
        <div class="mastery-lock-icon">🔒</div>
        <div class="mastery-lock-msg">Ustalık modu için <strong>%${MASTERY_THRESHOLD}</strong> gerekli</div>
        <div class="mastery-progress-wrap">
          <div class="mastery-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="mastery-progress-txt">Şu an: %${pct}</div>
      </div>`;
    return;
  }

  initChunkMastery(chunk);
  const { questions, sessions } = chunk.mastery;
  const doneCount = sessions.filter(s => s.done).length;

  const hdr = document.createElement('div');
  hdr.className = 'active-session-header';
  hdr.innerHTML = `<span>Altyazısız çalışma &nbsp;·&nbsp; <strong>${doneCount}/${MASTERY_SESSIONS}</strong> seans tamamlandı</span>`;
  container.appendChild(hdr);

  // Sub-title reminder
  const reminder = document.createElement('div');
  reminder.className = 'mastery-subtitle-reminder';
  reminder.innerHTML = `📺 TED sayfasında altyazıları kapatın — eklenti butonu: <strong>"👁 Altyazı: AÇIK"</strong>`;
  container.appendChild(reminder);

  const sessionRow = document.createElement('div');
  sessionRow.className = 'active-session-row';
  sessions.forEach((sess, si) => {
    const isActive = masteryState && masteryState.chunkIdx === ci && masteryState.sessionIdx === si;
    const pill = document.createElement('button');
    pill.className = `session-pill ${sess.done ? 'pill-sess-done' : ''} ${isActive ? 'pill-sess-active' : ''}`;
    pill.textContent = sess.done ? `✅ %${Math.round(sess.score / sess.total * 100)}` : `${si + 1}. Seans`;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      masteryState = {
        slug: currentSlug, chunkIdx: ci, sessionIdx: si,
        questions,
        currentQ: 0,
        step: 'wordSel', // 'wordSel' → 'sentComp' → next question
        wsAnswers: {},    // blankIdx → chosen word (for current question)
        scInput: '',
        scChecked: false,
        scores: [],       // { ws: {c,t}, sc: {c,t} } per question
        complete: false,
      };
      refreshMasteryTab(chunk, ci);
    });
    sessionRow.appendChild(pill);
  });
  container.appendChild(sessionRow);

  const exArea = document.createElement('div');
  exArea.className = 'active-exercise-area';
  container.appendChild(exArea);

  if (masteryState && masteryState.chunkIdx === ci) {
    renderMasteryExercise(exArea, chunk, ci);
  } else {
    exArea.innerHTML = `<p class="active-start-hint">Bir seans seçin. Transkript görünmeyecek.</p>`;
  }
}

function refreshMasteryTab(chunk, ci) {
  const body = document.getElementById(`chunk-body-${ci}`);
  if (body) renderChunkTabContent(body.querySelector('.chunk-tab-content'), chunk, ci, 'mastery');
}

function renderMasteryExercise(container, chunk, ci) {
  if (!masteryState) return;
  const { questions, currentQ, step, complete } = masteryState;
  container.innerHTML = '';

  if (complete) { showMasteryResult(container, chunk, ci); return; }

  const q = questions[currentQ];
  const total = questions.length;

  // Progress
  const prog = document.createElement('div');
  prog.className = 'dict-progress';
  prog.innerHTML = `
    <span>Soru <strong>${currentQ + 1}</strong>/${total} &nbsp;·&nbsp; ${step === 'wordSel' ? '📝 Kelime Seçimi' : '✏️ Cümle Tamamlama'}</span>
    <div class="dict-prog-bar">
      <div class="dict-prog-fill" style="width:${Math.round(currentQ / total * 100)}%"></div>
    </div>`;
  container.appendChild(prog);

  if (step === 'wordSel') {
    renderMasteryWordSel(container, q, chunk, ci);
  } else {
    renderMasterySentComp(container, q, chunk, ci);
  }
}

// ── Mastery: Word Selection ───────────────────────────────────────────────────

function renderMasteryWordSel(container, q, chunk, ci) {
  const { tokens, blanks } = q.wordSel;
  const { wsAnswers } = masteryState;
  const allAnswered = blanks.every((_, bi) => wsAnswers[bi] != null);

  // Render sentence with blanks (no transcript reference)
  const sentDiv = document.createElement('div');
  sentDiv.className = 'mastery-sentence';
  let focusedBlank = blanks.findIndex((_, bi) => wsAnswers[bi] == null);
  if (focusedBlank === -1) focusedBlank = blanks.length - 1;

  tokens.forEach((tok, ti) => {
    const blankIdx = blanks.findIndex(b => b.tokenIdx === ti);
    if (blankIdx === -1) {
      sentDiv.appendChild(document.createTextNode(tok.text));
    } else {
      const ans = wsAnswers[blankIdx];
      const correct = ans === blanks[blankIdx].word;
      const slot = document.createElement('span');
      slot.className = `blank-slot ${blankIdx === focusedBlank ? 'blank-focused' : ''} ${ans ? (allAnswered ? (correct ? 'blank-correct' : 'blank-wrong') : 'blank-focused') : 'blank-empty'}`;
      slot.textContent = ans || `[${blankIdx + 1}]`;
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!wsAnswers[blankIdx]) {
          focusedBlank = blankIdx;
          renderMasteryWordSel(container, q, chunk, ci);
        }
      });
      sentDiv.appendChild(slot);
    }
  });
  container.appendChild(sentDiv);

  if (allAnswered) {
    // Show result and next step button
    const correct = blanks.filter((b, bi) => wsAnswers[bi] === b.word).length;
    const scoreDiv = document.createElement('div');
    scoreDiv.className = 'dict-sentence-score';
    scoreDiv.textContent = `${correct}/${blanks.length} doğru`;
    container.appendChild(scoreDiv);

    const btnNext = document.createElement('button');
    btnNext.className = 'btn-primary';
    btnNext.textContent = 'Cümle Tamamlamaya Geç →';
    btnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      masteryState.scores.push({ ws: { c: correct, t: blanks.length }, sc: null });
      masteryState.step = 'sentComp';
      masteryState.scInput = '';
      masteryState.scChecked = false;
      refreshMasteryTab(chunk, ci);
    });
    container.appendChild(btnNext);
    return;
  }

  // Options for focused blank
  const currBlank = blanks[focusedBlank];
  const bank = document.createElement('div');
  bank.className = 'word-bank';
  bank.innerHTML = `<div class="word-bank-label">Boşluk [${focusedBlank + 1}] için seçin:</div>`;
  const opts = document.createElement('div');
  opts.className = 'word-bank-options';
  currBlank.opts.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'word-bank-btn';
    btn.textContent = opt;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      masteryState.wsAnswers[focusedBlank] = opt;
      // advance focus
      const next = blanks.findIndex((_, bi) => bi > focusedBlank && masteryState.wsAnswers[bi] == null);
      if (next !== -1) focusedBlank = next;
      renderMasteryWordSel(container, q, chunk, ci);
    });
    opts.appendChild(btn);
  });
  bank.appendChild(opts);
  container.appendChild(bank);
}

// ── Mastery: Sentence Completion ─────────────────────────────────────────────

function renderMasterySentComp(container, q, chunk, ci) {
  const { sentComp } = q;
  const { scInput, scChecked, currentQ, questions } = masteryState;

  const prefixDiv = document.createElement('div');
  prefixDiv.className = 'mastery-sentence mastery-prefix';
  prefixDiv.innerHTML = `<span class="prefix-text">${escHtml(sentComp.prefix)}</span><span class="prefix-cursor">…</span>`;
  container.appendChild(prefixDiv);

  if (scChecked) {
    const result = compareWords(sentComp.suffix, scInput);
    const resultDiv = document.createElement('div');
    resultDiv.className = 'dict-result';
    resultDiv.append(...result.results.map(r => {
      const span = document.createElement('span');
      span.className = `dict-word ${r.correct ? 'dict-ok' : 'dict-fail'}`;
      span.textContent = r.original;
      if (!r.correct) span.title = r.user ? `Yazdınız: "${r.user}"` : '(boş)';
      return span;
    }));
    container.appendChild(resultDiv);

    const scoreDiv = document.createElement('div');
    scoreDiv.className = 'dict-sentence-score';
    scoreDiv.textContent = `${result.pct}% doğru (${result.correct}/${result.total} kelime)`;
    container.appendChild(scoreDiv);

    // Update score record
    const scoreEntry = masteryState.scores[masteryState.scores.length - 1];
    if (scoreEntry && !scoreEntry.sc) scoreEntry.sc = { c: result.correct, t: result.total };

    const isLast = currentQ >= questions.length - 1;
    const btnNext = document.createElement('button');
    btnNext.className = 'btn-primary';
    btnNext.textContent = isLast ? 'Seansı Bitir ✓' : 'Sonraki Soru →';
    btnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isLast) {
        masteryState.complete = true;
      } else {
        masteryState.currentQ++;
        masteryState.step = 'wordSel';
        masteryState.wsAnswers = {};
        masteryState.scInput = '';
        masteryState.scChecked = false;
      }
      refreshMasteryTab(chunk, ci);
    });
    container.appendChild(btnNext);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.className = 'dict-textarea';
  textarea.placeholder = 'Cümlenin devamını yazın…';
  textarea.value = scInput;
  textarea.addEventListener('input', () => { masteryState.scInput = textarea.value; });
  container.appendChild(textarea);

  const btnCheck = document.createElement('button');
  btnCheck.className = 'btn-primary';
  btnCheck.textContent = 'Kontrol Et';
  btnCheck.addEventListener('click', (e) => {
    e.stopPropagation();
    masteryState.scInput = textarea.value.trim();
    masteryState.scChecked = true;
    refreshMasteryTab(chunk, ci);
  });
  container.appendChild(btnCheck);
}

function showMasteryResult(container, chunk, ci) {
  const { scores, sessionIdx } = masteryState;
  let wsC = 0, wsT = 0, scC = 0, scT = 0;
  scores.forEach(s => {
    if (s.ws) { wsC += s.ws.c; wsT += s.ws.t; }
    if (s.sc) { scC += s.sc.c; scT += s.sc.t; }
  });
  const total = wsT + scT;
  const correct = wsC + scC;
  const pct = total > 0 ? Math.round(correct / total * 100) : 0;

  const result = document.createElement('div');
  result.className = 'active-result';
  result.innerHTML = `
    <div class="result-score">
      <span class="score-big">${pct}%</span>
      <span class="score-sub">${correct}/${total} doğru &nbsp;·&nbsp; Kelime: %${wsT ? Math.round(wsC/wsT*100) : 0} &nbsp;·&nbsp; Cümle: %${scT ? Math.round(scC/scT*100) : 0}</span>
    </div>
    ${pct >= 90 ? '<div class="result-perfect">Harika! Altyazısız ustalık seviyesi 🏆</div>' : ''}
    <button class="btn-primary btn-complete-session">Seansı Kaydet</button>`;
  container.appendChild(result);

  result.querySelector('.btn-complete-session').addEventListener('click', (e) => {
    e.stopPropagation();
    allTalks[currentSlug].listening.chunks[ci].mastery.sessions[sessionIdx] = {
      done: true, score: correct, total,
    };
    masteryState = null;
    chrome.storage.local.set({ talks: allTalks }, buildListeningView);
  });
}

// ── Vocabulary helpers ────────────────────────────────────────────────────────

function tokenizeTranscript(text) {
  // Split into tokens preserving whitespace/punctuation
  return text.split(/(\s+|[.,!?;:()"'\-–—]+)/).filter(t => t.length > 0);
}

function getStudyList() {
  return (allTalks[currentSlug] && allTalks[currentSlug].studyList) || {};
}

function setStudyList(list) {
  if (!currentSlug) return;
  allTalks[currentSlug].studyList = list;
  chrome.storage.local.set({ talks: allTalks });
}

function getActiveLevels() {
  return [...document.querySelectorAll('.lv-chk:checked')].map(c => c.value);
}

function buildVocabLegend() {
  const legend = $('vocab-legend');
  if (legend.childElementCount) return;
  Object.entries(CEFR_LEVELS.LABELS).forEach(([lv, label]) => {
    const chip = document.createElement('span');
    chip.style.cssText = `display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:${CEFR_LEVELS.COLORS[lv]}22;color:${CEFR_LEVELS.COLORS[lv]};border:1.5px solid ${CEFR_LEVELS.COLORS[lv]}66`;
    chip.textContent = label;
    legend.appendChild(chip);
  });
}

function buildVocabView() {
  const talk = allTalks[currentSlug];
  if (!talk) return;
  buildVocabLegend();

  const tokens = tokenizeTranscript(talk.transcript);
  const studyList = getStudyList();
  const activeLevels = getActiveLevels();
  const container = $('vocab-text');
  container.innerHTML = '';

  tokens.forEach(token => {
    const clean = token.toLowerCase().replace(/[^a-z]/g, '');
    const level = clean.length >= 2 ? CEFR_LEVELS.getLevel(clean) : null;

    if (!level || /^\s+$/.test(token)) {
      container.appendChild(document.createTextNode(token));
      return;
    }

    const span = document.createElement('span');
    span.textContent = token;
    span.className = 'vocab-word';
    span.dataset.word = clean;
    span.dataset.level = level;

    const color = CEFR_LEVELS.COLORS[level] || '#aaa';
    span.style.color = color;
    span.style.borderBottom = `2px solid ${color}`;

    if (studyList[clean]) {
      span.classList.add('in-study');
    }

    if (!activeLevels.includes(level === 'C2' ? 'C1' : level)) {
      span.style.opacity = '0.25';
    }

    span.addEventListener('click', () => toggleStudyWord(clean, level, talk.transcript));
    container.appendChild(span);
  });

  updateStudyPanel();
}

function toggleStudyWord(word, level, fullText) {
  const studyList = getStudyList();
  if (studyList[word]) {
    delete studyList[word];
  } else {
    const context = findContext(word, fullText);
    studyList[word] = { level, context, addedAt: Date.now(), correct: 0, wrong: 0 };
  }
  setStudyList(studyList);

  // Re-mark spans
  document.querySelectorAll(`.vocab-word[data-word="${word}"]`).forEach(el => {
    el.classList.toggle('in-study', !!studyList[word]);
  });
  updateStudyPanel();
}

function findContext(word, text) {
  const re = new RegExp(`[^.!?]*\\b${word}\\b[^.!?]*[.!?]`, 'i');
  const match = text.match(re);
  return match ? match[0].trim() : '';
}

function updateStudyPanel() {
  const studyList = getStudyList();
  const words = Object.entries(studyList);
  $('study-count').textContent = words.length;
  $('btn-clear-study').classList.toggle('hidden', words.length === 0);

  const container = $('study-words');
  container.innerHTML = '';
  words.forEach(([word, info]) => {
    const chip = document.createElement('span');
    chip.className = 'study-chip';
    chip.textContent = word;
    chip.style.background = CEFR_LEVELS.COLORS[info.level] + '22';
    chip.style.borderColor = CEFR_LEVELS.COLORS[info.level];
    chip.style.color = CEFR_LEVELS.COLORS[info.level];
    chip.title = CEFR_LEVELS.LABELS[info.level] || info.level;
    chip.addEventListener('click', () => toggleStudyWord(word, info.level, allTalks[currentSlug].transcript));
    container.appendChild(chip);
  });
}

// ── Flashcard ─────────────────────────────────────────────────────────────────

function buildFlashcards() {
  const studyList = getStudyList();
  const words = Object.entries(studyList);
  $('fc-empty').classList.toggle('hidden', words.length > 0);
  $('fc-container').classList.toggle('hidden', words.length === 0);
  if (words.length === 0) return;

  fcDeck = words.map(([word, info]) => ({ word, ...info }));
  shuffleDeck();
  fcIndex = 0; fcCorrect = 0; fcWrong = 0;
  renderCard();
}

function shuffleDeck() {
  for (let i = fcDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fcDeck[i], fcDeck[j]] = [fcDeck[j], fcDeck[i]];
  }
}

function renderCard() {
  if (fcIndex >= fcDeck.length) {
    showFlashcardResult();
    return;
  }
  const card = fcDeck[fcIndex];
  fcFlipped = false;

  $('fc-idx').textContent = fcIndex + 1;
  $('fc-total').textContent = fcDeck.length;
  $('fc-correct').textContent = fcCorrect;
  $('fc-wrong').textContent = fcWrong;

  $('fc-word').textContent = card.word;
  const lvBadge = $('fc-level-badge');
  lvBadge.textContent = card.level;
  lvBadge.style.background = CEFR_LEVELS.COLORS[card.level] + '33';
  lvBadge.style.color = CEFR_LEVELS.COLORS[card.level];

  $('fc-back').classList.add('hidden');
  $('fc-actions').classList.add('hidden');
  $('btn-flip').classList.remove('hidden');

  $('fc-context').textContent = card.context
    ? card.context.replace(new RegExp(`\\b${card.word}\\b`, 'gi'), '___')
    : '';
  $('fc-definition').textContent = CEFR_LEVELS.LABELS[card.level] || '';

  $('fc-card').classList.remove('flipped');
}

function showFlashcardResult() {
  $('fc-card').innerHTML = `
    <div style="text-align:center;padding:20px">
      <div style="font-size:28px;margin-bottom:10px">🎉</div>
      <strong>Tamamlandı!</strong><br>
      ✅ ${fcCorrect} &nbsp; ❌ ${fcWrong}
    </div>`;
  $('fc-actions').classList.add('hidden');
  $('btn-flip').classList.add('hidden');
}

$('btn-flip').addEventListener('click', () => {
  fcFlipped = true;
  $('fc-back').classList.remove('hidden');
  $('fc-actions').classList.remove('hidden');
  $('btn-flip').classList.add('hidden');
  $('fc-card').classList.add('flipped');
});

$('btn-fc-correct').addEventListener('click', () => {
  fcCorrect++;
  const card = fcDeck[fcIndex];
  const sl = getStudyList();
  if (sl[card.word]) { sl[card.word].correct = (sl[card.word].correct || 0) + 1; setStudyList(sl); }
  fcIndex++;
  renderCard();
});

$('btn-fc-wrong').addEventListener('click', () => {
  fcWrong++;
  const card = fcDeck[fcIndex];
  const sl = getStudyList();
  if (sl[card.word]) { sl[card.word].wrong = (sl[card.word].wrong || 0) + 1; setStudyList(sl); }
  fcIndex++;
  renderCard();
});

$('btn-fc-reset').addEventListener('click', () => { buildFlashcards(); });

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const panel = $(btn.dataset.tab);
    if (panel) panel.classList.remove('hidden');

    if (btn.dataset.tab === 'tab-listen') buildListeningView();
    if (btn.dataset.tab === 'tab-vocab') buildVocabView();
    if (btn.dataset.tab === 'tab-flashcards') buildFlashcards();
    if (btn.dataset.tab === 'tab-progress') buildStats();
  });
});

// Level filter checkboxes
document.querySelectorAll('.lv-chk').forEach(chk => {
  chk.addEventListener('change', buildVocabView);
});

// Clear study list
$('btn-clear-study').addEventListener('click', () => {
  setStudyList({});
  buildVocabView();
});

// ── Stats ─────────────────────────────────────────────────────────────────────

function buildStats() {
  const talk = allTalks[currentSlug];
  if (!talk) return;

  const words = talk.transcript.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
  const freq = {};
  const levelCount = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 };
  const unique = new Set();

  words.forEach(w => {
    unique.add(w);
    freq[w] = (freq[w] || 0) + 1;
    const lv = CEFR_LEVELS.getLevel(w);
    if (lv) levelCount[lv === 'C2' ? 'C1' : lv]++;
  });

  const studyList = getStudyList();
  const studyCount = Object.keys(studyList).length;

  const bars = Object.entries(levelCount).map(([lv, cnt]) => {
    const pct = Math.round((cnt / words.length) * 100);
    return `
      <div class="stat-row">
        <span class="stat-label" style="color:${CEFR_LEVELS.COLORS[lv]}">${lv}</span>
        <div class="stat-bar-wrap">
          <div class="stat-bar" style="width:${pct}%;background:${CEFR_LEVELS.COLORS[lv]}"></div>
        </div>
        <span class="stat-pct">${pct}%</span>
      </div>`;
  }).join('');

  $('vocab-stats').innerHTML = `
    <h4>Kelime İstatistikleri</h4>
    <p class="stat-summary">
      Toplam ${words.length} kelime &middot; ${unique.size} benzersiz &middot; ${studyCount} çalışma listesinde
    </p>
    ${bars}`;
}

// ── URL fetch ─────────────────────────────────────────────────────────────────

$('btn-fetch-url').addEventListener('click', fetchFromUrl);
$('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') fetchFromUrl(); });
$('url-input').addEventListener('paste', () => setTimeout(fetchFromUrl, 50));

async function fetchFromUrl() {
  const raw = $('url-input').value.trim();
  if (!raw) return;
  const slug = parseTedSlug(raw);
  if (!slug) { setFetchStatus('Geçerli bir TED linki değil.', 'error'); return; }
  if (allTalks[slug]) { setFetchStatus('Bu konuşma zaten kayıtlı.', 'info'); showDetail(slug); return; }

  $('btn-fetch-url').disabled = true;
  setFetchStatus('⏳ Transkript sayfası açılıyor, otomatik çekiliyor…', 'info');

  // Önce aktif sekme doğru TED sayfasında mı (hem /talks/SLUG hem /transcript kabul)
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    const tabSlug = tab && tab.url ? parseTedSlug(tab.url) : null;

    if (tabSlug && tabSlug === slug) {
      // Aktif sekme zaten doğru konuşma — content script'ten direkt çek
      chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' }, response => {
        if (chrome.runtime.lastError || !response?.ok) {
          // Aktif sekme başarısız → arka plan sekmesiyle otomatik dene
          autoFetchViaBackground(slug);
          return;
        }
        saveFetchedTalk(slug, response.transcript, response.meta);
      });
    } else {
      // Arka plan sekmesiyle otomatik çek
      autoFetchViaBackground(slug);
    }
  });
}

function autoFetchViaBackground(slug) {
  // background.js'e mesaj gönder — /transcript URL'sini arka planda açsın
  chrome.runtime.sendMessage({ type: 'FETCH_TRANSCRIPT_AUTO', slug }, () => {
    setFetchStatus('⏳ /transcript sayfası arka planda açıldı, çekiliyor…', 'info');
  });

  // storage.onChanged ile sonucu bekle
  const onStorageChange = (changes) => {
    if (changes.talks?.newValue?.[slug]) {
      chrome.storage.onChanged.removeListener(onStorageChange);
      allTalks = changes.talks.newValue;
      $('btn-fetch-url').disabled = false;
      $('url-input').value = '';
      renderList();
      showDetail(slug);
      setFetchStatus('✅ Transkript kaydedildi!', 'success');
    }
    if (changes.pending_fetch_error?.newValue?.[slug]) {
      chrome.storage.onChanged.removeListener(onStorageChange);
      $('btn-fetch-url').disabled = false;
      const msg = changes.pending_fetch_error.newValue[slug];
      setFetchStatus('❌ ' + msg, 'error');
      // Hata kaydını temizle
      chrome.storage.local.get(['pending_fetch_error'], d => {
        const errs = d.pending_fetch_error || {};
        delete errs[slug];
        chrome.storage.local.set({ pending_fetch_error: errs });
      });
    }
  };
  chrome.storage.onChanged.addListener(onStorageChange);

  // 60 saniye sonra timeout
  setTimeout(() => {
    chrome.storage.onChanged.removeListener(onStorageChange);
    if (!allTalks[slug]) {
      $('btn-fetch-url').disabled = false;
      setFetchStatus('❌ Zaman aşımı. TED sayfasını açıp "📋 Transkripti Kaydet" butonuna basın.', 'error');
    }
  }, 60000);
}

function saveFetchedTalk(slug, transcript, meta) {
  const record = {
    id: slug, title: meta?.title || slug,
    url: `https://www.ted.com/talks/${slug}`,
    transcript, savedAt: new Date().toISOString(),
    progress: 0, notes: '', studyList: {},
  };
  allTalks[slug] = record;
  chrome.storage.local.set({ talks: allTalks }, () => {
    $('btn-fetch-url').disabled = false;
    $('url-input').value = '';
    $('fetch-status').classList.add('hidden');
    renderList(); showDetail(slug);
  });
}

// ── List ──────────────────────────────────────────────────────────────────────

function renderList() {
  const list = $('talks-list');
  const slugs = Object.keys(allTalks);
  $('talk-count').textContent = slugs.length;
  list.innerHTML = '';
  $('empty-state').classList.toggle('hidden', slugs.length > 0);
  if (!slugs.length) return;

  slugs
    .sort((a, b) => new Date(allTalks[b].savedAt) - new Date(allTalks[a].savedAt))
    .forEach(slug => {
      const t = allTalks[slug];
      const studyCount = Object.keys(t.studyList || {}).length;
      const card = document.createElement('div');
      card.className = 'talk-card';
      card.innerHTML = `
        <div class="talk-card-title">${escHtml(t.title)}</div>
        <div class="talk-card-meta">
          <span>${formatDate(t.savedAt)}</span>
          <span>${studyCount ? `${studyCount} kelime · ` : ''}%${t.progress || 0} tamamlandı</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${t.progress || 0}%"></div>
        </div>`;
      card.addEventListener('click', () => showDetail(slug));
      list.appendChild(card);
    });
}

// ── Detail ────────────────────────────────────────────────────────────────────

function showDetail(slug) {
  currentSlug = slug;
  const t = allTalks[slug];
  $('detail-title').textContent = t.title;
  $('detail-url').href = t.url;
  $('detail-date').textContent = formatDate(t.savedAt);
  $('progress-slider').value = t.progress || 0;
  $('progress-val').textContent = t.progress || 0;
  $('notes-area').value = t.notes || '';
  $('transcript-text').textContent = t.transcript;

  // Reset tabs to first
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));

  $('view-list').classList.add('hidden');
  $('view-detail').classList.remove('hidden');
}

function showList() {
  currentSlug = null;
  $('view-detail').classList.add('hidden');
  $('view-list').classList.remove('hidden');
  renderList();
}

$('btn-back').addEventListener('click', showList);

$('progress-slider').addEventListener('input', () => {
  const val = $('progress-slider').value;
  $('progress-val').textContent = val;
  if (currentSlug) { allTalks[currentSlug].progress = +val; chrome.storage.local.set({ talks: allTalks }); }
});

$('btn-save-notes').addEventListener('click', () => {
  if (!currentSlug) return;
  allTalks[currentSlug].notes = $('notes-area').value;
  chrome.storage.local.set({ talks: allTalks });
  $('btn-save-notes').textContent = '✅ Kaydedildi';
  setTimeout(() => { $('btn-save-notes').textContent = 'Notları Kaydet'; }, 1500);
});

$('btn-copy').addEventListener('click', () => {
  if (!currentSlug) return;
  navigator.clipboard.writeText(allTalks[currentSlug].transcript).then(() => {
    $('btn-copy').textContent = '✅ Kopyalandı';
    setTimeout(() => { $('btn-copy').textContent = '📋 Kopyala'; }, 1500);
  });
});

$('btn-export').addEventListener('click', () => {
  if (!currentSlug) return;
  const t = allTalks[currentSlug];
  const blob = new Blob(
    [`${t.title}\n${'='.repeat(60)}\nKaynak: ${t.url}\n\n${t.transcript}`],
    { type: 'text/plain;charset=utf-8' }
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentSlug}-transcript.txt`;
  a.click();
});

$('btn-delete').addEventListener('click', () => {
  if (!currentSlug || !confirm('Bu konuşmayı silmek istediğinize emin misiniz?')) return;
  delete allTalks[currentSlug];
  chrome.storage.local.set({ talks: allTalks }, showList);
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['talks'], data => {
  allTalks = data.talks || {};
  // Eski kayıtlara studyList alanı ekle
  Object.values(allTalks).forEach(t => { if (!t.studyList) t.studyList = {}; });
  renderList();
});
