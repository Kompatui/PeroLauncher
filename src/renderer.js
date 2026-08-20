document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

const playTile = document.getElementById('tile-play');
const launchPanel = document.getElementById('launch-panel');
const launchText = document.getElementById('launch-text');
const launchFill = document.getElementById('launch-fill');
const launchCross = document.getElementById('launch-cross');

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
  // the panel stops being a button - it is only telling you something then.
  launchCross.classList.toggle('hidden', !canCancel);
  launchPanel.classList.toggle('waiting', !canCancel);
  launchPanel.disabled = !canCancel;

  launchPanel.classList.remove('hidden');
}

function hidePanel() {
  launchPanel.classList.add('hidden');
}

// The whole panel is the button. Nothing here starts anything: it can only
// ever call off what is already running.
launchPanel.addEventListener('click', (event) => {
  event.stopPropagation();
  if (launchPanel.disabled) return;

  showPanel(t('launch.cancelling'), null, false);
  window.api.cancelLaunch();
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

playTile.addEventListener('click', async () => {
  // This tile starts games. Nothing else. While one is being started or
  // played the panel covers it, so this cannot be reached at all.
  showPanel(t('launch.preparing'), null, true);

  try {
    // A saved account first. Signing in on every click was never necessary -
    // the session simply was not being kept.
    const session = await window.api.getSession();

    // Nobody to play as yet. Opening the Microsoft window here would hide the
    // fact that an offline account is also an option, so the account list is
    // shown instead and both ways are on screen.
    if (!session.ok && session.reason === 'no-account') {
      window.location.href = 'settings.html#accounts';
      return;
    }

    // The saved sign-in went stale, which only happens to a Microsoft account.
    const profile = session.ok ? session.profile : await window.api.loginMicrosoft();

    const result = await window.api.launchGame(profile);

    // The reason is shown on the blue screen; here the panel simply comes
    // down and the play tile is itself again.
    if (!result.started) hidePanel();
  } catch (e) {
    // Closing the Microsoft window lands here, and so does a refusal from it.
    console.log('Launch did not start:', e.message);
    hidePanel();
  }
});

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
