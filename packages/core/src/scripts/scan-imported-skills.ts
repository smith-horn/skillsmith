/**
 * SMI-864: Security Scanner for Imported Skills
 * SMI-1189: This file is now a thin wrapper for backwards compatibility.
 *
 * The implementation has been refactored into modular files:
 * - packages/core/src/scripts/skill-scanner/
 *
 * Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [path-to-imported-skills.json]
 *
 * For direct imports, use:
 * import { scanImportedSkills } from './skill-scanner/index.js'
 */

export * from './skill-scanner/index.js'

// Re-run the CLI entry point
import './skill-scanner/index.js'
