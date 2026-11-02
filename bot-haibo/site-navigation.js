const { matchesTarget, arrivalResult } = require('./visit-result');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readScrollState(page, point = {}) {
  const viewport = page.viewport() || { width: 390, height: 844 };
  return page.evaluate(({ x, y }) => {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) break;
      el = el.parentElement;
    }
    if (!el || el === document.body || el === document.documentElement) el = document.scrollingElement;
    const top = el?.scrollTop || 0;
    const max = Math.max(0, (el?.scrollHeight || 0) - (el?.clientHeight || 0));
    return { top, max, atBottom: top >= max - 60 };
  }, { x: point.x ?? viewport.width / 2, y: point.y ?? viewport.height * 0.55 });
}

function pageKey(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(ysclid|yclid|gclid|fbclid|utm_.*)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return ''; }
}

async function interact(page, handle, device) {
  await page.bringToFront();
  await handle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  // Wait for layout/animations to settle before sending a coordinate-based tap.
  let stable = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = await handle.boundingBox();
    await sleep(100);
    const after = await handle.boundingBox();
    if (before && after && ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 1)) {
      stable = true;
      break;
    }
  }
  if (!stable) return false;
  const hitTest = el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) return false;
    const nestedControl = hit.closest('button, input, [role="button"]');
    return !nestedControl || nestedControl === el || !el.contains(nestedControl);
  };
  try { await page.waitForFunction(hitTest, { timeout: 2000 }, handle); }
  catch { return false; }
  if (device === 'mobile') await handle.tap();
  else await handle.click({ delay: 80 });
  return true;
}

async function prepareSiteBrowsing(page, domain, device, { timeoutMs = 5000 } = {}) {
  if (!matchesTarget(page.url(), 'imperator-kzn.ru') || !matchesTarget(`https://${domain}`, 'imperator-kzn.ru')) return 'not-needed';
  // The mobile cookie notice is a full-screen sheet above the delivery prompt.
  // Acknowledge only that identified notice through its visible button.
  for (const sheet of await page.$$('.bottom-sheet')) {
    try {
      if (!await sheet.evaluate(el => !!el.querySelector('.cookie-notification'))) continue;
      for (const button of await sheet.$$('button')) {
        try {
          if (!await button.evaluate(el => /^хорошо$/i.test(el.innerText.trim()))) continue;
          if (!await interact(page, button, device)) return 'cookie-notice-blocked';
          try {
            await page.waitForFunction(() => ![...document.querySelectorAll('.bottom-sheet .cookie-notification')]
              .some(el => el.getBoundingClientRect().width > 0), { timeout: timeoutMs });
          } catch { return 'cookie-notice-still-open'; }
        } finally { await button.dispose(); }
      }
    } finally { await sheet.dispose(); }
  }
  // This FoodSoul prompt blocks all underlying links. Select only its public
  // menu mode; do not enter an address, add items or place an order.
  const roots = '.ui-modal, .delivery-choice';
  const options = '.ui-modal .delivery-method__item, .delivery-choice button';
  let prompt = null;
  const prompts = await page.$$(roots);
  for (const candidate of prompts) {
    const visible = await candidate.evaluate(el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility === 'visible' && style.opacity !== '0' && style.pointerEvents !== 'none';
    });
    if (visible && !prompt) prompt = candidate;
    else await candidate.dispose();
  }
  if (!prompt) return 'not-needed';
  try {
    const expected = await prompt.evaluate(el => /выберите способ получения/i.test(el.innerText));
    if (!expected) return 'unrecognized-dialog';
    try {
      await page.waitForFunction(selectors => [...document.querySelectorAll(selectors)]
        .some(el => /^самовывоз$/i.test(el.innerText.trim())), { timeout: timeoutMs }, options);
    } catch { return 'delivery-options-not-ready'; }
    for (const item of await page.$$(options)) {
      try {
        if (!await item.evaluate(el => /^самовывоз$/i.test(el.innerText.trim()))) continue;
        if (!await interact(page, item, device)) return 'delivery-option-blocked';
        try {
          await page.waitForFunction(selectors => ![...document.querySelectorAll(selectors)].some(el =>
            /выберите способ получения/i.test(el.innerText) && el.getBoundingClientRect().width > 0 &&
            getComputedStyle(el).opacity !== '0' && getComputedStyle(el).pointerEvents !== 'none'), { timeout: timeoutMs }, roots);
          await sleep(400); // let modal animations release the scroll lock
          return 'pickup-selected';
        } catch { return 'delivery-dialog-still-open'; }
      } finally { await item.dispose(); }
    }
    return 'delivery-option-missing';
  } finally { await prompt.dispose(); }
}

