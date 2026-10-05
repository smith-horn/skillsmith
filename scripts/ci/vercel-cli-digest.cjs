#!/usr/bin/env node
'use strict'
/**
 * SMI-6944 - deterministic content digest of the Vercel CLI's installed runtime
 * closure, for scripts/ci/use-lockfile-vercel.sh. Pure Node, no dependencies.
 *
 * SCOPE. The CLI is `node_modules/vercel` plus every package it can `require`:
 * its runtime dependency closure, computed from package-lock.json (dependencies,
 * optionalDependencies and peerDependencies, resolved with Node's node_modules
 * lookup: the package's own nested `node_modules`, then each ancestor's, then
 * the root). `vercel/dist` keeps `@vercel/*` builders, `smol-toml`, `esbuild`
 * and the rest external, so a tree limited to `node_modules/vercel` would let a
 * rewrite of a hoisted `node_modules/@vercel/build-utils` file pass unseen.
 *
 * WHAT IS HASHED, per closure package P (sorted by lockfile key):
 *   P <key> <lockfile version>
 *   F <path> <size> <sha256>   every file under P, recursively, EXCEPT the
 *                              subtree P/node_modules. That subtree is not
 *                              skipped silently: each nested closure member is
 *                              hashed as its own P, and
 *   N <path> <type>            names every entry directly in P/node_modules
 *                              (one level into an @scope dir), so a package
 *                              added there, which would shadow a hoisted copy
 *                              under Node's lookup, changes the digest.
 *   S <key> absent-optional    a lockfile-optional package not on disk (a
 *                              platform binary for another OS), listed by name.
 *                              It gets the same lookup-path check as a U edge
 *                              (below), from the directory that owns its key.
 *   U <key> <name> unresolved-optional absent
 *                              an optional (or optional-peer) dependency edge of
 *                              closure package <key> that the lockfile does not
 *                              resolve (node-fetch's `encoding`, ...). The CLI
 *                              still try-requires such names, so something on
 *                              one of Node's lookup paths for it would load
 *                              unhashed.
 *
 * LOOKUP CHECK (U and S). The lookup directories are <ws>/<key> (for S, the
 * directory owning the key), then each ancestor directory through the workspace
 * root and on above it up to `/`, skipping any directory named node_modules.
 * In each, these are checked with lstat: node_modules/<name>,
 * node_modules/<name>.js, node_modules/<name>.json and node_modules/<name>.node
 * (a scoped name keeps its directory; the suffix goes on its last segment).
 * Whatever exists there, a regular file, a directory, a symlink or a dangling
 * symlink, is refused by path; the line records that none was. NOT checked:
 * NODE_PATH, Node's global folders, package.json `exports` or `imports`
 * subpaths, and the `.mjs`/`.cjs` forms an ESM `import` would try.
 *
 * SHADOW CHECK (installed closure packages). The same lstat check is applied to
 * every installed closure package K, for K itself and for each closure package
 * that requires it (R). Starting from R's directory, and from K's own owning
 * directory, it covers what would WIN Node's resolution of K: at every
 * node_modules level nearer than K's own, the bare entry and the `.js`, `.json`
 * and `.node` forms; at K's own level, the `.js`, `.json` and `.node` forms
 * (Node loads a file form before the directory). Levels farther away than K's
 * own are not checked, because Node never reaches them. A present one is
 * refused by path. Anything inside a closure package's own node_modules is also
 * named by the N lines; this check is what covers the workspace root's
 * node_modules and the `@scope/node_modules` levels, which no N line names.
 * The digest is sha256 over those lines. Refused (exit 1): a symlink anywhere
 * inside a hashed package (outside P/node_modules), a closure package that is a
 * symlink or a workspace link, a required package missing from the lockfile or
 * the disk, a non-regular file, a path holding a newline, an empty closure, and
 * an unresolved optional edge or an absent-optional package with something on one
 * of its lookup paths.
 *
 * NOT IN SCOPE (stated, not hidden): the `node` binary that runs the CLI, the
 * environment (NODE_OPTIONS, PATH), files outside the closure the CLI reads at
 * runtime (.vercel/, vercel.json, ~/.local/share/com.vercel.cli), and the
 * `.bin` link farms inside P/node_modules (named, not followed), and NODE_PATH or
 * Node's global folders ($HOME/.node_modules, $HOME/.node_libraries,
 * $PREFIX/lib/node) or package `exports` subpaths as lookup paths for an
 * unresolved optional edge or an absent-optional package.
 *
 * Usage: node vercel-cli-digest.cjs <workspace> [--manifest-out F] [--diff-against F]
 *   stdout: sha256:<64 hex> files=<n> packages=<m> unresolved=<u>
 *   --manifest-out F  also writes the hashed lines to F
 *   --diff-against F  prints up to 10 lines that differ from manifest F to
 *                     stderr (diagnostic only; F is never trusted for a verdict)
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function refuse(check, detail) {
  process.stderr.write(`${check}: ${detail}\n`)
  process.exit(1)
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** Node's lookup over lockfile keys: own nested node_modules, each ancestor's, root. */
function resolveKey(pkgs, fromKey, name) {
  let base = fromKey
  for (;;) {
    const cand = (base ? base + '/' : '') + 'node_modules/' + name
    if (has(pkgs, cand)) return cand
    if (!base) return null
    const at = base.lastIndexOf('/node_modules/')
    base = at < 0 ? '' : base.slice(0, at)
  }
}

