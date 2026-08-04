# Legacy Full-Size Outbox Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize strictly identified legacy full-size final batches before delivery planning so the existing continuation notice fits within the 2000-byte WeChat body limit and the preserved live backlog can resume safely.

**Architecture:** `OutboxStore` receives numeric migration limits from `ILinkClient`, decodes the selected primary/backup snapshot into a temporary state, and transactionally rechunks only eligible consecutive legacy-derived final batches before publishing memory. The existing UTF-8 chunker and delivery planner remain the source of truth; tests use deterministic schema-1 and schema-2 revision-2 fixtures shaped like the preserved device failure.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, synchronous JSON snapshots, existing `atomicWrite()`, existing `chunkUtf8Text()`, iLink client fetch test double.

---

## File Structure

- Create `test/fixtures/legacy-full-chunk.ts`: deterministic schema-1 and schema-2 revision-2 snapshots matching the 12 x 2000 + 144-byte failure shape.
- Modify `src/ilink/outbox.ts`: migration options, explicit migration error, temporary snapshot decoding, strict eligibility checks, UTF-8 rechunking, identity reuse, resequencing, and persist-before-publish startup flow.
- Modify `test/outbox.test.ts`: schema-1/schema-2 regressions, persistence/idempotency assertions, strict no-op matrix, and invalid-limit coverage.
- Modify `src/ilink/client.ts`: pass `BODY_CHUNK_BYTES` and the effective inbound window size into the default `OutboxStore`.
- Modify `test/client-send.test.ts`: load the schema-2 failure fixture through `ILinkClient` and prove the first recovered window is deliverable without a standalone notice.
- Modify `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`: after automated verification, record the fixed candidate, migration evidence, fixed poller PID, and resumed real-device status. This existing dirty file must be committed only in its dedicated acceptance-evidence commit.

### Task 1: Add Deterministic Failure Fixtures

**Files:**
- Create: `test/fixtures/legacy-full-chunk.ts`

- [ ] **Step 1: Create the fixture module**

Create `test/fixtures/legacy-full-chunk.ts` with this complete content:

```ts
export const LEGACY_BODY_BYTES = 2_000;
export const MIGRATED_BODY_BYTES = 1_944;
export const INBOUND_WINDOW_ITEMS = 10;

const CREATED_AT = 1_785_825_600_000;
const EXPIRES_AT = 4_102_444_800_000;
const FULL_LEGACY_TEXTS = Array.from(
  { length: 12 },
  (_, index) => String.fromCharCode(65 + index).repeat(LEGACY_BODY_BYTES),
);
FULL_LEGACY_TEXTS[10] = `${'汉'.repeat(666)}ab`;
const LEGACY_TEXTS = [...FULL_LEGACY_TEXTS, 'M'.repeat(144)];

export const legacyFullChunkText = LEGACY_TEXTS.join('');

export interface OutboxFixtureSnapshot {
  schemaVersion: number;
  revision?: number;
  nextSequence: number;
  items: Array<Record<string, unknown>>;
}

function legacyItem(index: number, text: string, schemaVersion: 1 | 2): Record<string, unknown> {
  return {
    schemaVersion,
    itemId: `legacy-${index + 1}`,
    clientId: `legacy-client-${index + 1}`,
    sequence: index + 1,
    kind: 'text',
    accountId: 'account-a',
    userId: 'user-a',
    generation: 42,
    tokenVersion: 7,
    priority: 'final',
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    createdAt: CREATED_AT + index,
    expiresAt: EXPIRES_AT,
    state: 'pending',
  };
}

export function schemaOneLegacyFullChunkFixture(): OutboxFixtureSnapshot {
  return {
    schemaVersion: 1,
    nextSequence: 14,
    items: LEGACY_TEXTS.map((text, index) => legacyItem(index, text, 1)),
  };
}

export function schemaTwoFailureFixture(): OutboxFixtureSnapshot {
  return {
    schemaVersion: 2,
    revision: 2,
    nextSequence: 15,
    items: [
      ...LEGACY_TEXTS.map((text, index) => legacyItem(index, text, 2)),
      {
        schemaVersion: 2,
        itemId: 'new-confirmation',
        clientId: 'new-confirmation-client',
        sequence: 14,
        kind: 'text',
        accountId: 'account-a',
        userId: 'user-a',
        generation: 49,
        tokenVersion: 8,
        priority: 'final',
        text: '新会话',
        bytes: Buffer.byteLength('新会话', 'utf8'),
        createdAt: CREATED_AT + 100,
        expiresAt: EXPIRES_AT,
        state: 'pending',
      },
    ],
  };
}
```

