document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

const playTile = document.getElementById('tile-play');
const launchPanel = document.getElementById('launch-panel');
const launchProgress = document.getElementById('launch-progress');
const launchText = document.getElementById('launch-text');
const launchFill = document.getElementById('launch-fill');
const launchCross = document.getElementById('launch-cross');

// The Esc key, drawn the way the Enter key is drawn on the play tile. Until
// that picture exists the plain cross takes its place - an empty tile in the
// middle of a launch would look like something had gone wrong.
const launchEsc = document.getElementById('launch-esc');
function useCrossInstead() {
  launchEsc.classList.add('hidden');
  document.getElementById('launch-cross-fallback').classList.remove('hidden');
}
launchEsc.addEventListener('error', useCrossInstead);
// A picture that is already missing by the time this runs never fires 'error'.
if (launchEsc.complete && launchEsc.naturalWidth === 0) useCrossInstead();

// Starting and stopping are two different things, so they are two different
// controls. One tile that changed colour and meaning was where every one of
// these bugs came from: whether a press started a game or stopped one
// depended on a variable, and when the variable was wrong the launcher did
// the opposite of what was asked.
//
// The panel covers the play tile for as long as a launch is happening, so
// while it is up the play tile cannot be pressed at all.
function showPanel(text, fraction, canCancel) {
  launchText.textContent = text;
  launchFill.style.width = fraction === null ? '0' : `${Math.round(fraction * 100)}%`;
  launchFill.classList.toggle('working', fraction === null);

  // Once the game is up there is nothing to call off, so the cross goes and
  // the tile stops being a button - it is only telling you something then.
  launchCross.classList.toggle('hidden', !canCancel);
  launchPanel.classList.toggle('waiting', !canCancel);
  launchPanel.disabled = !canCancel;

  playTile.classList.add('hidden');
  launchPanel.classList.remove('hidden');
  launchProgress.classList.remove('hidden');
  updateDrawing();
}

function hidePanel() {
  launchPanel.classList.add('hidden');
  launchProgress.classList.add('hidden');
  playTile.classList.remove('hidden');
  updateDrawing();
}

// Which launch is on screen, and which one the player has called off. A launch
// does not reach the main process the moment it is asked for: a stale
// Microsoft sign-in has to be refreshed first, and that takes seconds. Called
// off during those seconds, there was nothing over there to stop - the refusal
// was answered with silence and the game started anyway.
let attempt = 0;
let cancelledAttempt = 0;
let handedOver = false;

// Nothing here starts anything: it can only ever call off what is already
// running.
function cancelLaunch() {
  if (launchPanel.disabled || launchPanel.classList.contains('hidden')) return;

  cancelledAttempt = attempt;

  // Still ours. No report will come back from a launch that was never handed
  // over, so the screen clears itself rather than waiting for one.
  if (!handedOver) {
    hidePanel();
    return;
  }

  showPanel(t('launch.cancelling'), null, false);
  window.api.cancelLaunch();
}

// The whole panel is the button.
launchPanel.addEventListener('click', (event) => {
  event.stopPropagation();
  // Otherwise the tile keeps the keyboard afterwards, and Enter - which is
  // meant to start a game - would press this instead.
  launchPanel.blur();
  cancelLaunch();
});

// A failure takes over the whole window instead of arriving as a little grey
// box from the operating system. It is the launcher's own screen, in the
// launcher's own words, and it cannot be missed.
const bluescreen = document.getElementById('bluescreen');

const bluescreenAction = document.getElementById('bluescreen-action');

function showBluescreen(report) {
  document.getElementById('bluescreen-what').textContent = report.what || t('launch.failedTitle');
  document.getElementById('bluescreen-why').textContent = report.why || '';

  // The part for whoever is reading over the player's shoulder.
  const technical = document.getElementById('bluescreen-technical');
  const line = report.technical
    ? (report.code ? `${report.code}: ${report.technical}` : report.technical)
    : '';
  technical.textContent = line;
  technical.classList.toggle('hidden', !line);

  // Some failures have something worth doing about them, and the screen that
  // reports one is the right place to offer it.
  bluescreenAction.textContent = report.action || '';
  bluescreenAction.classList.toggle('hidden', !report.action);

  document.getElementById('bluescreen-continue').textContent = t('bluescreen.continue');
  bluescreen.classList.remove('hidden');
}

