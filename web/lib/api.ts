// ============================================================
// API WRAPPER — chamadas pro backend com auto-refresh em 401
// ============================================================
// - Access token sai do zustand store (em memória, nunca em localStorage)
// - Refresh token tá em cookie HttpOnly (setado/lido pelo backend;
//   incluído via credentials: 'include')
// - Em 401 numa rota autenticada: tenta POST /account/refresh → se
//   funcionar, reexecuta a request original com o novo access token.
//   Se não, limpa store e dispara redirect pro /login.
// ============================================================

'use client';

import { useAuthStore } from './authStore';

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ApiOptions {
  method?: Method;
  body?: unknown;
  auth?: boolean;          // default true
  silent401?: boolean;     // se true, não tenta refresh (usado internamente pelo próprio refresh)
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;
  constructor(status: number, message: string, code?: string, data?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function rawFetch(path: string, opts: ApiOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  // Só seta Content-Type quando realmente tem body — senão Fastify
  // reclama "Body cannot be empty when content-type is application/json"
  const hasBody = opts.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  if (opts.auth !== false) {
    const access = useAuthStore.getState().accessToken;
    if (access) headers.Authorization = `Bearer ${access}`;
  }
  return fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    credentials: 'include', // envia cookie de refresh quando houver
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
}

// Evita N chamadas concorrentes de /refresh quando várias requests
// tomam 401 ao mesmo tempo. Todas esperam o mesmo Promise.
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await rawFetch('/account/refresh', {
        method: 'POST',
        auth: false,
        silent401: true,
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data?.ok && data.accessToken) {
        useAuthStore.getState().setSession({
          accessToken: data.accessToken,
          user: data.user,
        });
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  let res = await rawFetch(path, opts);

  if (res.status === 401 && opts.auth !== false && !opts.silent401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await rawFetch(path, opts);
    } else {
      // Sessão morreu de vez — limpa e manda pro login
      useAuthStore.getState().clear();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
  }

  let payload: any = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      payload?.message || `HTTP ${res.status}`,
      payload?.code,
      payload
    );
  }
  return payload as T;
}

// Helpers
export const apiGet = <T = unknown>(path: string) => api<T>(path, { method: 'GET' });
export const apiPost = <T = unknown>(path: string, body?: unknown, auth = true) =>
  api<T>(path, { method: 'POST', body, auth });
