const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const proxies = require('./proxies');
const { searchViaForm } = require('./search-input');
const { matchesTarget, failedVisit, arrivalResult, followSearchLink, formatVisitSummary } = require('./visit-result');

puppeteer.use(StealthPlugin());

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^a-z0-9а-яё._-]+/giu, '_').replace(/^_+|_+$/g, '');
}

// ─── SmartCaptcha image capture (ImageToTextTask input) ──

// The real SmartCaptcha challenge image is a narrow strip of glyphs (~a few
// KB). The old code screenshotted the whole widget/page (~500KB), so the OCR
// solver received a full-page screenshot instead of the glyph strip and
// returned garbage. Strategy: read the captcha <img> src directly, and only
// screenshot captcha-class elements that are small enough to BE the challenge.
const CAPTCHA_IMAGE_SELECTORS = [
  '.CheckboxCaptcha-Image',
  '.CheckboxCaptcha-Button img',
  '.CheckboxCaptcha img',
  '[class*="Captcha"] img',
  '[class*="captcha"] img',
  '[class*="Captcha"] canvas',
  '[class*="captcha"] canvas',
];

// A captcha glyph strip is tiny; anything bigger than this is the page/widget,
// not the challenge image.
const MAX_CAPTCHA_IMAGE_BYTES = 60 * 1024;

// Find the challenge image element by src, preferring real captcha endpoints.
async function getCaptchaImageBase64(page) {
  // Stage 1: read <img src> of captcha-class elements directly (data URI or URL).
  try {
    const src = await page.evaluate((sels) => {
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const tag = el.tagName;
          if (tag === 'IMG') {
            const s = el.currentSrc || el.src || '';
            if (s.startsWith('data:image')) return s;
          } else if (tag === 'CANVAS') {
            try { return el.toDataURL('image/png'); } catch (e) { /* tainted canvas */ }
          }
        }
      }
      return null;
    }, CAPTCHA_IMAGE_SELECTORS);
    if (src && src.startsWith('data:image')) {
      const b64 = src.split(',')[1] || '';
      console.log(`  🖼️ Captcha image read from element src (${b64.length} chars base64)`);
      return b64;
    }
  } catch (e) {
    console.log(`  ⚠️ Captcha src read failed: ${e.message}`);
  }

  // Stage 2: screenshot a captcha-class element, but only if its bounding box
  // is glyph-strip sized. This avoids the old 500KB full-widget screenshots.
  for (const sel of CAPTCHA_IMAGE_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 10 || box.height < 10) continue;
      if (box.width * box.height > 400 * 200) {
        console.log(`  ↷ Skipping oversized captcha element "${sel}" (${Math.round(box.width)}x${Math.round(box.height)}) — not a glyph strip`);
        continue;
      }
      const buf = await el.screenshot({ type: 'png' });
      if (buf.length > MAX_CAPTCHA_IMAGE_BYTES) {
        console.log(`  ↷ Skipping "${sel}" screenshot (${buf.length} bytes > ${MAX_CAPTCHA_IMAGE_BYTES} limit)`);
        continue;
      }
      console.log(`  🖼️ Captcha image captured from "${sel}" (${buf.length} bytes)`);
      return buf.toString('base64');
    } catch (e) {
      console.log(`  ⚠️ Captcha element screenshot failed for "${sel}": ${e.message}`);
    }
  }

  // Stage 3: viewport fallback, size-checked. NEVER fullPage.
  try {
    const buf = await page.screenshot({ type: 'png' });
    if (buf.length <= MAX_CAPTCHA_IMAGE_BYTES * 4) {
      console.log(`  🖼️ Captcha image captured from viewport (${buf.length} bytes)`);
      return buf.toString('base64');
    }
    console.log(`  ⚠️ Viewport screenshot too large for OCR (${buf.length} bytes) — skipping image task`);
    return null;
  } catch (e) {
    console.log(`  ⚠️ Captcha viewport screenshot failed: ${e.message}`);
    return null;
  }
}

async function saveCaptchaScreenshot(page, label = 'captcha') {
  try {
    const dir = path.join(__dirname, '.captcha-screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${stamp}_${safeFilePart(label)}.png`;
    const screenshotPath = path.join(dir, file);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  📸 Captcha screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  } catch (e) {
    console.log(`  ⚠️ Failed to save captcha screenshot: ${e.message}`);
    return null;
  }
}

// Dump the captcha DOM (forms, inputs, buttons) so the token-targeting
// selectors can be fixed against the real page, not guesses.
async function dumpCaptchaDom(page, label = 'captcha') {
  try {
    const dir = path.join(__dirname, '.captcha-screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = path.join(dir, `${stamp}_${safeFilePart(label)}_dom.html`);
    const info = await page.evaluate(() => {
      const lines = [`URL: ${location.href}`, ''];
      for (const f of document.querySelectorAll('form')) {
        lines.push(`FORM action="${f.getAttribute('action') || ''}" method="${f.method}" id="${f.id}" class="${f.className}"`);
        for (const el of f.querySelectorAll('input, textarea, select, button')) {
          lines.push(`  <${el.tagName.toLowerCase()}> type=${el.type || ''} name="${el.name || ''}" id="${el.id}" class="${el.className}" value="${(el.value || '').slice(0, 40)}"`);
        }
      }
      for (const el of document.querySelectorAll('input, textarea')) {
        if (el.closest('form')) continue;
        lines.push(`ORPHAN <${el.tagName.toLowerCase()}> type=${el.type || ''} name="${el.name || ''}" id="${el.id}" class="${el.className}"`);
      }
      return lines.join('\n');
    });
    fs.writeFileSync(htmlPath, `<!-- ${new Date().toISOString()} -->\n${info}\n\n${await page.content()}`, 'utf8');
    console.log(`  🧬 Captcha DOM dump saved: ${htmlPath}`);
    return htmlPath;
  } catch (e) {
    console.log(`  ⚠️ Failed to dump captcha DOM: ${e.message}`);
    return null;
  }
}

// ─── Human-like helpers ──────────────────────────────────

// Device profiles keep the fingerprint CONSISTENT with the proxy type:
// mobile-operator proxies (IP of cell carriers) must look like smartphones,
// desktop/ISP proxies like PCs. A mobile IP + desktop UA is an anomaly that
// search engines detect.

const DESKTOP_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1680, height: 1050 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 }
];

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
];

const MOBILE_VIEWPORTS = [
  { width: 390, height: 844, deviceScaleFactor: 3 },    // iPhone 12/13/14
  { width: 393, height: 852, deviceScaleFactor: 3 },    // iPhone 14/15 Pro
  { width: 360, height: 800, deviceScaleFactor: 3 },    // Samsung Galaxy S21
  { width: 412, height: 915, deviceScaleFactor: 2.6 }   // Pixel 7
];

const MOBILE_UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
];

function pickViewport(device) {
  if (device === 'mobile') {
    return { ...MOBILE_VIEWPORTS[Math.floor(Math.random() * MOBILE_VIEWPORTS.length)], isMobile: true, hasTouch: true };
  }
  const vp = DESKTOP_VIEWPORTS[Math.floor(Math.random() * DESKTOP_VIEWPORTS.length)];
  return { ...vp, deviceScaleFactor: Math.random() < 0.25 ? 2 : 1 };
}

// ─── Manual anti-detect patches ──────────────────────────
// puppeteer-extra-plugin-stealth covers most leaks, but SmartCaptcha still
// fingerprints a few primitive properties. These are applied on top of the
// plugin; they only mask automation tells, they do not change site behaviour.
function buildStealthInitScript() {
  return () => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
    try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }); } catch {}
    try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => (navigator.maxTouchPoints || 0) }); } catch {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] }); } catch {}
    try {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => [1, 2] });
    } catch {}
    try { window.chrome = window.chrome || { runtime: {} }; } catch {}
    try {
      const origQuery = (window.navigator && navigator.permissions && navigator.permissions.query)
        ? navigator.permissions.query.bind(navigator.permissions) : null;
      if (origQuery) {
        navigator.permissions.query = (p) => (p && p.name === 'notifications')
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
      }
    } catch {}
    try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, p);
      };
    } catch {}
  };
}

/**
 * Apply per-session human traits: realistic viewport, matching User-Agent,
 * Moscow timezone (matches the ru locale and RU proxy IP), and the manual
 * anti-detect patches on top of the stealth plugin.
 */
async function humanizePage(page, device = 'desktop') {
  await page.setViewport(pickViewport(device));
  const pool = device === 'mobile' ? MOBILE_UAS : DESKTOP_UAS;
  await page.setUserAgent(pool[Math.floor(Math.random() * pool.length)]);
  try { await page.emulateTimezone('Europe/Moscow'); } catch {}
  try { await page.evaluateOnNewDocument(buildStealthInitScript()); } catch {}
}

// ─── Captcha Solver Integration ──────────────────────────

function redactSensitive(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('[REDACTED]');
    }
  }

  return text
    .replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/g, '$1[REDACTED]@')
    .replace(/(proxy(?:Login|Password|_login|_password)?["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[REDACTED]')
    .replace(/(["']token["']\s*:\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2');
}

function extractPythonJson(stdout) {
  const outputLines = stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const jsonLine = outputLines.reverse().find(line => line.startsWith('{') && line.endsWith('}'));
  if (!jsonLine) return null;

  try {
    return JSON.parse(jsonLine);
  } catch {
    return null;
  }
}

function runPythonProcess(pythonPath, args, {
  timeoutMs = 150000,
  redactionSecrets = [],
  logOutput = true,
} = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const proc = spawn(pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONFAULTHANDLER: '1',
      },
    });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!proc.killed) proc.kill('SIGTERM');
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    const capture = (stream, data) => {
      const text = data.toString();
      if (stream === 'stdout') stdout += text;
      else stderr += text;

      if (!logOutput) return;
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log(`  [python:${stream}] ${redactSensitive(line, redactionSecrets)}`);
      }
    };

    proc.stdout.on('data', (data) => capture('stdout', data));
    proc.stderr.on('data', (data) => capture('stderr', data));

    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr, spawnError: err });
    });
  });
}

function formatPythonFailure(result, redactionSecrets = []) {
  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') return 'Python3 not found. Install Python 3.x';
    return `Failed to start Python: ${result.spawnError.message}`;
  }

  const parsed = extractPythonJson(result.stdout);
  if (parsed && parsed.status !== 'success') {
    return redactSensitive(parsed.error || JSON.stringify(parsed), redactionSecrets);
  }

  const details = [
    result.signal && `signal: ${result.signal}`,
    result.timedOut && `timeout: true`,
    result.stderr.trim() && `stderr: ${result.stderr.trim()}`,
    result.stdout.trim() && `stdout: ${result.stdout.trim()}`,
  ].filter(Boolean).join(' | ');
  const safeDetails = redactSensitive(details || 'no output', redactionSecrets);
  const exitLabel = result.signal
    ? `Python script was killed by signal ${result.signal}`
    : `Python script exited with code ${result.code}`;
  return `${exitLabel}: ${safeDetails.substring(0, 1500)}`;
}

