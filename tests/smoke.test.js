import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanRepo } from '../lib/analyze/walk.js';
import { detectModules } from '../lib/analyze/modules.js';
import { buildGraph } from '../lib/analyze/graph.js';
import { analyzeDeps } from '../lib/analyze/deps.js';
import { analyzeSecurity } from '../lib/analyze/security.js';
import { analyzeCoverage } from '../lib/analyze/coverage.js';
import { analyzeComplexity } from '../lib/analyze/complexity.js';
import { analyzeArchitecture } from '../lib/analyze/architecture.js';
import { analyzeKnowledge } from '../lib/analyze/knowledge.js';
import { extractJson } from '../lib/llm.js';
import { diffSnapshots } from '../lib/diff.js';
import { GitStore, isRetryableGitError } from '../lib/git.js';
import { openDatabase } from '../lib/db.js';
import { JobRunner } from '../lib/jobs.js';
import { chatJson } from '../lib/llm.js';
import { createArcVistaApp } from '../server.js';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-test-'));

function write(rel, content) {
  const target = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

write('package.json', JSON.stringify({
  name: 'demo-shop',
  dependencies: { express: '^4.19.0', jsonwebtoken: '^9.0.0', helmet: '^7.1.0' },
  devDependencies: { vitest: '^1.0.0' },
}, null, 2));
write('src/app.ts', `import express from 'express';\nimport { createOrder } from './order/order';\nimport { auth } from './auth';\nexport const app = express();\napp.use(auth);\napp.get('/api/orders', () => createOrder());\n`);
write('src/auth.ts', `import jwt from 'jsonwebtoken';\nexport function auth(req, res, next) { jwt.verify(req.token, 'secret'); next(); }\n`);
write('src/order/order.ts', `export function createOrder() {\n  if (Math.random() > 0.5) { return { ok: true }; }\n  return { ok: false };\n}\n`);
write('src/order/order.test.ts', `import { test, expect } from 'vitest';\nimport { createOrder } from './order';\ntest('creates order', () => { expect(createOrder()).toBeTruthy(); });\n`);
write('server/index.js', `const express = require('express');\nconst app = express();\napp.get('/health', (req, res) => res.json({ ok: true }));\napp.listen(3000);\n`);
write('server/routes.js', `const express = require('express');\nconst router = express.Router();\nrouter.get('/orders', (req, res) => res.json([]));\nmodule.exports = router;\n`);
write('docs/architecture.md', '# Demo\nA small demo system.');
write('Dockerfile', 'FROM node:22-alpine\nUSER node\nCMD ["node", "server/index.js"]');
write('docker-compose.yml', `services:\n  mysql:\n    image: mysql:8\n  redis:\n    image: redis:7\n`);
write('coverage/coverage-summary.json', JSON.stringify({
  total: {
    lines: { total: 100, covered: 72, skipped: 0, pct: 72 },
    branches: { total: 50, covered: 30, skipped: 0, pct: 60 },
    statements: { total: 120, covered: 90, skipped: 0, pct: 75 },
    functions: { total: 20, covered: 12, skipped: 0, pct: 60 },
  },
}));

test('scanRepo classifies files and projects', async () => {
  const repo = await scanRepo(fixture);
  assert.ok(repo.totals.files >= 8);
  assert.ok(repo.totals.sourceFiles >= 4);
  assert.ok(repo.projects.some((project) => project.type === 'node'));
  assert.equal(repo.read('package.json').includes('express'), true);
  assert.equal(repo.read('missing.ts'), null);
});

test('module + graph extraction found internal dependencies', async () => {
  const repo = await scanRepo(fixture);
  const modulesInfo = detectModules(repo);
  assert.ok(modulesInfo.modules.length >= 2);
  const graph = buildGraph(repo, modulesInfo);
  assert.ok(graph.fileEdges.length >= 2);
  assert.ok(graph.stats.internalFileEdges >= 2);
  assert.equal(modulesInfo.byFile.get('src/app.ts'), 'src');
});

test('all analyzers return contract-shaped, deterministic output', async () => {
  const repo = await scanRepo(fixture);
  const modulesInfo = detectModules(repo);
  const graph = buildGraph(repo, modulesInfo);
  const deps = analyzeDeps(repo);
  assert.ok(deps.packages.some((pkg) => pkg.name === 'express'));
  assert.ok(deps.ecosystems.some((ecosystem) => ecosystem.id === 'npm'));

  const security = analyzeSecurity(repo, { modulesInfo, graph, deps });
  assert.ok(security.guards.length >= 15);
  assert.ok(security.score >= 0 && security.score <= 100);
  assert.ok(['strong', 'moderate', 'weak', 'critical'].includes(security.level));
  assert.equal(JSON.stringify(security), JSON.stringify(analyzeSecurity(repo, { modulesInfo, graph, deps })));

  const coverage = analyzeCoverage(repo, { modulesInfo, graph, deps });
  assert.equal(coverage.measurable, true);
  assert.ok(coverage.line > 0);

  const complexity = analyzeComplexity(repo, { modulesInfo, graph, deps, churn: {} });
  assert.ok(complexity.score >= 0 && complexity.score <= 100);
  assert.ok(complexity.modules.length >= 2);
  assert.ok(Array.isArray(complexity.hotspots));

  const routes = [];
  const compose = { path: 'docker-compose.yml', services: [{ name: 'mysql', image: 'mysql:8', kind: 'mysql', label: 'MySQL', layer: 'database' }] };
  const architecture = analyzeArchitecture(repo, { modulesInfo, graph, deps, routes, compose, feign: [], complexity, coverage });
  assert.ok(architecture.nodes.length >= 2);
  assert.ok(architecture.layers.length >= 4);
  assert.ok(architecture.edges.every((edge) => architecture.nodes.some((node) => node.id === edge.from)));

  const knowledge = analyzeKnowledge(repo, { modulesInfo, routes, architecture, deps });
  assert.ok(knowledge.nodes.length >= 1);
  assert.ok(knowledge.stats.nodes === knowledge.nodes.length);
});

test('diff separates new risks from pre-existing risks', () => {
  const snapshot = (branch, patch) => ({
    id: `snap-${branch}`,
    branch,
    commit_sha: branch === 'main' ? 'a'.repeat(40) : 'b'.repeat(40),
    commit: { sha: 'a'.repeat(40), short: 'aaaaaaa', subject: branch, author: 't', date: '2026-01-01T00:00:00Z' },
    analyzedAt: '2026-01-01T00:00:00Z',
    analysis: {
      version: 1,
      meta: { stats: { sourceLoc: 1000 } },
      architecture: { nodes: [{ id: 'svc', label: 'Svc', layer: 'service', kind: 'service' }], edges: [], stats: {} },
      security: {
        score: 80,
        level: 'strong',
        guards: [{ id: 'authn', name: '认证', status: 'enforced', severity: 'high', ruleCount: 2 }],
        ruleSets: [{ id: 'semgrep', name: 'Semgrep', ruleCount: 5, rules: ['r1', 'r2'] }],
        totals: { guards: 1, rules: 7 },
      },
      coverage: { line: 70, measurable: true, testCount: 10, files: [] },
      complexity: { score: 40, modules: [{ path: 'svc', label: 'Svc', score: 40, loc: 1000 }], hotspots: [] },
      deps: { packages: [{ ecosystem: 'npm', name: 'react', version: '^18.0.0', dir: '.' }], stats: {} },
      knowledge: { domains: [], nodes: [], edges: [], stats: {} },
      fileIndex: [],
      risks: [],
      ...patch,
    },
  });

  const base = snapshot('main', {});
  const target = snapshot('feature', {
    meta: { stats: { sourceLoc: 1400 } },
    security: {
      score: 80,
      level: 'strong',
      guards: [{ id: 'authn', name: '认证', status: 'enforced', severity: 'high', ruleCount: 2 }],
      ruleSets: [{ id: 'semgrep', name: 'Semgrep', ruleCount: 3, rules: ['r1'] }],
      totals: { guards: 1, rules: 5 },
    },
    coverage: { line: 62, measurable: true, testCount: 8, files: [] },
    complexity: { score: 52, modules: [{ path: 'svc', label: 'Svc', score: 52, loc: 1400 }], hotspots: [] },
    deps: { packages: [{ ecosystem: 'npm', name: 'react', version: '^19.0.0', dir: '.' }], stats: {} },
    risks: [{ id: 'r1', level: 'high', category: '安全', title: '存量问题', detail: '', action: '' }],
  });

  const diff = diffSnapshots(base, target);
  assert.ok(diff.verdict.score < 0);
  assert.ok(diff.riskScore > 0);
  assert.ok(diff.risks.some((risk) => risk.level === 'high'));
  assert.ok(diff.risks.some((risk) => risk.source === 'target'));
  assert.ok(diff.existingRisks.length >= 1);
  assert.ok(diff.dependencies.upgraded.some((item) => item.name === 'react' && item.major));
  assert.ok(diff.security.ruleSets.some((set) => set.removed.includes('r2')));

  const stable = diffSnapshots(base, snapshot('main', {}));
  assert.equal(stable.verdict.level, 'stable');
  assert.equal(stable.riskScore, 0);
  assert.equal(stable.risks.length, 0);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前言 {"a":{"b":2}} 结尾'), { a: { b: 2 } });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"broken": '), null);
});


