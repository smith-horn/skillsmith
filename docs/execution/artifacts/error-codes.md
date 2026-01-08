# Skillsmith - Error Codes Reference

**Version:** 1.0
**Last Updated:** December 26, 2025
**Status:** Design Complete
**Owner:** Backend/API Architect

---

## Overview

This document defines the complete error code taxonomy for the Skillsmith. All MCP tool responses follow a consistent error format enabling Claude Code to provide actionable guidance to users.

### Design Principles

1. **Actionable Errors** - Every error includes recovery suggestions
2. **Consistent Structure** - All errors follow the same response schema
3. **Retriability Awareness** - Clearly indicates which errors can be retried
4. **User-Friendly Messages** - Separate technical codes from human-readable messages
5. **Traceable** - Request IDs for debugging and support

---

## Error Response Schema

### TypeScript Definitions

```typescript
// ==================================================================
// ERROR RESPONSE INTERFACES
// ==================================================================

/**
 * Standard error response returned by all MCP tools
 */
interface ErrorResponse {
  success: false;
  error: {
    /** Machine-readable error code (e.g., "INSTALL_CONFLICT_DETECTED") */
    code: ErrorCode;

    /** Human-readable error message */
    message: string;

    /** Additional context-specific details */
    details?: Record<string, unknown>;

    /** Actionable steps to resolve the error */
    recovery_suggestions?: string[];

    /** Link to relevant documentation */
    documentation_url?: string;

    /** HTTP-equivalent status code for categorization */
    http_status?: number;

    /** Whether the operation can be retried */
    retriable?: boolean;

    /** Recommended wait time before retry (milliseconds) */
    retry_after_ms?: number;
  };
  metadata?: {
    /** Unique identifier for this request */
    request_id?: string;

    /** ISO timestamp of when the error occurred */
    timestamp: string;

    /** Server that generated the error */
    server?: 'discovery-core' | 'learning' | 'sync';
  };
}

/**
 * Error severity levels
 */
type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Error category for grouping and handling
 */
type ErrorCategory =
  | 'search'
  | 'install'
  | 'sync'
  | 'security'
  | 'config'
  | 'network'
  | 'database'
  | 'validation';
```

---

## Error Code Taxonomy

### Error Code Enums

