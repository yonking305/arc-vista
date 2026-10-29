import crypto from 'node:crypto';

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const round = (n, digits = 1) => {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
export const pct = (part, total) => (total > 0 ? (part / total) * 100 : 0);

export const sha1 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex');

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function shortHash(value, len = 7) {
  return String(value || '').slice(0, len);
}

export function sortBy(list, fn, dir = 'desc') {
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const av = fn(a);
    const bv = fn(b);
    if (av === bv) return 0;
    return av > bv ? sign : -sign;
  });
}

export function unique(list) {
  return [...new Set(list)];
}

export function groupBy(list, fn) {
  const map = new Map();
  for (const item of list) {
    const key = fn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function sum(list, fn = (x) => x) {
  let total = 0;
  for (const item of list) total += fn(item) || 0;
  return total;
}

/** Run `worker` over items with bounded concurrency, preserving order. */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: width }, runner));
  return results;
}

export function truncate(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

export function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function scoreLevel(score, thresholds = [40, 60, 80]) {
  if (score < thresholds[0]) return 'low';
  if (score < thresholds[1]) return 'moderate';
  if (score < thresholds[2]) return 'high';
  return 'severe';
}
