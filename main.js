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
  javaArgs: '',
  // What the launcher does with itself once the game is up: get out of the
  // way, stay put, or quit. Minimising is what a launcher is expected to do.
  onGameStart: 'minimize',
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

// Modpacks. A player who only wants to play never has to make one - the
// settings page is enough on its own. Making one binds a version and a loader
// to it there and then, and from that moment those answer for it: mods go
// into the pack rather than into the shared game folder, and picking it
// overrides what the settings page says.
const instancesPath = 'E:\\PeroLauncher\\instances.json';
const instancesDir = 'E:\\PeroLauncher\\instances';

function loadInstances() {
  if (!fs.existsSync(instancesPath)) return { activeId: null, instances: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(instancesPath, 'utf-8'));
    return {
      activeId: parsed.activeId || null,
      instances: Array.isArray(parsed.instances) ? parsed.instances : []
    };
  } catch {
    return { activeId: null, instances: [] };
  }
}

function saveInstances(store) {
  fs.mkdirSync(path.dirname(instancesPath), { recursive: true });
  fs.writeFileSync(instancesPath, JSON.stringify(store, null, 2));
}

function instanceFolder(instance) {
  return path.join(instancesDir, instance.id);
}

// The one in use, or null when the player is on the plain path.
function activeInstance() {
  const store = loadInstances();
  return store.instances.find(entry => entry.id === store.activeId) || null;
}

