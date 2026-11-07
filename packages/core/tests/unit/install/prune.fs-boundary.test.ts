/**
 * SMI-6531 (A1 step 6c-i): the prune modules obey ADR-166 D-11's static fs
 * boundary ("Enforcement in tests"): every prune module uses `fs` only as the
 * default import and only through recorded `*Sync` calls, with `rmSync`
 * forbidden, so a destructive call can't hide from an interposer that patches
 * the default object. Ported from the SMI-6676 spike's
 * `harness/test-w5-boundary.mjs`, on the park boundary checker
 * (`park-tree.fs-boundary.ts`).
 *
 * Coverage is by enumeration, not reachability (governance M1): every
 * `prune*.ts` under src/install is listed with readdir, must appear in
 * `FS_MEMBERS`, and is walked as its own entry, so a module nothing imports
 * yet is still checked. Each walk is confined to src/install with no exempt
 * edge, and every module it reaches (the shared strict parser and the park
 * modules too, gate F2) is pinned by the same tables.
 *
 * Per module, the test pins:
 *  - the exact fs members it uses (`FS_MEMBERS`). The deleting calls are
 *    allowed only where named: `unlinkSync` in `prune.walk.ts` (the delete
 *    walk) and `prune.metadata.ts` (`removeIfIdentical`), `rmdirSync` in
 *    `prune.walk.ts`, and `renameSync` only in `prune.walk.shared.ts`
 *    (`renameNoReplace`);
 *  - the exact Node builtins it imports (`BUILTINS`). `child_process` is
 *    allowed nowhere: the module that spawns the walker arrives in 6c-iii and
 *    will be named here then;
 *  - the argument shapes of its tree-changing calls (`callShapeViolations`).
 * And `removeIfIdentical` may be imported only by `prune.walk.ts`, across
 * core, the CLI and the MCP server.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFsBoundary, checkFsBoundarySource } from './park-tree.fs-boundary.js'
import { callShapeViolations } from './prune.fs-boundary.calls.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = path.resolve(HERE, '../../../src/install')
const PACKAGES = path.resolve(HERE, '../../../..')
const OPTIONS = { forbidMembers: ['rmSync'] }

/**
 * Every module a prune entry reaches (the prune modules, the shared strict
 * parser and the park modules they import), and the exact fs members each may
 * use ([] = no fs call). F2: the pin covers the whole reached graph, not just
 * `prune*.ts`; the park boundary test keeps its own rules for the park modules.
 */
const FS_MEMBERS: Record<string, string[]> = {
  'prune.walk.ts': [
    'lstatSync',
    'mkdirSync',
    'readFileSync',
    'readdirSync',
    'rmdirSync',
    'statSync',
    'unlinkSync',
    'writeFileSync',
  ],
  'prune.walk.verify.ts': ['lstatSync', 'readdirSync', 'readlinkSync'],
  'prune.walk.shared.ts': ['lstatSync', 'realpathSync', 'renameSync'],
  'prune.walk.stage.ts': ['writeFileSync'],
  'prune.walk.resume.ts': ['lstatSync', 'readdirSync'],
  'prune.inventory.ts': [
    'closeSync',
    'constants',
    'fstatSync',
    'fsyncSync',
    'openSync',
    'writeSync',
  ],
  'prune.inventory.match.ts': ['lstatSync', 'readdirSync', 'readlinkSync'],
  'prune.metadata.ts': ['lstatSync', 'unlinkSync'],
  'prune.sidecar.ts': [
    'closeSync',
    'constants',
    'fstatSync',
    'lstatSync',
    'openSync',
    'readFileSync',
  ],
  'prune.leftovers.ts': ['lstatSync', 'readdirSync'],
  'prune.job.ts': [],
  'backup-sidecar.strict.ts': [],
  'park-result.ts': [],
  'park-callers.ts': [],
  'park-tree.mounts.ts': ['readFileSync'],
  'park-tree.perms.ts': [],
  'tree-hash.ts': [],
}
/** The exact Node builtins each reached module imports by value. `child_process` is in none. */
const BUILTINS: Record<string, string[]> = {
  'prune.walk.ts': ['crypto', 'fs', 'path', 'worker_threads'],
  'prune.walk.verify.ts': ['crypto', 'fs', 'path'],
  'prune.walk.shared.ts': ['crypto', 'fs', 'path'],
  'prune.walk.stage.ts': ['crypto', 'fs', 'path'],
  'prune.walk.resume.ts': ['fs', 'path'],
  'prune.inventory.ts': ['crypto', 'fs', 'path'],
  'prune.inventory.match.ts': ['fs', 'path'],
  'prune.metadata.ts': ['crypto', 'fs', 'path'],
  'prune.sidecar.ts': ['fs', 'path'],
  'prune.leftovers.ts': ['fs', 'path'],
  'prune.job.ts': ['path'],
  'backup-sidecar.strict.ts': ['path'],
  'park-result.ts': ['path', 'util'],
  'park-callers.ts': ['path'],
  'park-tree.mounts.ts': ['fs', 'path'],
  'park-tree.perms.ts': [],
  'tree-hash.ts': ['crypto'],
}
/** The only modules that may import `removeIfIdentical`, relative to packages/. */
const REMOVE_IMPORTERS = ['core/src/install/prune.walk.ts']

const pruneFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter((n) => /^prune.*\.ts$/.test(n))
    .sort()

interface AllCheck {
  /** Prune modules, or modules a prune entry reaches, that the tables do not list. */
  unlisted: string[]
  violations: { file: string; violation: string }[]
  members: Record<string, string[]>
  builtins: Record<string, string[]>
  shapes: Record<string, string[]>
}

/** Checks every prune module under `dir` as its own entry, and every module each reaches. */
function checkAll(dir: string): AllCheck {
  const r: AllCheck = { unlisted: [], violations: [], members: {}, builtins: {}, shapes: {} }
  const seen = new Set<string>()
  for (const f of pruneFiles(dir)) {
    const g = checkFsBoundary(path.join(dir, f), { ...OPTIONS, confineTo: dir })
    for (const v of g.violations) {
      r.violations.push({ file: path.relative(dir, v.file), violation: v.violation })
    }
    for (const file of [path.join(dir, f), ...g.files]) seen.add(path.relative(dir, file))
  }
  for (const rel of [...seen].sort()) {
    if (!(rel in FS_MEMBERS)) r.unlisted.push(rel)
    const text = fs.readFileSync(path.join(dir, rel), 'utf8')
    const src = checkFsBoundarySource(text, OPTIONS)
    r.members[rel] = src.fsMembers
    r.builtins[rel] = src.builtinImports
    r.shapes[rel] = callShapeViolations(text)
  }
  return r
}

/** A temp copy of src/install's .ts modules (the services type imports are type-only, erased). */
function withCopy(body: (dir: string) => void): void {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-graph-'))
  try {
    for (const n of fs.readdirSync(INSTALL)) {
      if (n.endsWith('.ts')) fs.copyFileSync(path.join(INSTALL, n), path.join(copy, n))
    }
    body(copy)
  } finally {
    fs.rmSync(copy, { recursive: true, force: true })
  }
}

/** Every .ts file under a package's src, recursively. */
function tsFiles(root: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}
const importsRemove = (source: string): boolean =>
  checkFsBoundarySource(source).importForms.some(
    (f) => /prune\.metadata(\.js)?$/.test(f.spec) && f.names.includes('removeIfIdentical')
  )

describe('the real prune modules', () => {
  const real = checkAll(INSTALL)

  it('every prune*.ts, and every module they reach, is listed; the list names nothing else', () => {
    expect(real.unlisted).toEqual([])
    expect(Object.keys(real.members).sort()).toEqual(Object.keys(FS_MEMBERS).sort())
  })

  it('no module any prune entry reaches has a boundary violation', () => {
    expect(real.violations).toEqual([])
  })

  it('each reached module uses exactly its allowed fs members', () => {
    expect(real.members).toEqual(FS_MEMBERS)
  })

  it('each reached module imports exactly its allowed Node builtins, and child_process nowhere', () => {
    expect(real.builtins).toEqual(BUILTINS)
    expect(Object.values(BUILTINS).flat()).not.toContain('child_process')
  })

  it('each tree-changing call has its allowed argument shape', () => {
    expect(real.shapes).toEqual(Object.fromEntries(Object.keys(FS_MEMBERS).map((f) => [f, []])))
  })

  it('removeIfIdentical is imported only by the modules that need it', () => {
    const importers = ['core', 'cli', 'mcp-server']
      .flatMap((pkg) => tsFiles(path.join(PACKAGES, pkg, 'src')))
      .filter((f) => importsRemove(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PACKAGES, f))
    expect(importers).toEqual(REMOVE_IMPORTERS)
  })
})

