/**
 * SMI-1307: Java Build File Parsers
 *
 * Parses Maven pom.xml and Gradle build files to extract dependency information.
 * Extracted from java.ts for better modularity.
 *
 * @see docs/architecture/multi-language-analysis.md
 */

/**
 * Maven pom.xml dependency information
 */
export interface MavenDependency {
  /** Maven groupId */
  groupId: string
  /** Maven artifactId */
  artifactId: string
  /** Dependency name in groupId:artifactId format */
  name: string
  /** Version (may be a property reference like ${project.version}) */
  version: string
  /** Whether this is a test/provided scope dependency */
  isDev: boolean
  /** Maven scope (compile, test, provided, runtime, system) */
  scope?: string
}

/**
 * Parsed dependency result
 */
export interface ParsedDependency {
  name: string
  version: string
  isDev: boolean
}

/**
 * Parse pom.xml to extract Maven dependencies
 *
 * @param content - Content of pom.xml file
 * @returns Array of dependency information
 *
 * @example
 * ```typescript
 * const deps = parsePomXml(pomXmlContent)
 * console.log(deps) // [{ name: "org.springframework:spring-core", version: "5.3.0", ... }]
 * ```
 */
export function parsePomXml(content: string): ParsedDependency[] {
  const deps: ParsedDependency[] = []

  // Remove XML comments to avoid false matches
  const contentWithoutComments = content.replace(/<!--[\s\S]*?-->/g, '')

  // Match dependency blocks first, then extract individual elements
  const depBlockRegex = /<dependency>([\s\S]*?)<\/dependency>/g

  let blockMatch
  while ((blockMatch = depBlockRegex.exec(contentWithoutComments)) !== null) {
    const block = blockMatch[1]

    // Extract individual elements from the dependency block
    const groupIdMatch = block.match(/<groupId>([^<]+)<\/groupId>/)
    const artifactIdMatch = block.match(/<artifactId>([^<]+)<\/artifactId>/)
    const versionMatch = block.match(/<version>([^<]+)<\/version>/)
    const scopeMatch = block.match(/<scope>([^<]+)<\/scope>/)

    if (groupIdMatch && artifactIdMatch) {
      const groupId = groupIdMatch[1].trim()
      const artifactId = artifactIdMatch[1].trim()
      const version = versionMatch ? versionMatch[1].trim() : 'unspecified'
      const scope = scopeMatch ? scopeMatch[1].trim() : 'compile'

      deps.push({
        name: `${groupId}:${artifactId}`,
        version,
        isDev: scope === 'test' || scope === 'provided',
      })
    }
  }

  return deps
}

/**
 * Parse build.gradle or build.gradle.kts to extract Gradle dependencies
 *
 * @param content - Content of build.gradle file
 * @returns Array of dependency information
 *
 * @example
 * ```typescript
 * const deps = parseBuildGradle(gradleContent)
 * console.log(deps) // [{ name: "org.springframework:spring-core", version: "5.3.0", ... }]
 * ```
 */
export function parseBuildGradle(content: string): ParsedDependency[] {
  const deps: ParsedDependency[] = []
  let match

  // Configuration names to match
  const configs =
    'implementation|api|testImplementation|testCompileOnly|compileOnly|runtimeOnly|testRuntimeOnly|annotationProcessor|kapt'

  // Pattern 1: Groovy style with quotes: implementation 'group:artifact:version'
  const groovyQuoteRegex = new RegExp(`(${configs})\\s+['"]([^'"]+)['"]`, 'g')
  while ((match = groovyQuoteRegex.exec(content)) !== null) {
    const config = match[1]
    const depStr = match[2].trim()
    addDependency(deps, config, depStr)
  }

  // Pattern 2: Kotlin DSL style with parens and quotes: implementation("group:artifact:version")
  const kotlinStringRegex = new RegExp(`(${configs})\\s*\\(\\s*["']([^"']+)["']\\s*\\)`, 'g')
  while ((match = kotlinStringRegex.exec(content)) !== null) {
    const config = match[1]
    const depStr = match[2].trim()
    addDependency(deps, config, depStr)
  }

  // Pattern 3: Kotlin DSL with named parameters
  // implementation(group = "com.example", name = "library", version = "1.0")
  const kotlinNamedRegex = new RegExp(
    `(${configs})\\s*\\(\\s*group\\s*=\\s*"([^"]+)"\\s*,\\s*name\\s*=\\s*"([^"]+)"(?:\\s*,\\s*version\\s*=\\s*"([^"]+)")?\\s*\\)`,
    'g'
  )
  while ((match = kotlinNamedRegex.exec(content)) !== null) {
    const config = match[1]
    const group = match[2]
    const name = match[3]
    const version = match[4] || 'unspecified'

    deps.push({
      name: `${group}:${name}`,
      version,
      isDev: config.startsWith('test'),
    })
  }

  return deps
}

/**
 * Helper function to add a dependency from a colon-separated string
 */
export function addDependency(deps: ParsedDependency[], config: string, depStr: string): void {
  // Skip project references
  if (depStr.startsWith(':') || depStr.includes('project(')) {
    return
  }

  // Parse group:artifact:version format
  const parts = depStr.split(':')
  if (parts.length >= 2) {
    deps.push({
      name: `${parts[0]}:${parts[1]}`,
      version: parts[2] || 'unspecified',
      isDev: config.startsWith('test') || config === 'annotationProcessor' || config === 'kapt',
    })
  }
}
