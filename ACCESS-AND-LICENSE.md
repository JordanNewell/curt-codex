# Access and license

Like `curt-openclaw` and `curt-hermes` (and unlike `curt-wildchat`'s public
research dataset), this converter's input is **your own local Codex CLI
data**: the rollout files under `~/.codex/sessions/` (`YYYY/MM/DD/
rollout-*.jsonl`). There is no remote access, no network use, and no
credential surface:

- Rollout files are opened read-only; nothing under `~/.codex` is ever
  written by this tool.
- Only session rollout `.jsonl` files are read. `auth.json`, `config.toml`,
  logs, and any credential/config surface are never touched.
- Instruction content is never emitted: `session_meta.base_instructions`,
  developer-role messages, and `<environment_context>` /
  `<user_instructions>` bootstrap turns are skipped (presence counted for the
  drop ledger, content never read into output). Paths (`cwd`,
  `workspace_roots`) are likewise dropped+counted.
- Direction 2 reads only `.curt` files (which parseCurt validates
  whole-file) and writes rollout JSONL.

Consequences:

- **License of the code:** MIT (see `LICENSE`). Test fixtures and `demos/`
  are fully synthetic; no real conversation content ships in this repo.
- **License of converted content:** yours (or your agents'/providers', per
  your own terms). `.curt` and emitted JSONL output are record-equivalent to
  the source rollouts — treat both as private, and scrub before sharing.
- Real-corpus conversion output is kept out of version control (untracked
  `work/` directory, gitignored from the start).
