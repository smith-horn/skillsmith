#!/bin/bash
# GitHub/Git Configuration Setup Script for macOS
#
# Configures a new Mac with GitHub CLI authentication using HTTPS/OAuth.
# No SSH keys or manual token management required.
#
# Usage:
#   chmod +x setup-github.sh
#   ./setup-github.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_step() { echo -e "${GREEN}==>${NC} $1"; }
echo_warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
echo_error() { echo -e "${RED}Error:${NC} $1"; }

# -------------------------------------------------------------------
# Step 1: Check/Install Homebrew
# -------------------------------------------------------------------
echo_step "Checking for Homebrew..."
if ! command -v brew &> /dev/null; then
    echo_step "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ $(uname -m) == "arm64" ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
else
    echo_step "Homebrew already installed"
fi

# -------------------------------------------------------------------
# Step 2: Install git and gh CLI
# -------------------------------------------------------------------
echo_step "Installing git and GitHub CLI..."
brew install git gh

# -------------------------------------------------------------------
# Step 3: Configure git user info
# -------------------------------------------------------------------
echo_step "Configuring git user info..."

# Prompt for user info if not already set
CURRENT_NAME=$(git config --global user.name 2>/dev/null || echo "")
CURRENT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")

if [[ -z "$CURRENT_NAME" ]]; then
    read -p "Enter your name for git commits: " GIT_NAME
    git config --global user.name "$GIT_NAME"
else
    echo "  Name already set: $CURRENT_NAME"
fi

if [[ -z "$CURRENT_EMAIL" ]]; then
    echo ""
    echo "For email, you can use your GitHub noreply address for privacy:"
    echo "  Format: USERNAME@users.noreply.github.com"
    echo ""
    read -p "Enter your email for git commits: " GIT_EMAIL
    git config --global user.email "$GIT_EMAIL"
else
    echo "  Email already set: $CURRENT_EMAIL"
fi

# -------------------------------------------------------------------
# Step 4: Set default branch name
# -------------------------------------------------------------------
echo_step "Setting default branch to 'main'..."
git config --global init.defaultBranch main

# -------------------------------------------------------------------
# Step 5: Authenticate with GitHub via gh CLI
# -------------------------------------------------------------------
echo_step "Authenticating with GitHub..."

# Check if already authenticated
if gh auth status &> /dev/null; then
    echo_step "Already authenticated with GitHub"
    gh auth status
else
    echo ""
    echo "This will open a browser for GitHub login."
    echo ""
    echo "What will happen:"
    echo "  1. A one-time code will be displayed here"
    echo "  2. Browser opens to github.com/login/device"
    echo "  3. Enter the code, log in, and click 'Authorize'"
    echo "  4. Return here - authentication completes automatically"
    echo ""
    echo "NOTE: You do NOT need to generate or paste any token."
    echo "      The CLI handles everything automatically."
    echo ""
    read -p "Press Enter to continue..."

    # Interactive login with web browser (OAuth device flow)
    # User logs in via browser, CLI receives token automatically
    gh auth login --web --git-protocol https
fi

# -------------------------------------------------------------------
# Step 6: Configure gh as git credential helper (optional but recommended)
# -------------------------------------------------------------------
echo_step "Setting up gh as git credential helper..."
gh auth setup-git

# -------------------------------------------------------------------
# Step 7: Verify setup
# -------------------------------------------------------------------
echo ""
echo_step "Verifying configuration..."
echo ""
echo "Git configuration:"
echo "  Name:  $(git config --global user.name)"
echo "  Email: $(git config --global user.email)"
echo ""
echo "GitHub authentication:"
gh auth status
echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "You can now clone and push to GitHub repositories using HTTPS URLs."
echo "Example: git clone https://github.com/smith-horn/skillsmith.git"
