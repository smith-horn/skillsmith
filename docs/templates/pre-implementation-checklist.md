# Pre-Implementation Checklist

**Version**: 1.0
**Status**: Active
**Reference**: [Engineering Standards](../architecture/standards.md)

---

## Instructions

Complete this checklist before implementing any new feature or module. This ensures consistency, quality, and maintainability across the Skillsmith codebase.

1. Copy this template to your feature documentation
2. Fill in each section
3. Run `npm run pre-impl -- --file <path>` for automated validation
4. Get team review before starting implementation

---

## Feature Description

### Feature Name

<!-- Clear, descriptive name for the feature -->

**Name**:

### Ticket Reference

<!-- Linear issue number -->

**Issue**: SMI-XXX

### Summary

<!-- 2-3 sentence description of what this feature does -->



### User Story

<!-- As a [user type], I want to [action] so that [benefit] -->

As a ________________, I want to ________________ so that ________________.

### Acceptance Criteria

<!-- Specific, testable criteria for feature completion -->

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

---

## API Design

### Public Interface

<!-- TypeScript interfaces/types for the public API -->

```typescript
// Define interfaces before implementation
interface FeatureInput {
  // Input parameters
}

interface FeatureOutput {
  // Return type
}
```

### Method Signatures

<!-- Key function signatures with JSDoc -->

```typescript
/**
 * Brief description of what the function does.
 *
 * @param input - Description of input parameter
 * @returns Description of return value
 * @throws {SkillsmithError} When validation fails
 */
function featureMethod(input: FeatureInput): Promise<FeatureOutput>;
```

### Error Handling

<!-- How errors will be handled and communicated -->

| Error Condition | Error Code | User Message |
|----------------|------------|--------------|
| Invalid input | `INVALID_INPUT` | User-friendly message |
| Not found | `NOT_FOUND` | User-friendly message |

### Dependencies

<!-- External and internal dependencies -->

**External:**
- Package name (version)

**Internal:**
- `@skillsmith/core` services used
- Existing repositories/services

---

## Test Plan

### Unit Tests

<!-- List of unit tests to be created -->

| Test Case | Description | Priority |
|-----------|-------------|----------|
| `should create with valid input` | Happy path | High |
| `should throw for invalid input` | Error handling | High |
| `should handle edge case X` | Edge case | Medium |

### Integration Tests

<!-- List of integration tests if applicable -->

| Test Scenario | Components Involved |
|--------------|---------------------|
| End-to-end workflow | Service + Repository + DB |

### Test File Location

<!-- Where tests will be created -->

- `packages/core/src/services/Feature.test.ts`
- `packages/mcp-server/src/tools/feature.test.ts`

### Coverage Target

<!-- Minimum coverage requirement -->

- **Unit tests**: 80% minimum
- **API/MCP tools**: 90% minimum

---

## Security Considerations

### Input Validation

<!-- How will inputs be validated? -->

| Input | Validation | Pattern |
|-------|-----------|---------|
| User input | Schema validation | Zod schema |
| File paths | Path sanitization | No `..`, null bytes |
| SQL parameters | Parameterized queries | Prepared statements |

### Authentication/Authorization

<!-- Access control requirements -->

- [ ] No authentication required
- [ ] Requires user context
- [ ] Requires elevated permissions

### Sensitive Data

<!-- How sensitive data is handled -->

- [ ] No sensitive data involved
- [ ] Sensitive data encrypted at rest
- [ ] Sensitive data masked in logs

### Security Checklist

- [ ] No hardcoded secrets
- [ ] All user input validated
- [ ] SQL injection prevention verified
- [ ] Command injection prevention verified
- [ ] No prototype pollution vulnerabilities
- [ ] Subprocess spawning follows security guidelines

---

## Performance Considerations

### Expected Load

<!-- Anticipated usage patterns -->

| Metric | Expected Value | Limit |
|--------|---------------|-------|
| Requests/minute | X | Y |
| Data volume | X records | Y max |

### Resource Usage

<!-- CPU, memory, storage considerations -->

- **Memory**: Expected usage
- **CPU**: Computation intensity
- **Storage**: Data storage needs

### Optimization Strategies

<!-- Planned optimizations -->

- [ ] Caching strategy defined
- [ ] Database indexes planned
- [ ] Batch operations for bulk data
- [ ] Lazy loading where appropriate

### Performance Targets

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Response time | <100ms | p95 latency |
| Memory usage | <50MB | Peak usage |

---

## File Structure

### New Files to Create

<!-- List all new files with their purpose -->

| File Path | Purpose |
|-----------|---------|
| `packages/core/src/services/FeatureService.ts` | Business logic |
| `packages/core/src/services/FeatureService.test.ts` | Unit tests |
| `packages/core/src/types/feature.types.ts` | Type definitions |

### Existing Files to Modify

<!-- List files that need changes -->

| File Path | Change Description |
|-----------|-------------------|
| `packages/core/src/index.ts` | Export new service |

### Package Assignment

<!-- Which package owns this feature -->

- [ ] `@skillsmith/core` - Core business logic
- [ ] `@skillsmith/mcp-server` - MCP tool implementation
- [ ] `@skillsmith/cli` - CLI command

---

## Pre-Implementation Validation

### Automated Checks

Run before implementation:

```bash
# Validate the proposed implementation
npm run pre-impl -- --file packages/core/src/services/NewFeature.ts

# Check for circular dependency risks
npm run pre-impl -- --module NewFeature
```

### Manual Checklist

- [ ] Types defined before implementation
- [ ] Test file created (even if empty)
- [ ] JSDoc comments planned
- [ ] No circular dependencies introduced
- [ ] Naming follows standards.md conventions
- [ ] File in correct package location

### Review Requirements

- [ ] Self-review completed
- [ ] Design discussed with team (if complex)
- [ ] Linear issue updated with implementation plan

---

## Implementation Notes

### Approach

<!-- High-level implementation approach -->



### Known Limitations

<!-- Any known limitations or future improvements -->



### Follow-up Tasks

<!-- Tasks for future iterations -->

- [ ] Future enhancement 1
- [ ] Future enhancement 2

---

## Sign-off

| Role | Name | Date | Approved |
|------|------|------|----------|
| Author | | | |
| Reviewer | | | |

---

*Template version 1.0 - See [standards.md](../architecture/standards.md) for engineering standards*
