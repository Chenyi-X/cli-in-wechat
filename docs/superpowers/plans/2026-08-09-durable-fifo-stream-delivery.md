# Durable FIFO Stream Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every generated answer and Activity record and deliver it in strict outbox sequence across ten-bubble windows and restarts.

**Architecture:** Make outbox sequence the only planner ordering key, retain a one-slot live-stream holdback solely for continuation discoverability, remove final supersession, and wrap exact continuation recovery with the existing typing API. Priority can pause the FIFO head but can never delete or reorder records.

**Tech Stack:** TypeScript, Node.js, `node:test`, persisted JSON outbox/quota state, iLink send and typing APIs.

---

### Task 1: Specify FIFO planning with a stream holdback

**Files:**
- Modify: `test/delivery-planner.test.ts`
- Modify: `test/quota.test.ts`
- Modify: `src/ilink/delivery-planner.ts`
- Modify: `src/ilink/quota.ts`

- [ ] **Step 1: Replace priority-order expectations with failing FIFO tests**

Add a planner test whose input order is `activity-1`, `final-1`,
`intermediate-1` and whose two-item output must be `activity-1`, `final-1`.
Assert that ten Activity records send the first nine in FIFO order, attach the
continuation suffix to record nine, and leave record ten queued. Also assert
that the planner never skips that queued Activity to select a later final.

- [ ] **Step 2: Run the red tests**

Run:

```powershell
node --import tsx --test test/delivery-planner.test.ts test/quota.test.ts
```

Expected: FAIL because the planner sorts `final` ahead of earlier records.

- [ ] **Step 3: Implement FIFO planning and total-only quota checks**

Remove `PRIORITY_RANK` sorting and select directly from the received pending
array. Apply the FIFO head record's stream holdback without scanning later
records for a priority that could still use the tenth slot.

- [ ] **Step 4: Run focused tests and commit**

```powershell
node --import tsx --test test/delivery-planner.test.ts test/quota.test.ts
git add src/ilink/delivery-planner.ts src/ilink/quota.ts test/delivery-planner.test.ts test/quota.test.ts
git commit -m "fix: deliver mixed messages in fifo order"
```

Expected: focused tests pass with FIFO ordering and the ninth stream record as
the visible continuation boundary.

### Task 2: Preserve queued Activity and streamed answer records

**Files:**
- Modify: `test/outbox.test.ts`
- Modify: `test/client-send.test.ts`
- Modify: `src/ilink/outbox.ts`
- Modify: `src/ilink/client.ts`

- [ ] **Step 1: Write the Run 20 regression test**

Use a real `ILinkClient` with a ten-item window. Send one streamed body large
enough for fourteen chunks with `priority: 'intermediate'`, then enqueue a final
footer. Assert that the first window sends chunks 1-9, the queue contains chunks
10-14 followed by the footer, and the next inbound sends those six in that
order. Assert the ninth request contains the attached continuation suffix.

- [ ] **Step 2: Replace supersession and eviction expectations**

Change the outbox test so final enqueue preserves pending same-generation
Activity and intermediate items in sequence. Change capacity coverage so a
full queue rejects atomically and leaves all existing items unchanged instead
of evicting low-priority history. Update legacy migration coverage to retain
valid mixed-priority records while rechunking oversized records.

- [ ] **Step 3: Run the red tests**

```powershell
node --import tsx --test test/outbox.test.ts test/client-send.test.ts
```

Expected: FAIL because final enqueue deletes pending streamed chunks and the
outbox evicts low-priority records for final capacity.

- [ ] **Step 4: Remove destructive supersession and eviction**

Stop calling `removeSuperseded` from final batch enqueue. Remove live and
migration paths that delete valid Activity/intermediate records. Make capacity
validation throw before publish without selecting eviction victims. Keep batch
enqueue atomic and keep existing snapshot/backup durability rules.

- [ ] **Step 5: Run focused tests and commit**

```powershell
node --import tsx --test test/outbox.test.ts test/client-send.test.ts
git add src/ilink/outbox.ts src/ilink/client.ts test/outbox.test.ts test/client-send.test.ts
git commit -m "fix: preserve streamed delivery history"
```

Expected: Run 20 regression and outbox tests pass with no discarded records.

### Task 3: Show typing during durable continuation

**Files:**
- Modify: `test/router.test.ts`
- Modify: `src/bridge/router.ts`

- [ ] **Step 1: Write failing continuation typing tests**

Extend the router fixture with `getDeliveryStatus` and a stop counter. For exact
`继续` with pending records, assert the order `startTyping`, `recoverPending`,
`stopTyping` and assert the Agent is not executed. For an empty queue, assert
the command is consumed without starting typing.

- [ ] **Step 2: Run the red router tests**

```powershell
node --import tsx --test test/router.test.ts
```

Expected: FAIL because recovery currently occurs before command detection and
never calls `startTyping`.

- [ ] **Step 3: Implement pending-aware continuation typing**

Handle exact `继续` before ordinary recovery. Read pending count from
`getDeliveryStatus`; when positive, start typing, await `recoverPending`, and
stop typing in `finally`. Preserve recover-before-execute for every other fresh
inbound message.

- [ ] **Step 4: Run router tests and commit**

```powershell
node --import tsx --test test/router.test.ts
git add src/bridge/router.ts test/router.test.ts
git commit -m "fix: show typing during queued continuation"
```

Expected: router tests pass and exact continuation never invokes an adapter.

### Task 4: Verify, rebuild, and cut over the acceptance poller

**Files:**
- Modify after device evidence: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Run complete automated verification**

```powershell
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: zero failures, successful typecheck/build, and no whitespace errors.

- [ ] **Step 2: Preserve live state and restart only the recorded poller**

Copy `C:\Users\35952\.wx-ai-bridge` into a new timestamped child directory of
`C:\tmp\cli-in-wechat-v2-device-20260804-142952`, stop the PID recorded in
`v2-acceptance-20260809-run7-restart.pid`, verify zero matching pollers, start
`dist/index.js --debug` from `C:\tmp\cli-in-wechat-quota-v2`, and verify exactly
one matching poller plus an unchanged empty outbox.

- [ ] **Step 3: Rerun Run 20 on the real device**

Send the approved verbose XX prompt. At each attached boundary notice, send
exact `继续` and confirm the typing indicator appears. Record complete visible
content, Activity order, duplicates, standalone notices, and truncation.

- [ ] **Step 4: Analyze diagnostics and record acceptance**

Verify FIFO request order, every response accepted, every request acknowledged,
the expected window distribution, no duplicate `client_id`, and an empty final
outbox. Update the acceptance document with both the original failed attempt
and successful retry, then commit only the implementation and evidence files.
