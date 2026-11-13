'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const G = 1;              // gravitational constant (natural units)
const SOFT2 = 4;          // softening² — stops forces blowing up at tiny distances
const FRAME_DT = 0.3;     // simulated time per 60 Hz frame at 1× speed
const LAUNCH_K = 0.1;     // slingshot: world-units of drag → velocity
const TRAIL_LEN = 180;    // samples kept per trail
const STAR_MASS = 2000;   // bodies at least this heavy glow like stars
const SHATTER_FACTOR = 1.2; // impacts faster than this × escape speed spray debris
const GRID_K = 0.4;       // how strongly mass dents the spacetime grid

const STAR_COLORS = ['#fff4d6', '#ffd27a', '#ffb36b', '#cfe3ff'];
const PLANET_COLORS = ['#7cc6ff', '#8affc1', '#ff8fb1', '#c7a6ff', '#ffe082', '#80deea', '#ffab91'];
const COMET_COLOR = '#bfefff';
const BH_COLOR = '#ffb36b';
// Dust palette: 0 blue disk, 1 orange disk, 2 grey rocks, 3 hot debris
const DUST_COLORS = ['rgba(140,190,255,0.8)', 'rgba(255,190,130,0.8)', 'rgba(205,205,215,0.65)', 'rgba(255,150,90,0.95)'];

const LAUNCH_TYPES = {
  asteroid: { m: 2, kind: 'rock' },
  planet: { m: 50, kind: 'rock' },
  giant: { m: 600, kind: 'rock' },
  star: { m: 5000, kind: 'rock' },
  blackhole: { m: 30000, kind: 'blackhole' },
  comet: { m: 0.5, kind: 'comet' },
};

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
// "bodies" attract each other and everything else (O(n²)).
// "dust" are massless test particles: they feel the bodies but exert nothing,
// which lets us show thousands of them (galaxy disks, asteroid belts, debris).
const world = { bodies: [], dust: [], flashes: [], time: 0 };
const cam = { x: 0, y: 0, zoom: 1, follow: null, fit: null }; // follow: null | 'com' | body
const settings = {
  paused: false, trails: true, timeScale: 1, launch: 'planet',
  grid: false, autoOrbit: false, sound: true,
};
let energyBaseline = null;
let nextId = 1;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isStar = (m) => m >= STAR_MASS;
const isBH = (b) => b.kind === 'blackhole';
const shines = (b) => b.kind === 'rock' && isStar(b.m);

function radiusFor(m, kind = 'rock') {
  if (kind === 'blackhole') return Math.max(3, Math.cbrt(m) * 0.45);
  return Math.max(1.6, Math.cbrt(m) * 0.9);
}

