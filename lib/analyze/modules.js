import path from 'node:path';
import { sum } from '../util.js';

const SERVICE_LABELS = [
  [/gateway/, '网关'],
  [/user|account|identity|auth/, '用户'],
  [/order|checkout|trade/, '订单'],
  [/product|catalog|sku|goods/, '商品'],
  [/finance|payment|pay|billing|wallet/, '支付'],
  [/logistics|shipment|delivery|warehouse|inventory/, '物流'],
  [/analytics|insight|report|stat/, '分析'],
  [/search/, '搜索'],
  [/cart/, '购物车'],
  [/notify|notification|message|mq/, '消息'],
  [/review|comment/, '评价'],
  [/coupon|promotion|marketing/, '营销'],
  [/common|shared|core|util|infra|kit/, '公共'],
];

const CLIENT_LABELS = [
  [/admin/, '管理后台'],
  [/shop|mall|web|storefront/, '商城前台'],
  [/miniapp|mini|weapp|taro/, '小程序'],
  [/app|mobile|native|expo/, '移动端'],
  [/console|dashboard|portal/, '控制台'],
];

function humanize(name) {
  return String(name)
    .replace(/^@[^/]+\//, '')
    .replace(/^(mall|cloudmall|cloud|ms|svc|service|app)[-_]/i, '')
    .replace(/[-_](service|server|api|app|module|lib|core|web)$/i, '')
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Stable, human-facing Chinese label for a module directory.
 * Unknown names fall back to a readable latin label, never a raw path.
 */
export function labelForModule(dir, options = {}) {
  const parts = dir.split('/').filter(Boolean);
  const name = options.name || parts[parts.length - 1] || options.packageName || '根目录';
  const isClient = /^(frontend|web|apps?|clients?|ui)$/.test(parts[0] || '') ||
    (options.group || '') === 'frontend' ||
    /(react|vue|next|taro|expo|svelte)/.test(options.packageName || '');
  const isSharedLib = parts.some((part) => /(^|[-_])(common|commons|shared|lib|libs|core|sdk|packages?|components?)([-_]|$)/i.test(part));
  if (isSharedLib && !/apps?$/i.test(parts[parts.length - 1] || '')) {
    return isClient ? '共享组件' : '公共组件';
  }
  const dictionary = isClient ? CLIENT_LABELS : SERVICE_LABELS;
  const haystack = `${name} ${parts.slice(-2).join(' ')}`.toLowerCase();
  for (const [regex, label] of dictionary) {
    if (regex.test(haystack)) {
      const suffix = isClient ? '' : '服务';
      if (label === '公共' || label === '网关') return label;
      return `${label}${suffix}`;
    }
  }
  return humanize(name);
}

function sourceUnder(repo, dir) {
  const prefix = dir === '.' || dir === '' ? '' : `${dir}/`;
  return repo.files.filter(
    (file) => (file.kind === 'source' || file.kind === 'test') && (!prefix || file.path.startsWith(prefix)),
  );
}

function directSourceUnder(repo, dir, candidates) {
  const prefix = dir === '.' || dir === '' ? '' : `${dir}/`;
  const nested = candidates
    .filter((other) => other !== dir && (prefix ? other.startsWith(prefix) : other !== '.'))
    .map((other) => `${other}/`);
  return repo.files.filter((file) => {
    if (file.kind !== 'source' && file.kind !== 'test') return false;
    if (prefix && !file.path.startsWith(prefix)) return false;
    return !nested.some((n) => file.path.startsWith(n));
  });
}

function groupOf(dir, manifestType) {
  const first = dir.split('/')[0] || '';
  if (/^(frontend|web|apps?|clients?|ui)$/.test(first)) return 'frontend';
  if (/^(backend|services?|server|app|api)$/.test(first)) return 'backend';
  if (manifestType === 'node') return 'frontend';
  return 'backend';
}

/**
 * Detect the module boundary of every product module. Uses build manifests when
 * present, falls back to top-level source directories (e.g. a plain script repo).
 */
export function detectModules(repo) {
  const projectDirs = [...new Set(repo.projects.map((project) => project.dir))].filter(
    (dir) => dir !== '' || repo.projects.length === 1,
  );
  let candidates = projectDirs.filter((dir) => sourceUnder(repo, dir).length > 0);
  if (candidates.length === 0) {
    const topDirs = new Set();
    for (const file of repo.files) {
      if (file.kind !== 'source' && file.kind !== 'test') continue;
      const first = file.path.includes('/') ? file.path.split('/')[0] : '.';
      topDirs.add(first);
    }
    candidates = [...topDirs].filter((dir) => sourceUnder(repo, dir).length > 0);
    if (candidates.length === 0) candidates = ['.'];
  }

  // Drop aggregator projects (parents that only contain other modules).
  const kept = candidates.filter((dir) => {
    const nested = candidates.filter((other) => other !== dir && other.startsWith(`${dir}/`));
    return nested.length === 0;
  });
  const selected = kept.length > 0 ? kept : candidates;

  // A single root project (e.g. one package.json for a full-stack repo) is split
  // into its top-level source directories so the architecture map still has structure.
  let finalDirs = selected;
  if (selected.length === 1 && (selected[0] === '.' || selected[0] === '')) {
    const counts = new Map();
    for (const file of repo.files) {
      if (file.kind !== 'source' && file.kind !== 'test') continue;
      if (!file.path.includes('/')) continue;
      const top = file.path.split('/')[0];
      counts.set(top, (counts.get(top) || 0) + 1);
    }
    const topDirs = [...counts.entries()].filter(([, count]) => count >= 2).map(([dir]) => dir);
    if (topDirs.length >= 2) finalDirs = topDirs;
  }

  // Root-level project only wins when nothing else matched.
  const pruned = finalDirs.filter((dir) => dir !== '.' || finalDirs.length === 1);

  const modules = pruned.map((dir) => {
    const files = sourceUnder(repo, dir);
    const sourceFiles = files.filter((file) => file.kind === 'source');
    const testFiles = files.filter((file) => file.kind === 'test');
    const manifest = repo.projects.find((project) => project.dir === dir);
    const pkgJson = dir === '' || dir === '.' ? repo.readJson('package.json') : repo.readJson(`${dir}/package.json`);
    const langs = new Map();
    for (const file of sourceFiles) {
      if (!file.lang) continue;
      langs.set(file.lang, (langs.get(file.lang) || 0) + 1);
    }
    const module = {
      id: dir || '.',
      path: dir || '.',
      name: (dir.split('/').pop() || pkgJson?.name || repo.root.split('/').pop() || 'root'),
      packageName: pkgJson?.name || null,
      type: manifest?.type || (pkgJson ? 'node' : 'generic'),
      group: groupOf(dir, manifest?.type),
      label: '',
      files: files.length,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      loc: sum(files, (file) => file.loc),
      sourceLoc: sum(sourceFiles, (file) => file.loc),
      testLoc: sum(testFiles, (file) => file.loc),
      langs: [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([lang, count]) => ({ lang, count })),
      parentId: null,
    };
    module.label = labelForModule(dir, { name: module.name, packageName: pkgJson?.name, group: module.group });
    return module;
  });

  // Assign parent relationships by nearest ancestor module.
  for (const module of modules) {
    if (module.id === '.') continue;
    const ancestors = modules
      .filter((other) => other !== module && module.id.startsWith(`${other.id}/`))
      .sort((a, b) => b.id.length - a.id.length);
    module.parentId = ancestors[0]?.id ?? null;
  }

  const byFile = new Map();
  const sorted = [...modules].sort((a, b) => b.path.length - a.path.length);
  for (const file of repo.files) {
    if (file.kind !== 'source' && file.kind !== 'test') continue;
    const owner = sorted.find((module) => module.id === '.' || file.path.startsWith(`${module.id}/`));
    byFile.set(file.path, owner?.id ?? '.');
  }

  const moduleMap = new Map(modules.map((module) => [module.id, module]));
  return { modules, moduleMap, byFile };
}

/** Directory depth based fallback used when a module has no manifest. */
export function parentDir(rel) {
  const dir = path.posix.dirname(rel);
  return dir === '.' ? '' : dir;
}
