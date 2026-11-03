#!/usr/bin/env node
/**
 * 构建 ArcVista 内网离线安装包。
 *
 *   node scripts/build-intranet-package.mjs
 *
 * 产物（工作空间根目录，与本仓库同级）：
 *   arc-vista-intranet-installer/       可直接拷进内网的安装目录
 *   arc-vista-intranet-installer.zip    分发包
 *
 * 流程：npm pack（prepack 会校验包内容）→ 解包成 payload → 复制 packaging/intranet
 * 模板并替换版本 / 校验和占位符 → 生成 zip。全程不访问网络（npm pack 只读本地文件）。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..');
const TEMPLATE_DIR = path.join(ROOT, 'packaging', 'intranet');
const OUT_DIR = path.join(WORKSPACE, 'arc-vista-intranet-installer');
const ZIP_PATH = path.join(WORKSPACE, 'arc-vista-intranet-installer.zip');
const BUILD_DIR = path.join(WORKSPACE, '.arcvista-intranet-build');
const SCREENSHOT = path.join(ROOT, 'docs', 'screenshots', 'dsh-plugin.png');

const log = (text) => console.log(`[build] ${text}`);
const fail = (text) => {
  console.error(`[build] 失败：${text}`);
  process.exit(1);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} 退出码 ${result.status}\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

/** 把目录内所有文件/目录的修改时间统一为固定时间，保证 zip 产物可复现。 */
function normalizeMtimes(dir, epochSeconds) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) normalizeMtimes(target, epochSeconds);
    fs.utimesSync(target, epochSeconds, epochSeconds);
  }
  fs.utimesSync(dir, epochSeconds, epochSeconds);
}

/** 可复现构建时间基准：SOURCE_DATE_EPOCH > 源码提交时间 > 当前时间。 */
function sourceEpoch() {
  const fromEnv = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const git = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%ct'], { encoding: 'utf8' });
  const seconds = Number((git.stdout || '').trim());
  if (git.status === 0 && Number.isFinite(seconds) && seconds > 0) return seconds;
  return Math.floor(Date.now() / 1000);
}

/** 源码提交日期（YYYY-MM-DD），让安装包内 DATE 随提交固定，从而使安装包可复现。 */
function sourceDateText() {
  const git = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%cs'], { encoding: 'utf8' });
  const value = (git.stdout || '').trim();
  if (git.status === 0 && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const now = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count += 1;
  }
  return count;
}

function replaceTokens(text, tokens) {
  return text.replace(/\{\{(VERSION|DATE|SHA256|TGZ_SIZE)\}\}/g, (match, key) => {
    if (!(key in tokens)) fail(`模板占位符 {{${key}}} 没有对应值`);
    return String(tokens[key]);
  });
}

