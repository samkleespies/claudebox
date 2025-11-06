#!/bin/bash
# ClaudeBox macOS Installation Helper
# This script removes the quarantine flag from the DMG to bypass Gatekeeper

set -e

echo "ClaudeBox macOS Installation Helper"
echo "===================================="
echo ""

# Find the most recent ClaudeBox DMG in Downloads
DMG=$(find ~/Downloads -name "claudebox-*-macos-*.dmg" -type f | head -n 1)

if [ -z "$DMG" ]; then
    echo "Error: No ClaudeBox DMG found in ~/Downloads"
    echo ""
    echo "Please download ClaudeBox from:"
    echo "https://github.com/samkleespies/claudebox/releases"
    exit 1
fi

echo "Found: $(basename "$DMG")"
echo ""

# Remove quarantine
echo "Removing quarantine flag..."
xattr -cr "$DMG"
echo "✓ Quarantine removed"
echo ""

# Mount the DMG
echo "Mounting DMG..."
VOLUME=$(hdiutil attach "$DMG" | grep "/Volumes" | sed 's/.*\/Volumes/\/Volumes/')
if [ -z "$VOLUME" ]; then
    echo "Error: Failed to mount DMG"
    exit 1
fi
echo "✓ DMG mounted at: $VOLUME"
echo ""

# Copy to Applications
echo "Installing to /Applications..."
if [ -d "/Applications/ClaudeBox.app" ]; then
    echo "  Removing existing installation..."
    rm -rf "/Applications/ClaudeBox.app"
fi

cp -R "$VOLUME/ClaudeBox.app" /Applications/
echo "✓ Installed to /Applications/ClaudeBox.app"
echo ""

# Unmount DMG
echo "Cleaning up..."
hdiutil detach "$VOLUME" -quiet
echo "✓ DMG unmounted"
echo ""

echo "════════════════════════════════════"
echo "Installation complete!"
echo ""
echo "ClaudeBox has been installed to /Applications"
echo "You can now launch it from Launchpad or Spotlight"
echo ""
echo "Note: Since this app is unsigned, macOS may still"
echo "show a security warning on first launch."
echo "If prompted, go to System Settings > Privacy & Security"
echo "and click 'Open Anyway'"
echo "════════════════════════════════════"
