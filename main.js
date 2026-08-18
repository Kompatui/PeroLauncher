const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');

Menu.setApplicationMenu(null);

// The GPU process crashes on this machine (exit_code=34) and Electron retries it
// three times before falling back to software rendering, which just wastes about
// a second of every startup. The UI is plain tiles, so the CPU handles it fine.
app.disableHardwareAcceleration();

// Set from settings.json at startup, see below - the file is read there.
let currentLocale = 'ru';

// Drive C is off limits - it is short on space. Everything lives on E.
app.setPath('userData', 'E:\\PeroLauncher\\userdata');

const settingsPath = 'E:\\PeroLauncher\\settings.json';

// Mojang's list of every official version. Cached on disk so the version
// picker still works without a connection.
const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const versionsCachePath = 'E:\\PeroLauncher\\versions-cache.json';

const defaultSettings = {
  version: '1.21.1',
  loader: 'vanilla',
  loaderVersion: null,
  accountName: null,
  ram: 4096,
  ramAuto: true,
  windowWidth: 854,
  windowHeight: 480,
  fullscreen: false,
  gameFolder: 'E:\\.minecraft',
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

// Without this the launcher would fall back to Russian on every restart,
// no matter what language the user picked in the settings.
currentLocale = loadSettings().language || 'ru';

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

  // With a mod loader picked, the game starts from the loader profile, which
  // sits on top of the vanilla version rather than replacing it.
  if (settings.loader && settings.loader !== 'vanilla' && settings.loaderVersion) {
    try {
      opts.version.custom = await installLoaderProfile(
        settings.loader, settings.version, settings.loaderVersion, settings.gameFolder
      );
    } catch (e) {
      return { started: false, error: `loader: ${e.message}` };
    }
  }

  launcher.launch(opts);

  launcher.on('debug', (e) => console.log('[DEBUG]', e));
  launcher.on('data', (e) => console.log('[DATA]', e));

  return { started: true, error: null };
});

// A version counts as installed when its folder holds a matching .json,
// which is what minecraft-launcher-core needs to start it.
function listInstalledVersions(gameFolder) {
  const dir = path.join(gameFolder, 'versions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => fs.existsSync(path.join(dir, entry.name, `${entry.name}.json`)))
    .map(entry => entry.name);
}

async function fetchVersionManifest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(VERSION_MANIFEST_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    fs.writeFileSync(versionsCachePath, JSON.stringify(data));
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function readVersionCache() {
  if (!fs.existsSync(versionsCachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(versionsCachePath, 'utf-8'));
  } catch {
    return null;
  }
}

ipcMain.handle('get-versions', async () => {
  const settings = loadSettings();
  const installed = listInstalledVersions(settings.gameFolder);

  let manifest = null;
  let source = 'installed';
  let error = null;

  if (settings.versionFilters.loadFromServer) {
    try {
      manifest = await fetchVersionManifest();
      source = 'network';
    } catch (e) {
      error = e.name === 'AbortError' ? 'timeout' : e.message;
      manifest = readVersionCache();
      if (manifest) source = 'cache';
    }
  } else {
    // Still useful: tells us the type of each installed version.
    manifest = readVersionCache();
  }

  const official = new Map();
  if (manifest) {
    for (const version of manifest.versions) official.set(version.id, version);
  }

  const versions = [];

  if (settings.versionFilters.loadFromServer && manifest) {
    for (const version of manifest.versions) {
      versions.push({
        id: version.id,
        type: version.type,
        releaseTime: version.releaseTime,
        installed: installed.includes(version.id),
        custom: false
      });
    }
  }

  // Anything installed that Mojang does not list is a modded or custom build
  // (Forge, Fabric, and so on). Those go first - they are the user's own.
  const extra = [];
  for (const id of installed) {
    if (versions.some(v => v.id === id)) continue;
    const known = official.get(id);
    extra.push({
      id,
      type: known ? known.type : 'custom',
      releaseTime: known ? known.releaseTime : null,
      installed: true,
      custom: !known
    });
  }

  return {
    versions: [...extra, ...versions],
    source,
    error,
    // Releases older than this are "old releases" for the filter.
    oldReleaseCutoff: official.get('1.7.10')?.releaseTime || null
  };
});

// Mod loaders. Each entry knows how to list its builds for a game version and
// how to put a launchable profile into versions/. Adding Quilt, Forge or
// NeoForge later means adding an entry here, nothing else.
const modLoaders = {
  fabric: metaLoader('fabric', 'https://meta.fabricmc.net/v2'),
  quilt: metaLoader('quilt', 'https://meta.quiltmc.org/v3')
};

// Fabric and Quilt share the same meta API shape, so one description covers
// both: list the builds for a game version, then hand out a ready profile.
function metaLoader(name, baseUrl) {
  return {
    async listVersions(mcVersion) {
      const list = await fetchJson(`${baseUrl}/versions/loader/${encodeURIComponent(mcVersion)}`);
      return list.map(entry => ({
        version: entry.loader.version,
        // Quilt omits the flag and marks pre-releases in the name instead.
        stable: entry.loader.stable ?? !/beta|alpha|pre|rc/i.test(entry.loader.version)
      }));
    },
    profileId(mcVersion, loaderVersion) {
      return `${name}-loader-${loaderVersion}-${mcVersion}`;
    },
    async fetchProfile(mcVersion, loaderVersion) {
      return fetchJson(`${baseUrl}/versions/loader/` +
        `${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
    }
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Writes the loader profile next to the vanilla versions. minecraft-launcher-core
// then loads it as a custom version and layers it over the base game.
async function installLoaderProfile(loaderId, mcVersion, loaderVersion, gameFolder) {
  const loader = modLoaders[loaderId];
  const profileId = loader.profileId(mcVersion, loaderVersion);
  const profileDir = path.join(gameFolder, 'versions', profileId);
  const profileFile = path.join(profileDir, `${profileId}.json`);

  if (fs.existsSync(profileFile)) return profileId;

  const profile = await loader.fetchProfile(mcVersion, loaderVersion);

  // Trust the name the loader itself reports - the folder, the json inside it
  // and the id must match or minecraft-launcher-core will not find the profile.
  const actualId = profile.id || profileId;
  const actualDir = path.join(gameFolder, 'versions', actualId);
  fs.mkdirSync(actualDir, { recursive: true });
  fs.writeFileSync(path.join(actualDir, `${actualId}.json`), JSON.stringify(profile, null, 2));
  return actualId;
}

ipcMain.handle('get-loader-versions', async (event, loaderId, mcVersion) => {
  const loader = modLoaders[loaderId];
  if (!loader) return { versions: [], error: 'unknown-loader' };
  try {
    return { versions: await loader.listVersions(mcVersion), error: null };
  } catch (e) {
    // Fabric answers 400 for a game version it does not support.
    return { versions: [], error: e.message };
  }
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
