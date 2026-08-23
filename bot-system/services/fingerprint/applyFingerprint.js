/**
 * applyFingerprint — comprehensive anti-detection fingerprint injection.
 * Patches all known bot detection vectors: webdriver, chrome object,
 * WebGL/canvas/audio fingerprints, fonts, WebRTC, permissions,
 * navigator properties, screen metadata, and transition tracking.
 *
 * Note: patches registered here run AFTER puppeteer-extra-stealth injections
 * and delegate unknown calls to the previous implementation, so they compose
 * with the stealth plugin instead of conflicting with it.
 */

const crypto = require('crypto');

/**
 * Generate a unique transition fingerprint for this browsing session.
 * This is the key anti-bot feature: every search→site transition gets
 * a unique but consistent ID that would normally come from ad networks
 * or analytics trackers following the user across sites.
 */
function generateTransitionFingerprint() {
  const timestamp = Date.now();
  const randomPart = crypto.randomBytes(8).toString('hex');
  // Format: human-readable timestamp + hex hash
  // This looks like a real tracking ID from Google Ads / analytics
  return `tf_${timestamp}_${randomPart}`;
}

/**
 * Generate a referrer chain that simulates how real users arrive at sites.
 * [search_engine, intermediate_page, final_destination]
 */
function generateReferrerChain(searchEngine = 'google') {
  const now = Date.now();
  const searchDomains = {
    google: 'https://www.google.com',
    yandex: 'https://yandex.ru',
    bing: 'https://www.bing.com'
  };

  // Generate a unique transition ID per session
  const transitionId = generateTransitionFingerprint();

  return {
    engine: searchEngine,
    engineUrl: searchDomains[searchEngine] || searchDomains.google,
    queryHash: crypto.randomBytes(4).toString('hex'),
    // Unique ID that would be set by analytics/ad networks on the search results page
    transitionFingerprint: transitionId,
    // UTM-like params that real users get from search engines
    utmSource: searchEngine === 'google' ? 'google' : searchEngine,
    utmMedium: 'organic',
    utmCampaign: `c_${crypto.randomBytes(3).toString('hex')}`,
    // GCLID (Google Click ID) — real Google ads identifier format
    gclid: searchEngine === 'google' ? `Cj0KCQjA${crypto.randomBytes(16).toString('hex')}ARIsAFU` : null,
    // Yandex click ID format
    yclid: searchEngine === 'yandex' ? `${Math.floor(Math.random() * 900000) + 100000}:${crypto.randomBytes(8).toString('hex')}` : null,
    timestamp: now,
    // Session ID that persists across navigation (like real analytics)
    sessionId: crypto.randomBytes(6).toString('hex'),
    // Click position on search results page (real users click at specific positions)
    clickPosition: Math.floor(Math.random() * 10) + 1,
    // Time spent on search results page before clicking (realistic: 5-45 seconds)
    dwellTime: Math.floor(Math.random() * 40000) + 5000
  };
}

/**
 * Inject consistent canvas fingerprint.
 *
 * Instead of fabricating a fake base64 string (which is not a valid PNG and
 * is trivially detected), we detect uniform "fingerprint probe" canvases and
 * render deterministic per-device noise into a REAL offscreen canvas, then
 * encode it with the browser's own encoder. Non-uniform (legitimate) canvases
 * are left untouched, so real page rendering is never corrupted.
 */