```typescript
// ==================================================================
// ERROR CODE ENUMS BY CATEGORY
// ==================================================================

/**
 * Search operation errors (SEARCH_*)
 */
enum SearchErrorCode {
  SEARCH_QUERY_EMPTY = 'SEARCH_QUERY_EMPTY',
  SEARCH_QUERY_TOO_LONG = 'SEARCH_QUERY_TOO_LONG',
  SEARCH_QUERY_INVALID_SYNTAX = 'SEARCH_QUERY_INVALID_SYNTAX',
  SEARCH_NO_RESULTS = 'SEARCH_NO_RESULTS',
  SEARCH_INDEX_UNAVAILABLE = 'SEARCH_INDEX_UNAVAILABLE',
  SEARCH_INDEX_CORRUPTED = 'SEARCH_INDEX_CORRUPTED',
  SEARCH_TIMEOUT = 'SEARCH_TIMEOUT',
  SEARCH_FILTER_INVALID = 'SEARCH_FILTER_INVALID',
}

/**
 * Installation errors (INSTALL_*)
 */
enum InstallErrorCode {
  INSTALL_SKILL_NOT_FOUND = 'INSTALL_SKILL_NOT_FOUND',
  INSTALL_ALREADY_INSTALLED = 'INSTALL_ALREADY_INSTALLED',
  INSTALL_VERSION_NOT_FOUND = 'INSTALL_VERSION_NOT_FOUND',
  INSTALL_CONFLICT_DETECTED = 'INSTALL_CONFLICT_DETECTED',
  INSTALL_BUDGET_EXCEEDED = 'INSTALL_BUDGET_EXCEEDED',
  INSTALL_DOWNLOAD_FAILED = 'INSTALL_DOWNLOAD_FAILED',
  INSTALL_WRITE_FAILED = 'INSTALL_WRITE_FAILED',
  INSTALL_PATH_INVALID = 'INSTALL_PATH_INVALID',
  INSTALL_BLOCKED_SKILL = 'INSTALL_BLOCKED_SKILL',
  INSTALL_ROLLBACK_FAILED = 'INSTALL_ROLLBACK_FAILED',
}

/**
 * Synchronization errors (SYNC_*)
 */
enum SyncErrorCode {
  SYNC_IN_PROGRESS = 'SYNC_IN_PROGRESS',
  SYNC_LOCK_TIMEOUT = 'SYNC_LOCK_TIMEOUT',
  SYNC_SOURCE_UNAVAILABLE = 'SYNC_SOURCE_UNAVAILABLE',
  SYNC_RATE_LIMITED = 'SYNC_RATE_LIMITED',
  SYNC_AUTH_EXPIRED = 'SYNC_AUTH_EXPIRED',
  SYNC_MERGE_CONFLICT = 'SYNC_MERGE_CONFLICT',
  SYNC_PARTIAL_FAILURE = 'SYNC_PARTIAL_FAILURE',
  SYNC_CANCELLED = 'SYNC_CANCELLED',
}

/**
 * Security-related errors (SECURITY_*)
 */
enum SecurityErrorCode {
  SECURITY_SCAN_FAILED = 'SECURITY_SCAN_FAILED',
  SECURITY_RISK_DETECTED = 'SECURITY_RISK_DETECTED',
  SECURITY_BLOCKLIST_HIT = 'SECURITY_BLOCKLIST_HIT',
  SECURITY_TRUST_TIER_INSUFFICIENT = 'SECURITY_TRUST_TIER_INSUFFICIENT',
  SECURITY_SIGNATURE_INVALID = 'SECURITY_SIGNATURE_INVALID',
  SECURITY_TYPOSQUATTING_DETECTED = 'SECURITY_TYPOSQUATTING_DETECTED',
}

/**
 * Configuration errors (CONFIG_*)
 */
enum ConfigErrorCode {
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  CONFIG_INVALID_VALUE = 'CONFIG_INVALID_VALUE',
  CONFIG_PERMISSION_DENIED = 'CONFIG_PERMISSION_DENIED',
  CONFIG_SCHEMA_MISMATCH = 'CONFIG_SCHEMA_MISMATCH',
  CONFIG_MIGRATION_FAILED = 'CONFIG_MIGRATION_FAILED',
}

/**
 * Network/connectivity errors (NETWORK_*)
 */
enum NetworkErrorCode {
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  NETWORK_CONNECTION_REFUSED = 'NETWORK_CONNECTION_REFUSED',
  NETWORK_DNS_FAILED = 'NETWORK_DNS_FAILED',
  NETWORK_SSL_ERROR = 'NETWORK_SSL_ERROR',
  NETWORK_OFFLINE = 'NETWORK_OFFLINE',
  NETWORK_RATE_LIMITED = 'NETWORK_RATE_LIMITED',
}

/**
 * SQLite operation errors (DATABASE_*)
 */
enum DatabaseErrorCode {
  DATABASE_LOCKED = 'DATABASE_LOCKED',
  DATABASE_CORRUPTED = 'DATABASE_CORRUPTED',
  DATABASE_DISK_FULL = 'DATABASE_DISK_FULL',
  DATABASE_READONLY = 'DATABASE_READONLY',
  DATABASE_CONSTRAINT_VIOLATION = 'DATABASE_CONSTRAINT_VIOLATION',
  DATABASE_MIGRATION_PENDING = 'DATABASE_MIGRATION_PENDING',
}

/**
 * Input validation errors (VALIDATION_*)
 */
enum ValidationErrorCode {
  VALIDATION_REQUIRED_FIELD = 'VALIDATION_REQUIRED_FIELD',
  VALIDATION_INVALID_FORMAT = 'VALIDATION_INVALID_FORMAT',
  VALIDATION_OUT_OF_RANGE = 'VALIDATION_OUT_OF_RANGE',
  VALIDATION_SKILL_ID_INVALID = 'VALIDATION_SKILL_ID_INVALID',
  VALIDATION_PATH_INVALID = 'VALIDATION_PATH_INVALID',
  VALIDATION_FRONTMATTER_INVALID = 'VALIDATION_FRONTMATTER_INVALID',
}

/**
 * Combined error code type
 */
type ErrorCode =
  | SearchErrorCode
  | InstallErrorCode
  | SyncErrorCode
  | SecurityErrorCode
  | ConfigErrorCode
  | NetworkErrorCode
  | DatabaseErrorCode
  | ValidationErrorCode;
```

