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
| Legacy schema/current thirteen records | `test/outbox.test.ts` |
| Ambiguous and `ret=-2` classification | `test/client-send.test.ts`, `test/send-result.test.ts` |
| Duplicate inbound and two-user isolation | `test/quota.test.ts` |
| Exact `继续` routing and ordinary prompt preservation | `test/router.test.ts` |
| Redacted diagnostics and `/status` | `test/diagnostics.test.ts`, `test/router.test.ts` |

## Real-Device Gate

Status: pending real WeChat run.

- [ ] 20 long tasks total.
- [ ] compact, normal, and verbose: at least 5 tasks each.
- [ ] At least one task over 10 chunks and one over 20 chunks.
- [ ] Restart after the 7th or 10th confirmed chunk.
- [ ] 100% complete final visibility.
- [ ] 0 duplicate visible bubbles.
- [ ] Continuation text is attached to the last body bubble in every partial window.
- [ ] No independent continuation-notice `sendmessage` call.
- [ ] Measured chunk sizes recorded; keep the 2000-byte threshold until 1800-4500-byte behavior is observed.

| Run | Mode | Chunks | Restart point | Complete | Duplicates | Notes |
| --- | --- | ---: | ---: | --- | ---: | --- |
| 1-20 | pending | - | - | - | - | Fill from the real-device log. |

