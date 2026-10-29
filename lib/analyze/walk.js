import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Directories that never carry product source and would drown the scan. */
export const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache',
  '.m2repo', '.m2', '.gradle', '.idea', '.vscode', 'vendor', 'Pods',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.tox', '.eggs',
  '.pnpm-store', '.yarn', '.cache', '.tmp', 'tmp', '.DS_Store', 'coverage-report',
]);

/** Dot directories worth keeping for architecture / security evidence. */
const KEPT_DOT_DIRS = new Set(['.github', '.gitlab', '.circleci', '.buildkite', '.semgrep']);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip', '.gz',
  '.tgz', '.7z', '.rar', '.jar', '.war', '.class', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.webm', '.psd', '.sketch',
  '.fig', '.lockb', '.db', '.sqlite', '.sqlite3', '.bin', '.wasm',
]);

export const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.vue': 'vue', '.svelte': 'svelte',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.cs': 'csharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.swift': 'swift', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.sql': 'sql', '.sh': 'shell', '.bash': 'shell', '.ps1': 'powershell',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.yml': 'yaml', '.yaml': 'yaml', '.json': 'json', '.xml': 'xml',
  '.toml': 'toml', '.ini': 'ini', '.properties': 'properties', '.md': 'markdown',
  '.txt': 'text', '.rst': 'rst', '.adoc': 'asciidoc', '.env': 'dotenv',
};

const CONFIG_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'requirements.txt', 'pipfile',
  'pyproject.toml', 'poetry.lock', 'composer.json', 'composer.lock', 'gemfile',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
  '.editorconfig', '.env', '.env.example', '.gitignore', '.gitattributes',
  'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.js',
  'jest.config.js', 'vitest.config.ts', 'pytest.ini', 'tox.ini', 'setup.py', 'setup.cfg',
  'application.yml', 'application.yaml', 'application.properties', 'bootstrap.yml',
  'nginx.conf', 'traefik.yml', 'manifest.json', 'renovate.json',
]);

const DOC_EXTS = new Set(['.md', '.markdown', '.rst', '.adoc', '.txt']);
const DOC_DIR_NAMES = new Set(['docs', 'doc', 'documentation', 'wiki']);

/** Languages whose LOC counts as product source code. */
export const SOURCE_LANGS = new Set([
  'javascript', 'typescript', 'vue', 'svelte', 'java', 'kotlin', 'scala', 'groovy',
  'python', 'go', 'rust', 'ruby', 'php', 'csharp', 'c', 'cpp', 'swift', 'dart',
  'elixir', 'html', 'css', 'scss', 'less', 'sql', 'shell', 'powershell',
]);

/** Languages that describe configuration rather than product logic. */
export const CONFIG_LANGS = new Set([
  'yaml', 'json', 'xml', 'toml', 'ini', 'properties', 'dotenv', 'docker', 'make',
]);

const MANIFEST_KINDS = new Map([
  ['package.json', 'node'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'],
  ['build.gradle.kts', 'gradle'],
  ['go.mod', 'go'],
  ['cargo.toml', 'rust'],
  ['requirements.txt', 'python'],
  ['pyproject.toml', 'python'],
  ['setup.py', 'python'],
  ['composer.json', 'php'],
  ['gemfile', 'ruby'],
  ['pubspec.yaml', 'dart'],
]);

export function extOf(filePath) {
  const base = path.basename(filePath);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index).toLowerCase();
}

