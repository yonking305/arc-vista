import { api } from '../api.js';
import { $, esc, icon, toast, fmtNum, fmtBytes, timeAgo } from '../dom.js';
import { themeGridHTML, mountThemeGrid, currentTheme } from '../theme.js';

export async function renderSettings(main, ctx) {
  let settings;
  let health = null;
  try {
    settings = await api.settings.get();
    health = await api.health();
  } catch (error) {
    main.innerHTML = `<div class="page"><div class="banner banner--red"><strong>无法加载设置</strong> ${esc(error.message)}</div></div>`;
    return {};
  }
  const llm = settings.llm || {};
  const dshManaged = document.documentElement.dataset.dsh === '1';

  main.innerHTML = `
    <div class="page page--narrow">
      <header class="masthead">
        <div>
          <div class="eyebrow">CONFIGURATION · 观测参数</div>
          <h1 class="page-title">${dshManaged ? '观测<em>配置</em>' : '模型与<em>观测配置</em>'}</h1>
          <p class="page-sub">${dshManaged ? 'ArcVista 现在运行在 DSH 插件中，模型由 DSH 统一提供，不需要单独配置 API Key。分析结论与快照仍保存在本机。' : 'ArcVista 是本地工具，分析结论与快照全部保存在你自己的机器上。配置一个 OpenAI 兼容的大模型后，架构语义、业务知识图谱、风险判断与模块下钻会由模型增强；不配置也能使用完整的启发式分析。'}</p>
        </div>
        <div class="masthead-right">
          <div class="masthead-meta">${dshManaged ? 'DSH MODEL' : llm.enabled ? 'MODEL ONLINE' : 'HEURISTIC MODE'}<br/><b>${dshManaged ? esc(llm.model || 'DSH') : llm.enabled ? esc(llm.model || '') : '需要在下方配置 Key'}</b></div>
          <a class="btn" href="#/">${icon('back', 13)} 返回观测台</a>
        </div>
      </header>

      ${
        health?.backups?.restoredFrom
          ? `<div class="banner banner--teal mb-24"><span>${icon('shield', 16)}</span><div><strong>已从备份自动恢复</strong> 检测到数据目录缺少数据库，已自动从最近一次备份恢复：<span class="mono">${esc(health.backups.restoredFrom)}</span></div></div>`
          : ''
      }

      <div class="panel mb-24">
        <div class="panel-head">
          <div>
            <div class="panel-title">外观 · APPEARANCE</div>
            <div class="panel-sub">皮肤只改变配色，不影响任何分析结果；选择保存在本地浏览器</div>
          </div>
          <span class="chip chip--amber" id="current-theme-chip">当前：${esc(currentTheme().name)}</span>
        </div>
        <div class="panel-body">
          <div id="theme-grid-settings">${themeGridHTML()}</div>
        </div>
      </div>

      ${dshManaged ? `<div class="banner banner--teal mb-24"><span>${icon('shield', 16)}</span><div><strong>模型由 DSH 统一提供</strong> 当前使用 <span class="mono">${esc(llm.model || 'DSH')}</span>，无需配置 API Key；密钥由 DSH 管理。</div></div>` : ''}
      <div class="settings-grid">
        <div class="panel" ${dshManaged ? 'style="display:none"' : ''}>
          <div class="panel-head">
            <div>
              <div class="panel-title">大模型配置 · MODEL</div>
              <div class="panel-sub">支持 DeepSeek / OpenAI / Moonshot / 通义千问 / 本地 Ollama 等 OpenAI 兼容接口</div>
            </div>
            <span class="badge ${llm.enabled ? 'badge--good' : 'badge--medium'}">${llm.enabled ? '已启用' : llm.hasKey ? '待校验' : '未配置'}</span>
          </div>
          <div class="panel-body stack">
            <div>
              <div class="help mb-8">快速选择服务商</div>
              <div class="preset-grid" id="presets">
                ${(settings.presets || [])
                  .map(
                    (preset) =>
                      `<button type="button" class="preset-btn" data-base="${esc(preset.baseUrl)}" data-model="${esc(preset.model)}"><b>${esc(preset.label)}</b>${esc(preset.model)}</button>`,
                  )
                  .join('')}
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="set-base">Base URL</label>
                <input class="input" id="set-base" value="${esc(llm.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" />
              </div>
              <div class="field">
                <label for="set-model">模型</label>
                <input class="input" id="set-model" value="${esc(llm.model || '')}" placeholder="deepseek-chat" />
              </div>
            </div>
            <div class="field">
              <label for="set-key">API Key</label>
              <input class="input" id="set-key" type="password" autocomplete="off"
                placeholder="${llm.hasKey ? `已保存 ${esc(llm.apiKeyMasked || '')}（留空保持不变）` : 'sk-...'}" />
              <div class="help">${llm.envKey ? '检测到环境变量 ARCVISTA_LLM_API_KEY，环境变量优先于页面配置。' : '密钥只写入本地 SQLite，不会发送到客户端以外的任何地方。'}</div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="set-mode">分析模式</label>
                <select class="select" id="set-mode">
                  <option value="auto" ${llm.mode !== 'off' ? 'selected' : ''}>自动：有 Key 就用模型增强</option>
                  <option value="off" ${llm.mode === 'off' ? 'selected' : ''}>仅启发式：不调用模型</option>
                </select>
              </div>
              <div class="field">
                <label for="set-temp">Temperature</label>
                <input class="input" id="set-temp" type="number" step="0.1" min="0" max="1.5" value="${esc(llm.temperature ?? 0.2)}" />
              </div>
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn btn--primary" id="save-settings">${icon('shield', 13)} 保存配置</button>
              <button class="btn" id="test-settings">${icon('pulse', 13)} 测试连接</button>
              ${llm.hasKey ? '<button class="btn btn--danger" id="clear-key">清除 Key</button>' : ''}
            </div>
            <div id="test-result"></div>
          </div>
        </div>

        <aside class="stack">
          <div class="panel">
            <div class="panel-head"><div><div class="panel-title">当前状态</div></div></div>
            <div class="panel-body">
              <dl class="kv-list">
                <div class="kv"><dt>模型增强</dt><dd>${dshManaged ? '<span class="teal">由 DSH 提供</span>' : llm.enabled ? '<span class="teal">已启用</span>' : '<span class="amber">启发式模式</span>'}</dd></div>
                <div class="kv"><dt>Base URL</dt><dd class="mono" style="font-size:10px;word-break:break-all">${dshManaged ? 'DSH 内置' : esc(llm.baseUrl || '—')}</dd></div>
                <div class="kv"><dt>模型</dt><dd class="mono">${esc(llm.model || '—')}</dd></div>
                ${dshManaged ? '' : `<div class="kv"><dt>Key</dt><dd class="mono">${llm.hasKey ? esc(llm.apiKeyMasked || '已保存') : llm.envKey ? '来自环境变量' : '未配置'}</dd></div>`}
                <div class="kv"><dt>数据目录</dt><dd class="mono" style="font-size:10px;word-break:break-all">${esc(health?.dataDir || '—')}</dd></div>
                <div class="kv"><dt>备份目录</dt><dd class="mono" style="font-size:10px;word-break:break-all">${esc(health?.backups?.dir || '—')}</dd></div>
                <div class="kv"><dt>最近备份</dt><dd>${health?.backups?.latest ? `${esc(timeAgo(health.backups.latest.at))} · ${esc(fmtBytes(health.backups.latest.size))}` : '暂无'}</dd></div>
                <div class="kv"><dt>运行环境</dt><dd class="mono">${esc(health?.node || '')}</dd></div>
              </dl>
              <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
                <button class="btn btn--sm" id="backup-now">${icon('shield', 12)} 立即备份数据</button>
                <span class="help" id="backup-note">${health?.backups?.count ? `已保留 ${health.backups.count} 份备份` : '启动与分析后会自动备份'}</span>
              </div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head"><div><div class="panel-title">模型增强了什么</div></div></div>
            <div class="panel-body">
              <ul class="bullet-list">
                <li>架构图的业务命名、分组与外部系统补全</li>
                <li>业务域、业务能力、主业务流程与跨域事实</li>
                <li>基于指标与代码证据的风险判断和治理建议</li>
                <li>模块下钻的职责说明、内部结构与追问回答</li>
              </ul>
              <div class="divider"></div>
              <div class="help">没有 Key 时，架构、依赖、安全守护、复杂度、覆盖率、知识图谱仍由静态分析引擎生成，风险规则照常运行。快照会记录当次使用的引擎，可随时重新分析。</div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head"><div><div class="panel-title">环境变量方式</div></div></div>
            <div class="panel-body">
              <div class="help" style="line-height:2">
                也可以不写页面配置，直接用环境变量启动：<br/>
                <span class="mono" style="color:var(--text-dim)">ARCVISTA_LLM_API_KEY=sk-xxx<br/>ARCVISTA_LLM_BASE_URL=https://api.deepseek.com/v1<br/>ARCVISTA_LLM_MODEL=deepseek-chat<br/>npm start</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
      <footer class="footer-note"><span>ArcVista · 本地优先</span><span>${health ? `UPTIME ${fmtNum(health.uptime)}s` : ''}</span></footer>
    </div>`;

  $('#backup-now', main)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const data = await api.backup();
      const note = $('#backup-note', main);
      if (note) note.textContent = `已备份 · ${timeAgo(data.backup.at)} · ${fmtBytes(data.backup.size)}`;
      toast('数据库已备份', { detail: data.backup.file });
    } catch (error) {
      toast('备份失败', { type: 'error', detail: error.message });
    } finally {
      button.disabled = false;
    }
  });

  mountThemeGrid($('#theme-grid-settings', main), {
    onSelect: (theme) => {
      const chip = $('#current-theme-chip', main);
      if (chip) chip.textContent = `当前：${theme.name}`;
    },
  });

  const baseInput = $('#set-base', main);
  const modelInput = $('#set-model', main);
  const keyInput = $('#set-key', main);
  const modeSelect = $('#set-mode', main);
  const tempInput = $('#set-temp', main);
  const resultBox = $('#test-result', main);

  $('#presets', main).addEventListener('click', (event) => {
    const button = event.target.closest('.preset-btn');
    if (!button) return;
    baseInput.value = button.dataset.base;
    modelInput.value = button.dataset.model;
    toast(`已填入 ${button.querySelector('b').textContent} 配置`);
  });

  async function save(extra = {}) {
    const payload = {
      baseUrl: baseInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: keyInput.value.trim(),
      mode: modeSelect.value,
      temperature: Number(tempInput.value),
      ...extra,
    };
    const data = await api.settings.update(payload);
    toast('配置已保存');
    keyInput.value = '';
    Object.assign(llm, data.llm);
    ctx.reload();
  }

  $('#save-settings', main).addEventListener('click', async () => {
    try {
      await save();
    } catch (error) {
      toast('保存失败', { type: 'error', detail: error.message });
    }
  });

  $('#clear-key', main)?.addEventListener('click', async () => {
    try {
      await save({ apiKey: '', clearKey: true });
      toast('已清除本地 Key');
    } catch (error) {
      toast('操作失败', { type: 'error', detail: error.message });
    }
  });

  $('#test-settings', main).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> 测试中`;
    resultBox.innerHTML = '';
    try {
      const data = await api.settings.test();
      const result = data.result;
      resultBox.innerHTML = `<div class="test-result ${result.ok ? 'ok' : 'fail'}">
        <b>${result.ok ? '连接成功' : '连接失败'}</b>
        <div class="mt-8" style="font-size:11.5px;color:var(--text-dim)">${esc(result.message)}</div>
        <div class="mt-8 mono faint" style="font-size:10px">${esc(result.model || '')} · ${esc(result.endpoint || '')} · ${result.latencyMs || 0}ms</div>
      </div>`;
    } catch (error) {
      resultBox.innerHTML = `<div class="test-result fail"><b>连接失败</b><div class="mt-8" style="font-size:11.5px">${esc(error.message)}</div></div>`;
    } finally {
      button.disabled = false;
      button.innerHTML = `${icon('pulse', 13)} 测试连接`;
    }
  });

  return {};
}
