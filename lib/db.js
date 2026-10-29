import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_short TEXT NOT NULL DEFAULT '',
  commit_subject TEXT NOT NULL DEFAULT '',
  commit_author TEXT NOT NULL DEFAULT '',
  commit_date TEXT NOT NULL DEFAULT '',
  analyzed_at TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'heuristic',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}',
  analysis TEXT NOT NULL DEFAULT '{}',
  UNIQUE(product_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_product ON snapshots(product_id, analyzed_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  logs TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_product ON jobs(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drill_cache (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  module_path TEXT NOT NULL,
  analysis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(snapshot_id, module_path)
);
`;

export const SETTING_DEFAULTS = {
  llm_base_url: 'https://api.deepseek.com/v1',
  llm_api_key: '',
  llm_model: 'deepseek-chat',
  llm_enabled: 'auto',
  llm_temperature: '0.2',
};

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}


/* ------------------------------------------------------------------ */
/* Backups                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_BACKUP_KEEP = 12;

function backupDirFor(dataDir, options = {}) {
  if (options.backupDir) return path.resolve(options.backupDir);
  if (process.env.ARCVISTA_BACKUP_DIR) return path.resolve(process.env.ARCVISTA_BACKUP_DIR);
  // Sibling of the data directory: survives `rm -rf data`, stays portable with the project.
  return path.join(path.dirname(path.resolve(dataDir)), 'backups');
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function listBackupFiles(backupDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^arcvista-[\w-]+\.db$/.test(name))
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

function isUsableBackup(file) {
  let probe;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const table = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();
    if (!table) return false;
    const row = probe.prepare('SELECT COUNT(*) AS count FROM products').get();
    return Number(row?.count) > 0;
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

function latestUsableBackup(backupDir) {
  for (const entry of listBackupFiles(backupDir)) {
    if (isUsableBackup(entry.file)) return entry;
  }
  return null;
}

function pruneBackups(backupDir, keep = DEFAULT_BACKUP_KEEP) {
  const files = listBackupFiles(backupDir);
  for (const entry of files.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(entry.file, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    for (const name of fs.readdirSync(backupDir)) {
      if (!name.endsWith('.tmp')) continue;
      const file = path.join(backupDir, name);
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(file, { force: true });
    }
  } catch {
    /* ignore */
  }
}

function createDbBackup(db, backupDir, reason = 'manual', keep = DEFAULT_BACKUP_KEEP) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = backupStamp();
  const safeReason = String(reason).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'manual';
  let counter = 0;
  let file = path.join(backupDir, `arcvista-${stamp}-${safeReason}.db`);
  while (fs.existsSync(file)) {
    counter += 1;
    file = path.join(backupDir, `arcvista-${stamp}-${safeReason}-${counter}.db`);
  }
  const tmp = `${file}.tmp`;
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* best effort */
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
  pruneBackups(backupDir, keep);
  const stat = fs.statSync(file);
  return { file, at: new Date().toISOString(), size: stat.size };
}

function restoreBackupInto(file, dbFile) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${dbFile}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
  fs.copyFileSync(file, dbFile);
  try {
    fs.chmodSync(dbFile, 0o600);
  } catch {
    /* ignore */
  }
}

export function openDatabase(dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'arcvista.db');
  const backupDir = backupDirFor(dataDir, options);
  const backupKeep = Number(options.backupKeep || process.env.ARCVISTA_BACKUP_KEEP || DEFAULT_BACKUP_KEEP);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const autoRestore = options.autoRestore !== false && process.env.ARCVISTA_NO_AUTO_RESTORE !== '1';
  let restoredFrom = null;

  if (!fs.existsSync(file) && autoRestore) {
    const candidate = latestUsableBackup(backupDir);
    if (candidate) {
      restoreBackupInto(candidate.file, file);
      restoredFrom = candidate.file;
    }
  }

  let db;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    const candidate = autoRestore ? latestUsableBackup(backupDir) : null;
    if (!candidate) throw error;
    restoreBackupInto(candidate.file, file);
    restoredFrom = candidate.file;
    db = new DatabaseSync(file);
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Lightweight schema migrations for databases created by older versions.
  try {
    const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name);
    if (!jobColumns.includes('branch')) db.exec('ALTER TABLE jobs ADD COLUMN branch TEXT');
    const productColumns = db.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
    if (!productColumns.includes('mirror_url')) db.exec('ALTER TABLE products ADD COLUMN mirror_url TEXT');
  } catch {
    /* migration is best-effort; the app still works with the base schema */
  }

  const parseJson = (value, fallback) => {
    if (value === null || value === undefined) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  const products = {
    list() {
      return db.prepare('SELECT * FROM products ORDER BY updated_at DESC').all().map(mapProduct);
    },
    get(id) {
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      return row ? mapProduct(row) : null;
    },
    findByName(name) {
      const row = db.prepare('SELECT * FROM products WHERE name = ?').get(name);
      return row ? mapProduct(row) : null;
    },
    create(input) {
      const id = newId('prd');
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO products (id, name, description, repo_url, mirror_url, default_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.description || '',
        input.repoUrl,
        input.mirrorUrl || null,
        input.defaultBranch || 'main',
        timestamp,
        timestamp,
      );
      return products.get(id);
    },
    update(id, patch) {
      const current = products.get(id);
      if (!current) return null;
      db.prepare(
        `UPDATE products SET name = ?, description = ?, repo_url = ?, mirror_url = ?, default_branch = ?, updated_at = ? WHERE id = ?`,
      ).run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        patch.repoUrl ?? current.repoUrl,
        patch.mirrorUrl ?? current.mirrorUrl ?? null,
        patch.defaultBranch ?? current.defaultBranch,
        nowIso(),
        id,
      );
      return products.get(id);
    },
    touch(id) {
      db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    },
    remove(id) {
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    },
  };

  const snapshots = {
    insert(input) {
      const id = input.id || newId('snap');
      db.prepare(
        `INSERT OR REPLACE INTO snapshots
         (id, product_id, branch, commit_sha, commit_short, commit_subject, commit_author, commit_date,
          analyzed_at, engine, duration_ms, summary, analysis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.productId,
        input.branch,
        input.commit.sha,
        input.commit.short,
        input.commit.subject,
        input.commit.author,
        input.commit.date,
        input.analyzedAt,
        input.engine,
        input.durationMs || 0,
        JSON.stringify(input.summary || {}),
        JSON.stringify(input.analysis || {}),
      );
      return id;
    },
    get(id) {
      const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
      return row ? mapSnapshot(row, parseJson) : null;
    },
    findByCommit(productId, sha) {
      const row = db
        .prepare('SELECT * FROM snapshots WHERE product_id = ? AND commit_sha = ? ORDER BY analyzed_at DESC LIMIT 1')
        .get(productId, sha);
      return row ? mapSnapshot(row, parseJson) : null;
    },
    listByProduct(productId) {
      return db
        .prepare(
          `SELECT id, product_id, branch, commit_sha, commit_short, commit_subject, commit_date, analyzed_at,
                  engine, duration_ms, summary
           FROM snapshots WHERE product_id = ? ORDER BY analyzed_at DESC`,
        )
        .all(productId)
        .map((row) => mapSnapshot(row, parseJson, false));
    },
    latestByBranch(productId, branch) {
      const row = db
        .prepare(
          'SELECT * FROM snapshots WHERE product_id = ? AND branch = ? ORDER BY analyzed_at DESC LIMIT 1',
        )
        .get(productId, branch);
      return row ? mapSnapshot(row, parseJson) : null;
    },
    latest(productId) {
      const row = db
        .prepare('SELECT * FROM snapshots WHERE product_id = ? ORDER BY analyzed_at DESC LIMIT 1')
        .get(productId);
      return row ? mapSnapshot(row, parseJson) : null;
    },
    count(productId) {
      return db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE product_id = ?').get(productId).n;
    },
    removeByProduct(productId) {
      db.prepare('DELETE FROM snapshots WHERE product_id = ?').run(productId);
    },
  };

  const settings = {
    all() {
      const rows = db.prepare('SELECT * FROM settings').all();
      const map = { ...SETTING_DEFAULTS };
      for (const row of rows) map[row.key] = row.value;
      return map;
    },
    get(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : SETTING_DEFAULTS[key] ?? null;
    },
    set(key, value) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, String(value));
    },
    setMany(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        settings.set(key, value);
      }
    },
  };

  const jobs = {
    upsert(job) {
      db.prepare(
        `INSERT INTO jobs (id, product_id, kind, branch, status, progress, message, logs, error, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           branch = excluded.branch, status = excluded.status, progress = excluded.progress,
           message = excluded.message, logs = excluded.logs, error = excluded.error,
           result = excluded.result, updated_at = excluded.updated_at`,
      ).run(
        job.id,
        job.productId || null,
        job.kind,
        job.branch || null,
        job.status,
        job.progress || 0,
        job.message || '',
        JSON.stringify(job.logs || []),
        job.error || null,
        job.result ? JSON.stringify(job.result) : null,
        job.createdAt,
        job.updatedAt,
      );
    },
    get(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      return row ? mapJob(row, parseJson) : null;
    },
    listByProduct(productId, limit = 10) {
      return db
        .prepare('SELECT * FROM jobs WHERE product_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(productId, limit)
        .map((row) => mapJob(row, parseJson));
    },
    latestByProduct(productId) {
      const row = db
        .prepare('SELECT * FROM jobs WHERE product_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(productId);
      return row ? mapJob(row, parseJson) : null;
    },
    activeByProduct(productId) {
      return db
        .prepare(
          `SELECT id, product_id, kind, branch, status, progress, message, created_at, updated_at
           FROM jobs WHERE product_id = ? AND status IN ('queued', 'running')
           ORDER BY created_at ASC`,
        )
        .all(productId)
        .map(mapJobSlim);
    },
    interruptActive(message = '服务重启，任务已中断，请重新发起') {
      const result = db
        .prepare(
          `UPDATE jobs SET status = 'error', error = ?, message = ?, updated_at = ?
           WHERE status IN ('queued', 'running')`,
        )
        .run(message, message, nowIso());
      return Number(result.changes || 0);
    },
  };

  const drill = {
    get(snapshotId, modulePath) {
      const row = db
        .prepare('SELECT * FROM drill_cache WHERE snapshot_id = ? AND module_path = ?')
        .get(snapshotId, modulePath);
      if (!row) return null;
      return { ...parseJson(row.analysis, {}), createdAt: row.created_at };
    },
    put(input) {
      db.prepare('INSERT OR REPLACE INTO drill_cache (id, product_id, snapshot_id, module_path, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        newId('drill'),
        input.productId,
        input.snapshotId,
        input.modulePath,
        JSON.stringify(input.analysis),
        nowIso(),
      );
    },
    removeByProduct(productId) {
      db.prepare('DELETE FROM drill_cache WHERE product_id = ?').run(productId);
    },
  };

  const backups = {
    dir: backupDir,
    restoredFrom,
    info() {
      const files = listBackupFiles(backupDir);
      return {
        dir: backupDir,
        count: files.length,
        latest: files[0] ? { file: files[0].file, at: files[0].at, size: files[0].size } : null,
        restoredFrom,
      };
    },
    list() {
      return listBackupFiles(backupDir).map(({ name, at, size }) => ({ name, at, size }));
    },
    create(reason = 'manual') {
      return createDbBackup(db, backupDir, reason, backupKeep);
    },
    maybeCreate(reason = 'auto', minIntervalMs = 120000) {
      const latest = listBackupFiles(backupDir)[0];
      if (latest && Date.now() - latest.mtimeMs < minIntervalMs) return null;
      return createDbBackup(db, backupDir, reason, backupKeep);
    },
  };

  const store = { db, file, products, snapshots, settings, jobs, drill, backups, close: () => db.close() };

  // Keep a recent backup without slowing normal startup. Sales pitch: even if
  // ./data is removed, the latest good database can be restored automatically.
  if (products.count() > 0) {
    try {
      backups.maybeCreate('startup', 5 * 60 * 1000);
    } catch {
      /* a failed backup must never block the app */
    }
  }

  return store;
}

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repoUrl: row.repo_url,
    mirrorUrl: row.mirror_url || null,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSnapshot(row, parseJson, withAnalysis = true) {
  const snapshot = {
    id: row.id,
    productId: row.product_id,
    branch: row.branch,
    commitSha: row.commit_sha,
    commitShort: row.commit_short,
    commitSubject: row.commit_subject,
    commitAuthor: row.commit_author,
    commitDate: row.commit_date,
    analyzedAt: row.analyzed_at,
    engine: row.engine,
    durationMs: row.duration_ms,
    summary: parseJson(row.summary, {}),
  };
  snapshot.commit = {
    sha: row.commit_sha,
    short: row.commit_short,
    subject: row.commit_subject,
    author: row.commit_author,
    date: row.commit_date,
  };
  if (withAnalysis) snapshot.analysis = parseJson(row.analysis, {});
  return snapshot;
}

function mapJob(row, parseJson) {
  return {
    id: row.id,
    productId: row.product_id,
    kind: row.kind,
    branch: row.branch || null,
    status: row.status,
    progress: row.progress,
    message: row.message,
    logs: parseJson(row.logs, []),
    error: row.error,
    result: parseJson(row.result, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJobSlim(row) {
  return {
    id: row.id,
    productId: row.product_id,
    kind: row.kind,
    branch: row.branch || null,
    status: row.status,
    progress: row.progress,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
