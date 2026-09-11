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
 * live-environment dependency and no plausible false-positive surface.
 * There is no legitimate reason for these two files to ever disagree.
 */

const COMPOSE_CPUS_RE = /cpus:\s*'\$\{SKILLSMITH_DOCKER_CPUS:-([^}]+)\}'/
const COMPOSE_MEM_RE = /mem_limit:\s*\$\{SKILLSMITH_DOCKER_MEM:-([^}]+)\}/

/**
 * Extract the `${VAR:-default}` values docker-compose.yml's `dev` service
 * declares for SKILLSMITH_DOCKER_CPUS / SKILLSMITH_DOCKER_MEM.
 *
 * @param {string} composeContent
 * @returns {{cpus: string|null, mem: string|null}}
 */
export function extractComposeDockerDefaults(composeContent) {
  const cpusMatch = composeContent.match(COMPOSE_CPUS_RE)
  const memMatch = composeContent.match(COMPOSE_MEM_RE)
  return {
    cpus: cpusMatch ? cpusMatch[1] : null,
    mem: memMatch ? memMatch[1] : null,
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
