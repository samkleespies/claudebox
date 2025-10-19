# ClaudeBox

Desktop UI for running Claude Code and Codex sessions.

## Features

- Terminal interface for Claude Code and Codex
- Session management
- Built with Electron and xterm.js

## Development

### Prerequisites

- Node.js (v16 or higher)
- npm

### Setup

```bash
npm install
```

### Running in Development

```bash
npm run dev
```

### Building

```bash
# Build for your current platform
npm run build

# Platform-specific builds
npm run build:linux   # Creates AppImage and .deb
npm run build:mac     # Creates .dmg
npm run build:win     # Creates portable .exe
```

## Installation

### Linux

After building for Linux, you can install ClaudeBox globally:

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

You can then run `claudebox` from the terminal or launch it from your application menu.

#### Alternative: Using the .deb package

```bash
sudo apt install ./dist/claudebox-1.0.0-linux-amd64.deb
```

#### Uninstall

```bash
# Remove user-level installation
npm run uninstall:linux

# Or remove system-wide installation
./scripts/uninstall-linux.sh --system
```

### macOS

1. Build the application: `npm run build:mac`
2. Open the generated `.dmg` file from the `dist/` directory
3. Drag ClaudeBox to your Applications folder

### Windows

1. Build the application: `npm run build:win`
2. Run the `ClaudeBox-Portable.exe` from the `dist/` directory

## Project Structure

```
claudebox/
├── src/
│   ├── main/         # Electron main process
│   ├── renderer/     # UI code
│   └── preload/      # Preload scripts
├── scripts/          # Build and installation scripts
├── out/              # Build output
└── dist/             # Distribution packages
```

## License

MIT
