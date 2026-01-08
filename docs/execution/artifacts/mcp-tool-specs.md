# MCP Tool Specifications

**Version:** 1.0
**Last Updated:** December 26, 2025
**Status:** Design Complete
**Owner:** Technical Architect

---

## Overview

This document provides the complete MCP (Model Context Protocol) tool specifications for the Skillsmith. The system exposes 23 tools across 3 MCP servers:

| Server | Tools | Purpose |
|--------|-------|---------|
| discovery-core | 12 | Skill search, analysis, installation, auditing |
| learning | 6 | Learning paths, exercises, progress tracking |
| sync | 5 | Index synchronization, source health |

---

## Common Types

These types are shared across multiple tools:

```typescript
// ==================================================================
// COMMON TYPES
// ==================================================================

// Trust tier classification
type TrustTier = 'official' | 'verified' | 'community' | 'unverified';

// Standard response wrapper
interface ToolResponse<T> {
  success: boolean;
  data?: T;
  error?: ErrorInfo;
  metadata?: ResponseMetadata;
}

interface ErrorInfo {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  recovery_suggestions?: string[];
}

interface ResponseMetadata {
  execution_time_ms: number;
  cached?: boolean;
  cache_age_seconds?: number;
  index_version?: string;
  request_id?: string;
}

// Skill summary for search results
interface SkillSummary {
  id: string;                        // 'source/author/name' format
  name: string;
  slug: string;
  description: string;
  author: {
    id: string;
    name: string;
    verified: boolean;
  };
  trust_tier: TrustTier;
  quality_score: number;             // 0.0 - 1.0
  github_stars: number;
  categories: string[];
  technologies: string[];
  updated_at: string;                // ISO 8601
  installed?: boolean;
}

// Full skill details
interface SkillDetail extends SkillSummary {
  long_description: string;
  repo_url: string;
  homepage_url?: string;
  current_version: string;
  github_forks: number;
  github_open_issues: number;
  github_license: string;
  has_skill_md: boolean;
  has_tests: boolean;
  has_examples: boolean;
  estimated_char_budget: number;
  security_scan_status: 'passed' | 'warning' | 'failed' | 'pending';
  security_findings?: SecurityFinding[];
  related_skills: string[];
  conflicts_with: string[];
  versions: VersionInfo[];
  readme_excerpt?: string;
}

// Technology stack item
interface TechStackItem {
  technology_id: string;
  name: string;
  type: 'language' | 'framework' | 'tool' | 'platform' | 'library';
  version?: string;
  confidence: number;                // 0.0 - 1.0
  source: 'package_json' | 'requirements' | 'go_mod' | 'cargo_toml' | 'file_extension' | 'inferred';
}

// Skill conflict information
interface Conflict {
  skill_id: string;
  skill_name: string;
  type: 'trigger_overlap' | 'behavioral' | 'file_collision';
  severity: 'blocking' | 'warning' | 'info';
  description: string;
  resolution_options: string[];
}

// Security warning from scan
interface SecurityWarning {
  type: 'external_url' | 'shell_command' | 'file_access' | 'obfuscation' | 'typosquatting';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  file_path?: string;
  line_number?: number;
}

// Character budget impact
interface BudgetImpact {
  current_usage: number;
  skill_size: number;
  projected_usage: number;
  budget_limit: number;
  utilization_percent: number;
  warning?: string;
}
```

---

## Error Codes

All tools use consistent error codes:

```typescript
// ==================================================================
// ERROR CODES
// ==================================================================

type ErrorCode =
  // General errors (1xxx)
  | 'INTERNAL_ERROR'           // 1000 - Unexpected internal error
  | 'INVALID_PARAMETER'        // 1001 - Invalid input parameter
  | 'MISSING_PARAMETER'        // 1002 - Required parameter missing
  | 'TIMEOUT'                  // 1003 - Operation timed out

  // Skill errors (2xxx)
  | 'SKILL_NOT_FOUND'          // 2000 - Skill ID doesn't exist
  | 'SKILL_BLOCKED'            // 2001 - Skill is blocklisted
  | 'SKILL_ALREADY_INSTALLED'  // 2002 - Skill already installed
  | 'SKILL_NOT_INSTALLED'      // 2003 - Skill not installed
  | 'SKILL_INSTALL_FAILED'     // 2004 - Installation failed

  // Security errors (3xxx)
  | 'SECURITY_SCAN_FAILED'     // 3000 - Security scan failed
  | 'SECURITY_RISK_DETECTED'   // 3001 - Security risk found
  | 'TRUST_TIER_INSUFFICIENT'  // 3002 - Trust tier too low

  // Conflict errors (4xxx)
  | 'CONFLICT_DETECTED'        // 4000 - Skill conflicts found
  | 'BUDGET_EXCEEDED'          // 4001 - Character budget exceeded

  // Sync errors (5xxx)
  | 'SYNC_IN_PROGRESS'         // 5000 - Sync already running
  | 'SYNC_FAILED'              // 5001 - Sync operation failed
  | 'SOURCE_UNAVAILABLE'       // 5002 - Source API unavailable
  | 'RATE_LIMITED'             // 5003 - Rate limit exceeded

  // Learning errors (6xxx)
  | 'PATH_NOT_FOUND'           // 6000 - Learning path not found
  | 'EXERCISE_NOT_FOUND'       // 6001 - Exercise not found
  | 'SOLUTION_INVALID'         // 6002 - Solution validation failed
  | 'NO_EXERCISES_REMAINING';  // 6003 - All exercises completed
```

---

## Server: discovery-core (12 Tools)

### 1. search

Full-text and semantic skill search with filtering and pagination.

```typescript
// ==================================================================
// SEARCH TOOL
// ==================================================================

interface SearchInput {
  // Required
  query: string;                     // Search query (min 1 char, max 500)

  // Optional filters
  filters?: {
    categories?: string[];           // e.g., ["testing", "documentation"]
    technologies?: string[];         // e.g., ["react", "typescript"]
    trust_tier?: TrustTier[];        // e.g., ["official", "verified"]
    min_score?: number;              // 0.0 - 1.0
    source?: string[];               // e.g., ["github", "skillsmp"]
    updated_after?: string;          // ISO 8601 date
    has_tests?: boolean;
    has_examples?: boolean;
  };

  // Sorting
  sort?: {
    field: 'relevance' | 'score' | 'stars' | 'updated';
    direction: 'asc' | 'desc';
  };

  // Pagination
  limit?: number;                    // Default: 10, Max: 50
  offset?: number;                   // Default: 0
}

interface SearchOutput {
  results: SkillSummary[];
  total: number;
  has_more: boolean;
  query_analysis: {
    interpreted_query: string;
    detected_intent: string;
    suggested_refinements: string[];
  };
}

// Validation Rules:
// - query: Required, 1-500 characters
// - limit: 1-50, default 10
// - offset: >= 0, default 0
// - min_score: 0.0-1.0
// - categories: must be valid category IDs
// - technologies: must be valid technology IDs
```

