/**
 * Helper for audit-standards.mjs Check 70 (SMI-6518 -- SKILLSMITH_DOCKER
 * static-consistency check) and its executable twin,
 * scripts/tests/audit-docker-env-coherence.test.ts.
 *
 * docker-compose.yml's `dev` service reads two env-var-overridable
 * defaults, `SKILLSMITH_DOCKER_CPUS` and `SKILLSMITH_DOCKER_MEM`
 * (SMI-6064), via `${VAR:-default}` shorthand. `.env.schema` separately
 * documents what those defaults are, in prose ("Default N" / "Default
 * Xg"), for a developer deciding whether to override them. Nothing
 * checked that the two agree -- confirmed during SMI-6518:
 * `grep -n "SKILLSMITH_DOCKER\|mem_limit" scripts/audit-standards.mjs`
 * returned zero hits before this check existed. This is exactly the
 * class of drift a prior SMI-6518 review round found and hand-fixed (a
 * stale "Default 4" comment) before realizing the fix itself was a
 * symptom of a missing permanent check.
 *
 * Ships HARD (fail), not shadow/warn -- unlike most of this repo's
 * shadow-gated checks, this one compares two static files with no
 * live-environment dependency.
 *
 * A prior version of this file's extraction claimed "no plausible
 * false-positive surface" here. That claim was disproved twice over by a
 * cross-family pre-merge review (SMI-6518 finding): the regexes searched
 * the WHOLE compose file and took the first match with no anchoring to
 * the `dev` service (so a second service declaring the same vars, listed
 * earlier in the file, would be validated instead of `dev` -- real drift
 * in `dev` passes silently), matched commented-out lines (a stale decoy
 * above the live line wins), and required single quotes for `cpus` but no
 * quotes for `mem_limit` (valid YAML that quotes one and not the other
 * fails a legitimate formatting change). Fixed: extraction is now scoped
 * to the `dev` service's own line block (`extractServiceBlock`), comments
 * are stripped from that block before matching, and both keys accept an
 * optional matching quote (single, double, or none) via a backreference.
 */

import { readFileSync } from 'node:fs'

const COMPOSE_CPUS_RE = /cpus:\s*(['"]?)\$\{SKILLSMITH_DOCKER_CPUS:-([^}'"]+)\}\1/
const COMPOSE_MEM_RE = /mem_limit:\s*(['"]?)\$\{SKILLSMITH_DOCKER_MEM:-([^}'"]+)\}\1/

/**
 * Extract a named top-level service's own line block from docker-compose
 * YAML content -- e.g. `dev`'s own `cpus:`/`mem_limit:`/etc lines, not the
 * whole file. Comment-only lines are dropped from the returned block, so a
 * commented-out decoy line can never satisfy a caller's regex. Deliberately
 * an indentation-based scanner, not a full YAML parser: docker-compose.yml
 * is a small, hand-authored file this repo controls, and "child lines are
 * indented deeper than their key, until a sibling key at the same-or-less
 * indentation ends the block" is enough to anchor correctly without adding
 * a YAML dependency for one check.
 *
 * @param {string} composeContent
 * @param {string} serviceName
 * @returns {string|null} the service's own lines (comments stripped, joined with '\n'), or null if the service key isn't found
 */
function extractServiceBlock(composeContent, serviceName) {
  const lines = composeContent.split('\n')
  const serviceLineRe = new RegExp(`^(\\s+)${serviceName}:\\s*$`)

  let blockIndent = -1
  let startIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('#')) continue // a commented-out `dev:` never opens a block
    const m = line.match(serviceLineRe)
    if (m) {
      blockIndent = m[1].length
      startIndex = i + 1
      break
    }
  }
  if (startIndex === -1) return null

  const blockLines = []
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue // blank lines don't end the block
    const indent = line.length - line.trimStart().length
    if (indent <= blockIndent) break // sibling key/service -- block is over
    if (line.trim().startsWith('#')) continue // drop comment-only lines
    blockLines.push(line)
  }
  return blockLines.join('\n')
}

/**
 * Extract the `${VAR:-default}` values docker-compose.yml's `dev` service
 * declares for SKILLSMITH_DOCKER_CPUS / SKILLSMITH_DOCKER_MEM, anchored to
 * the `dev` service's own block (never a different service, never a
 * comment).
 *
 * @param {string} composeContent
 * @returns {{cpus: string|null, mem: string|null}}
 */
export function extractComposeDockerDefaults(composeContent) {
  const devBlock = extractServiceBlock(composeContent, 'dev')
  if (devBlock === null) {
    return { cpus: null, mem: null }
  }
  const cpusMatch = devBlock.match(COMPOSE_CPUS_RE)
  const memMatch = devBlock.match(COMPOSE_MEM_RE)
  return {
    cpus: cpusMatch ? cpusMatch[2] : null,
    mem: memMatch ? memMatch[2] : null,
  }
}

/**
 * Extract the "Default N" value from the contiguous `#`-comment block
 * immediately above a `VAR=` key line in a Varlock-style `.env.schema`
 * file. Returns null if the key line, or a "Default ..." token in its
 * comment block, cannot be found.
 *
 * @param {string} envSchemaContent
 * @param {string} varName
 * @returns {string|null}
 */
export function extractEnvSchemaDefault(envSchemaContent, varName) {
  const lines = envSchemaContent.split('\n')
  const keyLineRe = new RegExp(`^${varName}=`)
  const keyIndex = lines.findIndex((l) => keyLineRe.test(l))
  if (keyIndex === -1) return null

  // Walk upward collecting the contiguous comment block immediately
  // above the key line -- a blank line or a non-'#' line ends the block.
  const commentLines = []
  for (let i = keyIndex - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.trim() === '') break
    if (!line.trim().startsWith('#')) break
    commentLines.unshift(line)
  }
  const blockText = commentLines.join(' ')
  const m = blockText.match(/Default\s+([^\s,.)]+)/)
  return m ? m[1] : null
}

