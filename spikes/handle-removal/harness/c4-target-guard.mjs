// SMI-6715: shared by run-c4-attacks.mjs and run-c4-mount-attacks.mjs.
//
// results/generate-summary.mjs has no notion of a cell's target, so a short
// smoke file left under results/raw/ would render as PASS. This refuses, before
// any run, a --target below a module's own target when the output resolves
// under results/raw/. Path comparison is lexical (path.resolve), so a symlinked
// route into results/raw is not detected.

import path from 'node:path'

/**
 * @param {{out:string, requested:number|null, modules:{name:string,target:number}[], rawDir:string}} args
 * @returns {string|null} a refusal message, or null when the run is allowed
 */
export function shortTargetRefusal({ out, requested, modules, rawDir }) {
  if (requested === null || requested === undefined) return null
  if (!Number.isInteger(requested) || requested < 1) {
    return `--target must be a positive integer, got ${String(requested)}`
  }
  const raw = path.resolve(rawDir)
  const o = path.resolve(out)
  if (o !== raw && !o.startsWith(raw + path.sep)) return null
  const short = modules.filter((m) => requested < m.target)
  if (short.length === 0) return null
  return (
    `refusing --target ${requested} with --out under results/raw/ (${o}): ` +
    `${short.map((m) => `${m.name} needs ${m.target}`).join(', ')}. ` +
    'The summary generator has no notion of target, so a short run there would read as PASS. ' +
    'Write smoke runs outside results/raw/ with --out.'
  )
}
