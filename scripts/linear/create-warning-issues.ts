#!/usr/bin/env npx tsx
/**
 * SMI-1179: Create Linear issues for code review warnings
 *
 * Creates issues in the Skillsmith Phase 6 project for all warnings found
 * during code review.
 */

import { LinearClient } from '@linear/sdk'
import * as fs from 'fs'
import * as path from 'path'

// Load environment
function loadEnv(): void {
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value.trim()
        }
      }
    }
  }
}

loadEnv()

const apiKey = process.env.LINEAR_API_KEY
if (!apiKey) {
  console.error('LINEAR_API_KEY not set')
  process.exit(1)
}

const client = new LinearClient({ apiKey })

interface WarningIssue {
  title: string
  description: string
  priority: number // 1=urgent, 2=high, 3=medium, 4=low
  labels?: string[]
}

// Define all warning issues to create
const warnings: WarningIssue[] = [
  // Type Safety Issues
  {
    title: 'Fix any types in AnalyticsRepository.ts',
    description: `## Problem
Found \`any\` types in \`packages/core/src/analytics/AnalyticsRepository.ts\` at lines 72, 99, 124.

## Solution
Replace \`any\` with proper types or \`unknown\` for external data.

## Files
- \`packages/core/src/analytics/AnalyticsRepository.ts\`

## Acceptance Criteria
- [ ] No \`any\` types remain in file
- [ ] TypeScript strict mode passes
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'type-safety']
  },
  {
    title: 'Fix any types in CSP middleware',
    description: `## Problem
Found \`any\` types in CSP middleware files.

## Files
- \`packages/mcp-server/src/middleware/csp.ts\` (lines 294)
- \`packages/mcp-server/src/middleware/__tests__/csp.test.ts\` (lines 156-158, 271-273)

## Solution
Add proper type definitions for CSP validation results.

## Acceptance Criteria
- [ ] No \`any\` types remain
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'type-safety']
  },
  // File Length Issues - Group by package
  {
    title: 'Split large files in @skillsmith/core (10 files > 500 lines)',
    description: `## Problem
The following files in \`packages/core/src\` exceed 500 lines:

| File | Lines |
|------|-------|
| \`analysis/CodebaseAnalyzer.ts\` | 707 |
| \`scripts/validate-skills.ts\` | 775 |
| \`scripts/import-github-skills.ts\` | 757 |
| \`security/RateLimiter.ts\` | 995 |
| \`security/scanner.ts\` | 749 |
| \`repositories/QuarantineRepository.ts\` | 681 |
| \`benchmarks/BenchmarkRunner.ts\` | 697 |
| \`benchmarks/MemoryProfiler.ts\` | 595 |
| \`session/SessionHealthMonitor.ts\` | 558 |
| \`scripts/scan-imported-skills.ts\` | 558 |

## Solution
Split into smaller, focused modules (<500 lines each).

## Acceptance Criteria
- [ ] All files under 500 lines
- [ ] No breaking changes to public API
- [ ] Tests pass`,
    priority: 3,
    labels: ['tech-debt', 'refactor']
  },
  {
    title: 'Split large files in @skillsmith/core utilities (7 files > 500 lines)',
    description: `## Problem
Additional large files in \`packages/core/src\`:

| File | Lines |
|------|-------|
| \`embeddings/index.ts\` | 506 |
| \`pipeline/DailyIndexPipeline.ts\` | 534 |
| \`security/AuditLogger.ts\` | 575 |
| \`session/SessionManager.ts\` | 545 |
| \`telemetry/metrics.ts\` | 532 |
| \`telemetry/tracer.ts\` | 531 |
| \`triggers/TriggerDetector.ts\` | 533 |

## Solution
Extract helper functions and types into separate files.

## Acceptance Criteria
- [ ] All files under 500 lines
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'refactor']
  },
  {
    title: 'Split large files in @skillsmith/core webhooks & validation',
    description: `## Problem
Large files in webhooks and validation:

| File | Lines |
|------|-------|
| \`validation/index.ts\` | 543 |
| \`webhooks/WebhookPayload.ts\` | 501 |
| \`webhooks/WebhookQueue.ts\` | 555 |

## Solution
Split validation schemas and webhook handlers.

## Acceptance Criteria
- [ ] All files under 500 lines
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'refactor']
  },
  {
    title: 'Split large files in @skillsmith/enterprise (4 files > 500 lines)',
    description: `## Problem
Large files in \`packages/enterprise/src\`:

| File | Lines |
|------|-------|
| \`audit/AuditEventTypes.ts\` | 811 |
| \`audit/AuditLogger.ts\` | 561 |
| \`audit/exporters/CloudWatchExporter.ts\` | 587 |
| \`license/GracefulDegradation.ts\` | 502 |

## Solution
Split audit event types into categories, extract exporter base class.

## Acceptance Criteria
- [ ] All files under 500 lines
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'refactor']
  },
  {
    title: 'Split large files in @skillsmith/mcp-server (4 files > 500 lines)',
    description: `## Problem
Large files in \`packages/mcp-server\`:

| File | Lines |
|------|-------|
| \`src/tools/compare.ts\` | 646 |
| \`src/tools/validate.ts\` | 577 |
| \`src/webhooks/webhook-endpoint.ts\` | 511 |
| \`tests/integration/fixtures/test-skills.ts\` | 675 |

## Solution
Extract comparison logic, validation rules, and test fixtures.

## Acceptance Criteria
- [ ] All files under 500 lines
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'refactor']
  },
  {
    title: 'Split SkillDetailPanel.ts in VS Code extension',
    description: `## Problem
\`packages/vscode-extension/src/views/SkillDetailPanel.ts\` has 607 lines.

## Solution
Extract webview HTML generation and message handlers.

## Acceptance Criteria
- [ ] File under 500 lines
- [ ] Extension functionality unchanged
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'refactor']
  },
  // Docker Compliance
  {
    title: 'Update scripts to use Docker for npm commands',
    description: `## Problem
4 scripts use local npm commands instead of Docker:

- \`scripts/run-benchmarks.sh\`
- \`scripts/run-phase2e-swarm.sh\`
- \`scripts/run-security-swarm.sh\`

## Solution
Update to use \`docker exec skillsmith-dev-1 npm ...\`

## Acceptance Criteria
- [ ] All scripts use Docker commands
- [ ] Scripts work correctly in Docker
- [ ] Documentation updated`,
    priority: 3,
    labels: ['tech-debt', 'docker']
  },
  // Unused Variables (from lint)
  {
    title: 'Fix unused variables in mcp-server tests',
    description: `## Problem
Multiple unused variables in test files:

| File | Variable |
|------|----------|
| \`middleware/degradation.ts\` | currentTier, validationResult |
| \`tools/suggest.ts\` | RATE_LIMIT_PRESETS |
| \`webhooks/webhook-endpoint.ts\` | error |
| \`tests/integration/setup.ts\` | TEST_SKILLS, TEST_SKILLS_STATS |
| \`tests/onboarding/first-run.test.ts\` | TEST_MARKER, originalSkillsmithDir, originalMarkerFile |
| \`tests/webhooks/*.test.ts\` | vi, RateLimiterState |

## Solution
Either use the variables or prefix with \`_\` to indicate intentionally unused.

## Acceptance Criteria
- [ ] No unused variable warnings
- [ ] Tests pass`,
    priority: 4,
    labels: ['tech-debt', 'lint']
  }
]

