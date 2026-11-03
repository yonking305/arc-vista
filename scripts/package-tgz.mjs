#!/usr/bin/env node
/**
 * Build a distributable DSH plugin tarball with npm pack.
 *
 * Output:
 *   dist/dsh-arcvista-<version>.tgz
 *   dist/dsh-arcvista-<version>.tgz.sha256
 *   dist/dsh-arcvista-<version>.manifest.json
 *
 * Usage:
 *   node scripts/package-tgz.mjs
 *   node scripts/package-tgz.mjs --skip-tests
 *   node scripts/package-tgz.mjs --out=/tmp/arcvista-dist
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const skipTests = has('--skip-tests');
const noTxt = has('--no-txt');
const outArg = valueOf('--out');
const outDir = path.resolve(ROOT, outArg || 'dist');

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  delete env.VSCODE_DEBUG;
  return env;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    env: childEnv(),
  });
  if (result.status !== 0) {
    if (options.capture && result.stdout) console.error(result.stdout.trim());
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return String(result.stdout || '').trim();
}

function git(argsList) {
  try {
    return run('git', argsList, { capture: true });
  } catch {
    return '';
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function main() {
  process.chdir(ROOT);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-arcvista') fail(`expected dsh-arcvista, got ${manifest.name}`);
  fs.mkdirSync(outDir, { recursive: true });

  if (!skipTests) {
    console.log('\n正在运行测试…');
    run(NPM, ['test']);
  } else {
    console.log('\n跳过测试（--skip-tests）。');
  }

  console.log('\n正在检查可发布包…');
  run(process.execPath, ['scripts/check-package.mjs']);

  console.log('\n正在打包 TGZ…');
  const packed = run(NPM, ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir], { capture: true });
  let result;
  try {
    const parsed = JSON.parse(packed);
    result = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    fail(`could not parse npm pack output:\n${packed}`);
  }
  const filename = String(result?.filename || '').trim();
  if (!filename) fail('npm pack did not report a filename');
  const tarball = path.isAbsolute(filename) ? filename : path.join(outDir, path.basename(filename));
  if (!fs.existsSync(tarball)) fail(`npm pack reported a missing file: ${tarball}`);

  const hash = sha256(tarball);
  const bytes = fs.statSync(tarball).size;
  const base = path.basename(tarball);
  const shaFile = `${tarball}.sha256`;
  fs.writeFileSync(shaFile, `${hash}  ${base}\n`, { mode: 0o600 });

  // Intranet transfer often requires a .txt container with the literal bytes
  // "txt\n" (74 78 74 0A) in front of the tarball. Keep the raw .tgz too.
  let txtInfo = null;
  if (!noTxt) {
    const txtName = `${path.basename(tarball, '.tgz')}.txt`;
    const txtFile = path.join(outDir, txtName);
    const prefix = Buffer.from('txt\n', 'ascii');
    fs.writeFileSync(txtFile, Buffer.concat([prefix, fs.readFileSync(tarball)]), { mode: 0o644 });
    const txtHash = sha256(txtFile);
    fs.writeFileSync(`${txtFile}.sha256`, `${txtHash}  ${txtName}\n`, { mode: 0o600 });
    txtInfo = {
      file: txtName,
      path: txtFile,
      bytes: fs.statSync(txtFile).size,
      sha256: txtHash,
      prefixHex: '74 78 74 0a',
    };
  }

  const info = {
    name: manifest.name,
    version: manifest.version,
    file: base,
    path: tarball,
    bytes,
    sha256: hash,
    createdAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain'])),
    installCommand: `dsh plugin --profile web add ${tarball}`,
    ...(txtInfo ? { txt: txtInfo } : {}),
  };
  const manifestFile = `${tarball.replace(/\.tgz$/, '')}.manifest.json`;
  fs.writeFileSync(manifestFile, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });

  console.log(`\n✓ ${base}`);
  console.log(`  路径      ${tarball}`);
  console.log(`  大小      ${(bytes / 1024).toFixed(1)} kB`);
  console.log(`  SHA256    ${hash}`);
  if (info.dirty) console.log('  警告      工作区不干净，tarball 会包含未提交的文件');
  if (txtInfo) {
    console.log(`  TXT 包    ${txtInfo.path}`);
    console.log(`  TXT 头    74 78 74 0a（"txt\\n"）`);
    console.log(`  TXT SHA   ${txtInfo.sha256}`);
  }
  console.log('\n本地安装命令：');
  console.log(`  ${info.installCommand}`);
  if (txtInfo) {
    console.log('\n内网还原 TXT 包：');
    console.log(`  node scripts/restore-tgz.mjs ${JSON.stringify(txtInfo.path)}`);
  }
  console.log('\n查看内容：');
  console.log(`  tar -tzf ${JSON.stringify(tarball)} | head -30`);
}

try {
  main();
} catch (error) {
  fail(error.message);
}
