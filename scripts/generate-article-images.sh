#!/bin/bash
# Generate images for agent-skill-framework article using Gemini 2.0 Flash Image Generation
# Usage: varlock run -- ./scripts/generate-article-images.sh

set -e

OUTPUT_DIR="docs/articles/images"
mkdir -p "$OUTPUT_DIR"

# Function to generate image using Gemini 2.0 Flash Image Generation API
generate_image() {
    local filename="$1"
    local prompt="$2"

    echo "Generating: $filename"

    # Call Gemini 2.0 Flash Image Generation API
    response=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${GEMINI_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{
            \"contents\": [{
                \"parts\": [{\"text\": \"Generate an image: $prompt\"}]
            }],
            \"generationConfig\": {
                \"responseModalities\": [\"image\", \"text\"]
            }
        }")

    # Extract base64 image data and decode
    image_data=$(echo "$response" | jq -r '.candidates[0].content.parts[] | select(.inlineData) | .inlineData.data' 2>/dev/null)

    if [ -n "$image_data" ] && [ "$image_data" != "null" ]; then
        echo "$image_data" | base64 -d > "$OUTPUT_DIR/$filename"
        echo "✓ Saved: $OUTPUT_DIR/$filename ($(du -h "$OUTPUT_DIR/$filename" | cut -f1))"
    else
        echo "✗ Failed: $filename"
        echo "$response" | jq -r '.error.message // "Unknown error"' 2>/dev/null || echo "Parse error"
    fi

    # Rate limiting - avoid hitting API too fast
    sleep 2
}

echo "Starting image generation for agent-skill-framework article..."
echo ""

# Image 1: Agent vs Skill Matrix
generate_image "01-agent-skill-matrix.png" \
"Clean 2x2 matrix diagram for technical documentation. X-axis labeled Scope from Narrow to Broad. Y-axis labeled Purpose from Execution to Knowledge. Top-left quadrant labeled Sub-Skills with single tool icon. Top-right quadrant labeled Skills with toolbox icon. Bottom-left quadrant labeled Sub-Agents with single worker icon. Bottom-right quadrant labeled Agents with conductor orchestrator icon. Professional minimal design with coral orange and navy blue colors on white background. Corporate infographic style suitable for technical article."

# Image 2: Context Window Economics
generate_image "02-context-window-economics.png" \
"Technical infographic showing three horizontal progress bars representing AI context windows. First bar completely filled in red labeled Monolithic Agent showing 150K tokens with red warning icon. Second bar partially filled labeled Orchestrator plus Sub-Agents showing 30K main section plus three smaller 15K segments. Third bar with minimal fill labeled Optimal Composition showing 10K orchestrator plus multiple 8K modular skill blocks that can attach and detach. Clean data visualization style with token counts labeled. Professional technical diagram on white background."

# Image 3: Delegation Architecture Flow
generate_image "03-delegation-architecture.png" \
"Hierarchical flow diagram for software architecture documentation. At top a large node labeled Orchestrator Agent. Three branches below connecting to medium nodes labeled Coder Agent, Tester Agent, and Reviewer Agent. Each of those connects down to small nodes labeled Issue Tracker Agent at bottom. Left side has arrow labeled Task Decomposition pointing down. Right side has arrow labeled Result Aggregation pointing up. Show document icons getting smaller at each level representing context. Modern flowchart style with clean lines navy and coral colors on white."

# Image 4: Decision Framework Tree
generate_image "04-decision-framework.png" \
"Decision tree flowchart for technical documentation. Start node with question I need to extend AI capabilities. First decision branch asking Is this about HOW to behave or WHAT tools to use. If Behavior leads to question Is it project-specific or reusable. If project-specific leads to Add to CLAUDE.md. If reusable leads to Create an Agent. If Tools from first question leads to Will it be triggered automatically or explicitly. If automatically leads to Create a Skill. If explicitly leads to Create a Slash Command. Additional branch from Skill asking Is it over 500 lines leading to Decompose into sub-skills. Clean professional flowchart with yes no paths and distinct colored terminal nodes green for endpoints."

