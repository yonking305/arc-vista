import { api } from '../api.js';
import { $, confirmDialog, delegate, esc, icon, openModal, timeAgo, toast, fmtNum } from '../dom.js';
import { miniRing } from '../charts.js';

const SAMPLE_REPO = '/Volumes/yonking/project/学习/实验室/cloud-mall';

function riskSignal(summary) {
  const risks = summary?.risks || {};
  const total = risks.total || 0;
  const high = risks.high || 0;
  const medium = risks.medium || 0;
  const low = risks.low || 0;
  const segments = [];
  let index = 0;
  for (let i = 0; i < Math.min(high, 5); i += 1) segments.push(`<i class="on" style="background:var(--red)"></i>`), (index += 1);
  for (let i = 0; i < Math.min(medium, 5 - index); i += 1) segments.push(`<i class="on medium"></i>`), (index += 1);
  for (let i = 0; i < Math.min(low, 5 - index); i += 1) segments.push(`<i class="on low"></i>`), (index += 1);
  while (segments.length < 5) segments.push('<i></i>');
  const tone = high > 0 ? 'red' : medium > 0 ? 'amber' : total > 0 ? 'dim' : 'teal';
  return `<span class="risk-signal" title="${total} 项风险：高 ${high} / 中 ${medium} / 低 ${low}">${segments.join('')}</span>`;
}

function toneFor(score, { invert = false } = {}) {
  if (score === null || score === undefined) return 'warn';
  const value = Number(score);
  const good = invert ? value < 45 : value >= 75;
  const warn = invert ? value < 65 : value >= 50;
  return good ? 'good' : warn ? 'warn' : 'bad';
}

function cardHTML(product) {
  const latest = product.latest;
  const job = product.job;
  const running = job && ['queued', 'running'].includes(job.status);
  const failed = job && job.status === 'error';
  const summary = latest?.summary || {};
  const description = product.description || '尚未填写描述 — 分析完成后由代码与架构证据自动刻画。';
  return `
  <article class="product-card" data-id="${esc(product.id)}" tabindex="0" role="link" aria-label="打开 ${esc(product.name)} 看板">
    <div class="product-head">
      <div style="min-width:0">
        <div class="product-name">${esc(product.name)}</div>
        <div class="product-repo" title="${esc(product.path || product.repoUrl)}">${esc(product.path || product.repoUrl)}</div>
      </div>
      <button class="btn btn--icon btn--ghost" data-action="delete" title="删除产品" aria-label="删除产品">${icon('trash', 14)}</button>
    </div>
    <div class="product-desc">${esc(description)}</div>
    ${
      running
        ? `<div class="product-job">
            <div class="spread">
              <span class="mono" style="color:var(--amber);font-size:10px;letter-spacing:.1em">本地项目分析</span>
              <span class="mono faint">${job.progress || 0}%</span>
            </div>
            <div class="help mt-8" style="font-size:10.5px">${esc(job.message || '进行中')}</div>
            ${(product.activeJobCount || 0) > 1 ? `<div class="help" style="font-size:10.5px">队列中还有 ${product.activeJobCount - 1} 个任务</div>` : ''}
            <div class="progress mt-8"><i style="width:${job.progress || 2}%"></i></div>
          </div>`
        : failed
          ? `<div class="product-job">
              <div class="banner banner--red" style="padding:9px 12px;font-size:11px;line-height:1.6">${esc(job.error || '任务失败')}</div>
              ${/超时|网络|无法访问|连接|timeout/i.test(job.error || '') ? '<div class="help mt-8" style="font-size:10.5px">检查本地目录是否仍存在，然后重试分析。</div>' : ''}
              <button class="btn btn--sm mt-8" data-action="analyze">重试分析 ${icon('refresh', 12)}</button>
            </div>`
          : latest
            ? `<div class="product-rings">
                ${miniRing(summary.security?.score, { tone: toneFor(summary.security?.score), label: '安全守护', unit: '' })}
                ${miniRing(summary.coverage?.line, { tone: toneFor(summary.coverage?.line), label: '行覆盖率' })}
                ${miniRing(summary.complexity?.score, { tone: toneFor(summary.complexity?.score, { invert: true }), label: '复杂度', unit: '' })}
              </div>
              <div class="product-foot">
                <div class="meta">
                  <span class="chip chip--amber">${icon('branch', 11)}${esc(latest.branch)}</span>
                  <span class="chip chip--dim">${esc(latest.commit?.short || '')}</span>
                  <span class="mono faint">${timeAgo(latest.analyzedAt)}</span>
                </div>
                <div class="row" style="gap:8px">
                  ${riskSignal(summary)}
                  <span class="chip ${latest.engine === 'llm' ? 'chip--violet' : 'chip--dim'}">${latest.engine === 'llm' ? 'LLM 增强' : '启发式'}</span>
                </div>
              </div>`
            : `<div class="product-job" style="margin-top:auto">
                <div class="empty" style="padding:18px 12px;border:none">
                  <div class="mono faint" style="font-size:10px">当前工作区尚未分析</div>
                  <button class="btn btn--sm btn--primary mt-8" data-action="open">立即分析当前工作区 ${icon('arrow', 12)}</button>
                </div>
              </div>`
    }
  </article>`;
}

