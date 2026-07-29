const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accountConsole', {
  openEmbedded: (payload) => ipcRenderer.invoke('embedded:open', payload),
  extractProfile: (accountId) => ipcRenderer.invoke('embedded:extract-profile', accountId),
  navigateEmbedded: (action) => ipcRenderer.invoke('embedded:navigate', action),
  onProfileReady: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('embedded:profile-ready', listener);
    return () => ipcRenderer.removeListener('embedded:profile-ready', listener);
  },
  setEmbeddedBounds: (bounds) => ipcRenderer.send('embedded:bounds', bounds),
  hideEmbedded: () => ipcRenderer.send('embedded:hide'),
  switchWorkspaceTab: (accountId) => ipcRenderer.invoke('workspace:switch', accountId),
  closeWorkspaceTab: (accountId) => ipcRenderer.invoke('workspace:close', accountId),
  adoptLoginSession: (payload) => ipcRenderer.invoke('account-login:adopt', payload),
  cancelLoginSessionView: (payload) => ipcRenderer.invoke('account-login:cancel-view', payload),
  beginAccountLogin: (payload) => ipcRenderer.invoke('account-login:begin', payload),
  inspectAccountLogin: (payload) => ipcRenderer.invoke('account-login:inspect', payload),
  cancelAccountLogin: (payload) => ipcRenderer.invoke('account-login:cancel', payload),
  fetchHomepageProfile: (payload) => ipcRenderer.invoke('profile:fetch-homepage', payload),
  discoverProfile: (payload) => ipcRenderer.invoke('profile:discover', payload),
  collectRun: (payload) => ipcRenderer.invoke('collect:run', payload),
  collectStop: () => ipcRenderer.invoke('collect:stop'),
  collectOpenLogin: (platform) => ipcRenderer.invoke('collect:open-login', platform),
  updateSchedule: (config) => ipcRenderer.invoke('collect:update-schedule', config),
  getGeneralState: () => ipcRenderer.invoke('settings:get'),
  setAutostart: (payload) => ipcRenderer.invoke('settings:set-autostart', payload),
  updateGeneral: (config) => ipcRenderer.invoke('settings:update-general', config),
  openDataDir: () => ipcRenderer.invoke('settings:open-data-dir'),
  onCollectProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('collect:progress', listener);
    return () => ipcRenderer.removeListener('collect:progress', listener);
  },
  isElectron: true,
});
