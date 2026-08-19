// Pre-flight check for the mod loaders.
//
// Every loader hands the launcher something different, and what looks fine for
// one game version can be wrong for another. Forge is the clear example: the
// installer jar carries the version.json that minecraft-launcher-core needs
// from 1.12 onwards, while older builds keep it in the universal jar. Give
// MCLC the wrong one and it silently starts vanilla with a broken class path.
//
// This script asks every loader for real builds and checks that what we would
// download actually contains what the launcher needs - before a player runs
// into it.
//
//   node scripts/check-loaders.js
//   node scripts/check-loaders.js 1.7.10 1.12.2 1.20

const AdmZip = require('adm-zip');
const { createHash } = require('crypto');

const VERSIONS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['1.5.2', '1.7.10', '1.11.2', '1.12.2', '1.16.5', '1.20', '1.21.1', '26.2'];

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Same retry policy as the launcher: the connection drops at random, but a 4xx
// is the server saying "nothing here" and must not be retried.
async function request(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 400 && response.status < 500) {
        const error = new Error(`HTTP ${response.status}`);
        error.fromServer = true;
        throw error;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (e) {
      if (e.fromServer) throw e;
      lastError = e;
    }
    if (attempt < attempts) await sleep(1500);
  }
  throw lastError;
}

const getJson = async url => (await request(url)).json();
const getText = async url => (await request(url)).text();
const getBuffer = async url => Buffer.from(await (await request(url)).arrayBuffer());

// Looks for a file stored at the root of a zip by finding its local header
// rather than pulling in a zip library for one question.
function zipHasFile(buffer, name) {
  const needle = Buffer.from(name);
  let at = buffer.indexOf(needle);
  while (at !== -1) {
    const headerStart = at - 30;
    if (headerStart >= 0 && buffer.readUInt32LE(headerStart) === 0x04034b50) return true;
    at = buffer.indexOf(needle, at + 1);
  }
  return false;
}

// Both rules mirror main.js. If they drift apart, this check stops meaning
// anything - it is here to test what the launcher actually does.
// Counts entries whose local header names a .class file.
function countClassEntries(buffer) {
  let count = 0;
  let at = buffer.indexOf(Buffer.from('.class'));
  while (at !== -1) {
    // Walk back over the file name to where its local header would start.
    for (let nameLength = 6; nameLength <= 200; nameLength++) {
      const headerStart = at + 6 - nameLength - 30;
      if (headerStart < 0) break;
      if (buffer.readUInt32LE(headerStart) === 0x04034b50 &&
          buffer.readUInt16LE(headerStart + 26) === nameLength) {
        count++;
        break;
      }
    }
    at = buffer.indexOf(Buffer.from('.class'), at + 1);
  }
  return count;
}

function forgeArtifactKind(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] !== '1') return 'installer';
  return Number(parts[1]) >= 12 ? 'installer' : 'universal';
}

function forgeUsesJarMod(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] !== '1') return false;
  return Number(parts[1]) < 6;
}

