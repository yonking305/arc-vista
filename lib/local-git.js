/** Local-directory Git metadata. ArcVista never clones or checks out a project. */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);
const TIMEOUT = Number(process.env.ARCVISTA_GIT_TIMEOUT_MS || 20000);
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oConnectTimeout=15',
  SSH_ASKPASS_REQUIRE: 'never',
  GCM_INTERACTIVE: 'never',
  ...(process.platform === 'win32'
    ? {}
    : { GIT_ASKPASS: process.env.GIT_ASKPASS || '/usr/bin/false' }),
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

/** Turn Git's noisy stderr into an actionable message instead of a hang/opaque exit. */
export function classifyCloneFailure(stderr, url = '') {
  const text = String(stderr || '').toLowerCase();
  const suffix = url ? `（${redactGitUrl(url)}）` : '';
  if (/permission denied \(publickey\)|authentication failed|terminal prompts disabled|could not read from remote repository|could not read username|access denied|invalid username or password|not authorized|401 unauthorized|403 forbidden/i.test(text)) {
    return new Error(
      `Git 认证/权限失败${suffix}。请检查 SSH Key、Git 用户名密码或仓库访问权限；插件不会等待交互式登录。`,
    );
  }
  if (/repository .* not found|repository not found|does not appear to be a git repository/i.test(text)) {
    return new Error(`Git 仓库不存在或无权访问${suffix}。请检查地址和权限。`);
  }
  if (/host key verification failed|authenticity of host/i.test(text)) {
    return new Error(`SSH 主机密钥校验失败${suffix}。请先在终端确认该主机的 SSH 指纹。`);
  }
  if (/could not resolve host|name or service not known|network is unreachable|connection timed out|operation timed out|connection reset|failed to connect|connection refused/i.test(text)) {
    return new Error(`无法连接 Git 服务${suffix}。请检查网络、代理或 Git 地址。`);
  }
  if (/no such file or directory|not found/i.test(text)) {
    return new Error(`Git 仓库不存在${suffix}。`);
  }
  return new Error(`git clone 失败${suffix}：${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`);
}

function redactGitUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    return parsed.toString();
  } catch {
    return String(url || '').replace(/(\/\/)[^/@]+@/, '$1***@');
  }
}

/** Clone one remote into a workspace. Uses spawn (no shell) and reports progress. */
export async function cloneInto({ url, target, log = () => {}, progress = () => {} }) {
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

  log(`克隆 ${redactGitUrl(repoUrl)} → ${destination}`);
  progress(4, '开始克隆仓库');
  const timeoutMs = Number(process.env.ARCVISTA_GIT_CLONE_TIMEOUT_MS || 15 * 60 * 1000);
  const idleMs = Number(process.env.ARCVISTA_GIT_IDLE_TIMEOUT_MS || 120000);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', '--origin', 'origin', '--', repoUrl, destination], {
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    let lastMilestone = -1;
    let settled = false;
    let lastActivity = Date.now();
    const cleanup = () => {
      try {
        fs.rmSync(destination, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      if (error) {
        cleanup();
        reject(error);
      } else {
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      killTree();
      finish(new Error(`克隆超时（${Math.round(timeoutMs / 60000)} 分钟），已中止。请检查网络和仓库大小。`));
    }, timeoutMs);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < idleMs) return;
      killTree();
      finish(
        new Error(
          `Git 克隆 ${Math.round(idleMs / 1000)} 秒无响应，已中止。请检查网络、SSH Key、凭据或仓库权限。`,
        ),
      );
    }, Math.min(5000, Math.max(1000, idleMs / 4)));

    child.stdout.on('data', () => {
      lastActivity = Date.now();
    });
    child.stderr.on('data', (chunk) => {
      lastActivity = Date.now();
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
      else finish(classifyCloneFailure(stderr, repoUrl));
    });
  });
}
