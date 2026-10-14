// SMI-7123 Wave 5 (design §6): the trace invariant for a walker child's trace.
//
//  1. Every unlinkSync/rmdirSync/rmSync on a user entry takes a single-segment
//     relative argument, with the real cwd inside S.
//  2. Each such unlinkSync is immediately preceded by lstatSync(n),
//     renameSync(n, r), lstatSync(r) on the same cwd.
//  3. No destructive call targets the trash path, the origin, or anything
//     outside S -- except Skillsmith's own metadata, by absolute path:
//     S/deleting, S/intent.json, rmdir S, and rmdir of the (now empty) op dir.
//  4. The walker never renames a hidden `.d-*` name (a rename back would
//     replace whatever now occupies the original name; design §3.3, M8).
//
// Clarification recorded for the coordinator: the design states rule 3 as "no
// destructive call ... outside S" and lists P4g's rmdir of the op dir, which is
// outside S. Only that exact empty-directory rmdir and the S-metadata calls are
// allowlisted here; anything else outside S is a violation.
import fs from 'node:fs'
import path from 'node:path'

const DESTRUCTIVE = new Set(['unlinkSync', 'rmdirSync', 'rmSync'])
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)
const single = (a) => typeof a === 'string' && a.length > 0 && !a.includes('/')

/**
 * ONE canonical spelling, decided UP FRONT from the fixture root -- never by
 * realpath-ing a traced path after the walk, when S, its files and the op dir
 * are already deleted (realpath then fails and a fallback returns the raw
 * spelling, so S and the allowlist end up spelled differently from the trace:
 * measured on a symlinked root, SMI-7123 coordinator repro w5-linkroot.sh).
 *
 * `root` is the fixture root as the caller spelled it; it is never deleted, so
 * its realpath is taken once here. Every path under that spelling is mapped
 * onto the canonical prefix by string; traced `cwd` values come from getcwd()
 * and are canonical already. Without a root, paths compare lexically (correct
 * only when the caller's root is already canonical, as w5Root() now is).
 */
export function canonicalizer(root) {
  if (!root) return (p) => (p === null ? null : path.resolve(p))
  const lex = path.resolve(root)
  const canon = fs.realpathSync(lex)
  return (p) => {
    if (p === null || p === undefined) return null
    const a = path.resolve(p)
    return a === lex ? canon : a.startsWith(lex + path.sep) ? canon + a.slice(lex.length) : a
  }
}

/**
 * @param {{trace:object[]}} t   the interposer's trace object
 * @param {{root?:string, S:string|null, copyPath:string, originPath?:string, opDir:string}} ctx
 *   root: the fixture root (see canonicalizer). S may be null when the run never
 *   created one (then any destructive call on a user entry is a violation).
 * @returns {{ok:boolean, destructive:number, violations:string[]}}
 */
export function matchPruneTrace(t, { root, S, copyPath, originPath, opDir }) {
  const violations = []
  const trace = t?.trace ?? []
  const C = canonicalizer(root)
  const realS = S ? C(S) : null
  // Per function: only single-entry unlink of the two metadata files, and only a
  // non-recursive rmdir of S or the (empty) op dir. Nothing else, ever.
  const allowAbs = {
    unlinkSync: new Set(
      realS ? [path.join(realS, 'deleting'), path.join(realS, 'intent.json')] : []
    ),
    rmdirSync: new Set(realS ? [realS, C(opDir)] : []),
  }
  const forbidden = [copyPath, originPath].filter(Boolean).map(C)
  let destructive = 0
  for (let i = 0; i < trace.length; i += 1) {
    const e = trace[i]
    if (e.fn === 'renameSync' && single(e.a0) && e.a0.startsWith('.d-')) {
      violations.push(`#${i} renameSync of a hidden name ${e.a0} -> ${e.a1} (a rename back)`)
    }
    if (!DESTRUCTIVE.has(e.fn) || e.err) continue
    destructive += 1
    // FIRST, unconditionally (Sol c1 finding 3): a recursive or forced delete is a
    // violation whatever it names. It used to be checked last, after the
    // absolute-path allowlist had already `continue`d past it.
    if (e.fn === 'rmSync' || e.recursive === true || e.force === true) {
      violations.push(
        `#${i} ${e.fn}(${e.a0}) is a recursive or forced delete: the walker never deletes recursively`
      )
      continue
    }
    const target = single(e.a0) ? path.join(e.cwd ?? '/', e.a0) : C(e.a0)
    if (forbidden.some((f) => inside(target, f) || target === f)) {
      violations.push(`#${i} ${e.fn} targets the trash path or origin: ${target}`)
      continue
    }
    if (!single(e.a0)) {
      if (!allowAbs[e.fn]?.has(target))
        violations.push(`#${i} ${e.fn} by absolute path outside the allowlist: ${target}`)
      continue
    }
    if (realS === null || !inside(e.cwd ?? '', realS)) {
      violations.push(`#${i} ${e.fn}(${e.a0}) with cwd ${e.cwd} outside S`)
      continue
    }
    if (e.fn === 'unlinkSync' && e.a0 !== 'deleting') {
      const [p3, p2, p1] = [trace[i - 3], trace[i - 2], trace[i - 1]]
      const ok =
        p3?.fn === 'lstatSync' &&
        p2?.fn === 'renameSync' &&
        p1?.fn === 'lstatSync' &&
        p2.a0 === p3.a0 &&
        p2.a1 === e.a0 &&
        p1.a0 === e.a0 &&
        p3.cwd === e.cwd &&
        p2.cwd === e.cwd &&
        p1.cwd === e.cwd
      if (!ok)
        violations.push(
          `#${i} unlinkSync(${e.a0}) not preceded by lstat(n), rename(n, r), lstat(r)`
        )
    }
  }
  return { ok: violations.length === 0, destructive, violations }
}
