/**
 * SMI-1189: File Scanner
 *
 * File system scanning and content extraction.
 */

import * as fs from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import type { ImportedSkill } from './types.js'

/**
 * Extracts scannable content from an imported skill
 * Combines all text fields that should be scanned
 *
 * @param skill - The imported skill to extract content from
 * @returns Combined text content for scanning
 */
export function extractScannableContent(skill: ImportedSkill): string {
  const parts: string[] = []

  if (skill.name) parts.push(`# ${skill.name}`)
  if (skill.description) parts.push(skill.description)
  if (skill.content) parts.push(skill.content)
  if (skill.instructions) parts.push(skill.instructions)
  if (skill.trigger) parts.push(skill.trigger)
  if (skill.tags?.length) parts.push(`Tags: ${skill.tags.join(', ')}`)

  // Include metadata if present
  if (skill.metadata) {
    try {
      parts.push(JSON.stringify(skill.metadata))
    } catch {
      // Ignore serialization errors
    }
  }

  return parts.join('\n\n')
}

/**
 * Read and parse imported skills from a JSON file
 *
 * @param inputPath - Path to the imported skills JSON file
 * @returns Array of imported skills
 * @throws Error if file cannot be read or parsed
 */
export async function readImportedSkills(inputPath: string): Promise<ImportedSkill[]> {
  const content = await fs.readFile(inputPath, 'utf-8')
  const parsed = JSON.parse(content) as unknown

  // Handle both array format and object with skills property
  if (Array.isArray(parsed)) {
    return parsed as ImportedSkill[]
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'skills' in parsed &&
    Array.isArray((parsed as { skills: unknown }).skills)
  ) {
    return (parsed as { skills: ImportedSkill[] }).skills
  }

  throw new Error('Invalid format: expected array or object with skills array')
}

/**
 * Ensure a directory exists, creating it if necessary
 *
 * @param dirPath - Path to the directory
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Check if a file exists
 *
 * @param filePath - Path to the file
 * @returns true if file exists
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath)
}

/**
 * Write JSON data to a file
 *
 * @param filePath - Path to the output file
 * @param data - Data to write
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2))
}
