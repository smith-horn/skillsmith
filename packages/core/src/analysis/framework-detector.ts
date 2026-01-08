/**
 * SMI-600: Framework Detection
 * SMI-1189: Extracted from CodebaseAnalyzer.ts
 *
 * Detects frameworks and libraries used in a codebase
 * based on imports and dependencies.
 */

import type { ImportInfo, DependencyInfo, FrameworkInfo } from './types.js'

/**
 * Framework detection rule
 */
export interface FrameworkRule {
  name: string
  depIndicators: string[]
  importIndicators: string[]
}

/**
 * Built-in framework detection rules
 */
export const FRAMEWORK_RULES: FrameworkRule[] = [
  {
    name: 'React',
    depIndicators: ['react', 'react-dom'],
    importIndicators: ['react', 'react-dom'],
  },
  {
    name: 'Next.js',
    depIndicators: ['next'],
    importIndicators: ['next', 'next/router', 'next/link', 'next/image'],
  },
  {
    name: 'Vue',
    depIndicators: ['vue'],
    importIndicators: ['vue'],
  },
  {
    name: 'Nuxt',
    depIndicators: ['nuxt'],
    importIndicators: ['nuxt', '#app', '#imports'],
  },
  {
    name: 'Angular',
    depIndicators: ['@angular/core'],
    importIndicators: ['@angular/core', '@angular/common'],
  },
  {
    name: 'Express',
    depIndicators: ['express'],
    importIndicators: ['express'],
  },
  {
    name: 'Fastify',
    depIndicators: ['fastify'],
    importIndicators: ['fastify'],
  },
  {
    name: 'NestJS',
    depIndicators: ['@nestjs/core'],
    importIndicators: ['@nestjs/core', '@nestjs/common'],
  },
  {
    name: 'Jest',
    depIndicators: ['jest'],
    importIndicators: ['@jest/globals', 'jest'],
  },
  {
    name: 'Vitest',
    depIndicators: ['vitest'],
    importIndicators: ['vitest'],
  },
  {
    name: 'Playwright',
    depIndicators: ['@playwright/test', 'playwright'],
    importIndicators: ['@playwright/test', 'playwright'],
  },
  {
    name: 'Prisma',
    depIndicators: ['@prisma/client', 'prisma'],
    importIndicators: ['@prisma/client'],
  },
  {
    name: 'TypeORM',
    depIndicators: ['typeorm'],
    importIndicators: ['typeorm'],
  },
  {
    name: 'Tailwind CSS',
    depIndicators: ['tailwindcss'],
    importIndicators: [],
  },
  {
    name: 'Electron',
    depIndicators: ['electron'],
    importIndicators: ['electron'],
  },
]

/**
 * Detect frameworks based on imports and dependencies
 *
 * @param imports - All imports found in the codebase
 * @param dependencies - Dependencies from package.json
 * @param rules - Optional custom framework rules (defaults to FRAMEWORK_RULES)
 * @returns Array of detected frameworks sorted by confidence
 */
export function detectFrameworks(
  imports: ImportInfo[],
  dependencies: DependencyInfo[],
  rules: FrameworkRule[] = FRAMEWORK_RULES
): FrameworkInfo[] {
  const frameworks: FrameworkInfo[] = []
  const depNames = new Set(dependencies.map((d) => d.name))
  const importModules = new Set(imports.map((i) => i.module))

  for (const rule of rules) {
    const evidence: string[] = []

    // Check dependencies
    for (const dep of rule.depIndicators) {
      if (depNames.has(dep)) {
        evidence.push(`Dependency: ${dep}`)
      }
    }

    // Check imports
    for (const imp of rule.importIndicators) {
      if (importModules.has(imp)) {
        evidence.push(`Import: ${imp}`)
      }
    }

    if (evidence.length > 0) {
      // Calculate confidence based on evidence
      const confidence = Math.min(1, evidence.length * 0.4)
      frameworks.push({
        name: rule.name,
        confidence,
        evidence,
      })
    }
  }

  // Sort by confidence
  frameworks.sort((a, b) => b.confidence - a.confidence)

  return frameworks
}

/**
 * Check if a specific framework is detected
 *
 * @param frameworkName - Name of the framework to check
 * @param imports - All imports found in the codebase
 * @param dependencies - Dependencies from package.json
 * @returns True if the framework is detected
 */
export function hasFramework(
  frameworkName: string,
  imports: ImportInfo[],
  dependencies: DependencyInfo[]
): boolean {
  const frameworks = detectFrameworks(imports, dependencies)
  return frameworks.some((f) => f.name.toLowerCase() === frameworkName.toLowerCase())
}

/**
 * Get the primary framework (highest confidence)
 *
 * @param imports - All imports found in the codebase
 * @param dependencies - Dependencies from package.json
 * @returns The primary framework or null if none detected
 */
export function getPrimaryFramework(
  imports: ImportInfo[],
  dependencies: DependencyInfo[]
): FrameworkInfo | null {
  const frameworks = detectFrameworks(imports, dependencies)
  return frameworks.length > 0 ? frameworks[0] : null
}