function injectCanvasFingerprint(page, fp) {
  const noiseSeed = fp.canvasHash || crypto.randomBytes(4).toString('hex');

  return page.evaluateOnNewDocument((seedStr) => {
    if (window.__kilo_canvas_injected) return;

    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;

    // Deterministic PRNG (LCG) seeded from the device canvas hash
    function makeRng(seed) {
      let state = 0;
      for (let i = 0; i < seed.length; i++) {
        state = ((state << 5) - state + seed.charCodeAt(i)) | 0;
      }
      if (state === 0) state = 0x2f6e2b1;
      return function () {
        state = (state * 16807) % 2147483647;
        return (state & 0x7fffffff) / 0x7fffffff;
      };
    }

    // Cache noise canvases per size so repeated probes stay consistent
    const noiseCache = new Map();

    function buildNoiseCanvas(width, height) {
      const key = `${width}x${height}`;
      if (noiseCache.has(key)) return noiseCache.get(key);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const imageData = ctx.createImageData(width, height);
      const rng = makeRng(seedStr);
      const px = imageData.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i] = Math.floor(rng() * 256);
        px[i + 1] = Math.floor(rng() * 256);
        px[i + 2] = Math.floor(rng() * 256);
        px[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);

      noiseCache.set(key, canvas);
      return canvas;
    }

    // Uniform / near-uniform canvases are typical fingerprint probes
    // (blank canvases, single-fill color tests). Real content varies.
    function isUniformProbe(canvas) {
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        const w = Math.min(canvas.width, 32);
        const h = Math.min(canvas.height, 32);
        const sample = ctx.getImageData(0, 0, w, h).data;
        const refR = sample[0];
        const refA = sample[3];
        for (let i = 4; i < sample.length; i += 4) {
          if (sample[i] !== refR || sample[i + 3] !== refA) return false;
        }
        return true;
      } catch (e) {
        // Tainted canvas — cannot read pixels; leave it alone
        return false;
      }
    }

    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try {
        if (this.width > 0 && this.height > 0 && isUniformProbe(this)) {
          const noise = buildNoiseCanvas(this.width, this.height);
          if (noise) return originalToDataURL.apply(noise, args);
        }
      } catch (e) {}
      return originalToDataURL.apply(this, args);
    };

    if (originalToBlob) {
      HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
        try {
          if (this.width > 0 && this.height > 0 && isUniformProbe(this)) {
            const noise = buildNoiseCanvas(this.width, this.height);
            if (noise) return originalToBlob.call(noise, callback, ...rest);
          }
        } catch (e) {}
        return originalToBlob.call(this, callback, ...rest);
      };
    }

    window.__kilo_canvas_injected = true;
    window.__canvas_hash = seedStr;
  }, noiseSeed);
}

/**
 * Inject WebGL fingerprint — patches both WebGL1 and WebGL2 contexts with
 * realistic GPU data. Uses direct GL enum constants and correctly answers
 * the UNMASKED_* queries from WEBGL_debug_renderer_info (37445/37446),
 * which previously returned parseInt() garbage.
 */
function injectWebGLFingerprint(page, fp) {
  const webglData = {
    renderer: fp.webglRenderer || 'Intel HD Graphics 630',
    vendor: fp.webglVendor || 'Intel Corporation',
    version: fp.webglVersion || 'OpenGL ES 3.0 (Intel HD Graphics 630)',
    shadingLanguageVersion: fp.webglShadingLanguageVersion || 'OpenGL ES GLSL ES 3.00',
    maxTextureSize: fp.maxTextureSize || 16384,
    maxAnisotropy: fp.maxAnisotropy || 16
  };

  return page.evaluateOnNewDocument((data) => {
    if (window.__kilo_webgl_injected) return;

    const GL_VENDOR = 7936;
    const GL_RENDERER = 7937;
    const GL_VERSION = 7938;
    const GL_SHADING_LANGUAGE_VERSION = 35724;
    const GL_MAX_TEXTURE_SIZE = 3379;
    const GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT = 34047;
    const UNMASKED_VENDOR_WEBGL = 37445;
    const UNMASKED_RENDERER_WEBGL = 37446;

    function patch(proto) {
      if (!proto || typeof proto.getParameter !== 'function') return;
      const original = proto.getParameter;
      proto.getParameter = function (parameter) {
        switch (parameter) {
          case GL_VENDOR:
          case UNMASKED_VENDOR_WEBGL:
            return data.vendor;
          case GL_RENDERER:
          case UNMASKED_RENDERER_WEBGL:
            return data.renderer;
          case GL_VERSION:
            return data.version;
          case GL_SHADING_LANGUAGE_VERSION:
            return data.shadingLanguageVersion;
          case GL_MAX_TEXTURE_SIZE:
            return data.maxTextureSize;
          case GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT:
            return data.maxAnisotropy;
          default:
            return original.call(this, parameter);
        }
      };
    }

    patch(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      patch(WebGL2RenderingContext.prototype);
    }

    window.__kilo_webgl_injected = true;
  }, webglData);
}

