export interface SyncPanelView {
  state: string;
  appliedRevision: number;
  error: string;
}

export interface SyncPanel {
  /** `empty` when the zone holds nothing to reconcile; `error` when status could not be read; `status` otherwise. */
  kind: "empty" | "status" | "error";
  overall: string;
  error?: string;
  views: { internal: SyncPanelView; external: SyncPanelView };
  percent: number;
  desired: number;
  applied?: number;
  /**
   * A view's applied revision trails the desired one, so an apply advances the
   * status record even when the provider plan is empty. False whenever the
   * status could not be read: an unknown revision is not a known lag.
   */
  behind: boolean;
}

export function syncPanel(state: unknown): SyncPanel;

export interface PlanPanelOperation {
  kind?: string;
  /** `internal` or `external` -- the view this operation belongs to. */
  view: string;
  desired?: { name?: string; type?: string; content?: string };
  actual?: { name?: string; type?: string; content?: string };
}

export interface PlanPanel {
  /** `error` when the plan could not be built; `loading` before it arrives; `plan` otherwise. */
  kind: "error" | "loading" | "plan";
  operations: PlanPanelOperation[];
  unreadable: { view: string; error: string }[];
  untouched: number;
  /**
   * The plan is empty and applying would still advance this zone's status record
   * from `applied` to `desired`. False whenever a view could not be read.
   */
  advancesRecord: boolean;
  applied: number;
  desired: number;
  /** Whether applying from this dialog would do anything at all. */
  applyEnabled: boolean;
}

export function planPanel(state: unknown): PlanPanel;

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

/** A zone this profile's overrides do not cover, and why not. */
export interface ExcludedZone {
  zone: string;
  /** `unbound`, `otherProfile`, `empty` or `invalid`. */
  reason: string;
  profile?: string;
  detail?: string;
}

export interface FallbackPanel {
  profile: string;
  resolver: string;
  /** No resolver is set, so a plan cannot be built and a sync can only fail. */
  resolverMissing: boolean;
  covered: string[];
  excluded: ExcludedZone[];
  entries: { suffix: string; dnsServer: string[]; owned: boolean; actions: string[] }[];
  /** `null` when the provider could not be read; `planError` says why. */
  plan: {
    add: string[];
    update: string[];
    adopt: string[];
    remove: string[];
    conflict: { suffix: string; reason: string }[];
    unchanged: number;
    untouched: number;
  } | null;
  planError: string;
  pending: number;
  inStep: boolean;
  syncable: boolean;
}

export function fallbackPanel(state: unknown): FallbackPanel;

/**
 * Record id to `ours`, `theirs`, `contested` or `absent`. A row missing from the
 * map has no verdict: either it answers nothing on this side, or nobody has read
 * the provider yet -- which must never be shown as unowned.
 *
 * `contested` is the row whose value does not match what the provider holds at
 * that name, where what it holds is not ours: applying reports a conflict rather
 * than writing, so it is neither ours nor merely unpublished.
 */
export function recordOwnership(
  records: readonly unknown[],
  plan: unknown,
  view?: string,
): Map<string, string>;
