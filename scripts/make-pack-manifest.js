// Turns one of the author's packs into something players can be given, and
// updated from, without downloading the whole thing again.
//
// The idea is the one every launcher settles on eventually: publish a list of
// every file the pack is made of, each with its sha1. A player's launcher
// compares that list against what is already on their disk and fetches only
// what differs. A changed config is a few kilobytes, not three hundred
// megabytes.
//
// Two things fall out of that and both matter.
//
// Third-party mods are not ours to host. Modrinth can be asked what a file is
// by its hash alone, so anything it recognises goes into the manifest as a
// link to Modrinth. What is left is the author's own work - configs, custom
// files - and only that has to live on our hosting. It is usually a rounding
// error next to the mods.
//
// A file's name is not its identity. Two builds of a config can share a name
// and differ inside, so everything we host is stored under its own sha1. That
// makes an update trivially incremental: a file whose hash is unchanged is
// already published, and is not uploaded again.
//
// The pack comes either as the zip the author already makes for players, or
// as a pack set up inside the launcher:
//
//   node scripts/make-pack-manifest.js "Kempa's mods V1.7.1 (1.21.11).zip"
//   node scripts/make-pack-manifest.js "<архив>.zip" --changelog пост.txt
//   node scripts/make-pack-manifest.js "<архив>.zip" --publish
//   node scripts/make-pack-manifest.js <id сборки> --version 1.4.0
//
// For a zip, the pack's version and the game's are read from its name, the way
// the author already writes them: "V1.7.1" and "(1.21.11)". --version and
// --minecraft say it outright when a name does not.
//
// A mod whose name starts with a note in brackets - "(Not for PPL) InvMove.jar"
// - belongs to an optional set named by that note. The player decides whether
// the set goes in; the author's own marking is all it takes.
//
// It writes into build/<id сборки>/:
//   manifest.json  - the list to publish
//   files/         - the files to upload, named by their hash
// The two are published side by side: the launcher looks for files/<sha1>
// next to wherever it found manifest.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const MOD_API_HEADERS = {
  'User-Agent': 'Kompatui/PeroLauncher/1.0 (https://github.com/Kompatui/PeroLauncher)'
};

// The launcher itself lives one folder up, and so do its settings and its
// record of which packs exist.
const launcherDir = path.join(__dirname, '..');

// What belongs to a pack rather than to the player. Worlds, screenshots and
// resource packs are deliberately shared between every pack on this machine,
// so they are not part of what gets published. Kept in step with PACK_OWNED in
// main.js - if that list grows, this one grows with it.
const PACK_OWNED = ['mods', 'config'];

// Only mods are worth asking Modrinth about. A config folder is thousands of
// small text files that no mod site has ever seen, and asking would be
// thousands of pointless requests.
const LOOK_UP = /\.jar$/i;

// "(Not for PPL) InvMove.jar": the bracketed note names an optional set.
const SET_MARK = /^\(([^)]+)\)\s*/;

// Where each loader lists its own builds. Forge and NeoForge have no such
// simple list, so for them the build is given with --loader-version.
const LOADER_META = {
  fabric: 'https://meta.fabricmc.net/v2/versions/loader',
  quilt: 'https://meta.quiltmc.org/v3/versions/loader'
};

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Same retry policy as the launcher: the connection here drops at random, but
// a 4xx is the server saying "nothing here" and must not be retried.
async function request(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 400 && response.status < 500) return response;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

// Some mods put raw line breaks inside their JSON strings, which the format
// does not allow and every loader quietly forgives. So do we.
function lenientJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' ')); } catch {}
  return null;
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

// One requirement as Fabric and Quilt write it: "1.21.1", "~1.21", "1.21.x",
// ">=1.21 <1.21.2", or a list of which any one will do. Kept in step with
// fabricAllows in main.js. A requirement this cannot read counts as none.
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

