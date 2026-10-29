import { api } from '../api.js';
import { $, delegate, esc, fmtNum, fmtPct, icon, openModal, poll, timeAgo, toast, levelLabel } from '../dom.js';
import { animateGauges, gauge } from '../charts.js';

const VERDICT_META = {
  risk: { label: '存在风险', tone: 'bad', cls: 'risk', desc: '变更引入了需要处理的风险信号' },
  watch: { label: '需要关注', tone: 'warn', cls: 'watch', desc: '出现一些退化，建议在合并前确认' },
  stable: { label: '基本稳定', tone: 'info', cls: 'stable', desc: '两个分支之间没有显著指标变化' },
  improved: { label: '整体改善', tone: 'good', cls: 'improved', desc: '质量与安全指标较基准分支提升' },
};

function statusColor(status, direction, delta) {
  if (status === 'improved') return 'var(--teal)';
  if (status === 'regressed' || status === 'risk') return 'var(--red)';
  if (delta === 0) return 'var(--text-faint)';
  return 'var(--text-dim)';
}

function fmtMetricValue(value, unit = '') {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  const formatted = Number.isInteger(number) ? fmtNum(number) : fmtNum(number, 1);
  return `${formatted}${unit}`;
}

function diffList(items, renderItem, emptyText) {
  if (!items || !items.length) return `<div class="diff-empty">${esc(emptyText)}</div>`;
  return `<div class="diff-list">${items.map(renderItem).join('')}</div>`;
}

function riskCard(risk) {
  return `
    <article class="risk-card risk-card--${['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'low'}" style="margin-bottom:10px">
      <div class="risk-head">
        <div>
          <div class="risk-title">${esc(risk.title)}</div>
          <div class="risk-detail">${esc(risk.detail)}</div>
        </div>
        <span class="badge badge--${risk.level || 'low'}">${risk.level === 'high' ? '高风险' : risk.level === 'medium' ? '中风险' : '低风险'} · ${esc(risk.category || '架构')}</span>
      </div>
      ${risk.action ? `<div class="risk-action"><b>建议动作</b> ${esc(risk.action)}</div>` : ''}
    </article>`;
}

