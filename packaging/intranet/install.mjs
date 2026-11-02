#!/usr/bin/env node
/**
 * ArcVista 内网离线安装器。
 *
 * 把 dsh-arcvista 安装进本机 DSH profile：
 *   1. 复制插件到 <profile>/node_modules/dsh-arcvista；
 *   2. 把离线 tarball 存到 <profile>/.dsh-offline-plugins/，并在 profile 的
 *      package.json 里写成 file: 依赖（之后 pnpm 也能离线解析）；
 *   3. 在 dsh.profile.bundles 里注册插件；
 *   4. 用 dsh --dump-config 校验插件条目。
 *
 * 全程只做本地文件复制与注册，不访问网络、不执行远程脚本。
 * 详细说明见同目录 README.md。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = 'dsh-arcvista';
const ENTRY_ID = 'arcvista';
const STORE = '.dsh-offline-plugins';
const MIN_NODE = [22, 19];

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const cyan = (text) => paint('36', text);
const green = (text) => paint('32', text);
const yellow = (text) => paint('33', text);
const red = (text) => paint('31', text);
const dim = (text) => paint('2', text);

const show = {
  title: (text) => console.log(`\n${cyan(text)}`),
  step: (text) => console.log(`  ${text}`),
  ok: (text) => console.log(`  ${green('[OK]')} ${text}`),
  warn: (text) => console.log(`  ${yellow('[!]')} ${text}`),
  fail: (text) => console.log(`  ${red('[X]')} ${text}`),
  info: (text) => console.log(`  ${dim(text)}`),
};

const USAGE = `ArcVista 内网离线安装器（dsh-arcvista ${'{{VERSION}}'}）

用法：
  node install.mjs [选项]

选项：
  --dsh-home <目录>    DSH 数据目录（默认取 $DSH_HOME，否则 ~/.dsh）
  --profile <名称>     DSH profile 名称（默认取 $DSH_PROFILE，否则 web）
  --dry-run            只打印安装计划，不写任何文件
  --verify             只检查当前安装状态，不写任何文件
  --uninstall          卸载插件（保留数据与备份）
  --no-backup          覆盖旧版时不保留备份
  --no-verify          安装后不调用 dsh --dump-config 校验
  --dsh-bin <路径>     指定 dsh 命令或 bin.js 入口（找不到 dsh 时使用）
  --yes, -y            跳过交互确认
  -h, --help           显示本帮助

示例：
  node install.mjs --dry-run
  node install.mjs --profile web
  node install.mjs --dsh-home /data/dsh-home --profile web
  node install.mjs --uninstall

安装完成后重启 DSH Web，左侧栏会出现「ArcVista 观界」。
`;

class InstallError extends Error {}

function parseArgs(argv) {
  const opts = {
    dshHome: '',
    profile: process.env.DSH_PROFILE || 'web',
    dryRun: false,
    verifyOnly: false,
    uninstall: false,
    noBackup: false,
    noVerify: false,
    dshBin: '',
    yes: false,
    help: false,
  };
  const need = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new InstallError(`${name} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--dsh-home':
        opts.dshHome = need(index, arg);
        index += 1;
        break;
      case '--profile':
        opts.profile = need(index, arg);
        index += 1;
        break;
      case '--dsh-bin':
        opts.dshBin = need(index, arg);
        index += 1;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--verify':
        opts.verifyOnly = true;
        break;
      case '--uninstall':
        opts.uninstall = true;
        break;
      case '--no-backup':
        opts.noBackup = true;
        break;
      case '--no-verify':
        opts.noVerify = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new InstallError(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return opts;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = (major === 22 && minor >= MIN_NODE[1]) || major >= 24;
  if (!supported) {
    throw new InstallError(
      `当前 Node.js 版本为 ${process.versions.node}，ArcVista 要求 Node.js 22.19+ 或 24+（使用本地 JSON 存储）。\n` +
        '  DSH 自带满足要求的 Node，请用 DSH 自带的 node 运行本安装器，或先升级 Node.js。',
    );
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonPreservingMode(file, value) {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // 文件不存在时使用默认权限
  }
  const temp = `${file}.dsh-install-${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Windows 上 chmod 可能被忽略，不影响使用
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 备份目录名按秒生成；同一秒内重复操作时追加序号，避免 rename 冲突。 */
function uniqueDir(base) {
  let candidate = base;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* dsh 命令发现与调用                                                   */
/* ------------------------------------------------------------------ */

let dshCliCache;

function dshCandidates(opts) {
  const list = [];
  if (opts.dshBin) {
    const file = path.resolve(expandHome(opts.dshBin));
    if (!fs.existsSync(file)) throw new InstallError(`--dsh-bin 指向的文件不存在：${file}`);
    list.push(file.endsWith('.js') ? { kind: 'node', file, label: file } : { kind: 'exe', file, label: file });
  }
  // DSH 便携安装：node 与 node_modules 同级（如 Windows 安装包 app/node/node.exe）。
  const bundled = path.resolve(path.dirname(process.execPath), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(bundled)) list.push({ kind: 'node', file: bundled, label: bundled });
  // PATH 中的 dsh 命令。
  list.push({ kind: 'path', file: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', label: 'dsh' });
  return list;
}

function runDsh(cli, args, dshHome) {
  const env = { ...process.env, DSH_HOME: dshHome };
  const command = cli.kind === 'node' ? process.execPath : cli.file;
  const argv = cli.kind === 'node' ? [cli.file, ...args] : args;
  return spawnSync(command, argv, {
    encoding: 'utf8',
    env,
    timeout: 180000,
    windowsHide: true,
    shell: cli.kind === 'path' && process.platform === 'win32',
  });
}

/** 找到可用的 dsh 入口；找不到时返回 undefined（安装仍可继续，只跳过校验）。 */
function detectDsh(opts, dshHome) {
  if (dshCliCache !== undefined) return dshCliCache;
  for (const candidate of dshCandidates(opts)) {
    const result = runDsh(candidate, ['--version'], dshHome);
    if (!result.error && result.status === 0 && /\d+\.\d+\.\d+/.test(result.stdout || '')) {
      const version = (result.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/) || [])[0] || '';
      dshCliCache = { ...candidate, version };
      return dshCliCache;
    }
  }
  dshCliCache = null;
  return dshCliCache;
}

/* ------------------------------------------------------------------ */
/* payload 与 profile                                                   */
/* ------------------------------------------------------------------ */

function loadPayload(manifest) {
  const root = path.join(HERE, 'payload');
  const dir = path.join(root, PLUGIN);
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    throw new InstallError(`安装包不完整：缺少 payload/${PLUGIN}/package.json。请重新解压完整的安装包。`);
  }
  const pkg = readJson(pkgFile);
  if (pkg.name !== PLUGIN) throw new InstallError(`payload 包名异常：期望 ${PLUGIN}，实际 ${pkg.name}`);
  const version = pkg.version;
  const tarball = path.join(root, `${PLUGIN}-${version}.tgz`);
  if (!fs.existsSync(tarball)) {
    throw new InstallError(`安装包不完整：缺少 payload/${PLUGIN}-${version}.tgz。请重新解压完整的安装包。`);
  }
  const expected = manifest.sha256;
  if (expected) {
    const actual = sha256(tarball);
    if (actual !== expected) {
      throw new InstallError(
        `离线包校验失败：${path.basename(tarball)} 的 SHA-256 与 manifest.json 不一致。\n  期望：${expected}\n  实际：${actual}\n  文件可能在传输中损坏，请重新拷贝安装包。`,
      );
    }
  }
  for (const file of ['index.js', 'client.js', 'server.js', 'cordis.patch.yml', path.join('lib', 'http.js'), path.join('public', 'index.html')]) {
    if (!fs.existsSync(path.join(dir, file))) {
      throw new InstallError(`安装包不完整：payload/${PLUGIN}/${file} 缺失。请重新解压完整的安装包。`);
    }
  }
  return { root, dir, tarball, version };
}

function resolveDshHome(opts) {
  const value = opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.resolve(expandHome(value));
}

function readProfile(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgFile)) return undefined;
  const manifest = readJson(pkgFile);
  if (typeof manifest !== 'object' || manifest === null) throw new InstallError(`profile 的 package.json 不是有效对象：${pkgFile}`);
  manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {};
  manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {};
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = [];
  return { manifest, pkgFile };
}

