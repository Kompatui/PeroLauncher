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
let autoRamMB = 4096;

async function loadSettingsUI() {
  settings = await window.api.getSettings();
  const memory = await window.api.getSystemRam();
  totalSystemRamMB = memory.total;
  autoRamMB = memory.auto;

  document.getElementById('current-version').textContent = settings.version;
  document.getElementById('current-gamefolder').textContent = settings.gameFolder;
  document.getElementById('current-language').textContent = settings.language.toUpperCase();
  renderTranslatedValues();
  renderJarModsRow();

  const slider = document.getElementById('ram-slider');
  const number = document.getElementById('ram-number');
  const autoCheckbox = document.getElementById('ram-auto');

  // The slider counts 512 MiB steps rather than megabytes. Counting megabytes
  // with a step of 512 put the machine's real total out of reach - 8070 is not
  // 1024 plus a whole number of steps, so it stopped at 7680 and the last 390
  // could not be chosen at all. Steps keep the arrow keys moving by a round
  // amount, and the final one means "everything this machine has".
  slider.min = 2;
  slider.step = 1;
  slider.max = topStep();
  number.max = totalSystemRamMB;

  autoCheckbox.checked = settings.ramAuto;
  updateRamDisabledState();

  const effectiveRam = settings.ramAuto ? autoRamValue() : settings.ram;
  slider.value = ramToStep(effectiveRam);
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
  document.getElementById('current-ongamestart').textContent =
    t(ON_GAME_START_LABELS[settings.onGameStart] || 'onGameStart.minimize');
  document.getElementById('current-javaargs').textContent =
    settings.javaArgs || t('javaArgs.none');
  renderLoaderBadge();
}

document.addEventListener('translations-applied', renderTranslatedValues);

// Worked out by the launcher itself and simply shown here. Computing it a
// second time in this file is how the page and the game could have started
// disagreeing without anyone noticing.
function autoRamValue() {
  return autoRamMB;
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
    document.getElementById('ram-slider').value = ramToStep(val);
    document.getElementById('ram-number').value = val;
    settings.ram = val;
  }
  await saveSettings();
});

// The last position on the slider. Rounding up rather than down is what makes
// the machine's whole memory reachable when it is not a multiple of 512.
function topStep() {
  return Math.max(2, Math.ceil(totalSystemRamMB / 512));
}

function stepToRam(step) {
  return Math.min(step * 512, totalSystemRamMB);
}

function ramToStep(mb) {
  if (mb >= totalSystemRamMB) return topStep();
  return Math.min(Math.max(Math.round(mb / 512), 2), topStep());
}

document.getElementById('ram-slider').addEventListener('input', (e) => {
  document.getElementById('ram-number').value = stepToRam(parseInt(e.target.value, 10));
});

document.getElementById('ram-slider').addEventListener('change', async (e) => {
  settings.ram = stepToRam(parseInt(e.target.value, 10));
  await saveSettings();
});

document.getElementById('ram-number').addEventListener('change', async (e) => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val)) val = 1024;
  // Typed in by hand, so it is taken as given rather than rounded - only
  // held inside what the machine has.
  val = Math.min(Math.max(val, 1024), totalSystemRamMB);
  e.target.value = val;
  document.getElementById('ram-slider').value = ramToStep(val);
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
        // The loader must belong to this game version, so the old choice is
        // dropped and offered again - if there is anything to offer.
        settings.loader = 'vanilla';
        settings.loaderVersion = null;
        await saveSettings();
        await pickLoaderForVersion(settings.version);
      });
    });
  }

  search.addEventListener('input', renderList);
  renderList();
  search.focus();
});

// Everything about accounts lives behind one row, the same way the version and
// the loader do. The list is the whole feature: pick who plays, add someone,
// drop someone.
document.getElementById('row-account').addEventListener('click', () => openAccounts());