**Example Invocation:**

```json
{
  "name": "search",
  "parameters": {
    "query": "react testing library",
    "filters": {
      "trust_tier": ["official", "verified"],
      "min_score": 0.7
    },
    "sort": {
      "field": "relevance",
      "direction": "desc"
    },
    "limit": 10
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "id": "github/testing-library/react-testing-skill",
        "name": "React Testing Library Skill",
        "slug": "react-testing-library-skill",
        "description": "Best practices for testing React components",
        "author": {
          "id": "github:testing-library",
          "name": "Testing Library",
          "verified": true
        },
        "trust_tier": "verified",
        "quality_score": 0.92,
        "github_stars": 1523,
        "categories": ["testing", "frontend"],
        "technologies": ["react", "jest", "typescript"],
        "updated_at": "2025-12-20T14:30:00Z",
        "installed": false
      }
    ],
    "total": 47,
    "has_more": true,
    "query_analysis": {
      "interpreted_query": "react testing library",
      "detected_intent": "testing_framework",
      "suggested_refinements": ["react unit testing", "react component testing"]
    }
  },
  "metadata": {
    "execution_time_ms": 45,
    "cached": true,
    "cache_age_seconds": 120,
    "index_version": "2025-12-26-001"
  }
}
```

---

### 2. get_skill

Retrieve complete skill details by ID.

```typescript
// ==================================================================
// GET_SKILL TOOL
// ==================================================================

interface GetSkillInput {
  skill_id: string;                  // Required: skill ID
  include_readme?: boolean;          // Include README excerpt (default: true)
  include_versions?: boolean;        // Include version history (default: false)
  include_security?: boolean;        // Include security scan details (default: false)
}

interface GetSkillOutput {
  skill: SkillDetail;
}

// Validation Rules:
// - skill_id: Required, format 'source/author/name'
// - Returns SKILL_NOT_FOUND if ID doesn't exist
// - Returns SKILL_BLOCKED if skill is blocklisted
```

**Example Invocation:**

```json
{
  "name": "get_skill",
  "parameters": {
    "skill_id": "github/anthropics/claude-code-memory",
    "include_readme": true,
    "include_security": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "skill": {
      "id": "github/anthropics/claude-code-memory",
      "name": "Claude Code Memory",
      "description": "Persistent memory and context management for Claude Code",
      "trust_tier": "official",
      "quality_score": 0.98,
      "github_stars": 5420,
      "current_version": "1.2.0",
      "estimated_char_budget": 2500,
      "security_scan_status": "passed",
      "readme_excerpt": "# Claude Code Memory\n\nEnhance Claude Code with persistent memory..."
    }
  },
  "metadata": {
    "execution_time_ms": 12,
    "cached": true
  }
}
```

---

### 3. analyze_codebase

Scan a project directory and detect technology stack.

```typescript
// ==================================================================
// ANALYZE_CODEBASE TOOL
// ==================================================================

interface AnalyzeCodebaseInput {
  path?: string;                     // Default: current directory
  depth?: number;                    // Default: 3, Max: 10
  include_dependencies?: boolean;    // Analyze package.json, etc. (default: true)
  quick_mode?: boolean;              // Faster but less accurate (default: false)
}

interface AnalyzeCodebaseOutput {
  path: string;
  scanned_at: string;
  stack: TechStackItem[];
  project_info: {
    name?: string;
    version?: string;
    description?: string;
    type: 'monorepo' | 'single' | 'library' | 'application' | 'unknown';
    package_manager?: 'npm' | 'yarn' | 'pnpm' | 'pip' | 'cargo' | 'go';
  };
  stats: {
    total_files: number;
    analyzed_files: number;
    directories_scanned: number;
    languages_detected: string[];
  };
  confidence_level: 'high' | 'medium' | 'low';
}

// Validation Rules:
// - path: Must be valid directory, defaults to cwd
// - depth: 1-10, default 3
// - Returns INVALID_PARAMETER if path doesn't exist
```

**Example Invocation:**

```json
{
  "name": "analyze_codebase",
  "parameters": {
    "path": "/Users/dev/my-react-app",
    "depth": 5,
    "include_dependencies": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "path": "/Users/dev/my-react-app",
    "scanned_at": "2025-12-26T15:30:00Z",
    "stack": [
      {
        "technology_id": "react",
        "name": "React",
        "type": "framework",
        "version": "18.2.0",
        "confidence": 1.0,
        "source": "package_json"
      },
      {
        "technology_id": "typescript",
        "name": "TypeScript",
        "type": "language",
        "version": "5.3.0",
        "confidence": 1.0,
        "source": "package_json"
      }
    ],
    "project_info": {
      "name": "my-react-app",
      "version": "1.0.0",
      "type": "application",
      "package_manager": "npm"
    },
    "stats": {
      "total_files": 245,
      "analyzed_files": 180,
      "directories_scanned": 32,
      "languages_detected": ["typescript", "javascript", "css", "html"]
    },
    "confidence_level": "high"
  },
  "metadata": {
    "execution_time_ms": 450,
    "files_analyzed": 180
  }
}
```

---

### 4. recommend_skills

Generate skill recommendations based on codebase analysis.

```typescript
// ==================================================================
// RECOMMEND_SKILLS TOOL
// ==================================================================

interface RecommendSkillsInput {
  path?: string;                     // Default: current directory
  max_results?: number;              // Default: 10, Max: 25
  include_reasons?: boolean;         // Include recommendation reasons (default: true)
  exclude_installed?: boolean;       // Exclude already installed skills (default: true)
  discovery_mode?: 'conservative' | 'exploratory';  // Default: 'conservative'
}

interface RecommendSkillsOutput {
  recommendations: Recommendation[];
  analysis_summary: string;
  gaps_identified: SkillGap[];
  installed_coverage: number;        // 0.0 - 1.0
}

interface Recommendation {
  skill: SkillSummary;
  match_score: number;               // 0.0 - 1.0
  reasons: RecommendationReason[];
  impact_areas: string[];
  priority: 'essential' | 'recommended' | 'optional';
}

interface RecommendationReason {
  type: 'technology_match' | 'gap_coverage' | 'popular_pairing' | 'author_reputation';
  description: string;
  confidence: number;
}

interface SkillGap {
  area: string;
  description: string;
  suggested_skills: string[];
  severity: 'high' | 'medium' | 'low';
}

// Validation Rules:
// - path: Must be valid directory
// - max_results: 1-25, default 10
// - Runs analyze_codebase internally if not cached
```

