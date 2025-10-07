const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('claudebox', {
  createSession: (type, cwd) => invoke('session:create', { type, cwd }),
  listSessions: () => invoke('session:list'),
  write: (id, data) => invoke('session:write', { id, data }),
  resize: (id, cols, rows) => invoke('session:resize', { id, cols, rows }),
  terminate: (id) => invoke('session:terminate', { id }),
  dispose: (id) => invoke('session:dispose', { id }),
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
  // Window controls
  windowMinimize: () => invoke('window:minimize'),
  windowMaximize: () => invoke('window:maximize'),
  windowClose: () => invoke('window:close'),
  // Directory selection
  selectDirectory: () => invoke('dialog:selectDirectory')
});
