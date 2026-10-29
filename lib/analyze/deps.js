import path from 'node:path';

/**
 * Dependency analyzer (contract §6).
 *
 * Reads every manifest exposed by the scanner (`repo.projects` plus a defensive
 * file sweep), normalizes each declaration into a single package list and keeps
 * same-name packages from different modules as separate entries. Everything is
 * deterministic: no timestamps, no absolute paths, stable sort order.
 *
 * Supported manifests:
 *   npm       package.json (dependencies/dev/peer/optional, workspaces included)
 *   maven     pom.xml (parent chain + properties + dependencyManagement)
 *             build.gradle / build.gradle.kts
 *   python    requirements.txt, pyproject.toml (PEP 621 + Poetry)
 *   go        go.mod
 *   rust      Cargo.toml
 *   php       composer.json
 *   ruby      Gemfile
 *   dart      pubspec.yaml
 *
 * When a nearby npm lockfile is readable we attach an optional `resolved`
 * version (declared ranges stay untouched in `version`).
 */

const ECOSYSTEM_LABELS = {
  npm: 'Node.js / npm',
  maven: 'Maven / Gradle',
  python: 'Python',
  go: 'Go Modules',
  rust: 'Cargo',
  php: 'Composer',
  ruby: 'Bundler',
  dart: 'Pub',
};

const MANIFEST_ECOSYSTEM = new Map([
  ['package.json', 'npm'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'maven'],
  ['build.gradle.kts', 'maven'],
  ['requirements.txt', 'python'],
  ['pyproject.toml', 'python'],
  ['go.mod', 'go'],
  ['cargo.toml', 'rust'],
  ['composer.json', 'php'],
  ['gemfile', 'ruby'],
  ['pubspec.yaml', 'dart'],
]);

const SCOPES = new Set(['runtime', 'dev', 'test', 'unknown']);

/* ------------------------------------------------------------------ */
/* small deterministic helpers                                         */
/* ------------------------------------------------------------------ */

function cmpStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeDir(dir) {
  if (!dir || dir === '.' || dir === './') return '.';
  const clean = String(dir).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return clean || '.';
}

function normalizePath(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const normalized = path.posix.normalize(clean);
  return normalized === '.' ? '' : normalized;
}

