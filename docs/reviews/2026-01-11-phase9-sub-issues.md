# Phase 9 Sub-Issues: Code Review Fixes

**Parent Issue**: SMI-1378 (Phase 9: Subagent Pair Generation)
**Created**: 2026-01-11
**Status**: Implemented (pending Linear issue creation)

---

## SMI-1394: Extract tool detection keywords to configurable constants

**Type**: Enhancement
**Labels**: `enhancement`, `code-quality`, `phase-9`
**Priority**: Low

### Summary

Extracted hardcoded tool detection keywords from inline strings to a configurable `TOOL_DETECTION_KEYWORDS` constant object for improved maintainability and extensibility.

### Changes

- Added `TOOL_DETECTION_KEYWORDS` constant mapping tool names to detection keywords
- Added `VALID_TOOLS` constant for tool name validation
- Refactored `analyzeRequiredTools()` function to use the keyword configuration
- Added JSDoc documentation explaining the keyword matching logic

### Files Changed

- `packages/cli/src/commands/author.ts` (lines 23-44, 159-195)

### Benefits

- Easier to add new tools or modify detection keywords
- Keywords are documented in one place
- Consistent pattern for tool detection across the codebase

---

## SMI-1395: Extract shared path resolution utility

**Type**: Enhancement
**Labels**: `enhancement`, `code-quality`, `DRY`, `phase-9`
**Priority**: Low

### Summary

Extracted duplicated path resolution logic into a shared `resolveSkillPath()` utility function to follow DRY principles.

### Changes

- Created `resolveSkillPath(inputPath: string): Promise<string>` utility function
- Updated `generateSubagent()` to use the shared utility
- Updated `transformSingleSkill()` to use the shared utility
- Added descriptive comment explaining the fallback behavior for non-existent paths

### Files Changed

- `packages/cli/src/commands/author.ts` (lines 74-100, 241-242, 349-350)

### Benefits

- Single source of truth for path resolution logic
- Easier to update behavior in one place
- Better documentation of edge case handling

---

## SMI-1396: Add tool name validation for --tools option

**Type**: Enhancement
**Labels**: `enhancement`, `validation`, `UX`, `phase-9`
**Priority**: Low

### Summary

Added validation for the `--tools` option to warn users when unknown tool names are provided.

### Changes

- Created `validateToolNames(tools: string[])` validation function
- Added warning output when unknown tools are specified
- Displays list of valid tool names for user reference
- Validation is non-blocking (allows unknown tools with warning)

### Files Changed

- `packages/cli/src/commands/author.ts` (lines 102-114, 253-260)

### Benefits

- Better user experience with clear feedback
- Helps catch typos in tool names
- Documents valid tool options inline

---

## SMI-1397: Add missing test coverage for --model and --batch options

**Type**: Test
**Labels**: `test`, `coverage`, `phase-9`
**Priority**: Low

### Summary

Added E2E tests for the `--model` option (subagent command) and `--batch` option (transform command) that were identified as missing during code review.

### Changes

- Added test for `--model opus` option
- Added test for `--model haiku` option
- Added test for `--batch` processing of multiple skills
- Verified generated content contains correct model specification

### Files Changed

- `packages/cli/tests/e2e/author.e2e.test.ts` (lines 581-616, 720-766)

### Test Cases Added

1. `should use specified model in subagent output` - Tests opus model
2. `should use haiku model when specified` - Tests haiku model
3. `should batch transform multiple skills` - Tests batch processing

---

## Implementation Status

| Issue ID | Title | Status |
|----------|-------|--------|
| SMI-1394 | Extract tool detection keywords to constants | ✅ Implemented |
| SMI-1395 | Extract shared path resolution utility | ✅ Implemented |
| SMI-1396 | Add tool name validation | ✅ Implemented |
| SMI-1397 | Add missing test coverage | ✅ Implemented |

All issues have been implemented and verified with passing tests.

---

## Quick Create Commands

To create these issues in Linear, run:

```bash
# SMI-1394
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" \
  "Extract tool detection keywords to configurable constants" \
  "Extracted hardcoded tool detection keywords to TOOL_DETECTION_KEYWORDS constant for maintainability."

# SMI-1395
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" \
  "Extract shared path resolution utility" \
  "Created resolveSkillPath() utility to eliminate duplicated path resolution logic."

# SMI-1396
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" \
  "Add tool name validation for --tools option" \
  "Added validateToolNames() to warn users about unknown tool names."

# SMI-1397
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" \
  "Add missing test coverage for --model and --batch options" \
  "Added E2E tests for model and batch options in author commands."
```
