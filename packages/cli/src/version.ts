// SMI-4454: CLI version helper — single source of truth for consumers that need
// to report CLI identity to the backend (e.g., auth-device-code client_meta).
//
// Reads from packages/cli/package.json at runtime. This mirrors the existing
// pattern in index.ts / utils/node-version.ts; we don't `import pkg from
// '../package.json'` because resolveJsonModule would bundle package.json into
// dist, which fights with npm publish's file layout.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from './utils/package-root.js'

function readVersion(): string {
  try {
    const pkgPath = join(packageRoot(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION: string = readVersion()
