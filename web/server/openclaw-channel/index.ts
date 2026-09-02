/**
 * Switchyard Channel Plugin for OpenClaw
 *
 * When installed in OpenClaw (~/.openclaw/extensions/switchyard/),
 * this plugin:
 * 1. Registers a "Switchyard" channel in OpenClaw's channel list
 * 2. Routes messages between OpenClaw agents and Switchyard's browser UI
 * 3. Exposes an HTTP webhook route for inbound messages from Switchyard
 *
 * Install: Copy this directory to ~/.openclaw/extensions/switchyard/
 *   or: npm install @switchyard/openclaw-channel
 */

import type { OpenClawPluginApi, HttpRouteHandler } from "./types.js";
import { switchyardPlugin, handleSwitchyardWebhook, getActiveAccounts } from "./channel.js";

const webhookHandler: HttpRouteHandler = async (req) => {
  if (req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "Method not allowed" } };
  }

  const body = req.body as {
    accountId?: string;
    senderId?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  };

  if (!body.accountId || !body.text) {
    return {
      status: 400,
      body: { ok: false, error: "accountId and text are required" },
    };
  }

  const result = handleSwitchyardWebhook({
    accountId: body.accountId,
    senderId: body.senderId || "switchyard-user",
    text: body.text,
    metadata: body.metadata,
  });

  return {
    status: result.ok ? 200 : 404,
    body: result,
  };
};

export default {
  id: "switchyard",
  name: "Switchyard",
  description: "Rich web UI for OpenClaw agents with cost tracking, session replay, and collaboration",

  register(api: OpenClawPluginApi) {
    // Register the Switchyard channel with OpenClaw
    api.registerChannel({ plugin: switchyardPlugin });

    // Register the inbound webhook route for Switchyard → OpenClaw messages
    api.registerHttpRoute({
      path: "/webhook/switchyard",
      handler: webhookHandler,
    });
  },
};

// Re-export for direct usage
export { switchyardPlugin, handleSwitchyardWebhook, getActiveAccounts };
export type { OpenClawPluginApi } from "./types.js";
