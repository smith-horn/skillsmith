# Linear Issue Template

**Version**: 1.0
**Status**: Active
**Reference**: SMI-1344

---

## Instructions

Use this template when creating Linear issues for Skillsmith. Copy the template section below and fill in all relevant fields.

---

## Template

```markdown
## Summary

<!-- 1-2 sentence description of what this issue accomplishes -->

## Context

<!-- Why is this work needed? What problem does it solve? -->

## Acceptance Criteria

<!-- Specific, testable criteria for completion -->

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Token Estimate

**Complexity**: <!-- Simple | Medium | Complex -->
**Estimated Tokens**: <!-- Xk tokens -->
**Recommended Agents**: <!-- 1 | 1-2 | 2-3 -->

### Breakdown

<!-- Itemize the components contributing to the estimate -->

| Component | Type | Tokens |
|-----------|------|--------|
| Component 1 | Source file (new) | Xk |
| Component 2 | Test file (new) | Xk |
| Component 3 | Documentation | Xk |
| Buffer (20%) | - | Xk |
| **Total** | - | **Xk** |

### Estimation Rationale

<!-- Brief explanation of complexity factors -->

## Dependencies

### Blocking Issues

<!-- Issues that must be completed before this one can start -->

- [ ] SMI-XXX - Description
- [ ] SMI-YYY - Description

### Blocked Issues

<!-- Issues that are waiting on this one -->

- SMI-ZZZ - Description

### Package Dependencies

<!-- Internal or external packages required -->

- `@skillsmith/core` - Specific modules needed
- External package (version)

## Implementation Notes

### Approach

<!-- High-level approach to implementation -->

### Files Affected

<!-- List files to be created or modified -->

**New Files:**
- `packages/core/src/path/to/file.ts` - Description
- `packages/core/src/path/to/file.test.ts` - Tests

**Modified Files:**
- `packages/core/src/index.ts` - Add exports
- `packages/core/src/existing/file.ts` - Description of changes

### Test Plan

<!-- How will this be tested? -->

| Test Type | Description | Coverage Target |
|-----------|-------------|-----------------|
| Unit | Test individual functions | 80% |
| Integration | Test with dependencies | Key paths |
| Edge cases | Boundary conditions | Critical paths |

## Labels

<!-- Suggested labels for this issue -->

- `component:core` | `component:mcp-server` | `component:cli`
- `type:feature` | `type:bug` | `type:refactor` | `type:docs`
- `complexity:simple` | `complexity:medium` | `complexity:complex`
- `wave:X` - Assigned wave number

## Wave Assignment

<!-- Which wave should this be assigned to? -->

**Suggested Wave**: Wave X
**Parallel With**: SMI-XXX, SMI-YYY (similar complexity/domain)
**Sequence After**: SMI-ZZZ (depends on this)
```

---

## Example: Completed Issue

### SMI-1305: Python Language Adapter

## Summary

Implement a Python language adapter for the multi-language AST analysis system, supporting function, class, and import extraction.

## Context

The AST analysis system needs Python support to analyze skills that include Python code. Python is one of the most common languages in the skill ecosystem and essential for comprehensive analysis.

## Acceptance Criteria

- [x] PythonAdapter class implementing LanguageAdapter interface
- [x] Function extraction (name, params, return type hints, decorators)
- [x] Class extraction (name, methods, inheritance, decorators)
- [x] Import extraction (standard, from-import, aliases)
- [x] Comprehensive test coverage (>80%)
- [x] JSDoc documentation on all public methods

## Token Estimate

**Complexity**: Medium
**Estimated Tokens**: 10k
**Recommended Agents**: 1

### Breakdown

| Component | Type | Tokens |
|-----------|------|--------|
| PythonAdapter class | Source file (new) | 4k |
| Pattern matching logic | Included in adapter | - |
| Test file | Test file (new) | 3k |
| Type definitions | Modify types.ts | 1k |
| Buffer (20%) | - | 2k |
| **Total** | - | **10k** |

### Estimation Rationale

Medium complexity: follows established TypeScript adapter pattern but requires Python-specific syntax handling (decorators, type hints, indentation-based parsing).

## Dependencies

### Blocking Issues

- [x] SMI-1303 - Core infrastructure (LanguageAdapter base class)
- [x] SMI-1304 - TypeScript adapter (establishes pattern)

### Blocked Issues

- SMI-1311 - Incremental parsing (needs all adapters complete)

### Package Dependencies

- `@skillsmith/core` - LanguageAdapter base class
- `tree-sitter-python` WASM bindings

## Implementation Notes

### Approach

1. Extend LanguageAdapter base class
2. Implement Python-specific tree-sitter queries
3. Handle Python-specific constructs (decorators, type hints)
4. Follow TypeScript adapter pattern for consistency

### Files Affected

**New Files:**
- `packages/core/src/analysis/adapters/python.ts` - Python adapter implementation
- `packages/core/src/analysis/adapters/__tests__/python.test.ts` - Tests

**Modified Files:**
- `packages/core/src/analysis/adapters/index.ts` - Export PythonAdapter
- `packages/core/src/analysis/types.ts` - Add Python-specific types

### Test Plan

| Test Type | Description | Coverage Target |
|-----------|-------------|-----------------|
| Unit | Function extraction | 90% |
| Unit | Class extraction | 90% |
| Unit | Import extraction | 90% |
| Edge cases | Decorators, type hints | Critical paths |

## Labels

- `component:core`
- `type:feature`
- `complexity:medium`
- `wave:A`

## Wave Assignment

**Suggested Wave**: Wave A
**Parallel With**: SMI-1304 (TypeScript adapter) - similar pattern
**Sequence After**: SMI-1303 (core infrastructure)

---

## Complexity Reference

Use these guidelines when determining complexity:

| Complexity | Criteria | Token Range |
|------------|----------|-------------|
| **Simple** | 1-2 files, isolated change, basic tests | 5-8k |
| **Medium** | 3-5 files, module-level change, comprehensive tests | 8-15k |
| **Complex** | 6+ files, cross-package, architectural decisions | 15-25k |

See [Token Estimation Guide](../guides/token-estimation.md) for detailed methodology.

---

## Related Documentation

- [Token Estimation Guide](../guides/token-estimation.md)
- [Pre-Implementation Checklist](pre-implementation-checklist.md)
- [Wave Completion Checklist](../process/wave-completion-checklist.md)
- [Engineering Standards](../architecture/standards.md)

---

*Template version 1.0 - Based on Wave 7 best practices*
