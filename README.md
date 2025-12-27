# Skillsmith

**Craft your Claude Code workflow.**

Skillsmith is a skill discovery, recommendation, and learning system for [Claude Code](https://claude.ai/code) users. Find the right skills for your projects, install them safely, and learn to use them effectively.

## Status

**Phase 0: Planning & Validation** - Currently in documentation and design phase.

## Features (Planned)

- **Discover** - Search 50,000+ skills from GitHub, SkillsMP, and other sources
- **Recommend** - Get personalized skill suggestions based on your codebase
- **Install** - One-command installation with security scanning
- **Learn** - Guided learning paths for new skills
- **Trust** - Quality scores and trust tiers to find reliable skills

## Architecture

Skillsmith is built as a set of MCP (Model Context Protocol) servers that integrate directly with Claude Code:

```
┌─────────────────────────────────────────────────────┐
│  Claude Code                                         │
│  ┌─────────────────────────────────────────────────┐│
│  │  Skillsmith MCP Servers                         ││
│  │  ├── discovery-core (search, install, audit)   ││
│  │  ├── learning (paths, exercises, progress)     ││
│  │  └── sync (index refresh, health)              ││
│  └─────────────────────────────────────────────────┘│
│                          │                           │
│                          ▼                           │
│  ┌─────────────────────────────────────────────────┐│
│  │  ~/.skillsmith/                                 ││
│  │  ├── index/skills.db (SQLite + FTS5)           ││
│  │  ├── user/profile.json                         ││
│  │  └── config/settings.json                      ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## Installation (Coming Soon)

```bash
npm install -g skillsmith
skillsmith register
```

## Usage (Coming Soon)

Once installed, Skillsmith tools are available directly in Claude Code:

```
# Search for skills
"Find skills for React testing"

# Get recommendations for your project
"What skills would help with this codebase?"

# Install a skill
"Install the jest-helper skill"

# Audit activation issues
"Why isn't my commit skill working?"
```

## Documentation

Detailed documentation is available in the `/docs` folder:

- [Implementation Plans](/docs/implementation/) - Epics, stories, and tasks
- [Architecture](/docs/architecture/) - System design and technical decisions
- [Research](/docs/research/) - Background research and analysis

## Tech Stack

- **Runtime**: Node.js 18+
- **Protocol**: MCP (Model Context Protocol)
- **Database**: SQLite with FTS5
- **Embeddings**: all-MiniLM-L6-v2 via @xenova/transformers
- **Web**: Astro 4.x (skillsmith.app)
- **Extension**: VS Code (Phase 2)

## License

[Apache License 2.0](LICENSE)

## Author

Smith Horn Group Ltd

---

*Skillsmith is not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.*
