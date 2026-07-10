#!/usr/bin/env node
/**
 * Skillsmith MCP Server
 * Provides skill discovery, installation, and management tools
 *
 * @see SMI-792: Database initialization with tool context
 * @see SMI-XXXX: First-run integration and documentation delivery
 */

import { createRequire } from 'node:module'

// ESM-compatible require for dynamic module resolution
const require = createRequire(import.meta.url)
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// SMI-2208: Use async context for WASM fallback support
import { getToolContextAsync, type ToolContext } from './context.js'
import { searchToolSchema } from './tools/search.js'
import { getSkillToolSchema } from './tools/get-skill.js'
import { installTool } from './tools/install.js'
import { uninstallTool } from './tools/uninstall.js'
import { recommendToolSchema } from './tools/recommend.js'
import { validateToolSchema } from './tools/validate.js'
import { compareToolSchema } from './tools/compare.js'
import { suggestToolSchema } from './tools/suggest.js'
import { indexLocalToolSchema } from './tools/index-local.js'
import { publishToolSchema } from './tools/publish.js'
import { skillUpdatesToolSchema } from './tools/skill-updates.js'
import { skillDiffToolSchema } from './tools/skill-diff.js'
import { skillAuditToolSchema } from './tools/skill-audit.js'
import { skillPackAuditToolSchema } from './tools/skill-pack-audit.js'
import { outdatedToolSchema } from './tools/outdated.js'
import { skillRescanToolSchema } from './tools/skill-rescan.js'
import {
  auditExportToolSchema,
  auditQueryToolSchema,
  siemExportToolSchema,
} from './tools/audit-tools.js'
import { teamWorkspaceToolSchema, shareSkillToolSchema } from './tools/team-workspace.js'
import { publishPrivateToolSchema } from './tools/publish-private.js'
import {
  teamAnalyticsDashboardToolSchema,
  teamUsageReportToolSchema,
  analyticsDashboardToolSchema,
  usageReportToolSchema,
} from './tools/analytics.js'
import { configureSsoToolSchema, ssoSettingsToolSchema } from './tools/sso-tools.js'
import {
  privateRegistryPublishToolSchema,
  privateRegistryManageToolSchema,
} from './tools/registry-tools.js'
import {
  rbacManageToolSchema,
  rbacAssignRoleToolSchema,
  rbacCreatePolicyToolSchema,
} from './tools/rbac-tools.js'
import { webhookConfigureToolSchema, apiKeyManageToolSchema } from './tools/integration-tools.js'
import { complianceReportToolSchema } from './tools/compliance-tools.js'
import { inventoryPushToolSchema } from './tools/inventory-push.js'
// SMI-5479: CallTool handler extracted to a sibling module (index.ts LOC gate).
import { handleCallToolRequest } from './call-tool-handler.js'
// SMI-5213: make the three audit-family tools client-discoverable. The
// builder gates `apply_recommended_edit` on APPLY_TEMPLATE_REGISTRY and
// omits the already-registered `skill_audit` / `skill_pack_audit`.
import { newAuditToolDefinitions } from './audit-tool-dispatch.js'
// SMI-5541 Wave 2C Stage 2 — background continuous-audit email digest.
import { maybeAutoNotifyAudit } from './audit/audit-notify.js'
// SMI-5407: skill_recover_source — Community read-only provenance tool
import { provenanceToolDefinitions } from './provenance-tool-dispatch.js'
import { isFirstRun, markFirstRunComplete } from './onboarding/first-run.js'
// SMI-5582: Tier-1 registry install + self-heal orchestration. Heavy logic
// (state-file I/O, the timeout-guarded install loop, welcome-message
// composition) lives in this sibling to keep index.ts under the 500-LOC gate.
// Re-exported below for integration testability (plan G).
import { maybeInstallMissingTier1Skills } from './onboarding/tier1-self-heal.js'
import { checkForUpdates, formatUpdateNotification } from '@skillsmith/core'
// SMI-5456: agent-mediation marker channel — resolution + AsyncLocalStorage
// scoping now live in call-tool-handler.js (SMI-5479 extraction).
// SMI-5479: flush-on-shutdown wiring lives in shutdown.js (own module — no
// top-level side effects, so it stays independently unit-testable; this file
// has `main().catch(...)` at module scope, which importing would trigger).
import { createShutdownTrigger } from './shutdown.js'
// SMI-5039: probe extracted from this file to @skillsmith/core/embeddings/probe.
// The call site (before server.connect) is unchanged; only the implementation
// moved so doc-retrieval-mcp + cli can share the same audited probe contract.
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'
// SMI-5615: shared logger — error/warn mirror to console unconditionally
// (safe console.error/warn swap); info/debug are disk-only by default.
import { createLogger } from '@skillsmith/core/logging'
import { createLicenseMiddleware } from './middleware/license.js'
import { createQuotaMiddleware } from './middleware/quota.js'
import { resolveStartupFlag } from './cli-flags.js'
// SMI-5456: curated agent tool profile — narrows ListTools to ~15 tools when
// SKILLSMITH_TOOL_PROFILE=agent; no-op (full surface) otherwise. Listing-only,
// see middleware/toolProfile.ts for the full contract.
import { filterToolsForAgentProfile } from './middleware/toolProfile.js'

