import { describe, it, expect } from 'vitest'
import { dedupeComponentsBySlug, planComponentReconciliation } from './status-reconcile'
import { COMPONENTS, type StatusComponent } from './status-vocab'

function makeComponent(overrides: Partial<StatusComponent> = {}): StatusComponent {
  return {
    slug: 'website',
    name: 'Website',
    description: 'desc',
    display_order: 0,
    status: 'operational',
    latency_ms: 42,
    message: 'All good',
    checked_at: '2026-07-15T00:00:00Z',
    uptime_90d: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Dynamic-row reconciliation contract (Codex #3)
// ---------------------------------------------------------------------------

describe('dedupeComponentsBySlug', () => {
  it('skips a duplicate slug, keeping the first occurrence', () => {
    const { components, duplicateSlugs } = dedupeComponentsBySlug([
      makeComponent({ slug: 'a', name: 'First' }),
      makeComponent({ slug: 'a', name: 'Second' }),
      makeComponent({ slug: 'b' }),
    ])
    expect(components.map((c) => c.slug)).toEqual(['a', 'b'])
    expect(components[0].name).toBe('First')
    expect(duplicateSlugs).toEqual(['a'])
  })
})

describe('planComponentReconciliation', () => {
  const scaffoldSlugs = new Set(COMPONENTS.map((c) => c.slug))

  it('an unrecognized slug is planned for creation as a dynamic row', () => {
    const plan = planComponentReconciliation(
      [makeComponent({ slug: 'a-new-service' })],
      new Set(scaffoldSlugs),
      scaffoldSlugs
    )
    expect(plan.toCreate.map((c) => c.slug)).toEqual(['a-new-service'])
    expect(plan.toUpsert).toHaveLength(0)
  })

  it('the dynamic-row contract: created on first poll, removed once absent from a later poll', () => {
    // First poll: a payload with an unrecognized slug.
    const firstPlan = planComponentReconciliation(
      [makeComponent({ slug: 'ephemeral-service' })],
      new Set(scaffoldSlugs),
      scaffoldSlugs
    )
    expect(firstPlan.toCreate.map((c) => c.slug)).toEqual(['ephemeral-service'])

    // Simulate the row having been created and now existing in the DOM.
    const existingAfterCreate = new Set([...scaffoldSlugs, 'ephemeral-service'])

    // Second poll: the payload no longer includes that slug.
    const secondPlan = planComponentReconciliation([], existingAfterCreate, scaffoldSlugs)
    expect(secondPlan.toRemoveSlugs).toEqual(['ephemeral-service'])
    // Every fixed scaffold slug is reset, never removed.
    expect(secondPlan.toResetSlugs.sort()).toEqual([...scaffoldSlugs].sort())
    expect(secondPlan.toRemoveSlugs).not.toEqual(expect.arrayContaining([...scaffoldSlugs]))
  })

  it('a scaffold slug absent from the payload is reset, never removed', () => {
    const plan = planComponentReconciliation([], new Set(scaffoldSlugs), scaffoldSlugs)
    expect(plan.toResetSlugs.sort()).toEqual([...scaffoldSlugs].sort())
    expect(plan.toRemoveSlugs).toEqual([])
  })

  it('an existing scaffold slug present in the payload is upserted, not recreated', () => {
    const plan = planComponentReconciliation(
      [makeComponent({ slug: 'website' })],
      new Set(scaffoldSlugs),
      scaffoldSlugs
    )
    expect(plan.toUpsert.map((c) => c.slug)).toEqual(['website'])
    expect(plan.toCreate).toHaveLength(0)
  })

  it('deduplicates the payload before planning (a duplicate slug is not created twice)', () => {
    const plan = planComponentReconciliation(
      [makeComponent({ slug: 'dup' }), makeComponent({ slug: 'dup' })],
      new Set(scaffoldSlugs),
      scaffoldSlugs
    )
    expect(plan.toCreate).toHaveLength(1)
  })
})
