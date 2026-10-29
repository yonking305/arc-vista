/* ArcVista — interactive architecture map renderer. */

import { esc } from '../dom.js';

const NODE_W = 178;
const NODE_H = 68;
const GAP_IN = 14;
const GAP_GROUP = 32;
const BAND_PAD = 18;
const BAND_GAP = 26;

function truncateCJK(text, max) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

const safe = (value, max) => esc(truncateCJK(value, max));

function layerOrder(model) {
  const seen = new Set();
  const layers = [];
  for (const layer of model.layers || []) {
    if (!model.nodes.some((node) => node.layer === layer.id)) continue;
    layers.push(layer);
    seen.add(layer.id);
  }
  for (const node of model.nodes) {
    if (seen.has(node.layer)) continue;
    seen.add(node.layer);
    layers.push({ id: node.layer, label: node.layer, kind: 'other' });
  }
  return layers;
}

function groupOrder(model) {
  const order = new Map((model.groups || []).map((group, index) => [group.id, index]));
  return (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b);
}

function computeLayout(model) {
  const layers = layerOrder(model);
  const groupsById = new Map((model.groups || []).map((group) => [group.id, group]));
  const rows = [];
  const nodePlacements = new Map();

  for (const layer of layers) {
    const layerNodes = model.nodes.filter((node) => node.layer === layer.id);
    const groupMap = new Map();
    for (const node of layerNodes) {
      const key = node.group || layer.id;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(node);
    }
    const groups = [];
    for (const [key, nodes] of [...groupMap.entries()].sort(([a], [b]) => groupOrder(model)(a, b))) {
      nodes.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-CN'));
      const width = nodes.length * NODE_W + (nodes.length - 1) * GAP_IN + BAND_PAD * 2;
      groups.push({ id: key, label: groupsById.get(key)?.label || key, nodes, width });
    }
    const rowWidth = groups.reduce((total, group) => total + group.width, 0) + GAP_GROUP * Math.max(0, groups.length - 1);
    rows.push({ layer, groups, rowWidth });
  }

  const contentWidth = Math.max(980, ...rows.map((row) => row.rowWidth + 120));
  const startX = 20;
  let y = 26;
  for (const row of rows) {
    const bandTop = y;
    const groupTop = bandTop + BAND_PAD;
    const groupHeight = NODE_H + 38;
    row.bandTop = bandTop;
    row.bandHeight = BAND_PAD + groupHeight + 12;
    row.groupTop = groupTop;
    row.groupHeight = groupHeight;
    let x = startX + (contentWidth - startX * 2 - row.rowWidth) / 2;
    for (const group of row.groups) {
      group.x = x;
      group.y = groupTop;
      group.height = groupHeight;
      group.nodes.forEach((node, index) => {
        nodePlacements.set(node.id, {
          x: x + BAND_PAD + index * (NODE_W + GAP_IN),
          y: groupTop + 28,
          w: NODE_W,
          h: NODE_H,
          node,
        });
      });
      x += group.width + GAP_GROUP;
    }
    y = bandTop + row.bandHeight + BAND_GAP;
  }
  const height = y + 14;
  return { width: contentWidth, height, rows, nodePlacements };
}

