# Configuration

Settings, git hooks, custom hooks, and troubleshooting.

---

## Basic Configuration

Edit `.claude/settings.json` to configure hooks:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook pre-edit --file '${tool.params.file_path}' --memory-key 'swarm/editor/current'"
        }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook pre-bash --command '${tool.params.command}'"
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook post-edit --file '${tool.params.file_path}' --memory-key 'swarm/editor/complete' --auto-format --train-patterns"
        }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook post-bash --command '${tool.params.command}' --update-metrics"
        }]
      }
    ]
  }
}
```

---

## Advanced Configuration

Complete hook configuration with all features:

```json
{
  "hooks": {
    "enabled": true,
    "debug": false,
    "timeout": 5000,

    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook pre-edit --file '${tool.params.file_path}' --auto-assign-agent --validate-syntax",
            "timeout": 3000,
            "continueOnError": true
          }
        ]
      },
      {
        "matcher": "^Task$",
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook pre-task --description '${tool.params.task}' --auto-spawn-agents --load-memory",
            "async": true
          }
        ]
      }
    ],

    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook post-edit --file '${tool.params.file_path}' --memory-key 'edits/${tool.params.file_path}' --auto-format --train-patterns",
            "async": true
          }
        ]
      },
      {
        "matcher": "^Task$",
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook post-task --task-id '${result.task_id}' --analyze-performance --store-decisions --export-learnings",
            "async": true
          }
        ]
      }
    ]
  }
}
```

---

## Protected File Patterns

Add protection for sensitive files:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook check-protected --file '${tool.params.file_path}'"
          }
        ]
      }
    ]
  }
}
```

---

## Git Integration

### Pre-Commit Hook

```bash
# Add to .git/hooks/pre-commit or use husky

#!/bin/bash
# Run quality checks before commit

# Get staged files
FILES=$(git diff --cached --name-only --diff-filter=ACM)

for FILE in $FILES; do
  # Run pre-edit hook for validation
  npx claude-flow hook pre-edit --file "$FILE" --validate-syntax

  if [ $? -ne 0 ]; then
    echo "Validation failed for $FILE"
    exit 1
  fi

  # Run post-edit hook for formatting
  npx claude-flow hook post-edit --file "$FILE" --auto-format
done

# Run tests
npm test

exit $?
```

### Post-Commit Hook

```bash
# Add to .git/hooks/post-commit

#!/bin/bash
# Track commit metrics

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B)

npx claude-flow hook notify \
  --message "Commit completed: $COMMIT_MSG" \
  --level info \
  --swarm-status
```

### Pre-Push Hook

```bash
# Add to .git/hooks/pre-push

#!/bin/bash
# Quality gate before push

# Run full test suite
npm run test:all

# Run quality checks
npx claude-flow hook session-end \
  --generate-report \
  --export-metrics

# Verify quality thresholds
TRUTH_SCORE=$(npx claude-flow metrics score --format json | jq -r '.truth_score')

if (( $(echo "$TRUTH_SCORE < 0.95" | bc -l) )); then
  echo "Truth score below threshold: $TRUTH_SCORE < 0.95"
  exit 1
fi

exit 0
```

---

## Custom Hook Creation

### Custom Hook Template

```javascript
// .claude/hooks/custom-quality-check.js

module.exports = {
  name: 'custom-quality-check',
  type: 'pre',
  matcher: /\.(ts|js)$/,

  async execute(context) {
    const { file, content } = context;

    // Custom validation logic
    const complexity = await analyzeComplexity(content);
    const securityIssues = await scanSecurity(content);

    // Store in memory
    await storeInMemory({
      key: `quality/${file}`,
      value: { complexity, securityIssues }
    });

    // Return decision
    if (complexity > 15 || securityIssues.length > 0) {
      return {
        continue: false,
        reason: 'Quality checks failed',
        warnings: [
          `Complexity: ${complexity} (max: 15)`,
          `Security issues: ${securityIssues.length}`
        ]
      };
    }

    return {
      continue: true,
      reason: 'Quality checks passed',
      metadata: { complexity, securityIssues: 0 }
    };
  }
};
```

### Register Custom Hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit)$",
        "hooks": [
          {
            "type": "script",
            "script": ".claude/hooks/custom-quality-check.js"
          }
        ]
      }
    ]
  }
}
```

---

## Debugging Hooks

Enable debug mode for troubleshooting:

```bash
# Enable debug output
export CLAUDE_FLOW_DEBUG=true

# Test specific hook with verbose output
npx claude-flow hook pre-edit --file "test.js" --debug

# Check hook execution logs
cat .claude-flow/logs/hooks-$(date +%Y-%m-%d).log

# Validate configuration
npx claude-flow hook validate-config
```

---

## Troubleshooting

### Hooks Not Executing

- Verify `.claude/settings.json` syntax
- Check hook matcher patterns
- Enable debug mode
- Review permission settings
- Ensure claude-flow CLI is in PATH

### Hook Timeouts

- Increase timeout values in configuration
- Make hooks asynchronous for heavy operations
- Optimize hook logic
- Check network connectivity for MCP tools

### Memory Issues

- Set appropriate TTLs for memory keys
- Clean up old memory entries
- Use memory namespaces effectively
- Monitor memory usage

### Performance Problems

- Profile hook execution times
- Use caching for repeated operations
- Batch operations when possible
- Reduce hook complexity

---

## Best Practices

1. **Configure Hooks Early** - Set up during project initialization
2. **Use Memory Keys Strategically** - Organize with clear namespaces
3. **Enable Auto-Formatting** - Maintain code consistency
4. **Train Patterns Continuously** - Learn from successful operations
5. **Monitor Performance** - Track hook execution times
6. **Validate Configuration** - Test hooks before production use
7. **Document Custom Hooks** - Maintain hook documentation
8. **Set Appropriate Timeouts** - Prevent hanging operations
9. **Handle Errors Gracefully** - Use continueOnError when appropriate
10. **Review Metrics Regularly** - Optimize based on usage patterns

---

## Related Commands

```bash
npx claude-flow init --hooks       # Initialize hooks system
npx claude-flow hook --list        # List available hooks
npx claude-flow hook --test <hook> # Test specific hook
npx claude-flow memory usage       # Manage memory
npx claude-flow agent spawn        # Spawn agents
npx claude-flow swarm init         # Initialize swarm
```
