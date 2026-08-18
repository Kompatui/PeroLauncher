document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

document.getElementById('tile-play').addEventListener('click', async () => {
  const profile = await window.api.loginMicrosoft();
  console.log('Вошли как:', profile.name, profile.uuid);
  console.log('Запускаем игру...');
  await window.api.launchGame(profile);
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