document.getElementById('bluescreen-continue').addEventListener('click', () => {
  bluescreen.classList.add('hidden');
});

bluescreenAction.addEventListener('click', async () => {
  bluescreen.classList.add('hidden');
  showPanel(t('launch.preparing'), null, true);
  await window.api.retryLaunch();
});

// The game died. It reads the same as a launch that never started, because to
// the person waiting to play it is the same thing.
window.api.onGameCrashed(report => {
  hidePanel();
  showBluescreen(report);
});

window.api.onLaunchProgress(progress => {
  if (progress.stage === 'failed' && progress.what) showBluescreen(progress);

  // The panel is up from the click until the game is over, so a report can
  // only ever change what it says - never whether it is there.
  if (progress.stage === 'preparing') showPanel(t('launch.preparing'), null, true);
  if (progress.stage === 'java') showPanel(t('launch.java'), null, true);
  if (progress.stage === 'loader') showPanel(t('launch.loader'), null, true);

  if (progress.stage === 'files') {
    const named = progress.type ? `${t('launch.files')} — ${progress.type}` : t('launch.files');
    showPanel(progress.total ? `${named} ${progress.done}/${progress.total}` : named,
      progress.total ? progress.done / progress.total : null, true);
  }

  // The game has spoken, but its window takes another half a minute to
  // appear. The panel stays: freeing the tile here is what let a second press
  // start a second game while the first was still on its way. Cancelling is
  // no longer offered, though - the game is running, and closing it from out
  // here would be taking someone out of a world.
  if (progress.stage === 'running') showPanel(t('launch.running'), 1, false);

  if (['ended', 'failed', 'cancelled'].includes(progress.stage)) hidePanel();
});

async function startLaunch() {
  // This starts games. Nothing else. While one is being started or played the
  // panel covers the tile, so it cannot be reached at all.
  if (playTile.classList.contains('hidden')) return;

  const mine = ++attempt;
  handedOver = false;
  showPanel(t('launch.preparing'), null, true);

  try {
    // A saved account first. Signing in on every click was never necessary -
    // the session simply was not being kept.
    const session = await window.api.getSession();
    if (cancelledAttempt === mine) return;

    // Nobody to play as yet. Opening the Microsoft window here would hide the
    // fact that an offline account is also an option, so the account list is
    // shown instead and both ways are on screen.
    if (!session.ok && session.reason === 'no-account') {
      window.location.href = 'settings.html#accounts';
      return;
    }

    // The saved sign-in went stale, which only happens to a Microsoft account.
    const profile = session.ok ? session.profile : await window.api.loginMicrosoft();
    if (cancelledAttempt === mine) return;

    // From here on the main process holds the launch and is the one to stop it.
    handedOver = true;
    const result = await window.api.launchGame(profile);

    // The reason is shown on the blue screen; here the panel simply comes
    // down and the play tile is itself again.
    if (!result.started) hidePanel();
  } catch (e) {
    // Closing the Microsoft window lands here, and so does a refusal from it.
    console.log('Launch did not start:', e.message);
    hidePanel();
  }
}

playTile.addEventListener('click', startLaunch);

// The tiles carry pictures of two keys, so those two keys had better do what
// the pictures say. Enter starts a game, Esc calls one off - and Esc also
// dismisses the blue screen, which is the one place it already means "away
// with this" to everyone.
window.addEventListener('keydown', (event) => {
  const bluescreenUp = !bluescreen.classList.contains('hidden');

  if (event.key === 'Escape') {
    event.preventDefault();
    if (bluescreenUp) bluescreen.classList.add('hidden');
    else cancelLaunch();
    return;
  }

  if (event.key === 'Enter' && !bluescreenUp) {
    event.preventDefault();
    startLaunch();
  }
});

// ------------------------------------------------------------- the player

// The character in three dimensions, turned by dragging. This machine runs
// with hardware acceleration off - the graphics process crashes on it - so the
// drawing is done in software; one figure of a dozen boxes is well within what
// that can manage.
let viewer = null;

