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
export const TrustTierSchema = z.enum(['verified', 'community', 'experimental', 'unknown'])

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
  repo_url: z.string().nullable().optional(),
  quality_score: z.number().nullable(),
  trust_tier: TrustTierSchema.optional().default('unknown'),
  tags: z.array(z.string()).default([]),
  stars: z.number().nullable().optional(),
  installable: z.boolean().nullable().optional(),
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