function kindLabel(b) {
  if (isBH(b)) return 'Black hole';
  if (b.kind === 'comet') return 'Comet';
  if (isStar(b.m)) return 'Star';
  if (b.m >= 300) return 'Gas giant';
  if (b.m >= 10) return 'Planet';
  if (b.m >= 1) return 'Asteroid';
  return 'Moonlet';
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function defaultColor(m, kind) {
  if (kind === 'blackhole') return BH_COLOR;
  if (kind === 'comet') return COMET_COLOR;
  return isStar(m) ? pick(STAR_COLORS) : pick(PLANET_COLORS);
}

function addBody(x, y, vx, vy, m, color, kind = 'rock') {
  const b = {
    id: nextId++, x, y, vx, vy, ax: 0, ay: 0, m, kind,
    r: radiusFor(m, kind),
    color: color || defaultColor(m, kind),
    trail: [], dead: false, into: null,
  };
  world.bodies.push(b);
  accelerations(world.bodies, world.dust);
  energyBaseline = null;
  return b;
}

function removeBody(b) {
  b.dead = true;
  world.bodies = world.bodies.filter((o) => o !== b);
  if (cam.follow === b) cam.follow = null;
  accelerations(world.bodies, world.dust);
  energyBaseline = null;
  syncFollowButton();
}

function addDust(x, y, vx, vy, c, life = Infinity) {
  world.dust.push({ x, y, vx, vy, ax: 0, ay: 0, c, life });
}

// Position + velocity for a circular orbit of radius r around `center`.
function circular(center, r, angle, mass, dir = 1) {
  const v = Math.sqrt(G * mass / r);
  return {
    x: center.x + r * Math.cos(angle),
    y: center.y + r * Math.sin(angle),
    vx: (center.vx || 0) - dir * v * Math.sin(angle),
    vy: (center.vy || 0) + dir * v * Math.cos(angle),
  };
}

function dustDisk(center, mass, n, rMin, rMax, colorIdx, dir = 1) {
  for (let i = 0; i < n; i++) {
    const r = rMin + (rMax - rMin) * Math.random();
    const o = circular(center, r, Math.random() * Math.PI * 2, mass, dir);
    addDust(o.x, o.y, o.vx, o.vy, colorIdx);
  }
  accelerations(world.bodies, world.dust);
}

// The body whose pull dominates at (x, y): largest m / d². Optionally only
// bodies heavier than `minMass`, and never `exclude` itself.
function dominantAttractor(x, y, exclude = null, minMass = 0) {
  let best = null, bestPull = 0;
  for (const b of world.bodies) {
    if (b === exclude || b.m <= minMass) continue;
    const d2 = (b.x - x) ** 2 + (b.y - y) ** 2 + SOFT2;
    const pull = b.m / d2;
    if (pull > bestPull) { bestPull = pull; best = b; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sound (Web Audio, synthesised — no files)
// ---------------------------------------------------------------------------
const audio = { ctx: null, last: 0, noise: null };

function ensureAudio() {
  if (!settings.sound) return;
  try {
    if (!audio.ctx) {
      audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const len = audio.ctx.sampleRate * 0.6;
      audio.noise = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
      const data = audio.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
  } catch (_) {
    audio.ctx = null;
  }
}

function envGain(ac, t, peak, dur) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(ac.destination);
  return g;
}

// A thump whose pitch drops with mass; violent impacts add a noise crunch.
function soundImpact(mass, violent) {
  const ac = audio.ctx;
  if (!settings.sound || !ac || ac.state !== 'running') return;
  const t = ac.currentTime;
  if (t - audio.last < 0.07) return;
  audio.last = t;

  const f = clamp(900 / Math.cbrt(mass + 1), 45, 600);
  const o = ac.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f * 1.6, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.45, t + 0.4);
  o.connect(envGain(ac, t, violent ? 0.3 : 0.18, 0.5));
  o.start(t);
  o.stop(t + 0.55);

  if (violent) {
    const n = ac.createBufferSource();
    n.buffer = audio.noise;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = clamp(f * 4, 300, 2500);
    bp.Q.value = 0.8;
    n.connect(bp).connect(envGain(ac, t, 0.25, 0.45));
    n.start(t);
    n.stop(t + 0.5);
  }
}

function soundLaunch() {
  const ac = audio.ctx;
  if (!settings.sound || !ac || ac.state !== 'running') return;
  const t = ac.currentTime;
  const o = ac.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(380, t);
  o.frequency.exponentialRampToValueAtTime(900, t + 0.12);
  o.connect(envGain(ac, t, 0.07, 0.16));
  o.start(t);
  o.stop(t + 0.2);
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
function accelerations(bodies, dust) {
  const n = bodies.length;
  for (let i = 0; i < n; i++) { bodies[i].ax = 0; bodies[i].ay = 0; }
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy + SOFT2;
      const inv = G / (d2 * Math.sqrt(d2));
      a.ax += b.m * dx * inv; a.ay += b.m * dy * inv;
      b.ax -= a.m * dx * inv; b.ay -= a.m * dy * inv;
    }
  }
  if (!dust) return;
  for (let k = 0; k < dust.length; k++) {
    const p = dust[k];
    let ax = 0, ay = 0;
    for (let j = 0; j < n; j++) {
      const b = bodies[j];
      const dx = b.x - p.x, dy = b.y - p.y;
      const d2 = dx * dx + dy * dy + SOFT2;
      const inv = G * b.m / (d2 * Math.sqrt(d2));
      ax += dx * inv; ay += dy * inv;
    }
    p.ax = ax; p.ay = ay;
  }
}

// Kick-drift-kick leapfrog: symplectic, so orbits stay stable for a long time.
function leapfrog(bodies, dust, dt) {
  const h = dt / 2;
  for (const b of bodies) { b.vx += b.ax * h; b.vy += b.ay * h; b.x += b.vx * dt; b.y += b.vy * dt; }
  if (dust) for (const p of dust) { p.vx += p.ax * h; p.vy += p.ay * h; p.x += p.vx * dt; p.y += p.vy * dt; }
  accelerations(bodies, dust);
  for (const b of bodies) { b.vx += b.ax * h; b.vy += b.ay * h; }
  if (dust) for (const p of dust) { p.vx += p.ax * h; p.vy += p.ay * h; }
}

// Spray glowing, short-lived debris out of the impact site. Debris is massless
// (visual only), so mass and momentum are still conserved by the merge.
function shatter(big, small, vrel, vesc) {
  const nx = small.x - big.x, ny = small.y - big.y;
  const base = Math.atan2(ny, nx);
  const violence = Math.min(4, vrel / vesc);
  const count = clamp(Math.round(5 * Math.cbrt(small.m + 1) * violence), 8, 160);
  for (let i = 0; i < count; i++) {
    const a = base + (Math.random() - 0.5) * 2.4;
    const sp = vrel * (0.15 + Math.random() * 0.55);
    const off = big.r * 1.15 + Math.random() * 2;
    addDust(
      big.x + Math.cos(a) * off, big.y + Math.sin(a) * off,
      big.vx + Math.cos(a) * sp, big.vy + Math.sin(a) * sp,
      3, 40 + Math.random() * 100,
    );
  }
  world.flashes.push({ x: big.x, y: big.y, r: big.r, t: 0, color: '#ffb070', big: true });
}

// Perfectly inelastic merges: momentum and mass are conserved.
function resolveCollisions() {
  const bs = world.bodies;
  let merged = false;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (a.dead) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j];
      if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const rr = (a.r + b.r) * 0.85;
      if (dx * dx + dy * dy >= rr * rr) continue;

      // A black hole always wins, whatever the masses.
      let big, small;
      if (isBH(a) !== isBH(b)) [big, small] = isBH(a) ? [a, b] : [b, a];
      else [big, small] = a.m >= b.m ? [a, b] : [b, a];

      const vrel = Math.hypot(a.vx - b.vx, a.vy - b.vy);
      const vesc = Math.sqrt(2 * G * (a.m + b.m) / (a.r + b.r));
      const violent = !isBH(big) && vrel > SHATTER_FACTOR * vesc;
      if (violent) shatter(big, small, vrel, vesc);

      const m = big.m + small.m;
      big.x = (big.x * big.m + small.x * small.m) / m;
      big.y = (big.y * big.m + small.y * small.m) / m;
      big.vx = (big.vx * big.m + small.vx * small.m) / m;
      big.vy = (big.vy * big.m + small.vy * small.m) / m;
      if (big.kind === 'comet' && small.kind !== 'comet') big.kind = 'rock';
      if (big.kind === 'rock' && isStar(m) && !isStar(big.m)) big.color = pick(STAR_COLORS);
      if (big.kind === 'rock' && big.color === COMET_COLOR) big.color = pick(PLANET_COLORS);
      big.m = m;
      big.r = radiusFor(m, big.kind);
      small.dead = true;
      small.into = big;
      world.flashes.push({ x: big.x, y: big.y, r: big.r, t: 0, color: small.color });
      soundImpact(small.m, violent);
      merged = true;
      if (a.dead) break;
    }
  }
  if (!merged) return false;

  world.bodies = bs.filter((b) => !b.dead);
  if (cam.follow && cam.follow !== 'com' && cam.follow.dead) {
    let f = cam.follow;
    while (f.into) f = f.into;
    cam.follow = f;
  }
  energyBaseline = null; // merges lose energy by design; restart the drift meter
  return true;
}

