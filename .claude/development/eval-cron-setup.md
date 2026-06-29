# Retrieval Eval Cron — Canonical Dev Setup (SMI-4764 Wave 2)

Plan: [docs/internal/implementation/smi-4764-eval-baseline-automation.md](../../docs/internal/implementation/smi-4764-eval-baseline-automation.md) §Wave 2

> **Single canonical developer.** This cron runs on **one** machine — the canonical retrieval-eval developer (currently Ryan). Other developers MUST NOT install it. Multiple installations would race auto-PRs and pollute baseline history. Replacement protocol below.

## What this does

A weekly local cron that runs `RETRIEVAL_EVAL_REAL=1` against the corpus (`docs/internal` + `.claude/skills` + the memory adapter), opens an auto-PR if `baseline.json` drifts, and writes a heartbeat row to `packages/doc-retrieval-mcp/eval/.cron-heartbeat`. The heartbeat is read by `audit:standards` (check 44, advisory) — stale heartbeat (>14 days) emits a warning prompting the replacement protocol.

**SMI-5353 — runs in an isolated checkout, never your live tree.** The eval runs against a dedicated clone at `~/.skillsmith/eval-checkout`, pinned to `origin/main`, in a **one-shot container** (`docker compose run`, scoped to the `skillsmith-eval-cron` Compose project). Your primary working tree and `skillsmith-dev-1` container are never reset, stashed, or guarded. After each run the heartbeat is **written back** into your primary tree so `audit:standards` Check 44 stays fresh. This replaced the old design that ran in your live tree and refused (silently skipping the weekly run) whenever you had uncommitted `docs/internal` / `.claude/skills` work — which was effectively always.

## Why local, not CI

`docs/internal` is **explicitly excluded from CI by repo policy** (`.github/workflows/docs-only.yml`, `ci.yml`, `packages/doc-retrieval-mcp/src/config.ts`). The eval needs the real corpus to produce honest numbers, so it runs on the canonical dev's machine where `docs/internal` is cloned. Plan-review v2 confirmed this is the right boundary; CI access to `docs/internal` would require an ADR + secret rotation.

## Prerequisites

