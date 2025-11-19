const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

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
const OPENCODE_COMMAND = 'opencode';
const GEMINI_COMMAND = 'gemini --yolo';

// Tool installation configuration
const TOOL_CONFIG = {
  claude: {
    checkCommand: 'claude --version',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    displayName: 'Claude Code',
    package: '@anthropic-ai/claude-code'
  },
  codex: {
    checkCommand: 'codex --version',
    installCommand: 'npm install -g @openai/codex',
    displayName: 'Codex',
    package: '@openai/codex'
  },
  opencode: {
    checkCommand: 'opencode --version',
    installCommand: 'npm install -g opencode-ai@latest',
    displayName: 'OpenCode',
    package: 'opencode-ai'
  },
  gemini: {
    checkCommand: 'gemini --version',
    installCommand: 'npm install -g @google/gemini-cli',
    displayName: 'Gemini',
    package: '@google/gemini-cli'
  }
};

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

// Tool installation cache - stores check results to avoid repeated checks
const toolInstallCache = new Map();

const log = (...args) => console.log('[main]', ...args);
const warn = (...args) => console.warn('[main]', ...args);
const reportError = (...args) => console.error('[main]', ...args);

/**
 * Git integration utilities
 */

/**
 * Execute a git command in a specific directory
 * SECURITY: Uses execFile to prevent command injection attacks
 * @param {string} cwd - Working directory
 * @param {string[]} args - Git command arguments
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');

    // Use execFile instead of exec to prevent command injection
    // args are passed as an array, not concatenated into a shell command
    execFile('git', args, {
      cwd,
      timeout: 10000,
      shell: false,  // Explicitly disable shell to prevent injection
      maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large outputs
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * Validate git branch name to prevent command injection and invalid characters
 * SECURITY: Prevents malicious branch names from causing unexpected git behavior
 * @param {string} branchName - Branch name to validate
 * @returns {string} - Validated branch name
 * @throws {Error} - If branch name is invalid
 */
