export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** For tests and the demo: time only moves when you say so. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: string | Date) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(to: string | Date): void {
    this.t = new Date(to).getTime();
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Local calendar parts for a timezone, using the platform's tz database. */
export function localParts(d: Date, tz: string): { date: string; time: string; weekday: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(hour).padStart(2, '0')}:${p.minute}`, weekday, hour, minute: Number(p.minute) };
}

/** Whole days from a to b (YYYY-MM-DD strings), b - a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY);
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
