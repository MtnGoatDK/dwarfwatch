'use strict';
// Tests for server.js. Claude Code's transcripts and session files are not a documented format, so these
// pin down what Dwarfwatch understands of them: when a format change breaks parsing, a test should fail.
// Everything runs against a throwaway folder; nothing of yours is read or written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarfwatch-test-'));
const CLAUDE = path.join(tmp, 'claude');
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.DWARFWATCH_ROSTER = path.join(tmp, 'data', 'roster.json');
process.env.LOCALAPPDATA = path.join(tmp, 'appdata'); // where the Claude desktop app's session metadata is looked for
const dw = require('../server.js');

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// --- transcript entries, shaped like Claude Code writes them -------------------------------------

const at = (sec) => new Date(Date.UTC(2026, 10, 27, 10, 0, sec)).toISOString();
const assistant = (content, { id = 'msg_1', usage, stop = null, model = 'claude-opus-5-5', sec = 0 } = {}) =>
  ({ type: 'assistant', timestamp: at(sec), message: { id, model, role: 'assistant', content, usage, stop_reason: stop } });
const user = (content, { sec = 0, ...extra } = {}) => ({ type: 'user', timestamp: at(sec), message: { role: 'user', content }, ...extra });
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: 'done', is_error: isError });
const text = (t) => ({ type: 'text', text: t });

function feed(entries) {
  const s = dw.freshStats();
  for (const e of entries) dw.ingest(s, typeof e === 'string' ? e : JSON.stringify(e));
  return s;
}
const jsonl = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');

// --- pricing --------------------------------------------------------------------------------------

test('pricing ranks models into pickaxe tiers', () => {
  assert.deepEqual(dw.pricing('claude-opus-5-5'), { tier: 'gold', input: 4, output: 20, fast: false });
  assert.equal(dw.pricing('claude-opus-5-5[1m]').tier, 'gold', 'context-size suffix is ignored');
  assert.equal(dw.pricing('claude-haiku-4-5-20251001').tier, 'iron', 'date suffix is ignored');
  assert.equal(dw.pricing('haiku').tier, 'copper', 'aliases resolve to the current model');
  assert.equal(dw.pricing('claude-fable-5-2').tier, 'diamond');
  assert.deepEqual(dw.pricing('claude-opus-5-5', 'fast'), { tier: 'diamond', input: 8, output: 40, fast: true });
  assert.equal(dw.pricing('claude-sonnet-5-5', 'fast').fast, false, 'no fast price: the normal one');
  assert.deepEqual(dw.pricing('some-new-model'), { tier: 'wood', input: null, output: null, fast: false });
  assert.equal(dw.pricing(undefined).tier, 'wood');
});

// --- reading transcripts --------------------------------------------------------------------------

test('tool calls are counted once and get their results', () => {
  const s = feed([
    user('fix the bug'),
    assistant([toolUse('t1', 'Read', { file_path: '/x/src/app.js' })]),
    assistant([toolUse('t1', 'Read', { file_path: '/x/src/app.js' })]), // same reply written again
    user([toolResult('t1')]),
    assistant([toolUse('t2', 'Bash', { command: 'npm test', description: 'Run the tests' })], { id: 'msg_2' }),
    user([toolResult('t2', true)]),
    assistant([toolUse('t3', 'mcp__grafana__query_loki_logs', { query: '{app="x"}' })], { id: 'msg_3' }),
  ]);
  assert.equal(s.toolCalls, 3);
  assert.deepEqual(s.tools.map((t) => [t.tool, t.detail, t.state]), [
    ['Read', 'app.js', 'ok'],
    ['Bash', 'Run the tests', 'error'],
    ['grafana: query_loki_logs', '{app="x"}', 'running'],
  ]);
  assert.deepEqual(s.step, { kind: 'tool', tool: 'grafana: query_loki_logs', detail: '{app="x"}' });
});

test('only the last few tool calls are kept', () => {
  const entries = [];
  for (let i = 0; i < 12; i++) entries.push(assistant([toolUse('t' + i, 'Grep', { pattern: 'p' + i })], { id: 'm' + i }));
  const s = feed(entries);
  assert.equal(s.toolCalls, 12);
  assert.equal(s.tools.length, 8);
  assert.equal(s.tools[0].detail, 'p4');
});

