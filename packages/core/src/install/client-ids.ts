/**
 * The client ids, in a module with no filesystem import, so doctor's
 * classifier (which may touch the filesystem only through its reader, SMI-6531
 * 6b-ii) can validate an op dir's attribution against them. `paths.ts`
 * re-exports this list and stays its public home.
 *
 * @module @skillsmith/core/install/client-ids
 */
import type { ClientId } from './paths.js'

export const CLIENT_IDS: ReadonlyArray<ClientId> = Object.freeze([
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'agents',
  'opencode',
  'hermes',
  'grok',
  'antigravity',
])
