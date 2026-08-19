const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
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

// Half the machine, never eating into the last 2 GB. Deliberately measured
// against total memory, not free memory: -Xmx is a ceiling the game grows into,
// not memory taken up front, and every normal launcher lets you set more than
// is free at the moment. Clamping to free memory would also lock the game into
// a tiny heap just because a browser happened to be open at launch.
function autoRamMB() {
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
  return Math.max(1024, Math.round(Math.min(totalMB / 2, totalMB - 2048) / 512) * 512);
}

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

  const effectiveRam = settings.ramAuto ? autoRamMB() : settings.ram;

  const opts = {
    authorization: profile.mclc,
    root: settings.gameFolder,
    version: {
      number: settings.version,
      type: "release"
    },
    memory: {
      max: effectiveRam + "M",
      // Committed up front, so keep it small: the game grows into the max on
      // its own. A large min is what makes a tight machine fail at startup.
      min: Math.min(512, effectiveRam) + "M"
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
      const kind = loader.kindFor(settings.version);

      if (kind === 'profile') {
        opts.version.custom = await installLoaderProfile(
          settings.loader, settings.version, settings.loaderVersion, settings.gameFolder
        );
      } else if (kind === 'jarmod') {
        opts.version.custom = await loader.installJarMod(
          settings.version, settings.loaderVersion, settings.gameFolder
        );
        await loader.ensureFmlLibraries(
          settings.version, settings.loaderVersion, settings.gameFolder
        );
        reconcileLanguageOption(
          settings.gameFolder,
          path.join(settings.gameFolder, 'versions', opts.version.custom, `${opts.version.custom}.jar`)
        );

        // Forge of that era ignores --gameDir entirely and works out the game
        // folder on its own, landing in %APPDATA%\.minecraft. This property is
        // the only thing it listens to, and it is how launchers have always
        // pointed it somewhere else.
        opts.customArgs = [
          ...(opts.customArgs || []),
          `-Dminecraft.applet.TargetDirectory=${settings.gameFolder}`
        ];
      } else if (kind === 'installer-run') {
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

  // The game's own output is the only place its reason for dying shows up,
  // so keep the tail of it around for the report below.
  const recentOutput = [];
  launcher.on('data', (e) => {
    console.log('[DATA]', e);
    recentOutput.push(String(e));
    if (recentOutput.length > 60) recentOutput.shift();
  });

  // Measured now, not when the game dies: by then the dying process has given
  // its memory back, and the figure would look like there was plenty.
  const freeAtLaunch = Math.floor(os.freemem() / 1024 / 1024);

  launcher.on('close', (code) => {
    if (code === 0) return;
    reportGameCrash(code, recentOutput.join('\n'), effectiveRam, freeAtLaunch);
  });

  return { started: true, error: null };
});

// Without this the launcher stays silent and the game just blinks and
// disappears, which tells the player nothing at all.
function reportGameCrash(code, output, effectiveRam, freeAtLaunch) {
  const t = loadTranslations(currentLocale);
  const outOfMemory = /insufficient memory|OutOfMemoryError|failed to allocate/i.test(output);

  const detail = outOfMemory
    ? `${t['crash.outOfMemory']}\n\n` +
      `${t['crash.givenRam']}: ${effectiveRam} ${t['settings.mib']}\n` +
      `${t['crash.freeAtLaunch']}: ${freeAtLaunch} ${t['settings.mib']}\n\n` +
      t['crash.heapIsNotAll']
    : `${t['crash.exitCode']}: ${code}\n\n${output.trim().split('\n').slice(-6).join('\n')}`;

  dialog.showMessageBox({
    type: 'warning',
    title: t['crash.title'],
    message: outOfMemory ? t['crash.outOfMemoryShort'] : t['crash.title'],
    detail
  });
}

const PLAIN_VERSION = /^\d+(\.\d+)*$/;

// Mojang files nine real releases as snapshots - 1.3, 1.4, 1.4.1, 1.4.3, 1.5,
// 1.6, 1.6.3, 1.7 and 1.7.1. They were public releases at the time, and hiding
// them behind the snapshot filter makes them look like they never existed.
function correctedType(version) {
  if (version.type === 'snapshot' && PLAIN_VERSION.test(version.id)) return 'release';
  return version.type;
}

function compareVersionNumbers(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const one = left[i] ?? 0;
    const other = right[i] ?? 0;
    if (one !== other) return one - other;
  }
  return 0;
}

