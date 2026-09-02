/**
 * Switchyard channel plugin for OpenClaw.
 *
 * This plugin enables OpenClaw users to interact with their agents
 * through Switchyard's rich web UI — with cost tracking, session replay,
 * permission voting, session gallery, and collaboration features
 * that OpenClaw's native UI doesn't have.
 *
 * Architecture:
 *   Browser (Switchyard React UI)
 *       ↕ WebSocket
 *   Switchyard Server (Hono/Bun)
 *       ↕ HTTP webhook + outbound API
 *   OpenClaw Gateway
 *       ↕ Agent runtime
 *   AI Agent (Claude, GPT, Gemini, etc.)
 */

import type {
  ChannelPlugin,
  InboundMessage,
} from "./types.js";

// ─── Active account tracking ────────────────────────────────────────────────

interface ActiveAccount {
  accountId: string;
  switchyardUrl: string;
  onMessage: (msg: InboundMessage) => void;
}

const activeAccounts = new Map<string, ActiveAccount>();

// ─── Channel Plugin implementation ─────────────────────────────────────────

export const switchyardPlugin: ChannelPlugin = {
  meta: {
    id: "switchyard",
    label: "Switchyard",
    icon: "🔥",
    docsPath: "/channels/switchyard",
    blurb: "Rich web UI with cost tracking, session replay, and collaboration",
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },

  config: {
    fields: [
      {
        key: "switchyardUrl",
        label: "Switchyard Server URL",
        type: "url",
        required: true,
        placeholder: "http://localhost:4567",
        help: "The URL of your running Switchyard server",
      },
      {
        key: "switchyardPort",
        label: "Switchyard Port",
        type: "number",
        required: false,
        placeholder: "4567",
        help: "Port number (default: 4567)",
      },
    ],

    validate(values: Record<string, string>): { valid: boolean; error?: string } {
      const url = values.switchyardUrl;
      if (!url) {
        return { valid: false, error: "Switchyard Server URL is required" };
      }
      try {
        new URL(url);
        return { valid: true };
      } catch {
        return { valid: false, error: "Invalid URL format" };
      }
    },
  },

  outbound: {
    /**
     * Send a text message from the OpenClaw agent to Switchyard.
     * Posts to Switchyard's inbound webhook endpoint.
     */
    async sendText(opts: {
      accountId: string;
      recipientId: string;
      text: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ success: boolean; error?: string }> {
      const account = activeAccounts.get(opts.accountId);
      if (!account) {
        return { success: false, error: `Account ${opts.accountId} is not active` };
      }

      try {
        const res = await fetch(`${account.switchyardUrl}/api/openclaw/inbound`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            senderId: "openclaw-agent",
            sessionId: opts.recipientId,
            text: opts.text,
            metadata: opts.metadata,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "unknown error");
          return { success: false, error: `HTTP ${res.status}: ${body}` };
        }

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },

  gateway: {
    /**
     * Start an account: register with Switchyard for inbound messages.
     * When a user sends a message in Switchyard, Switchyard will POST
     * to the OpenClaw webhook to route it to the agent.
     */
    async startAccount(opts: {
      accountId: string;
      config: Record<string, string>;
      onMessage: (msg: InboundMessage) => void;
    }): Promise<void> {
      const switchyardUrl = opts.config.switchyardUrl || "http://localhost:4567";

      activeAccounts.set(opts.accountId, {
        accountId: opts.accountId,
        switchyardUrl,
        onMessage: opts.onMessage,
      });

      console.log(`[switchyard-channel] Started account ${opts.accountId} → ${switchyardUrl}`);
    },

    /**
     * Stop an account: unregister from Switchyard.
     */
    async stopAccount(accountId: string): Promise<void> {
      activeAccounts.delete(accountId);
      console.log(`[switchyard-channel] Stopped account ${accountId}`);
    },
  },
};

/**
 * Handle an inbound webhook from Switchyard.
 * Called when a user sends a message in the Switchyard UI
 * and it needs to be routed to the OpenClaw agent.
 */
export function handleSwitchyardWebhook(body: {
  accountId: string;
  senderId: string;
  text: string;
  metadata?: Record<string, unknown>;
}): { ok: boolean; error?: string } {
  const account = activeAccounts.get(body.accountId);
  if (!account) {
    return { ok: false, error: `Account ${body.accountId} not found` };
  }

  account.onMessage({
    senderId: body.senderId,
    text: body.text,
    metadata: body.metadata,
  });

  return { ok: true };
}

/** Get the list of active account IDs (for status checking). */
export function getActiveAccounts(): string[] {
  return Array.from(activeAccounts.keys());
}
