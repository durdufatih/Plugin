'use strict';

let allTalks = {};
let currentSlug = null;

const $ = (id) => document.getElementById(id);

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

// TED URL'sinden slug çıkar
// Kabul edilen formlar:
//   https://www.ted.com/talks/ken_robinson_says_schools_kill_creativity
//   https://ted.com/talks/ken_robinson_says_schools_kill_creativity?language=tr
//   ted.com/talks/ken_robinson_says_schools_kill_creativity/transcript
function parseTedSlug(raw) {
  let url = raw.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('ted.com')) return null;
    const match = u.pathname.match(/^\/talks\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function fetchTranscriptForSlug(slug) {
  const transcriptUrl = `https://www.ted.com/talks/${slug}/transcript`;
  const res = await fetch(transcriptUrl);
  if (!res.ok) throw new Error(`Transkript sayfası alınamadı (${res.status})`);
  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // TED'in farklı dönemlerden gelen HTML yapıları için çoklu seçici
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
    if (paragraphs.length > 0) break;
  }

  if (paragraphs.length === 0) {
    // fallback: main içindeki uzun <p> etiketleri
    const main = doc.querySelector('main') || doc.body;
    paragraphs = [...main.querySelectorAll('p')].filter(
      (p) => p.textContent.trim().length > 30
    );
  }

  if (paragraphs.length === 0) throw new Error('Transkript metni bulunamadı');

  return paragraphs.map((p) => p.textContent.trim()).join('\n\n');
}

async function fetchTalkTitle(slug) {
  const talkUrl = `https://www.ted.com/talks/${slug}`;
  try {
    const res = await fetch(talkUrl);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const h1 = doc.querySelector('h1[data-testid="talk-title"]') || doc.querySelector('h1');
    return h1 ? h1.textContent.trim() : slug;
  } catch {
    return slug;
  }
}

// --- URL ile transkript çekme ---
function setFetchStatus(msg, type = 'info') {
  const el = $('fetch-status');
  el.textContent = msg;
  el.className = `fetch-status status-${type}`;
  el.classList.remove('hidden');
}

$('btn-fetch-url').addEventListener('click', fetchFromUrl);
$('url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchFromUrl();
});

// Yapıştırıldığında otomatik tetikle
$('url-input').addEventListener('paste', () => {
  // Küçük gecikme ile clipboard değerini al
  setTimeout(fetchFromUrl, 50);
});

async function fetchFromUrl() {
  const raw = $('url-input').value.trim();
  if (!raw) return;

  const slug = parseTedSlug(raw);
  if (!slug) {
    setFetchStatus('Geçerli bir TED linki değil. Örnek: ted.com/talks/...', 'error');
    return;
  }

  if (allTalks[slug]) {
    setFetchStatus('Bu konuşma zaten kaydedilmiş.', 'info');
    showDetail(slug);
    return;
  }

  $('btn-fetch-url').disabled = true;
  setFetchStatus('⏳ Transkript çekiliyor…', 'info');

  try {
    const [transcript, title] = await Promise.all([
      fetchTranscriptForSlug(slug),
      fetchTalkTitle(slug),
    ]);

    const url = `https://www.ted.com/talks/${slug}`;
    const record = {
      id: slug,
      title,
      url,
      transcript,
      savedAt: new Date().toISOString(),
      progress: 0,
      notes: '',
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

// --- Liste ---
function renderList() {
  const list = $('talks-list');
  const empty = $('empty-state');
  const slugs = Object.keys(allTalks);

  $('talk-count').textContent = slugs.length;
  list.innerHTML = '';

  if (slugs.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  slugs
    .sort((a, b) => new Date(allTalks[b].savedAt) - new Date(allTalks[a].savedAt))
    .forEach((slug) => {
      const t = allTalks[slug];
      const card = document.createElement('div');
      card.className = 'talk-card';
      card.innerHTML = `
        <div class="talk-card-title">${escHtml(t.title)}</div>
        <div class="talk-card-meta">
          <span>${formatDate(t.savedAt)}</span>
          <span>%${t.progress || 0} tamamlandı</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${t.progress || 0}%"></div>
        </div>
      `;
      card.addEventListener('click', () => showDetail(slug));
      list.appendChild(card);
    });
}

// --- Detay ---
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

  $('view-list').classList.add('hidden');
  $('view-detail').classList.remove('hidden');
}

function showList() {
  currentSlug = null;
  $('view-detail').classList.add('hidden');
  $('view-list').classList.remove('hidden');
  renderList();
}

function saveCurrentTalk() {
  if (!currentSlug) return;
  chrome.storage.local.set({ talks: allTalks });
}

// --- Detay olayları ---
$('btn-back').addEventListener('click', showList);

$('progress-slider').addEventListener('input', () => {
  const val = $('progress-slider').value;
  $('progress-val').textContent = val;
  if (currentSlug) {
    allTalks[currentSlug].progress = parseInt(val, 10);
    saveCurrentTalk();
  }
});

$('btn-save-notes').addEventListener('click', () => {
  if (!currentSlug) return;
  allTalks[currentSlug].notes = $('notes-area').value;
  saveCurrentTalk();
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
  const content = `${t.title}\n${'='.repeat(60)}\nKaydedildi: ${formatDate(t.savedAt)}\nKaynak: ${t.url}\n\n${t.transcript}`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentSlug}-transcript.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

$('btn-delete').addEventListener('click', () => {
  if (!currentSlug || !confirm('Bu konuşmayı silmek istediğinize emin misiniz?')) return;
  delete allTalks[currentSlug];
  chrome.storage.local.set({ talks: allTalks }, showList);
});

// Başlangıç
chrome.storage.local.get(['talks'], (data) => {
  allTalks = data.talks || {};
  renderList();
});