test('git errors are classified for retry', () => {
  const timeout = Object.assign(new Error('fatal: unable to access: Operation timed out'), { timedOut: true });
  assert.equal(isRetryableGitError(timeout), true);
  assert.equal(isRetryableGitError(new Error('fatal: unable to access https://x: Could not resolve host: github.com')), true);
  assert.equal(isRetryableGitError(new Error('error: RPC failed; HTTP 502')), true);
  assert.equal(isRetryableGitError(new Error('remote: Repository not found')), false);
  assert.equal(isRetryableGitError(new Error('Authentication failed for https://x')), false);
  assert.equal(isRetryableGitError(new Error('fatal: not a git repository')), false);
});

test('git mirror clone retries transient failures with backoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-git-retry-'));
  let calls = 0;
  let cloneCalls = 0;
  const logs = [];
  const run = async (args) => {
    calls += 1;
    if (args[0] === 'clone') {
      cloneCalls += 1;
      if (cloneCalls <= 2) {
        const error = new Error('fatal: unable to access: Connection reset by peer');
        error.timedOut = true;
        throw error;
      }
    }
    if (args.includes('symbolic-ref')) return 'main\n';
    return '';
  };
  const store = new GitStore(dir, { run, retryAttempts: 3, retryDelayMs: 5 });
  const result = await store.ensureMirror({ id: 'test', repoUrl: 'https://example.com/demo.git' }, (message) => logs.push(message));
  assert.equal(result.defaultBranch, 'main');
  assert.equal(cloneCalls, 3);
  assert.ok(calls >= 3);
  assert.ok(logs.some((line) => /自动重试/.test(line)));
  assert.ok(logs.some((line) => /重试克隆/.test(line)));
});

