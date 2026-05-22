// TED sayfasında çalışan content script
(function () {
  'use strict';

  if (document.getElementById('ted-tracker-btn')) return;

  // ── Altyazı gizleme butonu ─────────────────────────────────────────────────
  let subsHidden = false;
  const subStyleId = 'ted-sub-hide-style';

  function injectSubtitleToggle() {
    if (document.getElementById('ted-sub-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'ted-sub-btn';
    btn.textContent = '👁 Altyazı: AÇIK';
    btn.style.cssText = `
      position: fixed; bottom: 72px; right: 24px; z-index: 999999;
      background: #1a1a1a; color: #fff; border: none; border-radius: 8px;
      padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); transition: background .15s;
    `;
    btn.addEventListener('click', () => {
      subsHidden = !subsHidden;
      // 1. Video text tracks
      const video = document.querySelector('video');
      if (video) {
        [...video.textTracks].forEach(t => { t.mode = subsHidden ? 'hidden' : 'showing'; });
      }
      // 2. CSS overlay approach (covers multiple TED player versions)
      let styleEl = document.getElementById(subStyleId);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = subStyleId;
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = subsHidden ? `
        [class*="subtitle"], [class*="caption"], [class*="transcript-overlay"],
        [class*="tjs-"], [data-testid*="caption"], [data-testid*="subtitle"],
        .tlc, .tls, [class*="PlayerSubtitle"], [class*="player-subtitle"] {
          display: none !important;
          visibility: hidden !important;
        }` : '';
      btn.textContent = subsHidden ? '👁 Altyazı: KAPALI' : '👁 Altyazı: AÇIK';
      btn.style.background = subsHidden ? '#e62b1e' : '#1a1a1a';
    });
    document.body.appendChild(btn);
  }

  injectSubtitleToggle();

  function getVideoMeta() {
    const titleEl =
      document.querySelector('h1[data-testid="talk-title"]') ||
      document.querySelector('h1.f:first-of-type') ||
      document.querySelector('h1');
    const title = titleEl ? titleEl.textContent.trim() : document.title;
    const url = window.location.href.split('?')[0].replace(/\/$/, '');
    const slug = url.split('/talks/')[1] || '';
    return { title, url, slug };
  }

  async function fetchTranscript(slug) {
    const transcriptUrl = `https://www.ted.com/talks/${slug}/transcript`;
    const res = await fetch(transcriptUrl);
    if (!res.ok) throw new Error('Transkript sayfası alınamadı');
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // TED transkript paragrafları
    const selectors = [
      '[data-testid="transcript-line"]',
      '.Grid__cell--verticalAlignTop .Paragraph',
      '.talk-transcript__para__text',
      '.transcript__para__text',
    ];

    let paragraphs = [];
    for (const sel of selectors) {
      paragraphs = [...doc.querySelectorAll(sel)];
      if (paragraphs.length > 0) break;
    }

    if (paragraphs.length === 0) {
      // fallback: <p> içindeki metinleri al
      const main = doc.querySelector('main') || doc.body;
      paragraphs = [...main.querySelectorAll('p')].filter(
        (p) => p.textContent.trim().length > 30
      );
    }

    return paragraphs.map((p) => p.textContent.trim()).join('\n\n');
  }

  function injectButton() {
    const btn = document.createElement('button');
    btn.id = 'ted-tracker-btn';
    btn.textContent = '📋 Transkripti Kaydet';
    btn.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: #e62b1e;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      transition: background 0.2s;
    `;

    btn.addEventListener('mouseenter', () => (btn.style.background = '#c0231a'));
    btn.addEventListener('mouseleave', () => (btn.style.background = '#e62b1e'));

    btn.addEventListener('click', async () => {
      btn.textContent = '⏳ Yükleniyor...';
      btn.disabled = true;
      try {
        const meta = getVideoMeta();
        if (!meta.slug) throw new Error('TED konuşma adresi tanınamadı');

        const transcript = await fetchTranscript(meta.slug);
        if (!transcript) throw new Error('Transkript bulunamadı');

        const record = {
          id: meta.slug,
          title: meta.title,
          url: meta.url,
          transcript,
          savedAt: new Date().toISOString(),
          progress: 0,
          notes: '',
          studyList: {},
        };

        chrome.storage.local.get(['talks'], (data) => {
          const talks = data.talks || {};
          talks[meta.slug] = record;
          chrome.storage.local.set({ talks }, () => {
            btn.textContent = '✅ Kaydedildi!';
            setTimeout(() => {
              btn.textContent = '📋 Transkripti Kaydet';
              btn.disabled = false;
            }, 2000);
          });
        });
      } catch (err) {
        btn.textContent = '❌ Hata: ' + err.message;
        setTimeout(() => {
          btn.textContent = '📋 Transkripti Kaydet';
          btn.disabled = false;
        }, 3000);
      }
    });

    document.body.appendChild(btn);
  }

  // Sayfa yüklenince butonu ekle
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }
})();
