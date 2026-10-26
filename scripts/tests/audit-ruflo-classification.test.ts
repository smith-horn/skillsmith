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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  evaluateRufloClassification,
  rufloClassificationReportLines,
} from '../audit-ruflo-classification-helpers.mjs'
import {
  P,
  prefixOf,
  CORE,
  WAVE4,
  SETTINGS,
  DOC,
  base,
  run,
  applied,
  row,
} from './audit-ruflo-classification.fixtures'
import type { Fx, Row } from './audit-ruflo-classification.fixtures'

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

  it('array half: core=54 pinned=54 with no findings, always', () => {
    expect(live.coreCount).toBe(54)
    expect(live.pinnedCount).toBe(54)
    expect(live.findings).toEqual([])
  })

  it.skipIf(!existsSync(docPath))(
    'doc half (only when docs/internal exists; CI has none): doc=54 and rules A-F and F2 are clean',
    () => {
      expect(live.findings).toEqual([])
      expect(live.docChecked).toBe(true)
      expect(live.docCount).toBe(54)
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
    expect([r.coreCount, r.pinnedCount, r.docCount]).toEqual([54, 54, 54])
    expect(r.rows).toBeGreaterThan(5)
  })

  it('report lines always print the denominators', () => {
    const [line] = rufloClassificationReportLines(run(base()))
    expect(line.severity).toBe('pass')
    expect(line.message).toContain('core=54 pinned=54 doc=54')
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
    expect(lines[0].message).not.toContain('table rows agree')
    // The counted pass line itself says it covers the array half only (PR #3176 gate).
    expect(lines[0].severity).toBe('pass')
    expect(lines[0].message).toContain('(array half only)')
    expect(lines[0].message).toContain('the doc half was NOT checked')
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

  it('t: an unclosed json fence is a finding, not a pass', () => {
    applied('t:unclosed-fence')
    const r = run({ ...base(), unclosedFence: true })
    expect(r.findings).toContain('doc must hold exactly one closed json fence, found 1')
    expect(r.docCount).toBeNull()
  })

  it('u: settings.json unreadable (readFile throws) -> a finding naming it', () => {
    applied('u:settings-unreadable')
    const r = run({ ...base(), settingsThrows: true })
    expect(r.findings.some((x: string) => x.includes(`${SETTINGS} is unreadable`))).toBe(true)
    expect(r.coreCount).toBeNull()
  })

  it('v: doc exists but readFile throws -> a finding naming it', () => {
    applied('v:doc-unreadable')
    const r = run({ ...base(), docThrows: true })
    expect(r.docChecked).toBe(true)
    expect(r.findings.some((x: string) => x.includes(`doc ${DOC} exists but is unreadable`))).toBe(
      true
    )
    expect(r.docCount).toBeNull()
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

  it('w: a denied tool in an Allowed cell of a row that does not own it -> rule C (full set)', () => {
    const general: Row = { prefix: 'hooks_', allowed: '`intelligence_learn`', blocked: 'none' }
    const specific: Row = { prefix: 'hooks_intelligence_', allowed: '`safe`', blocked: '`learn`' }
    applied('w:allowed-denied-owned-by-other-row')
    expect(run(small('hooks_intelligence_learn', [general, specific])).findings).toEqual([
      'rule C: denied "hooks_intelligence_learn" appears in the Allowed cell as "intelligence_learn"',
    ])
    // negative control: the same rows with a harmless Allowed token stay clean
    const harmless = small('hooks_intelligence_learn', [
      { ...general, allowed: '`safe`' },
      specific,
    ])
    expect(run(harmless).findings).toEqual([])
  })

  it('x: a table row that is none of header, separator, parsed or continuation -> rule F2', () => {
    const shapes = [
      '| `transfer_*` (legacy) | `detect-pii` | none |',
      '| memory_stats | all | none |',
      '| `Session_*` | all | none |',
      '| `hooks_intelligence*` | all | none |',
    ]
    for (const line of shapes) {
      applied(`x:${line}`)
      const f = run({ ...base(), extraTableLines: [line] }).findings
      expect(f).toEqual([`rule F2: unparsed table row: ${line.slice(0, 60)}`])
    }
    // negative control: header, separator and continuation rows (all in the base fixture) are clean
    expect(run(base()).findings).toEqual([])
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

/**
 * SMI-7184: the three denies added for the sql.js fallback write path
 * (`memory_list`, `hooks_intelligence_attention`, `embeddings_search`).
 *
 * Unlike the arms above, these read the REAL `.claude/settings.json` and the
 * real classification doc, apply one in-memory string mutation, and inject the
 * result through `readFile`, so they pin this change's actual edits. Each arm
 * first asserts that the unmutated text holds the token it will remove (or
 * lacks the token it will add) and logs `applied=<arm>:<name>`. Doc arms skip
 * where docs/internal is absent (CI).
 */
describe('SMI-7184', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const settingsPath = join(root, '.claude', 'settings.json')
  const docPath = join(root, 'docs', 'internal', 'architecture', 'ruflo-tool-classification.md')
  const hasDoc = existsSync(docPath)
  const settingsText = readFileSync(settingsPath, 'utf8')
  const docText = hasDoc ? readFileSync(docPath, 'utf8') : ''
  const NAMES = ['memory_list', 'hooks_intelligence_attention', 'embeddings_search']

  /** The single seam every arm mutates through. */
  function mutate(text: string, fn: (t: string) => string): string {
    return fn(text)
  }

  function evalReal(over: { settings?: string; doc?: string; coreEntries?: string[] }) {
    return evaluateRufloClassification({
      settingsPath,
      docPath,
      readFile: (p: string) => {
        if (p === settingsPath) return over.settings ?? settingsText
        if (p === docPath) return over.doc ?? docText
        throw new Error(`ENOENT ${p}`)
      },
      exists: (p: string) => p === settingsPath || (p === docPath && hasDoc),
      ...(over.coreEntries ? { coreEntries: over.coreEntries } : {}),
    })
  }

  const denyOf = (text: string): string[] => JSON.parse(text).permissions.deny as string[]
  const withDeny = (text: string, fn: (d: string[]) => string[]): string => {
    const j = JSON.parse(text)
    j.permissions.deny = fn(j.permissions.deny)
    return JSON.stringify(j, null, 2)
  }
  const splitName = (name: string) => {
    const prefix = prefixOf(name)
    return { prefix, sfx: name.slice(prefix.length) }
  }

  /** Rewrite one cell (0 prefix, 1 Allowed, 2 Blocked) of the table row owning `prefix`. */
  function withCell(doc: string, prefix: string, cell: number, fn: (c: string) => string): string {
    const lines = doc.split('\n')
    const i = lines.findIndex((l) => l.startsWith(`| \`${prefix}*\` |`))
    expect(i, `row for ${prefix}* must exist`).toBeGreaterThan(-1)
    const cs = lines[i].slice(1, lines[i].lastIndexOf('|')).split('|')
    cs[cell] = fn(cs[cell])
    lines[i] = `|${cs.join('|')}|`
    return lines.join('\n')
  }
  const cellOf = (doc: string, prefix: string, cell: number): string => {
    const l = doc.split('\n').find((x) => x.startsWith(`| \`${prefix}*\` |`)) ?? ''
    return l.slice(1, l.lastIndexOf('|')).split('|')[cell] ?? ''
  }
  /** Apply `fn` to the text inside the doc's json fence only. */
  function withFence(doc: string, fn: (f: string) => string): string {
    const a = doc.indexOf('```json')
    const b = doc.indexOf('```', a + 7)
    return doc.slice(0, a) + fn(doc.slice(a, b)) + doc.slice(b)
  }

  for (const name of NAMES) {
    const full = `${P}${name}`
    const { prefix, sfx } = splitName(name)

    it(`SMI-7184 T1 ${name}: removed from the settings deny array -> pin-only`, () => {
      expect(denyOf(settingsText)).toContain(full)
      const settings = mutate(settingsText, (t) => withDeny(t, (d) => d.filter((x) => x !== full)))
      applied(`T1:${name}`)
      const f = evalReal({ settings }).findings
      expect(f).toContain(`pin-only: "${full}" is missing from array`)
      if (hasDoc) {
        expect(f).toContain(`rule B: "${prefix}${sfx}" is in a Blocked cell but is not denied`)
      }
    })

    it(`SMI-7184 T2 ${name}: removed from the pin only -> array-only`, () => {
      expect(CORE).toContain(full)
      applied(`T2:${name}`)
      const coreEntries = mutate(CORE.join('\n'), (t) =>
        t
          .split('\n')
          .filter((x) => x !== full)
          .join('\n')
      ).split('\n')
      expect(evalReal({ coreEntries }).findings).toContain(
        `array-only: "${full}" is not in the pinned list`
      )
    })

    it.skipIf(!hasDoc)(`SMI-7184 T3 ${name}: token removed from Blocked cell -> rule A`, () => {
      expect(cellOf(docText, prefix, 2)).toContain(`\`${sfx}\``)
      const doc = mutate(docText, (t) => withCell(t, prefix, 2, (c) => c.replace(`\`${sfx}\``, '')))
      expect(doc).not.toBe(docText)
      applied(`T3:${name}`)
      expect(evalReal({ doc }).findings).toContain(
        `rule A: denied "${name}" is not in the ${prefix}* Blocked cell`
      )
    })

    it.skipIf(!hasDoc)(`SMI-7184 T4 ${name}: suffix added to Allowed cell -> rule C`, () => {
      expect(cellOf(docText, prefix, 1)).not.toContain(`\`${sfx}\``)
      const doc = mutate(docText, (t) =>
        withCell(t, prefix, 1, (c) => `${c.trimEnd()}, \`${sfx}\` `)
      )
      expect(doc).not.toBe(docText)
      applied(`T4:${name}`)
      expect(evalReal({ doc }).findings).toContain(
        `rule C: denied "${name}" appears in the Allowed cell as "${sfx}"`
      )
    })

    it.skipIf(!hasDoc)(`SMI-7184 T5 ${name}: removed from the doc paste block only`, () => {
      expect(withFence(docText, (f) => f)).toContain(`"${full}"`)
      const doc = mutate(docText, (t) => withFence(t, (f) => f.replace(`      "${full}",\n`, '')))
      expect(doc).not.toBe(docText)
      applied(`T5:${name}`)
      expect(evalReal({ doc }).findings).toContain(`pin-only: "${full}" is missing from doc`)
    })

    // Rule C must read the Allowed cell's parentheticals too: the memory_* and
    // hooks_* Allowed cells carry long ones. Where the row has a parenthetical the
    // denied name goes inside it; embeddings_* has none, so the arm adds one.
    it.skipIf(!hasDoc)(`SMI-7184 T9 ${name}: inside an Allowed parenthetical -> rule C`, () => {
      const cell = cellOf(docText, prefix, 1)
      expect(cell).not.toContain(`\`${sfx}\``)
      const open = cell.indexOf('(')
      const insert = (c: string) =>
        open === -1
          ? `${c.trimEnd()} (not \`${sfx}\`) `
          : `${c.slice(0, open + 1)}\`${sfx}\`, ${c.slice(open + 1)}`
      const doc = mutate(docText, (t) => withCell(t, prefix, 1, insert))
      expect(doc).not.toBe(docText)
      const after = cellOf(doc, prefix, 1)
      const at = after.indexOf(`\`${sfx}\``)
      expect(at).toBeGreaterThan(after.indexOf('('))
      expect(at).toBeLessThan(after.lastIndexOf(')'))
      applied(`T9:${name}`)
      expect(evalReal({ doc }).findings).toContain(
        `rule C: denied "${name}" appears in the Allowed cell as "${sfx}"`
      )
    })
  }

  it.skipIf(!hasDoc)('SMI-7184 T6: embeddings_* Allowed back to "all" -> rule C', () => {
    expect(cellOf(docText, 'embeddings_', 1).trim().startsWith('all')).toBe(false)
    const doc = mutate(docText, (t) =>
      withCell(t, 'embeddings_', 1, () => ' all — pure compute on local vectors ')
    )
    applied('T6:embeddings-all')
    expect(evalReal({ doc }).findings).toContain(
      'rule C: embeddings_* has denials but its Allowed cell starts with "all"'
    )
  })

  it('SMI-7184 T7: memory_list and embeddings_search swapped in the array -> order', () => {
    const a = `${P}memory_list`
    const b = `${P}embeddings_search`
    const d0 = denyOf(settingsText)
    expect(d0.indexOf(b)).toBe(d0.indexOf(a) + 1)
    const settings = mutate(settingsText, (t) =>
      withDeny(t, (d) => {
        const i = d.indexOf(a)
        ;[d[i], d[i + 1]] = [d[i + 1], d[i]]
        return d
      })
    )
    applied('T7:swap')
    expect(evalReal({ settings }).findings).toContain(
      `array order differs from the pinned list at index 39: "${b}" vs "${a}"`
    )
  })

  it('SMI-7184 T8 (known negative): the edited real files are clean at 54', () => {
    const r = evalReal({})
    applied('T8:none')
    expect(r.findings).toEqual([])
    expect([r.coreCount, r.pinnedCount]).toEqual([54, 54])
    if (hasDoc) expect(r.docCount).toBe(54)
  })
})