// SMI-5125: re-export the inline Stripe webhook contract interfaces so the
// canonical contract in `@smith-horn/enterprise/billing` can be type-equality
// checked against this package's structural copy across the package boundary.
// Type-only — erased from the emitted JS, adds nothing to the binary entrypoint.
// The drift guard at
// `packages/enterprise/tests/billing/StripeWebhookHandler.drift.test.ts` fails
// `tsc` if the two definitions diverge.
export type {
  StripeWebhookHandler,
  StripeWebhookResult,
} from './webhooks/stripe-webhook-endpoint.js'

// Package version - keep in sync with package.json
const PACKAGE_VERSION = '0.7.1'
const PACKAGE_NAME = '@skillsmith/mcp-server'
const logger = createLogger('mcp', { version: PACKAGE_VERSION }) // SMI-5615
import { installBundledSkills, installUserDocs } from './onboarding/install-assets.js'
import { handleDocsFlag, ensureSkillsmithSkillInstalled } from './index.startup-helpers.js'

// SMI-2679: Quota enforcement middleware — module-level singletons, initialized once
// licenseMiddleware uses a cache (TTL) so the first-call @skillsmith/enterprise lazy-load
// latency (~10-50ms) is not incurred on every tool invocation.
const licenseMiddleware = createLicenseMiddleware()
const quotaMiddleware = createQuotaMiddleware()

// Initialize tool context with database connection
let toolContext: ToolContext

// Tool definitions for MCP
const toolDefinitions = [
  searchToolSchema,
  getSkillToolSchema,
  installTool,
  uninstallTool,
  recommendToolSchema,
  validateToolSchema,
  compareToolSchema,
  suggestToolSchema,
  indexLocalToolSchema,
  publishToolSchema,
  skillUpdatesToolSchema,
  skillDiffToolSchema,
  skillAuditToolSchema,
  skillPackAuditToolSchema,
  outdatedToolSchema,
  skillRescanToolSchema,
  auditExportToolSchema,
  auditQueryToolSchema,
  siemExportToolSchema,
  teamWorkspaceToolSchema,
  shareSkillToolSchema,
  publishPrivateToolSchema,
  teamAnalyticsDashboardToolSchema,
  teamUsageReportToolSchema,
  analyticsDashboardToolSchema,
  usageReportToolSchema,
  configureSsoToolSchema,
  ssoSettingsToolSchema,
  privateRegistryPublishToolSchema,
  privateRegistryManageToolSchema,
  rbacManageToolSchema,
  rbacAssignRoleToolSchema,
  rbacCreatePolicyToolSchema,
  webhookConfigureToolSchema,
  apiKeyManageToolSchema,
  complianceReportToolSchema,
  // SMI-5392: push installed-skill inventory to the user's Skillsmith account.
  inventoryPushToolSchema,
  // SMI-5213: skill_inventory_audit, apply_namespace_rename, and (gated)
  // apply_recommended_edit. Spread so apply_recommended_edit is omitted
  // when APPLY_TEMPLATE_REGISTRY is empty. audit:standards Check 25 resolves
  // this spread to its MAX *ToolSchema set (SMI-5216), so the README must
  // document every tool that CAN register (the max set, incl. the gated one).
  // Runtime may register fewer; that correctness is covered by the
  // ListTools-registry test, not Check 25.
  ...newAuditToolDefinitions(),
  // SMI-5407: skill_recover_source — Community read-only source provenance recovery
  ...provenanceToolDefinitions(),
]

