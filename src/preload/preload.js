const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('claudebox', {
  createSession: (type, cwd, worktreeMode, branchName) => invoke('session:create', { type, cwd, worktreeMode, branchName }),
  listSessions: () => invoke('session:list'),
  write: (id, data) => invoke('session:write', { id, data }),
  resize: (id, cols, rows) => invoke('session:resize', { id, cols, rows }),
  terminate: (id) => invoke('session:terminate', { id }),
  dispose: (id) => invoke('session:dispose', { id }),
  renameSession: (id, newTitle) => invoke('session:rename', { id, newTitle }),
  onSessionData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('session:data', listener);
    return () => ipcRenderer.removeListener('session:data', listener);
  },
  onSessionExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('session:exit', listener);
    return () => ipcRenderer.removeListener('session:exit', listener);
  },
  // Tool installation
  checkToolInstalled: (type) => invoke('tool:checkInstalled', { type }),
  installTool: (type) => invoke('tool:install', { type }),
  // Window controls
  windowMinimize: () => invoke('window:minimize'),
  windowMaximize: () => invoke('window:maximize'),
  windowClose: () => invoke('window:close'),
  // Directory selection
  selectDirectory: () => invoke('dialog:selectDirectory'),
  // External terminal
  openExternalTerminal: (cwd) => invoke('terminal:open', { cwd }),
  // System
  getUserHome: () => invoke('system:getUserHome'),
  // Settings
  loadSettings: () => invoke('settings:load'),
  saveSettings: (settings) => invoke('settings:save', { settings }),
  // Auto-updater
  checkForUpdates: () => invoke('updater:checkForUpdates'),
  downloadUpdate: () => invoke('updater:downloadUpdate'),
  installUpdate: () => invoke('updater:installUpdate'),
  getAppVersion: () => invoke('updater:getVersion'),
  onUpdateAvailable: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:downloaded', listener);
    return () => ipcRenderer.removeListener('update:downloaded', listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:download-progress', listener);
    return () => ipcRenderer.removeListener('update:download-progress', listener);
  },
  onUpdateError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:error', listener);
    return () => ipcRenderer.removeListener('update:error', listener);
  },
  // Git integration
  gitIsRepo: (cwd) => invoke('git:isRepo', { cwd }),
  gitGetCurrentBranch: (cwd) => invoke('git:getCurrentBranch', { cwd }),
  gitGetAllBranches: (cwd) => invoke('git:getAllBranches', { cwd }),
  gitCreateBranch: (cwd, branchName) => invoke('git:createBranch', { cwd, branchName }),
  gitCheckoutBranch: (cwd, branchName) => invoke('git:checkoutBranch', { cwd, branchName }),
  // Worktree management
  gitListWorktrees: (cwd) => invoke('git:listWorktrees', { cwd }),
  gitCreateWorktree: (cwd, branchName, createBranch) => invoke('git:createWorktree', { cwd, branchName, createBranch }),
  gitRemoveWorktree: (cwd, branchName, force) => invoke('git:removeWorktree', { cwd, branchName, force }),
  gitGetWorktreePath: (cwd, branchName) => invoke('git:getWorktreePath', { cwd, branchName }),
  gitPruneWorktrees: (cwd) => invoke('git:pruneWorktrees', { cwd })
});
