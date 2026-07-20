# NEEDLE-based Codex dispatch — SMI-5668

One-time personal setup for `scripts/needle/dispatch.sh`, the queen's only
mechanism for dispatching a Codex-tier task (ADR-128, "Harness-of-Harnesses").
**Maintainer-machine-only, like `scripts/agent-evals/`: a real dispatch is
never run in CI** — the binaries below need interactive login, per-seat
licensing, or a from-source build not available in a CI container. The unit
test (`scripts/tests/needle-dispatch.test.sh`) fakes out all three binaries
and needs only bash/git/jq/openssl, so it IS CI-wired
(`validate-needle-dispatch.yml`, SMI-5771) — that test proves the script's
own logic (flag handling, false-success detection, secret-scanner guard),
not that a real dispatch succeeds.

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
- **A dispatch reports `outcome=success` but no diff exists.** (SMI-5700)
  NEEDLE's `outcome.classified` telemetry event is based purely on the
  dispatched Codex process's exit code — it does not verify that any actual
  file changes exist. Confirmed root cause via a real incident (bead
  `bf-1aj`): Codex tried to write a real code change, the read-only sandbox
  (correctly, per ADR-128 rule 2) rejected the write, Codex handled the
  rejection gracefully and exited 0, and NEEDLE classified that as
  `success` because that's exactly what it's designed to do from an exit
  code alone. This is not a NEEDLE bug and not misconfiguration — the
  read-only sandbox is a deliberate, permanent design choice (see
  `codex-adapter.yaml`'s `-s read-only`), not something to work around.
  `dispatch.sh` now catches this two ways: (1) it always greps the bead's
  `stderr.txt` trace for a `patch rejected:` signature and downgrades the
  outcome to `blocked-by-sandbox` if found, regardless of whether
  `--expect-write` was passed; (2) if the caller passes `--expect-write`
  (meaning the dispatch was supposed to produce a real workspace change,
  not just analysis/review output) and the workspace shows no diff since
  the dispatch started, the outcome is downgraded to
  `no-diff-despite-expected-write`. Either downgrade makes `dispatch.sh`
  exit non-zero, same as any other failure — **a task that requires actual
  file writes cannot succeed under the current read-only-only adapter,
  full stop; route it through normal Claude-tier routing instead of
  retrying the same dispatch.** Pass `--expect-write` whenever the prompt
  asks Codex to make a real change; omit it for pure analysis/review
  prompts, where "no diff" is the expected, successful outcome.
- **`bf create` fails with `secret detected: ... [Azure Key]` on an
  ordinary long file path in the title/body — or, a separate and unrelated
  finding from the same investigation, an analysis-only dispatch's trace
  file never contains the model's final answer.** (SMI-5709) Two
  unconnected things, bundled into one entry because they surfaced
  together.
  **Part 1 — secret-scanner guard + allowlist.** `bf`'s own secret scanner
  has a generic heuristic — confirmed via `strings $(which bf)` to be
  labeled "Azure Key" — that flags any unbroken run of 44+ characters from
  `[A-Za-z0-9/_-]` in `--title`/`--description` content regardless of
  whether it's a real secret; an ordinary long file/worktree path trips it
  just as reliably as a credential would. `dispatch.sh` now pre-scans the
  exact raw title/body bytes for this same pattern — in grep's default
  per-line mode, so a match can never span a newline — before calling `bf
  create`, and fails fast with a redacted preview (the first ~10 and last
  ~4 characters of up to 5 matches, never the full matched substring, since
  a real credential could theoretically match this class too — remaining
  matches beyond 5 are counted but not shown) plus which field, and for the
  body which line, each shown match was found in. If a title or prompt body
  genuinely needs a long path, state the directory prefix once in prose and
  refer to bare filenames afterward. This guard is a pure compatibility
  pre-check with no knowledge of `bf`'s own `secret_protection.allowlist`
  (`.beads/config.yaml`) — allowlisting a pattern there does NOT get you
  past this guard, only past `bf`'s own scanner. To bypass this guard for a
  single dispatch, set `SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1` (registered
  in `docs/internal/process/guards-and-opt-outs.md`); `bf`'s own scanner
  still runs afterward, so a genuinely-allowlisted pattern needs both. On
  the allowlist itself: as observed behavior against the `bf` version in
  use at the time of this investigation (not a guarantee for every future
  `bf` release), matching there is a substring match against the *entire*
  scanned field's content — a pattern anchored at both ends (`^...$`) only
  matches a field whose full content equals it, a pattern anchored at one
  end only matches at that corresponding boundary, and an unanchored
  pattern matches text embedded anywhere in a longer field. Also note: this
  guard's character class (`[A-Za-z0-9/_-]`) is verified against ordinary
  long paths, not against `bf`'s real rule for base64-shaped secrets (which
  may include `+`/`=`) — a real base64 credential could in principle slip
  past this guard and still hit `bf`'s own rejection.
  **Part 2 — trace gap, unrelated to Part 1.** For a dispatch made without
  `--expect-write`, the trace file `dispatch.sh` prints (built by
  `needle_bead_trace_path()` in `scripts/needle/lib.sh`) only ever contains
  `tool_call`/`tool_result`/`tokens` events — never the dispatched model's
  final text response. That response lives only in the Codex CLI's own
  session log, `~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<uuid>.jsonl`,
  as JSON lines where `type == "event_msg"` and
  `payload.type == "agent_message"` — the *last* such line is the final
  answer, extractable with a small `jq`/Python snippet reading
  `payload.message`. Don't expect an analysis-only Codex review's actual
  answer to show up in the bead trace; go to the Codex session log
  instead.
