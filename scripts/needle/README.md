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

- **`dispatch.sh` always closes the bead it created, on every terminal path
  (success, a downgraded outcome, or a poll-loop timeout).** (SMI-5847)
  Neither NEEDLE nor `bf` does this on their own: NEEDLE's own bead-close
  handler is `action: "none"` by design (no config knob), and its `mend`
  janitor's repair path shells out to `bf release` — a subcommand that does
  not exist in this `bf` version. Left unclosed, a bead is re-claimed and
  re-run at real Codex cost after `bf`'s `claim_ttl_minutes` (30 min)
  expires. `bf close` is idempotent, so a future SMI-5701 agent-side close
  is harmless on top of this. `dispatch.sh` never trusts `bf close`'s own
  exit code — it re-reads via `bf show` and, if the bead is still not
  closed (e.g. a transient `bf` error), prints a loud `WARNING` with the
  exact manual remediation command; this never changes the dispatch's own
  outcome or exit code.
- **A `needle run --count 1` worker drains the ENTIRE ready queue in the
  workspace's `.beads` store, oldest-first — not just the bead this
  dispatch just created — and `dispatch.sh` refuses to dispatch into a
  workspace already holding stale `open`/`in_progress` beads by default.**
  "Observably slower and does extra, unrequested work" understated the real
  cost: a live 7-day sample of this repo's own dispatch history found
  **66/66** real dispatches left their own bead `in_progress` forever (the
  defect SMI-5847 fixed above), and **17 of 59** `agent.completed` runs
  (28.8%) were undetected re-runs of already-finished work — a single
  dispatch that only asked for one bead silently ran three, at ~1.4x the
  requested Codex cost. Worse, a re-run **overwrites** the stale bead's own
  `.beads/traces/<bead-id>/` directory in place, destroying whatever answer
  it held. `dispatch.sh` now refuses (exit 2) before ever creating its own
  bead when the target workspace holds any stale bead — see this repo's
  `CLAUDE.md` Troubleshooting table for the exact refusal message and its
  registered opt-out (`SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1`).
  **One dispatch per workspace at a time** is the underlying constraint
  this guard enforces: `bf`'s `claim_ttl_minutes` (30 min) is shorter than
  `dispatch.sh`'s own default `--timeout` (3600s), so a legitimately
  long-running dispatch's own claim can expire mid-flight and trip this
  same guard for a second, genuinely-concurrent dispatch into the same
  workspace — wait for it to finish rather than reaching for the opt-out.
  Prefer a clean worktree per dispatch, or `bf list --workspace <dir>` to
  check for stale beads by hand.

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
  `stderr.txt` trace for a `patch rejected:` signature and records that as
  an audit-only `sandbox_write_rejected=yes` field in the results log —
  **but this only downgrades the outcome to `blocked-by-sandbox` when the
  caller passed `--expect-write`** (SMI-5847 corrected this: under the
  `pluck` prompt template's `notes/<bead>.md` write plus the permanently
  read-only sandbox, a rejected write is the *expected steady state* on
  every dispatch that never asked for one — downgrading it unconditionally
  was discarding complete, correct answers on analysis-only dispatches; see
  the note below and the SMI-5709 Part 2 entry below for how this shows up
  in the results log); (2) if the caller passes `--expect-write` (meaning
  the dispatch was supposed to produce a real workspace change, not just
  analysis/review output) and the workspace shows no diff since the
  dispatch started, the outcome is downgraded to
  `no-diff-despite-expected-write`. **Either of these — plus the
  zero-`agent_message` downgrade in the SMI-5709 Part 2 entry below — makes
  `dispatch.sh` exit non-zero when it fires**, same as any other failure —
  **a task that requires actual file writes cannot succeed under the
  current read-only-only adapter, full stop; route it through normal
  Claude-tier routing instead of retrying the same dispatch.** Pass
  `--expect-write` whenever the prompt asks Codex to make a real change;
  omit it for pure analysis/review prompts, where "no diff", and an
  incidental `patch rejected:` from the always-forbidden `notes/<bead>.md`
  write, are both the expected, still-successful outcome — do not
  re-dispatch a `success` result just because
  `sandbox_write_rejected=yes` also appears in the log.
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
  **Part 2 — trace gap, unrelated to Part 1. Superseded by SMI-5847 —
  the original guidance below to go read `~/.codex/sessions/` was wrong;
  read on for the corrected location.** The trace file `dispatch.sh` prints
  as `trace=`/`trace:` (built by `needle_bead_trace_path()` in
  `scripts/needle/lib.sh`, pointing at `trace.jsonl`) only ever contains
  `tool_call`/`tool_result`/`tokens` events — never the dispatched model's
  final text response, regardless of `--expect-write`. This originally led
  us to document `~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<uuid>.jsonl`
  as the place to find it — **that was wrong.** The final answer actually
  lives in the *sibling* file in the same trace directory,
  `.beads/traces/<bead-id>/stdout.txt`, as JSON lines where
  `type == "item.completed"` and `item.type == "agent_message"` — the last
  such line's `item.text` is the final answer (verified live against real
  trace output on 4 beads). `dispatch.sh` now prints this path directly as
  `stdout=`/`stdout:` right alongside `trace=`/`trace:`, both on stdout and
  in the results-log line, so there's no need to hunt for it manually.
  `dispatch.sh` also now extracts it itself (Wave 2 Step 3, SMI-5847): if
  an otherwise-`success` run's `stdout.txt` has zero `agent_message` items
  — e.g. Codex exited 0 having emitted only `command_execution` items
  (killed mid-turn, a transform failure, or similar) — the outcome is
  downgraded to `success-without-agent-message` and `dispatch.sh` exits
  non-zero, the same non-override invariant as the SMI-5700 checks above
  (it only ever downgrades an already-`success` outcome, never overrides a
  real failure back to success). A missing or corrupt `stdout.txt` never
  changes the outcome or exit code by itself — extraction failure degrades
  to "treat it as having no answer," not to a crash.
