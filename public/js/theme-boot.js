/* Applied before first paint so the saved skin never flashes the default theme. */
(function () {
  function isValidTheme(id) {
    return typeof id === 'string' && /^[a-z0-9-]+$/.test(id);
  }
  try {
    // Allow ArcVista to be mounted under a DSH route prefix (e.g. /arcvista/).
    var basePath = new URL('.', window.location.href).pathname.replace(/\/$/, '');
    window.__ARCVISTA_BASE__ = basePath;
    var params = new URLSearchParams(window.location.search);
    if (params.get('embed') === '1') document.documentElement.setAttribute('data-embed', '1');
    if (params.get('dsh') === '1') document.documentElement.setAttribute('data-dsh', '1');
    var queryTheme = params.get('theme');
    if (isValidTheme(queryTheme)) {
      document.documentElement.setAttribute('data-theme', queryTheme);
    } else {
      var saved = localStorage.getItem('arcvista.theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (error) {
    /* private mode / storage disabled */
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'arcvista:theme' || !isValidTheme(data.theme)) return;
    document.documentElement.setAttribute('data-theme', data.theme);
  });
})();
