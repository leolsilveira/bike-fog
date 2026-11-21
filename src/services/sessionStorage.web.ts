// Armazenamento de sessão na Web: usa window.localStorage (separado do IndexedDB do jogo)
// com fallback em memória para ambientes sem window ou com bloqueio de storage.
import type { SupportedStorage } from '@supabase/supabase-js';

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryFallback = new Map<string, string>();

function getWebStorage(): WebStorageLike | null {
  try {
    const w = (globalThis as { window?: { localStorage?: WebStorageLike } }).window;
    if (w?.localStorage) {
      return w.localStorage;
    }
  } catch {
    // Acesso a localStorage pode lançar em contextos restritos
  }
  return null;
}

export const sessionStorage: SupportedStorage = {
  getItem(key: string): string | null {
    const ls = getWebStorage();
    if (ls) {
      try {
        const val = ls.getItem(key);
        if (val !== null) return val;
      } catch {
        // Fallback em memória
      }
    }
    return memoryFallback.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    const ls = getWebStorage();
    if (ls) {
      try {
        ls.setItem(key, value);
        memoryFallback.delete(key);
        return;
      } catch {
        // Fallback em memória
      }
    }
    memoryFallback.set(key, value);
  },

  removeItem(key: string): void {
    const ls = getWebStorage();
    if (ls) {
      try {
        ls.removeItem(key);
      } catch {
        // Ignora erro de remoção no localStorage e limpa fallback
      }
    }
    memoryFallback.delete(key);
  },
};
