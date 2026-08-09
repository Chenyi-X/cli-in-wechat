# Durable FIFO Stream Delivery Design

**Date:** 2026-08-09

**Status:** Approved in the real-device acceptance thread

## Problem

Run 20 exposed a conflict between streaming and finalization. In normal and
verbose modes, answer text is queued as `intermediate`. When the final footer is
queued, the outbox treats that footer as authoritative and deletes unsent
same-generation `activity` and `intermediate` records. Run 20 queued fourteen
body chunks, sent nine, then deleted the remaining five when a 25-byte footer
arrived. Later `继续` messages were received correctly but found an empty queue.

The restart recovery path also sends pending content without a typing indicator.
This made the successful Run 7 recovery look unresponsive until bubbles arrived.

## Required Semantics

Every generated visible record is durable delivery history:

- Answer text, verbose Activity, normal-mode Activity summaries, control text,
  and final footers are persisted before network delivery.
- No final footer may delete, supersede, or jump ahead of an earlier record.
- Delivery order is the outbox `sequence` order. Priority may reserve one live
  streaming slot so a future record remains discoverable, but it never permits
  deletion or reordering.
- Each inbound window sends at most ten records. If records remain, the final
  record in that window carries the continuation suffix.
- `继续` resumes at the first unsent sequence after a restart or ordinary pause.
  It never reruns the Agent prompt.
- A continuation with pending records starts typing before recovery and stops
  typing after recovery. An empty continuation remains a consumed no-op.
- Confirmed records are acknowledged only after an accepted iLink response;
  ambiguous records retain their frozen payload and `client_id`.

## Mode Behavior

### Compact

Compact continues to send the completed answer without Activity records. Long
answers are chunked, persisted, and resumed in FIFO order.

### Normal

Answer text may stream first. Tool activity is retained and emitted as the
existing consolidated Activity block near finalization. The Activity block and
footer are queued after earlier answer chunks and cannot remove them.

### Verbose

Answer and Activity records are enqueued in the order emitted by the adapter.
That sequence is preserved across quota windows and process restarts, so the
phone shows an execution log rather than a priority-reordered summary.

## Component Changes

### Delivery planner

`planDeliveryWindow` selects the pending FIFO prefix and never scans past a
blocked head record. Live Activity/intermediate records retain the nine-item
sub-window so the ninth record can carry a continuation notice before a later
footer exists. A final record may use the tenth slot only when it is already the
FIFO head; it cannot jump over a queued stream record.

### Quota manager

Reservations retain the one-slot live-stream holdback and byte reserve. These
limits provide a visible continuation boundary; they do not authorize priority
reordering or deletion. Persisted schema fields remain backward compatible.

### Outbox

Final enqueue no longer calls `removeSuperseded`. `supersedeIntermediate` is no
longer part of live delivery. Capacity enforcement must not evict queued
Activity or intermediate records; a capacity failure is atomic and explicit.
Legacy migration rechunks invalid oversized records without deleting other
valid queued records.

### Router

Exact `继续` checks whether pending records exist. When they do, the router wraps
`recoverPending` with the existing typing API and always stops typing in a
`finally` block. Ordinary prompts retain the existing recover-before-execute
behavior.

## Failure Handling

Network and acknowledgement rules remain unchanged. A send failure stops the
current FIFO window, and an ambiguous outcome preserves the current record and
blocks later records. Capacity errors never mutate the existing queue and are
surfaced rather than resolved by deleting history.

## Verification

Automated coverage must prove:

- mixed Activity, streamed answer, and footer records are delivered by sequence;
- a fourteen-chunk streamed body plus footer drains as `9 + 6` without loss;
- final enqueue preserves pending same-generation Activity and answer chunks;
- normal consolidated Activity remains queued behind earlier answer chunks;
- continuation starts and stops typing only when pending records exist;
- restart recovery preserves payloads, client IDs, order, and continuation text;
- all existing typecheck, test, and build commands pass.

After automated verification, restart the single acceptance poller from the new
build and rerun only Run 20. The retry must show every body and Activity record,
typing during each continuation, no duplicates, and an empty outbox at the end.
