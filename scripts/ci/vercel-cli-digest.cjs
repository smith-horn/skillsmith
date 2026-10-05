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
 *   U <key> <name> unresolved-optional absent
 *                              an optional (or optional-peer) dependency edge of
 *                              closure package <key> that the lockfile does not
 *                              resolve (node-fetch's `encoding`, ...). The CLI
 *                              still try-requires such names, so a package on
 *                              any of Node's lookup paths for it would load
 *                              unhashed. Every candidate is checked first:
 *                              <ws>/<key>/node_modules/<name>, then each
 *                              ancestor directory's node_modules/<name>, through
 *                              the workspace root and on above it up to `/`.
 *                              One on disk is refused by path; the line records
 *                              that none was.
 * The digest is sha256 over those lines. Refused (exit 1): a symlink anywhere
 * inside a hashed package (outside P/node_modules), a closure package that is a
 * symlink or a workspace link, a required package missing from the lockfile or
 * the disk, a non-regular file, a path holding a newline, an empty closure, and
 * an unresolved optional edge with something on one of its lookup paths.
 *
 * NOT IN SCOPE (stated, not hidden): the `node` binary that runs the CLI, the
 * environment (NODE_OPTIONS, PATH), files outside the closure the CLI reads at
 * runtime (.vercel/, vercel.json, ~/.local/share/com.vercel.cli), and the
 * `.bin` link farms inside P/node_modules (named, not followed), and NODE_PATH or
 * Node's global folders ($HOME/.node_modules, $HOME/.node_libraries,
 * $PREFIX/lib/node) as lookup paths for an unresolved optional edge.
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

/**
 * Node's lookup candidates for `name` required from directory `absDir`: every
 * directory from absDir up to `/` that is not itself named node_modules, joined
 * with node_modules/<name>.
 */
function lookupCandidates(absDir, name) {
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

/**
 * One `U` line per unresolved optional edge, after proving that nothing sits on
 * any lookup path for it. Refuses, naming the path, when something does.
 */
function unresolvedLines(ws, skipped) {
  const lines = []
  for (const { key, name } of skipped) {
    for (const cand of lookupCandidates(path.join(ws, key), name)) {
      if (presentOnDisk(cand))
        refuse(
          'digest-unresolved',
          `${key} optionally requires "${name}", which the lockfile does not resolve, but ${cand} exists and Node would load it unhashed`
        )
    }
    lines.push(`U ${key} ${name} unresolved-optional absent`)
  }
  return lines.sort()
}

function closure(pkgs) {
  const start = 'node_modules/vercel'
  if (!has(pkgs, start)) refuse('lockfile-closure', `package-lock.json has no "${start}"`)
  const seen = new Set([start])
  const queue = [start]
  const skipped = []
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
        if (!seen.has(dep)) {
          seen.add(dep)
          queue.push(dep)
        }
      }
    }
  }
  return { keys: [...seen].sort(), skipped }
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
  const { keys, skipped } = closure(pkgs)
  const lines = []
  const counts = { files: 0, packages: 0 }
  for (const key of keys) {
    let st
    try {
      st = fs.lstatSync(path.join(ws, key))
    } catch {
      if (pkgs[key].optional) {
        lines.push(`S ${key} absent-optional`)
        continue
      }
      refuse('digest-missing', `${key} is in the CLI closure but not on disk`)
    }
    if (st.isSymbolicLink())
      refuse('digest-symlink', `${key} is a symlink; the lockfile install is a real directory`)
    if (!st.isDirectory()) refuse('digest-filetype', `${key} is not a directory`)
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
