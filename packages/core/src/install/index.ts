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