**Example Invocation:**

```json
{
  "name": "recommend_skills",
  "parameters": {
    "path": "/Users/dev/my-react-app",
    "max_results": 5,
    "discovery_mode": "conservative"
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "recommendations": [
      {
        "skill": {
          "id": "github/testing-library/react-testing-skill",
          "name": "React Testing Library Skill",
          "quality_score": 0.92
        },
        "match_score": 0.95,
        "reasons": [
          {
            "type": "technology_match",
            "description": "Your project uses React 18, this skill specializes in React testing",
            "confidence": 0.98
          },
          {
            "type": "gap_coverage",
            "description": "No testing skills currently installed",
            "confidence": 0.90
          }
        ],
        "impact_areas": ["testing", "code-quality"],
        "priority": "essential"
      }
    ],
    "analysis_summary": "React 18 application with TypeScript. Strong frontend stack, missing testing and documentation skills.",
    "gaps_identified": [
      {
        "area": "testing",
        "description": "No testing skills installed for React components",
        "suggested_skills": ["react-testing-skill", "jest-helper"],
        "severity": "high"
      }
    ],
    "installed_coverage": 0.35
  },
  "metadata": {
    "execution_time_ms": 320,
    "cached": false
  }
}
```

---

### 5. install_skill

Install a skill with pre-flight checks for conflicts and security.

```typescript
// ==================================================================
// INSTALL_SKILL TOOL
// ==================================================================

interface InstallSkillInput {
  skill_id: string;                  // Required: skill to install
  skip_conflict_check?: boolean;     // Default: false
  skip_security_scan?: boolean;      // Default: false
  force?: boolean;                   // Override warnings (default: false)
  target_directory?: string;         // Custom install location
}

interface InstallSkillOutput {
  skill_id: string;
  installed_path: string;
  installed_version: string;
  install_method: 'copy' | 'symlink' | 'plugin';

  // Pre-install check results
  conflicts?: Conflict[];
  security_warnings?: SecurityWarning[];
  budget_impact: BudgetImpact;

  // Post-install guidance
  activation_tips: string[];
  suggested_hooks?: HookConfig;
}

interface HookConfig {
  pre_message_hooks?: string[];
  post_message_hooks?: string[];
  file_triggers?: {
    pattern: string;
    description: string;
  }[];
}

// Validation Rules:
// - skill_id: Required, must exist in index
// - Returns SKILL_NOT_FOUND if skill doesn't exist
// - Returns SKILL_BLOCKED if skill is blocklisted
// - Returns SKILL_ALREADY_INSTALLED if already installed
// - Returns CONFLICT_DETECTED if conflicts found and !skip_conflict_check
// - Returns SECURITY_RISK_DETECTED if security issues and !force
// - Returns BUDGET_EXCEEDED if budget exceeded and !force
```

**Example Invocation:**

```json
{
  "name": "install_skill",
  "parameters": {
    "skill_id": "github/anthropics/claude-code-memory",
    "skip_conflict_check": false,
    "skip_security_scan": false
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "skill_id": "github/anthropics/claude-code-memory",
    "installed_path": "~/.claude/skills/claude-code-memory",
    "installed_version": "1.2.0",
    "install_method": "copy",
    "conflicts": [],
    "security_warnings": [],
    "budget_impact": {
      "current_usage": 15000,
      "skill_size": 2500,
      "projected_usage": 17500,
      "budget_limit": 50000,
      "utilization_percent": 35
    },
    "activation_tips": [
      "This skill activates when you mention 'memory' or 'remember'",
      "Try: 'Remember this API endpoint for later'"
    ],
    "suggested_hooks": {
      "pre_message_hooks": ["memory-context-loader"],
      "file_triggers": [
        {
          "pattern": "*.md",
          "description": "Load relevant notes for markdown files"
        }
      ]
    }
  },
  "metadata": {
    "execution_time_ms": 1250
  }
}
```

---

### 6. uninstall_skill

Remove an installed skill.

```typescript
// ==================================================================
// UNINSTALL_SKILL TOOL
// ==================================================================

interface UninstallSkillInput {
  skill_id: string;                  // Required: skill to uninstall
  remove_data?: boolean;             // Remove associated data (default: false)
  force?: boolean;                   // Skip confirmation (default: false)
}

interface UninstallSkillOutput {
  skill_id: string;
  removed_path: string;
  data_removed: boolean;
  budget_freed: number;
  dependent_skills_affected: string[];
}

// Validation Rules:
// - skill_id: Required
// - Returns SKILL_NOT_INSTALLED if not currently installed
// - Returns dependent_skills_affected if other skills depend on this one
```

**Example Invocation:**

```json
{
  "name": "uninstall_skill",
  "parameters": {
    "skill_id": "github/anthropics/claude-code-memory",
    "remove_data": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "skill_id": "github/anthropics/claude-code-memory",
    "removed_path": "~/.claude/skills/claude-code-memory",
    "data_removed": true,
    "budget_freed": 2500,
    "dependent_skills_affected": []
  },
  "metadata": {
    "execution_time_ms": 150
  }
}
```

---

### 7. list_installed

List all currently installed skills.

```typescript
// ==================================================================
// LIST_INSTALLED TOOL
// ==================================================================

interface ListInstalledInput {
  include_health?: boolean;          // Include health status (default: true)
  include_updates?: boolean;         // Check for updates (default: false)
  filter_health?: 'healthy' | 'warning' | 'error';
}

interface ListInstalledOutput {
  skills: InstalledSkillInfo[];
  total_count: number;
  total_budget_used: number;
  budget_limit: number;
  health_summary: {
    healthy: number;
    warning: number;
    error: number;
    unknown: number;
  };
}

interface InstalledSkillInfo {
  skill_id: string;
  name: string;
  installed_version: string;
  installed_at: string;
  installation_path: string;
  health_status: 'healthy' | 'warning' | 'error' | 'unknown';
  health_details?: string;
  activation_count: number;
  last_activated_at?: string;
  update_available?: {
    latest_version: string;
    breaking_changes: boolean;
  };
  char_budget: number;
}

// Validation Rules:
// - No required parameters
// - include_updates may increase latency (checks remote)
```

**Example Invocation:**

