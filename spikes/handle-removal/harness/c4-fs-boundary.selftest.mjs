// Self-test for attacks/c4-fs-boundary.mjs (SMI-6715 R2-8 / X7b). Plain node
// script: PASS/FAIL lines, non-zero exit on any failure. Host node.
//
// Two halves: the REAL code C4 runs (quarantine.mjs and every module it imports
// relatively) obeys the boundary; and the checker itself flags each bypass
// shape (known negatives) while passing ordinary code (known positives).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFsBoundary, checkFsBoundarySource } from './attacks/c4-fs-boundary.mjs'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'

const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let allOk = true
function check(label, cond, detail = '') {
  if (!cond) allOk = false
  console.log(
    `[c4-fs-boundary self-test] ${label}: ${cond ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`
  )
}

// 1. The real code. Denominator and presence first: the walk must actually reach
//    quarantine.mjs, hash.mjs and result-shape.mjs, and must SEE the fs default
//    import in the two that use fs, or "no violations" would mean nothing.
{
  const r = checkFsBoundary(path.join(SPIKE, 'quarantine.mjs'))
  const rel = r.files.map((f) => path.relative(SPIKE, f)).sort()
  check(
    'real: transitive walk reaches quarantine.mjs, hash.mjs, result-shape.mjs',
    ['hash.mjs', 'quarantine.mjs', 'result-shape.mjs'].every((f) => rel.includes(f)),
    `files=${rel.join(',')}`
  )
  const locals = (f) => r.fsLocalsByFile[path.join(SPIKE, f)] ?? []
  check(
    'real: the fs default import is seen in quarantine.mjs and hash.mjs',
    locals('quarantine.mjs').includes('fs') && locals('hash.mjs').includes('fs'),
    `quarantine=${locals('quarantine.mjs')} hash=${locals('hash.mjs')}`
  )
  check(
    'real: no boundary violation in any module C4 runs',
    r.violations.length === 0,
    r.violations.map((v) => `${path.relative(SPIKE, v.file)}: ${v.violation}`).join('; ')
  )
}

// 1b. Known positive for the REAL pipeline: the real quarantine.mjs source with
//     one named fs import appended (ESM imports hoist, so this is valid) must be
//     flagged -- the check is not vacuously green on the real file.
{
  const src = fs.readFileSync(path.join(SPIKE, 'quarantine.mjs'), 'utf8')
  const { violations } = checkFsBoundarySource(`${src}\nimport { statSync } from 'node:fs'\n`)
  check(
    'real + injected named import -> flagged',
    violations.some((v) => v.includes('non-default import')),
    violations.join('; ') || 'no violation'
  )
}