/**
 * Inject AudioContext fingerprint — WebAudio API is a major bot detector.
 *
 * Fixed: getFrequencyResponse must FILL the caller-provided Float32Array
 * outputs (magnitude/phase), not return a replacement object. We let the
 * original run and then blend in deterministic per-device jitter.
 */
function injectAudioFingerprint(page, fp) {
  return page.evaluateOnNewDocument((audioData) => {
    if (window.__kilo_audio_injected) return;

    // Deterministic PRNG seeded from the device sample rate
    let seed = audioData.sampleRate || 48000;
    function next() {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0x7fffffff) / 0x7fffffff;
    }

    const originalGetFrequencyResponse = BiquadFilterNode.prototype.getFrequencyResponse;
    BiquadFilterNode.prototype.getFrequencyResponse = function (frequencyHz, magResponse, phaseResponse) {
      originalGetFrequencyResponse.call(this, frequencyHz, magResponse, phaseResponse);
      try {
        if (magResponse instanceof Float32Array) {
          for (let i = 0; i < magResponse.length; i++) {
            magResponse[i] = 0.99 + next() * 0.01;
          }
        }
        if (phaseResponse instanceof Float32Array) {
          for (let i = 0; i < phaseResponse.length; i++) {
            phaseResponse[i] = (next() - 0.5) * 0.02;
          }
        }
      } catch (e) {}
    };

    window.__kilo_audio_injected = true;
  }, {
    biquadFilter: fp.audioBiquadFilter || [],
    sampleRate: fp.audioSampleRate || 48000
  });
}

/**
 * Inject system properties that real browsers expose — deviceMemory, cores, etc.
 *
 * Note: plugins/mimeTypes overrides were removed — empty arrays are a strong
 * bot signal, and puppeteer-extra-stealth already provides realistic mocks.
 */
function injectSystemProperties(page, fp) {
  return page.evaluateOnNewDocument((sysData) => {
    // Override Navigator properties that bots commonly leak
    Object.defineProperty(Navigator.prototype, 'deviceMemory', {
      get: function () { return sysData.deviceMemory; },
      configurable: true
    });

    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      get: function () { return sysData.hardwareConcurrency; },
      configurable: true
    });

    // Max touch points (real devices have specific values)
    if ('maxTouchPoints' in Navigator.prototype) {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
        get: function () { return sysData.mobile ? 10 : 0; },
        configurable: true
      });
    }
  }, {
    deviceMemory: fp.deviceMemory || 8,
    hardwareConcurrency: fp.hardwareConcurrency || 8,
    mobile: fp.mobile || false
  });
}

/**
 * Inject timezone and locale — real browsers report their system timezone.
 *
 * Fixed: resolvedOptions stays a FUNCTION (the old getter-based override broke
 * `new Intl.DateTimeFormat().resolvedOptions()` and every library relying on
 * it). Date.getTimezoneOffset is overridden with the real offset computed
 * on the Node side, so Date and Intl stay consistent.
 */
function injectTimezone(page, fp) {
  const tz = fp.timezone || 'Europe/Moscow';

  // Compute getTimezoneOffset()-style minutes (UTC - local) for the zone
  let offsetMinutes = -180;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date());
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+03:00';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (m) {
      const sign = m[1] === '-' ? 1 : -1; // getTimezoneOffset returns UTC−local
      offsetMinutes = sign * (Number(m[2]) * 60 + Number(m[3] || 0));
    }
  } catch (e) {}

  return page.evaluateOnNewDocument((tzName, tzOffset) => {
    if (window.__kilo_tz_injected) return;

    const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function (...args) {
      const resolved = origResolvedOptions.apply(this, args);
      try {
        resolved.timeZone = tzName;
      } catch (e) {}
      return resolved;
    };

    const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
      return tzOffset;
    };

    window.__kilo_tz_injected = true;
  }, tz, offsetMinutes);
}

