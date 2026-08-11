/**
 * Only what a test needs to drive a flow. The store's full state is deliberately
 * not described here: a type that has to be kept in step by hand would drift,
 * and the boundary this file exists to make checkable is the one between the
 * view and the store, not the shape of the state itself.
 */

export interface StoreNotice {
  readonly key: string;
  readonly values: Record<string, string>;
  readonly level: string;
}

export interface Store {
  getState(): Record<string, unknown>;
  subscribe(listener: (state: Record<string, unknown>) => void): void;
  onNotice(listener: (notice: StoreNotice) => void): void;
  onIntent(listener: (event: { type: string }) => void): void;
  saveSettings(values: Record<string, unknown>): Promise<boolean>;
  [command: string]: unknown;
}

export function createStore(client: unknown): Store;
export function readRecords(state: unknown): unknown[];
export function desiredState(state: unknown): unknown;
export function isNonGlobalAddress(value: string): boolean;
export const ERROR_SCOPES: readonly string[];
