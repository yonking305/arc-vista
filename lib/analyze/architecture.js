import { detectTech, countEndpoints } from './evidence.js';

const LAYERS = [
  { id: 'client', label: '用户触点', kind: 'client' },
  { id: 'edge', label: '接入层', kind: 'edge' },
  { id: 'service', label: '服务层', kind: 'service' },
  { id: 'data', label: '数据层', kind: 'data' },
  { id: 'infra', label: '基础设施', kind: 'infra' },
  { id: 'external', label: '外部依赖', kind: 'external' },
];

const GROUPS = [
  { id: 'clients', label: '客户端应用', layer: 'client', kind: 'client' },
  { id: 'gateway', label: '接入网关', layer: 'edge', kind: 'edge' },
  { id: 'business', label: '业务服务', layer: 'service', kind: 'service' },
  { id: 'shared', label: '共享组件', layer: 'service', kind: 'shared' },
  { id: 'storage', label: '数据与消息', layer: 'data', kind: 'data' },
  { id: 'infra', label: '基础设施', layer: 'infra', kind: 'infra' },
  { id: 'external', label: '外部系统', layer: 'external', kind: 'external' },
];

const SHARED_SEGMENT = /(^|[-_])(common|commons|shared|lib|libs|core|sdk|utils?|packages?|components?|ui-kit)([-_]|$)/i;
const isSharedPath = (value) => String(value).split('/').some((segment) => SHARED_SEGMENT.test(segment));
const SHARED_PATH = { test: isSharedPath };
const CLIENT_PATH = /(^|\/)(apps?|clients?|frontend|web|ui|miniapp)(\/|$)/i;
const GATEWAY_PATH = /gateway|bff|proxy|edge/i;

const DSTORE_MATCHERS = [
  { kind: 'mysql', label: 'MySQL', test: /mysql|mariadb/i, layer: 'data', nodeKind: 'database' },
  { kind: 'postgres', label: 'PostgreSQL', test: /postgres|pg-jdbc/i, layer: 'data', nodeKind: 'database' },
  { kind: 'mongo', label: 'MongoDB', test: /mongo/i, layer: 'data', nodeKind: 'database' },
  { kind: 'redis', label: 'Redis', test: /redis|jedis|lettuce/i, layer: 'data', nodeKind: 'cache' },
  { kind: 'kafka', label: 'Kafka', test: /kafka/i, layer: 'data', nodeKind: 'mq' },
  { kind: 'rabbitmq', label: 'RabbitMQ', test: /rabbit|amqp/i, layer: 'data', nodeKind: 'mq' },
  { kind: 'elasticsearch', label: 'Elasticsearch', test: /elasticsearch|opensearch/i, layer: 'data', nodeKind: 'search' },
];

function moduleTokens(module) {
  return module.name
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[-_](service|server|api|app|module|core|web|mq)$/g, '')
    .split(/[-_.]/)
    .filter((token) => token.length >= 3 && !['mall', 'cloud', 'common', 'shared'].includes(token));
}

function matchModuleByTarget(target, modules) {
  const value = String(target || '').toLowerCase();
  if (!value) return null;
  return (
    modules.find((module) => {
      const name = module.name.toLowerCase();
      return value === name || value.endsWith(name) || name.endsWith(value) || value.includes(name);
    }) ||
    modules.find((module) => moduleTokens(module).some((token) => value.includes(token))) ||
    null
  );
}

function frameworkTag(tech, module) {
  const base = tech.label || (module.langs?.[0]?.lang ? module.langs[0].lang : '代码模块');
  return base;
}

/**
 * Heuristic architecture model: deterministic, derived only from repository evidence.
 * The LLM enrichment layer may refine labels/edges afterwards, but this model always exists.
 */
