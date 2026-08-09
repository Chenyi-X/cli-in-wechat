# Long Task Delivery Acceptance

This record belongs to `codex/quota-management-v2`. Automated evidence is kept
separate from real-device evidence; a passing test suite is not a substitute for
seeing the complete response in WeChat.

## Automated Coverage

| Scenario | Evidence |
| --- | --- |
| 13 final chunks | `test/client-send.test.ts` sends 10, then 3 after the next inbound |
| 25 final chunks | `test/client-send.test.ts` sends 10, 10, then 5 |
| Exact ten / continuation bytes | `test/delivery-planner.test.ts` |
| Restart and frozen client ID | `test/outbox.test.ts`, `test/client-send.test.ts` |
| Confirmed-response crash journal and idempotent quota reconciliation | `test/outbox.test.ts`, `test/quota.test.ts`, `test/client-send.test.ts` |
| Restart after chunks 7 and 10 | `test/client-send.test.ts` |
| Legacy schema/current thirteen records | `test/outbox.test.ts` |
| Ambiguous and `ret=-2` classification | `test/client-send.test.ts`, `test/send-result.test.ts` |
| Same-inbound ambiguity gate and zero transport retries | `test/client-send.test.ts` |
| Activity reserve, configurable windows, and in-flight generation races | `test/client-send.test.ts`, `test/quota.test.ts`, `test/router.test.ts` |
| Torn primary/backup recovery and expired-failure requeue | `test/outbox.test.ts` |
| Duplicate inbound and two-user isolation | `test/quota.test.ts` |
| Exact `继续` routing and ordinary prompt preservation | `test/router.test.ts` |
| Real `processMessage` queue-aware `继续` routing with typing | `test/client-send.test.ts` |
| Full ten-slot streamed windows and terminal tenth record | `test/delivery-planner.test.ts`, `test/client-send.test.ts` |
| 3800-byte default and persisted-record rechunking without Activity merging | `test/client-send.test.ts`, `test/outbox.test.ts` |
| Rejected rate-limit boundary restores the unfrozen continuation suffix | `test/client-send.test.ts` |
| Redacted diagnostics and `/status` | `test/diagnostics.test.ts`, `test/router.test.ts` |

Latest automated run at `72d982b` on 2026-08-09: 222 tests, 220 passed,
2 expected Windows platform skips, 0 failed. Typecheck, build, focused 96-test
delivery/outbox suite, `git diff --check`, and independent final code review passed.

## Real-Device Gate

Status: final-build targeted text-delivery gate passed. PID 21144 is the only
active bridge poller at commit `72d982b`; outbox is empty. The historical
20-task soak matrix at the end of this file was never completed and is not
presented as evidence for this result.

### 2026-08-09 final-build targeted acceptance

Evidence prefix:
`C:\tmp\cli-in-wechat-v2-device-20260804-142952\v2-queue-aware-3800-20260809-173254`.
Before cutover, the live state was copied to
`state-before-e06e147-20260809-171736`; source and snapshot both contained 131
files and 9,916,039 bytes. PID 6236 was confirmed as the old
`node dist/index.js --debug` process with an empty outbox, stopped, and replaced
by PID 21144 from the V2 worktree. Startup loaded saved credentials without
migration or planner errors, the cursor advanced, and exactly one poller was
present.

The first exact `继续` arrived with an empty outbox as inbound generation 89.
It reached the Claude adapter (`resume=0e166034-06d5-450f-8993-be7098709012`)
instead of being consumed as a delivery command. The resulting normal-mode task
enqueued and delivered 8 records (7 intermediate, 1 final), in exact FIFO order,
with 8 unique item IDs and client IDs, 8 `ret=0` responses, and 8 acknowledgements.
The request range was 78-3742 UTF-8 bytes, directly exercising the raised
3800-byte device path.

A second normal-mode research task was generation 91. It delivered all 15
records (12 intermediate, 2 Activity, 1 final) across generation-91 and
generation-92 inbound windows as 9 + 6. The first window ended at the unresolved
stream boundary; the exact `继续` did not start a second Agent. All 15 item IDs
and client IDs were unique, all responses were `ret=0`, all were acknowledged,
and enqueue order exactly matched request order. The byte range was 26-2187.

