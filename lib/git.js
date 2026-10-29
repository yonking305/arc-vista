import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
  LC_ALL: 'C',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envInt(name, fallback, min = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.round(value) : fallback;
}

/** Git reliability knobs. Clone/fetch timeouts are generous and retried with resume. */
export function gitRuntimeConfig() {
  return {
    retryAttempts: envInt('ARCVISTA_GIT_RETRIES', 4),
    retryDelayMs: envInt('ARCVISTA_GIT_RETRY_DELAY_MS', 2000, 100),
    cloneTimeoutMs: envInt('ARCVISTA_GIT_CLONE_TIMEOUT_MS', 900000, 5000),
    fetchTimeoutMs: envInt('ARCVISTA_GIT_FETCH_TIMEOUT_MS', 300000, 5000),
    worktreeTimeoutMs: envInt('ARCVISTA_GIT_WORKTREE_TIMEOUT_MS', 300000, 5000),
    localTimeoutMs: envInt('ARCVISTA_GIT_TIMEOUT_MS', 120000, 1000),
  };
}

function runGit(args, { timeout = 120000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { env: GIT_ENV, timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim();
        const err = new Error(detail || 'git 命令执行失败');
        err.gitArgs = args;
        err.timedOut = error.killed || error.signal === 'SIGTERM';
        reject(err);
        return;
      }
      resolve(String(stdout));
    });
  });
}

const GIT_PHASE_LABELS = {
  'Receiving objects': '接收对象',
  'Resolving deltas': '解析增量',
  'Counting objects': '计数对象',
  'Compressing objects': '压缩对象',
  'Enumerating objects': '枚举对象',
  'Updating files': '更新文件',
};

/** Parse the last `Receiving objects: 42% (…), 12.3 MiB | 1.2 MiB/s` style line. */
function parseGitProgress(text) {
  const clean = String(text || '').replace(/\r/g, '\n');
  const re = /(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Enumerating objects|Updating files)[:\s]+(\d+)%/g;
  let match;
  let last = null;
  while ((match = re.exec(clean))) {
    const lineStart = clean.lastIndexOf('\n', match.index) + 1;
    const lineEnd = clean.indexOf('\n', match.index);
    const line = clean.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    last = { phase: match[1], percent: Number(match[2]), line };
  }
  if (!last) return null;
  const bytes = last.line.match(/([\d.]+\s*(?:KiB|MiB|GiB|B))\s*\|\s*([\d.]+\s*(?:KiB|MiB|GiB|B)\/s)/i);
  return {
    phase: last.phase,
    percent: Math.max(0, Math.min(100, last.percent)),
    size: bytes?.[1] || '',
    speed: bytes?.[2] || '',
    text: last.line.trim(),
  };
}

/**
 * Like runGit(), but streams git's stderr so clone/fetch progress can be shown
 * to the user instead of a frozen "拉取中" for half an hour.
 */
function runGitStream(args, { timeout = 120000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: GIT_ENV });
    let stdout = '';
    let stderr = '';
    let carry = '';
    let settled = false;
    let timedOut = false;
    let lastEmitAt = 0;
    let lastPercent = -1;

    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
        }, timeout)
      : null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-120000);
      const progress = parseGitProgress(carry + text);
      carry = text.slice(-4000);
      if (!progress) return;
      const now = Date.now();
      if (progress.percent !== lastPercent && now - lastEmitAt > 700) {
        lastPercent = progress.percent;
        lastEmitAt = now;
        onProgress?.(progress);
      }
    });
    child.on('error', (error) => {
      const wrapped = new Error(error.message);
      wrapped.gitArgs = args;
      wrapped.timedOut = timedOut;
      finish(wrapped);
    });
    child.on('close', (code) => {
      if (timedOut) {
        const error = new Error('操作超时');
        error.gitArgs = args;
        error.timedOut = true;
        finish(error);
        return;
      }
      if (code === 0) {
        onProgress?.({ phase: 'done', percent: 100, size: '', speed: '', text: '' });
        finish(null);
        return;
      }
      const error = new Error(stderr.trim() || `git 命令执行失败（exit ${code}）`);
      error.gitArgs = args;
      finish(error);
    });
  });
}

