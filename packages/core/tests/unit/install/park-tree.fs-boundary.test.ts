/**
 * SMI-6531: the park modules obey the static fs boundary (ADR-166 D-11), and
 * the checker itself flags each bypass shape. Ported from the SMI-6676 spike's
 * `harness/c4-fs-boundary.selftest.mjs`.
 *
 * Scope of the claim: the park modules route every fs call through the `fs`
 * default import, contain no delete call, and import nothing outside the park
 * graph except `VERSION` from the core barrel (`park-tree.ts` only). The barrel
 * itself is not walked, so nothing here speaks for code the barrel loads.
 *
 * Two entries cover the modules: `park-tree.ts`, and `parked-index.ts`, which
 * only `park-call.ts` imports at runtime. `park-call.ts` itself imports
 * `config/file-lock` for lock 4, so it is outside the confined walk; it is
 * pinned instead to make no fs call and to import exactly its known modules.
 *
 * Two halves: the real park graph, with its denominator, its fs imports and its
 * one exempt edge pinned, plus planted violations that must be caught; and the
 * checker flagging every known bypass while passing conforming code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkFsBoundary, checkFsBoundarySource } from './park-tree.fs-boundary.js'

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/install')
/** The modules the walk from park-tree.ts reaches. */
const PARK_TREE_GRAPH = [
  'park-callers.ts',
  'park-result.ts',
  'park-tree.destination.ts',
  'park-tree.identity.ts',
  'park-tree.mounts.ts',
  'park-tree.perms.ts',
  'park-tree.postmove.ts',
  'park-tree.ts',
  'park-tree.verify.ts',
  'tree-hash.ts',
]
/** Every module under the boundary: the walk above plus the parked-index entry. */
const PARK_MODULES = [...PARK_TREE_GRAPH, 'parked-index.ts']
const FS_USERS = [
  'park-tree.destination.ts',
  'park-tree.identity.ts',
  'park-tree.mounts.ts',
  'park-tree.postmove.ts',
  'park-tree.ts',
  'park-tree.verify.ts',
  'parked-index.ts',
]
const BARREL = '../index.js'
/** The park never deletes, so no delete member may appear anywhere in its graph. */
const PARK_OPTIONS = { forbidMembers: ['rmSync', 'unlinkSync', 'rmdirSync'] }
/**
 * The one exempt edge: park-tree.ts imports exactly `VERSION` from the core
 * barrel for the sidecar. Bundlers inline core into the CLI and the VS Code
 * extension, where only a resolved import finds the version. Every other edge
 * must stay inside src/install.
 */
const graphFor = (dir: string) => ({
  ...PARK_OPTIONS,
  confineTo: dir,
  exempt: [{ file: path.join(dir, 'park-tree.ts'), spec: BARREL, names: ['VERSION'] }],
})
const GRAPH = graphFor(INSTALL)
const read = (f: string) => fs.readFileSync(path.join(INSTALL, f), 'utf8')

/** A temp copy of the park modules under src/install, plus a stub barrel. */
function withCopy(body: (dir: string) => void): void {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'park-graph-'))
  try {
    const dir = path.join(copy, 'src', 'install')
    fs.mkdirSync(dir, { recursive: true })
    for (const f of PARK_MODULES) fs.copyFileSync(path.join(INSTALL, f), path.join(dir, f))
    fs.writeFileSync(path.join(copy, 'src', 'index.ts'), "export const VERSION = '0.0.0'\n")
    body(dir)
  } finally {
    fs.rmSync(copy, { recursive: true, force: true })
  }
}

