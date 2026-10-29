/**
 * 覆盖率分析：优先读取真实插桩产物，找不到时才做显式标注的结构化估算。
 *
 * 支持的产物：
 * - coverage/coverage-summary.json（Istanbul）
 * - coverage/lcov.info（lcov）
 * - target/site/jacoco/jacoco.xml、build/reports/jacoco/test/jacocoTestReport.xml（JaCoCo）
 * - coverage.xml、target/site/cobertura/coverage.xml（Cobertura）
 * - .nyc_output/*.json（nyc）
 *
 * 所有文件读取都容错；产物缺失或损坏时退化为 estimated，不抛错、不输出绝对路径。
 */
import fs from 'node:fs';
import path from 'node:path';

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function round1(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function toInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

function pct(covered, total) {
  if (!Number.isFinite(covered) || !Number.isFinite(total) || total <= 0) return null;
  return round1((covered / total) * 100);
}

function metricsPct(metric) {
  if (!metric || typeof metric !== 'object') return null;
  if (Number.isFinite(metric.pct)) return round1(metric.pct);
  return pct(toInt(metric.covered), toInt(metric.total));
}

function normalizePath(repo, raw) {
  let value = String(raw || '').replace(/\\/g, '/').trim();
  if (!value) return '';
  const root = String(repo.root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  value = value.replace(/^\.\//, '');
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    const match = (repo.files || []).find((file) => value.endsWith(`/${file.path}`));
    if (match) return match.path;
    return `external/${path.posix.basename(value)}`;
  }
  return value;
}

function readText(repo, rel) {
  if (!rel) return null;
  const direct = repo.read ? repo.read(rel) : null;
  if (typeof direct === 'string') return direct;
  if (!repo.root) return null;
  try {
    const abs = path.join(repo.root, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 8_000_000) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function fileExists(repo, rel) {
  if (!rel) return false;
  if (repo.fileByPath?.has(rel)) return true;
  if (!repo.root) return false;
  try {
    return fs.statSync(path.join(repo.root, rel)).isFile();
  } catch {
    return false;
  }
}

function record(pathValue) {
  return {
    path: pathValue,
    lineCovered: 0,
    lineTotal: 0,
    branchCovered: 0,
    branchTotal: 0,
    statementCovered: 0,
    statementTotal: 0,
  };
}

function mergeCounts(target, source) {
  target.lineCovered += toInt(source.lineCovered);
  target.lineTotal += toInt(source.lineTotal);
  target.branchCovered += toInt(source.branchCovered);
  target.branchTotal += toInt(source.branchTotal);
  target.statementCovered += toInt(source.statementCovered);
  target.statementTotal += toInt(source.statementTotal);
}

function aggregate(list) {
  const total = record('');
  for (const item of list) mergeCounts(total, item);
  return {
    lineCovered: total.lineCovered,
    lineTotal: total.lineTotal,
    branchCovered: total.branchCovered,
    branchTotal: total.branchTotal,
    statementCovered: total.statementCovered,
    statementTotal: total.statementTotal,
  };
}

function summaryOf(totals) {
  return {
    line: pct(totals.lineCovered, totals.lineTotal),
    branch: pct(totals.branchCovered, totals.branchTotal),
    statement: pct(totals.statementCovered, totals.statementTotal),
    lineTotal: totals.lineTotal,
    lineCovered: totals.lineCovered,
  };
}

// ---------------------------------------------------------------------------
// 各格式解析器
// ---------------------------------------------------------------------------

function parseIstanbul(repo, relList) {
  const records = [];
  const system = record('');
  let valid = false;
  for (const rel of relList) {
    const text = readText(repo, rel);
    if (!text) continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object') continue;
    valid = true;
    const total = json.total;
    if (total) {
      system.lineCovered += toInt(total.lines?.covered);
      system.lineTotal += toInt(total.lines?.total);
      system.branchCovered += toInt(total.branches?.covered);
      system.branchTotal += toInt(total.branches?.total);
      system.statementCovered += toInt(total.statements?.covered);
      system.statementTotal += toInt(total.statements?.total);
    }
    for (const [key, value] of Object.entries(json)) {
      if (key === 'total' || !value || typeof value !== 'object') continue;
      const item = record(normalizePath(repo, key));
      item.lineCovered = toInt(value.lines?.covered);
      item.lineTotal = toInt(value.lines?.total);
      item.branchCovered = toInt(value.branches?.covered);
      item.branchTotal = toInt(value.branches?.total);
      item.statementCovered = toInt(value.statements?.covered);
      item.statementTotal = toInt(value.statements?.total);
      records.push(item);
    }
  }
  if (!valid) return null;
  const totals = system.lineTotal > 0 ? system : aggregate(records);
  return { records, totals, paths: relList };
}

function parseLcov(repo, relList) {
  const records = [];
  let current = null;
  let hasLineSummary = false;
  let hasBranchSummary = false;
  let daTotal = 0;
  let daCovered = 0;
  let brdaTotal = 0;
  let brdaCovered = 0;
  let valid = false;
  const finalize = () => {
    if (!current) return;
    if (!hasLineSummary && daTotal > 0) {
      current.lineTotal = daTotal;
      current.lineCovered = daCovered;
    }
    if (!hasBranchSummary && brdaTotal > 0) {
      current.branchTotal = brdaTotal;
      current.branchCovered = brdaCovered;
    }
    if (current.lineTotal > 0 || current.branchTotal > 0 || current.statementTotal > 0) {
      records.push(current);
      valid = true;
    }
    current = null;
    hasLineSummary = false;
    hasBranchSummary = false;
    daTotal = 0;
    daCovered = 0;
    brdaTotal = 0;
    brdaCovered = 0;
  };
  for (const rel of relList) {
    const text = readText(repo, rel);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const field = line.trim();
      if (field.startsWith('SF:')) {
        finalize();
        current = record(normalizePath(repo, field.slice(3)));
        continue;
      }
      if (!current) continue;
      if (field.startsWith('LF:')) {
        current.lineTotal = toInt(field.slice(3));
        hasLineSummary = true;
        valid = true;
      } else if (field.startsWith('LH:')) {
        current.lineCovered = toInt(field.slice(3));
      } else if (field.startsWith('BRF:')) {
        current.branchTotal = toInt(field.slice(4));
        hasBranchSummary = true;
      } else if (field.startsWith('BRH:')) {
        current.branchCovered = toInt(field.slice(4));
      } else if (field.startsWith('DA:')) {
        const [, hit] = field.slice(3).split(',');
        daTotal += 1;
        if (toInt(hit) > 0) daCovered += 1;
      } else if (field.startsWith('BRDA:')) {
        const parts = field.slice(5).split(',');
        const taken = parts[3];
        brdaTotal += 1;
        if (taken !== '-' && toInt(taken) > 0) brdaCovered += 1;
      } else if (field === 'end_of_record') {
        finalize();
      }
    }
  }
  finalize();
  if (!valid || records.length === 0) return null;
  return { records, totals: aggregate(records), paths: relList };
}

function countersIn(block, type) {
  const regex = /<counter\b([^>]*)\/?>/g;
  let match;
  let last = null;
  while ((match = regex.exec(block))) {
    const attrs = match[1];
    const typeMatch = attrs.match(/type="([^"]+)"/);
    if (!typeMatch || typeMatch[1] !== type) continue;
    const missed = toInt(attrs.match(/missed="(\d+)"/)?.[1]);
    const covered = toInt(attrs.match(/covered="(\d+)"/)?.[1]);
    last = { covered, total: covered + missed };
  }
  return last;
}

function parseJacoco(repo, relList) {
  const recordMap = new Map();
  let fallback = null;
  let valid = false;
  for (const rel of relList) {
    const text = readText(repo, rel);
    if (!text) continue;
    const packageRe = /<package\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
    let packageMatch;
    let sawSourceFile = false;
    while ((packageMatch = packageRe.exec(text))) {
      const packageName = packageMatch[1];
      const packageBlock = packageMatch[2];
      const sourceRe = /<sourcefile\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g;
      let sourceMatch;
      while ((sourceMatch = sourceRe.exec(packageBlock))) {
        const sourceName = sourceMatch[1];
        const block = sourceMatch[2];
        const lineCounter = countersIn(block, 'LINE');
        if (!lineCounter || lineCounter.total === 0) continue;
        const branchCounter = countersIn(block, 'BRANCH');
        const key = packageName ? `${packageName}/${sourceName}` : sourceName;
        const existing = recordMap.get(key) || record(key);
        existing.lineCovered += lineCounter.covered;
        existing.lineTotal += lineCounter.total;
        if (branchCounter) {
          existing.branchCovered += branchCounter.covered;
          existing.branchTotal += branchCounter.total;
        }
        recordMap.set(key, existing);
        sawSourceFile = true;
        valid = true;
      }
    }
    if (!sawSourceFile) {
      const allCounters = text.match(/<counter\b[^>]*type="LINE"[^>]*\/>/g) || [];
      const last = allCounters[allCounters.length - 1];
      if (last) {
        const counter = countersIn(last, 'LINE');
        if (counter && counter.total > 0) {
          fallback = counter;
          valid = true;
        }
      }
    }
  }
  const records = [...recordMap.values()];
  if (!valid) return null;
  const totals = records.length ? aggregate(records) : {
    lineCovered: fallback?.covered || 0,
    lineTotal: fallback?.total || 0,
    branchCovered: 0,
    branchTotal: 0,
    statementCovered: 0,
    statementTotal: 0,
  };
  return { records, totals, paths: relList };
}

function attrsOf(tag) {
  const attrs = {};
  const regex = /([\w:-]+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(tag))) attrs[match[1]] = match[2];
  return attrs;
}

function parseCobertura(repo, relList) {
  const recordMap = new Map();
  let rootLine = null;
  let rootBranch = null;
  for (const rel of relList) {
    const text = readText(repo, rel);
    if (!text) continue;
    const rootMatch = text.match(/<coverage\b([^>]*)>/);
    if (rootMatch) {
      const attrs = attrsOf(rootMatch[1]);
      if (attrs['line-rate'] !== undefined) rootLine = Number(attrs['line-rate']);
      if (attrs['branch-rate'] !== undefined) rootBranch = Number(attrs['branch-rate']);
    }
    const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
    let classMatch;
    while ((classMatch = classRe.exec(text))) {
      const attrs = attrsOf(classMatch[1]);
      const filename = attrs.filename;
      if (!filename) continue;
      const block = classMatch[2];
      const item = record(normalizePath(repo, filename));
      const lineRe = /<line\b([^>]*)>/g;
      let lineMatch;
      let hasLine = false;
      while ((lineMatch = lineRe.exec(block))) {
        const lineAttrs = attrsOf(lineMatch[1]);
        if (lineAttrs.hits === undefined) continue;
        hasLine = true;
        item.lineTotal += 1;
        if (toInt(lineAttrs.hits) > 0) item.lineCovered += 1;
        const condition = lineAttrs['condition-coverage'];
        if (condition) {
          const conditionMatch = condition.match(/\((\d+)\/(\d+)\)/);
          if (conditionMatch) {
            item.branchCovered += toInt(conditionMatch[1]);
            item.branchTotal += toInt(conditionMatch[2]);
          }
        }
      }
      if (!hasLine) {
        const lineRate = Number(attrs['line-rate']);
        if (!Number.isFinite(lineRate)) continue;
        // 没有逐行明细时，用类级比例占位，保证排序与加权仍有依据
        item.lineTotal = 1;
        item.lineCovered = lineRate > 0 ? 1 : 0;
      }
      recordMap.set(item.path, item);
    }
  }
  const records = [...recordMap.values()];
  if (records.length === 0) {
    if (rootLine === null) return null;
    return {
      records: [],
      totals: {
        lineCovered: Math.round(rootLine * 1000),
        lineTotal: 1000,
        branchCovered: rootBranch === null ? 0 : Math.round(rootBranch * 1000),
        branchTotal: rootBranch === null ? 0 : 1000,
        statementCovered: 0,
        statementTotal: 0,
      },
      paths: relList,
    };
  }
  const totals = aggregate(records);
  if (totals.lineTotal === 0 && rootLine !== null) {
    totals.lineCovered = Math.round(rootLine * 1000);
    totals.lineTotal = 1000;
  }
  if (totals.branchTotal === 0 && rootBranch !== null) {
    totals.branchCovered = Math.round(rootBranch * 1000);
    totals.branchTotal = 1000;
  }
  return { records, totals, paths: relList };
}

function parseNyc(repo, relList) {
  const recordMap = new Map();
  let valid = false;
  for (const rel of relList) {
    const text = readText(repo, rel);
    if (!text) continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object') continue;
    const entries = json.data && typeof json.data === 'object' && !json.path ? json.data : json;
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== 'object') continue;
      if (!value.statementMap && !value.s && !value.l && !value.b) continue;
      const target = record(normalizePath(repo, value.path || key));
      if (value.s && typeof value.s === 'object') {
        for (const count of Object.values(value.s)) {
          target.statementTotal += 1;
          if (toInt(count) > 0) target.statementCovered += 1;
        }
      }
      if (value.l && typeof value.l === 'object') {
        for (const count of Object.values(value.l)) {
          target.lineTotal += 1;
          if (toInt(count) > 0) target.lineCovered += 1;
        }
      } else if (target.statementTotal > 0) {
        target.lineTotal = target.statementTotal;
        target.lineCovered = target.statementCovered;
      }
      if (value.b && typeof value.b === 'object') {
        for (const counts of Object.values(value.b)) {
          if (Array.isArray(counts)) {
            for (const count of counts) {
              target.branchTotal += 1;
              if (toInt(count) > 0) target.branchCovered += 1;
            }
          } else if (typeof counts === 'number') {
            target.branchTotal += 1;
            if (counts > 0) target.branchCovered += 1;
          }
        }
      }
      if (target.lineTotal > 0 || target.statementTotal > 0) {
        recordMap.set(target.path, target);
        valid = true;
      }
    }
  }
  if (!valid) return null;
  const records = [...recordMap.values()];
  return { records, totals: aggregate(records), paths: relList };
}

