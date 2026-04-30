#!/usr/bin/env node
/**
 * Linear Drift Triage (SMI-4559, 2026-04-30)
 *
 * Bucket `linear-drift-audit` output into 5 categories so the maintainer can
 * draft `.linear-drift-allowlist` additions in one pass.
 *
 * Categories:
 *   external-repo       — issue belongs to AsanaPlayground / MAUI / lin-cli /
 *                         minimax / 021.School / Asana modules / EvoSkill
 *                         (separate repos; commits don't land here)
 *   docs-only           — pure documentation or operational ticket
 *                         (docs/internal/ submodule edits, runbooks, etc.)
 *   manual-op           — deploy / seed / GPG / approval / one-time admin
 *                         action (no source change expected)
 *   commit-without-token — squash-merged PR exists in this repo but the
 *                         commit message lacked SMI-NNNN
 *   genuine-drift       — code work that should have shipped but didn't;
 *                         reopen the issue
 *
 * Re-runs cleanly each month; this is a recurring governance need
 * (NOT single-use). Re-classifies drift buckets when the audit fires.
 *
 * Usage:
 *   varlock run -- node scripts/audit-linear-drift.mjs --json --since 2025-01-01 > /tmp/drift-results.json
 *   varlock run -- node scripts/triage-linear-drift.mjs /tmp/drift-results.json
 *
 * Output:
 *   /tmp/drift-buckets.json — five-bucket classification with rationale
 *   stdout                  — human-readable summary + counts
 *
 * Exit codes:
 *   0  — all entries bucketed; ≤5 genuine-drift candidates
 *   1  — input file missing or unparseable
 *   2  — >5 genuine-drift candidates (re-bucket or escalate)
 *
 * Environment:
 *   LINEAR_API_KEY  — Required for fetching issue metadata (project + labels)
 *   GH_TOKEN        — Optional; uses gh CLI auth if absent
 */

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// --- Configuration ---

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const OUTPUT_PATH = '/tmp/drift-buckets.json'
const ESCALATION_THRESHOLD = 5

// Title-keyword heuristics for external-repo classification.
// Order matters — checked first-to-last; first match wins.
const EXTERNAL_REPO_PATTERNS = [
  { pattern: /AsanaPlayground|Asana(?:[ -])?(?:module|API|Workshop)|AIPM-Asana|aipm-asana/i, repo: 'AsanaPlayground' },
  // MAUI prototype — covers all named services + spec / scaffold / boundary work
  { pattern: /MAUI|\.NET 8|PdfWorkspace|PdfJsViewer|AnnotationSet|XFDF|sidecar annotation|RefreshPolicyService|DocumentSessionService|annotation workflow|annotation set per PDF|app boundaries in the scaffold|viewer and session architecture|prototype specification|sidecar annotation file model|harness UI/i, repo: 'MAUI prototype' },
  // lin-cli — separate npm package
  { pattern: /lin[ -]cli|tryLin|lin CLI|checkLin(ear)?Cli|execLin<|detectLin(ear)?Cli|checkLinCli|list-initiatives|Add list-issues command|Add search command|Rename check.*Cli|Update help command/i, repo: 'lin-cli' },
  // minimax / gateway / LLM routing project (Python codebase, separate repo)
  { pattern: /MiniMax|qwen3-coder|gemma3-12b|minimax-M2|GATEWAY_MASTER|gateway routing|coding_benchmark|Phase \d+: (Setup|Live Model|Live Tests|Gate Check)|Gate Check —|Stage \d+: (JSONL|Supabase llm_usage)|crawler\/(crawl|crawl_log|dedup)\.py|agent\/interview\.py|llm_usage\.py|LLMBackend|GatewayBackend|AnthropicBackend|chat_with_usage|record_usage|token-report\.py/i, repo: 'minimax / gateway' },
  // Wave-numbered Python work in the minimax/crawler repo
  { pattern: /Wave \d+ · .*\.py|Wave \d+ · (Migration|Surface new counter|Split crawl_log|TDD Red|Dedupe script|app-side recovery)/i, repo: 'minimax / crawler' },
  // 021.School cohort docs + Track A/B/C work + workshop-specific scripts
  { pattern: /021\.School|Module \d+ Step|live-session-setup|environment-setup\.md|agent-skill-distinction|composing-and-anti-patterns|context-window-economics|delegation-architecture|exercise-(build-a-skill|ship-it|publish-skill|multi-agent)|\[Track [ABC]\]|introduction\.md|lessons-next-steps|appendix-troubleshooting|writing-skills-that-work|daisy-chain-pattern|anatomy-of-a-skill|workshop-config|workshop-fork|register-workshop|Asana playground|David Gratton|attendee-management|Module \d+:|Agentic Skills April 2026|send-workshop-invites|enrollment email sends|workshop_instructors|instructor (badge|chips)|^PR2:/i, repo: '021.School cohort docs' },
  { pattern: /EvoSkill|evoskill-harness/i, repo: 'EvoSkill' },
  { pattern: /minimax-compatibility/i, repo: 'minimax compatibility tests' },
  // Ideon / Acme Corp workshop forks
  { pattern: /Ideon|Acme Corp|workshop\.yaml/i, repo: '021.School workshop forks' },
]

