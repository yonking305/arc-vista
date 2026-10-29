import { chatJson } from '../llm.js';
import { truncate } from '../util.js';

const SYSTEM_ARCH = `你是一名资深系统架构师与领域建模专家，正在分析一个真实代码仓库。
你只输出一个合法 JSON 对象，不输出 Markdown、注释或解释。所有面向用户的文字使用简体中文，简洁、具体、有证据感，避免空话。`;

const SYSTEM_RISK = `你是一名负责架构治理与交付风险的技术负责人，正在审计一个真实代码仓库的架构健康度。
你只输出一个合法 JSON 对象，不输出 Markdown、注释或解释。风险必须具体到模块/配置/指标，面向用户使用简体中文。`;

function topDeps(deps, limit = 70) {
  const seen = new Set();
  const list = [];
  for (const pkg of deps?.packages || []) {
    if (pkg.scope === 'dev') continue;
    const key = `${pkg.ecosystem}:${pkg.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem, dir: pkg.dir });
    if (list.length >= limit) break;
  }
  return list;
}

function readmeExcerpt(repo) {
  const candidates = repo.files.filter(
    (file) => /^readme(\.md|\.markdown|\.txt)?$/i.test(file.name) && file.depth <= 2,
  );
  const file = candidates.sort((a, b) => a.depth - b.depth)[0];
  if (!file) return '';
  const text = repo.read(file.path) || '';
  return truncate(text, 2600);
}

export function buildEvidence({ product, snapshot, repo, modulesInfo, deps, architecture, knowledge, security, complexity, coverage, routes, graph, compose }) {
  const modules = modulesInfo.modules
    .filter((module) => module.sourceFiles > 0)
    .map((module) => ({
      path: module.path,
      label: module.label,
      group: module.group,
      sourceFiles: module.sourceFiles,
      testFiles: module.testFiles,
      loc: module.loc,
      langs: (module.langs || []).map((lang) => lang.lang),
      complexity: complexity?.modules?.find((item) => item.path === module.path)?.score ?? null,
      coverage: coverage?.modules?.find((item) => item.path === module.path)?.line ?? null,
      apis: routes.filter((route) => route.moduleId === module.id).length,
    }));

  return {
    product: { name: product.name, description: product.description || '', repoUrl: product.repoUrl },
    revision: {
      branch: snapshot.branch,
      commit: snapshot.commit?.short,
      subject: snapshot.commit?.subject,
      date: snapshot.commit?.date,
    },
    readme: readmeExcerpt(repo),
    stats: {
      files: repo.totals.files,
      sourceFiles: repo.totals.sourceFiles,
      testFiles: repo.totals.testFiles,
      sourceLoc: repo.totals.sourceLoc,
      languages: repo.languages.slice(0, 6).map((lang) => `${lang.lang} ${lang.loc}`),
      modules: modulesInfo.modules.length,
      endpoints: routes.length,
      entities: knowledge.stats.entities,
      events: knowledge.stats.events,
      domains: knowledge.stats.domains,
      datastores: knowledge.stats.datastores,
      securityScore: security.score,
      securityLevel: security.level,
      coverageLine: coverage.line,
      coverageMeasured: coverage.measurable,
      testCount: coverage.testCount,
      complexityScore: complexity.score,
      complexityLevel: complexity.level,
    },
    modules,
    architecture: {
      nodes: architecture.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        layer: node.layer,
        kind: node.kind,
        sublabel: node.sublabel,
      })),
      edges: architecture.edges.slice(0, 60).map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        ...(edge.label ? { label: edge.label } : {}),
      })),
    },
    security: {
      score: security.score,
      level: security.level,
      guards: security.guards.map((guard) => ({
        id: guard.id,
        name: guard.name,
        category: guard.category,
        status: guard.status,
        severity: guard.severity,
        ruleCount: guard.ruleCount,
      })),
      ruleSets: security.ruleSets.map((set) => ({ id: set.id, name: set.name, ruleCount: set.ruleCount })),
      riskyPatterns: security.riskyPatterns.slice(0, 8).map((pattern) => ({
        id: pattern.id,
        name: pattern.name,
        severity: pattern.severity,
        path: pattern.path,
      })),
    },
    complexity: {
      score: complexity.score,
      level: complexity.level,
      hotspots: complexity.hotspots.slice(0, 8).map((hotspot) => ({
        path: hotspot.path,
        label: hotspot.label,
        score: hotspot.score,
        reason: hotspot.reason,
      })),
    },
    coverage: {
      line: coverage.line,
      estimated: coverage.estimated,
      testCount: coverage.testCount,
      sourceFiles: coverage.sourceFiles,
      testFiles: coverage.testFiles,
      note: coverage.note,
      untestedModules: coverage.untestedModules.slice(0, 8),
    },
    knowledge: {
      domains: knowledge.domains,
      capabilities: knowledge.nodes
        .filter((node) => node.kind === 'capability')
        .slice(0, 40)
        .map((node) => ({ id: node.id, label: node.label, domain: node.domain })),
      entities: knowledge.nodes
        .filter((node) => node.kind === 'entity')
        .slice(0, 40)
        .map((node) => ({ id: node.id, label: node.label, table: node.meta?.table || null })),
      events: knowledge.nodes.filter((node) => node.kind === 'event').map((node) => node.label).slice(0, 30),
      actors: knowledge.nodes.filter((node) => node.kind === 'actor').map((node) => node.label),
    },
    dependencies: topDeps(deps),
    routes: routes.slice(0, 50).map((route) => `${route.method} ${route.path} (${route.moduleId})`),
    internalEdges: graph.moduleEdges.slice(0, 40),
    compose: (compose?.services || []).map((service) => `${service.name}:${service.image}`),
  };
}

function clampRiskLevel(value, fallback = 'medium') {
  return ['high', 'medium', 'low'].includes(value) ? value : fallback;
}

export function heuristicRisks({ security, complexity, coverage, architecture, knowledge, deps, compose, repo }) {
  const risks = [];
  const seen = new Set();
  const push = (risk) => {
    if (seen.has(risk.id)) return;
    if (risks.length >= 10) return;
    seen.add(risk.id);
    risks.push(risk);
  };

  for (const guard of security.guards || []) {
    if (guard.status === 'missing' && (guard.severity === 'critical' || guard.severity === 'high')) {
      push({
        id: `heur-guard-${guard.id}`,
        level: guard.severity === 'critical' ? 'high' : 'medium',
        category: '安全',
        title: `缺少「${guard.name}」守护`,
        detail: `${guard.category}类守护未在仓库中找到落地证据。${guard.note || ''}`.trim(),
        evidence: guard.evidence?.slice(0, 2).map((item) => ({ label: guard.name, path: item.path })) || [],
        action: guard.recommendation || `补充${guard.name}相关配置与校验。`,
        source: 'heuristic',
      });
    }
  }

  for (const pattern of (security.riskyPatterns || []).filter((item) => item.severity === 'high').slice(0, 2)) {
    push({
      id: `heur-pattern-${pattern.id}`,
      level: 'high',
      category: '安全',
      title: pattern.name,
      detail: pattern.detail,
      evidence: [{ label: pattern.name, path: pattern.path }],
      action: '清理该写法，改为安全 API 或移入环境变量/密钥管理。',
      source: 'heuristic',
    });
  }

  if (security.score < 45) {
    push({
      id: 'heur-security-score',
      level: 'high',
      category: '安全',
      title: `安全架构守护覆盖偏弱（${security.score}/100）`,
      detail: `仅 ${security.totals.enforced} 项守护达到 enforced，${security.totals.missing} 项缺失。`,
      evidence: [],
      action: '按安全守护清单补齐认证、授权与供应链扫描，并纳入 CI 强制门禁。',
      source: 'heuristic',
    });
  }

  if (coverage.line !== null && coverage.line < 40) {
    push({
      id: 'heur-coverage',
      level: coverage.line < 25 ? 'high' : 'medium',
      category: '测试',
      title: `测试覆盖率偏低（${coverage.line}%${coverage.estimated ? '，估算' : ''}）`,
      detail: coverage.note || '核心模块缺少自动化测试，重构风险较高。',
      evidence: (coverage.untestedModules || []).slice(0, 3).map((module) => ({ label: module.label, path: module.path })),
      action: '优先为核心域服务补齐单元测试与契约测试，并在 CI 中设置覆盖率门禁。',
      source: 'heuristic',
    });
  }

  for (const hotspot of (complexity.hotspots || []).slice(0, 3)) {
    if (hotspot.score < 62) continue;
    push({
      id: `heur-complexity-${hotspot.path}`,
      level: hotspot.score >= 80 ? 'high' : 'medium',
      category: '可维护性',
      title: `模块「${hotspot.label}」复杂度偏高（${hotspot.score}/100）`,
      detail: hotspot.reason || `该模块规模与耦合度排名靠前，修改成本高。`,
      evidence: [{ label: hotspot.label, path: hotspot.path }],
      action: `拆分${hotspot.label}的职责边界，优先处理最大的文件与最深的依赖链。`,
      source: 'heuristic',
    });
  }

  const untestedModules = (coverage.untestedModules || []).filter((module) => module.reason === '无测试文件');
  if (untestedModules.length >= 3) {
    push({
      id: 'heur-untested-modules',
      level: 'low',
      category: '测试',
      title: `${untestedModules.length} 个模块没有任何测试`,
      detail: untestedModules.slice(0, 5).map((module) => module.label).join('、'),
      evidence: untestedModules.slice(0, 3).map((module) => ({ label: module.label, path: module.path })),
      action: '从改动最频繁的模块开始补测试，先覆盖关键业务规则。',
      source: 'heuristic',
    });
  }

  const hasCi = repo.files.some((file) => file.path.startsWith('.github/workflows/') || file.path.startsWith('.gitlab-ci'));
  if (!hasCi) {
    push({
      id: 'heur-no-ci',
      level: 'medium',
      category: '架构',
      title: '缺少持续集成流水线配置',
      detail: '未发现 .github/workflows 或 .gitlab-ci 等 CI 配置，架构守护规则无法自动执行。',
      evidence: [],
      action: '补充 CI 流水线，把安全扫描、测试与依赖检查作为合并门禁。',
      source: 'heuristic',
    });
  }

  const hasLockfile = repo.files.some((file) => ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(file.name));
  const hasNode = (deps?.stats?.packages || 0) > 0 && (deps?.ecosystems || []).some((eco) => eco.id === 'npm');
  if (hasNode && !hasLockfile) {
    push({
      id: 'heur-no-lockfile',
      level: 'low',
      category: '依赖',
      title: '前端依赖缺少锁文件',
      detail: '依赖版本不可复现，可能存在供应链与构建漂移风险。',
      evidence: [],
      action: '提交 lockfile 并在 CI 使用 frozen install。',
      source: 'heuristic',
    });
  }
  return {
    risks: risks
      .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.level] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.level] ?? 3))
      .slice(0, 8),
  };
}

export function heuristicRecommendations({ security, complexity, coverage, architecture, knowledge }) {
  const list = [];
  const missingGuards = (security.guards || [])
    .filter((guard) => guard.status !== 'enforced' && ['critical', 'high'].includes(guard.severity))
    .slice(0, 3);
  for (const guard of missingGuards) {
    list.push({
      id: `heur-rec-guard-${guard.id}`,
      title: `补齐${guard.name}`,
      detail: guard.recommendation || guard.note || `在${guard.category}层补齐该守护。`,
      priority: guard.severity === 'critical' ? 'P0' : 'P1',
      modules: [],
    });
  }
  for (const hotspot of (complexity.hotspots || []).slice(0, 2)) {
    list.push({
      id: `heur-rec-complexity-${hotspot.path}`,
      title: `治理复杂度热点：${hotspot.label}`,
      detail: `${hotspot.reason || '模块规模偏大'}。建议按领域拆分模块、下沉公共能力，并为改造补充回归测试。`,
      priority: hotspot.score >= 80 ? 'P1' : 'P2',
      modules: [hotspot.path],
    });
  }
  if (coverage.line !== null && coverage.line < 55) {
    list.push({
      id: 'heur-rec-coverage',
      title: '建立分层测试策略',
      detail: `当前覆盖率${coverage.estimated ? '（估算）' : ''}为 ${coverage.line}%。先为核心领域服务补单测与契约测试，再逐步扩展到集成测试。`,
      priority: 'P1',
      modules: [],
    });
  }
  if (architecture.stats?.datastores === 0 && architecture.stats?.services > 0) {
    list.push({
      id: 'heur-rec-datastore',
      title: '明确数据存储边界',
      detail: '架构中未识别到数据组件，建议显式声明持久化与缓存依赖，便于容量与故障域分析。',
      priority: 'P2',
      modules: [],
    });
  }
  return list.slice(0, 5);
}

export function heuristicModuleInsights({ complexity, coverage, security }) {
  const insights = [];
  for (const hotspot of (complexity.hotspots || []).slice(0, 6)) {
    const coverageModule = (coverage.modules || []).find((module) => module.path === hotspot.path);
    const verdict = hotspot.score >= 78 ? '高风险' : hotspot.score >= 60 ? '需关注' : '健康';
    const actions = [];
    if (hotspot.score >= 60) actions.push(`拆分 ${hotspot.label} 的职责，优先处理最大文件`);
    if (coverageModule && coverageModule.line !== null && coverageModule.line < 50) {
      actions.push(`测试覆盖 ${coverageModule.line}%，补齐关键路径单测`);
    }
    if (hotspot.fanOut >= 10) actions.push('收敛对外依赖，避免模块成为耦合中心');
    insights.push({
      module: hotspot.path,
      label: hotspot.label,
      verdict,
      summary: hotspot.reason || `复杂度 ${hotspot.score}/100`,
      actions: actions.slice(0, 2),
      metrics: { complexity: hotspot.score, coverage: coverageModule?.line ?? null },
    });
  }
  return insights;
}

export function mergeHeuristicAnalysis({ architecture, knowledge, security, complexity, coverage, deps, repo, product, snapshot }) {
  const { risks } = heuristicRisks({ security, complexity, coverage, architecture, knowledge, deps, repo });
  const recommendations = heuristicRecommendations({ security, complexity, coverage, architecture, knowledge });
  const moduleInsights = heuristicModuleInsights({ complexity, coverage, security });
  const overview = [
    `${product.name} 当前为 ${architecture.stats.services} 个服务、${architecture.stats.clients} 个客户端的系统。`,
    `安全守护覆盖 ${security.score}/100（${security.level}），${coverage.estimated ? '估算' : '实测'}行覆盖率 ${coverage.line ?? '未知'}%。`,
    `系统复杂度 ${complexity.score}/100，热点模块 ${(complexity.hotspots || []).slice(0, 2).map((item) => item.label).join('、') || '无'}。`,
  ].join('');
  return { risks, recommendations, moduleInsights, overview };
}

/* ------------------------------------------------------------------ */
/* LLM                                                                 */
/* ------------------------------------------------------------------ */

function applyArchitectureEnrichment(architecture, data) {
  const next = structuredClone(architecture);
  const byId = new Map(next.nodes.map((node) => [node.id, node]));
  next.generatedBy = 'llm';

  if (data.overview) next.overview = truncate(data.overview, 400);
  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      const target = next.groups.find((item) => item.id === group.id);
      if (target && typeof group.label === 'string' && group.label.trim()) target.label = group.label.trim().slice(0, 24);
    }
  }
  if (Array.isArray(data.nodes)) {
    for (const patch of data.nodes.slice(0, 200)) {
      const node = byId.get(patch?.id);
      if (!node) continue;
      if (typeof patch.label === 'string' && patch.label.trim()) node.label = patch.label.trim().slice(0, 40);
      if (typeof patch.sublabel === 'string') node.sublabel = patch.sublabel.trim().slice(0, 60);
      if (typeof patch.tag === 'string') node.tag = patch.tag.trim().slice(0, 30);
      if (typeof patch.note === 'string' && patch.note.trim()) node.note = patch.note.trim().slice(0, 240);
    }
  }
  if (Array.isArray(data.addNodes)) {
    for (const raw of data.addNodes.slice(0, 12)) {
      if (!raw?.id || typeof raw.id !== 'string' || !raw.id.startsWith('ext:')) continue;
      if (byId.has(raw.id)) continue;
      const layer = ['external', 'infra', 'data'].includes(raw.layer) ? raw.layer : 'external';
      const node = {
        id: raw.id,
        label: String(raw.label || '外部系统').slice(0, 40),
        sublabel: String(raw.sublabel || '').slice(0, 60),
        tag: String(raw.tag || '外部依赖').slice(0, 30),
        layer,
        group: layer === 'external' ? 'external' : layer === 'data' ? 'storage' : 'infra',
        kind: layer === 'external' ? 'external' : 'infra',
        module: null,
        path: null,
        loc: 0,
        files: 0,
        lang: null,
        tech: null,
        health: { complexity: null, coverage: null },
        drill: false,
        note: typeof raw.note === 'string' ? raw.note.slice(0, 240) : '',
      };
      next.nodes.push(node);
      byId.set(node.id, node);
    }
  }
  if (Array.isArray(data.addEdges)) {
    for (const raw of data.addEdges.slice(0, 30)) {
      if (!byId.has(raw?.from) || !byId.has(raw?.to) || raw.from === raw.to) continue;
      const kind = ['sync', 'async', 'data', 'depends'].includes(raw.kind) ? raw.kind : 'depends';
      if (next.edges.some((edge) => edge.from === raw.from && edge.to === raw.to && edge.kind === kind)) continue;
      next.edges.push({
        from: raw.from,
        to: raw.to,
        kind,
        count: 1,
        ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim().slice(0, 30) } : {}),
      });
    }
  }
  next.stats = {
    ...next.stats,
    nodes: next.nodes.length,
    edges: next.edges.length,
    services: next.nodes.filter((node) => node.kind === 'service').length,
    clients: next.nodes.filter((node) => node.kind === 'frontend').length,
    datastores: next.nodes.filter((node) => ['database', 'cache', 'mq', 'search'].includes(node.kind)).length,
  };
  next.subtitle = [
    next.stats.clients ? `${next.stats.clients} 个客户端` : null,
    next.stats.services ? `${next.stats.services} 个服务` : null,
    next.stats.datastores ? `${next.stats.datastores} 个数据组件` : null,
    `${next.stats.edges} 条依赖连接`,
  ]
    .filter(Boolean)
    .join('，');
  next.notes = [...(next.notes || []), '业务分层的命名与外部依赖由大模型基于仓库证据做了语义增强。'];
  return next;
}

function applyKnowledgeEnrichment(knowledge, data) {
  const next = structuredClone(knowledge);
  next.generatedBy = 'llm';
  const nodeById = new Map(next.nodes.map((node) => [node.id, node]));
  const domainById = new Map(next.domains.map((domain) => [domain.id, domain]));

  if (Array.isArray(data.domains)) {
    for (const patch of data.domains.slice(0, 20)) {
      const domain = domainById.get(patch?.id);
      if (!domain) continue;
      if (typeof patch.label === 'string' && patch.label.trim()) domain.label = patch.label.trim().slice(0, 24);
      if (typeof patch.description === 'string' && patch.description.trim()) domain.description = patch.description.trim().slice(0, 160);
      const node = nodeById.get(domain.id);
      if (node) {
        node.label = domain.label;
        node.description = domain.description;
      }
    }
  }

  if (Array.isArray(data.capabilities)) {
    for (const raw of data.capabilities.slice(0, 40)) {
      if (!raw?.label || !domainById.has(raw.domain)) continue;
      const id = raw.id && String(raw.id).startsWith('cap:llm:') ? raw.id : `cap:llm:${next.nodes.length}`;
      if (nodeById.has(id)) continue;
      const node = {
        id,
        label: String(raw.label).slice(0, 30),
        kind: 'capability',
        domain: raw.domain,
        description: String(raw.description || '').slice(0, 140),
        module: null,
        size: 24,
      };
      next.nodes.push(node);
      nodeById.set(id, node);
      next.edges.push({ from: raw.domain, to: id, kind: 'contains' });
    }
  }

  if (Array.isArray(data.entities)) {
    for (const raw of data.entities.slice(0, 40)) {
      const existing = raw?.id ? nodeById.get(raw.id) : null;
      if (existing) {
        if (typeof raw.label === 'string' && raw.label.trim()) existing.label = raw.label.trim().slice(0, 30);
        if (typeof raw.description === 'string' && raw.description.trim()) existing.description = raw.description.trim().slice(0, 140);
        continue;
      }
      if (!raw?.label) continue;
      const id = `entity:llm:${next.nodes.length}`;
      const node = {
        id,
        label: String(raw.label).slice(0, 30),
        kind: 'entity',
        domain: domainById.has(raw.domain) ? raw.domain : null,
        description: String(raw.description || '业务实体').slice(0, 140),
        module: null,
        size: 16,
      };
      next.nodes.push(node);
      nodeById.set(id, node);
      if (node.domain) next.edges.push({ from: node.domain, to: id, kind: 'owns' });
    }
  }

  if (Array.isArray(data.addEdges)) {
    for (const raw of data.addEdges.slice(0, 40)) {
      if (!nodeById.has(raw?.from) || !nodeById.has(raw?.to) || raw.from === raw.to) continue;
      const kind = String(raw.kind || 'depends');
      if (next.edges.some((edge) => edge.from === raw.from && edge.to === raw.to && edge.kind === kind)) continue;
      next.edges.push({
        from: raw.from,
        to: raw.to,
        kind,
        ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim().slice(0, 20) } : {}),
      });
    }
  }

  if (Array.isArray(data.flows)) {
    next.flows = data.flows.slice(0, 6).map((flow, index) => ({
      id: `flow:${index}`,
      name: String(flow.name || `流程 ${index + 1}`).slice(0, 30),
      description: String(flow.description || '').slice(0, 200),
      steps: Array.isArray(flow.steps)
        ? flow.steps
            .slice(0, 10)
            .map((step) => ({
              label: String(step?.label || '').slice(0, 30),
              domain: domainById.has(step?.domain) ? step.domain : null,
            }))
            .filter((step) => step.label)
        : [],
    }));
  }

  if (data.summary) next.summary = truncate(data.summary, 400);
  next.stats = {
    ...next.stats,
    domains: next.domains.length,
    capabilities: next.nodes.filter((node) => node.kind === 'capability').length,
    entities: next.nodes.filter((node) => node.kind === 'entity').length,
    nodes: next.nodes.length,
    edges: next.edges.length,
  };
  next.subtitle = [
    `${next.stats.domains} 个业务域`,
    `${next.stats.capabilities} 项能力`,
    `${next.stats.apis} 个接口`,
    `${next.stats.entities} 个实体`,
    `${next.stats.events} 个事件`,
  ].join(' · ');
  next.notes = [...(next.notes || []), '业务域命名、能力拆解与主流程由大模型基于代码证据补充。'];
  return next;
}

function validateRisks(rawRisks, evidence) {
  const risks = [];
  for (const raw of (rawRisks || []).slice(0, 8)) {
    if (!raw?.title) continue;
    const level = clampRiskLevel(raw.level);
    const evidenceItems = Array.isArray(raw.evidence)
      ? raw.evidence.slice(0, 3).map((item) => ({
          label: String(item?.label || '').slice(0, 40),
          ...(item?.path ? { path: String(item.path).slice(0, 200) } : {}),
        }))
      : [];
    risks.push({
      id: `llm-risk-${risks.length}`,
      level,
      category: String(raw.category || '架构').slice(0, 12),
      title: String(raw.title).slice(0, 80),
      detail: String(raw.detail || '').slice(0, 400),
      evidence: evidenceItems,
      action: String(raw.action || '').slice(0, 300),
      source: 'llm',
    });
  }
  return risks;
}

export async function enrichWithLlm({ config, evidence, architecture, knowledge, heuristic }) {
  const archPayload = JSON.stringify(evidence);

  const archTask = `下面是仓库证据（JSON）。请完成两件事，并严格按给定 JSON 结构输出：
1. 架构图语义增强：只修改已有节点（按 id）的 label/sublabel/tag，使其体现真实业务职责（中文、短）；可补充外部系统节点（id 必须以 "ext:" 开头，layer 为 "external"）和缺失的关键连接。
2. 业务知识图谱：对已有业务域 domain（按 id）给出更准确的中文名称与一句描述；补充 3-8 个关键业务能力（capability，必须指定已有 domain id）；给出 2-4 条主业务流程（flows，steps 引用已有 domain id 或只给 label）；可补充关键实体与跨域关系。

证据：
${archPayload}

输出结构（字段可省略，不要输出多余字段；nodes 最多 18 条、addNodes 最多 8 条、addEdges 最多 12 条、knowledge 各数组最多 12 条，文字精简）：
{
  "architecture": {
    "overview": "2-3 句系统架构概述",
    "nodes": [{"id": "mod:...", "label": "订单服务", "sublabel": "Spring Boot · Java", "tag": "12 个接口", "note": "职责一句话"}],
    "addNodes": [{"id": "ext:payment", "label": "第三方支付", "layer": "external", "kind": "external", "sublabel": "外部依赖", "note": ""}],
    "addEdges": [{"from": "mod:...", "to": "ext:payment", "kind": "sync", "label": "支付回调"}],
    "groups": [{"id": "business", "label": "业务服务"}]
  },
  "knowledge": {
    "domains": [{"id": "domain:...", "label": "交易域", "description": "负责下单、订单状态与履约编排"}],
    "capabilities": [{"id": "cap:llm:order-create", "label": "下单", "domain": "domain:...", "description": "..."}],
    "entities": [{"id": "entity:...", "label": "订单项", "description": "...", "domain": "domain:..."}],
    "flows": [{"name": "下单履约主流程", "description": "...", "steps": [{"label": "创建订单", "domain": "domain:..."}]}],
    "addEdges": [{"from": "domain:...", "to": "domain:...", "kind": "depends", "label": "调用"}],
    "summary": "一句话业务概览"
  }
}`;

  const riskTask = `下面是仓库证据（JSON）。请以技术负责人视角输出架构风险与治理建议，严格按 JSON 结构，只输出 JSON：
- risks：最多 8 条，必须具体到模块/指标/配置，level 取 high/medium/low，category 取 架构/安全/可维护性/测试/依赖/性能。
- recommendations：最多 6 条可执行治理建议，priority 取 P0/P1/P2。
- moduleInsights：针对复杂度最高的 3-6 个模块给出 verdict（健康/需关注/高风险）与 1-2 条 action。
- overview：2-3 句整体健康度判断（中文）。
- 输出务必精简：每条 detail 不超过 120 字，每条 evidence 最多 2 条，避免重复证据；整个 JSON 控制在 6000 tokens 内。

证据：
${archPayload}

输出结构：
{
  "risks": [{"level": "high", "category": "安全", "title": "...", "detail": "...", "evidence": [{"label": "...", "path": "..."}], "action": "..."}],
  "recommendations": [{"title": "...", "detail": "...", "priority": "P1", "modules": ["backend/mall-order-service"]}],
  "moduleInsights": [{"module": "backend/mall-order-service", "label": "订单服务", "verdict": "需关注", "summary": "...", "actions": ["..."]}],
  "overview": "..."
}`;

  const requestArch = () => chatJson(config, { system: SYSTEM_ARCH, user: archTask, maxTokens: 12000, timeoutMs: 240000 });
  const requestRisk = () => chatJson(config, { system: SYSTEM_RISK, user: riskTask, maxTokens: 8000, timeoutMs: 240000 });

  // Run both in parallel for speed, but fall back to a sequential retry when a
  // provider rejects/drops one of two concurrent long requests (DeepSeek and
  // some gateways limit concurrency per key).
  const [archSettled, riskSettled] = await Promise.allSettled([requestArch(), requestRisk()]);
  const archResult = archSettled.status === 'fulfilled' ? archSettled.value : await requestArch();
  const riskResult = riskSettled.status === 'fulfilled' ? riskSettled.value : await requestRisk();

  const nextArchitecture = applyArchitectureEnrichment(architecture, archResult.data.architecture || {});
  const nextKnowledge = applyKnowledgeEnrichment(knowledge, archResult.data.knowledge || {});
  const risks = validateRisks(riskResult.data.risks, evidence);
  const recommendations = Array.isArray(riskResult.data.recommendations)
    ? riskResult.data.recommendations.slice(0, 6).map((raw, index) => ({
        id: `llm-rec-${index}`,
        title: String(raw?.title || '治理建议').slice(0, 80),
        detail: String(raw?.detail || '').slice(0, 400),
        priority: ['P0', 'P1', 'P2'].includes(raw?.priority) ? raw.priority : 'P2',
        modules: Array.isArray(raw?.modules) ? raw.modules.slice(0, 4).map((module) => String(module).slice(0, 200)) : [],
        source: 'llm',
      }))
    : [];
  const moduleInsights = Array.isArray(riskResult.data.moduleInsights)
    ? riskResult.data.moduleInsights.slice(0, 8).map((raw, index) => ({
        module: String(raw?.module || ''),
        label: String(raw?.label || raw?.module || '').slice(0, 40),
        verdict: ['健康', '需关注', '高风险'].includes(raw?.verdict) ? raw.verdict : '需关注',
        summary: String(raw?.summary || '').slice(0, 240),
        actions: Array.isArray(raw?.actions) ? raw.actions.slice(0, 3).map((action) => String(action).slice(0, 160)) : [],
        source: 'llm',
      }))
    : [];

  const mergedRisks = [...risks, ...heuristic.risks]
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.level] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.level] ?? 3))
    .slice(0, 8);
  const mergedRecommendations = [...recommendations, ...heuristic.recommendations].slice(0, 6);

  return {
    architecture: nextArchitecture,
    knowledge: nextKnowledge,
    risks: mergedRisks,
    recommendations: mergedRecommendations,
    moduleInsights: moduleInsights.length > 0 ? moduleInsights : heuristic.moduleInsights,
    overview: riskResult.data.overview || archResult.data.architecture?.overview || heuristic.overview,
    usage: { arch: archResult.usage, risk: riskResult.usage },
    raw: { architecture: archResult.data, risk: riskResult.data },
  };
}