function updateDust(dt) {
  const d = world.dust, bs = world.bodies;
  for (let i = d.length - 1; i >= 0; i--) {
    const p = d[i];
    p.life -= dt;
    let gone = p.life <= 0 || Math.abs(p.x) > 1e5 || Math.abs(p.y) > 1e5;
    for (let j = 0; !gone && j < bs.length; j++) {
      const b = bs[j];
      const dx = b.x - p.x, dy = b.y - p.y;
      if (dx * dx + dy * dy < b.r * b.r) gone = true;
    }
    if (gone) { d[i] = d[d.length - 1]; d.pop(); }
  }
}

function simulate(dt) {
  const sub = Math.max(4, Math.ceil(8 * settings.timeScale));
  const h = dt / sub;
  for (let s = 0; s < sub; s++) {
    leapfrog(world.bodies, world.dust, h);
    if (resolveCollisions()) accelerations(world.bodies, world.dust);
    updateDust(h);
  }
  world.time += dt;
}

function totalEnergy() {
  const bs = world.bodies;
  let e = 0;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    e += 0.5 * a.m * (a.vx * a.vx + a.vy * a.vy);
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      e -= G * a.m * b.m / Math.sqrt(dx * dx + dy * dy + SOFT2);
    }
  }
  return e;
}

function centreOfMass() {
  let m = 0, x = 0, y = 0, vx = 0, vy = 0;
  for (const b of world.bodies) { m += b.m; x += b.x * b.m; y += b.y * b.m; vx += b.vx * b.m; vy += b.vy * b.m; }
  return m ? { x: x / m, y: y / m, vx: vx / m, vy: vy / m } : { x: 0, y: 0, vx: 0, vy: 0 };
}

// Two-body orbital elements of `b` around its dominant heavier neighbour.
function orbitOf(b) {
  const host = dominantAttractor(b.x, b.y, b, b.m);
  if (!host) return null;
  const rx = b.x - host.x, ry = b.y - host.y;
  const vx = b.vx - host.vx, vy = b.vy - host.vy;
  const r = Math.hypot(rx, ry);
  const mu = G * (host.m + b.m);
  const eps = (vx * vx + vy * vy) / 2 - mu / r;
  const h = rx * vy - ry * vx;
  const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (mu * mu)));
  const bound = eps < 0;
  const a = bound ? -mu / (2 * eps) : Infinity;
  const period = bound ? 2 * Math.PI * Math.sqrt(a ** 3 / mu) : Infinity;
  return { host, r, e, bound, period };
}

// Run a throw-away copy of the system forward to show where a launch will go.
function predictPath(x, y, vx, vy, m, kind) {
  const ghosts = world.bodies.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, ax: 0, ay: 0, m: b.m, r: b.r }));
  const probe = { x, y, vx, vy, ax: 0, ay: 0, m, r: radiusFor(m, kind) };
  ghosts.push(probe);
  accelerations(ghosts, null);
  const n = ghosts.length;
  const steps = Math.min(600, Math.floor(200000 / (n * n)));
  const h = FRAME_DT / 4;
  const pts = [x, y];
  for (let s = 0; s < steps; s++) {
    leapfrog(ghosts, null, h);
    if (s % 3 === 0) pts.push(probe.x, probe.y);
    let hit = false;
    for (let j = 0; j < n - 1; j++) {
      const g = ghosts[j];
      const rr = (g.r + probe.r) * 0.85;
      if ((g.x - probe.x) ** 2 + (g.y - probe.y) ** 2 < rr * rr) { hit = true; break; }
    }
    if (hit) { pts.push(probe.x, probe.y); break; }
  }
  return pts;
}

