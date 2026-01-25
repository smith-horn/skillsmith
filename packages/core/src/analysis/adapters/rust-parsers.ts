/**
 * SMI-1306: Rust Build File Parsers
 *
 * Parses Cargo.toml files to extract dependency information.
 * Extracted from rust.ts for better modularity.
 *
 * @see docs/architecture/multi-language-analysis.md
 */

/**
 * Cargo.toml dependency information
 */
export interface CargoDependency {
  /** Crate name */
  name: string
  /** Version specifier */
  version: string
  /** Whether this is a dev dependency */
  isDev: boolean
}

/**
 * Parse Cargo.toml to extract dependencies
 *
 * @param content - Content of Cargo.toml file
 * @returns Array of dependencies with name, version, and isDev flag
 *
 * @example
 * ```typescript
 * const deps = parseCargoToml(cargoTomlContent)
 * console.log(deps) // [{ name: 'serde', version: '1.0', isDev: false }]
 * ```
 */
export function parseCargoToml(content: string): CargoDependency[] {
  const deps: CargoDependency[] = []
  const lines = content.split('\n')
  let inDeps = false
  let inDevDeps = false
  let inBuildDeps = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Track which section we're in
    if (trimmed === '[dependencies]') {
      inDeps = true
      inDevDeps = false
      inBuildDeps = false
      continue
    }
    if (trimmed === '[dev-dependencies]') {
      inDeps = false
      inDevDeps = true
      inBuildDeps = false
      continue
    }
    if (trimmed === '[build-dependencies]') {
      inDeps = false
      inDevDeps = false
      inBuildDeps = true
      continue
    }
    // Any other section header exits dependency sections
    if (trimmed.startsWith('[')) {
      inDeps = false
      inDevDeps = false
      inBuildDeps = false
      continue
    }

    // Parse dependencies in relevant sections
    if (inDeps || inDevDeps || inBuildDeps) {
      // Skip empty lines and comments
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue
      }

      // Simple format: name = "version"
      const simpleMatch = trimmed.match(/^([\w-]+)\s*=\s*"([^"]+)"/)
      if (simpleMatch) {
        deps.push({
          name: simpleMatch[1],
          version: simpleMatch[2],
          isDev: inDevDeps,
        })
        continue
      }

      // Table format: name = { version = "1.0", features = [...] }
      const tableMatch = trimmed.match(/^([\w-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/)
      if (tableMatch) {
        deps.push({
          name: tableMatch[1],
          version: tableMatch[2],
          isDev: inDevDeps,
        })
        continue
      }

      // Git/path dependencies without version (we still capture them)
      const gitMatch = trimmed.match(/^([\w-]+)\s*=\s*\{.*(?:git|path)\s*=/)
      if (gitMatch) {
        deps.push({
          name: gitMatch[1],
          version: 'git/path',
          isDev: inDevDeps,
        })
      }
    }
  }

  return deps
}