- [ ] **Step 2: Run the existing outbox suite before importing the fixture**

Run:

```powershell
node --import tsx --test test/outbox.test.ts
```

Expected: all existing outbox tests pass; the new module has no side effects.

- [ ] **Step 3: Commit the fixture**

```powershell
git add test/fixtures/legacy-full-chunk.ts
git commit -m "test: add legacy full-chunk fixtures"
```

Expected: the commit contains only the fixture module.

### Task 2: Normalize Eligible Batches Transactionally

**Files:**
- Modify: `src/ilink/outbox.ts`
- Modify: `test/outbox.test.ts`

- [ ] **Step 1: Write the schema-1 and schema-2 failing regressions**

Add these imports to `test/outbox.test.ts`:

```ts
import { planDeliveryWindow, type DeliveryItem } from '../src/ilink/delivery-planner.js';
import {
  INBOUND_WINDOW_ITEMS,
  MIGRATED_BODY_BYTES,
  legacyFullChunkText,
  schemaOneLegacyFullChunkFixture,
  schemaTwoFailureFixture,
} from './fixtures/legacy-full-chunk.js';
```

Add this helper and both tests after the existing schema-one migration test:

```ts
function migrationOptions() {
  return {
    bodyChunkBytes: MIGRATED_BODY_BYTES,
    inboundItemLimit: INBOUND_WINDOW_ITEMS,
  };
}

test('normalizes a schema-one legacy full-chunk batch before delivery planning', () => {
  const filePath = tempPath();
  const fixture = schemaOneLegacyFullChunkFixture();
  writeFileSync(filePath, JSON.stringify(fixture, null, 2));

  const store = new OutboxStore(filePath, migrationOptions());
  const migrated = store.listPending('user-a', 'account-a');

  assert.equal(migrated.length, 13);
  assert.equal(migrated.map((item) => item.text).join(''), legacyFullChunkText);
  assert.deepEqual(migrated.map((item) => item.itemId),
    Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`));
  assert.deepEqual(migrated.map((item) => item.clientId),
    Array.from({ length: 13 }, (_, index) => `legacy-client-${index + 1}`));
  assert.ok(migrated.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.deepEqual(migrated.map((item) => item.bytes), [
    ...Array.from({ length: 10 }, () => 1_944),
    1_943,
    1_944,
    817,
  ]);
  assert.deepEqual(
    migrated.map((item) => ({ createdAt: item.createdAt, expiresAt: item.expiresAt })),
    fixture.items.map((item) => ({ createdAt: item.createdAt, expiresAt: item.expiresAt })),
  );
  assert.doesNotThrow(() => planDeliveryWindow(migrated as DeliveryItem[], {
    sentItems: 0,
    maxItems: INBOUND_WINDOW_ITEMS,
    maxBytes: 2_000,
    continuationNotice: '后续内容已排队，请回复“继续”续发。',
  }));

  const primary = JSON.parse(readFileSync(filePath, 'utf8'));
  const backup = JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'));
  assert.equal(primary.schemaVersion, 2);
  assert.equal(primary.revision, backup.revision);
  assert.deepEqual(primary, backup);

  const persistedBeforeReload = readFileSync(filePath, 'utf8');
  const reloaded = new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), persistedBeforeReload);
  assert.deepEqual(reloaded.listPending('user-a', 'account-a'), migrated);
});

test('normalizes the schema-two revision-two failure batch and preserves the queued new confirmation', () => {
  const filePath = tempPath();
  writeFileSync(filePath, JSON.stringify(schemaTwoFailureFixture(), null, 2));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');
  const legacy = pending.filter((item) => item.generation === 42);

  assert.equal(legacy.length, 13);
  assert.equal(legacy.map((item) => item.text).join(''), legacyFullChunkText);
  assert.ok(legacy.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.equal(pending.at(-1)?.itemId, 'new-confirmation');
  assert.equal(pending.at(-1)?.text, '新会话');

  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(persisted.revision, 3);
  const persistedBeforeReload = readFileSync(filePath, 'utf8');
  new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), persistedBeforeReload);
});
```

- [ ] **Step 2: Run the regressions and verify RED**

Run:

```powershell
node --import tsx --test test/outbox.test.ts
```

Expected: TypeScript reports that `bodyChunkBytes` and `inboundItemLimit` are not members of `OutboxOptions`. If the test runner proceeds past type stripping, the byte-limit assertion or planner assertion fails because the 2000-byte bodies are unchanged.

- [ ] **Step 3: Add migration types, explicit errors, and temporary decoded state**

In `src/ilink/outbox.ts`, import the existing UTF-8 chunker:

```ts
import { chunkUtf8Text } from './text-chunk.js';
```

Extend `OutboxOptions` and add the error/state declarations:

```ts
export interface OutboxOptions {
  defaultTtlMs?: number;
  maxItemsPerUser?: number;
  maxBytesPerUser?: number;
  finalReserveItems?: number;
  finalReserveBytes?: number;
  bodyChunkBytes?: number;
  inboundItemLimit?: number;
  now?: () => number;
}