/** The entries Node's file resolution tries for a bare `<name>` request. */
const FILE_SUFFIXES = ['', '.js', '.json', '.node']

/**
 * Node's lookup candidates for `name` required from directory `absDir`: every
 * directory from absDir up to `/` that is not itself named node_modules, joined
 * with node_modules/<name>, and for each of those the bare entry plus the
 * `.js`, `.json` and `.node` file forms (`require('x')` loads `x.js` before it
 * looks at a directory `x`). A scoped name keeps its directory and the suffix
 * goes on its last segment.
 */
function lookupCandidates(absDir, name) {
  return lookupLevels(absDir, name).flatMap((base) => FILE_SUFFIXES.map((s) => base + s))
}

/** The bare path Node tries at each level of its lookup for `name` from `absDir`, nearest first. */
function lookupLevels(absDir, name) {
  const out = []
  let dir = absDir
  for (;;) {
    if (path.basename(dir) !== 'node_modules') out.push(path.join(dir, 'node_modules', name))
    const up = path.dirname(dir)
    if (up === dir) return out
    dir = up
  }
}

/** True when `abs` exists (any type, a dangling symlink included). Fails closed. */
function presentOnDisk(abs) {
  try {
    fs.lstatSync(abs)
    return true
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false
    return refuse('digest-unresolved', `cannot tell whether ${abs} exists: ${e.code || e.message}`)
  }
}

/** Refuses, naming the path, when any of `cands` exists. */
function refuseIfAny(cands, why) {
  for (const cand of cands) {
    if (presentOnDisk(cand))
      refuse('digest-unresolved', `${why}, but ${cand} exists and Node would load it unhashed`)
  }
}

/** Refuses, naming the path, when anything sits on a lookup path for `name` from `fromKey`. */
function refuseIfShadowed(ws, fromKey, name, why) {
  refuseIfAny(lookupCandidates(path.join(ws, fromKey), name), why)
}

/**
 * The entries that would WIN Node's resolution of closure package `key` when it is
 * required from `fromKey` ('' is the workspace root): everything at a level nearer
 * than the package's own, and at its own level the file forms, which Node tries
 * before the directory. Levels past the package's own never win.
 */
function winningCandidates(ws, fromKey, key) {
  const marker = 'node_modules/'
  const name = key.slice(key.lastIndexOf(marker) + marker.length)
  const real = path.join(ws, key)
  const out = []
  for (const base of lookupLevels(path.join(ws, fromKey), name)) {
    if (base === real) return out.concat(FILE_SUFFIXES.slice(1).map((s) => base + s))
    out.push(...FILE_SUFFIXES.map((s) => base + s))
  }
  return refuse('digest-unresolved', `${key} is not on the lookup path from ${fromKey || '.'}`)
}

