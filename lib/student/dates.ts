export function countdown(
  value: Date | string,
  timezone: string,
  now = new Date(),
) {
  const date = new Date(value);
  const day = (v: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(v);
  const days = Math.round(
    (Date.parse(day(date)) - Date.parse(day(now))) / 86400000,
  );
  if (date < now)
    return days === 0
      ? "Earlier today"
      : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`;
}
export function formatDate(value: Date | string, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
export function localInput(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
