#!/usr/bin/env node
/**
 * One-command release for dsh-arcvista.
 *
 * What it does:
 *   1. checks the worktree, branch, npm login and package sanity
 *   2. calculates the next version (patch by default)
 *   3. runs tests, bumps package.json, writes a CHANGELOG entry
 *   4. commits and tags the release, pushes it to GitHub
 *   5. publishes to npm and waits until the exact version is visible
 *
 * Usage:
 *   node scripts/release.mjs                 # patch bump, asks for confirmation
 *   node scripts/release.mjs --minor
 *   node scripts/release.mjs --major
 *   node scripts/release.mjs --version 0.2.0
 *   node scripts/release.mjs --dry-run
 *   node scripts/release.mjs --yes            # no prompt (CI)
 *   node scripts/release.mjs --skip-tests
 *   node scripts/release.mjs --no-push
 *   node scripts/release.mjs --no-wait
 *   node scripts/release.mjs --otp 123456
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GIT = 'git';
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const valueOf = (name) => {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const has = (name) => flags.has(name) || argv.includes(name);

const dryRun = has('--dry-run');
const yes = has('--yes') || has('-y');
const skipTests = has('--skip-tests');
const noPush = has('--no-push');
const noWait = has('--no-wait');
const explicitVersion = valueOf('--version');
const note = valueOf('--note') || '';
const otp = valueOf('--otp');
const bumpKind = has('--major') ? 'major' : has('--minor') ? 'minor' : 'patch';
const waitMs = Number(valueOf('--wait') || 8 * 60 * 1000);

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  if (!options.allowFailure && result.status !== 0) {
    if (options.capture && result.stderr) console.error(result.stderr.trim());
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function capture(command, args) {
  return run(command, args, { capture: true, allowFailure: true });
}

function parseStable(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function compareVersion(a, b) {
  const left = parseStable(a);
  const right = parseStable(b);
  if (!left || !right) return 0;
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function bumpVersion(base, kind) {
  if (kind === 'major') return { major: base.major + 1, minor: 0, patch: 0 };
  if (kind === 'minor') return { major: base.major, minor: base.minor + 1, patch: 0 };
  return { major: base.major, minor: base.minor, patch: base.patch + 1 };
}

async function main() {
  process.chdir(ROOT);
  const packageFile = path.join(ROOT, 'package.json');
  const changelogFile = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(packageFile)) fail('package.json not found; run this from the ArcVista repository.');

  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (pkg.name !== 'dsh-arcvista') fail(`expected package name dsh-arcvista, got ${pkg.name}`);

  const branch = capture(GIT, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
  const remote = capture(GIT, ['remote', 'get-url', 'origin']).stdout;
  const dirty = capture(GIT, ['status', '--porcelain']).stdout;

  console.log('\nArcVista release');
  console.log(`  package   ${pkg.name}`);
  console.log(`  version   ${pkg.version}`);
  console.log(`  branch    ${branch}`);
  console.log(`  remote    ${remote || '(none)'}`);
  console.log(`  bump      ${explicitVersion ? `explicit ${explicitVersion}` : bumpKind}`);

  if (!dryRun) {
    if (branch !== 'main') fail(`release must run on main (currently ${branch})`);
    if (!/github\.com[/:]yonking305\/arc-vista(?:\.git)?$/i.test(remote)) {
      fail('origin must point to https://github.com/yonking305/arc-vista.git');
    }
    if (dirty) {
      fail(
        'working tree is not clean. Commit or stash these changes first:\n\n' +
          dirty
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
      );
    }
  }

  const latestResult = capture(NPM, ['view', `${pkg.name}@latest`, 'version', '--json']);
  const npmLatest = latestResult.status === 0 ? latestResult.stdout.replace(/^"|"$/g, '') : '';
  const current = parseStable(pkg.version);
  if (!current) fail(`invalid current version: ${pkg.version}`);
  const latest = parseStable(npmLatest);

  let next;
  if (explicitVersion) {
    next = parseStable(explicitVersion);
    if (!next) fail(`invalid --version: ${explicitVersion}`);
    if (compareVersion(formatVersion(next), pkg.version) <= 0) {
      fail(`new version ${explicitVersion} must be greater than current ${pkg.version}`);
    }
    if (latest && compareVersion(formatVersion(next), npmLatest) <= 0) {
      fail(`new version ${explicitVersion} must be greater than npm latest ${npmLatest}`);
    }
  } else {
    const base = latest && compareVersion(npmLatest, pkg.version) > 0 ? latest : current;
    next = bumpVersion(base, bumpKind);
  }
  const nextVersion = formatVersion(next);
  console.log(`  next      ${nextVersion}${npmLatest ? ` (npm latest ${npmLatest})` : ''}`);

  if (!dryRun) {
    if (capture(GIT, ['tag', '-l', `v${nextVersion}`]).stdout) {
      fail(`git tag v${nextVersion} already exists`);
    }
    const whoami = capture(NPM, ['whoami']);
    if (whoami.status !== 0) {
      fail(
        'npm is not authenticated. Run `npm login --auth-type=web`, or configure a granular token with publish permission.',
      );
    }
    console.log(`  npm user  ${whoami.stdout}`);
  }

  if (!skipTests) {
    console.log('\nRunning tests...');
    run(NPM, ['test']);
    console.log('\nChecking publishable package...');
    run(process.execPath, ['scripts/check-package.mjs']);
  } else {
    console.log('\nSkipping tests and package check (--skip-tests).');
  }

  if (dryRun) {
    console.log('\nDry run complete. No files, commits, tags or registry entries were changed.');
    return;
  }

  if (!yes) {
    if (!process.stdin.isTTY) fail('confirmation needs a TTY; rerun with --yes for non-interactive release.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nPublish ${pkg.name}@${nextVersion}? Type "yes" to continue: `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Release cancelled. No changes made.');
      return;
    }
  }

  // Bump package.json and add a CHANGELOG entry.
  pkg.version = nextVersion;
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : '# Changelog\n\n';
  if (!changelog.includes(`## ${nextVersion}`)) {
    const entry = `## ${nextVersion} - ${new Date().toISOString().slice(0, 10)}\n\n- ${note || `Release ${nextVersion}.`}\n\n`;
    const marker = changelog.startsWith('# Changelog') ? changelog.indexOf('\n\n') + 2 : 0;
    fs.writeFileSync(changelogFile, changelog.slice(0, marker) + entry + changelog.slice(marker));
  }

  // Only release metadata is committed; unrelated working tree files are never
  // swept into the release commit.
  console.log('\nCommitting release metadata...');
  run(GIT, ['add', '--', 'package.json', 'CHANGELOG.md']);
  run(GIT, ['commit', '-m', `chore: release v${nextVersion}`]);
  run(GIT, ['tag', '-a', `v${nextVersion}`, '-m', `ArcVista ${nextVersion}`]);

  if (!noPush) {
    console.log('\nPushing release commit and tag to GitHub...');
    run(GIT, ['push', 'origin', 'main']);
    run(GIT, ['push', 'origin', `v${nextVersion}`]);
  } else {
    console.log('\nSkipping git push (--no-push).');
  }

  console.log(`\nPublishing ${pkg.name}@${nextVersion} to npm...`);
  const publishArgs = ['publish', '--access', 'public'];
  if (otp) publishArgs.push(`--otp=${otp}`);
  try {
    run(NPM, publishArgs);
  } catch (error) {
    fail(
      `${error.message}\n\nThe release commit/tag is already on GitHub. Fix the npm error and retry:\n  cd ${ROOT}\n  ${NPM} publish --access public${otp ? ' --otp=<code>' : ''}`,
    );
  }

  if (!noWait) {
    process.stdout.write('\nWaiting for npm registry to expose the version');
    const deadline = Date.now() + waitMs;
    let visible = false;
    while (Date.now() < deadline) {
      const check = capture(NPM, ['view', `${pkg.name}@${nextVersion}`, 'version', '--json']);
      if (check.status === 0 && check.stdout.includes(nextVersion)) {
        visible = true;
        break;
      }
      process.stdout.write('.');
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    process.stdout.write('\n');
    if (!visible) {
      console.log('npm accepted the publish, but the version is still processing. It should appear shortly.');
    }
  }

  console.log(`\n✓ Released ${pkg.name}@${nextVersion}`);
  console.log(`  GitHub: https://github.com/yonking305/arc-vista/releases/tag/v${nextVersion}`);
  console.log(`  npm:    https://www.npmjs.com/package/${pkg.name}/v/${nextVersion}`);
  console.log(`  Install: dsh plugin --profile web add ${pkg.name}@${nextVersion}`);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});
