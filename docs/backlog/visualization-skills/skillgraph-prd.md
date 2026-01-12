# Product Requirements Document: SkillGraph Visualizer

## Overview

**Product Name:** SkillGraph  
**Version:** 1.0  
**Date:** January 10, 2026  
**Author:** Ryan (Smith Horn Group Ltd)  
**Target Implementation:** Claude Code

SkillGraph is a visualization system for understanding relationships between skills and MCP servers in AI agent ecosystems. It provides interactive exploration of complex dependency networks through multiple complementary views, designed to scale from 100 to 300+ nodes with filtering, querying, and hierarchical navigation capabilities.

---

## Problem Statement

As AI agent systems grow in complexity with dozens to hundreds of skills and MCP servers, developers and users face critical visibility challenges:

1. **No mental model** — Cannot visualize how skills relate to each other or to MCP servers
2. **Hairball effect** — Traditional graph visualizations become unreadable at 100+ nodes
3. **Single-node blindness** — Difficult to understand all relationships for one specific skill
4. **No filtering** — Cannot query "show me everything that uses the Notion MCP"
5. **Hidden dependencies** — Skills calling sub-skills, shared resources, and conflicts remain invisible

### Business Value

- Reduces debugging time when skill invocations fail
- Enables informed decisions when adding/removing skills
- Supports workshop demonstrations and client communications
- Provides foundation for future runtime analysis features

---

## Target Users

### Primary: AI Agent Developers
- Building custom skill ecosystems
- Need to understand dependency chains
- Want to identify optimization opportunities

### Secondary: Workshop Participants
- Learning agentic AI architecture
- Need intuitive visualization for understanding
- Benefit from interactive exploration

---

## Functional Requirements

### FR-1: Data Ingestion

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Accept JSON input defining nodes (skills, MCPs) and edges (relationships) | P0 |
| FR-1.2 | Support CLI invocation with file path argument | P0 |
| FR-1.3 | Support stdin piped input for integration flexibility | P1 |
| FR-1.4 | Validate input schema and report errors clearly | P0 |
| FR-1.5 | Support incremental updates without full reload | P2 |

**Input Schema (Draft):**
```json
{
  "nodes": [
    {
      "id": "skill-docx",
      "type": "skill",
      "label": "Document Creator",
      "metadata": {
        "path": "/mnt/skills/public/docx",
        "invocationCount": 145,
        "category": "document"
      },
      "children": ["skill-docx-tables", "skill-docx-styles"]
    },
    {
      "id": "mcp-notion",
      "type": "mcp",
      "label": "Notion MCP",
      "metadata": {
        "url": "https://mcp.notion.com/mcp",
        "invocationCount": 89
      }
    }
  ],
  "edges": [
    {
      "source": "skill-docx",
      "target": "mcp-notion",
      "type": "calls",
      "metadata": {
        "frequency": "high"
      }
    }
  ],
  "relationshipTypes": ["calls", "depends-on", "shares-data", "conflicts", "requires-auth"]
}
```

### FR-2: Visualization Views

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | **DSM View**: Dependency Structure Matrix for pattern detection at scale | P0 |
| FR-2.2 | **Ego-Centric View**: Focus on single node with 1-2 hop neighbors | P0 |
| FR-2.3 | **Compound Graph View**: Hierarchical view with collapsible skill groups | P1 |
| FR-2.4 | Seamless switching between views preserving selection state | P1 |
| FR-2.5 | View state persistence in URL for shareability | P2 |

#### FR-2.1: DSM View Specifications
- Matrix display with skills/MCPs on both axes
- Color-coded cells by relationship type
- Expandable/collapsible hierarchy rows
- Click cell to see relationship details
- Highlight cycles and layering patterns
- Sort/reorder using partitioning algorithms

#### FR-2.2: Ego-Centric View Specifications
- Radial layout around selected focal node
- Configurable hop depth (1 or 2)
- Edge coloring by relationship type
- Node sizing by invocation frequency (optional)
- Smooth animation when changing focus
- "Expand" action to add neighbors to view

#### FR-2.3: Compound Graph View Specifications
- Skills with sub-skills shown as nested containers
- Expand/collapse containers
- Force-directed layout within containers
- Hierarchical edge bundling to reduce clutter
- Zoom-to-fit on container expansion

### FR-3: Filtering & Querying

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | Filter by node type (skill, MCP, sub-skill) | P0 |
| FR-3.2 | Filter by relationship type | P0 |
| FR-3.3 | Text search across node labels and IDs | P0 |
| FR-3.4 | Filter by metadata properties (category, frequency) | P1 |
| FR-3.5 | Combine filters with AND/OR logic | P1 |
| FR-3.6 | Save/load filter presets | P2 |
| FR-3.7 | "Highlight path" between two selected nodes | P1 |

