async function applyFingerprint(page, fp) {
  await page.setUserAgent(fp.userAgent);

  await page.setViewport({
    width: fp.viewport.width,
    height: fp.viewport.height,
    deviceScaleFactor: fp.viewport.dpr,
    isMobile: true,
    hasTouch: true
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': fp.languages.join(',')
  });
}

module.exports = { applyFingerprint };