---

## Error Code Reference

### 1. Search Errors (SEARCH_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `SEARCH_QUERY_EMPTY` | 400 | No | Search query is empty or contains only whitespace |
| `SEARCH_QUERY_TOO_LONG` | 400 | No | Query exceeds maximum length (500 characters) |
| `SEARCH_QUERY_INVALID_SYNTAX` | 400 | No | Query contains invalid FTS5 syntax |
| `SEARCH_NO_RESULTS` | 200 | No | Query executed successfully but returned no matches |
| `SEARCH_INDEX_UNAVAILABLE` | 503 | Yes | FTS5 index is being rebuilt or unavailable |
| `SEARCH_INDEX_CORRUPTED` | 500 | No | FTS5 index corruption detected |
| `SEARCH_TIMEOUT` | 504 | Yes | Search query exceeded timeout (500ms) |
| `SEARCH_FILTER_INVALID` | 400 | No | Invalid filter parameter value |

#### SEARCH_QUERY_EMPTY

```typescript
{
  success: false,
  error: {
    code: 'SEARCH_QUERY_EMPTY',
    message: 'Search query cannot be empty.',
    http_status: 400,
    retriable: false,
    recovery_suggestions: [
      'Provide a search term describing the skill you need',
      'Example: search "react testing" or search "python debugging"'
    ],
    documentation_url: 'https://docs.discovery.claude.ai/search#query-syntax'
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_abc123'
  }
}
```

#### SEARCH_INDEX_UNAVAILABLE

```typescript
{
  success: false,
  error: {
    code: 'SEARCH_INDEX_UNAVAILABLE',
    message: 'Search index is temporarily unavailable. Please try again in a moment.',
    http_status: 503,
    retriable: true,
    retry_after_ms: 5000,
    recovery_suggestions: [
      'Wait 5-10 seconds and retry',
      'Index rebuilding typically completes within 30 seconds',
      'Run "sync status" to check index status'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_def456',
    server: 'discovery-core'
  }
}
```

#### SEARCH_NO_RESULTS

```typescript
{
  success: false,
  error: {
    code: 'SEARCH_NO_RESULTS',
    message: 'No skills found matching your query.',
    http_status: 200,
    retriable: false,
    details: {
      query: 'obscure-framework-xyz',
      filters_applied: { trust_tier: ['verified'] },
      suggestions: [
        'Try broader search terms',
        'Remove trust tier filters',
        'Check spelling'
      ]
    },
    recovery_suggestions: [
      'Try searching for "framework" or related technologies',
      'Remove the trust_tier filter to include community skills',
      'Run "recommend_skills" for automatic recommendations'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_ghi789'
  }
}
```

---

### 2. Installation Errors (INSTALL_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `INSTALL_SKILL_NOT_FOUND` | 404 | No | Requested skill ID does not exist in index |
| `INSTALL_ALREADY_INSTALLED` | 409 | No | Skill is already installed at same or newer version |
| `INSTALL_VERSION_NOT_FOUND` | 404 | No | Requested version does not exist |
| `INSTALL_CONFLICT_DETECTED` | 409 | No | Skill conflicts with existing installed skill |
| `INSTALL_BUDGET_EXCEEDED` | 413 | No | Installation would exceed character budget |
| `INSTALL_DOWNLOAD_FAILED` | 502 | Yes | Failed to download skill from source |
| `INSTALL_WRITE_FAILED` | 500 | Yes | Failed to write skill files to disk |
| `INSTALL_PATH_INVALID` | 400 | No | Target installation path is invalid |
| `INSTALL_BLOCKED_SKILL` | 403 | No | Skill is on the security blocklist |
| `INSTALL_ROLLBACK_FAILED` | 500 | No | Installation failed and rollback also failed |

#### INSTALL_CONFLICT_DETECTED

