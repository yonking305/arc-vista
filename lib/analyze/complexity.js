/**
 * 复杂度分析：系统分 + 模块级指标 + 可执行热点。
 *
 * 只用真实可计算的信号：
 * - LOC / 文件数 / 单文件最大行数（来自 walk 的统计）
 * - 分支密度（if/else/for/while/case/catch、&&、||、? 的出现次数 / 千行源码）
 * - fan-in / fan-out（由 graph.fileEdges 聚合到模块）
 * - churn（ctx.churn 可选；缺失按 0 处理，不臆造提交次数）
 *
 * 输出确定性、无第三方依赖，缺失上下文时自动降级，不抛错。
 */
import { clamp, scoreLevel } from '../util.js';
import { detectModules } from './modules.js';
import { buildGraph } from './graph.js';

const STYLE_LANGS = new Set(['css', 'scss', 'less']);
const isCodeFile = (file) =>
  (file.kind === 'source' || file.kind === 'test') && !STYLE_LANGS.has(file.lang);

const MODULE_WEIGHTS = {
  size: 0.30,
  bigFile: 0.20,
  branch: 0.20,
  coupling: 0.15,
  files: 0.08,
  churn: 0.05,
};

const DRIVER_LABELS = {
  size: '规模',
  bigFile: '超大文件',
  branch: '分支密度',
  coupling: '模块耦合',
  files: '文件数量',
  churn: '变更频率',
};

function round1(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10) / 10;
}

