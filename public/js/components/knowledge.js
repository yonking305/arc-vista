/* ArcVista — business knowledge graph renderer (domain lanes + capability cards). */

import { esc } from '../dom.js';

const KIND_META = {
  domain: { label: '业务域', color: 'var(--kind-domain)' },
  capability: { label: '业务能力', color: 'var(--kind-capability)' },
  entity: { label: '领域实体', color: 'var(--kind-entity)' },
  api: { label: '接口', color: 'var(--kind-api)' },
  event: { label: '事件', color: 'var(--kind-event)' },
  datastore: { label: '数据组件', color: 'var(--kind-datastore)' },
  actor: { label: '参与者', color: 'var(--kind-actor)' },
};

const BASE_HIDDEN = new Set(['api', 'entity']);
// Containment edges are already expressed by the lane layout. Drawing them too
// makes the canvas look like a bowl of spaghetti, so only real relations are visible.
const CLUTTER_EDGES = new Set(['contains', 'exposes', 'owns']);

const truncateCJK = (text, max) => {
  const chars = Array.from(String(text ?? ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};
const safe = (value, max) => esc(truncateCJK(value, max));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function nodeSubtitle(node, kind, counts = {}) {
  if (kind === 'domain') {
    const parts = [`${counts.capabilities || 0} 能力`];
    if (counts.entities) parts.push(`${counts.entities} 实体`);
    return parts.join(' · ');
  }
  if (kind === 'capability') return String(node.description || '').split('·')[0].trim() || '业务能力';
  if (kind === 'entity') {
    if (node.meta?.table) return `表 ${node.meta.table}`;
    if (node.meta?.fields?.length) return `${node.meta.fields.length} 个字段`;
    return '领域模型';
  }
  if (kind === 'datastore') return String(node.description || '').split('·')[0].trim() || '数据组件';
  if (kind === 'actor') return '参与者';
  if (kind === 'event') return '领域事件';
  return '';
}

function cardLabel(node, kind) {
  if (kind === 'domain') return safe(node.label, 11);
  if (kind === 'capability') return safe(node.label, 10);
  if (kind === 'entity') return safe(node.label, 11);
  if (kind === 'datastore') return safe(node.label, 12);
  if (kind === 'actor') return safe(node.label, 10);
  if (kind === 'event') return safe(node.label, 14);
  return safe(node.label, 12);
}

function trimRect(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const tx = ux === 0 ? Number.POSITIVE_INFINITY : from.w / 2 / Math.abs(ux);
  const ty = uy === 0 ? Number.POSITIVE_INFINITY : from.h / 2 / Math.abs(uy);
  const t = Math.min(tx, ty);
  return { x: from.x + ux * t, y: from.y + uy * t };
}

function edgePath(from, to) {
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  if (horizontal) {
    const bend = clamp(Math.abs(to.x - from.x) * 0.48, 24, 130);
    return `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${(from.x + bend).toFixed(1)},${from.y.toFixed(1)} ${(to.x - bend).toFixed(1)},${to.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
  }
  const bend = clamp(Math.abs(to.y - from.y) * 0.48, 24, 110);
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${from.x.toFixed(1)},${(from.y + bend).toFixed(1)} ${to.x.toFixed(1)},${(to.y - bend).toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}

export function renderKnowledge(container, model, { onNodeClick = null } = {}) {
  if (!container) return null;
  const hidden = new Set(BASE_HIDDEN);
  let destroyed = false;
  let controller = null;

  function draw() {
    controller?.destroy?.();
    container.innerHTML = '';
    const nodes = (model?.nodes || []).filter((node) => !hidden.has(node.kind));
    if (!nodes.length) {
      container.innerHTML = '<div class="empty" style="height:100%;border:none">知识图谱为空</div>';
      return null;
    }

    const domainNodes = nodes.filter((node) => node.kind === 'domain');
    const actorNodes = nodes.filter((node) => node.kind === 'actor');
    const storeNodes = nodes.filter((node) => node.kind === 'datastore');
    const eventNodes = nodes.filter((node) => node.kind === 'event');
    const childNodes = nodes.filter((node) => !['domain', 'actor', 'datastore', 'event'].includes(node.kind));

    const childrenByDomain = new Map();
    for (const node of childNodes) {
      const key = node.domain || 'unassigned';
      if (!childrenByDomain.has(key)) childrenByDomain.set(key, []);
      childrenByDomain.get(key).push(node);
    }
    const allDomainIds = new Set(domainNodes.map((node) => node.id));
    const sharedEntities = hidden.has('entity')
      ? []
      : (model?.nodes || []).filter((node) => node.kind === 'entity' && !allDomainIds.has(node.domain));
    const populatedDomains = domainNodes.filter((domain) => (childrenByDomain.get(domain.id) || []).length > 0);
    const domains = populatedDomains.length > 0 ? populatedDomains : domainNodes.length > 0 ? domainNodes : [{ id: 'unassigned', label: '业务域', description: '' }];

    const LANE_X = 196;
    const LANE_WIDTH = 880;
    const HEADER_W = 188;
    const CAP_START_X = LANE_X + HEADER_W + 38;
    const CAP_COLS = 5;
    const CAP_W = 118;
    const CAP_H = 36;
    const CAP_GAP_X = 8;
    const CAP_GAP_Y = 6;
    const ENTITY_COLS = 7;
    const ENTITY_W = 84;
    const ENTITY_H = 22;
    const ENTITY_GAP_X = 6;
    const ENTITY_GAP_Y = 4;
    const positions = new Map();
    const lanes = [];
    let laneY = 26;

    for (let index = 0; index < domains.length; index += 1) {
      const domain = domains[index];
      const children = childrenByDomain.get(domain.id) || [];
      const capabilities = children.filter((node) => node.kind === 'capability');
      const entities = children.filter((node) => node.kind === 'entity');
      const apis = children.filter((node) => node.kind === 'api');
      const capRows = Math.max(1, Math.ceil(capabilities.length / CAP_COLS));
      const capArea = capRows * (CAP_H + CAP_GAP_Y);
      const entityRows = Math.ceil(entities.length / ENTITY_COLS);
      const apiRows = hidden.has('api') ? 0 : Math.ceil(apis.length / 6);
      const apiArea = apiRows * 28;
      const headerH = 56;
      const top = 16;
      const entityStart = laneY + top + Math.max(capArea, headerH) + (entities.length ? 12 : 0);
      const apiStart = entityStart + entityRows * (ENTITY_H + ENTITY_GAP_Y) + (entities.length ? 4 : 0);
      const laneHeight = top + Math.max(capArea, headerH) + (entities.length ? 12 + entityRows * (ENTITY_H + ENTITY_GAP_Y) : 0) + apiArea + 14;

      positions.set(domain.id, {
        node: domain,
        x: LANE_X + 16 + HEADER_W / 2,
        y: laneY + top + headerH / 2,
        w: HEADER_W,
        h: headerH,
      });

      capabilities.forEach((node, capIndex) => {
        const row = Math.floor(capIndex / CAP_COLS);
        const col = capIndex % CAP_COLS;
        positions.set(node.id, {
          node,
          x: CAP_START_X + col * (CAP_W + CAP_GAP_X) + CAP_W / 2,
          y: laneY + top + row * (CAP_H + CAP_GAP_Y) + CAP_H / 2,
          w: CAP_W,
          h: CAP_H,
        });
      });

      entities.forEach((node, entityIndex) => {
        const row = Math.floor(entityIndex / ENTITY_COLS);
        const col = entityIndex % ENTITY_COLS;
        positions.set(node.id, {
          node,
          x: CAP_START_X + col * (ENTITY_W + ENTITY_GAP_X) + ENTITY_W / 2,
          y: entityStart + row * (ENTITY_H + ENTITY_GAP_Y) + ENTITY_H / 2,
          w: ENTITY_W,
          h: ENTITY_H,
        });
      });

      if (!hidden.has('api')) {
        apis.forEach((node, apiIndex) => {
          const row = Math.floor(apiIndex / 6);
          const col = apiIndex % 6;
          positions.set(node.id, {
            node,
            x: CAP_START_X + col * 128 + 56,
            y: apiStart + row * 28 + 10,
            w: 118,
            h: 20,
          });
        });
      }

      lanes.push({ domain, index, y: laneY, height: laneHeight, capabilities, entities });
      laneY += laneHeight + 14;
    }

    if (sharedEntities.length > 0) {
      const sharedDomain = {
        id: 'group:shared-entities',
        label: '共享实体',
        kind: 'domain',
        description: '跨域共享的领域模型',
      };
      const headerH = 56;
      const top = 16;
      const rows = Math.ceil(sharedEntities.length / ENTITY_COLS);
      const laneHeight = top + headerH + 12 + rows * (ENTITY_H + ENTITY_GAP_Y) + 14;
      positions.set(sharedDomain.id, {
        node: sharedDomain,
        x: LANE_X + 16 + HEADER_W / 2,
        y: laneY + top + headerH / 2,
        w: HEADER_W,
        h: headerH,
      });
      sharedEntities.forEach((node, index) => {
        const row = Math.floor(index / ENTITY_COLS);
        const col = index % ENTITY_COLS;
        positions.set(node.id, {
          node,
          x: CAP_START_X + col * (ENTITY_W + ENTITY_GAP_X) + ENTITY_W / 2,
          y: laneY + top + headerH + 12 + row * (ENTITY_H + ENTITY_GAP_Y) + ENTITY_H / 2,
          w: ENTITY_W,
          h: ENTITY_H,
        });
      });
      lanes.push({ domain: sharedDomain, index: domains.length, y: laneY, height: laneHeight, capabilities: [], entities: sharedEntities, shared: true });
      laneY += laneHeight + 14;
    }

    const RIGHT_X = LANE_X + LANE_WIDTH + 52;
    const RIGHT_W = 160;
    const totalLaneHeight = laneY;
    const actorYs = actorNodes.map((_, index) =>
      actorNodes.length === 1 ? Math.max(220, totalLaneHeight / 2) : 70 + (index * (totalLaneHeight - 140)) / Math.max(1, actorNodes.length - 1),
    );
    actorNodes.forEach((node, index) => {
      positions.set(node.id, {
        node,
        x: 26 + RIGHT_W / 2,
        y: actorYs[index],
        w: RIGHT_W,
        h: 42,
      });
    });

    let rightY = 32;
    for (const node of storeNodes) {
      positions.set(node.id, {
        node,
        x: RIGHT_X + RIGHT_W / 2,
        y: rightY + 21,
        w: RIGHT_W,
        h: 42,
      });
      rightY += 52;
    }
    rightY += 18;
    for (const node of eventNodes) {
      positions.set(node.id, {
        node,
        x: RIGHT_X + RIGHT_W / 2,
        y: rightY + 12,
        w: RIGHT_W,
        h: 24,
      });
      rightY += 32;
    }

    const contentW = RIGHT_X + RIGHT_W + 30;
    const contentH = Math.max(laneY + 20, rightY + 36, ...actorYs.map((y) => y + 30), 420);

    const edgeMarkup = [];
    const edges = (model.edges || []).filter((edge) => !CLUTTER_EDGES.has(edge.kind));
    for (const edge of edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      const start = trimRect(from, to);
      const end = trimRect(to, from);
      const label = edge.label || edge.kind || '';
      edgeMarkup.push(`
        <g class="kg-edge-group" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" data-kind="${esc(edge.kind || '')}">
          <title>${esc(edge.from)} → ${esc(edge.to)}${label ? ` · ${esc(label)}` : ''}</title>
          <path class="kg-edge-hit" d="${edgePath(start, end)}"/>
          <path class="kg-edge" data-kind="${esc(edge.kind || '')}" d="${edgePath(start, end)}" marker-end="url(#kg-arrow)"/>
        </g>`);
    }

    const laneMarkup = lanes
      .map(
        (lane) => `
      <g class="kg-lane">
        <rect class="kg-lane-bg" x="${LANE_X - 10}" y="${lane.y - 8}" width="${LANE_WIDTH + 20}" height="${lane.height + 16}" rx="12"/>
        <text class="lane-index" x="${LANE_X}" y="${lane.y + 12}">${lane.shared ? 'SHARED MODELS' : `DOMAIN ${String(lane.index + 1).padStart(2, '0')}`}</text>
        <text class="lane-sub" x="${LANE_X + LANE_WIDTH}" y="${lane.y + 12}" text-anchor="end">${lane.shared ? `${sharedEntities.length} 个跨域模型` : `${lane.capabilities.length} 能力 · ${lane.entities.length} 实体`}</text>
      </g>`,
      )
      .join('');

    const nodeMarkup = [...positions.values()]
      .map(({ node, x, y, w, h }) => {
        const kind = node.kind || 'capability';
        const meta = KIND_META[kind] || KIND_META.capability;
        const left = x - w / 2;
        const top = y - h / 2;
        const domain = kind === 'domain';
        const cap = kind === 'capability';
        const entity = kind === 'entity';
        const event = kind === 'event';
        const flat = kind === 'datastore' || kind === 'actor';
        const sub = node.id === 'group:shared-entities'
          ? `${sharedEntities.length} 个跨域模型`
          : nodeSubtitle(node, kind, {
              capabilities: (childrenByDomain.get(node.id) || []).filter((child) => child.kind === 'capability').length,
              entities: (childrenByDomain.get(node.id) || []).filter((child) => child.kind === 'entity').length,
            });
        const titleY = domain ? top + 27 : cap ? top + 16 : flat ? top + 18 : top + h / 2 + 3;
        const subY = domain ? top + 42 : cap ? top + 28 : flat ? top + 32 : top + h / 2;
        const apiCount = cap ? (String(node.description || '').match(/(\d+)\s*个接口/) || [])[1] : '';
        const dotY = domain ? top + 23 : cap ? top + 16 : top + h / 2;
        return `
        <g class="kg-node kind-${esc(kind)}${node.id === 'group:shared-entities' ? ' is-static' : ''}" data-id="${esc(node.id)}" data-kind="${esc(kind)}"${node.id === 'group:shared-entities' ? ' data-static="1"' : ''} tabindex="0" role="button" aria-label="${esc(node.label)}">
          <title>${esc(node.label)}${node.description ? ` · ${esc(node.description)}` : ''}</title>
          <rect class="kg-card" x="${left}" y="${top}" width="${w}" height="${h}" rx="${domain ? 9 : entity ? 6 : 7}"/>
          <circle class="kg-dot" cx="${left + (entity ? 10 : 13)}" cy="${dotY}" r="${domain ? 4 : entity ? 2.4 : cap ? 3.2 : 3.6}"/>
          <text class="kg-label" x="${left + (entity ? 18 : 24)}" y="${titleY}">${cardLabel(node, kind)}</text>
          ${sub && !event ? `<text class="kg-sub" x="${left + (entity ? 18 : 24)}" y="${subY}">${safe(sub, kind === 'domain' ? 16 : 13)}</text>` : ''}
          ${apiCount ? `<text class="kg-count" x="${left + w - 9}" y="${top + 16}" text-anchor="end">${esc(apiCount)}</text>` : ''}
        </g>`;
      })
      .join('');

    container.innerHTML = `
      <div class="kg-stage" style="position:absolute;inset:0;overflow:hidden">
        <svg class="kg-svg" width="${contentW}" height="${contentH}" viewBox="0 0 ${contentW} ${contentH}" style="position:absolute;left:0;top:0;transform-origin:0 0">
          <defs>
            <marker id="kg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0.5,0.8 L7,4 L0.5,7.2" fill="context-stroke" stroke="none"/>
            </marker>
            <filter id="nodeGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="3" stdDeviation="5" flood-opacity="0.22" style="flood-color:var(--kind-domain)"/>
            </filter>
            <filter id="nodeGlowStrong" x="-60%" y="-60%" width="220%" height="220%">
              <feDropShadow dx="0" dy="0" stdDeviation="8" flood-opacity="0.4" style="flood-color:var(--amber)"/>
            </filter>
          </defs>
          ${laneMarkup}
          <g class="kg-edge-layer">${edgeMarkup.join('')}</g>
          <g class="kg-node-layer">${nodeMarkup}</g>
        </svg>
        <div class="diagram-tools">
          <button type="button" data-tool="zoom-out" title="缩小">−</button>
          <button type="button" class="zoom-label" data-tool="fit" title="适配画布">100%</button>
          <button type="button" data-tool="zoom-in" title="放大">+</button>
          <button type="button" data-tool="reset" title="复位"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
        </div>
        <div class="diagram-tip">拖拽平移 · Ctrl/⌘ + 滚轮缩放<br/><b>点击节点查看业务含义</b></div>
        <div class="diagram-legend">
          ${Object.entries(KIND_META)
            .filter(([kind]) => !hidden.has(kind))
            .map(([kind, meta]) => {
              const count = nodes.filter((node) => node.kind === kind).length;
              return `<span class="lg"><b class="kg-swatch" style="background:${meta.color}"></b>${meta.label}<em>${count}</em></span>`;
            })
            .join('')}
        </div>
      </div>`;

    container.style.height = `${clamp(contentH + 24, 520, 920)}px`;

    const svg = container.querySelector('.kg-svg');
    const zoomLabel = container.querySelector('[data-tool="fit"]');
    const nodeElements = [...svg.querySelectorAll('.kg-node')];
    const edgeElements = [...svg.querySelectorAll('.kg-edge')];
    const edgeGroups = [...svg.querySelectorAll('.kg-edge-group')];
    const edgesByNode = new Map();
    for (const group of edgeGroups) {
      for (const id of [group.dataset.from, group.dataset.to]) {
        if (!edgesByNode.has(id)) edgesByNode.set(id, []);
        edgesByNode.get(id).push(group);
      }
    }

    let zoom = 1;
    let tx = 0;
    let ty = 0;
    let activeId = null;

    const apply = () => {
      svg.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
      if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    };
    const fit = () => {
      const rect = container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      zoom = Math.min((rect.width - 40) / contentW, (rect.height - 36) / contentH, 1.06);
      tx = (rect.width - contentW * zoom) / 2;
      ty = (rect.height - contentH * zoom) / 2;
      apply();
    };
    const zoomAt = (sx, sy, factor) => {
      const next = Math.min(2.2, Math.max(0.32, zoom * factor));
      const ratio = next / zoom;
      tx = sx - (sx - tx) * ratio;
      ty = sy - (sy - ty) * ratio;
      zoom = next;
      apply();
    };
    const clear = () => {
      nodeElements.forEach((element) => element.classList.remove('dim'));
      edgeGroups.forEach((element) => element.classList.remove('dim', 'highlight'));
    };
    const isolate = (id) => {
      const connected = edgesByNode.get(id) || [];
      nodeElements.forEach((element) => element.classList.toggle('dim', element.dataset.id !== id));
      edgeGroups.forEach((element) => {
        const on = connected.includes(element);
        element.classList.toggle('dim', !on);
        element.classList.toggle('highlight', on);
      });
    };

    nodeElements.forEach((element) => {
      if (element.dataset.static === '1') {
        element.addEventListener('click', (event) => event.stopPropagation());
        return;
      }
      element.addEventListener('mouseenter', () => isolate(element.dataset.id));
      element.addEventListener('mouseleave', () => {
        clear();
        if (activeId) isolate(activeId);
      });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        activeId = element.dataset.id;
        nodeElements.forEach((item) => item.classList.toggle('active', item.dataset.id === activeId));
        const node = nodes.find((item) => item.id === activeId);
        isolate(activeId);
        if (node && onNodeClick) onNodeClick(node);
      });
    });

    const stage = container.querySelector('.kg-stage');
    let pointer = null;
    let moved = 0;
    let downOnNode = false;
    stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.diagram-tools')) return;
      pointer = { x: event.clientX, y: event.clientY };
      moved = 0;
      downOnNode = Boolean(event.target.closest('.kg-node'));
      stage.setPointerCapture?.(event.pointerId);
    });
    stage.addEventListener('pointermove', (event) => {
      if (!pointer) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      moved += Math.abs(dx) + Math.abs(dy);
      pointer = { x: event.clientX, y: event.clientY };
      tx += dx;
      ty += dy;
      apply();
    });
    const endPan = () => {
      if (!pointer) return;
      if (moved < 5 && !downOnNode) {
        clear();
        nodeElements.forEach((item) => item.classList.remove('active'));
        activeId = null;
      }
      pointer = null;
      downOnNode = false;
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);
    stage.addEventListener(
      'wheel',
      (event) => {
        // Plain scroll scrolls the page; only Ctrl/⌘ + wheel zooms the map.
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = container.getBoundingClientRect();
        zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0016));
      },
      { passive: false },
    );
    stage.querySelectorAll('[data-tool]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = container.getBoundingClientRect();
        const tool = button.dataset.tool;
        if (tool === 'zoom-in') zoomAt(rect.width / 2, rect.height / 2, 1.22);
        else if (tool === 'zoom-out') zoomAt(rect.width / 2, rect.height / 2, 1 / 1.22);
        else if (tool === 'fit' || tool === 'reset') {
          fit();
          clear();
        }
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!destroyed) fit();
    });
    resizeObserver.observe(container);
    requestAnimationFrame(fit);

    const api = {
      fit,
      destroy: () => {
        destroyed = true;
        resizeObserver.disconnect();
      },
      nodeCount: positions.size,
    };
    controller = api;
    return api;
  }

  draw();

  return {
    setHidden: (kinds) => {
      hidden.clear();
      for (const kind of kinds) hidden.add(kind);
      draw();
    },
    getHidden: () => [...hidden],
    redraw: draw,
    destroy: () => {
      destroyed = true;
      controller?.destroy?.();
    },
  };
}

export const KG_KINDS = KIND_META;
