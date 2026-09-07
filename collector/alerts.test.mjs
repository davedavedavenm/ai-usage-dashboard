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

test('existing threshold stages preserved while preference is pending', () => {
  const h = harness();
  assert.deepEqual(Array.from(h.context.buildStages(15), stage => stage.pct), [50, 30, 15, 0]);
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
  for (const corrupt of [{ alerts: [] }, { alerts: { fixture: { stages: [] } } }, { alertWindows: { fixture: [] } }, { alerts: { fixture: { stages: { 15: { telegram: true } } } } }]) {
    context.readFileSync = () => JSON.stringify(corrupt);
    assert.throws(() => context.readState(), /refusing to reset/);
  }
  context.writeState({ alerts: {} });
  assert.equal(calls[0][1].flush, true);
  assert.deepEqual(calls.slice(1).map(c => c[0]), ['rename', 'fsync', 'close']);
  context.writeFileSync = () => { throw new Error('disk full'); };
  assert.throws(() => context.writeState({}), /disk full/);
});
