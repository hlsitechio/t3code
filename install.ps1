#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot installer for T3 Code desktop app.

.DESCRIPTION
    Downloads and installs the latest T3 Code MSI, plus all required
    dependencies (Node.js, Git, GitHub CLI, provider CLIs) via winget
    or Chocolatey. Supports future updates through both package managers.

.EXAMPLE
    iex (irm https://raw.githubusercontent.com/hlsitechio/t3code/main/install.ps1)
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repo = "hlsitechio/t3code"
$appName = "T3 Code"

function Write-Step($msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "  - $msg" -ForegroundColor DarkGray }
function Write-Err($msg)  { Write-Host "  x $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ========================================" -ForegroundColor White
Write-Host "           T3 Code Installer              " -ForegroundColor White
Write-Host "  ========================================" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Package manager detection
# ---------------------------------------------------------------------------

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

$hasWinget = Test-Command "winget"
$hasChoco  = Test-Command "choco"

if ($hasWinget) {
    Write-Ok "winget detected (primary package manager)"
} elseif ($hasChoco) {
    Write-Ok "Chocolatey detected (package manager)"
} else {
    Write-Warn "No package manager found (winget or Chocolatey)"
    Write-Step "Installing Chocolatey..."
    try {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        $hasChoco = $true
        Write-Ok "Chocolatey installed"
    } catch {
        Write-Err "Could not install Chocolatey: $_"
    }
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ---------------------------------------------------------------------------
# Universal package installer (winget > choco > manual)
# ---------------------------------------------------------------------------

function Install-Dep {
    param(
        [string]$Name,
        [string]$WingetId,
        [string]$ChocoId,
        [string]$ManualUrl
    )

    # Try winget first
    if ($hasWinget) {
        Write-Step "Installing $Name via winget..."
        $result = winget install --id $WingetId --accept-package-agreements --accept-source-agreements --disable-interactivity --silent 2>&1
        if ($LASTEXITCODE -eq 0 -or "$result" -match "already installed") {
            Write-Ok "$Name installed (winget)"
            Refresh-Path
            return $true
        }
    }

    # Fallback to Chocolatey
    if ($hasChoco) {
        Write-Step "Installing $Name via Chocolatey..."
        choco install $ChocoId -y --no-progress 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "$Name installed (Chocolatey)"
            Refresh-Path
            return $true
        }
    }

    Write-Err "Could not install $Name automatically"
    Write-Warn "Install manually: $ManualUrl"
    return $false
}

# ---------------------------------------------------------------------------
# 1. Core dependencies
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [1/4] Core Dependencies" -ForegroundColor White
Write-Host "  -----------------------" -ForegroundColor DarkGray

# Node.js
if (Test-Command "node") {
    $nodeVer = & node --version 2>$null
    Write-Ok "Node.js $nodeVer (already installed)"
} else {
    Install-Dep -Name "Node.js LTS" -WingetId "OpenJS.NodeJS.LTS" -ChocoId "nodejs-lts" -ManualUrl "https://nodejs.org"
}

# Git
if (Test-Command "git") {
    $gitVer = & git --version 2>$null
    Write-Ok "$gitVer (already installed)"
} else {
    Install-Dep -Name "Git" -WingetId "Git.Git" -ChocoId "git" -ManualUrl "https://git-scm.com"
}

# GitHub CLI
if (Test-Command "gh") {
    $ghVer = & gh --version 2>$null | Select-Object -First 1
    Write-Ok "$ghVer (already installed)"
} else {
    Install-Dep -Name "GitHub CLI" -WingetId "GitHub.cli" -ChocoId "gh" -ManualUrl "https://cli.github.com"
}

# ---------------------------------------------------------------------------
# 2. Provider CLI tools (via npm)
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [2/4] Provider CLI Tools" -ForegroundColor White
Write-Host "  ------------------------" -ForegroundColor DarkGray

if (Test-Command "npm") {
    $npmPkgs = @(
        @{ Cmd = "codex";  Pkg = "@openai/codex";            Name = "Codex CLI (OpenAI)" },
        @{ Cmd = "claude"; Pkg = "@anthropic-ai/claude-code"; Name = "Claude Code (Anthropic)" },
        @{ Cmd = "gemini"; Pkg = "@google/gemini-cli";        Name = "Gemini CLI (Google)" }
    )

    foreach ($tool in $npmPkgs) {
        if (Test-Command $tool.Cmd) {
            Write-Skip "$($tool.Name) (already installed)"
        } else {
            Write-Step "Installing $($tool.Name)..."
            npm install -g $tool.Pkg 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "$($tool.Name) installed"
            } else {
                Write-Err "$($tool.Name) failed (run later: npm i -g $($tool.Pkg))"
            }
        }
    }
} else {
    Write-Warn "npm not available — skipping provider CLI tools"
    Write-Warn "Install Node.js first, then run: npm i -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli"
}

# ---------------------------------------------------------------------------
# 3. Download & install T3 Code MSI
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [3/4] T3 Code Desktop App" -ForegroundColor White
Write-Host "  -------------------------" -ForegroundColor DarkGray

Write-Step "Fetching latest release from GitHub..."

try {
    $headers = @{ "User-Agent" = "T3CodeInstaller/1.0" }
    $release = $null
    $msiAsset = $null

    # Try latest release first
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
        $msiAsset = $release.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
    } catch {
        # No latest release, check all releases
    }

    if (-not $msiAsset) {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=10" -Headers $headers
        foreach ($r in $releases) {
            $msiAsset = $r.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
            if ($msiAsset) { $release = $r; break }
        }
    }

    if (-not $msiAsset) {
        Write-Err "No MSI found in releases at github.com/$repo"
        Write-Warn "Visit https://github.com/$repo/releases to download manually."
        exit 1
    }

    $msiUrl = $msiAsset.browser_download_url
    $msiName = $msiAsset.name
    $sizeMB = [math]::Round($msiAsset.size / 1MB, 1)
    $tempDir = Join-Path $env:TEMP "t3code-install"
    $msiPath = Join-Path $tempDir $msiName

    if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

    Write-Step "Downloading $msiName ($sizeMB MB)..."
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing

    Write-Step "Installing T3 Code (admin prompt may appear)..."
    $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qb /norestart" -Wait -Verb RunAs -PassThru
    if ($proc.ExitCode -eq 0) {
        Write-Ok "T3 Code $($release.tag_name) installed!"
    } else {
        Write-Err "MSI install returned exit code $($proc.ExitCode)"
    }

    # Cleanup
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue

} catch {
    Write-Err "Download/install failed: $_"
    Write-Warn "Visit https://github.com/$repo/releases to download manually."
    exit 1
}

