#!/usr/bin/env node
/**
 * E2E setup patch (SMI-5331) — make minimatch's ESM build tolerate brace-expansion@5.
 *
 * The monorepo pins a global `brace-expansion@^5.0.6` override (CVE fix, SMI-5249).
 * brace-expansion@5's ESM entry exports `{ EXPANSION_MAX, expand }` — NO default —
 * but minimatch@9's ESM build does `import expand from 'brace-expansion'` (a default
 * import). When wdio (ESM) loads `@wdio/config → glob@10 → minimatch@9`, Node throws
 * `does not provide an export named 'default'` and the whole e2e run aborts.
 *
 * npm overrides cannot dislodge this (a global brace-expansion override defeats any
 * scoped/nested override, and minimatch is a transitive grandchild via glob). So we
 * make the import resilient in node_modules at e2e-setup time. This is CONTAINED to
 * the e2e flow (run by `test:e2e:setup` / `test:e2e`), touches no committed source,
 * no lockfile, and no other package's behaviour. Idempotent: only rewrites files
 * that still have the broken default import.
 *
 * Reverify when bumping wdio-vscode-service / @wdio (a version whose @wdio/config
 * uses minimatch@10 would make this a no-op and it can then be removed).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// packages/vscode-extension/e2e/scripts → repo root (up 4)
const nodeModules = join(here, '..', '..', '..', '..', 'node_modules')

// Default-import form is the broken one; minimatch@10 already uses a named import.
const BROKEN = /import expand from ['"]brace-expansion['"];/
const FIXED = 'import * as __be from "brace-expansion"; const expand = __be.default ?? __be.expand;'

let files = []
try {
  files = execFileSync('find', [nodeModules, '-path', '*minimatch/dist/esm/index.js'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 100,
  })
    .split('\n')
    .filter(Boolean)
} catch (err) {
  console.warn(`[e2e setup] could not scan for minimatch ESM files: ${err.message}`)
  process.exit(0) // fail-soft: let the e2e run surface the real error if any
}

let patched = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (BROKEN.test(src)) {
    writeFileSync(file, src.replace(BROKEN, FIXED))
    patched += 1
  }
}
console.log(
  `[e2e setup] minimatch ESM brace-expansion shim: patched ${patched} file(s) ` +
    `(${files.length} scanned; 0 patched = already compatible)`
)
