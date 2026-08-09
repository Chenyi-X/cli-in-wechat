# Full-Window Continuation Design

## Goal

Use the full ten-message iLink inbound window, raise the text body ceiling to
3,800 UTF-8 bytes, and make queued continuation visibly type before delivery
without rerunning the Agent or losing any queued record.

## Confirmed Failure

Generation 86 did not lose data. Its final continuation sent two remaining
answer chunks, four Activity chunks, and the footer; all seven requests returned
`ret=0` and were acknowledged. The device eventually displayed them. The user
mistook the delayed delivery for loss because no typing indicator appeared.

The missing indicator is caused by `ILinkClient.processMessage()` recovering the
outbox before parsing and dispatching the inbound text. By the time `BridgeRouter`
sees exact `继续` text, the pending queue is empty, so its typing wrapper is
bypassed. A router-only unit test did not exercise this production path.

## Delivery Limits

- `MAX_TEXT_BYTES` becomes 3,800 UTF-8 bytes. This is a byte limit, not a
  JavaScript character count.
- Every body is initially chunked below 3,800 bytes by the exact UTF-8 byte size
  of the continuation suffix. A boundary body plus the suffix is therefore at
  most 3,800 bytes.
- Every inbound window may confirm at most ten messages, regardless of priority.
- The outbox remains strict FIFO by persisted `sequence`; priority cannot reorder,
  skip, delete, or supersede a record.

## Full Ten-Slot Streaming Rule

The first nine records may stream immediately. When only the tenth slot remains:

1. A lone Activity or intermediate record is held briefly because the planner
   cannot yet know whether it is the final record or a boundary record.
2. When another record arrives, the held record becomes the tenth message and is
   sent with the attached continuation suffix. Later records stay queued.
3. When a terminal final record is the only pending tenth record, it is sent
   without a suffix because the queue is complete.
4. If fewer than ten messages complete the task, all are sent without an
   unnecessary continuation suffix.

This uses all ten iLink slots while preserving a visible continuation instruction.
It also fixes the mixed-priority case: a later final may prove that a preceding
stream record is a boundary, but it may never overtake that record.

## Inbound Ownership

`ILinkClient.processMessage()` continues to deduplicate the inbound message,
record the new quota generation, persist its context token, and parse it. It no
longer drains pending output before dispatch.

`BridgeRouter` owns recovery after text is known:

- Exact trimmed `继续` text with pending records performs
  `startTyping -> recoverPending -> stopTyping`, consumes the command, and never
  invokes an Agent.
- Exact `继续` text with an empty queue is consumed without typing or Agent
  execution.
- Every other fresh inbound first recovers pending FIFO records and then continues
  through normal command or Agent routing.

## Tests

- Add an end-to-end inbound test through `ILinkClient.processMessage()` and the
  real router handler proving typing wraps recovery and the Agent is not invoked.
- Add planner tests for nine streamed records followed by final, ten streamed
  records followed by final, and eleven streamed records. Assert ten-message
  windows, FIFO order, and suffix placement on record ten.
- Update client integration and UTF-8 assertions from 2,000 to 3,800 bytes,
  including Chinese and emoji boundaries.
- Run focused red/green tests, then the complete test suite, typecheck, build, and
  a real-device Activity-plus-answer continuation check.

## Non-Goals

- No adaptive rechunking after an ambiguous send.
- No independent continuation-notice message.
- No changes to outbox capacity, stable client IDs, or acknowledgement rules.
- No retry based solely on delayed device rendering after `ret=0`.
