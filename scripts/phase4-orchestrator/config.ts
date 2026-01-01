/**
 * Phase 4 Orchestrator Configuration
 *
 * Defines epics, specialists, and orchestration settings for
 * automated Phase 4 execution via claude-flow hive mind.
 */

export interface SubIssue {
  title: string
  specialist: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  dependencies?: string[]
  description: string
}

export interface Epic {
  id: string
  title: string
  linearId?: string
  subIssues: SubIssue[]
}

export interface CodeReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low'
  category: 'architecture' | 'security' | 'testing' | 'style'
  title: string
  description: string
  file?: string
  line?: number
  suggestedFix?: string
}

export interface OrchestratorConfig {
  projectId: string
  teamId: string
  initiativeId: string
  skillsmithPath: string
  memoryNamespace: string
  maxAgentsPerEpic: number
  sessionTimeout: number
  blockingPriorities: ('critical' | 'high')[]
}

// Safe parseInt with fallback for NaN values
const parseIntSafe = (value: string | undefined, defaultVal: number): number => {
  if (!value) return defaultVal
  const parsed = parseInt(value, 10)
  return isNaN(parsed) ? defaultVal : parsed
}

// Phase 4 Project and Team IDs from Linear
// Configuration is now portable via environment variables
export const CONFIG: OrchestratorConfig = {
  projectId: process.env.LINEAR_PROJECT_ID || 'f37e5fae-05da-467e-a9f7-ec4481ae5a61',
  teamId: process.env.LINEAR_TEAM_ID || '6795e794-99cc-4cf3-974f-6630c55f037d',
  initiativeId: process.env.LINEAR_INITIATIVE_ID || '5e1cebfe-f4bb-42c1-988d-af792fc4253b',
  skillsmithPath: process.env.SKILLSMITH_PATH || process.cwd(),
  memoryNamespace: process.env.PHASE4_NAMESPACE || 'phase4-orchestrator',
  maxAgentsPerEpic: parseIntSafe(process.env.MAX_AGENTS_PER_EPIC, 6),
  sessionTimeout: parseIntSafe(process.env.SESSION_TIMEOUT, 1800000), // 30 minutes per epic
  blockingPriorities: ['critical', 'high'],
}

// Specialist agent types mapped to Linear labels
export const SPECIALISTS: Record<string, { type: string; capabilities: string[] }> = {
  'UX Researcher': {
    type: 'researcher',
    capabilities: ['user-research', 'interviews', 'synthesis', 'personas'],
  },
  'Behavioral Designer': {
    type: 'analyst',
    capabilities: ['ux-design', 'behavioral-patterns', 'flow-design', 'psychology'],
  },
  'Data Scientist': {
    type: 'analyst',
    capabilities: ['ml-models', 'data-analysis', 'metrics', 'experimentation'],
  },
  'MCP Specialist': {
    type: 'coder',
    capabilities: ['mcp-protocol', 'typescript', 'server-development', 'api-design'],
  },
  'Backend Specialist': {
    type: 'coder',
    capabilities: ['nodejs', 'typescript', 'databases', 'api-development'],
  },
  'Frontend Specialist': {
    type: 'coder',
    capabilities: ['react', 'typescript', 'ui-components', 'accessibility'],
  },
  'Security Specialist': {
    type: 'reviewer',
    capabilities: ['security-review', 'vulnerability-assessment', 'threat-modeling'],
  },
}

