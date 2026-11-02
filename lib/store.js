/**
 * JSON storage for ArcVista.
 *
 * Global plugin state (project list, jobs, settings) lives in the plugin data
 * directory. Analysis artifacts live next to the analysed project so a project
 * remains portable:
 *
 *   <dataDir>/projects.json
 *   <dataDir>/jobs.json
 *   <dataDir>/settings.json
 *   <dataDir>/backups/arcvista-*.json
 *
 *   <project>/.arcvista/project.json
 *   <project>/.arcvista/snapshots/index.json
 *   <project>/.arcvista/snapshots/<snapshotId>.json
 *   <project>/.arcvista/drill/<snapshotId>/<hash>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STORE_VERSION = 1;
const DEFAULT_BACKUP_KEEP = 12;

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export const SETTING_DEFAULTS = {
  llm_enabled: 'auto',
  llm_temperature: '0.2',
};

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let writeCounter = 0;

/** Atomic JSON write: same-directory temp file + rename, mode 0600. */
function writeJson(file, value) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${writeCounter++}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
}

export function artifactDir(projectPath) {
  return path.join(path.resolve(projectPath), '.arcvista');
}

function snapshotsDir(projectPath) {
  return path.join(artifactDir(projectPath), 'snapshots');
}

function snapshotIndexFile(projectPath) {
  return path.join(snapshotsDir(projectPath), 'index.json');
}

function drillDir(projectPath) {
  return path.join(artifactDir(projectPath), 'drill');
}

