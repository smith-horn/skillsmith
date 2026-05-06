#!/usr/bin/env node
/**
 * SMI-4716: WASM tree-sitter env snapshot + diff harness
 *
 * Two modes:
 *   node scripts/diagnostics/wasm-env-snapshot.mjs --emit            # print JSON snapshot to stdout
 *   node scripts/diagnostics/wasm-env-snapshot.mjs --diff a.json b.json  # diff two snapshots
 *
 * The --emit snapshot captures:
 *   - Node version, process.versions.modules, platform, arch
 *   - Relevant env keys (IS_DOCKER, NODE_ENV, SKILLSMITH_* — values filtered to safe-to-print)
 *   - tree-sitter-python.wasm artifact: size + sha256
 *   - web-tree-sitter runtime: tree-sitter.wasm size + sha256, tree-sitter.js size + sha256
 *   - vitest pool config read from active vitest.config.colocated.ts
 *   - Native binding presence: better-sqlite3 .node path + size
 *
 * Exit codes:
 *   --emit:  0 on success, 1 on fatal error
 *   --diff:  0 snapshots match (no divergence), 1 divergence found, 2 usage error
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Worktree/repo root: two levels up from scripts/diagnostics/
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  if (!existsSync(filePath)) return null
  const hash = createHash('sha256')
  const buf = readFileSync(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

function artifactInfo(filePath) {
  if (!existsSync(filePath)) return { present: false, size: null, sha256: null }
  const stat = statSync(filePath)
  return {
    present: true,
    size: stat.size,
    sha256: sha256File(filePath),
  }
}

/** Resolve candidate paths for tree-sitter-python.wasm, mirroring resolvePythonWasmPath() */
function resolvePythonWasm() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-python.wasm'),
    path.join(
      REPO_ROOT,
      'packages',
      'core',
      'node_modules',
      'tree-sitter-wasms',
      'out',
      'tree-sitter-python.wasm'
    ),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Find the web-tree-sitter package root. */
function resolveWebTreeSitter() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'web-tree-sitter'),
    path.join(REPO_ROOT, 'packages', 'core', 'node_modules', 'web-tree-sitter'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Find native better-sqlite3 .node binding. */
function resolveBetterSqlite3Node() {
  const candidates = [
    path.join(
      REPO_ROOT,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    ),
    path.join(
      REPO_ROOT,
      'packages',
      'core',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    ),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Extract the pool config from vitest.config.colocated.ts by text-scanning
 * the file for pool/poolOptions settings.  We do NOT import the TS file —
 * this script must be zero-dependency runnable without ts-node/tsx.
 *
 * Returns an object summarising the relevant fields (or defaults when absent).
 */
function extractVitestPoolConfig() {
  const configPath = path.join(REPO_ROOT, 'vitest.config.colocated.ts')
  if (!existsSync(configPath)) return { configFile: null, pool: null, poolOptions: null }

  const src = readFileSync(configPath, 'utf8')

  // Look for explicit pool: '...' or pool: "..."
  const poolMatch = src.match(/\bpool\s*:\s*['"]([^'"]+)['"]/)
  const pool = poolMatch ? poolMatch[1] : 'threads' // vitest default

  // Look for poolOptions block (simplified — just capture presence)
  const hasPoolOptions = /\bpoolOptions\s*:/.test(src)

  // Look for forks/singleFork/minForks/maxForks
  const forkMatch = src.match(/\bsingleFork\s*:\s*(true|false)/)
  const singleFork = forkMatch ? forkMatch[1] === 'true' : null

  // Look for --no-file-parallelism equivalent (fileParallelism: false)
  const fileParallelismMatch = src.match(/\bfileParallelism\s*:\s*(true|false)/)
  const fileParallelism = fileParallelismMatch ? fileParallelismMatch[1] === 'true' : null

  // Look for maxWorkers / minWorkers
  const maxWorkersMatch = src.match(/\bmaxWorkers\s*:\s*(\d+)/)
  const minWorkersMatch = src.match(/\bminWorkers\s*:\s*(\d+)/)

  return {
    configFile: path.relative(REPO_ROOT, configPath),
    pool,
    hasPoolOptions,
    singleFork,
    fileParallelism,
    maxWorkers: maxWorkersMatch ? parseInt(maxWorkersMatch[1], 10) : null,
    minWorkers: minWorkersMatch ? parseInt(minWorkersMatch[1], 10) : null,
  }
}

/** Collect safe-to-print env keys. Strips values that look like secrets. */
function collectSafeEnv() {
  const safeKeys = ['IS_DOCKER', 'NODE_ENV', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ARCH']
  const skillsmithKeys = Object.keys(process.env).filter(
    (k) =>
      k.startsWith('SKILLSMITH_') &&
      // Do not capture keys whose value looks like a secret token/key
      !/KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|HASH|SALT/i.test(k)
  )

  const result = {}
  for (const k of [...safeKeys, ...skillsmithKeys]) {
    result[k] = process.env[k] ?? '<unset>'
  }
  return result
}

// ---------------------------------------------------------------------------
// --emit mode
// ---------------------------------------------------------------------------

function emitSnapshot() {
  const pythonWasmPath = resolvePythonWasm()
  const webTsRoot = resolveWebTreeSitter()
  const sqlite3Node = resolveBetterSqlite3Node()

  const snapshot = {
    captured_at: new Date().toISOString(),
    node: {
      version: process.version,
      modules_abi: process.versions.modules,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
    },
    env: collectSafeEnv(),
    artifacts: {
      'tree-sitter-python.wasm': pythonWasmPath
        ? {
            path: path.relative(REPO_ROOT, pythonWasmPath),
            ...artifactInfo(pythonWasmPath),
          }
        : { present: false, path: null, size: null, sha256: null },
      'web-tree-sitter/tree-sitter.wasm': webTsRoot
        ? {
            path: path.relative(REPO_ROOT, path.join(webTsRoot, 'tree-sitter.wasm')),
            ...artifactInfo(path.join(webTsRoot, 'tree-sitter.wasm')),
          }
        : { present: false, path: null, size: null, sha256: null },
      'web-tree-sitter/tree-sitter.js': webTsRoot
        ? {
            path: path.relative(REPO_ROOT, path.join(webTsRoot, 'tree-sitter.js')),
            ...artifactInfo(path.join(webTsRoot, 'tree-sitter.js')),
          }
        : { present: false, path: null, size: null, sha256: null },
      'better-sqlite3.node': sqlite3Node
        ? {
            path: path.relative(REPO_ROOT, sqlite3Node),
            present: true,
            size: statSync(sqlite3Node).size,
          }
        : { present: false, path: null, size: null },
    },
    vitest_pool: extractVitestPoolConfig(),
  }

  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n')
  return 0
}

// ---------------------------------------------------------------------------
// --diff mode
// ---------------------------------------------------------------------------

/** Recursively collect leaf paths in the form "a.b.c" -> value. */
function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key))
    } else {
      out[key] = v
    }
  }
  return out
}

