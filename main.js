const { app, BrowserWindow, ipcMain, Menu, shell, dialog, utilityProcess } = require('electron');
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

// Where the launcher keeps everything of its own. No drive letter is written
// down anywhere in the code: in development this is the project folder, in a
// built exe it is the folder the exe sits in. So the launcher can be moved to
// another disk, or the same card can come back under a different letter, and
// it still finds its settings, accounts and packs.
//
// Installing onto the system drive is the player's business and has to work,
// Program Files included. The one place the exe's own folder will not do is
// exactly there: a program folder is not the player's to write into, so the
// per-user folder answers for it instead.
//
// Program Files is ruled out by where it is rather than by trying to write
// into it, because trying gives different answers on different runs: the first
// launch after an install can still be elevated and would succeed, and every
// ordinary launch after it would fail and go looking somewhere else - the
// player would lose their accounts and packs to a launcher that was simply
// asked for administrator rights once.
const launcherDir = (() => {
  if (!app.isPackaged) return __dirname;
  const besideExe = path.dirname(app.getPath('exe'));
  const perUser = path.join(app.getPath('appData'), 'PeroLauncher');
  if (insideProgramFiles(besideExe)) return perUser;
  return canWriteInto(besideExe) ? besideExe : perUser;
})();

function insideProgramFiles(directory) {
  const bases = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432']
  ].filter(Boolean);

  return bases.some(base => {
    const relative = path.relative(base, directory);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function canWriteInto(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Every file of ours is named from that folder and from nowhere else.
function launcherFile(...parts) {
  return path.join(launcherDir, ...parts);
}

app.setPath('userData', launcherFile('userdata'));

const settingsPath = launcherFile('settings.json');

// Mojang's list of every official version. Cached on disk so the version
// picker still works without a connection.
const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const versionsCachePath = launcherFile('versions-cache.json');

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
  gameFolder: launcherFile('.minecraft'),
  language: 'ru',
  javaPath: null,
  javaArgs: '',
  // What the launcher does with itself once the game is up: stay on screen,
  // get out of the way until the game is over, or leave for good. Getting out
  // of the way is what a launcher is expected to do.
  onGameStart: 'hide',
  // The character on the white tile, drawn in three dimensions. It is the one
  // thing here that costs anything to have on screen - the graphics card is no
  // help on a machine where it has to be switched off - so it can be turned
  // off. On, because it is the nicest thing on the screen.
  playerModel: true,
  // How the pack list is laid out: one under another, or two across.
  packsView: 'list',
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

// The game folder is the one path a player may point wherever they like, so
// what they chose is what is kept. What is not kept is a dead drive letter: a
// folder inside the launcher's own directory is written down relative to it
// and comes back attached to wherever the launcher is now, and an absolute one
// whose drive is no longer in the machine gives way to the default instead of
// failing halfway through a launch.
function storeGameFolder(folder) {
  if (!folder) return folder;
  const relative = path.relative(launcherDir, folder);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return folder;
}

function resolveGameFolder(stored) {
  if (!stored) return defaultSettings.gameFolder;
  const full = path.resolve(launcherDir, stored);
  const root = path.parse(full).root;
  // Only a plain drive letter is worth checking - a network path is not ours
  // to judge, and it is better to try it than to refuse it.
  if (/^[A-Za-z]:/.test(root) && !fs.existsSync(root)) return defaultSettings.gameFolder;
  return full;
}

function loadSettings() {
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    saveSettingsToDisk(defaultSettings);
    return { ...defaultSettings };
  }
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const settings = {
    ...defaultSettings,
    ...parsed,
    versionFilters: { ...defaultSettings.versionFilters, ...(parsed.versionFilters || {}) }
  };

  // Both of the old answers become the one that works. Minimising left the
  // launcher sitting in the taskbar for no reason, and closing quit the
  // application outright, which killed the game a second and a half after it
  // started - measured, not guessed.
  if (settings.onGameStart === 'minimize' || settings.onGameStart === 'close') {
    settings.onGameStart = 'hide';
  }

  settings.gameFolder = resolveGameFolder(parsed.gameFolder);

  return settings;
}

function saveSettingsToDisk(settings) {
  const onDisk = { ...settings, gameFolder: storeGameFolder(settings.gameFolder) };
  fs.writeFileSync(settingsPath, JSON.stringify(onDisk, null, 2));
}

// Modpacks. A player who only wants to play never has to make one - the
// settings page is enough on its own. Making one binds a version and a loader
// to it there and then, and from that moment those answer for it: mods go
// into the pack rather than into the shared game folder, and picking it
// overrides what the settings page says.
//
// The list is the launcher's own bookkeeping and stays with the launcher. The
// packs themselves live in the game folder - see below.
const instancesPath = launcherFile('instances.json');

// Where the packs used to live, one full copy of the game inside each. Kept
// only so they can be moved out of there once.
const legacyPacksDir = launcherFile('instances');

// ---------------------------------------------------------------------------
// One game folder, and the launcher works out what belongs to whom.
//
// Everything a player accumulates is shared and stays shared: worlds, the
// options file, resource packs, shaders, screenshots - and the downloaded game
// as well, which is what actually costs something. Assets, libraries and
// versions used to be fetched again in full for every pack; four packs here
// held about three gigabytes between them, and perhaps a hundred megabytes of
// that was theirs.
//
// A pack owns two folders and no more. While it is the one being played they
// are laid out in the game folder itself - the only place the game will look
// for them - and the folders of whoever was there before are put away.
//
// Folders are moved rather than linked. A link would read better, but an
// ordinary recursive delete follows a Windows junction straight through and
// erases what is on the far side. That was measured here, not assumed, and on
// the far side would be every world the player has.
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
//
// That is why config is one of the two, and not shared like the rest.
const PACK_OWNED = ['mods', 'config'];

function packsDir(gameFolder) {
  return path.join(gameFolder, 'instances');
}

function ownerFilePath(gameFolder) {
  return path.join(packsDir(gameFolder), 'owner.txt');
}

// Whose mods and config are laid out in the game folder at this moment.
function currentOwner(gameFolder) {
  try {
    return fs.readFileSync(ownerFilePath(gameFolder), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

// Playing without a pack is an owner like any other, one per version and
// loader: the mods of 1.7.10 have no business being handed to 1.21.
function ownerKey(pack, settings) {
  if (pack) return pack.id;
  const plain = `no-pack-${settings.version}-${settings.loader || 'vanilla'}`;
  return plain.replace(/[^A-Za-z0-9._-]/g, '_');
}

// A pack's own files, wherever they happen to be right now: laid out in the
// game folder if this is the pack being played, waiting in its own folder if
// it is not. Both answers are correct - which one applies is not something the
// rest of the launcher should have to think about.
function packContentDir(instance, folderName) {
  const gameFolder = loadSettings().gameFolder;
  if (currentOwner(gameFolder) === instance.id) return path.join(gameFolder, folderName);
  return path.join(packsDir(gameFolder), instance.id, folderName);
}

// The launcher's note of what it installed into a pack. It is never handed to
// the game, so unlike the mods themselves it stays in one place.
function packRecordDir(instance) {
  return path.join(packsDir(loadSettings().gameFolder), instance.id);
}

// Where a thing of this kind belongs for this pack. Mods and configs are the
// pack's own. Resource packs and shaders are not: those are shared with every
// pack on purpose, so a texture the player likes is theirs everywhere rather
// than something to install again in each pack.
function contentDirFor(instance, spec) {
  if (PACK_OWNED.includes(spec.folder)) return packContentDir(instance, spec.folder);
  return path.join(loadSettings().gameFolder, spec.folder);
}

// A ready-made pack ships more than its own mods - resource packs, shaders,
// sometimes an options file. Each file goes where its kind belongs rather than
// all of it into the pack.
function packFileDestination(instance, relativePath) {
  const parts = String(relativePath).split(/[\\/]/).filter(Boolean);
  if (!parts.length) return null;

  if (PACK_OWNED.includes(parts[0])) {
    return safeInside(packContentDir(instance, parts[0]), parts.slice(1).join(path.sep));
  }
  return safeInside(loadSettings().gameFolder, parts.join(path.sep));
}

// Moves a folder onto another. A plain rename when the destination is free,
// which is the usual case and costs nothing even for thousands of files, and
// entry by entry when it is not.
//
// Nothing is ever overwritten. What happens to a file that is already there is
// the caller's decision, because it differs: two files named the same under
// assets are the same file by construction and one of them is waste, while two
// worlds named "New World" are two different worlds and losing one is losing
// somebody's evenings.
// Of two files under the same name, the shorter one is the one that was cut
// short. A size that cannot be read is treated as no file at all.
function biggerOf(one, other) {
  const size = file => { try { return fs.statSync(file).size; } catch { return -1; } };
  return size(one) > size(other) ? one : other;
}

function mergeFolder(from, to, onCollision = 'keep') {
  if (!fs.existsSync(from)) return;

  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
      return;
    } catch {
      // A different drive, or something appeared in between. Go the slow way.
      fs.mkdirSync(to, { recursive: true });
    }
  }

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    let target = path.join(to, entry.name);

    if (fs.existsSync(target)) {
      if (onCollision === 'drop' || onCollision === 'keep') {
        // Two folders of the same name are one folder with more in it: go in
        // and settle it file by file.
        if (entry.isDirectory()) {
          mergeFolder(source, target, onCollision);
          continue;
        }
        // A file already there is either the same file (drop the spare) or one
        // we were told not to touch (leave ours where it is, in plain sight).
        //
        // "The same file" was taken on trust, by name alone, and that was too
        // much trust: a download cut short keeps its name and loses its tail.
        // Two files under one name in versions or libraries are the same file
        // or one of them is damaged, and the damaged one is the shorter one.
        // Keep the longer, and never delete the only whole copy.
        if (onCollision === 'drop') {
          if (biggerOf(source, target) === source) fs.rmSync(target, { force: true });
          else { fs.rmSync(source, { force: true }); continue; }
        } else {
          continue;
        }
      }

      // Told to keep both. Whatever this is - a world, a resource pack - it is
      // one thing and goes in whole under another name. Merging a world into
      // another world by file would destroy them both.
      target = freeNameBeside(target, onCollision);
    }

    try {
      fs.renameSync(source, target);
    } catch {
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  }

  // Only if it actually emptied. Anything left is something the caller asked
  // to keep, and it stays where the player can still find it.
  try {
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
  } catch {}
}

// "New World" out of a pack called Skyblock becomes "New World (Skyblock)",
// and gets a number after that if even this is taken.
function freeNameBeside(target, note) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let n = 0; n < 100; n++) {
    const suffix = n === 0 ? ` (${note})` : ` (${note} ${n + 1})`;
    const candidate = path.join(dir, stem + suffix + ext);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${note} ${Date.now()})${ext}`);
}

// Moving in. Everything below used to live somewhere else, and this puts it
// where it belongs now. It runs at every start and does nothing at all once
// there is nothing left to move.
//
// A name that turns up twice is judged by what folder it is in. Under assets,
// libraries and versions a name is a hash or a version number, so the same
// name is the same file and the second copy is pure waste. A world or a
// resource pack is not: two of those sharing a name are two different things,
// and the incoming one is kept under the name of the pack it came from.
const SHARED_WHEN_MOVING = [
  ['assets', 'drop'], ['libraries', 'drop'], ['versions', 'drop'],
  ['natives', 'drop'], ['cache', 'drop'], ['logs', 'drop'], ['crash-reports', 'drop'],
  ['saves', 'rename'], ['resourcepacks', 'rename'], ['shaderpacks', 'rename'],
  ['screenshots', 'rename']
];

// Loose files that belong to the player rather than to a pack.
const PLAYER_FILES = [
  'options.txt', 'optionsof.txt', 'optionsshaders.txt',
  'servers.dat', 'servers.dat_old', 'usercache.json', 'usernamecache.json'
];

function migrateIntoGameFolder(gameFolder) {
  migrateLegacyPacks(gameFolder);
  migratePerVersionConfigs(gameFolder);
}

// The packs used to sit beside the launcher with a full copy of the game
// inside each one.
function migrateLegacyPacks(gameFolder) {
  if (!fs.existsSync(legacyPacksDir)) return;

  const packs = fs.readdirSync(legacyPacksDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory());

  for (const entry of packs) {
    const from = path.join(legacyPacksDir, entry.name);

    for (const [name, rule] of SHARED_WHEN_MOVING) {
      mergeFolder(path.join(from, name), path.join(gameFolder, name),
        rule === 'rename' ? entry.name : 'drop');
    }

    for (const name of PLAYER_FILES) {
      const loose = path.join(from, name);
      if (!fs.existsSync(loose)) continue;
      const target = path.join(gameFolder, name);
      if (fs.existsSync(target)) continue;
      try { fs.renameSync(loose, target); } catch {}
    }

    // Whatever is left is the pack's own - its mods, its config, and anything
    // it shipped that we have no name for.
    mergeFolder(from, path.join(packsDir(gameFolder), entry.name), 'keep');
    console.log('[MOVE] pack moved into the game folder:', entry.name);
  }

  // Only if it emptied. Something left behind is something worth looking at.
  try { fs.rmdirSync(legacyPacksDir); } catch {}
}

// Playing without a pack used to keep one config folder per version in a store
// of its own. That is the same idea as a pack owning its config, so those
// become owners like any other.
function migratePerVersionConfigs(gameFolder) {
  const store = path.join(gameFolder, 'config-per-version');
  if (!fs.existsSync(store)) return;

  const ownerFile = path.join(store, 'owner.txt');
  const owner = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, 'utf-8').trim() : null;

  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    mergeFolder(path.join(store, entry.name),
      path.join(packsDir(gameFolder), 'no-pack-' + entry.name, 'config'), 'keep');
  }

  // Whatever is laid out in the game folder right now was that owner's.
  if (owner && !currentOwner(gameFolder)) {
    fs.mkdirSync(packsDir(gameFolder), { recursive: true });
    fs.writeFileSync(ownerFilePath(gameFolder), 'no-pack-' + owner);
  }

  fs.rmSync(ownerFile, { force: true });
  try { fs.rmdirSync(store); } catch {}
}

// The packs live in the game folder, so when the player points the launcher at
// a different one, the packs go too. They meant the game to live elsewhere,
// not their packs to vanish.
function movePacksBetweenGameFolders(from, to) {
  const owner = currentOwner(from);
  if (owner) {
    // Otherwise this pack's mods would be left behind in a folder that is not
    // the game folder any more.
    for (const name of PACK_OWNED) {
      mergeFolder(path.join(from, name), path.join(packsDir(from), owner, name), 'keep');
    }
    fs.rmSync(ownerFilePath(from), { force: true });
  }
  mergeFolder(packsDir(from), packsDir(to), 'keep');
}

// Hands the game folder to one pack. What is lying there goes back to whoever
// owns it, and this pack's own files take its place.
function usePackData(gameFolder, key) {
  const store = packsDir(gameFolder);
  fs.mkdirSync(store, { recursive: true });
  const owner = currentOwner(gameFolder);

  if (owner !== key) {
    for (const name of PACK_OWNED) {
      const live = path.join(gameFolder, name);
      if (!fs.existsSync(live)) continue;
      // Without a recorded owner there is no telling whose these are, so they
      // are put aside under a name of their own rather than thrown out.
      mergeFolder(live, path.join(store, owner || 'unclaimed', name), 'keep');
    }

    // Recorded before the incoming files are laid out, not after. If the
    // launcher stops between the two, the next run reads its own name and
    // finishes the job; the other order would hand these files to whoever
    // came next.
    fs.writeFileSync(ownerFilePath(gameFolder), key);
  }

  for (const name of PACK_OWNED) {
    const mine = path.join(store, key, name);
    const live = path.join(gameFolder, name);
    if (fs.existsSync(mine)) mergeFolder(mine, live, 'keep');
    else fs.mkdirSync(live, { recursive: true });
  }
}
// ---------------------------------------------------------------------------

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

// Everything of a pack's in one place, for showing and for deleting. Not for
// reaching a particular folder of it - packContentDir answers that, and its
// answer is not always in here.
function instanceFolder(instance) {
  return path.join(packsDir(loadSettings().gameFolder), instance.id);
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
const accountsPath = launcherFile('accounts.json');

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
  const before = loadSettings().gameFolder;
  saveSettingsToDisk(settings);
  const after = loadSettings().gameFolder;

  if (path.resolve(before) !== path.resolve(after)) {
    try {
      movePacksBetweenGameFolders(before, after);
    } catch (e) {
      console.log('[MOVE] could not carry the packs across:', e.message);
    }
  }
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

// Skins are kept once they are fetched, so the main screen has a face to show
// the moment it opens and keeps one when the connection is down.
const skinsDir = launcherFile('skins');

// The two skins Minecraft hands out to anyone who has not set one. Which of
// them a player gets is decided by their id, and this is the same arithmetic
// the game does, so an offline player sees the character they will actually
// be playing as.
const DEFAULT_SKINS = {
  classic: 'http://textures.minecraft.net/texture/1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b',
  slim: 'http://textures.minecraft.net/texture/83cee5ca6afcdb171285aa00e8049c297b2dbeba0efb8ff970a5677a1b644032'
};

function defaultSkinFor(uuid) {
  const hex = uuid.replace(/-/g, '');
  // Java's UUID.hashCode(), folded down from the two halves.
  const most = BigInt('0x' + hex.slice(0, 16));
  const least = BigInt('0x' + hex.slice(16));
  const folded = (most ^ (most >> 32n) ^ least ^ (least >> 32n)) & 0xffffffffn;
  return (folded & 1n) === 1n ? 'slim' : 'classic';
}

// What the sessionserver has on file for this player. Answers 204 - no body at
// all - for anyone it has never heard of, which is every offline account.
async function skinFromMojang(uuid) {
  const response = await fetchWithRetry(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`);
  if (response.status === 204) return null;

  const data = await response.json();
  const property = (data.properties || []).find(entry => entry.name === 'textures');
  if (!property) return null;

  const textures = JSON.parse(Buffer.from(property.value, 'base64').toString('utf-8'));
  const skin = textures.textures?.SKIN;
  if (!skin?.url) return null;

  return {
    url: skin.url,
    model: skin.metadata?.model === 'slim' ? 'slim' : 'classic',
    // Worth having: a cape is something a player earned or was given, and
    // leaving it off would show them as someone slightly less than they are.
    cape: textures.textures?.CAPE?.url || null
  };
}

