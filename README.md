```
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗██████╗  ██████╗ ██╗  ██╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗  ██████╔╝██║   ██║ ╚███╔╝
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ██╔══██╗██║   ██║ ██╔██╗
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗██████╔╝╚██████╔╝██╔╝ ██╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝
```

# ClaudeBox

A powerful desktop application for managing multiple AI coding assistants in isolated terminal sessions with advanced git integration and workflow automation.

## Overview

ClaudeBox provides a unified interface for running Claude Code, Codex, OpenCode, Gemini, and standard terminal sessions side-by-side. Built with Electron and xterm.js, it offers professional-grade session management with branch isolation, custom prompts, and automatic updates.

## Core Features

### Multi-Session Management
- Run multiple AI assistants simultaneously
- Claude Code, Codex, OpenCode, Gemini support
- Standard terminal sessions
- Session persistence and restoration
- Real-time activity status indicators
- Customizable session titles

### Git Integration & Branch Mode
- Automatic git repository detection
- Visual branch selector with current branch display
- Create and switch between branches directly from UI
- Branch mode: automatically create isolated branches for each new session
- Prevents feature conflicts by isolating work in separate branches
- One-click branch creation during session startup

### Quick Prompts System
- Pre-configured AI prompts for common tasks:
  - Debug an Issue: systematic debugging with hypothesis generation
  - Merge Branch: guided branch merging with conflict resolution
  - Handoff Summary: comprehensive branch documentation
  - Project Analysis: initial codebase exploration
- Create, edit, and manage custom prompts
- Persistent prompt storage
- One-click prompt injection into active sessions

### Auto-Update System
- Automatic update checking on startup
- Background download with progress tracking
- One-click install and restart
- GitHub releases integration
- Configurable update notifications

### UI & UX
- Dark theme optimized for long coding sessions
- Resizable sidebar
- Collapsible session list
- Keyboard shortcuts for common actions
- Smooth animations and transitions
- Professional xterm.js terminal integration

## Installation

### Prerequisites
- Node.js v16 or higher
- npm or yarn
- Git (for branch mode features)
- At least one supported AI CLI tool:
  - Claude Code: `npm install -g @anthropics/claude-code`
  - Codex: Install from official repository
  - OpenCode: `npm install -g opencode`
  - Gemini: `npm install -g gemini`

### Quick Start

```bash
# Clone the repository
git clone https://github.com/samkleespies/claudebox.git
cd claudebox

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for your platform
npm run build          # Current platform
npm run build:win      # Windows
npm run build:mac      # macOS
npm run build:linux    # Linux
```

### Platform-Specific Installation

#### Windows
1. Build: `npm run build:win`
2. Installers in `dist/`:
   - `claudebox-{version}-win-setup.exe` - Full installer with shortcuts
   - `claudebox-{version}-win-portable.exe` - Portable version
3. Run the installer or portable executable

#### macOS
1. Build: `npm run build:mac`
2. Open the `.dmg` file from `dist/`
3. Drag ClaudeBox to Applications folder
4. Allow app in System Preferences if prompted

#### Linux

##### AppImage (Recommended)
```bash
npm run build:linux
chmod +x dist/claudebox-{version}-linux-x64.AppImage
./dist/claudebox-{version}-linux-x64.AppImage
```

##### System Installation
```bash
# Install to ~/.local/bin (user-level)
npm run install:linux

# Or install system-wide
./scripts/install-linux.sh --system
```

This will:
- Install the AppImage to your bin directory
- Create a desktop entry
- Add the application icon
- Enable launching from application menu

##### Debian/Ubuntu
```bash
sudo apt install ./dist/claudebox-{version}-linux-x64.deb
```

##### Uninstall
```bash
npm run uninstall:linux                    # User-level
./scripts/uninstall-linux.sh --system     # System-wide
sudo apt remove claudebox                  # Debian/Ubuntu
```

## Usage Guide

### Creating Sessions

1. Select a working directory (defaults to user home)
2. Click any session type button (Claude Code, Codex, etc.)
3. Session opens in the selected directory
4. Switch between sessions by clicking them in the sidebar

### Using Branch Mode

1. Navigate to a git repository directory
2. Branch selector displays current branch
3. Toggle "Branch Mode" button (wave icon)
4. When creating new sessions:
   - You'll be prompted for a branch name
   - Branch is created and checked out automatically
   - Session starts in the new branch
5. Each session can work on different features in isolation

### Managing Branches

1. Click branch selector dropdown
2. See all available branches
3. Click any branch to switch
4. Use the plus button to create new branches
5. Current branch highlighted in orange

### Quick Prompts

1. Click "Quick Prompts" button
2. Select from built-in or custom prompts
3. Prompt text automatically injects into active session
4. Press Enter to send to AI