### FR-4: Interaction

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Click node to select and show details panel | P0 |
| FR-4.2 | Hover to highlight connected edges | P0 |
| FR-4.3 | Pan and zoom with mouse/trackpad | P0 |
| FR-4.4 | Keyboard navigation (arrow keys, Enter to select) | P1 |
| FR-4.5 | Right-click context menu (focus, expand, filter to) | P1 |
| FR-4.6 | Multi-select with Shift+click | P2 |

### FR-5: CLI Integration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | `skillgraph serve <file.json>` — Start local server with visualization | P0 |
| FR-5.2 | `skillgraph export <file.json> --format png\|svg\|html` — Static export | P1 |
| FR-5.3 | Auto-open browser on serve | P0 |
| FR-5.4 | Watch mode: `--watch` flag to reload on file changes | P1 |
| FR-5.5 | Port configuration: `--port <number>` | P1 |
| FR-5.6 | Quiet mode for scripting: `--quiet` | P2 |

### FR-6: Details Panel

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | Show node metadata on selection | P0 |
| FR-6.2 | List all incoming and outgoing relationships | P0 |
| FR-6.3 | Link to source file path (clickable if local) | P1 |
| FR-6.4 | Show invocation statistics if available | P1 |
| FR-6.5 | "Copy ID" button for scripting integration | P2 |

---

## Non-Functional Requirements

### NFR-1: Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1.1 | Initial render time for 300 nodes | < 2 seconds |
| NFR-1.2 | Filter application latency | < 100ms |
| NFR-1.3 | View switch animation | < 300ms |
| NFR-1.4 | Smooth 60fps during pan/zoom | Maintained |
| NFR-1.5 | Memory usage for 300 nodes | < 100MB |

### NFR-2: Browser Compatibility

| Browser | Minimum Version |
|---------|-----------------|
| Chrome | 90+ |
| Firefox | 88+ |
| Safari | 14+ |
| Edge | 90+ |

### NFR-3: Accessibility

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-3.1 | Keyboard navigable | P1 |
| NFR-3.2 | Screen reader labels for nodes | P2 |
| NFR-3.3 | Color-blind friendly palette option | P1 |
| NFR-3.4 | Minimum contrast ratios (WCAG AA) | P1 |

### NFR-4: Licensing Requirements

**Critical:** All dependencies must have licenses compatible with commercial use and bundling.

| Acceptable Licenses | Not Acceptable |
|---------------------|----------------|
| MIT | GPL v2/v3 |
| Apache 2.0 | AGPL |
| BSD 2/3-Clause | SSPL |
| ISC | CC-NC variants |
| Unlicense | |

---

## Technical Approach

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Layer                                │
│                    (Node.js / Bun)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   serve     │  │   export    │  │   validate  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Local HTTP Server                            │
│                  (Express / Fastify)                            │
│         Serves static files + JSON data endpoint                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Frontend Application                          │
│                    (Vanilla JS or React)                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    State Management                       │  │
│  │     (Graph data, filters, selection, view mode)          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│       ┌──────────────────────┼──────────────────────┐          │
│       ▼                      ▼                      ▼          │
│  ┌─────────┐          ┌─────────────┐        ┌───────────┐     │
│  │DSM View │          │ Ego-Centric │        │ Compound  │     │
│  │(Custom) │          │   (Sigma/   │        │  Graph    │     │
│  │         │          │  Cytoscape) │        │(Cytoscape)│     │
│  └─────────┘          └─────────────┘        └───────────┘     │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 Shared Components                         │  │
│  │  Filter Bar │ Details Panel │ Legend │ View Switcher     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Recommended Technology Stack

| Layer | Technology | License | Rationale |
|-------|------------|---------|-----------|
| CLI Runtime | Node.js or Bun | MIT | Wide adoption, fast startup |
| CLI Framework | Commander.js | MIT | Standard, lightweight |
| HTTP Server | Fastify | MIT | Fast, minimal |
| Graph Library | Cytoscape.js | MIT | Compound nodes, filters, layouts |
| Graph Performance | Sigma.js + Graphology | MIT | WebGL rendering if needed |
| DSM Rendering | Custom Canvas/SVG | N/A | No good OSS DSM library exists |
| Build Tool | Vite | MIT | Fast, modern |
| Testing | Vitest | MIT | Fast, Vite-native |

### Key Design Decisions

1. **Cytoscape.js as primary graph engine**
   - Rationale: Native compound node support, rich filtering API, 67+ layout extensions
   - Risk: Slower than Sigma.js at extreme scale
   - Mitigation: Use Sigma.js for ego-centric view if performance issues arise

