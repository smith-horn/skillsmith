/**
 * SMI-6654: executable twin of `audit:standards` Check 72 -- a container
 * launcher followed by an npm mutation verb must reach npm only through
 * scripts/lib/node-modules-mount-gate.sh (ADR-158 Decision 3), and a
 * node_modules path is never probed through the mount table.
 * Plan: docs/internal/implementation/smi-6654-container-npm-mount-gate-check.md
 *
 * ADR-157 harness properties (SMI-6598):
 *   B-1 -- a harness-owned literal corpus. Every expectation is hand-written;
 *          nothing is computed from the helper under test.
 *   B-2 -- every ungated arm-A row has a hand-authored safe twin. Before any
 *          classification runs, the harness asserts each pair's expectations
 *          differ and that each twin's shell text parses (`sh -n -c`), so a
 *          twin cannot bless malformed shell. The F2 rows are near-twin negatives.
 *   B-3 -- `afterAll` prints the executed-case summary and fails on zero, or on
 *          a mismatch with fixtures/container-npm-gate-corpus.expected-count
 *          (a separate file, so changing the corpus size is a reviewable edit).
 *
 * Row expectations: 'F' finding, '-' clean, 'L' lock-only warn (pending U-1).
 * `G` is the exact gate invocation; it is interpolated into hand-written rows
 * only, never inserted into another row's text by code.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - .mjs helper has no typings
import {
  CHECK_72_SHADOW_END_DATE,
  CONTAINER_NPM_GATE_ALLOWLIST_JUSTIFICATIONS,
  LOCK_ONLY_EXEMPTION_VERIFIED,
  containerNpmGateReportLines,
  evaluateContainerNpmGate,
  liveScanDisposition,
  logicalUnits,
  probeMounts,
  scanText,
} from '../audit-container-npm-gate-helpers.mjs'
// SMI-4693: every fixture `git` spawn routes through makeFixtureEnv/makeFixtureTempDir.
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const EXPECTED_COUNT_FILE = resolve(
  __dirname,
  'fixtures',
  'container-npm-gate-corpus.expected-count'
)
const REPO_WALK_TIMEOUT_MS = 60_000

const G = 'sh scripts/lib/node-modules-mount-gate.sh'

type Kind = 'sh' | 'md' | 'ts'
type Expect = 'F' | '-' | 'L'
interface Row {
  id: string
  kind: Kind
  text: string
  expect: Expect
  safeTwinOf?: string
  note?: string
  /**
   * The shell that `sh -n` must accept, when the row's text deliberately holds
   * non-shell literal lines (a nested fence line shown as code content). Set it
   * explicitly rather than filtering the text, so a malformed twin can't pass
   * by having lines silently dropped (PR #2857 gate finding SMI-6654-3).
   */
  shellFragment?: string
}