```json
{
  "name": "list_installed",
  "parameters": {
    "include_health": true,
    "include_updates": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "skills": [
      {
        "skill_id": "github/anthropics/claude-code-memory",
        "name": "Claude Code Memory",
        "installed_version": "1.2.0",
        "installed_at": "2025-12-20T10:00:00Z",
        "installation_path": "~/.claude/skills/claude-code-memory",
        "health_status": "healthy",
        "activation_count": 45,
        "last_activated_at": "2025-12-26T14:30:00Z",
        "update_available": {
          "latest_version": "1.3.0",
          "breaking_changes": false
        },
        "char_budget": 2500
      }
    ],
    "total_count": 5,
    "total_budget_used": 12500,
    "budget_limit": 50000,
    "health_summary": {
      "healthy": 4,
      "warning": 1,
      "error": 0,
      "unknown": 0
    }
  },
  "metadata": {
    "execution_time_ms": 85
  }
}
```

---

### 8. check_conflicts

Check for potential conflicts between skills.

```typescript
// ==================================================================
// CHECK_CONFLICTS TOOL
// ==================================================================

interface CheckConflictsInput {
  skill_id: string;                  // Skill to check
  against_installed?: boolean;       // Check against installed skills (default: true)
  against_skills?: string[];         // Check against specific skills
}

interface CheckConflictsOutput {
  skill_id: string;
  has_conflicts: boolean;
  conflicts: ConflictDetail[];
  recommendations: string[];
}

interface ConflictDetail extends Conflict {
  conflicting_skill: SkillSummary;
  overlap_details?: {
    shared_triggers: string[];
    overlap_percentage: number;
  };
}

// Validation Rules:
// - skill_id: Required, must exist
// - against_skills: Must be valid skill IDs if provided
```

**Example Invocation:**

```json
{
  "name": "check_conflicts",
  "parameters": {
    "skill_id": "github/testing/jest-skill",
    "against_installed": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "skill_id": "github/testing/jest-skill",
    "has_conflicts": true,
    "conflicts": [
      {
        "skill_id": "github/testing/vitest-skill",
        "skill_name": "Vitest Skill",
        "type": "trigger_overlap",
        "severity": "warning",
        "description": "Both skills respond to 'write test' triggers",
        "resolution_options": [
          "Uninstall one skill",
          "Set priority order",
          "Use specific trigger phrases"
        ],
        "conflicting_skill": {
          "id": "github/testing/vitest-skill",
          "name": "Vitest Skill",
          "quality_score": 0.88
        },
        "overlap_details": {
          "shared_triggers": ["test", "write test", "unit test"],
          "overlap_percentage": 65
        }
      }
    ],
    "recommendations": [
      "Consider setting priority: vitest-skill > jest-skill for modern projects",
      "Use 'jest test' and 'vitest test' for explicit skill targeting"
    ]
  },
  "metadata": {
    "execution_time_ms": 45
  }
}
```

---

### 9. audit_activation

Audit skill health and activation readiness.

```typescript
// ==================================================================
// AUDIT_ACTIVATION TOOL
// ==================================================================

interface AuditActivationInput {
  skill_id?: string;                 // Specific skill or all if omitted
  generate_hooks?: boolean;          // Generate activation hooks (default: false)
  include_recommendations?: boolean; // Include fix recommendations (default: true)
}

interface AuditActivationOutput {
  summary: AuditSummary;
  issues: AuditIssue[];
  warnings: AuditWarning[];
  recommendations: string[];
  generated_hooks?: HookConfig;
  budget_report: BudgetReport;
}

interface AuditSummary {
  skills_audited: number;
  healthy: number;
  issues_found: number;
  warnings_found: number;
  overall_health: 'healthy' | 'degraded' | 'critical';
}

interface AuditIssue {
  skill_id: string;
  issue_type: 'frontmatter_invalid' | 'file_missing' | 'syntax_error' | 'dependency_missing';
  severity: 'error' | 'warning';
  title: string;
  description: string;
  fix_suggestion?: string;
  auto_fixable: boolean;
}

interface AuditWarning {
  skill_id: string;
  warning_type: 'outdated' | 'low_activation' | 'budget_heavy' | 'no_triggers';
  message: string;
}

interface BudgetReport {
  total_budget: number;
  used_budget: number;
  utilization_percent: number;
  largest_skills: {
    skill_id: string;
    size: number;
    percent_of_budget: number;
  }[];
  optimization_suggestions: string[];
}

// Validation Rules:
// - skill_id: Optional, if omitted audits all installed skills
// - generate_hooks: Adds activation hooks to output
```

**Example Invocation:**

```json
{
  "name": "audit_activation",
  "parameters": {
    "include_recommendations": true,
    "generate_hooks": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "summary": {
      "skills_audited": 5,
      "healthy": 4,
      "issues_found": 1,
      "warnings_found": 2,
      "overall_health": "degraded"
    },
    "issues": [
      {
        "skill_id": "github/user/custom-skill",
        "issue_type": "frontmatter_invalid",
        "severity": "error",
        "title": "Invalid YAML frontmatter",
        "description": "Missing required 'triggers' field in SKILL.md",
        "fix_suggestion": "Add triggers field: 'triggers: [keyword1, keyword2]'",
        "auto_fixable": false
      }
    ],
    "warnings": [
      {
        "skill_id": "github/old/legacy-skill",
        "warning_type": "outdated",
        "message": "Skill hasn't been updated in 6 months"
      }
    ],
    "recommendations": [
      "Fix frontmatter issue in custom-skill for proper activation",
      "Consider replacing legacy-skill with a maintained alternative"
    ],
    "budget_report": {
      "total_budget": 50000,
      "used_budget": 22500,
      "utilization_percent": 45,
      "largest_skills": [
        {
          "skill_id": "github/large/documentation-skill",
          "size": 8000,
          "percent_of_budget": 16
        }
      ],
      "optimization_suggestions": [
        "documentation-skill uses 16% of budget - consider lazy loading"
      ]
    }
  },
  "metadata": {
    "execution_time_ms": 180,
    "skills_audited": 5
  }
}
```

---

### 10. estimate_budget

Calculate character budget impact for skills.

```typescript
// ==================================================================
// ESTIMATE_BUDGET TOOL
// ==================================================================

interface EstimateBudgetInput {
  skill_ids: string[];               // Skills to estimate
  include_current?: boolean;         // Include current usage (default: true)
}

interface EstimateBudgetOutput {
  current_usage: number;
  estimated_addition: number;
  projected_total: number;
  budget_limit: number;
  utilization_percent: number;
  breakdown: {
    skill_id: string;
    name: string;
    estimated_size: number;
    installed: boolean;
  }[];
  fits_budget: boolean;
  overflow_amount?: number;
}

// Validation Rules:
// - skill_ids: Required, at least one skill ID
// - All skill_ids must exist in index
```

