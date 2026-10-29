import { extractModels, extractEvents } from './evidence.js';

const DOMAIN_TOKENS = [
  [/order|trade|checkout/i, '订单'],
  [/product|catalog|sku|goods/i, '商品'],
  [/user|account|identity|auth/i, '用户'],
  [/finance|payment|pay|wallet|billing/i, '支付'],
  [/logistics|shipment|delivery|warehouse|inventory/i, '履约'],
  [/analytics|insight|report|stat/i, '分析'],
  [/gateway|bff/i, '网关'],
  [/cart/i, '购物车'],
  [/coupon|promotion/i, '营销'],
  [/search/i, '搜索'],
  [/notify|notification|message/i, '消息'],
];

const CAPABILITY_WORDS = [
  [/auth|login|token/i, '认证登录'],
  [/order/i, '订单'],
  [/product|catalog|sku/i, '商品'],
  [/inventory/i, '库存'],
  [/shipment|delivery/i, '发货'],
  [/warehouse/i, '仓库'],
  [/payment|pay/i, '支付'],
  [/refund/i, '退款'],
  [/user/i, '用户'],
  [/admin/i, '管理端'],
  [/analytics|stat|insight/i, '分析'],
  [/event/i, '事件接入'],
  [/public/i, '公开接口'],
  [/internal/i, '内部接口'],
  [/cart/i, '购物车'],
  [/coupon|promotion/i, '优惠券'],
  [/review|comment/i, '评价'],
  [/finance/i, '财务'],
  [/logistics/i, '物流'],
];

function translateTokens(tokens, rules) {
  return tokens.map((token) => {
    for (const [regex, label] of rules) if (regex.test(token)) return label;
    return null;
  });
}

function domainLabel(module) {
  const translated = translateTokens([module.name, module.path], DOMAIN_TOKENS).filter(Boolean);
  if (translated.length > 0) return `${translated[0]}域`;
  return module.label.replace(/服务$/, '') + '域';
}

function capabilityLabel(controllerName) {
  const base = controllerName.replace(/Controller$/, '');
  const tokens = base.match(/[A-Z][a-z0-9]*/g) || [base];
  const translated = translateTokens(tokens, CAPABILITY_WORDS);
  const words = translated.filter(Boolean);
  if (words.length === 0) return `${base} 能力`;
  const joined = words.join('');
  return /管理$/.test(joined) ? joined : `${joined}管理`;
}