function normalizeScope(scope) {
  return SCOPES.has(scope) ? scope : 'unknown';
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ */
/* manifest discovery                                                   */
/* ------------------------------------------------------------------ */

function collectManifests(repo) {
  const entries = [];
  const seen = new Set();

  const consider = (relPath, dir) => {
    if (typeof relPath !== 'string' || !relPath) return;
    const normalized = normalizePath(relPath);
    if (!normalized || seen.has(normalized)) return;
    const base = path.posix.basename(normalized).toLowerCase();
    const ecosystem = MANIFEST_ECOSYSTEM.get(base);
    if (!ecosystem) return;
    if (normalized.includes('/node_modules/')) return;
    seen.add(normalized);
    entries.push({
      path: normalized,
      dir: normalizeDir(dir === undefined ? path.posix.dirname(normalized) : dir),
      ecosystem,
    });
  };

  const projects = Array.isArray(repo.projects) ? repo.projects : [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    consider(project.path, project.dir);
  }

  // Defensive sweep: never lose a manifest because a caller passed a stale
  // project list. project.path wins above; this only fills gaps.
  const files = Array.isArray(repo.files) ? repo.files : [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    const base = path.posix.basename(file.path).toLowerCase();
    if (!MANIFEST_ECOSYSTEM.has(base)) continue;
    consider(file.path, file.dir);
  }

  entries.sort((a, b) => cmpStr(a.path, b.path));
  return entries;
}

function readText(repo, relPath) {
  try {
    if (typeof repo.read === 'function') {
      const text = repo.read(relPath);
      if (typeof text === 'string') return text;
    }
  } catch {
    /* ignore unreadable manifest */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* package factory / accumulator                                       */
/* ------------------------------------------------------------------ */

function createCollector(repo, resolveLocked) {
  const packages = [];

  function add(ecosystem, name, version, scope, dir, manifest, options = {}) {
    if (!name || typeof name !== 'string') return;
    let resolved = null;
    if (options.lockLookup && typeof resolveLocked === 'function') {
      try {
        resolved = resolveLocked(name, version, dir, options.lockGroup);
      } catch {
        resolved = null;
      }
    }
    const entry = {
      ecosystem,
      name: name.trim(),
      version: typeof version === 'string' && version.trim() ? version.trim() : null,
      scope: normalizeScope(scope),
      dir,
      manifest,
    };
    if (resolved) entry.resolved = String(resolved);
    packages.push(entry);
  }

  return { packages, add };
}

/* ------------------------------------------------------------------ */
/* npm                                                                 */
/* ------------------------------------------------------------------ */

const NPM_FIELDS = [
  ['dependencies', 'runtime'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'runtime'],
  ['peerDependencies', 'runtime'],
];

function parseNpm(text, dir, manifest, add) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  if (!json || typeof json !== 'object') return;
  for (const [field, scope] of NPM_FIELDS) {
    const table = json[field];
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const name of Object.keys(table).sort()) {
      const raw = table[name];
      const version = typeof raw === 'string' ? raw : null;
      add('npm', name, version, scope, dir, manifest, { lockLookup: true, lockGroup: field });
    }
  }
}

/* ------------------------------------------------------------------ */
/* maven: pom.xml                                                      */
/* ------------------------------------------------------------------ */

function tagValue(block, tag) {
  if (!block) return null;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const match = block.match(re);
  if (!match) return null;
  const value = decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
  return value || null;
}

function firstBlock(text, tag) {
  if (!text) return null;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const match = text.match(re);
  return match ? match[1] : null;
}

function dependencyBlocks(block) {
  const deps = [];
  if (!block) return deps;
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match;
  while ((match = re.exec(block))) {
    const body = match[1];
    deps.push({
      groupId: tagValue(body, 'groupId'),
      artifactId: tagValue(body, 'artifactId'),
      version: tagValue(body, 'version'),
      scope: tagValue(body, 'scope'),
      type: tagValue(body, 'type'),
      optional: tagValue(body, 'optional'),
      classifier: tagValue(body, 'classifier'),
    });
  }
  return deps;
}

function parsePomInfo(relPath, dir, text) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');
  const parentBlock = firstBlock(clean, 'parent');
  let parent = null;
  if (parentBlock) {
    const hasEmptyRelative = /<relativePath\s*\/>/.test(parentBlock);
    parent = {
      groupId: tagValue(parentBlock, 'groupId'),
      artifactId: tagValue(parentBlock, 'artifactId'),
      version: tagValue(parentBlock, 'version'),
      relativePath: hasEmptyRelative ? '' : tagValue(parentBlock, 'relativePath'),
    };
  }

  const propertiesBlock = firstBlock(clean, 'properties');
  const properties = {};
  if (propertiesBlock) {
    const re = /<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g;
    let match;
    while ((match = re.exec(propertiesBlock))) {
      properties[match[1]] = decodeXml(match[2].trim());
    }
  }

  const managementBlock = firstBlock(clean, 'dependencyManagement');
  const managedDeps = dependencyBlocks(managementBlock);

  const withoutParent = clean.replace(/<parent(?:\s[^>]*)?>[\s\S]*?<\/parent>/g, '');
  const header = withoutParent.split(/<(?:dependencies|dependencyManagement|build|profiles|repositories|pluginRepositories|distributionManagement)\b/)[0];

  const directSource = clean
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '')
    .replace(/<reporting>[\s\S]*?<\/reporting>/g, '')
    .replace(/<repositories>[\s\S]*?<\/repositories>/g, '')
    .replace(/<pluginRepositories>[\s\S]*?<\/pluginRepositories>/g, '');

  const dependencies = [];
  const sectionRe = /<dependencies>([\s\S]*?)<\/dependencies>/g;
  let section;
  while ((section = sectionRe.exec(directSource))) {
    dependencies.push(...dependencyBlocks(section[1]));
  }

  return {
    path: relPath,
    dir,
    groupId: tagValue(header, 'groupId'),
    artifactId: tagValue(header, 'artifactId'),
    version: tagValue(header, 'version'),
    parent,
    properties,
    managedDeps,
    dependencies,
  };
}

function interpolate(value, lookup, depth = 0) {
  if (typeof value !== 'string') return value ?? null;
  if (value.indexOf('${') === -1) return value;
  if (depth > 8 || !lookup) return value;
  return value.replace(/\$\{([^}]+)\}/g, (whole, key) => {
    const found = lookup[key];
    if (found === undefined || found === null) return whole;
    return String(interpolate(String(found), lookup, depth + 1));
  });
}