// What a jar says about itself, as far as publishing needs it: the loader it
// is for, and what it asks of the game and of the loader.
function describeJar(data) {
  let jar;
  try { jar = new AdmZip(data); } catch { return null; }
  const read = name => {
    const entry = jar.getEntry(name);
    return entry ? entry.getData().toString('utf-8') : null;
  };

  // A jar that carries both descriptions runs on Fabric too, and its Quilt one
  // is often left over from an older build. Only a Quilt-only mod makes it Quilt.
  const quilt = jar.getEntry('fabric.mod.json') ? null : lenientJson(read('quilt.mod.json'));
  if (quilt) {
    const depends = quilt.quilt_loader?.depends || [];
    const find = id => depends.find(dep => (dep?.id || dep) === id);
    return { loader: 'quilt', game: find('minecraft')?.versions, loaderNeeds: find('quilt_loader')?.versions };
  }
  const fabric = lenientJson(read('fabric.mod.json'));
  if (fabric) {
    return { loader: 'fabric', game: fabric.depends?.minecraft, loaderNeeds: fabric.depends?.fabricloader };
  }
  const neoToml = read('META-INF/neoforge.mods.toml');
  const toml = neoToml || read('META-INF/mods.toml');
  if (toml) return { loader: neoToml || /modId\s*=\s*["']neoforge["']/.test(toml) ? 'neoforge' : 'forge' };
  return null;
}

// Where the launcher keeps its game folder, resolved the same way main.js does
// it: a path inside the launcher folder is stored relative so the whole thing
// can be moved or carried on a stick.
function gameFolder() {
  const settings = readJson(path.join(launcherDir, 'settings.json'), {});
  const stored = settings.gameFolder || '.minecraft';
  return path.resolve(launcherDir, stored);
}

// A pack's own files are wherever they happen to be right now: in the game
// folder if this pack is the one that played last, in its own folder if not.
// Exactly the question packContentDir answers inside the launcher.
function packContentDir(instanceId, folderName) {
  const game = gameFolder();
  const ownerFile = path.join(game, 'instances', 'owner.txt');
  let owner = null;
  try {
    owner = fs.readFileSync(ownerFile, 'utf-8').trim();
  } catch {
    // No owner recorded yet, which just means nothing has played.
  }
  if (owner === instanceId) return path.join(game, folderName);
  return path.join(game, 'instances', instanceId, folderName);
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push({ full, relative: path.relative(base, full) });
  }
  return out;
}

function sha1Of(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

// Stable across releases, so every version of the pack is the same pack to a
// player's launcher: "Kempa's mods" -> "kempas-mods".
function packIdFrom(name) {
  return name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '') || 'pack';
}

// Modrinth will take a batch of hashes and say which ones it knows. Asking one
// at a time works too, but a pack is hundreds of mods and that is hundreds of
// round trips over a connection that drops.
async function askModrinth(hashes) {
  const known = new Map();
  const batchSize = 100;

  for (let start = 0; start < hashes.length; start += batchSize) {
    const batch = hashes.slice(start, start + batchSize);
    const response = await request('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { ...MOD_API_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: batch, algorithm: 'sha1' })
    });

    if (!response.ok) continue;   // Nothing in this batch is known to it.

    const found = await response.json();
    for (const [hash, version] of Object.entries(found)) {
      const file = (version.files || []).find(entry => entry.hashes?.sha1 === hash);
      if (file?.url) known.set(hash, file.url);
    }
  }

  return known;
}

