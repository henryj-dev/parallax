/**
 * The boundary between the view and the store.
 *
 * The store's state is deliberately left as an open record: a shape kept in
 * step by hand would drift, and it is not what this file exists to check. The
 * commands are, because they are what the view calls by name -- and a name the
 * store does not have is a page that throws the moment that button is pressed,
 * which nothing else here would catch.
 *
 * Adding a command to `store.js` without adding it here makes the view's call
 * fail to compile. That is the intended direction: the list is short, and a
 * command the view cannot reach is not finished.
 */

export interface StoreNotice {
  readonly key: string;
  readonly values: Record<string, string>;
  readonly level: string;
}

/** A command that reported whether it succeeded, having already shown why not. */
type Outcome = Promise<boolean>;

/**
 * The state, described only where the view reads it by name.
 *
 * The rest stays open on purpose: a full shape kept in step by hand would
 * drift, and it is not the boundary this file exists to check. These five are
 * different -- the view indexes into them, so a name the store stopped
 * providing is a page that throws when that panel is drawn.
 */
/** One view's answer for a record, as the editor holds it while being edited. */
export interface RecordViewValue {
  id: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  acknowledgeNonGlobalIp?: boolean;
  /** Why the provider owns this record, or "" when nobody but us does. */
  managed?: string;
  /** The answer as the row shows it: the worker or bucket where one owns it. */
  label?: string;
}

/** The service that publishes a name for itself, as the record records it. */
export interface ManagedByService {
  service: string;
  resource: string;
}

/**
 * A record as the editor shows it: one row, two answers. The two views are
 * folded together here so that a name answered differently inside and outside
 * is one thing to edit rather than two that have to be kept in step.
 */
export interface RecordRow {
  id: string;
  name: string;
  type: string;
  /** `Worker`, `R2`, or the DNS type where no service owns the name. */
  typeLabel?: string;
  /** Carried through an edit and sent back, so a save cannot drop the lock. */
  managedBy?: ManagedByService;
  views: { internal: RecordViewValue; external: RecordViewValue };
}

export interface StoreState extends Record<string, unknown> {
  records: RecordRow[];
  profiles: { name: string; [key: string]: unknown }[];
  bindings: { zone: string; [key: string]: unknown }[];
  tokens: { id: string; [key: string]: unknown }[];
  dirty: boolean;
}

export interface Store {
  getState(): StoreState;
  subscribe(listener: (state: StoreState) => void): () => void;
  onNotice(listener: (notice: StoreNotice) => void): () => void;
  onIntent(listener: (event: { type: string }) => void): () => void;

  /** Shows why a provider sign-in was refused, in the dialog that asked for it. */
  reportSignInFailure(reason: string): void;
  readAuthenticationMode(): Promise<void>;
  signIn(token: string): Outcome;
  signOut(): Promise<void>;

  loadZones(options?: { preserveSelection?: boolean }): Outcome;
  selectZone(name: string): Outcome;
  createZone(name: string): Outcome;
  deleteActiveZone(): Outcome;

  /** Stages an edit locally; `index` null appends. Nothing is sent until save. */
  stageRecord(record: RecordRow, index?: number | null): boolean;
  removeRecord(index: number): void;
  proposeRecordId(name: string, type: string): string;

  /** Describes records the provider already holds; does not take them over. */
  adopt(): Outcome;
  preview(): Outcome;
  apply(): Outcome;

  loadRevisions(): Promise<void>;
  /** Loads one snapshot for reading, or closes the one already open. */
  inspectRevision(revision: number): Outcome;
  restoreRevision(revision: number): Outcome;

  loadAdministration(): Outcome;
  selectProfile(name: string): void;
  selectBinding(zone: string): void;
  saveProfile(name: string, credential: { token?: string; accountId?: string }): Outcome;
  testProfile(name: string, probe: { zone?: string; token?: string }): Outcome;
  deleteProfile(name: string): Outcome;
  saveBinding(zone: string, binding: { profile: string }): Outcome;
  testBinding(zone: string, binding?: { profile?: string }): Outcome;
  deleteBinding(zone: string): Outcome;
  saveSettings(values: Record<string, unknown>): Outcome;
  issueToken(request: { subject: string; role: string }): Outcome;
  revokeToken(id: string): Outcome;
}

export function createStore(client: unknown): Store;
export function readRecords(zone: unknown): RecordRow[];
export function providerManagedReason(record: unknown): string;
export function desiredState(state: unknown): unknown;
export function isNonGlobalAddress(value: string): boolean;
export const ERROR_SCOPES: readonly string[];
export const HISTORY_PAGE_SIZE: number;
export const REVISION_PAGE_SIZE: number;