function createMavenResolver(infos) {
  const byPath = new Map();
  const byCoord = new Map();
  for (const info of infos) {
    byPath.set(info.path, info);
    if (info.groupId && info.artifactId) {
      const key = `${info.groupId}:${info.artifactId}`;
      const existing = byCoord.get(key);
      if (!existing || info.path < existing.path) byCoord.set(key, info);
    }
  }

  function parentOf(info) {
    const parent = info.parent;
    if (!parent) return null;
    if (parent.relativePath !== '') {
      const rel = parent.relativePath || '../pom.xml';
      const baseDir = info.dir === '.' ? '' : info.dir;
      const resolved = normalizePath(path.posix.join(baseDir || '.', rel));
      if (byPath.has(resolved)) return byPath.get(resolved);
    }
    if (parent.groupId && parent.artifactId) {
      const found = byCoord.get(`${parent.groupId}:${parent.artifactId}`);
      if (found) return found;
    }
    return null;
  }

  function chainOf(info) {
    const chain = [];
    const seen = new Set();
    let current = info;
    while (current && !seen.has(current.path) && chain.length <= 24) {
      chain.push(current);
      seen.add(current.path);
      current = parentOf(current);
    }
    return chain;
  }

  function buildLookup(info, chain) {
    const properties = {};
    for (const pom of [...chain].reverse()) Object.assign(properties, pom.properties || {});
    const version = info.version || chain.slice(1).map((pom) => pom.version).find(Boolean) || null;
    const parentPom = chain[1] || null;
    const lookup = {
      ...properties,
      'project.version': version,
      'pom.version': version,
      'version': version,
      'project.groupId': info.groupId || parentPom?.groupId || null,
      'pom.groupId': info.groupId || parentPom?.groupId || null,
      'project.artifactId': info.artifactId,
      'pom.artifactId': info.artifactId,
      'project.parent.version': parentPom?.version || info.parent?.version || null,
      'project.parent.groupId': parentPom?.groupId || info.parent?.groupId || null,
      'parent.version': parentPom?.version || info.parent?.version || null,
    };
    return lookup;
  }

  function lookupFor(info) {
    return buildLookup(info, chainOf(info));
  }

  const cache = new Map();

  function contextOf(info) {
    if (cache.has(info.path)) return cache.get(info.path);
    const chain = chainOf(info);
    const lookup = buildLookup(info, chain);

    let springBoot = null;
    for (const pom of chain) {
      const parent = pom.parent;
      if (
        parent &&
        parent.groupId === 'org.springframework.boot' &&
        parent.artifactId &&
        /^spring-boot-(?:starter-parent|dependencies)$/.test(parent.artifactId)
      ) {
        const resolved = interpolate(parent.version, lookupFor(pom));
        if (resolved) springBoot = resolved;
      }
      if (
        pom.groupId === 'org.springframework.boot' &&
        pom.artifactId &&
        /^spring-boot-(?:starter-parent|dependencies)$/.test(pom.artifactId) &&
        pom.version
      ) {
        springBoot = pom.version;
      }
    }
    if (!springBoot) {
      const property = interpolate(lookup['spring-boot.version'] ?? null, lookup);
      if (property) springBoot = property;
    }

    const managed = new Map();
    for (const pom of [...chain].reverse()) {
      const pomLookup = pom === info ? lookup : lookupFor(pom);
      for (const dep of pom.managedDeps) {
        if (!dep.groupId || !dep.artifactId || !dep.version) continue;
        if (dep.scope === 'import' || dep.type === 'pom') continue;
        const value = interpolate(dep.version, pomLookup);
        if (value) managed.set(`${dep.groupId}:${dep.artifactId}`, value);
      }
    }

    const context = { lookup, version: lookup['project.version'], springBoot, managed };
    cache.set(info.path, context);
    return context;
  }

  return { contextOf };
}

function mavenScope(dep) {
  const scope = (dep.scope || '').toLowerCase();
  if (scope === 'test') return 'test';
  if (scope === 'provided' || dep.optional === 'true') return 'dev';
  if (scope === 'import') return 'unknown';
  return 'runtime';
}

function emitPomPackages(info, context, add) {
  const seen = new Set();
  for (const dep of info.dependencies) {
    if (!dep.groupId || !dep.artifactId) continue;
    if (dep.scope === 'import' || dep.type === 'pom') continue;
    const name = `${dep.groupId}:${dep.artifactId}`;
    if (seen.has(name)) continue;
    seen.add(name);

    let version = dep.version ? interpolate(dep.version, context.lookup) : null;
    if (!version) version = context.managed.get(name) || null;
    if (!version && dep.groupId === 'org.springframework.boot' && context.springBoot) {
      version = context.springBoot;
    }
    add('maven', name, version, mavenScope(dep), info.dir, info.path);
  }
}

/* ------------------------------------------------------------------ */
/* maven: build.gradle(.kts)                                           */
/* ------------------------------------------------------------------ */

const GRADLE_CONFIGS = [
  ['testImplementation', 'test'],
  ['testCompileOnly', 'test'],
  ['testRuntimeOnly', 'test'],
  ['testCompile', 'test'],
  ['implementation', 'runtime'],
  ['api', 'runtime'],
  ['compile', 'runtime'],
  ['runtimeOnly', 'runtime'],
  ['runtime', 'runtime'],
  ['compileOnly', 'dev'],
  ['annotationProcessor', 'dev'],
  ['kapt', 'dev'],
  ['ksp', 'dev'],
  ['classpath', 'dev'],
];

