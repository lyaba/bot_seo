const crypto = require('crypto');

/**
 * Sleep utility with jitter — real humans don't have perfect timers.
 */
function sleep(ms) {
  // Add ±30% jitter to simulate human timing variance
  const jittered = ms * (0.7 + Math.random() * 0.6);
  return new Promise(resolve => setTimeout(resolve, jittered));
}

/**
 * Generate a random number between min and max.
 */
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Pick a random element from an array.
 */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Normalize a domain or URL to a bare hostname (no protocol/www/path).
 */
function normalizeDomain(value) {
  return String(value || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

/**
 * Viewport size with a safe fallback (page.viewport() can return null).
 */
function viewportSize(page) {
  const vp = page.viewport();
  return {
    width: (vp && vp.width) || 1280,
    height: (vp && vp.height) || 800
  };
}

/**
 * Simulate natural mouse movement with bezier-like curves.
 * Real mouse movements follow curved paths, not straight lines.
 */
async function humanMouseMovement(page, steps = 10) {
  const { width, height } = viewportSize(page);
  const startX = rand(50, width - 50);
  const startY = rand(80, height - 80);

  for (let i = 0; i < steps; i++) {
    // Interpolate with bezier curve
    const t = i / steps;
    const easeT = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const x = startX + rand(-30, 30);
    const y = startY + rand(-30, 30);

    await page.mouse.move(x, y, { steps: rand(3, 8) });
    await sleep(rand(50, 200));
  }
}

/**
 * Simulate realistic scrolling behavior.
 * Real users scroll with variable speed, occasional pauses, and sometimes scroll back up.
 */
async function naturalScroll(page) {
  const { height: viewportHeight } = viewportSize(page);

  // Phase 1: Initial pause (reading the page)
  await sleep(rand(3000, 7000));

  // Phase 2: Scroll down in bursts with pauses
  let totalScrolled = 0;
  const scrollBursts = Math.floor(rand(5, 12));

  for (let burst = 0; burst < scrollBursts; burst++) {
    // Each burst has 3-8 small scrolls
    const scrollsInBurst = Math.floor(rand(3, 8));

    for (let s = 0; s < scrollsInBurst; s++) {
      const stepSize = rand(80, 250); // Variable scroll speed

      await page.evaluate((step) => {
        window.scrollBy(0, step);
      }, stepSize);

      totalScrolled += stepSize;

      // Pause between scrolls in burst (100-400ms)
      await sleep(rand(100, 400));
    }

    // Pause between bursts (2-6 seconds) — like reading content
    const pauseBetweenBursts = rand(2000, 6000);
    await sleep(pauseBetweenBursts);

    // Occasionally scroll back up slightly (like re-reading)
    if (Math.random() > 0.6) {
      const backScroll = rand(50, 150);
      await page.evaluate((step) => {
        window.scrollBy(0, -step);
      }, backScroll);
      await sleep(rand(500, 1500));
    }

    // Random pause before next burst (like thinking about what to click)
    await sleep(rand(1000, 4000));
  }

  // Phase 3: Scroll back to top occasionally (like starting over)
  if (Math.random() > 0.5) {
    await sleep(rand(2000, 4000));
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await sleep(rand(3000, 6000));
  }
}

/**
 * Simulate mouse movements while on the page.
 */
async function ambientMouse(page) {
  const moves = Math.floor(rand(8, 20));

  for (let i = 0; i < moves; i++) {
    await humanMouseMovement(page, rand(5, 15));
    await sleep(rand(300, 1200));
  }
}

/**
 * Simulate clicking on internal links with realistic timing.
 *
 * Fixed: the domain argument is now actually used — only same-site links
 * are clicked. When no domain is passed, the current page's own hostname
 * is used as fallback, so the bot never navigates off-site.
 * Also fixed: scrolling to the link now uses scrollIntoView (the old
 * page.evaluate referenced an out-of-scope variable and always threw,
 * so clicks silently never happened).
 */
async function clickLinks(page, domain) {
  const links = await page.$$('a[href]');
  if (!links.length) return false;

  const targetDomain = normalizeDomain(domain) || normalizeDomain(page.url());

  // Filter to relevant links
  const relevantLinks = [];
  for (const link of links) {
    try {
      const href = await page.evaluate(el => el.href, link);
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;

      if (targetDomain) {
        const host = normalizeDomain(href);
        if (host !== targetDomain && !host.endsWith(`.${targetDomain}`)) continue;
      }

      relevantLinks.push({ el: link, href });
    } catch {}
  }

  if (!relevantLinks.length) return false;

  for (const { el, href } of relevantLinks.slice(0, Math.min(3, relevantLinks.length))) {
    try {
      // Scroll the link into the middle of the viewport
      await el.evaluate(elem => elem.scrollIntoView({ block: 'center' }));

      await sleep(rand(500, 1500));

      // Move mouse to element
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: rand(8, 16) });
        await sleep(rand(200, 800));

        // Click with realistic delay
        await el.click({ delay: rand(50, 200) });

        console.log(`Clicked link: ${href}`);
        return true;
      }
    } catch (e) {
      continue;
    }
  }

  return false;
}

