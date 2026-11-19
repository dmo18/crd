import { createMyCardfolio } from "./mycardfolio";
import type { Catalog } from "./types";

/**
 * The catalog the screens and actions talk to. Tests put a fake in its place
 * so nothing reaches the network. Calls go through the shared gate.
 */
let override: Catalog | undefined;
let shared: Catalog | undefined;

export function getCatalog(): Catalog {
  if (override) return override;
  return (shared ??= createMyCardfolio());
}

export function setCatalogForTests(catalog: Catalog | undefined): void {
  override = catalog;
}
