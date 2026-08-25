const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const proxies = require('./proxies');

puppeteer.use(StealthPlugin());

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
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

/**
 * Apply per-session human traits: realistic viewport, matching User-Agent,
 * Moscow timezone (matches the ru locale and RU proxy IP).
 */
async function humanizePage(page, device = 'desktop') {
  await page.setViewport(pickViewport(device));
  const pool = device === 'mobile' ? MOBILE_UAS : DESKTOP_UAS;
  await page.setUserAgent(pool[Math.floor(Math.random() * pool.length)]);
  try { await page.emulateTimezone('Europe/Moscow'); } catch {}
}

/**
 * Type like a human: variable key delay, occasional typo + backspace
 * correction, random thinking pauses between words/chars.
 */
async function humanType(page, text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // ~7% chance: hit a neighbouring wrong char, notice, correct it
    if (Math.random() < 0.07 && /[а-яёa-z]/i.test(ch)) {
      const shift = Math.random() < 0.5 ? 1 : -1;
      const wrong = String.fromCharCode(ch.charCodeAt(0) + shift);
      await page.keyboard.type(wrong, { delay: rand(60, 160) });
      await sleep(rand(180, 450));   // "notice the mistake"
      await page.keyboard.press('Backspace');
      await sleep(rand(120, 320));
    }

    await page.keyboard.type(ch, { delay: rand(60, 190) });
    if (Math.random() < 0.12) await sleep(rand(200, 650)); // thinking pause
  }
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
const SOLVER_TERMINAL_RETRY_ERRORS = /Captcha solver wall-clock timeout reached|Captcha solving timed out/i;