function diffSnapshots(pathA, pathB) {
  if (!existsSync(pathA)) {
    process.stderr.write(`ERROR: file not found: ${pathA}\n`)
    return 2
  }
  if (!existsSync(pathB)) {
    process.stderr.write(`ERROR: file not found: ${pathB}\n`)
    return 2
  }

  let a, b
  try {
    a = JSON.parse(readFileSync(pathA, 'utf8'))
  } catch (e) {
    process.stderr.write(`ERROR: failed to parse ${pathA}: ${e.message}\n`)
    return 2
  }
  try {
    b = JSON.parse(readFileSync(pathB, 'utf8'))
  } catch (e) {
    process.stderr.write(`ERROR: failed to parse ${pathB}: ${e.message}\n`)
    return 2
  }

  const flatA = flatten(a)
  const flatB = flatten(b)

  // Exclude timestamp fields that are always different
  const SKIP = new Set(['captured_at'])

  const allKeys = new Set([...Object.keys(flatA), ...Object.keys(flatB)])
  const divergent = []
  const missing = []

  for (const key of [...allKeys].sort()) {
    if (SKIP.has(key) || key.endsWith('.captured_at')) continue

    const inA = Object.prototype.hasOwnProperty.call(flatA, key)
    const inB = Object.prototype.hasOwnProperty.call(flatB, key)

    if (inA && !inB) {
      missing.push({ key, side: 'b', value: flatA[key] })
    } else if (!inA && inB) {
      missing.push({ key, side: 'a', value: flatB[key] })
    } else if (String(flatA[key]) !== String(flatB[key])) {
      divergent.push({ key, a: flatA[key], b: flatB[key] })
    }
  }

  const labelA = path.basename(pathA)
  const labelB = path.basename(pathB)

  if (divergent.length === 0 && missing.length === 0) {
    process.stdout.write(`WASM-ENV-DIFF: snapshots MATCH — no divergent fields\n`)
    process.stdout.write(`  ${labelA}  ==  ${labelB}\n`)
    return 0
  }

  process.stdout.write(
    `WASM-ENV-DIFF: ${divergent.length} divergent field(s), ${missing.length} missing key(s)\n`
  )
  process.stdout.write(`  A: ${labelA}\n`)
  process.stdout.write(`  B: ${labelB}\n\n`)

  if (divergent.length > 0) {
    process.stdout.write(`Divergent fields:\n`)
    for (const { key, a: va, b: vb } of divergent) {
      process.stdout.write(`  ${key}\n`)
      process.stdout.write(`    A: ${JSON.stringify(va)}\n`)
      process.stdout.write(`    B: ${JSON.stringify(vb)}\n`)
    }
    process.stdout.write('\n')
  }

  if (missing.length > 0) {
    process.stdout.write(`Missing keys:\n`)
    for (const { key, side, value } of missing) {
      process.stdout.write(
        `  ${key} — only in ${side === 'a' ? labelA : labelB}: ${JSON.stringify(value)}\n`
      )
    }
    process.stdout.write('\n')
  }

  return 1
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

if (args[0] === '--emit') {
  process.exit(emitSnapshot())
} else if (args[0] === '--diff') {
  if (args.length < 3) {
    process.stderr.write('Usage: node wasm-env-snapshot.mjs --diff <host.json> <ci.json>\n')
    process.exit(2)
  }
  process.exit(diffSnapshots(args[1], args[2]))
} else {
  process.stderr.write(
    'Usage:\n' +
      '  node scripts/diagnostics/wasm-env-snapshot.mjs --emit\n' +
      '  node scripts/diagnostics/wasm-env-snapshot.mjs --diff host.json ci.json\n'
  )
  process.exit(2)
}
