const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { spawn } = require('child_process');

// Configure caches and GPU behavior as early as possible
try {
  const isDev = !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === 'development';
  // Place dev userData/cache under AppData to avoid permission issues/locks
  if (isDev) {
    const devUserData = path.join(app.getPath('appData'), 'ClaudeBoxDev');
    app.setPath('userData', devUserData);
    app.setPath('cache', path.join(devUserData, 'Cache'));
  }
} catch (e) {
  // Safe fallback; paths remain defaults
}

// Avoid shader disk cache errors/noise
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Configuration constants
const CLAUDE_COMMAND = 'claude --dangerously-skip-permissions';
const CODEX_COMMAND = 'codex --dangerously-bypass-approvals-and-sandbox';

// Window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 820;
// Allow much smaller windows while preserving usable UI.
// Width rationale: sidebar min is 200px + 1px resizer; leaving ~19px for workspace/toggles.
// Height rationale: keeps window controls visible and sidebar actions accessible without severe clipping.
// Minimum width should match the sidebar minimum (200px) plus the 1px resizer,
// so the workspace can collapse completely with no visible sliver.
const MIN_WINDOW_WIDTH = 200;
const MIN_WINDOW_HEIGHT = 320;

// Terminal dimensions
const DEFAULT_TERMINAL_COLS = 100;
const DEFAULT_TERMINAL_ROWS = 30;
const MIN_TERMINAL_COLS = 10;
const MIN_TERMINAL_ROWS = 5;

// Session management
const sessions = new Map();
let sessionCounter = 0;
const sessionCounterByType = new Map([
  ['claude', 0],
  ['codex', 0],
  ['terminal', 0],
]);

const log = (...args) => console.log('[main]', ...args);
const warn = (...args) => console.warn('[main]', ...args);
const reportError = (...args) => console.error('[main]', ...args);

function buildSessionMetadata(type) {
  if (!['claude', 'codex', 'terminal'].includes(type)) {
    throw new Error(`Unsupported session type: ${type}`);
  }

  const command = type === 'claude' ? CLAUDE_COMMAND : (type === 'codex' ? CODEX_COMMAND : null);
  const labelBase = type === 'claude' ? 'Claude Code' : (type === 'codex' ? 'Codex' : 'Terminal');
  const typeCount = (sessionCounterByType.get(type) ?? 0) + 1;
  sessionCounterByType.set(type, typeCount);

  const id = `session-${Date.now()}-${++sessionCounter}`;
  const title = `${labelBase} · ${typeCount}`;

  return { id, type, title, command };
}

function spawnShell(command, cols, rows, cwd) {
  const env = { ...process.env };

  // Add common node binary paths to PATH for CLIs installed via npm/nvm
  const homeDir = require('os').homedir();
  const fs = require('fs');
  const pathSeparator = process.platform === 'win32' ? ';' : ':';

  const additionalPaths = [];

  // Unix-like systems (Linux/macOS)
  if (process.platform !== 'win32') {
    const nvmPath = path.join(homeDir, '.nvm/versions/node');
    const npmGlobalPath = path.join(homeDir, '.npm-global/bin');

    additionalPaths.push(npmGlobalPath);

    // Add all nvm node versions bin directories
    if (fs.existsSync(nvmPath)) {
      const nvmBinPaths = fs.readdirSync(nvmPath)
        .map(version => path.join(nvmPath, version, 'bin'))
        .filter(p => fs.existsSync(p));
      additionalPaths.push(...nvmBinPaths);
    }
  }
  // Windows
  else {
    const appDataPath = process.env.APPDATA;
    if (appDataPath) {
      const npmPath = path.join(appDataPath, 'npm');
      if (fs.existsSync(npmPath)) {
        additionalPaths.push(npmPath);
      }
    }
  }

  env.PATH = [...additionalPaths, env.PATH || ''].filter(Boolean).join(pathSeparator);

  const workingDir = cwd || process.cwd();
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : env.SHELL || '/bin/bash';

  const isInteractive = !command || String(command).trim().length === 0;
  let args;
  if (process.platform === 'win32') {
    if (isInteractive) {
      // Launch interactive PowerShell without the startup banner
      args = ['-NoLogo'];
    } else {
      // Run provided command and keep shell open, no banner
      args = ['-NoLogo', '-NoExit', '-Command', `$env:TERM='xterm-256color'; $env:COLORTERM='truecolor'; ${command}`];
    }
  } else {
    // Unix-like
    args = isInteractive ? ['-l'] : ['-l', '-c', command];
  }

  // Prefer ConPTY on Windows 10/11 for proper 256/truecolor support.
  // The previous configuration forced winpty (useConpty: false), which
  // downgrades colors to the 16‑color palette and can shift hues (e.g. orange → bright red).
  // Keep a single code path and let node-pty use ConPTY on Windows.
  return pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: workingDir,
    env: {
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    useConpty: true,
  });
}

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed())
    .forEach((win) => win.webContents.send(channel, payload));
}

