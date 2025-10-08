const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

// Configuration constants
const CLAUDE_COMMAND = 'claude --dangerously-skip-permissions';
const CODEX_COMMAND = 'codex --dangerously-bypass-approvals-and-sandbox';

// Window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 820;
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 600;

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
]);

const log = (...args) => console.log('[main]', ...args);
const warn = (...args) => console.warn('[main]', ...args);
const reportError = (...args) => console.error('[main]', ...args);

function buildSessionMetadata(type) {
  if (!['claude', 'codex'].includes(type)) {
    throw new Error(`Unsupported session type: ${type}`);
  }

  const command = type === 'claude' ? CLAUDE_COMMAND : CODEX_COMMAND;
  const labelBase = type === 'claude' ? 'Claude Code' : 'Codex';
  const typeCount = (sessionCounterByType.get(type) ?? 0) + 1;
  sessionCounterByType.set(type, typeCount);

  const id = `session-${Date.now()}-${++sessionCounter}`;
  const title = `${labelBase} · ${typeCount}`;

  return { id, type, title, command };
}

function spawnShell(command, cols, rows, cwd) {
  const env = { ...process.env };
  const workingDir = cwd || process.cwd();
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : env.SHELL || '/bin/bash';

  // For Windows, prepend environment variable setting to the command
  const args = process.platform === 'win32'
    ? ['-NoExit', '-Command', `$env:TERM='xterm-256color'; $env:COLORTERM='truecolor'; ${command}`]
    : ['-l', '-c', command];

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
    useConpty: false,
  });
}

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed())
    .forEach((win) => win.webContents.send(channel, payload));
}

function registerDiagnostics(mainWindow) {
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log(`renderer console(${level}): ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    reportError(`preload failure in ${preloadPath}:`, error);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    reportError(`renderer failed to load (${errorCode}) ${errorDescription} @ ${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    warn('renderer process gone', details);
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
    log(`terminating session ${session.id} (signal=${signal})`);
    session.status = 'exiting';
    session.pty.kill(signal);
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

  log('terminating all sessions');
  sessions.forEach((session) => {
    terminateSession(session);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('session:create', (_event, { type, cwd }) => {
    log(`session:create requested (${type})`);

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
      log(`session ${session.id} started (type=${session.type}) pid=${session.pty?.pid}`);

      ptyProcess.onData((data) => {
        broadcast('session:data', { id: meta.id, data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        session.status = 'exited';
        session.exitCode = typeof exitCode === 'number' ? exitCode : null;
        log(`session ${session.id} exited with code ${session.exitCode}`);
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
      warn(`resize failed for session ${id}`, error);
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
    terminateSession(session);
    sessions.delete(id);
    log(`session ${id} disposed`);

    // Reset counter if no more sessions of this type exist
    const hasRemainingOfType = Array.from(sessions.values()).some(s => s.type === sessionType);
    if (!hasRemainingOfType) {
      sessionCounterByType.set(sessionType, 0);
      log(`reset ${sessionType} counter to 0`);
    }
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
