async function applyTranslations() {
  const t = await window.api.getTranslations();
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t[key]) el.textContent = t[key];
  });
}

async function changeLanguage(lang) {
  await window.api.setLocale(lang);
  await applyTranslations();
}

window.addEventListener('DOMContentLoaded', applyTranslations);
