/* Dependency-free SVG chart primitives. */

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));

const TONE_COLORS = {
  good: 'var(--teal)',
  warn: 'var(--amber)',
  bad: 'var(--red)',
  info: 'var(--blue)',
  violet: 'var(--violet)',
  dim: 'var(--text-faint)',
};

export function toneColorFor(tone) {
  return TONE_COLORS[tone] || TONE_COLORS.dim;
}

function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function gaugePoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * 270° instrument gauge.
 * @param {number} value 0..max
 * @param {{size?:number, tone?:string, label?:string, sublabel?:string, unit?:string, max?:number, digits?:number}} opts
 */
export function gauge(value, opts = {}) {
  const {
    size = 210,
    tone = 'warn',
    label = '',
    sublabel = '',
    unit = '',
    max = 100,
    digits = 0,
  } = opts;
  const color = toneColorFor(tone);
  const cx = size / 2;
  const cy = size / 2;
  const stroke = Math.max(6, Math.round(size * 0.038));
  const r = size / 2 - stroke * 1.7;
  const circumference = 2 * Math.PI * r;
  const span = 0.75;
  const ratio = clamp(Number(value) / (max || 100), 0, 1);
  const filled = ratio * span * circumference;
  const display = Number(value);

  const ticks = [];
  for (let i = 0; i <= 10; i += 1) {
    const angle = 135 + (i / 10) * 270;
    const major = i % 5 === 0;
    const outer = r + stroke * 0.75;
    const inner = outer - (major ? 8 : 4);
    const a = gaugePoint(cx, cy, inner, angle);
    const b = gaugePoint(cx, cy, outer, angle);
    ticks.push(
      `<line class="${major ? 'tick-major' : 'tick'}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`,
    );
  }

  const scaleLabels = [
    { angle: 135, text: '0' },
    { angle: 270, text: String(Math.round(max / 2)) },
    { angle: 405, text: String(max) },
  ]
    .map(({ angle, text }) => {
      const p = gaugePoint(cx, cy, r - stroke * 2.4, angle);
      return `<text class="gauge-scale" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${text}</text>`;
    })
    .join('');

  return `
  <div class="gauge-wrap">
    <svg class="gauge" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label || '指标'} ${display}">
      <circle class="tick" cx="${cx}" cy="${cy}" r="${(size / 2 - 2).toFixed(1)}" fill="none" stroke-dasharray="1 5" opacity=".35"/>
      ${ticks.join('')}
      ${scaleLabels}
      <circle class="track" cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" stroke-width="${stroke}"
        stroke-dasharray="${(span * circumference).toFixed(2)} ${circumference.toFixed(2)}"
        transform="rotate(135 ${cx} ${cy})"/>
      <circle class="value-arc" cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" stroke-width="${stroke}"
        stroke-dasharray="${(span * circumference).toFixed(2)} ${circumference.toFixed(2)}"
        transform="rotate(135 ${cx} ${cy})"
        style="stroke:${color};stroke-dashoffset:${(span * circumference).toFixed(2)}"
        data-gauge-init="${(span * circumference).toFixed(2)}"
        data-gauge-target="${(span * circumference - filled).toFixed(2)}"/>
      <text class="gauge-number" x="${cx}" y="${cy + 2}" text-anchor="middle" dominant-baseline="middle">${Number.isFinite(display) ? display.toFixed(digits) : '—'}<tspan class="gauge-unit">${unit}</tspan></text>
      <text class="gauge-label" x="${cx}" y="${cy + size * 0.17}" text-anchor="middle">${label}</text>
    </svg>
    ${sublabel ? `<div class="help" style="text-align:center">${sublabel}</div>` : ''}
  </div>`;
}

/** Compact ring used on product cards. */
export function miniRing(value, { size = 58, tone = 'warn', label = '', unit = '%' } = {}) {
  const stroke = 3;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - stroke * 1.6;
  const c = 2 * Math.PI * r;
  const ratio = clamp(Number(value) / 100, 0, 1);
  const color = toneColorFor(tone);
  return `
  <div class="product-ring">
    <svg class="mini-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${stroke}"/>
      <circle class="value" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${stroke}"
        stroke-dasharray="${(ratio * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"
        style="stroke:${color}"/>
      <text class="num" x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle">${value === null || value === undefined ? '—' : Math.round(Number(value))}</text>
      <text class="unit" x="${cx}" y="${cy + 12}" text-anchor="middle">${unit}</text>
    </svg>
    <span class="ring-label">${label}</span>
  </div>`;
}

/** Radar chart for system shape. */
export function radar(dimensions, { size = 280, max = 100 } = {}) {
  const items = dimensions.filter((dimension) => Number.isFinite(Number(dimension.value)));
  if (items.length < 3) return '<div class="empty" style="padding:32px">数据不足以绘制雷达图</div>';
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 44;
  const count = items.length;

  const pointAt = (index, ratio) => {
    const angle = (360 / count) * index;
    const p = polar(cx, cy, radius * ratio, angle);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  };

  const rings = [0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const points = Array.from({ length: count }, (_, index) => pointAt(index, ratio)).join(' ');
      return `<polygon class="grid" points="${points}"/>`;
    })
    .join('');

  const axes = Array.from({ length: count }, (_, index) => {
    const [x, y] = pointAt(index, 1).split(',').map(Number);
    return `<line class="axis" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`;
  }).join('');

  const area = items.map((item, index) => pointAt(index, clamp(Number(item.value) / max, 0.02, 1))).join(' ');
  const points = items
    .map((item, index) => {
      const [x, y] = pointAt(index, clamp(Number(item.value) / max, 0.02, 1)).split(',').map(Number);
      return `<circle class="point" cx="${x}" cy="${y}" r="2.4"/>`;
    })
    .join('');

  const labels = items
    .map((item, index) => {
      const angle = (360 / count) * index;
      const p = polar(cx, cy, radius + 26, angle);
      const anchor = p.x > cx + 6 ? 'start' : p.x < cx - 6 ? 'end' : 'middle';
      return `<text class="label" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="${anchor}">${item.label}</text>`;
    })
    .join('');

  return `
  <svg class="radar" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="系统复杂度雷达图">
    ${rings}${axes}
    <polygon class="area" points="${area}"/>
    ${points}${labels}
  </svg>`;
}

/** Trigger the gauge sweep animation after markup is in the DOM. */
export function animateGauges(root = document) {
  requestAnimationFrame(() => {
    root.querySelectorAll('[data-gauge-init]').forEach((node) => {
      node.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.2,.9,.3,1)';
      node.style.strokeDashoffset = node.dataset.gaugeTarget || '0';
    });
  });
}

/** Horizontal two-sided bar for deltas. */
export function deltaBar(before, after, { max = 100, invert = false } = {}) {
  const safeMax = Math.max(max, before || 0, after || 0, 1);
  const beforeWidth = ((before || 0) / safeMax) * 100;
  const afterWidth = ((after || 0) / safeMax) * 100;
  const positive = invert ? after < before : after > before;
  return `
    <div class="delta-bar">
      <span class="mono faint" style="width:44px;text-align:right">${before ?? '—'}</span>
      <span class="db-track">
        <i style="left:0;width:${beforeWidth}%;background:rgb(var(--ink-rgb) / .3)"></i>
        <i style="left:0;width:${afterWidth}%;background:${positive ? 'var(--teal)' : 'var(--red)'};opacity:.85"></i>
      </span>
      <span class="mono" style="width:44px">${after ?? '—'}</span>
    </div>`;
}