function neoforgeVersionPrefix(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] === '1') {
    const [, minor, patch] = parts;
    return `${minor}.${patch ?? 0}.`;
  }
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch ?? 0}.`;
}

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

// A loader profile is only launchable if it names itself, points at the game
// version it extends, says which class starts the game, and gives a download
// address for every library it adds.
function checkProfile(profile) {
  const problems = [];
  if (!profile.id) problems.push('no id');
  if (!profile.inheritsFrom) problems.push('no inheritsFrom');
  if (!profile.mainClass) problems.push('no mainClass');
  if (!Array.isArray(profile.libraries) || profile.libraries.length === 0) {
    problems.push('no libraries');
  } else {
    const noUrl = profile.libraries.filter(library => !library.url && !library.downloads);
    if (noUrl.length) problems.push(`${noUrl.length} libraries without a download address`);
  }
  return problems;
}

async function checkMetaLoader(name, baseUrl, mcVersion) {
  let builds;
  try {
    builds = await getJson(`${baseUrl}/versions/loader/${encodeURIComponent(mcVersion)}`);
  } catch (e) {
    if (e.fromServer) return { state: 'absent' };
    return { state: 'error', note: e.message };
  }
  if (!builds.length) return { state: 'absent' };

  const build = builds[0].loader.version;
  const profile = await getJson(
    `${baseUrl}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(build)}/profile/json`
  );

  const problems = checkProfile(profile);
  return {
    state: problems.length ? 'broken' : 'ok',
    note: problems.length ? problems.join('; ') : `${build}, ${profile.libraries.length} libraries`
  };
}

async function checkForge(mcVersion, metadata) {
  const prefix = `${mcVersion}-`;
  const builds = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)]
    .map(match => match[1])
    .filter(version => version.startsWith(prefix))
    .map(version => version.slice(prefix.length))
    .filter(Boolean)
    .sort(compareBuildNumbers);

  if (!builds.length) return { state: 'absent' };

  const newest = builds[builds.length - 1];
  const build = `${mcVersion}-${newest}`;

  // Before 1.6 the launcher pastes the loader into the game jar itself, so
  // what matters is that the archive exists and holds classes to paste.
  if (forgeUsesJarMod(mcVersion)) {
    for (const name of [`forge-${build}-universal.zip`, `forge-${build}-client.zip`]) {
      let archive;
      try {
        archive = await getBuffer(`${FORGE_MAVEN}/${build}/${name}`);
      } catch (e) {
        if (e.fromServer) continue;
        return { state: 'error', note: `${name}: ${e.message}` };
      }
      // A jar mod is a pile of class files to lay over the game. The earliest
      // Forge builds are only that - no ModLoader, no FML, those came later.
      const classes = countClassEntries(archive);
      if (classes === 0) return { state: 'broken', note: `${name} holds no classes to overlay` };

      // The patched jar is only half of it: FML then wants its own libraries,
      // and those addresses died in 2013.
      const libraries = await checkFmlLibraries(mcVersion, build);
      if (libraries.state !== 'ok') {
        return { state: libraries.state, note: `${newest}, jar mod - ${libraries.note}` };
      }
      return { state: 'ok', note: `${newest}, jar mod, ${classes} classes, ${libraries.note}` };
    }
    return { state: 'broken', note: 'no universal or client archive published' };
  }

  const kind = forgeArtifactKind(mcVersion);
  let jar;
  try {
    jar = await getBuffer(`${FORGE_MAVEN}/${build}/forge-${build}-${kind}.jar`);
  } catch (e) {
    return { state: 'broken', note: `${kind} jar: ${e.message}` };
  }

  if (!zipHasFile(jar, 'version.json')) {
    const other = kind === 'installer' ? 'universal' : 'installer';
    return { state: 'broken', note: `${kind} jar has no version.json - try the ${other} jar` };
  }

  return { state: 'ok', note: `${newest}, ${kind} jar` };
}

async function checkNeoforge(mcVersion, metadata) {
  const prefix = neoforgeVersionPrefix(mcVersion);
  const builds = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)]
    .map(match => match[1])
    .filter(version => version.startsWith(prefix))
    .sort(compareBuildNumbers);

  if (!builds.length) return { state: 'absent' };

  // The catalogue can list a build whose installer is not uploaded yet, so the
  // launcher walks down from the newest. Same thing here.
  let build = null;
  let jar = null;
  let skipped = 0;

  for (const candidate of [...builds].reverse()) {
    try {
      jar = await getBuffer(`${NEOFORGE_MAVEN}/${candidate}/neoforge-${candidate}-installer.jar`);
      build = candidate;
      break;
    } catch (e) {
      if (!e.fromServer) return { state: 'error', note: `installer: ${e.message}` };
      if (++skipped >= 4) return { state: 'broken', note: 'no published installer among the newest builds' };
    }
  }

  if (!build) return { state: 'broken', note: 'no published installer' };

  // Its installer is run rather than read, so what matters is that it is the
  // real thing and not an error page.
  if (!zipHasFile(jar, 'install_profile.json')) {
    return { state: 'broken', note: 'installer has no install_profile.json' };
  }

  const skippedNote = skipped ? `, skipped ${skipped} unpublished` : '';
  return { state: 'ok', note: `${build}, installer ${Math.round(jar.length / 1024 / 1024)} MB${skippedNote}` };
}

// Same table and sources main.js uses to supply FML's dependencies.
const FML_LIBRARY_ON_MAVEN = {
  'guava-14.0-rc3.jar': 'com/google/guava/guava/14.0-rc3/guava-14.0-rc3.jar',
  'guava-12.0.1.jar': 'com/google/guava/guava/12.0.1/guava-12.0.1.jar',
  'asm-all-4.1.jar': 'org/ow2/asm/asm-all/4.1/asm-all-4.1.jar',
  'asm-all-4.0.jar': 'org/ow2/asm/asm-all/4.0/asm-all-4.0.jar',
  'bcprov-jdk15on-148.jar': 'org/bouncycastle/bcprov-jdk15on/1.48/bcprov-jdk15on-1.48.jar',
  'bcprov-jdk15on-147.jar': 'org/bouncycastle/bcprov-jdk15on/1.47/bcprov-jdk15on-1.47.jar'
};

const FML_LIBRARY_ORIGIN = 'http://files.minecraftforge.net/fmllibs/';

// Reading the requirement out of the build itself, exactly as the launcher does.
function readFmlLibraryList(archive) {
  const entry = new AdmZip(archive).getEntry('cpw/mods/fml/relauncher/CoreFMLLibraries.class');
  if (!entry) return null;   // Forge older than FML.

  const text = entry.getData().toString('latin1');
  const strings = text.match(/[\x20-\x7e]{4,}/g) || [];
  const names = strings.filter(value => /\.(jar|zip)$/.test(value));
  const hashes = strings.flatMap(value => value.match(/[0-9a-f]{40}/g) || []);
  return names.map((name, index) => ({ name, sha1: hashes[index] || null }));
}

async function archivedUrls(originalUrl) {
  const index = 'https://web.archive.org/cdx/search/cdx' +
    `?url=${encodeURIComponent(originalUrl)}&output=json&filter=statuscode:200&limit=-6`;
  try {
    const rows = await getJson(index);
    if (!Array.isArray(rows) || rows.length < 2) return [];
    return rows.slice(1).map(row => row[1]).reverse()
      .map(stamp => `https://web.archive.org/web/${stamp}id_/${originalUrl}`);
  } catch {
    return [];
  }
}

