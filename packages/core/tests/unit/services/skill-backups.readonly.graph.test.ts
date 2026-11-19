/**
 * SMI-6531 (A1 step 6c-ii-a, governance round 2 F7): the read-only invariant
 * over every module `listBackups` and the `doctor backups` CLI path reach.
 *
 * The zero-mutation test in the CLI spies the default `fs` export and
 * `fs.promises`. It cannot see a named `import { mkdirSync } from 'node:fs'`, a
 * namespace import, or anything outside those two objects, and the install-graph
 * test stops at `src/install`. This one walks the import graph of the listing
 * and of the three CLI modules, in two zones:
 *
 *  - the STRICT zone (`src/services` and the CLI's `doctor.backups.*`) is code
 *    that has no business writing at all: no function in a reached module of it
 *    may write, and none may import a write member by name;
 *  - every edge from the strict zone into any other module (install, config, ...)
 *    must take only names that cannot write, by name. `writingNames` follows a
 *    name through every call and import it makes, so a reader name that reaches
 *    a writer many modules deep is a writer; a namespace, default, re-export or
 *    side-effect import of a module that can write cannot be proven and fails.
 *
 * `fs-write-shape.ts` holds the predicates and the one list of write members.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { checkFsBoundarySource } from '../install/park-tree.fs-boundary.js'
import { fsBindingsOf, resolveSpec, writingNames } from '../install/fs-write-shape.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../../src')
const CLI = path.resolve(HERE, '../../../../cli/src/commands')

/** The entries: the listing, and the CLI modules the command runs. */
const entriesIn = (src: string, cli: string): string[] => [
  path.join(src, 'services/skill-backups.listing.ts'),
  path.join(cli, 'doctor.backups.ts'),
  path.join(cli, 'doctor.backups.json.ts'),
  path.join(cli, 'doctor.backups.render.ts'),
]

interface Edge {
  importer: string
  form: string
  names: string[]
}

/** Every module reached from `entries` by a relative value import, and the edges into each. */
function walk(entries: string[]): { reached: Set<string>; into: Map<string, Edge[]> } {
  const reached = new Set<string>()
  const into = new Map<string, Edge[]>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (reached.has(file)) continue
    reached.add(file)
    for (const f of checkFsBoundarySource(fs.readFileSync(file, 'utf8')).importForms) {
      const target = resolveSpec(file, f.spec)
      if (target === null) continue
      const edge = { importer: file, form: f.form, names: f.names }
      into.set(target, [...(into.get(target) ?? []), edge])
      queue.push(target)
    }
  }
  return { reached, into }
}

const writeImportsOf = (file: string): string[] => {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  return [...fsBindingsOf(sf).writeNamed.values()]
}

/** Why the graph from `entries` is not read-only, by file relative to `root`. Empty when it is. */
export function readOnlyViolations(entries: string[], src: string, cli: string): string[] {
  const { reached, into } = walk(entries)
  const rel = (f: string): string => path.relative(src, f).split(path.sep).join('/')
  const strict = (f: string): boolean =>
    f.startsWith(path.join(src, 'services') + path.sep) || path.dirname(f) === cli
  const out: string[] = []
  for (const f of reached) {
    const names = [...writingNames(f), ...writeImportsOf(f)]
    if (strict(f) && names.length > 0)
      out.push(`${rel(f)} can write: ${[...new Set(names)].sort().join(', ')}`)
  }
  for (const [target, edges] of into) {
    const writes = writingNames(target)
    if (strict(target) || (writes.size === 0 && writeImportsOf(target).length === 0)) continue
    for (const e of edges.filter((x) => strict(x.importer))) {
      const taken = e.names.filter((n) => writes.has(n))
      if (e.form !== 'named' || taken.length > 0) {
        const why = e.form !== 'named' ? '' : ` (${taken.join(', ')} can write)`
        out.push(`${rel(e.importer)} takes ${rel(target)} as ${e.form}${why}`)
      }
    }
  }
  return out.sort()
}

