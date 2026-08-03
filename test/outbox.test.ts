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

test('OutboxStore preserves enqueue order for same-priority chunks', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath, { now: () => 100 });
    store.enqueueText({ ...base, itemId: 'z-first', createdAt: 100, priority: 'final', text: 'first chunk' });
    store.enqueueText({ ...base, itemId: 'a-second', createdAt: 100, priority: 'final', text: 'second chunk' });

    assert.deepEqual(store.list('user-a').map((item) => item.text), ['first chunk', 'second chunk']);
  });
});

test('OutboxStore batch enqueue is atomic when a later item exceeds capacity', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath, { maxItemsPerUser: 1 });
    const first = store.enqueueText({ ...base, priority: 'final', text: 'existing' });

    assert.throws(
      () => store.enqueueTextBatch([
        { ...base, priority: 'final', text: 'new first' },
        { ...base, priority: 'final', text: 'new second' },
      ]),
      /capacity/,
    );
    assert.deepEqual(store.list('user-a').map((item) => item.itemId), [first.itemId]);
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
    assert.equal(store.list('user-a').length, 1);
    assert.equal(store.get(expiring.itemId)?.state, 'permanent-failure');
    assert.match(store.get(expiring.itemId)?.terminalError?.errmsg || '', /expired/);
  });
});

test('OutboxStore enforces caps while preserving higher-priority control work', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath, {
      maxItemsPerUser: 2,
      maxBytesPerUser: 20,
      finalReserveItems: 0,
      finalReserveBytes: 0,
    });
    const activity = store.enqueueText({ ...base, priority: 'activity', text: 'old activity' });
    const intermediate = store.enqueueText({ ...base, priority: 'intermediate', text: 'old text' });

    const control = store.enqueueText({ ...base, priority: 'control', text: 'third' });
    assert.equal(store.get(control.itemId)?.priority, 'control');
    assert.equal(store.get(activity.itemId), undefined);
    assert.equal(store.get(intermediate.itemId)?.priority, 'intermediate');
    assert.equal(store.supersedeIntermediate('account-a', 'user-a', 1), 1);
    assert.deepEqual(store.list('user-a').map((item) => item.itemId), [control.itemId]);
  });
});

test('OutboxStore evicts lower-priority activity to preserve a final result', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath, {
      maxItemsPerUser: 3,
      maxBytesPerUser: 20,
      finalReserveItems: 0,
      finalReserveBytes: 0,
    });
    const activity = store.enqueueText({ ...base, priority: 'activity', text: 'activity!' });
    store.enqueueText({ ...base, priority: 'intermediate', text: 'working' });

    const final = store.enqueueText({ ...base, priority: 'final', text: 'final' });

    assert.equal(store.get(final.itemId)?.text, 'final');
    assert.equal(store.get(activity.itemId), undefined);
    assert.deepEqual(store.list('user-a').map((item) => item.priority), ['final', 'intermediate']);
  });
});

test('OutboxStore removes a recovery notice when its intermediate item is superseded', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath);
    const intermediate = store.enqueueText({ ...base, priority: 'intermediate', text: 'working' });
    const notice = store.enqueueText({
      ...base,
      itemId: `delivery-notice:${intermediate.itemId}`,
      priority: 'control',
      text: 'will retry after inbound',
    });

    assert.equal(store.supersedeIntermediate('account-a', 'user-a', 1), 1);
    assert.equal(store.get(intermediate.itemId), undefined);
    assert.equal(store.get(notice.itemId), undefined);
  });
});

test('OutboxStore reserves capacity for a future final result', () => {
  withOutbox((filePath) => {
    const store = new OutboxStore(filePath, {
      maxItemsPerUser: 2,
      finalReserveItems: 1,
    });
    store.enqueueText({ ...base, priority: 'intermediate', text: 'first' });

    assert.throws(
      () => store.enqueueText({ ...base, priority: 'intermediate', text: 'second' }),
      /capacity/,
    );
  });
});

test('OutboxStore recovers from a truncated persisted document', () => {
  withOutbox((filePath) => {
    const original = new OutboxStore(filePath);
    const item = original.enqueueText({ ...base, priority: 'final', text: 'survive corruption' });
    writeFileSync(filePath, '{"schemaVersion":1,"items":[');
    const store = new OutboxStore(filePath);

    assert.equal(store.get(item.itemId)?.text, 'survive corruption');
  });
});

test('OutboxStore recovers from a missing primary using the backup snapshot', () => {
  withOutbox((filePath) => {
    const original = new OutboxStore(filePath);
    const item = original.enqueueText({ ...base, priority: 'final', text: 'survive missing primary' });
    rmSync(filePath);

    const store = new OutboxStore(filePath);

    assert.equal(store.get(item.itemId)?.text, 'survive missing primary');
  });
});

test('OutboxStore surfaces unrecoverable corruption instead of pretending the queue is empty', () => {
  withOutbox((filePath) => {
    writeFileSync(filePath, '{"schemaVersion":1,"items":[');

    assert.throws(() => new OutboxStore(filePath), { name: 'OutboxCorruptionError' });
  });
});
