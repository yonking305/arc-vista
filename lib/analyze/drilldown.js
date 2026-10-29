import { scanRepo } from './walk.js';
import { detectModules } from './modules.js';
import { buildGraph } from './graph.js';
import { extractRoutes } from './evidence.js';
import { chatJson } from '../llm.js';

const GROUP_LABELS = [
  [/controller|api|handler|route|endpoint/i, '接口层'],
  [/service|usecase|application/i, '业务逻辑'],
  [/domain|model|entity|aggregate/i, '领域模型'],
  [/repository|mapper|dao|persistence|storage/i, '数据访问'],
  [/config|settings|properties|bootstrap/i, '配置'],
  [/event|listener|consumer|producer|mq/i, '事件消息'],
  [/page|view|screen/i, '页面'],
  [/component|widget|ui/i, '组件'],
  [/store|state|reducer|slice/i, '状态管理'],
  [/util|helper|common|shared|lib/i, '工具函数'],
  [/test|spec/i, '测试'],
  [/dto|request|response|vo|param|payload/i, '传输对象'],
  [/client|remote|adapter|feign/i, '外部调用'],
  [/state|store|reducer|slice/i, '状态管理'],
  [/ui|component|widget/i, '界面组件'],
];

function labelForGroup(key) {
  for (const [regex, label] of GROUP_LABELS) if (regex.test(key)) return label;
  return key;
}

function meaningfulParts(relDir) {
  let parts = relDir.split('/').filter(Boolean);
  const javaAt = parts.indexOf('java');
  if (javaAt !== -1) parts = parts.slice(javaAt + 1);
  const noise = new Set(['src', 'main', 'java', 'kotlin', 'com', 'org', 'net', 'io', 'app', 'lib', 'resources']);
  parts = parts.filter((part) => !noise.has(part.toLowerCase()));
  if (parts.length > 0 && /^[a-z]{2,12}$/.test(parts[0]) && parts.length > 1 && /cloud|mall|company|corp/.test(parts[0])) {
    parts = parts.slice(1);
  }
  return parts;
}

const GROUP_CATEGORIES = [
  [/controller|handler|endpoint|rest|api$/i, 'controller'],
  [/service|usecase|application|manager|facade/i, 'service'],
  [/domain|entity|model|aggregate/i, 'domain'],
  [/repository|mapper|dao|persistence|storage/i, 'repository'],
  [/dto|request|response|view|vo$|param|payload/i, 'dto'],
  [/consumer|listener|producer|event|mq|messaging/i, 'event'],
  [/feign|client|remote|adapter|gateway/i, 'client'],
  [/config|settings|properties|bootstrap/i, 'config'],
  [/util|helper|common|shared|support/i, 'util'],
  [/page|view|screen|component|widget|ui/i, 'ui'],
  [/store|state|reducer|slice/i, 'state'],
  [/test|spec/i, 'test'],
];

function groupKeyForFile(module, file) {
  const dir = file.dir === module.path ? '' : file.dir.slice(module.path.length + 1);
  const parts = meaningfulParts(dir);
  if (parts.length === 0) return '(根)';
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    for (const [regex, key] of GROUP_CATEGORIES) {
      if (regex.test(parts[index])) return key;
    }
  }
  return parts.slice(-2).join('/');
}

