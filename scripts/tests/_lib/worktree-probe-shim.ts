/**
 * SMI-5596 — injected-fake-binary PATH shims for testing create-worktree.sh's
 * Step 8 container-view readiness probe and the shared run_with_timeout
 * helper without a real running container (this repo's "never
 * `skipIf(inDocker)`" rule — an injected fake seam instead).
 *
 * Consumed by scripts/tests/create-worktree-ready-probe.test.ts. Split out
 * of that file to keep it under the 500-line CI limit.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Resolve a real system binary via the ambient PATH and write a thin
 * passthrough wrapper into `dir`, so the curated PATH stays fully
 * deterministic (no dependency on the real host's binary layout). */
function passthrough(dir: string, name: string): void {
  const real = execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
  writeFileSync(join(dir, name), `#!/bin/sh\nexec "${real}" "$@"\n`, 'utf8')
  chmodSync(join(dir, name), 0o755)
}

function writeFake(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(join(dir, name), 0o755)
}

/** Base shim: every non-faked external binary the code under test can call.
 * `uname` / `docker` / `gtimeout` / `timeout` are added per-scenario as
 * fakes on top of this, never as passthroughs (full determinism regardless
 * of the host running these tests). */
export function buildBaseShim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ready-probe-shim-'))
  for (const bin of ['git', 'dirname', 'grep', 'sed', 'date', 'sleep', 'basename', 'sh', 'cat']) {
    passthrough(dir, bin)
  }
  return dir
}

/** Deterministic `uname` — every test picks Darwin or Linux explicitly
 * rather than relying on whatever OS actually runs the suite. */
export function fakeUname(dir: string, value: 'Darwin' | 'Linux'): void {
  writeFake(dir, 'uname', `echo '${value}'`)
}

/**
 * Fake `docker` — behavior fully controlled by env vars so ONE fake script
 * serves every scenario:
 *
 *   FAKE_DOCKER_CONTAINER_UP=1|0      default 1 — `docker ps` lists skillsmith-dev-1
 *   FAKE_DOCKER_EXEC_MODE=ok|fail|ready-after   default ok — `docker exec` outcome
 *   FAKE_DOCKER_READY_AFTER=N         used when EXEC_MODE=ready-after
 *   FAKE_DOCKER_COUNTER_FILE=path     used when EXEC_MODE=ready-after (persists call count)
 */
export function fakeDocker(dir: string): void {
  writeFake(
    dir,
    'docker',
    [
      'case "$1" in',
      '  ps)',
      '    if [ "${FAKE_DOCKER_CONTAINER_UP:-1}" = "1" ]; then echo "skillsmith-dev-1"; fi',
      '    exit 0',
      '    ;;',
      '  exec)',
      '    case "${FAKE_DOCKER_EXEC_MODE:-ok}" in',
      '      ok) exit 0 ;;',
      '      fail) exit 1 ;;',
      '      ready-after)',
      '        f="${FAKE_DOCKER_COUNTER_FILE:?}"',
      '        n=$(cat "$f" 2>/dev/null || echo 0)',
      '        n=$((n + 1))',
      '        echo "$n" > "$f"',
      '        if [ "$n" -ge "${FAKE_DOCKER_READY_AFTER:-1}" ]; then exit 0; else exit 1; fi',
      '        ;;',
      '      *) exit 0 ;;',
      '    esac',
      '    ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n')
  )
}

/**
 * Fake `gtimeout`/`timeout` that records its own invocation to a marker
 * file, then `exec`s the wrapped command directly. This is enough to prove
 * WHICH binary run_with_timeout delegates to and that the wrapped
 * command's exit code survives the wrapping — real hang/kill enforcement
 * is the post-ship manual smoke path per the plan (a fake seam that sleeps
 * past the timeout), not a CI-mocked scenario here.
 */
export function fakeTimeoutBinary(
  dir: string,
  name: 'gtimeout' | 'timeout',
  markerFile: string
): void {
  writeFake(
    dir,
    name,
    [
      '# Capability probe: `--kill-after=0 0 true` must exit 0. Exit directly',
      '# rather than exec-ing "true" — the curated shim PATH deliberately does',
      '# not carry every coreutil, and the probe only checks the exit status.',
      'if [ "$1" = "--kill-after=0" ]; then',
      '  exit 0',
      'fi',
      `echo "${name}-called" >> ${JSON.stringify(markerFile)}`,
      'shift',
      'exec "$@"',
    ].join('\n')
  )
}