async function openAccounts(store) {
  const data = store || await window.api.getAccounts();
  const accounts = data.accounts;

  const rows = accounts.length
    ? accounts.map(account => `
        <div class="account-row${account.id === data.activeId ? ' current' : ''}" data-id="${account.id}">
          <span class="account-name">${escapeHtml(account.name)}</span>
          <span class="account-meta">
            ${account.id === data.activeId ? `<span class="account-active">${t('account.active')}</span>` : ''}
            <span class="account-type">${account.type === 'offline' ? t('account.typeOffline') : t('account.typeMicrosoft')}</span>
            <button class="account-remove" data-remove="${account.id}" title="${t('account.remove')}">×</button>
          </span>
        </div>
      `).join('')
    : `<p class="modal-note">${t('account.empty')}</p>`;

  modalBox.innerHTML = `
    <h3>${t('account.title')}</h3>
    <div class="account-list">${rows}</div>
    <div class="account-actions">
      <button class="modal-btn" id="add-microsoft">${t('account.addMicrosoft')}</button>
      <button class="modal-btn" id="add-offline">${t('account.addOffline')}</button>
    </div>
    ${closeButtonHtml()}
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  // Switching who plays.
  modalBox.querySelectorAll('.account-row').forEach(row => {
    row.addEventListener('click', async (event) => {
      if (event.target.dataset.remove) return;   // The × is its own action.
      const updated = await window.api.setActiveAccount(row.dataset.id);
      settings.accountName = accounts.find(a => a.id === row.dataset.id).name;
      renderTranslatedValues();
      openAccounts(updated);
    });
  });

  modalBox.querySelectorAll('.account-remove').forEach(button => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const updated = await window.api.removeAccount(button.dataset.remove);
      settings.accountName = updated.accounts.find(a => a.id === updated.activeId)?.name || null;
      renderTranslatedValues();
      openAccounts(updated);
    });
  });

  document.getElementById('add-microsoft').addEventListener('click', async () => {
    modalBox.innerHTML = `<h3>${t('account.title')}</h3><p class="modal-note">${t('account.signingIn')}</p>`;
    try {
      const profile = await window.api.loginMicrosoft();
      settings.accountName = profile.name;
      renderTranslatedValues();
      openAccounts();
    } catch (e) {
      // Closing the Microsoft window counts as a refusal, not a fault, so it
      // returns to the list instead of showing a failure over nothing.
      console.log('Microsoft sign-in did not complete:', e.message);
      openAccounts();
    }
  });

  document.getElementById('add-offline').addEventListener('click', openOfflineForm);
}

function openOfflineForm() {
  modalBox.innerHTML = `
    <h3>${t('account.offlineTitle')}</h3>
    <p class="modal-note explain">${t('account.offlineExplain')}</p>
    <input type="text" id="offline-name" class="modal-search" maxlength="16"
           placeholder="${t('account.namePlaceholder')}">
    <p class="modal-note warn hidden" id="offline-problem"></p>
    <div class="modal-buttons">
      <button class="modal-btn" id="offline-add">${t('account.add')}</button>
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  document.getElementById('modal-cancel').addEventListener('click', () => openAccounts());

  const field = document.getElementById('offline-name');
  const problem = document.getElementById('offline-problem');

  const PROBLEM_TEXT = {
    characters: 'account.nameBadCharacters',
    length: 'account.nameBadLength',
    exists: 'account.nameBadExists'
  };

  async function submit() {
    const result = await window.api.addOfflineAccount(field.value);
    if (!result.ok) {
      problem.textContent = t(PROBLEM_TEXT[result.reason] || 'account.signInFailed');
      problem.classList.remove('hidden');
      return;
    }
    settings.accountName = field.value.trim();
    renderTranslatedValues();
    openAccounts(result.store);
  }

  document.getElementById('offline-add').addEventListener('click', submit);
  field.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
  field.focus();
}

// Names come from the player and from Microsoft, and both end up inside markup.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

const MOD_LOADER_NAMES = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge'
};

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