**Example Invocation:**

```json
{
  "name": "estimate_budget",
  "parameters": {
    "skill_ids": ["github/skill1", "github/skill2"],
    "include_current": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "current_usage": 15000,
    "estimated_addition": 5500,
    "projected_total": 20500,
    "budget_limit": 50000,
    "utilization_percent": 41,
    "breakdown": [
      {
        "skill_id": "github/skill1",
        "name": "Skill One",
        "estimated_size": 3000,
        "installed": false
      },
      {
        "skill_id": "github/skill2",
        "name": "Skill Two",
        "estimated_size": 2500,
        "installed": false
      }
    ],
    "fits_budget": true
  },
  "metadata": {
    "execution_time_ms": 25
  }
}
```

---

### 11. get_priorities

Get skill priority configuration.

```typescript
// ==================================================================
// GET_PRIORITIES TOOL
// ==================================================================

interface GetPrioritiesInput {
  skill_ids?: string[];              // Filter to specific skills (optional)
}

interface GetPrioritiesOutput {
  priorities: SkillPriority[];
  default_order: 'quality_score' | 'manual' | 'install_date';
}

interface SkillPriority {
  skill_id: string;
  name: string;
  priority: number;                  // 1 = highest
  locked: boolean;                   // Manual override applied
  effective_triggers: string[];
}

// Validation Rules:
// - skill_ids: Optional, if provided must be valid installed skill IDs
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "priorities": [
      {
        "skill_id": "github/anthropics/claude-code-memory",
        "name": "Claude Code Memory",
        "priority": 1,
        "locked": true,
        "effective_triggers": ["memory", "remember", "recall"]
      },
      {
        "skill_id": "github/testing/jest-skill",
        "name": "Jest Skill",
        "priority": 2,
        "locked": false,
        "effective_triggers": ["test", "jest"]
      }
    ],
    "default_order": "quality_score"
  },
  "metadata": {
    "execution_time_ms": 15
  }
}
```

---

### 12. set_priority

Set skill priority order.

```typescript
// ==================================================================
// SET_PRIORITY TOOL
// ==================================================================

interface SetPriorityInput {
  skill_id: string;                  // Skill to prioritize
  priority: number;                  // Priority level (1 = highest)
  lock?: boolean;                    // Lock priority (default: true)
}

interface SetPriorityOutput {
  skill_id: string;
  old_priority: number;
  new_priority: number;
  locked: boolean;
  affected_skills: {
    skill_id: string;
    old_priority: number;
    new_priority: number;
  }[];
}

// Validation Rules:
// - skill_id: Required, must be installed
// - priority: >= 1
// - Returns SKILL_NOT_INSTALLED if not installed
```

**Example Invocation:**

```json
{
  "name": "set_priority",
  "parameters": {
    "skill_id": "github/testing/vitest-skill",
    "priority": 1,
    "lock": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "skill_id": "github/testing/vitest-skill",
    "old_priority": 3,
    "new_priority": 1,
    "locked": true,
    "affected_skills": [
      {
        "skill_id": "github/testing/jest-skill",
        "old_priority": 1,
        "new_priority": 2
      }
    ]
  },
  "metadata": {
    "execution_time_ms": 20
  }
}
```

---

## Server: learning (6 Tools)

### 1. get_paths

List available learning paths.

```typescript
// ==================================================================
// GET_PATHS TOOL
// ==================================================================

interface GetPathsInput {
  category?: string;                 // Filter by category
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  include_progress?: boolean;        // Include user progress (default: true)
}

interface GetPathsOutput {
  paths: LearningPathSummary[];
  categories: string[];
}

interface LearningPathSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimated_hours: number;
  exercise_count: number;
  skills_covered: string[];
  progress?: {
    completed_exercises: number;
    percent_complete: number;
    last_activity?: string;
  };
}

// Validation Rules:
// - category: Must be valid category if provided
// - difficulty: Must be valid difficulty level if provided
```

**Example Invocation:**

```json
{
  "name": "get_paths",
  "parameters": {
    "category": "testing",
    "include_progress": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "paths": [
      {
        "id": "testing-fundamentals",
        "name": "Testing Fundamentals",
        "description": "Learn unit testing, integration testing, and TDD",
        "category": "testing",
        "difficulty": "beginner",
        "estimated_hours": 4,
        "exercise_count": 12,
        "skills_covered": ["jest-skill", "testing-library-skill"],
        "progress": {
          "completed_exercises": 5,
          "percent_complete": 42,
          "last_activity": "2025-12-25T10:00:00Z"
        }
      }
    ],
    "categories": ["testing", "documentation", "debugging", "productivity"]
  },
  "metadata": {
    "execution_time_ms": 35
  }
}
```

---

### 2. get_path

Get complete learning path details.

```typescript
// ==================================================================
// GET_PATH TOOL
// ==================================================================

interface GetPathInput {
  path_id: string;                   // Required: learning path ID
  include_exercises?: boolean;       // Include exercise list (default: true)
}

interface GetPathOutput {
  path: LearningPathDetail;
}

interface LearningPathDetail extends LearningPathSummary {
  prerequisites: string[];
  learning_objectives: string[];
  exercises: ExerciseSummary[];
  related_paths: string[];
}

interface ExerciseSummary {
  id: string;
  title: string;
  type: 'tutorial' | 'practice' | 'challenge' | 'project';
  estimated_minutes: number;
  status: 'locked' | 'available' | 'in_progress' | 'completed';
  skills_practiced: string[];
}

// Validation Rules:
// - path_id: Required
// - Returns PATH_NOT_FOUND if path doesn't exist
```

**Example Invocation:**

```json
{
  "name": "get_path",
  "parameters": {
    "path_id": "testing-fundamentals",
    "include_exercises": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "path": {
      "id": "testing-fundamentals",
      "name": "Testing Fundamentals",
      "description": "Learn unit testing, integration testing, and TDD",
      "difficulty": "beginner",
      "estimated_hours": 4,
      "prerequisites": [],
      "learning_objectives": [
        "Write effective unit tests",
        "Understand test-driven development",
        "Use mocking and stubbing"
      ],
      "exercises": [
        {
          "id": "test-first-unit-test",
          "title": "Your First Unit Test",
          "type": "tutorial",
          "estimated_minutes": 15,
          "status": "completed",
          "skills_practiced": ["jest-skill"]
        },
        {
          "id": "test-async-functions",
          "title": "Testing Async Functions",
          "type": "practice",
          "estimated_minutes": 20,
          "status": "available",
          "skills_practiced": ["jest-skill"]
        }
      ],
      "related_paths": ["testing-advanced", "tdd-mastery"]
    }
  },
  "metadata": {
    "execution_time_ms": 28
  }
}
```