function drillFile(projectPath, snapshotId, modulePath) {
  const hash = crypto.createHash('sha1').update(String(modulePath)).digest('hex').slice(0, 20);
  return path.join(drillDir(projectPath), snapshotId, `${hash}.json`);
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupFiles(backupDir) {
  let names = [];
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^arcvista-[\w-]+\.json$/.test(name))
    .map((name) => {
      const file = path.join(backupDir, name);
      try {
        const stat = fs.statSync(file);
        return { name, file, size: stat.size, mtimeMs: stat.mtimeMs, at: new Date(stat.mtimeMs).toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function normalizePath(value) {
  return String(value || '').trim();
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null;
  const projectPath = normalizePath(project.path || project.repoUrl);
  if (!projectPath) return null;
  const timestamp = project.createdAt || nowIso();
  return {
    id: project.id || newId('prj'),
    name: String(project.name || path.basename(projectPath)).slice(0, 120),
    description: String(project.description || '').slice(0, 500),
    path: projectPath,
    repoUrl: projectPath,
    mirrorUrl: null,
    defaultBranch: String(project.defaultBranch || ''),
    createdAt: timestamp,
    updatedAt: project.updatedAt || timestamp,
  };
}

export function openStore(dataDir, options = {}) {
  const root = path.resolve(dataDir);
  ensureDir(root);
  const backupDir = path.resolve(
    options.backupDir || process.env.ARCVISTA_BACKUP_DIR || path.join(root, 'backups'),
  );
  ensureDir(backupDir);
  const backupKeep = Number(options.backupKeep || process.env.ARCVISTA_BACKUP_KEEP || DEFAULT_BACKUP_KEEP);

  const projectsFile = path.join(root, 'projects.json');
  const jobsFile = path.join(root, 'jobs.json');
  const settingsFile = path.join(root, 'settings.json');

  const projectState = readJson(projectsFile, { version: STORE_VERSION, projects: [] });
  let projects = Array.isArray(projectState.projects)
    ? projectState.projects.map(normalizeProject).filter(Boolean)
    : [];
  const jobState = readJson(jobsFile, { version: STORE_VERSION, jobs: [] });
  let jobs = Array.isArray(jobState.jobs) ? jobState.jobs : [];
  const settingsState = readJson(settingsFile, { version: STORE_VERSION, values: {} });
  let settingValues = settingsState.values && typeof settingsState.values === 'object' ? settingsState.values : {};

  // Snapshot location cache: snapshotId -> { productPath, file }.
  const snapshotLocations = new Map();

  function saveProjects() {
    writeJson(projectsFile, { version: STORE_VERSION, projects });
  }

  function saveJobs() {
    writeJson(jobsFile, { version: STORE_VERSION, jobs });
  }

  function saveSettings() {
    writeJson(settingsFile, { version: STORE_VERSION, values: settingValues });
  }

  function projectById(id) {
    return projects.find((item) => item.id === id) || null;
  }

  function readSnapshotIndex(project) {
    const data = readJson(snapshotIndexFile(project.path), {
      version: STORE_VERSION,
      snapshots: [],
    });
    return Array.isArray(data.snapshots) ? data.snapshots : [];
  }

  function writeSnapshotIndex(project, index) {
    ensureDir(snapshotsDir(project.path));
    writeJson(snapshotIndexFile(project.path), { version: STORE_VERSION, snapshots: index });
  }

  function refreshSnapshotLocations() {
    snapshotLocations.clear();
    for (const project of projects) {
      for (const entry of readSnapshotIndex(project)) {
        if (!entry?.id) continue;
        snapshotLocations.set(entry.id, {
          productPath: project.path,
          file: path.join(snapshotsDir(project.path), `${entry.id}.json`),
        });
      }
    }
  }

  function ensureSnapshotLocation(snapshotId) {
    const cached = snapshotLocations.get(snapshotId);
    if (cached && fs.existsSync(cached.file)) return cached;
    for (const project of projects) {
      const file = path.join(snapshotsDir(project.path), `${snapshotId}.json`);
      if (fs.existsSync(file)) {
        const location = { productPath: project.path, file };
        snapshotLocations.set(snapshotId, location);
        return location;
      }
    }
    return null;
  }

  function snapshotFromFile(file, withAnalysis = true) {
    const snapshot = readJson(file, null);
    if (!snapshot) return null;
    if (!withAnalysis) delete snapshot.analysis;
    return snapshot;
  }

  const products = {
    list() {
      return [...projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    get(id) {
      return projectById(id);
    },
    findByName(name) {
      return projects.find((item) => item.name === name) || null;
    },
    findByPath(projectPath) {
      return projects.find((item) => item.path === projectPath) || null;
    },
    create(input) {
      const projectPath = path.resolve(String(input.path || input.repoUrl || ''));
      const timestamp = nowIso();
      const project = {
        id: newId('prj'),
        name: String(input.name || path.basename(projectPath)).slice(0, 120),
        description: String(input.description || '').slice(0, 500),
        path: projectPath,
        repoUrl: projectPath,
        mirrorUrl: null,
        defaultBranch: String(input.defaultBranch || ''),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      projects.push(project);
      saveProjects();
      ensureDir(artifactDir(projectPath));
      writeJson(path.join(artifactDir(projectPath), 'project.json'), {
        version: STORE_VERSION,
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
      });
      refreshSnapshotLocations();
      return project;
    },
    update(id, patch) {
      const project = projectById(id);
      if (!project) return null;
      if (patch.name !== undefined) project.name = String(patch.name).slice(0, 120);
      if (patch.description !== undefined) project.description = String(patch.description).slice(0, 500);
      if (patch.defaultBranch !== undefined) project.defaultBranch = String(patch.defaultBranch || '');
      if (patch.path !== undefined) {
        const nextPath = path.resolve(String(patch.path));
        project.path = nextPath;
        ensureDir(artifactDir(nextPath));
      }
      project.updatedAt = nowIso();
      saveProjects();
      refreshSnapshotLocations();
      return project;
    },
    touch(id) {
      const project = projectById(id);
      if (!project) return null;
      project.updatedAt = nowIso();
      saveProjects();
      return project;
    },
    remove(id) {
      const index = projects.findIndex((item) => item.id === id);
      if (index < 0) return false;
      projects.splice(index, 1);
      saveProjects();
      refreshSnapshotLocations();
      return true;
    },
    count() {
      return projects.length;
    },
  };

  const snapshots = {
    insert(input) {
      const project = projectById(input.productId);
      if (!project) throw new Error(`项目不存在：${input.productId}`);
      ensureDir(snapshotsDir(project.path));
      const id = input.id || newId('snap');
      const record = {
        version: STORE_VERSION,
        id,
        productId: input.productId,
        branch: input.branch || '',
        commit: input.commit || { sha: '', short: '', subject: '', author: '', date: '' },
        analyzedAt: input.analyzedAt || nowIso(),
        engine: input.engine || 'heuristic',
        durationMs: Number(input.durationMs) || 0,
        summary: input.summary || {},
        analysis: input.analysis || {},
      };
      const file = path.join(snapshotsDir(project.path), `${id}.json`);
      writeJson(file, record);
      const index = readSnapshotIndex(project).filter((entry) => entry.id !== id);
      index.unshift({
        id,
        productId: record.productId,
        branch: record.branch,
        commitSha: record.commit.sha,
        commitShort: record.commit.short,
        commitSubject: record.commit.subject,
        commitAuthor: record.commit.author,
        commitDate: record.commit.date,
        analyzedAt: record.analyzedAt,
        engine: record.engine,
        durationMs: record.durationMs,
        summary: record.summary,
      });
      writeSnapshotIndex(project, index);
      snapshotLocations.set(id, { productPath: project.path, file });
      return id;
    },
    get(id) {
      const location = ensureSnapshotLocation(id);
      if (!location) return null;
      return snapshotFromFile(location.file);
    },
    findByCommit(productId, sha) {
      const project = projectById(productId);
      if (!project) return null;
      const entry = readSnapshotIndex(project).find((item) => item.commitSha === sha);
      return entry ? snapshots.get(entry.id) : null;
    },
    listByProduct(productId) {
      const project = projectById(productId);
      if (!project) return [];
      return readSnapshotIndex(project)
        .slice()
        .sort((a, b) => String(b.analyzedAt).localeCompare(String(a.analyzedAt)))
        .map((entry) => ({
          id: entry.id,
          productId,
          branch: entry.branch,
          commitSha: entry.commitSha,
          commitShort: entry.commitShort,
          commitSubject: entry.commitSubject,
          commitAuthor: entry.commitAuthor,
          commitDate: entry.commitDate,
          analyzedAt: entry.analyzedAt,
          engine: entry.engine,
          durationMs: entry.durationMs,
          summary: entry.summary || {},
          commit: {
            sha: entry.commitSha,
            short: entry.commitShort,
            subject: entry.commitSubject,
            author: entry.commitAuthor,
            date: entry.commitDate,
          },
        }));
    },
    latestByBranch(productId, branch) {
      const project = projectById(productId);
      if (!project) return null;
      const entry = readSnapshotIndex(project)
        .filter((item) => item.branch === branch)
        .sort((a, b) => String(b.analyzedAt).localeCompare(String(a.analyzedAt)))[0];
      return entry ? snapshots.get(entry.id) : null;
    },
    latest(productId) {
      const project = projectById(productId);
      if (!project) return null;
      const entry = readSnapshotIndex(project).sort((a, b) =>
        String(b.analyzedAt).localeCompare(String(a.analyzedAt)),
      )[0];
      return entry ? snapshots.get(entry.id) : null;
    },
    count(productId) {
      const project = projectById(productId);
      if (!project) return 0;
      return readSnapshotIndex(project).length;
    },
    removeByProduct(productId) {
      const project = projectById(productId);
      if (!project) return;
      const dir = snapshotsDir(project.path);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      for (const [id, location] of snapshotLocations) {
        if (location.productPath === project.path) snapshotLocations.delete(id);
      }
    },
  };

  const settings = {
    all() {
      return { ...SETTING_DEFAULTS, ...settingValues };
    },
    get(key) {
      return settingValues[key] ?? SETTING_DEFAULTS[key] ?? null;
    },
    set(key, value) {
      settingValues[key] = String(value);
      saveSettings();
    },
    setMany(patch) {
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined) continue;
        settingValues[key] = String(value);
      }
      saveSettings();
    },
  };

  const jobsApi = {
    upsert(job) {
      const index = jobs.findIndex((item) => item.id === job.id);
      const record = {
        id: job.id,
        productId: job.productId || null,
        kind: job.kind,
        branch: job.branch || null,
        status: job.status,
        progress: job.progress || 0,
        message: job.message || '',
        logs: Array.isArray(job.logs) ? job.logs : [],
        error: job.error || null,
        result: job.result ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
      if (index >= 0) jobs[index] = record;
      else jobs.push(record);
      if (jobs.length > 500) jobs = jobs.slice(-500);
      saveJobs();
    },
    get(id) {
      return jobs.find((item) => item.id === id) || null;
    },
    listByProduct(productId, limit = 30) {
      return jobs
        .filter((item) => item.productId === productId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },
    latestByProduct(productId) {
      return jobsApi.listByProduct(productId, 1)[0] || null;
    },
    activeByProduct(productId) {
      return jobs
        .filter((item) => item.productId === productId && ['queued', 'running'].includes(item.status))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    interruptActive(message = '服务重启，任务已中断，请重新发起') {
      let changed = 0;
      for (const job of jobs) {
        if (!['queued', 'running'].includes(job.status)) continue;
        job.status = 'error';
        job.error = message;
        job.message = message;
        job.updatedAt = nowIso();
        changed += 1;
      }
      if (changed) saveJobs();
      return changed;
    },
  };

  const drill = {
    get(snapshotId, modulePath) {
      const location = ensureSnapshotLocation(snapshotId);
      if (!location) return null;
      const file = drillFile(location.productPath, snapshotId, modulePath);
      const record = readJson(file, null);
      if (!record) return null;
      return { ...(record.analysis || {}), createdAt: record.createdAt };
    },
    put(input) {
      const location = ensureSnapshotLocation(input.snapshotId);
      if (!location) throw new Error(`快照不存在：${input.snapshotId}`);
      const file = drillFile(location.productPath, input.snapshotId, input.modulePath);
      ensureDir(path.dirname(file));
      writeJson(file, {
        version: STORE_VERSION,
        productId: input.productId,
        snapshotId: input.snapshotId,
        modulePath: input.modulePath,
        analysis: input.analysis || {},
        createdAt: nowIso(),
      });
    },
    removeByProduct(productId) {
      const project = projectById(productId);
      if (!project) return;
      try {
        fs.rmSync(drillDir(project.path), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };

  const backups = {
    dir: backupDir,
    restoredFrom: null,
    info() {
      const files = backupFiles(backupDir);
      return {
        dir: backupDir,
        count: files.length,
        latest: files[0] ? { file: files[0].file, at: files[0].at, size: files[0].size } : null,
        restoredFrom: null,
      };
    },
    list() {
      return backupFiles(backupDir).map(({ name, at, size }) => ({ name, at, size }));
    },
    create(reason = 'manual') {
      const file = path.join(backupDir, `arcvista-${stamp()}-${reason}.json`);
      writeJson(file, {
        version: STORE_VERSION,
        createdAt: nowIso(),
        reason,
        projects,
        jobs,
        settings: settingValues,
      });
      const files = backupFiles(backupDir);
      for (const old of files.slice(Math.max(0, backupKeep))) {
        try {
          fs.rmSync(old.file, { force: true });
        } catch {
          /* ignore */
        }
      }
      const stat = fs.statSync(file);
      return { file, at: new Date(stat.mtimeMs).toISOString(), size: stat.size };
    },
    maybeCreate(reason = 'auto', minIntervalMs = 120000) {
      const latest = backupFiles(backupDir)[0];
      if (latest && Date.now() - latest.mtimeMs < minIntervalMs) return null;
      return backups.create(reason);
    },
  };

  refreshSnapshotLocations();

  return {
    version: STORE_VERSION,
    dataDir: root,
    file: projectsFile,
    projects,
    products,
    snapshots,
    settings,
    jobs: jobsApi,
    drill,
    backups,
    close() {},
  };
}
