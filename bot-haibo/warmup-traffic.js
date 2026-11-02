// Restrict optional warm-up traffic without changing search/target pages.
async function limitWarmupTraffic(page) {
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isInterceptResolutionHandled()) return;
    let blocked = request.resourceType() === 'media';
    try {
      const url = new URL(request.url());
      const host = url.hostname.toLowerCase();
      blocked ||= /(^|\.)(dzen\.ru|kinopoisk\.ru|rythm\.yandex\.ru)$/.test(host) ||
        (/(^|\.)yandex\.ru$/.test(host) && /^\/rythm(?:\/|$)/i.test(url.pathname)) ||
        /\.(mp4|webm|m4v|mov|m3u8|mpd|m4s|mp3|aac|ogg|wav)$/i.test(url.pathname);
    } catch {}
    const action = blocked ? request.abort('blockedbyclient') : request.continue();
    // A warm-up deadline may close the page while a request is being handled.
    action.catch(() => {});
  });
}

module.exports = { limitWarmupTraffic };