/** profile 不存在时，调用 dsh 初始化（等价于第一次启动 DSH）。 */
function ensureProfile(opts, dshHome, profileDir, profile) {
  const current = readProfile(profileDir);
  if (current) return current;
  show.warn(`profile 不存在：${profileDir}`);
  const cli = detectDsh(opts, dshHome);
  if (!cli) {
    throw new InstallError(
      `找不到 dsh 命令，无法自动初始化 profile。\n` +
        `  请先启动一次 DSH（例如运行 dsh --profile ${profile}），或确认 DSH 已正确安装并在 PATH 中。\n` +
        `  也可以用 --dsh-home 指定已有 profile 所在的 DSH 数据目录。`,
    );
  }
  show.step(`使用 ${cli.label} 初始化 profile ...`);
  const result = runDsh(cli, ['--profile', profile, '--dump-config'], dshHome);
  if (result.error) throw new InstallError(`初始化 profile 失败：${result.error.message}`);
  const created = readProfile(profileDir);
  if (!created) {
    throw new InstallError(
      `初始化 profile 失败（${cli.label} 退出码 ${result.status}）。\n${(result.stderr || '').trim()}\n` +
        `  请手动运行一次 dsh --profile ${profile} 后重试。`,
    );
  }
  show.ok(`已创建 profile：${profileDir}`);
  return created;
}

