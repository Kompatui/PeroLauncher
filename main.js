const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');

Menu.setApplicationMenu(null);

let currentLocale = 'ru';

const settingsPath = 'D:\\PeroLauncherData\\settings.json';

const defaultSettings = {
  version: '1.21.1',
  accountName: null,
  ram: 4096,
  ramAuto: true,
  windowWidth: 854,
  windowHeight: 480,
  fullscreen: false,
  gameFolder: 'D:\\PeroLauncherData',
  language: 'ru',
  javaPath: null,
  versionFilters: {
    loadFromServer: true,
    mods: true,
    alpha: false,
    experimental: true,
    onlyInstalled: false,
    snapshots: false,
    beta: false,
    launchers: false,
    oldReleases: true
  }
};

function loadSettings() {
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
    return { ...defaultSettings };
  }
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    ...defaultSettings,
    ...parsed,
    versionFilters: { ...defaultSettings.versionFilters, ...(parsed.versionFilters || {}) }
  };
}

function saveSettingsToDisk(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function loadTranslations(lang) {
  const filePath = path.join(__dirname, 'locales', `${lang}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 400,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');
  win.webContents.openDevTools({ mode: 'right' });

  win.on('maximize', () => win.webContents.send('window-state', true));
  win.on('unmaximize', () => win.webContents.send('window-state', false));

  ipcMain.on('window-minimize', () => win.minimize());
  ipcMain.on('window-maximize', () => {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('window-close', () => win.close());
}

ipcMain.handle('is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender).isMaximized();
});

ipcMain.handle('get-translations', () => loadTranslations(currentLocale));
ipcMain.handle('get-locale', () => currentLocale);
ipcMain.handle('set-locale', (event, lang) => {
  currentLocale = lang;
  return loadTranslations(currentLocale);
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (event, settings) => {
  saveSettingsToDisk(settings);
  return true;
});

ipcMain.handle('get-system-ram', () => {
  return Math.floor(os.totalmem() / 1024 / 1024);
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('pick-java', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('login-microsoft', async () => {
  const authManager = new Auth("select_account");
  const xboxManager = await authManager.launch("electron", { parent: BrowserWindow.getFocusedWindow() });
  const token = await xboxManager.getMinecraft();

  const settings = loadSettings();
  settings.accountName = token.profile.name;
  saveSettingsToDisk(settings);

  return {
    name: token.profile.name,
    uuid: token.profile.id,
    mclc: token.mclc()
  };
});

ipcMain.handle('launch-game', async (event, profile) => {
  const settings = loadSettings();
  const launcher = new Client();

  const effectiveRam = settings.ramAuto
    ? Math.max(1024, Math.round(Math.min(os.totalmem() / 1024 / 1024 / 2, os.totalmem() / 1024 / 1024 - 2048) / 512) * 512)
    : settings.ram;

  const opts = {
    authorization: profile.mclc,
    root: settings.gameFolder,
    version: {
      number: settings.version,
      type: "release"
    },
    memory: {
      max: effectiveRam + "M",
      min: "1024M"
    },
    window: {
      width: settings.windowWidth,
      height: settings.windowHeight,
      fullscreen: settings.fullscreen
    }
  };

  if (settings.javaPath) {
    opts.javaPath = settings.javaPath;
  }

  launcher.launch(opts);

  launcher.on('debug', (e) => console.log('[DEBUG]', e));
  launcher.on('data', (e) => console.log('[DATA]', e));

  return true;
});

ipcMain.handle('open-game-folder', () => {
  const settings = loadSettings();
  if (!fs.existsSync(settings.gameFolder)) {
    fs.mkdirSync(settings.gameFolder, { recursive: true });
  }
  shell.openPath(settings.gameFolder);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
