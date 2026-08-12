# Product Requirements Document: iLink Delivery Reliability Roadmap

**Version**: 1.0  
**Date**: 2026-08-10  
**Author**: Sarah (Product Owner)  
**Quality Score**: 94/100

---

## Executive Summary

`cli-in-wechat` is a single-user bridge that turns WeChat into a remote interface for AI coding agents. Its core product value is not merely forwarding messages: it must preserve the feeling of watching and controlling an Agent while absorbing iLink's ten-message-per-inbound-window constraint.

The current Compact, Normal, and Verbose modes already express the desired user experience. The immediate work should preserve those semantics and improve delivery liveness: terminal failures must not block future output, successful Agent work must not be repeated because delivery failed, and already implemented OpenCode activity streaming must be restored to the rebuilt mainline.

This roadmap deliberately avoids a large delivery rewrite. Work is split into small issues and independently verifiable pull requests, starting with Issue #26.

---

## Problem Statement

### Current Situation

- PR #25 is merged into `upstream/main` at `5e5f1da`.
- The merged PR branch `codex/quota-management-integration` is clean and fully merged.
- The primary worktree is on `codex/quota-management` at `a319177` with 12 modified files and 2 untracked paths.
- Local and fork `main` point to `d619dfa`; `upstream/main` has 11 unique commits and local `main` has 21 unique commits.
- `permanent-failure` records remain in the same capacity budget as deliverable records and can eventually prevent new outbound content from entering the outbox.
- A bubbled outbound failure can keep an inbound receipt and poll cursor replayable, which creates a risk that completed Agent work is executed again.
- OpenCode intermediate activity support existed in historical commit `2e94a7c` but is missing from the rebuilt upstream mainline.
- Text delivery is more durable than media delivery.

### Proposed Solution

1. Stabilize and back up all local and remote development lines.
2. Fix Issue #26 with a narrowly scoped outbox liveness change that does not alter the three message modes.
3. Separate Agent execution completion from outbound delivery recovery.
4. Restore OpenCode event streaming and verify mode parity.
5. Improve media durability and tool-call/result correlation through separate issues.
6. Validate the complete system with failure injection and real-device acceptance runs.

### Business Impact

- The user can trust that completed Agent work is not silently lost.
- Long-running tasks remain observable in the chosen message mode.
- Restart, quota-window, and transport failures do not require routine queue management.
- The project remains maintainable because each reliability concern has a bounded issue and PR.

---

## Goals

### Overall Business Goal

Make `cli-in-wechat` feel like a dependable Agent interface inside WeChat: the user chooses how much of the Agent process to observe, receives output in order, and does not need to understand internal quota or queue state during normal operation.

### Product Goals

- Preserve the existing mode contract:
  - Compact: final result only, except independently enabled thoughts and requested files.
  - Normal: ordered speech, followed by an ordered Activity summary and final status.
  - Verbose: ordered speech, thoughts when enabled, tool activity, and meaningful tool-result summaries.
- Use all ten available iLink sends when useful; append continuation guidance to the last bubble instead of reserving fixed slots.
- Automatically continue durable pending output whenever a fresh inbound opens a new window.
- Never allow a terminal record to permanently disable future output.
- Never rerun a completed Agent task solely because delivery failed.

### Technical Goals

- Preserve stable client IDs and receipt reconciliation.
- Keep strict per-user FIFO ordering for user-visible event streams.
- Bound terminal-record storage independently from active delivery capacity.
- Make failure behavior deterministic and covered by fault-injection tests.
- Keep schema migrations and restart recovery backward compatible.

### Non-Goals

- Redesigning Compact, Normal, or Verbose mode semantics.
- Introducing multi-user administration or permissions.
- Replacing the iLink protocol or its user-inbound window requirement.
- Building a large `DeliveryCoordinator` rewrite before the smaller reliability fixes are validated.

---

## Success Metrics

### Primary KPIs

- **Final-result preservation**: 100% eventual final delivery in controlled tests when enough inbound windows are provided and iLink eventually accepts sends.
- **Duplicate Agent execution**: 0 repeated adapter executions caused only by outbound delivery failure or poll replay.
- **Duplicate visible messages**: 0 duplicates in restart and ambiguous-response acceptance runs.
- **FIFO correctness**: 100% ordered delivery for 1, 9, 10, 11, 13, 20, and 25 bubble cases.
- **Mode compatibility**: no unexpected bubble or ordering changes in Compact, Normal, and Verbose golden tests.
- **Queue liveness**: terminal records cannot cause `OutboxCapacityError` for otherwise admissible active output.
- **Restart recovery**: pending text and confirmed receipts recover without loss or resend.

