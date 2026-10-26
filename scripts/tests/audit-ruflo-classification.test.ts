/**
 * SMI-6744 A5.3: executable twin of `audit:standards` Check 79 (ruflo deny
 * list and classification doc lockstep).
 *
 * Plan: docs/internal/implementation/smi-6744-a53-hooks-intelligence-denies.md
 * (red arms a-s; the code mutations are run by hand against the real helper).
 *
 * Every red arm injects readFile/exists fixtures built in memory, so the real
 * settings.json and doc are never mutated. Each arm logs `applied=<mutation>`
 * so a run shows the mutation actually landed. The base fixture is first
 * proven clean (a known-negative control), so a red arm cannot pass on a
 * fixture that was already broken.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  RUFLO_CORE_DENY_ENTRIES,
  evaluateRufloClassification,
  rufloClassificationReportLines,
} from '../audit-ruflo-classification-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import { RUFLO_MCP_DENY_ENTRIES } from '../audit-ruflo-mcp-denies-helpers.mjs'

const P = 'mcp__ruflo__'
const CORE: string[] = [...RUFLO_CORE_DENY_ENTRIES]
const WAVE4: string[] = [...RUFLO_MCP_DENY_ENTRIES]
const SETTINGS = '/fx/settings.json'
const DOC = '/fx/doc.md'

interface Row {
  prefix: string
  allowed: string
  blocked: string
}
interface Fx {
  deny: unknown
  docDeny: unknown
  rows: Row[]
  settingsText?: string
  docFence?: string
  extraFence?: boolean
  strayRow?: string
  docPresent?: boolean
  core?: string[]
  mcp?: string[]
}

function prefixOf(name: string): string {
  if (name.startsWith('managed_agent_')) return 'managed_agent_'
  return /^[a-z0-9-]+_/.exec(name)![0]
}

function rowsFor(denies: string[]): Row[] {
  const by = new Map<string, string[]>()
  for (const d of denies) {
    const name = d.slice(P.length)
    const pre = prefixOf(name)
    by.set(pre, [...(by.get(pre) ?? []), name.slice(pre.length)])
  }
  return [...by].map(([prefix, sfx]) => ({
    prefix,
    allowed: '`safe`',
    blocked: sfx.map((s) => `\`${s}\``).join(', '),
  }))
}

function base(): Fx {
  return {
    deny: ['Bash(ls)', ...CORE, ...WAVE4],
    docDeny: [...CORE],
    rows: rowsFor([...CORE, ...WAVE4]),
  }
}

function render(fx: Fx): Record<string, string> {
  const files: Record<string, string> = {}
  files[SETTINGS] = fx.settingsText ?? JSON.stringify({ permissions: { deny: fx.deny } })
  if (fx.docPresent === false) return files
  const fence = fx.docFence ?? JSON.stringify({ permissions: { deny: fx.docDeny } }, null, 2)
  const table = fx.rows.map((r) => `| \`${r.prefix}*\` | ${r.allowed} | ${r.blocked} |`)
  files[DOC] = [
    '# Doc',
    '```json',
    fence,
    '```',
    ...(fx.extraFence ? ['```json', '{}', '```'] : []),
    '## Full classification table',
    '| Prefix | Allowed | Blocked |',
    '|---|---|---|',
    ...table,
    '| | | a continuation row, not parsed |',
    '## Next',
    ...(fx.strayRow ? [fx.strayRow] : []),
    '',
  ].join('\n')
  return files
}

function run(fx: Fx) {
  const files = render(fx)
  return evaluateRufloClassification({
    settingsPath: SETTINGS,
    docPath: DOC,
    readFile: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]
    },
    exists: (p: string) => p in files,
    ...(fx.core ? { coreEntries: fx.core } : {}),
    ...(fx.mcp ? { mcpEntries: fx.mcp } : {}),
  })
}

function applied(name: string): void {
  console.log(`applied=${name}`)
}

function row(fx: Fx, prefix: string): Row {
  return fx.rows.find((r) => r.prefix === prefix)!
}

/** Tiny fixture for the prefix-matching arms: one denied name and its rows. */
function small(name: string, rows: Row[]): Fx {
  const full = `${P}${name}`
  return { deny: [full], docDeny: [full], rows, core: [full], mcp: [] }
}