function validateBranchName(branchName) {
  if (!branchName || typeof branchName !== 'string') {
    throw new Error('Branch name must be a non-empty string');
  }

  const trimmed = branchName.trim();

  // Prevent argument injection (git commands could be confused by leading hyphens)
  if (trimmed.startsWith('-')) {
    throw new Error('Branch name cannot start with hyphen');
  }

  // Prevent path traversal
  if (trimmed.includes('..') || trimmed.includes('\\')) {
    throw new Error('Branch name contains invalid path characters');
  }

  // Git branch name restrictions (based on git-check-ref-format)
  // Cannot contain: ASCII control chars, space, ~, ^, :, ?, *, [, \
  // Cannot end with .lock, cannot contain @{, cannot be @
  const invalidChars = /[\x00-\x1f\x7f ~^:?*\[\\]/;
  if (invalidChars.test(trimmed)) {
    throw new Error('Branch name contains invalid characters');
  }

  if (trimmed.endsWith('.lock')) {
    throw new Error('Branch name cannot end with .lock');
  }

  if (trimmed.includes('@{') || trimmed === '@') {
    throw new Error('Branch name cannot contain @{ or be @');
  }

  // Prevent double dots
  if (trimmed.includes('..')) {
    throw new Error('Branch name cannot contain consecutive dots');
  }

  return trimmed;
}

/**
 * Get the current git branch for a directory
 * @param {string} cwd - Working directory
 * @returns {Promise<string|null>} - Branch name or null if not a git repo
 */
async function getCurrentBranch(cwd) {
  try {
    const { stdout } = await execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout;
  } catch (error) {
    log('Failed to get current branch:', error.message);
    return null;
  }
}

/**
 * Get all git branches for a directory
 * @param {string} cwd - Working directory
 * @returns {Promise<string[]>} - Array of branch names
 */
async function getAllBranches(cwd) {
  try {
    const { stdout } = await execGit(cwd, ['branch', '--list', '--format=%(refname:short)']);
    return stdout ? stdout.split('\n').filter(Boolean) : [];
  } catch (error) {
    log('Failed to get branches:', error.message);
    return [];
  }
}

/**
 * Create and checkout a new git branch
 * @param {string} cwd - Working directory
 * @param {string} branchName - Name of the new branch
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function createBranch(cwd, branchName) {
  try {
    const safeBranchName = validateBranchName(branchName);
    await execGit(cwd, ['checkout', '-b', safeBranchName]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Checkout an existing git branch
 * @param {string} cwd - Working directory
 * @param {string} branchName - Name of the branch to checkout
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function checkoutBranch(cwd, branchName) {
  try {
    const safeBranchName = validateBranchName(branchName);
    await execGit(cwd, ['checkout', safeBranchName]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check if a directory is a git repository
 * @param {string} cwd - Working directory
 * @returns {Promise<boolean>}
 */
async function isGitRepo(cwd) {
  try {
    await execGit(cwd, ['rev-parse', '--git-dir']);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Git Worktree Integration
 */

/**
 * Get the repository root directory
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} - Absolute path to repo root
 */
async function getRepoRoot(cwd) {
  try {
    const { stdout } = await execGit(cwd, ['rev-parse', '--show-toplevel']);
    return stdout;
  } catch (error) {
    throw new Error('Not a git repository');
  }
}

/**
 * Sanitize branch name for use in file paths
 * @param {string} branchName - Branch name (should already be validated)
 * @returns {string} - Sanitized name
 */
function sanitizeBranchNameForPath(branchName) {
  // Note: branchName should already be validated by validateBranchName()
  return branchName
    .replace(/\//g, '-')           // Replace slashes with dashes
    .replace(/[^a-zA-Z0-9-_]/g, '_') // Replace special chars with underscores
    .toLowerCase();                 // Lowercase for consistency
}

/**
 * Get ClaudeBox worktrees directory
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} - Path to .claudebox/worktrees
 */
async function getWorktreesDir(cwd) {
  const repoRoot = await getRepoRoot(cwd);
  const worktreesDir = path.join(repoRoot, '.claudebox', 'worktrees');

  // Ensure directory exists
  const fs = require('fs').promises;
  await fs.mkdir(worktreesDir, { recursive: true });

  return worktreesDir;
}

/**
 * List all git worktrees
 * @param {string} cwd - Working directory
 * @returns {Promise<Array<{path: string, branch: string, head: string}>>}
 */
async function listWorktrees(cwd) {
  try {
    const { stdout } = await execGit(cwd, [
      'worktree',
      'list',
      '--porcelain'
    ]);

    const worktrees = [];
    const lines = stdout.split('\n');
    let current = {};

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        current.path = line.substring('worktree '.length);
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring('branch '.length).replace('refs/heads/', '');
      } else if (line.startsWith('HEAD ')) {
        current.head = line.substring('HEAD '.length);
      } else if (line === '') {
        if (current.path) {
          worktrees.push(current);
          current = {};
        }
      }
    }

    // Add the last worktree if it wasn't followed by an empty line
    if (current.path) {
      worktrees.push(current);
    }

    return worktrees;
  } catch (error) {
    log('Failed to list worktrees:', error.message);
    return [];
  }
}

/**
 * Get worktree path for a branch
 * @param {string} cwd - Working directory
 * @param {string} branchName - Branch name
 * @returns {Promise<string|null>} - Worktree path or null
 */
async function getWorktreePath(cwd, branchName) {
  const worktrees = await listWorktrees(cwd);
  const worktree = worktrees.find(w => w.branch === branchName);
  return worktree ? worktree.path : null;
}

/**
 * Create a git worktree for a branch
 * SECURITY: Validates worktree path to prevent path traversal attacks
 * @param {string} cwd - Working directory
 * @param {string} branchName - Name of the branch
 * @param {boolean} createBranch - Whether to create a new branch
 * @returns {Promise<{success: boolean, worktreePath?: string, error?: string}>}
 */
async function createWorktree(cwd, branchName, createBranch = true) {
  try {
    // SECURITY: Validate branch name before any operations
    const safeBranchName = validateBranchName(branchName);
    const worktreesDir = await getWorktreesDir(cwd);
    const sanitizedName = sanitizeBranchNameForPath(safeBranchName);
    const worktreePath = path.join(worktreesDir, sanitizedName);

    // SECURITY: Validate the resolved path is actually under worktreesDir
    // This prevents path traversal attacks via malicious branch names
    const resolvedWorktreePath = path.resolve(worktreePath);
    const resolvedWorktreesDir = path.resolve(worktreesDir);

    if (!resolvedWorktreePath.startsWith(resolvedWorktreesDir + path.sep)) {
      return {
        success: false,
        error: 'Invalid branch name: path traversal detected'
      };
    }

    // Check if worktree already exists
    const fs = require('fs').promises;
    try {
      await fs.access(worktreePath);
      return {
        success: false,
        error: `Worktree already exists at ${worktreePath}`
      };
    } catch {
      // Directory doesn't exist, proceed
    }

    // Build git worktree add command
    const args = ['worktree', 'add'];
    if (createBranch) {
      args.push('-b', safeBranchName);
    }
    args.push(worktreePath);
    if (!createBranch) {
      args.push(safeBranchName);
    }

    await execGit(cwd, args);

    log(`Created worktree for ${safeBranchName} at ${worktreePath}`);
    return { success: true, worktreePath };
  } catch (error) {
    reportError('Failed to create worktree:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Check if a worktree is safe to remove (no uncommitted changes)
 * @param {string} worktreePath - Path to worktree
 * @returns {Promise<{safe: boolean, uncommittedChanges: boolean, error?: string}>}
 */
async function isWorktreeSafeToRemove(worktreePath) {
  try {
    // Check for uncommitted changes
    const { stdout: statusOutput } = await execGit(worktreePath, [
      'status', '--porcelain'
    ]);

    const uncommittedChanges = statusOutput.trim().length > 0;

    return {
      safe: !uncommittedChanges,
      uncommittedChanges
    };
  } catch (error) {
    return {
      safe: false,
      uncommittedChanges: false,
      error: error.message
    };
  }
}

/**
 * Remove a git worktree
 * @param {string} cwd - Working directory
 * @param {string} branchName - Branch name
 * @param {boolean} force - Force removal even with uncommitted changes
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function removeWorktree(cwd, branchName, force = false) {
  try {
    // Find worktree by branch name
    const worktrees = await listWorktrees(cwd);
    const worktree = worktrees.find(w => w.branch === branchName);

    if (!worktree) {
      return { success: false, error: 'Worktree not found' };
    }

    // Check if worktree is managed by ClaudeBox
    const worktreesDir = await getWorktreesDir(cwd);
    if (!worktree.path.includes(worktreesDir)) {
      return {
        success: false,
        error: 'Worktree is not managed by ClaudeBox'
      };
    }

    // Remove worktree
    const args = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktree.path);

    await execGit(cwd, args);

    log(`Removed worktree for ${branchName}`);
    return { success: true };
  } catch (error) {
    reportError('Failed to remove worktree:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Prune stale worktree metadata
 * @param {string} cwd - Working directory
 * @returns {Promise<void>}
 */
async function pruneWorktrees(cwd) {
  try {
    await execGit(cwd, ['worktree', 'prune']);
    log('Pruned stale worktrees');
  } catch (error) {
    log('Failed to prune worktrees:', error.message);
  }
}

/**
 * Worktree Metadata Management
 */

/**
 * Get worktree metadata file path
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} - Path to metadata file
 */
async function getWorktreeMetadataPath(cwd) {
  const repoRoot = await getRepoRoot(cwd);
  return path.join(repoRoot, '.claudebox', 'worktree-metadata.json');
}

/**
 * Load worktree metadata
 * @param {string} cwd - Working directory
 * @returns {Promise<{worktrees: object}>} - Metadata object
 */
async function loadWorktreeMetadata(cwd) {
  const fs = require('fs').promises;
  const metadataPath = await getWorktreeMetadataPath(cwd);

  try {
    const data = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return empty metadata
    return { worktrees: {} };
  }
}

/**
 * Save worktree metadata
 * @param {string} cwd - Working directory
 * @param {string} branchName - Branch name
 * @param {string} worktreePath - Worktree path
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function saveWorktreeMetadata(cwd, branchName, worktreePath, sessionId = null) {
  const fs = require('fs').promises;
  const metadataPath = await getWorktreeMetadataPath(cwd);

  const metadata = await loadWorktreeMetadata(cwd);

  if (!metadata.worktrees[branchName]) {
    metadata.worktrees[branchName] = {
      branch: branchName,
      path: worktreePath,
      createdAt: new Date().toISOString(),
      createdBy: sessionId,
      sessions: []
    };
  }

  // Add session if provided
  if (sessionId && !metadata.worktrees[branchName].sessions.includes(sessionId)) {
    metadata.worktrees[branchName].sessions.push(sessionId);
  }

  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Remove worktree metadata
 * @param {string} cwd - Working directory
 * @param {string} branchName - Branch name
 * @returns {Promise<void>}
 */
async function removeWorktreeMetadata(cwd, branchName) {
  const fs = require('fs').promises;
  const metadataPath = await getWorktreeMetadataPath(cwd);

  const metadata = await loadWorktreeMetadata(cwd);
  delete metadata.worktrees[branchName];

  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Track session in worktree
 * @param {string} cwd - Working directory
 * @param {string} branchName - Branch name
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function trackSessionInWorktree(cwd, branchName, sessionId) {
  const metadata = await loadWorktreeMetadata(cwd);

  if (metadata.worktrees[branchName]) {
    if (!metadata.worktrees[branchName].sessions.includes(sessionId)) {
      metadata.worktrees[branchName].sessions.push(sessionId);
      const metadataPath = await getWorktreeMetadataPath(cwd);
      const fs = require('fs').promises;
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    }
  }
}

/**
 * Untrack session from worktree
 * @param {string} cwd - Working directory
 * @param {string} branchName - Branch name
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function untrackSessionFromWorktree(cwd, branchName, sessionId) {
  const fs = require('fs').promises;
  const metadataPath = await getWorktreeMetadataPath(cwd);

  const metadata = await loadWorktreeMetadata(cwd);

  if (metadata.worktrees[branchName]) {
    metadata.worktrees[branchName].sessions =
      metadata.worktrees[branchName].sessions.filter(id => id !== sessionId);

    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }
}

/**
 * Get enhanced PATH with npm/nvm directories
 * @returns {string} - Enhanced PATH string
 */
function getEnhancedPath() {
  const homeDir = require('os').homedir();
  const fs = require('fs');
  const pathSeparator = process.platform === 'win32' ? ';' : ':';

  const additionalPaths = [];

  // Unix-like systems (Linux/macOS)
  if (process.platform !== 'win32') {
    // CRITICAL: Add paths where Node.js binary might be located
    // These are needed for npm-installed CLI tools that use #!/usr/bin/env node
    additionalPaths.push('/usr/local/bin');     // Common on Intel Macs
    additionalPaths.push('/opt/homebrew/bin');  // Common on Apple Silicon Macs

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

  return [...additionalPaths, process.env.PATH || ''].filter(Boolean).join(pathSeparator);
}

/**
 * Check if a CLI tool is installed by attempting to run its version command
 * Uses caching to avoid repeated checks for better performance
 * @param {string} type - The session type (claude, codex, opencode)
 * @param {boolean} skipCache - Force a fresh check, ignoring cache
 * @returns {Promise<boolean>} - True if the tool is installed, false otherwise
 */
async function checkToolInstalled(type, skipCache = false) {
  if (type === 'terminal') return true; // Terminal is always available

  const config = TOOL_CONFIG[type];
  if (!config) return false;

  // Check cache first (unless skipCache is true)
  if (!skipCache && toolInstallCache.has(type)) {
    const cached = toolInstallCache.get(type);
    log(`Using cached result for ${type}: ${cached}`);
    return cached;
  }

  // Perform actual check with enhanced PATH
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const env = { ...process.env, PATH: getEnhancedPath() };

    exec(config.checkCommand, { timeout: 5000, env }, (error, stdout, stderr) => {
      let isInstalled = !error;

      // Special validation for Gemini to ensure it's the Google AI CLI, not the Yandex screenshot tool
      if (type === 'gemini' && !error) {
        const output = (stdout + stderr).toLowerCase();
        // Check if output contains indicators it's the Google Gemini AI CLI
        // The Google CLI typically includes "gemini" or "google" or "@google" in version output
        // The Yandex tool will have different output
        const isGoogleGemini = output.includes('@google') ||
                               output.includes('gemini-cli') ||
                               output.includes('google') ||
                               // Also accept if it just shows a version number (like "0.10.0")
                               /^\d+\.\d+\.\d+/.test(output.trim());

        if (!isGoogleGemini) {
          log(`Found 'gemini' command but it doesn't appear to be Google's Gemini CLI (output: ${output.substring(0, 100)})`);
          isInstalled = false;
        }
      }

      // Cache the result
      toolInstallCache.set(type, isInstalled);
      log(`Checked ${type} installation: ${isInstalled} (PATH: ${env.PATH.substring(0, 100)}...)`);

      resolve(isInstalled);
    });
  });
}

/**
 * Install a CLI tool using npm
 * Clears the cache and re-checks installation after completion
 * @param {string} type - The session type (claude, codex, opencode)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function installTool(type) {
  const config = TOOL_CONFIG[type];
  if (!config) {
    return { success: false, error: 'Unknown tool type' };
  }

  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const env = { ...process.env, PATH: getEnhancedPath() };
    log(`Installing ${config.displayName}...`);

    exec(config.installCommand, { timeout: 300000, env }, async (error, stdout, stderr) => {
      if (error) {
        reportError(`Failed to install ${config.displayName}:`, error);
        resolve({
          success: false,
          error: `Installation failed: ${error.message}\n${stderr}`
        });
      } else {
        log(`Successfully installed ${config.displayName}`);

        // Clear cache and verify installation
        toolInstallCache.delete(type);
        const verified = await checkToolInstalled(type, true);

        if (verified) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: 'Installation completed but tool verification failed. You may need to restart the app.'
          });
        }
      }
    });
  });
}

function buildSessionMetadata(type) {
  if (!['claude', 'codex', 'opencode', 'gemini', 'terminal'].includes(type)) {
    throw new Error(`Unsupported session type: ${type}`);
  }

  const command = type === 'claude' ? CLAUDE_COMMAND :
                  (type === 'codex' ? CODEX_COMMAND :
                  (type === 'opencode' ? OPENCODE_COMMAND :
                  (type === 'gemini' ? GEMINI_COMMAND : null)));
  const title = type === 'claude' ? 'Claude Code' :
                (type === 'codex' ? 'Codex' :
                (type === 'opencode' ? 'OpenCode' :
                (type === 'gemini' ? 'Gemini' : 'Terminal')));

  const id = `session-${Date.now()}-${++sessionCounter}`;

  return { id, type, title, command };
}

function spawnShell(command, cols, rows, cwd) {
  const env = {
    ...process.env,
    PATH: getEnhancedPath()
  };

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

  // SECURITY: Implement Content Security Policy for defense-in-depth
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +  // unsafe-inline needed for terminal styles
          "img-src 'self' data: file:; " +
          "font-src 'self' data:; " +
          "connect-src 'self'"
        ]
      }
    });
  });

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
  // Check if a tool is installed
  ipcMain.handle('tool:checkInstalled', async (_event, { type, skipCache = false }) => {
    try {
      const installed = await checkToolInstalled(type, skipCache);
      return { installed, toolConfig: TOOL_CONFIG[type] };
    } catch (error) {
      reportError('failed to check tool installation', error);
      return { installed: false, error: error.message };
    }
  });

  // Install a tool
  ipcMain.handle('tool:install', async (_event, { type }) => {
    try {
      const result = await installTool(type);
      return result;
    } catch (error) {
      reportError('failed to install tool', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('session:create', async (_event, { type, cwd, worktreeMode, branchName }) => {
    try {
      // Check if tool is installed first (skip for terminal)
      if (type !== 'terminal') {
        const installed = await checkToolInstalled(type);
        if (!installed) {
          const config = TOOL_CONFIG[type];
          throw new Error(`TOOL_NOT_INSTALLED:${type}:${config?.displayName || type}`);
        }
      }

      const initialSize = { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS };
      const meta = buildSessionMetadata(type);

      let sessionCwd = cwd || process.cwd();
      let worktreeInfo = null;
      let sessionBranch = branchName || null;

      // Auto-detect if we're already in a worktree (even without branch mode)
      // BUT only if no branch was explicitly selected from the UI
      if (!worktreeMode && !sessionBranch) {
        try {
          const isRepo = await isGitRepo(sessionCwd);
          if (isRepo) {
            const worktrees = await listWorktrees(sessionCwd);
            const repoRoot = await getRepoRoot(sessionCwd);

            // Find the most specific worktree (longest path match)
            // This prevents matching the main repo when we're in a worktree subdirectory
            const matchingWorktrees = worktrees.filter(wt =>
              sessionCwd.includes(wt.path) || wt.path.includes(sessionCwd)
            );

            // Sort by path length (descending) to get the most specific match
            const currentWorktree = matchingWorktrees.sort((a, b) =>
              b.path.length - a.path.length
            )[0];

            if (currentWorktree && currentWorktree.branch) {
              sessionBranch = currentWorktree.branch;

              // Only set enabled: true if we're actually in a worktree directory (not the main repo)
              const isInWorktreeDir = currentWorktree.path.includes('.claudebox') &&
                                      currentWorktree.path.includes('worktrees');

              if (isInWorktreeDir) {
                const mainBranches = ['main', 'master'];
                const isMainBranch = mainBranches.includes(sessionBranch);

                worktreeInfo = {
                  enabled: true,
                  path: currentWorktree.path,
                  isMain: isMainBranch,
                  repoRoot: repoRoot
                };

                // Track this session in the worktree metadata
                if (!isMainBranch) {
                  await trackSessionInWorktree(repoRoot, sessionBranch, meta.id);
                }

                log(`Auto-detected worktree for branch ${sessionBranch}`);
              }
            }
          }
        } catch (error) {
          log('Failed to auto-detect worktree:', error.message);
        }
      }

      // Handle worktree creation if branch mode is enabled
      if (worktreeMode && branchName) {
        const isRepo = await isGitRepo(sessionCwd);

        if (!isRepo) {
          log('Directory is not a git repository, ignoring branch mode');
        } else {
          // Determine if this is the main branch
          const currentBranch = await getCurrentBranch(sessionCwd);
          const mainBranches = ['main', 'master'];
          const isMainBranch = mainBranches.includes(branchName) || branchName === currentBranch;

          if (isMainBranch) {
            // Use main repository directory for main branch
            sessionBranch = branchName;
            worktreeInfo = {
              enabled: true,
              path: sessionCwd,
              isMain: true,
              repoRoot: await getRepoRoot(sessionCwd)
            };
            log(`Using main repo directory for branch ${branchName}`);
          } else {
            // Create or get worktree for the branch
            let worktreePath = await getWorktreePath(sessionCwd, branchName);

            if (!worktreePath) {
              // Create new worktree
              log(`Creating new worktree for branch ${branchName}`);
              const createResult = await createWorktree(sessionCwd, branchName, true);

              if (!createResult.success) {
                throw new Error(`Failed to create worktree: ${createResult.error}`);
              }

              worktreePath = createResult.worktreePath;

              // Save metadata
              await saveWorktreeMetadata(sessionCwd, branchName, worktreePath, meta.id);
            } else {
              log(`Using existing worktree for branch ${branchName}`);
              // Track this session in existing worktree
              await trackSessionInWorktree(sessionCwd, branchName, meta.id);
            }

            // Update session CWD to point to worktree
            sessionCwd = worktreePath;
            sessionBranch = branchName;

            worktreeInfo = {
              enabled: true,
              path: worktreePath,
              isMain: false,
              repoRoot: await getRepoRoot(cwd)
            };
          }
        }
      }

      // If branch was explicitly selected but worktreeMode is off, checkout to that branch
      if (!worktreeMode && branchName && sessionBranch) {
        try {
          const isRepo = await isGitRepo(sessionCwd);
          if (isRepo) {
            const currentBranch = await getCurrentBranch(sessionCwd);
            if (currentBranch !== branchName) {
              log(`Switching from branch ${currentBranch} to ${branchName}`);
              // Check out the selected branch
              await exec(`git checkout ${branchName}`, { cwd: sessionCwd });
              sessionBranch = branchName;
            }
          }
        } catch (error) {
          log(`Failed to checkout branch ${branchName}: ${error.message}`);
          // Continue with session creation even if branch switch fails
        }
      }

      const ptyProcess = spawnShell(meta.command, initialSize.cols, initialSize.rows, sessionCwd);

      const session = {
        ...meta,
        status: 'running',
        createdAt: new Date().toISOString(),
        cwd: sessionCwd,
        pty: ptyProcess,
        exitCode: null,
        branch: sessionBranch,
        worktree: worktreeInfo
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
        branch: session.branch,
        worktree: session.worktree
      };
    } catch (error) {
      reportError('failed to create session', error);
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
      branch: session.branch,
      worktree: session.worktree
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

  ipcMain.handle('session:dispose', async (_event, { id }) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }

    // CRITICAL FIX: Wait for graceful termination before cleanup
    // This prevents race conditions where we check for uncommitted changes
    // while the process is still writing to the worktree
    if (session.status === 'running') {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000); // Max 5s wait

        const checkExit = () => {
          if (session.status === 'exited') {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(checkExit, 100);
          }
        };

        terminateSession(session);
        checkExit();
      });

      // Additional grace period for filesystem operations to complete
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Cleanup worktree tracking and potentially remove worktree
    if (session.worktree && session.worktree.enabled && !session.worktree.isMain) {
      try {
        const repoRoot = session.worktree.repoRoot || session.cwd;

        // Untrack session from worktree metadata
        await untrackSessionFromWorktree(repoRoot, session.branch, session.id);

        // Check if worktree is still in use by other sessions
        const metadata = await loadWorktreeMetadata(repoRoot);
        const worktreeData = metadata.worktrees[session.branch];

        if (worktreeData && worktreeData.sessions.length === 0) {
          // No other sessions using this worktree, check if safe to remove
          const safetyCheck = await isWorktreeSafeToRemove(session.worktree.path);

          if (safetyCheck.safe) {
            // Remove worktree immediately
            log(`Removing worktree for ${session.branch} (no uncommitted changes)`);
            await removeWorktree(repoRoot, session.branch, false);
            await removeWorktreeMetadata(repoRoot, session.branch);
          } else if (safetyCheck.uncommittedChanges) {
            // Uncommitted changes exist, warn but don't remove
            warn(`Worktree ${session.branch} has uncommitted changes, not removing automatically`);
          }
        } else {
          log(`Worktree for ${session.branch} still in use by other sessions`);
        }
      } catch (error) {
        reportError('Failed to cleanup worktree:', error);
      }
    }

    sessions.delete(id);
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

  // Show input dialog for branch name
  ipcMain.handle('dialog:getBranchName', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return null;
    }

    // Create a simple HTML dialog for text input
    const inputWin = new BrowserWindow({
      parent: win,
      modal: true,
      width: 400,
      height: 180,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        // Disable web security to allow inline scripts in data URLs
        webSecurity: false
      }
    });

    inputWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0d0d0d;
            color: #e8e8e8;
            padding: 20px;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: calc(100vh - 40px);
          }
          h3 {
            margin: 0 0 15px 0;
            font-size: 14px;
            font-weight: 500;
          }
          input {
            width: 100%;
            padding: 8px 12px;
            background: #1a1a1a;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 5px;
            color: #e8e8e8;
            font-size: 13px;
            font-family: 'JetBrains Mono', monospace;
            outline: none;
            box-sizing: border-box;
          }
          input:focus {
            border-color: rgba(255, 107, 53, 0.5);
          }
          .buttons {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: auto;
          }
          button {
            padding: 8px 20px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 5px;
            font-size: 13px;
            cursor: pointer;
            outline: none;
          }
          button.primary {
            background: rgba(255, 107, 53, 0.2);
            border-color: rgba(255, 107, 53, 0.5);
            color: #ffb89d;
          }
          button.primary:hover {
            background: rgba(255, 107, 53, 0.3);
          }
          button.secondary {
            background: #1a1a1a;
            color: #e8e8e8;
          }
          button.secondary:hover {
            background: #1f1f1f;
          }
        </style>
      </head>
      <body>
        <h3>Enter branch name:</h3>
        <input type="text" id="branchInput" placeholder="e.g., feature/my-new-feature" autofocus />
        <div class="buttons">
          <button class="secondary" id="cancelBtn">Cancel</button>
          <button class="primary" id="submitBtn">Create Branch</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');

          // Make functions global so they're accessible everywhere
          window.submit = function() {
            console.log('SUBMIT CALLED');
            const input = document.getElementById('branchInput');
            const value = input.value.trim();
            if (value) {
              ipcRenderer.send('branch-name-result', value);
              window.close();
            }
          };

          window.cancel = function() {
            console.log('CANCEL CALLED');
            ipcRenderer.send('branch-name-result', null);
            window.close();
          };

          // Execute immediately (script is at end of body, DOM is ready)
          const input = document.getElementById('branchInput');
          const cancelBtn = document.getElementById('cancelBtn');
          const submitBtn = document.getElementById('submitBtn');

          console.log('Elements found:', {
            input: !!input,
            cancelBtn: !!cancelBtn,
            submitBtn: !!submitBtn
          });

          // Try multiple event types
          if (cancelBtn) {
            cancelBtn.onclick = function(e) {
              console.log('Cancel onclick fired');
              window.cancel();
            };
            cancelBtn.addEventListener('click', function(e) {
              console.log('Cancel addEventListener click fired');
              window.cancel();
            });
            cancelBtn.addEventListener('mousedown', function(e) {
              console.log('Cancel mousedown fired');
              window.cancel();
            });
          }

          if (submitBtn) {
            submitBtn.onclick = function(e) {
              console.log('Submit onclick fired');
              window.submit();
            };
            submitBtn.addEventListener('click', function(e) {
              console.log('Submit addEventListener click fired');
              window.submit();
            });
          }

          if (input) {
            input.onkeypress = function(e) {
              if (e.key === 'Enter') {
                console.log('Enter key pressed');
                window.submit();
              }
            };
          }

          document.onkeydown = function(e) {
            if (e.key === 'Escape') {
              console.log('Escape key pressed');
              window.cancel();
            }
          };

          // Log that script loaded
          console.log('Branch dialog script loaded');
        </script>
      </body>
      </html>
    `)}`);

    // Open DevTools for debugging
    inputWin.webContents.openDevTools({ mode: 'detach' });

    return new Promise((resolve) => {
      const { ipcMain } = require('electron');

      const resultHandler = (_event, branchName) => {
        ipcMain.removeListener('branch-name-result', resultHandler);
        resolve(branchName);
      };

      ipcMain.on('branch-name-result', resultHandler);

      inputWin.on('closed', () => {
        ipcMain.removeListener('branch-name-result', resultHandler);
        resolve(null);
      });
    });
  });

  // Open an external terminal window at a directory
  ipcMain.handle('terminal:open', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();

      if (process.platform === 'win32') {
        // Prefer PowerShell in a new window via cmd's start
        // SECURITY: Escape PowerShell special characters to prevent command injection
        const escapePowerShellPath = (path) => {
          // Escape backticks, dollar signs, double quotes, and single quotes
          return path.replace(/[`$"']/g, '`$&');
        };
        const escapedPath = escapePowerShellPath(targetDir);
        const cmd = 'cmd.exe';
        const args = ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', `Set-Location -LiteralPath '${escapedPath}'`];
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

  // Get user's home directory
  ipcMain.handle('system:getUserHome', async () => {
    try {
      const os = require('os');
      const homeDir = os.homedir();
      return { path: homeDir };
    } catch (error) {
      reportError('failed to get user home directory', error);
      return { path: null, error: error.message };
    }
  });

  // Settings storage
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  const ensureSettingsDir = async () => {
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  };
  const settingsFileExists = async () => {
    try {
      await fsPromises.access(settingsPath, fs.constants.F_OK);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  };

  // Load settings
  ipcMain.handle('settings:load', async () => {
    try {
      await ensureSettingsDir();
      if (!(await settingsFileExists())) {
        return { settings: {} };
      }
      const data = await fsPromises.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(data);
      return { settings };
    } catch (error) {
      reportError('failed to load settings', error);
      return { settings: {}, error: error.message };
    }
  });

  // Save settings
  ipcMain.handle('settings:save', async (_event, { settings }) => {
    try {
      await ensureSettingsDir();
      await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      return { success: true };
    } catch (error) {
      reportError('failed to save settings', error);
      return { success: false, error: error.message };
    }
  });

  // Git integration handlers
  ipcMain.handle('git:isRepo', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const isRepo = await isGitRepo(targetDir);
      return { isRepo };
    } catch (error) {
      reportError('failed to check if directory is git repo', error);
      return { isRepo: false, error: error.message };
    }
  });

  ipcMain.handle('git:getCurrentBranch', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const branch = await getCurrentBranch(targetDir);
      return { branch };
    } catch (error) {
      reportError('failed to get current branch', error);
      return { branch: null, error: error.message };
    }
  });

  ipcMain.handle('git:getAllBranches', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const branches = await getAllBranches(targetDir);
      return { branches };
    } catch (error) {
      reportError('failed to get branches', error);
      return { branches: [], error: error.message };
    }
  });

  ipcMain.handle('git:createBranch', async (_event, { cwd, branchName }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const result = await createBranch(targetDir, branchName);
      return result;
    } catch (error) {
      reportError('failed to create branch', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:checkoutBranch', async (_event, { cwd, branchName }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const result = await checkoutBranch(targetDir, branchName);
      return result;
    } catch (error) {
      reportError('failed to checkout branch', error);
      return { success: false, error: error.message };
    }
  });

  // Worktree management handlers
  ipcMain.handle('git:listWorktrees', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const worktrees = await listWorktrees(targetDir);
      return { worktrees };
    } catch (error) {
      reportError('failed to list worktrees', error);
      return { worktrees: [], error: error.message };
    }
  });

  ipcMain.handle('git:createWorktree', async (_event, { cwd, branchName, createBranch }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const result = await createWorktree(targetDir, branchName, createBranch !== false);
      return result;
    } catch (error) {
      reportError('failed to create worktree', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:removeWorktree', async (_event, { cwd, branchName, force }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const result = await removeWorktree(targetDir, branchName, force === true);
      return result;
    } catch (error) {
      reportError('failed to remove worktree', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:getWorktreePath', async (_event, { cwd, branchName }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      const path = await getWorktreePath(targetDir, branchName);
      return { path };
    } catch (error) {
      reportError('failed to get worktree path', error);
      return { path: null, error: error.message };
    }
  });

  ipcMain.handle('git:pruneWorktrees', async (_event, { cwd }) => {
    try {
      const targetDir = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
      await pruneWorktrees(targetDir);
      return { success: true };
    } catch (error) {
      reportError('failed to prune worktrees', error);
      return { success: false, error: error.message };
    }
  });

  // Auto-updater handlers
  ipcMain.handle('updater:checkForUpdates', async () => {
    if (isDev) {
      return { available: false, message: 'Updates disabled in development mode' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, updateInfo: result?.updateInfo };
    } catch (error) {
      reportError('failed to check for updates', error);
      return { available: false, error: error.message };
    }
  });

  ipcMain.handle('updater:downloadUpdate', async () => {
    if (isDev) {
      return { success: false, message: 'Updates disabled in development mode' };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      reportError('failed to download update', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('updater:installUpdate', () => {
    if (isDev) {
      return;
    }
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('updater:getVersion', () => {
    return { version: app.getVersion() };
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

// Auto-updater configuration
const isDev = !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === 'development';

// Disable auto-updater in development
if (!isDev) {
  // SECURITY NOTE: Updates are currently unsigned (verifyUpdateCodeSignature: false in package.json)
  // For production use, consider implementing code signing:
  // 1. Obtain a code signing certificate
  // 2. Configure signing in package.json: "win": { "sign": "./sign.js" }
  // 3. Enable verification: "verifyUpdateCodeSignature": true
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    log('Update available:', info.version);
    broadcast('update:available', { version: info.version, releaseNotes: info.releaseNotes });
  });

  autoUpdater.on('update-not-available', () => {
    log('No updates available');
    broadcast('update:not-available');
  });

  autoUpdater.on('error', (err) => {
    reportError('Auto-updater error:', err);
    broadcast('update:error', { message: err.message });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    broadcast('update:download-progress', {
      percent: progressObj.percent,
      transferred: progressObj.transferred,
      total: progressObj.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('Update downloaded:', info.version);
    broadcast('update:downloaded', { version: info.version });
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.samkl.claudebox');
  }

  createWindow();
  registerIpcHandlers();

  // Check for updates on startup (production only)
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        reportError('Failed to check for updates:', err);
      });
    }, 3000); // Wait 3 seconds after startup
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
