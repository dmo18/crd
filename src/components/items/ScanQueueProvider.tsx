"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { emptyQueue, hasUnsaved, type QueueState } from "./scan-queue";
import { browserDeps, createScanStore, type ScanStore } from "./scan-store";

const ScanQueueContext = createContext<ScanStore | null>(null);

/**
 * Holds the scan list for every signed-in page. Mounted once in the (app)
 * layout, which stays in place when the owner moves between pages, so
 * uploads keep going and the scan screen shows them again on return.
 */
export function ScanQueueProvider({ children }: { children: React.ReactNode }) {
  // Made once per page load; the store only touches browser functions when used.
  const [store] = useState(() => createScanStore(browserDeps()));
  const state = useSyncExternalStore(store.subscribe, store.getState, () => emptyQueue);

  // Leave warning (reload, close, typing another address) while anything is not yet on the server.
  const unsaved = hasUnsaved(state);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  return <ScanQueueContext.Provider value={store}>{children}</ScanQueueContext.Provider>;
}

/** Only the store, for parts that read the shared status (the pill), not the list. */
export function useScanStore(): ScanStore {
  const store = useContext(ScanQueueContext);
  if (!store) throw new Error("useScanStore needs ScanQueueProvider");
  return store;
}

/** The shared scan list and its actions. Use inside the (app) layout only. */
export function useScanQueue(): { state: QueueState; store: ScanStore } {
  const store = useContext(ScanQueueContext);
  if (!store) throw new Error("useScanQueue needs ScanQueueProvider");
  const state = useSyncExternalStore(store.subscribe, store.getState, () => emptyQueue);
  return { state, store };
}
