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

      return { state: 'ok', note: `${newest}, jar mod from ${name.split('-').pop()}, ${classes} classes` };
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

const MARK = { ok: 'ok    ', absent: '-     ', broken: 'BROKEN', error: 'ERROR ' };

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