---

### 3. next_exercise

Get the next available exercise in a learning path.

```typescript
// ==================================================================
// NEXT_EXERCISE TOOL
// ==================================================================

interface NextExerciseInput {
  path_id: string;                   // Required: learning path ID
}

interface NextExerciseOutput {
  exercise: ExerciseDetail;
  path_progress: {
    completed: number;
    remaining: number;
    percent_complete: number;
  };
}

interface ExerciseDetail {
  id: string;
  path_id: string;
  title: string;
  type: 'tutorial' | 'practice' | 'challenge' | 'project';
  difficulty: 'easy' | 'medium' | 'hard';
  estimated_minutes: number;

  // Content
  instructions: string;
  starter_code?: string;
  hints: string[];

  // Validation
  validation_type: 'output' | 'pattern' | 'manual' | 'test';
  expected_output?: string;
  test_cases?: TestCase[];

  // Context
  skills_practiced: string[];
  related_docs: string[];
}

interface TestCase {
  input: string;
  expected: string;
  description: string;
}

// Validation Rules:
// - path_id: Required
// - Returns PATH_NOT_FOUND if path doesn't exist
// - Returns NO_EXERCISES_REMAINING if path completed
```

**Example Invocation:**

```json
{
  "name": "next_exercise",
  "parameters": {
    "path_id": "testing-fundamentals"
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "exercise": {
      "id": "test-async-functions",
      "path_id": "testing-fundamentals",
      "title": "Testing Async Functions",
      "type": "practice",
      "difficulty": "medium",
      "estimated_minutes": 20,
      "instructions": "Write tests for an async function that fetches user data...",
      "starter_code": "// async function fetchUser(id) {...}\n\ntest('fetches user successfully', async () => {\n  // Your code here\n});",
      "hints": [
        "Use async/await in your test",
        "Mock the fetch function"
      ],
      "validation_type": "test",
      "test_cases": [
        {
          "input": "fetchUser(1)",
          "expected": "{ id: 1, name: 'Test User' }",
          "description": "Should return user object"
        }
      ],
      "skills_practiced": ["jest-skill"],
      "related_docs": ["https://jestjs.io/docs/asynchronous"]
    },
    "path_progress": {
      "completed": 5,
      "remaining": 7,
      "percent_complete": 42
    }
  },
  "metadata": {
    "execution_time_ms": 22
  }
}
```

---

### 4. submit_solution

Submit and validate an exercise solution.

```typescript
// ==================================================================
// SUBMIT_SOLUTION TOOL
// ==================================================================

interface SubmitSolutionInput {
  exercise_id: string;               // Required: exercise ID
  solution: string;                  // Required: user's solution code
  request_feedback?: boolean;        // Get detailed feedback (default: true)
}

interface SubmitSolutionOutput {
  exercise_id: string;
  passed: boolean;
  score: number;                     // 0.0 - 1.0
  feedback: SolutionFeedback;
  next_exercise?: ExerciseSummary;
  achievements_earned?: Achievement[];
}

interface SolutionFeedback {
  summary: string;
  test_results?: {
    passed: number;
    failed: number;
    details: TestResult[];
  };
  suggestions: string[];
  exemplary_aspects?: string[];
  improvement_areas?: string[];
}

interface TestResult {
  test_name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  error?: string;
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
}

// Validation Rules:
// - exercise_id: Required, must exist
// - solution: Required, non-empty string
// - Returns EXERCISE_NOT_FOUND if exercise doesn't exist
// - Returns SOLUTION_INVALID if validation fails (still returns feedback)
```

**Example Invocation:**

```json
{
  "name": "submit_solution",
  "parameters": {
    "exercise_id": "test-async-functions",
    "solution": "test('fetches user successfully', async () => {\n  const user = await fetchUser(1);\n  expect(user).toEqual({ id: 1, name: 'Test User' });\n});",
    "request_feedback": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "exercise_id": "test-async-functions",
    "passed": true,
    "score": 0.95,
    "feedback": {
      "summary": "Excellent work! Your async test correctly awaits the promise and validates the result.",
      "test_results": {
        "passed": 3,
        "failed": 0,
        "details": [
          {
            "test_name": "validates async behavior",
            "passed": true
          }
        ]
      },
      "suggestions": [
        "Consider adding error handling tests"
      ],
      "exemplary_aspects": [
        "Proper use of async/await",
        "Clear assertion"
      ]
    },
    "next_exercise": {
      "id": "test-mocking-basics",
      "title": "Introduction to Mocking",
      "type": "tutorial",
      "estimated_minutes": 25,
      "status": "available"
    },
    "achievements_earned": [
      {
        "id": "async-ace",
        "name": "Async Ace",
        "description": "Complete your first async testing exercise",
        "icon": "lightning"
      }
    ]
  },
  "metadata": {
    "execution_time_ms": 150
  }
}
```

---

### 5. get_progress

Get learning progress across all or specific paths.

```typescript
// ==================================================================
// GET_PROGRESS TOOL
// ==================================================================

interface GetProgressInput {
  path_id?: string;                  // Specific path or all paths
  include_history?: boolean;         // Include activity history (default: false)
}

interface GetProgressOutput {
  overall: OverallProgress;
  paths: PathProgress[];
  recent_activity?: ActivityEntry[];
  achievements: Achievement[];
  streak: StreakInfo;
}

interface OverallProgress {
  total_exercises: number;
  completed_exercises: number;
  percent_complete: number;
  total_hours_spent: number;
  skills_mastered: string[];
}

interface PathProgress {
  path_id: string;
  path_name: string;
  started_at: string;
  last_activity: string;
  completed_exercises: number;
  total_exercises: number;
  percent_complete: number;
  status: 'not_started' | 'in_progress' | 'completed';
}

interface ActivityEntry {
  timestamp: string;
  type: 'exercise_completed' | 'path_started' | 'achievement_earned';
  details: string;
  score?: number;
}

interface StreakInfo {
  current_streak: number;            // Days
  longest_streak: number;
  last_activity_date: string;
}

// Validation Rules:
// - path_id: Optional, must be valid if provided
```

**Example Invocation:**

