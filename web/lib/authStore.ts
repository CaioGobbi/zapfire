// ============================================================
// AUTH STORE — zustand, em memória (nunca em localStorage!)
// ============================================================
// Access token morre em refresh de página. Isso é intencional:
//   - Nunca persistimos JWT em storage acessível (XSS)
//   - Ao carregar a app, o client tenta POST /account/refresh
//     — se o cookie HttpOnly de refresh tiver válido, a sessão
//     se recupera sozinha
// ============================================================

import { create } from 'zustand';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  emailVerified: boolean;
}

interface AuthState {
  accessToken: string | null;
  user: SessionUser | null;
  hydrated: boolean;  // true depois do 1º refresh attempt no boot
  setSession: (s: { accessToken: string; user: SessionUser }) => void;
  setHydrated: (v: boolean) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  hydrated: false,
  setSession: ({ accessToken, user }) => set({ accessToken, user }),
  setHydrated: (v) => set({ hydrated: v }),
  clear: () => set({ accessToken: null, user: null }),
}));
