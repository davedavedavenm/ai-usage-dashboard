import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the real refresher at throwaway files and a stub token endpoint.
const dir = mkdtempSync(join(tmpdir(), 'aiud-claude-token-'));
const credPath = join(dir, 'credentials.json');
const sidecarPath = join(dir, 'oauth-refresh.json');
process.env.CLAUDE_CREDENTIALS_PATH = credPath;
process.env.CLAUDE_OAUTH_SIDECAR_PATH = sidecarPath;
process.env.CLAUDE_TOKEN_URL = 'https://fixture.invalid/v1/oauth/token';

const { refreshClaudeTokenIfNeeded } = await import('./claude-token.mjs');

const NOW = Date.now();

function seed({ accessToken = 'access-old', refreshToken = 'refresh-1', expiresIn = -60_000, subscriptionType = 'pro' } = {}) {
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: NOW + expiresIn, scopes: ['user:inference'], subscriptionType },
  }));
  rmSync(sidecarPath, { force: true });
}

const creds = () => JSON.parse(readFileSync(credPath, 'utf8')).claudeAiOauth;
const sidecar = () => { try { return JSON.parse(readFileSync(sidecarPath, 'utf8')); } catch { return {}; } };
const ok = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
const fail = (status, body) => ({ status, text: async () => JSON.stringify(body) });

test('a token with more than 30 minutes left is left alone', async () => {
  seed({ expiresIn: 2 * 60 * 60 * 1000 });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok({}); };
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.reason, 'fresh');
  assert.equal(calls, 0);
});

test('an expiring access token is rotated and the rest of the file survives', async () => {
  seed();
  globalThis.fetch = async () => ok({ access_token: 'access-new', refresh_token: 'refresh-2', expires_in: 28_800 });
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'refreshed');
  const after = creds();
  assert.equal(after.accessToken, 'access-new');
  assert.equal(after.refreshToken, 'refresh-2');
  assert.equal(after.subscriptionType, 'pro');
  assert.ok(after.expiresAt > NOW + 7 * 60 * 60 * 1000);
  assert.ok(sidecar().lastSuccessAt > 0);
});

test('a token rotated by another Claude process mid-flight is retried, not declared dead', async () => {
  seed();
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body.refresh_token);
    if (body.refresh_token === 'refresh-1') {
      // The host CLI / bridge refreshed first: disk now holds a newer token.
      writeFileSync(credPath, JSON.stringify({
        claudeAiOauth: { accessToken: 'access-theirs', refreshToken: 'refresh-2', expiresAt: NOW, scopes: ['user:inference'] },
      }));
      return fail(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' });
    }
    return ok({ access_token: 'access-new', refresh_token: 'refresh-3', expires_in: 28_800 });
  };
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(bodies.at(-1), 'refresh-2');
  assert.equal(result.ok, true);
  assert.equal(creds().refreshToken, 'refresh-3');
});

test('a rejected refresh keeps the endpoint error so a dead login is diagnosable', async () => {
  seed();
  globalThis.fetch = async () => fail(400, { error: 'invalid_grant', error_description: 'Refresh token expired' });
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh-failed');
  assert.match(result.detail, /400 invalid_grant — Refresh token expired/);
  assert.match(sidecar().lastFailure, /invalid_grant/);
  assert.equal(creds().refreshToken, 'refresh-1');
});

test('a cleared login reports the missing refresh token without calling the endpoint', async () => {
  seed({ accessToken: '', refreshToken: '', expiresIn: 0 });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok({}); };
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.reason, 'no-refresh-token');
  assert.equal(calls, 0);
});

test('HTTP 429 starts a cooldown instead of retrying every run', async () => {
  seed();
  globalThis.fetch = async () => fail(429, {});
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.reason, 'rate-limited');
  assert.ok(sidecar().rateLimitedUntil > NOW + 30 * 60 * 1000);
});

test('a network failure is reported, not thrown', async () => {
  seed();
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.ok, false);
  assert.match(result.detail, /socket hang up/);
});

test('a token rotated by another process before our write is not clobbered', async () => {
  seed();
  globalThis.fetch = async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'access-theirs', refreshToken: 'refresh-2', expiresAt: NOW + 3_600_000 },
    }));
    return ok({ access_token: 'access-ours', refresh_token: 'refresh-ours', expires_in: 28_800 });
  };
  const result = await refreshClaudeTokenIfNeeded();
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'rotated-elsewhere');
  assert.equal(creds().refreshToken, 'refresh-2');
  assert.equal(creds().accessToken, 'access-theirs');
});
