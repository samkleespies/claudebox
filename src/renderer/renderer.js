import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const API_POLL_INTERVAL_MS = 50;
const API_TIMEOUT_MS = 5000;

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
        reject(new Error('Electron API not available'));
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
    renameSession,
    onSessionData,
    onSessionExit,
    checkToolInstalled,
    installTool,
    windowMinimize,
    windowMaximize,
    windowClose,
    selectDirectory,
    openExternalTerminal,
  } = api;

  // Window control buttons
  const minimizeBtn = document.getElementById('minimizeBtn');
  const maximizeBtn = document.getElementById('maximizeBtn');
  const closeBtn = document.getElementById('closeBtn');

  if (minimizeBtn && windowMinimize) {
    minimizeBtn.addEventListener('click', () => windowMinimize());
  }
  if (maximizeBtn && windowMaximize) {
    maximizeBtn.addEventListener('click', () => windowMaximize());
  }
  if (closeBtn && windowClose) {
    closeBtn.addEventListener('click', () => windowClose());
  }

  const elements = {
    sessionListEl: document.getElementById('sessionList'),
    newClaudeButton: document.getElementById('newClaude'),
    newCodexButton: document.getElementById('newCodex'),
    newOpenCodeButton: document.getElementById('newOpenCode'),
    newTerminalButton: document.getElementById('newTerminal'),
    sessionDirInput: document.getElementById('sessionDir'),
    browseDirButton: document.getElementById('browseDirBtn'),
    terminalHostEl: document.getElementById('terminal'),
    emptyStateEl: document.getElementById('emptyState'),
    sidebar: document.querySelector('.sidebar'),
    sidebarResizer: document.getElementById('sidebarResizer'),
    sidebarToggle: document.getElementById('sidebarToggle'),
    sidebarToggleWorkspace: document.getElementById('sidebarToggleWorkspace'),
  };

  if (!Object.values(elements).every(Boolean)) {
    renderFatalError('Renderer UI failed to load expected elements.');
    return;
  }

  // Initialize CSS custom property for current sidebar width
  try {
    const initialWidth = Math.round(elements.sidebar.offsetWidth);
    elements.sidebar.style.setProperty('--sidebar-width', `${initialWidth}px`);
  } catch (_) {
    // no-op; safe default remains in CSS
  }

  // Windows 11 uses piecewise sRGB color curve while Linux/Mac use gamma 2.2.
  // This causes minimumContrastRatio to calculate luminance differently and shift colors.
  // On Windows, disable contrast adjustment to match Linux/Mac color rendering.
  const isWindows = navigator.platform.toLowerCase().includes('win');

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
    scrollback: 2000,
    smoothScrollDuration: 50,
    // Disable contrast adjustment on Windows due to gamma/sRGB differences
    minimumContrastRatio: isWindows ? 1 : 4.5,
    fontWeight: 300,
    fontWeightBold: 600,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(elements.terminalHostEl);
  terminal.blur(); // Don't focus terminal until a session starts
  window.requestAnimationFrame(() => fitAddon.fit());

  const state = {
    sessions: [],
    activeSessionId: null,
  };

  const disposerFns = [];

  const findSession = (id) => state.sessions.find((session) => session.id === id);

  function updateEmptyState() {
    if (state.activeSessionId) {
      elements.emptyStateEl.classList.add('hidden');
      elements.terminalHostEl.classList.remove('no-session');
    } else {
      elements.emptyStateEl.classList.remove('hidden');
      elements.terminalHostEl.classList.add('no-session');
    }
  }

  function setActionButtonsDisabled(disabled) {
    elements.newClaudeButton.disabled = disabled;
    elements.newCodexButton.disabled = disabled;
    elements.newOpenCodeButton.disabled = disabled;
    elements.newTerminalButton.disabled = disabled;
  }

  function renderSessionList() {
    elements.sessionListEl.innerHTML = '';

    state.sessions.forEach((session) => {
      const li = document.createElement('li');
      li.className = 'session-item';

      // Add session type class
      li.classList.add(`session-item--${session.type}`);

      if (session.id === state.activeSessionId) {
        li.classList.add('active');
      }

      if (session.hasActivity && session.id !== state.activeSessionId) {
        li.classList.add('unread');
      }

      const meta = document.createElement('div');
      meta.className = 'session-item__meta';

      // Create title wrapper with icon
      const titleWrapper = document.createElement('div');
      titleWrapper.className = 'session-item__title-wrapper';

      const icon = document.createElement('img');
      icon.className = 'session-item__icon';
      let iconSrc = './images/gpt-icon.svg';
      if (session.type === 'claude') {
        iconSrc = './images/claude-icon.svg';
      } else if (session.type === 'opencode') {
        iconSrc = './images/opencode-logo.svg';
      } else if (session.type === 'terminal') {
        iconSrc = './images/terminal-icon.svg';
      }
      icon.src = iconSrc;
      icon.alt = `${session.type} icon`;

      const title = document.createElement('p');
      title.className = 'session-item__title';
      title.textContent = session.title;

      // Add double-click to rename functionality
      title.addEventListener('dblclick', async (e) => {
        e.stopPropagation();

        const currentTitle = session.title;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentTitle;
        input.className = 'session-item__title-input';
        input.spellcheck = false;

        // Set dynamic width based on text content
        const measureText = (text) => {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          context.font = getComputedStyle(input).font;
          return Math.ceil(context.measureText(text || 'a').width);
        };

        const updateWidth = () => {
          const textWidth = measureText(input.value);
          input.style.width = `${textWidth}px`;
        };

        // Replace title with input
        title.style.display = 'none';
        titleWrapper.insertBefore(input, title);

        // Set initial width after element is in DOM
        updateWidth();

        input.focus();
        input.select();

        // Update width as user types
        input.addEventListener('input', updateWidth);

        const finishEditing = async (save) => {
          if (save && input.value.trim() && input.value !== currentTitle) {
            const newTitle = input.value.trim();
            try {
              await renameSession(session.id, newTitle);
              session.title = newTitle;
              title.textContent = newTitle;
            } catch (error) {
              console.error('[renderer] Failed to rename session', error);
              title.textContent = currentTitle;
            }
          }
          input.remove();
          title.style.display = '';
        };

        input.addEventListener('blur', () => finishEditing(true));
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            finishEditing(true);
          } else if (event.key === 'Escape') {
            finishEditing(false);
          }
        });
      });

      titleWrapper.appendChild(icon);
      titleWrapper.appendChild(title);

      const path = document.createElement('p');
      path.className = 'session-item__path';
      path.textContent = session.cwd || '';

      meta.appendChild(titleWrapper);
      meta.appendChild(path);

      const statusColumn = document.createElement('div');
      statusColumn.className = 'session-item__status-column';

      const timestamp = document.createElement('span');
      timestamp.className = 'session-item__timestamp';
      const timeStr = new Date(session.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      timestamp.textContent = timeStr;

      const status = document.createElement('span');
      status.className = 'session-item__status';

      // Activity-aware status display
      if (session.status === 'running') {
        const activityLabels = {
          idle: 'Idle',
          thinking: 'Thinking',
          working: 'Working',
          responding: 'Responding'
        };
        status.textContent = activityLabels[session.activityState] || 'Idle';
        status.classList.add('session-item__status--running');

        // Add activity-specific class for animations
        if (session.activityState !== 'idle') {
          status.classList.add(`session-item__status--${session.activityState}`);
        }
      } else if (session.status === 'exited') {
        status.textContent = 'Exited';
        status.classList.add('session-item__status--exited');
      } else {
        status.textContent = 'Stopping';
      }

      statusColumn.appendChild(status);
      statusColumn.appendChild(timestamp);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-item__delete';
      deleteBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M5.5 1.5h5M2 4h12M3.5 4l.5 9.5a1 1 0 001 1h6a1 1 0 001-1L13 4M6.5 7v4M9.5 7v4"
                stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await dispose(session.id);
        } finally {
          removeSessionFromState(session.id);
        }
      });

      li.appendChild(meta);
      li.appendChild(statusColumn);
      li.appendChild(deleteBtn);

      li.addEventListener('click', () => {
        if (session.id !== state.activeSessionId) {
          setActiveSession(session.id);
        }
      });

      elements.sessionListEl.appendChild(li);
    });
  }

  function appendToSessionBuffer(id, data) {
    const session = findSession(id);
    if (!session) {
      return;
    }

    session.buffer = (session.buffer || '') + data;

    // Detect activity state from terminal output for all sessions
    updateSessionActivity(session, data);

    if (state.activeSessionId === id) {
      terminal.write(data);
    } else {
      session.hasActivity = true;
      updateActiveSessionUI();
    }
  }

  // Coalesce frequent fit requests (e.g., during sidebar drag) to one per frame
  let fitPending = false;
  function fitAndNotify() {
    if (fitPending) return;
    fitPending = true;
    window.requestAnimationFrame(() => {
      fitPending = false;
      try {
        fitAddon.fit();
      } catch (error) {
        // Silently ignore fit errors
      }

      const activeId = state.activeSessionId;
      if (activeId) {
        try {
          resize(activeId, terminal.cols, terminal.rows);
        } catch (_) {
          // ignore
        }
      }
    });
  }

  function setActiveSession(id) {
    const session = findSession(id);
    if (!session) {
      return;
    }

    state.activeSessionId = id;
    session.hasActivity = false;

    // Reset activity tracking when switching to this session
    // Any new activity will be detected in real-time
    session.activityState = 'idle';
    session.recentChunks = [];
    if (session.activityTimeout) {
      clearTimeout(session.activityTimeout);
      session.activityTimeout = null;
    }

    terminal.reset();
    terminal.write(session.buffer || '');
    terminal.focus();
    fitAndNotify();
    renderSessionList();
    updateEmptyState();
  }

  function updateSessionStatus(session) {
    // Find the session's index and DOM element
    const sessionIndex = state.sessions.indexOf(session);
    if (sessionIndex === -1) return;

    const sessionElement = elements.sessionListEl.children[sessionIndex];
    if (!sessionElement) return;

    // Update only the status element
    const statusEl = sessionElement.querySelector('.session-item__status');
    if (!statusEl) return;

    // Remove all activity state classes
    statusEl.classList.remove(
      'session-item__status--thinking',
      'session-item__status--working',
      'session-item__status--responding'
    );

    // Add new state class if not idle
    if (session.activityState !== 'idle') {
      statusEl.classList.add(`session-item__status--${session.activityState}`);
    }

    // Update text content
    const statusLabels = {
      idle: 'Idle',
      thinking: 'Thinking',
      working: 'Working',
      responding: 'Responding',
    };
    statusEl.textContent = statusLabels[session.activityState] || 'Idle';
  }

  function updateSessionActivity(session, data) {
    // Terminal sessions don't have AI activity - skip detection
    if (session.type === 'terminal') {
      return;
    }

    const timestamp = Date.now();

    // Add chunk to rolling window
    session.recentChunks.push({ data, timestamp });

    // Remove chunks older than window (keep last 1 second)
    const cutoff = timestamp - session.chunkWindowMs;
    session.recentChunks = session.recentChunks.filter(c => c.timestamp > cutoff);

    // Aggregate recent chunks for pattern matching
    const aggregatedData = session.recentChunks.map(c => c.data).join('');

    // Strip ANSI codes and clean up the aggregated data
    const cleanData = aggregatedData
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // Remove ANSI escape codes
      .replace(/\x1b\][0-9;]*\x07/g, '')      // Remove OSC sequences
      .replace(/\r/g, '')                      // Remove carriage returns
      .trim();

    // Skip if it's just whitespace or empty after cleaning
    if (!cleanData) return;

    // SIMPLIFIED: Only detect activity spinner characters
    let newState = session.activityState;
    let confidence = 0;

    // Check for activity indicators:
    // Claude Code: ✽✦✧✨
    // Codex: ◦•
    if (/[✽✦✧✨◦•]/.test(cleanData)) {
      newState = 'working';
      confidence = 0.9;
    }

    // Only update if state changed with sufficient confidence
    const minConfidence = 0.5;

    // Valid state transitions (prevents illogical jumps)
    const validTransitions = {
      idle: ['thinking', 'working', 'responding'],
      thinking: ['working', 'responding', 'idle'],
      working: ['responding', 'thinking', 'idle'],
      responding: ['idle', 'thinking', 'working'],
    };

    // Check if transition is valid
    const canTransition = validTransitions[session.activityState]?.includes(newState) || newState === session.activityState;

    if (newState !== session.activityState && confidence >= minConfidence && canTransition) {
      session.activityState = newState;
      updateSessionStatus(session);
    }

    // Variable timeout based on state
    const stateTimeouts = {
      thinking: 4000,   // Thinking can take a while
      working: 3000,    // Tool execution has gaps
      responding: 2000, // Streaming is more continuous
      idle: 1500,
    };

    // Reset timeout
    if (session.activityTimeout) {
      clearTimeout(session.activityTimeout);
    }

    const timeout = stateTimeouts[session.activityState] || 2000;

    session.activityTimeout = setTimeout(() => {
      if (session.activityState !== 'idle') {
        session.activityState = 'idle';
        updateSessionStatus(session);
      }
    }, timeout);
  }

  function updateActiveSessionUI() {
    // Update active state classes without re-rendering entire list
    const sessionItems = elements.sessionListEl.querySelectorAll('.session-item');
    sessionItems.forEach((item, index) => {
      const session = state.sessions[index];
      if (!session) return;

      if (session.id === state.activeSessionId) {
        item.classList.add('active');
        item.classList.remove('unread');
      } else {
        item.classList.remove('active');
        if (session.hasActivity) {
          item.classList.add('unread');
        } else {
          item.classList.remove('unread');
        }
      }
    });
  }

  function addSession(sessionInfo) {
    const session = {
      ...sessionInfo,
      buffer: '',
      hasActivity: false,
      activityState: 'idle',  // idle | thinking | working | responding
      activityTimeout: null,
      // Chunk aggregation for better pattern detection
      recentChunks: [],
      chunkWindowMs: 1000,  // 1 second context window
    };

    state.sessions.push(session);
    renderSessionList();
    setActiveSession(session.id);
  }

  function removeSessionFromState(id) {
    const idx = state.sessions.findIndex((session) => session.id === id);
    if (idx === -1) {
      return;
    }

    const session = state.sessions[idx];
    const wasActive = state.activeSessionId === id;

    // Clean up activity timeout
    if (session.activityTimeout) {
      clearTimeout(session.activityTimeout);
    }

    state.sessions.splice(idx, 1);

    if (wasActive) {
      state.activeSessionId = state.sessions.at(-1)?.id ?? null;
      if (state.activeSessionId) {
        setActiveSession(state.activeSessionId);
      } else {
        terminal.reset();
        terminal.blur(); // Remove cursor when no sessions
        updateEmptyState();
      }
    }

    renderSessionList();
  }

  function showInstallDialog(toolName, toolType, onInstall, onCancel) {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      animation: fadeIn 0.2s ease-out;
    `;

    // Create modal dialog
    const dialog = document.createElement('div');
    dialog.className = 'install-dialog';
    dialog.style.cssText = `
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      animation: slideUp 0.3s ease-out;
    `;

    const title = document.createElement('h2');
    title.textContent = `Install ${toolName}?`;
    title.style.cssText = `
      margin: 0 0 16px 0;
      color: #ff6b35;
      font-size: 20px;
      font-weight: 600;
    `;

    const message = document.createElement('p');
    message.textContent = `${toolName} is not installed on your system. Would you like to install it now?`;
    message.style.cssText = `
      margin: 0 0 20px 0;
      color: #e8e8e8;
      line-height: 1.5;
    `;

    const installNote = document.createElement('p');
    installNote.textContent = `This will run: npm install -g ${toolType === 'claude' ? '@anthropic-ai/claude-code' : toolType === 'codex' ? '@openai/codex' : 'opencode-ai@latest'}`;
    installNote.style.cssText = `
      margin: 0 0 20px 0;
      color: #999;
      font-size: 12px;
      font-family: monospace;
      background: #0d0d0d;
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px solid #333;
    `;

    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    `;

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      background: #333;
      color: #e8e8e8;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    `;
    cancelBtn.onmouseover = () => cancelBtn.style.background = '#444';
    cancelBtn.onmouseout = () => cancelBtn.style.background = '#333';

    const installBtn = document.createElement('button');
    installBtn.textContent = 'Install';
    installBtn.style.cssText = `
      padding: 8px 16px;
      background: #ff6b35;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: background 0.2s;
    `;
    installBtn.onmouseover = () => installBtn.style.background = '#ff8555';
    installBtn.onmouseout = () => installBtn.style.background = '#ff6b35';

    const progressContainer = document.createElement('div');
    progressContainer.style.cssText = `
      display: none;
      margin-top: 16px;
    `;

    const progressText = document.createElement('p');
    progressText.textContent = 'Installing...';
    progressText.style.cssText = `
      color: #ff6b35;
      margin: 0 0 8px 0;
      font-size: 14px;
    `;

    const progressBar = document.createElement('div');
    progressBar.style.cssText = `
      width: 100%;
      height: 4px;
      background: #333;
      border-radius: 2px;
      overflow: hidden;
    `;

    const progressFill = document.createElement('div');
    progressFill.style.cssText = `
      width: 0%;
      height: 100%;
      background: #ff6b35;
      animation: progress 2s ease-in-out infinite;
    `;

    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressText);
    progressContainer.appendChild(progressBar);

    cancelBtn.onclick = () => {
      document.body.removeChild(overlay);
      onCancel();
    };

    installBtn.onclick = async () => {
      buttonContainer.style.display = 'none';
      progressContainer.style.display = 'block';
      progressFill.style.animation = 'progress 2s ease-in-out infinite';

      await onInstall();

      document.body.removeChild(overlay);
    };

    buttonContainer.appendChild(cancelBtn);
    buttonContainer.appendChild(installBtn);

    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(installNote);
    dialog.appendChild(buttonContainer);
    dialog.appendChild(progressContainer);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Add animation keyframes
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      @keyframes progress {
        0% { transform: translateX(-100%); }
        50% { transform: translateX(100%); }
        100% { transform: translateX(100%); }
      }
    `;
    document.head.appendChild(style);
  }

  async function handleCreateSession(type) {
    setActionButtonsDisabled(true);

    try {
      const cwd = elements.sessionDirInput.value.trim() || undefined;
      const session = await createSession(type, cwd);
      addSession(session);
      // Keep the directory input value for subsequent sessions
    } catch (error) {
      console.error('[renderer] Failed to create session', error);
      const message = error?.message ?? 'Unknown error';

      // Check if it's a tool not installed error
      if (message.startsWith('TOOL_NOT_INSTALLED:')) {
        const [, toolType, toolName] = message.split(':');

        showInstallDialog(
          toolName,
          toolType,
          async () => {
            // Install the tool
            try {
              const result = await installTool(toolType);
              if (result.success) {
                alert(`${toolName} has been successfully installed! You can now start a session.`);
              } else {
                alert(`Failed to install ${toolName}: ${result.error}`);
              }
            } catch (installError) {
              alert(`Failed to install ${toolName}: ${installError.message}`);
            } finally {
              setActionButtonsDisabled(false);
            }
          },
          () => {
            setActionButtonsDisabled(false);
          }
        );
        return; // Don't re-enable buttons here, let the dialog handlers do it
      }

      alert(`Could not start the session. ${message}`);
    } finally {
      setActionButtonsDisabled(false);
    }
  }


  const resizeObserver = new ResizeObserver(() => fitAndNotify());
  resizeObserver.observe(elements.terminalHostEl);

  // Handle keyboard events for Ctrl+C copy and Ctrl+V paste support
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && event.ctrlKey) {
      // Handle Ctrl+C: Copy when there's a selection
      if (event.key === 'c') {
        const selection = terminal.getSelection();
        if (selection) {
          // Copy to clipboard
          navigator.clipboard.writeText(selection).catch(err => {
            console.error('[renderer] Failed to copy to clipboard', err);
          });
          // Prevent the event from being sent to the terminal (preventing SIGTERM)
          return false;
        }
      }
      // Handle Ctrl+V: Paste from clipboard
      else if (event.key === 'v') {
        event.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text && state.activeSessionId) {
            write(state.activeSessionId, text);
          }
        }).catch(err => {
          console.error('[renderer] Failed to read from clipboard', err);
        });
        return false;
      }
    }
    // Allow all other key events to be processed normally
    return true;
  });

  terminal.onData((data) => {
    const activeId = state.activeSessionId;
    if (!activeId) {
      return;
    }
    write(activeId, data);
  });

  // Prevent terminal from being focused when there's no active session
  elements.terminalHostEl.addEventListener('mousedown', (e) => {
    if (!state.activeSessionId) {
      e.preventDefault();
      terminal.blur();
    }
  });

  elements.newClaudeButton.addEventListener('click', () => handleCreateSession('claude'));
  elements.newCodexButton.addEventListener('click', () => handleCreateSession('codex'));
  elements.newOpenCodeButton.addEventListener('click', () => handleCreateSession('opencode'));
  elements.newTerminalButton.addEventListener('click', () => handleCreateSession('terminal'));

  // Directory browse button
  if (elements.browseDirButton && selectDirectory) {
    elements.browseDirButton.addEventListener('click', async () => {
      const selectedPath = await selectDirectory();
      if (selectedPath) {
        elements.sessionDirInput.value = selectedPath;
      }
    });
  }

  // Sidebar toggle functionality
  function toggleSidebar() {
    // Capture current sidebar width so CSS can slide exactly that distance
    const rect = elements.sidebar.getBoundingClientRect();
    elements.sidebar.style.setProperty('--sidebar-width', `${Math.round(rect.width)}px`);

    const currentlyHidden = elements.sidebar.classList.contains('hidden');

    const afterTransition = (el, fn, timeout = 350) => {
      let called = false;
      const handler = (ev) => {
        // Ensure we respond to the transition on the element itself
        if (ev.currentTarget !== el) return;
        if (called) return;
        called = true;
        el.removeEventListener('transitionend', handler);
        fn();
      };
      el.addEventListener('transitionend', handler);
      // Fallback in case transitionend doesn't fire
      setTimeout(() => {
        if (called) return;
        called = true;
        el.removeEventListener('transitionend', handler);
        fn();
      }, timeout);
    };

    if (!currentlyHidden) {
      // Hiding: collapse width smoothly via CSS; resizer auto collapses via CSS rule
      elements.sidebar.classList.add('hidden');
      afterTransition(elements.sidebar, () => {
        // Show floating workspace toggle
        elements.sidebarToggleWorkspace.style.display = 'flex';
        elements.sidebarToggleWorkspace.offsetHeight; // reflow
        elements.sidebarToggleWorkspace.classList.add('visible');
        fitAndNotify();
      });
    } else {
      // Showing: when the floating restore button is clicked, animate it out
      // in reverse while the sidebar slides back in.
      const btn = elements.sidebarToggleWorkspace;
      if (btn && btn.style.display !== 'none') {
        // Start reverse animation (slide left + fade out)
        btn.classList.remove('visible');
        // After its own transition completes, remove from flow
        const onBtnEnd = (ev) => {
          if (ev.target !== btn) return;
          btn.removeEventListener('transitionend', onBtnEnd);
          btn.style.display = 'none';
        };
        btn.addEventListener('transitionend', onBtnEnd, { once: true });
      }

      // Slide the sidebar back in
      elements.sidebar.classList.remove('hidden');
      afterTransition(elements.sidebar, () => {
        fitAndNotify();
      });
    }
  }

  elements.sidebarToggle.addEventListener('click', toggleSidebar);
  elements.sidebarToggleWorkspace.addEventListener('click', toggleSidebar);

  // Sidebar resize functionality
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;
  const DEFAULT_SIDEBAR_WIDTH = 300;
  const MIN_SIDEBAR_WIDTH = 200;
  const MAX_SIDEBAR_WIDTH = 600;
  let preferredSidebarWidth = elements.sidebar.offsetWidth || DEFAULT_SIDEBAR_WIDTH;

  // Helper function to update ASCII logo font size based on sidebar width
  function updateAsciiLogoSize(width) {
    const asciiLogo = document.querySelector('.ascii-logo');
    if (!asciiLogo) return;

    if (width <= 300) {
      // Linear interpolation: 0.32rem at 300px, 0.2rem at 200px
      // Formula: fontSize = 0.2 + (width - 200) * 0.0012
      const fontSize = 0.2 + (width - 200) * 0.0012;
      asciiLogo.style.fontSize = `${fontSize}rem`;
    } else {
      // Above 300px, keep at max size
      asciiLogo.style.fontSize = '0.32rem';
    }
  }

  // Unified setter: used by both manual drag and window-driven adjustments
  function setSidebarWidth(nextWidth, persistPreferred = true) {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(nextWidth)));
    if (persistPreferred) {
      preferredSidebarWidth = clamped;
    }
    elements.sidebar.style.width = `${clamped}px`;
    elements.sidebar.style.setProperty('--sidebar-width', `${clamped}px`);
    updateAsciiLogoSize(clamped);
    fitAndNotify();
  }

  // No longer needed - using CSS container queries instead

  // Double-click to reset sidebar width
  elements.sidebarResizer.addEventListener('dblclick', () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true);
  });

  elements.sidebarResizer.addEventListener('mousedown', (e) => {
    // Prevent double-click from triggering resize
    if (e.detail > 1) return;

    isResizing = true;
    startX = e.clientX;
    startWidth = elements.sidebar.offsetWidth;
    elements.sidebarResizer.classList.add('resizing');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const deltaX = e.clientX - startX;
    const newWidth = startWidth + deltaX;

    // Constrain to min/max width
    const constrainedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth));

    setSidebarWidth(constrainedWidth, true);
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      elements.sidebarResizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // Window-driven sidebar resize using the same code path as manual drag
  // Immediate updates (fit is rAF-coalesced) for snappy behavior
  window.addEventListener('resize', () => {
    if (elements.sidebar.classList.contains('hidden')) {
      elements.sidebarResizer.style.width = '0px';
      elements.sidebarResizer.style.flexBasis = '0';
      return;
    }

    const windowWidth = window.innerWidth;
    const collapseResizer = windowWidth <= MIN_SIDEBAR_WIDTH + 1;
    if (collapseResizer) {
      elements.sidebarResizer.style.width = '0px';
      elements.sidebarResizer.style.flexBasis = '0';
      setSidebarWidth(MIN_SIDEBAR_WIDTH, true);
      return;
    }

    // Normal case: keep resizer visible and set width to the min of preferred and available space
    elements.sidebarResizer.style.width = '1px';
    elements.sidebarResizer.style.flexBasis = '';

    const resizerWidth = elements.sidebarResizer.offsetWidth || 1;
    const available = Math.max(MIN_SIDEBAR_WIDTH, windowWidth - resizerWidth);
    const target = Math.max(MIN_SIDEBAR_WIDTH, Math.min(preferredSidebarWidth, available));
    setSidebarWidth(target, true);
  });

  disposerFns.push(onSessionData(({ id, data }) => {
    appendToSessionBuffer(id, data);
  }));

  disposerFns.push(onSessionExit(({ id }) => {
    const session = findSession(id);
    if (!session) {
      return;
    }

    renderSessionList();
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
      updateEmptyState();
    }
  } catch (error) {
    console.error('[renderer] Failed to load existing sessions', error);
  }

  updateEmptyState();

  // ASCII art animation on boot
  function initializeASCIIAnimation() {
    const asciiLogo = document.querySelector('.ascii-logo');
    if (!asciiLogo) return;

    // Get the original ASCII art text
    const claudeboxArt = [
      " ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗██████╗  ██████╗ ██╗  ██╗",
      "██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝",
      "██║     ██║     ███████║██║   ██║██║  ██║█████╗  ██████╔╝██║   ██║ ╚███╔╝ ",
      "██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ██╔══██╗██║   ██║ ██╔██╗ ",
      "╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗██████╔╝╚██████╔╝██╔╝ ██╗",
      " ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝"
    ];

    // Split the art into individual letters (9 letters in "CLAUDEBOX")
    const letterWidth = 8.25;
    const letters = [];

    // Clear existing content
    asciiLogo.textContent = '';

    for (let i = 0; i < 9; i++) {
      const letterLines = claudeboxArt.map(line => {
        const startIdx = i * letterWidth;
        const endIdx = Math.min(startIdx + letterWidth, line.length);
        return line.substring(startIdx, endIdx);
      });

      const letterElement = document.createElement('span');
      letterElement.className = 'letter';
      letterElement.textContent = letterLines.join('\n');
      letters.push(letterElement);
      asciiLogo.appendChild(letterElement);
    }

    // Wave animation function
    function waveAnimation() {
      letters.forEach((letter, index) => {
        setTimeout(() => {
          letter.classList.add('animating');

          // Remove animation class after animation completes
          setTimeout(() => {
            letter.classList.remove('animating');
          }, 450);
        }, index * 100); // Stagger each letter by 100ms
      });
    }

    // Start wave animation after a small delay
    setTimeout(() => {
      waveAnimation();
    }, 500);
  }

  // Initialize ASCII animation on load
  initializeASCIIAnimation();
});
