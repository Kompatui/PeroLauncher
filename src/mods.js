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

const page = document.getElementById('page');
const overlay = document.getElementById('modal-overlay');
const modalBox = document.getElementById('modal-box');

const LOADER_NAMES = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

function closeModal() {
  overlay.classList.add('hidden');
  modalBox.innerHTML = '';
}

overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Names and descriptions come from strangers on the internet and end up inside
// markup here.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function loaderLabel(pack) {
  if (!pack.loader || pack.loader === 'vanilla') return t('loader.vanilla');
  return `${LOADER_NAMES[pack.loader] || pack.loader} ${pack.loaderVersion || ''}`.trim();
}

function countLabel(n) {
  return `${n} ${t('packs.modsCount')}`;
}

// ---------------------------------------------------------------- pack list

async function showPacks() {
  const store = await window.api.getInstances();

  const packs = store.instances.map(pack => `
    <div class="pack-row${pack.id === store.activeId ? ' current' : ''}" data-id="${escapeHtml(pack.id)}">
      <span class="pack-main">
        <span class="pack-name">${escapeHtml(pack.name)}</span>
        <span class="pack-meta">${escapeHtml(pack.version)} · ${escapeHtml(loaderLabel(pack))} · ${countLabel(pack.modCount)}</span>
      </span>
      ${pack.id === store.activeId ? `<span class="pack-badge">${t('packs.active')}</span>` : ''}
    </div>
  `).join('');

  page.innerHTML = `
    <div class="packs-head">
      <h2>${t('packs.title')}</h2>
      <p class="packs-note">${t('packs.explain')}</p>
    </div>

    <div class="pack-list">
      <div class="pack-row plain${store.activeId ? '' : ' current'}" data-id="">
        <span class="pack-main">
          <span class="pack-name">${t('packs.noPack')}</span>
          <span class="pack-meta">${t('packs.noPackHint')}</span>
        </span>
        ${store.activeId ? '' : `<span class="pack-badge">${t('packs.active')}</span>`}
      </div>
      ${packs}
    </div>

    <div class="pack-actions">
      <button class="modal-btn" id="create-pack">${t('packs.create')}</button>
    </div>
  `;

  document.getElementById('create-pack').addEventListener('click', createPack);

  page.querySelectorAll('.pack-row').forEach(row => {
    row.addEventListener('click', async () => {
      const id = row.dataset.id;
      // The plain path is chosen by selecting it, not by having no packs.
      if (!id) {
        await window.api.selectInstance(null);
        showPacks();
        return;
      }
      openPack(id);
    });
  });
}

// -------------------------------------------------------------- one pack

async function openPack(id) {
  const store = await window.api.getInstances();
  const pack = store.instances.find(entry => entry.id === id);
  if (!pack) return showPacks();

  const mods = await window.api.listInstanceMods(id);
  const isActive = store.activeId === id;
  const canHaveMods = pack.loader && pack.loader !== 'vanilla';

  page.innerHTML = `
    <div class="pack-head">
      <button class="link-btn" id="to-packs">${t('packs.backToList')}</button>
      <h2>${escapeHtml(pack.name)}</h2>
      <p class="packs-note">${escapeHtml(pack.version)} · ${escapeHtml(loaderLabel(pack))}</p>
    </div>

    <div class="pack-actions">
      <button class="modal-btn${isActive ? ' chosen' : ''}" id="use-pack" ${isActive ? 'disabled' : ''}>
        ${isActive ? t('packs.inUse') : t('packs.use')}
      </button>
      ${canHaveMods ? `<button class="modal-btn" id="add-mods">${t('packs.addMods')}</button>` : ''}
      <button class="modal-btn" id="open-folder">${t('packs.openFolder')}</button>
      <button class="modal-btn danger" id="delete-pack">${t('packs.delete')}</button>
    </div>

    ${canHaveMods ? '' : `<p class="modal-note explain">${t('packs.vanillaNoMods')}</p>`}

    <div class="mod-list" id="mod-list">
      ${mods.length ? mods.map(mod => `
        <div class="mod-row">
          <span class="mod-main">
            <span class="mod-title">${escapeHtml(mod.title)}</span>
            <span class="mod-file">${escapeHtml(mod.filename)}</span>
          </span>
          <button class="mod-remove" data-file="${escapeHtml(mod.filename)}" title="${t('packs.removeMod')}">×</button>
        </div>
      `).join('') : `<p class="modal-note">${canHaveMods ? t('packs.noMods') : ''}</p>`}
    </div>
  `;

  document.getElementById('to-packs').addEventListener('click', showPacks);
  document.getElementById('open-folder').addEventListener('click', () => window.api.openInstanceFolder(id));

  document.getElementById('delete-pack').addEventListener('click', async () => {
    const result = await window.api.deleteInstance(id);
    if (result.ok) showPacks();
  });

  if (!isActive) {
    document.getElementById('use-pack').addEventListener('click', async () => {
      await window.api.selectInstance(id);
      openPack(id);
    });
  }

  if (canHaveMods) {
    document.getElementById('add-mods').addEventListener('click', () => searchMods(pack));
  }

  page.querySelectorAll('.mod-remove').forEach(button => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.api.removeInstanceMod(id, button.dataset.file);
      openPack(id);
    });
  });
}

