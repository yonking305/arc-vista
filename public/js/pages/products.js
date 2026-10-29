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
        <div class="product-repo" title="${esc(product.repoUrl)}">${esc(product.repoUrl)}</div>
      </div>
      <button class="btn btn--icon btn--ghost" data-action="delete" title="删除产品" aria-label="删除产品">${icon('trash', 14)}</button>
    </div>
    <div class="product-desc">${esc(description)}</div>
    ${
      running
        ? `<div class="product-job">
            <div class="spread">
              <span class="mono" style="color:var(--amber);font-size:10px;letter-spacing:.1em">${job.kind === 'prepare' ? '准备仓库' : job.branch ? `分析 ${esc(job.branch)}` : '分析中'}</span>
              <span class="mono faint">${job.progress || 0}%</span>
            </div>
            <div class="help mt-8" style="font-size:10.5px">${esc(job.message || '进行中')}</div>
            ${(product.activeJobCount || 0) > 1 ? `<div class="help" style="font-size:10.5px">队列中还有 ${product.activeJobCount - 1} 个任务</div>` : ''}
            <div class="progress mt-8"><i style="width:${job.progress || 2}%"></i></div>
          </div>`
        : failed
          ? `<div class="product-job">
              <div class="banner banner--red" style="padding:9px 12px;font-size:11px;line-height:1.6">${esc(job.error || '任务失败')}</div>
              ${/超时|网络|无法访问|连接|timeout/i.test(job.error || '') ? '<div class="help mt-8" style="font-size:10.5px">Git 超时会自动重试并断点续传；网络恢复后点重试即可继续。</div>' : ''}
              <button class="btn btn--sm mt-8" data-action="${job.kind === 'prepare' ? 'prepare' : 'analyze'}">${job.kind === 'prepare' ? '重试准备仓库' : '重试分析'} ${icon('refresh', 12)}</button>
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
                  <div class="mono faint" style="font-size:10px">仓库就绪后选择分支分析</div>
                  <button class="btn btn--sm btn--primary mt-8" data-action="open">选择分支并分析 ${icon('arrow', 12)}</button>
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

function createModal(navigate) {
  openModal({
    eyebrow: 'NEW TARGET',
    title: '接入观测目标',
    width: '600px',
    closeOnBackdrop: false,
    body: `
      <div class="field">
        <label for="np-name">产品名称</label>
        <input class="input" id="np-name" placeholder="例如：CloudMall 云商城" maxlength="60" />
      </div>
      <div class="field">
        <label for="np-repo">Git 仓库地址</label>
        <input class="input" id="np-repo" placeholder="https://github.com/org/repo.git  或  /本地/仓库路径" />
        <div class="help">支持 HTTPS / SSH / 本地绝对路径。首次分析会把仓库镜像到本地 <span class="mono">data/repos/</span>，不会修改你的工作区。</div>
      </div>
      <div class="field">
        <label for="np-desc">一句话描述（可选）</label>
        <input class="input" id="np-desc" placeholder="这个系统是做什么的" maxlength="300" />
      </div>
      <div class="banner">
        <span>${icon('pulse', 16)}</span>
        <div>创建后会先在后台克隆仓库并列出所有分支，然后你可以勾选分支逐个分析（任务自动排队）。没有配置大模型 Key 时使用启发式分析，配置后可获得语义化架构与风险判断。<a href="#/settings" data-close-modal>去配置模型</a></div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建并开始分析',
        primary: true,
        onClick: async (close, modal) => {
          const name = modal.querySelector('#np-name').value.trim();
          const repoUrl = modal.querySelector('#np-repo').value.trim();
          const description = modal.querySelector('#np-desc').value.trim();
          if (!name) {
            toast('请填写产品名称', { type: 'warn' });
            modal.querySelector('#np-name').focus();
            return false;
          }
          if (!repoUrl) {
            toast('请填写 Git 仓库地址', { type: 'warn' });
            modal.querySelector('#np-repo').focus();
            return false;
          }
          try {
            const result = await api.products.create({ name, repoUrl, description });
            toast('目标已创建，正在准备仓库', { detail: '克隆完成后会显示分支列表' });
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
      modal.querySelector('#np-name').focus();
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
          <p class="page-sub">接入任意 Git 仓库，自动生成可下钻的系统架构图、安全架构守护清单、业务知识图谱、复杂度与测试覆盖度，并对比不同分支之间的架构漂移与风险。</p>
        </div>
        <div class="masthead-right">
          <div class="masthead-meta">LOCAL-FIRST · SQLITE<br/><b>数据只保存在这台机器</b></div>
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
            <p class="page-sub" style="margin-bottom:24px">填入 Git 仓库地址即可开始。ArcVista 会克隆一份镜像，静态解析模块、依赖、路由、安全配置与测试，再绘制成可交互的架构看板。仓库不会产生任何改动。</p>
            <div class="row row--wrap" style="gap:10px">
              <button class="btn btn--primary" data-action="create">${icon('plus', 15)} 接入第一个仓库</button>
              <span class="mono faint" style="font-size:10.5px">示例本地路径：${esc(SAMPLE_REPO)}</span>
            </div>
            <div class="grid grid--3 mt-24" style="gap:14px">
              <div class="stat"><div class="stat-label">架构洞察</div><div class="stat-note mt-8">分层架构图 · 双击节点下钻到模块内部结构</div></div>
              <div class="stat"><div class="stat-label">质量观测</div><div class="stat-note mt-8">安全守护 · 复杂度 · 测试覆盖 · 业务知识图谱</div></div>
              <div class="stat"><div class="stat-label">分支对比</div><div class="stat-note mt-8">守护规则增减 · 依赖升级 · 复杂度漂移与风险判断</div></div>
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
      message: '会同时删除本地快照、分析缓存与仓库镜像，此操作不可撤销。',
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
      toast('开始准备仓库');
      refresh();
    } catch (error) {
      toast('无法准备仓库', { type: 'error', detail: error.message });
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
