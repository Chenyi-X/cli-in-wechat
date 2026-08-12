# Long Task Delivery and Mainline Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the local mainline from the current upstream baseline, preserve the valuable local behavior, and make long WeChat tasks observable and recoverable so final text is not silently lost.

**Architecture:** The rebuilt branch uses `upstream/main` as its code baseline and keeps private deployment behavior on the fork. The iLink client remains responsible for transport and token updates; a quota coordinator owns per-user generations, reservations, and structured send outcomes; a file-backed outbox owns durable ordering, deduplication, TTL, and crash recovery; the router owns task state and gated continuation handling.

**Tech Stack:** TypeScript, Node.js built-in test runner, `fetch`, atomic JSON writes, existing iLink/media/adapters APIs.

---

### Task 1: Protect the dirty repository and rebuild the mainline

**Files:**
- Git refs only: `codex/backup-*`, `codex/rebuild-main`
- Preserve existing `.gitignore` edit containing `.wx-media/`

- [x] Record current branch, dirty files, remotes, stash commits, and the absence of a merge base.
- [x] Create dated backup refs for old `main`, the current feature branch, and all three stash commits.
- [x] Fetch `upstream` and create `codex/rebuild-main` from `upstream/main` in an isolated worktree.
- [x] Apply the `.wx-media/` ignore rule to the rebuilt tree and commit it separately.
- [x] Keep the old refs until at least two stable validation cycles have completed.

Current evidence: the rebuilt baseline has no direct merge with unrelated upstream
history; `main` tracks `origin/main`, `remote.pushDefault=origin`, `pull.ff=only`,
and `upstream` has a disabled push URL. Four preserved stash entries and dated
backup refs remain available in the repository.

### Task 2: Migrate local behavior that upstream has not absorbed

**Files:**
- Modify: `src/adapters/base.ts`
- Modify: `src/bridge/router.ts`
- Test: `test/router.test.ts`

- [x] Add failing tests proving a fresh session defaults to `maxTurns: 100` and `/reset` restores 100.
- [x] Run `npm test` and verify those assertions fail against upstream's 30-turn defaults.
- [x] Change only the default and reset values to 100; retain upstream's adapter, network, media, and model handling.
- [x] Run the focused test, typecheck, build, and complete test suite.

### Task 3: Define durable send outcomes and UTF-8 text chunks

**Files:**
- Modify: `src/ilink/types.ts`
- Create: `src/ilink/send-result.ts`
- Create: `src/ilink/text-chunk.ts`
- Tests: `test/send-result.test.ts`, `test/text-chunk.test.ts`

The send layer will expose stable outcomes instead of `void`:

```ts
export type SendStatus =
  | 'sent' | 'queued' | 'waiting-for-token' | 'suppressed'
  | 'rate-limited' | 'permanent-failure';

export interface SendResult {
  status: SendStatus;
  itemId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  attemptedBytes: number;
  error?: { ret?: number; errcode?: number; errmsg?: string; httpStatus?: number };
}
```

- [x] Test UTF-8 byte limits for Chinese, emoji, Markdown, and code blocks without splitting surrogate pairs or emitting empty chunks.
- [x] Test stable item IDs and preservation of `ret`, `errcode`, and `errmsg`.
- [x] Implement the smallest pure helpers first, then reuse them from the client/outbox.

### Task 4: Implement quota generations and final-result reservations

**Files:**
- Create: `src/ilink/quota.ts`
- Modify: `src/ilink/client.ts`
- Tests: `test/quota.test.ts`, `test/client-internals.test.ts`

The quota key is `(accountId, userId)`; each inbound message increments `inboundGeneration` after deduplication, while a token change increments `tokenVersion`. Repeated polls, restarts, and re-reading the same token do not reset a budget. Every text and media request reserves budget before sending, but only a confirmed `sendmessage ret=0` increments the local sent counter. Final-result capacity is reserved before intermediate activity is accepted.

- [x] Add failing tests for generation stability, token-version changes, final reservation, and media counting.
- [x] Implement `QuotaManager` with explicit configurable limits and no claims that 10 messages, 24 hours, or 4000 bytes are protocol constants.
- [x] Classify `ret=-2` as ambiguous, preserve the complete structured error, stop high-frequency retries, and default to queue/wait for a new inbound message.
- [x] Keep transport retries in `fetchWithRetry`; application-level `ret=-2` handling lives only in the quota/send coordinator.