// The newest stable build of the loader that every mod in the pack accepts.
// Pinned into the manifest, so all players run the build the author tested.
async function pickLoaderVersion(loader, jars) {
  const url = LOADER_META[loader];
  if (!url) return null;
  const response = await request(url, { headers: MOD_API_HEADERS });
  if (!response.ok) return null;
  const builds = await response.json();
  const needs = jars.map(jar => jar.about?.loaderNeeds).filter(Boolean);
  const fits = build => needs.every(need => fabricAllows(build.version, need));
  // Quilt's list has no stable flag; its betas are marked in the number.
  const stable = build => build.stable ?? !/beta|alpha|pre|rc/i.test(build.version);
  return (builds.find(build => stable(build) && fits(build)) || builds.find(fits))?.version || null;
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

// The pack as a zip the author made by hand: jars wherever they are, a config
// folder if there is one. Everything else in it (a readme, a picture) is not
// part of what the game loads and is named, not published.
async function readZipPack(zipPath, options) {
  const fileName = path.basename(zipPath).replace(/\.zip$/i, '');
  const version = options.version || fileName.match(/\bV(\d+(?:\.\d+)*)/i)?.[1] || null;
  const minecraft = options.minecraft || fileName.match(/\((\d+\.\d+(?:\.\d+)?)\)/)?.[1] ||
    fileName.match(/\b(1\.\d+(?:\.\d+)?)\b/)?.[1] || null;
  const name = options.name || fileName
    .replace(/\(\s*\d+\.\d+(?:\.\d+)?\s*\)/g, '')
    .replace(/\(?\bV\d+(?:\.\d+)*\)?/gi, '')
    .replace(/\b1\.\d+(?:\.\d+)?\b/g, '')
    .replace(/\s+/g, ' ').trim();

  const zip = new AdmZip(zipPath);
  const files = [];
  const skipped = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const inside = entry.entryName.replace(/\\/g, '/');
    const parts = inside.split('/');
    const lastName = parts[parts.length - 1];
    const configAt = parts.findIndex(part => part.toLowerCase() === 'config');

    let target = null;
    if (configAt !== -1 && configAt < parts.length - 1) target = ['config', ...parts.slice(configAt + 1)].join('/');
    else if (/\.jar$/i.test(lastName)) target = `mods/${lastName}`;
    if (!target) {
      skipped.push(inside);
      continue;
    }

    const data = entry.getData();
    files.push({ path: target, data, size: data.length, sha1: sha1Of(data) });
  }

  return { name, id: options.id || packIdFrom(name), version, minecraft, files, skipped };
}

// The pack as it is set up inside the launcher.
function readInstancePack(pack, options) {
  const files = [];
  for (const folder of PACK_OWNED) {
    const dir = packContentDir(pack.id, folder);
    for (const found of walk(dir)) {
      const data = fs.readFileSync(found.full);
      files.push({
        path: `${folder}/${found.relative.split(path.sep).join('/')}`,
        data,
        size: data.length,
        sha1: sha1Of(data)
      });
    }
  }
  return {
    name: pack.name,
    id: options.id || pack.id,
    version: options.version || new Date().toISOString().slice(0, 10),
    minecraft: pack.version,
    loader: pack.loader || 'vanilla',
    loaderVersion: pack.loaderVersion || null,
    ram: pack.ram || null,
    files,
    skipped: []
  };
}

// Options that are said, not given a value.
const SWITCHES = new Set(['publish']);

function parseArgs(argv) {
  const options = {};
  const loose = [];
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--([a-z-]+)$/);
    if (match && SWITCHES.has(match[1])) {
      options[match[1]] = true;
    } else if (match) {
      options[match[1].replace(/-([a-z])/g, (all, letter) => letter.toUpperCase())] = argv[i + 1];
      i++;
    } else {
      loose.push(argv[i]);
    }
  }
  return { options, wanted: loose[0] };
}