/**
 * Network hiccups, GitHub 5xx and timeouts are worth another attempt.
 * Auth/permission/not-a-repo errors are not.
 */
export function isRetryableGitError(error) {
  if (!error) return false;
  if (error.timedOut) return true;
  const text = String(error.message || '');
  if (/Authentication failed|Permission denied|publickey|terminal prompts disabled|does not appear to be a git repository|Repository .* not found|repository .* not found/i.test(text)) {
    return false;
  }
  return /timed out|timeout|Operation timed out|Could not resolve host|could not resolve host|Failed to connect|Connection (reset|refused|timed out)|unexpected disconnect|remote end hung up|early EOF|RPC failed|TLS|SSL|HTTP 5\d\d|The requested URL returned error: 5|index-pack failed|fetch-pack|unable to access|temporary failure|Could not read from remote repository/i.test(text);
}

function gitErrorReason(error) {
  if (error?.timedOut) return '操作超时';
  const text = String(error?.message || '');
  if (/Could not resolve host|could not resolve host/i.test(text)) return '无法解析域名';
  if (/Failed to connect|Connection refused/i.test(text)) return '连接被拒绝';
  if (/Connection reset|remote end hung up|unexpected disconnect|early EOF/i.test(text)) return '连接中断';
  if (/HTTP 5\d\d|The requested URL returned error: 5/i.test(text)) return '远端服务异常';
  if (/timed out|timeout/i.test(text)) return '操作超时';
  return '网络错误';
}

function friendlyGitError(error, repoUrl) {
  const text = String(error.message || '');
  if (/could not resolve host|Could not resolve host|unable to access/i.test(text)) {
    return `无法访问仓库地址（网络或域名问题）：${repoUrl}`;
  }
  if (/Authentication failed|Permission denied|publickey|terminal prompts disabled/i.test(text)) {
    return `仓库认证失败，请确认地址可访问或本机已配置凭据：${repoUrl}`;
  }
  if (/not a git repository|does not appear to be a git repository/i.test(text)) {
    return `地址不是有效的 Git 仓库：${repoUrl}`;
  }
  if (/repository .* not found|not found/i.test(text) && /github|gitlab|gitee/i.test(text)) {
    return `仓库不存在或无权访问：${repoUrl}`;
  }
  if (error.timedOut) return `Git 操作超时：${repoUrl}`;
  return text.split('\n').slice(0, 4).join(' ').slice(0, 400) || 'Git 操作失败';
}

export function classifyRepoUrl(repoUrl) {
  if (!repoUrl) return 'unknown';
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(repoUrl) && !repoUrl.startsWith('file://')) {
    if (/^https?:\/\//.test(repoUrl)) return 'http';
    if (/^ssh:\/\//.test(repoUrl)) return 'ssh';
    return 'url';
  }
  return 'local';
}

/** Remove stale lock files left behind by a killed git process so resume can work. */
async function removeLockFiles(gitDir) {
  const targets = [
    'index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock',
    'FETCH_HEAD.lock', 'ORIG_HEAD.lock', 'gc.pid', 'gc.log',
  ].map((name) => path.join(gitDir, name));
  await Promise.all(targets.map((target) => fsp.rm(target, { force: true }).catch(() => {})));
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'objects') continue;
        await walk(target, depth + 1);
      } else if (entry.name.endsWith('.lock')) {
        await fsp.rm(target, { force: true }).catch(() => {});
      }
    }
  }
  await walk(path.join(gitDir, 'refs'), 0);
}

function mirrorHeadState(mirror) {
  let content = '';
  try {
    content = fs.readFileSync(path.join(mirror, 'HEAD'), 'utf8').trim();
  } catch {
    return 'missing';
  }
  if (/^ref:\s*refs\/heads\/(?!\.invalid)/.test(content)) return 'valid';
  if (/^[0-9a-f]{40}$/.test(content)) return 'valid';
  return 'partial';
}

function isPartialMirror(mirror) {
  return fs.existsSync(path.join(mirror, 'config')) && mirrorHeadState(mirror) !== 'valid';
}