// Release times of old versions are rounded to the day, so 1.4.5 and 1.4.6
// share a timestamp and come out of the manifest in the wrong order. Runs that
// are entirely plain version numbers get sorted properly; anything mixed with
// snapshots is left as Mojang has it, since there the order is a real answer.
function fixSameDayOrder(versions) {
  let start = 0;
  for (let i = 1; i <= versions.length; i++) {
    if (i < versions.length && versions[i].releaseTime === versions[start].releaseTime) continue;

    const run = versions.slice(start, i);
    if (run.length > 1 && run.every(version => PLAIN_VERSION.test(version.id))) {
      run.sort((a, b) => compareVersionNumbers(b.id, a.id));
      versions.splice(start, run.length, ...run);
    }
    start = i;
  }
}

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
  const data = await fetchJson(VERSION_MANIFEST_URL);
  fs.writeFileSync(versionsCachePath, JSON.stringify(data));
  return data;
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
        type: correctedType(version),
        releaseTime: version.releaseTime,
        installed: installed.includes(version.id),
        custom: false
      });
    }
    fixSameDayOrder(versions);
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

  let meta;
  try {
    meta = await versionMetadata(mcVersion);
  } catch {
    // A version Mojang does not list - a modded profile, most likely.
    return LEGACY_JAVA;
  }

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

// Mojang's runtimes are the ones the game is tested against, so they come
// first. But their servers are not always reachable - during development they
// timed out for an evening while every other service answered in 200 ms - and
// a player with no Java would then be stuck with nothing at all. Adoptium
// publishes the same OpenJDK builds and stays as the way out.
async function downloadJava(component, major) {
  try {
    return await downloadMojangRuntime(component);
  } catch (e) {
    console.log('[JAVA] Mojang runtime unavailable, falling back to Adoptium:', e.message);
    return await downloadAdoptiumRuntime(major);
  }
}

async function downloadAdoptiumRuntime(major) {
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  const target = path.join(javaDir, `adoptium-${major}`);
  fs.mkdirSync(target, { recursive: true });

  const archive = path.join(javaDir, `adoptium-${major}.zip`);
  fs.writeFileSync(archive, await fetchBuffer(url, { redirect: 'follow' }));

  // Windows-only project, so the shell's own unzip saves a dependency.
  await runProcess('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${target}" -Force`
  ]);
  fs.unlinkSync(archive);

  const javaExe = adoptiumExeIn(target);
  if (!javaExe) throw new Error('Adoptium archive unpacked without bin/java.exe');
  return javaExe;
}

// The archive holds one folder named after the build, so look one level down.
function adoptiumExeIn(target) {
  if (!fs.existsSync(target)) return null;
  return fs.readdirSync(target)
    .map(name => path.join(target, name, 'bin', 'java.exe'))
    .find(candidate => fs.existsSync(candidate)) || null;
}

