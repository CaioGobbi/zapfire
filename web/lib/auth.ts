// ============================================================
// AUTH — helpers de alto nível (login, logout, consume, bootstrap)
// ============================================================

'use client';

import { useAuthStore, type SessionUser } from './authStore';
import { apiPost } from './api';

interface SessionResponse {
  ok: boolean;
  accessToken: string;
  user: SessionUser;
}

export async function loginWithPassword(email: string, password: string): Promise<SessionUser> {
  const data = await apiPost<SessionResponse>('/account/login', { email, password }, false);
  useAuthStore.getState().setSession({ accessToken: data.accessToken, user: data.user });
  return data.user;
}

export async function consumeMagicLink(token: string, newPassword: string): Promise<SessionUser> {
  const data = await apiPost<SessionResponse>(
    '/account/consume-magic-link',
    { token, newPassword },
    false
  );
  useAuthStore.getState().setSession({ accessToken: data.accessToken, user: data.user });
  return data.user;
}

export async function requestMagicLink(email: string): Promise<void> {
  await apiPost('/account/magic-link-request', { email }, false);
}

export async function logout(): Promise<void> {
  try {
    await apiPost('/account/logout', undefined, false);
  } catch {
    // ignora erro — de qualquer forma limpa local
  }
  useAuthStore.getState().clear();
}

// Tenta restaurar a sessão via cookie de refresh.
// Chamado 1× no boot (RootProvider).
export async function bootstrapSession(): Promise<boolean> {
  try {
    const data = await apiPost<SessionResponse>('/account/refresh', undefined, false);
    if (data?.ok && data.accessToken) {
      useAuthStore.getState().setSession({ accessToken: data.accessToken, user: data.user });
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    useAuthStore.getState().setHydrated(true);
  }
}