/* ------------------------------------------------------------------ */
/* 安装 / 卸载 / 校验                                                   */
/* ------------------------------------------------------------------ */

function describePlan({ profileDir, profile, payload, spec }) {
  show.step(`DSH profile：${profileDir}${profile ? dim(` (${profile})`) : ''}`);
  show.step(`插件版本：${payload.version}`);
  show.step(`离线 tarball：${path.relative(HERE, payload.tarball)}（${formatBytes(fs.statSync(payload.tarball).size)}）`);
  show.step(`安装位置：${path.join(profileDir, 'node_modules', PLUGIN)}`);
  show.step(`profile 依赖：${PLUGIN} = ${spec}`);
  show.step(`bundle 注册：dsh.profile.bundles 追加 ${PLUGIN}`);
}

function install(opts, dshHome, profileDir, profile, payload, manifest) {
  const existing = readProfile(profileDir);
  const nodeModules = path.join(profileDir, 'node_modules');
  const target = path.join(nodeModules, PLUGIN);
  const storeDir = path.join(profileDir, STORE);
  const tarballName = `${PLUGIN}-${payload.version}.tgz`;
  const tarballInsideProfile = path.join(storeDir, tarballName);
  const spec = `file:${STORE}/${tarballName}`;
  const stamp = timestamp();
  const backupDir = uniqueDir(path.join(storeDir, 'backups', stamp));

  if (opts.dryRun) {
    show.title('安装计划（--dry-run，不会写入任何文件）');
    if (existing) show.step(`DSH profile：${profileDir}`);
    else show.step(`DSH profile 不存在，将先初始化：${profileDir}`);
    describePlan({ profileDir, profile, payload, spec });
    if (existing && opts.noBackup) show.step('将覆盖现有插件目录，且不保留备份（--no-backup）');
    else show.step(`旧版备份目录：${backupDir}`);
    return { dryRun: true, profileDir, version: payload.version };
  }

  const { pkgFile, manifest: before } = ensureProfile(opts, dshHome, profileDir, profile);

  show.title(`安装 ${PLUGIN} ${payload.version}`);
  show.step(`profile：${profileDir}`);

  const beforeText = fs.readFileSync(pkgFile, 'utf8');
  let movedOldPlugin = false;
  try {
    // 1. 备份 profile 清单与旧版插件
    if (!opts.noBackup) fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'));
    if (fs.existsSync(target)) {
      if (opts.noBackup) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.renameSync(target, path.join(backupDir, 'dsh-arcvista'));
        movedOldPlugin = true;
      }
    }

    // 2. 落盘：profile 内 tarball + node_modules 插件目录
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.copyFileSync(payload.tarball, tarballInsideProfile);
    fs.cpSync(payload.dir, target, { recursive: true, force: true });
    show.ok(`已复制插件文件：${target}`);

    // 3. 注册依赖与 bundle
    const next = JSON.parse(JSON.stringify(before));
    next.dependencies = next.dependencies && typeof next.dependencies === 'object' ? next.dependencies : {};
    next.dependencies[PLUGIN] = spec;
    if (!next.dsh.profile.bundles.includes(PLUGIN)) next.dsh.profile.bundles.push(PLUGIN);
    writeJsonPreservingMode(pkgFile, next);
    show.ok(`已注册 profile 依赖与 bundle（${PLUGIN}）`);

    // 4. 清理同一插件的其它版本 tarball
    for (const name of fs.readdirSync(storeDir)) {
      if (name !== tarballName && name.startsWith(`${PLUGIN}-`) && name.endsWith('.tgz')) {
        fs.rmSync(path.join(storeDir, name), { force: true });
      }
    }

    // 5. 自检
    verifyInstallation({ profileDir, profile, payload, spec, quiet: true, opts, dshHome });
    show.ok(`profile 校验通过：${path.relative(profileDir, pkgFile)} 已引用 ${PLUGIN}@${payload.version}`);

    // 6. 提示可能的旧 lockfile
    const lockfile = path.join(profileDir, 'pnpm-lock.yaml');
    if (fs.existsSync(lockfile)) {
      const text = fs.readFileSync(lockfile, 'utf8');
      if (text.includes(PLUGIN) && !text.includes(`${PLUGIN}@file:`)) {
        show.warn(
          'pnpm-lock.yaml 里还记录着旧版 dsh-arcvista；本安装器不修改 lockfile。' +
            '之后运行 pnpm install 时会按离线 tarball 重新解析（需保留 .dsh-offline-plugins/ 目录）。',
        );
      }
    }

    console.log('');
    show.ok(`安装完成：${PLUGIN} ${payload.version}`);
    show.info(`备份：${opts.noBackup ? '未保留（--no-backup）' : backupDir}`);
    printNextSteps(profile, manifest);
    return { profileDir, version: payload.version };
  } catch (error) {
    // 回滚：恢复 package.json 与旧版插件
    try {
      fs.writeFileSync(pkgFile, beforeText);
      fs.rmSync(target, { recursive: true, force: true });
      if (movedOldPlugin) fs.renameSync(path.join(backupDir, 'dsh-arcvista'), target);
      if (fs.existsSync(tarballInsideProfile)) fs.rmSync(tarballInsideProfile, { force: true });
      show.warn('安装失败，已回滚到安装前状态');
    } catch (rollbackError) {
      show.fail(`回滚未完全成功：${rollbackError.message}`);
      show.info(`请手动恢复备份：${backupDir}`);
    }
    throw error;
  }
}

