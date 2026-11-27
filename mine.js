'use strict';
// Dwarfwatch mine: a small tile-based game engine that shows Claude sessions as dwarves.
// Fixed-step loop, tile map, BFS pathfinding with ladders, cached pixel sprites, particles
// and 2D lighting. The page calls Mine.init(container, { onSelect }) once and Mine.sync(state)
// on every poll.
//
// The world: a lodge and a shaft on the surface. Each session owns a gallery that branches off
// the shaft, alternating left and right, two per level. Its lead dwarf digs the gallery face
// (its length is a log scale of the session's tool calls), its subagents break boulders
// behind it, and ore flies into the gallery's cart. When a session needs input, its lead climbs
// out and waits on the surface. A subsession (a session started by another running session) does
// not open onto the main shaft: its gallery hangs below its parent's, on the same side, reached by
// a side shaft with a ladder down from the parent's gallery.

(() => {
  // ---- constants ----------------------------------------------------------------------
  const TILE = 10;
  const GRASS = 6;              // grass row; the rows above are sky
  const LEVEL_TOP = 9;          // top row of the first tunnel level
  const LEVEL_STRIDE = 5;       // 3 rows of tunnel + 2 rows of rock
  const STEP = 1 / 60;
  const WALK = 96, CLIMB = 72;  // world px per second
  const SPAWN_GAP = 0.7;        // seconds between dwarves leaving the lodge
  const GRACE_POLLS = 3;        // a session or agent must be missing this many polls in a row before its dwarf leaves
  const SWING = 0.9, IMPACT = 0.68;
  const FACE_HP = 4, BOULDER_HP = 3;
  const MIN_LEN = 4;
  const SKY_STEPS = 6;          // flat colours in the sky gradient (and the dusk glow), dithered where they meet
  const CART_FULL = 12;          // lumps in a full cart: then the windlass hauls it up to the ore store
  const GNOME_SPACE = 2 * TILE; // px between gnomes when the tunnel has room (a gnome is 8 wide)
  const CALLS_FULL = 1500;      // tool calls at which a tunnel reaches the edge of the scene
  const SIDE_SHAFT = 3;         // tiles from a gallery's entrance to the side shaft down to its subsessions

  const T = { SKY: 0, GRASS: 1, DIRT: 2, ROCK: 3, TUNNEL: 4, LADDER: 5 };
  const TIERS = {
    wood: ['#b07a45', '#6e4622'], copper: ['#d9803f', '#8a4520'], iron: ['#c3cbd4', '#66707b'],
    gold: ['#f5c531', '#9c7710'], diamond: ['#7cf0f7', '#1f9fb0'],
  };
  const TIER_NAMES = { wood: 'Wood', copper: 'Copper', iron: 'Iron', gold: 'Gold', diamond: 'Diamond' };
  const TUNICS = { lead: '#5d5048', Explore: '#3f7d4e', 'general-purpose': '#3b5f9e', Plan: '#6b4a9a' };
  // What each kind of subagent gnome carries: explorers dig, general-purpose helpers light the way,
  // planners carry the sack. Only pickaxe gnomes break boulders.
  const GNOME_PROPS = { Explore: 'pick', 'general-purpose': 'lantern', Plan: 'sack' };
  const BEARDS = ['#c96e26', '#c96e26', '#a8522a', '#8b5a2b', '#d9a441', '#bdb7ad', '#3a2a20']; // mostly ginger
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // The lead dwarf, 10 x 15 pixels, facing right (mirrored to walk left): a dark miner's helmet with a
  // grey lamp housing and a lamp, a grey brim, eyes and a nose under it, a big orange beard with darker
  // shading, grey-brown arms with the hands low, a hem band, and legs in three frames. The pickaxe is
  // drawn separately, so it can swing and show the model's tier.
  const BODY = [
    '.....qq...',
    '...HhLlq..',
    '..HHHYYH..',
    '..HhhhhhH.',
    '..BseseB..',
    '..BBbubB..', // the nose (u: a little redder than the skin), under and between the eyes
    '..BbbBBbB.',
    '.TTBbbbbT.',
    'TtTBbbbbBT', // one extra row of arms and beard, to make the dwarf a little taller than the original
    'TtTTBbbBtT',
    'TSSTTBBTST',
    '.TTkkkkkT.',
  ];
  const LEGS = { // trousers, then boots
    A: ['..pp..pp..', '..oo..oo..', '..xx..xx..'],
    B: ['..pp..pp..', '.oo....oo.', '.xx....xx.'],
    C: ['..pp..pp..', '..oo..oo..', '..xx......'],
  };
  // 8 x 12 pixel gnome for subagents, drawn in the same style as the dwarf but smaller: a pointy hat
  // leaning forward with a darker band, two eyes and a light nose over a pale beard, arms in the
  // agent-type tunic with the hands low, a belt with a buckle, and dark boots.
  // (a tall hat with a wide brim, a rosy nose and a black belt with a gold buckle)
  const GNOME = [
    '....r...',
    '...rr...',
    '...rrr..',
    '..rrrrR.',
    '.RRRRRRR',
    '.bsesesb',
    '.bbsnsbb',
    '.Bbbbbbb',
    'TtBbbbbT',
    'STtbbbtS',
    '.TKKgKKT',
  ];
  const GNOME_LEGS = {
    A: ['.oo..oo.', '.xx..xx.'],
    B: ['oo....oo', 'xx....xx'],
    C: ['.oo..oo.', '.xx.....'],
  };
  const GNOME_BEARDS = ['#eee8dc', '#ddd6cb', '#c9c2b6', '#e8d9b0'];
  // Sprite geometry: size, foot anchor x, shoulder (pickaxe pivot), handle length, pick head half-width, lamp radius.
  const SPECS = {
    dwarf: { name: 'dwarf', body: BODY, legs: LEGS, w: 10, h: 15, ax: 4, sx: 8.5, sy: 9.5, handle: 9, head: 3, lamp: 22, eye: [6, 4] },
    gnome: { name: 'gnome', body: GNOME, legs: GNOME_LEGS, w: 8, h: 13, ax: 3, sx: 6.5, sy: 8.5, handle: 7, head: 3, lamp: 16, eye: [5, 5] },
  };
  // ---- names ----
  // Every dwarf gets a name in the old dwarven style: a hard, Norse-sounding first name and a surname
  // from stone, forge and beard. Gnomes get small tinkerer names. Built from parts, picked by a hash of
  // the session or agent id, so the same session always has the same dwarf.
  const NAME_PARTS = {
    first: ['Bal', 'Dor', 'Gor', 'Thra', 'Brom', 'Dur', 'Kar', 'Mor', 'Grim', 'Har', 'Bar', 'Dag', 'Gund', 'Hro', 'Nor', 'Rur', 'Skal', 'Ulf', 'Vor', 'Bof', 'Thur', 'Kaz', 'Drom', 'Hel'],
    end: ['in', 'ak', 'grim', 'dur', 'rik', 'li', 'mar', 'nar', 'ok', 'ri', 'um', 'bek', 'rand', 'gar', 'on'],
    sur1: ['Iron', 'Stone', 'Granite', 'Coal', 'Copper', 'Anvil', 'Hammer', 'Ember', 'Flint', 'Deep', 'Gold', 'Bronze', 'Forge', 'Rune', 'Frost', 'Ale', 'Slate', 'Cinder', 'Boulder', 'Oak'],
    sur2: ['beard', 'fist', 'helm', 'brow', 'foot', 'delve', 'braid', 'mantle', 'shield', 'hand', 'vein', 'axe', 'barrel', 'mug', 'belly', 'grip'],
    gnome: ['Pip', 'Tink', 'Fizz', 'Nob', 'Wizzle', 'Bix', 'Glim', 'Dabble', 'Pocket', 'Sprock', 'Nim', 'Twiddle'],
    gnomeEnd: ['bolt', 'cog', 'sprocket', 'whistle', 'spark', 'gear', 'button', 'wick', 'thimble', 'kettle'],
  };
  const pick = (list, h) => list[h % list.length];
  const leadKey = (s) => 'lead:' + (s.dwarf ? s.dwarf.id : s.id);
  const nameKey = (s) => (s.dwarf ? s.dwarf.id : s.id);
  // drawn every frame, so each name is made once per id (bounded: the cache starts over past 500)
  const memo = (fn) => {
    const cache = new Map();
    return (id) => {
      let v = cache.get(id);
      if (v === undefined) { if (cache.size > 500) cache.clear(); v = fn(id); cache.set(id, v); }
      return v;
    };
  };
  const dwarfName = memo(function (id) {
    const h = strHash('dwarf:' + id);
    const first = pick(NAME_PARTS.first, h);
    let end = pick(NAME_PARTS.end, h >>> 5);
    if (end === first.toLowerCase()) end = pick(NAME_PARTS.end, (h >>> 5) + 1); // no "Grimgrim"
    return first + end + ' ' + pick(NAME_PARTS.sur1, h >>> 10) + pick(NAME_PARTS.sur2, h >>> 16);
  });
  const gnomeName = memo(function (id) {
    const h = strHash('gnome:' + id);
    const first = pick(NAME_PARTS.gnome, h);
    let family = pick(NAME_PARTS.gnome, h >>> 7);
    if (family === first) family = pick(NAME_PARTS.gnome, (h >>> 7) + 1);
    return first + ' ' + family + pick(NAME_PARTS.gnomeEnd, h >>> 13);
  });

  const strikeReach = (sp) => sp.sx - sp.ax + sp.handle * 0.9; // how far in front of the feet the pick lands
  const CRACKS = [[5, 1], [4, 2], [5, 3], [6, 4], [5, 5], [4, 6], [3, 7], [6, 5], [7, 6], [2, 8], [5, 7], [8, 7]];

  // ---- helpers ------------------------------------------------------------------------
  const rand01 = (x, y, seed) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const strHash = (text) => {
    let h = 2166136261;
    for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  };
  const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  // busy: working. ready: idle and its last reply asked you something. done: idle, nothing asked.
  // A session with no transcript yet has asked nothing, so it counts as done.
  const stateOf = (s) => (s.status === 'busy' ? 'busy' : s.turn && s.turn.asked ? 'ready' : 'done');
  const shortModel = (m) => String(m || '').replace(/^claude-/, '') || 'unknown model';
  const priceText = (p) => (!p || p.input == null ? 'price unknown'
    : `$${p.input} in / $${p.output} out per 1M tokens${p.fast ? ', fast mode' : ''}`);
  const COMPACTING = 'Compacting the conversation';
  // What a dwarf does at the face for each kind of tool call. Anything not listed swings the pick.
  const ACTS = [
    [/^(Read|Grep|Glob|LS|NotebookRead|ToolSearch)$/, 'inspect'],    // holds up a lantern to look at the rock
    [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'chisel'],              // hammer and chisel
    [/^(Bash|PowerShell|BashOutput|KillShell|Monitor)$/, 'cart'],     // pushes an ore cart
    [/^(WebFetch|WebSearch)$|Browser|chrome/i, 'scout'],              // looks ahead through a spyglass
    [/^(Agent|Task|SendMessage|Workflow)$/, 'call'],                  // waves the gnomes in
  ];
  const actOf = (a) => {
    if (!a || (a.kind !== 'tool' && a.kind !== 'compacting')) return 'think';
    const hit = a.kind === 'tool' && ACTS.find(([re]) => re.test(a.tool || ''));
    return hit ? hit[1] : 'dig';
  };
  // seconds per loop of each working animation; once per loop the lead's work counts towards the tunnel
  const WORK = { dig: SWING, chisel: 0.4, inspect: 1.6, cart: 1.3, scout: 2.4, call: 0.8 };
  const stepText = (a) => (!a || !a.kind ? 'Working' : a.kind === 'tool'
    ? a.tool + (a.detail ? ': ' + a.detail : '') : a.kind === 'thinking' ? 'Thinking' : a.kind === 'compacting' ? COMPACTING : 'Writing');
  const greyOf = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const l = Math.round((((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) * 0.8);
    return `rgb(${l},${l},${l})`;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  // ---- day and night ----
  // Daylight follows the working day (local time). Outside these windows, and in the breaks between
  // them, it is night. Each change fades over FADE_MIN minutes, centred on the time given. Both can be
  // changed in the Day & night panel (Mine.setSchedule); with no windows at all it is always night.
  const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], windows: [['08:00', '12:00'], ['12:30', '16:15']] };
  let DAYLIGHT = DEFAULT_SCHEDULE.windows;
  let WORK_DAYS = DEFAULT_SCHEDULE.days; // Monday to Friday; other days stay night
  const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
  // Takes { days: [0-6], windows: [['HH:MM', 'HH:MM'], ...] }; windows are sorted, and any that are
  // empty, back to front or overlapping the one before are dropped. Returns what it applied.
  function setSchedule(sched) {
    const days = Array.isArray(sched && sched.days) ? [...new Set(sched.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : DEFAULT_SCHEDULE.days;
    const windows = [];
    for (const w of (Array.isArray(sched && sched.windows) ? sched.windows : DEFAULT_SCHEDULE.windows)
      .filter((w) => Array.isArray(w) && HM.test(w[0]) && HM.test(w[1]) && toMin(w[0]) < toMin(w[1]))
      .sort((a, b) => toMin(a[0]) - toMin(b[0]))) {
      if (!windows.length || toMin(w[0]) > toMin(windows[windows.length - 1][1])) windows.push([w[0], w[1]]);
    }
    DAYLIGHT = windows; WORK_DAYS = days;
    return { days, windows };
  }
  const FADE_MIN = 10;  // the lunch break: a quick fade, the sun can't set at noon
  const DAWN_MIN = 40;  // morning and evening: the sun rises from, and sinks behind, the mountains
  const DUSK_MIN = 40;
  const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  let clockOverride = null; // minutes past midnight on a work day, for testing: Mine.setTime('12:03')
  function clockMinutes() {
    const now = new Date();
    return clockOverride ?? now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  }
  function daylight() {
    if (!DAYLIGHT.length || (clockOverride === null && !WORK_DAYS.includes(new Date().getDay()))) return 0;
    const t = clockMinutes();
    let level = 0;
    DAYLIGHT.forEach(([from, to], i) => {
      // Sunrise and sunset are centred on their times. Around a break the fade happens inside the
      // daylight window instead, so the whole break is night: dark by 12:00, light again from 12:30.
      const first = i === 0, last = i === DAYLIGHT.length - 1;
      const fadeIn = first ? DAWN_MIN : FADE_MIN, fadeOut = last ? DUSK_MIN : FADE_MIN;
      const riseAt = first ? toMin(from) - fadeIn / 2 : toMin(from);
      const darkAt = last ? toMin(to) + fadeOut / 2 : toMin(to);
      const rise = (t - riseAt) / fadeIn;
      const set = (darkAt - t) / fadeOut;
      level = Math.max(level, Math.min(1, Math.max(0, Math.min(rise, set))));
    });
    return level;
  }
  // How strong the orange dawn/dusk colours are: only during the real sunrise and sunset. The lunch
  // break also fades to night, but the sun is high then, so it just dims without a sunset glow.
  function twilight(day) {
    if (!DAYLIGHT.length) return 0;
    const t = clockMinutes();
    const dawnFrom = toMin(DAYLIGHT[0][0]) - DAWN_MIN / 2, duskTo = toMin(DAYLIGHT[DAYLIGHT.length - 1][1]) + DUSK_MIN / 2;
    const edge = (t >= dawnFrom && t <= dawnFrom + DAWN_MIN) || (t >= duskTo - DUSK_MIN && t <= duskTo);
    return edge ? Math.sin(Math.PI * day) : 0;
  }
  const setTime = (hm) => { clockOverride = hm ? toMin(hm) : null; };

  // The sun crosses the sky once over the working day: low in the east at the start, highest midway,
  // low in the west at the end. Shadows fall away from it, long when it is low and short when it is high.
  // Its path runs from the start of dawn to the end of dusk, starting and ending below the horizon,
  // so it climbs out from behind the mountains and sinks behind them again.
  function sunState(wpx) {
    if (!DAYLIGHT.length) return { x: -40, y: 200, arc: 0, dir: 1, reach: 1 }; // always night: no sun
    const rise = toMin(DAYLIGHT[0][0]), set = toMin(DAYLIGHT[DAYLIGHT.length - 1][1]), t = clockMinutes();
    const p = Math.min(1, Math.max(0, (t - rise) / (set - rise)));
    const arc = Math.sin(p * Math.PI);
    // On the mountain line at sunrise and sunset, high midway. Before sunrise and after sunset it keeps
    // going down, and is hidden behind the hills by the end of dawn's and dusk's outer half.
    const horizon = 40, sinkMin = DUSK_MIN / 2;
    const beyond = t < rise ? (rise - t) / sinkMin : t > set ? (t - set) / sinkMin : 0;
    const drift = (t < rise ? -1 : t > set ? 1 : 0) * Math.min(1, beyond) * 10;
    return {
      x: 12 + p * (wpx - 24) + drift,
      y: horizon - Math.sqrt(arc) * (horizon - 12) + Math.min(1.2, beyond) * 24,
      arc,
      dir: p < 0.5 ? 1 : -1,                                      // which way shadows point
      reach: 1.2 / Math.max(0.25, Math.tan(0.25 + arc * 1.05)),   // shadow length per pixel of height
    };
  }

  // The moon crosses the sky once a night, from the end of dusk to the start of dawn: it rises from
  // behind the mountains on the left, is highest around the middle of the night, and sets on the right.
  // Returns null while it is below the horizon (the working day).
  function moonState(wpx) {
    // always night: the moon takes the whole day to cross
    const nightStart = DAYLIGHT.length ? toMin(DAYLIGHT[DAYLIGHT.length - 1][1]) + DUSK_MIN / 2 : 0;
    const nightEnd = DAYLIGHT.length ? toMin(DAYLIGHT[0][0]) - DAWN_MIN / 2 + 24 * 60 : 24 * 60;
    const q = ((clockMinutes() - nightStart + 24 * 60) % (24 * 60)) / (nightEnd - nightStart);
    if (q > 1) return null;
    const horizon = 40, arc = Math.sin(q * Math.PI);
    return { x: 12 + q * (wpx - 24), y: horizon + 14 - Math.sqrt(arc) * (horizon + 2) };
  }

  const wave = (speed, offset = 0) => (reduceMotion.matches ? 0 : Math.sin(G.time * speed + offset)); // decorative motion
  const SWING_KEYS = [[0, -2.2], [0.45, -2.4], [0.68, 0.45], [0.78, 0.32], [1, -2.2]];
  const swingAngle = (p) => {
    for (let i = 1; i < SWING_KEYS.length; i++) {
      const [t1, a1] = SWING_KEYS[i];
      if (p <= t1) {
        const [t0, a0] = SWING_KEYS[i - 1];
        return a0 + (a1 - a0) * smooth((p - t0) / (t1 - t0));
      }
    }
    return SWING_KEYS[0][1];
  };

  // ---- world --------------------------------------------------------------------------
  class World {
    constructor(w, h) {
      this.w = w; this.h = h;
      this.t = new Uint8Array(w * h);
      this.owner = new Int16Array(w * h).fill(-1); // which gallery's rock this is (ore colour)
    }
    in(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
    get(x, y) { return this.in(x, y) ? this.t[y * this.w + x] : T.ROCK; }
    set(x, y, v) { if (this.in(x, y)) this.t[y * this.w + x] = v; }
    open(x, y) { const v = this.get(x, y); return v === T.SKY || v === T.TUNNEL || v === T.LADDER; }
    standable(x, y) {
      if (!this.in(x, y) || !this.open(x, y)) return false;
      return this.get(x, y) === T.LADDER || this.get(x, y + 1) === T.LADDER || !this.open(x, y + 1);
    }
    // Breadth-first search over standable tiles; ladders allow vertical moves.
    path([sx, sy], [tx, ty]) {
      if (sx === tx && sy === ty) return [];
      const W = this.w, prev = new Int32Array(W * this.h).fill(-1);
      const start = sy * W + sx, goal = ty * W + tx;
      const queue = [start];
      prev[start] = start;
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        if (cur === goal) break;
        const x = cur % W, y = (cur - x) / W, here = this.get(x, y);
        const next = [];
        if (this.standable(x - 1, y)) next.push(cur - 1);
        if (this.standable(x + 1, y)) next.push(cur + 1);
        if ((here === T.LADDER || this.get(x, y - 1) === T.LADDER) && this.open(x, y - 1)) next.push(cur - W);
        if (this.get(x, y + 1) === T.LADDER || (here === T.LADDER && this.open(x, y + 1))) next.push(cur + W);
        for (const n of next) {
          if (n < 0 || n >= prev.length || prev[n] !== -1) continue;
          prev[n] = cur;
          queue.push(n);
        }
      }
      if (prev[goal] === -1) return null;
      const out = [];
      for (let c = goal; c !== start; c = prev[c]) out.push([c % W, Math.floor(c / W)]);
      return out.reverse();
    }
  }

  // ---- engine state -------------------------------------------------------------------
  const G = {
    root: null, canvas: null, ctx: null, tip: null, hooks: {},
    scale: 3, k: 3, tilesX: 0, rows: 0, SX: 0,
    world: null, tiles: null, sky: null, dark: null,
    galleries: new Map(), order: [], layoutKey: null, tilesDirty: false,
    dwarves: new Map(), retired: new Set(), known: new Map(), particles: [], gems: [], rockets: [],
    haul: null, store: {}, // the windlass hauling a full cart up; the ore on the surface (from the server)
    clouds: [], stars: [], sessions: [], first: true, time: 0,
    mouse: null, hover: null, signs: [], smokeT: 0, nextSpawn: 0, slotGap: 4,
    win: window, ro: null, loopGen: 0,
  };
  const resting = (d) => d.activity === 'rest' && d.atGoal();          // finished leads sit inside the lodge
  const visible = (d) => !(d.delay > 0) && !resting(d);
  const door = () => [G.SX - 4, GRASS - 1];

  // How long a session's tunnel should be: a log scale of its tool calls, so a short task and a long one
  // look different (10 calls is about a third of the way, 100 about two thirds) and only very long
  // sessions reach the edge of the scene.
  function targetOf(g) {
    const room = Math.max(0, (g.max == null ? MIN_LEN : g.max) - MIN_LEN);
    return MIN_LEN + Math.round(room * Math.min(1, Math.log1p(g.calls || 0) / Math.log1p(CALLS_FULL)));
  }

  // ---- dwarves ------------------------------------------------------------------------
  class Dwarf {
    constructor(id, role) {
      this.id = id; this.role = role;
      this.path = []; this.goal = null; this.activity = 'wait'; this.state = 'wait';
      this.face = 1; this.workFace = 1; this.walkT = 0; this.leaving = false; this.gone = false; this.done = false;
      const h = strHash(id);
      this.spec = role === 'lead' ? SPECS.dwarf : SPECS.gnome;
      const beards = role === 'lead' ? BEARDS : GNOME_BEARDS;
      this.beard = this.baseBeard = varied(beards, h, strHash('beard:' + id));
      this.look = lookOf(id, role);
      this.phase = (h % 1000) / 1000;
      this.boulder = { hp: BOULDER_HP, present: true, back: 0 };
      this.place(...door());
    }
    place(tx, ty) { this.tx = tx; this.ty = ty; this.x = tx * TILE + TILE / 2; this.y = (ty + 1) * TILE; this.path = []; }
    atGoal() { return !this.path.length && this.goal && this.tx === this.goal[0] && this.ty === this.goal[1]; }
    setGoal(gx, gy, activity, face, snap) {
      this.activity = activity; this.workFace = face;
      if (snap) { this.goal = [gx, gy]; this.place(gx, gy); return; }
      if (this.goal && this.goal[0] === gx && this.goal[1] === gy) return;
      this.goal = [gx, gy];
      this.route();
    }
    route() {
      if (!this.goal) return;
      if (reduceMotion.matches || this.snap) { this.snap = false; this.place(...this.goal); return; }
      const start = this.path.length ? this.path[0] : [this.tx, this.ty];
      const p = G.world.path(start, this.goal);
      if (!p) { this.place(...this.goal); return; }
      this.path = this.path.length ? [this.path[0], ...p] : p;
    }
    leave(grey) {
      if (this.leaving) return;
      if (this.delay > 0) { this.leaving = true; this.gone = true; return; } // never came out
      this.leaving = true; this.done = grey; this.nudge = 0;
      this.goal = null;
      this.setGoal(...door(), 'wait', 1);
    }
    // Called back before reaching the door: the agent or session turned out to be still going.
    stay() {
      this.leaving = false; this.done = false; this.gone = false;
      this.goal = null; // plan() gives it a new goal
    }
    update(dt) {
      if (this.delay > 0) { this.delay -= dt; return; } // still inside the lodge, waiting for the door
      this.walkT += dt;
      if (this.path.length) {
        const [nx, ny] = this.path[0];
        const px = nx * TILE + TILE / 2, py = (ny + 1) * TILE;
        const dx = px - this.x, dy = py - this.y, dist = Math.hypot(dx, dy);
        const climbing = Math.abs(dy) > Math.abs(dx);
        this.state = climbing ? 'climb' : 'walk';
        if (Math.abs(dx) > 0.01) this.face = Math.sign(dx);
        const step = (climbing ? CLIMB : WALK) * dt;
        if (dist <= step) { this.x = px; this.y = py; this.tx = nx; this.ty = ny; this.path.shift(); }
        else { this.x += dx / dist * step; this.y += dy / dist * step; }
        return;
      }
      if (this.leaving) { this.gone = true; return; }
      const spotX = this.tx * TILE + TILE / 2 + (this.nudge || 0); // a crowded gnome's pixel nudge
      if (this.x !== spotX) this.x += Math.sign(spotX - this.x) * Math.min(Math.abs(spotX - this.x), WALK * dt);
      this.state = this.activity;
      this.face = this.workFace;
      const b = this.boulder;
      if (!b.present && G.time >= b.back) {
        b.present = true; b.hp = BOULDER_HP;
        dust(this.x + this.face * TILE, this.y - 2, 5);
      }
      const period = WORK[this.activity];
      if (period && !reduceMotion.matches) {
        const before = this.phase, hit = this.activity === 'dig' ? IMPACT : 0.5;
        this.phase = (this.phase + dt / period) % 1;
        if (before < hit && (this.phase >= hit || this.phase < before)) work(this);
        if (this.activity === 'dig' && this.tier === 'diamond' && (!this.prop || this.prop === 'pick') && Math.random() < dt * 2) {
          const a = swingAngle(this.phase);
          const sp = this.spec;
          spark(this.x + this.face * (sp.sx - sp.ax + Math.cos(a) * sp.handle), this.y - sp.h + sp.sy + Math.sin(a) * sp.handle);
        }
      }
    }
    pickAngle() {
      if (this.state === 'dig') return reduceMotion.matches ? 0.4 : swingAngle(this.phase);
      if (this.state === 'think') return 0.55;
      return -2.1;
    }
  }

  // finished: the server says this agent is done. A retired id comes back if it turns out not to be.
  function ensureDwarf(id, role, finished) {
    if (G.retired.has(id)) {
      if (finished) return null;
      G.retired.delete(id);
    }
    let d = G.dwarves.get(id);
    if (d) {
      d.miss = 0;
      if (d.leaving && !finished) d.stay();
    }
    if (!d) {
      d = new Dwarf(id, role);
      d.fresh = true;
      if (!G.first) { // queue up at the lodge door so newcomers do not walk on top of each other
        d.delay = Math.max(0, G.nextSpawn - G.time);
        G.nextSpawn = G.time + d.delay + SPAWN_GAP;
      }
      G.dwarves.set(id, d);
    }
    return d;
  }

  // ---- gameplay -----------------------------------------------------------------------
  function strike(d) {
    if (d.role === 'sub' && d.prop && d.prop !== 'pick') return; // lantern and sack gnomes don't dig
    const g = G.galleries.get(d.sessionId);
    const hx = d.x + d.face * strikeReach(d.spec), hy = d.y - (d.spec.h - d.spec.sy) / 2 - 0.5;
    chips(hx, hy, d.face, d.tier);
    if (!g || g.level == null || !d.atGoal()) return;
    if (d.role === 'lead') {
      faceWork(d);
    } else {
      const b = d.boulder;
      if (!b.present || d.space < GNOME_SPACE) return; // squeezed gnomes have no boulder (none is drawn)
      if (--b.hp <= 0) {
        b.present = false; b.back = G.time + 1.3;
        const bx = (d.tx + d.face) * TILE + TILE / 2;
        dust(bx, d.y - 3, 8);
        gemTo(g, bx, d.y - 4, d.tier);
      }
    }
  }

  // One beat of a lead's work at the tunnel face; FACE_HP beats break the next tile.
  function faceWork(d) {
    const g = G.galleries.get(d.sessionId);
    if (d.role !== 'lead' || !g || g.level == null || !d.atGoal() || g.len >= g.max) return;
    if (++g.dmg >= FACE_HP) {
      if (g.len < targetOf(g)) breakFace(g, d);
      else g.dmg = FACE_HP - 1; // nothing new to show for this session yet: keep working
    }
  }

  // The beat of each working animation: the pick strikes, the hammer taps, the rest just count.
  function work(d) {
    if (d.activity === 'dig') { strike(d); return; }
    const sp = d.spec, top = d.y - sp.h;
    if (!d.prop || d.prop === 'pick') {
      if (d.activity === 'chisel') spark(d.x + d.face * (sp.w - sp.ax + 3.5), top + Math.round(sp.sy) - 1);
      else if (d.activity === 'inspect' && Math.random() < 0.6) spark(d.x + d.face * strikeReach(sp), top + sp.eye[1] + 2);
      else if (d.activity === 'cart') dust(d.x + d.face * (sp.w - sp.ax + 4), d.y - 1, 2);
    }
    faceWork(d);
  }

  function breakFace(g, d) {
    const x = g.ox + g.dir * (g.len + 1);
    for (let y = g.r0; y < g.r0 + 3; y++) G.world.set(x, y, T.TUNNEL);
    for (let xx = x - 1; xx <= x + 1; xx++) for (let y = g.r0 - 1; y <= g.r0 + 3; y++) drawTile(xx, y);
    g.len++; g.dmg = 0;
    g.dug = Math.max(g.dug, g.len);
    const cx = x * TILE + TILE / 2;
    for (let y = g.r0; y < g.r0 + 3; y++) dust(cx, y * TILE + 5, 6);
    gemTo(g, cx, (g.r0 + 2) * TILE, d.tier);
    plan();
  }

  const cartPos = (g) => [(g.ox + g.dir * 2) * TILE + TILE / 2, (g.r0 + 3) * TILE - 7];

  function gemTo(g, x, y, tier) {
    const [cx, cy] = cartPos(g);
    G.gems.push({ g, x0: x, y0: y, x1: cx, y1: cy, t: 0, dur: 0.5 + Math.abs(cx - x) / 140, color: TIERS[tier || 'wood'][0] });
  }

  function chips(x, y, dir, tier) {
    if (reduceMotion.matches) return;
    for (let i = 0; i < 4; i++) {
      G.particles.push({
        x, y, vx: -dir * (10 + Math.random() * 35), vy: -(20 + Math.random() * 40), g: 170,
        life: 0.6 + Math.random() * 0.4, age: 0, size: 1,
        color: i === 0 ? TIERS[tier || 'wood'][0] : '#8d8073', bounce: true,
      });
    }
  }
  function dust(x, y, n) {
    if (reduceMotion.matches) return;
    for (let i = 0; i < n; i++) {
      G.particles.push({
        x: x + (Math.random() - 0.5) * 8, y, vx: (Math.random() - 0.5) * 30, vy: -Math.random() * 25, g: 50,
        life: 0.8 + Math.random() * 0.6, age: 0, size: Math.random() < 0.3 ? 2 : 1, color: '#a39686', bounce: true,
      });
    }
  }
  // Level-up fireworks: a few rockets go up from the top of the shaft, one after another, trailing
  // sparks, and each bursts high in the sky into a ring of coloured sparks that drift down and fade.
  const FIREWORK_COLOURS = ['#ff6b6b', '#6ec6ff', '#7dff9a', '#d58cff', '#ffa94d'];
  function fireworks(count = 3) {
    if (reduceMotion.matches || !G.world) return;
    for (let i = 0; i < count; i++) {
      G.rockets.push({
        x: G.SX * TILE + TILE / 2 + (Math.random() - 0.5) * 50, y: GRASS * TILE - 2,
        vx: (Math.random() - 0.5) * 16, vy: -(62 + Math.random() * 10), // bursts about a third of the way down the sky
        delay: i * 0.4 + Math.random() * 0.15, fuse: 0.8 + Math.random() * 0.2, age: 0,
        colours: ['#f5c542', FIREWORK_COLOURS[Math.floor(Math.random() * FIREWORK_COLOURS.length)]],
      });
    }
  }
  function burst(r) {
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2, v = 26 + Math.random() * 18;
      G.particles.push({
        x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 26, life: 1.1 + Math.random() * 0.6, age: 0,
        size: Math.random() < 0.25 ? 2 : 1, color: r.colours[i % 2], glow: true, twinkle: true,
      });
    }
    G.particles.push({ x: r.x - 1, y: r.y - 1, vx: 0, vy: 0, g: 0, life: 0.15, age: 0, size: 3, color: '#ffffff', glow: true }); // the flash
  }
  function updateRockets(dt) {
    G.rockets = G.rockets.filter((r) => {
      if (r.delay > 0) { r.delay -= dt; return true; }
      r.age += dt;
      r.vy += 60 * dt; r.x += r.vx * dt; r.y += r.vy * dt;
      if (Math.random() < 0.8) {
        G.particles.push({ x: r.x, y: r.y + 1, vx: (Math.random() - 0.5) * 6, vy: 6, g: 20, life: 0.35, age: 0, size: 1, color: '#ffd58a' });
      }
      if (r.age < r.fuse) return true;
      burst(r);
      return false;
    });
  }

  function spark(x, y) {
    G.particles.push({ x, y, vx: (Math.random() - 0.5) * 10, vy: -8, g: 0, life: 0.4, age: 0, size: 1, color: '#ffffff' });
  }

  // Where everyone should be, from the latest poll and the galleries' current lengths.
  function plan() {
    if (!G.world) return;
    const ready = G.sessions.filter((s) => stateOf(s) === 'ready');
    const slots = waitingSlots(ready.length);
    for (const s of G.sessions) {
      const g = G.galleries.get(s.id);
      const lead = G.dwarves.get(leadKey(s));
      if (lead && !lead.leaving) {
        const snap = lead.fresh && G.first;
        const st = stateOf(s);
        if (st === 'ready') lead.setGoal(slots[ready.indexOf(s)], GRASS - 1, 'wait', 1, snap);
        else if (st === 'done') lead.setGoal(...door(), 'rest', 1, snap);
        else lead.setGoal(g.ox + g.dir * g.len, g.r0 + 2, actOf(s.activity), g.dir, snap);
        lead.fresh = false;
      }
      const crew = [];
      for (const a of s.agents) {
        const d = G.dwarves.get('sub:' + a.id);
        if (!d || d.leaving) continue;
        if (a.finished) {
          if (d.fresh && G.first) { G.dwarves.delete(d.id); G.retired.add(d.id); continue; }
          d.leave(true);
          continue;
        }
        crew.push([d, a]);
      }
      // Gnomes stand behind the lead, from two tiles back towards the shaft, two tiles apart when the
      // tunnel has room. When it is crowded they also use the tile just behind the lead and squeeze
      // closer, spread evenly so they overlap a little but are never fully stacked. They never stand on
      // the shaft tile (the ladder, shared with the tunnel opposite). Each stands on a tile plus a pixel nudge.
      const n = crew.length, near = TILE;                    // pixels from the shaft: the last spot
      let far = (g.len - 2) * TILE;                          // the first gnome's spot
      if (n > 1 && (far - near) / (n - 1) < GNOME_SPACE) far = (g.len - 1) * TILE - 4;
      far = Math.max(far, near);                             // a tunnel too short for that (tiny window)
      const space = n <= 1 ? GNOME_SPACE : Math.min(GNOME_SPACE, (far - near) / (n - 1));
      crew.forEach(([d, a], k) => {
        const snap = d.fresh && G.first;
        d.fresh = false;
        const at = Math.max(far - space * k, near);
        const tile = Math.max(0, Math.round(at / TILE));
        Object.assign(d, { space, nudge: g.dir * (at - tile * TILE), stagger: space < GNOME_SPACE && k % 2 === 1 });
        d.setGoal(g.ox + g.dir * tile, g.r0 + 2, actOf(a.activity), g.dir, snap);
      });
    }
  }

  // Surface spots for dwarves waiting on you: right of the shaft first, then left of the lodge.
  // Packs them closer when space is short; G.slotGap tells the text pass whether names fit.
  function waitingSlots(n) {
    let out = [];
    for (const gap of [4, 3, 2, 1]) {
      out = [];
      for (let x = G.SX + 5; x <= G.tilesX - 2 && out.length < n; x += gap) out.push(x); // past the ore store
      for (let x = G.SX - 9; x >= 1 && out.length < n; x -= gap) out.push(x);
      G.slotGap = gap;
      if (out.length >= n) return out;
    }
    const base = out.length ? out.slice() : [G.SX + 2];
    for (let i = 0; out.length < n; i++) out.push(base[i % base.length]);
    return out;
  }

  // ---- building the world -------------------------------------------------------------
  function rebuild() {
    const cw = G.root.clientWidth || 800;
    const fit = !!G.root.dataset.fit;
    const ch = G.root.clientHeight || 300;
    const gals = G.order.map((id) => G.galleries.get(id));
    const placed = layOut(gals);
    const levels = placed.reduce((n, g) => Math.max(n, g.level + 1), 0);
    G.shaftLevels = placed.reduce((n, g) => (g.up ? n : Math.max(n, g.level + 1)), 0);
    const needRows = LEVEL_TOP + levels * LEVEL_STRIDE;
    if (fit) {
      // overlay: the biggest pixel scale at which every tunnel fits the window...
      G.scale = [3, 2, 1].find((s) => Math.floor(cw / (TILE * s)) >= 16 && needRows * TILE * s <= ch) || 1;
      // ...and then enough world to fill it: more rock to the sides and further down
      G.tilesX = Math.max(16, Math.ceil(cw / (TILE * G.scale)));
      G.rows = Math.max(needRows, Math.ceil(ch / (TILE * G.scale)));
    } else {
      G.scale = cw >= 900 ? 3 : 2;
      G.tilesX = Math.max(16, Math.floor(cw / (TILE * G.scale)));
      G.rows = needRows;
    }
    G.SX = Math.floor(G.tilesX / 2);
    const w = new World(G.tilesX, G.rows);
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        w.set(x, y, y < GRASS ? T.SKY : y === GRASS ? T.GRASS : y <= GRASS + 2 ? T.DIRT : T.ROCK);
      }
    }
    // the main shaft goes down to the deepest gallery that opens onto it
    if (G.shaftLevels) for (let y = GRASS; y <= LEVEL_TOP + (G.shaftLevels - 1) * LEVEL_STRIDE + 2; y++) w.set(G.SX, y, T.LADDER);
    for (const g of placed) { // parents before their subsessions, so a parent's length is known
      g.r0 = LEVEL_TOP + g.level * LEVEL_STRIDE;
      // a subsession's entrance is its side shaft, a few tiles into the top gallery of its family; deeper
      // subsessions hang off that same shaft, so nesting never costs more width
      g.ox = !g.up ? G.SX : g.up.up ? g.up.ox : g.up.ox + g.up.dir * Math.min(SIDE_SHAFT, g.up.len);
      g.max = Math.max(0, g.dir > 0 ? G.tilesX - 2 - g.ox : g.ox - 1);
      // g.dug remembers how far it was dug, so a narrower window only hides tunnel, never loses it
      if (g.dug == null) g.dug = targetOf(g);
      g.len = Math.max(Math.min(g.dug, g.max), Math.min(MIN_LEN, g.max));
      const i = G.order.indexOf(g.id);
      for (let j = 1; j <= g.max; j++) {
        const x = g.ox + g.dir * j;
        for (let y = g.r0 - 1; y <= g.r0 + 3; y++) if (w.in(x, y)) w.owner[y * w.w + x] = i;
        if (j <= g.len) for (let y = g.r0; y < g.r0 + 3; y++) w.set(x, y, T.TUNNEL);
      }
      // the side shaft: from just under the parent's sign down to this gallery's floor
      if (g.up) for (let y = g.up.r0 + 1; y <= g.r0 + 2; y++) w.set(g.ox, y, T.LADDER);
    }
    G.world = w;
    sizeCanvas();
    drawSky();
    drawAllTiles();
    // Old goals are in the old layout, so forget them and let plan() hand out new ones.
    // Dwarves that were already standing at their spot (digging, waiting, resting in the lodge), and
    // dwarves now inside rock, snap straight to their new spot. Only dwarves that were on the move walk on.
    for (const d of G.dwarves.values()) {
      const settled = d.atGoal();
      d.path = [];
      d.goal = null;
      if (settled || !w.standable(d.tx, d.ty)) d.snap = true;
      else d.place(d.tx, d.ty);
      if (d.leaving) {
        if (d.snap) { d.snap = false; d.place(...door()); }
        d.setGoal(...door(), 'wait', 1);
      }
    }
    plan();
    // Anyone plan() had no spot for (a gnome missing from this poll, still within its grace polls)
    // stays where it stands if that is open ground, rather than jumping to the lodge door; the next
    // poll either gives it a spot again or sends it home.
    for (const d of G.dwarves.values()) {
      if (!d.snap) continue;
      d.snap = false;
      if (w.standable(d.tx, d.ty)) { d.place(d.tx, d.ty); d.goal = [d.tx, d.ty]; }
      else d.place(...door());
    }
  }

  // Which side and level each gallery gets. A family (a session and the subsessions it started, and
  // theirs) keeps to one side, stacked: the session first, then each subsession under it, depth first,
  // oldest first. A family keeps the side it was given, so a new subsession pushes the galleries below
  // it on that side down a level and nothing ever changes sides; only a new family picks a side: the
  // one with fewer levels, the right on a tie (so plain sessions alternate right and left). Sets g.dir,
  // g.level and g.up (the parent's gallery, or null); returns the galleries in that order.
  function layOut(gals) {
    const byId = new Map(gals.map((g) => [g.id, g]));
    const parentOf = (g) => {
      const p = g.parent && g.parent !== g.id ? byId.get(g.parent) : null;
      if (!p) return null;
      for (let q = p, n = 0; q; q = q.parent && byId.get(q.parent), n++) if (q === g || n > gals.length) return null; // a loop
      return p;
    };
    const kids = new Map();
    for (const g of gals) {
      g.up = parentOf(g);
      if (g.up) kids.set(g.up.id, [...(kids.get(g.up.id) || []), g]);
    }
    const used = { 1: 0, '-1': 0 }, out = [];
    const place = (g, dir) => {
      g.dir = dir; g.level = used[dir]++; out.push(g);
      for (const k of kids.get(g.id) || []) place(k, dir);
    };
    // families that already have a side first, so a new family sees how deep each side really is
    const roots = gals.filter((g) => !g.up), sided = (g) => g.dir === 1 || g.dir === -1;
    for (const g of roots) if (sided(g)) place(g, g.dir);
    for (const g of roots) if (!sided(g)) place(g, used[1] <= used[-1] ? 1 : -1);
    return out.sort((a, b) => a.dir - b.dir || a.level - b.level); // parents before their subsessions
  }

  // The way ore goes from a gallery's cart to the main shaft: for a subsession, along its floor to its
  // side shaft and up into the parent's gallery, and so on up to the gallery that opens onto the shaft.
  // Returns the points after the cart (ending at the shaft) and that top gallery.
  function routeUp(g) {
    const pts = [];
    let cur = g;
    while (cur.up) {
      const x = cur.ox * TILE + TILE / 2;
      pts.push([x, (cur.r0 + 3) * TILE - 6], [x, (cur.up.r0 + 3) * TILE - 6]);
      cur = cur.up;
    }
    return { pts, top: cur };
  }

  function sizeCanvas() {
    const wpx = G.tilesX * TILE, hpx = G.rows * TILE;
    G.k = Math.max(1, Math.round(G.scale * (G.win.devicePixelRatio || 1)));
    G.canvas.width = wpx * G.k;
    G.canvas.height = hpx * G.k;
    G.canvas.style.width = wpx * G.scale + 'px';
    G.canvas.style.height = hpx * G.scale + 'px';
    G.dark = makeCanvas(wpx, hpx);
  }

  // Two skies, night and day, cross-faded by daylight() in render().
  function drawSky() {
    const wpx = G.tilesX * TILE, top = GRASS * TILE;
    // Layers, back to front: gradient, moon, far mountains with snow, rolling hills, a line of pines.
    // Trees keep clear of the lodge and the headframe.
    const clearFrom = (G.SX - 8) * TILE, clearTo = (G.SX + 4) * TILE; // the tavern, the windlass and the ore store
    const treeAt = [];
    for (let x = 4; x < wpx - 4; x += 9 + Math.floor(rand01(x, 3, 41) * 16)) {
      if (x + 5 < clearFrom || x - 5 > clearTo) treeAt.push([x, 9 + Math.floor(rand01(x, 4, 41) * 8)]);
    }
    const paint = (p) => {
      const canvas = makeCanvas(wpx, top), c = canvas.getContext('2d');
      // the sky: a few flat colour steps blended with an ordered (Bayer) dither, the pixel-art way
      const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const [a, b] = [hex(p.from), hex(p.to)], steps = SKY_STEPS - 1;
      const img = c.createImageData(wpx, top);
      for (let y = 0; y < top; y++) {
        const t = y / (top - 1);
        for (let x = 0; x < wpx; x++) {
          const k = Math.min(steps, Math.floor(t * steps + bayer(x, y))) / steps, o = (y * wpx + x) * 4;
          for (let j = 0; j < 3; j++) img.data[o + j] = Math.round(a[j] + (b[j] - a[j]) * k);
          img.data[o + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
      const mx = wpx - 26, my = 14; // the moon; the sun moves, so render() draws it
      if (p.disc) for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
        if (x * x + y * y > 36) continue;
        c.fillStyle = p.disc(x, y);
        c.fillRect(mx + x, my + y, 1, 1);
      }
      // the landscape is its own transparent layer, so the sun can be drawn between sky and mountains
      const sky = canvas;
      const land = makeCanvas(wpx, top);
      {
      const c = land.getContext('2d');
      for (let x = 0; x < wpx; x++) {
        const h = Math.round(20 + 8 * Math.sin(x * 0.021 + 2) + 5 * Math.sin(x * 0.061) + 4 * Math.abs(Math.sin(x * 0.13)));
        c.fillStyle = p.far;
        c.fillRect(x, top - h, 1, h);
        if (h > 29) { c.fillStyle = p.snow; c.fillRect(x, top - h, 1, Math.min(3, h - 29)); }
      }
      for (let x = 0; x < wpx; x++) {
        const h = Math.round(9 + 5 * Math.sin(x * 0.045) + 3 * Math.sin(x * 0.13 + 1));
        c.fillStyle = p.hills;
        c.fillRect(x, top - h, 1, h);
        c.fillStyle = p.hillsLight;
        c.fillRect(x, top - h, 1, 1);
      }
      for (const [tx, th] of treeAt) {
        c.fillStyle = p.trunk;
        c.fillRect(tx, top - 3, 1, 3);
        for (let row = 0; row < th - 2; row++) {
          const half = Math.floor(row * 0.42) - (row % 4 === 0 && row > 0 ? 1 : 0);
          c.fillStyle = p.tree;
          c.fillRect(tx - half, top - th + row, half * 2 + 1, 1);
          c.fillStyle = p.treeLight;
          c.fillRect(tx - half, top - th + row, 1, 1);
        }
      }
      }
      return [sky, land];
    };
    [G.sky, G.skyLand] = paint({
      from: '#0d1430', to: '#2c3b63', far: '#18203a', snow: '#3a4566', hills: '#141c33', hillsLight: '#1e2944',
      tree: '#0d1526', treeLight: '#18233a', trunk: '#0d1526', disc: null, // the moon moves: render() draws it
    });
    [G.skyDay, G.skyDayLand] = paint({
      from: '#3f86d8', to: '#a8d6f7', far: '#7fa3c9', snow: '#eef4fb', hills: '#4a7f4a', hillsLight: '#62a05a',
      tree: '#2e5a32', treeLight: '#42784a', trunk: '#4a3020', disc: null,
    });
    // the dawn/dusk glow: orange whose opacity rises towards the horizon in dithered steps; render()
    // fades the whole layer in and out with the twilight
    G.glow = makeCanvas(wpx, top);
    {
      const gc = G.glow.getContext('2d'), img = gc.createImageData(wpx, top), steps = SKY_STEPS - 1;
      for (let y = 0; y < top; y++) for (let x = 0; x < wpx; x++) {
        const k = Math.min(steps, Math.floor((y + 1) / top * steps + bayer(x, y))) / steps, o = (y * wpx + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 140; img.data[o + 2] = 70; img.data[o + 3] = Math.round(255 * 0.45 * k);
      }
      gc.putImageData(img, 0, 0);
    }
    G.stars = [];
    for (let i = 0; i < Math.round(wpx / 9); i++) {
      G.stars.push({ x: Math.floor(rand01(i, 1, 5) * wpx), y: Math.floor(rand01(i, 2, 5) * (top - 18)), p: rand01(i, 3, 5) * 6 });
    }
    if (!G.clouds.length) {
      for (let i = 0; i < 4; i++) {
        const w = 22 + Math.floor(rand01(i, 7, 6) * 20);
        G.clouds.push({ x: rand01(i, 4, 6) * wpx, y: 4 + i * 9, w, v: 1.5 + i * 0.8, sprite: cloudSprite(w, i) });
      }
    }
  }

  // A puffy pixel cloud: a few overlapping circles, white on top, grey-blue underneath.
  function cloudSprite(w, seed) {
    const h = 11, canvas = makeCanvas(w, h), c = canvas.getContext('2d');
    const puffs = [[w * 0.3, 7, 4.5], [w * 0.55, 5, 5.5], [w * 0.78, 7, 4], [w * 0.15, 8.5, 2.8], [w * 0.92, 8.5, 2.5]]
      .map(([x, y, r], i) => [x + (rand01(seed, i, 8) - 0.5) * 3, y, r]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (y > 9 || !puffs.some(([px, py, r]) => (x - px) ** 2 + (y - py) ** 2 <= r * r)) continue;
      const below = y >= 8 || !puffs.some(([px, py, r]) => (x - px) ** 2 + (y + 2 - py) ** 2 <= r * r);
      c.fillStyle = below ? '#c8d4e8' : y < 4 ? '#ffffff' : '#f2f6fc';
      c.fillRect(x, y, 1, 1);
    }
    return canvas;
  }

  function drawAllTiles() {
    const w = G.world;
    G.tiles = makeCanvas(w.w * TILE, w.h * TILE);
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) drawTile(x, y);
  }

  // Rock colour by depth: warm brown just under the dirt, cool dark stone further down.
  function strata(y) {
    const t = Math.min(1, Math.max(0, y - (GRASS + 3)) / 20);
    return [88 + (54 - 88) * t, 76 + (55 - 76) * t, 64 + (66 - 64) * t];
  }
  const shade = ([rr, gg, bb], k) => `rgb(${Math.min(255, Math.round(rr * k))},${Math.min(255, Math.round(gg * k))},${Math.min(255, Math.round(bb * k))})`;

  function drawTile(x, y) {
    const w = G.world;
    if (!w.in(x, y)) return;
    const c = G.tiles.getContext('2d'), t = w.get(x, y), px = x * TILE, py = y * TILE;
    c.clearRect(px, py, TILE, TILE);
    if (t === T.SKY) return;
    const r = (i, seed) => rand01(x * 31 + i * 7, y * 17 + i, seed);
    const speck = (base, a, b, n, seed) => {
      c.fillStyle = base;
      c.fillRect(px, py, TILE, TILE);
      for (let i = 0; i < n; i++) {
        c.fillStyle = r(i, seed) < 0.5 ? a : b;
        c.fillRect(px + Math.floor(r(i, seed + 1) * TILE), py + Math.floor(r(i, seed + 2) * TILE), 1, 1);
      }
    };
    // Stone texture: a base colour from the depth, a few rounded stones with a lit top and a dark underside.
    const stones = (base, k) => {
      c.fillStyle = shade(base, k);
      c.fillRect(px, py, TILE, TILE);
      for (let i = 0; i < 7; i++) {
        c.fillStyle = shade(base, k * (r(i, 20) < 0.5 ? 0.82 : 1.1));
        c.fillRect(px + Math.floor(r(i, 21) * TILE), py + Math.floor(r(i, 22) * TILE), 1, 1);
      }
      for (let i = 0; i < 3; i++) {
        const sx = px + 1 + Math.floor(r(i, 23) * 6), sy = py + 1 + Math.floor(r(i, 24) * 6), sw = 2 + (r(i, 25) < 0.5 ? 1 : 0);
        c.fillStyle = shade(base, k * 1.12); c.fillRect(sx, sy, sw, 2);
        c.fillStyle = shade(base, k * 1.32); c.fillRect(sx, sy, 1, 1);
        c.fillStyle = shade(base, k * 0.72); c.fillRect(sx, sy + 2, sw, 1);
      }
    };
    const wall = () => {
      stones(strata(y), 0.48); // the tunnel's back wall: the same rock, in shadow
      if (!w.open(x, y - 1)) {
        c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(px, py, TILE, 2);
        c.fillStyle = 'rgba(0,0,0,.2)'; c.fillRect(px, py + 2, TILE, 1);
      }
      if (!w.open(x, y + 1) && t === T.TUNNEL) { // floor: minecart rails on sleepers
        c.fillStyle = '#4a3020';
        for (let i = (x % 2) * 2; i < TILE; i += 4) c.fillRect(px + i, py + 8, 2, 2);
        c.fillStyle = '#7d828c'; c.fillRect(px, py + 8, TILE, 1);
        c.fillStyle = '#a9afb9'; c.fillRect(px + Math.floor(r(0, 26) * 8), py + 8, 2, 1);
      }
    };
    if (t === T.GRASS) {
      speck('#5a3f2b', '#6b4c34', '#4a3323', 10, 2);
      c.fillStyle = '#3f6a2b'; c.fillRect(px, py, TILE, 4);
      c.fillStyle = '#4f7f34'; c.fillRect(px, py, TILE, 3);
      for (let i = 0; i < TILE; i++) {
        const q = rand01(x * TILE + i, y, 8);
        if (q < 0.45) { c.fillStyle = q < 0.2 ? '#7fb24f' : '#62983f'; c.fillRect(px + i, py - 1 - (q < 0.1 ? 1 : 0), 1, 2 + (q < 0.1 ? 1 : 0)); }
        if (q > 0.965) { c.fillStyle = ['#ffe066', '#ffffff', '#ff7aa2', '#9ec9ff'][Math.floor(q * 997) % 4]; c.fillRect(px + i, py - 2, 1, 1); }
      }
    } else if (t === T.DIRT) {
      speck('#5a3f2b', '#6b4c34', '#4a3323', 14, 2);
      c.fillStyle = '#7a5a3e';
      for (let i = 0; i < 2; i++) if (r(i, 30) < 0.6) c.fillRect(px + Math.floor(r(i, 31) * 9), py + Math.floor(r(i, 32) * 9), 2, 1);
      if (y === GRASS + 1 && r(0, 33) < 0.5) { // roots hanging down from the grass
        c.fillStyle = '#3b2a1c';
        let rx = px + Math.floor(r(0, 34) * 8);
        for (let ry = 0; ry < 6; ry++) { c.fillRect(rx, py + ry, 1, 1); if (r(ry, 35) < 0.35) rx += r(ry, 36) < 0.5 ? -1 : 1; }
      }
    } else if (t === T.ROCK) {
      stones(strata(y), 1);
      const owner = w.owner[y * w.w + x];
      const g = owner >= 0 && G.galleries.get(G.order[owner]);
      // ore: in a gallery's rock it has that session's pickaxe colour; elsewhere a sparse mix of all kinds
      const deep = !g && y > GRASS + 2;
      const oreTier = g ? g.tier || 'wood'
        : deep && rand01(x, y, 9) < 0.08 ? ['copper', 'copper', 'iron', 'iron', 'gold', 'diamond'][Math.floor(rand01(x, y, 12) * 6)] : null;
      if (oreTier && (!g || rand01(x, y, 9) < 0.22)) {
        const ox = px + 2 + Math.floor(rand01(x, y, 10) * 5), oy = py + 2 + Math.floor(rand01(x, y, 11) * 5);
        c.fillStyle = TIERS[oreTier][0];
        c.fillRect(ox, oy, 2, 1); c.fillRect(ox + 1, oy + 1, 1, 1);
        c.fillStyle = TIERS[oreTier][1];
        c.fillRect(ox, oy + 1, 1, 1);
      }
      // edges facing a tunnel: dark sides, a lit lip on top of a floor
      c.fillStyle = shade(strata(y), 0.55);
      if (w.open(x - 1, y) && y > GRASS) c.fillRect(px, py, 1, TILE);
      if (w.open(x + 1, y) && y > GRASS) c.fillRect(px + TILE - 1, py, 1, TILE);
      if (w.open(x, y - 1) && y > GRASS) {
        c.fillStyle = shade(strata(y), 1.45); c.fillRect(px, py, TILE, 1);
        c.fillStyle = shade(strata(y), 1.15); c.fillRect(px, py + 1, TILE, 1);
      }
      if (w.open(x, y + 1) && y > GRASS) { c.fillStyle = shade(strata(y), 0.6); c.fillRect(px, py + TILE - 1, TILE, 1); }
    } else if (t === T.TUNNEL) {
      wall();
    } else if (t === T.LADDER) {
      wall();
      c.fillStyle = '#5e3c1f'; c.fillRect(px + 2, py, 1, TILE); c.fillRect(px + 7, py, 1, TILE);
      c.fillStyle = '#8a5a30'; c.fillRect(px + 1, py, 1, TILE); c.fillRect(px + 8, py, 1, TILE);
      for (const ry of [2, 7]) {
        c.fillStyle = '#a8763f'; c.fillRect(px + 2, py + ry, 6, 1);
        c.fillStyle = '#5e3c1f'; c.fillRect(px + 2, py + ry + 1, 6, 1);
      }
    }
  }

  // ---- sprites ------------------------------------------------------------------------
  const sprites = new Map();
  // ---- looks ----
  // Each dwarf and gnome gets a few features picked by a hash of its id (so they stay the same):
  // helmet or hat colour, tunic and boots, beard style, nose, belt buckle, and now and then a horn.
  const LOOKS = {
    // dark iron, steel, brass, copper, rusty red, moss green
    helms: [['#222c35', '#46525d'], ['#58606c', '#8a929e'], ['#7a6230', '#a88a48'], ['#7a4a2a', '#a06a3e'], ['#6a3a30', '#8e5244'], ['#33452f', '#566e4c']],
    tunics: ['#6a5f53', '#4f5a3e', '#6b3f33', '#3f4a5c', '#7a6438', '#5a4a5e', '#56524a'],
    boots: ['#25222a', '#3b2a1c', '#2a2f3a', '#3a2622'],
    hats: [['#c8382c', '#9e2a22'], ['#2f6fb0', '#22528a'], ['#3f8a4a', '#2c6636'], ['#c8a02c', '#9a7a1e'], ['#8a3fa0', '#6a2e7c']],
    beards: ['long', 'long', 'short', 'forked', 'braided'],
    // skin, fair to dark; the original tone comes up most often
    skins: ['#d5a076', '#d5a076', '#d5a076', '#e8b98f', '#f3cfae', '#b98257', '#93603c', '#6e4429'],
  };
  // Colour helpers for slight variety: blend a picked colour part of the way towards another entry of
  // its list, then nudge its brightness a little. Same id, same result.
  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  function blend(a, b, t, bright) {
    const [x, y] = [hexRgb(a), hexRgb(b)];
    return rgbHex(x.map((v, i) => (v + (y[i] - v) * t) * bright));
  }
  // varied(list, pickHash, tintHash): an entry, blended up to 35% towards another, brightness ±10%.
  function varied(list, h, tint) {
    const i = h % list.length, j = (i + 1 + (tint % Math.max(1, list.length - 1))) % list.length;
    const t = ((tint >>> 8) % 1000) / 1000 * 0.35, bright = 0.9 + ((tint >>> 18) % 1000) / 1000 * 0.2;
    return blend(list[i], list[j], t, bright);
  }
  // the same for pairs of colours that belong together (a helmet and its brim, a hat and its shadow)
  function variedPair(list, h, tint) {
    const i = h % list.length, j = (i + 1 + (tint % Math.max(1, list.length - 1))) % list.length;
    const t = ((tint >>> 8) % 1000) / 1000 * 0.35, bright = 0.9 + ((tint >>> 18) % 1000) / 1000 * 0.2;
    return [0, 1].map((k) => blend(list[i][k], list[j][k], t, bright));
  }

  function lookOf(id, role) {
    const h = strHash('look:' + id), tint = (part) => strHash(part + ':' + id);
    const look = {
      helm: variedPair(LOOKS.helms, h, tint('helm')), tunic: varied(LOOKS.tunics, h >>> 3, tint('tunic')),
      boots: varied(LOOKS.boots, h >>> 6, tint('boots')), hat: variedPair(LOOKS.hats, h >>> 9, tint('hat')),
      beard: pick(LOOKS.beards, h >>> 12),
      bigNose: (h >>> 15) % 3 === 0, buckle: (h >>> 17) % 2 === 0, horn: (h >>> 19) % 5 === 0,
      skin: pick(LOOKS.skins, tint('skin')), // its own hash, so the other features stay as they were
    };
    look.key = lookKey(look, role);
    return look;
  }
  const lookKey = (look, role) => role + [look.helm[0], look.helm[1], look.tunic, look.boots, look.hat[0], look.beard, look.bigNose, look.buckle, look.horn, look.skin].join(',');

  // Your own choices (from the tavern) over the generated look: colours, beard style, nose, buckle, horn.
  // A chosen helmet colour gets a lighter brim to match.
  function withCustom(base, c, role) {
    if (!c) return base;
    const look = { ...base };
    if (c.helm) look.helm = [c.helm, rgbHex(hexRgb(c.helm).map((v) => v * 1.3 + 14))];
    for (const k of ['tunic', 'boots', 'beard', 'bigNose', 'buckle', 'horn', 'skin']) if (c[k] !== undefined) look[k] = c[k];
    look.key = lookKey(look, role);
    return look;
  }
  // Applies a roster dwarf's chosen name and looks to its sprite; only redoes the look when they change.
  function applyCustom(d, w) {
    d.firstName = (w && w.firstName) || '';  // the parts you chose; empty: generated
    d.lastName = (w && w.lastName) || '';
    d.nameSeed = (w && w.nameSeed) || '';    // generated from another seed (an older way of rolling names)
    const key = JSON.stringify((w && w.look) || null);
    if (d.customKey === key) return;
    d.customKey = key;
    d.look = withCustom(lookOf(d.id, d.role), w && w.look, d.role);
    d.beard = (w && w.look && w.look.beardColor) || d.baseBeard;
  }
  // A lead's display name: yours if you gave it one, else the generated one.
  // A lead's name: your first name and surname where you chose them, the generated parts otherwise.
  const nameParts = (d) => {
    const [first, last] = dwarfName(d.nameSeed || d.nameKey || d.sessionId).split(' ');
    return [d.firstName || first, d.lastName || last];
  };
  const nameOf = (d) => nameParts(d).join(' ');

  // The dwarf's pixel rows with its own features worked in (row numbers refer to BODY above).
  function dwarfRows(rows, look) {
    const g = rows.map((r) => r.split(''));
    const set = (y, x, ch) => { if (g[y] && x >= 0 && x < g[y].length) g[y][x] = ch; };
    const beardish = (ch) => ch === 'b' || ch === 'B' || ch === 'd';
    if (look.beard === 'short') { // ends at the chest: tunic below
      for (const y of [9, 10]) g[y] = g[y].map((ch) => (beardish(ch) ? 't' : ch));
    } else if (look.beard === 'forked') {
      set(10, 5, 'T'); set(10, 6, 'T');
    } else if (look.beard === 'braided') {
      // one thick braid down the middle: light and dark strands crossing, a gold ring, the tip hanging
      // below the belt between the legs
      // starting right under the eyes
      for (let y = 6; y <= 11; y++) if (y !== 10) { set(y, 5, y % 2 ? 'D' : 'd'); set(y, 6, y % 2 ? 'd' : 'D'); }
      set(10, 5, 'g'); set(10, 6, 'g');
      set(12, 5, 'd'); set(13, 5, 'D');
    } else if (look.beard === 'twin') {
      // two braids hanging from the cheeks down both sides of the beard, gold rings at the chest,
      // tips past the belt
      for (const x of [3, 7]) {
        for (let y = 5; y <= 12; y++) set(y, x, y === 10 ? 'g' : y % 2 ? 'd' : 'D');
      }
    }
    // a big nose from between the eyes out over the beard, the way the dwarf is looking (sprites face right)
    if (look.bigNose) { set(5, 5, 'u'); set(5, 6, 'u'); set(5, 7, 'n'); }
    if (look.buckle) { set(11, 4, 'g'); set(11, 5, 'g'); }
    // a horn on each side of the helmet: one behind, one in front beside the lamp
    if (look.horn) {
      set(1, 2, 'w'); set(0, 2, 'w'); set(0, 1, 'W'); set(2, 1, 'W');
      set(1, 8, 'w'); set(0, 8, 'w'); set(0, 9, 'W'); set(2, 9, 'W');
    }
    return g.map((r) => r.join(''));
  }

  function bodySprite(sp, tunic, beard, legs, grey, look) {
    const key = [sp.name, tunic, beard, legs, grey, look ? look.key : ''].join('|');
    let c = sprites.get(key);
    if (c) return c;
    // one pixel of padding all round for a dark outline, so the sprite reads against rock and sky
    c = makeCanvas(sp.w + 2, sp.h + 2);
    const x = c.getContext('2d');
    const tone = (hex, k) => '#' + [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k))
      .toString(16).padStart(2, '0')).join('');
    const pal = {
      // the dwarf's base colours (looks and Customise change some of them)
      H: '#212b33', h: '#44474d', q: '#8a8d8f', L: '#fdea46', l: '#fcf59f', Y: '#edbc36', // helmet, brim, housing, lamp
      s: '#d5a076', S: '#bb8565', e: '#212b33', N: '#f0b88e', n: '#d8785e', u: '#d48e69', K: '#1e1a1a',               // skin, hands, eyes, noses
      b: beard, B: tone(beard, 0.8), d: tone(beard, 1.18), D: tone(beard, 0.62),          // beard, its shadow, streaks, braid shadow
      t: tunic, T: tone(tunic, 0.69), k: tone(tunic, 1.05), g: '#e8b923',                 // tunic, shadow, hem, buckle
      p: '#5b4733', o: '#212b33', x: '#18181c', r: '#c8382c', R: '#9e2a22',               // trousers, boots, gnome hat
      w: '#ece3cc', W: '#bfb291',                                        // horn
    };
    if (look) {
      [pal.H, pal.h] = look.helm;
      [pal.r, pal.R] = look.hat;
      pal.o = look.boots;
      if (look.skin) { // face, hands, and the nose: lighter, with a ruddy shade
        pal.s = look.skin; pal.S = tone(look.skin, 0.88); pal.N = tone(look.skin, 1.12);
        pal.u = blend(look.skin, '#d0503a', 0.22, 1); pal.n = blend(look.skin, '#c0503a', 0.4, 1); // nose, nose tip
      }
    }
    let rows = sp.body.concat(sp.legs[legs]);
    if (look && sp.name === 'dwarf') rows = dwarfRows(rows, look);
    const filled = (i, y) => y >= 0 && y < rows.length && i >= 0 && i < rows[y].length && rows[y][i] !== '.';
    x.fillStyle = grey ? '#24262b' : '#140d09';
    for (let y = -1; y <= rows.length; y++) for (let i = -1; i <= sp.w; i++) {
      if (!filled(i, y) && (filled(i - 1, y) || filled(i + 1, y) || filled(i, y - 1) || filled(i, y + 1))) {
        x.fillRect(i + 1, y + 1, 1, 1);
      }
    }
    rows.forEach((row, y) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '.') continue;
        x.fillStyle = grey ? greyOf(pal[ch]) : pal[ch];
        x.fillRect(i + 1, y + 1, 1, 1);
      }
    });
    sprites.set(key, c);
    return c;
  }

  function drawPick(c, ox, oy, a, d) {
    const [main, edge] = d.done ? ['#8a8f99', '#5d6578'] : TIERS[d.tier || 'wood'];
    const sp = d.spec, len = sp.handle, half = sp.head, arm = Math.round(len * 0.3);
    const cs = Math.cos(a), sn = Math.sin(a), sx = ox + sp.sx, sy = oy + sp.sy;
    for (let i = 0; i <= len; i++) {
      c.fillStyle = i < arm ? (d.done ? greyOf(d.tunic) : d.tunic) : i === arm ? '#f0c08a' : '#8b5a2b';
      c.fillRect(Math.floor(sx + cs * i), Math.floor(sy + sn * i), 1, 1);
    }
    const ex = sx + cs * len, ey = sy + sn * len;
    for (let j = -half; j <= half; j++) {
      const back = (j * j) / (half * half) * (half * 0.55);
      c.fillStyle = Math.abs(j) === half ? edge : main;
      c.fillRect(Math.floor(ex - sn * j - cs * back), Math.floor(ey + cs * j - sn * back), 1, 1);
      if (Math.abs(j) < 2) c.fillRect(Math.floor(ex - sn * j - cs * (back + 1)), Math.floor(ey + cs * j - sn * (back + 1)), 1, 1);
    }
  }

  function drawDwarf(c, d) {
    const legs = d.state === 'walk' ? (Math.floor(d.walkT * 9) % 2 ? 'B' : 'A')
      : d.state === 'climb' ? (Math.floor(d.walkT * 7) % 2 ? 'C' : 'A') : 'A';
    const bob = (d.state === 'walk' && legs === 'B') || (d.state === 'dig' && d.phase > 0.68 && d.phase < 0.8) ? 1 : 0;
    const sp = d.spec, cx = Math.round(d.x), ox = cx - sp.ax, oy = Math.round(d.y) - sp.h + bob;
    c.save();
    if (d.face < 0) { c.translate(cx * 2, 0); c.scale(-1, 1); }
    const body = bodySprite(sp, d.tunic, d.beard, legs, d.done, d.look);
    if (d.prop === 'sack') { drawSack(c, ox, oy, d); c.drawImage(body, ox - 1, oy - 1); }
    else if (d.prop === 'lantern') { c.drawImage(body, ox - 1, oy - 1); drawLantern(c, ox, oy, d); }
    else {
      const push = d.state === 'cart' ? Math.round(Math.sin(d.phase * Math.PI * 2) * 1.5) : 0; // leans into the cart
      const a = d.pickAngle(), behind = a < -1.2;
      if (behind) drawPick(c, ox + push, oy, a, d);
      c.drawImage(body, ox + push - 1, oy - 1);
      if (!behind) drawPick(c, ox + push, oy, a, d);
      if (ACT_DRAW[d.state]) ACT_DRAW[d.state](c, ox + push, oy, d);
    }
    c.restore();
  }

  // Where a lantern-carrying gnome holds its lantern (world pixels), swaying a little as it walks.
  function lanternPos(d) {
    const sway = d.state === 'walk' || d.state === 'climb' ? Math.round(Math.sin(d.walkT * 9)) : 0;
    return [Math.round(d.x) + d.face * (d.spec.w - d.spec.ax + 1) + sway * d.face, Math.round(d.y) - 5];
  }

  // drawn in sprite space (facing right): a ring, a dark frame and lit glass just in front of the hand
  function drawLantern(c, ox, oy, d) {
    lanternAt(c, ox + d.spec.w + (d.state === 'walk' ? Math.round(Math.sin(d.walkT * 9)) : 0), oy + d.spec.h - 6, d);
  }
  function lanternAt(c, x, y, d) {
    const dark = '#2a2a2a';
    c.fillStyle = d.done ? '#8a8f99' : '#d5a076'; c.fillRect(x - 1, y - 1, 1, 1);   // the hand's reach
    c.fillStyle = dark; c.fillRect(x, y - 2, 2, 1); c.fillRect(x - 1, y - 1, 4, 1); c.fillRect(x - 1, y + 3, 4, 1);
    c.fillStyle = dark; c.fillRect(x - 1, y, 1, 3); c.fillRect(x + 2, y, 1, 3);
    c.fillStyle = d.done ? '#9a9ea6' : '#ffd75e'; c.fillRect(x, y, 2, 3);
    c.fillStyle = d.done ? '#c9ccd2' : '#fff3b0'; c.fillRect(x, y, 1, 1);
  }

  // ---- tool animations (sprite space, facing right; ox, oy = the body's top left) ----------------
  const px = (c, x, y, color) => { c.fillStyle = color; c.fillRect(x, y, 1, 1); };
  // small held items: a dark outline like the sprites have, then the pixels ([x, y, colour] each)
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function outlined(c, pts, done) {
    const has = (x, y) => pts.some((p) => p[0] === x && p[1] === y); // a few points: a scan beats a Set
    c.fillStyle = done ? '#24262b' : '#140d09';
    for (const [x, y] of pts) for (const [dx, dy] of NEIGHBOURS) {
      if (!has(x + dx, y + dy)) c.fillRect(x + dx, y + dy, 1, 1);
    }
    for (const [x, y, color] of pts) px(c, x, y, done ? greyOf(color) : color);
  }
  const ease = (t) => t * t * (3 - 2 * t);
  // inspect: a hand lantern raised to eye height, bobbing slowly
  const inspectLantern = (d) => [d.spec.w, d.spec.eye[1] + (d.phase < 0.5 ? 0 : 1)];
  const ACT_DRAW = {
    inspect(c, ox, oy, d) {
      const [x, y] = inspectLantern(d);
      lanternAt(c, ox + x, oy + y, d);
    },
    // chisel: a chisel against the rock at chest height, a hammer swinging onto it from the hand
    chisel(c, ox, oy, d) {
      const sp = d.spec, cy = oy + Math.round(sp.sy) - 1, cx = ox + sp.w;
      const chisel = [[cx, cy, '#d5a076'], [cx + 1, cy, '#9aa3ad'], [cx + 2, cy, '#9aa3ad'], [cx + 3, cy, '#d8dde3']];
      // the hammer swings from the shoulder, up past the helmet and down onto the chisel's end
      const hx0 = cx - 1, hy0 = cy - 3;
      const t = d.phase < 0.5 ? ease(d.phase / 0.5) : 1 - ease((d.phase - 0.5) / 0.5);
      const a = -0.4 + 3.1 * t, len = 3; // up and back at rest, forward and down onto the chisel on the hit
      const hammer = [];
      for (let i = 1; i < len; i++) hammer.push([Math.round(hx0 + Math.sin(a) * i), Math.round(hy0 - Math.cos(a) * i), '#8b5a2b']);
      const ex = Math.round(hx0 + Math.sin(a) * len), ey = Math.round(hy0 - Math.cos(a) * len);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) hammer.push([ex + dx - (Math.sin(a) < 0 ? 1 : 0), ey + dy - 1, '#5d6168']);
      outlined(c, chisel, d.done);
      outlined(c, hammer, d.done);
    },
    // cart: a small ore cart in front, loaded with ore of the pick's tier
    cart(c, ox, oy, d) {
      const rows = ['.o.oo..', 'mmmmmmm', 'mWWWWWm', '.mWWWm.', '.k...k.'];
      const ore = d.done ? '#9aa0aa' : TIERS[d.tier || 'wood'][0];
      const col = { o: ore, m: '#5d6168', W: '#7a5030', k: '#1e1a1a' };
      const x0 = ox + d.spec.w, y0 = oy + d.spec.h - rows.length;
      rows.forEach((row, y) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.') px(c, x0 + i, y0 + y, col[row[i]]); });
    },
    // scout: a brass spyglass at the eye, panning up and down a little
    scout(c, ox, oy, d) {
      const [ex, ey] = d.spec.eye, tilt = d.phase < 0.33 ? 0 : d.phase < 0.66 ? 1 : 2;
      const glass = [[ox + ex + 2, oy + ey + 1, '#d5a076']]; // the hand holding it
      for (let i = 0; i < 6; i++) {
        glass.push([ox + ex + 1 + i, oy + ey - Math.floor(i * tilt / 5),
          i === 0 || i === 3 ? '#8a6d2a' : i === 5 ? (d.phase % 0.33 < 0.08 ? '#f4fbff' : '#a9c7dc') : '#c9a646']);
      }
      outlined(c, glass, d.done);
    },
    // call: the front arm up, waving the gnomes over
    call(c, ox, oy, d) {
      // the front arm raised beside the helmet, tipping back and forth
      const sp = d.spec, x = ox + sp.w - 1, y = oy + Math.round(sp.sy) - 3, skin = '#d5a076';
      const arm = d.phase < 0.5
        ? [[x, y, d.tunic], [x, y - 1, d.tunic], [x, y - 2, d.tunic], [x, y - 3, skin], [x, y - 4, skin]]
        : [[x, y, d.tunic], [x + 1, y - 1, d.tunic], [x + 1, y - 2, d.tunic], [x + 2, y - 3, skin], [x + 2, y - 4, skin]];
      outlined(c, arm, d.done);
    },
  };

  // a cloth sack slung on the back (behind the body)
  function drawSack(c, ox, oy, d) {
    const rows = ['..t..', '.sss.', 'sssss', 'ssssS', 'ssssS', '.sSS.'];
    const col = d.done ? { t: '#5d6578', s: '#8a8f99', S: '#6b7079' } : { t: '#5a3a20', s: '#a8743e', S: '#7a5030' };
    rows.forEach((row, y) => {
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '.') continue;
        c.fillStyle = col[row[i]];
        c.fillRect(ox - 3 + i, oy + 6 + y, 1, 1);
      }
    });
    c.fillStyle = '#140d09';
    c.fillRect(ox - 3, oy + 12, 5, 1); // ground shadow line under the sack
  }

  function drawBoulder(c, d) {
    const bx = (d.tx + d.face) * TILE, by = (d.ty + 1) * TILE;
    const rows = ['..xxxx..', '.xxxxxx.', 'xxxxxxxx', 'xxxxxxxx', '.xxxxxx.'];
    rows.forEach((row, y) => {
      for (let i = 0; i < row.length; i++) {
        if (row[i] !== 'x') continue;
        c.fillStyle = y === 0 || (y === 1 && i < 3) ? '#6b625a' : '#544b44';
        c.fillRect(bx + 1 + i, by - 5 + y, 1, 1);
      }
    });
    c.fillStyle = TIERS[d.tier || 'wood'][0];
    c.fillRect(bx + 4, by - 3, 1, 1); c.fillRect(bx + 6, by - 2, 1, 1);
    c.fillStyle = '#1b1715';
    for (let i = 0; i < BOULDER_HP - d.boulder.hp; i++) c.fillRect(bx + 3 + i * 2, by - 4 + i, 1, 2);
  }

  // ---- decor --------------------------------------------------------------------------
  function line(c, x0, y0, x1, y1, color) {
    c.fillStyle = color;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      c.fillRect(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 1, 1);
    }
  }

  // The dwarves' tavern: a stone ground floor with shields on the wall and a bench, a timber-framed
  // upper floor under a steep slate roof, a stone chimney, the studded door in
  // a carved stone portal with a lantern, barrels with a keg and a mug, and a hanging sign with a mug of
  // ale. Drawn once into a sprite; the door lines up with the door tile the dwarves walk in and out of.
  // drawLodge adds what changes: dwarves in the windows, and embers in the chimney at night.
  const TAVERN_OX = 8, TAVERN_W = 68, TAVERN_H = 60; // sprite x = tavern x + 8; ground on the bottom row
  let tavernSprite = null;
  function tavern() {
    if (tavernSprite) return tavernSprite;
    tavernSprite = makeCanvas(TAVERN_W, TAVERN_H);
    const c = tavernSprite.getContext('2d');
    const R = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(x + TAVERN_OX, TAVERN_H + y, w, h); };
    const P = (x, y, color) => R(x, y, 1, 1, color);
    // barrel by the wall
    R(-7, -7, 5, 7, '#7a4f28'); R(-7, -7, 5, 1, '#9a6a3a'); R(-7, -5, 5, 1, '#3a3a3a'); R(-7, -2, 5, 1, '#3a3a3a');
    R(-8, -5, 1, 4, '#6a4322'); R(-2, -5, 1, 4, '#6a4322');
    R(-7, -11, 4, 4, '#7a4f28'); R(-7, -11, 4, 1, '#9a6a3a'); R(-7, -9, 4, 1, '#3a3a3a'); P(-3, -9, '#4b5058'); // keg and tap
    // timber-framed walls: plaster between dark beams, with braces in the first bay
    // the timber frame over the stone: two-pixel posts and rails with a lit edge (as chunky as the rest of
    // the art), a chunky X brace in the first bay, plaster with a soft shadow under the top beam
    R(1, -31, 46, 17, '#d2bb8e'); R(1, -30, 46, 1, '#c2aa7c'); R(1, -16, 46, 2, '#b9a277');
    const beam = (x, y, w, h) => { R(x, y, w, h, '#4a2e1a'); if (w > h) R(x, y, w, 1, '#6b4528'); else R(x, y, 1, h, '#6b4528'); };
    beam(0, -32, 48, 2); beam(1, -20, 46, 2);      // top plate, mid rail
    for (const px of [1, 15, 29, 45]) beam(px, -31, 2, 17);
    beam(-1, -14, 50, 2);                          // the sill beam on the stone
    for (let i = 0; i < 11; i++) {                 // X brace: two crossing two-pixel timbers
      R(3 + i, -21 - i, 2, 1, '#4a2e1a'); R(12 - i, -21 - i, 2, 1, '#4a2e1a');
      if (i % 2) { P(3 + i, -21 - i, '#6b4528'); P(12 - i, -21 - i, '#6b4528'); }
    }
    // two lit windows with crossed mullions and a sill
    for (const wx of [18, 37]) {
      R(wx - 1, -29, 8, 8, '#4a2e1a'); R(wx, -28, 6, 6, '#ffcf6b'); R(wx, -27, 3, 2, '#ffe9a8');
      R(wx + 2, -28, 1, 6, '#4a2e1a'); R(wx, -25, 6, 1, '#4a2e1a'); R(wx - 2, -21, 10, 1, '#6f6a63');
    }
    // stone foundation: offset courses of blocks over mortar, lighter top edge
    R(-1, -12, 50, 12, '#4c4842');
    for (let row = 0; row < 4; row++) {
      for (let x = row % 2 ? -4 : -1; x < 49; x += 7) {
        const x0 = Math.max(-1, x), x1 = Math.min(49, x + 6);
        R(x0, -12 + row * 3, x1 - x0, 2, ['#77716a', '#6f6a63', '#837c73'][(x + row * 5 + 21) % 3]);
      }
    }
    // round shields on the stone: a red one with a gold cross, a blue one with a gold boss
    const shield = (x, y, field, mark) => {
      R(x + 1, y, 3, 1, '#4b5058'); R(x, y + 1, 5, 3, '#4b5058'); R(x + 1, y + 4, 3, 1, '#4b5058');
      R(x + 1, y + 1, 3, 3, field); P(x + 2, y, '#8a929c');
      if (mark === 'cross') { R(x + 2, y + 1, 1, 3, '#e8b923'); R(x + 1, y + 2, 3, 1, '#e8b923'); } else P(x + 2, y + 2, '#e8b923');
    };
    shield(5, -11, '#9e2a22', 'cross');
    shield(43, -11, '#2f5f9e', 'boss');
    // a bench along the wall, with a mug of ale on it
    R(2, -4, 11, 1, '#8b6a45'); R(2, -3, 11, 1, '#5e3c1f'); R(3, -2, 1, 2, '#4a2e1a'); R(11, -2, 1, 2, '#4a2e1a');
    R(9, -6, 2, 2, '#e8a33a'); R(9, -7, 2, 1, '#fff4d6'); P(11, -6, '#c47f22');
    // the iron-studded door in a carved dwarven portal (lines up with the door tile): blocky stone jambs
    // in courses, an arch of wedge stones with a keystone, gold runes cut into the jambs
    {
      const cx = 35, base = -12, inner = 4, outer = 7;
      for (const jx of [28, 39]) { // jambs
        R(jx, base, 3, -base, '#77716a');
        for (let y = base; y < 0; y += 3) { R(jx, y, 3, 1, '#8c867d'); R(jx + (((y - base) / 3) % 2 ? 2 : 0), y + 1, 1, 2, '#5c5750'); }
      }
      R(27, -1, 16, 1, '#4c4842'); // threshold
      for (let y = base - outer; y < base; y++) for (let x = cx - outer; x < cx + outer; x++) { // arch and door top
        const d = Math.hypot(x + 0.5 - cx, base - y - 0.5);
        if (d >= outer) continue;
        if (d < inner) { P(x, y, '#3a2414'); continue; }
        const a = Math.atan2(base - y - 0.5, x + 0.5 - cx), seam = Math.abs(((a / Math.PI) * 5) % 1 - 0.5) > 0.4;
        P(x, y, seam ? '#5c5750' : d > outer - 1.2 ? '#8c867d' : '#77716a');
      }
      R(34, base - outer, 2, 3, '#9a948a'); P(34, base - outer + 1, '#e8b923'); P(35, base - outer + 1, '#e8b923'); // keystone, rune
      for (const [rx, ry] of [[29, -9], [29, -8], [30, -8], [40, -9], [40, -8], [39, -8]]) P(rx, ry, '#e8b923'); // jamb runes
      R(31, base, 8, -base - 1, '#3a2414'); // the door below the arch
    }
    R(33, -16, 1, 15, '#2a190d'); R(36, -16, 1, 15, '#2a190d');
    for (const [sx, sy] of [[32, -12], [37, -12], [32, -5], [37, -5]]) P(sx, sy, '#a8aeb6');
    P(36, -8, '#d4a93a'); P(35, -8, '#d4a93a');
    // lantern on a bracket beside the door
    R(41, -20, 3, 1, '#2a2a2a'); R(43, -19, 1, 1, '#2a2a2a'); R(42, -18, 3, 4, '#2a2a2a'); R(43, -17, 1, 2, '#ffd75e');
    // steep slate roof with an overhang, shingle courses, a little moss and a dark ridge
    for (let k = 0; k < 18; k++) {
      const left = Math.round(-5 + k * 1.45), right = Math.round(53 - k * 1.45);
      R(left, -33 - k, right - left, 1, k % 3 === 0 ? '#353a46' : '#424857');
      if (k % 3 === 1) for (let x = left + (k % 2) * 2; x < right; x += 4) P(x, -33 - k, '#2e323d');
    }
    R(-5, -32, 58, 1, '#23262e');
    for (const [mx, my] of [[4, -35], [9, -38], [40, -36], [44, -34], [24, -46]]) P(mx, my, '#5d7d48');
    R(21, -51, 6, 1, '#2a2e38');
    // stone chimney through the roof
    R(36, -56, 6, 18, '#6f6a63'); R(36, -50, 6, 1, '#4c4842'); R(36, -44, 6, 1, '#4c4842');
    R(35, -57, 8, 2, '#4c4842'); R(37, -55, 1, 4, '#837c73');
    // hanging sign with a mug of ale
    R(47, -28, 10, 1, '#2a2a2a'); P(49, -27, '#2a2a2a'); P(55, -27, '#2a2a2a');
    R(48, -26, 9, 8, '#4a2e1a'); R(49, -25, 7, 6, '#8a5a30');
    R(51, -24, 3, 4, '#e8a33a'); R(51, -25, 3, 1, '#fff4d6'); P(54, -23, '#e8a33a'); P(54, -22, '#e8a33a'); P(51, -21, '#c47f22');
    return tavernSprite;
  }

  function drawLodge(c, lights) {
    const x0 = (G.SX - 7) * TILE, b = GRASS * TILE;
    c.drawImage(tavern(), x0 - TAVERN_OX, b - TAVERN_H);
    const R = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(x0 + x, b + y, w, h); };
    // finished dwarves resting inside show as silhouettes against the lit windows (one per window)
    const inside = restingLeads().length;
    for (const [i, wx] of [18, 37].entries()) {
      if (inside <= i) continue;
      R(wx + 2, -26, 2, 1, '#4a2e1a');          // helmet
      R(wx + 1, -25, 4, 1, '#4a2e1a');          // brim
      R(wx + 2, -24, 2, 1, '#7a4a22');          // face
      R(wx + 1, -23, 4, 1, '#5a3a20');          // beard and shoulders
    }
    // embers in the chimney after dark
    const night = 1 - daylight();
    if (night > 0.05) {
      c.globalAlpha = night * (0.7 + 0.3 * Math.abs(wave(3)));
      R(37, -58, 4, 1, '#ff8a3a'); R(38, -59, 2, 1, '#ffc46b');
      c.globalAlpha = 1;
      lights.push({ x: x0 + 39, y: b - 58, r: 8 * night });
    }
    lights.push({ x: x0 + 21, y: b - 25, r: 20 }, { x: x0 + 40, y: b - 25, r: 20 }, { x: x0 + 43, y: b - 16, r: 16 });
  }

  // Over the shaft: a dwarven windlass. Two stone pillars and a beam under a little slate roof (like the
  // tavern's), a drum with a crank between the pillars, the rope down to a bucket over the shaft, and a
  // lantern hung from the beam. The drum and crank turn only while someone is on the ladder.
  let wheelTurn = 0;
  function drawHeadframe(c, lights) {
    if (!G.order.length) return;
    const sx = G.SX * TILE, b = GRASS * TILE;
    const R = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(sx + x, b + y, w, h); };
    const hauling = G.haul && (G.haul.phase === 'down' || G.haul.phase === 'up');
    if ((hauling || [...G.dwarves.values()].some((d) => d.state === 'climb')) && !reduceMotion.matches) wheelTurn += 0.08;
    for (const px of [-6, 12]) { // stone pillars in courses
      R(px, -17, 4, 17, '#6f6a63');
      for (let y = -17; y < 0; y += 3) { R(px, y, 4, 1, '#837c73'); R(px + ((y / 3) % 2 ? 2 : 0), y + 1, 1, 2, '#4c4842'); }
      R(px - 1, -2, 6, 2, '#4c4842');
    }
    R(-7, -19, 24, 2, '#4a2e1a'); R(-7, -17, 24, 1, '#2e1c10'); // beam
    for (let k = 0; k < 8; k++) R(-9 + k * 1.5 | 0, -20 - k, 28 - (k * 3 | 0), 1, k % 3 === 0 ? '#353a46' : '#424857'); // roof
    R(-9, -20, 28, 1, '#23262e'); R(3, -28, 4, 1, '#2a2e38');
    // the drum: a log on an axle, with rings
    R(-2, -13, 14, 4, '#8b5a2b'); R(-2, -13, 14, 1, '#a8763f'); R(-2, -10, 14, 1, '#5e3c1f');
    const ring = Math.round(wheelTurn * 3) % 4;
    for (const rx of [0, 4, 8]) R(rx + (ring % 2), -13, 1, 4, '#5e3c1f');
    R(16, -12, 3, 1, '#4b5058'); R(18, -12 + (Math.round(wheelTurn * 2) % 2 ? 0 : 2), 1, 3, '#4b5058'); // crank
    // rope and bucket: resting over the shaft, or down it on a haul with the ore on top
    const by = (G.haul ? Math.round(G.haul.y) : b + BUCKET_REST) - b;
    R(5, -9, 1, by + 9, '#c9b08a'); R(3, by, 5, 4, '#6b4a2f'); R(3, by + 1, 5, 1, '#4b5058'); R(4, by, 3, 1, '#8b6a45');
    if (G.haul) G.haul.load.forEach((shade, i) => R(3 + (i % 5), by - 1 - Math.floor(i / 5), 1, 1, TIERS[G.haul.tier][shade]));
    // lantern hung from the beam
    R(-3, -16, 1, 2, '#2a2a2a'); R(-4, -14, 3, 4, '#2a2a2a'); R(-3, -13, 1, 2, '#ffd75e');
    lights.push({ x: sx - 3, y: b - 12, r: 20 + wave(7) });
  }

  // ---- hauling ore up -------------------------------------------------------------------
  // Carts are kept by the server (see server.js), so no ore is lost to a restart or a closed session.
  // Here: a lump landing in a cart is reported (by the one view the server picked to report), and when a
  // cart is full, or its session's turn is over with ore still in it, the windlass lowers its bucket to
  // that tunnel, the ore hops in, the drum winds it up, and it is tipped onto the store; only then is the
  // haul reported, so ore in the bucket during a shutdown simply stays in the cart. Other views just show
  // the carts and the store as the server has them.
  const BUCKET_REST = -5, BUCKET_SPEED = 45; // bucket top above the ground (px); px per second
  const bucketX = () => G.SX * TILE + 5;
  function landInCart(g) {
    if (!G.reporter) return; // the reporting view's count comes back with the next poll
    g.gems++;
    g.unsent = (g.unsent || 0) + 1;
    if (G.hooks.onMine) G.hooks.onMine(g.id, g.tier || 'wood', () => { g.unsent = Math.max(0, g.unsent - 1); });
    else g.unsent--;
  }
  function updateHaul(dt) {
    if (!G.reporter) { G.haul = null; return; }
    const b = GRASS * TILE;
    let H = G.haul;
    if (!H) {
      const g = [...G.galleries.values()].find((x) => x.level != null && !x.hauling &&
        (x.gems >= CART_FULL || (x.idle && x.gems > 0)));          // full, or the turn is over: take what there is
      if (!g) return;
      H = G.haul = { g, phase: 'down', y: b + BUCKET_REST, load: [], waiting: 0 };
    }
    // a subsession's ore climbs its side shafts to the gallery on the main shaft; the bucket meets it there
    const g = H.g, route = routeUp(g), bottom = (route.top.r0 + 3) * TILE - 6;
    if (H.phase === 'down') {
      H.y = Math.min(bottom, H.y + BUCKET_SPEED * dt);
      if (H.y < bottom) return;
      // tip the cart into the bucket
      const [cx, cy] = cartPos(g);
      const n = Math.min(CART_FULL, g.gems);
      g.gems -= n; g.hauling = (g.hauling || 0) + n; // still in the server's cart until it is tipped
      H.tier = g.tier || 'wood'; H.n = n;
      H.limit = 3;
      for (let i = 0; i < n; i++) {
        const pts = [[cx + (i % 4) - 2, cy - 1], ...route.pts, [bucketX() + (i % 3) - 1, bottom]];
        H.limit = Math.max(H.limit, 3 + flyAlong(pts, TIERS[H.tier][i % 3 ? 0 : 1], i * 0.018, () => H.load.push(i % 3 ? 0 : 1)));
      }
      H.phase = 'load';
    } else if (H.phase === 'load') {
      if (H.load.length >= H.n || (H.waiting += dt) > H.limit) H.phase = 'up';
    } else if (H.phase === 'up') {
      H.y = Math.max(b + BUCKET_REST, H.y - BUCKET_SPEED * dt);
      if (H.y > b + BUCKET_REST) return;
      // tip the bucket onto the store
      const [sx, sy] = storeTop();
      const k = H.load.length;
      H.load.forEach((shade, i) => {
        G.gems.push({ x0: bucketX(), y0: H.y, x1: sx + (i % 5) * 2 - 4, y1: sy, t: -i * 0.05, dur: 0.6,
          color: TIERS[H.tier][shade], done: i === k - 1 ? () => deposit(H) : () => {} });
      });
      if (!k) deposit(H);
      H.load = [];
      H.phase = 'tip';
    }
  }
  // A lump of ore hopping from point to point (the cart, the foot and top of each side shaft, the bucket):
  // one hop straight to the bucket from a gallery on the main shaft, small hops up the ladders otherwise.
  // Returns the seconds the whole way takes.
  function flyAlong(pts, color, wait, done) {
    const hops = pts.length - 1;
    const durOf = (a, b) => (hops === 1 ? 0.45 : Math.max(0.15, Math.hypot(b[0] - a[0], b[1] - a[1]) / 110));
    const hop = (k, delay) => {
      const [a, b] = [pts[k], pts[k + 1]], dur = durOf(a, b);
      G.gems.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], t: -delay / dur, dur, color, arc: hops === 1 ? 14 : 4,
        done: k + 1 < hops ? () => hop(k + 1, 0) : done });
    };
    hop(0, wait);
    let total = wait;
    for (let k = 0; k < hops; k++) total += durOf(pts[k], pts[k + 1]);
    return total;
  }
  function deposit(H) {
    const g = H.g;
    G.store[H.tier] = (G.store[H.tier] || 0) + H.n; // shown at once; the server's total follows
    const done = () => { g.hauling = Math.max(0, (g.hauling || 0) - H.n); };
    if (H.n && G.hooks.onHaul) G.hooks.onHaul(g.id, H.n, done); else done();
    if (G.haul === H) G.haul = null;
  }

  // The ore store: a timber bin beside the windlass with a heap of ore that grows with the total, its
  // colours mixed in proportion to the ore of each pickaxe tier.
  const STORE_X = 23, STORE_W = 15; // from the shaft's left edge, in world px
  const storeTotal = () => Object.values(G.store).reduce((a, n) => a + (n || 0), 0);
  const heapHeight = () => { const t = storeTotal(); return t ? Math.min(12, Math.round(2 + Math.log2(1 + t / CART_FULL) * 2)) : 0; };
  const storeTop = () => [G.SX * TILE + STORE_X + STORE_W / 2, GRASS * TILE - 5 - heapHeight()];
  function drawStore(c) {
    if (!G.order.length) return;
    const x0 = G.SX * TILE + STORE_X, b = GRASS * TILE;
    const R = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(x0 + x, b + y, w, h); };
    const total = storeTotal(), H = heapHeight();
    if (total) {
      // pick a tier per pixel, weighted by how much of each there is (fixed per pixel, so it doesn't flicker)
      const tiers = Object.entries(G.store).filter(([, n]) => n > 0);
      for (let x = 0; x < STORE_W; x++) {
        const u = (x + 0.5) / STORE_W * 2 - 1, h = Math.round(H * Math.pow(Math.max(0, 1 - u * u), 0.7));
        for (let y = 0; y < h; y++) {
          let pickU = rand01(x, y, 77) * total, tier = tiers[0][0];
          for (const [t, n] of tiers) { if (pickU < n) { tier = t; break; } pickU -= n; }
          R(x, -5 - 1 - y, 1, 1, TIERS[tier][rand01(x, y, 78) < 0.3 ? 1 : 0]);
        }
      }
    }
    // the bin: planks, a rim, two posts
    R(-1, -5, STORE_W + 2, 5, '#6b4a2f'); R(-1, -5, STORE_W + 2, 1, '#8b6a45'); R(-1, -3, STORE_W + 2, 1, '#5a3d27');
    R(-1, -5, 1, 5, '#4a2e1a'); R(STORE_W, -5, 1, 5, '#4a2e1a'); R(-1, -1, STORE_W + 2, 1, '#3a2414');
  }

  function drawGallery(c, g, lights) {
    const ex = (g.ox + g.dir) * TILE, top = g.r0 * TILE, floor = (g.r0 + 3) * TILE;
    // support frames every few tiles
    for (let j = 1; j <= g.len; j += 5) {
      const fx = (g.ox + g.dir * j) * TILE + (g.dir > 0 ? 0 : TILE - 2);
      c.fillStyle = '#5a3d27';
      c.fillRect(fx, top, 2, floor - top);
      c.fillStyle = '#6b4a2f';
      c.fillRect(fx - (g.dir > 0 ? 0 : 6), top, 8, 2);
    }
    // lantern
    const lx = ex + TILE / 2, fl = 1 + wave(9, g.r0) * 0.6;
    c.fillStyle = '#3a2a1e'; c.fillRect(lx, top + 2, 1, 2);
    c.fillStyle = '#ffd75e'; c.fillRect(lx - 1, top + 4, 3, 3);
    lights.push({ x: lx, y: top + 6, r: 24 + fl });
    // cart with ore
    const [cx, cy] = cartPos(g);
    c.fillStyle = '#3d3f45'; c.fillRect(cx - 5, cy, 10, 1);
    c.fillStyle = '#5d6068'; c.fillRect(cx - 4, cy + 1, 8, 4);
    c.fillStyle = '#1b1b1f'; c.fillRect(cx - 3, cy + 5, 2, 2); c.fillRect(cx + 1, cy + 5, 2, 2);
    const n = Math.min(g.gems, 12), [main, edge] = TIERS[g.tier || 'wood'];
    for (let i = 0; i < n; i++) {
      const row = i < 6 ? 0 : i < 10 ? 1 : 2, col = i < 6 ? i : i < 10 ? i - 6 : i - 10;
      c.fillStyle = (i % 3 === 0) ? edge : main;
      c.fillRect(cx - 3 + row + col, cy - 1 - row, 1, 1);
    }
    // cracks in the face
    if (g.dmg > 0 && g.len < g.max) {
      const fx = (g.ox + g.dir * (g.len + 1)) * TILE;
      c.fillStyle = '#1b1715';
      for (let y = g.r0; y < g.r0 + 3; y++) {
        CRACKS.slice(0, g.dmg * 3).forEach(([px, py]) => c.fillRect(fx + (g.dir > 0 ? px : TILE - 1 - px), y * TILE + py, 1, 1));
      }
    }
  }

  // ---- light as pixel art ---------------------------------------------------------------
  // No smooth gradients: light is drawn at the art's own resolution, in a few hard steps, with an
  // ordered (Bayer) dither where one step meets the next, the way pixel-art games do it.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];
  // i in 0..1 cut into hard steps; with dither, pixels near a step boundary are spread by the Bayer pattern.
  const stepped = (i, x, y, steps = 3, dither = true) =>
    Math.max(0, Math.min(steps, Math.floor(i * steps + (dither ? bayer(x, y) : 0.5)))) / steps;

  // A round light as a cached sprite: 'hole' cuts the darkness, 'warm' and 'firefly' add colour.
  const lightCache = new Map();
  function lightSprite(r, kind) {
    r = Math.max(2, Math.round(r));
    const key = kind + r;
    let canvas = lightCache.get(key);
    if (canvas) return canvas;
    canvas = makeCanvas(r * 2 + 1, r * 2 + 1);
    const c = canvas.getContext('2d');
    // Underground lights use clean rings (4 steps, dithered only at the very edge) so the tunnels stay calm;
    // the warm tint is just 2 soft rings. Fireflies keep the full dither.
    const [rgb, strength, steps] = {
      hole: ['0,0,0', 1, 4], warm: ['255,170,80', 0.14, 2], firefly: ['200,255,120', 0.35, 3],
    }[kind];
    for (let y = 0; y <= r * 2; y++) for (let x = 0; x <= r * 2; x++) {
      const d = Math.hypot(x - r, y - r) / r;
      if (d >= 1) continue;
      const dither = kind === 'firefly' || (kind === 'hole' && d > 0.82);
      const level = stepped(1 - d, x, y, steps, dither);
      if (level <= 0) continue;
      c.fillStyle = `rgba(${rgb},${level * strength})`;
      c.fillRect(x, y, 1, 1);
    }
    lightCache.set(key, canvas);
    return canvas;
  }

  // The sun: a disc with a two-ring dithered halo of pale sky around it.
  // The moon: a pale pixel disc with a few darker craters and a faint, sparse dithered halo.
  function drawMoon(c, moon, alpha) {
    c.globalAlpha = alpha;
    const mx = Math.round(moon.x), my = Math.round(moon.y);
    for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) {
      const d = x * x + y * y, px = mx + x, py = my + y;
      if (d <= 36) c.fillStyle = rand01(x + 9, y + 9, 77) < 0.12 ? '#d6cba9' : '#f1e8c8';
      else if (d <= 100 && bayer(px, py) < 0.12) c.fillStyle = '#9fb0d6';
      else continue;
      c.fillRect(px, py, 1, 1);
    }
    c.globalAlpha = 1;
  }

  // low in the sky at dawn and dusk (warm > 0.5) the sun turns orange-red with a rosy halo
  function drawSun(c, sun, alpha, warm = 0) {
    c.globalAlpha = alpha;
    const sx = Math.round(sun.x), sy = Math.round(sun.y), low = warm > 0.5;
    const [core, rim, halo, outer] = low ? ['#ffd27a', '#ff8a3d', '#ffc2a0', '#ffd9c7'] : ['#fff0a0', '#ffc93d', '#fff6cf', '#e4f3ff'];
    for (let y = -11; y <= 11; y++) for (let x = -11; x <= 11; x++) {
      const d = x * x + y * y, px = sx + x, py = sy + y;
      if (d <= 25) c.fillStyle = core;
      else if (d <= 36) c.fillStyle = rim;
      else if (d <= 64 && bayer(px, py) < 0.5) c.fillStyle = halo;
      else if (d <= 121 && bayer(px, py) < 0.19) c.fillStyle = outer;
      else continue;
      c.fillRect(px, py, 1, 1);
    }
    c.globalAlpha = 1;
  }

  // Daylight down the shaft as a pixel beam: it cuts the darkness in dithered steps that thin out with
  // depth, and the brightest pixels get a pale warm tint. Returns the pixels to tint on the main canvas.
  const beamStyles = new Map();
  const beamStyle = (level) => {
    let st = beamStyles.get(level);
    if (!st) { if (beamStyles.size > 64) beamStyles.clear(); st = `rgba(0,0,0,${0.95 * level})`; beamStyles.set(level, st); }
    return st;
  };
  function shaftBeam(dc, sun, day, groundY) {
    const tint = [];
    if (day <= 0 || !G.order.length) return tint;
    const sx = G.SX * TILE, depth = shaftLight(groundY), tilt = sun.dir * depth * 0.4 * (1 - sun.arc);
    const top = groundY - TILE;
    for (let y = top; y < groundY + depth; y++) {
      const fall = (y - top) / (depth + TILE);
      const x0 = Math.round(sx - 1 - 5 * fall + tilt * fall), x1 = Math.round(sx + TILE + 1 + 5 * fall + tilt * fall);
      for (let x = x0; x < x1; x++) {
        const edge = Math.min(x - x0, x1 - 1 - x) < 1 ? 0.6 : 1; // softer one-pixel rim
        const level = stepped((1 - fall) * day * edge, x, y, 4, false); // clean bands down the shaft
        if (level <= 0) continue;
        dc.fillStyle = beamStyle(level);
        dc.fillRect(x, y, 1, 1);
        if (level >= 0.75) tint.push(x, y);
      }
    }
    return tint;
  }

  // Side view, so a shadow is a dark stretch of grass beside whatever casts it: the lodge, the
  // headframe, dwarves on the surface, and clouds drifting over.
  function drawShadows(c, sun, day, wpx) {
    if (day <= 0) return;
    const ground = GRASS * TILE;
    const strip = (x0, x1, height, strength) => {
      const len = height * sun.reach;
      const from = sun.dir > 0 ? x0 : x0 - len, to = sun.dir > 0 ? x1 + len : x1;
      const near = sun.dir > 0 ? x1 : x0;
      const g = c.createLinearGradient(near, 0, near + sun.dir * len, 0);
      g.addColorStop(0, `rgba(10,20,10,${0.38 * strength * day})`);
      g.addColorStop(1, 'rgba(10,20,10,0)');
      c.fillStyle = g;
      c.fillRect(Math.round(from), ground, Math.round(to - from), 3);
    };
    const lodgeX = (G.SX - 7) * TILE + 2;
    strip(lodgeX - 9, lodgeX + 55, 50, 1); // the tavern, barrel to sign
    if (G.order.length) strip(G.SX * TILE - 9, G.SX * TILE + 19, 28, 0.7); // the windlass house over the shaft
    for (const d of G.dwarves.values()) {
      if (visible(d) && d.ty === GRASS - 1 && !d.path.length) strip(d.x - 4, d.x + 4, d.spec.h, 0.9);
    }
    c.fillStyle = `rgba(10,20,10,${0.12 * day})`;
    for (const cl of G.clouds) {
      const x = Math.round(cl.x + sun.dir * (ground - cl.y) * sun.reach * 0.5);
      if (x < wpx && x + cl.w > 0) c.fillRect(x, ground, cl.w, 3);
    }
  }

  // How far daylight reaches down the shaft: to its bottom, at most 110 px.
  function shaftLight(groundY) {
    const bottom = (LEVEL_TOP + ((G.shaftLevels || 1) - 1) * LEVEL_STRIDE + 3) * TILE;
    return Math.max(0, Math.min(110, bottom - groundY));
  }

  // On top of the darkness: warm light around lamps and lanterns, dust drifting in the daylight down
  // the shaft, and fireflies over the grass at night.
  function drawGlow(c, lights, sun, day, wpx, hpx, groundY) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      // Above ground a lamp's glow fades out in daylight (a helmet lamp doesn't light up the noon sun);
      // underground it always shines. The lamp itself is part of the sprite and stays.
      const glow = L.y < groundY ? 1 - day : 1;
      if (glow <= 0.02) continue;
      const r = Math.round(L.r * 0.9);
      c.globalAlpha = glow;
      c.drawImage(lightSprite(r, 'warm'), Math.round(L.x) - r, Math.round(L.y) - r);
    }
    c.globalAlpha = 1;
    if (!reduceMotion.matches) {
      if (day > 0 && G.order.length) {
        const sx = G.SX * TILE, depth = shaftLight(groundY), tilt = sun.dir * depth * 0.4 * (1 - sun.arc);
        for (let i = 0; i < 14; i++) {
          const fall = ((G.time * (2 + rand01(i, 1, 50) * 3) + rand01(i, 2, 50) * depth) % depth) / depth;
          const x = sx + 5 + tilt * fall + Math.sin(G.time * 0.7 + i * 1.3) * 3;
          const y = groundY - TILE + fall * (depth + TILE);
          c.fillStyle = `rgba(255,240,200,${0.55 * day * (1 - fall)})`;
          c.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
      }
      if (day < 1) {
        const ground = GRASS * TILE;
        for (let i = 0; i < 9; i++) {
          const blink = Math.max(0, Math.sin(G.time * (1.6 + rand01(i, 3, 51)) + i * 2.1));
          if (blink <= 0) continue;
          const x = (rand01(i, 4, 51) * wpx + Math.sin(G.time * 0.25 + i) * 18 + wpx) % wpx;
          const y = ground - 3 - Math.abs(Math.sin(G.time * 0.4 + i * 1.7)) * 16;
          const a = (1 - day) * blink;
          c.globalAlpha = a;
          c.drawImage(lightSprite(4, 'firefly'), Math.round(x) - 4, Math.round(y) - 4);
          c.globalAlpha = 1;
          c.fillStyle = `rgba(230,255,150,${a})`;
          c.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
      }
    }
    c.restore();
  }

  // ---- loop ---------------------------------------------------------------------------
  function update(dt) {
    G.time += dt;
    for (const d of G.dwarves.values()) {
      d.update(dt);
      if (d.gone) { G.dwarves.delete(d.id); G.retired.add(d.id); }
    }
    const w = G.world;
    updateRockets(dt);
    G.particles = G.particles.filter((p) => {
      p.age += dt;
      if (p.age >= p.life) return false;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.bounce && w && p.vy > 0 && !w.open(Math.floor(p.x / TILE), Math.floor(p.y / TILE))) {
        p.y = Math.floor(p.y / TILE) * TILE - 0.01;
        p.vy *= -0.3; p.vx *= 0.5;
      }
      return true;
    });
    const landed = [];
    G.gems = G.gems.filter((m) => {
      m.t += dt / m.dur;
      if (m.t < 1) return true;
      landed.push(m);
      return false;
    });
    for (const m of landed) if (m.done) m.done(); else landInCart(m.g); // after: a done may start the next hop
    updateHaul(dt);
    for (const cl of G.clouds) {
      if (!reduceMotion.matches) cl.x += cl.v * dt;
      if (cl.x > G.tilesX * TILE + 20) cl.x = -cl.w - 10;
    }
    G.smokeT -= dt;
    if (G.smokeT <= 0 && !reduceMotion.matches && G.world) {
      G.smokeT = 0.5;
      G.particles.push({
        x: (G.SX - 7) * TILE + 39, y: GRASS * TILE - 58, vx: 3 + Math.random() * 3, vy: -6, g: -1,
        life: 3.2, age: 0, size: 2, color: 'smoke',
      });
    }
  }

  function render() {
    if (!G.world) return;
    const c = G.ctx, k = G.k, wpx = G.tilesX * TILE, hpx = G.rows * TILE;
    const lights = [];
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, G.canvas.width, G.canvas.height);
    c.setTransform(k, 0, 0, k, 0, 0);
    c.imageSmoothingEnabled = false;

    // back to front: sky, stars, dawn/dusk glow, the sun, then the landscape over it, so the sun can rise
    // from and sink behind the mountains
    const day = daylight(), sun = sunState(wpx);
    c.drawImage(G.sky, 0, 0);
    if (day > 0) { c.globalAlpha = day; c.drawImage(G.skyDay, 0, 0); c.globalAlpha = 1; }
    for (const s of G.stars) {
      c.globalAlpha = (1 - day) * (reduceMotion.matches ? 0.8 : 0.35 + 0.65 * Math.abs(wave(0.7, s.p)));
      c.fillStyle = '#e9ecff';
      c.fillRect(s.x, s.y, 1, 1);
    }
    c.globalAlpha = 1;
    const dusk = twilight(day); // only during sunrise and sunset, not the lunch-break dimming
    if (dusk > 0.01) {
      // the orange glow, strongest at the horizon, dithered like the sky (made once in drawSky)
      c.globalAlpha = dusk;
      c.drawImage(G.glow, 0, 0);
      c.globalAlpha = 1;
    }
    if (day > 0) drawSun(c, sun, Math.min(1, day * 2.5), dusk);
    const moon = moonState(wpx);
    if (moon && day < 1) drawMoon(c, moon, 1 - day);
    c.drawImage(G.skyLand, 0, 0);
    if (day > 0) { c.globalAlpha = day; c.drawImage(G.skyDayLand, 0, 0); c.globalAlpha = 1; }
    if (dusk > 0.01) { c.fillStyle = `rgba(255,120,60,${0.12 * dusk})`; c.fillRect(0, 0, wpx, GRASS * TILE); }
    c.globalAlpha = 0.16 + 0.76 * day; // faint at night, bright by day
    for (const cl of G.clouds) c.drawImage(cl.sprite, Math.round(cl.x), cl.y);
    c.globalAlpha = 1;
    c.drawImage(G.tiles, 0, 0);
    drawShadows(c, sun, day, wpx);

    drawLodge(c, lights);
    drawHeadframe(c, lights);
    drawStore(c);
    for (const id of G.order) drawGallery(c, G.galleries.get(id), lights);

    const crew = [...G.dwarves.values()].filter(visible).sort((a, b) => a.y - b.y || (a.role === 'lead') - (b.role === 'lead'));
    for (const d of crew) if (d.role === 'sub' && d.prop === 'pick' && d.atGoal() && !d.leaving && !(d.space < GNOME_SPACE) && d.boulder.present) drawBoulder(c, d);
    for (const d of crew) {
      drawDwarf(c, d);
      const flick = d.state === 'dig' ? 4 + wave(13, d.phase * 9) : 0;
      if (d.prop === 'lantern') {
        const [lx, ly] = lanternPos(d);
        lights.push({ x: lx, y: ly, r: 26 + wave(6, d.phase * 7) }); // a lantern lights more than a gnome's glow
      } else if (d.state === 'inspect') {
        const [x, y] = inspectLantern(d);
        lights.push({ x: Math.round(d.x) + d.face * (x - d.spec.ax + 1), y: Math.round(d.y) - d.spec.h + y + 1, r: 24 });
      } else {
        lights.push({ x: d.x + d.face * 3, y: d.y - d.spec.h + 2, r: d.spec.lamp + flick });
      }
    }
    for (const r of G.rockets) {
      if (r.delay > 0) continue;
      c.fillStyle = '#fff3c4';
      c.fillRect(Math.round(r.x), Math.round(r.y) - 1, 1, 2);
      lights.push({ x: r.x, y: r.y, r: 6 });
    }
    for (const p of G.particles) {
      const fade = 1 - p.age / p.life;
      if (p.color === 'smoke') { c.fillStyle = `rgba(170,170,185,${0.35 * fade})`; }
      else {
        // firework sparks flicker as they fade
        c.globalAlpha = Math.min(1, fade * 1.5) * (p.twinkle && fade < 0.6 && Math.random() < 0.3 ? 0.3 : 1);
        c.fillStyle = p.color;
      }
      c.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      c.globalAlpha = 1;
      if (p.glow && fade > 0.3 && Math.random() < 0.25) lights.push({ x: p.x, y: p.y, r: 4 });
    }
    for (const m of G.gems) {
      if (m.t < 0) continue; // a lump waiting its turn to fly
      const t = m.t, mx = m.x0 + (m.x1 - m.x0) * t, my = m.y0 + (m.y1 - m.y0) * t - Math.sin(t * Math.PI) * (m.arc ?? 14);
      c.fillStyle = m.color;
      c.fillRect(Math.round(mx), Math.round(my), 2, 2);
      lights.push({ x: mx, y: my, r: 6 });
    }

    // lighting: night sky, dark underground, lamps cut holes in the dark
    const dc = G.dark.getContext('2d'), groundY = (GRASS + 1) * TILE;
    dc.globalCompositeOperation = 'source-over';
    dc.clearRect(0, 0, wpx, hpx);
    dc.fillStyle = `rgba(6,8,24,${0.3 * (1 - day)})`;
    dc.fillRect(0, 0, wpx, groundY);
    dc.fillStyle = 'rgba(10,8,18,0.72)'; // dark, but the rock and its ore still show
    dc.fillRect(0, groundY, wpx, hpx - groundY);
    dc.globalCompositeOperation = 'destination-out';
    for (const L of lights) {
      const r = Math.round(L.r);
      dc.drawImage(lightSprite(r, 'hole'), Math.round(L.x) - r, Math.round(L.y) - r);
    }
    // By day, sunlight falls down the shaft, slanting away from the sun and fading with depth.
    const beamTint = shaftBeam(dc, sun, day, groundY);
    c.drawImage(G.dark, 0, 0);
    if (beamTint.length) {
      c.fillStyle = `rgba(255,236,180,${0.12 * day})`;
      for (let i = 0; i < beamTint.length; i += 2) c.fillRect(beamTint[i], beamTint[i + 1], 1, 1);
    }
    drawGlow(c, lights, sun, day, wpx, hpx, groundY);

    renderText(c);
    updateHover();
  }

  // Text, signs and bubbles are drawn at screen resolution so they stay sharp.
  function renderText(c) {
    const S = G.scale;
    c.setTransform(G.k / S, 0, 0, G.k / S, 0, 0);
    c.textBaseline = 'middle';
    G.signs = [];
    const tiny = S < 2; // the overlay can drop to 1:1 pixels; keep signs small and skip subagent captions
    for (const id of G.order) {
      const g = G.galleries.get(id);
      // the sign: status dot, name, how full the context window is, and a fill bar along its bottom edge
      const share = Math.min(1, (g.context || 0) / (g.window || 1000000));
      const pctText = g.context ? Math.round(share * 100) + '%' : '';
      const nameFont = tiny ? '600 9px system-ui, sans-serif' : '600 11px system-ui, sans-serif';
      const pctFont = tiny ? '600 8px system-ui, sans-serif' : '600 10px system-ui, sans-serif';
      c.font = pctFont;
      const pctW = pctText ? c.measureText(pctText).width + 6 : 0;
      // pull requests, like the desktop app shows them: the PR icon, green while any is open and purple
      // once all are merged (grey otherwise), with the count when there is more than one
      const prs = g.prs, icon = tiny ? 8 : 10;
      const prText = prs && prs.count > 1 ? String(prs.count) : '';
      const prW = prs ? icon + (prText ? c.measureText(prText).width + 2 : 0) + 6 : 0;
      c.font = nameFont;
      const maxW = Math.max(40, (g.max - 2) * TILE * S);
      const label = fit(c, g.name, maxW - 22 - pctW - prW);
      const w = c.measureText(label).width + 22 + pctW + prW, h = tiny ? 13 : 18;
      const x = g.dir > 0 ? (g.ox + 1.6) * TILE * S : (g.ox - 0.6) * TILE * S - w;
      const y = g.r0 * TILE * S + (tiny ? 1 : 4);
      c.fillStyle = '#5a3d27';
      roundRect(c, x, y, w, h, 3); c.fill();
      c.fillStyle = '#3a2a1e'; c.fillRect(x, y + h - 3, w, 3);
      if (share > 0) { // context fill: green, amber from 70%, red from 90% (auto-compact is near the top)
        c.fillStyle = share >= 0.9 ? '#f97066' : share >= 0.7 ? '#f5b83d' : '#6fcf7f';
        c.fillRect(x + 1, y + h - 2, Math.max(1, (w - 2) * share), 2);
      }
      c.fillStyle = g.state === 'ready' ? '#3ddc97' : g.state === 'done' ? '#8a8f99' : '#6ea8fe';
      c.beginPath(); c.arc(x + 9, y + h / 2 - 1, 3.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#f6ead8';
      c.fillText(label, x + 17, y + h / 2 - 0.5);
      if (pctText) {
        c.font = pctFont;
        c.fillStyle = share >= 0.9 ? '#ffb4a8' : share >= 0.7 ? '#ffd98a' : '#cdbfae';
        c.fillText(pctText, x + w - prW - pctW + 1, y + h / 2 - 0.5);
      }
      if (prs) {
        const color = prs.open ? '#3fb950' : prs.merged === prs.count ? '#a371f7' : '#8b949e';
        const ix = x + w - prW + 1, iy = y + (h - 2 - icon) / 2;
        prIcon(c, ix, iy, icon, !prs.open && prs.merged === prs.count, color);
        if (prText) { c.font = pctFont; c.fillStyle = color; c.fillText(prText, ix + icon + 2, y + h / 2 - 0.5); }
      }
      G.signs.push({ x, y, w, h, id });
    }
    for (const d of G.dwarves.values()) {
      if (!visible(d)) continue;
      const fx = d.x * S, fy = d.y * S;
      // a small name tag just above the head: the first name, light text with a dark outline so it
      // reads on sky, grass and rock alike; bubbles sit above it
      // gnomes packed one tile apart alternate their name heights so neighbouring names don't collide
      const tagY = fy - (d.spec.h + 2) * S - (d.stagger && d.atGoal() ? 10 : 0);
      if (d.role === 'sub' && d.space < TILE && d.atGoal() && !d.leaving) continue; // packed too tight for names: hover shows them
      // a name you chose is shown whole; a generated one by its first name
      const first = d.role === 'lead' ? nameParts(d)[0] : gnomeName(d.id.slice(4)).split(' ')[0]; // first names on the tags
      c.font = d.role === 'lead' ? `700 ${tiny ? 9 : 10}px system-ui, sans-serif` : `600 ${tiny ? 8 : 9}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.lineJoin = 'round';
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(14,10,8,0.9)';
      if (d.role === 'lead' && d.level) {
        // "Thorin 7": the name, then the level smaller and in gold, centred as one
        const lvl = String(d.level), nameW = c.measureText(first).width;
        const font = c.font;
        c.font = `800 ${tiny ? 7 : 8}px system-ui, sans-serif`;
        const lvlW = c.measureText(lvl).width, x0 = fx - (nameW + 3 + lvlW) / 2;
        c.textAlign = 'start';
        c.strokeText(lvl, x0 + nameW + 3, tagY);
        c.fillStyle = d.done ? '#b8bcc4' : '#f5c542';
        c.fillText(lvl, x0 + nameW + 3, tagY);
        c.font = font;
        c.strokeText(first, x0, tagY);
        c.fillStyle = d.done ? '#b8bcc4' : '#ffe9b8';
        c.fillText(first, x0, tagY);
      } else {
        c.strokeText(first, fx, tagY);
        c.fillStyle = d.done ? '#b8bcc4' : d.role === 'lead' ? '#ffe9b8' : '#d6e7ff';
        c.fillText(first, fx, tagY);
      }
      c.textAlign = 'start';
      const above = tagY - 7;
      if (d.role === 'lead' && d.state === 'wait' && !d.leaving) {
        if (G.slotGap * TILE * S >= 50) { // names only when there is room; otherwise hover shows them
          c.font = '600 11px system-ui, sans-serif';
          c.textAlign = 'center';
          c.fillStyle = '#bff5d8';
          c.fillText(fit(c, d.caption, G.slotGap * TILE * S - 8), fx, (GRASS + 1.2) * TILE * S);
          c.textAlign = 'start';
        }
        bubble(c, fx, above + wave(5) * 2, '!', '#2fbf7f', '#fff');
      } else if (d.role === 'sub' && d.atGoal() && !d.leaving && !tiny && !(d.space < GNOME_SPACE)) { // too tight otherwise: hover shows it
        c.font = '10px system-ui, sans-serif';
        c.textAlign = 'center';
        c.fillStyle = '#d8c9b6';
        c.fillText(fit(c, d.caption, 2 * TILE * S - 6), fx, fy + 0.5 * TILE * S);
        c.textAlign = 'start';
      }
      if (d.levelUpUntil > G.time) bubble(c, fx, above + wave(6) * 2, `Level ${d.level}!`, '#f5c542', '#3a2600');
      else if (d.state === 'think') bubble(c, fx, above, '…', '#f3efe8', '#2b1d14');
      if (d.state === 'call' && d.phase < 0.5) bubble(c, fx, above, '♪', '#f3efe8', '#2b1d14');
      if (d.done) bubble(c, fx, above, '✓', '#8a8f99', '#fff');
    }
    const inside = restingLeads();
    if (inside.length) {
      bubble(c, (G.SX - 5.4) * TILE * S, (GRASS * TILE - 40) * S, `🍺 ${inside.length} finished`, '#3a3550', '#e9e3ff');
    }
    if (!G.order.length) {
      c.font = '600 13px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillStyle = '#f6ead8';
      c.fillText('No Claude sessions are running', G.tilesX * TILE * S / 2, (GRASS + 1.6) * TILE * S);
      c.textAlign = 'start';
    }
  }

  function bubble(c, x, y, text, bg, fg) {
    c.font = '700 12px system-ui, sans-serif';
    const w = Math.max(20, c.measureText(text).width + 12), h = 16;
    c.fillStyle = bg;
    roundRect(c, x - w / 2, y - h, w, h, 8); c.fill();
    c.beginPath(); c.arc(x + 4, y + 3, 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = fg;
    c.textAlign = 'center';
    c.fillText(text, x, y - h / 2 + 0.5);
    c.textAlign = 'start';
  }

  // the pull request icon (two branches joined by an arrow) or, once merged, the merge icon, in a box of
  // size s at x, y
  function prIcon(c, x, y, s, merged, color) {
    const r = s / 7, l = x + r + 0.5, rt = x + s - r - 0.5, top = y + r + 0.5, bot = y + s - r - 0.5;
    c.save();
    c.strokeStyle = color; c.lineWidth = Math.max(1, s / 8); c.lineCap = 'round'; c.lineJoin = 'round';
    const ring = (cx, cy) => { c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke(); };
    ring(l, top); ring(l, bot);
    c.beginPath(); c.moveTo(l, top + r); c.lineTo(l, bot - r); c.stroke();
    if (merged) { // a branch curving out of the top one into a ring on the right
      const my = (top + bot) / 2 + r / 2;
      ring(rt, my);
      c.beginPath(); c.moveTo(l, top + r); c.quadraticCurveTo(l, my, rt - r, my); c.stroke();
    } else { // the right branch goes up and points back at the left one
      ring(rt, bot);
      const ay = top;
      c.beginPath(); c.moveTo(rt, bot - r); c.lineTo(rt, ay + r); c.quadraticCurveTo(rt, ay, rt - r, ay); c.lineTo(l + r * 2.2, ay); c.stroke();
      c.beginPath(); c.moveTo(l + r * 3.4, ay - r * 1.2); c.lineTo(l + r * 2.2, ay); c.lineTo(l + r * 3.4, ay + r * 1.2); c.stroke();
    }
    c.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  const fitCache = new Map();
  function fit(c, text, max) {
    text = String(text || '');
    const key = c.font + '|' + Math.round(max) + '|' + text;
    let out = fitCache.get(key);
    if (out !== undefined) return out;
    out = text;
    if (c.measureText(text).width > max) {
      while (out.length > 1 && c.measureText(out + '…').width > max) out = out.slice(0, -1);
      out += '…';
    }
    if (fitCache.size > 500) fitCache.clear();
    fitCache.set(key, out);
    return out;
  }

  // ---- input --------------------------------------------------------------------------
  function hitTest() {
    if (!G.mouse) return null;
    const { cx, cy } = G.mouse, S = G.scale, ix = cx / S, iy = cy / S;
    let hit = null;
    for (const d of G.dwarves.values()) {
      if (visible(d) && Math.abs(d.x - ix) <= d.spec.w / 2 && iy >= d.y - d.spec.h - 2 && iy <= d.y + 1 && (!hit || d.y >= hit.y)) hit = d;
    }
    if (hit) return { text: hit.tip, session: hit.sessionId };
    for (const s of G.signs) {
      if (cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) {
        const g = G.galleries.get(s.id);
        return {
          text: `${g.name}\n${tokenLine(g)}\nTunnel: ${g.len} tiles for ${g.calls} tool calls · ${g.gems} of ${CART_FULL} ore in the cart\n` +
            (g.openable ? 'Click to open it in Claude' : 'Click to open the session card'),
          session: s.id,
        };
      }
    }
    { // the ore store
      const x0 = G.SX * TILE + STORE_X - 1, b = GRASS * TILE;
      if (G.order.length && ix >= x0 && ix <= x0 + STORE_W + 2 && iy >= b - 7 - heapHeight() && iy <= b) {
        const list = ['diamond', 'gold', 'iron', 'copper', 'wood'].filter((t) => G.store[t])
          .map((t) => `${G.store[t].toLocaleString()} ${TIER_NAMES[t].toLowerCase()}`).join(' · ');
        return { text: `Ore store\n${list || 'Empty so far'}\nThe windlass hauls each cart up when it is full (${CART_FULL} lumps)` };
      }
    }
    const inside = restingLeads();
    const lx0 = (G.SX - 7) * TILE - 8, lx1 = (G.SX - 7) * TILE + 57, ly0 = GRASS * TILE - 57;
    if (ix >= lx0 && ix <= lx1 && iy >= ly0 && iy <= GRASS * TILE) { // the tavern: always opens the crew
      const names = inside.map((d) => `• ${nameOf(d)}${d.level ? ', level ' + d.level : ''} (${d.caption})`).join('\n');
      return { text: (inside.length ? `Finished, having an ale in the tavern:\n${names}\n` : 'The tavern\n') + 'Click to see the whole crew', lodge: true };
    }
    return null;
  }

  const kTokens = (n) => (n >= 999500 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
  // "Context: 650k of 1M (65%) · 312k tokens written"
  const tokenLine = (g) => (g.context
    ? `Context: ${kTokens(g.context)} of ${kTokens(g.window)} (${Math.round(g.context / g.window * 100)}%) · ${kTokens(g.output)} tokens written`
    : 'Context: no model calls yet');

  const restingLeads = () => [...G.dwarves.values()].filter((d) => d.role === 'lead' && resting(d));

  function updateHover() {
    const h = hitTest();
    G.hover = h;
    G.canvas.style.cursor = h ? 'pointer' : '';
    if (!h) { G.tip.hidden = true; return; }
    if (G.tip.textContent !== h.text) G.tip.textContent = h.text;
    G.tip.hidden = false;
    const rootW = G.root.clientWidth, off = G.canvas.offsetLeft;
    const left = Math.min(off + G.mouse.cx + 14, rootW - G.tip.offsetWidth - 6);
    G.tip.style.left = Math.max(6, left) + 'px';
    G.tip.style.top = (G.canvas.offsetTop + G.mouse.cy + 16) + 'px';
  }

  // ---- public API ---------------------------------------------------------------------
  function sync(state) {
    // A session missing from one poll (say its file was being rewritten) keeps its last known state
    // for a few polls, so its dwarf and tunnel do not vanish and come back.
    if (state.ore && typeof state.ore === 'object') G.store = { ...state.ore };
    G.reporter = !!state.reporter;
    const present = new Set(state.sessions.map((s) => s.id));
    for (const [id, e] of G.known) if (!present.has(id) && ++e.miss >= GRACE_POLLS) G.known.delete(id);
    for (const s of state.sessions) G.known.set(s.id, { s, miss: 0 });
    const sessions = [...G.known.values()].map((e) => e.s).sort((a, b) => a.startedAt - b.startedAt);
    G.sessions = sessions;
    const ids = sessions.map((s) => s.id);
    for (const s of sessions) {
      let g = G.galleries.get(s.id);
      if (!g) { g = { id: s.id, dug: null, len: 0, dmg: 0, gems: 0 }; G.galleries.set(s.id, g); }
      g.calls = s.toolCalls || 0;
      // the server's cart, plus lumps reported but not yet counted there, minus a load on its way up
      g.gems = Math.max(0, (s.cart || 0) + (g.unsent || 0) - (g.hauling || 0));
      g.idle = s.status !== 'busy';
      g.context = (s.tokens && s.tokens.context) || 0;   // tokens sent with the latest model call
      g.output = (s.tokens && s.tokens.output) || 0;     // tokens written over the whole session
      g.window = state.contextWindow || 1000000;
      g.openable = !!s.openable;
      const tier = (s.pricing && s.pricing.tier) || 'wood';
      if (g.tier && g.tier !== tier) G.tilesDirty = true;
      g.tier = tier;
      g.name = s.name;
      g.state = stateOf(s);
      g.parent = s.parent || null; // the session that started this one, if it is running (see layOut)
      // its pull requests, as the desktop app lists them; a newly merged one sets off a couple of rockets
      const prs = s.prs || null;
      if (prs && g.prs && prs.merged > g.prs.merged && !G.first) fireworks(2);
      g.prs = prs;
    }
    for (const id of [...G.galleries.keys()]) if (!ids.includes(id)) G.galleries.delete(id);
    const key = sessions.map((s) => s.id + (s.parent ? '<' + s.parent : '')).join(',');
    if (key !== G.layoutKey) { G.order = ids; G.layoutKey = key; rebuild(); }
    else if (G.tilesDirty) drawAllTiles();
    G.tilesDirty = false;
    if (reduceMotion.matches) { // no digging animation: tunnels jump straight to their length
      let grew = false;
      for (const g of G.galleries.values()) {
        if (g.max != null && g.dug < targetOf(g)) { g.dug = targetOf(g); grew = true; }
      }
      if (grew) rebuild();
    }

    const seen = new Set();
    for (const s of sessions) {
      const leadId = leadKey(s);
      seen.add(leadId);
      const lead = ensureDwarf(leadId, 'lead', false);
      if (lead) {
        const p = s.pricing || { tier: 'wood' };
        const w = s.dwarf;
        if (w && lead.level && w.level > lead.level && !G.first) { // earned a level since the last poll
          lead.levelUpUntil = G.time + 4;
          for (let i = 0; i < 14; i++) spark(lead.x + (Math.random() - 0.5) * 12, lead.y - lead.spec.h + Math.random() * 6);
          fireworks(3);
        }
        applyCustom(lead, w);
        Object.assign(lead, { sessionId: s.id, nameKey: nameKey(s) });
        Object.assign(lead, {
          level: w ? w.level : 0, tier: p.tier, tunic: lead.look.tunic, caption: s.name,
          tip: `${nameOf(lead)}${w ? ` · level ${w.level}` : ''}\n${s.name}\nLead · ${shortModel(s.model)} · ${TIER_NAMES[p.tier]} pickaxe (${priceText(p)})\n` +
            (w ? `${w.xp - w.levelAt} of ${w.nextAt - w.levelAt} XP to level ${w.level + 1} · ${w.xp} XP over ${w.sessions} session${w.sessions === 1 ? '' : 's'}\n` : '') +
            tokenLine(G.galleries.get(s.id)) + '\n' +
            ({ ready: 'Asked you something', done: 'Finished', busy: stepText(s.activity) })[stateOf(s)] +
            (s.openable ? '\nClick to open it in Claude' : '\nClick to open the session card'),
        });
      }
      for (const a of s.agents) {
        const id = 'sub:' + a.id;
        seen.add(id);
        const d = ensureDwarf(id, 'sub', a.finished);
        if (!d) continue;
        const p = a.pricing || { tier: 'wood' };
        Object.assign(d, {
          sessionId: s.id, tier: p.tier, tunic: TUNICS[a.type] || '#2f7f7f', caption: a.description || a.type,
          prop: GNOME_PROPS[a.type] || 'pick',
          tip: `${gnomeName(a.id)}, gnome\n${a.description || a.type}\n${a.type} ·${shortModel(a.model)} · ${TIER_NAMES[p.tier]} pickaxe (${priceText(p)})\n` +
            (a.finished ? 'Finished' : stepText(a.activity)) + `\nWorking for: ${s.name}` +
            (s.openable ? '\nClick to open that session in Claude' : ''),
        });
      }
    }
    for (const d of G.dwarves.values()) {
      if (seen.has(d.id)) continue;
      // Its session's tunnel is already gone (the session waited out its own grace polls): go home now.
      const orphan = !G.galleries.has(d.sessionId);
      if (orphan || (d.miss = (d.miss || 0) + 1) >= GRACE_POLLS) d.leave(d.role === 'sub');
    }
    plan();
    G.first = false;
  }

  // Move the scene to a container in another window (the pop-out overlay) or back. The loop and the
  // resize watcher run on that window, so the scene keeps animating while the main tab is hidden.
  function attach(root, win) {
    G.root = root;
    G.win = win || window;
    if (G.ro) G.ro.disconnect();
    let size = '', timer = 0;
    G.ro = new G.win.ResizeObserver(() => {
      const next = root.clientWidth + 'x' + (root.dataset.fit ? root.clientHeight : 0);
      if (next === size) return;
      size = next;
      G.win.clearTimeout(timer);
      timer = G.win.setTimeout(() => { if (G.layoutKey !== null) rebuild(); }, 150);
    });
    G.ro.observe(root);
    rebuild();
    startLoop();
  }

  function startLoop() {
    const gen = ++G.loopGen, win = G.win;
    let last = win.performance.now(), acc = 0;
    const frame = (now) => {
      if (gen !== G.loopGen) return; // the scene moved to another window, which runs its own loop
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      while (acc >= STEP) { update(STEP); acc -= STEP; }
      render();
      win.requestAnimationFrame(frame);
    };
    win.requestAnimationFrame(frame);
  }

  function init(root, hooks) {
    G.root = root;
    G.hooks = hooks || {};
    G.canvas = root.querySelector('canvas');
    G.ctx = G.canvas.getContext('2d');
    G.tip = root.querySelector('.tip');
    G.canvas.addEventListener('mousemove', (e) => {
      const r = G.canvas.getBoundingClientRect();
      G.mouse = { cx: e.clientX - r.left, cy: e.clientY - r.top };
    });
    G.canvas.addEventListener('mouseleave', () => { G.mouse = null; });
    G.canvas.addEventListener('click', () => {
      if (!G.hover) return;
      if (G.hover.lodge) { if (G.hooks.onLodge) G.hooks.onLodge(); }
      else if (G.hooks.onSelect) G.hooks.onSelect(G.hover.session);
    });
    G.layoutKey = '';
    attach(root, window);
  }

  // inspect() is a read-only snapshot of the dwarves, for debugging from the console.
  const inspect = () => [...G.dwarves.values()].map((d) => ({
    id: d.id, state: d.state, activity: d.activity, leaving: d.leaving, done: d.done, tile: [d.tx, d.ty], goal: d.goal,
  }));
  // gallery(canvas, ids) draws the dwarves for those ids side by side, 4x, to compare their looks.
  function gallery(canvas, ids, role = 'lead', state = 'wait', phase = 0) {
    const c = canvas.getContext('2d');
    canvas.width = ids.length * 22 * 4;
    canvas.height = 24 * 4;
    c.imageSmoothingEnabled = false;
    c.setTransform(4, 0, 0, 4, 0, 0);
    const types = Object.keys(TUNICS).filter((k) => k !== 'lead');
    ids.forEach((id, i) => {
      const d = new Dwarf(id, role);
      const tunic = role === 'lead' ? d.look.tunic : TUNICS[types[i % types.length]];
      Object.assign(d, { tunic, tier: 'gold', x: i * 22 + 11, y: 22, state, phase, face: 1, prop: role === 'lead' ? null : GNOME_PROPS[types[i % types.length]] || 'pick' });
      drawDwarf(c, d);
    });
  }

  // The tavern panel: a roster dwarf drawn on its own canvas (with your choices, or a draft of them),
  // its generated look and name to start editing from, and the palette the generator picks from.
  function portrait(canvas, dwarf, scale = 4) {
    const d = new Dwarf('lead:' + dwarf.id, 'lead');
    applyCustom(d, dwarf);
    const c = canvas.getContext('2d');
    canvas.width = 16 * scale; canvas.height = 20 * scale;
    c.imageSmoothingEnabled = false;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, 16, 20);
    Object.assign(d, { tunic: d.look.tunic, tier: 'gold', x: 7, y: 18, state: 'wait', face: 1, prop: null });
    drawDwarf(c, d);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  function defaults(id) {
    const d = new Dwarf('lead:' + id, 'lead'), L = d.look;
    return { name: dwarfName(id), skin: L.skin, beardColor: d.baseBeard, helm: L.helm[0], tunic: L.tunic, boots: L.boots, beard: L.beard, bigNose: L.bigNose, buckle: L.buckle, horn: L.horn };
  }
  const palette = {
    beardColor: [...new Set(BEARDS)], helm: LOOKS.helms.map((p) => p[0]), tunic: LOOKS.tunics, boots: LOOKS.boots,
    skin: [...new Set(LOOKS.skins)].sort((a, b) => hexRgb(b).reduce((x, y) => x + y) - hexRgb(a).reduce((x, y) => x + y)),
    beard: ['long', 'short', 'forked', 'braided', 'twin'],
  };

  window.Mine = { init, attach, sync, inspect, setTime, dwarfName, gnomeName, gallery, portrait, defaults, palette, fireworks, setSchedule, DEFAULT_SCHEDULE };
})();