```json
{
  "name": "get_progress",
  "parameters": {
    "include_history": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "overall": {
      "total_exercises": 150,
      "completed_exercises": 45,
      "percent_complete": 30,
      "total_hours_spent": 12.5,
      "skills_mastered": ["jest-skill", "documentation-skill"]
    },
    "paths": [
      {
        "path_id": "testing-fundamentals",
        "path_name": "Testing Fundamentals",
        "started_at": "2025-12-01T10:00:00Z",
        "last_activity": "2025-12-26T14:00:00Z",
        "completed_exercises": 8,
        "total_exercises": 12,
        "percent_complete": 67,
        "status": "in_progress"
      }
    ],
    "recent_activity": [
      {
        "timestamp": "2025-12-26T14:00:00Z",
        "type": "exercise_completed",
        "details": "Completed 'Testing Async Functions'",
        "score": 0.95
      }
    ],
    "achievements": [
      {
        "id": "async-ace",
        "name": "Async Ace",
        "description": "Complete your first async testing exercise",
        "icon": "lightning"
      }
    ],
    "streak": {
      "current_streak": 5,
      "longest_streak": 12,
      "last_activity_date": "2025-12-26"
    }
  },
  "metadata": {
    "execution_time_ms": 45
  }
}
```

---

### 6. reset_progress

Reset progress for a learning path.

```typescript
// ==================================================================
// RESET_PROGRESS TOOL
// ==================================================================

interface ResetProgressInput {
  path_id: string;                   // Required: path to reset
  confirm?: boolean;                 // Confirmation required (default: false)
}

interface ResetProgressOutput {
  path_id: string;
  exercises_reset: number;
  achievements_retained: boolean;
  previous_completion: number;
}

// Validation Rules:
// - path_id: Required
// - confirm: Must be true to actually reset
// - Returns PATH_NOT_FOUND if path doesn't exist
// - Without confirm=true, returns preview of what would be reset
```

**Example Invocation:**

```json
{
  "name": "reset_progress",
  "parameters": {
    "path_id": "testing-fundamentals",
    "confirm": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "path_id": "testing-fundamentals",
    "exercises_reset": 8,
    "achievements_retained": true,
    "previous_completion": 67
  },
  "metadata": {
    "execution_time_ms": 30
  }
}
```

---

## Server: sync (5 Tools)

### 1. refresh_index

Trigger an incremental index sync.

```typescript
// ==================================================================
// REFRESH_INDEX TOOL
// ==================================================================

interface RefreshIndexInput {
  sources?: string[];                // Specific sources or all if omitted
  force_check?: boolean;             // Ignore cache/etags (default: false)
}

interface RefreshIndexOutput {
  sync_id: string;
  status: 'started' | 'completed' | 'queued';
  sources_synced: SourceSyncResult[];
  total_skills_updated: number;
  duration_ms?: number;
}

interface SourceSyncResult {
  source_id: string;
  source_name: string;
  status: 'success' | 'skipped' | 'failed';
  skills_added: number;
  skills_updated: number;
  skills_removed: number;
  error?: string;
}

// Validation Rules:
// - sources: Must be valid source IDs if provided
// - Returns SYNC_IN_PROGRESS if sync already running
```

**Example Invocation:**

```json
{
  "name": "refresh_index",
  "parameters": {
    "sources": ["github"],
    "force_check": false
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "sync_id": "sync_20251226_153000",
    "status": "completed",
    "sources_synced": [
      {
        "source_id": "github",
        "source_name": "GitHub",
        "status": "success",
        "skills_added": 15,
        "skills_updated": 42,
        "skills_removed": 3
      }
    ],
    "total_skills_updated": 60,
    "duration_ms": 8500
  },
  "metadata": {
    "execution_time_ms": 8500
  }
}
```

---

### 2. force_full_sync

Force a complete index rebuild from all sources.

```typescript
// ==================================================================
// FORCE_FULL_SYNC TOOL
// ==================================================================

interface ForceFullSyncInput {
  sources?: string[];                // Specific sources or all if omitted
  confirm?: boolean;                 // Required confirmation (default: false)
}

interface ForceFullSyncOutput {
  sync_id: string;
  status: 'started' | 'in_progress';
  estimated_duration_minutes: number;
  message: string;
}

// Validation Rules:
// - confirm: Must be true to proceed (full sync is expensive)
// - Returns SYNC_IN_PROGRESS if sync already running
// - Without confirm, returns preview with estimated time
```

**Example Invocation:**

```json
{
  "name": "force_full_sync",
  "parameters": {
    "confirm": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "sync_id": "full_sync_20251226_160000",
    "status": "started",
    "estimated_duration_minutes": 8,
    "message": "Full index rebuild started. This may take 5-10 minutes. Use get_sync_status to monitor progress."
  },
  "metadata": {
    "execution_time_ms": 50
  }
}
```

---

### 3. get_sync_status

Check current sync state and history.

```typescript
// ==================================================================
// GET_SYNC_STATUS TOOL
// ==================================================================

interface GetSyncStatusInput {
  sync_id?: string;                  // Specific sync or current status
  include_history?: boolean;         // Include recent sync history (default: false)
}

interface GetSyncStatusOutput {
  current_sync?: CurrentSyncInfo;
  index_stats: IndexStats;
  last_sync: LastSyncInfo;
  sync_history?: SyncHistoryEntry[];
}

interface CurrentSyncInfo {
  sync_id: string;
  sync_type: 'incremental' | 'full';
  status: 'preparing' | 'fetching' | 'processing' | 'storing';
  started_at: string;
  progress: {
    current: number;
    total: number;
    percent: number;
  };
  current_source?: string;
}

interface IndexStats {
  total_skills: number;
  by_source: { [source: string]: number };
  by_trust_tier: { [tier: string]: number };
  index_size_mb: number;
  last_updated: string;
}

interface LastSyncInfo {
  sync_id: string;
  sync_type: 'incremental' | 'full';
  completed_at: string;
  duration_ms: number;
  skills_updated: number;
  status: 'success' | 'partial' | 'failed';
}

interface SyncHistoryEntry {
  sync_id: string;
  sync_type: 'incremental' | 'full';
  started_at: string;
  completed_at: string;
  status: 'success' | 'partial' | 'failed';
  skills_updated: number;
}

// Validation Rules:
// - sync_id: Optional, must be valid if provided
```

**Example Invocation:**

```json
{
  "name": "get_sync_status",
  "parameters": {
    "include_history": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "current_sync": null,
    "index_stats": {
      "total_skills": 52340,
      "by_source": {
        "github": 45000,
        "skillsmp": 5000,
        "mcp-so": 2340
      },
      "by_trust_tier": {
        "official": 150,
        "verified": 2500,
        "community": 35000,
        "unverified": 14690
      },
      "index_size_mb": 125.5,
      "last_updated": "2025-12-26T15:30:00Z"
    },
    "last_sync": {
      "sync_id": "sync_20251226_153000",
      "sync_type": "incremental",
      "completed_at": "2025-12-26T15:30:08Z",
      "duration_ms": 8500,
      "skills_updated": 60,
      "status": "success"
    },
    "sync_history": [
      {
        "sync_id": "sync_20251226_153000",
        "sync_type": "incremental",
        "started_at": "2025-12-26T15:30:00Z",
        "completed_at": "2025-12-26T15:30:08Z",
        "status": "success",
        "skills_updated": 60
      }
    ]
  },
  "metadata": {
    "execution_time_ms": 15
  }
}
```