function edgeGeometry(source, target) {
  const sc = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
  const tc = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const sameRow = Math.abs(source.y - target.y) < 4;
  let start;
  let end;
  let path;
  let label;
  if (sameRow) {
    const direction = tc.x >= sc.x ? 1 : -1;
    start = { x: source.x + (direction > 0 ? source.w : 0), y: sc.y };
    end = { x: target.x + (direction > 0 ? 0 : target.w), y: tc.y };
    const bow = sc.y - 34;
    const midX = (start.x + end.x) / 2;
    path = `M${start.x},${start.y} C${midX},${bow} ${midX},${bow} ${end.x},${end.y}`;
    label = { x: midX, y: bow + 8 };
  } else {
    const down = tc.y > sc.y;
    start = { x: sc.x, y: source.y + (down ? source.h : 0) };
    end = { x: tc.x, y: target.y + (down ? 0 : target.h) };
    const span = Math.abs(end.y - start.y);
    const bend = Math.max(38, Math.min(130, span * 0.45));
    const c1 = { x: start.x, y: start.y + (down ? bend : -bend) };
    const c2 = { x: end.x, y: end.y - (down ? bend : -bend) };
    path = `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
    label = {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
    };
  }
  return { path, label };
}

function nodeMarkup(placement) {
  const { node, x, y, w, h } = placement;
  const health = node.health || {};
  const complexity = health.complexity;
  const coverage = health.coverage;
  let dot = 'na';
  if (complexity !== null && complexity !== undefined) dot = complexity >= 75 ? 'bad' : complexity >= 55 ? 'warn' : 'good';
  else if (coverage !== null && coverage !== undefined) dot = coverage < 35 ? 'bad' : coverage < 65 ? 'warn' : 'good';
  const kindLabel = {
    frontend: 'CLIENT',
    gateway: 'EDGE',
    service: 'SERVICE',
    shared: 'SHARED',
    database: 'DB',
    cache: 'CACHE',
    mq: 'MQ',
    search: 'SEARCH',
    infra: 'INFRA',
    external: 'EXTERNAL',
  }[node.kind] || 'MODULE';
  return `
  <g class="node-group" data-kind="${esc(node.kind || 'service')}" data-id="${esc(node.id)}" tabindex="0" role="button"
     aria-label="${esc(node.label)}" transform="translate(${x},${y})">
    <title>${esc(node.label)}${node.sublabel ? ` · ${esc(node.sublabel)}` : ''}${node.tag ? ` · ${esc(node.tag)}` : ''}</title>
    <rect class="node-card" width="${w}" height="${h}" rx="2"/>
    <rect class="node-accent" x="0" y="10" width="2.5" height="${h - 20}" rx="1"/>
    <text class="node-label" x="14" y="27">${safe(node.label, 16)}</text>
    <text class="node-sub" x="14" y="45">${safe(node.sublabel || kindLabel, 26)}</text>
    <text class="node-tag" x="14" y="60">${safe(node.tag || kindLabel, 20)}</text>
    <circle class="health-dot ${dot}" cx="${w - 12}" cy="14" r="3"/>
    <text class="node-drill" x="${w - 18}" y="${h - 10}">↳</text>
  </g>`;
}

/**
 * Render the architecture map with pan / zoom / hover-isolation / drill click.
 * @returns controller { fit, zoomIn, zoomOut, setActive, destroy, getZoom }
 */
export function renderArchitecture(container, model, { onNodeClick = null, onBackgroundClick = null } = {}) {
  if (!container) return null;
  container.innerHTML = '';
  if (!model?.nodes?.length) {
    container.innerHTML = '<div class="empty" style="height:100%;border:none">架构节点为空</div>';
    return null;
  }

  const layout = computeLayout(model);
  const { width: W, height: H, rows, nodePlacements } = layout;

  const edgeMarkup = [];
  const edgeMeta = [];
  for (const edge of model.edges) {
    const source = nodePlacements.get(edge.from);
    const target = nodePlacements.get(edge.to);
    if (!source || !target) continue;
    const geometry = edgeGeometry(source, target);
    const showLabel = edge.label && String(edge.label).length > 0 && edge.kind !== 'depends';
    const labelWidth = showLabel ? Math.max(26, String(edge.label).length * 5.4 + 10) : 0;
    edgeMarkup.push(`
      <g class="edge fade-in" data-kind="${esc(edge.kind)}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}">
        <path d="${geometry.path}" marker-end="url(#arrow-${esc(edge.kind)})"/>
        ${showLabel ? `<g>
          <rect class="edge-label-bg" x="${geometry.label.x - labelWidth / 2}" y="${geometry.label.y - 7}" width="${labelWidth}" height="13" rx="2"/>
          <text class="edge-label" x="${geometry.label.x}" y="${geometry.label.y + 2}" text-anchor="middle">${safe(edge.label, 18)}</text>
        </g>` : ''}
      </g>`);
    edgeMeta.push({ edge, elementIndex: edgeMarkup.length - 1 });
  }

  const layerMarkup = rows
    .map((row, index) => `
      <g class="layer-band">
        <rect x="20" y="${row.bandTop}" width="${W - 40}" height="${row.bandHeight}" rx="2"/>
        <text class="layer-index" x="36" y="${row.bandTop + 19}">${String(index + 1).padStart(2, '0')}</text>
        <text class="layer-label" x="66" y="${row.bandTop + 19}">${esc(row.layer.label)}</text>
      </g>`)
    .join('');

  const groupMarkup = rows
    .map((row) =>
      row.groups
        .map(
          (group) => `
      <g class="group-box">
        <rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="2"/>
        <line class="group-tick" x1="${group.x}" y1="${group.y - 9}" x2="${group.x + 16}" y2="${group.y - 9}"/>
        <text class="group-label" x="${group.x + 22}" y="${group.y - 6}">${safe(group.label, 20)}</text>
      </g>`,
        )
        .join(''),
    )
    .join('');

  const nodeMarkupAll = [...nodePlacements.values()].map(nodeMarkup).join('');

  container.innerHTML = `
    <div class="arch-stage" style="position:absolute;inset:0;overflow:hidden">
      <svg class="arch-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;left:0;top:0;transform-origin:0 0;width:${W}px;height:${H}px">
        <defs>
          ${['sync', 'async', 'data', 'depends']
            .map(
              (kind) => `<marker id="arrow-${kind}" class="arrow-${kind}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
                <path class="edge-arrow" d="M0,0 L8,4 L0,8 z"/></marker>`,
            )
            .join('')}
          <linearGradient id="nodeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="node-fill-hi"/>
            <stop offset="1" class="node-fill-lo"/>
          </linearGradient>
          <filter id="nodeGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.18" style="flood-color:var(--amber)"/>
          </filter>
          <filter id="nodeGlowStrong" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="0" stdDeviation="8" flood-opacity="0.35" style="flood-color:var(--amber)"/>
          </filter>
        </defs>
        <g class="layer-layer">${layerMarkup}</g>
        <g class="group-layer">${groupMarkup}</g>
        <g class="edge-layer">${edgeMarkup.join('')}</g>
        <g class="node-layer">${nodeMarkupAll}</g>
      </svg>
      <div class="diagram-tools">
        <button type="button" data-tool="zoom-out" title="缩小">−</button>
        <button type="button" class="zoom-label" data-tool="fit" title="适配画布">100%</button>
        <button type="button" data-tool="zoom-in" title="放大">+</button>
        <button type="button" data-tool="reset" title="居中复位"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      </div>
      <div class="diagram-tip">拖拽平移 · 滚轮缩放<br/><b>点击节点下钻分析</b></div>
      <div class="diagram-legend">
        <span class="lg"><i></i>同步调用</span>
        <span class="lg"><i class="dash"></i>异步消息</span>
        <span class="lg"><i class="dot"></i>数据读写</span>
        <span class="lg"><i style="opacity:.4"></i>代码依赖</span>
        <span class="lg"><b class="round" style="background:var(--teal)"></b>健康</span>
        <span class="lg"><b class="round" style="background:var(--amber)"></b>关注</span>
        <span class="lg"><b class="round" style="background:var(--red)"></b>高风险</span>
      </div>
    </div>`;

  const svg = container.querySelector('.arch-svg');
  const zoomLabel = container.querySelector('[data-tool="fit"]');
  const stage = container.querySelector('.arch-stage');
  const nodeElements = [...svg.querySelectorAll('.node-group')];
  const edgeElements = [...svg.querySelectorAll('.edge')];
  const edgesByNode = new Map();
  for (const edgeEl of edgeElements) {
    const from = edgeEl.dataset.from;
    const to = edgeEl.dataset.to;
    if (!edgesByNode.has(from)) edgesByNode.set(from, []);
    if (!edgesByNode.has(to)) edgesByNode.set(to, []);
    edgesByNode.get(from).push(edgeEl);
    edgesByNode.get(to).push(edgeEl);
  }

  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let activeId = null;
  let hoveringId = null;
  let destroyed = false;

  function applyTransform() {
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function fit() {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const padding = 44;
    zoom = Math.min((rect.width - padding * 2) / W, (rect.height - padding * 2) / H, 1.08);
    tx = (rect.width - W * zoom) / 2;
    ty = (rect.height - H * zoom) / 2;
    applyTransform();
  }

  function zoomAt(screenX, screenY, factor) {
    const next = Math.min(2.6, Math.max(0.22, zoom * factor));
    const ratio = next / zoom;
    tx = screenX - (screenX - tx) * ratio;
    ty = screenY - (screenY - ty) * ratio;
    zoom = next;
    applyTransform();
  }

  function resetActive() {
    nodeElements.forEach((element) => element.classList.remove('active'));
    activeId = null;
  }

  function isolate(nodeId) {
    const connected = edgesByNode.get(nodeId) || [];
    for (const element of nodeElements) {
      element.classList.toggle('dim', element.dataset.id !== nodeId);
    }
    for (const element of edgeElements) {
      const on = connected.includes(element);
      element.classList.toggle('dim', !on);
      element.classList.toggle('highlight', on);
    }
  }

  function clearIsolation() {
    for (const element of nodeElements) element.classList.remove('dim');
    for (const element of edgeElements) {
      element.classList.remove('dim');
      element.classList.remove('highlight');
    }
  }

  nodeElements.forEach((element) => {
    element.addEventListener('mouseenter', () => {
      hoveringId = element.dataset.id;
      isolate(hoveringId);
    });
    element.addEventListener('mouseleave', () => {
      hoveringId = null;
      clearIsolation();
      if (activeId) isolate(activeId);
    });
    element.addEventListener('focus', () => {
      hoveringId = element.dataset.id;
      isolate(hoveringId);
    });
    element.addEventListener('blur', () => {
      hoveringId = null;
      clearIsolation();
      if (activeId) isolate(activeId);
    });
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = element.dataset.id;
      activeId = id;
      nodeElements.forEach((item) => item.classList.toggle('active', item.dataset.id === id));
      isolate(id);
      const node = model.nodes.find((item) => item.id === id);
      if (node && onNodeClick) onNodeClick(node);
    });
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });

  function setActive(id) {
    activeId = id;
    nodeElements.forEach((item) => item.classList.toggle('active', item.dataset.id === id));
    if (id) isolate(id);
    else {
      clearIsolation();
    }
  }

  // pan / zoom
  let pointer = null;
  let moved = 0;
  let downOnNode = false;
  container.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.diagram-tools')) return;
    pointer = { x: event.clientX, y: event.clientY };
    moved = 0;
    downOnNode = Boolean(event.target.closest('.node-group'));
    if (!downOnNode) container.setPointerCapture?.(event.pointerId);
    container.classList.add('is-panning');
  });
  container.addEventListener('pointermove', (event) => {
    if (!pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    moved += Math.abs(dx) + Math.abs(dy);
    pointer = { x: event.clientX, y: event.clientY };
    tx += dx;
    ty += dy;
    applyTransform();
  });
  const endPan = () => {
    if (!pointer) return;
    const wasClick = moved < 5 && !downOnNode;
    pointer = null;
    downOnNode = false;
    container.classList.remove('is-panning');
    if (wasClick) {
      resetActive();
      clearIsolation();
      if (onBackgroundClick) onBackgroundClick();
    }
  };
  container.addEventListener('pointerup', endPan);
  container.addEventListener('pointercancel', endPan);
  container.addEventListener(
    'wheel',
    (event) => {
      // Plain wheel / trackpad scroll should scroll the page, not zoom the map.
      // Keep zoom available through the toolbar and the explicit Ctrl/⌘ + wheel gesture.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0016));
    },
    { passive: false },
  );

  container.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const tool = button.dataset.tool;
      const rect = container.getBoundingClientRect();
      if (tool === 'zoom-in') zoomAt(rect.width / 2, rect.height / 2, 1.22);
      else if (tool === 'zoom-out') zoomAt(rect.width / 2, rect.height / 2, 1 / 1.22);
      else if (tool === 'fit') fit();
      else if (tool === 'reset') {
        fit();
        resetActive();
        clearIsolation();
        if (onBackgroundClick) onBackgroundClick();
      }
    });
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!destroyed) fit();
  });
  resizeObserver.observe(container);

  requestAnimationFrame(() => {
    fit();
    setTimeout(() => container.classList.add('is-ready'), 60);
  });

  return {
    fit,
    zoomIn: () => zoomAt(container.clientWidth / 2, container.clientHeight / 2, 1.2),
    zoomOut: () => zoomAt(container.clientWidth / 2, container.clientHeight / 2, 1 / 1.2),
    setActive,
    getZoom: () => zoom,
    destroy: () => {
      destroyed = true;
      resizeObserver.disconnect();
    },
  };
}

/** Compact internal-structure graph for the drill-down drawer. */
export function renderMiniGraph(container, graph, { onNodeClick = null, height = 260 } = {}) {
  if (!container) return;
  container.innerHTML = '';
  const nodes = (graph?.nodes || []).filter((node) => node.id);
  if (nodes.length === 0) {
    container.innerHTML = '<div class="empty" style="border:none;height:100%;padding:20px">无内部结构数据</div>';
    return;
  }
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(nodes.length * 1.4))));
  const nodeW = 138;
  const nodeH = 44;
  const gapX = 26;
  const gapY = 40;
  const rows = Math.ceil(nodes.length / cols);
  const W = cols * nodeW + (cols - 1) * gapX + 60;
  const H = rows * nodeH + (rows - 1) * gapY + 60;
  const positions = new Map();
  const nodeMarkup = nodes
    .map((node, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = 30 + col * (nodeW + gapX);
      const y = 30 + row * (nodeH + gapY);
      positions.set(node.id, { x, y, w: nodeW, h: nodeH });
      const label = truncateCJK(node.label, 12);
      return `
        <g class="mini-node kind-${node.kind || 'component'}" data-id="${node.id}" transform="translate(${x},${y})">
          <rect width="${nodeW}" height="${nodeH}" rx="2"/>
          <text class="mini-label" x="10" y="19">${label}</text>
          <text class="mini-sub" x="10" y="33">${truncateCJK(node.detail || node.sublabel || '', 22)}</text>
        </g>`;
    })
    .join('');

  const edges = (graph?.edges || [])
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const sx = from.x + from.w / 2;
      const sy = from.y + from.h;
      const tx2 = to.x + to.w / 2;
      const ty2 = to.y;
      const midY = (sy + ty2) / 2;
      return `<path class="mini-edge" d="M${sx},${sy} C${sx},${midY} ${tx2},${midY} ${tx2},${ty2}" marker-end="url(#mini-arrow)"/>`;
    })
    .join('');

  container.innerHTML = `
    <svg class="mini-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:${height}px">
      <defs><marker id="mini-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path class="mini-arrow" d="M0,0 L8,4 L0,8 z"/></marker></defs>
      ${edges}
      ${nodeMarkup}
    </svg>`;
  if (onNodeClick) {
    container.querySelectorAll('.mini-node').forEach((element) => {
      element.style.cursor = 'pointer';
      element.addEventListener('click', () => {
        const node = nodes.find((item) => item.id === element.dataset.id);
        if (node) onNodeClick(node);
      });
    });
  }
}