export class OutboxMigrationError extends Error {
  constructor(message: string) {
    super(`outbox migration failed: ${message}`);
    this.name = 'OutboxMigrationError';
  }
}

interface LoadedOutboxState {
  revision: number;
  nextSequence: number;
  items: Map<string, OutboxItem>;
}

interface NormalizedOutboxState {
  nextSequence: number;
  items: Map<string, OutboxItem>;
  changed: boolean;
}
```

Add two readonly fields to `OutboxStore`, initialize them in the constructor, and validate before `load()`:

```ts
private readonly bodyChunkBytes?: number;
private readonly inboundItemLimit?: number;

this.bodyChunkBytes = options.bodyChunkBytes;
this.inboundItemLimit = options.inboundItemLimit;
this.validateMigrationLimits();
```

Use this validation method:

```ts
private validateMigrationLimits(): void {
  const bothAbsent = this.bodyChunkBytes === undefined && this.inboundItemLimit === undefined;
  if (bothAbsent) return;
  if (!Number.isInteger(this.bodyChunkBytes) || this.bodyChunkBytes! <= 0) {
    throw new OutboxMigrationError('bodyChunkBytes must be a positive integer');
  }
  if (!Number.isInteger(this.inboundItemLimit) || this.inboundItemLimit! <= 0) {
    throw new OutboxMigrationError('inboundItemLimit must be a positive integer');
  }
}
```

- [ ] **Step 4: Replace mutating snapshot load with decode-normalize-persist-publish**

Replace `loadSnapshot()` with `decodeSnapshot()` using the existing field sanitation logic, but write into a local map and return it:

```ts
private decodeSnapshot(snapshot: LegacySnapshot): LoadedOutboxState {
  const items = new Map<string, OutboxItem>();
  let maxSequence = 0;
  for (const raw of snapshot.items ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Partial<OutboxItem>;
    if (typeof value.text !== 'string') continue;
    const priority = value.priority && PRIORITY_RANK[value.priority] !== undefined
      ? value.priority
      : 'final';
    const sequence = asFiniteNumber(value.sequence, maxSequence + 1);
    const createdAt = asFiniteNumber(value.createdAt, this.now());
    const item: OutboxItem = {
      schemaVersion: 2,
      itemId: value.itemId || randomUUID(),
      clientId: value.clientId || randomUUID(),
      sequence,
      kind: 'text',
      accountId: value.accountId || '',
      userId: value.userId || '',
      generation: asFiniteNumber(value.generation, 0),
      tokenVersion: asFiniteNumber(value.tokenVersion, 0),
      priority,
      text: value.text,
      bytes: Buffer.byteLength(value.text, 'utf8'),
      createdAt,
      expiresAt: asFiniteNumber(value.expiresAt, createdAt + this.defaultTtlMs),
      state: value.state === 'permanent-failure' ? 'permanent-failure' : 'pending',
      ...(value.deliveryReceipt?.reservationId && Number.isInteger(value.deliveryReceipt.quotaGeneration)
        ? { deliveryReceipt: {
            reservationId: value.deliveryReceipt.reservationId,
            quotaGeneration: value.deliveryReceipt.quotaGeneration,
          } }
        : {}),
      ...(value.continuationNoticeAttached ? { continuationNoticeAttached: true } : {}),
      ...(value.recoveryRequired ? { recoveryRequired: true } : {}),
      ...(value.terminalError ? { terminalError: value.terminalError } : {}),
    };
    if (items.has(item.itemId)) continue;
    items.set(item.itemId, item);
    maxSequence = Math.max(maxSequence, sequence);
  }
  return {
    revision: asFiniteNumber(snapshot.revision, 0),
    nextSequence: Math.max(
      Number.isInteger(snapshot.nextSequence) ? snapshot.nextSequence! : 1,
      maxSequence + 1,
    ),
    items,
  };
}
```

Replace `load()` with this persist-before-publish flow:

```ts
private load(): void {
  const primary = this.readSnapshot(this.filePath);
  const backup = this.readSnapshot(this.backupPath);
  if (primary || backup) {
    const useBackup = Boolean(backup)
      && (!primary || this.snapshotFreshness(backup!) > this.snapshotFreshness(primary));
    const selected = useBackup ? backup! : primary!;
    const loaded = this.decodeSnapshot(selected);
    const normalized = this.normalizeLegacyFinalBatches(loaded.items, loaded.nextSequence);
    this.revision = loaded.revision;
    if (normalized.changed || useBackup || selected.schemaVersion !== 2
      || !Number.isInteger(selected.revision)) {
      this.persistState(normalized.items, normalized.nextSequence);
    }
    this.publish(normalized.items, normalized.nextSequence);
    return;
  }
  if (existsSync(this.filePath) || existsSync(this.backupPath)) {
    throw new OutboxCorruptionError(this.filePath);
  }
}
```

- [ ] **Step 5: Implement strict batch normalization**

Add these methods before `persistState()`:

```ts
private sameLegacyBatch(left: OutboxItem, right: OutboxItem): boolean {
  return left.accountId === right.accountId
    && left.userId === right.userId
    && left.generation === right.generation
    && left.tokenVersion === right.tokenVersion;
}

