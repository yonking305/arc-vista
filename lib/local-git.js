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