2. **Custom DSM implementation**
   - Rationale: No MIT-licensed DSM library exists; Canvas rendering is straightforward
   - Risk: Development effort
   - Mitigation: Start with basic matrix, iterate on features

3. **Vanilla JS or lightweight framework**
   - Rationale: Minimize bundle size, faster load for CLI tool
   - Alternative: React if team prefers component model
   - Decision: Defer to implementation phase based on complexity

4. **Single-page app served locally**
   - Rationale: Simplest CLI integration, works offline
   - Future: Same codebase can be deployed to hosted service

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
**Goal:** Working CLI that serves basic visualization

**Tasks:**
- [ ] Project scaffolding (repo, build, lint, test setup)
- [ ] JSON schema definition and validation
- [ ] CLI with `serve` command
- [ ] Local HTTP server serving static files
- [ ] Basic graph rendering with Cytoscape.js
- [ ] Single view: simple node-link diagram

**Deliverables:** 
- `skillgraph serve data.json` opens browser with interactive graph
- Basic pan/zoom/click interactions

**Acceptance Criteria:**
- [ ] 100-node test graph renders in < 1 second
- [ ] Click node shows ID in console
- [ ] CLI provides helpful error on invalid JSON

### Phase 2: Core Views (Week 3-4)
**Goal:** Implement all three visualization views

**Tasks:**
- [ ] DSM View implementation (Canvas-based)
- [ ] Ego-Centric View with radial layout
- [ ] Compound Graph View with expand/collapse
- [ ] View switcher component
- [ ] Shared selection state across views

**Deliverables:**
- Three functioning view modes
- Seamless view switching

**Acceptance Criteria:**
- [ ] DSM correctly shows relationship matrix
- [ ] Ego-centric view focuses on clicked node
- [ ] Compound containers expand/collapse
- [ ] Selection persists when switching views

### Phase 3: Filtering & Interaction (Week 5-6)
**Goal:** Full filtering and query capabilities

**Tasks:**
- [ ] Filter bar UI component
- [ ] Node type filter
- [ ] Relationship type filter
- [ ] Text search with highlighting
- [ ] Details panel with metadata
- [ ] Keyboard navigation
- [ ] Context menu

**Deliverables:**
- Fully interactive filtering system
- Rich details panel

**Acceptance Criteria:**
- [ ] Filter "type:mcp" shows only MCP nodes
- [ ] Search "notion" highlights matching nodes
- [ ] Details panel shows all relationships
- [ ] Tab/arrow key navigation works

### Phase 4: Polish & Export (Week 7-8)
**Goal:** Production-ready CLI tool

**Tasks:**
- [ ] Export command (PNG, SVG, standalone HTML)
- [ ] Watch mode for development workflow
- [ ] Color-blind friendly palette
- [ ] Performance optimization pass
- [ ] Documentation (README, examples)
- [ ] Packaging for npm distribution

**Deliverables:**
- Complete CLI tool ready for distribution
- Documentation and examples

**Acceptance Criteria:**
- [ ] `skillgraph export data.json --format svg` produces valid SVG
- [ ] `--watch` mode reloads on file change
- [ ] 300-node graph renders under 2 seconds
- [ ] README covers all commands and options

---

## Data Model

### Node Types

| Type | Description | Visual |
|------|-------------|--------|
| `skill` | A Claude skill (may have children) | Rounded rectangle, blue |
| `sub-skill` | Nested skill within parent | Smaller rounded rectangle |
| `mcp` | MCP server connection | Hexagon, green |
| `resource` | Shared resource (optional) | Circle, orange |

### Relationship Types

| Type | Description | Visual |
|------|-------------|--------|
| `calls` | Direct invocation | Solid arrow |
| `depends-on` | Must be available | Dashed arrow |
| `shares-data` | Read/write same resource | Dotted line |
| `conflicts` | Cannot run simultaneously | Red dashed line |
| `requires-auth` | Needs authentication from | Lock icon on edge |

### Metadata Fields

**Node Metadata:**
- `path` (string): File system path
- `invocationCount` (number): Usage frequency
- `category` (string): Grouping category
- `description` (string): Human-readable description
- `enabled` (boolean): Currently active

**Edge Metadata:**
- `frequency` (string): "high" | "medium" | "low"
- `bidirectional` (boolean): Two-way relationship
- `description` (string): Relationship description

---

## API Reference (Future Hosted Service)

For future hosted deployment, the visualization should support:

```
GET /api/graph
  → Returns full graph JSON

GET /api/graph/node/:id
  → Returns single node with relationships

GET /api/graph/search?q=:query
  → Returns matching nodes

POST /api/graph/filter
  Body: { types: [], relationships: [], search: "" }
  → Returns filtered subgraph
```

