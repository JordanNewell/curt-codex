# curt-codex

Two-direction bridge between [OpenAI Codex CLI](https://github.com/openai/codex)
session rollout files and the [`.curt`](https://github.com/JordanNewell/dot_curt)
single-file conversation format. Built on
[`curt-format`](https://www.npmjs.com/package/curt-format) (reference
implementation, v1 core). Part of the `curt-*` converter family (`curt-convert`
for Claude Code, `curt-openclaw` for OpenClaw, `curt-hermes` for Hermes).

**Hub-and-spoke positioning:** `.curt` is the archival hub. Direction 1
exports Codex sessions *out* into portable `.curt` archives. Direction 2 emits
the native Codex rollout JSONL that Codex itself writes — which both
`hermes sessions import` and OpenClaw's `sessions import` natively consume as
a third-party transcript source — so one emitter gives `.curt` archives two
downstream import paths.

```sh
npm install -g curt-codex    # or: npx curt-codex

# Direction 1: rollout files -> .curt
curt-codex ~/.codex/sessions -o ./out     # recursive over the sessions tree
curt-codex rollout-2026-11-01T....jsonl   # one file
curt-codex ~/.codex/sessions --sample 5
curt-codex one-rollout.jsonl --stdout > one.curt

# Direction 2: .curt -> Codex rollout JSONL (for sessions import in Hermes / OpenClaw)
curt-codex --emit-rollout ./out           # a directory of .curt files
curt-codex --emit-rollout one.curt -o ./jsonl
```

Direction 1 reads rollout files read-only. Every `.curt` output is re-parsed
with `parseCurt` before it is written; a file that fails round-trip validation
is never written. Output names follow the Curtis bulk convention
(`YYYY-MM-DD <slug> <suffix>.curt` via `curtFilename()`); a filename collision
gets a `-2`/`-3` suffix instead of silently overwriting. Direction 2 validates
each emitted JSONL for line-parseability, `session_meta` presence, and
`function_call`/`function_call_output` `call_id` linkage before writing. A
summary line with converted/skipped/round-trip-failure counts goes to stderr;
per-file problems are counted, never fatal. Rollout files are left untouched.

## Provenance

Input schema verified read-only against rollout files written by
**codex-cli 0.146.0** on **2026-11-01**: 5 rollout files (`work/` only —
gitignored), all written by the real Codex CLI writer on this machine the same
day. No prior Codex corpus existed (`~/.codex/sessions` was empty — the local
Codex install is unauthenticated against the API), so the corpus was generated
by running `codex exec` headless against local Ollama models with fully
synthetic prompts (including one run whose API calls failed 401 mid-session —
kept deliberately, because it exercises the failure-shaped rollout). Real
content stays out of this repo (gitignored `work/` by convention); `demos/`
are fully synthetic.

Schema findings that shaped the converter:

- Every line is `{timestamp, type, payload}`. `timestamp` is **ISO-8601 UTC
  with milliseconds and `Z`** (`2026-11-01T19:29:59.707Z`) — not epoch.
  Normalized to epoch milliseconds for `.curt`.
- Line types observed: `session_meta` (exactly once, first), `response_item`
  (the conversation record), `event_msg` (turn lifecycle telemetry),
  `turn_context` (per-turn config), `world_state` (environment snapshot).
  Unknown top-level types are counted, not fatal.
- `session_meta.payload`: `id`, `timestamp`, `cwd`, `originator`, `cli_version`,
  `source`, `model_provider`, `session_id`, `thread_source`, `history_mode`,
  `context_window`, `base_instructions`. The instructions field
  (`base_instructions`) is **never emitted** — presence counted for the drop
  ledger. `cwd` likewise dropped+counted. `id`, `originator`, `cli_version`,
  `source`, `model_provider` are non-identifying and kept as conversation
  extras (`codex`).
- `turn_context.payload` carries the **model id** (rollouts store the model
  per turn, not in session_meta) plus `cwd`, `workspace_roots`,
  `approval_policy`, `sandbox_policy`, `effort`, `summary`, `current_date`,
  `timezone`, `turn_id`, … — only `model` is kept; paths are dropped+counted.
- `response_item.payload.type == "message"` items carry `role`
  (`user` / `assistant` / `developer`), `content[]` parts of type
  `input_text` / `output_text`, and plumbing (`id`,
  `internal_chat_message_metadata_passthrough`) that is dropped+counted.
- **Bootstrap turns:** every session opens with developer-role instruction
  turns (`<permissions instructions>`, `<user_instructions>`, skills/plugins
  manifests) and a user-role `<environment_context>` turn. None of that is
  conversation: developer-role messages and `<environment_context>` /
  `<user_instructions>`-wrapped user turns are skipped+counted
  (`skippedBootstrap`), their content never read into output.
- `event_msg` payloads duplicate the record: `user_message` mirrors the user
  response_item, `agent_message` mirrors the assistant message. The
  `response_item` stream is the source of truth; events are skipped+counted —
  **except** `token_count`, whose `info.total_token_usage` (cumulative) /
  `info.last_token_usage` (this turn) /
  `info.model_context_window` feed the `usage-metadata` extras:
  `last_token_usage` attaches to the most recent assistant message as
  `tokens`, the final cumulative usage lands on the conversation as
  `codexTokens`. Token counts are plain integers; `rate_limits` is dropped.
- Tool linkage: `function_call` items carry `call_id`, `name`,
  `arguments` (a JSON-encoded string); `function_call_output` items carry
  `call_id` + `output` (string). Pairing is by exact `call_id`; unmatched
  calls/outputs are counted, never dropped. (Not exercised by the local
  corpus — the local Ollama models never emitted a tool call — so these
  shapes are pinned to codex-cli 0.146.0's persisted Responses-API items and
  covered by synthetic fixtures.)
- `reasoning` items (`summary[]` / `content[]` parts, optional
  `encrypted_content`) become `.curt` `thinking` passthrough, attached to the
  following assistant message; consecutive reasoning items join with a blank
  line. Reasoning with no following assistant turn is preserved as a trailing
  assistant message with empty content and counted (`orphanReasoning`).
  (Also fixture-only: no reasoning-capable model was available locally.)
- A rollout whose model calls all fail still contains `session_meta`,
  bootstrap turns, the user prompt, and `task_complete` — but no assistant
  content. Those convert to nothing usable and are skipped.

## Mapping

| Codex rollout | .curt | Notes |
|---|---|---|
| rollout file | conversation | One per file; the file *is* the session. |
| `session_meta.id` | `conversation.id` | |
| first emitted user text | `conversation.title` | Rollouts store no title; derived, single line, 60-char cap. |
| `response_item.message` timestamps (ISO → ms) | `conversation.createdAt` / `updatedAt` | Min/max over emitted messages. |
| `turn_context.model` | `conversation.model` (and per-message `model`) | Last turn_context wins. |
| `role:"user"` message (non-bootstrap) | message `role:"user"` | Content verbatim. |
| `role:"assistant"` message | message `role:"assistant"` | Content verbatim. |
| `role:"developer"` message | — | Instruction surface; skipped+counted, content never emitted. |
| user `<environment_context>` / `<user_instructions>` turns | — | Bootstrap; skipped+counted. |
| `reasoning` items | message `thinking` (extra) | Attached to the next assistant message; consecutive items joined; orphan reasoning kept as a trailing assistant message. |
| `function_call` | assistant message `toolCalls` (extra) | `[{id: call_id, name, arguments}]` with `arguments` parsed to a value — draft `tool-linkage` passthrough convention. Item `id` dropped+counted. |
| `function_call_output` | message `role:"tool"` | Extras: `toolCallId` (= `call_id`). JSON `output` re-serialized canonically and counted. |
| `event_msg` `token_count` `last_token_usage` | message `tokens` (extra) | Attached to the turn's assistant message; stable `usage-metadata` shape. |
| `event_msg` `token_count` `total_token_usage` (+ `model_context_window`) | `conversation.codexTokens` (extra) | Final cumulative usage; numbers only. |
| other `event_msg` (`task_started`, `user_message`, `agent_message`, `task_complete`, …) | — | Lifecycle telemetry / duplicates; skipped+counted. |
| `world_state` | — | Environment snapshot; skipped+counted. |
| `session_meta.originator`, `cli_version`, `source`, `model_provider` | `conversation.codex` (extra) | Minimal non-identifying metadata. |
| `session_meta.base_instructions`, `cwd`; `turn_context.cwd`, `workspace_roots`; item `id`s, `internal_chat_message_metadata_passthrough`, `encrypted_content` | — | Dropped, counted in `redactedFields`. |
| — | message `id` | Synthesized `"<sessionId>-<n>"` over emitted messages. |

### Direction 2 mapping (.curt → Codex rollout JSONL)

| .curt | Codex rollout | Notes |
|---|---|---|
| conversation | one `.jsonl` file | Curtis bulk-convention name, `.jsonl` extension. |
| conversation | `session_meta` line (first) | `payload.id` = conversation id; `cwd` empty; `originator`/`source`/`model_provider` restored from `codex` extras when present. |
| `conversation.model` | `turn_context` line | Minimal payload (`model`, `cwd:""`). |
| message `role:"user"` | `response_item` `message` (`input_text`) | |
| message `thinking` | `response_item` `reasoning` (`summary_text`) | Emitted before the same message's other items. |
| message `toolCalls` | `response_item` `function_call` per call | `arguments` re-encoded as a JSON string. |
| message `content` (assistant) | `response_item` `message` (`output_text`) | |
| message `role:"tool"` | `response_item` `function_call_output` | `toolCallId` → `call_id`. |
| `role:"system"` | `response_item` `message` `role:"developer"` | Closest native shape; see known losses. |
| `conversation.codexTokens` | final `event_msg` `token_count` | `total_token_usage` = `last_token_usage` = the rollup. |

Deterministic: the same `.curt` always emits byte-identical JSONL. Each file
is validated before writing: every line parses, `session_meta` is first, and
every `function_call_output`'s `call_id` either matches a preceding
`function_call` or is counted as an orphan (archives may legitimately contain
aborted calls). Emitting the native rollout format means `hermes sessions
import` and OpenClaw's `sessions import` both consume `.curt` archives without
upstream changes.

### Extensions

The top-level `extensions` array declares `["usage-metadata"]` (stable in
`EXTENSIONS.md`) because `tokens` is emitted. The **`tool-linkage` extension
is draft**, so its field names (`toolCalls` on assistant messages,
`toolCallId` on tool messages) ride as plain passthrough extras without
declaring the extension — the same convention curt-openclaw and curt-hermes
use. If/when `tool-linkage` reaches stable, declaring it is a one-line change.

## Known losses

Deliberate — instructions, identifiers, paths, and plumbing that must not
leak into a portable file. Counted in `redactedFields` (aggregate only; never
logged verbatim):

- `session_meta.base_instructions` (the system prompt) — never emitted.
- Developer-role messages (permissions, user instructions, skills/plugins
  manifests) — skipped, content never read.
- `<environment_context>` / `<user_instructions>` bootstrap user turns —
  skipped.
- `session_meta.cwd`, `turn_context.cwd`, `workspace_roots` — paths dropped.
- Response-item plumbing: `id`,
  `internal_chat_message_metadata_passthrough`, `function_call.id`,
  reasoning `encrypted_content`.
- `event_msg.rate_limits` and lifecycle events.

Structural, not redaction:

- `event_msg` `user_message`/`agent_message` duplicates are not carried — the
  `response_item` stream already holds the same content.
- A `function_call` with no matching output (aborted call) still emits its
  `toolCalls` entry; counted as `unmatchedToolCalls`. An
  `function_call_output` with no preceding call is counted as
  `unmatchedToolResults` but still emitted.
- Empty-content user/assistant items are dropped and counted
  (`emptyDropped`).
- `turn_context` config beyond the model id (approval policy, sandbox mode,
  effort, summary, timezone, collaboration mode, …) has no `.curt` mapping.
- Unknown payload types (`web_search_call`, `local_shell_call`,
  `custom_tool_call*`, future types) are counted (`unknownItemTypes`), not
  converted.
- Malformed lines (unparseable JSON) are counted, never fatal.
- Asymmetry: `role:"system"` messages re-emit as developer-role items, which
  the import direction treats as instructions — a system message survives
  archival but will not survive a codex → curt → codex round trip.

## Privacy posture

Direction 1 writes content-faithful files: conversation text, tool calls and
outputs, and thinking blocks all land in `.curt` output — treat output as
record-equivalent to the source rollout. The converter's metadata layer never
emits instructions (`base_instructions`, developer/bootstrap turns), paths
(`cwd`, `workspace_roots`), or item plumbing; nothing is read from
`~/.codex` except session rollout `.jsonl` files — `auth.json`, `config.toml`,
and credential stores are never touched. Direction 2 re-emits that same
content into rollout JSONL; nothing is added except neutral `cwd`/
`originator`/`source` fields. Real-corpus runs write into an untracked,
gitignored `work/` directory.

## Development

```sh
npm i
npm test       # vitest, 32 tests over a synthetic rollout fixture tree
npm run build  # tsc -> dist/
```

Fixtures (`test/fixtures.ts`) are fully synthetic and build a Codex-style
`YYYY/MM/DD/rollout-*.jsonl` tree in a temp dir. Regenerate the staged demos
with:

```sh
node --experimental-strip-types test/make-demo.ts
node dist/cli.js demos/synthetic-rollout -o demos/synthetic-flow
```

Real-corpus runs write into `work/` (gitignored from the start).

## Part of the .curt suite

- [`curt-format`](https://github.com/JordanNewell/dot_curt) — the .curt format spec + reference implementation ([npm](https://www.npmjs.com/package/curt-format))
- [`curt-convert`](https://github.com/JordanNewell/curt-convert) — Claude Code transcripts → .curt ([npm](https://www.npmjs.com/package/curt-convert))
- [`curt-openclaw`](https://github.com/JordanNewell/curt-openclaw) — OpenClaw session transcripts → .curt ([npm](https://www.npmjs.com/package/curt-openclaw))
- [`curt-hermes`](https://github.com/JordanNewell/curt-hermes) — Hermes agent store ⇄ .curt ([npm](https://www.npmjs.com/package/curt-hermes))
- [`curt-wildchat`](https://github.com/JordanNewell/curt-wildchat) — WildChat-1M records → .curt ([npm](https://www.npmjs.com/package/curt-wildchat))
- [`curt-vcon`](https://github.com/JordanNewell/curt-vcon) — .curt ⇄ vCon (IETF) bridge ([npm](https://www.npmjs.com/package/curt-vcon))
- [`curt-openwith`](https://github.com/JordanNewell/curt-openwith) — double-click any .curt file: offline viewer, Windows + macOS + Linux

MIT — see [LICENSE](LICENSE). See also
[ACCESS-AND-LICENSE.md](ACCESS-AND-LICENSE.md) for the input-data access and
content-licensing posture.
