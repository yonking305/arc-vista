import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from './lib/store.js';
import { inspectProject, listBranches } from './lib/local-git.js';
import { Router, createServer, badRequest, notFound, readJsonBody } from './lib/http.js';
import { JobRunner } from './lib/jobs.js';
import { resolveLlmConfig, maskKey, testConnection } from './lib/llm.js';
import { analyzeRepository } from './lib/analyze/index.js';
import { analyzeModule } from './lib/analyze/drilldown.js';
import { diffSnapshots } from './lib/diff.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || VERSION;
} catch {
  /* package metadata is optional at runtime */
}
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.ARCVISTA_DATA ? path.resolve(process.env.ARCVISTA_DATA) : path.join(ROOT, 'data');
const PORT = Number(
  process.env.PORT ||
    process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] ||
    4321,
);
const HOST = process.env.HOST || '127.0.0.1';

/**
 * Build the complete ArcVista application (store, git cache, job runner, API
 * router) without binding an HTTP port. The standalone CLI below uses it, and
 * the DSH plugin mounts the same router on the Harness web server.
 */
export function createArcVistaApp({ dataDir = DATA_DIR, publicDir = PUBLIC_DIR, backupDir = null, llm = null, workspaces = () => [], directoryPicker = null } = {}) {
  const store = openStore(dataDir, backupDir ? { backupDir } : {});
  const jobs = new JobRunner(store);
  const interruptedJobs = store.jobs.interruptActive();
  if (interruptedJobs > 0) {
    console.log(`  \u001b[2m─\u001b[0m 已中断 ${interruptedJobs} 个上次未完成的任务（可在页面重新发起）`);
  }
  const router = new Router();

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function publicLlmSettings() {
  if (llm) {
    return {
      baseUrl: 'DSH',
      model: llm.model,
      mode: 'auto',
      temperature: Number(llm.temperature ?? 0.2),
      hasKey: false,
      apiKeyMasked: '',
      envKey: false,
      enabled: true,
      note: '由 DSH 提供模型',
    };
  }
  const raw = store.settings.all();
  const envKey = Boolean(process.env.ARCVISTA_LLM_API_KEY);
  const config = resolveLlmConfig(raw);
  return {
    baseUrl: raw.llm_base_url || '',
    model: raw.llm_model || '',
    mode: raw.llm_enabled || 'auto',
    temperature: Number(raw.llm_temperature),
    hasKey: Boolean(raw.llm_api_key),
    apiKeyMasked: maskKey(raw.llm_api_key),
    envKey,
    enabled: config.enabled,
    note: config.enabled ? '大模型已启用' : '未配置 Key，将使用启发式分析',
  };
}

function effectiveLlmConfig() {
  if (llm) return llm;
  const raw = store.settings.all();
  if (process.env.ARCVISTA_LLM_API_KEY) {
    return resolveLlmConfig({
      llm_base_url: process.env.ARCVISTA_LLM_BASE_URL || raw.llm_base_url,
      llm_api_key: process.env.ARCVISTA_LLM_API_KEY,
      llm_model: process.env.ARCVISTA_LLM_MODEL || raw.llm_model,
      llm_enabled: raw.llm_enabled,
      llm_temperature: raw.llm_temperature,
    });
  }
  return resolveLlmConfig(raw);
}

function productCard(product) {
  const latest = store.snapshots.latest(product.id);
  const job = jobs.latestByProduct(product.id);
  const active = store.jobs.activeByProduct(product.id);
  const snapshotCount = store.snapshots.count(product.id);
  const branchHints = [];
  if (latest) branchHints.push(latest.branch);
  return {
    ...product,
    repoUrl: product.path,
    path: product.path,
    repoKind: 'local',
    latest: latest
      ? {
          id: latest.id,
          branch: latest.branch,
          commit: latest.commit,
          analyzedAt: latest.analyzedAt,
          summary: latest.summary,
          engine: latest.engine,
        }
      : null,
    snapshotCount,
    job: job
      ? {
          id: job.id,
          kind: job.kind,
          branch: job.branch || null,
          status: job.status,
          progress: job.progress,
          message: job.message,
          error: job.error,
          createdAt: job.createdAt,
        }
      : null,
    activeJobCount: active.length,
    activeBranches: active.map((item) => item.branch).filter(Boolean),
    branches: [...new Set(branchHints)],
  };
}

function requireProduct(id) {
  const product = store.products.get(id);
  if (!product) throw notFound('产品不存在');
  return product;
}

function requireSnapshot(productId, snapshotId) {
  const snapshot = store.snapshots.get(snapshotId);
  if (!snapshot || snapshot.productId !== productId) throw notFound('分析快照不存在');
  return snapshot;
}

function startAnalyzeJob(product, { force = false } = {}) {
  return jobs.start({
    productId: product.id,
    kind: 'analyze',
    branch: null,
    run: async (ctx) => {
      const fresh = store.products.get(product.id);
      return analyzeRepository({
        store,
        product: fresh,
        force,
        llm: effectiveLlmConfig(),
        log: ctx.log,
        progress: ctx.progress,
      });
    },
  });
}

function branchJobSummary(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    branch: job.branch || null,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error || null,
    createdAt: job.createdAt,
  };
}

