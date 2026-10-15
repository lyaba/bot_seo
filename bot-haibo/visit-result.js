const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function matchesTarget(rawUrl, targetDomain) {
  try {
    const url = new URL(rawUrl);
    const host = new URL(`https://${targetDomain}`).hostname.toLowerCase();
    return /^https?:$/.test(url.protocol) &&
      (url.hostname === host || url.hostname.endsWith('.' + host));
  } catch { return false; }
}

function failedVisit(reason) {
  return { ok: false, source: 'none', reason };
}

async function arrivalResult(page, targetDomain, source, reason = '') {
  try {
    // page.url() alone may retain the requested URL on a Chromium error page.
    const state = await page.evaluate(() => ({
      url: location.href, ready: document.readyState,
      status: performance.getEntriesByType('navigation')[0]?.responseStatus || 0,
    }));
    if (state.ready === 'loading' || !matchesTarget(state.url, targetDomain)) {
      return failedVisit('target-not-reached');
    }
    if (state.status >= 400) return failedVisit('target-http-error');
    return { ok: true, source, reason };
  } catch { return failedVisit('target-not-reached'); }
}

// Observe the actual click outcome in the original tab or a popup belonging to
// it. This function never navigates directly and never fabricates a referrer.
async function followSearchLink(page, link, targetDomain, device, { timeoutMs = 15000 } = {}) {
  const browser = page.browser();
  const known = new Set(browser.targets());
  const sourceTarget = page.target();
  let clickFailed = false;
  try {
    await page.bringToFront();
    await link.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    if (device === 'mobile') await link.tap();
    else await link.click({ delay: 80 });
  } catch { clickFailed = true; }

  const deadline = Date.now() + timeoutMs;
  do {
    // Uninitialized about:blank popups must not block enumeration while their
    // redirect is pending. Inspect targets first and resolve only matching pages.
    const targets = browser.targets().filter(target => target === sourceTarget ||
      (!known.has(target) && target.type() === 'page' && target.opener() === sourceTarget));
    for (const target of targets) {
      if (!matchesTarget(target.url(), targetDomain)) continue;
      const candidate = await target.page();
      if (!candidate) continue;
      const result = await arrivalResult(candidate, targetDomain, 'search',
        candidate === page ? 'same-tab-click' : 'new-tab-click');
      if (result.ok) return { page: candidate, result };
    }
    await sleep(100);
  } while (Date.now() < deadline);
  return { page, result: failedVisit(clickFailed ? 'click-failed' : 'click-target-not-reached') };
}

function formatVisitSummary(result) {
  const label = result.ok ? (result.source === 'search' ? 'SEARCH' : 'DIRECT') : 'FAIL';
  return `${label} | ${result.ip || 'unknown-ip'} | ${result.query}${result.reason ? ' | ' + result.reason : ''}`;
}

module.exports = { matchesTarget, failedVisit, arrivalResult, followSearchLink, formatVisitSummary };
