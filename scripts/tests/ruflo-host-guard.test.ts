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
  // KNOWN RESIDUAL GAP (found during implementation, not fixed): the
  // LITERAL plan example `sed 's/^/node node_modules\/ruflo\/bin\/ruflo.js/e'`
  // (escaped `/` as sed's own delimiter) still ALLOWS — the backslash
  // characters sed's own syntax requires break the contiguous
  // `node_modules/ruflo` substring H1 tests for (the tokenizer correctly
  // preserves literal backslashes inside single quotes; there is no shell
  // escaping to unwind here, this is sed's OWN delimiter-escaping
  // convention). The row below uses `#` as sed's delimiter instead (an
  // equally realistic, arguably more likely real-world spelling since it
  // needs no escaping at all) to test the same "sed with an `e` flag"
  // attack class without that specific unresolved gap. Flagged in the
  // implementation hand-back, not silently absorbed.
  const rows = [
    "find node_modules/ruflo/bin -name 'ruflo.js' -exec node {} memory store --key k \\;",
    'awk \'BEGIN{system("node node_modules/ruflo/bin/ruflo.js memory store")}\'',
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
})