// ---------------------------------------------------------------------------
// 产物发现
// ---------------------------------------------------------------------------

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function filesNamed(repo, name) {
  return unique((repo.files || []).filter((file) => file.name === name).map((file) => file.path)).sort();
}

function findArtifacts(repo) {
  const result = {
    istanbul: filesNamed(repo, 'coverage-summary.json'),
    lcov: filesNamed(repo, 'lcov.info'),
    jacoco: filesNamed(repo, 'jacoco.xml'),
    cobertura: filesNamed(repo, 'coverage.xml'),
    nyc: [],
  };

  const add = (bucket, rel) => {
    if (rel && fileExists(repo, rel) && !result[bucket].includes(rel)) result[bucket].push(rel);
  };
  add('istanbul', 'coverage/coverage-summary.json');
  add('lcov', 'coverage/lcov.info');
  add('jacoco', 'target/site/jacoco/jacoco.xml');
  add('cobertura', 'coverage.xml');
  add('cobertura', 'coverage/coverage.xml');
  add('cobertura', 'target/site/cobertura/coverage.xml');

  const projectDirs = unique((repo.projects || []).map((project) => project.dir))
    .filter((dir) => typeof dir === 'string')
    .sort();
  for (const dir of projectDirs) {
    const prefix = dir && dir !== '.' ? `${dir}/` : '';
    add('jacoco', `${prefix}target/site/jacoco/jacoco.xml`);
    add('jacoco', `${prefix}build/reports/jacoco/test/jacocoTestReport.xml`);
    add('cobertura', `${prefix}target/site/cobertura/coverage.xml`);
    add('istanbul', `${prefix}coverage/coverage-summary.json`);
    add('lcov', `${prefix}coverage/lcov.info`);
  }

  // .nyc_output 以点目录存在，walk 不收录，直接读目录
  if (repo.root) {
    try {
      const absDir = path.join(repo.root, '.nyc_output');
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && entry.name.endsWith('.json')) result.nyc.push(`.nyc_output/${entry.name}`);
      }
    } catch {
      /* no nyc output */
    }
  }
  result.nyc.push(...filesNamed(repo, 'coverage-final.json').filter((rel) => rel.includes('.nyc_output/')));
  for (const key of Object.keys(result)) result[key] = unique(result[key]).sort();
  return result;
}