/** Proves nothing shadows installed closure package `key` for it or any package that requires it. */
function assertNotShadowed(ws, key, requirers) {
  const marker = 'node_modules/'
  const at = key.lastIndexOf(marker)
  const owner = at > 0 ? key.slice(0, at - 1) : ''
  for (const from of new Set([owner, ...requirers])) {
    refuseIfAny(
      winningCandidates(ws, from, key),
      `${key} is in the CLI closure and something is placed ahead of it on Node's lookup path`
    )
  }
}

/**
 * One `U` line per unresolved optional edge, after proving that nothing sits on
 * any lookup path for it. Refuses, naming the path, when something does.
 */
function unresolvedLines(ws, skipped) {
  const lines = []
  for (const { key, name } of skipped) {
    refuseIfShadowed(
      ws,
      key,
      name,
      `${key} optionally requires "${name}", which the lockfile does not resolve`
    )
    lines.push(`U ${key} ${name} unresolved-optional absent`)
  }
  return lines.sort()
}

/** The same proof for a lockfile-optional package that is not installed (an `S` line). */
function assertAbsentOptional(ws, key) {
  const marker = 'node_modules/'
  const at = key.lastIndexOf(marker)
  const name = key.slice(at + marker.length)
  const owner = at > 0 ? key.slice(0, at - 1) : ''
  refuseIfShadowed(
    ws,
    owner,
    name,
    `${key} is optional and recorded absent, but it is on disk in a form the lockfile install did not write`
  )
}

function closure(pkgs) {
  const start = 'node_modules/vercel'
  if (!has(pkgs, start)) refuse('lockfile-closure', `package-lock.json has no "${start}"`)
  const seen = new Set([start])
  const queue = [start]
  const skipped = []
  const requirers = new Map()
  while (queue.length) {
    const key = queue.shift()
    const e = pkgs[key]
    const peerMeta = e.peerDependenciesMeta || {}
    const groups = [
      [e.dependencies, false],
      [e.optionalDependencies, true],
      [e.peerDependencies, null],
    ]
    for (const [deps, optional] of groups) {
      for (const name of Object.keys(deps || {})) {
        const dep = resolveKey(pkgs, key, name)
        if (!dep) {
          const opt = optional === true || (optional === null && peerMeta[name]?.optional)
          if (opt || (e.optionalDependencies && has(e.optionalDependencies, name))) {
            skipped.push({ key, name })
            continue
          }
          refuse(
            'lockfile-closure',
            `${key} requires "${name}", which the lockfile does not resolve`
          )
        }
        if (pkgs[dep].link)
          refuse('lockfile-closure', `${dep} is a workspace link, outside the CLI tree`)
        if (!requirers.has(dep)) requirers.set(dep, new Set())
        requirers.get(dep).add(key)
        if (!seen.has(dep)) {
          seen.add(dep)
          queue.push(dep)
        }
      }
    }
  }
  return { keys: [...seen].sort(), skipped, requirers }
}

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

function checkName(rel) {
  if (/[\n\r]/.test(rel)) refuse('digest-path', `a path holds a newline: ${JSON.stringify(rel)}`)
}

