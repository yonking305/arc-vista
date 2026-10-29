/** Host half of the ArcVista bundle: mount the app and route its model calls through DSH. */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArcVistaApp } from './server.js';
import { handleRequest } from './lib/http.js';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const inject = ['webServer', 'llm', 'agentDefaultModel'];

function createDshLlm(ctx) {
  const selection = () => {
    const current = ctx.agentDefaultModel.currentSelection();
    if (!current?.provider || !current?.model) throw new Error('DSH 尚未选择默认模型');
    return current;
  };

  return {
    enabled: true,
    provider: 'dsh',
    get model() {
      try {
        return selection().model;
      } catch {
        return 'DSH';
      }
    },
    temperature: 0.2,
    async chat({ system, user, maxTokens }) {
      const model = selection();
      const stream = ctx.llm.stream({
        provider: model.provider,
        model: model.model,
        reasoningEffort: model.reasoningEffort,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        temperature: 0.2,
        maxTokens: maxTokens || 4096,
      });
      let text = '';
      let finished = false;
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
        if (chunk.type === 'finish') {
          finished = true;
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            const failure = chunk.reason.failure;
            throw new Error(`DSH 模型调用失败：${failure?.message || failure?.code || 'unknown'}`);
          }
          if (chunk.reason.kind !== 'stop') {
            throw new Error(`DSH 模型调用未正常结束：${chunk.reason.kind}`);
          }
        }
      }
      if (!finished) throw new Error('DSH 模型调用没有返回结束标记');
      return text;
    },
  };
}

export function apply(ctx, config = {}) {
  const dataDir = path.resolve(
    config.dataDir ||
      process.env.ARCVISTA_DATA ||
      path.join(process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh'), 'arcvista'),
  );
  const backupDir = path.resolve(config.backupDir || process.env.ARCVISTA_BACKUP_DIR || path.join(dataDir, 'backups'));
  const app = createArcVistaApp({
    dataDir,
    publicDir: path.join(APP_ROOT, 'public'),
    backupDir,
    llm: createDshLlm(ctx),
  });

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/arcvista') {
      res.writeHead(308, { Location: `/arcvista/${url.search}` });
      res.end();
      return;
    }
    req.url = `${url.pathname.replace(/^\/arcvista/, '') || '/'}${url.search}`;
    await handleRequest({ req, res, publicDir: app.publicDir, router: app.router });
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/arcvista', handler }), 'arcvista:web-route');
  ctx.effect(() => () => app.close(), 'arcvista:store');
}
