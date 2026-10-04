// Service worker template. pwa/vite-plugin.ts fills in the two placeholders at
// build time and emits the result as dist/sw.js, so every deploy (new commit =
// new __BUILD_VERSION__) produces a byte-different worker and browsers pick it
// up on the next visit.
const VERSION = '__SW_VERSION__';
const PRECACHE = __SW_PRECACHE__;

const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
// Covers and audio are immutable per filename, so they survive deploys instead
// of being re-downloaded every time the build version changes. Bump the suffix
// only if the caching scheme itself changes.
const MEDIA = 'media-v1';
// Same-origin art under /css/images/ (cover and buddy thumbnails, member
// portraits, group icons) keeps its filename across deploys too, so it stays
// offline after an update. A deploy can regenerate a thumb under the same
// name, hence stale-while-revalidate rather than cache-first.
const IMAGES = 'images-v1';
// Song configs are fetched as songs/<file>?v=<content hash>, so a URL never
// changes meaning: cache-first, no revalidation. Every edit leaves the old
// hash behind, which the cap eventually evicts.
const SONGS = 'songs-v1';
const KEEP = new Set([SHELL, RUNTIME, MEDIA, IMAGES, SONGS]);

// Opaque cross-origin responses count ~7 MB each against quota in Chrome and
// audio files are 3-8 MB, so cap how many we hold.
const MAX_COVERS = 120;
const MAX_AUDIO = 40;
// ~380 cover thumbs plus ~175 portraits on the anime site, more covers on kpop;
// thumbs average ~50 KB.
const MAX_IMAGES = 800;
const MAX_SONGS = 900;
const SONG_HASH_RE = /^[0-9a-f]{10}$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // One missing page (e.g. guide.html on the kpop build) shouldn't abort
      // the whole install, so add entries individually.
      .then(cache => Promise.all(PRECACHE.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }
  if (AUDIO_RE.test(url.pathname) && !sameOrigin) {
    event.respondWith(audio(event, req));
    return;
  }
  if (url.pathname.includes('/covers-v1/') || (sameOrigin && url.pathname.includes('/images/covers/'))) {
    event.respondWith(cacheFirst(req, MEDIA, MAX_COVERS, /covers(-v1)?\//));
    return;
  }
  if (!sameOrigin) return;
  if (url.pathname.startsWith('/assets/')) {
    // Hashed filenames: a hit is always correct.
    event.respondWith(cacheFirst(req, SHELL));
    return;
  }
  if (url.pathname.startsWith('/css/images/')) {
    event.respondWith(staleWhileRevalidate(event, req, IMAGES, MAX_IMAGES));
    return;
  }
  if (url.pathname.startsWith('/songs/') && url.pathname.endsWith('.json')
      && SONG_HASH_RE.test(url.searchParams.get('v') || '')) {
    event.respondWith(cacheFirst(req, SONGS, MAX_SONGS));
    return;
  }
  if (url.pathname.endsWith('.json') || url.pathname.startsWith('/css/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(staleWhileRevalidate(event, req, RUNTIME));
  }
});

// HTML always tries the network so a deploy is visible immediately; the cache
// is only the offline fallback. ignoreSearch lets play.html?song=x fall back
// to the precached play.html.
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(stripSearch(req.url), resp.clone());
    return resp;
  } catch (err) {
    const url = new URL(req.url);
    const hit = await cache.match(req, { ignoreSearch: true })
      || (url.pathname.endsWith('/') ? await cache.match(url.pathname + 'index.html') : undefined);
    // Browsers refuse a redirected response for a navigation, so strip the
    // redirect flag in case the precache followed one.
    if (hit) return hit.redirected ? new Response(hit.body, hit) : hit;
    throw err;
  }
}

async function cacheFirst(req, name, max, pattern) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok || resp.type === 'opaque') {
    await cache.put(req, resp.clone());
    if (max) trim(cache, max, pattern);
  }
  return resp;
}