async function main() {
  console.log('🔍 Finding Skillsmith Phase 6 project...\n')

  // Get team
  const teams = await client.teams()
  const team = teams.nodes.find(t => t.key === 'SMI')
  if (!team) {
    console.error('Team SMI not found')
    process.exit(1)
  }
  console.log(`Team: ${team.name} (${team.key})`)

  // Get projects
  const projects = await client.projects({
    filter: { name: { containsIgnoreCase: 'phase 6' } }
  })

  let project = projects.nodes[0]
  if (!project) {
    // Try broader search
    const allProjects = await client.projects()
    project = allProjects.nodes.find(p =>
      p.name.toLowerCase().includes('phase 6') ||
      p.name.toLowerCase().includes('skillsmith')
    )
  }

  if (!project) {
    console.log('\nNo Phase 6 project found. Creating one...')
    const newProject = await client.createProject({
      name: 'Skillsmith Phase 6: Production Deployment',
      teamIds: [team.id],
      description: 'Deploy Skillsmith to production with Supabase, Vercel, and enterprise features.'
    })
    project = (await newProject.project) as typeof project
  }

  console.log(`Project: ${project.name}`)
  console.log(`Project ID: ${project.id}\n`)

  // Get or create labels
  const labelsResult = await client.issueLabels()
  const existingLabels = new Map(labelsResult.nodes.map(l => [l.name, l.id]))

  const neededLabels = ['tech-debt', 'type-safety', 'refactor', 'docker', 'lint']
  for (const labelName of neededLabels) {
    if (!existingLabels.has(labelName)) {
      console.log(`Creating label: ${labelName}`)
      const result = await client.createIssueLabel({
        name: labelName,
        teamId: team.id
      })
      const label = await result.issueLabel
      if (label) {
        existingLabels.set(labelName, label.id)
      }
    }
  }

  // Create issues
  console.log(`\n📝 Creating ${warnings.length} issues...\n`)

  const createdIssues: string[] = []

  for (const warning of warnings) {
    const labelIds = (warning.labels || [])
      .map(name => existingLabels.get(name))
      .filter((id): id is string => !!id)

    try {
      const result = await client.createIssue({
        title: warning.title,
        description: warning.description,
        teamId: team.id,
        projectId: project.id,
        priority: warning.priority,
        labelIds
      })

      const issue = await result.issue
      if (issue) {
        console.log(`✅ ${issue.identifier}: ${warning.title}`)
        createdIssues.push(issue.identifier)
      }
    } catch (error) {
      console.error(`❌ Failed to create: ${warning.title}`)
      console.error(error)
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Created ${createdIssues.length}/${warnings.length} issues`)
  console.log(`\nIssues: ${createdIssues.join(', ')}`)
  console.log(`\nView in Linear: https://linear.app/smith-horn-group/project/${project.id}`)
}

main().catch(console.error)