function registerDiagnostics(mainWindow) {
  // Only log errors and critical issues
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    // level 2 = error, level 1 = warning
    // Filter out noisy ResizeObserver warnings
    if (message.includes('ResizeObserver loop')) return;
    if (level >= 2) {
      reportError(`renderer: ${message}`);
    }
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    reportError(`preload failure in ${preloadPath}:`, error);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    reportError(`renderer failed to load (${errorCode}) ${errorDescription} @ ${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    reportError('renderer process gone', details);
  });
}

function createWindow() {
  // Use absolute path from project root for the icon
  const iconPath = process.env.ELECTRON_RENDERER_URL
    ? path.join(__dirname, '../../src/renderer/assets/images/app-icon.ico')
    : path.join(__dirname, '../renderer/assets/images/app-icon.ico');

  const icon = nativeImage.createFromPath(iconPath);

  const mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'ClaudeBox',
    icon: icon,
    frame: false,  // Remove default titlebar
    autoHideMenuBar: true,  // Hide the menu bar
    show: false,  // Don't show until ready (prevents flash)
    backgroundColor: '#0d0d0d',  // Match app background
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove the menu bar completely
  mainWindow.setMenuBarVisibility(false);

  // Register zoom keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Handle Ctrl+Plus/Equals for zoom in
    if (input.control && (input.key === '+' || input.key === '=') && input.type === 'keyDown') {
      const currentZoom = mainWindow.webContents.getZoomLevel();
      mainWindow.webContents.setZoomLevel(currentZoom + 0.5);
      event.preventDefault();
    }
    // Handle Ctrl+Minus for zoom out
    else if (input.control && input.key === '-' && input.type === 'keyDown') {
      const currentZoom = mainWindow.webContents.getZoomLevel();
      mainWindow.webContents.setZoomLevel(currentZoom - 0.5);
      event.preventDefault();
    }
    // Handle Ctrl+0 for reset zoom
    else if (input.control && input.key === '0' && input.type === 'keyDown') {
      mainWindow.webContents.setZoomLevel(0);
      event.preventDefault();
    }
  });

  registerDiagnostics(mainWindow);

  // Show window when ready to prevent flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // In development, load from Vite dev server
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // In production, load the built files
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      terminateAllSessions();
    }
  });
}

function terminateSession(session, signal = undefined) {
  if (!session || session.status === 'exited') {
    return;
  }

  try {
    if (session.status === 'exiting') {
      return; // already terminating
    }
    session.status = 'exiting';
    try {
      session.pty.kill(signal);
    } catch (killErr) {
      // Swallow kill errors and mark exited, then broadcast
      session.status = 'exited';
      session.exitCode = -1;
      broadcast('session:exit', { id: session.id, exitCode: session.exitCode });
    }
  } catch (err) {
    reportError(`failed to terminate session ${session?.id}`, err);
    session.status = 'exited';
    session.exitCode = -1;
    broadcast('session:exit', { id: session.id, exitCode: session.exitCode });
  }
}

function terminateAllSessions() {
  if (sessions.size === 0) {
    return;
  }

  sessions.forEach((session) => {
    terminateSession(session);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('session:create', (_event, { type, cwd }) => {
    try {
      const initialSize = { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS };
      const meta = buildSessionMetadata(type);
      const sessionCwd = cwd || process.cwd();
      const ptyProcess = spawnShell(meta.command, initialSize.cols, initialSize.rows, sessionCwd);

      const session = {
        ...meta,
        status: 'running',
        createdAt: new Date().toISOString(),
        cwd: sessionCwd,
        pty: ptyProcess,
        exitCode: null,
      };

      sessions.set(meta.id, session);

      ptyProcess.onData((data) => {
        broadcast('session:data', { id: meta.id, data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        session.status = 'exited';
        session.exitCode = typeof exitCode === 'number' ? exitCode : null;
        broadcast('session:exit', { id: meta.id, exitCode: session.exitCode });
      });

      return {
        id: session.id,
        type: session.type,
        title: session.title,
        status: session.status,
        command: session.command,
        createdAt: session.createdAt,
        cwd: session.cwd,
      };
    } catch (error) {
      reportError('failed to create session', error);
      dialog.showErrorBox('Failed to start session', error.message);
      throw error;
    }
  });

  ipcMain.handle('session:list', () => {
    return Array.from(sessions.values()).map((session) => ({
      id: session.id,
      type: session.type,
      title: session.title,
      status: session.status,
      command: session.command,
      createdAt: session.createdAt,
      cwd: session.cwd,
      exitCode: session.exitCode,
    }));
  });

  ipcMain.handle('session:write', (_event, { id, data }) => {
    const session = sessions.get(id);
    if (!session || session.status !== 'running') {
      return;
    }

    session.pty.write(data);
  });

  ipcMain.handle('session:resize', (_event, { id, cols, rows }) => {
    const session = sessions.get(id);
    if (!session || session.status !== 'running') {
      return;
    }

    try {
      session.pty.resize(Math.max(MIN_TERMINAL_COLS, cols), Math.max(MIN_TERMINAL_ROWS, rows));
    } catch (error) {
      // Silently ignore resize errors
    }
  });

  ipcMain.handle('session:terminate', (_event, { id }) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }

    terminateSession(session);
  });

  ipcMain.handle('session:dispose', (_event, { id }) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }

    const sessionType = session.type;
    if (session.status === 'running') {
      terminateSession(session);
    }
    sessions.delete(id);

    // Reset counter if no more sessions of this type exist
    const hasRemainingOfType = Array.from(sessions.values()).some(s => s.type === sessionType);
    if (!hasRemainingOfType) {
      sessionCounterByType.set(sessionType, 0);
    }
  });

  ipcMain.handle('session:rename', (_event, { id, newTitle }) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }

    session.title = newTitle;
    return { id, title: newTitle };
  });

  // Window control handlers
  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.minimize();
    }
  });

  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.restore();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
    }
  });

  // Directory selection dialog
  ipcMain.handle('dialog:selectDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return null;
    }

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // Open an external terminal window at a directory
  ipcMain.handle('terminal:open', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();

      if (process.platform === 'win32') {
        // Prefer PowerShell in a new window via cmd's start
        // start "" powershell -NoExit -Command "Set-Location -LiteralPath 'path'"
        const cmd = 'cmd.exe';
        const args = ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', `Set-Location -LiteralPath \"${targetDir.replace(/\\/g, '\\\\')}\"`];
        spawn(cmd, args, { detached: true, windowsHide: false });
        return true;
      }

      if (process.platform === 'darwin') {
        // Open macOS Terminal at directory
        spawn('open', ['-a', 'Terminal', targetDir], { detached: true });
        return true;
      }

      // Linux: try common terminals
      const trySpawn = (bin, args = []) => new Promise((resolve) => {
        const p = spawn(bin, args, { detached: true });
        p.on('error', () => resolve(false));
        // Resolve after short delay; if it didn't error, assume ok
        setTimeout(() => resolve(true), 50);
      });

      const attempts = [
        () => trySpawn('x-terminal-emulator', ['--working-directory', targetDir]),
        () => trySpawn('gnome-terminal', ['--working-directory', targetDir]),
        () => trySpawn('konsole', ['--workdir', targetDir]),
        () => trySpawn('xfce4-terminal', ['--working-directory', targetDir]),
        () => trySpawn('xterm', ['-e', `bash -lc \"cd \"${targetDir}\"; exec bash\"`]),
      ];

      for (const attempt of attempts) {
        // eslint-disable-next-line no-await-in-loop
        if (await attempt()) return true;
      }

      throw new Error('No supported terminal found');
    } catch (error) {
      reportError('failed to open external terminal', error);
      dialog.showErrorBox('Open Terminal Failed', error.message);
      throw error;
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    terminateAllSessions();
    app.quit();
  }
});

app.on('before-quit', () => {
  terminateAllSessions();
});

// Disable GPU process crash handling (common Windows issue with some drivers)
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.samkl.claudebox');
  }

  createWindow();
  registerIpcHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