// Create server
// SMI-4790 S1: version sourced from PACKAGE_VERSION constant (was hardcoded '0.4.6';
// drifted from package.json's actual version). prepare-release.ts updates PACKAGE_VERSION,
// so this binding stays in sync automatically.
const server = new Server(
  {
    name: 'skillsmith',
    version: PACKAGE_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: filterToolsForAgentProfile(toolDefinitions).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }
})

// Handle tool calls — request handling delegated to call-tool-handler.ts
// (SMI-5479 extraction; dispatch itself stays in tool-dispatch.ts,
// SMI-skill-version-tracking Wave 2). `deps` is read fresh on every call —
// `toolContext` is a module-level `let` assigned inside main() AFTER this
// handler registers, so capturing it once here would freeze it at
// `undefined`. See call-tool-handler.ts's module doc (LATE-BINDING TRAP).
server.setRequestHandler(CallToolRequestSchema, (request) =>
  handleCallToolRequest(request, { toolContext, licenseMiddleware, quotaMiddleware })
)

/**
 * SMI-5582: run only the SYNCHRONOUS, zero-network part of first-time setup —
 * install bundled first-party assets + docs and flip the first-run marker. Kept
 * on the blocking startup path (fast, no network) so `isFirstRun()` flips to
 * false immediately. The Tier-1 REGISTRY install (real network) runs
 * fire-and-forget via `maybeInstallMissingTier1Skills` in `main()`, never here.
 * Exported for integration testability (plan G).
 *
 * @returns Names of the bundled skills freshly installed (credited, without
 *   attribution, in the welcome message).
 */
export async function runFirstTimeSetup(): Promise<string[]> {
  // SMI-5615: plain console.error (not disk-only logger.info) — always-visible docker-logs status line.
  console.error('[skillsmith] First run detected, installing essentials...')
  const bundledSkills = installBundledSkills()
  installUserDocs()
  // Mark complete BEFORE the async registry install kicks off, so isFirstRun()
  // flips regardless of registry outcome.
  markFirstRunComplete()
  return bundledSkills
}

// SMI-5582 (plan G): re-export so integration tests can drive it directly.
export { maybeInstallMissingTier1Skills }

/**
 * SMI-2163: Startup diagnostics for common installation issues
 * Detects native module problems and provides actionable error messages
 */