describe('Check 79: live repo (presence control)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const settingsPath = join(root, '.claude', 'settings.json')
  const docPath = join(root, 'docs', 'internal', 'architecture', 'ruflo-tool-classification.md')
  const live = evaluateRufloClassification({ settingsPath, docPath })

  it('array half: core=51 pinned=51 with no findings, always', () => {
    expect(live.coreCount).toBe(51)
    expect(live.pinnedCount).toBe(51)
    expect(live.findings).toEqual([])
  })

  it.skipIf(!existsSync(docPath))(
    'doc half (only when docs/internal exists; CI has none): doc=51 and rules A-F are clean',
    () => {
      expect(live.docChecked).toBe(true)
      expect(live.docCount).toBe(51)
      expect(live.rows).toBeGreaterThan(0)
    }
  )

  it('the two pinned lists share no name', () => {
    expect(CORE.filter((n) => WAVE4.includes(n))).toEqual([])
  })
})

describe('Check 79: base fixture and report denominators', () => {
  it('a correct fixture is clean and counts what it read', () => {
    const r = run(base())
    expect(r.findings).toEqual([])
    expect([r.coreCount, r.pinnedCount, r.docCount]).toEqual([51, 51, 51])
    expect(r.rows).toBeGreaterThan(5)
  })

  it('report lines always print the denominators', () => {
    const [line] = rufloClassificationReportLines(run(base()))
    expect(line.severity).toBe('pass')
    expect(line.message).toContain('core=51 pinned=51 doc=51')
  })
})

