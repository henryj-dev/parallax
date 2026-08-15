import { ProviderNotConfiguredError, type ProviderAdapter } from "../application/ports.ts";
import type { ReconcileOperation } from "../domain/reconciliation.ts";

export interface RoutingProviderAdapterOptions {
  external?: ReadonlyMap<string, ProviderAdapter> | Readonly<Record<string, ProviderAdapter>>;
  internal?: ProviderAdapter;
  fallback?: ProviderAdapter;
}

/** Dispatches split-horizon targets to their configured provider implementations. */
export class RoutingProviderAdapter implements ProviderAdapter {
  readonly #external = new Map<string, ProviderAdapter>();
  readonly #quarantinedExternal = new Set<string>();
  #internal?: ProviderAdapter;
  #fallback?: ProviderAdapter;
  #fallbackViews = new Set<"internal" | "external">();
  #configurationRevision = 0;

  constructor(options: RoutingProviderAdapterOptions = {}) {
    this.#internal = options.internal;
    this.#fallback = options.fallback;
    if (options.fallback) this.#fallbackViews = new Set(["internal", "external"]);
    const entries = options.external instanceof Map ? options.external.entries() : Object.entries(options.external ?? {});
    for (const [zone, adapter] of entries) this.registerExternal(zone, adapter);
  }

  /** Swaps the internal-view adapter, so a settings change needs no restart. */
  setInternal(adapter: ProviderAdapter | undefined): void {
    const before = this.isConfigured("readiness.invalid/internal");
    this.#internal = adapter;
    if (before !== this.isConfigured("readiness.invalid/internal")) this.#configurationRevision += 1;
  }

  /** Swaps the adapter used when no specific one is configured for a target. */
  setFallback(adapter: ProviderAdapter | undefined, views: readonly ("internal" | "external")[] = ["internal", "external"]): void {
    const before = this.#representativeConfiguration();
    this.#fallback = adapter;
    this.#fallbackViews = adapter ? new Set(views) : new Set();
    if (before !== this.#representativeConfiguration()) this.#configurationRevision += 1;
  }

  registerExternal(zone: string, adapter: ProviderAdapter): void {
    const normalized = normalizeZone(zone);
    const target = `${normalized}/external`;
    const before = this.isConfigured(target);
    this.#external.set(normalized, adapter);
    this.#quarantinedExternal.delete(normalized);
    if (before !== this.isConfigured(target)) this.#configurationRevision += 1;
  }

  unregisterExternal(zone: string): boolean {
    const normalized = normalizeZone(zone);
    const target = `${normalized}/external`;
    const before = this.isConfigured(target);
    const removed = this.#external.delete(normalized);
    if (removed) this.#quarantinedExternal.add(normalized);
    if (before !== this.isConfigured(target)) this.#configurationRevision += 1;
    return removed;
  }

  /** Changes only when some target's configured/unconfigured answer may change. */
  configurationRevision(): number {
    return this.#configurationRevision;
  }

  isConfigured(target: string): boolean {
    let parsed: { zone: string; view: "internal" | "external" };
    try {
      parsed = parseTarget(target);
    } catch {
      return false;
    }
    const explicit = parsed.view === "external" ? this.#external.has(parsed.zone) : this.#internal !== undefined;
    return explicit || (this.#fallback !== undefined
      && this.#fallbackViews.has(parsed.view)
      && !(parsed.view === "external" && this.#quarantinedExternal.has(parsed.zone)));
  }

  async list(target: string) {
    const route = this.#route(target);
    return route.adapter.list(route.target);
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const route = this.#route(target);
    await route.adapter.apply(route.target, operation);
  }

  #representativeConfiguration(): string {
    return `${this.isConfigured("readiness.invalid/internal")}:${this.isConfigured("readiness.invalid/external")}`;
  }

  #route(target: string): { adapter: ProviderAdapter; target: string } {
    const parsed = parseTarget(target);
    const adapter = parsed.view === "external" ? this.#external.get(parsed.zone) : this.#internal;
    const fallbackAllowed = this.#fallbackViews.has(parsed.view)
      && !(parsed.view === "external" && this.#quarantinedExternal.has(parsed.zone));
    const selected = adapter ?? (fallbackAllowed ? this.#fallback : undefined);
    if (!selected) throw new ProviderNotConfiguredError(`no provider is configured for ${parsed.target}`);
    return { adapter: selected, target: parsed.target };
  }
}

function parseTarget(target: string): { zone: string; view: "internal" | "external"; target: string } {
  const match = /^(.+?)\/(internal|external)$/i.exec(target.trim());
  if (!match?.[1] || !match[2]) throw new ProviderNotConfiguredError(`no provider is configured for ${target}`);
  const zone = normalizeZone(match[1]);
  const view = match[2].toLowerCase() as "internal" | "external";
  return { zone, view, target: `${zone}/${view}` };
}

function normalizeZone(value: string): string {
  const zone = value.trim().toLowerCase().replace(/\.$/, "");
  if (!zone.includes(".") || zone.length > 253 || zone.split(".").some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    throw new Error(`invalid provider target zone ${value}`);
  }
  return zone;
}
