/* ArcVista shell + hash router. */

import { api } from './api.js';
import { $, icon, toast } from './dom.js';
import { initTheme, openThemePicker } from './theme.js';
import { renderProducts } from './pages/products.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderCompare } from './pages/compare.js';
import { renderSettings } from './pages/settings.js';

const appEl = document.getElementById('app');
const state = { health: null, products: [] };
let dispose = null;
let booted = false;

function rail() {
  return `
    <aside class="app-rail">
      <a class="rail-logo" href="#/" title="ArcVista 首页" aria-label="ArcVista 首页">${icon('logo', 24)}</a>
      <div class="rail-word">ArcVista · 架构观测台</div>
      <div class="rail-spacer"></div>
      <button class="rail-btn" data-theme-picker type="button" title="切换皮肤" aria-label="切换皮肤">${icon('palette', 18)}</button>
      <a class="rail-btn" href="#/settings" title="模型设置" aria-label="模型设置">${icon('settings', 18)}</a>
      <span class="rail-status" title="本地服务在线"></span>
    </aside>`;
}

function pageError(error) {
  const unreachable = /Failed to fetch|NetworkError|load failed/i.test(String(error?.message));
  return `
    <div class="page page--narrow">
      <div class="masthead">
        <div>
          <div class="eyebrow">CONNECTION LOST</div>
          <h1 class="page-title">观测台<em>离线</em></h1>
          <p class="page-sub">${unreachable ? '无法连接本地 ArcVista 服务。请在项目目录执行 <span class="mono">npm start</span> 后刷新页面。' : '页面渲染失败，请查看服务端日志或重试。'}</p>
        </div>
      </div>
      <div class="panel"><div class="panel-body">
        <div class="mono faint" style="word-break:break-all;line-height:1.8">${String(error?.message || error)}</div>
        <div class="row mt-16"><button class="btn btn--primary" id="reload-app">重新加载</button></div>
      </div></div>
    </div>`;
}

function parseRoute() {
  const hash = location.hash || '#/';
  const [pathPart, queryPart] = hash.replace(/^#/, '').split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart || '');
  if (segments[0] === 'settings') return { name: 'settings', params };
  if (segments[0] === 'p' && segments[1]) {
    if (segments[2] === 'compare') return { name: 'compare', id: decodeURIComponent(segments[1]), params };
    return {
      name: 'dashboard',
      id: decodeURIComponent(segments[1]),
      tab: params.get('tab') || 'architecture',
      params,
    };
  }
  return { name: 'products', params };
}

export function navigate(path) {
  if (`#${path}` === location.hash) return;
  location.hash = path;
}

async function renderRoute() {
  if (typeof dispose === 'function') {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  dispose = null;
  if (!location.hash) {
    history.replaceState(null, '', '#/');
  }
  const route = parseRoute();
  const existingMain = document.getElementById('main');
  if (!existingMain) return;
  // Replace the container on every route so delegated listeners from the previous
  // page cannot stack up (which otherwise could submit the same analysis twice).
  const main = existingMain.cloneNode(false);
  existingMain.replaceWith(main);
  main.innerHTML = `
    <div class="page page--narrow" style="padding-top:120px">
      <div class="row" style="justify-content:center;color:var(--text-faint)">
        <span class="spinner"></span><span class="mono" style="letter-spacing:.15em">LOADING OBSERVATORY</span>
      </div>
    </div>`;
  try {
    const page =
      route.name === 'dashboard'
        ? renderDashboard
        : route.name === 'compare'
          ? renderCompare
          : route.name === 'settings'
            ? renderSettings
            : renderProducts;
    const result = await page(main, { route, navigate, state, reload: renderRoute });
    dispose = result?.dispose || null;
  } catch (error) {
    console.error('[arcvista] route error', error);
    main.innerHTML = pageError(error);
    $('#reload-app')?.addEventListener('click', () => location.reload());
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function shell() {
  appEl.innerHTML = `<div class="app-shell">${rail()}<main class="app-main" id="main"></main></div>`;
}

async function boot() {
  if (booted) return;
  booted = true;
  initTheme();
  shell();
  window.addEventListener('hashchange', renderRoute);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-theme-picker]')) {
      event.preventDefault();
      openThemePicker();
    }
  });
  api
    .health()
    .then((health) => {
      state.health = health;
      state.products = [];
    })
    .catch(() => {
      toast('无法连接 ArcVista 服务', { type: 'error', detail: '请确认 npm start 正在运行' });
    });
  await renderRoute();
}

boot();

export { state };