// ── B-1: arm A corpus (plan rows A/F/R2 plus implementation rows N) ─────────
const ARM_A: Row[] = [
  { id: 'A01', kind: 'sh', text: 'docker exec skillsmith-dev-1 npm install', expect: 'F' },
  {
    id: 'A01s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'A01',
  },
  { id: 'A03', kind: 'sh', text: `docker exec c sh -c '${G}; npm install'`, expect: 'F' },
  {
    id: 'A03s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'A03',
  },
  { id: 'A04', kind: 'sh', text: `docker exec c sh -c 'npm install && ${G}'`, expect: 'F' },
  {
    id: 'A04s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'A04',
  },
  {
    id: 'A05',
    kind: 'sh',
    text: `docker exec -w /app "$C" sh -c '${G}; rc=$?; [ "$rc" -eq 0 ] || { echo "MOUNT_GATE $rc" >&2; exit 97; }; exec npm install'`,
    expect: '-',
    safeTwinOf: 'A05m',
    note: 'safe shape (b), regen-lockfile.sh saved-rc form',
  },
  {
    id: 'A05m',
    kind: 'sh',
    text: `docker exec -w /app "$C" sh -c '${G}; rc=$?; [ "$rc" -eq 0 ] || { echo "MOUNT_GATE $rc" >&2; }; exec npm install'`,
    expect: 'F',
    note: 'rc form without exit 97 is fail-open',
  },
  { id: 'A06', kind: 'sh', text: `docker exec c sh -c '${G} || true; npm ci'`, expect: 'F' },
  {
    id: 'A06s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm ci'`,
    expect: '-',
    safeTwinOf: 'A06',
  },
  { id: 'A07', kind: 'sh', text: 'docker compose exec dev npm ci', expect: 'F' },
  {
    id: 'A07s',
    kind: 'sh',
    text: `docker compose exec dev sh -c '${G} && npm ci'`,
    expect: '-',
    safeTwinOf: 'A07',
  },
  { id: 'A08', kind: 'sh', text: 'docker compose --profile dev run dev npm ci', expect: 'F' },
  {
    id: 'A08s',
    kind: 'sh',
    text: `docker compose --profile dev run dev sh -c '${G} && npm ci'`,
    expect: '-',
    safeTwinOf: 'A08',
  },
  { id: 'A09', kind: 'sh', text: 'docker compose -f a.yml run dev npm ci', expect: 'F' },
  {
    id: 'A09s',
    kind: 'sh',
    text: `docker compose -f a.yml run --rm dev sh -c '${G} && npm ci'`,
    expect: '-',
    safeTwinOf: 'A09',
  },
  { id: 'A10', kind: 'sh', text: 'docker compose --profile dev exec dev npm install', expect: 'F' },
  {
    id: 'A10s',
    kind: 'sh',
    text: `docker compose --profile dev exec dev sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'A10',
  },
  {
    id: 'A11',
    kind: 'sh',
    text: './scripts/worktree-docker.sh exec -- npm rebuild better-sqlite3',
    expect: 'F',
  },
  {
    id: 'A11s',
    kind: 'sh',
    text: `./scripts/worktree-docker.sh exec -- sh -c '${G} && npm rebuild better-sqlite3'`,
    expect: '-',
    safeTwinOf: 'A11',
  },
  { id: 'A12', kind: 'sh', text: 'docker exec c npm audit fix', expect: 'F' },
  {
    id: 'A12s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm audit fix'`,
    expect: '-',
    safeTwinOf: 'A12',
  },
  { id: 'A13', kind: 'sh', text: 'docker exec c npm install-test', expect: 'F' },
  {
    id: 'A13s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm install-test'`,
    expect: '-',
    safeTwinOf: 'A13',
  },
  { id: 'A14', kind: 'sh', text: 'docker exec c npm clean-install', expect: 'F' },
  {
    id: 'A14s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm clean-install'`,
    expect: '-',
    safeTwinOf: 'A14',
  },
  { id: 'A15', kind: 'sh', text: 'docker exec c npm add lodash', expect: 'F' },
  {
    id: 'A15s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm add lodash'`,
    expect: '-',
    safeTwinOf: 'A15',
  },
  {
    id: 'A16',
    kind: 'sh',
    text: 'docker exec c npm --workspace=packages/core install',
    expect: 'F',
  },
  {
    id: 'A16s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm --workspace=packages/core install'`,
    expect: '-',
    safeTwinOf: 'A16',
  },
  { id: 'A17', kind: 'sh', text: 'docker exec c npm -w packages/core install', expect: 'F' },
  {
    id: 'A17s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm -w packages/core install'`,
    expect: '-',
    safeTwinOf: 'A17',
  },
  { id: 'A18', kind: 'sh', text: 'docker exec c pnpm install', expect: '-' },
  { id: 'A19', kind: 'sh', text: 'docker exec c npm run build', expect: '-' },
  {
    id: 'A20',
    kind: 'sh',
    text: 'docker exec "$C" npm install --package-lock-only --ignore-scripts 2>/dev/null',
    expect: 'L',
  },
  {
    id: 'A20s',
    kind: 'sh',
    text: `docker exec "$C" sh -c '${G} && npm install --package-lock-only --ignore-scripts' 2>/dev/null`,
    expect: '-',
    safeTwinOf: 'A20',
  },
  {
    id: 'A20n',
    kind: 'sh',
    text: 'docker exec "$C" npm install --ignore-scripts 2>/dev/null',
    expect: 'F',
  },
  {
    id: 'A20n-s',
    kind: 'sh',
    text: `docker exec "$C" sh -c '${G} && npm install --ignore-scripts' 2>/dev/null`,
    expect: '-',
    safeTwinOf: 'A20n',
  },
  {
    id: 'A21',
    kind: 'sh',
    text: 'docker exec c npm install --package-lock-only && docker exec c npm install',
    expect: 'F',
  },
  {
    id: 'A21s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm install --package-lock-only && npm install'`,
    expect: '-',
    safeTwinOf: 'A21',
  },
  {
    id: 'A22',
    kind: 'sh',
    text: 'docker exec c ls  # then npm install',
    expect: 'F',
    note: 'accepted false positive, fixed by rewording',
  },
  {
    id: 'A22s',
    kind: 'sh',
    text: 'docker exec c ls  # then run the gated install',
    expect: '-',
    safeTwinOf: 'A22',
  },
  {
    id: 'A23',
    kind: 'md',
    text: '- check: `docker exec skillsmith-dev-1 node -e "x"`. However, `npm update <pkg>` may resolve it',
    expect: '-',
  },
  {
    id: 'A24',
    kind: 'md',
    text: 'Run `docker exec skillsmith-dev-1 npm install` first.',
    expect: 'F',
  },
  {
    id: 'A24s',
    kind: 'md',
    text: `Run \`docker exec -w /app c sh -c '${G} && npm install'\` first.`,
    expect: '-',
    safeTwinOf: 'A24',
  },
  {
    id: 'A25',
    kind: 'md',
    text: 'never a bare `docker exec skillsmith-dev-1 npm install`, which is the hazard',
    expect: 'F',
  },
  {
    id: 'A25s',
    kind: 'md',
    text: `never an ungated install; run \`docker exec -w /app skillsmith-dev-1 sh -c '${G} && npm install'\``,
    expect: '-',
    safeTwinOf: 'A25',
  },
  {
    id: 'A26',
    kind: 'sh',
    text: '# `docker exec skillsmith-dev-1 npm install` afterwards fails EROFS',
    expect: 'F',
  },
  {
    id: 'A26s',
    kind: 'sh',
    text: `# \`docker exec -w /app skillsmith-dev-1 sh -c '${G} && npm install'\` afterwards fails EROFS`,
    expect: '-',
    safeTwinOf: 'A26',
  },
  {
    id: 'A27',
    kind: 'ts',
    text: "        '    docker exec skillsmith-dev-1 npm install\\n\\n' +",
    expect: 'F',
  },
  {
    id: 'A27s',
    kind: 'ts',
    text: `        '    docker exec -w /app skillsmith-dev-1 sh -c "${G} && rm -rf /app/packages/x/node_modules/zod && npm install"\\n' +`,
    expect: '-',
    safeTwinOf: 'A27',
  },
  {
    id: 'A28',
    kind: 'sh',
    text: 'docker run --rm -v "$PWD:/app" node:22 npm ci',
    expect: '-',
    note: 'bare docker run is out of scope (R3)',
  },
  { id: 'A29', kind: 'sh', text: 'docker exec c npm i', expect: 'F' },
  {
    id: 'A29s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm i'`,
    expect: '-',
    safeTwinOf: 'A29',
  },
  { id: 'A30', kind: 'sh', text: 'docker exec c npm i18n-lint', expect: '-' },
  {
    id: 'A31',
    kind: 'md',
    text: '`node-modules-mount-gate.sh` exists; `docker exec c npm install` still runs ungated',
    expect: 'F',
  },
  {
    id: 'A31s',
    kind: 'md',
    text: `\`node-modules-mount-gate.sh\` exists; \`docker exec -w /app c sh -c '${G} && npm install'\` runs gated`,
    expect: '-',
    safeTwinOf: 'A31',
  },
  {
    id: 'A32',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install && npm rebuild x'`,
    expect: '-',
  },
  {
    id: 'A33',
    kind: 'sh',
    text: 'docker exec c rm -rf /app/node_modules/zod',
    expect: '-',
    note: 'M-11 / D-7, not arm A',
  },
  {
    id: 'A34',
    kind: 'md',
    text: '# `docker exec` and `npm install` ROUTING decision',
    expect: '-',
  },
  { id: 'A35', kind: 'sh', text: 'docker container exec c npm ci', expect: 'F' },
  {
    id: 'A35s',
    kind: 'sh',
    text: `docker container exec c sh -c '${G} && npm ci'`,
    expect: '-',
    safeTwinOf: 'A35',
  },
  { id: 'A36', kind: 'sh', text: 'docker-compose exec dev npm install', expect: 'F' },
  {
    id: 'A36s',
    kind: 'sh',
    text: `docker-compose exec dev sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'A36',
  },
  { id: 'A37', kind: 'sh', text: 'docker exec c npm --silent run build', expect: '-' },
  { id: 'A38', kind: 'sh', text: 'docker exec c npm --prefix /app/packages/core ci', expect: 'F' },
  {
    id: 'A38s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm --prefix /app/packages/core ci'`,
    expect: '-',
    safeTwinOf: 'A38',
  },
  {
    id: 'A39',
    kind: 'sh',
    text: 'docker exec c npm -s run rebuild:native',
    expect: 'F',
    note: 'accepted false positive, fixed by rewording',
  },
  {
    id: 'A39s',
    kind: 'sh',
    text: 'docker exec c npm run --silent rebuild:native',
    expect: '-',
    safeTwinOf: 'A39',
  },
  // F-1 adversarial lines
  {
    id: 'F1a',
    kind: 'sh',
    text: 'docker exec c echo node-modules-mount-gate.sh && npm install',
    expect: 'F',
  },
  {
    id: 'F1a-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F1a',
  },
  {
    id: 'F1b',
    kind: 'sh',
    text: `docker exec c ${G} && npm install`,
    expect: 'F',
    note: 'npm runs in the HOST shell',
  },
  {
    id: 'F1b-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F1b',
  },
  {
    id: 'F1c',
    kind: 'sh',
    text: "docker exec c sh -c 'echo node-modules-mount-gate.sh && npm install'",
    expect: 'F',
  },
  {
    id: 'F1c-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F1c',
  },
  // F-2 negative near-twins
  {
    id: 'F2a',
    kind: 'sh',
    text: `docker exec -w /app c sh -c 'echo ${G} && npm install'`,
    expect: 'F',
  },
  {
    id: 'F2a-s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F2a',
  },
  { id: 'F2b', kind: 'sh', text: `docker exec -w /app c sh -c '${G}' && npm install`, expect: 'F' },
  {
    id: 'F2b-s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F2b',
  },
  { id: 'F2c', kind: 'sh', text: `docker exec -w /app c sh -c '${G}; npm install'`, expect: 'F' },
  {
    id: 'F2c-s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F2c',
  },
  {
    id: 'F2d',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm ci; npm install'`,
    expect: 'F',
  },
  {
    id: 'F2d-s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && npm ci && npm install'`,
    expect: '-',
    safeTwinOf: 'F2d',
  },
  { id: 'F2e', kind: 'sh', text: `docker exec c echo sh -c '${G} && npm install'`, expect: 'F' },
  {
    id: 'F2e-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F2e',
  },
  // F-3 fail-open, grouping and position variants
  {
    id: 'F3a',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && echo ok; npm install'`,
    expect: 'F',
  },
  {
    id: 'F3a-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && echo ok && npm install'`,
    expect: '-',
    safeTwinOf: 'F3a',
  },
  { id: 'F3b', kind: 'sh', text: `docker exec c sh -c '(${G}) && npm install'`, expect: 'F' },
  {
    id: 'F3b-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F3b',
  },
  { id: 'F3c', kind: 'sh', text: `docker exec c sh -c '{ ${G}; } && npm install'`, expect: 'F' },
  {
    id: 'F3c-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F3c',
  },
  { id: 'F3d', kind: 'sh', text: `docker exec c sh -c '${G} && (npm install)'`, expect: 'F' },
  {
    id: 'F3d-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F3d',
  },
  { id: 'F3e', kind: 'sh', text: `docker exec c sh -c 'true || ${G} && npm install'`, expect: 'F' },
  {
    id: 'F3e-s',
    kind: 'sh',
    text: `docker exec c sh -c 'true && ${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F3e',
  },
  {
    id: 'F3f',
    kind: 'sh',
    text: `docker exec c sh -c '${G} | tee /tmp/g && npm install'`,
    expect: 'F',
  },
  {
    id: 'F3f-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install | tee /tmp/g'`,
    expect: '-',
    safeTwinOf: 'F3f',
  },
  { id: 'F3g', kind: 'sh', text: `docker exec c sh -c '! ${G} && npm install'`, expect: 'F' },
  {
    id: 'F3g-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F3g',
  },
  { id: 'F3h', kind: 'sh', text: `docker exec c sh -c '${G} && echo npm install'`, expect: 'F' },
  {
    id: 'F3h-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && echo done && npm install'`,
    expect: '-',
    safeTwinOf: 'F3h',
  },
  {
    id: 'F3i',
    kind: 'sh',
    text: `docker exec -w /app c sh -c '${G} && cd /app/packages/p && npm rebuild m'`,
    expect: '-',
  },
  // F-6 continuations and multi-line scripts
  { id: 'F6a', kind: 'sh', text: "docker exec -w /app c sh -c \\\n  'npm install'", expect: 'F' },
  {
    id: 'F6a-s',
    kind: 'sh',
    text: `docker exec -w /app c sh -c \\\n  '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F6a',
  },
  {
    id: 'F6b',
    kind: 'md',
    text: "```bash\ndocker exec -w /app c sh -c '\n  npm install\n'\n```",
    expect: 'F',
  },
  {
    id: 'F6b-s',
    kind: 'md',
    text: `\`\`\`bash\ndocker exec -w /app c sh -c '${G} && npm install'\n\`\`\``,
    expect: '-',
    safeTwinOf: 'F6b',
  },
  {
    id: 'F6c',
    kind: 'md',
    text: `\`\`\`bash\ndocker exec -w /app c sh -c '\n  ${G} &&\n  npm install\n'\n\`\`\``,
    expect: 'F',
    note: 'valid shell, but a newline counts as a separator (conservative)',
  },
  {
    id: 'F6c-s',
    kind: 'md',
    text: `\`\`\`bash\ndocker exec -w /app c sh -c '${G} && npm install'\n\`\`\``,
    expect: '-',
    safeTwinOf: 'F6c',
  },
  {
    id: 'F6d',
    kind: 'sh',
    text: "docker exec -w /app c sh -c '\n" + 'x\n'.repeat(12) + "npm install'",
    expect: 'F',
  },
  {
    id: 'F6d-s',
    kind: 'sh',
    text: "docker exec -w /app c sh -c '\n" + 'x\n'.repeat(12) + `${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'F6d',
  },
  { id: 'F6e', kind: 'sh', text: 'docker exec -w /app c \\\n  npm ci', expect: 'F' },
  {
    id: 'F6e-s',
    kind: 'sh',
    text: `docker exec -w /app c \\\n  sh -c '${G} && npm ci'`,
    expect: '-',
    safeTwinOf: 'F6e',
  },
  // Round-2 adversarial shapes
  { id: 'R2a', kind: 'sh', text: `docker exec c sh -c 'echo "${G} && npm install"'`, expect: 'F' },
  {
    id: 'R2a-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'R2a',
  },
  {
    id: 'R2b',
    kind: 'sh',
    text: 'docker exec c sh -c "$SCRIPT"',
    expect: '-',
    note: 'ACCEPTED FALSE NEGATIVE: the script hides behind a variable',
  },
  { id: 'R2c', kind: 'sh', text: `docker exec c bash -lc '${G} && npm install'`, expect: 'F' },
  {
    id: 'R2c-s',
    kind: 'sh',
    text: `docker exec c bash -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'R2c',
  },
  {
    id: 'R2d',
    kind: 'sh',
    text: `docker compose run --entrypoint sh dev -c '${G} && npm install'`,
    expect: 'F',
  },
  {
    id: 'R2d-s',
    kind: 'sh',
    text: `docker compose run --rm dev sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'R2d',
  },
  { id: 'R2e', kind: 'sh', text: `docker exec -e X=1 c sh -c '${G} && npm install'`, expect: '-' },
  { id: 'R2f', kind: 'sh', text: "docker exec c sh -c '$G && npm install'", expect: 'F' },
  {
    id: 'R2f-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'R2f',
  },
  {
    id: 'R2g',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && echo "&&"; npm install'`,
    expect: 'F',
  },
  {
    id: 'R2g-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && echo "&&" && npm install'`,
    expect: '-',
    safeTwinOf: 'R2g',
  },
  {
    id: 'R2h',
    kind: 'sh',
    text: `docker exec c sh -c '${G} # comment && npm install'`,
    expect: 'F',
  },
  {
    id: 'R2h-s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm install # comment'`,
    expect: '-',
    safeTwinOf: 'R2h',
  },
  {
    id: 'R2i',
    kind: 'sh',
    text: `docker exec -i c sh -s <<'EOF'\n${G} && npm install\nEOF`,
    expect: 'F',
  },
  {
    id: 'R2i-s',
    kind: 'sh',
    text: `docker exec -i c sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'R2i',
  },
  // Implementation rows (not in the plan's 79 + 9)
  {
    id: 'N01',
    kind: 'sh',
    text: 'docker exec c npm -C /app install',
    expect: 'F',
    note: 'upper-case short flag',
  },
  {
    id: 'N01s',
    kind: 'sh',
    text: `docker exec c sh -c '${G} && npm -C /app install'`,
    expect: '-',
    safeTwinOf: 'N01',
  },
  {
    id: 'N02',
    kind: 'sh',
    text: 'docker exec "$C" npm install --package-lock-only=false',
    expect: 'F',
    note: 'an explicit false is a full install',
  },
  {
    id: 'N02s',
    kind: 'sh',
    text: `docker exec "$C" sh -c '${G} && npm install --package-lock-only=false'`,
    expect: '-',
    safeTwinOf: 'N02',
  },
  {
    id: 'N03',
    kind: 'sh',
    text: 'docker exec "$C" npm install --package-lock-only=true',
    expect: 'L',
  },
  {
    id: 'N03s',
    kind: 'sh',
    text: `docker exec "$C" sh -c '${G} && npm install --package-lock-only=true'`,
    expect: '-',
    safeTwinOf: 'N03',
  },
  {
    id: 'N04',
    kind: 'sh',
    text: 'docker compose -p proj --env-file .env.dev exec dev npm install',
    expect: 'F',
  },
  {
    id: 'N04s',
    kind: 'sh',
    text: `docker compose -p proj --env-file .env.dev exec dev sh -c '${G} && npm install'`,
    expect: '-',
    safeTwinOf: 'N04',
  },
  {
    id: 'N05',
    kind: 'sh',
    text: "docker exec c sh -c 'sh /app/scripts/lib/node-modules-mount-gate.sh && npm install'",
    expect: '-',
  },
  {
    id: 'N06',
    kind: 'sh',
    text: "docker exec c sh -c 'bash scripts/lib/node-modules-mount-gate.sh && npm install'",
    expect: '-',
  },
  {
    id: 'N07',
    kind: 'sh',
    text: `bash -c 'docker exec c sh -c '\\''${G} && npm rebuild x'\\'''`,
    expect: '-',
    note: "'\\'' delimiter",
  },
  {
    id: 'N08',
    kind: 'sh',
    text: `bash -c "docker exec c sh -c \\"${G} && npm install\\""`,
    expect: '-',
    note: '\\" delimiter',
  },
  // PR #2857 gate finding SMI-6654-1: a shorter or other-character fence line
  // inside a fenced block is content, not a fence transition (CommonMark). The
  // old toggle flipped into prose mode on the inner line, split the launcher and
  // the verb onto separate units, and reported nothing.
  {
    id: 'N09',
    kind: 'md',
    text: "````bash\n```\ndocker exec c sh -c '\nnpm install\n'\n```\n````",
    expect: 'F',
    note: 'triple-backtick line inside a four-backtick fence',
  },
  {
    id: 'N09s',
    kind: 'md',
    text: `\`\`\`\`bash\n\`\`\`\ndocker exec c sh -c '${G} && npm install'\n\`\`\`\n\`\`\`\``,
    expect: '-',
    safeTwinOf: 'N09',
    shellFragment: `docker exec c sh -c '${G} && npm install'`,
  },
  {
    id: 'N10',
    kind: 'md',
    text: "```bash\n~~~\ndocker exec c sh -c '\nnpm install\n'\n~~~\n```",
    expect: 'F',
    note: 'tilde fence line inside a backtick fence',
  },
  {
    id: 'N10s',
    kind: 'md',
    text: `\`\`\`bash\n~~~\ndocker exec c sh -c '${G} && npm install'\n~~~\n\`\`\``,
    expect: '-',
    safeTwinOf: 'N10',
    shellFragment: `docker exec c sh -c '${G} && npm install'`,
  },
  {
    id: 'N11',
    kind: 'md',
    text: "~~~bash\n```\ndocker exec c sh -c '\nnpm install\n'\n```\n~~~",
    expect: 'F',
    note: 'backtick fence line inside a tilde fence',
  },
  {
    id: 'N11s',
    kind: 'md',
    text: `~~~bash\n\`\`\`\ndocker exec c sh -c '${G} && npm install'\n\`\`\`\n~~~`,
    expect: '-',
    safeTwinOf: 'N11',
    shellFragment: `docker exec c sh -c '${G} && npm install'`,
  },
]

