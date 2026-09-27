/**
 * SMI-6744 Wave 4 (A4.6): executable twin of `audit:standards` Checks 74
 * and 75.
 *
 * Design: docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 1(b) Layer R (the 50-entry Bash deny set), § 6 rows 9, 13, 14.
 *
 * The two entry arrays below are harness-owned literals, hand-copied from
 * the design doc. The first test in each describe block below cross-checks
 * the two lists for exact equality against the helper's own
 * RUFLO_BASH_DENY_ENTRIES / RUFLO_MCP_DENY_ENTRIES exports. That equality
 * check is not evidence the two copies are independently correct against
 * the design doc or the census it derives from -- both are hand-maintained
 * and can drift the same way together -- it only catches the two copies
 * disagreeing with EACH OTHER (SMI-6744 Wave 4 L-10 governance finding: an
 * earlier version of this comment overstated what `toEqual()` proves here).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  RUFLO_BASH_DENY_ENTRIES,
  RUFLO_MCP_DENY_ENTRIES,
  evaluateRufloHostPaths,
  rufloHostPathsReportLines,
  evaluateRufloHostGuardHooks,
  rufloHostGuardHooksReportLines,
  evaluateRufloMcpDenies,
  rufloMcpDeniesReportLines,
} from '../audit-ruflo-host-paths-helpers.mjs'

// Harness-owned copy of the design doc's Layer R Bash deny set (50 entries
// as of the M-4 governance round; count-free name so the fixture's own name
// never states a total the array can silently drift out of sync with).
const ALL_RUFLO_BASH_ENTRIES = [
  'Bash(npx ruflo)',
  'Bash(npx ruflo *)',
  'Bash(npx ruflo@*)',
  'Bash(npx -y ruflo)',
  'Bash(npx -y ruflo *)',
  'Bash(npx -y ruflo@*)',
  'Bash(npx --yes ruflo)',
  'Bash(npx --yes ruflo *)',
  'Bash(npx --yes ruflo@*)',
  'Bash(npx claude-flow)',
  'Bash(npx claude-flow *)',
  'Bash(npx claude-flow@*)',
  'Bash(npx @claude-flow/cli)',
  'Bash(npx @claude-flow/cli *)',
  'Bash(npx @claude-flow/cli@*)',
  'Bash(npm exec ruflo)',
  'Bash(npm exec ruflo *)',
  'Bash(npm exec ruflo@*)',
  'Bash(npm exec -- ruflo)',
  'Bash(npm exec -- ruflo *)',
  'Bash(npm exec -- ruflo@*)',
  'Bash(npm x ruflo)',
  'Bash(npm x ruflo *)',
  'Bash(npm x ruflo@*)',
  'Bash(npm x -- ruflo)',
  'Bash(npm x -- ruflo *)',
  'Bash(npm x -- ruflo@*)',
  'Bash(pnpm dlx ruflo)',
  'Bash(pnpm dlx ruflo *)',
  'Bash(pnpm dlx ruflo@*)',
  'Bash(yarn dlx ruflo)',
  'Bash(yarn dlx ruflo *)',
  'Bash(yarn dlx ruflo@*)',
  'Bash(bunx ruflo)',
  'Bash(bunx ruflo *)',
  'Bash(bunx ruflo@*)',
  'Bash(node node_modules/ruflo/*)',
  'Bash(node ./node_modules/ruflo/*)',
  'Bash(node node_modules/@claude-flow/cli/*)',
  'Bash(node ./node_modules/@claude-flow/cli/*)',
  'Bash(node node_modules/.bin/ruflo)',
  'Bash(node node_modules/.bin/ruflo *)',
  'Bash(node node_modules/.bin/claude-flow)',
  'Bash(node node_modules/.bin/claude-flow *)',
  'Bash(node_modules/.bin/ruflo)',
  'Bash(node_modules/.bin/ruflo *)',
  'Bash(./node_modules/.bin/ruflo)',
  'Bash(./node_modules/.bin/ruflo *)',
  'Bash(ruflo)',
  'Bash(ruflo *)',
]

// Harness-owned copy of the design doc's 37-entry MCP deny set.
const ALL_37_MCP_ENTRIES = [
  'mcp__ruflo__terminal_execute',
  'mcp__ruflo__agent_execute',
  'mcp__ruflo__wasm_agent_tool',
  'mcp__ruflo__github_issue_track',
  'mcp__ruflo__github_metrics',
  'mcp__ruflo__github_pr_manage',
  'mcp__ruflo__github_repo_analyze',
  'mcp__ruflo__github_workflow',
  'mcp__ruflo__browser_act',
  'mcp__ruflo__browser_back',
  'mcp__ruflo__browser_check',
  'mcp__ruflo__browser_click',
  'mcp__ruflo__browser_close',
  'mcp__ruflo__browser_cookie_use',
  'mcp__ruflo__browser_eval',
  'mcp__ruflo__browser_fill',
  'mcp__ruflo__browser_forward',
  'mcp__ruflo__browser_get-text',
  'mcp__ruflo__browser_get-title',
  'mcp__ruflo__browser_get-url',
  'mcp__ruflo__browser_get-value',
  'mcp__ruflo__browser_hover',
  'mcp__ruflo__browser_open',
  'mcp__ruflo__browser_press',
  'mcp__ruflo__browser_reload',
  'mcp__ruflo__browser_screenshot',
  'mcp__ruflo__browser_scroll',
  'mcp__ruflo__browser_select',
  'mcp__ruflo__browser_session-list',
  'mcp__ruflo__browser_session_end',
  'mcp__ruflo__browser_session_record',
  'mcp__ruflo__browser_session_replay',
  'mcp__ruflo__browser_snapshot',
  'mcp__ruflo__browser_template_apply',
  'mcp__ruflo__browser_type',
  'mcp__ruflo__browser_uncheck',
  'mcp__ruflo__browser_wait',
]

function settingsWithDeny(denyEntries: string[]): string {
  return JSON.stringify({ permissions: { deny: denyEntries } })
}

function settingsWithHooks(preToolUse: unknown[]): string {
  return JSON.stringify({ hooks: { PreToolUse: preToolUse } })
}

const RUFLO_GUARD_COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/ruflo-host-guard.mjs"'

const BASH_HOOK_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', timeout: 5, command: RUFLO_GUARD_COMMAND }],
}
const SESSION_START_HOOK_ENTRY = {
  matcher: '^mcp__ruflo__hooks_session-start$',
  hooks: [{ type: 'command', timeout: 5, command: RUFLO_GUARD_COMMAND }],
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

describe('harness-owned entry lists match the helper (drift guard)', () => {
  it('Bash entries, identical set and order to RUFLO_BASH_DENY_ENTRIES', () => {
    expect(ALL_RUFLO_BASH_ENTRIES).toEqual(RUFLO_BASH_DENY_ENTRIES)
  })

  it('37 MCP entries, identical set and order to RUFLO_MCP_DENY_ENTRIES', () => {
    expect(ALL_37_MCP_ENTRIES).toHaveLength(37)
    expect(ALL_37_MCP_ENTRIES).toEqual(RUFLO_MCP_DENY_ENTRIES)
  })
})

describe('Check 74 arm (a): Bash deny entries', () => {
  it('passes when all entries are present (tree absent)', () => {
    const verdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: '/nonexistent-root-for-this-test',
      readFile: () => settingsWithDeny(ALL_RUFLO_BASH_ENTRIES),
      existsSync: () => false,
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.missingBashEntries).toEqual([])
    const lines = rufloHostPathsReportLines(verdict)
    const passLine = lines.find((l: { message: string }) => l.message.startsWith('Check 74: all'))
    expect(passLine?.severity).toBe('pass')
    // Denominator must derive from the array's own length, never a literal
    // (SMI-6744 Wave 4 M-4 governance finding).
    expect(passLine?.message).toContain(String(RUFLO_BASH_DENY_ENTRIES.length))
  })

  const perFamilyRemoval: Array<[string, string]> = [
    ['npx', 'Bash(npx ruflo)'],
    ['npm exec/x', 'Bash(npm exec ruflo)'],
    ['pnpm/yarn/bunx', 'Bash(pnpm dlx ruflo)'],
    ['node <repo-relative path>', 'Bash(node node_modules/ruflo/*)'],
    ['direct .bin', 'Bash(node_modules/.bin/ruflo)'],
    ['bare ruflo', 'Bash(ruflo)'],
    // SMI-6744 Wave 4 M-4 red arm: one of the seven `@*` twins the
    // governance round added. Watched failing before the twin existed in
    // either RUFLO_BASH_DENY_ENTRIES or .claude/settings.json (the entry was
    // simply absent from both, so `missingBashEntries` never named it).
    ['pnpm dlx @* twin', 'Bash(pnpm dlx ruflo@*)'],
  ]

  it.each(perFamilyRemoval)(
    'fails naming the removed entry when the %s family loses one entry',
    (_family, removed) => {
      const deny = ALL_RUFLO_BASH_ENTRIES.filter((e) => e !== removed)
      const verdict = evaluateRufloHostPaths({
        settingsPath: '.claude/settings.json',
        root: '/nonexistent-root-for-this-test',
        readFile: () => settingsWithDeny(deny),
        existsSync: () => false,
      })
      expect(verdict.missingBashEntries).toEqual([removed])
      const lines = rufloHostPathsReportLines(verdict)
      const failLine = lines.find(
        (l: { severity: string; message: string }) =>
          l.severity === 'fail' && l.message.includes(removed)
      )
      expect(failLine).toBeTruthy()
      // Denominator printed on the fail line, derived from the array's own
      // length, never a literal.
      expect(failLine?.message).toContain(`${RUFLO_BASH_DENY_ENTRIES.length} required`)
      expect(failLine?.message).toContain(`${RUFLO_BASH_DENY_ENTRIES.length - 1} present`)
    }
  )
})

describe('Check 74 arm (b): host-tree removal', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('produces different verdicts for a real temp tree with and without node_modules/ruflo', () => {
    const withRuflo = mkdtempSync(join(tmpdir(), 'smi6744-check74-with-'))
    scratchDirs.push(withRuflo)
    mkdirSync(join(withRuflo, 'node_modules', 'ruflo'), { recursive: true })

    const withoutRuflo = mkdtempSync(join(tmpdir(), 'smi6744-check74-without-'))
    scratchDirs.push(withoutRuflo)
    mkdirSync(join(withoutRuflo, 'node_modules'), { recursive: true })

    // Real fs.existsSync (no injection) -- this is a direct test of the
    // filesystem property, not an inference from metadata.
    expect(existsSync(join(withRuflo, 'node_modules', 'ruflo'))).toBe(true)
    expect(existsSync(join(withoutRuflo, 'node_modules', 'ruflo'))).toBe(false)

    const presentVerdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: withRuflo,
      readFile: () => settingsWithDeny(ALL_RUFLO_BASH_ENTRIES),
    })
    const absentVerdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: withoutRuflo,
      readFile: () => settingsWithDeny(ALL_RUFLO_BASH_ENTRIES),
    })

    expect(presentVerdict.treePresent).toBe(true)
    expect(absentVerdict.treePresent).toBe(false)

    const presentLines = rufloHostPathsReportLines(presentVerdict)
    const absentLines = rufloHostPathsReportLines(absentVerdict)
    expect(presentLines.some((l: { severity: string }) => l.severity === 'fail')).toBe(true)
    expect(absentLines.every((l: { severity: string }) => l.severity !== 'fail')).toBe(true)
  })

  it("both the pass and fail tree lines name what is out of this check's reach", () => {
    const dir = mkdtempSync(join(tmpdir(), 'smi6744-check74-reach-'))
    scratchDirs.push(dir)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })

    const absentLines = rufloHostPathsReportLines(
      evaluateRufloHostPaths({
        settingsPath: '.claude/settings.json',
        root: dir,
        readFile: () => settingsWithDeny(ALL_RUFLO_BASH_ENTRIES),
      })
    )
    for (const l of absentLines) {
      expect(l.message).toContain("out of this check's reach")
    }

    mkdirSync(join(dir, 'node_modules', 'ruflo'), { recursive: true })
    const presentLines = rufloHostPathsReportLines(
      evaluateRufloHostPaths({
        settingsPath: '.claude/settings.json',
        root: dir,
        readFile: () => settingsWithDeny(ALL_RUFLO_BASH_ENTRIES),
      })
    )
    for (const l of presentLines) {
      expect(l.message).toContain("out of this check's reach")
    }
  })
})

describe('Check 75: MCP deny entries', () => {
  it('passes when all 37 entries are present', () => {
    const verdict = evaluateRufloMcpDenies({
      settingsPath: '.claude/settings.json',
      readFile: () => settingsWithDeny(ALL_37_MCP_ENTRIES),
    })
    expect(verdict.missingMcpEntries).toEqual([])
    const lines = rufloMcpDeniesReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('pass')
    expect(lines[0].message).toContain('37')
  })

  const perFamilyRemoval: Array<[string, string]> = [
    ['browser_*', 'mcp__ruflo__browser_click'],
    ['github_*', 'mcp__ruflo__github_pr_manage'],
    ['terminal_execute', 'mcp__ruflo__terminal_execute'],
    ['agent_execute', 'mcp__ruflo__agent_execute'],
    ['wasm_agent_tool', 'mcp__ruflo__wasm_agent_tool'],
  ]

  it.each(perFamilyRemoval)(
    'fails naming the removed entry when %s is removed',
    (_family, removed) => {
      const deny = ALL_37_MCP_ENTRIES.filter((e) => e !== removed)
      const verdict = evaluateRufloMcpDenies({
        settingsPath: '.claude/settings.json',
        readFile: () => settingsWithDeny(deny),
      })
      expect(verdict.missingMcpEntries).toEqual([removed])
      const lines = rufloMcpDeniesReportLines(verdict)
      expect(lines).toHaveLength(1)
      expect(lines[0].severity).toBe('fail')
      expect(lines[0].message).toContain(removed)
      // Denominator printed on the fail line, same shape as the pass line.
      expect(lines[0].message).toContain('37 required')
      expect(lines[0].message).toContain('36 present')
    }
  )
})

describe('not_evaluated: neither check reports an unread settings file as a pass', () => {
  const THROWS = () => {
    throw new Error("ENOENT: no such file or directory, open '.claude/settings.json'")
  }

  it('Check 74 fails rather than passing on unreadable input', () => {
    const verdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: '.',
      readFile: THROWS,
    })
    expect(verdict.status).toBe('not_evaluated')
    const lines = rufloHostPathsReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('fail')
  })

  it('Check 75 fails rather than passing on unreadable input', () => {
    const verdict = evaluateRufloMcpDenies({
      settingsPath: '.claude/settings.json',
      readFile: THROWS,
    })
    expect(verdict.status).toBe('not_evaluated')
    const lines = rufloMcpDeniesReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('fail')
  })
})

describe('Check 74 hook-entry tripwire (SMI-6744 A4.6): scripts/ruflo-host-guard.mjs registration', () => {
  it('both entries present -> evaluated true/true, one pass line', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () => settingsWithHooks([BASH_HOOK_ENTRY, SESSION_START_HOOK_ENTRY]),
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.hasBashEntry).toBe(true)
    expect(verdict.hasSessionStartEntry).toBe(true)
    const lines = rufloHostGuardHooksReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('pass')
  })

  it('RED: the Bash matcher entry removed -> fails naming "Bash"', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () => settingsWithHooks([SESSION_START_HOOK_ENTRY]),
    })
    expect(verdict.hasBashEntry).toBe(false)
    expect(verdict.hasSessionStartEntry).toBe(true)
    const lines = rufloHostGuardHooksReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('fail')
    expect(lines[0].message).toContain('"Bash"')
  })

  it('RED: the session-start matcher entry removed -> fails naming it', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () => settingsWithHooks([BASH_HOOK_ENTRY]),
    })
    expect(verdict.hasBashEntry).toBe(true)
    expect(verdict.hasSessionStartEntry).toBe(false)
    const lines = rufloHostGuardHooksReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('fail')
    expect(lines[0].message).toContain('^mcp__ruflo__hooks_session-start$')
  })

  it('RED: both entries removed -> two fail lines', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () => settingsWithHooks([]),
    })
    expect(verdict.hasBashEntry).toBe(false)
    expect(verdict.hasSessionStartEntry).toBe(false)
    expect(rufloHostGuardHooksReportLines(verdict)).toHaveLength(2)
  })

  it('RED: a functionally inert hook (wrong type) carrying the right text does NOT count', () => {
    // Type + exact invocation-shape check, not a bare substring match on
    // the whole file — a hook object whose `type` isn't 'command' (e.g.
    // silently swapped to something inert) must still fail, even though
    // its `command`-shaped field contains both required substrings.
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () =>
        settingsWithHooks([
          {
            matcher: 'Bash',
            hooks: [{ type: 'not-a-command', command: RUFLO_GUARD_COMMAND }],
          },
          SESSION_START_HOOK_ENTRY,
        ]),
    })
    expect(verdict.hasBashEntry).toBe(false)
  })

  it('RED: the right matcher/type but a command missing scripts/ruflo-host-guard.mjs does NOT count', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () =>
        settingsWithHooks([
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/env-read-guard.mjs"' },
            ],
          },
          SESSION_START_HOOK_ENTRY,
        ]),
    })
    expect(verdict.hasBashEntry).toBe(false)
  })

  it('not_evaluated: unreadable settings file fails rather than passing', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: '.claude/settings.json',
      readFile: () => {
        throw new Error("ENOENT: no such file or directory, open '.claude/settings.json'")
      },
    })
    expect(verdict.status).toBe('not_evaluated')
    const lines = rufloHostGuardHooksReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('fail')
  })
})

describe('SMI-6744: the real .claude/settings.json in this repo', () => {
  it('Check 74 arm (a): every Bash deny entry is present', () => {
    const verdict = evaluateRufloHostPaths({
      settingsPath: join(REPO_ROOT, '.claude', 'settings.json'),
      root: REPO_ROOT,
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.missingBashEntries).toEqual([])
  })

  it('Check 74 hook-entry tripwire: both scripts/ruflo-host-guard.mjs entries are registered', () => {
    const verdict = evaluateRufloHostGuardHooks({
      settingsPath: join(REPO_ROOT, '.claude', 'settings.json'),
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.hasBashEntry).toBe(true)
    expect(verdict.hasSessionStartEntry).toBe(true)
  })

  it('Check 75: every MCP deny entry is present', () => {
    const verdict = evaluateRufloMcpDenies({
      settingsPath: join(REPO_ROOT, '.claude', 'settings.json'),
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.missingMcpEntries).toEqual([])
  })
})