async function downloadMojangRuntime(component) {
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
      fs.writeFileSync(destination, await fetchBuffer(url));

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

  // Already fetched by us before, from either source - the surest match.
  const fromMojang = path.join(javaDir, required.component, 'bin', 'java.exe');
  if (fs.existsSync(fromMojang)) return fromMojang;

  const fromAdoptium = adoptiumExeIn(path.join(javaDir, `adoptium-${required.major}`));
  if (fromAdoptium) return fromAdoptium;

  const installed = findSystemJavas().find(java => java.major === required.major);
  return installed ? installed.path : downloadJava(required.component, required.major);
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

  async function metadata() {
    if (!metadataCache) metadataCache = await fetchText(`${maven}/maven-metadata.xml`);
    return metadataCache;
  }

  return {
    // Three eras, three ways in: the installer from 1.12, the universal jar
    // from 1.6, and before that a jar mod pasted into the game itself.
    kindFor(mcVersion) {
      return forgeUsesJarMod(mcVersion) ? 'jarmod' : 'installer';
    },

    profileId(mcVersion, loaderVersion) {
      return `${mcVersion}-forge-${loaderVersion}`;
    },

    async listVersions(mcVersion) {
      await metadata();
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
      const kind = forgeArtifactKind(mcVersion);
      const file = path.join(loadersDir, `forge-${build}-${kind}.jar`);
      if (fs.existsSync(file)) return file;

      const url = `${maven}/${build}/forge-${build}-${kind}.jar`;
      fs.mkdirSync(loadersDir, { recursive: true });
      fs.writeFileSync(file, await fetchBuffer(url));
      return file;
    },

    // Builds the patched game jar and registers it as a version of its own,
    // so the vanilla jar next to it stays untouched.
    async installJarMod(mcVersion, loaderVersion, gameFolder) {
      const profileId = this.profileId(mcVersion, loaderVersion);
      const directory = path.join(gameFolder, 'versions', profileId);
      const jarPath = path.join(directory, `${profileId}.jar`);
      const jsonPath = path.join(directory, `${profileId}.json`);

      if (fs.existsSync(jarPath) && fs.existsSync(jsonPath)) return profileId;

      const meta = await versionMetadata(mcVersion);
      const vanillaJar = await fetchBuffer(meta.downloads.client.url);
      const modArchive = await this.fetchJarModArchive(`${mcVersion}-${loaderVersion}`);

      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(jarPath, buildJarMod(vanillaJar, modArchive));

      // The vanilla description, renamed. Everything the loader adds already
      // lives inside the patched jar, so nothing else has to be declared.
      fs.writeFileSync(jsonPath, JSON.stringify({ ...meta, id: profileId }, null, 2));
      return profileId;
    },

    // 1.4 and 1.5 call it universal.zip, 1.1 through 1.3 call it client.zip.
    // Kept on disk: the library step below reads it again.
    async fetchJarModArchive(build) {
      const cached = path.join(loadersDir, `forge-${build}-jarmod.zip`);
      if (fs.existsSync(cached)) return fs.readFileSync(cached);

      for (const name of [`forge-${build}-universal.zip`, `forge-${build}-client.zip`]) {
        try {
          const archive = await fetchBuffer(`${maven}/${build}/${name}`);
          fs.mkdirSync(loadersDir, { recursive: true });
          fs.writeFileSync(cached, archive);
          return archive;
        } catch (e) {
          if (!/^HTTP 4\d\d$/.test(e.message)) throw e;
        }
      }
      throw new Error('no universal or client archive published for this build');
    },

    // FML of that era fetches its own dependencies from a Forge server that
    // has been gone for years, and dies when it cannot. The files still exist
    // elsewhere, so the launcher puts them in place beforehand and FML finds
    // everything it needs already there.
    async ensureFmlLibraries(mcVersion, loaderVersion, gameFolder) {
      const archive = await this.fetchJarModArchive(`${mcVersion}-${loaderVersion}`);
      const required = readFmlLibraryList(archive);
      if (required.length === 0) return;

      const libDirectory = path.join(gameFolder, 'lib');
      fs.mkdirSync(libDirectory, { recursive: true });

      for (const library of required) {
        await placeFmlLibrary(library, libDirectory);
      }

      // Its name carries the game version; the hash lives in a build property
      // we cannot read, so the file is trusted to be the archived original.
      await placeFmlLibrary(
        { name: `deobfuscation_data_${mcVersion}.zip`, sha1: null },
        libDirectory
      );
    }
  };
}

// Forge ships two archives and only one of them carries the version.json that
// minecraft-launcher-core reads. The split is at 1.12: from there the installer
// holds it, before that the universal jar does. Hand over the wrong one and
// MCLC quietly falls back to vanilla while still leaving the jar on the class
// path, where its bundled copy of jopt-simple breaks the game on startup.
function forgeArtifactKind(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] !== '1') return 'installer';   // 26.2 and friends
  return Number(parts[1]) >= 12 ? 'installer' : 'universal';
}

// Before 1.6 there were no version profiles at all. Forge of that era was
// installed by pasting its classes straight into minecraft.jar and deleting
// the signatures - what people called a jar mod. Prism and MultiMC still do
// exactly this, and it is the only way those versions run.
function forgeUsesJarMod(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] !== '1') return false;
  return Number(parts[1]) < 6;
}

// FML lists what it needs, and the sha1 of each file, inside its own
// CoreFMLLibraries class: first the names, then the hashes, in the same order.
// Reading them from the build itself means every Forge version is covered
// without a table of our own that would go stale.
function readFmlLibraryList(archive) {
  const entry = new AdmZip(archive).getEntry('cpw/mods/fml/relauncher/CoreFMLLibraries.class');
  if (!entry) return [];   // Forge older than FML - nothing to fetch.

  const text = entry.getData().toString('latin1');
  const strings = text.match(/[\x20-\x7e]{4,}/g) || [];
  const names = strings.filter(value => /\.(jar|zip)$/.test(value));
  const hashes = strings.flatMap(value => value.match(/[0-9a-f]{40}/g) || []);

  return names.map((name, index) => ({ name, sha1: hashes[index] || null }));
}

