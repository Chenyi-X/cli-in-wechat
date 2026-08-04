import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OutboxCapacityError,
  OutboxMigrationError,
  OutboxStore,
  type OutboxItem,
} from '../src/ilink/outbox.js';
import { planDeliveryWindow, type DeliveryItem } from '../src/ilink/delivery-planner.js';
import {
  INBOUND_WINDOW_ITEMS,
  MIGRATED_BODY_BYTES,
  legacyFullChunkText,
  schemaOneLegacyFullChunkFixture,
  schemaTwoFailureFixture,
} from './fixtures/legacy-full-chunk.js';

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

function migrationOptions() {
  return {
    bodyChunkBytes: MIGRATED_BODY_BYTES,
    inboundItemLimit: INBOUND_WINDOW_ITEMS,
  };
}

function assertSafePersistedSequences(filePath: string): void {
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  const sequences = persisted.items.map((item: OutboxItem) => item.sequence) as number[];
  assert.ok(sequences.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0));
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index] > sequences[index - 1]);
  }
  assert.ok(Number.isSafeInteger(persisted.nextSequence));
  assert.ok(persisted.nextSequence > Math.max(...sequences));
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

test('normalizes an oversized schema-one final batch before delivery planning', () => {
  const filePath = tempPath();
  const fixture = schemaOneLegacyFullChunkFixture();
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');

  assert.equal(pending.length, 13);
  assert.equal(pending.map((item) => item.text).join(''), legacyFullChunkText);
  assert.deepEqual(pending.map((item) => item.itemId),
    Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`));
  assert.deepEqual(pending.map((item) => item.clientId),
    Array.from({ length: 13 }, (_, index) => `legacy-client-${index + 1}`));
  assert.ok(pending.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.deepEqual(pending.map((item) => item.bytes), [
    ...Array.from({ length: 10 }, () => 1_944),
    1_943,
    1_944,
    817,
  ]);
  assert.deepEqual(
    pending.map((item) => ({ createdAt: item.createdAt, expiresAt: item.expiresAt })),
    fixture.items.map((item) => ({ createdAt: item.createdAt, expiresAt: item.expiresAt })),
  );
  const plan = planDeliveryWindow(pending as DeliveryItem[], {
    sentItems: 0,
    maxItems: INBOUND_WINDOW_ITEMS,
    maxBytes: 2_000,
    continuationNotice: '后续内容已排队，请回复“继续”续发。',
  });
  assert.equal(plan.needsContinuation, true);
  const lastSelected = plan.items.at(-1);
  assert.equal(lastSelected?.continuationNoticeAttached, true);
  assert.ok(lastSelected);
  assert.ok(Buffer.byteLength(lastSelected.text, 'utf8') <= 2_000);
  assert.ok(lastSelected.bytes <= 2_000);

  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  const backup = JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(backup.schemaVersion, 2);
  assert.equal(persisted.revision, backup.revision);
  assert.deepEqual(persisted, backup);

  const primaryBeforeReload = readFileSync(filePath, 'utf8');
  const reloaded = new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), primaryBeforeReload);
  assert.deepEqual(reloaded.listPending('user-a', 'account-a'), pending);
});

test('normalizes an already-wrapped schema-two failure snapshot once', () => {
  const filePath = tempPath();
  writeFileSync(filePath, JSON.stringify(schemaTwoFailureFixture()));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');
  const oldGeneration = pending.filter((item) => item.generation === 42);

  assert.equal(oldGeneration.length, 13);
  assert.equal(oldGeneration.map((item) => item.text).join(''), legacyFullChunkText);
  assert.ok(oldGeneration.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.equal(pending.at(-1)?.itemId, 'new-confirmation');
  assert.equal(pending.at(-1)?.text, '新会话');
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).revision, 3);

  const primaryBeforeReload = readFileSync(filePath, 'utf8');
  const reloaded = new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), primaryBeforeReload);
  assert.deepEqual(reloaded.listPending('user-a', 'account-a'), pending);
});

test('rejects incomplete or invalid migration configuration', () => {
  assert.throws(
    () => new OutboxStore(tempPath(), { bodyChunkBytes: 0, inboundItemLimit: 10 }),
    OutboxMigrationError,
  );
  assert.throws(
    () => new OutboxStore(tempPath(), { bodyChunkBytes: MIGRATED_BODY_BYTES }),
    OutboxMigrationError,
  );
});

test('does not publish an unrepresentable UTF-8 rechunk migration', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.items = fixture.items.slice(0, 11);
  fixture.nextSequence = 12;
  fixture.items[0].text = '汉';
  fixture.items[0].bytes = Buffer.byteLength('汉', 'utf8');
  for (let index = 1; index < fixture.items.length; index += 1) {
    fixture.items[index].text = String.fromCharCode(65 + index);
    fixture.items[index].bytes = 1;
  }
  const before = JSON.stringify(fixture, null, 2);
  writeFileSync(filePath, before);

  assert.throws(
    () => new OutboxStore(filePath, { bodyChunkBytes: 1, inboundItemLimit: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof OutboxMigrationError);
      assert.match(error.message, /UTF-8 rechunk invariant failed|normalization could not preserve text/i);
      return true;
    },
  );
  assert.equal(readFileSync(filePath, 'utf8'), before);
  assert.equal(existsSync(`${filePath}.bak`), false);
});

test('does not migrate schema-two batches outside the strict eligibility boundary', async (t) => {
  for (const { name, pretty, mutate } of [
  {
    name: 'all compliant bodies',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items.slice(0, 13).forEach((item, index) => {
        const text = String.fromCharCode(65 + index).repeat(MIGRATED_BODY_BYTES);
        item.text = text;
        item.bytes = Buffer.byteLength(text, 'utf8');
      });
    },
  },
  {
    name: 'multiple inbound-sized generations',
    pretty: false,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items.slice(6, 13).forEach((item) => { item.generation = 43; });
    },
  },
  {
    name: 'an intermediate-priority member',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].priority = 'intermediate';
    },
  },
  {
    name: 'a permanent-failure member',
    pretty: false,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].state = 'permanent-failure';
    },
  },
  {
    name: 'a member with a delivery receipt',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].deliveryReceipt = { reservationId: 'reservation-1', quotaGeneration: 42 };
    },
  },
  {
    name: 'a recovery-required member',
    pretty: false,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].recoveryRequired = true;
    },
  },
  {
    name: 'a continuation-notice member',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].continuationNoticeAttached = true;
    },
  },
  ]) {
    await t.test(name, () => {
      const filePath = tempPath();
      const fixture = schemaTwoFailureFixture();
      mutate(fixture);
      const before = pretty ? JSON.stringify(fixture, null, 2) : JSON.stringify(fixture);
      writeFileSync(filePath, before);

      const store = new OutboxStore(filePath, migrationOptions());

      for (const item of fixture.items) {
        const loaded = store.get(String(item.itemId));
        assert.ok(loaded);
        assert.equal(loaded.text, item.text);
        assert.equal(loaded.bytes, item.bytes);
        assert.equal(loaded.priority, item.priority);
        assert.equal(loaded.state, item.state);
        assert.equal(loaded.generation, item.generation);
        assert.equal(loaded.tokenVersion, item.tokenVersion);
        assert.deepEqual(loaded.deliveryReceipt, item.deliveryReceipt);
        assert.equal(loaded.recoveryRequired, item.recoveryRequired);
        assert.equal(loaded.continuationNoticeAttached, item.continuationNoticeAttached);
      }

      assert.equal(readFileSync(filePath, 'utf8'), before);
      assert.equal(existsSync(`${filePath}.bak`), false);
    });
  }
});

test('preserves positional item identities while expanding and contracting a migration batch', async (t) => {
  await t.test('expansion retains existing identities and persists the appended identity', () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.items = fixture.items.slice(0, 11);
    fixture.nextSequence = 12;
    const originalIds = fixture.items.map((item) => String(item.itemId));
    assert.equal(
      fixture.items.reduce((total, item) => total + Number(item.bytes), 0),
      22_000,
    );
    writeFileSync(filePath, JSON.stringify(fixture));

    const migrated = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.equal(migrated.length, 12);
    assert.deepEqual(migrated.slice(0, 11).map((item) => item.itemId), originalIds);
    const appendedId = migrated[11].itemId;
    assert.equal(originalIds.includes(appendedId), false);

    const reloaded = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.equal(reloaded[11].itemId, appendedId);
  });

  await t.test('contraction retains only used identities and preserves the following batch', () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.items = [...fixture.items.slice(0, 11), fixture.items[13]];
    fixture.items[0].text = 'A'.repeat(2_000);
    fixture.items[0].bytes = 2_000;
    for (let index = 1; index < 11; index += 1) {
      const text = String(index);
      fixture.items[index].text = text;
      fixture.items[index].bytes = Buffer.byteLength(text, 'utf8');
    }
    const originalText = fixture.items.slice(0, 11).map((item) => String(item.text)).join('');
    writeFileSync(filePath, JSON.stringify(fixture));

    const migrated = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.deepEqual(migrated.map((item) => item.itemId), [
      'legacy-1',
      'legacy-2',
      'new-confirmation',
    ]);
    assert.equal(migrated.slice(0, 2).map((item) => item.text).join(''), originalText);
    assertSafePersistedSequences(filePath);

    const reloaded = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.deepEqual(reloaded.map((item) => item.itemId), [
      'legacy-1',
      'legacy-2',
      'new-confirmation',
    ]);
    assert.equal(reloaded.slice(0, 2).map((item) => item.text).join(''), originalText);
    assert.equal(reloaded.at(-1)?.text, '新会话');
    assert.equal(reloaded.at(-1)?.state, 'pending');
  });
});

test('sanitizes unsafe migration sequences without losing snapshot FIFO order', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.nextSequence = 1e20;
  fixture.items.forEach((item) => { item.sequence = 1e20; });
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');

  assert.deepEqual(pending.map((item) => item.itemId), [
    ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
    'new-confirmation',
  ]);
  assert.equal(
    pending.filter((item) => item.generation === 42).map((item) => item.text).join(''),
    legacyFullChunkText,
  );
  assertSafePersistedSequences(filePath);
});

for (const { name, value } of [
  { name: 'fractional', value: 1.5 },
  { name: 'negative', value: -1 },
]) {
  test(`sanitizes ${name} migration sequences in deterministic snapshot order`, () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.nextSequence = value;
    fixture.items.forEach((item) => { item.sequence = value; });
    writeFileSync(filePath, JSON.stringify(fixture));

    const store = new OutboxStore(filePath, migrationOptions());
    const pending = store.listPending('user-a', 'account-a');

    assert.deepEqual(pending.map((item) => item.itemId), [
      ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
      'new-confirmation',
    ]);
    assert.equal(
      pending.filter((item) => item.generation === 42).map((item) => item.text).join(''),
      legacyFullChunkText,
    );
    assertSafePersistedSequences(filePath);
  });
}

test('rejects migration when no safe next sequence remains', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  const firstSequence = Number.MAX_SAFE_INTEGER - fixture.items.length;
  fixture.items.forEach((item, index) => { item.sequence = firstSequence + index; });
  fixture.nextSequence = Number.MAX_SAFE_INTEGER;
  fixture.items[12].text = `${fixture.items[12].text}${'Z'.repeat(MIGRATED_BODY_BYTES)}`;
  const encoded = JSON.stringify(fixture);
  writeFileSync(filePath, encoded);

  assert.throws(
    () => new OutboxStore(filePath, migrationOptions()),
    (error: unknown) => {
      assert.ok(error instanceof OutboxMigrationError);
      assert.match(error.message, /^outbox migration failed: .*sequence/i);
      return true;
    },
  );
  assert.equal(readFileSync(filePath, 'utf8'), encoded);
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
