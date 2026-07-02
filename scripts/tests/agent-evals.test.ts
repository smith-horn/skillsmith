/**
 * SMI-5456 Wave 1 Step 6 — pure-JS sanity checks for `scripts/agent-evals/`
 * (the L2b headless eval runners).
 *
 * These are checked-in-unexecuted shell scripts (see the SCOPE note in
 * `scripts/agent-evals/README.md`) — this suite never invokes a harness
 * binary. It only verifies: (1) every runner + the shared lib parses as
 * valid POSIX `sh` (`sh -n`, a shellcheck-style sanity gate that doesn't
 * require the `shellcheck` binary to be installed), and (2) the README /
 * results template documentation stays in sync with the seven-harness
 * matrix the implementation plan defines.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_EVALS_DIR = resolve(__dirname, '..', 'agent-evals')

/** Every harness the plan's Validation Ladder tracks (5 HarnessId + windsurf + hermes). */
const ALL_SEVEN_HARNESSES = [
  'claude',
  'cursor',
  'codex',
  'copilot',
  'opencode',
  'hermes',
  'windsurf',
] as const

/**
 * The runners this worker actually generated (per the SCOPE brief): Windsurf
 * is structurally excluded from L2b (no headless mode, IDE-only) and Hermes
 * is pending confirmation of its one-shot headless invocation shape — both
 * documented in the README rather than shipped as a runner.
 */
const RUNNER_SCRIPTS = ['claude.sh', 'cursor.sh', 'codex.sh', 'copilot.sh', 'opencode.sh']

function readAgentEvalsFile(name: string): string {
  return readFileSync(join(AGENT_EVALS_DIR, name), 'utf-8')
}

describe('scripts/agent-evals — shell sanity (sh -n)', () => {
  it.each([...RUNNER_SCRIPTS, 'lib.sh'])('%s parses as valid POSIX sh', (name) => {
    // execFileSync with an array argv — never a shell-interpolated string.
    expect(() =>
      execFileSync('sh', ['-n', join(AGENT_EVALS_DIR, name)], { stdio: 'pipe' })
    ).not.toThrow()
  })

  it('every runner has a #!/bin/sh shebang (POSIX sh, not bash)', () => {
    for (const name of RUNNER_SCRIPTS) {
      const content = readAgentEvalsFile(name)
      expect(content.startsWith('#!/bin/sh\n')).toBe(true)
    }
  })

  it('every runner sources lib.sh and calls check_binary before doing anything else', () => {
    for (const name of RUNNER_SCRIPTS) {
      const content = readAgentEvalsFile(name)
      expect(content).toContain('. "$SCRIPT_DIR/lib.sh"')
      expect(content).toMatch(/check_binary \w+/)
    }
  })

  it('every runner drives exactly the three MVP jobs (keep-current, audit-fix, vet-before-install)', () => {
    for (const name of RUNNER_SCRIPTS) {
      const content = readAgentEvalsFile(name)
      expect(content).toContain('run_job "$LOG" "keep-current"')
      expect(content).toContain('run_job "$LOG" "audit-fix"')
      expect(content).toContain('run_job "$LOG" "vet-before-install"')
    }
  })
})

describe('scripts/agent-evals/results — directory shape', () => {
  it('results/ exists and contains TEMPLATE.md', () => {
    const entries = readdirSync(join(AGENT_EVALS_DIR, 'results'))
    expect(entries).toContain('TEMPLATE.md')
  })

  it('TEMPLATE.md has a row for all seven harnesses plus the required columns', () => {
    const template = readAgentEvalsFile(join('results', 'TEMPLATE.md'))
    const requiredHarnessLabels = [
      'Claude Code',
      'Cursor',
      'Codex',
      'Copilot / VS Code',
      'OpenCode',
      'Hermes',
      'Windsurf / Devin',
    ]
    for (const label of requiredHarnessLabels) {
      expect(template).toContain(label)
    }
    // The three MVP-job columns + the marker-channel row from the plan's
    // Validation Ladder Level 3 definition.
    expect(template).toContain('keep-current')
    expect(template).toContain('audit-fix')
    expect(template).toContain('vet-before-install')
    expect(template).toMatch(/Marker channel verified/)
  })
})

describe('scripts/agent-evals/README.md — eval matrix documentation', () => {
  it('mentions all seven harnesses', () => {
    const readme = readAgentEvalsFile('README.md')
    for (const harness of ALL_SEVEN_HARNESSES) {
      expect(readme.toLowerCase()).toContain(harness)
    }
  })

  it('documents Windsurf as structurally excluded from L2b (no headless mode)', () => {
    const readme = readAgentEvalsFile('README.md')
    expect(readme).toMatch(/Windsurf[\s\S]{0,400}(no headless|excluded)/i)
  })

  it('documents Hermes L2b as pending (no runner shipped yet)', () => {
    const readme = readAgentEvalsFile('README.md')
    expect(readme).toMatch(/Hermes[\s\S]{0,400}[Pp]ending/)
  })

  it('references every shipped runner script by name', () => {
    const readme = readAgentEvalsFile('README.md')
    for (const script of RUNNER_SCRIPTS) {
      expect(readme).toContain(script)
    }
  })
})