```typescript
{
  success: false,
  error: {
    code: 'INSTALL_CONFLICT_DETECTED',
    message: 'This skill conflicts with an already installed skill.',
    http_status: 409,
    retriable: false,
    details: {
      skill_id: 'github/author/react-testing-v2',
      conflicts_with: [
        {
          skill_id: 'github/other/react-testing',
          conflict_type: 'trigger_overlap',
          overlapping_triggers: ['test', 'react test'],
          severity: 'high'
        }
      ]
    },
    recovery_suggestions: [
      'Uninstall "github/other/react-testing" first',
      'Use force=true to install anyway (may cause unexpected behavior)',
      'Choose a different testing skill that does not conflict'
    ],
    documentation_url: 'https://docs.discovery.claude.ai/conflicts'
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_jkl012'
  }
}
```

#### INSTALL_BUDGET_EXCEEDED

```typescript
{
  success: false,
  error: {
    code: 'INSTALL_BUDGET_EXCEEDED',
    message: 'Installing this skill would exceed your character budget.',
    http_status: 413,
    retriable: false,
    details: {
      skill_id: 'github/author/large-skill',
      skill_size_chars: 15000,
      current_usage_chars: 85000,
      budget_limit_chars: 95000,
      remaining_chars: 10000
    },
    recovery_suggestions: [
      'Uninstall unused skills to free up budget',
      'Run "audit_activation" to see current budget usage',
      'This skill requires 15,000 characters but only 10,000 remain'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_mno345'
  }
}
```

#### INSTALL_BLOCKED_SKILL

```typescript
{
  success: false,
  error: {
    code: 'INSTALL_BLOCKED_SKILL',
    message: 'This skill has been blocked for security reasons.',
    http_status: 403,
    retriable: false,
    details: {
      skill_id: 'github/suspicious/malware-skill',
      block_reason: 'Contains obfuscated code and external data exfiltration',
      blocked_by: 'security',
      blocked_at: '2025-12-20T00:00:00Z',
      severity: 'critical'
    },
    recovery_suggestions: [
      'Choose a different skill with similar functionality',
      'Search for verified alternatives using trust_tier filter',
      'If you believe this is an error, report at security@claude.ai'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_pqr678'
  }
}
```

---

### 3. Synchronization Errors (SYNC_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `SYNC_IN_PROGRESS` | 409 | Yes | Another sync operation is already running |
| `SYNC_LOCK_TIMEOUT` | 408 | Yes | Failed to acquire sync lock within timeout |
| `SYNC_SOURCE_UNAVAILABLE` | 502 | Yes | External source (GitHub, SkillsMP) is unreachable |
| `SYNC_RATE_LIMITED` | 429 | Yes | Rate limit exceeded for external API |
| `SYNC_AUTH_EXPIRED` | 401 | No | GitHub token or other auth has expired |
| `SYNC_MERGE_CONFLICT` | 409 | No | Conflicting updates from multiple sources |
| `SYNC_PARTIAL_FAILURE` | 207 | No | Some sources synced successfully, others failed |
| `SYNC_CANCELLED` | 499 | No | Sync was cancelled by user request |

#### SYNC_RATE_LIMITED

```typescript
{
  success: false,
  error: {
    code: 'SYNC_RATE_LIMITED',
    message: 'GitHub API rate limit exceeded. Sync will resume automatically.',
    http_status: 429,
    retriable: true,
    retry_after_ms: 3600000,
    details: {
      source: 'github',
      rate_limit_remaining: 0,
      rate_limit_reset: '2025-12-26T11:30:00Z',
      skills_synced_before_limit: 1250
    },
    recovery_suggestions: [
      'Wait until rate limit resets (1 hour)',
      'Sync will automatically resume at 11:30 UTC',
      'Consider authenticating with a GitHub token for higher limits'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_stu901',
    server: 'sync'
  }
}
```

#### SYNC_PARTIAL_FAILURE

```typescript
{
  success: false,
  error: {
    code: 'SYNC_PARTIAL_FAILURE',
    message: 'Sync completed with partial failures. Some sources could not be reached.',
    http_status: 207,
    retriable: false,
    details: {
      successful_sources: ['github', 'mcp-so'],
      failed_sources: [
        { source: 'skillsmp', error: 'Connection timeout' },
        { source: 'claude-plugins', error: 'HTTP 503' }
      ],
      skills_synced: 45230,
      skills_failed: 0
    },
    recovery_suggestions: [
      'Failed sources will be retried on next scheduled sync',
      'Run "sync status" to monitor source health',
      'Manual retry available in 15 minutes'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_vwx234',
    server: 'sync'
  }
}
```