const SOLVER_TRANSPORT_ERRORS = /ProxyError|Unable to connect to proxy|Tunnel connection failed|Node has rejected the request|ConnectTimeout|Read timed out|ConnectionError|Max retries exceeded/i;
const SOLVER_TERMINAL_RETRY_ERRORS = /Captcha solver wall-clock timeout reached|Captcha solving timed out|ERROR_CAPTCHA_UNSOLVABLE/i;
const QUERIES_PER_PROXY_SESSION = Number(process.env.HAIBO_QUERIES_PER_PROXY_SESSION || 4);
const PROXY_ROTATION_CHECK_ATTEMPTS = Number(process.env.HAIBO_PROXY_ROTATION_CHECK_ATTEMPTS || 12);
const PROXY_ROTATION_WAIT_MS = Number(process.env.HAIBO_PROXY_ROTATION_WAIT_MS || 30000);
const PROXY_IP_CHECK_ATTEMPTS = Number(process.env.HAIBO_PROXY_IP_CHECK_ATTEMPTS || 3);
const PROXY_IP_CHECK_TIMEOUT_MS = Number(process.env.HAIBO_PROXY_IP_CHECK_TIMEOUT_MS || 20000);
const PROXY_IP_CHECK_RETRY_WAIT_MS = Number(process.env.HAIBO_PROXY_IP_CHECK_RETRY_WAIT_MS || 8000);
const PROXY_SESSION_START_MAX_MS = Number(process.env.HAIBO_PROXY_SESSION_START_MAX_MS || 180000);
const BROWSER_LAUNCH_TIMEOUT_MS = Number(process.env.HAIBO_BROWSER_LAUNCH_TIMEOUT_MS || 45000);
const PROXY_SESSION_RETRY_WAIT_MS = Number(process.env.HAIBO_PROXY_SESSION_RETRY_WAIT_MS || 300000);

