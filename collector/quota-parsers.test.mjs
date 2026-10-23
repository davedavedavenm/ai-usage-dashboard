import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zaiLimitWindow,
  zaiRemainingPercent,
  parseZaiSubscription,
  isConstantAntigravityReport,
  parseAnthropicOAuthUsage,
  extractAntigravityModelEntries,
  retainSkippedProviders,
} from './quota-parsers.mjs';

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

test('parseAnthropicOAuthUsage parses live /api/oauth/usage payload and weekly breakdown note', () => {
  const payload = {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 100, resets_at: '2026-10-19T02:59:59.512302+00:00' },
    seven_day_breakdown: {
      rows: [
        { key: 'claude_code', display_name: 'Claude Code', percent: 97 },
        { key: 'chat', display_name: 'Chats', percent: 0 },
        { key: 'cowork', display_name: 'Cowork', percent: 3 },
      ],
    },
  };
  const parsed = parseAnthropicOAuthUsage(payload);
  assert.deepEqual(parsed, {
    status: 'ok',
    label: 'anthropic',
    entries: [
      { name: '5h', renderType: 'percent', percentRemaining: 100, resetAt: undefined, window: '5h' },
      { name: 'Weekly', renderType: 'percent', percentRemaining: 0, resetAt: '2026-10-19T02:59:59.512Z', window: 'weekly' },
    ],
    note: 'weekly split: Claude Code 97% · Cowork 3%',
  });
  assert.equal(parseAnthropicOAuthUsage({}), null);
  assert.equal(parseAnthropicOAuthUsage(null), null);
});

test('extractAntigravityModelEntries maps G4Argon, Claude 5.5, Gemini 3.1-flash-image, and Gemini 3.6/3.8 Flash', () => {
  const models = {
    'gemini-4-argon': { quotaInfo: { remainingFraction: 0.85, resetTime: '2026-10-17T11:13:07Z' } },
    'gemini-3.1-pro-high': { quotaInfo: { remainingFraction: 1, resetTime: '2026-10-17T11:13:07Z' } },
    'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 1, resetTime: '2026-10-17T11:13:07Z' } },
    'claude-opus-5-5-high': { quotaInfo: { remainingFraction: 0.4999584, resetTime: '2026-10-22T07:21:22Z' } },
    'gemini-3.1-flash-image': { quotaInfo: { remainingFraction: 1, resetTime: '2026-10-17T11:13:07Z' } },
    'gpt-oss-120b-medium': { quotaInfo: { remainingFraction: 0.4999584, resetTime: '2026-10-22T07:21:22Z' } },
  };
  const entries = extractAntigravityModelEntries(models);
  assert.deepEqual(entries, [
    { name: 'G4Argon', renderType: 'percent', percentRemaining: 85, resetAt: '2026-10-17T11:13:07Z', window: 'agy-g4argon' },
    { name: 'G3Pro', renderType: 'percent', percentRemaining: 100, resetAt: '2026-10-17T11:13:07Z', window: 'agy-g3pro' },
    { name: 'G3Flash', renderType: 'percent', percentRemaining: 100, resetAt: '2026-10-17T11:13:07Z', window: 'agy-g3flash' },
    { name: 'Claude', renderType: 'percent', percentRemaining: 50, resetAt: '2026-10-22T07:21:22Z', window: 'agy-claude' },
    { name: 'G3Image', renderType: 'percent', percentRemaining: 100, resetAt: '2026-10-17T11:13:07Z', window: 'agy-g3image' },
    { name: 'GPT-OSS', renderType: 'percent', percentRemaining: 50, resetAt: '2026-10-22T07:21:22Z', window: 'agy-gptoss' },
  ]);
});

test('retainSkippedProviders preserves recent provider state when a collect skips a provider', () => {
  const now = 1_792_215_643_000;
  const prevRecord = {
    receivedAt: now - 10 * 60 * 1000,
    envelope: {
      providers: {
        anthropic: { status: 'ok', label: 'anthropic', entries: [{ name: 'Weekly', renderType: 'percent', percentRemaining: 0, window: 'weekly' }] },
        openai: { status: 'ok', label: 'openai', entries: [{ name: 'Weekly', renderType: 'percent', percentRemaining: 76, window: 'weekly' }] },
      },
    },
  };
  const merged = retainSkippedProviders(
    { openai: { status: 'ok', label: 'openai', entries: [{ name: 'Weekly', renderType: 'percent', percentRemaining: 75, window: 'weekly' }] } },
    prevRecord,
    now
  );
  assert.equal(merged.openai.entries[0].percentRemaining, 75);
  assert.equal(merged.anthropic.entries[0].percentRemaining, 0);

  // Stale prevRecord (> 24h old) is not carried forward
  const staleMerged = retainSkippedProviders(
    { openai: { status: 'ok', label: 'openai', entries: [] } },
    { ...prevRecord, receivedAt: now - 25 * 3600 * 1000 },
    now
  );
  assert.equal(staleMerged.anthropic, undefined);
});

test('zai subscription parser reads the live annual renewal shape', () => {
  const body = {
    code: 200,
    success: true,
    data: [{
      productName: 'GLM Coding Lite',
      status: 'VALID',
      billingCycle: 'annually',
      autoRenew: 1,
      nextRenewTime: '2027-09-22',
      currentRenewTime: '2026-09-22',
    }],
  };
  assert.deepEqual(parseZaiSubscription(body), {
    productName: 'GLM Coding Lite',
    nextRenewDate: '2027-09-22',
    billingCycle: 'annually',
    autoRenew: true,
  });
});

test('zai subscription parser picks the active row and drops any time from the date', () => {
  const body = {
    data: [
      { productName: 'GLM Coding Lite', status: 'EXPIRED', nextRenewTime: '2025-09-22' },
      { productName: 'GLM Coding Lite', status: 'valid', billingCycle: 'annually', autoRenew: 0, nextRenewTime: '2027-09-22 04:51:32' },
    ],
  };
  assert.deepEqual(parseZaiSubscription(body), {
    productName: 'GLM Coding Lite',
    nextRenewDate: '2027-09-22',
    billingCycle: 'annually',
    autoRenew: false,
  });
});

test('zai subscription parser returns null when no usable active renewal exists', () => {
  assert.equal(parseZaiSubscription(null), null);
  assert.equal(parseZaiSubscription({}), null);
  assert.equal(parseZaiSubscription({ data: [] }), null);
  assert.equal(parseZaiSubscription({ data: [{ status: 'VALID' }] }), null);
  assert.equal(parseZaiSubscription({ data: [{ status: 'VALID', nextRenewTime: 'not-a-date' }] }), null);
  assert.equal(parseZaiSubscription({ data: [{ status: 'EXPIRED', nextRenewTime: '2027-09-22' }] }), null);
});
