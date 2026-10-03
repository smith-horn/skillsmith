#!/bin/bash
# Setup MCP server for Claude Flow

echo "🚀 Setting up Claude Flow MCP server..."

# Check if claude command exists
if ! command -v claude &> /dev/null; then
    echo "❌ Error: Claude Code CLI not found"
    echo "Please install Claude Code first"
    exit 1
fi

# Add MCP server
echo "📦 Adding Claude Flow MCP server..."
# Must stay in sync with the "ruflo" server entry in .mcp.json: a stdio server
# whose command is the launcher script (ADR-170), not a direct npx invocation.
claude mcp add ruflo ./scripts/mcp-ruflo-launcher.sh

echo "✅ MCP server setup complete!"
echo "🎯 You can now use mcp__ruflo__ tools in Claude Code"
