/**
 * SMI-1307: Java Language Adapter
 *
 * Parses Java source files and extracts imports, exports, and functions
 * using regex-based parsing. Handles Java-specific features including:
 * - Visibility modifiers (public, private, protected, package-private)
 * - Annotations (@Override, @Test, @Autowired, etc.)
 * - Generics in class and method declarations
 * - Interfaces, abstract classes, enums, and annotation types
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { LanguageAdapter, type SupportedLanguage } from './base.js'
import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo, FrameworkRule } from './base.js'

/**
 * Extended ExportInfo for Java with visibility support
 */
export interface JavaExportInfo extends ExportInfo {
  /** Java visibility modifier */
  visibility: 'public' | 'private' | 'protected' | 'internal'
  /** Line number in source */
  line: number
  /** Whether the class/method is abstract */
  isAbstract?: boolean
  /** Whether the class is final */
  isFinal?: boolean
}

/**
 * Extended FunctionInfo for Java with decorator/annotation support
 */
export interface JavaFunctionInfo extends FunctionInfo {
  /** Annotations on the method (@Override, @Test, etc.) */
  decorators?: string[]
  /** Whether the method is static */
  isStatic?: boolean
  /** Whether the method is synchronized */
  isSynchronized?: boolean
}

/**
 * Java Language Adapter
 *
 * Parses Java source files using regex-based parsing.
 * Handles Java's explicit visibility modifiers and annotation system.
 *
 * @example
 * ```typescript
 * const adapter = new JavaAdapter()
 * const result = adapter.parseFile(javaCode, 'Main.java')
 * console.log(result.exports) // public classes, interfaces, enums
 * console.log(result.functions) // public/protected methods
 * ```
 */
export class JavaAdapter extends LanguageAdapter {
  readonly language: SupportedLanguage = 'java'
  readonly extensions = ['.java']

  /**
   * Parse a Java source file and extract information
   */
  parseFile(content: string, filePath: string): ParseResult {
    const imports = this.extractImports(content, filePath)
    const exports = this.extractExports(content, filePath)
    const functions = this.extractFunctions(content, filePath)
    return { imports, exports, functions }
  }

  /**
   * Parse file incrementally (currently same as full parse)
   */
  parseIncremental(content: string, filePath: string, _previousTree?: unknown): ParseResult {
    // Incremental parsing not yet implemented for Java
    // Will be added with tree-sitter integration
    return this.parseFile(content, filePath)
  }

  /**
   * Get Java framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    return [
      {
        name: 'Spring Boot',
        depIndicators: ['spring-boot', 'org.springframework.boot'],
        importIndicators: ['org.springframework.boot', 'org.springframework.web'],
      },
      {
        name: 'Spring',
        depIndicators: ['spring-core', 'org.springframework'],
        importIndicators: ['org.springframework'],
      },
      {
        name: 'Quarkus',
        depIndicators: ['io.quarkus'],
        importIndicators: ['io.quarkus', 'javax.enterprise'],
      },
      {
        name: 'Micronaut',
        depIndicators: ['io.micronaut'],
        importIndicators: ['io.micronaut'],
      },
      {
        name: 'Jakarta EE',
        depIndicators: ['jakarta.'],
        importIndicators: ['jakarta.'],
      },
      {
        name: 'JUnit',
        depIndicators: ['junit', 'org.junit'],
        importIndicators: ['org.junit', 'junit.framework'],
      },
      {
        name: 'Hibernate',
        depIndicators: ['hibernate', 'org.hibernate'],
        importIndicators: ['org.hibernate', 'javax.persistence', 'jakarta.persistence'],
      },
      {
        name: 'Lombok',
        depIndicators: ['lombok', 'org.projectlombok'],
        importIndicators: ['lombok'],
      },
      {
        name: 'Maven',
        depIndicators: ['maven', 'org.apache.maven'],
        importIndicators: [],
      },
      {
        name: 'Gradle',
        depIndicators: ['gradle', 'org.gradle'],
        importIndicators: [],
      },
      {
        name: 'TestNG',
        depIndicators: ['testng', 'org.testng'],
        importIndicators: ['org.testng'],
      },
      {
        name: 'Mockito',
        depIndicators: ['mockito', 'org.mockito'],
        importIndicators: ['org.mockito'],
      },
      {
        name: 'Jackson',
        depIndicators: ['jackson', 'com.fasterxml.jackson'],
        importIndicators: ['com.fasterxml.jackson'],
      },
      {
        name: 'Gson',
        depIndicators: ['gson', 'com.google.gson'],
        importIndicators: ['com.google.gson'],
      },
      {
        name: 'Apache Commons',
        depIndicators: ['commons-', 'org.apache.commons'],
        importIndicators: ['org.apache.commons'],
      },
      {
        name: 'SLF4J',
        depIndicators: ['slf4j', 'org.slf4j'],
        importIndicators: ['org.slf4j'],
      },
      {
        name: 'Log4j',
        depIndicators: ['log4j', 'org.apache.logging.log4j'],
        importIndicators: ['org.apache.logging.log4j', 'org.apache.log4j'],
      },
    ]
  }

  /**
   * Clean up resources (no-op for regex-based parsing)
   */
  dispose(): void {
    // No resources to clean up for regex-based parsing
  }