describe('the real park graph', () => {
  it('reaches every park module, sees the fs default where fs is used, and has no violation', () => {
    const r = checkFsBoundary(path.join(INSTALL, 'park-tree.ts'), GRAPH)
    const rel = r.files.map((f) => path.relative(INSTALL, f)).sort()
    expect(rel).toEqual([...PARK_TREE_GRAPH].sort())
    for (const f of FS_USERS.filter((u) => PARK_TREE_GRAPH.includes(u))) {
      expect(r.fsLocalsByFile[path.join(INSTALL, f)]).toEqual(['fs'])
    }
    expect(r.violations).toEqual([])
    expect(r.exemptUsed).toEqual([{ file: path.join(INSTALL, 'park-tree.ts'), spec: BARREL }])
  })

  it('parked-index.ts, its own entry for direct consumers, has no violation', () => {
    const r = checkFsBoundary(path.join(INSTALL, 'parked-index.ts'), GRAPH)
    expect(r.files.map((f) => path.basename(f)).sort()).toEqual([
      'park-callers.ts',
      'park-result.ts',
      'parked-index.ts',
    ])
    expect(r.fsLocalsByFile[path.join(INSTALL, 'parked-index.ts')]).toEqual(['fs'])
    expect(r.violations).toEqual([])
  })

  it('park-call.ts (lock 4) makes no fs call and imports exactly its known modules', () => {
    const r = checkFsBoundarySource(read('park-call.ts'), PARK_OPTIONS)
    expect(r.violations).toEqual([])
    expect(r.fsLocals).toEqual([])
    expect([...r.localImports].sort()).toEqual([
      '../config/file-lock.js',
      '../config/lock-tracker.js', // SMI-6531: LockOrderError passes through, not into indexError
      './park-result.js',
      './park-tree.js',
      './parked-index.js',
    ])
    expect(r.externalImports).toEqual([])
  })

  it('positive control: an fs import planted in park-call.ts is seen', () => {
    const planted = `${read('park-call.ts')}\nimport fs from 'node:fs'\nexport const s = fs.statSync('/')\n`
    expect(checkFsBoundarySource(planted, PARK_OPTIONS).fsLocals).toEqual(['fs'])
  })

  it('(a) park-tree.ts is the only park module importing the barrel', () => {
    const importers = PARK_MODULES.filter((f) =>
      checkFsBoundarySource(read(f)).localImports.includes(BARREL)
    )
    expect(importers).toEqual(['park-tree.ts'])
  })

  it('(b) its import from the barrel names exactly VERSION, with no default or namespace form', () => {
    const forms = checkFsBoundarySource(read('park-tree.ts')).importForms.filter(
      (f) => f.spec === BARREL
    )
    expect(forms).toEqual([{ spec: BARREL, form: 'named', names: ['VERSION'] }])
  })

  for (const [entry, plantedIn] of [
    ['park-tree.ts', 'park-tree.postmove.ts'],
    ['parked-index.ts', 'parked-index.ts'],
  ] as const) {
    it(`(c) positive control: a barrel import planted in ${plantedIn} is reported from ${entry}`, () => {
      withCopy((dir) => {
        expect(checkFsBoundary(path.join(dir, entry), graphFor(dir)).violations).toEqual([])
        fs.appendFileSync(
          path.join(dir, plantedIn),
          "\nimport { VERSION } from '../index.js'\nexport const planted = VERSION\n"
        )
        const r = checkFsBoundary(path.join(dir, entry), graphFor(dir))
        expect(r.violations).toContainEqual({
          file: path.join(dir, plantedIn),
          violation: "import '../index.js' leaves the confined directory",
        })
      })
    })
  }

  for (const [label, planted] of [
    ['a second named import', "import { VERSION, SCANNER_RULESET_VERSION } from '../index.js'"],
    ['a namespace import', "import * as core from '../index.js'\nvoid core"],
    ['a re-export', "export { VERSION as V2 } from '../index.js'"],
  ] as const) {
    it(`positive control: park-tree.ts widening its barrel import with ${label} is reported`, () => {
      withCopy((dir) => {
        fs.appendFileSync(path.join(dir, 'park-tree.ts'), `\n${planted}\n`)
        const r = checkFsBoundary(path.join(dir, 'park-tree.ts'), graphFor(dir))
        expect(
          r.violations.some(
            (v) =>
              v.file === path.join(dir, 'park-tree.ts') &&
              v.violation.startsWith("exempt import '../index.js' must be exactly { VERSION }")
          )
        ).toBe(true)
      })
    })
  }

  for (const [label, planted, expected] of [
    ['a named fs import', "\nimport { statSync } from 'node:fs'\n", 'non-default import'],
    [
      'a forbidden delete',
      '\nexport function x(p: string) { fs.rmSync(p) }\n',
      'fs.rmSync is forbidden here',
    ],
    [
      'an unlink',
      '\nexport function x(p: string) { fs.unlinkSync(p) }\n',
      'fs.unlinkSync is forbidden here',
    ],
    [
      'an async delete',
      '\nexport function x(p: string) { fs.promises.rm(p) }\n',
      'fs.promises access',
    ],
  ] as const) {
    it(`positive control: the real park-tree.ts with ${label} planted is flagged`, () => {
      const src = fs.readFileSync(path.join(INSTALL, 'park-tree.ts'), 'utf8')
      const { violations } = checkFsBoundarySource(src + planted, PARK_OPTIONS)
      expect(violations.some((v) => v.includes(expected))).toBe(true)
    })
  }
})

