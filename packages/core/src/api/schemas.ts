/**
 * Zod Schemas for API Response Validation
 * @module api/schemas
 *
 * SMI-1258: Runtime validation for API responses using zod
 */

import { z } from 'zod'

// ============================================================================
// Trust Tier Schema
// ============================================================================

/**
 * Trust tier enum values
 */
export const TrustTierSchema = z.enum([
  'verified',
  'curated',
  'community',
  'experimental',
  'unknown',
])

// ============================================================================
// API Search Result Schema
// ============================================================================

/**
 * Schema for individual search result from API
 * SMI-1577: Added .optional() and .default() to handle partial API responses
 */
export const ApiSearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  publisher: z.string().nullable().optional(),
  repo_url: z.string().nullable().optional(),
  quality_score: z.number().nullable(),
  trust_tier: TrustTierSchema.optional().default('unknown'),
  tags: z.array(z.string()).default([]),
  stars: z.number().nullable().optional(),
  installable: z.boolean().nullable().optional(),
  /** SMI-3672: Raw SKILL.md content (only present when include_content=true) */
  content: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

// ============================================================================
// API Response Schema Factory
// ============================================================================

/**
 * Schema for generic API response wrapper
 */
export function createApiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: z.record(z.string(), z.unknown()).optional(),
  })
}

// ============================================================================
// Telemetry Schema
// ============================================================================

/**
 * Schema for telemetry response
 */
export const TelemetryResponseSchema = z.object({
  data: z.object({
    ok: z.boolean(),
  }),
  meta: z.record(z.string(), z.unknown()).optional(),
})

// ============================================================================
// Telemetry Batch Schemas (SMI-4119)
// ============================================================================

/**
 * Schema for a single telemetry event payload.
 * Used to validate batch entries client-side before POST.
 */
export const TelemetryEventSchema = z.object({
  event: z.enum([
    'skill_view',
    'skill_install',
    'skill_uninstall',
    'skill_rate',
    'search',
    'recommend',
    'compare',
    'validate',
  ]),
  skill_id: z.string().optional(),
  anonymous_id: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Request schema for batched telemetry: `{ events: [...] }` (1..=20).
 */
export const TelemetryEventBatchSchema = z.object({
  events: z.array(TelemetryEventSchema).min(1).max(20),
})

/**
 * Response schema for batched telemetry POST.
 * Returned ONLY for the array-body path; single-event POST still returns `{ ok: true }`.
 */
export const TelemetryBatchResponseSchema = z.object({
  ok: z.boolean(),
  accepted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  errors: z
    .array(
      z.object({
        index: z.number().int(),
        reason: z.string(),
      })
    )
    .optional(),
})

export type TelemetryEventPayload = z.infer<typeof TelemetryEventSchema>
export type TelemetryEventBatch = z.infer<typeof TelemetryEventBatchSchema>
export type TelemetryBatchResponse = z.infer<typeof TelemetryBatchResponseSchema>

// ============================================================================
// Pre-built Response Schemas
// ============================================================================

/**
 * Search response schema with array of results
 */
export const SearchResponseSchema = createApiResponseSchema(z.array(ApiSearchResultSchema))

/**
 * Single skill response schema
 */
export const SingleSkillResponseSchema = createApiResponseSchema(ApiSearchResultSchema)

// ============================================================================
// Type Inference
// ============================================================================

/**
 * Inferred type from ApiSearchResultSchema
 */
export type ValidatedApiSearchResult = z.infer<typeof ApiSearchResultSchema>

/**
 * Inferred type from SearchResponseSchema
 */
export type ValidatedSearchResponse = z.infer<typeof SearchResponseSchema>

/**
 * Inferred type from SingleSkillResponseSchema
 */
export type ValidatedSingleSkillResponse = z.infer<typeof SingleSkillResponseSchema>

/**
 * Inferred type from TelemetryResponseSchema
 */
export type ValidatedTelemetryResponse = z.infer<typeof TelemetryResponseSchema>