private isEligibleLegacyBatch(batch: readonly OutboxItem[]): boolean {
  const bodyChunkBytes = this.bodyChunkBytes!;
  const inboundItemLimit = this.inboundItemLimit!;
  return batch.length > inboundItemLimit
    && batch.every((item) => item.priority === 'final'
      && item.state === 'pending'
      && !item.deliveryReceipt
      && !item.recoveryRequired
      && !item.continuationNoticeAttached)
    && batch.some((item) => item.bytes > bodyChunkBytes);
}

private normalizeLegacyFinalBatches(
  items: Map<string, OutboxItem>,
  nextSequence: number,
): NormalizedOutboxState {
  if (this.bodyChunkBytes === undefined || this.inboundItemLimit === undefined) {
    return { items, nextSequence, changed: false };
  }

  const ordered = [...items.values()].sort((left, right) =>
    left.sequence - right.sequence || left.itemId.localeCompare(right.itemId));
  const normalized: OutboxItem[] = [];
  let changed = false;

  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && this.sameLegacyBatch(ordered[start], ordered[end])) end += 1;
    const batch = ordered.slice(start, end);
    if (!this.isEligibleLegacyBatch(batch)) {
      normalized.push(...batch);
      start = end;
      continue;
    }

    const originalText = batch.map((item) => item.text).join('');
    const chunks = chunkUtf8Text(originalText, this.bodyChunkBytes);
    if (chunks.join('') !== originalText
      || chunks.some((chunk) => Buffer.byteLength(chunk, 'utf8') > this.bodyChunkBytes!)) {
      throw new OutboxMigrationError(
        `UTF-8 rechunk invariant failed for ${batch[0].accountId}/${batch[0].userId}`,
      );
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const existing = batch[index];
      const source = existing ?? batch[batch.length - 1];
      const text = chunks[index];
      normalized.push({
        ...source,
        schemaVersion: 2,
        itemId: existing?.itemId ?? randomUUID(),
        clientId: existing?.clientId ?? randomUUID(),
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    }
    changed = true;
    start = end;
  }

  if (!changed) return { items, nextSequence, changed: false };
  const firstSequence = Math.max(1, Math.floor(ordered[0]?.sequence ?? 1));
  const resequenced = new Map<string, OutboxItem>();
  normalized.forEach((item, index) => {
    const value = { ...item, sequence: firstSequence + index };
    resequenced.set(value.itemId, value);
  });
  return {
    items: resequenced,
    nextSequence: Math.max(nextSequence, firstSequence + normalized.length),
    changed: true,
  };
}
```

- [ ] **Step 6: Run the focused outbox tests and verify GREEN**

Run:

```powershell
node --import tsx --test test/outbox.test.ts
```

Expected: all outbox tests pass; both new regressions persist a schema-2 snapshot and reload without another revision.

- [ ] **Step 7: Commit the transactional migration**

```powershell
git add src/ilink/outbox.ts test/outbox.test.ts
git commit -m "fix: normalize legacy full-size final batches"
```

Expected: the commit contains only outbox behavior and its tests.

### Task 3: Lock Down the Strict Eligibility Boundary

**Files:**
- Modify: `test/outbox.test.ts`
- Modify: `src/ilink/outbox.ts` only if a new test exposes an eligibility defect

- [ ] **Step 1: Add invalid-limit and no-op matrix tests**

Import `OutboxMigrationError` from `outbox.ts`, then append these tests:

```ts
test('rejects partial or invalid legacy migration limits before reading a snapshot', () => {
  assert.throws(
    () => new OutboxStore(tempPath(), { bodyChunkBytes: 0, inboundItemLimit: 10 }),
    OutboxMigrationError,
  );
  assert.throws(
    () => new OutboxStore(tempPath(), { bodyChunkBytes: 1_944 }),
    OutboxMigrationError,
  );
});

