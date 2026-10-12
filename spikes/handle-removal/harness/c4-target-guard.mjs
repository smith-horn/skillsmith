// SMI-6715: shared by run-c4-attacks.mjs and run-c4-mount-attacks.mjs.
//
// results/generate-summary.mjs has no notion of a cell's target, so a short
// smoke file left under results/raw/ would render as PASS. This refuses, before
// any run, a --target below a module's own target when the output resolves
// under results/raw/.
//
// "Under" is decided by file IDENTITY (dev, ino), not by comparing spellings: a
// case-variant path on a case-insensitive filesystem, a symlinked route, or the
// /tmp vs /private/tmp style alias all name the same directory but differ as
// strings. Each existing ancestor of --out (lexical, and again via the realpath of
// the nearest existing ancestor) is compared to results/raw by identity.

import path from 'node:path'
import { realpathSync, statSync } from 'node:fs'

function identityOrNull(p) {
  try {
    return statSync(p, { bigint: true })
  } catch {
    return null
  }
}

/** The out path with its nearest EXISTING ancestor realpath'd (tail kept as written). */
function realpathOfNearestExisting(abs) {
  let cur = abs
  const tail = []
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...tail)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      tail.unshift(path.basename(cur))
      cur = parent
    }
  }
}

function isUnderCorpus(out, rawDir) {
  const raw = identityOrNull(rawDir)
  const lexical = path.resolve(out)
  const spellings = [lexical, realpathOfNearestExisting(lexical)]
  if (raw !== null) {
    for (const start of spellings) {
      for (let p = start; ; p = path.dirname(p)) {
        const st = identityOrNull(p)
        if (st !== null && st.dev === raw.dev && st.ino === raw.ino) return true
        if (path.dirname(p) === p) break
      }
    }
    return false
  }
  // The corpus dir does not exist (yet): nothing to compare identity with.
  const r = path.resolve(rawDir)
  return lexical === r || lexical.startsWith(r + path.sep)
}

/**
 * @param {{out:string, requested:number|null, modules:{name:string,target:number}[], rawDir:string}} args
 * @returns {string|null} a refusal message, or null when the run is allowed
 */
export function shortTargetRefusal({ out, requested, modules, rawDir }) {
  if (requested === null || requested === undefined) return null
  if (!Number.isInteger(requested) || requested < 1) {
    return `--target must be a positive integer, got ${String(requested)}`
  }
  const o = path.resolve(out)
  if (!isUnderCorpus(out, rawDir)) return null
  const short = modules.filter((m) => requested < m.target)
  if (short.length === 0) return null
  return (
    `refusing --target ${requested} with --out under results/raw/ (${o}): ` +
    `${short.map((m) => `${m.name} needs ${m.target}`).join(', ')}. ` +
    'The summary generator has no notion of target, so a short run there would read as PASS. ' +
    'Write smoke runs outside results/raw/ with --out.'
  )
}

/**
 * Strict flag parser shared by the C4 runners. Every argument must be a known
 * flag followed by a non-empty value that does not itself start with `--`; an
 * unknown flag, a positional, or a flag with a missing value is an error, never
 * silently ignored (a typo used to produce a run of zero cells that exited 0).
 *
 * @param {string[]} argv
 * @param {Record<string,{key:string, kind:'string'|'int'|'list'}>} spec - flag -> how to read it
 * @returns {{opts:object}|{error:string}}
 */
export function parseFlags(argv, spec) {
  const opts = {}
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const def = Object.hasOwn(spec, flag) ? spec[flag] : null
    if (def === null) {
      return {
        error: `unknown argument ${JSON.stringify(flag)} (known: ${Object.keys(spec).join(', ')})`,
      }
    }
    if (seen.has(flag)) return { error: `${flag} given more than once` }
    seen.add(flag)
    const value = argv[i + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { error: `${flag} requires a value` }
    }
    i += 1
    if (def.kind === 'int') {
      if (!/^[1-9][0-9]*$/.test(value)) {
        return { error: `${flag} must be a positive integer, got ${JSON.stringify(value)}` }
      }
      opts[def.key] = Number(value)
    } else if (def.kind === 'list') {
      opts[def.key] = value.split(',')
    } else {
      opts[def.key] = value
    }
  }
  return { opts }
}
