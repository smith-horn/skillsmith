/**
 * SMI-4813: parseYamlFrontmatter helper, extracted from SkillParser.ts so the
 * class file stays under the audit:standards 500-line gate.
 *
 * Internal to the indexer module — not re-exported from `index.ts`. Consumers
 * import via the `SkillParser` class.
 */

/**
 * Simple YAML frontmatter parser
 * Parses basic YAML key-value pairs without external dependencies
 */
export function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')
  let currentKey: string | null = null
  let arrayBuffer: string[] = []
  let inArray = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    // Check for array item
    if (trimmed.startsWith('- ')) {
      if (currentKey && inArray) {
        const value = trimmed.slice(2).trim()
        // Remove quotes if present
        const unquoted = value.replace(/^["']|["']$/g, '')
        arrayBuffer.push(unquoted)
      }
      continue
    }

    // Check for key-value pair
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      // Save previous array if exists
      if (currentKey && inArray && arrayBuffer.length > 0) {
        result[currentKey] = arrayBuffer
        arrayBuffer = []
      }

      const key = trimmed.slice(0, colonIndex).trim()
      const value = trimmed.slice(colonIndex + 1).trim()

      if (value === '' || value === '|' || value === '>') {
        // This might be an array or multiline value
        currentKey = key
        inArray = true
        arrayBuffer = []
      } else {
        // Simple key-value
        currentKey = null
        inArray = false

        // Parse the value
        let parsedValue: unknown = value

        // Remove quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          parsedValue = value.slice(1, -1)
        }
        // Parse boolean
        else if (value === 'true') {
          parsedValue = true
        } else if (value === 'false') {
          parsedValue = false
        }
        // Parse number
        else if (/^-?\d+(\.\d+)?$/.test(value)) {
          parsedValue = parseFloat(value)
        }
        // Parse inline array [item1, item2]
        else if (value.startsWith('[') && value.endsWith(']')) {
          parsedValue = value
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter((item) => item.length > 0)
        }

        result[key] = parsedValue
      }
    }
  }

  // Save final array if exists
  if (currentKey && inArray && arrayBuffer.length > 0) {
    result[currentKey] = arrayBuffer
  }

  return result
}
