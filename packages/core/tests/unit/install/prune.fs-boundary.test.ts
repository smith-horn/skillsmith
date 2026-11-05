/**
 * SMI-6531 (A1 step 6c-i): the prune modules obey ADR-166 D-11's static fs
 * boundary ("Enforcement in tests"): every prune module uses `fs` only as the
 * default import and only through recorded `*Sync` calls, with `rmSync`
 * forbidden, so a destructive call can't hide from an interposer that patches
 * the default object. Ported from the SMI-6676 spike's
 * `harness/test-w5-boundary.mjs`, on the park boundary checker
 * (`park-tree.fs-boundary.ts`).
 *
 * The walker must unlink and rmdir, so the delete calls are allowed per
 * module, and the allowance is written out below (`FS_MEMBERS`) and pinned
 * exactly: `unlinkSync` only in `prune.walk.ts` (the delete walk) and
 * `prune.metadata.ts` (`removeIfIdentical`), `rmdirSync` only in
 * `prune.walk.ts`. Every other module, the park modules the prune graph
 * reaches included, makes no delete call.
 *
 * Two entries cover the modules: `prune.walk.ts` (the walker) and
 * `prune.leftovers.ts` (the read-only leftover inspection, which the walker
 * does not import). Both walks are confined to src/install with no exempt edge.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFsBoundary, checkFsBoundarySource } from './park-tree.fs-boundary.js'

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/install')
const OPTIONS = { forbidMembers: ['rmSync'] }

/**
 * Every module the two walks reach, and the exact fs members each may use.
 * An empty list means the module makes no fs call at all.
 */
const FS_MEMBERS: Record<string, string[]> = {
  'prune.walk.ts': [
    'lstatSync',
    'mkdirSync',
    'readFileSync',
    'readdirSync',
    'renameSync',
    'rmdirSync',
    'statSync',
    'unlinkSync',
    'writeFileSync',
  ],
  'prune.walk.verify.ts': ['lstatSync', 'readdirSync', 'readlinkSync'],
  'prune.walk.shared.ts': ['realpathSync'],
  'prune.metadata.ts': ['lstatSync', 'renameSync', 'unlinkSync'],
  'prune.sidecar.ts': [
    'closeSync',
    'constants',
    'fstatSync',
    'lstatSync',
    'openSync',
    'readFileSync',
  ],
  'prune.leftovers.ts': ['lstatSync', 'readFileSync', 'readdirSync'],
  'prune.job.ts': [],
  'park-result.ts': [],
  'park-callers.ts': [],
  'park-tree.mounts.ts': ['readFileSync'],
  'park-tree.perms.ts': [],
  'tree-hash.ts': [],
}
const WALK_GRAPH = Object.keys(FS_MEMBERS).filter((f) => f !== 'prune.leftovers.ts')
const LEFTOVERS_GRAPH = [
  'prune.leftovers.ts',
  'prune.sidecar.ts',
  'prune.metadata.ts',
  'prune.walk.shared.ts',
  'park-result.ts',
  'park-callers.ts',
  'park-tree.mounts.ts',
  'park-tree.perms.ts',
]
const PRUNE_MODULES = Object.keys(FS_MEMBERS).filter((f) => f.startsWith('prune.'))

const rel = (files: string[]) => files.map((f) => path.relative(INSTALL, f)).sort()
const membersOf = (r: { fsMembersByFile: Record<string, string[]> }) =>
  Object.fromEntries(
    Object.entries(r.fsMembersByFile).map(([f, m]) => [path.relative(INSTALL, f), m])
  )

