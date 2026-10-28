/**
 * The install scopes, in a module with no filesystem import, so doctor's
 * classifier (which may touch the filesystem only through its reader, SMI-6531
 * 6b-ii) can validate an op dir's attribution against them. `InstallScope`
 * (`workspace-scope.ts`) stays the type's home; the table below makes adding
 * a member there a compile error here until it is listed.
 *
 * @module @skillsmith/core/install/scope-ids
 */
import type { InstallScope } from './workspace-scope.js'

const SCOPE_TABLE = { global: true, workspace: true } satisfies Record<InstallScope, true>

export const INSTALL_SCOPES: ReadonlyArray<InstallScope> = Object.freeze(
  Object.keys(SCOPE_TABLE) as InstallScope[]
)
