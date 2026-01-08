# MCP Tool Definitions

> **Navigation**: [API Index](./index.md) | [Technical Index](../index.md) | [Error Handling](./error-handling.md)

---

## discovery-core Tools

### search

Search the skill index for skills matching a query.

```typescript
interface SearchTool {
  name: 'search';
  description: 'Search the skill index for skills matching a query';
  parameters: {
    query: string;            // Required: search query
    filters?: {
      categories?: string[];
      technologies?: string[];
      trust_tier?: TrustTier[];
      min_score?: number;
    };
    limit?: number;           // Default: 10, max: 50
    offset?: number;          // For pagination
  };
  returns: {
    results: SkillSummary[];
    total: number;
    has_more: boolean;
  };
}
```

#### Example

```json
// Request
{
  "query": "react testing",
  "filters": {
    "trust_tier": ["official", "verified"],
    "min_score": 0.5
  },
  "limit": 10
}

// Response
{
  "success": true,
  "data": {
    "results": [
      {
        "id": "anthropic/skills/react-testing",
        "name": "react-testing",
        "description": "Best practices for testing React components",
        "trust_tier": "official",
        "final_score": 0.92,
        "stars": 1234
      }
    ],
    "total": 45,
    "has_more": true
  }
}
```

---

### get_skill

Get detailed information about a specific skill.

```typescript
interface GetSkillTool {
  name: 'get_skill';
  description: 'Get detailed information about a specific skill';
  parameters: {
    id: string;               // Skill ID (e.g., "anthropic/skills/test-fixing")
  };
  returns: SkillDetail;
}

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  author: string;
  repo_url: string;

  // Metrics
  stars: number;
  forks: number;
  downloads?: number;

  // Scores
  quality_score: number;
  popularity_score: number;
  maintenance_score: number;
  final_score: number;

  // Trust
  trust_tier: TrustTier;
  security_scan_status: string;

  // Content
  readme_excerpt: string;
  skillmd_content?: string;

  // Categories
  categories: string[];
  technologies: string[];

  // Dates
  created_at: string;
  updated_at: string;
  indexed_at: string;
}
```

---

### analyze_codebase

Analyze a codebase to detect technology stack.

```typescript
interface AnalyzeCodebaseTool {
  name: 'analyze_codebase';
  description: 'Analyze a codebase to detect technology stack and recommend skills';
  parameters: {
    path: string;             // Path to analyze (default: ".")
    depth?: number;           // How deep to scan (default: 3)
  };
  returns: CodebaseAnalysis;
}

interface CodebaseAnalysis {
  path: string;
  scanned_at: string;

  stack: TechStackItem[];
  project_info: {
    name?: string;
    description?: string;
    version?: string;
  };

  stats: {
    total_files: number;
    analyzed_files: number;
    skipped_files: number;
    scan_duration_ms: number;
  };
}

interface TechStackItem {
  technology: string;
  confidence: number;
  detected_via: string;
}
```

---

### recommend_skills

Get skill recommendations based on codebase analysis.

```typescript
interface RecommendSkillsTool {
  name: 'recommend_skills';
  description: 'Get skill recommendations based on codebase analysis';
  parameters: {
    path?: string;            // Path to analyze (default: ".")
    max_results?: number;     // Default: 10
    include_reasons?: boolean;// Include explanation for each recommendation
  };
  returns: {
    recommendations: Recommendation[];
    analysis_summary: string;
  };
}

interface Recommendation {
  skill: SkillSummary;
  score: number;
  relevance_score: number;
  quality_score: number;
  match_reasons: string[];
  tech_overlap: string[];
  is_new: boolean;
  is_trending: boolean;
}
```

---

### install_skill

Install a skill from the index.

```typescript
interface InstallSkillTool {
  name: 'install_skill';
  description: 'Install a skill from the index';
  parameters: {
    skill_id: string;
    skip_conflict_check?: boolean;  // Default: false
    skip_security_scan?: boolean;   // Default: false
  };
  returns: InstallResult;
}

interface InstallResult {
  success: boolean;
  skill_id: string;
  installed_path: string;

  // Warnings
  conflicts?: Conflict[];
  security_warnings?: SecurityWarning[];

  // Post-install
  activation_tips?: string[];
}
```

