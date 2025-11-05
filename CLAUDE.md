# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ClaudeBox is an Electron-based desktop application that provides a terminal UI for running Claude Code and Codex sessions. It manages multiple AI coding sessions with integrated git worktree support, PTY (pseudoterminal) management, and a custom xterm.js-based interface.

## Development Commands

### Building and Running
```bash
npm run dev           # Start development server with hot reload
npm run start         # Preview built app without hot reload
npm run build         # Build for current platform (outputs to out/)
npm run build:win     # Build Windows NSIS installer and portable executable
npm run build:mac     # Build macOS DMG (x64 and arm64)
npm run build:linux   # Build Linux AppImage
```

### Other Commands
```bash
npm run lint          # Run ESLint on src/**/*.js
npm run clean         # Remove out/ and dist/ directories
npm run postinstall   # Install native dependencies (runs automatically)
```

### Installation Scripts
Platform-specific installation/uninstallation scripts are in `scripts/`:
- `install-linux.sh` / `uninstall-linux.sh`
- `install-windows.ps1` / `uninstall-windows.ps1`

## Architecture

### Electron Three-Process Architecture

**Main Process** (`src/main/main.js`):
- Application lifecycle and window management
- PTY session spawning using `@homebridge/node-pty-prebuilt-multiarch`
- Git operations and worktree management (lines 86-607)
- Session state management via Map (line 75: `sessions`)
- IPC handlers for all backend operations (lines 966-1707)
- Auto-updater integration

**Preload Script** (`src/preload/preload.js`):
- Security bridge using `contextBridge`
- Exposes `window.claudebox` API to renderer
- All IPC communication goes through this boundary

**Renderer Process** (`src/renderer/renderer.js`):
- UI rendering and user interactions
- xterm.js terminal integration (v5.5.0 with FitAddon)
- Session list and active session management
- AI activity state machine (lines 603-683)
- Git branch UI and quick prompts system

### Key Architectural Components

#### Session Management
Sessions are tracked in a Map with auto-incrementing IDs. Each session includes:
- Unique ID, type (`claude`, `codex`, `opencode`, `gemini`, `terminal`)
- Title, status (`running`, `exiting`, `exited`)
- Working directory (`cwd`), branch name, worktree path
- PTY process instance
- Exit code

#### PTY Integration (src/main/main.js:767-809)
Platform-specific shell spawning:
- **Windows**: PowerShell with ConPTY enabled for proper color rendering
- **Unix**: Bash or `$SHELL` environment variable
- Enhanced PATH for npm/nvm binaries (lines 613-647)
- Terminal settings: 100x30 default, xterm-256color, truecolor support

#### Git Worktree System
Creates isolated worktrees for feature branches in `.claudebox/worktrees/`:
- Branch name validation prevents command injection (lines 124-163)
- Path traversal protection (lines 360-370)
- Uses `execFile` instead of `exec` for security (lines 96-115)
- Automatic cleanup when sessions close (lines 1229-1260)
- Worktree metadata tracked in JSON file

#### Activity Detection State Machine (src/renderer/renderer.js:603-683)
Sophisticated detection of AI activity states:
- **States**: `idle`, `thinking`, `working`, `responding`
- **Detection**: 1-second rolling window aggregates chunks, pattern matches spinner characters (✽✦✧✨◦•)
- **Validation**: State transition validation prevents invalid transitions
- **Timeout Reset**: Different timeouts per state for accurate UI feedback

### IPC Communication Patterns

**Request-Response** (Renderer → Main):
```javascript
// Renderer invokes
await window.claudebox.createSession(type, cwd, branchMode, branchName)
// → Preload forwards via ipcRenderer.invoke()
// → Main handles with ipcMain.handle()
// ← Returns session metadata
```

**Push Events** (Main → Renderer):
```javascript
// Main broadcasts to all windows
broadcast('session:data', { id, data })
// → Renderer listens with window.claudebox.onSessionData()
```

### Security Architecture

1. **Context Isolation**: Enabled in BrowserWindow (main.js:862)
2. **No Node Integration**: Disabled in renderer (main.js:863)
3. **Content Security Policy**: Restricts script/style sources (main.js:870-885)
4. **Command Injection Prevention**:
   - Uses `execFile` not `exec` for git commands
   - Branch name validation with regex
   - Path traversal protection in worktree paths
   - PowerShell path escaping for external terminals (lines 1470-1476)

## Build Configuration

### electron.vite.config.js
- **Main**: Externalizes `node-pty` to preserve native binary
- **Preload**: Single bridge script entry point
- **Renderer**: Root in `src/renderer`, auto-copies assets from `src/renderer/assets`

### package.json Build Section
Electron Builder configuration for multi-platform builds:
- **Windows**: NSIS installer + portable executable
- **macOS**: DMG for x64 and arm64
- **Linux**: AppImage for x64
- GitHub releases integration configured
- Native module handling: `node-pty-prebuilt-multiarch` is unarchived from asar

## Critical Implementation Details

### Terminal Integration (src/renderer/renderer.js:134-178)
- Custom dark theme with carefully tuned colors
- **Windows-specific**: Disables contrast adjustment due to sRGB vs gamma 2.2 differences (lines 132, 169)
- Font stack: JetBrains Mono, Cascadia Code, Fira Code
- Performance: Coalesced fit requests using `requestAnimationFrame` (lines 520-541)

### Tool Installation Detection (src/main/main.js:649-746)
- Caches CLI presence checks to avoid repeated subprocess overhead
- Enhanced PATH searches: npm global, nvm versions, Windows AppData
- Gemini CLI special validation to distinguish from Yandex screenshot tool (lines 678-693)

### Session Data Flow
```
User action → Renderer UI
→ window.claudebox API call (preload bridge)
→ IPC invoke to main process
→ PTY spawned with platform-specific shell
→ PTY data events → broadcast to all windows
→ Renderer writes to xterm.js terminal
```

## Important Patterns

1. **Session Factory**: `buildSessionMetadata()` creates consistent session objects (main.js:748-765)
2. **Broadcast Pattern**: Main process broadcasts events to all windows (main.js:918-924)
3. **State Machine**: Activity detection uses validated state transitions
4. **Coalesced Events**: Terminal resize uses `requestAnimationFrame` to batch requests
5. **Graceful Degradation**: Sessions track exit status and handle cleanup properly

## Platform-Specific Notes

### Windows
- ConPTY enabled for proper ANSI color rendering
- PowerShell is default shell with proper PATH configuration
- Portable builds available alongside NSIS installers
- Path escaping required for external terminal spawning

### macOS
- Universal binaries (x64 + arm64) in single DMG
- Unsigned builds (identity: null)
- Shell defaults to `$SHELL` or `/bin/bash`

### Linux
- AppImage format for maximum compatibility
- Installation scripts handle desktop entries and PATH setup
- Shell defaults to `$SHELL` or `/bin/bash`

## Git Worktree Workflow

When creating sessions with worktree mode enabled (toggle in UI):
1. Auto-detects if cwd is already in a worktree
2. Main branches (main/master) → use repository root
3. Feature branches → create worktree in `.claudebox/worktrees/<branch-name>`
4. Worktree metadata persisted in `.claudebox/worktree-metadata.json`
5. Sessions reuse existing worktrees when possible
6. Automatic cleanup when last session in worktree closes

The worktree mode toggle button in the UI controls whether new sessions will create isolated worktrees for branches.
