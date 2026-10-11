#!/usr/bin/env node
// scripts/tests/fixtures/executable-frontmatter/generate-fixtures.mjs
// SMI-7030: regenerates gray-matter-4.0.3.cases.json, the golden fixture table for
// the `executable_frontmatter` predicate (plan: smi-7030-js-frontmatter-flag-rule.md,
// Q1 and Wave 1 Step 1).
//
// For every case-table row this runs the REAL gray-matter 4.0.3 and records:
//   input : the SKILL.md text fed to gray-matter
//   A     : gray-matter's own opener + language detection resolves its `javascript` engine
//   eval  : the real `javascript` engine's parse() was actually invoked (the eval sink)
//
// gray-matter is deliberately NOT a repo dependency. It is loaded from an isolated,
// throwaway install passed as --gray-matter-root (see the Q1 command in the plan).
// The case inputs are benign markers (object literals, comments, one bare identifier
// that throws ReferenceError); the generator evals them by design.
//
// Run (from the repo root, on the host):
//   (
//     set -eu
//     REPO_ROOT="$(git rev-parse --show-toplevel)"
//     GM_TMP="$(mktemp -d)"
//     trap 'rm -rf "$GM_TMP"' EXIT
//     cd "$GM_TMP"
//     npm init -y >/dev/null
//     npm install --ignore-scripts --no-audit --no-fund --save-exact gray-matter@4.0.3 js-yaml@3.15.2
//     node "$REPO_ROOT/scripts/tests/fixtures/executable-frontmatter/generate-fixtures.mjs" --gray-matter-root "$GM_TMP"
//   )
//
// Output is byte-reproducible: no timestamp, no Node version, stable row order.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'gray-matter-4.0.3.cases.json')
const WANT_GRAY_MATTER = '4.0.3'
const WANT_JS_YAML = '3.15.2'

