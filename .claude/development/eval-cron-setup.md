# Retrieval Eval Cron — Canonical Dev Setup (SMI-4764 Wave 2)

Plan: [docs/internal/implementation/smi-4764-eval-baseline-automation.md](../../docs/internal/implementation/smi-4764-eval-baseline-automation.md) §Wave 2

> **Single canonical developer.** This cron runs on **one** machine — the canonical retrieval-eval developer (currently Ryan). Other developers MUST NOT install it. Multiple installations would race auto-PRs and pollute baseline history. Replacement protocol below.

## What this does

A weekly local cron that runs `RETRIEVAL_EVAL_REAL=1` against `docs/internal` + the memory adapter, opens an auto-PR if `baseline.json` drifts, and writes a heartbeat row to `packages/doc-retrieval-mcp/eval/.cron-heartbeat`. The heartbeat is read by `audit:standards` (check 44, advisory) — stale heartbeat (>14 days) emits a warning prompting the replacement protocol.

## Why local, not CI

`docs/internal` is **explicitly excluded from CI by repo policy** (`.github/workflows/docs-only.yml`, `ci.yml`, `packages/doc-retrieval-mcp/src/config.ts`). The eval needs the real corpus to produce honest numbers, so it runs on the canonical dev's machine where `docs/internal` is cloned. Plan-review v2 confirmed this is the right boundary; CI access to `docs/internal` would require an ADR + secret rotation.

## Prerequisites

- Repo cloned at a stable path (cron resolves it from the LaunchAgent / systemd unit)
- Docker Desktop running with `skillsmith-dev-1` reachable
- `gh` CLI authenticated with PR-create permissions
- `varlock` set up if the dev container needs env injection
- `git submodule update --init docs/internal` succeeds (you have access to the private docs submodule)

## macOS setup (primary)

```bash
# 1. Generate the LaunchAgent plist with substituted paths
sed "s|__REPO_PATH__|$(pwd)|g; s|__HOME__|$HOME|g" \
  scripts/eval-baseline-launchd.plist.template \
  > ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist

# 2. Load it (no auto-fire on load)
launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist

# 3. Verify
launchctl list | grep skillsmith
mkdir -p ~/.skillsmith/logs    # for first-run log path

# 4. Optional: dry-run the script to confirm guards pass
./scripts/eval-baseline-cron.sh --dry-run

# 5. Optional: trigger manually for first-run smoke
launchctl start app.skillsmith.eval-baseline-cron
tail ~/.skillsmith/logs/eval-cron-$(date -u +%Y-%m-%d).log
```

### macOS TCC (privacy sandbox) gotcha

If your repo lives under `~/Documents/`, `~/Desktop/`, or `~/Downloads/`, **launchd will be denied filesystem access by macOS TCC** and the agent will exit with code 126 + this stderr:

```text
shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted
job-working-directory: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted
/bin/bash: ./scripts/eval-baseline-cron.sh: Operation not permitted
```

This is macOS Privacy & Security blocking launchd jobs from traversing user-data folders. Two fixes (pick one):

**Option A — Grant `/bin/bash` Full Disk Access (recommended)**:

```bash
# Open the right pane directly:
open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
# Click the "+" button, hit Cmd+Shift+G in the file picker, type /bin/bash, add it.
# Toggle the switch ON for /bin/bash.
# Then re-load:
launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
launchctl start  app.skillsmith.eval-baseline-cron
tail -20 ~/.skillsmith/logs/eval-cron-launchd-stderr.log   # should be empty
ls -la packages/doc-retrieval-mcp/eval/.cron-heartbeat     # should now exist
```

**Option B — Move the repo outside `~/Documents/`**:

A clone at `~/code/skillsmith` or similar bypasses TCC entirely. Re-generate the plist after relocating (the substituted paths become stale).

**Why this isn't the systemd path's problem**: Linux has no equivalent global per-folder consent system, so the systemd timer just works. macOS Sequoia tightened TCC to cover launchd→`~/Documents/` traversal — pre-Sequoia LaunchAgents in the same configuration ran without intervention.

## Linux setup (fallback)

```bash
# 1. Substitute paths into the systemd unit + timer
sed "s|__REPO_PATH__|$(pwd)|g; s|__USER__|$USER|g" \
  scripts/eval-baseline-systemd.service.template \
  > ~/.config/systemd/user/skillsmith-eval-baseline-cron.service

sed "s|__REPO_PATH__|$(pwd)|g" \
  scripts/eval-baseline-systemd.timer.template \
  > ~/.config/systemd/user/skillsmith-eval-baseline-cron.timer

# 2. Reload + enable
systemctl --user daemon-reload
systemctl --user enable --now skillsmith-eval-baseline-cron.timer

# 3. Verify
systemctl --user list-timers | grep skillsmith
journalctl --user -u skillsmith-eval-baseline-cron --since '1 day ago'
```

