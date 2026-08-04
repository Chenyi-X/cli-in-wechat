# Legacy Full-Size Outbox Migration Design

**Date:** 2026-08-04
**Status:** User approved

## Context

The first real-device command after the V2 cutover exposed a migration gap. The
schema-1 outbox contains one final batch with 13 pending chunks: twelve chunks
are exactly 2000 UTF-8 bytes and the last is 144 bytes. V2 correctly limits a
sendmessage body to 2000 bytes, but a partial delivery window must append the
56-byte continuation suffix to its final body bubble. The tenth legacy chunk
therefore cannot carry the suffix, and `planDeliveryWindow()` throws before any
of the old final chunks or the command response is sent.

The failure evidence is preserved in
`C:\tmp\cli-in-wechat-v2-device-20260804-142952\wx-ai-bridge-v2-failure`.
The failed V2 poller is stopped. Neither the live outbox nor any saved snapshot
will be manually cleared or restored.

## Goals

- Migrate eligible schema-1 final batches to the existing V2 body-chunk limit
  before the first V2 delivery plan.
- Preserve the concatenated UTF-8 text byte-for-byte and preserve FIFO order.
- Keep every migrated body chunk at or below 1944 bytes so the 56-byte suffix
  can be attached without exceeding the 2000-byte send limit.
- Persist the complete migrated snapshot atomically before network I/O.
- Leave schema-2 payloads and any legacy record carrying delivery-recovery state
  unchanged.
- Recover the already queued `/new` confirmation without deleting or replaying
  the inbound command.

## Non-Goals

- Raising the 2000-byte send threshold.
- Sending the continuation notice as an independent bubble.
- Re-executing the `/new` command or any interrupted agent prompt.
- Rewriting acknowledged, ambiguous, or schema-2 payloads.
- Restoring an older cursor, quota snapshot, or outbox snapshot.

## Chosen Design

### Configuration Boundary

`ILinkClient` already owns `MAX_TEXT_BYTES`, `CONTINUATION_SUFFIX`, and
`BODY_CHUNK_BYTES`. It will pass the existing `BODY_CHUNK_BYTES` value and the
configured inbound item limit to `OutboxStore`. The outbox remains independent
of WeChat-specific strings and receives only numeric migration limits.

### Eligibility

Normalization runs only while loading a snapshot whose top-level
`schemaVersion` is not 2. A batch is eligible when all of these conditions hold:

- records are consecutive in sequence order;
- `priority` is `final` and `state` is `pending`;
- `accountId`, `userId`, `generation`, and `tokenVersion` are identical;
- no record has `deliveryReceipt`, `recoveryRequired`, or
  `continuationNoticeAttached`;
- the batch is larger than the inbound item limit; and
- at least one body exceeds the migration body-chunk limit.

These constraints target the atomic schema-1 backlog that V2 was created to
recover. Under the schema-1 client, a final batch larger than the inbound limit
was rejected as a whole before network I/O; the saved diagnostics likewise show
the current batch only as queued. The recovery-state exclusions prevent the
migration from changing payloads that carry evidence of a later send attempt.

### Transactional Transformation

For each eligible batch:

1. Concatenate record text in sequence order with no inserted separator.
2. Split the concatenated text with the existing UTF-8-aware chunking rule at
   `BODY_CHUNK_BYTES`.
3. Verify that joining the replacement chunks reproduces the original text
   exactly and that every replacement chunk is within the byte limit.
4. Reuse existing `itemId`, `clientId`, creation time, expiry, account, user,
   generation, token version, and priority positionally for as many replacement
   chunks as possible.
5. If more chunks are required, create durable IDs for the additional unsent
   chunks. If fewer are required, remove only the unused unsent legacy records.
6. Splice the replacement records into the original global queue position,
   renumber sequence values monotonically without changing relative order, and
   retain a `nextSequence` greater than every assigned sequence.
7. Persist the complete schema-2 snapshot through the existing backup-then-
   primary atomic write before publishing it in memory.

The current 24,144-byte batch becomes 13 chunks (eleven at 1944 bytes, one at
1943 bytes, and one at 817 bytes), so all 13 existing item and client identities
are reused.

### Failure Handling

Migration validates its numeric limits and round-trip invariant before
persistence. An invalid limit or failed invariant raises an explicit migration
error during startup. The bridge must not poll or send in that state. The saved
failure and post-stop snapshots remain the recovery authority; no automatic
snapshot restoration is attempted.

### Runtime Flow After the Fix

On the first fixed startup, `OutboxStore` migrates schema 1 to schema 2 and
persists the normalized batch before polling. The already handled `/new` command
response remains queued behind the older final batch. A fresh exact `继续`
message opens a new quota window: V2 sends the first ten old final chunks, with
the notice attached to chunk ten. Further `继续` messages drain the remaining
old chunks and then the queued command response without re-running `/new`.

## Test Design

### Outbox Regression

Create a schema-1 fixture matching the observed shape: twelve 2000-byte ASCII
chunks plus one 144-byte chunk in a 13-item final batch. Assert that:

- the new regression test first fails against the current implementation because
  the migrated tenth item cannot carry the suffix in the planner;
- migration produces schema 2 with 13 final records;
- concatenated text is byte-for-byte identical;
- every migrated chunk is at most 1944 UTF-8 bytes;
- original item and client IDs remain in order;
- primary and backup snapshots contain the same migrated revision; and
- reloading the migrated snapshot is idempotent.

Add focused cases proving that schema-2 records, non-final records, separate
generations, and records with receipt or recovery state are not coalesced.

### Client Regression

Load the real-shaped fixture through `ILinkClient`, open one fresh inbound
window, and assert that ten requests are made, the tenth body ends with the
continuation notice, no request exceeds 2000 bytes, the remaining queue stays
durable, and no standalone notice request is made.

### Verification

Run the focused planner, outbox, and client tests first, then run
`npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`. After
all checks pass, start exactly one fixed V2 poller from the isolated worktree and
resume real-device acceptance with the existing evidence directory.
