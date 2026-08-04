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

test('does not silently evict final items when capacity is exhausted', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1, maxBytesPerUser: 100 });
  store.enqueue(input({ itemId: 'final-1' }));

  assert.throws(
    () => store.enqueue(input({ itemId: 'final-2', text: 'another final' })),
    OutboxCapacityError,
  );
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), ['final-1']);
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
