/* Module drill-down drawer: structure + LLM narrative + follow-up questions. */

import { api } from '../api.js';
import { esc, icon, poll, toast, fmtNum, fmtPct } from '../dom.js';
import { renderMiniGraph } from './diagram.js';

function metricCell(label, value, suffix = '') {
  return `<div class="dm"><span>${esc(label)}</span><b>${value === null || value === undefined ? '—' : `${fmtNum(value)}${suffix}`}</b></div>`;
}

function riskCards(risks = []) {
  if (!risks.length) return '<div class="diff-empty">未发现明显风险</div>';
  return risks
    .map(
      (risk) => `
    <div class="risk-card risk-card--${['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'low'}" style="margin-bottom:10px;padding:14px 16px 14px 18px">
      <div class="spread">
        <div class="risk-title" style="font-size:13px">${esc(risk.title)}</div>
        <span class="badge badge--${risk.level || 'low'}">${risk.level === 'high' ? '高风险' : risk.level === 'medium' ? '中风险' : '低风险'}</span>
      </div>
      <div class="risk-detail" style="font-size:11.5px">${esc(risk.detail)}</div>
      ${risk.action ? `<div class="risk-action" style="font-size:11px"><b>建议</b> ${esc(risk.action)}</div>` : ''}
    </div>`,
    )
    .join('');
}

function renderResult(result) {
  const metrics = result.metrics || {};
  const module = result.module || {};
  const internalGraph = result.internalGraph || { nodes: [], edges: [] };
  const flows = result.flows || [];
  const apis = result.apis || [];
  const dependencies = result.dependencies || { incoming: [], outgoing: [] };
  const question = result.question;
  const answer = result.answer || result.dependenciesInterpretation;

  return `
    <div class="row row--wrap" style="gap:8px">
      ${module.domain ? `<span class="chip chip--amber">${esc(module.domain.label)}</span>` : ''}
      <span class="chip chip--dim">${esc(module.type || 'module')}</span>
      <span class="chip chip--dim">${esc(module.langs?.[0]?.lang || 'code')}</span>
      <span class="chip ${result.generatedBy === 'llm' ? 'chip--violet' : 'chip--dim'}">${result.generatedBy === 'llm' ? 'LLM 深度分析' : '结构分析'}</span>
      ${result.cached ? '<span class="chip chip--dim">已缓存</span>' : ''}
    </div>

    <div class="drill-metrics">
      ${metricCell('代码行', metrics.loc)}
      ${metricCell('源文件', metrics.sourceFiles)}
      ${metricCell('测试文件', metrics.testFiles)}
      ${metricCell('复杂度', metrics.complexity)}
      ${metricCell('覆盖率', metrics.coverage, '%')}
      ${metricCell('对外接口', metrics.endpoints)}
      ${metricCell('调用方', metrics.callers ?? metrics.fanIn)}
      ${metricCell('扇出', metrics.fanOut)}
    </div>

    <div class="drawer-section">
      <h4>模块职责</h4>
      <p class="drawer-summary">${esc(result.summary || '')}</p>
      ${result.llmWarning ? `<div class="banner mt-8" style="font-size:11px">大模型增强失败，展示结构分析：${esc(result.llmWarning)}</div>` : ''}
    </div>

    ${
      (result.responsibilities || []).length
        ? `<div class="drawer-section"><h4>核心职责</h4><ul class="duty-list">${result.responsibilities
            .map((item) => `<li>${esc(item)}</li>`)
            .join('')}</ul></div>`
        : ''
    }

    <div class="drawer-section">
      <h4>内部结构</h4>
      <div class="mini-canvas" id="drill-mini"></div>
      <div class="help mt-8">按目录/包聚合的内部依赖；箭头表示引用方向。</div>
    </div>

    ${
      flows.length
        ? `<div class="drawer-section"><h4>关键流程</h4><div class="flow-list">${flows
            .map(
              (flow) => `
          <div class="flow-row">
            <b>${esc(flow.name)}</b>
            <div class="steps">${(flow.steps || [])
              .map((step, index) => `<span>${String(index + 1).padStart(2, '0')}</span>${esc(typeof step === 'string' ? step : step.label)}`)
              .join('　')}</div>
          </div>`,
            )
            .join('')}</div></div>`
        : ''
    }

    <div class="drawer-section">
      <h4>依赖关系</h4>
      <div class="dep-cols">
        <div>
          <div class="mono faint" style="font-size:9px;letter-spacing:.16em;margin-bottom:6px">被依赖 · INCOMING</div>
          ${dependencies.incoming.length
            ? dependencies.incoming
                .map((dep) => `<div class="dep-item"><span>${esc(dep.label)}</span><span class="mono">×${dep.count}</span></div>`)
                .join('')
            : '<div class="diff-empty">无内部模块依赖</div>'}
        </div>
        <div>
          <div class="mono faint" style="font-size:9px;letter-spacing:.16em;margin-bottom:6px">依赖 · OUTGOING</div>
          ${dependencies.outgoing.length
            ? dependencies.outgoing
                .map((dep) => `<div class="dep-item"><span>${esc(dep.label)}</span><span class="mono">×${dep.count}</span></div>`)
                .join('')
            : '<div class="diff-empty">无内部模块依赖</div>'}
        </div>
      </div>
    </div>

    ${apis.length ? `<div class="drawer-section"><h4>对外接口 · ${apis.length}</h4><div>${apis
      .map(
        (apiItem) => `<div class="api-row"><span class="verb">${esc(apiItem.method)}</span><span class="p">${esc(apiItem.path)}</span></div>`,
      )
      .join('')}</div></div>` : ''}

    ${
      (result.dataStores || []).length
        ? `<div class="drawer-section"><h4>数据与中间件</h4><div class="row row--wrap">${result.dataStores
            .map((item) => `<span class="chip chip--teal">${esc(item)}</span>`)
            .join('')}</div></div>`
        : ''
    }

    <div class="drawer-section">
      <h4>模块风险</h4>
      ${riskCards(result.risks)}
    </div>

    ${
      (result.recommendations || []).length
        ? `<div class="drawer-section"><h4>改进建议</h4><ul class="bullet-list">${result.recommendations
            .map((item) => `<li>${esc(item)}</li>`)
            .join('')}</ul></div>`
        : ''
    }

    ${
      (result.symbols || []).length
        ? `<div class="drawer-section"><h4>关键符号</h4><div class="symbol-cloud">${result.symbols
            .map((item) => `<span>${esc(item)}</span>`)
            .join('')}</div></div>`
        : ''
    }

    <div class="drawer-section">
      <h4>追问这个模块</h4>
      <form class="ask-box" id="drill-ask">
        <input class="input" name="question" placeholder="例如：订单状态机在哪些文件里实现？失败重试如何处理？" maxlength="300" />
        <button class="btn btn--primary" type="submit">提问 ${icon('arrow', 13)}</button>
      </form>
      <div id="drill-answer" class="mt-16">
        ${question && answer ? `<div class="banner banner--teal"><div><strong>回答</strong><br/>${esc(answer)}</div></div>` : ''}
      </div>
    </div>`;
}

