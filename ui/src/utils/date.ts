const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dtf = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const dtfWithYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const dtfFull = new Intl.DateTimeFormat("en", {
  month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit",
});

/** Convert a timestamp (unix seconds or ms) to milliseconds. */
function toMs(ts: number): number {
  if (!ts) return 0;
  // Unix seconds are < ~2 billion; milliseconds are > ~1 trillion
  return ts < 1e11 ? ts * 1000 : ts;
}

export function relativeTime(ts: number): string {
  const ms = toMs(ts);
  const now = Date.now();
  const diff = ms - now;
  const absDiff = Math.abs(diff);

  if (absDiff < 60_000) return "just now";
  if (absDiff < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (absDiff < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (absDiff < 604_800_000) return rtf.format(Math.round(diff / 86_400_000), "day");

  const emailYear = new Date(ms).getFullYear();
  const currentYear = new Date().getFullYear();
  return emailYear !== currentYear ? dtfWithYear.format(ms) : dtf.format(ms);
}

export function fullDate(ts: number): string {
  return dtfFull.format(toMs(ts));
}

export function isToday(ts: number): boolean {
  const d = new Date(toMs(ts));
  const now = new Date();
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

export function timeOnly(ts: number): string {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(toMs(ts));
}