### Creating Custom Prompts

1. Open Quick Prompts dropdown
2. Click "Manage Custom Prompts"
3. Click "Add New Prompt"
4. Fill in:
   - Prompt Name (shown in dropdown)
   - Short Description (shown in dropdown)
   - Prompt Content (full text sent to AI)
5. Save and use immediately

### Auto-Updates

Updates check automatically on startup. When available:
1. Notification appears in bottom-right
2. Click "Download" to begin
3. Progress bar shows download status
4. Click "Restart & Install" when ready
5. App restarts with new version

## Development

### Project Structure

```
claudebox/
├── src/
│   ├── main/         # Electron main process
│   │   └── main.js   # IPC handlers, git integration, auto-updater
│   ├── renderer/     # UI and frontend logic
│   │   ├── index.html      # Main HTML structure
│   │   ├── renderer.js     # Session management, UI logic
│   │   └── styles.css      # Complete styling
│   └── preload/      # Secure IPC bridge
│       └── preload.js
├── scripts/          # Installation scripts
├── out/              # Build output (gitignored)
├── dist/             # Distribution packages (gitignored)
└── package.json      # Dependencies and build config
```

### Tech Stack

- Electron 27.x - Cross-platform desktop framework
- xterm.js 5.x - Professional terminal emulator
- node-pty - PTY management for terminal sessions
- electron-updater - Auto-update functionality
- electron-builder - Application packaging

### Build Configuration

The `package.json` includes build configurations for all platforms:
- Windows: NSIS installer + portable executable
- macOS: DMG with arm64/x64 universal support
- Linux: AppImage + Debian package

Auto-updater is configured for GitHub releases:
```json
{
  "publish": {
    "provider": "github",
    "owner": "samkleespies",
    "repo": "claudebox"
  }
}
```

### Development Commands

```bash
npm run dev           # Development mode with hot reload
npm run build         # Build for current platform
npm run build:win     # Build Windows installers
npm run build:mac     # Build macOS DMG
npm run build:linux   # Build Linux packages
npm run lint          # Run ESLint
npm run clean         # Clean build directories
```

### Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes with clear commits
4. Test on your platform
5. Submit a pull request

## Configuration

### Custom Prompts Storage
Custom prompts are stored in:
- Windows: `%APPDATA%/ClaudeBox/custom-prompts.json`
- macOS: `~/Library/Application Support/ClaudeBox/custom-prompts.json`
- Linux: `~/.config/ClaudeBox/custom-prompts.json`

### Session Data
Sessions are ephemeral and stored in memory. Future versions may add session persistence.

## Troubleshooting

### AI Tool Not Found
If a tool installation dialog appears:
1. Click "Install Instructions"
2. Follow the npm install command shown
3. Restart ClaudeBox
4. Tool should now be detected

### Git Features Not Working
Ensure git is installed and in your PATH:
```bash
git --version
```

### Updates Not Checking
Auto-updates only work in production builds, not development mode. To test:
```bash
npm run build
# Run the built application from dist/
```

### Terminal Not Responsive
1. Check if session is still running (status indicator)
2. Try creating a new session
3. Restart ClaudeBox if issues persist

## Keyboard Shortcuts

- `Ctrl+C` - Copy selected text (when text is selected)
- `Ctrl+V` - Paste from clipboard
- Double-click session title - Rename session
- Double-click sidebar resizer - Reset to default width

## Roadmap

- Session persistence across restarts
- Terminal theme customization
- Keyboard shortcut configuration
- Session export/import
- Multi-window support
- Context menu for right-click (optional toggle)
- Advanced git operations (merge, rebase)
- Prompt sharing and importing

## Version History

### 1.1.0 (Current)
- Branch mode with automatic branch creation
- Git integration (branch selector, switching, creation)
- Quick prompts system with 4 built-in prompts
- Custom prompts management UI
- Auto-update system with GitHub releases
- Default to user home directory on startup
- Debug quick prompt for systematic issue resolution
- Frameless branch name input dialog

### 1.0.1
- Gemini CLI support
- Session icon fixes
- UI improvements

### 1.0.0
- Initial release
- Multi-session support (Claude Code, Codex, Terminal)
- Basic session management
- Terminal interface

## License

MIT License - See LICENSE file for details

## Author

Sam Kleespies

## Support

For issues, questions, or feature requests:
- GitHub Issues: https://github.com/samkleespies/claudebox/issues
- Email: sam.kleespies@gmail.com

## Acknowledgments

- Anthropic for Claude Code
- OpenAI for Codex
- Google for Gemini
- xterm.js team for the terminal emulator
- Electron team for the framework
