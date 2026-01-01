/**
 * @fileoverview Suggestion Module Exports
 * @module @skillsmith/mcp-server/suggestions
 * @see SMI-913: Contextual skill suggestions after first success
 *
 * Re-exports all suggestion-related types and the SuggestionEngine class.
 *
 * @example
 * import {
 *   SuggestionEngine,
 *   type SkillSuggestion,
 *   type SuggestionConfig,
 *   type SuggestionState,
 * } from './suggestions';
 *
 * const engine = new SuggestionEngine();
 * const suggestions = engine.getSuggestions(context);
 */

export { SuggestionEngine } from './suggestion-engine.js'

export type { SkillSuggestion, SuggestionConfig, SuggestionState } from './types.js'
