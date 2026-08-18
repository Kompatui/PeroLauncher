const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
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

  // Picking the wrong Java is what silently kills the game: Forge for 1.20
  // dies on Java 25 with "Unsupported class file major version 69".
  try {
    opts.javaPath = await resolveJavaPath(settings.version, settings.javaPath);
  } catch (e) {
    return { started: false, error: `java: ${e.message}` };
  }

  // The loader is fetched here rather than when it is picked, so browsing the
  // list costs nothing. Both kinds sit on top of the vanilla version.
  const loader = modLoaders[settings.loader];
  if (loader && settings.loaderVersion) {
    try {
      if (loader.kind === 'profile') {
        opts.version.custom = await installLoaderProfile(
          settings.loader, settings.version, settings.loaderVersion, settings.gameFolder
        );
      } else if (loader.kind === 'installer-run') {
        const profileId = loader.profileId(settings.version, settings.loaderVersion);
        const profileFile = path.join(settings.gameFolder, 'versions', profileId, `${profileId}.json`);
        // Running the installer takes minutes, so only do it once.
        if (!fs.existsSync(profileFile)) {
          // Same runtime the game will use, not whatever java is on PATH.
          await loader.install(settings.version, settings.loaderVersion, settings.gameFolder, opts.javaPath);
        }
        opts.version.custom = profileId;
      } else {
        opts.forge = await loader.ensureInstaller(settings.version, settings.loaderVersion);
      }
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
// Two kinds exist. A 'profile' loader hands out a ready version json that is
// dropped next to the vanilla versions. An 'installer' loader gives out an
// installer jar that minecraft-launcher-core has to unpack itself.
const modLoaders = {
  fabric: metaLoader('fabric', 'https://meta.fabricmc.net/v2'),
  quilt: metaLoader('quilt', 'https://meta.quiltmc.org/v3'),
  forge: forgeLoader(),
  neoforge: neoforgeLoader()
};

// Installer jars are kept beside the launcher, not in the game folder -
// they are build tooling, not something the game reads.
const loadersDir = 'E:\\PeroLauncher\\loaders';

// Java runtimes the launcher downloads itself, plus a small note of which
// Java each game version asks for, so we do not refetch that every launch.
const javaDir = 'E:\\PeroLauncher\\java';
const javaRequirementsPath = 'E:\\PeroLauncher\\java-versions.json';

// Every version json names the runtime it expects, both as a component
// ("java-runtime-gamma") and a plain major number. Versions older than 1.17
// leave the field out - those run on Java 8.
const LEGACY_JAVA = { component: 'jre-legacy', major: 8 };

async function requiredJava(mcVersion) {
  let cache = {};
  if (fs.existsSync(javaRequirementsPath)) {
    try {
      cache = JSON.parse(fs.readFileSync(javaRequirementsPath, 'utf-8'));
    } catch {
      cache = {};
    }
  }
  if (cache[mcVersion]) return cache[mcVersion];

  const manifest = readVersionCache() || await fetchVersionManifest();
  const entry = manifest.versions.find(version => version.id === mcVersion);
  if (!entry) return LEGACY_JAVA;

  const meta = await fetchJson(entry.url);
  const required = meta.javaVersion
    ? { component: meta.javaVersion.component, major: meta.javaVersion.majorVersion }
    : LEGACY_JAVA;

  cache[mcVersion] = required;
  fs.writeFileSync(javaRequirementsPath, JSON.stringify(cache, null, 2));
  return required;
}

// "17.0.7" -> 17, and the old "1.8.0_481" -> 8.
function javaMajorFromVersion(text) {
  const parts = text.replace(/"/g, '').trim().split('.');
  return parts[0] === '1' ? parseInt(parts[1], 10) : parseInt(parts[0], 10);
}

function javaMajorAt(home) {
  const releaseFile = path.join(home, 'release');
  if (!fs.existsSync(releaseFile)) return null;
  const match = fs.readFileSync(releaseFile, 'utf-8').match(/^JAVA_VERSION="?([^"\r\n]+)"?/m);
  return match ? javaMajorFromVersion(match[1]) : null;
}

// Looks where Java installers usually put things, plus our own folder.
function findSystemJavas() {
  const roots = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Zulu',
    javaDir
  ];

  const found = [];
  const seen = new Set();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const home = path.join(root, entry.name);
      const exe = path.join(home, 'bin', 'java.exe');
      if (!fs.existsSync(exe)) continue;
      const major = javaMajorAt(home);
      if (!major || seen.has(exe)) continue;
      seen.add(exe);
      found.push({ path: exe, major, home, downloaded: home.startsWith(javaDir) });
    }
  }

  return found.sort((a, b) => a.major - b.major);
}