export class GitStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.reposDir = path.join(dataDir, 'repos');
    this.worktreesDir = path.join(dataDir, 'worktrees');
    this.config = { ...gitRuntimeConfig(), ...options };
    this.run = options.run || runGit;
    this.runStream = options.runStream || (options.run ? options.run : runGitStream);
    fs.mkdirSync(this.reposDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
  }

  mirrorPath(productId) {
    return path.join(this.reposDir, `${productId}.git`);
  }

  worktreePath(productId, sha) {
    return path.join(this.worktreesDir, productId, sha);
  }

  hasUsableMirror(productId) {
    const mirror = this.mirrorPath(productId);
    return fs.existsSync(path.join(mirror, 'config')) && mirrorHeadState(mirror) === 'valid';
  }

  /**
   * Clone or update the bare mirror. Clone/fetch failures caused by timeouts or
   * network errors are retried; an interrupted clone is resumed with `fetch`.
   */
  async ensureMirror(product, onLog = () => {}, onProgress = () => {}) {
    const mirror = this.mirrorPath(product.id);
    const cloneUrl = product.mirrorUrl || product.repoUrl;
    const { retryAttempts, retryDelayMs, cloneTimeoutMs, fetchTimeoutMs } = this.config;
    let lastMilestone = -1;
    let maxProgress = 0;
    const reportProgress = (info) => {
      if (!info || !Number.isFinite(info.percent)) return;
      const phase = info.phase || '';
      let normalized;
      if (phase === 'done') normalized = 100;
      else if (/Resolving|Updating|Checking/.test(phase)) normalized = 92 + info.percent * 0.07;
      else normalized = info.percent * 0.92;
      normalized = Math.min(100, Math.max(maxProgress, normalized));
      maxProgress = normalized;
      const label = GIT_PHASE_LABELS[phase] || (phase === 'done' ? '完成' : phase);
      const detail = `${label} ${info.percent}%${info.size ? ` · ${info.size}` : ''}${info.speed ? ` · ${info.speed}` : ''}`;
      onProgress({ ...info, percent: Math.round(normalized), detail });
      const milestone = Math.floor(info.percent / 25) * 25;
      if (info.percent >= 25 && info.percent < 100 && milestone > lastMilestone) {
        lastMilestone = milestone;
        onLog(detail);
      }
    };
    fs.mkdirSync(path.dirname(mirror), { recursive: true });

    const hasRepo = fs.existsSync(path.join(mirror, 'config'));
    const headState = mirrorHeadState(mirror);
    const hadMirror = hasRepo && headState === 'valid';
    let resumable = hasRepo && !hadMirror;
    if (fs.existsSync(mirror) && !hasRepo) {
      await fsp.rm(mirror, { recursive: true, force: true });
      resumable = false;
    }

    if (hadMirror) onLog('拉取远端最新提交');
    else if (resumable) onLog('检测到上次未完成的克隆，尝试断点续传', 'warn');
    else if (cloneUrl !== product.repoUrl) onLog(`克隆仓库（镜像）${cloneUrl}（仓库较大时需要几分钟；超时会自动断点续传）`);
    else onLog(`克隆仓库 ${product.repoUrl}（完整镜像，仓库较大时需要几分钟；超时会自动断点续传）`);

    let initialized = hadMirror || resumable;
    let needHeadFix = resumable;
    let lastError = null;
    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      if (!initialized && isPartialMirror(mirror)) {
        initialized = true;
        needHeadFix = true;
        onLog('检测到上次中断的仓库数据，改为断点续传', 'warn');
      }
      try {
        if (!initialized) {
          await this.runStream(['clone', '--mirror', '--progress', cloneUrl, mirror], {
            timeout: cloneTimeoutMs,
            onProgress: reportProgress,
          });
          initialized = true;
          needHeadFix = false;
        } else {
          await this.runStream([`--git-dir=${mirror}`, 'fetch', '--prune', '--progress', 'origin'], {
            timeout: fetchTimeoutMs,
            onProgress: reportProgress,
          });
          if (needHeadFix) {
            const branches = await this.listBranches(product.id).catch(() => []);
            if (branches.length === 0) throw new Error('断点续传后没有获取到任何分支');
            const preferred = branches.find((branch) => branch.name === product.defaultBranch) || branches[0];
            await this.run([`--git-dir=${mirror}`, 'symbolic-ref', 'HEAD', `refs/heads/${preferred.name}`], { timeout: 15000 });
            needHeadFix = false;
            onLog(`续传完成，默认分支 ${preferred.name}`);
          }
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await removeLockFiles(mirror);
        if (!initialized && isPartialMirror(mirror)) {
          initialized = true;
          needHeadFix = true;
        }
        // A clone interrupted before its remote was configured cannot be resumed with fetch.
        let resetMirror = false;
        if (!hadMirror && initialized && /No such remote|not a git repository|does not appear to be a git repository|No such file or directory/i.test(error.message || '')) {
          await fsp.rm(mirror, { recursive: true, force: true }).catch(() => {});
          initialized = false;
          needHeadFix = false;
          resetMirror = true;
        }
        const canRetry = (isRetryableGitError(error) || resetMirror) && attempt < retryAttempts;
        if (!canRetry) break;
        const delay = retryDelayMs * attempt;
        const action = hadMirror ? '远端拉取' : initialized ? '克隆中断' : '克隆失败';
        onLog(
          `${action}（${gitErrorReason(error)}），${(delay / 1000).toFixed(1)}s 后自动重试（第 ${attempt + 1}/${retryAttempts} 次）`,
          'warn',
        );
        await sleep(delay);
        onLog(
          hadMirror
            ? `重试拉取（第 ${attempt + 1}/${retryAttempts} 次）`
            : initialized
              ? `断点续传镜像（第 ${attempt + 1}/${retryAttempts} 次）`
              : `重试克隆（第 ${attempt + 1}/${retryAttempts} 次）`,
        );
      }
    }

    if (lastError) {
      if (hadMirror) {
        onLog(`远端拉取失败，使用本地缓存继续：${friendlyGitError(lastError, product.repoUrl)}`, 'warn');
      } else {
        throw new Error(`${friendlyGitError(lastError, product.repoUrl)}（已自动尝试 ${retryAttempts} 次，网络恢复后可点「重试分析」继续断点续传）`);
      }
    }

    const defaultBranch = await this.defaultBranch(product.id, product.defaultBranch);
    return { mirror, defaultBranch };
  }

  async defaultBranch(productId, fallback = 'main') {
    const mirror = this.mirrorPath(productId);
    try {
      const head = (await this.run([`--git-dir=${mirror}`, 'symbolic-ref', '--short', 'HEAD'], { timeout: 15000 })).trim();
      if (head) return head;
    } catch {
      /* fall through */
    }
    try {
      const branches = await this.listBranches(productId);
      return branches[0]?.name || fallback;
    } catch {
      return fallback;
    }
  }

  async listBranches(productId) {
    const mirror = this.mirrorPath(productId);
    const format = '%(refname:short)%00%(objectname:short)%00%(committerdate:iso-strict)%00%(contents:subject)';
    const out = await this.run(
      [`--git-dir=${mirror}`, 'for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads'],
      { timeout: 30000 },
    );
    const branches = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [name, short, date, subject] = line.split('\u0000');
      if (!name) continue;
      branches.push({ name, short, date, subject: (subject || '').slice(0, 200) });
    }
    return branches.slice(0, 300);
  }

  async resolveRef(productId, ref) {
    const mirror = this.mirrorPath(productId);
    const candidates = [];
    const clean = String(ref || '').trim();
    if (!clean) throw new Error('未指定分支或提交');
    candidates.push(`refs/heads/${clean}`, clean, `refs/tags/${clean}`, `refs/remotes/origin/${clean}`);
    for (const candidate of candidates) {
      try {
        const sha = (
          await this.run([`--git-dir=${mirror}`, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
            timeout: 15000,
          })
        ).trim();
        if (sha) return sha;
      } catch {
        /* try next */
      }
    }
    throw new Error(`找不到分支或提交：${clean}`);
  }

  async commitInfo(productId, sha) {
    const mirror = this.mirrorPath(productId);
    const out = await this.run([`--git-dir=${mirror}`, 'show', '-s', '--format=%H%x00%h%x00%s%x00%an%x00%aI', sha], {
      timeout: 20000,
    });
    const [full, short, subject, author, date] = out.trim().split('\u0000');
    return { sha: full, short, subject: subject || '', author: author || '', date: date || '' };
  }

  async ensureWorktree(productId, sha, onLog = () => {}) {
    const target = this.worktreePath(productId, sha);
    const mirror = this.mirrorPath(productId);
    if (fs.existsSync(path.join(target, '.git'))) {
      try {
        const head = (await this.run(['-C', target, 'rev-parse', 'HEAD'], { timeout: 15000 })).trim();
        if (head === sha) return target;
      } catch {
        /* recreate */
      }
    }
    await fsp.rm(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    onLog(`检出代码 ${sha.slice(0, 8)}`);

    const { retryAttempts, retryDelayMs, worktreeTimeoutMs } = this.config;
    let lastError = null;
    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      try {
        await this.run(['--git-dir=' + mirror, 'worktree', 'add', '--detach', '--force', target, sha], {
          timeout: worktreeTimeoutMs,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        if (!isRetryableGitError(error) || attempt >= retryAttempts) break;
        const delay = retryDelayMs * attempt;
        onLog(`检出代码超时，${(delay / 1000).toFixed(1)}s 后自动重试（第 ${attempt + 1}/${retryAttempts} 次）`, 'warn');
        await sleep(delay);
      }
    }
    if (lastError) {
      throw new Error(`检出分支失败：${friendlyGitError(lastError, mirror)}`);
    }
    return target;
  }

  async pruneWorktrees(productId, keepShas = []) {
    const dir = path.join(this.worktreesDir, productId);
    if (!fs.existsSync(dir)) return;
    const keep = new Set(keepShas);
    const entries = await fsp.readdir(dir);
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      const target = path.join(dir, entry);
      try {
        await this.run([`--git-dir=${this.mirrorPath(productId)}`, 'worktree', 'remove', '--force', target], {
          timeout: 30000,
        });
      } catch {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
    try {
      await this.run([`--git-dir=${this.mirrorPath(productId)}`, 'worktree', 'prune'], { timeout: 20000 });
    } catch {
      /* ignore */
    }
  }

  /** Commits touching each file over the recent window, used for complexity churn. */
  async fileChurn(productId, sha, { days = 180, maxCommits = 400 } = {}) {
    const mirror = this.mirrorPath(productId);
    try {
      const out = await this.run(
        [
          `--git-dir=${mirror}`,
          'log',
          `--since=${days} days ago`,
          '--no-merges',
          `-n ${maxCommits}`,
          '--format=commit:%H',
          '--name-only',
          sha,
          '--',
        ],
        { timeout: 45000, maxBuffer: 48 * 1024 * 1024 },
      );
      const fileCommits = new Map();
      let commits = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('commit:')) {
          commits += 1;
          continue;
        }
        const file = line.trim();
        if (!file) continue;
        fileCommits.set(file, (fileCommits.get(file) || 0) + 1);
      }
      return { commits, fileCommits };
    } catch {
      return { commits: 0, fileCommits: new Map() };
    }
  }

  async removeProduct(productId) {
    await fsp.rm(path.join(this.worktreesDir, productId), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(this.mirrorPath(productId), { recursive: true, force: true }).catch(() => {});
  }

  async diskUsage(productId) {
    const dirs = [this.mirrorPath(productId), path.join(this.worktreesDir, productId)];
    let bytes = 0;
    async function sizeOf(target) {
      let stat;
      try {
        stat = await fsp.stat(target);
      } catch {
        return;
      }
      if (stat.isFile()) {
        bytes += stat.size;
        return;
      }
      const entries = await fsp.readdir(target).catch(() => []);
      await Promise.all(entries.map((entry) => sizeOf(path.join(target, entry))));
    }
    for (const dir of dirs) await sizeOf(dir);
    return bytes;
  }
}
