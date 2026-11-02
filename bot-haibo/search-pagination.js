const RESULT_SELECTOR = '.serp-item, .Organic, .organic, a.organic__href, a.organic__url';

function searchUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /^(?:www\.)?(?:ya\.ru|yandex\.ru)$/.test(url.hostname) &&
      /^\/(?:search(?:\/|$)|yandsearch(?:\/|$))/.test(url.pathname) ? url : null;
  } catch { return null; }
}

function pageIndex(value) {
  const url = searchUrl(value);
  const p = url?.searchParams.get('p') ?? '0';
  return url && /^\d+$/.test(p) ? Number(p) : -1;
}

function resultsPageUrl(base, pageNumber) {
  const url = searchUrl(base);
  if (!url || !Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('Invalid search pagination request');
  url.searchParams.delete('page');
  url.searchParams.set('p', String(pageNumber - 1));
  url.hash = '';
  return url.href;
}

async function readSearchPage(page) {
  return page.evaluate(selector => {
    const items = [...document.querySelectorAll(selector)];
    const links = [...new Set(items.flatMap(item =>
      [...item.querySelectorAll('a[href]'), ...(item.matches('a[href]') ? [item] : [])]
        .map(a => a.href)))].sort();
    const text = [...new Set(items.map(item => item.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean))].sort();
    return {
      url: location.href, ready: document.readyState,
      challenge: !!document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, form[action*="checkcaptcha"], iframe[src*="smartcaptcha"]'),
      signature: links.length ? links.join('\n') : text.join('\n'),
    };
  }, RESULT_SELECTOR);
}

function confirmedSearchPage(state, pageNumber, query) {
  const url = searchUrl(state?.url);
  return !!url && typeof query === 'string' && query.length > 0 && pageIndex(state.url) === pageNumber - 1 &&
    url.searchParams.get('text') === query && state.ready !== 'loading' &&
    !state.challenge && !!state.signature;
}

async function openResultsPage(page, base, pageNumber, { navigate, solveCaptcha, seen }) {
  // Keep the original search URL: a CAPTCHA/error document is never a pagination base.
  const requestedUrl = resultsPageUrl(base, pageNumber);
  const query = searchUrl(base).searchParams.get('text');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await navigate(page, requestedUrl);
      if (!(await solveCaptcha(page))) return { ok: false, reason: 'pagination-captcha' };
      if (response && response.status() >= 400 && page.url() === response.url()) {
        return { ok: false, reason: 'pagination-http-error' };
      }
      // CAPTCHA clearance can redirect to the first/wrong page. Restore exactly once.
      if (pageIndex(page.url()) !== pageNumber - 1) {
        if (attempt === 0) continue;
        return { ok: false, reason: 'pagination-page-mismatch' };
      }
      await page.waitForFunction(selector => document.readyState !== 'loading' &&
        !!document.querySelector(selector), { timeout: 5000 }, RESULT_SELECTOR);
      const state = await readSearchPage(page);
      if (!confirmedSearchPage(state, pageNumber, query)) return { ok: false, reason: 'pagination-page-unconfirmed' };
      if (seen.has(state.signature)) return { ok: false, reason: 'pagination-repeated-results' };
      return { ok: true, state };
    }
  } catch {
    return { ok: false, reason: 'pagination-navigation-failed' };
  }
}

module.exports = { resultsPageUrl, readSearchPage, confirmedSearchPage, openResultsPage };
