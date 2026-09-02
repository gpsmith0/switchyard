/**
 * Schedule helpers for the Automations page — presets and a small
 * human-readable formatter for the 5-field cron expressions we generate.
 */

export interface SchedulePreset {
  label: string;
  value: string;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 2 hours", value: "0 */2 * * *" },
  { label: "Daily at 8am", value: "0 8 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Nightly at 2am", value: "0 2 * * *" },
  { label: "Mondays at 9am", value: "0 9 * * 1" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(hour: string, minute: string): string {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return `${hour}:${minute}`;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

/** Turn a cron expression into a short phrase; falls back to the raw expression. */
export function humanizeCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [minute, hour, dom, month, dow] = parts;

  if (schedule.trim() === "* * * * *") return "Every minute";

  if (hour === "*" && dom === "*" && month === "*" && dow === "*" && minute.startsWith("*/")) {
    const n = Number(minute.slice(2));
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }
  if (dom === "*" && month === "*" && dow === "*" && /^\d+$/.test(minute)) {
    if (hour === "*") return minute === "0" ? "Every hour" : `Hourly at :${minute.padStart(2, "0")}`;
    if (hour.startsWith("*/")) return `Every ${Number(hour.slice(2))} hours`;
    if (/^\d+$/.test(hour)) return `Daily at ${formatTime(hour, minute)}`;
  }
  if (dom === "*" && month === "*" && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    if (dow === "1-5") return `Weekdays at ${formatTime(hour, minute)}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${formatTime(hour, minute)}`;
    if (/^\d$/.test(dow)) return `${DAY_NAMES[Number(dow)]}s at ${formatTime(hour, minute)}`;
  }
  if (month === "*" && dow === "*" && /^\d+$/.test(dom) && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return `Monthly on day ${dom} at ${formatTime(hour, minute)}`;
  }
  return schedule;
}

/** Describe an automation's trigger for list rows. */
export function describeTrigger(job: { trigger?: "schedule" | "manual"; recurring: boolean; schedule: string }): string {
  if (job.trigger === "manual") return "Manual";
  if (!job.recurring) {
    const d = new Date(job.schedule);
    return Number.isNaN(d.getTime()) ? "Once" : `Once · ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
  return humanizeCron(job.schedule);
}

export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60_000);
  const label = mins < 1
    ? "under a minute"
    : mins < 60
    ? `${mins}m`
    : mins < 24 * 60
    ? `${Math.floor(mins / 60)}h`
    : `${Math.floor(mins / (24 * 60))}d`;
  if (mins < 1) return diff >= 0 ? "in under a minute" : "just now";
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}
