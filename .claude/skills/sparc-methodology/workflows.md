# Workflows

TDD workflows, common workflows, integration examples, and advanced features.

---

## TDD Workflow

### Complete TDD Workflow

```javascript
// Step 1: Initialize TDD swarm
mcp__claude-flow__swarm_init {
  topology: "hierarchical",
  maxAgents: 8
}

// Step 2: Research and planning
mcp__claude-flow__sparc_mode {
  mode: "researcher",
  task_description: "research testing best practices for feature X"
}

// Step 3: Architecture design
mcp__claude-flow__sparc_mode {
  mode: "architect",
  task_description: "design testable architecture for feature X"
}

// Step 4: TDD implementation
mcp__claude-flow__sparc_mode {
  mode: "tdd",
  task_description: "implement feature X with 90% coverage",
  options: {
    coverage_target: 90,
    test_framework: "jest",
    parallel_tests: true
  }
}

// Step 5: Code review
mcp__claude-flow__sparc_mode {
  mode: "reviewer",
  task_description: "review feature X implementation",
  options: {
    test_coverage_check: true,
    security_check: true
  }
}

// Step 6: Optimization
mcp__claude-flow__sparc_mode {
  mode: "optimizer",
  task_description: "optimize feature X performance"
}
```

### Red-Green-Refactor Cycle

```javascript
// RED: Write failing test
mcp__claude-flow__sparc_mode {
  mode: "tester",
  task_description: "create failing test for shopping cart add item",
  options: { expect_failure: true }
}

// GREEN: Minimal implementation
mcp__claude-flow__sparc_mode {
  mode: "coder",
  task_description: "implement minimal code to pass test",
  options: { minimal: true }
}

// REFACTOR: Improve code quality
mcp__claude-flow__sparc_mode {
  mode: "coder",
  task_description: "refactor shopping cart implementation",
  options: { maintain_tests: true }
}
```

---

## Common Workflows

### Workflow 1: Feature Development

```bash
# Step 1: Research and planning
npx claude-flow sparc run researcher "authentication patterns"

# Step 2: Architecture design
npx claude-flow sparc run architect "design auth system"

# Step 3: TDD implementation
npx claude-flow sparc tdd "user authentication feature"

# Step 4: Code review
npx claude-flow sparc run reviewer "review auth implementation"

# Step 5: Documentation
npx claude-flow sparc run documenter "document auth API"
```

### Workflow 2: Bug Investigation

```bash
# Step 1: Analyze issue
npx claude-flow sparc run analyzer "investigate bug #456"

# Step 2: Debug systematically
npx claude-flow sparc run debugger "fix memory leak in service X"

# Step 3: Create tests
npx claude-flow sparc run tester "regression tests for bug #456"

# Step 4: Review fix
npx claude-flow sparc run reviewer "validate bug fix"
```

### Workflow 3: Performance Optimization

```bash
# Step 1: Profile performance
npx claude-flow sparc run analyzer "profile API response times"

# Step 2: Identify bottlenecks
npx claude-flow sparc run optimizer "optimize database queries"

# Step 3: Implement improvements
npx claude-flow sparc run coder "implement caching layer"

# Step 4: Benchmark results
npx claude-flow sparc run tester "performance benchmarks"
```

### Workflow 4: Complete Pipeline

```bash
# Execute full development pipeline
npx claude-flow sparc pipeline "e-commerce checkout feature"

# This automatically runs:
# 1. researcher - Gather requirements
# 2. architect - Design system
# 3. coder - Implement features
# 4. tdd - Create comprehensive tests
# 5. reviewer - Code quality review
# 6. optimizer - Performance tuning
# 7. documenter - Documentation
```

---

## Integration Examples

### Example 1: Full-Stack Development