export function isTestPath(rel) {
  const lower = rel.toLowerCase();
  if (/(^|\/)(__tests__|tests?|spec|testcases?)\//.test(lower)) return true;
  if (/\.(test|spec|e2e|integration)\.[a-z0-9]+$/.test(lower)) return true;
  if (/(test|tests|it|spec)\.(java|kt|cs)$/.test(lower)) return true;
  if (/_test\.(py|go|rb)$/.test(lower)) return true;
  if (/(^|\/)src\/test\//.test(lower)) return true;
  if (/(^|\/)(checks?)\//.test(lower) && /\.(mjs|js|ts)$/.test(lower)) return true;
  return false;
}

export function isDocPath(rel) {
  if (DOC_EXTS.has(extOf(rel))) return true;
  return rel.split('/').some((part) => DOC_DIR_NAMES.has(part.toLowerCase()));
}

export function isConfigPath(rel) {
  const base = path.basename(rel).toLowerCase();
  if (CONFIG_FILES.has(base)) return true;
  if (base.startsWith('application-') && (base.endsWith('.yml') || base.endsWith('.yaml') || base.endsWith('.properties'))) return true;
  return false;
}

export function langOf(rel) {
  const base = path.basename(rel).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
  if (base === 'makefile') return 'make';
  if (base === 'jenkinsfile') return 'groovy';
  return LANG_BY_EXT[extOf(rel)] || null;
}

export function countLines(text) {
  if (!text) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  if (text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

function kindOf(rel) {
  const lang = langOf(rel);
  if (isTestPath(rel)) return 'test';
  if (isConfigPath(rel) || CONFIG_LANGS.has(lang)) return 'config';
  if (DOC_EXTS.has(extOf(rel))) return 'doc';
  if (SOURCE_LANGS.has(lang)) return 'source';
  if (lang) return 'config';
  return 'asset';
}

const READ_CACHE_MAX_CHARS = 96 * 1024 * 1024;

/**
 * Scan a repository working tree once; every analyzer reads through this object.
 * @param {string} root absolute path of the checked-out tree
 * @param {{maxFiles?: number, maxFileBytes?: number, readLimitBytes?: number}} [opts]
 */
export async function scanRepo(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? 20000;
  const listedMaxBytes = opts.maxFileBytes ?? 1_200_000;
  const readLimitBytes = opts.readLimitBytes ?? 700_000;
  const raw = [];
  let truncated = false;

  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !KEPT_DOT_DIRS.has(entry.name)) continue;
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (raw.length >= maxFiles) {
        truncated = true;
        continue;
      }
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > listedMaxBytes) continue;
      const ext = extOf(rel);
      if (BINARY_EXTS.has(ext)) continue;
      raw.push({ rel, abs, size: stat.size, ext });
    }
  }

  await walk(root, '');

  const contentCache = new Map();
  let cacheChars = 0;

  function read(rel) {
    if (contentCache.has(rel)) return contentCache.get(rel);
    const entry = fileByPath.get(rel);
    if (!entry || !entry.isText) return null;
    if (entry.size > readLimitBytes) return null;
    let text = null;
    try {
      const buffer = fs.readFileSync(entry.abs);
      if (buffer.subarray(0, 2048).includes(0)) return null;
      text = buffer.toString('utf8');
    } catch {
      return null;
    }
    if (cacheChars + text.length > READ_CACHE_MAX_CHARS) {
      contentCache.clear();
      cacheChars = 0;
    }
    contentCache.set(rel, text);
    cacheChars += text.length;
    return text;
  }

  const files = raw.map((item) => {
    const lang = langOf(item.rel);
    const kind = kindOf(item.rel);
    const isText = Boolean(lang) || isConfigPath(item.rel) || kind === 'doc' || kind === 'test';
    const file = {
      path: item.rel,
      abs: item.abs,
      name: path.basename(item.rel),
      dir: path.posix.dirname(item.rel) === '.' ? '' : path.posix.dirname(item.rel),
      ext: item.ext,
      lang,
      kind,
      size: item.size,
      isText,
      loc: 0,
      depth: item.rel.split('/').length,
    };
    return file;
  });

  const fileByPath = new Map(files.map((file) => [file.path, file]));

  const textFiles = files.filter((file) => file.isText && file.size <= readLimitBytes);
  let cursor = 0;
  async function readWorker() {
    while (cursor < textFiles.length) {
      const file = textFiles[cursor++];
      try {
        const buffer = await fsp.readFile(file.abs);
        if (buffer.subarray(0, 2048).includes(0)) {
          file.isText = false;
          continue;
        }
        const text = buffer.toString('utf8');
        file.loc = countLines(text);
        if (cacheChars + text.length <= READ_CACHE_MAX_CHARS) {
          contentCache.set(file.path, text);
          cacheChars += text.length;
        }
      } catch {
        file.isText = false;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(24, Math.max(1, textFiles.length)) }, readWorker));

  const languages = new Map();
  const totals = {
    files: files.length,
    textFiles: 0,
    sourceFiles: 0,
    testFiles: 0,
    docFiles: 0,
    configFiles: 0,
    loc: 0,
    sourceLoc: 0,
    testLoc: 0,
    docLoc: 0,
  };
  for (const file of files) {
    if (!file.isText) continue;
    totals.textFiles += 1;
    totals.loc += file.loc;
    if (file.kind === 'test') {
      totals.testFiles += 1;
      totals.testLoc += file.loc;
    } else if (file.kind === 'source') {
      totals.sourceFiles += 1;
      totals.sourceLoc += file.loc;
    } else if (file.kind === 'doc') {
      totals.docFiles += 1;
      totals.docLoc += file.loc;
    } else if (file.kind === 'config' || isConfigPath(file.path)) {
      totals.configFiles += 1;
    }
    if (file.lang) {
      const bucket = languages.get(file.lang) || { lang: file.lang, files: 0, loc: 0 };
      bucket.files += 1;
      bucket.loc += file.loc;
      languages.set(file.lang, bucket);
    }
  }

  const projects = [];
  for (const file of files) {
    const kind = MANIFEST_KINDS.get(file.name.toLowerCase());
    if (!kind) continue;
    if (file.path.includes('/node_modules/')) continue;
    projects.push({
      dir: file.dir,
      path: file.path,
      type: kind,
      manifest: file.name,
    });
  }
  // de-dup nested duplicate manifests, keep shallowest per kind/dir
  const seenProject = new Set();
  const uniqueProjects = projects
    .sort((a, b) => a.dir.split('/').length - b.dir.split('/').length)
    .filter((project) => {
      const key = `${project.dir}|${project.type}`;
      if (seenProject.has(key)) return false;
      seenProject.add(key);
      return true;
    });

  function grep(pattern, options = {}) {
    const {
      exts,
      pathIncludes,
      pathExcludes,
      maxMatches = 400,
      maxFiles = 6000,
      flags = '',
      kinds = ['source', 'config', 'test', 'doc'],
      filterFiles = null,
    } = options;
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, flags);
    const matches = [];
    let scanned = 0;
    for (const file of files) {
      if (scanned >= maxFiles) break;
      if (!kinds.includes(file.kind) && !isConfigPath(file.path)) continue;
      if (exts && !exts.includes(file.ext)) continue;
      if (pathIncludes && !file.path.includes(pathIncludes)) continue;
      if (pathExcludes && pathExcludes.some((part) => file.path.includes(part))) continue;
      if (filterFiles && !filterFiles(file)) continue;
      const text = read(file.path);
      if (!text) continue;
      scanned += 1;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const match = regex.exec(line);
        regex.lastIndex = 0;
        if (!match) continue;
        matches.push({
          path: file.path,
          line: i + 1,
          text: line.trim().slice(0, 240),
          match: match[0].slice(0, 240),
        });
        if (matches.length >= maxMatches) return matches;
      }
    }
    return matches;
  }

  function find(options = {}) {
    const { exts, includes, excludes = [], basename, kinds } = options;
    return files.filter((file) => {
      if (exts && !exts.includes(file.ext)) return false;
      if (basename && !basename.test(file.name)) return false;
      if (includes && !includes.some((part) => file.path.includes(part))) return false;
      if (excludes.some((part) => file.path.includes(part))) return false;
      if (kinds && !kinds.includes(file.kind)) return false;
      return true;
    });
  }

  function readJson(rel) {
    const text = read(rel);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  return {
    root,
    files,
    fileByPath,
    projects: uniqueProjects,
    languages: [...languages.values()].sort((a, b) => b.loc - a.loc),
    totals,
    truncated,
    read,
    readJson,
    grep,
    find,
    sourceFiles: () => files.filter((file) => file.kind === 'source'),
    testFiles: () => files.filter((file) => file.kind === 'test'),
    textFiles,
  };
}