async function solveCaptchaWithPython(captchaPage, proxyAuth, maxRetries = 3) {
  console.log('  🧩 Solving captcha via Python/CapMonster...');
  
  const captchaUrl = captchaPage.url();
  console.log(`  Captcha URL: ${captchaUrl}`);
  
  // Get the sitekey from the page
  let sitekey;
  try {
    sitekey = await getCaptchaSiteKey(captchaPage);
  } catch (e) {
    sitekey = '0x4AAAAAAA1Y6Rq8M2BnJfIe';
  }
  console.log(`  Sitekey: ${sitekey.substring(0, 30)}...`);
  
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
  const solverTimeoutMs = 150000;

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
    
    const args = ['-u', '-X', 'faulthandler', scriptPath, '--url', captchaUrl, '--sitekey', sitekey, '--output', 'json'];
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
      throw new Error(`Captcha solver timed out while CapMonster was still processing; stopping retries to avoid creating more paid tasks. Last error: ${lastError}`);
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

async function applyCaptchaToken(page, token) {
  console.log('  🔑 Applying captcha token to page...');
  
  const result = await page.evaluate((tok) => {
    const selectors = [
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

async function trySearchViaURL(query, browser, proxyAuth, device = 'desktop') {
  const urls = [
    `https://yandex.ru/search/?text=${encodeURIComponent(query)}&lr=213`,
    `https://yandex.ru/search/?text=${encodeURIComponent(query)}&auto-direct=true`,
    `https://search.yandex.ru/yandsearch?text=${encodeURIComponent(query)}&lr=213`,
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
        console.log('  ⚠️ CAPTCHA triggered — attempting to solve via Python...');
        
        // Wait for captcha iframe to load
        await sleep(rand(3000, 5000));
        
        // Try to solve the captcha
        let token = null;
        try {
          token = await solveCaptchaWithPython(page, proxyAuth);
        } catch (e) {
          const reason = SOLVER_TERMINAL_RETRY_ERRORS.test(e.message || String(e)) ? 'solver-timeout' : 'solver';
          lastFailure = { reason, error: e.message };
          console.log(`  ✗ Python captcha solver failed: ${e.message}`);
          await page.close();
          if (reason === 'solver-timeout') {
            return { success: false, ...lastFailure };
          }
          continue;
        }
        
        if (token) {
          console.log('  🔑 Applying token...');
          await applyCaptchaToken(page, token);
          
          // Check if we're past the captcha now
          await sleep(rand(2000, 4000));
          const newUrl = page.url();
          
          if (!isCaptchaPage(newUrl)) {
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
            lastFailure = { reason: 'captcha', error: 'Captcha token was not accepted' };
            console.log('  ✗ Captcha token not accepted, trying next URL...');
            await page.close();
            continue;
          }
        }
        
        // If Python solver failed, try next URL
        lastFailure = { reason: 'solver', error: 'Python captcha solver returned no token' };
        console.log('  ✗ Python captcha solver failed, trying next URL...');
        await page.close();
        continue;
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
  await humanActivity(page, device);
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
      console.log(`  Nav attempt ${i}/${attempts} failed (${msg.split('\n')[0].substring(0, 90)}), retrying navigation...`);
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

    // Human-like: bring into view, then tap (mobile) or hover+click (desktop)
    await btn.evaluate(elem => elem.scrollIntoView({ block: 'center' })).catch(() => {});
    await sleep(rand(300, 700));
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

  try {
    // Open ya.ru first (human behavior)
    console.log('--- Opening ya.ru ---');
    mainPage = await browser.newPage();
    await humanizePage(mainPage, device);
    await authenticateIfNeeded(mainPage, proxyAuth);

    await gotoWithRetry(mainPage, 'https://ya.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(rand(3000, 5000));
    await humanActivity(mainPage, device);

    // Try to find and use the search input on ya.ru
    console.log('--- Using ya.ru search ---');
    const selectors = [
      'input[name="text"]',
      'textarea[class*="Search"]',
      '[class*="SearchInput"] input',
      '.index-Controls input',
      'input[type="text"][autofocus]',
      '.header-search__field',
      '#text'
    ];

    let searchFound = false;
    for (const sel of selectors) {
      const el = await mainPage.$(sel);
      if (el) {
        console.log(`  Found input via: ${sel}`);
        await el.click({ clickCount: 3 });
        await sleep(rand(200, 500));
        await humanType(mainPage, searchQuery);
        await sleep(rand(500, 1000));
        await mainPage.keyboard.press('Enter');
        searchFound = true;
        break;
      }
    }

    if (!searchFound) {
      console.log('  Search input not found on ya.ru, navigating directly...');
      // Direct Yandex search URL — the most reliable method
      const directUrl = `https://yandex.ru/search/?text=${encodeURIComponent(searchQuery)}&lr=213`;
      await gotoWithRetry(mainPage, directUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    await sleep(rand(4000, 7000));

    let activePage = mainPage;
    const currentPageUrl = mainPage.url();

    if (isCaptchaPage(currentPageUrl)) {
      console.log('CAPTCHA detected! Trying checkbox click first...');
      if (await tryClickCaptchaCheckbox(mainPage, device)) {
        activePage = mainPage;
      } else {
        console.log('Falling back to direct search URLs + solver...');
        await mainPage.close().catch(() => {});
        mainPage = null;

        const result = await trySearchViaURL(searchQuery, browser, proxyAuth, device);
        if (!result.success) {
          console.log(formatSearchFailure(result));
          return false;
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
        if (await tryClickCaptchaCheckbox(mainPage, device)) {
          activePage = mainPage;
        } else {
          console.log('Falling back to direct URLs + solver...');
          await mainPage.close().catch(() => {});
          mainPage = null;

          const result = await trySearchViaURL(searchQuery, browser, proxyAuth, device);
          if (!result.success) {
            console.log(formatSearchFailure(result));
            return false;
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
          const directUrl = `https://yandex.ru/search/?text=${encodeURIComponent(searchQuery)}&lr=213`;
          await gotoWithRetry(mainPage, directUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
          });
          await sleep(rand(4000, 7000));

          const checkUrl = mainPage.url();
          if (isCaptchaPage(checkUrl)) {
            console.log('CAPTCHA detected! Trying checkbox click first...');
            if (await tryClickCaptchaCheckbox(mainPage, device)) {
              activePage = mainPage;
            } else {
              console.log('Falling back to alternative URLs + solver...');
              const result = await trySearchViaURL(searchQuery, browser, proxyAuth, device);
              if (!result.success) {
                console.log(formatSearchFailure(result));
                return false;
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
    let visited = false;

    for (let pageNum = 1; pageNum <= MAX_PAGES && !visited; pageNum++) {
      if (pageNum > 1) {
        console.log(`\n--- Checking page ${pageNum} of results ---`);
        const base = activePage.url();
        const urlWithPage = /[?&]page=\d+/.test(base)
          ? base.replace(/([?&])page=\d+/, `$1page=${pageNum}`)
          : `${base}${base.includes('?') ? '&' : '?'}page=${pageNum}`;

        await gotoWithRetry(activePage, urlWithPage, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(rand(2500, 5000));

        if (isCaptchaPage(activePage.url())) {
          console.log(`CAPTCHA on page ${pageNum}, trying checkbox click...`);
          if (!(await tryClickCaptchaCheckbox(activePage, device))) break;

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

      visited = await findAndVisitTarget(activePage, targetDomain, device);
    }

    if (!visited) {
      // Target not in top pages — go directly (behavioral factor still counts)
      console.log(`\n--- Target not found in top ${MAX_PAGES} pages, navigating directly ---`);
      const domainsToMatch = buildDomains(targetDomain);

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
      console.log('Target domain reached:', domainsToMatch.some(d => finalUrl.includes(d)) ? 'YES' : 'NO');

      await activePage.screenshot({ path: `./${targetDomain}_from_yandex.png`, fullPage: true });
      console.log(`Screenshot saved: ${targetDomain}_from_yandex.png`);

      await visitSite(activePage, targetDomain, device);
    }
    return true;

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

async function warmUpProfile(browser, proxyAuth, device, profileDir) {
  const marker = path.join(profileDir, '.warmed');
  if (fs.existsSync(marker)) return;

  console.log('--- First run: warming up profile (cookies/history) ---');
  try {
    const page = await browser.newPage();
    await humanizePage(page, device);
    await authenticateIfNeeded(page, proxyAuth);

    await gotoWithRetry(page, 'https://yandex.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(3000, 6000));
    await humanActivity(page, device);
    await scrollToBottom(page, device);
    await sleep(rand(2000, 4000));

    // A second neutral page deepens the cookie set
    await gotoWithRetry(page, 'https://ya.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(rand(2500, 5000));
    await humanActivity(page, device);

    fs.writeFileSync(marker, String(Date.now()));
    await page.close();
    console.log('--- Profile warmed ---');
  } catch (e) {
    console.log(`Warm-up skipped: ${e.message}`);
  }
}

async function main() {
  const { projectName, targetDomain, device, queries } = resolveCli();
  const proxyAuth = getPrimaryProxy();

  console.log('=== Yandex Search & Visit Bot ===');
  console.log('Project:', projectName);
  console.log('Target:', targetDomain);
  console.log(`Device: ${device}`);
  console.log(`Queries (${queries.length}):`, queries.join(' | '));
  console.log(`Proxy: ${proxyAuth.host}:${proxyAuth.port}`);
  console.log('');

  // Persistent per-project profile: cookies, localStorage and history
  // survive between runs — the bot appears as a returning user.
  const profileDir = path.join(__dirname, '.profiles', projectName);
  fs.mkdirSync(profileDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--proxy-server=http://${proxyAuth.host}:${proxyAuth.port}`,
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--proxy-bypass-list=<-loopback>',
      '--lang=ru-RU',
      '--accept-lang=ru-RU,ru,en-US,en'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  try {
    // Test proxy first
    console.log('--- Testing proxy connectivity ---');
    const testPage = await browser.newPage();
    await authenticateIfNeeded(testPage, proxyAuth);

    // Mobile proxies occasionally drop the CONNECT tunnel during IP
    // rotation — retry before giving up.
    let ipText = null;
    for (let attempt = 1; attempt <= 3 && !ipText; attempt++) {
      try {
        await gotoWithRetry(testPage, 'https://api.ipify.org?format=json', {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        }, 1);
        ipText = await testPage.evaluate(() => document.documentElement.textContent);
      } catch (e) {
        console.log(`  Proxy attempt ${attempt}/3 failed: ${e.message}`);
        if (attempt < 3) await sleep(8000);
      }
    }

    if (!ipText) {
      throw new Error('Proxy unreachable after 3 attempts — check geonix account or wait for IP rotation');
    }
    console.log('Proxy IP:', ipText.trim());
    await testPage.close();
    console.log('');

    // Warm up the persistent profile on first run (cookies/history)
    await warmUpProfile(browser, proxyAuth, device, profileDir);

    const results = [];

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      console.log(`\n========== QUERY ${i + 1}/${queries.length}: ${query} ==========`);

      let ok = false;
      try {
        ok = await runSearchAndVisit(browser, proxyAuth, query, targetDomain, device);
      } catch (e) {
        console.log(`Query failed: ${e.message}`);
      }

      results.push({ query, ok });

      if (i < queries.length - 1) {
        const pause = rand(45000, 90000);
        console.log(`\n--- Pausing ${Math.round(pause / 1000)}s before next query ---`);
        await sleep(pause);
      }
    }

    console.log('\n=== SUMMARY ===');
    for (const r of results) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} | ${r.query}`);
    }

  } finally {
    console.log('--- Closing browser ---');
    await browser.close();
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
      if (href && domainsToMatch.some(d => href.includes(d))) {
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
      if (href && domainsToMatch.some(d => href.includes(d))) {
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
      // Try to click it by navigating directly
      targetLink = { click: async () => { await gotoWithRetry(page, foundUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } };
    }
  }

  if (!targetLink) {
    console.log(`WARNING: Could not find ${targetDomain} on this page of results`);
    return false;
  } else {
    console.log('Found link:', foundUrl);

    await sleep(rand(1000, 2000));
    await humanActivity(page, device);

    console.log('--- Clicking target link ---');
    // Yandex SERP links usually open in a NEW TAB (target="_blank"),
    // so track pages created by the click and switch to the target one.
    const knownPages = new Set(await page.browser().pages());
    try {
      // Human click: hover over the link first, then click a random point
      // inside it (never the exact center).
      let clickAction;
      const box = await targetLink.boundingBox();
      if (device === 'mobile' && box) {
        // Real touch tap — phones have no hover/mousemove
        const cx = box.x + box.width * rand(35, 65) / 100;
        const cy = box.y + box.height * rand(35, 65) / 100;
        await sleep(rand(400, 900));
        clickAction = page.touchscreen.tap(cx, cy);
      } else if (box) {
        const cx = box.x + box.width * rand(30, 70) / 100;
        const cy = box.y + box.height * rand(35, 65) / 100;
        await page.mouse.move(cx, cy, { steps: rand(10, 20) });
        await sleep(rand(400, 900));
        clickAction = page.mouse.click(cx, cy, { delay: rand(50, 140) });
      } else {
        clickAction = targetLink.click({ delay: rand(50, 150) });
      }
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        clickAction
      ]);
    } catch (e) {
      console.log('Click failed:', e.message);
    }

    await sleep(rand(2000, 4000));

    // If the original page did not reach the target, look for a new tab
    if (!domainsToMatch.some(d => page.url().includes(d))) {
      try {
        const pagesNow = await page.browser().pages();
        for (const p of pagesNow) {
          if (knownPages.has(p)) continue;
          const u = p.url();
          if (domainsToMatch.some(d => u.includes(d))) {
            console.log('  Target opened in a new tab:', u.substring(0, 100));
            page = p;
            break;
          }
        }
      } catch {}

      // Still not on target — navigate directly as last resort
      if (!domainsToMatch.some(d => page.url().includes(d))) {
        console.log('  No new tab with target, navigating directly:', foundUrl);
        await gotoWithRetry(page, foundUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
    }

    await sleep(rand(2000, 4000));

    const finalUrl = page.url();
    console.log('');
    console.log('=== RESULT ===');
    console.log('Final URL:', finalUrl);
    console.log('Target domain reached:', domainsToMatch.some(d => finalUrl.includes(d)) ? 'YES' : 'NO');

    await page.screenshot({ path: `./${targetDomain}_from_yandex.png`, fullPage: true });
    console.log(`Screenshot saved: ${targetDomain}_from_yandex.png`);

    await visitSite(page, targetDomain, device);
    return true;
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
      candidates = await page.evaluate((domainList, excludeList) => {
        const exclude = new Set(excludeList);
        const fileRe = /\.(png|jpe?g|gif|svg|webp|pdf|zip|rar|docx?|xlsx?|mp4|mp3)(\?|$)/i;
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(href =>
            href &&
            domainList.some(dm => href.includes(dm)) &&
            !href.includes('#') &&
            !href.startsWith('javascript') &&
            !fileRe.test(href) &&
            !exclude.has(href)
          )
          .slice(0, 10);
      }, domainsToMatch, Array.from(visited)).catch(() => []);
    } catch (e) {
      break;
    }

    if (!candidates.length) break;

    // Pick one of the first few candidates (humans click what they see first)
    const chosen = candidates[Math.floor(Math.random() * Math.min(candidates.length, 4))];

    // Fresh handle for this round only
    let handle = null;
    try {
      for (const el of await page.$$('a[href]')) {
        const href = await page.evaluate(e => e.href, el).catch(() => null);
        if (href === chosen) { handle = el; break; }
      }
    } catch (e) {
      break;
    }
    if (!handle) break;

    try {
      console.log(`  Clicking internal link: ${chosen}`);

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

      visited.add(chosen);
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
      visited.add(chosen);
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
