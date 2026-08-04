# Quota Management V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver long WeChat responses through durable, quota-aware windows that resume after new inbound messages or process restarts without duplicate visible chunks.

**Architecture:** A pure delivery planner selects a FIFO prefix within the current inbound budget and appends the continuation notice to the final body chunk when needed. A durable outbox freezes each payload and client ID before network I/O; a persisted quota manager tracks per-user inbound windows, token versions, and confirmed sends. `ILinkClient` serializes network delivery around those modules, while `Router` consumes only the exact `继续` command for recovery and leaves ordinary prompts intact.

**Tech Stack:** TypeScript, Node `node:test`, JSON snapshots written with the existing atomic file helper, UTF-8 byte accounting.

---

### Task 1: Add the failing cross-window planner test

**Files:**
- Create: `test/delivery-planner.test.ts`
- Create: `src/ilink/delivery-planner.ts` (introduced only as the missing import target)

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDeliveryWindow } from '../src/ilink/delivery-planner.js';

test('plans thirteen final chunks as ten now and three later', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({
    itemId: `item-${index + 1}`,
    text: `chunk-${index + 1}`,
    priority: 'final' as const,
    bytes: Buffer.byteLength(`chunk-${index + 1}`, 'utf8'),
  }));

  const first = planDeliveryWindow(items, { sentItems: 0, maxItems: 10, continuationNotice: '后续内容已排队，请回复“继续”续发。' });
  assert.deepEqual(first.items.map(item => item.itemId), Array.from({ length: 10 }, (_, i) => `item-${i + 1}`));
  assert.equal(first.items.at(-1)?.text.endsWith('后续内容已排队，请回复“继续”续发。'), true);
  assert.equal(first.remainingItems, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/delivery-planner.test.ts`

Expected: FAIL because `planDeliveryWindow` does not exist.

- [ ] **Step 3: Commit the red test**

```powershell
git add test/delivery-planner.test.ts
git commit -m "test: specify cross-window final delivery"
```

### Task 2: Implement the pure delivery planner

**Files:**
- Modify: `src/ilink/delivery-planner.ts`
- Modify: `test/delivery-planner.test.ts`

- [ ] **Step 1: Add the planner contract and edge-case tests**

Cover 1, 9, 10, 11, 20, 25 items; exact ten with no notice; continuation notice byte limits; priority ordering; and no empty windows.

- [ ] **Step 2: Implement the minimal pure function**

Define `DeliveryItem`, `DeliveryWindow`, and `planDeliveryWindow(items, { sentItems, maxItems, maxBytes, continuationNotice })`. Select the ordered prefix with `Math.min(maxItems - sentItems, items.length)`, reserve notice bytes while fitting the last selected text, and return `remainingItems` plus `needsContinuation` without mutating inputs.

- [ ] **Step 3: Run the focused tests**

Run: `node --import tsx --test test/delivery-planner.test.ts`

Expected: all planner tests pass.

- [ ] **Step 4: Commit**

```powershell
git add src/ilink/delivery-planner.ts test/delivery-planner.test.ts
git commit -m "feat: add quota-aware delivery planner"
```

### Task 3: Add durable outbox persistence and migration

**Files:**
- Create: `src/ilink/outbox.ts`
- Create: `test/outbox.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Specify frozen `text`, stable `clientId`, sequence ordering, `ack` only after confirmed success, restart reload, backup recovery, capacity protection for final items, final superseding same-generation activity/intermediate, and migration of the legacy array/object shape including the current thirteen final records.

- [ ] **Step 2: Implement the store**

Persist schema version 2 records with `{ itemId, clientId, sequence, userId, generation, tokenVersion, priority, text, bytes, state }`; write backup then primary atomically; keep pending and permanent-failure records; provide `enqueue`, `listPending`, `ack`, `markAmbiguous`, `markPermanentFailure`, `supersedeIntermediate`, and `migrateLegacy`.

- [ ] **Step 3: Run tests and commit**

Run: `node --import tsx --test test/outbox.test.ts`

```powershell
git add src/ilink/outbox.ts test/outbox.test.ts
git commit -m "feat: persist frozen delivery outbox"
```

### Task 4: Persist per-user quota windows

**Files:**
- Create: `src/ilink/quota.ts`
- Create: `test/quota.test.ts`

- [ ] **Step 1: Write failing quota tests**

Cover a default ten-item inbound window, confirmed-send increments only, duplicate inbound IDs, restart without resetting budget, token changes opening a fresh budget only on a real inbound, two-user isolation, and rate-backoff state.

- [ ] **Step 2: Implement `QuotaManager`**

Persist per-user `{ inboundGeneration, tokenVersion, seenInboundIds, sentItems, rateBackoffUntil }`; expose `recordInbound`, `confirmSend`, `remaining`, `markRateBackoff`, `canOpenWindow`, and `snapshot`. Do not reset on timers, poll replays, or process construction.

- [ ] **Step 3: Run tests and commit**

Run: `node --import tsx --test test/quota.test.ts`

```powershell
git add src/ilink/quota.ts test/quota.test.ts
git commit -m "feat: persist per-user inbound quotas"
```

### Task 5: Integrate outbox, planner, and single-owner send errors into the client

**Files:**
- Modify: `src/ilink/client.ts`
- Modify: `src/ilink/send-result.ts`
- Modify: `src/ilink/types.ts`
- Modify: `test/client-send.test.ts`
- Modify: `test/client-internals.test.ts`

- [ ] **Step 1: Add failing client tests**

Assert 25 final chunks drain as `25 -> 15 -> 5 -> 0` across three distinct inbound windows; payloads and client IDs survive restart and ambiguous responses; `ret=0` is the only acknowledgement; final enqueue removes same-generation activity/intermediate; missing token queues without a network call; and rate-limited `ret=-2` is classified once without nested retry ownership.

- [ ] **Step 2: Wire durable generation-aware delivery**

On each deduplicated inbound, call `quota.recordInbound`, cache its context token, and invoke `deliverPending(userId)`. Final responses are chunked at 2000 UTF-8 bytes with notice reservation, enqueued before sending, and sent only up to the planner prefix. Persist the exact API `client_id` before the first attempt; ack and `quota.confirmSend` only on confirmed success; keep the item unchanged for ambiguous outcomes.

- [ ] **Step 3: Implement error classification**

Extend `SendStatus` with `ambiguous`; treat `ret=-2` plus an `errmsg` containing `rate limited` as rate backoff; treat other `ret=-2`, empty responses, timeouts, and uncertain HTTP outcomes as ambiguous; use one backoff owner and stop the current window on ambiguity.

- [ ] **Step 4: Run client tests and commit**

Run: `node --import tsx --test test/client-send.test.ts test/client-internals.test.ts`

```powershell
git add src/ilink/client.ts src/ilink/send-result.ts src/ilink/types.ts test/client-send.test.ts test/client-internals.test.ts
git commit -m "feat: deliver durable quota windows"
```

### Task 6: Make router recovery exact and non-destructive

**Files:**
- Modify: `src/bridge/router.ts`
- Modify: `test/router.test.ts`

- [ ] **Step 1: Write failing router tests**

Verify only `text.trim() === '继续'` invokes outbox recovery; ordinary text both triggers recovery and reaches the selected adapter; duplicate message IDs do not open a window; and no old prompt is executed after restart.

- [ ] **Step 2: Implement routing**

Call client recovery for every fresh inbound before command parsing. Consume the exact `继续` message after recovery, preserve all other prompts, and remove the old automatic prompt re-execution branch. Keep slash `/continue` behavior separate.

- [ ] **Step 3: Run router tests and commit**

Run: `node --import tsx --test test/router.test.ts`

```powershell
git add src/bridge/router.ts test/router.test.ts
git commit -m "fix: reserve continue for outbox recovery"
```

### Task 7: Add diagnostics, status, compatibility, and regression coverage

**Files:**
- Create or modify: `src/ilink/diagnostics.ts`
- Modify: `src/ilink/client.ts`
- Modify: `src/bridge/router.ts`
- Modify: `test/diagnostics.test.ts`
- Modify: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Add redacted diagnostics tests**

Record inbound, plan, request, response, ack, ambiguous, and queue-change events without tokens, signed URLs, or full message bodies; expose `/status` delivery state with user-safe counts and failure state.

- [ ] **Step 2: Implement and verify compatibility**

Load old outbox files and migrate the thirteen current final chunks without dropping them; clear same-generation activity/intermediate after final enqueue; preserve the independent `/models` restoration as a separate commit if needed.

- [ ] **Step 3: Run the full suite**

Run: `npm run typecheck`; `npm test`; `npm run build`.

- [ ] **Step 4: Commit**

```powershell
git add src test docs/superpowers/experiments/2026-08-03-long-task-acceptance.md
git commit -m "test: cover durable delivery recovery and diagnostics"
```

### Task 8: Execute real-device acceptance

**Files:**
- Modify: `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`

- [ ] **Step 1: Verify the committed V2 candidate without touching the live process**

Run from `C:\tmp\cli-in-wechat-quota-v2`:

```powershell
git status --short --branch
git rev-parse HEAD
npm run typecheck
npm test
npm run build
```

Expected: branch `codex/quota-management-v2`, clean status, expected commit recorded in the acceptance log, 0 failed tests, and successful typecheck/build. Do not proceed if any command fails.

- [ ] **Step 2: Create an acceptance evidence directory and pre-stop snapshot**

```powershell
$acceptanceRoot = "C:\tmp\cli-in-wechat-v2-device-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$liveData = 'C:\Users\35952\.wx-ai-bridge'
New-Item -ItemType Directory -Path $acceptanceRoot | Out-Null
Copy-Item -LiteralPath $liveData -Destination (Join-Path $acceptanceRoot 'wx-ai-bridge-pre-stop') -Recurse
$acceptanceRoot | Set-Content -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt'
git rev-parse HEAD | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'candidate-commit.txt')
Get-CimInstance Win32_Process -Filter "ProcessId = 2176" |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |
  Format-List | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'old-process.txt')
$acceptanceRoot
```

Expected: a new uniquely named evidence directory containing the complete pre-stop runtime snapshot, candidate SHA, and PID 2176 metadata.

- [ ] **Step 3: Obtain explicit approval, then stop the single old poller**

Do not execute this step until the user explicitly authorizes stopping PID 2176.

```powershell
$acceptanceRoot = Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt'
$acceptanceRoot = $acceptanceRoot.Trim()
$liveData = 'C:\Users\35952\.wx-ai-bridge'
Stop-Process -Id 2176
Wait-Process -Id 2176 -Timeout 15 -ErrorAction SilentlyContinue
if (Get-Process -Id 2176 -ErrorAction SilentlyContinue) {
  throw 'PID 2176 is still running; do not start V2'
}
Copy-Item -LiteralPath $liveData -Destination (Join-Path $acceptanceRoot 'wx-ai-bridge-post-stop') -Recurse
```

Expected: PID 2176 is absent and the authoritative post-stop runtime snapshot exists. Never run the next step while PID 2176 remains alive.

- [ ] **Step 4: Start exactly one V2 poller and capture its PID and logs**

```powershell
$acceptanceRoot = Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt'
$acceptanceRoot = $acceptanceRoot.Trim()
$stdoutPath = Join-Path $acceptanceRoot 'v2.stdout.log'
$stderrPath = Join-Path $acceptanceRoot 'v2.stderr.log'
$v2 = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'dist/index.js','--debug' `
  -WorkingDirectory 'C:\tmp\cli-in-wechat-quota-v2' `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru
$v2.Id | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'v2.pid')
Start-Sleep -Seconds 3
Get-Process -Id $v2.Id
Get-Content -LiteralPath $stdoutPath,$stderrPath -Tail 80
$pollers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[/\\]index\.js.*--debug'
})
if ($pollers.Count -ne 1 -or $pollers[0].ProcessId -ne $v2.Id) {
  throw "Expected only V2 PID $($v2.Id), found: $($pollers.ProcessId -join ', ')"
}
```

Expected: one live Node process whose working build is `C:\tmp\cli-in-wechat-quota-v2\dist\index.js`, with no second bridge poller and no startup/migration error in either log.

If V2 exits or reports a startup/migration error, stop the acceptance run and execute:

```powershell
$acceptanceRoot = Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt'
$acceptanceRoot = $acceptanceRoot.Trim()
$v2PidPath = Join-Path $acceptanceRoot 'v2.pid'
if (Test-Path -LiteralPath $v2PidPath) {
  $failedV2Pid = [int](Get-Content -LiteralPath $v2PidPath)
  if (Get-Process -Id $failedV2Pid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $failedV2Pid
    Wait-Process -Id $failedV2Pid -Timeout 15 -ErrorAction SilentlyContinue
  }
}
$failureSnapshot = Join-Path $acceptanceRoot 'wx-ai-bridge-v2-failure'
Copy-Item -LiteralPath 'C:\Users\35952\.wx-ai-bridge' -Destination $failureSnapshot -Recurse
$failureSnapshot
```

Then request user direction. Do not automatically restore either snapshot or restart the old dirty build: restoring an older cursor/outbox can replay or lose messages.

- [ ] **Step 5: Use three deterministic long-output profiles**

Send the following safe prompts from the real WeChat device. Do not allow tool use or file changes.

`L` (target 4-9 chunks):

```text
@codex 不调用任何工具，不修改文件。只输出 6 个编号章节，每章约 500 个中文字符，主题是“可靠消息队列的设计检查项”。章节内容不得省略，不要使用表格，不要总结。
```

`X` (target >10 chunks):

```text
@codex 不调用任何工具，不修改文件。只输出 12 个编号章节，每章约 700 个中文字符，主题是“长消息交付系统的故障场景与验证方法”。章节内容不得省略，不要使用表格，不要总结。
```

`XX` (target >20 chunks):

```text
@codex 不调用任何工具，不修改文件。只输出 22 个编号章节，每章约 700 个中文字符，主题是“持久化消息系统从入站到确认的完整验收案例”。章节内容不得省略，不要使用表格，不要总结。
```

If the measured request count misses a target, repeat that run with more chapters; record the actual count rather than the requested count.

- [ ] **Step 6: Execute the fixed 20-run distribution**

Before each group, send `/msgmode <mode>` and verify the confirmation bubble names the requested mode. Use this matrix:

| Runs | Mode | Profile | Required observation |
| --- | --- | --- | --- |
| 1-5 | compact | L | Complete final content; no duplicate bubbles |
| 6 | compact | X | More than 10 chunks; attached continuation at the first boundary |
| 7 | compact | XX | More than 20 chunks; controlled restart after the first 10 confirmed chunks |
| 8-12 | normal | L | Complete streamed/final content; no post-final old activity |
| 13-14 | normal | X | More than 10 chunks; attached continuation at every boundary |
| 15-18 | verbose | L | Complete content; final result remains higher priority than activity |
| 19 | verbose | X | More than 10 chunks; no duplicate visible bubbles |
| 20 | verbose | XX | More than 20 chunks; attached continuation at every boundary |

This gives compact 7, normal 7, and verbose 6 runs, satisfying the minimum of five per mode.

- [ ] **Step 7: Perform the required in-delivery restart during run 7**

For run 7, wait until the device visibly shows the first 10 body chunks and the attached continuation text. Before sending `继续`, stop only the V2 PID recorded in `v2.pid`, confirm it is absent, restart the same committed build with the command below, and then send the exact text `继续`.

```powershell
$acceptanceRoot = Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt'
$acceptanceRoot = $acceptanceRoot.Trim()
$v2Pid = [int](Get-Content -LiteralPath (Join-Path $acceptanceRoot 'v2.pid'))
Stop-Process -Id $v2Pid
Wait-Process -Id $v2Pid -Timeout 15 -ErrorAction SilentlyContinue
if (Get-Process -Id $v2Pid -ErrorAction SilentlyContinue) {
  throw "V2 PID $v2Pid is still running"
}
$stdoutPath = Join-Path $acceptanceRoot 'v2-restart.stdout.log'
$stderrPath = Join-Path $acceptanceRoot 'v2-restart.stderr.log'
$v2 = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'dist/index.js','--debug' `
  -WorkingDirectory 'C:\tmp\cli-in-wechat-quota-v2' `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru
$v2.Id | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'v2.pid')
Start-Sleep -Seconds 3
Get-Process -Id $v2.Id
Get-Content -LiteralPath $stdoutPath,$stderrPath -Tail 80
$pollers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[/\\]index\.js.*--debug'
})
if ($pollers.Count -ne 1 -or $pollers[0].ProcessId -ne $v2.Id) {
  throw "Expected only restarted V2 PID $($v2.Id), found: $($pollers.ProcessId -join ', ')"
}
```

Expected: the remaining suffix resumes from durable state after `继续`; the first 10 visible chunks do not reappear; the frozen retry identity remains stable in diagnostics.

- [ ] **Step 8: Capture evidence after every run**

For each row in `docs/superpowers/experiments/2026-08-03-long-task-acceptance.md`, record mode, actual chunk count, restart point, complete visibility, duplicate count, continuation placement, observed UTF-8 byte range from diagnostics, and the phone screenshot/video filename. After each run, copy the current diagnostics tail without exposing credentials:

```powershell
$acceptanceRoot = Get-Content -Raw -LiteralPath 'C:\tmp\cli-in-wechat-v2-active-acceptance.txt'
$acceptanceRoot = $acceptanceRoot.Trim()
$runNumberText = Read-Host 'Completed run number (1-20)'
$runNumber = 0
if (-not [int]::TryParse($runNumberText, [ref]$runNumber) -or $runNumber -lt 1 -or $runNumber -gt 20) {
  throw 'Run number must be an integer from 1 through 20'
}
$diagnosticsCopy = Join-Path $acceptanceRoot ("run-{0:D2}-diagnostics-tail.jsonl" -f $runNumber)
Get-Content -LiteralPath 'C:\Users\35952\.wx-ai-bridge\delivery-diagnostics.jsonl' -Tail 300 |
  Set-Content -LiteralPath $diagnosticsCopy
$diagnosticsCopy
```

Do not treat `ret=0`, API confirmation, or diagnostics alone as proof of visible completeness; the device observation is mandatory.

- [ ] **Step 9: Evaluate the gate without weakening any criterion**

The gate passes only when all 20 rows show complete visible results, total duplicates equal zero, every partial window has the continuation notice attached to its last body bubble, no notice appears as an independent bubble, compact/normal/verbose each have at least five runs, at least one run exceeds 10 chunks, at least one exceeds 20 chunks, and run 7 resumes correctly after restart. Keep the chunk threshold at 2000 until real request sizes spanning 1800-4500 bytes have been recorded and reviewed.

- [ ] **Step 10: Run final verification and commit the observed acceptance record**

```powershell
npm run typecheck
npm test
npm run build
git diff --check
git diff -- docs/superpowers/experiments/2026-08-03-long-task-acceptance.md
```

Expected: all automated checks pass and every device-gate row contains observed evidence. Only then commit the acceptance record. Do not create `codex/main-candidate`, push, or modify `origin/main` until this gate is proven and the user separately authorizes the Git transition.
