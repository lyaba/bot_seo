const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');

function normalizeIp(value) {
  const ip = String(value || '').trim();
  const version = net.isIP(ip);
  if (!version) throw new Error('Proxy check did not return a valid IP address');
  return version === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

function profileForIp(root, projectName, device, rawIp) {
  if (!projectName || !['mobile', 'desktop'].includes(device)) {
    throw new Error('Project name and supported device are required for an IP profile');
  }
  const ip = normalizeIp(rawIp);
  const projectKey = encodeURIComponent(projectName).replace(/\./g, '%2E');
  const id = 'ip-' + createHash('sha256').update(ip).digest('hex').slice(0, 24);
  const dir = path.join(root, 'by-ip', projectKey, device, id);
  return { id, dir, ip };
}

// Identify the endpoint with an isolated probe first, then verify it again in
// the selected profile. Never clone a profile's cookies/history into another.
async function openIpProfileSession({ root, projectName, device, initialIp,
  probe, launch, checkIp, warm, log = console.log, maxAttempts = 3 }) {
  let ip = initialIp;
  if (!ip) {
    const probeSession = await probe();
    try { ip = normalizeIp(probeSession.ip); }
    finally { await probeSession.browser.close(); }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const profile = profileForIp(root, projectName, device, ip);
    fs.mkdirSync(profile.dir, { recursive: true });
    const wasWarmed = fs.existsSync(path.join(profile.dir, '.warmed'));
    log(`--- Profile ${profile.id}: ${wasWarmed ? 'saved warm-up history' : 'new; warm-up required'} ---`);
    let browser;
    let delivered = false;
    try {
      browser = await launch(profile.dir);
      const actualIp = normalizeIp(await checkIp(browser));
      if (actualIp !== profile.ip) {
        ip = actualIp;
        log('--- IP changed during profile startup; selecting its own profile ---');
        continue;
      }
      const warming = await warm(browser, profile.dir);
      if (!fs.existsSync(path.join(profile.dir, '.warmed'))) {
        throw new Error(warming?.skipped
          ? 'New IP profile requires warm-up; enable HAIBO_WARM_SESSION'
          : 'New IP profile warm-up did not visit any site successfully');
      }
      const afterWarmIp = normalizeIp(await checkIp(browser));
      if (afterWarmIp !== profile.ip) {
        ip = afterWarmIp;
        log('--- IP changed during warm-up; switching profile before search ---');
        continue;
      }
      delivered = true;
      return { browser, ip: profile.ip, profileId: profile.id, profileDir: profile.dir };
    } finally {
      if (browser && !delivered) await browser.close().catch(() => {});
    }
  }
  throw new Error('IP kept changing during profile startup/warm-up; retry this session later');
}

module.exports = { normalizeIp, profileForIp, openIpProfileSession };
