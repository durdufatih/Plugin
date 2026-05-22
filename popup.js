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
const WPM = 130;               // average TED speaker words/minute
const CHUNK_MINS = 5;          // target chunk length in minutes
const WORDS_PER_CHUNK = WPM * CHUNK_MINS; // 650 words ≈ 5 min
const SHORT_THRESHOLD = WPM * CHUNK_MINS; // talks shorter than 1 chunk = "short"
const SESSIONS_REQUIRED = 3;  // mandatory passive listening sessions

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

async function fetchTranscriptForSlug(slug) {
  const res = await fetch(`https://www.ted.com/talks/${slug}/transcript`);
  if (!res.ok) throw new Error(`Transkript alınamadı (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

  const selectors = [
    '[data-testid="transcript-line"]',
    '.Grid__cell--verticalAlignTop .Paragraph',
    '.talk-transcript__para__text',
    '.transcript__para__text',
    '[class*="transcript"] p',
  ];

  let paragraphs = [];
  for (const sel of selectors) {
    paragraphs = [...doc.querySelectorAll(sel)];
    if (paragraphs.length) break;
  }
  if (!paragraphs.length) {
    const main = doc.querySelector('main') || doc.body;
    paragraphs = [...main.querySelectorAll('p')].filter(p => p.textContent.trim().length > 30);
  }
  if (!paragraphs.length) throw new Error('Transkript metni bulunamadı');
  return paragraphs.map(p => p.textContent.trim()).join('\n\n');
}

async function fetchTalkTitle(slug) {
  try {
    const res = await fetch(`https://www.ted.com/talks/${slug}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const h1 = doc.querySelector('h1[data-testid="talk-title"]') || doc.querySelector('h1');
    return h1 ? h1.textContent.trim() : slug;
  } catch { return slug; }
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

function estimatedMins(text) {
  return Math.round(wordCount(text) / WPM);
}

function splitIntoChunks(transcript) {
  // Split at sentence boundaries, group into ~WORDS_PER_CHUNK word blocks
  const sentences = transcript.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let buf = '';
  let bufWords = 0;

  for (const sent of sentences) {
    const sw = wordCount(sent);
    if (bufWords + sw > WORDS_PER_CHUNK && buf) {
      chunks.push(buf.trim());
      buf = sent + ' ';
      bufWords = sw;
    } else {
      buf += sent + ' ';
      bufWords += sw;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function initListeningData(talk) {
  if (talk.listening) return; // already initialised
  const wc = wordCount(talk.transcript);
  const isShort = wc <= SHORT_THRESHOLD;

  if (isShort) {
    talk.listening = {
      mode: 'short',
      durationMins: Math.max(1, Math.round(wc / WPM)),
      sessions: [false, false, false],
    };
  } else {
    const chunkTexts = splitIntoChunks(talk.transcript);
    talk.listening = {
      mode: 'chunks',
      durationMins: Math.round(wc / WPM),
      chunks: chunkTexts.map((text, i) => ({
        index: i,
        text,
        timeStart: i * CHUNK_MINS,
        timeEnd: (i + 1) * CHUNK_MINS,
        sessions: [false, false, false],
      })),
    };
  }
  chrome.storage.local.set({ talks: allTalks });
}

function fmtTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

function sessionsDone(arr) { return arr.filter(Boolean).length; }

function buildListeningView() {
  const talk = allTalks[currentSlug];
  if (!talk) return;
  initListeningData(talk);

  const container = $('listen-content');
  container.innerHTML = '';

  const ld = talk.listening;
  const header = document.createElement('div');
  header.className = 'listen-header';
  header.innerHTML = `
    <div class="listen-duration">
      ⏱ Tahmini süre: <strong>~${fmtTime(ld.durationMins)}</strong>
    </div>
    <div class="listen-mode-badge ${ld.mode === 'short' ? 'mode-short' : 'mode-chunks'}">
      ${ld.mode === 'short' ? 'Kısa Konuşma (<5dk)' : `${ld.chunks.length} Parçaya Bölündü`}
    </div>`;
  container.appendChild(header);

  if (ld.mode === 'short') {
    renderShortListening(container, ld);
  } else {
    renderChunkListening(container, ld);
  }
}

function renderShortListening(container, ld) {
  const done = sessionsDone(ld.sessions);
  const wrap = document.createElement('div');
  wrap.className = 'short-listen-wrap';
  wrap.innerHTML = `
    <p class="listen-instruction">
      Bu konuşma kısa olduğu için <strong>${SESSIONS_REQUIRED} kez pasif dinleme</strong> yapmanız önerilir.
      Her dinleme sonrası işaretleyin.
    </p>
    <div class="session-dots" id="short-sessions"></div>
    <div class="listen-progress-text">${done}/${SESSIONS_REQUIRED} tamamlandı
      ${done === SESSIONS_REQUIRED ? ' 🎉' : ''}
    </div>`;
  container.appendChild(wrap);

  const dots = wrap.querySelector('#short-sessions');
  ld.sessions.forEach((done, i) => {
    const btn = document.createElement('button');
    btn.className = `session-dot ${done ? 'done' : ''}`;
    btn.innerHTML = done ? `✅` : `${i + 1}. Dinleme`;
    btn.title = done ? 'Tamamlandı (tekrar tıkla = geri al)' : `${i + 1}. pasif dinlemeyi işaretle`;
    btn.addEventListener('click', () => {
      allTalks[currentSlug].listening.sessions[i] = !done;
      chrome.storage.local.set({ talks: allTalks }, buildListeningView);
    });
    dots.appendChild(btn);
  });
}

function renderChunkListening(container, ld) {
  const totalDone = ld.chunks.filter(c => sessionsDone(c.sessions) === SESSIONS_REQUIRED).length;
  const summary = document.createElement('div');
  summary.className = 'chunks-summary';
  summary.innerHTML = `
    <span>${totalDone}/${ld.chunks.length} parça tamamlandı</span>
    <div class="chunks-overall-bar">
      <div class="chunks-overall-fill" style="width:${Math.round(totalDone / ld.chunks.length * 100)}%"></div>
    </div>`;
  container.appendChild(summary);

  ld.chunks.forEach((chunk, ci) => {
    const done = sessionsDone(chunk.sessions);
    const completed = done === SESSIONS_REQUIRED;
    const block = document.createElement('div');
    block.className = `chunk-block ${completed ? 'chunk-done' : ''}`;
    block.dataset.chunk = ci;

    block.innerHTML = `
      <div class="chunk-header">
        <span class="chunk-num">Parça ${ci + 1}</span>
        <span class="chunk-time">${chunk.timeStart}:00 – ${chunk.timeEnd}:00</span>
        <span class="chunk-sessions-mini">${done}/${SESSIONS_REQUIRED} ${completed ? '✅' : ''}</span>
        <button class="chunk-toggle btn-link">▼</button>
      </div>
      <div class="chunk-body hidden">
        <div class="chunk-transcript">${escHtml(chunk.text)}</div>
        <div class="chunk-session-row" id="chunk-sess-${ci}"></div>
      </div>`;

    container.appendChild(block);

    const sessRow = block.querySelector(`#chunk-sess-${ci}`);
    chunk.sessions.forEach((isDone, si) => {
      const btn = document.createElement('button');
      btn.className = `session-dot ${isDone ? 'done' : ''}`;
      btn.innerHTML = isDone ? '✅' : `${si + 1}. Dinleme`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        allTalks[currentSlug].listening.chunks[ci].sessions[si] = !isDone;
        chrome.storage.local.set({ talks: allTalks }, buildListeningView);
      });
      sessRow.appendChild(btn);
    });

    // Toggle transcript
    const toggleBtn = block.querySelector('.chunk-toggle');
    const body = block.querySelector('.chunk-body');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !body.classList.contains('hidden');
      body.classList.toggle('hidden', open);
      toggleBtn.textContent = open ? '▼' : '▲';
    });

    // Click header to toggle
    block.querySelector('.chunk-header').addEventListener('click', () => {
      toggleBtn.click();
    });
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
  setFetchStatus('⏳ Transkript çekiliyor…', 'info');
  try {
    const [transcript, title] = await Promise.all([
      fetchTranscriptForSlug(slug),
      fetchTalkTitle(slug),
    ]);
    const record = {
      id: slug, title,
      url: `https://www.ted.com/talks/${slug}`,
      transcript,
      savedAt: new Date().toISOString(),
      progress: 0, notes: '', studyList: {},
    };
    allTalks[slug] = record;
    chrome.storage.local.set({ talks: allTalks }, () => {
      $('url-input').value = '';
      $('fetch-status').classList.add('hidden');
      renderList();
      showDetail(slug);
    });
  } catch (err) {
    setFetchStatus('❌ ' + err.message, 'error');
  } finally {
    $('btn-fetch-url').disabled = false;
  }
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
