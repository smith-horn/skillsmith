/**
 * WebdriverIO config for the Skillsmith VS Code extension E2E suite (SMI-5331).
 *
 * Launches a REAL VS Code (Extension Development Host) via `wdio-vscode-service`
 * with the locally-built `dist/extension.js` loaded, and a dependency-free fake
 * stdio MCP server wired in via the extension's own settings hook
 * (`skillsmith.mcp.serverCommand` / `serverArgs`, read in
 * `src/extension.ts` `initializeMcpClientFromSettings()`).
 *
 * Host-only (ADR-113): no Docker. Headless in CI via `xvfb-run`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Repo path to the extension package (where `dist/extension.js` is built). */
const EXTENSION_PATH = path.resolve(here, '..')
/** A throwaway workspace so VS Code opens a folder (not the welcome tab). */
const WORKSPACE_PATH = path.resolve(here, 'fixtures', 'workspace')
/** The fake stdio MCP server the extension spawns instead of `npx @skillsmith/mcp-server`. */
const FAKE_MCP_SERVER = path.resolve(here, 'fixtures', 'fake-mcp-server.mjs')

// SAFE_SPAWN_CHARS guard (src/utils/security.ts:61). The extension rejects spawn
// args containing characters outside this allowlist (e.g. a CI checkout path with
// a '+' from a PR ref). Fail fast here with an actionable message rather than the
// opaque "Unsafe server command/argument" throw inside the extension at connect time.
const SAFE_SPAWN_CHARS = /^[a-zA-Z0-9._/@: -]+$/
if (!SAFE_SPAWN_CHARS.test(FAKE_MCP_SERVER)) {
  throw new Error(
    `[wdio.conf] Resolved fake MCP server path is not SAFE_SPAWN_CHARS-clean and would be ` +
      `rejected by the extension: ${FAKE_MCP_SERVER}`
  )
}

// Concrete VS Code version, deliberately pinned (NOT 'stable') so the CI binary
// cache key is stable and version bumps are intentional. Must be >= engines.vscode
// (^1.110.0) or VS Code refuses to load the extension. NOTE: wdio-vscode-service@8's
// tested default is 1.109.0 and the exact string '1.110.0' mis-resolves down to it;
// a concrete recent release (1.125.1, validated) resolves correctly. Override via
// VSCODE_E2E_VERSION if a pinned patch is ever unavailable.
const VSCODE_VERSION = process.env['VSCODE_E2E_VERSION'] || '1.125.1'

export const config: WebdriverIO.Config = {
  runner: 'local',
  // wdio compiles the TS specs/config with this tsconfig.
  tsConfigPath: path.resolve(here, '..', 'tsconfig.e2e.json'),

  specs: [path.resolve(here, 'specs', '**', '*.e2e.ts')],
  maxInstances: 1,

  capabilities: [
    {
      browserName: 'vscode',
      browserVersion: VSCODE_VERSION,
      'wdio:vscodeOptions': {
        extensionPath: EXTENSION_PATH,
        workspacePath: WORKSPACE_PATH,
        userSettings: {
          'skillsmith.mcp.serverCommand': 'node',
          'skillsmith.mcp.serverArgs': [FAKE_MCP_SERVER],
          'skillsmith.mcp.autoConnect': true,
          // Keep the e2e run quiet / deterministic.
          'skillsmith.telemetry.enabled': false,
          'skillsmith.demoMode': false,
        },
      },
    },
  ],

  services: ['vscode'],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',

  // Retries hide the iframe-timing races this suite exists to catch; cap at 1
  // (CI only) and surface a ::warning:: from the afterTest hook on any retry.
  mochaOpts: {
    ui: 'bdd',
    timeout: 60_000,
    retries: process.env['CI'] ? 1 : 0,
  },

  afterTest: function (test, _context, result) {
    if (process.env['CI'] && (result as { retries?: { attempts?: number } })?.retries?.attempts) {
      const attempts = (result as { retries: { attempts: number } }).retries.attempts
      if (attempts > 0) {
        // eslint-disable-next-line no-console
        console.log(`::warning::e2e spec retried (${attempts}x): ${test.parent} > ${test.title}`)
      }
    }
  },
}