function parseGradle(text, dir, manifest, add) {
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const variables = new Map();
  const varRe = /\b(?:ext\.)?([A-Za-z_][\w.]*)\s*=\s*['"]([^'"\n]+)['"]/g;
  let varMatch;
  while ((varMatch = varRe.exec(clean))) variables.set(varMatch[1], varMatch[2]);

  const expand = (value) =>
    String(value)
      .replace(/\$\{([^}]+)\}/g, (whole, key) => variables.get(key.trim()) ?? whole)
      .replace(/\$([A-Za-z_][\w.]*)/g, (whole, key) => variables.get(key) ?? whole);

  const configPattern = GRADLE_CONFIGS.map(([name]) => name).join('|');
  const depRe = new RegExp(
    `\\b(${configPattern})\\s*\\(?\\s*(?:platform\\s*\\(\\s*)?(['"])([^'"\\n]+)\\2`,
    'g',
  );

  let match;
  while ((match = depRe.exec(clean))) {
    const config = match[1];
    const scope = GRADLE_CONFIGS.find(([name]) => name === config)?.[1] || 'runtime';
    const coords = expand(match[3]).split(':');
    if (coords.length < 2) continue;
    const group = coords[0].trim();
    const artifact = coords[1].trim();
    if (!group || !artifact) continue;
    const version = coords.length >= 3 && coords[2].trim() ? coords[2].trim() : null;
    add('maven', `${group}:${artifact}`, version, scope, dir, manifest);
  }
}

/* ------------------------------------------------------------------ */
/* python                                                              */
/* ------------------------------------------------------------------ */

function parseRequirement(spec) {
  let clean = String(spec || '').trim();
  if (!clean) return null;
  clean = clean.split(';')[0].trim();
  if (!clean || clean.startsWith('-') || clean.startsWith('#')) return null;
  if (/^(?:git\+|https?:\/\/|file:|\/)/i.test(clean)) return null;
  clean = clean.replace(/\s+@\s+.*$/, '');
  const match = clean.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  const name = match[1];
  const version = match[2].trim() || null;
  return { name, version };
}

function addRequirement(spec, scope, dir, manifest, add) {
  const parsed = parseRequirement(spec);
  if (!parsed) return;
  add('python', parsed.name, parsed.version, scope, dir, manifest);
}

function parseRequirementsTxt(text, dir, manifest, add) {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (/^(-r|--requirement)\b/i.test(line)) continue;
    if (/^-e\b/.test(line)) continue;
    if (line.startsWith('-')) continue;
    addRequirement(line, 'runtime', dir, manifest, add);
  }
}

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, i);
  }
  return line;
}

function collectTomlArray(lines, startIndex, firstLine) {
  let text = firstLine.slice(firstLine.indexOf('[') + 1);
  let index = startIndex;
  let depth = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1;
    if (text[i] === ']') depth -= 1;
  }
  while (depth > 0 && index + 1 < lines.length) {
    index += 1;
    const next = stripTomlComment(lines[index]);
    text += `\n${next}`;
    for (const char of next) {
      if (char === '[') depth += 1;
      if (char === ']') depth -= 1;
    }
  }
  const items = [];
  const re = /"([^"\n]*)"|'([^'\n]*)'/g;
  let match;
  while ((match = re.exec(text))) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value) items.push(value);
  }
  return { items, endIndex: index };
}

function parsePoetryValue(line) {
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (!value) return null;
  const inlineVersion = value.match(/\bversion\s*=\s*["']([^"']+)["']/);
  if (inlineVersion) return inlineVersion[1];
  const quoted = value.match(/^["']([^"']*)["']/);
  if (quoted) return quoted[1] || null;
  const arrays = value.match(/^\[([\s\S]*?)\]/);
  if (arrays) {
    const inner = arrays[1].match(/["']([^"']+)["']/);
    if (inner) return inner[1];
  }
  return null;
}

function parsePyproject(text, dir, manifest, add) {
  const lines = text.split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripTomlComment(raw).trim();
    if (!line) continue;

    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      section = header[1].trim();
      continue;
    }

    if (section === 'project' && /^dependencies\s*=/.test(line)) {
      const { items, endIndex } = collectTomlArray(lines, i, line);
      i = endIndex;
      for (const item of items) addRequirement(item, 'runtime', dir, manifest, add);
      continue;
    }

    if (section === 'project.optional-dependencies') {
      const keyMatch = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*\[/);
      if (!keyMatch) continue;
      const scope = /test|qa|e2e/i.test(keyMatch[1]) ? 'test' : 'dev';
      const { items, endIndex } = collectTomlArray(lines, i, line);
      i = endIndex;
      for (const item of items) addRequirement(item, scope, dir, manifest, add);
      continue;
    }

    const poetrySection = /^tool\.poetry(?:\.group\.([^.]+))?\.(dev-)?dependencies$/.exec(section);
    if (poetrySection) {
      const keyMatch = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=/);
      if (!keyMatch) continue;
      const name = keyMatch[1];
      if (name.toLowerCase() === 'python') continue;
      const groupName = (poetrySection[1] || '').toLowerCase();
      const isDev = Boolean(poetrySection[2]) || groupName === 'dev';
      const scope = groupName === 'test' ? 'test' : isDev ? 'dev' : 'runtime';
      add('python', name, parsePoetryValue(line), scope, dir, manifest);
      continue;
    }

    // `[dependencies.foo]` style Poetry entries.
    const poetryTable = /^tool\.poetry\.dependencies\.(.+)$/.exec(section);
    if (poetryTable && /^version\s*=/.test(line)) {
      add('python', poetryTable[1].trim(), parsePoetryValue(line), 'runtime', dir, manifest);
    }
  }
}

