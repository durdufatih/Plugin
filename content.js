// TED sayfasında çalışan content script
(function () {
  'use strict';

  if (document.getElementById('ted-tracker-btn')) return;

  // ── Altyazı gizleme butonu ─────────────────────────────────────────────────
  let subsHidden = false;

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
      const video = document.querySelector('video');
      if (video) [...video.textTracks].forEach(t => { t.mode = subsHidden ? 'hidden' : 'showing'; });
      let styleEl = document.getElementById('ted-sub-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'ted-sub-style';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = subsHidden ? `
        [class*="subtitle"],[class*="caption"],[class*="transcript-overlay"],
        [class*="tjs-"],[data-testid*="caption"],[data-testid*="subtitle"],
        .tlc,.tls,[class*="PlayerSubtitle"],[class*="player-subtitle"]{
          display:none!important;visibility:hidden!important;
        }` : '';
      btn.textContent = subsHidden ? '👁 Altyazı: KAPALI' : '👁 Altyazı: AÇIK';
      btn.style.background = subsHidden ? '#e62b1e' : '#1a1a1a';
    });
    document.body.appendChild(btn);
  }

  // ── Transkript çıkarma ─────────────────────────────────────────────────────

  function getVideoMeta() {
    const url   = window.location.href.split('?')[0].replace(/\/$/, '');
    // /transcript suffix'ini slug'dan çıkar
    const slug  = (url.split('/talks/')[1] || '').replace(/\/.*$/, '');
    const h1    = document.querySelector('h1[data-testid="talk-title"]') || document.querySelector('h1');
    const title = h1 ? h1.textContent.trim() : document.title.replace(' | TED', '').replace('Transcript: ', '').trim();
    return { title, url: `https://www.ted.com/talks/${slug}`, slug };
  }

  // Yöntem 1: __NEXT_DATA__ (TED Next.js uygulaması — en güvenilir)
  function extractFromNextData() {
    try {
      const nd = window.__NEXT_DATA__;
      if (!nd) return null;
      const pp = nd.props?.pageProps;
      if (!pp) return null;

      // Bilinen yollar
      const directPaths = [
        pp?.transcriptData?.paragraphs,
        pp?.videoData?.transcript?.paragraphs,
        pp?.talk?.transcript?.paragraphs,
        pp?.serverProps?.transcriptData?.paragraphs,
      ];
      for (const arr of directPaths) {
        const text = paragraphsToText(arr);
        if (text) return text;
      }

      // playerData (JSON string olarak gömülü olabilir)
      const rawPD = pp?.videoData?.playerData || pp?.talk?.playerData;
      if (rawPD) {
        const pd = typeof rawPD === 'string' ? JSON.parse(rawPD) : rawPD;
        // Önce captions/paragraphs
        const langObj = pd?.languages?.en || pd?.languages?.['en-us']
          || (pd?.languages && Object.values(pd.languages)[0]);
        const paras = langObj?.translation?.paragraphs || langObj?.paragraphs;
        const text = paragraphsToText(paras);
        if (text) return text;

        // Cue tabanlı yapı
        if (Array.isArray(paras)) {
          const cueText = paras
            .flatMap(p => p.cues || [])
            .map(c => c.text || '')
            .filter(Boolean)
            .join(' ');
          if (cueText.length > 100) return cueText;
        }
      }

      // Derin arama — paragraf dizisi içeren herhangi bir alan
      return deepSearchParagraphs(pp, 0);
    } catch (e) {
      return null;
    }
  }

  function paragraphsToText(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return null;
    const texts = arr.map(p => p.text || p.cue || p.transcript || '').filter(t => t.length > 5);
    if (texts.length < 3) return null;
    return texts.join('\n\n');
  }

  function deepSearchParagraphs(obj, depth) {
    if (depth > 7 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj) && obj.length >= 5) {
      const sample = obj[0];
      if (sample && typeof sample === 'object' && (sample.text || sample.cue)) {
        const texts = obj.map(p => p.text || p.cue || '').filter(t => t.length > 10);
        if (texts.length >= 5) return texts.join('\n\n');
      }
    }
    // Öncelikli anahtarlar
    for (const key of ['transcript', 'paragraphs', 'captions', 'cues', 'subtitles', 'translation']) {
      if (obj[key]) {
        const r = deepSearchParagraphs(obj[key], depth + 1);
        if (r) return r;
      }
    }
    for (const val of Object.values(obj)) {
      const r = deepSearchParagraphs(val, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // Yöntem 2: Sayfada görünen DOM elemanları
  function extractFromDom() {
    // ── Yeni TED oynatıcısı (2024): altta açılan transkript paneli ──
    // <div class="fixed bottom-0 ..."> → <div role="button" class="inline ..."> → <span dir="ltr">
    const panel = document.querySelector(
      '.fixed.bottom-0.left-0, [class*="fixed"][class*="bottom-0"]'
    );
    if (panel) {
      const spans = [...panel.querySelectorAll('span[dir="ltr"]')]
        .filter(s => s.textContent.trim().length > 10 && !s.closest('button'));
      if (spans.length >= 3) {
        return spans.map(s => s.textContent.replace(/\s+/g, ' ').trim())
          .filter(Boolean).join(' ');
      }
    }

    // aria-label yaklaşımı (yukarıdaki span çalışmazsa)
    const cueDivs = [...document.querySelectorAll('div[role="button"][aria-label].inline')]
      .filter(el => (el.getAttribute('aria-label') || '').length > 15);
    if (cueDivs.length >= 3) {
      return cueDivs.map(el => el.getAttribute('aria-label').trim()).join(' ');
    }

    // ── /transcript sayfası: tüm inline cue divsları (panel dışındakiler de dahil) ──
    const allCueDivs = [...document.querySelectorAll('div[role="button"][aria-label]')]
      .filter(el => (el.getAttribute('aria-label') || '').length > 15);
    if (allCueDivs.length >= 5) {
      return allCueDivs.map(el => el.getAttribute('aria-label').trim()).join(' ');
    }

    // Tüm span[dir="ltr"] (buton dışı)
    const allDirSpans = [...document.querySelectorAll('span[dir="ltr"]')]
      .filter(s => s.textContent.trim().length > 10 && !s.closest('button'));
    if (allDirSpans.length >= 5) {
      return allDirSpans.map(s => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    }

    // ── Eski TED yapıları ──
    const selectors = [
      '[data-testid="transcript-line"]',
      '[data-testid="transcript-paragraph"]',
      '.talk-transcript__para__text',
      '.transcript__para__text',
      '[class*="Transcript__ParaText"]',
      '[class*="transcript-para"]',
    ];
    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)];
      if (els.length >= 3) return els.map(e => e.textContent.trim()).filter(Boolean).join('\n\n');
    }
    return null;
  }

  // Yöntem 3: "Transcript" sekmesine tıkla, yüklenmesini bekle
  async function triggerTranscriptTab() {
    // Önce transcript paneli zaten görünür mü diye tekrar kontrol et (daha uzun bekleyerek)
    for (let i = 0; i < 10; i++) {
      await delay(400);
      const text = extractFromDom();
      if (text) return text;
    }

    // Transcript butonunu bul ve tıkla
    const triggerEls = [...document.querySelectorAll('button,[role="tab"],[role="button"]')]
      .filter(el => {
        const txt = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        return txt.includes('transcript') && !txt.includes('cefr');
      });
    if (!triggerEls.length) return null;
    triggerEls[0].click();
    for (let i = 0; i < 20; i++) {
      await delay(400);
      const text = extractFromDom();
      if (text) return text;
    }
    return null;
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function extractTranscript() {
    // 1. __NEXT_DATA__ — sayfa yüklenirken zaten hazır
    let text = extractFromNextData();
    if (text && text.length > 100) return text;

    // 2. DOM'dan — transkript bölümü zaten açıksa
    text = extractFromDom();
    if (text && text.length > 100) return text;

    // 3. Transkript sekmesini aç ve bekle
    text = await triggerTranscriptTab();
    if (text && text.length > 100) return text;

    throw new Error('Transkript bulunamadı. Sayfayı yenileyin veya "Transcript" bölümünü kendiniz açın.');
  }

  // ── Popup mesajlarını dinle ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TRANSCRIPT') {
      const meta = getVideoMeta();
      extractTranscript()
        .then(transcript => sendResponse({ ok: true, transcript, meta }))
        .catch(err   => sendResponse({ ok: false, error: err.message }));
      return true; // async response
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, meta: getVideoMeta() });
      return true;
    }
  });

  // ── Kaydet butonu ─────────────────────────────────────────────────────────
  function injectSaveButton() {
    const btn = document.createElement('button');
    btn.id = 'ted-tracker-btn';
    btn.textContent = '📋 Transkripti Kaydet';
    btn.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      background: #e62b1e; color: #fff; border: none; border-radius: 8px;
      padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: background .2s;
    `;
    btn.addEventListener('mouseenter', () => (btn.style.background = '#c0231a'));
    btn.addEventListener('mouseleave', () => (btn.style.background = '#e62b1e'));

    btn.addEventListener('click', async () => {
      btn.textContent = '⏳ Çekiliyor…';
      btn.disabled = true;
      try {
        const meta = getVideoMeta();
        if (!meta.slug) throw new Error('TED konuşma adresi tanınamadı');
        const transcript = await extractTranscript();

        const record = {
          id: meta.slug, title: meta.title, url: meta.url,
          transcript, savedAt: new Date().toISOString(),
          progress: 0, notes: '', studyList: {},
        };
        chrome.storage.local.get(['talks'], data => {
          const talks = data.talks || {};
          talks[meta.slug] = record;
          chrome.storage.local.set({ talks }, () => {
            btn.textContent = '✅ Kaydedildi!';
            setTimeout(() => { btn.textContent = '📋 Transkripti Kaydet'; btn.disabled = false; }, 2000);
          });
        });
      } catch (err) {
        btn.textContent = '❌ ' + err.message;
        setTimeout(() => { btn.textContent = '📋 Transkripti Kaydet'; btn.disabled = false; }, 4000);
      }
    });

    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectSubtitleToggle(); injectSaveButton(); });
  } else {
    injectSubtitleToggle();
    injectSaveButton();
  }
})();
