// ==UserScript==
// @name         Bat Redirector
// @namespace    https://github.com/TFBUtils
// @version      1.0.0
// @description  Replaces and redirects instances of Firebat's @handle URL with her Channel ID URL :D
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/TFBUtils/dependancies/batdirector/scripts/batdirector.user.js
// @downloadURL  https://raw.githubusercontent.com/TFBUtils/dependancies/batdirector/scripts/batdirector.user.js
// ==/UserScript==

(() => {
  'use strict';

  const RAW_BASE = 'https://raw.githubusercontent.com/TFBUtils/dependancies/batdirector/data/';
  const HANDLE_URL = RAW_BASE + 'channelHandle.txt';
  const ID_URL = RAW_BASE + 'channelID.txt';

  const PREFER_YOUTUBE_ID = true;
  const SHOW_OVERLAY = true;
  const OVERLAY_TEXT = 'redirecting to channel\'s ID';
  const REWRITE_SEARCH_LINKS = true;
  const INTERCEPT_CLICKS = true;
  const SPA_NAVIGATE = true;
  const LOOP_GUARD_MS = 15000;

  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  const HANDLE_PATH_RE = /^\/@([^/]+)(\/.*)?$/;
  const log = (...a) => console.log('[batdirector]', ...a);

  const cache = {};

  function gmGet(url) {
    if (cache[url]) return cache[url];
    cache[url] = new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? resolve(r.responseText.trim())
            : reject(new Error(url + ' -> HTTP ' + r.status)),
        onerror: () => reject(new Error('network error for ' + url)),
      });
    });
    return cache[url];
  }

  function getRepoHandle() {
    return gmGet(HANDLE_URL).then((t) => t.replace(/^@/, '').toLowerCase());
  }

  function parseHandlePath(pathname) {
    const m = pathname.match(HANDLE_PATH_RE);
    if (!m) return null;
    let handle = m[1];
    try {
      handle = decodeURIComponent(handle);
    } catch (_) {}
    return { handle: handle.toLowerCase(), rest: m[2] || '' };
  }

  async function idFromYouTube(pageUrl) {
    try {
      const res = await fetch(pageUrl, { credentials: 'same-origin' });
      const html = await res.text();
      const m =
        html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
        html.match(/"externalId":"(UC[\w-]{22})"/) ||
        html.match(/"channelId":"(UC[\w-]{22})"/);
      return m ? m[1] : null;
    } catch (e) {
      log('youtube ID lookup failed:', e);
      return null;
    }
  }

  async function idFromRepo() {
    try {
      const id = await gmGet(ID_URL);
      return CHANNEL_ID_RE.test(id) ? id : null;
    } catch (e) {
      log('repo ID lookup failed:', e);
      return null;
    }
  }

  async function resolveId(pageUrl) {
    const sources = PREFER_YOUTUBE_ID
      ? [() => idFromYouTube(pageUrl), idFromRepo]
      : [idFromRepo, () => idFromYouTube(pageUrl)];
    for (const get of sources) {
      const id = await get();
      if (id) return id;
    }
    return null;
  }

  let idPromise = null;

  function getId(pageUrl) {
    if (!idPromise) {
      idPromise = resolveId(pageUrl).then((id) => {
        if (!id) idPromise = null;
        return id;
      });
    }
    return idPromise;
  }

  let overlay = null;
  let dotTimer = null;

  function showOverlay() {
    if (!SHOW_OVERLAY || overlay) return;

    const root = document.documentElement;
    const dark = root.hasAttribute('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    const fallbackBg = dark ? '#0f0f0f' : '#ffffff';
    const fallbackFg = dark ? '#ffffff' : '#0f0f0f';

    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font:500 20px/1 Roboto,Arial,sans-serif',
      `background:var(--yt-spec-base-background,${fallbackBg})`,
      `color:var(--yt-spec-text-primary,${fallbackFg})`,
    ].join(';');

    const label = document.createElement('span');
    label.textContent = OVERLAY_TEXT;

    const dots = document.createElement('span');
    dots.style.cssText = 'display:inline-block;width:1.2em;text-align:left';
    dots.textContent = '.';

    overlay.append(label, dots);
    root.appendChild(overlay);

    let count = 1;
    dotTimer = setInterval(() => {
      count = (count % 3) + 1;
      dots.textContent = '.'.repeat(count);
    }, 400);
  }

  function hideOverlay() {
    clearInterval(dotTimer);
    dotTimer = null;
    if (overlay) overlay.remove();
    overlay = null;
  }

  let running = false;
  let lastSpaNav = 0;

  async function check() {
    const parsed = parseHandlePath(location.pathname);
    if (!parsed || running) return;
    if (Date.now() - lastSpaNav < LOOP_GUARD_MS) return;

    running = true;
    let redirecting = false;

    try {
      const repoHandle = await getRepoHandle();
      if (!repoHandle || parsed.handle !== repoHandle) return;

      let recent = false;
      try {
        recent = Date.now() - Number(sessionStorage.getItem('batdirector-last') || 0) < LOOP_GUARD_MS;
      } catch (_) {}
      if (recent) {
        log('redirected recently, skipping because loops suck');
        return;
      }

      showOverlay();

      const id = await getId(location.href);
      if (!id) {
        log('the handle matches, but no valid channel ID could be found');
        return;
      }

      try {
        sessionStorage.setItem('batdirector-last', String(Date.now()));
      } catch (_) {}

      const target = `https://www.youtube.com/channel/${id}${parsed.rest}${location.search}${location.hash}`;
      log('redirecting to', target);
      redirecting = true;
      location.replace(target);
    } catch (e) {
      log('error:', e);
    } finally {
      running = redirecting;
      if (!redirecting) hideOverlay();
    }
  }

  let queued = false;

  async function rewriteSearchLinks() {
    queued = false;
    if (!REWRITE_SEARCH_LINKS || location.pathname !== '/results') return;

    try {
      const handle = await getRepoHandle();
      if (!handle) return;

      const matches = [];
      for (const a of document.querySelectorAll('a[href*="/@"]')) {
        if (!a.hostname.endsWith('youtube.com')) continue;
        const parsed = parseHandlePath(a.pathname);
        if (parsed && parsed.handle === handle) matches.push([a, parsed.rest]);
      }
      if (!matches.length) return;

      const id = await getId('/@' + handle);
      if (!id) return;

      for (const [a, rest] of matches) {
        a.href = `/channel/${id}${rest}${a.search}${a.hash}`;
        a.dataset.batdirector = '1';
      }
    } catch (e) {
      log('search rewrite error:', e);
    }
  }

  function queueRewrite() {
    if (queued || location.pathname !== '/results') return;
    queued = true;
    requestAnimationFrame(rewriteSearchLinks);
  }

  new MutationObserver(queueRewrite).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  function spaNavigate(id) {
    try {
      const page = unsafeWindow;
      const app = page.document.querySelector('ytd-app');
      if (!app || typeof app.fire !== 'function') return false;

      const detail = page.JSON.parse(
        JSON.stringify({
          endpoint: {
            commandMetadata: {
              webCommandMetadata: {
                url: `/channel/${id}`,
                webPageType: 'WEB_PAGE_TYPE_CHANNEL',
                rootVe: 3611,
                apiUrl: '/youtubei/v1/browse',
              },
            },
            browseEndpoint: { browseId: id },
          },
        })
      );

      app.fire('yt-navigate', detail);
      return true;
    } catch (e) {
      log('pwa navigation failed:', e);
      return false;
    }
  }

  function trySpaClick(href) {
    const m = new URL(href, location.origin).pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/);
    if (!m) return false;

    const from = location.href;
    if (!spaNavigate(m[1])) return false;

    lastSpaNav = Date.now();
    setTimeout(() => {
      if (location.href !== from) return;
      log('pwa navigation didnt work, falling back to a direct url load (which will reload thhe page :D)');
      showOverlay();
      location.assign(href);
    }, 3000);

    return true;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!INTERCEPT_CLICKS || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const link = e.composedPath().find((n) => n.tagName === 'A' && n.dataset && n.dataset.batdirector);
      if (!link) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      if (SPA_NAVIGATE && trySpaClick(link.href)) return;

      showOverlay();
      location.assign(link.href);
    },
    true
  );

  const onNavigate = () => {
    check();
    queueRewrite();
  };

  onNavigate();
  window.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);
})();
