/**
 * Additional shims for prune-orphaned-docker-volumes.test.ts (SMI-6981 round 3).
 * Split from the sibling helpers file to keep it under the 500-line gate.
 */

import { writeFileSync, chmodSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join } from 'path'

import type { FixtureRepo } from './prune-orphaned-docker-volumes.helpers.js'

/**
 * Shadow `git` so `git worktree list` misbehaves in ONE of two ways, counting
 * every invocation in the same count file `worktreeListCallCount` reads (the
 * presence proof that the shim was reached):
 *
 *   'partial'  -- print the MAIN checkout's porcelain record, then exit 128.
 *                 This is the shape that satisfies a positive control built
 *                 from the first record while omitting every later worktree.
 *   'empty-ok' -- print nothing and exit 0. Reaches the "no worktree entry"
 *                 arm instead of the status check, which is the only way to
 *                 keep exercising the control-name derivation now that a
 *                 nonzero exit is refused first.
 *
 * Every other git subcommand delegates to the real git.
 */
export function shimGitWorktreeList(
  fixture: FixtureRepo,
  mode: 'partial' | 'empty-ok',
  withWorktreeDirs: string[] = []
): void {
  for (const name of withWorktreeDirs) {
    mkdirSync(join(fixture.repoDir, '.worktrees', name), { recursive: true })
  }
  const body =
    mode === 'partial'
      ? [
          `  printf 'worktree %s\\nHEAD 0000000000000000000000000000000000000000\\nbranch refs/heads/main\\n\\n' "${fixture.repoDir}"`,
          '  echo "fatal: simulated mid-output failure" >&2',
          '  exit 128',
        ]
      : ['  exit 0']
  const shim = [
    '#!/usr/bin/env bash',
    'COUNT_FILE="$(dirname "$0")/../git-worktree-list.count"',
    'prev=""',
    'is_list=0',
    'for a in "$@"; do',
    '  if [ "$prev" = "worktree" ] && [ "$a" = "list" ]; then is_list=1; fi',
    '  prev="$a"',
    'done',
    'if [ "$is_list" = 1 ]; then',
    '  echo x >> "$COUNT_FILE"',
    ...body,
    'fi',
    'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
    'exec env PATH="$CLEAN_PATH" git "$@"',
  ].join('\n')
  const p = join(fixture.binDir, 'git')
  writeFileSync(p, `${shim}\n`)
  chmodSync(p, 0o755)
}

/**
 * Serve a DIFFERENT image label value per successive read (image counterpart of
 * `volumeLabelSequence`). Once the sequence runs dry the label reads empty.
 */
export function imageLabelSequence(
  fixture: FixtureRepo,
  img: string,
  label: 'service' | 'owned',
  values: string[]
): void {
  writeFileSync(
    join(fixture.responsesDir, `image_inspect__${img}__${label}.seq`),
    `${values.join('\n')}\n`
  )
}

/** Serve `ps_ancestor__<img>` / `ps_volume__<vol>` output per successive read. */
export function psResponseSequence(fixture: FixtureRepo, key: string, values: string[]): void {
  writeFileSync(join(fixture.responsesDir, `${key}.seq`), `${values.join('\n')}\n`)
}

/**
 * Make `docker ps -aq --filter <volume=|ancestor=>` EXIT NONZERO. `key` is the
 * response key (`ps_volume__<vol>` / `ps_ancestor__<img>`). Pass a single code
 * to fail every read, or an array to give one exit code per successive read
 * (0 = succeed and emit the normal response for that read).
 */
export function setPsExit(fixture: FixtureRepo, key: string, codes: number | number[]): void {
  if (Array.isArray(codes)) {
    writeFileSync(join(fixture.responsesDir, `exit__${key}.seq`), `${codes.join('\n')}\n`)
  } else {
    writeFileSync(join(fixture.responsesDir, `exit__${key}`), String(codes))
  }
}

/**
 * Shadow `git` so `git rev-parse --show-toplevel` answers `toplevel` (or, with
 * `null`, exits 128). Every other subcommand -- notably `worktree list` --
 * delegates to the real git, so the control name the script derives
 * independently can be made to DISAGREE with a healthy, correct listing.
 */
export function shimGitToplevel(fixture: FixtureRepo, toplevel: string | null): void {
  const answer =
    toplevel === null
      ? ['  echo "fatal: simulated rev-parse failure" >&2', '  exit 128']
      : [`  printf '%s\\n' "${toplevel}"`, '  exit 0']
  const shim = [
    '#!/usr/bin/env bash',
    'prev=""',
    'is_top=0',
    'for a in "$@"; do',
    '  if [ "$prev" = "rev-parse" ] && [ "$a" = "--show-toplevel" ]; then is_top=1; fi',
    '  prev="$a"',
    'done',
    'if [ "$is_top" = 1 ]; then',
    ...answer,
    'fi',
    'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
    'exec env PATH="$CLEAN_PATH" git "$@"',
  ].join('\n')
  const p = join(fixture.binDir, 'git')
  writeFileSync(p, `${shim}\n`)
  chmodSync(p, 0o755)
}

/**
 * Make specific `docker` invocations FAIL with a chosen stderr, on top of the
 * responsive shim (SMI-6981 round 4). The responsive shim cannot: its inspect
 * always exits 0 and its `rm`/`rmi` emit no stderr, so "the query failed" and
 * "the object is gone" were indistinguishable.
 *
 * `glob` is a shell glob matched against `"$*"` (e.g. `volume inspect v *owned*`).
 * `passFirst` lets that many MATCHING calls through to the real shim before the
 * rule starts failing, so a test can fail only a later read of the same label.
 * An intercepted call is logged here; a passed-through one is logged by the
 * wrapped shim, so each call appears in the log exactly once.
 */
export function shimDockerFailures(
  fixture: FixtureRepo,
  rules: Array<{ glob: string; stderr: string; code?: number; passFirst?: number }>
): void {
  const real = join(fixture.binDir, 'docker.real')
  if (!existsSync(real)) renameSync(join(fixture.binDir, 'docker'), real)
  const body = rules.flatMap((r, i) => [
    `case "$*" in`,
    // Spaces must be escaped or the `case` pattern splits into several words.
    `  ${r.glob.replace(/ /g, '\\ ')})`,
    `    n=$(cat "${fixture.binDir}/rule${i}.count" 2>/dev/null || echo 0); n=$((n+1))`,
    `    echo "$n" > "${fixture.binDir}/rule${i}.count"`,
    `    if [ "$n" -gt ${r.passFirst ?? 0} ]; then`,
    `      echo "$@" >> "${fixture.logPath}"`,
    `      echo '${r.stderr}' >&2`,
    `      exit ${r.code ?? 1}`,
    '    fi',
    '    ;;',
    'esac',
  ])
  const shim = ['#!/bin/sh', ...body, `exec "${real}" "$@"`].join('\n')
  const p = join(fixture.binDir, 'docker')
  writeFileSync(p, `${shim}\n`)
  chmodSync(p, 0o755)
}