// With `max`, a new entry trims the cache. A refresh re-puts its entry at the
// back of the key order, so trim evicts what was used least recently.
async function staleWhileRevalidate(event, req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const refresh = fetch(req).then(async resp => {
    if (resp.ok) {
      await cache.put(req, resp.clone());
      // a miss is still being answered here, so the event can be extended
      if (max && !hit) event.waitUntil(trim(cache, max));
    }
    return resp;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh;
}

// Howler streams through <audio>, which sends Range requests: Chrome opens
// with `bytes=0-` and then reads the tail of an ogg for its duration, Safari
// probes `bytes=0-1` and won't play without real 206s. The Cache API can't
// store 206s, so a track is cached whole and ranges are sliced out of it.
//
// A track's first play on the play page makes one CORS fetch of the whole file
// and writes it into a buffer as it arrives. Range requests for that track are
// answered from the buffer while it fills, so the file crosses the network
// once, and the finished buffer goes into the cache. Other pages (Bubudle only
// plays 4 s clips) pass straight through and never fill.
//
// Chrome rejects a media element whose range responses come from different
// sources (a SW-built response has no URL, a passed-through one does), so
// once an element is being served from a fill or the cache, every later range
// it asks for must be SW-built too, never a passthrough.
//
// GitHub-direct audio has no CORS headers, so its fill fails and it streams
// uncached.
const AUDIO_RE = /\.(ogg|m4a)$/i;
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
// A request starting further than this past what the fill has received gets
// its own range fetch instead of waiting for the download to catch up.
// Open-ended ones (Chrome's `bytes=N-`) are capped at RANGE_CHUNK, a legal
// short 206 the browser follows up on, so a seek doesn't re-download the rest
// of the file alongside the fill. 512 KB is ~20 s of 192 kbps audio.
const SEEK_AHEAD = 256 * 1024;
const RANGE_CHUNK = 512 * 1024;
const filling = new Map();
// Tracks whose fill failed (no CORS, network error, unusable response), so
// the media element's follow-up and retry requests don't each start another
// full fetch. Lives as long as the worker does.
const noFill = new Set();

async function audio(event, req) {
  const cache = await caches.open(MEDIA);
  const key = stripSearch(req.url);
  let range;
  try {
    range = parseRange(req.headers.get('Range'));
  } catch {
    return fetch(req);
  }
  const hit = await cache.match(key);
  if (hit) {
    let blob;
    try {
      blob = await hit.blob();
    } catch {
      // Corrupt entry — drop it and fall through to the network.
      await cache.delete(key);
    }
    if (blob) return sliceResponse(blob, range, blob.size, hit.headers.get('Content-Type'));
  }
  if (!filling.has(key) && !noFill.has(key) && await playsFullTrack(event.clientId)) {
    // Another request for the track may have started one during the await.
    if (!filling.has(key)) startFill(event, cache, key);
  }
  const fill = await filling.get(key);
  return fill ? fromFill(fill, range, key) : fetch(req);
}

// Only the play page plays whole tracks (same check as main.ts routing).
// Media requests from a page carry its clientId in Chrome; where one doesn't,
// we can't tell who's asking, so we don't fill.
async function playsFullTrack(clientId) {
  if (!clientId) return false;
  const client = await self.clients.get(clientId);
  return !!client && new URL(client.url).pathname.endsWith('play.html');
}

// Registers the fill synchronously so concurrent range requests share it.
// Resolves to null (requests pass through) if the file can't be filled.
function startFill(event, cache, key) {
  const job = fetch(key, { mode: 'cors', credentials: 'omit' }).then(resp => {
    const size = Number(resp.headers.get('Content-Length'));
    if (resp.status !== 200 || !resp.body || !(size > 0) || size > MAX_AUDIO_BYTES) {
      resp.body?.cancel();
      noFill.add(key);
      filling.delete(key);
      return null;
    }
    let wake = () => {};
    const fill = {
      size,
      type: resp.headers.get('Content-Type'),
      buf: new Uint8Array(size),
      received: 0,
      failed: false,
      progress: null,
      tick() {
        wake();
        fill.progress = new Promise(r => { wake = r; });
      },
    };
    fill.tick();
    event.waitUntil(pump(fill, resp.body.getReader(), cache, key));
    return fill;
  }, () => {
    noFill.add(key);
    filling.delete(key);
    return null;
  });
  filling.set(key, job);
}

async function pump(fill, reader, cache, key) {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (fill.received + value.byteLength > fill.size) throw new Error('body longer than Content-Length');
      fill.buf.set(value, fill.received);
      fill.received += value.byteLength;
      fill.tick();
    }
    if (fill.received !== fill.size) throw new Error('body shorter than Content-Length');
    await cache.put(key, new Response(fill.buf, {
      headers: { 'Content-Type': fill.type || 'application/octet-stream', 'Content-Length': String(fill.size) },
    }));
    await trim(cache, MAX_AUDIO, AUDIO_RE);
  } catch {
    // Readers that already have their bytes finish normally; ones still
    // waiting error out, which surfaces as a Howler loaderror.
    noFill.add(key);
    fill.failed = true;
    fill.tick();
  } finally {
    filling.delete(key);
  }
}

