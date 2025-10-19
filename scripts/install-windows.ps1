# ClaudeBox Windows Installation Script
# Installs the portable exe to the user's local programs directory and adds to PATH

param(
    [switch]$System
)

$ErrorActionPreference = "Stop"

# Get directories
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$DistDir = Join-Path $ProjectDir "dist"

# Find the portable exe (matches claudebox-*-portable.exe pattern)
$PortableExe = Get-ChildItem -Path $DistDir -Filter "claudebox-*-portable.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $PortableExe) {
    Write-Error "Error: claudebox portable exe not found in $DistDir"
    Write-Host "Please run 'npm run build:win' first" -ForegroundColor Yellow
    exit 1
}

Write-Host "Found portable exe: $($PortableExe.FullName)" -ForegroundColor Green

# Determine installation directory
if ($System) {
    $InstallDir = "C:\Program Files\ClaudeBox"
    Write-Host "Installing system-wide (requires Administrator)..." -ForegroundColor Yellow

    # Check for admin privileges
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "System-wide installation requires Administrator privileges. Please run as Administrator or omit the -System flag for user installation."
        exit 1
    }
} else {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\ClaudeBox"
    Write-Host "Installing to user directory..." -ForegroundColor Cyan
}

# Create installation directory
if (-not (Test-Path $InstallDir)) {
    Write-Host "Creating directory: $InstallDir" -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Copy the executable
$InstallPath = Join-Path $InstallDir "claudebox.exe"
Write-Host "Installing exe to $InstallPath..." -ForegroundColor Cyan
Copy-Item -Path $PortableExe.FullName -Destination $InstallPath -Force

# Add to PATH
Write-Host "Adding to PATH..." -ForegroundColor Cyan

if ($System) {
    # System-wide PATH
    $PathTarget = [System.EnvironmentVariableTarget]::Machine
} else {
    # User PATH
    $PathTarget = [System.EnvironmentVariableTarget]::User
}

$CurrentPath = [Environment]::GetEnvironmentVariable("Path", $PathTarget)
$PathArray = $CurrentPath -split ";" | Where-Object { $_ -ne "" }

if ($PathArray -notcontains $InstallDir) {
    $NewPath = ($PathArray + $InstallDir) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, $PathTarget)
    Write-Host "Added $InstallDir to PATH" -ForegroundColor Green
} else {
    Write-Host "$InstallDir is already in PATH" -ForegroundColor Yellow
}

# Update current session PATH
$env:Path = [Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::Machine) + ";" + [Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)

Write-Host ""
Write-Host "Success! ClaudeBox has been installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "You can now:" -ForegroundColor Cyan
Write-Host "  - Run 'claudebox' from any terminal (you may need to restart your terminal)" -ForegroundColor White
Write-Host "  - Run the exe directly from $InstallPath" -ForegroundColor White
Write-Host ""
