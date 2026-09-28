/**
 * Twin test for `scripts/ruflo-host-guard.mjs` (SMI-6744 Wave 4 / A4.6).
 *
 * Same two-part shape as `env-read-guard.test.ts`: a real-file
 * registration pin plus a table-driven `decide()` case table, per
 * docs/internal/implementation/smi-6744-ruflo-host-guard.md's own
 * "Twin test" section, built from the 62-row adversarial census in
 * docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md § 5.
 *
 * Every deny row's predicate label was MEASURED against this guard's own
 * decide() (not assumed from the census's "Closed by" column) before being
 * hardcoded here — several rows are closed by a different H-predicate, or
 * an H-predicate at all, than the census's own shorthand once this guard's
 * actual segment-splitting/wrapper-normalization order is run (e.g. C6 and
 * C9 are closed by H1 in this implementation, not the census's cited H3/H7,
 * because H1 is checked first and both paths already contain the
 * `node_modules/ruflo` or `lib/node_modules/ruflo` substring H1 tests for).
 *
 * D9, D10 and E6 are excluded from the census table below, per the plan:
 * D9/D10 (`ln -s …` / `cp …` then invoke the copy) are closed ONLY by
 * host-tree removal (Layer X) — this guard correctly ALLOWS the isolated
 * second step (`node /tmp/x …`), which names nothing ruflo-shaped; E6
 * (`mcp__ruflo__terminal_execute`) is not a Bash spelling at all, closed by
 * an MCP deny this plan does not touch. D11 is tested separately below (H8
 * arms), not via the generic census loop, since its own census "Closed by"
 * text does not literally contain "H" in the source census's original
 * form (H8 was added to close it in this design's own round 1).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { decide } from '../ruflo-host-guard.mjs'

const SETTINGS_PATH = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url))
const GUARD_SCRIPT_PATH = fileURLToPath(new URL('../ruflo-host-guard.mjs', import.meta.url))

function bashCall(command: string) {
  return { tool_name: 'Bash', tool_input: { command } }
}

function sessionStartCall(toolInput: unknown) {
  return { tool_name: 'mcp__ruflo__hooks_session-start', tool_input: toolInput }
}

function reasonOf(result: ReturnType<typeof decide>): string {
  return result.json?.hookSpecificOutput?.permissionDecisionReason ?? ''
}

// --- Registration pin ---

describe('.claude/settings.json registration (regression pin)', () => {
  it('registers ruflo-host-guard.mjs on the Bash PreToolUse matcher', () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const preToolUse = settings.hooks?.PreToolUse
    expect(Array.isArray(preToolUse)).toBe(true)

    const bashEntry = preToolUse.find((entry: { matcher?: string }) => entry.matcher === 'Bash')
    expect(bashEntry).toBeDefined()
    const hasGuardHook = (bashEntry.hooks ?? []).some(
      (hook: Record<string, unknown>) =>
        hook.type === 'command' &&
        typeof hook.command === 'string' &&
        hook.command.includes('node') &&
        hook.command.includes('scripts/ruflo-host-guard.mjs')
    )
    expect(hasGuardHook).toBe(true)
  })

  it('registers ruflo-host-guard.mjs on the ^mcp__ruflo__hooks_session-start$ matcher', () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const preToolUse = settings.hooks?.PreToolUse
    const entry = preToolUse.find(
      (e: { matcher?: string }) => e.matcher === '^mcp__ruflo__hooks_session-start$'
    )
    expect(entry).toBeDefined()
    const hasGuardHook = (entry.hooks ?? []).some(
      (hook: Record<string, unknown>) =>
        hook.type === 'command' &&
        typeof hook.command === 'string' &&
        hook.command.includes('node') &&
        hook.command.includes('scripts/ruflo-host-guard.mjs')
    )
    expect(hasGuardHook).toBe(true)
  })
})

// --- Full census table (58 rows: 57 H-closed deny + E1 sanctioned allow) ---
// [census id, command, expected action, expected predicate substring or null]
const CENSUS_ROWS: Array<[string, string, 'allow' | 'deny', string | null]> = [
  ['A1', 'npx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A2', 'npx -y ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A3', 'npx --yes ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A4', 'npx ruflo@3.14.2 memory store --key k --value v', 'deny', 'H5'],
  ['A5', 'npx -p ruflo ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A6', 'npx --package=ruflo ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A7', 'npm exec ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A8', 'npm exec -- ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A9', 'npm x ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A10', 'pnpm dlx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A11', 'yarn dlx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A12', 'corepack npx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A13', 'bunx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A14', 'deno run -A npm:ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A15', 'npx --cache=/tmp ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A16', 'NPM_CONFIG_CACHE=/tmp npx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['A17', 'npx @claude-flow/cli mcp start', 'deny', 'H5'],
  // A18 is the SAME string as A1, deliberately (SMI-6744 Wave 4 L-9
  // governance finding, not a copy-paste duplicate): the census
  // distinguishes A1/A18 by HOST STATE (an npx local-cache miss vs. hit),
  // which this guard's decide() cannot observe -- it only ever sees the
  // command STRING -- so the two rows are expected to collapse to
  // identical input/output here.
  ['A18', 'npx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['B1', 'node node_modules/ruflo/bin/ruflo.js memory store --key k --value v', 'deny', 'H1'],
  ['B2', 'node ./node_modules/ruflo/bin/ruflo.js memory store --key k --value v', 'deny', 'H1'],
  [
    'B3',
    'node /Users/x/skillsmith/node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  [
    'B4',
    'node "$PWD/node_modules/ruflo/bin/ruflo.js" memory store --key k --value v',
    'deny',
    'H1',
  ],
  ['B5', 'cd node_modules/ruflo && node bin/ruflo.js memory store --key k --value v', 'deny', 'H1'],
  ['B6', 'node node_modules/@claude-flow/cli/bin/cli.js mcp start', 'deny', 'H2'],
  ['B7', 'node node_modules/@claude-flow/cli/bin/mcp-server.js', 'deny', 'H2'],
  ['B8', 'node -e "import(\'./node_modules/ruflo/bin/ruflo.js\')"', 'deny', 'H1'],
  ['B9', "node --import ./node_modules/ruflo/bin/ruflo.js -e ''", 'deny', 'H1'],
  ['B10', 'node node_modules/.bin/ruflo memory store --key k --value v', 'deny', 'H3'],
  ['C1', './node_modules/.bin/ruflo memory store --key k --value v', 'deny', 'H3'],
  ['C2', 'node_modules/.bin/ruflo memory store --key k --value v', 'deny', 'H3'],
  ['C3', 'node_modules/.bin/claude-flow memory store --key k --value v', 'deny', 'H3'],
  ['C4', 'node_modules/.bin/claude-flow-mcp', 'deny', 'H3'],
  ['C5', 'node_modules/.bin/cli memory store --key k --value v', 'deny', 'H3'],
  ['C6', 'node_modules/ruflo/bin/ruflo.js memory store --key k --value v', 'deny', 'H1'],
  ['C7', 'ruflo memory store --key k --value v', 'deny', 'H4'],
  [
    'C8',
    '/Users/x/.nvm/versions/node/v22.22.2/bin/ruflo memory store --key k --value v',
    'deny',
    'H7',
  ],
  [
    'C9',
    'node /Users/x/.nvm/versions/node/v22.22.2/lib/node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  ['C10', 'claude-flow memory store --key k --value v', 'deny', 'H4'],
  [
    'D1',
    'command node node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  [
    'D2',
    'env X=1 node node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  ['D3', 'env RUFLO_DEBUG=1 ruflo memory store --key k --value v', 'deny', 'H4'],
  [
    'D4',
    "sh -c 'node node_modules/ruflo/bin/ruflo.js memory store --key k --value v'",
    'deny',
    'H1',
  ],
  ['D5', "bash -lc 'ruflo memory store --key k --value v'", 'deny', 'H4'],
  [
    'D6',
    'eval "node node_modules/ruflo/bin/ruflo.js memory store --key k --value v"',
    'deny',
    'H1',
  ],
  ['D7', "echo 'memory store --key k' | xargs node node_modules/ruflo/bin/ruflo.js", 'deny', 'H1'],
  [
    'D8',
    "find node_modules/ruflo/bin -name 'ruflo.js' -exec node {} memory store --key k \\;",
    'deny',
    'H1',
  ],
  ['D12', 'noglob npx ruflo memory store --key k --value v', 'deny', 'H5'],
  ['D13', 'NODE_OPTIONS="--require ./node_modules/ruflo/bin/ruflo.js" node -e \'\'', 'deny', 'H1'],
  ['D14', 'sudo node node_modules/ruflo/bin/ruflo.js memory store --key k --value v', 'deny', 'H1'],
  [
    'E1',
    'docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js mcp start',
    'allow',
    null,
  ],
  [
    'E2',
    'docker exec skillsmith-dev-1 node node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  [
    'E3',
    'docker run --rm -v "$PWD":/app node:22-slim node /app/node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  ['E4', 'docker run --rm node:22-slim npx -y ruflo memory store --key k --value v', 'deny', 'H5'],
  [
    'E5',
    'docker compose --profile dev run --rm dev node node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  [
    'F1',
    'node ~/.npm/_npx/5136ad6db8e498e9/node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
  [
    'F2',
    '~/.npm/_npx/489f51a63dd46519/node_modules/.bin/ruflo memory store --key k --value v',
    'deny',
    'H3',
  ],
  [
    'F3',
    'node ~/.npm/_npx/85fb20e3e7e3a233/node_modules/@claude-flow/cli/bin/cli.js mcp start',
    'deny',
    'H2',
  ],
  [
    'F4',
    'node ~/.npm/_npx/5e4ef4085681fb7a/node_modules/ruflo/bin/ruflo.js memory store --key k --value v',
    'deny',
    'H1',
  ],
]

describe('decide() — full 58-row census table (58 = 62 - D9 - D10 - D11 - E6)', () => {
  it.each(CENSUS_ROWS)('%s -> %s :: %s', (_id, command, expected, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe(expected)
    if (predicate) expect(reasonOf(result)).toContain(predicate)
  })
})

// --- Quote-synthesis inputs ---

describe('decide() — quote-synthesis inputs (round 0)', () => {
  it("npx ru''flo … denies (single-quote synthesis)", () => {
    expect(decide(bashCall("npx ru''flo memory store --key k --value v"), {}).action).toBe('deny')
  })

  it('npx ru\\flo … denies (backslash synthesis)', () => {
    expect(decide(bashCall('npx ru\\flo memory store --key k --value v'), {}).action).toBe('deny')
  })
})

// --- Round 1 inputs and their greens ---

describe('decide() — round 1 inputs (eval, exec, braces)', () => {
  const redArms: Array<[string, string]> = [
    ['X=\'npx ruflo\'; eval "$X"', 'H9'],
    ["eval 'npx ruflo memory store --key k --value v'", 'H5'],
    ['exec ruflo memory store --key k', 'H4'],
    ['exec npx -p ruflo ruflo memory store --key k', 'H5'],
    ['exec env X=1 ruflo memory store --key k', 'H4'],
    ['npx ru{f,}lo memory store --key k', 'brace-syntax'],
    ['npx {ruflo,eslint} memory store --key k', 'brace-syntax'],
    ['env X=1 npx ru{f,}lo memory store --key k', 'brace-syntax'],
  ]

  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })

  const greenArms = ["eval 'printf %s harmless'", 'exec printf harmless', "printf '{harmless}'"]

  it.each(greenArms)('%s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

// --- H8's two arms (D11) ---

describe('decide() — H8 (D11 registry-fetch closure)', () => {
  it('V=ru; npx "${V}flo" … denies via H8(ii) only (not H5)', () => {
    const result = decide(bashCall('V=ru; npx "${V}flo" memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8')
    expect(reasonOf(result)).not.toContain('H5')
  })

  it('V=ruflo; npx "$V" … denies (H8(i) fires on the bare assignment segment)', () => {
    const result = decide(bashCall('V=ruflo; npx "$V" memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8')
  })
})

// --- Green arms: Stage 1 rows, own-merit greens, laundering red arms, compound case ---

describe('decide() — Stage 1 sanctioned forms (green)', () => {
  const rows = [
    'docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js mcp start',
    'npm ls -g ruflo',
    'npm view ruflo',
    'npm uninstall -g ruflo',
  ]
  it.each(rows)('%s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

describe('decide() — own-merit greens (no allowlist involved)', () => {
  const rows = [
    'git log --grep ruflo',
    'grep -rn ruflo scripts/',
    './scripts/ruflo-service-up.sh',
    'docker compose --profile ruflo up -d',
    'ls node_modules | grep ruflo',
  ]
  it.each(rows)('%s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

describe("decide() — laundering inputs (Queen's pre-review corrections item 1)", () => {
  // The removed Stage-1 allowlist rows (find -exec, awk system(), sed e,
  // rg --pre, cat|node, git -c core.pager, git alias, docker compose run)
  // would have exempted these whole segments; with no reader carve-out
  // they must all deny on the element that names the path.
  //
  // RESIDUAL GAP CLOSED (SMI-6744 Wave 4 governance round, post-
  // implementation): the LITERAL plan example
  // `sed 's/^/node node_modules\/ruflo\/bin\/ruflo.js/e'` (escaped `/` as
  // sed's own delimiter -- not shell escaping; the tokenizer correctly
  // preserves the literal backslash characters inside the single-quoted sed
  // script) used to ALLOW, because the backslashes sed's own delimiter-
  // escaping convention requires broke the contiguous `node_modules/ruflo`
  // substring H1/H2/H7 test for. Fixed by testing each scanned element
  // against BOTH its raw form and a backslash-de-escaped view
  // (`deEscape()` in ruflo-host-guard-predicates.mjs) -- watched failing
  // against the pre-fix predicates (see implementation hand-back) before
  // the fix landed. The `#`-delimiter row below is KEPT as its own arm
  // (not redundant with the `/`-delimiter row above it): it is the "needs
  // no escaping at all" spelling of the same "sed with an `e` flag" attack
  // class, so it must keep denying via the plain (non-de-escaped) path
  // regardless of what the de-escape view finds.
  const rows = [
    "find node_modules/ruflo/bin -name 'ruflo.js' -exec node {} memory store --key k \\;",
    'awk \'BEGIN{system("node node_modules/ruflo/bin/ruflo.js memory store")}\'',
    "sed 's/^/node node_modules\\/ruflo\\/bin\\/ruflo.js/e'",
    "sed 's#^#node node_modules/ruflo/bin/ruflo.js#e'",
    "rg --pre 'node node_modules/ruflo/bin/ruflo.js' .",
    'cat node_modules/ruflo/bin/ruflo.js | node',
    "git -c core.pager='node node_modules/ruflo/bin/ruflo.js' log",
    "git config alias.x '!node node_modules/ruflo/bin/ruflo.js memory store' && git x",
    'docker compose --profile dev run --rm dev node node_modules/ruflo/bin/ruflo.js memory store',
  ]
  it.each(rows)('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })
})

describe('decide() — compound command: a sanctioned segment does not launder an unsanctioned one', () => {
  it('docker exec skillsmith-ruflo-1 … && npx ruflo … -> deny', () => {
    const result = decide(
      bashCall('docker exec skillsmith-ruflo-1 sqlite3 foo.db && npx ruflo memory store --key k'),
      {}
    )
    expect(result.action).toBe('deny')
  })
})

// --- SMI-6744 Wave 4 governance-round fixes (H-A through M-D) ---

describe('decide() — H-A: launcher prefixes defeat H4/H5 (governance round)', () => {
  const redArms: Array<[string, string]> = [
    ['timeout 5 ruflo memory store --key k --value v', 'H4'],
    ['nohup ruflo memory store --key k --value v', 'H4'],
    ['nice -n 10 ruflo memory store --key k --value v', 'H4'],
    ['setsid ruflo memory store --key k --value v', 'H4'],
    ['stdbuf -o0 ruflo memory store --key k --value v', 'H4'],
    ['script -q /dev/null ruflo memory store --key k --value v', 'H4'],
    ['xargs ruflo memory store --key k --value v', 'H4'],
    ['time ruflo memory store --key k --value v', 'H4'],
    ["builtin eval 'npx ruflo memory store --key k --value v'", 'H5'],
  ]
  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })

  it('control: timeout 5 npx ruflo … still denies via H5 (not widened to any position)', () => {
    const result = decide(bashCall('timeout 5 npx ruflo memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5')
  })

  it('control: nohup node node_modules/ruflo/bin/ruflo.js … still denies via H1', () => {
    const result = decide(
      bashCall('nohup node node_modules/ruflo/bin/ruflo.js memory store --key k --value v'),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H1')
  })

  it('control: git log --grep ruflo still allows (launcher table does not over-match)', () => {
    expect(decide(bashCall('git log --grep ruflo'), {}).action).toBe('allow')
  })
})

describe('decide() — H-B: `env -S`/`--split-string` collapses the command (governance round)', () => {
  const redArms = [
    "env -S 'ruflo memory store --key k --value v'",
    "env --split-string='ruflo memory store'",
    "env -S 'npx ruflo memory store'",
  ]
  it.each(redArms)('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it("env -S 'printf harmless' -> allow (green control)", () => {
    expect(decide(bashCall("env -S 'printf harmless'"), {}).action).toBe('allow')
  })
})

describe('decide() — H-C: `command eval`/`builtin eval`/`noglob eval` evade H9 (governance round)', () => {
  const redArms = [
    "command eval 'npx ruflo memory store --key k --value v'",
    "builtin eval 'npx ruflo memory store'",
    "noglob eval 'npx ruflo memory store'",
  ]
  it.each(redArms)('%s -> deny (H5, via the recursed literal text)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5')
  })
})

describe('decide() — H-D: no path normalisation lets `//` and `/./` through (governance round)', () => {
  const redArms: Array<[string, string]> = [
    ['node node_modules/@claude-flow/cli//bin/cli.js mcp start', 'H2'],
    ['node node_modules/@claude-flow/cli/./bin/cli.js mcp start', 'H2'],
    ['node node_modules/@claude-flow//cli/bin/cli.js mcp start', 'H2'],
    ['./node_modules//.bin/ruflo memory store', 'H3'],
    ['node_modules/./.bin/ruflo memory store', 'H3'],
  ]
  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })

  it('existing negative controls stay green: git log --grep ruflo', () => {
    expect(decide(bashCall('git log --grep ruflo'), {}).action).toBe('allow')
  })

  it('existing negative controls stay green: ls node_modules | grep ruflo', () => {
    expect(decide(bashCall('ls node_modules | grep ruflo'), {}).action).toBe('allow')
  })
})

describe('decide() — H-E: `varlock run <payload> -- x` drops the command (governance round)', () => {
  it('varlock run npx ruflo memory store --key k -- x -> deny', () => {
    expect(decide(bashCall('varlock run npx ruflo memory store --key k -- x'), {}).action).toBe(
      'deny'
    )
  })

  it('varlock run ruflo memory store --key k -- x -> deny', () => {
    expect(decide(bashCall('varlock run ruflo memory store --key k -- x'), {}).action).toBe('deny')
  })

  it('control: varlock run -- npx ruflo … still denies via H5', () => {
    const result = decide(bashCall('varlock run -- npx ruflo memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5')
  })

  it('control: varlock run ruflo … (no trailing --) still denies via H4', () => {
    const result = decide(bashCall('varlock run ruflo memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4')
  })
})

describe('decide() — H-F: literal text piped/fed into a shell (governance round)', () => {
  const redArms = [
    "echo 'npx ruflo memory store --key k --value v' | bash",
    "printf 'npx ruflo memory store' | sh",
    "bash <<< 'npx ruflo memory store'",
    "bash <(echo 'npx ruflo memory store')",
  ]
  it.each(redArms)('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it("echo 'hello' | bash -> allow (green control)", () => {
    expect(decide(bashCall("echo 'hello' | bash"), {}).action).toBe('allow')
  })

  it("bash <<< 'printf harmless' -> allow (green control)", () => {
    expect(decide(bashCall("bash <<< 'printf harmless'"), {}).action).toBe('allow')
  })
})

describe('decide() — M-A: narrowed H8(ii) stops denying ordinary repo commands (governance round)', () => {
  const greenArms = [
    'npx vitest run "$F"',
    'docker exec skillsmith-dev-1 npx vitest run "$F"',
    'npx prettier --write "$f"',
    'npx eslint $(git diff --name-only)',
    'npm run lint -- $ARGS',
    'npx tsx scripts/x.ts "$ARG"',
    'npm ci --prefix "$(pwd)"',
    'bash -c \'npx vitest run "$F"\'',
    'npm run build --workspace=$W',
  ]
  it.each(greenArms)('%s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it('control: V=ru; npx "${V}flo" … still denies via H8 (slot 1), not H5', () => {
    const result = decide(bashCall('V=ru; npx "${V}flo" memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8')
    expect(reasonOf(result)).not.toContain('H5')
  })

  it('control: npx `echo ruflo` memory store … still denies via H8 (slot 1, .subs)', () => {
    const result = decide(bashCall('npx `echo ruflo` memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8')
  })
})

describe('decide() — M-B: brace check fires before the runner (governance round)', () => {
  it('{ npm run lint; } -> allow (shell grouping syntax, not a brace expansion)', () => {
    expect(decide(bashCall('{ npm run lint; }'), {}).action).toBe('allow')
  })

  it("npx prettier --write scripts/{a,b}.ts -> deny (brace AFTER the runner, design's chosen posture)", () => {
    const result = decide(bashCall('npx prettier --write scripts/{a,b}.ts'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('brace-syntax')
  })

  it('control: npx ru{f,}lo memory store --key k still denies (brace-syntax)', () => {
    const result = decide(bashCall('npx ru{f,}lo memory store --key k'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('brace-syntax')
  })

  it('control: npx {ruflo,eslint} memory store --key k still denies (brace-syntax)', () => {
    const result = decide(bashCall('npx {ruflo,eslint} memory store --key k'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('brace-syntax')
  })

  it('control: env X=1 npx ru{f,}lo memory store --key k still denies (brace-syntax)', () => {
    const result = decide(bashCall('env X=1 npx ru{f,}lo memory store --key k'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('brace-syntax')
  })
})

describe('decide() — M-C: Stage-1 sanctioned docker exec checked before H8(i) (governance round)', () => {
  it('docker exec skillsmith-ruflo-1 env V=ruflo node … -> allow', () => {
    const result = decide(
      bashCall(
        'docker exec skillsmith-ruflo-1 env V=ruflo node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js x'
      ),
      {}
    )
    expect(result.action).toBe('allow')
  })
})

describe('decide() — L-A: `docker container exec` long-form alias (governance round)', () => {
  it('docker container exec skillsmith-ruflo-1 … -> allow', () => {
    const result = decide(
      bashCall(
        'docker container exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js mcp start'
      ),
      {}
    )
    expect(result.action).toBe('allow')
  })

  it('docker container exec skillsmith-dev-1 node node_modules/ruflo/bin/ruflo.js … -> deny (H1)', () => {
    const result = decide(
      bashCall(
        'docker container exec skillsmith-dev-1 node node_modules/ruflo/bin/ruflo.js memory store --key k --value v'
      ),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H1')
  })
})

describe('decide() — L-B: `npm uninstall -g ruflo --dry-run` (governance round)', () => {
  it('allows the dry-run form (strictly safer than the already-sanctioned bare uninstall)', () => {
    expect(decide(bashCall('npm uninstall -g ruflo --dry-run'), {}).action).toBe('allow')
  })
})

describe('decide() — L-D: H1_RE2/H2 trailing boundary + bare --require specifier (governance round)', () => {
  const redArms: Array<[string, string]> = [
    ['node -e \'import("ruflo/bin/ruflo.js")\'', 'H1'],
    ["node --require ruflo -e ''", 'H1'],
    ['node -e \'import("@claude-flow/cli/bin/cli.js")\'', 'H2'],
  ]
  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })
})

describe('decide() — M-D: standing arm for the fail-closed depth-cap boundary (governance round)', () => {
  function nestedSubshells(n: number, inner: string): string {
    let cmd = inner
    for (let i = 0; i < n; i++) cmd = `echo $(${cmd})`
    return cmd
  }

  it('eight nested $(...) denies with reason containing "internal error", not the fail-open the cap prevents', () => {
    const result = decide(bashCall(nestedSubshells(8, 'npx ruflo memory store')), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('internal error')
  })
})

// --- SMI-6854 startDaemon shapes ---

describe('decide() — mcp__ruflo__hooks_session-start startDaemon gate (SMI-6854)', () => {
  const denyShapes: Array<[string, unknown]> = [
    ['true', true],
    ['"true"', 'true'],
    ['1', 1],
    ['[]', []],
    ['{}', {}],
    ['null', null],
  ]
  it.each(denyShapes)('startDaemon=%s -> deny', (_label, value) => {
    const result = decide(sessionStartCall({ startDaemon: value }), {})
    expect(result.action).toBe('deny')
  })

  it('startDaemon absent -> allow', () => {
    expect(decide(sessionStartCall({}), {}).action).toBe('allow')
  })

  it('startDaemon===false -> allow', () => {
    expect(decide(sessionStartCall({ startDaemon: false }), {}).action).toBe('allow')
  })

  it('missing tool_input entirely -> deny (fail-closed rule, round 1 finding 5)', () => {
    const result = decide({ tool_name: 'mcp__ruflo__hooks_session-start' }, {})
    expect(result.action).toBe('deny')
  })
})

// --- Runtime input failures (round 1 finding 4) ---

describe('decide() — malformed/unparseable input denies, unrelated tools allow', () => {
  it('non-object payload denies', () => {
    expect(decide('not-an-object' as never, {}).action).toBe('deny')
  })

  it('null payload denies', () => {
    expect(decide(null, {}).action).toBe('deny')
  })

  it('non-string tool_name denies', () => {
    expect(decide({ tool_name: 1 } as never, {}).action).toBe('deny')
  })

  it('Bash with missing tool_input denies', () => {
    expect(decide({ tool_name: 'Bash' }, {}).action).toBe('deny')
  })

  it('Bash with non-string command denies', () => {
    expect(decide({ tool_name: 'Bash', tool_input: { command: 42 } }, {}).action).toBe('deny')
  })

  it('an unrelated well-formed tool call allows', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }, {}).action).toBe(
      'allow'
    )
  })

  it('empty Bash command allows (nothing to evaluate)', () => {
    expect(decide(bashCall(''), {}).action).toBe('allow')
  })
})

// --- Runtime wrapper exercised as a child process ---

function runGuardChildProcess(stdin: string) {
  return spawnSync(process.execPath, [GUARD_SCRIPT_PATH], {
    input: stdin,
    encoding: 'utf8',
  })
}

describe('runtime wrapper (child process) — malformed input shapes deny', () => {
  it('empty stdin -> deny JSON on stdout, exit 0', () => {
    const result = runGuardChildProcess('')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('invalid JSON ("{") -> deny JSON on stdout, exit 0', () => {
    const result = runGuardChildProcess('{')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('{"tool_name":1} -> deny JSON on stdout, exit 0', () => {
    const result = runGuardChildProcess('{"tool_name":1}')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a matched tool (Bash) without tool_input -> deny JSON on stdout, exit 0', () => {
    const result = runGuardChildProcess(JSON.stringify({ tool_name: 'Bash' }))
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a well-formed unrelated tool call -> allow (no stdout, exit 0)', () => {
    const result = runGuardChildProcess(
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('M-D: a real ruflo invocation -> deny JSON with an H-labelled reason, not just malformed-input denials', () => {
    const result = runGuardChildProcess(
      JSON.stringify(bashCall('npx ruflo memory store --key k --value v'))
    )
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/\[ruflo-host-guard\] H\d/)
  })
})
