#!/usr/bin/env node
/**
 * Linear Drift Audit (SMI-3542)
 *
 * Detects Linear issues marked "Done" that lack corresponding source code
 * commits. Cross-references git log and GitHub PR API to verify each issue.
 *
 * Usage:
 *   node scripts/audit-linear-drift.mjs                     # Last 30 days
 *   node scripts/audit-linear-drift.mjs --since 2025-01-01  # Custom window
 *   node scripts/audit-linear-drift.mjs --json              # JSON output
 *   node scripts/audit-linear-drift.mjs --verbose           # Per-issue trace
 *
 * Output tiers (JSON mode):
 *   verified    - Commit touches source globs or merged PR found
 *   mentionOnly - Commit exists but no source glob match (informational)
 *   drift       - No commit or PR references the issue
 *
 * Environment:
 *   LINEAR_API_KEY  - Required for Linear GraphQL API
 *   GH_TOKEN        - Optional for GitHub PR search (uses gh CLI auth by default)
 *
 * npm script: npm run audit:drift
 */

import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'

// --- Configuration ---

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const SOURCE_GLOBS = [
  'packages/**/*.ts',
  'packages/**/*.tsx',
  'packages/**/*.astro',
  'packages/**/*.json',
  'packages/**/*.md',
  'packages/**/*.mjs',
  'packages/**/*.css',
  'scripts/**/*.ts',
  'scripts/**/*.mjs',
  'supabase/functions/**/*.ts',
  '.github/workflows/**',
]
const RETRY_DELAYS = [1000, 2000, 4000]
const ALLOWLIST_PATH = '.linear-drift-allowlist'

// SMI-5275: Structural out-of-scope tier. The SMI Linear team spans multiple
// initiatives; non-Skillsmith ones (021 School Platform, MiniMax Gateway, …)
// ship their code in other repos and would always "drift" here. Classify them
// structurally rather than via manual allowlist entries.
//
// SOURCE OF TRUTH: copied verbatim from scripts/triage-linear-drift.mjs
// (SKILLSMITH_PROJECT_PATTERNS, ~lines 221-226). Keep the two in lock-step —
// several Skillsmith projects live under names that don't start with
// "Skillsmith", so the initiative check needs this project-name escape hatch.
const SKILLSMITH_PROJECT_PATTERNS = [
  /^Skillsmith/i,
  /Dependabot Vulnerability Fixes/i,
  /Stub-to-Real|Tier Feature Gap/i,
  /^Backfill Infrastructure/i,
]
// LIVE Smith Horn Group label set — confirmed external-curriculum markers ONLY
// (verified 2026-06-14). Do NOT add generic Docs/Content/documentation labels
// here: those mark genuine Skillsmith repo docs and would suppress real drift.
const EXTERNAL_CURRICULUM_LABELS = ['Track_A', 'Track_B', 'Track_C', 'Track_Z', 'Cohort_4']

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2)
  const sinceIdx = args.indexOf('--since')
  const jsonMode = args.includes('--json')
  const verbose = args.includes('--verbose')

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  let since = thirtyDaysAgo.toISOString().split('T')[0]
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    since = args[sinceIdx + 1]
  }

  return { since, jsonMode, verbose }
}

// --- Allowlist ---

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set()
  const content = readFileSync(ALLOWLIST_PATH, 'utf-8')
  const ids = content
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.length > 0)
  return new Set(ids)
}

// --- Linear API ---

async function fetchWithRetry(url, options, retries = RETRY_DELAYS) {
  for (let i = 0; i <= retries.length; i++) {
    try {
      const res = await fetch(url, options)
      if (res.ok) return res
      if (res.status >= 500 && i < retries.length) {
        await new Promise((r) => setTimeout(r, retries[i]))
        continue
      }
      throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    } catch (err) {
      if (i < retries.length) {
        await new Promise((r) => setTimeout(r, retries[i]))
        continue
      }
      throw err
    }
  }
}