### Task 5: Implement the durable text outbox

**Files:**
- Create: `src/ilink/outbox.ts`
- Modify: `src/config.ts`, `src/ilink/client.ts`
- Tests: `test/outbox.test.ts`, `test/client-internals.test.ts`

The outbox is an atomically written, schema-versioned JSON store under the existing data directory. Items have stable IDs, priority, creation time, TTL, UTF-8 byte accounting, user/generation/token metadata, and a terminal state. Priority is final result, control/error, media, intermediate text, then tool activity. Successful delivery deletes the item; restart reloads it; expired or superseded intermediate items are discarded before final results.

- [x] Test atomic enqueue/dequeue/ack, deterministic ordering, duplicate acknowledgement, TTL, per-user item/byte caps, and recovery after a truncated temp write.
- [x] Test that a final result reserves space and that a media caption is not acknowledged independently from its media item.
- [x] Implement `OutboxStore` with atomic writes through `atomicWrite`, schema validation, and bounded sensitive-content retention.
- [x] Wire text sends through the outbox while preserving existing media upload behavior and making media failures visible.

### Task 6: Gate continuation and route recovery through the router

**Files:**
- Modify: `src/bridge/router.ts`, `src/ilink/client.ts`
- Tests: `test/router.test.ts`, `test/outbox.test.ts`

- [x] Add failing tests showing that plain `继续` is intercepted only when the user is waiting and has queued work; otherwise it reaches the normal Agent path. Preserve `/continue` as the existing session-recovery alias.
- [x] Track `READY`, `SENDING`, `WAITING_INBOUND`, `RATE_BACKOFF`, and `PERMANENT_FAILURE` per user/task.
- [x] On a new deduplicated inbound message, update the generation, refresh the usable context token, and drain queued text in priority order without re-sending acknowledged items.
- [x] Append a continuation notice only while the failed item remains queued; remove the associated notice once the item is confirmed so stale warnings are never sent.
- [x] Await asynchronous route handlers before completing an inbound receipt; rethrow handler failures so the poll cursor and durable inbound receipt remain replayable.

### Task 7: Verify and prepare the dual-remote workflow

**Files:**
- Modify: `.gitignore`, remote/local Git config as needed
- Tests/build: all project files

- [x] Run typecheck, build, all tests, and inspect the complete diff against `upstream/main`.
- [x] Set rebuilt local `main` to track `origin/main`, set `remote.pushDefault=origin`, and keep `upstream` fetch/PR-only.
- [x] Push backup refs before any force-with-lease update when credentials permit.
- [x] Replace local `main` only after validation and update `origin/main` with `git push --force-with-lease origin main`, never bare `--force`.
- [x] For upstream work, branch from fresh `upstream/main`; for local deployment features, branch from `origin/main`.

### Task 8: Real-device acceptance experiment

**Evidence:** WeChat client display, captured structured API responses, and redacted logs.

- [ ] Test 1-15 sends, 0/0.5/1/2/5/10 second intervals, one request with multiple items, same/different users, same/new token, before/after inbound, restart, and cross-day behavior.
- [ ] Test 1800/2000/2048/3000/3500/4000/4500 UTF-8 bytes with Chinese, English, emoji, Markdown, and code blocks.
- [ ] Record timestamp, redacted user ID, token hash, inbound generation, token version, client ID, request/item/bubble sequence, JS length, UTF-8 bytes, full response, and actual WeChat visibility.
- [ ] Accept only when at least 20 long tasks run, each mode has at least 5, final delivery is 100%, duplicates are 0, restart recovery works, and all media failures are visible.

Current evidence: automated coverage is green at 188 tests, with 186 passing and
2 platform-specific skips; the real-device run record remains `0 / 20`.

### Task 9: Prevent multiple bridge instances

**Files:**
- Create: `src/utils/single-instance.ts`
- Modify: `src/index.ts`
- Test: `test/single-instance.test.ts`

- [x] Reject a second bridge process while the recorded owner PID is alive.
- [x] Reclaim a lock left by a dead process and release it during every shutdown path.
- [x] Keep the lock scoped to bridge mode so the one-shot `send` subcommand is unaffected.
