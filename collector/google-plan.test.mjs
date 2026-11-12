import test from 'node:test';
import assert from 'node:assert/strict';
import { QUOTA_SUMMARY_URLS, FETCH_MODELS_URLS } from './google-plan.mjs';

test('Antigravity quota summary asks the daily host first, production only as fallback', () => {
  // 2026-11-08: the same token/project/UA returned G4Argon 0.84% with a 22 h
  // reset from production and 85% with the 15 Nov weekly reset from daily;
  // daily matched the desktop "View Usage" panel, production did not. Do not
  // reorder without re-checking against a fresh panel reading.
  assert.equal(
    QUOTA_SUMMARY_URLS[0],
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  );
  assert.equal(
    QUOTA_SUMMARY_URLS[1],
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  );
});

test('Antigravity model catalogue also asks the daily host first', () => {
  // 2026-11-12: Gemini 4 Hydrogen is only listed by the daily host; production
  // still returns the older catalogue without it.
  assert.equal(
    FETCH_MODELS_URLS[0],
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  );
  assert.equal(
    FETCH_MODELS_URLS[1],
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  );
});