---

### 4. Security Errors (SECURITY_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `SECURITY_SCAN_FAILED` | 500 | Yes | Security scanner encountered an error |
| `SECURITY_RISK_DETECTED` | 403 | No | Skill contains security risks above threshold |
| `SECURITY_BLOCKLIST_HIT` | 403 | No | Skill or author is on blocklist |
| `SECURITY_TRUST_TIER_INSUFFICIENT` | 403 | No | Skill trust tier below user's minimum setting |
| `SECURITY_SIGNATURE_INVALID` | 403 | No | Skill signature verification failed |
| `SECURITY_TYPOSQUATTING_DETECTED` | 403 | No | Skill name suspiciously similar to popular skill |

#### SECURITY_RISK_DETECTED

```typescript
{
  success: false,
  error: {
    code: 'SECURITY_RISK_DETECTED',
    message: 'Security scan detected risks in this skill. Installation blocked.',
    http_status: 403,
    retriable: false,
    details: {
      skill_id: 'github/unknown/risky-skill',
      risk_score: 75,
      findings: [
        {
          type: 'external_url',
          severity: 'high',
          description: 'Contains hardcoded URLs to unknown domains',
          locations: ['SKILL.md:45', 'SKILL.md:67']
        },
        {
          type: 'shell_command',
          severity: 'medium',
          description: 'Suggests running shell commands without explanation',
          locations: ['SKILL.md:102']
        }
      ]
    },
    recovery_suggestions: [
      'Review the security findings before proceeding',
      'Use skip_security_scan=true only if you trust this source',
      'Consider choosing a verified alternative skill'
    ],
    documentation_url: 'https://docs.discovery.claude.ai/security'
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_yza567'
  }
}
```

#### SECURITY_TYPOSQUATTING_DETECTED

```typescript
{
  success: false,
  error: {
    code: 'SECURITY_TYPOSQUATTING_DETECTED',
    message: 'This skill name is suspiciously similar to a popular skill.',
    http_status: 403,
    retriable: false,
    details: {
      skill_id: 'github/unknown/reakt-testing',
      similar_to: 'github/official/react-testing',
      similarity_score: 0.92,
      levenshtein_distance: 1
    },
    recovery_suggestions: [
      'Did you mean "github/official/react-testing"?',
      'Verify you have the correct skill ID',
      'Use force=true if you are certain this is the correct skill'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_bcd890'
  }
}
```

---

### 5. Configuration Errors (CONFIG_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `CONFIG_NOT_FOUND` | 404 | No | Configuration key does not exist |
| `CONFIG_INVALID_VALUE` | 400 | No | Configuration value is invalid for the key type |
| `CONFIG_PERMISSION_DENIED` | 403 | No | Cannot modify system configuration |
| `CONFIG_SCHEMA_MISMATCH` | 400 | No | Configuration file schema version mismatch |
| `CONFIG_MIGRATION_FAILED` | 500 | Yes | Failed to migrate configuration to new schema |

#### CONFIG_INVALID_VALUE

```typescript
{
  success: false,
  error: {
    code: 'CONFIG_INVALID_VALUE',
    message: 'Invalid configuration value provided.',
    http_status: 400,
    retriable: false,
    details: {
      key: 'trust_tier_minimum',
      provided_value: 'super-trusted',
      expected_type: 'enum',
      valid_values: ['official', 'verified', 'community', 'unverified']
    },
    recovery_suggestions: [
      'Use one of the valid values: official, verified, community, unverified',
      'Run "config show trust_tier_minimum" to see current value'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_efg123'
  }
}
```

---

### 6. Network Errors (NETWORK_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `NETWORK_TIMEOUT` | 504 | Yes | Request to external service timed out |
| `NETWORK_CONNECTION_REFUSED` | 502 | Yes | External service refused connection |
| `NETWORK_DNS_FAILED` | 502 | Yes | DNS resolution failed |
| `NETWORK_SSL_ERROR` | 502 | No | SSL/TLS certificate validation failed |
| `NETWORK_OFFLINE` | 503 | Yes | No network connectivity detected |
| `NETWORK_RATE_LIMITED` | 429 | Yes | External API rate limit exceeded |

