# Development Phases

SPARC methodology follows 5 structured phases from specification to completion.

---

## Phase 1: Specification

**Goal**: Define requirements, constraints, and success criteria

Activities:
- Requirements analysis
- User story mapping
- Constraint identification
- Success metrics definition
- Pseudocode planning

**Key Modes**: `researcher`, `analyzer`, `memory-manager`

```javascript
mcp__claude-flow__sparc_mode {
  mode: "researcher",
  task_description: "gather requirements for user authentication system"
}
```

---

## Phase 2: Architecture

**Goal**: Design system structure and component interfaces

Activities:
- System architecture design
- Component interface definition
- Database schema planning
- API contract specification
- Infrastructure planning

**Key Modes**: `architect`, `designer`, `orchestrator`

```javascript
mcp__claude-flow__sparc_mode {
  mode: "architect",
  task_description: "design scalable e-commerce platform",
  options: {
    memory_enabled: true,
    patterns: ["microservices", "event-driven"]
  }
}
```

---

## Phase 3: Refinement (TDD Implementation)

**Goal**: Implement features with test-first approach

Activities:
- Write failing tests
- Implement minimum viable code
- Make tests pass
- Refactor for quality
- Iterate until complete

**Key Modes**: `tdd`, `coder`, `tester`

```javascript
mcp__claude-flow__sparc_mode {
  mode: "tdd",
  task_description: "shopping cart feature with payment integration",
  options: {
    coverage_target: 90,
    test_framework: "jest",
    e2e_framework: "playwright"
  }
}
```

---

## Phase 4: Review

**Goal**: Ensure code quality, security, and performance

Activities:
- Code quality assessment
- Security vulnerability scanning
- Performance profiling
- Best practices validation
- Documentation review

**Key Modes**: `reviewer`, `optimizer`, `debugger`

```javascript
mcp__claude-flow__sparc_mode {
  mode: "reviewer",
  task_description: "review authentication module PR #123",
  options: {
    security_check: true,
    performance_check: true,
    test_coverage_check: true
  }
}
```

---

## Phase 5: Completion

**Goal**: Integration, deployment, and monitoring

Activities:
- System integration
- Deployment automation
- Monitoring setup
- Documentation finalization
- Knowledge capture

**Key Modes**: `workflow-manager`, `documenter`, `memory-manager`

```javascript
mcp__claude-flow__sparc_mode {
  mode: "documenter",
  task_description: "document authentication API"
}
```

---

## Phase Flow Diagram

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Specification│ ─→ │ Architecture │ ─→ │ Refinement  │
│  (Research) │    │   (Design)  │    │    (TDD)    │
└─────────────┘    └─────────────┘    └─────────────┘
                                              │
                                              ▼
                   ┌─────────────┐    ┌─────────────┐
                   │ Completion  │ ←─ │   Review    │
                   │  (Deploy)   │    │  (Quality)  │
                   └─────────────┘    └─────────────┘
```

---

## Phase-Mode Mapping

| Phase | Primary Modes | Supporting Modes |
|-------|---------------|------------------|
| Specification | researcher, analyzer | memory-manager |
| Architecture | architect, designer | orchestrator |
| Refinement | tdd, coder | tester |
| Review | reviewer, optimizer | debugger |
| Completion | workflow-manager, documenter | memory-manager |
