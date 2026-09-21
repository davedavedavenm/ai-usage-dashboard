import test from 'node:test';
import assert from 'node:assert/strict';
import { zaiLimitWindow, zaiRemainingPercent, isConstantAntigravityReport } from './quota-parsers.mjs';

const pct = (percentRemaining, resetAt, name = 'Window') => ({ name, window: 'agy-test', renderType: 'percent', percentRemaining, resetAt });

test('zai maps limit rows by unit, not by the type name it last saw', () => {
  // Live 2026-09-21 shape: the credit plans publish CREDIT_LIMIT rows.
  assert.equal(zaiLimitWindow({ type: 'CREDIT_LIMIT', unit: 3 }), 'fiveHour');
  assert.equal(zaiLimitWindow({ type: 'CREDIT_LIMIT', unit: 6 }), 'weekly');
  // The token plans this parser was written for must keep working.
  assert.equal(zaiLimitWindow({ type: 'TOKENS_LIMIT', unit: 3 }), 'fiveHour');
  assert.equal(zaiLimitWindow({ type: 'TOKENS_LIMIT', unit: 6 }), 'weekly');
  assert.equal(zaiLimitWindow({ type: 'TIME_LIMIT' }), 'mcp');
  assert.equal(zaiLimitWindow({ type: 'CREDIT_LIMIT', unit: 99 }), null);
  assert.equal(zaiLimitWindow({ type: 'SOMETHING_ELSE', unit: 3 }), null);
  assert.equal(zaiLimitWindow(undefined), null);
});

test('zai prefers exact remaining/usage over the floored percentage', () => {
  // Live "lite" weekly row: 1960 of 2000 credits left reads 98% remaining, while
  // the API's own `percentage` (share used, floored) only reports "1".
  const row = { type: 'CREDIT_LIMIT', unit: 6, usage: 2000, currentValue: 39, remaining: 1960, percentage: 1 };
  assert.equal(zaiRemainingPercent(row), 98);
  assert.equal(zaiRemainingPercent({ type: 'CREDIT_LIMIT', unit: 6, percentage: 1 }), 99);
  assert.equal(zaiRemainingPercent({ type: 'CREDIT_LIMIT', unit: 6, usage: 100, currentValue: 40, percentage: 30 }), 60);
  assert.equal(zaiRemainingPercent({ type: 'TIME_LIMIT', percentage: 25 }), 75);
  assert.equal(zaiRemainingPercent({ type: 'TIME_LIMIT', percentage: 0 }), 100);
  assert.equal(zaiRemainingPercent({ type: 'CREDIT_LIMIT', unit: 3, usage: 100, currentValue: 240 }), 0);
  assert.equal(zaiRemainingPercent({ type: 'CREDIT_LIMIT', unit: 3 }), null);
});

test('antigravity placeholder detection matches only the constant full report', () => {
  const reset = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  const placeholder = [pct(100, reset, 'G3Pro'), pct(100, reset, 'G3Flash'), pct(100, reset, 'Claude')];
  assert.equal(isConstantAntigravityReport(placeholder), true);

  // Any real signal has to survive: a moved window, its own reset times, a
  // server-stamped rate-limit reset, or a single window.
  assert.equal(isConstantAntigravityReport([pct(92, reset, 'G3Pro'), pct(100, reset, 'G3Flash')]), false);
  assert.equal(isConstantAntigravityReport([pct(100, reset), pct(100, new Date(Date.now() + 4 * 3600e3).toISOString())]), false);
  assert.equal(isConstantAntigravityReport([pct(0, reset, 'Claude'), pct(0, reset, 'GPT-OSS')]), false);
  assert.equal(isConstantAntigravityReport([pct(100, reset)]), false);
  assert.equal(isConstantAntigravityReport([pct(100, new Date(Date.now() + 7 * 24 * 3600e3).toISOString())]), false);
  assert.equal(isConstantAntigravityReport([]), false);
  assert.equal(isConstantAntigravityReport(undefined), false);
});
