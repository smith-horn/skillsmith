/**
 * SKILL.md heading-gate regression test (SMI-4529)
 * @module scripts/tests/indexer/skill-md-heading-gate
 *
 * Pins the invariant that `validateSkillMd`'s quality gate 3 accepts a
 * SKILL.md whose title is expressed as:
 *   - a level-1 heading (`# Title`),
 *   - a deeper heading only (`## Title`, `### Title`, ...), OR
 *   - a frontmatter `name` field with no markdown heading at all.
 *
 * Regression: the prior gate used `/^#\s+.+/m`, which demanded a level-1
 * `# H1` and ignored frontmatter entirely. Valid skills authored with
 * `##`-only headings or a frontmatter `name` but no `# H1` were rejected
 * with `installable: false` and `repo_url: null`, dropping them to
 * discovery-only across every author. The fix demotes gate 3 to accept any
 * heading level OR a non-empty frontmatter `name`.
 *
 * A post-merge indexer dispatch / `skill_rescan` is needed to recover the
 * already-dropped skills — this test only pins the validator behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateSkillMd } from '../../indexer/skill-processor.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

/**
 * Build a 200-status `Response` whose streamed body is `body`. `validateSkillMd`
 * reads the body via `response.body.getReader()`, so a real `Response` from a
 * string is sufficient — no custom stream plumbing required.
 */
function skillMdResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

describe('validateSkillMd quality gate 3 — heading / frontmatter name (SMI-4529)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = vi.fn()
    // @ts-expect-error overriding global for test
    global.fetch = fetchMock
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  // Non-strict validation isolates gate 3: strict mode would add unrelated
  // frontmatter-completeness errors that obscure whether gate 3 passed.
  const opts = { strictValidation: false }

  it('accepts a SKILL.md with only `##`-level headings (no `# H1`)', async () => {
    const content = [
      '## Overview',
      '',
      'This skill helps with a focused task. It documents the workflow in',
      'enough prose to clear the minimum-length gate comfortably.',
      '',
      '## Usage',
      '',
      'Invoke it when the trigger phrase appears in the conversation.',
    ].join('\n')
    fetchMock.mockResolvedValueOnce(skillMdResponse(content))

    const result = await validateSkillMd(
      'acme',
      'widget',
      'main',
      newRateLimitTelemetry(),
      undefined,
      opts
    )

    expect(result.valid).toBe(true)
    expect(result.errors).not.toContain(
      'SKILL.md must contain a heading or a frontmatter "name" field'
    )
  })

  it('accepts a SKILL.md with a frontmatter `name` but no markdown heading', async () => {
    const content = [
      '---',
      'name: data-pipeline',
      'description: A skill that documents an ETL pipeline for analytics data.',
      '---',
      '',
      'This skill helps with a focused task and documents the workflow in',
      'enough prose to clear the minimum-length gate comfortably without any',
      'markdown heading present anywhere in the body.',
    ].join('\n')
    fetchMock.mockResolvedValueOnce(skillMdResponse(content))

    const result = await validateSkillMd(
      'acme',
      'widget',
      'main',
      newRateLimitTelemetry(),
      undefined,
      opts
    )

    expect(result.valid).toBe(true)
    expect(result.errors).not.toContain(
      'SKILL.md must contain a heading or a frontmatter "name" field'
    )
    expect(result.metadata?.name).toBe('data-pipeline')
  })

  it('still accepts a conventional `# H1` SKILL.md (no regression)', async () => {
    const content = [
      '# Widget Skill',
      '',
      'This skill helps with a focused task. It documents the workflow in',
      'enough prose to clear the minimum-length gate comfortably.',
    ].join('\n')
    fetchMock.mockResolvedValueOnce(skillMdResponse(content))

    const result = await validateSkillMd(
      'acme',
      'widget',
      'main',
      newRateLimitTelemetry(),
      undefined,
      opts
    )

    expect(result.valid).toBe(true)
    expect(result.errors).not.toContain(
      'SKILL.md must contain a heading or a frontmatter "name" field'
    )
  })

  it('rejects a SKILL.md with no heading and no frontmatter `name`', async () => {
    const content = [
      '---',
      'description: A skill whose frontmatter omits the name field entirely.',
      '---',
      '',
      'Plain prose with no markdown heading and no frontmatter name. This is',
      'long enough to clear the minimum-length gate so the heading gate is',
      'the only one under test here.',
    ].join('\n')
    fetchMock.mockResolvedValueOnce(skillMdResponse(content))

    const result = await validateSkillMd(
      'acme',
      'widget',
      'main',
      newRateLimitTelemetry(),
      undefined,
      opts
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('SKILL.md must contain a heading or a frontmatter "name" field')
  })

  it('rejects a SKILL.md whose frontmatter `name` is blank whitespace', async () => {
    const content = [
      '---',
      'name: "   "',
      'description: A skill whose frontmatter name is only whitespace.',
      '---',
      '',
      'Plain prose with no markdown heading. This is long enough to clear the',
      'minimum-length gate so the heading gate is the only one under test.',
    ].join('\n')
    fetchMock.mockResolvedValueOnce(skillMdResponse(content))

    const result = await validateSkillMd(
      'acme',
      'widget',
      'main',
      newRateLimitTelemetry(),
      undefined,
      opts
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('SKILL.md must contain a heading or a frontmatter "name" field')
  })
})
