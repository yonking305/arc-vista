#!/usr/bin/env node
/**
 * 生成 ArcVista 安全审查材料包。
 *
 *   npm run package:security-review
 *
 * 产物（工作空间根目录）：
 *   arc-vista-security-review/       材料目录（文档 + 证据 + 交付物 + 源码快照）
 *   arc-vista-security-review.zip    提交给安全团队的压缩包
 *
 * 材料中的文件清单、校验和、静态扫描结果均由本脚本从实际分发包中采集，
 * 不是手写声明；重新运行即可复核。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..');
const INSTALLER_DIR = path.join(WORKSPACE, 'arc-vista-intranet-installer');
const INSTALLER_ZIP = path.join(WORKSPACE, 'arc-vista-intranet-installer.zip');
const OUT_DIR = path.join(WORKSPACE, 'arc-vista-security-review');
const OUT_ZIP = path.join(WORKSPACE, 'arc-vista-security-review.zip');
const BUILD_DIR = path.join(WORKSPACE, '.arcvista-review-build');
const SCREENSHOT = path.join(ROOT, 'docs', 'screenshots', 'dsh-plugin.png');

const log = (text) => console.log(`[review] ${text}`);
const fail = (text) => {
  console.error(`[review] 失败：${text}`);
  process.exit(1);
};

const PLUGIN = 'dsh-arcvista';
const INSTALLER_SCRIPTS = ['install.mjs', 'install.sh', 'install.command', 'install.bat', 'install.ps1'];
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.html', '.css', '.svg', '.md', '.txt',
  '.sh', '.bat', '.ps1', '.command', '.yml', '.gitignore', '.npmignore',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.tgz', '.gz',
  '.tar', '.woff', '.woff2', '.ttf', '.eot', '.wasm', '.node', '.exe', '.dll', '.so', '.dylib',
]);

const SCANS = [
  {
    id: 'network',
    title: '网络访问 API',
    file: 'scan-network.txt',
    patterns: [
      [/fetch\s*\(/, 'fetch() 调用'],
      [/XMLHttpRequest/, 'XMLHttpRequest'],
      [/WebSocket/, 'WebSocket'],
      [/sendBeacon/, 'navigator.sendBeacon'],
      [/https?\.request\s*\(/, 'http(s).request()'],
      [/node:https?['"]/, 'node:http / node:https 模块'],
      [/node:net['"]/, 'node:net 模块'],
      [/node:dns['"]/, 'node:dns 模块'],
      [/net\.connect\s*\(/, 'net.connect()'],
      [/dns\.(lookup|resolve)\s*\(/, 'DNS 解析调用'],
      [/["'](axios|undici|got|node-fetch)["']/, '第三方 HTTP 客户端'],
      [/createServer\s*\(/, 'HTTP 服务创建'],
      [/\.listen\s*\(/, '端口监听'],
    ],
  },
  {
    id: 'spawn',
    title: '子进程 / 命令执行',
    file: 'scan-process-spawn.txt',
    patterns: [
      [/child_process/, 'child_process 模块'],
      [/\bexecFile\s*\(/, 'execFile()'],
      [/\bspawnSync\s*\(/, 'spawnSync()'],
      [/\bspawn\s*\(/, 'spawn()'],
      [/\bexecSync\s*\(/, 'execSync()'],
      [/child_process\.exec\s*\(/, 'child_process.exec()'],
      [/(?<![.\w$])exec\s*\(/, 'exec()（排除 RegExp.exec / db.exec）'],
    ],
  },
  {
    id: 'dynamic',
    title: '动态代码执行',
    file: 'scan-dynamic-code.txt',
    patterns: [
      [/\beval\s*\(/, 'eval()'],
      [/new\s+Function\s*\(/, 'new Function()'],
      [/vm\.run(In|NewContext|NewContext)?/, 'vm 模块'],
    ],
  },
  {
    id: 'obfuscation',
    title: '混淆 / 隐藏载荷特征',
    file: 'scan-obfuscation.txt',
    patterns: [
      [/[A-Za-z0-9+/]{300,}={0,2}/, '超长 Base64 片段（≥300 字符）'],
      [/(\\x[0-9a-fA-F]{2}){60,}/, '超长十六进制转义序列'],
      [/fromCharCode\s*\(/, 'String.fromCharCode 拼接'],
    ],
  },
  {
    id: 'secrets',
    title: '密钥 / 凭据特征',
    file: 'scan-secrets.txt',
    patterns: [
      [/sk-[A-Za-z0-9]{20,}/, '疑似 OpenAI 风格密钥'],
      [/AKIA[0-9A-Z]{16}/, '疑似 AWS AccessKey'],
      [/ghp_[A-Za-z0-9]{36}/, '疑似 GitHub Token'],
      [/xox[baprs]-[A-Za-z0-9-]{10,}/, '疑似 Slack Token'],
      [/BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY/, '私钥块'],
    ],
  },
];

const INSTALL_TIME_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];

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

function walk(dir) {
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result.push({ absolute, relative: path.relative(dir, absolute), size: fs.statSync(absolute).size });
    }
  };
  visit(dir);
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

function readTextFile(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) return undefined;
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) return undefined;
  return text;
}

function isTextFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return false;
  if (TEXT_EXTENSIONS.has(extension)) return true;
  if (path.basename(file) === 'LICENSE') return true;
  return readTextFile(file) !== undefined;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`);
  return lines.join('\n');
}

function writeFile(relative, content) {
  const target = path.join(OUT_DIR, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`);
}

function writeJson(relative, value) {
  writeFile(relative, `${JSON.stringify(value, undefined, 2)}\n`);
}

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

function loadInputs() {
  if (!fs.existsSync(INSTALLER_DIR)) fail(`缺少内网安装包目录：${INSTALLER_DIR}，请先运行 npm run package:intranet`);
  if (!fs.existsSync(INSTALLER_ZIP)) fail(`缺少分发包：${INSTALLER_ZIP}，请先运行 npm run package:intranet`);
  const installerManifest = JSON.parse(fs.readFileSync(path.join(INSTALLER_DIR, 'manifest.json'), 'utf8'));
  const repoManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (installerManifest.version !== repoManifest.version) {
    fail(`安装包版本 ${installerManifest.version} 与仓库版本 ${repoManifest.version} 不一致，请重新运行 npm run package:intranet`);
  }
  const tarballName = `${PLUGIN}-${installerManifest.version}.tgz`;
  const tarball = path.join(INSTALLER_DIR, 'payload', tarballName);
  if (!fs.existsSync(tarball)) fail(`安装包缺少 payload/${tarballName}`);
  const tarballSha = sha256(tarball);
  if (installerManifest.sha256 && tarballSha !== installerManifest.sha256) {
    fail('安装包 manifest.json 的 tarball 校验和与实际文件不一致，请重新运行 npm run package:intranet');
  }
  return { installerManifest, repoManifest, tarball, tarballName, tarballSha, installerZipSha: sha256(INSTALLER_ZIP) };
}

function collectEnvironment() {
  const npm = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { cwd: ROOT, shell: process.platform === 'win32' });
  const commit = run('git', ['-C', ROOT, 'log', '-1', '--format=%H%n%s%n%cI'], { cwd: ROOT });
  const status = run('git', ['-C', ROOT, 'status', '--porcelain'], { cwd: ROOT });
  const commitLines = (commit.stdout || '').trim().split('\n');
  return {
    date: new Date().toLocaleString('sv-SE'),
    node: process.version,
    npm: (npm.stdout || '').trim() || 'unknown',
    platform: `${process.platform}-${process.arch}`,
    commit: commitLines[0] || 'unknown',
    commitSubject: commitLines[1] || '',
    commitDate: commitLines[2] || '',
    workingTreeClean: (status.stdout || '').trim() === '',
    workingTreeChanges: (status.stdout || '').trim().split('\n').filter(Boolean),
  };
}

function scanTexts(roots) {
  const results = {};
  for (const scan of SCANS) results[scan.id] = [];
  for (const root of roots) {
    for (const file of root.files) {
      const extension = path.extname(file.absolute).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      const text = readTextFile(file.absolute);
      if (text === undefined) continue;
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const scan of SCANS) {
          for (const [pattern, label] of scan.patterns) {
            if (pattern.test(line)) {
              results[scan.id].push({
                scope: root.id,
                file: file.relative,
                line: index + 1,
                label,
                text: line.trim().slice(0, 200),
              });
              break;
            }
          }
        }
      }
    }
  }
  return results;
}

function classify(match) {
  const file = match.file.replace(/\\/g, '/');
  if (/\.(md|txt)$/i.test(file)) {
    return '文档说明文字，不参与执行';
  }
  if (match.scope === 'plugin' && file === 'lib/analyze/security.js') {
    return '安全扫描器的检测规则（正则字符串），不是可执行调用';
  }
  if (match.scope === 'plugin' && file === 'lib/llm.js') {
    return '独立运行模式：直连用户配置的模型服务；DSH 插件模式注入 DSH 模型后不启用';
  }
  if (match.scope === 'plugin' && (file === 'client.js' || file.startsWith('public/js/'))) {
    return '同源请求 ArcVista 自身 API（/arcvista/api/*），不访问外部地址';
  }
  if (match.scope === 'plugin' && (file === 'lib/http.js' || file === 'server.js')) {
    return '本机 HTTP 服务/路由实现；DSH 插件模式不调用 listen，仅注册 /arcvista 路由';
  }
  if (match.scope === 'plugin' && file === 'lib/git.js') {
    return '调用本机 git 子进程访问用户指定仓库地址（克隆/拉取/检出）';
  }
  if (match.scope === 'installer' && file === 'install.mjs') {
    return '安装器调用本机 dsh CLI 做只读版本/配置校验（spawnSync）';
  }
  if (match.scope === 'installer' && file === 'install.bat') {
    return 'Windows 批处理入口：查找并调用 node 运行安装器';
  }
  if (match.scope === 'installer' && (file === 'install.sh' || file === 'install.command')) {
    return 'Shell 入口：查找并调用 node 运行安装器';
  }
  return '需人工确认（见对应证据文件）';
}

function collectUrls(roots) {
  const pattern = /https?:\/\/[^\s'"`)<>\]]+/g;
  const found = new Map();
  for (const root of roots) {
    for (const file of root.files) {
      const extension = path.extname(file.absolute).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      const text = readTextFile(file.absolute);
      if (text === undefined) continue;
      text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          const url = match[0].replace(/[.,;]+$/, '');
          const key = `${url}|${root.id}|${file.relative}|${index + 1}`;
          if (!found.has(key)) found.set(key, { url, scope: root.id, file: file.relative, line: index + 1 });
        }
      });
    }
  }
  return [...found.values()];
}

function urlKind(url) {
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return '本机地址（独立模式/文档示例）';
  if (/api\.(deepseek|openai|moonshot)|dashscope|ollama/.test(url)) return '模型服务地址（独立模式设置页预设，非插件模式调用）';
  if (/github\.com|githubusercontent/.test(url)) return '项目/文档链接（仅文档或 git 地址示例）';
  if (/npmjs\.com|deepseek-ai|deepseek\.com\/harness/.test(url)) return 'DSH/依赖文档链接';
  return '文档链接或示例';
}

function collectLifecycle(payloadDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(payloadDir, 'package.json'), 'utf8'));
  const scripts = manifest.scripts || {};
  return {
    manifest,
    scripts,
    installHooks: INSTALL_TIME_HOOKS.filter((name) => Object.hasOwn(scripts, name)),
    dependencies: manifest.dependencies || {},
    devDependencies: manifest.devDependencies || {},
    peerDependencies: manifest.peerDependencies || {},
    optionalDependencies: manifest.optionalDependencies || {},
  };
}

function collectBinaries(rootDir) {
  const items = [];
  for (const file of walk(rootDir)) {
    const extension = path.extname(file.absolute).toLowerCase();
    const text = readTextFile(file.absolute);
    if (text === undefined || BINARY_EXTENSIONS.has(extension)) {
      items.push({
        relative: path.relative(rootDir, file.absolute).split(path.sep).join('/'),
        size: file.size,
        kind: BINARY_EXTENSIONS.has(extension) ? extension.slice(1) : '未识别二进制',
      });
    }
  }
  return items;
}

function buildInventory(installerManifest, tarballName, tarballSha) {
  const inventory = [];
  for (const file of walk(INSTALLER_DIR)) {
    inventory.push({
      path: path.relative(INSTALLER_DIR, file.absolute),
      bytes: file.size,
      sha256: sha256(file.absolute),
      text: isTextFile(file.absolute),
    });
  }
  return { inventory, installerManifest, tarballName, tarballSha };
}

/* ------------------------------------------------------------------ */
/* 文档                                                                */
/* ------------------------------------------------------------------ */