// ── B-1: one row per npm mutation alias, with a hand-authored safe twin ─────
// Deliberately duplicated from the helper rather than imported: a list derived
// from the helper would shrink silently when an alias is removed there, and
// this corpus exists to notice exactly that. Source: npm 10.9.7
// docs/content/commands/npm-*.md (plan M-8), plus `prune` and `audit fix`.
const ALIASES: Array<[alias: string, ungated: string, twin: string]> = [
  ['install', 'docker exec c npm install', `docker exec -w /app c sh -c '${G} && npm install'`],
  ['add', 'docker exec c npm add', `docker exec -w /app c sh -c '${G} && npm add'`],
  ['i', 'docker exec c npm i', `docker exec -w /app c sh -c '${G} && npm i'`],
  ['in', 'docker exec c npm in', `docker exec -w /app c sh -c '${G} && npm in'`],
  ['ins', 'docker exec c npm ins', `docker exec -w /app c sh -c '${G} && npm ins'`],
  ['inst', 'docker exec c npm inst', `docker exec -w /app c sh -c '${G} && npm inst'`],
  ['insta', 'docker exec c npm insta', `docker exec -w /app c sh -c '${G} && npm insta'`],
  ['instal', 'docker exec c npm instal', `docker exec -w /app c sh -c '${G} && npm instal'`],
  ['isnt', 'docker exec c npm isnt', `docker exec -w /app c sh -c '${G} && npm isnt'`],
  ['isnta', 'docker exec c npm isnta', `docker exec -w /app c sh -c '${G} && npm isnta'`],
  ['isntal', 'docker exec c npm isntal', `docker exec -w /app c sh -c '${G} && npm isntal'`],
  ['isntall', 'docker exec c npm isntall', `docker exec -w /app c sh -c '${G} && npm isntall'`],
  ['ci', 'docker exec c npm ci', `docker exec -w /app c sh -c '${G} && npm ci'`],
  [
    'clean-install',
    'docker exec c npm clean-install',
    `docker exec -w /app c sh -c '${G} && npm clean-install'`,
  ],
  ['ic', 'docker exec c npm ic', `docker exec -w /app c sh -c '${G} && npm ic'`],
  [
    'install-clean',
    'docker exec c npm install-clean',
    `docker exec -w /app c sh -c '${G} && npm install-clean'`,
  ],
  [
    'isntall-clean',
    'docker exec c npm isntall-clean',
    `docker exec -w /app c sh -c '${G} && npm isntall-clean'`,
  ],
  [
    'install-test',
    'docker exec c npm install-test',
    `docker exec -w /app c sh -c '${G} && npm install-test'`,
  ],
  ['it', 'docker exec c npm it', `docker exec -w /app c sh -c '${G} && npm it'`],
  [
    'install-ci-test',
    'docker exec c npm install-ci-test',
    `docker exec -w /app c sh -c '${G} && npm install-ci-test'`,
  ],
  ['cit', 'docker exec c npm cit', `docker exec -w /app c sh -c '${G} && npm cit'`],
  [
    'clean-install-test',
    'docker exec c npm clean-install-test',
    `docker exec -w /app c sh -c '${G} && npm clean-install-test'`,
  ],
  ['sit', 'docker exec c npm sit', `docker exec -w /app c sh -c '${G} && npm sit'`],
  ['update', 'docker exec c npm update', `docker exec -w /app c sh -c '${G} && npm update'`],
  ['up', 'docker exec c npm up', `docker exec -w /app c sh -c '${G} && npm up'`],
  ['upgrade', 'docker exec c npm upgrade', `docker exec -w /app c sh -c '${G} && npm upgrade'`],
  ['udpate', 'docker exec c npm udpate', `docker exec -w /app c sh -c '${G} && npm udpate'`],
  [
    'uninstall',
    'docker exec c npm uninstall x',
    `docker exec -w /app c sh -c '${G} && npm uninstall x'`,
  ],
  ['unlink', 'docker exec c npm unlink x', `docker exec -w /app c sh -c '${G} && npm unlink x'`],
  ['remove', 'docker exec c npm remove x', `docker exec -w /app c sh -c '${G} && npm remove x'`],
  ['rm', 'docker exec c npm rm x', `docker exec -w /app c sh -c '${G} && npm rm x'`],
  ['r', 'docker exec c npm r x', `docker exec -w /app c sh -c '${G} && npm r x'`],
  ['un', 'docker exec c npm un x', `docker exec -w /app c sh -c '${G} && npm un x'`],
  ['rebuild', 'docker exec c npm rebuild', `docker exec -w /app c sh -c '${G} && npm rebuild'`],
  ['rb', 'docker exec c npm rb', `docker exec -w /app c sh -c '${G} && npm rb'`],
  ['dedupe', 'docker exec c npm dedupe', `docker exec -w /app c sh -c '${G} && npm dedupe'`],
  ['ddp', 'docker exec c npm ddp', `docker exec -w /app c sh -c '${G} && npm ddp'`],
  ['link', 'docker exec c npm link x', `docker exec -w /app c sh -c '${G} && npm link x'`],
  ['ln', 'docker exec c npm ln x', `docker exec -w /app c sh -c '${G} && npm ln x'`],
  ['prune', 'docker exec c npm prune', `docker exec -w /app c sh -c '${G} && npm prune'`],
  [
    'audit fix',
    'docker exec c npm audit fix',
    `docker exec -w /app c sh -c '${G} && npm audit fix'`,
  ],
]
const ALIAS_ROWS: Row[] = ALIASES.flatMap(([alias, ungated, twin]) => {
  const id = `AL-${alias.replace(/\s+/g, '-')}`
  return [
    { id, kind: 'sh' as Kind, text: ungated, expect: 'F' as Expect },
    { id: `${id}-s`, kind: 'sh' as Kind, text: twin, expect: '-' as Expect, safeTwinOf: id },
  ]
})

