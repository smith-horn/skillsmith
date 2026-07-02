/**
 * SMI-4578: Public surface for `@skillsmith/core/install`.
 *
 * Subpath export — consumers import as:
 *
 * ```ts
 * import { getCanonicalInstallPath, type ClientId } from '@skillsmith/core/install'
 * ```
 *
 * @module @skillsmith/core/install
 */
export {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  assertClientId,
  enumerateHarnessPresence,
  getCanonicalInstallPath,
  getInstallPath,
  resolveClientId,
  resolveClientPath,
} from './paths.js'
export type { ClientId } from './paths.js'

export {
  addLink,
  getDefaultFromClient,
  getLinkManifestPath,
  listLinks,
  loadManifest,
  removeLinks,
  saveManifest,
} from './fan-out.js'
export type {
  AddLinkOptions,
  AddLinkResult,
  LinkKind,
  LinkManifest,
  LinkRecord,
} from './fan-out.js'

// SMI-5456 Wave 1 Step 5: `sklx agent install` / `uninstall` core.
export { installAgentPack, loadAgentManifest } from './agent-pack-installer.js'
export { uninstallAgentPack } from './agent-pack-uninstaller.js'
export {
  getAgentInstallBackupsDir,
  getAgentManifestPath,
  saveAgentManifest,
  AGENT_INSTALL_DIR_ENV_VAR,
  AGENT_MANIFEST_SCHEMA_VERSION,
  type AgentInstallManifest,
  type AgentManifestEntry,
  type AgentManifestEntryKind,
} from './agent-manifest.js'
export {
  HARNESS_SUPPORT_TIER,
  type AgentInstallOptions,
  type AgentInstallResult,
  type AgentUninstallOptions,
  type AgentUninstallResult,
  type HarnessInstallReport,
  type SupportTier,
} from './agent-pack-installer.types.js'
export {
  AGENT_MCP_TARGETS,
  AGENT_SHIM_TARGETS,
  AGENT_HOOK_TARGETS,
  CODEX_CONFIG_TOML_PATH,
  type McpHarnessId,
  type ConfigFormat,
  type McpConfigTarget,
  type ShimTarget,
  type HookInstallTarget,
} from './agent-harness-targets.js'
export { type MergeResult, type MergeStatus } from './agent-config-merge.types.js'
