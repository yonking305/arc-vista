import path from 'node:path';

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

export function packageOfSpecifier(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  const clean = spec.startsWith('node:') ? spec.slice(5) : spec;
  const parts = clean.split('/');
  if (clean.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function parseJsImports(text) {
  const specs = new Set();
  const patterns = [
    /(?:^|[^.\w])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) specs.add(match[1]);
  }
  return [...specs];
}

function resolveJsFile(repo, fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const candidates = [
    base,
    ...JS_EXTS.map((ext) => `${base}${ext}`),
    ...JS_EXTS.map((ext) => `${base}/index${ext}`),
    `${base}/index`,
  ];
  return candidates.find((candidate) => repo.fileByPath.has(candidate)) || null;
}

function buildJavaIndex(repo, byFile) {
  const fqcnToFile = new Map();
  const packageToModules = new Map();
  for (const file of repo.files) {
    if (!['.java', '.kt'].includes(file.ext)) continue;
    if (file.kind !== 'source') continue;
    const text = repo.read(file.path);
    if (!text) continue;
    const pkgMatch = text.match(/^\s*package\s+([\w.]+)\s*;?/m);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    const className = file.name.replace(/\.(java|kt)$/, '');
    const fqcn = pkg ? `${pkg}.${className}` : className;
    fqcnToFile.set(fqcn, file.path);
    if (pkg) {
      if (!packageToModules.has(pkg)) packageToModules.set(pkg, new Set());
      packageToModules.get(pkg).add(byFile.get(file.path));
    }
  }
  return { fqcnToFile, packageToModules };
}

function resolveJavaImport(importName, index) {
  const clean = importName.replace(/^static\s+/, '').replace(/;$/, '');
  if (clean.endsWith('.*')) {
    const pkg = clean.slice(0, -2);
    const modules = index.packageToModules.get(pkg);
    return modules ? [...modules][0] : null;
  }
  if (index.fqcnToFile.has(clean)) return index.fqcnToFile.get(clean);
  const parts = clean.split('.');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const candidate = parts.slice(0, i).join('.');
    if (index.fqcnToFile.has(candidate)) return index.fqcnToFile.get(candidate);
  }
  return null;
}

