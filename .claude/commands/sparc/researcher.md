# SPARC Researcher Mode

## Purpose
Deep research with parallel WebSearch/WebFetch and Memory coordination.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "researcher",
  task_description: "research AI trends 2024",
  options: {
    depth: "comprehensive",
    sources: ["academic", "industry", "news"]
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run researcher "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `researcher`-type work (e.g. `research AI trends 2024`).

## Core Capabilities
- Information gathering
- Source evaluation
- Trend analysis
- Competitive research
- Technology assessment

## Research Methods
- Parallel web searches
- Academic paper analysis
- Industry report synthesis
- Expert opinion gathering
- Data compilation

## Memory Integration
- Store research findings
- Build knowledge graphs
- Track information sources
- Cross-reference insights
- Maintain research history
