// Service worker — rozet sayacı + otomatik transkript çekme

// ── Rozet ────────────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.talks) {
    const talks = changes.talks.newValue || {};
    const count = Object.keys(talks).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e62b1e' });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['talks'], (data) => {
    const count = Object.keys(data.talks || {}).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e62b1e' });
  });
});

// ── Otomatik transkript çekme ─────────────────────────────────────────────────
// popup.js'den { type: 'FETCH_TRANSCRIPT_AUTO', slug } mesajı gelince:
// 1. /transcript sayfasını arka planda aç
// 2. Yüklenince content script'e GET_TRANSCRIPT gönder
// 3. Sonucu storage'a kaydet, sekmeyi kapat
// 4. popup.js storage.onChanged ile sonucu algılar

const pending = {}; // tabId → { slug, attempts }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FETCH_TRANSCRIPT_AUTO') return;
  const { slug } = msg;

  chrome.tabs.create(
    { url: `https://www.ted.com/talks/${slug}/transcript`, active: false },
    (tab) => {
      pending[tab.id] = { slug, attempts: 0 };
      sendResponse({ ok: true, tabId: tab.id });
    }
  );
  return true; // async response
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!pending[tabId] || changeInfo.status !== 'complete') return;
  const { slug } = pending[tabId];

  // Sayfanın JS'i çalışsın diye kısa bekle
  setTimeout(() => {
    tryExtract(tabId, slug, 0);
  }, 1500);
});

function tryExtract(tabId, slug, attempt) {
  if (attempt > 6) {
    // Başarısız — pending_fetch_error kaydı bırak, popup gösterir
    chrome.storage.local.get(['pending_fetch_error'], (d) => {
      const errs = d.pending_fetch_error || {};
      errs[slug] = 'Transkript çekilemedi. Sayfayı açıp manuel kaydedin.';
      chrome.storage.local.set({ pending_fetch_error: errs });
    });
    cleanup(tabId);
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: 'GET_TRANSCRIPT' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Content script henüz hazır değil, tekrar dene
      setTimeout(() => tryExtract(tabId, slug, attempt + 1), 1500);
      return;
    }
    if (!response.ok) {
      setTimeout(() => tryExtract(tabId, slug, attempt + 1), 1500);
      return;
    }

    // Başarılı
    const meta = response.meta || {};
    chrome.storage.local.get(['talks'], (data) => {
      const talks = data.talks || {};
      talks[slug] = {
        id: slug,
        title: meta.title || slug,
        url: `https://www.ted.com/talks/${slug}`,
        transcript: response.transcript,
        savedAt: new Date().toISOString(),
        progress: 0, notes: '', studyList: {},
      };
      chrome.storage.local.set({ talks }, () => cleanup(tabId));
    });
  });
}

function cleanup(tabId) {
  delete pending[tabId];
  chrome.tabs.remove(tabId, () => { /* ignore "tab not found" error */ });
}
