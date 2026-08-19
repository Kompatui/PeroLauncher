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
const { spawn } = require('child_process');

let child = null;
let stopped = false;

// Java leaves children of its own, so the whole tree goes.
function stopGame() {
  stopped = true;
  if (!child) return;

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

function send(message) {
  process.parentPort.postMessage(message);
}

process.parentPort.on('message', event => {
  const message = event.data;

  if (message.type === 'stop') return stopGame();
  if (message.type !== 'launch') return;

  const launcher = new Client();

  launcher.on('debug', line => send({ type: 'debug', line: String(line) }));
  launcher.on('data', line => send({ type: 'data', line: String(line) }));
  launcher.on('progress', progress => send({ type: 'progress', progress }));
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