test('raises an explicit migration error when a UTF-8 code point cannot satisfy the configured limit', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.items = fixture.items.slice(0, 11);
  fixture.items[0].text = '汉';
  fixture.items[0].bytes = Buffer.byteLength('汉', 'utf8');
  for (const item of fixture.items.slice(1)) {
    item.text = 'a';
    item.bytes = 1;
  }
  writeFileSync(filePath, JSON.stringify(fixture, null, 2));

  assert.throws(
    () => new OutboxStore(filePath, { bodyChunkBytes: 1, inboundItemLimit: 10 }),
    (error: unknown) => error instanceof OutboxMigrationError
      && /UTF-8 rechunk invariant failed/.test(error.message),
  );
});

test('does not rewrite batches outside the strict legacy signature', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (items: Array<Record<string, unknown>>) => void;
  }> = [
    {
      name: 'already compliant schema-two body sizes',
      mutate: (items) => {
        for (const item of items.slice(0, 13)) {
          item.text = 'x'.repeat(MIGRATED_BODY_BYTES);
          item.bytes = MIGRATED_BODY_BYTES;
        }
      },
    },
    {
      name: 'separate generations each within one window',
      mutate: (items) => {
        for (const item of items.slice(6, 13)) item.generation = 43;
      },
    },
    {
      name: 'non-final member',
      mutate: (items) => { items[5].priority = 'intermediate'; },
    },
    {
      name: 'permanent-failure member',
      mutate: (items) => { items[5].state = 'permanent-failure'; },
    },
    {
      name: 'delivery receipt member',
      mutate: (items) => {
        items[5].deliveryReceipt = { reservationId: 'reservation-1', quotaGeneration: 42 };
      },
    },
    {
      name: 'recovery-required member',
      mutate: (items) => { items[5].recoveryRequired = true; },
    },
    {
      name: 'continuation-attached member',
      mutate: (items) => { items[5].continuationNoticeAttached = true; },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const filePath = tempPath();
      const fixture = schemaTwoFailureFixture();
      testCase.mutate(fixture.items);
      const before = JSON.stringify(fixture, null, 2);
      writeFileSync(filePath, before);

      new OutboxStore(filePath, migrationOptions());

      assert.equal(readFileSync(filePath, 'utf8'), before);
      assert.equal(existsSync(`${filePath}.bak`), false);
    });
  }
});

test('reuses identities positionally when normalization expands or contracts a batch', async (t) => {
  await t.test('creates durable identities only for additional chunks', () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.items = fixture.items.slice(0, 11);
    fixture.nextSequence = 12;
    writeFileSync(filePath, JSON.stringify(fixture, null, 2));

    const store = new OutboxStore(filePath, migrationOptions());
    const migrated = store.listPending('user-a', 'account-a');

    assert.equal(migrated.length, 12);
    assert.deepEqual(
      migrated.slice(0, 11).map((item) => item.itemId),
      fixture.items.map((item) => item.itemId),
    );
    assert.equal(fixture.items.some((item) => item.itemId === migrated[11].itemId), false);
    const addedItemId = migrated[11].itemId;
    const reloaded = new OutboxStore(filePath, migrationOptions());
    assert.equal(reloaded.listPending('user-a', 'account-a')[11].itemId, addedItemId);
  });

  await t.test('removes only unused pending identities when chunks contract', () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    const confirmation = fixture.items.at(-1)!;
    const legacy = fixture.items.slice(0, 11);
    legacy.forEach((item, index) => {
      const text = index === 0 ? 'x'.repeat(2_000) : String(index);
      item.text = text;
      item.bytes = Buffer.byteLength(text, 'utf8');
    });
    fixture.items = [...legacy, confirmation];
    writeFileSync(filePath, JSON.stringify(fixture, null, 2));

    const store = new OutboxStore(filePath, migrationOptions());
    const pending = store.listPending('user-a', 'account-a');

    assert.deepEqual(pending.map((item) => item.itemId), [
      'legacy-1',
      'legacy-2',
      'new-confirmation',
    ]);
    assert.equal(pending.slice(0, 2).map((item) => item.text).join(''),
      legacy.map((item) => item.text).join(''));
    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.ok(persisted.nextSequence > Math.max(...persisted.items.map(
      (item: { sequence: number }) => item.sequence,
    )));
  });
});
```

Add `existsSync` to the existing `node:fs` import.

- [ ] **Step 2: Run the no-op matrix and verify the expected failure, if any**

Run:

```powershell
node --import tsx --test test/outbox.test.ts
```

Expected: all cases pass. If a case fails, the failure must identify a batch the current predicate rewrote despite receipt, recovery, notice, state, priority, generation, or compliant-size evidence.

- [ ] **Step 3: Tighten only the exposed predicate defect**

The intended complete predicate remains:

```ts
batch.length > inboundItemLimit
  && batch.every((item) => item.priority === 'final'
    && item.state === 'pending'
    && !item.deliveryReceipt
    && !item.recoveryRequired
    && !item.continuationNoticeAttached)
  && batch.some((item) => item.bytes > bodyChunkBytes)
