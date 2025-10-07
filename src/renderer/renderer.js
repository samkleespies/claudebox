import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const SYSTEM_PREFIX = '\r\n[ClaudeBox] ';
const API_POLL_INTERVAL_MS = 50;
const API_TIMEOUT_MS = 5000;

// Mock API for browser development/testing (when not in Electron)
function createMockAPI() {
  console.log('[renderer] Creating mock API for browser testing');
  const mockSessions = new Map();
  let sessionCounter = 0;

  return {
    createSession: async (type) => {
      const id = `mock-session-${++sessionCounter}`;
      const session = {
        id,
        type,
        title: `${type === 'claude' ? 'Claude' : 'Codex'} Session ${sessionCounter}`,
        status: 'running',
        command: type === 'claude' ? 'claude --dangerously-skip-permissions' : 'codex --dangerously-bypass-approvals-and-sandbox',
        createdAt: new Date().toISOString()
      };
      mockSessions.set(id, session);

      // Simulate some output
      setTimeout(() => {
        const dataHandler = window._mockDataHandler;
        if (dataHandler) {
          dataHandler({ id, data: `\r\n[Mock ${type}] Session started in browser mode\r\n` });
          dataHandler({ id, data: `[Mock ${type}] This is a mock session for UI testing\r\n` });
          dataHandler({ id, data: `[Mock ${type}] In Electron, this would connect to real ${type}\r\n` });
        }
      }, 100);

      return session;
    },
    listSessions: async () => Array.from(mockSessions.values()),
    write: async (id, data) => {
      console.log(`[mock] write to ${id}:`, data);
    },
    resize: async (id, cols, rows) => {
      console.log(`[mock] resize ${id}:`, cols, rows);
    },
    terminate: async (id) => {
      const session = mockSessions.get(id);
      if (session) {
        setTimeout(() => {
          const exitHandler = window._mockExitHandler;
          if (exitHandler) {
            exitHandler({ id, exitCode: 0 });
          }
        }, 100);
      }
    },
    dispose: async (id) => {
      mockSessions.delete(id);
    },
    onSessionData: (callback) => {
      window._mockDataHandler = callback;
      return () => { window._mockDataHandler = null; };
    },
    onSessionExit: (callback) => {
      window._mockExitHandler = callback;
      return () => { window._mockExitHandler = null; };
    }
  };
}

function waitForApi(timeoutMs = API_TIMEOUT_MS) {
  // If already available, return immediately
  if (window.claudebox) {
    return Promise.resolve(window.claudebox);
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.claudebox) {
        clearInterval(timer);
        resolve(window.claudebox);
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        // In browser mode, use mock API instead of rejecting
        console.warn('[renderer] Electron API not found, using mock API for browser testing');
        resolve(createMockAPI());
      }
    }, API_POLL_INTERVAL_MS);
  });
}

