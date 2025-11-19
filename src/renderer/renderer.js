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
    newGeminiButton: document.getElementById('newGemini'),
    newTerminalButton: document.getElementById('newTerminal'),
    sessionDirInput: document.getElementById('sessionDir'),
    browseDirButton: document.getElementById('browseDirBtn'),
    terminalHostEl: document.getElementById('terminal'),
    emptyStateEl: document.getElementById('emptyState'),
    sidebar: document.querySelector('.sidebar'),
    sidebarResizer: document.getElementById('sidebarResizer'),
    sidebarToggle: document.getElementById('sidebarToggle'),
    sidebarToggleWorkspace: document.getElementById('sidebarToggleWorkspace'),
    settingsBtn: document.getElementById('settingsBtn'),
    // Branch selector elements
    branchSelector: document.getElementById('branchSelector'),
    branchName: document.getElementById('branchName'),
    branchDropdown: document.getElementById('branchDropdown'),
    branchList: document.getElementById('branchList'),
    newBranchInput: document.getElementById('newBranchInput'),
    createBranchBtn: document.getElementById('createBranchBtn'),
    worktreeModeToggle: document.getElementById('worktreeModeToggle'),
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
    // Worktree mode state
    worktreeMode: false,
    currentBranch: null,
    availableBranches: [],
    isGitRepo: false,
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

  function setActionButtonsDisabled(disabled, exceptButton = null) {
    if (exceptButton !== elements.newClaudeButton) {
      elements.newClaudeButton.disabled = disabled;
    }
    if (exceptButton !== elements.newCodexButton) {
      elements.newCodexButton.disabled = disabled;
    }
    if (exceptButton !== elements.newOpenCodeButton) {
      elements.newOpenCodeButton.disabled = disabled;
    }
    if (exceptButton !== elements.newGeminiButton) {
      elements.newGeminiButton.disabled = disabled;
    }
    if (exceptButton !== elements.newTerminalButton) {
      elements.newTerminalButton.disabled = disabled;
    }
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
      } else if (session.type === 'gemini') {
        iconSrc = './images/gemini-icon.svg';
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

      // Add branch badge next to title if session has branch info
      if (session.branch) {
        const branchBadge = document.createElement('span');
        branchBadge.className = 'session-item__branch-badge';
        branchBadge.textContent = `⎇ ${session.branch}`;

        // Add worktree indicator
        if (session.worktree && session.worktree.enabled) {
          if (session.worktree.isMain) {
            branchBadge.classList.add('session-item__branch-badge--main');
            branchBadge.title = `Main branch (${session.cwd})`;
          } else {
            branchBadge.classList.add('session-item__branch-badge--worktree');
            branchBadge.title = `Worktree: ${session.worktree.path}`;
          }
        }

        titleWrapper.appendChild(branchBadge);
      }

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
        // Debug: Log terminal dimensions before fit
        const terminalEl = elements.terminalHostEl.querySelector('.xterm');
        const viewportEl = elements.terminalHostEl.querySelector('.xterm-viewport');
        const screenEl = elements.terminalHostEl.querySelector('.xterm-screen');

        console.log('[DEBUG] Before fit:', {
          terminalHost: {
            width: elements.terminalHostEl.offsetWidth,
            clientWidth: elements.terminalHostEl.clientWidth,
            scrollWidth: elements.terminalHostEl.scrollWidth
          },
          xterm: terminalEl ? {
            width: terminalEl.offsetWidth,
            clientWidth: terminalEl.clientWidth,
            scrollWidth: terminalEl.scrollWidth,
            computedPadding: window.getComputedStyle(terminalEl).padding
          } : null,
          viewport: viewportEl ? {
            width: viewportEl.offsetWidth,
            scrollLeft: viewportEl.scrollLeft
          } : null,
          screen: screenEl ? {
            width: screenEl.offsetWidth,
            transform: window.getComputedStyle(screenEl).transform
          } : null,
          cols: terminal.cols,
          rows: terminal.rows
        });

        fitAddon.fit();

        // Debug: Log after fit
        console.log('[DEBUG] After fit:', {
          cols: terminal.cols,
          rows: terminal.rows,
          viewport: viewportEl ? {
            width: viewportEl.offsetWidth,
            scrollLeft: viewportEl.scrollLeft
          } : null
        });
      } catch (error) {
        console.error('[DEBUG] Fit error:', error);
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
    const packageName = toolType === 'claude' ? '@anthropic-ai/claude-code' :
                        toolType === 'codex' ? '@openai/codex' :
                        toolType === 'gemini' ? '@google/gemini-cli' :
                        'opencode-ai@latest';
    installNote.textContent = `This will run: npm install -g ${packageName}`;
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

  async function handleCreateSession(type, buttonElement) {
    setActionButtonsDisabled(true, buttonElement);

    try {
      const cwd = elements.sessionDirInput.value.trim() || undefined;

      let branchName = null;
      let createNewBranch = false;

      // Check if branch mode is enabled (for creating NEW branches)
      if (state.worktreeMode && state.isGitRepo) {
        // Show dialog to get branch name
        const { getBranchNameDialog } = window.claudebox || {};
        if (!getBranchNameDialog) {
          alert('Branch name dialog not available');
          setActionButtonsDisabled(false);
          return;
        }

        branchName = await getBranchNameDialog();

        if (!branchName) {
          // User cancelled
          setActionButtonsDisabled(false);
          return;
        }

        // Update state (the worktree will be created by the main process)
        state.currentBranch = branchName;
        elements.branchName.textContent = branchName;
        createNewBranch = true;
      } else if (state.currentBranch) {
        // Not creating a new branch, but we have a current branch from dropdown selection
        branchName = state.currentBranch;
      }

      // Create the session with worktree support
      // Pass worktreeMode only when creating a new branch, but always pass branchName
      const session = await createSession(type, cwd, createNewBranch, branchName);

      // Refresh branch info after session creation (to show new worktrees)
      if (createNewBranch && state.isGitRepo) {
        await updateBranchInfo();
      }

      addSession(session);
      // Keep the directory input value for subsequent sessions
    } catch (error) {
      console.error('[renderer] Failed to create session', error);
      const message = error?.message ?? 'Unknown error';

      // Check if it's a tool not installed error
      if (message.includes('TOOL_NOT_INSTALLED:')) {
        // Extract the TOOL_NOT_INSTALLED part from the error message
        const toolNotInstalledMatch = message.match(/TOOL_NOT_INSTALLED:([^:]+):(.+?)(?:\s|$)/);
        if (!toolNotInstalledMatch) {
          alert(`Could not start the session. ${message}`);
          setActionButtonsDisabled(false);
          return;
        }
        const [, toolType, toolName] = toolNotInstalledMatch;

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

  // Directory validation - enable/disable session buttons based on whether directory is set
  function validateDirectoryInput() {
    const hasDirectory = elements.sessionDirInput.value.trim().length > 0;

    // Enable or disable all session creation buttons
    elements.newClaudeButton.disabled = !hasDirectory;
    elements.newCodexButton.disabled = !hasDirectory;
    elements.newOpenCodeButton.disabled = !hasDirectory;
    elements.newGeminiButton.disabled = !hasDirectory;
    elements.newTerminalButton.disabled = !hasDirectory;

    // Note: Branch controls are handled by updateBranchInfo() which checks if it's a git repo
  }

  elements.newClaudeButton.addEventListener('click', () => handleCreateSession('claude', elements.newClaudeButton));
  elements.newCodexButton.addEventListener('click', () => handleCreateSession('codex', elements.newCodexButton));
  elements.newOpenCodeButton.addEventListener('click', () => handleCreateSession('opencode', elements.newOpenCodeButton));
  elements.newGeminiButton.addEventListener('click', () => handleCreateSession('gemini', elements.newGeminiButton));
  elements.newTerminalButton.addEventListener('click', () => handleCreateSession('terminal', elements.newTerminalButton));

  // Directory browse button
  if (elements.browseDirButton && selectDirectory) {
    elements.browseDirButton.addEventListener('click', async () => {
      const selectedPath = await selectDirectory();
      if (selectedPath) {
        elements.sessionDirInput.value = selectedPath;
        // Validate and enable buttons
        validateDirectoryInput();
        // Update branch info when directory changes
        await updateBranchInfo();
      }
    });
  }

  // ========== BRANCH FUNCTIONALITY ==========

  /**
   * Update branch information based on current directory
   */
  async function updateBranchInfo() {
    const {
      gitIsRepo,
      gitGetCurrentBranch,
      gitGetAllBranches
    } = window.claudebox || {};

    if (!gitIsRepo || !gitGetCurrentBranch || !gitGetAllBranches) {
      return;
    }

    const cwd = elements.sessionDirInput.value.trim();

    // If no directory is selected, disable branch controls
    if (!cwd) {
      elements.branchName.textContent = 'No directory';
      elements.branchSelector.disabled = true;
      elements.worktreeModeToggle.disabled = true;
      state.isGitRepo = false;
      state.currentBranch = null;
      state.availableBranches = [];
      return;
    }

    try {
      // Check if it's a git repo
      const { isRepo } = await gitIsRepo(cwd);
      state.isGitRepo = isRepo;

      if (!isRepo) {
        elements.branchName.textContent = 'Not a git repo';
        elements.branchSelector.disabled = true;
        elements.worktreeModeToggle.disabled = true;
        state.currentBranch = null;
        state.availableBranches = [];
        return;
      }

      // Get current branch
      const { branch } = await gitGetCurrentBranch(cwd);
      state.currentBranch = branch;
      elements.branchName.textContent = branch || 'Unknown';
      elements.branchSelector.disabled = false;
      elements.worktreeModeToggle.disabled = false;

      // Get all branches
      const { branches } = await gitGetAllBranches(cwd);
      state.availableBranches = branches || [];

      // Update branch dropdown
      renderBranchList();
    } catch (error) {
      console.error('[renderer] Failed to update branch info', error);
      elements.branchName.textContent = 'Error';
      elements.branchSelector.disabled = true;
      elements.worktreeModeToggle.disabled = true;
    }
  }

  /**
   * Render the branch list in the dropdown
   */
  async function renderBranchList() {
    elements.branchList.innerHTML = '';

    if (state.availableBranches.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.padding = '8px';
      emptyMsg.style.color = 'var(--text-secondary)';
      emptyMsg.style.fontSize = '0.7rem';
      emptyMsg.textContent = 'No branches found';
      elements.branchList.appendChild(emptyMsg);
      return;
    }

    const { gitListWorktrees } = window.claudebox || {};
    const cwd = elements.sessionDirInput.value.trim() || undefined;

    // Get list of branches in worktrees
    let worktreeBranches = new Set();
    if (gitListWorktrees) {
      try {
        const { worktrees } = await gitListWorktrees(cwd);
        worktrees.forEach(wt => {
          if (wt.branch) {
            worktreeBranches.add(wt.branch);
          }
        });
      } catch (error) {
        console.error('[renderer] Failed to list worktrees', error);
      }
    }

    state.availableBranches.forEach(branch => {
      const branchBtn = document.createElement('button');
      branchBtn.className = 'branch-item';

      if (branch === state.currentBranch) {
        branchBtn.classList.add('active');
      }

      const isInWorktree = worktreeBranches.has(branch);

      // Add branch icon
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('width', '12');
      icon.setAttribute('height', '12');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '6');
      line.setAttribute('y1', '3');
      line.setAttribute('x2', '6');
      line.setAttribute('y2', '15');
      icon.appendChild(line);

      const circle1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle1.setAttribute('cx', '18');
      circle1.setAttribute('cy', '6');
      circle1.setAttribute('r', '3');
      icon.appendChild(circle1);

      const circle2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle2.setAttribute('cx', '6');
      circle2.setAttribute('cy', '18');
      circle2.setAttribute('r', '3');
      icon.appendChild(circle2);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M18 9a9 9 0 0 1-9 9');
      icon.appendChild(path);

      branchBtn.appendChild(icon);

      const branchText = document.createElement('span');
      branchText.textContent = branch;
      branchBtn.appendChild(branchText);

      // Add worktree indicator badge if branch is in a worktree
      if (isInWorktree) {
        const worktreeBadge = document.createElement('span');
        worktreeBadge.className = 'branch-item__worktree-badge';
        worktreeBadge.textContent = 'worktree';
        worktreeBadge.title = 'This branch is checked out in a worktree';
        branchBtn.appendChild(worktreeBadge);
      }

      branchBtn.addEventListener('click', async () => {
        await checkoutBranch(branch);
      });

      elements.branchList.appendChild(branchBtn);
    });
  }

  /**
   * Checkout a branch
   */
  async function checkoutBranch(branchName) {
    const { gitCheckoutBranch, gitGetWorktreePath, gitListWorktrees } = window.claudebox || {};
    if (!gitCheckoutBranch) return;

    let cwd = elements.sessionDirInput.value.trim() || undefined;

    try {
      // Check if this branch is already in a worktree
      if (gitGetWorktreePath && gitListWorktrees) {
        const { path: worktreePath } = await gitGetWorktreePath(cwd, branchName);

        if (worktreePath) {
          // Branch is in a worktree - switch to that worktree directory
          elements.sessionDirInput.value = worktreePath;
          state.currentBranch = branchName;
          elements.branchName.textContent = branchName;
          closeBranchDropdown();

          // Refresh branch info for the new directory
          await updateBranchInfo();
          return;
        }

        // Branch doesn't have a worktree - check if we're currently in a worktree
        const { worktrees } = await gitListWorktrees(cwd);
        const currentWorktree = worktrees.find(wt => cwd && cwd.includes(wt.path));

        if (currentWorktree) {
          // We're in a worktree, need to switch to main repo for this branch
          // Find the main worktree (the one without .claudebox/worktrees in path)
          const mainWorktree = worktrees.find(wt => !wt.path.includes('.claudebox'));
          if (mainWorktree) {
            cwd = mainWorktree.path;
            elements.sessionDirInput.value = mainWorktree.path;
          }
        }
      }

      // No worktree exists - do regular checkout in main repo
      const { success, error } = await gitCheckoutBranch(cwd, branchName);

      if (success) {
        state.currentBranch = branchName;
        elements.branchName.textContent = branchName;
        closeBranchDropdown();
        await updateBranchInfo();
      } else {
        alert(`Failed to checkout branch: ${error}`);
      }
    } catch (error) {
      console.error('[renderer] Failed to checkout branch', error);
      alert(`Error: ${error.message}`);
    }
  }

  /**
   * Toggle branch selector dropdown
   */
  function toggleBranchDropdown() {
    const isOpen = !elements.branchDropdown.classList.contains('hidden');

    if (isOpen) {
      closeBranchDropdown();
    } else {
      openBranchDropdown();
    }
  }

  function openBranchDropdown() {
    elements.branchDropdown.classList.remove('hidden');
    elements.branchSelector.classList.add('open');
    elements.newBranchInput.value = '';

    // Close quick prompts dropdown if open
    closeQuickPromptsDropdown();
  }

  function closeBranchDropdown() {
    elements.branchDropdown.classList.add('hidden');
    elements.branchSelector.classList.remove('open');
  }

  // Branch selector click handler
  elements.branchSelector.addEventListener('click', () => {
    if (!elements.branchSelector.disabled) {
      toggleBranchDropdown();
    }
  });

  // Create new branch button
  elements.createBranchBtn.addEventListener('click', async () => {
    const branchName = elements.newBranchInput.value.trim();

    if (!branchName) {
      alert('Please enter a branch name');
      return;
    }

    const { gitCreateBranch } = window.claudebox || {};
    if (!gitCreateBranch) return;

    const cwd = elements.sessionDirInput.value.trim() || undefined;

    try {
      const { success, error } = await gitCreateBranch(cwd, branchName);

      if (success) {
        state.currentBranch = branchName;
        elements.branchName.textContent = branchName;
        elements.newBranchInput.value = '';

        // Refresh branch list
        await updateBranchInfo();
        closeBranchDropdown();
      } else {
        alert(`Failed to create branch: ${error}`);
      }
    } catch (error) {
      console.error('[renderer] Failed to create branch', error);
      alert(`Error: ${error.message}`);
    }
  });

  // Handle Enter key in new branch input
  elements.newBranchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      elements.createBranchBtn.click();
    }
  });

  // Branch mode toggle
  elements.worktreeModeToggle.addEventListener('click', () => {
    if (elements.worktreeModeToggle.disabled) return;

    state.worktreeMode = !state.worktreeMode;

    if (state.worktreeMode) {
      elements.worktreeModeToggle.classList.add('active');
    } else {
      elements.worktreeModeToggle.classList.remove('active');
    }
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    // Check if click is outside branch dropdown
    if (!elements.branchSelector.contains(e.target) &&
        !elements.branchDropdown.contains(e.target)) {
      closeBranchDropdown();
    }
  });

  // Initialize branch info on load
  updateBranchInfo();

  // ========== SETTINGS MODAL ==========

  const settingsModal = document.getElementById('settingsModal');
  const settingsBtn = document.getElementById('settingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const resetSettingsBtn = document.getElementById('resetSettingsBtn');

  // Default settings
  const defaultSettings = {
    // Appearance
    sidebarWidth: 300,
    enableAnimations: true,
    accentClaude: '#ff6b35',
    accentCodex: '#5899ff',
    accentOpencode: '#22c55e',
    accentGemini: '#8B7CFF',
    // Terminal
    terminalFontFamily: 'JetBrains Mono, Cascadia Code, Fira Code, monospace',
    terminalFontSize: 13,
    terminalFontWeight: 300,
    terminalFontWeightBold: 600,
    terminalCursorStyle: 'bar',
    terminalCursorBlink: true,
    terminalScrollback: 2000,
    terminalBgColor: '#0d0d0d',
    terminalFgColor: '#e8e8e8',
    terminalCursorColor: '#ff6b35',
    // Sessions
    claudeCommand: 'claude --dangerously-skip-permissions',
    codexCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
    opencodeCommand: 'opencode',
    geminiCommand: 'gemini --yolo',
    activitySensitivity: 0.5,
    // Git
    worktreeDir: '.claudebox/worktrees',
    mainBranches: 'main, master',
    // Window
    windowWidth: 1280,
    windowHeight: 820,
    rememberWindowSize: false,
    // Updates
    autoCheckUpdates: true,
    autoDownloadUpdates: false,
    // Shortcuts (empty by default)
    shortcutNewClaude: '',
    shortcutNewCodex: '',
    shortcutNewTerminal: '',
    shortcutCloseSession: '',
    shortcutToggleSidebar: '',
    // Advanced
    hardwareAcceleration: false,
    debugMode: false,
    gitTimeout: 10000
  };

  let currentSettings = { ...defaultSettings };

  // Tab switching
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab');

      // Update tabs
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update panels
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      document.querySelector(`[data-panel="${tabName}"]`).classList.add('active');
    });
  });

  // Scrollbar visibility on scroll
  let scrollTimeout;
  const settingsContent = document.querySelector('.settings-content');
  const settingsTabs = document.querySelector('.settings-tabs');

  function showScrollbar(element) {
    element.classList.add('scrolling');
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      element.classList.remove('scrolling');
    }, 1000);
  }

  if (settingsContent) {
    settingsContent.addEventListener('scroll', () => showScrollbar(settingsContent));
  }

  if (settingsTabs) {
    settingsTabs.addEventListener('scroll', () => showScrollbar(settingsTabs));
  }

  // Load settings from storage
  async function loadSettings() {
    const { loadSettings } = window.claudebox || {};
    if (!loadSettings) return;

    try {
      const { settings } = await loadSettings();
      currentSettings = { ...defaultSettings, ...settings };
      applySettingsToForm();
    } catch (error) {
      console.error('[renderer] Failed to load settings', error);
    }
  }

  // Apply settings to form inputs
  function applySettingsToForm() {
    Object.keys(currentSettings).forEach(key => {
      const input = document.getElementById(key);
      if (!input) return;

      if (input.type === 'checkbox') {
        input.checked = currentSettings[key];
      } else {
        input.value = currentSettings[key];
      }
    });
  }

  // Gather settings from form
  function gatherSettingsFromForm() {
    const settings = {};

    Object.keys(defaultSettings).forEach(key => {
      const input = document.getElementById(key);
      if (!input) return;

      if (input.type === 'checkbox') {
        settings[key] = input.checked;
      } else if (input.type === 'number') {
        settings[key] = parseFloat(input.value);
      } else {
        settings[key] = input.value;
      }
    });

    return settings;
  }

  // Save settings
  async function saveSettings() {
    const { saveSettings } = window.claudebox || {};
    if (!saveSettings) return;

    try {
      currentSettings = gatherSettingsFromForm();
      const result = await saveSettings(currentSettings);

      if (result.success) {
        alert('Settings saved successfully! Some settings may require a restart to take effect.');
        closeSettingsModal();
      } else {
        alert('Failed to save settings: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('[renderer] Failed to save settings', error);
      alert('Failed to save settings: ' + error.message);
    }
  }

  // Reset to defaults
  function resetSettings() {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      currentSettings = { ...defaultSettings };
      applySettingsToForm();
    }
  }

  // Open settings modal
  function openSettingsModal() {
    settingsModal.classList.remove('hidden');
    loadSettings();
  }

  // Close settings modal
  function closeSettingsModal() {
    settingsModal.classList.add('hidden');
  }

  // Event listeners
  settingsBtn.addEventListener('click', openSettingsModal);
  closeSettingsBtn.addEventListener('click', closeSettingsModal);
  settingsModal.querySelector('.modal__overlay').addEventListener('click', closeSettingsModal);
  saveSettingsBtn.addEventListener('click', saveSettings);
  resetSettingsBtn.addEventListener('click', resetSettings);

  // ========== AUTO-UPDATE NOTIFICATION ==========

  const updateNotification = document.getElementById('updateNotification');
  const updateTitle = document.getElementById('updateTitle');
  const updateMessage = document.getElementById('updateMessage');
  const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
  const dismissUpdateBtn = document.getElementById('dismissUpdateBtn');
  const updateProgress = document.getElementById('updateProgress');
  const updateProgressFill = document.getElementById('updateProgressFill');
  const updateProgressText = document.getElementById('updateProgressText');

  const UpdateAction = {
    DOWNLOAD: 'download',
    INSTALL: 'install'
  };

  let currentUpdateVersion = null;
  let currentUpdateAction = UpdateAction.DOWNLOAD;

  function setDownloadButtonState(action) {
    currentUpdateAction = action;
    downloadUpdateBtn.disabled = false;
    if (action === UpdateAction.DOWNLOAD) {
      downloadUpdateBtn.textContent = 'Download';
    } else {
      downloadUpdateBtn.textContent = 'Restart & Install';
    }
  }

  /**
   * Show update notification
   */
  function showUpdateNotification(version, message) {
    currentUpdateVersion = version;
    updateTitle.textContent = 'Update Available';
    updateMessage.textContent = message || `Version ${version} is ready to download`;
    setDownloadButtonState(UpdateAction.DOWNLOAD);
    updateNotification.classList.remove('hidden');
    updateProgress.classList.add('hidden');
    updateProgressFill.style.width = '0%';
    updateProgressText.textContent = '';
  }

  /**
   * Hide update notification
   */
  function hideUpdateNotification() {
    updateNotification.classList.add('hidden');
    currentUpdateVersion = null;
  }

  /**
   * Show download progress
   */
  function showDownloadProgress(percent, transferred, total) {
    updateProgress.classList.remove('hidden');
    updateProgressFill.style.width = `${percent}%`;
    const transferredMB = (transferred / 1024 / 1024).toFixed(1);
    const totalMB = (total / 1024 / 1024).toFixed(1);
    updateProgressText.textContent = `Downloading... ${Math.round(percent)}% (${transferredMB}MB / ${totalMB}MB)`;
  }

  /**
   * Show update ready to install
   */
  function showUpdateReady(version) {
    updateTitle.textContent = 'Update Ready';
    updateMessage.textContent = `Version ${version} has been downloaded and is ready to install`;
    setDownloadButtonState(UpdateAction.INSTALL);
    updateProgress.classList.remove('hidden');
  }

  // Handle update available event
  const { onUpdateAvailable, onUpdateDownloaded, onUpdateProgress, onUpdateError } = window.claudebox || {};

  if (onUpdateAvailable) {
    disposerFns.push(onUpdateAvailable(({ version }) => {
      showUpdateNotification(version);
    }));
  }

  if (onUpdateDownloaded) {
    disposerFns.push(onUpdateDownloaded(({ version }) => {
      showUpdateReady(version);
    }));
  }

  if (onUpdateProgress) {
    disposerFns.push(onUpdateProgress(({ percent, transferred, total }) => {
      showDownloadProgress(percent, transferred, total);
    }));
  }

  if (onUpdateError) {
    disposerFns.push(onUpdateError(({ message }) => {
      console.error('[renderer] Update error:', message);
      alert(`Update error: ${message}`);
      hideUpdateNotification();
    }));
  }

  // Download update button
  downloadUpdateBtn.addEventListener('click', async () => {
    if (currentUpdateAction === UpdateAction.INSTALL) {
      const { installUpdate } = window.claudebox || {};
      if (!installUpdate) return;

      downloadUpdateBtn.disabled = true;
      downloadUpdateBtn.textContent = 'Restarting...';
      try {
        await installUpdate();
      } catch (error) {
        console.error('[renderer] Failed to install update', error);
        alert(`Failed to install update: ${error.message}`);
        setDownloadButtonState(UpdateAction.INSTALL);
      }
      return;
    }

    const { downloadUpdate } = window.claudebox || {};
    if (!downloadUpdate) return;

    try {
      downloadUpdateBtn.disabled = true;
      downloadUpdateBtn.textContent = 'Downloading...';
      await downloadUpdate();
    } catch (error) {
      console.error('[renderer] Failed to download update', error);
      alert(`Failed to download update: ${error.message}`);
      setDownloadButtonState(UpdateAction.DOWNLOAD);
    }
  });

  // Dismiss update button
  dismissUpdateBtn.addEventListener('click', () => {
    hideUpdateNotification();
  });

  // Sidebar toggle functionality
  function toggleSidebar() {
    // Capture current sidebar width for CSS animation
    const sidebarRect = elements.sidebar.getBoundingClientRect();
    const sidebarWidth = Math.round(sidebarRect.width);
    elements.sidebar.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    document.documentElement.style.setProperty('--sidebar-visible-width', `${sidebarWidth}px`);

    const currentlyHidden = elements.sidebar.classList.contains('hidden');

    // Debug: Check sidebar and workspace positions before toggle
    const workspaceEl = document.querySelector('.workspace');
    const workspaceRect = workspaceEl?.getBoundingClientRect();
    const canvasEl = elements.terminalHostEl.querySelector('canvas');

    console.log('[DEBUG] Before toggle:', {
      sidebar: {
        left: sidebarRect.left,
        right: sidebarRect.right,
        width: sidebarRect.width,
        computedWidth: window.getComputedStyle(elements.sidebar).width,
        transform: window.getComputedStyle(elements.sidebar).transform,
        hidden: elements.sidebar.classList.contains('hidden')
      },
      workspace: workspaceRect ? {
        left: workspaceRect.left,
        width: workspaceRect.width
      } : null,
      canvas: canvasEl ? {
        left: canvasEl.getBoundingClientRect().left,
        offsetLeft: canvasEl.offsetLeft
      } : null
    });

    const afterTransition = (el, fn, timeout = 350) => {
      let called = false;
      const handler = (ev) => {
        // Ensure we respond to the transition on the element itself
        if (ev.currentTarget !== el) return;
        if (called) return;
        called = true;
        el.removeEventListener('transitionend', handler);

        // Debug: Check positions after transition
        const sidebarRectAfter = elements.sidebar.getBoundingClientRect();
        const workspaceElAfter = document.querySelector('.workspace');
        const workspaceRectAfter = workspaceElAfter?.getBoundingClientRect();
        const canvasElAfter = elements.terminalHostEl.querySelector('canvas');
        const resizerEl = document.querySelector('.sidebar-resizer');
        const resizerRect = resizerEl?.getBoundingClientRect();

        console.log('[DEBUG] After toggle transition:', {
          sidebar: {
            left: sidebarRectAfter.left,
            right: sidebarRectAfter.right,
            width: sidebarRectAfter.width,
            computedWidth: window.getComputedStyle(elements.sidebar).width,
            transform: window.getComputedStyle(elements.sidebar).transform,
            hidden: elements.sidebar.classList.contains('hidden')
          },
          resizer: resizerRect ? {
            left: resizerRect.left,
            width: resizerRect.width,
            computedWidth: window.getComputedStyle(resizerEl).width
          } : null,
          workspace: workspaceRectAfter ? {
            left: workspaceRectAfter.left,
            width: workspaceRectAfter.width
          } : null,
          canvas: canvasElAfter ? {
            left: canvasElAfter.getBoundingClientRect().left,
            offsetLeft: canvasElAfter.offsetLeft
          } : null
        });

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

    const workspaceElement = document.querySelector('.workspace');

    if (!currentlyHidden) {
      // Hiding: collapse width smoothly via CSS; resizer auto collapses via CSS rule
      elements.sidebar.classList.add('hidden');
      if (workspaceElement) workspaceElement.classList.add('sidebar-hidden');
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
      if (workspaceElement) workspaceElement.classList.remove('sidebar-hidden');
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

  // Set initial sidebar width CSS variable
  document.documentElement.style.setProperty('--sidebar-visible-width', `${preferredSidebarWidth}px`);

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
    document.documentElement.style.setProperty('--sidebar-visible-width', `${clamped}px`);
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

  // Initialize with buttons disabled (no default directory)
  validateDirectoryInput();

  // Watch for directory input changes
  elements.sessionDirInput.addEventListener('input', async () => {
    validateDirectoryInput();
    await updateBranchInfo();
  });
  elements.sessionDirInput.addEventListener('blur', async () => {
    validateDirectoryInput();
    await updateBranchInfo();
  });

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