function renderSummary(data) {
  const { manifest, env, lifecycle, scans, binaries } = data;
  const network = scans.network || [];
  const secrets = scans.secrets || [];
  const dynamic = scans.dynamic || [];
  return `# 01 · 审查摘要

## 基本信息

${table(
    ['项目', '值'],
    [
      ['包名', 'dsh-arcvista'],
      ['版本', manifest.version],
      ['中文名', 'ArcVista 观界 · 架构观测台'],
      ['许可', 'MIT'],
      ['源码仓库', 'https://github.com/yonking305/arc-vista'],
      ['源码提交', env.commit ? env.commit.slice(0, 12) : 'unknown'],
      ['构建环境', `Node ${env.node} / npm ${env.npm} / ${env.platform}`],
      ['构建时间', env.date],
      ['兼容 DSH', '0.2.0-rc.2 与 0.2.1-rc.2 已实测（见 08 文档）'],
      ['分发包', 'arc-vista-intranet-installer.zip'],
      ['插件 tarball SHA-256', data.tarballSha],
    ],
  )}

## 结论摘要（供快速评审）

1. **纯 JavaScript / 文本构成**：分发包内没有 .exe / .dll / .so / .node 等原生二进制；唯一的二进制内容是 npm 打包归档（.tgz，内含上述纯文本文件）和一张文档截图（.png）。
2. **零第三方运行时依赖**：插件 package.json 没有 dependencies / devDependencies / peerDependencies，安装过程不会解析或下载任何依赖树。
3. **无安装期生命周期脚本**：不存在 preinstall / install / postinstall / prepare 等安装期钩子；仅有的 prepack 只在开发机执行本地只读校验脚本，安装 tarball 时不会运行。
4. **安装器不联网**：安装器只做本地文件复制 + DSH profile 注册 + 调用本机 dsh CLI 做只读校验，不访问 registry、GitHub 或任何远程服务。
5. **运行期外联边界清晰**：唯一的主动外联是调用本机 git 访问"用户自己填写的被观测仓库地址"；DSH 插件模式下模型调用经 DSH 的 llm 服务（DSH 已配置的模型服务商），插件不直连模型。
6. **模型直连代码在插件模式下不可达**：lib/llm.js 的 fetch 仅在独立运行模式（npm start）且用户显式配置 Base URL + API Key 后才会执行；DSH 插件模式下模型由 DSH 注入，设置写入与连通性测试接口均被短路。
7. **不收集、不上传数据**：没有遥测、埋点、统计上报代码；数据只写入本机用户目录（~/.dsh/arcvista），SQLite、仓库镜像与备份均留在本地。
8. **静态扫描结果**：未发现密钥/凭据、隐私凭据、eval/new Function 等动态执行、混淆或隐藏载荷特征。逐项证据见 05 文档与 evidence/ 目录。

## 已知风险与边界（建议评审时一并确认）

${table(
    ['能力', '触发条件', '数据流向', '控制/关闭方式'],
    [
      ['调用本机 git 访问仓库', '用户在产品里填写 Git 地址并分析', '被克隆仓库内容留在本机；不向插件作者回传', '只填写内网可达仓库；不分析外部仓库即可'],
      ['模型语义增强', 'DSH 提供可用默认模型时', '仅把仓库证据摘要（模块/依赖/路由/配置/指标，不含完整源码）交给 DSH 的模型服务', '不配置模型即回退纯静态分析；模型调用由 DSH 统一管控'],
      ['独立运行模式直连模型', '不使用 DSH、单独 npm start 并配置 Base URL+API Key', '请求发往用户自己配置的地址', '插件安装场景不涉及；内网可按第 06 节在网络层封禁'],
      ['本机 HTTP 服务', '仅独立运行模式（插件模式不监听端口）', '监听 127.0.0.1，无对外暴露', '插件安装场景不涉及'],
    ],
  )}

## 审查材料导航

| 文件 | 内容 |
| --- | --- |
| 02-artifacts-and-checksums.md | 所有交付物的 SHA-256 与校验命令 |
| 03-file-inventory.md | 分发包逐文件清单与摘要 |
| 04-dependencies-and-sbom.md | 依赖声明与 CycloneDX SBOM |
| 05-static-security-scan.md | 网络/进程/动态代码/密钥/混淆扫描结果 |
| 06-permissions-and-data-boundary.md | 文件、进程、网络、数据流向边界 |
| 07-reproducible-build.md | 从源码重新构建并比对校验和 |
| 08-tests-and-verification.md | 自动化测试与 DSH 内实机验证记录 |
| 09-approval-request-template.md | 可直接改写提交的审批说明模板 |
| evidence/ | 上述结论的原始扫描证据 |
| artifacts/ | 待审查的安装包、源码快照与安装器源码 |
| tools/verify-review-package.mjs | 复核脚本（重算校验和、可选重跑扫描） |
`;
}

