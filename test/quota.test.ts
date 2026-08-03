import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { QuotaManager } from '../src/ilink/quota.js';

function withQuota(fn: (filePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'wxquota-'));
  try {
    fn(join(dir, 'quota.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const limits = {
  maxItems: 3,
  maxBytes: 32,
  finalReserveItems: 1,
  finalReserveBytes: 16,
};

test('QuotaManager increments inbound generation once and versions only changed tokens', () => {
  withQuota((filePath) => {
    const quota = new QuotaManager(filePath, 'account-a', limits);

    assert.deepEqual(quota.recordInbound('user-a', 'message-1', 'token-a'), {
      duplicate: false,
      inboundGeneration: 1,
      tokenVersion: 1,
    });
    assert.deepEqual(quota.recordInbound('user-a', 'message-1', 'token-b'), {
      duplicate: true,
      inboundGeneration: 1,
      tokenVersion: 1,
    });
    assert.deepEqual(quota.recordInbound('user-a', 'message-2', 'token-a'), {
      duplicate: false,
      inboundGeneration: 2,
      tokenVersion: 1,
    });
    assert.deepEqual(quota.recordInbound('user-a', 'message-3', 'token-b'), {
      duplicate: false,
      inboundGeneration: 3,
      tokenVersion: 2,
    });
  });
});

test('QuotaManager persists generations and counts only successful reservations', () => {
  withQuota((filePath) => {
    const quota = new QuotaManager(filePath, 'account-a', limits);
    quota.recordInbound('user-a', 'message-1', 'token-a');

    const intermediate = quota.reserve('user-a', 8, 'intermediate');
    assert.equal(intermediate.allowed, true);

    const secondIntermediate = quota.reserve('user-a', 8, 'activity');
    assert.equal(secondIntermediate.allowed, true);

    const blockedActivity = quota.reserve('user-a', 1, 'activity');
    assert.equal(blockedActivity.allowed, false);
    assert.equal(blockedActivity.reason, 'final-reserved');

    const final = quota.reserve('user-a', 16, 'final');
    assert.equal(final.allowed, true);
    assert.equal(quota.commit(final.reservation.reservationId), true);
    assert.equal(quota.release(intermediate.reservation.reservationId), true);
    assert.equal(quota.release(secondIntermediate.reservation.reservationId), true);

    const reloaded = new QuotaManager(filePath, 'account-a', limits);
    const snapshot = reloaded.snapshot('user-a');
    assert.equal(snapshot.inboundGeneration, 1);
    assert.equal(snapshot.tokenVersion, 1);
    assert.equal(snapshot.sentItems, 1);
    assert.equal(snapshot.sentBytes, 16);
    assert.equal(snapshot.reservedItems, 0);
  });
});

test('QuotaManager clears in-flight reservations after a crash/restart', () => {
  withQuota((filePath) => {
    const quota = new QuotaManager(filePath, 'account-a', limits);
    quota.recordInbound('user-a', 'message-1', 'token-a');
    const pending = quota.reserve('user-a', 8, 'intermediate');
    assert.equal(pending.allowed, true);

    const restarted = new QuotaManager(filePath, 'account-a', limits);

    assert.equal(restarted.snapshot('user-a').reservedItems, 0);
    const retry = restarted.reserve('user-a', 8, 'intermediate');
    assert.equal(retry.allowed, true);
  });
});

test('QuotaManager does not reset an unknown legacy token budget after restart', () => {
  withQuota((filePath) => {
    const userKey = 'account-a\u0000user-a';
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      users: {
        [userKey]: {
          accountId: 'account-a',
          userId: 'user-a',
          inboundGeneration: 1,
          tokenVersion: 1,
          seenInboundIds: ['message-1'],
          sentItems: 7,
          sentBytes: 128,
          reservedItems: 0,
          reservedBytes: 0,
          reservations: {},
          rateBackoffUntil: 0,
          rateBackoffGeneration: 1,
        },
      },
    }));

    const quota = new QuotaManager(filePath, 'account-a');
    const sameToken = quota.reserve('user-a', 1, 'final');
    assert.equal(sameToken.allowed, false);
    assert.equal(sameToken.reason, 'token-budget-exhausted');

    quota.recordInbound('user-a', 'message-2', 'new-token');
    const newToken = quota.reserve('user-a', 1, 'final');
    assert.equal(newToken.allowed, true);
  });
});

test('QuotaManager keeps rate backoff for the same token and clears it for a new token', () => {
  withQuota((filePath) => {
    const quota = new QuotaManager(filePath, 'account-a');
    quota.recordInbound('user-a', 'message-1', 'token-a');
    const until = Date.now() + 60_000;

    quota.noteRateBackoff('user-a', until);
    const restarted = new QuotaManager(filePath, 'account-a');
    assert.equal(restarted.getRateBackoff('user-a').until, until);

    restarted.recordInbound('user-a', 'message-2', 'token-a');
    assert.equal(restarted.getRateBackoff('user-a').until, until);

    restarted.recordInbound('user-a', 'message-3', 'token-b');
    assert.equal(restarted.getRateBackoff('user-a').until, 0);
  });
});

test('QuotaManager preserves another account when sharing a state file', () => {
  withQuota((filePath) => {
    const first = new QuotaManager(filePath, 'account-a', limits);
    first.recordInbound('user-a', 'message-a', 'token-a');
    const reservation = first.reserve('user-a', 8, 'final');
    assert.equal(reservation.allowed, true);
    first.commit(reservation.reservation.reservationId);

    const second = new QuotaManager(filePath, 'account-b', limits);
    second.recordInbound('user-b', 'message-b', 'token-b');

    const reloadedFirst = new QuotaManager(filePath, 'account-a', limits);
    assert.equal(reloadedFirst.snapshot('user-a').sentItems, 1);
  });
});
