# ClaudeBox Windows Uninstall Script
# Removes ClaudeBox from the user's local programs directory and PATH

param(
    [switch]$System
)

$ErrorActionPreference = "Stop"

# Determine installation directory
if ($System) {
    $InstallDir = "C:\Program Files\ClaudeBox"
    Write-Host "Uninstalling system-wide installation (requires Administrator)..." -ForegroundColor Yellow

    # Check for admin privileges
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "System-wide uninstallation requires Administrator privileges. Please run as Administrator or omit the -System flag for user uninstallation."
        exit 1
    }
} else {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\ClaudeBox"
    Write-Host "Uninstalling user installation..." -ForegroundColor Cyan
}

# Check if installation exists
if (-not (Test-Path $InstallDir)) {
    Write-Host "ClaudeBox is not installed at $InstallDir" -ForegroundColor Yellow
    Write-Host "Nothing to uninstall." -ForegroundColor Yellow
    exit 0
}

# Remove from PATH
Write-Host "Removing from PATH..." -ForegroundColor Cyan

if ($System) {
    $PathTarget = [System.EnvironmentVariableTarget]::Machine
} else {
    $PathTarget = [System.EnvironmentVariableTarget]::User
}

$CurrentPath = [Environment]::GetEnvironmentVariable("Path", $PathTarget)
$PathArray = $CurrentPath -split ";" | Where-Object { $_ -ne "" -and $_ -ne $InstallDir }

$NewPath = $PathArray -join ";"
[Environment]::SetEnvironmentVariable("Path", $NewPath, $PathTarget)
Write-Host "Removed $InstallDir from PATH" -ForegroundColor Green

# Remove installation directory
Write-Host "Removing installation directory..." -ForegroundColor Cyan
Remove-Item -Path $InstallDir -Recurse -Force

Write-Host ""
Write-Host "Success! ClaudeBox has been uninstalled." -ForegroundColor Green
Write-Host ""
Write-Host "Note: You may need to restart your terminal for PATH changes to take effect." -ForegroundColor Cyan
Write-Host ""