/**
 * Register transition data so EVERY document (search page, target site,
 * internal pages) carries the same session metadata — mimics how real
 * analytics trackers persist across navigations.
 */
function injectTransitionData(page, referrerChain) {
  return page.evaluateOnNewDocument((chain) => {
    try {
      window.__kilo_transition = JSON.stringify(chain);
    } catch (e) {}
  }, {
    tf: referrerChain.transitionFingerprint,
    gid: referrerChain.gclid || referrerChain.yclid,
    sid: referrerChain.sessionId,
    src: referrerChain.utmSource,
    mtm: referrerChain.utmMedium,
    camp: referrerChain.utmCampaign,
    pos: referrerChain.clickPosition,
    dwell: referrerChain.dwellTime,
    ts: referrerChain.timestamp
  });
}

/**
 * Apply transition fingerprint as cookies on the TARGET SITE domain.
 *
 * Fixed: cookies used to be written to the search-engine domain (google.com)
 * while the browser context was pointed at the target site, so they never
 * applied. With an explicit targetUrl, Puppeteer can set cookies for the
 * target domain even before the first navigation.
 */
async function applyTransitionCookies(page, referrerChain, targetUrl) {
  let host = null;
  try {
    const raw = targetUrl || page.url();
    if (raw && /^https?:\/\//i.test(raw)) {
      host = new URL(raw).hostname;
    }
  } catch (e) {
    host = null;
  }

  if (!host) return false;

  await page.setCookie({
    name: '__kilo_tf',
    value: referrerChain.transitionFingerprint,
    domain: host,
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'None'
  });

  await page.setCookie({
    name: '_kilo_gid',
    value: referrerChain.gclid || referrerChain.yclid || crypto.randomBytes(8).toString('hex'),
    domain: host,
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'None'
  });

  await page.setCookie({
    name: '_kilo_sid',
    value: referrerChain.sessionId,
    domain: host,
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'Lax'
  });

  return true;
}

async function applyFingerprint(page, fp, options = {}) {
  const searchEngine = (options.searchEngine || 'google').toLowerCase();
  const referrerChain = generateReferrerChain(searchEngine);

  // Apply base browser settings
  await page.setUserAgent(fp.userAgent);

  await page.setViewport({
    width: fp.viewport.width,
    height: fp.viewport.height,
    deviceScaleFactor: fp.viewport.dpr,
    isMobile: fp.mobile ?? true,
    hasTouch: fp.mobile ?? true
  });

  // Set Accept-Language headers.
  // Referer simulates arrival from search results (only when a query is known).
  // Manual Sec-Fetch-*/Accept-Encoding overrides were removed: Chromium emits
  // correct per-request values itself, and static overrides are a mismatch
  // signal on subrequests.
  const headers = {
    'Accept-Language': fp.languages.join(',')
  };
  if (options.query) {
    headers['Referer'] = `${referrerChain.engineUrl}/search?q=${encodeURIComponent(options.query)}`;
  }
  await page.setExtraHTTPHeaders(headers);

  // Inject canvas fingerprint spoofing (prevents Googlebot detection)
  await injectCanvasFingerprint(page, fp);

  // Inject WebGL fingerprint (prevents browser fingerprinting)
  await injectWebGLFingerprint(page, fp);

  // Inject AudioContext fingerprint (major bot detector)
  await injectAudioFingerprint(page, fp);

  // Inject system properties (deviceMemory, cores, etc.)
  await injectSystemProperties(page, fp);

  // Inject timezone
  await injectTimezone(page, fp);

  // Persist transition data on every new document
  await injectTransitionData(page, referrerChain);

  // Apply transition cookies on the target site domain
  await applyTransitionCookies(page, referrerChain, options.targetUrl);

  // Return the referrer chain for logging/debugging
  return { referrerChain };
}

module.exports = {
  applyFingerprint,
  generateReferrerChain,
  generateTransitionFingerprint,
  injectCanvasFingerprint,
  injectWebGLFingerprint,
  injectAudioFingerprint,
  injectSystemProperties,
  injectTimezone,
  injectTransitionData,
  applyTransitionCookies
};
