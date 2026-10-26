/*
 * Runs before the app, in old-style JavaScript so that even old browsers can run it. If the browser lacks what the
 * app needs (it is built for browsers from 2022 on: Chrome and Edge 98+, Firefox 94+, Safari 15.4+), show a short
 * message instead of a blank page, and tell the app not to start (see src/main.tsx).
 */
(function () {
  var ok =
    typeof Array.prototype.at === 'function' &&
    typeof Object.hasOwn === 'function' &&
    typeof window.structuredClone === 'function' &&
    typeof Promise.allSettled === 'function' &&
    'noModule' in document.createElement('script');
  if (ok) return;
  window.__pagewrightUnsupported = true;
  var show = function () {
    var root = document.getElementById('root');
    if (!root) return;
    root.innerHTML =
      '<div role="alert" style="max-width:440px;margin:15vh auto 0;padding:0 16px;font:15px/1.5 system-ui,sans-serif;color:#1c1f26;text-align:center">' +
      '<h1 style="font-size:22px;margin:0 0 8px">Pagewright PDF needs a newer browser</h1>' +
      '<p style="margin:0">Please update your browser, or open this page in a current version of Chrome, Edge, Firefox or Safari.</p>' +
      '</div>';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