function formatInt(value) {
  const num = Math.round(Number(value) || 0);
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function normAgainst(value, max, benchmark) {
  if (!value || value <= 0) return 0;
  const relative = max > 0 ? value / max : 0;
  const absolute = benchmark > 0 ? value / benchmark : 0;
  return clamp(0.55 * relative + 0.45 * absolute, 0, 1);
}

function countBranches(text) {
  if (!text) return 0;
  const matches = text.match(/\b(?:if|else|for|while|case|catch)\b|&&|\|\||\?/g);
  return matches ? matches.length : 0;
}

function moduleIdForPath(modulesInfo, rel) {
  if (!rel) return null;
  const byFile = modulesInfo?.byFile;
  if (byFile?.has(rel)) return byFile.get(rel);
  const modules = modulesInfo?.modules || [];
  const hit = modules
    .filter((module) => module.id !== '.' && rel.startsWith(`${module.id}/`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (hit) return hit.id;
  if (modules.some((module) => module.id === '.')) return '.';
  return null;
}

function fallbackModules(repo) {
  const modules = [];
  const map = new Map();
  for (const file of repo.files || []) {
    if (!isCodeFile(file)) continue;
    const first = file.path.includes('/') ? file.path.split('/')[0] : '.';
    const id = first === '.' ? '.' : first;
    if (!map.has(id)) {
      const module = {
        id,
        path: id,
        label: id === '.' ? '根目录' : id,
        group: '',
        sourceFiles: 0,
        testFiles: 0,
        sourceLoc: 0,
        testLoc: 0,
        files: 0,
        loc: 0,
      };
      map.set(id, module);
      modules.push(module);
    }
    map.get(id).files += 1;
    map.get(id).loc += file.loc || 0;
    if (file.kind === 'test') {
      map.get(id).testFiles += 1;
      map.get(id).testLoc += file.loc || 0;
    } else if (file.kind === 'source') {
      map.get(id).sourceFiles += 1;
      map.get(id).sourceLoc += file.loc || 0;
    }
  }
  modules.sort((a, b) => a.path.localeCompare(b.path));
  const byFile = new Map();
  for (const file of repo.files || []) {
    if (file.kind !== 'source' && file.kind !== 'test') continue;
    const first = file.path.includes('/') ? file.path.split('/')[0] : '.';
    byFile.set(file.path, first === '.' ? '.' : first);
  }
  return {
    modules,
    moduleMap: new Map(modules.map((module) => [module.id, module])),
    byFile,
  };
}

function readChurn(churn, module) {
  if (!churn) return 0;
  if (churn instanceof Map) {
    return toNumber(churn.get(module.id) ?? churn.get(module.path));
  }
  if (typeof churn === 'object') {
    return toNumber(churn[module.id] ?? churn[module.path]);
  }
  return 0;
}

/**
 * @param {object} repo scanRepo() 结果
 * @param {{modulesInfo?: object, graph?: object, churn?: Record<string, number>}} [ctx]
 * @returns {object} 契约 §5 定义的复杂度结果
 */
export function analyzeComplexity(repo, ctx = {}) {
  const safeRepo = repo && Array.isArray(repo.files)
    ? repo
    : { files: [], root: '', read: () => null, fileByPath: new Map() };

  let modulesInfo = ctx?.modulesInfo;
  if (!modulesInfo || !Array.isArray(modulesInfo.modules)) {
    try {
      modulesInfo = detectModules(safeRepo);
    } catch {
      modulesInfo = fallbackModules(safeRepo);
    }
  }
  if (!modulesInfo.modules.length) modulesInfo = fallbackModules(safeRepo);

  let graph = ctx?.graph;
  if (!graph || !Array.isArray(graph.fileEdges)) {
    try {
      graph = buildGraph(safeRepo, modulesInfo);
    } catch {
      graph = { fileEdges: [], moduleEdges: [], stats: {} };
    }
  }

  const modules = modulesInfo.modules || [];
  const moduleBuckets = new Map(modules.map((module) => [module.id, {
    module,
    files: [],
    sourceFiles: [],
    testFiles: [],
    sourceLoc: 0,
    testLoc: 0,
    loc: 0,
    maxFileLoc: 0,
    branches: 0,
    churn: 0,
    fanIn: 0,
    fanOut: 0,
  }]));

  for (const file of safeRepo.files) {
    if (file.kind !== 'source' && file.kind !== 'test') continue;
    let moduleId = moduleIdForPath(modulesInfo, file.path);
    if (!moduleId || !moduleBuckets.has(moduleId)) {
      const first = file.path.includes('/') ? file.path.split('/')[0] : '.';
      moduleId = first === '.' ? '.' : first;
    }
    let bucket = moduleBuckets.get(moduleId);
    if (!bucket) continue;
    const loc = toNumber(file.loc);
    bucket.files.push(file);
    bucket.loc += loc;
    if (loc > bucket.maxFileLoc) bucket.maxFileLoc = loc;
    if (file.kind === 'test') {
      bucket.testFiles.push(file);
      bucket.testLoc += loc;
      continue;
    }
    bucket.sourceFiles.push(file);
    bucket.sourceLoc += loc;
    if (file.isText) {
      const text = safeRepo.read ? safeRepo.read(file.path) : null;
      if (text) bucket.branches += countBranches(text);
    }
  }

  // fan-in / fan-out：文件边与模块边都并入，按不同邻居模块去重
  const outgoing = new Map();
  const incoming = new Map();
  const addEdge = (from, to) => {
    if (!from || !to || from === to) return;
    if (!moduleBuckets.has(from) || !moduleBuckets.has(to)) return;
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    if (!incoming.has(to)) incoming.set(to, new Set());
    outgoing.get(from).add(to);
    incoming.get(to).add(from);
  };
  for (const edge of graph.fileEdges || []) {
    addEdge(
      moduleIdForPath(modulesInfo, edge.from),
      moduleIdForPath(modulesInfo, edge.to),
    );
  }
  for (const edge of graph.moduleEdges || []) addEdge(edge.from, edge.to);
  const churnMissing = !(ctx?.churn && typeof ctx.churn === 'object');
  for (const [moduleId, bucket] of moduleBuckets) {
    bucket.fanOut = outgoing.get(moduleId)?.size || 0;
    bucket.fanIn = incoming.get(moduleId)?.size || 0;
    bucket.churn = readChurn(ctx?.churn, bucket.module);
  }

  const sourceLocTotal = [...moduleBuckets.values()].reduce((sum, bucket) => sum + bucket.sourceLoc, 0);
  const branchesTotal = [...moduleBuckets.values()].reduce((sum, bucket) => sum + bucket.branches, 0);
  const maxSourceLoc = Math.max(1, ...[...moduleBuckets.values()].map((bucket) => bucket.sourceLoc));
  const maxFileLoc = Math.max(1, ...[...moduleBuckets.values()].map((bucket) => bucket.maxFileLoc));
  const maxBranchDensity = Math.max(1, ...[...moduleBuckets.values()]
    .map((bucket) => (bucket.sourceLoc > 0 ? (bucket.branches / bucket.sourceLoc) * 1000 : 0)));
  const maxCoupling = Math.max(1, ...[...moduleBuckets.values()].map((bucket) => bucket.fanIn + bucket.fanOut));
  const maxSourceFiles = Math.max(1, ...[...moduleBuckets.values()].map((bucket) => bucket.sourceFiles.length));
  const maxChurn = Math.max(0, ...[...moduleBuckets.values()].map((bucket) => bucket.churn));
  const churnWeight = maxChurn > 0 ? MODULE_WEIGHTS.churn : 0;
  const weightSum = Object.values(MODULE_WEIGHTS).reduce((sum, weight) => sum + weight, 0) - (maxChurn > 0 ? 0 : MODULE_WEIGHTS.churn);

  for (const bucket of moduleBuckets.values()) {
    const branchDensity = bucket.sourceLoc > 0 ? (bucket.branches / bucket.sourceLoc) * 1000 : 0;
    const components = [
      {
        key: 'size',
        weight: MODULE_WEIGHTS.size,
        value: bucket.sourceLoc,
        norm: normAgainst(bucket.sourceLoc, maxSourceLoc, 12_000),
      },
      {
        key: 'bigFile',
        weight: MODULE_WEIGHTS.bigFile,
        value: bucket.maxFileLoc,
        norm: normAgainst(bucket.maxFileLoc, maxFileLoc, 1_000),
      },
      {
        key: 'branch',
        weight: MODULE_WEIGHTS.branch,
        value: round1(branchDensity),
        // 少于 300 行时分支密度的统计噪声太大，不参与打分
        norm: bucket.sourceLoc >= 300 ? normAgainst(branchDensity, maxBranchDensity, 300) : 0,
      },
      {
        key: 'coupling',
        weight: MODULE_WEIGHTS.coupling,
        value: bucket.fanIn + bucket.fanOut,
        norm: normAgainst(bucket.fanIn + bucket.fanOut, maxCoupling, 15),
      },
      {
        key: 'files',
        weight: MODULE_WEIGHTS.files,
        value: bucket.sourceFiles.length,
        norm: normAgainst(bucket.sourceFiles.length, maxSourceFiles, 250),
      },
      {
        key: 'churn',
        weight: churnWeight,
        value: bucket.churn,
        norm: maxChurn > 0 ? normAgainst(bucket.churn, maxChurn, 80) : 0,
      },
    ];
    const active = components.filter((component) => component.weight > 0);
    const weighted = active.reduce((sum, component) => sum + component.weight * component.norm, 0);
    const score = Math.round(clamp(weightSum > 0 ? (weighted / weightSum) * 100 : 0, 0, 100));
    const sorted = [...active].sort((a, b) => (b.weight * b.norm) - (a.weight * a.norm) || a.key.localeCompare(b.key));
    const drivers = sorted
      .filter((component) => component.value > 0)
      .slice(0, 3)
      .map((component) => {
        let detail = '';
        if (component.key === 'size') detail = `源码 ${formatInt(bucket.sourceLoc)} 行、${bucket.sourceFiles.length} 个源文件`;
        else if (component.key === 'bigFile') detail = `单文件最大 ${formatInt(bucket.maxFileLoc)} 行`;
        else if (component.key === 'branch') detail = `分支密度 ${round1(branchDensity)}/千行（${formatInt(bucket.branches)} 个分支）`;
        else if (component.key === 'coupling') detail = `扇出 ${bucket.fanOut} 个模块、扇入 ${bucket.fanIn} 个模块`;
        else if (component.key === 'files') detail = `${bucket.sourceFiles.length} 个源文件规模`;
        else if (component.key === 'churn') detail = `累计 ${formatInt(bucket.churn)} 次提交`;
        return {
          name: DRIVER_LABELS[component.key],
          value: typeof component.value === 'number' ? round1(component.value) : component.value,
          detail,
        };
      });
    if (drivers.length === 0) {
      drivers.push({
        name: '规模',
        value: 0,
        detail: '模块内没有可统计的源码行',
      });
    }
    bucket.branchDensity = round1(branchDensity);
    bucket.score = score;
    bucket.level = scoreLevel(score);
    bucket.drivers = drivers;
    bucket.needsOptimization = score >= 65 || bucket.maxFileLoc >= 800 || bucket.fanOut >= 12;
  }

  const moduleRows = [...moduleBuckets.values()]
    .filter((bucket) => bucket.files.length > 0)
    .map((bucket) => ({
      path: bucket.module.path,
      label: bucket.module.label,
      loc: bucket.loc,
      sourceLoc: bucket.sourceLoc,
      files: bucket.files.length,
      sourceFiles: bucket.sourceFiles.length,
      testFiles: bucket.testFiles.length,
      avgFileLoc: bucket.files.length ? round1(bucket.loc / bucket.files.length) : 0,
      maxFileLoc: bucket.maxFileLoc,
      fanIn: bucket.fanIn,
      fanOut: bucket.fanOut,
      branches: bucket.branches,
      churn: bucket.churn,
      score: bucket.score,
      level: bucket.level,
      drivers: bucket.drivers,
      needsOptimization: bucket.needsOptimization,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const allFiles = safeRepo.files.filter(isCodeFile);
  const sourceFiles = safeRepo.files.filter((file) => file.kind === 'source' && !STYLE_LANGS.has(file.lang));
  const totalsLoc = allFiles.reduce((sum, file) => sum + toNumber(file.loc), 0);
  const totals = {
    loc: totalsLoc,
    sourceLoc: sourceLocTotal,
    files: allFiles.length,
    sourceFiles: sourceFiles.length,
    modules: modules.length,
    avgFileLoc: allFiles.length ? round1(totalsLoc / allFiles.length) : 0,
    maxFileLoc: allFiles.reduce((max, file) => Math.max(max, toNumber(file.loc)), 0),
  };

  const sortedByScore = [...moduleBuckets.values()]
    .filter((bucket) => bucket.files.length > 0 && (bucket.sourceLoc > 0 || bucket.testFiles.length > 0))
    .sort((a, b) => b.score - a.score
      || b.sourceLoc - a.sourceLoc
      || a.module.path.localeCompare(b.module.path));

  const hotspots = sortedByScore
    .filter((bucket) => bucket.needsOptimization
      || bucket.score >= 55
      || bucket.maxFileLoc >= 600
      || bucket.branchDensity >= 200)
    .slice(0, 8)
    .map((bucket) => {
      const reasons = [`源码 ${formatInt(bucket.sourceLoc)} 行`];
      if (bucket.maxFileLoc > 0) reasons.push(`单文件最大 ${formatInt(bucket.maxFileLoc)} 行`);
      if (bucket.branchDensity > 0) reasons.push(`分支密度 ${round1(bucket.branchDensity)}/千行`);
      if (bucket.fanOut > 0 || bucket.fanIn > 0) reasons.push(`扇出 ${bucket.fanOut} / 扇入 ${bucket.fanIn}`);
      if (bucket.churn > 0) reasons.push(`累计 ${formatInt(bucket.churn)} 次提交`);
      return {
        path: bucket.module.path,
        label: bucket.module.label,
        score: bucket.score,
        loc: bucket.sourceLoc,
        reason: reasons.join('，'),
      };
    });

  // 系统分：模块加权平均 + 最大热点 + 绝对规模 + 分支密度，避免小仓库被相对归一化抬高
  const weightedAvg = sourceLocTotal > 0
    ? [...moduleBuckets.values()].reduce((sum, bucket) => sum + bucket.score * bucket.sourceLoc, 0) / sourceLocTotal
    : 0;
  const maxScore = sortedByScore.length ? sortedByScore[0].score : 0;
  const sizeBase = clamp(Math.log10(sourceLocTotal + 10) / Math.log10(50_000), 0, 1) * 100;
  const systemDensity = sourceLocTotal >= 300 ? (branchesTotal / sourceLocTotal) * 1000 : 0;
  const densityScore = clamp(systemDensity / 300, 0, 1) * 100;
  const systemScore = Math.round(clamp(
    0.52 * weightedAvg + 0.22 * maxScore + 0.17 * sizeBase + 0.09 * densityScore,
    0,
    100,
  ));
  const level = systemScore >= 80 ? 'severe' : systemScore >= 60 ? 'high' : systemScore >= 40 ? 'moderate' : 'low';

  const recommendations = [];
  const bigModules = [...moduleBuckets.values()]
    .filter((bucket) => bucket.maxFileLoc >= 600)
    .sort((a, b) => b.maxFileLoc - a.maxFileLoc || b.sourceLoc - a.sourceLoc);
  if (bigModules.length) {
    const labels = bigModules.slice(0, 2).map((bucket) => `${bucket.module.label}（最大 ${formatInt(bucket.maxFileLoc)} 行）`);
    recommendations.push(`${bigModules.length} 个模块存在超过 600 行的单文件，优先拆分 ${labels.join('、')}：按页面区块或领域职责拆成 300–400 行以内的文件。`);
  }

  const concentration = sourceLocTotal > 0 && sortedByScore.length
    ? sortedByScore[0].sourceLoc / sourceLocTotal
    : 0;
  if (concentration >= 0.28 && sourceLocTotal >= 2_000 && sortedByScore[0]?.sourceLoc >= 1_000) {
    const top = sortedByScore[0];
    recommendations.push(`${top.module.label}占全部源码的 ${Math.round(concentration * 100)}%（${formatInt(top.sourceLoc)} 行），是系统复杂度的单点来源；先把它的页面/服务按领域边界拆开，再评估是否独立成模块。`);
  }

  const coupled = [...moduleBuckets.values()]
    .filter((bucket) => bucket.fanOut >= 8)
    .sort((a, b) => b.fanOut - a.fanOut);
  if (coupled.length) {
    const top = coupled[0];
    recommendations.push(`${top.module.label}直接依赖 ${top.fanOut} 个模块，改动会向外扩散；考虑引入接口层或事件解耦，把扇出压到 5 以内。`);
  }

  const dense = [...moduleBuckets.values()]
    .filter((bucket) => bucket.branchDensity >= 250 && bucket.sourceLoc >= 800)
    .sort((a, b) => b.branchDensity - a.branchDensity);
  if (dense.length) {
    const top = dense[0];
    recommendations.push(`${top.module.label}的分支密度达到 ${round1(top.branchDensity)}/千行，建议把深层 if/else 改成状态机或策略表，并为关键分支补测试再重构。`);
  }

  const highChurn = [...moduleBuckets.values()]
    .filter((bucket) => bucket.score >= 65 && bucket.churn > 0)
    .sort((a, b) => b.churn - a.churn);
  if (highChurn.length) {
    const top = highChurn[0];
    recommendations.push(`${top.module.label}复杂度 ${top.score} 且累计 ${formatInt(top.churn)} 次提交，属于高频改动区；先在测试保护下做小步拆分，避免一次性大重写。`);
  }

  const untestedModules = [...moduleBuckets.values()].filter((bucket) => bucket.files.length > 0 && bucket.testFiles.length === 0);
  if (recommendations.length < 3 && untestedModules.length > moduleBuckets.size / 2) {
    recommendations.push(`${untestedModules.length}/${moduleBuckets.size} 个模块没有测试文件，重构前先给热点模块补最小回归测试，否则拆分风险不可控。`);
  }

  if (!recommendations.length) {
    recommendations.push('当前模块规模与分支密度都在可控范围，保持单文件不超过 600 行、模块扇出不超过 8，新增功能继续按现有边界扩展即可。');
  }

  const noteParts = [];
  noteParts.push(`基于 ${modules.length} 个模块、${formatInt(sourceLocTotal)} 行源码统计，仅包含 source/test，构建产物已排除`);
  noteParts.push(churnMissing
    ? 'churn 未提供，按 0 处理'
    : maxChurn === 0
      ? 'ctx.churn 为空，按 0 处理'
      : 'churn 来自 ctx.churn');
  noteParts.push('fan-in/out 来自文件级 import 图并按模块去重');
  noteParts.push('分支密度按 if/else/for/while/case/catch、&&、||、? 计数（含可选链与三元表达式）');
  const note = `${noteParts.join('；')}。`;

  return {
    score: systemScore,
    level,
    totals,
    modules: moduleRows,
    hotspots,
    recommendations: recommendations.slice(0, 5),
    note,
  };
}