# ---------------------------------------------------------------------------
# 4. Update channel setup
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  [4/4] Update Channels" -ForegroundColor White
Write-Host "  ---------------------" -ForegroundColor DarkGray

# T3 Code has built-in auto-update via electron-updater (checks GitHub Releases).
# Additionally, register with system package managers for CLI updates.

if ($hasWinget) {
    Write-Ok "winget: T3 Code will appear in 'winget upgrade' once published to winget-pkgs"
    Write-Skip "  Future: winget upgrade --id T3Tools.T3Code"
}

if ($hasChoco) {
    Write-Ok "Chocolatey: T3 Code will appear in 'choco upgrade' once published"
    Write-Skip "  Future: choco upgrade t3code -y"
}

Write-Ok "Auto-update: T3 Code checks GitHub Releases on every launch"

# npm tools can be updated with:
if (Test-Command "npm") {
    Write-Skip "Update CLI tools anytime: npm update -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "       Installation Complete!              " -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Launch T3 Code from the Start Menu or Desktop shortcut." -ForegroundColor White
Write-Host ""
Write-Host "  Quick start:" -ForegroundColor DarkGray
Write-Host "    1. Sign in with your AI providers (ChatGPT, Claude, Gemini)" -ForegroundColor DarkGray
Write-Host "    2. Connect your GitHub account" -ForegroundColor DarkGray
Write-Host "    3. Start coding!" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Update everything:" -ForegroundColor DarkGray
if ($hasWinget) {
    Write-Host "    winget upgrade --all" -ForegroundColor DarkGray
}
if ($hasChoco) {
    Write-Host "    choco upgrade all -y" -ForegroundColor DarkGray
}
Write-Host "    npm update -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli" -ForegroundColor DarkGray
Write-Host ""
