#!/bin/bash
# Setup GitHub integration for Claude Flow

echo "🔗 Setting up GitHub integration..."

# Check for gh CLI
if ! command -v gh &> /dev/null; then
    echo "⚠️  GitHub CLI (gh) not found"
    echo "Install from: https://cli.github.com/"
    echo "Continuing without GitHub features..."
else
    echo "✅ GitHub CLI found"
    
    # Check auth status
    if gh auth status &> /dev/null; then
        echo "✅ GitHub authentication active"
    else
        echo "⚠️  Not authenticated with GitHub"
        echo "Run: gh auth login"
    fi
fi

echo ""
echo "📦 GitHub swarm commands available:"
echo "  - docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js github swarm"
echo "  - docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js repo analyze"
echo "  - docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js pr enhance"
echo "  - docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js issue triage"