describe('Check 79: array and doc-block red arms', () => {
  it('a: a name added to the doc block only', () => {
    const fx = base()
    ;(fx.docDeny as string[]).push(`${P}x_new`)
    applied('a:doc-only-name')
    expect(run(fx).findings).toContain(`doc-only: "${P}x_new" is not in the pinned list`)
  })

  it('b: a name added to the array only', () => {
    const fx = base()
    ;(fx.deny as string[]).push(`${P}x_new`)
    applied('b:array-only-name')
    expect(run(fx).findings).toContain(`array-only: "${P}x_new" is not in the pinned list`)
  })

  it('c: hooks_intelligence-reset spelled with an underscore in the doc', () => {
    const fx = base()
    const d = fx.docDeny as string[]
    d[d.indexOf(`${P}hooks_intelligence-reset`)] = `${P}hooks_intelligence_reset`
    applied('c:doc-spelling')
    const f = run(fx).findings
    expect(f).toContain(`doc-only: "${P}hooks_intelligence_reset" is not in the pinned list`)
    expect(f).toContain(`pin-only: "${P}hooks_intelligence-reset" is missing from doc`)
  })

  it("c': the same name upper-cased in the array", () => {
    const fx = base()
    const d = fx.deny as string[]
    d[d.indexOf(`${P}hooks_intelligence-reset`)] = `${P}HOOKS_INTELLIGENCE-RESET`
    applied("c':array-case")
    const f = run(fx).findings
    expect(f).toContain(`array-only: "${P}HOOKS_INTELLIGENCE-RESET" is not in the pinned list`)
    expect(f).toContain(`pin-only: "${P}hooks_intelligence-reset" is missing from array`)
  })

  it('d: two adjacent names swapped in the array', () => {
    const fx = base()
    const d = fx.deny as string[]
    const i = d.indexOf(CORE[3])
    ;[d[i], d[i + 1]] = [d[i + 1], d[i]]
    applied('d:adjacent-swap')
    expect(run(fx).findings).toEqual([
      `array order differs from the pinned list at index 3: "${CORE[4]}" vs "${CORE[3]}"`,
    ])
  })

  it('e: a second json fence added to the doc', () => {
    const fx = base()
    fx.extraFence = true
    applied('e:second-fence')
    expect(run(fx).findings).toContain('doc must hold exactly one closed json fence, found 2')
  })

  it('f: doc absent -> not checked, array half still runs', () => {
    const fx = base()
    fx.docPresent = false
    applied('f:doc-absent')
    const r = run(fx)
    expect(r.docChecked).toBe(false)
    expect(r.findings).toEqual([])
    const lines = rufloClassificationReportLines(r)
    expect(lines.map((l: { message: string }) => l.message)).toContain(
      'doc half: not checked (docs/internal absent)'
    )
    expect(lines[0].message).toContain('doc=not checked')
    const mutated = base()
    mutated.docPresent = false
    ;(mutated.deny as string[]).push(`${P}x_new`)
    expect(run(mutated).findings).toContain(`array-only: "${P}x_new" is not in the pinned list`)
  })

  it('g: a core name also in Check 75 list -> ownership; a fresh name in both -> rule A', () => {
    const fx = base()
    fx.mcp = [...WAVE4, CORE[37]]
    applied('g:name-in-both-pins')
    expect(run(fx).findings).toContain(
      `ownership: "${CORE[37]}" is in both the pinned core list and Check 75's list`
    )
    const fresh = base()
    const n = `${P}hooks_zzz_fresh`
    ;(fresh.deny as string[]).push(n)
    fresh.mcp = [...WAVE4, n]
    applied('g:fresh-name-in-array-and-check75')
    expect(run(fresh).findings).toEqual([
      'rule A: denied "hooks_zzz_fresh" is not in the hooks_* Blocked cell',
    ])
  })

  it('g2: a denied name absent from the table -> rule A names it', () => {
    const fx = base()
    fx.rows = fx.rows.filter((r) => r.prefix !== 'memory_')
    applied('g2:row-removed')
    expect(run(fx).findings).toContain('rule A: denied tool "memory_store" maps to no table row')
  })

  it('l: settings.json defects fail closed, each naming the defect', () => {
    const cases: Array<[string, Partial<Fx>, string]> = [
      ['malformed-json', { settingsText: '{ nope' }, `${SETTINGS} is not valid JSON`],
      [
        'deny-missing',
        { settingsText: '{"permissions":{}}' },
        'permissions.deny is missing or not an array',
      ],
      ['deny-non-array', { deny: 'x' }, 'permissions.deny is missing or not an array'],
      ['non-string-member', { deny: ['a', 7] }, 'permissions.deny[1] is not a string'],
    ]
    for (const [name, patch, text] of cases) {
      applied(`l:${name}`)
      const f = run({ ...base(), ...patch }).findings
      expect(f.some((x: string) => x.includes(text))).toBe(true)
    }
  })

  it('l-doc: doc fence deny missing / non-array / non-string member', () => {
    const cases: Array<[string, string, string]> = [
      [
        'deny-missing',
        '{"permissions":{}}',
        'the doc paste block: permissions.deny is missing or not an array',
      ],
      [
        'deny-non-array',
        '{"permissions":{"deny":"x"}}',
        'the doc paste block: permissions.deny is missing or not an array',
      ],
      [
        'non-string-member',
        '{"permissions":{"deny":["a",3]}}',
        'the doc paste block: permissions.deny[1] is not a string',
      ],
    ]
    for (const [name, docFence, text] of cases) {
      applied(`l-doc:${name}`)
      const r = run({ ...base(), docFence })
      expect(r.findings).toContain(text)
      expect(r.docCount).toBeNull()
    }
  })

  it('m: malformed JSON inside the doc fence', () => {
    applied('m:doc-fence-json')
    const f = run({ ...base(), docFence: '{ "permissions": ' }).findings
    expect(f.some((x: string) => x.startsWith('the doc paste block is not valid JSON'))).toBe(true)
  })
})

