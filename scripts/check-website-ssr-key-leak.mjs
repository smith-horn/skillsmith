#!/usr/bin/env node
/**
 * SMI-6190 build-artifact scan: confirms the dedicated SSR API key never
 * reaches the client-shipped bundle.
 *
 * `packages/website/src/lib/supabase-config.server.ts` reads
 * `SKILLSMITH_WEBSITE_SSR_API_KEY` and is only ever imported from
 * server-side frontmatter (`.astro` files), never from client-side code —
 * but that's a convention enforced by file-naming discipline and code
 * review, not by the bundler. This script backs the convention with a
 * concrete assertion: after `packages/website`'s build, neither the env var
 * name nor a recognizable `sk_live_`-shaped key ever appears anywhere under
 * the client-shipped output directory (`packages/website/dist/client` —
 * the static/browser-served assets; `dist/server` is the SSR-only bundle
 * and is legitimately allowed to reference the env var name, since it reads
 * it from `process.env` at request time and never bakes in the literal
 * secret value).
 *
 * Usage: node scripts/check-website-ssr-key-leak.mjs
 * Run AFTER `packages/website`'s build has produced `dist/client` (e.g.
 * `cd packages/website && npx astro build`, or `npm run build`).
 * Exits 1 (and prints every offending file) if either string is found;
 * exits 2 if `dist/client` doesn't exist (build hasn't run yet); exits 0
 * on a clean scan.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CLIENT_DIST_DIR = join(REPO_ROOT, 'packages', 'website', 'dist', 'client')

const FORBIDDEN_PATTERNS = [
  { label: 'env var name', re: /SKILLSMITH_WEBSITE_SSR_API_KEY/ },
  // A REAL key (see generateLicenseKey(), supabase/functions/_shared/license.ts)
  // is `sk_live_` followed by a 43-char base64url body (32 random bytes,
  // charset [A-Za-z0-9_-]) — 20+ such characters is specific enough to catch
  // any real leaked key while not false-positiving on this site's own docs
  // pages, which legitimately show the placeholder shapes `sk_live_...` and
  // bare `sk_live_` (an OpenAPI pattern example) when documenting the format
  // for users setting up their own personal API keys.
  { label: 'sk_live_ key-shape (real, not a doc placeholder)', re: /sk_live_[A-Za-z0-9_-]{20,}/ },
]

/** Recursively yields every regular file under `dir`. */
function* walkFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const st = statSync(fullPath)
    if (st.isDirectory()) {
      yield* walkFiles(fullPath)
    } else if (st.isFile()) {
      yield fullPath
    }
  }
}

function main() {
  if (!existsSync(CLIENT_DIST_DIR)) {
    console.error(
      `[check-website-ssr-key-leak] ${relative(REPO_ROOT, CLIENT_DIST_DIR)} does not exist — ` +
        'run the packages/website build first (e.g. `cd packages/website && npx astro build`).'
    )
    process.exit(2)
  }

  /** @type {Array<{file: string, label: string}>} */
  const findings = []

  for (const file of walkFiles(CLIENT_DIST_DIR)) {
    let contents
    try {
      contents = readFileSync(file, 'utf-8')
    } catch {
      // Binary/unreadable-as-utf8 file (e.g. an image or font) — cannot
      // contain a matching text pattern in any way that matters here, skip.
      continue
    }
    for (const { label, re } of FORBIDDEN_PATTERNS) {
      if (re.test(contents)) {
        findings.push({ file: relative(REPO_ROOT, file), label })
      }
    }
  }

  if (findings.length > 0) {
    console.error(
      `[check-website-ssr-key-leak] FAILED — found ${findings.length} leak(s) in ` +
        `${relative(REPO_ROOT, CLIENT_DIST_DIR)}:`
    )
    for (const { file, label } of findings) {
      console.error(`  - ${file}: contains ${label}`)
    }
    process.exit(1)
  }

  console.log(
    `[check-website-ssr-key-leak] OK — no SSR key leak found in ${relative(REPO_ROOT, CLIENT_DIST_DIR)}`
  )
  process.exit(0)
}

main()
