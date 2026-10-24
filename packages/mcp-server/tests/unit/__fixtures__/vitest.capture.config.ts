/**
 * SMI-7168: vitest config for REGENERATING `input-parity.zod3.json` (see capture-input-parity.capture.ts).
 *
 * It is deliberately separate from the package's own config: it includes only the capture file (which
 * is not named `*.test.ts`, so no normal run ever executes it), and it aliases `zod` to an explicitly
 * supplied zod 3 copy. After the SMI-7168 migration the repo itself is on zod 4, so the baseline can
 * only be re-captured against a zod 3.25.76 you extract yourself:
 *
 *   npm pack zod@3.25.76 --pack-destination <empty dir> && tar -xzf <empty dir>/zod-3.25.76.tgz -C <empty dir>
 *   ZOD3_DIR=<empty dir>/package npx vitest run -c packages/mcp-server/tests/unit/__fixtures__/vitest.capture.config.ts
 *
 * Run it where the tests normally run (the dev container), with ZOD3_DIR reachable from there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export const PINNED_ZOD3_VERSION = '3.25.76'

const zod3Dir = process.env.ZOD3_DIR
if (!zod3Dir) {
  throw new Error(
    `capture: set ZOD3_DIR to an extracted \`npm pack zod@${PINNED_ZOD3_VERSION}\` (the directory holding its package.json)`
  )
}
const version = (
  JSON.parse(readFileSync(join(zod3Dir, 'package.json'), 'utf8')) as { version: string }
).version
if (version !== PINNED_ZOD3_VERSION) {
  throw new Error(
    `capture: ZOD3_DIR holds zod ${version}, expected exactly ${PINNED_ZOD3_VERSION}; refusing to write a baseline`
  )
}

export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  resolve: { alias: [{ find: /^zod$/, replacement: join(zod3Dir, 'index.js') }] },
  test: {
    include: ['tests/unit/__fixtures__/capture-input-parity.capture.ts'],
  },
})
