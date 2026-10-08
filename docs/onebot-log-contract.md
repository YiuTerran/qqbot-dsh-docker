# OneBot log and artifact bridge contract v1

This optional project contract is not part of OneBot v11. Capabilities are
`log-capture-v1` and `artifact-v1`. It never permits arbitrary file access,
remote fetches, hidden-output disclosure or execution of observed chat text.

## Capture

Before persistence, QQ face tags in current raw message text and confirmed bot replies become bounded readable labels; opaque base64 `ext` data is never stored or forwarded. Other Unicode text, newlines and Markdown are preserved. Normalized text still follows the existing 8192-character limit; raw input above 1 MiB produces a gap rather than truncation.

Authenticated `POST /internal/log/events` accepts one event:
`backend_id`, `event_id` (opaque stable deduplication key), `group_key`,
`user_key`, `time` (Unix seconds), `nickname`, `text`, `is_bot`, and `kind`
(`message` or `gap`). Keys are app-qualified SDK identities. Messages are
current raw events only; attachments become fixed type placeholders. Gap
events contain fixed diagnostic text rather than guessed missing content. A
successful durable enqueue returns HTTP 2xx with `{"accepted": true}`. Queue
overflow returns 429 `queue_full` and preserves a bounded per-group gap marker.
Confirmed bot sends use `appId:__qqbot__` rather than a fabricated SDK OpenID;
capture maps `is_bot` actors in the separate `bot` identity namespace.

The bridge persists a bounded pending queue separately from command quota,
maps identities with the existing mapper, and dispatches a capture-only frame:
`post_type: "_llm_bridge_log_event"`, `version: 1`, `connection_id`,
`event_id`, `group_id`, `user_id`, `time`, `nickname`, `text`, `is_bot`, `kind`.
Group/user IDs are JSON numbers in the existing virtual identity range
`[8_000_000_000_000_000, 9_000_000_000_000_000)`, not strings and not int32;
only command source message IDs use the existing positive int32 allocator.
The backend handles this before the normal OneBot parser and acknowledges
with `_llm_bridge_log_ack` action params containing `version`, `connection_id`,
`event_id`, `status` (`ok` or `failed`). The bridge returns the usual action ACK.
ACKs and event replay are connection-bound. Capture deduplication, authoritative
per-group bridge recording state and native log append share a log-DB transaction;
the legacy asynchronous GroupInfo save is only a compatibility mirror. Each new
connection adds a deterministic gap to restored active logs before capture replay.
Successful append/deduplication is atomic at the backend. Events received while recording is off are acknowledged
and discarded, not retroactively imported when recording starts.

Command and capture dispatch order must preserve accepted event order around
log controls. Commands are never replayed; only capture events may be replayed
by their persistent id. Queue overflow, restarts and outages must be represented
as recording gaps, never silently claimed complete. Capture endpoints are not
model tools. Bot outputs are observed only after the final QQ ACK; unknown
delivery is a gap. A virtual command and its backend reply are not independently
logged at the native execution hook.

## Artifacts

Backend action `_llm_bridge_artifact` params:
`version: 1`, `connection_id`, `source_message_id`, `filename`, `media_type`,
`bytes_base64`. Media types are exactly `text/markdown` for `.md` and
`text/plain` for `.txt` (no MIME parameters); bytes must independently be UTF-8.
Only bounded basename `.md` / `.txt` UTF-8 artifacts are accepted,
at most 10 MiB decoded bytes. No paths or URLs. Acceptance is tied to the active
group call, original connection and source message and increments the output
count used by `_llm_bridge_complete`; the backend counts only a successful ACK.

Successful MCP results add `artifact_receipts`, each with `receipt`, `filename`,
`media_type`, `size`, `sha256`. No file body is present in a model result.
Authenticated `POST /internal/artifacts/claim` requires `backend_id`,
`request_id`, `receipt`, `group_key`; returns `delivery_id`, the same metadata
and `bytes_base64`. Claim is one-shot and scoped to the completed original call.
`POST /internal/artifacts/ack` requires the same call/group binding plus
`delivery_id` and `status` (`sent`, `failed`, `unknown`, `expired`). Every final
status deletes bytes. Unclaimed/claimed bytes expire ten minutes after creation.
Retention is bounded to twenty artifacts and 64 MiB globally; capacity rejection
must return a failed action ACK and may not increment accepted output count.
Unknown QQ delivery never permits automatic re-send or text fallback.

## Identity labels

Existing `master-acl-v1` authorization may include `master_user_keys`, a map
from authorized decimal virtual user IDs to original `appId:openid` strings.
It is display-only; grants still come exclusively from `master_user_ids`.
Validate all mapped IDs and keys, isolate to the negotiated connection and clear
on disconnect. Missing mappings display an explicitly labeled virtual ID.

## Commands and defaults

Capture defaults on when OneBot is enabled; `QQBOT_ONEBOT_LOG_ENABLED=false`
disables it (qq-bot). Persistent recording still requires `.log new/on`. Native `.log`
supports `new/on/off/halt/end/list/stat/get/export/del` in the current group only.
State mutations require the current owner/admin role, never Master privilege;
every log command must match the identity-bound current QQ event text after removing only this bot mention. QQ users send `@bot .log …` through qq-bot; quotes, history and attachments cannot supply a missing command, while accompanying quote or attachment context does not invalidate a full current command. `get/export/end` default to
colored Markdown, `get/export --format=txt` optionally produce raw TXT.
No email, external upload, cross-group target or hidden output is supported.
These defaults do not modify ordinary OneBot mode or existing identity/card data.
