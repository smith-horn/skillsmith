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
    'createRequire() call',
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
