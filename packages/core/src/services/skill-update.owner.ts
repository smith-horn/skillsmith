/**
 * SMI-6531 (A1 step 7b): which manifest key owns a real skill folder (UD22(4);
 * A1 plan §4.3 "One folder, several keys").
 *
 * A real path can be named by more than one key: two clients sharing one
 * root, or a root symlinked into another. Exactly one key owns it:
 *
 * 1. a key whose recorded `installPath` equals the real path as written,
 *    without resolving a symlink;
 * 2. among several, the earliest `installedAt`;
 * 3. then the smallest key in code-unit order.
 *
 * When no key records the real path as written, rules 2 and 3 choose among
 * every key that names it through a symlink. An `installedAt` that does not
 * parse sorts after every one that does.
 *
 * Pure: the caller resolves `installPath`s (`realPathOf`) before calling, so
 * the rule itself does no I/O. The in-place update refuses a non-owning key
 * (`skill-update.target.ts`). A2's `plan.identityMismatch` has no producer
 * yet; when one is wired it must call this same function.
 *
 * @module @skillsmith/core/services/skill-update.owner
 */
import { isPlainObject } from './skill-manifest.canonical.js'

/** The real path an `installPath` resolves to, or `null` when it does not resolve. */
export type RealPathOf = (installPath: string) => string | null

interface Candidate {
  key: string
  literal: boolean
  installedAt: number
}

function timeOf(value: unknown): number {
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

function byOwnership(a: Candidate, b: Candidate): number {
  if (a.installedAt !== b.installedAt) return a.installedAt < b.installedAt ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * The key owning `realDir` in the raw manifest, or `null` when no key names
 * it. `realPathOf` defaults to "no symlink resolution", so only literal
 * `installPath`s count.
 */
export function manifestKeyOwner(
  rawManifest: unknown,
  realDir: string,
  realPathOf: RealPathOf = () => null
): string | null {
  if (!isPlainObject(rawManifest) || !Object.hasOwn(rawManifest, 'installedSkills')) return null
  const installed = rawManifest.installedSkills
  if (!isPlainObject(installed)) return null
  const naming: Candidate[] = []
  for (const key of Object.keys(installed)) {
    const entry = installed[key]
    if (!isPlainObject(entry)) continue
    const installPath = entry.installPath
    if (typeof installPath !== 'string' || installPath === '') continue
    const literal = installPath === realDir
    if (!literal && realPathOf(installPath) !== realDir) continue
    naming.push({ key, literal, installedAt: timeOf(entry.installedAt) })
  }
  const pool = naming.some((c) => c.literal) ? naming.filter((c) => c.literal) : naming
  return pool.sort(byOwnership)[0]?.key ?? null
}