/** A temp copy of the core src tree (`.ts` only) with a sibling copy of the CLI's `doctor.backups.*` modules. */
function withCopy(body: (src: string, cli: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-readonly-'))
  try {
    const src = path.join(root, 'core-src')
    const cli = path.join(root, 'cli-commands')
    fs.cpSync(SRC, src, {
      recursive: true,
      filter: (p) => fs.statSync(p).isDirectory() || p.endsWith('.ts'),
    })
    fs.mkdirSync(cli)
    for (const n of fs.readdirSync(CLI)) {
      if (n.startsWith('doctor.backups.') && n.endsWith('.ts') && !n.endsWith('.test.ts')) {
        fs.copyFileSync(path.join(CLI, n), path.join(cli, n))
      }
    }
    body(src, cli)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Each copy-based control copies the source tree and walks its import graph, often twice. On a
// loaded CI runner that took 36-40 s per case (#3267, run 44364742912) against the repo's 15 s
// `testTimeout` (`vitest.preset.ts`); the whole file took 100 s on #3248. This raises the time
// limit only; no assertion changes.
const GRAPH_TEST_TIMEOUT_MS = 120_000

describe(
  'the listing and the doctor backups path are read-only (F7)',
  { timeout: GRAPH_TEST_TIMEOUT_MS },
  () => {
    it('no strict-zone module can write, and every edge out of it takes only read-only names', () => {
      expect(readOnlyViolations(entriesIn(SRC, CLI), SRC, CLI)).toEqual([])
    })

    it('control: the real graph reaches the services, the install and config modules and the CLI render', () => {
      const { reached, into } = walk(entriesIn(SRC, CLI))
      const names = [...reached].map((f) => path.basename(f))
      for (const n of [
        'skill-backups.listing.ts',
        'skill-backups.areas.ts',
        'prune.list.parked.ts',
        'workspace-scope.ts',
        'doctor.backups.render.ts',
      ]) {
        expect(names).toContain(n)
      }
      // workspace-scope.ts imports mkdirSync by name: the case the existing spy cannot see. It is
      // reached, and passes only because the names the services take from it cannot write.
      const ws = path.join(SRC, 'install/workspace-scope.ts')
      expect(writeImportsOf(ws)).toContain('mkdirSync')
      expect(writingNames(ws).size).toBeGreaterThan(0)
      const taken = (into.get(ws) ?? []).flatMap((e) => e.names)
      expect(taken.length).toBeGreaterThan(0)
      expect(taken.filter((n) => writingNames(ws).has(n))).toEqual([])
    })

    const PLANTS: [string, string, string][] = [
      [
        'a named mkdirSync import and call in skill-backups.areas.ts',
        'services/skill-backups.areas.ts',
        "\nimport { mkdirSync } from 'node:fs'\nexport const planted = (p: string) => mkdirSync(p)\n",
      ],
      [
        'a namespace import and write in skill-backups.records.ts',
        'services/skill-backups.records.ts',
        "\nimport * as nfs from 'node:fs'\nexport const planted = (p: string) => nfs.rmSync(p)\n",
      ],
      [
        'fs.promises.rm through the default fs in skill-backups.narrow.ts',
        'services/skill-backups.narrow.ts',
        '\nexport const planted = (p: string) => fs.promises.rm(p)\n',
      ],
      [
        'a node:fs/promises named import in skill-backups.areas.ts',
        'services/skill-backups.areas.ts',
        "\nimport { rm } from 'node:fs/promises'\nexport const planted = (p: string) => rm(p)\n",
      ],
      [
        'a call into a writer from skill-backups.listing.ts',
        'services/skill-backups.listing.ts',
        "\nimport { renameNoReplace } from '../install/prune.walk.shared.js'\nexport const planted = (a: string) => renameNoReplace(a, a)\n",
      ],
    ]
    for (const [label, file, planted] of PLANTS) {
      it(`control: ${label} is caught`, () => {
        withCopy((src, cli) => {
          expect(readOnlyViolations(entriesIn(src, cli), src, cli)).toEqual([])
          fs.appendFileSync(path.join(src, file), planted)
          const v = readOnlyViolations(entriesIn(src, cli), src, cli)
          expect(v.some((x) => x.startsWith(`${file} can write`))).toBe(true)
        })
      })
    }

    it('control: a write planted in a reached install function is caught at the edge into it', () => {
      withCopy((src, cli) => {
        const f = path.join(src, 'install/parked-usage.ts')
        const text = fs.readFileSync(f, 'utf8')
        const hook = 'const perVolume = judgeParkedUsage(entries, options)'
        expect(text).toContain(hook)
        fs.writeFileSync(f, text.replace(hook, `${hook}\n  fs.rmSync('/x')`))
        expect(readOnlyViolations(entriesIn(src, cli), src, cli)).toContain(
          'services/skill-backups.listing.ts takes install/parked-usage.ts as named (evaluateParkedUsage can write)'
        )
      })
    })

    it('control: a write several modules down, behind a name the services take, is caught', () => {
      withCopy((src, cli) => {
        // `prune.list.parked.ts` imports nothing writing from here today; a writer added to the
        // module it imports `errCode` from reaches `listParkedArea` through that call.
        const park = path.join(src, 'install/park-result.ts')
        fs.appendFileSync(
          park,
          "\nimport nfs from 'node:fs'\nexport const errCodeAndWrite = (e: unknown) => nfs.rmSync('/x')\n"
        )
        const text = fs.readFileSync(path.join(src, 'install/prune.list.parked.ts'), 'utf8')
        expect(text).toContain("import { errCode } from './park-result.js'")
        fs.writeFileSync(
          path.join(src, 'install/prune.list.parked.ts'),
          text
            .replace(
              "import { errCode } from './park-result.js'",
              "import { errCode, errCodeAndWrite } from './park-result.js'"
            )
            .replace(
              'const isFile = (p: string): boolean => {',
              'const isFile = (p: string): boolean => {\n  errCodeAndWrite(p)'
            )
        )
        const v = readOnlyViolations(entriesIn(src, cli), src, cli)
        expect(
          v.some((x) => x.includes('takes install/prune.list.parked.ts as named (listParkedArea'))
        ).toBe(true)
      })
    })

    const WS = 'install/workspace-scope.ts'
    it('control: workspace-scope taken by a name that writes is caught', () => {
      withCopy((src, cli) => {
        const writer = [...writingNames(path.join(src, WS))][0] as string
        expect(writer).toBeDefined()
        fs.appendFileSync(
          path.join(src, 'services/skill-backups.areas.ts'),
          `\nimport { ${writer} } from '../install/workspace-scope.js'\nexport const planted = ${writer}\n`
        )
        const v = readOnlyViolations(entriesIn(src, cli), src, cli)
        expect(v).toContain(
          `services/skill-backups.areas.ts takes ${WS} as named (${writer} can write)`
        )
      })
    })

    it('control: workspace-scope taken as a namespace is caught', () => {
      withCopy((src, cli) => {
        fs.appendFileSync(
          path.join(src, 'services/skill-backups.areas.ts'),
          "\nimport * as ws from '../install/workspace-scope.js'\nexport const planted = ws\n"
        )
        expect(readOnlyViolations(entriesIn(src, cli), src, cli)).toContain(
          `services/skill-backups.areas.ts takes ${WS} as namespace`
        )
      })
    })
  }
)
