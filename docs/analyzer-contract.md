# ArcVista 分析器内部契约（v1）

所有分析器都是纯函数：输入 `repo`（扫描结果）、上下文，输出可 JSON 序列化的普通对象。
禁止引入第三方依赖；ESM；Node >= 22。输出必须确定性（同输入同输出，无随机、无时间戳、无绝对路径）。

## 1. repo（lib/analyze/walk.js）

```js
repo = {
  root,                                   // 绝对路径，禁止写进输出
  files: [{
    path,        // 相对路径，正斜杠
    abs, name, dir, ext, lang,            // lang 见 LANG_BY_EXT
    kind,        // 'source' | 'test' | 'doc' | 'config' | 'asset'
    size, loc, isText, depth
  }],
  fileByPath: Map<path, file>,
  projects: [{ dir, path, type, manifest }],   // type: node|maven|gradle|go|rust|python|php|ruby|dart
  languages: [{ lang, files, loc }],
  totals: { files, textFiles, sourceFiles, testFiles, docFiles, configFiles, loc, sourceLoc, testLoc, docLoc },
  truncated: boolean,
  read(path) -> string|null,              // 带缓存，超限/二进制返回 null
  readJson(path) -> object|null,
  grep(pattern, { exts, pathIncludes, pathExcludes, kinds, maxMatches, maxFiles, flags, filterFiles })
     -> [{ path, line, text, match }],
  find({ exts, includes, excludes, basename, kinds }) -> [file],
  sourceFiles(), testFiles(), textFiles
}
```

## 2. modulesInfo / graph（lib/analyze/modules.js + graph.js）

```js
modulesInfo = {
  modules: [{
    id, path, name, packageName, type, group: 'frontend'|'backend', label,
    files, sourceFiles, testFiles, loc, sourceLoc, testLoc,
    langs: [{ lang, count }], parentId
  }],
  moduleMap: Map<id, module>,
  byFile: Map<filePath, moduleId>
}

graph = {
  fileEdges: [{ from, to }],                       // 已解析的仓库内文件依赖
  moduleEdges: [{ from, to, count }],
  externalByModule: { [moduleId]: [{ pkg, count }] },
  stats: { files, internalFileEdges, moduleEdges, externalSpecs, unresolved }
}
```

## 3. security.js

`export function analyzeSecurity(repo, ctx)`，`ctx = { modulesInfo, graph, deps }`。
面向“架构守护”而不是漏洞扫描：检测代码库中真实存在的守护机制与规则，并给出可 diff 的规则清单。

```js
{
  score: 0-100,                    // 守护覆盖率评分，越高越安全
  level: 'strong'|'moderate'|'weak'|'critical',
  summary: '一中文句话结论',
  totals: { guards, enforced, partial, missing, rules },
  guards: [{
    id,                            // 稳定 kebab id，例如 'authn-jwt'，用于分支 diff
    name,                          // 中文名，例如 'JWT 身份认证'
    category,                      // '认证'|'授权'|'数据保护'|'传输安全'|'供应链'|'代码安全'|'密钥管理'|'运行时'|'审计'
    status,                        // 'enforced'|'partial'|'missing'
    severity,                      // 'critical'|'high'|'medium'|'low'（若缺失，风险等级）
    ruleCount,                     // 该守护下可枚举的规则/控制点数量
    rules: [string],               // 可 diff 的规则名（中文），例如 '校验 JWT 签名'
    evidence: [{ path, line, snippet }],  // line 可省略；最多 4 条
    note,                          // 中文补充说明
    recommendation                 // 中文改进建议（missing/partial 时）
  }],
  ruleSets: [{
    id, name, kind: 'sast'|'dependency'|'secret'|'lint'|'iac'|'custom',
    path,                          // 规则文件路径（可为 null）
    ruleCount, rules: [string]     // 每条规则的稳定可 diff 名称
  }],
  riskyPatterns: [{
    id, name, severity, path, line, snippet, detail   // 代码里的反模式/危险信号
  }]
}
```

要求：
- 覆盖至少这些守护族：身份认证、授权/RBAC、输入校验、SQL/注入防护、传输与安全头、CORS、限流、
  SAST/代码扫描、依赖扫描（dependabot/renovate/snyk/trivy）、密钥扫描、密钥硬编码、
  权限审计日志、供应链锁定（lockfile）、容器安全（Dockerfile 非 root / 基础镜像固定）、安全测试。
- 规则文件解析：`.semgrep.yml`（数 rules）、ESLint 配置（数 security 规则/插件）、
  CodeQL / SonarQube / gitleaks / dependabot / renovate / trivy / snyk 配置存在性与条目。
- 支持 Java/Spring 与 Node/TS 项目（cloud-mall 两种都有）。证据必须来自真实文件。
- `score` 计算：按 category 权重（认证/授权/密钥 权重高）聚合 enforced=1、partial=0.5，缺失但 severity=critical 额外扣分；clamp 0-100。
- 识别硬编码密钥时避免把 `MYSQL_ROOT_PASSWORD: cloudmall` 这类演示配置误报为 critical，可标 low 并注明演示环境。
- 输出按 guards.id 排序。

## 4. coverage.js

`export function analyzeCoverage(repo, ctx)`，优先解析真实覆盖率产物，否则给出明确标注的估算。

```js
{
  measurable: boolean,            // 是否解析到真实覆盖率文件
  estimated: boolean,             // measurable=false 时为 true
  source: 'jacoco'|'istanbul'|'lcov'|'cobertura'|'nyc'|'estimate',
  line: number|null,              // 行覆盖率 0-100（estimate 时也给出估算值）
  branch: number|null,
  statement: number|null,
  testCount: number,              // 测试用例数（正则统计 it/test/@Test）
  testFiles: number,
  sourceFiles: number,
  testToSourceRatio: number,      // 0-1
  modules: [{ path, label, line, branch, testFiles }],   // 能解析到模块级时给出
  untestedModules: [{ path, label, reason }],            // 无测试文件覆盖的模块（最多 12）
  testFramework: string|null,
  note: string,                    // 若为估算必须写明方法与局限
  files: [{ path, loc, tested: boolean }]   // 最多 800 条，供分支 diff 找“新增未测试文件”
}
```

覆盖率产物位置：`coverage/coverage-summary.json`、`coverage/lcov.info`、`coverage.xml`、
`target/site/jacoco/jacoco.xml`、`.nyc_output/*.json`。注意本仓库可能没有产物 → 必须走估算路径且不报错。
估算方法（写进 note）：测试/源码 LOC 比、测试文件/源文件比、测试用例数、模块是否零测试文件，合成一个 5-55 的保守值，
并按“缺失产物”降权。测试计数正则：Jest/Vitest `it(`/`test(`、JUnit `@Test`、pytest `def test_`、Go `func Test`。

## 5. complexity.js

`export function analyzeComplexity(repo, ctx)`，系统复杂度 + 模块级可优化建议。

```js
{
  score: 0-100,                // 越高越复杂
  level: 'low'|'moderate'|'high'|'severe',
  totals: { loc, sourceLoc, files, sourceFiles, modules, avgFileLoc, maxFileLoc },
  modules: [{
    path, label, loc, sourceLoc, files, sourceFiles, testFiles,
    avgFileLoc, maxFileLoc, fanIn, fanOut, branches, churn,
    score, level, drivers: [{ name, value, detail }], needsOptimization: boolean
  }],
  hotspots: [{ path, label, score, loc, reason }],       // 最多 8 条，按严重度
  recommendations: [string],                             // 中文，最多 5 条系统级建议
  note
}
```

- 仅统计 `kind==='source'` 与 `'test'`；跳过生成目录（walk 已排除）。
- 复杂度信号：LOC、超大文件（>600 行 / >1000 行）、分支密度（`if|else|for|while|case|catch|&&|\|\||?` 计数 / 千行）、
  fan-in/fan-out（来自 graph.fileEdges，文件级聚合到模块）、文件数量、git churn（ctx.churn 可选：{moduleId: commits}）。
- `score`：加权归一化 0-100，相对本仓库规模；`needsOptimization`：score>=65 或 maxFileLoc>=800 或 fanOut>=12。
- `drivers` 给 1-3 条中文原因（如 `单文件最大 1240 行`）。
- `churn` 缺失时为 0。
- 输出 modules 按 path 排序，hotspots 按 score 降序。

## 6. deps.js

`export function analyzeDeps(repo)`。

```js
{
  ecosystems: [{ id, label, packages, manifests: [path] }],
  packages: [{
    ecosystem,                  // 'npm'|'maven'|'python'|'go'|'rust'|'php'|'ruby'|'dart'
    name, version,              // version 原始声明，如 '^18.2.0' 或 '2.7.18'
    scope,                      // 'runtime'|'dev'|'test'|'unknown'
    dir,                        // 所在模块目录（用于 UI 展示）
    manifest                    // 清单路径
  }],
  manifests: [{ path, type, packages }],
  stats: { packages, runtime, dev, manifests }
}
```

支持：package.json（dependencies/devDependencies/peer/optional）、pom.xml（dependency 块，含 version/property 解析）、
build.gradle（implementation/api/testImplementation）、requirements.txt、pyproject.toml（dependencies）、go.mod。
同一 name 在不同模块重复出现时保留多条（dir 不同）。排序：ecosystem, name, dir。

## 7. diff.js

`export function diffSnapshots(baseSnapshot, targetSnapshot)`。
两个 snapshot 形如 `{ id, branch, commit_sha, analysis }`，`analysis` 是完整分析快照：

```js
analysis = {
  version: 1,
  meta: { branch, commit: { sha, short, subject, author, date }, analyzedAt, stats },
  architecture: { layers, groups, nodes, edges, stats },
  security, coverage, complexity, deps, knowledge,
  risks: [{ id, level, category, title, detail, evidence, action, source }],
  recommendations: [{ id, title, detail, priority }],
  fileIndex: [{ path, loc, kind, module }]
}
```

输出（UI 直接渲染，所有 before/after 用数字或 null）：

```js
{
  base: { snapshotId, branch, commit, analyzedAt },
  target: { snapshotId, branch, commit, analyzedAt },
  verdict: { level: 'risk'|'watch'|'stable'|'improved', score: -100..100, headline, summary },
  metrics: [{
    key, label, unit, before, after, delta,
    direction: 'higher-better'|'lower-better'|'neutral',
    status: 'improved'|'regressed'|'flat'|'risk'
  }],
  security: {
    scoreBefore, scoreAfter, delta,
    guardsAdded: [{ id, name, category, severity, ruleCount }],
    guardsRemoved: [{ id, name, category, severity, ruleCount }],
    guardsChanged: [{ id, name, from, to, ruleDelta }],
    ruleSets: [{ id, name, added: [string], removed: [string], before, after }],
    riskyPatternsAdded: [...], riskyPatternsRemoved: [...]
  },
  dependencies: {
    added: [{ ecosystem, name, version }],
    removed: [...],
    upgraded: [{ ecosystem, name, from, to, major: boolean }],
    downgraded: [...],
    byEcosystem: [{ ecosystem, added, removed, upgraded }]
  },
  architecture: {
    nodesBefore, nodesAfter, edgesBefore, edgesAfter,
    nodesAdded: [{ id, label, layer }],
    nodesRemoved: [{ id, label, layer }],
    layerDeltas: [{ layer, before, after }]
  },
  complexity: {
    scoreBefore, scoreAfter, delta,
    modules: [{ path, label, before, after, delta, status }],
    topRegressions: [{ path, label, before, after, delta }],
    topImprovements: [...]
  },
  coverage: {
    lineBefore, lineAfter, delta, estimatedBefore, estimatedAfter,
    testCountBefore, testCountAfter, testCountDelta,
    untestedNewFiles: [{ path, loc, module }],
    testsRemoved: [{ path }]
  },
  knowledge: {
    domainsAdded, domainsRemoved, entitiesAdded, entitiesRemoved,
    apisAdded, apisRemoved, eventsAdded, eventsRemoved      // 均为 [{ id, label }]
  },
  risks: [{ id, level: 'high'|'medium'|'low', category, title, detail, evidence: [{ path?, label? }], action, source: 'diff'|'target' }],
  riskScore: 0-100
}
```

风险规则（确定性，逐条实现）：
- 安全守护从 enforced/partial 消失或降级：critical/high 守护 → high，其余 medium；新增守护 → 正向。
- 规则集条目减少（如 SAST 规则、密钥扫描规则）：sast/secret 类 → high，其余 medium；新增规则记为正向。
- 依赖 major 升级 → medium（列出去重后的清单）；降级 → medium；新增依赖 → low 仅记录。
- 系统复杂度上升 >= 12 分或单模块 >= 15 分且 after>=60 → medium；>= 25 → high。
- 覆盖率下降 >= 2pp → medium；>= 6pp → high；新增源码文件无对应测试 → low（>5 个聚合为 medium）。
- 新增模块无测试 / 复杂度高 → medium。
- 目标快照自身 `analysis.risks` 且 level=high 的带入（source='target'）。
- `verdict.score`：正向指标加权（安全 30、覆盖率 20、复杂度 20、依赖 15、架构 15），clamp -100..100；
  `riskScore` 取 risks 权重和 (high=35, medium=18, low=6)，clamp 0-100。
- 如果两快照完全一致：verdict.level='stable'，score=0，risks=[]。
- 健壮性：任何字段缺失（旧快照、无覆盖率）都不能抛错，使用空数组/0/null 并跳过对应规则。

## 8. 验证方式

已克隆真实样例仓库：`/tmp/arcvista-fixture`（CloudMall：Spring Boot 7 服务 + 4 个 React 端，含 JWT/Spring Security/MyBatis 等）。
用临时脚本验证（放 /tmp，不要写仓库根）：

```bash
cd /Volumes/yonking/project/学习/实验室/arcvista
cat > /tmp/probe-security.mjs <<'EOF'
import { scanRepo } from '/Volumes/.../arcvista/lib/analyze/walk.js';
import { detectModules } from '.../modules.js';
import { buildGraph } from '.../graph.js';
import { analyzeSecurity } from '.../security.js';
const repo = await scanRepo('/tmp/arcvista-fixture');
const modulesInfo = detectModules(repo);
const graph = buildGraph(repo, modulesInfo);
console.log(JSON.stringify(analyzeSecurity(repo, { modulesInfo, graph }), null, 2).slice(0, 6000));
EOF
node /tmp/probe-security.mjs
```

验收：在三类样例上无异常、输出结构符合契约——
1. `/tmp/arcvista-fixture`（真实中等仓库，Java+TS）；
2. 自造一个零安全配置的极简 JS 仓库（安全分应低、缺失项多）；
3. 自造一个带 semgrep/dependabot/lockfile/JWT/helmet/rate-limit 的 Node 仓库（各项应被识别，规则数可 diff）。

不要修改 `walk.js` / `modules.js` / `graph.js` / `util.js`，如发现 bug 在结果中说明。