describe('the real prune graph', () => {
  it('the walker entry reaches exactly the expected modules, with no violation', () => {
    const r = checkFsBoundary(path.join(INSTALL, 'prune.walk.ts'), {
      ...OPTIONS,
      confineTo: INSTALL,
    })
    expect(rel(r.files)).toEqual([...WALK_GRAPH].sort())
    expect(r.violations).toEqual([])
    expect(r.exemptUsed).toEqual([])
  })

  it('the leftovers entry reaches exactly the expected modules, with no violation', () => {
    const r = checkFsBoundary(path.join(INSTALL, 'prune.leftovers.ts'), {
      ...OPTIONS,
      confineTo: INSTALL,
    })
    expect(rel(r.files)).toEqual([...LEFTOVERS_GRAPH].sort())
    expect(r.violations).toEqual([])
  })

  it('each module uses exactly its allowed fs members, through the fs default only', () => {
    const walk = checkFsBoundary(path.join(INSTALL, 'prune.walk.ts'), {
      ...OPTIONS,
      confineTo: INSTALL,
    })
    const left = checkFsBoundary(path.join(INSTALL, 'prune.leftovers.ts'), {
      ...OPTIONS,
      confineTo: INSTALL,
    })
    const got = { ...membersOf(walk), ...membersOf(left) }
    expect(got).toEqual(FS_MEMBERS)
    for (const f of Object.keys(FS_MEMBERS)) {
      const locals = { ...walk.fsLocalsByFile, ...left.fsLocalsByFile }[path.join(INSTALL, f)]
      expect(locals, f).toEqual((FS_MEMBERS[f] ?? []).length > 0 ? ['fs'] : [])
    }
  })

  it('no prune module imports outside src/install by value', () => {
    for (const f of PRUNE_MODULES) {
      const r = checkFsBoundarySource(fs.readFileSync(path.join(INSTALL, f), 'utf8'), OPTIONS)
      expect(
        r.localImports.filter((s) => !s.startsWith('./')),
        f
      ).toEqual([])
      expect(r.externalImports, f).toEqual([])
    }
  })
})

describe('positive controls: a planted bypass in the real prune.walk.ts is flagged', () => {
  const src = () => fs.readFileSync(path.join(INSTALL, 'prune.walk.ts'), 'utf8')
  for (const [label, planted, expected] of [
    [
      'fs.rmSync',
      '\nexport function x(p: string) { fs.rmSync(p) }\n',
      'fs.rmSync is forbidden here',
    ],
    [
      "a named `import { unlinkSync } from 'node:fs'`",
      "\nimport { unlinkSync } from 'node:fs'\nexport const y = (p: string) => unlinkSync(p)\n",
      "non-default import from 'node:fs'",
    ],
    [
      'a named rmSync alias',
      "\nimport { rmSync as erase } from 'node:fs'\nexport const z = (p: string) => erase(p)\n",
      "non-default import from 'node:fs'",
    ],
    [
      'callback fs.unlink',
      "\nfs.unlink('x', () => {})\n",
      'fs.unlink is not a traced *Sync function',
    ],
    ['fs.promises.rm', "\nvoid fs.promises.rm('x')\n", 'fs.promises access'],
  ] as const) {
    it(`${label} is flagged`, () => {
      expect(checkFsBoundarySource(src(), OPTIONS).violations).toEqual([])
      const { violations } = checkFsBoundarySource(src() + planted, OPTIONS)
      expect(violations.some((v) => v.includes(expected))).toBe(true)
    })
  }

  it('control: unlinkSync and rmdirSync through the default stay allowed by the graph rule', () => {
    const pre = "import fs from 'node:fs'\n"
    expect(checkFsBoundarySource(`${pre}fs.unlinkSync('x')`, OPTIONS).violations).toEqual([])
    expect(checkFsBoundarySource(`${pre}fs.rmdirSync('x')`, OPTIONS).violations).toEqual([])
  })

  it('a planted fs.rmSync in a copy of the graph is reported from the walker entry', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-graph-'))
    try {
      for (const f of Object.keys(FS_MEMBERS)) {
        fs.copyFileSync(path.join(INSTALL, f), path.join(copy, f))
      }
      const opts = { ...OPTIONS, confineTo: copy }
      expect(checkFsBoundary(path.join(copy, 'prune.walk.ts'), opts).violations).toEqual([])
      fs.appendFileSync(
        path.join(copy, 'prune.walk.verify.ts'),
        '\nexport function planted(p: string) { fs.rmSync(p, { recursive: true }) }\n'
      )
      expect(checkFsBoundary(path.join(copy, 'prune.walk.ts'), opts).violations).toContainEqual({
        file: path.join(copy, 'prune.walk.verify.ts'),
        violation: 'fs.rmSync is forbidden here',
      })
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  it('a delete call planted in a module the table forbids it changes that module’s members', () => {
    const planted = `${fs.readFileSync(path.join(INSTALL, 'prune.leftovers.ts'), 'utf8')}\nexport const u = (p: string) => fs.unlinkSync(p)\n`
    const r = checkFsBoundarySource(planted, OPTIONS)
    expect(r.violations).toEqual([])
    expect(r.fsMembers).not.toEqual(FS_MEMBERS['prune.leftovers.ts'])
    expect(r.fsMembers).toContain('unlinkSync')
  })
})
