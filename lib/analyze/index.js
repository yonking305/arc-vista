import { scanRepo } from './walk.js';
import { detectModules } from './modules.js';
import { buildGraph } from './graph.js';
import { analyzeDeps } from './deps.js';
import { analyzeSecurity } from './security.js';
import { analyzeCoverage } from './coverage.js';
import { analyzeComplexity } from './complexity.js';
import { analyzeArchitecture } from './architecture.js';
import { analyzeKnowledge } from './knowledge.js';
import { extractRoutes, extractFeign, parseCompose } from './evidence.js';
import {
  buildEvidence,
  mergeHeuristicAnalysis,
  enrichWithLlm,
} from './enrich.js';

function moduleChurn(churn, modulesInfo) {
  const result = {};
  if (!churn?.fileCommits) return result;
  for (const module of modulesInfo.modules) result[module.id] = 0;
  for (const [file, count] of churn.fileCommits) {
    const moduleId = modulesInfo.byFile.get(file);
    if (!moduleId) continue;
    result[moduleId] = (result[moduleId] || 0) + count;
  }
  return result;
}

function buildSummary({ analysis, product }) {
  const { security, coverage, complexity, knowledge, architecture, risks } = analysis;
  const riskCounts = { high: 0, medium: 0, low: 0 };
  for (const risk of risks || []) riskCounts[risk.level] = (riskCounts[risk.level] || 0) + 1;
  return {
    overview: analysis.meta.overview,
    engine: analysis.meta.engine.kind,
    branch: analysis.meta.branch,
    commitShort: analysis.meta.commit.short,
    security: {
      score: security.score,
      level: security.level,
      guards: security.totals.guards,
      enforced: security.totals.enforced,
      missing: security.totals.missing,
      rules: security.totals.rules,
    },
    coverage: {
      line: coverage.line,
      estimated: coverage.estimated,
      measurable: coverage.measurable,
      testCount: coverage.testCount,
      testFiles: coverage.testFiles,
      sourceFiles: coverage.sourceFiles,
    },
    complexity: {
      score: complexity.score,
      level: complexity.level,
      modules: complexity.totals.modules,
      hotspots: (complexity.hotspots || []).slice(0, 3).map((hotspot) => ({
        path: hotspot.path,
        label: hotspot.label,
        score: hotspot.score,
      })),
    },
    knowledge: {
      domains: knowledge.stats.domains,
      capabilities: knowledge.stats.capabilities,
      entities: knowledge.stats.entities,
      apis: knowledge.stats.apis,
      events: knowledge.stats.events,
      nodes: knowledge.stats.nodes,
      edges: knowledge.stats.edges,
    },
    architecture: {
      nodes: architecture.stats.nodes,
      edges: architecture.stats.edges,
      services: architecture.stats.services,
      clients: architecture.stats.clients,
      datastores: architecture.stats.datastores,
    },
    risks: { ...riskCounts, total: (risks || []).length },
    deps: analysis.deps.stats,
    stats: analysis.meta.stats,
  };
}

/**
 * Clone/fetch the repository mirror and list remote branches WITHOUT running
 * the expensive analysis. The UI uses this as the first step after adding a repo,
 * so the user can see progress and then choose which branches to analyse.
 */