#### NETWORK_OFFLINE

```typescript
{
  success: false,
  error: {
    code: 'NETWORK_OFFLINE',
    message: 'No network connectivity. Using cached data where available.',
    http_status: 503,
    retriable: true,
    retry_after_ms: 30000,
    details: {
      last_successful_connection: '2025-12-26T09:45:00Z',
      cache_available: true,
      cache_age_minutes: 45
    },
    recovery_suggestions: [
      'Check your internet connection',
      'Cached search results are available (45 minutes old)',
      'Install operations are unavailable offline'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_hij456'
  }
}
```

#### NETWORK_TIMEOUT

```typescript
{
  success: false,
  error: {
    code: 'NETWORK_TIMEOUT',
    message: 'Request to GitHub timed out after 30 seconds.',
    http_status: 504,
    retriable: true,
    retry_after_ms: 5000,
    details: {
      target_url: 'https://api.github.com/repos/author/skill',
      timeout_ms: 30000,
      attempt: 2,
      max_attempts: 3
    },
    recovery_suggestions: [
      'Automatic retry in 5 seconds (attempt 3 of 3)',
      'Check https://githubstatus.com for service issues',
      'Try again later if retries fail'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_klm789'
  }
}
```

---

### 7. Database Errors (DATABASE_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `DATABASE_LOCKED` | 409 | Yes | SQLite database is locked by another operation |
| `DATABASE_CORRUPTED` | 500 | No | SQLite database corruption detected |
| `DATABASE_DISK_FULL` | 507 | No | Insufficient disk space for database operation |
| `DATABASE_READONLY` | 403 | No | Database is in read-only mode |
| `DATABASE_CONSTRAINT_VIOLATION` | 409 | No | Unique or foreign key constraint violated |
| `DATABASE_MIGRATION_PENDING` | 503 | Yes | Database migration in progress |

#### DATABASE_LOCKED

```typescript
{
  success: false,
  error: {
    code: 'DATABASE_LOCKED',
    message: 'Database is temporarily locked. Please try again.',
    http_status: 409,
    retriable: true,
    retry_after_ms: 100,
    details: {
      lock_holder: 'sync',
      lock_type: 'exclusive',
      wait_time_ms: 5000
    },
    recovery_suggestions: [
      'Automatic retry in 100ms',
      'A sync operation is writing to the database',
      'This typically resolves within a few seconds'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_nop012',
    server: 'discovery-core'
  }
}
```

#### DATABASE_CORRUPTED

```typescript
{
  success: false,
  error: {
    code: 'DATABASE_CORRUPTED',
    message: 'Database corruption detected. Recovery required.',
    http_status: 500,
    retriable: false,
    details: {
      database: 'skills.db',
      corruption_type: 'page_checksum_mismatch',
      affected_tables: ['skills', 'skills_fts']
    },
    recovery_suggestions: [
      'Run "sqlite3 ~/.skillsmith/index/skills.db .recover" to attempt recovery',
      'Delete ~/.skillsmith/index/skills.db and run "sync full" to rebuild',
      'Check disk health if corruption recurs'
    ],
    documentation_url: 'https://docs.discovery.claude.ai/troubleshooting#database-recovery'
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_qrs345'
  }
}
```

---

### 8. Validation Errors (VALIDATION_*)

| Code | HTTP Status | Retriable | Description |
|------|-------------|-----------|-------------|
| `VALIDATION_REQUIRED_FIELD` | 400 | No | Required parameter is missing |
| `VALIDATION_INVALID_FORMAT` | 400 | No | Parameter format is invalid |
| `VALIDATION_OUT_OF_RANGE` | 400 | No | Numeric parameter outside valid range |
| `VALIDATION_SKILL_ID_INVALID` | 400 | No | Skill ID format is invalid |
| `VALIDATION_PATH_INVALID` | 400 | No | File path is invalid or inaccessible |
| `VALIDATION_FRONTMATTER_INVALID` | 400 | No | SKILL.md frontmatter YAML is invalid |

#### VALIDATION_SKILL_ID_INVALID