---

### 4. get_source_health

Check health status of all data sources.

```typescript
// ==================================================================
// GET_SOURCE_HEALTH TOOL
// ==================================================================

interface GetSourceHealthInput {
  source_id?: string;                // Specific source or all sources
}

interface GetSourceHealthOutput {
  sources: SourceHealth[];
  overall_health: 'healthy' | 'degraded' | 'critical';
}

interface SourceHealth {
  source_id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'unavailable' | 'rate_limited';
  last_successful_sync: string;
  last_check: string;
  response_time_ms?: number;
  rate_limit?: {
    remaining: number;
    limit: number;
    resets_at: string;
  };
  error_count_24h: number;
  last_error?: string;
  skills_contributed: number;
}

// Validation Rules:
// - source_id: Optional, must be valid if provided
```

**Example Invocation:**

```json
{
  "name": "get_source_health",
  "parameters": {}
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "sources": [
      {
        "source_id": "github",
        "name": "GitHub",
        "status": "healthy",
        "last_successful_sync": "2025-12-26T15:30:00Z",
        "last_check": "2025-12-26T16:00:00Z",
        "response_time_ms": 120,
        "rate_limit": {
          "remaining": 4850,
          "limit": 5000,
          "resets_at": "2025-12-26T17:00:00Z"
        },
        "error_count_24h": 0,
        "skills_contributed": 45000
      },
      {
        "source_id": "skillsmp",
        "name": "SkillsMP",
        "status": "degraded",
        "last_successful_sync": "2025-12-26T12:00:00Z",
        "last_check": "2025-12-26T16:00:00Z",
        "response_time_ms": 2500,
        "error_count_24h": 3,
        "last_error": "Connection timeout",
        "skills_contributed": 5000
      }
    ],
    "overall_health": "degraded"
  },
  "metadata": {
    "execution_time_ms": 350
  }
}
```

---

### 5. update_blocklist

Update local blocklist entries.

```typescript
// ==================================================================
// UPDATE_BLOCKLIST TOOL
// ==================================================================

interface UpdateBlocklistInput {
  action: 'add' | 'remove' | 'refresh';
  skill_id?: string;                 // For add/remove
  reason?: string;                   // Required for add
  refresh_from_community?: boolean;  // For refresh action (default: true)
}

interface UpdateBlocklistOutput {
  action: string;
  skill_id?: string;
  blocklist_size: number;
  last_community_refresh?: string;
  affected_installed_skills?: string[];
}

// Validation Rules:
// - For 'add': skill_id and reason required
// - For 'remove': skill_id required
// - For 'refresh': no skill_id needed
// - Returns SKILL_NOT_FOUND for add if skill doesn't exist
```

**Example Invocation (Add):**

```json
{
  "name": "update_blocklist",
  "parameters": {
    "action": "add",
    "skill_id": "github/suspicious/malware-skill",
    "reason": "Contains obfuscated code with external API calls"
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "action": "add",
    "skill_id": "github/suspicious/malware-skill",
    "blocklist_size": 127,
    "affected_installed_skills": []
  },
  "metadata": {
    "execution_time_ms": 20
  }
}
```

**Example Invocation (Refresh):**

```json
{
  "name": "update_blocklist",
  "parameters": {
    "action": "refresh",
    "refresh_from_community": true
  }
}
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "action": "refresh",
    "blocklist_size": 145,
    "last_community_refresh": "2025-12-26T16:00:00Z",
    "affected_installed_skills": [
      "github/old/deprecated-skill"
    ]
  },
  "metadata": {
    "execution_time_ms": 1200
  }
}
```

---

## Error Response Patterns

All tools return consistent error responses:

```typescript
// ==================================================================
// ERROR RESPONSE PATTERN
// ==================================================================

interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    recovery_suggestions?: string[];
  };
  metadata?: {
    execution_time_ms: number;
    request_id?: string;
  };
}
```

**Example Error Response:**

```json
{
  "success": false,
  "error": {
    "code": "SKILL_NOT_FOUND",
    "message": "Skill 'github/invalid/nonexistent' not found in index",
    "details": {
      "skill_id": "github/invalid/nonexistent",
      "searched_sources": ["github", "skillsmp", "mcp-so"]
    },
    "recovery_suggestions": [
      "Verify the skill ID is correct",
      "Try searching for the skill by name",
      "Run refresh_index to update the skill index"
    ]
  },
  "metadata": {
    "execution_time_ms": 25,
    "request_id": "req_abc123"
  }
}
```

---

## Validation Rules Summary

| Tool | Required Parameters | Key Validations |
|------|---------------------|-----------------|
| search | query | query: 1-500 chars, limit: 1-50 |
| get_skill | skill_id | Must exist, not blocked |
| analyze_codebase | none | path must be valid directory |
| recommend_skills | none | path must be valid directory |
| install_skill | skill_id | Must exist, not blocked, not installed |
| uninstall_skill | skill_id | Must be installed |
| list_installed | none | - |
| check_conflicts | skill_id | Must exist |
| audit_activation | none | - |
| estimate_budget | skill_ids | At least one, all must exist |
| get_priorities | none | - |
| set_priority | skill_id, priority | Must be installed, priority >= 1 |
| get_paths | none | - |
| get_path | path_id | Must exist |
| next_exercise | path_id | Must exist, exercises remaining |
| submit_solution | exercise_id, solution | exercise must exist, solution non-empty |
| get_progress | none | - |
| reset_progress | path_id | Must exist, confirm=true required |
| refresh_index | none | No sync in progress |
| force_full_sync | none | confirm=true required |
| get_sync_status | none | - |
| get_source_health | none | - |
| update_blocklist | action | add: skill_id + reason; remove: skill_id |

---

## References

- [Backend API Architecture](/docs/architecture/backend-api.md) - Full API design
- [Data Schema](/docs/implementation/artifacts/data-schema.md) - SQLite schema
- [PRD v3](/docs/prd-v3.md) - Product requirements
- [Technical Design](/docs/technical-design.md) - System architecture

---

*Schema Version: 1.0*
*Last Updated: December 26, 2025*
*Compatibility: MCP Protocol 2024.1+*
