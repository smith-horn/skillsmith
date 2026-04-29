// SMI-4533: Forbid local-fallback npm publish.
//
// Wired as `prepublishOnly` in every publishable package's package.json. Refuses
// unless invoked from a canonical-repo GitHub Actions runner. Override path:
// `SKILLSMITH_PUBLISH_OVERRIDE=SMI-NNNN <rationale, ≥20 chars>` for genuine
// break-glass use; the override appends an audit row to
// `~/.skillsmith-publish-overrides.log` (SMI-4538 tracks the eventual Supabase
// audit-log write).
//
// Caveat: `npm publish --ignore-scripts` skips this hook. The binding registry
// gate is npm trusted-publisher OIDC (SMI-4539 flips that on after the token
// path stabilizes; SMI-4540 retires the token entirely).
//
// Recovery runbook: docs/internal/runbooks/publish-ci-recovery.md.

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

// SMI-4533: SMI-NNNN + space + 18+ chars (total ≥ 20 chars after the SMI ref).
// Prevents `OVERRIDE=1` from becoming idiomatic; forces the operator to write
// down WHY a local publish is happening, in the same line that's logged.
const OVERRIDE_FORMAT = /^SMI-\d+\s+\S.{18,}$/

const CANONICAL_REPO = 'smith-horn/skillsmith'
const RUNBOOK = 'docs/internal/runbooks/publish-ci-recovery.md'

/**
 * Assert that the current process is running inside a canonical-repo GitHub
 * Actions runner. Exits the process with code 1 on refusal.
 *
 * @param {NodeJS.ProcessEnv} [env] - injected env for tests
 * @returns {void}
 */
export function assertCiPublishContext(env = process.env) {
  const override = env.SKILLSMITH_PUBLISH_OVERRIDE
  if (override) {
    if (!OVERRIDE_FORMAT.test(override)) {
      console.error(
        'SMI-4533: SKILLSMITH_PUBLISH_OVERRIDE format invalid.\n' +
          '  Required: SMI-NNNN <rationale, ≥20 chars total>\n' +
          '  Example: SMI-4499 emergency hotfix for prod incident; CI down 30+ min'
      )
      process.exit(1)
      return
    }
    console.error(`::warning::OVERRIDE: local-publish guard bypassed. Reason: ${override}`)
    try {
      appendFileSync(
        join(env.HOME ?? '/tmp', '.skillsmith-publish-overrides.log'),
        `${new Date().toISOString()}\t${override}\t${env.GITHUB_REPOSITORY ?? 'local'}\n`
      )
    } catch (e) {
      console.error(`::warning::Failed to write override log: ${e.message}`)
    }
    return
  }

  const isCi = env.CI === 'true' && env.GITHUB_ACTIONS === 'true'
  const isCanonicalRepo = env.GITHUB_REPOSITORY === CANONICAL_REPO
  if (!isCi || !isCanonicalRepo) {
    console.error(
      'SMI-4533: npm publish must run from CI (publish.yml). Local-fallback bypasses all guards.\n' +
        '  - Use: gh workflow run publish.yml -f dry_run=false\n' +
        `  - If CI is broken, fix CI first — see ${RUNBOOK}\n` +
        '  - Genuine emergency: set SKILLSMITH_PUBLISH_OVERRIDE="SMI-NNNN <rationale>" and document in retro.'
    )
    process.exit(1)
    return
  }
}

// CLI entrypoint — only runs when invoked directly via `node ../../scripts/lib/forbid-local-publish.mjs`.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('forbid-local-publish.mjs')

if (isMain) {
  assertCiPublishContext()
}