export function analyzeKnowledge(repo, ctx) {
  const { modulesInfo, routes = [], architecture, deps } = ctx;
  const modules = modulesInfo.modules;
  const domains = [];
  const nodes = [];
  const edges = [];
  const edgeSeen = new Set();
  const nodeSeen = new Set();

  const addNode = (node) => {
    if (nodeSeen.has(node.id)) return;
    nodeSeen.add(node.id);
    nodes.push(node);
  };
  const addEdge = (from, to, kind, label = null) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind, ...(label ? { label } : {}) });
  };

  // ---- domains from backend business modules --------------------------------
  const domainByModule = new Map();
  const serviceNodes = (architecture?.nodes || []).filter((node) => node.kind === 'service');
  for (const node of serviceNodes) {
    const module = modules.find((item) => item.id === node.module);
    if (!module) continue;
    const domain = {
      id: `domain:${module.id}`,
      label: domainLabel(module),
      description: `${module.label} · ${module.sourceFiles} 个源文件 · ${node.tag || ''}`.trim(),
      module: module.id,
      kind: 'domain',
      nodeKind: 'domain',
      health: node.health || { complexity: null, coverage: null },
    };
    domains.push(domain);
    addNode({
      id: domain.id,
      label: domain.label,
      kind: 'domain',
      domain: domain.id,
      description: domain.description,
      module: module.id,
      size: 60,
    });
    domainByModule.set(module.id, domain);
  }

  // ---- capabilities from controllers ---------------------------------------
  const controllers = new Map();
  for (const route of routes) {
    if (!route.file) continue;
    const key = route.file;
    if (!controllers.has(key)) controllers.set(key, []);
    controllers.get(key).push(route);
  }
  let capabilityCount = 0;
  for (const [file, fileRoutes] of controllers) {
    const moduleId = fileRoutes[0].moduleId;
    const domain = domainByModule.get(moduleId);
    if (!domain) continue;
    if (capabilityCount >= 36) break;
    const className = file.split('/').pop().replace(/\.(java|kt|ts|js)$/, '');
    const capability = {
      id: `cap:${file}`,
      label: capabilityLabel(className),
      kind: 'capability',
      domain: domain.id,
      description: `${fileRoutes.length} 个接口 · ${className}`,
      module: moduleId,
      size: 24,
    };
    addNode(capability);
    addEdge(domain.id, capability.id, 'contains');
    capabilityCount += 1;
  }

  // ---- APIs ----------------------------------------------------------------
  let apiCount = 0;
  for (const route of routes) {
    if (apiCount >= 90) break;
    const domain = domainByModule.get(route.moduleId);
    if (!domain) continue;
    const id = `api:${route.moduleId}:${route.method}:${route.path}`;
    addNode({
      id,
      label: `${route.method} ${route.path}`,
      kind: 'api',
      domain: domain.id,
      description: route.handler ? `${route.handler}() · ${route.file}` : route.file,
      module: route.moduleId,
      meta: { method: route.method, path: route.path, file: route.file, line: route.line },
      size: 10,
    });
    addEdge(domain.id, id, 'exposes');
    apiCount += 1;
  }

  // ---- entities ------------------------------------------------------------
  const { models, references } = extractModels(repo, modulesInfo);
  const modelIdByEntity = new Map();
  for (const model of models) {
    const domain = domainByModule.get(model.module);
    let id;
    if (domain) {
      id = `entity:${domain.id}:${model.name}`;
      addEdge(domain.id, id, 'owns');
    } else {
      id = `entity:shared:${model.name}`;
    }
    if (nodeSeen.has(id)) continue;
    modelIdByEntity.set(model.id, id);
    addNode({
      id,
      label: model.name,
      kind: 'entity',
      domain: domain?.id || null,
      description: model.description,
      module: model.module,
      meta: { table: model.table, fields: model.fields.slice(0, 8).map((field) => `${field.name}: ${field.type}`) },
      size: 16,
    });
  }
  for (const reference of references) {
    const from = modelIdByEntity.get(reference.from);
    const target = models.find((model) => model.name === reference.toName);
    const to = target ? modelIdByEntity.get(target.id) : null;
    if (from && to) addEdge(from, to, 'references');
  }

  // ---- events --------------------------------------------------------------
  const events = extractEvents(repo, modulesInfo);
  const eventIds = new Map();
  for (const event of events) {
    const domain = domainByModule.get(event.moduleId);
    const id = `event:${event.name}`;
    if (!eventIds.has(event.name)) {
      eventIds.set(event.name, id);
      addNode({
        id,
        label: event.name,
        kind: 'event',
        domain: domain?.id || null,
        description: `领域事件 / 消息主题 · ${event.name}`,
        module: event.moduleId,
        size: 18,
      });
    }
    if (domain) {
      const kind = event.direction === 'consume' ? 'consumes' : 'emits';
      addEdge(domain.id, id, kind);
    }
  }

  // ---- datastores ----------------------------------------------------------
  const datastoreNodes = (architecture?.nodes || []).filter((node) => node.kind === 'database' || node.kind === 'cache' || node.kind === 'mq' || node.kind === 'search');
  for (const store of datastoreNodes) {
    addNode({
      id: `datastore:${store.id}`,
      label: store.label,
      kind: 'datastore',
      domain: null,
      description: `${store.sublabel || '数据组件'}${store.tag ? ` · ${store.tag}` : ''}`,
      module: null,
      size: 28,
    });
  }
  // link domains to datastores through architecture edges
  const dsNodeIds = new Map(datastoreNodes.map((store) => [store.id, `datastore:${store.id}`]));
  for (const edge of architecture?.edges || []) {
    if (edge.kind !== 'data' && edge.kind !== 'async') continue;
    if (!dsNodeIds.has(edge.to)) continue;
    const fromNode = architecture.nodes.find((node) => node.id === edge.from);
    const domain = fromNode ? domainByModule.get(fromNode.module) : null;
    if (domain) addEdge(domain.id, dsNodeIds.get(edge.to), 'uses', edge.kind === 'async' ? '消息' : '读写');
  }

  // ---- actors --------------------------------------------------------------
  const actors = new Map();
  for (const node of architecture?.nodes || []) {
    if (node.kind !== 'frontend') continue;
    const label = /admin|管理|后台/i.test(`${node.label} ${node.module}`) ? '运营人员' : '消费者';
    if (!actors.has(label)) actors.set(label, { id: `actor:${label}`, label, kind: 'actor', description: '系统参与者', size: 34, modules: [] });
    actors.get(label).modules.push(node.id);
  }
  for (const actor of actors.values()) {
    addNode({ ...actor, domain: null, module: null });
  }

  // ---- cross-domain dependencies -------------------------------------------
  const archNodeToModule = new Map((architecture?.nodes || []).map((node) => [node.id, node.module]));
  for (const edge of architecture?.edges || []) {
    if (!['sync', 'depends'].includes(edge.kind)) continue;
    const fromModule = archNodeToModule.get(edge.from);
    const toModule = archNodeToModule.get(edge.to);
    const fromDomain = domainByModule.get(fromModule);
    const toDomain = domainByModule.get(toModule);
    if (fromDomain && toDomain && fromDomain.id !== toDomain.id) {
      addEdge(fromDomain.id, toDomain.id, 'depends', edge.kind === 'sync' ? '调用' : '依赖');
    }
  }

  // actor → reachable domains via gateway routes
  for (const actor of actors.values()) {
    const reached = new Set();
    const frontier = [...actor.modules];
    for (let hop = 0; hop < 2; hop += 1) {
      const next = [];
      for (const nodeId of frontier) {
        for (const edge of architecture?.edges || []) {
          if (edge.from !== nodeId) continue;
          const targetModule = archNodeToModule.get(edge.to);
          const domain = targetModule ? domainByModule.get(targetModule) : null;
          if (domain) reached.add(domain.id);
          else next.push(edge.to);
        }
      }
      frontier.length = 0;
      frontier.push(...next);
    }
    for (const domainId of [...reached].slice(0, 8)) addEdge(actor.id, domainId, 'acts_on', '使用');
  }

  const moduleDeps = deps?.packages || [];
  const distinctPackages = new Set(moduleDeps.map((pkg) => `${pkg.ecosystem}:${pkg.name}`)).size;

  const subtitle = [
    `${domains.length} 个业务域`,
    `${capabilityCount} 项能力`,
    `${apiCount} 个接口`,
    `${models.length} 个实体`,
    `${eventIds.size} 个事件`,
  ].join(' · ');

  return {
    title: '业务知识图谱',
    subtitle,
    generatedBy: 'heuristic',
    domains: domains.map(({ id, label, description, module, health }) => ({ id, label, description, module, health })),
    nodes,
    edges,
    flows: [],
    stats: {
      domains: domains.length,
      capabilities: capabilityCount,
      apis: apiCount,
      entities: models.length,
      events: eventIds.size,
      datastores: datastoreNodes.length,
      actors: actors.size,
      nodes: nodes.length,
      edges: edges.length,
      packages: distinctPackages,
    },
    notes: ['业务域由服务边界推断，能力由 Controller 聚合；配置大模型后会补充业务语义、主流程与跨域事实。'],
  };
}