test('git retry gives up after configured attempts with a resumable hint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-git-fail-'));
  let calls = 0;
  const run = async () => {
    calls += 1;
    const error = new Error('fatal: unable to access: Operation timed out after 900000 milliseconds');
    error.timedOut = true;
    throw error;
  };
  const store = new GitStore(dir, { run, retryAttempts: 3, retryDelayMs: 5 });
  await assert.rejects(
    store.ensureMirror({ id: 'fail', repoUrl: 'https://example.com/demo.git' }, () => {}),
    /已自动尝试 3 次.*重试分析/,
  );
  assert.equal(calls, 3);
});


test('database backups survive data-dir loss and auto-restore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-backup-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  let store = openDatabase(dataDir, { backupDir });
  const product = store.products.create({ name: '云端商城', repoUrl: 'https://github.com/demo/shop.git' });
  store.products.create({ name: '交易中心', repoUrl: 'https://github.com/demo/trade.git' });
  const backup = store.backups.create('test');
  assert.ok(fs.existsSync(backup.file));
  assert.equal(store.backups.info().count, 1);
  store.close();

  fs.rmSync(dataDir, { recursive: true, force: true });
  store = openDatabase(dataDir, { backupDir });
  assert.ok(store.backups.restoredFrom);
  assert.equal(store.products.get(product.id).name, '云端商城');
  assert.equal(store.products.list().length, 2);
  store.close();
});


