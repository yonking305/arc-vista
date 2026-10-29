/* Lightweight node detail drawer shared by the architecture map and knowledge graph. */

import { esc, fmtNum, fmtPct, icon } from '../dom.js';

const KIND_LABEL = {
  frontend: '客户端',
  gateway: '网关',
  service: '服务',
  shared: '共享组件',
  database: '数据库',
  cache: '缓存',
  mq: '消息队列',
  search: '搜索',
  infra: '基础设施',
  external: '外部系统',
  domain: '业务域',
  capability: '业务能力',
  entity: '领域实体',
  api: '接口',
  event: '领域事件',
  datastore: '数据组件',
  actor: '参与者',
};

const toneColor = (tone) => ({ good: 'var(--teal)', warn: 'var(--amber)', bad: 'var(--red)' }[tone] || 'var(--text-faint)');
const toneFor = (score, invert = false) => {
  if (score === null || score === undefined) return 'warn';
  const value = Number(score);
  if (invert) return value < 45 ? 'good' : value < 65 ? 'warn' : 'bad';
  return value >= 75 ? 'good' : value >= 50 ? 'warn' : 'bad';
};

export function openNodeDrawer({ node, analysis, nodes = [], edges = [], onDrill = null, onClose = null }) {
  if (!node) return { close: () => {} };
  const modulePath =
    node.module ||
    (typeof node.domain === 'string' && node.domain.startsWith('domain:') ? node.domain.slice(7) : null) ||
    (typeof node.id === 'string' && node.id.startsWith('domain:') ? node.id.slice(7) : null);
  const module = (analysis?.modules || []).find((item) => item.id === modulePath || item.path === modulePath);
  const comp = (analysis?.complexity?.modules || []).find((item) => item.path === modulePath);
  const cov = (analysis?.coverage?.modules || []).find((item) => item.path === modulePath);
  const nodeById = new Map(nodes.map((item) => [item.id, item]));
  const incoming = edges.filter((edge) => edge.to === node.id);
  const outgoing = edges.filter((edge) => edge.from === node.id);
  const edgeLabel = (edge) => edge.label || ({ sync: '调用', async: '消息', data: '读写', depends: '依赖' }[edge.kind] || edge.kind);
  const kindName = KIND_LABEL[node.kind] || '节点';

  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.innerHTML = `
    <aside class="drawer" style="width:min(540px,94vw)" role="dialog" aria-modal="true" aria-label="${esc(node.label)}">
      <header class="drawer-head">
        <div style="min-width:0">
          <div class="eyebrow">NODE · ${esc(kindName)}</div>
          <div class="drawer-title">${esc(node.label)}</div>
          <div class="drawer-path">${esc(node.sublabel || node.description || '')}${modulePath ? `<br/>${esc(modulePath)}` : ''}</div>
        </div>
        <button class="btn btn--icon btn--ghost" data-node-close aria-label="关闭">${icon('close', 16)}</button>
      </header>
      <div class="drawer-body">
        <div class="row row--wrap" style="gap:6px">
          ${node.tag ? String(node.tag).split('·').map((tag) => `<span class="chip chip--dim">${esc(tag.trim())}</span>`).join('') : ''}
          ${module ? `<span class="chip chip--dim">${esc(module.type || 'module')}</span>` : ''}
          ${node.description && node.kind !== 'domain' ? `<span class="chip chip--dim">${esc(node.description.slice(0, 40))}</span>` : ''}
        </div>
        ${node.note ? `<div class="help">${esc(node.note)}</div>` : ''}
        ${
          module
            ? `<div class="drill-metrics">
                <div class="dm"><span>代码行</span><b>${fmtNum(module.loc)}</b></div>
                <div class="dm"><span>源文件</span><b>${fmtNum(module.sourceFiles)}</b></div>
                <div class="dm"><span>复杂度</span><b style="color:${toneColor(toneFor(comp?.score, true))}">${comp ? fmtNum(comp.score) : '—'}</b></div>
                <div class="dm"><span>覆盖率</span><b style="color:${toneColor(toneFor(cov?.line))}">${cov?.line != null ? fmtPct(cov.line) : '—'}</b></div>
              </div>`
            : node.kind === 'domain'
              ? `<div class="banner banner--teal"><div>${esc(node.description || '业务域节点')}</div></div>`
              : `<div class="banner"><div>该节点由仓库结构、依赖或配置推断得出，没有可直接下钻的代码模块。</div></div>`
        }
        ${
          incoming.length || outgoing.length
            ? `<div class="drawer-section">
                <h4>依赖关系</h4>
                ${incoming
                  .slice(0, 8)
                  .map((edge) => `<div class="dep-item"><span>← ${esc(nodeById.get(edge.from)?.label || edge.from)}</span><span class="mono">${esc(edgeLabel(edge))}</span></div>`)
                  .join('')}
                ${outgoing
                  .slice(0, 8)
                  .map((edge) => `<div class="dep-item"><span>→ ${esc(nodeById.get(edge.to)?.label || edge.to)}</span><span class="mono">${esc(edgeLabel(edge))}</span></div>`)
                  .join('')}
              </div>`
            : ''
        }
        ${
          comp?.drivers?.length
            ? `<div class="drawer-section"><h4>复杂度驱动</h4><div class="row row--wrap" style="gap:6px">${comp.drivers
                .map((driver) => `<span class="chip chip--dim" title="${esc(driver.detail)}">${esc(driver.name)} ${fmtNum(driver.value)}</span>`)
                .join('')}</div></div>`
            : ''
        }
        ${
          modulePath && onDrill
            ? `<button class="btn btn--primary btn--block" data-node-drill>下钻分析这个模块 ${icon('arrow', 13)}</button>`
            : ''
        }
        <div class="help">在画布上滚动缩放、拖拽平移；按 Esc 关闭。</div>
      </div>
    </aside>`;
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';

  const close = () => {
    backdrop.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector('[data-node-close]').addEventListener('click', close);
  backdrop.querySelector('[data-node-drill]')?.addEventListener('click', () => {
    close();
    if (onDrill) onDrill({ ...node, module: modulePath });
  });
  return { close };
}
