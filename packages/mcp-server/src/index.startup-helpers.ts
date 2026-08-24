/**
 * @fileoverview Startup-flag, bundled-skill, and diagnostics helpers extracted
 * from index.ts (SMI-5639; runStartupDiagnostics added SMI-6111).
 * @module @skillsmith/mcp-server/index.startup-helpers
 *
 * Extracted to keep index.ts under the `audit:standards` 500-LOC gate. No
 * behavior change from the prior in-file versions — in particular, both
 * logging functions below take `version` explicitly rather than creating a
 * module-scope `logger` here, so their log records keep the real
 * `PACKAGE_VERSION` stamp index.ts's own logger uses instead of silently
 * downgrading to `createLogger`'s `'unknown'` default (caught in review of
 * SMI-6111 — a prior, still-live instance of the same drop dates back to this
 * file's SMI-5639 origin, in `ensureSkillsmithSkillInstalled`).
 */

import { exec } from 'child_process'
import { createRequire } from 'node:module'
import { createLogger } from '@skillsmith/core/logging'
import { installBundledSkills, getUserGuidePath } from './onboarding/install-assets.js'

// ESM-compatible require for dynamic module resolution (native-module probe below)
const require = createRequire(import.meta.url)

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
 *
 * @param version - Host package's `PACKAGE_VERSION` (index.ts), stamped on
 *   any log record emitted here. Defaults to `'unknown'` only for callers
 *   that genuinely don't have a version (e.g. direct unit tests).
 */
export function ensureSkillsmithSkillInstalled(version = 'unknown'): void {
  const logger = createLogger('mcp', { version })
  try {
    installBundledSkills()
  } catch (error) {
    // Fail-soft: never block MCP startup on bundled-skill install failure.
    const msg = error instanceof Error ? error.message : 'Unknown error'
    logger.warn(`[skillsmith] Bundled skill install failed (non-fatal): ${msg}`, { err: error })
  }
}

/**
 * SMI-2163: Startup diagnostics for common installation issues
 * Detects native module problems and provides actionable error messages
 *
 * @param version - Host package's `PACKAGE_VERSION` (index.ts), stamped on
 *   any log record emitted here. Defaults to `'unknown'` only for callers
 *   that genuinely don't have a version (e.g. direct unit tests).
 */
export function runStartupDiagnostics(version = 'unknown'): void {
  const logger = createLogger('mcp', { version })
  // Check for native module issues by attempting dynamic import simulation
  // The actual check happens when @skillsmith/core loads better-sqlite3
  try {
    // Verify core module can be loaded (will fail if native modules broken)
    require.resolve('@skillsmith/core')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)

    if (msg.includes('NODE_MODULE_VERSION')) {
      logger.error(`
╔══════════════════════════════════════════════════════════════╗
║  Skillsmith: Native Module Version Mismatch                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Your Node.js version (${process.version.padEnd(10)}) doesn't match the       ║
║  pre-compiled native modules.                                ║
║                                                              ║
║  To fix, run one of:                                         ║
║                                                              ║
║    SKILLSMITH_FORCE_WASM=true to use WASM SQLite fallback    ║
║                                                              ║
║  Or reinstall completely:                                    ║
║                                                              ║
║    npm uninstall @skillsmith/mcp-server                      ║
║    npm install @skillsmith/mcp-server                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`)
      process.exit(1)
    }

    if (msg.includes('GLIBC') || msg.includes('libc') || msg.includes('GLIBCXX')) {
      logger.error(`
╔══════════════════════════════════════════════════════════════╗
║  Skillsmith: Missing System Library (glibc)                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Native modules require glibc which is not available on      ║
║  Alpine Linux or some minimal containers.                    ║
║                                                              ║
║  Options:                                                    ║
║    1. Use a Debian/Ubuntu-based environment                  ║
║    2. Use Docker: docker run -it node:22 npx @skillsmith/... ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`)
      process.exit(1)
    }

    if (msg.includes('invalid ELF header')) {
      logger.error(`
╔══════════════════════════════════════════════════════════════╗
║  Skillsmith: Architecture Mismatch                           ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Native modules were compiled for a different architecture.  ║
║                                                              ║
║  This can happen when:                                       ║
║    - Copying node_modules between machines                   ║
║    - Running x86 modules on ARM (or vice versa)              ║
║                                                              ║
║  To fix, reinstall:                                          ║
║                                                              ║
║    rm -rf node_modules                                       ║
║    npm install                                               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`)
      process.exit(1)
    }

    // Unknown module resolution error - log but don't exit
    // The actual error will surface when the module is used
    logger.warn(`[Skillsmith] Warning: Could not resolve @skillsmith/core: ${msg}`)
  }
}