```

Do not add schema-version gating: the preserved authoritative live file is already schema 2 revision 2.

- [ ] **Step 4: Run outbox tests again and commit the eligibility proof**

```powershell
node --import tsx --test test/outbox.test.ts
git add test/outbox.test.ts src/ilink/outbox.ts
git commit -m "test: guard legacy batch migration eligibility"
```

Expected: all outbox tests pass; the commit proves all exclusion states remain byte-for-byte unchanged.

### Task 4: Wire Client Limits and Prove the First Recovery Window

**Files:**
- Modify: `src/ilink/client.ts`
- Modify: `test/client-send.test.ts`

- [ ] **Step 1: Write the failing client integration regression**

Change the `node:fs` import in `test/client-send.test.ts` to include `writeFileSync`, import the schema-2 fixture constants, and allow the message helper to carry exact text:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import {
  schemaTwoFailureFixture,
} from './fixtures/legacy-full-chunk.js';

function message(
  id: number,
  uid = 'user-a',
  contextToken = 'context-token',
  text = 'hello',
): WeixinMessage {
  return {
    message_id: id,
    from_user_id: uid,
    to_user_id: 'bot-user',
    client_id: `inbound-${id}`,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}
```

Add this test after the existing thirteen-chunk test:

```ts
test('migrates the live schema-two failure shape before the first recovery window', async () => {
  const options = paths();
  writeFileSync(options.outboxPath, JSON.stringify(schemaTwoFailureFixture(), null, 2));
  const client = new ILinkClient(CREDS, options);

  await withFetchResponses(Array.from({ length: 10 }, () => ({ ret: 0 })), async (requests) => {
    await (client as any).processMessage(message(50, 'user-a', 'fresh-token', '继续'));

    assert.equal(requests.length, 10);
    const bodies = requests.map((request) => request.body.msg.item_list[0].text_item.text as string);
    assert.ok(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 2_000));
    assert.match(bodies[9], /\n\n后续内容已排队，请回复“继续”续发。$/);
    assert.equal(bodies.some((body) => body === '后续内容已排队，请回复“继续”续发。'), false);

    const pending = client.getDeliveryStatus('user-a').pending;
    assert.deepEqual(pending.map((item) => item.itemId), [
      'legacy-11',
      'legacy-12',
      'legacy-13',
      'new-confirmation',
    ]);
    assert.equal(pending.at(-1)?.text, '新会话');
  });
});
```

- [ ] **Step 2: Run the client regression and verify RED**

Run:

```powershell
node --import tsx --test test/client-send.test.ts
```

Expected: `processMessage()` catches and records `RangeError: continuation notice exceeds maxBytes`, so the request-count assertion fails with zero requests because the default `OutboxStore` has not received migration limits.

- [ ] **Step 3: Pass one effective window size to both outbox and quota**

Change the quota import in `src/ilink/client.ts`:

```ts
import { DEFAULT_QUOTA_LIMITS, QuotaManager } from './quota.js';
```

Replace the outbox/quota construction in `ILinkClient` with:

```ts
const maxItemsPerWindow = options.maxItemsPerWindow ?? DEFAULT_QUOTA_LIMITS.maxItemsPerWindow;
this.outbox = options.outbox || new OutboxStore(options.outboxPath || join(DATA_DIR, 'outbox.json'), {
  bodyChunkBytes: BODY_CHUNK_BYTES,
  inboundItemLimit: maxItemsPerWindow,
});
this.quota = options.quota || new QuotaManager(
  options.quotaPath || join(DATA_DIR, 'quota.json'),
  this.accountId,
  { maxItemsPerWindow },
);
```