  /**
   * Extract import statements from Java source
   *
   * Handles:
   * - Regular imports: import com.example.Class;
   * - Static imports: import static com.example.Class.method;
   * - Wildcard imports: import com.example.*;
   */
  private extractImports(content: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match: import com.example.Class;
      // Match: import static com.example.Class.method;
      // Match: import com.example.*;
      const importMatch = line.match(/^import\s+(static\s+)?([\w.]+(?:\.\*)?);/)
      if (importMatch) {
        const isStatic = !!importMatch[1]
        const fullPath = importMatch[2]
        const isWildcard = fullPath.endsWith('.*')
        const module = isWildcard ? fullPath.slice(0, -2) : fullPath

        // Extract the simple name from the full path
        const parts = fullPath.split('.')
        const simpleName = isWildcard ? undefined : parts[parts.length - 1]

        imports.push({
          module,
          namedImports: simpleName && !isWildcard ? [simpleName] : [],
          namespaceImport: isWildcard ? '*' : undefined,
          isTypeOnly: !isStatic, // Java imports are type-only unless static
          sourceFile: filePath,
          line: i + 1,
        })
      }
    }

    return imports
  }

  /**
   * Extract exports (public declarations) from Java source
   *
   * In Java, exports are determined by visibility modifiers:
   * - public: accessible from anywhere
   * - protected: accessible from subclasses
   * - package-private (default): accessible within package
   * - private: not exported
   */
  private extractExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Match class/interface/enum/@interface declarations
      // Supports: public, protected, private, abstract, final, static modifiers
      const classMatch = line.match(
        /^\s*(public|protected|private)?\s*(abstract\s+)?(final\s+)?(static\s+)?(class|interface|enum|@interface)\s+(\w+)(?:<[^>]+>)?/
      )
      if (classMatch) {
        const visibility = classMatch[1] || 'package'
        const _isAbstract = !!classMatch[2]
        const type = classMatch[5]
        const name = classMatch[6]

        let kind: 'class' | 'interface' | 'enum' | 'type' = 'class'
        if (type === 'interface' || type === '@interface') kind = 'interface'
        if (type === 'enum') kind = 'enum'

        exports.push({
          name,
          kind,
          isDefault: false,
          sourceFile: filePath,
          visibility:
            visibility === 'package'
              ? 'internal'
              : (visibility as 'public' | 'private' | 'protected'),
          line: i + 1,
        })
      }
    }

    return exports
  }

  /**
   * Extract function definitions from Java source
   *
   * Handles:
   * - Regular methods: public void foo(String s, int n)
   * - Generic methods: public <T> List<T> bar(T item)
   * - Abstract methods: protected abstract void baz();
   * - Static methods: public static void main(String[] args)
   * - Annotated methods: @Override public String toString()
   */
  private extractFunctions(content: string, filePath: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Match method declarations:
      // public void foo(String s, int n)
      // private static <T> List<T> bar(T item)
      // protected abstract void baz();
      // @Override public String toString()
      const methodMatch = line.match(
        /^\s*(public|protected|private)?\s*(static\s+)?(abstract\s+)?(final\s+)?(synchronized\s+)?(native\s+)?(<[^>]+>\s+)?(\w+(?:<[^>]+>)?(?:\[\])*)\s+(\w+)\s*\(([^)]*)\)/
      )
      if (methodMatch) {
        const visibility = methodMatch[1] || 'package'
        const _isStatic = !!methodMatch[2]
        const _isAbstract = !!methodMatch[3]
        const _returnType = methodMatch[8]
        const name = methodMatch[9]
        const paramsStr = methodMatch[10]

        // Skip constructors (return type matches class name pattern - would need context)
        // Skip if the "return type" looks like a class name being constructed
        // A simple heuristic: constructors have no return type in the regex
        // In practice, our regex captures return type, so constructors won't match

        // Count parameters - handle generics in parameters like List<String>
        let paramCount = 0
        if (paramsStr.trim()) {
          // Remove generic brackets to avoid splitting on commas inside them
          let depth = 0
          let cleanedParams = ''
          for (const char of paramsStr) {
            if (char === '<') depth++
            else if (char === '>') depth--
            else if (char === ',' && depth === 0) cleanedParams += ','
            else if (depth === 0) cleanedParams += char
          }
          paramCount = cleanedParams.split(',').filter((p) => p.trim()).length
        }

        // Look for annotations above the method
        const decorators: string[] = []
        for (let j = i - 1; j >= 0; j--) {
          const prevLine = lines[j].trim()
          if (prevLine.startsWith('@')) {
            const annoMatch = prevLine.match(/@(\w+)/)
            if (annoMatch) {
              decorators.unshift(annoMatch[1])
            }
          } else if (prevLine && !prevLine.startsWith('//') && !prevLine.startsWith('*')) {
            break
          }
        }

        functions.push({
          name,
          parameterCount: paramCount,
          isAsync: false, // Java doesn't have async keyword
          isExported: visibility === 'public' || visibility === 'protected',
          sourceFile: filePath,
          line: i + 1,
          decorators: decorators.length > 0 ? decorators : undefined,
        })
      }
    }

    return functions
  }
}

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
export function parsePomXml(content: string): { name: string; version: string; isDev: boolean }[] {
  const deps: { name: string; version: string; isDev: boolean }[] = []

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
export function parseBuildGradle(
  content: string
): { name: string; version: string; isDev: boolean }[] {
  const deps: { name: string; version: string; isDev: boolean }[] = []
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
function addDependency(
  deps: { name: string; version: string; isDev: boolean }[],
  config: string,
  depStr: string
): void {
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