function verifyInstallation({ profileDir, profile, payload, spec, quiet = false, opts, dshHome }) {
  const problems = [];
  const current = readProfile(profileDir);
  if (!current) problems.push(`profile 不存在：${profileDir}`);
  else {
    const { manifest } = current;
    if (!manifest.dependencies || manifest.dependencies[PLUGIN] !== spec) {
      problems.push(`profile 依赖不正确：期望 ${PLUGIN} = ${spec}，实际 ${JSON.stringify(manifest.dependencies?.[PLUGIN])}`);
    }
    if (!manifest.dsh.profile.bundles.includes(PLUGIN)) problems.push(`dsh.profile.bundles 缺少 ${PLUGIN}`);
  }

  const target = path.join(profileDir, 'node_modules', PLUGIN);
  const installedPkgFile = path.join(target, 'package.json');
  let installedVersion;
  if (!fs.existsSync(installedPkgFile)) problems.push(`插件目录缺失：${target}`);
  else {
    const installed = readJson(installedPkgFile);
    installedVersion = installed.version;
    if (installed.name !== PLUGIN) problems.push(`已安装包名异常：${installed.name}`);
    if (payload && installed.version !== payload.version) {
      problems.push(`版本不一致：安装包 ${payload.version}，已安装 ${installed.version}`);
    }
  }
  const tarballVersion = payload?.version ?? installedVersion;
  if (tarballVersion) {
    const tarball = path.join(profileDir, STORE, `${PLUGIN}-${tarballVersion}.tgz`);
    if (!fs.existsSync(tarball)) problems.push(`离线 tarball 缺失：${tarball}`);
  }

  if (!opts?.noVerify) {
    const cli = detectDsh(opts || {}, dshHome);
    if (!cli) {
      if (!quiet) show.warn('未找到 dsh 命令，跳过 --dump-config 校验；重启 DSH 后可手动执行 dsh --profile ' + profile + ' --dump-config 确认。');
    } else {
      const result = runDsh(cli, ['--profile', profile, '--dump-config'], dshHome);
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (result.error || result.status !== 0) {
        problems.push(`dsh --dump-config 失败（退出码 ${result.status}）：${(result.stderr || result.error?.message || '').trim().slice(0, 800)}`);
      } else if (!new RegExp(`- id:\\s*${ENTRY_ID}\\b`).test(output) || !output.includes(`name: ${PLUGIN}`) && !output.includes(`name: '${PLUGIN}'`)) {
        problems.push(`dsh --dump-config 输出中没有找到 ${PLUGIN}（${ENTRY_ID}）条目`);
      } else if (!quiet) {
        show.ok(`dsh --dump-config 已确认 ${ENTRY_ID} 条目（DSH ${cli.version}）`);
      }
    }
  }

  if (problems.length > 0) throw new InstallError(`安装校验未通过：\n  - ${problems.join('\n  - ')}`);
  return true;
}