// ── B-1: arm B corpus ─────────────────────────────────────────────────────
type ArmBExpect = 'block' | 'warn' | 'none'
const ARM_B: Array<{ id: string; text: string; expect: ArmBExpect }> = [
  { id: 'B01', text: 'if mountpoint -q /app/node_modules; then', expect: 'block' },
  { id: 'B02', text: 'NM=/app/node_modules\nif mountpoint -q "$NM"; then', expect: 'block' },
  { id: 'B02w', text: 'if mountpoint -q "$TARGET"; then', expect: 'warn' },
  {
    id: 'B03',
    text: '# `mountpoint -q` returns 0 for ANY mount reachable at a path',
    expect: 'none',
  },
  { id: 'B04', text: 'docker exec c mountpoint -q /app/node_modules', expect: 'block' },
  { id: 'B05', text: 'findmnt --target /app/node_modules', expect: 'block' },
  {
    id: 'B06',
    text: '# a virtiofs host bind at the identical mountpoint, and the checker',
    expect: 'none',
  },
  { id: 'B07', text: 'echo "run: mountpoint /app/.cache"', expect: 'warn' },
  {
    id: 'B08',
    text: '# Parses /proc/self/mountinfo directly rather than calling `mountpoint`:',
    expect: 'none',
  },
]

