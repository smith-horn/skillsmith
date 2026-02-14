# Quality Gates

Status checks, thresholds, and metrics tracking for code review.

---

## Status Checks

```yaml
# Required status checks in branch protection
protection_rules:
  required_status_checks:
    strict: true
    contexts:
      - "review-swarm/security"
      - "review-swarm/performance"
      - "review-swarm/architecture"
      - "review-swarm/tests"
```

---

## Define Quality Gates

```bash
# Set quality gate thresholds
npx ruv-swarm github quality-gates \
  --define '{
    "security": {"threshold": "no-critical"},
    "performance": {"regression": "<5%"},
    "coverage": {"minimum": "80%"},
    "architecture": {"complexity": "<10"},
    "duplication": {"maximum": "5%"}
  }'
```

---

## Configuration File

```yaml
# .github/review-swarm.yml
version: 1
review:
  auto-trigger: true
  required-agents:
    - security
    - performance
    - style
  optional-agents:
    - architecture
    - accessibility
    - i18n

  thresholds:
    security: block      # Block merge on security issues
    performance: warn    # Warn on performance issues
    style: suggest       # Suggest style improvements

  rules:
    security:
      - no-eval
      - no-hardcoded-secrets
      - proper-auth-checks
      - validate-input
    performance:
      - no-n-plus-one
      - efficient-queries
      - proper-caching
      - optimize-loops
    architecture:
      - max-coupling: 5
      - min-cohesion: 0.7
      - follow-patterns
      - avoid-circular-deps
```

---

## Track Review Metrics

```bash
# Monitor review effectiveness
npx ruv-swarm github review-metrics \
  --period 30d \
  --metrics "issues-found,false-positives,fix-rate,time-to-review" \
  --export-dashboard \
  --format json
```

---

## Monitoring & Analytics

### Review Dashboard

```bash
# Launch real-time review dashboard
npx ruv-swarm github review-dashboard \
  --real-time \
  --show "agent-activity,issue-trends,fix-rates,coverage"
```

### Generate Review Reports

```bash
# Create comprehensive review report
npx ruv-swarm github review-report \
  --format "markdown" \
  --include "summary,details,trends,recommendations" \
  --email-stakeholders \
  --export-pdf
```

### PR Swarm Analytics

```bash
# Generate PR-specific analytics
npx ruv-swarm github pr-report 123 \
  --metrics "completion-time,agent-efficiency,token-usage,issue-density" \
  --format markdown \
  --compare-baseline
```

### Export to GitHub Insights

```bash
# Export metrics to GitHub Insights
npx ruv-swarm github export-metrics \
  --pr 123 \
  --to-insights \
  --dashboard-url
```

---

## Severity Thresholds

| Severity | Action | Threshold |
|----------|--------|-----------|
| **Critical** | Block merge | 0 allowed |
| **High** | Request changes | 0 allowed |
| **Medium** | Warning | < 5 allowed |
| **Low** | Suggestion | No limit |

---

## Coverage Requirements

| Type | Minimum | Target |
|------|---------|--------|
| Line coverage | 80% | 90% |
| Branch coverage | 75% | 85% |
| Function coverage | 80% | 90% |

---

## Performance Thresholds

| Metric | Warning | Block |
|--------|---------|-------|
| Regression | > 2% | > 5% |
| Memory increase | > 10% | > 25% |
| Bundle size increase | > 5KB | > 20KB |

---

## Complexity Limits

| Metric | Warning | Error |
|--------|---------|-------|
| Cyclomatic complexity | > 10 | > 15 |
| Nesting depth | > 4 | > 6 |
| Function length | > 50 lines | > 100 lines |
| File length | > 300 lines | > 500 lines |

---

## Branch Protection Rules

```json
{
  "protection": {
    "required_status_checks": {
      "strict": true,
      "contexts": [
        "review-swarm/security",
        "review-swarm/performance",
        "review-swarm/tests"
      ]
    },
    "required_pull_request_reviews": {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews": true,
      "require_code_owner_reviews": true
    },
    "restrictions": null,
    "enforce_admins": true
  }
}
```
