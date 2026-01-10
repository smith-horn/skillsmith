# Skillsmith E2E Testing Plan - Phase 4.5

**Created**: 2026-01-01
**Status**: Implemented (with modifications)
**Related Issues**: SMI-902, SMI-904 (hardcoded data patterns)

> **Update (January 2026)**: The external test repository (`021-school-platform`) requirement has been removed. E2E tests now run against the Skillsmith codebase itself, eliminating external dependencies and CI annotation warnings.

## Executive Summary

This plan defines comprehensive end-to-end testing for Skillsmith to validate all CLI commands and MCP server tools against real repositories before Phase 5. Tests run in GitHub Codespaces to ensure clean environment isolation and catch hardcoded values that pass unit tests but fail in production.

## Objectives

1. **Smoke out hardcoded issues** - Detect hardcoded paths, URLs, IDs, tokens, and environment assumptions
2. **Validate user journeys** - Test complete workflows as end users would experience them
3. **Establish performance baselines** - Document metrics for future optimization
4. **Enable regression prevention** - Ensure hardcoded data doesn't creep back

## Test Environment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Codespaces                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                 E2E Test Container                         │  │
│  │                                                            │  │
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │  │
│  │  │  Skillsmith  │   │  Test Repo   │   │   Results    │   │  │
│  │  │  (installed) │   │ 021-school-  │   │  Collector   │   │  │
│  │  │              │   │  platform    │   │              │   │  │
│  │  └──────────────┘   └──────────────┘   └──────────────┘   │  │
│  │                                                            │  │
│  │  Clean user environment - no dev artifacts                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                                          │
         ▼                                          ▼
┌─────────────────┐                     ┌─────────────────────┐
│  Linear API     │                     │  GitHub Actions     │
│  (Issue Create) │                     │  (CI/CD Trigger)    │
└─────────────────┘                     └─────────────────────┘
```

### Why GitHub Codespaces?

| Concern | Dev Docker | Codespace |
|---------|-----------|-----------|
| Environment pollution | Risk of dev artifacts | Clean slate |
| Hardcoded path detection | May use cached values | Fails fast on `/Users/...` |
| User experience simulation | Developer context | True user context |
| CI/CD integration | Manual setup | Native GitHub Actions |

## Test Scope

### Phase A: CLI Commands (First Priority)

| Command | Options to Test | User Journey |
|---------|-----------------|--------------|
| `import` | `-t topic`, `-m max`, `-d db`, `-v` | Import skills from GitHub topic |
| `search` | `-i`, `-l`, `-t tier`, `-s score` | Find skills interactively |
| `list` | (none) | View installed skills |
| `update` | `-a`, specific skill | Update skill versions |
| `remove` | `-f` | Uninstall skills |
| `init` | `-p path`, name | Create new skill project |
| `validate` | path | Validate SKILL.md structure |
| `publish` | path | Prepare skill for sharing |

### Phase B: MCP Server Tools (After CLI passes)

| Tool | Parameters | User Journey |
|------|-----------|--------------|
| `search` | query, category, trust_tier, min_score, limit | Discover skills via MCP |
| `get_skill` | id | Get skill details |
| `install` | skill_id | Install skill to ~/.claude/skills |
| `uninstall` | skill_id | Remove installed skill |
| `recommend` | context, requirements | Get contextual recommendations |
| `validate` | skill_id or path | Validate skill structure |
| `compare` | skill_ids[] | Side-by-side comparison |
| `suggest` | context | Suggest skills for context |

## Test Repository

**Primary**: `https://github.com/wrsmith108/021-school-platform`

### Repository Selection Criteria
- Real-world complexity
- Multiple file types and structures
- Suitable for skill discovery testing
- Never create PRs to this repository

### Future Edge Case Repositories
After initial E2E passes, identify repos for:
- Monorepo structures
- Minimal projects (single file)
- Non-Node.js projects
- Projects with existing SKILL.md files

## Hardcoded Value Detection Strategy

### Detection Patterns