// Title-keyword heuristics for docs-only classification.
const DOCS_ONLY_PATTERNS = [
  /^docs(\(|:)/i,
  /update (CLAUDE\.md|SKILL\.md|README|docs|index)/i,
  /^Document /i,
  /^Update.*(documentation|docs)/i,
  /add.*(rationale|guidance|note|memo) to/i,
  /CHANGELOG/i,
  /retro:|retro$/i,
  /Sub-Documentation/i,
]

// Title-keyword heuristics for wave / sub-task shipped under a parent PR.
// Linear convention: large initiatives split into Wave N / WN.M / scoped
// conventional-commit subtasks. The parent PR title typically references
// only the parent SMI (or "Wave N"), so child SMIs land in drift even
// though the work shipped. Allowlist these with a parent-shipped rationale.
const WAVE_SUBTASK_PATTERNS = [
  /^Wave \d+(\.\d+)?:/i,
  /^Wave \d+ ·/i,
  /^W\d+\.\d+:/i,
  /^Phase \d+:/i,
  /^Stage \d+:/i,
  /^(fix|feat|test|chore|ci|a11y|ux|refactor|spike|docs|build|perf|style|plan)[(:]/i,
  /^plan: /i,
  /^ADR: /i,
  /^Bridge .* MCP tool handler/i,
  /SMI-\d+ Wave \d+/i,
  // Batch search-feature follow-ups (PR #183/184 era, all bundled with the
  // search-modal refactor parent PR)
  /searchModal\.ts|search-helper\.ts|SearchModalSimulator|SearchController|searchGeneration|cancelPendingSearch|performSearch|navigateResults|search modal keyboard|Pagefind|search-error-/i,
]

// Title-keyword heuristics for manual-op classification.
const MANUAL_OP_PATTERNS = [
  /^(Deploy|Seed|Apply|Provision|Set up|Set staging|Configure|Authorize|Authorise|Grant|Approve|Ops:?\s)/i,
  /supabase staging|production database|create.*(repo|repository)|set up.*environment/i,
  /Verify .*(access|setup)/i,
  /Initialize .*(GitHub repo|repository)/i,
  /Smoke test |Manual /i,
  /Install .*(globally|on Windows|CLI)/i,
  /git-crypt.*(authorize|authorise|collaborator|gpg)/i,
  // Triage / batch review / runbook work
  /^Triage \d+ /i,
  /^Review:? /i,
  /^Runbook:?/i,
  /post-merge human code review/i,
  /clear stale npx _npx caches/i,
  // Migration application / DB ops
  /apply migrations? \d+/i,
  /Remediate prod schema_migrations/i,
  // Local-only cleanup (no commit expected)
  /Clean up.*local branch artifacts/i,
  /Consumer grep|orphan check/i,
]

// --- Helpers ---

function readJson(path) {
  if (!existsSync(path)) {
    console.error(`Input file not found: ${path}`)
    process.exit(1)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err.message}`)
    process.exit(1)
  }
}

/**
 * Fetch the Linear project name AND its parent initiative for a single SMI
 * via the GraphQL API. Initiative is the cross-project grouping that
 * cleanly separates Skillsmith from sibling projects (021.School,
 * lin-cli, MAUI, minimax). Project name alone misses Skillsmith projects
 * whose names don't start with "Skillsmith" (e.g. "Release Hardening",
 * "Issue Description Validation", etc.).
 *
 * Returns { project, initiative } or null on failure.
 */
function fetchLinearProject(smi, apiKey) {
  if (!apiKey) return null
  try {
    const out = execFileSync(
      'curl',
      [
        '-sS',
        '-H',
        `Authorization: ${apiKey}`,
        '-H',
        'Content-Type: application/json',
        '-X',
        'POST',
        '--data',
        JSON.stringify({
          query: `query { issue(id: "${smi}") { project { name initiatives { nodes { name } } } } }`,
        }),
        LINEAR_API_URL,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const data = JSON.parse(out || '{}')
    const project = data?.data?.issue?.project
    if (!project) return null
    const initiatives = (project.initiatives?.nodes ?? []).map((n) => n.name)
    return {
      project: project.name,
      initiative: initiatives[0] ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Linear project → external-repo bucket name. Anything not in the
 * Skillsmith initiative belongs in external-repo.
 */
const EXTERNAL_PROJECT_PATTERNS = [
  { pattern: /021|Asana Playground|AIPM|cohort|Module \d+/i, repo: '021.School' },
  { pattern: /^lin-cli|^Linear CLI/i, repo: 'lin-cli' },
  { pattern: /MAUI|PDF (Annotation|Viewer)/i, repo: 'MAUI prototype' },
  { pattern: /MiniMax|Gateway Routing|LLM Backend|crawler/i, repo: 'minimax / gateway' },
  { pattern: /EvoSkill/i, repo: 'EvoSkill' },
]

const SKILLSMITH_PROJECT_PATTERNS = [
  /^Skillsmith/i,
  /Dependabot Vulnerability Fixes/i,
  /Stub-to-Real|Tier Feature Gap/i,
  /^Backfill Infrastructure/i,
]

/**
 * Find a merged PR in this repo that references the SMI by either:
 *   - PR title containing `SMI-NNNN`
 *   - PR body containing `SMI-NNNN`
 *
 * If found but the audit reported no source commit, the work shipped under
 * that PR but the squash-merge commit message likely lacked the SMI token.
 * Treat as commit-without-token (allowlist with PR ref for audit trail).
 */
function findCommitWithoutToken(smi, ghToken) {
  const num = smi.replace('SMI-', '')
  try {
    const env = { ...process.env }
    if (ghToken) env.GH_TOKEN = ghToken
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        'smith-horn/skillsmith',
        '--state',
        'merged',
        '--search',
        `SMI-${num} in:title,body`,
        '--limit',
        '1',
        '--json',
        'number,title,mergeCommit,mergedAt',
      ],
      { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const prs = JSON.parse(out || '[]')
    if (prs.length > 0) {
      return {
        prNumber: prs[0].number,
        prTitle: prs[0].title,
        mergeCommit: prs[0].mergeCommit?.oid?.substring(0, 7) ?? null,
        mergedAt: prs[0].mergedAt,
      }
    }
  } catch {
    // gh search failure → null (no commit found)
  }
  return null
}

/**
 * Classify a single drift entry.
 */
function classifyEntry(entry, ghToken, linearKey) {
  const { id, title } = entry

  // 1. external-repo — title keywords win regardless of any local commits.
  for (const { pattern, repo } of EXTERNAL_REPO_PATTERNS) {
    if (pattern.test(title)) {
      return { bucket: 'external-repo', external_repo: repo, signal: 'title' }
    }
  }

  // 2. Linear initiative lookup — most reliable bucket. The Skillsmith
  //    initiative groups all Skillsmith projects regardless of name; any
  //    issue NOT in the Skillsmith initiative belongs to a sibling
  //    project (021.School, lin-cli, MAUI, minimax). Skip with
  //    TRIAGE_NO_LINEAR=1.
  if (!process.env.TRIAGE_NO_LINEAR && linearKey) {
    const meta = fetchLinearProject(id, linearKey)
    if (meta && meta.initiative) {
      const isSkillsmith = /^Skillsmith$/i.test(meta.initiative)
      if (!isSkillsmith) {
        // Initiative-level external — strongest signal.
        for (const { pattern, repo } of EXTERNAL_PROJECT_PATTERNS) {
          if (pattern.test(meta.initiative) || pattern.test(meta.project)) {
            return {
              bucket: 'external-repo',
              external_repo: repo,
              initiative: meta.initiative,
              project: meta.project,
              signal: 'linear-initiative',
            }
          }
        }
        return {
          bucket: 'external-repo',
          external_repo: meta.initiative,
          initiative: meta.initiative,
          project: meta.project,
          signal: 'linear-initiative',
        }
      }
      // Skillsmith initiative — fall through to wave-subtask / docs / etc.
      // Stash project for later context.
    }
  }

  // 3. docs-only — title keywords.
  if (DOCS_ONLY_PATTERNS.some((p) => p.test(title))) {
    return { bucket: 'docs-only' }
  }

  // 4. wave-subtask — Wave N / WN.M / scoped conventional commit. Likely
  //    shipped under a parent PR whose title referenced only the parent.
  if (WAVE_SUBTASK_PATTERNS.some((p) => p.test(title))) {
    return { bucket: 'wave-subtask' }
  }

  // 5. manual-op — title keywords.
  if (MANUAL_OP_PATTERNS.some((p) => p.test(title))) {
    return { bucket: 'manual-op' }
  }

  // 5. commit-without-token — gh search for PR referencing this SMI in
  //    title or body. The audit's pr-search would have already classified
  //    these as 'verified' in most cases; we only land here if neither
  //    git log nor PR title/body referenced the SMI. In practice, these
  //    are rare — usually parent-issue PRs that didn't enumerate every
  //    child SMI by number. Optional and slow (one gh call per entry);
  //    skip with TRIAGE_NO_GH=1.
  if (!process.env.TRIAGE_NO_GH) {
    const commit = findCommitWithoutToken(id, ghToken)
    if (commit) {
      return { bucket: 'commit-without-token', ...commit }
    }
  }

  // 6. genuine-drift — fallback. Maintainer must triage individually.
  return { bucket: 'genuine-drift' }
}

// --- Main ---

function main() {
  const inputPath = process.argv[2] || '/tmp/drift-results.json'
  const data = readJson(inputPath)

  const driftEntries = data.drift ?? []
  if (driftEntries.length === 0) {
    console.log('No drift entries to triage.')
    return
  }

  const ghToken = process.env.GH_TOKEN || ''
  const linearKey = process.env.LINEAR_API_KEY || ''

  console.error(`Triaging ${driftEntries.length} drift entries...`)
  if (linearKey && !process.env.TRIAGE_NO_LINEAR) {
    console.error('  Linear project lookup: ENABLED')
  } else {
    console.error('  Linear project lookup: disabled (set LINEAR_API_KEY or unset TRIAGE_NO_LINEAR)')
  }

  const buckets = {
    'external-repo': [],
    'docs-only': [],
    'wave-subtask': [],
    'manual-op': [],
    'commit-without-token': [],
    'genuine-drift': [],
  }

  for (let i = 0; i < driftEntries.length; i++) {
    const entry = driftEntries[i]
    if (i % 25 === 0) console.error(`  [${i}/${driftEntries.length}] processing...`)
    const classification = classifyEntry(entry, ghToken, linearKey)
    buckets[classification.bucket].push({ ...entry, ...classification })
  }

  // Write buckets file.
  writeFileSync(OUTPUT_PATH, JSON.stringify(buckets, null, 2) + '\n')

  // Stdout summary.
  console.log('')
  console.log('Bucket counts:')
  for (const [bucket, entries] of Object.entries(buckets)) {
    console.log(`  ${bucket.padEnd(22, ' ')} ${entries.length}`)
  }
  console.log('')
  console.log(`Total drift entries:       ${driftEntries.length}`)
  console.log(`Genuine-drift threshold:   ${ESCALATION_THRESHOLD}`)
  console.log(`Output:                    ${OUTPUT_PATH}`)

  if (buckets['genuine-drift'].length > ESCALATION_THRESHOLD) {
    console.log('')
    console.log(`⚠ Escalation: ${buckets['genuine-drift'].length} genuine-drift entries exceed threshold ${ESCALATION_THRESHOLD}.`)
    console.log('Re-bucket or revisit triage rules before opening the allowlist PR.')
    process.exit(2)
  }
}

main()
