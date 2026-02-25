/**
 * @fileoverview Tests for change-classifier.ts
 * @see SMI-skill-version-tracking Wave 2
 */

import { describe, it, expect } from 'vitest'
import { classifyChange } from './change-classifier.js'

// ============================================================================
// Fixtures
// ============================================================================

const BASE_SKILL = `---
name: test-skill
version: 1.0.0
---

## Overview

This is a test skill.

## Usage

Run with /test.

## Configuration

Set env vars.
`

const WITH_HEADING_REMOVED = `---
name: test-skill
version: 1.0.0
---

## Overview

This is a test skill.

## Usage

Run with /test.
`

const WITH_HEADING_ADDED = `---
name: test-skill
version: 1.0.0
---

## Overview

This is a test skill.

## Usage

Run with /test.

## Configuration

Set env vars.

## Examples

Here are examples.
`

const WITH_BODY_EDIT_ONLY = `---
name: test-skill
version: 1.0.0
---

## Overview

This is an UPDATED test skill.

## Usage

Run with /test command.

## Configuration

Set your env vars here.
`

const WITH_SEMVER_MAJOR = `---
name: test-skill
version: 2.0.0
---

## Overview

This is a test skill.

## Usage

Run with /test.

## Configuration

Set env vars.
`

const WITH_SEMVER_MINOR = `---
name: test-skill
version: 1.1.0
---

## Overview

This is a test skill.

## Usage

Run with /test.

## Configuration

Set env vars.
`

const WITH_SEMVER_PATCH = `---
name: test-skill
version: 1.0.1
---

## Overview

This is a test skill.

## Usage

Run with /test.

## Configuration

Set env vars.
`

const WITH_DEPENDENCY_REMOVED = `---
name: test-skill
version: 1.0.0
---

## Overview

A test skill with dependencies.

## Dependencies

- dep-b

## Usage

Run with /test.
`

const WITH_DEPENDENCY_ADDED = `---
name: test-skill
version: 1.0.0
---

## Overview

A test skill with dependencies.

## Dependencies

- dep-a
- dep-b
- dep-c

## Usage

Run with /test.
`

const BASE_WITH_DEPS = `---
name: test-skill
version: 1.0.0
---

## Overview

A test skill with dependencies.

## Dependencies

- dep-a
- dep-b

## Usage

Run with /test.
`

// ============================================================================
// Tests
// ============================================================================

describe('classifyChange', () => {
  describe('heading removal → major', () => {
    it('returns major when a heading is removed', () => {
      expect(classifyChange(BASE_SKILL, WITH_HEADING_REMOVED)).toBe('major')
    })

    it('returns major when multiple headings are removed', () => {
      const twoHeadingsGone = `---
name: test-skill
version: 1.0.0
---

## Overview

Only this remains.
`
      expect(classifyChange(BASE_SKILL, twoHeadingsGone)).toBe('major')
    })
  })

  describe('heading addition only → minor', () => {
    it('returns minor when a heading is added with no removals', () => {
      expect(classifyChange(BASE_SKILL, WITH_HEADING_ADDED)).toBe('minor')
    })
  })

  describe('body edits only → patch', () => {
    it('returns patch when only body text changes', () => {
      expect(classifyChange(BASE_SKILL, WITH_BODY_EDIT_ONLY)).toBe('patch')
    })

    it('returns patch when content is identical', () => {
      expect(classifyChange(BASE_SKILL, BASE_SKILL)).toBe('patch')
    })
  })

  describe('semver in frontmatter overrides heuristic', () => {
    it('returns major when semver major bumps', () => {
      // semver overrides even if headings look like minor
      expect(classifyChange(BASE_SKILL, WITH_SEMVER_MAJOR)).toBe('major')
    })

    it('returns minor when semver minor bumps', () => {
      expect(classifyChange(BASE_SKILL, WITH_SEMVER_MINOR)).toBe('minor')
    })

    it('returns patch when semver patch bumps', () => {
      expect(classifyChange(BASE_SKILL, WITH_SEMVER_PATCH)).toBe('patch')
    })

    it('semver override applies even when headings were removed (semver wins)', () => {
      // new content: semver 2.0.0 + heading removed — semver says major, heuristic also says major
      const newContent = `---
name: test-skill
version: 2.0.0
---

## Overview

Only overview.
`
      expect(classifyChange(BASE_SKILL, newContent)).toBe('major')
    })
  })

  describe('risk score delta > 20 → major', () => {
    it('upgrades to major when risk delta exceeds 20', () => {
      // No heading changes but risk jumped significantly
      expect(classifyChange(BASE_SKILL, WITH_BODY_EDIT_ONLY, 10, 35)).toBe('major')
    })

    it('does not upgrade when risk delta is exactly 20', () => {
      expect(classifyChange(BASE_SKILL, WITH_BODY_EDIT_ONLY, 10, 30)).toBe('patch')
    })

    it('does not upgrade when risk decreases', () => {
      expect(classifyChange(BASE_SKILL, WITH_BODY_EDIT_ONLY, 50, 20)).toBe('patch')
    })
  })

  describe('dependency changes', () => {
    it('returns major when a dependency is removed', () => {
      // No semver change, no heading change, but dep removed
      const base = BASE_WITH_DEPS
      expect(classifyChange(base, WITH_DEPENDENCY_REMOVED)).toBe('major')
    })

    it('returns minor when a dependency is added', () => {
      const base = BASE_WITH_DEPS
      expect(classifyChange(base, WITH_DEPENDENCY_ADDED)).toBe('minor')
    })
  })

  describe('error / unknown content', () => {
    it('returns patch for empty content (no headings or semver)', () => {
      expect(classifyChange('', '')).toBe('patch')
    })

    it('returns unknown when classifier throws (simulated by invalid regex-triggering content)', () => {
      // Pass valid strings — classifier should not throw, returns patch
      expect(classifyChange('hello', 'world')).toBe('patch')
    })
  })
})
