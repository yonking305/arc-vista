import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './lib/db.js';
import { GitStore, classifyRepoUrl } from './lib/git.js';
import { Router, createServer, badRequest, notFound, readJsonBody } from './lib/http.js';
import { JobRunner } from './lib/jobs.js';
import { resolveLlmConfig, maskKey, testConnection } from './lib/llm.js';
import { analyzeRepository, prepareRepository } from './lib/analyze/index.js';
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
export function createArcVistaApp({ dataDir = DATA_DIR, publicDir = PUBLIC_DIR, backupDir = null, llm = null } = {}) {
  const store = openDatabase(dataDir, backupDir ? { backupDir } : {});
  // DSH manages the model. Remove legacy standalone model settings (including
  // any old API key) so upgrading to the plugin cannot retain a stale secret.
  if (llm?.provider === 'dsh') {
    try {
      store.db.prepare("DELETE FROM settings WHERE key LIKE 'llm_%'").run();
    } catch {
      /* best-effort cleanup for old databases */
    }
  }
  const git = new GitStore(dataDir);
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
    repoKind: classifyRepoUrl(product.repoUrl),
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

function startAnalyzeJob(product, { branch = null, force = false } = {}) {
  return jobs.start({
    productId: product.id,
    kind: 'analyze',
    branch,
    run: async (ctx) => {
      const fresh = store.products.get(product.id);
      return analyzeRepository({
        store,
        git,
        product: fresh,
        branch,
        force,
        llm: effectiveLlmConfig(),
        log: ctx.log,
        progress: ctx.progress,
      });
    },
  });
}

function startPrepareJob(product) {
  return jobs.start({
    productId: product.id,
    kind: 'prepare',
    run: async (ctx) => {
      const fresh = store.products.get(product.id);
      return prepareRepository({
        store,
        git,
        product: fresh,
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

/* ------------------------------------------------------------------ */
/* routes                                                             */
/* ------------------------------------------------------------------ */

router.get('/api/health', () => ({
  ok: true,
  name: 'ArcVista',
  version: VERSION,
  node: process.version,
  dataDir: path.dirname(store.file),
  backups: store.backups.info(),
  llm: publicLlmSettings(),
  uptime: Math.round(process.uptime()),
}));

router.get('/api/products', () => ({ products: store.products.list().map(productCard) }));

router.post('/api/products', async ({ req }) => {
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  const repoUrl = String(body.repoUrl || '').trim();
  if (!name) throw badRequest('产品名称不能为空');
  if (name.length > 60) throw badRequest('产品名称不能超过 60 个字符');
  if (!repoUrl) throw badRequest('Git 仓库地址不能为空');
  if (!/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/|\.\.?\/|[A-Za-z]:[\\/])/.test(repoUrl)) {
    throw badRequest('请填写有效的 Git 仓库地址（https://、git@ 或本地绝对路径）');
  }
  if (store.products.findByName(name)) throw badRequest('同名产品已存在，请换一个名称');
  const product = store.products.create({
    name,
    repoUrl,
    description: String(body.description || '').slice(0, 300),
    mirrorUrl: body.mirrorUrl ? String(body.mirrorUrl).trim() : undefined,
    defaultBranch: String(body.branch || 'main'),
  });
  const job = startPrepareJob(product);
  return { product: productCard(product), job };
});

router.get('/api/products/:id', async ({ params }) => {
  const product = requireProduct(params.id);
  let branches = [];
  let repoReady = false;
  if (git.hasUsableMirror(product.id)) {
    repoReady = true;
    try {
      branches = await git.listBranches(product.id);
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
    defaultBranch: product.defaultBranch,
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
  if (body.repoUrl !== undefined) patch.repoUrl = String(body.repoUrl).trim();
  if (body.mirrorUrl !== undefined) patch.mirrorUrl = String(body.mirrorUrl).trim();
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
  store.drill.removeByProduct(product.id);
  store.snapshots.removeByProduct(product.id);
  store.products.remove(product.id);
  await git.removeProduct(product.id).catch(() => {});
  return { ok: true, deleted: product.id };
});

router.post('/api/products/:id/prepare', async ({ params }) => {
  const product = requireProduct(params.id);
  const job = startPrepareJob(product);
  return { job };
});

router.post('/api/products/:id/analyze', async ({ params, req }) => {
  const { readJsonBody } = await import('./lib/http.js');
  const product = requireProduct(params.id);
  const body = await readJsonBody(req);
  const branch = body.branch ? String(body.branch) : null;
  const force = Boolean(body.force);
  if (!git.hasUsableMirror(product.id) && !product.repoUrl) throw badRequest('未配置仓库地址');
  const job = startAnalyzeJob(product, { branch, force });
  return { job };
});

router.get('/api/products/:id/branches', async ({ params }) => {
  const product = requireProduct(params.id);
  if (!git.hasUsableMirror(product.id)) return { branches: [], repoReady: false };
  try {
    return { branches: await git.listBranches(product.id), repoReady: true };
  } catch (error) {
    return { branches: [], repoReady: true, warning: error.message };
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
    git,
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
    console.log(`  \u001b[2m─\u001b[0m 数据   ${DATA_DIR}`);
    console.log(`  \u001b[2m─\u001b[0m 模型   ${settings.enabled ? `${settings.model} 已配置` : '未配置 Key（启发式模式）'}`);
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