// A folder name made from what the player typed. Kept readable rather than
// reduced to a number, because they will see it in the explorer sooner or
// later and "My pack" is worth more than "instance-3".
function instanceId(name, taken) {
  const base = name.trim().toLowerCase()
    .replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pack';

  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

// Signed-in accounts live in their own file rather than in settings.json.
// What is kept is a refresh token - not a password, and not a key to the game
// on its own, but still the thing that gets someone into the account. The
// settings file is something a user will sooner or later copy, post in a chat
// or hand over for help, and it must be safe to do that.
const accountsPath = 'E:\\PeroLauncher\\accounts.json';

function loadAccounts() {
  if (!fs.existsSync(accountsPath)) return { activeId: null, accounts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
    return {
      activeId: parsed.activeId || null,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch {
    // A damaged file must not lock the player out of the launcher: they can
    // always sign in again, which rewrites it.
    return { activeId: null, accounts: [] };
  }
}

function saveAccounts(store) {
  fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
  fs.writeFileSync(accountsPath, JSON.stringify(store, null, 2));
}

// What the pages are allowed to see. The tokens never leave the main process.
function publicAccounts(store) {
  return {
    activeId: store.activeId,
    accounts: store.accounts.map(account => ({
      id: account.id,
      name: account.name,
      uuid: account.uuid,
      type: account.type || 'microsoft',
      addedAt: account.addedAt
    }))
  };
}

// The name a player types is all an offline account has, so the identity is
// derived from it the same way a Minecraft server does when it is not
// checking sessions: an MD5 of "OfflinePlayer:<name>" dressed up as a version
// 3 UUID. Matching that exactly is what makes the inventory and the world
// data follow the name on a LAN game or a server in offline mode.
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Minecraft has always refused names outside this shape, and a server would
// reject one anyway. Better to say so while the player is typing than to fail
// at launch.
// Length is judged first so that an empty field is answered with "3 to 16
// characters" rather than a complaint about characters that are not there.
function offlineNameProblem(name) {
  if (name.length < 3 || name.length > 16) return 'length';
  if (!/^[A-Za-z0-9_]+$/.test(name)) return 'characters';
  return null;
}

// An offline session carries no tokens because there are none: nothing was
// signed in. The game accepts it and runs; a server that verifies sessions
// will not let it in, which is exactly what "offline" means.
function offlineSession(account) {
  return {
    id: account.id,
    name: account.name,
    uuid: account.uuid,
    mclc: {
      access_token: '0',
      client_token: '0',
      uuid: account.uuid,
      name: account.name,
      user_properties: '{}',
      meta: { type: 'mojang', demo: false }
    }
  };
}

function rememberAccount(store, minecraft, refreshToken) {
  const id = minecraft.profile.id;
  const record = {
    id,
    type: 'microsoft',
    name: minecraft.profile.name,
    uuid: minecraft.profile.id,
    refreshToken,
    addedAt: new Date().toISOString()
  };

  // Signing into an account that is already saved updates it instead of
  // adding a second copy of the same person.
  const existing = store.accounts.findIndex(account => account.id === id);
  if (existing === -1) store.accounts.push(record);
  else store.accounts[existing] = { ...store.accounts[existing], ...record };

  store.activeId = id;
  saveAccounts(store);
  return record;
}

// Turns a saved account into something the game can be launched with, without
// showing a login window. Microsoft hands out a new refresh token each time,
// so the saved one is replaced - keeping the old one is how an account
// quietly stops working after a while.
async function sessionFromSaved(account) {
  const auth = new Auth('select_account');
  const xbox = await auth.refresh(account.refreshToken);
  const minecraft = await xbox.getMinecraft();

  const store = loadAccounts();
  const saved = store.accounts.find(entry => entry.id === account.id);
  if (saved) {
    saved.refreshToken = xbox.save();
    saved.name = minecraft.profile.name;   // The player may have renamed.
    saveAccounts(store);
  }

  return {
    id: minecraft.profile.id,
    name: minecraft.profile.name,
    uuid: minecraft.profile.id,
    mclc: minecraft.mclc()
  };
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

  // A page that throws goes white and says nothing: its errors land in the
  // developer tools, while the terminal only ever hears from this process.
  // Repeating them here means a blank screen comes with its reason attached.
  win.webContents.on('console-message', (event, level, message, line, source) => {
    if (level < 2) return;   // Warnings and errors only.
    console.log(`[PAGE] ${message}   (${source}:${line})`);
  });

  win.webContents.on('render-process-gone', (event, details) => {
    console.log('[PAGE] the page process stopped:', details.reason);
  });

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

// The total and the automatic figure come from the same place, so the number
// on the settings page cannot drift away from the one the game is started
// with. They were worked out twice before, in two files, agreeing only by
// coincidence.
ipcMain.handle('get-system-ram', () => {
  return { total: Math.floor(os.totalmem() / 1024 / 1024), auto: autoRamMB() };
});

// More heap is not more game. Above roughly this much, Minecraft gains
// nothing and loses something: the pauses to collect a larger heap get longer
// and show up as stutter. Which is why launchers hand out a fixed few
// gigabytes rather than a share of whatever the machine happens to have -
// Mojang's own gives every version 2 GiB, MultiMC and Prism 4.
const AUTO_RAM_CEILING_MB = 4096;

// Measured against total memory, not free memory: -Xmx is a ceiling the game
// grows into, not memory taken up front, and every normal launcher lets you
// set more than is free at the moment. Clamping to free memory would also
// lock the game into a tiny heap just because a browser happened to be open.
//
// Nothing here looks at the game version, and that is on purpose. What
// decides the appetite is the mods, not the version: bare 1.20 is happy in
// 2 GiB while 1.7.10 under a heavy pack will not fit in 4. A version says
// almost nothing about it, so the figure belongs to the modpack instead -
// which is where it will come from once modpacks exist.
function autoRamMB() {
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);

  // Half the machine, and never so much that the system is left under 2 GB.
  const share = Math.min(totalMB / 2, totalMB - 2048);
  const rounded = Math.round(share / 512) * 512;

  return Math.max(1024, Math.min(rounded, AUTO_RAM_CEILING_MB));
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

// Opens the Microsoft window. Only for adding an account - never on the way
// into the game, where a saved account is used instead.
ipcMain.handle('login-microsoft', async () => {
  const auth = new Auth('select_account');
  const xbox = await auth.launch('electron', { parent: BrowserWindow.getFocusedWindow() });
  const minecraft = await xbox.getMinecraft();

  const store = loadAccounts();
  const record = rememberAccount(store, minecraft, xbox.save());

  // Kept so the settings page still has a name to show without unlocking
  // anything, and so an older settings.json keeps working.
  const settings = loadSettings();
  settings.accountName = record.name;
  saveSettingsToDisk(settings);

  return {
    id: record.id,
    name: record.name,
    uuid: record.uuid,
    mclc: minecraft.mclc()
  };
});

// An account that is only a name. No sign-in, no servers that check
// sessions - single player, a LAN game, or a server running in offline mode.
ipcMain.handle('add-offline-account', (event, rawName) => {
  const name = String(rawName || '').trim();

  const problem = offlineNameProblem(name);
  if (problem) return { ok: false, reason: problem };

  const uuid = offlineUuid(name);
  const store = loadAccounts();

  if (store.accounts.some(account => account.type === 'offline' && account.uuid === uuid)) {
    return { ok: false, reason: 'exists' };
  }

  store.accounts.push({
    id: `offline:${uuid}`,
    type: 'offline',
    name,
    uuid,
    addedAt: new Date().toISOString()
  });
  store.activeId = `offline:${uuid}`;
  saveAccounts(store);

  const settings = loadSettings();
  settings.accountName = name;
  saveSettingsToDisk(settings);

  return { ok: true, store: publicAccounts(store) };
});

ipcMain.handle('get-accounts', () => publicAccounts(loadAccounts()));

ipcMain.handle('set-active-account', (event, id) => {
  const store = loadAccounts();
  if (!store.accounts.some(account => account.id === id)) return publicAccounts(store);

  store.activeId = id;
  saveAccounts(store);

  const settings = loadSettings();
  settings.accountName = store.accounts.find(account => account.id === id).name;
  saveSettingsToDisk(settings);

  return publicAccounts(store);
});

ipcMain.handle('remove-account', (event, id) => {
  const store = loadAccounts();
  store.accounts = store.accounts.filter(account => account.id !== id);

  // Removing the one in use hands the place to whoever is left, so the
  // launcher is never left pointing at an account that is gone.
  if (store.activeId === id) store.activeId = store.accounts[0]?.id || null;
  saveAccounts(store);

  const settings = loadSettings();
  settings.accountName = store.accounts.find(account => account.id === store.activeId)?.name || null;
  saveSettingsToDisk(settings);

  return publicAccounts(store);
});

// The session the game is started with. Returns null when there is nothing
// saved, so the caller knows to ask the player to sign in rather than
// showing an error over something that is not broken.
ipcMain.handle('get-session', async () => {
  const store = loadAccounts();
  const account = store.accounts.find(entry => entry.id === store.activeId);
  if (!account) return { ok: false, reason: 'no-account' };

  // Nothing to refresh and nobody to ask: an offline account works with the
  // network down, which is half the point of having one.
  if (account.type === 'offline') return { ok: true, profile: offlineSession(account) };

  try {
    return { ok: true, profile: await sessionFromSaved(account) };
  } catch (e) {
    // Microsoft can refuse a token that is too old or was revoked. That is
    // not a failure to report as a crash - the account simply has to be
    // signed into again.
    return { ok: false, reason: 'expired', name: account.name, error: e.message };
  }
});

ipcMain.handle('get-instances', () => {
  const store = loadInstances();
  return {
    activeId: store.activeId,
    instances: store.instances.map(instance => ({
      ...instance,
      folder: instanceFolder(instance),
      modCount: listInstanceContent(instance, 'mod').length,
      packCount: listInstanceContent(instance, 'resourcepack').length
    }))
  };
});

ipcMain.handle('create-instance', (event, draft) => {
  const store = loadInstances();
  const name = String(draft.name || '').trim();
  if (!name) return { ok: false, reason: 'no-name' };

  const instance = {
    id: instanceId(name, store.instances.map(entry => entry.id)),
    name,
    version: draft.version,
    loader: draft.loader || 'vanilla',
    loaderVersion: draft.loaderVersion || null,
    ram: null,
    createdAt: new Date().toISOString()
  };

  fs.mkdirSync(path.join(instancesDir, instance.id, 'mods'), { recursive: true });
  store.instances.push(instance);
  store.activeId = instance.id;
  saveInstances(store);

  return { ok: true, id: instance.id };
});

ipcMain.handle('select-instance', (event, id) => {
  const store = loadInstances();
  // null puts the player back on the plain path, with the settings page in
  // charge again. It is a choice, not an absence of one.
  store.activeId = id && store.instances.some(entry => entry.id === id) ? id : null;
  saveInstances(store);
  return store.activeId;
});

ipcMain.handle('delete-instance', async (event, id) => {
  const store = loadInstances();
  const instance = store.instances.find(entry => entry.id === id);
  if (!instance) return { ok: false };

  const t = loadTranslations(currentLocale);
  const answer = dialog.showMessageBoxSync({
    type: 'warning',
    title: t['packs.deleteTitle'],
    message: `${t['packs.deleteTitle']}: ${instance.name}`,
    detail: t['packs.deleteWarning'],
    buttons: [t['packs.deleteConfirm'], t['modal.close']],
    defaultId: 1,
    cancelId: 1
  });
  if (answer !== 0) return { ok: false };

  // Worlds live in here too, so it goes to the recycle bin rather than being
  // erased - a wrong click should be survivable.
  await shell.trashItem(instanceFolder(instance)).catch(() => {
    fs.rmSync(instanceFolder(instance), { recursive: true, force: true });
  });

  store.instances = store.instances.filter(entry => entry.id !== id);
  if (store.activeId === id) store.activeId = null;
  saveInstances(store);
  return { ok: true };
});

ipcMain.handle('open-instance-folder', (event, id) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  if (instance) shell.openPath(instanceFolder(instance));
});

ipcMain.handle('list-instance-mods', (event, id, kind) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  return instance ? listInstanceContent(instance, kind || 'mod') : [];
});

ipcMain.handle('remove-instance-mod', (event, id, filename, kind) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  const spec = CONTENT_KINDS[kind || 'mod'];
  if (!instance || !spec || filename !== path.basename(filename)) return { ok: false };

  const file = path.join(instanceFolder(instance), spec.folder, filename);
  if (fs.existsSync(file)) fs.rmSync(file, { recursive: true, force: true });
  return { ok: true };
});

ipcMain.handle('get-mod-categories', () => modrinthCategories());

ipcMain.handle('search-modpacks', async (event, query, offset, categories) => {
  try {
    return await searchModpacks(query, offset || 0, categories || []);
  } catch (e) {
    return { error: e.message };
  }
});

// Installing a whole pack takes minutes, so the page is told how it is going.
ipcMain.handle('install-modpack', async (event, projectId) => {
  try {
    const report = progress => event.sender.send('modpack-progress', progress);
    return { ok: true, pack: await installModpack(projectId, report) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pick-modpack-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Modpack', extensions: ['mrpack', 'zip'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('install-local-modpack', async (event, filePath) => {
  try {
    const report = progress => event.sender.send('modpack-progress', progress);
    return { ok: true, pack: await installLocalModpack(filePath, report) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-shader-support', (event, id) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  if (!instance) return { ready: false };

  const needed = shaderLoaderFor(instance);
  return { ready: hasShaderLoader(instance), projectId: needed.id, name: needed.name };
});

ipcMain.handle('search-mods', async (event, id, query, offset, categories, kind) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  if (!instance) return { error: 'no-instance' };

  try {
    return await modProviders.modrinth.search(query, instance, offset || 0, categories || [], kind || 'mod');
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('install-mod', async (event, id, source, projectId, kind) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  if (!instance) return { ok: false, error: 'no-instance' };

  try {
    return { ok: true, installed: await installMod(instance, source, projectId, kind || 'mod') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-game', (event, profile) => startGame(profile));

// ramOverride is set when the launcher is having a second go with a smaller
// heap, after Java refused to start with the first one.
async function startGame(profile, ramOverride) {
  const settings = loadSettings();
  const launcher = new Client();

  // A chosen pack answers for its own version, loader and folder. Nothing
  // else changes: the same code launches both paths, so a pack cannot end up
  // on a route the plain one has not already proved.
  const pack = activeInstance();
  if (pack) {
    settings.version = pack.version;
    settings.loader = pack.loader;
    settings.loaderVersion = pack.loaderVersion;
    settings.gameFolder = instanceFolder(pack);
    if (pack.ram) settings.ram = pack.ram;
  }

  const effectiveRam = ramOverride || (settings.ramAuto && !pack?.ram ? autoRamMB() : settings.ram);

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

        // Only the universal-jar era, 1.6 to 1.11. From 1.12 the installer
        // route brings its own libraries and needs no help.
        if (forgeArtifactKind(settings.version) === 'universal') {
          await ensureForgeLibraries(settings.gameFolder, opts.forge);
        }
      }
    } catch (e) {
      if (e.message === 'needs-modloader') {
        const t = loadTranslations(currentLocale);
        dialog.showMessageBox({
          type: 'info',
          title: t['jarmods.needsModLoaderTitle'],
          message: t['jarmods.needsModLoaderTitle'],
          detail: `${t['jarmods.needsModLoader']}\n\n${path.join(settings.gameFolder, 'jarmods')}`
        });
        return { started: false, error: 'needs-modloader' };
      }
      return { started: false, error: `loader: ${e.message}` };
    }
  } else if (forgeUsesJarMod(settings.version) && listUserJarMods(settings.gameFolder).length > 0) {
    // No loader picked, but the player has put jar mods in place - on these
    // versions that is how mods were installed, loader or not.
    try {
      opts.version.custom = await installLegacyProfile(
        settings.version, settings.gameFolder, `${settings.version}-jarmod`, null
      );
      reconcileLanguageOption(
        settings.gameFolder,
        path.join(settings.gameFolder, 'versions', opts.version.custom, `${opts.version.custom}.jar`)
      );
      opts.customArgs = [
        ...(opts.customArgs || []),
        `-Dminecraft.applet.TargetDirectory=${settings.gameFolder}`
      ];
    } catch (e) {
      return { started: false, error: `jarmods: ${e.message}` };
    }
  }

  // Only the shared folder needs this. A pack has a folder to itself, so
  // nothing is there to clash with it, and shuffling its config about would
  // be meddling for no reason.
  if (!pack) {
    try {
      useConfigOf(settings.gameFolder, `${settings.version}-${settings.loader || 'vanilla'}`);
    } catch (e) {
      console.log('Could not swap the config folder:', e.message);
    }
  }

  // Whatever the player typed goes on last, so it wins over what the launcher
  // worked out - that is the point of being able to type it.
  const extraArgs = String(settings.javaArgs || '').trim();
  if (extraArgs) {
    opts.customArgs = [...(opts.customArgs || []), ...extraArgs.split(/\s+/)];
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

  // Getting out of the way, but only once the game is actually on screen -
  // minimising while it is still downloading would leave the player looking
  // at an empty desktop with no sign that anything is happening.
  const launcherWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  let steppedAside = false;

  launcher.on('data', () => {
    if (steppedAside || !launcherWindow || launcherWindow.isDestroyed()) return;
    steppedAside = true;

    if (settings.onGameStart === 'minimize') launcherWindow.minimize();
    else if (settings.onGameStart === 'close') app.quit();
  });

  launcher.on('close', (code) => {
    // Back where it was. A crash is exactly when the launcher is wanted
    // again, so this happens before the report below.
    if (settings.onGameStart === 'minimize' && launcherWindow && !launcherWindow.isDestroyed()) {
      launcherWindow.restore();
      launcherWindow.focus();
    }

    if (code === 0) return;

    // The last words arrive after the process is already gone. Judging the
    // crash the instant it closes meant reading a report with its ending
    // missing - which is how a plain "exit code 1" was shown for a failure
    // that had said exactly what was wrong a moment later.
    setTimeout(
      () => reportGameCrash(code, recentOutput.join('\n'), effectiveRam, freeAtLaunch, profile),
      300
    );
  });

  return { started: true, error: null };
}

// Where mods come from. One shape for every source, so adding CurseForge
// later means adding an entry here rather than touching the pages.
//
// CurseForge is deliberately absent for now: its API needs a developer key we
// do not have, and offering a source that cannot answer would be a button
// leading nowhere.
const MODRINTH = 'https://api.modrinth.com/v2';

// Modrinth asks to be told who is calling, and it is only polite to answer.
const MOD_API_HEADERS = {
  'User-Agent': 'Kompatui/PeroLauncher/1.0 (https://github.com/Kompatui/PeroLauncher)'
};

// Quilt runs Fabric's mods, so a Quilt pack should be offered them too -
// refusing would hide almost everything that exists for it.
function loaderTags(loader) {
  if (loader === 'quilt') return ['quilt', 'fabric'];
  return [loader];
}

// What a pack can be given, and where each kind belongs once it arrives.
// A texture pack is not a category of mod - it is a different kind of thing
// entirely, which is why asking only for mods made them impossible to find.
const CONTENT_KINDS = {
  mod: { type: 'mod', folder: 'mods', extension: '.jar' },
  resourcepack: { type: 'resourcepack', folder: 'resourcepacks', extension: '.zip' },
  shader: { type: 'shader', folder: 'shaderpacks', extension: '.zip' }
};

// Texture packs are made for the game, not for a loader; shaders are made for
// the mod that renders them, which is a different thing again.
function kindLoaders(kind, instance) {
  if (kind === 'resourcepack') return ['minecraft'];
  if (kind === 'shader') return ['iris', 'optifine'];
  return loaderTags(instance.loader);
}

// A shader is not a mod and does nothing on its own: something has to render
// it. Iris does that on Fabric, Quilt and NeoForge, Oculus on Forge. Rather
// than hide the shaders from a pack that has neither, the launcher says what
// is missing and offers to fetch it.
const SHADER_LOADERS = {
  iris: { id: 'YL57xq9U', name: 'Iris' },
  oculus: { id: 'GchcoXML', name: 'Oculus' }
};

function shaderLoaderFor(instance) {
  return instance.loader === 'forge' ? SHADER_LOADERS.oculus : SHADER_LOADERS.iris;
}

// Whether this pack can already show a shader. The file name is checked as
// well as our own record, because a player may have put the mod there by hand
// and would rightly expect that to count.
function hasShaderLoader(instance) {
  return listInstanceContent(instance, 'mod').some(mod =>
    mod.projectId === SHADER_LOADERS.iris.id ||
    mod.projectId === SHADER_LOADERS.oculus.id ||
    /\b(iris|oculus|optifine)\b/i.test(mod.filename)
  );
}

// The categories each kind is filed under, taken from Modrinth rather than
// written down here - a list kept by hand drifts from the real one, and the
// player is the one who finds out.
const categoriesCachePath = 'E:\\PeroLauncher\\modrinth-categories.json';

async function modrinthCategories() {
  try {
    const tags = await fetchJson(`${MODRINTH}/tag/category`, { headers: MOD_API_HEADERS });
    const grouped = {};
    for (const tag of tags) (grouped[tag.project_type] ||= []).push(tag.name);
    fs.writeFileSync(categoriesCachePath, JSON.stringify(grouped));
    return grouped;
  } catch {
    // The catalogue still works without them; the filters simply do not show.
    try {
      return JSON.parse(fs.readFileSync(categoriesCachePath, 'utf-8'));
    } catch {
      return {};
    }
  }
}

const modProviders = {
  modrinth: {
    id: 'modrinth',
    name: 'Modrinth',

    async search(query, instance, offset = 0, categories = [], kind = 'mod') {
      const facets = [[`project_type:${kind}`], [`versions:${instance.version}`]];

      // Only mods care which loader is underneath them.
      if (kind === 'mod' && instance.loader && instance.loader !== 'vanilla') {
        facets.push(loaderTags(instance.loader).map(tag => `categories:${tag}`));
      }

      // Each chosen category is its own group, which narrows rather than
      // widens: asking for magic and storage means both, as it does on the
      // site people are used to.
      for (const category of categories) {
        facets.push([`categories:${category}`]);
      }

      const url = `${MODRINTH}/search?limit=20&offset=${offset}` +
        `&query=${encodeURIComponent(query || '')}` +
        `&facets=${encodeURIComponent(JSON.stringify(facets))}` +
        `&index=${query ? 'relevance' : 'downloads'}`;

      const data = await fetchJson(url, { headers: MOD_API_HEADERS });
      return {
        total: data.total_hits,
        mods: (data.hits || []).map(hit => ({
          source: 'modrinth',
          id: hit.project_id,
          slug: hit.slug,
          title: hit.title,
          description: hit.description,
          author: hit.author,
          downloads: hit.downloads,
          follows: hit.follows,
          // The loaders are in here too and would only repeat what the pack
          // already is, so they are dropped and the subject matter kept.
          categories: (hit.display_categories || hit.categories || [])
            .filter(category => !['fabric', 'forge', 'quilt', 'neoforge'].includes(category))
            .slice(0, 4),
          icon: hit.icon_url || null
        }))
      };
    },

    // The newest build of this mod that fits the pack. Returned rather than
    // downloaded, so dependencies can be walked before anything is written.
    async pickFile(projectId, instance, kind = 'mod') {
      const loaders = JSON.stringify(kindLoaders(kind, instance));
      const versions = JSON.stringify([instance.version]);
      const url = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version` +
        `?loaders=${encodeURIComponent(loaders)}&game_versions=${encodeURIComponent(versions)}`;

      const builds = await fetchJson(url, { headers: MOD_API_HEADERS });
      if (!Array.isArray(builds) || !builds.length) return null;

      const build = builds[0];   // Newest first.
      const file = build.files.find(entry => entry.primary) || build.files[0];
      if (!file) return null;

      return {
        projectId,
        versionId: build.id,
        title: build.name,
        filename: file.filename,
        url: file.url,
        sha1: file.hashes?.sha1 || null,
        // Only what the mod cannot run without. Optional extras are the
        // player's business, not ours to decide for them.
        requires: (build.dependencies || [])
          .filter(dependency => dependency.dependency_type === 'required' && dependency.project_id)
          .map(dependency => dependency.project_id)
      };
    }
  }
};

// What the pack has in it. The record is the launcher's own, but the folder
// is the truth: a file dropped in by hand counts just as much as one we
// fetched, and is listed so it can be seen and removed here.
function listInstanceContent(instance, kind = 'mod') {
  const spec = CONTENT_KINDS[kind];
  if (!spec) return [];

  const folder = path.join(instanceFolder(instance), spec.folder);
  if (!fs.existsSync(folder)) return [];

  const recordPath = path.join(instanceFolder(instance), 'mods.json');
  let known = [];
  try {
    known = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  } catch {
    known = [];
  }

  // A texture pack may be a folder rather than a zip, and that is a perfectly
  // ordinary way to have one.
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter(entry => (kind === 'resourcepack' && entry.isDirectory()) ||
                     new RegExp(`\\${spec.extension}$`, 'i').test(entry.name))
    .map(entry => {
      const record = known.find(item => item.filename === entry.name && (item.kind || 'mod') === kind);
      return {
        filename: entry.name,
        title: record?.title || entry.name.replace(/\.(jar|zip)$/i, ''),
        source: record?.source || null,
        projectId: record?.projectId || null,
        kind
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function rememberMod(instance, entry) {
  const recordPath = path.join(instanceFolder(instance), 'mods.json');
  let known = [];
  try {
    known = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  } catch {
    known = [];
  }

  known = known.filter(item => item.filename !== entry.filename);
  known.push(entry);
  fs.writeFileSync(recordPath, JSON.stringify(known, null, 2));
}

// Installs a mod and everything it cannot run without. A mod that quietly
// fails to load because a library is missing is the launcher's fault, not the
// player's, so the dependencies come along without being asked about.
async function installMod(instance, source, projectId, kind = 'mod', seen = new Set()) {
  if (seen.has(projectId)) return [];
  seen.add(projectId);

  const provider = modProviders[source];
  if (!provider) throw new Error(`unknown source: ${source}`);

  const spec = CONTENT_KINDS[kind] || CONTENT_KINDS.mod;

  const file = await provider.pickFile(projectId, instance, kind);
  if (!file) return [{ projectId, ok: false, reason: 'no-build' }];

  const folder = path.join(instanceFolder(instance), spec.folder);
  fs.mkdirSync(folder, { recursive: true });
  const destination = path.join(folder, file.filename);

  if (!fs.existsSync(destination)) {
    const data = await fetchBuffer(file.url, { headers: MOD_API_HEADERS });

    if (file.sha1) {
      const got = crypto.createHash('sha1').update(data).digest('hex');
      if (got !== file.sha1) throw new Error(`${file.filename}: the download does not match its hash`);
    }
    fs.writeFileSync(destination, data);
  }

  rememberMod(instance, {
    filename: file.filename,
    title: file.title,
    source,
    projectId,
    versionId: file.versionId,
    kind
  });

  const installed = [{ projectId, ok: true, filename: file.filename, title: file.title }];

  // A texture pack has nothing to bring with it; only mods do.
  for (const dependency of kind === 'mod' ? file.requires : []) {
    installed.push(...await installMod(instance, source, dependency, kind, seen));
  }
  return installed;
}

// A ready-made pack says which loader it wants in these terms.
const LOADER_FROM_DEPENDENCY = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  'forge': 'forge',
  'neoforge': 'neoforge'
};

// Where a file from someone else's archive is allowed to land. The paths
// inside come from a stranger, and a path that climbs out of the folder would
// let a pack write anywhere on the machine.
function safeInside(folder, relative) {
  const full = path.resolve(folder, relative);
  const root = path.resolve(folder);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

// Searching for whole packs rather than for pieces to put in one. Nothing is
// filtered by version or loader here: a ready-made pack brings its own.
async function searchModpacks(query, offset = 0, categories = []) {
  const facets = [['project_type:modpack']];
  for (const category of categories) facets.push([`categories:${category}`]);

  const url = `${MODRINTH}/search?limit=20&offset=${offset}` +
    `&query=${encodeURIComponent(query || '')}` +
    `&facets=${encodeURIComponent(JSON.stringify(facets))}` +
    `&index=${query ? 'relevance' : 'downloads'}`;

  const data = await fetchJson(url, { headers: MOD_API_HEADERS });
  return {
    total: data.total_hits,
    mods: (data.hits || []).map(hit => ({
      source: 'modrinth',
      id: hit.project_id,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      downloads: hit.downloads,
      categories: (hit.display_categories || hit.categories || []).slice(0, 4),
      icon: hit.icon_url || null,
      versions: hit.versions?.slice(-1)[0] || null
    }))
  };
}

// Installs a whole pack as a new one of ours: its version, its loader, its
// mods and whatever else it ships. Long enough that it reports as it goes -
// several minutes of silence would look like a hang.
async function installModpack(projectId, report = () => {}) {
  const builds = await fetchJson(
    `${MODRINTH}/project/${encodeURIComponent(projectId)}/version`, { headers: MOD_API_HEADERS });
  if (!Array.isArray(builds) || !builds.length) throw new Error('this pack has no published build');

  const build = builds[0];
  const archive = build.files.find(file => file.primary) || build.files[0];
  if (!archive) throw new Error('this build has no file');

  report({ stage: 'downloading', done: 0, total: 0 });
  const data = await fetchBuffer(archive.url, { headers: MOD_API_HEADERS });

  return installPackArchive(data, {
    source: 'modrinth',
    projectId,
    versionId: build.id,
    versionNumber: build.version_number
  }, report);
}

// The same pack, handed over as a file instead of fetched. A .mrpack from a
// friend, a forum or the author's own hard disk is the same archive Modrinth
// serves, so it is unpacked by the same code.
async function installLocalModpack(filePath, report = () => {}) {
  if (!fs.existsSync(filePath)) throw new Error('there is no such file');
  return installPackArchive(fs.readFileSync(filePath), { source: 'file', from: filePath }, report);
}

// Everything a pack archive holds, laid out as a pack of ours.
async function installPackArchive(data, origin, report = () => {}) {
  const zip = new AdmZip(data);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('this file is not a Modrinth pack');

  const index = JSON.parse(indexEntry.getData().toString('utf-8'));

  const mcVersion = index.dependencies?.minecraft;
  if (!mcVersion) throw new Error('the pack does not say which Minecraft it is for');

  let loader = 'vanilla';
  let loaderVersion = null;
  for (const [dependency, version] of Object.entries(index.dependencies || {})) {
    if (LOADER_FROM_DEPENDENCY[dependency]) {
      loader = LOADER_FROM_DEPENDENCY[dependency];
      loaderVersion = version;
    }
  }

  const store = loadInstances();
  const instance = {
    id: instanceId(index.name || 'pack', store.instances.map(entry => entry.id)),
    name: index.name || 'Modpack',
    version: mcVersion,
    loader,
    loaderVersion,
    ram: null,
    fromModpack: origin,
    createdAt: new Date().toISOString()
  };

  const folder = instanceFolder(instance);
  fs.mkdirSync(folder, { recursive: true });

  // Only what a player needs. A pack carries server-side files too, and
  // fetching them would be minutes spent on things this machine never runs.
  const wanted = (index.files || []).filter(file => file.env?.client !== 'unsupported');

  let done = 0;
  for (const file of wanted) {
    const destination = safeInside(folder, file.path);
    if (!destination) {
      console.log('[MODPACK] refused a path outside the pack folder:', file.path);
      continue;
    }

    report({ stage: 'files', done, total: wanted.length, name: path.basename(file.path) });

    let saved = false;
    for (const url of file.downloads || []) {
      try {
        const contents = await fetchBuffer(url, { headers: MOD_API_HEADERS });
        if (file.hashes?.sha1) {
          const got = crypto.createHash('sha1').update(contents).digest('hex');
          if (got !== file.hashes.sha1) continue;   // Try the next address.
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, contents);
        saved = true;
        break;
      } catch {
        // The pack may list several places to get it from.
      }
    }

    if (!saved) console.log('[MODPACK] could not obtain', file.path);
    done++;
  }

  // Configs, keybinds and the rest the pack ships as plain files.
  report({ stage: 'overrides', done: wanted.length, total: wanted.length });
  for (const entry of zip.getEntries()) {
    const match = entry.entryName.match(/^(?:client-)?overrides\/(.+)$/);
    if (!match || entry.isDirectory) continue;

    const destination = safeInside(folder, match[1]);
    if (!destination) continue;

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.getData());
  }

  store.instances.push(instance);
  store.activeId = instance.id;
  saveInstances(store);

  report({ stage: 'done', done: wanted.length, total: wanted.length });
  return { id: instance.id, name: instance.name, version: mcVersion, loader, files: wanted.length };
}

// Minecraft writes its own account of a crash here, and it says far more than
// the last lines of output ever can.
ipcMain.handle('open-crash-reports', () => {
  const settings = loadSettings();
  const reports = path.join(settings.gameFolder, 'crash-reports');
  shell.openPath(fs.existsSync(reports) ? reports : settings.gameFolder);
});

// Two different things write a report when the game dies, and a player has no
// reason to know the difference: the game writes crash-reports/crash-*.txt
// when it catches the problem itself, and Java writes hs_err_pid*.log when it
// falls over so hard the game never gets a say. Both are listed together.
function listCrashReports(gameFolder) {
  const found = [];

  const add = (file, kind) => {
    try {
      const stat = fs.statSync(file);
      found.push({
        id: `${kind}:${path.basename(file)}`,
        name: path.basename(file),
        kind,
        when: stat.mtime.toISOString(),
        size: stat.size
      });
    } catch {
      // Vanished between listing and reading. Nothing to report.
    }
  };

  const reports = path.join(gameFolder, 'crash-reports');
  if (fs.existsSync(reports)) {
    for (const name of fs.readdirSync(reports)) {
      if (name.endsWith('.txt')) add(path.join(reports, name), 'game');
    }
  }

  if (fs.existsSync(gameFolder)) {
    for (const name of fs.readdirSync(gameFolder)) {
      if (/^hs_err_pid\d+\.log$/.test(name)) add(path.join(gameFolder, name), 'jvm');
    }
  }

  return found.sort((a, b) => b.when.localeCompare(a.when));
}

// The name is picked from a list the launcher itself produced, and it is
// resolved back to a folder here rather than trusted as a path - a page
// should never be able to name a file outside these two folders.
function crashReportPath(gameFolder, id) {
  const separator = id.indexOf(':');
  const kind = id.slice(0, separator);
  const name = id.slice(separator + 1);

  if (name !== path.basename(name)) return null;
  if (kind === 'game' && name.endsWith('.txt')) {
    return path.join(gameFolder, 'crash-reports', name);
  }
  if (kind === 'jvm' && /^hs_err_pid\d+\.log$/.test(name)) {
    return path.join(gameFolder, name);
  }
  return null;
}

// The one line worth reading first. The game states its own cause under
// "Description"; Java puts its own on a line beginning with "#".
function crashHeadline(text) {
  const description = text.match(/^Description:\s*(.+)$/m);
  const exception = text.match(/^([\w.$]+(?:Exception|Error)[^\n]*)$/m);
  if (description) {
    return exception ? `${description[1].trim()} - ${exception[1].trim()}` : description[1].trim();
  }

  const jvm = text.match(/^#\s+(.*(?:SIGSEGV|EXCEPTION|Out of Memory|memory).*)$/mi);
  if (jvm) return jvm[1].trim();

  return exception ? exception[1].trim() : null;
}

ipcMain.handle('list-crash-reports', () => {
  const settings = loadSettings();
  try {
    return listCrashReports(settings.gameFolder);
  } catch {
    return [];
  }
});

ipcMain.handle('read-crash-report', (event, id) => {
  const settings = loadSettings();
  const file = crashReportPath(settings.gameFolder, String(id || ''));
  if (!file || !fs.existsSync(file)) return { ok: false };

  let text = fs.readFileSync(file, 'utf-8');

  // These run to hundreds of kilobytes of register dumps and loaded
  // libraries. The top is where the reason is; the rest is for a search
  // engine, and the file itself is one click away.
  const limit = 60000;
  const trimmed = text.length > limit;
  if (trimmed) text = text.slice(0, limit);

  return { ok: true, text, trimmed, headline: crashHeadline(text) };
});

ipcMain.handle('reveal-crash-report', (event, id) => {
  const settings = loadSettings();
  const file = crashReportPath(settings.gameFolder, String(id || ''));
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
});

// Every version writes its mod settings into the same config folder, and the
// formats are not the same. Forge for 1.6.4 writes lists as
//
//   I:biomeSkyBlendRange <
//       20
//   >
//
// and Forge for 1.4.2 has never heard of that, so it dies on the file with
// "unknown character" before the game window appears. The player did nothing
// wrong: they played a newer version once.
//
// So the folder belongs to one version at a time. The one on its way out is
// put away under its own name and brought back when that version is played
// again. Worlds, resource packs and screenshots stay shared, which is what
// people actually want shared.
function useConfigOf(gameFolder, versionKey) {
  const configDir = path.join(gameFolder, 'config');
  const store = path.join(gameFolder, 'config-per-version');
  const ownerFile = path.join(store, 'owner.txt');

  const key = versionKey.replace(/[^A-Za-z0-9._-]/g, '_');
  const owner = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, 'utf-8').trim() : null;
  if (owner === key) return;

  fs.mkdirSync(store, { recursive: true });

  // Put the outgoing settings away. Without a recorded owner there is no
  // telling whose they are, so they are kept aside rather than thrown out.
  if (fs.existsSync(configDir)) {
    const kept = path.join(store, owner || 'unclaimed');
    fs.rmSync(kept, { recursive: true, force: true });
    fs.renameSync(configDir, kept);
  }

  const mine = path.join(store, key);
  if (fs.existsSync(mine)) fs.renameSync(mine, configDir);
  else fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(ownerFile, key);
}

// Java refusing to start at all because the heap it was asked for will not
// fit. Nothing has run yet, nothing is lost, and a smaller heap would work -
// which is why this is worth telling apart from a game that died mid-play.
// Either line is proof enough on its own terms. Demanding both missed the
// real thing: the process died so fast that "Could not create the Java
// Virtual Machine" never reached us, and the player got a bare exit code for
// a problem the launcher could have fixed in one click.
function heapTooBigToStart(output) {
  const failedToStart = /Error occurred during initialization of VM|Could not create the Java Virtual Machine/i.test(output);
  const aboutMemory = /Unable to allocate|Could not reserve enough space|insufficient memory|Failed to allocate|object heap/i.test(output);
  return failedToStart && aboutMemory;
}

// A heap that stands a chance this time. Java needs room for the heap itself
// plus its own bookkeeping, so it asks for rather more than the number given.
function smallerHeap(effectiveRam, freeAtLaunch) {
  const fromFree = Math.floor((freeAtLaunch - 768) / 512) * 512;
  const fromLast = Math.floor((effectiveRam * 0.6) / 512) * 512;
  return Math.max(1024, Math.min(fromFree, fromLast));
}

// Without this the launcher stays silent and the game just blinks and
// disappears, which tells the player nothing at all.
function reportGameCrash(code, output, effectiveRam, freeAtLaunch, profile) {
  const t = loadTranslations(currentLocale);

  // Which reading of the crash was taken, so a wrong one can be seen from the
  // terminal instead of guessed at from the dialog that followed.
  console.log(`[CRASH] exit ${code}, ${output.length} chars captured, ` +
    `heap-too-big-to-start: ${heapTooBigToStart(output)}`);

  // The game never started: Java would not take the heap.
  if (heapTooBigToStart(output)) {
    const retryWith = smallerHeap(effectiveRam, freeAtLaunch);

    const answer = dialog.showMessageBoxSync({
      type: 'warning',
      title: t['crash.title'],
      message: t['crash.heapTooBigShort'],
      detail: `${t['crash.heapTooBig']}\n\n` +
        `${t['crash.givenRam']}: ${effectiveRam} ${t['settings.mib']}\n` +
        `${t['crash.freeAtLaunch']}: ${freeAtLaunch} ${t['settings.mib']}\n\n` +
        `${t['crash.heapIsNotAll']}`,
      buttons: [`${t['crash.retryWith']} ${retryWith} ${t['settings.mib']}`, t['crash.giveUp']],
      defaultId: 0,
      cancelId: 1
    });

    // Only this once, and only for this launch - the setting is left alone,
    // because a machine with a browser closed will take the larger figure
    // again tomorrow.
    if (answer === 0 && profile) startGame(profile, retryWith);
    return;
  }

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

// Which game version a custom profile is really a build of. The profile says
// so itself when it was made by Fabric, Quilt or NeoForge; the ones written
// here for the jar mod era are a copy of the vanilla description under a new
// name, and there the name is what is left to go on.
function baseVersionOf(gameFolder, profileId, officialIds) {
  const jsonPath = path.join(gameFolder, 'versions', profileId, `${profileId}.json`);
  try {
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (json.inheritsFrom) return json.inheritsFrom;
  } catch {
    // Fall through to reading the name.
  }

  // The longest official id the name starts with, so 1.12.2 is never mistaken
  // for 1.12 just because it was tried first.
  let best = null;
  for (const id of officialIds) {
    if (!profileId.startsWith(id)) continue;
    if (!best || id.length > best.length) best = id;
  }
  return best;
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
  // (Forge, Fabric, and so on). Each one belongs directly under the version it
  // was built from - pushed to the top of the list it says nothing about where
  // it fits, and 1.2.5 with Forge ends up above 1.21.
  const officialIds = [...official.keys()];
  const orphans = [];

  for (const id of installed) {
    if (versions.some(v => v.id === id)) continue;
    const known = official.get(id);
    const entry = {
      id,
      type: known ? known.type : 'custom',
      releaseTime: known ? known.releaseTime : null,
      installed: true,
      custom: !known
    };

    const base = known ? null : baseVersionOf(settings.gameFolder, id, officialIds);
    const at = base ? versions.findIndex(v => v.id === base) : -1;

    if (at === -1) orphans.push(entry);
    else {
      entry.basedOn = base;
      // After the base version and after any builds already placed under it,
      // so several loaders on one version keep the order they were found in.
      let insertAt = at + 1;
      while (insertAt < versions.length && versions[insertAt].basedOn === base) insertAt++;
      versions.splice(insertAt, 0, entry);
    }
  }

  return {
    // Only what could not be placed goes to the top - there is nowhere else
    // for it, and it is still the player's own build.
    versions: [...orphans, ...versions],
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

    async installJarMod(mcVersion, loaderVersion, gameFolder) {
      const archive = await this.fetchJarModArchive(`${mcVersion}-${loaderVersion}`);
      return installLegacyProfile(mcVersion, gameFolder, this.profileId(mcVersion, loaderVersion), archive);
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

      // Only 1.5 and later ask for this; FML in 1.3 and 1.4 has no idea it
      // exists, and demanding it there would fail the launch over nothing.
      if (needsDeobfuscationData(archive)) {
        await placeFmlLibrary(
          { name: `deobfuscation_data_${mcVersion}.zip`, sha1: null },
          libDirectory
        );
      }
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

// The runtime deobfuscation map arrived with FML 5, which shipped for 1.5.
// Older builds never mention it, so the build itself is asked.
function needsDeobfuscationData(archive) {
  const entry = new AdmZip(archive).getEntry('cpw/mods/fml/relauncher/FMLInjectionData.class');
  if (!entry) return false;
  return entry.getData().toString('latin1').includes('deobfuscation_data_');
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
//
// The index needs its own retries. It answers 200 with an empty body often
// enough - the same query returns six captures one minute and nothing the
// next - and an empty answer is indistinguishable from "this was never
// archived" unless it is asked again. Believing the first empty reply is how
// a file that is perfectly available turns into "cannot obtain".
async function archivedUrls(originalUrl, attempts = 3) {
  const index = 'https://web.archive.org/cdx/search/cdx' +
    `?url=${encodeURIComponent(originalUrl)}&output=json&filter=statuscode:200&limit=-6`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let rows;
    try {
      rows = await fetchJson(index);
    } catch {
      rows = null;
    }

    if (Array.isArray(rows) && rows.length >= 2) {
      return rows.slice(1)
        .map(row => row[1])
        .reverse()
        .map(timestamp => `https://web.archive.org/web/${timestamp}id_/${originalUrl}`);
    }

    if (attempt < attempts) await new Promise(done => setTimeout(done, 2000));
  }

  return [];
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
function buildJarMod(vanillaJar, layers) {
  const patched = new AdmZip(vanillaJar);

  // Collect first, delete after: removing entries while walking the same list
  // makes the walk skip half of them, and the leftover signatures are exactly
  // what stops the game from starting.
  const signatures = patched.getEntries()
    .map(entry => entry.entryName)
    .filter(name => name.startsWith('META-INF/'));
  for (const name of signatures) patched.deleteFile(name);

  // Later layers win, which is why the order they are applied in matters:
  // ModLoader first, then whatever builds on top of it.
  for (const layer of layers) {
    for (const entry of new AdmZip(layer).getEntries()) {
      if (entry.isDirectory || entry.entryName.startsWith('META-INF/')) continue;
      patched.deleteFile(entry.entryName);
      patched.addFile(entry.entryName, entry.getData());
    }
  }

  return patched.toBuffer();
}

// Builds the patched game jar and registers it as a version of its own, so the
// vanilla jar next to it stays untouched. The player's own jar mods go on
// first and the loader last, which is the order that era expected: ModLoader
// underneath, Forge on top of it.
async function installLegacyProfile(mcVersion, gameFolder, profileId, loaderArchive) {
  const userMods = listUserJarMods(gameFolder);
  const directory = path.join(gameFolder, 'versions', profileId);
  const jarPath = path.join(directory, `${profileId}.jar`);
  const jsonPath = path.join(directory, `${profileId}.json`);
  const stampPath = path.join(directory, 'jarmods.json');

  // Rebuilt when the player's set of jar mods changes - otherwise adding one
  // would silently do nothing, since the patched jar is already there.
  const stamp = JSON.stringify(userMods.map(file => ({
    name: path.basename(file),
    size: fs.statSync(file).size
  })));

  const built = fs.existsSync(jarPath) && fs.existsSync(jsonPath);
  const sameMods = fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf-8') === stamp;
  if (built && sameMods) return profileId;

  const meta = await versionMetadata(mcVersion);
  const vanillaJar = await fetchBuffer(meta.downloads.client.url);

  const layers = userMods.map(file => fs.readFileSync(file));
  if (loaderArchive) layers.push(loaderArchive);

  const patched = buildJarMod(vanillaJar, layers);

  // Forge before 1.3 calls into ModLoader without carrying it, so a jar built
  // without it starts and dies on a missing class. Saying so plainly here beats
  // letting the player decode a Java stack trace.
  if (missingModLoader(patched)) {
    throw new Error('needs-modloader');
  }

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(jarPath, patched);
  fs.writeFileSync(stampPath, stamp);

  // The vanilla description, renamed. Everything the mods add already lives
  // inside the patched jar, so nothing else has to be declared.
  fs.writeFileSync(jsonPath, JSON.stringify({ ...meta, id: profileId }, null, 2));
  return profileId;
}

// Where a Forge library can be found. Its own address first, then the three
// hosts that between them still carry everything that era needs - argo and
// lzma survive only at Mojang, guava is everywhere, Forge's own maven has the
// rest.
const FORGE_LIBRARY_SOURCES = [
  'https://maven.minecraftforge.net/',
  'https://libraries.minecraft.net/',
  'https://repo1.maven.org/maven2/'
];

// minecraft-launcher-core writes some of these into the class path without
// ever downloading them: 1.6.4 asked for guava 14.0, put it on the command
// line, and left the file absent, so FML died on a missing class before the
// game window appeared. Fetching them ourselves makes that moot.
async function ensureForgeLibraries(gameFolder, forgeJarPath) {
  const entry = new AdmZip(forgeJarPath).getEntry('version.json');
  if (!entry) return;

  let json;
  try {
    json = JSON.parse(entry.getData().toString('utf-8'));
  } catch {
    return;
  }

  for (const library of json.libraries || []) {
    // Native libraries are unpacked by MCLC from its own copies.
    if (library.natives) continue;

    const [group, artifact, version] = library.name.split(':');
    // Forge itself is handed over as the jar, not fetched from a repository.
    if (group === 'net.minecraftforge') continue;

    const relative = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    const destination = path.join(gameFolder, 'libraries', relative);
    if (fs.existsSync(destination)) continue;

    const sources = library.url
      ? [library.url, ...FORGE_LIBRARY_SOURCES]
      : FORGE_LIBRARY_SOURCES;

    for (const base of sources) {
      try {
        const data = await fetchBuffer(base + relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data);
        break;
      } catch {
        // Try the next host; a missing file here is not fatal on its own.
      }
    }
  }
}

// True when something in the jar calls ModLoader but nothing provides it.
// Forge of 1.1 and 1.2.5 was a layer on top of ModLoader rather than a
// replacement for it, and shipped without it - the player installed both.
function missingModLoader(patchedJar) {
  const zip = new AdmZip(patchedJar);
  if (zip.getEntry('ModLoader.class')) return false;

  return zip.getEntries().some(entry =>
    entry.entryName.endsWith('.class') &&
    entry.getData().toString('latin1').includes('ModLoader')
  );
}

// Files the player drops in themselves. Mods of that era - ModLoader, Optifine,
// anything from 2011 to 2013 - are installed by being pasted into the game jar,
// and some of them are things we may not fetch on their behalf. Order is
// alphabetical, so a name can decide it: "1-ModLoader.zip" goes before "2-...".
function listUserJarMods(gameFolder) {
  const directory = path.join(gameFolder, 'jarmods');
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory)
    .filter(name => /\.(zip|jar)$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map(name => path.join(directory, name));
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

async function fetchJson(url, options = {}) {
  return (await fetchWithRetry(url, options)).json();
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

ipcMain.handle('get-jarmods', () => {
  const settings = loadSettings();
  return {
    files: listUserJarMods(settings.gameFolder).map(file => path.basename(file)),
    // Only these versions take jar mods; newer ones load mods from mods/.
    applies: forgeUsesJarMod(settings.version)
  };
});

ipcMain.handle('open-jarmods-folder', () => {
  const settings = loadSettings();
  const directory = path.join(settings.gameFolder, 'jarmods');
  fs.mkdirSync(directory, { recursive: true });
  shell.openPath(directory);
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