/** Lines for one package directory. `rel` is workspace-relative, '/'-separated. */
function hashPackage(ws, key, out, counts) {
  const files = []
  const names = []
  const walk = (rel, top) => {
    const entries = fs.readdirSync(path.join(ws, rel)).sort()
    for (const name of entries) {
      const r = rel + '/' + name
      checkName(r)
      if (top && name === 'node_modules') {
        listNested(r)
        continue
      }
      const st = fs.lstatSync(path.join(ws, r))
      if (st.isSymbolicLink()) refuse('digest-symlink', `${r} is a symlink inside the CLI tree`)
      if (st.isDirectory()) walk(r, false)
      else if (st.isFile()) files.push(`F ${r} ${st.size} ${sha256File(path.join(ws, r))}`)
      else refuse('digest-filetype', `${r} is not a regular file or directory`)
    }
  }
  const listNested = (nm) => {
    const st = fs.lstatSync(path.join(ws, nm))
    if (st.isSymbolicLink() || !st.isDirectory())
      refuse('digest-symlink', `${nm} is not a real directory`)
    for (const name of fs.readdirSync(path.join(ws, nm)).sort()) {
      const r = nm + '/' + name
      checkName(r)
      const s = fs.lstatSync(path.join(ws, r))
      const type = s.isSymbolicLink() ? 'l' : s.isDirectory() ? 'd' : 'f'
      names.push(`N ${r} ${type}`)
      if (name.startsWith('@') && type === 'd') {
        for (const sub of fs.readdirSync(path.join(ws, r)).sort()) {
          checkName(r + '/' + sub)
          const ss = fs.lstatSync(path.join(ws, r, sub))
          names.push(`N ${r}/${sub} ${ss.isSymbolicLink() ? 'l' : ss.isDirectory() ? 'd' : 'f'}`)
        }
      }
    }
  }
  walk(key, true)
  counts.files += files.length
  out.push(...names, ...files)
}

function main(argv) {
  const ws = argv[0]
  if (!ws || !path.isAbsolute(ws))
    refuse('usage', 'first argument must be the absolute workspace path')
  let manifestOut = ''
  let diffAgainst = ''
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] === '--manifest-out' && argv[i + 1]) manifestOut = argv[i + 1]
    else if (argv[i] === '--diff-against' && argv[i + 1]) diffAgainst = argv[i + 1]
    else refuse('usage', `unknown argument '${argv[i]}'`)
  }
  let pkgs
  try {
    pkgs = JSON.parse(fs.readFileSync(path.join(ws, 'package-lock.json'), 'utf8')).packages
  } catch (e) {
    refuse('lockfile-closure', `cannot read package-lock.json: ${e.message}`)
  }
  if (!pkgs)
    refuse('lockfile-closure', 'package-lock.json has no "packages" map (lockfileVersion >= 2)')
  const { keys, skipped, requirers } = closure(pkgs)
  const lines = []
  const counts = { files: 0, packages: 0 }
  for (const key of keys) {
    let st
    try {
      st = fs.lstatSync(path.join(ws, key))
    } catch {
      if (pkgs[key].optional) {
        assertAbsentOptional(ws, key)
        lines.push(`S ${key} absent-optional`)
        continue
      }
      refuse('digest-missing', `${key} is in the CLI closure but not on disk`)
    }
    if (st.isSymbolicLink())
      refuse('digest-symlink', `${key} is a symlink; the lockfile install is a real directory`)
    if (!st.isDirectory()) refuse('digest-filetype', `${key} is not a directory`)
    assertNotShadowed(ws, key, requirers.get(key) || [])
    lines.push(`P ${key} ${pkgs[key].version || ''}`)
    counts.packages++
    hashPackage(ws, key, lines, counts)
  }
  if (counts.files === 0) refuse('digest-empty', 'the CLI closure holds no files')
  const unresolved = unresolvedLines(ws, skipped)
  lines.push(...unresolved)
  const manifest = lines.join('\n') + '\n'
  const digest = 'sha256:' + crypto.createHash('sha256').update(manifest).digest('hex')
  if (manifestOut) fs.writeFileSync(manifestOut, manifest)
  if (diffAgainst) {
    let old = []
    try {
      old = fs.readFileSync(diffAgainst, 'utf8').split('\n')
    } catch {
      process.stderr.write(`diagnostic: no manifest at ${diffAgainst}\n`)
    }
    const a = new Set(old)
    const b = new Set(lines)
    const diff = [
      ...old.filter((l) => l && !b.has(l)).map((l) => `- ${l}`),
      ...lines.filter((l) => !a.has(l)).map((l) => `+ ${l}`),
    ]
    for (const d of diff.slice(0, 10))
      process.stderr.write(`diagnostic (untrusted manifest): ${d}\n`)
  }
  process.stdout.write(
    `${digest} files=${counts.files} packages=${counts.packages} unresolved=${unresolved.length}\n`
  )
}

main(process.argv.slice(2))
