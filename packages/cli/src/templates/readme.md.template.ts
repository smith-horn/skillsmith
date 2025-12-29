/**
 * README.md Template
 *
 * Template for new skill README files.
 */

export const README_MD_TEMPLATE = `# {{name}}

{{description}}

## Overview

This is a Claude Code skill that provides [describe functionality].

## Installation

### Via Skillsmith

\`\`\`bash
skillsmith install {{name}}
\`\`\`

### Manual Installation

1. Clone or download this repository
2. Copy to your skills directory:

\`\`\`bash
cp -r {{name}} ~/.claude/skills/
\`\`\`

## Quick Start

1. Install the skill
2. Start Claude Code
3. Use the skill by [describe how to trigger]

## Documentation

See [SKILL.md](./SKILL.md) for detailed documentation.

## Development

### Prerequisites

- Node.js 18+
- npm or pnpm

### Setup

\`\`\`bash
# Install dependencies (if any)
npm install

# Run tests
npm test
\`\`\`

### Project Structure

\`\`\`
{{name}}/
├── SKILL.md          # Skill definition and documentation
├── README.md         # This file
├── scripts/          # Automation scripts
│   └── example.js    # Example script
├── resources/        # Static resources
└── .gitignore        # Git ignore rules
\`\`\`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License

## Author

Created with [Skillsmith](https://github.com/skillsmith/skillsmith)
`

export default README_MD_TEMPLATE