function printNextSteps(profile, manifest) {
  console.log('');
  console.log(cyan('下一步：'));
  console.log('  1. 退出并重新启动 DSH Web（Host 插件在启动时加载，热更新不生效）；');
  console.log('  2. 左侧栏出现「ArcVista 观界」，点击即可打开面板；');
  console.log('  3. 面板顶部显示「已连接」即安装成功；也可以在浏览器直接访问：');
  console.log(dim('     http://127.0.0.1:3080/arcvista/'));
  console.log('');
  console.log(cyan('数据与网络：'));
  console.log('  - 数据目录：~/.dsh/arcvista（项目列表、任务、全局备份），卸载不会删除；分析快照在项目自己的 .arcvista/；');
  console.log('  - 分析时只读取本机项目目录，不联网、不克隆仓库；');
  console.log('  - 模型由 DSH 当前默认模型提供，不额外直连外网；没有可用模型时静态分析仍完整可用。');
  console.log('');
  console.log(dim(`  dsh-arcvista ${manifest?.version || ''} · 详细说明见 README.md`));
}

function uninstall(opts, dshHome, profileDir, profile, payload) {
  const current = readProfile(profileDir);
  if (!current) {
    if (opts.dryRun) {
      show.title('卸载计划（--dry-run，不会写入任何文件）');
      show.ok(`profile 不存在，无需卸载：${profileDir}`);
      return { uninstalled: false, dryRun: true };
    }
    throw new InstallError(`profile 不存在：${profileDir}`);
  }
  const { manifest, pkgFile } = current;
  const target = path.join(profileDir, 'node_modules', PLUGIN);
  const storeDir = path.join(profileDir, STORE);
  const installed = manifest.dependencies?.[PLUGIN];
  const registered = manifest.dsh.profile.bundles.includes(PLUGIN);
  if (!installed && !registered && !fs.existsSync(target)) {
    show.title('卸载');
    show.ok(`${PLUGIN} 未安装，无需卸载。`);
    return { uninstalled: false };
  }
  if (opts.dryRun) {
    show.title('卸载计划（--dry-run，不会写入任何文件）');
    show.step(`移除目录：${target}`);
    show.step(`从 package.json 移除依赖 ${PLUGIN} 与 bundle 注册`);
    show.step(`移除 ${storeDir} 中的离线 tarball${opts.noBackup ? '（不保留备份）' : '（旧文件移到 backups/）'}`);
    show.step('数据目录 ~/.dsh/arcvista 保留');
    return { uninstalled: false, dryRun: true };
  }

  show.title(`卸载 ${PLUGIN}`);
  const beforeText = fs.readFileSync(pkgFile, 'utf8');
  const stamp = timestamp();
  const backupDir = uniqueDir(path.join(storeDir, 'backups', stamp));
  try {
    if (!opts.noBackup) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'));
      if (fs.existsSync(target)) fs.renameSync(target, path.join(backupDir, PLUGIN));
    } else {
      fs.rmSync(target, { recursive: true, force: true });
    }
    for (const name of fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : []) {
      if (name.startsWith(`${PLUGIN}-`) && name.endsWith('.tgz')) {
        const file = path.join(storeDir, name);
        if (opts.noBackup) fs.rmSync(file, { force: true });
        else {
          fs.mkdirSync(backupDir, { recursive: true });
          fs.renameSync(file, path.join(backupDir, name));
        }
      }
    }
    delete manifest.dependencies?.[PLUGIN];
    if (manifest.dependencies && Object.keys(manifest.dependencies).length === 0) delete manifest.dependencies;
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== PLUGIN);
    writeJsonPreservingMode(pkgFile, manifest);
    show.ok(`已移除插件目录、依赖与 bundle 注册`);
    show.info(`备份：${opts.noBackup ? '未保留（--no-backup）' : backupDir}`);
    show.info('数据目录 ~/.dsh/arcvista 未删除；不再需要时可手动删除。');
    console.log('');
    show.ok('卸载完成，重启 DSH Web 后生效。');
    return { uninstalled: true };
  } catch (error) {
    try {
      fs.writeFileSync(pkgFile, beforeText);
    } catch {
      // 忽略：下面会提示手动恢复
    }
    throw error;
  }
}

