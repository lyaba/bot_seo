'use strict';
/**
 * Local Yandex SmartCaptcha solver — verbatim port of the algorithms extracted
 * from the live captcha bundle (/tmp/cs.js).
 *
 * PoW:  for(;;){ nonce = allocBuffer(16); genNonce(nonce);
 *               h = sha256(prefixBytes || nonce); if (checkComplexity(h, c)) return nonce }
 *       nonce = big-endian Date.now() (hi word, then lo word) + random bytes.
 * Picasso: canvas rendered with an LCG-Lehmer PRNG (16807*seed % 2^31-1), then
 *          MurmurHash3 x64-128 over canvas.toDataURL() (seed = task seed).
 *
 * The word-pair helpers below are byte-for-byte ports of the bundle's
 * o0/o1/o2/o3/o6/o4 — do NOT "simplify" them to BigInt: the 16-bit limb math
 * must reproduce the bundle's 32-bit overflow semantics exactly.
 */

// ─── 64-bit word-pair ([hi, lo]) arithmetic ──────────────────────────────
function add64(t, e) {
  t = [t[0] >>> 16, 65535 & t[0], t[1] >>> 16, 65535 & t[1]];
  e = [e[0] >>> 16, 65535 & e[0], e[1] >>> 16, 65535 & e[1]];
  var r = [0, 0, 0, 0];
  r[3] += t[3] + e[3]; r[2] += r[3] >>> 16; r[3] &= 65535;
  r[2] += t[2] + e[2]; r[1] += r[2] >>> 16; r[2] &= 65535;
  r[1] += t[1] + e[1]; r[0] += r[1] >>> 16; r[1] &= 65535;
  r[0] += t[0] + e[0]; r[0] &= 65535;
  return [r[0] << 16 | r[1], r[2] << 16 | r[3]];
}
function mul64(t, e) {
  t = [t[0] >>> 16, 65535 & t[0], t[1] >>> 16, 65535 & t[1]];
  e = [e[0] >>> 16, 65535 & e[0], e[1] >>> 16, 65535 & e[1]];
  var r = [0, 0, 0, 0];
  r[3] += t[3] * e[3]; r[2] += r[3] >>> 16; r[3] &= 65535;
  r[2] += t[2] * e[3]; r[1] += r[2] >>> 16; r[2] &= 65535;
  r[2] += t[3] * e[2]; r[1] += r[2] >>> 16; r[2] &= 65535;
  r[1] += t[1] * e[3]; r[0] += r[1] >>> 16; r[1] &= 65535;
  r[1] += t[2] * e[2]; r[0] += r[1] >>> 16; r[1] &= 65535;
  r[1] += t[3] * e[1]; r[0] += r[1] >>> 16; r[1] &= 65535;
  r[0] += t[0] * e[3] + t[1] * e[2] + t[2] * e[1] + t[3] * e[0]; r[0] &= 65535;
  return [r[0] << 16 | r[1], r[2] << 16 | r[3]];
}
function rotl64(t, e) {
  if (32 === (e %= 64)) return [t[1], t[0]];
  if (e < 32) return [t[0] << e | t[1] >>> 32 - e, t[1] << e | t[0] >>> 32 - e];
  e -= 32;
  return [t[1] << e | t[0] >>> 32 - e, t[0] << e | t[1] >>> 32 - e];
}
function shl64(t, e) {
  if (0 === (e %= 64)) return t;
  if (e < 32) return [t[0] << e | t[1] >>> 32 - e, t[1] << e];
  return [t[1] << e - 32, 0];
}
function xor64(t, e) { return [t[0] ^ e[0], t[1] ^ e[1]]; }
function fmix64(t) {
  t = mul64(xor64(t, [0, t[0] >>> 1]), [0xff51afd7, 0xed558ccd]);
  t = mul64(xor64(t, [0, t[0] >>> 1]), [0xc4ceb9fe, 0x1a85ec53]);
  return xor64(t, [0, t[0] >>> 1]);
}

