import { api } from '../api.js';
import {
  $,
  $$,
  delegate,
  esc,
  fmtNum,
  fmtPct,
  icon,
  openModal,
  poll,
  timeAgo,
  toast,
  fmtDate,
  levelLabel,
} from '../dom.js';
import { animateGauges, gauge, radar } from '../charts.js';
import { renderArchitecture } from '../components/diagram.js';
import { renderKnowledge, KG_KINDS } from '../components/knowledge.js';
import { openDrillDrawer } from '../components/drawer.js';
import { openNodeDrawer } from '../components/node-drawer.js';

const TABS = [
  { id: 'architecture', label: '系统架构', icon: 'layers' },
  { id: 'security', label: '安全守护', icon: 'shield' },
  { id: 'knowledge', label: '业务知识图谱', icon: 'graph' },
  { id: 'complexity', label: '复杂度', icon: 'pulse' },
  { id: 'coverage', label: '测试覆盖', icon: 'flask' },
  { id: 'risks', label: '风险与建议', icon: 'warning' },
];

const riskOrder = { high: 0, medium: 1, low: 2 };

function toneFor(score, { invert = false } = {}) {
  if (score === null || score === undefined) return 'warn';
  const value = Number(score);
  const good = invert ? value < 45 : value >= 75;
  const warn = invert ? value < 65 : value >= 50;
  return good ? 'good' : warn ? 'warn' : 'bad';
}

function toneColor(tone) {
  return { good: 'var(--teal)', warn: 'var(--amber)', bad: 'var(--red)', na: 'var(--text-faint)' }[tone] || 'var(--text-faint)';
}

const JOB_KIND_LABEL = { prepare: '准备仓库', analyze: '分析分支', drill: '模块下钻' };

function jobKindLabel(job) {
  return JOB_KIND_LABEL[job.kind] || '任务';
}

function jobElapsedSeconds(job) {
  const start = new Date(job.createdAt || job.updatedAt || Date.now()).getTime();
  return Math.max(0, Math.round((Date.now() - start) / 1000));
}

function jobCardHTML(job) {
  const running = job.status === 'running';
  const queued = job.status === 'queued';
  const label = job.kind === 'prepare' ? '准备仓库' : job.kind === 'analyze' ? '分析分支' : '任务';
  const logs = (job.logs || []).slice(-3);
  const indeterminate = running && job.kind === 'prepare' && (job.progress || 0) < 8;
  const statusText = queued ? '排队中' : running ? '进行中' : job.status === 'done' ? '已完成' : '失败';
  const elapsed = jobElapsedSeconds(job);
  return `
  <div class="job-banner job-card" data-job="${esc(job.id)}">
    ${queued || running ? '<span class="spinner"></span>' : `<span style="color:${job.status === 'done' ? 'var(--teal)' : 'var(--red)'}">${icon(job.status === 'done' ? 'shield' : 'warning', 18)}</span>`}
    <div class="job-text">
      <div class="job-title">
        <span>${esc(label)}</span>
        ${job.branch ? `<span class="chip chip--amber">${esc(job.branch)}</span>` : ''}
        <span class="chip ${queued ? 'chip--dim' : running ? 'chip--amber' : job.status === 'done' ? 'chip--teal' : 'chip--red'}">${statusText}</span>
        <span class="mono faint" style="margin-left:auto">${elapsed}s</span>
      </div>
      <div class="job-msg">${esc(job.message || '')}</div>
      ${logs.length ? `<div class="job-log">${logs.map((item) => `<span>${esc(item.text)}</span>`).join('')}</div>` : ''}
      <div class="progress ${indeterminate ? 'progress--indeterminate' : ''}"><i style="width:${job.progress || 0}%"></i></div>
    </div>
    <span class="job-pct">${queued ? '排队' : indeterminate ? '拉取中' : `${job.progress || 0}%`}</span>
  </div>`;
}

function jobCardsHTML(jobs = []) {
  if (!jobs.length) return '';
  return `<div class="job-queue">${jobs.map(jobCardHTML).join('')}</div>`;
}

function renderRisks(risks = []) {
  if (!risks.length) {
    return '<div class="empty"><div class="empty-mark" style="color:var(--teal)">◇</div><h4>当前未发现显著风险</h4><p>指标与守护均在可接受范围。持续观察分支对比中的架构漂移。</p></div>';
  }
  return `<div class="risk-list">
    ${[...risks]
      .sort((a, b) => (riskOrder[a.level] ?? 3) - (riskOrder[b.level] ?? 3))
      .map(
        (risk) => `
      <article class="risk-card risk-card--${['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'low'}">
        <div class="risk-head">
          <div>
            <div class="risk-title">${esc(risk.title)}</div>
            <div class="risk-detail">${esc(risk.detail)}</div>
          </div>
          <span class="badge badge--${risk.level || 'low'}">${risk.level === 'high' ? '高风险' : risk.level === 'medium' ? '中风险' : '低风险'} · ${esc(risk.category || '架构')}</span>
        </div>
        ${risk.action ? `<div class="risk-action"><b>建议动作</b> ${esc(risk.action)}</div>` : ''}
        ${
          (risk.evidence || []).length
            ? `<div class="risk-evidence">${risk.evidence
                .slice(0, 4)
                .map((item) => `<span class="chip" title="${esc(item.path || '')}">${esc(item.label || item.path || '证据')}</span>`)
                .join('')}</div>`
            : ''
        }
      </article>`,
      )
      .join('')}
  </div>`;
}

function renderRecommendations(list = []) {
  if (!list.length) return '<div class="diff-empty">暂无治理建议</div>';
  return `<div class="rec-list">${list
    .map(
      (item) => `
    <div class="rec-card">
      <span class="prio">${esc(item.priority || 'P2')}</span>
      <div>
        <div class="rec-title">${esc(item.title)}</div>
        <div class="rec-detail">${esc(item.detail)}</div>
        ${(item.modules || []).length ? `<div class="row row--wrap mt-8" style="gap:6px">${item.modules
          .slice(0, 3)
          .map((module) => `<span class="chip chip--dim">${esc(module.split('/').pop())}</span>`)
          .join('')}</div>` : ''}
      </div>
    </div>`,
    )
    .join('')}</div>`;
}