```javascript
[Single Message - Parallel Agent Execution]:

// Initialize swarm
mcp__claude-flow__swarm_init {
  topology: "hierarchical",
  maxAgents: 10
}

// Architecture phase
mcp__claude-flow__sparc_mode {
  mode: "architect",
  task_description: "design REST API with authentication",
  options: { memory_enabled: true }
}

// Implementation phase
mcp__claude-flow__sparc_mode {
  mode: "coder",
  task_description: "implement Express API with JWT auth",
  options: { test_driven: true }
}

// Testing phase
mcp__claude-flow__sparc_mode {
  mode: "tdd",
  task_description: "comprehensive API tests",
  options: { coverage_target: 90 }
}

// Batch todos
TodoWrite {
  todos: [
    {content: "Design API schema", status: "completed"},
    {content: "Implement authentication", status: "in_progress"},
    {content: "Write API tests", status: "pending"},
    {content: "Security review", status: "pending"},
    {content: "API documentation", status: "pending"}
  ]
}
```

### Example 2: Research-Driven Innovation

```javascript
// Research phase
mcp__claude-flow__sparc_mode {
  mode: "researcher",
  task_description: "research AI-powered search implementations",
  options: {
    depth: "comprehensive",
    sources: ["academic", "industry"]
  }
}

// Innovation phase
mcp__claude-flow__sparc_mode {
  mode: "innovator",
  task_description: "propose novel search algorithm",
  options: { memory_enabled: true }
}

// Architecture phase
mcp__claude-flow__sparc_mode {
  mode: "architect",
  task_description: "design scalable search system"
}
```

### Example 3: Legacy Code Refactoring

```javascript
// Analysis phase
mcp__claude-flow__sparc_mode {
  mode: "analyzer",
  task_description: "analyze legacy codebase dependencies"
}

// Testing phase (create safety net)
mcp__claude-flow__sparc_mode {
  mode: "tester",
  task_description: "create comprehensive test suite for legacy code",
  options: { coverage_target: 80 }
}

// Refactoring phase
mcp__claude-flow__sparc_mode {
  mode: "coder",
  task_description: "refactor module X with modern patterns",
  options: { maintain_tests: true }
}

// Review phase
mcp__claude-flow__sparc_mode {
  mode: "reviewer",
  task_description: "validate refactoring maintains functionality"
}
```

---

## Advanced Features

### Neural Pattern Training

```javascript
// Train patterns from successful workflows
mcp__claude-flow__neural_train {
  pattern_type: "coordination",
  training_data: "successful_tdd_workflow.json",
  epochs: 50
}
```

### Cross-Session Memory

```javascript
// Save session state
mcp__claude-flow__memory_persist {
  sessionId: "feature-auth-v1"
}

// Restore in new session
mcp__claude-flow__context_restore {
  snapshotId: "feature-auth-v1"
}
```

### GitHub Integration

```javascript
// Analyze repository
mcp__claude-flow__github_repo_analyze {
  repo: "owner/repo",
  analysis_type: "code_quality"
}

// Manage pull requests
mcp__claude-flow__github_pr_manage {
  repo: "owner/repo",
  pr_number: 123,
  action: "review"
}
```

### Performance Monitoring

```javascript
// Real-time swarm monitoring
mcp__claude-flow__swarm_monitor {
  swarmId: "current",
  interval: 5000
}

// Bottleneck analysis
mcp__claude-flow__bottleneck_analyze {
  component: "api-layer",
  metrics: ["latency", "throughput", "errors"]
}

// Token usage tracking
mcp__claude-flow__token_usage {
  operation: "feature-development",
  timeframe: "24h"
}
```

---

## Best Practices

### Test Coverage

**Maintain minimum 90% coverage**:
- Unit tests for all functions
- Integration tests for APIs
- E2E tests for critical flows
- Edge case coverage
- Error path testing

### Documentation

**Document as you build**:
- API documentation (OpenAPI)
- Architecture decision records (ADR)
- Code comments for complex logic
- README with setup instructions
- Changelog for version tracking

### File Organization

**Never save to root folder**:

```
project/
├── src/           # Source code
├── tests/         # Test files
├── docs/          # Documentation
├── config/        # Configuration
├── scripts/       # Utility scripts
└── examples/      # Example code
```