// Fetched once and kept, so the figure appears immediately next time and
// still appears when the connection is down.
async function cachedImage(url) {
  fs.mkdirSync(skinsDir, { recursive: true });
  const file = path.join(skinsDir, crypto.createHash('sha1').update(url).digest('hex') + '.png');

  if (!fs.existsSync(file)) fs.writeFileSync(file, await fetchBuffer(url));
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

async function playerSkin(account) {
  let source = null;

  if ((account.type || 'microsoft') === 'microsoft') {
    try {
      source = await skinFromMojang(account.uuid);
    } catch (e) {
      console.log('[SKIN] could not ask about', account.name + ':', e.message);
    }
  }

  // Nobody has a skin on file for an offline account, and there is nothing
  // wrong with that - the game gives them one of the two defaults.
  if (!source) {
    const model = defaultSkinFor(account.uuid);
    source = { url: DEFAULT_SKINS[model], model, isDefault: true };
  }

  return {
    model: source.model,
    isDefault: !!source.isDefault,
    image: await cachedImage(source.url),
    cape: source.cape ? await cachedImage(source.cape) : null
  };
}

// Who is playing, and what they look like. Null when nobody is signed in -
// the screen then invites them to be, rather than showing an empty frame.
ipcMain.handle('get-player', async () => {
  const store = loadAccounts();
  const account = store.accounts.find(entry => entry.id === store.activeId);
  if (!account) return null;

  const player = {
    name: account.name,
    uuid: account.uuid,
    offline: (account.type || 'microsoft') === 'offline'
  };

  try {
    return { ...player, ...await playerSkin(account) };
  } catch (e) {
    console.log('[SKIN] could not fetch a skin:', e.message);
    return { ...player, image: null, model: 'classic', isDefault: true };
  }
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

  fs.mkdirSync(packContentDir(instance, 'mods'), { recursive: true });
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

  // A pack being played has its mods and config laid out in the game folder
  // rather than in its own, so they are gathered back in first. Otherwise
  // deleting this pack would leave its mods behind for whoever plays next.
  const gameFolder = loadSettings().gameFolder;
  if (currentOwner(gameFolder) === instance.id) {
    for (const name of PACK_OWNED) {
      mergeFolder(path.join(gameFolder, name), path.join(packsDir(gameFolder), instance.id, name), 'keep');
    }
    fs.writeFileSync(ownerFilePath(gameFolder), '');
  }

  // Worlds are not in here - they are shared and stay where they are - but
  // hours of arranging mods may be, so it goes to the recycle bin rather than
  // being erased. A wrong click should be survivable.
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
  // Where its mods actually are at this moment, which for the pack being
  // played is the game folder itself. Opening an empty folder instead would be
  // technically true and useless.
  if (instance) {
    const folder = path.dirname(packContentDir(instance, 'mods'));
    fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
  }
});

ipcMain.handle('list-instance-mods', (event, id, kind) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  return instance ? listInstanceContent(instance, kind || 'mod') : [];
});

