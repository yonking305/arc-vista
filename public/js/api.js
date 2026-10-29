/* Thin API client for the local ArcVista server. */

const API_BASE = (typeof window !== 'undefined' && window.__ARCVISTA_BASE__) || '';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request('/api/health'),

  products: {
    list: () => request('/api/products'),
    create: (payload) => request('/api/products', { method: 'POST', body: JSON.stringify(payload) }),
    get: (id) => request(`/api/products/${encodeURIComponent(id)}`),
    update: (id, payload) => request(`/api/products/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    remove: (id) => request(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    prepare: (id) =>
      request(`/api/products/${encodeURIComponent(id)}/prepare`, { method: 'POST', body: '{}' }),
    analyze: (id, payload = {}) =>
      request(`/api/products/${encodeURIComponent(id)}/analyze`, { method: 'POST', body: JSON.stringify(payload) }),
    branches: (id) => request(`/api/products/${encodeURIComponent(id)}/branches`),
    snapshots: (id) => request(`/api/products/${encodeURIComponent(id)}/snapshots`),
    snapshot: (id, snapshotId) =>
      request(`/api/products/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`),
    compare: (id, params) => {
      const search = new URLSearchParams(params);
      return request(`/api/products/${encodeURIComponent(id)}/compare?${search.toString()}`);
    },
    drill: (id, payload) =>
      request(`/api/products/${encodeURIComponent(id)}/modules/analyze`, { method: 'POST', body: JSON.stringify(payload) }),
    jobs: (id) => request(`/api/products/${encodeURIComponent(id)}/jobs`),
  },

  jobs: {
    get: (id) => request(`/api/jobs/${encodeURIComponent(id)}`),
  },

  backup: () => request('/api/backup', { method: 'POST', body: '{}' }),

  settings: {
    get: () => request('/api/settings'),
    update: (payload) => request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
    test: () => request('/api/settings/test', { method: 'POST', body: '{}' }),
  },
};

export const TERMINAL_JOB_STATES = new Set(['done', 'error']);