test('tokens: output counted once per reply, context from the latest reply', () => {
  const s = feed([
    assistant([text('a')], { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 10 } }),
    assistant([toolUse('t1', 'Read')], { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 25 } }),
    assistant([text('b')], { id: 'm2', usage: { input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 5, speed: 'fast' } }),
  ]);
  assert.equal(s.output, 30);
  assert.equal(s.context, 2305);
  assert.equal(s.speed, 'fast');
  assert.equal(s.model, 'claude-opus-5-5');
});

test('synthetic replies do not change the model', () => {
  const s = feed([assistant([text('hi')]), assistant([text('No response requested.')], { id: 'm2', model: '<synthetic>' })]);
  assert.equal(s.model, 'claude-opus-5-5');
});

test('a typed prompt starts a new turn; slash commands and meta entries do not', () => {
  const s = feed([
    user('first question', { sec: 1 }),
    assistant([toolUse('t1', 'Read')], { sec: 2 }),
    user('<command-name>/compact</command-name>', { sec: 3 }),
    user('caveat text', { sec: 4, isMeta: true }),
  ]);
  assert.equal(s.prompt, 'first question');
  assert.equal(s.tools[0].state, 'running', 'a slash command does not end the running call');
  const s2 = feed([user('first'), assistant([toolUse('t1', 'Read')]), user([text('second prompt')], { sec: 9 })]);
  assert.equal(s2.prompt, 'second prompt');
  assert.equal(s2.tools[0].state, 'stopped', 'a new prompt means the old call never got a result');
  assert.equal(s2.lastTurnAt, Date.parse(at(9)));
});

test('the last-prompt entry sets the prompt', () => {
  assert.equal(feed([{ type: 'last-prompt', lastPrompt: 'resume me' }]).prompt, 'resume me');
});

test('broken and irrelevant lines are skipped', () => {
  const s = feed(['', '{not json', 'null', '42', '{"type":"api-request","body":{}}', { type: 'summary', summary: 'x' }]);
  assert.equal(s.toolCalls, 0);
  assert.equal(s.prompt, '');
});

test('a reply that ends the turn is marked ended', () => {
  assert.deepEqual(feed([assistant([text('All done.')], { stop: 'end_turn' })]).step, { kind: 'writing', ended: true });
  assert.deepEqual(feed([assistant([text('Looking…')])]).step, { kind: 'writing', ended: false });
  assert.deepEqual(feed([assistant([{ type: 'thinking', thinking: '' }])]).step, { kind: 'thinking' });
});

// --- did the turn ask you something? ----------------------------------------------------------------

test('asked: a question in the final paragraph', () => {
  assert.equal(dw.askedYou(feed([user('go'), assistant([text('Done.\n\nShall I commit it?')])])), true);
  assert.equal(dw.askedYou(feed([user('go'), assistant([text('Should I? I did.\n\nIt is done.')])])), false, 'earlier paragraph');
  assert.equal(dw.askedYou(feed([user('go'), assistant([text('See https://x.test/?q=1 and `a?b`.')])])), false, 'links and code');
});

test('asked: the text of the latest reply counts, not an earlier one', () => {
  const s = feed([user('go'), assistant([text('Which one?')]), assistant([text('Picked the first. Done.')], { id: 'm2' })]);
  assert.equal(dw.askedYou(s), false);
});

test('asked: an unanswered AskUserQuestion, until it is answered', () => {
  const s = feed([user('go'), assistant([toolUse('q1', 'AskUserQuestion', { questions: [] })])]);
  assert.equal(dw.askedYou(s), true);
  dw.ingest(s, JSON.stringify(user([toolResult('q1')])));
  dw.ingest(s, JSON.stringify(assistant([text('Thanks, done.')], { id: 'm2' })));
  assert.equal(dw.askedYou(s), false);
});