// Where an auto-orbit click at (x, y) would put a body: circular orbit around
// whatever dominates gravity there.
function autoOrbitAt(x, y, m) {
  const host = dominantAttractor(x, y);
  if (!host) return { host: null, x, y, vx: 0, vy: 0 };
  const r = Math.hypot(x - host.x, y - host.y);
  if (r < host.r * 1.5) return null;
  const angle = Math.atan2(y - host.y, x - host.x);
  return { host, r, ...circular(host, r, angle, host.m + m) };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
function comet(host, r, speedFactor, angle) {
  const o = circular(host, r, angle, host.m);
  const k = speedFactor;
  addBody(o.x, o.y, host.vx + (o.vx - host.vx) * k, host.vy + (o.vy - host.vy) * k, 0.5, null, 'comet');
}

const PRESETS = {
  solar() {
    const sun = addBody(0, 0, 0, 0, 10000, '#fff1c4');
    const planets = [[70, 3], [110, 8], [160, 10], [225, 6], [380, 140], [520, 90]];
    for (const [r, m] of planets) {
      const o = circular(sun, r, Math.random() * Math.PI * 2, sun.m);
      const p = addBody(o.x, o.y, o.vx, o.vy, m);
      if (m === 140) {
        const moon = circular(p, 16, Math.random() * Math.PI * 2, p.m);
        addBody(moon.x, moon.y, moon.vx, moon.vy, 0.5, '#d9d9d9');
      }
    }
    dustDisk(sun, sun.m, 600, 255, 300, 2);
    comet(sun, 640, 0.42, Math.random() * Math.PI * 2);
    comet(sun, 700, 0.38, Math.random() * Math.PI * 2);
    return 560;
  },

  binary() {
    const m = 5000, d = 160;
    const v = Math.sqrt(G * m / (2 * d));
    addBody(-d / 2, 0, 0, -v, m, '#ffd27a');
    addBody(d / 2, 0, 0, v, m, '#cfe3ff');
    const centre = { x: 0, y: 0, vx: 0, vy: 0 };
    for (const [r, pm] of [[420, 20], [560, 40]]) {
      const o = circular(centre, r, Math.random() * Math.PI * 2, 2 * m);
      addBody(o.x, o.y, o.vx, o.vy, pm);
    }
    dustDisk(centre, 2 * m, 900, 280, 520, 0);
    return 600;
  },

  figure8() {
    // The Chenciner–Montgomery choreography: three equal masses chasing each
    // other around one figure-of-eight. Scaled from natural units (G=m=1).
    const L = 150, M = 2000, s = Math.sqrt(M / L);
    const p = [[0.97000436, -0.24308753], [-0.97000436, 0.24308753], [0, 0]];
    const v3 = [-0.93240737, -0.86473146];
    const v = [[-v3[0] / 2, -v3[1] / 2], [-v3[0] / 2, -v3[1] / 2], v3];
    const colors = ['#ff8fb1', '#8affc1', '#7cc6ff'];
    for (let i = 0; i < 3; i++) addBody(p[i][0] * L, p[i][1] * L, v[i][0] * s, v[i][1] * s, M, colors[i]);
    return 220;
  },

  galaxies() {
    const M = 15000;
    const a = addBody(-380, -140, 2.6, 0.4, M, '#cfe3ff');
    const b = addBody(380, 140, -2.6, -0.4, M, '#ffd9a0');
    dustDisk(a, M, 1100, 25, 200, 0, 1);
    dustDisk(b, M, 1100, 25, 200, 1, -1);
    return 650;
  },

  blackhole() {
    const bh = addBody(0, 0, 0, 0, 40000, null, 'blackhole');
    dustDisk(bh, bh.m, 1500, 45, 260, 1);
    for (const r of [360, 470]) {
      const o = circular(bh, r, Math.random() * Math.PI * 2, bh.m);
      addBody(o.x, o.y, o.vx, o.vy, 3000);
    }
    for (let i = 0; i < 4; i++) comet(bh, 650 + i * 40, 0.3 + i * 0.05, Math.random() * Math.PI * 2);
    return 620;
  },

  sandbox() {
    addBody(0, 0, 0, 0, 8000, '#fff1c4');
    return 450;
  },
};

function loadPreset(name) {
  world.bodies = [];
  world.dust = [];
  world.flashes = [];
  world.time = 0;
  cam.follow = null;
  cam.x = 0; cam.y = 0;
  const extent = PRESETS[name]();
  accelerations(world.bodies, world.dust);
  cam.fit = extent; // applied once the canvas has a real size (see fitPending)
  fitPending();
  energyBaseline = null;
  document.querySelectorAll('[data-preset]').forEach((el) => el.classList.toggle('active', el.dataset.preset === name));
  syncFollowButton();
}

// ---------------------------------------------------------------------------
// Camera & input
// ---------------------------------------------------------------------------
const toWorld = (sx, sy) => ({ x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y });

function frameVelocity() {
  if (cam.follow === 'com') { const c = centreOfMass(); return { vx: c.vx, vy: c.vy }; }
  if (cam.follow) return { vx: cam.follow.vx, vy: cam.follow.vy };
  return { vx: 0, vy: 0 };
}

// Launch is measured in screen space, so it feels right even while the camera
// is following a moving body; the launched body inherits that frame's velocity.
function launchParams(d, mx, my) {
  const start = toWorld(d.sx, d.sy);
  const fv = frameVelocity();
  return {
    x: start.x, y: start.y,
    vx: fv.vx + ((d.sx - mx) / cam.zoom) * LAUNCH_K,
    vy: fv.vy + ((d.sy - my) / cam.zoom) * LAUNCH_K,
  };
}

function fitPending() {
  if (!cam.fit || W <= 0 || H <= 0) return;
  cam.zoom = clamp(Math.min(W, H) / (2 * cam.fit), 0.03, 30);
  cam.fit = null;
}

function updateCamera() {
  fitPending();
  let target = null;
  if (cam.follow === 'com') target = centreOfMass();
  else if (cam.follow) target = cam.follow;
  if (!target) return;
  cam.x += (target.x - cam.x) * 0.25;
  cam.y += (target.y - cam.y) * 0.25;
}

function bodyAt(sx, sy) {
  const w = toWorld(sx, sy);
  let best = null, bestD = Infinity;
  for (const b of world.bodies) {
    const d = Math.hypot(b.x - w.x, b.y - w.y);
    const reach = Math.max(b.r, 10 / cam.zoom);
    if (d < reach && d < bestD) { best = b; bestD = d; }
  }
  return best;
}

function launch(x, y, vx, vy) {
  const t = LAUNCH_TYPES[settings.launch];
  addBody(x, y, vx, vy, t.m, null, t.kind);
  soundLaunch();
}

let drag = null;
const mouse = { x: 0, y: 0, inside: false };

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  canvas.setPointerCapture(e.pointerId);
  mouse.x = e.clientX; mouse.y = e.clientY;
  const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
  if (pan) drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: 0 };
  else if (e.button === 0) drag = { mode: 'launch', sx: e.clientX, sy: e.clientY, moved: 0 };
});

canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
  if (!drag) return;
  drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy));
  if (drag.mode === 'pan') {
    if (cam.follow) { cam.follow = null; syncFollowButton(); drag.cx = cam.x; drag.cy = cam.y; drag.sx = e.clientX; drag.sy = e.clientY; }
    cam.x = drag.cx - (e.clientX - drag.sx) / cam.zoom;
    cam.y = drag.cy - (e.clientY - drag.sy) / cam.zoom;
  }
});

canvas.addEventListener('pointerleave', () => { mouse.inside = false; });

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.mode === 'launch') {
    if (drag.moved >= 5) {
      const p = launchParams(drag, e.clientX, e.clientY);
      launch(p.x, p.y, p.vx, p.vy);
    } else {
      const b = bodyAt(e.clientX, e.clientY);
      if (b) {
        cam.follow = b;
      } else if (settings.autoOrbit) {
        const w = toWorld(e.clientX, e.clientY);
        const o = autoOrbitAt(w.x, w.y, LAUNCH_TYPES[settings.launch].m);
        if (o) launch(o.x, o.y, o.vx, o.vy);
      } else {
        cam.follow = null;
      }
      syncFollowButton();
    }
  }
  drag = null;
});

canvas.addEventListener('pointercancel', () => { drag = null; });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), 0.03, 30);
  if (!cam.follow) {
    const after = toWorld(e.clientX, e.clientY);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// Toolbar, inspector & keyboard
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const btnPause = $('btn-pause');
const btnFollow = $('btn-follow');
const btnOrbit = $('btn-orbit');
const btnSound = $('btn-sound');
const speed = $('speed');
const speedVal = $('speed-val');
const trails = $('trails');
const gridBox = $('grid');
const inspector = $('inspector');

function setPaused(p) { settings.paused = p; btnPause.textContent = p ? 'Play' : 'Pause'; btnPause.classList.toggle('active', p); }
function setSpeed(v) { settings.timeScale = clamp(Math.round(v * 10) / 10, 0.1, 4); speed.value = settings.timeScale; speedVal.textContent = settings.timeScale.toFixed(1) + '×'; }
function setTrails(on) { settings.trails = on; trails.checked = on; if (!on) world.bodies.forEach((b) => { b.trail.length = 0; }); }
function setGrid(on) { settings.grid = on; gridBox.checked = on; }
function setAutoOrbit(on) { settings.autoOrbit = on; btnOrbit.classList.toggle('active', on); }
function setSound(on) { settings.sound = on; btnSound.textContent = on ? 'Sound on' : 'Sound off'; btnSound.classList.toggle('active', on); if (on) ensureAudio(); }
function setLaunch(type) { settings.launch = type; document.querySelectorAll('[data-launch]').forEach((el) => el.classList.toggle('active', el.dataset.launch === type)); }
function syncFollowButton() { btnFollow.classList.toggle('active', cam.follow === 'com'); }
function toggleFollowCom() { cam.follow = cam.follow === 'com' ? null : 'com'; syncFollowButton(); }
function clearAll() { world.bodies = []; world.dust = []; world.flashes = []; cam.follow = null; syncFollowButton(); energyBaseline = null; }

document.querySelectorAll('[data-preset]').forEach((el) => el.addEventListener('click', () => loadPreset(el.dataset.preset)));
document.querySelectorAll('[data-launch]').forEach((el) => el.addEventListener('click', () => setLaunch(el.dataset.launch)));
btnPause.addEventListener('click', () => setPaused(!settings.paused));
btnFollow.addEventListener('click', toggleFollowCom);
btnOrbit.addEventListener('click', () => setAutoOrbit(!settings.autoOrbit));
btnSound.addEventListener('click', () => setSound(!settings.sound));
$('btn-clear').addEventListener('click', clearAll);
$('btn-delete').addEventListener('click', () => { if (cam.follow && cam.follow !== 'com') removeBody(cam.follow); });
$('btn-unfollow').addEventListener('click', () => { cam.follow = null; syncFollowButton(); });
speed.addEventListener('input', () => setSpeed(Number(speed.value)));
trails.addEventListener('change', () => setTrails(trails.checked));
gridBox.addEventListener('change', () => setGrid(gridBox.checked));

// Keep buttons from stealing the keyboard shortcuts after a click.
document.querySelectorAll('button, input').forEach((el) => el.addEventListener('mouseup', () => el.blur()));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  ensureAudio();
  const presetKeys = { '1': 'solar', '2': 'binary', '3': 'figure8', '4': 'galaxies', '5': 'blackhole', '6': 'sandbox' };
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); setPaused(!settings.paused); }
  else if (k === 't') setTrails(!settings.trails);
  else if (k === 'f') toggleFollowCom();
  else if (k === 'c') clearAll();
  else if (k === 'g') setGrid(!settings.grid);
  else if (k === 'o') setAutoOrbit(!settings.autoOrbit);
  else if (k === 'm') setSound(!settings.sound);
  else if (k === '+' || k === '=') setSpeed(settings.timeScale + 0.2);
  else if (k === '-' || k === '_') setSpeed(settings.timeScale - 0.2);
  else if (k === 'delete' || k === 'backspace') { if (cam.follow && cam.follow !== 'com') removeBody(cam.follow); }
  else if (k === 'escape') { drag = null; cam.follow = null; syncFollowButton(); }
  else if (presetKeys[e.key]) loadPreset(presetKeys[e.key]);
});

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : '∞');

