"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** Most items one selection may tick one by one. Same number the server allows. */
export const MAX_TICKED = 500;

type State = { ids: number[]; all: boolean; key: string | null };
type Api = {
  ids: ReadonlySet<number>;
  /** True when "Select all matching" is on: every item the filters match. */
  all: boolean;
  /** Ticks or unticks one. Returns false when the limit is reached. */
  toggle: (id: number) => boolean;
  /** Ticks many. Returns false (and ticks none) when that would pass the limit. */
  addMany: (ids: number[]) => boolean;
  removeMany: (ids: number[]) => void;
  selectAll: () => void;
  clear: () => void;
  /** Tells the provider which search the list shows; a different search clears the selection. */
  setFilterKey: (key: string) => void;
};

const Ctx = createContext<Api | null>(null);

export function useSelection(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSelection needs SelectionProvider");
  return v;
}

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ ids: [], all: false, key: null });

  const toggle = useCallback((id: number) => {
    if (state.all) return true;
    if (state.ids.includes(id)) {
      setState({ ...state, ids: state.ids.filter((x) => x !== id) });
      return true;
    }
    if (state.ids.length >= MAX_TICKED) return false;
    setState({ ...state, ids: [...state.ids, id] });
    return true;
  }, [state]);
  const addMany = useCallback((ids: number[]) => {
    if (state.all) return true;
    const next = [...new Set([...state.ids, ...ids])];
    if (next.length > MAX_TICKED) return false;
    setState({ ...state, ids: next });
    return true;
  }, [state]);
  const removeMany = useCallback((ids: number[]) => setState((s) => ({ ...s, ids: s.ids.filter((x) => !ids.includes(x)) })), []);
  const selectAll = useCallback(() => setState((s) => ({ ...s, ids: [], all: true })), []);
  const clear = useCallback(() => setState((s) => ({ ...s, ids: [], all: false })), []);
  const setFilterKey = useCallback((key: string) => {
    setState((s) => (s.key === key ? s : s.key === null ? { ...s, key } : { ids: [], all: false, key }));
  }, []);

  const value = useMemo<Api>(() => ({
    ids: new Set(state.ids), all: state.all, toggle, addMany, removeMany, selectAll, clear, setFilterKey,
  }), [state, toggle, addMany, removeMany, selectAll, clear, setFilterKey]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
