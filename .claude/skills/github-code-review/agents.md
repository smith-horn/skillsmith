# Review Agents

Specialized AI agents for comprehensive code review.

---

## Security Review Agent

**Focus:** Identify security vulnerabilities and suggest fixes

```bash
# Get changed files from PR
CHANGED_FILES=$(gh pr view 123 --json files --jq '.files[].path')

# Run security-focused review
SECURITY_RESULTS=$(npx ruv-swarm github review-security \
  --pr 123 \
  --files "$CHANGED_FILES" \
  --check "owasp,cve,secrets,permissions" \
  --suggest-fixes)

# Post findings based on severity
if echo "$SECURITY_RESULTS" | grep -q "critical"; then
  gh pr review 123 --request-changes --body "$SECURITY_RESULTS"
  gh pr edit 123 --add-label "security-review-required"
else
  gh pr comment 123 --body "$SECURITY_RESULTS"
fi
```

### Security Checks Performed

```javascript
{
  "checks": [
    "SQL injection vulnerabilities",
    "XSS attack vectors",
    "Authentication bypasses",
    "Authorization flaws",
    "Cryptographic weaknesses",
    "Dependency vulnerabilities",
    "Secret exposure",
    "CORS misconfigurations"
  ],
  "actions": [
    "Block PR on critical issues",
    "Suggest secure alternatives",
    "Add security test cases",
    "Update security documentation"
  ]
}
```

### Comment Template: Security Issue

```markdown
🔒 **Security Issue: [Type]**

**Severity**: 🔴 Critical / 🟡 High / 🟢 Low

**Description**:
[Clear explanation of the security issue]

**Impact**:
[Potential consequences if not addressed]

**Suggested Fix**:
```language
[Code example of the fix]
```

**References**:
- [OWASP Guide](link)
- [Security Best Practices](link)
```

---

## Performance Review Agent

**Focus:** Analyze performance impact and optimization opportunities

```bash
# Run performance analysis
npx ruv-swarm github review-performance \
  --pr 123 \
  --profile "cpu,memory,io" \
  --benchmark-against main \
  --suggest-optimizations
```

### Performance Metrics Analyzed

```javascript
{
  "metrics": [
    "Algorithm complexity (Big O analysis)",
    "Database query efficiency",
    "Memory allocation patterns",
    "Cache utilization",
    "Network request optimization",
    "Bundle size impact",
    "Render performance"
  ],
  "benchmarks": [
    "Compare with baseline",
    "Load test simulations",
    "Memory leak detection",
    "Bottleneck identification"
  ]
}
```

---

## Architecture Review Agent

**Focus:** Evaluate design patterns and architectural decisions

```bash
# Architecture review
npx ruv-swarm github review-architecture \
  --pr 123 \
  --check "patterns,coupling,cohesion,solid" \
  --visualize-impact \
  --suggest-refactoring
```

### Architecture Analysis

```javascript
{
  "patterns": [
    "Design pattern adherence",
    "SOLID principles",
    "DRY violations",
    "Separation of concerns",
    "Dependency injection",
    "Layer violations",
    "Circular dependencies"
  ],
  "metrics": [
    "Coupling metrics",
    "Cohesion scores",
    "Complexity measures",
    "Maintainability index"
  ]
}
```

---

## Style & Convention Agent

**Focus:** Enforce coding standards and best practices

```bash
# Style enforcement with auto-fix
npx ruv-swarm github review-style \
  --pr 123 \
  --check "formatting,naming,docs,tests" \
  --auto-fix "formatting,imports,whitespace"
```

### Style Checks

```javascript
{
  "checks": [
    "Code formatting",
    "Naming conventions",
    "Documentation standards",
    "Comment quality",
    "Test coverage",
    "Error handling patterns",
    "Logging standards"
  ],
  "auto-fix": [
    "Formatting issues",
    "Import organization",
    "Trailing whitespace",
    "Simple naming issues"
  ]
}
```

---

## Custom Review Agents

### Create Custom Agent

```javascript
// custom-review-agent.js
class CustomReviewAgent {
  constructor(config) {
    this.config = config;
    this.rules = config.rules || [];
  }

  async review(pr) {
    const issues = [];

    // Custom logic: Check for TODO comments in production code
    if (await this.checkTodoComments(pr)) {
      issues.push({
        severity: 'warning',
        file: pr.file,
        line: pr.line,
        message: 'TODO comment found in production code',
        suggestion: 'Resolve TODO or create issue to track it'
      });
    }

    // Custom logic: Verify API versioning
    if (await this.checkApiVersioning(pr)) {
      issues.push({
        severity: 'error',
        file: pr.file,
        line: pr.line,
        message: 'API endpoint missing versioning',
        suggestion: 'Add /v1/, /v2/ prefix to API routes'
      });
    }

    return issues;
  }

  async checkTodoComments(pr) {
    const todoRegex = /\/\/\s*TODO|\/\*\s*TODO/gi;
    return todoRegex.test(pr.diff);
  }

  async checkApiVersioning(pr) {
    const apiRegex = /app\.(get|post|put|delete)\(['"]\/api\/(?!v\d+)/;
    return apiRegex.test(pr.diff);
  }
}

module.exports = CustomReviewAgent;
```

### Register Custom Agent

```bash
# Register custom review agent
npx ruv-swarm github register-agent \
  --name "custom-reviewer" \
  --file "./custom-review-agent.js" \
  --category "standards"
```

---

## Agent Configuration

### Custom Review Triggers

```javascript
{
  "triggers": {
    "high-risk-files": {
      "paths": ["**/auth/**", "**/payment/**", "**/admin/**"],
      "agents": ["security", "architecture"],
      "depth": "comprehensive",
      "require-approval": true
    },
    "performance-critical": {
      "paths": ["**/api/**", "**/database/**", "**/cache/**"],
      "agents": ["performance", "database"],
      "benchmarks": true,
      "regression-threshold": "5%"
    },
    "ui-changes": {
      "paths": ["**/components/**", "**/styles/**", "**/pages/**"],
      "agents": ["accessibility", "style", "i18n"],
      "visual-tests": true,
      "responsive-check": true
    }
  }
}
```

---

## Context-Aware Reviews

Analyze PRs with full project context:

```bash
# Review with comprehensive context
npx ruv-swarm github review-context \
  --pr 123 \
  --load-related-prs \
  --analyze-impact \
  --check-breaking-changes \
  --dependency-analysis
```

---

## Learning from History

Train review agents on your codebase patterns:

```bash
# Learn from past reviews
npx ruv-swarm github review-learn \
  --analyze-past-reviews \
  --identify-patterns \
  --improve-suggestions \
  --reduce-false-positives

# Train on your codebase
npx ruv-swarm github review-train \
  --learn-patterns \
  --adapt-to-style \
  --improve-accuracy
```
