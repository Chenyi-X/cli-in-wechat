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
| Redacted diagnostics and `/status` | `test/diagnostics.test.ts`, `test/router.test.ts` |

Latest automated run at `f276b4c7850bc610e093197293e6f6be4270f90d`:
212 tests, 210 passed, 2 expected platform skips, 0 failed; isolated
`USERPROFILE` live-state guards, typecheck, build, and diff checks passed.

## Real-Device Gate

Status: fixed V2 poller PID 18628 active; preserved backlog migrated; exact
`继续` recovery and real-device UI runs remain 0/20.

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

The initial `old-process.txt` capture serialized PowerShell formatting records
instead of process fields. The runbook now writes structured JSON, the still-live
PID 2176 metadata was recaptured and matched all five selected fields, and the
original malformed output is preserved as `old-process-formatting-error.txt`.

The isolated canary used the saved account/context without touching the live
bridge data. Its first response was ambiguous, the retry reused the same
persisted `client_id`, the second response confirmed delivery, and the final
isolated status had zero pending and zero permanent-failure items. This proves
the recovery protocol, not the visible WeChat bubble.

- [ ] 20 long tasks total.
- [ ] compact, normal, and verbose: at least 5 tasks each.
- [ ] At least one task over 10 chunks and one over 20 chunks.
- [ ] Restart after the 7th or 10th confirmed chunk.
- [ ] 100% complete final visibility.
- [ ] 0 duplicate visible bubbles.
- [ ] Continuation text is attached to the last body bubble in every partial window.
- [ ] No independent continuation-notice `sendmessage` call.
- [ ] Measured chunk sizes recorded; keep the 2000-byte threshold until 1800-4500-byte behavior is observed.

| Run | Planned mode/profile | Actual chunks | Restart point | Complete | Duplicates | Continuation attached | Separate notice | Byte range | Device evidence | Notes |
| --- | --- | ---: | --- | --- | ---: | --- | ---: | --- | --- | --- |
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
