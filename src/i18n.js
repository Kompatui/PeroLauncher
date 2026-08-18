let translations = {};

// Returns a translated string for text built from JavaScript.
// Falls back to the key itself so a missing entry is visible instead of blank.
function t(key) {
  return translations[key] || key;
}

// Fills every [data-i18n] element, then lets pages redraw their dynamic text.
function renderTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[key]) el.textContent = translations[key];
  });
  document.dispatchEvent(new CustomEvent('translations-applied'));
}

async function changeLanguage(lang) {
  translations = await window.api.setLocale(lang);
  renderTranslations();
}

// Scripts sit at the end of <body>, so the DOM is ready by the time this runs.
// Pages wait on this promise before drawing anything that needs t().
const translationsReady = window.api.getTranslations().then(loaded => {
  translations = loaded;
  renderTranslations();
});