ipcMain.handle('remove-instance-mod', (event, id, filename, kind) => {
  const instance = loadInstances().instances.find(entry => entry.id === id);
  const spec = CONTENT_KINDS[kind || 'mod'];
  if (!instance || !spec || filename !== path.basename(filename)) return { ok: false };

  const file = path.join(contentDirFor(instance, spec), filename);
  if (fs.existsSync(file)) fs.rmSync(file, { recursive: true, force: true });
  return { ok: true };
});

ipcMain.handle('get-mod-categories', () => modrinthCategories());

ipcMain.handle('get-mod-game-versions', () => modrinthGameVersions());

ipcMain.handle('search-modpacks', async (event, query, offset, categories, gameVersion) => {
  try {
    return await searchModpacks(query, offset || 0, categories || [], gameVersion || null);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('list-modpack-builds', async (event, projectId) => {
  try {
    return { ok: true, builds: await modpackBuilds(projectId) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Installing a whole pack takes minutes, so the page is told how it is going.
ipcMain.handle('install-modpack', async (event, projectId, buildId = null) => {
  try {
    const report = progress => event.sender.send('modpack-progress', progress);
    return { ok: true, pack: await installModpack(projectId, buildId, report) };
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

// Looked at before anything is installed: a Modrinth pack says what it is, a
// hand-made zip has to be read, and the player sees what was found in it.
ipcMain.handle('inspect-local-modpack', async (event, filePath) => {
  try {
    return { ok: true, ...await inspectLocalModpack(filePath) };
  } catch (e) {
    // A zip that is cut short - most often one still being downloaded. The
    // library's own words mean nothing to a player.
    if (/END header|unsupported zip format/i.test(e.message)) {
      return { ok: false, reason: 'broken-archive', error: e.message };
    }
    return { ok: false, error: e.message };
  }
});

// With choices it is a hand-made zip, confirmed on screen; without, a .mrpack.
ipcMain.handle('install-local-modpack', async (event, filePath, choices = null) => {
  try {
    const report = progress => event.sender.send('modpack-progress', progress);
    const pack = choices
      ? await installLooseArchive(filePath, choices, report)
      : await installLocalModpack(filePath, report);
    return { ok: true, pack };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-featured-pack', async () => {
  try {
    return await featuredPackState();
  } catch (e) {
    console.log('[FEATURED] state:', e.message);
    return { shown: false };
  }
});

// Install, update and switching sets on or off are one and the same: bring
// the pack on disk in line with the published list and the player's choice.
ipcMain.handle('install-featured-pack', async (event, sets = null) => {
  try {
    const report = progress => event.sender.send('modpack-progress', progress);
    return { ok: true, pack: await installFeaturedPack(sets, report) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-pack-readme', (event, id) => {
  return openPackReadme(loadInstances().instances.find(entry => entry.id === id));
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

// Answering at once matters more than stopping at once. A download already in
// flight cannot be interrupted mid-file - and should not be, since the file it
// finishes is one less to fetch next time - but the player asked to stop, and
// nothing they asked for should have to wait on a download.
ipcMain.handle('cancel-launch', (event) => {
  if (!activeLaunch) return false;

  activeLaunch.cancelled = true;
  event.sender.send('launch-progress', { stage: 'cancelled' });
  console.log('[LAUNCH] called off' +
    (activeLaunch.pid ? ` - stopping process ${activeLaunch.pid}` : ' before the game started'));

  // The worker holds the game and knows how to take it down; it is told
  // rather than killed outright, so it can stop the whole tree Java leaves.
  if (activeLaunch.worker) {
    try {
      activeLaunch.worker.postMessage({ type: 'stop' });
    } catch (e) {
      console.log('[LAUNCH] could not reach the launch worker:', e.message);
    }
  }

  // A game already on its feet is taken down from here as well. The worker is
  // asked to do it, but it only reads its messages between pieces of work.
  if (activeLaunch.pid) {
    try {
      spawn('taskkill', ['/pid', String(activeLaunch.pid), '/T', '/F'], { windowsHide: true });
    } catch (e) {
      console.log('[LAUNCH] taskkill refused:', e.message);
    }
  }

  // And if it has not gone by itself, it is taken down. Between three thousand
  // downloads there is barely a gap for it to notice the message in: measured,
  // it carried on fetching for another ten to twenty seconds after being told
  // to stop. Nothing is lost by cutting it off - every file is checked by hash
  // before it is used, so a half-written one is simply fetched again.
  const abandoned = activeLaunch;
  setTimeout(() => {
    if (!abandoned.worker) return;

    try {
      abandoned.worker.kill();
      console.log('[LAUNCH] the worker had not stopped on its own - taken down');
    } catch (e) {
      console.log('[LAUNCH] could not take down the worker:', e.message);
    }

    abandoned.worker = null;
    if (activeLaunch === abandoned) activeLaunch = null;
  }, 1500);

  return true;
});

// ramOverride is set when the launcher is having a second go with a smaller
// heap, after Java refused to start with the first one.
// The launch in progress, so it can be called off. Preparing a game takes
// minutes, and a player who changes their mind should not have to wait it out
// or kill the launcher.
let activeLaunch = null;

async function startGame(profile, ramOverride) {
  const settings = loadSettings();
  const launch = { cancelled: false, worker: null, pid: null };
  activeLaunch = launch;

  const launcherWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

  // Everything between the click and the game window used to happen in
  // silence - minutes of it - so a step that failed looked exactly like a
  // click that never registered. It is said out loud now.
  const say = (stage, info = {}) => {
    // Once it has been called off, progress reports are noise: they would
    // keep a tile alive that the player has already dismissed.
    if (launch.cancelled && stage !== 'cancelled') return;

    if (launcherWindow && !launcherWindow.isDestroyed()) {
      launcherWindow.webContents.send('launch-progress', { stage, ...info });
    }
  };

  // A failure has to reach the player. It used to reach the console, which
  // nobody has open, and the launcher simply appeared to do nothing.
  const fail = (reason, detail) => {
    const t = loadTranslations(currentLocale);

    // A 404 is the server saying it has no such thing, and trying again will
    // not change its mind. Telling the player to retry would send them round
    // in circles - the same distinction the retries themselves observe.
    const missing = /HTTP 404/.test(detail);

    say('failed', {
      what: t[`launch.failed.${reason}`] || t['launch.failedTitle'],
      why: missing ? t['launch.notPublished'] : t['launch.mayBeConnection'],
      technical: detail,
      code: reason
    });
    return { started: false, error: `${reason}: ${detail}` };
  };

  // Checked between steps rather than inside them: a download already under
  // way is left to finish, and the file it saves is one less to fetch next
  // time. Stopping mid-file would only leave a broken one behind.
  const givenUp = () => {
    if (!launch.cancelled) return false;
    say('cancelled');
    return true;
  };

  say('preparing');

  // A chosen pack answers for its own version, loader and folder. Nothing
  // else changes: the same code launches both paths, so a pack cannot end up
  // on a route the plain one has not already proved.
  const pack = activeInstance();
  if (pack) {
    settings.version = pack.version;
    settings.loader = pack.loader;
    settings.loaderVersion = pack.loaderVersion;
    if (pack.ram) settings.ram = pack.ram;
  }

  const effectiveRam = ramOverride || (settings.ramAuto && !pack?.ram ? autoRamMB() : settings.ram);

  // Set where the launcher puts the game together itself rather than fetching
  // it - jar mods, which cannot be downloaded from anywhere.
  let builtJarLocally = false;

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
  say('java');
  try {
    opts.javaPath = await resolveJavaPath(settings.version, settings.javaPath);
  } catch (e) {
    return fail('java', e.message);
  }
  if (givenUp()) return { started: false, error: 'cancelled' };

  // The loader is fetched here rather than when it is picked, so browsing the
  // list costs nothing. Both kinds sit on top of the vanilla version.
  const loader = modLoaders[settings.loader];
  if (loader && settings.loaderVersion) {
    say('loader', { name: settings.loader, version: settings.loaderVersion });
    try {
      const kind = loader.kindFor(settings.version);

      if (kind === 'profile') {
        opts.version.custom = await installLoaderProfile(
          settings.loader, settings.version, settings.loaderVersion, settings.gameFolder
        );
      } else if (kind === 'jarmod') {
        builtJarLocally = true;
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
        say('failed', {
          what: t['jarmods.needsModLoaderTitle'],
          why: `${t['jarmods.needsModLoader']}\n\n${path.join(settings.gameFolder, 'jarmods')}`
        });
        return { started: false, error: 'needs-modloader' };
      }
      return fail('loader', e.message);
    }
  } else if (forgeUsesJarMod(settings.version) && listUserJarMods(settings.gameFolder).length > 0) {
    // No loader picked, but the player has put jar mods in place - on these
    // versions that is how mods were installed, loader or not.
    try {
      builtJarLocally = true;
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
      return fail('jarmods', e.message);
    }
  }

  // One game folder for everything, and whoever is being played gets their own
  // mods and config laid out in it. Worlds, settings and resource packs are
  // deliberately left alone - those belong to the player, not to the pack, and
  // they carry across.
  //
  // This one is not allowed to fail quietly. Carrying on would start the game
  // with somebody else's mods, and the player would be looking at a crash
  // report about a mod they never installed.
  const previousOwner = currentOwner(settings.gameFolder);
  try {
    usePackData(settings.gameFolder, ownerKey(pack, settings));
  } catch (e) {
    return fail('packdata', e.message);
  }

  // Resource packs a pack brought with it. Only when the game folder changes
  // hands, and a failure here is not worth refusing to start the game over.
  if (previousOwner !== ownerKey(pack, settings)) {
    try {
      applyPackResourcePacks(settings.gameFolder, pack, settings.version);
    } catch (e) {
      console.log('[RESOURCEPACKS] could not update options.txt:', e.message);
    }
  }

  // Whatever the player typed goes on last, so it wins over what the launcher
  // worked out - that is the point of being able to type it.
  const extraArgs = String(settings.javaArgs || '').trim();
  if (extraArgs) {
    opts.customArgs = [...(opts.customArgs || []), ...extraArgs.split(/\s+/)];
  }

  if (givenUp()) return { started: false, error: 'cancelled' };

  // Nothing has been fetched at this point and nothing has even been looked at
  // yet - the next thing that happens is the looking. Saying "downloading" here
  // was the same untruth as saying it during the checks, only a second earlier.
  // A jar the launcher built itself is left alone: it is not something the
  // library can fetch, and removing it would only get a plain one written over
  // the top of a game that was assembled on purpose.
  if (!builtJarLocally) {
    discardBrokenVersionJar(settings.gameFolder, opts.version.custom || settings.version);
  }

  say('files', { type: '', done: 0, total: 0, checking: true });

  // Handed to a process of its own. Doing it here meant the window stopped
  // answering while thousands of files were checked, and a player could press
  // cancel with nothing there to receive the press.
  const worker = utilityProcess.fork(path.join(__dirname, 'src', 'launch-worker.js'));
  launch.worker = worker;

  // The game's own output is the only place its reason for dying shows up,
  // so keep the tail of it around for the report below.
  const recentOutput = [];

  // Measured now, not when the game dies: by then the dying process has given
  // its memory back, and the figure would look like there was plenty.
  const freeAtLaunch = Math.floor(os.freemem() / 1024 / 1024);

  // Getting out of the way, but only once the game is actually on screen -
  // minimising while it is still downloading would leave the player looking
  // at an empty desktop with no sign that anything is happening.
  let steppedAside = false;

  // One message per file means nearly four thousand of them, which is more
  // than anyone can read and more than the page can draw.
  let lastSaid = 0;

  worker.on('message', message => {
    if (message.type === 'debug') return console.log('[DEBUG]', message.line);

    if (message.type === 'progress') {
      const e = message.progress;
      const finished = e.task >= e.total;
      if (!finished && Date.now() - lastSaid < 150) return;

      lastSaid = Date.now();
      return say('files', {
        type: e.type,
        done: e.task,
        total: e.total,
        checking: !message.downloading
      });
    }

    if (message.type === 'started') {
      launch.pid = message.pid;

      // It spawned anyway. Telling the worker to stop does not reach into the
      // middle of what the launcher library is doing, so a game could still
      // appear a moment after being called off - and did. This is the second
      // line: whatever started after the answer was given, gets stopped here.
      if (launch.cancelled && message.pid) {
        console.log(`[LAUNCH] a game appeared after being called off - stopping ${message.pid}`);
        try {
          spawn('taskkill', ['/pid', String(message.pid), '/T', '/F'], { windowsHide: true });
        } catch (e) {
          console.log('[LAUNCH] taskkill refused:', e.message);
        }
      }
      return;
    }

    if (message.type === 'error') {
      console.log('[LAUNCH] could not start:', message.error);
      return;
    }

    if (message.type === 'data') {
      console.log('[DATA]', message.line);
      recentOutput.push(message.line);
      if (recentOutput.length > 60) recentOutput.shift();

      // The first word out of the game means it is running.
      if (steppedAside || !launcherWindow || launcherWindow.isDestroyed()) return;
      if (launch.cancelled) return;

      steppedAside = true;
      say('running');

      // Off the screen and out of the taskbar - and for both of these, not
      // gone: quitting would kill the game. Everything the launcher starts is
      // its own family as far as Windows is concerned, and the family goes
      // down together; measured, a game died a second and a half after the
      // launcher did. So what is left behind draws nothing, costs nothing,
      // and is there to catch the game's last words. Where the two differ is
      // afterwards: one comes back, the other leaves for good.
      if (settings.onGameStart !== 'keep') launcherWindow.hide();
      return;
    }

    if (message.type !== 'close') return;

    const code = message.code;
    say(launch.cancelled ? 'cancelled' : 'ended');
    if (activeLaunch === launch) activeLaunch = null;
    worker.kill();

    // Back on screen. A crash is exactly when the launcher is wanted again,
    // so this happens before the report below.
    if (launcherWindow && !launcherWindow.isDestroyed() && settings.onGameStart !== 'keep') {
      launcherWindow.show();
      launcherWindow.focus();
    }

    // A game that was called off did not crash, and reporting it as one would
    // be blaming the player for their own decision.
    if (code === 0 || launch.cancelled) return;

    // The last words arrive after the process is already gone. Judging the
    // crash the instant it closes meant reading a report with its ending
    // missing - which is how a plain "exit code 1" was shown for a failure
    // that had said exactly what was wrong a moment later.
    setTimeout(
      () => reportGameCrash(code, recentOutput.join('\n'), effectiveRam, freeAtLaunch, profile),
      300
    );
  });

  worker.postMessage({ type: 'launch', opts });

  // The answer may already have been given while the worker was starting.
  if (launch.cancelled) worker.postMessage({ type: 'stop' });

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
const categoriesCachePath = launcherFile('modrinth-categories.json');
const gameVersionsCachePath = launcherFile('modrinth-versions.json');

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

// Every version of the game the catalogue knows, newest first - 907 of them,
// snapshots and all. Two things are taken from this list: what the filter
// offers, and what counts as newer than what.
//
// The order matters more than it looks. Version names cannot be sorted: "26.2"
// against "1.21.11" is not a comparison any rule of arithmetic settles, and
// the numbering has changed shape twice in the game's life. This list is the
// answer, straight from the catalogue, and it is kept rather than worked out.
async function modrinthVersionTags() {
  const fromCache = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(gameVersionsCachePath, 'utf-8'));
      // An older cache held bare names, all of them releases.
      return saved.map(entry => (typeof entry === 'string' ? { version: entry, type: 'release' } : entry));
    } catch {
      return [];
    }
  };

  try {
    const tags = await fetchJson(`${MODRINTH}/tag/game_version`, { headers: MOD_API_HEADERS });
    const slim = tags.map(tag => ({ version: tag.version, type: tag.version_type }));
    fs.writeFileSync(gameVersionsCachePath, JSON.stringify(slim));
    return slim;
  } catch {
    // Without them the filter is not shown; the catalogue itself still works.
    return fromCache();
  }
}

// Releases only for the filter: nobody goes looking for a pack for a snapshot,
// and there are eight hundred of those.
async function modrinthGameVersions() {
  return (await modrinthVersionTags()).filter(tag => tag.type === 'release').map(tag => tag.version);
}

// How new a version is, as a place in that list: 0 is the newest there is.
// Anything the list has never heard of goes to the end rather than to the top.
function versionRanking(tags) {
  const places = new Map();
  tags.forEach((tag, index) => places.set(tag.version, index));
  return version => (places.has(version) ? places.get(version) : Number.MAX_SAFE_INTEGER);
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

  const folder = contentDirFor(instance, spec);
  if (!fs.existsSync(folder)) return [];

  const recordPath = path.join(packRecordDir(instance), 'mods.json');
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
  const recordPath = path.join(packRecordDir(instance), 'mods.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
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

  const folder = contentDirFor(instance, spec);
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
async function searchModpacks(query, offset = 0, categories = [], gameVersion = null) {
  const facets = [['project_type:modpack']];
  for (const category of categories) facets.push([`categories:${category}`]);

  // A pack is made for a particular version of the game, and that is the first
  // thing anyone narrows by: a wonderful pack for 1.21 is no use to somebody
  // whose world is on 1.20.
  if (gameVersion) facets.push([`versions:${gameVersion}`]);

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
// Every published build of a pack, so the player can take the one they want.
// Packs are made for a particular version of the game, and the newest build is
// often for a version somebody is not ready to move to - a world, a server or
// a friend can all be a reason to stay where they are.
async function modpackBuilds(projectId) {
  const builds = await fetchJson(
    `${MODRINTH}/project/${encodeURIComponent(projectId)}/version`, { headers: MOD_API_HEADERS });
  if (!Array.isArray(builds)) return [];

  // One line per version of the game, not per build. A pack that has been
  // going for years has hundreds of builds - Fabulously Optimized has 463 -
  // and a list of those is not a choice anyone can make. What is being chosen
  // here is the version of Minecraft; for each one, the newest build that was
  // made for it, which is the one that pack's author would hand over.
  const usable = builds.filter(build => (build.files || []).length);
  const newestFor = new Map();

  for (const build of usable) {
    for (const gameVersion of build.game_versions || []) {
      const kept = newestFor.get(gameVersion);
      if (kept && String(kept.published) >= String(build.date_published)) continue;

      newestFor.set(gameVersion, {
        id: build.id,
        gameVersion,
        number: build.version_number,
        loaders: build.loaders || [],
        published: build.date_published
      });
    }
  }

  // The one build that came out last, whatever it was made for. Worth saying
  // out loud, because it is not always the one for the newest game version.
  const latest = usable.reduce(
    (newest, build) => (!newest || build.date_published > newest.date_published ? build : newest), null);

  // In order of the game's own versions, newest first. Sorting these by the
  // date their builds came out is what made the list nonsense before: a pack
  // patched for 1.21.1 last week landed above one built for 26.1 last month.
  const rankOf = versionRanking(await modrinthVersionTags());

  return [...newestFor.values()]
    .map(entry => ({ ...entry, newest: latest ? entry.id === latest.id : false }))
    .sort((a, b) => rankOf(a.gameVersion) - rankOf(b.gameVersion)
      || String(a.gameVersion).localeCompare(String(b.gameVersion)));
}

async function installModpack(projectId, buildId = null, report = () => {}) {
  const builds = await fetchJson(
    `${MODRINTH}/project/${encodeURIComponent(projectId)}/version`, { headers: MOD_API_HEADERS });
  if (!Array.isArray(builds) || !builds.length) throw new Error('this pack has no published build');

  // Whichever one was chosen; the newest when nothing was.
  const build = (buildId && builds.find(entry => entry.id === buildId)) || builds[0];
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
    const destination = packFileDestination(instance, file.path);
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

    const destination = packFileDestination(instance, match[1]);
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

// ------------------------------------------------------- the author's pack

// The pack this launcher was made for. It is published as a list of files
// with their hashes (scripts/make-pack-manifest.js writes it), so a player who
// already has it fetches only what changed - one new mod is one download, not
// the whole pack again.
//
// Where the list lives. A settings entry of the same name points elsewhere,
// which is how the author tries a release on their own machine before
// publishing it - a path on disk works as well as an address.
const FEATURED_PACK_SOURCE = 'https://raw.githubusercontent.com/Kompatui/PeroLauncher/pack/kempas-mods/manifest.json';

// The last list seen, so the pack still shows - and still plays - with no
// connection.
const featuredCachePath = launcherFile('featured-pack.json');

function featuredSource() {
  return loadSettings().featuredPackSource || FEATURED_PACK_SOURCE;
}

const isAddress = source => /^https?:\/\//i.test(source);

// A file named relative to the manifest: our own files sit beside it.
function besideManifest(source, relative) {
  return isAddress(source) ? new URL(relative, source).href : path.join(path.dirname(source), relative);
}

async function readFromSource(location, asJson) {
  if (isAddress(location)) {
    return asJson ? fetchJson(location, { headers: MOD_API_HEADERS }) : fetchBuffer(location, { headers: MOD_API_HEADERS });
  }
  const data = fs.readFileSync(location);
  return asJson ? JSON.parse(data.toString('utf-8')) : data;
}

// The published list, fresh if it can be had and the remembered one if not.
async function featuredManifest() {
  const source = featuredSource();
  if (!source) return null;
  try {
    const manifest = await readFromSource(source, true);
    if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('not a pack list');
    fs.writeFileSync(featuredCachePath, JSON.stringify({ source, manifest }));
    return { manifest, fresh: true };
  } catch (e) {
    console.log('[FEATURED] could not read the pack list:', e.message);
    try {
      const cached = JSON.parse(fs.readFileSync(featuredCachePath, 'utf-8'));
      if (cached.source === source) return { manifest: cached.manifest, fresh: false };
    } catch {}
    return null;
  }
}

function featuredInstance(store, manifest) {
  return store.instances.find(entry => entry.featured && (!manifest || entry.id === manifest.id)) || null;
}

function fileSha1(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// Installs the pack, or brings an installed one up to the published list.
// "sets" are the optional parts the player chose; a set left out is not
// installed, and one switched off is taken out again.
//
// What is the player's stays the player's. A mod they added themselves is not
// on our list and is never touched. A config they changed is kept, unless the
// author changed that same file in this release - then the author's wins,
// because the new mods may need it.
async function installFeaturedPack(chosenSets, report = () => {}) {
  const found = await featuredManifest();
  if (!found) throw new Error('the pack list cannot be reached');
  const { manifest } = found;
  const source = featuredSource();

  const store = loadInstances();
  let instance = featuredInstance(store, manifest);
  const isNew = !instance;
  if (isNew) {
    instance = {
      id: manifest.id,
      name: manifest.name,
      ram: manifest.ram || null,
      featured: { version: null, sets: [], files: {} },
      createdAt: new Date().toISOString()
    };
    // A pack the player made under the same name keeps its name; ours steps aside.
    if (store.instances.some(entry => entry.id === instance.id)) {
      instance.id = instanceId(manifest.id, store.instances.map(entry => entry.id));
    }
  }

  const knownSets = new Set((manifest.sets || []).map(set => set.id));
  const sets = (Array.isArray(chosenSets) ? chosenSets : instance.featured.sets || [])
    .filter(set => knownSets.has(set));
  const wanted = manifest.files.filter(file => !file.set || sets.includes(file.set));
  const before = instance.featured.files || {};

  // What has to be fetched: anything missing or different on disk. A file the
  // player changed and the author did not is left as the player has it.
  const toFetch = [];
  for (const file of wanted) {
    const destination = packFileDestination(instance, file.path);
    if (!destination) continue;
    const onDisk = fileSha1(destination);
    if (onDisk === file.sha1) continue;
    if (onDisk && before[file.path] === file.sha1) continue;
    toFetch.push({ ...file, destination });
  }

  let done = 0;
  report({ stage: 'files', done, total: toFetch.length });

  // A few at a time: a pack is a hundred small files, and one after another
  // most of the wait is the round trip, not the download.
  const queue = [...toFetch];
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      const from = file.url || besideManifest(source, `files/${file.sha1}`);
      const data = await readFromSource(from, false);
      if (crypto.createHash('sha1').update(data).digest('hex') !== file.sha1) {
        throw new Error(`${path.basename(file.path)}: the download does not match its hash`);
      }
      fs.mkdirSync(path.dirname(file.destination), { recursive: true });
      fs.writeFileSync(file.destination, data);
      done++;
      report({ stage: 'files', done, total: toFetch.length, name: path.basename(file.path) });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // What we put in before and is no longer on the list - a mod the author
  // dropped, or a set the player switched off. Only if it is still the file we
  // put there; one the player has since changed is theirs now.
  const wantedPaths = new Set(wanted.map(file => file.path));
  for (const [relative, sha1] of Object.entries(before)) {
    if (wantedPaths.has(relative)) continue;
    const destination = packFileDestination(instance, relative);
    if (destination && fileSha1(destination) === sha1) fs.rmSync(destination, { force: true });
  }

  instance.name = manifest.name;
  instance.version = manifest.minecraft;
  instance.loader = manifest.loader || 'vanilla';
  instance.loaderVersion = manifest.loaderVersion || null;
  instance.featured = {
    version: manifest.version,
    sets,
    files: Object.fromEntries(wanted.map(file => [file.path, file.sha1]))
  };

  // Read again: the download took a while, and the list may have changed under it.
  const latest = loadInstances();
  latest.instances = latest.instances.filter(entry => entry.id !== instance.id);
  latest.instances.push(instance);
  if (isNew) latest.activeId = instance.id;
  saveInstances(latest);

  report({ stage: 'done', done: toFetch.length, total: toFetch.length });
  return { id: instance.id, name: instance.name, fetched: toFetch.length };
}

// The version number is the author's to forget to raise; the files are what
// actually decide whether there is anything to fetch.
function featuredDiffers(installed, manifest) {
  if (installed.featured?.version !== manifest.version) return true;
  const sets = installed.featured?.sets || [];
  const had = installed.featured?.files || {};
  const wanted = manifest.files.filter(file => !file.set || sets.includes(file.set));
  return wanted.length !== Object.keys(had).length || wanted.some(file => had[file.path] !== file.sha1);
}

// What the packs page needs to draw the pack's row: what is published, what
// is installed, and whether the two differ.
async function featuredPackState() {
  const settings = loadSettings();
  if (settings.showFeaturedPack === false || !featuredSource()) return { shown: false };

  const found = await featuredManifest();
  const installed = featuredInstance(loadInstances(), found?.manifest);
  if (!found) return { shown: !!installed, installedId: installed?.id || null };

  const { manifest } = found;
  return {
    shown: true,
    fresh: found.fresh,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    minecraft: manifest.minecraft,
    loader: manifest.loader,
    loaderVersion: manifest.loaderVersion,
    changelog: manifest.changelog || null,
    sets: (manifest.sets || []).map(set => ({
      ...set,
      // "(Not for PPL) InvMove-0.9.3+1.21.11-Fabric.jar" reads as "InvMove":
      // the note is the set's own title already, the numbers say nothing here.
      files: manifest.files.filter(file => file.set === set.id).map(file => path.basename(file.path)
        .replace(/^\([^)]*\)\s*/, '').replace(/\.jar$/i, '').replace(/[-_ ]v?\d.*$/i, ''))
    })),
    modCount: manifest.files.filter(file => !file.set && file.path.startsWith('mods/')).length,
    installedId: installed?.id || null,
    installedVersion: installed?.featured?.version || null,
    installedSets: installed?.featured?.sets || [],
    updateAvailable: !!installed && featuredDiffers(installed, manifest)
  };
}

// ------------------------------------------------- packs with no description

// Plenty of packs never went near Modrinth: a zip somebody put together by
// hand, mods in one folder, a resource pack in another, and a text file telling
// a person where to copy what. There is no list to read, so the archive is read
// the way that person would read it - by what each thing in it is.
//
// Nothing here knows about any particular pack, and nothing should. What it
// knows is what the game itself recognises: a resource pack has pack.mcmeta
// and assets, a world has level.dat, a mod describes itself inside its jar.
// Whatever is left over is named on the confirmation screen rather than
// dropped in silence, and the author's own instructions are opened for the
// player - every pack has its quirks, the author has already written them
// down, and no amount of code here would keep up with them.

// Which versions of the game read each resource pack format. Only formats
// whose range is settled; a newer one simply does not narrow the choice.
const RESOURCE_PACK_FORMATS = {
  1: ['1.6.1', '1.8.9'], 2: ['1.9', '1.10.2'], 3: ['1.11', '1.12.2'], 4: ['1.13', '1.14.4'],
  5: ['1.15', '1.16.1'], 6: ['1.16.2', '1.16.5'], 7: ['1.17', '1.17.1'], 8: ['1.18', '1.18.2'],
  9: ['1.19', '1.19.2'], 12: ['1.19.3', '1.19.3'], 13: ['1.19.4', '1.19.4'], 15: ['1.20', '1.20.1'],
  18: ['1.20.2', '1.20.2'], 22: ['1.20.3', '1.20.4'], 32: ['1.20.5', '1.20.6'], 34: ['1.21', '1.21.1'],
  42: ['1.21.2', '1.21.3'], 46: ['1.21.4', '1.21.4'], 55: ['1.21.5', '1.21.5'], 63: ['1.21.6', '1.21.6'],
  64: ['1.21.7', '1.21.8']
};

const DOC_FILE = /\.(txt|md|pdf|html?|rtf)$/i;
const README_NAME = /read.?me|instruc|install|guide|how.?to|инструк|установ|прочт|прочит/i;
const OPTIONAL_FOLDER = /optional|необязат|опционал|по желанию/i;
// Folder names that say "a resource pack" and nothing about which one. Put into
// the shared folder as they are, two packs would fight over "Resourcepack".
const GENERIC_PACK_NAME = /^(resource ?packs?|resources|textures?|texture ?packs?|rp|pack)$/i;

const NUMERIC_VERSION = /^\d+(\.\d+)*$/;

// One requirement as Fabric and Quilt write it: "1.21.1", "~1.21", "1.21.x",
// ">=1.21 <1.21.2", or a list of which any one will do. A requirement this
// cannot read counts as no requirement: offering a version is better than
// refusing all of them over a typo in someone's mod.
function fabricAllows(version, requirement) {
  if (Array.isArray(requirement)) {
    return requirement.length === 0 || requirement.some(one => fabricAllows(version, one));
  }
  if (requirement && typeof requirement === 'object') return true;
  const text = String(requirement ?? '').trim();
  if (!text || text === '*') return true;

  return text.split(/\s+/).every(predicate => {
    const match = predicate.match(/^(>=|<=|>|<|=|~|\^)?v?(.+)$/);
    if (!match) return true;
    const op = match[1] || '=';
    // "1.21.1-" means "and its pre-releases", "+build" is not part of the number.
    const value = match[2].replace(/[-+].*$/, '');
    const parts = value.split('.');
    const wildAt = parts.findIndex(part => /^[xX*]$/.test(part));
    const fixed = wildAt === -1 ? parts : parts.slice(0, wildAt);
    if (!fixed.length) return true;
    if (!fixed.every(part => /^\d+$/.test(part))) return true;

    const base = fixed.join('.');
    const cmp = compareVersionNumbers(version, base);
    if (wildAt !== -1) {
      const mine = version.split('.');
      return fixed.every((part, i) => Number(mine[i] ?? 0) === Number(part));
    }
    switch (op) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '~': {
        const next = fixed.length >= 2 ? `${fixed[0]}.${Number(fixed[1]) + 1}` : `${Number(fixed[0]) + 1}`;
        return cmp >= 0 && compareVersionNumbers(version, next) < 0;
      }
      case '^': return cmp >= 0 && compareVersionNumbers(version, `${Number(fixed[0]) + 1}`) < 0;
      default: return cmp === 0;
    }
  });
}

// The same question as Forge and NeoForge ask it, in Maven's notation:
// "[1.21.1,1.22)", "[1.20.1]", "[1.20,)".
function mavenAllows(version, range) {
  const text = String(range ?? '').trim();
  if (!text || text === '*') return true;
  const spans = [...text.matchAll(/([\[(])\s*([^,\])]*?)\s*(?:,\s*([^\])]*?)\s*)?([\])])/g)];
  if (!spans.length) return NUMERIC_VERSION.test(text) ? compareVersionNumbers(version, text) === 0 : true;

  return spans.some(([, open, low, high, close]) => {
    if (high === undefined) return NUMERIC_VERSION.test(low) ? compareVersionNumbers(version, low) === 0 : true;
    const aboveLow = !NUMERIC_VERSION.test(low) ||
      (open === '[' ? compareVersionNumbers(version, low) >= 0 : compareVersionNumbers(version, low) > 0);
    const belowHigh = !NUMERIC_VERSION.test(high) ||
      (close === ']' ? compareVersionNumbers(version, high) <= 0 : compareVersionNumbers(version, high) < 0);
    return aboveLow && belowHigh;
  });
}

// Some mods put raw line breaks inside their JSON strings, which the format
// does not allow and every loader quietly forgives. So do we.
function lenientJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' ')); } catch {}
  return null;
}

// What a jar says about itself: which loader it is for, what it is called and
// which versions of the game it will run on. Null when it says nothing - then
// it is not a mod we can vouch for.
function describeModJar(data) {
  let jar;
  try { jar = new AdmZip(data); } catch { return null; }
  const read = name => {
    const entry = jar.getEntry(name);
    return entry ? entry.getData().toString('utf-8') : null;
  };

  // A jar that carries both descriptions runs on Fabric too, and its Quilt one
  // is often left over from an older build ("1.18.2" in a mod for 1.21.11).
  // Only a Quilt-only mod makes it Quilt.
  const quilt = jar.getEntry('fabric.mod.json') ? null : lenientJson(read('quilt.mod.json'));
  if (quilt) {
    const block = quilt.quilt_loader || {};
    const game = (block.depends || []).find(dep => (dep?.id || dep) === 'minecraft');
    return {
      loader: 'quilt',
      title: block.metadata?.name || block.id || null,
      allows: version => !game || typeof game === 'string' || fabricAllows(version, game.versions)
    };
  }

  const fabric = lenientJson(read('fabric.mod.json'));
  if (fabric) {
    return {
      loader: 'fabric',
      title: fabric.name || fabric.id || null,
      allows: version => fabricAllows(version, fabric.depends?.minecraft)
    };
  }

  const neoToml = read('META-INF/neoforge.mods.toml');
  const toml = neoToml || read('META-INF/mods.toml');
  if (toml) {
    // The game's own entry among the dependencies, wherever in the file it is.
    const block = toml.split(/\[\[\s*dependencies/).find(part => /modId\s*=\s*["']minecraft["']/.test(part));
    const range = block?.match(/versionRange\s*=\s*["']([^"']*)["']/)?.[1];
    return {
      loader: neoToml || /modId\s*=\s*["']neoforge["']/.test(toml) ? 'neoforge' : 'forge',
      title: toml.match(/displayName\s*=\s*["']([^"']+)["']/)?.[1] || null,
      allows: version => mavenAllows(version, range)
    };
  }

  const info = lenientJson(read('mcmod.info'));
  if (info) {
    const first = Array.isArray(info) ? info[0] : info.modList?.[0];
    const wanted = String(first?.mcversion || '');
    return {
      loader: 'forge',
      title: first?.name || null,
      allows: version => !NUMERIC_VERSION.test(wanted) || compareVersionNumbers(version, wanted) === 0
    };
  }

  return null;
}

// Every release of the game, newest first. From the cached list of Mojang's
// versions, fetched once if there is no cache yet.
async function releaseIds() {
  let manifest = readVersionCache();
  if (!manifest) {
    try { manifest = await fetchVersionManifest(); } catch { manifest = null; }
  }
  return (manifest?.versions || [])
    .filter(version => correctedType(version) === 'release' && NUMERIC_VERSION.test(version.id))
    .map(version => version.id);
}

// A name Windows will take for a folder.
function folderSafeName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 80);
}

// Minecraft's formatting codes ("§6Portal") are colours on screen and noise
// anywhere else.
function plainPackDescription(description) {
  if (Array.isArray(description)) return description.map(plainPackDescription).join('');
  if (description && typeof description === 'object') {
    return plainPackDescription(description.text || '') + plainPackDescription(description.extra || []);
  }
  return String(description || '').replace(/§./g, '').trim();
}

// Reads the archive and works out a plan: what goes where, which version and
// loader it wants. Nothing is written - this is what the confirmation screen
// is drawn from.
async function planLooseArchive(zip, fileName) {
  const files = zip.getEntries().filter(entry => !entry.isDirectory);
  const pathOf = entry => entry.entryName.replace(/\\/g, '/');
  const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const inside = (p, dir) => dir === '' || p.startsWith(dir + '/');
  const lastName = p => p.split('/').pop();

  const name = path.basename(fileName).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim() || 'Pack';

  // Folders that hold a particular child somewhere directly under them.
  const dirsWithChild = child => {
    const found = new Set();
    for (const entry of files) {
      const parts = pathOf(entry).split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === child) found.add(parts.slice(0, i).join('/'));
      }
    }
    return found;
  };
  const withAssets = dirsWithChild('assets');
  const withShaders = dirsWithChild('shaders');

  // Things that are one thing each and go in whole: worlds first, because a
  // world carries datapacks and resource packs of its own inside it.
  const claimed = [];
  const isClaimed = p => claimed.some(dir => inside(p, dir));
  const worlds = [];
  const resourcePacks = [];
  const shaders = [];

  for (const entry of files) {
    const p = pathOf(entry);
    if (lastName(p) !== 'level.dat') continue;
    const dir = dirOf(p);
    if (isClaimed(p)) continue;
    claimed.push(dir);
    worlds.push({ dir, title: lastName(dir) || name });
  }

  for (const entry of files) {
    const p = pathOf(entry);
    if (lastName(p) !== 'pack.mcmeta' || isClaimed(p)) continue;
    const dir = dirOf(p);
    // pack.mcmeta without assets is a datapack, which lives inside a world and
    // has nowhere to go on its own. It is left among the unrecognised.
    if (!withAssets.has(dir)) continue;
    const meta = lenientJson(entry.getData().toString('utf-8'))?.pack || {};
    claimed.push(dir);
    resourcePacks.push({
      dir,
      format: Number(meta.pack_format) || null,
      title: plainPackDescription(meta.description) || lastName(dir) || name,
      folderName: lastName(dir) && !GENERIC_PACK_NAME.test(lastName(dir)) ? lastName(dir) : name
    });
  }

  for (const dir of withShaders) {
    const p = dir + '/shaders/';
    // A resource pack keeps its own shaders under assets; those are not a
    // shader pack.
    if (isClaimed(p) || dir === '' || /(^|\/)assets(\/|$)/.test(dir)) continue;
    claimed.push(dir);
    shaders.push({ dir, title: lastName(dir) });
  }

  // Archives inside the archive: a resource pack, a world or a shader pack
  // shipped zipped, the way the game itself also accepts them.
  for (const entry of files) {
    const p = pathOf(entry);
    if (!/\.zip$/i.test(p) || isClaimed(p)) continue;
    let inner;
    try { inner = new AdmZip(entry.getData()); } catch { continue; }
    const innerNames = inner.getEntries().map(item => item.entryName.replace(/\\/g, '/'));
    const atTop = file => innerNames.find(item => item === file || /^[^/]+\/[^/]+$/.test(item) && lastName(item) === file);
    const title = lastName(p).replace(/\.zip$/i, '');

    if (atTop('level.dat')) {
      const levelDat = atTop('level.dat');
      worlds.push({ zip: p, inner: dirOf(levelDat), title: dirOf(levelDat) || title });
      claimed.push(p);
    } else if (atTop('pack.mcmeta') && innerNames.some(item => /(^|\/)assets\//.test(item))) {
      const meta = lenientJson(inner.getEntry(atTop('pack.mcmeta')).getData().toString('utf-8'))?.pack || {};
      resourcePacks.push({
        zip: p,
        format: Number(meta.pack_format) || null,
        title: plainPackDescription(meta.description) || title,
        folderName: title
      });
      claimed.push(p);
    } else if (innerNames.some(item => /^([^/]+\/)?shaders\//.test(item))) {
      shaders.push({ zip: p, title });
      claimed.push(p);
    }
  }

  // A config folder belongs to the pack's mods, as it would in a game folder.
  const configDirs = [];
  for (const entry of files) {
    const p = pathOf(entry);
    if (isClaimed(p)) continue;
    const parts = p.split('/');
    const at = parts.findIndex(part => part.toLowerCase() === 'config');
    if (at === -1 || at === parts.length - 1) continue;
    const dir = parts.slice(0, at + 1).join('/');
    if (!configDirs.includes(dir)) configDirs.push(dir);
  }
  const inConfig = p => configDirs.some(dir => inside(p, dir));

  // Mods, grouped by the folder they came in. The folder is how an author says
  // "these are optional" or "this set is for Forge, that one for Fabric".
  const groups = new Map();
  const unknown = new Set();
  for (const entry of files) {
    const p = pathOf(entry);
    if (!/\.jar$/i.test(p) || isClaimed(p) || inConfig(p)) continue;
    const about = describeModJar(entry.getData());
    const dir = dirOf(p);
    // A jar that says nothing about itself is still a mod if it sits in a
    // folder called mods - old Forge mods often said nothing.
    if (!about && lastName(dir).toLowerCase() !== 'mods') {
      unknown.add(p);
      continue;
    }
    if (!groups.has(dir)) {
      groups.set(dir, {
        id: `g${groups.size}`,
        dir,
        title: lastName(dir) || name,
        optional: OPTIONAL_FOLDER.test(dir),
        mods: []
      });
    }
    groups.get(dir).mods.push({
      path: p,
      filename: lastName(p),
      title: about?.title || lastName(p).replace(/\.jar$/i, ''),
      loader: about?.loader || null,
      allows: about?.allows || (() => true)
    });
  }

  // The author's own words: any document that is not part of something else.
  const docs = files.map(pathOf).filter(p => DOC_FILE.test(p) && !isClaimed(p) && !inConfig(p));
  const depth = p => p.split('/').length;
  const readme = docs.filter(p => README_NAME.test(lastName(p))).sort((a, b) => depth(a) - depth(b))[0] ||
    (docs.length === 1 ? docs[0] : docs.find(p => /\.(txt|md)$/i.test(p))) || null;

  for (const entry of files) {
    const p = pathOf(entry);
    if (isClaimed(p) || inConfig(p) || docs.includes(p) || /\.jar$/i.test(p)) continue;
    unknown.add(p);
  }

  // Which version it is for. The mods have the strongest say - each one
  // states what it runs on - then the resource pack's format, then the
  // author's instructions, which usually name the version in so many words.
  const releases = await releaseIds();
  const docText = docs.filter(p => /\.(txt|md|html?)$/i.test(p))
    .map(p => zip.getEntry(p) || files.find(entry => pathOf(entry) === p))
    .filter(Boolean)
    .map(entry => entry.getData().toString('utf-8').slice(0, 200000))
    .join('\n');
  // Not \b: authors write "v0.17.2", and there is no word boundary between
  // the v and the number.
  const mentioned = new Set(docText.match(/(?<![\d.])\d+\.\d+(?:\.\d+)*/g) || []);

  const allMods = [...groups.values()].flatMap(group => group.mods);
  let candidates = releases;
  if (allMods.length) {
    const score = version => allMods.filter(mod => mod.allows(version)).length;
    const best = Math.max(0, ...releases.map(score));
    if (best > 0) candidates = releases.filter(version => score(version) === best);
  }
  const formats = resourcePacks.map(pack => RESOURCE_PACK_FORMATS[pack.format]).filter(Boolean);
  if (formats.length) {
    const narrowed = candidates.filter(version => formats.every(([low, high]) => versionWithin(version, low, high)));
    if (narrowed.length) candidates = narrowed;
  }
  const narrowedByMods = allMods.length > 0 || formats.length > 0;
  const named = candidates.filter(version => mentioned.has(version));
  const version = named[0] || (narrowedByMods && candidates.length < releases.length ? candidates[0] : null) || null;

  return {
    name,
    version,
    releases,
    groups: [...groups.values()],
    resourcePacks,
    worlds,
    shaders,
    configDirs,
    docs,
    readme,
    mentioned: [...mentioned],
    unknown: [...unknown]
  };
}

function versionWithin(version, low, high) {
  return compareVersionNumbers(version, low) >= 0 && compareVersionNumbers(version, high) <= 0;
}

// The loader a set of mods needs. Quilt runs Fabric's mods, so the two
// together are a Quilt pack, not a contradiction.
function loaderForMods(mods) {
  const loaders = new Set(mods.map(mod => mod.loader).filter(Boolean));
  if (loaders.has('quilt')) loaders.delete('fabric');
  return [...loaders];
}

// What the page is shown. Paths and functions stay here.
function describePlanForPage(plan) {
  const top = list => list.slice(0, 12);
  // The first folder of each unrecognised file is enough to say what it was.
  const unknownNames = [...new Set(plan.unknown.map(p => p.split('/').slice(0, 2).join('/')))];
  return {
    kind: 'loose',
    name: plan.name,
    version: plan.version,
    releases: plan.releases,
    groups: plan.groups.map(group => ({
      id: group.id,
      title: group.title,
      optional: group.optional,
      count: group.mods.length,
      loaders: loaderForMods(group.mods)
    })),
    resourcePacks: plan.resourcePacks.map(pack => pack.title),
    worlds: plan.worlds.map(world => world.title),
    shaders: plan.shaders.map(shader => shader.title),
    hasConfig: plan.configDirs.length > 0,
    readme: plan.readme ? plan.readme.split('/').pop() : null,
    unknown: top(unknownNames),
    unknownMore: Math.max(0, unknownNames.length - 12)
  };
}

// The archive is read once to be shown and once more to be installed. Large
// packs run to hundreds of megabytes, so the one read is kept in between.
let looseImport = null;

async function inspectLocalModpack(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('there is no such file');
  const zip = new AdmZip(filePath);
  if (zip.getEntry('modrinth.index.json')) return { kind: 'mrpack' };

  const plan = await planLooseArchive(zip, filePath);
  const nothing = !plan.groups.length && !plan.resourcePacks.length && !plan.worlds.length && !plan.shaders.length;
  if (nothing) throw new Error('nothing in this archive is a mod, a resource pack, a shader or a world');

  looseImport = { filePath, mtimeMs: fs.statSync(filePath).mtimeMs, zip, plan };
  return describePlanForPage(plan);
}

// Writes one file out of the archive, refusing any path that climbs out of
// where it is meant to land.
function extractTo(folder, relative, data) {
  const target = safeInside(folder, relative);
  if (!target) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return true;
}

// Everything in a folder of the archive, laid out under a folder on disk.
function extractFolder(entries, dir, target, written) {
  const pathOf = entry => entry.entryName.replace(/\\/g, '/');
  for (const entry of entries) {
    const p = pathOf(entry);
    if (dir !== '' && !p.startsWith(dir + '/')) continue;
    extractTo(target, dir === '' ? p : p.slice(dir.length + 1), entry.getData());
    written();
  }
}

// A free folder name in the shared folders. A world or a resource pack already
// there is somebody's, and is never overwritten.
function freeTarget(folder, wanted, note) {
  const target = path.join(folder, folderSafeName(wanted) || 'Pack');
  return fs.existsSync(target) ? freeNameBeside(target, folderSafeName(note) || 'import') : target;
}

async function installLooseArchive(filePath, choices, report = () => {}) {
  if (!looseImport || looseImport.filePath !== filePath ||
      looseImport.mtimeMs !== fs.statSync(filePath).mtimeMs) {
    await inspectLocalModpack(filePath);
  }
  const { zip, plan } = looseImport;
  const version = String(choices?.version || '');
  if (!NUMERIC_VERSION.test(version)) throw new Error('no version of the game was chosen');

  const chosen = plan.groups.filter(group => (choices.groups || []).includes(group.id));
  const mods = chosen.flatMap(group => group.mods);
  const loaders = loaderForMods(mods);
  if (loaders.length > 1) throw new Error(`these mods are for different loaders: ${loaders.join(', ')}`);
  const loader = loaders[0] || 'vanilla';

  // The build of the loader the author named, if they did - instructions often
  // say "Fabric 0.17.2" - and the newest stable one otherwise.
  let loaderVersion = null;
  if (loader !== 'vanilla') {
    report({ stage: 'loader' });
    let builds = [];
    try { builds = await modLoaders[loader].listVersions(version); } catch {}
    if (!builds.length) throw new Error(`${loader} has nothing for Minecraft ${version}`);
    const named = builds.find(build => plan.mentioned.includes(build.version));
    loaderVersion = (named || builds.find(build => build.stable) || builds[0]).version;
  }

  const store = loadInstances();
  const name = String(choices.name || '').trim() || plan.name;
  const instance = {
    id: instanceId(name, store.instances.map(entry => entry.id)),
    name,
    version,
    loader,
    loaderVersion,
    ram: null,
    fromModpack: { source: 'file', from: filePath },
    createdAt: new Date().toISOString()
  };

  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  const pathOf = entry => entry.entryName.replace(/\\/g, '/');
  const inside = (p, dir) => dir === '' || p.startsWith(dir + '/');
  const gameFolder = loadSettings().gameFolder;

  // Counted up front so the bar means something.
  const total = mods.length +
    plan.resourcePacks.reduce((sum, pack) => sum + (pack.zip ? 1 : entries.filter(e => inside(pathOf(e), pack.dir)).length), 0) +
    plan.worlds.reduce((sum, world) => sum + (world.zip ? 1 : entries.filter(e => inside(pathOf(e), world.dir)).length), 0) +
    plan.shaders.reduce((sum, shader) => sum + (shader.zip ? 1 : entries.filter(e => inside(pathOf(e), shader.dir)).length), 0) +
    plan.configDirs.reduce((sum, dir) => sum + entries.filter(e => inside(pathOf(e), dir)).length, 0);

  let done = 0;
  let lastReport = 0;
  let label = '';
  // Thousands of small files are written in one go. Every so often the loop
  // steps aside, so the progress bar is drawn and the window stays alive.
  const written = async () => {
    done++;
    if (Date.now() - lastReport > 150) {
      lastReport = Date.now();
      report({ stage: 'files', done, total, name: label });
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const writtenSync = () => { done++; };
  const pause = async () => {
    report({ stage: 'files', done, total, name: label });
    await new Promise(resolve => setImmediate(resolve));
  };

  const modsDir = packContentDir(instance, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  for (const mod of mods) {
    label = mod.filename;
    extractTo(modsDir, mod.filename, zip.getEntry(mod.path).getData());
    rememberMod(instance, { filename: mod.filename, title: mod.title, source: null, projectId: null, kind: 'mod' });
    await written();
  }

  const configDir = packContentDir(instance, 'config');
  for (const dir of plan.configDirs) {
    label = 'config';
    for (const entry of entries.filter(e => inside(pathOf(e), dir))) {
      extractTo(configDir, pathOf(entry).slice(dir.length + 1), entry.getData());
      await written();
    }
  }

  // Resource packs are shared between packs, so they go to the shared folder,
  // and the pack remembers which ones it brought - those are switched on when
  // it is played and off when something else is.
  const enabled = [];
  for (const pack of plan.resourcePacks) {
    label = pack.title;
    const folder = path.join(gameFolder, 'resourcepacks');
    if (pack.zip) {
      const target = freeTarget(folder, `${pack.folderName}.zip`, name);
      extractTo(folder, path.basename(target), zip.getEntry(pack.zip).getData());
      enabled.push(path.basename(target));
      await written();
    } else {
      const target = freeTarget(folder, pack.folderName, name);
      for (const entry of entries.filter(e => inside(pathOf(e), pack.dir))) {
        const p = pathOf(entry);
        extractTo(target, pack.dir === '' ? p : p.slice(pack.dir.length + 1), entry.getData());
        await written();
      }
      enabled.push(path.basename(target));
    }
  }
  if (enabled.length) instance.resourcePacks = enabled;

  for (const world of plan.worlds) {
    label = world.title;
    const target = freeTarget(path.join(gameFolder, 'saves'), world.title, name);
    if (world.zip) {
      const inner = new AdmZip(zip.getEntry(world.zip).getData());
      extractFolder(inner.getEntries().filter(entry => !entry.isDirectory), world.inner, target, writtenSync);
      await pause();
    } else {
      for (const entry of entries.filter(e => inside(pathOf(e), world.dir))) {
        const p = pathOf(entry);
        extractTo(target, world.dir === '' ? p : p.slice(world.dir.length + 1), entry.getData());
        await written();
      }
    }
  }

  for (const shader of plan.shaders) {
    label = shader.title;
    const folder = path.join(gameFolder, 'shaderpacks');
    if (shader.zip) {
      const target = freeTarget(folder, `${shader.title}.zip`, name);
      extractTo(folder, path.basename(target), zip.getEntry(shader.zip).getData());
      await written();
    } else {
      const target = freeTarget(folder, shader.title, name);
      for (const entry of entries.filter(e => inside(pathOf(e), shader.dir))) {
        extractTo(target, pathOf(entry).slice(shader.dir.length + 1), entry.getData());
        await written();
      }
    }
  }

  // The author's documents travel with the pack, so they can be opened again
  // from its page long after the archive is gone.
  if (plan.docs.length) {
    const docsDir = path.join(packRecordDir(instance), 'docs');
    for (const doc of plan.docs) {
      const target = freeTargetFile(docsDir, doc.split('/').pop());
      extractTo(docsDir, path.basename(target), zip.getEntry(doc).getData());
      if (doc === plan.readme) instance.readme = path.basename(target);
    }
  }

  store.instances.push(instance);
  store.activeId = instance.id;
  saveInstances(store);
  looseImport = null;

  report({ stage: 'done', done: total, total });
  if (instance.readme) openPackReadme(instance);
  return { id: instance.id, name: instance.name, version, loader, files: total };
}

// Two documents called readme.txt from two folders of the archive.
function freeTargetFile(folder, name) {
  const target = path.join(folder, folderSafeName(name) || 'readme.txt');
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  for (let n = 2; n < 100; n++) {
    const candidate = path.join(folder, `${path.basename(target, ext)} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return target;
}

function openPackReadme(instance) {
  if (!instance?.readme) return false;
  const file = path.join(packRecordDir(instance), 'docs', path.basename(instance.readme));
  if (!fs.existsSync(file)) return false;
  shell.openPath(file);
  return true;
}

// The resource packs a pack brought with it are switched on when that pack
// starts to be played, at the top of the list as such packs ask to be, and
// switched off again when something else is played - a Portal texture pack has
// no business in somebody's survival world. Only on the change of hands: if
// the player turns one off while playing the pack, that choice stands.
//
// Packs the player chose for themselves are never touched.
function applyPackResourcePacks(gameFolder, pack, version) {
  const instances = loadInstances().instances;
  if (!instances.some(entry => entry.resourcePacks?.length)) return;

  // Before 1.13 the list holds bare names; after, names with "file/" in front.
  const modern = !NUMERIC_VERSION.test(version) || compareVersionNumbers(version, '1.13') >= 0;
  const asListed = name => (modern ? `file/${name}` : name);
  const everyone = new Set(instances.flatMap(entry => entry.resourcePacks || [])
    .flatMap(name => [`file/${name}`, name]));
  const mine = (pack?.resourcePacks || []).map(asListed);

  const optionsPath = path.join(gameFolder, 'options.txt');
  const lines = fs.existsSync(optionsPath) ? fs.readFileSync(optionsPath, 'utf-8').split(/\r?\n/) : [];
  const at = lines.findIndex(line => line.startsWith('resourcePacks:'));
  let list = modern ? ['vanilla'] : [];
  if (at >= 0) {
    const parsed = lenientJson(lines[at].slice('resourcePacks:'.length));
    if (Array.isArray(parsed)) list = parsed;
  }

  const before = JSON.stringify(list);
  list = list.filter(name => !everyone.has(name) || mine.includes(name));
  // Last in the list is top of the list in the game.
  for (const name of mine) if (!list.includes(name)) list.push(name);
  if (JSON.stringify(list) === before) return;

  const line = `resourcePacks:${JSON.stringify(list)}`;
  if (at >= 0) lines[at] = line;
  else if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line);
  else lines.push(line);
  fs.writeFileSync(optionsPath, lines.join('\n'));
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


// Java refusing to start at all because the heap it was asked for will not
// fit. Nothing has run yet, nothing is lost, and a smaller heap would work -
// which is why this is worth telling apart from a game that died mid-play.
// Either line is proof enough on its own terms. Demanding both missed the
// real thing: the process died so fast that "Could not create the Java
// Virtual Machine" never reached us, and the player got a bare exit code for
// a problem the launcher could have fixed in one click.
// A zip ends with a record naming where its table of contents starts. No such
// record, no zip: the file was cut short. Only the tail is read, because that
// is where the record lives - the end plus room for a comment.
function looksTruncated(file) {
  try {
    const size = fs.statSync(file).size;
    if (!size) return true;
    const length = Math.min(size, 66000);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, 'r');
    fs.readSync(handle, buffer, 0, length, size - length);
    fs.closeSync(handle);
    return buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) === -1;
  } catch {
    // Unreadable is not the same as cut short, and guessing here would delete
    // a file over a locked handle.
    return false;
  }
}

// minecraft-launcher-core writes a download with no check of any kind - not a
// hash, not even the length it was promised - and afterwards only ever asks
// whether the file exists. So a download cut short by a dropped connection is
// left looking complete and is never fetched again: the game dies on it with a
// Java stack trace, at every launch, for good.
//
// Found exactly that here - 7.4 MB of a jar with no end to it, sitting since
// August, and Fabric refusing to start on "zip END header not found". Removing
// it is all it takes: the library fetches what is missing.
function discardBrokenVersionJar(gameFolder, versionId) {
  const jar = path.join(gameFolder, 'versions', versionId, `${versionId}.jar`);
  if (!fs.existsSync(jar) || !looksTruncated(jar)) return false;

  console.log('[LAUNCH] the game jar is cut short, removing so it is fetched again:', jar);
  fs.rmSync(jar, { force: true });
  return true;
}

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
// What a retry would look like, kept until it is asked for. The blue screen
// asks rather than a system dialog, so the answer comes back separately.
let offeredRetry = null;

function reportGameCrash(code, output, effectiveRam, freeAtLaunch, profile) {
  const t = loadTranslations(currentLocale);
  const window = BrowserWindow.getAllWindows()[0];

  // Which reading of the crash was taken, so a wrong one can be seen from the
  // terminal instead of guessed at from the screen that followed.
  console.log(`[CRASH] exit ${code}, ${output.length} chars captured, ` +
    `heap-too-big-to-start: ${heapTooBigToStart(output)}`);

  const show = report => {
    if (window && !window.isDestroyed()) window.webContents.send('game-crashed', report);
  };

  // The game never started: Java would not take the heap.
  if (heapTooBigToStart(output)) {
    const retryWith = smallerHeap(effectiveRam, freeAtLaunch);

    // Only this once, and only for this launch - the setting is left alone,
    // because a machine with a browser closed will take the larger figure
    // again tomorrow.
    offeredRetry = profile ? { profile, ram: retryWith } : null;

    return show({
      what: t['crash.heapTooBigShort'],
      why: `${t['crash.heapTooBig']}\n\n` +
        `${t['crash.givenRam']}: ${effectiveRam} ${t['settings.mib']}\n` +
        `${t['crash.freeAtLaunch']}: ${freeAtLaunch} ${t['settings.mib']}\n\n` +
        t['crash.heapIsNotAll'],
      action: offeredRetry ? `${t['crash.retryWith']} ${retryWith} ${t['settings.mib']}` : null
    });
  }

  const outOfMemory = /insufficient memory|OutOfMemoryError|failed to allocate/i.test(output);

  show(outOfMemory
    ? {
      what: t['crash.outOfMemoryShort'],
      why: `${t['crash.outOfMemory']}\n\n` +
        `${t['crash.givenRam']}: ${effectiveRam} ${t['settings.mib']}\n` +
        `${t['crash.freeAtLaunch']}: ${freeAtLaunch} ${t['settings.mib']}\n\n` +
        t['crash.heapIsNotAll']
    }
    : {
      what: t['crash.title'],
      why: `${t['crash.exitCode']}: ${code}`,
      technical: output.trim().split('\n').slice(-6).join('\n')
    });
}

ipcMain.handle('retry-launch', () => {
  if (!offeredRetry) return false;

  const { profile, ram } = offeredRetry;
  offeredRetry = null;
  startGame(profile, ram);
  return true;
});

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
const loadersDir = launcherFile('loaders');

// Java runtimes the launcher downloads itself, plus a small note of which
// Java each game version asks for, so we do not refetch that every launch.
const javaDir = launcherFile('java');
const javaRequirementsPath = launcherFile('java-versions.json');

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
// Where that is comes from Windows itself rather than from a letter written
// down here - the system is not always on C:, and a launcher that only ever
// looks at C: would download a second copy of a Java the machine already has.
function findSystemJavas() {
  const programFiles = [
    process.env['ProgramFiles'] || 'C:' + path.sep + 'Program Files',
    process.env['ProgramFiles(x86)'] || 'C:' + path.sep + 'Program Files (x86)',
    process.env['ProgramW6432']
  ].filter(Boolean);

  const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft'];
  const roots = [
    ...programFiles.flatMap(base => vendors.map(vendor => path.join(base, vendor))),
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
  // A hand-picked runtime that is no longer on the machine - the drive it was
  // on has gone, or it was uninstalled - is not an answer. Better to pick one
  // ourselves than to hand the game a path to nothing.
  if (manualPath && fs.existsSync(manualPath)) return manualPath;
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

app.whenReady().then(() => {
  // Never allowed to stop the launcher from opening. A pack that has not moved
  // yet is a pack in the wrong folder; a launcher that will not start is worse.
  try {
    migrateIntoGameFolder(loadSettings().gameFolder);
  } catch (e) {
    console.log('[MOVE] could not finish moving the packs:', e.message);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
