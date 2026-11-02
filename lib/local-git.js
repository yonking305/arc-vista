/** Local-directory Git metadata. ArcVista never clones or checks out a project. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);
const TIMEOUT = Number(process.env.ARCVISTA_GIT_TIMEOUT_MS || 20000);
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

async function git(projectPath, args, options = {}) {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], {
    env: ENV,
    timeout: options.timeout || TIMEOUT,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  });
  return String(stdout || '').trim();
}

export function localCommit(projectPath) {
  const sha = `local-${crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 12)}`;
  return {
    sha,
    short: 'local',
    subject: '本地工作区',
    author: '',
    date: new Date().toISOString(),
  };
}

export async function isGitRepository(projectPath) {
  try {
    return (await git(projectPath, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export async function inspectProject(projectPath) {
  try {
    const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') throw new Error('not a work tree');
    let branch = '';
    try {
      branch = await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    } catch {
      branch = (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).trim();
    }
    const format = '%H%x00%h%x00%s%x00%an%x00%aI';
    const text = await git(projectPath, ['show', '-s', `--format=${format}`, 'HEAD']);
    const [sha, short, subject, author, date] = text.split('\u0000');
    const status = await git(projectPath, ['status', '--porcelain', '--untracked-files=normal']);
    return {
      isGit: true,
      branch: branch || 'HEAD',
      commit: { sha, short, subject: subject || '', author: author || '', date: date || '' },
      dirty: status.length > 0,
      status,
    };
  } catch {
    return {
      isGit: false,
      branch: '工作区',
      commit: localCommit(projectPath),
      dirty: true,
      status: '',
    };
  }
}

/** The local workflow analyses exactly one checked-out state. */
export async function listBranches(projectPath) {
  const info = await inspectProject(projectPath);
  return [
    {
      name: info.branch,
      short: info.commit.short,
      date: info.commit.date,
      subject: info.commit.subject,
      current: true,
      isGit: info.isGit,
    },
  ];
}

export async function fileChurn(projectPath, sha, { days = 180, maxCommits = 400 } = {}) {
  try {
    if (!sha || String(sha).startsWith('local-')) return { commits: 0, fileCommits: new Map() };
    const out = await git(
      projectPath,
      [
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

/** Derive a safe directory name from a Git URL. */
export function repoDirectoryName(url) {
  const clean = String(url || '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const tail = clean.split(/[\\/:]/).filter(Boolean).pop() || '';
  const name = tail.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return name || 'git-project';
}

/** Clone one remote into a workspace. Uses spawn (no shell) and reports progress. */
export async function cloneInto({ url, target, log = () => {}, progress = () => {} }) {
  const fs = await import('node:fs');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');

  const repoUrl = String(url || '').trim();
  const destination = path.resolve(String(target || ''));
  if (!repoUrl) throw new Error('Git 地址不能为空');
  if (!destination) throw new Error('克隆目标目录不能为空');
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const entries = await fsp.readdir(destination).catch(() => []);
    if (entries.length > 0) throw new Error(`目标目录已存在且非空：${destination}`);
  } else {
    await fsp.mkdir(destination, { recursive: true });
  }

  log(`克隆 ${repoUrl} → ${destination}`);
  progress(4, '开始克隆仓库');
  const timeoutMs = Number(process.env.ARCVISTA_GIT_CLONE_TIMEOUT_MS || 15 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', '--origin', 'origin', '--', repoUrl, destination], {
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let lastMilestone = -1;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`克隆超时（${Math.round(timeoutMs / 60000)} 分钟）`));
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const match = /(?:Receiving objects|Resolving deltas):\s+(\d+)%/.exec(line);
        if (match) {
          const pct = Number(match[1]);
          const milestone = Math.floor(pct / 20) * 20;
          if (milestone > lastMilestone) {
            lastMilestone = milestone;
            progress(5 + Math.round(pct * 0.55), `克隆仓库 ${pct}%`);
            log(`克隆仓库 ${pct}%`);
          }
        } else if (line.trim() && !/^remote:|^Cloning into|^Receiving objects|^Resolving deltas|^Updating files/.test(line.trim())) {
          log(line.trim().slice(0, 300));
        }
      }
    });
    child.on('error', (error) => finish(new Error(`无法启动 git clone：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null, destination);
      else finish(new Error(`git clone 失败（退出码 ${code}）：${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`));
    });
  });
}