async function solveCaptchaWithPython(captchaPage, proxyAuth, maxRetries = 3, imageB64 = null) {
  console.log('  🧩 Solving captcha via Python/CapMonster...');
  
  const captchaUrl = captchaPage.url();
  console.log(`  Captcha URL: ${captchaUrl}`);
  
  // The sitekey only matters for the Turnstile checkbox fallback. When we
  // have the captcha image, the solver runs ImageToTextTask and ignores it.
  let sitekey;
  if (imageB64) {
    sitekey = '';
    console.log(`  🖼️ Image captcha: ${imageB64.length} chars base64 → ImageToTextTask (no sitekey)`);
  } else {
    try {
      sitekey = await getCaptchaSiteKey(captchaPage);
    } catch (e) {
      sitekey = '0x4AAAAAAA1Y6Rq8M2BnJfIe';
    }
    console.log(`  Sitekey: ${sitekey.substring(0, 30)}...`);
  }
  
  // Build proxy args for Python script using proxyAuth directly
  let proxyArg = null;
  const redactionSecrets = [];
  if (proxyAuth && proxyAuth.host && proxyAuth.port && proxyAuth.username && proxyAuth.password) {
    proxyArg = `${proxyAuth.host}:${proxyAuth.port}:${proxyAuth.username}:${proxyAuth.password}`;
    redactionSecrets.push(proxyArg, proxyAuth.username, proxyAuth.password);
  } else if (proxyAuth && proxyAuth.username) {
    redactionSecrets.push(proxyAuth.username, proxyAuth.password);
    // Fallback: extract host/port from the captcha page URL
    const urlMatch = captchaUrl.match(/https?:\/\/([^/]+)/);
    if (urlMatch) {
      // We don't have host/port in proxyAuth, use the page's host as a hint
      console.log('  ⚠️ Proxy auth present but no host/port — using page URL for proxy connection');
    }
  }
  
  const pythonPath = '/usr/bin/python3';
  const scriptPath = path.join(__dirname, 'solve_captcha.py');
  const solverTimeoutMs = 330000;

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Captcha solver script not found: ${scriptPath}`);
  }

  const preflightArgs = ['-u', '-X', 'faulthandler', scriptPath, '--self-test', '--output', 'json'];
  if (proxyArg) {
    preflightArgs.push('--proxy', proxyArg);
  }
  const safePreflightArgs = preflightArgs.map((arg, index) => preflightArgs[index - 1] === '--proxy' ? '[REDACTED]' : arg);
  console.log(`  Preflight: ${pythonPath} ${safePreflightArgs.join(' ')}`);
  const preflight = await runPythonProcess(pythonPath, preflightArgs, {
    timeoutMs: 15000,
    redactionSecrets,
  });
  const preflightJson = extractPythonJson(preflight.stdout);
  if (preflight.code !== 0 || !preflightJson || preflightJson.status !== 'ok') {
    throw new Error(`Python solver preflight failed: ${formatPythonFailure(preflight, redactionSecrets)}`);
  }
  console.log(`  ✓ Python solver preflight ok: python ${preflightJson.python}, requests ${preflightJson.requests}, proxy_for_solving=${preflightJson.config && preflightJson.config.has_proxy_for_solving ? 'yes' : 'no'}`);
  
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`  Attempt ${attempt}/${maxRetries}...`);
    
    const args = ['-u', '-X', 'faulthandler', scriptPath, '--url', captchaUrl, '--output', 'json'];
    if (imageB64) {
      // Pass the captcha image via a temp file (never argv): the solver
      // base64-encodes it and submits it as the ImageToTextTask body.
      const imgDir = path.join(__dirname, '.captcha-screenshots');
      fs.mkdirSync(imgDir, { recursive: true });
      const imgFile = path.join(imgDir, `${Date.now()}_solver_${process.pid}_${attempt}.png`);
      fs.writeFileSync(imgFile, Buffer.from(imageB64, 'base64'));
      args.push('--captcha-image-file', imgFile);
    } else {
      args.push('--sitekey', sitekey);
    }
    if (proxyArg) {
      args.push('--proxy', proxyArg);
    }
    
    const safeArgs = args.map((arg, index) => args[index - 1] === '--proxy' ? '[REDACTED]' : arg);
    console.log(`  Running: ${pythonPath} ${safeArgs.join(' ')}`);
    
    lastError = await (async () => {
      const result = await runPythonProcess(pythonPath, args, {
        timeoutMs: solverTimeoutMs,
        redactionSecrets,
      });

      const parsed = extractPythonJson(result.stdout);
      if (parsed && parsed.status === 'success' && parsed.token) {
        console.log(`  ✓ Captcha solved on attempt ${attempt}! Token length: ${parsed.token.length}`);
        return { token: parsed.token, error: null };
      }

      if (parsed) {
        const errorMsg = redactSensitive(parsed.error || JSON.stringify(parsed), redactionSecrets);
        console.log(`  ✗ Python solver error (attempt ${attempt}): ${errorMsg}`);
        return { token: null, error: errorMsg };
      }

      if (result.code === 0 && result.stdout.trim()) {
        const outputLines = result.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
        const token = outputLines[outputLines.length - 1] || '';
        if (/^[A-Za-z0-9_.-]{50,}$/.test(token)) {
          console.log(`  ✓ Captcha solved on attempt ${attempt}! Token length: ${token.length}`);
          return { token, error: null };
        }
      }

      return { token: null, error: formatPythonFailure(result, redactionSecrets) };
    })();
    
    if (lastError.token) {
      return lastError.token;
    }
    
    lastError = lastError.error;
    console.log(`  ✗ Attempt ${attempt} failed: ${lastError}`);

    if (SOLVER_TRANSPORT_ERRORS.test(lastError)) {
      throw new Error(`Captcha solver transport/proxy error; stopping retries to avoid creating more CapMonster tasks. Last error: ${lastError}`);
    }

    if (SOLVER_TERMINAL_RETRY_ERRORS.test(lastError)) {
      throw new Error(`Captcha solver returned a terminal result; stopping retries and moving to the next query. Last error: ${lastError}`);
    }
    
    if (attempt < maxRetries) {
      const waitMs = rand(3000, 6000) * attempt;
      console.log(`  Waiting ${waitMs}ms before retry...`);
      await sleep(waitMs);
    }
  }
  
  throw new Error(`Captcha solving failed after ${maxRetries} attempts. Last error: ${lastError}`);
}

async function getCaptchaSiteKey(page) {
  return await page.evaluate(() => {
    const patterns = [
      /data-sitekey=["']([^"']+)/,
      /websiteKey["']?\s*[:=]\s*["']([^"']+)/,
      /sitekey["']?\s*[:=]\s*["']([^"']+)/,
      /"site_key"\s*:\s*"([^"']+)"/,
      /"sitekey"\s*:\s*"([^"']+)"/,
    ];
    
    // 1. Scan ALL DOM elements' outerHTML (not just innerText — this catches hidden elements)
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const html = el.outerHTML || '';
      if (html) {
        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match && match[1] && match[1].length >= 20) {
            return match[1];
          }
        }
      }
    }
    
    // 2. Scan full document HTML (includes shadow DOM, template tags, etc.)
    const fullHTML = document.documentElement.outerHTML || '';
    if (fullHTML) {
      for (const pattern of patterns) {
        const match = fullHTML.match(pattern);
        if (match && match[1] && match[1].length >= 20) {
          return match[1];
        }
      }
    }
    
    // 3. Scan ALL script tags thoroughly (including noscript, template content)
    const scripts = document.querySelectorAll('script, noscript, template');
    for (const script of scripts) {
      const text = script.textContent || script.innerHTML || '';
      if (text) {
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match && match[1] && match[1].length >= 20) {
            return match[1];
          }
        }
      }
    }
    
    // 4. Look for sitekey in form action attributes or data attributes on iframe
    const captchas = document.querySelectorAll('[class*="captcha"], [class*="recaptcha"], [class*="verify"]');
    for (const el of captchas) {
      const dataset = el.dataset || {};
      if (dataset.sitekey && dataset.sitekey.length >= 20) return dataset.sitekey;
      if (dataset.recaptchakey && dataset.recaptchakey.length >= 20) return dataset.recaptchakey;
    }
    
    // Fallback: Yandex default key
    return '0x4AAAAAAA1Y6Rq8M2BnJfIe';
  });
}

// Extract the retpath redirect target from a captcha URL (showcaptcha /
// showcaptchafast). The retpath query param is base64 of the target URL.
function getCaptchaRetpath(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const rp = u.searchParams.get('retpath');
    if (!rp) return null;
    let decoded = Buffer.from(rp, 'base64').toString('utf8');
    // retpath may itself be URL-encoded; decode once more if it looks encoded
    if (/%25|%\w\w/.test(decoded)) {
      try { decoded = decodeURIComponent(decoded); } catch (e) { /* keep as-is */ }
    }
    return decoded || null;
  } catch (e) {
    return null;
  }
}

async function applyCaptchaToken(page, token) {
  console.log('  🔑 Applying captcha token to page...');
  
  const result = await page.evaluate((tok) => {
    // SmartCaptcha answer field FIRST: Yandex CheckboxCaptcha input is the
    // real target for the OCR text. Generic token fields come after.
    const selectors = [
      '.CheckboxCaptcha-Input',
      'input.CheckboxCaptcha-Input',
      'textarea[name="g-recaptcha-response"]',
      'input[name="g-recaptcha-response"]',
      'textarea[name="h-captcha-response"]',
      'input[name="h-captcha-response"]',
      'input[name="cf-turnstile-response"]',
      'input[name="smart-token"]',
      'input[name="captcha_token"]',
      'input[name="captcha-token"]',
      'input[name="captchaResponse"]',
      'input[name="captcha-response"]',
      'input[id*="captcha" i]',
      'input[id*="recaptcha" i]',
      'input[class*="captcha" i]',
      'input[class*="response" i]',
      'input[name*="captcha" i]',
      'input[name*="response" i]',
      'input[name*="token" i]',
      'textarea[name*="captcha" i]',
      'textarea[name*="response" i]',
    ];

    const appliedFields = [];
    const seen = new Set();
    const tokenFieldPattern = /(captcha|recaptcha|hcaptcha|turnstile|smart-token|response|token)/i;

    function isWritableTokenField(el) {
      if (!el || seen.has(el)) return false;
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
      const haystack = [el.name, el.id, el.className, el.getAttribute('aria-label'), el.getAttribute('data-testid')]
        .filter(Boolean)
        .join(' ');
      return tokenFieldPattern.test(haystack);
    }

    function setFieldValue(el) {
      seen.add(el);
      const prototype = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

      if (descriptor && descriptor.set) {
        descriptor.set.call(el, tok);
      } else {
        el.value = tok;
      }

      el.setAttribute('value', tok);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      appliedFields.push(el.name || el.id || el.className || el.tagName.toLowerCase());
    }
    
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isWritableTokenField(el)) {
          setFieldValue(el);
        }
      }
    }
    
    for (const el of document.querySelectorAll('input, textarea')) {
      if (isWritableTokenField(el)) {
        setFieldValue(el);
      }
    }

    if (appliedFields.length === 0) {
      const captchaForms = document.querySelectorAll(
        'form[action*="captcha" i], form[id*="captcha" i], form[class*="captcha" i], form[action*="verify" i]'
      );
      for (const form of captchaForms) {
        const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
        for (const input of hiddenInputs) {
          const name = input.name || input.id || '';
          if (!/(csrf|xsrf|nonce|session|key)/i.test(name)) {
            setFieldValue(input);
            break;
          }
        }
        if (appliedFields.length > 0) break;
      }
    }
    
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    const actionPattern = /(проверить|отправить|продолжить|найти|submit|verify|continue|search)/i;
    const visibleButtons = buttons.filter(btn => {
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !btn.disabled;
    });
    const preferredButton = visibleButtons.find(btn => {
      const label = [btn.textContent, btn.value, btn.getAttribute('aria-label')]
        .filter(Boolean)
        .join(' ');
      return btn.type === 'submit' || actionPattern.test(label);
    });

    let clicked = false;
    if (preferredButton) {
      preferredButton.click();
      clicked = true;
    } else if (appliedFields.length > 0) {
      const field = Array.from(document.querySelectorAll('input, textarea')).find(el => el.value === tok);
      const form = field ? field.closest('form') : document.querySelector('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.submit();
        }
        clicked = true;
      }
    }

    return { appliedCount: appliedFields.length, appliedFields, clicked };
  }, token);

  console.log(`  Token fields updated: ${result.appliedCount}`);
  if (result.appliedFields.length > 0) {
    console.log(`  Fields: ${result.appliedFields.slice(0, 5).join(', ')}`);
  }
  console.log(`  Submit triggered: ${result.clicked ? 'yes' : 'no'}`);
  
  // Wait for navigation or redirect
  await sleep(rand(2000, 4000));
}

function getPrimaryProxy() {
  const proxy = proxies && proxies[0];
  if (!proxy || !proxy.host || !proxy.port) {
    throw new Error('Proxy config is incomplete. Check bot-haibo/proxies.js: host and port are required.');
  }
  return proxy;
}

async function authenticateIfNeeded(page, proxyAuth) {
  if (proxyAuth && proxyAuth.username && proxyAuth.password) {
    await page.authenticate({
      username: proxyAuth.username,
      password: proxyAuth.password,
    });
  }
}

// ─── Enhanced search with captcha solving ────────────────

// Solve the captcha: checkbox click first (clean path, no image); then the
// LOCAL pow solver (no external captcha service — CapMonster is unreliable for
// Yandex SmartCaptcha); only if the page is a REAL image challenge fall back
// to the Python solver (ImageToTextTask). showcaptchafast (passive check) is
// handled by following retpath.
async function solveCaptcha(page, proxyAuth, device = 'desktop', label = 'captcha') {
  if (await tryClickCaptchaCheckbox(page, device)) return true;

  if (page.url().includes('showcaptchafast')) {
    const retpath = getCaptchaRetpath(page.url());
    if (retpath) {
      console.log(`  ↷ showcaptchafast — following retpath instead of OCR: ${retpath.substring(0, 100)}`);
      try {
        await gotoWithRetry(page, retpath, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(rand(2000, 4000));
        if (!isCaptchaPage(page.url())) {
          console.log('  ✓ retpath redirect passed captcha wall!');
          return true;
        }
        console.log('  ✗ retpath redirect still on captcha page');
      } catch (e) {
        console.log(`  ⚠️ retpath redirect failed: ${e.message}`);
      }
    }
  }

  // Gate: only run OCR when there is a REAL image challenge. SmartCaptcha is a
  // pow/checkbox challenge (fields rdata/pdata/tdata/picasso, empty imageSrc) —
  // feeding its canvas noise to OCR yields a garbage 5-char token that Yandex
  // rejects, so it is strictly worse than just clicking the checkbox again.
  const hasImageChallenge = await page.evaluate(() => {
    // PRIMARY signal: the pow/checkbox variant ships its challenge data as
    // hidden form inputs (rdata/pdata/picasso/tdata) inside #checkbox-captcha-
    // form. If ANY of those exist in the DOM, this is a pow challenge — the
    // visible <img>/canvas is decorative noise, and OCR on it only produced
    // garbage 4-5 char tokens that Yandex rejected.
    try {
      if (document.getElementById('checkbox-captcha-form')) return false;
      const powNames = /^(rdata|pdata|picasso|tdata)$/i;
      for (const el of document.querySelectorAll('input')) {
        const n = (el.getAttribute('name') || '').trim();
        const id = (el.getAttribute('id') || '').trim();
        if (powNames.test(n) || powNames.test(id)) return false;
      }
    } catch (e) { /* fall through to secondary signals */ }
    // SECONDARY: __SSR_DATA__ is a JS object literal (NOT strict JSON) — cannot
    // be JSON.parse'd. Inspect its raw source instead: an EMPTY imageSrc ("")
    // means the checkbox/pow variant; a non-empty imageSrc means a real image
    // challenge.
    const raw = (function () {
      try {
        const s = window.__SSR_DATA__;
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object') return JSON.stringify(s);
        return '';
      } catch (e) { return ''; }
    })();
    if (raw) {
      const m = raw.match(/"?\b(?:imageSrc|taskImageSrc)"?\s*:\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,}\s]+)/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, '').trim();
        if (v && v !== '""' && v !== "''" && v !== 'null' && v !== 'undefined') return true;
      }
    }
    // LAST RESORT: a visible <img> pointing at a real captcha endpoint.
    const imgs = document.querySelectorAll('img');
    for (const el of imgs) {
      const src = el.getAttribute('src') || '';
      if (/showcaptcha|captcha|\/pic|challenge/i.test(src) && el.getBoundingClientRect().width > 0) {
        return true;
      }
    }
    return false;
  });

  if (!hasImageChallenge) {
    // Checkbox/pow challenge with no real image: solve it LOCALLY (proof-of-work
    // computed in our own browser session). CapMonster is unreliable for
    // SmartCaptcha, so the Python solver is only the last resort here.
    console.log('  ↷ Checkbox/pow captcha without image challenge (empty imageSrc) — solving pow locally (CapMonster disabled for SmartCaptcha)');
    if (await solveCaptchaLocally(page, label)) return true;
    console.log('  ↷ Local pow solver failed — last-resort attempt via Python solver...');
    const token = await solveCaptchaWithPython(page, proxyAuth, 3, null);
    if (!token) return false;
    console.log(`  🔑 Applying captcha solution to page... (token length: ${String(token).length})`);
    await applyCaptchaToken(page, token);
    await sleep(rand(2000, 4000));
    return !isCaptchaPage(page.url());
  }

  console.log('  Checkbox stage failed — solving image captcha via Python solver...');
  const imageB64 = await getCaptchaImageBase64(page);
  const token = await solveCaptchaWithPython(page, proxyAuth, 3, imageB64);
  if (!token) return false;
  console.log('  🔑 Applying captcha solution to page...');
  await applyCaptchaToken(page, token);
  await sleep(rand(2000, 4000));
  return !isCaptchaPage(page.url());
}

// Yandex search accepts spaces, underscores and hyphens in the text param;
// %20 encoding trips the strict captcha path, so encode space as '+'.
function encodeQueryText(query) {
  return encodeURIComponent(query).replace(/%20/g, '+');
}

async function trySearchViaURL(query, browser, proxyAuth, device = 'desktop') {
  const text = encodeQueryText(query);
  const urls = [
    `https://yandex.ru/search/?text=${text}&lr=213`,
    `https://yandex.ru/search/?text=${text}&auto-direct=true`,
    // yandex.ru (NOT search.yandex.ru — that host trips the captcha wall)
    `https://yandex.ru/yandsearch?text=${text}&lr=213`,
  ];
  let lastFailure = null;

  for (let i = 0; i < urls.length; i++) {
    const searchUrl = urls[i];
    console.log(`  Trying: ${searchUrl}`);
    
    // Add random delay between attempts
    if (i > 0) {
      console.log(`  Waiting ${rand(3000, 6000)}ms before retry...`);
      await sleep(rand(3000, 6000));
    }

    const page = await browser.newPage();
    await humanizePage(page, device);

    await authenticateIfNeeded(page, proxyAuth);

    // Set human-like headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    try {
      await gotoWithRetry(page, searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      const pageUrl = page.url();
      console.log(`  Result URL: ${pageUrl}`);

      if (isCaptchaPage(pageUrl)) {
        console.log('  ⚠️ CAPTCHA triggered — checkbox click first, then Python solver...');

        // Wait for captcha iframe to load
        await sleep(rand(3000, 5000));
        await saveCaptchaScreenshot(page, `solver_${safeFilePart(query)}`);
        await dumpCaptchaDom(page, `solver_${safeFilePart(query)}`);

        // Try to solve the captcha (checkbox click, then image solver)
        let solved = false;
        try {
          solved = await solveCaptcha(page, proxyAuth, device, `solver_${safeFilePart(query)}`);
        } catch (e) {
          const reason = SOLVER_TERMINAL_RETRY_ERRORS.test(e.message || String(e)) ? 'solver-terminal' : 'solver';
          lastFailure = { reason, error: e.message };
          console.log(`  ✗ Python captcha solver failed: ${e.message}`);
          await page.close();
          if (reason === 'solver-terminal') {
            return { success: false, ...lastFailure };
          }
          continue;
        }

        if (solved) {
          const newUrl = page.url();
          console.log(`  ✓ Captcha solved! Redirected to: ${newUrl}`);

          // Check for search results
          const hasResults = await page.evaluate(() => {
            return document.querySelector('.organic__href, .serp-item, [class*="organic"], [class*="result"]') !== null;
          });

          if (hasResults) {
            console.log('  ✓ Search results found after captcha!');
            return { page, success: true };
          }

          // Wait more for results to load
          await sleep(rand(4000, 7000));
          const hasResults2 = await page.evaluate(() => {
            return document.querySelector('.organic__href, .serp-item, [class*="organic"], [class*="result"]') !== null;
          });

          if (hasResults2) {
            console.log('  ✓ Search results found after waiting!');
            return { page, success: true };
          }

          // If still no results but captcha solved, keep the page and let caller handle it
          console.log('  ⚠️ Captcha solved but no results yet — keeping page for fallback handling');
          return { page, success: true };
        } else {
          lastFailure = { reason: 'captcha', error: 'Captcha solution was not accepted' };
          console.log('  ✗ Captcha solution not accepted, trying next URL...');
          await page.close();
          continue;
        }
      }

      // Check if we have search results
      const hasResults = await page.evaluate(() => {
        return document.querySelector('.organic__href, .serp-item, [class*="organic"], [class*="result"]') !== null;
      });

      if (hasResults) {
        console.log('  ✓ Search results found!');
        return { page, success: true };
      }

      // Wait a bit more for JS-rendered results
      await sleep(rand(3000, 5000));
      const hasResults2 = await page.evaluate(() => {
        return document.querySelector('.organic__href, .serp-item, [class*="organic"], [class*="result"]') !== null;
      });

      if (hasResults2) {
        console.log('  ✓ Search results found after waiting!');
        return { page, success: true };
      }

      // Check if we got redirected somewhere else
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      console.log('  Body preview:', bodyText.replace(/\n/g, ' ').substring(0, 100));
      lastFailure = { reason: 'no-results', error: 'No recognizable Yandex result items on page' };
      await page.close();

    } catch (e) {
      const reason = TRANSIENT_NET_ERRORS.test(e.message || String(e)) ? 'proxy' : 'navigation';
      lastFailure = { reason, error: e.message };
      console.log(`  Error: ${e.message}`);
      try { await page.close(); } catch {}
      if (reason === 'proxy') break;
    }
  }

  return { success: false, ...(lastFailure || { reason: 'unknown', error: 'No search URL succeeded' }) };
}

