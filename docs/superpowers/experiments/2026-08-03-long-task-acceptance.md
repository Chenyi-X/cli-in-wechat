# Long Task Delivery Acceptance Log

This file records real-device evidence only. A successful API response does not
count as visible delivery until the WeChat client has been checked.

## Run Record

| Run | Mode | Prompt class | Start/end | Inbound generation | Token version/hash | Requests/items | Bytes | Ret/errmsg | WeChat visible | Duplicate | Restart tested | Notes |
|---:|---|---|---|---:|---|---:|---:|---|---|---|---|---|
| 1 | normal | Huxiu research | 2026-08-03 | 17 | 17 / `8b330590cd34...` | 10+ | 1800-2000 | `ret=-2 prepare failed` | incomplete, pending outbox | not observed | no | Historical failure preserved as outbox sequences 52-54 |

## Protocol Matrix

Record one row per real request. Keep the full response body in a private log;
use the redacted value in this file.

| Timestamp | Redacted user | Token hash | Generation | Token version | Client ID | Request/item/bubble sequence | JS length | UTF-8 bytes | Ret/errcode/errmsg | WeChat display |
|---|---|---|---:|---:|---|---|---:|---:|---|---|
| | | | | | | | | | | |

## Required Cases

- [ ] 1-15 sends with 0, 0.5, 1, 2, 5, and 10 second spacing.
- [ ] One request containing multiple `item_list` entries.
- [ ] Same user and different users.
- [ ] Same token and changed token, before and after inbound messages.
- [ ] Process restart with queued text; verify no duplicate client IDs.
- [ ] Cross-day behavior.
- [ ] 1800, 2000, 2048, 3000, 3500, 4000, and 4500 UTF-8 bytes.
- [ ] Chinese, English, emoji, Markdown, and code blocks.
- [ ] `compact`, `normal`, and `verbose`, at least five long tasks each.
- [ ] Image, file, and video failure visibility.

## Acceptance Summary

- Long tasks completed: `0 / 20` (minimum)
- Per-mode minimum: `compact 0/5`, `normal 0/5`, `verbose 0/5`
- Final visible delivery: `unverified`
- Duplicate visible delivery: `unverified`
- Restart recovery: `unverified`
- Media failure visibility: `unverified`