// Phase 4 Epics with sub-issues
export const EPICS: Epic[] = [
  {
    id: 'epic-1-contextual-recommendations',
    title: '[EPIC] Contextual Recommendations - Skills Find Users',
    subIssues: [
      {
        title: 'Design Trigger System Architecture',
        specialist: 'MCP Specialist',
        priority: 'critical',
        description: `Design the architecture for detecting user context and triggering skill recommendations.

Key deliverables:
- Trigger types (file patterns, commands, errors, project structure)
- Context scoring algorithm
- Integration points with existing CodebaseAnalyzer
- Event flow diagrams`,
      },
      {
        title: 'Implement MCP Skill Suggestion Protocol',
        specialist: 'MCP Specialist',
        priority: 'critical',
        dependencies: ['Design Trigger System Architecture'],
        description: `Implement MCP protocol extension for push-based skill suggestions.

Key deliverables:
- skill_suggest MCP tool implementation
- Rate limiting (max 1 per 5 min)
- Client notification mechanism
- Accept/dismiss action handlers`,
      },
      {
        title: 'Design Non-Intrusive Surfacing UX',
        specialist: 'Behavioral Designer',
        priority: 'high',
        description: `Design UX patterns for surfacing suggestions without interrupting flow.

Key deliverables:
- UX mockups for CLI presentation
- Interaction flow diagrams
- Accessibility requirements
- User testing protocol`,
      },
      {
        title: 'Implement One-Click Skill Activation',
        specialist: 'MCP Specialist',
        priority: 'high',
        dependencies: ['Implement MCP Skill Suggestion Protocol'],
        description: `Enable instant skill activation with zero configuration.

Key deliverables:
- Pre-validation during recommendation
- Background skill prefetch
- Hot-reload activation (no restart)
- Undo/rollback infrastructure`,
      },
      {
        title: 'Build Recommendation Learning Loop',
        specialist: 'Data Scientist',
        priority: 'medium',
        dependencies: ['Implement One-Click Skill Activation'],
        description: `Implement learning from accept/dismiss signals.

Key deliverables:
- Signal collection (accept/dismiss/usage)
- Per-user preference model
- Privacy-preserving storage
- Recommendation weight adjustment`,
      },
    ],
  },
  {
    id: 'epic-2-quick-wins-onboarding',
    title: '[EPIC] Quick Wins Onboarding - First Value in 60 Seconds',
    subIssues: [
      {
        title: 'Curate First-Impression Skill Collection',
        specialist: 'UX Researcher',
        priority: 'critical',
        description: `Identify skills that deliver instant, visible value.

Key deliverables:
- Curated list of 5-10 first-impression skills
- Ranking by onboarding effectiveness
- User testing validation
- Default suggestion strategy`,
      },
      {
        title: 'Implement Zero-Config Skill Activation',
        specialist: 'MCP Specialist',
        priority: 'critical',
        dependencies: ['Curate First-Impression Skill Collection'],
        description: `Enable skills to work immediately with sensible defaults.

Key deliverables:
- Quick-start skill schema extension
- Default value injection system
- Hot-reload activation mechanism
- Configuration deferral system`,
      },
      {
        title: 'Design Contextual Welcome Experience',
        specialist: 'Behavioral Designer',
        priority: 'high',
        dependencies: ['Curate First-Impression Skill Collection'],
        description: `Create welcoming first experience based on project detection.

Key deliverables:
- Project analyzer integration
- Skill-to-context matching rules
- Welcome message templates
- Response tracking for learning`,
      },
      {
        title: 'Build Instant Value Feedback',
        specialist: 'Behavioral Designer',
        priority: 'high',
        dependencies: ['Implement Zero-Config Skill Activation'],
        description: `Ensure users see value immediately after activation.

Key deliverables:
- Activation confirmation messages
- First-use detection system
- Example prompt suggestions
- Value attribution display`,
      },
    ],
  },
  {
    id: 'epic-3-attribution-during-use',
    title: '[EPIC] Attribution During Use - Making Value Visible',
    subIssues: [
      {
        title: 'Design Skill Attribution System',
        specialist: 'Behavioral Designer',
        priority: 'high',
        description: `Create subtle attribution for skill-generated outputs.

Key deliverables:
- Attribution modes (inline, metadata, session)
- Design requirements document
- Privacy considerations
- User toggle mechanism`,
      },
      {
        title: 'Implement Skill Usage Analytics',
        specialist: 'Backend Specialist',
        priority: 'high',
        dependencies: ['Design Skill Attribution System'],
        description: `Track skill usage locally for value visibility.

Key deliverables:
- Local SQLite analytics storage
- Usage tracking API
- 30-day rolling window
- Export functionality`,
      },
      {
        title: 'Build Value Summary Reports',
        specialist: 'Behavioral Designer',
        priority: 'medium',
        dependencies: ['Implement Skill Usage Analytics'],
        description: `Generate periodic value reports.

Key deliverables:
- Weekly digest generation
- Monthly summary reports
- On-demand stats query
- Value estimation algorithms`,
      },
      {
        title: 'Implement Milestone Celebrations',
        specialist: 'Behavioral Designer',
        priority: 'low',
        dependencies: ['Implement Skill Usage Analytics'],
        description: `Create celebration moments for user milestones.

Key deliverables:
- 5+ milestone types
- Non-intrusive celebration UI
- Opt-out mechanism
- Frequency controls`,
      },
    ],
  },
  {
    id: 'epic-4-proof-of-value',
    title: '[EPIC] Proof of Value - ROI Validation',
    subIssues: [
      {
        title: 'Design Value Measurement Framework',
        specialist: 'UX Researcher',
        priority: 'high',
        description: `Define rigorous framework for measuring skill value.

Key deliverables:
- Value dimensions definition
- Measurement methods selection
- Bias mitigation plan
- Framework documentation`,
      },
      {
        title: 'Implement A/B Testing Infrastructure',
        specialist: 'Backend Specialist',
        priority: 'medium',
        dependencies: ['Design Value Measurement Framework'],
        description: `Build infrastructure for controlled experiments.

Key deliverables:
- Experiment assignment system
- Outcome tracking
- Basic analysis dashboard
- Pilot experiment`,
      },
      {
        title: 'Conduct User Value Studies',
        specialist: 'UX Researcher',
        priority: 'medium',
        dependencies: ['Design Value Measurement Framework'],
        description: `Qualitative research on value perception.

Key deliverables:
- 20+ user interviews
- Synthesis report
- Updated personas
- Improvement backlog`,
      },
      {
        title: 'Build ROI Dashboard',
        specialist: 'Backend Specialist',
        priority: 'low',
        dependencies: ['Implement A/B Testing Infrastructure', 'Conduct User Value Studies'],
        description: `Dashboard demonstrating Skillsmith ROI.

Key deliverables:
- User ROI view
- Stakeholder aggregate view
- Automated data refresh
- Export to PDF/CSV`,
      },
    ],
  },
]

// Code review focus areas
export const CODE_REVIEW_FOCUS = {
  architecture: {
    patterns: [
      'Follows existing Skillsmith patterns',
      'Proper separation of concerns',
      'Integration with existing modules',
      'No circular dependencies',
    ],
    files: ['packages/core/src/**/*.ts', 'packages/mcp-server/src/**/*.ts'],
  },
  security: {
    patterns: [
      'No hardcoded secrets',
      'Input validation present',
      'Rate limiting where appropriate',
      'Privacy-preserving data handling',
    ],
    reference: 'packages/core/src/security/scanner.ts',
  },
  testing: {
    minCoverage: 80,
    requiredTests: ['unit', 'integration'],
    patterns: ['packages/*/tests/**/*.test.ts'],
  },
}
