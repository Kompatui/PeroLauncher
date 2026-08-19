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

  const mods = await window.api.listInstanceMods(id, 'mod');
  const resourcePacks = await window.api.listInstanceMods(id, 'resourcepack');
  const shaders = await window.api.listInstanceMods(id, 'shader');
  const isActive = store.activeId === id;
  const canHaveMods = pack.loader && pack.loader !== 'vanilla';

  // One list per kind, and a kind with nothing in it is not shown at all
  // rather than as an empty heading.
  const contentList = (items, heading, kind) => !items.length ? '' : `
    <h3 class="content-heading">${heading}</h3>
    <div class="mod-list">
      ${items.map(item => `
        <div class="mod-row">
          <span class="mod-main">
            <span class="mod-title">${escapeHtml(item.title)}</span>
            <span class="mod-file">${escapeHtml(item.filename)}</span>
          </span>
          <button class="mod-remove" data-file="${escapeHtml(item.filename)}" data-kind="${kind}"
                  title="${t('packs.removeMod')}">×</button>
        </div>
      `).join('')}
    </div>
  `;

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
      <button class="modal-btn" id="add-mods">${t('packs.addContent')}</button>
      <button class="modal-btn" id="open-folder">${t('packs.openFolder')}</button>
      <button class="modal-btn danger" id="delete-pack">${t('packs.delete')}</button>
    </div>

    ${canHaveMods ? '' : `<p class="modal-note explain">${t('packs.vanillaNoMods')}</p>`}

    <div id="content-lists">
      ${contentList(mods, t('packs.kindMods'), 'mod')}
      ${contentList(resourcePacks, t('packs.kindResourcePacks'), 'resourcepack')}
      ${contentList(shaders, t('packs.kindShaders'), 'shader')}
      ${mods.length || resourcePacks.length || shaders.length
        ? '' : `<p class="modal-note">${t('packs.nothingInPack')}</p>`}
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

  // A pack without a loader can still take texture packs, so the way in is
  // always open - it just opens on the kind that applies.
  document.getElementById('add-mods').addEventListener('click', () => {
    browseMods(pack, canHaveMods ? 'mod' : 'resourcepack');
  });

  page.querySelectorAll('.mod-remove').forEach(button => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.api.removeInstanceMod(id, button.dataset.file, button.dataset.kind);
      openPack(id);
    });
  });
}

// ------------------------------------------------------------ mod search

// Numbers the way a catalogue writes them: nobody reads 4831207.
function shortNumber(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(value ?? 0);
}

// Filled from Modrinth's own list of categories, per kind of content, so it
// cannot drift from the real one. Empty until it arrives.
let CATEGORIES = {};

// A slug the launcher knows becomes a word; one it does not is shown as it
// came, which is better than hiding a category we have never heard of.
function categoryName(slug) {
  const translated = t(`category.${slug}`);
  return translated === `category.${slug}` ? slug : translated;
}

function modCard(mod, alreadyIn) {
  return `
    <article class="mod-card" data-id="${escapeHtml(mod.id)}" data-source="${escapeHtml(mod.source)}">
      <header class="mod-card-head">
        ${mod.icon
          ? `<img class="mod-card-icon" src="${escapeHtml(mod.icon)}" alt="" loading="lazy">`
          : '<span class="mod-card-icon empty"></span>'}
        <div class="mod-card-naming">
          <h3 class="mod-card-title">${escapeHtml(mod.title)}</h3>
          ${mod.author ? `<span class="mod-card-author">${t('packs.by')} ${escapeHtml(mod.author)}</span>` : ''}
        </div>
      </header>

      <p class="mod-card-desc">${escapeHtml(mod.description)}</p>

      <div class="mod-card-tags">
        ${mod.categories.map(category => `<span class="mod-tag">${escapeHtml(categoryName(category))}</span>`).join('')}
      </div>

      <footer class="mod-card-foot">
        <span class="mod-card-stat"><b>${shortNumber(mod.downloads)}</b> ${t('packs.downloads')}</span>
        <button class="mod-install${alreadyIn ? ' done' : ''}" ${alreadyIn ? 'disabled' : ''}>
          ${alreadyIn ? t('packs.alreadyIn') : t('packs.install')}
        </button>
      </footer>
    </article>
  `;
}

