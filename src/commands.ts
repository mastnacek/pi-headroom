import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { exec } from "child_process";
import { saveConfig } from "./config.js";
import { getHeadroomMetrics } from "./telemetry.js";
import {
  formatDetailedReport,
  formatSessionReport,
  formatStatusline,
  ANSI_BOLD,
  ANSI_CYAN,
  ANSI_GREEN,
  ANSI_DIM,
  ANSI_RESET,
} from "./statusline.js";
import type {
  HeadroomConfig,
  HeadroomMetrics,
  HeadroomSessionMetrics,
} from "./types.js";

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

const COMMAND_DOCS = {
  session: "show context reduction and savings for current session only",
  status: "display detailed headroom metrics, active routes, and uptime",
  savings: "show token reduction and cost savings breakdown",
  route: "configure provider proxy routing (google | openrouter | openai | anthropic | moonshotai)",
  scope: "switch statusline badge scope (session | lifetime)",
  "reset-session": "reset session baseline counter to now",
  dashboard: "open Headroom web dashboard in browser",
  refresh: "force immediate stats probe and update statusline",
  on: "enable statusline badge display",
  off: "disable statusline badge display",
  format: "set statusline format (compact | normal | detailed)",
  port: "configure proxy port (default: 8787)",
  help: "display command reference and help banner",
} as const;

export function buildHelpText(
  config: HeadroomConfig,
  metrics: HeadroomMetrics,
): string {
  const statusBadge = metrics.online
    ? `${ANSI_BOLD}${ANSI_GREEN}● Online${ANSI_RESET} (:${config.port})`
    : `${ANSI_BOLD}${ANSI_DIM}○ Offline${ANSI_RESET}`;

  const enabledBadge = config.enabled
    ? `${ANSI_BOLD}${ANSI_GREEN}● Enabled${ANSI_RESET}`
    : `${ANSI_BOLD}${ANSI_DIM}○ Disabled${ANSI_RESET}`;

  const sessionSaved = metrics.session?.tokensSaved ?? 0;
  const sessionPct = (metrics.session?.savingsPct ?? 0).toFixed(1);
  const sessionCost = (metrics.session?.costSavedUsd ?? 0).toFixed(2);

  const activeRoutes = Object.entries(config.routes)
    .filter(([_, enabled]) => enabled)
    .map(([name]) => name);

  return [
    `${ANSI_BOLD}${ANSI_CYAN}⚡ pi-headroom${ANSI_RESET} — Unified Context Optimization & Provider Routing Suite`,
    `Real-time Headroom proxy compression, multi-provider routing (Google OAuth, OpenRouter), and statusline.`,
    ``,
    `${ANSI_BOLD}Commands & Subcommands:${ANSI_RESET}`,
    `  /headroom session                        — show savings for active Pi session`,
    `  /headroom status                         — show full metrics, active routes & lifetime report`,
    `  /headroom savings                        — view token savings & cost breakdown`,
    `  /headroom route <provider> on|off        — toggle routing (google | openrouter | openai | anthropic | moonshotai)`,
    `  /headroom scope <session|lifetime>       — switch badge scope (current: ${config.scope})`,
    `  /headroom reset-session                  — reset session baseline counter to now`,
    `  /headroom dashboard                      — open web dashboard (http://${config.host}:${config.port}/dashboard)`,
    `  /headroom refresh                        — force immediate stats probe & statusline update`,
    `  /headroom on | off                       — toggle statusline footer display (${enabledBadge})`,
    `  /headroom format <type>                  — set badge format (compact | normal | detailed)`,
    `  /headroom port <number>                  — set proxy port (current: ${config.port})`,
    `  /headroom help                           — display this reference guide`,
    ``,
    `${ANSI_DIM}Tip: Append --global to any setting command to persist across all sessions.${ANSI_RESET}`,
    ``,
    `${ANSI_BOLD}Current Runtime Overview:${ANSI_RESET}`,
    `  • Proxy: ${statusBadge} | Statusline: ${enabledBadge} | Scope: ${ANSI_BOLD}${ANSI_CYAN}${config.scope}${ANSI_RESET} | Format: ${ANSI_BOLD}${ANSI_CYAN}${config.format}${ANSI_RESET}`,
    `  • Active Routes: ${activeRoutes.length > 0 ? activeRoutes.map((r) => `${ANSI_GREEN}${r}${ANSI_RESET}`).join(", ") : `${ANSI_DIM}none${ANSI_RESET}`}`,
    `  • Session Savings: ${ANSI_BOLD}${ANSI_GREEN}${sessionPct}%${ANSI_RESET} (${sessionSaved.toLocaleString()} tokens · $${sessionCost})`,
    `  • Lifetime Savings: ${ANSI_BOLD}${ANSI_GREEN}${metrics.savingsPct.toFixed(1)}%${ANSI_RESET} (${metrics.tokensSaved.toLocaleString()} tokens · $${metrics.costSavedUsd.toFixed(2)})`,
  ].join("\n");
}