### Real-Device Validation

- At least 20 long-task runs.
- At least 5 runs in each message mode.
- Text, file, image, and video cases represented.
- At least one restart during pending delivery.
- At least one multi-window Verbose task.
- Full ret/errcode evidence retained in redacted diagnostics.

---

## User Experience Contract

### Compact

- No intermediate event callback is rendered.
- Final answer is delivered in order and chunked only when necessary.
- `/thoughts` remains an independent switch unless a later product decision changes it.
- Requested files are still delivered.

### Normal

- Speech is streamed in chronological order.
- Tool calls are summarized rather than exposing raw JSON, long paths, or full outputs.
- Skill activity is included.
- The final Activity block preserves chronological order.
- Useful result summaries may be included only when concise and correctly associated with their call.

### Verbose

- Speech, enabled thoughts, tool calls, and useful result summaries retain event order.
- No silent activity coalescing beyond the existing batching needed to form WeChat bubbles.
- When more than ten sends are required, the tenth bubble carries continuation guidance.

### Continuation

- Exact `继续` is a flow-control gesture and is consumed when durable output is pending.
- Any fresh inbound may open a new iLink window, but must not accidentally rerun a completed task.
- No fixed one- or two-slot reservation is introduced.

---

## Repository Baseline And Safe Handling

### Current Baseline

| Item | Current State |
|---|---|
| Primary worktree | `codex/quota-management`, dirty |
| Current HEAD | `a319177` |
| Local/fork main | `d619dfa` |
| Upstream main | `5e5f1da` |
| Merged PR branch | `codex/quota-management-integration`, clean worktree |
| Quota v2 worktree | Dirty, preserve |
| Rebuild worktree | Clean but divergent, preserve until audited |

### Local Worktree Plan

1. Do not reset, rebase, or clean the primary worktree.
2. Review and checkpoint its tracked changes on a dedicated WIP branch.
3. Treat `DEVELOPMENT-GUIDE.md` and `opencode-zen-vs-go/` separately; do not add them to a delivery commit without classifying them.
4. Use the clean integration worktree for new upstream work.
5. Keep quota-v2 and rebuild worktrees until their unique commits have been audited against the merged implementation.

Suggested checkpoint flow:

```powershell
Set-Location C:\Users\35952\Desktop\123\test\cli-in-wechat
git switch -c codex/quota-management-wip-20260810
git diff --check
# Stage only reviewed delivery source, tests, and plans.
git add docs/superpowers/plans/2026-08-03-long-task-delivery.md src test
git commit -m "wip: checkpoint post-merge delivery recovery"
git push -u origin codex/quota-management-wip-20260810
```

The checkpoint commit is optional until the diff has been reviewed, but no destructive cleanup should happen before it exists locally and remotely.

### New Development Worktree

Use the clean merged-PR worktree:

```powershell
Set-Location C:\tmp\cli-in-wechat-integration
git fetch upstream --prune
git fetch origin --prune
git switch -c codex/fix-outbox-terminal-capacity upstream/main
```

After switching that worktree to the new branch, the old merged branch can be removed:

```powershell
git branch -d codex/quota-management-integration
git push origin --delete codex/quota-management-integration
```

### Fork Main Alignment

The fork's `main` must not be force-updated until the old mainline is backed up. This alignment is useful for clean future PRs but is not a prerequisite for fixing Issue #26.

```powershell
git branch codex/backup-main-before-pr25 d619dfa
git push origin d619dfa:refs/heads/codex/backup-main-before-pr25
git branch -f main upstream/main
git push --force-with-lease=refs/heads/main:d619dfa9d8b03b357a78a8231db1339935743b50 origin upstream/main:main
```

The exact lease makes the push fail safely if the remote main changes first.

---

## Issue And Pull Request Roadmap

### Milestone 0: Repository Stabilization

**Priority**: P0  
**Start**: Immediately  
**Estimated effort**: 0.5 to 1 day

