document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

const playTile = document.getElementById('tile-play');

// A second click while the first is still working would start a second game.
// It also used to be the only way to find out the first had failed.
let launching = false;

// What the tile says while it works. Without this a click looked exactly like
// no click at all, for minutes, and the answer was to click again.
function showStatus(text, fraction) {
  let status = playTile.querySelector('.tile-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'tile-status';
    status.innerHTML = '<span class="tile-status-text"></span>' +
      '<span class="tile-status-bar"><span class="tile-status-fill"></span></span>';
    playTile.appendChild(status);
  }

  status.querySelector('.tile-status-text').textContent = text;
  const fill = status.querySelector('.tile-status-fill');
  fill.style.width = fraction === null ? '0' : `${Math.round(fraction * 100)}%`;
  status.classList.toggle('working', fraction === null);
}

function clearStatus() {
  playTile.querySelector('.tile-status')?.remove();
  playTile.querySelector('.tile-cancel')?.remove();
  playTile.classList.remove('busy');
}

// While it works the tile becomes the way to call it off. The arrow would be
// a lie at that point - pressing it again cannot start what is already
// starting, so it turns into the only thing left worth doing.
function showCancel() {
  playTile.classList.add('busy');
  if (playTile.querySelector('.tile-cancel')) return;

  const cross = document.createElement('div');
  cross.className = 'tile-cancel';
  cross.innerHTML = `<svg viewBox="0 0 48 48" width="64" height="64" aria-hidden="true">
      <line x1="10" y1="10" x2="38" y2="38" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
      <line x1="38" y1="10" x2="10" y2="38" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
    </svg>`;
  playTile.appendChild(cross);
}

// A failure takes over the whole window instead of arriving as a little grey
// box from the operating system. It is the launcher's own screen, in the
// launcher's own words, and it cannot be missed.
const bluescreen = document.getElementById('bluescreen');

function showBluescreen(progress) {
  document.getElementById('bluescreen-what').textContent = progress.what || t('launch.failedTitle');
  document.getElementById('bluescreen-why').textContent = progress.why || '';

  // The part for whoever is reading over the player's shoulder.
  const technical = document.getElementById('bluescreen-technical');
  technical.textContent = progress.technical ? `${progress.code}: ${progress.technical}` : '';
  technical.classList.toggle('hidden', !progress.technical);

  document.getElementById('bluescreen-continue').textContent = t('bluescreen.continue');
  bluescreen.classList.remove('hidden');
}

document.getElementById('bluescreen-continue').addEventListener('click', () => {
  bluescreen.classList.add('hidden');
});

window.api.onLaunchProgress(progress => {
  if (progress.stage === 'failed' && progress.what) showBluescreen(progress);

  // Reports from a launch that has been called off keep arriving for a while
  // - the work does not stop the instant the answer is given. Acting on them
  // redrew the bar on a tile that had gone back to normal, which left it
  // looking busy while behaving as if it were free: the next press started a
  // second game instead of stopping the first.
  if (!launching && !['cancelled', 'ended', 'failed'].includes(progress.stage)) return;
  if (progress.stage === 'preparing') showStatus(t('launch.preparing'), null);
  if (progress.stage === 'java') showStatus(t('launch.java'), null);
  if (progress.stage === 'loader') showStatus(t('launch.loader'), null);

  if (progress.stage === 'files') {
    const named = progress.type ? `${t('launch.files')} — ${progress.type}` : t('launch.files');
    showStatus(progress.total ? `${named} ${progress.done}/${progress.total}` : named,
      progress.total ? progress.done / progress.total : null);
  }

  // The game is up, or it is over: the launcher has nothing left to say.
  if (['running', 'ended', 'failed', 'cancelled'].includes(progress.stage)) {
    launching = false;
    clearStatus();
  }
});

playTile.addEventListener('click', async () => {
  // Busy means the tile is a stop button, not a dead one. The screen answers
  // straight away rather than waiting to be told it may: downloading happens
  // in the same process that handles this click, so a busy launcher can take
  // the better part of a minute to reply - and the player has already decided.
  if (launching) {
    launching = false;
    clearStatus();
    window.api.cancelLaunch();
    return;
  }

  launching = true;
  showCancel();
  showStatus(t('launch.preparing'), null);

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

    // The reason is shown by the launcher itself; here the tile just stops
    // pretending to work.
    if (!result.started) {
      launching = false;
      clearStatus();
    }
  } catch (e) {
    // Closing the Microsoft window lands here, and so does a refusal from it.
    console.log('Launch did not start:', e.message);
    launching = false;
    clearStatus();
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