async function collectVisibleInternalLinks(page, domain, visited) {
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter(el => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility === 'visible' && style.opacity !== '0' && !el.closest('[inert]');
  }).map(el => ({ href: el.href, text: el.innerText.trim() })));
  const excluded = new Set([...visited, page.url()].map(pageKey));
  const seen = new Set();
  return links.filter(link => {
    const key = pageKey(link.href);
    if (!matchesTarget(link.href, domain) || !key || excluded.has(key) || seen.has(key)) return false;
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|rar|docx?|xlsx?|mp4|mp3)(\?|$)/i.test(link.href)) return false;
    // Keep browsing read-only: no cart/checkout/account or logout routes.
    if (/(?:^|\/)(?:cart|basket|checkout|logout|login|account|korzina)(?:\/|\?|$)/i.test(new URL(link.href).pathname)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30).map(({ href }) => ({ href, source: 'dom-link' }));
}

async function openInternalLink(page, href, domain, device, { timeoutMs = 8000 } = {}) {
  const before = pageKey(page.url());
  const sourceTarget = page.target();
  const browser = page.browser();
  const popups = new Set();
  let adopted;
  // Track only popups opened by this page during this interaction, including
  // noopener links. Never adopt an unrelated existing tab.
  const onTarget = target => {
    if (target.type() === 'page' && target.opener() === sourceTarget) popups.add(target);
  };
  browser.on('targetcreated', onTarget);
  let links = [];
  try {
    links = await page.$$('a[href]');
    for (const link of links) {
      const info = await link.evaluate(el => ({ href: el.href, visible: !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height) }));
      if (!info.visible || pageKey(info.href) !== pageKey(href)) continue;
      if (!await interact(page, link, device)) continue;
      const deadline = Date.now() + timeoutMs;
      do {
        for (const target of [sourceTarget, ...popups]) {
          if (pageKey(target.url()) !== pageKey(href) || (target === sourceTarget && pageKey(target.url()) === before)) continue;
          const candidate = target === sourceTarget ? page : await target.page();
          if (!candidate || candidate.isClosed()) continue;
          const arrival = await arrivalResult(candidate, domain, 'internal');
          if (arrival.ok) {
            await candidate.bringToFront();
            adopted = candidate;
            return { ok: true, url: candidate.url(), page: candidate };
          }
        }
        await sleep(100);
      } while (Date.now() < deadline);
      return { ok: false, reason: pageKey(page.url()) === before ? 'no-confirmed-navigation' : 'expected-route-not-reached' };
    }
    return { ok: false, reason: 'link-hidden-missing-or-covered' };
  } finally {
    browser.off('targetcreated', onTarget);
    await Promise.all(links.map(link => link.dispose().catch(() => {})));
    for (const target of popups) {
      const popup = await target.page().catch(() => null);
      if (popup && popup !== adopted) await popup.close().catch(() => {});
    }
    if (!adopted || adopted === page) await page.bringToFront().catch(() => {});
  }
}

module.exports = { pageKey, readScrollState, prepareSiteBrowsing, collectVisibleInternalLinks, openInternalLink };
