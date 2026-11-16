/**
 * SMI-6531 (A1 step 6c-ii-a): the read-only invariant over the IMPORT GRAPH.
 *
 * `prune.fs-boundary.test.ts` pins each module's own fs members. That cannot see
 * a read-only module importing a write-capable FUNCTION: `prune.list.parked.ts`
 * can import and call `renameNoReplace` while its own pin stays `lstatSync,
 * readdirSync, statSync`, because the `renameSync` is inside the imported
 * module. So this test walks everything each read-only module reaches and
 * checks every import edge from a module that does not itself write into a
 * write-capable module (one whose own source uses a write fs member) against a
 * per-edge allow-list of the names it may take. An edge not listed, or a name
 * not listed on it, fails. Edges between write-capable modules are not the
 * question: they only run if a reader calls the writer, and that call is an
 * edge into the writer.
 *
 * The allow-list holds only names that read: constants, regexes, parsers,
 * `readStable`. A second check reads each allowed name's own declaration and
 * fails if it can write: its body uses a write fs member, or mentions a name in
 * its own module that does, or a named import that does (`writingNames`
 * follows that to a fixpoint through any depth of imports). So a reader name
 * that later grows a write, or a call to a writer, is caught too.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFsBoundary, checkFsBoundarySource } from './park-tree.fs-boundary.js'
import { WRITE_MEMBERS, writingNames as writingNamesIn } from './fs-write-shape.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = path.resolve(HERE, '../../../src/install')

/** The read-only modules (D19, and 6c-ii-b's planner): each is an entry, and everything it reaches is walked. */
const READ_ONLY_ENTRIES = [
  'prune.plan.types.ts',
  'prune.select.ts',
  'prune.select.digest.ts',
  'prune.select.match.ts',
  'prune.select.paths.ts',
  'prune.kinds.ts',
  'prune.measure.ts',
  'prune.classify.ts',
  'prune.list.types.ts',
  'prune.list.parked.ts',
  'prune.list.backups.ts',
  'parked-usage.ts',
]

/**
 * `<importer> -> <write-capable target>`: the form and the exact names the
 * importer may take. Read-only names only.
 */
const ALLOWED_EDGES: Record<string, string> = {
  'prune.classify.ts -> prune.sidecar.ts': 'named:parseSidecarStrict,readStable',
  'prune.inventory.match.ts -> prune.inventory.ts':
    'named:D_NAME_RE,INVENTORY_FILE,INVENTORY_TMP,STAGING_KEY,sha256Of',
  'prune.inventory.match.ts -> prune.sidecar.ts': 'named:readStable',
  'prune.inventory.match.ts -> prune.walk.shared.ts': 'named:SIDECAR_KEY,typeOf',
  'prune.leftovers.ts -> prune.inventory.ts':
    'named:INVENTORY_FILE,INVENTORY_TMP,loadInventory,parseInventoryStrict,stagingMatches',
  'prune.leftovers.ts -> prune.metadata.ts':
    'named:parseDeletingStrict,parseIntentStrict,runBindingProblem',
  'prune.leftovers.ts -> prune.sidecar.ts': 'named:readStable',
  'prune.leftovers.ts -> prune.walk.shared.ts': 'named:META,RANDOM_NAME_RE,resumeStagingProblem',
}

/** `file`'s top-level names that can write (see `fs-write-shape.ts`). */
const writingNames = (file: string, dir = INSTALL): Set<string> =>
  writingNamesIn(path.join(dir, file))

const isWriteCapable = (dir: string, file: string): boolean =>
  checkFsBoundarySource(fs.readFileSync(path.join(dir, file), 'utf8')).fsMembers.some((m) =>
    WRITE_MEMBERS.has(m)
  )

