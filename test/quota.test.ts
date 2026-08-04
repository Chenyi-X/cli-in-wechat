import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuotaManager } from '../src/ilink/quota.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'quota-v2-state-')), 'quota.json');
}

test('opens a ten-item window only for a fresh inbound and counts confirmed sends', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  const first = quota.recordInbound('user-a', 'message-1', 'token-1');
  assert.equal(first.duplicate, false);
  assert.equal(first.generation, 1);
  assert.equal(first.tokenVersion, 1);
  assert.equal(quota.remaining('user-a'), 10);

  quota.confirmSend('user-a', 'item-1');
  quota.confirmSend('user-a', 'item-2');
  assert.equal(quota.remaining('user-a'), 8);

  const duplicate = quota.recordInbound('user-a', 'message-1', 'token-1');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.generation, 1);
  assert.equal(quota.remaining('user-a'), 8);
});

test('a real inbound opens the next window while a poll replay does not', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  for (let index = 0; index < 10; index += 1) quota.confirmSend('user-a', `item-${index}`);
  assert.equal(quota.remaining('user-a'), 0);

  const replay = quota.recordInbound('user-a', 1, 'token-1');
  assert.equal(replay.duplicate, true);
  assert.equal(quota.remaining('user-a'), 0);

  const next = quota.recordInbound('user-a', 2, 'token-1');
  assert.equal(next.duplicate, false);
  assert.equal(next.generation, 2);
  assert.equal(quota.remaining('user-a'), 10);
});

test('confirmed item IDs are idempotent and do not overrun the window', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  assert.equal(quota.confirmSend('user-a', 'item-1'), true);
  assert.equal(quota.confirmSend('user-a', 'item-1'), false);
  assert.equal(quota.remaining('user-a'), 9);
});

test('restart preserves the current budget and token version', () => {
  const filePath = tempPath();
  const first = new QuotaManager(filePath, 'account-a');
  first.recordInbound('user-a', 1, 'token-1');
  first.confirmSend('user-a', 'item-1');

  const restarted = new QuotaManager(filePath, 'account-a');
  assert.equal(restarted.remaining('user-a'), 9);
  assert.equal(restarted.snapshot('user-a').tokenVersion, 1);
});

test('token changes are recorded but do not reset quota without a fresh inbound', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  quota.confirmSend('user-a', 'item-1');
  const duplicateWithNewToken = quota.recordInbound('user-a', 1, 'token-2');
  assert.equal(duplicateWithNewToken.duplicate, true);
  assert.equal(duplicateWithNewToken.tokenVersion, 1);
  assert.equal(quota.remaining('user-a'), 9);

  const next = quota.recordInbound('user-a', 2, 'token-2');
  assert.equal(next.tokenVersion, 2);
  assert.equal(quota.remaining('user-a'), 10);
});

test('two users have independent windows and rate backoff state', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-a');
  quota.recordInbound('user-b', 1, 'token-b');
  quota.confirmSend('user-a', 'item-a');
  quota.markRateBackoff('user-a', 60_000);

  assert.equal(quota.remaining('user-a'), 9);
  assert.equal(quota.remaining('user-b'), 10);
  assert.equal(quota.snapshot('user-a').rateBackoffUntil > Date.now(), true);
  assert.equal(quota.snapshot('user-b').rateBackoffUntil, 0);
});