Injected `OutboxStore` instances remain caller-owned and are not reconstructed. Tests that exercise migration through the client must therefore use `outboxPath`, as the new regression does.

- [ ] **Step 4: Run the focused planner, outbox, and client suites**

Run:

```powershell
node --import tsx --test test/delivery-planner.test.ts test/outbox.test.ts test/client-send.test.ts
```

Expected: every focused test passes; the new client test makes exactly ten requests, the tenth contains the attached notice, and four items remain durable.

- [ ] **Step 5: Commit client integration**

```powershell
git add src/ilink/client.ts test/client-send.test.ts
git commit -m "fix: migrate legacy chunks before client recovery"
```

Expected: the commit contains only client wiring and its integration regression.

### Task 5: Run Complete Automated Verification

**Files:**
- No source edits expected

- [ ] **Step 1: Run static checks and the complete test suite**

Run each command independently and stop on the first failure:

```powershell
npm run typecheck
npm test
npm run build
git diff --check
```

Expected:

- `npm run typecheck` exits 0.
- `npm test` exits 0 with all tests passing except the two existing expected platform skips.
- `npm run build` exits 0 and refreshes ignored `dist/` output.
- `git diff --check` exits 0. The two pre-existing dirty documentation files may remain modified; no whitespace error is allowed in them.

- [ ] **Step 2: Verify migration arithmetic independently**

Run:

```powershell
node --input-type=module -e "const total=24144,limit=1944,suffix=56; const count=Math.ceil(total/limit); if(count!==13||limit+suffix!==2000) process.exit(1); console.log({total,limit,suffix,count})"
```

Expected output includes `{ total: 24144, limit: 1944, suffix: 56, count: 13 }`.

- [ ] **Step 3: Inspect the final source diff without touching preserved docs**

Run:

```powershell
git status --short
git log -5 --oneline
git diff HEAD -- src/ilink/outbox.ts src/ilink/client.ts test/outbox.test.ts test/client-send.test.ts test/fixtures/legacy-full-chunk.ts
```

Expected: the five implementation/test paths have no uncommitted changes. The only retained dirty paths are the previously documented acceptance files:

```text
docs/superpowers/experiments/2026-08-03-long-task-acceptance.md
docs/superpowers/plans/2026-08-04-quota-management-v2.md
```

### Task 6: Perform the Controlled Fixed-Poller Restart

**Files:**
- Modify after evidence capture: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Prove zero pollers and preserve the pre-fixed-start live state**

Run:

```powershell
$pollers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[/\\]index\.js.*--debug'
})
if ($pollers.Count -ne 0) {
  throw "Expected zero bridge pollers before fixed start; found $($pollers.ProcessId -join ', ')"
}
$acceptanceRoot = (Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt').Trim()
$preFixed = Join-Path $acceptanceRoot 'wx-ai-bridge-pre-fixed-start'
if (Test-Path -LiteralPath $preFixed) {
  throw "Refusing to overwrite existing evidence: $preFixed"
}
Copy-Item -LiteralPath 'C:\Users\35952\.wx-ai-bridge' -Destination $preFixed -Recurse
Get-ChildItem -LiteralPath $preFixed -Recurse -File | Measure-Object
```

Expected: zero existing pollers and a new immutable snapshot under the existing evidence root. Do not clear the live outbox, edit cursors, or restore an older snapshot.

- [ ] **Step 2: Start exactly one fixed V2 poller**

Run:

```powershell
$acceptanceRoot = (Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt').Trim()
$stdoutPath = Join-Path $acceptanceRoot 'v2-fixed.stdout.log'
$stderrPath = Join-Path $acceptanceRoot 'v2-fixed.stderr.log'
$pidPath = Join-Path $acceptanceRoot 'v2-fixed.pid'
if ((Test-Path -LiteralPath $stdoutPath) -or (Test-Path -LiteralPath $stderrPath)
  -or (Test-Path -LiteralPath $pidPath)) {
  throw 'Refusing to overwrite existing fixed-poller evidence'
}
$fixed = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'dist/index.js','--debug' `
  -WorkingDirectory 'C:\tmp\cli-in-wechat-quota-v2' `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru
$fixed.Id | Set-Content -LiteralPath $pidPath
Start-Sleep -Seconds 3
$pollers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[/\\]index\.js.*--debug'
})
if ($pollers.Count -ne 1 -or $pollers[0].ProcessId -ne $fixed.Id) {
  throw "Expected only fixed V2 PID $($fixed.Id); found $($pollers.ProcessId -join ', ')"
}
Get-Content -LiteralPath $stdoutPath,$stderrPath -Tail 100
```

