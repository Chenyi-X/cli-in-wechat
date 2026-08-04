# Quota Management V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver long WeChat responses through durable, quota-aware windows that resume after new inbound messages or process restarts without duplicate visible chunks.

**Architecture:** A pure delivery planner selects a FIFO prefix within the current inbound budget and appends the continuation notice to the final body chunk when needed. A durable outbox freezes each payload and client ID before network I/O; a persisted quota manager tracks per-user inbound windows, token versions, and confirmed sends. `ILinkClient` serializes network delivery around those modules, while `Router` consumes only the exact `继续` command for recovery and leaves ordinary prompts intact.

**Tech Stack:** TypeScript, Node `node:test`, JSON snapshots written with the existing atomic file helper, UTF-8 byte accounting.

---

### Task 1: Add the failing cross-window planner test

**Files:**
- Create: `test/delivery-planner.test.ts`
- Create: `src/ilink/delivery-planner.ts` (introduced only as the missing import target)

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDeliveryWindow } from '../src/ilink/delivery-planner.js';

test('plans thirteen final chunks as ten now and three later', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({
    itemId: `item-${index + 1}`,
    text: `chunk-${index + 1}`,
    priority: 'final' as const,
    bytes: Buffer.byteLength(`chunk-${index + 1}`, 'utf8'),
  }));

  const first = planDeliveryWindow(items, { sentItems: 0, maxItems: 10, continuationNotice: '后续内容已排队，请回复“继续”续发。' });
  assert.deepEqual(first.items.map(item => item.itemId), Array.from({ length: 10 }, (_, i) => `item-${i + 1}`));
  assert.equal(first.items.at(-1)?.text.endsWith('后续内容已排队，请回复“继续”续发。'), true);
  assert.equal(first.remainingItems, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/delivery-planner.test.ts`

Expected: FAIL because `planDeliveryWindow` does not exist.

- [ ] **Step 3: Commit the red test**

```powershell
git add test/delivery-planner.test.ts
git commit -m "test: specify cross-window final delivery"
```

### Task 2: Implement the pure delivery planner

**Files:**
- Modify: `src/ilink/delivery-planner.ts`
- Modify: `test/delivery-planner.test.ts`

- [ ] **Step 1: Add the planner contract and edge-case tests**

Cover 1, 9, 10, 11, 20, 25 items; exact ten with no notice; continuation notice byte limits; priority ordering; and no empty windows.

- [ ] **Step 2: Implement the minimal pure function**

Define `DeliveryItem`, `DeliveryWindow`, and `planDeliveryWindow(items, { sentItems, maxItems, maxBytes, continuationNotice })`. Select the ordered prefix with `Math.min(maxItems - sentItems, items.length)`, reserve notice bytes while fitting the last selected text, and return `remainingItems` plus `needsContinuation` without mutating inputs.

- [ ] **Step 3: Run the focused tests**

Run: `node --import tsx --test test/delivery-planner.test.ts`

Expected: all planner tests pass.

- [ ] **Step 4: Commit**

```powershell
git add src/ilink/delivery-planner.ts test/delivery-planner.test.ts
git commit -m "feat: add quota-aware delivery planner"
```

### Task 3: Add durable outbox persistence and migration

**Files:**
- Create: `src/ilink/outbox.ts`
- Create: `test/outbox.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Specify frozen `text`, stable `clientId`, sequence ordering, `ack` only after confirmed success, restart reload, backup recovery, capacity protection for final items, final superseding same-generation activity/intermediate, and migration of the legacy array/object shape including the current thirteen final records.

- [ ] **Step 2: Implement the store**

Persist schema version 2 records with `{ itemId, clientId, sequence, userId, generation, tokenVersion, priority, text, bytes, state }`; write backup then primary atomically; keep pending and permanent-failure records; provide `enqueue`, `listPending`, `ack`, `markAmbiguous`, `markPermanentFailure`, `supersedeIntermediate`, and `migrateLegacy`.

- [ ] **Step 3: Run tests and commit**

Run: `node --import tsx --test test/outbox.test.ts`

```powershell
git add src/ilink/outbox.ts test/outbox.test.ts
git commit -m "feat: persist frozen delivery outbox"
```

### Task 4: Persist per-user quota windows

**Files:**
- Create: `src/ilink/quota.ts`
- Create: `test/quota.test.ts`

- [ ] **Step 1: Write failing quota tests**

Cover a default ten-item inbound window, confirmed-send increments only, duplicate inbound IDs, restart without resetting budget, token changes opening a fresh budget only on a real inbound, two-user isolation, and rate-backoff state.

- [ ] **Step 2: Implement `QuotaManager`**

Persist per-user `{ inboundGeneration, tokenVersion, seenInboundIds, sentItems, rateBackoffUntil }`; expose `recordInbound`, `confirmSend`, `remaining`, `markRateBackoff`, `canOpenWindow`, and `snapshot`. Do not reset on timers, poll replays, or process construction.

- [ ] **Step 3: Run tests and commit**

Run: `node --import tsx --test test/quota.test.ts`

```powershell
git add src/ilink/quota.ts test/quota.test.ts
git commit -m "feat: persist per-user inbound quotas"
```

### Task 5: Integrate outbox, planner, and single-owner send errors into the client

**Files:**
- Modify: `src/ilink/client.ts`
- Modify: `src/ilink/send-result.ts`
- Modify: `src/ilink/types.ts`
- Modify: `test/client-send.test.ts`
- Modify: `test/client-internals.test.ts`

- [ ] **Step 1: Add failing client tests**

Assert 25 final chunks drain as `25 -> 15 -> 5 -> 0` across three distinct inbound windows; payloads and client IDs survive restart and ambiguous responses; `ret=0` is the only acknowledgement; final enqueue removes same-generation activity/intermediate; missing token queues without a network call; and rate-limited `ret=-2` is classified once without nested retry ownership.

- [ ] **Step 2: Wire durable generation-aware delivery**

On each deduplicated inbound, call `quota.recordInbound`, cache its context token, and invoke `deliverPending(userId)`. Final responses are chunked at 2000 UTF-8 bytes with notice reservation, enqueued before sending, and sent only up to the planner prefix. Persist the exact API `client_id` before the first attempt; ack and `quota.confirmSend` only on confirmed success; keep the item unchanged for ambiguous outcomes.

- [ ] **Step 3: Implement error classification**

Extend `SendStatus` with `ambiguous`; treat `ret=-2` plus an `errmsg` containing `rate limited` as rate backoff; treat other `ret=-2`, empty responses, timeouts, and uncertain HTTP outcomes as ambiguous; use one backoff owner and stop the current window on ambiguity.

- [ ] **Step 4: Run client tests and commit**

Run: `node --import tsx --test test/client-send.test.ts test/client-internals.test.ts`

```powershell
git add src/ilink/client.ts src/ilink/send-result.ts src/ilink/types.ts test/client-send.test.ts test/client-internals.test.ts
git commit -m "feat: deliver durable quota windows"
```

### Task 6: Make router recovery exact and non-destructive

**Files:**
- Modify: `src/bridge/router.ts`
- Modify: `test/router.test.ts`

- [ ] **Step 1: Write failing router tests**

Verify only `text.trim() === '继续'` invokes outbox recovery; ordinary text both triggers recovery and reaches the selected adapter; duplicate message IDs do not open a window; and no old prompt is executed after restart.

- [ ] **Step 2: Implement routing**

Call client recovery for every fresh inbound before command parsing. Consume the exact `继续` message after recovery, preserve all other prompts, and remove the old automatic prompt re-execution branch. Keep slash `/continue` behavior separate.

- [ ] **Step 3: Run router tests and commit**

Run: `node --import tsx --test test/router.test.ts`

```powershell
git add src/bridge/router.ts test/router.test.ts
git commit -m "fix: reserve continue for outbox recovery"
```

### Task 7: Add diagnostics, status, compatibility, and regression coverage

**Files:**
- Create or modify: `src/ilink/diagnostics.ts`
- Modify: `src/ilink/client.ts`
- Modify: `src/bridge/router.ts`
- Modify: `test/diagnostics.test.ts`
- Modify: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Add redacted diagnostics tests**

Record inbound, plan, request, response, ack, ambiguous, and queue-change events without tokens, signed URLs, or full message bodies; expose `/status` delivery state with user-safe counts and failure state.

- [ ] **Step 2: Implement and verify compatibility**

Load old outbox files and migrate the thirteen current final chunks without dropping them; clear same-generation activity/intermediate after final enqueue; preserve the independent `/models` restoration as a separate commit if needed.

- [ ] **Step 3: Run the full suite**

Run: `npm run typecheck`; `npm test`; `npm run build`.

- [ ] **Step 4: Commit**

```powershell
git add src test docs/superpowers/experiments/2026-08-03-long-task-acceptance.md
git commit -m "test: cover durable delivery recovery and diagnostics"
```

### Task 8: Execute real-device acceptance

**Files:**
- Modify: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Run at least twenty long tasks**

Run compact, normal, and verbose modes at least five times each, including responses over ten and twenty chunks and a process restart after the seventh or tenth confirmed send.

- [ ] **Step 2: Record the gate criteria**

Record complete final visibility at 100%, zero duplicate bubbles, continuation text attached to the last body bubble of each window, zero independent notice sends, and measured 1800-4500 byte chunks before considering a threshold increase.

- [ ] **Step 3: Run final verification**

Run: `npm run typecheck`; `npm test`; `npm run build`; inspect `git diff --check` and the acceptance log before any completion claim.

