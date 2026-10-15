// ==UserScript==
// @name        Desktop GIFs (YouTube) — Tampermonkey standalone
// @namespace   https://github.com/noob111111/desktop_gifs-tampermonkey
// @version     1.0.0
// @description Post GIFs in YouTube comments and replies from a desktop browser. Standalone Tampermonkey userscript (implements the extension's background duties).
// @author      noob111111 (converted by copilot)
// @match       https://www.youtube.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM.getValue
// @grant       GM.setValue
// @grant       GM_addValueChangeListener
// @grant       GM_notification
// @grant       GM_download
// @grant       GM_registerMenuCommand
// @grant       unsafeWindow
// @run-at      document-start
// ==/UserScript==

/*
 This userscript is a standalone conversion of the original extension. It
 merges the extension's content script (content.js), page hook (main.js) and
 background worker (sw.js). It uses GM_xmlhttpRequest and GM.getValue/GM.setValue
 to implement Tenor API access and cross-tab storage.
*/

;(async () => {
  'use strict';

  // ------------------- lightweight GM helpers -------------------
  const GM = typeof unsafeWindow?.GM === 'object' ? unsafeWindow.GM : null;
  const gmGet = async (k, d = undefined) => {
    if (typeof GM?.getValue === 'function') return GM.getValue(k, d);
    if (typeof GM_getValue === 'function') return GM_getValue(k, d);
    return (await window.localStorage.getItem(k)) ?? d;
  };
  const gmSet = async (k, v) => {
    if (typeof GM?.setValue === 'function') return GM.setValue(k, v);
    if (typeof GM_setValue === 'function') return GM_setValue(k, v);
    return window.localStorage.setItem(k, JSON.stringify(v));
  };

  function gmFetch(url, opts = {}) {
    // Returns a Promise that resolves to { status, responseText, finalUrl, ok, json() }
    return new Promise((resolve, reject) => {
      const method = opts.method || 'GET';
      const headers = opts.headers || {};
      const data = opts.body || null;
      const xhrOpts = {
        method,
        url,
        headers,
        data,
        timeout: opts.timeout || 10000,
        onload: (res) => {
          resolve({ status: res.status, responseText: res.responseText, finalUrl: res.finalUrl || url, ok: res.status >= 200 && res.status < 300, json: async () => JSON.parse(res.responseText) });
        },
        onerror: (err) => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      };
      try { GM_xmlhttpRequest(xhrOpts); } catch (e) { reject(e); }
    });
  }

  // ------------------- inject CSS (content.css) -------------------
  const CSS = `
/* The GIF button lives inside YouTube's comment box, so it is styled from the
   page to match YouTube's round icon buttons. The picker has its own shadow root. */
.gcfy-btn { flex: none; align-self: center; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; margin: 0; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #0f0f0f; cursor: pointer; }
html[dark] .gcfy-btn { color: #f1f1f1; }
.gcfy-btn::before { --gcfy-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5'%3E%3Crect x='3' y='3' width='18' height='18' rx='4'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'/%3E%3Cpath d='M21 15l-5-5-3 3-4-4-5 5'/%3E%3C/svg%3E"); content: ""; width: 24px; height: 24px; background-color: currentColor; -webkit-mask: var(--gcfy-icon) center / contain no-repeat; mask: var(--gcfy-icon) center / contain no-repeat; }
.gcfy-btn:hover, .gcfy-btn[aria-expanded="true"] { background: rgba(0, 0, 0, 0.05); }
html[dark] .gcfy-btn:hover, html[dark] .gcfy-btn[aria-expanded="true"] { background: rgba(255, 255, 255, 0.1); }
.gcfy-btn:focus-visible { outline: 2px solid #065fd4; outline-offset: 2px; }
html[dark] .gcfy-btn:focus-visible { outline-color: #3ea6ff; }
.gcfy-attachment { margin: 8px 0 0; font: 12px/1.4 Roboto, Arial, sans-serif; color: #606060; }
html[dark] .gcfy-attachment { color: #aaa; }
.gcfy-attachment-gif { position: relative; display: inline-block; vertical-align: top; border-radius: 8px; overflow: hidden; }
.gcfy-attachment-gif img { display: block; width: auto; height: auto; max-width: 200px; max-height: 120px; }
.gcfy-attachment[data-busy] .gcfy-attachment-gif { opacity: 0.6; }
.gcfy-attachment-remove { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; font: 16px/1 Arial, sans-serif; cursor: pointer; }
.gcfy-attachment[data-busy] .gcfy-attachment-remove { display: none; }
.gcfy-attachment-remove:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 1px; }
.gcfy-attachment-status:empty { display: none; }
.gcfy-attachment-status { margin-top: 4px; }
.gcfy-attachment-status[data-kind="error"] { color: #c00; }
html[dark] .gcfy-attachment-status[data-kind="error"] { color: #ff7b7b; }
`;
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.documentElement.appendChild(styleEl);

  // ------------------- inject main.js into page to wrap fetch -------------------
  // We'll inject a script that replicates main.js behavior (arm/disarm and fetch wrapper).
  const mainCode = `
(function(){
  const HOOK = Symbol.for('gcfy.hook');
  if (window[HOOK] === true) return;
  let hook = window[HOOK];
  if (!hook) {
    hook = { current: null, live: document.readyState === 'loading', originalFetch: window.fetch };
    Object.defineProperty(window, HOOK, { value: hook });
    window.fetch = function(input, init) { return hook.current.fetch(this, arguments); };
  }
  if (hook.current) hook.current.retire();

  const API_URL = /\/youtubei\/v1\//;
  const WATCHED_URL = /\/youtubei\/v1\/(comment|backstage)\//;
  const CREATE_URL = /\/youtubei\/v1\/comment\/create_comment(_reply)?(\?|$)/;
  const MARKER = /\[\[gif:(\d{1,20}):([a-z0-9]{8,32})\]\]/;
  const ARM_TTL_MS = 3 * 60 * 1000;
  const RETRY_DELAYS_MS = [1000,1500,2000,2000,2500,2500,3000,3000,3000,3000,3000];
  const armed = new Map();
  const sleep = (ms) => new Promise((resolve)=>setTimeout(resolve,ms));
  const toContent = (msg) => window.postMessage(Object.assign({gcfy:'to-content'}, msg), location.origin);

  function onMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.gcfy !== 'to-main') return;
    if (msg.type === 'arm' && /^\d{1,20}$/.test(msg.id) && /^[a-z0-9]{8,32}$/.test(msg.nonce)) {
      if (!hook.live) { toContent({ type: 'refused', nonce: msg.nonce }); return; }
      armed.set(msg.nonce, { id: msg.id, ratedG: msg.ratedG === true, expires: Date.now() + ARM_TTL_MS });
      toContent({ type: 'armed', nonce: msg.nonce });
    } else if (msg.type === 'disarm') {
      armed.delete(msg.nonce);
    }
  }
  window.addEventListener('message', onMessage);

  async function readBody(input, init) {
    const isRequest = input instanceof Request;
    const headers = new Headers((init && init.headers) || (isRequest ? input.headers : {}));
    let buf;
    if (init && init.body != null) buf = await new Response(init.body).arrayBuffer();
    else if (isRequest) buf = await input.clone().arrayBuffer();
    else return null;
    const text = headers.get('content-encoding') === 'gzip'
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf);
    return { headers, text };
  }
  const { originalFetch } = hook;
  hook.current = {
    fetch(self, args) {
      const [input, init] = args;
      let url = '';
      try { url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input); } catch (e) {}
      if (!hook.live && /\/youtubei\/v1\//.test(url)) hook.live = true;
      if (!WATCHED_URL.test(url)) return originalFetch.apply(self, args);
      return handleWatched.call(self, url, input, init, args);
    },
    retire() { window.removeEventListener('message', onMessage); armed.clear(); }
  };

  async function handleWatched(url, input, init, originalArgs) {
    let parsed = null;
    try { parsed = await readBody(input, init); } catch (e) {}
    const match = parsed && parsed.text.match(MARKER);
    if (!match) return originalFetch.apply(this, originalArgs);
    const [whole, id, nonce] = match;
    const entry = armed.get(nonce);
    armed.delete(nonce);
    let body = null;
    try { body = JSON.parse(parsed.text); } catch (e) {}
    const full = body && typeof body.commentText === 'string' ? body.commentText.trim() : '';
    const ownText = full.endsWith(whole) ? full.slice(0, -whole.length).trim() : null;
    const valid = body && CREATE_URL.test(url) && ownText !== null && !MARKER.test(ownText) && entry && entry.id === id && entry.expires >= Date.now();
    if (!valid) { toContent({ type:'result', nonce, ok:false, error:'This box cannot take a GIF, or the request expired. Nothing was posted.' }); throw new TypeError('GIF comment marker blocked'); }
    toContent({ type:'seen', nonce });
    if (ownText) body.commentText = ownText; else delete body.commentText;
    body.tenorId = id;
    const headers = parsed.headers; headers.delete('content-encoding');
    const payload = JSON.stringify(body);
    const send = () => (input instanceof Request ? originalFetch.call(this, new Request(input, { ...init, body: payload, headers })) : originalFetch.call(this, input, { ...init, body: payload, headers }));
    const tries = RETRY_DELAYS_MS.length + 1;
    let response; let verdict; let attempt = 0;
    for (;;) {
      attempt++;
      try { response = await send(); } catch (e) { toContent({ type:'result', nonce, ok:false, error:'The request could not be sent. Nothing was posted.'}); throw e; }
      try { verdict = await judge(response); } catch (e) { verdict = { kind: 'uncertain', httpStatus: response.status }; }
      if (verdict.kind !== 'blocked' || !entry.ratedG || attempt === tries) break;
      toContent({ type:'retrying', nonce, attempt: attempt + 1, tries });
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    const detail = `HTTP ${verdict.httpStatus}${verdict.apiStatus ? `, ${verdict.apiStatus}` : ''}`;
    const said = !verdict.message ? '' : /[.!?]$/.test(verdict.message) ? ` ${verdict.message}` : ` ${verdict.message}.`;
    const error = verdict.kind === 'posted' ? null
      : verdict.kind === 'gif' ? (verdict.message ? `YouTube turned this GIF comment down:${said} Nothing was posted.` : 'YouTube does not accept this GIF. Try a different one. Nothing was posted.')
      : verdict.kind === 'blocked' ? (entry.ratedG ? `YouTube is refusing GIF comments sent from desktop (tried ${tries} times). The GIF is not the cause, so another one will not help. Nothing was posted.` : 'YouTube turned this GIF comment down. Either Tenor does not rate the GIF G, or YouTube is refusing GIF comments sent from desktop. Nothing was posted.')
      : verdict.kind === 'rejected' ? `YouTube rejected this GIF comment (${detail}).${said} Nothing was posted.`
      : `YouTube did not confirm this GIF comment (${detail}).${said} Check the comments before trying again.`;
    if (verdict.kind !== 'posted') console.warn('Desktop GIFs: comment not confirmed', JSON.stringify({ tenorId: id, ratedG: entry.ratedG, hasText: !!ownText, kind: verdict.kind, tries: attempt, httpStatus: verdict.httpStatus }));
    toContent({ type:'result', nonce, ok: verdict.kind === 'posted', error });
    return response;
  }

  function textOf(value) { if (typeof value === 'string') return value; if (!value || typeof value !== 'object') return ''; if (typeof value.simpleText === 'string') return value.simpleText; if (typeof value.content === 'string') return value.content; if (Array.isArray(value.runs)) return value.runs.map((r)=>typeof r.text==='string'?r.text:'').join(''); return ''; }
  function errorActions(actions) { if (!Array.isArray(actions)) return []; return actions.flatMap((action)=>{ if (!action || typeof action !== 'object') return []; const own = action.showErrorAction ? [(()=>{ const error = action.showErrorAction.errorMessage; return textOf(error && error.messageRenderer && error.messageRenderer.text) || textOf(error); })()] : []; return [...own, ...errorActions(action.commandExecutorCommand && action.commandExecutorCommand.commands)]; }); }
  async function judge(response) {
    let json = null; try { json = await response.clone().json(); } catch (e) {}
    const action = json && json.actionResult; const errors = json ? [...errorActions(json.actions), ...errorActions(json.onResponseReceivedActions), ...errorActions(json.onResponseReceivedEndpoints)] : [];
    const apiStatus = json && json.error && typeof json.error.status === 'string' ? json.error.status : null;
    const message = [...new Set([textOf(json && json.error && json.error.message), ...errors, textOf(action && action.feedbackText)].filter(Boolean))].join(' ');
    const verdict = { httpStatus: response.status, apiStatus, actionStatus: action && typeof action.status === 'string' ? action.status : null, message };
    const kind = response.ok && action && action.status === 'STATUS_SUCCEEDED' && !errors.length ? 'posted'
      : response.status === 400 && apiStatus === 'INVALID_ARGUMENT' ? 'blocked'
      : response.ok && !action && errors.length ? 'gif'
      : (response.status >= 400 && response.status < 500) || errors.length || verdict.actionStatus === 'STATUS_FAILED' ? 'rejected' : 'uncertain';
    return { kind, ...verdict };
  }
})();
`;
  const script = document.createElement('script');
  script.textContent = mainCode;
  // Inject as earliest possible
  document.documentElement.appendChild(script);
  script.remove();

  // ------------------- background functionality (Tenor, storage, update) -------------------
  // ported from sw.js but adapted to userscript environment
  const TENOR = 'https://tenor.com';
  const TENOR_API = 'https://tenor.googleapis.com/v2';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_RESULTS = 50;
  const TENOR_TIMEOUT_MS = 10000;
  const NETWORK_RETRY_MS = 1000;
  const RELEASES_API = 'https://api.github.com/repos/noob111111/desktop_gifs-tampermonkey/releases/latest';
  const RELEASES_PAGE = 'https://github.com/noob111111/desktop_gifs-tampermonkey/releases/';
  const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

  const cache = new Map();

  async function cached(url, load) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
    const value = await load();
    cache.set(url, { time: Date.now(), value });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return value;
  }

  async function tenorFetch(url, init) {
    for (let attempt = 1;; attempt++) {
      try {
        return await gmFetch(url, { method: init && init.method ? init.method : 'GET', headers: init && init.headers ? init.headers : {}, body: init && init.body ? init.body : null, timeout: TENOR_TIMEOUT_MS });
      } catch (e) {
        if (e && e.message === 'Timeout') throw new Error('Tenor did not answer in time. Try again.');
        if (attempt === 1) { await new Promise((r) => setTimeout(r, NETWORK_RETRY_MS)); continue; }
        throw new Error(`Could not reach ${new URL(url).hostname}.`);
      }
    }
  }

  async function fetchPage(url) {
    return cached(url, async () => {
      const res = await tenorFetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(res.status === 404 ? 'Tenor could not find that GIF.' : `Tenor returned HTTP ${res.status}.`);
      if (new URL(res.finalUrl).origin !== TENOR) throw new Error('Tenor redirected somewhere unexpected.');
      const html = res.responseText;
      const m = html.match(/<script id="store-cache" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) throw new Error('Tenor changed its page format; search is unavailable.');
      const keys = readKeys(html);
      if (keys) await storeKeys(keys);
      return { store: JSON.parse(m[1]), keys };
    });
  }

  async function storedKeys() {
    try { const k = await gmGet('tenorKeys'); if (k && typeof k.key === 'string' && typeof k.client_key === 'string') return { key: k.key, client_key: k.client_key }; } catch (e) {}
    return null;
  }
  async function storeKeys(keys) { try { await gmSet('tenorKeys', keys); } catch (e) {} }
  async function forgetKeys() { try { await gmSet('tenorKeys', null); } catch (e) {} }

  function readKeys(html) {
    const m = html.match(/<script id="data" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
    try {
      const data = JSON.parse(atob(m[1].trim()));
      if (typeof data.API_V2_KEY === 'string' && typeof data.API_V2_CLIENT_KEY === 'string') return { key: data.API_V2_KEY, client_key: data.API_V2_CLIENT_KEY };
    } catch (e) {}
    return null;
  }

  async function fetchApi(path, params) {
    const stored = await storedKeys();
    if (stored) {
      try { return await callApi(stored, path, params); } catch (e) { if (!e.badKey) throw e; await forgetKeys(); }
    }
    const { keys } = await fetchPage(`${TENOR}/`);
    if (!keys) throw new Error('Tenor changed its page format; ratings are unavailable.');
    return callApi(keys, path, params);
  }

  function callApi(keys, path, params) {
    const query = new URLSearchParams(Object.assign({}, keys, { contentfilter: 'high', media_filter: 'tinygif,tinywebp,gif' }, params));
    const url = `${TENOR_API}${path}?${query}`;
    return cached(url, async () => {
      const res = await tenorFetch(url, { method: 'GET' });
      if (!res.ok) { const e = new Error(`Tenor returned HTTP ${res.status}.`); e.badKey = res.status === 400 || res.status === 401 || res.status === 403; throw e; }
      const data = await res.json();
      if (!Array.isArray(data.results)) throw new Error('Tenor sent an answer that could not be read.');
      return data.results;
    });
  }

  const ratedG = (r) => typeof r.content_rating !== 'string' || r.content_rating === 'G';
  function toGif(r) {
    if (!r || !/^\d{1,20}$/.test(String(r.id)) || !r.media_formats) return null;
    const flags = r.flags || [];
    if (flags.includes('sticker') || flags.includes('static')) return null;
    const f = r.media_formats.tinygif || r.media_formats.tinywebp || r.media_formats.gif;
    if (!f || typeof f.url !== 'string' || !/^https:\/\/media\d*\.tenor\.com\//.test(f.url)) return null;
    const dims = Array.isArray(f.dims) ? f.dims : [];
    return { id: String(r.id), title: String(r.content_description || r.h1_title || 'GIF').slice(0,200), preview: f.url, width: dims[0] || 220, height: dims[1] || 124, contentRating: typeof r.content_rating === 'string' ? r.content_rating : null };
  }
  const toGifs = (results) => (results || []).map(toGif).filter(Boolean).slice(0, MAX_RESULTS);

  async function featured() {
    try { return toGifs((await fetchApi('/featured', { limit: MAX_RESULTS })).filter(ratedG)); } catch (e) {}
    const { store } = await fetchPage(`${TENOR}/`);
    return toGifs(store.gifs && store.gifs.featured && store.gifs.featured.results);
  }
  async function search(query) {
    const slug = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(encodeURIComponent).join('-');
    if (!slug) return featured();
    try { return toGifs((await fetchApi('/search', { q: query.trim(), limit: MAX_RESULTS })).filter(ratedG)); } catch (e) {}
    const { store } = await fetchPage(`${TENOR}/search/${slug}-gifs`);
    const searches = Object.values((store.universal && store.universal.search) || {});
    return toGifs(searches[0] && searches[0].results);
  }
  async function resolve(input) {
    const text = input.trim(); let pageUrl;
    if (/^\d{1,20}$/.test(text)) { pageUrl = `${TENOR}/view/x-gif-${text}`; }
    else {
      let url; try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch (e) { throw new Error('That is not a Tenor link.'); }
      if (/^media\d*\.tenor\.com$/.test(url.hostname)) {
        const mediaId = url.pathname.split('/').filter(Boolean).find((p) => /^[A-Za-z0-9_-]{16}$/.test(p));
        if (!mediaId) throw new Error('That is not a Tenor GIF link.');
        pageUrl = `${TENOR}/view/x-gif-${decodeMediaId(mediaId)}`;
      } else if (url.hostname === 'tenor.com' || url.hostname === 'www.tenor.com') { pageUrl = `${TENOR}${url.pathname}`; } else { throw new Error('That is not a Tenor link.'); }
    }
    const { store } = await fetchPage(pageUrl);
    const entries = Object.values((store.gifs && store.gifs.byId) || {});
    const gifs = toGifs(entries.flatMap((e) => (e && e.results) || []).slice(0,1));
    if (!gifs.length) throw new Error('That link does not point at a GIF.');
    let rated = [];
    try { rated = await fetchApi('/posts', { ids: gifs[0].id, contentfilter: 'off' }); } catch (e) {}
    const post = rated.find((r) => r && String(r.id) === gifs[0].id);
    if (post && !ratedG(post)) throw new Error(`YouTube only takes GIFs that Tenor rates G. This one is rated ${post.content_rating}.`);
    if (post) gifs[0].contentRating = post.content_rating;
    return gifs;
  }
  async function check(id) { const results = await fetchApi('/posts', { ids: id, contentfilter: 'off' }); const post = results.find((r)=> r && String(r.id) === id); const gif = post && toGif(post); return gif ? [gif] : []; }

  function decodeMediaId(mediaId) { const bin = atob(mediaId.slice(0,11).replace(/-/g,'+').replace(/_/g,'/') + '='); let n = 0n; for (let i=0;i<8;i++) n=(n<<8n)|BigInt(bin.charCodeAt(i)); return n.toString(); }

  async function newerRelease() {
    const current = '1.0.0';
    const saved = await gmGet('latestRelease');
    let release = saved && Date.now() - (saved.checkedAt||0) < UPDATE_CHECK_MS ? saved : null;
    if (!release) {
      const res = await gmFetch(RELEASES_API, { method: 'GET', timeout: TENOR_TIMEOUT_MS });
      if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
      const data = await (async()=>JSON.parse(res.responseText))();
      const version = String(data.tag_name || '').replace(/^v/, '');
      const url = String(data.html_url || '');
      if (!/^\d+(\.\d+){0,3}$/.test(version) || !url.startsWith(RELEASES_PAGE)) throw new Error('GitHub sent an answer that could not be read.');
      release = { version, url, checkedAt: Date.now() };
      await gmSet('latestRelease', release);
    }
    return newer(release.version, current) ? { version: release.version, url: release.url } : null;
  }
  function newer(a,b){ const x=a.split('.').map(Number); const y=b.split('.').map(Number); for (let i=0;i<Math.max(x.length,y.length);i++){ if ((x[i]||0)!==(y[i]||0)) return (x[i]||0)>(y[i]||0);} return false; }

  // ------------------- cross-tab favorites (storage) -------------------
  async function getFavorites() { try { const f = await gmGet('favorites'); return Array.isArray(f) ? f : []; } catch (e) { return []; } }
  async function setFavorites(v) { try { await gmSet('favorites', v); } catch (e) {} }

  // allow content area to call handler functions directly
  async function handleMsg(msg) {
    if (!msg || typeof msg !== 'object') throw new Error('Bad request.');
    if (msg.type === 'featured') return await featured();
    if (msg.type === 'search' && typeof msg.query === 'string') return await search(msg.query);
    if (msg.type === 'resolve' && typeof msg.input === 'string') return await resolve(msg.input);
    if (msg.type === 'check' && typeof msg.id === 'string') return await check(msg.id);
    if (msg.type === 'getFavorites') return await getFavorites();
    if (msg.type === 'setFavorites' && Array.isArray(msg.favorites)) { await setFavorites(msg.favorites); return true; }
    if (msg.type === 'update') return await newerRelease();
    throw new Error('Bad request.');
  }

  // ------------------- wire content script to background methods -------------------
  // The original extension used chrome.runtime.sendMessage; here we expose a
  // small bridge available to the content UI via window.__gcfy_bg
  window.__gcfy_bg = { call: async (msg) => { try { const r = await handleMsg(msg); return { ok: true, gifs: r }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } } };

  // Also implement cross-tab storage change listener for favorites using GM_addValueChangeListener when available
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('favorites', (name, oldVal, newVal) => {
      window.postMessage({ gcfy: 'favorites-changed', favorites: newVal }, location.origin);
    });
  } else {
    // fallback: poll
    let lastFav = await getFavorites();
    setInterval(async () => { const cur = await getFavorites(); try { if (JSON.stringify(cur) !== JSON.stringify(lastFav)) { lastFav = cur; window.postMessage({ gcfy: 'favorites-changed', favorites: cur }, location.origin); } } catch (e) {} }, 2000);
  }

  // ------------------- content script (adapted content.js) -------------------
  // We'll adapt the original content.js so it talks to window.__gcfy_bg.call instead of chrome.runtime.sendMessage

  // For brevity and to preserve behavior we mostly reuse the original content.js but replace the chrome.* calls

  (function(){
    // copy of content.js with minimal edits for message bridge
    const TAKEOVER = 'gcfy-takeover';
    const RELEASED = 'gcfy-released';
    document.dispatchEvent(new CustomEvent(TAKEOVER));
    const life = new AbortController();
    const { signal } = life;
    let retired = false;

    const BOX_SCOPE = 'ytd-comment-simplebox-renderer, ytd-comment-thread-renderer';
    const POST_DIALOG = 'ytd-backstage-post-dialog-renderer';
    const PICKER_W = 340; const PICKER_H = 420; const SEARCH_DEBOUNCE_MS = 350; const ARM_TIMEOUT_MS = 1500; const SUBMIT_GRACE_MS = 4000; const RESULT_TIMEOUT_MS = 60000; const CHECK_TIMEOUT_MS = 5000; const NO_FAVORITES = 'No favorites yet. Point at a GIF and click its star.';

    const PICKER_CSS = `:host { all: initial; position: fixed; z-index: 2147483647; }`;

    const fromMain = new Map();
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const msg = e.data;
      if (!msg || msg.gcfy !== 'to-content' || typeof msg.nonce !== 'string') return;
      const cb = fromMain.get(msg.nonce);
      if (cb) cb(msg);
    });
    const toMain = (msg) => window.postMessage(Object.assign({ gcfy: 'to-main' }, msg), location.origin);
    function newNonce(){ const bytes = crypto.getRandomValues(new Uint8Array(8)); return [...bytes].map((b)=>b.toString(16).padStart(2,'0')).join(''); }

    function addButton(box) {
      if (box.querySelector('.gcfy-btn')) return;
      if (!box.closest(BOX_SCOPE) || box.closest(POST_DIALOG)) return;
      const footer = box.querySelector('#footer'); if (!footer) return;
      const btn = document.createElement('button'); btn.type='button'; btn.className='gcfy-btn'; btn.title='Add a GIF'; btn.setAttribute('aria-label','Add a GIF'); btn.setAttribute('aria-haspopup','dialog'); btn.setAttribute('aria-expanded','false');
      btn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); if (picker.open && picker.anchor===btn) closePicker(); else openPicker(btn, box);});
      const emoji = footer.querySelector('#emoji-button'); if (emoji && emoji.parentElement===footer) emoji.after(btn); else footer.prepend(btn);
    }
    let scanQueued=false;
    function scan(){ scanQueued=false; if (retired) return; for (const box of document.querySelectorAll('ytd-commentbox')) addButton(box); }
    const scanner = new MutationObserver(()=>{ if (scanQueued) return; scanQueued=true; requestAnimationFrame(scan); });
    scanner.observe(document.documentElement, { childList: true, subtree: true });
    for (const el of document.querySelectorAll('.gcfy-btn, [data-gcfy-picker]')) el.remove();
    scan();

    const picker = { open:false, host:null, anchor:null, box:null, els:null, seq:0, timer:0, gifs:[], nonce:null, favorites:[], showingFavorites:false, updateAsked:false };

    function buildPicker(){
      const host = document.createElement('div'); host.setAttribute('data-gcfy-picker',''); host.setAttribute('popover','manual');
      for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu']) host.addEventListener(type,(e)=>e.stopPropagation());
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.textContent = PICKER_CSS;
      const panel = document.createElement('div'); panel.className='panel'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','Choose a GIF');
      const search = document.createElement('div'); search.className='search'; const input = document.createElement('input'); input.type='text'; input.placeholder='Search Tenor or paste a Tenor link'; input.setAttribute('aria-label','Search Tenor or paste a Tenor link'); input.autocomplete='off'; input.spellcheck=false; const favTab = document.createElement('button'); favTab.type='button'; favTab.className='fav-tab'; favTab.textContent='★'; favTab.title='Favorites'; favTab.setAttribute('aria-pressed','false'); search.append(input, favTab);
      const update = document.createElement('div'); update.className='update'; update.hidden=true; const updateText = document.createElement('span'); const updateLink = document.createElement('a'); updateLink.target='_blank'; updateLink.rel='noopener noreferrer'; updateLink.textContent='Download'; const updateClose = document.createElement('button'); updateClose.type='button'; updateClose.textContent='×'; updateClose.title='Hide until the next version'; updateClose.setAttribute('aria-label','Hide until the next version'); update.append(updateText, updateLink, updateClose);
      const status = document.createElement('div'); status.className='status'; status.setAttribute('role','status');
      const grid = document.createElement('div'); grid.className='grid'; panel.append(search, update, status, grid); root.append(style, panel);
      input.addEventListener('input', () => { clearTimeout(picker.timer); picker.timer = setTimeout(()=>load(input.value), SEARCH_DEBOUNCE_MS); });
      favTab.addEventListener('click', () => { if (picker.showingFavorites) { load(input.value); return; } clearTimeout(picker.timer); picker.seq++; setFavoritesView(true); renderFavorites(false); });
      grid.addEventListener('click',(e)=>{ const star = e.target.closest('.star'); const tile = e.target.closest('.tile'); if (star) toggleFavorite(picker.gifs[Number(star.dataset.index)]); else if (tile) attach(picker.gifs[Number(tile.dataset.index)]); });
      updateClose.addEventListener('click', ()=>{ update.hidden=true; gmSet('dismissedUpdate', update.dataset.version).catch(()=>{}); input.focus(); });
      picker.host = host; picker.els = { panel, input, status, grid, favTab, update, updateText, updateLink };
    }

    async function showUpdate(){ if (picker.updateAsked) return; picker.updateAsked=true; let release=null; try{ const reply = await window.__gcfy_bg.call({ type: 'update' }); release = reply && reply.version ? reply : null; } catch(e){} if (!release) return; const { update, updateText, updateLink } = picker.els; update.dataset.version = release.version; updateText.textContent = `Desktop GIFs ${release.version} is out.`; updateLink.href = release.url; update.hidden=false; }

    function setStatus(text, kind){ picker.els.status.textContent = text || ''; if (kind) picker.els.status.dataset.kind = kind; else delete picker.els.status.dataset.kind; }
    function place(){ if (!picker.open) return; if (!picker.anchor.isConnected) { closePicker(); return; } const r = picker.anchor.getBoundingClientRect(); const h = Math.min(PICKER_H, innerHeight - 16); picker.els.panel.style.height = `${h}px`; let top = r.top - h - 8; if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8); const left = Math.min(Math.max(8, r.left), innerWidth - PICKER_W - 8); picker.host.style.top = `${Math.max(8, top)}px`; picker.host.style.left = `${Math.max(8, left)}px`; }

    function openPicker(anchor, box){ if (!picker.host) buildPicker(); if (picker.open) closePicker(); picker.open=true; picker.anchor=anchor; picker.box=box; anchor.setAttribute('aria-expanded','true'); picker.els.panel.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark')); box.append(picker.host); picker.host.showPopover(); place(); picker.els.input.focus(); load(picker.els.input.value); showUpdate(); }
    function closePicker(){ if (!picker.open) return; picker.open=false; clearTimeout(picker.timer); picker.seq++; picker.anchor.setAttribute('aria-expanded','false'); picker.host.remove(); if (picker.anchor.isConnected) picker.anchor.focus(); }

    const looksLikeLink = (text) => /^\d{6,20}$/.test(text) || /^(https?:\/\/)?([\w-]+\.)*tenor\.com\//i.test(text);

    async function load(raw){ const text = raw.trim(); const seq = ++picker.seq; setFavoritesView(false); setStatus(text ? 'Searching…' : 'Loading…'); let reply; try { reply = await window.__gcfy_bg.call(!text ? { type: 'featured' } : looksLikeLink(text) ? { type: 'resolve', input: text } : { type: 'search', query: text }); } catch (e) { reply = { ok: false, error: 'The userscript logic failed. Refresh this page.' }; } if (seq !== picker.seq || !picker.open) return; if (!reply || !reply.ok) { render([]); setStatus((reply && reply.error) || 'Tenor could not be reached.', 'error'); return; } render(reply.gifs || []); setStatus((reply.gifs && reply.gifs.length) ? '' : 'No GIFs found.'); }

    function render(gifs){ picker.gifs = gifs; const cols = [0,1].map(()=>{ const col = document.createElement('div'); col.className='col'; return { el: col, height: 0 }; }); gifs.forEach((gif,i)=>{ const cell = document.createElement('div'); cell.className='cell'; const tile = document.createElement('button'); tile.type='button'; tile.className='tile'; tile.dataset.index=String(i); tile.title=gif.title; const img = document.createElement('img'); img.referrerPolicy='no-referrer'; img.loading='lazy'; img.src=gif.preview; img.alt=gif.title; img.width=gif.width; img.height=gif.height; tile.append(img); const star = document.createElement('button'); star.type='button'; star.className='star'; star.dataset.index=String(i); setStar(star,gif); cell.append(tile, star); const col = cols[0].height <= cols[1].height ? cols[0] : cols[1]; col.el.append(cell); col.height += gif.height / gif.width; }); picker.els.grid.replaceChildren(...cols.map((c)=>c.el)); picker.els.grid.scrollTop=0; }

    function setFavoritesView(on){ picker.showingFavorites = on; picker.els.favTab.setAttribute('aria-pressed', String(on)); }
    function setStar(star, gif) { const on = picker.favorites.some((f) => f.id === gif.id); star.textContent = on ? '★' : '☆'; star.title = on ? 'Remove from favorites' : 'Add to favorites'; star.setAttribute('aria-label', star.title); star.setAttribute('aria-pressed', String(on)); }
    function renderFavorites(keepScroll){ const top = keepScroll ? picker.els.grid.scrollTop : 0; render(picker.favorites); picker.els.grid.scrollTop = top; setStatus(picker.favorites.length ? '' : NO_FAVORITES); }
    function useFavorites(stored){ picker.favorites = (Array.isArray(stored) ? stored : []).filter((g) => g && typeof g.id === 'string' && typeof g.title === 'string' && typeof g.preview === 'string' && g.width > 0 && g.height > 0); if (!picker.open) return; if (picker.showingFavorites) renderFavorites(true); else for (const star of picker.els.grid.querySelectorAll('.star')) setStar(star, picker.gifs[Number(star.dataset.index)]); }

    (async ()=>{ const favs = await (window.__gcfy_bg.call({ type: 'getFavorites' }).then(r=>r.gifs).catch(()=>null)); if (Array.isArray(favs)) { picker.favorites = favs; } })();
    window.addEventListener('message', (e) => { if (e.data && e.data.gcfy === 'favorites-changed') { useFavorites(e.data.favorites); } });

    async function toggleFavorite(gif){ const rest = picker.favorites.filter((f) => f.id !== gif.id); try { const next = rest.length < picker.favorites.length ? rest : [gif, ...rest]; picker.favorites = next; await window.__gcfy_bg.call({ type: 'setFavorites', favorites: next }); } catch (e) { setStatus('The favorite could not be saved. Refresh this page.', 'error'); } }

    const attachments = new Map(); let passThrough=false; const BUTTON_STYLES = [['ytSpecButtonShapeNextDisabled','ytSpecButtonShapeNextMono'], ['yt-spec-button-shape-next--disabled','yt-spec-button-shape-next--mono']]; const submitOf = (box) => box.querySelector('#submit-button button'); const editorOf = (box) => box.querySelector('#contenteditable-root');

    function selectRange(editor, range){ editor.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    function appendMarker(editor, marker){ const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selectRange(editor, range); let done=false; try { done = document.execCommand('insertText', false, marker); } catch (e) {} if (!done || !editor.textContent.includes(marker)) { editor.append(document.createTextNode(marker)); editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data: marker })); } }
    function removeMarker(editor, marker){ const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); for (let node = walker.nextNode(); node; node = walker.nextNode()) { const at = node.data.indexOf(marker); if (at===-1) continue; const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at+marker.length); selectRange(editor, range); let done=false; try { done = document.execCommand('delete', false); } catch (e) {} if (!done || editor.textContent.includes(marker)) { node.data = node.data.replace(marker, ''); editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward'})); } return; } }
    const sleep = (ms) => new Promise((resolve)=>setTimeout(resolve, ms));

    function attach(gif){ const box = picker.box; const editor = box && box.isConnected && box.querySelector('#footer') && editorOf(box); if (!editor) { setStatus('The comment box was closed. Open it and try again.', 'error'); return; } const old = attachments.get(box); if (old && old.posting) return; attachTo(box, gif); closePicker(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selectRange(editor, range); }

    function attachTo(box, gif, kept){ const footer = box.querySelector('#footer'); detach(box, false); const chip = document.createElement('div'); chip.className='gcfy-attachment'; const frame = document.createElement('div'); frame.className='gcfy-attachment-gif'; const img = document.createElement('img'); img.referrerPolicy='no-referrer'; img.src = gif.preview; img.alt = gif.title; img.width = gif.width; img.height = gif.height; const remove = document.createElement('button'); remove.type='button'; remove.className='gcfy-attachment-remove'; remove.textContent='×'; remove.title='Remove the GIF'; remove.setAttribute('aria-label','Remove the GIF'); remove.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); if (!att.posting) detach(box, true); }); frame.append(img, remove); const status = document.createElement('div'); status.className='gcfy-attachment-status'; status.setAttribute('role','status'); chip.append(frame, status); footer.before(chip);
      const observer = new MutationObserver(()=> enableSubmit(box));
      const att = { gif, chip, status, observer, posting:false, greyed: (kept && kept.greyed) || [] };
      attachments.set(box, att);
      saveChip(att);
      if (kept) setChipStatus(att, kept.status, kept.kind);
      const submit = submitOf(box);
      if (submit) observer.observe(submit, { attributes: true, attributeFilter: ['disabled','aria-disabled','class'] });
      enableSubmit(box);
    }

    function saveChip(att){ att.chip.dataset.gcfyGif = JSON.stringify({ gif: att.gif, greyed: att.greyed }); }
    const isGif = (g) => g && typeof g.id==='string' && /^\d{1,20}$/.test(g.id) && typeof g.title==='string' && typeof g.preview==='string' && g.width>0 && g.height>0;
    const isStyle = (s) => Array.isArray(s) && s.length===2 && BUTTON_STYLES.some((b)=>b[0]===s[0] && b[1]===s[1]);

    function adoptChips(){ if (retired) return; for (const chip of document.querySelectorAll('.gcfy-attachment[data-gcfy-gif]:not([data-busy])')) { if ([...attachments.values()].some((att)=>att.chip===chip)) continue; const box = chip.closest('ytd-commentbox'); let saved=null; try { saved = JSON.parse(chip.dataset.gcfyGif); } catch (e) {} const status = chip.querySelector('.gcfy-attachment-status'); chip.remove(); if (!box || !box.querySelector('#footer') || !saved || !isGif(saved.gif) || attachments.has(box)) continue; attachTo(box, saved.gif, { greyed: Array.isArray(saved.greyed) ? saved.greyed.filter(isStyle) : [], status: status ? status.textContent : '', kind: status ? status.dataset.kind : undefined }); } }

    function enableSubmit(box){ const submit = submitOf(box); const att = attachments.get(box); if (!submit || !att || att.posting || editorOf(box)?.textContent.trim()) return; if (submit.disabled) submit.disabled = false; if (submit.hasAttribute('aria-disabled')) submit.removeAttribute('aria-disabled'); for (const style of BUTTON_STYLES) { if (!submit.classList.contains(style[0])) continue; submit.classList.replace(style[0], style[1]); if (!att.greyed.includes(style)) { att.greyed.push(style); saveChip(att); } } }

    function detach(box, restoreSubmit){ const att = attachments.get(box); if (!att) return; attachments.delete(box); att.observer.disconnect(); att.chip.remove(); const submit = submitOf(box); const editor = editorOf(box); if (restoreSubmit && submit && editor && !editor.textContent.trim()) { submit.disabled=true; for (const [disabled, enabled] of att.greyed) submit.classList.replace(enabled, disabled); } }
    function setChipStatus(att, text, kind){ att.status.textContent = text || ''; if (kind) att.status.dataset.kind = kind; else delete att.status.dataset.kind; }

    async function post(box){ const att = attachments.get(box); const editor = editorOf(box); const submit = submitOf(box); if (!att || att.posting || !editor || !submit) return; const nonce = newNonce(); const marker = `[[gif:${att.gif.id}:${nonce}]]`; let settle; const settled = new Promise((resolve)=>{ settle = resolve; }); let armedAck; const armedPromise = new Promise((resolve)=>{ armedAck = resolve; }); let seen = false; fromMain.set(nonce, (msg)=>{ if (msg.type === 'armed') armedAck(true); else if (msg.type === 'refused') armedAck('refused'); else if (msg.type === 'seen') seen = true; else if (msg.type === 'retrying') setChipStatus(att, `YouTube turned it down. Trying again (${msg.attempt} of ${msg.tries})…`); else if (msg.type === 'result') settle(msg); });
      att.posting = true; att.chip.toggleAttribute('data-busy', true); setChipStatus(att, 'Posting…');
      try {
        let rating = att.gif.contentRating;
        if (rating !== 'G') {
          setChipStatus(att, 'Checking the GIF…');
          const checked = await Promise.race([ window.__gcfy_bg.call({ type: 'check', id: att.gif.id }).then(r=>r.gifs).catch(()=>null), sleep(CHECK_TIMEOUT_MS).then(()=>null) ]);
          const found = checked && Array.isArray(checked) && checked.find((g)=>g.id===att.gif.id);
          rating = found ? found.contentRating : null;
          if (rating && rating !== 'G') { setChipStatus(att, `YouTube only takes GIFs that Tenor rates G. This one is rated ${rating}. Nothing was posted.`, 'error'); return; }
          if (!box.isConnected || !editor.getClientRects().length) { setChipStatus(att, 'The comment box was closed. Open it and try again.', 'error'); return; }
          setChipStatus(att, 'Posting…');
        }
        toMain({ type:'arm', id: att.gif.id, ratedG: rating === 'G', nonce });
        const armed = await Promise.race([ armedPromise, sleep(ARM_TIMEOUT_MS).then(()=>false) ]);
        if (armed !== true) { setChipStatus(att, armed === 'refused' ? 'Not ready in this tab yet. Try again in a few seconds, or refresh this page.' : 'The page hook is not running. Refresh this page and try again.', 'error'); return; }
        if (!box.isConnected || !editor.getClientRects().length) { toMain({ type: 'disarm', nonce }); setChipStatus(att, 'The comment box was closed. Open it and try again.', 'error'); return; }
        appendMarker(editor, marker);
        for (let i=0;i<20 && submit.disabled;i++) await sleep(50);
        passThrough = true;
        try { submit.click(); } finally { passThrough = false; }
        let result = await Promise.race([ settled, sleep(SUBMIT_GRACE_MS).then(()=>null) ]);
        if (!result && seen) result = await Promise.race([ settled, sleep(RESULT_TIMEOUT_MS).then(()=>null) ]);
        if (result && result.ok) { detach(box, false); return; }
        toMain({ type: 'disarm', nonce }); if (editor.isConnected) removeMarker(editor, marker); setChipStatus(att, (result && result.error) || 'The GIF was not sent. Nothing was posted.', 'error');
      } finally { fromMain.delete(nonce); att.posting = false; att.chip.toggleAttribute('data-busy', false); if (retired) { release(box); document.dispatchEvent(new CustomEvent(RELEASED)); } else { enableSubmit(box); } }
    }

    const boxIn = (path) => path.find((n)=>n.localName === 'ytd-commentbox');
    window.addEventListener('click', (e)=>{ if (passThrough) return; const path = e.composedPath(); const box = boxIn(path); if (!box || !attachments.has(box)) return; const submit = box.querySelector('#submit-button'); const cancel = box.querySelector('#cancel-button'); if (submit && path.includes(submit)) { e.preventDefault(); e.stopImmediatePropagation(); post(box); } else if (cancel && path.includes(cancel) && !attachments.get(box).posting) { detach(box, false); } }, { capture:true, signal });
    window.addEventListener('keydown', (e)=>{ if (inPicker(e)) return; if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return; const box = boxIn(e.composedPath()); if (!box || !attachments.has(box)) return; e.preventDefault(); e.stopImmediatePropagation(); post(box); }, { capture:true, signal });
    const inPicker = (e) => picker.open && e.composedPath().includes(picker.host);
    for (const type of ['keydown','keyup','keypress']) { window.addEventListener(type, (e)=>{ if (!inPicker(e)) return; e.stopImmediatePropagation(); if (type !== 'keydown') return; if (e.key === 'Escape') { e.preventDefault(); closePicker(); } else if (e.key === 'Enter' && e.composedPath()[0] === picker.els.input && picker.gifs.length === 1) { e.preventDefault(); attach(picker.gifs[0]); } }, { capture:true, signal }); }
    window.addEventListener('wheel', (e)=>{ if (inPicker(e)) e.stopImmediatePropagation(); }, { capture:true, passive:true, signal });
    window.addEventListener('pointerdown', (e)=>{ if (!picker.open) return; const path = e.composedPath(); if (!path.includes(picker.host) && !path.includes(picker.anchor)) closePicker(); }, { capture:true, signal });
    let placeQueued=false; const queuePlace = ()=>{ if (!picker.open || placeQueued) return; placeQueued=true; requestAnimationFrame(()=>{ placeQueued=false; place(); }); };
    window.addEventListener('scroll', queuePlace, { capture:true, passive:true, signal });
    window.addEventListener('resize', queuePlace, { passive:true, signal });
    window.addEventListener('yt-navigate-start', ()=>{ closePicker(); for (const [box, att] of attachments) if (!att.posting) detach(box, false); }, { signal });

    function release(box){ const att = attachments.get(box); if (!att) return; attachments.delete(box); att.observer.disconnect(); }
    function retire(){ retired=true; life.abort(); scanner.disconnect(); try{ /* nothing */ } catch (e) {} closePicker(); for (const [box, att] of attachments) if (!att.posting) release(box); }
    document.addEventListener(TAKEOVER, retire, { signal }); document.addEventListener(RELEASED, adoptChips, { signal }); adoptChips();
  })();

})();
