'use strict';
// Dwarfwatch: local visualiser for running Claude Code sessions and their subagents.
// Read-only. Data comes from ~/.claude/sessions (live status) and ~/.claude/projects (transcripts).
// Zero dependencies: node server.js

const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PORT = Number(process.env.PORT) || 4777;
// The transcripts do not record the model's context window, so the meter scale is an assumption.
const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW) || 1000000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const FEED_KEEP = 8;                    // tool calls remembered per transcript
const FEED_SEND = 6;                    // tool calls sent to the page
const FINISHED_LINGER_MS = 90 * 1000;   // keep finished subagents visible this long
const ORPHAN_QUIET_MS = 30 * 60 * 1000; // subagent with no output this long is not shown at all
const WRITING_DONE_MS = 2 * 60 * 1000;  // a subagent whose last entry is text, quiet this long, is done
const CACHE_IDLE_MS = 30 * 60 * 1000;   // forget transcripts nobody has asked about for this long

// Anthropic API list prices, USD per 1M tokens [input, output], from the claude-api reference (cached 2026-11-03).
// Only used to rank models into pickaxe tiers; what you are actually billed depends on your plan.
const PRICES = {
  'fable-5-2': [8, 40], 'mythos-5-2': [8, 40], 'fable-5-1': [10, 50], 'mythos-5-1': [10, 50], 'fable-5': [10, 50],
  'opus-5-5': [4, 20], 'opus-5': [5, 25], 'opus-4-8': [5, 25], 'opus-4-7': [5, 25], 'opus-4-6': [5, 25],
  'sonnet-5-5': [2, 10], 'sonnet-5': [2, 10], 'sonnet-4-6': [3, 15],
  'haiku-5-5': [0.1, 0.5], 'haiku-4-5': [1, 5],
};
const FAST_PRICES = { 'opus-5-5': [8, 40], 'fable-5-2': [16, 80], 'mythos-5-2': [16, 80], 'opus-5': [10, 50], 'opus-4-8': [10, 50] };
const MODEL_ALIASES = { opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-5-5', fable: 'fable-5-2' };

function pricing(model, speed) {
  const bare = String(model || '').toLowerCase().replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  // A model newer than this table is priced like the current model of its family (opus-6 like opus).
  const family = (bare.match(/^[a-z]+/) || [''])[0];
  const key = MODEL_ALIASES[bare] || (PRICES[bare] ? bare : MODEL_ALIASES[family] || bare);
  const fast = speed === 'fast' ? FAST_PRICES[key] : null;
  const price = fast || PRICES[key];
  if (!price) return { tier: 'wood', input: null, output: null, fast: false };
  const [input, output] = price;
  const tier = input >= 8 ? 'diamond' : input >= 4 ? 'gold' : input >= 1 ? 'iron' : 'copper';
  return { tier, input, output, fast: !!fast };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// Whole file or nothing, even if the server is stopped mid-write: write a temporary file, then rename it.
function writeJson(file, data, indent = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent));
  fs.renameSync(tmp, file);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Windows hands out process ids again soon after a process ends, so a session file left behind by a
// crashed Claude Code can point at some unrelated program. The registry's procStart is the process's
// creation time (a FILETIME); compare it with the live process's, checked in the background (it takes a
// PowerShell call) on first sight and every few minutes. Until a check has answered, assume it matches.
const PROC_RECHECK_MS = 5 * 60 * 1000;
const procChecks = new Map(); // pid -> { procStart, ok, at, busy }
function sameProcess(entry) {
  if (process.platform !== 'win32' || !/^\d+$/.test(String(entry.procStart || ''))) return true;
  const pid = entry.pid, want = String(entry.procStart);
  let c = procChecks.get(pid);
  if (!c || c.procStart !== want) { c = { procStart: want, ok: true, at: 0, busy: false }; procChecks.set(pid, c); }
  if (!c.busy && Date.now() - c.at > PROC_RECHECK_MS) {
    c.busy = true;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], // pid is an integer
    { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      c.busy = false; c.at = Date.now();
      c.ok = err ? !/Cannot find a process/i.test(String(err.message)) && alive(pid) : String(stdout).trim() === want;
    });
  }
  return c.ok;
}
const running = (entry) => Number.isInteger(entry.pid) && alive(entry.pid) && sameProcess(entry);

const clip = (text, max) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);

// --- transcripts -----------------------------------------------------------

const transcriptPaths = new Map(); // sessionId -> { file, at } (file null = not found yet)
const MISS_RETRY_MS = 30 * 1000;

function transcriptPath(id, cwd) {
  const projects = path.join(CLAUDE_DIR, 'projects');
  // The folder for the session's current cwd wins: a session moved to another folder keeps an old copy behind.
  const guess = path.join(projects, String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
  if (fs.existsSync(guess)) { transcriptPaths.set(id, { file: guess, at: Date.now() }); return guess; }
  const cached = transcriptPaths.get(id);
  if (cached && cached.file && fs.existsSync(cached.file)) return cached.file;
  if (cached && !cached.file && Date.now() - cached.at < MISS_RETRY_MS) return null; // don't rescan every poll
  let found = null;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, id + '.jsonl');
      if (fs.existsSync(candidate)) { found = candidate; break; }
    }
  } catch { /* no projects dir yet */ }
  transcriptPaths.set(id, { file: found, at: Date.now() });
  return found;
}

function describe(input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.description
    || (input.file_path && path.basename(String(input.file_path)))
    || input.pattern || input.query || input.url || input.command || input.skill || input.prompt || '';
  return clip(pick, 120);
}

// Each transcript is read once from the start, then only the bytes appended since.
const transcripts = new Map(); // file -> running stats