function assertInside(target, parent, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} 路径越界：${target}`);
  }
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-arcvista') fail(`包名应为 dsh-arcvista，实际为 ${manifest.name}`);
  if (manifest.private === true) fail('package.json 的 private 必须为 false');
  const version = manifest.version;
  log(`打包 dsh-arcvista@${version}`);

  if (!fs.existsSync(TEMPLATE_DIR)) fail(`缺少模板目录：${TEMPLATE_DIR}`);
  assertInside(OUT_DIR, WORKSPACE, '输出目录');
  assertInside(ZIP_PATH, WORKSPACE, 'zip 路径');

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const cacheDir = path.join(BUILD_DIR, 'npm-cache');
  const logDir = path.join(BUILD_DIR, 'npm-logs');
  const packDir = path.join(BUILD_DIR, 'pack');
  fs.mkdirSync(packDir, { recursive: true });

  // 1. npm pack：prepack 会跑 scripts/check-package.mjs，确保包自洽、无数据目录。
  log('npm pack ...');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', packDir, '--cache', cacheDir, '--logs-dir', logDir], {
    cwd: ROOT,
    shell: process.platform === 'win32',
  });
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) fail(`pack 目录应只有 1 个 tarball，实际：${tarballs.join(', ') || '无'}`);
  const tarballName = tarballs[0];
  const tarball = path.join(packDir, tarballName);
  if (tarballName !== `dsh-arcvista-${version}.tgz`) fail(`tarball 名称异常：${tarballName}`);
  const checksum = sha256(tarball);
  const tarballBytes = fs.statSync(tarball).size;
  log(`tarball ${tarballName}（${(tarballBytes / 1024).toFixed(1)} KB，sha256 ${checksum.slice(0, 16)}...）`);

  // 2. 解包并检查内容
  const extractDir = path.join(BUILD_DIR, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extractDir], { shell: process.platform === 'win32' });
  const packedDir = path.join(extractDir, 'package');
  if (!fs.existsSync(path.join(packedDir, 'package.json'))) fail('解包后缺少 package/package.json');
  const packedManifest = JSON.parse(fs.readFileSync(path.join(packedDir, 'package.json'), 'utf8'));
  if (packedManifest.version !== version) fail(`解包版本 ${packedManifest.version} 与 ${version} 不一致`);
  for (const required of ['index.js', 'client.js', 'server.js', 'cordis.patch.yml', 'public/index.html', 'lib/http.js', 'lib/store.js', 'lib/local-git.js', 'lib/analyze/index.js']) {
    if (!fs.existsSync(path.join(packedDir, required))) fail(`tarball 缺少 ${required}（files 白名单可能配置有误）`);
  }
  for (const forbidden of ['data', 'backups', 'logs', 'node_modules']) {
    if (fs.existsSync(path.join(packedDir, forbidden))) fail(`tarball 不应包含 ${forbidden}/`);
  }
  log(`解包 ${countFiles(packedDir)} 个文件，内容检查通过`);

  // 3. 组装输出目录
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'payload'), { recursive: true });
  fs.copyFileSync(tarball, path.join(OUT_DIR, 'payload', tarballName));
  copyDir(packedDir, path.join(OUT_DIR, 'payload', 'dsh-arcvista'));
  log(`payload 写入完成：${path.relative(WORKSPACE, OUT_DIR)}/payload`);

  const tokens = {
    VERSION: version,
    DATE: sourceDateText(),
    SHA256: checksum,
    TGZ_SIZE: tarballBytes,
  };
  const textFiles = ['install.mjs', 'install.sh', 'install.command', 'install.bat', 'install.ps1', 'README.md', 'START-HERE.txt', 'manifest.json'];
  for (const name of textFiles) {
    const source = path.join(TEMPLATE_DIR, name);
    if (!fs.existsSync(source)) fail(`缺少模板文件：packaging/intranet/${name}`);
    const text = replaceTokens(fs.readFileSync(source, 'utf8'), tokens);
    fs.writeFileSync(path.join(OUT_DIR, name), text);
    if (name === 'manifest.json') {
      const parsed = JSON.parse(text);
      if (parsed.version !== version || parsed.sha256 !== checksum) fail('生成的 manifest.json 校验信息不正确');
    }
    if (name === 'install.mjs') {
      const usageVersion = text.includes('{{') ? fail('install.mjs 中仍残留未替换的占位符') : undefined;
      void usageVersion;
    }
  }
  for (const executable of ['install.sh', 'install.command']) {
    fs.chmodSync(path.join(OUT_DIR, executable), 0o755);
  }
  if (fs.existsSync(SCREENSHOT)) {
    fs.mkdirSync(path.join(OUT_DIR, 'docs'), { recursive: true });
    fs.copyFileSync(SCREENSHOT, path.join(OUT_DIR, 'docs', 'dsh-plugin.png'));
  } else {
    log('提示：未找到 docs/screenshots/dsh-plugin.png，README 截图将缺失');
  }

  // 4. 输出目录自检
  for (const required of ['install.mjs', 'install.bat', 'install.ps1', 'install.sh', 'install.command', 'README.md', 'START-HERE.txt', 'manifest.json', 'payload/dsh-arcvista/package.json']) {
    if (!fs.existsSync(path.join(OUT_DIR, required))) fail(`输出目录缺少 ${required}`);
  }
  if (sha256(path.join(OUT_DIR, 'payload', tarballName)) !== checksum) fail('输出目录中的 tarball 校验和不一致');

  // 5. 生成 zip
  normalizeMtimes(OUT_DIR, sourceEpoch());
  fs.rmSync(ZIP_PATH, { force: true });
  log('生成 zip ...');
  const zipped = spawnSync('zip', ['-r', '-X', '-q', path.basename(ZIP_PATH), path.basename(OUT_DIR)], {
    cwd: WORKSPACE,
    encoding: 'utf8',
  });
  if (zipped.error || zipped.status !== 0) {
    log('zip 不可用，改用 tar 生成 zip 包');
    run('tar', ['-a', '-c', '-f', ZIP_PATH, '-C', WORKSPACE, path.basename(OUT_DIR)], { shell: process.platform === 'win32' });
  }
  const zipBytes = fs.statSync(ZIP_PATH).size;

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  console.log('');
  log(`完成：${path.relative(WORKSPACE, OUT_DIR)}（${countFiles(OUT_DIR)} 个文件）`);
  log(`分发包：${path.relative(WORKSPACE, ZIP_PATH)}（${(zipBytes / 1024 / 1024).toFixed(2)} MB）`);
  log(`插件版本：${version}`);
  log(`tarball SHA-256：${checksum}`);
  log(`安装校验：node ${path.relative(WORKSPACE, path.join(OUT_DIR, 'install.mjs'))} --dry-run`);
}

main();
