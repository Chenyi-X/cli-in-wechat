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

Latest automated run: 151 tests, 149 passed, 2 expected platform skips; typecheck and build passed.

## Real-Device Gate

Status: partial API evidence; UI observation and the 20-run gate remain pending.

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
