document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

document.getElementById('tile-play').addEventListener('click', async () => {
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

  console.log('Signed in as:', profile.name, profile.uuid);
  console.log('Launching the game...');
  const result = await window.api.launchGame(profile);
  if (!result.started) console.error('Launch failed:', result.error);
});

document.getElementById('tile-folder').addEventListener('click', () => {
  window.api.openGameFolder();
});

document.getElementById('tile-settings').addEventListener('click', () => {
  window.location.href = 'settings.html';
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
