# Full-Window Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver queued output in strict ten-message FIFO windows at a 3,800-byte ceiling while making exact `继续` queue-aware and visibly typed.

**Architecture:** Keep durable queueing and acknowledgement unchanged. Move recovery ownership from pre-routing client code to the router, let the planner defer only an unresolved tenth streaming record, and pass the configured UTF-8 body ceiling into the iLink client.

**Tech Stack:** TypeScript, Node.js, `node:test`, persisted outbox/quota JSON, iLink send and typing APIs.

---

### Task 1: Make exact continuation queue-aware end to end

**Files:**
- Modify: `test/router.test.ts`
- Modify: `test/client-send.test.ts`
- Modify: `src/ilink/client.ts`
- Modify: `src/bridge/router.ts`

- [ ] **Step 1: Write failing routing tests**

Change the empty-queue router test so exact `继续` must reach `router.exec` as the
unchanged prompt. Add an integration test that registers a real `Router` handler
on a real `ILinkClient`, preloads one pending record, invokes private
`processMessage()` with exact `继续`, and asserts:

```ts
assert.deepEqual(events, ['typing:start', 'send:pending-1', 'typing:stop']);
assert.equal(execCalled, false);
```

The same fixture with no pending records must call the Agent with `继续` and must
not start delivery typing.

- [ ] **Step 2: Run the red tests**

```powershell
node --import tsx --test test/router.test.ts test/client-send.test.ts
```

Expected: the empty-queue assertion fails because the command is swallowed, and
the integrated typing assertion fails because `processMessage()` drains the queue
before router dispatch.

- [ ] **Step 3: Move recovery ownership to the router**

Remove the unconditional `deliverPendingNow()` block from
`ILinkClient.processMessage()`. In `Router.handle()`, use this decision:

```ts
if (trimmed === '继续' && deliveryStatus?.pending.length) {
  const stopTyping = await this.ilink.startTyping(uid);
  try { await recoverPending?.call(this.ilink, uid); }
  finally { stopTyping(); }
  return;
}

if (recoverPending) await recoverPending.call(this.ilink, uid);
// Continue normal routing, including exact `继续` when the queue was empty.
```

- [ ] **Step 4: Verify and commit**

```powershell
node --import tsx --test test/router.test.ts test/client-send.test.ts
git add src/ilink/client.ts src/bridge/router.ts test/router.test.ts test/client-send.test.ts
git commit -m "fix: route continuation by pending queue state"
```

### Task 2: Use all ten FIFO slots without losing the boundary notice

**Files:**
- Modify: `test/delivery-planner.test.ts`
- Modify: `test/quota.test.ts`
- Modify: `test/client-send.test.ts`
- Modify: `src/ilink/delivery-planner.ts`
- Modify: `src/ilink/quota.ts`
- Modify: `src/ilink/client.ts`

- [ ] **Step 1: Write failing full-window tests**

Add planner and client tests for these exact sequences:

```text
9 Activity + final            -> 10 now, 0 pending, no notice
10 Activity + final           -> 10 now, final pending, notice on Activity 10
11 Activity + final           -> 10 now, 2 pending, notice on Activity 10
Activity 1..9 + final + body  -> Activity 1..9 + final, body pending (FIFO)
```

Also assert that a lone tenth Activity is held until a later record proves whether
it is a boundary, while the maximum confirmed count remains ten.

- [ ] **Step 2: Run the red tests**

```powershell
node --import tsx --test test/delivery-planner.test.ts test/quota.test.ts test/client-send.test.ts
```

Expected: defaults stop at nine streamed records, and mixed priorities can let a
later final consume slot ten without resolving the streaming boundary correctly.

- [ ] **Step 3: Implement the tenth-record lookahead**

Select only the FIFO prefix up to the global remaining item count. If that prefix
exactly fills the window, no later item is currently known, and its last record is
`activity` or `intermediate`, hold that last record. Once another record is queued,
send the held record as item ten with the attached suffix. A terminal `final`
record may fill item ten immediately when no record remains.

Remove per-priority item reservation from the default quota decision so all
priorities share the strict global ten-item cap. Do not change outbox order,
capacity, byte reserve, stable client IDs, or acknowledgement behavior.

- [ ] **Step 4: Verify and commit**

```powershell
node --import tsx --test test/delivery-planner.test.ts test/quota.test.ts test/client-send.test.ts
git add src/ilink/delivery-planner.ts src/ilink/quota.ts src/ilink/client.ts test/delivery-planner.test.ts test/quota.test.ts test/client-send.test.ts
git commit -m "fix: use full ten-message delivery windows"
```

### Task 3: Raise the configured UTF-8 body ceiling to 3,800 bytes

**Files:**
- Modify: `test/text-chunk.test.ts`
- Modify: `test/client-send.test.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/ilink/client.ts`
- Modify: `src/cli/send.ts`

- [ ] **Step 1: Write failing byte-boundary tests**

Assert that the default bridge configuration is 3,800, Chinese and emoji payloads
are split by UTF-8 bytes, and every iLink request including an attached continuation
suffix is at most 3,800 bytes. Assert at least one generated body is greater than
2,000 bytes so the test proves the new limit is used.

- [ ] **Step 2: Run the red tests**

```powershell
node --import tsx --test test/text-chunk.test.ts test/client-send.test.ts
```

Expected: requests remain capped at 2,000 bytes and the default config assertion
reports 2,000 instead of 3,800.

- [ ] **Step 3: Use one configured byte limit**

Set `DEFAULT_CONFIG.maxResponseChunkSize` to `3_800`, pass it from `src/index.ts`
as `ILinkClientOptions.maxTextBytes`, and derive each client instance's body chunk
size by subtracting the continuation suffix bytes. Use the instance limit in both
chunking and planner validation. Update the standalone send command to use
`chunkUtf8Text()` with the same 3,800-byte default instead of JavaScript string
length.

- [ ] **Step 4: Verify and commit**

```powershell
node --import tsx --test test/text-chunk.test.ts test/client-send.test.ts
npm run typecheck
git add src/config.ts src/index.ts src/ilink/client.ts src/cli/send.ts test/text-chunk.test.ts test/client-send.test.ts
git commit -m "feat: raise ilink text bodies to 3800 bytes"
```

### Task 4: Full verification and real-device cutover

**Files:**
- Modify after device evidence: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Run complete automated verification**

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 2: Snapshot and restart only the active poller**

Snapshot `C:\Users\35952\.wx-ai-bridge`, stop only the PID in the active
`v2-fifo-run20-retry-*.pid` file, start the rebuilt worktree with unique logs,
and verify one poller plus an unchanged outbox.

- [ ] **Step 3: Run one mixed Activity/answer continuation check**

Use a normal-mode task that emits at least eleven Activity/answer/footer records.
At each boundary send exact `继续`; verify ten visible messages per full window,
typing during every queued continuation, strict FIFO order, no duplicate or
missing bubble, and a final empty outbox. Then send exact `继续` with the empty
queue and verify it reaches the Agent as an ordinary prompt.

- [ ] **Step 4: Record evidence**

Update the acceptance record with request byte ranges, window counts, `ret`
values, acknowledgements, unique client IDs, typing observation, and the
queue-aware empty-queue result.
