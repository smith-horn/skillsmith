#!/bin/bash
# Pre-commit hook to check for untracked src files
# Prevents the Wave 4/5 gitignore bug from happening again

# Find untracked files in packages/*/src/
UNTRACKED=$(git ls-files --others --exclude-standard packages/*/src/ 2>/dev/null)

if [ -n "$UNTRACKED" ]; then
    echo "WARNING: Untracked files found in packages/*/src/:"
    echo "$UNTRACKED"
    echo ""
    echo "These files may be accidentally ignored by .gitignore"
    echo "Run 'git add <file>' to track them, or add to .gitignore if intentional"
    echo ""
    # Don't block commit, just warn
fi

exit 0