Expected: exactly one fixed poller remains alive, and its logs contain no startup, migration, planner, or corruption error. Startup must have persisted a new schema-2 revision before polling.

- [ ] **Step 3: Verify the authoritative live snapshot after startup**

Run a read-only Node check against `C:\Users\35952\.wx-ai-bridge\outbox.json`:

```powershell
node --input-type=module -e "import{readFileSync}from'node:fs';const p='C:/Users/35952/.wx-ai-bridge/outbox.json';const s=JSON.parse(readFileSync(p,'utf8'));const old=s.items.filter(x=>x.generation===42&&x.priority==='final');if(old.length!==13)throw Error('expected 13 old finals');if(old.some(x=>Buffer.byteLength(x.text,'utf8')>1944))throw Error('oversized migrated body');if(!s.items.some(x=>x.generation===49&&x.text==='新会话'))throw Error('queued new confirmation missing');console.log({schemaVersion:s.schemaVersion,revision:s.revision,oldFinals:old.length,totalItems:s.items.length})"
```

Expected: schema 2, a revision newer than 2, 13 generation-42 finals at no more than 1944 bytes each, and the generation-49 `新会话` confirmation still present.

- [ ] **Step 4: Record evidence in the acceptance log and commit it separately**

Update `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md` with the fixed candidate SHA, fixed poller PID, migration revision, live outbox counts, exact evidence paths, and automated verification totals. Preserve all existing failure chronology.

Run:

```powershell
git diff -- docs/superpowers/experiments/2026-08-03-long-task-acceptance.md
git add docs/superpowers/experiments/2026-08-03-long-task-acceptance.md
git commit -m "docs: record fixed migration cutover evidence"
```

Expected: the commit contains only the acceptance log. The pre-existing checkbox edits in `docs/superpowers/plans/2026-08-04-quota-management-v2.md` remain unstaged.

### Task 7: Resume Physical-Device Recovery and Acceptance

**Files:**
- Modify throughout: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Request one exact recovery inbound from the user**

Ask the user to send exactly:

```text
继续
```

Expected on the physical WeChat device: ten old generation-42 final bubbles become visible, the tenth ends with `后续内容已排队，请回复“继续”续发。`, no standalone continuation bubble appears, and `/new` is not executed again.

- [ ] **Step 2: Drain the remaining preserved backlog window by window**

After each observed boundary, ask for another exact `继续`, inspect the fixed logs and live outbox read-only, and record:

```text
inbound message_id
request count
visible bubble count
last visible body suffix
remaining generation-42 count
generation-49 confirmation state
duplicate count
standalone-notice count
```

Expected: the old finals drain in FIFO order, the queued `新会话` confirmation follows them, every body is at most 2000 bytes, and the inbound `/new` is never replayed.

- [ ] **Step 3: Continue the existing 20-run matrix**

Resume Steps 5-8 in `docs/superpowers/plans/2026-08-04-quota-management-v2.md`. Completion still requires all of these physical-device gates:

```text
20 long tasks total
compact >= 5
normal >= 5
verbose >= 5
at least one actual run > 10 chunks
at least one actual run > 20 chunks
controlled restart during run 7
100% visible completeness
0 duplicate bubbles
attached continuation at every partial boundary
0 standalone continuation bubbles
1800-4500-byte observations while the configured threshold remains 2000
```

Do not create `codex/main-candidate` until every gate is recorded as passed. Do not push `upstream`, replace `main`, restore snapshots, clear the live outbox, or alter cursors manually.

## Final Self-Review Checklist

- [ ] Every eligibility condition from the approved design has a positive or negative test.
- [ ] Both schema 1 and schema 2 revision 2 failure shapes are covered.
- [ ] Concatenated UTF-8 text, FIFO order, positional identities, primary/backup revision, and reload idempotency are asserted.
- [ ] The client integration proves 10 requests, an attached tenth-body notice, no body above 2000 bytes, no standalone notice, and the queued `新会话` confirmation remains.
- [ ] Automated checks pass before any poller starts.
- [ ] Exactly one poller starts from the isolated worktree and migration is verified read-only before the user sends `继续`.
- [ ] Existing evidence snapshots and dirty documentation are preserved.
- [ ] `codex/main-candidate` remains forbidden until the full physical-device matrix passes.
