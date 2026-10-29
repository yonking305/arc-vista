/** Shared, deterministic evidence extractors used by the architecture map, knowledge graph and drill-down. */

const JAVA_MAPPING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/;

function joinRoute(base, sub) {
  const left = (base || '').replace(/\/+$/, '');
  const right = (sub || '').replace(/^\/+/, '');
  if (!left && !right) return '/';
  return `${left.startsWith('/') || !left ? left : `/${left}`}/${right}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function extractJavaRoutes(repo, file, moduleId) {
  if (!file.path.endsWith('.java') && !file.path.endsWith('.kt')) return [];
  const text = repo.read(file.path);
  if (!text) return [];
  if (!/@(RestController|Controller)\b/.test(text)) return [];
  const lines = text.split('\n');
  let classIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/\b(class|interface)\s+\w+/.test(lines[i])) {
      classIndex = i;
      break;
    }
  }
  if (classIndex === -1) return [];
  let classBase = '';
  for (let i = 0; i < classIndex; i += 1) {
    const match = lines[i].match(/@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/);
    if (match) classBase = match[1];
  }
  const routes = [];
  for (let i = classIndex; i < lines.length; i += 1) {
    const annotation = lines[i].match(JAVA_MAPPING);
    if (!annotation) continue;
    const kind = annotation[1];
    let path = '';
    let httpMethod = kind === 'Request' ? 'ANY' : kind.toUpperCase();
    const sameLine = lines.slice(i, i + 3).join(' ');
    const pathMatch = sameLine.match(/@\w*Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:\{\s*)?["']([^"']*)["']/);
    if (pathMatch) path = pathMatch[1];
    const methodMatch = sameLine.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/);
    if (methodMatch) httpMethod = methodMatch[1];
    let handler = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const signature = lines[j].match(/^\s*(?:public|protected|private|static|final|\s)*[\w<>\[\],.?\s]+\s+(\w+)\s*\(/);
      if (signature && !/^(if|for|while|switch|catch|new)$/.test(signature[1])) {
        handler = signature[1];
        break;
      }
      if (/^\s*@/.test(lines[j])) continue;
      if (/\b(class|interface)\b/.test(lines[j])) break;
    }
    if (!handler) continue;
    routes.push({
      moduleId,
      method: httpMethod,
      path: joinRoute(classBase, path),
      handler,
      file: file.path,
      line: i + 1,
    });
  }
  return routes;
}

function extractNodeRoutes(repo, file, moduleId) {
  const text = repo.read(file.path);
  if (!text) return [];
  const routes = [];

  // NestJS-style controllers.
  if (/@Controller\s*\(/.test(text)) {
    const classBase = text.match(/@Controller\s*\(\s*["']([^"']*)["']/)?.[1] || '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:["']([^"']*)["'])?/);
      if (!match) continue;
      routes.push({
        moduleId,
        method: match[1].toUpperCase(),
        path: joinRoute(classBase, match[2] || ''),
        handler: null,
        file: file.path,
        line: i + 1,
      });
    }
    return routes;
  }

  const patterns = [
    /(?:\brouter|\bapp|\bserver|\bfastify)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /@(?:app|router|bp|blueprint)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const line = text.slice(0, match.index).split('\n').length;
      routes.push({
        moduleId,
        method: match[1].toUpperCase() === 'ALL' ? 'ANY' : match[1].toUpperCase(),
        path: match[2],
        handler: null,
        file: file.path,
        line,
      });
    }
  }
  return routes;
}

export function extractRoutes(repo, modulesInfo, { max = 500 } = {}) {
  const routes = [];
  for (const file of repo.files) {
    if (file.kind !== 'source') continue;
    const moduleId = modulesInfo.byFile.get(file.path);
    if (!moduleId) continue;
    if (['java', 'kotlin'].includes(file.lang)) routes.push(...extractJavaRoutes(repo, file, moduleId));
    else if (['javascript', 'typescript', 'vue', 'svelte'].includes(file.lang)) {
      routes.push(...extractNodeRoutes(repo, file, moduleId));
    }
    if (routes.length >= max) break;
  }
  const seen = new Set();
  return routes
    .filter((route) => {
      const key = `${route.moduleId}|${route.method}|${route.path}|${route.file}:${route.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.path.localeCompare(b.path))
    .slice(0, max);
}