describe('positive controls: each planted bypass is flagged', () => {
  const walkSrc = () => fs.readFileSync(path.join(INSTALL, 'prune.walk.ts'), 'utf8')

  it('M1: a new prune.extra.ts that nothing imports, with fs.rmSync, is caught', () => {
    withCopy((dir) => {
      expect(checkAll(dir).violations).toEqual([])
      fs.writeFileSync(
        path.join(dir, 'prune.extra.ts'),
        "import fs from 'node:fs'\nexport function x(p: string) {\n  fs.rmSync(p, { recursive: true })\n}\n"
      )
      const r = checkAll(dir)
      expect(r.unlisted).toEqual(['prune.extra.ts'])
      expect(r.violations).toContainEqual({
        file: 'prune.extra.ts',
        violation: 'fs.rmSync is forbidden here',
      })
    })
  })

  it("M1: `import { execFileSync } from 'node:child_process'` in prune.walk.ts is caught", () => {
    withCopy((dir) => {
      fs.appendFileSync(
        path.join(dir, 'prune.walk.ts'),
        "\nimport { execFileSync } from 'node:child_process'\nexport const rm = (p: string) => execFileSync('rm', ['-rf', p])\n"
      )
      const r = checkAll(dir)
      expect(r.violations).toEqual([])
      expect(r.builtins['prune.walk.ts']).toContain('child_process')
      expect(r.builtins).not.toEqual(BUILTINS)
    })
  })

  it('F2: an fs import with fs.unlinkSync appended to backup-sidecar.strict.ts is caught', () => {
    withCopy((dir) => {
      expect(checkAll(dir).members).toEqual(FS_MEMBERS)
      fs.appendFileSync(
        path.join(dir, 'backup-sidecar.strict.ts'),
        "\nimport fs from 'node:fs'\nexport const u = (p: string) => fs.unlinkSync(p)\n"
      )
      const r = checkAll(dir)
      expect(r.members['backup-sidecar.strict.ts']).toEqual(['unlinkSync'])
      expect(r.members).not.toEqual(FS_MEMBERS)
      expect(r.builtins['backup-sidecar.strict.ts']).toEqual(['fs', 'path'])
    })
  })

  it('F2: a raw fs.renameSync in tree-hash.ts is caught by the prune test', () => {
    withCopy((dir) => {
      expect(checkAll(dir).shapes['tree-hash.ts']).toEqual([])
      fs.appendFileSync(
        path.join(dir, 'tree-hash.ts'),
        "\nimport fs from 'node:fs'\nexport const mv = (a: string, b: string) => fs.renameSync(a, b)\n"
      )
      const r = checkAll(dir)
      expect(r.shapes['tree-hash.ts']).toContain('fs.renameSync outside renameNoReplace')
      expect(r.members['tree-hash.ts']).toEqual(['renameSync'])
    })
  })

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
    it(`${label} in prune.walk.ts is flagged`, () => {
      expect(checkFsBoundarySource(walkSrc(), OPTIONS).violations).toEqual([])
      const { violations } = checkFsBoundarySource(walkSrc() + planted, OPTIONS)
      expect(violations.some((v) => v.includes(expected))).toBe(true)
    })
  }

  for (const [label, planted, expected] of [
    [
      'a recursive rmdirSync',
      "\nfs.rmdirSync('x', { recursive: true })\n",
      'fs.rmdirSync with 2 arguments (exactly one allowed)',
    ],
    [
      'a writeFileSync without wx',
      "\nfs.writeFileSync('x', 'y')\n",
      "fs.writeFileSync without { flag: 'wx' }",
    ],
    [
      'a renameSync outside the helper',
      "\nfs.renameSync('a', 'b')\n",
      'fs.renameSync outside renameNoReplace',
    ],
  ] as const) {
    it(`m6: ${label} in prune.walk.ts is flagged`, () => {
      expect(callShapeViolations(walkSrc())).toEqual([])
      expect(callShapeViolations(walkSrc() + planted)).toContain(expected)
    })
  }

  it('m6: renameNoReplace without its lstat check is flagged', () => {
    const src = fs.readFileSync(path.join(INSTALL, 'prune.walk.shared.ts'), 'utf8')
    const stripped = src.replace('    fs.lstatSync(to)\n', '    void to\n')
    expect(stripped).not.toBe(src)
    expect(callShapeViolations(stripped)).toContain(
      'fs.renameSync in renameNoReplace without an earlier lstat'
    )
  })

  it('(c) a planted import of removeIfIdentical in another module is seen', () => {
    const src = fs.readFileSync(path.join(INSTALL, 'prune.leftovers.ts'), 'utf8')
    expect(importsRemove(src)).toBe(false)
    expect(importsRemove(`${src}\nimport { removeIfIdentical } from './prune.metadata.js'\n`)).toBe(
      true
    )
  })
})