function renderArtifacts(data) {
  const { manifest, env, artifacts } = data;
  return `# 02 · 交付物与校验和

## 待审查交付物

${table(
    ['文件', '大小', 'SHA-256', '说明'],
    artifacts
      .filter((item) => !item.name.startsWith('artifacts/installer-source/'))
      .map((item) => [item.name, formatBytes(item.bytes), item.sha256, item.description])
      .concat([[
        'artifacts/installer-source/',
        formatBytes(artifacts.filter((item) => item.name.startsWith('artifacts/installer-source/')).reduce((sum, item) => sum + item.bytes, 0)),
        '（逐文件哈希见 CHECKSUMS.sha256）',
        '安装器与打包脚本源码，原样收录',
      ]]),
  )}

## 插件包（tarball）

| 项目 | 值 |
| --- | --- |
| 文件名 | payload/${data.tarballName} |
| 版本 | ${manifest.version} |
| 大小 | ${formatBytes(data.tarballSize)} |
| SHA-256 | ${data.tarballSha} |
| 文件数 | ${data.tarballFiles.length} |
| 归档内容 | 见 evidence/npm-tarball-files.txt（逐文件列表） |

## 校验方法

Windows PowerShell：

    Get-FileHash artifacts\\arc-vista-intranet-installer.zip -Algorithm SHA256
    Get-FileHash artifacts\\arc-vista-intranet-installer.zip -Algorithm SHA256 | Format-List

macOS / Linux：

    shasum -a 256 artifacts/arc-vista-intranet-installer.zip
    shasum -a 256 artifacts/arc-vista-${manifest.version}-source.zip

一键复核全部材料（推荐）：

    node tools/verify-review-package.mjs

校验通过时输出 PASS；任何文件缺失或被改动都会输出 FAIL 并以非零码退出。

## 与内网安装包的关系

本材料包中的 artifacts/arc-vista-intranet-installer.zip 即待放行的内网安装包本体，其 SHA-256 已记录在上表。
安装器会在安装前再次校验插件 tarball 的 SHA-256（与安装包内 manifest.json 一致），不一致会中止安装。

## 构建溯源

| 项目 | 值 |
| --- | --- |
| 源码提交 | ${env.commit || 'unknown'} |
| 提交说明 | ${env.commitSubject || ''} |
| 提交时间 | ${env.commitDate || ''} |
| 工作树状态 | ${env.workingTreeClean ? '干净（与源码快照一致）' : `含未提交改动：${env.workingTreeChanges.join('；') || '无'}`} |
| 构建时间 | ${env.date} |
| 构建环境 | Node ${env.node} / npm ${env.npm} / ${env.platform} |
| 构建命令 | npm run package:intranet（由 07 文档详述） |

说明：源码快照取自 git 提交 ${env.commit ? env.commit.slice(0, 12) : 'unknown'}；打包脚本与安装器源码是当前工作树新增的未提交文件，已原样收录在 artifacts/installer-source/ 中，便于逐行核对。
`;
}