// The same runtimes the official launcher installs. Each component is a list
// of files with their own sha1, so a half-finished download resumes cleanly
// and a corrupted file is replaced instead of silently breaking the game.
const JAVA_RUNTIME_FEED =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function runtimePlatform() {
  if (process.arch === 'arm64') return 'windows-arm64';
  if (process.arch === 'ia32') return 'windows-x86';
  return 'windows-x64';
}

function sha1Of(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

async function downloadJava(component) {
  const feed = await fetchJson(JAVA_RUNTIME_FEED);
  const platform = feed[runtimePlatform()] || feed['windows-x64'];
  const builds = platform[component];
  if (!builds || builds.length === 0) throw new Error(`no ${component} runtime for this system`);

  const files = (await fetchJson(builds[0].manifest.url)).files;
  const target = path.join(javaDir, component);

  for (const [name, entry] of Object.entries(files)) {
    if (entry.type === 'directory') fs.mkdirSync(path.join(target, name), { recursive: true });
  }

  const downloads = Object.entries(files).filter(([, entry]) => entry.type === 'file');
  let index = 0;

  async function worker() {
    while (index < downloads.length) {
      const [name, entry] = downloads[index++];
      const destination = path.join(target, name);
      const { url, sha1 } = entry.downloads.raw;

      // Already there and intact - skip it. This is what makes a retry cheap.
      if (fs.existsSync(destination) && sha1Of(destination) === sha1) continue;

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));

      if (sha1Of(destination) !== sha1) throw new Error(`${name}: checksum mismatch`);
    }
  }

  await Promise.all(Array.from({ length: 8 }, worker));

  const javaExe = path.join(target, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) throw new Error('runtime unpacked without bin/java.exe');
  return javaExe;
}

// Manual choice wins. Otherwise match the game's own requirement, and fetch
// the runtime when the machine has nothing suitable - which is the normal
// case for someone who has never installed Java.
async function resolveJavaPath(mcVersion, manualPath) {
  if (manualPath) return manualPath;
  const required = await requiredJava(mcVersion);

  // Already fetched by us before - the surest match, and no scanning needed.
  const ownRuntime = path.join(javaDir, required.component, 'bin', 'java.exe');
  if (fs.existsSync(ownRuntime)) return ownRuntime;

  const installed = findSystemJavas().find(java => java.major === required.major);
  return installed ? installed.path : downloadJava(required.component);
}

ipcMain.handle('get-java-status', async (event, mcVersion) => {
  try {
    const { major } = await requiredJava(mcVersion);
    const installed = findSystemJavas();
    return {
      required: major,
      installed: installed.map(({ path: javaPath, major: javaMajor, downloaded }) =>
        ({ path: javaPath, major: javaMajor, downloaded })),
      matched: installed.find(java => java.major === major)?.path || null,
      error: null
    };
  } catch (e) {
    return { required: null, installed: [], matched: null, error: e.message };
  }
});

