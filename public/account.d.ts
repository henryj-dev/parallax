export const ACCOUNT_MESSAGES: Readonly<Record<"en" | "ko", Readonly<Record<string, string>>>>;
export function viewForPath(pathname: string): "login" | "invite" | "reset" | "email" | "account";