```typescript
const HARDCODED_PATTERNS = {
  // User-specific paths
  userPaths: [
    /\/Users\/[a-zA-Z0-9_-]+\//,
    /\/home\/[a-zA-Z0-9_-]+\//,
    /C:\\Users\\[a-zA-Z0-9_-]+\\/,
  ],

  // Localhost/dev URLs
  devUrls: [
    /localhost:\d+/,
    /127\.0\.0\.1:\d+/,
    /0\.0\.0\.0:\d+/,
  ],

  // Hardcoded IDs/tokens
  credentials: [
    /sk-[a-zA-Z0-9]{32,}/,         // API keys
    /ghp_[a-zA-Z0-9]{36}/,         // GitHub tokens
    /lin_api_[a-zA-Z0-9]+/,        // Linear API keys
  ],

  // Environment assumptions
  envAssumptions: [
    /process\.env\.[A-Z_]+(?!\s*\|\|)/,  // Env vars without fallback
    /\.skillsmith\/skills\.db/,           // Hardcoded DB path
  ],
};
```

### Detection Implementation

1. **Runtime Detection**: Intercept and log all file path operations
2. **Output Scanning**: Scan stdout/stderr for pattern matches
3. **Environment Validation**: Verify no dev environment variables leak
4. **Database Inspection**: Check stored values for hardcoded data

### On Detection: Linear Issue Creation

```typescript
interface HardcodedIssue {
  type: 'path' | 'url' | 'credential' | 'env_assumption';
  value: string;
  location: {
    file: string;
    line: number;
    function: string;
  };
  command: string;  // CLI command or MCP tool that exposed it
  stackTrace: string;
  timestamp: string;
}

// Auto-create Linear issue with evidence
async function createLinearIssue(issue: HardcodedIssue): Promise<string> {
  const title = `[E2E] Hardcoded ${issue.type} detected in ${issue.command}`;
  const description = `
## Problem Definition

A hardcoded ${issue.type} was detected during E2E testing.

**Detected Value**: \`${maskSensitive(issue.value)}\`
**Location**: ${issue.location.file}:${issue.location.line}
**Function**: ${issue.location.function}
**Command**: \`${issue.command}\`

## Evidence

\`\`\`
${issue.stackTrace}
\`\`\`

## Recommended Fix

Replace hardcoded value with:
- Environment variable with fallback
- User-configurable option
- Platform-agnostic path resolution

## Test Environment

- Container: GitHub Codespaces
- Test Repository: 021-school-platform
- Timestamp: ${issue.timestamp}
`;

  return linearClient.createIssue({
    project: 'Skillsmith',
    title,
    description,
    labels: ['bug', 'e2e', 'hardcoded'],
    priority: 'high',
  });
}
```

## Test Cases by User Journey

### Journey 1: Skill Discovery and Installation

```gherkin
Feature: Discover and install skills from GitHub

  Background:
    Given a clean Codespace environment
    And skillsmith CLI is installed globally
    And test repository 021-school-platform is cloned

  Scenario: Import skills from GitHub topic
    When I run "skillsmith import -t claude-skill -m 10 -v"
    Then the command exits with code 0
    And at least 1 skill is imported
    And the database is created at the default location
    And no hardcoded paths appear in output
    And execution time is recorded for baseline

  Scenario: Search for imported skills
    Given skills have been imported
    When I run "skillsmith search testing"
    Then matching skills are displayed
    And results include trust tier and score
    And no localhost URLs appear in output

  Scenario: Interactive search mode
    Given skills have been imported
    When I run "skillsmith search -i"
    Then interactive mode launches
    And I can navigate results
    And selection returns skill details

  Scenario: Install a skill
    Given skills have been imported
    When I run "skillsmith list"
    Then installed skills are shown (may be empty)
    When I select a skill from search results
    And I install it via MCP tool
    Then the skill appears in ~/.claude/skills/
    And skill structure is valid

  Scenario: Update installed skills
    Given a skill is installed
    When I run "skillsmith update -a"
    Then all skills are checked for updates
    And updated skills are reported
```

### Journey 2: Skill Authoring

```gherkin
Feature: Create and validate custom skills

  Scenario: Initialize new skill project
    When I run "skillsmith init my-skill -p ./skills"
    Then directory ./skills/my-skill is created
    And SKILL.md template exists
    And README.md exists
    And scripts/example.js exists
    And .gitignore exists

  Scenario: Validate skill structure
    Given a skill project exists
    When I run "skillsmith validate ./skills/my-skill"
    Then validation passes or reports specific errors
    And no hardcoded validation paths appear

  Scenario: Prepare skill for publishing
    Given a valid skill project
    When I run "skillsmith publish ./skills/my-skill"
    Then .skillsmith-publish.json is created
    And checksum is generated
    And publishing instructions are displayed
