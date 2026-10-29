import { newId, nowIso } from './db.js';

const MAX_LOGS = 220;
const FINISHED_RETENTION_MS = 10 * 60 * 1000;

/**
 * In-process job queue persisted to SQLite.
 * Heavy git/LLM work runs one job per product at a time; extra submissions are
 * queued and started in order, so "分析多个分支" can be submitted at once.
 */
export class JobRunner {
  constructor(store, { logger = console } = {}) {
    this.store = store;
    this.logger = logger;
    this.active = new Map();
    this.byProduct = new Map();
    this.queues = new Map();
  }

  isProductBusy(productId) {
    const job = this.currentJob(productId);
    return job ? job.public() : null;
  }

  currentJob(productId) {
    const id = this.byProduct.get(productId);
    if (!id) return null;
    const job = this.active.get(id);
    return job && job.status === 'running' ? job : null;
  }

  queueDepth(productId) {
    return this.queues.get(productId)?.length || 0;
  }

  start({ productId, kind, branch = null, run }) {
    const job = {
      id: newId('job'),
      productId,
      kind,
      branch,
      status: 'queued',
      progress: 0,
      message: '任务已排队',
      logs: [],
      error: null,
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      public() {
        return {
          id: job.id,
          productId: job.productId,
          kind: job.kind,
          branch: job.branch,
          status: job.status,
          progress: job.progress,
          message: job.message,
          logs: job.logs,
          error: job.error,
          result: job.result,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        };
      },
    };
    this.active.set(job.id, job);

    const running = this.currentJob(productId);
    if (running) {
      if (!this.queues.has(productId)) this.queues.set(productId, []);
      const queue = this.queues.get(productId);
      queue.push({ job, run });
      job.message = `已排队，等待前一个任务完成（第 ${queue.length} 位）`;
      job.logs.push({ at: nowIso(), text: `${job.message}${branch ? `：${branch}` : ''}`, level: 'info' });
      job.updatedAt = nowIso();
      this.persist(job);
      return job.public();
    }

    this.byProduct.set(productId, job.id);
    this.persist(job);
    this.launch(job, run);
    return job.public();
  }

  launch(job, run) {
    this.byProduct.set(job.productId, job.id);
    job.status = 'running';
    job.progress = Math.max(job.progress || 0, 1);
    job.message = job.kind === 'prepare' ? '准备仓库' : job.branch ? `开始分析 ${job.branch}` : '任务开始';
    job.logs.push({ at: nowIso(), text: job.message, level: 'info' });
    job.updatedAt = nowIso();
    this.persist(job);

    const ctx = {
      jobId: job.id,
      productId: job.productId,
      log: (text, level = 'info') => this.log(job, text, level),
      progress: (percent, message) => this.progress(job, percent, message),
    };

    setImmediate(async () => {
      try {
        const result = await run(ctx);
        job.status = 'done';
        job.progress = 100;
        job.message = job.kind === 'prepare' ? '仓库已就绪' : '分析完成';
        job.result = result ?? null;
        job.updatedAt = nowIso();
        this.log(job, job.message);
      } catch (error) {
        job.status = 'error';
        job.error = error.message || '任务失败';
        job.updatedAt = nowIso();
        this.log(job, `任务失败：${job.error}`, 'error');
        this.logger.error?.(`[job:${job.kind}] ${job.error}`);
        if (error.stack && process.env.ARCVISTA_DEBUG) this.logger.error?.(error.stack);
      } finally {
        job.updatedAt = nowIso();
        this.persist(job);
        if (this.byProduct.get(job.productId) === job.id) this.byProduct.delete(job.productId);
        setTimeout(() => this.active.delete(job.id), FINISHED_RETENTION_MS).unref?.();
        this.drain(job.productId);
      }
    });
  }

  drain(productId) {
    const queue = this.queues.get(productId);
    if (!queue || queue.length === 0) {
      this.queues.delete(productId);
      return;
    }
    const next = queue.shift();
    if (queue.length === 0) this.queues.delete(productId);
    this.launch(next.job, next.run);
  }

  log(job, text, level = 'info') {
    job.logs.push({ at: nowIso(), text: String(text).slice(0, 500), level });
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
    job.message = String(text).slice(0, 200);
    job.updatedAt = nowIso();
    this.persist(job);
  }

  progress(job, percent, message) {
    job.progress = Math.max(0, Math.min(100, Math.round(percent)));
    if (message) job.message = String(message).slice(0, 200);
    job.updatedAt = nowIso();
    this.persist(job);
  }

  persist(job) {
    try {
      this.store.jobs.upsert({
        id: job.id,
        productId: job.productId,
        kind: job.kind,
        branch: job.branch,
        status: job.status,
        progress: job.progress,
        message: job.message,
        logs: job.logs,
        error: job.error,
        result: job.result,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error) {
      this.logger.error?.('job persist failed', error);
    }
  }

  get(id) {
    if (this.active.has(id)) return this.active.get(id).public();
    return this.store.jobs.get(id);
  }

  listByProduct(productId) {
    return this.store.jobs.listByProduct(productId).map((row) => {
      if (this.active.has(row.id)) return this.active.get(row.id).public();
      return row;
    });
  }

  latestByProduct(productId) {
    const row = this.store.jobs.latestByProduct(productId);
    if (row && this.active.has(row.id)) return this.active.get(row.id).public();
    return row;
  }
}
