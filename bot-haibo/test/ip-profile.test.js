const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeIp, profileForIp, openIpProfileSession } = require('../ip-profile');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haibo-ip-profile-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opened = [], closed = [], warmed = [];
  const deps = {
    root, projectName: 'example', device: 'mobile', initialIp: '192.0.2.1', log() {},
    launch: async dir => { const browser = { dir, close: async () => { closed.push(dir); } }; opened.push(dir); return browser; },
    checkIp: async () => '192.0.2.1',
    warm: async (browser, dir) => {
      warmed.push(dir);
      fs.writeFileSync(path.join(dir, '.warmed'), 'test fixture warm-up');
      return { visited: 1 };
    },
    ...options,
  };
  return { deps, root, opened, closed, warmed };
}

test('profile identity isolates IPs, projects and devices, with safe directory paths', t => {
  const { root } = fixture(t);
  const a = profileForIp(root, 'example', 'mobile', '192.0.2.1');
  assert.notEqual(a.dir, profileForIp(root, 'example', 'mobile', '192.0.2.2').dir);
  assert.notEqual(a.dir, profileForIp(root, 'other', 'mobile', '192.0.2.1').dir);
  assert.notEqual(a.dir, profileForIp(root, 'example', 'desktop', '192.0.2.1').dir);
  assert.equal(a.dir, profileForIp(root, 'example', 'mobile', '192.0.2.1').dir);
  assert.equal(path.relative(root, profileForIp(root, '../../outside', 'mobile', '192.0.2.1').dir).startsWith('..'), false);
  assert.throws(() => profileForIp(root, 'example', 'mobile', '<html>proxy error</html>'));
  assert.equal(normalizeIp('2001:0db8:0:0:0:0:0:1'), normalizeIp('2001:db8::1'));
});

test('returning IP reuses stored data; new IP gets no cloned data; legacy stays untouched', async t => {
  const f = fixture(t);
  const legacy = path.join(f.root, 'example');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'history-fixture'), 'legacy');
  const first = await openIpProfileSession(f.deps);
  fs.writeFileSync(path.join(first.profileDir, 'history-fixture'), 'profile A');
  await first.browser.close();
  const other = await openIpProfileSession({ ...f.deps, initialIp: '192.0.2.2', checkIp: async () => '192.0.2.2' });
  assert.equal(fs.existsSync(path.join(other.profileDir, 'history-fixture')), false);
  await other.browser.close();
  const again = await openIpProfileSession(f.deps);
  assert.equal(again.profileDir, first.profileDir);
  assert.equal(fs.readFileSync(path.join(again.profileDir, 'history-fixture'), 'utf8'), 'profile A');
  assert.equal(fs.readFileSync(path.join(legacy, 'history-fixture'), 'utf8'), 'legacy');
});

test('isolated probe is closed before launching a selected profile', async t => {
  const f = fixture(t);
  let probeClosed = false;
  const session = await openIpProfileSession({ ...f.deps, initialIp: undefined,
    probe: async () => ({ ip: '192.0.2.1', browser: { close: async () => { probeClosed = true; } } }),
    launch: async dir => { assert.equal(probeClosed, true); return f.deps.launch(dir); },
  });
  assert.equal(session.ip, '192.0.2.1');
});

test('IP changed at launch selects another profile before warm-up', async t => {
  const f = fixture(t);
  const session = await openIpProfileSession({ ...f.deps, checkIp: async () => '192.0.2.2' });
  assert.equal(session.ip, '192.0.2.2');
  assert.equal(f.opened.length, 2);
  assert.deepEqual(f.warmed, [session.profileDir]);
  assert.deepEqual(f.closed, [f.opened[0]]);
});

test('IP changed during warm-up switches profile and warms the replacement', async t => {
  const f = fixture(t);
  const ips = ['192.0.2.1', '192.0.2.2', '192.0.2.2', '192.0.2.2'];
  const session = await openIpProfileSession({ ...f.deps, checkIp: async () => ips.shift() });
  assert.equal(session.ip, '192.0.2.2');
  assert.equal(f.warmed.length, 2);
  assert.equal(f.closed.length, 1);
});

