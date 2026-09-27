#!/bin/bash
# Quick start guide for Claude Flow

echo "🚀 Claude Flow Quick Start"
echo "=========================="
echo ""
echo "1. Initialize a swarm:"
echo "   docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js swarm init --topology hierarchical"
echo ""
echo "2. Spawn agents:"
echo "   docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js agent spawn --type coder --name "API Developer""
echo ""
echo "3. Orchestrate tasks:"
echo "   docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js task orchestrate --task "Build REST API""
echo ""
echo "4. Monitor progress:"
echo "   docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js swarm monitor"
echo ""
echo "📚 For more examples, see .claude/commands/"