The verbose-mode HTML research task was generation 96 and produced 46 durable
text records: 23 intermediate, 22 Activity, and 1 final. They were delivered in
five inbound windows as exactly `10 + 10 + 10 + 10 + 6` (generations 96-100).
All 46 item IDs and client IDs were unique; every item was requested exactly
once, received exactly one `ret=0`, and was acknowledged exactly once. The full
enqueue-ID sequence equals the full request-ID sequence, proving FIFO retention
across the four continuation windows. No `[claude]` start appears for the four
exact `继续` messages, including the final continuations sent after the Agent had
finished producing output, so queued delivery did not rerun the Agent. The user
confirmed that the final queued continuation displayed WeChat's typing indicator
and that the complete answer, every Activity block, and the final result were
visible in order. The outbox returned to zero.

Across all text delivery after final-build startup there were 83 requests, 83
unique item IDs, 83 unique client IDs, 83 responses with `ret=0`, and 83
acknowledgements. There were zero duplicate requests and zero nonzero text
responses; the measured request range was 9-3742 bytes. The user also confirmed
that device bubbles were visibly longer than under the old 2000-byte setting.

The verbose HTML task's first file send returned `prepare failed`; after the user
explicitly requested a resend, the same 25,078-byte HTML file uploaded and sent
successfully. This is recorded as a separate media-channel issue and does not
change the text FIFO result.

### Historical preserved-backlog evidence

Preflight candidate: `174c37e02bc701a7366125c2dbe63cf1e418b764`.
Evidence directory: `C:\tmp\cli-in-wechat-v2-device-20260804-142952`.
`candidate-commit.txt` intentionally pins the verified runtime-code commit;
subsequent branch commits modify acceptance documentation only. Before stopping
the old poller, Step 3 proves there is no non-documentation diff and records the
exact branch HEAD in `cutover-head.txt`.
The pre-stop snapshot contains 131 files and all guarded-file SHA-256 hashes
match the live directory. The user authorized cutover on 2026-08-04; PID 2176
was stopped and confirmed absent, and the post-stop snapshot contains 131 files.
V2 PID 12868 started from the isolated worktree at
`2026-08-04T14:45:55+08:00`. It is the only bridge poller, loaded the saved
credentials, and reported no startup or migration error. The user then sent
`new` and observed no response. PID 12868 was stopped, and the failure state is
preserved under `wx-ai-bridge-v2-failure`.

The first full-chunk fixed candidate `d122ce99e38a87bb0227a5718b844950962ee553`
started as PID 34356 at `2026-08-04T18:19:17+08:00`. It immediately reproduced
`continuation notice exceeds maxBytes`: the real 43-item snapshot placed 9
intermediate and 19 activity records before the 13 finals in the same generation,
so the legacy migration grouped all 41 records and rejected the non-final batch.
PID 34356 was stopped; `wx-ai-bridge-pre-fixed-start` and
`wx-ai-bridge-v2-fixed-attempt1-failure` preserve the before/after states and
`v2-fixed.stdout.log`, `v2-fixed.stderr.log`, and `v2-fixed.pid` preserve the
runtime evidence.

Candidate `f276b4c7850bc610e093197293e6f6be4270f90d` fixes the mixed-priority
boundary and transactionally applies the existing final supersession rule. Its
pre-start state is preserved under `wx-ai-bridge-pre-f276b4c-start`. PID 18628
started at `2026-08-04T18:50:10+08:00`; evidence is in `v2-f276b4c.stdout.log`,
`v2-f276b4c.stderr.log`, and `v2-f276b4c.pid`. Startup persisted schema 2
revision 4 with 16 total records: 13 generation-42 finals at
`1944 x 11, 1943, 817` UTF-8 bytes, zero old activity/intermediate, and one
record each for generations 46, 49, and 50. Primary and backup are identical,
PID 18628 is the only poller, and the startup logs contain no migration,
planner, corruption, or routing error. No recovery UI result has been counted
yet.

The preserved backlog was drained through two real inbound windows on PID
18628. Inbound message `7490380087112850000` (`继续`, generation 51) planned 10
items with 6 remaining. It made 10 unique generation-42 requests at
`1944 x 9, 2000` bytes; all 10 returned `ret=0` and were acknowledged. The
2000-byte tenth body is the 1944-byte frozen body plus the 56-byte attached
continuation suffix. No standalone notice request was emitted. Inbound message
`7490380207900346000` (`继续`, generation 52) planned the remaining 6 items and
made 6 unique requests at `1944, 1943, 817, 9, 445, 9` bytes: three old finals
and one item each from generations 49, 50, and 46. All returned `ret=0` and were
acknowledged. Across both windows there were 16 requests, 16 unique item IDs,
zero duplicate requests, and zero standalone notices; outbox primary and backup
are now identical empty snapshots at revision 43.

