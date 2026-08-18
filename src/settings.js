document.getElementById('btn-back').addEventListener('click', () => {
  window.location.href = 'index.html';
});

document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

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

let settings = {};
let totalSystemRamMB = 8192;

async function loadSettingsUI() {
  settings = await window.api.getSettings();
  totalSystemRamMB = await window.api.getSystemRam();

  document.getElementById('current-version').textContent = settings.version;
  document.getElementById('current-gamefolder').textContent = settings.gameFolder;
  document.getElementById('current-language').textContent = settings.language.toUpperCase();
  renderTranslatedValues();

  const slider = document.getElementById('ram-slider');
  const number = document.getElementById('ram-number');
  const autoCheckbox = document.getElementById('ram-auto');

  slider.max = totalSystemRamMB;
  number.max = totalSystemRamMB;

  autoCheckbox.checked = settings.ramAuto;
  updateRamDisabledState();

  const effectiveRam = settings.ramAuto ? autoRamValue() : settings.ram;
  slider.value = effectiveRam;
  number.value = effectiveRam;

  document.getElementById('win-w').value = settings.windowWidth;
  document.getElementById('win-h').value = settings.windowHeight;
  document.getElementById('win-fullscreen').checked = settings.fullscreen;
  updateWindowSizeDisabledState();
}

// Values that are either user data or a translated placeholder.
// Redrawn on every language switch, hence a function of its own.
function renderTranslatedValues() {
  if (!settings.language) return;
  document.getElementById('current-account').textContent =
    settings.accountName || t('account.notSignedIn');
  document.getElementById('current-java').textContent =
    settings.javaPath || t('settings.javaAuto');
}

document.addEventListener('translations-applied', renderTranslatedValues);

function autoRamValue() {
  const half = Math.floor(totalSystemRamMB / 2);
  const capped = Math.min(half, totalSystemRamMB - 2048);
  const rounded = Math.max(1024, Math.round(capped / 512) * 512);
  return rounded;
}

function updateRamDisabledState() {
  const disabled = document.getElementById('ram-auto').checked;
  document.getElementById('ram-slider').disabled = disabled;
  document.getElementById('ram-number').disabled = disabled;
}

function updateWindowSizeDisabledState() {
  const disabled = document.getElementById('win-fullscreen').checked;
  document.getElementById('win-w').disabled = disabled;
  document.getElementById('win-h').disabled = disabled;
}

async function saveSettings() {
  await window.api.saveSettings(settings);
}

document.getElementById('ram-auto').addEventListener('change', async (e) => {
  settings.ramAuto = e.target.checked;
  updateRamDisabledState();
  if (settings.ramAuto) {
    const val = autoRamValue();
    document.getElementById('ram-slider').value = val;
    document.getElementById('ram-number').value = val;
    settings.ram = val;
  }
  await saveSettings();
});

document.getElementById('ram-slider').addEventListener('input', (e) => {
  document.getElementById('ram-number').value = e.target.value;
});

document.getElementById('ram-slider').addEventListener('change', async (e) => {
  settings.ram = parseInt(e.target.value, 10);
  await saveSettings();
});

document.getElementById('ram-number').addEventListener('change', async (e) => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val)) val = 1024;
  val = Math.min(Math.max(val, 1024), totalSystemRamMB);
  document.getElementById('ram-slider').value = val;
  settings.ram = val;
  await saveSettings();
});

document.getElementById('win-w').addEventListener('change', async (e) => {
  settings.windowWidth = parseInt(e.target.value, 10);
  await saveSettings();
});

document.getElementById('win-h').addEventListener('change', async (e) => {
  settings.windowHeight = parseInt(e.target.value, 10);
  await saveSettings();
});

document.getElementById('win-fullscreen').addEventListener('change', async (e) => {
  settings.fullscreen = e.target.checked;
  updateWindowSizeDisabledState();
  await saveSettings();
});

const overlay = document.getElementById('modal-overlay');
const modalBox = document.getElementById('modal-box');

function closeModal() {
  overlay.classList.add('hidden');
  modalBox.innerHTML = '';
}

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

// Order of the checkboxes in the version filter modal.
// The captions live in locales/*.json under filters.*
const versionFilterKeys = [
  'loadFromServer',
  'mods',
  'alpha',
  'experimental',
  'onlyInstalled',
  'snapshots',
  'beta',
  'launchers',
  'oldReleases'
];

document.getElementById('item-versions').addEventListener('click', () => {
  let rowsHtml = '';
  for (const key of versionFilterKeys) {
    const checked = settings.versionFilters[key] ? 'checked' : '';
    rowsHtml += `
      <label class="modal-checkbox-row">
        <input type="checkbox" data-key="${key}" ${checked}>
        ${t('filters.' + key)}
      </label>
    `;
  }

  modalBox.innerHTML = `
    <h3>${t('settings.showVersions')}</h3>
    ${rowsHtml}
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  overlay.classList.remove('hidden');

  modalBox.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      settings.versionFilters[cb.dataset.key] = cb.checked;
      await saveSettings();
    });
  });

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
});

document.getElementById('item-java').addEventListener('click', async () => {
  const javaPath = await window.api.pickJava();
  if (javaPath) {
    settings.javaPath = javaPath;
    document.getElementById('current-java').textContent = javaPath;
    await saveSettings();
  }
});

document.getElementById('item-gamefolder').addEventListener('click', async () => {
  const folder = await window.api.pickFolder();
  if (folder) {
    settings.gameFolder = folder;
    document.getElementById('current-gamefolder').textContent = folder;
    await saveSettings();
  }
});

document.getElementById('item-language').addEventListener('click', () => {
  modalBox.innerHTML = `
    <h3>${t('modal.language')}</h3>
    <div class="modal-lang-option" data-lang="ru">Русский</div>
    <div class="modal-lang-option" data-lang="en">English</div>
    <div class="modal-lang-option" data-lang="de">Deutsch</div>
  `;
  overlay.classList.remove('hidden');

  modalBox.querySelectorAll('.modal-lang-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      settings.language = opt.dataset.lang;
      document.getElementById('current-language').textContent = settings.language.toUpperCase();
      await changeLanguage(settings.language);
      await saveSettings();
      closeModal();
    });
  });
});

// Wait for the dictionary: the page draws captions through t().
translationsReady.then(loadSettingsUI);
