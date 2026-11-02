function withTimeout(operation, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function closeBrowserBounded(browser, timeoutMs = 5000) {
  try {
    await withTimeout(() => browser.close(), timeoutMs, 'Browser close timed out');
  } catch {
    // Only kill the process belonging to this Puppeteer instance.
    const child = browser.process?.();
    if (!child) throw new Error('Browser close failed and no owned process is available');
    if (child.exitCode !== null || child.signalCode) return;
    child.kill('SIGKILL');
    await withTimeout(() => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('exit', resolve);
    }), timeoutMs, 'Browser process did not exit');
  }
}

async function closePageBounded(page, timeoutMs, log) {
  if (page.isClosed()) return;
  try {
    await withTimeout(() => page.close({ runBeforeUnload: false }), timeoutMs, 'Page close timed out');
    return;
  } catch {
    if (page.isClosed()) return;
    log('page close stalled; trying CDP close');
  }
  let session;
  try {
    await withTimeout(async () => {
      session = await page.target().createCDPSession();
      const { targetInfo } = await session.send('Target.getTargetInfo');
      const result = await session.send('Target.closeTarget', { targetId: targetInfo.targetId });
      if (!result.success) throw new Error('CDP rejected target close');
    }, timeoutMs, 'CDP page close timed out');
  } catch {
    if (!page.isClosed()) throw new Error('Warm-up tab cannot be closed; browser session must restart');
  } finally {
    if (session) {
      await withTimeout(() => session.detach(), timeoutMs, 'CDP detach timed out').catch(() => {});
    }
  }
}

async function runBoundedWarmVisit(browser, visit, {
  timeoutMs = 60000, closeTimeoutMs = 3000, log = () => {},
} = {}) {
  let page;
  let stage = 'open-page';
  let cancelled = false;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error(`Warm-up site exceeded ${timeoutMs}ms at ${stage}`));
    }, timeoutMs);
  });
  // Every awaited action checks cancellation. Late completion of an abandoned
  // navigation cannot resume clicks or typing on a later warm-up page.
  const step = async (name, operation) => {
    if (cancelled) throw new Error('Warm-up visit cancelled');
    stage = name;
    const result = await Promise.race([Promise.resolve().then(operation), expired]);
    if (cancelled) throw new Error('Warm-up visit cancelled');
    return result;
  };
  try {
    page = await step('open-page', async () => {
      const opened = await browser.newPage();
      if (cancelled) {
        await closePageBounded(opened, closeTimeoutMs, log).catch(() => {});
        throw new Error('Warm-up page opened after deadline');
      }
      return opened;
    });
    return await Promise.race([visit(page, step), expired]);
  } catch (error) {
    cancelled = true;
    log(`skipped at ${stage}: ${error.message}`);
    if (!page) {
      await closeBrowserBounded(browser, closeTimeoutMs);
      throw new Error('Warm-up page could not be created; browser session must restart');
    }
    return false;
  } finally {
    cancelled = true;
    clearTimeout(timer);
    if (page) {
      try {
        await closePageBounded(page, closeTimeoutMs, log);
      } catch (error) {
        await closeBrowserBounded(browser, closeTimeoutMs);
        throw error;
      }
    }
  }
}

module.exports = { runBoundedWarmVisit, closeBrowserBounded };