// Step two of choosing a version. Every loader is asked what it really has for
// this game version, and only those with something to offer are shown - no
// entries that lead nowhere. When none of them support it, there is nothing to
// decide, so the step is skipped instead of wasting a click.
async function pickLoaderForVersion(mcVersion) {
  modalBox.innerHTML = `
    <h3>${t('loader.select')}</h3>
    <p class="modal-note">${t('loader.checking')}</p>
    ${closeButtonHtml()}
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  const available = await window.api.getAvailableLoaders(mcVersion);
  if (overlay.classList.contains('hidden')) return;

  if (available.length === 0) {
    closeModal();
    return;
  }

  modalBox.innerHTML = `
    <h3>${t('loader.select')}</h3>
    <p class="modal-note">${t('settings.version')}: ${mcVersion}</p>
    <div class="modal-lang-option current" data-loader="vanilla">${t('loader.vanilla')}</div>
    ${available.map(entry => `
      <div class="modal-lang-option" data-loader="${entry.id}">${MOD_LOADER_NAMES[entry.id]}</div>
    `).join('')}
    ${closeButtonHtml()}
  `;
  wireCloseButton();

  modalBox.querySelectorAll('.modal-lang-option').forEach(option => {
    option.addEventListener('click', async () => {
      const loaderId = option.dataset.loader;
      if (loaderId === 'vanilla') {
        settings.loader = 'vanilla';
        settings.loaderVersion = null;
        renderLoaderBadge();
        await saveSettings();
        closeModal();
        return;
      }
      // The builds arrived with the availability answer - no second request.
      pickLoaderBuild(loaderId, available.find(entry => entry.id === loaderId).versions);
    });
  });
}

function pickLoaderBuild(loaderId, builds) {
  const name = MOD_LOADER_NAMES[loaderId];

  modalBox.innerHTML = `
    <h3>${name} — ${t('loader.pickVersion')}</h3>
    <p class="modal-note">${t('settings.version')}: ${settings.version}</p>
    <div class="version-list" id="loader-list">
      ${builds.map(build => `
        <div class="version-row${build.version === settings.loaderVersion && settings.loader === loaderId ? ' current' : ''}"
             data-version="${build.version}">
          <span class="version-id">${build.version}</span>
          <span class="version-meta">${build.stable ? t('loader.stable') : ''}</span>
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
      settings.loader = loaderId;
      settings.loaderVersion = row.dataset.version;
      renderLoaderBadge();
      await saveSettings();
      closeModal();
    });
  });
}

// The orange badge is both the marker that a loader is in use and the way back
// into that choice, so it only exists while one is selected.
function renderLoaderBadge() {
  const badge = document.getElementById('edit-loader');
  const hasLoader = settings.loader && settings.loader !== 'vanilla';
  badge.classList.toggle('hidden', !hasLoader);
  if (hasLoader) {
    document.getElementById('current-loader').textContent =
      `${MOD_LOADER_NAMES[settings.loader]} ${settings.loaderVersion || ''}`.trim();
  }
}

document.getElementById('edit-loader').addEventListener('click', (e) => {
  // Otherwise the click also opens the version list behind it.
  e.stopPropagation();
  pickLoaderForVersion(settings.version);
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
    <p class="modal-note explain">${t('java.howItWorks')}</p>

    <div class="option-list">
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
    </div>
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

// Old versions take mods by having them pasted into the game jar. The folder
// is the whole interface: drop files in, they are applied in name order.
async function renderJarModsRow() {
  const status = await window.api.getJarMods();
  const value = document.getElementById('current-jarmods');

  if (!status.applies) {
    value.textContent = t('jarmods.notForThisVersion');
    return;
  }
  value.textContent = status.files.length
    ? status.files.join(', ')
    : t('jarmods.empty');
}

// The name alone invites the wrong folder: ordinary mods are .jar files too,
// and what tells these apart is not the extension but how they are installed.
// So the row explains itself before it opens anything.
document.getElementById('item-jarmods').addEventListener('click', () => {
  modalBox.innerHTML = `
    <h3>${t('settings.jarmods')}</h3>
    <p class="modal-note explain">${t('jarmods.hint')}</p>
    <div class="modal-buttons">
      <button class="modal-btn" id="jarmods-open">${t('jarmods.openFolder')}</button>
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  document.getElementById('jarmods-open').addEventListener('click', async () => {
    await window.api.openJarModsFolder();
    closeModal();
    // Reopening the page is not needed to see what was just added.
    setTimeout(renderJarModsRow, 1500);
  });
});

const ON_GAME_START_LABELS = {
  minimize: 'onGameStart.minimize',
  keep: 'onGameStart.keep',
  close: 'onGameStart.close'
};

document.getElementById('item-ongamestart').addEventListener('click', () => {
  const options = Object.keys(ON_GAME_START_LABELS).map(value => `
    <div class="modal-lang-option${settings.onGameStart === value ? ' current' : ''}"
         data-value="${value}">${t(ON_GAME_START_LABELS[value])}</div>
  `).join('');

  modalBox.innerHTML = `
    <h3>${t('settings.onGameStart')}</h3>
    ${options}
    ${closeButtonHtml()}
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  modalBox.querySelectorAll('.modal-lang-option').forEach(option => {
    option.addEventListener('click', async () => {
      settings.onGameStart = option.dataset.value;
      await saveSettings();
      renderTranslatedValues();
      closeModal();
    });
  });
});

// Every launcher lets these be typed in, and for the same reason: sooner or
// later a mod, a driver or a machine needs something nobody could have
// guessed in advance. What is typed goes on last and wins.
document.getElementById('item-javaargs').addEventListener('click', () => {
  modalBox.innerHTML = `
    <h3>${t('settings.javaArgs')}</h3>
    <p class="modal-note explain">${t('javaArgs.explain')}</p>
    <input type="text" id="java-args" class="modal-search"
           placeholder="${t('javaArgs.placeholder')}" value="${escapeHtml(settings.javaArgs || '')}">
    <div class="modal-buttons">
      <button class="modal-btn" id="java-args-save">${t('modal.save')}</button>
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  const field = document.getElementById('java-args');

  async function save() {
    settings.javaArgs = field.value.trim();
    await saveSettings();
    renderTranslatedValues();
    closeModal();
  }

  document.getElementById('java-args-save').addEventListener('click', save);
  field.addEventListener('keydown', event => { if (event.key === 'Enter') save(); });
  field.focus();
});

document.getElementById('item-logs').addEventListener('click', openCrashReportList);

// A crash report is the game explaining itself, but it opens in Notepad as a
// wall of stack traces. Read here instead, newest first, with the line that
// actually says what happened pulled to the front.
async function openCrashReportList() {
  modalBox.innerHTML = `
    <h3>${t('settings.logs')}</h3>
    <p class="modal-note">${t('crashes.loading')}</p>
    ${closeButtonHtml()}
  `;
  overlay.classList.remove('hidden');
  wireCloseButton();

  const reports = await window.api.listCrashReports();
  if (overlay.classList.contains('hidden')) return;

  if (!reports.length) {
    modalBox.innerHTML = `
      <h3>${t('settings.logs')}</h3>
      <p class="modal-note explain">${t('crashes.none')}</p>
      ${closeButtonHtml()}
    `;
    wireCloseButton();
    return;
  }

  modalBox.innerHTML = `
    <h3>${t('settings.logs')}</h3>
    <div class="version-list">
      ${reports.map(report => `
        <div class="version-row" data-id="${escapeHtml(report.id)}">
          <span class="version-id">${formatCrashTime(report.when)}</span>
          <span class="version-meta">
            <span class="version-installed">${report.kind === 'jvm' ? t('crashes.kindJvm') : t('crashes.kindGame')}</span>
          </span>
        </div>
      `).join('')}
    </div>
    <div class="modal-buttons">
      <button class="modal-btn" id="crashes-folder">${t('crashes.openFolder')}</button>
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  wireCloseButton();

  document.getElementById('crashes-folder').addEventListener('click', () => window.api.openCrashReports());

  modalBox.querySelectorAll('.version-row').forEach(row => {
    row.addEventListener('click', () => showCrashReport(row.dataset.id));
  });
}

async function showCrashReport(id) {
  const report = await window.api.readCrashReport(id);
  if (!report.ok) return openCrashReportList();

  modalBox.innerHTML = `
    <h3>${t('settings.logs')}</h3>
    ${report.headline ? `<p class="modal-note warn">${escapeHtml(report.headline)}</p>` : ''}
    <pre class="crash-text">${escapeHtml(report.text)}</pre>
    ${report.trimmed ? `<p class="modal-note">${t('crashes.trimmed')}</p>` : ''}
    <div class="modal-buttons">
      <button class="modal-btn" id="crash-back">${t('crashes.back')}</button>
      <button class="modal-btn" id="crash-reveal">${t('crashes.showFile')}</button>
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  wireCloseButton();

  document.getElementById('crash-back').addEventListener('click', openCrashReportList);
  document.getElementById('crash-reveal').addEventListener('click', () => window.api.revealCrashReport(id));
}

function formatCrashTime(iso) {
  const when = new Date(iso);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(when.getDate())}.${pad(when.getMonth() + 1)}.${when.getFullYear()} ` +
         `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

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
translationsReady.then(async () => {
  await loadSettingsUI();

  // Sent here by the play tile because there is nobody to play as. Opening
  // the list straight away saves the player hunting for the row that explains
  // why nothing happened.
  if (window.location.hash === '#accounts') openAccounts();
});
