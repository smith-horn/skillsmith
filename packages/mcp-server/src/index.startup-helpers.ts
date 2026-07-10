/**
 * @fileoverview Startup-flag and bundled-skill helpers extracted from index.ts (SMI-5639).
 * @module @skillsmith/mcp-server/index.startup-helpers
 *
 * Extracted to keep index.ts under the `audit:standards` 500-LOC gate after
 * SMI-5639's shutdown-hook fix. No behavior change from the prior in-file
 * versions.
 */

import { exec } from 'child_process'
import { createLogger } from '@skillsmith/core/logging'
import { installBundledSkills, getUserGuidePath } from './onboarding/install-assets.js'

const logger = createLogger('mcp')

/**
 * Handle --docs flag to open user documentation
 */
export function handleDocsFlag(): void {
  const userGuidePath = getUserGuidePath()
  const onlineDocsUrl = 'https://skillsmith.app/docs'

  if (userGuidePath) {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${userGuidePath}"`)
    console.log(`Opening documentation: ${userGuidePath}`)
  } else {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${onlineDocsUrl}"`)
    console.log(`Opening online documentation: ${onlineDocsUrl}`)
  }
  process.exit(0)
}

/**
 * SMI-4790: Idempotent install of the bundled `skillsmith` slash-command skill
 * for MCP-only users (who never ran `skillsmith setup`) and recovery if the
 * skill was uninstalled. Delegates routing to the existing
 * `installBundledSkills()` which honours the SKILLSMITH_CLIENT env var via
 * `resolveClientPath()` (Claude Code default; cursor/copilot/windsurf via env).
 *
 * Quiet by design: `installBundledSkills()` only logs when it actually copies
 * a skill or hits an error, so happy-path startup adds zero stderr.
 */
export function ensureSkillsmithSkillInstalled(): void {
  try {
    installBundledSkills()
  } catch (error) {
    // Fail-soft: never block MCP startup on bundled-skill install failure.
    const msg = error instanceof Error ? error.message : 'Unknown error'
    logger.warn(`[skillsmith] Bundled skill install failed (non-fatal): ${msg}`, { err: error })
  }
}
