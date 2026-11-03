#!/usr/bin/env node
/**
 * Build a source-code ZIP and an intranet-friendly .txt container.
 *
 * Output:
 *   dist/arc-vista-source-<version>.zip
 *   dist/arc-vista-source-<version>.zip.sha256
 *   dist/arc-vista-source-<version>.txt        (74 78 74 0A + ZIP)
 *   dist/arc-vista-source-<version>.txt.sha256
 *   dist/arc-vista-source-<version>.manifest.json
 *
 * The ZIP is produced by `git archive HEAD`, so it contains exactly the files
 * committed at HEAD (no node_modules, data, backups, dist, or local secrets).
 *
 * Usage:
 *   npm run package:source
 *   npm run package:source -- --skip-tests
 *   npm run package:source -- --out=/tmp/arc-vista-source
 *   npm run package:source -- --no-txt
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const outDir = path.resolve(ROOT, valueOf('--out') || 'dist');

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  delete env.VSCODE_DEBUG;
  return env;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: childEnv(),
  });
  if (result.status !== 0) {
    if (options.capture && result.stderr) console.error(result.stderr.trim());
    throw new Error(`${command} ${commandArgs.join(' ')} 执行失败（退出码 ${result.status}）`);
  }
  return String(result.stdout || '').trim();
}

function git(argsList) {
  return run('git', argsList, { capture: true });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function main() {
  process.chdir(ROOT);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-arcvista') fail(`包名应为 dsh-arcvista，实际为 ${pkg.name}`);
  if (git(['status', '--porcelain'])) {
    fail('工作区不干净；源码包必须从已提交的 HEAD 构建。请先提交或 stash。');
  }
  fs.mkdirSync(outDir, { recursive: true });

  if (!skipTests) {
    console.log('\n正在运行测试…');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test']);
  } else {
    console.log('\n跳过测试（--skip-tests）。');
  }

  console.log('\n正在检查可发布包…');
  run(process.execPath, ['scripts/check-package.mjs']);

  const version = pkg.version;
  const commit = git(['rev-parse', 'HEAD']);
  const commitShort = commit.slice(0, 7);
  const zipName = `arc-vista-source-${version}.zip`;
  const zipFile = path.join(outDir, zipName);

  console.log(`\n正在从 HEAD ${commitShort} 生成源码 ZIP…`);
  run('git', ['archive', '--format=zip', `--prefix=arc-vista/`, `--output=${zipFile}`, 'HEAD']);
  const zipHash = sha256(zipFile);
  fs.writeFileSync(`${zipFile}.sha256`, `${zipHash}  ${zipName}\n`, { mode: 0o600 });

  let txtInfo = null;
  if (!noTxt) {
    const txtName = `arc-vista-source-${version}.txt`;
    const txtFile = path.join(outDir, txtName);
    const prefix = Buffer.from('txt\n', 'ascii');
    fs.writeFileSync(txtFile, Buffer.concat([prefix, fs.readFileSync(zipFile)]), { mode: 0o644 });
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

  const manifest = {
    name: `${pkg.name}-source`,
    version,
    commit,
    commitShort,
    zip: {
      file: zipName,
      path: zipFile,
      bytes: fs.statSync(zipFile).size,
      sha256: zipHash,
    },
    ...(txtInfo ? { txt: txtInfo } : {}),
    createdAt: new Date().toISOString(),
    restoreCommand: txtInfo
      ? `node scripts/restore-tgz.mjs ${JSON.stringify(txtInfo.path)} ${JSON.stringify(zipFile)}`
      : null,
  };
  fs.writeFileSync(
    path.join(outDir, `arc-vista-source-${version}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  console.log(`\n✓ ${zipName}`);
  console.log(`  路径      ${zipFile}`);
  console.log(`  大小      ${(manifest.zip.bytes / 1024).toFixed(1)} kB`);
  console.log(`  SHA256    ${zipHash}`);
  if (txtInfo) {
    console.log(`  TXT 包    ${txtInfo.path}`);
    console.log(`  TXT 头    74 78 74 0a（"txt\\n"）`);
    console.log(`  TXT SHA   ${txtInfo.sha256}`);
    console.log('\n内网还原：');
    console.log(`  node scripts/restore-tgz.mjs ${JSON.stringify(txtInfo.path)} ${JSON.stringify(zipFile)}`);
  }
  console.log('\n查看内容：');
  console.log(`  unzip -l ${JSON.stringify(zipFile)} | head -40`);
}

try {
  main();
} catch (error) {
  fail(error.message);
}
