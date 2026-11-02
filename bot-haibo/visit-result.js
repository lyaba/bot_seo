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
  const sourceTarget = page.target();
  const owned = new Set();
  const closing = new Map();
  let selected;
  let state = 'observing';
  const closeTarget = target => {
    if (!closing.has(target)) closing.set(target, (async () => {
      const popup = await target.page().catch(() => null);
      if (popup && !popup.isClosed()) await popup.close().catch(() => {});
    })());
    return closing.get(target);
  };
  const track = target => {
    if (target.type() !== 'page' || target.opener() !== sourceTarget) return;
    owned.add(target);
    // Keep this guard through fallback navigation: a late popup must not
    // survive a timed-out click. Release it before internal browsing.
    if (state === 'fallback' || state === 'disposed' || (state === 'selected' && target !== selected)) void closeTarget(target);
  };
  browser.on('targetcreated', track);
  const dispose = async (keepSelected = false) => {
    state = 'disposed';
    browser.off('targetcreated', track);
    page.off('close', disposeOnClose);
    await Promise.all([...owned].filter(target => !keepSelected || target !== selected).map(closeTarget));
  };
  const disposeOnClose = () => { void dispose(); };
  page.once('close', disposeOnClose);
  const fallback = async (reason, diagnostic) => {
    state = 'fallback';
    await Promise.all([...owned].map(closeTarget));
    await page.bringToFront();
    return { page, result: failedVisit(reason), diagnostic, dispose };
  };
  try {
    let clickFailed = false;
    let clickError = '';
    try {
      await page.bringToFront();
      await link.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      // A coordinate tap can succeed at the protocol level while hitting a
      // moving neighbour or an overlay. Require a stable, unobstructed centre.
      let previous;
      let point;
      const settleDeadline = Date.now() + Math.min(timeoutMs, 2000);
      do {
        const box = await link.evaluate(el => {
          const r = el.getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, width: r.width, height: r.height,
            clear: r.width > 0 && r.height > 0 && !!hit && (hit === el || el.contains(hit)) };
        });
        if (box.clear && previous && ['x', 'y', 'width', 'height'].every(key => Math.abs(box[key] - previous[key]) < 1)) {
          point = box;
          break;
        }
        previous = box;
        await sleep(100);
      } while (Date.now() < settleDeadline);
      if (!point) return await fallback('link-covered-or-moving');
      if (device === 'mobile') await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y, { delay: 80 });
    } catch (error) {
      clickFailed = true;
      // The caller redacts this before logging; never include page HTML here.
      clickError = error.message || error.name || 'Unknown click error';
    }

    const deadline = Date.now() + timeoutMs;
    do {
      // Uninitialized about:blank popups must not block enumeration while their
      // redirect is pending. Inspect targets first and resolve only matching pages.
      const targets = [sourceTarget, ...owned];
      for (const target of targets) {
        if (!matchesTarget(target.url(), targetDomain)) continue;
        const candidate = await target.page();
        if (!candidate || candidate.isClosed()) continue;
        const result = await arrivalResult(candidate, targetDomain, 'search',
          candidate === page ? 'same-tab-click' : 'new-tab-click');
        if (result.ok) {
          selected = target;
          state = 'selected';
          await Promise.all([...owned].filter(other => other !== selected).map(closeTarget));
          await candidate.bringToFront();
          return { page: candidate, result, dispose };
        }
      }
      await sleep(100);
    } while (Date.now() < deadline);
    return await fallback(clickFailed ? 'click-failed' : 'click-target-not-reached',
      clickError || `No loaded target document observed within ${timeoutMs}ms after input; click popups: ${owned.size}`);
  } catch (error) {
    await dispose();
    throw error;
  }
}

function formatVisitSummary(result) {
  const label = result.ok ? (result.source === 'search' ? 'SEARCH' : 'DIRECT') : 'FAIL';
  return `${label} | ${result.ip || 'unknown-ip'} | ${result.query}${result.reason ? ' | ' + result.reason : ''}${result.profileId ? ' | profile=' + result.profileId : ''}`;
}

module.exports = { matchesTarget, failedVisit, arrivalResult, followSearchLink, formatVisitSummary };