/**
 * Extract the "Default N" / "Default Xg" prose values .env.schema
 * documents for SKILLSMITH_DOCKER_CPUS / SKILLSMITH_DOCKER_MEM.
 *
 * @param {string} envSchemaContent
 * @returns {{cpus: string|null, mem: string|null}}
 */
export function extractEnvSchemaDockerDefaults(envSchemaContent) {
  return {
    cpus: extractEnvSchemaDefault(envSchemaContent, 'SKILLSMITH_DOCKER_CPUS'),
    mem: extractEnvSchemaDefault(envSchemaContent, 'SKILLSMITH_DOCKER_MEM'),
  }
}

/**
 * Compare docker-compose.yml's `dev` service SKILLSMITH_DOCKER_CPUS /
 * SKILLSMITH_DOCKER_MEM defaults against what .env.schema documents for
 * the same two variables.
 *
 * @param {string} composeContent
 * @param {string} envSchemaContent
 * @returns {{
 *   compose: {cpus: string|null, mem: string|null},
 *   schema: {cpus: string|null, mem: string|null},
 *   problems: string[],
 *   mismatches: string[],
 *   ok: boolean
 * }}
 */
export function checkDockerEnvDefaultCoherence(composeContent, envSchemaContent) {
  const compose = extractComposeDockerDefaults(composeContent)
  const schema = extractEnvSchemaDockerDefaults(envSchemaContent)

  const problems = []
  if (compose.cpus === null) {
    problems.push(
      "docker-compose.yml: could not find a `cpus: '${SKILLSMITH_DOCKER_CPUS:-N}'` default on the dev service"
    )
  }
  if (schema.cpus === null) {
    problems.push(
      '.env.schema: could not find a "Default N" prose value near SKILLSMITH_DOCKER_CPUS='
    )
  }
  if (compose.mem === null) {
    problems.push(
      'docker-compose.yml: could not find a `mem_limit: ${SKILLSMITH_DOCKER_MEM:-X}` default on the dev service'
    )
  }
  if (schema.mem === null) {
    problems.push(
      '.env.schema: could not find a "Default X" prose value near SKILLSMITH_DOCKER_MEM='
    )
  }

  const mismatches = []
  if (compose.cpus !== null && schema.cpus !== null && compose.cpus !== schema.cpus) {
    mismatches.push(
      `SKILLSMITH_DOCKER_CPUS: docker-compose.yml says ${compose.cpus}, .env.schema says ${schema.cpus}`
    )
  }
  if (compose.mem !== null && schema.mem !== null && compose.mem !== schema.mem) {
    mismatches.push(
      `SKILLSMITH_DOCKER_MEM: docker-compose.yml says ${compose.mem}, .env.schema says ${schema.mem}`
    )
  }

  return {
    compose,
    schema,
    problems,
    mismatches,
    ok: problems.length === 0 && mismatches.length === 0,
  }
}

