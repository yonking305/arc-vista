/** OpenAI-compatible LLM client (DeepSeek / OpenAI / Qwen / Moonshot / Ollama...). */

export class LlmError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = meta.status || 0;
    this.detail = meta.detail || '';
  }
}

export function resolveLlmConfig(settings) {
  const baseUrl = String(settings.llm_base_url ?? '').trim();
  const apiKey = String(settings.llm_api_key ?? '').trim();
  const model = String(settings.llm_model ?? '').trim();
  const mode = String(settings.llm_enabled ?? 'auto');
  const temperature = Number(settings.llm_temperature ?? 0.2);
  const enabled = mode !== 'off' && Boolean(baseUrl && model && apiKey);
  return {
    baseUrl,
    apiKey,
    model,
    mode,
    enabled,
    temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : 0.2,
  };
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function chatEndpoint(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function contentOf(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  if (typeof payload?.choices?.[0]?.text === 'string') return payload.choices[0].text;
  return '';
}

async function requestOnce(config, body, timeoutMs) {
  const endpoint = chatEndpoint(config.baseUrl);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new LlmError(`大模型请求超时（${Math.round(timeoutMs / 1000)}s）`, { detail: String(error) });
    }
    throw new LlmError(`无法连接大模型服务：${error.message}`, { detail: String(error.cause || error) });
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 600);
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch {
      /* keep raw */
    }
    throw new LlmError(`大模型返回 ${response.status}：${detail}`, { status: response.status, detail });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new LlmError('大模型返回了非 JSON 响应', { detail: text.slice(0, 400) });
  }
  const content = contentOf(payload);
  if (!content) throw new LlmError('大模型返回内容为空', { detail: text.slice(0, 300) });
  return { content, usage: payload.usage || null };
}

export async function chat(config, { system, user, maxTokens = 4096, timeoutMs = 180000, jsonMode = false }) {
  if (!config.enabled) throw new LlmError('未配置可用的大模型 Key，已使用启发式分析');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const baseBody = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  // DeepSeek V4 models default to high reasoning effort, which can consume the
  // whole output budget and leave an empty content field. Low effort is plenty
  // for structured summaries and keeps JSON responses fast and complete.
  if (/deepseek/i.test(String(config.model || '')) || /deepseek/i.test(String(config.baseUrl || ''))) {
    baseBody.reasoning_effort = 'low';
  }
  const attempts = [];
  if (jsonMode) attempts.push({ ...baseBody, response_format: { type: 'json_object' } });
  attempts.push(baseBody);
  if (jsonMode) attempts.push({ ...baseBody, response_format: { type: 'json_object' } });

  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      const result = await requestOnce(config, attempts[index], timeoutMs);
      return { ...result, endpoint: chatEndpoint(config.baseUrl), attempts: index + 1 };
    } catch (error) {
      lastError = error;
      const retryable =
        error.status === 400 || error.status === 422 || error.status === 429 || error.status >= 500 || error.status === 0;
      if (!retryable || index === attempts.length - 1) break;
      if (error.status === 400 || error.status === 422) continue; // likely response_format unsupported
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw lastError;
}

/** Extract the first balanced JSON object from a model reply (tolerates fences and prose). */
export function extractJson(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function chatJson(config, options) {
  if (typeof config.chat === 'function') {
    const content = await config.chat({
      system: options.system,
      user: options.user,
      maxTokens: options.maxTokens,
      jsonMode: true,
    });
    const parsed = extractJson(content);
    if (!parsed) {
      throw new LlmError('DSH 模型未返回可解析的 JSON', {
        detail: String(content || '').slice(0, 800),
      });
    }
    return { data: parsed, usage: null, raw: content };
  }
  const result = await chat(config, { ...options, jsonMode: true });
  const parsed = extractJson(result.content);
  if (!parsed) {
    throw new LlmError('大模型未返回可解析的 JSON', {
      detail: `${result.content.slice(0, 800)}\n...\n${result.content.slice(-800)}`,
    });
  }
  return { data: parsed, usage: result.usage, raw: result.content };
}

export async function testConnection(config) {
  const startedAt = Date.now();
  try {
    const result = await chat(config, {
      system: '你是 JSON 接口，只输出一个 JSON 对象，不要解释。',
      user: '返回 {"ok": true, "role": "arcvista-check"}',
      maxTokens: 40,
      timeoutMs: 30000,
      jsonMode: true,
    });
    const parsed = extractJson(result.content);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: config.model,
      endpoint: result.endpoint,
      sample: parsed ? JSON.stringify(parsed).slice(0, 120) : result.content.slice(0, 120),
      message: '连接成功，模型可正常返回 JSON',
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: config.model,
      endpoint: chatEndpoint(config.baseUrl || 'https://invalid'),
      message: error.message,
    };
  }
}