async function fetchDoneIssues(since) {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    console.error('LINEAR_API_KEY not set. Skipping drift audit.')
    process.exit(0)
  }

  const query = `
    query DoneIssues($after: String, $since: DateTimeOrDuration!) {
      issues(
        filter: {
          team: { key: { eq: "SMI" } }
          state: { type: { eq: "completed" } }
          completedAt: { gte: $since }
        }
        first: 100
        after: $after
      ) {
        nodes {
          identifier
          title
          completedAt
          state { name }
          project { name initiatives { nodes { name } } }
          labels(first: 50) { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `

  const sinceDateTime = `${since}T00:00:00Z`
  const allIssues = []
  let cursor = null

  do {
    const res = await fetchWithRetry(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query,
        variables: { after: cursor, since: sinceDateTime },
      }),
    })

    const data = await res.json()
    if (data.errors) {
      // Distinct from the drift `exit 1` gate: a Linear query rejection (e.g.
      // a complexity error or schema drift) must never be mistaken for drift.
      // exit 2 = audit could not run; exit 1 = audit ran and found drift.
      console.error('Drift audit: Linear query failed:', JSON.stringify(data.errors))
      process.exit(2)
    }

    const { nodes, pageInfo } = data.data.issues
    allIssues.push(...nodes)
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (cursor)

  return allIssues
}

// --- Git & GitHub Verification ---