```

### Journey 3: MCP Tool Integration

```gherkin
Feature: MCP server tools work correctly

  Scenario: Search via MCP
    Given MCP server is running
    When I call search tool with query "testing"
    Then results are returned
    And timing metrics are captured
    And no hardcoded data in response

  Scenario: Recommend skills for context
    Given MCP server is running
    And I'm in the 021-school-platform directory
    When I call recommend tool with project context
    Then relevant skills are suggested
    And recommendations are not hardcoded
    And response time is recorded

  Scenario: Compare skills
    Given MCP server is running
    When I call compare tool with ["skill-a", "skill-b"]
    Then comparison table is returned
    And metrics are accurate (not hardcoded)

  Scenario: Validate external skill
    Given MCP server is running
    When I call validate tool with a GitHub URL
    Then skill is fetched and validated
    And no localhost URLs used for fetch
```

## Performance Baseline Metrics

### Metrics to Capture

| Metric | Command/Tool | Target | Measurement |
|--------|-------------|--------|-------------|
| Import time | `import -m 100` | Establish baseline | Total seconds |
| Search latency | `search <query>` | <100ms | Median, P95, P99 |
| Get skill latency | `get_skill` | <50ms | Median, P95, P99 |
| Install time | `install` | Establish baseline | Total seconds |
| Memory usage | All commands | Establish baseline | Peak MB |
| Database size | After import | Establish baseline | MB per 100 skills |
| Recommend latency | `recommend` | Establish baseline | Median, P95, P99 |

### Baseline Output Format

```json
{
  "timestamp": "2026-01-01T00:00:00Z",
  "environment": {
    "type": "codespace",
    "nodeVersion": "20.x",
    "platform": "linux-x64"
  },
  "baselines": {
    "import": {
      "skills100": { "seconds": 45.2, "memoryMB": 128 }
    },
    "search": {
      "medianMs": 23,
      "p95Ms": 45,
      "p99Ms": 82
    },
    "recommend": {
      "medianMs": 156,
      "p95Ms": 289,
      "p99Ms": 412
    }
  }
}
```

## Output Formats

### 1. JUnit XML (CI Integration)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Skillsmith E2E" tests="42" failures="2" time="123.45">
  <testsuite name="CLI Commands" tests="24" failures="1">
    <testcase name="import: basic import" time="12.3"/>
    <testcase name="search: query returns results" time="0.05"/>
    <testcase name="recommend: no hardcoded data" time="0.2">
      <failure message="Hardcoded path detected">
        Found: /Users/williamsmith/skills in output
      </failure>
    </testcase>
  </testsuite>
</testsuites>
```

### 2. JSON (Programmatic Analysis)

```json
{
  "summary": {
    "total": 42,
    "passed": 40,
    "failed": 2,
    "duration": 123.45
  },
  "hardcodedIssues": [
    {
      "type": "path",
      "value": "/Users/williamsmith/skills",
      "command": "recommend",
      "linearIssue": "SMI-950"
    }
  ],
  "baselines": { /* ... */ },
  "testResults": [ /* ... */ ]
}
```

### 3. Markdown Report (docs/testing/results/)

```markdown
# E2E Test Results - 2026-01-01

## Summary
- **Total Tests**: 42
- **Passed**: 40 (95.2%)
- **Failed**: 2 (4.8%)
- **Duration**: 123.45s

## Hardcoded Issues Detected

| Type | Value | Command | Linear Issue |
|------|-------|---------|--------------|
| path | /Users/.../skills | recommend | SMI-950 |

## Performance Baselines

| Metric | Value | Notes |
|--------|-------|-------|
| search p95 | 45ms | First baseline |
| recommend median | 156ms | First baseline |

## Failed Tests

### recommend: no hardcoded data
**Error**: Hardcoded path detected
**Evidence**: Found `/Users/williamsmith/skills` in output
**Linear Issue**: [SMI-950](link)
```

## GitHub Actions Workflow

