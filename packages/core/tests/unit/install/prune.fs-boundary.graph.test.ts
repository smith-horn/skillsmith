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
 * fails if its body uses a write fs member, so a reader name that later grows a
 * write is caught too. (One level: a write hidden in a helper it calls is the
 * module's own pin's to catch.)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { checkFsBoundary, checkFsBoundarySource } from './park-tree.fs-boundary.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = path.resolve(HERE, '../../../src/install')

/** The read-only modules (D19): each is an entry, and everything it reaches is walked. */
const READ_ONLY_ENTRIES = [
  'prune.kinds.ts',
  'prune.measure.ts',
  'prune.classify.ts',
  'prune.list.types.ts',
  'prune.list.parked.ts',
  'prune.list.backups.ts',
  'parked-usage.ts',
]

/** fs members that change the tree or the descriptor table's contents. */
const WRITE_MEMBERS = new Set([
  'unlinkSync',
  'rmdirSync',
  'rmSync',
  'renameSync',
  'mkdirSync',
  'writeFileSync',
  'appendFileSync',
  'openSync',
  'fsyncSync',
  'writeSync',
  'linkSync',
  'symlinkSync',
  'copyFileSync',
  'truncateSync',
  'chmodSync',
  'utimesSync',
])

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

const isWriteCapable = (dir: string, file: string): boolean =>
  checkFsBoundarySource(fs.readFileSync(path.join(dir, file), 'utf8')).fsMembers.some((m) =>
    WRITE_MEMBERS.has(m)
  )

/** The top-level functions and arrow constants in `source` whose own body uses `fs.<write member>`. */
function writingNames(source: string): Set<string> {
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const usesWrite = (n: ts.Node): boolean => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'fs' &&
      WRITE_MEMBERS.has(n.name.text)
    ) {
      // `fs.openSync(p, O_RDONLY | ...)` and `fs.openSync(p, 'r')` read; any other flag may write.
      if (n.name.text === 'openSync' && ts.isCallExpression(n.parent)) {
        const flags = n.parent.arguments[1]?.getText() ?? ''
        return (
          !/^(['"]r['"]|[\w.]*O_RDONLY\b[\w.| ]*)$/.test(flags) ||
          /O_(WRONLY|RDWR|CREAT)/.test(flags)
        )
      }
      return true
    }
    return ts.forEachChild(n, usesWrite) === true
  }
  const out = new Set<string>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined && usesWrite(st))
      out.add(st.name.text)
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer !== undefined && usesWrite(d.initializer)) {
          out.add(d.name.text)
        }
      }
    }
  }
  return out
}

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

  it('no allow-listed name has a body that uses a write fs member', () => {
    for (const [edge, spec] of Object.entries(ALLOWED_EDGES)) {
      const target = edge.split(' -> ')[1] as string
      const writing = writingNames(fs.readFileSync(path.join(INSTALL, target), 'utf8'))
      const names = spec.replace(/^named:/, '').split(',')
      expect(
        names.filter((n) => writing.has(n)),
        edge
      ).toEqual([])
    }
  })

  it('control: writingNames flags a known writer and passes a known reader', () => {
    const inventory = writingNames(
      fs.readFileSync(path.join(INSTALL, 'prune.inventory.ts'), 'utf8')
    )
    expect(inventory.has('writeInventory')).toBe(true)
    expect(inventory.has('loadInventory')).toBe(false)
    const walkShared = writingNames(
      fs.readFileSync(path.join(INSTALL, 'prune.walk.shared.ts'), 'utf8')
    )
    expect(walkShared.has('renameNoReplace')).toBe(true)
    expect(walkShared.has('resumeStagingProblem')).toBe(false)
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