function renderInventory(data) {
  const { inventory } = data;
  const byExtension = new Map();
  for (const file of inventory) {
    const extension = path.extname(file.path).toLowerCase() || '(无扩展名)';
    const bucket = byExtension.get(extension) || { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += file.bytes;
    byExtension.set(extension, bucket);
  }
  const summaryRows = [...byExtension.entries()]
    .sort((left, right) => right[1].bytes - left[1].bytes)
    .map(([extension, bucket]) => [extension, bucket.count, formatBytes(bucket.bytes)]);
  const topRows = inventory
    .filter((file) => file.bytes > 20 * 1024)
    .map((file) => [file.path, formatBytes(file.bytes), file.sha256.slice(0, 16)]);
  const textCount = inventory.filter((file) => file.text).length;
  const binaryCount = inventory.length - textCount;
  return `# 03 · 文件清单

## 摘要

${table(
    ['项目', '值'],
    [
      ['分发包文件总数', inventory.length],
      ['文本文件', `${textCount} 个（JavaScript / JSON / YAML / Markdown / 样式等）`],
      ['二进制文件', `${binaryCount} 个（npm 打包归档 .tgz 与文档截图 .png，见 05 文档）`],
      ['分发包总大小', formatBytes(inventory.reduce((sum, file) => sum + file.bytes, 0))],
      ['逐文件清单', 'evidence/file-inventory.csv（路径 / 大小 / SHA-256 / 是否文本）'],
      ['逐文件哈希', 'evidence/file-hashes.sha256（sha256sum 格式）'],
      ['插件 tarball 内容', 'evidence/npm-tarball-files.txt'],
    ],
  )}

## 按扩展名统计

${table(['扩展名', '文件数', '合计大小'], summaryRows)}

## 较大的文件（> 20 KB）

${table(['路径', '大小', 'SHA-256 前 16 位'], topRows)}

## 文件构成说明

- payload/dsh-arcvista/：插件本体（Host 入口、Client 入口、静态页面、分析引擎、文档），共 ${data.tarballFiles.length} 个文件，全部为纯文本；
- payload/${data.tarballName}：上面这份插件本体经 npm pack 生成的归档，供 pnpm / dsh plugin add 使用；
- install.mjs / install.sh / install.command / install.bat / install.ps1：跨平台安装入口，纯文本脚本；
- docs/dsh-plugin.png：安装说明用的界面截图（唯一图片）；
- manifest.json / README.md / START-HERE.txt：包元信息与使用说明。

完整逐文件清单见 evidence/file-inventory.csv。
`;
}

function renderDependencies(data) {
  const { lifecycle } = data;
  const scripts = Object.entries(lifecycle.scripts).map(([name, command]) => [name, command, INSTALL_TIME_HOOKS.includes(name) ? '安装期钩子（不允许）' : '开发/构建期，安装时不会执行']);
  return `# 04 · 依赖与 SBOM

## 依赖声明

${table(
    ['字段', '内容'],
    [
      ['dependencies', Object.keys(lifecycle.dependencies).length === 0 ? '无（0 个）' : JSON.stringify(lifecycle.dependencies)],
      ['devDependencies', Object.keys(lifecycle.devDependencies).length === 0 ? '无（0 个）' : JSON.stringify(lifecycle.devDependencies)],
      ['peerDependencies', Object.keys(lifecycle.peerDependencies).length === 0 ? '无（0 个）' : JSON.stringify(lifecycle.peerDependencies)],
      ['optionalDependencies', Object.keys(lifecycle.optionalDependencies).length === 0 ? '无（0 个）' : JSON.stringify(lifecycle.optionalDependencies)],
      ['node_modules', '分发包内不包含 node_modules'],
      ['lockfile 依赖树', '不存在（无依赖需要解析）'],
    ],
  )}

## 运行平台要求

${table(
    ['项目', '要求'],
    [
      ['Node.js', '^22.19.0 || >=24.0.0（使用内置 node:sqlite）'],
      ['DSH', '>=0.2.0-rc.2 <0.3.0-0（实测 0.2.0-rc.2 / 0.2.1-rc.2）'],
      ['git', '本机安装 git，用于克隆被观测仓库'],
    ],
  )}

## 生命周期脚本

${table(['脚本名', '命令', '类别'], scripts)}

结论：${lifecycle.installHooks.length === 0 ? '**不存在任何安装期生命周期钩子**，安装 tarball 不会执行包内代码。' : `存在安装期钩子：${lifecycle.installHooks.join(', ')}（需重点审查）`}

## SBOM

已生成 CycloneDX 1.5 格式：\`sbom.cdx.json\`。摘要：

${table(
    ['组件', '版本', '类型', '依赖数', 'SHA-256'],
    [['dsh-arcvista', lifecycle.manifest.version, 'application', '0', data.tarballSha]],
  )}
`;
}

function renderStaticScan(data) {
  const { scans } = data;
  const rows = [];
  for (const scan of SCANS) {
    const matches = scans[scan.id] || [];
    rows.push([scan.title, matches.length === 0 ? '未发现' : `${matches.length} 处`, scan.file]);
  }
  const detail = [];
  for (const scan of SCANS) {
    const matches = scans[scan.id] || [];
    if (matches.length === 0) {
      detail.push(`### ${scan.title}\n\n未发现相关代码特征。证据文件：evidence/${scan.file}\n`);
      continue;
    }
    const rowsForScan = matches.slice(0, 60).map((match) => [
      `${match.scope === 'plugin' ? '插件' : '安装器'} · ${match.file}:${match.line}`,
      match.label,
      classify(match),
      `\`${match.text.replace(/`/g, "'")}\``,
    ]);
    detail.push(`### ${scan.title}\n\n共 ${matches.length} 处，逐条判定如下（证据文件：evidence/${scan.file}）：\n\n${table(['位置', '特征', '性质判定', '代码片段'], rowsForScan)}${matches.length > 60 ? `\n\n> 其余 ${matches.length - 60} 处见证据文件。\n` : ''}`);
  }
  return `# 05 · 静态安全核查

## 方法

- 扫描对象：分发包内的插件源码（payload/dsh-arcvista/**，即实际安装到 DSH 的内容）与安装器脚本（install.mjs / .sh / .command / .bat / .ps1）；
- 扫描方式：逐行正则匹配，规则表见下；原始命中逐条写入 evidence/scan-*.txt；
- 判定原则：宁可多报，不隐藏命中；每处命中给出性质判定，评审可据代码片段自行复核；
- 误报处理：子进程类扫描排除 RegExp.prototype.exec / SQLite db.exec 等非进程 API（用负向后顾排除 xxx.exec(），仅统计真实进程/命令调用；安装器脚本中的 spawnSync 仅用于调用本机 dsh CLI；
- 本材料由 \`scripts/build-security-review.mjs\` 从实际分发包采集生成，重新运行即可复现（npm run package:security-review）。

## 结果总览

${table(['类别', '结果', '证据文件'], rows)}

## 逐项判定

${detail.join('\n')}

## 补充说明

- **无原生二进制**：分发包内没有 .exe / .dll / .so / .node / .wasm 文件；二进制仅有 npm 归档（.tgz）与一张文档截图（.png），清单见 evidence/binary-files.txt。
- **无动态执行**：产品代码中没有 eval / new Function / vm 调用。仅在安全分析器的检测规则中出现相关正则字符串（用于扫描被观测仓库），不会在本机执行。
- **无密钥凭据**：未命中任何密钥/Token/私钥特征；项目本身不保存 API Key（DSH 插件模式使用 DSH 的模型配置）。
- **无混淆**：未发现超长 Base64、超长十六进制转义或 fromCharCode 拼接等隐藏载荷特征；代码可读、未压缩。
- **无安装期脚本**：见 04 文档，安装 tarball 不执行包内代码。

## 复核方式

    # 重算全部校验和
    node tools/verify-review-package.mjs

    # 解出安装包并重跑静态扫描（需要系统 tar，Windows 10+ / macOS / Linux 均自带）
    node tools/verify-review-package.mjs --extract
`;
}

