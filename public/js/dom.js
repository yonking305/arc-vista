/* Shared DOM helpers, formatters and micro-interactions. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setHTML(target, html) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = html;
  return node;
}

export function delegate(root, selector, eventName, handler) {
  const node = typeof root === 'string' ? $(root) : root;
  if (!node) return () => {};
  const listener = (event) => {
    const match = event.target.closest(selector);
    if (match && node.contains(match)) handler(event, match);
  };
  node.addEventListener(eventName, listener);
  return () => node.removeEventListener(eventName, listener);
}

export function on(target, eventName, handler, options) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return () => {};
  node.addEventListener(eventName, handler, options);
  return () => node.removeEventListener(eventName, handler, options);
}

export function fmtNum(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(value, digits = 1) {
  if (value === null || value === undefined) return '—';
  return `${fmtNum(value, digits)}%`;
}

export function fmtDelta(value, { unit = '', digits = 1, invert = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  const sign = number > 0 ? '+' : '';
  const tone = number === 0 ? 'flat' : (number > 0) !== invert ? 'up' : 'down';
  return `<span class="metric-delta ${tone}">${sign}${fmtNum(number, digits)}${unit}</span>`;
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString('zh-CN');
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scoreTone(score, { invert = false, max = 100 } = {}) {
  if (score === null || score === undefined) return 'na';
  const normalized = Number(score) / max;
  const value = invert ? 1 - normalized : normalized;
  if (value >= 0.75) return 'good';
  if (value >= 0.45) return 'warn';
  return 'bad';
}

export function toneColor(tone) {
  return { good: 'var(--teal)', warn: 'var(--amber)', bad: 'var(--red)', na: 'var(--text-faint)' }[tone] || 'var(--text-faint)';
}

export function levelLabel(level) {
  return { high: '高风险', medium: '中风险', low: '低风险', strong: '强', moderate: '中', weak: '弱', critical: '危险', severe: '严重' }[level] || level || '—';
}

export const ICONS = {
  logo: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" width="22" height="22"><circle cx="16" cy="16" r="10" opacity=".4"/><circle cx="16" cy="16" r="5.5" opacity=".75"/><circle cx="16" cy="16" r="1.8" fill="currentColor" stroke="none"/><path d="M16 2v5M16 25v5M2 16h5M25 16h5" opacity=".5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>`,
  compare: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 4v16M16 4v16M4 8h8M12 16h8"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>`,
  graph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="7" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.8 7.6l8.2 7.2M8.2 5.7l7.5.9M16.3 9l-3 6.8"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>`,
  pulse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>`,
  flask: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 3h6M10 3v6l-5 8a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 17l-5-8V3"/><path d="M8 14h8"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3l10 17H2L12 3z"/><path d="M12 9v5M12 17.5v.5"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="6.5"/><path d="M11 8v6M8 11h6M16 16l4 4"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="6.5"/><path d="M8 11h6M16 16l4 4"/></svg>`,
  fit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  dot: `<svg viewBox="0 0 8 8" width="8" height="8"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg>`,
  branch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M8 5.5c4 0 8 1 8 6"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>`,
  palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.5-.8 1.5-1.5 0-.6-.3-1-.6-1.4-.3-.4-.6-.9-.6-1.4 0-.9.7-1.6 1.6-1.6h1.6a4.5 4.5 0 0 0 4.5-4.5c0-3.8-3.8-6.6-8-6.6z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
};

export function icon(name, size = 14) {
  const svg = ICONS[name] || '';
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
}

/* ------------------------------------------------------------------ toast */

let toastSeq = 0;
export function toast(message, { type = 'success', detail = '', duration = 4200 } = {}) {
  const root = $('#toast-root');
  if (!root) return () => {};
  const id = `toast-${++toastSeq}`;
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' toast--error' : type === 'warn' ? ' toast--warn' : ''}`;
  node.id = id;
  node.innerHTML = `<div>${esc(message)}</div>${detail ? `<small>${esc(detail)}</small>` : ''}`;
  root.appendChild(node);
  const remove = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    node.style.transition = 'all .25s ease';
    setTimeout(() => node.remove(), 260);
  };
  const timer = setTimeout(remove, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

/* ------------------------------------------------------------------ modal */

export function openModal({ eyebrow = '', title = '', body = '', actions = [], width = '', onMount = null, dismissible = true, closeOnBackdrop = true }) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="${width ? `width:${width}` : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
          <h3>${esc(title)}</h3>
        </div>
        <button class="modal-close" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">${body}</div>
      ${actions.length ? '<div class="modal-foot"></div>' : ''}
    </div>`;
  const modal = backdrop.querySelector('.modal');
  const foot = backdrop.querySelector('.modal-foot');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && dismissible) close();
  };
  if (foot) {
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = `btn ${action.primary ? 'btn--primary' : action.danger ? 'btn--danger' : ''}`;
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        if (action.onClick) {
          const result = await action.onClick(close, modal);
          if (result === false) return;
        }
        if (action.close !== false) close();
      });
      foot.appendChild(button);
    }
  }
  backdrop.addEventListener('click', (event) => {
    // Forms opt out of backdrop-close so a stray click outside cannot discard input.
    if (event.target === backdrop && dismissible && closeOnBackdrop) close();
  });
  backdrop.querySelector('[data-close]')?.addEventListener('click', close);
  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  if (onMount) onMount(modal, close);
  setTimeout(() => modal.querySelector('input,textarea,select,button.btn--primary')?.focus(), 60);
  return { close, modal };
}

export function confirmDialog({ title = '确认操作', message = '', confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      eyebrow: 'CONFIRM',
      title,
      body: `<p class="dim" style="line-height:1.8">${esc(message)}</p>`,
      actions: [
        { label: '取消', onClick: () => resolve(false) },
        {
          label: confirmText,
          danger,
          onClick: () => {
            resolve(true);
          },
        },
      ],
    });
  });
}

/* ---------------------------------------------------------------- polling */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll(fn, { interval = 1200, signal, immediate = true } = {}) {
  let first = true;
  while (!signal?.aborted) {
    if (!first || immediate) {
      const result = await fn();
      if (result === false) return;
    }
    first = false;
    await sleep(interval);
  }
}
