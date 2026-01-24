# Pair Programming Configuration

Configuration options, profiles, and environment setup.

---

## Basic Configuration

Create `.claude-flow/pair-config.json`:

```json
{
  "pair": {
    "enabled": true,
    "defaultMode": "switch",
    "defaultAgent": "auto",
    "autoStart": false,
    "theme": "professional"
  }
}
```

---

## Complete Configuration

```json
{
  "pair": {
    "general": {
      "enabled": true,
      "defaultMode": "switch",
      "defaultAgent": "senior-dev",
      "language": "javascript",
      "timezone": "UTC"
    },

    "modes": {
      "driver": {
        "enabled": true,
        "suggestions": true,
        "realTimeReview": true,
        "autoComplete": false
      },
      "navigator": {
        "enabled": true,
        "codeGeneration": true,
        "explanations": true,
        "alternatives": true
      },
      "switch": {
        "enabled": true,
        "interval": "10m",
        "warning": "30s",
        "autoSwitch": true,
        "pauseOnIdle": true
      }
    },

    "verification": {
      "enabled": true,
      "threshold": 0.95,
      "autoRollback": true,
      "preCommitCheck": true,
      "continuousMonitoring": true,
      "blockOnFailure": true
    },

    "testing": {
      "enabled": true,
      "autoRun": true,
      "framework": "jest",
      "onSave": true,
      "coverage": {
        "enabled": true,
        "minimum": 80,
        "enforce": true,
        "reportFormat": "html"
      }
    },

    "review": {
      "enabled": true,
      "continuous": true,
      "preCommit": true,
      "security": true,
      "performance": true,
      "style": true,
      "complexity": {
        "maxComplexity": 10,
        "maxDepth": 4,
        "maxLines": 100
      }
    },

    "git": {
      "enabled": true,
      "autoCommit": false,
      "commitTemplate": "feat: {message}",
      "signCommits": false,
      "pushOnEnd": false,
      "branchProtection": true
    },

    "session": {
      "autoSave": true,
      "saveInterval": "5m",
      "maxDuration": "4h",
      "idleTimeout": "15m",
      "breakReminder": "45m",
      "metricsInterval": "1m"
    },

    "ai": {
      "model": "advanced",
      "temperature": 0.7,
      "maxTokens": 4000,
      "personality": "professional",
      "expertise": ["backend", "testing", "security"],
      "learningEnabled": true
    }
  }
}
```

---

## Built-in Agents

```json
{
  "agents": {
    "senior-dev": {
      "expertise": ["architecture", "patterns", "optimization"],
      "style": "thorough",
      "reviewLevel": "strict"
    },
    "tdd-specialist": {
      "expertise": ["testing", "mocks", "coverage"],
      "style": "test-first",
      "reviewLevel": "comprehensive"
    },
    "debugger-expert": {
      "expertise": ["debugging", "profiling", "tracing"],
      "style": "analytical",
      "reviewLevel": "focused"
    },
    "junior-dev": {
      "expertise": ["learning", "basics", "documentation"],
      "style": "questioning",
      "reviewLevel": "educational"
    }
  }
}
```

---

## CLI Configuration

```bash
# Set configuration
claude-flow pair config set defaultMode switch
claude-flow pair config set verification.threshold 0.98

# Get configuration
claude-flow pair config get
claude-flow pair config get defaultMode

# Export/Import
claude-flow pair config export > config.json
claude-flow pair config import config.json

# Reset
claude-flow pair config reset
```

---

## Profile Management

Create reusable profiles:

```bash
# Create profile
claude-flow pair profile create refactoring \
  --mode driver \
  --verify true \
  --threshold 0.98 \
  --focus refactor

# Use profile
claude-flow pair --start --profile refactoring

# List profiles
claude-flow pair profile list
```

Profile configuration:
```json
{
  "profiles": {
    "refactoring": {
      "mode": "driver",
      "verification": {
        "enabled": true,
        "threshold": 0.98
      },
      "focus": "refactor"
    },
    "debugging": {
      "mode": "navigator",
      "agent": "debugger-expert",
      "trace": true,
      "verbose": true
    },
    "learning": {
      "mode": "mentor",
      "pace": "slow",
      "explanations": "detailed",
      "examples": true
    }
  }
}
```

---

## Environment Variables

Override configuration via environment:

```bash
export CLAUDE_PAIR_MODE=driver
export CLAUDE_PAIR_VERIFY=true
export CLAUDE_PAIR_THRESHOLD=0.98
export CLAUDE_PAIR_AGENT=senior-dev
export CLAUDE_PAIR_AUTO_TEST=true
```

---

## Configuration Priority

Configuration is loaded in this priority order (highest first):

1. CLI arguments
2. Environment variables
3. Project config (`.claude-flow/pair-config.json`)
4. User config (`~/.claude-flow/pair-config.json`)
5. Global defaults

---

## Session Configuration

### Auto-Save Settings

```json
{
  "session": {
    "autoSave": true,
    "saveInterval": "5m",
    "maxDuration": "4h",
    "idleTimeout": "15m",
    "breakReminder": "45m"
  }
}
```

### Session Persistence

```bash
# Save session
claude-flow pair --save [--name <name>]

# Load session
claude-flow pair --load <session-id>

# Export session
claude-flow pair --export <session-id> [--format json|md]

# Generate report
claude-flow pair --report <session-id>
```

---

## Integration Options

### With Git

```bash
claude-flow pair --start --git --auto-commit
```

### With CI/CD

```bash
claude-flow pair --start --ci --non-interactive
```

### With IDE

```bash
claude-flow pair --start --ide vscode
```

---

## Troubleshooting Configuration

### Configuration Issues

```bash
# Validate configuration
claude-flow pair config validate

# Show effective configuration
claude-flow pair config show --effective

# Reset to defaults
claude-flow pair config reset
```

### Common Issues

**Issue**: Configuration not loading
**Solution**: Check file syntax with JSON validator

**Issue**: Environment variables not working
**Solution**: Ensure variables are exported, not just set

**Issue**: Profile not found
**Solution**: Check profile exists with `claude-flow pair profile list`