Deliverables:

- Primary dirty work is reviewed and checkpointed or explicitly left untouched.
- Old main is backed up locally and remotely.
- New work begins from `upstream/main` in the clean integration worktree.
- Merged integration branch is retired after its worktree switches branches.

Exit criteria:

- No unique commit or untracked artifact is deleted.
- The Issue #26 branch is based exactly on `5e5f1da` or a newer upstream main.
- `git status` in the new development worktree is clean.

### Milestone 1: Issue #26 Outbox Liveness

**Priority**: P0  
**Start**: Immediately after Milestone 0  
**Estimated effort**: 1 to 2 days

Scope:

- Active capacity counts deliverable pending records and unreconciled receipts, not terminal failures.
- Terminal failures have an independent, bounded retention policy.
- Recoverable expiry failures can re-enter delivery on a fresh inbound under a bounded policy.
- Confirmed permanent rejection does not blindly retry forever.
- One terminal item does not require a second external recovery call before the FIFO suffix can proceed.
- Recovery commands may exist for self-diagnostics but are not required in the normal path.

Acceptance criteria:

- Hundreds of terminal records cannot block a new admissible final result.
- A permanent HTTP 400 item is retained as failure evidence while a valid suffix sends in the same drain.
- An expired recoverable item renews its lifetime only under the defined bounded policy.
- Restart preserves pending, receipt, and recent failure state.
- Compact, Normal, and Verbose golden outputs are unchanged.
- `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.

### Milestone 2: Agent Execution And Delivery Boundary

**Priority**: P0  
**Start**: After Milestone 1 is merged  
**Estimated effort**: 2 to 4 days

Proposed issue title:

`delivery: 出站失败可能阻止 poll cursor 提交并重复执行 Agent`

Scope:

- Persist enough task state to distinguish `executing`, `delivery-pending`, and `completed`.
- A replayed inbound resumes delivery or an interrupted Agent session according to durable state.
- Completed Agent output is never regenerated merely because outbox persistence or sending failed.

Acceptance criteria:

- Inject an outbox failure after adapter success; replay does not invoke the adapter twice.
- Restart during delivery resumes the existing result.
- Restart during execution follows an explicit recovery policy and does not reinterpret the recovery inbound as a new prompt.
- Poll cursor and inbound receipt behavior is deterministic under handler failure.

### Milestone 3: Restore OpenCode Event Streaming

**Priority**: P1  
**Start**: After Milestone 2, or in parallel only if maintained in a separate clean worktree  
**Estimated effort**: 1 to 2 days

Proposed issue title:

`opencode: 恢复 text/reasoning/tool activity 中间事件流`

Scope:

- Manually port the behavior from historical commit `2e94a7c` onto current upstream.
- Reuse concise tool call/result summaries.
- Preserve OpenCode session/model fixes already present upstream.

Acceptance criteria:

- Compact produces final output only, subject to independent thoughts behavior.
- Normal streams speech and produces an ordered Activity summary.
- Verbose emits ordered text, reasoning, tool-use, and useful tool-result summaries.
- Long paths and raw results remain compressed.
- Golden event fixtures pass for Claude and OpenCode.

### Milestone 4: Activity Correlation

**Priority**: P2  
**Start**: After OpenCode parity  
**Estimated effort**: 1 to 2 days

Proposed issue title:

`activity: 使用 toolCallId 关联 tool_use 与 tool_result`

Scope:

- Replace the single pending tool name with stable call IDs where adapters expose them.
- Preserve chronological Activity order.
- Include only concise and useful result summaries.

Acceptance criteria:

- Multiple sequential and concurrent tool calls associate with the correct results.
- Skill load, command exit, HTTP status, and Agent completion summaries appear under the correct call.
- No raw high-volume tool output reaches WeChat.

### Milestone 5: Durable Media Delivery

**Priority**: P1  
**Start**: After the text delivery state is stable  
**Estimated effort**: 3 to 5 days

Proposed issue title:

`media: 文件、图片和视频缺少与文本同等级的持久恢复`

Scope:

- Give media delivery a stable identity and durable state.
- Preserve shared quota ordering with text.
- Define upload-stage and send-stage ambiguity separately.
- Recover safely after restart without duplicating visible media.

Acceptance criteria:

- Restart after upload but before send does not silently lose the item.
- Ambiguous send uses a stable identity and a bounded recovery policy.
- Missing files produce a visible final notice without blocking text delivery.
- Text/media FIFO and ten-item accounting remain correct.

### Milestone 6: Release Acceptance

**Priority**: P0 release gate  
**Start**: After each milestone, final pass after Milestone 5  
**Estimated effort**: 2 to 3 days of controlled device runs

Acceptance criteria:

- All automated suites pass on Windows.
- Twenty controlled long tasks meet the KPI matrix.
- Each message mode has at least five successful runs.
- No duplicate Agent execution or visible delivery is observed.
- Restart and multi-window continuation pass on a real WeChat device.
- Diagnostics contain enough redacted evidence to investigate any failure.

---

## Issue #26 Reply

```markdown
感谢详细 review，这个问题成立。

