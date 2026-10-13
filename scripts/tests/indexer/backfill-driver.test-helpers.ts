/**
 * SMI-7112: shared harness for the rollout-driver and handover-helper tests.
 *
 * Spawns the REAL shell scripts under their SKILLSMITH_BACKFILL_DRIVER_TEST seam:
 * the clock, sleep and pooler queries are files in a temp dir, and `gh` is a
 * stub first on PATH. Nothing here calls GitHub, Supabase or Docker. Not a
 * `*.test.ts` file, so vitest does not collect it.
 *
 * The stub `gh` logs every call to <dir>/seam.log (the same file the scripts'
 * faked `sleep` appends to, so cross-event ORDER is observable) and serves:
 *   gh variable get      -> STUB_FLAG_SEQ (comma list by call index; ERR / EMPTY)
 *   gh workflow run      -> logs WORKFLOW_RUN with intent_present; prints a URL if STUB_URL_ID
 *   gh api .../runs?event=workflow_dispatch... -> built from STUB_RUNS_MODE (one|none|two)
 *   gh api <anything else>  -> <dir>/api/<path sanitized>.json, or exit 1 (an API error)
 *   gh run view / list   -> completed / success ; list prints the trap id 222
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const DRIVER = join(REPO_ROOT, 'scripts', 'indexer', 'backfill-rollout-driver.sh')
export const HELPER = join(REPO_ROOT, 'scripts', 'indexer', 'backfill-handover-check.sh')
export const REPO = 'smith-horn/skillsmith'
export const PREFIX = '.agents/skills'

const GH_STUB = `#!/usr/bin/env bash
D="$STUB_DIR"; LOG="$D/seam.log"
echo "gh $*" >> "$D/calls.log"
clock=$(cat "$D/clock")
case "$1" in
  variable)
    if [ "$2" = "set" ]; then
      val=""; for a in "$@"; do prev_a="\${cur_a:-}"; cur_a="$a"; [ "$prev_a" = "--body" ] && val="$a"; done
      echo "VARIABLE_SET value=$val at=$clock" >> "$LOG"
      # Test hook: run a script at the moment of every variable-set call (an ordering seam).
      [ -f "$D/on-varset.sh" ] && bash "$D/on-varset.sh" "$val"
      # Test hook: fail ONLY the set call carrying this value (e.g. the restore-to-1).
      [ -f "$D/fail-varset-$val" ] && { echo "gh: HTTP 500" >&2; exit 1; }
      [ -n "\${STUB_VARSET_FAIL:-}" ] && { echo "gh: HTTP 500" >&2; exit 1; }
      echo "$val" > "$D/varstate"; exit 0
    fi
    if [ -f "$D/varstate" ]; then
      v=$(cat "$D/varstate"); echo "FLAG_READ phase=after-set value=$v at=$clock" >> "$LOG"
      [ -n "\${STUB_VARGET_AFTER_SET:-}" ] && v="$STUB_VARGET_AFTER_SET"
      echo "$v"; exit 0
    fi
    # STARTUP read (before the driver's first VACUUM) -> STUB_FLAG_STARTUP.
    # Per-dispatch reads (after a VACUUM) -> STUB_FLAG_SEQ by per-dispatch index.
    if ! grep -q '^vacuum' "$LOG" 2>/dev/null; then
      phase=startup; v="\${STUB_FLAG_STARTUP:-1}"
    else
      phase=dispatch
      n=$(cat "$D/flagcount" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$D/flagcount"
      IFS=, read -ra seq <<< "\${STUB_FLAG_SEQ:-1}"
      i=$((n-1)); [ "$i" -ge "\${#seq[@]}" ] && i=$((\${#seq[@]}-1)); v="\${seq[$i]}"
    fi
    echo "FLAG_READ phase=$phase value=$v at=$clock" >> "$LOG"
    [ "$v" = "ERR" ] && { echo "gh: HTTP 500" >&2; exit 1; }
    [ "$v" = "EMPTY" ] && { echo ""; exit 0; }
    echo "$v"; exit 0 ;;
  workflow)
    tok=""; for a in "$@"; do case "$a" in dispatch_token=*) tok="\${a#dispatch_token=}";; esac; done
    present=0; [ -f "$D/intents.jsonl" ] && grep -q "\\"token\\":\\"$tok\\"" "$D/intents.jsonl" && present=1
    echo "WORKFLOW_RUN token=$tok intent_present=$present at=$clock" >> "$LOG"
    echo "$tok" > "$D/last_token"
    [ -n "\${STUB_URL_ID:-}" ] && echo "https://github.com/${REPO}/actions/runs/$STUB_URL_ID"
    exit 0 ;;
  run)
    case "$2" in
      list) echo "RUN_LIST (trap) at=$clock" >> "$LOG"; echo 222; exit 0 ;;
      view)
        echo "RUN_VIEW id=$3 at=$clock" >> "$LOG"
        case "$*" in *"--json status"*) echo completed ;; *"--json conclusion"*) echo success ;; esac
        exit 0 ;;
    esac ;;
  api)
    p="$2"
    case "$p" in
      *"/workflows/indexer-backfill.yml/runs?event=workflow_dispatch"*)
        tok=$(cat "$D/last_token" 2>/dev/null || true)
        rid="\${STUB_RUN_ID:-111}"
        other='{"id":222,"display_title":"Skill Indexer Backfill (env=prod) [tok=drv-other]"}'
        mine="{\\"id\\":$rid,\\"display_title\\":\\"Skill Indexer Backfill (env=prod) [tok=$tok]\\"}"
        twin="{\\"id\\":333,\\"display_title\\":\\"Skill Indexer Backfill (env=prod) [tok=$tok]\\"}"
        mode="\${STUB_RUNS_MODE:-one}"
        if [ "$mode" = "err" ] || [ "$mode" = "flaky" ]; then
          # API errors on token lookup: always (err), or the first 3 calls (flaky).
          qn=$(cat "$D/qcount" 2>/dev/null || echo 0); qn=$((qn+1)); echo "$qn" > "$D/qcount"
          echo "API_RUNS_QUERY mode=$mode n=$qn at=$clock" >> "$LOG"
          if [ "$mode" = "err" ] || [ "$qn" -le 3 ]; then echo "gh: HTTP 502" >&2; exit 1; fi
          mode=one
        fi
        case "$mode" in
          one) body="$other,$mine" ;;
          none) body="$other" ;;
          two) body="$other,$mine,$twin" ;;
        esac
        [ -z "$tok" ] && body="$other"
        echo "API_RUNS_QUERY mode=\${STUB_RUNS_MODE:-one} at=$clock" >> "$LOG"
        echo "{\\"workflow_runs\\":[$body]}"; exit 0 ;;
    esac
    key=$(printf '%s' "$p" | tr -c 'a-zA-Z0-9' '_')
    if [ -f "$D/api/$key.json" ]; then cat "$D/api/$key.json"; exit 0; fi
    echo "gh: no fixture for $p (key $key)" >&2; exit 1 ;;
esac
echo "gh stub: unexpected call: $*" >> "$LOG"; exit 99
`

const Q_STUB = `#!/usr/bin/env bash
D="$STUB_DIR"
disp=$(grep -c '^WORKFLOW_RUN' "$D/seam.log" 2>/dev/null); disp=\${disp:-0}
case "$1" in
  *"->>'facet_index'"*) echo 3 ;;
  *"->>'facet'"*) if [ "$disp" -ge "\${STUB_DONE_AFTER:-1}" ]; then echo done; else echo f1; fi ;;
  *"->>'path'"*) echo "$STUB_PREFIX" ;;
  *"FROM audit_logs"*) echo 1 ;;
  *"FROM indexer_lock"*) echo 0 ;;
  *"FROM skills"*) echo 5 ;;
  *) echo "" ;;
esac
`

export interface Seam {
  dir: string
  env: NodeJS.ProcessEnv
  log(): string
  calls(): string
  intents(): string
  /** Count log lines starting with the given prefix. */
  count(prefix: string): number
  /** Write an API fixture for `gh api <path>`. */
  fixture(path: string, body: unknown): void
}