function runStartupDiagnostics(): void {
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

// SMI-5009 (origin) / SMI-5039 (extraction): the embedding capability probe
// now lives in @skillsmith/core/embeddings/probe. See that file for the
// contract (hard 2 s timeout, try/catch wrapper, stderr-only, never throws).
// Call site below preserved verbatim — invoke before server.connect(transport).

// SMI-5479 (pass 2): flush-on-shutdown trigger — see shutdown.ts for the
// rationale and the bounded-flush implementation. Registering ANY listener
// for SIGTERM/SIGINT overrides Node's default terminate-on-signal behavior,
// so this explicitly exits once the bounded flush settles, preserving
// today's default (process exits promptly on those signals) instead of
// leaving the process hanging.
const shutdownAndExit = createShutdownTrigger(
  () => process.exit(0),
  () => toolContext?.db
)

// Start server
async function main() {
  // SMI-4805: --version / --help must short-circuit before diagnostics, DB
  // init, or the stdio server start — otherwise the flag is swallowed by the
  // MCP SDK's stdio mode and the server runs instead of printing + exiting.
  const startupFlagOutput = resolveStartupFlag(process.argv.slice(2), PACKAGE_VERSION)
  if (startupFlagOutput !== null) {
    console.log(startupFlagOutput)
    return
  }

  // SMI-2163: Run startup diagnostics before anything else
  runStartupDiagnostics()

  // Handle --docs flag
  if (process.argv.includes('--docs') || process.argv.includes('-d')) {
    handleDocsFlag()
    return
  }

  // SMI-2208: Initialize database asynchronously with WASM fallback
  // CRITICAL: Must complete before any tool handlers access toolContext
  try {
    toolContext = await getToolContextAsync()
    // SMI-5615: plain console.error — same rationale as runFirstTimeSetup above.
    console.error(
      `Database initialized at: ${process.env.SKILLSMITH_DB_PATH || '~/.skillsmith/skills.db'}`
    )
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : String(error)
    // SMI-5615: single '\n'-joined message reproduces the prior 8-line stderr output.
    const troubleshooting = [
      '  - In Docker: Ensure container is running',
      '  - On macOS: sql.js WASM should load automatically',
      '  - Set SKILLSMITH_FORCE_WASM=true to use the WASM SQLite fallback',
    ].join('\n')
    logger.error(
      `[skillsmith] Failed to initialize database:\n${errorDetail}\n\nTroubleshooting:\n${troubleshooting}\n`,
      { err: error }
    )
    process.exit(1)
  }

  // Run the synchronous (zero-network) part of first-time setup if needed.
  // `bundledSkills` are credited (without attribution) in the welcome message;
  // on a non-first-run self-heal there are none freshly installed here, so the
  // welcome message then lists only the registry skills.
  let bundledSkills: string[] = []
  if (isFirstRun()) {
    bundledSkills = await runFirstTimeSetup()
  } else {
    // SMI-4790: ensure the bundled `skillsmith` slash-command skill is installed
    // even on non-first-run (covers MCP-only users who never ran `skillsmith setup`,
    // and recovery if the skill was uninstalled). installBundledSkills() is
    // idempotent — it skips skills already present at the runtime path resolved
    // by `SKILLSMITH_CLIENT`. Opt out via SKILLSMITH_SKIP_SKILL_INSTALL=1.
    if (process.env.SKILLSMITH_SKIP_SKILL_INSTALL !== '1') {
      ensureSkillsmithSkillInstalled()
    }
  }

  // SMI-5582: Tier-1 registry install + self-heal. Runs on EVERY startup (not
  // just first-run) so users already past markFirstRunComplete() with the old
  // broken IDs get healed; it reconciles a persisted status file, retrying only
  // still-missing skills (≤1×/24h). FIRE-AND-FORGET (never awaited) — mirrors
  // checkForUpdates() below so a slow, now-timeout-guarded GitHub fetch cannot
  // delay server.connect(). Opt out via SKILLSMITH_TIER1_AUTOINSTALL_DISABLE=1
  // (registry path only; bundled assets above unaffected). Never throws.
  void maybeInstallMissingTier1Skills(toolContext, { bundledSkills }).catch(() => {})

  // SMI-1952: Auto-update check (non-blocking)
  if (process.env.SKILLSMITH_AUTO_UPDATE_CHECK !== 'false') {
    checkForUpdates(PACKAGE_NAME, PACKAGE_VERSION)
      .then((result) => {
        if (result?.updateAvailable) {
          console.error(formatUpdateNotification(result)) // SMI-5615: plain console.error, not disk-only logger.info
        }
      })
      .catch(() => {
        // Silent failure - don't block server startup
      })
  }

  // SMI-5541: continuous personal audit — throttled (≤1×/day), deduped, and
  // consent-gated SERVER-side. Fire-and-forget: maybeAutoNotifyAudit never
  // throws (all errors swallowed internally), so it cannot block or crash
  // startup. Opt out with SKILLSMITH_AUDIT_EMAIL_DISABLE=1.
  maybeAutoNotifyAudit().catch(() => {
    // Defensive: the helper already swallows everything; this is belt-and-braces.
  })

  // SMI-5009: probe embedding capability BEFORE serving any requests so the
  // module-load cache is warm and the first user search request doesn't race
  // with cold transformers initialisation. Probe is hard-bounded at 2s and
  // can never throw — see probeEmbeddingCapability for guarantees.
  await probeEmbeddingCapability()

  const transport = new StdioServerTransport()
  // SMI-5479: flush-on-shutdown wiring — see flushTelemetryOnShutdown above.
  // `onclose` covers the common MCP-host shutdown path (host closes stdio
  // without a signal); SIGTERM/SIGINT cover process-manager-driven shutdown.
  transport.onclose = shutdownAndExit
  process.on('SIGTERM', shutdownAndExit)
  process.on('SIGINT', shutdownAndExit)
  await server.connect(transport)
  // SMI-5615: plain console.error — startup-probe.test.ts waits on this exact stderr line.
  console.error('Skillsmith MCP server running')
}

// SMI-5615: was `main().catch(console.error)` — handled, so it exited 0 with
// no diagnostic beyond the console line. `logger.error` mirrors to
// console.error unconditionally (same stderr visibility) plus a disk record;
// `process.exit(1)` fixes the latent success-exit-code-on-failure gap.
main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  logger.error(`Fatal error during startup: ${detail}`, { err: error })
  process.exit(1)
})