## Heartbeat lifecycle

The cron always writes a heartbeat row to `packages/doc-retrieval-mcp/eval/.cron-heartbeat`:

```text
<ISO-timestamp>\t<git-HEAD-sha>\tOK
```

(Failed runs write `FAIL` instead of `OK`.)

| Cron run outcome | What gets committed | When |
|---|---|---|
| Drift detected | `baseline.json` + `.cron-heartbeat` together via auto-PR | Automatic (cron opens PR with `eval-baseline-cron` label) |
| No drift | `.cron-heartbeat` only | **Manual** — canonical dev pushes a heartbeat-only commit weekly |

**Why manual heartbeat-only push**: the cron deliberately does NOT auto-commit when there's no drift, to avoid spamming `main` with no-op commits. Canonical dev's weekly hygiene includes a `git add packages/doc-retrieval-mcp/eval/.cron-heartbeat && git commit -m 'chore(eval): cron heartbeat'` push when no drift PR fires. Forgetting this surfaces as the >14d audit warning.

## Replacement protocol

If the canonical dev becomes unavailable for >2 weeks:

1. **Verify staleness**: `audit:standards` warning will be live. Manually inspect `.cron-heartbeat` last timestamp.
2. **Designate replacement**: file a Linear issue under SMI-4764 (or a successor parent). Tag `area:eval-baseline`. The replacement dev:
   - Has access to `docs/internal` submodule (private)
   - Has Docker + `gh` set up
   - Commits to running the cron + manual weekly heartbeat-only pushes
3. **Hand off the canonical role**: the new dev installs the cron locally per the macOS / Linux setup above. The old dev disables their cron:

   ```bash
   # macOS
   launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
   rm ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
   # Linux
   systemctl --user disable --now skillsmith-eval-baseline-cron.timer
   ```

4. **Document the hand-off**: comment on SMI-4764 (or successor) noting the date and new canonical dev.

## Disabling temporarily

To pause the cron without deleting it:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist

# Linux
systemctl --user stop --now skillsmith-eval-baseline-cron.timer
```

The `audit:standards` warning will fire after 14 days of pause — that's intentional, it's the exact signal the system is supposed to surface.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cron must run from 'main' (current: '<branch>')` | Canonical dev left feature branch checked out at scheduled time | Switch to main before the next scheduled run, or expect to skip a week |
| `cron requires clean working tree` | Uncommitted local edits | Commit / stash; cron will retry next week |
| `Docker container 'skillsmith-dev-1' is not running` | Docker Desktop not launched at scheduled time | Start container; verify launch-agent / timer is set to fire when machine wakes |
| `eval invocation failed with exit N` | Eval-runner errored (network, OOM, indexer state) | Inspect `~/.skillsmith/logs/eval-cron-<date>.log`; .cron-heartbeat will record `FAIL` so the audit can distinguish `not running` vs `running but failing` |
| Auto-PR not opened despite drift | `gh` not authenticated, or branch already exists | Check `gh auth status`; remove stale `chore/eval-baseline-cron-<date>` branch with `git branch -D` + `git push --delete origin <branch>` |
| `audit:standards` heartbeat stale warning despite cron running | Forgetting the manual heartbeat-only push when there's no drift | Run `git add packages/doc-retrieval-mcp/eval/.cron-heartbeat && git commit -m 'chore(eval): cron heartbeat' && git push` |
| `launchctl list` shows exit code 126 + stderr `Operation not permitted` | macOS TCC blocks launchd from accessing repo under `~/Documents/` | See "macOS TCC (privacy sandbox) gotcha" above — grant `/bin/bash` Full Disk Access OR move repo outside `~/Documents/` |

## What this does NOT cover

- **Hand-rolled baseline edits**: the cron is observability for *automated* baseline freshness. A developer hand-editing `baseline.json` and pushing with `--no-verify` bypasses the cron. The advisory `audit:standards` check 41 (Wave 3) catches that path.
- **Adversarial repo-write actors**: signature emission is observability, not security. ed25519 hardening tracked as Wave 5 follow-up if scenario materializes.
- **Cross-platform Windows support**: not implemented. Current contributor base is macOS/Linux. File a Linear issue under SMI-4764 if a Windows canonical dev is ever needed.