- Repo cloned at a stable path (cron resolves it from the LaunchAgent / systemd unit)
- Docker Desktop running (the cron runs a one-shot eval container under its own `skillsmith-eval-cron` Compose project; the daemon must be reachable)
- `gh` CLI authenticated with PR-create permissions
- `varlock` set up if the dev container needs env injection
- Private-submodule access: `git submodule update --init docs/internal .claude/skills` succeeds (the eval corpus reads both)
- `.env` carries `SKILLSMITH_PROJECT_DIR_ENCODED` (for the eval container's `/skillsmith-memory` bind-mount). The setup `sed` reads its value from `.env` via `varlock` **at setup time** and bakes it into the plist `EnvironmentVariables` / systemd `Environment=`. The cron itself does **not** run under `varlock` — varlock hangs in launchd's keychain-less background context (it never exec's the cron). The cron refuses to run a memory-less corpus. _Existing installs predating SMI-5353 must re-generate the plist/unit (below) to pick up the baked-in env var._
- **≥ 3 GB free** at `$HOME` (isolated clone ~100 MB + `node_modules` ~500 MB + `.ruvector` ~200 MB)

### One-time isolated-checkout setup (SMI-5353)

Before first run (and on any replacement hand-off), create the dedicated clone the cron runs in. Do this **after** the SMI-5353 changes are on `origin/main`:

```bash
git clone https://github.com/smith-horn/skillsmith.git ~/.skillsmith/eval-checkout
cd ~/.skillsmith/eval-checkout
git submodule update --init --force docs/internal .claude/skills   # private — needs your creds
# Validate the wiring without running the ~1h40m eval:
cd /path/to/your/primary/repo
./scripts/eval-baseline-cron.sh --dry-run
```

The cron auto-clones on first run if the directory is absent, but doing it manually lets you confirm submodule access + disk up front. `--dry-run` validates: clone present, `origin/main` reachable, submodules initialized, the eval container starts, `tsx` resolves, `/skillsmith-memory` is populated, and the two heartbeat paths are distinct. It does **not** run the eval or exercise copy-back.

## macOS setup (primary)

```bash
# 1. Generate the LaunchAgent plist with substituted paths
# __PROJECT_DIR_ENCODED__ → SKILLSMITH_PROJECT_DIR_ENCODED, read from .env via
# varlock AT SETUP TIME (the cron does NOT run under varlock — it hangs in launchd).
PROJ=$(varlock run -- sh -c 'printf %s "$SKILLSMITH_PROJECT_DIR_ENCODED"')
sed "s|__REPO_PATH__|$(pwd)|g; s|__HOME__|$HOME|g; s|__PROJECT_DIR_ENCODED__|$PROJ|g" \
  scripts/eval-baseline-launchd.plist.template \
  > ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist

# 2. Load it (no auto-fire on load)
launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist

# 3. Verify
launchctl list | grep skillsmith
mkdir -p ~/.skillsmith/logs    # for first-run log path

# 4. Optional: dry-run the script to confirm the isolated checkout is wired (SMI-5353)
./scripts/eval-baseline-cron.sh --dry-run

# 5. Optional: trigger manually for first-run smoke
launchctl start app.skillsmith.eval-baseline-cron
tail ~/.skillsmith/logs/eval-cron-$(date -u +%Y-%m-%d).log
```

## Linux setup (fallback)

```bash
# 1. Substitute paths into the systemd unit + timer
PROJ=$(varlock run -- sh -c 'printf %s "$SKILLSMITH_PROJECT_DIR_ENCODED"')
sed "s|__REPO_PATH__|$(pwd)|g; s|__USER__|$USER|g; s|__PROJECT_DIR_ENCODED__|$PROJ|g" \
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

## Heartbeat lifecycle (SMI-5353)

The cron writes a heartbeat row in the **isolated clone**, then **copies it back** into your primary tree at `packages/doc-retrieval-mcp/eval/.cron-heartbeat`:

```text
<ISO-timestamp>\t<git-HEAD-sha>\t<OK|FAIL|WARN-PARTIAL>
```

- `OK` — eval succeeded, full corpus.
- `FAIL` — the eval errored.
- `WARN-PARTIAL` — `.claude/skills` couldn't be pinned (e.g. expired PAT); the eval still ran against `docs/internal` + memory, but the corpus was partial.

The cron writes the run's true status directly to **both** the clone's heartbeat and your primary tree's (no `cp` indirection), so the dev-tree file always carries the real status — never a silently-retained stale line. `audit:standards` Check 44 reads the **working-tree** copy in your primary tree, so this write-back is the entire local freshness mechanism. **There is no manual weekly push** — the old "no-drift weeks need a manual heartbeat-only commit" step (and its forgotten-push failure mode) is gone.

If the dev-tree write itself fails (path not writable / disk full), the cron logs an `ERROR` to `~/.skillsmith/logs/eval-cron-<date>.log`; Check 44 then keeps reading the prior line and won't flag the run until the normal 14-day staleness window expires. The log is the authoritative signal in that (rare) case.

| Cron run outcome | What lands in your primary tree | What gets committed to `main` |
|---|---|---|
| Drift detected | Fresh heartbeat (copy-back) | `baseline.json` + `.cron-heartbeat` via auto-PR (`eval-baseline-cron` label), opened from the clone |
| No drift | Fresh heartbeat (copy-back) | Nothing — copy-back alone keeps Check 44 fresh |

The copied-back heartbeat sits **untracked** in your primary tree; that's expected and harmless (Check 44 reads the working-tree file, and the cron no longer runs in your tree so it can't be tripped by it).

## Liveness alert — retrieval-telemetry stale-feed backstop (SMI-5432)

**What this is.** After the eval finishes (success or failure), the cron runs `scripts/retrieval-liveness-check.sh` as a best-effort step, placed **before** the eval-fail exit guard so it runs even when the eval has errored (dead binding is a leading cause of eval failure). This step checks whether the local `~/.claude/projects/<encoded>/retrieval-logs.db` has produced any row in the `retrieval_events` or `frontmatter_lint_events` tables within N days (default 7; configurable via `SKILLSMITH_RETRIEVAL_LIVENESS_STALE_DAYS`). If the feed is stale or a binding-outage marker is present, the script records the verdict in `~/.skillsmith/retrieval-liveness.state` (keyed by main-repo path, JSON, deduped 14-day re-notify cooldown) and either logs the finding (if in shadow) or opens/updates a deduped GitHub issue labeled `telemetry-liveness` (production mode).

**Shadow-first operator gate.** The alert ships **shadow-on by default** (`SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW` defaults to `1`). In shadow, the check still reads the DB, computes the verdict, and writes state/logs (`~/.skillsmith/logs/retrieval-liveness-<date>.log`) — but does not touch GitHub. This keeps the build safe even if the liveness logic has edge-case false positives. **Lifting shadow is a separate, gated operator milestone**, done only after both (a) the SMI-5426 auto-heal has been verified firing live end-to-end on a real `post-merge` (explicit user confirmation required — the binding self-heals), and (b) ≥4 consecutive weekly eval-cron runs show zero *false* `stale` verdicts (use `scripts/retrieval-liveness-check.sh --soak-report` over `~/.skillsmith/logs/retrieval-liveness-*.log` for an auditable tally). Record both criteria met on SMI-5432 before lifting.

**Lifting shadow on macOS:**

```bash
# 1. Verify gh auth
gh auth status

# 2. Uncomment the single shadow-lift line in the plist and reload
sed -i '' 's|<!-- <key>SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW</key><string>0</string> -->|<key>SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW</key><string>0</string>|' \
  ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
launchctl load   ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist

# 3. Verify
launchctl list | grep skillsmith
```

**Lifting shadow on Linux:**

```bash
# 1. Verify gh auth
gh auth status

# 2. Uncomment the env var in the systemd unit
sed -i 's|#Environment="SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW=0"|Environment="SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW=0"|' \
  ~/.config/systemd/user/skillsmith-eval-baseline-cron.service

# 3. Reload + restart
systemctl --user daemon-reload
systemctl --user restart skillsmith-eval-baseline-cron.timer
```

**Snooze pattern** (known away-window suppress, e.g., vacation). This keeps the check's state/log recording live while silencing GitHub paging:

```bash
# On leave
export SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL=$(date -d "+14 days" +%s)  # Linux
# or macOS
export SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL=$(date -v+14d +%s)
# Then set in the plist/unit's EnvironmentVariables / Environment= and reload, or just set it in your shell for interactive sessions

# Return from leave — clear the var (unset from plist/unit, or re-run the cron setup with a fresh .env)
```

**Invariant: no self-silencing TTL.** The script deliberately does **not** apply the interactive `probe.ts` function's `OUTAGE_MARKER_TTL_DAYS = 7` self-silencing — a present outage marker always alerts. The interactive banner stops nagging after 7 days; the *scheduled backstop's* whole purpose is the opposite — keep alerting until the binding actually heals (self-detected on the next successful row write).

## Replacement protocol

If the canonical dev becomes unavailable for >2 weeks:

1. **Verify staleness**: `audit:standards` warning will be live. Manually inspect `.cron-heartbeat` last timestamp.
2. **Designate replacement**: file a Linear issue under SMI-4764 (or a successor parent). Tag `area:eval-baseline`. The replacement dev:
   - Has access to the `docs/internal` + `.claude/skills` submodules (private)
   - Has Docker + `gh` set up
   - Commits to running the cron (no manual weekly push — the cron copies the heartbeat back automatically; SMI-5353)
3. **Hand off the canonical role**: the new dev performs the **one-time isolated-checkout setup** (see Prerequisites → "One-time isolated-checkout setup") and then installs the cron locally per the macOS / Linux setup above. The old dev disables their cron and tears down their isolated checkout:

   ```bash
   # macOS
   launchctl unload ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
   rm ~/Library/LaunchAgents/app.skillsmith.eval-baseline-cron.plist
   # Linux
   systemctl --user disable --now skillsmith-eval-baseline-cron.timer
   # Both: remove the isolated checkout + its Compose network/volume (SMI-5353)
   docker compose --project-name skillsmith-eval-cron \
     -f ~/.skillsmith/eval-checkout/docker-compose.yml down -v 2>/dev/null
   rm -rf ~/.skillsmith/eval-checkout
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

If a run is **in progress** when you unload (SMI-5353), the one-shot eval container keeps going until the run finishes. To kill it immediately:

```bash
docker compose --project-name skillsmith-eval-cron \
  -f ~/.skillsmith/eval-checkout/docker-compose.yml down
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Docker daemon not reachable` | Docker Desktop not launched at scheduled time | Start Docker; verify the launch-agent / timer is set to fire when the machine wakes |
| `isolated clone missing at ~/.skillsmith/eval-checkout` (dry-run) | One-time setup not done, or the clone was deleted | Run the one-time isolated-checkout setup (see Prerequisites). A real (non-dry-run) run auto-clones |
| `docs/internal not initialized in the clone (missing index.md sentinel)` / `docs/internal submodule update failed` | Lost private-submodule access (PAT/SSH) in the clone | Restore creds; `git -C ~/.skillsmith/eval-checkout submodule update --init --force docs/internal`. `docs/internal` is required — the cron aborts without it |
| Heartbeat shows `WARN-PARTIAL` | `.claude/skills` submodule couldn't be pinned (e.g. expired PAT); eval ran on a partial corpus | Restore strategy-submodule access; next run pins it and returns to `OK`. Baseline from a `WARN-PARTIAL` run may differ slightly — don't treat its drift as authoritative |
| Eval run fails during `npm ci` / native rebuild / image build | Network (prebuilt fetch), stale image, or disk | `docker compose --project-name skillsmith-eval-cron -f ~/.skillsmith/eval-checkout/docker-compose.yml down -v` (clears the node_modules volume) then re-run; inspect `~/.skillsmith/logs/eval-cron-<date>.log` |
| `memory dir empty or SKILLSMITH_PROJECT_DIR_ENCODED unset` | The plist/unit doesn't carry the var (e.g. install predates SMI-5353, or `.env` lacked it at setup) → empty memory bind-mount | Re-generate the plist/unit (Prerequisites → setup) so the `sed` bakes `SKILLSMITH_PROJECT_DIR_ENCODED` (read from `.env` via varlock at setup time) into `EnvironmentVariables` / `Environment=`. The cron itself does not run under varlock |
| `could not write heartbeat to the dev tree` | Primary-tree path not writable / disk full | Check disk + permissions on `<primary-repo>/packages/doc-retrieval-mcp/eval/`. Check 44 keeps reading the prior line until the 14-day window expires; the log line is the authoritative signal for that run |
| `eval invocation failed with exit N` | Eval-runner errored (network, OOM, indexer state) | Inspect `~/.skillsmith/logs/eval-cron-<date>.log`; `.cron-heartbeat` records `FAIL` so the audit distinguishes `not running` vs `running but failing` |
| Auto-PR not opened despite drift | `gh` not authenticated, or branch already exists | Check `gh auth status`; the branch suffix is now minute-resolution (`-YYYYMMDDTHHMM`) so same-day collisions are unlikely. Remove a stale `chore/eval-baseline-cron-*` branch with `git branch -D` + `git push --delete origin <branch>` |

## What this does NOT cover

- **Hand-rolled baseline edits**: the cron is observability for _automated_ baseline freshness. A developer hand-editing `baseline.json` and pushing with `--no-verify` bypasses the cron. The advisory `audit:standards` check 41 (Wave 3) catches that path.
- **Adversarial repo-write actors**: signature emission is observability, not security. ed25519 hardening tracked as Wave 5 follow-up if scenario materializes.
- **Cross-platform Windows support**: not implemented. Current contributor base is macOS/Linux. File a Linear issue under SMI-4764 if a Windows canonical dev is ever needed.