export function analyzeArchitecture(repo, ctx) {
  const { modulesInfo, graph, deps, routes = [], compose, feign = [], complexity, coverage } = ctx;
  const modules = modulesInfo.modules;
  const nodes = [];
  const edges = [];
  const nodeByModule = new Map();
  const edgeMap = new Map();

  const addNode = (node) => {
    nodes.push(node);
    return node;
  };
  const addEdge = (from, to, kind, label = null, weight = 1) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += weight;
      return;
    }
    const edge = { from, to, kind, count: weight };
    if (label) edge.label = label;
    edgeMap.set(key, edge);
    edges.push(edge);
  };

  const complexityByPath = new Map((complexity?.modules || []).map((item) => [item.path, item]));
  const coverageByPath = new Map((coverage?.modules || []).map((item) => [item.path, item]));

  const routeCount = new Map();
  for (const route of routes) routeCount.set(route.moduleId, (routeCount.get(route.moduleId) || 0) + 1);

  const isGatewayModule = (module) => {
    if (GATEWAY_PATH.test(module.path) || GATEWAY_PATH.test(module.name)) return true;
    const pkgs = deps?.packages || [];
    return pkgs.some(
      (pkg) => pkg.dir === module.path && /spring-cloud-gateway|zuul|envoy|apisix/.test(pkg.name.toLowerCase()),
    );
  };
  const isSharedModule = (module) =>
    (isSharedPath(module.path) && !isGatewayModule(module)) ||
    (module.group === 'backend' && (routeCount.get(module.id) || 0) === 0 && module.sourceFiles < 5 && !isGatewayModule(module));

  const frontendModules = modules.filter(
    (module) => module.group === 'frontend' && module.sourceFiles > 0 && !isSharedPath(module.path),
  );
  const sharedFrontend = modules.filter(
    (module) => module.group === 'frontend' && (isSharedPath(module.path) || module.sourceFiles === 0),
  );
  const backendModules = modules.filter((module) => module.group === 'backend' && module.sourceFiles > 0);
  const gatewayModules = backendModules.filter(isGatewayModule);
  const sharedBackend = backendModules.filter((module) => !isGatewayModule(module) && isSharedModule(module));
  const serviceModules = backendModules.filter(
    (module) => !isGatewayModule(module) && !isSharedModule(module),
  );

  // ---- clients -------------------------------------------------------------
  for (const module of frontendModules) {
    const tech = detectTech(module, deps);
    const comp = complexityByPath.get(module.path);
    const node = addNode({
      id: `mod:${module.id}`,
      label: module.label,
      sublabel: frameworkTag(tech, module),
      tag: `${module.sourceFiles} 个源文件`,
      layer: 'client',
      group: 'clients',
      kind: 'frontend',
      module: module.id,
      path: module.path,
      loc: module.loc,
      files: module.sourceFiles,
      lang: module.langs?.[0]?.lang || null,
      tech: tech.label,
      health: {
        complexity: comp?.score ?? null,
        coverage: coverageByPath.get(module.path)?.line ?? null,
      },
      drill: true,
    });
    nodeByModule.set(module.id, node.id);
  }

  if (sharedFrontend.length > 0) {
    const node = addNode({
      id: 'shared:frontend',
      label: '前端共享包',
      sublabel: sharedFrontend.map((module) => module.name).slice(0, 2).join(' · ') || '共享代码',
      tag: `${sharedFrontend.length} 个共享模块`,
      layer: 'service',
      group: 'shared',
      kind: 'shared',
      module: sharedFrontend[0].id,
      path: sharedFrontend[0].path,
      loc: sharedFrontend.reduce((total, module) => total + module.loc, 0),
      files: sharedFrontend.reduce((total, module) => total + module.sourceFiles, 0),
      lang: sharedFrontend[0].langs?.[0]?.lang || null,
      tech: '前端共享依赖',
      health: { complexity: null, coverage: null },
      drill: true,
    });
    for (const module of sharedFrontend) nodeByModule.set(module.id, node.id);
  }

  // ---- gateway -------------------------------------------------------------
  for (const module of gatewayModules) {
    const tech = detectTech(module, deps);
    const node = addNode({
      id: `mod:${module.id}`,
      label: 'API 网关',
      sublabel: tech.label,
      tag: `${module.sourceFiles} 个源文件`,
      layer: 'edge',
      group: 'gateway',
      kind: 'gateway',
      module: module.id,
      path: module.path,
      loc: module.loc,
      files: module.sourceFiles,
      lang: module.langs?.[0]?.lang || null,
      tech: tech.label,
      health: { complexity: null, coverage: null },
      drill: true,
    });
    nodeByModule.set(module.id, node.id);
  }

  // ---- services ------------------------------------------------------------
  const serviceNodeByModule = new Map();
  for (const module of serviceModules) {
    const tech = detectTech(module, deps);
    const comp = complexityByPath.get(module.path);
    const endpoints = routeCount.get(module.id) || 0;
    const node = addNode({
      id: `mod:${module.id}`,
      label: module.label,
      sublabel: tech.label || '后端服务',
      tag: endpoints > 0 ? `${endpoints} 个接口` : `${module.sourceFiles} 个源文件`,
      layer: 'service',
      group: 'business',
      kind: 'service',
      module: module.id,
      path: module.path,
      loc: module.loc,
      files: module.sourceFiles,
      lang: module.langs?.[0]?.lang || null,
      tech: tech.label,
      endpoints,
      health: {
        complexity: comp?.score ?? null,
        coverage: coverageByPath.get(module.path)?.line ?? null,
      },
      drill: true,
    });
    nodeByModule.set(module.id, node.id);
    serviceNodeByModule.set(module.id, node);
  }

  if (sharedBackend.length > 0) {
    const node = addNode({
      id: 'shared:backend',
      label: '后端公共组件',
      sublabel: sharedBackend
        .map((module) => module.name.replace(/^mall-common-/, '').replace(/^common-/, ''))
        .slice(0, 3)
        .join(' · '),
      tag: `${sharedBackend.length} 个共享模块`,
      layer: 'service',
      group: 'shared',
      kind: 'shared',
      module: sharedBackend[0].id,
      path: sharedBackend[0].path,
      loc: sharedBackend.reduce((total, module) => total + module.loc, 0),
      files: sharedBackend.reduce((total, module) => total + module.sourceFiles, 0),
      lang: sharedBackend[0].langs?.[0]?.lang || null,
      tech: '公共能力',
      health: { complexity: null, coverage: null },
      drill: true,
    });
    for (const module of sharedBackend) nodeByModule.set(module.id, node.id);
  }

  // ---- datastores & infra ---------------------------------------------------
  const datastoreUsage = new Map(); // kind -> Set(moduleId)
  for (const module of backendModules) {
    const pkgs = (deps?.packages || []).filter((pkg) => pkg.dir === module.path);
    for (const matcher of DSTORE_MATCHERS) {
      if (pkgs.some((pkg) => matcher.test.test(pkg.name))) {
        if (!datastoreUsage.has(matcher.kind)) datastoreUsage.set(matcher.kind, new Set());
        datastoreUsage.get(matcher.kind).add(module.id);
      }
    }
  }
  // Usage signals catch middleware consumed through shared libraries (no direct driver dependency).
  const USAGE_SIGNALS = [
    { kind: 'kafka', pattern: /@KafkaListener|KafkaTemplate|KafkaProducer|KafkaConsumer|MallTopics/ },
    { kind: 'rabbitmq', pattern: /@RabbitListener|RabbitTemplate|convertAndSend|AmqpTemplate/ },
    { kind: 'redis', pattern: /RedisTemplate|StringRedisTemplate|@Cacheable|RedisConnection|redisTemplate/ },
  ];
  for (const module of backendModules) {
    const files = repo.files.filter(
      (file) => file.kind === 'source' && file.path.startsWith(`${module.path}/`),
    );
    let matched = new Set();
    for (const file of files) {
      const text = repo.read(file.path);
      if (!text) continue;
      for (const signal of USAGE_SIGNALS) {
        if (!signal.pattern.test(text)) continue;
        if (!matched.has(signal.kind)) matched.add(signal.kind);
      }
      if (matched.size === USAGE_SIGNALS.length) break;
    }
    for (const kind of matched) {
      if (!datastoreUsage.has(kind)) datastoreUsage.set(kind, new Set());
      datastoreUsage.get(kind).add(module.id);
    }
  }

  const composeServices = compose?.services || [];
  const datastoreNodes = new Map();
  const addDatastore = (kind, label, layer = 'data', nodeKind = 'database', tag = '') => {
    if (datastoreNodes.has(kind)) return datastoreNodes.get(kind);
    const node = addNode({
      id: `ds:${kind}`,
      label,
      sublabel: layer === 'infra' ? '基础设施' : '数据组件',
      tag: tag || (layer === 'infra' ? '运行支撑' : '持久化'),
      layer,
      group: layer === 'infra' ? 'infra' : 'storage',
      kind: nodeKind,
      module: null,
      path: null,
      loc: 0,
      files: 0,
      lang: null,
      tech: null,
      health: { complexity: null, coverage: null },
      drill: false,
    });
    datastoreNodes.set(kind, node);
    return node;
  };

  for (const service of composeServices) {
    if (service.layer === 'infra' || service.layer === 'observability' || service.layer === 'storage') {
      addDatastore(service.kind, service.label, 'infra', 'infra', '运行支撑');
    } else if (service.layer === 'database' || service.layer === 'cache' || service.layer === 'mq' || service.layer === 'search') {
      addDatastore(service.kind, service.label, 'data', service.layer === 'mq' ? 'mq' : service.layer === 'cache' ? 'cache' : 'database', service.image || '');
    }
  }
  for (const [kind] of datastoreUsage) {
    if (!datastoreNodes.has(kind)) {
      const matcher = DSTORE_MATCHERS.find((item) => item.kind === kind);
      if (matcher) addDatastore(kind, matcher.label, 'data', matcher.nodeKind, '来自依赖推断');
    }
  }

  // ---- edges: clients → gateway/services -------------------------------------
  const gatewayNodes = gatewayModules.map((module) => nodeByModule.get(module.id)).filter(Boolean);
  if (gatewayNodes.length > 0) {
    for (const module of frontendModules) {
      const from = nodeByModule.get(module.id);
      for (const gatewayId of gatewayNodes) addEdge(from, gatewayId, 'sync', 'HTTPS', 1);
    }
  } else {
    const targets = serviceModules.slice(0, 6);
    for (const module of frontendModules) {
      const from = nodeByModule.get(module.id);
      const text = [];
      for (const file of repo.files) {
        if (file.kind !== 'source' || modulesInfo.byFile.get(file.path) !== module.id) continue;
        const content = repo.read(file.path);
        if (content) text.push(content.toLowerCase());
        if (text.length >= 12) break;
      }
      const haystack = text.join('\n');
      const matched = targets.filter((service) =>
        moduleTokens(service).some((token) => haystack.includes(token)),
      );
      for (const service of matched.length ? matched : targets.slice(0, 1)) {
        addEdge(from, nodeByModule.get(service.id), 'sync', 'API', 1);
      }
    }
  }

  // ---- edges: gateway → services (from route config when available) ----------
  let gatewayRoutes = [];
  for (const module of gatewayModules) {
    const configFiles = repo.files.filter(
      (file) =>
        file.kind === 'config' &&
        file.path.startsWith(`${module.path}/`) &&
        /\.(ya?ml|properties)$/.test(file.name),
    );
    for (const file of configFiles) {
      const text = repo.read(file.path);
      if (!text) continue;
      const blocks = text.split(/-\s+id\s*:/).slice(1);
      for (const block of blocks) {
        const routeId = (block.match(/^\s*([\w.-]+)/)?.[1] || '').replace(/-(events?|route)$/i, '');
        const uri = block.match(/uri\s*:\s*["']?([^"'\s]+)/)?.[1] || '';
        const pathPredicate = block.match(/Path\s*=\s*([^\s,"']+)/)?.[1] || '';
        const uriTarget = uri.replace(/^lb:\/\//, '').replace(/^https?:\/\//, '').split(':')[0];
        const targetModule =
          matchModuleByTarget(routeId, serviceModules) || matchModuleByTarget(uriTarget, serviceModules);
        if (targetModule) {
          gatewayRoutes.push({
            from: nodeByModule.get(module.id),
            to: nodeByModule.get(targetModule.id),
            label: pathPredicate || null,
          });
        }
      }
    }
  }
  if (gatewayRoutes.length > 0) {
    for (const route of gatewayRoutes) addEdge(route.from, route.to, 'sync', route.label, 1);
  } else {
    for (const gateway of gatewayNodes) {
      for (const service of serviceModules) addEdge(gateway.id, nodeByModule.get(service.id), 'sync', null, 1);
    }
  }

  // ---- edges: service ↔ service (Feign / HTTP clients) -----------------------
  for (const client of feign) {
    const from = nodeByModule.get(client.moduleId);
    const targetModule = matchModuleByTarget(client.target, serviceModules);
    if (from && targetModule) {
      addEdge(from, nodeByModule.get(targetModule.id), 'sync', 'Feign');
    }
  }

  // ---- edges: imports (shared libraries, cross-module imports) ---------------
  for (const edge of graph.moduleEdges) {
    const from = nodeByModule.get(edge.from);
    const to = nodeByModule.get(edge.to);
    if (!from || !to || from === to) continue;
    addEdge(from, to, 'depends', null, edge.count);
  }

  // ---- edges: services → datastores -----------------------------------------
  for (const [kind, moduleIds] of datastoreUsage) {
    const dsNode = datastoreNodes.get(kind);
    if (!dsNode) continue;
    for (const moduleId of moduleIds) {
      const from = nodeByModule.get(moduleId);
      if (!from) continue;
      addEdge(from, dsNode.id, kind === 'kafka' || kind === 'rabbitmq' ? 'async' : 'data', null, 1);
    }
  }

  // ---- health note ----------------------------------------------------------
  const stats = {
    nodes: nodes.length,
    edges: edges.length,
    modules: modules.length,
    clients: frontendModules.length,
    services: serviceModules.length,
    shared: sharedFrontend.length + sharedBackend.length,
    datastores: [...datastoreNodes.values()].filter((node) => node.layer === 'data').length,
    layers: LAYERS.length,
  };

  const subtitleParts = [];
  if (stats.clients) subtitleParts.push(`${stats.clients} 个客户端`);
  if (stats.services) subtitleParts.push(`${stats.services} 个服务`);
  if (stats.datastores) subtitleParts.push(`${stats.datastores} 个数据组件`);
  subtitleParts.push(`${stats.edges} 条依赖连接`);

  return {
    title: '系统架构',
    subtitle: subtitleParts.join('，'),
    generatedBy: 'heuristic',
    layers: LAYERS,
    groups: GROUPS,
    nodes,
    edges: edges.map((edge) => ({ ...edge })),
    stats,
    notes: [
      '架构由仓库结构、构建清单、网关路由、Feign 声明与依赖推断生成；配置大模型后可获得更语义化的业务分层。',
    ],
  };
}