---

## Success Criteria

### Technical Success
- [ ] All P0 requirements implemented
- [ ] Performance targets met (NFR-1)
- [ ] Browser compatibility verified
- [ ] Zero GPL/AGPL dependencies
- [ ] Test coverage > 70%

### User Success
- [ ] Developer can understand skill dependencies in < 2 minutes
- [ ] "Find all skills using Notion MCP" query takes < 10 seconds
- [ ] Non-technical user can navigate ego-centric view intuitively

---

## Risks & Mitigation

### Risk 1: DSM Implementation Complexity
- **Probability:** Medium
- **Impact:** High
- **Mitigation:** Start with minimal viable DSM (just the matrix), add features iteratively. Consider d3.js matrix examples as reference.

### Risk 2: Performance with 300+ Nodes
- **Probability:** Medium
- **Impact:** Medium
- **Mitigation:** Use WebGL rendering (Sigma.js) for graph views if Canvas-based Cytoscape struggles. Implement virtualization for DSM.

### Risk 3: Scope Creep
- **Probability:** High
- **Impact:** Medium
- **Mitigation:** Strict adherence to P0/P1/P2 priorities. P2 features only after P0/P1 complete.

### Risk 4: Library Licensing Issues
- **Probability:** Low
- **Impact:** High
- **Mitigation:** Audit all dependencies before use. Use `license-checker` tool in CI.

---

## Open Questions

1. **Framework choice:** Vanilla JS vs. React for frontend? (Decision: Phase 1)
2. **Bundling:** Single HTML file vs. separate assets? (Preference for single file for portability)
3. **State persistence:** LocalStorage vs. URL params vs. file export?
4. **Future runtime analysis:** What telemetry format will be used?

---

## Appendix A: Example Test Data

```json
{
  "nodes": [
    { "id": "skill-docx", "type": "skill", "label": "Document Creator", "children": ["skill-docx-tables"] },
    { "id": "skill-docx-tables", "type": "sub-skill", "label": "Table Formatter" },
    { "id": "skill-xlsx", "type": "skill", "label": "Spreadsheet Creator" },
    { "id": "skill-pdf", "type": "skill", "label": "PDF Generator" },
    { "id": "mcp-notion", "type": "mcp", "label": "Notion MCP" },
    { "id": "mcp-gdrive", "type": "mcp", "label": "Google Drive MCP" }
  ],
  "edges": [
    { "source": "skill-docx", "target": "mcp-notion", "type": "calls" },
    { "source": "skill-docx", "target": "mcp-gdrive", "type": "calls" },
    { "source": "skill-xlsx", "target": "mcp-gdrive", "type": "calls" },
    { "source": "skill-pdf", "target": "skill-docx", "type": "depends-on" },
    { "source": "skill-docx-tables", "target": "skill-xlsx", "type": "shares-data" }
  ],
  "relationshipTypes": ["calls", "depends-on", "shares-data"]
}
```

---

## Appendix B: Competitor/Reference Analysis

| Tool | Strengths | Weaknesses | Lessons |
|------|-----------|------------|---------|
| Obsidian Graph | Beautiful, integrated | No filtering, hairball at scale | Need filtering |
| NDepend DSM | Scales well, patterns visible | Windows-only, expensive | DSM is valuable |
| Neo4j Bloom | Natural language query | Requires Neo4j backend | Query UX inspiration |
| Gephi | Powerful analysis | Desktop-only, steep learning | Analysis features later |

---

## Appendix C: File Structure (Proposed)

```
skillgraph/
├── packages/
│   ├── cli/                    # CLI tool
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── serve.ts
│   │   │   │   ├── export.ts
│   │   │   │   └── validate.ts
│   │   │   ├── server/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── web/                    # Frontend application
│       ├── src/
│       │   ├── views/
│       │   │   ├── dsm/
│       │   │   ├── ego-centric/
│       │   │   └── compound/
│       │   ├── components/
│       │   │   ├── FilterBar/
│       │   │   ├── DetailsPanel/
│       │   │   ├── Legend/
│       │   │   └── ViewSwitcher/
│       │   ├── state/
│       │   │   └── graph.ts
│       │   ├── utils/
│       │   │   └── schema.ts
│       │   └── main.ts
│       ├── public/
│       └── package.json
│
├── examples/                   # Example data files
│   ├── simple.json
│   ├── complex.json
│   └── skills-ecosystem.json
│
├── docs/                       # Documentation
│   ├── README.md
│   ├── schema.md
│   └── cli-reference.md
│
├── package.json                # Monorepo root
└── README.md
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-10 | Ryan | Initial PRD |
