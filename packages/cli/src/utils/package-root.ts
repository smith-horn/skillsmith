import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Returns the CLI package root directory.
 *
 * In the esbuild bundle (dist/cli.js), all source is inlined into a single
 * file, so import.meta.url resolves to dist/cli.js. dirname(...) is <pkg>/dist
 * and join('..') is the package root.
 *
 * In the tsc / vitest-source paths, this function returns a path that may not
 * be the package root, but callers have their own fallback behaviour:
 *   - version.ts and node-version.ts have try/catch that fall back to '0.0.0'
 *     and '22.22.0' respectively.
 *   - install-skill.ts and telemetry.action.ts tests mock the filesystem.
 *
 * Note: @skillsmith/core and @skillsmith/mcp-server are frozen-inlined into
 * the published bundle. A patch to core or mcp-server requires a CLI republish.
 */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}