function buildBranchAnalysis({ branches, snapshots, jobList }) {
  const snapshotByBranch = new Map();
  for (const snapshot of snapshots) {
    if (!snapshotByBranch.has(snapshot.branch)) snapshotByBranch.set(snapshot.branch, snapshot);
  }
  const latestJobByBranch = new Map();
  for (const job of jobList) {
    if (!job.branch) continue;
    if (!latestJobByBranch.has(job.branch)) latestJobByBranch.set(job.branch, job);
  }
  const activeJobs = jobList.filter((job) => ['queued', 'running'].includes(job.status));
  const activeByBranch = new Map();
  for (const job of activeJobs) {
    if (job.branch && !activeByBranch.has(job.branch)) activeByBranch.set(job.branch, job);
  }
  const branchByName = new Map(branches.map((branch) => [branch.name, branch]));
  const rows = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const branchInfo = branchByName.get(name);
    const snapshot = snapshotByBranch.get(name);
    const active = activeByBranch.get(name);
    const last = latestJobByBranch.get(name);
    rows.push({
      branch: name,
      short: branchInfo?.short || snapshot?.commit?.short || snapshot?.commitShort || '',
      date: branchInfo?.date || snapshot?.commit?.date || '',
      subject: branchInfo?.subject || snapshot?.commit?.subject || '',
      analyzed: snapshot
        ? {
            snapshotId: snapshot.id,
            analyzedAt: snapshot.analyzedAt,
            engine: snapshot.engine,
            commitShort: snapshot.commit?.short || snapshot.commitShort || '',
            summary: snapshot.summary || null,
          }
        : null,
      activeJob: branchJobSummary(active),
      lastJob: branchJobSummary(last),
    });
  };
  for (const branch of branches) add(branch.name);
  for (const snapshot of snapshots) add(snapshot.branch);
  for (const job of jobList) if (job.branch) add(job.branch);
  return rows;
}

function snapshotOption(snapshot) {
  return {
    id: snapshot.id,
    branch: snapshot.branch,
    commit: snapshot.commit,
    analyzedAt: snapshot.analyzedAt,
    engine: snapshot.engine,
    summary: snapshot.summary,
  };
}

