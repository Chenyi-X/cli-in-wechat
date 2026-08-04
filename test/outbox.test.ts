import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OutboxCapacityError,
  OutboxStore,
  type OutboxItem,
} from '../src/ilink/outbox.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'quota-v2-outbox-')), 'outbox.json');
}

function input(overrides: Partial<OutboxItem> = {}) {
  return {
    accountId: 'account-a',
    userId: 'user-a',
    generation: 1,
    tokenVersion: 1,
    priority: 'final' as const,
    text: 'frozen body',
    ...overrides,
  };
}

test('freezes text and client id before send and reloads them after restart', () => {
  const filePath = tempPath();
  const first = new OutboxStore(filePath);
  const created = first.enqueue(input({ itemId: 'final-1' }));
  assert.equal(created.text, 'frozen body');
  assert.ok(created.clientId);

  const restarted = new OutboxStore(filePath);
  const loaded = restarted.listPending('user-a')[0];
  assert.equal(loaded.itemId, 'final-1');
  assert.equal(loaded.text, 'frozen body');
  assert.equal(loaded.clientId, created.clientId);
  assert.equal(restarted.ack('final-1'), true);
  assert.deepEqual(restarted.listPending('user-a'), []);
});

test('persists a confirmed delivery receipt until quota reconciliation', () => {
  const filePath = tempPath();
  const first = new OutboxStore(filePath);
  const item = first.enqueue(input({ itemId: 'confirmed-1' }));

  assert.equal(first.recordDeliveryReceipt(item.itemId, 'reservation-1', 3), true);

  const restarted = new OutboxStore(filePath);
  assert.deepEqual(restarted.get(item.itemId)?.deliveryReceipt, {
    reservationId: 'reservation-1',
    quotaGeneration: 3,
  });
});

test('ambiguous records remain pending with their original payload', () => {
  const store = new OutboxStore(tempPath());
  const created = store.enqueue(input({ itemId: 'ambiguous-1' }));

  assert.equal(store.markAmbiguous('ambiguous-1', { errmsg: 'timeout' }), true);
  const pending = store.listPending('user-a')[0];
  assert.equal(pending.clientId, created.clientId);
  assert.equal(pending.text, created.text);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.recoveryRequired, true);
  assert.deepEqual(pending.terminalError, { errmsg: 'timeout' });
});

test('final enqueue supersedes same-generation activity and intermediate records', () => {
  const store = new OutboxStore(tempPath());
  store.enqueue(input({ itemId: 'activity-1', priority: 'activity', text: 'activity' }));
  store.enqueue(input({ itemId: 'intermediate-1', priority: 'intermediate', text: 'intermediate' }));
  store.enqueue(input({ itemId: 'final-1', priority: 'final', text: 'final' }));

  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), ['final-1']);
});

test('final enqueue preserves confirmed activity until its receipt is reconciled', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 2 });
  const activity = store.enqueue(input({ itemId: 'confirmed-activity', priority: 'activity' }));
  store.recordDeliveryReceipt(activity.itemId, 'reservation-1', 1);

  store.enqueue(input({ itemId: 'final-1', text: 'final body' }));

  assert.equal(store.get(activity.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
  assert.equal(store.get('final-1')?.state, 'pending');
});

test('does not silently evict final items when capacity is exhausted', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1, maxBytesPerUser: 100 });
  store.enqueue(input({ itemId: 'final-1' }));

  assert.throws(
    () => store.enqueue(input({ itemId: 'final-2', text: 'another final' })),
    OutboxCapacityError,
  );
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), ['final-1']);
});

test('capacity pressure never deletes a permanent-failure final record', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1, maxBytesPerUser: 100 });
  const failed = store.enqueue(input({ itemId: 'failed-final' }));
  store.markPermanentFailure(failed.itemId, { errmsg: 'manual recovery required' });

  assert.throws(
    () => store.enqueue(input({ itemId: 'final-2', text: 'another final' })),
    OutboxCapacityError,
  );
  assert.equal(store.get(failed.itemId)?.state, 'permanent-failure');
  assert.equal(store.get(failed.itemId)?.clientId, failed.clientId);
});