export function openDrillDrawer({ productId, snapshotId, node, onClose }) {
  const modulePath =
    node.module ||
    (typeof node.domain === 'string' && node.domain.startsWith('domain:') ? node.domain.slice(7) : null) ||
    (typeof node.id === 'string' && node.id.startsWith('domain:') ? node.id.slice(7) : null);
  const title = node.label || node.name || '模块分析';
  let disposed = false;
  let controller = null;
  const abort = new AbortController();

  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.innerHTML = `
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="drawer-head">
        <div style="min-width:0">
          <div class="eyebrow">MODULE DRILL-DOWN</div>
          <div class="drawer-title">${esc(title)}</div>
          <div class="drawer-path">${esc(modulePath || node.path || node.id || '')}</div>
        </div>
        <button class="btn btn--icon btn--ghost" data-drill-close aria-label="关闭">${icon('close', 16)}</button>
      </header>
      <div class="drawer-body" id="drill-body">
        <div class="row"><span class="spinner"></span><span class="mono faint">正在读取模块证据…</span></div>
      </div>
    </aside>`;
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  const body = backdrop.querySelector('#drill-body');

  const close = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    controller?.destroy?.();
    backdrop.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector('[data-drill-close]').addEventListener('click', close);

  function attachMini(result) {
    const canvas = body.querySelector('#drill-mini');
    if (!canvas) return;
    renderMiniGraph(canvas, result.internalGraph || { nodes: [], edges: [] }, { height: 280 });
  }

  async function runJob(start, { onProgress } = {}) {
    const { job } = await start();
    let final = job;
    await poll(
      async () => {
        if (disposed) return false;
        const data = await api.jobs.get(job.id);
        final = data.job;
        if (onProgress) onProgress(final);
        return ['done', 'error'].includes(final.status) ? false : true;
      },
      { interval: 1000, signal: abort.signal },
    );
    return final;
  }

  async function analyze(question = '') {
    body.innerHTML = `
      <div class="job-banner" style="margin:0 0 18px">
        <span class="spinner"></span>
        <div class="job-text">
          <div class="job-title">DRILL-DOWN · ${question ? '追问' : '结构分析'}</div>
          <div class="job-msg">${question ? esc(question) : '正在提取文件、依赖、接口与测试证据…'}</div>
          <div class="job-log"></div>
        </div>
        <span class="job-pct">0%</span>
      </div>`;
    try {
      const job = await runJob(
        () => api.products.drill(productId, { snapshotId, modulePath, question }),
        {
          onProgress: (current) => {
            const msg = body.querySelector('.job-msg');
            const log = body.querySelector('.job-log');
            const pct = body.querySelector('.job-pct');
            if (msg) msg.textContent = current.message || '分析中';
            if (pct) pct.textContent = `${current.progress || 0}%`;
            if (log) {
              log.innerHTML = (current.logs || [])
                .slice(-4)
                .map((item) => `<span>${esc(item.text)}</span>`)
                .join('');
            }
          },
        },
      );
      if (disposed) return;
      if (job.status === 'error') throw new Error(job.error || '模块分析失败');
      const result = job.result;
      if (!result) throw new Error('模块分析没有返回结果');

      if (question) {
        const answerArea = body.querySelector('#drill-answer');
        if (answerArea) {
          answerArea.innerHTML = `<div class="banner banner--teal"><div><strong>回答</strong><br/>${esc(result.answer || result.summary || '未生成回答')}</div></div>`;
        }
        return;
      }

      body.innerHTML = renderResult(result);
      attachMini(result);
      const form = body.querySelector('#drill-ask');
      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = form.querySelector('input').value.trim();
        if (!value) return;
        const answerArea = body.querySelector('#drill-answer');
        answerArea.innerHTML = '<div class="row"><span class="spinner"></span><span class="mono faint">正在追问…</span></div>';
        try {
          const { job: askJob } = await api.products.drill(productId, { snapshotId, modulePath, question: value });
          const askFinal = await waitJob(askJob.id);
          if (askFinal.status === 'error') throw new Error(askFinal.error);
          answerArea.innerHTML = `<div class="banner banner--teal"><div><strong>回答</strong><br/>${esc(
            askFinal.result?.answer || askFinal.result?.summary || '未生成回答',
          )}</div></div>`;
        } catch (error) {
          answerArea.innerHTML = `<div class="banner banner--red">${esc(error.message)}</div>`;
        }
      });
    } catch (error) {
      if (disposed) return;
      body.innerHTML = `
        <div class="banner banner--red">
          <div><strong>模块分析失败</strong><br/>${esc(error.message)}</div>
        </div>
        <div class="row mt-16">
          <button class="btn" data-retry>重试 ${icon('refresh', 13)}</button>
        </div>`;
      body.querySelector('[data-retry]')?.addEventListener('click', () => analyze(question));
    }
  }

  async function waitJob(jobId) {
    let final = null;
    await poll(
      async () => {
        const data = await api.jobs.get(jobId);
        final = data.job;
        return ['done', 'error'].includes(final.status) ? false : true;
      },
      { interval: 1000, signal: abort.signal },
    );
    return final;
  }

  if (!modulePath) {
    body.innerHTML = `
      <div class="banner">
        <div>该节点是基础设施或外部系统，没有可直接下钻的代码模块。它的依赖关系已经体现在架构图中。</div>
      </div>
      ${node.tag ? `<div class="drawer-section"><h4>节点信息</h4><dl class="kv-list"><div class="kv"><dt>类型</dt><dd>${esc(node.kind || '')}</dd></div><div class="kv"><dt>标签</dt><dd>${esc(node.tag)}</dd></div>${node.sublabel ? `<div class="kv"><dt>技术</dt><dd>${esc(node.sublabel)}</dd></div>` : ''}</dl></div>` : ''}`;
    return { close };
  }

  analyze('').catch((error) => toast('模块分析失败', { type: 'error', detail: error.message }));

  return {
    close,
    destroy: () => controller?.destroy?.(),
  };
}