const CORPUS_A: Row[] = [...ARM_A, ...ALIAS_ROWS]

function classifyA(kind: Kind, text: string): Expect {
  const r = scanText(text, kind === 'md')
  const verdicts: string[] = r.verbs.map((v: { verdict: string }) => v.verdict)
  const clean = new Set(['safe', 'safe-rc', 'lock-only-unverified'])
  if (r.unresolved.length > 0 || verdicts.some((v) => !clean.has(v))) return 'F'
  return verdicts.includes('lock-only-unverified') ? 'L' : '-'
}

function classifyB(text: string): ArmBExpect {
  const probes: Array<{ severity: string }> = probeMounts(text)
  if (probes.some((p) => p.severity === 'block')) return 'block'
  return probes.length > 0 ? 'warn' : 'none'
}

/** The shell text inside a twin that `sh -n` can judge: whole sh rows, launcher spans in md/ts. */
function shellFragmentsOf(row: Row): string[] {
  if (row.kind === 'sh') return [row.text]
  if (row.kind === 'ts') {
    const m = /(docker|\.\/scripts\/worktree-docker\.sh)[^\\]*/.exec(row.text)
    return m ? [m[0]] : []
  }
  if (row.shellFragment !== undefined) return [row.shellFragment]
  // The complete content of each outermost fence (either character, any length),
  // validated unchanged.
  const fenced = [...row.text.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/gm)].map(
    (m) => m[2]
  )
  if (fenced.length > 0) return fenced
  return row.text.split('`').filter((span) => /\bdocker\b|worktree-docker\.sh/.test(span))
}