function fail(message) {
  console.error(`generate-fixtures: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const i = argv.indexOf('--gray-matter-root')
  if (i === -1 || !argv[i + 1]) fail('usage: generate-fixtures.mjs --gray-matter-root <dir>')
  return resolve(argv[i + 1])
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return fail(`cannot read ${path}: ${err.message}`)
  }
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + sep)

// The generator evals case inputs by design, so the gray-matter install must be a
// throwaway directory under the OS temp dir and never inside this repository.
// Both sides are realpath'd first (macOS /var vs /private/var).
function assertThrowawayRoot(dir) {
  let real
  try {
    real = realpathSync(dir)
  } catch (err) {
    return fail(`--gray-matter-root ${dir} is not readable: ${err.message}`)
  }
  const repoRoot = realpathSync(resolve(HERE, '..', '..', '..', '..'))
  if (isInside(real, repoRoot))
    fail(`--gray-matter-root ${real} is inside the repository ${repoRoot}`)
  if (!isInside(real, realpathSync(tmpdir()))) {
    fail(`--gray-matter-root ${real} is not under the OS temp directory ${realpathSync(tmpdir())}`)
  }
}

// ---------------------------------------------------------------------------
// Load gray-matter from the isolated install and refuse unless versions match.
// ---------------------------------------------------------------------------
const root = parseArgs(process.argv.slice(2))
assertThrowawayRoot(root)
const gmDir = join(root, 'node_modules', 'gray-matter')
const gmPkg = readJson(join(gmDir, 'package.json'))
if (gmPkg.version !== WANT_GRAY_MATTER) {
  fail(`gray-matter at ${gmDir} is ${gmPkg.version}, need exactly ${WANT_GRAY_MATTER}`)
}
const requireFromGm = createRequire(join(gmDir, 'index.js'))
const jsYamlPkg = readJson(requireFromGm.resolve('js-yaml/package.json'))
if (jsYamlPkg.version !== WANT_JS_YAML) {
  fail(`js-yaml resolved from gray-matter is ${jsYamlPkg.version}, need exactly ${WANT_JS_YAML}`)
}
const lock = readJson(join(root, 'package-lock.json'))
const lockGm = lock.packages?.['node_modules/gray-matter']
const lockYaml = lock.packages?.['node_modules/js-yaml']
if (lockGm?.version !== WANT_GRAY_MATTER || !lockGm.integrity) {
  fail('package-lock.json does not record gray-matter 4.0.3 with an integrity')
}
if (lockYaml?.version !== WANT_JS_YAML) {
  fail(`package-lock.json records js-yaml ${lockYaml?.version}, need exactly ${WANT_JS_YAML}`)
}

const matter = requireFromGm('gray-matter')
const engines = requireFromGm('gray-matter/lib/engines')
const getEngine = requireFromGm('gray-matter/lib/engine')
const defaults = requireFromGm('gray-matter/lib/defaults')
const stripBom = requireFromGm('strip-bom-string')

// Wrap the real javascript engine's parse to record whether it evaluated.
// gray-matter copies engine objects by reference (lib/defaults.js), so mutating
// the shared object is seen by every call.
let evaluated = false
const realParse = engines.javascript.parse
engines.javascript.parse = function (...args) {
  evaluated = true
  return realParse.apply(this, args)
}

// A: gray-matter's own opener + language detection resolves the javascript engine.
// Uses gray-matter's own helpers (language(), engine lookup), independent of any
// predicate under test. Mirrors index.js: BOM strip, opener at offset 0, the
// "next char is a delimiter char" guard, then language -> engine.
function measureA(input) {
  const opts = defaults({})
  const open = opts.delimiters[0]
  const s = stripBom(input)
  if (!s.startsWith(open)) return false
  if (s.charAt(open.length) === open.slice(-1)) return false
  const { name } = matter.language(s.slice(open.length), opts)
  if (!name) return false
  try {
    return getEngine(name, opts) === engines.javascript
  } catch {
    return false // engine "<name>" is not registered
  }
}

function measureEval(input) {
  evaluated = false
  matter.clearCache() // matter(str) caches by content; a cache hit would skip the eval
  try {
    matter(input) // exactly the old CLI call: matter(content), no options
  } catch {
    // a throw (unregistered engine, ReferenceError, SyntaxError) is a recorded outcome, not a failure
  }
  return evaluated
}

// ---------------------------------------------------------------------------
// Case table (plan rounds 1 and 2). Each row: [input, expected A, expected eval].
// Expected values are the plan's table; the generator refuses on any mismatch
// with what the real gray-matter measures.
// ---------------------------------------------------------------------------
const BODY = '\n{"name":"fmt"}\n---\n# Fmt\n' // valid JS, JSON and YAML flow mapping
const withBody = (opener) => opener + BODY
const rows = []
const add = (input, a, ev) => rows.push([input, a, ev])
const addAll = (openers, a, ev) => openers.forEach((o) => add(withBody(o), a, ev))

// Round 1: the javascript engine runs.
addAll(['---js', '---javascript', '--- js', '---  js  ', '---\tjs'], true, true)
addAll(['---JS', '---JavaScript'], true, true)
add('---js\r\n{"name":"fmt"}\r\n---\r\n# Fmt\r\n', true, true) // CRLF
add(withBody('﻿---js'), true, true) // one BOM
// Unicode whitespace that String.prototype.trim strips
addAll(['--- js', '---js ', '---　js', '---﻿js'], true, true)
// Round 2
addAll(['---\fjs', '---js\f', '---\vjs', '---js\v'], true, true)
addAll(['--- js', '---js ', '--- js', '---js ', '--- js', '---js '], true, true)
// No newline: slice(0,-1) drops the last char, so the opener line's tail is evaluated
for (const input of ['---jsX', '---javascriptX', '--- javascriptX', '---JSX'])
  add(input, true, true)
add('---js\n// comment\n---\n# Fmt\n', true, true)
add('---javascript\n// comment\n---\n# Fmt\n', true, true)
add('---js\n/* block */\n---\n# Fmt\n', true, true)
// Resolves the engine but never evaluates: deliberate superset
add('---js\n# comment\n---\n# Fmt\n', true, false)
add('---js\n---\n# Fmt\n', true, false)

// Not the javascript engine.
for (const input of ['', '-', '--', '---', '---\n']) add(input, false, false)
add(withBody('﻿﻿---js'), false, false) // two BOMs
add(withBody('﻿ ---js'), false, false) // BOM + space
add(withBody('\n---js'), false, false) // leading blank line
add(withBody(' ---js'), false, false) // leading space
addAll(['---\u0000js', '---js\u0000'], false, false) // NUL is not trimmed
add(withBody('---​js'), false, false) // ZWSP
addAll(['----js', '----javascript', '-----js', '------javascript'], false, false)
add('----', false, false)
add('---js', false, false) // no newline at EOF: language is "j"
add('---javascript', false, false) // no newline at EOF: language is "javascrip"
add(withBody('---js;payload'), false, false)
add('---javascript\r{"name":"fmt"}\r---\r# Fmt\r', false, false) // CR-only file
addAll(['---json', '---yaml', '---yml'], false, false)
addAll(['---toml', '---coffee'], false, false)
add(withBody('---constructor'), false, false) // resolves Object, a prototype key
add(withBody('---'), false, false) // plain YAML
add('---\nname: fmt\n---\n# Fmt\n\n---js\n', false, false) // ---js only later in the body

// ---------------------------------------------------------------------------
// Measure, compare to the plan, then write.
// ---------------------------------------------------------------------------
const seen = new Set()
const cases = []
const problems = []
for (const [input, expectA, expectEval] of rows) {
  if (seen.has(input)) problems.push(`duplicate input ${JSON.stringify(input)}`)
  seen.add(input)
  const A = measureA(input)
  const ev = measureEval(input)
  if (A !== expectA) problems.push(`A ${JSON.stringify(input)}: plan ${expectA}, measured ${A}`)
  if (ev !== expectEval) {
    problems.push(`eval ${JSON.stringify(input)}: plan ${expectEval}, measured ${ev}`)
  }
  if (ev && !A) problems.push(`eval without A: ${JSON.stringify(input)}`)
  cases.push({ input, A, eval: ev })
}
if (problems.length > 0) fail(`case table disagrees with gray-matter:\n  ${problems.join('\n  ')}`)

const fixture = {
  header: {
    fixture: 'gray-matter-4.0.3.cases',
    grayMatter: { version: lockGm.version, integrity: lockGm.integrity },
    jsYaml: { version: lockYaml.version },
    columns: {
      input: 'SKILL.md text fed to gray-matter',
      A: "gray-matter's own opener and language detection resolves its javascript engine",
      eval: "the real javascript engine's parse() was invoked",
    },
  },
  cases,
}

// Fixed serialisation: JSON.stringify(obj, null, 2) plus a trailing newline, then a lossless
// post-pass escaping DEL and everything non-ASCII as \uXXXX (JSON.stringify already escapes
// control characters below 0x20), so invisible characters are explicit in diffs and the file is
// pure ASCII. JSON.parse returns identical data.
const text = (JSON.stringify(fixture, null, 2) + '\n').replace(
  /[\u007f-\uffff]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
)
writeFileSync(OUT, text)
console.log(`wrote ${cases.length} cases to ${OUT}`)