Inbound message `7490380332727047000` (`你好`, generation 53) then reached the
Claude adapter normally and produced one intermediate and one final confirmed
delivery. The two exact `继续` messages did not invoke the adapter, and no old
`/new` prompt was replayed. Post-recovery state, diagnostics, PID, cursor, quota,
and logs are preserved under `wx-ai-bridge-post-preserved-recovery`. The user
confirmed 10 old body bubbles in the first window, the attached continuation at
the end of the tenth, the remaining 3 old body bubbles in the second window,
zero duplicate bubbles, zero standalone continuation bubbles, and a normally
visible `你好` response. Preserved-backlog recovery therefore passes API,
durability, and real-device UI observation. It remains separate from the 20-run
matrix.

The initial `old-process.txt` capture serialized PowerShell formatting records
instead of process fields. The runbook now writes structured JSON, the still-live
PID 2176 metadata was recaptured and matched all five selected fields, and the
original malformed output is preserved as `old-process-formatting-error.txt`.

The isolated canary used the saved account/context without touching the live
bridge data. Its first response was ambiguous, the retry reused the same
persisted `client_id`, the second response confirmed delivery, and the final
isolated status had zero pending and zero permanent-failure items. This proves
the recovery protocol, not the visible WeChat bubble.

## Historical 20-Task Soak Matrix

This original matrix remains below as an honest historical plan. It was not
completed and is not used to claim the final-build targeted acceptance above.
The final-build gate instead uses the user-observed 46-record verbose task, two
normal tasks, the preserved restart run, and ID-level diagnostics.

- [ ] 20 long tasks total (historical soak only).
- [ ] compact, normal, and verbose: at least 5 tasks each (historical soak only).
- [x] At least one task over 10 chunks and one over 20 chunks.
- [x] Restart after the 7th or 10th confirmed chunk.
- [x] 100% complete final visibility for accepted targeted runs.
- [x] 0 duplicate visible bubbles for accepted targeted runs.
- [x] Continuation text is attached to the last body bubble in partial-window device evidence.
- [x] No independent continuation-notice `sendmessage` call.
- [x] Measured chunk sizes recorded: 9-3742 bytes; configured ceiling is now 3800 bytes.

| Run | Planned mode/profile | Actual chunks | Restart point | Complete | Duplicates | Continuation attached | Separate notice | Byte range | Device evidence | Notes |
| --- | --- | ---: | --- | --- | ---: | --- | ---: | --- | --- | --- |
| Preserved recovery | historical / >10 | 13 final (`10 + 3`) | fixed cutover before first `继续` | yes | 0 | yes, first window item 10 | 0 | 817-2000 | user-confirmed; `wx-ai-bridge-post-preserved-recovery` | Recovery gate passed; not counted in runs 1-20. |
| Canary | isolated API | 1 | ambiguity then retry | API only | 0 known | n/a | not observed | not UI measured | none | UI not independently observed. |
| 1 | compact / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 2 | compact / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 3 | compact / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 4 | compact / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 5 | compact / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 6 | compact / X (>10) | pending | none | pending | pending | pending | pending | pending | pending | |
| 7 | compact / XX (>20) | pending | after first 10 | pending | pending | pending | pending | pending | pending | Controlled V2 restart before first `继续`. |
| 8 | normal / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 9 | normal / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 10 | normal / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 11 | normal / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 12 | normal / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 13 | normal / X (>10) | pending | none | pending | pending | pending | pending | pending | pending | |
| 14 | normal / X (>10) | pending | none | pending | pending | pending | pending | pending | pending | |
| 15 | verbose / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 16 | verbose / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 17 | verbose / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 18 | verbose / L | pending | none | pending | pending | pending | pending | pending | pending | |
| 19 | verbose / X (>10) | pending | none | pending | pending | pending | pending | pending | pending | |
| 20 | verbose / XX (>20) | pending | none | pending | pending | pending | pending | pending | pending | |