// Maven Central still carries the ordinary libraries untouched. The two Forge
// built for itself - a stripped argo and their own scala build - exist only in
// the web archive now, which is where the rest come from when Central has
// nothing matching.
const FML_LIBRARY_ON_MAVEN = {
  'guava-14.0-rc3.jar': 'com/google/guava/guava/14.0-rc3/guava-14.0-rc3.jar',
  'guava-12.0.1.jar': 'com/google/guava/guava/12.0.1/guava-12.0.1.jar',
  'asm-all-4.1.jar': 'org/ow2/asm/asm-all/4.1/asm-all-4.1.jar',
  'asm-all-4.0.jar': 'org/ow2/asm/asm-all/4.0/asm-all-4.0.jar',
  'bcprov-jdk15on-148.jar': 'org/bouncycastle/bcprov-jdk15on/1.48/bcprov-jdk15on-1.48.jar',
  'bcprov-jdk15on-147.jar': 'org/bouncycastle/bcprov-jdk15on/1.47/bcprov-jdk15on-1.47.jar'
};

const FML_LIBRARY_ORIGIN = 'http://files.minecraftforge.net/fmllibs/';

async function placeFmlLibrary(library, libDirectory) {
  const destination = path.join(libDirectory, library.name);

  if (fs.existsSync(destination)) {
    if (!library.sha1 || sha1Of(destination) === library.sha1) return;
    fs.unlinkSync(destination);
  }

  const sources = [];
  if (FML_LIBRARY_ON_MAVEN[library.name]) {
    sources.push(`https://repo1.maven.org/maven2/${FML_LIBRARY_ON_MAVEN[library.name]}`);
  }
  // Several snapshots, not one: the archive serves an old capture badly often
  // enough that a single address is not a reliable source.
  sources.push(...await archivedUrls(FML_LIBRARY_ORIGIN + library.name));

  let lastError = new Error('no source');
  for (const source of sources) {
    try {
      const data = await fetchBuffer(source);
      if (library.sha1 && crypto.createHash('sha1').update(data).digest('hex') !== library.sha1) {
        lastError = new Error(`${library.name}: checksum mismatch`);
        continue;
      }
      fs.writeFileSync(destination, data);
      return;
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(`${library.name}: ${lastError.message}`);
}

// Every archived capture of a long-dead address, newest first. Only captures
// that answered 200 at the time are worth trying, and even those sometimes
// fail to replay, so the caller walks the list.
async function archivedUrls(originalUrl) {
  const index = 'https://web.archive.org/cdx/search/cdx' +
    `?url=${encodeURIComponent(originalUrl)}&output=json&filter=statuscode:200&limit=-6`;

  let rows;
  try {
    rows = await fetchJson(index);
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || rows.length < 2) return [];

  return rows.slice(1)
    .map(row => row[1])
    .reverse()
    .map(timestamp => `https://web.archive.org/web/${timestamp}id_/${originalUrl}`);
}

// Old versions read their language file straight out of the jar, where names
// are case sensitive - en_US.lang. Modern versions write "lang:en_us" into the
// options.txt they all share, and 1.5.2 then looks for a file that is not
// there and dies with a null stream. The setting is put back into the spelling
// this version understands; a modern version will write its own back later.
function reconcileLanguageOption(gameFolder, jarPath) {
  const optionsPath = path.join(gameFolder, 'options.txt');
  if (!fs.existsSync(optionsPath)) return;

  const text = fs.readFileSync(optionsPath, 'utf-8');
  const line = text.match(/^lang:(.*)$/m);
  if (!line) return;

  const wanted = line[1].trim();
  const available = new AdmZip(jarPath).getEntries()
    .map(entry => entry.entryName)
    .filter(name => name.startsWith('lang/') && name.endsWith('.lang'))
    .map(name => name.slice(5, -5));

  if (available.length === 0 || available.includes(wanted)) return;

  const corrected = available.find(name => name.toLowerCase() === wanted.toLowerCase())
    || (available.includes('en_US') ? 'en_US' : available[0]);

  fs.writeFileSync(optionsPath, text.replace(/^lang:.*$/m, `lang:${corrected}`));
}

// Vanilla jar with the loader's files laid over it. The signatures have to go:
// once a single class is replaced they no longer match, and the game refuses
// to start rather than run a jar whose signature is broken.
function buildJarMod(vanillaJar, modArchive) {
  const patched = new AdmZip(vanillaJar);

  // Collect first, delete after: removing entries while walking the same list
  // makes the walk skip half of them, and the leftover signatures are exactly
  // what stops the game from starting.
  const signatures = patched.getEntries()
    .map(entry => entry.entryName)
    .filter(name => name.startsWith('META-INF/'));
  for (const name of signatures) patched.deleteFile(name);

  for (const entry of new AdmZip(modArchive).getEntries()) {
    if (entry.isDirectory || entry.entryName.startsWith('META-INF/')) continue;
    patched.deleteFile(entry.entryName);
    patched.addFile(entry.entryName, entry.getData());
  }

  return patched.toBuffer();
}

// The full description of a game version, fetched from the address the
// manifest gives for it.
async function versionMetadata(mcVersion) {
  const manifest = readVersionCache() || await fetchVersionManifest();
  const entry = manifest.versions.find(version => version.id === mcVersion);
  if (!entry) throw new Error(`unknown game version ${mcVersion}`);
  return fetchJson(entry.url);
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

  async function allBuilds() {
    if (!metadataCache) metadataCache = await fetchText(`${maven}/maven-metadata.xml`);
    return [...metadataCache.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
  }

  return {
    kindFor() {
      return 'installer-run';
    },

    async supports(mcVersion) {
      const prefix = neoforgeVersionPrefix(mcVersion);
      return (await allBuilds()).some(build => build.startsWith(prefix));
    },

    async listVersions(mcVersion) {
      const all = await allBuilds();
      const prefix = neoforgeVersionPrefix(mcVersion);
      const builds = all
        .filter(version => version.startsWith(prefix))
        .sort(compareBuildNumbers)
        .reverse();

      // The catalogue sometimes lists a build whose installer is not uploaded
      // yet (26.2.0.64 was). Those sit at the top, where people pick from, so
      // the newest few are checked and the missing ones dropped.
      while (builds.length > 0) {
        const newest = builds[0];
        const url = `${maven}/${newest}/neoforge-${newest}-installer.jar`;
        if (await urlExists(url)) break;
        builds.shift();
      }

      return builds.map(version => ({
        version,
        stable: !/alpha|beta|rc|snapshot/i.test(version)
      }));
    },

    profileId(mcVersion, loaderVersion) {
      return `neoforge-${loaderVersion}`;
    },

    async install(mcVersion, loaderVersion, gameFolder, javaPath) {
      const file = path.join(loadersDir, `neoforge-${loaderVersion}-installer.jar`);
      if (!fs.existsSync(file)) {
        const url = `${maven}/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
        fs.mkdirSync(loadersDir, { recursive: true });
        fs.writeFileSync(file, await fetchBuffer(url));
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
  return (await fetchWithRetry(url)).text();
}

async function fetchBuffer(url, options = {}) {
  return Buffer.from(await (await fetchWithRetry(url, options)).arrayBuffer());
}

// "Is this file actually there" - a missing file is an answer, not a failure.
async function urlExists(url) {
  try {
    await fetchWithRetry(url, { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

// Fabric and Quilt share the same meta API shape, so one description covers
// both: list the builds for a game version, then hand out a ready profile.
function metaLoader(name, baseUrl) {
  return {
    kindFor() {
      return 'profile';
    },

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

// Connections here drop at random: the same host answers in 200 ms, then times
// out, then answers again. One failed attempt means nothing, so every request
// gets a few tries. A 4xx answer is the server talking, not the network, and
// is not retried - that is how "this loader has nothing for this version" is
// told apart from "the connection broke".
async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok) return response;
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (e) {
      if (/^HTTP 4\d\d$/.test(e.message)) throw e;
      lastError = e;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await new Promise(done => setTimeout(done, 1500));
  }

  throw lastError;
}

async function fetchJson(url) {
  return (await fetchWithRetry(url)).json();
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

// Asks every loader what it actually has for this game version, rather than
// trusting a list of "supported versions". Slower, but the answer cannot be
// stale - and the builds come back with it, so picking one needs no second
// request. All four are asked at once.
ipcMain.handle('get-available-loaders', async (event, mcVersion) => {
  const checks = Object.entries(modLoaders).map(async ([id, loader]) => {
    try {
      const versions = await loader.listVersions(mcVersion);
      return versions.length > 0 ? { id, versions } : null;
    } catch {
      // A loader with nothing for this version answers 400 or 404.
      return null;
    }
  });

  return (await Promise.all(checks)).filter(Boolean);
});

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