async function main() {
  const { options, wanted } = parseArgs(process.argv.slice(2));
  const store = readJson(path.join(launcherDir, 'instances.json'), { instances: [] });

  if (!wanted) {
    console.log('Укажите архив сборки или сборку из лаунчера. В лаунчере есть такие:\n');
    for (const pack of store.instances) {
      console.log(`  ${pack.id}${' '.repeat(Math.max(1, 26 - pack.id.length))}${pack.name}`);
    }
    console.log('\n  node scripts/make-pack-manifest.js "<архив>.zip"');
    console.log('  node scripts/make-pack-manifest.js <id сборки>');
    return;
  }

  let source;
  if (/\.zip$/i.test(wanted) && fs.existsSync(wanted)) {
    source = await readZipPack(path.resolve(wanted), options);
  } else {
    const pack = store.instances.find(entry => entry.id === wanted);
    if (!pack) {
      console.log(`Ни архива, ни сборки "${wanted}" нет. Запустите без имени, чтобы увидеть список.`);
      process.exitCode = 1;
      return;
    }
    source = readInstancePack(pack, options);
  }

  const { files } = source;
  if (!files.length) {
    console.log('В сборке нет ни одного файла - публиковать нечего.');
    process.exitCode = 1;
    return;
  }

  // Each mod speaks for itself: which loader it needs and which game. A pack
  // that disagrees with itself is the author's to know about before players
  // find out.
  const jars = files.filter(file => LOOK_UP.test(file.path) && file.path.startsWith('mods/'));
  for (const jar of jars) jar.about = describeJar(jar.data);

  if (!source.loader) {
    const counts = {};
    for (const jar of jars) if (jar.about) counts[jar.about.loader] = (counts[jar.about.loader] || 0) + 1;
    // Quilt runs Fabric mods, so one Quilt mod among them makes it a Quilt pack.
    source.loader = counts.quilt ? 'quilt'
      : Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'vanilla';
  }

  const problems = [];
  if (!source.version) problems.push('не нашёл версию сборки в имени архива - укажите --version 1.0');
  if (!source.minecraft) problems.push('не нашёл версию игры в имени архива - укажите --minecraft 1.21.11');
  if (problems.length) {
    for (const problem of problems) console.log(`Ошибка: ${problem}`);
    process.exitCode = 1;
    return;
  }

  if (!source.loaderVersion && source.loader !== 'vanilla') {
    source.loaderVersion = options.loaderVersion || await pickLoaderVersion(source.loader, jars);
    if (!source.loaderVersion) {
      console.log(`Ошибка: не смог подобрать версию загрузчика ${source.loader} - укажите --loader-version`);
      process.exitCode = 1;
      return;
    }
  }

  // Optional sets, from the author's bracketed notes.
  const sets = new Map();
  for (const file of files) {
    const mark = file.path.split('/').pop().match(SET_MARK);
    if (!mark) continue;
    const title = mark[1].trim();
    const id = packIdFrom(title);
    if (!sets.has(id)) sets.set(id, { id, title, files: 0 });
    sets.get(id).files++;
    file.set = id;
  }

  // The post that goes with the release. Given outright, or simply lying next
  // to the zip under the same name - "Kempa's mods V1.7.1 (1.21.11).txt".
  const besideZip = /\.zip$/i.test(wanted) ? wanted.replace(/\.zip$/i, '.txt') : null;
  const changelogFile = options.changelog || (besideZip && fs.existsSync(besideZip) ? besideZip : null);
  const changelog = changelogFile ? fs.readFileSync(changelogFile, 'utf-8').trim() : null;

  console.log(`Сборка: ${source.name} ${source.version}  (Minecraft ${source.minecraft}, ${source.loader} ${source.loaderVersion || ''})\n`);

  const strangers = jars.filter(jar => jar.about && jar.about.loader !== source.loader &&
    !(source.loader === 'quilt' && jar.about.loader === 'fabric'));
  const wrongGame = jars.filter(jar => jar.about?.game && !fabricAllows(source.minecraft, jar.about.game));

  console.log(`Файлов в сборке: ${files.length}, вес ${human(files.reduce((sum, f) => sum + f.size, 0))}`);
  console.log('Спрашиваю Modrinth, что из этого он узнаёт…');

  const askAbout = [...new Set(jars.map(file => file.sha1))];
  const known = await askModrinth(askAbout);

  let theirs = 0;
  let ours = 0;
  for (const file of files) {
    const url = known.get(file.sha1);
    if (url) {
      file.url = url;
      theirs += file.size;
    } else {
      ours += file.size;
    }
  }

  // Ours to host: laid out under the hash, so republishing an unchanged file
  // is a no-op and the same file used twice is stored once.
  const outDir = path.join(launcherDir, 'build', source.id);
  const filesDir = path.join(outDir, 'files');
  fs.rmSync(filesDir, { recursive: true, force: true });
  fs.mkdirSync(filesDir, { recursive: true });

  const uploaded = new Set();
  for (const file of files) {
    if (file.url) continue;
    if (!uploaded.has(file.sha1)) {
      fs.writeFileSync(path.join(filesDir, file.sha1), file.data);
      uploaded.add(file.sha1);
    }
  }

  const manifest = {
    formatVersion: 1,
    id: source.id,
    name: source.name,
    version: source.version,
    minecraft: source.minecraft,
    loader: source.loader,
    loaderVersion: source.loaderVersion || null,
    ram: source.ram || null,
    changelog,
    // The player is asked about each of these; nothing in them is put in
    // unless they say so.
    sets: [...sets.values()].map(({ id, title }) => ({ id, title })),
    files: files.map(file => ({
      path: file.path,
      size: file.size,
      sha1: file.sha1,
      // A file of ours has no address of its own: it is files/<sha1> next to
      // the manifest, wherever that is published.
      ...(file.url ? { url: file.url } : {}),
      ...(file.set ? { set: file.set } : {})
    }))
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('');
  console.log(`  чужое, берётся с Modrinth   ${String(files.filter(f => f.url).length).padStart(5)} файлов   ${human(theirs)}`);
  console.log(`  ваше, надо выложить самим   ${String(uploaded.size).padStart(5)} файлов   ${human(ours)}`);
  for (const file of files.filter(f => !f.url)) console.log(`      ${file.path}`);
  for (const set of sets.values()) console.log(`  по выбору игрока: «${set.title}» - ${set.files} файлов`);
  if (strangers.length) {
    console.log(`\nВнимание: моды не для ${source.loader}, игра с ними может не запуститься:`);
    for (const jar of strangers) console.log(`      ${jar.path} (${jar.about.loader})`);
  }
  if (wrongGame.length) {
    console.log(`\nВнимание: эти моды по своему описанию не для Minecraft ${source.minecraft}:`);
    for (const jar of wrongGame) console.log(`      ${jar.path} (просит ${JSON.stringify(jar.about.game)})`);
  }
  if (source.skipped.length) {
    console.log('\nНе публикуется (не моды и не настройки):');
    for (const item of source.skipped) console.log(`      ${item}`);
  }
  console.log('');
  console.log(`Манифест: ${path.join(outDir, 'manifest.json')}`);
  console.log(`Выложить: ${filesDir}`);
  console.log(changelog ? `Описание обновления: ${changelogFile}` : 'Описания обновления нет (положите .txt рядом с архивом).');

  // build/ is the "pack" branch of the launcher's own repository, checked out
  // on its own. Each release is a commit there; --publish sends it to GitHub,
  // and from that moment players' launchers see it.
  const git = (...args) => execFileSync('git', ['-C', path.join(launcherDir, 'build'), ...args], { encoding: 'utf-8' });
  let isRepo = false;
  try { isRepo = git('rev-parse', '--is-inside-work-tree').trim() === 'true'; } catch {}
  if (!isRepo) return;

  git('add', '-A', '--', source.id);
  if (git('status', '--porcelain', '--', source.id).trim()) {
    git('commit', '-q', '-m', `${source.name} ${source.version}`);
    console.log(`\nЗаписано в ветку pack: ${source.name} ${source.version}`);
  } else {
    console.log('\nПо сравнению с прошлым выпуском ничего не изменилось.');
  }

  if (options.publish) {
    console.log('Отправляю на GitHub…');
    execFileSync('git', ['-C', path.join(launcherDir, 'build'), 'push', '-u', 'origin', 'pack'], { stdio: 'inherit' });
    console.log('Опубликовано. Лаунчеры игроков увидят обновление в течение нескольких минут.');
  } else {
    console.log('Игрокам ещё не видно. Опубликовать: добавьте --publish');
  }
}

main().catch(error => {
  console.error('Не получилось:', error.message);
  process.exitCode = 1;
});
