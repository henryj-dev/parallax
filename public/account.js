/**
 * The member account page: sign-in, two-step verification, invitations,
 * password and email changes, sessions, organization sign-in links and member
 * administration.
 *
 * Nothing secret leaves memory. Session and challenge cookies are HttpOnly and
 * never reach this script; the CSRF token, an authenticator key being set up
 * and recovery codes live in variables and on screen only, and are wiped on
 * sign-out and when the page is left. A link token arrives in the URL from an
 * email and is taken out of the address bar before anything else runs.
 *
 * The server enforces every rule shown here. Hiding a button is a courtesy,
 * not the check.
 */
import { LOCALE_STORAGE_KEY, resolveLocale } from "./i18n.js";

export const ACCOUNT_MESSAGES = Object.freeze({
  en: {
    "brand.account": "ACCOUNT", "nav.dns": "DNS", "language.label": "Language", "action.logout": "Sign out",
    "field.email": "Email", "field.password": "Password", "field.code": "Code", "field.invitedEmail": "The address the invitation was sent to",
    "field.displayName": "Display name", "field.newPassword": "New password", "field.currentPassword": "Current password", "field.newEmail": "New email",
    "login.title": "Sign in", "login.submit": "Sign in", "login.sso": "Sign in with your organization",
    "forgot.title": "Forgot your password?", "forgot.submit": "Send a reset link",
    "forgot.sent": "If that address belongs to an active account, a reset link is on its way.",
    "mfa.title": "Two-step verification", "mfa.body": "Enter the code from your authenticator app, or one recovery code.",
    "mfa.recoveryNote": "A recovery code ends every session and asks you to set up a new authenticator.", "mfa.verify": "Verify",
    "mfa.recoveryUsed": "Recovery code accepted. Set up a new authenticator to finish signing in.",
    "enroll.title": "Set up an authenticator", "enroll.body": "Add this key to an authenticator app, then enter the code it shows. The key is shown only on this screen.",
    "enroll.start": "Show the key", "enroll.key": "Key", "enroll.uri": "Setup link", "enroll.confirm": "Confirm",
    "recovery.title": "Recovery codes", "recovery.body": "These are shown once. Keep them somewhere safe; each one works a single time.",
    "recovery.done": "I have saved them", "recovery.replace": "Replace recovery codes", "recovery.replaceConfirm": "Replace your recovery codes? The old ones stop working.",
    "invite.title": "Accept your invitation", "invite.submit": "Create my account", "invite.done": "Your account is ready. Sign in to continue.",
    "reset.title": "Choose a new password", "reset.submit": "Set password", "reset.done": "Password changed. Sign in with the new one.",
    "emailConfirm.title": "Confirm your new email address", "emailConfirm.body": "Signing in again afterwards is required. Confirming needs a recent verification code.",
    "emailConfirm.submit": "Confirm the change", "emailConfirm.done": "Email changed. Sign in again.", "emailConfirm.signIn": "Sign in first, then open the link again.",
    "me.email": "Email", "me.role": "Role", "me.mfa": "Recent verification", "me.mfaYes": "Yes", "me.mfaNo": "No",
    "me.legacy": "You signed in through the temporary legacy sign-in. Sensitive actions need your own account and authenticator.",
    "reauth.title": "Verify for sensitive actions", "reauth.body": "Changing passwords, email, sessions, sign-in links and members needs a code entered recently.",
    "reauth.done": "Verified.",
    "password.title": "Change password", "password.note": "Every session ends, including this one.", "password.submit": "Change password",
    "password.done": "Password changed. Sign in again.",
    "email.title": "Change email", "email.submit": "Send a confirmation link", "email.sent": "A confirmation link went to the new address. Open it in this browser.",
    "sessions.title": "Sessions", "sessions.revokeAll": "Sign out everywhere", "sessions.revoke": "End", "sessions.legacy": "legacy sign-in",
    "sessions.item": "Started {created} · last seen {seen}", "sessions.revokeAllConfirm": "End every session, including this one?",
    "sessions.current": "this session", "sessions.revokeCurrent": "Sign out here", "sessions.revokeCurrentConfirm": "End this session? You will be signed out of this browser.",
    "identities.title": "Organization sign-in", "identities.note": "Linking is matched by the provider's account ID, never by email.",
    "identities.link": "Link an organization account", "identities.unlink": "Unlink", "identities.none": "No organization account is linked.",
    "identities.unlinkConfirm": "Unlink {issuer}? You will need your password to sign in.", "identities.legacy": "legacy",
    "admin.title": "Members", "admin.invite": "Invite", "admin.status": "Status", "admin.invited": "Invitation sent to {email}.",
    "admin.inviteAdminConfirm": "Invite {email} as an administrator? They can manage every member and the DNS control plane.",
    "admin.suspend": "Suspend", "admin.restore": "Restore", "admin.delete": "Delete", "admin.apply": "Save role",
    "admin.suspendConfirm": "Suspend {email}? Their sessions end now.", "admin.deleteConfirm": "Delete {email}? Their sessions end and they cannot sign in again.",
    "admin.roleConfirm": "Change {email} to {role}? Their sessions end now.", "admin.changed": "Saved.", "admin.needsVerify": "Verify with a code above to see and manage members.",
    "status.active": "active", "status.suspended": "suspended", "status.deleted": "deleted",
    "role.viewer": "viewer", "role.editor": "editor", "role.admin": "admin",
    "policy.title": "Organization sign-in policy", "policy.roleSource": "Where roles come from", "policy.local": "Parallax (local roles)",
    "policy.idpUnsupported": "Identity provider — not supported: the provider cannot prove a revoked role on the next request",
    "policy.mfaEvidence": "What counts as verification", "policy.localTotp": "Parallax authenticator codes",
    "policy.idpMfaUnsupported": "Identity provider MFA — not supported: no provider contract proves a fresh second factor",
    "policy.jit": "Automatic sign-up on first organization sign-in",
    "policy.jitNote": "Off unless an issuer is named. New people get viewer, an address already in use is refused, and nobody is linked by email.",
    "policy.issuer": "Issuer (blank turns it off)", "policy.maxUsers": "Most people it may admit", "policy.save": "Save policy", "policy.saved": "Policy saved.",
    "policy.maxUsersRequired": "Name how many people automatic sign-up may admit.",
    "error.invalid-input": "Check what you entered.", "error.denied": "That was not accepted.", "error.conflict": "That conflicts with the current state. Reload and try again.",
    "error.last-admin": "This would leave no administrator who can sign in with a password and authenticator.",
    "error.rate-limited": "Too many attempts. Wait a while and try again.", "error.unavailable": "The account service is unavailable. Try again shortly.",
    "error.mfa-required": "Enter a verification code first, then try again.", "error.reauthentication_required": "Enter a verification code first, then try again.",
    "error.not-enabled": "Member accounts are not enabled on this server.", "error.csrf_rejected": "The page was out of date. Reload and try again.",
    "error.identity_authentication_failed": "Organization sign-in failed.", "error.unknown": "Something went wrong. Try again.",
    "error.weak-password": "Use at least 8 characters with three of: lower-case letters, upper-case letters, digits, and anything else.",
    "password.rule": "At least 8 characters, using three of: lower-case letters, upper-case letters, digits, and anything else (spaces and other scripts count).",
    "leave.title": "Delete my account", "leave.note": "Your address, name, password and authenticator are removed at once and you are signed out. This needs a recent verification code.",
    "leave.submit": "Delete my account", "leave.confirm": "Delete your account? This cannot be undone.", "leave.done": "Your account was deleted.",
    "error.unauthorized": "Your session has ended. Sign in again.", "error.authentication_unavailable": "Sign-in cannot be checked right now. Try again shortly.",
    "error.invalid_path": "That address is not valid.",
    "admin.restoreConfirm": "Restore {email}? They can sign in again with their existing password and authenticator.",
    "enroll.passwordRequired": "Enter your current password to set up an authenticator.",
    "error.enroll-first": "This needs a verification code, and you have no authenticator yet. Set one up first.",
    "action.enroll": "Set up an authenticator",
  },
  ko: {
    "brand.account": "계정", "nav.dns": "DNS", "language.label": "언어", "action.logout": "로그아웃",
    "field.email": "이메일", "field.password": "비밀번호", "field.code": "코드", "field.invitedEmail": "초대를 받은 이메일 주소",
    "field.displayName": "표시 이름", "field.newPassword": "새 비밀번호", "field.currentPassword": "현재 비밀번호", "field.newEmail": "새 이메일",
    "login.title": "로그인", "login.submit": "로그인", "login.sso": "조직 계정으로 로그인",
    "forgot.title": "비밀번호를 잊으셨나요?", "forgot.submit": "재설정 링크 받기",
    "forgot.sent": "사용 중인 계정의 주소라면 재설정 링크를 보냈어요.",
    "mfa.title": "2단계 인증", "mfa.body": "인증 앱의 코드나 복구 코드 하나를 입력하세요.",
    "mfa.recoveryNote": "복구 코드를 쓰면 모든 세션이 끝나고 인증 앱을 새로 등록해야 해요.", "mfa.verify": "확인",
    "mfa.recoveryUsed": "복구 코드를 확인했어요. 인증 앱을 새로 등록하면 로그인이 끝나요.",
    "enroll.title": "인증 앱 등록", "enroll.body": "아래 키를 인증 앱에 추가하고, 앱에 나온 코드를 입력하세요. 키는 이 화면에만 보여요.",
    "enroll.start": "키 보기", "enroll.key": "키", "enroll.uri": "설정 링크", "enroll.confirm": "확인",
    "recovery.title": "복구 코드", "recovery.body": "한 번만 보여 드려요. 안전한 곳에 보관하세요. 코드마다 한 번씩만 쓸 수 있어요.",
    "recovery.done": "보관했어요", "recovery.replace": "복구 코드 다시 발급", "recovery.replaceConfirm": "복구 코드를 다시 발급할까요? 기존 코드는 더 이상 쓸 수 없어요.",
    "invite.title": "초대 수락", "invite.submit": "계정 만들기", "invite.done": "계정을 만들었어요. 로그인해 주세요.",
    "reset.title": "새 비밀번호 정하기", "reset.submit": "비밀번호 설정", "reset.done": "비밀번호를 바꿨어요. 새 비밀번호로 로그인하세요.",
    "emailConfirm.title": "새 이메일 주소 확인", "emailConfirm.body": "확인한 뒤 다시 로그인해야 해요. 최근에 입력한 인증 코드가 필요해요.",
    "emailConfirm.submit": "변경 확인", "emailConfirm.done": "이메일을 바꿨어요. 다시 로그인하세요.", "emailConfirm.signIn": "먼저 로그인한 뒤 링크를 다시 여세요.",
    "me.email": "이메일", "me.role": "역할", "me.mfa": "최근 인증", "me.mfaYes": "예", "me.mfaNo": "아니요",
    "me.legacy": "임시 기존 SSO 로그인으로 들어왔어요. 민감한 작업은 자체 계정과 인증 앱이 있어야 해요.",
    "reauth.title": "민감한 작업 전 인증", "reauth.body": "비밀번호·이메일·세션·로그인 연결·회원을 바꾸려면 최근에 입력한 코드가 필요해요.",
    "reauth.done": "인증했어요.",
    "password.title": "비밀번호 변경", "password.note": "이 세션을 포함한 모든 세션이 끝나요.", "password.submit": "비밀번호 변경",
    "password.done": "비밀번호를 바꿨어요. 다시 로그인하세요.",
    "email.title": "이메일 변경", "email.submit": "확인 링크 받기", "email.sent": "새 주소로 확인 링크를 보냈어요. 이 브라우저에서 여세요.",
    "sessions.title": "세션", "sessions.revokeAll": "모든 기기에서 로그아웃", "sessions.revoke": "종료", "sessions.legacy": "기존 SSO 로그인",
    "sessions.item": "{created} 시작 · 마지막 사용 {seen}", "sessions.revokeAllConfirm": "이 세션을 포함한 모든 세션을 끝낼까요?",
    "sessions.current": "현재 세션", "sessions.revokeCurrent": "여기서 로그아웃", "sessions.revokeCurrentConfirm": "현재 세션을 끝낼까요? 이 브라우저에서 로그아웃돼요.",
    "identities.title": "조직 계정 로그인", "identities.note": "연결은 이메일이 아니라 제공자의 계정 ID로만 맞춰요.",
    "identities.link": "조직 계정 연결", "identities.unlink": "연결 해제", "identities.none": "연결된 조직 계정이 없어요.",
    "identities.unlinkConfirm": "{issuer} 연결을 해제할까요? 이후에는 비밀번호로 로그인해야 해요.", "identities.legacy": "기존",
    "admin.title": "회원", "admin.invite": "초대", "admin.status": "상태", "admin.invited": "{email} 주소로 초대를 보냈어요.",
    "admin.inviteAdminConfirm": "{email} 님을 관리자로 초대할까요? 모든 회원과 DNS 컨트롤 플레인을 관리할 수 있어요.",
    "admin.suspend": "정지", "admin.restore": "복구", "admin.delete": "삭제", "admin.apply": "역할 저장",
    "admin.suspendConfirm": "{email} 님을 정지할까요? 세션이 바로 끝나요.", "admin.deleteConfirm": "{email} 님을 삭제할까요? 세션이 끝나고 다시 로그인할 수 없어요.",
    "admin.roleConfirm": "{email} 님의 역할을 {role}(으)로 바꿀까요? 세션이 바로 끝나요.", "admin.changed": "저장했어요.", "admin.needsVerify": "회원을 보고 관리하려면 위에서 코드로 인증하세요.",
    "status.active": "사용 중", "status.suspended": "정지", "status.deleted": "삭제됨",
    "role.viewer": "뷰어", "role.editor": "편집자", "role.admin": "관리자",
    "policy.title": "조직 계정 로그인 정책", "policy.roleSource": "역할 출처", "policy.local": "Parallax (자체 역할)",
    "policy.idpUnsupported": "인증 제공자 — 지원 안 함: 다음 요청에서 권한 철회를 증명하지 못해요",
    "policy.mfaEvidence": "인증으로 인정하는 것", "policy.localTotp": "Parallax 인증 앱 코드",
    "policy.idpMfaUnsupported": "인증 제공자 MFA — 지원 안 함: 최근 2단계 인증을 증명하는 제공자 계약이 없어요",
    "policy.jit": "첫 조직 계정 로그인 때 자동 가입",
    "policy.jitNote": "발급자를 적어야만 켜져요. 새 회원은 뷰어로 시작하고, 이미 쓰는 주소는 거절하며, 이메일로 계정을 연결하지 않아요.",
    "policy.issuer": "발급자 (비우면 꺼짐)", "policy.maxUsers": "자동 가입 최대 인원", "policy.save": "정책 저장", "policy.saved": "정책을 저장했어요.",
    "policy.maxUsersRequired": "자동 가입으로 받을 최대 인원을 적어 주세요.",
    "error.invalid-input": "입력한 값을 확인하세요.", "error.denied": "승인되지 않았어요.", "error.conflict": "현재 상태와 맞지 않아요. 새로고침한 뒤 다시 시도하세요.",
    "error.last-admin": "비밀번호와 인증 앱으로 로그인할 관리자가 한 명도 남지 않게 돼요.",
    "error.rate-limited": "시도가 너무 많아요. 잠시 뒤 다시 시도하세요.", "error.unavailable": "계정 서비스를 쓸 수 없어요. 잠시 뒤 다시 시도하세요.",
    "error.mfa-required": "먼저 인증 코드를 입력한 뒤 다시 시도하세요.", "error.reauthentication_required": "먼저 인증 코드를 입력한 뒤 다시 시도하세요.",
    "error.not-enabled": "이 서버에서 회원 계정이 켜져 있지 않아요.", "error.csrf_rejected": "페이지가 오래됐어요. 새로고침한 뒤 다시 시도하세요.",
    "error.identity_authentication_failed": "조직 계정 로그인에 실패했어요.", "error.unknown": "문제가 생겼어요. 다시 시도하세요.",
    "error.weak-password": "8자 이상, 영소문자·영대문자·숫자·그 밖의 문자 중 세 가지를 섞어 주세요.",
    "password.rule": "8자 이상, 영소문자·영대문자·숫자·그 밖의 문자(공백·한글 등 포함) 중 세 가지를 섞어 주세요.",
    "leave.title": "계정 삭제", "leave.note": "이메일 주소·이름·비밀번호·인증 앱이 바로 지워지고 로그아웃돼요. 최근에 입력한 인증 코드가 필요해요.",
    "leave.submit": "계정 삭제", "leave.confirm": "계정을 삭제할까요? 되돌릴 수 없어요.", "leave.done": "계정을 삭제했어요.",
    "error.unauthorized": "세션이 끝났어요. 다시 로그인하세요.", "error.authentication_unavailable": "지금은 로그인을 확인할 수 없어요. 잠시 뒤 다시 시도하세요.",
    "error.invalid_path": "올바른 주소가 아니에요.",
    "admin.restoreConfirm": "{email} 님을 복구할까요? 기존 비밀번호와 인증 앱으로 다시 로그인할 수 있어요.",
    "enroll.passwordRequired": "인증 앱을 등록하려면 현재 비밀번호를 입력하세요.",
    "error.enroll-first": "이 작업에는 인증 코드가 필요한데 아직 인증 앱이 없어요. 먼저 OTP를 등록하세요.",
    "action.enroll": "OTP 등록하기",
  },
});

/** Which view a path shows. Mail links land on the last three. */
export function viewForPath(pathname) {
  const path = pathname.replace(/\/+$/u, "") || "/";
  return { "/account/login": "login", "/account/invite": "invite", "/account/reset": "reset", "/account/email": "email" }[path] ?? "account";
}

class AccountError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function startPage() {
  const $ = (selector) => document.querySelector(selector);
  let locale = "en";
  try { locale = resolveLocale({ persistedLocale: localStorage.getItem(LOCALE_STORAGE_KEY), browserLocales: navigator.languages }); }
  catch { locale = resolveLocale({ browserLocales: navigator.languages }); }
  const t = (key, values = {}) => (ACCOUNT_MESSAGES[locale]?.[key] ?? ACCOUNT_MESSAGES.en[key] ?? key)
    .replace(/\{(\w+)\}/gu, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);

  // Read once, then removed from the address bar, history and any later Referer.
  const url = new URL(location.href);
  const linkToken = url.searchParams.get("token") ?? "";
  const mfaParameter = url.searchParams.get("mfa");
  if (url.search) history.replaceState(null, "", url.pathname);

  /** @type {{ csrf?: string, me?: any, anonymousCsrf?: string, identityProvider: boolean }} */
  const session = { identityProvider: false };

  function translatePage() {
    document.documentElement.lang = locale;
    for (const element of document.querySelectorAll("[data-t]")) element.textContent = t(element.getAttribute("data-t"));
    for (const element of document.querySelectorAll("[data-t-aria]")) element.setAttribute("aria-label", t(element.getAttribute("data-t-aria")));
    /** @type {HTMLSelectElement} */ ($("#locale-select")).value = locale;
  }