test('new profile cannot skip warm-up or continue after all visits fail', async t => {
  const f = fixture(t);
  await assert.rejects(openIpProfileSession({ ...f.deps, warm: async () => ({ skipped: true }) }), /requires warm-up/);
  await assert.rejects(openIpProfileSession({ ...f.deps, warm: async () => ({ visited: 0 }) }), /did not visit/);
  assert.equal(f.closed.length, 2);
});

test('saved warmed profile can respect the warm-up disable setting', async t => {
  const f = fixture(t);
  const first = await openIpProfileSession(f.deps);
  await first.browser.close();
  const again = await openIpProfileSession({ ...f.deps, warm: async () => ({ skipped: true }) });
  assert.equal(again.profileDir, first.profileDir);
});

test('IP check error closes browser and a constantly changing IP exhausts the bound', async t => {
  const f = fixture(t);
  await assert.rejects(openIpProfileSession({ ...f.deps, checkIp: async () => { throw new Error('test failure'); } }), /test failure/);
  assert.equal(f.closed.length, 1);
  let n = 2;
  await assert.rejects(openIpProfileSession({ ...f.deps, checkIp: async () => `192.0.2.${n++}` }), /kept changing/);
  assert.equal(f.closed.length, 4);
});

function loadMain(t, observations) {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
  const mainSource = source.slice(source.indexOf('async function main()'), source.indexOf('async function findAndVisitTarget('));
  const sessions = [], visited = [], rows = [];
  const main = vm.runInNewContext(`${mainSource}\nmain`, {
    fs, path, __dirname: f.root, normalizeIp, console: { log() {} },
    resolveCli: () => ({ projectName: 'example', device: 'mobile', targetDomain: 'target.test', queries: ['one', 'two'] }),
    getPrimaryProxy: () => ({}), QUERIES_PER_PROXY_SESSION: 4, PROXY_SESSION_RETRY_WAIT_MS: 1000,
    sleep: async () => {}, rand: min => min,
    openIpProfileSession: async options => {
      const ip = options.initialIp || '192.0.2.1';
      const session = { ip, profileId: 'profile-' + ip, browser: { close: async () => {} } };
      sessions.push(session);
      return session;
    },
    testProxyIp: async () => observations.shift(),
    failedVisit: reason => ({ ok: false, source: 'none', reason }),
    runSearchAndVisit: async (browser, auth, query) => { visited.push({ browser, query }); return { ok: true, source: 'search' }; },
    formatVisitSummary: result => { rows.push(result); return 'fixture'; },
  });
  return { main, sessions, visited, rows };
}

test('query flow switches profile when IP changes between queries and reports its identity', async t => {
  const f = loadMain(t, ['192.0.2.2']);
  await f.main();
  assert.equal(f.sessions.length, 2);
  assert.notEqual(f.visited[0].browser, f.visited[1].browser);
  assert.equal(f.rows[0].ip, '192.0.2.1');
  assert.equal(f.rows[1].ip, '192.0.2.2');
  assert.equal(f.rows[1].profileId, 'profile-192.0.2.2');
});

test('query flow keeps the same browser/profile when IP is unchanged', async t => {
  const f = loadMain(t, ['192.0.2.1']);
  await f.main();
  assert.equal(f.sessions.length, 1);
  assert.equal(f.visited[0].browser, f.visited[1].browser);
});

test('real warm-up function never creates a warmed marker after zero successful visits', async t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
  const code = source.slice(source.indexOf('async function warmUpProfile('), source.indexOf('async function launchBrowserSession('));
  const warm = vm.runInNewContext(`${code}\nwarmUpProfile`, {
    fs, path, process: { env: {} }, console: { log() {} },
    warmEnabled: () => true, shuffleArray: array => array, WARM_NEUTRAL_SITES: ['fixture'], warmSiteCount: () => 1,
    warmVisitPage: async () => false, readWarmHistory: () => [], appendWarmHistory() {},
    runSearchAndVisit: {}, sleep: async () => {}, rand: min => min,
  });
  const result = await warm({}, {}, 'mobile', f.root, 1);
  assert.equal(result.visited, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.warmed')), false);
});
