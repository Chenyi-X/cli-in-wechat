import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { OutboxStore } from '../src/ilink/outbox.js';

function withOutbox(fn: (filePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'wxoutbox-'));
  try {
    fn(join(dir, 'outbox.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = {
  accountId: 'account-a',
  userId: 'user-a',
  generation: 1,
  tokenVersion: 1,
};

test('OutboxStore persists stable item/client IDs and orders by priority', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath);
    const activity = store.enqueueText({ ...base, priority: 'activity', text: 'activity' });
    const final = store.enqueueText({ ...base, priority: 'final', text: 'final' });
    const control = store.enqueueText({ ...base, priority: 'control', text: 'control' });
    const intermediate = store.enqueueText({ ...base, priority: 'intermediate', text: 'intermediate' });

    const reloaded = new OutboxStore(filePath);
    assert.deepEqual(reloaded.list('user-a').map((item) => item.itemId), [
      final.itemId,
      control.itemId,
      intermediate.itemId,
      activity.itemId,
    ]);
    assert.equal(reloaded.get(final.itemId)?.clientId, final.clientId);

    const duplicate = reloaded.enqueueText({
      ...base,
      itemId: final.itemId,
      priority: 'final',
      text: 'different body must not replace the durable item',
    });
    assert.equal(duplicate.clientId, final.clientId);
    assert.equal(reloaded.get(final.itemId)?.text, 'final');
  });
});

test('OutboxStore acknowledges by stable ID and expires old items', () => {
  withOutbox((filePath) => {
    let now = 1_000;
    const store = new OutboxStore(filePath, { now: () => now, defaultTtlMs: 10 });
    const item = store.enqueueText({ ...base, priority: 'final', text: 'result' });

    assert.equal(store.ack(item.itemId), true);
    assert.equal(store.ack(item.itemId), false);

    const expiring = store.enqueueText({ ...base, priority: 'control', text: 'notice' });
    now += 11;
    assert.deepEqual(store.list('user-a'), []);
    assert.equal(store.get(expiring.itemId), undefined);
  });
});

test('OutboxStore enforces per-user item/byte caps and supersedes stale activity', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath, { maxItemsPerUser: 2, maxBytesPerUser: 20 });
    store.enqueueText({ ...base, priority: 'activity', text: 'old activity' });
    store.enqueueText({ ...base, priority: 'intermediate', text: 'old text' });

    assert.throws(
      () => store.enqueueText({ ...base, priority: 'control', text: 'third' }),
      /capacity/,
    );
    assert.equal(store.supersedeIntermediate('account-a', 'user-a', 1), 2);
    assert.deepEqual(store.list('user-a'), []);
  });
});

test('OutboxStore recovers from a truncated persisted document', () => {
  withOutbox((filePath) => {
    writeFileSync(filePath, '{"schemaVersion":1,"items":[');
    const store = new OutboxStore(filePath);

    assert.deepEqual(store.list('user-a'), []);
    const item = store.enqueueText({ ...base, priority: 'final', text: 'rewritten' });
    const reloaded = new OutboxStore(filePath);
    assert.equal(reloaded.get(item.itemId)?.text, 'rewritten');
  });
});
