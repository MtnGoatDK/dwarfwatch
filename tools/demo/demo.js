// Demo driver for the Dwarfwatch GIF. Loaded before mine.js: it answers the page's API calls with a
// scripted story instead of real sessions (keeping its own carts and ore store, like the real server),
// runs the engine on a virtual clock so every frame is exactly 1/FPS apart, moves the time of day
// through an afternoon, a night and a sunrise, and with #rec posts each frame to the capture server.
(() => {
  const LENGTH = 32, FPS = 12, rec = location.hash === '#rec';
  let vt = 0;
  Object.defineProperty(performance, 'now', { value: () => vt, configurable: true });
  const frames = [];
  window.requestAnimationFrame = (cb) => frames.push(cb);
  const now = () => vt / 1000;
  const at = (t, steps) => { let cur = steps[0][1]; for (const [s, v] of steps) if (t >= s) cur = v; return cur; };
  const tool = (name, detail) => ({ kind: 'tool', tool: name, detail });
  const think = { kind: 'thinking' };
  const base = Date.now() - 3600e3;

  // the story's ore: carts per session and the surface store, as the server would keep them
  const carts = { 'demo-a': 9, 'demo-b': 2, 'demo-c': 5, 'demo-d': 3 };
  const store = { copper: 40, iron: 70, gold: 110, diamond: 25 };
  const tierOf = { 'demo-a': 'diamond', 'demo-b': 'gold', 'demo-c': 'copper', 'demo-d': 'iron' };

  function session(id, name, model, extra) {
    return {
      id, pid: 1, name, cwd: 'C:\\demo', openable: false, status: 'busy', since: Date.now(), startedAt: base + id.charCodeAt(5),
      model, pricing: { tier: tierOf[id], input: 3, output: 15, fast: false },
      tokens: { context: 300000, output: 60000 }, prompt: '', toolCalls: 400, turn: { at: Date.now(), asked: false },
      activity: think, feed: [], agents: [], cart: carts[id] || 0, ...extra,
    };
  }
  const dwarf = (id, level) => ({ id: 'dw-' + id, firstName: '', lastName: '', nameSeed: '', look: null, level, xp: 0, levelAt: 0, nextAt: 1, sessions: 3, hiredAt: base });
  const gnome = (id, type, description, finished, activity) => ({
    id, type, description, model: 'claude-haiku-5-5', pricing: { tier: 'copper' }, finished, toolCalls: 3, activity, tokens: null,
  });

  function state(t) {
    // Refactor: reads, edits, runs tests; calls two gnomes in at 2.5 s; levels up at 21 s (at night)
    const a = session('demo-a', 'Refactor the import pipeline', 'claude-opus-5-5', {
      toolCalls: 1400 + Math.floor(t * 3),
      activity: at(t, [[0, tool('Read', 'importer.ts')], [2.5, tool('Agent', 'Explore the parsers')], [4.5, tool('Edit', 'importer.ts')],
        [8, tool('Bash', 'npm test')], [11, tool('Edit', 'parser.ts')], [15, tool('Read', 'cases.json')], [19, tool('Bash', 'npm test')],
        [24, tool('Edit', 'importer.ts')], [28, tool('Read', 'importer.ts')]]),
      agents: t < 3.5 ? [] : [
        gnome('g1', 'Explore', 'Map the parsers', t > 26, tool('Grep', 'parse')),
        gnome('g2', 'general-purpose', 'Check edge cases', t > 14, tool('Read', 'cases.json')),
      ],
      dwarf: dwarf('demo-a', t < 21 ? 19 : 20),
    });
    // Login fix: looks things up on the web, edits, then asks you something at 9 s
    const b = session('demo-b', 'Fix the login redirect', 'claude-sonnet-5-5', {
      activity: at(t, [[0, tool('WebFetch', 'oauth docs')], [4, tool('Edit', 'auth.ts')], [7.5, think]]),
      ...(t >= 9 ? { status: 'idle', turn: { at: Date.now(), asked: true } } : {}),
      dwarf: dwarf('demo-b', 8),
    });
    // Release notes: writes, then finishes at 6.5 s and heads for the tavern (its cart is hauled up)
    const c = session('demo-c', 'Write the release notes', 'claude-haiku-5-5', {
      activity: at(t, [[0, tool('Edit', 'CHANGELOG.md')], [3, tool('Read', 'git log')], [5.5, think]]),
      ...(t >= 6.5 ? { status: 'idle', turn: { at: Date.now(), asked: false } } : {}),
      dwarf: dwarf('demo-c', 3),
    });
    // Build speed-up: runs builds and searches the whole time
    const d = session('demo-d', 'Speed up the build', 'claude-sonnet-5-5', {
      activity: at(t, [[0, tool('Bash', 'dotnet build')], [5, tool('Grep', 'csproj')], [8, tool('WebSearch', 'msbuild cache')],
        [12, tool('Bash', 'dotnet build')], [17, tool('Edit', 'Directory.Build.props')], [22, tool('Bash', 'dotnet build')],
        [27, tool('Grep', 'PackageReference')]]),
      dwarf: dwarf('demo-d', 12),
    });
    for (const s of [a, b, c, d]) s.cart = carts[s.id] || 0;
    return {
      now: Date.now(), contextWindow: 1000000, sessions: [a, b, c, d], reporter: true, schedule: null, ore: { ...store },
      usage: { estimated: true, plan: 'Team', calibratedAt: new Date().toISOString(),
        fiveHour: { percent: Math.round(34 + t * 0.5), resetsAt: new Date(Date.now() + 2.2 * 3600e3).toISOString() },
        weekly: { percent: 58, resetsAt: new Date(Date.now() + 30 * 3600e3).toISOString() } },
    };
  }

  // the refactor's cart fills up early on, so the windlass has a full load to haul
  let filled = false;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('/api/state')) {
      if (!filled && now() > 3) { carts['demo-a'] = 12; filled = true; }
      return new Response(JSON.stringify(state(now())), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.startsWith('/api/ore')) { // mining and hauls, kept like the server does
      const b = JSON.parse(opts.body);
      if (b.op === 'mine') carts[b.session] = (carts[b.session] || 0) + b.n;
      if (b.op === 'haul') { const n = Math.min(b.n, carts[b.session] || 0); carts[b.session] -= n; store[tierOf[b.session]] += n; }
      return new Response(null, { status: 204 });
    }
    if (u.startsWith('/api/roster')) return new Response(JSON.stringify({ dwarves: [] }), { headers: { 'Content-Type': 'application/json' } });
    return realFetch(url, opts);
  };

  // the clock: a working morning, then sunset, a whole night with the moon, and sunrise into the morning
  const KEYS = [[0, 10 * 60 + 30], [13, 10 * 60 + 30], [13.01, 16 * 60 + 5], [18, 17 * 60], [26, 24 * 60 + 7 * 60 + 15], [32, 24 * 60 + 8 * 60 + 20]];
  const clock = (t) => {
    let m = KEYS[KEYS.length - 1][1];
    for (let i = 1; i < KEYS.length; i++) {
      const [t0, m0] = KEYS[i - 1], [t1, m1] = KEYS[i];
      if (t <= t1) { m = m0 + (t - t0) / (t1 - t0) * (m1 - m0); break; }
    }
    m %= 24 * 60;
    return `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
  };

  let n = 0, lastPoll = -1;
  const yieldTask = () => new Promise((r) => { const m = new MessageChannel(); m.port1.onmessage = () => r(); m.port2.postMessage(0); });
  // one step of the virtual clock: half-second polls (so the story lands on time), then a frame
  async function advance() {
    vt += 1000 / FPS;
    if (window.Mine) Mine.setTime(clock(now()));
    if (Math.floor(now() * 2) !== lastPoll && typeof tick === 'function') { lastPoll = Math.floor(now() * 2); tick(pollGen); }
    await yieldTask(); await yieldTask();
    for (const cb of frames.splice(0)) cb(vt);
  }
  // for previews: run the story up to a moment without recording
  window.demoGoto = async (seconds) => { while (now() < seconds) await advance(); };
  if (!rec) return;
  const ch = new MessageChannel();
  ch.port1.onmessage = async () => {
    await advance();
    const cv = document.querySelector('#mine canvas');
    if (cv && now() > 0.5) {
      const body = cv.toDataURL('image/png'), k = n++;
      for (let i = 0; i < 4; i++) {
        try { await realFetch('http://127.0.0.1:4790/frame?n=' + k, { method: 'POST', mode: 'no-cors', body }); break; } catch { /* retry */ }
      }
    }
    if (now() > LENGTH) { realFetch('http://127.0.0.1:4790/done', { method: 'POST', mode: 'no-cors', body: String(n) }); return; }
    ch.port2.postMessage(0);
  };
  setTimeout(() => ch.port2.postMessage(0), 300);
})();