// ------------------------------------------------------------ mod search

async function searchMods(pack) {
  modalBox.innerHTML = `
    <h3>${t('packs.addMods')}</h3>
    <p class="modal-note">${escapeHtml(pack.version)} · ${escapeHtml(loaderLabel(pack))}</p>
    <input type="text" id="mod-search" class="modal-search" placeholder="${t('packs.searchPlaceholder')}">
    <div class="mod-results" id="mod-results"><p class="modal-note">${t('packs.searching')}</p></div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('modal-cancel').addEventListener('click', () => {
    closeModal();
    openPack(pack.id);   // Whatever was installed should be on screen.
  });

  const field = document.getElementById('mod-search');
  const results = document.getElementById('mod-results');

  let round = 0;

  async function run(query) {
    const mine = ++round;
    results.innerHTML = `<p class="modal-note">${t('packs.searching')}</p>`;

    const data = await window.api.searchMods(pack.id, query, 0);
    if (mine !== round || overlay.classList.contains('hidden')) return;

    if (data.error) {
      results.innerHTML = `<p class="modal-note warn">${t('packs.searchFailed')}</p>`;
      return;
    }

    if (!data.mods.length) {
      results.innerHTML = `<p class="modal-note">${t('packs.nothingFound')}</p>`;
      return;
    }

    results.innerHTML = data.mods.map(mod => `
      <div class="mod-hit" data-id="${escapeHtml(mod.id)}" data-source="${escapeHtml(mod.source)}">
        ${mod.icon ? `<img class="mod-icon" src="${escapeHtml(mod.icon)}" alt="">` : '<span class="mod-icon empty"></span>'}
        <span class="mod-hit-main">
          <span class="mod-title">${escapeHtml(mod.title)}</span>
          <span class="mod-desc">${escapeHtml(mod.description)}</span>
        </span>
        <button class="mod-install">${t('packs.install')}</button>
      </div>
    `).join('');

    results.querySelectorAll('.mod-hit').forEach(hit => {
      const button = hit.querySelector('.mod-install');
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = t('packs.installing');

        const result = await window.api.installMod(pack.id, hit.dataset.source, hit.dataset.id);

        if (!result.ok) {
          button.textContent = t('packs.installFailed');
          return;
        }

        // Dependencies come along uninvited, so say how many actually landed.
        const extra = result.installed.filter(entry => entry.ok).length - 1;
        button.textContent = extra > 0
          ? `${t('packs.installed')} +${extra}`
          : t('packs.installed');
      });
    });
  }

  let typingTimer = null;
  field.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => run(field.value.trim()), 350);
  });

  field.focus();
  run('');
}

// ------------------------------------------------------------ making one

function createPack() {
  modalBox.innerHTML = `
    <h3>${t('packs.create')}</h3>
    <p class="modal-note explain">${t('packs.createExplain')}</p>
    <input type="text" id="pack-name" class="modal-search" maxlength="40" placeholder="${t('packs.namePlaceholder')}">
    <p class="modal-note warn hidden" id="pack-problem"></p>
    <div class="modal-buttons">
      <button class="modal-btn" id="pack-next">${t('packs.next')}</button>
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  overlay.classList.remove('hidden');
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  const field = document.getElementById('pack-name');
  const problem = document.getElementById('pack-problem');

  function next() {
    const name = field.value.trim();
    if (!name) {
      problem.textContent = t('packs.nameNeeded');
      problem.classList.remove('hidden');
      return;
    }
    pickVersionForPack(name);
  }

  document.getElementById('pack-next').addEventListener('click', next);
  field.addEventListener('keydown', event => { if (event.key === 'Enter') next(); });
  field.focus();
}