// A page of its own rather than a dialog: a catalogue needs the whole window,
// and a box in the middle of the screen was cutting the list in half.
async function browseMods(pack, kind = 'mod') {
  if (!Object.keys(CATEGORIES).length) CATEGORIES = await window.api.getModCategories();

  const installed = await window.api.listInstanceMods(pack.id, kind);
  const have = new Set(installed.map(mod => mod.projectId).filter(Boolean));

  const modded = pack.loader && pack.loader !== 'vanilla';

  // A texture pack fits any loader, so a pack without one can still have them.
  // Shaders need a mod to render them, which is why they are only offered
  // where there is a loader to put that mod on.
  const kinds = [
    { id: 'mod', label: t('packs.kindMods'), only: modded },
    { id: 'resourcepack', label: t('packs.kindResourcePacks'), only: true },
    { id: 'shader', label: t('packs.kindShaders'), only: modded }
  ].filter(entry => entry.only);

  // Nothing renders shaders yet: say so and offer the missing piece, rather
  // than showing a catalogue of things that would do nothing once installed.
  if (kind === 'shader') {
    const support = await window.api.getShaderSupport(pack.id);
    if (!support.ready) {
      page.innerHTML = `
        <div class="browse-head">
          <button class="link-btn" id="to-pack">${t('packs.backToPack')}</button>
          <div class="browse-title"><h2>${t('packs.kindShaders')}</h2></div>
          <div class="kind-tabs">
            ${kinds.map(entry => `
              <button class="kind-tab${entry.id === kind ? ' current' : ''}" data-kind="${entry.id}">${entry.label}</button>
            `).join('')}
          </div>
        </div>
        <p class="modal-note explain">${t('packs.shadersNeedLoader').replace('%s', escapeHtml(support.name))}</p>
        <div class="pack-actions">
          <button class="modal-btn" id="get-shader-loader">${t('packs.installShaderLoader')} ${escapeHtml(support.name)}</button>
        </div>
      `;

      document.getElementById('to-pack').addEventListener('click', () => openPack(pack.id));
      page.querySelectorAll('.kind-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          if (tab.dataset.kind !== kind) browseMods(pack, tab.dataset.kind);
        });
      });

      const button = document.getElementById('get-shader-loader');
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = t('packs.installing');

        const result = await window.api.installMod(pack.id, 'modrinth', support.projectId, 'mod');
        if (result.ok && result.installed.some(entry => entry.ok)) return browseMods(pack, 'shader');

        button.textContent = t('packs.shaderLoaderFailed');
      });
      return;
    }
  }

  page.innerHTML = `
    <div class="browse-head">
      <button class="link-btn" id="to-pack">${t('packs.backToPack')}</button>
      <div class="browse-title">
        <h2>${t('packs.addContent')}</h2>
        <span class="browse-for">${escapeHtml(pack.name)} · ${escapeHtml(pack.version)} · ${escapeHtml(loaderLabel(pack))}</span>
      </div>

      <div class="kind-tabs">
        ${kinds.map(entry => `
          <button class="kind-tab${entry.id === kind ? ' current' : ''}" data-kind="${entry.id}">${entry.label}</button>
        `).join('')}
      </div>

      <input type="text" id="mod-search" class="browse-search" placeholder="${t('packs.searchPlaceholder')}">
      <p class="browse-hint">${kind === 'mod' ? t('packs.searchHint') : t('packs.searchHintPacks')}</p>
      ${kind === 'shader' ? `<p class="browse-hint">${t('packs.shadersHowTo')}</p>` : ''}
    </div>

    <div class="browse-body">
      <aside class="browse-filters">
        <div class="filters-head">
          <span class="filters-title">${t('packs.categories')}</span>
          <button class="link-btn hidden" id="clear-categories">${t('packs.clearCategories')}</button>
        </div>
        <div class="category-list">
          ${(CATEGORIES[kind] || []).map(slug => `
            <label class="category-row">
              <input type="checkbox" value="${escapeHtml(slug)}">
              <span>${escapeHtml(categoryName(slug))}</span>
            </label>
          `).join('')}
        </div>
      </aside>

      <div class="browse-results">
        <div class="mod-cards" id="mod-cards"><p class="modal-note">${t('packs.searching')}</p></div>
        <div class="browse-more" id="browse-more"></div>
      </div>
    </div>
  `;

  document.getElementById('to-pack').addEventListener('click', () => openPack(pack.id));

  page.querySelectorAll('.kind-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.kind !== kind) browseMods(pack, tab.dataset.kind);
    });
  });

  const field = document.getElementById('mod-search');
  const cards = document.getElementById('mod-cards');
  const more = document.getElementById('browse-more');
  const clear = document.getElementById('clear-categories');

  let round = 0;
  let shown = 0;
  let query = '';
  let chosen = [];

  function readCategories() {
    chosen = [...page.querySelectorAll('.category-row input:checked')].map(box => box.value);
    clear.classList.toggle('hidden', chosen.length === 0);
    load(0);
  }

  page.querySelectorAll('.category-row input').forEach(box => {
    box.addEventListener('change', readCategories);
  });

  clear.addEventListener('click', () => {
    page.querySelectorAll('.category-row input').forEach(box => { box.checked = false; });
    readCategories();
  });

  function wire(scope) {
    scope.querySelectorAll('.mod-card').forEach(card => {
      const button = card.querySelector('.mod-install');
      if (button.disabled) return;

      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = t('packs.installing');

        const result = await window.api.installMod(pack.id, card.dataset.source, card.dataset.id, kind);

        if (!result.ok) {
          button.textContent = t('packs.installFailed');
          button.classList.add('failed');
          return;
        }

        // Dependencies come along uninvited, so say how many actually landed.
        const extra = result.installed.filter(entry => entry.ok).length - 1;
        button.classList.add('done');
        button.textContent = extra > 0
          ? `${t('packs.installed')} +${extra}`
          : t('packs.installed');
      });
    });
  }

  async function load(offset) {
    const mine = ++round;
    if (!offset) cards.innerHTML = `<p class="modal-note">${t('packs.searching')}</p>`;
    more.innerHTML = '';

    const data = await window.api.searchMods(pack.id, query, offset, chosen, kind);
    if (mine !== round) return;

    if (data.error) {
      cards.innerHTML = `<p class="modal-note warn">${t('packs.searchFailed')}</p>`;
      return;
    }

    if (!data.mods.length && !offset) {
      cards.innerHTML = `<p class="modal-note">${t('packs.nothingFound')}</p>`;
      return;
    }

    const html = data.mods.map(mod => modCard(mod, have.has(mod.id))).join('');
    if (offset) cards.insertAdjacentHTML('beforeend', html);
    else cards.innerHTML = html;

    shown = offset + data.mods.length;
    wire(cards);

    if (shown < data.total) {
      more.innerHTML = `<button class="modal-btn" id="load-more">${t('packs.showMore')}</button>`;
      document.getElementById('load-more').addEventListener('click', () => load(shown));
    }
  }

  let typingTimer = null;
  field.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { query = field.value.trim(); load(0); }, 350);
  });

  field.focus();
  load(0);
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