test('asked: a desktop-app wrap-up with a question', () => {
  const s = feed([user('go'), assistant([toolUse('w1', 'mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'Commit?' })]), assistant([text('Done.')], { id: 'm2' })]);
  assert.equal(dw.askedYou(s), true);
  dw.ingest(s, JSON.stringify(user('yes')));
  assert.equal(dw.askedYou(s), false, 'your next prompt answers it');
});

test('asked: you interrupted the turn', () => {
  const s = feed([user('go'), assistant([toolUse('t1', 'Bash')]), user([text('[Request interrupted by user]')])]);
  assert.equal(dw.askedYou(s), true);
  assert.equal(s.tools[0].state, 'stopped');
  assert.equal(s.prompt, 'go', 'the interruption is not a prompt');
});

test('a turn started by something else clears the question but keeps your prompt', () => {
  const s = feed([
    user('go'),
    assistant([text('Want me to continue?')]),
    user('<task-notification>agent finished</task-notification>', { origin: { kind: 'task-notification' } }),
  ]);
  assert.equal(dw.askedYou(s), false);
  assert.equal(s.prompt, 'go');
  assert.deepEqual(s.step, { kind: 'thinking' });
});

// --- files on disk ---------------------------------------------------------------------------------

test('transcripts are read incrementally, whole lines only', () => {
  const file = path.join(tmp, 'incremental.jsonl');
  const first = JSON.stringify(assistant([toolUse('t1', 'Read')]));
  const second = JSON.stringify(assistant([toolUse('t2', 'Edit')], { id: 'm2' }));
  fs.writeFileSync(file, first + '\n' + second.slice(0, 30));
  assert.equal(dw.readTranscript(file).toolCalls, 1);
  fs.appendFileSync(file, second.slice(30) + '\n');
  assert.equal(dw.readTranscript(file).toolCalls, 2);
  assert.equal(dw.readTranscript(file).toolCalls, 2, 'nothing new, nothing counted again');
  fs.writeFileSync(file, first + '\n'); // replaced by a shorter file: start over
  assert.equal(dw.readTranscript(file).toolCalls, 1);
  assert.equal(dw.readTranscript(path.join(tmp, 'missing.jsonl')), null);
});

test('transcripts are found by the session folder, or by searching', () => {
  const projects = path.join(CLAUDE, 'projects');
  const byCwd = path.join(projects, 'C--work-my-app');
  const elsewhere = path.join(projects, 'C--old-place');
  fs.mkdirSync(byCwd, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(byCwd, 'aaa.jsonl'), '');
  fs.writeFileSync(path.join(elsewhere, 'bbb.jsonl'), '');
  assert.equal(dw.transcriptPath('aaa', 'C:\\work\\my_app'), path.join(byCwd, 'aaa.jsonl'));
  assert.equal(dw.transcriptPath('bbb', 'C:\\work\\my_app'), path.join(elsewhere, 'bbb.jsonl'));
  assert.equal(dw.transcriptPath('ccc', 'C:\\work\\my_app'), null);
});

test('subagents: running ones shown, finished ones linger briefly, stale ones hidden', () => {
  const dir = path.join(tmp, 'agents');
  const transcript = path.join(dir, 'sess.jsonl');
  const subs = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const agent = (id, meta, entries, ageMs = 0) => {
    fs.writeFileSync(path.join(subs, id + '.meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(subs, id + '.jsonl'), jsonl(entries));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(path.join(subs, id + '.jsonl'), t, t);
  };
  agent('agent-run', { agentType: 'Explore', description: 'Find the config' }, [assistant([toolUse('t1', 'Grep')], { model: 'claude-haiku-5-5' })]);
  agent('agent-done', { agentType: 'Plan', finished: true, model: 'claude-sonnet-5-5' }, [assistant([text('plan')])], 30 * 1000);
  agent('agent-gone', { agentType: 'Plan', finished: true }, [assistant([text('plan')])], 5 * 60 * 1000);
  agent('agent-ended', { agentType: 'general-purpose' }, [assistant([text('report')], { stop: 'end_turn' })]);
  agent('agent-stale', { agentType: 'Explore' }, [assistant([toolUse('t1', 'Grep')])], 60 * 60 * 1000);

  const agents = dw.listAgents(transcript, Date.now());
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(byId).sort(), ['agent-done', 'agent-ended', 'agent-run']);
  assert.equal(byId['agent-run'].finished, false);
  assert.equal(byId['agent-run'].type, 'Explore');
  assert.equal(byId['agent-run'].pricing.tier, 'copper', 'model from the transcript');
  assert.equal(byId['agent-done'].finished, true);
  assert.equal(byId['agent-ended'].finished, true, 'a reply that ended the turn');
  assert.deepEqual(dw.listAgents(path.join(tmp, 'none.jsonl'), Date.now()), []);
});

// --- the crew ---------------------------------------------------------------------------------------

test('levels follow XP', () => {
  assert.deepEqual([0, 19, 20, 59, 60, 120, 200].map(dw.levelOf), [1, 1, 2, 2, 3, 4, 5]);
  for (let xp = 0; xp < 2000; xp += 7) {
    const level = dw.levelOf(xp);
    assert.ok(dw.xpFor(level) <= xp && xp < dw.xpFor(level + 1), `xp ${xp}`);
  }
});

test('dwarves: hired when needed, kept per session, matched to the project, paid in XP', () => {
  const session = (id, cwd, toolCalls, startedAt = 1) => ({ id, cwd, toolCalls, startedAt, status: 'busy', tokens: { output: toolCalls * 10 } });
  let crew = dw.assignDwarves([session('s1', 'C:\\a', 5), session('s2', 'C:\\b', 3, 2)], 1000);
  const d1 = crew.get('s1'), d2 = crew.get('s2');
  assert.notEqual(d1.id, d2.id);
  assert.equal(dw.roster.dwarves.length, 2);
  assert.equal(d1.xp, 5);

  crew = dw.assignDwarves([session('s1', 'C:\\a', 9), session('s2', 'C:\\b', 3, 2)], 2000);
  assert.equal(crew.get('s1'), d1, 'a session keeps its dwarf');
  assert.equal(d1.xp, 9, 'only new tool calls earn XP');
  assert.equal(d1.tokens, 90);

  // both end; a new session in C:\a gets the dwarf who has worked there, though d2 rested longer
  crew = dw.assignDwarves([session('s3', 'C:\\a', 0, 3)], 3000);
  assert.equal(crew.get('s3'), d1);
  assert.equal(dw.roster.dwarves.length, 2, 'nobody new is hired while someone is free');

  // s2 is resumed: it gets its old dwarf back; a third session at the same time needs a new hire
  crew = dw.assignDwarves([session('s3', 'C:\\a', 0, 3), session('s2', 'C:\\b', 3, 2), session('s4', 'C:\\c', 0, 4)], 4000);
  assert.equal(crew.get('s2'), d2);
  assert.equal(d2.xp, 3, 'a resumed session brings no XP twice');
  assert.equal(dw.roster.dwarves.length, 3);
  assert.ok(fs.existsSync(process.env.DWARFWATCH_ROSTER), 'the roster is saved');
});

test('dwarves: names and looks are cleaned before they are kept', () => {
  const d = dw.roster.dwarves[0];
  assert.equal(dw.customiseDwarf({ id: 'nobody' }), false);
  assert.equal(dw.customiseDwarf({ id: d.id, firstName: '  Gimli\u0007 the very long name ', lastName: '', look: { beard: 'forked', helm: '#a0b1c2', tunic: 'red', hat: '#000000' } }), true);
  assert.equal(d.firstName, 'Gimli the very l');
  assert.equal(d.lastName, undefined);
  assert.deepEqual(d.look, { beard: 'forked', helm: '#a0b1c2' });
  dw.customiseDwarf({ id: d.id, look: null });
  assert.equal(d.look, undefined);
});

test('ore: mined into live sessions\' carts, hauled to the store, nothing lost', () => {
  dw._setLiveSessions(['live']);
  const storeBefore = { ...dw.roster.ore };
  assert.equal(dw.mineOre({ session: 'live', tier: 'gold', n: 3 }), true);
  assert.equal(dw.mineOre({ session: 'live', tier: 'iron', n: 2 }), true);
  assert.equal(dw.mineOre({ session: 'gone', tier: 'gold', n: 1 }), false, 'only live sessions mine');
  assert.equal(dw.mineOre({ session: 'live', tier: 'mithril', n: 1 }), false);
  assert.equal(dw.mineOre({ session: 'live', tier: 'gold', n: 21 }), false);
  assert.equal(dw.mineOre({ session: 'live', tier: 'gold', n: 1.5 }), false);
  assert.equal(dw.haulOre({ session: 'live', n: 4 }), true);
  assert.deepEqual(dw.roster.carts.live, { iron: 1 }, 'the biggest pile goes up first');
  assert.equal(dw.moveToStore('live', Infinity), 1);
  assert.equal(dw.roster.carts.live, undefined);
  assert.equal((dw.roster.ore.gold || 0) - (storeBefore.gold || 0), 3);
  assert.equal((dw.roster.ore.iron || 0) - (storeBefore.iron || 0), 2);
});

// --- day and night ----------------------------------------------------------------------------------

test('schedules: bad values dropped, windows sorted, overlaps removed', () => {
  assert.equal(dw.cleanSchedule(null), null);
  assert.equal(dw.cleanSchedule({ days: [1] }), null);
  assert.deepEqual(dw.cleanSchedule({
    days: [1, 1, 5, 7, -1, 2.5, '3'],
    windows: [['13:00', '17:00'], ['08:00', '12:00'], ['09:00', '10:00'], ['25:00', '26:00'], ['15:00', '14:00'], 'x'],
  }), { days: [1, 5], windows: [['08:00', '12:00'], ['13:00', '17:00']] });
});

// --- usage estimate ---------------------------------------------------------------------------------

test('reply cost: cache writes cost more, cache reads less', () => {
  const cost = dw.replyCost('claude-opus-5-5', { input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6 });
  assert.ok(Math.abs(cost - (4 + 5 + 0.4 + 20)) < 1e-9);
  assert.equal(dw.replyCost('unknown-model', { input_tokens: 1e6 }), 0);
});

// --- the HTTP server --------------------------------------------------------------------------------

function request(port, { method = 'GET', url = '/', host = 'localhost', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('http: guards, the page and the state of a live session', async () => {
  // a running session: this test process, with a transcript in its project folder
  const cwd = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(CLAUDE, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, 'sessions', process.pid + '.json'), JSON.stringify({
    pid: process.pid, sessionId: 'live-1', cwd, status: 'busy', startedAt: 1, hostSessionId: 'local_abc-123',
  }));
  const folder = path.join(CLAUDE, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'live-1.jsonl'), jsonl([
    user('make it so'),
    assistant([toolUse('t1', 'Edit', { file_path: path.join(cwd, 'a.js') })], { usage: { input_tokens: 100, output_tokens: 7 } }),
  ]));

  const server = dw.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal((await request(port, { url: '/api/state', host: 'evil.test' })).status, 403, 'foreign Host (DNS rebinding)');
    assert.equal((await request(port, { method: 'POST', url: '/api/open', body: 'live-1' })).status, 403, 'no custom header');
    assert.equal((await request(port, { url: '/api/dwarf' })).status, 403, 'GET where POST is needed');
    assert.equal((await request(port, { url: '/nope' })).status, 404);
    assert.equal((await request(port, { url: '/server.js' })).status, 404, 'only the page and mine.js are served');
    const page = await request(port, { url: '/' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/i);

    const res = await request(port, { url: '/api/state?view=v1&app=1', host: 'localhost:' + port });
    assert.equal(res.status, 200);
    const state = JSON.parse(res.body);
    assert.equal(state.reporter, true);
    assert.equal(state.sessions.length, 1);
    const s = state.sessions[0];
    assert.equal(s.id, 'live-1');
    assert.equal(s.name, 'proj');
    assert.equal(s.openable, true);
    assert.equal(s.parent, null);
    assert.equal(s.prompt, 'make it so');
    assert.equal(s.toolCalls, 1);
    assert.deepEqual(s.feed.map((f) => f.detail), ['a.js']);
    assert.equal(s.pricing.tier, 'gold');
    assert.equal(typeof s.dwarf.id, 'string');

    const settings = { method: 'POST', url: '/api/settings', headers: { 'X-Dwarfwatch': '1' } };
    const ok = await request(port, { ...settings, body: JSON.stringify({ schedule: { days: [1, 2], windows: [['08:00', '16:00']] } }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).schedule, { days: [1, 2], windows: [['08:00', '16:00']] });
    assert.equal((await request(port, { ...settings, body: JSON.stringify({ schedule: 'x' }) })).status, 400);
    assert.equal((await request(port, { ...settings, body: '{' })).status, 400);
  } finally {
    server.close();
  }
});
