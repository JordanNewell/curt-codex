# Demo notes

Fully synthetic — no real conversation content.

- `../synthetic-rollout/` — three Codex-style rollout JSONL files generated
  from `test/fixtures.ts` (session A: full zoo — bootstrap turns, reasoning,
  tool-call pair, unmatched call + orphan output, malformed line, unknown
  types; session B: minimal; session C: unusable failure-shaped rollout).
- `*.curt` — Direction 1 output of
  `node dist/cli.js ../synthetic-rollout -o .` (session C is skipped: nothing
  usable).

Round-trip check:

```sh
node dist/cli.js --emit-rollout . -o /tmp/emit   # 2 rollout JSONL, 0 rejected
node dist/cli.js /tmp/emit -o /tmp/reimport      # 2 .curt, same message counts
```
