/**
 * SMI-2167: Structural Typing Boundary Tests
 *
 * Tests that verify the structural typing approach for Zod v3/v4 compatibility.
 * The API client uses structural typing instead of `z.ZodType` to allow schemas
 * from different Zod versions to be used interchangeably.
 *
 * @see docs/adr/027-zod-version-coexistence.md
 */

import { describe, it, expect } from 'vitest'

/**
 * The structural interface expected by the API client.
 * This mirrors the type in client.ts:233-236
 */
interface StructuralSchema<T> {
  safeParse(data: unknown): {
    success: boolean
    data?: T
    error?: { issues: Array<{ path: (string | number)[]; message: string }> }
  }
}

/**
 * Mock API response type for testing
 */
interface MockApiResponse<T> {
  data: T
  meta?: { total?: number }
}

describe('Structural Typing for Zod v3/v4 Compatibility', () => {
  describe('StructuralSchema Interface', () => {
    it('should accept a schema that returns success with data', () => {
      const mockSchema: StructuralSchema<MockApiResponse<{ id: string }>> = {
        safeParse: (data: unknown) => ({
          success: true,
          data: data as MockApiResponse<{ id: string }>,
        }),
      }

      const input = { data: { id: '123' } }
      const result = mockSchema.safeParse(input)

      expect(result.success).toBe(true)
      expect(result.data).toEqual(input)
    })

    it('should accept a schema that returns failure with error', () => {
      const mockSchema: StructuralSchema<MockApiResponse<{ id: string }>> = {
        safeParse: () => ({
          success: false,
          error: {
            issues: [{ path: ['data', 'id'], message: 'Expected string, received number' }],
          },
        }),
      }

      const result = mockSchema.safeParse({ data: { id: 123 } })

      expect(result.success).toBe(false)
      expect(result.error?.issues).toHaveLength(1)
      expect(result.error?.issues[0].path).toEqual(['data', 'id'])
    })

    it('should work with custom schema implementations (not Zod)', () => {
      // Simulates a non-Zod schema that implements the structural interface
      const customValidator: StructuralSchema<MockApiResponse<string[]>> = {
        safeParse: (data: unknown) => {
          if (
            typeof data === 'object' &&
            data !== null &&
            'data' in data &&
            Array.isArray((data as { data: unknown }).data)
          ) {
            return { success: true, data: data as MockApiResponse<string[]> }
          }
          return {
            success: false,
            error: { issues: [{ path: ['data'], message: 'Expected array' }] },
          }
        },
      }

      // Valid input
      const validResult = customValidator.safeParse({ data: ['a', 'b'] })
      expect(validResult.success).toBe(true)
      expect(validResult.data?.data).toEqual(['a', 'b'])

      // Invalid input
      const invalidResult = customValidator.safeParse({ data: 'not-array' })
      expect(invalidResult.success).toBe(false)
      expect(invalidResult.error?.issues[0].message).toBe('Expected array')
    })
  })

  describe('Error Handling with Structural Types', () => {
    it('should handle error.issues array for error message generation', () => {
      const schemaWithMultipleErrors: StructuralSchema<MockApiResponse<{ a: string; b: number }>> =
        {
          safeParse: () => ({
            success: false,
            error: {
              issues: [
                { path: ['data', 'a'], message: 'Required' },
                { path: ['data', 'b'], message: 'Expected number' },
              ],
            },
          }),
        }

      const result = schemaWithMultipleErrors.safeParse({})

      expect(result.success).toBe(false)
      expect(result.error?.issues).toHaveLength(2)

      // Simulate error message generation like client.ts:298-300
      const errorMessage = result.error?.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ')

      expect(errorMessage).toBe('data.a: Required, data.b: Expected number')
    })

    it('should handle empty issues array gracefully', () => {
      const schemaWithEmptyIssues: StructuralSchema<MockApiResponse<unknown>> = {
        safeParse: () => ({
          success: false,
          error: { issues: [] },
        }),
      }

      const result = schemaWithEmptyIssues.safeParse({})

      expect(result.success).toBe(false)
      expect(result.error?.issues).toEqual([])

      // Empty issues array produces empty string, fallback handles it
      const errorMessage =
        result.error?.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join(', ') || 'Unknown validation error'

      // With empty issues, map returns [], join returns '', which is falsy, so fallback is used
      expect(errorMessage).toBe('Unknown validation error')
    })

    it('should handle nested path arrays', () => {
      const schemaWithNestedPath: StructuralSchema<MockApiResponse<unknown>> = {
        safeParse: () => ({
          success: false,
          error: {
            issues: [{ path: ['data', 'items', 0, 'name'], message: 'Invalid' }],
          },
        }),
      }

      const result = schemaWithNestedPath.safeParse({})
      const errorMessage = result.error?.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ')

      expect(errorMessage).toBe('data.items.0.name: Invalid')
    })
  })

  describe('Type Safety', () => {
    it('should preserve generic type through validation', () => {
      interface User {
        id: string
        name: string
      }

      const userSchema: StructuralSchema<MockApiResponse<User>> = {
        safeParse: (data: unknown) => ({
          success: true,
          data: data as MockApiResponse<User>,
        }),
      }

      const result = userSchema.safeParse({ data: { id: '1', name: 'Test' } })

      if (result.success && result.data) {
        // TypeScript should know result.data is MockApiResponse<User>
        const user: User = result.data.data
        expect(user.id).toBe('1')
        expect(user.name).toBe('Test')
      }
    })

    it('should allow optional meta field in response', () => {
      const schemaWithMeta: StructuralSchema<MockApiResponse<string[]>> = {
        safeParse: (data: unknown) => ({
          success: true,
          data: data as MockApiResponse<string[]>,
        }),
      }

      const withMeta = schemaWithMeta.safeParse({ data: [], meta: { total: 0 } })
      const withoutMeta = schemaWithMeta.safeParse({ data: [] })

      expect(withMeta.success).toBe(true)
      expect(withMeta.data?.meta?.total).toBe(0)
      expect(withoutMeta.success).toBe(true)
      expect(withoutMeta.data?.meta).toBeUndefined()
    })
  })

  describe('Compatibility with Real Zod Schemas', () => {
    // These tests verify that actual Zod schemas work at runtime
    // Note: We use explicit typing rather than assignment to StructuralSchema
    // because Zod v4's path type (PropertyKey[]) includes symbol, which is
    // stricter than our interface's (string | number)[]
    it('should work with Zod-like safeParse return type', async () => {
      // Import actual Zod to verify runtime compatibility
      const { z } = await import('zod')

      const zodSchema = z.object({
        data: z.object({
          id: z.string(),
        }),
      })

      // Test that Zod schema works at runtime (structural compatibility)
      const validResult = zodSchema.safeParse({ data: { id: 'test' } })
      expect(validResult.success).toBe(true)
      if (validResult.success) {
        expect(validResult.data.data.id).toBe('test')
      }

      const invalidResult = zodSchema.safeParse({ data: { id: 123 } })
      expect(invalidResult.success).toBe(false)
      if (!invalidResult.success) {
        // Zod's path array is compatible at runtime
        const paths = invalidResult.error.issues.map((i) => i.path)
        expect(paths[0]).toContain('id')
      }
    })

    it('should demonstrate structural typing works with wrapped schema', async () => {
      const { z } = await import('zod')

      const zodSchema = z.object({
        data: z.string(),
      })

      // Wrap Zod schema to satisfy our structural interface exactly
      // This is what the API client effectively does
      const wrappedSchema: StructuralSchema<{ data: string }> = {
        safeParse: (data: unknown) => {
          const result = zodSchema.safeParse(data)
          if (result.success) {
            return { success: true, data: result.data }
          }
          return {
            success: false,
            error: {
              issues: result.error.issues.map((i) => ({
                path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
                message: i.message,
              })),
            },
          }
        },
      }

      const valid = wrappedSchema.safeParse({ data: 'hello' })
      expect(valid.success).toBe(true)

      const invalid = wrappedSchema.safeParse({ data: 123 })
      expect(invalid.success).toBe(false)
    })
  })
})
