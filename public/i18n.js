export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = Object.freeze(["en", "ko"]);
export const LOCALE_STORAGE_KEY = "parallax.locale";

const AUDIT_MESSAGE_KEYS = Object.freeze({
  "zone.created": "audit.zoneCreated",
  "zone.deleted": "audit.zoneDeleted",
  "record.upserted": "audit.recordUpserted",
  "record.deleted": "audit.recordDeleted",
  "desired.replaced": "audit.desiredReplaced",
  "desired.restored": "audit.desiredRestored",
  "records.adopted": "audit.recordsAdopted",
  "provider.apply.started": "audit.providerApplyStarted",
  "provider.apply.completed": "audit.providerApplyCompleted",
  "provider.apply.failed": "audit.providerApplyFailed",
});

const PROVIDER_ERROR_KEYS = Object.freeze({
  "provider operation failed": "provider.operationFailed",
  "unmanaged provider records conflict with desired state": "provider.unmanagedConflict",
});

const VIEW_MESSAGE_KEYS = Object.freeze({ internal: "horizon.internal", external: "horizon.external" });

export const messages = Object.freeze({
  en: {
    "meta.description": "Parallax split-horizon DNS operations portal",
    "meta.title": "Parallax — DNS observatory",
    "language.label": "Language",
    "language.english": "English",
    "language.korean": "한국어",
    "nav.skip": "Skip to workspace",
    "nav.home": "Parallax home",
    "brand.subtitle": "DNS OBSERVATORY",
    "provider.settings": "Provider settings",
    "status.controlPlane": "CONTROL PLANE",
    "status.connecting": "Connecting",
    "status.online": "Control plane online",
    "status.unavailable": "Control plane unavailable",
    "zones.label": "Zones",
    "zones.observed": "Observed zones",
    "zones.create": "Create zone",
    "zones.filterLabel": "Filter zones",
    "zones.filterPlaceholder": "Filter by domain…",
    "zones.list": "Zone list",
    "zones.none": "No zones yet. Create one to begin.",
    "zones.noMatch": "No zones match this filter.",
    "zones.loadFailed": "Zones could not be loaded.",
    "zones.retry": "Try again",
    "zones.stateUnknown": "Nothing to reconcile",
    "policy.label": "MANAGEMENT POLICY",
    "policy.managedOnly": "Managed records only",
    "welcome.eyebrow": "No zone selected",
    "welcome.title": "Choose an observation point.",
    "welcome.body": "Select a zone to compare its internal and external DNS views, or create the first zone in this control plane.",
    "welcome.create": "Create a zone",
    "zone.active": "Active zone",
    "zone.loading": "Loading zone…",
    "zone.desiredRevision": "Desired revision {revision}",
    "zone.lastChanged": "Last changed {date}",
    "zone.delete": "Delete zone",
    "zone.refresh": "Refresh",
    "zone.revisions": "Revisions", "zone.adopt": "Adopt existing", "zone.adoptHint": "Describe records the provider already holds, without taking them over", "zone.adoptConfirm": "Bring the records this provider already holds into the desired state?\n\nThey stay owned by whoever made them: nothing is rewritten at the provider, and a later change there appears as a conflict rather than being overwritten.", "zone.adopted": "Adopted {adopted} of {seen} records the provider holds", "zone.adoptFailed": "Could not adopt: {error}", "zone.adoptWarning": "Adopted, with a caveat: {warning}",
    "zone.preview": "Preview plan",
    "zone.apply": "Apply changes",
    "zone.applying": "Applying…",
    "zone.discardChanges": "Discard unsaved record changes?",
    "zone.detailsFailed": "Zone details could not be loaded: {error}",
    "zone.created": "{name} was created.",
    "zone.createFailed": "Zone was not created: {error}",
    "zone.creating": "Creating…",
    "zone.deleteConfirm": "Delete {name}? Its desired state is removed and every record Parallax published for it is withdrawn from the DNS provider. Records Parallax does not manage are left alone. This cannot be undone.",
    "zone.deleted": "{name} was deleted. No published records needed to be withdrawn.",
    "zone.deletedRecords.one": "{name} was deleted and 1 published record was withdrawn.",
    "zone.deletedRecords.other": "{name} was deleted and {count} published records were withdrawn.",
    "zone.deleteFailed": "Zone was not deleted: {error}",
    "horizon.eyebrow": "Split-horizon lens",
    "horizon.title": "One name, two answers",
    "horizon.focus": "Focus record",
    "horizon.internal": "Internal view",
    "horizon.privateResolver": "Private resolver",
    "horizon.sameName": "same name",
    "horizon.external": "External view",
    "horizon.cloudflareEdge": "Cloudflare edge",
    "record.desiredState": "Desired state",
    "record.title": "DNS records",
    "record.add": "Add record",
    "record.addFirst": "Add first record",
    "record.nameType": "Name / type",
    "record.internalAnswer": "Internal answer",
    "record.externalAnswer": "External answer",
    "record.ttlViews": "TTL (IN / EX)",
    "record.actions": "Actions",
    "record.noneDefined": "No records are defined",
    "record.noneBody": "Add a record to establish this zone’s first split view.",
    "record.none": "No records",
    "record.noneYet": "No records yet",
    "record.noAnswer": "No answer",
    "record.noAnswerDefined": "No answer defined",
    "record.overridden": "Overridden by RRset",
    "record.proxied": "proxied",
    "record.proxiedLabel": "Proxied",
    "record.dnsOnly": "DNS only",
    "record.edit": "Edit",
    "record.delete": "Delete",
    "record.providerOwnedHint": "Your DNS provider created this record and still owns it. Remove it where it was created, then adopt the zone again.",
    "record.owner.ours": "ours",
    "record.owner.oursHint": "Parallax created this record at the provider and carries its ownership marker, so it is this control plane's to change.",
    "record.owner.theirs": "theirs",
    "record.owner.theirsHint": "The provider holds this record without Parallax's marker: it is described here but owned by whoever made it. Applying will not rewrite it, and a later change there appears as a conflict.",
    "record.owner.contested": "conflict",
    "record.owner.contestedHint": "The provider holds a different record at this name and Parallax does not own it, so applying reports a conflict instead of writing. Change it where it was created, or remove it there and let Parallax publish this value.",
    "record.owner.absent": "not published",
    "record.owner.absentHint": "The provider holds nothing matching this record yet. Applying would create it, and it becomes this control plane's.",
    "record.editDesired": "Edit desired record",
    "record.desired": "Desired record",
    "record.removeConfirm": "Remove {name} {type} from desired state?",
    "record.updatedLocal": "Desired state updated locally. Preview the plan before applying.",
    "record.removedLocal": "Record removed locally. Preview the plan to review the deletion.",
    "record.answerRequired": "Give an internal or an external answer; a record with neither would save as nothing.",
    "record.duplicate": "This RRset already contains the same value.",
    "record.cnameConflict": "A CNAME must be the only record at its name.",
    "sync.eyebrow": "Reconciliation",
    "sync.title": "Sync state",
    "sync.checking": "Checking",
    "sync.internal": "Internal DNS",
    "sync.cloudflare": "Cloudflare",
    "sync.waiting": "Waiting for status",
    "sync.comparing": "Desired and applied revisions are being compared.",
    "sync.appliedRevision": "Applied revision {revision}",
    "sync.progress": "Applied revision {applied} of {desired}.",
    "sync.noneApplied": "No revision has been applied yet.",
    "sync.empty": "nothing to sync",
    "sync.emptyDetail": "This zone holds no records yet, so there is nothing to publish or answer.",
    "status.pending": "pending",
    "status.applied": "applied",
    "status.failed": "failed",
    "status.unknown": "unknown",
    "status.loadFailed": "Apply status could not be loaded: {error}",
    "history.eyebrow": "Audit trail",
    "history.title": "Recent changes",
    "history.none": "No changes have been recorded for this zone.",
    "history.loadFailed": "Change history could not be loaded: {error}",
    "history.changed": "Desired state changed",
    "audit.zoneCreated": "Zone created", "audit.zoneDeleted": "Zone deleted", "audit.recordUpserted": "Record saved", "audit.recordDeleted": "Record deleted", "audit.desiredReplaced": "Desired state replaced", "audit.desiredRestored": "Desired state restored", "audit.recordsAdopted": "Provider records adopted", "audit.providerApplyStarted": "Provider apply started", "audit.providerApplyCompleted": "Provider apply completed", "audit.providerApplyFailed": "Provider apply failed",
    "provider.operationFailed": "Provider operation failed", "provider.unmanagedConflict": "Unmanaged provider records conflict with desired state",
    "provider.notConfigured": "No DNS provider is configured for {target}",
    "history.system": "system",
    "history.revision": "revision {revision}", "history.counts": "+{added} \u2212{removed} ~{changed}",
    "dialog.close": "Close dialog",
    "dialog.cancel": "Cancel",
    "zoneDialog.eyebrow": "New observation point",
    "zoneDialog.title": "Create a zone",
    "zoneDialog.body": "Parallax will manage only records it creates or explicitly adopts.",
    "zoneDialog.domain": "Domain name",
    "zoneDialog.provider": "External provider",
    "recordDialog.name": "Name",
    "recordDialog.type": "Type",
    "recordDialog.content": "Content",
    "recordDialog.internalHelp": "Leave empty to inherit the external answer",
    "recordDialog.internalTtl": "Internal TTL in seconds",
    "recordDialog.externalHelp": "Published through the configured provider; leave empty to answer this name only inside",
    "recordDialog.proxy": "Cloudflare proxy",
    "recordDialog.proxyHelp": "Available for supported address and CNAME records.",
    "recordDialog.externalTtl": "External TTL",
    "recordDialog.ttlHelp": "Use 1 for Auto, or 60–86400 seconds for DNS-only records.",
    "recordDialog.proxiedTtlHelp": "Cloudflare proxied records always use Auto TTL (5 minutes).",
    "recordDialog.ttlInvalid": "Use Auto (1) or a value from 60 through 86400 seconds.",
    "recordDialog.nonGlobal": "Confirm non-global address publication",
    "recordDialog.nonGlobalHelp": "This address is private or reserved and may expose an invalid external DNS answer. Check only after reviewing the intent.",
    "recordDialog.save": "Save desired state",
    "plan.eyebrow": "Reconciliation preview",
    "plan.title": "Review the apply plan",
    "plan.comparing": "Parallax is comparing desired and actual state.",
    "plan.keepEditing": "Keep editing",
    "plan.apply": "Apply this plan",
    "plan.failed": "The plan could not be generated.",
    "plan.failedHelp": "{error} Check the zone configuration and try again.",
    "plan.operations.one": "1 operation will reconcile this zone.",
    "plan.operations.other": "{count} operations will reconcile this zone.",
    "plan.viewUnreadable": "{view}: {error}",
    "plan.unreadable.one": "1 view could not be read -- what it would change is unknown",
    "plan.unreadable.other": "{count} views could not be read -- what they would change is unknown",
    "plan.noChanges": "Desired and actual state already match. There is nothing to apply.",
    "plan.provider": "DNS provider",
    "plan.record": "record",
    "plan.reconciled": "State will be reconciled",
    "plan.noDrift": "No drift detected.",
    "plan.untouched.one": "1 record at the provider is neither owned nor described here, so it is left alone.",
    "plan.untouched.other": "{count} records at the provider are neither owned nor described here, so they are left alone.",
    "operation.create": "create", "operation.update": "update", "operation.delete": "delete", "operation.conflict": "conflict",
    "apply.started": "Apply started{revisionText}.",
    "apply.startedRevision": "Apply started for revision {revision}.",
    "apply.forRevision": " for revision {revision}",
    "apply.failed": "Changes were not applied: {error}",
    "auth.eyebrow": "Protected control plane",
    "auth.title": "Enter an access token",
    "auth.body": "This server requires an administrator, editor, or viewer token. It is exchanged for a session cookie that scripts on this page cannot read.",
    "auth.signOut": "Sign out",
    "auth.token": "Access token",
    "auth.open": "Open control plane", "auth.or": "or", "auth.identity": "Sign in with your organization account", "auth.identityHint": "Your role comes from the identity provider. An administrator assigns it there.",
    "auth.forbidden": "This token cannot open the control plane.",
    "auth.rejected": "The token was not accepted.",
    "auth.identityFailed": "{reason}",
    "revisions.eyebrow": "Immutable desired state",
    "revisions.title": "Revision history",
    "revisions.body": "Restoring a snapshot creates a new revision. Existing history is never rewritten.",
    "revisions.item": "Revision {revision}{currentText}",
    "revisions.current": " · current",
    "revisions.records.one": "1 view record",
    "revisions.records.other": "{count} view records",
    "revisions.restore": "Restore",
    "revisions.inspect": "Inspect", "revisions.hide": "Hide",
    "revisions.inspectFailed": "Could not read this revision: {error}",
    "revisions.snapshotEmpty": "This revision holds no records.",
    "revisions.colView": "View", "revisions.colName": "Name", "revisions.colType": "Type",
    "revisions.colContent": "Content", "revisions.colTtl": "TTL",
    "revisions.none": "No revision snapshots have been recorded.",
    "revisions.restoreConfirm": "Restore revision {revision} as a new desired revision?",
    "revisions.restored": "Revision {revision} was restored as a new desired state.",
    "revisions.restoreFailed": "Revision was not restored: {error}", "revisions.loadFailed": "Revision history could not be loaded: {error}",
    "settings.tab": "Server settings",
    "settings.body": "These are stored in the database and shared by every instance. Bind address, database connection and encryption keys stay in the environment.",
    "settings.allowLocalProvider": "Local file provider",
    "settings.allowLocalProviderHelp": "Publish to a local file when no real provider is configured. Applied changes do not reach real DNS.",
    "settings.trustForwardedHeaders": "Trust proxy headers",
    "settings.trustForwardedHeadersHelp": "Read X-Forwarded-Proto and X-Forwarded-Host. Enable only when a proxy is the only route in.",
    "settings.publicOrigin": "Public origin",
    "settings.warning": "Saved, with a caveat: {message}",
    "settings.revisionRetention": "Revisions kept per zone",
    "settings.auditRetentionDays": "Audit history kept (days)",
    "settings.fallbackResolver": "Fallback resolver address",
    "settings.fallbackResolverHelp": "Address devices should use for this control plane's zones. Required before device-settings sync can run.",
    "settings.save": "Save settings",
    "settings.saved": "Server settings were saved.",
    "settings.saveFailed": "Settings were not saved: {error}",
    "fallback.tab": "Local domain fallback",
    "fallback.body": "Devices running the provider's client resolve these suffixes through this control plane instead of publicly. A zone is covered when it is bound to this profile and its internal view answers for something.",
    "fallback.profile": "Credential profile",
    "fallback.refresh": "Refresh",
    "fallback.sync": "Apply to device settings",
    "fallback.syncConfirm": "Point devices at this control plane for every zone {profile} covers?\n\nThis writes one setting the whole organization shares. Entries Parallax did not create are left exactly as they are.",
    "fallback.synced": "Overrides updated: {count} changed.",
    "fallback.alreadyInStep": "The overrides already match this profile's zones.",
    "fallback.syncFailed": "Could not update the overrides: {error}",
    "fallback.coverageFailed": "Could not read which zones are covered: {error}",
    "fallback.resolver": "Resolver devices are sent to",
    "fallback.resolverMissing": "No fallback resolver is set in server settings, so there is no address to send these zones to.",
    "fallback.covered": "Covered by this profile",
    "fallback.coveredNone": "No zone bound to this profile has an internal answer yet.",
    "fallback.excluded": "Not covered, and why",
    "fallback.reason.unbound": "no credential is bound to this zone, so no profile covers it",
    "fallback.reason.otherProfile": "bound to the profile {profile}, so sync that one instead",
    "fallback.reason.empty": "no internal answer yet, so this control plane claims no authority for it",
    "fallback.reason.invalid": "its views cannot be composed, so the listener does not serve it",
    "fallback.live": "Entries live at the provider",
    "fallback.liveNone": "The override list is empty.",
    "fallback.plan.title": "What applying would change",
    "fallback.plan.add": "add",
    "fallback.plan.update": "point here",
    "fallback.plan.adopt": "claim (already correct)",
    "fallback.plan.remove": "remove",
    "fallback.plan.conflict": "left alone: somebody else's entry",
    "fallback.planFailed": "The provider's list could not be read: {error}",
    "fallback.inStep": "Nothing to change.",
    "tokens.tab": "Access tokens",
    "tokens.existing": "Issued tokens",
    "tokens.issue": "Issue a token",
    "tokens.body": "A new token is shown once and stored only as a digest. Copy it before closing this dialog.",
    "tokens.subject": "Subject",
    "tokens.role": "Role",
    "tokens.roleAdmin": "Administrator",
    "tokens.roleEditor": "Editor",
    "tokens.roleViewer": "Viewer",
    "tokens.issued": "New token",
    "tokens.issueAction": "Issue token",
    "tokens.issueFailed": "Token was not issued: {error}",
    "tokens.none": "No access token exists. Anyone who reaches this server is an administrator.",
    "tokens.environment": "From the environment; revoke it there",
    "tokens.nowRequired": "This server now requires a token. Copy the one above, then sign in with it to continue.",
    "tokens.revoke": "Revoke",
    "tokens.revokeConfirm": "Revoke the token for {subject}?",
    "tokens.revoked": "The token for {subject} was revoked.",
    "tokens.revokeFailed": "Token was not revoked: {error}",
    "credentials.sections": "Provider settings sections",
    "credentials.profilesTab": "Credential profiles",
    "credentials.bindingsTab": "Apex domains",
    "credentials.profilesConfigured": "Saved profiles",
    "credentials.profileEditor": "Profile",
    "credentials.bindingEditor": "Apex domain",
    "credentials.profileName": "Profile name",
    "credentials.profileNamePlaceholder": "production-account",
    "credentials.profileTokenPlaceholder": "Write-only; re-enter to rotate",
    "credentials.accountId": "Cloudflare account ID",
    "credentials.accountIdValue": "Account {id}",
    "credentials.accountIdMissing": "No account ID recorded",
    "credentials.probeZone": "Apex domain used to test this token",
    "credentials.profile": "Credential profile",
    "credentials.profileValue": "Profile {name}",
    "credentials.profileSave": "Save profile",
    "credentials.profileDelete": "Delete profile",
    "credentials.profilesNone": "No credential profiles yet. Create one to reuse a token across domains.",
    "credentials.profileUnused": "Not used by any apex domain yet",
    "credentials.profileSaved": "Profile {name} was saved.",
    "credentials.profileDeleted": "Profile {name} was deleted.",
    "credentials.profileAccepted": "Cloudflare accepted profile {name}.",
    "credentials.profileDeleteConfirm": "Delete credential profile {name}?",
    "credentials.profileInUse": "This profile is still used by an apex domain. Remove those bindings first.",
    "credentials.profileTokenRequired": "An API token is required to save a profile.",
    "credentials.profileNameRequired": "Enter a profile name first.",
    "credentials.probeZoneRequired": "Name an apex domain this token should be able to reach.",
    "credentials.profileRequired": "Select a credential profile for this apex domain.",
    "credentials.eyebrow": "Administrator settings",
    "credentials.title": "Cloudflare credentials",
    "credentials.body": "A profile holds one account ID and API token and can be reused by any number of apex domains. Tokens are encrypted by the server and are never returned to this portal.",
    "credentials.configured": "Configured apex domains",
    "credentials.current": "Current zone",
    "credentials.zone": "Apex domain",
    "credentials.apiToken": "API token",
    "credentials.tokenPlaceholder": "Leave empty to test the saved token",
    "credentials.delete": "Remove binding",
    "credentials.test": "Test connection",
    "credentials.save": "Save binding",
    "credentials.selectZone": "Select a zone before configuring its provider credential.",
    "credentials.adminView": "Administrator access is required to view or change provider credentials.",
    "credentials.disabled": "Encrypted credential management is not enabled on this server.",
    "credentials.loadFailed": "Provider settings could not be loaded: {error}",
    "credentials.zoneIdValue": "Zone ID {id}",
    "credentials.updated": "Updated {date}",
    "credentials.none": "No apex domain is bound to a profile yet.",
    "credentials.required": "Choose a credential profile to save this apex domain.",
    "credentials.saved": "{zone} is now bound to its credential profile.",
    "credentials.adminSave": "Administrator access is required to save credentials.",
    "credentials.saveFailed": "Credential was not saved: {error}",
    "credentials.testNeedsZone": "Name an apex domain before testing a new token.",
    "credentials.accepted": "Cloudflare accepted the credential for {zone}.",
    "credentials.adminTest": "Administrator access is required to test credentials.",
    "credentials.testFailed": "Connection test failed: {error}",
    "credentials.testNeedsBinding": "This apex domain is not connected yet. Save it to a profile first, then test.",
    "credentials.deleteConfirm": "Remove the provider binding for {zone}? The profile itself is kept.",
    "credentials.deleted": "Provider binding removed for {zone}.",
    "credentials.adminDelete": "Administrator access is required to delete credentials.",
    "credentials.deleteFailed": "Credential was not deleted: {error}",
    "validation.required": "{field} is required.", "validation.number": "Enter a valid number for {field}.", "validation.min": "{field} must be at least {min}.", "validation.max": "{field} must be at most {max}.", "validation.step": "{field} must use increments of {step}.",
    "date.unknown": "unknown", "ttl.auto": "Auto", "ttl.seconds": "{seconds}s", "ttl.label": "TTL {value}"
  },
  ko: {
    "meta.description": "Parallax 분할 DNS 운영 포털", "meta.title": "Parallax — DNS 관측소", "language.label": "언어", "language.english": "English", "language.korean": "한국어",
    "nav.skip": "작업 영역으로 건너뛰기", "nav.home": "Parallax 홈", "brand.subtitle": "DNS 관측소", "provider.settings": "프로바이더 설정", "status.controlPlane": "컨트롤 플레인", "status.connecting": "연결 중", "status.online": "컨트롤 플레인 온라인", "status.unavailable": "컨트롤 플레인에 연결할 수 없음",
    "zones.label": "존", "zones.observed": "관측 중인 존", "zones.create": "존 만들기", "zones.filterLabel": "존 필터", "zones.filterPlaceholder": "도메인으로 필터…", "zones.list": "존 목록", "zones.none": "아직 존이 없습니다. 하나 만들어 시작하세요.", "zones.noMatch": "필터와 일치하는 존이 없습니다.", "zones.loadFailed": "존을 불러오지 못했습니다.", "zones.retry": "다시 시도", "zones.stateUnknown": "조정할 것 없음",
    "policy.label": "관리 정책", "policy.managedOnly": "관리 레코드만", "welcome.eyebrow": "선택한 존 없음", "welcome.title": "관측 지점을 선택하세요.", "welcome.body": "존을 선택하여 내부와 외부 DNS 뷰를 비교하거나 이 컨트롤 플레인에 첫 번째 존을 만드세요.", "welcome.create": "존 만들기",
    "zone.active": "활성 존", "zone.loading": "존 불러오는 중…", "zone.desiredRevision": "목표 리비전 {revision}", "zone.lastChanged": "마지막 변경 {date}", "zone.delete": "존 삭제", "zone.refresh": "새로고침", "zone.revisions": "리비전", "zone.adopt": "기존 레코드 입양", "zone.adoptHint": "프로바이더가 이미 갖고 있는 레코드를 소유권은 그대로 둔 채 기술합니다", "zone.adoptConfirm": "이 프로바이더가 이미 갖고 있는 레코드를 목표 상태로 들여올까요?\n\n소유권은 만든 쪽에 그대로 남습니다. 프로바이더에서 다시 쓰는 것이 없고, 나중에 그쪽이 바뀌면 덮어쓰지 않고 충돌로 보입니다.", "zone.adopted": "프로바이더가 가진 {seen}건 중 {adopted}건을 입양했습니다", "zone.adoptFailed": "입양하지 못했습니다: {error}", "zone.adoptWarning": "입양했지만 짚어둘 점이 있습니다: {warning}", "zone.preview": "계획 미리보기", "zone.apply": "변경 적용", "zone.applying": "적용 중…", "zone.discardChanges": "저장하지 않은 레코드 변경을 버릴까요?", "zone.detailsFailed": "존 상세 정보를 불러오지 못했습니다: {error}", "zone.created": "{name} 존을 만들었습니다.", "zone.createFailed": "존을 만들지 못했습니다: {error}", "zone.creating": "만드는 중…", "zone.deleteConfirm": "{name}을(를) 삭제할까요? 목표 상태가 제거되고 Parallax가 게시한 레코드는 DNS 프로바이더에서 모두 회수됩니다. Parallax가 관리하지 않는 레코드는 그대로 둡니다. 되돌릴 수 없습니다.", "zone.deleted": "{name} 존을 삭제했습니다. 회수할 게시 레코드는 없었습니다.", "zone.deletedRecords.one": "{name} 존을 삭제하고 게시 레코드 1건을 회수했습니다.", "zone.deletedRecords.other": "{name} 존을 삭제하고 게시 레코드 {count}건을 회수했습니다.", "zone.deleteFailed": "존을 삭제하지 못했습니다: {error}",
    "horizon.eyebrow": "분할 DNS 렌즈", "horizon.title": "하나의 이름, 두 개의 응답", "horizon.focus": "포커스 레코드", "horizon.internal": "내부 뷰", "horizon.privateResolver": "사설 리졸버", "horizon.sameName": "같은 이름", "horizon.external": "외부 뷰", "horizon.cloudflareEdge": "Cloudflare 엣지",
    "record.desiredState": "목표 상태", "record.title": "DNS 레코드", "record.add": "레코드 추가", "record.addFirst": "첫 레코드 추가", "record.nameType": "이름 / 유형", "record.internalAnswer": "내부 응답", "record.externalAnswer": "외부 응답", "record.ttlViews": "TTL (내부 / 외부)", "record.actions": "작업", "record.noneDefined": "정의된 레코드가 없습니다", "record.noneBody": "레코드를 추가하여 이 존의 첫 번째 분할 뷰를 만드세요.", "record.none": "레코드 없음", "record.noneYet": "아직 레코드 없음", "record.noAnswer": "응답 없음", "record.noAnswerDefined": "정의된 응답 없음", "record.overridden": "RRset으로 재정의됨", "record.proxied": "프록시됨", "record.proxiedLabel": "프록시됨", "record.dnsOnly": "DNS 전용", "record.edit": "수정", "record.delete": "삭제", "record.providerOwnedHint": "DNS 프로바이더가 만들어 지금도 소유한 레코드입니다. 만든 곳에서 지운 뒤 존을 다시 입양하세요.", "record.owner.ours": "우리 소유", "record.owner.oursHint": "Parallax가 프로바이더에 만든 레코드이며 소유권 마커를 갖고 있습니다. 이 컨트롤 플레인이 바꿀 수 있는 레코드입니다.", "record.owner.theirs": "남의 것", "record.owner.theirsHint": "프로바이더가 갖고 있지만 Parallax의 마커가 없습니다. 여기에 기술만 되어 있고 소유는 만든 쪽에 있습니다. 적용해도 다시 쓰지 않으며, 그쪽이 나중에 바뀌면 충돌로 보입니다.", "record.owner.contested": "충돌", "record.owner.contestedHint": "프로바이더가 이 이름에 다른 레코드를 갖고 있고 Parallax 소유가 아닙니다. 적용하면 쓰지 않고 충돌로 보고합니다. 만든 곳에서 바꾸거나, 그쪽에서 지운 뒤 Parallax가 이 값을 게시하게 하세요.", "record.owner.absent": "미게시", "record.owner.absentHint": "이 레코드와 일치하는 것을 프로바이더가 아직 갖고 있지 않습니다. 적용하면 만들어지고 이 컨트롤 플레인의 소유가 됩니다.", "record.editDesired": "목표 레코드 수정", "record.desired": "목표 레코드", "record.removeConfirm": "목표 상태에서 {name} {type} 레코드를 제거할까요?", "record.updatedLocal": "목표 상태를 로컬에서 변경했습니다. 적용 전에 계획을 미리 보세요.", "record.removedLocal": "레코드를 로컬에서 제거했습니다. 계획 미리보기에서 삭제를 확인하세요.", "record.answerRequired": "내부 또는 외부 응답 중 하나는 있어야 합니다. 둘 다 비우면 아무것도 저장되지 않습니다.", "record.duplicate": "이 RRset에 같은 값이 이미 있습니다.", "record.cnameConflict": "CNAME은 해당 이름의 유일한 레코드여야 합니다.",
    "sync.eyebrow": "동기화", "sync.title": "동기화 상태", "sync.checking": "확인 중", "sync.internal": "내부 DNS", "sync.cloudflare": "Cloudflare", "sync.waiting": "상태 대기 중", "sync.comparing": "목표 리비전과 적용된 리비전을 비교하고 있습니다.", "sync.appliedRevision": "적용된 리비전 {revision}", "sync.progress": "{desired} 중 {applied} 리비전 적용됨.", "sync.noneApplied": "아직 적용된 리비전이 없습니다.", "sync.empty": "동기화할 것 없음", "sync.emptyDetail": "이 존에는 아직 레코드가 없어 발행하거나 응답할 것이 없습니다.", "status.pending": "대기 중", "status.applied": "적용됨", "status.failed": "실패", "status.unknown": "알 수 없음", "status.loadFailed": "적용 상태를 불러오지 못했습니다: {error}",
    "history.eyebrow": "감사 추적", "history.title": "최근 변경", "history.none": "이 존에 기록된 변경이 없습니다.", "history.loadFailed": "변경 이력을 불러오지 못했습니다: {error}", "history.changed": "목표 상태 변경됨", "history.system": "시스템", "history.revision": "리비전 {revision}", "history.counts": "+{added} \u2212{removed} ~{changed}", "audit.zoneCreated": "존 생성", "audit.zoneDeleted": "존 삭제", "audit.recordUpserted": "레코드 저장", "audit.recordDeleted": "레코드 삭제", "audit.desiredReplaced": "목표 상태 교체", "audit.desiredRestored": "목표 상태 복원", "audit.recordsAdopted": "기존 레코드 입양", "audit.providerApplyStarted": "프로바이더 적용 시작", "audit.providerApplyCompleted": "프로바이더 적용 완료", "audit.providerApplyFailed": "프로바이더 적용 실패", "provider.operationFailed": "프로바이더 작업 실패", "provider.unmanagedConflict": "관리되지 않는 프로바이더 레코드가 목표 상태와 충돌합니다", "provider.notConfigured": "{target}에 설정된 DNS 프로바이더가 없습니다", "dialog.close": "대화 상자 닫기", "dialog.cancel": "취소",
    "zoneDialog.eyebrow": "새 관측 지점", "zoneDialog.title": "존 만들기", "zoneDialog.body": "Parallax는 직접 만들거나 명시적으로 채택한 레코드만 관리합니다.", "zoneDialog.domain": "도메인 이름", "zoneDialog.provider": "외부 프로바이더",
    "recordDialog.name": "이름", "recordDialog.type": "유형", "recordDialog.content": "내용", "recordDialog.internalHelp": "비워 두면 외부 응답을 상속합니다", "recordDialog.internalTtl": "내부 TTL(초)", "recordDialog.externalHelp": "설정된 프로바이더를 통해 게시됩니다. 비워 두면 이 이름은 내부에서만 응답합니다", "recordDialog.proxy": "Cloudflare 프록시", "recordDialog.proxyHelp": "지원되는 주소 및 CNAME 레코드에서 사용할 수 있습니다.", "recordDialog.externalTtl": "외부 TTL", "recordDialog.ttlHelp": "자동은 1, DNS 전용 레코드는 60~86400초를 사용하세요.", "recordDialog.proxiedTtlHelp": "Cloudflare 프록시 레코드는 항상 자동 TTL(5분)을 사용합니다.", "recordDialog.ttlInvalid": "자동(1) 또는 60~86400초 값을 사용하세요.", "recordDialog.nonGlobal": "비전역 주소 게시 확인", "recordDialog.nonGlobalHelp": "이 주소는 사설 또는 예약 주소이며 유효하지 않은 외부 DNS 응답을 노출할 수 있습니다. 의도를 검토한 후에만 선택하세요.", "recordDialog.save": "목표 상태 저장",
    "plan.eyebrow": "동기화 미리보기", "plan.title": "적용 계획 검토", "plan.comparing": "Parallax가 목표 상태와 실제 상태를 비교하고 있습니다.", "plan.keepEditing": "계속 수정", "plan.apply": "이 계획 적용", "plan.failed": "계획을 생성하지 못했습니다.", "plan.failedHelp": "{error} 존 설정을 확인한 후 다시 시도하세요.", "plan.operations.one": "이 존을 동기화할 작업이 1개 있습니다.", "plan.operations.other": "이 존을 동기화할 작업이 {count}개 있습니다.", "plan.viewUnreadable": "{view}: {error}", "plan.unreadable.one": "뷰 1개를 읽지 못했습니다 — 무엇이 바뀔지 알 수 없습니다", "plan.unreadable.other": "뷰 {count}개를 읽지 못했습니다 — 무엇이 바뀔지 알 수 없습니다", "plan.noChanges": "목표 상태와 실제 상태가 이미 일치합니다. 적용할 항목이 없습니다.", "plan.provider": "DNS 프로바이더", "plan.record": "레코드", "plan.reconciled": "상태가 동기화됩니다", "plan.noDrift": "차이가 감지되지 않았습니다.", "plan.untouched.one": "프로바이더에 있는 레코드 1개는 여기서 소유하지도 기술하지도 않아 그대로 둡니다.", "plan.untouched.other": "프로바이더에 있는 레코드 {count}개는 여기서 소유하지도 기술하지도 않아 그대로 둡니다.", "operation.create": "생성", "operation.update": "업데이트", "operation.delete": "삭제", "operation.conflict": "충돌", "apply.started": "적용을 시작했습니다.", "apply.startedRevision": "리비전 {revision} 적용을 시작했습니다.", "apply.forRevision": "(리비전 {revision})", "apply.failed": "변경을 적용하지 못했습니다: {error}",
    "auth.eyebrow": "보호된 컨트롤 플레인", "auth.title": "접근 토큰 입력", "auth.body": "이 서버에는 관리자, 편집자 또는 뷰어 토큰이 필요합니다. 토큰은 이 페이지의 스크립트가 읽을 수 없는 세션 쿠키로 교환됩니다.", "auth.signOut": "로그아웃", "auth.token": "접근 토큰", "auth.open": "컨트롤 플레인 열기", "auth.or": "또는", "auth.identity": "조직 계정으로 로그인", "auth.identityHint": "역할은 인증 제공자에서 옵니다. 관리자가 거기서 부여합니다.", "auth.forbidden": "이 토큰으로 컨트롤 플레인을 열 수 없습니다.", "auth.rejected": "토큰이 승인되지 않았습니다.", "auth.identityFailed": "{reason}",
    "revisions.eyebrow": "불변의 목표 상태", "revisions.title": "리비전 기록", "revisions.body": "스냅샷을 복원하면 새 리비전이 생성됩니다. 기존 기록은 다시 작성되지 않습니다.", "revisions.item": "리비전 {revision}{currentText}", "revisions.current": " · 현재", "revisions.records.one": "뷰 레코드 1개", "revisions.records.other": "뷰 레코드 {count}개", "revisions.restore": "복원", "revisions.inspect": "내용 보기", "revisions.hide": "접기", "revisions.inspectFailed": "이 리비전을 읽지 못했습니다: {error}", "revisions.snapshotEmpty": "이 리비전에는 레코드가 없습니다.", "revisions.colView": "뷰", "revisions.colName": "이름", "revisions.colType": "유형", "revisions.colContent": "내용", "revisions.colTtl": "TTL", "revisions.none": "기록된 리비전 스냅샷이 없습니다.", "revisions.restoreConfirm": "리비전 {revision}을 새 목표 리비전으로 복원할까요?", "revisions.restored": "리비전 {revision}을 새 목표 상태로 복원했습니다.", "revisions.restoreFailed": "리비전을 복원하지 못했습니다: {error}", "revisions.loadFailed": "리비전 기록을 불러오지 못했습니다: {error}",
    "settings.tab": "서버 설정", "settings.body": "이 값들은 데이터베이스에 저장되어 모든 인스턴스가 공유합니다. 바인드 주소, 데이터베이스 접속 정보, 암호화 키는 환경변수에 남습니다.", "settings.allowLocalProvider": "로컬 파일 프로바이더", "settings.allowLocalProviderHelp": "실제 프로바이더가 없을 때 로컬 파일에 게시합니다. 적용해도 실제 DNS에는 반영되지 않습니다.", "settings.trustForwardedHeaders": "프록시 헤더 신뢰", "settings.trustForwardedHeadersHelp": "X-Forwarded-Proto와 X-Forwarded-Host를 읽습니다. 프록시를 통해서만 접근 가능한 경우에만 켜세요.", "settings.publicOrigin": "공개 origin",
    "settings.warning": "저장했습니다. 다만: {message}", "settings.revisionRetention": "존별 보관 리비전 수", "settings.auditRetentionDays": "감사 기록 보관 일수", "settings.fallbackResolver": "폴백 리졸버 주소", "settings.fallbackResolverHelp": "이 컨트롤 플레인의 존을 기기가 물어볼 주소입니다. 기기 설정 동기화 전에 필요합니다.", "settings.save": "설정 저장", "settings.saved": "서버 설정을 저장했습니다.", "settings.saveFailed": "설정을 저장하지 못했습니다: {error}", "fallback.tab": "로컬 도메인 폴백", "fallback.body": "프로바이더 클라이언트를 쓰는 기기는 이 접미사들을 공개 DNS 대신 이 컨트롤 플레인으로 해석합니다. 존이 이 프로필에 묶여 있고 내부 뷰가 무언가에 답할 때 대상이 됩니다.", "fallback.profile": "자격 증명 프로필", "fallback.refresh": "새로고침", "fallback.sync": "기기 설정에 반영", "fallback.syncConfirm": "{profile}이(가) 담당하는 모든 존에 대해 기기를 이 컨트롤 플레인으로 보낼까요?\n\n조직 전체가 공유하는 설정 하나를 수정합니다. Parallax가 만들지 않은 항목은 그대로 둡니다.", "fallback.synced": "오버라이드를 갱신했습니다. {count}건이 바뀌었습니다.", "fallback.alreadyInStep": "오버라이드가 이미 이 프로필의 존과 일치합니다.", "fallback.syncFailed": "오버라이드를 갱신하지 못했습니다: {error}", "fallback.coverageFailed": "어느 존이 대상인지 읽지 못했습니다: {error}", "fallback.resolver": "기기를 보낼 리졸버", "fallback.resolverMissing": "서버 설정에 폴백 리졸버가 없어서, 이 존들을 보낼 주소가 없습니다.", "fallback.covered": "이 프로필이 담당하는 존", "fallback.coveredNone": "이 프로필에 묶인 존 중 내부 응답이 있는 것이 아직 없습니다.", "fallback.excluded": "대상이 아닌 존과 그 이유", "fallback.reason.unbound": "이 존에 묶인 자격 증명이 없어 어느 프로필도 담당하지 않습니다", "fallback.reason.otherProfile": "{profile} 프로필에 묶여 있으니 그쪽을 동기화하세요", "fallback.reason.empty": "내부 응답이 아직 없어 이 컨트롤 플레인이 권한을 주장하지 않습니다", "fallback.reason.invalid": "뷰를 구성할 수 없어 리스너가 서비스하지 않습니다", "fallback.live": "프로바이더에 있는 항목", "fallback.liveNone": "오버라이드 목록이 비어 있습니다.", "fallback.plan.title": "반영하면 바뀌는 것", "fallback.plan.add": "추가", "fallback.plan.update": "이쪽으로 변경", "fallback.plan.adopt": "소유 표시(이미 올바름)", "fallback.plan.remove": "제거", "fallback.plan.conflict": "그대로 둠: 다른 쪽의 항목", "fallback.planFailed": "프로바이더 목록을 읽지 못했습니다: {error}", "fallback.inStep": "바꿀 것이 없습니다.", "tokens.tab": "접근 토큰", "tokens.existing": "발급된 토큰", "tokens.issue": "토큰 발급", "tokens.body": "새 토큰은 한 번만 표시되고 서버에는 다이제스트만 저장됩니다. 이 창을 닫기 전에 복사하세요.", "tokens.subject": "주체", "tokens.role": "역할", "tokens.roleAdmin": "관리자", "tokens.roleEditor": "편집자", "tokens.roleViewer": "뷰어", "tokens.issued": "새 토큰", "tokens.issueAction": "토큰 발급", "tokens.issueFailed": "토큰을 발급하지 못했습니다: {error}", "tokens.none": "접근 토큰이 없습니다. 이 서버에 도달한 누구나 관리자입니다.", "tokens.environment": "환경변수로 주입됨. 그곳에서 제거하세요", "tokens.nowRequired": "이제 이 서버는 토큰을 요구합니다. 위 토큰을 복사한 뒤 그것으로 로그인하세요.", "tokens.revoke": "폐기", "tokens.revokeConfirm": "{subject}의 토큰을 폐기할까요?", "tokens.revoked": "{subject}의 토큰을 폐기했습니다.", "tokens.revokeFailed": "토큰을 폐기하지 못했습니다: {error}", "credentials.sections": "프로바이더 설정 섹션", "credentials.profilesTab": "자격 증명 프로필", "credentials.bindingsTab": "Apex 도메인", "credentials.profilesConfigured": "저장된 프로필", "credentials.profileEditor": "프로필", "credentials.bindingEditor": "Apex 도메인", "credentials.profileName": "프로필 이름", "credentials.profileNamePlaceholder": "production-account", "credentials.profileTokenPlaceholder": "쓰기 전용. 교체하려면 다시 입력하세요", "credentials.accountId": "Cloudflare 계정 ID", "credentials.accountIdValue": "계정 {id}", "credentials.accountIdMissing": "기록된 계정 ID 없음", "credentials.probeZone": "이 토큰을 테스트할 apex 도메인", "credentials.profile": "자격 증명 프로필", "credentials.profileValue": "프로필 {name}", "credentials.profileSave": "프로필 저장", "credentials.profileDelete": "프로필 삭제", "credentials.profilesNone": "아직 자격 증명 프로필이 없습니다. 하나 만들면 여러 도메인에서 토큰을 재사용할 수 있습니다.", "credentials.profileUnused": "아직 어떤 apex 도메인도 사용하지 않음", "credentials.profileSaved": "{name} 프로필을 저장했습니다.", "credentials.profileDeleted": "{name} 프로필을 삭제했습니다.", "credentials.profileAccepted": "Cloudflare가 {name} 프로필을 승인했습니다.", "credentials.profileDeleteConfirm": "{name} 자격 증명 프로필을 삭제할까요?", "credentials.profileInUse": "이 프로필을 사용 중인 apex 도메인이 있습니다. 해당 연결을 먼저 제거하세요.", "credentials.profileTokenRequired": "프로필을 저장하려면 API 토큰이 필요합니다.", "credentials.profileNameRequired": "프로필 이름을 먼저 입력하세요.", "credentials.probeZoneRequired": "이 토큰이 닿을 수 있는 apex 도메인을 입력하세요.", "credentials.profileRequired": "이 apex 도메인에 사용할 자격 증명 프로필을 선택하세요.", "credentials.eyebrow": "관리자 설정", "credentials.title": "Cloudflare 자격 증명", "credentials.body": "프로필 하나가 계정 ID와 API 토큰을 담으며 여러 apex 도메인이 재사용할 수 있습니다. 토큰은 서버에서 암호화되고 이 포털로 반환되지 않습니다.", "credentials.configured": "설정된 apex 도메인", "credentials.current": "현재 존", "credentials.zone": "Apex 도메인", "credentials.apiToken": "API 토큰", "credentials.tokenPlaceholder": "저장된 토큰을 테스트하려면 비워 두세요", "credentials.delete": "연결 제거", "credentials.test": "연결 테스트", "credentials.save": "연결 저장", "credentials.selectZone": "프로바이더 자격 증명을 설정하기 전에 존을 선택하세요.", "credentials.adminView": "프로바이더 자격 증명을 보거나 변경하려면 관리자 권한이 필요합니다.", "credentials.disabled": "이 서버에서 암호화 자격 증명 관리가 활성화되지 않았습니다.", "credentials.loadFailed": "프로바이더 설정을 불러오지 못했습니다: {error}", "credentials.zoneIdValue": "존 ID {id}", "credentials.updated": "업데이트 {date}", "credentials.none": "아직 프로필에 연결된 apex 도메인이 없습니다.", "credentials.required": "이 apex 도메인에 사용할 자격 증명 프로필을 선택하세요.", "credentials.saved": "{zone}을(를) 자격 증명 프로필에 연결했습니다.", "credentials.adminSave": "자격 증명을 저장하려면 관리자 권한이 필요합니다.", "credentials.saveFailed": "자격 증명을 저장하지 못했습니다: {error}", "credentials.testNeedsZone": "새 토큰을 테스트하기 전에 apex 도메인을 입력하세요.", "credentials.accepted": "Cloudflare가 {zone}의 자격 증명을 승인했습니다.", "credentials.adminTest": "자격 증명을 테스트하려면 관리자 권한이 필요합니다.", "credentials.testFailed": "연결 테스트 실패: {error}", "credentials.testNeedsBinding": "이 apex 도메인은 아직 연결되지 않았습니다. 프로필에 저장한 뒤 테스트하세요.", "credentials.deleteConfirm": "{zone}의 프로바이더 연결을 제거할까요? 프로필 자체는 유지됩니다.", "credentials.deleted": "{zone}의 프로바이더 연결을 제거했습니다.", "credentials.adminDelete": "자격 증명을 삭제하려면 관리자 권한이 필요합니다.", "credentials.deleteFailed": "자격 증명을 삭제하지 못했습니다: {error}", "validation.required": "{field}: 필수 입력 항목입니다.", "validation.number": "{field}: 올바른 숫자를 입력하세요.", "validation.min": "{field}: {min} 이상이어야 합니다.", "validation.max": "{field}: {max} 이하여야 합니다.", "validation.step": "{field}: {step} 단위로 입력하세요.", "date.unknown": "알 수 없음", "ttl.auto": "자동", "ttl.seconds": "{seconds}초", "ttl.label": "TTL {value}"
  }
});