function buildPythonIndex(repo) {
  const dottedToFile = new Map();
  for (const file of repo.files) {
    if (file.lang !== 'python' || file.kind === 'test') continue;
    let rel = file.path;
    for (const marker of ['src/main/python/', 'src/', 'python/', 'app/']) {
      const at = rel.indexOf(marker);
      if (at !== -1) {
        rel = rel.slice(at + marker.length);
        break;
      }
    }
    rel = rel.replace(/\.py$/, '');
    rel = rel.replace(/\/__init__$/, '');
    dottedToFile.set(rel.replace(/\//g, '.'), file.path);
  }
  return dottedToFile;
}

function parsePythonImports(text) {
  const found = [];
  const fromRe = /^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
  let match;
  while ((match = fromRe.exec(text))) found.push({ from: match[1], names: match[2] });
  const importRe = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
  while ((match = importRe.exec(text))) {
    for (const name of match[1].split(',').map((part) => part.trim())) found.push({ from: name, names: null });
  }
  return found;
}

function parseGoImports(text) {
  const imports = [];
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  let match;
  while ((match = blockRe.exec(text))) {
    for (const line of match[1].split('\n')) {
      const quoted = line.match(/"([^"]+)"/);
      if (quoted) imports.push(quoted[1]);
    }
  }
  const singleRe = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm;
  while ((match = singleRe.exec(text))) imports.push(match[1]);
  return imports;
}

function resolveImportPath(repo, spec) {
  // Best-effort lookup of an import path as a repository directory package.
  const clean = spec.replace(/^\.\//, '');
  const direct = repo.files.find(
    (file) => file.path === clean || file.path.startsWith(`${clean}/`) || file.path.endsWith(`/${clean}`),
  );
  return direct ? direct.path : null;
}

/**
 * Build a file/module import graph used by complexity scoring and the
 * architecture diagram. Language coverage: JS/TS, Java/Kotlin, Python, Go.
 */
export function buildGraph(repo, modulesInfo) {
  const { modules, byFile } = modulesInfo;
  const workspacePackages = new Map();
  for (const module of modules) {
    if (module.packageName) workspacePackages.set(module.packageName, module.id);
  }
  const javaIndex = buildJavaIndex(repo, byFile);
  const pythonIndex = buildPythonIndex(repo);
  const fileEdgeSet = new Set();
  const moduleEdges = new Map();
  const externalByModule = new Map();
  let externalSpecs = 0;
  let unresolved = 0;

  const recordExternal = (moduleId, spec) => {
    const pkg = packageOfSpecifier(spec);
    if (!pkg) return;
    externalSpecs += 1;
    if (!externalByModule.has(moduleId)) externalByModule.set(moduleId, new Map());
    const bucket = externalByModule.get(moduleId);
    bucket.set(pkg, (bucket.get(pkg) || 0) + 1);
  };

  const link = (fromFile, toFile) => {
    if (!toFile || toFile === fromFile) return;
    const fromModule = byFile.get(fromFile);
    const toModule = byFile.get(toFile);
    if (!fromModule || !toModule) return;
    const key = `${fromFile}\u0000${toFile}`;
    if (!fileEdgeSet.has(key)) fileEdgeSet.add(key);
    if (fromModule === toModule) return;
    const moduleKey = `${fromModule}\u0000${toModule}`;
    moduleEdges.set(moduleKey, (moduleEdges.get(moduleKey) || 0) + 1);
  };

  for (const file of repo.files) {
    if (file.kind !== 'source' && file.kind !== 'test') continue;
    const moduleId = byFile.get(file.path);
    if (!moduleId) continue;
    const text = repo.read(file.path);
    if (!text) continue;

    if (['javascript', 'typescript', 'vue', 'svelte'].includes(file.lang)) {
      for (const spec of parseJsImports(text)) {
        const resolved = resolveJsFile(repo, file.path, spec);
        if (resolved) {
          link(file.path, resolved);
          continue;
        }
        if (spec.startsWith('.')) {
          unresolved += 1;
          continue;
        }
        const workspace = workspacePackages.get(spec) || workspacePackages.get(packageOfSpecifier(spec));
        if (workspace) {
          // Cross-package import inside the monorepo: link first entry file if known.
          const entry = repo.files.find(
            (candidate) => candidate.kind === 'source' && (byFile.get(candidate.path) === workspace),
          );
          if (entry) link(file.path, entry.path);
          else if (workspace !== moduleId) {
            const moduleKey = `${moduleId}\u0000${workspace}`;
            moduleEdges.set(moduleKey, (moduleEdges.get(moduleKey) || 0) + 1);
          }
          continue;
        }
        recordExternal(moduleId, spec);
      }
      continue;
    }

    if (['java', 'kotlin'].includes(file.lang)) {
      const importRe = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;?/gm;
      let match;
      while ((match = importRe.exec(text))) {
        const resolved = resolveJavaImport(match[2], javaIndex);
        if (resolved) link(file.path, resolved);
        else if (!match[2].startsWith('java.') && !match[2].startsWith('javax.') && !match[2].startsWith('kotlin.') && !match[2].startsWith('jakarta.')) {
          unresolved += 1;
        }
      }
      continue;
    }

    if (file.lang === 'python') {
      for (const item of parsePythonImports(text)) {
        let target = null;
        if (item.from.startsWith('.')) {
          const dots = item.from.match(/^\.+/)[0].length;
          const rest = item.from.slice(dots).replace(/\./g, '/');
          const baseDir = path.posix.dirname(file.path);
          target = resolveImportPath(repo, path.posix.join(baseDir, rest));
        } else {
          target = pythonIndex.get(item.from) || pythonIndex.get(item.from.replace(/\./g, '/'));
        }
        if (target) link(file.path, target);
        else if (!item.from.startsWith('.')) recordExternal(moduleId, item.from);
      }
      continue;
    }

    if (file.lang === 'go') {
      for (const spec of parseGoImports(text)) {
        const target = resolveImportPath(repo, spec);
        if (target) link(file.path, target);
        else recordExternal(moduleId, spec);
      }
    }
  }

  const fileEdges = [...fileEdgeSet].map((key) => {
    const [from, to] = key.split('\u0000');
    return { from, to };
  });
  const edges = [...moduleEdges.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, count };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const external = {};
  for (const [moduleId, bucket] of externalByModule) {
    external[moduleId] = [...bucket.entries()]
      .map(([pkg, count]) => ({ pkg, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 60);
  }

  return {
    fileEdges,
    moduleEdges: edges,
    externalByModule: external,
    stats: {
      files: repo.files.filter((file) => file.kind === 'source' || file.kind === 'test').length,
      internalFileEdges: fileEdges.length,
      moduleEdges: edges.length,
      externalSpecs,
      unresolved,
    },
  };
}