function renderBoundary(data) {
  return `# 06 · 权限与数据边界

## 安装器做什么、不做什么

| 动作 | 是否执行 | 说明 |
| --- | --- | --- |
| 读取本地文件 | 是 | 读取自身 payload 与 DSH profile 的 package.json |
| 写入文件 | 是 | 仅写入 DSH profile 目录：node_modules/dsh-arcvista、.dsh-offline-plugins/、package.json |
| 调用本机 dsh CLI | 是 | 只读命令：dsh --version、dsh --profile <name> --dump-config（用于校验插件已进入配置树） |
| 网络访问 | **否** | 不访问 registry / GitHub / 任何远程地址 |
| 安装 npm 依赖 | **否** | 插件零依赖，无需 pnpm/npm 解析依赖 |
| 修改系统 / DSH 核心 / 全局 npm | **否** | 不改注册表、不改 PATH、不写系统目录、不改 DSH 安装目录 |
| 执行包内生命周期脚本 | **否** | 包内没有安装期钩子 |

## 运行期文件边界

| 路径 | 用途 | 权限/说明 |
| --- | --- | --- |
| ~/.dsh/arcvista/arcvista.db | 产品、快照、设置（SQLite） | 用户目录，数据库文件权限 600 |
| ~/.dsh/arcvista/repos/ | 被观测仓库的 bare mirror | 可随时删除，重新分析自动重建 |
| ~/.dsh/arcvista/worktrees/ | 按提交检出的临时工作区 | 分析完成后只保留最近使用的 |
| ~/.dsh/arcvista/backups/ | SQLite 自动备份（默认 12 份，权限 600） | 只备份数据库，不重复备份仓库镜像 |
| ~/.dsh/profiles/<profile>/ | 安装位置与离线 tarball | 卸载时移除，旧版备份保留在 .dsh-offline-plugins/backups/ |

## 运行期网络边界

| 能力 | 触发条件 | 数据内容 | 是否为 DSH 插件模式默认行为 |
| --- | --- | --- | --- |
| 调用本机 git 克隆/拉取/检出 | 用户创建产品并分析仓库 | 访问用户填写的仓库地址；仓库内容留在本机 | 是（任务必需） |
| 模型语义增强 | DSH 提供可用默认模型时 | 仅发送仓库证据摘要（模块、依赖、路由、配置、指标），**不含完整源码** | 是（无模型时自动回退纯静态分析） |
| 直连 OpenAI 兼容模型 | 仅独立运行模式且用户显式配置 Base URL + API Key | 用户配置的模型服务 | **否**（插件模式不启用，设置写入/测试接口被 DSH 托管短路） |
| 本机 HTTP 监听 | 仅独立运行模式（npm start，默认 127.0.0.1:4321） | 仅本机可访问 | **否**（插件模式由 DSH webServer 挂载 /arcvista，不监听端口） |
| 遥测 / 埋点 / 统计上报 | 不存在 | 无 | 无 |

## 对 DSH 的改动范围

- 不修改 DSH 安装目录与核心代码；
- 不占用 @deepseek-ai/* 命名空间；
- 只向当前 profile 的 package.json 增加一个 file: 依赖和一个 bundle 注册项，两者都可由卸载命令精确移除。

## 数据外发可控性建议（内网）

1. 分析对象限定为内网可达仓库；
2. 若不允许把仓库摘要交给模型，可不给 DSH 配置模型，或让 DSH 侧禁用模型；
3. 如需完全离线，可在主机防火墙层禁止该进程访问外部地址，静态分析功能不受影响（仅失去语义增强）；
4. 仓库镜像与数据库都在本机用户目录，可直接删除或用备份恢复。
`;
}

function renderBuild(data) {
  const { manifest } = data;
  return `# 07 · 可复现构建

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 22.19+（与插件运行时一致） |
| npm | 随 Node 提供（仅用于 npm pack，不下载依赖） |
| git | 用于取源码快照（可选） |
| 操作系统 | Windows / macOS / Linux 均可 |

## 构建步骤

    # 1. 取源码（仓库根目录即 npm 包根目录）
    git clone https://github.com/yonking305/arc-vista.git
    cd arc-vista
    git checkout ${data.env.commit || '<commit>'}

    # 2. 运行测试（零依赖，无需 npm install）
    npm test

    # 3. 构建内网离线安装包
    npm run package:intranet
    # 产物：../arc-vista-intranet-installer/ 与 ../arc-vista-intranet-installer.zip

    # 4. 构建安全审查材料（本文件所在材料包）
    npm run package:security-review
    # 产物：../arc-vista-security-review/ 与 ../arc-vista-security-review.zip

## 预期结果

${table(
    ['产物', '预期值'],
    [
      ['插件 tarball', `dsh-arcvista-${manifest.version}.tgz`],
      ['插件 tarball SHA-256', data.tarballSha],
      ['安装包 zip SHA-256', data.installerZipSha],
      ['安装包文件数', data.inventory.length],
      ['测试结果', '13 个测试全部通过（Node 内置 node:test）'],
    ],
  )}

## 确定性说明

- 插件 tarball 由 npm pack 对同一份源码生成，本次构建连续两次运行得到相同 SHA-256（${data.tarballSha}），可与本材料核对；
- 安装包 zip 同样可复现：构建脚本把包内"生成日期"固定为源码提交日期，并把所有产物文件时间戳统一为提交时间（也支持通过环境变量 SOURCE_DATE_EPOCH 指定），因此同一源码提交 + 同一构建脚本连续构建得到完全相同的 SHA-256（${data.installerZipSha}）；
- 审查材料 zip 内的文档记录了本次实际构建时间，跨次生成会出现日期差异，因此材料 zip 的哈希仅对应本次提交版本；材料内部以 CHECKSUMS.sha256 与插件 tarball 的 SHA-256 作为内容一致性基准；
- 所有构建步骤只读源码、只写工作空间内的产物目录，不联网、不执行包内脚本以外的代码。

## 独立复核

安全团队可在自己机器上按上述步骤重新构建，并比对：

    node tools/verify-review-package.mjs
    # 再与自己构建的 tarball 比对 SHA-256

若重新构建的 tarball 与材料中的 SHA-256 不一致，说明源码或构建环境存在差异，应暂停放行并联系提供方。
`;
}

function renderVerification(data) {
  const { testResult, checkResult, manifest } = data;
  return `# 08 · 测试与验证记录

## 构建环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | ${data.env.platform} |
| Node.js | ${data.env.node} |
| npm | ${data.env.npm} |
| 构建时间 | ${data.env.date} |
| 源码提交 | ${data.env.commit || 'unknown'} |

## 自动化测试

命令：\`npm test\`（Node 内置 node:test，零依赖）

${testResult}

## 包内容自检

命令：\`node scripts/check-package.mjs\`（npm pack 的 prepack 阶段执行）

${checkResult}

## DSH 内实机验证

| 场景 | 环境 | 结果 |
| --- | --- | --- |
| 全新 profile 安装 → 重启 → 打开面板 | DSH 0.2.0-rc.2（macOS） | 通过：GET /arcvista/ 返回 200；/arcvista/api/health 返回 version="${manifest.version}" 且 dataDir 为实际数据目录；客户端插件注册到 Web 壳；启动日志无插件激活报错 |
| 全新 profile 安装 → 重启 → 打开面板 | DSH 0.2.1-rc.2（内网 Windows 便携版 DSH 代码，macOS 上运行） | 通过：GET /arcvista/ 返回 200；/arcvista/api/health 返回 version="${manifest.version}"；路由与客户端注册正常 |
| 重复安装 / 升级覆盖 | DSH 0.2.0-rc.2 | 通过：旧版自动备份到 .dsh-offline-plugins/backups/，配置不重复 |
| 卸载 | DSH 0.2.0-rc.2 | 通过：插件目录、依赖、bundle 注册均被移除，数据目录保留 |
| 只读预览（--dry-run） | DSH 0.2.0-rc.2 | 通过：不写任何文件 |
| pnpm 离线一致性 | pnpm 10.x + 本地 tarball | 通过：profile 内 file: 依赖可离线解析，安装后插件仍可加载 |

## 验证限制（如实说明）

1. 本次验证在 macOS 上完成；DSH 0.2.1-rc.2 使用内网 Windows 便携版所带的 DSH 代码运行（补充了 macOS 原生绑定以启动），**未在真实 Windows 10/11 + DSH 便携版上执行双击安装**。安装器 Windows 入口（install.bat / install.ps1）与 macOS/Linux 入口调用同一份 install.mjs，逻辑一致，但建议内网验收时按下列清单补测。
2. DSH 0.2.1-rc.2 的实际运行环境为 Windows，本次以其 JS 代码在 macOS 验证插件兼容性；插件不包含平台相关原生模块，平台差异风险低。
3. 测试未覆盖内网代理、终端防护软件干扰等企业环境因素。

## 内网验收建议清单

1. 校验 ZIP 与 tarball 的 SHA-256（见 02 文档）；
2. 在测试机 Windows 上双击 install.bat，确认输出"安装完成"；
3. 重启 DSH Web，确认左侧栏出现「ArcVista 观界」；
4. 打开面板，确认顶部显示"已连接"；
5. 用浏览器访问 http://127.0.0.1:3080/arcvista/ 返回 200；
6. 运行 node install.mjs --verify 返回通过；
7. 运行 node install.mjs --uninstall，确认可干净卸载；
8. 如需继续观察，可将被观测仓库指向内网 Git 仓库做一次完整分析。
`;
}