export function normalizeLocale(value) {
  const locale = String(value || "").trim().toLowerCase().replace("_", "-");
  const base = locale.split("-")[0];
  return SUPPORTED_LOCALES.includes(base) ? base : null;
}

/** @param {{ persistedLocale?: string | null, browserLocales?: readonly string[] }} [sources] */
export function resolveLocale({ persistedLocale, browserLocales = [] } = {}) {
  const persisted = normalizeLocale(persistedLocale);
  if (persisted) return persisted;
  for (const locale of browserLocales) {
    const normalized = normalizeLocale(locale);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

export function createTranslator(locale = DEFAULT_LOCALE) {
  const activeLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  return (key, values = {}) => {
    const template = messages[activeLocale]?.[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? key;
    return template.replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  };
}

export function pluralKey(baseKey, count) {
  return `${baseKey}.${Number(count) === 1 ? "one" : "other"}`;
}

export function localizeAuditAction(value, translate) {
  const key = AUDIT_MESSAGE_KEYS[String(value || "")];
  return key ? translate(key) : value;
}

export function localizeProviderError(value, translate) {
  const message = String(value || "");
  const key = PROVIDER_ERROR_KEYS[message];
  if (key) return translate(key);
  // The provider-not-configured message names the target it is missing, so it
  // is matched by shape rather than by exact text.
  const missing = /^no provider is configured for (\S+)$/.exec(message);
  return missing ? translate("provider.notConfigured", { target: missing[1] }) : value;
}

export function localizeViewName(value, translate) {
  const key = VIEW_MESSAGE_KEYS[String(value || "")];
  return key ? translate(key) : value;
}

export function createSemanticMessage(key, values = {}) {
  return Object.freeze({ key, values: Object.freeze({ ...values }) });
}

export function renderSemanticMessage(message, translate) {
  return translate(message.key, message.values);
}

export function readPersistedLocale(storage) {
  try { return storage?.getItem(LOCALE_STORAGE_KEY) ?? null; } catch { return null; }
}

export function writePersistedLocale(storage, locale) {
  if (!storage) return false;
  try { storage.setItem(LOCALE_STORAGE_KEY, locale); return true; } catch { return false; }
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

export function localizedValidationMessage({ validity, label, min, max, step }, translate) {
  if (validity.valueMissing) return translate("validation.required", { field: label });
  if (validity.badInput) return translate("validation.number", { field: label });
  if (validity.rangeUnderflow) return translate("validation.min", { field: label, min });
  if (validity.rangeOverflow) return translate("validation.max", { field: label, max });
  if (validity.stepMismatch) return translate("validation.step", { field: label, step });
  return "";
}

export function translateDocument(root, translate) {
  for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = translate(element.dataset.i18n);
  for (const element of root.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", translate(element.dataset.i18nAriaLabel));
  for (const element of root.querySelectorAll("[data-i18n-title]")) element.setAttribute("title", translate(element.dataset.i18nTitle));
  for (const element of root.querySelectorAll("[data-i18n-placeholder]")) element.setAttribute("placeholder", translate(element.dataset.i18nPlaceholder));
  for (const element of root.querySelectorAll("[data-i18n-content]")) element.setAttribute("content", translate(element.dataset.i18nContent));
}