/**
 * Swipe using REAL touch events (touchStart/touchMove/touchEnd).
 */
async function touchSwipe(page, fromX, fromY, toX, toY, steps = 6) {
  try {
    await page.touchscreen.touchStart({ x: fromX, y: fromY });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await page.touchscreen.touchMove({ x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t });
      await sleep(rand(16, 48));
    }
    await page.touchscreen.touchEnd();
  } catch {}
}

/**
 * Ambient hand activity. Desktop: bezier-ish mouse moves.
 * Mobile: NO mouse events (phones have none) — occasional light swipes.
 */
async function humanActivity(page, device = 'desktop') {
  if (device === 'mobile') {
    if (Math.random() < 0.5) {
      const vp = page.viewport();
      const w = (vp && vp.width) || 390;
      const h = (vp && vp.height) || 844;
      const x = rand(w * 0.25, w * 0.75);
      await touchSwipe(page, x, rand(h * 0.45, h * 0.6), x + rand(-40, 40), rand(h * 0.5, h * 0.75), rand(5, 9));
      await sleep(rand(300, 900));
    }
    return;
  }
  await humanMouse(page);
}

async function humanMouse(page) {
  for (let i = 0; i < rand(4, 7); i++) {
    await page.mouse.move(rand(50, 1200), rand(80, 700), { steps: rand(8, 20) });
    await sleep(rand(200, 800));
  }
}

async function scrollToBottom(page, device = 'desktop') {
  if (device === 'mobile') {
    // Inertial touch swipes: fast flick, decelerating tail
    for (let i = 0; i < rand(3, 6); i++) {
      const vp = page.viewport();
      const w = (vp && vp.width) || 390;
      const startX = rand(w * 0.3, w * 0.7);
      await touchSwipe(page, startX, rand(550, 700), startX + rand(-30, 30), rand(380, 480), rand(4, 7));
      await sleep(rand(300, 700));
      const atBottom = await page.evaluate(
        () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 60
      ).catch(() => true);
      if (atBottom) break;
    }
    return;
  }
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let last = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 200 + Math.random() * 200);
        const h = document.body.scrollHeight;
        if (h === last) { clearInterval(timer); resolve(); }
        last = h;
      }, 400);
    });
  });
}

const TRANSIENT_NET_ERRORS = /ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_(RESET|CLOSED|TIMED_OUT)|ERR_NETWORK_CHANGED|ERR_PROXY_CONNECTION_FAILED|TimeoutError|Navigation timeout|Navigation failed because browser has disconnected/i;

function formatSearchFailure(result) {
  if (!result) return 'Search attempts failed: no result details.';
  if (result.reason === 'proxy') {
    return `Search attempts failed due to proxy/network tunnel error: ${result.error}`;
  }
  if (result.reason === 'solver') {
    return `All search attempts reached CAPTCHA and the Python solver failed: ${result.error}`;
  }
  if (result.reason === 'solver-timeout') {
    return `Captcha solver timed out while CapMonster was still processing: ${result.error}`;
  }
  if (result.reason === 'solver-terminal') {
    return `Captcha solver stopped after a terminal CapMonster result: ${result.error}`;
  }
  if (result.reason === 'captcha') {
    return `All search attempts failed due to CAPTCHA: ${result.error}`;
  }
  if (result.reason === 'no-results') {
    return `Search attempts opened pages, but no results were detected: ${result.error}`;
  }
  return `Search attempts failed: ${result.error || 'unknown error'}`;
}

/**
 * Navigate with retries for transient mobile-proxy tunnel drops
 * (geonix returns CONNECT 503 while rotating exit IPs).
 */
async function gotoWithRetry(page, url, options = {}, attempts = 3) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await page.goto(url, options);
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      if (!TRANSIENT_NET_ERRORS.test(msg)) throw e;
      const action = i < attempts ? 'retrying navigation...' : 'giving up on this navigation.';
      console.log(`  Nav attempt ${i}/${attempts} failed (${msg.split('\n')[0].substring(0, 90)}), ${action}`);
      if (i < attempts) await sleep(rand(6000, 12000));
    }
  }
  if (lastErr) lastErr.transientNetworkFailure = true;
  throw lastErr;
}

function isCaptchaPage(pageUrl) {
  return pageUrl.includes('showcaptcha') || pageUrl.includes('verify') || pageUrl.includes('robot');
}

/**
 * Try to pass SmartCaptcha by clicking its checkbox like a human.
 * Works when Yandex serves the checkbox stage (no image challenge).
 * Returns true if the page left the captcha URL within ~20s.
 */
async function tryClickCaptchaCheckbox(page, device = 'desktop') {
  try {
    const btn = await page.$('#js-button.CheckboxCaptcha-Button');
    if (!btn) {
      console.log('  Checkbox button not found on captcha page');
      return false;
    }

    // The widget's own listener is attached to 'click' on #js-button (confirmed
    // from the live page: it sets window.__JS_BUTTON_CLICKED__ and flips
    // type->submit). A synthetic el.click() fires click WITHOUT isTrusted;
    // page.mouse.click / touchscreen.tap produce trusted input events, which is
    // what the widget and Yandex's bot-detection expect. Human-like: bring into
    // view and focus first, then tap (mobile) or hover+click (desktop).
    await btn.evaluate(elem => elem.scrollIntoView({ block: 'center' })).catch(() => {});
    await sleep(rand(300, 700));
    try { await page.bringToFront(); } catch (e) { console.log(`  bringToFront failed: ${e.message}`); }
    const box = await btn.boundingBox();
    if (device === 'mobile' && box) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: rand(8, 16) });
      await sleep(rand(300, 800));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: rand(60, 140) });
    } else {
      await btn.evaluate(elem => elem.click()).catch(() => {});
    }
    // Confirmed from the live captcha_smart.*.js source in the DOM dump: the
    // button's own click listener ONLY sets window.__JS_BUTTON_CLICKED__ and
    // removes itself — it does NOT submit the form. The flag is an audit
    // signal; the real answer is tdata, which we compute in solveCaptchaLocally.
    const flagged = await page.evaluate(() => !!window.__JS_BUTTON_CLICKED__).catch(() => false);
    console.log(`  Checkbox click: flag __JS_BUTTON_CLICKED__=${flagged} (widget click handler does not submit — pow solver follows)`);

    // Poll for redirect away from the captcha page
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      if (!isCaptchaPage(page.url())) {
        console.log('  ✓ Checkbox passed! Redirected to:', page.url().substring(0, 100));
        return true;
      }
    }

    console.log('  ✗ Checkbox click did not pass (image challenge may have appeared)');
    return false;
  } catch (e) {
    console.log(`  Checkbox click error: ${e.message}`);
    return false;
  }
}

/**
 * Solve Yandex SmartCaptcha pow/checkbox challenge LOCALLY (no external
 * captcha service). Confirmed protocol (decoded from the live captcha DOM):
 *   - hidden form fields: rdata, pdata, tdata (EMPTY on checkbox variant),
 *     picasso — all base64 JSON.
 *   - pdata = {powNonce, powCalcTime, powPrefix}; powPrefix is hex and decodes
 *     to "t=<ts>;p=<uuid>;c=<diff>;d=<hex>;" — the hash-chain prefix.
 *   - rdata = ~100 JSON chunks "<base64>;<idx>" (keys a1..z5 + pgrd/v): the
 *     per-chunk expected hashes the real widget's own JS verifies.
 *   - picasso = canvas challenge tasks [{seed, rounds, width, height,
 *     fontSizeFactor, maxShadowBlur, result, calcTime}].
 * Strategy (in this order, inside OUR browser session over the proxy):
 *   A. foreground the tab (page.bringToFront() — background-tab throttling is
 *      what made the old click path silently fail), click the checkbox, and
 *      let the page's OWN script compute the answer;
 *   B. local protocol solver: recompute picasso hashes in-page, mine the pow
 *      nonce, write tdata, submit the real form to formAction.
 */