export function makeSeam(extraEnv: Record<string, string> = {}): Seam {
  const dir = mkdtempSync(join(tmpdir(), 'smi7112-seam-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'api'))
  writeFileSync(join(dir, 'bin', 'gh'), GH_STUB.replace('${REPO}', REPO))
  writeFileSync(join(dir, 'q.sh'), Q_STUB)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  chmodSync(join(dir, 'q.sh'), 0o755)
  writeFileSync(join(dir, 'clock'), '1790000000')
  writeFileSync(join(dir, 'seam.log'), '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
    SKILLSMITH_BACKFILL_DRIVER_TEST: dir,
    STUB_DIR: dir,
    STUB_PREFIX: PREFIX,
    BACKFILL_REPO: REPO,
    HOME: dir,
    ...extraEnv,
  }
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
  return {
    dir,
    env,
    log: () => read('seam.log'),
    calls: () => read('calls.log'),
    intents: () => read('intents.jsonl'),
    count: (prefix) =>
      read('seam.log')
        .split('\n')
        .filter((l) => l.startsWith(prefix)).length,
    fixture: (path, body) => {
      const key = path.replace(/[^a-zA-Z0-9]/g, '_')
      writeFileSync(join(dir, 'api', `${key}.json`), JSON.stringify(body))
    },
  }
}

export function runScript(script: string, args: string[], seam: Seam) {
  const r = spawnSync('bash', [script, ...args], {
    env: seam.env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: (r.stdout ?? '') + (r.stderr ?? ''),
  }
}

/** Log lines (in order) between the n-th and (n+1)-th WORKFLOW_RUN. */
export function linesBetweenDispatches(log: string, n: number): string[] {
  const lines = log.split('\n')
  const idx = lines.map((l, i) => (l.startsWith('WORKFLOW_RUN') ? i : -1)).filter((i) => i >= 0)
  if (idx.length <= n) return []
  return lines.slice(idx[n - 1] + 1, idx[n])
}
