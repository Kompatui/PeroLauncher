// Downloading and starting the game, in a process of its own.
//
// It used to happen in the same process that draws the window and receives
// clicks. minecraft-launcher-core re-checks the hash of every asset on every
// launch - nearly four thousand files even when nothing needs fetching - and
// while it did that the launcher stopped answering for tens of seconds. Long
// enough that a player could press cancel and watch the game start anyway,
// because the press had nowhere to land.
//
// Nothing here touches the interface. It takes a launch, reports what it is
// doing, and stops when told to.

const { Client } = require('minecraft-launcher-core');
const Handler = require('minecraft-launcher-core/components/handler');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// The library pipes a download straight into a file and calls it done when the
// stream ends - which it also does when a connection drops halfway. Nothing is
// checked afterwards, so a truncated jar is written as though it were whole.
//
// An archive says where it ends. If the one we just wrote does not, it was cut
// short: throw it away and ask once more. Only archives are looked at - assets
// are named by their own hash and the library does check those.
const libraryDownload = Handler.prototype.downloadAsync;

Handler.prototype.downloadAsync = async function (url, directory, name, retry, type) {
  const result = await libraryDownload.call(this, url, directory, name, retry, type);
  if (!/\.(jar|zip)$/i.test(name)) return result;

  const file = path.join(directory, name);
  if (!fs.existsSync(file) || !truncatedArchive(file)) return result;

  this.client.emit('debug', `[pero]: ${name} arrived cut short - fetching it again`);
  fs.rmSync(file, { force: true });
  return libraryDownload.call(this, url, directory, name, false, type);
};

function truncatedArchive(file) {
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
    return false;
  }
}

// minecraft-launcher-core reads and hashes every asset on every launch - 4591
// files and 431 MB for 1.21.11 - even when there is nothing to fetch. Measured
// here at 33 seconds, and the screen called it downloading, which sent the
// player looking for a connection problem that did not exist.
//
// Every file the library writes is hash-checked as it is written. So what is
// worth asking on the next launch is not "is this the right file" but "is it
// still there, and still whole". That is a stat instead of a read: the same
// 4591 files in under half a second, and a truncated one is still caught,
// because a truncated file is the wrong size.
//
// Anything missing or the wrong size and the library's own pass runs in full
// and fetches exactly what is needed. Nothing is skipped that matters - only
// the reading of hundreds of megabytes to be told what we already knew.
const libraryAssetCheck = Handler.prototype.getAssets;

Handler.prototype.getAssets = async function () {
  const assetDirectory = path.resolve(
    this.options.overrides.assetRoot || path.join(this.options.root, 'assets'));
  const assetId = this.options.version.custom || this.options.version.number;
  const indexPath = path.join(assetDirectory, 'indexes', `${assetId}.json`);

  // Versions before 1.6 also need their assets copied out into resources/,
  // which is the library's business and not worth reproducing here.
  if (this.isLegacy() || !fs.existsSync(indexPath)) return libraryAssetCheck.call(this);

  let objects;
  try {
    objects = Object.values(JSON.parse(fs.readFileSync(indexPath, 'utf8')).objects || {});
  } catch {
    return libraryAssetCheck.call(this);
  }

  const total = objects.length;
  if (!total) return libraryAssetCheck.call(this);

  this.client.emit('progress', { type: 'assets', task: 0, total });

  let checked = 0;
  for (const object of objects) {
    const file = path.join(assetDirectory, 'objects', object.hash.substring(0, 2), object.hash);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {}

    if (!stat || stat.size !== object.size) {
      this.client.emit('debug', '[pero]: something is missing from the assets - full check');
      return libraryAssetCheck.call(this);
    }

    checked++;
    if (checked % 500 === 0) this.client.emit('progress', { type: 'assets', task: checked, total });
  }

  this.client.emit('progress', { type: 'assets', task: total, total });
  this.client.emit('debug', `[pero]: ${total} assets already in place, nothing to fetch`);
};

let child = null;
let stopped = false;

// Java leaves children of its own, so the whole tree goes - and then this
// process goes too. Downloading carried on for another ten seconds otherwise,
// which is not what anyone means by cancel: files are checked by hash before
// they are used, so a half-written one is simply fetched again next time.
function stopGame() {
  stopped = true;

  if (child) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch (e) {
      send({ type: 'debug', line: `[worker] taskkill refused: ${e.message}` });
    }
    try {
      child.kill();
    } catch (e) {
      send({ type: 'debug', line: `[worker] could not stop the game: ${e.message}` });
    }
  }

  // A moment for the message above to get out, then everything here stops.
  setTimeout(() => process.exit(0), 200);
}

function send(message) {
  process.parentPort.postMessage(message);
}

process.parentPort.on('message', event => {
  const message = event.data;

  if (message.type === 'stop') return stopGame();
  if (message.type !== 'launch') return;

  const launcher = new Client();

  // Whether anything is actually coming down the wire. The library reports the
  // same progress whether it is fetching a file or looking at one it already
  // has, and calling both of them downloading is simply untrue - most launches
  // fetch nothing at all.
  let lastDownloadAt = 0;
  launcher.on('download-status', () => { lastDownloadAt = Date.now(); });

  launcher.on('debug', line => send({ type: 'debug', line: String(line) }));
  launcher.on('data', line => send({ type: 'data', line: String(line) }));
  launcher.on('progress', progress => send({
    type: 'progress',
    progress,
    downloading: Date.now() - lastDownloadAt < 2000
  }));
  launcher.on('close', code => send({ type: 'close', code }));

  launcher.launch(message.opts)
    .then(started => {
      child = started;
      send({ type: 'started', pid: started?.pid || null });
      // The answer can arrive while the game is being spawned.
      if (stopped) stopGame();
    })
    .catch(e => send({ type: 'error', error: e.message }));
});