const ENTITY_DIRS = /\/(entity|entities|model|models|domain|po|dto|types)\//i;

export function extractModels(repo, modulesInfo, { max = 120 } = {}) {
  const models = [];
  const knownNames = new Set();
  const candidates = repo.files.filter(
    (file) =>
      file.kind === 'source' &&
      (file.path.match(ENTITY_DIRS) || /\.d\.ts$/.test(file.path)) &&
      !/\.(test|spec)\./.test(file.path),
  );

  for (const file of candidates) {
    if (models.length >= max) break;
    const text = repo.read(file.path);
    if (!text) continue;
    const moduleId = modulesInfo.byFile.get(file.path);
    const label = moduleId?.split('/').pop() || '';
    if (['java', 'kotlin'].includes(file.lang)) {
      const classMatches = text.matchAll(/\b(?:public\s+)?(?:class|record|enum)\s+(\w+)/g);
      for (const match of classMatches) {
        if (models.length >= max) break;
        const name = match[1];
        if (/(Controller|Service|Repository|Mapper|Application|Test|Config|Exception)$/.test(name)) continue;
        if (/^(Request|Response|Result|Page|Base)/.test(name)) continue;
        if (/(Request|Response|Result|View|Dto|DTO|Command|Query|Vo|VO|Payload|Message|Event)$/.test(name)) continue;
        const table = text.match(/@Table\s*\(\s*name\s*=\s*["']([^"']+)["']/)?.[1] || null;
        const fields = [];
        for (const field of text.matchAll(/^\s*(?:private|public|protected)\s+([\w<>\[\], ?]+)\s+(\w+)\s*;/gm)) {
          if (fields.length >= 12) break;
          fields.push({ name: field[2], type: field[1].trim() });
        }
        models.push({
          id: `entity:${file.path}:${name}`,
          name,
          label: name,
          table,
          module: moduleId,
          file: file.path,
          fields,
          description: table ? `数据表 ${table}` : `领域模型 · ${label}`,
        });
        knownNames.add(name);
      }
    } else if (['typescript', 'javascript'].includes(file.lang)) {
      const ifaceRe = /export\s+(?:interface|type|class)\s+(\w+)/g;
      let match;
      while ((match = ifaceRe.exec(text))) {
        if (models.length >= max) break;
        const name = match[1];
        if (/(Props|State|Context|Config|Options|Params|Result|Response|Request)$/.test(name)) continue;
        models.push({
          id: `entity:${file.path}:${name}`,
          name,
          label: name,
          table: null,
          module: moduleId,
          file: file.path,
          fields: [],
          description: `前端类型 · ${label}`,
        });
        knownNames.add(name);
      }
    }
  }

  const references = new Set();
  for (const model of models) {
    for (const field of model.fields) {
      for (const name of knownNames) {
        if (name !== model.name && field.type.includes(name)) references.add(`${model.id}\u0000${name}`);
      }
    }
  }
  return {
    models,
    references: [...references].map((key) => {
      const [from, name] = key.split('\u0000');
      return { from, toName: name };
    }),
  };
}

export function extractEvents(repo, modulesInfo, { max = 80 } = {}) {
  const events = [];
  const constants = new Map();

  // Pass 1: topic constants (e.g. MallTopics.PAYMENT_SUCCEEDED = "cloudmall.payment.succeeded")
  for (const file of repo.files) {
    if (!['java', 'kotlin', 'typescript', 'javascript'].includes(file.lang) || file.kind !== 'source') continue;
    const text = repo.read(file.path);
    if (!text) continue;
    for (const match of text.matchAll(/(?:static\s+final\s+String|final\s+String|const)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*["']([^"']{2,140})["']/g)) {
      constants.set(match[1], match[2]);
      constants.set(match[2], match[2]);
    }
  }

  const add = (name, moduleId, direction) => {
    const value = String(name || '').trim().replace(/^["']|["']$/g, '');
    if (!value || value.length > 140 || events.length >= max) return;
    if (!/^[\w.:-]+$/.test(value)) return;
    if (events.some((event) => event.name === value && event.moduleId === moduleId && event.direction === direction)) return;
    events.push({ id: `${moduleId}|${value}|${direction}`, name: value, moduleId, direction });
  };

  const resolveExpr = (expr) => {
    const clean = String(expr || '').trim().replace(/^\{\s*/, '').replace(/[}\s]+$/, '');
    if (!clean) return null;
    const literal = clean.match(/^["']([^"']+)["']$/);
    if (literal) return literal[1];
    const symbol = clean.split('.').pop();
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(symbol)) return constants.get(symbol) || null;
    return null;
  };

  for (const file of repo.files) {
    if (!['java', 'kotlin', 'javascript', 'typescript'].includes(file.lang) || file.kind !== 'source') continue;
    const moduleId = modulesInfo.byFile.get(file.path);
    if (!moduleId) continue;
    const text = repo.read(file.path);
    if (!text) continue;

    // Consumers: Kafka / Rabbit listeners
    for (const match of text.matchAll(/@(?:Kafka|Rabbit)Listener\s*\(([\s\S]{0,600}?)\)/g)) {
      const body = match[1];
      for (const entry of body.matchAll(/(?:topics|topicPattern|queues|queue)\s*=\s*(\{[^}]*\}|[^,)]+)/g)) {
        const raw = entry[1].replace(/^\{|\}$/g, '');
        for (const piece of raw.split(/\s*,\s*/)) {
          const resolved = resolveExpr(piece);
          if (resolved) add(resolved, moduleId, 'consume');
        }
      }
    }

    // Producers: KafkaTemplate.send(topic, ...) / rabbitTemplate.convertAndSend(exchange, routingKey, ...)
    for (const match of text.matchAll(/(?:KafkaTemplate|kafkaTemplate|producer|rabbitTemplate|amqpTemplate)\s*\.\s*(?:send|convertAndSend)\s*\(\s*([^,)]+)/g)) {
      const resolved = resolveExpr(match[1]);
      if (resolved) add(resolved, moduleId, 'produce');
    }

    // Explicit topic constants in send/publish calls
    for (const match of text.matchAll(/(?:publish|emit|send)\s*\(\s*([A-Za-z_][\w.]*)\s*,/g)) {
      const resolved = resolveExpr(match[1]);
      if (resolved) add(resolved, moduleId, 'produce');
    }
  }

  return events
    .sort((a, b) => a.name.localeCompare(b.name) || a.moduleId.localeCompare(b.moduleId))
    .slice(0, max);
}

export function extractFeign(repo, modulesInfo, { max = 80 } = {}) {
  const clients = [];
  for (const file of repo.files) {
    if (!['java', 'kotlin'].includes(file.lang) || file.kind !== 'source') continue;
    const moduleId = modulesInfo.byFile.get(file.path);
    if (!moduleId) continue;
    const text = repo.read(file.path);
    if (!text || !/@FeignClient/.test(text)) continue;
    for (const match of text.matchAll(/@FeignClient\s*\(([\s\S]*?)\)/g)) {
      const body = match[1];
      const name = body.match(/(?:name|value|serviceId|url)\s*=\s*["']([^"']+)["']/)?.[1] || null;
      const pathValue = body.match(/path\s*=\s*["']([^"']+)["']/)?.[1] || '';
      if (!name) continue;
      const target = name.replace(/^https?:\/\//, '').replace(/^lb:\/\//, '').split('/')[0];
      if (clients.length >= max) break;
      clients.push({ moduleId, target, path: pathValue, file: file.path });
    }
  }
  return clients;
}

const COMPOSE_IMAGE_KINDS = [
  [/mysql|mariadb/i, 'mysql', 'MySQL', 'database'],
  [/postgres/i, 'postgres', 'PostgreSQL', 'database'],
  [/mongo/i, 'mongo', 'MongoDB', 'database'],
  [/redis/i, 'redis', 'Redis', 'cache'],
  [/kafka/i, 'kafka', 'Kafka', 'mq'],
  [/rabbitmq/i, 'rabbitmq', 'RabbitMQ', 'mq'],
  [/elasticsearch|opensearch/i, 'elasticsearch', 'Elasticsearch', 'search'],
  [/nacos|consul|eureka|zookeeper/i, 'registry', '注册中心', 'infra'],
  [/prometheus/i, 'prometheus', 'Prometheus', 'observability'],
  [/grafana/i, 'grafana', 'Grafana', 'observability'],
  [/minio/i, 'minio', 'MinIO', 'storage'],
  [/nginx|traefik/i, 'proxy', '反向代理', 'infra'],
  [/zipkin|jaeger/i, 'tracing', '链路追踪', 'observability'],
];

export function parseCompose(repo) {
  const candidates = repo.files.filter((file) => /docker-compose.*\.ya?ml$/i.test(file.name) && file.depth <= 2);
  for (const file of candidates) {
    const text = repo.read(file.path);
    if (!text) continue;
    const lines = text.split('\n');
    let inServices = false;
    let current = null;
    const services = [];
    for (const line of lines) {
      if (/^services\s*:/.test(line)) {
        inServices = true;
        continue;
      }
      if (/^\w+:/.test(line) && !/^services/.test(line)) inServices = false;
      if (!inServices) continue;
      const nameMatch = line.match(/^ {2}([\w.-]+)\s*:\s*$/);
      if (nameMatch) {
        current = { name: nameMatch[1], image: '', kind: 'other', label: nameMatch[1] };
        services.push(current);
        continue;
      }
      const imageMatch = line.match(/^\s+image\s*:\s*["']?([^"'\s]+)/);
      if (imageMatch && current) current.image = imageMatch[1];
    }
    for (const service of services) {
      for (const [regex, kind, label, layer] of COMPOSE_IMAGE_KINDS) {
        if (regex.test(service.image) || regex.test(service.name)) {
          service.kind = kind;
          service.label = label;
          service.layer = layer;
          break;
        }
      }
    }
    if (services.length) return { path: file.path, services };
  }
  return null;
}

const TECH_RULES = [
  [/spring-boot|spring-cloud/, 'Spring Boot'],
  [/spring-security/, 'Spring Security'],
  [/mybatis/, 'MyBatis'],
  [/^react$/, 'React'],
  [/^vue$/, 'Vue'],
  [/^next$/, 'Next.js'],
  [/^@tarojs\//, 'Taro'],
  [/^expo$/, 'Expo'],
  [/^express$/, 'Express'],
  [/^@nestjs\//, 'NestJS'],
  [/^fastify$/, 'Fastify'],
  [/^koa$/, 'Koa'],
  [/^django$/, 'Django'],
  [/^fastapi$/, 'FastAPI'],
  [/^gin-gonic/, 'Gin'],
  [/^actix/, 'Actix'],
];

const LANG_LABEL = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  java: 'Java',
  kotlin: 'Kotlin',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'Ruby',
  vue: 'Vue',
  svelte: 'Svelte',
  scala: 'Scala',
  swift: 'Swift',
  dart: 'Dart',
};

export function detectTech(module, deps) {
  if (!module) return { framework: null, language: null, label: '' };
  const packages = (deps?.packages || []).filter((pkg) => pkg.dir === module.path);
  const names = packages.map((pkg) => pkg.name.toLowerCase());
  const frameworks = [];
  for (const [regex, label] of TECH_RULES) {
    if (names.some((name) => regex.test(name)) && !frameworks.includes(label)) frameworks.push(label);
    if (frameworks.length >= 2) break;
  }
  const language = LANG_LABEL[module.langs?.[0]?.lang] || null;
  const parts = [...frameworks];
  if (language && !parts.includes(language)) parts.push(language);
  return { framework: frameworks[0] || null, language, label: parts.join(' · ') };
}

export function countEndpoints(routes, moduleId) {
  return routes.filter((route) => route.moduleId === moduleId).length;
}
