/**
 * Build-time generator for the portable Skillsmith Agent pack (SMI-5456 Wave 1
 * Step 4). Emits every artifact into `packages/mcp-server/src/assets/agent-pack/`
 * so the pack versions with the `@skillsmith/mcp-server` release (it is inside
 * the package's published `files` glob) and the installer (Step 5) reads it from
 * a stable, versioned location.
 *
 * The wiring lives here — not in `@skillsmith/core` — because this is the one
 * place that legitimately couples the pure generator (`@skillsmith/core`) with
 * the curated tool profile (this package's single source of truth,
 * `AGENT_TOOL_PROFILE_NAMES`). Output is deterministic: re-running produces
 * byte-identical files, so a source change surfaces as a diff and the drift
 * test (agent-pack.assets.test.ts) fails until this is re-run.
 *
 * Usage (in the dev container):
 *   docker exec skillsmith-dev-1 sh -c 'cd /app && npm run generate:agent-pack -w @skillsmith/mcp-server'
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAgentPack } from '@skillsmith/core'

import { AGENT_TOOL_PROFILE_NAMES } from '../src/middleware/toolProfile.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outDir = join(scriptDir, '..', 'src', 'assets', 'agent-pack')

/** Directory-tree owner of the generated pack (regenerated from scratch each run). */
function resetOutDir(): void {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
}

function main(): void {
  resetOutDir()
  const artifacts = generateAgentPack({ toolProfile: AGENT_TOOL_PROFILE_NAMES })
  for (const artifact of artifacts) {
    const dest = join(outDir, artifact.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, artifact.content, 'utf8')
    if (artifact.executable) chmodSync(dest, 0o755)
  }
  // eslint-disable-next-line no-console -- build-time script user feedback
  console.log(`Wrote ${artifacts.length} agent-pack artifact(s) to ${outDir}`)
}

main()
