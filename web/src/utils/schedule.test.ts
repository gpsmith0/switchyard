import { describe, it, expect } from "vitest";
import { humanizeCron, describeTrigger, formatRelative, SCHEDULE_PRESETS } from "./schedule.js";

describe("humanizeCron", () => {
  it("renders every preset as a readable phrase, never the raw expression", () => {
    // Validates: whatever the presets list offers, the row label is human text.
    for (const preset of SCHEDULE_PRESETS) {
      expect(humanizeCron(preset.value)).not.toBe(preset.value);
    }
    expect(humanizeCron("0 * * * *")).toBe("Every hour");
    expect(humanizeCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(humanizeCron("0 8 * * *")).toBe("Daily at 8am");
    expect(humanizeCron("30 14 * * *")).toBe("Daily at 2:30pm");
    expect(humanizeCron("0 9 * * 1-5")).toBe("Weekdays at 9am");
    expect(humanizeCron("0 9 * * 1")).toBe("Mondays at 9am");
    expect(humanizeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanizeCron("0 0 1 * *")).toBe("Monthly on day 1 at 12am");
  });

  it("falls back to the raw expression for shapes it does not understand", () => {
    expect(humanizeCron("0 8 * * 1,3,5")).toBe("0 8 * * 1,3,5");
    expect(humanizeCron("not a cron")).toBe("not a cron");
  });
});

describe("describeTrigger", () => {
  it("labels manual, one-shot, and recurring automations", () => {
    expect(describeTrigger({ trigger: "manual", recurring: true, schedule: "0 8 * * *" })).toBe("Manual");
    expect(describeTrigger({ recurring: true, schedule: "0 8 * * *" })).toBe("Daily at 8am");
    expect(describeTrigger({ recurring: false, schedule: "garbage" })).toBe("Once");
    expect(describeTrigger({ recurring: false, schedule: "2030-01-02T09:00:00.000Z" })).toMatch(/^Once · /);
  });
});

describe("formatRelative", () => {
  it("formats future and past times symmetrically", () => {
    const now = 1_800_000_000_000;
    expect(formatRelative(now + 30_000, now)).toBe("in under a minute");
    expect(formatRelative(now - 30_000, now)).toBe("just now");
    expect(formatRelative(now + 5 * 60_000, now)).toBe("in 5m");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelative(now + 2 * 86_400_000, now)).toBe("in 2d");
  });
});