const DOCKER_ENV_FIX_CI =
  'A CI runner checks out the full tree, so this is a real breakage. Confirm the checkout ' +
  'step ran and that audit:standards is invoked from the repository root.'

const DOCKER_ENV_FIX_LOCAL =
  'Both paths are resolved relative to the current working directory — run ' +
  '`npm run audit:standards` from the repository root.'

/**
 * Read both inputs and evaluate them, returning a verdict instead of throwing
 * (SMI-6575, round 2).
 *
 * Check 70's call site previously read `docker-compose.yml` and `.env.schema`
 * with bare `readFileSync` calls. Check 70 is the LAST check and the Summary
 * block sits immediately below it, so an ENOENT there destroyed the summary and
 * the exit verdict exactly as Check 69's throw did -- measured by moving
 * `.env.schema` aside: exit 1, no summary block at all.
 *
 * The first fix for that wrapped the reads inline in audit-standards.mjs, which
 * a cross-family pre-merge gate correctly BLOCKED: it left the new failure path
 * with no automated coverage, which is the same defect that had blocked the
 * Check 69 fix one round earlier. `.mjs` is outside both typecheck and eslint
 * here, so nothing mechanical guards an inline branch. Extracting the read plus
 * the branching makes every outcome directly testable and leaves the audit
 * script a flat dispatch.
 *
 * `readFile` is injected so a test can drive the failure path without touching
 * the real filesystem.
 *
 * @param {{isCI?: boolean, readFile?: (path: string) => string}} [options]
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function dockerEnvCoherenceReportLines(options = {}) {
  const readFile = options.readFile ?? ((p) => readFileSync(p, 'utf8'))

  let coherence
  try {
    coherence = checkDockerEnvDefaultCoherence(
      readFile('docker-compose.yml'),
      readFile('.env.schema')
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // NOT EVALUATED is a third outcome, never a pass -- a check that self-skips
    // to pass is the SMI-6118 / SMI-6332 failure mode elsewhere in this audit.
    return [
      {
        severity: options.isCI ? 'fail' : 'warn',
        message:
          'Check 70: NOT EVALUATED — could not read docker-compose.yml and/or ' +
          `.env.schema, so nothing was compared: ${reason}`,
        fix: options.isCI ? DOCKER_ENV_FIX_CI : DOCKER_ENV_FIX_LOCAL,
      },
    ]
  }

  if (coherence.problems.length > 0) {
    return [
      {
        severity: 'fail',
        message: `Check 70: ${coherence.problems.join('; ')}`,
        fix:
          "Both files must declare a parseable default -- see docker-compose.yml's dev service " +
          "(`cpus:`/`mem_limit:`) and .env.schema's SKILLSMITH_DOCKER_CPUS/SKILLSMITH_DOCKER_MEM " +
          'entries ("Default N" prose).',
      },
    ]
  }

  if (coherence.mismatches.length > 0) {
    return [
      {
        severity: 'fail',
        message:
          'Check 70: docker-compose.yml and .env.schema disagree on SKILLSMITH_DOCKER ' +
          `default(s) — ${coherence.mismatches.join('; ')}`,
        fix: 'Update whichever file is stale so both defaults match exactly.',
      },
    ]
  }

  return [
    {
      severity: 'pass',
      message:
        'Check 70: docker-compose.yml and .env.schema agree on SKILLSMITH_DOCKER_CPUS ' +
        `(${coherence.compose.cpus}) and SKILLSMITH_DOCKER_MEM (${coherence.compose.mem}) defaults`,
    },
  ]
}
