// Service worker - rozet sayacını günceller
chrome.storage.onChanged.addListener((changes) => {
  if (changes.talks) {
    const talks = changes.talks.newValue || {};
    const count = Object.keys(talks).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e62b1e' });
  }
});

// İlk yüklemede rozeti ayarla
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['talks'], (data) => {
    const count = Object.keys(data.talks || {}).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e62b1e' });
  });
});