// The figure gets the whole tile, drawn at the screen's own pixels and with
// its edges smoothed. Every attempt to make it cheaper by drawing fewer pixels
// was seen at once - a pale film over the character and staircases down every
// slope - and it is the best-looking thing on the screen. What it costs is
// real, so it can be switched off in the settings instead; half of it is not
// worth having.
function fitViewer() {
  if (!viewer) return;

  const tile = document.getElementById('tile-skin').getBoundingClientRect();
  // The whole tile, less a margin so the figure does not touch the edges.
  viewer.setSize(Math.max(80, tile.width - 36), Math.max(80, tile.height - 36));
}

// When the figure is worth drawing. Not while the game is in front or the
// launcher is minimised - that is work done for an empty room, and exactly
// when the machine has a game to run and needs everything it has. Not during
// a launch either: thousands of files are being fetched and checked, and the
// progress bar is there to show the launcher is alive.
function updateDrawing() {
  if (!viewer) return;

  const launching = !launchPanel.classList.contains('hidden');
  viewer.renderPaused = document.hidden || !document.hasFocus() || launching;
}

document.addEventListener('visibilitychange', updateDrawing);
window.addEventListener('focus', updateDrawing);
window.addEventListener('blur', updateDrawing);

async function showPlayer() {
  const player = await window.api.getPlayer();
  const settings = await window.api.getSettings();
  const name = document.getElementById('player-name');
  const canvas = document.getElementById('player-body');

  // Nobody signed in: the tile says so rather than standing empty. This is the
  // only time it carries words - a figure needs no caption, and the main
  // screen is meant to be pictures.
  if (!player || !player.image) {
    name.textContent = player ? player.name : t('player.nobody');
    name.classList.remove('hidden');
    canvas.classList.add('hidden');
    return;
  }

  // Turned off in the settings. Nothing is created, so nothing is drawn and
  // nothing is paid for. The tile is left empty on purpose - what stands there
  // instead is still to be decided; it opens the account list either way.
  if (settings.playerModel === false) {
    name.classList.add('hidden');
    canvas.classList.add('hidden');
    return;
  }

  name.classList.add('hidden');
  canvas.classList.remove('hidden');

  if (!viewer) {
    viewer = new skinview3d.SkinViewer({ canvas, width: 200, height: 260 });


    // Turning it is worth having; wheeling it closer and further is not, and
    // would only fight with the scroll on the page.
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;

    // Standing and breathing rather than posing: it is a launcher tile, not a
    // dance floor.
    viewer.animation = new skinview3d.IdleAnimation();
    viewer.zoom = 0.85;
  }

  await viewer.loadSkin(player.image, { model: player.model });
  if (player.cape) await viewer.loadCape(player.cape);
  else viewer.resetCape();

  fitViewer();
}

window.addEventListener('resize', fitViewer);

// Dragging the figure turns it, so a drag must not be taken for a click on the
// tile and send the player off to the account list.
let dragged = false;
document.getElementById('player-body').addEventListener('pointerdown', () => { dragged = false; });
document.getElementById('player-body').addEventListener('pointermove', (e) => {
  if (e.buttons) dragged = true;
});

// The tile is about who is playing, so it opens the list of accounts.
document.getElementById('tile-skin').addEventListener('click', () => {
  if (dragged) return;
  window.location.href = 'settings.html#accounts';
});

translationsReady.then(showPlayer);

document.getElementById('tile-folder').addEventListener('click', () => {
  window.api.openGameFolder();
});

document.getElementById('tile-settings').addEventListener('click', () => {
  window.location.href = 'settings.html';
});

document.getElementById('tile-mods').addEventListener('click', () => {
  window.location.href = 'mods.html';
});

const maxBtn = document.getElementById('btn-max');

function renderMaxIcon(isMaximized) {
  if (isMaximized) {
    maxBtn.innerHTML = `<svg width="10" height="10">
      <rect x="2" y="0.5" width="7" height="7" fill="none" stroke="black" stroke-width="1"/>
      <rect x="0.5" y="2.5" width="7" height="7" fill="white" stroke="black" stroke-width="1"/>
    </svg>`;
  } else {
    maxBtn.innerHTML = `<svg width="10" height="10">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="black" stroke-width="1"/>
    </svg>`;
  }
}

window.api.onWindowStateChange(renderMaxIcon);
window.api.isMaximized().then(renderMaxIcon);
