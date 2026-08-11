/**
 * SMI-4241 / SMI-5964 -- lightweight GitHub Actions workflow YAML walker.
 *
 * Extracted from `scripts/tests/indexer-workflow-report-failure.test.ts`
 * (SMI-5964 Case 13) so `indexer-backfill-alert-gap.test.ts` can reuse the
 * same `extractStep` logic instead of copy-pasting it. No YAML parser
 * dependency is added -- the repo has none, and every existing workflow test
 * is string/regex based; this only needs three-ish known steps per file.
 */

/** A single workflow step's `env:` map and `run:` script body. */
export interface WorkflowStep {
  name: string
  envBlock: Record<string, string>
  runScript: string
}

/**
 * Extract a step's `env:` map and `run:` script body. Lightweight YAML
 * walker -- we don't pull in a YAML parser because we only need a handful of
 * known steps per workflow file.
 *
 * @param yaml - The full workflow file contents.
 * @param stepName - The step's `name:` value (matched via `- name: <name>`).
 */
export function extractStep(yaml: string, stepName: string): WorkflowStep {
  const startMarker = `- name: ${stepName}`
  const startIdx = yaml.indexOf(startMarker)
  if (startIdx === -1) {
    throw new Error(`Step "${stepName}" not found in workflow`)
  }
  // Find next "- name: " or end of file.
  const after = yaml.slice(startIdx + startMarker.length)
  const nextStepIdx = after.search(/\n {6}- name: /)
  const block = nextStepIdx === -1 ? after : after.slice(0, nextStepIdx)

  // Parse env: block (lines before `run: |`).
  const envBlock: Record<string, string> = {}
  const envMatch = block.match(/\n {8}env:\n((?: {10}[^\n]+\n)+)/)
  if (envMatch) {
    for (const line of envMatch[1].split('\n')) {
      const m = line.match(/^ {10}(\w+): (.+?)$/)
      if (m) envBlock[m[1]] = m[2].trim()
    }
  }

  // Extract run: | body (lines indented 10 spaces under run:). Each line is
  // EITHER 10-space-indented content OR wholly blank (SMI-5964: the original
  // extraction required every line to carry the 10-space prefix, so a
  // genuinely blank line inside a `run: |` block silently truncated the
  // capture -- `indexer.yml`'s existing steps route around this by using
  // `echo ""` instead of blank YAML lines; newer steps should not have to).
  const runMatch = block.match(/\n {8}run: \|\n((?:(?: {10}[^\n]*)?\n)+)/)
  if (!runMatch) {
    throw new Error(`Step "${stepName}" has no \`run: |\` block`)
  }
  const runScript = runMatch[1]
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n')
  return { name: stepName, envBlock, runScript }
}
