# Skillsmith Agent — Eval Report (SMI-5456 Wave 1 Step 6, Validation Ladder Level 3)

Copy this file to `results/<release-version>-eval-report.md` for each release
and fill it in. This report is the committed artifact that feeds the Support
Tier-1 badges and the per-harness "marker channel verified" row referenced in
`docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md`.

- **Release**: `@skillsmith/mcp-server`@`<version>`
- **Date**: `<YYYY-MM-DD>`
- **Evaluator**: `<partner code or team member — never a real external name, per the anonymization rule>`

## Eval matrix

One row per harness. The three MVP-job columns are `pass`/`fail` against the
scripted prompt for that job (see `scripts/agent-evals/<harness>.sh` for the
exact prompt text; the three jobs are `keep-current`, `audit-fix`,
`vet-before-install` — see `packages/core/src/services/agent-pack/
prompt-source.ts` `JOBS` for the underlying job definitions). `L2b log` cites
the automated-run log this row's `pass`/`fail` calls are based on. `Marker
channel verified` is confirmed by hand during the interactive L3 session:
watch for a file under `~/.skillsmith/agent-markers/` appearing at
SessionStart and being removed at SessionEnd.

| Harness | keep-current | audit-fix | vet-before-install | Marker channel verified | L2b log | Notes |
|---|---|---|---|---|---|---|
| Claude Code | pass / fail | pass / fail | pass / fail | yes / no | `results/claude-code-<date>.log` | |
| Cursor | pass / fail | pass / fail | pass / fail | yes / no | `results/cursor-<date>.log` | `cursor-agent` requires `--force` for MCP tool access in headless mode as of the Step-0 spike — reconfirm still required |
| Codex | pass / fail | pass / fail | pass / fail | yes / no | `results/codex-<date>.log` | |
| Copilot / VS Code | pass / fail | pass / fail | pass / fail | yes / no | `results/copilot-<date>.log` | CLI surface only — the VS Code chat surface has no headless mode, so it is L3-interactive-only |
| OpenCode | pass / fail | pass / fail | pass / fail | yes / no | `results/opencode-<date>.log` | |
| Hermes | N/A | N/A | N/A | N/A | pending | L2b headless one-shot CLI invocation shape not yet confirmed (Step-0 spike covered the skill directory + MCP config only); no SessionStart hook exists (spike-verified absent), so the marker channel is not applicable to this harness |
| Windsurf / Devin | N/A | N/A | N/A | N/A | N/A | Structurally excluded from L2b — no headless mode (IDE-only per the plan's Validation Ladder table). L3-interactive-only. |

## Per-harness free-form notes (L3)

For each harness actually run interactively this release, capture: invocation
ergonomics, nudge firing (did the onboarding nudge appear, and only once per
the cooldown window?), trigger prompt rendering + frequency caps, quota-cost
display, decline/error/undo paths.

### Claude Code

-

### Cursor

-

### Codex

-

### Copilot / VS Code

-

### OpenCode

-

### Hermes

-

### Windsurf / Devin

-

## Sign-off

This report feeds the Validation Ladder Level 3 gate
(`docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md`). A harness
only advances to its UAT issue (SMI-5457–5463) once every applicable job in
its row above is `pass` and, where applicable, the marker channel is
verified.

- **Report author**:
- **Reviewed by**:
