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
  readonly #internal?: ProviderAdapter;
  readonly #fallback?: ProviderAdapter;

  constructor(options: RoutingProviderAdapterOptions = {}) {
    this.#internal = options.internal;
    this.#fallback = options.fallback;
    const entries = options.external instanceof Map ? options.external.entries() : Object.entries(options.external ?? {});
    for (const [zone, adapter] of entries) this.registerExternal(zone, adapter);
  }

  registerExternal(zone: string, adapter: ProviderAdapter): void {
    this.#external.set(normalizeZone(zone), adapter);
  }

  unregisterExternal(zone: string): boolean {
    return this.#external.delete(normalizeZone(zone));
  }

  isConfigured(target: string): boolean {
    let parsed: { zone: string; view: "internal" | "external" };
    try {
      parsed = parseTarget(target);
    } catch {
      return false;
    }
    return (parsed.view === "external" ? this.#external.has(parsed.zone) : this.#internal !== undefined)
      || this.#fallback !== undefined;
  }

  async list(target: string) {
    const route = this.#route(target);
    return route.adapter.list(route.target);
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const route = this.#route(target);
    await route.adapter.apply(route.target, operation);
  }

  #route(target: string): { adapter: ProviderAdapter; target: string } {
    const parsed = parseTarget(target);
    const adapter = parsed.view === "external" ? this.#external.get(parsed.zone) : this.#internal;
    const selected = adapter ?? this.#fallback;
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
