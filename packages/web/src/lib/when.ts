/**
 * Times you choose, in your own time zone (Amendment 111).
 *
 * A `<input type="datetime-local">` reads and writes `YYYY-MM-DDTHH:mm` with no zone: the
 * browser's own local time. The daemon is sent an ISO instant, so a pause or a message
 * happens at the moment you meant whatever zone the daemon's machine is in. Shown back in
 * local time again, with the zone's short name, so "18:00" can't be mistaken for UTC.
 *
 * Pure, given `now`, so verify can check every case without a clock.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** A date as `datetime-local` wants it, in local time. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value as an ISO instant, or null when it isn't one. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(value)) return null;
  const t = new Date(value).getTime(); // no zone in the string: local time
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The next whole hour after `now`, at least 30 minutes away: what a picker starts on. */
export function nextHour(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + (now.getMinutes() >= 30 ? 2 : 1));
  return d;
}

/** 9:00 tomorrow, local. */
export function tomorrowMorning(now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** The zone's short name where the browser has one (`EDT`), else the offset (`GMT-4`). */
function zoneName(d: Date): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * An instant in local time, as short as it can be: `18:00 EDT` today, `tomorrow 09:00 EDT`,
 * `Fri 9 Oct 18:00 EDT` otherwise, with the year when it isn't this one.
 */
export function fmtWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const zone = zoneName(d);
  const tail = zone ? `${time} ${zone}` : time;
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return tail;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day(d) === day(tomorrow)) return `tomorrow ${tail}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const date = d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${weekday} ${date} ${tail}`;
}

/** Why a chosen local time can't be used, or null. The daemon refuses the same (session/schedule.ts). */
export function whenProblem(value: string, now: Date = new Date()): string | null {
  const iso = fromLocalInput(value);
  if (!iso) return 'choose a date and time';
  const t = Date.parse(iso);
  if (t <= now.getTime()) return 'that time has passed';
  if (t > now.getTime() + 366 * 24 * 60 * 60 * 1000) return 'more than a year ahead';
  return null;
}

/** How long until an instant, roughly: `in 3 h 20 min`, `in 2 days`. */
export function fmtIn(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'in under a minute';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 === 0 ? `in ${h} h` : `in ${h} h ${min % 60} min`;
  return `in ${Math.round(h / 24)} days`;
}
