# Agent Evals — SMI-5456 Wave 1 Step 6

Per-harness eval matrix for the Skillsmith Agent pack, implementing
**Validation Ladder Level 2b** (real headless CLI runs) from
[`docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md`](../../docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md).
Level 2a (harness-simulation over a real MCP `Client`, no harness binaries
required) lives in
[`packages/mcp-server/tests/integration/agent-harness-sim.test.ts`](../../packages/mcp-server/tests/integration/agent-harness-sim.test.ts)
and runs in CI. **Everything in this directory is maintainer-run only — none
of it is wired into CI**, because the harness binaries below are not
installable in a CI container (interactive login, per-seat licensing, or
both).

## Why this exists

Level 0/1 (unit tests, generated-artifact snapshots, install-state
assertions) prove the pack is *built* correctly. Level 2a proves the MCP
*server* behaves correctly against a simulated client. Neither proves a real
harness binary can actually drive the pack end to end — that is what these
runners are for, and what Level 3 (a human running the same three jobs
interactively, recorded in `results/<release>-eval-report.md` via
[`results/TEMPLATE.md`](./results/TEMPLATE.md)) closes out before a harness
is allowed to enter its UAT issue (SMI-5457–5463).

## The three MVP jobs

Every runner drives the same three scripted prompts, one per MVP job defined
in [`packages/core/src/services/agent-pack/prompt-source.ts`](../../packages/core/src/services/agent-pack/prompt-source.ts) (`JOBS`):

1. **keep-current** — "What skills do I have installed that are outdated, and what changed?"
2. **audit-fix** — "Audit my installed skills for namespace collisions or issues, and tell me what you would fix. Do not apply anything yet."
3. **vet-before-install** — "I am thinking about installing the skill anthropic/commit. Look it up and tell me whether it is safe to install."

(`find-recommend`, the fourth pack job, is routing-only per the plan and is
not part of the MVP eval matrix.)

## Eval matrix (per-harness coverage)

| Harness | Runner | Headless invocation | Marker channel row | Status |
|---|---|---|---|---|
| Claude Code | `claude.sh` | `claude -p "<prompt>"` | Verified per L2a (`_meta` + marker-file round trip); L3 confirms the real hook writes it | Ready |
| Cursor | `cursor.sh` | `cursor-agent -p --force --output-format json "<prompt>"` | Verified per L2a; `--force` required for MCP tool access in headless mode as of the Step-0 spike (re-verify — the confirming forum evidence was ~9 months stale even at spike time) | Ready |
| Codex | `codex.sh` | `codex exec "<prompt>"` | Verified per L2a; `SessionStart` hook is confirmed wireable (`[[hooks.SessionStart]]` TOML), but Codex has **no `SessionEnd`-equivalent event** — see the Step-6 worker report on `agent-harness-targets.ts` | Ready |
| Copilot / VS Code | `copilot.sh` | `copilot -p "<prompt>" --allow-all-tools` | Verified per L2a; the VS Code chat surface itself has no headless mode — this runner covers the CLI surface only, VS Code chat is L3-interactive-only | Ready |
| OpenCode | `opencode.sh` | `opencode run "<prompt>"` | Verified per L2a | Ready |
| Hermes | *(none)* | Not yet confirmed | N/A — no SessionStart hook exists (Step-0 spike verified absent) | **Pending**: the Step-0 spike confirmed the skill directory (`~/.hermes/skills/`) and MCP config shape (`~/.hermes/config.yaml` `mcp_servers`), but not a one-shot headless prompt invocation. No `hermes.sh` runner until that is confirmed. |
| Windsurf / Devin | *(none)* | N/A | N/A | **Structurally excluded** from L2b — Windsurf/Devin Desktop has no headless CLI mode (IDE-only), per the plan's Validation Ladder table. L3-interactive-only. |

## Usage

Each runner is POSIX `sh`, safe to commit and run unexecuted, and checks for
its binary before doing anything else:

```sh
./scripts/agent-evals/claude.sh
./scripts/agent-evals/cursor.sh
./scripts/agent-evals/codex.sh
./scripts/agent-evals/copilot.sh
./scripts/agent-evals/opencode.sh
```

- **Exit 2** — the harness binary is not installed on this machine. The
  script prints which binary it looked for and exits cleanly; nothing is
  written.
- **Exit 0** — the run completed (this does NOT mean every job passed — read
  the log). Each job's combined stdout/stderr and exit code is appended to
  `results/<harness>-<date>.log`, one `=== JOB: <id> ... ===` section per
  job. A single job failing does not stop the remaining jobs in the same run.

Precondition for a meaningful run: the Skillsmith agent pack must already be
installed on the machine (`sklx agent install`) so the harness has the
`skillsmith-agent` subagent / curated MCP profile / hooks available. These
runners do not install anything themselves.

## Results

`results/*.log` are the raw per-run L2b captures (gitignored by convention —
they are machine- and date-specific scratch output, not the committed
artifact). The committed, human-curated artifact is
`results/TEMPLATE.md` copied to `results/<release-version>-eval-report.md`
per release — see that file for the full eval matrix + sign-off format. That
report (Level 3) is what actually gates a harness's entry into its UAT issue,
per the plan's Validation Ladder.
