export interface SyncPanelView {
  state: string;
  appliedRevision: number;
  error: string;
}

export interface SyncPanel {
  /** `empty` when the zone holds nothing to reconcile; `status` otherwise. */
  kind: "empty" | "status";
  overall: string;
  views: { internal: SyncPanelView; external: SyncPanelView };
  percent: number;
  desired: number;
  applied?: number;
}

export function syncPanel(state: unknown): SyncPanel;

/** One side's answer, and which message stands in when there is none. */
export interface RecordAnswerView {
  text: string;
  /** `""`, `"overridden"` or `"noAnswer"` -- the view translates it. */
  absent: string;
}

export interface RecordRow {
  /** `Worker`, `R2`, or the DNS type. */
  typeLabel: string;
  /** The provider owns this row: it offers nothing and says so on both sides. */
  locked: boolean;
  /** The DNS value as stored, for a row that shows something else. */
  stored: string;
  /** `["edit", "delete"]`, or empty where nothing here can change the record. */
  actions: string[];
  inside: RecordAnswerView & { inherited: boolean };
  outside: RecordAnswerView & { proxied: boolean };
}

export function recordRow(record: unknown, records: readonly unknown[]): RecordRow;
