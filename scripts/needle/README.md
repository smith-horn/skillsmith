# NEEDLE-based Codex dispatch — SMI-5668

One-time personal setup for `scripts/needle/dispatch.sh`, the queen's only
mechanism for dispatching a Codex-tier task (ADR-128, "Harness-of-Harnesses").
**Maintainer-machine-only, like `scripts/agent-evals/`: none of this is wired
into CI** — the binaries below need interactive login, per-seat licensing, or
a from-source build not available in a CI container.

Full design: [`docs/internal/implementation/smi-5668-needle-codex-dispatch.md`](../../docs/internal/implementation/smi-5668-needle-codex-dispatch.md).
Architecture decision: [ADR-128](../../docs/internal/adr/128-harness-of-harnesses-multi-cli-agent-orchestration.md).

## Setup

1. **Rust toolchain**, if not already present: install via [rustup](https://rustup.rs).
2. **Install NEEDLE**, pinned to the diligenced, macOS-compatible fork commit
   (upstream `jedarden/NEEDLE` has never published a macOS binary and has a
   real Darwin compile bug — see the implementation doc § 2). This also
   carries the transform-kill grace-period fix
   ([SMI-5678](https://linear.app/smith-horn-group/issue/SMI-5678/needle-transform-codex-fails-to-parse-jsonl-output-model-attribution))
   that fixed a spurious `TransformFailed` event and `model: "unknown"` cost
   attribution on every Codex dispatch — see the Linear issue for the
   root-cause and validation record (the paired implementation doc for the
   broader SMI-5691 fork-followups work has not been written yet):

   ```sh
   cargo install --git https://github.com/wrsmith108/NEEDLE --rev 96e669e8 --no-default-features
   ```

   `--no-default-features` skips the `otlp` telemetry feature (needs
   `protoc`; not required for this design — file-based telemetry is used
   instead, see the implementation doc § 5).

3. **Install bead-forge** (`bf`), pinned to the diligenced commit:

   ```sh
   cargo install --git https://github.com/jedarden/bead-forge --rev b516c0d2
   ```

   NEEDLE's own claim logic prefers `bf` natively (`which::which("bf")`) —
   no `br`/`beads_rust` shim is needed.

4. **Initialize NEEDLE's global config from a neutral directory — never from
   inside this repo (or any real repo checkout):**

   ```sh
   cd ~
   needle init
   ```

   `needle init` silently defaults `workspace.default` to the *current
   working directory at init time*. Running it from inside a repo would
   default NEEDLE's global workspace to that repo. This is a real footgun,
   independently confirmed in diligence — don't rely on remembering it,
   follow this step exactly.

5. **Install the corrected `codex` adapter** (NEEDLE's built-in one targets a
   stale Codex CLI flag surface):

   ```sh
   mkdir -p ~/.config/needle/adapters
   cp scripts/needle/codex-adapter.yaml ~/.config/needle/adapters/codex.yaml
   needle test-agent codex   # expect: Status: READY
   ```

6. **Install and authenticate the Codex CLI itself**, if not already done —
   the whole design depends on a separately-authenticated Codex CLI process
   (ADR-128):

   ```sh
   codex login
   codex exec --help   # sanity check
   ```

   Do this before step 5's `needle test-agent codex` check — without it,
   `needle`, `bf`, and the adapter all install fine but every dispatch fails
   for a reason none of the earlier steps explain.

## Usage

```sh
scripts/needle/dispatch.sh --workspace <worktree-dir> --title "<title>" --body-file <prompt-file> [--model gpt-5.6-sol] [--timeout 3600]
scripts/needle/dispatch.sh -h
```

See `dispatch.sh -h` for the full contract. Never targets the skillsmith
repo's own root/main checkout — the script refuses to run against it
(the same footgun as step 4, guarded a second time at dispatch time).

## Secret hygiene

The adapter's sandbox (`-s read-only`) blocks Codex from *writing* to the
target workspace, but not from *reading* it — a read-only sandbox can still
`cat` a secret-bearing file, and that content can end up in
`.beads/traces/<bead-id>/{trace.jsonl,stdout.txt}` or in NEEDLE's own
telemetry log with no redaction step. **Do not dispatch into a workspace
that contains live secrets** (`.env`, unencrypted credentials, etc.) — this
is the same class of exposure CLAUDE.md's Varlock section already guards
against for terminal output and logs, just via a new surface.

Verified during implementation with a real dispatch into a workspace
containing a dummy `.env`: Codex found the file, then explicitly declined to
read or reproduce its contents, citing the Skillsmith Agent pack's own
Varlock skill guidance ("the mandatory Varlock security policy prohibits
exposing secret values in terminal traces or responses") — a real,
observed layer of defense-in-depth from the already-installed agent pack, on
top of (not a substitute for) the workspace-hygiene rule above. Don't rely
on it: it depends on the model actually following that guidance, which isn't
guaranteed for every model/prompt.

## Known behavior

- **A dispatch processes every ready bead in the workspace, not just the one
  it just created.** `needle run --count 1` launches one *worker process*,
  not "process one bead then exit" — a worker drains the entire ready queue
  in the workspace's `.beads` store before going idle. If a workspace has
  leftover open/in-progress beads from an earlier interrupted run,
  `dispatch.sh` will process those too. This doesn't affect the outcome
  `dispatch.sh` reports (it classifies strictly by the bead ID it created),
  but it does mean a workspace with stale beads is observably slower and
  does extra, unrequested work. Prefer a clean worktree per dispatch, or
  periodically `bf list --workspace <dir>` to check for stale open beads.

## Troubleshooting

- **`needle doctor` reports `br CLI not found`.** Expected and benign once
  `bf` is installed — `bf` is NEEDLE's natively-preferred bead-store client
  (see setup step 3). This is a stale check in `needle doctor` itself, not a
  functional blocker; do not treat it as a regression.
- **A dispatch hangs or crashes with no error, `~/.needle/` never created.**
  NEEDLE's own `needle run` entry point always wraps the worker in a
  detached tmux session, and that tmux-launch wrapper crashes near-instantly
  on macOS. `dispatch.sh` already avoids this — it never calls `needle run`
  directly, only the documented `NEEDLE_INNER=1 needle run ...`
  direct-invocation form, which bypasses tmux entirely (confirmed via source:
  tmux is used only for NEEDLE's own fleet-supervision CLI surface —
  `attach`/`stop`/`cleanup`/`status`'s session count — never the worker state
  machine). tmux is not a dependency of this integration.
- **Cost**: a one-off Step 0 trial observed ~51k input tokens for a trivial
  task, traced to a leftover `.agents/skills/beads/SKILL.md` file specific to
  that trial's scratch workspace (an artifact of an earlier, abandoned `bd`
  install) — not something `bf`/NEEDLE creates (confirmed: `bf init` writes
  only `.beads/`), and not something the skillsmith repo itself ships (no
  `.agents/skills/` directory or `AGENTS.md` at its root). A dispatch into a
  real skillsmith worktree should not carry this tax. Kept as a defensive
  rule of thumb anyway, in case an unusual workspace has its own
  `.agents/skills/` content: don't dispatch anything to Codex that a
  Sonnet/Haiku worker would finish in under ~2 minutes. See CLAUDE.md's
  Default Execution Model, Codex row.
- **`transform.failed error="exit code -1"` in `needle logs`, or Codex-dispatch
  cost/token attribution showing `model: "unknown"`.** Fixed as of the pinned
  fork rev bump to `96e669e8` (SMI-5678) — `needle-transform-codex` now
  parses the dispatch output correctly and attributes the real model. If you
  still see this, confirm the install actually picked up `96e669e8` (re-run
  setup step 2; `cargo install` is a no-op if an older pinned rev is already
  installed under the same binary name).