test('job runner queues per-product branches and drains in order', async () => {
  const rows = new Map();
  const store = {
    jobs: {
      upsert(job) {
        rows.set(job.id, { ...job });
      },
      get(id) {
        const job = rows.get(id);
        return job ? { ...job, logs: job.logs || [] } : null;
      },
      listByProduct() {
        return [];
      },
      latestByProduct() {
        return null;
      },
    },
  };
  const runner = new JobRunner(store, { logger: { error() {} } });
  const order = [];
  const first = runner.start({
    productId: 'p1',
    kind: 'analyze',
    branch: 'main',
    run: async () => {
      order.push('main');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { snapshotId: 's1' };
    },
  });
  const second = runner.start({
    productId: 'p1',
    kind: 'analyze',
    branch: 'feature/demo',
    run: async () => {
      order.push('feature/demo');
      return { snapshotId: 's2' };
    },
  });
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  assert.equal(second.branch, 'feature/demo');
  assert.equal(runner.queueDepth('p1'), 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(order, ['main', 'feature/demo']);
  assert.equal(runner.get(first.id).status, 'done');
  assert.equal(runner.get(second.id).status, 'done');
});

test('unfinished jobs are marked interrupted on startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-jobs-'));
  const store = openDatabase(path.join(root, 'data'), { backupDir: path.join(root, 'backups') });
  const stamp = new Date().toISOString();
  for (const [id, status] of [['job_running', 'running'], ['job_queued', 'queued'], ['job_done', 'done']]) {
    store.jobs.upsert({
      id,
      productId: null,
      kind: 'analyze',
      branch: 'main',
      status,
      progress: 10,
      message: status,
      logs: [],
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  assert.equal(store.jobs.interruptActive(), 2);
  assert.equal(store.jobs.get('job_running').status, 'error');
  assert.equal(store.jobs.get('job_queued').status, 'error');
  assert.equal(store.jobs.get('job_done').status, 'done');
  assert.match(store.jobs.get('job_running').error, /服务重启/);
  store.close();
});


test('chatJson uses an injected DSH model bridge', async () => {
  const result = await chatJson(
    { chat: async ({ maxTokens }) => JSON.stringify({ ok: true, maxTokens }) },
    { system: 's', user: 'u', maxTokens: 42, jsonMode: true },
  );
  assert.deepEqual(result.data, { ok: true, maxTokens: 42 });
  assert.equal(result.usage, null);
});

test('createArcVistaApp mounts without binding a port', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-app-'));
  const app = createArcVistaApp({
    dataDir: path.join(root, 'data'),
    backupDir: path.join(root, 'backups'),
    llm: { enabled: true, model: 'dsh-test', temperature: 0.2, chat: async () => '{"ok":true}' },
  });
  assert.equal(app.router.match('GET', '/api/health') !== null, true);
  assert.equal(app.getLlmSettings().baseUrl, 'DSH');
  assert.equal(app.getLlm().model, 'dsh-test');
  app.close();
});
