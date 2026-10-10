import { create } from "zustand";
import type { Me } from "@sweatbox/shared";
import { api, ApiError } from "./api";

interface AuthState {
  me: Me | null;
  loaded: boolean;
  /** NOT_IN_GUILD etc. */
  error: string | null;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  me: null,
  loaded: false,
  error: null,
  refresh: async () => {
    try {
      const me = await api.me();
      set({ me, loaded: true, error: null });
      return me;
    } catch (e) {
      const err = e as ApiError;
      set({ me: null, loaded: true, error: err.status === 401 ? null : err.message });
      return null;
    }
  },
  logout: async () => {
    try {
      await api.logout();
    } finally {
      set({ me: null });
    }
  },
}));
