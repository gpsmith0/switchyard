import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_SWITCHYARD_CODEX_HOME,
  getLegacyCodexHome,
  resolveSwitchyardCodexHome,
  resolveSwitchyardCodexSessionHome,
} from "./codex-home.js";

describe("codex-home", () => {
  it("DEFAULT_SWITCHYARD_CODEX_HOME points to ~/.switchyard/codex-home", () => {
    expect(DEFAULT_SWITCHYARD_CODEX_HOME).toBe(
      join(homedir(), ".switchyard", "codex-home"),
    );
  });

  it("getLegacyCodexHome returns ~/.codex", () => {
    expect(getLegacyCodexHome()).toBe(join(homedir(), ".codex"));
  });

  it("resolveSwitchyardCodexHome returns default when no explicit path given", () => {
    expect(resolveSwitchyardCodexHome()).toBe(DEFAULT_SWITCHYARD_CODEX_HOME);
  });

  it("resolveSwitchyardCodexHome uses explicit path when provided", () => {
    const custom = "/tmp/my-codex-home";
    expect(resolveSwitchyardCodexHome(custom)).toBe(custom);
  });

  // Regression: resolveSwitchyardCodexHome must NOT read process.env.CODEX_HOME
  // because that points to the user's global ~/.codex and would break per-session isolation.
  it("resolveSwitchyardCodexHome ignores process.env.CODEX_HOME", () => {
    const original = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/tmp/global-codex";
      expect(resolveSwitchyardCodexHome()).toBe(DEFAULT_SWITCHYARD_CODEX_HOME);
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("resolveSwitchyardCodexSessionHome appends sessionId to base", () => {
    const sessionId = "abc-123";
    expect(resolveSwitchyardCodexSessionHome(sessionId)).toBe(
      join(DEFAULT_SWITCHYARD_CODEX_HOME, sessionId),
    );
  });

  it("resolveSwitchyardCodexSessionHome uses explicit path", () => {
    const custom = "/tmp/my-codex-home";
    const sessionId = "xyz-789";
    expect(resolveSwitchyardCodexSessionHome(sessionId, custom)).toBe(
      join(custom, sessionId),
    );
  });
});
