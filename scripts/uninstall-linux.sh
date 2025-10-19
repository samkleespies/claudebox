#!/bin/bash
# ClaudeBox Linux Uninstallation Script
# Removes the installed AppImage, desktop entry, and icon

set -e

# Determine installation type
if [ "$1" == "--system" ]; then
    INSTALL_DIR="/usr/local/bin"
    DESKTOP_DIR="/usr/share/applications"
    ICON_DIR="/usr/share/icons/hicolor/256x256/apps"
    SUDO="sudo"
    echo "Uninstalling from system directories (requires sudo)..."
else
    INSTALL_DIR="$HOME/.local/bin"
    DESKTOP_DIR="$HOME/.local/share/applications"
    ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
    SUDO=""
    echo "Uninstalling from user directory..."
fi

REMOVED=0

# Remove AppImage
if [ -f "$INSTALL_DIR/claudebox" ]; then
    echo "Removing AppImage from $INSTALL_DIR..."
    $SUDO rm "$INSTALL_DIR/claudebox"
    REMOVED=1
fi

# Remove desktop entry
if [ -f "$DESKTOP_DIR/claudebox.desktop" ]; then
    echo "Removing desktop entry..."
    $SUDO rm "$DESKTOP_DIR/claudebox.desktop"
    REMOVED=1
fi

# Remove icon
if [ -f "$ICON_DIR/claudebox.png" ]; then
    echo "Removing icon..."
    $SUDO rm "$ICON_DIR/claudebox.png"
    REMOVED=1
fi

# Update desktop database if possible
if command -v update-desktop-database &> /dev/null; then
    if [ "$1" == "--system" ]; then
        $SUDO update-desktop-database /usr/share/applications 2>/dev/null || true
    else
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi
fi

if [ $REMOVED -eq 1 ]; then
    echo ""
    echo "✓ ClaudeBox has been uninstalled successfully!"
else
    echo ""
    echo "ClaudeBox was not found in the expected locations."
    echo "It may not have been installed, or was installed to a different location."
fi

echo ""
