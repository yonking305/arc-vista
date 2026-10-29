import { clamp, round } from './util.js';

/**
 * Snapshot diff engine (contract §7).
 *
 * Pure and defensive: every field of an old or partial snapshot is optional.
 * The output is deterministic, JSON serializable and free of absolute paths.
 * `verdict.score` measures quality movement (positive = better) while
 * `riskScore` measures the amount of newly introduced risk (higher = worse).
 */

const RISK_WEIGHTS = { high: 35, medium: 18, low: 6 };
const LEVEL_RANK = { high: 3, medium: 2, low: 1 };
const STATUS_RANK = { enforced: 2, partial: 1, missing: 0 };
const SEVERITY_LABEL = { critical: '致命', high: '高', medium: '中', low: '低' };
const STATUS_LABEL = { enforced: '已强制执行', partial: '部分覆盖', missing: '缺失' };
const GUARD_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const GUARD_STATUSES = new Set(['enforced', 'partial', 'missing']);

/* ------------------------------------------------------------------ */
/* generic helpers                                                     */
/* ------------------------------------------------------------------ */

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const obj = (value) => (isObj(value) ? value : {});
const arr = (value) => (Array.isArray(value) ? value : []);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function numOrNull(value) {
  if (finite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function firstString(...values) {
  for (const value of values) {
    const found = str(value);
    if (found) return found;
  }
  return null;
}

function cmpStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function safeId(value, fallback = 'item') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return slug || fallback;
}

function listText(items, max = 5) {
  const list = items.map((item) => String(item)).filter(Boolean);
  const shown = list.slice(0, max).join('、');
  return list.length > max ? `${shown} 等 ${list.length} 项` : shown;
}

function sanitizeEvidence(value) {
  const out = [];
  for (const item of arr(value)) {
    if (out.length >= 4) break;
    if (typeof item === 'string' && item.trim()) {
      out.push({ label: item.trim().slice(0, 160) });
      continue;
    }
    if (!isObj(item)) continue;
    const filePath = str(item.path);
    const label = str(item.label) || str(item.name);
    if (filePath && label) out.push({ path: filePath, label: label.slice(0, 160) });
    else if (filePath) out.push({ path: filePath });
    else if (label) out.push({ label: label.slice(0, 160) });
  }
  return out;
}

function canonical(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type !== 'object') return 'null';
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
  const keys = Object.keys(value).sort(cmpStr);
  const parts = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonical(value[key], seen)}`);
  }
  return `{${parts.join(',')}}`;
}

function comparableAnalysis(analysis) {
  if (!isObj(analysis)) return {};
  if (!isObj(analysis.meta)) return analysis;
  const meta = { ...analysis.meta };
  delete meta.analyzedAt;
  return { ...analysis, meta };
}

/* ------------------------------------------------------------------ */
/* snapshot normalization                                              */
/* ------------------------------------------------------------------ */

function looksLikeAnalysis(value) {
  if (!isObj(value)) return false;
  return [
    'meta',
    'security',
    'coverage',
    'complexity',
    'architecture',
    'deps',
    'knowledge',
    'risks',
    'fileIndex',
  ].some((key) => key in value);
}

function normalizeSnapshot(input) {
  const raw = isObj(input) ? input : {};
  let analysis = {};
  if (isObj(raw.analysis)) analysis = raw.analysis;
  else if (looksLikeAnalysis(raw)) analysis = raw;

  const meta = obj(analysis.meta);
  const commitValue = meta.commit;
  const commitObj = isObj(commitValue) ? commitValue : {};

  return {
    id: firstString(raw.id, raw.snapshotId, raw.snapshot_id),
    branch: firstString(raw.branch, meta.branch),
    commit: firstString(raw.commit_sha, raw.commit_sha_short, raw.commit, commitObj.sha),
    analyzedAt: firstString(raw.analyzed_at, raw.analyzedAt, meta.analyzedAt),
    analysis,
  };
}

/* ------------------------------------------------------------------ */
/* extraction                                                          */
/* ------------------------------------------------------------------ */

function normalizeGuard(raw) {
  if (!isObj(raw)) return null;
  const id = firstString(raw.id, raw.name);
  if (!id) return null;
  const severity = str(raw.severity)?.toLowerCase();
  const status = str(raw.status)?.toLowerCase();
  const rules = arr(raw.rules)
    .filter((rule) => typeof rule === 'string' && rule.trim())
    .map((rule) => rule.trim());
  const ruleCount = numOrNull(raw.ruleCount);
  return {
    id,
    name: firstString(raw.name, raw.id),
    category: firstString(raw.category) || '未分类',
    severity: GUARD_SEVERITIES.has(severity) ? severity : 'medium',
    status: GUARD_STATUSES.has(status) ? status : 'missing',
    ruleCount: ruleCount === null ? rules.length : ruleCount,
    rules,
    evidence: sanitizeEvidence(raw.evidence),
  };
}

function extractSecurity(analysis) {
  const raw = analysis.security;
  const has = isObj(raw);
  const sec = obj(raw);
  const guards = new Map();
  for (const item of arr(sec.guards)) {
    const guard = normalizeGuard(item);
    if (!guard || guards.has(guard.id)) continue;
    guards.set(guard.id, guard);
  }

  const ruleSets = new Map();
  for (const item of arr(sec.ruleSets)) {
    if (!isObj(item)) continue;
    const id = firstString(item.id, item.name);
    if (!id || ruleSets.has(id)) continue;
    const rules = arr(item.rules)
      .filter((rule) => typeof rule === 'string' && rule.trim())
      .map((rule) => rule.trim());
    ruleSets.set(id, {
      id,
      name: firstString(item.name, item.id),
      kind: (firstString(item.kind) || 'custom').toLowerCase(),
      path: firstString(item.path),
      ruleCount: numOrNull(item.ruleCount),
      rules,
    });
  }

  const riskyPatterns = [];
  for (const item of arr(sec.riskyPatterns)) {
    if (!isObj(item)) continue;
    const id = firstString(item.id, item.name);
    if (!id) continue;
    riskyPatterns.push({
      id,
      name: firstString(item.name, item.id),
      severity: GUARD_SEVERITIES.has(str(item.severity)?.toLowerCase())
        ? str(item.severity).toLowerCase()
        : 'medium',
      path: firstString(item.path),
      line: numOrNull(item.line),
      snippet: str(item.snippet),
      detail: str(item.detail),
    });
  }

  return {
    has,
    guardsKnown: has && Array.isArray(sec.guards),
    ruleSetsKnown: has && Array.isArray(sec.ruleSets),
    patternsKnown: has && Array.isArray(sec.riskyPatterns),
    score: numOrNull(sec.score),
    guards,
    ruleSets,
    riskyPatterns,
  };
}

function extractCoverage(analysis) {
  const raw = analysis.coverage;
  const has = isObj(raw);
  const cov = obj(raw);
  const fileEntries = [];
  const filesMap = new Map();
  for (const item of arr(cov.files)) {
    if (!isObj(item)) continue;
    const filePath = str(item.path);
    if (!filePath) continue;
    const entry = {
      path: filePath,
      loc: numOrNull(item.loc) ?? 0,
      tested: item.tested === true,
    };
    fileEntries.push(entry);
    if (!filesMap.has(filePath)) filesMap.set(filePath, entry.tested);
  }
  return {
    has,
    line: numOrNull(cov.line),
    branch: numOrNull(cov.branch),
    testCount: numOrNull(cov.testCount),
    estimated: cov.estimated === true || cov.source === 'estimate',
    files: fileEntries,
    filesMap,
  };
}

function extractComplexity(analysis) {
  const raw = analysis.complexity;
  const has = isObj(raw);
  const comp = obj(raw);
  const modules = new Map();
  for (const item of arr(comp.modules)) {
    if (!isObj(item)) continue;
    const modulePath = firstString(item.path, item.id, item.label);
    if (!modulePath || modules.has(modulePath)) continue;
    modules.set(modulePath, {
      path: modulePath,
      label: firstString(item.label, item.name, item.path),
      score: numOrNull(item.score),
      testFiles: numOrNull(item.testFiles),
    });
  }
  const totals = obj(comp.totals);
  return {
    has,
    score: numOrNull(comp.score),
    modules,
    totals,
    totalsSourceLoc: numOrNull(totals.sourceLoc),
  };
}

function extractArchitecture(analysis) {
  const raw = analysis.architecture;
  const has = isObj(raw);
  const arch = obj(raw);
  const nodes = [];
  for (const item of arr(arch.nodes)) {
    if (!isObj(item)) continue;
    const id = firstString(item.id, item.path, item.label);
    if (!id) continue;
    nodes.push({
      id,
      path: firstString(item.path, item.id),
      label: firstString(item.label, item.name, item.id),
      layer: firstString(item.layer, item.layerId) || '未分层',
    });
  }
  const layers = [];
  for (const item of arr(arch.layers)) {
    if (!isObj(item)) continue;
    const id = firstString(item.id, item.name);
    if (id) layers.push({ id, name: firstString(item.name, item.id) });
  }
  const stats = obj(arch.stats);
  const edgeCount = Array.isArray(arch.edges) ? arch.edges.length : numOrNull(stats.edges);
  return {
    has,
    nodes,
    layers,
    edges: edgeCount,
  };
}

function depEntryVersion(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (finite(value)) return String(value);
  return null;
}

function extractDependencies(analysis) {
  const raw = analysis.deps;
  const has = isObj(raw);
  const deps = obj(raw);
  const index = new Map();
  for (const item of arr(deps.packages)) {
    if (!isObj(item)) continue;
    const name = str(item.name);
    if (!name) continue;
    const ecosystem = firstString(item.ecosystem) || 'unknown';
    const version = depEntryVersion(item.version);
    const key = `${ecosystem}\u0000${name}`;
    if (!index.has(key)) index.set(key, { ecosystem, name, versions: new Set() });
    const record = index.get(key);
    if (version) record.versions.add(version);
  }
  const stats = obj(deps.stats);
  return {
    has,
    index,
    count: numOrNull(stats.packages) ?? (has && Array.isArray(deps.packages) ? deps.packages.length : null),
  };
}

const KNOWLEDGE_KEYS = ['domains', 'entities', 'apis', 'events'];
const KNOWLEDGE_NODE_KINDS = {
  domains: ['domain'],
  entities: ['entity', 'model'],
  apis: ['api', 'endpoint', 'route'],
  events: ['event'],
};

function knowledgeItems(knowledge, key) {
  const source = obj(knowledge);
  const candidates = [source[key], source[key.replace(/s$/, '')]];
  const rawList = candidates.find((value) => Array.isArray(value));
  const items = new Map();
  const remember = (item) => {
    if (!isObj(item)) return;
    const id = firstString(item.id, item.name, item.label);
    if (!id || items.has(id)) return;
    items.set(id, { id, label: firstString(item.label, item.name, item.id) });
  };
  for (const item of arr(rawList)) remember(item);
  // Newer knowledge snapshots keep a single `nodes` list with a `kind` field
  // instead of separate top-level arrays; support both shapes.
  const kinds = KNOWLEDGE_NODE_KINDS[key] || [];
  for (const node of arr(source.nodes)) {
    const kind = str(node && node.kind)?.toLowerCase();
    if (kind && kinds.includes(kind)) remember(node);
  }
  return items;
}

function extractKnowledge(analysis) {
  const raw = analysis.knowledge;
  const has = isObj(raw);
  const knowledge = obj(raw);
  const result = { has, lists: {} };
  for (const key of KNOWLEDGE_KEYS) {
    result.lists[key] = has ? knowledgeItems(knowledge, key) : new Map();
  }
  return result;
}

function extractFileIndex(analysis) {
  const has = isObj(analysis.fileIndex) || Array.isArray(analysis.fileIndex);
  const files = [];
  for (const item of arr(analysis.fileIndex)) {
    if (!isObj(item)) continue;
    const filePath = str(item.path);
    if (!filePath) continue;
    files.push({
      path: filePath,
      loc: numOrNull(item.loc) ?? 0,
      kind: str(item.kind),
      module: str(item.module),
    });
  }
  return { has, files };
}

/* ------------------------------------------------------------------ */
/* version comparison (dependency upgrades)                            */
/* ------------------------------------------------------------------ */

function versionParts(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (/^(?:workspace|file|link|git|git\+|https?|npm):/i.test(text)) return null;
  if (/^[*^~<>=| ]+$/.test(text)) return null;
  text = text.replace(/^[^0-9]*/, '');
  const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareParts(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function representativeVersion(record) {
  const versions = [...record.versions];
  const parsed = versions.filter((version) => versionParts(version));
  if (parsed.length > 0) {
    parsed.sort((a, b) => compareParts(versionParts(b), versionParts(a)) || cmpStr(b, a));
    return parsed[0];
  }
  versions.sort(cmpStr);
  return versions[0] ?? null;
}

function dependencyDiff(baseDeps, targetDeps) {
  const added = [];
  const removed = [];
  const upgraded = [];
  const downgraded = [];
  const lowerKeys = new Set([...baseDeps.index.keys(), ...targetDeps.index.keys()]);
  const keys = [...lowerKeys].sort(cmpStr);

  const pushVersioned = (list, keyRecord, versions) => {
    const sorted = [...versions].sort(cmpStr);
    if (sorted.length === 0) {
      list.push({ ecosystem: keyRecord.ecosystem, name: keyRecord.name, version: null });
      return;
    }
    for (const version of sorted) {
      list.push({ ecosystem: keyRecord.ecosystem, name: keyRecord.name, version });
    }
  };

  for (const key of keys) {
    const before = baseDeps.index.get(key);
    const after = targetDeps.index.get(key);
    if (!before && after) {
      pushVersioned(added, after, after.versions);
      continue;
    }
    if (before && !after) {
      pushVersioned(removed, before, before.versions);
      continue;
    }
    if (!before || !after) continue;
    if (before.versions.size === after.versions.size) {
      const same = [...before.versions].every((version) => after.versions.has(version));
      if (same) continue;
    }
    const from = representativeVersion(before);
    const to = representativeVersion(after);
    if (!from || !to || from === to) continue;
    const fromParts = versionParts(from);
    const toParts = versionParts(to);
    if (!fromParts || !toParts) continue;
    const compared = compareParts(toParts, fromParts);
    if (compared === 0) continue;
    const item = {
      ecosystem: after.ecosystem,
      name: after.name,
      from,
      to,
      major: toParts[0] !== fromParts[0],
    };
    if (compared > 0) upgraded.push(item);
    else downgraded.push(item);
  }

  const byKey = (a, b) =>
    cmpStr(a.ecosystem, b.ecosystem) || cmpStr(a.name, b.name) || cmpStr(a.version ?? '', b.version ?? '') || cmpStr(a.from ?? '', b.from ?? '');
  added.sort(byKey);
  removed.sort(byKey);
  upgraded.sort(byKey);
  downgraded.sort(byKey);

  const ecosystems = new Set([
    ...added.map((item) => item.ecosystem),
    ...removed.map((item) => item.ecosystem),
    ...upgraded.map((item) => item.ecosystem),
    ...downgraded.map((item) => item.ecosystem),
  ]);
  const byEcosystem = [...ecosystems].sort(cmpStr).map((ecosystem) => ({
    ecosystem,
    added: added.filter((item) => item.ecosystem === ecosystem).length,
    removed: removed.filter((item) => item.ecosystem === ecosystem).length,
    upgraded: upgraded.filter((item) => item.ecosystem === ecosystem).length,
  }));

  return { added, removed, upgraded, downgraded, byEcosystem };
}

/* ------------------------------------------------------------------ */
/* file helpers                                                        */
/* ------------------------------------------------------------------ */

const TEST_PATH_RE = /(^|\/)(__tests__|tests?|spec|testcases?)\/|\.(test|spec|e2e|integration)\.[a-z0-9]+$|(test|tests|it|spec)\.(java|kt|cs)$|_test\.(py|go|rb)$/i;

function fileKind(entry) {
  if (entry.kind === 'source' || entry.kind === 'test') return entry.kind;
  return TEST_PATH_RE.test(entry.path) ? 'test' : 'source';
}

function fileStem(filePath) {
  const base = filePath.split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * Compare two analysis snapshots and explain the quality / risk movement.
 * @param {object} baseSnapshot  `{ id, branch, commit_sha, analysis }`
 * @param {object} targetSnapshot same shape
 * @returns {object} JSON-serializable diff (contract §7)
 */
export function diffSnapshots(baseSnapshot, targetSnapshot) {
  const base = normalizeSnapshot(baseSnapshot);
  const target = normalizeSnapshot(targetSnapshot);
  const baseAnalysis = base.analysis;
  const targetAnalysis = target.analysis;

  const identical =
    base.commit && target.commit
      ? base.commit === target.commit
      : canonical(comparableAnalysis(baseAnalysis)) === canonical(comparableAnalysis(targetAnalysis));

  const baseSec = extractSecurity(baseAnalysis);
  const targetSec = extractSecurity(targetAnalysis);
  const baseCov = extractCoverage(baseAnalysis);
  const targetCov = extractCoverage(targetAnalysis);
  const baseComp = extractComplexity(baseAnalysis);
  const targetComp = extractComplexity(targetAnalysis);
  const baseArch = extractArchitecture(baseAnalysis);
  const targetArch = extractArchitecture(targetAnalysis);
  const baseDeps = extractDependencies(baseAnalysis);
  const targetDeps = extractDependencies(targetAnalysis);
  const baseKnowledge = extractKnowledge(baseAnalysis);
  const targetKnowledge = extractKnowledge(targetAnalysis);
  const baseFiles = extractFileIndex(baseAnalysis);
  const targetFiles = extractFileIndex(targetAnalysis);

  /* ---------------- risks ---------------- */

  const risks = [];
  const usedRiskIds = new Set();

  function pushRisk(risk) {
    const level = LEVEL_RANK[risk.level] ? risk.level : 'medium';
    const baseId = str(risk.id) || 'risk';
    let id = baseId;
    let suffix = 2;
    while (usedRiskIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedRiskIds.add(id);
    risks.push({
      id,
      level,
      category: str(risk.category) || '变更',
      title: str(risk.title) || '检测到风险变更',
      detail: str(risk.detail) || '',
      evidence: sanitizeEvidence(risk.evidence),
      action: str(risk.action) || '在合并前评估该变更并补充验证。',
      source: risk.source === 'target' ? 'target' : 'diff',
    });
  }

  /* ---------------- security ---------------- */

  const guardIds = [...new Set([...baseSec.guards.keys(), ...targetSec.guards.keys()])].sort(cmpStr);
  const guardsAdded = [];
  const guardsRemoved = [];
  const guardsChanged = [];
  for (const id of guardIds) {
    const before = baseSec.guards.get(id);
    const after = targetSec.guards.get(id);
    if (!before && after) {
      guardsAdded.push({
        id,
        name: after.name,
        category: after.category,
        severity: after.severity,
        ruleCount: after.ruleCount,
      });
      continue;
    }
    if (before && !after) {
      guardsRemoved.push({
        id,
        name: before.name,
        category: before.category,
        severity: before.severity,
        ruleCount: before.ruleCount,
      });
      continue;
    }
    if (!before || !after) continue;
    const ruleDelta = after.ruleCount - before.ruleCount;
    if (before.status !== after.status || ruleDelta !== 0) {
      guardsChanged.push({
        id,
        name: after.name || before.name,
        from: before.status,
        to: after.status,
        ruleDelta,
      });
    }
  }

  for (const removed of guardsRemoved) {
    const guard = baseSec.guards.get(removed.id);
    if (!guard || STATUS_RANK[guard.status] === 0) continue;
    const high = guard.severity === 'critical' || guard.severity === 'high';
    pushRisk({
      id: `guard-removed-${safeId(guard.id)}`,
      level: high ? 'high' : 'medium',
      category: '安全',
      title: `安全守护被移除：${guard.name}`,
      detail: `基线中的「${guard.name}」（分类：${guard.category}，缺失风险：${SEVERITY_LABEL[guard.severity]}）原本为${STATUS_LABEL[guard.status]}，目标分支已不再包含该守护，涉及 ${guard.ruleCount} 条控制规则${guard.rules.length ? `：${listText(guard.rules, 4)}` : ''}。`,
      evidence: guard.evidence,
      action: `在目标分支恢复「${guard.name}」相关实现与配置${guard.rules.length ? `（${listText(guard.rules, 3)}）` : ''}；若确认由等效机制替代，请在 PR 中写明替代方案并补充对应测试。`,
    });
  }

  for (const id of guardIds) {
    const before = baseSec.guards.get(id);
    const after = targetSec.guards.get(id);
    if (!before || !after) continue;
    if (STATUS_RANK[after.status] >= STATUS_RANK[before.status]) continue;
    const high = before.severity === 'critical' || before.severity === 'high';
    const lostRules = before.rules.filter((rule) => !after.rules.includes(rule));
    pushRisk({
      id: `guard-degraded-${safeId(id)}`,
      level: high ? 'high' : 'medium',
      category: '安全',
      title: `安全守护降级：${after.name}`,
      detail: `「${after.name}」由${STATUS_LABEL[before.status]}降为${STATUS_LABEL[after.status]}，规则数 ${before.ruleCount} → ${after.ruleCount}${lostRules.length ? `，不再覆盖：${listText(lostRules, 4)}` : ''}。该守护属于${after.category}，降级会放大${SEVERITY_LABEL[before.severity]}级别风险。`,
      evidence: before.evidence.length ? before.evidence : after.evidence,
      action: `恢复「${after.name}」到${STATUS_LABEL[before.status]}状态，补齐被移除的校验/配置，并为降级路径补充负向测试用例。`,
    });
  }

  const ruleSetIds = [...new Set([...baseSec.ruleSets.keys(), ...targetSec.ruleSets.keys()])].sort(cmpStr);
  const ruleSetDiff = [];
  for (const id of ruleSetIds) {
    const before = baseSec.ruleSets.get(id);
    const after = targetSec.ruleSets.get(id);
    if (!before && !after) continue;
    const beforeRules = new Set(before?.rules ?? []);
    const afterRules = new Set(after?.rules ?? []);
    const added = [...afterRules].filter((rule) => !beforeRules.has(rule)).sort(cmpStr);
    const removed = [...beforeRules].filter((rule) => !afterRules.has(rule)).sort(cmpStr);
    const beforeCount = before ? (before.rules.length > 0 ? before.rules.length : before.ruleCount ?? 0) : 0;
    const afterCount = after ? (after.rules.length > 0 ? after.rules.length : after.ruleCount ?? 0) : 0;
    if (added.length === 0 && removed.length === 0 && beforeCount === afterCount) continue;
    ruleSetDiff.push({
      id,
      name: after?.name || before?.name || id,
      added,
      removed,
      before: beforeCount,
      after: afterCount,
    });
    if (afterCount >= beforeCount && removed.length <= added.length) continue;
    const kind = (after?.kind || before?.kind || 'custom').toLowerCase();
    const level = kind === 'sast' || kind === 'secret' ? 'high' : 'medium';
    const targetPath = after?.path || before?.path;
    pushRisk({
      id: `ruleset-reduced-${safeId(id)}`,
      level,
      category: '安全',
      title: `检测规则减少：${after?.name || before?.name || id}`,
      detail: `规则集「${after?.name || before?.name || id}」（类型：${kind}${targetPath ? `，文件：${targetPath}` : ''}）从 ${beforeCount} 条变为 ${afterCount} 条，移除 ${removed.length} 条${removed.length ? `：${listText(removed, 6)}` : ''}。${kind === 'sast' || kind === 'secret' ? 'SAST/密钥规则减少会让对应缺陷直接进入主干。' : '规则减少会削弱该维度的自动防线。'}`,
      evidence: targetPath ? [{ path: targetPath }] : [],
      action: targetPath
        ? `在 ${targetPath} 中恢复上述规则，或在 PR 中说明等价覆盖方案；同时确认 CI 仍会执行该规则集。`
        : '恢复被移除的规则，或补充等价的自动检查并在 CI 中强制执行。',
    });
  }

  const patternKey = (pattern) => `${pattern.id}\u0000${pattern.path ?? ''}`;
  const basePatternKeys = new Set(baseSec.riskyPatterns.map(patternKey));
  const targetPatternKeys = new Set(targetSec.riskyPatterns.map(patternKey));
  const riskyPatternsAdded = targetSec.riskyPatterns
    .filter((pattern) => !basePatternKeys.has(patternKey(pattern)))
    .sort((a, b) => cmpStr(a.id, b.id) || cmpStr(a.path ?? '', b.path ?? ''));
  const riskyPatternsRemoved = baseSec.riskyPatterns
    .filter((pattern) => !targetPatternKeys.has(patternKey(pattern)))
    .sort((a, b) => cmpStr(a.id, b.id) || cmpStr(a.path ?? '', b.path ?? ''));

  if (riskyPatternsAdded.length > 0) {
    const severityLevel = riskyPatternsAdded.some(
      (pattern) => pattern.severity === 'critical' || pattern.severity === 'high',
    )
      ? 'high'
      : riskyPatternsAdded.some((pattern) => pattern.severity === 'medium')
        ? 'medium'
        : 'low';
    pushRisk({
      id: 'risky-patterns-added',
      level: severityLevel,
      category: '安全',
      title: `新增 ${riskyPatternsAdded.length} 处风险代码模式`,
      detail: `目标分支出现基线中不存在的风险模式：${listText(
        riskyPatternsAdded.map((pattern) => `${pattern.name}${pattern.path ? `（${pattern.path}${pattern.line ? `:${pattern.line}` : ''}）` : ''}`),
        5,
      )}。这些模式通常对应注入、越权或密钥泄露等真实缺陷。`,
      evidence: riskyPatternsAdded
        .filter((pattern) => pattern.path)
        .map((pattern) => ({ path: pattern.path })),
      action: '逐处确认触发条件并修复根因；为对应入口补充安全测试（如注入 payload、越权访问用例），修复前不要合并到主干。',
    });
  }

  const security = {
    scoreBefore: baseSec.score,
    scoreAfter: targetSec.score,
    delta: baseSec.score !== null && targetSec.score !== null ? round(targetSec.score - baseSec.score, 1) : null,
    guardsAdded,
    guardsRemoved,
    guardsChanged,
    ruleSets: ruleSetDiff,
    riskyPatternsAdded,
    riskyPatternsRemoved,
  };

  /* ---------------- dependencies ---------------- */

  const depsDiff = dependencyDiff(baseDeps, targetDeps);
  const majorUpgrades = depsDiff.upgraded.filter((item) => item.major);

  if (majorUpgrades.length > 0) {
    pushRisk({
      id: 'deps-major-upgrade',
      level: 'medium',
      category: '依赖',
      title: `${majorUpgrades.length} 个依赖发生 major 升级`,
      detail: `跨大版本升级：${listText(
        majorUpgrades.map((item) => `${item.name} ${item.from} → ${item.to}`),
        6,
      )}。major 升级通常包含破坏性 API/行为变更，是回归与运行时故障的高发来源。`,
      evidence: majorUpgrades.slice(0, 4).map((item) => ({ label: `${item.ecosystem}:${item.name}` })),
      action: '逐个阅读上游 CHANGELOG 与 breaking changes，补充针对升级点的回归测试，并在预发环境验证；必要时拆分升级或暂时回退版本。',
    });
  }

  if (depsDiff.downgraded.length > 0) {
    pushRisk({
      id: 'deps-downgrade',
      level: 'medium',
      category: '依赖',
      title: `${depsDiff.downgraded.length} 个依赖被降级`,
      detail: `版本回退：${listText(
        depsDiff.downgraded.map((item) => `${item.name} ${item.from} → ${item.to}`),
        6,
      )}。降级可能丢失安全补丁或与锁文件不一致。`,
      evidence: depsDiff.downgraded.slice(0, 4).map((item) => ({ label: `${item.ecosystem}:${item.name}` })),
      action: '确认降级原因与对应 CVE/兼容性问题，更新锁文件并重新安装验证；若为临时回退，请记录恢复计划与负责人。',
    });
  }

  if (depsDiff.added.length > 0) {
    const addedNames = [...new Set(depsDiff.added.map((item) => item.name))];
    pushRisk({
      id: 'deps-added',
      level: 'low',
      category: '依赖',
      title: `新增 ${addedNames.length} 个依赖`,
      detail: `新增依赖：${listText(addedNames, 8)}。新增运行时依赖会扩大供应链攻击面，需要确认来源、许可证与版本锁定策略。`,
      evidence: depsDiff.added.filter((item) => item.version).slice(0, 4).map((item) => ({ label: `${item.ecosystem}:${item.name}@${item.version}` })),
      action: '确认依赖来源可信、许可证兼容、版本已锁定（lockfile 同步提交），并记录引入原因；能用现有依赖实现时优先复用。',
    });
  }

  const dependencies = {
    added: depsDiff.added,
    removed: depsDiff.removed,
    upgraded: depsDiff.upgraded,
    downgraded: depsDiff.downgraded,
    byEcosystem: depsDiff.byEcosystem,
  };

  /* ---------------- architecture ---------------- */

  const baseNodeIds = new Set(baseArch.nodes.map((node) => node.id));
  const targetNodeIds = new Set(targetArch.nodes.map((node) => node.id));
  const nodesAdded = targetArch.nodes
    .filter((node) => !baseNodeIds.has(node.id))
    .map((node) => ({ id: node.id, label: node.label, layer: node.layer }))
    .sort((a, b) => cmpStr(a.id, b.id));
  const nodesRemoved = baseArch.nodes
    .filter((node) => !targetNodeIds.has(node.id))
    .map((node) => ({ id: node.id, label: node.label, layer: node.layer }))
    .sort((a, b) => cmpStr(a.id, b.id));

  const layerIds = new Set();
  for (const layer of [...baseArch.layers, ...targetArch.layers]) layerIds.add(layer.id);
  for (const node of [...baseArch.nodes, ...targetArch.nodes]) layerIds.add(node.layer);
  const layerDeltas = [...layerIds]
    .sort(cmpStr)
    .map((layer) => ({
      layer,
      before: baseArch.nodes.filter((node) => node.layer === layer).length,
      after: targetArch.nodes.filter((node) => node.layer === layer).length,
    }))
    .filter((entry) => entry.before !== entry.after);

  const architecture = {
    nodesBefore: baseArch.has ? baseArch.nodes.length : null,
    nodesAfter: targetArch.has ? targetArch.nodes.length : null,
    edgesBefore: baseArch.edges,
    edgesAfter: targetArch.edges,
    nodesAdded,
    nodesRemoved,
    layerDeltas,
  };

  // New modules that ship without tests (or land already very complex).
  const newModulesWithoutTests = [];
  const newComplexModules = [];
  if (targetArch.has && targetComp.has) {
    for (const node of targetArch.nodes) {
      if (baseNodeIds.has(node.id)) continue;
      const module =
        targetComp.modules.get(node.path || node.id) ||
        targetComp.modules.get(node.id) ||
        targetComp.modules.get(node.label || '');
      if (!module) continue;
      if (module.testFiles === 0 && !newModulesWithoutTests.some((item) => item.id === node.id)) {
        newModulesWithoutTests.push(node);
      }
      if (module.score !== null && module.score >= 60 && !newComplexModules.some((item) => item.id === node.id)) {
        newComplexModules.push(node);
      }
    }
  }
  if (newModulesWithoutTests.length > 0 || newComplexModules.length > 0) {
    const labels = [...new Set([...newModulesWithoutTests, ...newComplexModules].map((node) => node.label))];
    const reasons = [];
    if (newModulesWithoutTests.length > 0) reasons.push(`${newModulesWithoutTests.length} 个没有任何测试文件`);
    if (newComplexModules.length > 0) reasons.push(`${newComplexModules.length} 个复杂度评分达到 60 以上`);
    pushRisk({
      id: 'architecture-new-modules',
      level: 'medium',
      category: '架构',
      title: `新增模块风险：${listText(labels, 3)}`,
      detail: `本次新增的模块中，${reasons.join('，')}。缺少测试的新模块会直接抬高维护成本与回归概率。`,
      evidence: [...new Set([...newModulesWithoutTests, ...newComplexModules].map((node) => node.id))]
        .slice(0, 4)
        .map((id) => ({ path: id })),
      action: '为新增模块补上最小可用的单元/集成测试骨架，拆分职责过重的类，并在后续迭代中持续监控复杂度增量。',
    });
  }

  /* ---------------- complexity ---------------- */

  const modulePaths = [...new Set([...baseComp.modules.keys(), ...targetComp.modules.keys()])].sort(cmpStr);
  const complexityModules = [];
  for (const modulePath of modulePaths) {
    const before = baseComp.modules.get(modulePath);
    const after = targetComp.modules.get(modulePath);
    const beforeScore = before?.score ?? null;
    const afterScore = after?.score ?? null;
    let status = 'flat';
    let delta = null;
    if (beforeScore === null && afterScore !== null) status = 'new';
    else if (beforeScore !== null && afterScore === null) status = 'removed';
    else if (beforeScore !== null && afterScore !== null) {
      delta = round(afterScore - beforeScore, 1);
      if (delta > 0) status = 'regressed';
      else if (delta < 0) status = 'improved';
    }
    if (status === 'flat') continue;
    complexityModules.push({
      path: modulePath,
      label: after?.label || before?.label || modulePath,
      before: beforeScore,
      after: afterScore,
      delta,
      status,
    });
  }
  const regressions = complexityModules
    .filter((module) => (module.delta ?? 0) > 0)
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || cmpStr(a.path, b.path));
  const improvements = complexityModules
    .filter((module) => (module.delta ?? 0) < 0)
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0) || cmpStr(a.path, b.path));

  const complexityDelta =
    baseComp.score !== null && targetComp.score !== null ? round(targetComp.score - baseComp.score, 1) : null;

  let complexityLevel = null;
  if (complexityDelta !== null) {
    if (complexityDelta >= 25) complexityLevel = 'high';
    else if (complexityDelta >= 12) complexityLevel = 'medium';
  }
  const moduleTriggers = regressions.filter((module) => (module.after ?? 0) >= 60 && (module.delta ?? 0) >= 15);
  for (const module of moduleTriggers) {
    const level = (module.delta ?? 0) >= 25 ? 'high' : 'medium';
    if (!complexityLevel || LEVEL_RANK[level] > LEVEL_RANK[complexityLevel]) complexityLevel = level;
  }
  if (complexityLevel) {
    const top = regressions.slice(0, 3);
    const moduleText = top.length
      ? `；模块变化：${listText(top.map((module) => `${module.label} ${module.before ?? '—'} → ${module.after ?? '—'}（+${module.delta}）`), 3)}`
      : '';
    const moduleOnly = (complexityDelta === null || complexityDelta < 12) && moduleTriggers.length > 0;
    pushRisk({
      id: 'complexity-up',
      level: complexityLevel,
      category: '复杂度',
      title: moduleOnly
        ? `模块复杂度显著上升（${moduleTriggers.length} 个模块）`
        : complexityDelta !== null
          ? `系统复杂度上升 ${complexityDelta} 分`
          : '模块复杂度显著上升',
      detail: `复杂度评分 ${baseComp.score ?? '—'} → ${targetComp.score ?? '—'}（+${complexityDelta ?? 0}）${moduleText}。复杂度上升会让缺陷率、评审成本与交付周期同步恶化。`,
      evidence: regressions.slice(0, 4).map((module) => ({ path: module.path })),
      action: '优先拆分增幅最大的模块（按领域职责提取子模块/服务），为超大文件引入边界测试；在 CI 中加入复杂度阈值，阻止继续增长。',
    });
  }

  const complexity = {
    scoreBefore: baseComp.score,
    scoreAfter: targetComp.score,
    delta: complexityDelta,
    modules: complexityModules,
    topRegressions: regressions.slice(0, 5).map(({ path: modulePath, label, before, after, delta }) => ({
      path: modulePath,
      label,
      before,
      after,
      delta,
    })),
    topImprovements: improvements.slice(0, 5).map(({ path: modulePath, label, before, after, delta }) => ({
      path: modulePath,
      label,
      before,
      after,
      delta,
    })),
  };

  /* ---------------- coverage ---------------- */

  const coverageDelta =
    baseCov.line !== null && targetCov.line !== null ? round(targetCov.line - baseCov.line, 1) : null;
  const testCountDelta =
    baseCov.testCount !== null && targetCov.testCount !== null
      ? round(targetCov.testCount - baseCov.testCount, 1)
      : null;

  const untestedNewFiles = [];
  if (baseFiles.files.length > 0 && targetFiles.files.length > 0) {
    const basePaths = new Set(baseFiles.files.map((file) => file.path));
    const testPaths = targetFiles.files.filter((file) => fileKind(file) === 'test').map((file) => file.path.toLowerCase());
    const newSources = targetFiles.files
      .filter((file) => !basePaths.has(file.path) && fileKind(file) === 'source')
      .sort((a, b) => cmpStr(a.path, b.path));
    for (const file of newSources) {
      let tested;
      if (targetCov.filesMap.has(file.path)) tested = targetCov.filesMap.get(file.path) === true;
      else {
        const stem = fileStem(file.path);
        tested = stem.length > 1 && testPaths.some((testPath) => testPath.includes(stem));
      }
      if (!tested) untestedNewFiles.push({ path: file.path, loc: file.loc, module: file.module ?? null });
    }
  }

  let testsRemoved = [];
  if (baseFiles.files.length > 0 && targetFiles.files.length > 0) {
    const targetPaths = new Set(targetFiles.files.map((file) => file.path));
    testsRemoved = baseFiles.files
      .filter((file) => fileKind(file) === 'test' && !targetPaths.has(file.path))
      .map((file) => ({ path: file.path }))
      .sort((a, b) => cmpStr(a.path, b.path));
  }

  if (coverageDelta !== null && coverageDelta <= -2) {
    const level = coverageDelta <= -6 ? 'high' : 'medium';
    pushRisk({
      id: 'coverage-drop',
      level,
      category: '测试',
      title: `行覆盖率下降 ${Math.abs(coverageDelta)} 个百分点`,
      detail: `行覆盖率 ${baseCov.line}% → ${targetCov.line}%（${coverageDelta}pp）${targetCov.estimated ? '，数据来自估算' : ''}。覆盖率下降意味着新增或修改逻辑缺少自动化验证，回归更依赖人工。`,
      evidence: untestedNewFiles.slice(0, 4).map((file) => ({ path: file.path })),
      action: '为覆盖率下降的模块补充针对变更分支的单元测试，并在 CI 中设置覆盖率不低于基线（建议 ratchet）阈值。',
    });
  }

  if (untestedNewFiles.length > 0) {
    pushRisk({
      id: 'coverage-untested-new-files',
      level: untestedNewFiles.length > 5 ? 'medium' : 'low',
      category: '测试',
      title: `新增 ${untestedNewFiles.length} 个源码文件缺少测试`,
      detail: `以下新增文件没有对应测试：${listText(
        untestedNewFiles.map((file) => `${file.path}${file.loc ? `（${file.loc} 行）` : ''}`),
        5,
      )}。新增逻辑未经测试直接进入主干会显著提高缺陷逃逸概率。`,
      evidence: untestedNewFiles.slice(0, 4).map((file) => ({ path: file.path })),
      action: '为这些新增文件补充单元测试或集成测试，至少覆盖主路径与错误分支；若为纯类型/常量文件，请在 PR 中说明并标记豁免原因。',
    });
  }

  const coverage = {
    lineBefore: baseCov.line,
    lineAfter: targetCov.line,
    delta: coverageDelta,
    estimatedBefore: baseCov.estimated,
    estimatedAfter: targetCov.estimated,
    testCountBefore: baseCov.testCount,
    testCountAfter: targetCov.testCount,
    testCountDelta,
    untestedNewFiles,
    testsRemoved,
  };

  /* ---------------- knowledge ---------------- */

  const knowledge = {};
  for (const key of KNOWLEDGE_KEYS) {
    const before = baseKnowledge.lists[key];
    const after = targetKnowledge.lists[key];
    const added = [...after.keys()]
      .filter((id) => !before.has(id))
      .sort(cmpStr)
      .map((id) => after.get(id));
    const removed = [...before.keys()]
      .filter((id) => !after.has(id))
      .sort(cmpStr)
      .map((id) => before.get(id));
    knowledge[`${key}Added`] = added;
    knowledge[`${key}Removed`] = removed;
  }

  /* ---------------- existing target risks ---------------- */

  if (!identical) {
    const targetRisks = arr(targetAnalysis.risks)
      .filter((risk) => isObj(risk) && str(risk.level)?.toLowerCase() === 'high')
      .sort((a, b) => cmpStr(str(a.id) || '', str(b.id) || ''))
      .slice(0, 20);
    for (const [index, risk] of targetRisks.entries()) {
      pushRisk({
        id: `target-${safeId(risk.id || risk.title, `risk-${index + 1}`)}`,
        level: 'high',
        category: firstString(risk.category) || '存量风险',
        title: `存量高危：${firstString(risk.title) || '未命名风险'}`,
        detail: firstString(risk.detail) || '目标快照本身仍包含未解决的高危风险。',
        evidence: risk.evidence,
        action: firstString(risk.action) || '在合并前修复该高危问题，或给出明确的豁免说明、责任人与截止时间。',
        source: 'target',
      });
    }
  }

  /* ---------------- metrics ---------------- */

  const sourceLocBefore =
    numOrNull(obj(obj(baseAnalysis.meta).stats).sourceLoc) ??
    numOrNull(obj(obj(baseAnalysis.complexity).totals).sourceLoc);
  const sourceLocAfter =
    numOrNull(obj(obj(targetAnalysis.meta).stats).sourceLoc) ??
    numOrNull(obj(obj(targetAnalysis.complexity).totals).sourceLoc);

  const moduleCount = (comp, arch) => {
    if (comp.has && comp.modules.size > 0) return comp.modules.size;
    if (arch.has) return arch.nodes.length;
    return comp.has ? 0 : null;
  };

  const guardsCount = (sec) => (sec.guardsKnown ? sec.guards.size : null);
  const rulesCount = (sec) =>
    sec.guardsKnown ? [...sec.guards.values()].reduce((total, guard) => total + guard.ruleCount, 0) : null;

  const metricDefinitions = [
    {
      key: 'security-score',
      label: '安全守护分',
      unit: '分',
      before: baseSec.score,
      after: targetSec.score,
      direction: 'higher-better',
    },
    {
      key: 'security-guards',
      label: '守护项数',
      unit: '项',
      before: guardsCount(baseSec),
      after: guardsCount(targetSec),
      direction: 'higher-better',
    },
    {
      key: 'security-rules',
      label: '安全规则数',
      unit: '条',
      before: rulesCount(baseSec),
      after: rulesCount(targetSec),
      direction: 'higher-better',
    },
    {
      key: 'system-complexity',
      label: '系统复杂度',
      unit: '分',
      before: baseComp.score,
      after: targetComp.score,
      direction: 'lower-better',
    },
    {
      key: 'line-coverage',
      label: '行覆盖率',
      unit: '%',
      before: baseCov.line,
      after: targetCov.line,
      direction: 'higher-better',
    },
    {
      key: 'test-count',
      label: '测试用例数',
      unit: '个',
      before: baseCov.has ? baseCov.testCount : null,
      after: targetCov.has ? targetCov.testCount : null,
      direction: 'higher-better',
    },
    {
      key: 'source-loc',
      label: '源码行数',
      unit: '行',
      before: sourceLocBefore,
      after: sourceLocAfter,
      direction: 'neutral',
    },
    {
      key: 'modules',
      label: '模块数',
      unit: '个',
      before: moduleCount(baseComp, baseArch),
      after: moduleCount(targetComp, targetArch),
      direction: 'neutral',
    },
    {
      key: 'dependencies',
      label: '依赖数',
      unit: '个',
      before: baseDeps.count,
      after: targetDeps.count,
      direction: 'lower-better',
    },
    {
      key: 'api-count',
      label: '业务 API 数',
      unit: '个',
      before: baseKnowledge.has ? baseKnowledge.lists.apis.size : null,
      after: targetKnowledge.has ? targetKnowledge.lists.apis.size : null,
      direction: 'neutral',
    },
    {
      key: 'risky-patterns',
      label: '风险代码模式',
      unit: '处',
      before: baseSec.patternsKnown ? baseSec.riskyPatterns.length : null,
      after: targetSec.patternsKnown ? targetSec.riskyPatterns.length : null,
      direction: 'lower-better',
    },
  ];

  const metrics = metricDefinitions.map((definition) => {
    const before = numOrNull(definition.before);
    const after = numOrNull(definition.after);
    const delta = before !== null && after !== null ? round(after - before, 1) : null;
    let status = 'flat';
    if (delta !== null && delta !== 0) {
      if (definition.direction === 'higher-better') status = delta > 0 ? 'improved' : 'regressed';
      else if (definition.direction === 'lower-better') status = delta < 0 ? 'improved' : 'regressed';
      else status = 'flat';
      if (status === 'regressed') {
        if (definition.key === 'line-coverage' && delta <= -2) status = 'risk';
        else if (definition.key === 'security-score' && delta <= -5) status = 'risk';
        else if (definition.key === 'system-complexity' && delta >= 10) status = 'risk';
        else if (definition.key === 'risky-patterns' && delta > 0) status = 'risk';
      }
    }
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      before,
      after,
      delta,
      direction: definition.direction,
      status,
    };
  });

  /* ---------------- verdict ---------------- */

  const securityComponent =
    security.scoreBefore !== null && security.scoreAfter !== null
      ? clamp((security.scoreAfter - security.scoreBefore) * 2, -100, 100)
      : 0;
  const coverageComponent = coverageDelta !== null ? clamp(coverageDelta * 5, -100, 100) : 0;
  const complexityComponent = complexityDelta !== null ? clamp(-complexityDelta * 2.5, -100, 100) : 0;
  const dependencyComponent = clamp(
    2 * dependencies.removed.length -
      15 * majorUpgrades.length -
      8 * depsDiff.downgraded.length -
      1 * dependencies.added.length,
    -100,
    20,
  );
  const edgesBefore = baseArch.edges ?? 0;
  const edgesAfter = targetArch.edges ?? 0;
  const newModuleRiskCount = new Set([...newModulesWithoutTests, ...newComplexModules].map((node) => node.id)).size;
  const architectureComponent = clamp(
    4 * (nodesRemoved.length - nodesAdded.length) -
      0.5 * Math.max(0, edgesAfter - edgesBefore) -
      8 * newModuleRiskCount,
    -100,
    15,
  );

  const weightedScore =
    (30 * securityComponent +
      20 * coverageComponent +
      20 * complexityComponent +
      15 * dependencyComponent +
      15 * architectureComponent) /
    100;
  const score = identical ? 0 : round(clamp(weightedScore, -100, 100), 1);

  const deltaRisks = risks.filter((risk) => risk.source !== 'target');
  const existingRisks = risks.filter((risk) => risk.source === 'target');
  const riskScore = identical
    ? 0
    : Math.round(clamp(deltaRisks.reduce((total, risk) => total + (RISK_WEIGHTS[risk.level] ?? 0), 0), 0, 100));

  const sortedRisks = identical
    ? []
    : [...risks].sort((a, b) => {
        const sourceRank = (risk) => (risk.source === 'target' ? 1 : 0);
        return sourceRank(a) - sourceRank(b) || LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || cmpStr(a.id, b.id);
      });
  const sortedDeltaRisks = sortedRisks.filter((risk) => risk.source !== 'target');
  const highCount = sortedDeltaRisks.filter((risk) => risk.level === 'high').length;
  const mediumCount = sortedDeltaRisks.filter((risk) => risk.level === 'medium').length;
  const lowCount = sortedDeltaRisks.filter((risk) => risk.level === 'low').length;

  let level;
  if (identical) level = 'stable';
  else if (riskScore >= 50 || highCount >= 2 || (highCount >= 1 && riskScore >= 30)) level = 'risk';
  else if (highCount >= 1 || mediumCount >= 1 || riskScore >= 15) level = 'watch';
  else if (score >= 3) level = 'improved';
  else if (score <= -3) level = 'watch';
  else level = 'stable';

  const improvedMetrics = metrics.filter((metric) => metric.status === 'improved');
  const regressedMetrics = metrics.filter((metric) => metric.status === 'regressed' || metric.status === 'risk');
  const topRiskTitles = sortedDeltaRisks.slice(0, 3).map((risk) => risk.title);
  const notableRiskCount = highCount + mediumCount;

  let headline;
  if (identical) headline = '两个快照一致，未发现质量变化';
  else if (level === 'risk') {
    headline = highCount > 0
      ? `分支风险上升：${highCount} 项高风险${mediumCount > 0 ? `、${mediumCount} 项中风险` : ''}`
      : `分支出现风险信号：${mediumCount} 项中风险${lowCount > 0 ? `、${lowCount} 项低风险` : ''}（风险评分 ${riskScore}）`;
  } else if (level === 'watch') {
    headline = notableRiskCount > 0
      ? `存在需要关注的变更：${notableRiskCount} 项中高风险`
      : `质量指标下滑：综合评分 ${score}`;
  } else if (level === 'improved') headline = `质量改善：${improvedMetrics.length} 项指标向好`;
  else headline = '质量基本稳定';

  let summary;
  if (identical) {
    summary = '基线快照与目标快照的提交/内容一致，本次未产生新的安全、依赖、复杂度或测试风险。';
  } else if (sortedDeltaRisks.length > 0) {
    summary = `本次变更引入 ${sortedDeltaRisks.length} 项风险（${highCount} 高 / ${mediumCount} 中 / ${lowCount} 低）。主要问题：${topRiskTitles.join('；')}。${
      improvedMetrics.length > 0 ? `另有 ${improvedMetrics.length} 项指标改善（${listText(improvedMetrics.map((metric) => metric.label), 4)}）。` : ''
    }${existingRisks.length > 0 ? `目标分支另有 ${existingRisks.length} 项存量高危待处理。` : ''}`;
  } else if (regressedMetrics.length > 0) {
    summary = `未产生独立的风险条目，但${listText(regressedMetrics.map((metric) => metric.label), 4)}等 ${regressedMetrics.length} 项指标较基线变差（综合评分 ${score}），建议在合并前确认变化原因。`;
  } else if (improvedMetrics.length > 0) {
    summary = `未发现本次变更引入的新风险，${listText(improvedMetrics.map((metric) => metric.label), 4)} 等 ${improvedMetrics.length} 项指标向好。${
      existingRisks.length > 0 ? `目标分支仍有 ${existingRisks.length} 项存量高危，建议单独排期治理。` : ''
    }`;
  } else {
    summary = '未发现新的风险项，关键指标与基线基本持平。';
  }

  return {
    base: {
      snapshotId: base.id,
      branch: base.branch,
      commit: base.commit,
      analyzedAt: base.analyzedAt,
    },
    target: {
      snapshotId: target.id,
      branch: target.branch,
      commit: target.commit,
      analyzedAt: target.analyzedAt,
    },
    verdict: { level, score, headline, summary },
    metrics,
    security,
    dependencies,
    architecture,
    complexity,
    coverage,
    knowledge,
    risks: sortedRisks,
    existingRisks,
    riskScore,
  };
}
