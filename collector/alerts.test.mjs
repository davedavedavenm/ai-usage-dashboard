import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual production functions with isolated network/state dependencies.
const source = readFileSync(new URL('./collect.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function tightestEntry('), source.indexOf('async function main()'));
const provider = pct => ({ fixture: { label: 'Fixture', entries: [{ name: 'Weekly', window: 'weekly', resetAt: '2026-09-14T06:34:00Z', renderType: 'percent', percentRemaining: pct }] } });
const config = { enabled: true, token: 'private-fixture', chatId: 'fixture', threshold: 15, webhookUrl: 'https://fixture.invalid/hook' };

function harness(replies = []) {
  const calls = [], writes = [], logs = [];
  const context = vm.createContext({
    ALERT_THRESHOLD_DEFAULT: 15, DASHBOARD_URL: 'https://fixture.invalid', TG_API: 'https://fixture.invalid', REQ_TIMEOUT_MS: 20,
    AbortController, setTimeout, clearTimeout, console: { log: value => logs.push(value) },
    writeState: state => writes.push(JSON.parse(JSON.stringify(state))),
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const response = replies.shift() ?? { status: 200, ok: true, body: { ok: true } };
      if (response instanceof Error) throw response;
      return { ...response, json: async () => response.body, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  vm.runInContext(functions, context);
  return { context, calls, writes, logs };
}

test('HTTP failure and Telegram negative/missing receipt cannot advance sent state', async () => {
  for (const response of [{ status: 500, ok: false, body: { ok: true } }, { status: 200, ok: true, body: { ok: false } }, { status: 200, ok: true, body: {} }, new Error('secret URL')]) {
    const h = harness([response]);
    const state = {};
    await h.context.runAlerts(provider(14), state, { ...config, webhookUrl: '' });
    assert.equal(h.writes.length, 0);
    assert.equal(state.alerts?.fixture, undefined);
    assert.equal(h.logs.join('').includes('secret URL'), false);
    await h.context.runAlerts(provider(14), state, { ...config, webhookUrl: '' });
    assert.equal(h.writes.length, 1);
  }
});

test('partial channel receipt survives restart; only failed destination retries', async () => {
  const h = harness([{ status: 200, ok: true, body: { ok: true } }, { status: 503, ok: false }]);
  await h.context.runAlerts(provider(14), {}, config);
  assert.equal(h.writes.length, 1);
  const restarted = harness();
  await restarted.context.runAlerts(provider(14), h.writes.at(-1), config);
  assert.equal(restarted.calls.length, 1);
  assert.match(restarted.calls[0].url, /\/hook$/);
});

test('exhaustion is distinct from final warning; repeated and weaker stages stay silent', async () => {
  const h = harness();
  const state = {};
  const cfg = { ...config, webhookUrl: '' };
  await h.context.runAlerts(provider(14), state, cfg);
  await h.context.runAlerts(provider(0), state, cfg);
  await h.context.runAlerts(provider(0), state, cfg);
  await h.context.runAlerts(provider(25), state, cfg);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].body.text, /Nothing left/);
});

test('legacy sent stages are not replayed; new reset may alert', async () => {
  const h = harness();
  const state = { alerts: { fixture: { winKey: 'weekly|2026-09-14T06:34:00Z', stages: { 15: '2026-09-07T10:00:00Z' } } } };
  await h.context.runAlerts(provider(14), state, config);
  assert.equal(h.calls.length, 0);
  const next = provider(14);
  next.fixture.entries[0].resetAt = '2026-09-21T06:34:00Z';
  await h.context.runAlerts(next, state, config);
  assert.equal(h.calls.length, 2);
});

test('missing reset does not cause a repeat every collection', async () => {
  const h = harness();
  const state = {}, data = provider(14);
  delete data.fixture.entries[0].resetAt;
  await h.context.runAlerts(data, state, config);
  await h.context.runAlerts(data, state, config);
  assert.equal(h.calls.length, 2);
});

test('only configured near-exhaustion and exhausted stages remain', () => {
  const h = harness();
  assert.deepEqual(Array.from(h.context.buildStages(15), stage => stage.pct), [15, 0]);
});

test('alternating tightest windows retains each receipt history across restart', async () => {
  const h = harness(), state = {}, cfg = { ...config, webhookUrl: '' };
  const data = provider(14);
  data.fixture.entries.push({ ...data.fixture.entries[0], name: 'Short', window: 'short', percentRemaining: 90 });
  await h.context.runAlerts(data, state, cfg);
  data.fixture.entries[1].percentRemaining = 10;
  await h.context.runAlerts(data, state, cfg);
  const restarted = harness();
  data.fixture.entries[1].percentRemaining = 100;
  await restarted.context.runAlerts(data, h.writes.at(-1), cfg);
  assert.equal(h.calls.length, 2);
  assert.equal(restarted.calls.length, 0);
});

test('legacy window is migrated before another window replaces the old record', async () => {
  const h = harness(), cfg = { ...config, webhookUrl: '' };
  const state = { alerts: { fixture: { winKey: 'weekly|2026-09-14T06:34:00Z', stages: { 15: '2026-09-07T10:00:00Z' } } } };
  const data = provider(14);
  data.fixture.entries.push({ ...data.fixture.entries[0], name: 'Short', window: 'short', percentRemaining: 10 });
  await h.context.runAlerts(data, state, cfg);
  const restarted = harness();
  data.fixture.entries[1].percentRemaining = 100;
  await restarted.context.runAlerts(data, h.writes.at(-1), cfg);
  assert.equal(h.calls.length, 1);
  assert.equal(restarted.calls.length, 0);
});

test('state persistence uses fsync + rename; read/write failures stay visible', () => {
  const stateCode = source.slice(source.indexOf('function readState()'), source.indexOf('function readDashboardSettings()'));
  const calls = [];
  const context = vm.createContext({ STATE_FILE: '/private/state.json', process: { pid: 1 }, dirname: () => '/private',
    readFileSync: () => '{broken', writeFileSync: (path, data, options) => calls.push(['write', options]),
    renameSync: () => calls.push(['rename']), openSync: () => 9, fsyncSync: () => calls.push(['fsync']), closeSync: () => calls.push(['close']) });
  vm.runInContext(stateCode, context);
  assert.throws(() => context.readState(), /refusing to reset/);
  for (const corrupt of [{ alerts: [] }, { alerts: { fixture: { stages: [] } } }, { alertWindows: { fixture: [] } }, { alerts: { fixture: { stages: { 15: { telegram: true } } } } }, { rolloverAlerts: [] }, { rolloverAlerts: { fixture: { stages: [] } } }, { rolloverAlerts: { fixture: { stages: { 24: { telegram: true } } } } }]) {
    context.readFileSync = () => JSON.stringify(corrupt);
    assert.throws(() => context.readState(), /refusing to reset/);
  }
  context.writeState({ alerts: {} });
  assert.equal(calls[0][1].flush, true);
  assert.deepEqual(calls.slice(1).map(c => c[0]), ['rename', 'fsync', 'close']);
  context.writeFileSync = () => { throw new Error('disk full'); };
  assert.throws(() => context.writeState({}), /disk full/);
});


test('midpoint samples stay silent and preserve old provider/window receipts', async () => {
  const h = harness();
  const record = { winKey: 'weekly|2026-09-14T06:34:00Z', stages: {
    50: { telegram: '2026-09-07T10:00:00Z' },
    30: { webhook: '2026-09-07T11:00:00Z' },
  } };
  const state = { alerts: { fixture: record }, alertWindows: { fixture: { weekly: record } }, unrelated: { retained: true } };
  const before = JSON.stringify(state);
  for (const pct of [80, 50, 40, 30, 25, 16]) await h.context.runAlerts(provider(pct), state, config);
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(JSON.stringify(state), before);
  await h.context.runAlerts(provider(15), state, config);
  assert.equal(h.calls.length, 2);
  assert.equal(state.alertWindows.fixture.weekly.stages[50].telegram, '2026-09-07T10:00:00Z');
  assert.equal(state.alertWindows.fixture.weekly.stages[30].webhook, '2026-09-07T11:00:00Z');
  assert.equal(state.unrelated.retained, true);
});

test('longestPeriodEntries picks the longest allowance window', () => {
  const h = harness();
  const providers = {
    'opencode-go': {
      label: 'OpenCode Go',
      entries: [
        { name: 'Last 5 hours', window: 'rolling', resetAt: '2026-09-20T12:00:00Z', renderType: 'percent', percentRemaining: 100 },
        { name: 'This week', window: 'weekly', resetAt: '2026-09-21T00:00:00Z', renderType: 'percent', percentRemaining: 90 },
        { name: 'This month', window: 'monthly', resetAt: '2026-09-30T00:00:00Z', renderType: 'percent', percentRemaining: 50 },
      ],
    },
    'anthropic': {
      label: 'Claude',
      entries: [
        { name: '5h', window: '5h', resetAt: '2026-09-20T12:00:00Z', renderType: 'percent', percentRemaining: 20 },
        { name: 'Weekly', window: 'weekly', resetAt: '2026-09-21T03:00:00Z', renderType: 'percent', percentRemaining: 60 },
      ],
    },
  };
  const longest = h.context.longestPeriodEntries(providers);
  assert.equal(longest.length, 2);
  assert.equal(longest.find(p => p.id === 'opencode-go').entry.name, 'This month');
  assert.equal(longest.find(p => p.id === 'anthropic').entry.name, 'Weekly');
});

test('rollover alerts: 24h and 12h warnings fire before reset when allowance remains', async () => {
  const h = harness();
  const state = {};
  const cfg = { ...config, webhookUrl: '' };
  const resetAt = '2026-09-20T12:00:00Z';
  const data = { fixture: { label: 'Claude', entries: [{ name: 'Weekly', window: 'weekly', resetAt, renderType: 'percent', percentRemaining: 66 }] } };

  // 26 hours before reset -> no rollover alert
  const t26 = new Date('2026-09-19T10:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t26);
  assert.equal(h.calls.length, 0);

  // 23 hours before reset -> 24h rollover warning fires
  const t23 = new Date('2026-09-19T13:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t23);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].body.text, /resets in ~24 hours/);
  assert.match(h.calls[0].body.text, /66%<\/b> allowance remaining/);

  // Subsequent collection within 24h window -> deduped, no repeat
  const t22 = new Date('2026-09-19T14:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t22);
  assert.equal(h.calls.length, 1);

  // 10 hours before reset -> 12h rollover warning fires
  const t10 = new Date('2026-09-20T02:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t10);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].body.text, /resets in ~12 hours/);

  // Subsequent collection within 12h window -> deduped, no repeat
  const t8 = new Date('2026-09-20T04:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t8);
  assert.equal(h.calls.length, 2);

  // Past reset -> no alert
  const tPast = new Date('2026-09-20T13:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, tPast);
  assert.equal(h.calls.length, 2);
});

test('rollover alerts: 0% allowance remaining suppresses warning (nothing to lose)', async () => {
  const h = harness();
  const state = {};
  const cfg = { ...config, webhookUrl: '' };
  const resetAt = '2026-09-20T12:00:00Z';
  const data = { fixture: { label: 'Claude', entries: [{ name: 'Weekly', window: 'weekly', resetAt, renderType: 'percent', percentRemaining: 0 }] } };

  // 23 hours before reset with 0% remaining
  const t23 = new Date('2026-09-19T13:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t23);
  assert.equal(h.calls.length, 0);

  // 10 hours before reset with 0% remaining
  const t10 = new Date('2026-09-20T02:00:00Z').getTime();
  await h.context.runRolloverAlerts(data, state, cfg, t10);
  assert.equal(h.calls.length, 0);
});

test('rollover alerts: short rolling windows (< 24h duration) never trigger rollover alerts', async () => {
  const h = harness();
  const state = {};
  const cfg = { ...config, webhookUrl: '' };
  // 5-hour rolling window resetting in 3 hours
  const resetAt = '2026-09-20T12:00:00Z';
  const data = {
    fixture: {
      label: 'Google Antigravity',
      entries: [
        { name: 'G3Flash', window: 'agy-g3flash', resetAt, renderType: 'percent', percentRemaining: 80 },
        { name: '5h', window: '5h', resetAt, renderType: 'percent', percentRemaining: 50 },
        { name: 'Last 5 hours', window: 'rolling', resetAt, renderType: 'percent', percentRemaining: 90 },
      ],
    },
  };
  const t3 = new Date('2026-09-20T09:00:00Z').getTime(); // 3 hours before reset
  await h.context.runRolloverAlerts(data, state, cfg, t3);
  assert.equal(h.calls.length, 0);
});

test('rollover alerts: new reset period clears dedupe and allows new cycle of warnings', async () => {
  const h = harness();
  const state = {};
  const cfg = { ...config, webhookUrl: '' };
  const reset1 = '2026-09-20T12:00:00Z';
  const data = { fixture: { label: 'Claude', entries: [{ name: 'Weekly', window: 'weekly', resetAt: reset1, renderType: 'percent', percentRemaining: 50 }] } };

  // Trigger 24h on first reset cycle
  await h.context.runRolloverAlerts(data, state, cfg, new Date('2026-09-19T13:00:00Z').getTime());
  assert.equal(h.calls.length, 1);

  // Next week reset
  const reset2 = '2026-09-27T12:00:00Z';
  data.fixture.entries[0].resetAt = reset2;

  // 23 hours before next week's reset -> fires again!
  await h.context.runRolloverAlerts(data, state, cfg, new Date('2026-09-26T13:00:00Z').getTime());
  assert.equal(h.calls.length, 2);
});

test('rollover alerts: 12h delivery suppresses 24h warning if 24h was missed', async () => {
  const h = harness();
  const state = {};
  const cfg = { ...config, webhookUrl: '' };
  const resetAt = '2026-09-20T12:00:00Z';
  const data = { fixture: { label: 'Claude', entries: [{ name: 'Weekly', window: 'weekly', resetAt, renderType: 'percent', percentRemaining: 40 }] } };

  // First check happens directly at 10 hours before reset (24h check missed)
  await h.context.runRolloverAlerts(data, state, cfg, new Date('2026-09-20T02:00:00Z').getTime());
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].body.text, /resets in ~12 hours/);

  // Subsequent check still in 12h window -> stays silent
  await h.context.runRolloverAlerts(data, state, cfg, new Date('2026-09-20T03:00:00Z').getTime());
  assert.equal(h.calls.length, 1);
});

test('rollover alerts: partial destination delivery survives restart', async () => {
  const h = harness([{ status: 200, ok: true, body: { ok: true } }, { status: 503, ok: false }]);
  const resetAt = '2026-09-20T12:00:00Z';
  const data = { fixture: { label: 'Claude', entries: [{ name: 'Weekly', window: 'weekly', resetAt, renderType: 'percent', percentRemaining: 30 }] } };
  const t23 = new Date('2026-09-19T13:00:00Z').getTime();

  await h.context.runRolloverAlerts(data, {}, config, t23);
  assert.equal(h.writes.length, 1);

  // On restart with recorded state, only failed webhook retries
  const restarted = harness();
  await restarted.context.runRolloverAlerts(data, h.writes.at(-1), config, t23);
  assert.equal(restarted.calls.length, 1);
  assert.match(restarted.calls[0].url, /\/hook$/);
  assert.equal(restarted.calls[0].body.event, 'rollover_alert');
  assert.equal(restarted.calls[0].body.hoursBeforeReset, 24);
});