/** Every edge into a write-capable module, from any module a read-only entry reaches. */
export function writeCapableEdges(dir: string): Record<string, string> {
  const reached = new Set<string>()
  for (const entry of READ_ONLY_ENTRIES) {
    const g = checkFsBoundary(path.join(dir, entry), {
      forbidMembers: ['rmSync'],
      confineTo: dir,
    })
    for (const f of [path.join(dir, entry), ...g.files]) reached.add(path.basename(f))
  }
  const edges: Record<string, string[]> = {}
  for (const importer of [...reached].sort()) {
    if (isWriteCapable(dir, importer)) continue
    const text = fs.readFileSync(path.join(dir, importer), 'utf8')
    for (const form of checkFsBoundarySource(text).importForms) {
      if (!form.spec.startsWith('./')) continue
      const target = `${form.spec.slice(2).replace(/\.js$/, '')}.ts`
      if (!fs.existsSync(path.join(dir, target)) || !isWriteCapable(dir, target)) continue
      const key = `${importer} -> ${target}`
      ;(edges[key] ??= []).push(`${form.form}:${[...form.names].sort().join(',')}`)
    }
  }
  return Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, v.sort().join(' | ')]))
}

/** A temp copy of src/install's .ts modules. */
function withCopy(body: (dir: string) => void): void {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-edges-'))
  try {
    for (const n of fs.readdirSync(INSTALL)) {
      if (n.endsWith('.ts')) fs.copyFileSync(path.join(INSTALL, n), path.join(copy, n))
    }
    body(copy)
  } finally {
    fs.rmSync(copy, { recursive: true, force: true })
  }
}

describe('the read-only modules import no write-capable function (6c-ii-a)', () => {
  it('every edge into a write-capable module is allow-listed with exactly its names', () => {
    expect(writeCapableEdges(INSTALL)).toEqual(ALLOWED_EDGES)
  })

  it('no allow-listed name can write, in its body or through anything it calls', () => {
    for (const [edge, spec] of Object.entries(ALLOWED_EDGES)) {
      const target = edge.split(' -> ')[1] as string
      const writing = writingNames(target)
      const names = spec.replace(/^named:/, '').split(',')
      expect(
        names.filter((n) => writing.has(n)),
        edge
      ).toEqual([])
    }
  })

  it('control: writingNames flags a known writer and passes a known reader', () => {
    const inventory = writingNames('prune.inventory.ts')
    expect(inventory.has('writeInventory')).toBe(true)
    expect(inventory.has('loadInventory')).toBe(false)
    const walkShared = writingNames('prune.walk.shared.ts')
    expect(walkShared.has('renameNoReplace')).toBe(true)
    expect(walkShared.has('resumeStagingProblem')).toBe(false)
  })

  it('control: a write reached through a call inside a reader name is caught', () => {
    withCopy((dir) => {
      expect(writingNames('prune.inventory.ts', dir).has('loadInventory')).toBe(false)
      const f = path.join(dir, 'prune.inventory.ts')
      const src = fs.readFileSync(f, 'utf8')
      const planted = src.replace(
        'export function loadInventory(S: string): InventoryLoad {\n',
        'export function loadInventory(S: string): InventoryLoad {\n  renameNoReplace(S, S)\n'
      )
      expect(planted).not.toBe(src)
      fs.writeFileSync(f, planted)
      expect(writingNames('prune.inventory.ts', dir).has('loadInventory')).toBe(true)
    })
  })

  it('control: prune.list.parked.ts importing and calling renameNoReplace is caught', () => {
    withCopy((dir) => {
      expect(writeCapableEdges(dir)).toEqual(ALLOWED_EDGES)
      fs.appendFileSync(
        path.join(dir, 'prune.list.parked.ts'),
        "\nimport { renameNoReplace } from './prune.walk.shared.js'\n" +
          'export const planted = (a: string, b: string) => renameNoReplace(a, b)\n'
      )
      const edges = writeCapableEdges(dir)
      expect(edges).not.toEqual(ALLOWED_EDGES)
      expect(edges['prune.list.parked.ts -> prune.walk.shared.ts']).toBe('named:renameNoReplace')
    })
  })

  it('control: a write-capable name added to an edge that already exists is caught', () => {
    withCopy((dir) => {
      fs.appendFileSync(
        path.join(dir, 'prune.leftovers.ts'),
        "\nimport { removeIfIdentical } from './prune.metadata.js'\n" +
          'export const planted = removeIfIdentical\n'
      )
      expect(writeCapableEdges(dir)).not.toEqual(ALLOWED_EDGES)
    })
  })
})

