/* ArcVista skins: persisted theme switching + picker UI. */

import { esc, icon, openModal, toast } from './dom.js';

export const THEMES = [
  {
    id: 'obsidian',
    name: '深空观测',
    mode: 'dark',
    tagline: '琥珀信号 · 墨蓝底',
    desc: '默认皮肤。夜航观测台的暖色信号与冷色结构。',
    swatches: ['#06090d', '#101823', '#ffb054', '#4fe3c1'],
  },
  {
    id: 'blueprint',
    name: '蓝图档案',
    mode: 'dark',
    tagline: '工程制图 · 电光青',
    desc: '深蓝图纸底色与青色标注，像一张会下钻的工程蓝图。',
    swatches: ['#04121d', '#0a2638', '#62d0ff', '#66f0c9'],
  },
  {
    id: 'parchment',
    name: '纸本手记',
    mode: 'light',
    tagline: '暖纸 · 朱砂',
    desc: '暖色纸面与朱砂批注，适合白天阅读与投屏演示。',
    swatches: ['#efe6d3', '#faf4e6', '#b5431f', '#3f7d5c'],
  },
  {
    id: 'neon',
    name: '午夜霓虹',
    mode: 'dark',
    tagline: '洋红脉冲 · 电光蓝',
    desc: '午夜机房里的霓虹信号，强对比的仪表盘气质。',
    swatches: ['#08040f', '#1a0f2b', '#ff5cc8', '#6ff7ff'],
  },
  {
    id: 'forest',
    name: '苔原深林',
    mode: 'dark',
    tagline: '苔绿 · 黄铜',
    desc: '低饱和墨绿与黄铜色，安静、耐看的长时段观测皮肤。',
    swatches: ['#06100c', '#0e211a', '#d8b36a', '#7fd6a8'],
  },
  {
    id: 'daylight',
    name: '日光实验室',
    mode: 'light',
    tagline: '冷灰 · 信号橙',
    desc: '清透的实验室日光，适合白天办公和截图归档。',
    swatches: ['#eef1f2', '#fbfcfc', '#d95f26', '#1f8f7a'],
  },
];

const STORAGE_KEY = 'arcvista.theme';

export function getStoredThemeId() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((theme) => theme.id === stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  return 'obsidian';
}

export function currentTheme() {
  const id = document.documentElement.dataset.theme || getStoredThemeId();
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}

let transitionTimer = null;
export function applyTheme(id, { persist = true, animate = true } = {}) {
  const theme = THEMES.find((item) => item.id === id) || THEMES[0];
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-transition');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 420);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
  try {
    if (persist) localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    /* ignore quota / privacy mode */
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.swatches[0]);
  document.querySelectorAll('[data-theme-picker]').forEach((button) => {
    button.setAttribute('title', `切换皮肤（当前：${theme.name}）`);
  });
  window.dispatchEvent(new CustomEvent('arcvista:theme', { detail: { id: theme.id, theme } }));
  return theme;
}

function queryThemeId() {
  try {
    const id = new URLSearchParams(window.location.search).get('theme');
    return THEMES.some((theme) => theme.id === id) ? id : null;
  } catch {
    return null;
  }
}

export function initTheme() {
  const theme = applyTheme(queryThemeId() || getStoredThemeId(), { persist: false, animate: false });
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'arcvista:theme' || typeof data.theme !== 'string') return;
    if (!THEMES.some((item) => item.id === data.theme)) return;
    applyTheme(data.theme, { persist: false, animate: false });
  });
  return theme;
}

export function themeGridHTML() {
  const active = currentTheme().id;
  return `<div class="theme-grid">${THEMES.map(
    (theme) => `
    <button type="button" class="theme-card ${theme.id === active ? 'is-active' : ''}" data-theme-id="${esc(theme.id)}" aria-pressed="${theme.id === active}">
      <span class="theme-preview" style="--tp-bg:${theme.swatches[0]};--tp-panel:${theme.swatches[1]};--tp-accent:${theme.swatches[2]};--tp-teal:${theme.swatches[3]}">
        <span class="tp-rail"></span>
        <span class="tp-title"></span>
        <span class="tp-panel"><i></i><i></i><i></i></span>
        <span class="tp-line"></span>
      </span>
      <span class="theme-meta">
        <span class="theme-name">${esc(theme.name)}</span>
        <span class="theme-tagline">${esc(theme.tagline)}</span>
        <span class="theme-mode">${theme.mode === 'light' ? '浅色' : '深色'} · ${esc(theme.desc)}</span>
      </span>
      <span class="theme-picked">${icon('check', 13)}</span>
    </button>`,
  ).join('')}</div>`;
}

export function mountThemeGrid(root, { onSelect = null } = {}) {
  if (!root) return () => {};
  const container = typeof root === 'string' ? document.querySelector(root) : root;
  if (!container) return () => {};
  const onClick = (event) => {
    const card = event.target.closest('.theme-card');
    if (!card) return;
    const theme = applyTheme(card.dataset.themeId, { persist: true });
    container.querySelectorAll('.theme-card').forEach((item) => {
      const active = item.dataset.themeId === theme.id;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    if (onSelect) onSelect(theme);
  };
  container.addEventListener('click', onClick);
  return () => container.removeEventListener('click', onClick);
}

export function openThemePicker() {
  const { close } = openModal({
    eyebrow: 'APPEARANCE · 外观',
    title: '选择观测台皮肤',
    width: '780px',
    body: `
      <p class="help" style="margin-bottom:14px">皮肤只改变界面配色，不影响任何分析结果。选择会保存在本地浏览器，下次打开自动生效。</p>
      <div id="theme-grid-host">${themeGridHTML()}</div>`,
    actions: [{ label: '完成', primary: true }],
    onMount: (modal) => {
      mountThemeGrid(modal.querySelector('#theme-grid-host'), {
        onSelect: (theme) => toast(`已切换皮肤：${theme.name}`, { detail: theme.tagline }),
      });
    },
  });
  return { close };
}