export async function renderCompare(main, ctx) {
  const { route, navigate } = ctx;
  const productId = route.id;

  let detail;
  try {
    detail = await api.products.get(productId);
  } catch (error) {
    main.innerHTML = `<div class="page"><div class="banner banner--red"><strong>无法加载产品</strong> ${esc(error.message)}</div></div>`;
    return {};
  }
  const product = detail.product;
  const snapshots = detail.snapshots || [];
  const branches = detail.branches || [];

  // pick defaults: latest snapshot per branch, two most recent branches
  const byBranch = new Map();
  for (const snapshot of snapshots) {
    if (!byBranch.has(snapshot.branch)) byBranch.set(snapshot.branch, snapshot);
  }
  const branchSnapshots = [...byBranch.values()];
  const paramBase = route.params.get('base');
  const paramTarget = route.params.get('target');
  let baseSnapshot = snapshots.find((snapshot) => snapshot.id === paramBase) || branchSnapshots[1] || snapshots[1] || null;
  let targetSnapshot = snapshots.find((snapshot) => snapshot.id === paramTarget) || branchSnapshots[0] || snapshots[0] || null;

  let diffResult = null;
  let loadError = null;
  if (snapshots.length >= 2 && baseSnapshot && targetSnapshot && baseSnapshot.id !== targetSnapshot.id) {
    try {
      diffResult = await api.products.compare(productId, {
        base: baseSnapshot.id,
        target: targetSnapshot.id,
      });
      baseSnapshot = diffResult.base;
      targetSnapshot = diffResult.target;
    } catch (error) {
      loadError = error.message;
    }
  }

  const header = `
    <div class="dash-head">
      <div class="crumb">
        <a href="#/">观测台</a><span class="sep">/</span>
        <a href="#/p/${esc(productId)}">${esc(product.name)}</a><span class="sep">/</span><span>分支对比</span>
      </div>
      <div class="dash-title-row">
        <div>
          <h1 class="dash-title">架构漂移对比</h1>
          <div class="dash-badges">
            <span class="chip chip--amber">${esc(baseSnapshot?.branch || '基准')} → ${esc(targetSnapshot?.branch || '目标')}</span>
            <span class="chip chip--dim">${esc(baseSnapshot?.commit?.short || '')} → ${esc(targetSnapshot?.commit?.short || '')}</span>
            <span class="chip chip--dim">${snapshots.length} 个快照 · ${byBranch.size} 个分支</span>
          </div>
        </div>
        <div class="dash-actions">
          <button class="btn" id="analyze-branch">${icon('branch', 13)} 分析新分支</button>
          <button class="btn" id="back-dashboard">${icon('back', 13)} 返回看板</button>
        </div>
      </div>
    </div>`;

  if (snapshots.length < 2) {
    main.innerHTML = `
      <div class="page">
        ${header}
        <div class="panel mt-24">
          <div class="panel-body" style="padding:42px 36px">
            <div class="eyebrow">NEED A SECOND SNAPSHOT</div>
            <h2 style="font-family:var(--font-display);font-size:30px;font-weight:600;margin:14px 0 10px">先分析第二个分支</h2>
            <p class="page-sub">分支对比需要两个快照。当前只有 ${snapshots.length} 个。选择一个分支进行分析，ArcVista 会保存独立快照，然后自动计算安全守护、依赖、复杂度与覆盖率的变化。</p>
            <div class="row row--wrap mt-24" style="gap:10px">
              <button class="btn btn--primary" id="analyze-branch-cta">${icon('branch', 14)} 分析一个分支</button>
              <button class="btn" id="back-dashboard-cta">${icon('back', 14)} 返回看板</button>
            </div>
            ${
              snapshots.length
                ? `<div class="mt-24">${snapshots
                    .map(
                      (snapshot) => `<div class="diff-row"><span>${esc(snapshot.branch)} <span class="mono faint">${esc(snapshot.commit?.short || '')}</span></span><span class="mono faint">${esc(timeAgo(snapshot.analyzedAt))}</span></div>`,
                    )
                    .join('')}</div>`
                : ''
            }
          </div>
        </div>
        <div id="job-area"></div>
        <footer class="footer-note"><span>${esc(product.repoUrl)}</span><span>BRANCH DIFF</span></footer>
      </div>`;
    $('#back-dashboard').addEventListener('click', () => navigate(`/p/${productId}`));
    $('#back-dashboard-cta').addEventListener('click', () => navigate(`/p/${productId}`));
    const openAnalyze = () => analyzeModal();
    $('#analyze-branch').addEventListener('click', openAnalyze);
    $('#analyze-branch-cta').addEventListener('click', openAnalyze);
    return {};
  }

  if (loadError) {
    main.innerHTML = `<div class="page">${header}<div class="banner banner--red mt-24"><strong>无法对比</strong> ${esc(loadError)}</div></div>`;
    return {};
  }

  const diff = diffResult.diff;
  const verdictMeta = VERDICT_META[diff.verdict?.level] || VERDICT_META.stable;
  const riskScore = diff.riskScore || 0;
  const deltaRisks = (diff.risks || []).filter((risk) => risk.source !== 'target');
  const existingRisks = diff.existingRisks || (diff.risks || []).filter((risk) => risk.source === 'target');
  const riskTone = riskScore >= 50 ? 'bad' : riskScore >= 20 ? 'warn' : 'good';

  const snapshotOptions = (selected) =>
    [...snapshots]
      .sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt))
      .map(
        (snapshot) =>
          `<option value="${esc(snapshot.id)}" ${snapshot.id === selected?.id ? 'selected' : ''}>${esc(snapshot.branch)} · ${esc(snapshot.commit?.short || '')} · ${esc(timeAgo(snapshot.analyzedAt))}</option>`,
      )
      .join('');

  main.innerHTML = `
    <div class="page">
      ${header}
      <div class="compare-toolbar mt-24">
        <div class="field">
          <label>基准快照 · BASE</label>
          <select class="select" id="base-select">${snapshotOptions(baseSnapshot)}</select>
        </div>
        <span class="arrow">→</span>
        <div class="field">
          <label>目标快照 · TARGET</label>
          <select class="select" id="target-select">${snapshotOptions(targetSnapshot)}</select>
        </div>
        <button class="btn" id="swap" title="交换基准与目标">⇄ 交换</button>
      </div>

      <div class="verdict verdict--${verdictMeta.cls}">
        <div>
          ${gauge(riskScore, { label: 'DELTA RISK', tone: riskTone, digits: 0, sublabel: `${deltaRisks.length} 条本次变更风险${existingRisks.length ? ` · ${existingRisks.length} 条存量` : ''}` })}
        </div>
        <div>
          <div class="row" style="gap:10px;flex-wrap:wrap">
            <div class="verdict-level ${verdictMeta.cls}">${esc(verdictMeta.label)}</div>
            <span class="chip chip--dim">质量变化 ${diff.verdict?.score > 0 ? '+' : ''}${fmtNum(diff.verdict?.score, 1)}</span>
          </div>
          <div class="verdict-headline">${esc(diff.verdict?.headline || verdictMeta.desc)}</div>
          <div class="verdict-summary">${esc(diff.verdict?.summary || '')}</div>
          <div class="row row--wrap mt-16" style="gap:8px">
            <span class="chip chip--dim">${esc(baseSnapshot.branch)} ${esc(baseSnapshot.commit?.short || '')}</span>
            <span class="chip chip--amber">${esc(targetSnapshot.branch)} ${esc(targetSnapshot.commit?.short || '')}</span>
            <span class="chip chip--dim">${esc(baseSnapshot.engine === 'llm' ? 'LLM' : '启发式')} → ${esc(targetSnapshot.engine === 'llm' ? 'LLM' : '启发式')}</span>
          </div>
        </div>
      </div>

      <div class="row spread mt-24 mb-16"><div class="panel-title">指标变化 · METRICS</div><div class="help">箭头表示目标分支相对基准分支的变化；颜色代表好坏方向</div></div>
      <div class="metric-grid">
        ${(diff.metrics || [])
          .map(
            (metric) => `
          <div class="metric-card">
            <div class="metric-label">${esc(metric.label)}</div>
            <div class="metric-values">
              <span class="from">${fmtMetricValue(metric.before, metric.unit)}</span>
              <span class="arrow">→</span>
              <span style="color:${statusColor(metric.status, metric.direction, metric.delta)}">${fmtMetricValue(metric.after, metric.unit)}</span>
            </div>
            <div class="metric-delta" style="color:${statusColor(metric.status, metric.direction, metric.delta)}">
              ${metric.delta > 0 ? '+' : ''}${fmtNum(metric.delta, 1)}${metric.unit || ''}
              <span class="faint" style="font-family:var(--font-mono);font-size:9px;letter-spacing:.08em"> ${metric.status === 'improved' ? 'IMPROVED' : metric.status === 'regressed' ? 'REGRESSED' : metric.status === 'risk' ? 'RISK' : 'FLAT'}</span>
            </div>
          </div>`,
          )
          .join('') || '<div class="diff-empty">没有可比较的指标</div>'}
      </div>

      <div class="row spread mt-32 mb-16"><div class="panel-title">安全架构守护 · SECURITY GUARDS</div><div class="help">规则清单逐条对比，新增与移除都可追溯</div></div>
      <div class="grid grid--2">
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">守护变更</div></div><div class="panel-tools"><span class="chip ${diff.security?.guardsAdded?.length ? 'chip--teal' : 'chip--dim'}">+${diff.security?.guardsAdded?.length || 0}</span><span class="chip ${diff.security?.guardsRemoved?.length ? 'chip--red' : 'chip--dim'}">-${diff.security?.guardsRemoved?.length || 0}</span></div></div>
          <div class="panel-body">
            ${diffList(diff.security?.guardsAdded, (guard) => `<div class="diff-row"><span><span class="plus">+</span> ${esc(guard.name)}</span><span class="mono">${esc(guard.category || '')}</span></div>`, '没有新增守护')}
            ${diffList(diff.security?.guardsRemoved, (guard) => `<div class="diff-row"><span><span class="minus">−</span> ${esc(guard.name)}</span><span class="mono">${esc(guard.category || '')}</span></div>`, '没有移除守护')}
            ${
              (diff.security?.guardsChanged || []).length
                ? `<div class="divider"></div>${diff.security.guardsChanged
                    .map((guard) => `<div class="diff-row"><span>${esc(guard.name)}</span><span class="mono">${
                      guard.from === guard.to
                        ? `规则数 ${guard.ruleDelta > 0 ? '+' : ''}${guard.ruleDelta}`
                        : `${esc(guard.from)} → ${esc(guard.to)}${guard.ruleDelta ? ` · 规则 ${guard.ruleDelta > 0 ? '+' : ''}${guard.ruleDelta}` : ''}`
                    }</span></div>`)
                    .join('')}`
                : ''
            }
            <div class="divider"></div>
            <div class="row spread"><span class="mono faint">安全评分</span><span class="mono" style="color:${diff.security?.delta > 0 ? 'var(--teal)' : diff.security?.delta < 0 ? 'var(--red)' : 'var(--text-dim)'}">${fmtNum(diff.security?.scoreBefore)} → ${fmtNum(diff.security?.scoreAfter)} (${diff.security?.delta > 0 ? '+' : ''}${fmtNum(diff.security?.delta)})</span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">规则集变更</div></div></div>
          <div class="panel-body">
            ${
              (diff.security?.ruleSets || []).filter((set) => set.added.length || set.removed.length).length
                ? diff.security.ruleSets
                    .filter((set) => set.added.length || set.removed.length)
                    .map(
                      (set) => `
                  <div class="mb-16">
                    <div class="spread"><span style="font-size:12.5px">${esc(set.name)}</span><span class="mono faint">${set.before} → ${set.after}</span></div>
                    <div class="rule-diff">
                      ${set.added.map((rule) => `<div class="add">+ ${esc(rule)}</div>`).join('')}
                      ${set.removed.map((rule) => `<div class="del">− ${esc(rule)}</div>`).join('')}
                    </div>
                  </div>`,
                    )
                    .join('')
                : '<div class="diff-empty">规则集没有变化</div>'
            }
          </div>
        </div>
      </div>

      <div class="row spread mt-32 mb-16"><div class="panel-title">依赖与组件 · DEPENDENCIES</div><div class="help">major 版本升级会标记为风险信号</div></div>
      <div class="panel">
        <div class="panel-body panel-body--flush">
          ${
            (diff.dependencies?.upgraded || []).length
              ? `<div class="table-wrap"><table class="data-table data-table--tight">
                  <thead><tr><th>组件</th><th>版本变化</th><th>生态</th><th>风险</th></tr></thead>
                  <tbody>${diff.dependencies.upgraded
                    .slice(0, 24)
                    .map(
                      (item) => `<tr><td class="mono">${esc(item.name)}</td><td class="mono">${esc(item.from || '?')} → <span style="color:var(--amber)">${esc(item.to)}</span></td><td><span class="chip chip--dim">${esc(item.ecosystem)}</span></td><td>${item.major ? '<span class="badge badge--high">MAJOR</span>' : '<span class="badge badge--medium">MINOR</span>'}</td></tr>`,
                    )
                    .join('')}</tbody>
                </table></div>`
              : '<div class="diff-empty">没有组件版本升级</div>'
          }
          <div class="grid grid--2" style="gap:0;border-top:1px solid var(--line)">
            <div class="panel-body">
              <div class="panel-title" style="margin-bottom:10px">新增依赖 · ${diff.dependencies?.added?.length || 0}</div>
              ${diffList(diff.dependencies?.added?.slice(0, 12), (item) => `<div class="diff-row"><span><span class="plus">+</span> ${esc(item.name)}</span><span class="mono">${esc(item.version || '')}</span></div>`, '无新增依赖')}
            </div>
            <div class="panel-body" style="border-left:1px solid var(--line)">
              <div class="panel-title" style="margin-bottom:10px">移除依赖 · ${diff.dependencies?.removed?.length || 0}</div>
              ${diffList(diff.dependencies?.removed?.slice(0, 12), (item) => `<div class="diff-row"><span><span class="minus">−</span> ${esc(item.name)}</span><span class="mono">${esc(item.version || '')}</span></div>`, '无移除依赖')}
            </div>
          </div>
        </div>
      </div>

      <div class="row spread mt-32 mb-16"><div class="panel-title">复杂度和覆盖率 · QUALITY</div><div class="help">模块级变化定位需要优化的部分</div></div>
      <div class="grid grid--2">
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">复杂度变化</div></div><div class="panel-tools"><span class="mono faint">${fmtNum(diff.complexity?.scoreBefore)} → ${fmtNum(diff.complexity?.scoreAfter)}</span></div></div>
          <div class="panel-body panel-body--flush table-wrap">
            ${
              (diff.complexity?.modules || []).filter((module) => Math.abs(module.delta) >= 1).length
                ? `<table class="data-table data-table--tight"><thead><tr><th>模块</th><th class="num">基准</th><th class="num">目标</th><th class="num">变化</th></tr></thead><tbody>${diff.complexity.modules
                    .filter((module) => Math.abs(module.delta) >= 1)
                    .sort((a, b) => b.delta - a.delta)
                    .slice(0, 14)
                    .map(
                      (module) => `<tr><td>${esc(module.label)}<div class="mono faint" style="font-size:9px">${esc(module.path)}</div></td><td class="num">${fmtNum(module.before)}</td><td class="num">${fmtNum(module.after)}</td><td class="num" style="color:${module.delta > 0 ? 'var(--red)' : 'var(--teal)'}">${module.delta > 0 ? '+' : ''}${fmtNum(module.delta)}</td></tr>`,
                    )
                    .join('')}</tbody></table>`
                : '<div class="diff-empty">模块复杂度没有显著变化</div>'
            }
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">测试覆盖变化</div></div></div>
          <div class="panel-body">
            <div class="row spread">
              <span class="mono faint">行覆盖率</span>
              <span class="mono">${fmtPct(diff.coverage?.lineBefore)} → <span style="color:${diff.coverage?.delta >= 0 ? 'var(--teal)' : 'var(--red)'}">${fmtPct(diff.coverage?.lineAfter)}</span></span>
            </div>
            <div class="row spread mt-8">
              <span class="mono faint">测试用例</span>
              <span class="mono">${fmtNum(diff.coverage?.testCountBefore)} → ${fmtNum(diff.coverage?.testCountAfter)} (${diff.coverage?.testCountDelta > 0 ? '+' : ''}${fmtNum(diff.coverage?.testCountDelta)})</span>
            </div>
            <div class="divider"></div>
            <div class="panel-title" style="margin-bottom:8px">新增未测试文件 · ${diff.coverage?.untestedNewFiles?.length || 0}</div>
            ${diffList(diff.coverage?.untestedNewFiles, (file) => `<div class="diff-row"><span class="mono" style="font-size:10px;word-break:break-all">${esc(file.path)}</span><span class="mono">${fmtNum(file.loc)} 行</span></div>`, '没有新增未测试文件')}
          </div>
        </div>
      </div>

      <div class="row spread mt-32 mb-16"><div class="panel-title">架构与业务变化 · ARCHITECTURE</div><div class="help">节点、接口与业务实体的增减</div></div>
      <div class="grid grid--3">
        <div class="panel"><div class="panel-head"><div><div class="panel-title">架构节点</div></div></div><div class="panel-body">
          ${diffList(diff.architecture?.nodesAdded, (node) => `<div class="diff-row"><span><span class="plus">+</span> ${esc(node.label)}</span><span class="mono">${esc(node.layer || '')}</span></div>`, '没有新增节点')}
          ${diffList(diff.architecture?.nodesRemoved, (node) => `<div class="diff-row"><span><span class="minus">−</span> ${esc(node.label)}</span><span class="mono">${esc(node.layer || '')}</span></div>`, '没有移除节点')}
        </div></div>
        <div class="panel"><div class="panel-head"><div><div class="panel-title">业务知识</div></div></div><div class="panel-body">
          ${diffList(diff.knowledge?.domainsAdded, (item) => `<div class="diff-row"><span><span class="plus">+</span> ${esc(item.label)}</span><span class="mono">业务域</span></div>`, '没有新增业务域')}
          ${diffList(diff.knowledge?.domainsRemoved, (item) => `<div class="diff-row"><span><span class="minus">−</span> ${esc(item.label)}</span><span class="mono">业务域</span></div>`, '没有移除业务域')}
          ${diffList(diff.knowledge?.apisAdded, (item) => `<div class="diff-row"><span><span class="plus">+</span> ${esc(item.label)}</span><span class="mono">接口</span></div>`, '没有新增接口')}
        </div></div>
        <div class="panel"><div class="panel-head"><div><div class="panel-title">变更风险</div></div></div><div class="panel-body">
          ${deltaRisks.length ? deltaRisks.slice(0, 4).map((risk) => `<div class="diff-row"><span><span class="badge badge--${risk.level}">${risk.level === 'high' ? '高' : risk.level === 'medium' ? '中' : '低'}</span> ${esc(risk.title)}</span></div>`).join('') : '<div class="diff-empty">本次变更没有新增风险</div>'}
        </div></div>
      </div>

      <div class="row spread mt-32 mb-16"><div class="panel-title">变更风险 · ${deltaRisks.length}</div><div class="help">由本次分支变化触发，决定风险结论</div></div>
      ${deltaRisks.length ? `<div class="risk-list">${deltaRisks.map(riskCard).join('')}</div>` : '<div class="empty"><div class="empty-mark" style="color:var(--teal)">◇</div><h4>本次变更没有引入新风险</h4><p>指标变化在可接受范围内。可以继续查看目标分支的存量风险。</p></div>'}
      ${
        existingRisks.length
          ? `<div class="row spread mt-32 mb-16"><div class="panel-title">存量风险 · ${existingRisks.length}</div><div class="help">目标分支在本次变更之前就已存在，不计入变更结论</div></div>
             <div class="risk-list">${existingRisks.map(riskCard).join('')}</div>`
          : ''
      }

      <div id="job-area"></div>
      <footer class="footer-note">
        <span>${esc(product.repoUrl)}</span>
        <span>ARCHITECTURE DRIFT · ${esc(baseSnapshot.branch)} → ${esc(targetSnapshot.branch)}</span>
      </footer>
    </div>`;

  animateGauges(main);

  const goCompare = (baseId, targetId) => {
    const params = new URLSearchParams({ base: baseId, target: targetId });
    location.hash = `/p/${productId}/compare?${params.toString()}`;
  };

  $('#base-select', main).addEventListener('change', (event) => goCompare(event.target.value, targetSnapshot.id));
  $('#target-select', main).addEventListener('change', (event) => goCompare(baseSnapshot.id, event.target.value));
  $('#swap', main).addEventListener('click', () => goCompare(targetSnapshot.id, baseSnapshot.id));
  $('#back-dashboard', main).addEventListener('click', () => navigate(`/p/${productId}`));

  async function analyzeModal() {
    openModal({
      eyebrow: 'ANALYZE BRANCH',
      title: '分析一个分支',
      body: `
        <div class="banner"><div>快照生成后即可与本页的基准快照对比。首次分析需要克隆仓库，可能需要几十秒。</div></div>
        <div class="field">
          <label>仓库分支</label>
          <select class="select" id="branch-select">
            ${branches.map((branch) => `<option value="${esc(branch.name)}">${esc(branch.name)} · ${esc(branch.short)}</option>`).join('')}
            ${branches.length ? '' : '<option value="main">main</option>'}
            <option value="__custom">手动输入分支 / 提交…</option>
          </select>
        </div>
        <div class="field" id="custom-branch-field" style="display:none">
          <label>分支名或提交 SHA</label>
          <input class="input" id="branch-input" placeholder="feature/xxx" />
        </div>`,
      actions: [
        { label: '取消' },
        {
          label: '开始分析',
          primary: true,
          onClick: async (close, modal) => {
            let branch = modal.querySelector('#branch-select').value;
            if (branch === '__custom') branch = modal.querySelector('#branch-input').value.trim();
            if (!branch) {
              toast('请填写分支名', { type: 'warn' });
              return false;
            }
            close();
            try {
              const { job } = await api.products.analyze(productId, { branch });
              toast('分析任务已启动');
              watchJob(job);
            } catch (error) {
              toast('无法启动分析', { type: 'error', detail: error.message });
            }
            return true;
          },
        },
      ],
      onMount: (modal) => {
        const select = modal.querySelector('#branch-select');
        select.addEventListener('change', () => {
          modal.querySelector('#custom-branch-field').style.display = select.value === '__custom' ? 'flex' : 'none';
        });
      },
    });
  }

  $('#analyze-branch', main)?.addEventListener('click', analyzeModal);

  async function watchJob(job) {
    const jobArea = $('#job-area', main);
    let current = job;
    const paint = () => {
      if (!jobArea) return;
      jobArea.innerHTML = `
        <div class="job-banner" style="margin-top:24px">
          <span class="spinner"></span>
          <div class="job-text">
            <div class="job-title">分析分支</div>
            <div class="job-msg">${esc(current.message || '')}</div>
            <div class="progress"><i style="width:${current.progress || 0}%"></i></div>
          </div>
          <span class="job-pct">${current.progress || 0}%</span>
        </div>`;
    };
    paint();
    await poll(
      async () => {
        try {
          const data = await api.jobs.get(job.id);
          current = data.job;
          paint();
          return ['done', 'error'].includes(current.status) ? false : true;
        } catch {
          return false;
        }
      },
      { interval: 1200 },
    );
    if (current.status === 'done') {
      toast('分析完成，正在刷新对比');
      setTimeout(() => ctx.reload(), 500);
    } else {
      toast('分析失败', { type: 'error', detail: current.error || '' });
    }
  }

  return {};
}
