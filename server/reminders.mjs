// Claude Code can put <system-reminder> blocks before the user's own words. Shared by the hook (which drops them so
// its clip keeps the real text) and the server (which reads what follows them as the order). No imports: the hook
// loads this on every event.
export const REMINDER = /^<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/;
export function stripReminders(t) { t = String(t ?? '').trimStart(); let m; while ((m = REMINDER.exec(t))) t = t.slice(m[0].length).trimStart(); return t; }