describe('Check 79: table rule red arms', () => {
  it('h: a non-denied name regains a place in the hooks_* Blocked cell -> rule B', () => {
    const fx = base()
    row(fx, 'hooks_').blocked += ', `intelligence_stats`'
    applied('h:blocked-not-denied')
    expect(run(fx).findings).toEqual([
      'rule B: "hooks_intelligence_stats" is in a Blocked cell but is not denied',
    ])
  })

  it('i: a denied name removed from its Blocked cell -> rule A', () => {
    const fx = base()
    row(fx, 'hooks_').blocked = row(fx, 'hooks_').blocked.replace(', `intelligence_learn`', '')
    applied('i:blocked-name-removed')
    expect(run(fx).findings).toEqual([
      'rule A: denied "hooks_intelligence_learn" is not in the hooks_* Blocked cell',
    ])
  })

  it('j: a denied suffix in the Allowed cell -> rule C', () => {
    const fx = base()
    row(fx, 'hooks_').allowed = '`safe`, `intelligence_learn`'
    applied('j:allowed-has-denied')
    expect(run(fx).findings).toEqual([
      'rule C: denied "hooks_intelligence_learn" appears in the Allowed cell as "intelligence_learn"',
    ])
  })

  it('j3: a wildcard in the Allowed cell that covers a denied suffix -> rule C', () => {
    const fx = base()
    row(fx, 'hooks_').allowed = '`safe`, `intelligence_l*`'
    applied('j3:allowed-wildcard-covers-denied')
    expect(run(fx).findings).toEqual([
      'rule C: denied "hooks_intelligence_learn" appears in the Allowed cell as "intelligence_l*"',
    ])
  })

  it('j2: a row with a denied tool whose Allowed cell starts with all -> rule C', () => {
    const fx = base()
    row(fx, 'terminal_').allowed = 'all (create, close)'
    applied('j2:allowed-starts-with-all')
    expect(run(fx).findings).toEqual([
      'rule C: terminal_* has denials but its Allowed cell starts with "all"',
    ])
  })

  it('k: a wildcard in a Blocked cell -> rule B', () => {
    const fx = base()
    row(fx, 'hooks_').blocked += ', `intelligence_trajectory-*`'
    applied('k:blocked-wildcard')
    expect(run(fx).findings).toEqual([
      'rule B: wildcard "intelligence_trajectory-*" in the hooks_* Blocked cell',
    ])
  })

  it('n: longest prefix wins, whatever the row order', () => {
    const general: Row = { prefix: 'hooks_', allowed: '`safe`', blocked: 'none' }
    const specific: Row = { prefix: 'hooks_intelligence_', allowed: '`safe`', blocked: '`learn`' }
    applied('n:general-row-before-specific')
    const fx = small('hooks_intelligence_learn', [general, specific])
    expect(run(fx).findings).toEqual([])
    expect(run(small('hooks_intelligence_learn', [specific, general])).findings).toEqual([])
    // negative control: the specific row not listing it must fail, so the arm can go red
    const unlisted = small('hooks_intelligence_learn', [general, { ...specific, blocked: 'none' }])
    expect(run(unlisted).findings).toEqual([
      'rule A: denied "hooks_intelligence_learn" is not in the hooks_intelligence_* Blocked cell',
    ])
  })

  it('o: prose in a Blocked cell -> rule D', () => {
    for (const blocked of [
      'intelligence_stats is also blocked',
      'none — intelligence_stats is also blocked',
    ]) {
      const fx = base()
      row(fx, 'memory_').blocked = blocked
      applied(`o:prose:${blocked}`)
      expect(run(fx).findings).toContain(
        `rule D: memory_* Blocked cell must be "none" or a comma-separated list of backticked names, got "${blocked}"`
      )
    }
  })

  it('p: a Blocked cell reading all -> rule D', () => {
    const fx = base()
    row(fx, 'browser_').blocked = 'all'
    applied('p:blocked-all')
    expect(run(fx).findings.some((x: string) => x.startsWith('rule D: browser_*'))).toBe(true)
  })

  it('q: two rows for the same prefix -> rule E', () => {
    const fx = base()
    fx.rows.push({ ...row(fx, 'hooks_') })
    applied('q:duplicate-prefix')
    expect(run(fx).findings).toContain('rule E: prefix hooks_* appears in more than one row')
  })

  it('r: a table-shaped row outside the table section -> rule F', () => {
    const fx = base()
    fx.strayRow = '| `hooks_*` | `safe` | none |'
    applied('r:stray-row')
    const f = run(fx).findings
    expect(f.some((x: string) => x.startsWith('rule F: stray table row'))).toBe(true)
  })

  it('s: a prefix containing an underscore is parsed and matched', () => {
    const rows: Row[] = [{ prefix: 'managed_agent_', allowed: 'none', blocked: '`create`' }]
    applied('s:underscore-prefix-row')
    const ok = run(small('managed_agent_create', rows))
    expect(ok.findings).toEqual([])
    expect(ok.rows).toBe(1)
    // negative control: the name unlisted in that exact row must fail rule A
    const bad = run(small('managed_agent_create', [{ ...rows[0], blocked: 'none' }]))
    expect(bad.findings).toEqual([
      'rule A: denied "managed_agent_create" is not in the managed_agent_* Blocked cell',
    ])
  })
})