function heroHTML(products) {
  const snapshots = products.reduce((total, product) => total + (product.snapshotCount || 0), 0);
  const highRisks = products.reduce((total, product) => total + (product.latest?.summary?.risks?.high || 0), 0);
  const secured = products.filter((product) => product.latest).length;
  return `
    <div class="hero-strip">
      <div class="hero-stat"><b>${products.length}</b><span>观测目标 / TARGETS</span></div>
      <div class="hero-stat"><b>${snapshots}</b><span>分析快照 / SNAPSHOTS</span></div>
      <div class="hero-stat"><b style="color:${highRisks > 0 ? 'var(--red)' : 'var(--teal)'}">${highRisks}</b><span>高风险信号 / RISKS</span></div>
      <div class="hero-stat"><b>${secured}/${products.length || 0}</b><span>已建立基线 / BASELINED</span></div>
    </div>`;
}

function pathName(value) {
  const clean = String(value || '').replace(/[\/]+$/, '');
  return clean.split(/[\/]/).pop() || '';
}

async function createModal(navigate) {
  let workspaces = [];
  try {
    workspaces = (await api.workspaces()).workspaces || [];
  } catch {
    workspaces = [];
  }
  openModal({
    eyebrow: 'NEW LOCAL PROJECT',
    title: '接入本地项目',
    width: '600px',
    closeOnBackdrop: false,
    body: `
      <div class="field">
        <label for="np-name">产品名称</label>
        <input class="input" id="np-name" placeholder="例如：CloudMall 云商城" maxlength="60" />
      </div>
      ${workspaces.length ? `<div class="field">
        <label for="np-workspace">从 DSH 工作区选择</label>
        <select class="input" id="np-workspace">
          <option value="">手动填写本地目录</option>
          ${workspaces.map((workspace) => `<option value="${esc(workspace.path)}" data-title="${esc(workspace.title || '')}">${esc(workspace.title || workspace.path)} — ${esc(workspace.path)}</option>`).join('')}
        </select>
        <div class="help">直接复用 DeepSeek Harness 已登记的工作区目录。</div>
      </div>` : ''}
      <div class="field">
        <label for="np-path">本地项目目录</label>
        <input class="input" id="np-path" placeholder="/Users/you/projects/my-app" />
        <div class="help">填写绝对路径。ArcVista 直接分析当前工作区，不克隆、不拉取、不切换分支；分析产出写入项目内的 <span class="mono">.arcvista/</span>。</div>
      </div>
      <div class="field">
        <label for="np-desc">一句话描述（可选）</label>
        <input class="input" id="np-desc" placeholder="这个系统是做什么的" maxlength="300" />
      </div>
      <div class="banner">
        <span>${icon('pulse', 16)}</span>
        <div>创建后立即分析当前工作区，项目列表记录在 ArcVista 全局数据目录，快照与下钻结果写入项目内的 <span class="mono">.arcvista/</span>。模型由 DSH 统一提供。</div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建并开始分析',
        primary: true,
        onClick: async (close, modal) => {
          const name = modal.querySelector('#np-name').value.trim() || pathName(modal.querySelector('#np-path').value);
          const projectPath = modal.querySelector('#np-path').value.trim();
          const description = modal.querySelector('#np-desc').value.trim();
          if (!name) {
            toast('请填写产品名称', { type: 'warn' });
            modal.querySelector('#np-name').focus();
            return false;
          }
          if (!projectPath) {
            toast('请填写本地项目目录', { type: 'warn' });
            modal.querySelector('#np-path').focus();
            return false;
          }
          try {
            const result = await api.products.create({ name, path: projectPath, description });
            toast('项目已创建，正在分析当前工作区', { detail: '快照会写入项目内的 .arcvista/' });
            close();
            navigate(`/p/${result.product.id}`);
          } catch (error) {
            toast('创建失败', { type: 'error', detail: error.message });
            return false;
          }
          return true;
        },
      },
    ],
    onMount: (modal) => {
      const pathInput = modal.querySelector('#np-path');
      const nameInput = modal.querySelector('#np-name');
      const workspaceSelect = modal.querySelector('#np-workspace');
      workspaceSelect?.addEventListener('change', () => {
        if (!workspaceSelect.value) return;
        pathInput.value = workspaceSelect.value;
        const title = workspaceSelect.selectedOptions[0]?.dataset.title;
        if (!nameInput.value.trim() && title) nameInput.value = title;
        pathInput.focus();
      });
      pathInput.addEventListener('blur', () => {
        if (!nameInput.value.trim()) nameInput.value = pathName(pathInput.value);
      });
      nameInput.focus();
      modal.querySelector('[data-close-modal]')?.addEventListener('click', (event) => {
        event.preventDefault();
        modal.closest('.modal-backdrop').remove();
        navigate('/settings');
      });
    },
  });
}

export async function renderProducts(main, ctx) {
  const { api: _api, state, navigate } = ctx;
  main.innerHTML = `
    <div class="page">
      <header class="masthead">
        <div>
          <div class="eyebrow">ARCVISTA · 架构观测台</div>
          <h1 class="page-title">把系统放上<em>观测台</em></h1>
          <p class="page-sub">接入任意本地项目目录，自动生成可下钻的系统架构图、安全架构守护清单、业务知识图谱、复杂度与测试覆盖度，并对比不同快照之间的架构漂移与风险。</p>
        </div>
        <div class="masthead-right">
          <div class="masthead-meta">LOCAL-FIRST · JSON<br/><b>数据只保存在这台机器</b></div>
          <button class="btn btn--primary" id="create-product">${icon('plus', 15)} 新建观测目标</button>
        </div>
      </header>
      <section id="products-hero"></section>
      <section id="product-grid" class="product-grid"></section>
      <footer class="footer-note">
        <span>ArcVista v0.1 · 本地优先 · 零外部依赖</span>
        <span id="footer-status">OBSERVATORY ONLINE</span>
      </footer>
    </div>`;

  let products = [];
  let timer = null;
  let disposed = false;

  const hero = $('#products-hero', main);
  const grid = $('#product-grid', main);

  function paint() {
    if (disposed) return;
    hero.innerHTML = products.length > 0 ? heroHTML(products) : '';
    if (products.length === 0) {
      grid.innerHTML = `
        <div class="panel" style="grid-column:1/-1">
          <div class="panel-body" style="padding:46px 40px">
            <div class="eyebrow">NO TARGETS YET</div>
            <h2 style="font-family:var(--font-display);font-size:32px;font-weight:600;margin:14px 0 10px">先接入一个需要被看懂的系统</h2>
            <p class="page-sub" style="margin-bottom:24px">选择一个本地目录即可开始。ArcVista 直接读取当前工作区，静态解析模块、依赖、路由、安全配置与测试，再绘制成可交互的架构看板。不会修改你的源码，分析产出写入项目内的 .arcvista/。</p>
            <div class="row row--wrap" style="gap:10px">
              <button class="btn btn--primary" data-action="create">${icon('plus', 15)} 接入第一个本地项目</button>
              <span class="mono faint" style="font-size:10.5px">示例本地路径：${esc(SAMPLE_REPO)}</span>
            </div>
            <div class="grid grid--3 mt-24" style="gap:14px">
              <div class="stat"><div class="stat-label">架构洞察</div><div class="stat-note mt-8">分层架构图 · 双击节点下钻到模块内部结构</div></div>
              <div class="stat"><div class="stat-label">质量观测</div><div class="stat-note mt-8">安全守护 · 复杂度 · 测试覆盖 · 业务知识图谱</div></div>
              <div class="stat"><div class="stat-label">快照对比</div><div class="stat-note mt-8">守护规则增减 · 依赖升级 · 复杂度漂移与风险判断</div></div>
            </div>
          </div>
        </div>`;
      return;
    }
    grid.innerHTML = products.map(cardHTML).join('') + `
      <div class="add-card" data-action="create" role="button" tabindex="0">
        <span class="plus">+</span>
        <span>接入新的观测目标</span>
      </div>`;
  }

  function schedulePoll() {
    if (timer) clearTimeout(timer);
    const active = products.some((product) => product.job && ['queued', 'running'].includes(product.job.status));
    if (!active || disposed) return;
    timer = setTimeout(refresh, 2200);
  }

  async function refresh() {
    try {
      const data = await api.products.list();
      products = data.products;
      const active = products.some((product) => product.job && ['queued', 'running'].includes(product.job.status));
      if (active) paintGridOnly();
      else paint();
      schedulePoll();
    } catch {
      /* keep previous paint */
    }
  }

  function paintGridOnly() {
    if (!grid) return;
    grid.innerHTML = products.map(cardHTML).join('') + `
      <div class="add-card" data-action="create" role="button" tabindex="0">
        <span class="plus">+</span>
        <span>接入新的观测目标</span>
      </div>`;
    const footer = $('#footer-status', main);
    if (footer) footer.textContent = 'ANALYZING…';
  }

  delegate(main, '[data-action="create"]', 'click', () => createModal(navigate));
  delegate(grid, '[data-action="delete"]', 'click', async (event, button) => {
    event.stopPropagation();
    const card = button.closest('.product-card');
    const product = products.find((item) => item.id === card.dataset.id);
    if (!product) return;
    const confirmed = await confirmDialog({
      title: `删除「${product.name}」？`,
      message: '只从 ArcVista 项目列表移除；项目目录和 .arcvista 分析产出会保留。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.products.remove(product.id);
      products = products.filter((item) => item.id !== product.id);
      paint();
      toast('已删除观测目标');
    } catch (error) {
      toast('删除失败', { type: 'error', detail: error.message });
    }
  });

  delegate(grid, '[data-action="analyze"]', 'click', async (event, button) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await api.products.analyze(button.closest('.product-card').dataset.id);
      toast('分析任务已启动');
      refresh();
    } catch (error) {
      toast('无法启动分析', { type: 'error', detail: error.message });
      button.disabled = false;
    }
  });

  delegate(grid, '[data-action="prepare"]', 'click', async (event, button) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await api.products.prepare(button.closest('.product-card').dataset.id);
      toast('开始分析本地项目');
      refresh();
    } catch (error) {
      toast('无法开始分析', { type: 'error', detail: error.message });
      button.disabled = false;
    }
  });

  delegate(grid, '[data-action="open"]', 'click', (event, button) => {
    event.stopPropagation();
    navigate(`/p/${button.closest('.product-card').dataset.id}`);
  });

  delegate(grid, '.product-card', 'click', (event) => {
    if (event.target.closest('[data-action]')) return;
    const card = event.target.closest('.product-card');
    if (card) navigate(`/p/${card.dataset.id}`);
  });
  delegate(grid, '.product-card', 'keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('[data-action]')) {
      const card = event.target.closest('.product-card');
      if (card) navigate(`/p/${card.dataset.id}`);
    }
  });

  $('#create-product', main).addEventListener('click', () => createModal(navigate));

  try {
    const data = await api.products.list();
    products = data.products;
  } catch (error) {
    main.innerHTML = `<div class="page"><div class="banner banner--red"><strong>无法加载观测目标</strong> ${esc(error.message)}</div></div>`;
    return {};
  }
  paint();
  schedulePoll();

  return {
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export { fmtNum };
