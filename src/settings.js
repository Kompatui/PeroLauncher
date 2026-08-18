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
  document.getElementById('current-loader').textContent = loaderSummary();
}

// "Fabric 0.19.3" when a loader is picked, the translated "none" otherwise.
function loaderSummary() {
  if (!settings.loader || settings.loader === 'vanilla') return t('loader.vanillaShort');
  const name = MOD_LOADERS.find(l => l.id === settings.loader)?.name || settings.loader;
  return settings.loaderVersion ? `${name} ${settings.loaderVersion}` : name;
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
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

// Mojang files its April Fools and one-off builds as ordinary snapshots
// (25w14craftmine, 24w14potato, 3D Shareware v1.34 and friends). They carry no
// common marker, so they are found the other way round: a snapshot whose name
// fits none of the regular patterns is an experiment.
// Only ever called for type === 'snapshot'.
function isExperimental(id) {
  const weeklySnapshot = /^\d{2}w\d{2}[a-z]$/.test(id);       // 24w33a
  const preRelease = /(-pre|-rc|pre-release)/i.test(id);      // 26.2-pre-6, 1.14 Pre-Release 1
  const numberedSnapshot = /-snapshot-\d+$/.test(id);         // 26.3-snapshot-9
  const plainNumber = /^\d+(\.\d+)*$/.test(id);               // 1.6.3
  return !weeklySnapshot && !preRelease && !numberedSnapshot && !plainNumber;
}

function versionTypeLabel(version) {
  if (version.custom) return t('version.typeCustom');
  if (version.type === 'old_alpha') return t('version.typeAlpha');
  if (version.type === 'old_beta') return t('version.typeBeta');
  if (version.type === 'snapshot') {
    return isExperimental(version.id) ? t('version.typeExperimental') : t('version.typeSnapshot');
  }
  return t('version.typeRelease');
}

function versionPassesFilters(version, filters, oldReleaseCutoff) {
  if (filters.onlyInstalled && !version.installed) return false;
  if (version.custom) return !!filters.mods;
  if (version.type === 'old_alpha') return !!filters.alpha;
  if (version.type === 'old_beta') return !!filters.beta;
  if (version.type === 'snapshot') {
    return isExperimental(version.id) ? !!filters.experimental : !!filters.snapshots;
  }
  if (version.type === 'release' && oldReleaseCutoff && version.releaseTime) {
    const isOld = new Date(version.releaseTime) < new Date(oldReleaseCutoff);
    if (isOld) return !!filters.oldReleases;
  }
  return true;
}

document.getElementById('row-version').addEventListener('click', async () => {
  modalBox.innerHTML = `
    <h3>${t('version.select')}</h3>
    <p class="modal-note">${t('version.loading')}</p>
  `;
  overlay.classList.remove('hidden');

  const data = await window.api.getVersions();

  // The overlay may have been dismissed while the list was loading.
  if (overlay.classList.contains('hidden')) return;

  let notice = '';
  if (data.error && data.source === 'cache') notice = t('version.offlineCache');
  if (data.error && data.source !== 'cache') notice = t('version.offlineNoCache');

  modalBox.innerHTML = `
    <h3>${t('version.select')}</h3>
    ${notice ? `<p class="modal-note warn">${notice}</p>` : ''}
    <input type="text" id="version-search" class="modal-search" placeholder="${t('version.search')}">
    <div class="version-list" id="version-list"></div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;

  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  const listBox = document.getElementById('version-list');
  const search = document.getElementById('version-search');

  const visible = data.versions.filter(v =>
    versionPassesFilters(v, settings.versionFilters, data.oldReleaseCutoff)
  );

  function renderList() {
    const query = search.value.trim().toLowerCase();
    const matched = query
      ? visible.filter(v => v.id.toLowerCase().includes(query))
      : visible;

    if (matched.length === 0) {
      listBox.innerHTML = `<p class="modal-note">${t('version.empty')}</p>`;
      return;
    }

    listBox.innerHTML = matched.map(v => `
      <div class="version-row${v.id === settings.version ? ' current' : ''}" data-id="${v.id}">
        <span class="version-id">${v.id}</span>
        <span class="version-meta">
          ${v.installed ? `<span class="version-installed">${t('version.installed')}</span>` : ''}
          ${versionTypeLabel(v)}
        </span>
      </div>
    `).join('');

    listBox.querySelectorAll('.version-row').forEach(row => {
      row.addEventListener('click', async () => {
        settings.version = row.dataset.id;
        document.getElementById('current-version').textContent = settings.version;
        await saveSettings();
        closeModal();
      });
    });
  }

  search.addEventListener('input', renderList);
  renderList();
  search.focus();
});

// Loaders are added one at a time; `ready: false` ones are listed but not
// selectable yet, so the picker shows the whole picture instead of hiding it.
const MOD_LOADERS = [
  { id: 'fabric', name: 'Fabric', ready: true },
  { id: 'quilt', name: 'Quilt', ready: true },
  { id: 'forge', name: 'Forge', ready: true },
  { id: 'neoforge', name: 'NeoForge', ready: true }
];

function closeButtonHtml() {
  return `
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
}

function wireCloseButton() {
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
}

async function pickLoaderVersion(loader) {
  modalBox.innerHTML = `
    <h3>${loader.name}</h3>
    <p class="modal-note">${t('loader.loading')}</p>
    ${closeButtonHtml()}
  `;
  wireCloseButton();

  const data = await window.api.getLoaderVersions(loader.id, settings.version);
  if (overlay.classList.contains('hidden')) return;

  if (data.error || data.versions.length === 0) {
    modalBox.innerHTML = `
      <h3>${loader.name}</h3>
      <p class="modal-note warn">${t('loader.unsupported')}</p>
      ${closeButtonHtml()}
    `;
    wireCloseButton();
    return;
  }

  modalBox.innerHTML = `
    <h3>${loader.name} — ${t('loader.pickVersion')}</h3>
    <p class="modal-note">${t('settings.version')}: ${settings.version}</p>
    <div class="version-list" id="loader-list">
      ${data.versions.map(v => `
        <div class="version-row${v.version === settings.loaderVersion && settings.loader === loader.id ? ' current' : ''}" data-version="${v.version}">
          <span class="version-id">${v.version}</span>
          <span class="version-meta">${v.stable ? t('loader.stable') : ''}</span>
        </div>
      `).join('')}
    </div>
    ${closeButtonHtml()}
  `;
  wireCloseButton();

  document.getElementById('loader-list').querySelectorAll('.version-row').forEach(row => {
    row.addEventListener('click', async () => {
      // Only remembers the choice. The profile is fetched when the game is
      // actually launched, so browsing loaders leaves nothing on disk.
      settings.loader = loader.id;
      settings.loaderVersion = row.dataset.version;
      document.getElementById('current-loader').textContent = loaderSummary();
      await saveSettings();
      closeModal();
    });
  });
}

document.getElementById('row-loader').addEventListener('click', () => {
  const isVanilla = !settings.loader || settings.loader === 'vanilla';

  modalBox.innerHTML = `
    <h3>${t('loader.select')}</h3>
    <div class="modal-lang-option${isVanilla ? ' current' : ''}" data-loader="vanilla">
      ${t('loader.vanilla')}
    </div>
    ${MOD_LOADERS.map(l => `
      <div class="modal-lang-option${l.ready ? '' : ' disabled'}${settings.loader === l.id ? ' current' : ''}"
           data-loader="${l.ready ? l.id : ''}">
        ${l.name}${l.ready ? '' : ` <span class="loader-soon">${t('loader.soon')}</span>`}
      </div>
    `).join('')}
    ${closeButtonHtml()}
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  modalBox.querySelectorAll('.modal-lang-option').forEach(option => {
    const loaderId = option.dataset.loader;
    if (!loaderId) return;

    option.addEventListener('click', async () => {
      if (loaderId === 'vanilla') {
        settings.loader = 'vanilla';
        settings.loaderVersion = null;
        document.getElementById('current-loader').textContent = loaderSummary();
        await saveSettings();
        closeModal();
        return;
      }
      await pickLoaderVersion(MOD_LOADERS.find(l => l.id === loaderId));
    });
  });
});

document.getElementById('item-java').addEventListener('click', async () => {
  modalBox.innerHTML = `
    <h3>${t('settings.java')}</h3>
    <p class="modal-note">${t('java.checking')}</p>
    ${closeButtonHtml()}
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  const status = await window.api.getJavaStatus(settings.version);
  if (overlay.classList.contains('hidden')) return;

  const isAuto = !settings.javaPath;
  const autoHint = status.matched
    ? `${t('java.foundInSystem')} — Java ${status.required}`
    : `${t('java.willDownload')} — Java ${status.required}`;

  modalBox.innerHTML = `
    <h3>${t('settings.java')}</h3>
    <p class="modal-note">${t('java.requiredFor')} ${settings.version}: Java ${status.required ?? '?'}</p>

    <div class="modal-lang-option${isAuto ? ' current' : ''}" data-java="auto">
      ${t('settings.javaAuto')}
      <div class="java-hint">${autoHint}</div>
    </div>

    ${status.installed.map(java => `
      <div class="modal-lang-option${settings.javaPath === java.path ? ' current' : ''}" data-java="${java.path}">
        Java ${java.major}${java.downloaded ? ` <span class="loader-soon">${t('java.downloadedByLauncher')}</span>` : ''}
        <div class="java-hint">${java.path}</div>
      </div>
    `).join('')}

    <div class="modal-lang-option" data-java="browse">${t('java.browse')}</div>
    ${closeButtonHtml()}
  `;
  wireCloseButton();

  modalBox.querySelectorAll('.modal-lang-option').forEach(option => {
    option.addEventListener('click', async () => {
      const choice = option.dataset.java;

      if (choice === 'browse') {
        const picked = await window.api.pickJava();
        if (!picked) return;
        settings.javaPath = picked;
      } else {
        settings.javaPath = choice === 'auto' ? null : choice;
      }

      renderTranslatedValues();
      await saveSettings();
      closeModal();
    });
  });
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
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('modal-cancel').addEventListener('click', closeModal);

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