function buildInternalGraph(repo, modulesInfo, graph, module) {
  const files = repo.files.filter(
    (file) => (file.kind === 'source' || file.kind === 'test') && file.path.startsWith(`${module.path}/`),
  );
  const groups = new Map();
  for (const file of files) {
    const key = groupKeyForFile(module, file);
    if (!groups.has(key)) groups.set(key, { key, loc: 0, files: 0, filePaths: new Set(), fileList: [] });
    const group = groups.get(key);
    group.loc += file.loc;
    group.files += 1;
    group.filePaths.add(file.path);
    group.fileList.push({ path: file.path, loc: file.loc });
  }
  const sortedGroups = [...groups.values()].sort((a, b) => b.loc - a.loc);

  if (sortedGroups.length >= 3) {
    const kept = sortedGroups.slice(0, 9);
    const nodes = kept.map((group, index) => {
      const samples = [...group.fileList]
        .sort((a, b) => b.loc - a.loc)
        .slice(0, 2)
        .map((file) => file.path.split('/').pop());
      return {
        id: `grp:${index}`,
        label: labelForGroup(group.key),
        sublabel: group.key,
        kind: 'component',
        loc: group.loc,
        files: group.files,
        samples,
        detail: `${group.files} 个文件 · ${group.loc} 行`,
      };
    });
    const groupIdOf = new Map();
    kept.forEach((group, index) => {
      for (const filePath of group.filePaths) groupIdOf.set(filePath, nodes[index].id);
    });
    const edgeMap = new Map();
    for (const edge of graph.fileEdges) {
      const from = groupIdOf.get(edge.from);
      const to = groupIdOf.get(edge.to);
      if (!from || !to || from === to) continue;
      const key = `${from}|${to}`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
    return {
      nodes,
      edges: [...edgeMap.entries()].map(([key, count]) => {
        const [from, to] = key.split('|');
        return { from, to, kind: 'depends', count };
      }),
    };
  }

  const topFiles = [...files].sort((a, b) => b.loc - a.loc).slice(0, 10);
  const nodeId = new Map(topFiles.map((file, index) => [file.path, `file:${index}`]));
  const nodes = topFiles.map((file, index) => ({
    id: `file:${index}`,
    label: file.name,
    sublabel: file.dir.replace(`${module.path}/`, ''),
    kind: 'file',
    loc: file.loc,
    files: 1,
    samples: [file.name],
    detail: `${file.loc} 行 · ${file.lang || 'file'}`,
  }));
  const edgeMap = new Map();
  for (const edge of graph.fileEdges) {
    const from = nodeId.get(edge.from);
    const to = nodeId.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
  }
  return {
    nodes,
    edges: [...edgeMap.entries()].map(([key, count]) => {
      const [from, to] = key.split('|');
      return { from, to, kind: 'depends', count };
    }),
  };
}

function symbolNames(repo, module) {
  const names = [];
  for (const file of repo.files) {
    if (file.kind !== 'source' || !file.path.startsWith(`${module.path}/`)) continue;
    const text = repo.read(file.path);
    if (!text) continue;
    for (const match of text.matchAll(/(?:export\s+)?(?:async\s+)?(?:class|interface|function|const|enum)\s+([A-Za-z_$][\w$]{2,40})/g)) {
      if (!names.includes(match[1])) names.push(match[1]);
      if (names.length >= 24) return names;
    }
    for (const match of text.matchAll(/public\s+(?:[\w<>\[\],.?]+\s+)?([A-Z][\w]{2,40})\s*\(/g)) {
      if (!names.includes(match[1])) names.push(match[1]);
      if (names.length >= 24) return names;
    }
  }
  return names;
}

/**
 * Drill-down analysis for one module: deterministic internal structure first,
 * then optional LLM narrative / sub-graph refinement.
 */
export async function analyzeModule({ store, git, product, snapshot, modulePath, question, llm, log = () => {} }) {
  const analysis = snapshot.analysis;
  const module = (analysis.modules || []).find((item) => item.path === modulePath) || null;
  if (!module) throw new Error(`未找到模块：${modulePath}`);

  const worktree = await git.ensureWorktree(product.id, snapshot.commitSha);
  const repo = await scanRepo(worktree);
  const modulesInfo = detectModules(repo);
  const graph = buildGraph(repo, modulesInfo);
  const routes = extractRoutes(repo, modulesInfo);

  const files = repo.files
    .filter((file) => (file.kind === 'source' || file.kind === 'test') && file.path.startsWith(`${module.path}/`))
    .sort((a, b) => b.loc - a.loc);

  const complexityModule = (analysis.complexity?.modules || []).find((item) => item.path === module.path);
  const coverageModule = (analysis.coverage?.modules || []).find((item) => item.path === module.path);
  const moduleRoutes = routes.filter((route) => route.moduleId === module.id);
  const moduleDeps = (analysis.deps?.packages || []).filter((pkg) => pkg.dir === module.path);
  const incoming = graph.moduleEdges.filter((edge) => edge.to === module.id);
  const outgoing = graph.moduleEdges.filter((edge) => edge.from === module.id);
  const archNodes = analysis.architecture?.nodes || [];
  const archModuleById = new Map(archNodes.map((node) => [node.id, node.module]));
  const archLabelById = new Map(archNodes.map((node) => [node.id, node.label]));
  const callers = (analysis.architecture?.edges || [])
    .filter((edge) => edge.kind === 'sync' && archModuleById.get(edge.to) === module.id)
    .filter((edge) => archModuleById.get(edge.from) && archModuleById.get(edge.from) !== module.id)
    .map((edge) => ({
      module: archModuleById.get(edge.from),
      label: archLabelById.get(edge.from) || edge.from,
      count: 1,
      kind: edge.label || '调用',
    }));
  const guardEvidence = (analysis.security?.guards || []).flatMap((guard) =>
    (guard.evidence || [])
      .filter((item) => item.path?.startsWith(`${module.path}/`))
      .map((item) => ({ guard: guard.name, status: guard.status, path: item.path })),
  );
  const domain = (analysis.knowledge?.domains || []).find((item) => item.module === module.id) || null;
  const internalGraph = buildInternalGraph(repo, modulesInfo, graph, module);
  const symbols = symbolNames(repo, module);

  const metrics = {
    loc: module.loc,
    sourceFiles: module.sourceFiles,
    testFiles: module.testFiles,
    complexity: complexityModule?.score ?? null,
    complexityLevel: complexityModule?.level ?? null,
    coverage: coverageModule?.line ?? null,
    fanIn: incoming.reduce((total, edge) => total + edge.count, 0),
    fanOut: outgoing.reduce((total, edge) => total + edge.count, 0),
    endpoints: moduleRoutes.length,
    churn: complexityModule?.churn ?? 0,
    callers: callers.length,
  };

  const dependencyList = {
    incoming: [...callers, ...incoming
      .map((edge) => {
        const source = (analysis.modules || []).find((item) => item.id === edge.from);
        return { module: edge.from, label: source?.label || edge.from, count: edge.count };
      })
]
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    outgoing: outgoing
      .map((edge) => {
        const target = (analysis.modules || []).find((item) => item.id === edge.to);
        return { module: edge.to, label: target?.label || edge.to, count: edge.count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  };

  const moduleInfo = {
    path: module.path,
    label: module.label,
    type: module.type,
    group: module.group,
    sourceFiles: module.sourceFiles,
    testFiles: module.testFiles,
    loc: module.loc,
    langs: module.langs,
    domain: domain ? { id: domain.id, label: domain.label } : null,
    tech: (analysis.deps?.packages || []).some(
      (pkg) => pkg.dir === module.path && /spring-boot|react|vue|taro/.test(pkg.name.toLowerCase()),
    ),
  };

  const heuristicSummary = `${module.label} 包含 ${module.sourceFiles} 个源文件、约 ${module.loc} 行代码` +
    `${moduleRoutes.length > 0 ? `，对外提供 ${moduleRoutes.length} 个接口` : ''}` +
    `${incoming.length > 0 ? `，被 ${incoming.length} 个模块依赖` : ''}` +
    `${outgoing.length > 0 ? `，依赖 ${outgoing.length} 个模块` : ''}。`;

  const heuristicRisks = [];
  if ((complexityModule?.score ?? 0) >= 65) {
    heuristicRisks.push({
      level: 'medium',
      title: `复杂度偏高（${complexityModule.score}/100）`,
      detail: (complexityModule.drivers || []).map((driver) => driver.name).join('、') || '模块规模与耦合度靠前',
      action: '按职责拆分模块，优先治理最大文件。',
    });
  }
  if (module.testFiles === 0) {
    heuristicRisks.push({
      level: 'medium',
      title: '模块没有测试文件',
      detail: '该模块的修改缺少自动化回归保护。',
      action: '为核心业务规则补充单元测试与契约测试。',
    });
  }
  if (metrics.fanOut >= 10) {
    heuristicRisks.push({
      level: 'low',
      title: `对外依赖较多（${metrics.fanOut} 处）`,
      detail: '模块是依赖消费者，上游变更会造成连锁影响。',
      action: '收敛依赖，必要时引入防腐层。',
    });
  }

  const heuristic = {
    summary: heuristicSummary,
    responsibilities: internalGraph.nodes
      .filter((node) => !/^\d/.test(node.label))
      .slice(0, 6)
      .map((node) => node.samples?.length
        ? `${node.label}：${node.samples.join('、')}${node.files > 2 ? ` 等 ${node.files} 个文件` : ''}`
        : `${node.label} · ${node.files} 个文件`),
    internalGraph,
    flows: [],
    risks: heuristicRisks,
    recommendations: [
      ...(module.testFiles === 0 ? ['为核心路径补充测试，建立回归保护。'] : []),
      ...((complexityModule?.score ?? 0) >= 60 ? ['拆分过大的文件与类，明确模块边界。'] : []),
      ...(metrics.endpoints > 0 ? ['为对外接口补充契约测试与鉴权校验。'] : []),
    ].slice(0, 4),
    dependencies: dependencyList,
    dataStores: (analysis.knowledge?.nodes || [])
      .filter((node) => node.kind === 'datastore')
      .map((node) => node.label),
    apis: moduleRoutes.slice(0, 20).map((route) => ({
      method: route.method,
      path: route.path,
      handler: route.handler,
      file: route.file,
    })),
    symbols,
    generatedBy: 'heuristic',
  };

  if (!llm?.enabled) return { module: moduleInfo, metrics, ...heuristic, question: question || null };

  const evidence = {
    module: {
      path: module.path,
      label: module.label,
      group: module.group,
      sourceFiles: module.sourceFiles,
      testFiles: module.testFiles,
      loc: module.loc,
      langs: module.langs,
      domain: domain?.label || null,
    },
    metrics,
    duties: internalGraph.nodes.map((node) => `${node.label}(${node.loc} 行)`),
    files: files.slice(0, 24).map((file) => ({
      path: file.path,
      loc: file.loc,
      kind: file.kind,
      dir: file.dir,
    })),
    symbols: symbols.slice(0, 20),
    apis: moduleRoutes.slice(0, 20).map((route) => `${route.method} ${route.path} (${route.handler || ''})`),
    incoming: dependencyList.incoming,
    outgoing: dependencyList.outgoing,
    dependencies: moduleDeps.slice(0, 25).map((pkg) => `${pkg.ecosystem}:${pkg.name}@${pkg.version}`),
    guards: guardEvidence.slice(0, 8),
    risks: heuristicRisks,
    coverage: { line: metrics.coverage, testFiles: module.testFiles },
    question: question || null,
  };

  const task = `下面是仓库中一个模块的证据（JSON）。你是该模块的架构负责人，请做一次深入分析，只输出 JSON：
1. summary：2-4 句模块职责与实现方式的说明（中文，具体到机制）。
2. responsibilities：3-5 条核心职责。
3. internalGraph：模块内部结构图，nodes 的 id 用 "n1" 起，kind 取 component/service/entity/adapter/util；edges 引用 node id，kind 取 depends/calls/data。
4. flows：1-3 条模块内的关键流程（steps 为中文短句）。
5. risks：最多 4 条，level=high/medium/low，具体到文件或机制。
6. recommendations：最多 4 条可执行改进建议。
7. dependenciesInterpretation：一句话说明该模块在系统中的位置。
8. dataStores：用到的数据存储/中间件名称数组。
9. answer：如果 question 存在，用 2-4 句直接回答该问题；否则为空字符串。

证据：
${JSON.stringify(evidence)}

输出结构：
{"summary":"","responsibilities":[""],"internalGraph":{"nodes":[{"id":"n1","label":"订单状态机","kind":"component"}],"edges":[{"from":"n1","to":"n2","kind":"depends"}]},"flows":[{"name":"","steps":[""]}],"risks":[{"level":"medium","title":"","detail":"","action":""}],"recommendations":[""],"dependenciesInterpretation":"","dataStores":[""],"answer":""}`;

  try {
    const result = await chatJson(llm, {
      system: '你是资深软件架构师，只输出合法 JSON。所有面向用户的文字使用简体中文，具体、克制、有证据。',
      user: task,
      maxTokens: 4500,
      timeoutMs: 180000,
      jsonMode: true,
    });
    const data = result.data || {};
    const nodeIds = new Set((data.internalGraph?.nodes || []).map((node) => node.id));
    return {
      module: moduleInfo,
      metrics,
      summary: String(data.summary || heuristic.summary).slice(0, 600),
      responsibilities: Array.isArray(data.responsibilities)
        ? data.responsibilities.slice(0, 6).map((item) => String(item).slice(0, 120))
        : heuristic.responsibilities,
      internalGraph: Array.isArray(data.internalGraph?.nodes) && data.internalGraph.nodes.length >= 2
        ? {
            nodes: data.internalGraph.nodes.slice(0, 16).map((node, index) => ({
              id: String(node.id || `n${index}`).slice(0, 20),
              label: String(node.label || '组件').slice(0, 24),
              sublabel: '',
              kind: ['component', 'service', 'entity', 'adapter', 'util'].includes(node.kind) ? node.kind : 'component',
              loc: 0,
              files: 0,
              detail: String(node.detail || '').slice(0, 120),
            })),
            edges: (data.internalGraph.edges || [])
              .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
              .slice(0, 40)
              .map((edge) => ({ from: String(edge.from), to: String(edge.to), kind: String(edge.kind || 'depends'), count: 1 })),
          }
        : heuristic.internalGraph,
      flows: Array.isArray(data.flows)
        ? data.flows.slice(0, 4).map((flow, index) => ({
            id: `flow:${index}`,
            name: String(flow?.name || `流程 ${index + 1}`).slice(0, 30),
            steps: Array.isArray(flow?.steps) ? flow.steps.slice(0, 10).map((step) => String(step).slice(0, 80)) : [],
          }))
        : [],
      risks: Array.isArray(data.risks)
        ? data.risks.slice(0, 4).map((risk, index) => ({
            id: `risk:${index}`,
            level: ['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'medium',
            title: String(risk.title || '风险').slice(0, 80),
            detail: String(risk.detail || '').slice(0, 300),
            action: String(risk.action || '').slice(0, 200),
          }))
        : heuristic.risks,
      recommendations: Array.isArray(data.recommendations)
        ? data.recommendations.slice(0, 5).map((item) => String(item).slice(0, 160))
        : heuristic.recommendations,
      dependencies: dependencyList,
      dataStores: Array.isArray(data.dataStores) ? data.dataStores.slice(0, 6).map((item) => String(item).slice(0, 30)) : heuristic.dataStores,
      apis: heuristic.apis,
      symbols,
      generatedBy: 'llm',
      dependenciesInterpretation: String(data.dependenciesInterpretation || '').slice(0, 240),
      answer: String(data.answer || '').slice(0, 600),
      question: question || null,
    };
  } catch (error) {
    log(`模块下钻的大模型分析失败：${error.message}`, 'warn');
    return { module: moduleInfo, metrics, ...heuristic, llmWarning: error.message, question: question || null };
  }
}
