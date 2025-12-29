/**
 * SKILL.md Template
 *
 * Template for new skill SKILL.md files with YAML frontmatter.
 */

export const SKILL_MD_TEMPLATE = `---
name: {{name}}
description: {{description}}
author: {{author}}
version: 1.0.0
category: {{category}}
tags:
  - claude-skill
  - {{category}}
license: MIT
created: {{date}}
---

# {{name}}

{{description}}

## Features

- Feature 1: Description of feature
- Feature 2: Description of feature
- Feature 3: Description of feature

## Installation

\`\`\`bash
skillsmith install {{name}}
\`\`\`

Or manually:

\`\`\`bash
cp -r . ~/.claude/skills/{{name}}
\`\`\`

## Usage

### Basic Usage

Describe how to use the skill with examples.

### Commands

| Command | Description |
|---------|-------------|
| \`/example\` | Description of example command |

### Trigger Phrases

The skill responds to:
- "example phrase 1"
- "example phrase 2"

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| \`setting1\` | \`value\` | Description |

## Scripts

### example.js

Located in \`scripts/example.js\`:

\`\`\`javascript
// Your automation script here
\`\`\`

## Resources

Files in the \`resources/\` directory:
- \`resource1.txt\` - Description

## Dependencies

This skill requires:
- No external dependencies

## Contributing

Contributions welcome! Please submit pull requests.

## License

MIT License - see LICENSE file for details.

## Changelog

### 1.0.0 ({{date}})
- Initial release
`

export default SKILL_MD_TEMPLATE