describe('the checker flags each bypass shape', () => {
  const NEGATIVES: [string, string, string][] = [
    ['named import', "import { statSync } from 'node:fs'\nstatSync('/x')", 'non-default import'],
    ['namespace import', "import * as fs from 'fs'\nfs.statSync('/x')", 'non-default import'],
    [
      'default plus named',
      "import fs, { statSync } from 'node:fs'\nfs.lstatSync('/x')",
      'non-default import',
    ],
    ['fs/promises', "import fsp from 'node:fs/promises'", 'fs subpath import'],
    ['re-export', "export { statSync } from 'node:fs'", 're-export'],
    ['import = require', "import fs = require('fs')", 'import = require'],
    ['require', "const fs = require('fs')\nfs.statSync('/x')", 'require() call'],
    [
      'createRequire',
      "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)",
      "import of 'node:module'",
    ],
    ['dynamic import of fs', "const m = await import('node:fs')", "dynamic import of 'node:fs'"],
    [
      'dynamic import, non-literal',
      'const m = await import(name)',
      'dynamic import with a non-literal specifier',
    ],
    ['process.binding', "process.binding('fs')", 'process.binding() call'],
    ['destructured', "import fs from 'node:fs'\nconst { statSync } = fs", 'bare reference'],
    ['aliased', "import fs from 'node:fs'\nconst f = fs\nf.statSync('/x')", 'bare reference'],
    ['passed along', "import fs from 'node:fs'\nhelper(fs)", 'bare reference'],
    ['shorthand property', "import fs from 'node:fs'\nconst o = { fs }", 'bare reference'],
    [
      'method captured',
      "import fs from 'node:fs'\nconst s = fs.statSync\ns('/x')",
      'referenced without being called',
    ],
    ['fs.promises call', "import fs from 'node:fs'\nawait fs.promises.stat('/x')", 'fs.promises'],
    ['getBuiltinModule', "const f = process.getBuiltinModule('node:fs')", 'getBuiltinModule'],
    [
      'getBuiltinModule computed',
      "const f = process['getBuiltinModule']('fs')",
      'getBuiltinModule',
    ],
    [
      'async fs.rm',
      "import fs from 'node:fs'\nfs.rm('/x', {}, () => {})",
      'is not a traced *Sync function',
    ],
    [
      'stream',
      "import fs from 'node:fs'\nfs.createReadStream('/x')",
      'is not a traced *Sync function',
    ],
    [
      'unknown member',
      "import fs from 'node:fs'\nfs.notARealFunctionSync('/x')",
      'is not a traced *Sync function',
    ],
    ['computed member', "import fs from 'node:fs'\nfs['stat' + 'Sync']('/x')", 'computed member'],
    [
      'value import marked type in a mixed clause',
      "import { type Stats, statSync } from 'node:fs'",
      'non-default import',
    ],
  ]
  for (const [label, src, expected] of NEGATIVES) {
    it(`negative: ${label}`, () => {
      const { violations } = checkFsBoundarySource(src)
      expect(violations.some((v) => v.includes(expected))).toBe(true)
    })
  }

  const POSITIVES: [string, string][] = [
    [
      'calls through the default',
      "import fs from 'node:fs'\nfs.lstatSync('/x')\nfs.renameSync('/a', '/b')",
    ],
    ['constants', "import fs from 'node:fs'\nconst f = fs.constants.O_RDONLY"],
    [
      "'fs' as a property name",
      "import fs from 'node:fs'\nconst o = { fs: 1 }\no.fs\nfs.statSync('/x')",
    ],
    [
      'a type-only import',
      "import type { BigIntStats } from 'node:fs'\nlet s: BigIntStats | null = null",
    ],
    [
      'type-only named elements',
      "import { type Stats } from 'node:fs'\nlet s: Stats | null = null",
    ],
    [
      'bypass text in comments and strings',
      "import fs from 'node:fs'\n// import { statSync } from 'node:fs'\nconst s = \"require('fs')\"\nfs.statSync('/x')",
    ],
  ]
  for (const [label, src] of POSITIVES) {
    it(`positive: ${label}`, () => {
      expect(checkFsBoundarySource(src).violations).toEqual([])
    })
  }
})

