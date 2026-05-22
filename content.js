// TED ve YouTube sayfalarında çalışan content script
(function () {
  'use strict';

  const IS_YOUTUBE = window.location.hostname.includes('youtube.com');
  const guardId = IS_YOUTUBE ? 'yt-tracker-btn' : 'ted-tracker-btn';
  if (document.getElementById(guardId)) return;

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Mesaj dinleyici (TED + YouTube ortak) ────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TRANSCRIPT') {
      const meta = IS_YOUTUBE ? getYouTubeMeta() : getVideoMeta();
      const extractFn = IS_YOUTUBE ? extractYouTubeTranscript : extractTranscript;
      extractFn()
        .then(transcript => sendResponse({ ok: true, transcript, meta }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, meta: IS_YOUTUBE ? getYouTubeMeta() : getVideoMeta() });
      return true;
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // ── YOUTUBE ─────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  function getYouTubeMeta() {
    const videoId = new URLSearchParams(window.location.search).get('v') || '';
    const titleEl = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string')
      || document.querySelector('h1[class*="title"] yt-formatted-string')
      || document.querySelector('#title h1');
    const title = titleEl?.textContent.trim()
      || document.title.replace(' - YouTube', '').trim();
    return { title, url: `https://www.youtube.com/watch?v=${videoId}`, slug: `yt_${videoId}`, videoId };
  }

  async function fetchYouTubeCaption(tracks) {
    // Öncelik: manuel İngilizce > ASR İngilizce > ilk mevcut
    const track = tracks.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr')
      || tracks.find(t => /^en/.test(t.languageCode))
      || tracks[0];

    const url = track.baseUrl + '&fmt=json3';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Altyazı dosyası indirilemedi.');
    const data = await res.json();

    const text = (data.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim())
      .filter(t => t.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < 50) throw new Error('Altyazı metni çok kısa.');
    return text;
  }

  async function extractYouTubeTranscript() {
    // ytInitialData'dan caption track URL'sini al
    for (let i = 0; i < 8; i++) {
      const tracks = window.ytInitialData
        ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) return fetchYouTubeCaption(tracks);
      if (i < 7) await delay(800);
    }
    throw new Error('YouTube altyazısı bulunamadı. Videoda İngilizce altyazı olmayabilir.');
  }

  function injectYouTubeSaveButton() {
    const btn = document.createElement('button');
    btn.id = 'yt-tracker-btn';
    btn.textContent = '📋 Transkripti Kaydet';
    btn.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      background: #ff0000; color: #fff; border: none; border-radius: 8px;
      padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: background .2s;
    `;
    btn.addEventListener('mouseenter', () => (btn.style.background = '#cc0000'));
    btn.addEventListener('mouseleave', () => (btn.style.background = '#ff0000'));

    btn.addEventListener('click', async () => {
      btn.textContent = '⏳ Çekiliyor…';
      btn.disabled = true;
      try {
        const meta = getYouTubeMeta();
        if (!meta.videoId) throw new Error('YouTube video ID bulunamadı');
        const transcript = await extractYouTubeTranscript();
        const record = {
          id: meta.slug, title: meta.title, url: meta.url,
          transcript, savedAt: new Date().toISOString(),
          progress: 0, notes: '', studyList: {},
        };
        chrome.storage.local.get(['talks'], d => {
          const talks = d.talks || {};
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

  // ════════════════════════════════════════════════════════════════════════
  // ── TED ──────────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

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

  function getVideoMeta() {
    const url  = window.location.href.split('?')[0].replace(/\/$/, '');
    const slug = (url.split('/talks/')[1] || '').replace(/\/.*$/, '');
    const h1   = document.querySelector('h1[data-testid="talk-title"]') || document.querySelector('h1');
    const title = h1 ? h1.textContent.trim()
      : document.title.replace(' | TED', '').replace('Transcript: ', '').trim();
    return { title, url: `https://www.ted.com/talks/${slug}`, slug };
  }

  function extractFromNextData() {
    try {
      const nd = window.__NEXT_DATA__;
      if (!nd) return null;
      const pp = nd.props?.pageProps;
      if (!pp) return null;

      const directPaths = [
        pp?.transcriptData?.paragraphs,
        pp?.videoData?.transcript?.paragraphs,
        pp?.talk?.transcript?.paragraphs,
        pp?.serverProps?.transcriptData?.paragraphs,
        pp?.talkData?.transcript?.paragraphs,
        pp?.initialData?.transcript?.paragraphs,
        pp?.transcript?.paragraphs,
        pp?.data?.transcript?.paragraphs,
      ];
      for (const arr of directPaths) {
        const text = paragraphsToText(arr);
        if (text) return text;
      }

      const rawPD = pp?.videoData?.playerData || pp?.talk?.playerData;
      if (rawPD) {
        const pd = typeof rawPD === 'string' ? JSON.parse(rawPD) : rawPD;
        const langObj = pd?.languages?.en || pd?.languages?.['en-us']
          || (pd?.languages && Object.values(pd.languages)[0]);
        const paras = langObj?.translation?.paragraphs || langObj?.paragraphs;
        const text = paragraphsToText(paras);
        if (text) return text;
        if (Array.isArray(paras)) {
          const cueText = paras.flatMap(p => p.cues || []).map(c => c.text || '').filter(Boolean).join(' ');
          if (cueText.length > 100) return cueText;
        }
      }

      return deepSearchParagraphs(pp, 0);
    } catch (e) {
      return null;
    }
  }

  function paragraphsToText(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const directTexts = arr
      .map(p => p.text || p.cue || p.transcript || p.value || '')
      .filter(t => t.length > 5);
    if (directTexts.length >= 2) return directTexts.join('\n\n');
    const hasCues = arr.some(p => Array.isArray(p.cues) && p.cues.length > 0);
    if (hasCues) {
      const cueTexts = arr
        .flatMap(p => (p.cues || []).map(c => c.text || c.value || ''))
        .filter(t => t.length > 3);
      if (cueTexts.length >= 5) return cueTexts.join(' ');
    }
    return null;
  }

  function deepSearchParagraphs(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj) && obj.length >= 3) {
      const sample = obj[0];
      if (sample && typeof sample === 'object') {
        if (sample.text || sample.cue || sample.value) {
          const texts = obj.map(p => p.text || p.cue || p.value || '').filter(t => t.length > 5);
          if (texts.length >= 3) return texts.join('\n\n');
        }
        if (Array.isArray(sample.cues) && sample.cues[0]?.text) {
          const texts = obj.flatMap(p => (p.cues || []).map(c => c.text || '')).filter(t => t.length > 3);
          if (texts.length >= 5) return texts.join(' ');
        }
      }
    }
    for (const key of ['transcript', 'paragraphs', 'captions', 'cues', 'subtitles', 'translation', 'content']) {
      if (obj[key]) {
        const r = deepSearchParagraphs(obj[key], depth + 1);
        if (r) return r;
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'object') {
        const r = deepSearchParagraphs(val, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function extractFromDom() {
    const allDirSpans = [...document.querySelectorAll('span[dir="ltr"]')]
      .filter(s => s.textContent.trim().length > 8 && !s.closest('button'));
    if (allDirSpans.length >= 5) {
      return allDirSpans.map(s => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    }
    const allCueDivs = [...document.querySelectorAll('div[role="button"][aria-label]')]
      .filter(el => (el.getAttribute('aria-label') || '').length > 12);
    if (allCueDivs.length >= 5) {
      return allCueDivs.map(el => el.getAttribute('aria-label').trim()).join(' ');
    }
    if (allDirSpans.length >= 3) {
      return allDirSpans.map(s => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    }
    if (allCueDivs.length >= 3) {
      return allCueDivs.map(el => el.getAttribute('aria-label').trim()).join(' ');
    }
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

  async function triggerTranscriptTab() {
    for (let i = 0; i < 10; i++) {
      await delay(400);
      const text = extractFromDom();
      if (text) return text;
    }
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

  async function extractTranscript() {
    let text = extractFromNextData();
    if (text && text.length > 100) return text;
    text = extractFromDom();
    if (text && text.length > 100) return text;
    text = await triggerTranscriptTab();
    if (text && text.length > 100) return text;
    throw new Error('Transkript bulunamadı. Sayfayı yenileyin veya "Transcript" bölümünü kendiniz açın.');
  }

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
        chrome.storage.local.get(['talks'], d => {
          const talks = d.talks || {};
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

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    if (IS_YOUTUBE) {
      injectYouTubeSaveButton();
    } else {
      injectSubtitleToggle();
      injectSaveButton();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