/**
 * Simulate tab switching behavior — real users open links in new tabs.
 *
 * Fixed: actually opens a new page in the browser context (the old version
 * performed a regular left-click, which navigated the current tab instead
 * of opening a new one).
 */
async function simulateTabBehavior(page) {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(href => href && /^https?:\/\//i.test(href))
  );
  if (!hrefs.length) return;

  // Real users open 0-2 links in new tabs
  const tabsToOpen = Math.floor(rand(0, 2));

  for (let i = 0; i < tabsToOpen; i++) {
    const href = pick(hrefs);
    let tab = null;
    try {
      tab = await page.browser().newPage();
      await tab.setViewport(viewportSize(page));
      await tab.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`Opened in new tab: ${href}`);
      await sleep(rand(3000, 8000));
    } catch {} finally {
      if (tab) {
        try { await tab.close(); } catch {}
      }
    }
  }
}

/**
 * Phrases typed into on-site search inputs. Configurable per job;
 * defaults are neutral Russian site-search queries.
 */
const DEFAULT_TYPING_PHRASES = ['каталог', 'доставка', 'услуги', 'контакты'];

/**
 * Simulate typing behavior if there's a search input.
 */
async function simulateTyping(page, phrases = DEFAULT_TYPING_PHRASES) {
  const inputs = await page.$$('input[type="text"], input[type="search"], textarea');
  if (!inputs.length) return;

  const input = pick(inputs);
  if (!input) return;

  const phraseList = Array.isArray(phrases) && phrases.length ? phrases : DEFAULT_TYPING_PHRASES;

  try {
    // Click into the input
    await input.click();
    await sleep(rand(500, 1500));

    // Type realistic text with variable speed
    const phrase = pick(phraseList);

    for (const char of phrase) {
      await page.keyboard.type(char, { delay: rand(80, 250) });
    }

    // Sometimes press Enter, sometimes delete
    if (Math.random() > 0.3) {
      await sleep(rand(1000, 3000));
      await page.keyboard.press('Enter');
      console.log('Typed and submitted search query');
    } else {
      // Delete everything and close
      await page.evaluate(() => {
        document.activeElement.value = '';
      });
      await sleep(rand(500, 1500));
      await page.keyboard.press('Escape');
    }
  } catch (e) {}
}

/**
 * Simulate a complete human browsing session.
 * This is the core anti-bot behavior — real users don't follow a script.
 */
async function simulateBehavior(page, options = {}) {
  const domain = options.domain || '';
  const searchEngine = options.searchEngine || 'google';

  console.log(`[${searchEngine}] Starting human simulation...`);

  // Phase 1: Initial reading pause (like looking at the page)
  await sleep(rand(2000, 5000));

  // Phase 2: Ambient mouse movements
  await ambientMouse(page);

  // Phase 3: Natural scrolling through content
  await naturalScroll(page);

  // Phase 4: Try to interact with the page
  if (Math.random() > 0.3) {
    await clickLinks(page, domain);
  }

  // Phase 5: More reading and scrolling
  await sleep(rand(2000, 5000));
  await ambientMouse(page);

  // Phase 6: Maybe try to type something
  if (Math.random() > 0.4) {
    await simulateTyping(page, options.typingPhrases);
  }

  // Phase 7: Final scroll and pause before leaving
  await sleep(rand(3000, 6000));

  console.log('[human] Simulation complete');
}

module.exports = {
  simulateBehavior,
  naturalScroll,
  humanMouseMovement,
  clickLinks,
  ambientMouse,
  simulateTyping,
  sleep,
  rand,
  pick
};