describe('the walk follows every edge and fails closed', () => {
  let dir = ''
  afterEach(() => {
    if (dir !== '') fs.rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const setup = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-boundary-'))
    fs.writeFileSync(
      path.join(dir, 'unsafe.ts'),
      "import { statSync } from 'node:fs'\nexport const x = statSync\n"
    )
    fs.writeFileSync(
      path.join(dir, 'clean.ts'),
      "import fs from 'node:fs'\nexport function y(p: string) { return fs.lstatSync(p) }\n"
    )
  }
  const walk = (entrySrc: string) => {
    fs.writeFileSync(path.join(dir, 'entry.ts'), entrySrc)
    return checkFsBoundary(path.join(dir, 'entry.ts'))
  }
  for (const [label, entrySrc] of [
    ['a plain relative import', "import { x } from './unsafe.js'\n"],
    ['export * from', "export * from './unsafe.js'\n"],
    ['export { x } from', "export { x } from './unsafe.js'\n"],
    ['a literal dynamic import', "const m = await import('./unsafe.js')\n"],
  ] as const) {
    it(`${label}: the helper's named fs import is flagged`, () => {
      setup()
      const r = walk(entrySrc)
      expect(
        r.violations.some(
          (v) => path.basename(v.file) === 'unsafe.ts' && v.violation.includes('non-default import')
        )
      ).toBe(true)
    })
  }
  for (const [label, entrySrc, expected] of [
    ['a missing relative file', "import './missing.js'\n", 'unresolvable'],
    ['an extensionless specifier', "import './clean'\n", 'unresolvable'],
    ['a bare package', "import x from 'some-package'\n", 'unchecked'],
    ['a file URL', "import x from 'file:///etc/x.mjs'\n", 'unchecked'],
  ] as const) {
    it(`${label}: flagged, not skipped`, () => {
      setup()
      expect(walk(entrySrc).violations.some((v) => v.violation.includes(expected))).toBe(true)
    })
  }
  it('control: a clean relative helper and builtins are walked, not flagged', () => {
    setup()
    const r = walk(
      "import { y } from './clean.js'\nimport path from 'node:path'\nimport os from 'os'\nexport * from './clean.js'\n"
    )
    expect(r.violations).toEqual([])
    expect(r.files.some((f) => path.basename(f) === 'clean.ts')).toBe(true)
  })
})
