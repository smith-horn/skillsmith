# GitHub/Git Configuration Setup Script for Windows
#
# Configures a Windows machine with GitHub CLI authentication using HTTPS/OAuth.
# No SSH keys or manual token management required.
#
# Usage:
#   1. Open PowerShell as Administrator
#   2. Run: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
#   3. Run: .\setup-github.ps1
#
# Requires: Windows 10 (1809+) or Windows 11 with winget

#Requires -Version 5.1

# -------------------------------------------------------------------
# Helper Functions
# -------------------------------------------------------------------
function Write-Step {
    param([string]$Message)
    Write-Host "==> " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "Warning: " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Error {
    param([string]$Message)
    Write-Host "Error: " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

function Test-Command {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

# -------------------------------------------------------------------
# Step 1: Check for winget (Windows Package Manager)
# -------------------------------------------------------------------
Write-Step "Checking for Windows Package Manager (winget)..."

if (-not (Test-Command "winget")) {
    Write-Error "winget is not installed."
    Write-Host ""
    Write-Host "winget comes pre-installed on Windows 11 and recent Windows 10 versions."
    Write-Host "If missing, install it from the Microsoft Store:"
    Write-Host "  https://aka.ms/getwinget"
    Write-Host ""
    Write-Host "Or install 'App Installer' from the Microsoft Store."
    Write-Host ""
    exit 1
}

Write-Host "  winget is available"

# -------------------------------------------------------------------
# Step 2: Install git
# -------------------------------------------------------------------
Write-Step "Checking for Git..."

if (-not (Test-Command "git")) {
    Write-Step "Installing Git..."
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Test-Command "git")) {
        Write-Warn "Git installed but not in PATH. You may need to restart PowerShell."
    }
} else {
    $gitVersion = git --version
    Write-Host "  Git already installed: $gitVersion"
}

# -------------------------------------------------------------------
# Step 3: Install GitHub CLI
# -------------------------------------------------------------------
Write-Step "Checking for GitHub CLI..."

if (-not (Test-Command "gh")) {
    Write-Step "Installing GitHub CLI..."
    winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Test-Command "gh")) {
        Write-Warn "GitHub CLI installed but not in PATH. You may need to restart PowerShell."
    }
} else {
    $ghVersion = gh --version | Select-Object -First 1
    Write-Host "  GitHub CLI already installed: $ghVersion"
}

# -------------------------------------------------------------------
# Step 4: Configure git user info
# -------------------------------------------------------------------
Write-Step "Configuring git user info..."

$currentName = git config --global user.name 2>$null
$currentEmail = git config --global user.email 2>$null

if ([string]::IsNullOrWhiteSpace($currentName)) {
    $gitName = Read-Host "Enter your name for git commits"
    git config --global user.name "$gitName"
} else {
    Write-Host "  Name already set: $currentName"
}

if ([string]::IsNullOrWhiteSpace($currentEmail)) {
    Write-Host ""
    Write-Host "For email, you can use your GitHub noreply address for privacy:"
    Write-Host "  Format: USERNAME@users.noreply.github.com"
    Write-Host ""
    $gitEmail = Read-Host "Enter your email for git commits"
    git config --global user.email "$gitEmail"
} else {
    Write-Host "  Email already set: $currentEmail"
}

# -------------------------------------------------------------------
# Step 5: Set default branch name
# -------------------------------------------------------------------
Write-Step "Setting default branch to 'main'..."
git config --global init.defaultBranch main

# -------------------------------------------------------------------
# Step 6: Configure credential helper (Windows Credential Manager)
# -------------------------------------------------------------------
Write-Step "Configuring Windows Credential Manager..."
git config --global credential.helper manager

# -------------------------------------------------------------------
# Step 7: Authenticate with GitHub via gh CLI
# -------------------------------------------------------------------
Write-Step "Authenticating with GitHub..."

$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Step "Already authenticated with GitHub"
    gh auth status
} else {
    Write-Host ""
    Write-Host "This will open a browser for GitHub login."
    Write-Host ""
    Write-Host "What will happen:"
    Write-Host "  1. A one-time code will be displayed here"
    Write-Host "  2. Browser opens to github.com/login/device"
    Write-Host "  3. Enter the code, log in, and click 'Authorize'"
    Write-Host "  4. Return here - authentication completes automatically"
    Write-Host ""
    Write-Host "NOTE: You do NOT need to generate or paste any token."
    Write-Host "      The CLI handles everything automatically."
    Write-Host ""
    Read-Host "Press Enter to continue"

    # Interactive login with web browser (OAuth device flow)
    gh auth login --web --git-protocol https
}

# -------------------------------------------------------------------
# Step 8: Configure gh as git credential helper
# -------------------------------------------------------------------
Write-Step "Setting up gh as git credential helper..."
gh auth setup-git

# -------------------------------------------------------------------
# Step 9: Verify setup
# -------------------------------------------------------------------
Write-Host ""
Write-Step "Verifying configuration..."
Write-Host ""
Write-Host "Git configuration:"
Write-Host "  Name:  $(git config --global user.name)"
Write-Host "  Email: $(git config --global user.email)"
Write-Host ""
Write-Host "GitHub authentication:"
gh auth status
Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "You can now clone and push to GitHub repositories using HTTPS URLs."
Write-Host "Example: git clone https://github.com/smith-horn/skillsmith.git"