function verifyOnly(opts, dshHome, profileDir, profile) {
  show.title('检查安装状态');
  const manifest = readJson(path.join(HERE, 'manifest.json'));
  const payload = loadPayload(manifest);
  let status = 'not-installed';
  const current = readProfile(profileDir);
  if (current && (current.manifest.dependencies?.[PLUGIN] || current.manifest.dsh.profile.bundles.includes(PLUGIN))) {
    const spec = current.manifest.dependencies?.[PLUGIN];
    verifyInstallation({ profileDir, profile, payload, spec, opts, dshHome });
    status = 'installed';
    show.ok(`${PLUGIN} ${payload.version} 已安装在 ${profileDir}`);
    show.info('重启 DSH Web 后生效；如果已重启仍看不到入口，请查看 profile 日志。');
  } else {
    show.warn(`${PLUGIN} 尚未安装到 ${profileDir}`);
    show.info('运行 node install.mjs 进行安装。');
  }
  return { status, profileDir };
}

function summary({ dshHome, profile, profileDir }) {
  console.log('');
  console.log(dim(`DSH 数据目录：${dshHome}`));
  console.log(dim(`profile：${profile}（${profileDir}）`));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE.replace('{{VERSION}}', readJson(path.join(HERE, 'manifest.json')).version));
    return 0;
  }
  checkNode();
  const manifestPath = path.join(HERE, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new InstallError('安装包不完整：缺少 manifest.json。请重新解压完整的安装包。');
  const manifest = readJson(manifestPath);
  const payload = loadPayload(manifest);
  if (manifest.version && manifest.version !== payload.version) {
    throw new InstallError(`安装包版本不一致：manifest.json 为 ${manifest.version}，payload 为 ${payload.version}`);
  }
  const dshHome = resolveDshHome(opts);
  const profileDir = path.join(dshHome, 'profiles', opts.profile);

  if (opts.verifyOnly) {
    const result = verifyOnly(opts, dshHome, profileDir, opts.profile);
    summary({ dshHome, profile: opts.profile, profileDir });
    return result.status === 'installed' ? 0 : 1;
  }

  if (opts.uninstall) {
    const result = uninstall(opts, dshHome, profileDir, opts.profile, payload);
    summary({ dshHome, profile: opts.profile, profileDir });
    return result.uninstalled ? 0 : 0;
  }

  const result = install(opts, dshHome, profileDir, opts.profile, payload, manifest);
  summary({ dshHome, profile: opts.profile, profileDir });
  if (result?.dryRun) show.info('以上为预览，未写入任何文件。去掉 --dry-run 即可执行安装。');
  return 0;
}

try {
  const code = await main();
  process.exitCode = code;
} catch (error) {
  if (error instanceof InstallError) {
    console.error('');
    console.error(red(`安装未完成：${error.message}`));
  } else {
    console.error('');
    console.error(red(`安装未完成：${error.message}`));
    if (process.env.ARCVISTA_INSTALL_DEBUG) console.error(error);
    else console.error(dim('设置 ARCVISTA_INSTALL_DEBUG=1 可查看完整堆栈。'));
  }
  process.exitCode = 1;
}