/** Directory browsing used when the host has no native OS chooser. */
function browseDirectory(inputPath) {
  let target = os.homedir();
  if (inputPath) {
    try {
      target = path.resolve(String(inputPath));
    } catch {
      target = os.homedir();
    }
    try {
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) target = path.dirname(target);
    } catch {
      target = os.homedir();
    }
  }
  let dirents = [];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    target = os.homedir();
    dirents = fs.readdirSync(target, { withFileTypes: true });
  }
  const entries = dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(target, entry.name),
      hidden: entry.name.startsWith('.'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
  const crumbs = [];
  let cursor = target;
  while (true) {
    crumbs.unshift({ name: path.basename(cursor) || cursor, path: cursor, hidden: false });
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return {
    path: target,
    home: os.homedir(),
    crumbs,
    entries,
    truncated: false,
  };
}

function pickerCapability() {
  try {
    const capability = directoryPicker?.();
    if (capability?.kind) return capability;
  } catch {
    /* fall through to the local browser */
  }
  return { kind: 'browse', list: async (target) => browseDirectory(target), createDirectory: null };
}

/* ------------------------------------------------------------------ */
/* routes                                                             */
/* ------------------------------------------------------------------ */

router.get('/api/health', () => ({
  ok: true,
  name: 'ArcVista',
  version: VERSION,
  storage: 'json',
  node: process.version,
  dataDir: store.dataDir,
  backups: store.backups.info(),
  llm: publicLlmSettings(),
  uptime: Math.round(process.uptime()),
}));

router.get('/api/directory-picker', () => {
  const capability = pickerCapability();
  return {
    available: Boolean(capability),
    kind: capability?.kind || null,
    native: capability?.kind === 'native',
  };
});

router.get('/api/directory-picker/list', async ({ query }) => {
  const capability = pickerCapability();
  if (capability?.kind !== 'browse' || typeof capability.list !== 'function') {
    throw badRequest('当前环境使用系统文件夹选择器');
  }
  return { listing: await capability.list(query.get('path') || undefined) };
});

router.post('/api/directory-picker/pick', async () => {
  const capability = pickerCapability();
  if (capability?.kind !== 'native' || typeof capability.pick !== 'function') {
    return { path: null, browse: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const picked = await capability.pick(controller.signal);
    return { path: picked || null };
  } finally {
    clearTimeout(timer);
  }
});

router.get('/api/workspaces', async () => {
  try {
    const list = await workspaces();
    return { workspaces: Array.isArray(list) ? list : [] };
  } catch {
    return { workspaces: [] };
  }
});

router.get('/api/products', () => ({ products: store.products.list().map(productCard) }));

function validateProjectPath(input) {
  const raw = String(input || '').trim();
  if (!raw) throw badRequest('本地项目目录不能为空');
  if (!path.isAbsolute(raw)) throw badRequest('请填写本地目录的绝对路径');
  let real;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw badRequest('目录不存在或无法访问，请检查路径');
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw badRequest('目录不存在或无法访问，请检查路径');
  }
  if (!stat.isDirectory()) throw badRequest('请选择目录，而不是文件');
  if (path.parse(real).root === real) throw badRequest('不能直接选择文件系统根目录，请选择具体项目');
  return real;
}

router.post('/api/products', async ({ req }) => {
  const body = await readJsonBody(req);
  const projectPath = validateProjectPath(body.path || body.repoUrl);
  const name = String(body.name || path.basename(projectPath)).trim();
  if (!name) throw badRequest('项目名称不能为空');
  if (name.length > 60) throw badRequest('项目名称不能超过 60 个字符');
  if (store.products.findByName(name)) throw badRequest('同名项目已存在，请换一个名称');
  if (store.products.findByPath(projectPath)) throw badRequest('这个本地目录已经是一个观测项目');
  const product = store.products.create({
    name,
    path: projectPath,
    description: String(body.description || '').slice(0, 300),
  });
  let info = null;
  try {
    info = await inspectProject(projectPath);
    if (info.branch) store.products.update(product.id, { defaultBranch: info.branch });
  } catch {
    /* a plain directory is valid too */
  }
  const job = startAnalyzeJob(product);
  return { product: productCard({ ...product, defaultBranch: info?.branch || '' }), job };
});

router.get('/api/products/:id', async ({ params }) => {
  const product = requireProduct(params.id);
  const projectPath = product.path;
  let repoReady = false;
  let branches = [];
  let defaultBranch = product.defaultBranch || '';
  try {
    repoReady = fs.statSync(projectPath).isDirectory();
  } catch {
    repoReady = false;
  }
  if (repoReady) {
    try {
      branches = await listBranches(projectPath);
      defaultBranch = branches[0]?.name || defaultBranch;
    } catch {
      branches = [];
    }
  }
  const snapshots = store.snapshots.listByProduct(product.id).map(snapshotOption);
  const jobList = jobs.listByProduct(product.id, 30);
  const activeJobs = jobList.filter((job) => ['queued', 'running'].includes(job.status));
  return {
    product: productCard(product),
    snapshots,
    jobs: jobList.slice(0, 12),
    activeJobs,
    branches,
    branchAnalysis: buildBranchAnalysis({ branches, snapshots, jobList }),
    repoReady,
    defaultBranch,
    llm: publicLlmSettings(),
  };
});

router.put('/api/products/:id', async ({ params, req }) => {
  const { readJsonBody } = await import('./lib/http.js');
  const product = requireProduct(params.id);
  const body = await readJsonBody(req);
  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw badRequest('产品名称不能为空');
    const existing = store.products.findByName(name);
    if (existing && existing.id !== product.id) throw badRequest('同名产品已存在');
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = String(body.description).slice(0, 300);
  if (body.path !== undefined) patch.path = validateProjectPath(body.path);
  if (body.defaultBranch !== undefined) patch.defaultBranch = String(body.defaultBranch).trim();
  return { product: productCard(store.products.update(product.id, patch)) };
});

router.delete('/api/products/:id', async ({ params }) => {
  const product = requireProduct(params.id);
  try {
    store.backups.create('before-delete');
  } catch {
    /* ignore backup failures on delete */
  }
  // Keep <project>/.arcvista/ artifacts; removing a project only detaches it
  // from the global ArcVista project list.
  store.products.remove(product.id);
  return { ok: true, deleted: product.id };
});

router.post('/api/products/:id/prepare', async ({ params }) => {
  const product = requireProduct(params.id);
  const job = startAnalyzeJob(product);
  return { job };
});

router.post('/api/products/:id/analyze', async ({ params, req }) => {
  const { readJsonBody } = await import('./lib/http.js');
  const product = requireProduct(params.id);
  const body = await readJsonBody(req);
  const force = Boolean(body.force);
  const job = startAnalyzeJob(product, { force });
  return { job };
});

router.get('/api/products/:id/branches', async ({ params }) => {
  const product = requireProduct(params.id);
  try {
    await fs.promises.access(product.path);
    return { branches: await listBranches(product.path), repoReady: true };
  } catch (error) {
    return { branches: [], repoReady: false, warning: error.message };
  }
});

router.get('/api/products/:id/snapshots', ({ params }) => {
  const product = requireProduct(params.id);
  return { snapshots: store.snapshots.listByProduct(product.id).map(snapshotOption) };
});

router.get('/api/products/:id/snapshots/:sid', ({ params }) => {
  requireProduct(params.id);
  const snapshot = requireSnapshot(params.id, params.sid);
  return {
    snapshot: {
      ...snapshotOption(snapshot),
      analysis: snapshot.analysis,
      durationMs: snapshot.durationMs,
      summary: snapshot.summary,
    },
    product: productCard(store.products.get(params.id)),
  };
});

router.post('/api/products/:id/modules/analyze', async ({ params, req }) => {
  const { readJsonBody } = await import('./lib/http.js');
  const product = requireProduct(params.id);
  const body = await readJsonBody(req);
  const snapshotId = String(body.snapshotId || '');
  const modulePath = String(body.modulePath || '');
  const question = body.question ? String(body.question).slice(0, 300) : '';
  if (!snapshotId) throw badRequest('缺少 snapshotId');
  if (!modulePath) throw badRequest('缺少 modulePath');
  const snapshot = requireSnapshot(product.id, snapshotId);
  const llm = effectiveLlmConfig();
  const job = jobs.start({
    productId: product.id,
    kind: 'drill',
    run: async (ctx) => {
      if (!question) {
        const cached = store.drill.get(snapshot.id, modulePath);
        if (cached) return { ...cached, cached: true };
      }
      const result = await analyzeModule({
        store,
        git,
        product,
        snapshot,
        modulePath,
        question,
        llm,
        log: ctx.log,
      });
      if (!question) {
        store.drill.put({
          productId: product.id,
          snapshotId: snapshot.id,
          modulePath,
          analysis: result,
        });
      }
      return result;
    },
  });
  return { job };
});

router.get('/api/jobs/:id', ({ params }) => {
  const job = jobs.get(params.id);
  if (!job) throw notFound('任务不存在');
  return { job };
});

router.get('/api/products/:id/jobs', ({ params }) => {
  requireProduct(params.id);
  return { jobs: jobs.listByProduct(params.id, 12) };
});

router.get('/api/products/:id/compare', ({ params, query }) => {
  const product = requireProduct(params.id);
  const baseId = query.get('base');
  const targetId = query.get('target');
  const baseBranch = query.get('baseBranch');
  const targetBranch = query.get('targetBranch');

  const resolve = (id, branch) => {
    if (id) return requireSnapshot(product.id, id);
    if (branch) return store.snapshots.latestByBranch(product.id, branch);
    return null;
  };
  const base = resolve(baseId, baseBranch);
  const target = resolve(targetId, targetBranch);
  if (!base || !target) {
    const missing = !base ? baseBranch || 'base' : targetBranch || 'target';
    throw notFound(`缺少可对比的快照（${missing}）。请先分析对应分支。`);
  }
  if (base.id === target.id) throw badRequest('请选择两个不同的快照进行对比');

  const diff = diffSnapshots(
    {
      id: base.id,
      branch: base.branch,
      commit_sha: base.commitSha,
      commit: base.commit,
      analyzedAt: base.analyzedAt,
      analysis: base.analysis,
    },
    {
      id: target.id,
      branch: target.branch,
      commit_sha: target.commitSha,
      commit: target.commit,
      analyzedAt: target.analyzedAt,
      analysis: target.analysis,
    },
  );
  return {
    diff,
    base: snapshotOption(base),
    target: snapshotOption(target),
    snapshots: store.snapshots.listByProduct(product.id).map(snapshotOption),
  };
});

router.post('/api/backup', () => {
  const backup = store.backups.create('manual');
  return { ok: true, backup, info: store.backups.info() };
});

router.get('/api/settings', () => ({
  llm: publicLlmSettings(),
  presets: [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  ],
  env: {
    key: Boolean(process.env.ARCVISTA_LLM_API_KEY),
    baseUrl: Boolean(process.env.ARCVISTA_LLM_BASE_URL),
    model: Boolean(process.env.ARCVISTA_LLM_MODEL),
  },
}));

router.put('/api/settings', async ({ req }) => {
  if (llm) return { llm: publicLlmSettings(), managed: 'dsh' };
  const body = await readJsonBody(req);
  const patch = {};
  if (body.baseUrl !== undefined) {
    const baseUrl = String(body.baseUrl).trim();
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw badRequest('Base URL 必须以 http(s):// 开头');
    patch.llm_base_url = baseUrl;
  }
  if (body.model !== undefined) patch.llm_model = String(body.model).trim();
  if (body.apiKey !== undefined) {
    const key = String(body.apiKey).trim();
    if (key && !key.includes('••')) patch.llm_api_key = key;
  }
  if (body.clearKey) patch.llm_api_key = '';
  if (body.mode !== undefined) patch.llm_enabled = ['auto', 'off'].includes(body.mode) ? body.mode : 'auto';
  if (body.temperature !== undefined) {
    const value = Number(body.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 1.5) throw badRequest('temperature 需在 0 - 1.5 之间');
    patch.llm_temperature = String(value);
  }
  store.settings.setMany(patch);
  return { llm: publicLlmSettings() };
});

router.post('/api/settings/test', async () => {
  if (llm) return { result: { ok: true, latencyMs: 0, model: llm.model, endpoint: 'DSH', message: '模型由 DSH 托管，无需单独配置' } };
  const config = effectiveLlmConfig();
  if (!config.enabled) throw badRequest('请先填写 Base URL、模型名与 API Key');
  return { result: await testConnection(config) };
});

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */


  return {
    store,
    jobs,
    router,
    publicDir,
    backupDir,
    getLlm: effectiveLlmConfig,
    getLlmSettings: publicLlmSettings,
    close: () => store.close(),
  };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
export let server = null;
export let store = null;
if (isMain) {
  const app = createArcVistaApp();
  store = app.store;
  server = createServer({ publicDir: app.publicDir, router: app.router });
  server.listen(PORT, HOST, () => {
    const settings = app.getLlmSettings();
    console.log('');
    console.log('  \u001b[38;5;214mArcVista\u001b[0m 架构观测台');
    console.log(`  \u001b[2m─\u001b[0m 地址   \u001b[36mhttp://${HOST}:${PORT}\u001b[0m`);
    console.log(`  \u001b[2m─\u001b[0m 数据   ${app.store.dataDir}`);
    console.log(`  \u001b[2m─\u001b[0m 模型   ${settings.enabled ? settings.model : 'DSH / 启发式'}`);
    console.log('');
  });
  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    server.close(() => {
      app.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
