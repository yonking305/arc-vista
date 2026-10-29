#!/usr/bin/env node
/** Read-only release guard: the package must stay self-contained and data-free. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const errors = [];

if (manifest.name !== 'dsh-arcvista') errors.push('package name must be dsh-arcvista');
if (manifest.private === true) errors.push('private must be false for publishing');
if (!manifest.license) errors.push('license is required');
if (!manifest.dsh?.bundle?.patch) errors.push('dsh.bundle.patch is required');
if (!manifest.dsh?.client?.platform) errors.push('dsh.client.platform is required');
if (!manifest.dsh?.compatibility?.dshReleases) errors.push('dsh.compatibility.dshReleases is required');

const patch = fs.readFileSync(path.join(root, manifest.dsh.bundle.patch), 'utf8');
if (!/name:\s*'dsh-arcvista'/.test(patch)) errors.push('bundle patch must insert dsh-arcvista');
if (!/id:\s*arcvista/.test(patch)) errors.push('bundle patch must use the arcvista entry id');

const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
if (!client.includes("id: 'dsh-arcvista'")) errors.push("client.js must register id 'dsh-arcvista'");

for (const forbidden of ['data', 'backups', 'logs', 'node_modules']) {
  const entries = manifest.files || [];
  if (entries.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) {
    errors.push(`files must not include ${forbidden}/`);
  }
}

const secretPattern = /(sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)/;
function scan(dir, depth = 0) {
  if (depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'data' || entry.name === 'backups' || entry.name === 'logs' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(target, depth + 1);
      continue;
    }
    if (!/\.(js|mjs|json|md|yml|yaml|css|html|svg)$/.test(entry.name)) continue;
    const text = fs.readFileSync(target, 'utf8');
    if (secretPattern.test(text)) errors.push(`possible secret in ${path.relative(root, target)}`);
    if (text.includes('@local/') && !target.endsWith('scripts/check-package.mjs')) {
      errors.push(`private package reference in ${path.relative(root, target)}`);
    }
  }
}
scan(root);

if (errors.length) {
  console.error('package check failed:');
  for (const error of errors) console.error(' -', error);
  process.exit(1);
}
console.log('package check passed: dsh-arcvista is self-contained, data-free and publishable.');