export async function prepareRepository({ store, git, product, log, progress }) {
  const startedAt = Date.now();
  progress(3, '准备仓库');
  log(`准备仓库 ${product.repoUrl}`);
  let mirrorHigh = 0;
  const { defaultBranch } = await git.ensureMirror(
    product,
    (message, level) => log(message, level),
    (info) => {
      const percent = Number(info?.percent) || 0;
      mirrorHigh = Math.max(mirrorHigh, percent);
      progress(5 + Math.round(mirrorHigh * 0.6), `拉取仓库 · ${info.detail || `${percent}%`}`);
    },
  );
  if (defaultBranch && defaultBranch !== product.defaultBranch) {
    store.products.update(product.id, { defaultBranch });
  }
  progress(70, '读取分支列表');
  const branches = await git.listBranches(product.id).catch(() => []);
  log(`仓库已就绪，检测到 ${branches.length} 个分支`);
  progress(100, '仓库已就绪');
  return {
    defaultBranch: defaultBranch || product.defaultBranch,
    branchCount: branches.length,
    branches: branches.slice(0, 120).map((branch) => ({
      name: branch.name,
      short: branch.short,
      date: branch.date,
      subject: branch.subject,
    })),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Full repository analysis: mirrors the repo, checks out one commit, runs every
 * collector, optionally enriches with the LLM, then persists a snapshot.
 */
export async function analyzeRepository({ store, git, product, branch, force = false, llm, log, progress }) {
  const startedAt = Date.now();
  const warnings = [];

  progress(3, '准备仓库镜像');
  log(`准备分析 ${product.name}`);
  let mirrorHigh = 0;
  const { defaultBranch } = await git.ensureMirror(
    product,
    (message, level) => log(message, level),
    (info) => {
      const percent = Number(info?.percent) || 0;
      mirrorHigh = Math.max(mirrorHigh, percent);
      progress(3 + Math.round(mirrorHigh * 0.05), `准备仓库 · ${info.detail || `${percent}%`}`);
    },
  );
  const targetBranch = branch || defaultBranch || product.defaultBranch || 'main';
  if (defaultBranch && defaultBranch !== product.defaultBranch) {
    store.products.update(product.id, { defaultBranch });
  }
  log(`目标分支 ${targetBranch}`);

  progress(8, '解析提交');
  const sha = await git.resolveRef(product.id, targetBranch);
  const commit = await git.commitInfo(product.id, sha);
  log(`提交 ${commit.short} · ${commit.subject}`);

  if (!force) {
    const existing = store.snapshots.findByCommit(product.id, sha);
    if (existing) {
      log(`该提交已有分析快照（${existing.id}），直接复用`);
      progress(100, '已存在快照');
      return { snapshotId: existing.id, reused: true, branch: existing.branch, commit: existing.commit, summary: existing.summary };
    }
  }

  progress(13, '检出代码');
  const worktree = await git.ensureWorktree(product.id, sha, (message) => log(message));
  await git.pruneWorktrees(product.id, [sha]).catch(() => {});

  progress(20, '扫描仓库文件');
  const repo = await scanRepo(worktree);
  log(`扫描到 ${repo.totals.files} 个文件 / ${repo.totals.sourceFiles} 个源文件 / ${repo.totals.sourceLoc} 行代码`);
  if (repo.truncated) {
    warnings.push('仓库文件数量超过扫描上限，部分文件被忽略');
    log('仓库较大，已按上限截断扫描', 'warn');
  }

  progress(28, '识别模块与依赖');
  const modulesInfo = detectModules(repo);
  const deps = analyzeDeps(repo);
  const graph = buildGraph(repo, modulesInfo);
  const routes = extractRoutes(repo, modulesInfo);
  const compose = parseCompose(repo);
  const feign = extractFeign(repo, modulesInfo);
  log(`识别 ${modulesInfo.modules.length} 个模块、${deps.packages.length} 个依赖声明、${routes.length} 个接口`);

  progress(38, '计算安全守护');
  const security = analyzeSecurity(repo, { modulesInfo, graph, deps });
  log(`安全守护 ${security.totals.guards} 项，评分 ${security.score}`);

  progress(46, '解析测试覆盖率');
  const coverage = analyzeCoverage(repo, { modulesInfo, graph, deps });
  log(coverage.measurable ? `解析到真实覆盖率：${coverage.line}%` : `未发现覆盖率产物，估算覆盖 ${coverage.line}%`);

  progress(52, '度量系统复杂度');
  const churn = await git.fileChurn(product.id, sha).catch(() => ({ commits: 0, fileCommits: new Map() }));
  const complexity = analyzeComplexity(repo, {
    modulesInfo,
    graph,
    deps,
    churn: moduleChurn(churn, modulesInfo),
  });
  log(`系统复杂度 ${complexity.score}，热点 ${(complexity.hotspots || []).slice(0, 3).map((item) => item.label).join('、')}`);

  progress(60, '生成架构图与知识图谱');
  const architecture = analyzeArchitecture(repo, {
    modulesInfo,
    graph,
    deps,
    routes,
    compose,
    feign,
    complexity,
    coverage,
  });
  const knowledge = analyzeKnowledge(repo, {
    modulesInfo,
    routes,
    architecture,
    deps,
  });
  log(`架构图 ${architecture.stats.nodes} 节点 / ${architecture.stats.edges} 连接；知识图谱 ${knowledge.stats.nodes} 节点`);

  progress(68, '评估风险');
  const heuristic = mergeHeuristicAnalysis({
    architecture,
    knowledge,
    security,
    complexity,
    coverage,
    deps,
    repo,
    product,
    snapshot: { branch: targetBranch, commit },
  });
  log(`启发式识别 ${heuristic.risks.length} 条风险`);

  let enriched = {
    architecture,
    knowledge,
    risks: heuristic.risks,
    recommendations: heuristic.recommendations,
    moduleInsights: heuristic.moduleInsights,
    overview: heuristic.overview,
  };
  let engineKind = 'heuristic';
  let llmMeta = { enabled: Boolean(llm?.enabled), model: llm?.model || null, warnings: [] };

  if (llm?.enabled) {
    progress(74, `大模型增强分析（${llm.model}）`);
    log(`调用大模型 ${llm.model} 做语义增强`);
    try {
      const evidence = buildEvidence({
        product,
        snapshot: { branch: targetBranch, commit },
        repo,
        modulesInfo,
        deps,
        architecture,
        knowledge,
        security,
        complexity,
        coverage,
        routes,
        graph,
        compose,
      });
      const result = await enrichWithLlm({ config: llm, evidence, architecture, knowledge, heuristic });
      enriched = result;
      engineKind = 'llm';
      llmMeta = {
        enabled: true,
        model: llm.model,
        warnings: [],
        usage: result.usage,
        overviewSource: 'llm',
      };
      log('大模型语义增强完成');
    } catch (error) {
      llmMeta = { enabled: true, model: llm.model, warnings: [`大模型增强失败：${error.message}`], failed: true };
      log(`大模型增强失败，回退启发式结果：${error.message}`, 'warn');
      if (process.env.ARCVISTA_DEBUG && error.detail) log(`大模型返回片段：${error.detail}`, 'warn');
    }
  } else {
    warnings.push('未配置可用的大模型 Key，使用启发式分析（可在设置中配置）');
    log('未配置大模型 Key，使用启发式分析', 'warn');
  }

  progress(88, '整理快照');
  const analyzedAt = new Date().toISOString();
  const analysis = {
    version: 1,
    meta: {
      productName: product.name,
      repoUrl: product.repoUrl,
      branch: targetBranch,
      commit,
      analyzedAt,
      durationMs: Date.now() - startedAt,
      stats: {
        files: repo.totals.files,
        sourceFiles: repo.totals.sourceFiles,
        testFiles: repo.totals.testFiles,
        loc: repo.totals.loc,
        sourceLoc: repo.totals.sourceLoc,
        testLoc: repo.totals.testLoc,
        modules: modulesInfo.modules.length,
        packages: deps.stats.packages,
        endpoints: routes.length,
        languages: repo.languages.slice(0, 6),
      },
      engine: {
        kind: engineKind,
        model: llmMeta.model,
        warnings: [...warnings, ...(llmMeta.warnings || [])],
        durationMs: Date.now() - startedAt,
      },
      overview: enriched.overview,
    },
    architecture: enriched.architecture,
    security,
    knowledge: enriched.knowledge,
    complexity,
    coverage,
    deps,
    modules: modulesInfo.modules,
    risks: enriched.risks,
    recommendations: enriched.recommendations,
    moduleInsights: enriched.moduleInsights,
    fileIndex: repo.files
      .filter((file) => file.kind === 'source' || file.kind === 'test')
      .slice(0, 6000)
      .map((file) => ({
        path: file.path,
        loc: file.loc,
        kind: file.kind,
        module: modulesInfo.byFile.get(file.path) || null,
      })),
    notes: architecture.notes,
  };

  progress(94, '保存快照');
  const summary = buildSummary({ analysis, product });
  const snapshotId = store.snapshots.insert({
    id: force ? store.snapshots.findByCommit(product.id, sha)?.id : undefined,
    productId: product.id,
    branch: targetBranch,
    commit,
    analyzedAt,
    engine: engineKind,
    durationMs: Date.now() - startedAt,
    summary,
    analysis,
  });
  store.products.touch(product.id);
  try {
    store.backups?.maybeCreate?.('analysis', 120000);
  } catch {
    /* backups must never break an analysis */
  }
  await git.pruneWorktrees(product.id, [sha]).catch(() => {});

  log(`快照已保存，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  progress(100, '分析完成');
  return {
    snapshotId,
    reused: false,
    branch: targetBranch,
    commit,
    summary,
    engine: { kind: engineKind, model: llmMeta.model, warnings: analysis.meta.engine.warnings },
    durationMs: Date.now() - startedAt,
  };
}
