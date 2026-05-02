/**
 * Pure helpers for SMI-4641 vercel.json structural sync (audit-standards.mjs §38).
 *
 * Two vercel.json files exist by design — they target different deploy paths:
 *   • root vercel.json: read by Vercel's git-integrated deploy (rootDirectory=null
 *     on the project). buildCommand here must materialize BOA at REPO-ROOT
 *     `.vercel/output/`, hence the `cp -r packages/website/.vercel/output …`
 *     postbuild step. The @astrojs/vercel adapter writes to
 *     `packages/website/.vercel/output/`, but `vercel build` reads from
 *     `<projectRoot>/.vercel/output/`.
 *   • packages/website/vercel.json: read by `cd packages/website && vercel --prod`.
 *     The local CLI's `vercel build` runs with cwd=packages/website/, so BOA is
 *     written and read at `packages/website/.vercel/output/` — no postbuild
 *     copy needed.
 *
 * Zero dependencies. No I/O. No side effects.
 */

/**
 * Fields whose values must match between the two vercel.json files. Drift here
 * means preview/staging and prod render differently to end users (different
 * redirects, headers, CSP, framework, install behavior).
 */
export const VERCEL_JSON_SHARED_FIELDS = ['framework', 'installCommand', 'redirects', 'headers']

/**
 * Validate that an outputDirectory path is shaped correctly. Returns true for
 * undefined (preferred — let buildCommand materialize BOA) or for a non-empty
 * relative POSIX path with no traversal segments and no Windows backslashes.
 */
export const isValidOutputDirectory = (v) =>
  v === undefined ||
  (typeof v === 'string' &&
    v.length > 0 &&
    !v.startsWith('/') &&
    !v.includes('..') &&
    !v.includes('\\'))

/**
 * Compare two parsed vercel.json objects. Returns:
 *   { ok: true } when the shared fields match and outputDirectory shapes are valid;
 *   { ok: false, kind: 'drift', drifted: string[] } when shared fields disagree;
 *   { ok: false, kind: 'shape', side: 'root' | 'website', value: unknown } when
 *     outputDirectory is set but shaped wrong.
 *
 * `buildCommand` and `outputDirectory` are allowed to differ between the two
 * files because they target different cwd contexts.
 */
export const validateVercelJsonSync = (root, website) => {
  const drifted = VERCEL_JSON_SHARED_FIELDS.filter(
    (k) => JSON.stringify(root[k]) !== JSON.stringify(website[k])
  )
  if (drifted.length > 0) {
    return { ok: false, kind: 'drift', drifted }
  }
  if (!isValidOutputDirectory(root.outputDirectory)) {
    return { ok: false, kind: 'shape', side: 'root', value: root.outputDirectory }
  }
  if (!isValidOutputDirectory(website.outputDirectory)) {
    return { ok: false, kind: 'shape', side: 'website', value: website.outputDirectory }
  }
  return { ok: true }
}