function updateInspector() {
  const b = cam.follow;
  if (!b || b === 'com' || b.dead) { inspector.hidden = true; return; }
  inspector.hidden = false;
  $('insp-dot').style.background = isBH(b) ? '#000' : b.color;
  $('insp-dot').style.boxShadow = `0 0 8px ${b.color}`;
  $('insp-kind').textContent = kindLabel(b);
  $('insp-mass').textContent = fmt(b.m, 1);
  $('insp-radius').textContent = fmt(b.r, 1);
  const o = orbitOf(b);
  if (!o) {
    $('insp-speed').textContent = fmt(Math.hypot(b.vx, b.vy), 2);
    $('insp-host').textContent = 'nothing (heaviest here)';
    $('insp-dist').textContent = '–';
    $('insp-ecc').textContent = '–';
    $('insp-period').textContent = '–';
    return;
  }
  $('insp-speed').textContent = fmt(Math.hypot(b.vx - o.host.vx, b.vy - o.host.vy), 2) + ' rel.';
  $('insp-host').textContent = `${kindLabel(o.host)} #${o.host.id}`;
  $('insp-dist').textContent = fmt(o.r, 0);
  $('insp-ecc').textContent = o.bound ? o.e.toFixed(3) + (o.e < 0.05 ? ' (circular)' : o.e > 0.7 ? ' (very elongated)' : '') : 'escaping';
  $('insp-period').textContent = o.bound ? fmt(o.period, 0) : '–';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const BG_STARS = Array.from({ length: 380 }, () => ({
  x: Math.random(), y: Math.random(), s: Math.random() * 1.2 + 0.3, a: Math.random() * 0.55 + 0.15,
}));

function drawBackground() {
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  for (const s of BG_STARS) {
    const px = ((s.x * W - cam.x * 0.02 * s.s) % W + W) % W;
    const py = ((s.y * H - cam.y * 0.02 * s.s) % H + H) % H;
    ctx.fillStyle = `rgba(220,230,255,${s.a})`;
    ctx.fillRect(px, py, s.s, s.s);
  }
}

// A rubber-sheet picture of gravity: grid points are pulled toward each mass,
// falling off with distance and never past the mass itself.
function drawGrid() {
  if (!settings.grid) return;
  const step = 34 / cam.zoom;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const x0 = Math.floor(tl.x / step) * step - step, y0 = Math.floor(tl.y / step) * step - step;
  const cols = Math.ceil((br.x - x0) / step) + 2, rows = Math.ceil((br.y - y0) / step) + 2;
  const px = new Float32Array(cols * rows), py = new Float32Array(cols * rows);
  const soft = 25 / cam.zoom;
  const bs = world.bodies;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = x0 + i * step, y = y0 + j * step;
      let dx = 0, dy = 0;
      for (let k = 0; k < bs.length; k++) {
        const b = bs[k];
        const ox = b.x - x, oy = b.y - y;
        const d = Math.hypot(ox, oy) + 1e-6;
        const pull = Math.min(d * 0.8, (GRID_K * b.m) / (d + soft));
        dx += (ox / d) * pull; dy += (oy / d) * pull;
      }
      px[j * cols + i] = x + dx;
      py[j * cols + i] = y + dy;
    }
  }
  ctx.strokeStyle = 'rgba(110,150,255,0.2)';
  ctx.lineWidth = 1 / cam.zoom;
  ctx.beginPath();
  for (let j = 0; j < rows; j++) {
    ctx.moveTo(px[j * cols], py[j * cols]);
    for (let i = 1; i < cols; i++) ctx.lineTo(px[j * cols + i], py[j * cols + i]);
  }
  for (let i = 0; i < cols; i++) {
    ctx.moveTo(px[i], py[i]);
    for (let j = 1; j < rows; j++) ctx.lineTo(px[j * cols + i], py[j * cols + i]);
  }
  ctx.stroke();
}

