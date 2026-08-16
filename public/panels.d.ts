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