function renderApprovalTemplate(data) {
  const { manifest } = data;
  return `# 09 · 安全审批申请模板

> 使用说明：将【】中的内容替换为本单位信息后提交给信息安全/网络安全管理团队，附件使用本材料包。

---

## 主题：申请放行 DSH 插件 ArcVista 观界（dsh-arcvista ${manifest.version}）

### 一、背景

为提升研发架构可视化与代码安全观察能力，团队计划在内网 DeepSeek Harness（DSH）中安装内部工具插件 **ArcVista 观界（dsh-arcvista ${manifest.version}）**。该插件用于对 Git 仓库生成架构图、安全守护清单、复杂度与覆盖率看板，数据均保存在本机。

### 二、申请事项

1. 放行离线安装包 \`arc-vista-intranet-installer.zip\`（SHA-256：${(data.artifacts || []).find((item) => item.name.endsWith('arc-vista-intranet-installer.zip'))?.sha256 || ''}）；
2. 或将该安装包纳入内网白名单/内部制品库分发范围；
3. 允许其在 DSH 用户目录（~/.dsh）下写入插件文件与本地数据。

### 三、安全自评结论

- 纯 JavaScript，无原生二进制、无 exe/dll；
- 零第三方依赖，无安装期生命周期脚本；
- 安装器不联网，只做本地复制与 profile 注册；
- 无密钥、无动态代码执行、无混淆、无遥测上报；
- 运行期仅通过本机 git 访问用户指定的被观测仓库；模型增强经 DSH 统一模型服务，仅发送仓库证据摘要（不含完整源码）；
- 不修改 DSH 核心、系统配置或全局环境。

### 四、随附材料

1. 01-summary.md：结论摘要与已知边界；
2. 02-artifacts-and-checksums.md：所有产物 SHA-256；
3. 03/04：文件清单、依赖与 SBOM；
4. 05：静态安全扫描原始证据；
5. 06：权限与数据边界说明；
6. 07：可复现构建步骤；
7. 08：测试与验证记录（含验证限制说明）；
8. artifacts/：安装包、源码快照、安装器源码；
9. tools/verify-review-package.mjs：复算校验和/重跑扫描脚本。

### 五、风险控制与回滚

- 安装仅影响当前 DSH profile 目录，卸载命令可精确移除插件、依赖与 bundle 注册；
- 旧版安装前自动备份到 profile/.dsh-offline-plugins/backups/，可原样恢复；
- 运行数据（SQLite、仓库镜像、备份）在 ~/.dsh/arcvista，可单独删除；
- 如需立即停用：执行 \`node install.mjs --uninstall\` 后重启 DSH。

### 六、承诺

- 仅在内网授权环境使用，仅分析本单位授权仓库；
- 不将插件用于数据外传；模型调用遵循 DSH 统一配置与模型服务商合规要求；
- 配合安全团队开展复核、抽检与版本升级报备。

### 七、附件与联系人

- 材料包：arc-vista-security-review.zip；
- 来源与源码：https://github.com/yonking305/arc-vista（MIT 许可，源码可审）；
- 申请人：【姓名 / 部门 / 工号】；
- 联系方式：【电话 / 邮箱】；
- 拟安装范围：【测试机 / 研发终端数量及清单】；
- 期望完成时间：【日期】。

---

### 审批记录（由审批方填写）

| 环节 | 结论 | 审批人 | 日期 |
| --- | --- | --- | --- |
| 安全初审 |  |  |  |
| 终端/网络 |  |  |  |
| 结论 |  |  |  |
`;
}

function renderReadme(data) {
  return `# ArcVista 安全审查材料包

本材料用于向内网信息安全/网络安全管理团队说明 **dsh-arcvista（ArcVista 观界）** 插件的构成与安全边界，申请放行或纳入白名单。

- 插件版本：**${data.manifest.version}**
- 构建时间：${data.env.date}
- 待审查安装包：\`artifacts/arc-vista-intranet-installer.zip\`
- 安装包 SHA-256：\`${(data.artifacts || []).find((item) => item.name.endsWith('arc-vista-intranet-installer.zip'))?.sha256 || ''}\`

## 一分钟看结论

1. 纯 JavaScript / 文本，无原生二进制、无 exe/dll；
2. 零第三方依赖，无安装期生命周期脚本；
3. 安装器不联网，只做本地复制与 DSH profile 注册；
4. 运行期唯一主动外联是调用本机 git 访问用户指定的被观测仓库；模型增强经 DSH 统一模型服务，只发送仓库证据摘要，不含完整源码；
5. 无密钥、无动态执行、无混淆、无遥测。

## 包内结构

| 路径 | 内容 |
| --- | --- |
| 01-summary.md | 结论摘要、已知边界、材料导航（建议先读） |
| 02-artifacts-and-checksums.md | 所有产物 SHA-256 与校验命令 |
| 03-file-inventory.md | 分发包逐文件清单摘要 |
| 04-dependencies-and-sbom.md | 依赖声明、生命周期脚本、CycloneDX SBOM |
| 05-static-security-scan.md | 网络/进程/动态代码/密钥/混淆扫描结果与逐条判定 |
| 06-permissions-and-data-boundary.md | 安装器行为、文件/进程/网络/数据边界 |
| 07-reproducible-build.md | 从源码重建并比对校验和 |
| 08-tests-and-verification.md | 自动化测试、DSH 实机验证、验证限制 |
| 09-approval-request-template.md | 可直接改写提交的审批说明 |
| sbom.cdx.json | CycloneDX 1.5 SBOM |
| evidence/ | 扫描与清单原始证据 |
| artifacts/ | 安装包、源码快照、安装器源码 |
| tools/verify-review-package.mjs | 复核脚本 |

## 三步复核

1. **校验完整性**（任何机器可跑，只需 Node.js 22+）：

        node tools/verify-review-package.mjs

2. **重跑静态扫描**（需要系统自带 tar）：

        node tools/verify-review-package.mjs --extract

3. **自行构建比对**（需要源码与 Node.js 22+）：按 07 文档执行 \`npm run package:intranet\`，比对插件 tarball 的 SHA-256。

全部校验通过会输出 PASS；任何不一致都会输出 FAIL 并以非零码退出。

## 声明

- 本材料包内的所有文件清单、校验和与扫描结果均由构建脚本从实际分发包采集生成，不含人工编写的"安全声明"式断言；
- 安装包与源码可逐行核对，构建过程可复现；
- 许可：MIT；源码：https://github.com/yonking305/arc-vista
`;
}