// 2. Known negatives: each bypass shape must be flagged, with the right reason.
const NEGATIVES = [
  ['named import', "import { statSync } from 'node:fs'\nstatSync('/x')", 'non-default import'],
  ['namespace import', "import * as fs from 'fs'\nfs.statSync('/x')", 'non-default import'],
  [
    'default plus named',
    "import fs, { statSync } from 'node:fs'\nfs.lstatSync('/x')",
    'non-default import',
  ],
  ['fs/promises', "import fsp from 'node:fs/promises'", 'fs subpath import'],
  ['re-export', "export { statSync } from 'node:fs'", 're-export'],
  ['require', "const fs = require('fs')\nfs.statSync('/x')", 'require() call'],
  [
    'createRequire',
    "import { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)",
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
  [
    'method captured',
    "import fs from 'node:fs'\nconst s = fs.statSync\ns('/x')",
    'referenced without being called',
  ],
  [
    'method captured in a template',
    "import fs from 'node:fs'\nconst t = `${fs.statSync}`",
    'referenced without being called',
  ],
  [
    'fs.promises call (G3-5b)',
    "import fs from 'node:fs'\nawait fs.promises.stat('/x')",
    'fs.promises',
  ],
  [
    'fs.promises captured (G3-5b)',
    "import fs from 'node:fs'\nconst p = fs.promises",
    'fs.promises',
  ],
  // rt3 (a): module loader access, aliased or not.
  [
    'aliased createRequire (rt3 a)',
    "import { createRequire as cr } from 'node:module'\ncr(import.meta.url)('node:fs')",
    "import of 'node:module'",
  ],
  [
    'module default import (rt3 a)',
    "import mod from 'module'\nconst r = mod['create' + 'Require'](import.meta.url)",
    "import of 'module'",
  ],
  [
    'dynamic import of node:module (rt3 a)',
    "const m = await import('node:module')",
    "import of 'node:module'",
  ],
  // rt3 (b): process.getBuiltinModule in any spelling.
  [
    'process.getBuiltinModule call (rt3 b)',
    "const f = process.getBuiltinModule('node:fs')",
    'getBuiltinModule',
  ],
  [
    'getBuiltinModule destructured (rt3 b)',
    "const { getBuiltinModule } = process\ngetBuiltinModule('fs')",
    'getBuiltinModule',
  ],
  [
    'getBuiltinModule computed (rt3 b)',
    "const f = process['getBuiltinModule']('fs')",
    'getBuiltinModule',
  ],
  // rt3 (c): members of the fs default that the interposition never wraps.
  [
    'async fs.rm (rt3 c)',
    "import fs from 'node:fs'\nfs.rm('/x', {}, () => {})",
    'is not a traced *Sync function',
  ],
  [
    'async fs.readFile (rt3 c)',
    "import fs from 'node:fs'\nfs.readFile('/x', () => {})",
    'is not a traced *Sync function',
  ],
  [
    'stream fs.createReadStream (rt3 c)',
    "import fs from 'node:fs'\nfs.createReadStream('/x')",
    'is not a traced *Sync function',
  ],
  [
    'unknown fs member (rt3 c)',
    "import fs from 'node:fs'\nfs.notARealFunctionSync('/x')",
    'is not a traced *Sync function',
  ],
  ['computed member', "import fs from 'node:fs'\nfs['stat' + 'Sync']('/x')", 'computed member'],
]
for (const [label, src, expect] of NEGATIVES) {
  const { violations } = checkFsBoundarySource(src)
  check(
    `negative: ${label} -> flagged`,
    violations.some((v) => v.includes(expect)),
    violations.join('; ') || 'no violation'
  )
}

// 4. Sol round 2: the WALK must follow every way one module pulls in another,
//    and must fail closed on a specifier it cannot check. Each case is a real
//    on-disk entry module pointing at a helper with a named fs import.
{
  const fx = makeFixtureRoot({ harnessRoot: resolveHarnessRoot() })
  try {
    const put = (name, src) => fs.writeFileSync(path.join(fx.root, name), src)
    put('unsafe-helper.mjs', "import { statSync } from 'node:fs'\nexport const x = statSync\n")
    put(
      'clean-helper.mjs',
      "import fs from 'node:fs'\nexport function y(p) { return fs.lstatSync(p) }\n"
    )
    const walk = (entrySrc) => {
      put('entry.mjs', entrySrc)
      try {
        const r = checkFsBoundary(path.join(fx.root, 'entry.mjs'))
        return {
          r,
          text: r.violations.map((v) => `${path.basename(v.file)}: ${v.violation}`).join('; '),
        }
      } catch (err) {
        return { r: null, text: `THREW ${err.code ?? err.name}: ${err.message.slice(0, 60)}` }
      }
    }
    const flagsHelper = ({ r }) =>
      r !== null &&
      r.violations.some(
        (v) =>
          path.basename(v.file) === 'unsafe-helper.mjs' &&
          v.violation.includes('non-default import')
      )
    for (const [label, entrySrc] of [
      ['control: plain relative import', "import { x } from './unsafe-helper.mjs'\n"],
      ['export * from a relative module', "export * from './unsafe-helper.mjs'\n"],
      ['export { x } from a relative module', "export { x } from './unsafe-helper.mjs'\n"],
      [
        'literal dynamic import of a relative module',
        "const m = await import('./unsafe-helper.mjs')\n",
      ],
    ]) {
      const w = walk(entrySrc)
      check(`walk: ${label} -> helper's named fs import flagged`, flagsHelper(w), w.text || 'clean')
    }
    for (const [label, entrySrc, expect] of [
      ['missing relative file', "import './missing.mjs'\n", 'unresolvable'],
      [
        'extensionless relative specifier (ESM does not resolve it)',
        "import './clean-helper'\n",
        'unresolvable',
      ],
      ['directory specifier', "import './'\n", 'unresolvable'],
      ['bare package specifier', "import x from 'some-package'\n", 'unchecked'],
      ['absolute file URL specifier', "import x from 'file:///etc/x.mjs'\n", 'unchecked'],
    ]) {
      const w = walk(entrySrc)
      check(
        `walk: ${label} -> flagged, not skipped`,
        w.r !== null && w.r.violations.some((v) => v.violation.includes(expect)),
        w.text || 'clean'
      )
    }
    {
      const w = walk(
        "import { y } from './clean-helper.mjs'\nimport path from 'node:path'\nimport os from 'os'\nexport * from './clean-helper.mjs'\n"
      )
      check(
        'walk control: clean relative helper and builtins -> walked, not flagged',
        w.r !== null &&
          w.r.violations.length === 0 &&
          w.r.files.some((f) => path.basename(f) === 'clean-helper.mjs'),
        w.text || `files=${w.r?.files.map((f) => path.basename(f)).join(',')}`
      )
    }
  } finally {
    fx.cleanup()
  }
}

// 3. Known positives: ordinary, conforming code must NOT be flagged.
const POSITIVES = [
  [
    'calls through the default',
    "import fs from 'node:fs'\nfs.lstatSync('/x')\nfs.renameSync('/a', '/b')",
  ],
  ['non-function member (constants)', "import fs from 'node:fs'\nconst f = fs.constants.O_RDONLY"],
  [
    "'fs' as a property name",
    "import fs from 'node:fs'\nconst o = { fs: 1 }\no.fs\nfs.statSync('/x')",
  ],
  [
    'bypass text only inside comments and strings',
    "import fs from 'node:fs'\n// import { statSync } from 'node:fs'\nconst s = \"require('fs')\"\nfs.statSync('/x')",
  ],
  [
    'other default imports',
    "import path from 'node:path'\nimport crypto from 'node:crypto'\npath.join('a')",
  ],
]
for (const [label, src] of POSITIVES) {
  const { violations } = checkFsBoundarySource(src)
  check(`positive: ${label} -> not flagged`, violations.length === 0, violations.join('; '))
}

if (!allOk) {
  console.error('[c4-fs-boundary self-test] FAIL')
  process.exit(1)
}
console.log('[c4-fs-boundary self-test] all cases passed')
process.exit(0)
