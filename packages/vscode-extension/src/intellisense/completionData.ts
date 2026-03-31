/**
 * Pure data definitions for SKILL.md autocompletion.
 * Separated from SkillCompletionProvider to allow testing without the vscode dependency.
 *
 * @module intellisense/completionData
 */

export interface FrontmatterField {
  name: string
  description: string
  insertText: string
  required: boolean
}

export interface MarkdownSection {
  name: string
  description: string
  insertText: string
}

/**
 * YAML frontmatter field definitions with descriptions
 */
export const FRONTMATTER_FIELDS: FrontmatterField[] = [
  {
    name: 'name',
    description: 'The display name of the skill',
    insertText: 'name: "${1:Skill Name}"',
    required: true,
  },
  {
    name: 'description',
    description: 'A brief description of what the skill does',
    insertText: 'description: "${1:A brief description of the skill}"',
    required: true,
  },
  {
    name: 'version',
    description: 'Semantic version number (e.g., 1.0.0)',
    insertText: 'version: "${1:1.0.0}"',
    required: false,
  },
  {
    name: 'author',
    description: 'Author name or organization',
    insertText: 'author: "${1:Author Name}"',
    required: false,
  },
  {
    name: 'category',
    description: 'Skill category (e.g., development, testing, documentation)',
    insertText:
      'category: "${1|development,testing,documentation,productivity,devops,security|}"',
    required: false,
  },
  {
    name: 'tags',
    description: 'List of tags for discoverability',
    insertText: 'tags:\n  - ${1:tag1}\n  - ${2:tag2}',
    required: false,
  },
  {
    name: 'triggers',
    description: 'Phrases that activate this skill',
    insertText: 'triggers:\n  - "${1:trigger phrase}"',
    required: false,
  },
  {
    name: 'repository',
    description: 'URL to the skill repository',
    insertText: 'repository: "${1:https://github.com/user/repo}"',
    required: false,
  },
  {
    name: 'license',
    description: 'License identifier (e.g., MIT, Apache-2.0)',
    insertText: 'license: "${1|MIT,Apache-2.0,GPL-3.0,BSD-3-Clause|}"',
    required: false,
  },
]

/**
 * Common SKILL.md section headers with templates
 */
export const MARKDOWN_SECTIONS: MarkdownSection[] = [
  {
    name: '## What This Skill Does',
    description: 'Describes the main functionality of the skill',
    insertText:
      '## What This Skill Does\n\n${1:Describe the core functionality and purpose of this skill.}\n',
  },
  {
    name: '## Quick Start',
    description: 'Quick start guide for using the skill',
    insertText:
      '## Quick Start\n\n```bash\n${1:# Example command}\n```\n\nOr mention "${2:trigger phrase}" in your conversation.\n',
  },
  {
    name: '## Trigger Phrases',
    description: 'Phrases that activate the skill',
    insertText:
      '## Trigger Phrases\n\n- "${1:first trigger phrase}"\n- "${2:second trigger phrase}"\n',
  },
  {
    name: '## Examples',
    description: 'Usage examples',
    insertText:
      '## Examples\n\n### Example 1: ${1:Title}\n\n```${2:language}\n${3:code}\n```\n',
  },
  {
    name: '## Configuration',
    description: 'Configuration options for the skill',
    insertText:
      '## Configuration\n\n| Option | Type | Default | Description |\n|--------|------|---------|-------------|\n| ${1:option} | ${2:string} | ${3:-} | ${4:Description} |\n',
  },
  {
    name: '## Requirements',
    description: 'Prerequisites and dependencies',
    insertText: '## Requirements\n\n- ${1:Requirement 1}\n- ${2:Requirement 2}\n',
  },
  {
    name: '## Installation',
    description: 'Installation instructions',
    insertText:
      '## Installation\n\n```bash\n# Clone the skill repository\ngit clone ${1:repository-url}\n\n# Or install via Skillsmith\nskillsmith install ${2:skill-id}\n```\n',
  },
  {
    name: '## API Reference',
    description: 'API documentation section',
    insertText:
      '## API Reference\n\n### `${1:functionName}`\n\n${2:Description}\n\n**Parameters:**\n- `${3:param}`: ${4:description}\n\n**Returns:** ${5:return type}\n',
  },
]
