/**
 * Error Classes Module - SMI-881
 *
 * Provides custom error classes with proper cause chaining for better error propagation.
 *
 * @example
 * ```typescript
 * import {
 *   SkillsmithError,
 *   ApiError,
 *   NetworkError,
 *   ValidationError,
 *   SkillError,
 *   ConfigurationError,
 *   wrapError,
 *   getErrorMessage
 * } from '@skillsmith/core/errors'
 *
 * try {
 *   const response = await fetch(url)
 *   if (!response.ok) {
 *     throw new ApiError('API request failed', {
 *       statusCode: response.status,
 *       url
 *     })
 *   }
 * } catch (error) {
 *   // Wrap unknown errors for consistent handling
 *   throw wrapError(error, 'Failed to fetch data')
 * }
 * ```
 *
 * @module errors
 */

export {
  SkillsmithError,
  NetworkError,
  ApiError,
  ValidationError,
  SkillError,
  ConfigurationError,
  wrapError,
  getErrorMessage,
  isSkillsmithError,
} from './SkillsmithError.js'