function renderInsights(list = []) {
  if (!list.length) return '<div class="diff-empty">暂无模块洞察</div>';
  return `<div class="insight-grid">${list
    .map(
      (item) => `
    <div class="insight-card">
      <div class="ic-head">
        <div>
          <div class="ic-name">${esc(item.label || item.module)}</div>
          <div class="mono faint" style="font-size:9.5px;word-break:break-all">${esc(item.module || '')}</div>
        </div>
        <span class="badge ${item.verdict === '高风险' ? 'badge--high' : item.verdict === '需关注' ? 'badge--medium' : 'badge--good'}">${esc(item.verdict || '需关注')}</span>
      </div>
      <div class="ic-sum">${esc(item.summary || '')}</div>
      ${(item.actions || []).length ? `<ul>${item.actions.slice(0, 3).map((action) => `<li>${esc(action)}</li>`).join('')}</ul>` : ''}
    </div>`,
    )
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* page                                                               */
/* ------------------------------------------------------------------ */

export async function renderDashboard(main, ctx) {
  const { route, navigate } = ctx;
  const productId = route.id;
  let detail;
  try {
    detail = await api.products.get(productId);
  } catch (error) {
    main.innerHTML = `<div class="page"><div class="banner banner--red"><strong>无法加载产品</strong> ${esc(error.message)}</div>
      <div class="mt-16"><a class="btn" href="#/">${icon('back', 13)} 返回观测台</a></div></div>`;
    return {};
  }
  const product = detail.product;
  const snapshots = detail.snapshots || [];
  const requestedSnapshot = route.params.get('s');
  const selected =
    snapshots.find((snapshot) => snapshot.id === requestedSnapshot) ||
    snapshots[0] ||
    null;

  let analysis = null;
  let snapshotMeta = selected;
  if (selected) {
    try {
      const data = await api.products.snapshot(productId, selected.id);
      analysis = data.snapshot.analysis;
      snapshotMeta = data.snapshot;
    } catch (error) {
      toast('快照加载失败', { type: 'error', detail: error.message });
    }
  }

  const activeTab = TABS.some((tab) => tab.id === route.tab) ? route.tab : 'architecture';
  const summary = snapshotMeta?.summary || {};
  const activeJobs = detail.activeJobs || [];
  const branchAnalysis = detail.branchAnalysis || [];
  const repoReady = Boolean(detail.repoReady);
  const preparing = activeJobs.some((job) => job.kind === 'prepare');
  const latestPrepareJob = (detail.jobs || []).find((job) => job.kind === 'prepare') || null;
  const warnings = analysis?.meta?.engine?.warnings || [];
  const risks = analysis?.risks || [];
  const riskCount = summary.risks?.total ?? risks.length;

  const snapshotSelectHTML = snapshots.length > 1
    ? `<select class="select" id="snapshot-select" aria-label="选择分析快照">${snapshots
        .map(
          (snapshot) =>
            `<option value="${esc(snapshot.id)}" ${snapshot.id === selected?.id ? 'selected' : ''}>${esc(snapshot.branch)} · ${esc(snapshot.commit?.short || '')} · ${esc(timeAgo(snapshot.analyzedAt))}</option>`,
        )
        .join('')}</select>`
    : '';
  const headerActionsHTML = analysis
    ? `${snapshotSelectHTML}
       <button class="btn" id="analyze-branch">${icon('branch', 13)} 分析分支</button>
       <button class="btn" id="go-compare">${icon('compare', 13)} 分支对比</button>
       <button class="btn btn--primary" id="reanalyze" ${activeJobs.length ? 'disabled' : ''}>${icon('refresh', 13)} 重新分析</button>`
    : `${repoReady ? `<button class="btn" id="analyze-branch" ${preparing ? 'disabled' : ''}>${icon('branch', 13)} 分析分支</button>
         <button class="btn" id="refresh-branches" ${preparing ? 'disabled' : ''}>${icon('refresh', 13)} 刷新分支</button>`
       : `<button class="btn btn--primary" id="prepare-repo" ${preparing ? 'disabled' : ''}>${icon('refresh', 13)} ${preparing ? '正在准备仓库' : '准备仓库'}</button>`}`;

  const kpi = !analysis
    ? ''
    : `
    <div class="kpi-strip">
      <div class="kpi">
        <div class="kpi-label">安全守护</div>
        <div class="kpi-value" style="color:${toneColor(toneFor(summary.security?.score))}">${fmtNum(summary.security?.score)}<small>/100</small></div>
        <div class="kpi-foot">${summary.security?.guards || 0} 项守护 · ${summary.security?.missing || 0} 项缺失</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">系统复杂度</div>
        <div class="kpi-value" style="color:${toneColor(toneFor(summary.complexity?.score, { invert: true }))}">${fmtNum(summary.complexity?.score)}<small>/100</small></div>
        <div class="kpi-foot">${summary.complexity?.modules || 0} 个模块 · 热点 ${summary.complexity?.hotspots?.[0]?.label || '—'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">行覆盖率${summary.coverage?.estimated ? ' · 估算' : ''}</div>
        <div class="kpi-value" style="color:${toneColor(toneFor(summary.coverage?.line))}">${fmtNum(summary.coverage?.line, 1)}<small>%</small></div>
        <div class="kpi-foot">${fmtNum(summary.coverage?.testCount)} 个用例 · ${summary.coverage?.testFiles || 0} 个测试文件</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">风险信号</div>
        <div class="kpi-value" style="color:${summary.risks?.high ? 'var(--red)' : summary.risks?.medium ? 'var(--amber)' : 'var(--teal)'}">${summary.risks?.high || 0}<small>高</small></div>
        <div class="kpi-foot">中 ${summary.risks?.medium || 0} · 低 ${summary.risks?.low || 0} · 共 ${riskCount} 项</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">架构连接</div>
        <div class="kpi-value">${summary.architecture?.nodes || 0}<small>节点</small></div>
        <div class="kpi-foot">${summary.architecture?.edges || 0} 条依赖 · ${summary.architecture?.services || 0} 个服务</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">代码规模</div>
        <div class="kpi-value">${fmtNum(Math.round((summary.stats?.sourceLoc || 0) / 1000))}<small>k 行</small></div>
        <div class="kpi-foot">${fmtNum(summary.stats?.sourceFiles)} 源文件 · ${summary.stats?.modules || 0} 模块</div>
      </div>
    </div>`;

  main.innerHTML = `
    <div class="page">
      <div class="dash-head">
        <div class="crumb">
          <a href="#/">观测台</a><span class="sep">/</span>
          <span>${esc(product.name)}</span><span class="sep">/</span><span>看板</span>
        </div>
        <div class="dash-title-row">
          <div style="min-width:0">
            <h1 class="dash-title">${esc(product.name)}</h1>
            <div class="dash-badges">
              ${selected ? `<span class="chip chip--amber">${icon('branch', 11)}${esc(selected.branch)}</span>` : ''}
              ${selected ? `<span class="chip chip--dim">${esc(selected.commit?.short || '')}</span>` : ''}
              ${selected ? `<span class="chip ${selected.engine === 'llm' ? 'chip--violet' : 'chip--dim'}">${selected.engine === 'llm' ? 'LLM 语义增强' : '启发式分析'}</span>` : ''}
              ${selected ? `<span class="chip chip--dim">${esc(timeAgo(selected.analyzedAt))}</span>` : ''}
              ${!selected && repoReady ? `<span class="chip chip--dim">${(detail.branches || []).length} 个分支</span>` : ''}
              ${!selected ? `<span class="chip ${repoReady ? 'chip--teal' : 'chip--dim'}">${repoReady ? '仓库已就绪' : preparing ? '正在准备仓库' : '仓库未就绪'}</span>` : ''}
              <span class="chip chip--dim">/${esc(product.repoKind)}</span>
            </div>
            <div class="dash-meta">
              <span title="${esc(product.repoUrl)}">${icon('graph', 12)} ${esc(product.repoUrl)}</span>
              ${selected ? `<span>${icon('clock', 12)} ${esc(fmtDate(selected.analyzedAt))}</span>` : ''}
              ${selected?.commit?.subject ? `<span style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(selected.commit.subject)}</span>` : ''}
            </div>
          </div>
          <div class="dash-actions">${headerActionsHTML}</div>
        </div>
      </div>
      <div id="job-area">${jobCardsHTML(activeJobs)}</div>
      ${kpi}
      ${
        warnings.length
          ? `<div class="banner ${analysis?.meta?.engine?.kind === 'llm' ? 'banner--teal' : ''}">
              <span>${icon('warning', 16)}</span>
              <div><strong>${analysis?.meta?.engine?.kind === 'llm' ? '分析提示' : '当前为启发式分析'}</strong> ${warnings.map((warning) => esc(warning)).join('；')}</div>
            </div>`
          : ''
      }
      ${
        analysis
          ? `<div class="tabs" role="tablist">
              ${TABS.map(
                (tab) =>
                  `<button class="tab ${tab.id === activeTab ? 'active' : ''}" data-tab="${tab.id}" role="tab" aria-selected="${tab.id === activeTab}">
                    ${esc(tab.label)}
                    ${tab.id === 'risks' && riskCount ? `<span class="count">${riskCount}</span>` : ''}
                    ${tab.id === 'security' && summary.security?.missing ? `<span class="count">${summary.security.missing}</span>` : ''}
                  </button>`,
              ).join('')}
            </div>
            <section id="tab-panel" class="tab-panel"></section>`
          : emptyStateHTML()
      }
      <footer class="footer-note">
        <span>${esc(product.repoUrl)}</span>
        <span>${selected ? `SNAPSHOT ${esc(selected.id)}` : 'NO SNAPSHOT'}</span>
      </footer>
    </div>`;

  const disposers = [];
  const jobArea = $('#job-area', main);
  const tabPanel = $('#tab-panel', main);
  let currentTab = activeTab;
  let archController = null;
  let kgController = null;
  let currentSnapshot = snapshotMeta;
  let polling = false;
  let pollTimer = null;
  let disposed = false;

  function snapshotHash(tab = currentTab) {
    const params = new URLSearchParams();
    params.set('tab', tab);
    if (currentSnapshot?.id) params.set('s', currentSnapshot.id);
    return `#/p/${productId}?${params.toString()}`;
  }

  function openDrill(node) {
    const snapshotId = currentSnapshot?.id;
    if (!snapshotId) return;
    openDrillDrawer({ productId, snapshotId, node });
  }

  if ($('#snapshot-select', main)) {
    $('#snapshot-select', main).addEventListener('change', (event) => {
      const snapshot = snapshots.find((item) => item.id === event.target.value);
      if (!snapshot) return;
      currentSnapshot = snapshot;
      location.hash = snapshotHash().replace(/^#/, '');
    });
  }

  async function startPrepare() {
    try {
      await api.products.prepare(productId);
      toast('开始准备仓库', { detail: '克隆/拉取完成后会显示分支列表' });
      beginPolling();
    } catch (error) {
      toast('无法准备仓库', { type: 'error', detail: error.message });
    }
  }

  async function startAnalysis(payload) {
    try {
      const { job } = await api.products.analyze(productId, payload);
      toast(job.status === 'queued' ? `已加入队列：${payload.branch || '默认分支'}` : `已开始分析：${payload.branch || '默认分支'}`);
      beginPolling();
    } catch (error) {
      toast('无法启动分析', { type: 'error', detail: error.message });
    }
  }

  let submitting = false;
  async function startBranches(branches, { force = false } = {}) {
    if (!branches.length || submitting) return;
    submitting = true;
    let started = 0;
    for (const branch of branches) {
      try {
        await api.products.analyze(productId, { branch, force });
        started += 1;
      } catch (error) {
        toast(`分支 ${branch} 启动失败`, { type: 'error', detail: error.message });
      }
    }
    submitting = false;
    if (started > 0) {
      toast(`已提交 ${started} 个分支分析任务`, { detail: '任务按队列依次执行，全部完成后自动进入看板' });
      beginPolling();
    }
  }

  function selectedBranches(scope) {
    return [...scope.querySelectorAll('[data-branch-check]:checked')].map((input) => input.value);
  }

  function updateBranchSelection(scope) {
    const selected = selectedBranches(scope).length;
    scope.querySelectorAll('#branch-selected-count').forEach((node) => {
      node.textContent = String(selected);
    });
    scope.querySelectorAll('[data-action="analyze-selected"]').forEach((button) => {
      button.disabled = selected === 0;
    });
  }

  function wireBranchSelection(scope) {
    if (!scope) return;
    const master = scope.querySelector('#branch-check-all');
    if (master) {
      master.addEventListener('change', () => {
        scope.querySelectorAll('[data-branch-check]:not(:disabled)').forEach((input) => {
          input.checked = master.checked;
        });
        updateBranchSelection(scope);
      });
    }
    scope.addEventListener('change', (event) => {
      if (event.target.matches('[data-branch-check]')) updateBranchSelection(scope);
    });
    updateBranchSelection(scope);
  }

  function branchStatusHTML(row) {
    const active = row.activeJob;
    if (active) {
      return active.status === 'running'
        ? `<span class="badge badge--medium">分析中 ${active.progress || 0}%</span>`
        : '<span class="badge badge--low">排队中</span>';
    }
    if (row.analyzed) {
      return `<span class="badge badge--good">已分析</span> <span class="help">${esc(timeAgo(row.analyzed.analyzedAt))} · ${row.analyzed.engine === 'llm' ? 'LLM' : '启发式'}</span>`;
    }
    if (row.lastJob?.status === 'error') {
      return `<span class="badge badge--high">上次失败</span> <span class="help" title="${esc(row.lastJob.error || '')}">${esc((row.lastJob.error || '').slice(0, 46))}</span>`;
    }
    return '<span class="badge badge--low">未分析</span>';
  }

  function branchActionHTML(row) {
    if (row.activeJob) return '<span class="spinner"></span>';
    if (row.analyzed) {
      return `<span class="row" style="gap:6px;justify-content:flex-end"><button class="chip chip--teal" data-action="view-snapshot" data-snapshot="${esc(row.analyzed.snapshotId)}">查看看板</button><button class="btn btn--sm" data-action="analyze-branch" data-branch="${esc(row.branch)}" data-force="1">重新分析</button></span>`;
    }
    return `<button class="btn btn--sm btn--primary" data-action="analyze-branch" data-branch="${esc(row.branch)}">开始分析</button>`;
  }

  function branchRowsHTML(rows) {
    return rows
      .map(
        (row) => `<tr data-branch-row="${esc(row.branch)}">
          <td><input type="checkbox" data-branch-check value="${esc(row.branch)}" ${row.analyzed || row.activeJob ? 'disabled' : 'checked'}></td>
          <td>
            <div class="row" style="gap:6px"><b>${esc(row.branch)}</b>${row.branch === product.defaultBranch ? '<span class="chip chip--amber">默认</span>' : ''}</div>
            <div class="mono faint" style="font-size:9.5px">${esc(row.short || '')}</div>
          </td>
          <td>
            <div class="help" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(row.subject || '')}">${esc(row.subject || '—')}</div>
            <div class="help">${esc(row.date ? fmtDate(row.date) : '')}</div>
          </td>
          <td>${branchStatusHTML(row)}</td>
          <td style="text-align:right">${branchActionHTML(row)}</td>
        </tr>`,
      )
      .join('');
  }

  function branchTableHTML(rows) {
    return `<div class="table-wrap"><table class="data-table branch-table">
      <thead><tr><th style="width:38px"><input type="checkbox" id="branch-check-all" aria-label="全选未分析分支"></th><th>分支</th><th>最新提交</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>${branchRowsHTML(rows)}</tbody>
    </table></div>`;
  }

  function branchPanelHTML(rows) {
    const analyzedCount = rows.filter((row) => row.analyzed).length;
    return `<div class="panel mt-24" id="branch-panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">分支分析清单 · BRANCHES</div>
          <div class="panel-sub">仓库已就绪，检测到 ${rows.length} 个分支。勾选未分析的分支后开始分析，任务会按队列依次执行。</div>
        </div>
        <div class="panel-tools">
          <span class="chip chip--teal">已分析 ${analyzedCount}</span>
          <span class="chip chip--dim">未分析 ${rows.length - analyzedCount}</span>
          <button class="btn btn--sm" data-action="prepare">刷新分支</button>
        </div>
      </div>
      <div class="panel-body panel-body--flush">${branchTableHTML(rows)}</div>
      <div class="panel-body row spread" style="border-top:1px solid var(--line-soft);gap:12px">
        <div class="help">同一时间只运行一个分支分析，其余自动排队；全部分析结束后自动进入看板。</div>
        <button class="btn btn--primary" data-action="analyze-selected">开始分析选中（<span id="branch-selected-count">0</span>）</button>
      </div>
    </div>`;
  }

  function emptyStateHTML() {
    if (activeJobs.length > 0) return '';
    if (!repoReady) {
      const failed = latestPrepareJob?.status === 'error';
      return `<div class="empty mt-24">
        <div class="empty-mark">${icon(failed ? 'warning' : 'layers', 40)}</div>
        <h4>${failed ? '仓库准备失败' : '仓库尚未就绪'}</h4>
        <p>${failed ? esc(latestPrepareJob.error || '克隆/拉取仓库失败') : '先克隆并拉取仓库，之后可以看到全部分支，再选择要分析的分支。'}</p>
        <div class="row mt-8"><button class="btn btn--primary" data-action="prepare">${failed ? '重试准备仓库' : '准备仓库'} ${icon('arrow', 13)}</button></div>
        ${failed ? '<div class="help mt-8">Git 超时会自动重试并断点续传；网络恢复后再试即可继续。</div>' : ''}
      </div>`;
    }
    if (!branchAnalysis.length) {
      return `<div class="empty mt-24"><div class="empty-mark">${icon('branch', 40)}</div><h4>没有检测到分支</h4><p>仓库镜像已就绪，但没有可分析的分支。可以刷新分支或检查仓库是否为空。</p><div class="row mt-8"><button class="btn btn--primary" data-action="prepare">刷新分支 ${icon('refresh', 13)}</button></div></div>`;
    }
    return branchPanelHTML(branchAnalysis);
  }

  async function openBranchModal() {
    let fresh = null;
    try {
      fresh = await api.products.get(productId);
    } catch {
      fresh = null;
    }
    const rows = fresh?.branchAnalysis || branchAnalysis;
    if (!fresh?.repoReady && rows.length === 0) {
      toast('仓库尚未就绪，先准备仓库', { type: 'warn' });
      startPrepare();
      return;
    }
    openModal({
      eyebrow: 'BRANCHES',
      title: '选择要分析的分支',
      width: '860px',
      body: `
        <div class="banner"><div>已分析的分支可以直接打开看板；勾选未分析的分支后批量分析，任务按队列依次执行。</div></div>
        ${branchTableHTML(rows)}
        <div class="help">已选 <span id="branch-selected-count">0</span> 个未分析分支</div>`,
      actions: [
        { label: '取消' },
        {
          label: '开始分析选中',
          primary: true,
          onClick: (close, modal) => {
            const branches = selectedBranches(modal);
            if (branches.length === 0) {
              toast('请先勾选要分析的分支', { type: 'warn' });
              return false;
            }
            close();
            startBranches(branches);
            return true;
          },
        },
      ],
      onMount: (modal, close) => {
        wireBranchSelection(modal);
        const submit = modal.querySelector('.modal-foot .btn--primary');
        const refreshSubmit = () => {
          const count = selectedBranches(modal).length;
          if (!submit) return;
          submit.disabled = count === 0;
          submit.textContent = `开始分析选中（${count}）`;
        };
        modal.addEventListener('change', (event) => {
          if (event.target.matches('[data-branch-check], #branch-check-all')) refreshSubmit();
        });
        refreshSubmit();
        modal.addEventListener('click', (event) => {
          const analyze = event.target.closest('[data-action="analyze-branch"]');
          if (analyze) {
            close();
            startAnalysis({ branch: analyze.dataset.branch, force: analyze.dataset.force === '1' });
            return;
          }
          const view = event.target.closest('[data-action="view-snapshot"]');
          if (view) {
            close();
            navigate(`/p/${productId}?tab=architecture&s=${view.dataset.snapshot}`);
          }
        });
      },
    });
  }

  async function pollTick() {
    if (disposed) return;
    let data = null;
    try {
      data = await api.products.get(productId);
    } catch {
      data = null;
    }
    if (disposed) return;
    if (!data) {
      polling = false;
      return;
    }
    const active = data.activeJobs || [];
    if (jobArea) jobArea.innerHTML = jobCardsHTML(active);
    // Keep the branch table statuses (分析中 / 排队中) in sync while the queue runs
    // without re-rendering the whole panel, so the controls stay usable.
    const branchPanel = $('#branch-panel', main);
    if (branchPanel && Array.isArray(data.branchAnalysis)) {
      const tbody = branchPanel.querySelector('.branch-table tbody');
      if (tbody) {
        tbody.innerHTML = branchRowsHTML(data.branchAnalysis);
        updateBranchSelection(branchPanel);
      }
    }
    if (active.length === 0) {
      polling = false;
      pollTimer = setTimeout(() => {
        if (!disposed) ctx.reload();
      }, 350);
      return;
    }
    pollTimer = setTimeout(pollTick, 1200);
  }

  function beginPolling() {
    if (polling || disposed) return;
    polling = true;
    pollTimer = setTimeout(pollTick, 700);
  }

  $('#analyze-branch', main)?.addEventListener('click', openBranchModal);
  $('#refresh-branches', main)?.addEventListener('click', startPrepare);
  $('#prepare-repo', main)?.addEventListener('click', startPrepare);
  $('#reanalyze', main)?.addEventListener('click', () => {
    if (activeJobs.length > 0) {
      toast('已有任务在进行中，请等待完成', { type: 'warn' });
      return;
    }
    const branch = currentSnapshot?.branch || product.defaultBranch;
    startAnalysis({ branch, force: true });
  });
  $('#go-compare', main)?.addEventListener('click', () => navigate(`/p/${productId}/compare`));

  delegate(main, '[data-action="prepare"]', 'click', startPrepare);
  delegate(main, '[data-action="analyze-selected"]', 'click', () => {
    const scope = $('#branch-panel', main) || main;
    startBranches(selectedBranches(scope));
  });
  delegate(main, '[data-action="analyze-branch"]', 'click', (event, button) => {
    startAnalysis({ branch: button.dataset.branch, force: button.dataset.force === '1' });
  });
  delegate(main, '[data-action="view-snapshot"]', 'click', (event, button) => {
    navigate(`/p/${productId}?tab=architecture&s=${button.dataset.snapshot}`);
  });
  wireBranchSelection($('#branch-panel', main));
  if (activeJobs.length > 0) beginPolling();

  /* ---------------------------------------------------------------- tabs */

  function renderArchitectureTab() {
    const architecture = analysis.architecture || { nodes: [], edges: [], layers: [], groups: [], stats: {} };
    const overview = analysis.meta?.overview || '';
    const layerStats = (architecture.layers || [])
      .map((layer) => ({
        ...layer,
        count: (architecture.nodes || []).filter((node) => node.layer === layer.id).length,
      }))
      .filter((layer) => layer.count > 0);
    const maxLayer = Math.max(1, ...layerStats.map((layer) => layer.count));
    const nodeById = new Map((architecture.nodes || []).map((node) => [node.id, node]));

    tabPanel.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">系统架构图 · SYSTEM MAP</div>
            <div class="panel-sub">${esc(architecture.subtitle || '由仓库结构、依赖与配置推断')}</div>
          </div>
          <div class="panel-tools">
            <span class="chip chip--dim">${architecture.stats?.nodes || 0} 节点</span>
            <span class="chip chip--dim">${architecture.stats?.edges || 0} 连接</span>
            <span class="chip ${architecture.generatedBy === 'llm' ? 'chip--violet' : 'chip--dim'}">${architecture.generatedBy === 'llm' ? 'LLM 增强' : '启发式'}</span>
          </div>
        </div>
        <div class="arch-canvas" id="arch-canvas"></div>
      </div>
      <div class="grid grid--2 mt-16 arch-below">
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">架构结论 · READOUT</div>
            <div class="panel-tools"><span class="chip chip--dim">${architecture.stats?.services || 0} 服务 · ${architecture.stats?.clients || 0} 客户端</span></div>
          </div>
          <div class="panel-body">
            <p class="drawer-summary">${esc(overview || '暂无架构概述。配置大模型后可获得语义化解读。')}</p>
            ${(architecture.notes || []).length ? `<div class="help mt-16">${architecture.notes.map((note) => esc(note)).join('<br/>')}</div>` : ''}
            <div class="divider"></div>
            <div class="help">点击画布中的任意节点查看指标与依赖；在节点详情里可以「下钻分析」，进入模块内部结构、关键流程、接口与风险。</div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">分层构成 · LAYERS</div>
            <div class="panel-tools"><span class="chip chip--dim">${layerStats.length} 层</span></div>
          </div>
          <div class="panel-body">
            <div class="stack stack--sm">
              ${layerStats
                .map(
                  (layer) => `
                <div>
                  <div class="inspector-layer"><span>${esc(layer.label)}</span><span class="mono">${layer.count}</span></div>
                  <div class="layer-meter"><i style="width:${(layer.count / maxLayer) * 100}%"></i></div>
                </div>`,
                )
                .join('')}
            </div>
            <div class="node-health mt-16">
              <div class="nh"><span>模块</span><b>${architecture.stats?.modules || 0}</b></div>
              <div class="nh"><span>连接</span><b>${architecture.stats?.edges || 0}</b></div>
              <div class="nh"><span>数据组件</span><b>${architecture.stats?.datastores || 0}</b></div>
              <div class="nh"><span>分层</span><b>${layerStats.length}</b></div>
            </div>
          </div>
        </div>
      </div>`;

    const canvas = $('#arch-canvas', tabPanel);

    let nodeInspector = null;
    function showNode(node) {
      nodeInspector?.close();
      nodeInspector = openNodeDrawer({
        node,
        analysis,
        nodes: architecture.nodes,
        edges: architecture.edges,
        onDrill: (target) => openDrill(target),
        onClose: () => {
          nodeInspector = null;
        },
      });
    }

    archController = renderArchitecture(canvas, architecture, {
      onNodeClick: (node) => showNode(node),
    });
    disposers.push(() => {
      archController?.destroy?.();
      nodeInspector?.close();
    });
  }

  function renderSecurityTab() {
    const security = analysis.security || { guards: [], ruleSets: [], riskyPatterns: [], totals: {} };
    const guards = [...(security.guards || [])].sort((a, b) => {
      const order = { missing: 0, partial: 1, enforced: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3) || (riskOrder[a.severity] ?? 3) - (riskOrder[b.severity] ?? 3);
    });
    const tones = { strong: 'good', moderate: 'warn', weak: 'bad', critical: 'bad' };
    tabPanel.innerHTML = `
      <div class="panel">
        <div class="score-hero">
          ${gauge(security.score, {
            label: 'GUARD COVERAGE',
            tone: tones[security.level] || 'warn',
            digits: 0,
            sublabel: `${guards.filter((guard) => guard.status === 'enforced').length} / ${guards.length} 项守护已落地`,
          })}
          <div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <span class="badge ${security.level === 'strong' ? 'badge--good' : security.level === 'moderate' ? 'badge--medium' : 'badge--high'}">${esc(levelLabel(security.level))}</span>
              <span class="chip chip--dim">${security.totals?.rules || 0} 条可 diff 规则</span>
              <span class="chip chip--dim">${(security.ruleSets || []).length} 组规则集</span>
            </div>
            <p class="drawer-summary mt-16">${esc(security.summary || '')}</p>
            <div class="grid grid--4 mt-24" style="gap:12px">
              <div class="stat"><div class="stat-label">已强制</div><div class="stat-value" style="font-size:24px;color:var(--teal)">${security.totals?.enforced || 0}</div></div>
              <div class="stat"><div class="stat-label">部分落地</div><div class="stat-value" style="font-size:24px;color:var(--amber)">${security.totals?.partial || 0}</div></div>
              <div class="stat"><div class="stat-label">缺失</div><div class="stat-value" style="font-size:24px;color:var(--red)">${security.totals?.missing || 0}</div></div>
              <div class="stat"><div class="stat-label">风险信号</div><div class="stat-value" style="font-size:24px">${(security.riskyPatterns || []).length}</div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="row spread mt-24 mb-16">
        <div class="panel-title">安全守护清单 · ${guards.length}</div>
        <div class="help">状态来自仓库中的真实配置与代码证据，规则清单可用于分支 diff</div>
      </div>
      <div class="guard-grid">
        ${guards
          .map(
            (guard) => `
          <article class="guard-card guard-card--${guard.status}">
            <div class="guard-head">
              <div>
                <div class="guard-name">${esc(guard.name)}</div>
                <div class="guard-cat">${esc(guard.category)} · ${esc(levelLabel(guard.severity))}优先级</div>
              </div>
              <span class="badge ${guard.status === 'enforced' ? 'badge--good' : guard.status === 'partial' ? 'badge--medium' : 'badge--high'}">${guard.status === 'enforced' ? '已强制' : guard.status === 'partial' ? '部分' : '缺失'}</span>
            </div>
            ${(guard.rules || []).length ? `<div class="guard-rules">${guard.rules.slice(0, 6).map((rule) => `<span class="rule-pill">${esc(rule)}</span>`).join('')}${guard.rules.length > 6 ? `<span class="rule-pill">+${guard.rules.length - 6}</span>` : ''}</div>` : ''}
            ${guard.note ? `<div class="guard-note">${esc(guard.note)}</div>` : ''}
            ${(guard.evidence || []).length ? `<div class="guard-evidence">${guard.evidence.slice(0, 3).map((item) => esc(item.path || '')).join('<br/>')}</div>` : ''}
            ${guard.recommendation && guard.status !== 'enforced' ? `<div class="guard-rec">→ ${esc(guard.recommendation)}</div>` : ''}
          </article>`,
          )
          .join('')}
      </div>
      ${
        (security.ruleSets || []).length
          ? `<div class="panel mt-24">
              <div class="panel-head"><div><div class="panel-title">可对比规则集 · RULE SETS</div><div class="panel-sub">分支对比会逐条比较这些规则的新增与移除</div></div></div>
              <div class="panel-body panel-body--flush table-wrap">
                <table class="data-table">
                  <thead><tr><th>规则集</th><th>类型</th><th class="num">规则数</th><th>文件</th></tr></thead>
                  <tbody>${security.ruleSets
                    .map(
                      (set) => `<tr><td>${esc(set.name)}</td><td><span class="chip chip--dim">${esc(set.kind)}</span></td><td class="num">${fmtNum(set.ruleCount)}</td><td><code class="mono faint">${esc(set.path || '—')}</code></td></tr>`,
                    )
                    .join('')}</tbody>
                </table>
              </div>
            </div>`
          : ''
      }
      ${
        (security.riskyPatterns || []).length
          ? `<div class="panel mt-24">
              <div class="panel-head"><div><div class="panel-title">危险代码模式 · RISKY PATTERNS</div></div></div>
              <div class="panel-body">
                ${security.riskyPatterns
                  .slice(0, 12)
                  .map(
                    (pattern) => `<div class="pattern-row">
                      <span class="badge badge--${pattern.severity === 'high' ? 'high' : pattern.severity === 'medium' ? 'medium' : 'low'}">${esc(levelLabel(pattern.severity))}</span>
                      <div class="grow"><b>${esc(pattern.name)}</b><div class="help">${esc(pattern.detail || '')}</div></div>
                      <code class="mono faint" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(pattern.path)}:${pattern.line || ''}</code>
                    </div>`,
                  )
                  .join('')}
              </div>
            </div>`
          : ''
      }`;
    animateGauges(tabPanel);
  }

  function renderKnowledgeTab() {
    const knowledge = analysis.knowledge || { domains: [], nodes: [], edges: [], flows: [], stats: {} };
    const hidden = new Set(['api', 'entity']);
    let nodeInspector = null;

    const showNode = (node) => {
      nodeInspector?.close();
      nodeInspector = openNodeDrawer({
        node,
        analysis,
        nodes: knowledge.nodes || [],
        edges: knowledge.edges || [],
        onDrill: (target) => openDrill(target),
        onClose: () => {
          nodeInspector = null;
        },
      });
    };

    tabPanel.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">业务知识图谱 · KNOWLEDGE MAP</div>
            <div class="panel-sub">${esc(knowledge.subtitle || '业务域、能力、实体与事件的真实关系')}</div>
          </div>
          <div class="panel-tools">
            <span class="chip chip--dim">${knowledge.stats?.domains || 0} 业务域</span>
            <span class="chip chip--dim">${knowledge.stats?.capabilities || 0} 能力</span>
            <span class="chip chip--dim">${knowledge.stats?.entities || 0} 实体</span>
            <span class="chip chip--dim">${knowledge.stats?.events || 0} 事件</span>
            <span class="chip chip--dim">${knowledge.stats?.apis || 0} 接口</span>
            <span class="chip ${knowledge.generatedBy === 'llm' ? 'chip--violet' : 'chip--dim'}">${knowledge.generatedBy === 'llm' ? 'LLM 增强' : '启发式'}</span>
          </div>
        </div>
        ${
          (knowledge.flows || []).length
            ? `<div class="panel-body" style="padding:16px 22px 0">
                <div class="mono faint" style="font-size:9px;letter-spacing:.18em;margin-bottom:8px">主业务流程 · ${knowledge.flows.length}</div>
                ${knowledge.flows
                  .map(
                    (flow) => `<div class="mb-16"><div class="help" style="margin-bottom:6px"><b style="color:var(--text)">${esc(flow.name)}</b> ${esc(flow.description || '')}</div><div class="flow-strip">${(flow.steps || [])
                      .map((step, index) => `<div class="flow-step"><span class="idx">${String(index + 1).padStart(2, '0')}</span><b>${esc(step.label)}</b></div>`)
                      .join('')}</div></div>`,
                  )
                  .join('')}
              </div>`
            : ''
        }
        <div class="panel-body" style="padding:14px 22px 0">
          <div class="kg-filters" id="kg-filters">
            ${Object.entries(KG_KINDS)
              .map(
                ([kind, meta]) => {
                  const count = (knowledge.nodes || []).filter((node) => node.kind === kind).length;
                  return `<button class="filter-chip ${hidden.has(kind) ? '' : 'active'}" data-kind="${kind}"><i style="background:${meta.color}"></i>${meta.label}<b>${count}</b></button>`;
                },
              )
              .join('')}
          </div>
        </div>
        <div class="kg-canvas" id="kg-canvas" style="margin-top:14px;border-left:none;border-right:none"></div>
      </div>
      <div class="grid grid--2 mt-16">
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">业务域 · ${knowledge.domains?.length || 0}</div>
            <div class="panel-tools"><span class="chip chip--dim">点击查看节点详情</span></div>
          </div>
          <div class="panel-body">
            <div class="domain-list" id="domain-list">
              ${(knowledge.domains || [])
                .map(
                  (domain) => `
                <div class="domain-item" data-domain="${esc(domain.id)}">
                  <div class="domain-name"><span>${esc(domain.label)}</span><span class="mono faint">${(knowledge.nodes || []).filter((node) => node.domain === domain.id && node.kind === 'capability').length} 能力</span></div>
                  <div class="domain-desc">${esc(domain.description || '')}</div>
                  <div class="domain-metrics">
                    <span>${(knowledge.nodes || []).filter((node) => node.domain === domain.id && node.kind === 'entity').length} 实体</span>
                    <span>${(knowledge.nodes || []).filter((node) => node.domain === domain.id && node.kind === 'api').length} 接口</span>
                    <span>${(knowledge.nodes || []).filter((node) => node.domain === domain.id && node.kind === 'event').length} 事件</span>
                  </div>
                </div>`,
                )
                .join('') || '<div class="diff-empty">未识别到业务域</div>'}
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div class="panel-title">如何阅读 · GUIDE</div></div>
          <div class="panel-body">
            <p class="drawer-summary">图谱由代码事实构建：业务域来自服务边界，能力来自 Controller 聚合，实体来自领域模型，事件来自 Kafka/RabbitMQ 主题与监听器，数据组件来自依赖与编排配置。</p>
            <div class="divider"></div>
            <ul class="bullet-list">
              <li>点击任意节点查看业务含义、关联模块与依赖关系</li>
              <li>接口与领域实体默认隐藏，避免图谱过密；可在上方筛选器中打开</li>
              <li>普通滚动会滚动页面；缩放请用工具条或 Ctrl/⌘ + 滚轮</li>
              <li>点击「下钻相关模块」进入该业务域对应服务内部</li>
              <li>配置大模型后，图谱会补充业务语义、主流程与跨域事实</li>
            </ul>
            <div class="divider"></div>
            <div class="node-health">
              <div class="nh"><span>图谱节点</span><b>${knowledge.stats?.nodes || 0}</b></div>
              <div class="nh"><span>关系边</span><b>${knowledge.stats?.edges || 0}</b></div>
              <div class="nh"><span>参与者</span><b>${knowledge.stats?.actors || 0}</b></div>
              <div class="nh"><span>数据组件</span><b>${knowledge.stats?.datastores || 0}</b></div>
            </div>
          </div>
        </div>
      </div>`;

    const canvas = $('#kg-canvas', tabPanel);
    kgController = renderKnowledge(canvas, knowledge, { onNodeClick: (node) => showNode(node) });
    disposers.push(() => {
      kgController?.destroy?.();
      nodeInspector?.close();
    });

    const filters = $('#kg-filters', tabPanel);
    delegate(filters, '.filter-chip', 'click', (event, button) => {
      const kind = button.dataset.kind;
      if (hidden.has(kind)) hidden.delete(kind);
      else hidden.add(kind);
      button.classList.toggle('active', !hidden.has(kind));
      kgController?.setHidden([...hidden]);
    });

    delegate($('#domain-list', tabPanel), '.domain-item', 'click', (event, item) => {
      const id = item.dataset.domain;
      const node = (knowledge.nodes || []).find((entry) => entry.id === id) || {
        id,
        label: (knowledge.domains || []).find((domain) => domain.id === id)?.label || '业务域',
        kind: 'domain',
        description: (knowledge.domains || []).find((domain) => domain.id === id)?.description || '',
      };
      showNode(node);
    });
  }

  function renderComplexityTab() {
    const complexity = analysis.complexity || { modules: [], hotspots: [], totals: {}, recommendations: [] };
    const totals = complexity.totals || {};
    const modules = [...(complexity.modules || [])].sort((a, b) => b.score - a.score);
    const maxFan = Math.max(1, ...modules.map((module) => (module.fanIn || 0) + (module.fanOut || 0)));
    const maxChurn = Math.max(1, ...modules.map((module) => module.churn || 0));
    const dims = [
      { label: '代码规模', value: Math.min(100, (totals.sourceLoc || 0) / 800) },
      { label: '平均文件', value: Math.min(100, (totals.avgFileLoc || 0) / 4) },
      { label: '超大文件', value: Math.min(100, (totals.maxFileLoc || 0) / 12) },
      { label: '模块耦合', value: Math.min(100, maxFan * 4) },
      { label: '变更热度', value: Math.min(100, maxChurn * 8) },
      {
        label: '测试缺口',
        value: analysis.coverage?.line != null ? Math.max(0, 100 - analysis.coverage.line) : 50,
      },
    ];
    const levelTone = { low: 'good', moderate: 'warn', high: 'bad', severe: 'bad' }[complexity.level] || 'warn';
    tabPanel.innerHTML = `
      <div class="panel">
        <div class="complexity-hero">
          ${gauge(complexity.score, {
            label: 'COMPLEXITY',
            tone: levelTone,
            digits: 0,
            sublabel: `${totals.modules || 0} 个模块 · ${fmtNum(totals.sourceLoc)} 行源码`,
          })}
          <div class="row" style="gap:24px;align-items:center;flex-wrap:wrap">
            <div class="radar-wrap">${radar(dims, { size: 250 })}</div>
            <div class="grow" style="min-width:240px">
              <span class="badge ${complexity.level === 'low' ? 'badge--good' : complexity.level === 'moderate' ? 'badge--medium' : 'badge--high'}">${esc(levelLabel(complexity.level))}</span>
              <p class="drawer-summary mt-16">${esc(complexity.note || '复杂度由代码规模、文件粒度、耦合度、分支密度与变更频率综合计算，数值越高越需要治理。')}</p>
              ${(complexity.recommendations || []).length ? `<ul class="bullet-list mt-16">${complexity.recommendations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="row spread mt-24 mb-16"><div class="panel-title">复杂度热点 · HOTSPOTS</div><div class="help">优先治理的高复杂度模块</div></div>
      <div class="hotspot-grid">
        ${(complexity.hotspots || [])
          .map(
            (hotspot) => `
          <div class="hotspot-card">
            <div class="hs-top"><div class="hs-name">${esc(hotspot.label)}</div><span class="mono" style="color:${hotspot.score >= 80 ? 'var(--red)' : 'var(--amber)'}">${fmtNum(hotspot.score)}</span></div>
            <div class="hs-path">${esc(hotspot.path)}</div>
            <div class="hs-reason">${esc(hotspot.reason || '')}</div>
          </div>`,
          )
          .join('') || '<div class="diff-empty">无显著热点</div>'}
      </div>
      <div class="panel mt-24">
        <div class="panel-head"><div><div class="panel-title">模块复杂度 · MODULE MATRIX</div><div class="panel-sub">按复杂度得分排序，含耦合、变更与测试覆盖</div></div></div>
        <div class="panel-body panel-body--flush table-wrap">
          <table class="data-table data-table--tight">
            <thead><tr><th>模块</th><th class="num">LOC</th><th class="num">文件</th><th class="num">平均行</th><th class="num">扇入/扇出</th><th class="num">变更</th><th style="min-width:140px">复杂度</th><th class="num">覆盖率</th><th>判断</th></tr></thead>
            <tbody>
              ${modules
                .slice(0, 40)
                .map((module) => {
                  const cov = module.coverage ?? null;
                  return `<tr>
                    <td><div>${esc(module.label)}</div><div class="mono faint" style="font-size:9px">${esc(module.path)}</div></td>
                    <td class="num">${fmtNum(module.loc)}</td>
                    <td class="num">${fmtNum(module.sourceFiles ?? module.files)}</td>
                    <td class="num">${fmtNum(module.avgFileLoc)}</td>
                    <td class="num">${fmtNum(module.fanIn)}/${fmtNum(module.fanOut)}</td>
                    <td class="num">${fmtNum(module.churn)}</td>
                    <td><span class="score-bar"><span class="bar"><i class="${module.score >= 70 ? 'high' : ''}" style="width:${Math.min(100, module.score)}%"></i></span><b>${fmtNum(module.score)}</b></span></td>
                    <td class="num">${cov != null ? fmtPct(cov) : '—'}</td>
                    <td>${module.needsOptimization ? '<span class="badge badge--medium">需优化</span>' : '<span class="badge badge--good">健康</span>'}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    animateGauges(tabPanel);
  }

  function renderCoverageTab() {
    const coverage = analysis.coverage || { modules: [], untestedModules: [], files: [] };
    const tone = toneFor(coverage.line);
    const untested = coverage.untestedModules || [];
    const untestedFiles = (coverage.files || []).filter((file) => file.tested === false).slice(0, 40);
    tabPanel.innerHTML = `
      ${coverage.estimated ? `<div class="banner mb-16"><span>${icon('warning', 16)}</span><div><strong>估算值</strong> 仓库中没有发现覆盖率产物（jacoco / lcov / cobertura / istanbul）。${esc(coverage.note || '')}</div></div>` : ''}
      <div class="panel">
        <div class="coverage-hero">
          ${gauge(coverage.line, {
            label: 'LINE COVERAGE',
            tone,
            digits: 1,
            unit: '%',
            sublabel: coverage.measurable ? '来自真实覆盖率产物' : '估算：测试规模启发式',
          })}
          <div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <span class="badge ${coverage.measurable ? 'badge--good' : 'badge--medium'}">${coverage.measurable ? '实测' : '估算'}</span>
              <span class="chip chip--dim">${esc(coverage.source || 'estimate')}</span>
              ${coverage.testFramework ? `<span class="chip chip--dim">${esc(coverage.testFramework)}</span>` : ''}
            </div>
            <p class="drawer-summary mt-16">${esc(coverage.note || '')}</p>
            <div class="grid grid--4 mt-24" style="gap:12px">
              <div class="stat"><div class="stat-label">测试用例</div><div class="stat-value" style="font-size:24px">${fmtNum(coverage.testCount)}</div></div>
              <div class="stat"><div class="stat-label">测试文件</div><div class="stat-value" style="font-size:24px">${fmtNum(coverage.testFiles)}</div></div>
              <div class="stat"><div class="stat-label">源文件</div><div class="stat-value" style="font-size:24px">${fmtNum(coverage.sourceFiles)}</div></div>
              <div class="stat"><div class="stat-label">测试/源码比</div><div class="stat-value" style="font-size:24px">${coverage.testToSourceRatio != null ? fmtPct(coverage.testToSourceRatio * 100, 0) : '—'}</div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="grid grid--2 mt-24">
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">模块覆盖 · BY MODULE</div></div></div>
          <div class="panel-body">
            ${
              (coverage.modules || []).length
                ? (coverage.modules || [])
                    .filter((module) => module.line != null)
                    .sort((a, b) => a.line - b.line)
                    .slice(0, 14)
                    .map(
                      (module) => `
                  <div class="cov-row">
                    <div class="cov-name">${esc(module.label || module.path.split('/').pop())}<small>${esc(module.path)}</small></div>
                    <div class="cov-track"><i style="width:${Math.max(1, Math.min(100, module.line))}%"></i></div>
                    <div class="cov-val">${fmtPct(module.line)}</div>
                  </div>`,
                    )
                    .join('')
                : '<div class="diff-empty">没有模块级覆盖率数据</div>'
            }
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">测试缺口 · UNTESTED</div></div></div>
          <div class="panel-body">
            ${
              untested.length
                ? untested.slice(0, 14).map((module) => `<div class="untested-row"><span>${esc(module.label)}</span><span class="mono">${esc(module.reason || '')}</span></div>`).join('')
                : '<div class="diff-empty">所有模块都至少有一个测试文件</div>'
            }
            ${
              untestedFiles.length
                ? `<div class="divider"></div><div class="mono faint" style="font-size:9px;letter-spacing:.16em;margin-bottom:8px">未被测试引用的大文件</div>${untestedFiles
                    .slice(0, 10)
                    .map((file) => `<div class="untested-row"><span class="mono" style="font-size:10px;word-break:break-all">${esc(file.path)}</span><span class="mono">${fmtNum(file.loc)} 行</span></div>`)
                    .join('')}`
                : ''
            }
          </div>
        </div>
      </div>`;
    animateGauges(tabPanel);
  }

  function renderRisksTab() {
    tabPanel.innerHTML = `
      <div class="grid grid--sidebar" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:18px;align-items:start">
        <div>
          <div class="row spread mb-16"><div class="panel-title">风险清单 · ${risks.length}</div><div class="help">按严重度排序，证据来自指标与守护规则</div></div>
          ${renderRisks(risks)}
        </div>
        <div>
          <div class="panel">
            <div class="panel-head"><div><div class="panel-title">治理建议 · PLAN</div></div></div>
            <div class="panel-body">${renderRecommendations(analysis.recommendations || [])}</div>
          </div>
          <div class="panel mt-16">
            <div class="panel-head"><div><div class="panel-title">模块洞察 · INSIGHTS</div></div></div>
            <div class="panel-body">${renderInsights(analysis.moduleInsights || [])}</div>
          </div>
        </div>
      </div>
      ${
        warnings.length
          ? `<div class="panel mt-24"><div class="panel-head"><div><div class="panel-title">分析引擎 · ENGINE</div></div></div><div class="panel-body">
              <div class="kv-list">
                <div class="kv"><dt>引擎</dt><dd>${analysis.meta?.engine?.kind === 'llm' ? `LLM · ${esc(analysis.meta.engine.model || '')}` : '启发式规则引擎'}</dd></div>
                <div class="kv"><dt>耗时</dt><dd class="mono">${((analysis.meta?.durationMs || 0) / 1000).toFixed(1)}s</dd></div>
                <div class="kv"><dt>提示</dt><dd>${warnings.map((warning) => esc(warning)).join('；')}</dd></div>
              </div>
            </div></div>`
          : ''
      }`;
  }

  const renderers = {
    architecture: renderArchitectureTab,
    security: renderSecurityTab,
    knowledge: renderKnowledgeTab,
    complexity: renderComplexityTab,
    coverage: renderCoverageTab,
    risks: renderRisksTab,
  };

  function showTab(tabId, { updateHash = true } = {}) {
    if (!analysis || !renderers[tabId]) return;
    currentTab = tabId;
    $$('.tab', main).forEach((button) => {
      const active = button.dataset.tab === tabId;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    // cleanup previous tab controllers
    archController?.destroy?.();
    kgController?.destroy?.();
    archController = null;
    kgController = null;
    renderers[tabId]();
    if (updateHash) {
      history.replaceState(null, '', snapshotHash(tabId));
    }
  }

  delegate(main, '.tab', 'click', (event, button) => showTab(button.dataset.tab));

  if (analysis) showTab(activeTab, { updateHash: false });

  return {
    dispose: () => {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      archController?.destroy?.();
      kgController?.destroy?.();
      for (const disposer of disposers) {
        try {
          disposer();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