test('capacity pressure never evicts an unreconciled delivery receipt', () => {
  const store = new OutboxStore(tempPath(), {
    maxItemsPerUser: 1,
    maxBytesPerUser: 100,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  const confirmed = store.enqueue(input({
    itemId: 'confirmed-activity',
    generation: 1,
    priority: 'activity',
  }));
  store.recordDeliveryReceipt(confirmed.itemId, 'reservation-1', 1);

  assert.throws(
    () => store.enqueue(input({ itemId: 'new-final', generation: 2, text: 'new final' })),
    OutboxCapacityError,
  );
  assert.equal(store.get(confirmed.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
});

test('migrates the legacy schema-one item shape without dropping final records', () => {
  const filePath = tempPath();
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    nextSequence: 14,
    items: Array.from({ length: 13 }, (_, index) => ({
      schemaVersion: 1,
      itemId: `legacy-${index + 1}`,
      clientId: `client-${index + 1}`,
      sequence: index + 1,
      kind: 'text',
      accountId: 'account-a',
      userId: 'user-a',
      generation: 9,
      tokenVersion: 9,
      priority: 'final',
      text: `legacy-${index + 1}`,
      bytes: 8,
      createdAt: index + 1,
      expiresAt: Date.now() + 60_000,
      state: 'pending',
    })),
  }));

  const store = new OutboxStore(filePath);
  assert.equal(store.listPending('user-a').length, 13);
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.items.length, 13);
});

test('recovers the primary file from a valid backup snapshot', () => {
  const filePath = tempPath();
  const store = new OutboxStore(filePath);
  store.enqueue(input({ itemId: 'recover-1' }));
  writeFileSync(filePath, '{ not valid json');

  const recovered = new OutboxStore(filePath);
  assert.equal(recovered.listPending('user-a')[0]?.itemId, 'recover-1');
});

test('prefers a newer valid backup after a crash before the primary write', () => {
  const filePath = tempPath();
  const backupPath = `${filePath}.bak`;
  const baseItem = {
    ...input({ itemId: 'newer-backup' }),
    schemaVersion: 2,
    clientId: 'stable-client',
    sequence: 1,
    kind: 'text',
    bytes: 11,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    state: 'pending',
  };
  writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, revision: 1, nextSequence: 1, items: [] }));
  writeFileSync(backupPath, JSON.stringify({ schemaVersion: 2, revision: 2, nextSequence: 2, items: [baseItem] }));

  const recovered = new OutboxStore(filePath);

  assert.equal(recovered.listPending('user-a')[0]?.itemId, 'newer-backup');
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).items[0]?.itemId, 'newer-backup');
});

test('batch enqueue is atomic when a later final item exceeds capacity', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1 });
  const existing = store.enqueueText(input({ itemId: 'existing' }));

  assert.throws(() => store.enqueueTextBatch([
    input({ itemId: 'new-1', text: 'new first' }),
    input({ itemId: 'new-2', text: 'new second' }),
  ]), OutboxCapacityError);
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), [existing.itemId]);
});

test('reserves capacity for a future final result while activity is queued', () => {
  const store = new OutboxStore(tempPath(), {
    maxItemsPerUser: 2,
    finalReserveItems: 1,
  });
  store.enqueue(input({ itemId: 'activity-1', priority: 'activity', text: 'activity' }));

  assert.throws(
    () => store.enqueue(input({ itemId: 'activity-2', priority: 'activity', text: 'activity 2' })),
    OutboxCapacityError,
  );
  assert.equal(store.enqueue(input({ itemId: 'final-1', text: 'final' })).itemId, 'final-1');
});

test('requeues selected permanent failures without changing identity or payload', () => {
  const store = new OutboxStore(tempPath());
  const item = store.enqueue(input({ itemId: 'failed-1' }));
  store.markPermanentFailure(item.itemId, { errmsg: 'retryable local failure' });

  assert.equal(store.requeuePermanentFailures((candidate) => candidate.itemId === item.itemId), 1);
  const requeued = store.get(item.itemId);
  assert.equal(requeued?.state, 'pending');
  assert.equal(requeued?.clientId, item.clientId);
  assert.equal(requeued?.text, item.text);
});

test('requeueing an expired failure renews its delivery lifetime', () => {
  let now = 1_000;
  const store = new OutboxStore(tempPath(), { defaultTtlMs: 100, now: () => now });
  const item = store.enqueue(input({ itemId: 'expired-1' }));
  now = 1_100;
  assert.equal(store.get(item.itemId)?.state, 'permanent-failure');

  assert.equal(store.requeuePermanentFailures((candidate) => candidate.itemId === item.itemId), 1);

  const requeued = store.get(item.itemId);
  assert.equal(requeued?.state, 'pending');
  assert.equal(requeued?.expiresAt, 1_200);
});

test('an unreconciled delivery receipt does not expire before acknowledgement', () => {
  let now = 1_000;
  const store = new OutboxStore(tempPath(), { defaultTtlMs: 100, now: () => now });
  const item = store.enqueue(input({ itemId: 'confirmed-before-expiry' }));
  store.recordDeliveryReceipt(item.itemId, 'reservation-1', 1);

  now = 1_100;

  assert.equal(store.get(item.itemId)?.state, 'pending');
  assert.equal(store.get(item.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
});