async function solveCaptchaLocally(page, label = 'captcha') {
  // The pow fields (rdata/pdata/tdata/picasso) are NOT top-level keys of
  // __SSR_DATA__ — confirmed from the live captcha DOM: they live in the
  // hidden <input> elements of #checkbox-captcha-form, and __SSR_DATA__ only
  // carries formAction/powPrefix/powComplexity. Read the real sources: SSR for
  // formAction/powPrefix/powComplexity, the DOM inputs for the data fields.
  let ctx = null;
  try {
    ctx = await page.evaluate(() => {
      const s = window.__SSR_DATA__;
      const so = (s && typeof s === 'object') ? s : {};
      const inputVal = (n) => {
        const el = document.querySelector(`#js-${n}, input[name="${n}"], textarea[name="${n}"]`);
        return el ? el.value : '';
      };
      return {
        ssrKeys: Object.keys(so),
        formAction: typeof so.formAction === 'string' ? so.formAction : '',
        powPrefix: typeof so.powPrefix === 'string' ? so.powPrefix : '',
        powComplexity: typeof so.powComplexity === 'string' ? so.powComplexity : '',
        rdata: inputVal('rdata'), pdata: inputVal('pdata'),
        tdata: inputVal('tdata'), picasso: inputVal('picasso'),
      };
    });
  } catch (e) {
    console.log(`  Local solver: cannot read captcha page state: ${e.message}`);
    return false;
  }
  if (!ctx) return false;
  if (!ctx.pdata || !ctx.formAction) {
    console.log('  Local solver: no pdata/formAction on captcha page — nothing to solve');
    return false;
  }
  console.log(`  Local pow solver: SSR keys=[${ctx.ssrKeys.join(', ')}]`);
  console.log(`  Local pow solver: pdata=${String(ctx.pdata).length}ch rdata=${String(ctx.rdata || '').length}ch picasso=${String(ctx.picasso || '').length}ch tdata=${String(ctx.tdata || '').length}ch formAction=${String(ctx.formAction).substring(0, 80)}`);

  // Step A: foreground the tab (defeats background-tab throttling of the
  // captcha's own rAF-based pow loop), click the checkbox with TRUSTED input
  // events (synthetic el.click() is untrusted and the widget ignores it), and
  // wait for the widget to solve and redirect on its own.
  try { await page.bringToFront(); } catch (e) { console.log(`  bringToFront failed: ${e.message}`); }
  let clicked = false;
  try {
    const btn = await page.$('#js-button.CheckboxCaptcha-Button') || await page.$('.CheckboxCaptcha-Button');
    if (btn) {
      const bb = await btn.boundingBox().catch(() => null);
      if (bb) {
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: rand(8, 16) });
        await sleep(rand(200, 500));
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { delay: rand(60, 140) });
        clicked = true;
      } else {
        await btn.evaluate((el) => el.click()).catch(() => {});
        clicked = true;
      }
    }
  } catch (e) { console.log(`  Local solver step A click error: ${e.message}`); }
  const flagged = await page.evaluate(() => !!window.__JS_BUTTON_CLICKED__).catch(() => false);
  console.log(`  Local solver step A: checkbox clicked=${clicked} flag=${flagged} (page-side pow runs on its own)`);

  if (clicked) {
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (!isCaptchaPage(page.url())) {
        console.log('  ✓ Local pow solve passed (page-side solver)! Redirected to:', page.url().substring(0, 100));
        return true;
      }
    }
    console.log('  Local solver step A: page-side solver did not redirect in 12s — computing tdata locally...');
  }

  // Step B: compute the answers with the verbatim-port solver (captcha_solver.js:
  // SHA-256 PoW + LCG-Lehmer + MurmurHash3 x64-128 from the live bundle) — mine
  // the pow nonce in Node, re-render the picasso canvas in-page — write tdata,
  // submit the real form (rdata/pdata/picasso/tdata) to formAction.
  const solver = require('./captcha_solver.js');
  let solved;
  try {
    // ---- pdata: powPrefix (hex) + complexity from the page context.
    const pj = JSON.parse(Buffer.from(String(ctx.pdata).replace(/\s/g, ''), 'base64').toString('utf8'));
    const prefixHex = pj.powPrefix ? String(pj.powPrefix) : '';
    const calcTime = Number(pj.powCalcTime) || 0;
    const cm = /c=(\d+)/.exec(prefixHex);
    const diff = cm ? Number(cm[1]) : (Number(ctx.powComplexity) || 0);

    // ---- pow: mine a 16-byte nonce (BE Date.now() + random) such that
    // SHA-256(decodedPrefixBytes || nonce) passes checkComplexity(diff).
    let answer = null;
    if (diff > 0 && prefixHex) {
      const t0 = Date.now();
      answer = await solver.solvePow(Buffer.from(prefixHex, 'hex'), diff);
      console.log(`  pow nonce mined in ${Date.now() - t0}ms (diff=${diff})`);
    }
    if (answer == null) { solved = { ok: false, error: 'pow nonce not mined (no prefix/complexity)' }; }
    else {
      // ---- picasso: re-render each canvas task in-page with the ported
      // LCG-Lehmer + MurmurHash3 x64-128 chain and check our result against
      // the server-provided task.result.
      const tasks = (() => { try { const v = JSON.parse(Buffer.from(String(ctx.picasso).replace(/\s/g, ''), 'base64').toString('utf8')); return Array.isArray(v) ? v : [v]; } catch (e) { return []; } })();
      let chunkCount = 0;
      try { chunkCount = Object.keys(JSON.parse(Buffer.from(String(ctx.rdata).replace(/\s/g, ''), 'base64').toString('utf8'))).length; } catch (e) { /* ignore */ }
      const solverSrc = require('fs').readFileSync(require('path').join(__dirname, 'captcha_solver.js'), 'utf8');
      const inPageSolver = '(function(){' + solverSrc.replace(/^'use strict';\s*/m, '').replace(/module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/m, '') + ';return {Lcg:typeof Lcg!=="undefined"?Lcg:null,murmur128x64:typeof murmur128x64!=="undefined"?murmur128x64:null,solvePicassoTask:typeof solvePicassoTask!=="undefined"?solvePicassoTask:null};})()';
      let picassoOk = 0;
      for (const t of tasks) {
        if (!t || t.seed === undefined) continue;
        try {
          const res = await page.evaluate((src, task) => {
            const m = eval(src);
            const canvas = document.createElement('canvas');
            canvas.width = task.width; canvas.height = task.height;
            // The reference bundle (o9) appends the canvas to documentElement
            // before toDataURL() — keep the environment byte-identical.
            document.documentElement.appendChild(canvas);
            let out;
            try { out = m.solvePicassoTask(task, canvas); } finally { canvas.remove(); }
            return { result: out.result, expected: task.result, match: out.result === task.result };
          }, inPageSolver, t).catch((e) => ({ error: String((e && e.message) || e) }));
          if (res && res.match) picassoOk++;
          console.log(`  picasso seed=${t.seed} rounds=${t.rounds} portMatch=${res && res.match} got=${res && res.result ? String(res.result).slice(0, 16) + '…' : 'err:' + (res && res.error)}`);
        } catch (e) { console.log(`  picasso task error: ${e.message}`); }
      }

      const tdataVal = solver.buildTdata(answer, calcTime, prefixHex);
      const form = await page.evaluate((b64) => {
        const el = document.querySelector('#js-tdata, input[name="tdata"], textarea[name="tdata"]');
        const form = document.getElementById('checkbox-captcha-form') ||
          document.querySelector('form[action*="checkcaptcha" i]') || document.querySelector('form');
        if (!form) return { ok: false, error: 'captcha form not found' };
        function setVal(el, v) {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const inputs = Array.from(form.querySelectorAll('input, textarea'));
        const filled = [];
        const tdataEl = inputs.find((e) => /tdata/i.test((e.name || '') + ' ' + (e.id || '')));
        if (tdataEl) { setVal(tdataEl, b64); filled.push(tdataEl.name || 'tdata'); }
        else {
          const cand = inputs.find((e) => e.type === 'hidden' && !/(rdata|pdata|picasso|csrf|xsrf|action)/i.test(e.name || e.id || ''));
          if (cand) { setVal(cand, b64); filled.push(cand.name || cand.id || 'hidden'); }
        }
        return { ok: true, filled: filled.join(',') };
      }, tdataVal);
      solved = form.ok
        ? { ok: true, answer, diff, filled: form.filled, chunkCount, picassoOk, picassoTotal: tasks.length }
        : { ok: false, error: form.error };
    }
  } catch (e) {
    solved = { ok: false, error: String((e && e.message) || e) };
  }

  if (!solved.ok) {
    console.log(`  ✗ Local pow solver failed: ${solved.error}`);
    return false;
  }
  console.log(`  ✓ pow nonce found: ${solved.answer} (diff=${solved.diff}, rdata chunks=${solved.chunkCount}, fields: ${solved.filled}) — submitting form...`);

  const submitted = await page.evaluate(() => {
    const form = document.querySelector('#js-form.checkbox-captcha-form') ||
      document.querySelector('form.checkbox-captcha-form') ||
      document.querySelector('form[action*="checkcaptcha" i]') ||
      document.querySelector('form');
    if (!form) return false;
    const btn = Array.from(form.querySelectorAll('button, input[type="submit"]'))
      .find((b) => b.type === 'submit' || /проверить|провер|submit|continue|отправ/i.test(b.textContent || b.value || ''));
    if (btn) { btn.click(); return true; }
    if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
    return true;
  });
  console.log(`  Submit triggered: ${submitted ? 'yes' : 'no'}`);

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (!isCaptchaPage(page.url())) {
      console.log('  ✓ Local pow solve passed! Redirected to:', page.url().substring(0, 100));
      return true;
    }
  }
  console.log('  ✗ Local pow solve submitted but page stayed on captcha');
  return false;
}

// ─── Projects registry ───────────────────────────────────
// To add a new project, just append an entry to projects.json — no code
// changes needed:
//
//   "my-project": {
//     "targetDomain": "example.ru",
//     "queries": ["запрос 1", "запрос 2"]
//   }
//
// Run:  node yandex_search_visit.js --project my-project
const PROJECTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8')
);

/**
 * Parse CLI and resolve the active project.
 *   --project <name> / -p <name>   pick a project from projects.json
 *                                  (defaults to the first entry)
 *   remaining args                  ad-hoc query overrides
 */
function resolveCli() {
  const argv = process.argv.slice(2);
  let projectName = null;
  const queries = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' || argv[i] === '-p') {
      projectName = argv[i + 1] || null;
      i++;
    } else {
      queries.push(argv[i]);
    }
  }

  if (!projectName) projectName = Object.keys(PROJECTS)[0];
  const project = PROJECTS[projectName];

  if (!project || !project.targetDomain) {
    console.error(`Unknown project "${projectName}". Available: ${Object.keys(PROJECTS).join(', ')}`);
    process.exit(1);
  }

  return {
    projectName,
    targetDomain: project.targetDomain,
    // Device fingerprint mode: 'mobile' (default — matches mobile-operator
    // proxies like geonix) or 'desktop' (for ISP/office proxies).
    device: project.device === 'desktop' ? 'desktop' : 'mobile',
    queries: queries.length ? queries : (project.queries || [])
  };
}