async function fromFill(fill, range, key) {
  const { start, end } = resolveRange(range, fill.size);
  if (start <= end && start > fill.received + SEEK_AHEAD) {
    const last = range.last === null ? Math.min(end, start + RANGE_CHUNK - 1) : end;
    const resp = await fetchRange(key, start, last);
    if (resp) return sliceResponse(resp.body, { first: start, last }, fill.size, fill.type);
  }
  let pos = start;
  const body = new ReadableStream({
    async pull(ctrl) {
      while (fill.received <= pos) {
        if (fill.failed) {
          ctrl.error(new Error('audio fill failed'));
          return;
        }
        await fill.progress;
      }
      const stop = Math.min(fill.received, end + 1);
      ctrl.enqueue(fill.buf.slice(pos, stop));
      pos = stop;
      if (pos > end) ctrl.close();
    },
  });
  return sliceResponse(body, range, fill.size, fill.type);
}

// A simple Range header is CORS-safelisted (no preflight) in current Chrome.
// Where it isn't, the preflight hits the audio worker's 405 and this returns
// null, so the caller waits for the fill to reach the range instead.
async function fetchRange(key, start, end) {
  try {
    const resp = await fetch(key, { mode: 'cors', credentials: 'omit', headers: { Range: `bytes=${start}-${end}` } });
    if (resp.status === 206 && Number(resp.headers.get('Content-Length')) === end - start + 1) return resp;
    resp.body?.cancel();
  } catch {
    // Fall back to the fill.
  }
  return null;
}

// null means no Range header (whole file).
function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) throw new Error('unsupported range');
  return { first: m[1] === '' ? null : Number(m[1]), last: m[2] === '' ? null : Number(m[2]) };
}

function resolveRange(range, size) {
  if (!range) return { start: 0, end: size - 1 };
  const start = range.first === null ? Math.max(0, size - range.last) : range.first;
  const end = range.first !== null && range.last !== null ? Math.min(range.last, size - 1) : size - 1;
  return { start, end };
}

// body is a Blob of the whole file, or a stream that already starts at the
// requested offset.
function sliceResponse(body, range, size, type) {
  const { start, end } = resolveRange(range, size);
  if (start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const headers = {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (body instanceof Blob) body = body.slice(start, end + 1);
  return new Response(body, { status: range ? 206 : 200, headers });
}

// Cache keys come back in insertion order, so dropping from the front evicts
// the oldest entries first.
async function trim(cache, max, pattern) {
  const keys = (await cache.keys()).filter(k => !pattern || pattern.test(new URL(k.url).pathname));
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function stripSearch(href) {
  const u = new URL(href);
  u.search = '';
  return u.href;
}
