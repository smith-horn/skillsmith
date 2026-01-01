/**
 * Linear Sync Module
 *
 * Handles all Linear API interactions for Phase 4 orchestration:
 * - Project updates (before/after each epic)
 * - Issue creation and status updates
 * - Sub-issue management
 */

import { LinearClient } from '@linear/sdk'
import { CONFIG, Epic, CodeReviewFinding } from './config.js'

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  state: string
  priority: number
}

export interface ProjectUpdate {
  health: 'onTrack' | 'atRisk' | 'offTrack'
  body: string
}

export class LinearSync {
  private client: LinearClient
  private stateCache: Map<string, string> = new Map()

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('LINEAR_API_KEY is required')
    }
    this.client = new LinearClient({ apiKey })
  }

  /**
   * Initialize state cache for workflow states
   */
  async initialize(): Promise<void> {
    const states = await this.client.workflowStates({
      filter: { team: { id: { eq: CONFIG.teamId } } },
    })

    for (const state of states.nodes) {
      this.stateCache.set(state.name.toLowerCase(), state.id)
    }

    console.log(`[Linear] Initialized with ${this.stateCache.size} workflow states`)
  }

  /**
   * Get state ID by name
   */
  private getStateId(stateName: string): string {
    const id = this.stateCache.get(stateName.toLowerCase())
    if (!id) {
      throw new Error(`Unknown state: ${stateName}`)
    }
    return id
  }

  /**
   * Fetch all Phase 4 epics from Linear
   */
  async fetchPhase4Epics(): Promise<LinearIssue[]> {
    const issues = await this.client.issues({
      filter: {
        project: { id: { eq: CONFIG.projectId } },
        title: { contains: '[EPIC]' },
      },
    })

    return issues.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name || 'Unknown',
      priority: issue.priority || 0,
    }))
  }

  /**
   * Fetch sub-issues for an epic
   */
  async fetchSubIssues(parentId: string): Promise<LinearIssue[]> {
    const issues = await this.client.issues({
      filter: {
        parent: { id: { eq: parentId } },
      },
    })

    return issues.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name || 'Unknown',
      priority: issue.priority || 0,
    }))
  }

  /**
   * Update issue state
   */
  async updateIssueState(
    issueId: string,
    state: 'backlog' | 'in progress' | 'done' | 'canceled'
  ): Promise<void> {
    const stateId = this.getStateId(state)
    await this.client.updateIssue(issueId, { stateId })
    console.log(`[Linear] Updated issue ${issueId} to ${state}`)
  }

  /**
   * Create a project update
   */
  async createProjectUpdate(update: ProjectUpdate): Promise<string> {
    const result = await this.client.createProjectUpdate({
      projectId: CONFIG.projectId,
      health: update.health,
      body: update.body,
    })

    const updateId = result.projectUpdate?.id || 'unknown'
    console.log(`[Linear] Created project update: ${updateId}`)
    return updateId
  }

  /**
   * Create epic start update
   */
  async createEpicStartUpdate(epic: Epic, epicNumber: number): Promise<void> {
    const body = `## 🚀 Epic ${epicNumber}/4 Started: ${epic.title}

### Status
Starting automated execution via claude-flow hive mind.

### Sub-Issues to Execute
${epic.subIssues.map((s, i) => `${i + 1}. **${s.title}** (${s.specialist}) - ${s.priority}`).join('\n')}

### Execution Plan
- Agents: ${[...new Set(epic.subIssues.map((s) => s.specialist))].join(', ')}
- Strategy: Sequential with dependency resolution
- Session: Isolated context with memory persistence

---
*Automated update from Phase 4 Orchestrator*`

    await this.createProjectUpdate({ health: 'onTrack', body })
  }

  /**
   * Create epic completion update
   */
  async createEpicCompletionUpdate(
    epic: Epic,
    epicNumber: number,
    codeReviewFindings: CodeReviewFinding[],
    blockers: CodeReviewFinding[]
  ): Promise<void> {
    const criticalCount = codeReviewFindings.filter((f) => f.severity === 'critical').length
    const highCount = codeReviewFindings.filter((f) => f.severity === 'high').length
    const mediumCount = codeReviewFindings.filter((f) => f.severity === 'medium').length
    const lowCount = codeReviewFindings.filter((f) => f.severity === 'low').length

    const health = blockers.length > 0 ? 'atRisk' : 'onTrack'

    const body = `## ✅ Epic ${epicNumber}/4 Completed: ${epic.title}

### Code Review Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | ${criticalCount} |
| 🟠 High | ${highCount} |
| 🟡 Medium | ${mediumCount} |
| 🟢 Low | ${lowCount} |

### Blocking Issues
${blockers.length > 0 ? blockers.map((b) => `- **${b.title}** (${b.severity}): ${b.description}`).join('\n') : '_None - proceeding to next epic_'}

### Sub-Issues Completed
${epic.subIssues.map((s) => `- ✅ ${s.title}`).join('\n')}

### Memory Keys Stored
- \`phase4/${epic.id}/decisions\`
- \`phase4/${epic.id}/artifacts\`
- \`phase4/${epic.id}/review\`

---
*Automated update from Phase 4 Orchestrator*`

    await this.createProjectUpdate({ health, body })
  }

  /**
   * Create issue from code review finding
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createCodeReviewIssue(finding: CodeReviewFinding, _epicId: string): Promise<string> {
    const priorityMap = { critical: 1, high: 2, medium: 3, low: 4 }
    const categoryLabels: Record<string, string> = {
      architecture: 'Architecture',
      security: 'Security',
      testing: 'Testing',
      style: 'Code Style',
    }

    const description = `## Code Review Finding

**Category:** ${categoryLabels[finding.category]}
**Severity:** ${finding.severity.toUpperCase()}
${finding.file ? `**File:** \`${finding.file}\`${finding.line ? `:${finding.line}` : ''}` : ''}

### Description
${finding.description}

${finding.suggestedFix ? `### Suggested Fix\n${finding.suggestedFix}` : ''}

---
*Auto-generated from Phase 4 code review*`

    const result = await this.client.createIssue({
      teamId: CONFIG.teamId,
      projectId: CONFIG.projectId,
      title: `[Code Review] ${finding.title}`,
      description,
      priority: priorityMap[finding.severity],
    })

    const identifier = result.issue?.identifier || 'unknown'
    console.log(`[Linear] Created code review issue: ${identifier}`)
    return identifier
  }

  /**
   * Create sub-issue under a parent
   */
  async createSubIssue(
    parentId: string,
    title: string,
    description: string,
    priority: 'critical' | 'high' | 'medium' | 'low'
  ): Promise<string> {
    const priorityMap = { critical: 1, high: 2, medium: 3, low: 4 }

    const result = await this.client.createIssue({
      teamId: CONFIG.teamId,
      projectId: CONFIG.projectId,
      parentId,
      title,
      description,
      priority: priorityMap[priority],
    })

    const identifier = result.issue?.identifier || 'unknown'
    console.log(`[Linear] Created sub-issue: ${identifier}`)
    return identifier
  }

  /**
   * Create final Phase 4 summary
   */
  async createPhaseSummary(
    completedEpics: number,
    totalIssuesCreated: number,
    totalFindings: number,
    blockerCount: number
  ): Promise<void> {
    const health = blockerCount > 0 ? 'atRisk' : 'onTrack'

    const body = `## 🏁 Phase 4 Execution Complete

### Summary
| Metric | Value |
|--------|-------|
| Epics Completed | ${completedEpics}/4 |
| Issues Created | ${totalIssuesCreated} |
| Code Review Findings | ${totalFindings} |
| Blocking Issues | ${blockerCount} |

### Next Steps
${blockerCount > 0 ? '⚠️ **Blocking issues require manual resolution before Phase 5**' : '✅ **Ready to proceed to Phase 5: Release & Publishing**'}

### Memory Store
All decisions, artifacts, and review findings persisted in:
- Namespace: \`${CONFIG.memoryNamespace}\`
- Keys: \`phase4/epic-*/decisions\`, \`phase4/epic-*/artifacts\`

### Documentation Generated
- Architecture decision records
- Implementation specs
- Test coverage reports

---
*Phase 4 Orchestrator completed at ${new Date().toISOString()}*`

    await this.createProjectUpdate({ health, body })
  }
}

export async function createLinearSync(): Promise<LinearSync> {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is required')
  }

  const sync = new LinearSync(apiKey)
  await sync.initialize()
  return sync
}