function drawTrails() {
  if (!settings.trails) return;
  ctx.lineWidth = 1.2 / cam.zoom;
  ctx.lineCap = 'round';
  const SEG = 5;
  for (const b of world.bodies) {
    const t = b.trail;
    if (t.length < 4) continue;
    const pts = t.length / 2;
    const chunk = Math.ceil(pts / SEG);
    ctx.strokeStyle = b.color;
    for (let k = 0; k < SEG; k++) {
      const from = k * chunk, to = Math.min(pts - 1, (k + 1) * chunk);
      if (to <= from) continue;
      ctx.globalAlpha = 0.06 + 0.5 * ((k + 1) / SEG) ** 2;
      ctx.beginPath();
      ctx.moveTo(t[from * 2], t[from * 2 + 1]);
      for (let i = from + 1; i <= to; i++) ctx.lineTo(t[i * 2], t[i * 2 + 1]);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawDust() {
  const d = world.dust;
  if (!d.length) return;
  const size = Math.max(1.4 / cam.zoom, 0.6);
  ctx.globalCompositeOperation = 'lighter';
  for (let c = 0; c < DUST_COLORS.length; c++) {
    ctx.fillStyle = DUST_COLORS[c];
    const s = c === 3 ? size * 1.4 : size;
    for (let i = 0; i < d.length; i++) {
      const p = d[i];
      if (p.c === c) ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Comets get two tails: a straight blue ion tail pointing directly away from
// the brightest nearby star, and a curved yellow dust tail lagging the orbit.
function drawCometTails() {
  for (const b of world.bodies) {
    if (b.kind !== 'comet') continue;
    let sun = null, best = 0;
    for (const s of world.bodies) {
      if (!shines(s)) continue;
      const pull = s.m / ((s.x - b.x) ** 2 + (s.y - b.y) ** 2 + 1);
      if (pull > best) { best = pull; sun = s; }
    }
    if (!sun) continue;
    const dx = b.x - sun.x, dy = b.y - sun.y;
    const d = Math.hypot(dx, dy) || 1;
    const len = clamp(9000 * Math.sqrt(sun.m / 10000) / d, 4, 120);
    const ux = dx / d, uy = dy / d;
    const sp = Math.hypot(b.vx - sun.vx, b.vy - sun.vy) || 1;
    const wx = -(b.vx - sun.vx) / sp, wy = -(b.vy - sun.vy) / sp;

    const tails = [
      { ex: b.x + ux * len, ey: b.y + uy * len, col: '#9fdcff', w: 1.6 },
      { ex: b.x + (ux * 0.6 + wx * 0.4) * len * 0.75, ey: b.y + (uy * 0.6 + wy * 0.4) * len * 0.75, col: '#ffe6a8', w: 2.6 },
    ];
    ctx.globalCompositeOperation = 'lighter';
    for (const t of tails) {
      const g = ctx.createLinearGradient(b.x, b.y, t.ex, t.ey);
      g.addColorStop(0, hexA(t.col, 0.75));
      g.addColorStop(1, hexA(t.col, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = t.w / cam.zoom;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(t.ex, t.ey);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawBlackHole(b, minR) {
  const r = Math.max(b.r, minR * 2);
  const spin = world.time * 0.04;
  ctx.globalCompositeOperation = 'lighter';
  // Accretion glow
  const g = ctx.createRadialGradient(b.x, b.y, r * 1.1, b.x, b.y, r * 6);
  g.addColorStop(0, 'rgba(255,190,120,0.55)');
  g.addColorStop(0.35, 'rgba(255,120,60,0.18)');
  g.addColorStop(1, 'rgba(255,90,40,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 6, 0, Math.PI * 2);
  ctx.fill();
  // Swirling arcs
  for (let i = 0; i < 5; i++) {
    const rad = r * (1.5 + i * 0.55);
    const start = spin * (1.6 - i * 0.2) + i * 1.3;
    ctx.strokeStyle = `rgba(255,${200 - i * 25},${140 - i * 20},${0.5 - i * 0.07})`;
    ctx.lineWidth = (2.2 - i * 0.3) / cam.zoom;
    ctx.beginPath();
    ctx.arc(b.x, b.y, rad, start, start + 1.4 + i * 0.3);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  // Event horizon and photon ring
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,220,170,0.9)';
  ctx.lineWidth = 1.4 / cam.zoom;
  ctx.stroke();
}

function drawBodies() {
  const minR = 1.5 / cam.zoom;
  ctx.globalCompositeOperation = 'lighter';
  for (const b of world.bodies) {
    if (isBH(b)) continue;
    const glowR = Math.max(shines(b) ? b.r * 4.5 : b.r * 2.2, minR * 3);
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, glowR);
    g.addColorStop(0, hexA(b.color, shines(b) ? 0.9 : 0.45));
    g.addColorStop(0.3, hexA(b.color, shines(b) ? 0.3 : 0.12));
    g.addColorStop(1, hexA(b.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const b of world.bodies) {
    if (isBH(b)) { drawBlackHole(b, minR); continue; }
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, Math.max(b.r, minR), 0, Math.PI * 2);
    ctx.fill();
  }
  if (cam.follow && cam.follow !== 'com') {
    const b = cam.follow;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1 / cam.zoom;
    ctx.setLineDash([3 / cam.zoom, 3 / cam.zoom]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, Math.max(b.r, minR) + 6 / cam.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawFlashes() {
  world.flashes = world.flashes.filter((f) => f.t < 40);
  for (const f of world.flashes) {
    const k = f.t / 40;
    const grow = f.big ? 90 : 40;
    ctx.strokeStyle = hexA(f.color, 1 - k);
    ctx.lineWidth = ((f.big ? 4 : 2.5) * (1 - k) + 0.5) / cam.zoom;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r + (k * grow) / cam.zoom, 0, Math.PI * 2);
    ctx.stroke();
    f.t++;
  }
}

function drawScreenText(text, x, y, color) {
  ctx.save();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = color;
  ctx.font = '12px -apple-system, sans-serif';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawLaunchPreview() {
  const type = LAUNCH_TYPES[settings.launch];
  const ghostR = Math.max(radiusFor(type.m, type.kind), 2 / cam.zoom);

  // Auto-orbit hover: show the circle the body would be placed on.
  if (!drag && settings.autoOrbit && mouse.inside && !bodyAt(mouse.x, mouse.y)) {
    const w = toWorld(mouse.x, mouse.y);
    const o = autoOrbitAt(w.x, w.y, type.m);
    if (o && o.host) {
      ctx.strokeStyle = 'rgba(140,255,200,0.55)';
      ctx.lineWidth = 1 / cam.zoom;
      ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
      ctx.beginPath();
      ctx.arc(o.host.x, o.host.y, o.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(140,255,200,0.8)';
      ctx.beginPath();
      ctx.arc(w.x, w.y, ghostR, 0, Math.PI * 2);
      ctx.fill();
      drawScreenText(`orbit ${kindLabel(o.host).toLowerCase()} · r = ${o.r.toFixed(0)}`, mouse.x + 12, mouse.y - 10, 'rgba(140,255,200,0.9)');
    }
    return;
  }

  if (!drag || drag.mode !== 'launch' || drag.moved < 5) return;
  const p = launchParams(drag, mouse.x, mouse.y);
  const end = toWorld(mouse.x, mouse.y);

  // Slingshot band
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1 / cam.zoom;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  // Predicted trajectory
  const pts = predictPath(p.x, p.y, p.vx, p.vy, type.m, type.kind);
  ctx.strokeStyle = 'rgba(255,225,140,0.75)';
  ctx.lineWidth = 1.3 / cam.zoom;
  ctx.setLineDash([5 / cam.zoom, 5 / cam.zoom]);
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Ghost of the body to be launched
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, ghostR, 0, Math.PI * 2);
  ctx.fill();

  const fv = frameVelocity();
  drawScreenText(`v = ${Math.hypot(p.vx - fv.vx, p.vy - fv.vy).toFixed(2)}`, mouse.x + 12, mouse.y - 10, 'rgba(255,225,140,0.9)');
}

function draw() {
  drawBackground();
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  drawGrid();
  drawTrails();
  drawDust();
  drawCometTails();
  drawBodies();
  drawFlashes();
  drawLaunchPreview();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// HUD & main loop
// ---------------------------------------------------------------------------
let hudTimer = 0, frames = 0, fps = 0;

function updateHud(now) {
  frames++;
  if (now - hudTimer < 250) return;
  fps = (frames * 1000) / (now - hudTimer);
  frames = 0;
  hudTimer = now;
  $('stat-bodies').textContent = world.bodies.length;
  $('stat-dust').textContent = world.dust.length.toLocaleString();
  $('stat-time').textContent = world.time.toFixed(0);
  $('stat-fps').textContent = fps.toFixed(0);
  const e = totalEnergy();
  if (energyBaseline === null || world.bodies.length < 2) {
    energyBaseline = e;
    $('stat-energy').textContent = world.bodies.length < 2 ? '–' : '0.000%';
  } else {
    const drift = energyBaseline ? ((e - energyBaseline) / Math.abs(energyBaseline)) * 100 : 0;
    $('stat-energy').textContent = (drift >= 0 ? '+' : '') + drift.toFixed(3) + '%';
  }
  updateInspector();
}

let last = performance.now();
function frame(now) {
  const scale = clamp((now - last) / (1000 / 60), 0, 3); // frame-rate independent
  last = now;
  if (!settings.paused) {
    simulate(FRAME_DT * settings.timeScale * scale);
    if (settings.trails) {
      for (const b of world.bodies) {
        b.trail.push(b.x, b.y);
        if (b.trail.length > TRAIL_LEN * 2) b.trail.splice(0, 2);
      }
    }
  }
  updateCamera();
  draw();
  updateHud(now);
  requestAnimationFrame(frame);
}

setLaunch('planet');
setSpeed(1);
setSound(true);
loadPreset('solar');
requestAnimationFrame(frame);