function renderFatalError(message) {
  console.error('[renderer]', message);
  const statusBar = document.getElementById('statusBar');
  if (statusBar) {
    statusBar.textContent = message;
    statusBar.style.color = '#fca5a5';
  }
  const emptyState = document.getElementById('emptyState');
  if (emptyState) {
    emptyState.classList.remove('hidden');
    emptyState.innerHTML = `<h3>Startup Error</h3><p>${message}</p>`;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  let api;
  try {
    api = await waitForApi();
  } catch (error) {
    renderFatalError(error.message);
    return;
  }

  const {
    createSession,
    listSessions,
    write,
    resize,
    terminate,
    dispose,
    onSessionData,
    onSessionExit,
  } = api;

  const elements = {
    sessionListEl: document.getElementById('sessionList'),
    newClaudeButton: document.getElementById('newClaude'),
    newCodexButton: document.getElementById('newCodex'),
    sessionTitleEl: document.getElementById('sessionTitle'),
    terminalHostEl: document.getElementById('terminal'),
    emptyStateEl: document.getElementById('emptyState'),
  };

  if (!Object.values(elements).every(Boolean)) {
    renderFatalError('Renderer UI failed to load expected elements.');
    return;
  }

  const terminal = new Terminal({
    allowProposedApi: true,
    convertEol: true,
    drawBoldTextInBrightColors: true,
    theme: {
      background: '#0d0d0d',
      foreground: '#e8e8e8',
      cursor: '#ff6b35',
      cursorAccent: '#0d0d0d',
      selectionBackground: 'rgba(255, 107, 53, 0.3)',
      black: '#000000',
      red: '#ff6b6b',
      green: '#51cf66',
      yellow: '#ffd93d',
      blue: '#74c0fc',
      magenta: '#da77f2',
      cyan: '#11A8CD',
      white: '#E5E5E5',
      brightBlack: '#666666',
      brightRed: '#F14C4C',
      brightGreen: '#23D18B',
      brightYellow: '#F5F543',
      brightBlue: '#3B8EEA',
      brightMagenta: '#D670D6',
      brightCyan: '#29B8DB',
      brightWhite: '#E5E5E5',
    },
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    smoothScrollDuration: 50,
    minimumContrastRatio: 4.5,
    fontWeight: 300,
    fontWeightBold: 600,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(elements.terminalHostEl);
  terminal.focus();
  window.requestAnimationFrame(() => fitAddon.fit());

  // Debug mode toggle (Ctrl+Shift+D)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      document.body.classList.toggle('debug-mode');
      const isDebug = document.body.classList.contains('debug-mode');
      console.log(`Debug mode: ${isDebug ? 'ON' : 'OFF'}`);

      if (isDebug) {
        const terminalHost = elements.terminalHostEl;
        const viewport = terminalHost.querySelector('.xterm-viewport');
        const screen = terminalHost.querySelector('.xterm-screen');

        console.log('=== TERMINAL LAYOUT DIAGNOSTICS ===');
        console.log('terminal-host:', {
          offsetWidth: terminalHost.offsetWidth,
          clientWidth: terminalHost.clientWidth,
          scrollWidth: terminalHost.scrollWidth
        });

        if (viewport) {
          console.log('xterm-viewport:', {
            offsetWidth: viewport.offsetWidth,
            clientWidth: viewport.clientWidth,
            scrollWidth: viewport.scrollWidth
          });
        }

        if (screen) {
          console.log('xterm-screen:', {
            offsetWidth: screen.offsetWidth,
            clientWidth: screen.clientWidth,
            scrollWidth: screen.scrollWidth
          });
        }
      }
    }
  });

  const state = {
    sessions: [],
    activeSessionId: null,
    debugStartTime: Date.now(),
  };

  const disposerFns = [];

  const findSession = (id) => state.sessions.find((session) => session.id === id);

  function setStatusBar(message, isError = false) {
    // Status bar removed - keeping function for compatibility
  }

  function updateEmptyState() {
    if (state.activeSessionId) {
      elements.emptyStateEl.classList.add('hidden');
    } else {
      elements.emptyStateEl.classList.remove('hidden');
    }
  }

  function setActionButtonsDisabled(disabled) {
    elements.newClaudeButton.disabled = disabled;
    elements.newCodexButton.disabled = disabled;
  }

  function renderSessionList() {
    elements.sessionListEl.innerHTML = '';

    state.sessions.forEach((session) => {
      const li = document.createElement('li');
      li.className = 'session-item';

      if (session.id === state.activeSessionId) {
        li.classList.add('active');
      }

      if (session.hasActivity && session.id !== state.activeSessionId) {
        li.classList.add('unread');
      }

      const meta = document.createElement('div');
      meta.className = 'session-item__meta';

      const title = document.createElement('p');
      title.className = 'session-item__title';
      title.textContent = session.title;

      const subtitle = document.createElement('p');
      subtitle.className = 'session-item__subtitle';
      subtitle.textContent = `${session.type === 'claude' ? 'Claude' : 'Codex'} - ${new Date(session.createdAt).toLocaleTimeString()}`;

      meta.appendChild(title);
      meta.appendChild(subtitle);

      const status = document.createElement('span');
      status.className = 'session-item__status';
      status.textContent = session.status === 'running' ? 'Live' : session.status === 'exited' ? 'Exited' : 'Stopping';

      if (session.status === 'running') {
        status.classList.add('session-item__status--running');
      } else if (session.status === 'exited') {
        status.classList.add('session-item__status--exited');
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-item__delete';
      deleteBtn.innerHTML = '🗑️';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (session.status === 'running') {
          await terminate(session.id);
        }
        await dispose(session.id);
        removeSessionFromState(session.id);
      });

      li.appendChild(meta);
      li.appendChild(status);
      li.appendChild(deleteBtn);

      li.addEventListener('click', () => {
        if (session.id !== state.activeSessionId) {
          setActiveSession(session.id);
        }
      });

      elements.sessionListEl.appendChild(li);
    });
  }

  function updateWorkspaceHeader() {
    const active = state.activeSessionId ? findSession(state.activeSessionId) : null;

    if (!active) {
      elements.sessionTitleEl.textContent = 'No session selected';
      return;
    }

    elements.sessionTitleEl.textContent = active.title;
  }

  function appendToSessionBuffer(id, data) {
    const session = findSession(id);
    if (!session) {
      return;
    }

    session.buffer = (session.buffer || '') + data;

    if (state.activeSessionId === id) {
      terminal.write(data);
    } else {
      session.hasActivity = true;
      renderSessionList();
    }
  }

  function fitAndNotify() {
    try {
      fitAddon.fit();
    } catch (error) {
      console.warn('[renderer] fit failed', error);
    }

    const activeId = state.activeSessionId;
    if (activeId) {
      resize(activeId, terminal.cols, terminal.rows);
    }
  }

  function setActiveSession(id) {
    const session = findSession(id);
    if (!session) {
      return;
    }

    state.activeSessionId = id;
    session.hasActivity = false;

    terminal.reset();
    terminal.write(session.buffer || '');
    terminal.focus();
    fitAndNotify();
    renderSessionList();
    updateWorkspaceHeader();
    updateEmptyState();
    setStatusBar(`${session.title} ready.`);
  }

  function addSession(sessionInfo) {
    const session = {
      ...sessionInfo,
      buffer: '',
      hasActivity: false,
    };

    state.sessions.push(session);
    renderSessionList();
    setActiveSession(session.id);
    setStatusBar(`${session.title} started.`);
  }

  function removeSessionFromState(id) {
    const idx = state.sessions.findIndex((session) => session.id === id);
    if (idx === -1) {
      return;
    }

    const wasActive = state.activeSessionId === id;
    state.sessions.splice(idx, 1);

    if (wasActive) {
      state.activeSessionId = state.sessions.at(-1)?.id ?? null;
      if (state.activeSessionId) {
        setActiveSession(state.activeSessionId);
      } else {
        terminal.reset();
        updateWorkspaceHeader();
        updateEmptyState();
      }
    }

    renderSessionList();
  }

  async function handleCreateSession(type) {
    console.log('[renderer] creating session', type);
    setActionButtonsDisabled(true);

    try {
      const session = await createSession(type);
      addSession(session);
    } catch (error) {
      console.error('[renderer] Failed to create session', error);
      const message = error?.message ?? 'Unknown error';
      alert(`Could not start the session. ${message}`);
    } finally {
      setActionButtonsDisabled(false);
    }
  }


  const resizeObserver = new ResizeObserver(() => fitAndNotify());
  resizeObserver.observe(elements.terminalHostEl);
  window.addEventListener('resize', () => fitAndNotify());

  terminal.onData((data) => {
    const activeId = state.activeSessionId;
    if (!activeId) {
      return;
    }
    write(activeId, data);
  });

  elements.newClaudeButton.addEventListener('click', () => handleCreateSession('claude'));
  elements.newCodexButton.addEventListener('click', () => handleCreateSession('codex'));

  disposerFns.push(onSessionData(({ id, data }) => {
    // Debug: log all data for the first 30 seconds with hex dump
    if (Date.now() - state.debugStartTime < 30000) {
      const visible = data.replace(/\x1b/g, '\\x1b');
      const hex = Array.from(data).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');

      // Always log if contains "bypass" or "Claude Code"
      if (visible.includes('bypass') || visible.includes('Claude Code') || visible.includes('▐▛███▜▌')) {
        console.log('[DATA-HEX]', hex.substring(0, 300));
        console.log('[DATA-STR]', visible.substring(0, 200));
      }
    }
    appendToSessionBuffer(id, data);
  }));

  disposerFns.push(onSessionExit(({ id, exitCode }) => {
    const session = findSession(id);
    if (!session) {
      return;
    }

    renderSessionList();
    updateWorkspaceHeader();

    if (state.activeSessionId === id) {
      setStatusBar(`${session.title} exited${session.exitCode != null ? ` with code ${session.exitCode}` : ''}.`);
    }
  }));

  window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    disposerFns.forEach((disposeListener) => {
      try {
        disposeListener?.();
      } catch (error) {
        console.warn('[renderer] error cleaning listener', error);
      }
    });
    terminal.dispose();
  });

  try {
    const runningSessions = await listSessions();
    runningSessions.forEach((session) => addSession(session));
    if (runningSessions.length === 0) {
      updateWorkspaceHeader();
      updateEmptyState();
    }
  } catch (error) {
    console.error('[renderer] Failed to load existing sessions', error);
    setStatusBar('Unable to load existing sessions.', true);
  }

  updateWorkspaceHeader();
  updateEmptyState();
  setStatusBar('Ready.');
});
