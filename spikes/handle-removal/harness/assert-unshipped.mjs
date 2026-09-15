#!/usr/bin/env node
// SMI-6676 no-ship guard.
//
// Fails (exit 2) if the handle-removal spike has leaked into shipped code.
// Deliberately spike-local -- not a CI check or hook (that would be an
// ADR-109 infra change). Run before every harness invocation.
// See docs/internal/implementation/smi-6676-handle-relative-removal-spike.md §7.
//
// Self-test: `node assert-unshipped.mjs --self-test` builds a throwaway fixture
// repo shape under a temp dir, plants a violation of each kind, and asserts
// this script exits 2 against it (and 0 against the clean fixture).

import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPIKE_PATH_TOKEN = 'spikes/handle-removal'
const SPIKE_PKG_TOKEN = '@skillsmith-spike/handle-removal'
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function resolveDefaultRoot() {
  // spikes/handle-removal/harness/assert-unshipped.mjs -> repo root is three
  // levels up.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

function gitLsFiles(root, pathspec) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--', pathspec], {
      encoding: 'utf8',
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function gitGrepFiles(root, tokens, pathspecs) {
  const args = ['-C', root, 'grep', '-l']
  for (const t of tokens) {
    args.push('-e', t)
  }
  args.push('--', ...pathspecs)
  try {
    const out = execFileSync('git', args, { encoding: 'utf8' })
    return out.split('\n').filter(Boolean)
  } catch (err) {
    // git grep exits 1 when nothing matches -- that is success, not an error.
    if (err.status === 1) return []
    throw err
  }
}

/**
 * Runs all four §7 checks against `root`. Returns { failures, scannedFiles }.
 */
export function checkUnshipped(root) {
  const failures = []

  // Check 1: root package.json workspaces globs spikes/
  const rootPkgPath = path.join(root, 'package.json')
  if (existsSync(rootPkgPath)) {
    let rootPkg
    try {
      rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
    } catch (err) {
      failures.push(`root package.json is not valid JSON: ${err.message}`)
      rootPkg = {}
    }
    const workspaces = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : (rootPkg.workspaces?.packages ?? [])
    for (const glob of workspaces) {
      if (typeof glob === 'string' && glob.includes('spikes')) {
        failures.push(`root package.json "workspaces" entry "${glob}" matches spikes/`)
      }
    }
  }

  // Check 2: packages/ or apps/ referencing the spike path or package name.
  // The denominator is every tracked file under either directory, whether or
  // not the directory itself exists.
  const scannedFiles = new Set([...gitLsFiles(root, 'packages'), ...gitLsFiles(root, 'apps')]).size
  const grepHits = gitGrepFiles(root, [SPIKE_PATH_TOKEN, SPIKE_PKG_TOKEN], ['packages', 'apps'])
  if (grepHits.length > 0) {
    failures.push(
      `${grepHits.length} file(s) under packages/ or apps/ reference the spike ` +
        `(scanned ${scannedFiles} tracked files):\n  ${grepHits.join('\n  ')}`
    )
  }

  // Check 3: packages/*/package.json naming the spike package as a dependency.
  const pkgFiles = gitLsFiles(root, 'packages/*/package.json')
  for (const rel of pkgFiles) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(abs, 'utf8'))
    } catch {
      continue
    }
    for (const field of DEP_FIELDS) {
      if (pkg[field] && Object.prototype.hasOwnProperty.call(pkg[field], SPIKE_PKG_TOKEN)) {
        failures.push(`${rel} declares "${SPIKE_PKG_TOKEN}" in ${field}`)
      }
    }
  }

  // Check 4: tsconfig*.json under packages/ referencing spikes/.
  const tsconfigFiles = gitLsFiles(root, 'packages/**/tsconfig*.json')
  for (const rel of tsconfigFiles) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) continue
    const content = readFileSync(abs, 'utf8')
    if (content.includes('spikes/')) {
      failures.push(`${rel} references spikes/`)
    }
  }

  return { failures, scannedFiles }
}

function runCheck(root) {
  const { failures, scannedFiles } = checkUnshipped(root)
  if (failures.length > 0) {
    console.error('[assert-unshipped] FAIL: the spike has leaked into shipped code')
    console.error('')
    console.error(failures.join('\n\n'))
    process.exit(2)
  }
  console.log(
    `[assert-unshipped] OK -- no spike references found under packages/ or apps/ ` +
      `(scanned ${scannedFiles} tracked files, root=${root})`
  )
  process.exit(0)
}

