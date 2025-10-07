const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

// Force node-pty to use winpty instead of conpty (conpty.node was not built)
process.env.FORCE_WINPTY = '1';
const pty = require('node-pty');

const sessions = new Map();
let sessionCounter = 0;
const sessionCounterByType = new Map([
  ['claude', 0],
  ['codex', 0],
]);

const CLAUDE_COMMAND = 'claude --dangerously-skip-permissions';
const CODEX_COMMAND = 'codex --dangerously-bypass-approvals-and-sandbox';

const log = (...args) => console.log('[main]', ...args);
const warn = (...args) => console.warn('[main]', ...args);
const reportError = (...args) => console.error('[main]', ...args);

function buildSessionMetadata(type) {
  if (!['claude', 'codex'].includes(type)) {
    throw new Error(`Unsupported session type: ${type}`);
  }

  const command = type === 'claude' ? CLAUDE_COMMAND : CODEX_COMMAND;
  const labelBase = type === 'claude' ? 'Claude' : 'Codex';
  const typeCount = (sessionCounterByType.get(type) ?? 0) + 1;
  sessionCounterByType.set(type, typeCount);

  const id = `session-${Date.now()}-${++sessionCounter}`;
  const title = `${labelBase} [${typeCount}]`;

  return { id, type, title, command };
}

function spawnShell(command, cols, rows) {
  const env = { ...process.env };
  const cwd = process.cwd();
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : env.SHELL || '/bin/bash';

  const args = process.platform === 'win32'
    ? ['-NoExit', '-Command', command]
    : ['-l', '-c', command];

  return pty.spawn(shell, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env,
    useConpty: false,  // Force winpty (conpty.node was not built)
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
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'ClaudeBox',
    autoHideMenuBar: true,  // Hide the menu bar
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove the menu bar completely
  mainWindow.setMenuBarVisibility(false);

  registerDiagnostics(mainWindow);

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
  ipcMain.handle('session:create', (_event, { type }) => {
    log(`session:create requested (${type})`);

    try {
      const initialSize = { cols: 100, rows: 30 };
      const meta = buildSessionMetadata(type);
      const ptyProcess = spawnShell(meta.command, initialSize.cols, initialSize.rows);

      const session = {
        ...meta,
        status: 'running',
        createdAt: new Date().toISOString(),
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
      session.pty.resize(Math.max(10, cols), Math.max(5, rows));
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

    terminateSession(session);
    sessions.delete(id);
    log(`session ${id} disposed`);
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
