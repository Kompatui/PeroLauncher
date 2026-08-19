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
}

window.api.onLaunchProgress(progress => {
  if (progress.stage === 'preparing') showStatus(t('launch.preparing'), null);
  if (progress.stage === 'java') showStatus(t('launch.java'), null);
  if (progress.stage === 'loader') showStatus(t('launch.loader'), null);

  if (progress.stage === 'files') {
    const named = progress.type ? `${t('launch.files')} — ${progress.type}` : t('launch.files');
    showStatus(progress.total ? `${named} ${progress.done}/${progress.total}` : named,
      progress.total ? progress.done / progress.total : null);
  }

  // The game is up: the launcher has nothing left to say.
  if (progress.stage === 'running' || progress.stage === 'ended' || progress.stage === 'failed') {
    launching = false;
    clearStatus();
  }
});

playTile.addEventListener('click', async () => {
  if (launching) return;
  launching = true;
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
