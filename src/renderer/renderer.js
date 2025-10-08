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
    windowMinimize,
    windowMaximize,
    windowClose,
    selectDirectory,
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
    minimumContrastRatio: 4.5,
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
      icon.src = session.type === 'claude'
        ? './images/claude-icon.svg'
        : './images/gpt-icon.svg';
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
        if (session.status === 'running') {
          await terminate(session.id);
        }
        await dispose(session.id);
        removeSessionFromState(session.id);
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

    // Detect activity state from terminal output
    updateSessionActivity(session, data);

    if (state.activeSessionId === id) {
      terminal.write(data);
    } else {
      session.hasActivity = true;
      updateActiveSessionUI();
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
    updateEmptyState();
  }

  function updateSessionActivity(session, data) {
    // Strip ANSI codes and clean up the data for pattern matching
    const cleanData = data
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // Remove ANSI escape codes
      .replace(/\r/g, '')  // Remove carriage returns
      .trim();

    // Skip if it's just whitespace or empty after cleaning
    if (!cleanData) return;

    // Pattern detection - balanced between accuracy and responsiveness
    const patterns = {
      // User input detection - ignore state changes during user typing
      userInput: /^[a-z\s]{1,50}$/i,  // Short lowercase text = likely user typing

      // Tool usage - catch most tool-related activity
      toolUse: /(?:Using tool|tool:|read.*file|writ.*file|edit.*file|bash|grep|glob|search|execut|running command)/i,

      // Thinking/planning - only if it's clearly from Claude (starts with capital or has context)
      thinking: /(?:^Thinking\.\.\.|^Planning|^Analyzing|Envisioning)/i,

      // Response streaming - must be substantial (avoid false positives from session startup)
      responding: /(?:^[A-Z][a-z]{3,}.{25,}[.!?])/,

      // Completion/done indicators
      done: /(?:done|completed|finished|success|ready)/i,

      // Prompt ready
      prompt: />\s*$/,
    };

    let newState = session.activityState;

    // Don't change state if user is typing
    if (patterns.userInput.test(cleanData)) {
      return;
    }

    // Detect state based on patterns (order matters - most specific first)
    if (patterns.toolUse.test(cleanData)) {
      newState = 'working';
    } else if (patterns.thinking.test(cleanData)) {
      newState = 'thinking';
    } else if (patterns.done.test(cleanData)) {
      newState = 'idle';
    } else if (patterns.prompt.test(cleanData)) {
      newState = 'idle';
    } else if (patterns.responding.test(cleanData)) {
      newState = 'responding';
    }

    // Track any activity (non-idle states)
    const isActive = newState !== 'idle';

    // Only update if state changed
    if (newState !== session.activityState) {
      session.activityState = newState;
      renderSessionList();
    }

    // Reset timeout - if no activity for 1.5s, assume idle
    if (session.activityTimeout) {
      clearTimeout(session.activityTimeout);
    }

    if (isActive) {
      session.activityTimeout = setTimeout(() => {
        if (session.activityState !== 'idle') {
          session.activityState = 'idle';
          renderSessionList();
        }
      }, 1500);  // Faster idle detection (1.5s)
    }
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

  async function handleCreateSession(type) {
    console.log('[renderer] creating session', type);
    setActionButtonsDisabled(true);

    try {
      const cwd = elements.sessionDirInput.value.trim() || undefined;
      const session = await createSession(type, cwd);
      addSession(session);
      // Keep the directory input value for subsequent sessions
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
    const isHidden = elements.sidebar.classList.toggle('hidden');
    if (isHidden) {
      elements.sidebarToggleWorkspace.style.display = 'flex';
    } else {
      elements.sidebarToggleWorkspace.style.display = 'none';
    }
    // Refit terminal after sidebar animation completes
    setTimeout(() => fitAndNotify(), 300);
  }

  elements.sidebarToggle.addEventListener('click', toggleSidebar);
  elements.sidebarToggleWorkspace.addEventListener('click', toggleSidebar);

  // Sidebar resize functionality
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;
  const DEFAULT_SIDEBAR_WIDTH = 300;

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

  // Double-click to reset sidebar width
  elements.sidebarResizer.addEventListener('dblclick', () => {
    elements.sidebar.style.width = `${DEFAULT_SIDEBAR_WIDTH}px`;
    updateAsciiLogoSize(DEFAULT_SIDEBAR_WIDTH);
    fitAndNotify();
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
    const minWidth = 200;
    const maxWidth = 600;
    const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

    elements.sidebar.style.width = `${constrainedWidth}px`;
    updateAsciiLogoSize(constrainedWidth);

    // DEBUG: Show current width on the sidebar title (ALWAYS VISIBLE)
    const titleElement = document.querySelector('.sidebar__title');
    if (titleElement) {
      titleElement.setAttribute('data-width', constrainedWidth + 'px');
      if (!titleElement.style.position) {
        titleElement.style.position = 'relative';
        const widthDisplay = document.createElement('div');
        widthDisplay.id = 'width-display';
        widthDisplay.style.cssText = 'position: absolute; top: -20px; right: 0; background: red; color: white; padding: 2px 6px; font-size: 11px; font-family: monospace; border-radius: 3px; z-index: 1000;';
        titleElement.appendChild(widthDisplay);
      }
      const widthDisplay = document.getElementById('width-display');
      if (widthDisplay) {
        widthDisplay.textContent = constrainedWidth + 'px';
      }
    }

    // DEBUG: Log alignment info when sidebar is small
    if (constrainedWidth <= 230) {
      const codexButton = document.querySelector('.sidebar__action--codex');
      const folderButton = elements.browseDirButton;
      const inputGroup = document.querySelector('.sidebar__dir-input-group');
      const actionsContainer = document.querySelector('.sidebar__actions > div:first-child');

      if (codexButton && folderButton) {
        const codexRect = codexButton.getBoundingClientRect();
        const folderRect = folderButton.getBoundingClientRect();
        const inputGroupRect = inputGroup.getBoundingClientRect();
        const actionsRect = actionsContainer.getBoundingClientRect();

        const codexData = {
          width: codexRect.width.toFixed(2),
          right: codexRect.right.toFixed(2),
          rightEdgeRelative: (codexRect.right - elements.sidebar.getBoundingClientRect().left).toFixed(2)
        };
        const folderData = {
          width: folderRect.width.toFixed(2),
          height: folderRect.height.toFixed(2),
          right: folderRect.right.toFixed(2),
          rightEdgeRelative: (folderRect.right - elements.sidebar.getBoundingClientRect().left).toFixed(2)
        };
        const containerData = {
          actionsWidth: actionsRect.width.toFixed(2),
          inputGroupWidth: inputGroupRect.width.toFixed(2),
          gap: (actionsRect.width - inputGroupRect.width).toFixed(2)
        };
        const misalignment = (folderRect.right - codexRect.right).toFixed(2);

        console.log('[ALIGNMENT DEBUG @ ' + constrainedWidth + 'px]');
        console.log('  Codex:', 'w=' + codexData.width + 'px', 'rightEdge=' + codexData.rightEdgeRelative + 'px');
        console.log('  Folder:', 'w=' + folderData.width + 'px', 'h=' + folderData.height + 'px', 'rightEdge=' + folderData.rightEdgeRelative + 'px');
        console.log('  Containers:', 'actions=' + containerData.actionsWidth + 'px', 'inputGroup=' + containerData.inputGroupWidth + 'px', 'gap=' + containerData.gap + 'px');
        console.log('  Misalignment:', misalignment + 'px', misalignment < 0 ? '(too far left)' : misalignment > 0 ? '(too far right)' : '(perfect!)');
      }
    }

    fitAndNotify();
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      elements.sidebarResizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
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
});