# Image 5: Progressive Skill Loading
generate_image "05-progressive-disclosure.png" \
"Layered architecture diagram showing three horizontal layers stacked vertically representing progressive skill loading. Top thinnest layer labeled Skill Registry showing multiple skill names like Linear React Testing Security with label 500 tokens. Middle medium layer labeled SKILL.md Header showing one skill expanded with metadata and when-to-use sections labeled 2K tokens. Bottom thickest layer labeled Full Skill Content showing complete instructions scripts templates examples labeled 8K tokens. Arrows between layers showing Always loaded at top, Loaded on match at middle, Loaded on execution at bottom. Clean technical architecture diagram style on white background."

# Image 6: Daisy Chain Sequence
generate_image "06-daisy-chain-sequence.png" \
"UML sequence diagram with five vertical swim lanes labeled from left to right: Orchestrator, Coder Agent, Orchestration Skill, Governance Agent blocking, Issue Tracker Agent. Horizontal arrows showing message flow: Step 1 Orchestrator sends Implement feature to Coder Agent. Step 2 Coder Agent work block. Step 3 Coder invokes Orchestration Skill. Step 4 Orchestration Skill spawns Governance Agent. Step 5 Governance Agent runs audit with PASS FAIL decision. Step 6 On PASS spawns Issue Tracker Agent. Step 7 Issue Tracker updates and returns confirmation. Bounded boxes showing context window sizes 15K 8K 6K at each agent. Professional clean sequence diagram style."

# Image 7: Git Worktrees Structure
generate_image "07-git-worktrees.png" \
"Diagram showing Git worktree structure for parallel agent development. Center shows database cylinder icon labeled Repository .git. Five folder icons radiating outward connected by lines: main folder for main branch, trees agent-1 folder for feature auth branch, trees agent-2 folder for feature api branch, trees agent-3 folder for bugfix validation branch, trees agent-4 folder for refactor components branch. Each worktree folder shows small terminal icon with Claude Code label. Arrows between worktrees and center labeled Shared history isolated workspace. Callout bubble saying Conflict-free zone. Modern DevOps diagram style with blue and green colors."

# Image 8: Claude-Flow Orchestration
generate_image "08-claude-flow-orchestration.png" \
"Cloud architecture system diagram. Top section shows control panel bar labeled Claude-Flow Orchestration Layer. Below that a container labeled Hive Configuration containing three boxes labeled Swarm A, Swarm B, Swarm C, each containing 2-3 small circles representing Agent nodes. Arrows showing execution flow: Wave 1 arrow to Swarm A, then Wave 2 with parallel arrows to Swarm B and Swarm C simultaneously, then Wave 3 arrow to final processing. Side panel showing YAML configuration snippet. Green checkmarks on completed items yellow spinner icons on in-progress. Professional cloud architecture diagram style navy and white."

# Image 9: Anti-Patterns vs Patterns
generate_image "09-patterns-antipatterns.png" \
"Split comparison infographic divided vertically. Left side with red warning header labeled Anti-Patterns showing three items: 1 bloated saturated context window rectangle labeled Monolithic agent with everything loaded, 2 bidirectional arrow icon labeled Skill that also defines behavior mixing concerns, 3 tangled messy web of connections labeled Sub-agents sharing context. Right side with green success header labeled Patterns showing three corresponding items: 1 minimal clean context window labeled Orchestrator delegates to specialists, 2 clean separated boxes labeled Agent equals behavior Skill equals tools, 3 clean hierarchical tree structure labeled Sub-agents with isolated windows. Professional do vs dont comparison infographic style."

# Image 10: Skill Lifecycle Maturity
generate_image "10-skill-lifecycle.png" \
"Horizontal timeline maturity model showing skill evolution through four stages left to right. Stage 1 labeled Personal Script with single file document icon and label ~/.claude/skills/linear/SKILL.md with metric 1 user below. Stage 2 labeled Structured Skill with folder containing multiple files icon and label SKILL.md plus api.md plus scripts with metric 1 project below. Stage 3 labeled Versioned Repository with Git branch icon with version tags and label CHANGELOG.md LICENSE package.json with metric Multiple projects below. Stage 4 labeled Distributable Package with npm package icon and label claude plugin add github user skill with metric Community adoption below. Arrows showing progression between stages. Product roadmap style diagram with blue gradient."

echo ""
echo "========================================"
echo "Image generation complete!"
echo "========================================"
echo ""
ls -lah "$OUTPUT_DIR"/*.png 2>/dev/null || echo "No images found"