export function openDashboard(host: string, port: number): void {
  const url = `http://${host}:${port}/dashboard`;
  let startCmd = `xdg-open "${url}"`;
  if (process.platform === "win32") {
    startCmd = `start "" "${url}"`;
  } else if (process.platform === "darwin") {
    startCmd = `open "${url}"`;
  }

  exec(startCmd);
}

export function registerHeadroomCommands(
  pi: ExtensionAPI,
  getState: () => { config: HeadroomConfig; metrics: HeadroomMetrics },
  updateState: (config: HeadroomConfig, metrics: HeadroomMetrics) => void,
  computeSession?: (
    lifetime: HeadroomMetrics,
  ) => HeadroomSessionMetrics | undefined,
  resetSession?: (lifetime: HeadroomMetrics) => void,
): void {
  const getCompletions = async (
    prefix: string,
  ): Promise<AutocompleteItem[] | null> => {
    const tokens = prefix.split(/\s+/).filter(Boolean);
    const trailingSpace = /\s$/.test(prefix);
    const normalizedPrefix = tokens.join(" ").toLowerCase();

    // 2nd / 3rd Token Completion
    if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
      const cmd = tokens[0]?.toLowerCase();

      if (cmd === "format") {
        const formats = [
          {
            value: "format compact",
            label: "format compact",
            description: "Minimal percentage badge",
          },
          {
            value: "format normal",
            label: "format normal",
            description: "Standard percentage and token diff",
          },
          {
            value: "format detailed",
            label: "format detailed",
            description: "Full badge with version & requests",
          },
        ];
        const filtered = formats.filter((i) =>
          i.value.toLowerCase().startsWith(normalizedPrefix),
        );
        return filtered.length > 0 ? filtered : null;
      }

      if (cmd === "scope") {
        const scopes = [
          {
            value: "scope session",
            label: "scope session",
            description: "Show token savings for current Pi session",
          },
          {
            value: "scope lifetime",
            label: "scope lifetime",
            description: "Show total lifetime proxy savings",
          },
        ];
        const filtered = scopes.filter((i) =>
          i.value.toLowerCase().startsWith(normalizedPrefix),
        );
        return filtered.length > 0 ? filtered : null;
      }

      if (cmd === "route") {
        const providers = [
          "google",
          "openrouter",
          "opencode-go",
          "openai",
          "anthropic",
          "moonshotai",
        ];
        const items: AutocompleteItem[] = [];
        for (const p of providers) {
          items.push(
            {
              value: `route ${p} on`,
              label: `route ${p} on`,
              description: `Route ${p} through Headroom proxy`,
            },
            {
              value: `route ${p} off`,
              label: `route ${p} off`,
              description: `Disable Headroom routing for ${p}`,
            },
          );
        }
        const filtered = items.filter((i) =>
          i.value.toLowerCase().startsWith(normalizedPrefix),
        );
        return filtered.length > 0 ? filtered : null;
      }

      if (
        [
          "on",
          "off",
          "refresh",
          "dashboard",
          "status",
          "savings",
          "session",
          "reset-session",
        ].includes(cmd || "")
      ) {
        const flags = [
          {
            value: `${cmd} --global`,
            label: `${cmd} --global`,
            description: "Apply setting globally for all sessions",
          },
        ];
        const filtered = flags.filter((i) =>
          i.value.toLowerCase().startsWith(normalizedPrefix),
        );
        return filtered.length > 0 ? filtered : null;
      }

      return null;
    }

    // 1st Token Completion (Subcommands from Dictionary)
    const typed = (tokens[0] ?? "").toLowerCase();
    const items: AutocompleteItem[] = [];
    for (const [value, description] of Object.entries(COMMAND_DOCS)) {
      if (value.toLowerCase().startsWith(typed)) {
        items.push({ value, label: value, description });
      }
    }

    return items.length > 0 ? items : null;
  };

  const commandHandler = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const trimmed = args.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
    const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");

    const subcommand = (cleanTokens[0] ?? "").toLowerCase();
    const rest = cleanTokens.slice(1);
    const value = rest.join(" ").trim();

    let { config, metrics } = getState();

    // Help banner (default on empty or help)
    if (!subcommand || ["help", "-h", "--help"].includes(subcommand)) {
      metrics = await getHeadroomMetrics(config);
      if (computeSession) metrics.session = computeSession(metrics);
      updateState(config, metrics);
      ctx.ui.notify(buildHelpText(config, metrics), "info");
      return;
    }

    switch (subcommand) {
      case "session": {
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        ctx.ui.notify(formatSessionReport(metrics, config), "info");
        break;
      }

      case "reset-session": {
        metrics = await getHeadroomMetrics(config);
        if (resetSession) resetSession(metrics);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
        }
        ctx.ui.notify(
          "⚡ Headroom session baseline reset to current moment.",
          "info",
        );
        break;
      }

      case "status":
      case "savings": {
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        ctx.ui.notify(formatDetailedReport(metrics, config), "info");
        break;
      }

      case "route": {
        const provider = (rest[0] ?? "").toLowerCase();
        const action = (rest[1] ?? "").toLowerCase();

        if (!provider || !action || !["on", "off", "enable", "disable"].includes(action)) {
          ctx.ui.notify(
            "Usage: /headroom route <google|openrouter|openai|anthropic|moonshotai> on|off [--global]",
            "warning",
          );
          return;
        }

        const isEnable = action === "on" || action === "enable";
        const updatedRoutes = {
          ...config.routes,
          [provider]: isEnable,
        };

        config = saveConfig(ctx.cwd, { routes: updatedRoutes }, isGlobal);
        updateState(config, metrics);
        ctx.ui.notify(
          `⚡ Headroom route for "${provider}" turned ${isEnable ? "ON" : "OFF"}${isGlobal ? " (globally)" : ""}.`,
          "info",
        );
        break;
      }

      case "dashboard": {
        openDashboard(config.host, config.port);
        ctx.ui.notify(
          `Opening Headroom dashboard at http://${config.host}:${config.port}/dashboard ...`,
          "info",
        );
        break;
      }

      case "refresh": {
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
        }
        const activePct =
          config.scope === "session" && metrics.session
            ? metrics.session.savingsPct
            : metrics.savingsPct;
        const activeTokens =
          config.scope === "session" && metrics.session
            ? metrics.session.tokensSaved
            : metrics.tokensSaved;
        ctx.ui.notify(
          `⚡ Headroom stats refreshed: ${activePct.toFixed(1)}% savings (${activeTokens.toLocaleString()} tokens saved)`,
          "info",
        );
        break;
      }

      case "scope": {
        if (value !== "session" && value !== "lifetime") {
          ctx.ui.notify(
            `Invalid scope "${value}". Choose: session | lifetime`,
            "warning",
          );
          return;
        }
        config = saveConfig(ctx.cwd, { scope: value }, isGlobal);
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
        }
        ctx.ui.notify(
          `⚡ Headroom statusline scope set to "${value}"${isGlobal ? " (globally)" : ""}.`,
          "info",
        );
        break;
      }

      case "on": {
        config = saveConfig(ctx.cwd, { enabled: true }, isGlobal);
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
        }
        ctx.ui.notify(
          `⚡ Headroom statusline enabled${isGlobal ? " (globally)" : ""}.`,
          "info",
        );
        break;
      }

      case "off": {
        config = saveConfig(ctx.cwd, { enabled: false }, isGlobal);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", "");
        }
        ctx.ui.notify(
          `⚡ Headroom statusline disabled${isGlobal ? " (globally)" : ""}.`,
          "info",
        );
        break;
      }

      case "format": {
        if (value !== "compact" && value !== "normal" && value !== "detailed") {
          ctx.ui.notify(
            `Invalid format "${value}". Choose: compact | normal | detailed`,
            "warning",
          );
          return;
        }
        config = saveConfig(ctx.cwd, { format: value }, isGlobal);
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
        }
        ctx.ui.notify(
          `Format set to "${value}"${isGlobal ? " (globally)" : ""}.`,
          "info",
        );
        break;
      }

      case "port": {
        const portNum = parseInt(value, 10);
        if (Number.isNaN(portNum) || portNum <= 0 || portNum > 65535) {
          ctx.ui.notify(
            `Invalid port "${value}". Must be a number between 1 and 65535.`,
            "warning",
          );
          return;
        }
        config = saveConfig(ctx.cwd, { port: portNum }, isGlobal);
        metrics = await getHeadroomMetrics(config);
        if (computeSession) metrics.session = computeSession(metrics);
        updateState(config, metrics);
        if (ctx.hasUI) {
          ctx.ui.setStatus("headroom", formatStatusline(metrics, config));
        }
        ctx.ui.notify(
          `Headroom port set to ${portNum}${isGlobal ? " (globally)" : ""}.`,
          "info",
        );
        break;
      }

      default:
        ctx.ui.notify(
          `Unknown subcommand "${subcommand}". Use: /headroom help`,
          "warning",
        );
        break;
    }
  };

  pi.registerCommand("headroom", {
    description: "Manage Headroom context optimization, provider routing, and statusline",
    getArgumentCompletions: getCompletions,
    handler: commandHandler,
  });
}