```typescript
{
  success: false,
  error: {
    code: 'VALIDATION_SKILL_ID_INVALID',
    message: 'Invalid skill ID format.',
    http_status: 400,
    retriable: false,
    details: {
      provided_id: 'react-testing',
      expected_format: 'source/author/name',
      examples: [
        'github/facebook/react-testing',
        'skillsmp/author/skill-name',
        'mcp-so/provider/server-name'
      ]
    },
    recovery_suggestions: [
      'Use the full skill ID in format: source/author/name',
      'Search for the skill to find its correct ID',
      'Use autocomplete or copy ID from search results'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_tuv678'
  }
}
```

#### VALIDATION_FRONTMATTER_INVALID

```typescript
{
  success: false,
  error: {
    code: 'VALIDATION_FRONTMATTER_INVALID',
    message: 'Skill frontmatter contains invalid YAML.',
    http_status: 400,
    retriable: false,
    details: {
      skill_id: 'github/author/my-skill',
      yaml_error: 'Unexpected mapping key at line 5',
      line_number: 5,
      expected_fields: ['trigger', 'description', 'version'],
      provided_fields: ['trigger', 'descriptin']
    },
    recovery_suggestions: [
      'Check YAML syntax at line 5',
      'Field "descriptin" may be a typo for "description"',
      'Validate YAML at https://yaml-online-parser.appspot.com/'
    ]
  },
  metadata: {
    timestamp: '2025-12-26T10:30:00Z',
    request_id: 'req_wxy901'
  }
}
```

---

## Error Classification Matrix

### Retriability by Category

| Category | Retriable Errors | Non-Retriable Errors |
|----------|------------------|----------------------|
| SEARCH_* | INDEX_UNAVAILABLE, TIMEOUT | QUERY_EMPTY, QUERY_TOO_LONG, QUERY_INVALID_SYNTAX, NO_RESULTS, INDEX_CORRUPTED, FILTER_INVALID |
| INSTALL_* | DOWNLOAD_FAILED, WRITE_FAILED | SKILL_NOT_FOUND, ALREADY_INSTALLED, VERSION_NOT_FOUND, CONFLICT_DETECTED, BUDGET_EXCEEDED, PATH_INVALID, BLOCKED_SKILL, ROLLBACK_FAILED |
| SYNC_* | IN_PROGRESS, LOCK_TIMEOUT, SOURCE_UNAVAILABLE, RATE_LIMITED | AUTH_EXPIRED, MERGE_CONFLICT, PARTIAL_FAILURE, CANCELLED |
| SECURITY_* | SCAN_FAILED | RISK_DETECTED, BLOCKLIST_HIT, TRUST_TIER_INSUFFICIENT, SIGNATURE_INVALID, TYPOSQUATTING_DETECTED |
| CONFIG_* | MIGRATION_FAILED | NOT_FOUND, INVALID_VALUE, PERMISSION_DENIED, SCHEMA_MISMATCH |
| NETWORK_* | TIMEOUT, CONNECTION_REFUSED, DNS_FAILED, OFFLINE, RATE_LIMITED | SSL_ERROR |
| DATABASE_* | LOCKED, MIGRATION_PENDING | CORRUPTED, DISK_FULL, READONLY, CONSTRAINT_VIOLATION |
| VALIDATION_* | (none) | REQUIRED_FIELD, INVALID_FORMAT, OUT_OF_RANGE, SKILL_ID_INVALID, PATH_INVALID, FRONTMATTER_INVALID |

### Fallback Strategies by Category

| Category | Cache Fallback | Degraded Mode | Automatic Recovery |
|----------|----------------|---------------|-------------------|
| SEARCH_* | Return stale cache | Return fewer results | Rebuild index |
| INSTALL_* | Not applicable | Suggest alternatives | Rollback on failure |
| SYNC_* | Use existing index | Skip failed sources | Schedule retry |
| SECURITY_* | Not applicable | Warn and proceed | Not applicable |
| CONFIG_* | Use defaults | Not applicable | Migrate on startup |
| NETWORK_* | Return cached data | Offline mode | Auto-retry with backoff |
| DATABASE_* | Not applicable | Read-only mode | Attempt recovery |
| VALIDATION_* | Not applicable | Not applicable | Not applicable |

