const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTranslations: () => ipcRenderer.invoke('get-translations'),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  setLocale: (lang) => ipcRenderer.invoke('set-locale', lang),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
  launchGame: (profile) => ipcRenderer.invoke('launch-game', profile),
  openGameFolder: () => ipcRenderer.invoke('open-game-folder'),
  onWindowStateChange: (callback) => ipcRenderer.on('window-state', (event, isMaximized) => callback(isMaximized)),
  isMaximized: () => ipcRenderer.invoke('is-maximized'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickJava: () => ipcRenderer.invoke('pick-java'),
  getSystemRam: () => ipcRenderer.invoke('get-system-ram')
});
