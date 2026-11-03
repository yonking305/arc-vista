#!/usr/bin/env node
/**
 * Restore a package-tgz.mjs .txt container back to a raw .tgz.
 *
 * The intranet-friendly .txt file starts with the exact bytes 74 78 74 0A
 * ("txt\n"), followed by the original tarball. This script verifies that
 * prefix and writes the original tarball without re-encoding it.
 *
 * Usage:
 *   node scripts/restore-tgz.mjs dist/dsh-arcvista-0.3.1.txt
 *   node scripts/restore-tgz.mjs dist/dsh-arcvista-0.3.1.txt /tmp/out.tgz
 */
import fs from 'node:fs';
import path from 'node:path';

const source = process.argv[2];
const output = process.argv[3];
if (!source) {
  console.error('用法：node scripts/restore-tgz.mjs <文件.txt> [输出.tgz]');
  process.exit(1);
}
const sourcePath = path.resolve(source);
if (!fs.existsSync(sourcePath)) {
  console.error(`文件不存在：${sourcePath}`);
  process.exit(1);
}
const payload = fs.readFileSync(sourcePath);
const prefix = Buffer.from('txt\n', 'ascii');
if (payload.length < prefix.length || !payload.subarray(0, prefix.length).equals(prefix)) {
  console.error(`文件头不是 74 78 74 0A：${sourcePath}`);
  process.exit(1);
}
const target = path.resolve(
  output || (/\.txt$/i.test(sourcePath) ? sourcePath.replace(/\.txt$/i, '.tgz') : `${sourcePath}.tgz`),
);
const tarball = payload.subarray(prefix.length);
fs.writeFileSync(target, tarball, { mode: 0o644 });
console.log(`✓ 已还原 ${target}`);
console.log(`  大小 ${tarball.length} bytes`);