async function runSearchAndVisit(browser, proxyAuth, searchQuery, targetDomain, device = 'desktop') {
  let mainPage = null;
  let resultPage = null;

  // Read the warm-up captcha signal for THIS query, then reset it so it never
  // leaks into the next query on the same browser session.
  const warmedIntoCaptcha = runSearchAndVisit._warmHitCaptcha === true;
  runSearchAndVisit._warmHitCaptcha = false;

  try {
    // Open ya.ru first (human behavior)
    console.log('--- Opening ya.ru ---');
    mainPage = await browser.newPage();
    await humanizePage(mainPage, device);
    await authenticateIfNeeded(mainPage, proxyAuth);

    // If the warm-up already hit a captcha on this IP, the exit IP is dirty —
    // go straight to the direct SERP URL instead of wasting attempts on the
    // ya.ru homepage (which itself can be a captcha wall).

    if (!warmedIntoCaptcha) {
      console.log('--- Opening ya.ru ---');
      await gotoWithRetry(mainPage, 'https://ya.ru/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await sleep(rand(3000, 5000));
      await humanActivity(mainPage, device);

      // Try to find and use the search input on ya.ru
      console.log('--- Using ya.ru search ---');
      const searchFound = await searchViaForm(mainPage, searchQuery, device);

      if (!searchFound) {
        console.log('  Search form could not complete the query; using direct search URL...');
        // Direct Yandex search URL — the most reliable method
        const directUrl = `https://yandex.ru/search/?text=${encodeQueryText(searchQuery)}&lr=213`;
        await gotoWithRetry(mainPage, directUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
    } else {
      console.log('  Warm-up hit captcha — going straight to direct SERP URL...');
      const directUrl = `https://yandex.ru/search/?text=${encodeQueryText(searchQuery)}&lr=213`;
      await gotoWithRetry(mainPage, directUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    await sleep(rand(4000, 7000));

    let activePage = mainPage;
    const currentPageUrl = mainPage.url();

    if (isCaptchaPage(currentPageUrl)) {
      console.log('CAPTCHA detected! Trying checkbox click first...');
      await saveCaptchaScreenshot(mainPage, `${targetDomain}_initial`);
      if (await solveCaptcha(mainPage, proxyAuth, device, `${targetDomain}_initial`)) {
        activePage = mainPage;
      } else {
        console.log('Falling back to direct search URLs + solver...');
        await mainPage.close().catch(() => {});
        mainPage = null;

        const result = await trySearchViaURL(searchQuery, browser, proxyAuth, device);
        if (!result.success) {
          console.log(formatSearchFailure(result));
          return failedVisit(result.reason || 'search-failed');
        }
        resultPage = result.page;
        activePage = resultPage;
      }
    } else {
      console.log('Current URL:', currentPageUrl);
      await sleep(rand(3000, 5000));
      await humanActivity(mainPage, device);

      // Check if captcha appeared after navigation
      const newUrl = mainPage.url();
      if (isCaptchaPage(newUrl)) {
        console.log('CAPTCHA detected after search! Trying checkbox click first...');
        await saveCaptchaScreenshot(mainPage, `${targetDomain}_after_search`);
        if (await solveCaptcha(mainPage, proxyAuth, device, `${targetDomain}_after_search`)) {
          activePage = mainPage;
        } else {
          console.log('Falling back to direct URLs + solver...');
          await mainPage.close().catch(() => {});
          mainPage = null;

          const result = await trySearchViaURL(searchQuery, browser, proxyAuth, device);
          if (!result.success) {
            console.log(formatSearchFailure(result));
            return failedVisit(result.reason || 'search-failed');
          }
          resultPage = result.page;
          activePage = resultPage;
        }
      } else {
        await sleep(rand(2000, 4000));
        await scrollToBottom(mainPage, device);
        await sleep(rand(1000, 2000));

        // If we didn't get results, try direct search as fallback
        const hasResults = await mainPage.evaluate(() => {
          return document.querySelector('.organic__href, .serp-item, [class*="organic"], [class*="result"]') !== null;
        });

        if (!hasResults) {
          console.log('No results on current page, trying direct search...');
          const directUrl = `https://yandex.ru/search/?text=${encodeQueryText(searchQuery)}&lr=213`;
          await gotoWithRetry(mainPage, directUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
          });
          await sleep(rand(4000, 7000));

          const checkUrl = mainPage.url();
          if (isCaptchaPage(checkUrl)) {
            console.log('CAPTCHA detected! Trying checkbox click first...');
            await saveCaptchaScreenshot(mainPage, `${targetDomain}_direct_search`);
            if (await solveCaptcha(mainPage, proxyAuth, device, `${targetDomain}_direct_search`)) {
              activePage = mainPage;
            } else {
              console.log('Falling back to alternative URLs + solver...');
              const result = await trySearchViaURL(searchQuery, browser, proxyAuth, device);
              if (!result.success) {
                console.log(formatSearchFailure(result));
                return failedVisit(result.reason || 'search-failed');
              }
              resultPage = result.page;
              activePage = resultPage;
            }
          } else {
            await scrollToBottom(mainPage, device);
            await sleep(rand(1000, 2000));
          }
        }
      }
    }

    // Scan result pages 1..MAX_PAGES until the target domain is found.
    // Human-like: pause + scroll between pages, captcha check on each page.
    const MAX_PAGES = 7;
    let visitResult = null;

    for (let pageNum = 1; pageNum <= MAX_PAGES && !visitResult; pageNum++) {
      if (pageNum > 1) {
        console.log(`\n--- Checking page ${pageNum} of results ---`);
        const base = activePage.url();
        const urlWithPage = /[?&]page=\d+/.test(base)
          ? base.replace(/([?&])page=\d+/, `$1page=${pageNum}`)
          : `${base}${base.includes('?') ? '&' : '?'}page=${pageNum}`;

        await gotoWithRetry(activePage, urlWithPage, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(rand(2500, 5000));

        if (isCaptchaPage(activePage.url())) {
          console.log(`CAPTCHA on page ${pageNum}, trying checkbox click then image solver...`);
          if (!(await solveCaptcha(activePage, proxyAuth, device, `page_${pageNum}`))) break;

          // Captcha redirect may drop the &page=N param — restore it so we
          // don't accidentally rescan page 1
          if (pageNum > 1 && !/[?&]page=\d+/.test(activePage.url())) {
            const base = activePage.url();
            const sep = base.includes('?') ? '&' : '?';
            await gotoWithRetry(activePage, `${base}${sep}page=${pageNum}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await sleep(rand(2000, 4000));
          }
        }

        await scrollToBottom(activePage, device);
        await sleep(rand(1000, 2000));
      }

      visitResult = await findAndVisitTarget(activePage, targetDomain, device);
    }

    if (!visitResult) {
      // No target link found in the scanned pages; record a direct fallback.
      console.log(`\n--- Target not found in top ${MAX_PAGES} pages, navigating directly ---`);

      // Mobile proxy tunnels occasionally drop CONNECT — retry once
      let navOk = false;
      for (let att = 1; att <= 2 && !navOk; att++) {
        try {
          await gotoWithRetry(activePage, `https://${targetDomain}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }, 2);
          navOk = true;
        } catch (e) {
          console.log(`  Direct nav attempt ${att}/2 failed: ${e.message}`);
          if (att < 2) await sleep(8000);
        }
      }
      await sleep(rand(2000, 4000));

      const finalUrl = activePage.url();
      console.log('');
      console.log('=== RESULT ===');
      console.log('Final URL:', finalUrl);
      visitResult = navOk
        ? await arrivalResult(activePage, targetDomain, 'direct', 'target-not-found-in-scanned-results')
        : failedVisit('direct-navigation-failed');
      console.log('Target domain reached:', visitResult.ok ? 'YES' : 'NO');
      console.log('Visit source:', visitResult.ok ? visitResult.source : 'FAIL', '|', visitResult.reason);
      if (!visitResult.ok) return visitResult;

      await activePage.screenshot({ path: `./${targetDomain}_from_yandex.png`, fullPage: true }).catch(() => {});
      console.log(`Screenshot saved: ${targetDomain}_from_yandex.png`);

      await visitSite(activePage, targetDomain, device).catch(() => {
        console.log('  Target reached; subsequent site browsing failed.');
      });
    }
    return visitResult;

  } finally {
    if (resultPage) { try { await resultPage.close(); } catch {} }
    if (mainPage) { try { await mainPage.close(); } catch {} }
  }
}

/**
 * First-run warm-up: populate the persistent profile with cookies/history
 * by visiting neutral Yandex pages, so later runs look like a RETURNING
 * user instead of a fresh incognito browser.
 */
/**
 * IDN-aware domain list: original (Unicode) form + punycode serialization,
 * since browsers serialize hrefs/URLs of Cyrillic domains to punycode.
 */
function buildDomains(targetDomain) {
  const list = [targetDomain];
  try {
    const ascii = new URL(`https://${targetDomain}`).hostname;
    if (!list.includes(ascii)) list.push(ascii);
  } catch {}
  return list;
}

async function collectInternalLinkCandidates(page, domainsToMatch, visited) {
  return await page.evaluate((domainList, excludeList) => {
    const exclude = new Set(excludeList);
    const seen = new Set();
    const fileRe = /\.(png|jpe?g|gif|svg|webp|pdf|zip|rar|docx?|xlsx?|mp4|mp3)(\?|$)/i;

    function normalize(raw) {
      try {
        const url = new URL(raw, window.location.href);
        if (!/^https?:$/.test(url.protocol)) return null;
        url.hash = '';
        return url.href;
      } catch {
        return null;
      }
    }

    function sameTargetDomain(href) {
      try {
        const host = new URL(href).hostname;
        return domainList.some(dm => host === dm || host.endsWith(`.${dm}`));
      } catch {
        return false;
      }
    }

    function add(raw, source) {
      const href = normalize(raw);
      const hrefUrl = href ? new URL(href) : null;
      const currentUrl = new URL(window.location.href);
      if (
        !href ||
        (
          hrefUrl &&
          hrefUrl.hostname === currentUrl.hostname &&
          hrefUrl.pathname.replace(/\/+$/, '') === currentUrl.pathname.replace(/\/+$/, '')
        ) ||
        seen.has(href) ||
        exclude.has(href) ||
        !sameTargetDomain(href) ||
        fileRe.test(href)
      ) {
        return null;
      }
      seen.add(href);
      return { href, source };
    }

    const candidates = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const candidate = add(a.getAttribute('href'), 'dom-link');
      if (candidate) candidates.push(candidate);
    }

    return candidates.slice(0, 20);
  }, domainsToMatch, Array.from(visited)).catch(() => []);
}

async function tryOpenMobileMenu(page, device = 'desktop') {
  const opened = await page.evaluate(() => {
    const pattern = /(menu|burger|hamburger|nav|меню|каталог)/i;
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [aria-controls], [aria-expanded]'));

    for (const el of controls) {
      const text = [
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('class'),
        el.getAttribute('id'),
        el.getAttribute('data-testid')
      ].filter(Boolean).join(' ');

      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (visible && pattern.test(text)) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
    }

    return false;
  }).catch(() => false);

  if (opened) {
    console.log('  Opened possible mobile menu, recollecting internal links...');
    await sleep(device === 'mobile' ? rand(900, 1600) : rand(500, 1000));
  }

  return opened;
}

async function collectInternalFallbackUrls(page, domainsToMatch, visited) {
  return await page.evaluate(async (domainList, excludeList) => {
    const exclude = new Set(excludeList);
    const seen = new Set();
    const fileRe = /\.(png|jpe?g|gif|svg|webp|pdf|zip|rar|docx?|xlsx?|mp4|mp3)(\?|$)/i;

    function normalize(raw) {
      try {
        const url = new URL(raw, window.location.href);
        if (!/^https?:$/.test(url.protocol)) return null;
        url.hash = '';
        return url.href;
      } catch {
        return null;
      }
    }

    function sameTargetDomain(href) {
      try {
        const host = new URL(href).hostname;
        return domainList.some(dm => host === dm || host.endsWith(`.${dm}`));
      } catch {
        return false;
      }
    }

    function add(raw, source, output) {
      const href = normalize(raw);
      const hrefUrl = href ? new URL(href) : null;
      const currentUrl = new URL(window.location.href);
      if (
        !href ||
        (
          hrefUrl &&
          hrefUrl.hostname === currentUrl.hostname &&
          hrefUrl.pathname.replace(/\/+$/, '') === currentUrl.pathname.replace(/\/+$/, '')
        ) ||
        seen.has(href) ||
        exclude.has(href) ||
        !sameTargetDomain(href) ||
        fileRe.test(href)
      ) {
        return;
      }
      seen.add(href);
      output.push({ href, source });
    }

    const output = [];

    async function getJson(resourcePath) {
      try {
        const response = await fetch(resourcePath, { credentials: 'same-origin' });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }

    const pages = await getJson('/wp-json/wp/v2/pages?per_page=20&_fields=link,status');
    if (Array.isArray(pages)) {
      for (const item of pages) {
        if (!item.status || item.status === 'publish') add(item.link, 'wp-pages', output);
      }
    }

    const posts = await getJson('/wp-json/wp/v2/posts?per_page=20&_fields=link,status');
    if (Array.isArray(posts)) {
      for (const item of posts) {
        if (!item.status || item.status === 'publish') add(item.link, 'wp-posts', output);
      }
    }

    if (output.length) return output.slice(0, 20);

    async function getText(resourcePath) {
      try {
        const response = await fetch(resourcePath, { credentials: 'same-origin' });
        if (!response.ok) return '';
        return await response.text();
      } catch {
        return '';
      }
    }

    for (const resourcePath of ['/wp-sitemap.xml', '/sitemap.xml']) {
      const text = await getText(resourcePath);
      for (const match of text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
        add(match[1], 'sitemap', output);
      }
      if (output.length) break;
    }

    return output.slice(0, 20);
  }, domainsToMatch, Array.from(visited)).catch(() => []);
}

// ─── Profile warm-up (trust building) ─────────────────────
//
// A "quality" profile is built by accumulating REAL browsing behaviour across
// many sessions on the SAME exit IP, not by a single first-run visit. The old
// warm-up hit ya.ru once and set a permanent .warmed marker, so the profile
// only ever held 2-3 cookies. We now browse several neutral domains with real
// behaviour (scroll, idle reads, organic clicks with dwell time), record every
// warm session in warm-history.json, and re-warm on every proxy session
// (gated by HAIBO_WARM_SESSION, default on). A forced deep warm is available
// via HAIBO_FORCE_WARM=1.

const WARM_NEUTRAL_SITES = [
  'https://ya.ru/',
  'https://yandex.ru/pogoda/',
  'https://yandex.ru/pogoda/msk',
  'https://yandex.ru/news',
  'https://auto.ru/cars/new/',
  'https://www.kinopoisk.ru/lists/pick/',
  'https://ru.wikipedia.org/wiki/Автомобиль',
  'https://yandex.ru/maps/',
];

function warmHistoryPath(profileDir) {
  return path.join(profileDir, 'warm-history.json');
}

function readWarmHistory(profileDir) {
  try {
    const data = JSON.parse(fs.readFileSync(warmHistoryPath(profileDir), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function appendWarmHistory(profileDir, entry) {
  const history = readWarmHistory(profileDir);
  history.push(entry);
  try {
    fs.writeFileSync(warmHistoryPath(profileDir), JSON.stringify(history, null, 2));
  } catch (e) {
    console.log(`  ⚠️ Failed to persist warm history: ${e.message}`);
  }
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Open one neutral page and behave like a real returning user: scroll with
 * pauses, idle reads, click a visible organic link and dwell on it.
 */
async function warmVisitPage(browser, proxyAuth, url, device, index, total) {
  const page = await browser.newPage();
  await humanizePage(page, device);
  await authenticateIfNeeded(page, proxyAuth);
  let hitCaptcha = false;
  warmVisitPage._lastHitCaptcha = false;
  try {
    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`  [warm ${index}/${total}] ${url}`);
    await sleep(rand(2500, 5000));
    if (isCaptchaPage(page.url())) {
      hitCaptcha = true;
      warmVisitPage._lastHitCaptcha = true;
      console.log(`  [warm ${index}/${total}] captcha wall at ${page.url().substring(0, 80)} — exit IP is dirty`);
    }
    await humanActivity(page, device);
    await scrollToBottom(page, device);
    await sleep(rand(1500, 3500));

    const link = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('a[href^="http"]'));
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top > 80 && r.top < window.innerHeight) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: el.href };
        }
      }
      return null;
    }).catch(() => null);

    if (link) {
      console.log(`  [warm ${index}/${total}] click → ${link.href.substring(0, 80)}`);
      if (device === 'mobile') {
        await page.touchscreen.tap(link.x, link.y).catch(() => {});
      } else {
        await page.mouse.move(link.x, link.y, { steps: rand(8, 16) }).catch(() => {});
        await sleep(rand(120, 360));
        await page.mouse.click(link.x, link.y, { delay: rand(60, 140) }).catch(() => {});
      }
      await sleep(rand(3000, 7000));
      await humanActivity(page, device);
      await scrollToBottom(page, device).catch(() => {});
      await sleep(rand(1500, 3000));
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(rand(1200, 2500));
    }
    return true;
  } catch (e) {
    console.log(`  [warm ${index}/${total}] skipped ${url}: ${e.message}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

function warmEnabled() {
  const v = process.env.HAIBO_WARM_SESSION;
  return v === undefined ? true : /^(1|true|yes|on)$/i.test(String(v));
}

function warmSiteCount() {
  const n = Number(process.env.HAIBO_WARM_SITES || 4);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

/**
 * Warm-up now runs per proxy session (not once forever). It browses a shuffled
 * subset of neutral domains with human behaviour and records the session in
 * warm-history.json so trust accumulates across runs.
 */
async function warmUpProfile(browser, proxyAuth, device, profileDir, sessionNumber) {
  if (!warmEnabled()) {
    console.log('--- Profile warm-up skipped (HAIBO_WARM_SESSION=0) ---');
    return;
  }
  const force = /^(1|true|yes|on)$/i.test(String(process.env.HAIBO_FORCE_WARM || ''));
  const sites = shuffleArray(WARM_NEUTRAL_SITES).slice(0, Math.min(warmSiteCount(), WARM_NEUTRAL_SITES.length));
  const total = sites.length;

  console.log(`--- Warm-up (session ${sessionNumber || '?'}${force ? ' | forced deep' : ''}): ${total} neutral sites ---`);
  let visited = 0;
  let captchaSeen = false;
  for (let i = 0; i < total; i++) {
    const ok = await warmVisitPage(browser, proxyAuth, sites[i], device, i + 1, total);
    if (ok) visited++;
    if (warmVisitPage._lastHitCaptcha) captchaSeen = true;
    if (i < total - 1) await sleep(rand(4000, 9000));
  }

  // Propagate the warm-up captcha signal to the search flow: a dirty exit IP
  // means the ya.ru homepage is itself a captcha wall, so the search step must
  // skip the homepage form and go straight to the direct SERP URL.
  runSearchAndVisit._warmHitCaptcha = captchaSeen;
  if (captchaSeen) {
    console.log('  Warm-up hit captcha — search will use direct SERP URLs');
  }

  const ip = readWarmHistory(profileDir);
  const entry = { ts: new Date().toISOString(), session: sessionNumber || null, sites: total, visited, device };
  appendWarmHistory(profileDir, entry);
  try {
    fs.writeFileSync(path.join(profileDir, '.warmed'), String(Date.now()));
  } catch {}
  console.log(`--- Profile warmed: ${visited}/${total} sites; total warm sessions=${ip.length + 1} ---`);
}

async function launchBrowserSession(profileDir, proxyAuth) {
  // headless:false — SmartCaptcha fingerprints the headless GPU/network
  // stack; a real (headed) Chrome plus the stealth plugin plus the manual
  // navigator patches are what actually clears the captcha wall.
  // Set HAIBO_HEADLESS=1 to launch hidden instead (new headless mode still
  // runs a real Chrome; only use it if captcha does not appear).
  const headless = /^(1|true|yes|on)$/i.test(String(process.env.HAIBO_HEADLESS || ''));
  return await puppeteer.launch({
    headless: headless ? 'new' : false,
    userDataDir: profileDir,
    timeout: Number.isFinite(BROWSER_LAUNCH_TIMEOUT_MS) && BROWSER_LAUNCH_TIMEOUT_MS > 0
      ? BROWSER_LAUNCH_TIMEOUT_MS
      : 45000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--proxy-server=http://${proxyAuth.host}:${proxyAuth.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--lang=ru-RU',
      '--accept-lang=ru-RU,ru,en-US,en',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });
}

function normalizeProxyIp(ipText) {
  const text = String(ipText || '').trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.ip) return String(parsed.ip).trim();
  } catch {}

  return text.replace(/^"|"$/g, '');
}

async function testProxyIp(browser, proxyAuth, device = 'desktop') {
  console.log('--- Testing proxy connectivity ---');
  const maxAttempts = Number.isFinite(PROXY_IP_CHECK_ATTEMPTS) && PROXY_IP_CHECK_ATTEMPTS > 0
    ? Math.floor(PROXY_IP_CHECK_ATTEMPTS)
    : 3;
  const timeoutMs = Number.isFinite(PROXY_IP_CHECK_TIMEOUT_MS) && PROXY_IP_CHECK_TIMEOUT_MS >= 5000
    ? PROXY_IP_CHECK_TIMEOUT_MS
    : 20000;
  const retryWaitMs = Number.isFinite(PROXY_IP_CHECK_RETRY_WAIT_MS) && PROXY_IP_CHECK_RETRY_WAIT_MS >= 1000
    ? PROXY_IP_CHECK_RETRY_WAIT_MS
    : 8000;

  let ipText = null;
  let lastError = null;

  // Mobile proxies occasionally drop the CONNECT tunnel during IP rotation.
  // Recreate the page on each attempt so a poisoned navigation state does not
  // keep the whole session stuck.
  for (let attempt = 1; attempt <= maxAttempts && !ipText; attempt++) {
    const testPage = await browser.newPage();
    try {
      await humanizePage(testPage, device);
      await authenticateIfNeeded(testPage, proxyAuth);
      await gotoWithRetry(testPage, 'https://api.ipify.org?format=json', {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      }, 1);
      ipText = await testPage.evaluate(() => document.documentElement.textContent);
    } catch (e) {
      lastError = e;
      console.log(`  Proxy attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      if (attempt < maxAttempts) await sleep(retryWaitMs);
    } finally {
      await testPage.close().catch(() => {});
    }
  }

  if (!ipText) {
    const detail = lastError && lastError.message ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Proxy unreachable after ${maxAttempts} attempts — check geonix account or wait for IP rotation.${detail}`);
  }

  const ip = normalizeProxyIp(ipText);
  console.log('Proxy IP:', ip);
  console.log('');
  return ip;
}

async function openBrowserWithRotatedIp(profileDir, proxyAuth, device, previousIp, sessionNumber) {
  const shouldWaitForRotation = Boolean(previousIp);
  const rotationAttempts = Number.isFinite(PROXY_ROTATION_CHECK_ATTEMPTS) && PROXY_ROTATION_CHECK_ATTEMPTS > 0
    ? Math.floor(PROXY_ROTATION_CHECK_ATTEMPTS)
    : 12;
  const maxAttempts = shouldWaitForRotation ? rotationAttempts : 1;
  const waitMs = Number.isFinite(PROXY_ROTATION_WAIT_MS) && PROXY_ROTATION_WAIT_MS >= 1000
    ? PROXY_ROTATION_WAIT_MS
    : 30000;
  const sessionStartMaxMs = Number.isFinite(PROXY_SESSION_START_MAX_MS) && PROXY_SESSION_START_MAX_MS >= 30000
    ? PROXY_SESSION_START_MAX_MS
    : 180000;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() - startedAt > sessionStartMaxMs) {
      throw new Error(`Proxy session ${sessionNumber} startup watchdog reached ${Math.round(sessionStartMaxMs / 1000)}s`);
    }

    const browser = await launchBrowserSession(profileDir, proxyAuth);
    let currentIp = null;

    try {
      currentIp = await testProxyIp(browser, proxyAuth, device);
    } catch (e) {
      await browser.close().catch(() => {});
      console.log(`--- Proxy check failed while waiting for rotation before session ${sessionNumber}: ${e.message}`);
      if (attempt < maxAttempts) {
        if (Date.now() - startedAt + waitMs > sessionStartMaxMs) {
          throw new Error(`Proxy session ${sessionNumber} startup watchdog reached ${Math.round(sessionStartMaxMs / 1000)}s after failed check`);
        }
        console.log(`--- Waiting ${Math.round(waitMs / 1000)}s before retrying proxy session ${sessionNumber} (${attempt}/${maxAttempts}) ---`);
        await sleep(waitMs);
        continue;
      }
      throw e;
    }

    if (!shouldWaitForRotation || currentIp !== previousIp) {
      if (shouldWaitForRotation) {
        console.log(`--- Proxy IP changed: ${previousIp} -> ${currentIp} ---`);
      }
      return { browser, ip: currentIp };
    }

    console.log(`--- Proxy IP still ${currentIp}; waiting for rotation before session ${sessionNumber} (${attempt}/${maxAttempts}) ---`);
    await browser.close().catch(() => {});

    if (attempt < maxAttempts) {
      if (Date.now() - startedAt + waitMs > sessionStartMaxMs) {
        throw new Error(`Proxy session ${sessionNumber} startup watchdog reached ${Math.round(sessionStartMaxMs / 1000)}s while waiting for IP change`);
      }
      await sleep(waitMs);
    }
  }

  console.log(`--- Proxy IP did not change after ${maxAttempts} checks; continuing anyway ---`);
  const browser = await launchBrowserSession(profileDir, proxyAuth);
  try {
    const ip = await testProxyIp(browser, proxyAuth, device);
    return { browser, ip };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

async function main() {
  const { projectName, targetDomain, device, queries } = resolveCli();
  const proxyAuth = getPrimaryProxy();
  const queriesPerSession = Number.isFinite(QUERIES_PER_PROXY_SESSION) && QUERIES_PER_PROXY_SESSION > 0
    ? Math.floor(QUERIES_PER_PROXY_SESSION)
    : 4;

  console.log('=== Yandex Search & Visit Bot ===');
  console.log('Project:', projectName);
  console.log('Target:', targetDomain);
  console.log(`Device: ${device}`);
  console.log(`Queries (${queries.length}):`, queries.join(' | '));
  console.log(`Proxy: ${proxyAuth.host}:${proxyAuth.port}`);
  console.log(`Proxy rotation: ${queriesPerSession} queries per browser session`);
  console.log('');

  // Persistent per-project profile: cookies, localStorage and history
  // survive between runs — the bot appears as a returning user.
  const profileDir = path.join(__dirname, '.profiles', projectName);
  fs.mkdirSync(profileDir, { recursive: true });

  const results = [];
  let previousIp = null;
  let sessionNumber = 0;
  let browser = null;
  const proxySessionRetryWaitMs = Number.isFinite(PROXY_SESSION_RETRY_WAIT_MS) && PROXY_SESSION_RETRY_WAIT_MS >= 1000
    ? PROXY_SESSION_RETRY_WAIT_MS
    : 300000;

  try {
    for (let batchStart = 0; batchStart < queries.length; batchStart += queriesPerSession) {
      sessionNumber++;
      const batchEnd = Math.min(batchStart + queriesPerSession, queries.length);
      console.log(`\n========== PROXY SESSION ${sessionNumber}: queries ${batchStart + 1}-${batchEnd}/${queries.length} ==========`);

      let session = null;
      let sessionStartAttempt = 0;
      while (!session) {
        sessionStartAttempt++;
        try {
          session = await openBrowserWithRotatedIp(profileDir, proxyAuth, device, previousIp, sessionNumber);
        } catch (e) {
          console.log(`--- Proxy session ${sessionNumber} start attempt ${sessionStartAttempt} failed: ${e.message}`);
          console.log(`--- Waiting ${Math.round(proxySessionRetryWaitMs / 1000)}s before retrying the same proxy session. Press Ctrl+C to stop. ---`);
          await sleep(proxySessionRetryWaitMs);
        }
      }

      browser = session.browser;
      previousIp = session.ip;

      // Warm up the persistent profile on every proxy session so trust
      // (cookies, history, real browsing behaviour) accumulates over time.
      await warmUpProfile(browser, proxyAuth, device, profileDir, sessionNumber);

      for (let i = batchStart; i < batchEnd; i++) {
        const query = queries[i];
        console.log(`\n========== QUERY ${i + 1}/${queries.length}: ${query} ==========`);

        let outcome = failedVisit('query-failed');
        try {
          outcome = await runSearchAndVisit(browser, proxyAuth, query, targetDomain, device);
        } catch (e) {
          console.log(`Query failed: ${redactSensitive(e.message, [proxyAuth.username, proxyAuth.password])}`);
          outcome = failedVisit(SOLVER_TERMINAL_RETRY_ERRORS.test(e.message || '') ? 'solver-terminal'
            : TRANSIENT_NET_ERRORS.test(e.message || '') ? 'network-error' : 'query-error');
        }

        results.push({ query, ...outcome, ip: previousIp });

        if (i < batchEnd - 1) {
          const pause = rand(45000, 90000);
          console.log(`\n--- Pausing ${Math.round(pause / 1000)}s before next query ---`);
          await sleep(pause);
        }
      }

      console.log(`--- Closing browser for proxy session ${sessionNumber} ---`);
      await browser.close();
      browser = null;

      if (batchEnd < queries.length) {
        console.log(`--- Completed ${batchEnd}/${queries.length} queries; next browser session will wait for proxy IP rotation ---`);
      }
    }

    console.log('\n=== SUMMARY ===');
    for (const r of results) {
      console.log(formatVisitSummary(r));
    }
    console.log(`Totals: SEARCH=${results.filter(r => r.ok && r.source === 'search').length} | DIRECT=${results.filter(r => r.ok && r.source === 'direct').length} | FAIL=${results.filter(r => !r.ok).length}`);
  } finally {
    if (browser) {
      console.log('--- Closing browser ---');
      await browser.close().catch(() => {});
    }
    console.log('Done.');
  }
}

async function findAndVisitTarget(page, targetDomain, device = 'desktop') {
  // IDN domains: browser serializes hrefs to punycode, visible text keeps
  // Unicode — match both forms.
  const domainsToMatch = buildDomains(targetDomain);
  // Wait for results if not already loaded
  try {
    await page.waitForSelector('.organic__href, .serp-item, [class*="organic"], [class*="result"]', {
      timeout: 15000
    }).catch(() => {});
  } catch {}

  await sleep(rand(2000, 4000));
  await scrollToBottom(page, device);
  await sleep(rand(1000, 2000));

  console.log('--- Searching for target link ---');

  // Multiple selectors for organic results
  const selectors = [
    '.organic__href a[href]',
    '.serp-item a[href]',
    'a.url',
    'a[class*="Link"]',
    '.result-item a[href]',
    '.normal-link',
    ...domainsToMatch.map(d => `a[href*="${d}"]`)
  ];

  let targetLink = null;
  let foundUrl = '';

  for (const sel of selectors) {
    const links = await page.$$(sel);
    console.log(`  Selector "${sel}" -> ${links.length} links`);
    for (const link of links) {
      const href = await page.evaluate(el => el.href, link);
      if (href && matchesTarget(href, targetDomain)) {
        targetLink = link;
        foundUrl = href;
        break;
      }
    }
    if (targetLink) break;
  }

  // Fallback: all links on page
  if (!targetLink) {
    console.log('  Trying all <a> tags...');
    const allLinks = await page.$$('a[href]');
    for (const link of allLinks) {
      const href = await page.evaluate(el => el.href, link);
      if (href && matchesTarget(href, targetDomain)) {
        targetLink = link;
        foundUrl = href;
        break;
      }
    }
  }

  // Last resort: extract from page text
  if (!targetLink) {
    const textContent = await page.evaluate(() => document.body.innerText);
    const domainRe = new RegExp(`https?:\\/\\/[^\\s]*(?:${domainsToMatch.map(d => d.replace(/\./g, '\\.')).join('|')})[^<"\\s]*`, 'i');
    const urlMatch = textContent.match(domainRe);
    if (urlMatch) {
      foundUrl = urlMatch[0];
      console.log('  Found URL in page text:', foundUrl);
      if (!matchesTarget(foundUrl, targetDomain)) foundUrl = '';
    }
  }

  if (!targetLink && !foundUrl) {
    console.log(`WARNING: Could not find ${targetDomain} on this page of results`);
    return null;
  } else {
    console.log('Found link:', foundUrl);

    await sleep(rand(1000, 2000));
    await humanActivity(page, device);

    const searchPage = page;
    let outcome = { page, result: failedVisit('text-url-only') };
    if (targetLink) {
      console.log('--- Clicking target link ---');
      outcome = await followSearchLink(page, targetLink, targetDomain, device);
      page = outcome.page;
    }
    try {
      if (!outcome.result.ok) {
        const reason = outcome.result.reason;
        console.log(`  Search click not confirmed (${reason}); opening target directly.`);
        try {
          await gotoWithRetry(page, foundUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          outcome.result = await arrivalResult(page, targetDomain, 'direct', reason);
        } catch {
          outcome.result = failedVisit('direct-navigation-failed');
        }
      }

      console.log('');
      console.log('=== RESULT ===');
      console.log('Final URL:', page.url());
      console.log('Target domain reached:', outcome.result.ok ? 'YES' : 'NO');
      console.log('Visit source:', outcome.result.ok ? outcome.result.source : 'FAIL', '|', outcome.result.reason);
      if (!outcome.result.ok) return outcome.result;

      await page.screenshot({ path: `./${targetDomain}_from_yandex.png`, fullPage: true }).catch(() => {});
      await visitSite(page, targetDomain, device).catch(() => {
        console.log('  Target reached; subsequent site browsing failed.');
      });
      return outcome.result;
    } finally {
      // Close a target popup after browsing so it cannot leak into later queries.
      if (page !== searchPage) await page.close().catch(() => {});
    }
  }
}

async function visitSite(page, targetDomain, device = 'desktop') {
  const domainsToMatch = buildDomains(targetDomain);
  // Human-like browsing on the target site
  await sleep(rand(2000, 4000));
  await humanActivity(page, device);
  await scrollToBottom(page, device);
  await sleep(rand(1500, 3000));

  console.log('--- Browsing target site ---');

  let clickedCount = 0;
  const visited = new Set([page.url()]);
  const maxClicks = rand(2, 5);

  // Re-collect fresh link handles every round: element handles die after
  // navigation ("same JavaScript world" errors), so never reuse them.
  for (let round = 0; round < maxClicks + 2 && clickedCount < maxClicks; round++) {
    let candidates = [];
    try {
      candidates = await collectInternalLinkCandidates(page, domainsToMatch, visited);

      if (!candidates.length && round === 0) {
        await tryOpenMobileMenu(page, device);
        candidates = await collectInternalLinkCandidates(page, domainsToMatch, visited);
      }

      if (!candidates.length) {
        candidates = await collectInternalFallbackUrls(page, domainsToMatch, visited);
        if (candidates.length) {
          console.log(`  Found ${candidates.length} internal fallback URLs via ${candidates[0].source}`);
        }
      }
    } catch (e) {
      break;
    }

    if (!candidates.length) {
      console.log('  No internal links found for browsing on this page');
      break;
    }

    // Pick one of the first few candidates (humans click what they see first)
    const chosen = candidates[Math.floor(Math.random() * Math.min(candidates.length, 4))];
    const chosenHref = typeof chosen === 'string' ? chosen : chosen.href;
    const chosenSource = typeof chosen === 'string' ? 'dom-link' : chosen.source;

    // Fresh handle for this round only
    let handle = null;
    if (chosenSource === 'dom-link') {
      try {
        for (const el of await page.$$('a[href]')) {
          const href = await page.evaluate(e => {
            try {
              const url = new URL(e.getAttribute('href'), window.location.href);
              url.hash = '';
              return url.href;
            } catch {
              return e.href;
            }
          }, el).catch(() => null);
          if (href === chosenHref) { handle = el; break; }
        }
      } catch (e) {
        break;
      }
    }

    try {
      console.log(`  ${handle ? 'Clicking internal link' : 'Opening internal page'}: ${chosenHref}`);

      if (!handle) {
        await sleep(rand(700, 1400));
        await gotoWithRetry(page, chosenHref, { waitUntil: 'domcontentloaded', timeout: 30000 }, 2);
      } else {
        // Bring the link into view first — off-screen links have no bounding box
        await handle.evaluate(elem => elem.scrollIntoView({ block: 'center' })).catch(() => {});
        await sleep(rand(400, 900));

        const box = await handle.boundingBox();
        let clickAction;
        if (device === 'mobile' && box) {
          // Real touch tap (no mouse on phones)
          await sleep(rand(300, 700));
          clickAction = page.touchscreen.tap(
            box.x + box.width * rand(35, 65) / 100,
            box.y + box.height * rand(35, 65) / 100
          );
        } else if (box) {
          // Human click: hover, then click a random point inside the link
          await page.mouse.move(
            box.x + box.width * rand(30, 70) / 100,
            box.y + box.height * rand(35, 65) / 100,
            { steps: rand(8, 16) }
          );
          await sleep(rand(300, 700));

          clickAction = page.mouse.click(
            box.x + box.width * rand(35, 65) / 100,
            box.y + box.height * rand(35, 65) / 100,
            { delay: rand(50, 130) }
          );
        } else {
          // Hidden/unmeasurable element — JS click keeps the referrer and
          // skips Puppeteer's visibility checks that fail on mobile layouts
          clickAction = handle.evaluate(elem => elem.click()).catch(() => {});
        }

        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          clickAction
        ]);
      }

      visited.add(chosenHref);
      visited.add(page.url());
      clickedCount++;
      console.log(`  Navigated to: ${page.url().substring(0, 90)}`);

      // Read the page like a human before moving on
      await sleep(rand(2500, 6000));
      await humanActivity(page, device);
      await scrollToBottom(page, device);
      await sleep(rand(1500, 3500));

      await page.screenshot({ path: `./${targetDomain.replace(/\./g, '_')}_page_${clickedCount}.png`, fullPage: true }).catch(() => {});
    } catch (e) {
      console.log(`  Link click failed: ${e.message}`);
      visited.add(chosenHref);
    }
  }

  // Final screenshot
  await sleep(rand(2000, 3000));
  await page.screenshot({ path: `./${targetDomain.replace(/\./g, '_')}_final.png`, fullPage: true }).catch(() => {});
  console.log(`Final screenshot saved: ${targetDomain.replace(/\./g, '_')}_final.png`);
  console.log('Total internal links clicked:', clickedCount);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