/**
 * MurmurHash3 x64-128 — verbatim port of the bundle's f=function(t,e){...}.
 * Returns the 32-char lowercase hex of a[0]a[1]s[0]s[1].
 */
function murmur128x64(t, e) {
  e = e || 0;
  var r, n, i = (t = t || '').length % 16, o = t.length - i;
  var a = [0, e], s = [0, e];
  var c = [0x87c37b91, 0x114253d5], u = [0x4cf5ad43, 0x2745937f];
  var l;
  for (l = 0; l < o; l += 16) {
    r = [255 & t.charCodeAt(l + 4) | (255 & t.charCodeAt(l + 5)) << 8 | (255 & t.charCodeAt(l + 6)) << 16 | (255 & t.charCodeAt(l + 7)) << 24,
         255 & t.charCodeAt(l) | (255 & t.charCodeAt(l + 1)) << 8 | (255 & t.charCodeAt(l + 2)) << 16 | (255 & t.charCodeAt(l + 3)) << 24];
    n = [255 & t.charCodeAt(l + 12) | (255 & t.charCodeAt(l + 13)) << 8 | (255 & t.charCodeAt(l + 14)) << 16 | (255 & t.charCodeAt(l + 15)) << 24,
         255 & t.charCodeAt(l + 8) | (255 & t.charCodeAt(l + 9)) << 8 | (255 & t.charCodeAt(l + 10)) << 16 | (255 & t.charCodeAt(l + 11)) << 24];
    r = rotl64(mul64(xor64(r, c), u), 31);
    a = xor64(a, r = mul64(xor64(a, r), u));
    a = add64(rotl64(a, 27), s);
    a = add64(mul64(a, [0, 5]), [0, 0x52dce729]);
    n = mul64(rotl64(mul64(xor64(n, u), c), 33), c);
    s = xor64(s, n = mul64(xor64(s, n), c));
    s = add64(rotl64(s, 31), a);
    s = add64(mul64(s, [0, 5]), [0, 0x38495ab5]);
  }
  r = [0, 0]; n = [0, 0];
  switch (i) {
    case 15: n = xor64(n, shl64([0, t.charCodeAt(l + 14)], 48));
    case 14: n = xor64(n, shl64([0, t.charCodeAt(l + 13)], 40));
    case 13: n = xor64(n, shl64([0, t.charCodeAt(l + 12)], 32));
    case 12: n = xor64(n, shl64([0, t.charCodeAt(l + 11)], 24));
    case 11: n = xor64(n, shl64([0, t.charCodeAt(l + 10)], 16));
    case 10: n = xor64(n, shl64([0, t.charCodeAt(l + 9)], 8));
    case 9: n = mul64(rotl64(mul64(xor64(n, [0, t.charCodeAt(l + 8)]), u), 33), c);
            s = xor64(s, n = mul64(xor64(s, n), c));
            // fallthrough (reference bundle has no break here)
    case 8: r = xor64(r, shl64([0, t.charCodeAt(l + 7)], 56));
    case 7: r = xor64(r, shl64([0, t.charCodeAt(l + 6)], 48));
    case 6: r = xor64(r, shl64([0, t.charCodeAt(l + 5)], 40));
    case 5: r = xor64(r, shl64([0, t.charCodeAt(l + 4)], 32));
    case 4: r = xor64(r, shl64([0, t.charCodeAt(l + 3)], 24));
    case 3: r = xor64(r, shl64([0, t.charCodeAt(l + 2)], 16));
    case 2: r = xor64(r, shl64([0, t.charCodeAt(l + 1)], 8));
    case 1: r = mul64(rotl64(mul64(xor64(r, [0, t.charCodeAt(l)]), c), 31), u);
            a = xor64(a, r = mul64(xor64(a, r), u));
            // fallthrough to finalization (reference bundle has no break here)
  }
  a = add64(xor64(a, [0, t.length]), s = xor64(s, [0, t.length]));
  s = add64(s, a);
  a = xor64(fmix64(a), s = fmix64(s));
  s = add64(s, a);
  return hx(a[0]) + hx(a[1]) + hx(s[0]) + hx(s[1]);
}
function hx(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

// ─── LCG-Lehmer PRNG (verbatim port of the bundle's oZ class) ─────────────
class Lcg {
  constructor(seed) {
    this._seed = seed % 0x7fffffff;
    if (this._seed <= 0) this._seed += 0x7ffffffe;
  }
  random() { this._seed = 16807 * this._seed % 0x7fffffff; return this._seed / 0x7fffffff; }
  randomInt(t, e) { return Math.floor(this.randomFloat(t, e)); }
  randomFloat(t, e) {
    if (void 0 === e) return this.random() * t;
    if (e < t) throw Error('b should be greater than a');
    return (e - t) * this.random() + t;
  }
  randomColor() {
    for (var t = '#', e = 0; e < 3; e++) {
      var r = this.randomInt(0, 256).toString(16);
      t += r.length === 1 ? '0' + r : r;
    }
    return t;
  }
}

// ─── Picasso drawing ops (verbatim port of the bundle's oQ array) ─────────
const oQ = [
  function (t, e, r) {
    e.beginPath();
    e.arc(t.randomInt(r.width), t.randomInt(r.height), t.randomInt(Math.min(r.width, r.height)), t.randomFloat(2 * Math.PI), t.randomFloat(2 * Math.PI));
    e.stroke(); e.fill();
  },
  function (t, e, r) {
    var n = Math.max(1, t.randomInt(5));
    var i = (function (t, e) { for (var r = [], n = 0; n < e; n++) { var i = t.randomInt(65, 126); r.push(String.fromCharCode(i)); } return r.join(''); })(t, n);
    e.font = ''.concat(r.height / r.fontSizeFactor, 'px aafakefontaa');
    e.strokeText(i, t.randomInt(r.width), t.randomInt(r.height), t.randomInt(r.width));
    e.fill();
  },
  function (t, e, r) {
    e.beginPath();
    e.moveTo(t.randomInt(r.width), t.randomInt(r.height));
    e.bezierCurveTo(t.randomInt(r.width), t.randomInt(r.height), t.randomInt(r.width), t.randomInt(r.height), t.randomInt(r.width), t.randomInt(r.height));
    e.stroke(); e.fill();
  },
  function (t, e, r) {
    e.beginPath();
    e.moveTo(t.randomInt(r.width), t.randomInt(r.height));
    e.quadraticCurveTo(t.randomInt(r.width), t.randomInt(r.height), t.randomInt(r.width), t.randomInt(r.height));
    e.stroke(); e.fill();
  },
  function (t, e, r) {
    e.beginPath(); e.save();
    e.translate(t.randomInt(r.width), t.randomInt(r.height));
    e.rotate(t.randomFloat(2 * Math.PI));
    e.scale(t.randomInt(Math.floor(r.width / 2)), t.randomInt(Math.floor(r.height / 2)));
    e.arc(0, 0, 1, t.randomFloat(2 * Math.PI), t.randomFloat(2 * Math.PI));
    e.restore(); e.stroke(); e.fill();
  },
];

/**
 * Render one picasso task on the given 2d context (verbatim port of the
 * bundle's round loop): radial-gradient fillStyle, shadowBlur/shadowColor,
 * then a random oQ drawing op.
 */
function renderRound(t /* Lcg */, e /* ctx */, r /* task */) {
  var g = e.createRadialGradient(
    t.randomInt(r.width), t.randomInt(r.height), t.randomInt(r.width),
    t.randomInt(r.width), t.randomInt(r.height), t.randomInt(r.width));
  g.addColorStop(0, t.randomColor());
  g.addColorStop(1, t.randomColor());
  e.fillStyle = g;
  e.shadowBlur = t.randomInt(r.maxShadowBlur);
  e.shadowColor = t.randomColor();
  var n = t.randomInt(0, oQ.length);
  oQ[n](t, e, r);
}

/**
 * Solve one picasso task: seed the LCG, render `rounds` rounds on the canvas,
 * murmur-hash the data URL. Returns {result, calcTime}.
 */
function solvePicassoTask(task, canvas) {
  var t = new Lcg(task.seed);
  // Reference (o9): canvas is created with style.display='none', no clearRect
  // (a fresh canvas is already transparent-black), and appended to
  // documentElement before toDataURL().
  canvas.style.display = 'none';
  var ctx = canvas.getContext('2d');
  var start = Date.now();
  for (var l = 0; l < task.rounds; l++) renderRound(t, ctx, task);
  var result = murmur128x64(canvas.toDataURL(), task.seed);
  return { result, calcTime: Date.now() - start };
}

// ─── PoW: SHA-256(prefix||nonce) with leading-zero-word complexity ───────
function allocBuffer(t) { for (var r = new Array(t), e = 0; e < r.length; e++) r[e] = 0; return r; }
function writeUInt32(t, r, e) {
  t[e] = r >>> 24 & 255; t[e + 1] = r >>> 16 & 255; t[e + 2] = r >>> 8 & 255; t[e + 3] = r & 255;
  return e + 4;
}
function writeTimestamp(t, r, e) {
  var n = (4294967295 & r) >>> 0;
  e = writeUInt32(t, r / 4294967296 >>> 0, e);
  return writeUInt32(t, n, e);
}
function genNonce(t) {
  for (var r = Date.now(), e = writeTimestamp(t, r, 0), o = e + 4 * ((t.length - e) / 4 | 0); e < o; e += 4)
    writeUInt32(t, 4294967296 * Math.random() >>> 0, e);
  for (; e < t.length; e++) t[e] = 256 * Math.random() >>> 0;
}
function checkComplexity(t, r) {
  if (!(r < 8 * t.length)) throw Error('Complexity is too high');
  var e, o = 0;
  for (e = 0; e <= r - 8; e += 8, o++) if (0 !== t[o]) return false;
  var i = 255 << 8 + e - r;
  return 0 == (t[o] & i);
}

/**
 * Mine a PoW nonce: returns hex of a 16-byte nonce (big-endian Date.now() +
 * random) such that SHA-256(prefixBytes || nonce) passes checkComplexity(c).
 * `prefixBytes` = the decoded prefix bytes; `hexPrefix` = the hex string, kept
 * for protocol parity with the bundle (hash input uses decoded bytes).
 */
async function solvePow(prefixBytes, complexity) {
  const { createHash } = require('crypto');
  const toBuf = (x) => Buffer.isBuffer(x) || x instanceof Uint8Array ? x : Buffer.from(x);
  function hash(t, r) {
    const h = createHash('sha256');
    if (r) h.update(toBuf(r));
    h.update(Buffer.from(t));
    return new Uint8Array(h.digest());
  }
  for (var e = allocBuffer(16); ;) {
    genNonce(e);
    var o = hash(e, prefixBytes);
    if (checkComplexity(o, complexity)) return Array.from(e).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

/**
 * Build the tdata payload: base64(JSON({powNonce, powCalcTime, powPrefix})).
 */
function buildTdata(powNonceHex, powCalcTime, powPrefix) {
  return Buffer.from(JSON.stringify({ powNonce: powNonceHex, powCalcTime, powPrefix })).toString('base64');
}

module.exports = {
  murmur128x64,
  Lcg,
  oQ,
  renderRound,
  solvePicassoTask,
  allocBuffer, writeUInt32, writeTimestamp, genNonce, checkComplexity,
  solvePow,
  buildTdata,
};