function hasGitCommitWithSource(issueId) {
  try {
    const output = execFileSync(
      'git',
      [
        'log',
        '--all',
        `--grep=${issueId}`,
        '--diff-filter=AMR',
        '--format=%H',
        '--',
        ...SOURCE_GLOBS,
      ],
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    return output.length > 0
  } catch {
    return false
  }
}

function hasMergedPr(issueId) {
  try {
    const output = execFileSync(
      'gh',
      [
        'search',
        'prs',
        issueId,
        '--repo',
        'smith-horn/skillsmith',
        '--state',
        'merged',
        '--json',
        'number',
        '--jq',
        'length',
      ],
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    return parseInt(output, 10) > 0
  } catch {
    return false
  }
}

function hasAnyGitCommit(issueId) {
  try {
    const output = execFileSync('git', ['log', '--all', `--grep=${issueId}`, '--format=%H'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    return output.length > 0
  } catch {
    return false
  }
}

function verifyIssue(issueId, verbose) {
  if (hasGitCommitWithSource(issueId)) {
    if (verbose) console.error(`  ${issueId}: source-glob check HIT → verified`)
    return { status: 'verified', reason: 'source-commit' }
  }

  if (hasMergedPr(issueId)) {
    if (verbose) console.error(`  ${issueId}: source-glob MISS → pr-search HIT → verified`)
    return { status: 'verified', reason: 'merged-pr' }
  }

  if (hasAnyGitCommit(issueId)) {
    if (verbose)
      console.error(
        `  ${issueId}: source-glob MISS → pr-search MISS → any-commit HIT → mention-only`
      )
    return { status: 'mention-only', reason: 'commit-exists-no-source-glob' }
  }

  if (verbose)
    console.error(`  ${issueId}: source-glob MISS → pr-search MISS → any-commit MISS → unverified`)
  return { status: 'unverified', reason: 'no-commit-found' }
}

// --- Structural Out-of-Scope (SMI-5275) ---

/**
 * Classify an issue as structurally out-of-scope for THIS repo's drift audit.
 *
 * Returns `{ outOfScope: true, reason }` ONLY when:
 *   - (primary) the issue's project has a non-empty initiatives list, NONE of
 *     which is Skillsmith (full-list `.some()`, never nodes[0] — guards
 *     multi-initiative issues), AND the project name matches no known
 *     Skillsmith project pattern → reason `external-initiative:<name>`; OR
 *   - (secondary) the issue carries an external-curriculum label (catches
 *     orphan issues with no project/initiative) → reason
 *     `external-curriculum-label:<label>`.
 *
 * Otherwise returns `{ outOfScope: false }`. FAIL SAFE: a missing/blank
 * initiative with no curriculum label keeps the issue IN scope (it falls
 * through to verifyIssue and can still be flagged as drift) — the heuristic
 * never silently excludes.
 */
function isOutOfScope(issue) {
  // Primary: project initiative ∉ Skillsmith AND project not a Skillsmith project.
  const initiativeNodes = issue.project?.initiatives?.nodes
  if (Array.isArray(initiativeNodes) && initiativeNodes.length > 0) {
    const hasSkillsmith = initiativeNodes.some((n) => /^Skillsmith$/i.test(n?.name ?? ''))
    const projectName = issue.project?.name ?? ''
    const isSkillsmithProject = SKILLSMITH_PROJECT_PATTERNS.some((p) => p.test(projectName))
    if (!hasSkillsmith && !isSkillsmithProject) {
      // Report a representative non-Skillsmith initiative name for the reason.
      const externalName = initiativeNodes.find((n) => n?.name)?.name ?? 'unknown'
      return { outOfScope: true, reason: `external-initiative:${externalName}` }
    }
  }

  // Secondary: external-curriculum label on an orphan issue (no project/initiative).
  const labels = issue.labels?.nodes?.map((n) => n?.name).filter(Boolean) ?? []
  const curriculumLabel = labels.find((l) => EXTERNAL_CURRICULUM_LABELS.includes(l))
  if (curriculumLabel) {
    return { outOfScope: true, reason: `external-curriculum-label:${curriculumLabel}` }
  }

  return { outOfScope: false }
}

// --- Main ---

async function main() {
  const { since, jsonMode, verbose } = parseArgs()

  if (!jsonMode) {
    console.log(`Linear Drift Audit — checking issues completed since ${since}\n`)
  }

  const allowlist = loadAllowlist()
  const issues = await fetchDoneIssues(since)

  if (!jsonMode) {
    console.log(`Found ${issues.length} completed issues`)
  }

  const driftIssues = []
  const verifiedIssues = []
  const mentionOnlyIssues = []
  const allowlistedIssues = []
  const outOfScopeIssues = []

  for (const issue of issues) {
    if (allowlist.has(issue.identifier)) {
      allowlistedIssues.push(issue)
      continue
    }

    // SMI-5275: structural exclusion BEFORE verifyIssue. External-initiative /
    // external-curriculum issues ship their code in other repos and would
    // always drift here; exclude them from the `exit 1` gate.
    const scope = isOutOfScope(issue)
    if (scope.outOfScope) {
      outOfScopeIssues.push({ ...issue, reason: scope.reason })
      continue
    }

    const result = verifyIssue(issue.identifier, verbose)

    if (result.status === 'verified') {
      verifiedIssues.push(issue)
    } else if (result.status === 'mention-only') {
      mentionOnlyIssues.push({ ...issue, reason: result.reason })
    } else {
      driftIssues.push({ ...issue, reason: result.reason })
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          since,
          total: issues.length,
          verified: verifiedIssues.length,
          mentionOnly: mentionOnlyIssues.map((i) => ({
            id: i.identifier,
            title: i.title,
            completedAt: i.completedAt,
            reason: i.reason,
          })),
          drift: driftIssues.map((i) => ({
            id: i.identifier,
            title: i.title,
            completedAt: i.completedAt,
            reason: i.reason,
          })),
          // SMI-5275: out-of-scope is a per-item array (so maintainers can audit
          // WHAT was excluded), while `allowlisted` stays a bare count. The
          // asymmetry is intentional — do not "fix" it: the allowlist is a
          // manual override that needs no per-item audit trail here.
          outOfScope: outOfScopeIssues.map((i) => ({
            id: i.identifier,
            title: i.title,
            completedAt: i.completedAt,
            reason: i.reason,
          })),
          allowlisted: allowlistedIssues.length,
        },
        null,
        2
      )
    )
  } else {
    console.log(`Verified: ${verifiedIssues.length}`)
    console.log(`Mention-only (commit exists, no source glob match): ${mentionOnlyIssues.length}`)
    console.log(`Allowlisted: ${allowlistedIssues.length}`)
    console.log(
      `Out-of-scope (external initiative/curriculum — auto-excluded): ${outOfScopeIssues.length}`
    )
    console.log(`Drift detected: ${driftIssues.length}`)

    if (outOfScopeIssues.length > 0) {
      console.log('\n--- Issues structurally excluded (external initiative/curriculum) ---\n')
      for (const issue of outOfScopeIssues) {
        console.log(`  ${issue.identifier}: ${issue.title} (${issue.reason})`)
      }
    }

    if (mentionOnlyIssues.length > 0) {
      console.log('\n--- Issues with commits but no source glob match (informational) ---\n')
      for (const issue of mentionOnlyIssues) {
        console.log(`  ${issue.identifier}: ${issue.title} (reason: ${issue.reason})`)
      }
    }

    if (driftIssues.length > 0) {
      console.log('\n--- Issues marked Done without any commits ---\n')
      for (const issue of driftIssues) {
        console.log(
          `  ${issue.identifier}: ${issue.title} (completed: ${issue.completedAt?.split('T')[0]})`
        )
      }
    }
  }

  if (driftIssues.length > 0) {
    process.exit(1)
  }
}

// Only run when executed directly
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('audit-linear-drift.mjs') ||
    process.argv[1].endsWith('audit-linear-drift'))

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Drift audit failed:', err.message)
    process.exit(1)
  })
}

export {
  loadAllowlist,
  parseArgs,
  hasGitCommitWithSource,
  hasMergedPr,
  hasAnyGitCommit,
  verifyIssue,
  isOutOfScope,
}