  function notify(key, level = "success", values = {}) {
    const notice = $("#notice");
    notice.textContent = t(key, values);
    notice.dataset.level = level;
    notice.hidden = false;
  }
  const fail = (error) => {
    // A member with no authenticator cannot answer "enter a code first"; point at enrollment instead.
    if (error instanceof AccountError && error.code === "mfa-required" && session.me && !session.me.mfaEnrolled) {
      notify("error.enroll-first", "error");
      const go = Object.assign(document.createElement("button"), { type: "button", className: "button compact", textContent: t("action.enroll") });
      go.addEventListener("click", () => showEnrollment(false));
      $("#notice").append(" ", go);
      return;
    }
    notify(`error.${error instanceof AccountError && ACCOUNT_MESSAGES.en[`error.${error.code}`] ? error.code : "unknown"}`, "error");
  };

  function show(view) {
    for (const id of ["login", "challenge", "enroll", "recovery", "invite", "reset", "email", "account"]) $(`#view-${id}`).hidden = id !== view;
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, anonymous?: boolean }} [options]
   */
  async function call(path, { method = "GET", body = undefined, anonymous = false } = {}) {
    const headers = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      const csrf = anonymous ? await anonymousCsrf() : session.csrf;
      if (csrf) headers["x-parallax-csrf"] = csrf;
    }
    const response = await fetch(`/api/v1/account${path}`, {
      method, credentials: "same-origin", headers, ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new AccountError(typeof answer.error === "string" ? answer.error : "unknown", response.status);
    return answer;
  }
  async function anonymousCsrf() {
    if (!session.anonymousCsrf) session.anonymousCsrf = (await call("/csrf")).csrf;
    return session.anonymousCsrf;
  }

  /** Everything sensitive this page has held, gone. */
  function forget() {
    session.csrf = undefined; session.me = undefined; session.anonymousCsrf = undefined;
    for (const id of ["#enroll-seed", "#enroll-uri", "#recovery-codes", "#sessions", "#identities", "#members"]) $(id).replaceChildren();
    $("#enroll-secret").hidden = true;
    for (const form of document.querySelectorAll("form")) /** @type {HTMLFormElement} */ (form).reset();
  }
  addEventListener("pagehide", forget);

  function formValues(form) { return Object.fromEntries(new FormData(form).entries()); }
  function onSubmit(selector, handler) {
    $(selector).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try { await handler(formValues(form), form); } catch (error) { fail(error); }
    });
  }
  function onClick(selector, handler) {
    $(selector).addEventListener("click", async () => { try { await handler(); } catch (error) { fail(error); } });
  }
  const when = (ms) => new Date(ms).toLocaleString(locale);

  function signedIn(answer) {
    session.csrf = answer.csrf; session.anonymousCsrf = undefined;
  }
  async function afterLogin(answer) {
    if (answer.mfaRequired) {
      if (answer.enrollmentRequired) showEnrollment(true); else show("challenge");
      return;
    }
    signedIn(answer);
    await loadAccount();
  }

  // ---- sign-in, challenge and enrollment -------------------------------

  let enrollmentForChallenge = false;
  function showEnrollment(forChallenge) {
    enrollmentForChallenge = forChallenge;
    $("#enroll-secret").hidden = true;
    // From a session, the current password is asked for: a session cookie alone cannot attach a factor.
    $("#enroll-password").hidden = forChallenge;
    show("enroll");
  }

  onSubmit("#login-form", async (values, form) => {
    const answer = await call("/login", { method: "POST", body: { email: values.email, password: values.password }, anonymous: true });
    form.reset();
    await afterLogin(answer);
  });
  onSubmit("#forgot-form", async (values, form) => {
    await call("/password/forgot", { method: "POST", body: { email: values.email }, anonymous: true });
    form.reset(); notify("forgot.sent");
  });
  onSubmit("#challenge-form", async (values, form) => {
    const answer = await call("/login/mfa", { method: "POST", body: { otp: values.otp }, anonymous: true });
    form.reset();
    if (answer.mfaRequired) { notify("mfa.recoveryUsed", "warning"); showEnrollment(true); return; }
    await afterLogin(answer);
  });
  onClick("#enroll-start", async () => {
    const passwordInput = /** @type {HTMLInputElement} */ ($("#enroll-password input"));
    if (!enrollmentForChallenge && !passwordInput.value) { notify("enroll.passwordRequired", "error"); return; }
    const answer = enrollmentForChallenge
      ? await call("/mfa/enroll", { method: "POST", anonymous: true })
      : await call("/mfa/enroll", { method: "POST", body: { password: passwordInput.value } });
    passwordInput.value = "";
    $("#enroll-seed").textContent = answer.secretBase32;
    $("#enroll-uri").textContent = answer.otpauthUri;
    $("#enroll-secret").hidden = false;
  });
  onSubmit("#enroll-form", async (values, form) => {
    const answer = await call("/mfa/confirm", { method: "POST", body: { otp: values.otp }, anonymous: enrollmentForChallenge });
    form.reset();
    $("#enroll-seed").replaceChildren(); $("#enroll-uri").replaceChildren(); $("#enroll-secret").hidden = true;
    signedIn(answer);
    showRecoveryCodes(answer.recoveryCodes);
  });
  function showRecoveryCodes(codes) {
    $("#recovery-codes").replaceChildren(...codes.map((code) => Object.assign(document.createElement("li"), { textContent: code })));
    show("recovery");
  }
  onClick("#recovery-done", async () => { $("#recovery-codes").replaceChildren(); await loadAccount(); });

  // ---- mail links -------------------------------------------------------

  onSubmit("#invite-form", async (values, form) => {
    await call("/invite/accept", { method: "POST", anonymous: true, body: { token: linkToken, email: values.email, password: values.password, displayName: values.displayName } });
    form.reset(); notify("invite.done"); show("login");
  });
  onSubmit("#reset-form", async (values, form) => {
    await call("/password/reset", { method: "POST", anonymous: true, body: { token: linkToken, password: values.password } });
    form.reset(); notify("reset.done"); show("login");
  });
  // The link token is gone from the address bar, so the fresh code is asked for here rather than on another page.
  onSubmit("#email-confirm-form", async (values, form) => {
    if (!session.me?.recentMfa) await call("/reauthenticate", { method: "POST", body: { otp: values.otp } });
    await call("/email/confirm", { method: "POST", body: { token: linkToken } });
    form.reset(); forget(); notify("emailConfirm.done"); show("login");
  });

  // ---- the signed-in account -------------------------------------------

  async function loadAccount() {
    let me;
    try { me = await call("/me"); }
    catch (error) {
      if (error instanceof AccountError && (error.status === 401 || error.status === 403)) { show("login"); return; }
      throw error;
    }
    session.me = me; session.csrf = me.csrf;
    $("#logout").hidden = false; $("#dns-link").hidden = false;
    $("#me-name").textContent = me.user.displayName;
    $("#me-email").textContent = me.user.canonicalLoginKey;
    $("#me-role").textContent = t(`role.${me.user.role}`);
    $("#me-mfa").textContent = t(me.recentMfa ? "me.mfaYes" : "me.mfaNo");
    $("#legacy-note").hidden = me.sessionKind !== "legacy";
    $("#enroll-self").hidden = me.mfaEnrolled;
    $("#identity-link").hidden = !session.identityProvider;
    show("account");
    await Promise.all([loadSessions(), loadIdentities(), me.user.role === "admin" ? loadAdmin() : hideAdmin()]);
  }
  function hideAdmin() { $("#admin").hidden = true; }

  async function loadSessions() {
    const sessions = await call("/sessions");
    $("#sessions").replaceChildren(...sessions.map((entry) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = t("sessions.item", { created: when(entry.createdAt), seen: when(entry.lastSeenAt) })
        + (entry.kind === "legacy" ? ` · ${t("sessions.legacy")}` : "") + (entry.current ? ` · ${t("sessions.current")}` : "");
      const end = Object.assign(document.createElement("button"), { type: "button", className: "button compact quiet", textContent: t(entry.current ? "sessions.revokeCurrent" : "sessions.revoke") });
      end.addEventListener("click", async () => {
        // Ending this browser's own session is a sign-out: confirmed, then the same sign-out as the header
        // button, which needs no fresh code and also ends a provider session or a legacy one.
        try {
          if (entry.current) { if (confirm(t("sessions.revokeCurrentConfirm"))) await signOut(); return; }
          await call("/sessions/revoke", { method: "POST", body: { createdAt: entry.createdAt } });
          await loadAccount();
        } catch (error) { fail(error); }
      });
      item.append(label, end); return item;
    }));
  }
  async function loadIdentities() {
    const identities = await call("/identities");
    if (!identities.length) { $("#identities").replaceChildren(Object.assign(document.createElement("li"), { textContent: t("identities.none") })); return; }
    $("#identities").replaceChildren(...identities.map((identity) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${identity.issuer}${identity.kind === "legacy" ? ` (${t("identities.legacy")})` : ""}`;
      const unlink = Object.assign(document.createElement("button"), { type: "button", className: "button compact quiet", textContent: t("identities.unlink") });
      unlink.addEventListener("click", async () => {
        if (!confirm(t("identities.unlinkConfirm", { issuer: identity.issuer }))) return;
        try { await call("/identities/unlink", { method: "POST", body: { issuer: identity.issuer, subject: identity.subject } }); forget(); show("login"); } catch (error) { fail(error); }
      });
      item.append(label, unlink); return item;
    }));
  }

  async function loadAdmin() {
    $("#admin").hidden = false;
    try {
      const policy = await call("/identities/policy");
      const form = /** @type {HTMLFormElement} */ ($("#policy-form"));
      form.elements["issuer"].value = policy.jit[0]?.issuer ?? "";
      form.elements["maxUsers"].value = policy.jit[0] ? String(policy.jit[0].maxUsers) : "";
    } catch (error) { fail(error); }
    let members;
    try { members = await call("/members"); }
    catch (error) {
      if (error instanceof AccountError && error.code === "mfa-required") {
        $("#members").replaceChildren(Object.assign(document.createElement("tr"), { textContent: t("admin.needsVerify") })); return;
      }
      throw error;
    }
    $("#members").replaceChildren(...members.map((member) => memberRow(member)));
  }
  function memberRow(member) {
    const row = document.createElement("tr");
    const cell = (text) => Object.assign(document.createElement("td"), { textContent: text });
    const role = document.createElement("select");
    for (const value of ["viewer", "editor", "admin"]) role.append(Object.assign(document.createElement("option"), { value, textContent: t(`role.${value}`), selected: value === member.role }));
    const roleCell = document.createElement("td"); roleCell.append(role);
    const actions = document.createElement("td");
    const button = (key, handler) => {
      const element = Object.assign(document.createElement("button"), { type: "button", className: "button compact quiet", textContent: t(key) });
      element.addEventListener("click", async () => { try { await handler(); } catch (error) { fail(error); } });
      actions.append(element);
    };
    const change = async (patch, confirmKey, values) => {
      if (!confirm(t(confirmKey, { email: member.canonicalLoginKey, ...values }))) return;
      await call("/members/change", { method: "POST", body: { userId: member.userId, version: member.version, ...patch } });
      notify("admin.changed");
      if (member.userId === session.me?.user.userId) { forget(); show("login"); return; }
      await loadAdmin();
    };
    if (member.status !== "deleted") button("admin.apply", () => change({ role: role.value }, "admin.roleConfirm", { role: t(`role.${role.value}`) }));
    if (member.status === "active") button("admin.suspend", () => change({ status: "suspended" }, "admin.suspendConfirm"));
    if (member.status === "suspended") button("admin.restore", () => change({ status: "active" }, "admin.restoreConfirm"));
    if (member.status !== "deleted") button("admin.delete", () => change({ status: "deleted" }, "admin.deleteConfirm"));
    row.append(cell(member.displayName), cell(member.canonicalLoginKey), roleCell, cell(t(`status.${member.status}`)), actions);
    return row;
  }

  onSubmit("#reauth-form", async (values, form) => {
    await call("/reauthenticate", { method: "POST", body: { otp: values.otp } }); form.reset(); notify("reauth.done"); await loadAccount();
  });
  onClick("#enroll-self", async () => showEnrollment(false));
  onClick("#recovery-new", async () => {
    if (!confirm(t("recovery.replaceConfirm"))) return;
    showRecoveryCodes((await call("/mfa/recovery", { method: "POST" })).recoveryCodes);
  });
  onSubmit("#password-form", async (values, form) => {
    await call("/password/change", { method: "POST", body: { currentPassword: values.currentPassword, password: values.password } });
    form.reset(); forget(); notify("password.done"); show("login");
  });
  onSubmit("#leave-form", async (values, form) => {
    if (!confirm(t("leave.confirm"))) return;
    await call("/delete", { method: "POST", body: { password: values.password } });
    form.reset(); forget(); $("#logout").hidden = true; notify("leave.done"); show("login");
  });
  onSubmit("#email-form", async (values, form) => {
    await call("/email/request", { method: "POST", body: { email: values.email } }); form.reset(); notify("email.sent");
  });
  onClick("#sessions-revoke-all", async () => {
    if (!confirm(t("sessions.revokeAllConfirm"))) return;
    await call("/sessions/revoke", { method: "POST" }); forget(); $("#logout").hidden = true; show("login");
  });
  onClick("#identity-link", async () => {
    const response = await fetch("/auth/link", { method: "POST", credentials: "same-origin", headers: { "x-parallax-csrf": session.csrf ?? "" } });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || typeof answer.url !== "string") throw new AccountError(typeof answer.error === "string" ? answer.error : "unknown", response.status);
    location.assign(answer.url);
  });
  onSubmit("#invite-member-form", async (values, form) => {
    const email = String(values.email), role = String(values.role);
    // An administrator invitation is confirmed here; the server still demands a recent code.
    if (role === "admin" && !confirm(t("admin.inviteAdminConfirm", { email }))) return;
    await call("/members/invite", { method: "POST", body: { email, role } }); form.reset(); notify("admin.invited", "success", { email }); await loadAdmin();
  });
  onSubmit("#policy-form", async (values) => {
    const issuer = String(values.issuer ?? "").trim();
    if (issuer && !values.maxUsers) { notify("policy.maxUsersRequired", "error"); return; }
    const jit = issuer ? [{ issuer, role: "viewer", maxUsers: Number(values.maxUsers) }] : [];
    await call("/identities/policy", { method: "POST", body: { roleSource: values.roleSource, mfaEvidence: values.mfaEvidence, jit } });
    notify("policy.saved");
  });
  /** The one sign-out: through the provider when there is one, so its session ends too. */
  async function signOut() {
    if (session.identityProvider) {
      // Asked for as JSON: a manual redirect's location is unreadable here, so the provider's logout would never run.
      const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "x-parallax-csrf": session.csrf ?? "" } });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new AccountError(typeof answer.error === "string" ? answer.error : "unavailable", response.status);
      forget();
      // Only a provider logout on another origin is followed; otherwise this page shows sign-in itself.
      let target;
      try { target = typeof answer.location === "string" ? new URL(answer.location, location.href) : undefined; } catch { target = undefined; }
      if (target && target.protocol === "https:" && target.origin !== location.origin) { location.assign(target.href); return; }
      $("#logout").hidden = true; show("login"); return;
    }
    await call("/logout", { method: "POST" }); forget(); $("#logout").hidden = true; show("login");
  }
  onClick("#logout", signOut);

  $("#locale-select").addEventListener("change", (event) => {
    locale = /** @type {HTMLSelectElement} */ (event.currentTarget).value === "ko" ? "ko" : "en";
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* A private window keeps the choice for this page only. */ }
    translatePage();
    if (session.me) void loadAccount().catch(fail);
  });

  async function start() {
    translatePage();
    try {
      const health = await (await fetch("/health/live", { credentials: "same-origin" })).json();
      session.identityProvider = health?.identityProvider === "available";
    } catch { session.identityProvider = false; }
    $("#sso-block").hidden = !session.identityProvider;
    const view = viewForPath(location.pathname);
    if (view === "login") {
      if (mfaParameter === "required") show("challenge");
      else if (mfaParameter === "enroll") showEnrollment(true);
      else show("login");
      return;
    }
    if (view === "invite" || view === "reset") { show(view); return; }
    if (view === "email") {
      try { const me = await call("/me"); session.me = me; session.csrf = me.csrf; $("#logout").hidden = false; show("email"); }
      catch { notify("emailConfirm.signIn", "warning"); show("login"); }
      return;
    }
    await loadAccount();
  }
  void start().catch(fail);
}

if (typeof document !== "undefined" && typeof location !== "undefined") startPage();