const executed = { total: 0, F: 0, clean: 0, L: 0, safeTwins: 0, block: 0, warn: 0, none: 0 }
const aliasesHonoured = new Set<string>()

afterAll(() => {
  const line =
    `cases=${executed.total} F=${executed.F} clean=${executed.clean} L=${executed.L} ` +
    `safeTwins=${executed.safeTwins} armB(block/warn/none)=${executed.block}/${executed.warn}/${executed.none} ` +
    `aliases=${aliasesHonoured.size}/${ALIASES.length} (artifact-sourced)`
  console.log(line)
  expect(executed.total).toBeGreaterThan(0)
  expect(aliasesHonoured.size).toBe(ALIASES.length)
  const pinned = Number(readFileSync(EXPECTED_COUNT_FILE, 'utf8').trim())
  expect(executed.total).toBe(pinned)
})

// ── B-2: static pairing checks, before any row is classified ─────────────────
describe('B-2 safe-twin pairing (static, no classifier)', () => {
  const byId = new Map(CORPUS_A.map((r) => [r.id, r]))

  it('has unique row ids and 41 unique aliases', () => {
    expect(byId.size).toBe(CORPUS_A.length)
    expect(new Set(ALIASES.map((a) => a[0])).size).toBe(41)
  })

  it('gives every ungated arm-A row at least one safe twin, and every twin a differing expectation', () => {
    const missing: string[] = []
    for (const row of CORPUS_A) {
      if (row.expect === '-') continue
      if (!CORPUS_A.some((t) => t.safeTwinOf === row.id)) missing.push(row.id)
    }
    expect(missing, 'ungated rows with no hand-authored safe twin').toEqual([])
    for (const twin of CORPUS_A.filter((r) => r.safeTwinOf)) {
      const base = byId.get(twin.safeTwinOf as string)
      expect(base, `${twin.id} names a missing base row`).toBeDefined()
      expect(twin.expect, `${twin.id} must be a clean twin`).toBe('-')
      expect(base?.expect, `${twin.id} and ${base?.id} expect the same outcome`).not.toBe(
        twin.expect
      )
      expect(twin.text, `${twin.id} is byte-identical to its base`).not.toBe(base?.text)
    }
  })

  it('parses every twin as shell with sh -n -c, so a twin cannot bless malformed shell', () => {
    for (const twin of CORPUS_A.filter((r) => r.safeTwinOf)) {
      const fragments = shellFragmentsOf(twin)
      expect(fragments.length, `${twin.id} yielded no shell text to parse`).toBeGreaterThan(0)
      for (const fragment of fragments) {
        expect(
          () => execFileSync('sh', ['-n', '-c', fragment], { stdio: 'pipe' }),
          `${twin.id}: ${fragment}`
        ).not.toThrow()
      }
    }
  })
})

describe('B-1 arm A corpus', () => {
  for (const row of CORPUS_A) {
    it(`${row.id} → ${row.expect}${row.note ? ` (${row.note})` : ''}`, () => {
      executed.total++
      if (row.safeTwinOf) executed.safeTwins++
      if (row.expect === 'F') executed.F++
      else if (row.expect === 'L') executed.L++
      else executed.clean++
      expect(classifyA(row.kind, row.text)).toBe(row.expect)
    })
  }

  it('honours every alias: its ungated row is a finding and its twin is clean', () => {
    for (const [alias, ungated, twin] of ALIASES) {
      if (classifyA('sh', ungated) === 'F' && classifyA('sh', twin) === '-')
        aliasesHonoured.add(alias)
    }
    expect([...aliasesHonoured].length).toBe(ALIASES.length)
  })
})

describe('B-1 arm B corpus', () => {
  for (const row of ARM_B) {
    it(`${row.id} → ${row.expect}`, () => {
      executed.total++
      executed[row.expect]++
      expect(classifyB(row.text)).toBe(row.expect)
    })
  }
})