// --- Self-test -------------------------------------------------------------
//
// Builds a minimal fixture repo shape (its own git repo, so git ls-files/grep
// work) in a throwaway temp dir, and checks this module's exit behavior
// against both a clean copy and one planted violation per check kind.

function buildFixtureRepo(dir) {
  mkdirSync(path.join(dir, 'packages', 'demo', 'src'), { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] }, null, 2)
  )
  writeFileSync(
    path.join(dir, 'packages', 'demo', 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: {} }, null, 2)
  )
  writeFileSync(
    path.join(dir, 'packages', 'demo', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: {} }, null, 2)
  )
  writeFileSync(path.join(dir, 'packages', 'demo', 'src', 'index.ts'), 'export const demo = 1;\n')
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'spike@example.invalid'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'spike'])
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture'])
}

function gitCommitAll(dir, message) {
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message])
}

function assertExit(label, root, expected) {
  const result = checkUnshipped(root)
  const actual = result.failures.length > 0 ? 2 : 0
  const ok = actual === expected
  console.log(
    `[self-test] ${label}: expected exit ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`
  )
  if (!ok) {
    console.log(`  failures: ${JSON.stringify(result.failures, null, 2)}`)
  }
  return ok
}

function selfTest() {
  const base = mkdtempSync(path.join(tmpdir(), 'smi6676-noship-'))
  let allOk = true
  try {
    // Case 0: clean fixture -> exit 0.
    const cleanDir = path.join(base, 'clean')
    mkdirSync(cleanDir)
    buildFixtureRepo(cleanDir)
    allOk = assertExit('clean fixture', cleanDir, 0) && allOk

    // Case 1: workspaces glob matches spikes/.
    const wsDir = path.join(base, 'workspaces')
    mkdirSync(wsDir)
    buildFixtureRepo(wsDir)
    writeFileSync(
      path.join(wsDir, 'package.json'),
      JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*', 'spikes/*'] }, null, 2)
    )
    gitCommitAll(wsDir, 'plant workspaces violation')
    allOk = assertExit('workspaces glob plant', wsDir, 2) && allOk

    // Case 2: a packages/ file references the spike path token.
    const grepDir = path.join(base, 'grep')
    mkdirSync(grepDir)
    buildFixtureRepo(grepDir)
    writeFileSync(
      path.join(grepDir, 'packages', 'demo', 'src', 'index.ts'),
      "import x from '../../../spikes/handle-removal/walk.mjs';\n"
    )
    gitCommitAll(grepDir, 'plant grep violation')
    allOk = assertExit('git grep plant', grepDir, 2) && allOk

    // Case 3: a packages/*/package.json depends on the spike package.
    const depDir = path.join(base, 'deps')
    mkdirSync(depDir)
    buildFixtureRepo(depDir)
    writeFileSync(
      path.join(depDir, 'packages', 'demo', 'package.json'),
      JSON.stringify(
        { name: 'demo', dependencies: { '@skillsmith-spike/handle-removal': '0.0.0' } },
        null,
        2
      )
    )
    gitCommitAll(depDir, 'plant dependency violation')
    allOk = assertExit('dependency field plant', depDir, 2) && allOk

    // Case 4: a tsconfig references spikes/.
    const tsDir = path.join(base, 'tsconfig')
    mkdirSync(tsDir)
    buildFixtureRepo(tsDir)
    writeFileSync(
      path.join(tsDir, 'packages', 'demo', 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@spike/*': ['../../spikes/*'] } } }, null, 2)
    )
    gitCommitAll(tsDir, 'plant tsconfig violation')
    allOk = assertExit('tsconfig plant', tsDir, 2) && allOk
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  if (!allOk) {
    console.error('[self-test] FAIL -- one or more cases did not match')
    process.exit(1)
  }
  console.log('[self-test] all cases passed')
  process.exit(0)
}

// --- Entry -------------------------------------------------------------

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) {
  selfTest()
} else {
  const rootFlagIdx = argv.indexOf('--root')
  const root =
    rootFlagIdx !== -1 && argv[rootFlagIdx + 1]
      ? path.resolve(argv[rootFlagIdx + 1])
      : resolveDefaultRoot()
  runCheck(root)
}
