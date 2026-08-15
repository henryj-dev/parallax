import type { ZoneRepository } from "../application/ports.ts";

/**
 * A zone repository that says when the zones it holds have changed.
 *
 * The DNS listener answers from a snapshot, and something has to tell it the
 * snapshot is stale. The control plane commits through this repository and
 * emits nothing, so rather than give it an event bus -- which every caller
 * would then have to reason about -- the notification is taken from the one
 * place a change cannot avoid passing through.
 *
 * It fires only for writes made by this process. A second instance sharing a
 * database, or the command line writing to the same file, is invisible from
 * here, which is why the listener keeps a periodic refresh as well: this makes
 * the common case immediate, and the timer is what makes the rest correct.
 *
 * The listener is called after the write has been made durable, never before,
 * so a snapshot taken in response can never be ahead of the store.
 */
export function watchingZones(repository: ZoneRepository, onChange: () => void): ZoneRepository {
  // A notification is advisory and follows the durable write. Its listener
  // must not turn a committed mutation into an apparent failure that a caller
  // retries, because that can duplicate higher-level side effects.
  const changed = (): void => {
    try { onChange(); } catch { /* The periodic refresh remains the fallback. */ }
  };
  return {
    list: (page) => repository.list(page),
    get: (name) => repository.get(name),
    listRevisions: (zone, page) => repository.listRevisions(zone, page),
    getRevision: (zone, revision) => repository.getRevision(zone, revision),
    appendAudit: (entry, retention) => repository.appendAudit(entry, retention),
    audit: (zone, page) => repository.audit(zone, page),
    save: async (zone) => { await repository.save(zone); changed(); },
    saveRevision: async (snapshot) => { await repository.saveRevision(snapshot); changed(); },
    commitDesiredChange: async (change) => { await repository.commitDesiredChange(change); changed(); },
    commitZoneDeletion: async (deletion) => { await repository.commitZoneDeletion(deletion); changed(); },
    delete: async (name) => { await repository.delete(name); changed(); },
  };
}