function freshStats() {
  return {
    offset: 0, rest: null, at: 0,
    model: '', speed: '', toolCalls: 0, context: 0,
    output: 0, outById: new Map(), // a reply's usage is repeated on every entry it writes, so count each reply id once
    prompt: '', step: {}, tools: [], toolIds: new Set(),
    // the latest turn: when it last moved, and whether it ended by asking you something
    lastTurnAt: 0, turnAsk: false, turnText: '', pendingAsk: new Set(), interrupted: false,
    used: 0, ino: 0,
  };
}

// Did the turn end by asking the user something? Signs: you interrupted it, the desktop app's
// wrap-up step carried a question, an AskUserQuestion prompt has no answer yet, or the final
// paragraph of the reply contains a question mark (links and inline code ignored).
function askedYou(s) {
  if (s.interrupted || s.turnAsk || s.pendingAsk.size) return true;
  const last = s.turnText.trim().split(/\n\s*\n/).pop() || '';
  return last.replace(/https?:\/\/\S+/g, '').replace(/`[^`]*`/g, '').includes('?');
}

// User entries that were not typed as a prompt: slash commands and their output, shell-mode input,
// and the marker written when you stop a turn.
const NOT_A_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
const INTERRUPTED = /^\s*\[Request interrupted/;

function ingest(s, line) {
  if (!line || line.startsWith('{"type":"api-request')) return; // large request dumps, nothing we show
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || typeof d !== 'object') return;
  const m = d.message && typeof d.message === 'object' ? d.message : null;
  const blocks = m && Array.isArray(m.content) ? m.content.filter((b) => b && typeof b === 'object') : [];

  if (d.type === 'assistant' && m) {
    s.lastTurnAt = Date.parse(d.timestamp) || s.lastTurnAt;
    s.interrupted = false;
    if (m.model && m.model !== '<synthetic>') s.model = m.model;
    const u = m.usage;
    if (u) {
      if (u.speed) s.speed = u.speed;
      const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (context) s.context = context;
      const out = u.output_tokens || 0;
      if (!m.id) s.output += out;
      else if (out > (s.outById.get(m.id) || 0)) { s.output += out - (s.outById.get(m.id) || 0); s.outById.set(m.id, out); }
    }
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        if (s.toolIds.has(b.id)) continue; // the same reply can be written to the transcript again later
        s.toolIds.add(b.id);
        const call = {
          id: b.id,
          tool: String(b.name || '').replace(/^mcp__(.+?)__/, '$1: '),
          detail: describe(b.input),
          at: Date.parse(d.timestamp) || 0,
          state: 'running',
        };
        s.toolCalls++;
        s.tools.push(call);
        if (s.tools.length > FEED_KEEP) s.tools.shift();
        s.step = { kind: 'tool', tool: call.tool, detail: call.detail };
        if (/wrap_up$/.test(b.name) && b.input && b.input.ask) s.turnAsk = true;
        if (b.name === 'AskUserQuestion') s.pendingAsk.add(b.id);
      } else if (b.type === 'thinking') {
        s.step = { kind: 'thinking' };
      } else if (b.type === 'text') {
        s.step = { kind: 'writing', ended: m.stop_reason === 'end_turn' };
        if (typeof b.text === 'string' && b.text.trim()) s.turnText = b.text;
      }
    }
    return;
  }

  if (d.type === 'user' && m) {
    if (d.isMeta || d.isCompactSummary) return;
    const human = !d.origin || d.origin.kind === 'human';
    let prompt = typeof m.content === 'string' ? m.content : '';
    let results = 0;
    if (blocks.length) {
      const texts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          results++;
          s.pendingAsk.delete(b.tool_use_id);
          const call = s.tools.find((t) => t.id === b.tool_use_id);
          if (call) call.state = b.is_error ? 'error' : 'ok';
        } else if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
      }
      prompt = texts.join(' ');
    }
    if (INTERRUPTED.test(prompt)) {
      s.interrupted = true; // you stopped it, so it is waiting on you
      s.lastTurnAt = Date.parse(d.timestamp) || s.lastTurnAt;
      for (const t of s.tools) if (t.state === 'running') t.state = 'stopped';
      return;
    }
    if (results) {
      if (!s.tools.some((t) => t.state === 'running')) s.step = { kind: 'thinking' }; // model is reading the results
    } else if (human && prompt.trim() && !NOT_A_PROMPT.test(prompt)) {
      s.prompt = clip(prompt, 300);
      s.step = { kind: 'thinking' };
      s.lastTurnAt = Date.parse(d.timestamp) || s.lastTurnAt;
      s.turnAsk = false; s.turnText = ''; s.pendingAsk.clear(); s.interrupted = false;
      for (const t of s.tools) if (t.state === 'running') t.state = 'stopped'; // never got a result
    } else if (!human && prompt.trim() && !NOT_A_PROMPT.test(prompt)) {
      // a turn started by something other than you (a subagent's report, a task notification): the
      // model is working again, so the last reply's "finished" state no longer holds
      s.step = { kind: 'thinking' };
      s.lastTurnAt = Date.parse(d.timestamp) || s.lastTurnAt;
      s.turnAsk = false; s.turnText = ''; s.interrupted = false;
    }
    return;
  }

  if (d.type === 'last-prompt' && d.lastPrompt) s.prompt = clip(d.lastPrompt, 300);
}

function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let s = transcripts.get(file);
  // new, truncated, or replaced by another file (Windows reports a file index as ino)
  if (!s || st.size < s.offset || (s.ino && st.ino && st.ino !== s.ino)) {
    s = freshStats();
    transcripts.set(file, s);
  }
  s.ino = st.ino;
  s.used = Date.now();
  if (st.size > s.offset) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (s.offset < st.size) {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, st.size - s.offset));
        const n = fs.readSync(fd, chunk, 0, chunk.length, s.offset);
        if (!n) break;
        s.offset += n;
        const buf = s.rest ? Buffer.concat([s.rest, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        const end = buf.lastIndexOf(10); // split on whole lines only; keep an unfinished one for next time
        if (end < 0) { s.rest = buf; continue; }
        s.rest = end + 1 < buf.length ? buf.subarray(end + 1) : null;
        for (const line of buf.toString('utf8', 0, end).split('\n')) {
          try { ingest(s, line); } catch (err) { console.warn('skipped a transcript entry:', err.message); }
        }
      }
    } catch { /* locked or vanished; retry on the next poll */ } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  s.at = Math.round(st.mtimeMs);
  return s;
}

const activityOf = (s) => (s ? { at: s.at, ...s.step } : null);
const tokensOf = (s) => (s ? { context: s.context, output: s.output } : null);

// --- subagents ---------------------------------------------------------------

function listAgents(transcript, now) {
  const dir = path.join(transcript.slice(0, -'.jsonl'.length), 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const id = name.slice(0, -'.meta.json'.length);
    const file = path.join(dir, id + '.jsonl');
    let at;
    try { at = fs.statSync(file).mtimeMs; } catch {
      try { at = fs.statSync(path.join(dir, name)).mtimeMs; } catch { continue; } // spawned, nothing written yet
    }
    const quiet = now - at;
    if (quiet > ORPHAN_QUIET_MS) continue; // old or abandoned: skip without reading it
    const meta = readJson(path.join(dir, name));
    if (!meta) continue;
    const s = readTranscript(file);
    // meta.finished is only written for some agents; the rest end on a plain text reply.
    // A text block followed by a long pause can still be mid-turn, so the fallback waits WRITING_DONE_MS.
    const finished = !!meta.finished || !!(s && (s.step.ended || (s.step.kind === 'writing' && quiet > WRITING_DONE_MS)));
    if (finished && quiet > FINISHED_LINGER_MS) continue;
    const model = (s && s.model) || meta.model || '';
    out.push({
      id,
      type: meta.agentType || 'agent',
      description: meta.description || '',
      model,
      pricing: pricing(model, s && s.speed),
      finished,
      toolCalls: s ? s.toolCalls : 0,
      activity: activityOf(s),
      tokens: tokensOf(s),
    });
  }
  return out;
}

// --- state -------------------------------------------------------------------

// --- the dwarf roster ----------------------------------------------------------
// The dwarves are remembered between runs, so the crew grows and gains experience over time. Each
// session gets a dwarf from the roster: the one it had before if it is free (a resumed session), else a
// free dwarf who has worked in the same project folder, else the one who has rested longest; a new dwarf
// is hired only when everyone is busy. A dwarf earns 1 XP per tool call made in its sessions, and its
// level follows from its XP. The roster lives with the overlay's other data, outside the project.
const DATA_ROOT = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
const ROSTER_FILE = process.env.DWARFWATCH_ROSTER || process.env.AGENT_WATCH_ROSTER || path.join(DATA_ROOT, 'Dwarfwatch', 'roster.json');
// The project used to be called Agent Watch: on first start, bring the roster and settings over from its
// folder (the old folder stays as it was, as a backup). Returns whether anything was copied.
function bringOverOldData() {
  if (process.env.DWARFWATCH_ROSTER || process.env.AGENT_WATCH_ROSTER) return false;
  const oldDir = path.join(DATA_ROOT, 'AgentWatch'), newDir = path.dirname(ROSTER_FILE);
  let copied = false;
  for (const name of ['roster.json', 'settings.json']) {
    const from = path.join(oldDir, name), to = path.join(newDir, name);
    try {
      if (!fs.existsSync(to) && fs.existsSync(from)) { fs.mkdirSync(newDir, { recursive: true }); fs.copyFileSync(from, to); copied = true; }
    } catch (err) { console.warn('could not bring over ' + name + ':', err.message); }
  }
  return copied;
}
const XP_STEP = 20; // XP for level 2; each level after needs XP_STEP more than the one before

// Level from XP: level n starts at XP_STEP * n * (n - 1) / 2 (0, 20, 60, 120, 200, 300, …).
const levelOf = (xp) => Math.floor((1 + Math.sqrt(1 + (8 * xp) / XP_STEP)) / 2);
const xpFor = (level) => (XP_STEP * level * (level - 1)) / 2;

// Names are kept as a first name and a surname you chose; an empty part means the generated one.
// Names saved before that, as one string, are split at the first space.
function splitOldName(d) {
  if (typeof d.name === 'string' && d.name && d.firstName === undefined && d.lastName === undefined) {
    const [first, ...rest] = d.name.trim().split(/\s+/);
    d.firstName = first;
    if (rest.length) d.lastName = rest.join(' ');
  }
  delete d.name;
  return d;
}

function loadRoster() {
  const r = readJson(ROSTER_FILE);
  return {
    dwarves: Array.isArray(r && r.dwarves) ? r.dwarves.filter((d) => d && typeof d.id === 'string').map(splitOldName) : [],
    counted: (r && typeof r.counted === 'object' && r.counted) || {}, // session -> tool calls already credited
    countedOut: (r && typeof r.countedOut === 'object' && r.countedOut) || {}, // session -> output tokens credited
    history: (r && typeof r.history === 'object' && r.history) || {}, // session -> its last dwarf
    ore: (r && typeof r.ore === 'object' && r.ore) || {}, // the surface ore store: tier -> lumps hauled up
    carts: (r && typeof r.carts === 'object' && r.carts) || {}, // session -> { tier: lumps } mined, not yet hauled
  };
}
const roster = loadRoster();
let rosterDirty = false, rosterSavedAt = 0;

function saveRoster(force) {
  if (!rosterDirty || (!force && Date.now() - rosterSavedAt < 5000)) return;
  // keep the bookkeeping small: forget sessions that ended long ago (their XP stays with the dwarf)
  const keep = Object.entries(roster.history).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
  roster.history = Object.fromEntries(keep);
  for (const id of Object.keys(roster.counted)) if (!roster.history[id]) delete roster.counted[id];
  for (const id of Object.keys(roster.countedOut)) if (!roster.history[id]) delete roster.countedOut[id];
  try {
    writeJson(ROSTER_FILE, roster);
    rosterDirty = false; rosterSavedAt = Date.now();
  } catch (err) {
    console.warn('could not save the dwarf roster:', err.message);
  }
}

function hireDwarf(now) {
  const d = { id: require('crypto').randomBytes(6).toString('hex'), xp: 0, hiredAt: now, lastWorked: now, sessions: 0, projects: {} };
  roster.dwarves.push(d);
  return d;
}

// Gives every live session a dwarf and credits new tool calls as XP. Returns session id -> dwarf.
function assignDwarves(sessions, now) {
  const byId = new Map(roster.dwarves.map((d) => [d.id, d]));
  const taken = new Map(); // dwarf id -> session id
  const out = new Map();
  // sessions keep the dwarf they already have, oldest session first if two claim the same one
  const ordered = [...sessions].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const s of ordered) {
    const h = roster.history[s.id], d = h && byId.get(h.dwarf);
    if (d && !taken.has(d.id)) { taken.set(d.id, s.id); out.set(s.id, d); }
  }
  for (const s of ordered) {
    if (out.has(s.id)) continue;
    const free = roster.dwarves.filter((d) => !taken.has(d.id));
    const project = s.cwd.toLowerCase();
    free.sort((a, b) => ((b.projects && b.projects[project]) || 0) - ((a.projects && a.projects[project]) || 0)
      || (a.lastWorked || 0) - (b.lastWorked || 0)); // same project first, then the longest rested
    const d = free[0] || hireDwarf(now);
    taken.set(d.id, s.id);
    out.set(s.id, d);
    d.sessions = (d.sessions || 0) + 1;
    d.projects = d.projects || {};
    d.projects[project] = (d.projects[project] || 0) + 1;
    roster.history[s.id] = { dwarf: d.id, at: now };
    rosterDirty = true;
  }
  for (const s of sessions) {
    const d = out.get(s.id);
    // XP: tool calls since last counted (a session seen for the first time brings all its calls)
    const before = roster.counted[s.id] || 0, calls = s.toolCalls || 0;
    if (calls > before) { d.xp = (d.xp || 0) + (calls - before); roster.counted[s.id] = calls; d.lastWorked = now; rosterDirty = true; }
    else if (calls < before) roster.counted[s.id] = calls; // transcript replaced: count from here
    const written = (s.tokens && s.tokens.output) || 0, outBefore = roster.countedOut[s.id] || 0;
    if (written > outBefore) { d.tokens = (d.tokens || 0) + (written - outBefore); roster.countedOut[s.id] = written; rosterDirty = true; }
    else if (written < outBefore) roster.countedOut[s.id] = written;
    if (s.status === 'busy') d.lastWorked = now;
    roster.history[s.id].at = now;
  }
  saveRoster(false);
  return out;
}

const dwarfInfo = (d) => {
  const level = levelOf(d.xp || 0);
  return { id: d.id, firstName: d.firstName || '', lastName: d.lastName || '', nameSeed: d.nameSeed || '', look: d.look || null, xp: d.xp || 0, level, levelAt: xpFor(level), nextAt: xpFor(level + 1), sessions: d.sessions || 0, hiredAt: d.hiredAt || 0 };
};

// Ore, kept here so none is lost: every lump mined goes into its session's cart (saved), a haul moves
// a load from the cart to the surface store only once it is tipped there, and when a session ends
// whatever is left in its cart goes to the store at once. So closing the overlay mid-haul, or a shaft
// disappearing, loses nothing: the cart still holds it, or the store already does.
// One view reports mining and hauls (the overlay app if it is open, else the first page polling), so
// two open views don't count the same digging twice; the others just show what the server has.
const ORE_TIERS = ['wood', 'copper', 'iron', 'gold', 'diamond'];
let liveSessions = new Set(); // from the latest state(): only these can mine
const cartTotal = (c) => Object.values(c || {}).reduce((a, n) => a + (n || 0), 0);
function mineOre(body) {
  if (!body || typeof body.session !== 'string' || !liveSessions.has(body.session)) return false;
  if (!ORE_TIERS.includes(body.tier) || !Number.isInteger(body.n) || body.n < 1 || body.n > 20) return false;
  const cart = roster.carts[body.session] || (roster.carts[body.session] = {});
  cart[body.tier] = (cart[body.tier] || 0) + body.n;
  rosterDirty = true; saveRoster(false);
  return true;
}
// Moves up to n lumps from a session's cart to the store (the biggest tier first). Returns how many.
function moveToStore(session, n) {
  const cart = roster.carts[session];
  if (!cart) return 0;
  let moved = 0;
  for (const tier of Object.keys(cart).sort((a, b) => cart[b] - cart[a])) {
    const take = Math.min(cart[tier], n - moved);
    if (take <= 0) continue;
    cart[tier] -= take; moved += take;
    roster.ore[tier] = (roster.ore[tier] || 0) + take;
    if (!cart[tier]) delete cart[tier];
  }
  if (!cartTotal(cart)) delete roster.carts[session];
  if (moved) rosterDirty = true;
  return moved;
}
function haulOre(body) {
  if (!body || typeof body.session !== 'string' || !Number.isInteger(body.n) || body.n < 1 || body.n > 100) return false;
  moveToStore(body.session, body.n);
  saveRoster(false);
  return true; // a cart already emptied (the session ended meanwhile) moves nothing, which is fine
}
// Sessions that are gone: their carts go to the store.
function flushEndedCarts() {
  for (const session of Object.keys(roster.carts)) if (!liveSessions.has(session)) moveToStore(session, Infinity);
}

// Which view reports: views say who they are when they poll; the overlay app wins, then the oldest.
const views = new Map(); // id -> { app, first, seen }
function isReporter(viewId, app, now) {
  if (viewId) {
    const v = views.get(viewId) || { first: now };
    v.app = app; v.seen = now;
    views.set(viewId, v);
  }
  for (const [id, v] of views) if (now - v.seen > 6000) views.delete(id);
  const best = [...views.entries()].sort((a, b) => (b[1].app - a[1].app) || (a[1].first - b[1].first))[0];
  return !!viewId && !!best && best[0] === viewId;
}

// The whole crew for the tavern panel: stats, the folders they have worked in, and what each is doing.
let lastCrew = new Map(); // dwarf id -> { id, name, status } of its live session, from the latest state()
function rosterList() {
  return roster.dwarves.map((d) => ({
    ...dwarfInfo(d),
    tokens: d.tokens || 0,
    lastWorked: d.lastWorked || 0,
    projects: Object.entries(d.projects || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([dir, n]) => ({ name: path.basename(dir) || dir, sessions: n })),
    working: lastCrew.get(d.id) || null,
  })).sort((a, b) => b.xp - a.xp);
}

// Your own name and looks for a dwarf. Only known fields with sane values are kept; an empty name or a
// null look goes back to the generated one.
const HEX = /^#[0-9a-f]{6}$/i;
const LOOK_FIELDS = {
  beardColor: (v) => HEX.test(v), helm: (v) => HEX.test(v), tunic: (v) => HEX.test(v), boots: (v) => HEX.test(v), skin: (v) => HEX.test(v),
  beard: (v) => ['long', 'short', 'forked', 'braided', 'twin'].includes(v),
  bigNose: (v) => typeof v === 'boolean', buckle: (v) => typeof v === 'boolean', horn: (v) => typeof v === 'boolean',
};
function customiseDwarf(body) {
  const d = roster.dwarves.find((x) => x.id === body.id);
  if (!d) return false;
  // first name and surname, each typed or rolled; an empty one goes back to the generated part
  for (const key of ['firstName', 'lastName']) {
    if (typeof body[key] !== 'string') continue;
    const part = body[key].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
    if (part) d[key] = part; else delete d[key];
    delete d.nameSeed; // an older way of keeping a rolled name: the two parts replace it
  }
  if (body.nameSeed === null) delete d.nameSeed;
  if (body.look === null) delete d.look;
  else if (body.look && typeof body.look === 'object') {
    const look = {};
    for (const [k, ok] of Object.entries(LOOK_FIELDS)) if (k in body.look && ok(body.look[k])) look[k] = body.look[k];
    if (Object.keys(look).length) d.look = look; else delete d.look;
  }
  rosterDirty = true;
  saveRoster(true);
  return true;
}

// --- day and night -------------------------------------------------------------
// When it is daylight in the mine: the work days and the daylight hours (one or more windows; the
// gaps between them, like a lunch break, are night). Saved next to the roster; null means the default.
const SETTINGS_FILE = path.join(path.dirname(ROSTER_FILE), 'settings.json');
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hmMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
function cleanSchedule(sched) {
  if (!sched || typeof sched !== 'object' || !Array.isArray(sched.days) || !Array.isArray(sched.windows)) return null;
  const days = [...new Set(sched.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const windows = [];
  for (const w of sched.windows.filter((w) => Array.isArray(w) && HM.test(w[0]) && HM.test(w[1]) && hmMin(w[0]) < hmMin(w[1]))
    .sort((a, b) => hmMin(a[0]) - hmMin(b[0])).slice(0, 8)) {
    if (!windows.length || hmMin(w[0]) > hmMin(windows[windows.length - 1][1])) windows.push([w[0], w[1]]);
  }
  return { days, windows };
}
const loadSchedule = () => cleanSchedule((readJson(SETTINGS_FILE) || {}).schedule);
let schedule = loadSchedule();
function saveSchedule(next) {
  schedule = next; // null: back to the default
  try {
    writeJson(SETTINGS_FILE, { schedule });
  } catch (err) {
    console.warn('could not save the settings:', err.message);
  }
}

function state(viewId, app) {
  const now = Date.now();
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { /* Claude Code not started yet */ }
  const sessions = [];
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const entry = sessionEntry(path.join(dir, file), now);
      if (entry) sessions.push(entry);
    } catch (err) {
      console.warn(`skipped ${file}:`, err.message); // one odd session file must not take the others down
    }
  }
  linkParents(sessions, now);
  for (const [file, t] of transcripts) if (now - t.used > CACHE_IDLE_MS) transcripts.delete(file);
  const live = new Set(sessions.map((x) => x.id));
  for (const id of transcriptPaths.keys()) if (!live.has(id)) transcriptPaths.delete(id);
  liveSessions = new Set(sessions.map((s) => s.id));
  flushEndedCarts();
  for (const s of sessions) s.cart = cartTotal(roster.carts[s.id]);
  const crew = assignDwarves(sessions, now);
  lastCrew = new Map();
  for (const s of sessions) {
    const d = crew.get(s.id);
    s.dwarf = dwarfInfo(d);
    lastCrew.set(d.id, { id: s.id, name: s.name, status: s.status });
  }
  return { now, contextWindow: CONTEXT_WINDOW, sessions, usage: usageScan.summary, roster: roster.dwarves.length, schedule, ore: roster.ore, reporter: isReporter(viewId, app, now) };
}

// --- opening a session in the Claude desktop app --------------------------------
// Desktop sessions record their app-side id (hostSessionId, "local_…") in their session file. The Claude
// app opens one through claude://code/continue?session=local_…, the link it builds itself for its own
// "continue" entries. That link is not documented, so an app update could change it.
const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/;

function hostIdOf(sessionId) {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return null; }
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    const s = readJson(path.join(dir, file));
    if (s && s.sessionId === sessionId && HOST_ID.test(String(s.hostSessionId)) && running(s)) return s.hostSessionId;
  }
  return null;
}

function openInClaude(hostId) {
  const url = 'claude://code/continue?session=' + hostId; // hostId matched HOST_ID, so no quoting issues
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', (err) => {
    console.warn('could not open the Claude app:', err.message);
  }).unref();
}

// --- subsessions --------------------------------------------------------------
// A desktop session can start another one (a "New task" card, a hand-off). The app records that in its own
// metadata for the new session, Claude-Data\<install>\claude-code-sessions\<a>\<b>\local_<id>.json, as
// spawnedFrom.sessionId: the parent's local_… id. That file is undocumented and has only been seen on
// Windows, so an app update could move it; without it every session is simply its own tunnel.
const APP_DATA = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Claude-Data') : null;
const APP_DIRS_RECHECK_MS = 60 * 1000;
const appDirs = { list: [], at: 0 };
const spawned = new Map(); // child local_… id -> { parent: local_… id or null, found, at }

const subdirs = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); }
  catch { return []; }
};
function appSessionDirs(now) {
  if (!APP_DATA || now - appDirs.at < APP_DIRS_RECHECK_MS) return appDirs.list;
  appDirs.at = now;
  appDirs.list = subdirs(APP_DATA).flatMap((install) => subdirs(path.join(install, 'claude-code-sessions')))
    .flatMap(subdirs);
  return appDirs.list;
}
function parentHostOf(hostId, now) {
  const known = spawned.get(hostId);
  if (known && (known.found || now - known.at < MISS_RETRY_MS)) return known.parent;
  for (const dir of appSessionDirs(now)) {
    const meta = readJson(path.join(dir, hostId + '.json'));
    if (!meta) continue;
    const from = meta.spawnedFrom && meta.spawnedFrom.sessionId;
    const parent = HOST_ID.test(String(from)) && from !== hostId ? from : null;
    spawned.set(hostId, { parent, found: true, at: now }); // set when the session is started, so kept for good
    return parent;
  }
  spawned.set(hostId, { parent: null, found: false, at: now });
  return null;
}
// Each session gets parent: the id of the running session that started it, or null.
function linkParents(sessions, now) {
  const byHost = new Map(sessions.filter((s) => s.hostId).map((s) => [s.hostId, s.id]));
  for (const s of sessions) {
    const parentHost = s.hostId ? parentHostOf(s.hostId, now) : null;
    s.parent = (parentHost && byHost.get(parentHost)) || null;
    delete s.hostId;
  }
  for (const id of spawned.keys()) if (!byHost.has(id)) spawned.delete(id);
}

// /compact (and other slash commands) write nothing to the transcript until they finish: the entries for a
// manual compaction all land at once, about a minute later. So a session that turned busy after its last
// reply ended, and has written nothing since, is working outside the conversation, almost always compacting.
// Auto-compaction mid-turn looks like a quiet model call and cannot be told apart.
const OUTSIDE_CHAT_MS = 4000;
function busyOutsideChat(s, t, now) {
  const since = s.statusUpdatedAt || 0;
  return s.status === 'busy' && !!t && !!t.step.ended && t.at < since && now - since > OUTSIDE_CHAT_MS;
}

function sessionEntry(file, now) {
  const s = readJson(file);
  if (!s || typeof s.sessionId !== 'string' || !running(s)) return null;
  const cwd = typeof s.cwd === 'string' ? s.cwd : '';
  const transcript = transcriptPath(s.sessionId, cwd);
  const t = transcript ? readTranscript(transcript) : null;
  return {
      id: s.sessionId,
      pid: s.pid,
      name: (typeof s.name === 'string' && s.name) || path.basename(cwd) || 'Session',
      cwd,
      openable: HOST_ID.test(String(s.hostSessionId)), // a desktop-app session that "Open in Claude" can reach
      hostId: HOST_ID.test(String(s.hostSessionId)) ? s.hostSessionId : null, // replaced by parent in linkParents
      status: s.status || 'unknown',
      since: s.statusUpdatedAt || s.updatedAt || s.startedAt || now,
      startedAt: s.startedAt || 0,
      model: t ? t.model : '',
      pricing: pricing(t && t.model, t && t.speed),
      tokens: tokensOf(t),
      prompt: t ? t.prompt : '',
      toolCalls: t ? t.toolCalls : 0,
      // when the last turn happened (survives app restarts, unlike statusUpdatedAt) and whether it asked you something
      turn: t ? { at: t.lastTurnAt || null, asked: askedYou(t) } : null,
      activity: busyOutsideChat(s, t, now) ? { at: s.statusUpdatedAt, kind: 'compacting' } : activityOf(t),
      feed: t ? t.tools.slice(-FEED_SEND).reverse() : [], // newest first
      agents: transcript ? listAgents(transcript, now) : [],
  };
}

// --- plan usage (estimate) ----------------------------------------------------
// The Claude app's "Your usage limits" card (5-hour limit, weekly limit) is not available to local
// programs. This estimates it: every reply in every local transcript of the past week, priced at list
// price per model, summed over the current 5-hour and weekly windows, and scaled by a calibration taken
// from the app's real numbers (usage-calibration.json: percent and reset time of each window, plus when
// they were read). Usage from other devices or claude.ai in a browser is not in the local logs, so the
// estimate drifts; recalibrating fixes it.
// The file lives with the roster, so a new release unzipped somewhere else keeps it. It used to sit next to
// server.js: one found there is copied over on start (and left where it was).
const fsp = fs.promises;
const CALIBRATION_FILE = process.env.DWARFWATCH_CALIBRATION || path.join(path.dirname(ROSTER_FILE), 'usage-calibration.json');
function bringOverCalibration() {
  const old = path.join(__dirname, 'usage-calibration.json');
  if (process.env.DWARFWATCH_CALIBRATION || fs.existsSync(CALIBRATION_FILE) || !fs.existsSync(old)) return;
  try {
    fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
    fs.copyFileSync(old, CALIBRATION_FILE);
    console.log(`moved the usage calibration to ${CALIBRATION_FILE}; edit it there from now on`);
  } catch (err) { console.warn('could not copy the usage calibration:', err.message); }
}
const HOUR = 3600 * 1000, FIVE_HOURS = 5 * HOUR, WEEK = 7 * 24 * HOUR;
const usageScan = { files: new Map(), busy: false, summary: null };

function replyCost(model, u) {
  const p = pricing(model, u.speed);
  if (p.input == null) return 0;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  return (input * p.input + (u.output_tokens || 0) * p.output) / 1e6;
}

async function scanUsageFile(file) {
  const st = await fsp.stat(file);
  let u = usageScan.files.get(file);
  if (!u || st.size < u.offset) { u = { offset: 0, rest: null, replies: new Map(), mtime: 0 }; usageScan.files.set(file, u); }
  u.mtime = st.mtimeMs;
  if (st.size <= u.offset) return;
  const fh = await fsp.open(file, 'r');
  try {
    while (u.offset < st.size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, st.size - u.offset));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, u.offset);
      if (!bytesRead) break;
      u.offset += bytesRead;
      const buf = u.rest ? Buffer.concat([u.rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const end = buf.lastIndexOf(10);
      if (end < 0) { u.rest = Buffer.from(buf); continue; }
      u.rest = end + 1 < buf.length ? Buffer.from(buf.subarray(end + 1)) : null;
      for (const line of buf.toString('utf8', 0, end).split('\n')) {
        if (!line.includes('"usage"') || line.startsWith('{"type":"api-request')) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const m = d && d.type === 'assistant' && d.message;
        if (!m || !m.usage || !m.id) continue;
        const at = Date.parse(d.timestamp) || 0, cost = replyCost(m.model, m.usage);
        const seen = u.replies.get(m.id); // one reply is written as several entries: count it once
        if (!seen) u.replies.set(m.id, { at, cost });
        else if (cost > seen.cost) seen.cost = cost;
      }
      await new Promise((r) => setImmediate(r)); // let polls through while a big file is read
    }
  } finally {
    await fh.close();
  }
}

async function recentTranscripts(since) {
  const out = [];
  const projects = path.join(CLAUDE_DIR, 'projects');
  let dirs = [];
  try { dirs = await fsp.readdir(projects); } catch { return out; }
  for (const dir of dirs) {
    const base = path.join(projects, dir);
    let names = [];
    try { names = await fsp.readdir(base); } catch { continue; }
    for (const name of names) {
      const full = path.join(base, name);
      if (name.endsWith('.jsonl')) out.push(full);
      else if (!name.includes('.')) { // a session folder: its subagents
        try { for (const sub of await fsp.readdir(path.join(full, 'subagents'))) if (sub.endsWith('.jsonl')) out.push(path.join(full, 'subagents', sub)); } catch { /* none */ }
      }
    }
  }
  const fresh = [];
  for (const f of out) { try { if ((await fsp.stat(f)).mtimeMs >= since) fresh.push(f); } catch { /* gone */ } }
  return fresh;
}

function costBetween(from, to) {
  let sum = 0;
  for (const u of usageScan.files.values()) for (const r of u.replies.values()) if (r.at >= from && r.at < to) sum += r.cost;
  return sum;
}

function firstReplyAfter(t) {
  let first = Infinity;
  for (const u of usageScan.files.values()) for (const r of u.replies.values()) if (r.at >= t && r.at < first) first = r.at;
  return first === Infinity ? null : first;
}

// Turns the calibration into current percentages. Windows roll forward from the calibrated reset times:
// the weekly one every 7 days; a 5-hour one starts with the first reply after the previous one ended.
function usageSummary(now, complete) {
  const cal = readJson(CALIBRATION_FILE);
  if (!cal || !cal.fiveHour || !cal.weekly) return null;
  const measured = Date.parse(cal.measuredAt);
  let changed = false;
  for (const [key, span] of [['fiveHour', FIVE_HOURS], ['weekly', WEEK]]) {
    const w = cal[key];
    // A capacity is worked out once per reading (capacityFrom: the measuredAt it came from), so new
    // numbers typed over an old reading are used instead of the capacity saved from it. Files from
    // before capacityFrom keep their capacity, which is taken to be from the reading they hold.
    if (w.capacity && w.capacityFrom === undefined) { w.capacityFrom = cal.measuredAt; changed = true; }
    if ((!w.capacity || w.capacityFrom !== cal.measuredAt) && w.percent > 0) {
      // Saved for good, so only from a scan that read every transcript (a locked file would make it too
      // small and every later percentage too high), and never zero (no replies in that window yet).
      const capacity = costBetween(Date.parse(w.resetsAt) - span, measured) / (w.percent / 100);
      if (!complete || !(capacity > 0)) return null;
      w.capacity = capacity;
      w.capacityFrom = cal.measuredAt;
      changed = true;
    }
  }
  if (changed) { try { writeJson(CALIBRATION_FILE, cal, 2); } catch { /* keep in memory */ } }

  let weekEnd = Date.parse(cal.weekly.resetsAt);
  while (weekEnd <= now) weekEnd += WEEK;
  const weekly = { percent: Math.round(costBetween(weekEnd - WEEK, now) / cal.weekly.capacity * 100), resetsAt: new Date(weekEnd).toISOString() };

  let fiveEnd = Date.parse(cal.fiveHour.resetsAt), fiveStart = fiveEnd - FIVE_HOURS;
  while (fiveEnd <= now) {
    const next = firstReplyAfter(fiveEnd);
    if (next === null || next > now) { fiveStart = null; break; } // no window running: nothing used yet
    fiveStart = next; fiveEnd = next + FIVE_HOURS;
  }
  const fiveHour = fiveStart === null ? { percent: 0, resetsAt: null }
    : { percent: Math.round(costBetween(fiveStart, now) / cal.fiveHour.capacity * 100), resetsAt: new Date(fiveEnd).toISOString() };
  return { estimated: true, plan: cal.plan || '', calibratedAt: cal.measuredAt, fiveHour, weekly };
}

async function refreshUsage() {
  if (usageScan.busy) return;
  usageScan.busy = true;
  try {
    const since = Date.now() - WEEK - 6 * HOUR;
    const files = await recentTranscripts(since);
    let complete = true;
    for (const f of files) { try { await scanUsageFile(f); } catch { complete = false; /* locked or gone: next time */ } }
    for (const [f, u] of usageScan.files) if (u.mtime < since) usageScan.files.delete(f);
    usageScan.summary = usageSummary(Date.now(), complete) || usageScan.summary;
  } catch (err) {
    console.warn('usage estimate failed:', err.message);
  } finally {
    usageScan.busy = false;
  }
}

// --- http --------------------------------------------------------------------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/mine.js': ['mine.js', 'text/javascript; charset=utf-8'],
};

const createServer = () => http.createServer((req, res) => {
  // Loopback only, and refuse foreign Host headers (DNS rebinding).
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403).end(); return; }

  const url = req.url.split('?')[0];
  if (url === '/api/open') {
    // POST with a custom header: a page on another site can't send that without a CORS preflight,
    // which this server never approves, so only Dwarfwatch's own page can open sessions.
    if (req.method !== 'POST' || req.headers['x-dwarfwatch'] !== '1') { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 200) req.destroy(); });
    req.on('end', () => {
      const hostId = hostIdOf(body.trim());
      if (!hostId) { res.writeHead(404).end(); return; }
      openInClaude(hostId);
      res.writeHead(204).end();
    });
    return;
  }
  if (url === '/api/roster' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ dwarves: rosterList() }));
    return;
  }
  if (url === '/api/dwarf') {
    // same guard as /api/open: only Dwarfwatch's own page can send this custom header
    if (req.method !== 'POST' || req.headers['x-dwarfwatch'] !== '1') { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (!data || typeof data.id !== 'string' || !customiseDwarf(data)) { res.writeHead(404).end(); return; }
      res.writeHead(204).end();
    });
    return;
  }
  if (url === '/api/ore') {
    // same guard as /api/open: only Dwarfwatch's own page can send this custom header
    if (req.method !== 'POST' || req.headers['x-dwarfwatch'] !== '1') { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 200) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const ok = data && data.op === 'mine' ? mineOre(data) : data && data.op === 'haul' ? haulOre(data) : false;
      res.writeHead(ok ? 204 : 400).end();
    });
    return;
  }
  if (url === '/api/settings') {
    // same guard as /api/open; body { schedule: { days, windows } } or { schedule: null } for the default
    if (req.method !== 'POST' || req.headers['x-dwarfwatch'] !== '1') { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (!data || !('schedule' in data)) { res.writeHead(400).end(); return; }
      const next = data.schedule === null ? null : cleanSchedule(data.schedule);
      if (data.schedule !== null && !next) { res.writeHead(400).end(); return; }
      saveSchedule(next);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ schedule }));
    });
    return;
  }
  if (url === '/api/state') {
    let body;
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      body = JSON.stringify(state(String(q.get('view') || '').slice(0, 64), q.get('app') === '1' ? 1 : 0));
    } catch (err) {
      console.error('state failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } else if (STATIC[url]) {
    const [file, type] = STATIC[url];
    fs.readFile(path.join(__dirname, file), (err, body) => {
      if (err) { res.writeHead(500).end(file + ' missing'); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    });
  } else {
    res.writeHead(404).end();
  }
});

// --- start -------------------------------------------------------------------
// Everything with side effects (old data copied over, timers, signal handlers, the port) happens here,
// so the tests can load this file without starting a server.

function start() {
  if (bringOverOldData()) { Object.assign(roster, loadRoster()); schedule = loadSchedule(); }
  bringOverCalibration();
  process.on('exit', () => saveRoster(true));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveRoster(true); process.exit(0); });
  refreshUsage();
  setInterval(refreshUsage, 30 * 1000);
  createServer().on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    // Exit code 2 tells the overlay app the port is taken, so it can say so instead of waiting forever.
    console.error(`Port ${PORT} is already in use. Is Dwarfwatch already running? Otherwise set PORT to a free port.`);
    process.exit(2);
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`Dwarfwatch running at http://localhost:${PORT}`);
  });
}

if (require.main === module) start();

module.exports = {
  pricing, freshStats, ingest, askedYou, readTranscript, listAgents, transcriptPath,
  levelOf, xpFor, assignDwarves, customiseDwarf, cleanSchedule, mineOre, haulOre, moveToStore,
  replyCost, refreshUsage, usage: () => usageScan.summary, createServer, roster,
  _setLiveSessions: (ids) => { liveSessions = new Set(ids); }, // for the tests
};
