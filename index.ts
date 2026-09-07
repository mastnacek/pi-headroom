import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./src/config.js";
import {
  calculateSessionMetrics,
  createSessionBaseline,
  getHeadroomMetrics,
} from "./src/telemetry.js";
import {
  formatDetailedReport,
  formatSessionReport,
  formatStatusline,
} from "./src/statusline.js";
import { registerRetrieveTool } from "./src/retrieve.js";
import { registerProviderRoutes } from "./src/providers/router.js";
import { registerHeadroomCommands } from "./src/commands.js";
import type {
  HeadroomConfig,
  HeadroomMetrics,
  HeadroomSessionBaseline,
} from "./src/types.js";

export default function headroomExtension(pi: ExtensionAPI): void {
  let config: HeadroomConfig = loadConfig(process.cwd());
  let sessionBaseline: HeadroomSessionBaseline | null = null;
  let metrics: HeadroomMetrics = {
    online: false,
    totalRequests: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    savingsPct: 0,
    costSavedUsd: 0,
    schemaTokensSaved: 0,
    messageTokensSaved: 0,
    source: "offline",
    lastChecked: 0,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function computeSession(m: HeadroomMetrics) {
    if (!sessionBaseline) return undefined;
    return calculateSessionMetrics(m, sessionBaseline);
  }

  function resetSession(m: HeadroomMetrics) {
    sessionBaseline = createSessionBaseline(m);
    try {
      pi.appendEntry("headroom-session-baseline", sessionBaseline);
    } catch {
      // Non-fatal append error
    }
  }

  async function refresh(ctx?: ExtensionContext): Promise<void> {
    try {
      metrics = await getHeadroomMetrics(config);
      if (sessionBaseline) {
        metrics.session = calculateSessionMetrics(metrics, sessionBaseline);
      }
      if (ctx?.hasUI) {
        ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
      }
    } catch {
      // Non-fatal probe failure
    }
  }

  function startPolling(ctx?: ExtensionContext): void {
    stopPolling();
    if (config.enabled && config.pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        void refresh(ctx);
      }, config.pollIntervalMs);
    }
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // 1. Session Lifecycle
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    config = loadConfig(ctx.cwd || process.cwd());

    // Restore or initialize session baseline
    let restoredBaseline: HeadroomSessionBaseline | null = null;
    if (ctx.sessionManager?.getEntries) {
      try {
        for (const entry of ctx.sessionManager.getEntries()) {
          if (
            entry.type === "custom" &&
            entry.customType === "headroom-session-baseline"
          ) {
            const data = entry.data as HeadroomSessionBaseline;
            if (data && Number.isFinite(data.startedAt)) {
              restoredBaseline = data;
            }
          }
        }
      } catch {
        // Non-fatal read error
      }
    }

    metrics = await getHeadroomMetrics(config);

    if (restoredBaseline) {
      sessionBaseline = restoredBaseline;
    } else {
      resetSession(metrics);
    }

    if (sessionBaseline) {
      metrics.session = calculateSessionMetrics(metrics, sessionBaseline);
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
    }
    startPolling(ctx);
  });

  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
    await refresh(ctx);
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
  });

  // 2. Register Provider Proxies (Google OAuth, OpenRouter, opencode-go, etc.)
  registerProviderRoutes(pi, () => config);

  // 3. Register CCR headroom_retrieve Tool
  if (config.registerRetrieveTool !== false) {
    registerRetrieveTool(pi, () => config);
  }

  // 4. Register Slash Commands
  registerHeadroomCommands(
    pi,
    () => ({ config, metrics }),
    (newConfig, newMetrics) => {
      config = newConfig;
      metrics = newMetrics;
    },
    computeSession,
    resetSession,
  );

  // 5. Register Custom Agent Tool
  pi.registerTool({
    name: "headroom_status",
    label: "Headroom Status",
    description:
      "Inspect real-time Headroom context-compression metrics, token savings, cost avoided, and proxy status for session and lifetime.",
    promptSnippet:
      "Check Headroom context optimization stats and token savings",
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({
          description: "Force immediate re-probe against Headroom proxy",
        }),
      ),
      scope: Type.Optional(
        Type.Union(
          [
            Type.Literal("session"),
            Type.Literal("lifetime"),
            Type.Literal("both"),
          ],
          {
            description:
              "Scope of metrics to return: session | lifetime | both (default: both)",
          },
        ),
      ),
      detailed: Type.Optional(
        Type.Boolean({
          description: "Return full markdown breakdown instead of summary text",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (params.refresh) {
        metrics = await getHeadroomMetrics(config);
        if (sessionBaseline) {
          metrics.session = calculateSessionMetrics(metrics, sessionBaseline);
        }
      }

      if (params.detailed) {
        const text =
          params.scope === "session"
            ? formatSessionReport(metrics, config)
            : formatDetailedReport(metrics, config);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
          details: metrics,
        };
      }

      if (params.scope === "session" && metrics.session) {
        const s = metrics.session;
        return {
          content: [
            {
              type: "text",
              text: `Headroom [Session]: ${metrics.online ? "Online" : "Offline"} | Savings: ${s.savingsPct.toFixed(1)}% (${s.tokensSaved.toLocaleString()} tokens saved / $${s.costSavedUsd.toFixed(2)}) across ${s.totalRequests} reqs`,
            },
          ],
          details: metrics,
        };
      }

      if (params.scope === "lifetime") {
        return {
          content: [
            {
              type: "text",
              text: `Headroom [Lifetime]: ${metrics.online ? "Online" : "Offline"} | Savings: ${metrics.savingsPct.toFixed(1)}% (${metrics.tokensSaved.toLocaleString()} tokens saved / $${metrics.costSavedUsd.toFixed(2)}) across ${metrics.totalRequests} reqs`,
            },
          ],
          details: metrics,
        };
      }

      const sessionStr = metrics.session
        ? `Session: ${metrics.session.savingsPct.toFixed(1)}% (-${metrics.session.tokensSaved.toLocaleString()} tok · $${metrics.session.costSavedUsd.toFixed(2)}) | `
        : "";

      return {
        content: [
          {
            type: "text",
            text: `Headroom: ${metrics.online ? "Online" : "Offline"} | ${sessionStr}Lifetime: ${metrics.savingsPct.toFixed(1)}% (-${metrics.tokensSaved.toLocaleString()} tok · $${metrics.costSavedUsd.toFixed(2)})`,
          },
        ],
        details: metrics,
      };
    },
  });
}