describe('F8: every shape of a write is seen, not only fs.<Sync member>', () => {
  const HEAD = 'export function loadInventory(S: string): InventoryLoad {\n'
  /** `prune.inventory.ts` with `line` as the first statement of `loadInventory` (and `top` ahead of the file). */
  function plant(dir: string, line: string, top = ''): void {
    const f = path.join(dir, 'prune.inventory.ts')
    const src = fs.readFileSync(f, 'utf8')
    const planted = top + src.replace(HEAD, HEAD + line)
    expect(planted).not.toBe(top + src)
    fs.writeFileSync(f, planted)
  }
  const loadWrites = (dir: string): boolean =>
    writingNames('prune.inventory.ts', dir).has('loadInventory')

  const WRITES: [string, string][] = [
    ['fs.promises.rm', '  void fs.promises.rm(S)\n'],
    ["a computed fs['renameSync']", "  fs['renameSync'](S, S)\n"],
    ['a computed fs[member] that is not a literal', '  fs[S](S)\n'],
    ["a computed fs.promises['rm']", "  void fs.promises['rm'](S)\n"],
    ['a captured fs.renameSync', '  const f = fs.renameSync\n  f(S, S)\n'],
    ['a destructured member', '  const { renameSync } = fs\n  renameSync(S, S)\n'],
    ['a destructured fs.promises member', '  const { rm } = fs.promises\n  void rm(S)\n'],
    ['a destructuring with a rest element', '  const { ...all } = fs\n  void all\n'],
    ['an aliased fs', '  const f = fs\n  f.renameSync(S, S)\n'],
    ['fs.cpSync', '  fs.cpSync(S, S)\n'],
    ['fs.mkdtempSync', '  fs.mkdtempSync(S)\n'],
    ['fs.chownSync', '  fs.chownSync(S, 0, 0)\n'],
    ['fs.lchownSync', '  fs.lchownSync(S, 0, 0)\n'],
    ['fs.futimesSync', '  fs.futimesSync(0, 0, 0)\n'],
    ['fs.lutimesSync', '  fs.lutimesSync(S, 0, 0)\n'],
    ['fs.ftruncateSync', '  fs.ftruncateSync(0)\n'],
    ['fs.createWriteStream', '  fs.createWriteStream(S)\n'],
    ['the callback form fs.rename', '  fs.rename(S, S, () => undefined)\n'],
    ['the callback form fs.writeFile', "  fs.writeFile(S, '', () => undefined)\n"],
  ]
  for (const [label, line] of WRITES) {
    it(`${label} in a reader name is a write`, () => {
      withCopy((dir) => {
        expect(loadWrites(dir)).toBe(false)
        plant(dir, line)
        expect(loadWrites(dir)).toBe(true)
      })
    })
  }

  const READS: [string, string][] = [
    ['fs.promises.readFile', '  void fs.promises.readFile(S)\n'],
    ["a computed fs['readFileSync']", "  fs['readFileSync'](S)\n"],
    ['a destructured read member', '  const { readFileSync } = fs\n  readFileSync(S)\n'],
    ['fs.readFile (callback)', '  fs.readFile(S, () => undefined)\n'],
  ]
  for (const [label, line] of READS) {
    it(`control: ${label} is not a write`, () => {
      withCopy((dir) => {
        plant(dir, line)
        expect(loadWrites(dir)).toBe(false)
      })
    })
  }

  it('a namespace import of a write-capable module, called from a reader name, is a write', () => {
    withCopy((dir) => {
      // `removeEmptyDirs` is not a name prune.inventory.ts imports, so only the namespace can reach it.
      plant(dir, '  w.removeEmptyDirs(S, S)\n', "import * as w from './prune.walk.stage.js'\n")
      expect(loadWrites(dir)).toBe(true)
    })
  })

  it('a re-export of a write-capable name makes the re-exporting module write under that name', () => {
    withCopy((dir) => {
      fs.appendFileSync(
        path.join(dir, 'prune.inventory.ts'),
        "\nexport { renameNoReplace as laundered } from './prune.walk.shared.js'\n"
      )
      expect(writingNames('prune.inventory.ts', dir).has('laundered')).toBe(true)
    })
  })

  it('an export-star of a write-capable module brings its write names along', () => {
    withCopy((dir) => {
      fs.appendFileSync(
        path.join(dir, 'prune.inventory.ts'),
        "\nexport * from './prune.walk.shared.js'\n"
      )
      expect(writingNames('prune.inventory.ts', dir).has('renameNoReplace')).toBe(true)
    })
  })
})
