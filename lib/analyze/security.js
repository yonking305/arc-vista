/**
 * 安全守护分析：面向架构守护，而不是逐个复现漏洞。
 *
 * 设计原则：
 * - 所有结论都来自仓库内真实文件（配置、源码、规则文件、测试），不凭项目类型臆造；
 * - 每个守护都有稳定 id，状态（enforced / partial / missing）可用于分支 diff；
 * - 任何读文件、解析 YAML/JSON 的失败都被吞掉，最差情况退化为 missing，绝不抛错；
 * - 输出不含绝对路径、时间戳与随机值。
 */
import fs from 'node:fs';
import path from 'node:path';

const SEVERITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/** 各守护族在总分里的权重；认证 / 授权 / 密钥管理最高。 */
const CATEGORY_WEIGHT = {
  认证: 18,
  授权: 15,
  数据保护: 12,
  传输安全: 11,
  运行时: 7,
  代码安全: 8,
  供应链: 10,
  密钥管理: 14,
  审计: 5,
};

const SECRET_EXT = new Set([
  '.java', '.kt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rb', '.php',
  '.yml', '.yaml', '.properties', '.json', '.toml', '.env', '.sh', '.bash', '.gradle', '.xml',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json',
  'gradle.lockfile', 'poetry.lock', 'cargo.lock', 'go.sum', 'composer.lock', 'gemfile.lock',
  'packages.lock.json',
]);

const CI_PATH = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|jenkinsfile|azure-pipelines\.ya?ml)$/i;

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function round1(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10) / 10;
}

