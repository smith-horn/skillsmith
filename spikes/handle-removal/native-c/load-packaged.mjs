// SMI-6676 checkpoint 3: the loader an INSTALLED package would actually use
// -- prebuildify-shaped (P-A), never a source build.
//
// This is deliberately separate from load.mjs (this package's own dev-build
// loader, used by every attack harness in checkpoints 1-2): load.mjs reads
// `build/Release/shim.node`, the raw node-gyp output that exists only in
// this checked-out spike tree. load-packaged.mjs reads
// `prebuilds/<platform>-<arch>/shim.node`, the shape a published tarball
// would actually carry, and never touches `build/` at all.
//
// The owner has decided the fallback for a removal is quarantine (C4), not
// a source build (plan §4.5, §10). This loader is the actual mechanism that
// decision depends on: `loadNative()` is one bare `require()` in a
// try/catch. It never shells out to node-gyp, never inspects whether a
// toolchain is present, and this package's own package.json (see the
// checkpoint-3 report) has no `install`/`postinstall` script -- so `npm
// install` of a tarball built from this package cannot trigger a compile
// under any circumstance, on any platform, matching or not. If a prebuild
// doesn't match, `require()` throws (module not found), loadNative()
// returns { ok: false }, and that is the *entire* native attempt: the
// caller's only remaining option is the C4 quarantine path.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

export function prebuildPath(platform = process.platform, arch = process.arch) {
  return path.join(here, 'prebuilds', `${platform}-${arch}`, 'shim.node')
}

/**
 * @returns {{ok:true, shim:object, path:string}|{ok:false, path:string, error:{name:string, message:string, code:string|undefined}}}
 */
export function loadNative() {
  const p = prebuildPath()
  try {
    const shim = require(p)
    return { ok: true, shim, path: p }
  } catch (err) {
    return { ok: false, path: p, error: { name: err.name, message: err.message, code: err.code } }
  }
}
