/**
 * SMI-5702: PATH-prepended `git-crypt` binary shims, split out of
 * rebase-worktree.helpers.ts to keep that file under the 500-line limit.
 * Used by tests exercising `ensure_git_crypt_filter_registered()`'s REAL
 * repair behavior (as opposed to `runScript()`'s default of disabling the
 * heal entirely — see its doc comment in rebase-worktree.helpers.ts).
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A PATH with a do-nothing `git-crypt` shim prepended. The healer only ever
 * gates on `command -v git-crypt` before writing config; it never actually
 * invokes the binary, so a shim is sufficient and keeps these tests
 * hermetic regardless of whether the real binary is installed (it is NOT
 * inside this repo's own Docker dev container by design — git-crypt is
 * host-side tooling, see CLAUDE.md's Git-Crypt section).
 */
export const GIT_CRYPT_SHIM_PATH: string = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-crypt-shim-'))
  writeFileSync(join(dir, 'git-crypt'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'git-crypt'), 0o755)
  return `${dir}:${process.env.PATH ?? ''}`
})()

/**
 * A PATH with a FUNCTIONAL `git-crypt` shim that implements the
 * `smudge`/`clean` subcommands via the same `\0GITCRYPT` magic-header
 * wrap/unwrap convention setupGitCryptFixture() uses for its raw-shell fake
 * filter pair — but invoked through the real `git-crypt smudge`/`git-crypt
 * clean` command names, so a test can register the CANONICAL filter
 * spelling from the start (what ensure_git_crypt_filter_registered() always
 * heals TO) and get a genuine content round-trip, not just "isn't the raw
 * ciphertext prefix". Use for a test that needs the checked-out file
 * content to be provably correct after a heal, as opposed to
 * GIT_CRYPT_SHIM_PATH's presence-only no-op (sufficient when a test only
 * needs the `command -v git-crypt` write-gate satisfied, e.g. because the
 * scenario deliberately disables filters via "cat"/"cat" and never invokes
 * git-crypt content-wise at all).
 */
export const GIT_CRYPT_ROUNDTRIP_SHIM_PATH: string = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-crypt-roundtrip-shim-'))
  writeFileSync(
    join(dir, 'git-crypt'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  smudge) exec tail -c +10 ;;',
      "  clean) printf '\\0GITCRYPT'; exec cat ;;",
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n')
  )
  chmodSync(join(dir, 'git-crypt'), 0o755)
  return `${dir}:${process.env.PATH ?? ''}`
})()