这里需要区分两类额度：用户的新入站消息仍会正常刷新 iLink 的
10 条发送窗口；真正可能被占满的是本地 outbox 的 item/byte 容量。
`permanent-failure` 已经不再参与发送，但目前仍参与容量计算，而且
生产路径没有自动恢复或独立回收策略，因此长期运行后确实可能阻塞
该用户后续的出站回复。

当前产品受 iLink 限制，实际是扫码用户单人自用，因此 retry/clear
命令不存在普通用户与管理员的权限区分。不过我仍倾向于让正常路径
自动恢复，命令只作为自助排查和兜底，不要求日常使用时理解 outbox。

计划用一个范围较小的 follow-up PR 修复：

1. 活跃 outbox 容量只统计仍可能投递的 pending/receipt 记录；
2. permanent failure 使用独立且有上限的保留预算；
3. TTL 到期等可恢复类型在新入站窗口后按有界策略自动 requeue；
4. 确定性的 4xx 不自动无限重试；
5. 单条 permanent failure 不再阻止同一 FIFO 后缀继续发送；
6. Compact、Normal、Verbose 的消息内容、顺序和十条窗口行为保持不变。

我会补充容量恢复、重启持久化、HTTP 400 后缀放行和三种消息模式的
回归测试。

另外，`maxTurns` 从 30 调到 100 是有意支持长任务的改动，100 是上限
而不是每次固定消耗，但你指出得对：它与本 PR 的交付修复不是同一主题，
且 PR 描述遗漏了该行为。我会将其作为独立行为补充说明和测试，不与
本 issue 的修复混在一起。
```

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Existing dirty work is lost during cleanup | Medium | High | Checkpoint and remote backup before branch replacement |
| Outbox schema change breaks old snapshots | Medium | High | Migration fixtures and restart tests before merge |
| Reliability fix changes message-mode UX | Low | High | Golden tests for all three modes |
| Automatic retry loops on deterministic errors | Medium | High | Typed failure policy and bounded attempts |
| Agent task is executed twice after replay | Medium | High | Durable task phase and adapter invocation-count tests |
| OpenCode port reintroduces old model/session bugs | Medium | Medium | Manual port onto upstream, not cherry-pick |
| Media ambiguity causes duplicates | Medium | High | Stable identity and stage-specific state machine |

---

## Immediate Next Actions

1. Post the prepared reply on Issue #26.
2. Preserve the primary dirty worktree; do not reset or rebase it.
3. In the clean integration worktree, create `codex/fix-outbox-terminal-capacity` from `upstream/main`.
4. Write the failing Issue #26 tests before implementation.
5. Implement and verify Milestone 1 only.
6. Open the Agent execution/delivery boundary issue with its failure-injection acceptance case.
7. Open the OpenCode event-stream regression issue and reference historical commit `2e94a7c`.
8. Defer media and tool-call correlation implementation until the two P0 reliability milestones are stable.

---

## Final Target State

- The user selects Compact, Normal, or Verbose and receives exactly that experience.
- All useful iLink window slots are used without arbitrary reservations.
- Long output resumes on fresh inbound windows in strict order.
- Terminal records never disable future output.
- Completed Agent work is recovered, not recomputed, after delivery failure.
- Claude and OpenCode provide consistent event-stream behavior where their protocols allow it.
- Text and media survive restart under explicit, tested recovery policies.
- Routine use requires only normal WeChat conversation; recovery commands remain optional self-service tools.

