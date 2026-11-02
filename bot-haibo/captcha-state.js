const CAPTCHA_ALREADY_CLEARED = Symbol('captcha-already-cleared');
const isNavigationContextError = error => /Execution context was destroyed|Cannot find context|detached Frame|Cannot find execution context/i.test(error?.message || '');

function classifyCaptchaDocument(state) {
  if (!state || state.ready === 'loading') return 'unknown';
  let url;
  try { url = new URL(state.url); } catch { return 'unknown'; }
  if (!/^https?:$/.test(url.protocol)) return 'unknown';
  if (state.challenge) return 'captcha';
  const searchHost = /^(?:www\.)?(?:ya\.ru|yandex\.ru)$/.test(url.hostname);
  if (searchHost && /^\/(?:search(?:\/|$)|yandsearch(?:\/|$))/.test(url.pathname) &&
      (state.results || state.searchInput)) return 'clear';
  if (/\/(?:showcaptcha(?:fast)?|checkcaptcha|captcha|verify)(?:\/|$)/i.test(url.pathname) && state.hasBody) return 'captcha';
  return 'unknown';
}

async function captchaCleared(page, stage, { timeoutMs = 5000, pollMs = 150, log = console.log } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (page.isClosed()) throw new Error('CAPTCHA page closed while checking its state');
    try {
      const snapshot = await page.evaluate(() => {
        const visible = selector => [...document.querySelectorAll(selector)].some(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        });
        return {
          url: location.href, ready: document.readyState, hasBody: !!document.body?.innerText.trim(),
          challenge: visible('#checkbox-captcha-form, .CheckboxCaptcha, form[action*="checkcaptcha"], iframe[src*="smartcaptcha"]'),
          results: !!document.querySelector('.serp-item, .organic__href, #search-result, .Organic'),
          searchInput: visible('input[name="text"], textarea[name="text"], input#text, textarea#text'),
        };
      });
      const state = classifyCaptchaDocument(snapshot);
      if (state === 'clear') {
        log(`  CAPTCHA no longer active (${stage}); continuing search without solver.`);
        return true;
      }
      if (state === 'captcha') return false;
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  throw new Error(`CAPTCHA state could not be confirmed (${stage}); solver not started`);
}

module.exports = { CAPTCHA_ALREADY_CLEARED, isNavigationContextError, classifyCaptchaDocument, captchaCleared };