// ---------------------------------------------------------------------------
// 测试与模块辅助
// ---------------------------------------------------------------------------

function countTestsInText(text, ext) {
  if (!text) return 0;
  let count = 0;
  if (['.java', '.kt'].includes(ext)) {
    count += (text.match(/@Test\b/g) || []).length;
  } else if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(ext)) {
    const matches = text.match(/(?:^|[^\w$.])(?:it|test)(?:\.(?:each|only|concurrent))?\s*\(/g) || [];
    count += matches.length;
  } else if (ext === '.py') {
    count += (text.match(/^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm) || []).length;
  } else if (ext === '.go') {
    count += (text.match(/^func\s+Test\w*\s*\(/gm) || []).length;
  } else if (ext === '.rb') {
    count += (text.match(/^\s*it\s+['"]/gm) || []).length;
  } else if (ext === '.cs') {
    count += (text.match(/\[(?:Fact|Test|Theory)\]/g) || []).length;
  } else if (ext === '.php') {
    count += (text.match(/function\s+test\w*\s*\(/g) || []).length;
  }
  return count;
}

function countTests(repo) {
  let testCount = 0;
  const testFiles = (repo.testFiles ? repo.testFiles() : (repo.files || []).filter((file) => file.kind === 'test'));
  for (const file of testFiles) {
    const text = readText(repo, file.path);
    if (!text) continue;
    testCount += countTestsInText(text, file.ext);
  }
  return { testCount, testFileCount: testFiles.length };
}

function detectTestFramework(repo) {
  const packageFiles = (repo.files || [])
    .filter((file) => file.name === 'package.json' && !file.path.includes('node_modules'))
    .sort((a, b) => a.path.localeCompare(b.path));
  const frameworks = [];
  for (const file of packageFiles) {
    let json = null;
    try {
      const text = readText(repo, file.path);
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json) continue;
    const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}), ...(json.peerDependencies || {}) };
    const checks = [
      ['vitest', 'Vitest'], ['jest', 'Jest'], ['mocha', 'Mocha'], ['ava', 'AVA'],
      ['jasmine', 'Jasmine'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'],
      ['@testing-library/react', 'Testing Library'],
    ];
    for (const [pkg, label] of checks) {
      if (deps[pkg] && !frameworks.includes(label)) frameworks.push(label);
    }
  }
  if (frameworks.length) return frameworks[0];

  const pomTexts = (repo.files || []).filter((file) => file.name === 'pom.xml').map((file) => readText(repo, file.path) || '');
  if (pomTexts.some((text) => /junit-jupiter|junit<\/artifactId>|testng/i.test(text))) return 'JUnit';
  if (pomTexts.some((text) => /spock/i.test(text))) return 'Spock';

  const pyTexts = (repo.files || [])
    .filter((file) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.cfg|tox\.ini|pipfile)$/i.test(file.path))
    .map((file) => readText(repo, file.path) || '');
  if (pyTexts.some((text) => /\bpytest\b/i.test(text))) return 'pytest';

  if ((repo.files || []).some((file) => file.name === 'go.mod')) return 'go test';
  if ((repo.files || []).some((file) => file.name === 'Gemfile')) return 'RSpec';
  if ((repo.files || []).some((file) => /(^|\/)(phpunit\.xml|phpunit\.xml\.dist)$/.test(file.path))) return 'PHPUnit';
  if ((repo.files || []).some((file) => file.name === 'pubspec.yaml')) return 'flutter test';
  return null;
}

function buildJavaPackageModules(repo, modulesInfo) {
  const byFile = modulesInfo?.byFile;
  const map = new Map();
  for (const file of repo.files || []) {
    if (!['.java', '.kt'].includes(file.ext) || file.kind !== 'source') continue;
    const text = readText(repo, file.path);
    if (!text) continue;
    const packageMatch = text.match(/^\s*package\s+([\w.]+)\s*;?/m);
    if (!packageMatch) continue;
    const moduleId = byFile?.get(file.path);
    if (!moduleId) continue;
    if (!map.has(packageMatch[1])) map.set(packageMatch[1], moduleId);
  }
  return map;
}

function moduleIdForPath(modulesInfo, rel) {
  if (!rel) return null;
  const byFile = modulesInfo?.byFile;
  if (byFile?.has(rel)) return byFile.get(rel);
  const modules = modulesInfo?.modules || [];
  const hit = modules
    .filter((module) => module.id !== '.' && rel.startsWith(`${module.id}/`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (hit) return hit.id;
  if (modules.some((module) => module.id === '.')) return '.';
  return null;
}

function modulesCoverage(repo, modulesInfo, records, javaPackageModules) {
  const byFile = modulesInfo?.byFile;
  const moduleMap = modulesInfo?.moduleMap;
  if (!moduleMap || records.length === 0) return new Map();
  const javaTails = new Map();
  for (const file of repo.files || []) {
    if (!['.java', '.kt'].includes(file.ext)) continue;
    const marker = file.path.indexOf('/src/main/java/');
    const testMarker = file.path.indexOf('/src/test/java/');
    const tail = marker !== -1
      ? file.path.slice(marker + '/src/main/java/'.length)
      : testMarker !== -1
        ? file.path.slice(testMarker + '/src/test/java/'.length)
        : file.path;
    javaTails.set(tail, file.path);
  }
  const buckets = new Map();
  for (const item of records) {
    let realPath = item.path;
    if (byFile && !byFile.has(realPath) && javaTails.has(realPath)) realPath = javaTails.get(realPath);
    if (byFile && !byFile.has(realPath)) {
      const match = (repo.files || []).find((file) => file.path.endsWith(`/${item.path}`));
      if (match) realPath = match.path;
    }
    let moduleId = moduleIdForPath(modulesInfo, realPath);
    if (!moduleId && item.path.includes('/')) {
      const packageName = item.path.slice(0, item.path.lastIndexOf('/')).replace(/\//g, '.');
      const parts = packageName.split('.');
      for (let i = parts.length; i >= 2; i -= 1) {
        const candidate = javaPackageModules.get(parts.slice(0, i).join('.'));
        if (candidate) {
          moduleId = candidate;
          break;
        }
      }
    }
    if (!moduleId) continue;
    if (!buckets.has(moduleId)) buckets.set(moduleId, record(''));
    mergeCounts(buckets.get(moduleId), item);
  }
  const result = new Map();
  for (const [moduleId, counts] of buckets) {
    const module = moduleMap.get(moduleId);
    if (!module) continue;
    result.set(moduleId, {
      path: module.path,
      label: module.label,
      line: pct(counts.lineCovered, counts.lineTotal),
      branch: pct(counts.branchCovered, counts.branchTotal),
      testFiles: module.testFiles,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主分析
// ---------------------------------------------------------------------------

/**
 * @param {object} repo scanRepo() 结果
 * @param {{modulesInfo?: object, graph?: object}} [ctx]
 * @returns {object} 契约 §4 定义的覆盖率结果
 */
export function analyzeCoverage(repo, ctx = {}) {
  const safeRepo = repo && Array.isArray(repo.files)
    ? repo
    : { files: [], root: '', read: () => null, fileByPath: new Map() };
  const modulesInfo = ctx?.modulesInfo;
  const totals = safeRepo.totals || {
    sourceFiles: 0, sourceLoc: 0, testFiles: 0, testLoc: 0,
  };
  const { testCount, testFileCount } = countTests(safeRepo);
  const testFiles = Number.isFinite(totals.testFiles) ? totals.testFiles : testFileCount;
  const sourceFiles = Number.isFinite(totals.sourceFiles) ? totals.sourceFiles : 0;
  const testToSourceRatio = sourceFiles > 0 ? round2(Math.min(1, testFiles / sourceFiles)) : 0;
  const testFramework = detectTestFramework(safeRepo);

  const artifacts = findArtifacts(safeRepo);
  const parsers = [
    { source: 'istanbul', files: artifacts.istanbul, parse: parseIstanbul },
    { source: 'jacoco', files: artifacts.jacoco, parse: parseJacoco },
    { source: 'lcov', files: artifacts.lcov, parse: parseLcov },
    { source: 'cobertura', files: artifacts.cobertura, parse: parseCobertura },
    { source: 'nyc', files: artifacts.nyc, parse: parseNyc },
  ];
  const parsedCandidates = [];
  const failedSources = [];
  for (const candidate of parsers) {
    if (!candidate.files.length) continue;
    let parsed = null;
    try {
      parsed = candidate.parse(safeRepo, candidate.files);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.totals.lineTotal === 0) {
      failedSources.push(candidate.source);
      continue;
    }
    parsedCandidates.push({
      source: candidate.source,
      files: candidate.files,
      records: parsed.records,
      totals: parsed.totals,
    });
  }
  // 多种产物并存时，选统计行数最多的那个，避免被一份陈旧的小报告带偏
  parsedCandidates.sort((a, b) => b.totals.lineTotal - a.totals.lineTotal
    || a.source.localeCompare(b.source));
  const chosen = parsedCandidates[0] || null;
  const measurable = Boolean(chosen && chosen.totals.lineTotal > 0);
  const summary = measurable ? summaryOf(chosen.totals) : null;

  const javaPackageModules = buildJavaPackageModules(safeRepo, modulesInfo);
  let moduleCoverage = new Map();
  if (measurable && chosen.records.length) {
    moduleCoverage = modulesCoverage(safeRepo, modulesInfo, chosen.records, javaPackageModules);
  }

  // 覆盖率产物按真实路径索引，供 files.tested 使用
  const coverageByPath = new Map();
  if (measurable) {
    for (const item of chosen.records) {
      let rel = item.path;
      if (!safeRepo.fileByPath?.has(rel)) {
        const match = (safeRepo.files || []).find((file) => file.path.endsWith(`/${rel}`));
        if (match) rel = match.path;
      }
      coverageByPath.set(rel, item);
    }
  }

  // 估算
  let line = measurable ? summary.line : null;
  let branch = measurable ? summary.branch : null;
  let statement = measurable ? summary.statement : null;
  const sourceLoc = toInt(totals.sourceLoc);
  const testLoc = toInt(totals.testLoc);
  const locRatio = sourceLoc > 0 ? testLoc / sourceLoc : 0;
  const fileRatio = sourceFiles > 0 ? testFiles / sourceFiles : 0;
  const casePerTestFile = testFiles > 0 ? testCount / testFiles : 0;
  const moduleList = modulesInfo?.modules || [];
  const modulesWithTests = moduleList.filter((module) => module.sourceFiles > 0 && module.testFiles > 0).length;
  const modulesWithSource = moduleList.filter((module) => module.sourceFiles > 0).length;
  const modulesCoveredRatio = modulesWithSource > 0 ? modulesWithTests / modulesWithSource : 0;
  const locScore = clampNumber(locRatio / 0.5, 0, 1);
  const fileScore = clampNumber(fileRatio / 0.35, 0, 1);
  const caseScore = clampNumber(casePerTestFile / 8, 0, 1);
  const moduleScore = clampNumber(modulesCoveredRatio, 0, 1);
  let estimatedLine = 5;
  if (testCount > 0 || testFiles > 0) {
    const raw = 0.38 * locScore + 0.28 * fileScore + 0.19 * caseScore + 0.15 * moduleScore;
    estimatedLine = Math.round(clampNumber(5 + 50 * raw, 5, 55));
  }
  if (!measurable) {
    line = estimatedLine;
    branch = null;
    statement = null;
  }

  // 未测试模块
  const untestedModules = [];
  for (const module of moduleList) {
    if (!module.sourceFiles || module.sourceFiles <= 0) continue;
    const covered = moduleCoverage.get(module.id);
    if (module.testFiles === 0) {
      untestedModules.push({
        path: module.path,
        label: module.label,
        reason: `模块内 ${module.sourceFiles} 个源码文件（${module.sourceLoc} 行）没有对应测试文件`,
        sourceLoc: module.sourceLoc,
      });
    } else if (measurable && covered && covered.line === 0) {
      untestedModules.push({
        path: module.path,
        label: module.label,
        reason: `覆盖率报告显示行覆盖为 0%，${module.sourceFiles} 个源码文件没有在测试中执行`,
        sourceLoc: module.sourceLoc,
      });
    }
  }
  untestedModules.sort((a, b) => b.sourceLoc - a.sourceLoc || a.path.localeCompare(b.path));
  const untested = untestedModules.slice(0, 12).map(({ path: modulePath, label, reason }) => ({
    path: modulePath,
    label,
    reason,
  }));

  // 供 diff 使用的文件清单
  const sourceFileList = (safeRepo.files || [])
    .filter((file) => file.kind === 'source')
    .sort((a, b) => a.path.localeCompare(b.path));
  const files = sourceFileList.slice(0, 800).map((file) => {
    let tested = false;
    if (measurable) {
      const covered = coverageByPath.get(file.path);
      tested = Boolean(covered && covered.lineCovered > 0);
    } else {
      const moduleId = moduleIdForPath(modulesInfo, file.path);
      const module = moduleId ? modulesInfo?.moduleMap?.get(moduleId) : null;
      tested = Boolean(module && module.testFiles > 0);
    }
    return { path: file.path, loc: file.loc || 0, tested };
  });

  const modules = measurable
    ? [...moduleCoverage.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((module) => ({
        path: module.path,
        label: module.label,
        line: module.line,
        branch: module.branch,
        testFiles: module.testFiles,
      }))
    : [];

  let note;
  if (measurable) {
    const parts = [];
    parts.push(`覆盖率来自 ${chosen.source}（${chosen.files.length} 个产物文件）`);
    parts.push(`行覆盖 ${summary.line ?? '未知'}%`);
    if (summary.branch !== null) parts.push(`分支覆盖 ${summary.branch}%`);
    if (summary.statement !== null) parts.push(`语句覆盖 ${summary.statement}%`);
    parts.push(`测试用例 ${testCount} 个、测试文件 ${testFiles} 个、测试/源文件比 ${testToSourceRatio}`);
    if (parsedCandidates.length > 1) {
      const others = parsedCandidates.filter((item) => item !== chosen).map((item) => item.source);
      parts.push(`仓库同时存在 ${unique(others).join('、')} 产物，本次采用统计行数最多的 ${chosen.source}`);
    }
    if (sourceFileList.length > 800) parts.push(`文件清单仅保留前 800 个源码文件（共 ${sourceFileList.length} 个）`);
    note = `${parts.join('；')}。`;
  } else {
    const failed = failedSources.length ? `发现 ${unique(failedSources).join('、')} 产物但无法解析；` : '';
    const moduleText = modulesWithSource > 0
      ? `${modulesWithTests}/${modulesWithSource} 个模块含测试`
      : '未检测到可识别模块';
    const totalText = `测试/源码 LOC 比 ${(locRatio * 100).toFixed(1)}%、测试文件/源文件比 ${(fileRatio * 100).toFixed(1)}%、平均每个测试文件 ${casePerTestFile.toFixed(1)} 个用例、${moduleText}`;
    note = `${failed}未找到可用的覆盖率产物（coverage-summary.json、lcov.info、jacoco.xml、cobertura coverage.xml、.nyc_output），按结构代理指标估算行覆盖约 ${line}%：${totalText}。该值是保守估算，不是插桩结果，只能用于判断覆盖明显偏低或完全缺失，不能当作真实覆盖率；files.tested 在估算路径下按“模块是否有测试文件”判定，只能粗筛新增未测试文件；建议在 CI 中生成 lcov 或 JaCoCo 报告后重新分析。`;
  }

  return {
    measurable,
    estimated: !measurable,
    source: measurable ? chosen.source : 'estimate',
    line,
    branch,
    statement,
    testCount,
    testFiles,
    sourceFiles,
    testToSourceRatio,
    modules,
    untestedModules: untested,
    testFramework,
    note,
    files,
  };
}