---

### audit_activation

Audit installed skills for activation issues.

```typescript
interface AuditActivationTool {
  name: 'audit_activation';
  description: 'Audit installed skills for activation issues';
  parameters: {
    skill_id?: string;        // Audit specific skill, or all if omitted
    generate_hooks?: boolean; // Generate activation hooks (default: false)
  };
  returns: ActivationAuditReport;
}

interface ActivationAuditReport {
  summary: {
    installed_skills: number;
    likely_to_activate: number;
    at_risk: number;
    critical_issues: number;
  };

  issues: AuditIssue[];
  warnings: AuditWarning[];
  recommendations: string[];

  generated_hooks?: HookConfig;
}

interface AuditIssue {
  severity: 'critical' | 'warning';
  type: string;
  skill_id?: string;
  description: string;
  fix: string;
}
```

---

### check_conflicts

Check for conflicts between installed or proposed skills.

```typescript
interface CheckConflictsTool {
  name: 'check_conflicts';
  description: 'Check for conflicts between installed or proposed skills';
  parameters: {
    skill_ids: string[];      // Skills to check (if empty, checks all installed)
  };
  returns: ConflictReport;
}

interface ConflictReport {
  conflicts: Conflict[];
  warnings: Warning[];
  recommendations: string[];
}

interface Conflict {
  type: 'trigger' | 'output' | 'convention' | 'behavioral';
  severity: 'high' | 'medium' | 'low';
  skills: [string, string];
  description: string;
  resolution_options: string[];
}
```

---

## learning Tools

### get_path

```typescript
interface GetPathTool {
  name: 'get_path';
  description: 'Get learning path details';
  parameters: {
    name: string;
  };
  returns: LearningPath;
}

interface LearningPath {
  id: string;
  name: string;
  description: string;
  skills_covered: string[];
  exercises: ExerciseSummary[];
  estimated_duration: string;
}
```

### next_exercise

```typescript
interface NextExerciseTool {
  name: 'next_exercise';
  description: 'Get the next exercise for the user';
  parameters: {
    path_id?: string;         // Specific path, or continue current
    difficulty?: 'easy' | 'medium' | 'hard';
  };
  returns: Exercise;
}

interface Exercise {
  id: string;
  title: string;
  description: string;
  skills_practiced: string[];
  difficulty: string;
  estimated_time: string;
  instructions: string;
  starter_code?: string;
  hints?: string[];
}
```

### submit_solution

```typescript
interface SubmitSolutionTool {
  name: 'submit_solution';
  description: 'Submit an exercise solution for validation';
  parameters: {
    exercise_id: string;
  };
  returns: ValidationResult;
}

interface ValidationResult {
  passed: boolean;
  score: number;
  feedback: string;
  test_results?: TestResult[];
  next_exercise?: ExerciseSummary;
}
```

---

## sync Tools

### refresh_index

```typescript
interface RefreshIndexTool {
  name: 'refresh_index';
  description: 'Trigger an index refresh';
  parameters: {
    source?: string;          // 'github', 'claude-plugins', 'all'
    full?: boolean;           // Full refresh (default: incremental)
  };
  returns: SyncResult;
}

interface SyncResult {
  status: 'started' | 'completed' | 'failed';
  added: number;
  updated: number;
  removed: number;
  duration_ms: number;
  errors?: string[];
}
```

### get_sync_status

```typescript
interface GetSyncStatusTool {
  name: 'get_sync_status';
  description: 'Get synchronization status';
  parameters: {};
  returns: SyncStatus;
}

interface SyncStatus {
  last_sync: {
    github: string;
    claude_plugins: string;
    skillsmp: string;
  };
  next_scheduled: string;
  index_stats: {
    total_skills: number;
    by_trust_tier: Record<TrustTier, number>;
    by_source: Record<string, number>;
  };
}
```

---

## Related Documentation

- [Error Handling](./error-handling.md) - Error codes and recovery
- [MCP Servers](../components/mcp-servers.md) - Server architecture
- [Performance](../performance.md) - API latency requirements

---

*Next: [Error Handling](./error-handling.md)*
