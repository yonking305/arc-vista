/* ArcVista workspace panel: sidebar entry + embedded local ArcVista application. */
window.__ModuleLoader__.load({
  id: 'dsh-arcvista',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PANEL_ID = 'arcvista';
    const ARCVISTA_URL = '/arcvista';

    const zh = {
      panel: 'ArcVista 架构观测台',
      title: 'ArcVista',
      connected: '已连接',
      checking: '检测中',
      offline: '未连接',
      reload: '刷新',
      open: '在浏览器打开',
      loading: '正在连接 ArcVista…',
      offlineTitle: 'ArcVista 插件后端未就绪',
      offlineHint: 'ArcVista 现在运行在 DSH 进程内，不需要启动本地 Node。如果看到这个状态，通常需要重启 DSH 让新版本插件加载。',
      command: '重启 DSH 以加载 ArcVista 插件',
      retry: '重新检测',
      tip: '也可以在浏览器中打开完整窗口。',
    };
    const en = {
      panel: 'ArcVista Observatory',
      title: 'ArcVista',
      connected: 'Connected',
      checking: 'Checking',
      offline: 'Offline',
      reload: 'Reload',
      open: 'Open in browser',
      loading: 'Connecting to ArcVista…',
      offlineTitle: 'ArcVista plugin backend is not ready',
      offlineHint: 'ArcVista now runs inside the DSH host process. If you see this state, restart DSH to load the updated plugin.',
      command: 'Restart DSH to load the ArcVista plugin',
      retry: 'Check again',
      tip: 'You can also open the full window in your browser.',
    };

    const CSS = `
      .as-root { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
      .as-head { flex: none; height: 46px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
      .as-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .as-brand-icon { color: var(--dsw-alias-brand-primary); display: flex; flex: none; }
      .as-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; color: var(--dsw-alias-label-primary); white-space: nowrap; }
      .as-status { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 20px; color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }
      .as-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); display: block; }
      .as-status--online { color: var(--dsw-alias-state-success-primary); }
      .as-status--online i { background: var(--dsw-alias-state-success-primary); }
      .as-status--checking i { background: var(--dsw-alias-state-warn-primary); }
      .as-status--offline { color: var(--dsw-alias-state-error-primary); }
      .as-status--offline i { background: var(--dsw-alias-state-error-primary); }
      .as-spacer { flex: 1; min-width: 0; }
      .as-head-btn { height: 28px; padding: 0 10px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
      .as-head-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .as-body { position: relative; flex: 1; min-height: 0; background: var(--dsw-alias-bg-layer-1); }
      .as-frame { width: 100%; height: 100%; border: 0; display: block; background: var(--dsw-alias-bg-base); }
      .as-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--dsw-alias-label-tertiary); font-size: 12px; background: var(--dsw-alias-bg-base); }
      .as-spinner { width: 18px; height: 18px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: as-spin .9s linear infinite; }
      @keyframes as-spin { to { transform: rotate(360deg); } }
      .as-offline { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 32px; gap: 8px; }
      .as-offline-icon { color: var(--dsw-alias-brand-primary); opacity: .75; margin-bottom: 6px; }
      .as-offline h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .as-offline p { margin: 0; max-width: 440px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.7; }
      .as-command { margin: 8px 0 4px; padding: 10px 14px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
      .as-offline-actions { display: flex; gap: 8px; margin-top: 6px; }
      .as-primary { height: 30px; padding: 0 14px; border: none; border-radius: 7px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
      .as-secondary { height: 30px; padding: 0 14px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
      .as-secondary:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .as-tip { color: var(--dsw-alias-label-caption); font-size: 11px; }
    `;

    function ScopeGlyph({ size = 20 }) {
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true, fill: 'none' },
        h('circle', { cx: 32, cy: 32, r: 20, stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.35 }),
        h('circle', { cx: 32, cy: 32, r: 12, stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.7 }),
        h('circle', { cx: 32, cy: 32, r: 4.2, fill: 'currentColor' }),
        h('path', { d: 'M32 6v8M32 50v8M6 32h8M50 32h8', stroke: 'currentColor', strokeWidth: 2.2, opacity: 0.55 }),
      );
    }

    function useThemeScheme(getTheme, themeListeners) {
      const [scheme, setScheme] = useState(() => {
        try {
          return getTheme()?.active?.colorScheme || 'dark';
        } catch {
          return 'dark';
        }
      });
      useEffect(() => {
        const read = () => {
          try {
            setScheme(getTheme()?.active?.colorScheme || 'dark');
          } catch {
            /* keep current */
          }
        };
        themeListeners.add(read);
        read();
        return () => themeListeners.delete(read);
      }, [getTheme, themeListeners]);
      return scheme;
    }

    function ArchscopePanel({ t, getTheme, themeListeners }) {
      const scheme = useThemeScheme(getTheme, themeListeners);
      const archTheme = scheme === 'light' ? 'daylight' : 'obsidian';
      const [frameKey, setFrameKey] = useState(0);
      const [loaded, setLoaded] = useState(false);
      const [status, setStatus] = useState('checking');
      const frameRef = useRef(null);
      const initialTheme = useRef(archTheme);

      useEffect(() => {
        let alive = true;
        const check = async () => {
          try {
            const response = await fetch(`${ARCVISTA_URL}/api/health`, { cache: 'no-store' });
            if (alive) setStatus(response.ok ? 'online' : 'offline');
          } catch {
            if (alive) setStatus('offline');
          }
        };
        check();
        const timer = setInterval(check, 8000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [frameKey]);

      useEffect(() => {
        const frame = frameRef.current;
        if (!frame || !frame.contentWindow) return;
        try {
          frame.contentWindow.postMessage({ type: 'arcvista:theme', theme: archTheme }, window.location.origin);
        } catch {
          /* iframe may not be ready yet */
        }
      }, [archTheme, loaded, frameKey]);

      const src = `${ARCVISTA_URL}/?embed=1&dsh=1&theme=${initialTheme.current}`;
      const statusText = status === 'online' ? t('connected') : status === 'checking' ? t('checking') : t('offline');

      return h(
        'div',
        { className: 'as-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'as-head' },
          h('div', { className: 'as-brand' }, h('span', { className: 'as-brand-icon' }, h(ScopeGlyph, { size: 18 })), h('span', { className: 'as-title' }, t('title'))),
          h('span', { className: `as-status as-status--${status}` }, h('i'), statusText),
          h('span', { className: 'as-spacer' }),
          h('button', { type: 'button', className: 'as-head-btn', onClick: () => { setLoaded(false); setFrameKey((value) => value + 1); } }, t('reload')),
          h('button', { type: 'button', className: 'as-head-btn', onClick: () => window.open(`${ARCVISTA_URL}/`, '_blank', 'noopener,noreferrer') }, t('open')),
        ),
        h(
          'div',
          { className: 'as-body' },
          status === 'offline' && !loaded
            ? h(
                'div',
                { className: 'as-offline' },
                h('span', { className: 'as-offline-icon' }, h(ScopeGlyph, { size: 42 })),
                h('h2', null, t('offlineTitle')),
                h('p', null, t('offlineHint')),
                h('div', { className: 'as-command' }, t('command')),
                h(
                  'div',
                  { className: 'as-offline-actions' },
                  h('button', { type: 'button', className: 'as-primary', onClick: () => setFrameKey((value) => value + 1) }, t('retry')),
                  h('button', { type: 'button', className: 'as-secondary', onClick: () => window.open(`${ARCVISTA_URL}/`, '_blank', 'noopener,noreferrer') }, t('open')),
                ),
                h('span', { className: 'as-tip' }, t('tip')),
              )
            : [
                h('iframe', {
                  key: frameKey,
                  ref: frameRef,
                  className: 'as-frame',
                  title: t('title'),
                  src,
                  onLoad: () => setLoaded(true),
                  onError: () => setStatus('offline'),
                }),
                !loaded ? h('div', { className: 'as-loading' }, h('span', { className: 'as-spinner' }), t('loading')) : null,
              ],
        ),
      );
    }

    function SidebarIcon({ size = 18 }) {
      return h(ScopeGlyph, { size });
    }

    function apply(ctx) {
      const locale = ctx.get('locale');
      let t = (key) => zh[key] || key;
      if (locale) {
        try {
          ctx.effect(() => locale.register('arcvista', { zh, en }), 'arcvista:locale');
          const translate = locale.bind('arcvista');
          t = (key) => translate(key);
        } catch {
          /* fall back to Chinese copy */
        }
      }
      const theme = ctx.get('theme');
      const themeListeners = new Set();
      if (theme) {
        try {
          ctx.effect(() => ctx.on('theme/change', () => themeListeners.forEach((listener) => listener())), 'arcvista:theme');
        } catch {
          /* theme sync is optional */
        }
      }
      const getTheme = () => {
        try {
          return theme?.getTheme?.() || null;
        } catch {
          return null;
        }
      };

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ t, getTheme, themeListeners }),
          },
          ArchscopePanel,
        ),
      );

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => t('panel'),
          },
          SidebarIcon,
        ),
      );
    }

    return { inject: ['slots', 'locale', 'theme'], apply };
  },
});