describe('logicalUnits joins and resolution', () => {
  it('reports an unclosed sh -c quote at EOF as split-unresolved', () => {
    const units = logicalUnits("docker exec -w /app c sh -c '\n npm install\n", false)
    expect(units.some((u: { splitUnresolved: boolean }) => u.splitUnresolved)).toBe(true)
  })

  it('never joins a markdown unit across a fence line', () => {
    const units = logicalUnits("```bash\ndocker exec c sh -c '\n```\nnpm install\n", true)
    expect(units.some((u: { splitUnresolved: boolean }) => u.splitUnresolved)).toBe(true)
    expect(classifyA('md', "```bash\ndocker exec c sh -c '\n```\nnpm install\n")).toBe('F')
  })
})

// ── Report branches (fixture repos) ─────────────────────────────────────────
describe('evaluateContainerNpmGate + containerNpmGateReportLines', () => {
  const roots: string[] = []
  const SHADOW = new Date('2026-09-14T12:00:00Z')
  const ENFORCE = new Date('2026-10-06T12:00:00Z')

  function makeRepo(files: Record<string, string | Buffer>): string {
    const root = makeFixtureTempDir('smi6654-gate')
    roots.push(root)
    const env = makeFixtureEnv()
    execFileSync('git', ['-C', root, 'init', '-q'], { env })
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), content)
      execFileSync('git', ['-C', root, 'add', '--', rel], { env })
    }
    return root
  }

  afterAll(() => {
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
  })

  type Line = { severity: string; message: string; fix?: string }
  const PREFIXES = [
    /^Check 72: clean — scanned=\d+ /,
    /^Check 72 FINDING \[(A:[a-z-]+|B:node_modules-probe|allowlist:stale)\] /,
    /^Check 72 WARN \[lock-only-unverified\] /,
    /^Check 72 WARN \[B:mount-probe\] /,
    /^Check 72 NOT-EVALUATED — /,
  ]
  const FINDINGS_ONLY = /Check 72 (FINDING \[|NOT-EVALUATED)/

  function assertWellFormed(lines: Line[]): void {
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(['pass', 'warn', 'fail']).toContain(l.severity)
      expect(
        PREFIXES.filter((p) => p.test(l.message)),
        l.message
      ).toHaveLength(1)
      const isFindingClass = /^Check 72 (FINDING|NOT-EVALUATED)/.test(l.message)
      expect(FINDINGS_ONLY.test(l.message)).toBe(isFindingClass)
    }
  }

  it('pins the shipped constants', () => {
    expect(CHECK_72_SHADOW_END_DATE).toBe('2026-10-05')
    expect(LOCK_ONLY_EXEMPTION_VERIFIED).toBe(false)
    expect(Object.keys(CONTAINER_NPM_GATE_ALLOWLIST_JUSTIFICATIONS)).toEqual([])
    expect(new Date(CHECK_72_SHADOW_END_DATE).toISOString()).toBe('2026-10-05T00:00:00.000Z')
  })

  it('clean: one pass line carrying the denominators, excluded paths not scanned', () => {
    const root = makeRepo({
      'ok.sh': `docker exec -w /app c sh -c '${G} && npm install'\n`,
      'tests/ignored.sh': 'docker exec c npm install\n',
      'fixtures/ignored.md': 'Run `docker exec c npm ci`\n',
      'x.test.ts': "const s = 'docker exec c npm install'\n",
      'blob.bin': Buffer.from([0x64, 0x00, 0x6e]),
    })
    const verdict = evaluateContainerNpmGate(root, { isCI: false, now: SHADOW })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.counts).toMatchObject({ scanned: 1, safe: 1, tests: 3, binary: 1, gitlink: 0 })
    const lines: Line[] = containerNpmGateReportLines(verdict)
    assertWellFormed(lines)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('pass')
    expect(lines[0].message).toContain(
      'scanned=1 safe=1 lockOnly=0 allowlisted=0 excluded(tests/binary/gitlink)=3/1/0'
    )
  })

  it('counts a gitlink as excluded, not scanned', () => {
    const root = makeRepo({ 'ok.md': 'nothing here\n' })
    execFileSync(
      'git',
      ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`],
      {
        env: makeFixtureEnv(),
      }
    )
    const verdict = evaluateContainerNpmGate(root, { now: SHADOW })
    expect(verdict.counts).toMatchObject({ gitlink: 1, scanned: 1 })
  })

  it('findings: one FINDING line per ungated verb, warn in shadow, with denominators', () => {
    const root = makeRepo({
      'bad.sh': 'x\ndocker exec c npm install\n',
      'probe.sh': 'mountpoint -q /app/node_modules\n',
    })
    const lines: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: SHADOW })
    )
    assertWellFormed(lines)
    expect(lines.map((l) => l.message.split(' — ')[0])).toEqual([
      'Check 72 FINDING [A:outside-container-shell] bad.sh:2',
      'Check 72 FINDING [B:node_modules-probe] probe.sh:1',
    ])
    for (const l of lines) {
      expect(l.severity).toBe('warn')
      expect(l.message).toContain('{scanned=2 ')
      expect(l.message).toContain('shadow mode through 2026-10-05')
    }
    expect(lines.some((l) => l.severity === 'pass')).toBe(false)
  })

  it('lock-only: WARN beside a clean line until verified, then nothing', () => {
    const root = makeRepo({ 'lock.sh': 'docker exec "$C" npm install --package-lock-only\n' })
    const lines: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: ENFORCE })
    )
    assertWellFormed(lines)
    expect(lines.map((l) => l.severity)).toEqual(['pass', 'warn'])
    expect(lines[1].message).toMatch(/^Check 72 WARN \[lock-only-unverified\] lock\.sh:1 /)
    const verified: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: ENFORCE, lockOnlyExemptionVerified: true })
    )
    expect(verified.map((l) => l.severity)).toEqual(['pass'])
    expect(verified[0].message).toContain('lockOnly=1')
  })

  it('B-warn: a non-node_modules probe stays warn after the flip and is allowlistable', () => {
    const root = makeRepo({ 'p.sh': 'if mountpoint -q "$TARGET"; then :; fi\n' })
    const lines: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: ENFORCE })
    )
    assertWellFormed(lines)
    expect(lines.map((l) => l.severity)).toEqual(['pass', 'warn'])
    expect(lines[1].message).toMatch(/^Check 72 WARN \[B:mount-probe\] p\.sh:1 /)
    const allowlist = { 'p.sh:if mountpoint -q "$TARGET"; then :; fi': 'fixture reason' }
    const allowed: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: ENFORCE, allowlist })
    )
    expect(allowed).toHaveLength(1)
    expect(allowed[0].message).toContain('allowlisted=1')
  })

  it('stale allowlist key: reported as a FINDING that flips with the check', () => {
    const root = makeRepo({ 'ok.md': 'nothing\n' })
    const allowlist = { 'gone.sh:docker exec c npm install': 'line was removed' }
    const shadow: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: SHADOW, allowlist })
    )
    const enforce: Line[] = containerNpmGateReportLines(
      evaluateContainerNpmGate(root, { now: ENFORCE, allowlist })
    )
    assertWellFormed([...shadow, ...enforce])
    expect(shadow.map((l) => [l.severity, l.message.split(' — ')[0]])).toEqual([
      ['warn', "Check 72 FINDING [allowlist:stale] 'gone.sh:docker exec c npm install'"],
    ])
    expect(enforce[0].severity).toBe('fail')
  })

  it('not evaluated: fail under CI, warn locally, never a pass, and nothing counted', () => {
    const dir = makeFixtureTempDir('smi6654-nogit')
    roots.push(dir)
    writeFileSync(join(dir, 'a.sh'), 'docker exec c npm install\n')
    const ci = evaluateContainerNpmGate(dir, { isCI: true, now: SHADOW })
    const local = evaluateContainerNpmGate(dir, { isCI: false, now: SHADOW })
    expect(ci).toMatchObject({ status: 'not_evaluated', severity: 'fail' })
    expect(local).toMatchObject({ status: 'not_evaluated', severity: 'warn' })
    expect(local.findings).toBeUndefined()
    expect(local.counts).toBeUndefined()
    const ciLines: Line[] = containerNpmGateReportLines(ci)
    const localLines: Line[] = containerNpmGateReportLines(local)
    assertWellFormed([...ciLines, ...localLines])
    expect(ciLines.map((l) => l.severity)).toEqual(['fail'])
    expect(localLines.map((l) => l.severity)).toEqual(['warn'])
    expect(localLines[0].fix).toContain('SMI-6524')
    expect(ciLines[0].fix).not.toBe(localLines[0].fix)
  })

  it('flips at UTC midnight: 2026-10-04T23:59Z is shadow, 2026-10-05T00:01Z enforces', () => {
    const root = makeRepo({ 'bad.sh': 'docker exec c npm ci\n' })
    const before = evaluateContainerNpmGate(root, { now: new Date('2026-10-04T23:59:00Z') })
    const after = evaluateContainerNpmGate(root, { now: new Date('2026-10-05T00:01:00Z') })
    expect(before.inShadow).toBe(true)
    expect(after.inShadow).toBe(false)
    const b: Line[] = containerNpmGateReportLines(before)
    const a: Line[] = containerNpmGateReportLines(after)
    expect(b.map((l) => l.severity)).toEqual(['warn'])
    expect(a.map((l) => l.severity)).toEqual(['fail'])
    expect(b[0].message).toContain('shadow mode through 2026-10-05')
    expect(a[0].message).not.toContain('shadow mode')
  })
})

// ── F-4: live-repo twin disposition ────────────────────────────────────────
describe('liveScanDisposition', () => {
  const base = {
    isCI: false,
    gitIsDirectory: false,
    inDocker: false,
    gitfileTargetMissing: false,
    enumerationOk: false,
  }
  const cases: Array<[string, Partial<typeof base>, 'run' | 'fail' | 'skip']> = [
    ['enumeration ok runs, anywhere', { enumerationOk: true, isCI: true }, 'run'],
    [
      'CI + enumeration failure fails',
      { isCI: true, inDocker: true, gitfileTargetMissing: true },
      'fail',
    ],
    [
      'a real .git directory + failure fails, even without CI',
      { gitIsDirectory: true, inDocker: true },
      'fail',
    ],
    [
      'local container with a dangling gitfile skips',
      { inDocker: true, gitfileTargetMissing: true },
      'skip',
    ],
    ['dangling gitfile outside a container fails', { gitfileTargetMissing: true }, 'fail'],
    ['container with a resolvable gitfile fails', { inDocker: true }, 'fail'],
    ['no .git at all fails', {}, 'fail'],
  ]
  for (const [label, over, want] of cases) {
    it(label, () => expect(liveScanDisposition({ ...base, ...over })).toBe(want))
  }
})

function gitState(): { gitIsDirectory: boolean; gitfileTargetMissing: boolean } {
  const dotGit = join(REPO_ROOT, '.git')
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return { gitIsDirectory: true, gitfileTargetMissing: false }
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    return {
      gitIsDirectory: false,
      gitfileTargetMissing:
        Boolean(m) && !existsSync(resolve(REPO_ROOT, (m as RegExpExecArray)[1].trim())),
    }
  } catch {
    return { gitIsDirectory: false, gitfileTargetMissing: false }
  }
}

describe('live repo scan (F-4)', () => {
  it(
    'finds zero Check 72 findings repo-wide, having scanned more than 2000 files',
    (ctx) => {
      const isCI = Boolean(process.env.CI)
      const verdict = evaluateContainerNpmGate(REPO_ROOT, { isCI, now: new Date() })
      const disposition = liveScanDisposition({
        isCI,
        inDocker: existsSync('/.dockerenv'),
        enumerationOk: verdict.status === 'evaluated',
        ...gitState(),
      })
      if (disposition === 'skip') {
        const reason =
          'git ls-files cannot run here: a local container whose .git gitfile names a missing host path (SMI-6524). ' +
          `The host run and CI cover this scan. ${verdict.reason}`
        console.log(`container-npm-gate live-scan: status=skipped reason=${reason}`)
        ctx.skip(reason)
        return
      }
      if (disposition === 'fail') {
        console.log(`container-npm-gate live-scan: status=failed reason=${verdict.reason}`)
        throw new Error(
          `Check 72 live scan could not enumerate tracked files in an environment that must (CI or a real .git directory): ${verdict.reason}`
        )
      }
      console.log(
        `container-npm-gate live-scan: status=ran files=${verdict.counts.scanned} findings=${verdict.findings.length}`
      )
      expect(verdict.findings).toEqual([])
      expect(verdict.counts.scanned).toBeGreaterThan(2000)
    },
    REPO_WALK_TIMEOUT_MS
  )
})