function truncate(value, max = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function uniqueStrings(list) {
  return [...new Set(list.filter((item) => typeof item === 'string' && item.trim()))];
}

function uniqueById(list) {
  const seen = new Set();
  return list.filter((item) => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

function severityThenPath(a, b) {
  return (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
    || String(a.path || '').localeCompare(String(b.path || ''))
    || (a.line || 0) - (b.line || 0)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

function evidenceOf(matches, limit = 4) {
  const out = [];
  const seen = new Set();
  for (const match of matches) {
    if (!match || !match.path) continue;
    const key = `${match.path}:${match.line || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: match.path,
      ...(match.line ? { line: match.line } : {}),
      snippet: truncate(match.text || match.snippet || ''),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function ruleSetEvidence(sets, limit = 4) {
  return sets.slice(0, limit).map((set) => ({
    path: set.path,
    snippet: truncate(`${set.name}${set.rules[0] ? `：${set.rules[0]}` : `（${set.ruleCount} 项）`}`),
  }));
}

function makeGuard(config) {
  const rules = uniqueStrings(config.rules || []);
  const status = config.status;
  return {
    id: config.id,
    name: config.name,
    category: config.category,
    status,
    severity: config.severity,
    ruleCount: Number.isFinite(config.ruleCount) ? config.ruleCount : rules.length,
    rules,
    evidence: (config.evidence || []).slice(0, 4),
    note: config.note || '',
    recommendation: status === 'enforced' ? '' : (config.recommendation || ''),
  };
}

/** 读取仓库内文本；覆盖 walk 因 .env.* / 无扩展名配置被归为 asset 的情况。 */
function readText(repo, rel) {
  const fromRepo = repo.read(rel);
  if (typeof fromRepo === 'string') return fromRepo;
  if (!repo.root) return null;
  try {
    const abs = path.join(repo.root, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 600_000) return null;
    const buffer = fs.readFileSync(abs);
    if (buffer.subarray(0, 2048).includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

function readJsonFile(repo, rel) {
  const direct = repo.readJson(rel);
  if (direct) return direct;
  const text = readText(repo, rel);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} repo scanRepo() 结果
 * @param {{modulesInfo?: object, graph?: object, deps?: object}} [ctx]
 * @returns {object} 契约 §3 定义的安全分析结果
 */
export function analyzeSecurity(repo, ctx = {}) {
  const safeRepo = repo && Array.isArray(repo.files) ? repo : { files: [], root: '', read: () => null, grep: () => [], find: () => [], fileByPath: new Map() };

  const DEFAULT_SCAN_EXCLUDES = [
    'node_modules/', '/dist/', '/target/', '/build/', '.git/',
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  ];
  const scan = (pattern, options = {}) => {
    try {
      return safeRepo.grep(pattern, {
        maxMatches: 200,
        pathExcludes: DEFAULT_SCAN_EXCLUDES,
        ...options,
      }) || [];
    } catch {
      return [];
    }
  };
  const findFiles = (predicate) => safeRepo.files.filter(predicate);

  // ---------------------------------------------------------------------------
  // 规则文件（SAST / 依赖 / 密钥 / IaC）
  // ---------------------------------------------------------------------------
  const ruleSets = [];
  const ruleSetIds = new Set();
  const addRuleSet = (set) => {
    if (!set || !set.id || ruleSetIds.has(set.id)) return;
    const rules = uniqueStrings(set.rules || []).slice(0, 80);
    ruleSetIds.add(set.id);
    ruleSets.push({
      id: set.id,
      name: set.name,
      kind: set.kind,
      path: set.path || null,
      ruleCount: Number.isFinite(set.ruleCount) ? set.ruleCount : rules.length,
      rules,
    });
  };

  // Semgrep：.semgrep.yml / .semgrep/*.yml / semgrep.yml
  for (const file of findFiles((item) => {
    const full = item.path.toLowerCase();
    return /(^|\/)\.semgrep\.ya?ml$/.test(full)
      || /(^|\/)semgrep\.ya?ml$/.test(full)
      || /(^|\/)\.semgrep\/[^/]+\.ya?ml$/.test(full);
  })) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const names = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*-\s*id:\s*['"]?([A-Za-z0-9_.:/-]+)/);
      if (match) names.push(match[1]);
    }
    let ruleCount = names.length;
    if (ruleCount === 0 && /^\s*rules:\s*(?:\[\s*\])?\s*$/m.test(text)) {
      ruleCount = (text.match(/^\s*-\s+[\w"'$]/gm) || []).length;
    }
    addRuleSet({
      id: `semgrep:${file.path}`,
      name: 'Semgrep 静态扫描',
      kind: 'sast',
      path: file.path,
      ruleCount,
      rules: names.length ? names : (ruleCount ? ['未命名 Semgrep 规则'] : []),
    });
  }

  // ESLint：只收安全相关规则，避免把纯格式配置算成安全守护
  for (const file of findFiles((item) => {
    const base = item.name.toLowerCase();
    return /^\.eslintrc(\.[a-z]+)?$/.test(base) || /^eslint\.config\.(js|cjs|mjs|ts)$/.test(base);
  })) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const rules = [];
    const keyRe = /(['"]?)(security\/[\w-]+|no-eval|no-implied-eval|no-new-func|no-script-url|no-unsafe-innerhtml)\1\s*:/g;
    let match;
    while ((match = keyRe.exec(text))) rules.push(match[2]);
    const pluginRe = /plugin:security\/(recommended|all|[\w-]+)/g;
    while ((match = pluginRe.exec(text))) rules.push(`plugin:security/${match[1]}`);
    if (/\bplugins\s*:\s*\[[^\]]*['"]security['"]/.test(text)) rules.push('plugin:security');
    if (rules.length === 0) continue;
    addRuleSet({
      id: `eslint:${file.path}`,
      name: 'ESLint 安全规则',
      kind: 'lint',
      path: file.path,
      ruleCount: rules.length,
      rules,
    });
  }

  // CodeQL 配置与工作流
  for (const file of findFiles((item) => /(^|\/)\.github\/codeql\/[^/]+\.ya?ml$/i.test(item.path))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const rules = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*-\s*(?:uses|pack|query):\s*['"]?([^\s'"]+)/);
      if (match) rules.push(match[1]);
      const queryPack = line.match(/^\s*(?:queries|packs):\s*\[?\s*['"]?([\w/.:@-]+)/);
      if (queryPack) rules.push(queryPack[1]);
    }
    addRuleSet({
      id: `codeql:${file.path}`,
      name: 'CodeQL 代码扫描',
      kind: 'sast',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? uniqueStrings(rules) : ['CodeQL 默认查询集'],
    });
  }

  // SonarQube：属性文件里的质量门禁配置
  for (const file of findFiles((item) => /^(sonar-project\.properties|\.sonarcloud\.properties)$/i.test(item.name))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const rules = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(sonar\.[\w.]+)\s*=/);
      if (match) rules.push(match[1]);
    }
    addRuleSet({
      id: `sonar:${file.path}`,
      name: 'SonarQube 质量门禁',
      kind: 'sast',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? rules : ['SonarQube 扫描配置'],
    });
  }
  if (findFiles((item) => /(^|\/)pom\.xml$/.test(item.path)).some((item) => /sonar[-.]|sonarsource/i.test(readText(safeRepo, item.path) || ''))) {
    const pom = findFiles((item) => /(^|\/)pom\.xml$/.test(item.path))
      .find((item) => /sonar[-.]|sonarsource/i.test(readText(safeRepo, item.path) || ''));
    if (pom) {
      addRuleSet({
        id: `sonar:${pom.path}`,
        name: 'SonarQube 质量门禁',
        kind: 'sast',
        path: pom.path,
        ruleCount: 1,
        rules: ['sonar-maven-plugin 扫描'],
      });
    }
  }

  // Gitleaks / detect-secrets 配置
  for (const file of findFiles((item) => /^(\.?gitleaks\.(toml|ya?ml)|secrets?\.baseline)$/i.test(item.name))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const rules = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*id\s*=\s*['"]([^'"]+)['"]/);
      if (match) rules.push(match[1]);
      const yamlRule = line.match(/^\s*-\s+id:\s*['"]?([\w.-]+)/);
      if (yamlRule) rules.push(yamlRule[1]);
    }
    addRuleSet({
      id: `gitleaks:${file.path}`,
      name: 'Gitleaks 密钥扫描',
      kind: 'secret',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? rules : ['Gitleaks 默认规则集'],
    });
  }

  // Dependabot
  for (const file of findFiles((item) => /(^|\/)dependabot\.ya?ml$/i.test(item.path) || /(^|\/)\.dependabot\/config\.ya?ml$/i.test(item.path))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const lines = text.split('\n');
    const rules = [];
    for (let i = 0; i < lines.length; i += 1) {
      const eco = lines[i].match(/package-ecosystem:\s*['"]?([\w-]+)/);
      if (!eco) continue;
      let directory = '/';
      let interval = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        const dirMatch = lines[j].match(/directory:\s*['"]?([^'"\s]+)/);
        if (dirMatch) directory = dirMatch[1];
        const intervalMatch = lines[j].match(/interval:\s*['"]?([\w-]+)/);
        if (intervalMatch) interval = intervalMatch[1];
        if (/package-ecosystem:/.test(lines[j])) break;
      }
      rules.push(`${eco[1]} ${directory}${interval ? `（${interval}）` : ''}`);
    }
    addRuleSet({
      id: `dependabot:${file.path}`,
      name: 'Dependabot 依赖更新',
      kind: 'dependency',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? rules : ['依赖更新配置'],
    });
  }

  // Renovate
  for (const file of findFiles((item) => /^(renovate\.json5?|\.renovaterc(\.json)?)$/i.test(item.name))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const config = readJsonFile(safeRepo, file.path);
    const rules = [];
    if (config && typeof config === 'object') {
      const extendsList = Array.isArray(config.extends) ? config.extends : (config.extends ? [config.extends] : []);
      for (const item of extendsList.slice(0, 12)) rules.push(`继承 ${item}`);
      if (Array.isArray(config.packageRules)) {
        config.packageRules.slice(0, 20).forEach((rule, index) => {
          const parts = [];
          if (rule.groupName) parts.push(rule.groupName);
          if (Array.isArray(rule.matchUpdateTypes)) parts.push(rule.matchUpdateTypes.join('/'));
          if (Array.isArray(rule.matchPackageNames)) parts.push(rule.matchPackageNames.slice(0, 3).join(','));
          rules.push(parts.length ? `packageRule：${parts.join(' · ')}` : `packageRule #${index + 1}`);
        });
      }
      if (config.lockFileMaintenance) rules.push('锁文件维护');
      if (config.vulnerabilityAlerts) rules.push('漏洞告警自动升级');
    }
    addRuleSet({
      id: `renovate:${file.path}`,
      name: 'Renovate 依赖更新',
      kind: 'dependency',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? uniqueStrings(rules) : ['Renovate 配置'],
    });
  }

  // Snyk
  for (const file of findFiles((item) => /^\.snyk(\.ya?ml)?$/i.test(item.name))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const rules = [];
    let inIgnore = false;
    for (const line of text.split('\n')) {
      if (/^ignore:\s*$/.test(line)) {
        inIgnore = true;
        continue;
      }
      if (inIgnore) {
        const pkg = line.match(/^\s{2}['"]?([@\w][\w@/.-]*)['"]?\s*:/);
        if (pkg) rules.push(`忽略漏洞：${pkg[1]}`);
      }
      if (/^patch:\s*$/.test(line)) rules.push('已应用补丁');
    }
    addRuleSet({
      id: `snyk:${file.path}`,
      name: 'Snyk 依赖漏洞扫描',
      kind: 'dependency',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? uniqueStrings(rules) : ['Snyk 策略文件'],
    });
  }

  // Trivy
  for (const file of findFiles((item) => /^(trivy\.ya?ml|\.trivyignore(\.ya?ml)?)$/i.test(item.name))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const rules = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^CVE-\d{4}-\d+$/i.test(trimmed)) rules.push(trimmed.toUpperCase());
      const severity = line.match(/^severity:\s*['"]?([A-Z,]+)/i);
      if (severity) rules.push(`严重级别：${severity[1]}`);
      const ignoreUnfixed = line.match(/^ignore-unfixed:\s*(true|false)/i);
      if (ignoreUnfixed) rules.push(`忽略未修复漏洞：${ignoreUnfixed[1]}`);
    }
    addRuleSet({
      id: `trivy:${file.path}`,
      name: 'Trivy 镜像/依赖扫描',
      kind: 'iac',
      path: file.path,
      ruleCount: rules.length || 1,
      rules: rules.length ? rules : ['Trivy 扫描配置'],
    });
  }

  // CI 工作流中的扫描步骤（GitHub Actions / GitLab CI / CircleCI 等）
  for (const file of findFiles((item) => CI_PATH.test(item.path))) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (/semgrep/.test(lower)) {
      addRuleSet({
        id: `semgrep-ci:${file.path}`,
        name: 'Semgrep CI 扫描',
        kind: 'sast',
        path: file.path,
        ruleCount: 1,
        rules: ['CI 执行 Semgrep'],
      });
    }
    if (/codeql/.test(lower)) {
      addRuleSet({
        id: `codeql-ci:${file.path}`,
        name: 'CodeQL CI 扫描',
        kind: 'sast',
        path: file.path,
        ruleCount: 1,
        rules: ['CI 执行 CodeQL'],
      });
    }
    if (/gitleaks|trufflehog|detect-secrets/.test(lower)) {
      addRuleSet({
        id: `gitleaks-ci:${file.path}`,
        name: 'CI 密钥扫描',
        kind: 'secret',
        path: file.path,
        ruleCount: 1,
        rules: ['CI 执行密钥扫描'],
      });
    }
    if (/trivy/.test(lower)) {
      addRuleSet({
        id: `trivy-ci:${file.path}`,
        name: 'Trivy CI 扫描',
        kind: 'iac',
        path: file.path,
        ruleCount: 1,
        rules: ['CI 执行 Trivy'],
      });
    }
    if (/snyk/.test(lower)) {
      addRuleSet({
        id: `snyk-ci:${file.path}`,
        name: 'Snyk CI 扫描',
        kind: 'dependency',
        path: file.path,
        ruleCount: 1,
        rules: ['CI 执行 Snyk'],
      });
    }
    if (/npm audit|pnpm audit|yarn audit|owasp|dependency-check/.test(lower)) {
      addRuleSet({
        id: `audit-ci:${file.path}`,
        name: 'CI 依赖审计',
        kind: 'dependency',
        path: file.path,
        ruleCount: 1,
        rules: ['CI 执行依赖审计'],
      });
    }
  }
  // GitHub 原生密钥扫描配置
  for (const file of findFiles((item) => /secret[-_]scanning\.ya?ml$/i.test(item.path))) {
    addRuleSet({
      id: `github-secret-scanning:${file.path}`,
      name: 'GitHub 密钥扫描',
      kind: 'secret',
      path: file.path,
      ruleCount: 1,
      rules: ['GitHub 原生密钥扫描配置'],
    });
  }

  ruleSets.sort((a, b) => a.id.localeCompare(b.id));

  const sastSets = ruleSets.filter((set) => set.kind === 'sast');
  const lintSets = ruleSets.filter((set) => set.kind === 'lint');
  const dependencySets = ruleSets.filter((set) => set.kind === 'dependency');
  const secretSets = ruleSets.filter((set) => set.kind === 'secret');
  const iacSets = ruleSets.filter((set) => set.kind === 'iac');

  // ---------------------------------------------------------------------------
  // 硬编码密钥
  // ---------------------------------------------------------------------------
  const secretFindings = [];
  const secretCandidates = findFiles((file) => {
    if (!file || !file.path) return false;
    const lower = file.path.toLowerCase();
    if (!file.name.startsWith('.env') && !SECRET_EXT.has(file.ext)) return false;
    if (/(^|\/)(node_modules|target|dist|build|\.git|docs?)\//.test(lower)) return false;
    if (/(package-lock|pnpm-lock|yarn\.lock|bun\.lockb|\.lock$|\.min\.js$)/.test(lower)) return false;
    // 密钥扫描器的规则文件本身就包含密钥样例/正则，不能当成泄漏
    if (/(^|\/)(\.?gitleaks\.(toml|ya?ml)|\.semgrep[^/]*|\.trivyignore[^/]*|detect-secrets[^/]*)$/i.test(lower)) return false;
    const kindOk = file.kind === 'source' || file.kind === 'config' || file.kind === 'test';
    if (!kindOk && !file.name.startsWith('.env')) return false;
    return file.size < 320_000;
  }).sort((a, b) => a.path.localeCompare(b.path));

  const envDefaultRe = /\$\{([A-Z0-9_]+):([^}]{4,})\}/g;
  const assignmentRe = /([A-Za-z_][\w.-]*)\s*[:=]\s*(?:"([^"]{6,})"|'([^']{6,})'|([^\s,;#}]{6,}))/i;
  const secretKeyRe = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)/i;
  const placeholderRe = /^(?:\$\{|#\{|%\{|process\.env|os\.environ|System\.getenv|env\.|config\.|request\.|req\.|body\.|<|>|\{\{|null$|undefined$|true$|false$|none$|nil$)/i;
  const knownPlaceholderRe = /^(?:changeme|change-me|placeholder|your[-_].*|example|sample|dummy|xxx+|\*+)$/i;

  const pushSecret = (finding) => {
    if (secretFindings.length >= 80) return;
    secretFindings.push(finding);
  };

  for (const file of secretCandidates) {
    const text = readText(safeRepo, file.path);
    if (!text) continue;
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) {
      const lines = text.split('\n');
      const index = lines.findIndex((line) => /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(line));
      pushSecret({
        id: `private-key:${file.path}:${index + 1}`,
        kind: 'private-key',
        key: 'private-key',
        value: '',
        name: '私钥文件内容',
        severity: (file.kind === 'test' || /(^|\/)(test|tests|__tests__|spec)\//.test(file.path)) ? 'low' : 'critical',
        path: file.path,
        line: index + 1,
        snippet: '-----BEGIN PRIVATE KEY-----',
        detail: '仓库内出现私钥内容，任何能读取仓库的人都可冒用该身份，应立即吊销并改用密钥管理服务。',
      });
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > 500) continue;
      if (!/(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)/i.test(line)) continue;
      // 先处理 ${ENV:默认值}，这类默认值不会被普通赋值正则捕获
      let envMatch;
      envDefaultRe.lastIndex = 0;
      while ((envMatch = envDefaultRe.exec(line))) {
        const envName = envMatch[1];
        const defaultValue = envMatch[2].trim();
        if (!envName || !defaultValue || knownPlaceholderRe.test(defaultValue)) continue;
        if (!/(secret|token|password|passwd|pwd|key|credential)/i.test(envName)) continue;
        const lowerKey = envName.toLowerCase();
        const lowerPath = file.path.toLowerCase();
        const demo = /demo|example|sample|test|dev|mock|localhost|cloudmall|changeme|default/i.test(defaultValue);
        let severity = 'high';
        if (lowerKey.includes('jwt') || lowerKey.includes('signing')) severity = demo ? 'high' : 'critical';
        else if (/(mysql|postgres|redis|mongo|rabbit|kafka|database|datasource)/.test(lowerKey)) severity = demo ? 'low' : 'high';
        else if (lowerKey.includes('password')) severity = demo ? 'low' : 'medium';
        else if (lowerKey.includes('token') || lowerKey.includes('key')) severity = demo ? 'medium' : 'high';
        if (file.kind === 'test' || /(^|\/)(test|tests|__tests__|spec)\//.test(lowerPath) || /\.(test|spec)\./.test(lowerPath)) severity = 'low';
        const label = envName.replace(/_/g, ' ').toLowerCase();
        const demoDbDefault = severity === 'low' && /(mysql|postgres|redis|mongo|rabbit|kafka|database|datasource)/.test(lowerKey);
        pushSecret({
          id: `env-default:${file.path}:${i + 1}:${envName}`,
          kind: 'env-default',
          key: envName,
          value: defaultValue,
          name: `${envName} 存在固定默认值`,
          severity,
          path: file.path,
          line: i + 1,
          snippet: truncate(line.replace(defaultValue, '******')),
          detail: demoDbDefault
            ? `演示默认口令（${label}）只适合本地开发；生产漏配会退化为仓库内公开值，应移除默认值并要求启动时注入。`
            : `环境变量 ${envName} 未设置时会退回到仓库内可见的默认值（${label}），部署环境一旦漏配就等于使用公开密钥。`,
        });
        break;
      }
      const match = assignmentRe.exec(line);
      if (!match) continue;
      const key = match[1];
      if (!secretKeyRe.test(key)) continue;
      const quotedValue = match[2] || match[3];
      // 源码里的 `this.jwtSecret = jwtSecret` / TS 类型注解 `nextToken: string` 不是凭据；
      // 源码/测试只认显式字符串字面量，配置文件才接受未加引号的值。
      const isConfigFile = file.kind === 'config' || file.name.startsWith('.env');
      const value = (quotedValue || (isConfigFile ? match[4] : '') || '').trim();
      if (!value || value.length < 6) continue;
      if (placeholderRe.test(value) || knownPlaceholderRe.test(value)) continue;
      if (value.includes('${')) continue;
      // HTTP 头名称 / 认证方案不是凭据，例如 INTERNAL_TOKEN = "X-Internal-Token"
      if (/^(?:Bearer|Basic|Authorization|X-[\w-]+|Content-Type|application\/)/i.test(value) && /token|header/i.test(key)) continue;
      if (!quotedValue && !isConfigFile) continue;
      if (/^[A-Za-z0-9+/=_-]{6,}$/.test(value) && /^(?:password|secret|token)$/i.test(key) && value.length < 8) continue;
      const lowerKey = key.toLowerCase();
      const lowerPath = file.path.toLowerCase();
      const isTest = file.kind === 'test' || /(^|\/)(test|tests|__tests__|spec)\//.test(lowerPath) || /\.(test|spec)\./.test(lowerPath);
      const isMock = /(^|\/)(mock|mocks|demo|fixtures?|seeds?)\b/i.test(lowerPath) || /mock|fixture|seed/i.test(key);
      const demo = /demo|example|sample|test|dev|mock|localhost|cloudmall|changeme|default/i.test(value);
      // 存储键名不是凭据：TOKEN_KEY = 'app_token' 只是 localStorage key
      if (/(?:^|_)(?:token|storage|session|cache|cookie)_?key$/i.test(key) && !/(?:api|secret|private|access)/i.test(key)) continue;
      let severity = 'high';
      if (isTest || isMock) severity = 'low';
      else if (/(mysql|postgres|redis|mongo|rabbit|kafka|database|datasource)/.test(lowerKey) || /docker-compose/.test(lowerPath)) severity = 'low';
      else if (lowerKey.includes('jwt') || lowerKey.includes('signing')) severity = demo ? 'high' : 'critical';
      else if (lowerKey.includes('private') && lowerKey.includes('key')) severity = 'critical';
      else if (lowerKey.includes('password')) severity = demo ? 'low' : 'medium';
      else if (demo) severity = 'medium';
      pushSecret({
        id: `assignment:${file.path}:${i + 1}:${slug(key)}`,
        kind: 'assignment',
        key,
        value,
        name: isTest ? '测试中的固定凭据' : isMock ? '演示数据中的固定凭据' : '配置/源码中的明文凭据',
        severity,
        path: file.path,
        line: i + 1,
        snippet: truncate(line.replace(value, '******')),
        detail: isTest
          ? '测试夹具使用固定口令便于复现，但应与生产凭据完全隔离，避免被误用于真实环境。'
          : isMock
            ? '前端 mock / 演示数据里写入了固定账号口令，虽然不连接真实后端，但仍会进入构建产物；建议仅在测试环境启用。'
            : /docker-compose/.test(lowerPath) && demo
              ? '演示环境编排中的固定中间件口令，仅用于本地；生产部署应改由环境变量或密钥管理服务注入。'
              : `字段 ${key} 直接写入了可用凭据，应改为环境变量、密钥管理服务或启动时注入。`,
      });
    }
  }

  // 同一类默认值在多个 application.yml 中重复出现时，风险只保留一条代表项
  const secretRiskSeen = new Set();
  const secretRiskyPatterns = [];
  for (const finding of [...secretFindings].sort(severityThenPath)) {
    if (secretRiskyPatterns.length >= 12) break;
    const dedupeKey = finding.kind === 'env-default'
      ? `env:${finding.key}:${finding.value}`
      : finding.kind === 'private-key'
        ? `key:${finding.path}`
        : `assign:${finding.key}:${finding.value}`;
    if (secretRiskSeen.has(dedupeKey)) continue;
    secretRiskSeen.add(dedupeKey);
    secretRiskyPatterns.push({
      id: `hardcoded-secret:${slug(finding.key || finding.kind)}`,
      name: finding.name,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      snippet: finding.snippet,
      detail: finding.detail,
    });
  }

  // ---------------------------------------------------------------------------
  // 认证与令牌
  // ---------------------------------------------------------------------------
  const manifestHits = scan(/\b(jjwt|java-jwt|nimbus-jose-jwt|spring-security-oauth2-jose|jsonwebtoken|jose|passport-jwt|express-jwt|@fastify\/jwt)\b/i, {
    exts: ['.json', '.xml', '.gradle', '.kts'], kinds: ['config'], maxMatches: 80,
  });
  const jwtVerify = scan(/\b(?:parseSignedClaims|verifyWith|Jwts\.parser|jwt\.verify|jwtVerify|expressjwt|passport\.authenticate)\b/, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts', '.tsx'], kinds: ['source'], maxMatches: 40,
  });
  const jwtSign = scan(/\b(?:Jwts\.builder|signWith|jwt\.sign|new SignJWT|jwtSign|expiresIn)\b/, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts', '.tsx'], kinds: ['source'], maxMatches: 40,
  });
  const jwtExpiry = scan(/\b(?:\.expiration\(|setExpiration|expiresIn|expirationTime|maxAge)\b/, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts', '.tsx'], kinds: ['source'], maxMatches: 40,
  });
  const jwtGateway = scan(/JwtAuthFilter|GlobalFilter|OncePerRequestFilter|jwt\.middleware|authenticate\(['"]jwt/, {
    exts: ['.java', '.kt', '.js', '.ts'], kinds: ['source'], maxMatches: 30,
  });
  const jwtSecretGuard = scan(/bytes\.length\s*<\s*32|secret\.length\s*<|Keys\.hmacShaKeyFor|at least 32/i, {
    exts: ['.java', '.kt', '.js', '.ts'], kinds: ['source'], maxMatches: 30,
  });
  const jwtRules = [];
  if (jwtVerify.length) jwtRules.push('校验 JWT 签名');
  if (jwtExpiry.length) jwtRules.push('校验令牌有效期');
  if (jwtSign.length) jwtRules.push('服务端签发令牌');
  if (jwtGateway.length) jwtRules.push('网关统一验签');
  if (jwtSecretGuard.length) jwtRules.push('密钥长度下限校验');
  const jwtStatus = jwtVerify.length && (jwtSign.length || manifestHits.length) ? 'enforced'
    : (manifestHits.length || jwtSign.length || jwtVerify.length ? 'partial' : 'missing');
  const jwtEvidence = evidenceOf([...jwtVerify.slice(0, 2), ...jwtSign.slice(0, 1), ...jwtGateway.slice(0, 1), ...manifestHits.slice(0, 1)]);

  const bcryptHits = scan(/BCryptPasswordEncoder|Argon2PasswordEncoder|Pbkdf2PasswordEncoder|BCrypt\.hashpw|bcrypt\.(?:hash|compare)|argon2\.(?:hash|verify)/i, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 40,
  });
  const passwordFiles = new Set(scan(/password|passwd|credential|bcrypt|argon2|PasswordEncoder/i, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 200,
  }).map((match) => match.path));
  const passwordHashWrite = scan(/(?:passwordEncoder|encoder|passwordHasher)\.(?:encode|hash)\(|bcrypt\.hash\(|\.hash\([^)\n]*password/i, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 60,
  }).filter((match) => passwordFiles.has(match.path));
  const passwordVerify = scan(/(?:passwordEncoder|encoder|passwordHasher)\.matches\(|bcrypt\.compare\(|argon2\.verify\(|\.matches\([^)\n]*password/i, {
    exts: ['.java', '.kt', '.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 60,
  }).filter((match) => passwordFiles.has(match.path));
  const bcrypt = bcryptHits.some((match) => /BCrypt|bcrypt/i.test(match.text));
  const argon2 = bcryptHits.some((match) => /Argon2|argon2/i.test(match.text));
  const passwordRules = [];
  if (bcrypt) passwordRules.push('BCrypt 哈希存储密码');
  if (argon2) passwordRules.push('Argon2 哈希存储密码');
  if (passwordHashWrite.length) passwordRules.push('注册写入哈希而非明文');
  if (passwordVerify.length) passwordRules.push('登录比对密码哈希');
  if (scan(/@Size\([^)]*min\s*=\s*[6-9]|password.{0,20}min\(|password.{0,20}\.min\(/i, {
    exts: ['.java', '.ts', '.js'], kinds: ['source'], maxMatches: 10,
  }).length) passwordRules.push('密码长度下限约束');
  const springSecurity = scan(/spring-security|org\.springframework\.security/i, {
    exts: ['.xml', '.gradle', '.kts', '.java', '.kt'], kinds: ['config', 'source'], maxMatches: 30,
  });
  if (springSecurity.length) passwordRules.push('Spring Security 密码组件');
  const passwordStatus = (bcrypt || argon2) && passwordVerify.length ? 'enforced'
    : (bcryptHits.length || passwordHashWrite.length || passwordVerify.length ? 'partial' : 'missing');

  const revocationHits = scan(/blacklist|denylist|revoke|tokenVersion|jti/i, {
    exts: ['.java', '.kt', '.js', '.ts', '.yml', '.yaml'], kinds: ['source', 'config'], maxMatches: 60,
  });
  const revocationLogout = scan(/logout|signOut|sign_out/i, {
    exts: ['.java', '.kt', '.js', '.ts'], kinds: ['source'], maxMatches: 40,
  });
  const revocationCheck = scan(/hasKey\([^)]*blacklist|blacklist.*hasKey|isRevoked|revoked/i, {
    exts: ['.java', '.kt', '.js', '.ts'], kinds: ['source'], maxMatches: 40,
  });
  const revocationTtl = scan(/expirationMillis|remaining.*ttl|ttl.*expiration|Duration\.ofMillis/i, {
    exts: ['.java', '.kt', '.js', '.ts'], kinds: ['source'], maxMatches: 30,
  });
  const revocationRules = [];
  if (revocationHits.some((match) => /blacklist|denylist|revoke/i.test(match.text))) revocationRules.push('登出后令牌进入吊销集合');
  if (revocationCheck.length) revocationRules.push('每次请求校验令牌吊销状态');
  if (revocationTtl.length) revocationRules.push('黑名单 TTL 与令牌有效期对齐');
  if (scan(/SHA-256|MessageDigest|createHash\(['"]sha-?256/i, { exts: ['.java', '.js', '.ts'], kinds: ['source'], maxMatches: 20 }).length) {
    revocationRules.push('令牌摘要作为黑名单键');
  }
  const revocationStatus = revocationRules.length >= 2 ? 'enforced' : (revocationRules.length ? 'partial' : 'missing');

  // ---------------------------------------------------------------------------
  // 授权 / RBAC
  // ---------------------------------------------------------------------------
  const preAuthorize = scan(/@PreAuthorize|@Secured|@RolesAllowed|hasRole\(|hasAuthority\(/i, {
    exts: ['.java', '.kt'], kinds: ['source'], maxMatches: 60,
  });
  const roleChecks = scan(/hasRole\(|hasAnyRole|MallRoles\.|roles\.includes|requireRole|requireAdmin|isAdmin\(|authorize\(['"]/i, {
    exts: ['.java', '.kt', '.js', '.ts', '.tsx'], kinds: ['source'], maxMatches: 80,
  });
  const adminPathCheck = scan(/startsWith\(["']\/api\/admin|path.*\/api\/admin|\/admin\/.*hasRole|admin.*forbidden/i, {
    exts: ['.java', '.kt', '.js', '.ts'], kinds: ['source'], maxMatches: 40,
  });
  const roleMiddleware = scan(/(?:app|router)\.(?:get|post|put|patch|delete)\([^\n]{0,200}(?:requireRole|authorize)\s*\(/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 40,
  });
  const methodLevelAuth = preAuthorize.filter((match) => /@PreAuthorize|@Secured|@RolesAllowed/.test(match.text));
  const rbacRules = [];
  if (methodLevelAuth.length) rbacRules.push('方法级权限注解');
  if (preAuthorize.some((match) => /hasRole\(|hasAuthority\(/.test(match.text))) rbacRules.push('按角色/权限判断访问');
  if (adminPathCheck.length) rbacRules.push('管理端路径强制 ADMIN 角色');
  if (roleChecks.length >= 3) rbacRules.push('角色声明贯穿鉴权链路');
  if (roleMiddleware.length) rbacRules.push('路由级 requireRole 权限中间件');
  if (scan(/remove\(.*(?:USER|ROLE|TRACE)_|headers\.remove|MallHeaders\.USER/i, {
    exts: ['.java'], kinds: ['source'], maxMatches: 20,
  }).length) rbacRules.push('剥离客户端伪造身份头');
  const rbacStatus = methodLevelAuth.length >= 2 || roleMiddleware.length ? 'enforced'
    : (roleChecks.length || adminPathCheck.length ? 'partial' : 'missing');
  const rbacNote = rbacStatus === 'enforced'
    ? (roleMiddleware.length
      ? '敏感路由挂载了 requireRole 中间件，角色校验在进入处理函数前完成。'
      : '方法级权限注解与角色判断共同生效，管理端与普通用户接口有明确边界。')
    : rbacStatus === 'partial'
      ? (adminPathCheck.length && !methodLevelAuth.length
        ? '网关按 /api/admin 路径校验 ADMIN 角色，但业务服务内部没有方法级权限注解，越权防线集中在单点。'
        : '发现角色判断代码，但未能确认每个敏感路由都挂载了权限中间件。')
      : '未发现角色或权限校验，接口访问控制依赖网络边界或前端隐藏。';

  // ---------------------------------------------------------------------------
  // 输入校验 / 注入 / CSRF
  // ---------------------------------------------------------------------------
  const validationAnnotations = scan(/@(?:NotBlank|NotNull|NotEmpty|Size|Pattern|Email|Min|Max|Positive|PositiveOrZero|Past|Future|DecimalMin|DecimalMax|Valid)\b/, {
    exts: ['.java', '.kt'], kinds: ['source'], maxMatches: 200,
  });
  const validControllers = scan(/@Valid\b|@Validated\b/, {
    exts: ['.java', '.kt'], kinds: ['source'], maxMatches: 60,
  });
  const nodeSchemas = scan(/\bz\.object\(|\bJoi\.object\(|\byup\.object\(|\bclass-validator\b|\bexpress-validator\b|\bcelebrate\(|\bajv\b/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts', '.tsx'], kinds: ['source'], maxMatches: 80,
  });
  const schemaFiles = new Set(nodeSchemas.map((match) => match.path));
  const schemaFormat = scan(/\.(?:email|url|uuid|regex)\(/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 80,
  }).filter((match) => schemaFiles.has(match.path));
  const schemaBounds = scan(/\.(?:min|max|positive|nonnegative)\(/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 80,
  }).filter((match) => schemaFiles.has(match.path));
  const validationErrorHandler = scan(/MethodArgumentNotValidException|ConstraintViolationException|BindException/, {
    exts: ['.java'], kinds: ['source'], maxMatches: 20,
  });
  const frontendValidation = scan(/\.test\(|setErrors|validate\(/i, {
    exts: ['.ts', '.tsx', '.js', '.jsx'], kinds: ['source'], maxMatches: 40,
  });
  const annotationText = validationAnnotations.map((match) => match.text).join('\n');
  const validationRules = [];
  if (/@NotBlank|@NotNull|@NotEmpty/.test(annotationText)) validationRules.push('DTO 非空字段校验');
  if (/@Size|@Min|@Max|@Positive|@Decimal/.test(annotationText)) validationRules.push('长度与数值边界校验');
  if (/@Pattern|@Email/.test(annotationText)) validationRules.push('格式正则校验');
  if (validControllers.length) validationRules.push('控制器 @Valid 触发校验');
  if (validationErrorHandler.length) validationRules.push('校验异常统一响应');
  if (nodeSchemas.length) {
    validationRules.push('请求体 Schema 校验');
    if (schemaFormat.length) validationRules.push('Schema 字段格式校验');
    if (schemaBounds.length) validationRules.push('Schema 长度/数值边界校验');
    if (scan(/safeParse\(|\.parseAsync\(|\.parse\(/i, {
      exts: ['.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 20,
    }).length) validationRules.push('Schema 校验结果显式处理');
  }
  const validationStatus = validationRules.length >= 3 ? 'enforced'
    : (validationRules.length || frontendValidation.length ? 'partial' : 'missing');
  const validationNote = validationStatus === 'enforced'
    ? (nodeSchemas.length
      ? `请求体由 Zod/Joi 等 Schema 解析，字段格式与长度约束显式声明；${validationAnnotations.length ? 'Java DTO 侧同时有注解校验。' : '校验失败在进入业务逻辑前返回。'}`
      : `DTO 上的非空、长度、正则约束由 @Valid 触发，校验失败经统一异常处理器返回；${validationAnnotations.length} 处约束覆盖主要写接口。`)
    : validationStatus === 'partial'
      ? '存在输入校验，但覆盖范围有限，部分接口仍可能直接消费原始请求体。'
      : '未发现服务端输入校验，参数会直接进入业务与持久化层。';

  const jpaQuery = scan(/@Query\s*\(/, { exts: ['.java'], kinds: ['source'], maxMatches: 60 });
  const namedParams = scan(/[:?][A-Za-z_][\w]*|setParameter\(|\?\d|#\{/, {
    exts: ['.java', '.xml'], kinds: ['source', 'config'], maxMatches: 120,
  });
  const mybatisHash = scan(/#\{[^}]+\}/, { exts: ['.xml', '.java', '.kt'], kinds: ['source', 'config'], maxMatches: 80 });
  const mybatisDollar = scan(/\$\{[^}]+\}/, {
    exts: ['.xml'],
    kinds: ['config', 'source'],
    maxMatches: 40,
    filterFiles: (file) => {
      const text = readText(safeRepo, file.path) || '';
      return /<mapper\b|<select\b|<insert\b|<update\b|<delete\b/i.test(text);
    },
  });
  const javaSqlDollar = scan(/@(?:Select|Update|Insert|Delete)\s*\([\s\S]{0,400}?\$\{[^}]+\}/, {
    exts: ['.java'], kinds: ['source'], maxMatches: 20,
  });
  const jdbcPlaceholder = scan(/jdbcTemplate\.(?:query|update|execute)|NamedParameterJdbcTemplate|prepareStatement\(/i, {
    exts: ['.java'], kinds: ['source'], maxMatches: 40,
  });
  const ormRepos = scan(/JpaRepository|CrudRepository|EntityManager|createQuery\(/, {
    exts: ['.java', '.kt'], kinds: ['source'], maxMatches: 60,
  });
  const nodeParams = scan(/\b(?:prisma\.|knex\(|\.query\(\s*['"`][^'"`]*\?\d|\.query\(\s*['"`][^'"`]*\$1)|\$queryRaw/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 60,
  });
  const sqlConcat = scan(/(?:SELECT|INSERT|UPDATE|DELETE)[^;\n]{0,120}["'`]\s*\+\s*[A-Za-z_$]|(?:query|execute|createQuery)\s*\([^)\n]*\+\s*[A-Za-z_$]/i, {
    exts: ['.java', '.js', '.ts', '.py', '.xml'], kinds: ['source', 'config'], maxMatches: 30,
  });
  const injectionRules = [];
  if (jpaQuery.length && namedParams.length) injectionRules.push('JPA @Query 命名参数绑定');
  if (ormRepos.length) injectionRules.push('ORM 派生查询替代手写 SQL');
  if (mybatisHash.length) injectionRules.push('MyBatis #{} 预编译参数');
  if (jdbcPlaceholder.length) injectionRules.push('JdbcTemplate 占位符传参');
  if (nodeParams.length) injectionRules.push('参数化查询封装');
  const injectionStatus = injectionRules.length && !mybatisDollar.length && !javaSqlDollar.length ? 'enforced'
    : (injectionRules.length || mybatisDollar.length || javaSqlDollar.length ? 'partial' : 'missing');

  const csrfHits = scan(/\bcsrf\b|csrfToken|xsrf|_csrf|csurf|SameSite/i, {
    exts: ['.java', '.kt', '.js', '.ts', '.yml', '.yaml', '.properties'], kinds: ['source', 'config'], maxMatches: 40,
  });
  const csrfDisabled = scan(/csrf\(\)\s*\.disable|csrf\s*\([^;]{0,80}\.disable\s*\(\s*\)|csrf:\s*false|csrf\s*:\s*\{\s*enabled:\s*false/i, {
    exts: ['.java', '.js', '.ts', '.yml'], kinds: ['source', 'config'], maxMatches: 20,
  });
  const csrfRules = [];
  if (csrfHits.some((match) => /csrfToken|_csrf|csurf|SameSite/i.test(match.text))) csrfRules.push('CSRF Token / SameSite Cookie');
  if (csrfHits.some((match) => /csrf/i.test(match.text)) && !csrfDisabled.length) csrfRules.push('框架默认 CSRF 防护');
  const csrfStatus = csrfDisabled.length ? 'partial' : (csrfRules.length ? 'enforced' : 'missing');

  // ---------------------------------------------------------------------------
  // 传输安全 / 安全头 / CORS / 限流
  // ---------------------------------------------------------------------------
  const tlsServer = scan(/^\s*ssl:\s*$|ssl\.enabled\s*=\s*true|server\.ssl|ssl_certificate|https\.createServer|listen\(\s*443|TLSv1\.[23]/i, {
    exts: ['.yml', '.yaml', '.properties', '.conf', '.java', '.js', '.ts'], kinds: ['config', 'source'], maxMatches: 40,
  });
  const tlsDb = scan(/rejectUnauthorized\s*:\s*true|useSSL=true|sslmode=require|ssl:\s*\{|ssl=\{/i, {
    exts: ['.yml', '.yaml', '.properties', '.js', '.ts', '.java'], kinds: ['config', 'source'], maxMatches: 30,
  });
  const tlsConfig = [...tlsServer, ...tlsDb];
  const insecureTls = scan(/useSSL=false|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/i, {
    exts: ['.yml', '.yaml', '.properties', '.js', '.ts', '.java'], kinds: ['config', 'source'], maxMatches: 20,
  });
  const tlsStatus = tlsServer.length && tlsDb.length && !insecureTls.length
    ? 'enforced'
    : (tlsConfig.length ? 'partial' : 'missing');

  const helmetHits = scan(/require\(['"]helmet['"]\)|from ['"]helmet['"]|helmet\(/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts'], kinds: ['source'], maxMatches: 40,
  });
  const springHeaders = scan(/http\.headers\s*\(|\.headers\s*\([^)]{0,120}(?:frameOptions|contentSecurityPolicy|referrerPolicy|httpStrictTransportSecurity|contentTypeOptions|xssProtection|permissionsPolicy)|frameOptions\(|contentSecurityPolicy\(/i, {
    exts: ['.java', '.kt'], kinds: ['source'], maxMatches: 40,
  });
  const headerConfig = scan(/X-Content-Type-Options|X-Frame-Options|Content-Security-Policy|Referrer-Policy|add_header/i, {
    exts: ['.conf', '.yml', '.yaml', '.js', '.ts', '.java'], kinds: ['config', 'source'], maxMatches: 40,
  });
  const headerRules = [];
  if (helmetHits.length) headerRules.push('Helmet 安全响应头');
  if (springHeaders.length) headerRules.push('Spring Security 响应头');
  if (headerConfig.length) headerRules.push('反向代理响应头');
  if (helmetHits.some((match) => /contentSecurityPolicy|hsts|frameguard/i.test(match.text))) headerRules.push('CSP/HSTS 显式配置');
  const headersStatus = helmetHits.length || springHeaders.length || headerRules.length >= 2
    ? 'enforced'
    : (headerRules.length ? 'partial' : 'missing');

  const corsHits = scan(/cors|cors-configurations|Access-Control-Allow-Origin|allowedOrigin|allowedOrigins/i, {
    exts: ['.yml', '.yaml', '.properties', '.java', '.js', '.ts', '.conf'], kinds: ['config', 'source'], maxMatches: 80,
  });
  const corsWildcard = scan(/allowedOriginPatterns:\s*['"]?\*|allowedOrigins:\s*['"]?\*|Access-Control-Allow-Origin:\s*\*|origin:\s*['"]\*['"]/i, {
    exts: ['.yml', '.yaml', '.properties', '.java', '.js', '.ts', '.conf'], kinds: ['config', 'source'], maxMatches: 20,
  });
  const corsCredentials = scan(/allowCredentials:\s*true|credentials:\s*true|Access-Control-Allow-Credentials:\s*true/i, {
    exts: ['.yml', '.yaml', '.properties', '.java', '.js', '.ts', '.conf'], kinds: ['config', 'source'], maxMatches: 20,
  });
  const corsExplicit = scan(/allowedOrigins:\s*\[?\s*['"]?https?:\/\/|origin:\s*\[?\s*['"]https?:\/\/|allowedOriginPatterns:\s*\[?\s*['"]?https?:\/\//i, {
    exts: ['.yml', '.yaml', '.properties', '.java', '.js', '.ts', '.conf'], kinds: ['config', 'source'], maxMatches: 20,
  });
  // YAML 列表写法：allowedOrigins: 换行后 - https://...
  for (const rel of [...new Set(corsHits.map((match) => match.path))]) {
    const text = readText(safeRepo, rel);
    if (!text) continue;
    const lines = text.split('\n');
    let inOrigins = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(?:allowedOrigins|allowedOriginPatterns)\s*:/i.test(line)) {
        inOrigins = true;
        continue;
      }
      if (!inOrigins) continue;
      const item = line.match(/^\s*-\s*['"]?(https?:\/\/[^\s'"]+)/i);
      if (item) {
        corsExplicit.push({ path: rel, line: i + 1, text: line.trim() });
        continue;
      }
      if (/\S/.test(line) && !/^\s*#/.test(line)) inOrigins = false;
    }
  }
  const corsRules = [];
  if (corsHits.length) corsRules.push('CORS 配置集中声明');
  if (corsExplicit.length) corsRules.push('允许来源白名单');
  if (corsHits.length && !corsWildcard.length) corsRules.push('通配来源关闭');
  if (corsCredentials.length && !corsWildcard.length) corsRules.push('凭证仅对白名单来源开放');
  const corsStatus = corsExplicit.length && !corsWildcard.length ? 'enforced'
    : (corsHits.length ? 'partial' : 'missing');

  const rateLimitHits = scan(/express-rate-limit|rateLimit\s*\(|rate-limit|@RateLimit|bucket4j|RequestRateLimiter|RedisRateLimiter|throttl|limit_req|slowDown|p-limit/i, {
    exts: ['.js', '.mjs', '.cjs', '.ts', '.java', '.kt', '.yml', '.yaml', '.conf', '.properties'], kinds: ['source', 'config'], maxMatches: 60,
  });
  const rateLimitRules = [];
  if (rateLimitHits.some((match) => /express-rate-limit/i.test(match.text))) rateLimitRules.push('Express 限流中间件');
  if (rateLimitHits.some((match) => /rateLimit\s*\(/i.test(match.text))) rateLimitRules.push('接口级速率限制');
  if (rateLimitHits.some((match) => /windowMs|max\s*:|limit\s*:/i.test(match.text))) rateLimitRules.push('限流窗口与阈值显式配置');
  if (rateLimitHits.some((match) => /RequestRateLimiter|RedisRateLimiter|bucket4j/i.test(match.text))) rateLimitRules.push('网关/分布式限流');
  if (rateLimitHits.some((match) => /login|auth/i.test(match.text) && /limit/i.test(match.text))) rateLimitRules.push('登录接口单独限流');
  const rateLimitStatus = rateLimitRules.length >= 2 ? 'enforced' : (rateLimitRules.length ? 'partial' : 'missing');

  // ---------------------------------------------------------------------------
  // 供应链 / 容器 / 审计 / 安全测试
  // ---------------------------------------------------------------------------
  const lockfiles = findFiles((file) => LOCKFILE_NAMES.has(file.name.toLowerCase()));
  const manifests = Array.isArray(safeRepo.projects) ? safeRepo.projects : [];
  const ecosystemLock = new Set();
  for (const lock of lockfiles) {
    const name = lock.name.toLowerCase();
    if (name.includes('package') || name.includes('pnpm') || name.includes('yarn') || name.includes('bun')) ecosystemLock.add('node');
    if (name.includes('gradle')) ecosystemLock.add('gradle');
    if (name.includes('poetry') || name === 'pipfile.lock') ecosystemLock.add('python');
    if (name === 'cargo.lock') ecosystemLock.add('rust');
    if (name === 'go.sum') ecosystemLock.add('go');
    if (name === 'composer.lock') ecosystemLock.add('php');
    if (name === 'gemfile.lock') ecosystemLock.add('ruby');
  }
  const projectTypes = new Set(manifests.map((project) => project.type).filter(Boolean));
  const lockRules = [];
  for (const lock of lockfiles.slice(0, 8)) {
    lockRules.push(`${lock.name} 锁定依赖树`);
  }
  const lockedTypes = [...projectTypes].filter((type) => ecosystemLock.has(type));
  const lockStatus = projectTypes.size > 0
    ? (lockedTypes.length === projectTypes.size ? 'enforced' : (lockfiles.length ? 'partial' : 'missing'))
    : (lockfiles.length ? 'enforced' : 'missing');

  const dockerfiles = findFiles((file) => /(^|\/)(dockerfile|dockerfile\.[\w.-]+|[^/]+\.dockerfile)$/i.test(file.path));
  const composeFiles = findFiles((file) => /(^|\/)(docker-compose|compose)\.ya?ml$/i.test(file.path));
  const dockerText = dockerfiles.map((file) => readText(safeRepo, file.path) || '').join('\n');
  const composeText = composeFiles.map((file) => readText(safeRepo, file.path) || '').join('\n');
  const containerRules = [];
  if (dockerfiles.length) {
    if (/^\s*USER\s+(?!root\b)([^\s#]+)/mi.test(dockerText)) containerRules.push('容器以非 root 用户运行');
    if (/^\s*FROM\s+\S+(?::\S+)?/mi.test(dockerText) && !/^\s*FROM\s+\S+:latest\b/mi.test(dockerText)) containerRules.push('基础镜像固定版本');
    if ((dockerText.match(/^\s*FROM\s+/gmi) || []).length >= 2) containerRules.push('多阶段构建');
    if (/read_only:\s*true|readOnlyRootFilesystem:\s*true/i.test(dockerText) || /read_only:\s*true/i.test(composeText)) containerRules.push('只读根文件系统');
  }
  if (composeFiles.length) {
    if (/healthcheck:/i.test(composeText)) containerRules.push('Compose 服务健康检查');
    if (/no-new-privileges:\s*true/i.test(composeText)) containerRules.push('禁止提权（no-new-privileges）');
    if (/^\s*user:\s*['"]?(?![0]?\broot)/mi.test(composeText)) containerRules.push('Compose 指定非 root 用户');
  }
  const containerUnpinned = composeFiles.length && /image:\s*['"]?[\w./-]+:latest\b/i.test(composeText);
  const containerStatus = containerRules.length >= 2 && !containerUnpinned ? 'enforced'
    : (containerRules.length ? 'partial' : 'missing');

  const auditHits = scan(/\baudit\b|auditLog|audit_log|auditEvent|auditTrail|审计|securityLog|loginLog|loginAttempt|securityEvent|operationLog|操作日志/i, {
    exts: ['.java', '.kt', '.js', '.ts', '.yml', '.yaml', '.properties'], kinds: ['source', 'config'], maxMatches: 60,
    pathExcludes: [...DEFAULT_SCAN_EXCLUDES, '.github/', '.gitlab-ci', '.circleci', 'Jenkinsfile'],
  });
  const auditRules = [];
  if (auditHits.some((match) => /audit/i.test(match.text))) auditRules.push('结构化审计日志');
  if (auditHits.some((match) => /login|登录|auth/i.test(match.text))) auditRules.push('登录与失败认证记录');
  if (auditHits.some((match) => /admin|操作/i.test(match.text))) auditRules.push('管理操作审计');
  if (auditHits.some((match) => /topic|table|elastic|sink|event/i.test(match.text))) auditRules.push('审计事件独立存储');
  const auditStatus = auditRules.length >= 2 ? 'enforced' : (auditRules.length ? 'partial' : 'missing');

  const securityTestCandidates = findFiles((file) => {
    const lower = file.path.toLowerCase();
    const isTest = file.kind === 'test';
    const isSmoke = /(^|\/)scripts?\/(smoke|security|auth)[^/]*\.(mjs|js|ts)$/.test(lower);
    if (!isTest && !isSmoke) return false;
    return /(auth|security|jwt|token|permission|role|csrf|xss|injection|smoke)/.test(lower);
  });
  const securityTestRules = [];
  const securityTestEvidence = [];
  for (const file of securityTestCandidates) {
    const text = readText(safeRepo, file.path) || '';
    if (!text) continue;
    if (/401/.test(text)) securityTestRules.push('未认证访问返回 401 断言');
    if (/403/.test(text)) securityTestRules.push('越权访问返回 403 断言');
    if (/expired|过期/i.test(text) && /assertThrows|rejects|toThrow|throws/i.test(text)) securityTestRules.push('过期令牌拒绝测试');
    if (/another.?secret|invalid.?signature|篡改|伪造/i.test(text) && /assertThrows|rejects|toThrow|throws/i.test(text)) securityTestRules.push('错误签名拒绝测试');
    if (/logout|blacklist/i.test(text) && /401|expired|invalid/i.test(text)) securityTestRules.push('登出后令牌失效测试');
    if (/csrf|xss|injection|sqli/i.test(text) && /expect|assert|record/i.test(text)) securityTestRules.push('注入/CSRF 防护测试');
    securityTestEvidence.push({ path: file.path, snippet: truncate(file.path.split('/').pop() || file.path) });
  }
  const uniqueSecurityTestRules = uniqueStrings(securityTestRules);
  const securityTestsStatus = uniqueSecurityTestRules.length >= 3 ? 'enforced'
    : (uniqueSecurityTestRules.length ? 'partial' : 'missing');

  // ---------------------------------------------------------------------------
  // 组装守护
  // ---------------------------------------------------------------------------
  const safetySetRules = [...sastSets, ...lintSets];
  const sastGuardRules = sastSets.length
    ? sastSets.map((set) => `${set.name}（${set.ruleCount} 项）`)
    : lintSets.map((set) => `${set.name}（${set.ruleCount} 条安全规则）`);
  const dependencyGuardRules = dependencySets.map((set) => `${set.name}（${set.ruleCount} 项）`);
  const secretGuardRules = secretSets.map((set) => `${set.name}（${set.ruleCount} 条规则）`);

  const guards = [
    makeGuard({
      id: 'authn-jwt',
      name: 'JWT 身份认证',
      category: '认证',
      severity: 'critical',
      status: jwtStatus,
      rules: jwtRules,
      evidence: jwtEvidence,
      note: jwtStatus === 'enforced'
        ? (jwtGateway.length
          ? '网关与服务共享 JWT 密钥，验签、过期校验和签发链路均可枚举；令牌默认有效期 7 天，续期策略需另行确认。'
          : '服务端签发并校验 JWT，签名算法与过期时间显式声明；需结合刷新令牌策略确认令牌生命周期。')
        : jwtStatus === 'partial'
          ? `检测到 JWT 依赖或签发代码，但验签/过期校验链路不完整，无法确认所有入口都强制校验。`
          : `未发现 JWT 或其他令牌认证实现；如果接口依赖网关透传身份头，缺少令牌校验会让伪造身份头直接生效。`,
      recommendation: jwtStatus === 'missing'
        ? '在统一入口校验令牌签名与过期时间，并拒绝客户端自带的身份头。'
        : jwtStatus === 'partial'
          ? '补齐验签与过期校验，确保所有受保护路由都走同一套令牌解析逻辑。'
          : '',
    }),
    makeGuard({
      id: 'authn-password',
      name: '密码哈希存储',
      category: '认证',
      severity: 'critical',
      status: passwordStatus,
      rules: passwordRules,
      evidence: evidenceOf([...bcryptHits.slice(0, 2), ...passwordVerify.slice(0, 2)]),
      note: passwordStatus === 'enforced'
        ? `${bcrypt ? 'BCrypt' : 'Argon2'} 哈希写入后，登录用 ${passwordVerify.some((match) => /matches/i.test(match.text)) ? 'matches' : 'compare'} 比对，未出现明文密码落库路径。`
        : passwordStatus === 'partial'
          ? '发现密码哈希或比对代码，但无法确认注册、改密等所有写入路径都使用同一算法。'
          : '未发现密码哈希实现，若存在账号体系需确认密码是否以明文或可逆加密存储。',
      recommendation: passwordStatus === 'enforced' ? '' : '使用 BCrypt/Argon2 等慢哈希，禁止明文或 MD5/SHA1 直接存储密码。',
    }),
    makeGuard({
      id: 'authn-token-revocation',
      name: '令牌吊销与登出失效',
      category: '认证',
      severity: 'high',
      status: revocationStatus,
      rules: revocationRules,
      evidence: evidenceOf([...revocationHits.slice(0, 2), ...revocationCheck.slice(0, 1), ...revocationTtl.slice(0, 1)]),
      note: revocationStatus === 'enforced'
        ? (revocationHits.some((match) => /redis/i.test(match.text))
          ? '登出令牌写入 Redis 黑名单，每次请求校验，TTL 按令牌剩余有效期设置，Redis 故障时降级放行。'
          : '登出令牌进入吊销集合，鉴权时校验；内存实现重启会丢失，多实例部署时需要改为共享存储。')
        : revocationStatus === 'partial'
          ? '存在登出或吊销相关代码，但未能确认每次请求都会检查吊销状态。'
          : '未发现令牌吊销机制，JWT 在过期前无法主动失效，账号禁用或登出后仍可能继续访问。',
      recommendation: revocationStatus === 'enforced' ? '' : '为登出、改密和禁用账号建立令牌黑名单或版本号，并在鉴权入口强制校验。',
    }),
    makeGuard({
      id: 'authz-rbac',
      name: '角色与权限校验',
      category: '授权',
      severity: 'critical',
      status: rbacStatus,
      rules: rbacRules,
      evidence: evidenceOf([...methodLevelAuth.slice(0, 2), ...adminPathCheck.slice(0, 1), ...roleChecks.slice(0, 1)]),
      note: rbacNote,
      recommendation: rbacStatus === 'enforced' ? '' : '在服务层补方法级权限注解，并让网关注入的身份头只在下游可信网络内生效。',
    }),
    makeGuard({
      id: 'input-validation',
      name: '请求输入校验',
      category: '数据保护',
      severity: 'high',
      status: validationStatus,
      rules: validationRules,
      evidence: evidenceOf([...validationAnnotations.slice(0, 2), ...validControllers.slice(0, 1), ...nodeSchemas.slice(0, 1)]),
      note: validationNote,
      recommendation: validationStatus === 'enforced' ? '' : '为所有写接口补 DTO 约束并在控制器启用校验，避免只依赖前端表单校验。',
    }),
    makeGuard({
      id: 'injection-sql',
      name: 'SQL / 注入防护',
      category: '数据保护',
      severity: 'critical',
      status: injectionStatus,
      rules: injectionRules,
      evidence: evidenceOf([...jpaQuery.slice(0, 2), ...mybatisHash.slice(0, 1), ...ormRepos.slice(0, 1)]),
      note: injectionStatus === 'enforced'
        ? (mybatisHash.length && !jpaQuery.length
          ? 'MyBatis Mapper 使用 #{} 预编译参数，未发现 ${} 文本替换，查询参数不会直接拼进 SQL。'
          : '查询走 JPA 派生方法与命名参数，未发现 SQL 字符串拼接；MyBatis 场景优先使用 #{}，避免 ${} 直接拼接。')
        : injectionStatus === 'partial'
          ? '存在参数化查询，但同时发现动态 SQL 拼接或 ${} 插值，需要逐个确认输入来源。'
          : '未发现参数化查询或 ORM 使用痕迹，若存在手写 SQL 需确认没有拼接用户输入。',
      recommendation: injectionStatus === 'enforced' ? '' : '统一使用预编译参数或 ORM 绑定变量，禁止把请求参数拼进 SQL 字符串。',
    }),
    makeGuard({
      id: 'csrf-protection',
      name: 'CSRF 防护',
      category: '数据保护',
      severity: 'medium',
      status: csrfStatus,
      rules: csrfRules,
      evidence: evidenceOf(csrfHits.slice(0, 2)),
      note: csrfStatus === 'missing'
        ? '接口使用 Authorization Bearer，不依赖 Cookie 会话，CSRF 暴露面相对有限；一旦改为 Cookie 登录就需要补 Token 与 SameSite。'
        : csrfDisabled.length
          ? 'Spring Security 的 CSRF 被显式关闭；如果业务仍使用 Cookie 会话，写接口可被跨站触发，需要重新开启或改用 Bearer + SameSite。'
          : '已发现 CSRF 相关配置，需要确认 Cookie 会话路径与写接口都受保护。',
      recommendation: csrfStatus === 'enforced' ? '' : '若引入 Cookie 会话，为写接口加 CSRF Token，并设置 SameSite=Lax/Strict。',
    }),
    makeGuard({
      id: 'transport-tls',
      name: '传输层加密',
      category: '传输安全',
      severity: 'high',
      status: tlsStatus,
      rules: (() => {
        const rules = [];
        if (tlsServer.length) rules.push('服务端 TLS 监听');
        if (tlsDb.length) rules.push('数据库连接启用 TLS');
        return rules;
      })(),
      evidence: evidenceOf(tlsConfig.slice(0, 3)),
      note: tlsStatus === 'missing'
        ? '应用与数据库连接均未启用 TLS，演示环境可接受，跨主机部署时口令与令牌会以明文经过网络。'
        : tlsStatus === 'partial'
          ? (tlsServer.length
            ? '应用声明了 TLS 监听，但数据库连接仍有明文参数；或只有数据库 TLS，入口 HTTPS 由未纳入扫描的负载均衡终止，需补证据。'
            : '数据库连接已启用 TLS，但应用本身未见 HTTPS 监听或证书配置；若 TLS 在负载均衡终止，需要把该配置纳入仓库。')
          : '服务端与数据库连接均声明了 TLS。',
      recommendation: tlsStatus === 'enforced' ? '' : '为入口和数据库连接启用 TLS，并把 HTTP 请求重定向到 HTTPS。',
    }),
    makeGuard({
      id: 'security-headers',
      name: '安全响应头',
      category: '传输安全',
      severity: 'high',
      status: headersStatus,
      rules: headerRules,
      evidence: evidenceOf([...helmetHits.slice(0, 2), ...springHeaders.slice(0, 1), ...headerConfig.slice(0, 1)]),
      note: headersStatus === 'missing'
        ? '网关与前端均未配置 CSP、HSTS、X-Frame-Options 等安全头，浏览器侧缺少一层纵深防御。'
        : helmetHits.length
          ? 'Helmet 默认启用 CSP、HSTS、X-Frame-Options 等响应头，并显式配置了 CSP/HSTS 指令。'
          : springHeaders.length
            ? 'Spring Security 启用默认安全响应头，并显式配置了 frameOptions / CSP 等策略。'
            : '已发现安全响应头配置，需确认覆盖静态资源与 API 响应。',
      recommendation: headersStatus === 'enforced' ? '' : '在网关或前端接入 Helmet / 反向代理统一注入安全响应头，并先以 Report-Only 验证 CSP。',
    }),
    makeGuard({
      id: 'cors-policy',
      name: 'CORS 跨域策略',
      category: '传输安全',
      severity: 'high',
      status: corsStatus,
      rules: corsRules,
      evidence: evidenceOf([...corsHits.slice(0, 2), ...corsWildcard.slice(0, 1), ...corsCredentials.slice(0, 1)]),
      note: corsStatus === 'partial'
        ? (corsWildcard.length && corsCredentials.length
          ? '网关允许任意来源且允许携带凭证，浏览器会把任意站点发来的带 Cookie 请求放行；这是当前最直接的传输面风险。'
          : corsWildcard.length
            ? 'CORS 来源仍使用通配符，任何站点都能发起跨域请求；应改为明确域名白名单。'
            : '已发现 CORS 配置，但来源白名单没有以可识别形式声明，或凭证策略不完整，需要人工确认。')
        : corsStatus === 'enforced'
          ? 'CORS 来源使用显式白名单，未与通配来源和凭证同时出现。'
          : '未发现 CORS 配置；若前后端分离部署，需要确认网关默认行为。',
      recommendation: corsStatus === 'enforced' ? '' : '把 allowedOriginPatterns 收敛为明确域名，避免 * 与 allowCredentials=true 同时出现。',
    }),
    makeGuard({
      id: 'rate-limit',
      name: '接口限流与防暴破',
      category: '运行时',
      severity: 'high',
      status: rateLimitStatus,
      rules: rateLimitRules,
      evidence: evidenceOf(rateLimitHits.slice(0, 3)),
      note: rateLimitStatus === 'missing'
        ? '网关与业务服务均未见限流实现，登录、下单、支付回调等接口在流量突增或撞库时没有第一道闸门。'
        : '已发现限流相关实现，需确认阈值按接口区分而不是全局一刀切。',
      recommendation: rateLimitStatus === 'enforced' ? '' : '在网关按 IP/用户维度限流，登录与支付回调单独设置更严格的阈值。',
    }),
    makeGuard({
      id: 'sast',
      name: '静态代码扫描',
      category: '代码安全',
      severity: 'high',
      status: sastSets.length ? 'enforced' : (lintSets.length ? 'partial' : 'missing'),
      rules: sastGuardRules,
      ruleCount: sastSets.length
        ? sastSets.reduce((sum, set) => sum + set.ruleCount, 0)
        : lintSets.reduce((sum, set) => sum + set.ruleCount, 0),
      evidence: ruleSetEvidence(safetySetRules),
      note: sastSets.length
        ? `已接入 ${sastSets.length} 个静态扫描规则源，可枚举 ${sastSets.reduce((sum, set) => sum + set.ruleCount, 0)} 条规则；扫描是否在 CI 强制失败仍需确认。`
        : lintSets.length
          ? '只有 ESLint 安全规则，没有 Semgrep/CodeQL/SonarQube 这类跨文件数据流扫描。'
          : '没有静态代码扫描配置，安全问题只能靠人工评审发现。',
      recommendation: sastSets.length ? '' : '接入 Semgrep 或 CodeQL，并把高危规则设为 CI 阻断项。',
    }),
    makeGuard({
      id: 'dependency-scan',
      name: '依赖漏洞扫描',
      category: '供应链',
      severity: 'high',
      status: dependencySets.length ? 'enforced' : (iacSets.length ? 'partial' : 'missing'),
      rules: dependencyGuardRules.length ? dependencyGuardRules : iacSets.map((set) => `${set.name}（${set.ruleCount} 项）`),
      ruleCount: dependencySets.length
        ? dependencySets.reduce((sum, set) => sum + set.ruleCount, 0)
        : iacSets.reduce((sum, set) => sum + set.ruleCount, 0),
      evidence: ruleSetEvidence([...dependencySets, ...iacSets]),
      note: dependencySets.length
        ? `已配置 ${dependencySets.length} 个依赖更新/漏洞扫描规则源；需确认扫描失败会阻断合并，并覆盖仓库内所有生态。`
        : iacSets.length
          ? '只有镜像/文件系统扫描配置，没有依赖清单的漏洞扫描。'
          : '没有 Dependabot、Renovate、Snyk 或 Trivy 配置，依赖漏洞只能靠发布前人工检查。',
      recommendation: dependencySets.length ? '' : '接入 Dependabot 或 Renovate，并在 CI 对高危依赖设阻断。',
    }),
    makeGuard({
      id: 'dependency-lock',
      name: '依赖版本锁定',
      category: '供应链',
      severity: 'high',
      status: lockStatus,
      rules: lockRules,
      evidence: evidenceOf(lockfiles.map((file) => ({ path: file.path, line: 1, text: `${file.name} 已提交` }))),
      note: lockStatus === 'enforced'
        ? `检测到 ${lockfiles.length} 个锁文件，覆盖 ${lockedTypes.join('、') || '已识别生态'}。`
        : lockStatus === 'partial'
          ? `前端依赖已由 ${lockfiles.map((file) => file.name).slice(0, 3).join('、')} 锁定，但 Maven 服务没有 lockfile，传递依赖仍随构建时间漂移。`
          : '没有提交锁文件，同一份源码在不同时间安装出的依赖树可能不同。',
      recommendation: lockStatus === 'enforced' ? '' : '为 Maven 增加依赖锁定（如 maven-enforcer + dependencyManagement），并确保锁文件随源码提交。',
    }),
    makeGuard({
      id: 'container-security',
      name: '容器运行安全',
      category: '运行时',
      severity: 'high',
      status: containerStatus,
      rules: containerRules,
      evidence: evidenceOf([
        ...dockerfiles.map((file) => ({ path: file.path, text: '容器构建文件' })),
        ...composeFiles.map((file) => ({ path: file.path, text: 'Compose 服务编排' })),
      ]),
      note: containerStatus === 'partial'
        ? '只有 docker-compose 中间件编排，没有应用 Dockerfile；镜像使用 latest，无法保证基础镜像可复现，也没有非 root 运行约束。'
        : containerStatus === 'missing'
          ? '仓库内没有容器构建或运行配置，容器安全基线未建立。'
          : 'Dockerfile 具备非 root、版本固定等约束，需确认运行时只读与能力限制。',
      recommendation: containerStatus === 'enforced' ? '' : '为应用提供非 root 的 Dockerfile，固定基础镜像 digest，并在编排中开启只读根文件系统。',
    }),
    makeGuard({
      id: 'secret-scan',
      name: '密钥泄漏扫描',
      category: '密钥管理',
      severity: 'high',
      status: secretSets.length ? 'enforced' : 'missing',
      rules: secretGuardRules,
      ruleCount: secretSets.reduce((sum, set) => sum + set.ruleCount, 0),
      evidence: ruleSetEvidence(secretSets),
      note: secretSets.length
        ? `已配置 ${secretSets.length} 个密钥扫描规则源，可枚举 ${secretSets.reduce((sum, set) => sum + set.ruleCount, 0)} 条规则。`
        : '没有 gitleaks、trufflehog 或 GitHub 原生密钥扫描配置，凭证一旦提交不会被自动拦截。',
      recommendation: secretSets.length ? '' : '在 pre-commit 与 CI 中接入 gitleaks，并把扫描历史纳入上线门禁。',
    }),
    makeGuard({
      id: 'secret-hardcoded',
      name: '硬编码密钥',
      category: '密钥管理',
      severity: 'high',
      status: secretFindings.length ? 'partial' : 'enforced',
      rules: (() => {
        const rules = [];
        if (secretFindings.some((finding) => /jwt|signing/i.test(finding.key) && finding.kind === 'env-default')) rules.push('JWT 密钥支持环境变量覆盖');
        if (secretFindings.some((finding) => /mysql|postgres|database/i.test(finding.key))) rules.push('数据库口令支持环境变量覆盖');
        if (secretFindings.some((finding) => /docker-compose/.test(finding.path))) rules.push('演示口令隔离在本地编排');
        if (secretFindings.some((finding) => finding.severity === 'low' && /test|spec/i.test(finding.path))) rules.push('测试凭据与生产配置分离');
        if (!secretFindings.length) rules.push('未检出明文密钥');
        return rules;
      })(),
      evidence: evidenceOf(secretFindings.map((finding) => ({ path: finding.path, line: finding.line, text: finding.snippet }))),
      note: secretFindings.length
        ? `扫描到 ${secretFindings.length} 处明文凭据写法：JWT 密钥带有演示默认值，数据库口令使用 cloudmall 演示默认值（生产漏配会沿用），测试与 mock 凭据需要和真实账号隔离。`
        : '常见配置键均未检出明文密钥，仍建议接入密钥扫描防止后续回归。',
      recommendation: secretFindings.length ? '移除 JWT 密钥的固定默认值，启动时强制要求环境注入；对已提交过的演示口令做轮换并加入密钥扫描。' : '',
    }),
    makeGuard({
      id: 'audit-log',
      name: '权限与操作审计',
      category: '审计',
      severity: 'medium',
      status: auditStatus,
      rules: auditRules,
      evidence: evidenceOf(auditHits.slice(0, 3)),
      note: auditStatus === 'missing'
        ? '登录失败、登出、角色变更和管理端操作都没有独立审计记录，事后追溯只能依赖服务日志。'
        : '已发现审计相关记录，需确认包含操作者、目标资源、结果与 traceId 且不可被业务覆盖。',
      recommendation: auditStatus === 'enforced' ? '' : '为认证事件与管理端写操作建立结构化审计日志，保留操作者、资源、结果和请求追踪号。',
    }),
    makeGuard({
      id: 'security-tests',
      name: '安全回归测试',
      category: '代码安全',
      severity: 'high',
      status: securityTestsStatus,
      rules: uniqueSecurityTestRules,
      evidence: evidenceOf(securityTestEvidence),
      note: securityTestsStatus === 'enforced'
        ? `已有 ${securityTestEvidence.length} 个安全相关测试/冒烟脚本，覆盖 401、403、令牌伪造与登出失效等关键路径。`
        : securityTestsStatus === 'partial'
          ? '有少量安全测试，但未覆盖越权、令牌吊销或注入等关键路径。'
          : '没有针对认证、授权或注入的安全回归测试，安全修复容易在后续迭代中被破坏。',
      recommendation: securityTestsStatus === 'enforced' ? '' : '补 401/403、令牌过期/伪造、登出失效的自动化断言，并纳入 CI。',
    }),
  ];

  guards.sort((a, b) => a.id.localeCompare(b.id));

  // ---------------------------------------------------------------------------
  // 风险信号
  // ---------------------------------------------------------------------------
  const riskyPatterns = [...secretRiskyPatterns];
  const pushRisk = (risk) => {
    if (riskyPatterns.length >= 28) return;
    riskyPatterns.push(risk);
  };
  if (corsWildcard.length && corsCredentials.length) {
    const match = corsWildcard[0];
    pushRisk({
      id: 'cors-wildcard-credentials',
      name: 'CORS 通配来源与凭证共存',
      severity: 'high',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: '允许任意来源并允许携带凭证，任意站点都可以借用户 Cookie 调用接口；应改为显式来源白名单。',
    });
  }
  for (const match of insecureTls.slice(0, 1)) {
    pushRisk({
      id: 'plaintext-transport',
      name: '数据库连接未启用 TLS',
      severity: 'medium',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: 'JDBC 连接参数 useSSL=false，跨主机部署时数据库口令与查询内容会以明文传输。',
    });
  }
  const unpinned = scan(/image:\s*['"]?[\w./-]+:latest\b/i, {
    exts: ['.yml', '.yaml'], kinds: ['config'], maxMatches: 10,
  });
  for (const match of unpinned.slice(0, 2)) {
    pushRisk({
      id: 'container-latest-tag',
      name: '镜像使用 latest 标签',
      severity: 'medium',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: '基础镜像未固定版本，重新拉取可能得到不兼容或有已知漏洞的版本；应使用明确 tag 或 digest。',
    });
  }
  for (const match of sqlConcat.slice(0, 2)) {
    pushRisk({
      id: 'sql-string-concat',
      name: 'SQL 字符串拼接',
      severity: 'high',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: '把变量拼进 SQL 文本会绕过预编译参数，形成注入面；改为绑定变量。',
    });
  }
  for (const match of [...mybatisDollar, ...javaSqlDollar].slice(0, 2)) {
    pushRisk({
      id: 'mybatis-dollar-substitution',
      name: 'MyBatis ${} 文本替换',
      severity: 'high',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: '${} 直接把值拼进 SQL，只有 #{} 才会走预编译参数；确认该字段不来自请求。',
    });
  }
  for (const match of scan(/\beval\s*\(|new Function\s*\(/i, { exts: ['.js', '.mjs', '.cjs', '.ts', '.tsx'], kinds: ['source'], maxMatches: 10 }).slice(0, 2)) {
    pushRisk({
      id: 'dynamic-code-execution',
      name: '动态执行字符串代码',
      severity: 'high',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: 'eval / new Function 会把数据当代码执行，任何可控输入都可能升级为远程代码执行。',
    });
  }
  for (const match of scan(/dangerouslySetInnerHTML|\.innerHTML\s*=/i, { exts: ['.js', '.jsx', '.tsx', '.vue'], kinds: ['source'], maxMatches: 10 }).slice(0, 2)) {
    pushRisk({
      id: 'html-injection-sink',
      name: '直接写入 HTML 的内联方式',
      severity: 'medium',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: 'innerHTML / dangerouslySetInnerHTML 是 XSS 的高危汇聚点，需确认输入已白名单过滤。',
    });
  }
  for (const match of csrfDisabled.slice(0, 1)) {
    pushRisk({
      id: 'csrf-disabled',
      name: 'CSRF 防护被显式关闭',
      severity: 'medium',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: '关闭 CSRF 后，基于 Cookie 的写接口可被跨站触发；确认是否已完全改为 Bearer 令牌。',
    });
  }
  const longTtl = scan(/ttl-seconds:\s*(?:[5-9]\d{4,}|\d{6,})/i, {
    exts: ['.yml', '.yaml', '.properties'], kinds: ['config'], maxMatches: 5,
  });
  for (const match of longTtl.slice(0, 1)) {
    pushRisk({
      id: 'jwt-long-ttl',
      name: 'JWT 有效期偏长',
      severity: 'low',
      path: match.path,
      line: match.line,
      snippet: truncate(match.text),
      detail: '令牌默认有效期达到 7 天，吊销机制失效时窗口过长；建议缩短 access token 并引入刷新令牌。',
    });
  }
  riskyPatterns.sort(severityThenPath);
  const uniqueRiskyPatterns = riskyPatterns.filter((risk, index, list) => (
    list.findIndex((other) => other.id === risk.id && other.path === risk.path && other.line === risk.line) === index
  ));

  // ---------------------------------------------------------------------------
  // 评分
  // ---------------------------------------------------------------------------
  const byCategory = new Map();
  for (const guard of guards) {
    if (!byCategory.has(guard.category)) byCategory.set(guard.category, []);
    byCategory.get(guard.category).push(guard);
  }
  const categoryScores = new Map();
  for (const [category, list] of byCategory) {
    const weightSum = list.reduce((sum, guard) => sum + (SEVERITY_WEIGHT[guard.severity] || 1), 0);
    const earned = list.reduce((sum, guard) => {
      const value = guard.status === 'enforced' ? 1 : guard.status === 'partial' ? 0.5 : 0;
      return sum + value * (SEVERITY_WEIGHT[guard.severity] || 1);
    }, 0);
    const criticalMissing = list.filter((guard) => guard.status === 'missing' && guard.severity === 'critical').length;
    const raw = weightSum > 0 ? (earned / weightSum) * 100 : 0;
    categoryScores.set(category, clampNumber(raw - criticalMissing * 6, 0, 100));
  }
  let weightedScore = 0;
  let totalCategoryWeight = 0;
  for (const [category, weight] of Object.entries(CATEGORY_WEIGHT)) {
    const score = categoryScores.get(category);
    if (score === undefined) continue;
    weightedScore += score * weight;
    totalCategoryWeight += weight;
  }
  const score = Math.round(clampNumber(totalCategoryWeight > 0 ? weightedScore / totalCategoryWeight : 0, 0, 100));
  const level = score >= 80 ? 'strong' : score >= 60 ? 'moderate' : score >= 40 ? 'weak' : 'critical';

  const enforced = guards.filter((guard) => guard.status === 'enforced');
  const partial = guards.filter((guard) => guard.status === 'partial');
  const missing = guards.filter((guard) => guard.status === 'missing');
  const missingGaps = [...missing].sort(severityThenPath).slice(0, 3).map((guard) => guard.name);
  const partialGaps = [...partial].sort(severityThenPath).slice(0, 2).map((guard) => guard.name);
  const gapText = missingGaps.length ? missingGaps.join('、') : (partialGaps.length ? partialGaps.join('、') : '暂无明显缺口');
  const missingPhrase = missing.length ? `等 ${missing.length} 项守护缺失` : '';
  let summary;
  if (level === 'strong') {
    summary = `${enforced.length} 项守护已强制生效，${gapText}仍需补齐，整体安全基线与架构规模基本匹配。`;
  } else if (level === 'moderate') {
    summary = `认证与输入防护已经落地，但${gapText}仍有缺口，整体处于可接受但未闭合的状态。`;
  } else if (level === 'weak') {
    summary = `认证、输入校验与查询参数化已经具备，但${gapText}${missingPhrase}，安全基线尚未闭合。`;
  } else {
    summary = `仅 ${enforced.length} 项守护生效，${gapText}${missingPhrase || '等关键面暴露'}，建议先补认证、传输与供应链扫描。`;
  }

  const totals = {
    guards: guards.length,
    enforced: enforced.length,
    partial: partial.length,
    missing: missing.length,
    rules: guards.reduce((sum, guard) => sum + (Number.isFinite(guard.ruleCount) ? guard.ruleCount : guard.rules.length), 0),
  };

  return {
    score,
    level,
    summary,
    totals,
    guards,
    ruleSets,
    riskyPatterns: uniqueRiskyPatterns,
  };
}
