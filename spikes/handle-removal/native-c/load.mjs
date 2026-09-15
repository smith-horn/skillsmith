// Loads the platform's compiled C1 shim. ESM can't `require()` directly, so
// this wraps createRequire -- the one indirection every VR module needs.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

let cached = null

export function loadShim() {
  if (!cached) {
    cached = require(path.join(here, 'build', 'Release', 'shim.node'))
  }
  return cached
}