function forgeLoader() {
  const maven = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
  const promosUrl = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
  let metadataCache = null;

  return {
    kind: 'installer',

    async listVersions(mcVersion) {
      if (!metadataCache) metadataCache = await fetchText(`${maven}/maven-metadata.xml`);
      const all = [...metadataCache.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);

      // Exact prefix only: a plain startsWith on "1.21.1" would also swallow
      // 1.21.10 and 1.21.11.
      const prefix = `${mcVersion}-`;
      const builds = all
        .filter(v => v.startsWith(prefix))
        .map(v => v.slice(prefix.length))
        .filter(Boolean)
        .sort(compareBuildNumbers)
        .reverse();

      let promos = {};
      try {
        promos = (await fetchJson(promosUrl)).promos || {};
      } catch {
        // The recommended mark is a nicety; the list works without it.
      }
      const recommended = promos[`${mcVersion}-recommended`];

      return builds.map(version => ({
        version,
        // Old builds carry a trailing game version (10.13.4.1614-1.7.10)
        // that the promotions file leaves out.
        stable: !!recommended && (version === recommended || version.startsWith(`${recommended}-`))
      }));
    },

    async ensureInstaller(mcVersion, loaderVersion) {
      const build = `${mcVersion}-${loaderVersion}`;
      const file = path.join(loadersDir, `forge-${build}-installer.jar`);
      if (fs.existsSync(file)) return file;

      const url = `${maven}/${build}/forge-${build}-installer.jar`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      fs.mkdirSync(loadersDir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      return file;
    }
  };
}

// NeoForge numbers its builds after the game version with the leading "1."
// dropped: 1.21.1 -> 21.1.x, 1.21 -> 21.0.x. The newer game numbering keeps
// all its parts: 26.2 -> 26.2.0.x.
function neoforgeVersionPrefix(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] === '1') {
    const [, minor, patch] = parts;
    return `${minor}.${patch ?? 0}.`;
  }
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch ?? 0}.`;
}

// NeoForge cannot go through the Forge path: minecraft-launcher-core looks for
// libraries named net.minecraftforge, and NeoForge publishes under
// net.neoforged. Instead its installer is run once and leaves behind a normal
// profile, which is then launched the same way Fabric is.
function neoforgeLoader() {
  const maven = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
  let metadataCache = null;

  return {
    kind: 'installer-run',

    async listVersions(mcVersion) {
      if (!metadataCache) metadataCache = await fetchText(`${maven}/maven-metadata.xml`);
      const all = [...metadataCache.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
      const prefix = neoforgeVersionPrefix(mcVersion);
      return all
        .filter(version => version.startsWith(prefix))
        .sort(compareBuildNumbers)
        .reverse()
        .map(version => ({ version, stable: !/alpha|beta|rc|snapshot/i.test(version) }));
    },

    profileId(mcVersion, loaderVersion) {
      return `neoforge-${loaderVersion}`;
    },

    async install(mcVersion, loaderVersion, gameFolder, javaPath) {
      const file = path.join(loadersDir, `neoforge-${loaderVersion}-installer.jar`);
      if (!fs.existsSync(file)) {
        const url = `${maven}/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        fs.mkdirSync(loadersDir, { recursive: true });
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      }

      // The installer refuses to run without this file, and a folder that has
      // never been opened by the official launcher does not have one.
      const profilesFile = path.join(gameFolder, 'launcher_profiles.json');
      if (!fs.existsSync(profilesFile)) {
        fs.mkdirSync(gameFolder, { recursive: true });
        fs.writeFileSync(profilesFile, JSON.stringify({ profiles: {}, version: 3 }, null, 2));
      }

      await runProcess(javaPath || 'java', ['-jar', file, '--install-client', gameFolder]);
      return this.profileId(mcVersion, loaderVersion);
    }
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(output);
      reject(new Error(`exited with ${code}: ${output.trim().split('\n').pop()}`));
    });
  });
}

// Maven lists builds in its own order, which is not the numeric one, so
// 10.13.4.1614 could end up below 10.13.0.1150. Compare segment by segment.
function compareBuildNumbers(a, b) {
  const partsA = a.split(/[.-]/).map(Number);
  const partsB = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const left = partsA[i];
    const right = partsB[i];
    if (Number.isNaN(left) || left === undefined) return -1;
    if (Number.isNaN(right) || right === undefined) return 1;
    if (left !== right) return left - right;
  }
  return 0;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Fabric and Quilt share the same meta API shape, so one description covers
// both: list the builds for a game version, then hand out a ready profile.
function metaLoader(name, baseUrl) {
  return {
    kind: 'profile',

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
