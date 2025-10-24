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
    // Branch selector elements
    branchSelector: document.getElementById('branchSelector'),
    branchName: document.getElementById('branchName'),
    branchDropdown: document.getElementById('branchDropdown'),
    branchList: document.getElementById('branchList'),
    newBranchInput: document.getElementById('newBranchInput'),
    createBranchBtn: document.getElementById('createBranchBtn'),
    branchModeToggle: document.getElementById('branchModeToggle'),
    // Quick prompts elements
    quickPromptsBtn: document.getElementById('quickPromptsBtn'),
    quickPromptsDropdown: document.getElementById('quickPromptsDropdown'),
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
    // Branch mode state
    branchMode: false,
    currentBranch: null,
    availableBranches: [],
    isGitRepo: false,
    // Custom prompts state
    customPrompts: [],
    editingPromptIndex: null,
  };

  const disposerFns = [];

  // Quick prompts templates - detailed instructions for AI
  const QUICK_PROMPTS = {
    merge: `Please help me merge the current feature branch into the main branch. Follow these steps carefully:

1. First, verify the current branch name and show me what changes have been made
2. Switch to the main branch and ensure it's up to date
3. Merge the feature branch into main, handling any merge conflicts that arise
4. If there are conflicts, clearly explain them and help me resolve them
5. After a successful merge, delete the feature branch to keep the repository clean
6. Provide a summary of what was merged

Please proceed step by step and ask for confirmation before any destructive operations.`,

    handoff: `Please generate a comprehensive handoff summary for the current branch/feature. Include:

1. **Branch Name & Purpose**: What is this branch for?
2. **Changes Made**: Detailed list of files modified, added, or deleted
3. **Key Implementation Details**: Important architectural decisions or patterns used
4. **Testing Status**: What has been tested? What still needs testing?
5. **Known Issues**: Any bugs, limitations, or technical debt introduced
6. **Next Steps**: What work remains to be done?
7. **Dependencies**: Any new packages or external dependencies added
8. **Breaking Changes**: Any changes that might affect other parts of the codebase

Please analyze the git diff and commit history to provide accurate information.`,

    analysis: `Please perform a comprehensive initial analysis of this codebase. Provide:

1. **Project Overview**:
   - What is this project? (based on README, package.json, or main files)
   - What technologies/frameworks are used?
   - Project structure and organization

2. **Architecture**:
   - High-level architecture pattern (MVC, microservices, etc.)
   - Key components and how they interact
   - Data flow and state management

3. **Entry Points**:
   - Main application entry points
   - Build/run commands
   - Configuration files

4. **Dependencies**:
   - Key external libraries and their purposes
   - Development vs production dependencies

5. **Code Quality Observations**:
   - Testing setup (if any)
   - Documentation quality
   - Code organization patterns

6. **Suggestions**:
   - Areas that might need attention
   - Potential improvements or modernization opportunities

Please explore the codebase systematically and provide a well-organized report.`,

    debug: `I'm experiencing an issue and need help debugging it systematically. Please follow this structured debugging approach:

1. **Understand the Problem**: First, help me clearly articulate what the issue is, what the expected behavior should be, and what's actually happening.

2. **Hypothesis Generation**: Reflect on 5–7 different possible sources of the problem. Consider:
   - Logic errors or incorrect assumptions
   - State management issues
   - Timing/race conditions
   - Integration problems between components
   - Configuration or environment issues
   - Data flow or transformation problems
   - External dependencies or API issues

3. **Narrow Down**: Distill those possibilities down to the 1–2 most likely sources based on the symptoms and context.

4. **Validate with Logs**: Before implementing any fixes, add strategic logging/debugging statements to validate your assumptions about the most likely sources. Show me what logs to add and where.

5. **Review Results**: Once I run the code with the new logs, help me analyze the output to confirm the root cause.

6. **Implement Fix**: Only after we've validated the root cause with logs, proceed with implementing the actual code fix.

Please guide me through this process methodically and ask clarifying questions as needed.`
  };

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

  async function handleCreateSession(type) {
    setActionButtonsDisabled(true);

    try {
      const cwd = elements.sessionDirInput.value.trim() || undefined;

      let branchName = null;
      let createNewBranch = false;

      // Check if branch mode is enabled (for creating NEW branches)
      if (state.branchMode && state.isGitRepo) {
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
      // Pass branchMode only when creating a new branch, but always pass branchName
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

  elements.newClaudeButton.addEventListener('click', () => handleCreateSession('claude'));
  elements.newCodexButton.addEventListener('click', () => handleCreateSession('codex'));
  elements.newOpenCodeButton.addEventListener('click', () => handleCreateSession('opencode'));
  elements.newGeminiButton.addEventListener('click', () => handleCreateSession('gemini'));
  elements.newTerminalButton.addEventListener('click', () => handleCreateSession('terminal'));

  // Directory browse button
  if (elements.browseDirButton && selectDirectory) {
    elements.browseDirButton.addEventListener('click', async () => {
      const selectedPath = await selectDirectory();
      if (selectedPath) {
        elements.sessionDirInput.value = selectedPath;
        // Update branch info when directory changes
        await updateBranchInfo();
      }
    });
  }

  // Also update branch info when directory input changes manually
  elements.sessionDirInput.addEventListener('blur', async () => {
    await updateBranchInfo();
  });

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

    const cwd = elements.sessionDirInput.value.trim() || undefined;

    try {
      // Check if it's a git repo
      const { isRepo } = await gitIsRepo(cwd);
      state.isGitRepo = isRepo;

      if (!isRepo) {
        elements.branchName.textContent = 'Not a git repo';
        elements.branchSelector.disabled = true;
        elements.branchModeToggle.disabled = true;
        state.currentBranch = null;
        state.availableBranches = [];
        return;
      }

      // Get current branch
      const { branch } = await gitGetCurrentBranch(cwd);
      state.currentBranch = branch;
      elements.branchName.textContent = branch || 'Unknown';
      elements.branchSelector.disabled = false;
      elements.branchModeToggle.disabled = false;

      // Get all branches
      const { branches } = await gitGetAllBranches(cwd);
      state.availableBranches = branches || [];

      // Update branch dropdown
      renderBranchList();
    } catch (error) {
      console.error('[renderer] Failed to update branch info', error);
      elements.branchName.textContent = 'Error';
      elements.branchSelector.disabled = true;
      elements.branchModeToggle.disabled = true;
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
  elements.branchModeToggle.addEventListener('click', () => {
    if (elements.branchModeToggle.disabled) return;

    state.branchMode = !state.branchMode;

    if (state.branchMode) {
      elements.branchModeToggle.classList.add('active');
    } else {
      elements.branchModeToggle.classList.remove('active');
    }
  });

  // ========== QUICK PROMPTS FUNCTIONALITY ==========

  /**
   * Toggle quick prompts dropdown
   */
  function toggleQuickPromptsDropdown() {
    const isOpen = !elements.quickPromptsDropdown.classList.contains('hidden');

    if (isOpen) {
      closeQuickPromptsDropdown();
    } else {
      openQuickPromptsDropdown();
    }
  }

  function openQuickPromptsDropdown() {
    elements.quickPromptsDropdown.classList.remove('hidden');
    elements.quickPromptsBtn.classList.add('open');

    // Close branch dropdown if open
    closeBranchDropdown();
  }

  function closeQuickPromptsDropdown() {
    elements.quickPromptsDropdown.classList.add('hidden');
    elements.quickPromptsBtn.classList.remove('open');
  }

  // Quick prompts button click handler
  elements.quickPromptsBtn.addEventListener('click', () => {
    toggleQuickPromptsDropdown();
  });

  // Quick prompt item click handlers
  document.querySelectorAll('.quick-prompt-item').forEach(item => {
    item.addEventListener('click', () => {
      const promptKey = item.getAttribute('data-prompt');
      const promptText = QUICK_PROMPTS[promptKey];

      if (promptText && state.activeSessionId) {
        // Inject prompt into the active terminal
        injectPromptToActiveSession(promptText);
        closeQuickPromptsDropdown();
      } else if (!state.activeSessionId) {
        alert('Please select or create a session first');
      }
    });
  });

  /**
   * Inject a prompt into the active terminal session
   */
  function injectPromptToActiveSession(promptText) {
    if (!state.activeSessionId) return;

    const session = findSession(state.activeSessionId);
    if (!session || session.status !== 'running') return;

    // Write the prompt text to the terminal
    write(state.activeSessionId, promptText);
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    // Check if click is outside branch dropdown
    if (!elements.branchSelector.contains(e.target) &&
        !elements.branchDropdown.contains(e.target)) {
      closeBranchDropdown();
    }

    // Check if click is outside quick prompts dropdown
    if (!elements.quickPromptsBtn.contains(e.target) &&
        !elements.quickPromptsDropdown.contains(e.target)) {
      closeQuickPromptsDropdown();
    }
  });

  // Initialize branch info on load
  updateBranchInfo();

  // ========== CUSTOM PROMPTS MANAGEMENT ==========

  const customPromptsModal = document.getElementById('customPromptsModal');
  const promptEditorModal = document.getElementById('promptEditorModal');
  const managePromptsBtn = document.getElementById('managePromptsBtn');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const closeEditorBtn = document.getElementById('closeEditorBtn');
  const addPromptBtn = document.getElementById('addPromptBtn');
  const customPromptsList = document.getElementById('customPromptsList');
  const customPromptsContainer = document.getElementById('customPromptsContainer');
  const promptName = document.getElementById('promptName');
  const promptDescription = document.getElementById('promptDescription');
  const promptContent = document.getElementById('promptContent');
  const savePromptBtn = document.getElementById('savePromptBtn');
  const cancelPromptBtn = document.getElementById('cancelPromptBtn');
  const editorModalTitle = document.getElementById('editorModalTitle');

  /**
   * Load custom prompts from storage
   */
  async function loadCustomPrompts() {
    const { loadCustomPrompts } = window.claudebox || {};
    if (!loadCustomPrompts) return;

    try {
      const { prompts } = await loadCustomPrompts();
      state.customPrompts = prompts || [];
      renderCustomPromptsInDropdown();
      renderCustomPromptsList();
    } catch (error) {
      console.error('[renderer] Failed to load custom prompts', error);
    }
  }

  /**
   * Save custom prompts to storage
   */
  async function saveCustomPrompts() {
    const { saveCustomPrompts } = window.claudebox || {};
    if (!saveCustomPrompts) return;

    try {
      await saveCustomPrompts(state.customPrompts);
    } catch (error) {
      console.error('[renderer] Failed to save custom prompts', error);
      alert('Failed to save custom prompts');
    }
  }

  /**
   * Render custom prompts in the quick prompts dropdown
   */
  function renderCustomPromptsInDropdown() {
    customPromptsContainer.innerHTML = '';

    if (state.customPrompts.length === 0) return;

    // Add divider before custom prompts
    const divider = document.createElement('div');
    divider.className = 'prompts-divider';
    customPromptsContainer.appendChild(divider);

    state.customPrompts.forEach((prompt, index) => {
      const promptItem = document.createElement('button');
      promptItem.className = 'quick-prompt-item';
      promptItem.setAttribute('data-custom-index', index);

      const label = document.createElement('span');
      label.className = 'quick-prompt-label';
      label.textContent = prompt.name;

      const desc = document.createElement('span');
      desc.className = 'quick-prompt-desc';
      desc.textContent = prompt.description;

      promptItem.appendChild(label);
      promptItem.appendChild(desc);

      promptItem.addEventListener('click', () => {
        if (state.activeSessionId) {
          injectPromptToActiveSession(prompt.content);
          closeQuickPromptsDropdown();
        } else {
          alert('Please select or create a session first');
        }
      });

      customPromptsContainer.appendChild(promptItem);
    });
  }

  /**
   * Render custom prompts in the management modal
   */
  function renderCustomPromptsList() {
    customPromptsList.innerHTML = '';

    if (state.customPrompts.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.padding = '20px';
      emptyMsg.style.textAlign = 'center';
      emptyMsg.style.color = 'var(--text-secondary)';
      emptyMsg.style.fontSize = '0.75rem';
      emptyMsg.textContent = 'No custom prompts yet. Click "Add New Prompt" to create one.';
      customPromptsList.appendChild(emptyMsg);
      return;
    }

    state.customPrompts.forEach((prompt, index) => {
      const card = document.createElement('div');
      card.className = 'custom-prompt-card';

      const info = document.createElement('div');
      info.className = 'custom-prompt-card__info';

      const name = document.createElement('div');
      name.className = 'custom-prompt-card__name';
      name.textContent = prompt.name;

      const desc = document.createElement('div');
      desc.className = 'custom-prompt-card__desc';
      desc.textContent = prompt.description;

      info.appendChild(name);
      info.appendChild(desc);

      const actions = document.createElement('div');
      actions.className = 'custom-prompt-card__actions';

      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'custom-prompt-card__btn';
      editBtn.title = 'Edit prompt';
      editBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      `;
      editBtn.addEventListener('click', () => openEditPromptModal(index));

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'custom-prompt-card__btn custom-prompt-card__btn--delete';
      deleteBtn.title = 'Delete prompt';
      deleteBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      `;
      deleteBtn.addEventListener('click', () => deletePrompt(index));

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      card.appendChild(info);
      card.appendChild(actions);

      customPromptsList.appendChild(card);
    });
  }

  /**
   * Open the management modal
   */
  function openManagePromptsModal() {
    customPromptsModal.classList.remove('hidden');
    renderCustomPromptsList();
    closeQuickPromptsDropdown();
  }

  /**
   * Close the management modal
   */
  function closeManagePromptsModal() {
    customPromptsModal.classList.add('hidden');
  }

  /**
   * Open the editor modal for adding a new prompt
   */
  function openAddPromptModal() {
    state.editingPromptIndex = null;
    editorModalTitle.textContent = 'Add Custom Prompt';
    promptName.value = '';
    promptDescription.value = '';
    promptContent.value = '';
    promptEditorModal.classList.remove('hidden');
  }

  /**
   * Open the editor modal for editing an existing prompt
   */
  function openEditPromptModal(index) {
    state.editingPromptIndex = index;
    const prompt = state.customPrompts[index];
    editorModalTitle.textContent = 'Edit Custom Prompt';
    promptName.value = prompt.name;
    promptDescription.value = prompt.description;
    promptContent.value = prompt.content;
    promptEditorModal.classList.remove('hidden');
    closeManagePromptsModal();
  }

  /**
   * Close the editor modal
   */
  function closeEditorModal() {
    promptEditorModal.classList.add('hidden');
    state.editingPromptIndex = null;
  }

  /**
   * Save a prompt (add or edit)
   */
  async function savePrompt() {
    const name = promptName.value.trim();
    const description = promptDescription.value.trim();
    const content = promptContent.value.trim();

    if (!name || !description || !content) {
      alert('Please fill in all fields');
      return;
    }

    const prompt = { name, description, content };

    if (state.editingPromptIndex !== null) {
      // Edit existing
      state.customPrompts[state.editingPromptIndex] = prompt;
    } else {
      // Add new
      state.customPrompts.push(prompt);
    }

    await saveCustomPrompts();
    renderCustomPromptsInDropdown();
    renderCustomPromptsList();
    closeEditorModal();
    openManagePromptsModal();
  }

  /**
   * Delete a prompt
   */
  async function deletePrompt(index) {
    const prompt = state.customPrompts[index];
    if (!confirm(`Are you sure you want to delete "${prompt.name}"?`)) {
      return;
    }

    state.customPrompts.splice(index, 1);
    await saveCustomPrompts();
    renderCustomPromptsInDropdown();
    renderCustomPromptsList();
  }

  // Event listeners for custom prompts
  managePromptsBtn.addEventListener('click', openManagePromptsModal);
  closeModalBtn.addEventListener('click', closeManagePromptsModal);
  addPromptBtn.addEventListener('click', openAddPromptModal);
  closeEditorBtn.addEventListener('click', closeEditorModal);
  cancelPromptBtn.addEventListener('click', closeEditorModal);
  savePromptBtn.addEventListener('click', savePrompt);

  // Close modals when clicking overlay
  customPromptsModal.querySelector('.modal__overlay').addEventListener('click', closeManagePromptsModal);
  promptEditorModal.querySelector('.modal__overlay').addEventListener('click', closeEditorModal);

  // Load custom prompts on init
  loadCustomPrompts();

  // ========== AUTO-UPDATE NOTIFICATION ==========

  const updateNotification = document.getElementById('updateNotification');
  const updateTitle = document.getElementById('updateTitle');
  const updateMessage = document.getElementById('updateMessage');
  const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
  const dismissUpdateBtn = document.getElementById('dismissUpdateBtn');
  const updateProgress = document.getElementById('updateProgress');
  const updateProgressFill = document.getElementById('updateProgressFill');
  const updateProgressText = document.getElementById('updateProgressText');

  let currentUpdateVersion = null;

  /**
   * Show update notification
   */
  function showUpdateNotification(version, message) {
    currentUpdateVersion = version;
    updateTitle.textContent = 'Update Available';
    updateMessage.textContent = message || `Version ${version} is ready to download`;
    updateNotification.classList.remove('hidden');
    updateProgress.classList.add('hidden');
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
    downloadUpdateBtn.textContent = 'Restart & Install';
    downloadUpdateBtn.onclick = async () => {
      const { installUpdate } = window.claudebox || {};
      if (installUpdate) {
        await installUpdate();
      }
    };
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
    const { downloadUpdate } = window.claudebox || {};
    if (!downloadUpdate) return;

    try {
      downloadUpdateBtn.disabled = true;
      downloadUpdateBtn.textContent = 'Downloading...';
      await downloadUpdate();
    } catch (error) {
      console.error('[renderer] Failed to download update', error);
      alert(`Failed to download update: ${error.message}`);
      downloadUpdateBtn.disabled = false;
      downloadUpdateBtn.textContent = 'Download';
    }
  });

  // Dismiss update button
  dismissUpdateBtn.addEventListener('click', () => {
    hideUpdateNotification();
  });

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

  // Set default directory to user's home directory
  try {
    const { getUserHome } = window.claudebox || {};
    if (getUserHome) {
      const { path: homePath } = await getUserHome();
      if (homePath) {
        elements.sessionDirInput.value = homePath;
        // Update branch info for the home directory
        await updateBranchInfo();
      }
    }
  } catch (error) {
    console.error('[renderer] Failed to set default directory', error);
  }

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