/* ------------------------------------------------------------------ */
/* go / rust / php / ruby / dart                                       */
/* ------------------------------------------------------------------ */

function parseGoMod(text, dir, manifest, add) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const emit = (name, version, scope) => {
    if (!name || !version) return;
    add('go', name, version, scope, dir, manifest);
  };

  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  let block;
  while ((block = blockRe.exec(clean))) {
    for (const rawLine of block[1].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;
      const match = line.match(/^([^\s]+)\s+([^\s]+)/);
      if (match) emit(match[1], match[2], 'runtime');
    }
  }
  const singleRe = /^\s*require\s+(?!\()([^\s]+)\s+([^\s]+)/gm;
  let single;
  while ((single = singleRe.exec(clean))) emit(single[1], single[2], 'runtime');
}

function parseCargoToml(text, dir, manifest, add) {
  const lines = text.split('\n');
  let section = '';
  let pendingTable = null;
  let pendingScope = 'runtime';

  const flushTable = () => {
    if (!pendingTable) return;
    add('rust', pendingTable, null, pendingScope, dir, manifest);
    pendingTable = null;
    pendingScope = 'runtime';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripTomlComment(lines[i]).trim();
    if (!line) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      flushTable();
      section = header[1].trim();
      const table = /(?:^|\.)(dev-|build-)?dependencies\.(.+)$/.exec(section);
      if (table) {
        pendingTable = table[2].trim().replace(/^['"]|['"]$/g, '');
        pendingScope = table[1] === 'dev-' || table[1] === 'build-' ? 'dev' : 'runtime';
      }
      continue;
    }

    if (pendingTable && /^version\s*=/.test(line)) {
      const value = line.match(/^version\s*=\s*["']([^"']+)["']/);
      add('rust', pendingTable, value ? value[1] : null, pendingScope, dir, manifest);
      pendingTable = null;
      pendingScope = 'runtime';
      continue;
    }

    if (!/(?:^|\.)(dev-|build-)?dependencies$/.test(section)) continue;
    const scope = section.includes('dev-dependencies') ? 'dev' : section.includes('build-dependencies') ? 'dev' : 'runtime';
    const match = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.+)$/);
    if (!match) continue;
    const name = match[1];
    if (name === 'version' || name === 'features') continue;
    const value = match[2].trim();
    let version = null;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = value.match(/^["']([^"']*)["']/);
      version = quoted ? quoted[1] || null : null;
    } else if (value.startsWith('{')) {
      const inline = value.match(/version\s*=\s*["']([^"']+)["']/);
      if (inline) version = inline[1];
    }
    add('rust', name, version, scope, dir, manifest);
  }

  flushTable();
}

function parseComposer(text, dir, manifest, add) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  if (!json || typeof json !== 'object') return;
  for (const [field, scope] of [
    ['require', 'runtime'],
    ['require-dev', 'dev'],
  ]) {
    const table = json[field];
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const name of Object.keys(table).sort()) {
      if (name === 'php' || name.startsWith('ext-') || name.startsWith('lib-')) continue;
      const raw = table[name];
      add('php', name, typeof raw === 'string' ? raw : null, scope, dir, manifest);
    }
  }
}

function parseGemfile(text, dir, manifest, add) {
  const lines = text.split('\n');
  let groupScope = 'runtime';
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const groupOpen = line.match(/^group\s+([^,]+)(?:,\s*([^,]+))?\s+do$/);
    if (groupOpen) {
      const groups = `${groupOpen[1]} ${groupOpen[2] || ''}`.toLowerCase();
      groupScope = groups.includes('test') ? 'test' : groups.includes('development') ? 'dev' : 'runtime';
      continue;
    }
    if (line === 'end') {
      groupScope = 'runtime';
      continue;
    }
    const match = line.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (!match) continue;
    add('ruby', match[1], match[2] || null, groupScope, dir, manifest);
  }
}

