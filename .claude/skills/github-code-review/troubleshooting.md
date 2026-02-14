# Troubleshooting

Common issues and solutions for GitHub code review.

---

## Issue: Review agents not spawning

**Solution:**
```bash
# Check swarm status
npx ruv-swarm swarm-status

# Verify GitHub CLI authentication
gh auth status

# Re-initialize swarm
npx ruv-swarm github review-init --pr 123 --force
```

---

## Issue: Comments not posting to PR

**Solution:**
```bash
# Verify GitHub token permissions
gh auth status

# Check API rate limits
gh api rate_limit

# Use batch comment posting
npx ruv-swarm github review-comments --pr 123 --batch
```

---

## Issue: Review taking too long

**Solution:**
```bash
# Use incremental review for large PRs
npx ruv-swarm github review-init --pr 123 --incremental

# Reduce agent count
npx ruv-swarm github review-init --pr 123 --agents "security,style" --max-agents 3

# Enable parallel processing
npx ruv-swarm github review-init --pr 123 --parallel --cache-results
```

---

## Issue: False positives in security review

**Solution:**
```bash
# Train on your codebase patterns
npx ruv-swarm github review-learn \
  --analyze-past-reviews \
  --reduce-false-positives

# Add exceptions to configuration
# .github/review-swarm.yml
review:
  rules:
    security:
      exceptions:
        - pattern: "test/**/*"
          reason: "Test files allow unsafe patterns"
```

---

## Issue: PR comment commands not working

**Causes:**
1. Webhook not configured
2. Missing permissions
3. Command syntax error

**Solution:**
```bash
# Check webhook configuration
gh api repos/:owner/:repo/hooks

# Verify bot has comment permissions
gh api repos/:owner/:repo/collaborators --jq '.[].permissions'

# Test command parsing
npx ruv-swarm github parse-command "/swarm init mesh 6"
```

---

## Issue: GitHub API rate limit exceeded

**Solution:**
```bash
# Check current rate limit
gh api rate_limit

# Use authenticated requests (higher limits)
gh auth login

# Enable caching to reduce API calls
npx ruv-swarm github review-init --pr 123 --cache-results --cache-ttl 3600

# Batch operations
npx ruv-swarm github review-comments --pr 123 --batch
```

---

## Issue: Swarm not respecting topology configuration

**Solution:**
```bash
# Verify configuration file
cat .github/review-swarm.yml

# Check topology is supported
npx ruv-swarm swarm-topologies

# Force specific topology
npx ruv-swarm github review-init --pr 123 --topology hierarchical --force
```

---

## Issue: Quality gates not blocking merge

**Causes:**
1. Branch protection not configured
2. Required status checks not set
3. Admin bypass enabled

**Solution:**
```bash
# Check branch protection
gh api repos/:owner/:repo/branches/main/protection

# Update branch protection
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f required_status_checks='{"strict":true,"contexts":["review-swarm/security"]}' \
  -f enforce_admins=true
```

---

## Issue: Custom agent not registered

**Solution:**
```bash
# Check registered agents
npx ruv-swarm github list-agents

# Re-register agent
npx ruv-swarm github register-agent \
  --name "custom-reviewer" \
  --file "./custom-review-agent.js" \
  --force

# Verify agent works
npx ruv-swarm github test-agent --name "custom-reviewer" --pr 123
```

---

## Security Best Practices

1. **Token Permissions**: Ensure GitHub tokens have minimal required scopes
2. **Command Validation**: Validate all PR comments before execution
3. **Rate Limiting**: Implement rate limits for PR operations
4. **Audit Trail**: Log all swarm operations for compliance
5. **Secret Management**: Never expose API keys in PR comments or logs

---

## Debug Mode

Enable verbose logging for troubleshooting:

```bash
# Enable debug mode
DEBUG=ruv-swarm:* npx ruv-swarm github review-init --pr 123

# Export debug logs
npx ruv-swarm github review-init --pr 123 --debug --log-file review-debug.log
```

---

## Getting Help

- GitHub Issues: Report bugs and request features
- Community: Join discussions and share experiences
- Documentation: [RUV Swarm Guide](https://github.com/ruvnet/ruv-swarm)