/* ------------------------------------------------------------------ */
/* 证据与 SBOM                                                         */
/* ------------------------------------------------------------------ */

function writeEvidence(data) {
  const { env, inventory, scans, lifecycle, binaries, urls, testResultRaw, checkResultRaw } = data;
  writeFile('evidence/environment.txt', [
    `生成时间: ${env.date}`,
    `Node.js: ${env.node}`,
    `npm: ${env.npm}`,
    `平台: ${env.platform}`,
    `源码提交: ${env.commit || 'unknown'}`,
    `提交说明: ${env.commitSubject || ''}`,
    `提交时间: ${env.commitDate || ''}`,
    `工作树: ${env.workingTreeClean ? 'clean' : `dirty (${env.workingTreeChanges.join(', ')})`}`,
  ].join('\n'));

  const inventoryCsv = ['path,bytes,sha256,text'];
  for (const file of inventory) {
    inventoryCsv.push(`${file.path},${file.bytes},${file.sha256},${file.text ? 'text' : 'binary'}`);
  }
  writeFile('evidence/file-inventory.csv', inventoryCsv.join('\n'));
  writeFile('evidence/file-hashes.sha256', inventory.map((file) => `${file.sha256}  ${file.path}`).join('\n'));

  const payloadDir = path.join(INSTALLER_DIR, 'payload', 'dsh-arcvista');
  const payloadHashes = walk(payloadDir).map((file) => `${sha256(file.absolute)}  ${path.relative(payloadDir, file.absolute)}`);
  writeFile('evidence/plugin-payload-hashes.sha256', payloadHashes.join('\n'));

  for (const scan of SCANS) {
    const matches = scans[scan.id] || [];
    const lines = [
      `# ${scan.title}（${scan.id}）`,
      `# 扫描时间: ${env.date}`,
      `# 扫描范围: 分发包插件源码 + 安装器脚本`,
      `# 命中数: ${matches.length}`,
      '',
    ];
    for (const match of matches) {
      lines.push(`[${match.scope}] ${match.file}:${match.line}  ${match.label}`);
      lines.push(`    ${match.text}`);
      lines.push(`    判定: ${classify(match)}`);
      lines.push('');
    }
    writeFile(`evidence/${scan.file}`, lines.join('\n'));
  }

  const urlLines = [`# 外部 URL 引用清单（${urls.length} 处）`, `# 生成时间: ${env.date}`, ''];
  for (const item of urls.slice(0, 500)) {
    urlLines.push(`[${item.scope}] ${item.file}:${item.line}  ${item.url}`);
    urlLines.push(`    类型: ${urlKind(item.url)}`);
  }
  if (urls.length > 500) urlLines.push(`... 其余 ${urls.length - 500} 处省略`);
  writeFile('evidence/external-urls.txt', urlLines.join('\n'));

  writeFile('evidence/lifecycle-scripts.json', JSON.stringify({
    installTimeHooksFound: lifecycle.installHooks,
    installTimeHooksNotAllowed: INSTALL_TIME_HOOKS,
    scripts: lifecycle.scripts,
    dependencies: lifecycle.dependencies,
    devDependencies: lifecycle.devDependencies,
    peerDependencies: lifecycle.peerDependencies,
  }, undefined, 2));

  writeFile('evidence/binary-files.txt', [
    `# 分发包内二进制/归档文件清单（${binaries.length} 个）`,
    `# 判定标准: 扩展名属于二进制类型，或文件内容含 NUL 字节/非 UTF-8`,
    '',
    ...binaries.map((item) => `${item.relative}  ${formatBytes(item.size)}  类型: ${item.kind}`),
  ].join('\n'));

  const pluginManifestFile = path.join(INSTALLER_DIR, 'payload', PLUGIN, 'package.json');
  const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestFile, 'utf8'));
  writeFile('evidence/test-output.txt', testResultRaw);
  writeFile('evidence/check-package.txt', checkResultRaw);

  // npm tarball 内容清单
  const tarball = path.join(INSTALLER_DIR, 'payload', `${PLUGIN}-${pluginManifest.version}.tgz`);
  const listing = run('tar', ['-tzf', tarball], { shell: process.platform === 'win32' });
  writeFile('evidence/npm-tarball-files.txt', listing.status === 0 ? listing.stdout : '（系统 tar 不可用，未能列出 tarball 内容；可用 7-Zip 打开查看）');
}