```yaml
name: E2E Tests (Codespace)

on:
  push:
    branches: [e2e-testing, main]
  pull_request:
    branches: [e2e-testing, main]
  workflow_dispatch:

jobs:
  e2e-tests:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Clone test repository
        run: |
          git clone https://github.com/wrsmith108/021-school-platform.git /tmp/test-repo

      - name: Install Skillsmith globally
        run: |
          cd skillsmith
          npm ci
          npm run build
          npm link

      - name: Run CLI E2E tests
        id: cli-tests
        run: |
          cd skillsmith
          npm run test:e2e:cli
        continue-on-error: true

      - name: Run MCP E2E tests
        id: mcp-tests
        if: steps.cli-tests.outcome == 'success'
        run: |
          cd skillsmith
          npm run test:e2e:mcp

      - name: Generate reports
        run: |
          cd skillsmith
          npm run test:e2e:report

      - name: Upload JUnit results
        uses: actions/upload-artifact@v4
        with:
          name: junit-results
          path: skillsmith/test-results/junit.xml

      - name: Upload JSON results
        uses: actions/upload-artifact@v4
        with:
          name: json-results
          path: skillsmith/test-results/results.json

      - name: Create Linear issues for failures
        if: failure()
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
        run: |
          cd skillsmith
          npm run test:e2e:create-issues
```

## Devcontainer Configuration

```json
// .devcontainer/devcontainer.json
{
  "name": "Skillsmith E2E",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:20",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {}
  },
  "postCreateCommand": "npm ci && npm run build && npm link",
  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode"
      ]
    }
  },
  "forwardPorts": [3001],
  "remoteEnv": {
    "NODE_ENV": "test",
    "SKILLSMITH_E2E": "true"
  }
}
```

## Implementation Sequence

### Week 1: Foundation
1. Create `.devcontainer/devcontainer.json`
2. Create E2E test infrastructure in `packages/cli/tests/e2e/`
3. Implement hardcoded detection utilities
4. Create Linear issue auto-creation script

### Week 2: CLI Tests
5. Implement `import` command E2E tests
6. Implement `search` command E2E tests
7. Implement `list`, `update`, `remove` E2E tests
8. Implement `init`, `validate`, `publish` E2E tests

### Week 3: MCP Tests
9. Implement MCP tool E2E tests
10. Focus on `recommend` tool (known issues)
11. Implement `suggest` tool tests (currently untested)
12. Implement `compare` and `validate` tool tests

### Week 4: Integration
13. Create GitHub Actions workflow
14. Integrate Linear auto-issue creation
15. Generate baseline performance report
16. Documentation and handoff

## Success Criteria

- [ ] All CLI commands have E2E tests
- [ ] All MCP tools have E2E tests
- [ ] Zero hardcoded values detected in clean Codespace
- [ ] Performance baselines documented in Linear
- [ ] GitHub Actions workflow passes on main
- [ ] Linear issues auto-created for any failures

## Appendix A: Files to Create

```
skillsmith/
├── .devcontainer/
│   └── devcontainer.json           # Codespace configuration
├── packages/
│   ├── cli/
│   │   └── tests/
│   │       └── e2e/
│   │           ├── import.e2e.test.ts
│   │           ├── search.e2e.test.ts
│   │           ├── manage.e2e.test.ts
│   │           ├── author.e2e.test.ts
│   │           └── utils/
│   │               ├── hardcoded-detector.ts
│   │               ├── linear-reporter.ts
│   │               └── baseline-collector.ts
│   └── mcp-server/
│       └── tests/
│           └── e2e/
│               ├── recommend.e2e.test.ts    # Priority
│               ├── suggest.e2e.test.ts      # No tests exist
│               ├── install-flow.e2e.test.ts
│               └── compare.e2e.test.ts
├── docs/
│   └── testing/
│       ├── e2e-testing-plan.md     # This document
│       └── results/                # Test result reports
├── test-results/                   # Generated outputs
│   ├── junit.xml
│   ├── results.json
│   └── baselines.json
├── .github/
│   └── workflows/
│       └── e2e-tests.yml
└── scripts/
    └── e2e/
        ├── run-cli-tests.ts
        ├── run-mcp-tests.ts
        ├── create-linear-issues.ts
        └── generate-report.ts
```

## Appendix B: Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Test repo changes | Pin to specific commit hash |
| API rate limits | Use caching, mock for repeated calls |
| Flaky tests | Retry logic, deterministic setup |
| Long test times | Parallel execution, smart caching |
| Linear API failures | Queue issues locally, retry later |

---

**Next Steps**: Review and approve this plan, then proceed with implementation starting from `.devcontainer/devcontainer.json`.