async function pickVersionForPack(name) {
  modalBox.innerHTML = `
    <h3>${t('version.select')}</h3>
    <p class="modal-note">${t('version.loading')}</p>
  `;

  const data = await window.api.getVersions();
  if (overlay.classList.contains('hidden')) return;

  // Releases only. A pack is something to keep and add mods to, and mods are
  // not published for snapshots - offering them would be offering nothing.
  const versions = data.versions.filter(v => v.type === 'release');

  modalBox.innerHTML = `
    <h3>${t('version.select')}</h3>
    ${data.error ? `<p class="modal-note warn">${t('version.offlineCache')}</p>` : ''}
    <input type="text" id="version-search" class="modal-search" placeholder="${t('version.search')}">
    <div class="version-list" id="version-list"></div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  const listBox = document.getElementById('version-list');
  const search = document.getElementById('version-search');

  function draw() {
    const query = search.value.trim().toLowerCase();
    const shown = query ? versions.filter(v => v.id.toLowerCase().includes(query)) : versions;

    listBox.innerHTML = shown.length
      ? shown.map(v => `<div class="version-row" data-id="${escapeHtml(v.id)}"><span class="version-id">${escapeHtml(v.id)}</span></div>`).join('')
      : `<p class="modal-note">${t('version.empty')}</p>`;

    listBox.querySelectorAll('.version-row').forEach(row => {
      row.addEventListener('click', () => pickLoaderForPack(name, row.dataset.id));
    });
  }

  search.addEventListener('input', draw);
  draw();
  search.focus();
}

async function pickLoaderForPack(name, version) {
  modalBox.innerHTML = `
    <h3>${t('loader.select')}</h3>
    <p class="modal-note">${t('loader.checking')}</p>
  `;

  // Each entry is { id, versions } - the builds come back with the answer, so
  // choosing one needs no second trip to the network.
  const offered = await window.api.getAvailableLoaders(version);
  if (overlay.classList.contains('hidden')) return;

  modalBox.innerHTML = `
    <h3>${t('loader.select')}</h3>
    <p class="modal-note">${escapeHtml(version)}</p>
    <div class="option-list">
      ${offered.map(entry => `
        <div class="modal-lang-option" data-loader="${escapeHtml(entry.id)}">${LOADER_NAMES[entry.id] || entry.id}</div>
      `).join('')}
      <div class="modal-lang-option" data-loader="vanilla">${t('loader.vanilla')}</div>
    </div>
    <div class="modal-buttons">
      <button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button>
    </div>
  `;
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  modalBox.querySelectorAll('.modal-lang-option').forEach(option => {
    option.addEventListener('click', () => {
      const loader = option.dataset.loader;
      if (loader === 'vanilla') return finishPack({ name, version, loader: 'vanilla', loaderVersion: null });

      const entry = offered.find(item => item.id === loader);
      pickLoaderBuildForPack(name, version, loader, entry?.versions || []);
    });
  });
}

async function pickLoaderBuildForPack(name, version, loader, known) {
  modalBox.innerHTML = `
    <h3>${LOADER_NAMES[loader] || loader}</h3>
    <p class="modal-note">${t('loader.loading')}</p>
  `;

  let builds = known;
  if (!builds || !builds.length) {
    const answer = await window.api.getLoaderVersions(loader, version);
    builds = answer.versions || [];
  }
  if (overlay.classList.contains('hidden')) return;

  if (!builds.length) {
    modalBox.innerHTML = `
      <h3>${LOADER_NAMES[loader] || loader}</h3>
      <p class="modal-note warn">${t('loader.none')}</p>
      <div class="modal-buttons"><button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button></div>
    `;
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    return;
  }

  modalBox.innerHTML = `
    <h3>${LOADER_NAMES[loader] || loader} — ${t('loader.pickVersion')}</h3>
    <p class="modal-note">${escapeHtml(version)}</p>
    <div class="version-list">
      ${builds.map(build => `
        <div class="version-row" data-build="${escapeHtml(build.version)}">
          <span class="version-id">${escapeHtml(build.version)}</span>
          ${build.stable ? `<span class="version-meta"><span class="version-installed">${t('loader.stable')}</span></span>` : ''}
        </div>
      `).join('')}
    </div>
    <div class="modal-buttons"><button class="modal-btn-cancel" id="modal-cancel">${t('modal.close')}</button></div>
  `;
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  modalBox.querySelectorAll('.version-row').forEach(row => {
    row.addEventListener('click', () => finishPack({
      name, version, loader, loaderVersion: row.dataset.build
    }));
  });
}

async function finishPack(draft) {
  const result = await window.api.createInstance(draft);
  closeModal();
  if (result.ok) openPack(result.id);
  else showPacks();
}

translationsReady.then(showPacks);