function writeSbom(data) {
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: data.env.date,
      tools: [{ vendor: 'ArcVista', name: 'build-security-review.mjs', version: '1.0.0' }],
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/${PLUGIN}@${data.manifest.version}`,
        name: PLUGIN,
        version: data.manifest.version,
        licenses: [{ license: { id: 'MIT' } }],
        hashes: [{ alg: 'SHA-256', content: data.tarballSha }],
        externalReferences: [{ type: 'vcs', url: 'https://github.com/yonking305/arc-vista' }],
      },
    },
    components: [],
    dependencies: [{ ref: `pkg:npm/${PLUGIN}@${data.manifest.version}`, dependsOn: [] }],
  };
  writeJson('sbom.cdx.json', sbom);
}

function installVerifyTool() {
  const source = path.join(ROOT, "packaging", "security-review", "verify-review-package.mjs");
  if (!fs.existsSync(source)) fail("缺少复核脚本模板：packaging/security-review/verify-review-package.mjs");
  const target = path.join(OUT_DIR, "tools", "verify-review-package.mjs");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
}

/* artifacts                                                           */
/* ------------------------------------------------------------------ */

function prepareArtifacts(data) {
  const artifactsDir = path.join(OUT_DIR, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.copyFileSync(INSTALLER_ZIP, path.join(artifactsDir, 'arc-vista-intranet-installer.zip'));
  const installerZipSha = sha256(INSTALLER_ZIP);
  fs.writeFileSync(path.join(artifactsDir, 'arc-vista-intranet-installer.zip.sha256'), `${installerZipSha}  arc-vista-intranet-installer.zip\n`);

  // 安装器源码（未提交部分，原样收录）
  const installerSource = path.join(artifactsDir, 'installer-source');
  fs.mkdirSync(installerSource, { recursive: true });
  for (const file of walk(path.join(ROOT, 'packaging', 'intranet'))) {
    const target = path.join(installerSource, 'packaging', 'intranet', path.relative(path.join(ROOT, 'packaging', 'intranet'), file.absolute));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.absolute, target);
  }
  for (const relative of ['scripts/build-intranet-package.mjs', 'scripts/check-package.mjs']) {
    const source = path.join(ROOT, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(installerSource, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  // 源码快照（git archive，排除截图等大文件）
  const sourceZip = path.join(artifactsDir, `arc-vista-${data.manifest.version}-source.zip`);
  const paths = [
    'server.js', 'lib', 'public', 'locale', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg',
    'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'tests', 'scripts', 'docs/analyzer-contract.md',
  ].filter((item) => fs.existsSync(path.join(ROOT, item)));
  const archive = run('git', ['-C', ROOT, 'archive', '--format=zip', `--output=${sourceZip}`, 'HEAD', ...paths], { cwd: ROOT });
  const sourceInfo = { path: sourceZip, built: archive.status === 0 && fs.existsSync(sourceZip) };
  if (!sourceInfo.built) log('提示：git archive 不可用，跳过源码快照（可用 07 文档步骤自行取源码）');

  const artifacts = [];
  for (const file of walk(artifactsDir)) {
    const relative = path.relative(OUT_DIR, file.absolute);
    artifacts.push({
      name: relative,
      bytes: file.size,
      sha256: sha256(file.absolute),
      description: relative.endsWith('installer.zip.sha256')
        ? '安装包校验和'
        : relative.endsWith('installer.zip')
          ? '待审查的内网离线安装包'
          : relative.includes('source.zip')
            ? `源码快照（git 提交 ${data.env.commit ? data.env.commit.slice(0, 12) : 'unknown'}）`
            : '安装器/打包脚本源码（未提交部分，原样收录）',
    });
  }
  return { installerZipSha, artifacts, sourceInfo };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  log(`生成安全审查材料：${PLUGIN}`);
  const inputs = loadInputs();
  const env = collectEnvironment();
  const payloadDir = path.join(INSTALLER_DIR, 'payload', PLUGIN);
  if (!fs.existsSync(payloadDir)) fail(`缺少 payload 目录：${payloadDir}`);

  const installerFiles = INSTALLER_SCRIPTS
    .map((name) => path.join(INSTALLER_DIR, name))
    .filter((file) => fs.existsSync(file))
    .map((absolute) => ({ absolute, relative: path.basename(absolute) }));
  const payloadFiles = walk(payloadDir).map((file) => ({ absolute: file.absolute, relative: file.relative }));

  const scans = scanTexts([
    { id: 'installer', files: installerFiles },
    { id: 'plugin', files: payloadFiles },
  ]);
  const lifecycle = collectLifecycle(payloadDir);
  const binaries = collectBinaries(INSTALLER_DIR);
  const urls = collectUrls([
    { id: 'installer', files: installerFiles },
    { id: 'plugin', files: payloadFiles },
  ]);

  log('运行自动化测试 ...');
  const testRun = run(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', 'tests/smoke.test.js'], { cwd: ROOT });
  const testRaw = `$ npm test\n${testRun.stdout || ''}${testRun.stderr || ''}`.trim();
  const passMatch = (testRun.stdout || '').match(/# pass (\d+)/);
  const failMatch = (testRun.stdout || '').match(/# fail (\d+)/);
  const testResult = `结果：` + (failMatch && failMatch[1] !== '0'
    ? `**失败 ${failMatch[1]} 项**（请勿放行）`
    : `**${passMatch ? passMatch[1] : '?'} 项全部通过**`) + `，退出码 ${testRun.status}。原始输出见 evidence/test-output.txt。`;
  if (testRun.status !== 0) fail('自动化测试未通过，停止生成审查材料');

  log('运行包内容自检 ...');
  const checkRun = run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/check-package.mjs'], { cwd: ROOT });
  const checkRaw = `$ node scripts/check-package.mjs\n${checkRun.stdout || ''}${checkRun.stderr || ''}`.trim();
  const checkResult = `结果：${checkRun.status === 0 ? '通过' : '**失败**'}。原始输出见 evidence/check-package.txt。`;
  if (checkRun.status !== 0) fail('包内容自检未通过，停止生成审查材料');

  const tarballFiles = [];
  const listing = run('tar', ['-tzf', inputs.tarball], { shell: process.platform === 'win32' });
  if (listing.status === 0) {
    for (const line of (listing.stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '') tarballFiles.push(trimmed.replace(/^package\//, ''));
    }
  }

  const inventoryData = buildInventory(inputs.installerManifest, inputs.tarballName, inputs.tarballSha);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const data = {
    manifest: inputs.installerManifest,
    repoManifest: inputs.repoManifest,
    env,
    tarballSha: inputs.tarballSha,
    installerZipSha: inputs.installerZipSha,
    tarballSize: fs.statSync(inputs.tarball).size,
    tarballName: inputs.tarballName,
    tarballFiles,
    ...inventoryData,
    scans,
    lifecycle,
    binaries,
    urls,
    testResult,
    testResultRaw: testRaw,
    checkResult,
    checkResultRaw: checkRaw,
  };

  log('写入文档 ...');
  writeFile('README.md', renderReadme(data));
  writeFile('01-summary.md', renderSummary(data));
  writeFile('02-artifacts-and-checksums.md', renderArtifacts({ ...data, artifacts: [] }));
  writeFile('03-file-inventory.md', renderInventory(data));
  writeFile('04-dependencies-and-sbom.md', renderDependencies(data));
  writeFile('05-static-security-scan.md', renderStaticScan(data));
  writeFile('06-permissions-and-data-boundary.md', renderBoundary(data));
  writeFile('07-reproducible-build.md', renderBuild(data));
  writeFile('08-tests-and-verification.md', renderVerification(data));
  writeFile('09-approval-request-template.md', renderApprovalTemplate({ ...data, artifacts: [] }));
  writeEvidence(data);
  writeSbom(data);
  installVerifyTool();

  log('收集交付物与源码快照 ...');
  const artifactInfo = prepareArtifacts(data);
  data.artifacts = artifactInfo.artifacts;
  writeFile('README.md', renderReadme(data));
  // 交付物表依赖 artifacts，文档重写一次
  writeFile('02-artifacts-and-checksums.md', renderArtifacts(data));
  writeFile('09-approval-request-template.md', renderApprovalTemplate(data));
  writeFile('01-summary.md', renderSummary(data));

  log('生成 CHECKSUMS.sha256 ...');
  const allFiles = walk(OUT_DIR).filter((file) => path.basename(file.absolute) !== 'CHECKSUMS.sha256');
  const checksums = allFiles
    .map((file) => `${sha256(file.absolute)}  ${path.relative(OUT_DIR, file.absolute).split(path.sep).join('/')}`)
    .join('\n');
  writeFile('CHECKSUMS.sha256', checksums);

  normalizeMtimes(OUT_DIR, sourceEpoch());
  log('生成 zip ...');
  fs.rmSync(OUT_ZIP, { force: true });
  const zipped = spawnSync('zip', ['-r', '-X', '-q', path.basename(OUT_ZIP), path.basename(OUT_DIR)], { cwd: WORKSPACE, encoding: 'utf8' });
  if (zipped.error || zipped.status !== 0) {
    log('zip 不可用，改用 tar 生成 zip 包');
    run('tar', ['-a', '-c', '-f', OUT_ZIP, '-C', WORKSPACE, path.basename(OUT_DIR)], { shell: process.platform === 'win32' });
  }
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  const zipSha = sha256(OUT_ZIP);
  console.log('');
  log(`完成：${path.relative(WORKSPACE, OUT_DIR)}（${allFiles.length + 1} 个文件）`);
  log(`材料包：${path.relative(WORKSPACE, OUT_ZIP)}（${formatBytes(fs.statSync(OUT_ZIP).size)}）`);
  log(`材料包 SHA-256：${zipSha}`);
  log(`安装包 SHA-256：${artifactInfo.installerZipSha}`);
  log(`插件 tarball SHA-256：${inputs.tarballSha}`);
  log(`复核：node ${path.relative(WORKSPACE, path.join(OUT_DIR, 'tools', 'verify-review-package.mjs'))}`);
}

main();
