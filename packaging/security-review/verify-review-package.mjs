#!/usr/bin/env node
/**
 * 安全审查材料包复核脚本（只读）。
 *
 *   node tools/verify-review-package.mjs            重算全部文件校验和
 *   node tools/verify-review-package.mjs --extract  另外解出安装包并重跑静态扫描
 *
 * 退出码 0 表示全部通过；非 0 表示存在缺失、被改动或不一致。
 * 依赖：Node.js 22+；--extract 需要系统自带 tar（Windows 10+ / macOS / Linux 均自带）。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const useExtract = process.argv.includes('--extract');
const problems = [];
const ok = (text) => console.log(`  [OK] ${text}`);
const bad = (text) => {
  problems.push(text);
  console.log(`  [X]  ${text}`);
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(dir);
  return files;
}

/* 1. 全量校验和 */
const checksumsFile = path.join(ROOT, 'CHECKSUMS.sha256');
if (!fs.existsSync(checksumsFile)) {
  bad('CHECKSUMS.sha256 缺失');
} else {
  const lines = fs.readFileSync(checksumsFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
  let checked = 0;
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) {
      bad(`CHECKSUMS.sha256 行格式异常：${line}`);
      continue;
    }
    const file = path.join(ROOT, match[2].split('/').join(path.sep));
    if (!fs.existsSync(file)) {
      bad(`文件缺失：${match[2]}`);
      continue;
    }
    if (sha256(file) !== match[1]) {
      bad(`校验和不一致：${match[2]}`);
      continue;
    }
    checked += 1;
  }
  if (problems.length === 0) ok(`CHECKSUMS.sha256 全部通过（${checked} 个文件）`);
}

/* 2. 待审查安装包 */
const artifactZip = path.join(ROOT, 'artifacts', 'arc-vista-intranet-installer.zip');
if (!fs.existsSync(artifactZip)) {
  bad('artifacts/arc-vista-intranet-installer.zip 缺失');
} else {
  ok(`待审查安装包存在，SHA-256=${sha256(artifactZip)}`);
}

/* 3. 可选：解包并重跑静态扫描 */
if (useExtract) {
  if (!fs.existsSync(artifactZip)) {
    bad('无法解包：安装包不存在');
  } else {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcvista-review-'));
    const extracted = spawnSync('tar', ['-xf', artifactZip, '-C', temp], { encoding: 'utf8' });
    if (extracted.error || extracted.status !== 0) {
      bad(`解包失败：需要系统 tar（Windows 10+ / macOS / Linux 自带）。${extracted.stderr || ''}`);
    } else {
      const root = path.join(temp, 'arc-vista-intranet-installer');
      const manifestFile = path.join(root, 'manifest.json');
      if (!fs.existsSync(manifestFile)) {
        bad('安装包内缺少 manifest.json');
      } else {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const tarball = path.join(root, 'payload', `dsh-arcvista-${manifest.version}.tgz`);
        if (!fs.existsSync(tarball)) bad('安装包内缺少插件 tarball');
        else if (sha256(tarball) !== manifest.sha256) bad('安装包内 tarball 校验和与 manifest.json 不一致');
        else ok('安装包内插件 tarball 校验和与 manifest.json 一致');

        const forbidden = /\.(exe|dll|so|dylib|node|wasm)$/i;
        const badFiles = walk(root).filter((file) => forbidden.test(file));
        if (badFiles.length > 0) {
          bad(`安装包内发现原生可执行文件：${badFiles.map((file) => path.relative(root, file)).join(', ')}`);
        } else {
          ok('安装包内没有 .exe/.dll/.so/.node/.wasm 原生可执行文件');
        }

        const patterns = [
          [/\beval\s*\(/, 'eval()'],
          [/new\s+Function\s*\(/, 'new Function()'],
          [/sk-[A-Za-z0-9]{20,}/, '疑似密钥'],
          [/BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY/, '私钥块'],
        ];
        const findings = [];
        for (const file of walk(root)) {
          if (!/\.(js|mjs|cjs|json|yml|yaml|html|css|md|txt|sh|bat|ps1|command)$/i.test(file)) continue;
          const text = fs.readFileSync(file, 'utf8');
          text.split('\n').forEach((line, index) => {
            for (const [pattern, label] of patterns) {
              if (pattern.test(line)) findings.push(`${path.relative(root, file)}:${index + 1} ${label}`);
            }
          });
        }
        if (findings.length > 0) {
          bad(`静态扫描发现需要人工确认的命中：${findings.slice(0, 10).join('; ')}`);
        } else {
          ok('静态扫描未命中动态执行/密钥特征');
        }
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

console.log('');
if (problems.length === 0) {
  console.log('PASS：材料完整且校验通过。');
  process.exit(0);
}
console.log(`FAIL：发现 ${problems.length} 个问题，请对照 02 文档排查。`);
process.exit(1);