---

## Recovery Strategies by Category

### SEARCH_* Recovery

```typescript
// Automatic retry with exponential backoff for retriable errors
const searchRetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 100,
  max_delay_ms: 2000,
  backoff_multiplier: 2,
  retriable_codes: ['SEARCH_INDEX_UNAVAILABLE', 'SEARCH_TIMEOUT']
};

// Cache fallback for transient failures
function handleSearchError(error: ErrorResponse) {
  if (error.error.code === 'SEARCH_INDEX_UNAVAILABLE') {
    return getCachedResults() || { results: [], stale: true };
  }
  throw error;
}
```

### INSTALL_* Recovery

```typescript
// Transaction-based installation with automatic rollback
async function safeInstall(skillId: string) {
  const checkpoint = createCheckpoint();
  try {
    await installSkill(skillId);
    return { success: true };
  } catch (error) {
    await rollbackToCheckpoint(checkpoint);
    if (error.code === 'INSTALL_DOWNLOAD_FAILED') {
      // Retriable - schedule for later
      await scheduleRetry(skillId, error.retry_after_ms);
    }
    throw error;
  }
}
```

### SYNC_* Recovery

```typescript
// Partial sync recovery
async function handleSyncError(error: ErrorResponse) {
  if (error.error.code === 'SYNC_PARTIAL_FAILURE') {
    // Record failed sources for targeted retry
    const failedSources = error.error.details?.failed_sources || [];
    await scheduleSourceRetry(failedSources);
    return { partial: true, synced: error.error.details?.skills_synced };
  }

  if (error.error.code === 'SYNC_RATE_LIMITED') {
    // Schedule resume after rate limit reset
    await scheduleSyncResume(error.error.retry_after_ms);
  }
}
```

### NETWORK_* Recovery

```typescript
// Network error handling with offline support
const networkFallbackPolicy = {
  enable_cache_fallback: true,
  cache_max_age_hours: 24,
  offline_mode_enabled: true,
  health_check_interval_ms: 30000
};

function handleNetworkError(error: ErrorResponse) {
  if (error.error.code === 'NETWORK_OFFLINE') {
    enableOfflineMode();
    return { offline: true, cached: getCachedData() };
  }
}
```

### DATABASE_* Recovery

```typescript
// Database recovery procedures
async function handleDatabaseError(error: ErrorResponse) {
  switch (error.error.code) {
    case 'DATABASE_LOCKED':
      // Wait and retry
      await delay(error.error.retry_after_ms);
      return retry();

    case 'DATABASE_CORRUPTED':
      // Attempt automatic recovery
      const recovered = await attemptRecovery();
      if (!recovered) {
        await notifyUserManualRecovery();
      }
      break;

    case 'DATABASE_DISK_FULL':
      await cleanupCache();
      await vacuumDatabase();
      break;
  }
}
```

---

## Error Handling Best Practices

### 1. Always Check Success Field

```typescript
const response = await mcpTool.search({ query: 'react' });
if (!response.success) {
  // Handle error
  console.error(`Error: ${response.error.message}`);
  return;
}
// Process response.data
```

### 2. Log Request IDs for Debugging

```typescript
if (!response.success) {
  console.error(`Request ${response.metadata?.request_id} failed: ${response.error.code}`);
}
```

### 3. Present Recovery Suggestions to Users

```typescript
if (!response.success && response.error.recovery_suggestions) {
  console.log('To resolve this issue, try:');
  response.error.recovery_suggestions.forEach((suggestion, i) => {
    console.log(`  ${i + 1}. ${suggestion}`);
  });
}
```

### 4. Respect Retry-After Headers

```typescript
if (!response.success && response.error.retriable) {
  const delay = response.error.retry_after_ms || 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
  return retry();
}
```

---

## References

- [Backend API Architecture](/docs/architecture/backend-api.md) - Error handling flow
- [Data Schema](/docs/implementation/artifacts/data-schema.md) - Database structures
- [MCP Server Specification](/docs/technical/components/mcp-servers.md) - Tool interfaces
- [Security Design](/docs/research/skill-conflicts-security.md) - Security error context

---

*Error Codes Version: 1.0*
*Last Updated: December 26, 2025*
*Total Error Codes: 44*