function parsePubspec(text, dir, manifest, add) {
  const lines = text.split('\n');
  let section = '';
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent === 0) {
      section = raw.trim().replace(/:$/, '');
      continue;
    }
    if (section !== 'dependencies' && section !== 'dev_dependencies') continue;
    if (indent !== 2) continue;
    const match = raw.trim().match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    if (name === 'flutter' || name === 'sdk') continue;
    const scope = section === 'dev_dependencies' ? 'dev' : 'runtime';
    const value = match[2].replace(/\s+#.*$/, '').trim();
    add('dart', name, value || null, scope, dir, manifest);
  }
}

/* ------------------------------------------------------------------ */
/* npm lockfile resolution (optional, best effort)                     */
/* ------------------------------------------------------------------ */

function versionParts(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (/^(?:workspace|file|link|git|git\+|https?|npm):/i.test(text)) return null;
  if (/^[*^~<>=| ]+$/.test(text)) return null;
  text = text.replace(/^[^0-9]*/, '');
  const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareParts(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function cmpVersionDesc(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const compared = compareParts(pb, pa);
  if (compared !== 0) return compared;
  return cmpStr(b, a);
}

function cleanResolvedVersion(value) {
  if (typeof value !== 'string') return null;
  const version = value.trim().replace(/^["']|["']$/g, '');
  if (!version) return null;
  const cut = version.split('(')[0].trim();
  return /^\d/.test(cut) ? cut : null;
}

function pickLockedVersion(versions, declared) {
  const sorted = [...new Set(versions)].filter((v) => versionParts(v)).sort(cmpVersionDesc);
  if (sorted.length === 0) return null;
  const wanted = typeof declared === 'string' ? declared.trim() : '';
  const base = versionParts(wanted);
  if (!base) return sorted[0];
  if (/^\d/.test(wanted)) {
    return sorted.find((v) => versionParts(v) && compareParts(versionParts(v), base) === 0) || null;
  }
  const caret = wanted.startsWith('^');
  const tilde = wanted.startsWith('~');
  for (const version of sorted) {
    const parts = versionParts(version);
    if (compareParts(parts, base) < 0) continue;
    if (caret && parts[0] !== base[0]) continue;
    if (tilde && (parts[0] !== base[0] || parts[1] !== base[1])) continue;
    return version;
  }
  return null;
}

function relativeTo(lockDir, dir) {
  if (lockDir === dir) return '.';
  if (lockDir === '.') return dir;
  const prefix = `${lockDir}/`;
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : null;
}

function parsePnpmLock(text, lockDir) {
  const lines = text.split('\n');
  const importers = new Map();
  const versions = new Map();
  let section = '';
  let importer = null;
  let group = null;
  let importerEntry = null;
  let packageKey = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const trimmed = rawLine.trim();

    if (indent === 0) {
      section = trimmed.replace(/:$/, '');
      importer = null;
      group = null;
      importerEntry = null;
      packageKey = null;
      continue;
    }

    if (section === 'importers') {
      if (indent === 2) {
        // headers look like `apps/shop:` or `.: {}` (empty importer)
        importer = trimmed.split(':')[0].replace(/^['"]|['"]$/g, '');
        group = null;
        importerEntry = null;
        continue;
      }
      if (indent === 4 && trimmed.endsWith(':')) {
        group = trimmed.slice(0, -1);
        importerEntry = null;
        continue;
      }
      if (indent === 6 && trimmed.endsWith(':') && importer !== null) {
        const name = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, '');
        importerEntry = { group, version: null };
        importers.set(`${importer}\u0000${name}`, importerEntry);
        continue;
      }
      if (indent === 8 && importerEntry) {
        const versionMatch = trimmed.match(/^version:\s*(.+)$/);
        if (!versionMatch) continue;
        const clean = cleanResolvedVersion(versionMatch[1].split(/\s+#/)[0]);
        if (clean) importerEntry.version = clean;
      }
      continue;
    }

    if (section === 'packages') {
      if (indent === 2 && trimmed.endsWith(':')) {
        const key = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, '').split('(')[0];
        const at = key.lastIndexOf('@');
        if (at > 0) {
          const name = key.slice(0, at);
          const version = cleanResolvedVersion(key.slice(at + 1));
          if (version) {
            if (!versions.has(name)) versions.set(name, new Set());
            versions.get(name).add(version);
          }
        }
        packageKey = key;
        continue;
      }
      if (indent === 4 && packageKey) {
        const versionMatch = trimmed.match(/^version:\s*(.+)$/);
        if (versionMatch) {
          const at = packageKey.lastIndexOf('@');
          if (at > 0) {
            const name = packageKey.slice(0, at);
            const clean = cleanResolvedVersion(versionMatch[1].split(/\s+#/)[0]);
            if (clean) {
              if (!versions.has(name)) versions.set(name, new Set());
              versions.get(name).add(clean);
            }
          }
        }
      }
    }
  }

  return { type: 'pnpm', dir: lockDir, importers, versions };
}

function parsePackageLock(text, lockDir) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const versions = new Map();
  const record = (name, version) => {
    if (!name || !cleanResolvedVersion(version)) return;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(cleanResolvedVersion(version));
  };
  const packages = json && json.packages;
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      if (!key) continue;
      const index = key.lastIndexOf('node_modules/');
      if (index === -1) continue;
      const name = key.slice(index + 'node_modules/'.length);
      if (!name || name.includes('/node_modules/')) continue;
      record(name, packages[key] && packages[key].version);
    }
  }
  const legacy = json && json.dependencies;
  if (legacy && typeof legacy === 'object') {
    const walk = (table) => {
      for (const name of Object.keys(table)) {
        const entry = table[name];
        if (!entry || typeof entry !== 'object') continue;
        record(name, entry.version);
        if (entry.dependencies && typeof entry.dependencies === 'object') walk(entry.dependencies);
      }
    };
    walk(legacy);
  }
  return { type: 'package-lock', dir: lockDir, versions };
}

function parseYarnLock(text, lockDir) {
  const specs = new Map();
  const versions = new Map();
  let headers = null;
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    if (indent === 0) {
      if (!rawLine.trim().endsWith(':')) {
        headers = null;
        continue;
      }
      headers = rawLine
        .trim()
        .slice(0, -1)
        .split(',')
        .map((part) => part.trim().replace(/^['"]|['"]$/g, '').replace(/@npm:/g, '@'))
        .filter(Boolean);
      continue;
    }
    const versionMatch = rawLine.match(/^\s+version\s*:?\s+"?([^"\s]+)"?/);
    if (versionMatch && headers) {
      const version = cleanResolvedVersion(versionMatch[1]);
      if (!version) continue;
      for (const spec of headers) {
        specs.set(spec, version);
        const at = spec.lastIndexOf('@');
        if (at > 0) {
          const name = spec.slice(0, at);
          if (!versions.has(name)) versions.set(name, new Set());
          versions.get(name).add(version);
        }
      }
      headers = null;
    }
  }
  return { type: 'yarn', dir: lockDir, specs, versions };
}

function createLockResolver(repo) {
  const cache = new Map();
  const parsedLocks = new Map();

  function findLock(dir) {
    const start = normalizeDir(dir);
    if (cache.has(start)) return cache.get(start);
    const segments = start === '.' ? [] : start.split('/');
    const candidates = [];
    for (let i = segments.length; i >= 0; i -= 1) {
      candidates.push(segments.slice(0, i).join('/') || '.');
    }
    let found = null;
    for (const candidate of candidates) {
      for (const [name, type] of [
        ['pnpm-lock.yaml', 'pnpm'],
        ['package-lock.json', 'package-lock'],
        ['yarn.lock', 'yarn'],
      ]) {
        const lockPath = candidate === '.' ? name : `${candidate}/${name}`;
        const text = readText(repo, lockPath);
        if (!text) continue;
        const cacheKey = `${type}\u0000${lockPath}`;
        try {
          if (!parsedLocks.has(cacheKey)) {
            const parsed =
              type === 'pnpm'
                ? parsePnpmLock(text, candidate)
                : type === 'package-lock'
                  ? parsePackageLock(text, candidate)
                  : parseYarnLock(text, candidate);
            parsedLocks.set(cacheKey, parsed || null);
          }
          const parsed = parsedLocks.get(cacheKey);
          if (parsed) {
            found = parsed;
            break;
          }
        } catch {
          parsedLocks.set(cacheKey, null);
        }
      }
      if (found) break;
    }
    cache.set(start, found);
    return found;
  }

  return function resolve(name, declared, dir) {
    const lock = findLock(dir);
    if (!lock) return null;
    const relative = relativeTo(lock.dir, normalizeDir(dir));
    if (lock.type === 'pnpm') {
      // pnpm records the resolved version per importer. A workspace that is not
      // listed in the lockfile must stay unresolved rather than borrowing a
      // sibling workspace's version.
      if (relative === null) return null;
      const entry = lock.importers.get(`${relative}\u0000${name}`);
      return entry && entry.version ? entry.version : null;
    }
    if (lock.type === 'yarn' && typeof declared === 'string') {
      const spec = lock.specs.get(`${name}@${declared}`);
      if (spec) return spec;
    }
    const versions = lock.versions.get(name);
    return versions ? pickLockedVersion(versions, declared) : null;
  };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * Analyze dependency declarations across every manifest in the repository.
 * @param {object} repo scan result produced by `scanRepo`
 * @returns {object} JSON-serializable dependency analysis (contract §6)
 */
export function analyzeDeps(repo) {
  const safeRepo = repo && typeof repo === 'object' ? repo : {};
  const manifests = collectManifests(safeRepo);
  const resolveLocked = createLockResolver(safeRepo);
  const { packages, add } = createCollector(safeRepo, resolveLocked);

  const pomInfos = [];
  for (const entry of manifests) {
    if (entry.ecosystem !== 'maven') continue;
    if (path.posix.basename(entry.path) !== 'pom.xml') continue;
    const text = readText(safeRepo, entry.path);
    if (!text) continue;
    try {
      pomInfos.push(parsePomInfo(entry.path, entry.dir, text));
    } catch {
      /* malformed pom: keep the manifest, skip its packages */
    }
  }
  const mavenResolver = createMavenResolver(pomInfos);
  const pomByPath = new Map(pomInfos.map((info) => [info.path, info]));

  const manifestStats = new Map();

  for (const entry of manifests) {
    const text = readText(safeRepo, entry.path);
    const before = packages.length;
    if (text) {
      try {
        const base = path.posix.basename(entry.path).toLowerCase();
        if (base === 'package.json') {
          parseNpm(text, entry.dir, entry.path, add);
        } else if (base === 'pom.xml') {
          const info = pomByPath.get(entry.path);
          if (info) emitPomPackages(info, mavenResolver.contextOf(info), add);
        } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
          parseGradle(text, entry.dir, entry.path, add);
        } else if (base === 'requirements.txt') {
          parseRequirementsTxt(text, entry.dir, entry.path, add);
        } else if (base === 'pyproject.toml') {
          parsePyproject(text, entry.dir, entry.path, add);
        } else if (base === 'go.mod') {
          parseGoMod(text, entry.dir, entry.path, add);
        } else if (base === 'cargo.toml') {
          parseCargoToml(text, entry.dir, entry.path, add);
        } else if (base === 'composer.json') {
          parseComposer(text, entry.dir, entry.path, add);
        } else if (base === 'gemfile') {
          parseGemfile(text, entry.dir, entry.path, add);
        } else if (base === 'pubspec.yaml') {
          parsePubspec(text, entry.dir, entry.path, add);
        }
      } catch {
        /* one broken manifest must not break the whole analysis */
      }
    }
    manifestStats.set(entry.path, {
      path: entry.path,
      type: entry.ecosystem,
      packages: packages.length - before,
    });
  }

  // Stable de-duplication: two identical declarations (same module) count once.
  const seen = new Set();
  const deduped = [];
  for (const pkg of packages) {
    const key = [pkg.ecosystem, pkg.name, pkg.version ?? '', pkg.scope, pkg.dir, pkg.manifest, pkg.resolved ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(pkg);
  }

  deduped.sort(
    (a, b) =>
      cmpStr(a.ecosystem, b.ecosystem) ||
      cmpStr(a.name, b.name) ||
      cmpStr(a.dir, b.dir) ||
      cmpStr(a.version ?? '', b.version ?? '') ||
      cmpStr(a.scope, b.scope) ||
      cmpStr(a.manifest, b.manifest),
  );

  const ecosystemMap = new Map();
  for (const entry of manifests) {
    if (!ecosystemMap.has(entry.ecosystem)) {
      ecosystemMap.set(entry.ecosystem, {
        id: entry.ecosystem,
        label: ECOSYSTEM_LABELS[entry.ecosystem] || entry.ecosystem,
        packages: 0,
        manifestSet: new Set(),
      });
    }
    ecosystemMap.get(entry.ecosystem).manifestSet.add(entry.path);
  }
  for (const pkg of deduped) {
    if (!ecosystemMap.has(pkg.ecosystem)) {
      ecosystemMap.set(pkg.ecosystem, { id: pkg.ecosystem, label: ECOSYSTEM_LABELS[pkg.ecosystem] || pkg.ecosystem, packages: 0, manifestSet: new Set() });
    }
    const bucket = ecosystemMap.get(pkg.ecosystem);
    bucket.packages += 1;
    bucket.manifestSet.add(pkg.manifest);
  }
  const ecosystems = [...ecosystemMap.values()]
    .map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      packages: bucket.packages,
      manifests: [...bucket.manifestSet].sort(cmpStr),
    }))
    .sort((a, b) => cmpStr(a.id, b.id));

  const manifestList = [...manifestStats.values()].sort((a, b) => cmpStr(a.path, b.path));

  return {
    ecosystems,
    packages: deduped,
    manifests: manifestList,
    stats: {
      packages: deduped.length,
      runtime: deduped.filter((pkg) => pkg.scope === 'runtime').length,
      dev: deduped.filter((pkg) => pkg.scope === 'dev').length,
      manifests: manifestList.length,
    },
  };
}
