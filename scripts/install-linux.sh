#!/bin/bash
# ClaudeBox Linux Installation Script
# Installs the AppImage to the user's local bin directory and creates a desktop entry

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

# Find the AppImage
APPIMAGE=$(find "$DIST_DIR" -name "claudebox*.AppImage" -type f | head -n 1)

if [ -z "$APPIMAGE" ]; then
    echo "Error: claudebox AppImage not found in $DIST_DIR"
    echo "Please run 'npm run build:linux' first"
    exit 1
fi

echo "Found AppImage: $APPIMAGE"

# Determine installation directory
if [ "$1" == "--system" ]; then
    INSTALL_DIR="/usr/local/bin"
    DESKTOP_DIR="/usr/share/applications"
    ICON_DIR="/usr/share/icons/hicolor/256x256/apps"
    SUDO="sudo"
    echo "Installing system-wide (requires sudo)..."
else
    INSTALL_DIR="$HOME/.local/bin"
    DESKTOP_DIR="$HOME/.local/share/applications"
    ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
    SUDO=""
    echo "Installing to user directory..."
fi

# Create directories if they don't exist
mkdir -p "$INSTALL_DIR" "$DESKTOP_DIR" "$ICON_DIR" 2>/dev/null || $SUDO mkdir -p "$INSTALL_DIR" "$DESKTOP_DIR" "$ICON_DIR"

# Copy AppImage
APPIMAGE_NAME="claudebox"
INSTALL_PATH="$INSTALL_DIR/$APPIMAGE_NAME"

echo "Installing AppImage to $INSTALL_PATH..."
$SUDO cp "$APPIMAGE" "$INSTALL_PATH"
$SUDO chmod +x "$INSTALL_PATH"

# Copy icon if it exists
ICON_SOURCE="$PROJECT_DIR/src/renderer/assets/images/app-icon.png"
if [ -f "$ICON_SOURCE" ]; then
    echo "Installing icon..."
    $SUDO cp "$ICON_SOURCE" "$ICON_DIR/claudebox.png"
fi

# Create desktop entry
DESKTOP_FILE="$DESKTOP_DIR/claudebox.desktop"
echo "Creating desktop entry at $DESKTOP_FILE..."

$SUDO tee "$DESKTOP_FILE" > /dev/null <<EOF
[Desktop Entry]
Name=ClaudeBox
Comment=Desktop UI for running Claude Code and Codex sessions
Exec=$INSTALL_PATH
Icon=claudebox
Type=Application
Categories=Development;Utility;
Terminal=false
StartupNotify=true
EOF

$SUDO chmod +x "$DESKTOP_FILE"

# Update desktop database if possible
if command -v update-desktop-database &> /dev/null; then
    echo "Updating desktop database..."
    if [ "$1" == "--system" ]; then
        $SUDO update-desktop-database /usr/share/applications
    else
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi
fi

echo ""
echo "✓ ClaudeBox has been installed successfully!"
echo ""
echo "You can now:"
echo "  • Run 'claudebox' from the terminal"
echo "  • Find ClaudeBox in your application menu"
echo ""

if [ "$1" != "--system" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo "Note: Make sure $HOME/.local/bin is in your PATH"
    echo "Add this to your ~/.bashrc or ~/.zshrc:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
fi
