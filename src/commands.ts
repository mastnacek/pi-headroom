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
  session: "zobrazit úsporu kontextu a tokenů pro aktuální relaci",
  status: "zobrazit detailní metriky Headroom, aktivní směrování a uptime",
  savings: "zobrazit detailní rozpis úspory tokenů (schémata vs komprese zpráv)",
  route: "nastavit proxy směrování poskytovatelů (google | openrouter | openai | anthropic | moonshotai)",
  scope: "přepnout rozsah zobrazení ve statusline (session | lifetime)",
  "reset-session": "vynulovat výchozí stav relace na aktuální okamžik",
  dashboard: "otevřít webový dashboard Headroom v prohlížeči",
  refresh: "vynutit okamžitý dotaz na metriky a aktualizovat statusline",
  on: "zapnout zobrazení štítku v patičce (statusline)",
  off: "vypnout zobrazení štítku v patičce (statusline)",
  format: "nastavit formát štítku (compact | normal | detailed)",
  port: "nastavit port Headroom proxy (výchozí: 8787)",
  help: "zobrazit přehled příkazů a nápovědu",
} as const;

export function buildHelpText(
  config: HeadroomConfig,
  metrics: HeadroomMetrics,
): string {
  const statusBadge = metrics.online
    ? `${ANSI_BOLD}${ANSI_GREEN}● Online${ANSI_RESET} (:${config.port})`
    : `${ANSI_BOLD}${ANSI_DIM}○ Offline${ANSI_RESET}`;

  const enabledBadge = config.enabled
    ? `${ANSI_BOLD}${ANSI_GREEN}● Zapnuto${ANSI_RESET}`
    : `${ANSI_BOLD}${ANSI_DIM}○ Vypnuto${ANSI_RESET}`;

  const sessionSaved = metrics.session?.tokensSaved ?? 0;
  const sessionPct = (metrics.session?.savingsPct ?? 0).toFixed(1);
  const sessionCost = (metrics.session?.costSavedUsd ?? 0).toFixed(2);

  const activeRoutes = Object.entries(config.routes)
    .filter(([_, enabled]) => enabled)
    .map(([name]) => name);

  return [
    `${ANSI_BOLD}${ANSI_CYAN}⚡ /headroom${ANSI_RESET} — Správa optimalizace kontextu a směrování poskytovatelů`,
    `Optimalizace a komprese kontextu v reálném čase přes Headroom proxy s podporou Google OAuth a OpenRouter.`,
    ``,
    `${ANSI_BOLD}Příkazy & Podpříkazy:${ANSI_RESET}`,
    `  /headroom session                        — zobrazit úsporu pro aktuální relaci Pi`,
    `  /headroom status                         — zobrazit plný stav, aktivní trasy a statistiky`,
    `  /headroom savings                        — detailní rozpis úspory tokenů a nákladů`,
    `  /headroom route <poskytovatel> on|off    — přepnout směrování (google | openrouter | openai | anthropic | moonshotai)`,
    `  /headroom scope <session|lifetime>       — přepnout rozsah statusline (aktuálně: ${config.scope})`,
    `  /headroom reset-session                  — vynulovat počítadlo relace na aktuální stav`,
    `  /headroom dashboard                      — otevřít webový dashboard (http://${config.host}:${config.port}/dashboard)`,
    `  /headroom refresh                        — vynutit aktualizaci stavu a statusline`,
    `  /headroom on | off                       — zapnout / vypnout zobrazení v patičce (${enabledBadge})`,
    `  /headroom format <typ>                   — nastavit styl zobrazení (compact | normal | detailed)`,
    `  /headroom port <číslo>                   — nastavit port proxy (aktuálně: ${config.port})`,
    `  /headroom help                           — zobrazit tuto nápovědu`,
    ``,
    `${ANSI_DIM}Tip: Přidejte --global k jakémukoli příkazu pro trvalé uložení do ~/.pi/agent/headroom.json.${ANSI_RESET}`,
    ``,
    `${ANSI_BOLD}Aktuální stav systému:${ANSI_RESET}`,
    `  • Proxy: ${statusBadge} | Statusline: ${enabledBadge} | Rozsah: ${ANSI_BOLD}${ANSI_CYAN}${config.scope}${ANSI_RESET} | Formát: ${ANSI_BOLD}${ANSI_CYAN}${config.format}${ANSI_RESET}`,
    `  • Aktivní trasy: ${activeRoutes.length > 0 ? activeRoutes.map((r) => `${ANSI_GREEN}${r}${ANSI_RESET}`).join(", ") : `${ANSI_DIM}žádné${ANSI_RESET}`}`,
    `  • Úspora relace: ${ANSI_BOLD}${ANSI_GREEN}${sessionPct} %${ANSI_RESET} (${sessionSaved.toLocaleString()} tokenů · $${sessionCost})`,
    `  • Celoživotní úspora: ${ANSI_BOLD}${ANSI_GREEN}${metrics.savingsPct.toFixed(1)} %${ANSI_RESET} (${metrics.tokensSaved.toLocaleString()} tokenů · $${metrics.costSavedUsd.toFixed(2)})`,
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
            description: "Minimální zobrazení pouze s procenty úspory",
          },
          {
            value: "format normal",
            label: "format normal",
            description: "Standardní zobrazení s procenty a ušetřenými tokeny",
          },
          {
            value: "format detailed",
            label: "format detailed",
            description: "Podrobné zobrazení s verzí a počtem požadavků",
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
            description: "Zobrazovat úsporu tokenů pro aktuální relaci Pi",
          },
          {
            value: "scope lifetime",
            label: "scope lifetime",
            description: "Zobrazovat celkovou celoživotní úsporu proxy",
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
              description: `Směrovat požadavky ${p} přes Headroom kompresní proxy`,
            },
            {
              value: `route ${p} off`,
              label: `route ${p} off`,
              description: `Vypnout směrování pro ${p} (přímé volání API)`,
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
            description: "Uložit nastavení globálně pro všechny relace",
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
          "⚡ Počítadlo úspory pro aktuální relaci bylo vynulováno na aktuální stav.",
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
            "Použití: /headroom route <google|openrouter|openai|anthropic|moonshotai> on|off [--global]",
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
          `⚡ Headroom směrování pro "${provider}" bylo ${isEnable ? "ZAPNUTO" : "VYPNUTO"}${isGlobal ? " (globálně)" : ""}.`,
          "info",
        );
        break;
      }

      case "dashboard": {
        openDashboard(config.host, config.port);
        ctx.ui.notify(
          `Otevírám Headroom dashboard na adrese http://${config.host}:${config.port}/dashboard ...`,
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
          `⚡ Statistiky Headroom aktualizovány: ${activePct.toFixed(1)} % úspora (${activeTokens.toLocaleString()} ušetřených tokenů)`,
          "info",
        );
        break;
      }

      case "scope": {
        if (value !== "session" && value !== "lifetime") {
          ctx.ui.notify(
            `Neplatný rozsah "${value}". Vyberte: session | lifetime`,
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
          `⚡ Rozsah zobrazení ve statusline nastaven na "${value}"${isGlobal ? " (globálně)" : ""}.`,
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
          `⚡ Zobrazení Headroom ve statusline zapnuto${isGlobal ? " (globálně)" : ""}.`,
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
          `⚡ Zobrazení Headroom ve statusline vypnuto${isGlobal ? " (globálně)" : ""}.`,
          "info",
        );
        break;
      }

      case "format": {
        if (value !== "compact" && value !== "normal" && value !== "detailed") {
          ctx.ui.notify(
            `Neplatný formát "${value}". Vyberte: compact | normal | detailed`,
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
          `Formát statusline nastaven na "${value}"${isGlobal ? " (globálně)" : ""}.`,
          "info",
        );
        break;
      }

      case "port": {
        const portNum = parseInt(value, 10);
        if (Number.isNaN(portNum) || portNum <= 0 || portNum > 65535) {
          ctx.ui.notify(
            `Neplatný port "${value}". Musí být číslo mezi 1 a 65535.`,
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
          `Port Headroom proxy nastaven na ${portNum}${isGlobal ? " (globálně)" : ""}.`,
          "info",
        );
        break;
      }

      default:
        ctx.ui.notify(
          `Neznámý příkaz "${subcommand}". Použijte: /headroom help`,
          "warning",
        );
        break;
    }
  };

  pi.registerCommand("headroom", {
    description: "Správa optimalizace kontextu Headroom, směrování poskytovatelů a statusline",
    getArgumentCompletions: getCompletions,
    handler: commandHandler,
  });
}
