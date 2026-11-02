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
              <span class="mono" style="color:var(--amber);font-size:10px;letter-spacing:.1em">${job.kind === 'clone' ? '克隆并分析' : '本地项目分析'}</span>
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
              <button class="btn btn--sm mt-8" data-action="${job.kind === 'clone' ? 'clone' : 'analyze'}">${job.kind === 'clone' ? '重试克隆' : '重试分析'} ${icon('refresh', 12)}</button>
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
  const workspaceOptions = workspaces
    .map((workspace) => `<option value="${esc(workspace.path)}" data-title="${esc(workspace.title || '')}">${esc(workspace.title || workspace.path)} — ${esc(workspace.path)}</option>`)
    .join('');

  openModal({
    eyebrow: 'NEW PROJECT',
    title: '接入项目',
    width: '640px',
    closeOnBackdrop: false,
    body: `
      <div class="field">
        <label>接入方式</label>
        <div class="row" id="np-modes" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn--sm btn--primary" data-mode="local">本地项目</button>
          <button type="button" class="btn btn--sm" data-mode="git">Git 仓库</button>
          <button type="button" class="btn btn--sm" data-mode="batch">批量 Git</button>
        </div>
      </div>
      <div class="field" id="np-name-field">
        <label for="np-name">项目名称（可选）</label>
        <input class="input" id="np-name" placeholder="留空时使用目录名或仓库名" maxlength="60" />
      </div>
      <div id="np-local-panel">
        <div class="field">
          <label for="np-path">本地项目目录</label>
          <div class="row" style="gap:8px">
            <input class="input" id="np-path" placeholder="/Users/you/projects/my-app" />
            <button class="btn" id="np-pick" type="button" style="flex:none">选择文件夹</button>
          </div>
          <div id="np-browse" style="display:none;margin-top:10px;border:1px solid var(--border);border-radius:10px;padding:10px;max-height:260px;overflow:auto"></div>
          <div class="help">填写绝对路径，或从系统/DSH 文件夹选择器选择。ArcVista 直接分析当前工作区，不克隆、不拉取、不切换分支；分析产出写入项目内的 <span class="mono">.arcvista/</span>。</div>
        </div>
      </div>
      <div id="np-remote-panel" style="display:none">
        <div class="field">
          <label for="np-workspace">克隆到工作空间</label>
          ${workspaces.length
            ? `<select class="input" id="np-workspace">${workspaceOptions}</select>
               <input class="input mt-8" id="np-workspace-path" placeholder="或手动输入工作空间绝对路径" />`
            : `<input class="input" id="np-workspace-path" placeholder="/Users/you/workspaces" />`}
          <div class="help">Git 仓库会 clone 到这个工作空间下，目录名取自仓库名。多个仓库会分别生成项目。</div>
        </div>
        <div class="field" id="np-single-field">
          <label for="np-git-url">Git 地址</label>
          <input class="input" id="np-git-url" placeholder="https://github.com/org/repo.git" />
        </div>
        <div class="field" id="np-batch-field" style="display:none">
          <label for="np-git-urls">Git 地址列表</label>
          <textarea class="input" id="np-git-urls" rows="5" placeholder="每行一个 Git 地址"></textarea>
        </div>
      </div>
      <div class="field">
        <label for="np-desc">一句话描述（可选）</label>
        <input class="input" id="np-desc" placeholder="这个系统是做什么的" maxlength="300" />
      </div>
      <div class="banner">
        <span>${icon('pulse', 16)}</span>
        <div id="np-mode-hint">创建后立即分析当前工作区，项目列表记录在 ArcVista 全局数据目录，快照与下钻结果写入项目内的 <span class="mono">.arcvista/</span>。模型由 DSH 统一提供。</div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建项目',
        primary: true,
        onClick: async (close, modal) => {
          const mode = modal.dataset.mode || 'local';
          const description = modal.querySelector('#np-desc').value.trim();
          if (mode === 'local') {
            const projectPath = modal.querySelector('#np-path').value.trim();
            const name = modal.querySelector('#np-name').value.trim() || pathName(projectPath);
            if (!name) {
              toast('请填写项目名称', { type: 'warn' });
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
              toast('创建失败', {
                type: 'error',
                detail: /Git 仓库地址不能为空/.test(error.message)
                  ? '当前仍是旧版 Host，请重启 DSH 加载 ArcVista 0.2.x 后再创建项目'
                  : error.message,
              });
              return false;
            }
            return true;
          }

          const workspace =
            modal.querySelector('#np-workspace-path')?.value.trim() ||
            modal.querySelector('#np-workspace')?.value.trim() ||
            '';
          const urls = mode === 'batch'
            ? (modal.querySelector('#np-git-urls').value || '').split(/\s*\n\s*/).map((item) => item.trim()).filter(Boolean)
            : [modal.querySelector('#np-git-url').value.trim()].filter(Boolean);
          if (!workspace) {
            toast('请选择或填写工作空间', { type: 'warn' });
            return false;
          }
          if (urls.length === 0) {
            toast('请填写 Git 地址', { type: 'warn' });
            return false;
          }
          try {
            const result = await api.products.import({ workspace, urls, description });
            const count = result.projects?.length || urls.length;
            toast(`已开始克隆 ${count} 个仓库`, { detail: '克隆完成后会自动分析当前工作区' });
            close();
            if (result.projects?.[0]?.product?.id) {
              navigate(`/p/${result.projects[0].product.id}`);
            } else {
              navigate('/');
            }
          } catch (error) {
            toast('导入失败', { type: 'error', detail: error.message });
            return false;
          }
          return true;
        },
      },
    ],
    onMount: (modal) => {
      modal.dataset.mode = 'local';
      const pathInput = modal.querySelector('#np-path');
      const nameInput = modal.querySelector('#np-name');
      const pickButton = modal.querySelector('#np-pick');
      const browseBox = modal.querySelector('#np-browse');
      const workspaceSelect = modal.querySelector('#np-workspace');
      const workspacePath = modal.querySelector('#np-workspace-path');
      const hint = modal.querySelector('#np-mode-hint');

      const choosePath = (selected) => {
        if (!selected) return;
        pathInput.value = selected;
        if (!nameInput.value.trim()) nameInput.value = pathName(selected);
        browseBox.style.display = 'none';
      };

      workspaceSelect?.addEventListener('change', () => {
        if (workspaceSelect.value && workspacePath) workspacePath.value = workspaceSelect.value;
      });
      if (workspaceSelect?.value && workspacePath) workspacePath.value = workspaceSelect.value;

      pathInput.addEventListener('blur', () => {
        if (!nameInput.value.trim()) nameInput.value = pathName(pathInput.value);
      });

      async function renderBrowser(directoryPath) {
        browseBox.style.display = 'block';
        browseBox.innerHTML = '<div class="help">正在读取目录…</div>';
        try {
          const response = await api.directoryPicker.list(directoryPath);
          const listing = response.listing;
          const parent = listing.crumbs?.[listing.crumbs.length - 2]?.path || listing.home;
          browseBox.innerHTML = `
            <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
              <button class="btn btn--sm" type="button" data-browse-parent>↑ 上一级</button>
              <button class="btn btn--sm btn--primary" type="button" data-browse-use>使用此目录</button>
              <span class="mono" style="font-size:10px;color:var(--text-dim);word-break:break-all">${esc(listing.path)}</span>
            </div>
            <div style="margin-top:8px;display:grid;gap:2px">
              ${listing.entries.length
                ? listing.entries.map((entry) => `<button class="btn btn--sm" type="button" style="justify-content:flex-start" data-browse-dir="${esc(entry.path)}">${icon('folder', 12)} ${esc(entry.name)}</button>`).join('')
                : '<div class="help">这个目录下没有子文件夹。</div>'}
            </div>`;
          browseBox.querySelector('[data-browse-parent]')?.addEventListener('click', () => renderBrowser(parent));
          browseBox.querySelector('[data-browse-use]')?.addEventListener('click', () => choosePath(listing.path));
          browseBox.querySelectorAll('[data-browse-dir]').forEach((button) => {
            button.addEventListener('click', () => renderBrowser(button.dataset.browseDir));
          });
        } catch (error) {
          browseBox.innerHTML = `<div class="banner banner--red" style="padding:8px 10px">${esc(error.message)}</div>`;
        }
      }

      api.directoryPicker.capability()
        .then((capability) => {
          if (!capability?.available) {
            pickButton.style.display = 'none';
            return;
          }
          pickButton.textContent = capability.native ? '选择文件夹' : '浏览文件夹';
          pickButton.addEventListener('click', async () => {
            if (!capability.native) {
              renderBrowser(pathInput.value.trim() || '');
              return;
            }
            pickButton.disabled = true;
            const original = pickButton.textContent;
            pickButton.textContent = '等待选择…';
            try {
              const result = await api.directoryPicker.pick();
              if (result?.path) choosePath(result.path);
            } catch (error) {
              toast('无法打开文件夹选择器', { type: 'error', detail: error.message });
            } finally {
              pickButton.disabled = false;
              pickButton.textContent = original;
            }
          });
        })
        .catch(() => {
          pickButton.style.display = 'none';
        });

      const setMode = (mode) => {
        modal.dataset.mode = mode;
        modal.querySelectorAll('#np-modes [data-mode]').forEach((button) => {
          button.classList.toggle('btn--primary', button.dataset.mode === mode);
        });
        const local = mode === 'local';
        modal.querySelector('#np-local-panel').style.display = local ? '' : 'none';
        modal.querySelector('#np-remote-panel').style.display = local ? 'none' : '';
        modal.querySelector('#np-name-field').style.display = local ? '' : 'none';
        modal.querySelector('#np-single-field').style.display = mode === 'git' ? '' : 'none';
        modal.querySelector('#np-batch-field').style.display = mode === 'batch' ? '' : 'none';
        hint.innerHTML = local
          ? '创建后立即分析当前工作区，项目列表记录在 ArcVista 全局数据目录，快照与下钻结果写入项目内的 <span class="mono">.arcvista/</span>。模型由 DSH 统一提供。'
          : mode === 'batch'
            ? '会把这些仓库逐个 clone 到所选工作空间，再分别分析当前工作区。目标目录已存在时不会覆盖。'
            : '会把这个仓库 clone 到所选工作空间，再分析当前工作区。目标目录已存在时不会覆盖。';
        const primary = modal.querySelector('.modal-foot .btn--primary');
        if (primary) primary.textContent = local ? '创建项目' : '克隆并分析';
      };
      modal.querySelectorAll('#np-modes [data-mode]').forEach((button) => {
        button.addEventListener('click', () => setMode(button.dataset.mode));
      });
      setMode('local');
      nameInput.focus();
      modal.querySelector('[data-close]')?.addEventListener('click', (event) => {
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
          <p class="page-sub">接入本地项目，或从 Git 克隆到工作空间，自动生成可下钻的系统架构图、安全架构守护清单、业务知识图谱、复杂度与测试覆盖度，并对比不同快照之间的架构漂移与风险。</p>
        </div>
        <div class="masthead-right">
          <div class="masthead-meta">LOCAL-FIRST · JSON<br/><b>数据只保存在这台机器</b></div>
          <button class="btn btn--primary" id="create-product">${icon('plus', 15)} 新建项目</button>
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
            <p class="page-sub" style="margin-bottom:24px">选择本地目录，或填写 Git 地址克隆到工作空间即可开始。ArcVista 读取当前工作区，静态解析模块、依赖、路由、安全配置与测试，再绘制成可交互的架构看板。不会修改你的源码，分析产出写入项目内的 .arcvista/。</p>
            <div class="row row--wrap" style="gap:10px">
              <button class="btn btn--primary" data-action="create">${icon('plus', 15)} 接入第一个项目</button>
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

  delegate(grid, '[data-action="clone"]', 'click', async (event, button) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await api.products.clone(button.closest('.product-card').dataset.id);
      toast('重新开始克隆');
      refresh();
    } catch (error) {
      toast('无法重新克隆', { type: 'error', detail: error.message });
      button.disabled = false;
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