// Libraries repeat across versions, so a name is only ever resolved once.
const libraryResults = new Map();

async function canGetLibrary(library) {
  if (libraryResults.has(library.name)) return libraryResults.get(library.name);

  const sources = [];
  if (FML_LIBRARY_ON_MAVEN[library.name]) {
    sources.push(['maven', `https://repo1.maven.org/maven2/${FML_LIBRARY_ON_MAVEN[library.name]}`]);
  }
  for (const url of await archivedUrls(FML_LIBRARY_ORIGIN + library.name)) {
    sources.push(['archive', url]);
  }

  let outcome = { ok: false, from: 'nowhere' };
  for (const [where, url] of sources) {
    try {
      const data = await getBuffer(url);
      const sha1 = createHash('sha1').update(data).digest('hex');
      if (library.sha1 && sha1 !== library.sha1) continue;
      outcome = { ok: true, from: where };
      break;
    } catch {
      // Try the next source.
    }
  }

  libraryResults.set(library.name, outcome);
  return outcome;
}

async function checkFmlLibraries(mcVersion, build) {
  let archive;
  for (const name of [`forge-${build}-universal.zip`, `forge-${build}-client.zip`]) {
    try {
      archive = await getBuffer(`${FORGE_MAVEN}/${build}/${name}`);
      break;
    } catch {
      // Try the other name.
    }
  }
  if (!archive) return { state: 'broken', note: 'no archive' };

  const required = readFmlLibraryList(archive);
  if (required === null) {
    return { state: 'warn', note: 'no FML in this build - needs ModLoader, which the launcher does not supply' };
  }

  // Only FML 5 and later use the deobfuscation map; asking for it on 1.3 or
  // 1.4 would report a failure over a file those builds never wanted.
  const injection = new AdmZip(archive).getEntry('cpw/mods/fml/relauncher/FMLInjectionData.class');
  const wantsDeobfuscation = injection
    ? injection.getData().toString('latin1').includes('deobfuscation_data_')
    : false;

  const wanted = wantsDeobfuscation
    ? [...required, { name: `deobfuscation_data_${mcVersion}.zip`, sha1: null }]
    : required;

  const missing = [];
  const fromArchive = [];
  for (const library of wanted) {
    const result = await canGetLibrary(library);
    if (!result.ok) missing.push(library.name);
    else if (result.from === 'archive') fromArchive.push(library.name);
  }

  if (missing.length) return { state: 'broken', note: `cannot obtain: ${missing.join(', ')}` };
  return {
    state: 'ok',
    note: `${wanted.length} files available` +
      (fromArchive.length ? `, ${fromArchive.length} only from the web archive` : '')
  };
}

const MARK = { ok: 'ok    ', absent: '-     ', broken: 'BROKEN', error: 'ERROR ', warn: 'WARN  ' };

(async () => {
  console.log(`Checking loaders for: ${VERSIONS.join(', ')}\n`);

  const forgeMetadata = await getText(`${FORGE_MAVEN}/maven-metadata.xml`);
  const neoforgeMetadata = await getText(`${NEOFORGE_MAVEN}/maven-metadata.xml`);

  let broken = 0;

  for (const mcVersion of VERSIONS) {
    console.log(mcVersion);

    const results = {
      fabric: await checkMetaLoader('fabric', 'https://meta.fabricmc.net/v2', mcVersion),
      quilt: await checkMetaLoader('quilt', 'https://meta.quiltmc.org/v3', mcVersion),
      forge: await checkForge(mcVersion, forgeMetadata),
      neoforge: await checkNeoforge(mcVersion, neoforgeMetadata)
    };

    for (const [loader, result] of Object.entries(results)) {
      if (result.state === 'broken' || result.state === 'error') broken++;
      console.log(`  ${MARK[result.state]} ${loader.padEnd(9)}${result.note || ''}`);
    }
    console.log('');
  }

  console.log(broken === 0
    ? 'Everything a player can pick would actually launch.'
    : `${broken} combination(s) would fail. See the lines marked above.`);

  process.exit(broken === 0 ? 0 : 1);
})();
