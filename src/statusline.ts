import type { HeadroomConfig, HeadroomMetrics } from "./types.js";

// ANSI colors for clean, theme-friendly terminal rendering
export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_GREEN = "\x1b[38;2;95;200;140m";
export const ANSI_CYAN = "\x1b[38;2;95;200;230m";
export const ANSI_AMBER = "\x1b[38;2;218;165;32m";
export const ANSI_LAVENDER = "\x1b[38;2;170;160;220m";
export const ANSI_RED = "\x1b[38;2;210;100;100m";
export const ANSI_YELLOW = "\x1b[38;2;230;200;90m";
export const ANSI_DIM = "\x1b[38;2;120;124;140m";

export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return n.toLocaleString("en-US");
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens === 0) return "0";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 10_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  if (abs >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return formatNumber(tokens);
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0.00";
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return "just started";
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}h ${m % 60}m`;
  }
  if (m > 0) {
    return `${m}m ${Math.floor(seconds % 60)}s`;
  }
  return `${Math.floor(seconds)}s`;
}

/**
 * Builds the compact statusline badge text for Pi's footer.
 */
export function formatStatusline(
  metrics: HeadroomMetrics,
  config: HeadroomConfig,
): string {
  if (!config.enabled) {
    return "";
  }

  const prefix = config.prefix ? `${config.prefix} ` : "";

  if (!metrics.online) {
    if (!config.showOffline) return "";
    return `${ANSI_DIM}${ANSI_RED}${prefix}Headroom: offline${ANSI_RESET}`;
  }

  const isSessionScope = config.scope === "session" && metrics.session;
  const activeSaved = isSessionScope
    ? (metrics.session?.tokensSaved ?? 0)
    : metrics.tokensSaved;
  const activePct = isSessionScope
    ? (metrics.session?.savingsPct ?? 0)
    : metrics.savingsPct;
  const activeCost = isSessionScope
    ? (metrics.session?.costSavedUsd ?? 0)
    : metrics.costSavedUsd;
  const activeReqs = isSessionScope
    ? (metrics.session?.totalRequests ?? 0)
    : metrics.totalRequests;

  const pctStr = activePct > 0 ? `${activePct.toFixed(1)}%` : "0.0%";
  const pctColored = `${ANSI_BOLD}${ANSI_GREEN}${pctStr}${ANSI_RESET}`;

  const parts: string[] = [];
  if (config.showTokens && activeSaved > 0) {
    parts.push(`-${formatTokens(activeSaved)}`);
  }
  if (config.showDollars && activeCost > 0) {
    parts.push(formatCost(activeCost));
  }

  const details =
    parts.length > 0 ? ` ${ANSI_DIM}(${parts.join(" · ")})${ANSI_RESET}` : "";

  if (config.format === "compact") {
    return `${ANSI_BOLD}${ANSI_CYAN}${prefix}${pctColored}${details}`;
  }

  if (config.format === "detailed") {
    const versionStr = metrics.version ? ` v${metrics.version}` : "";
    const scopeStr = isSessionScope ? " (session)" : "";
    const reqStr = activeReqs > 0 ? ` · ${activeReqs} reqs` : "";
    return `${ANSI_BOLD}${ANSI_CYAN}${prefix}Headroom${versionStr}${scopeStr}:${ANSI_RESET} ${pctColored}${details}${ANSI_DIM}${reqStr}${ANSI_RESET}`;
  }

  // Normal format (default)
  return `${ANSI_BOLD}${ANSI_CYAN}${prefix}Headroom:${ANSI_RESET} ${pctColored}${details}`;
}

/**
 * Generates structured markdown report for /headroom session.
 */
export function formatSessionReport(
  metrics: HeadroomMetrics,
  config: HeadroomConfig,
): string {
  const statusIcon = metrics.online ? "🟢 Aktivní" : "🔴 Offline";
  const session = metrics.session;

  const startTimeStr = session?.startedAtIso
    ? new Date(session.startedAtIso).toLocaleString()
    : "aktuální relace";

  const lines: string[] = [
    `# ⚡ Headroom — Úspora kontextu v relaci`,
    ``,
    `* **Zahájení relace:** ${startTimeStr}`,
    `* **Stav proxy:** ${statusIcon} (http://${config.host}:${config.port})`,
  ];

  if (metrics.activeModel) {
    lines.push(`* **Aktivní model:** \`${metrics.activeModel}\``);
  }

  lines.push(
    ``,
    `### 🎯 Úspora v aktuální relaci`,
    `* **Míra komprese:** **${(session?.savingsPct ?? 0).toFixed(1)} %**`,
    `* **Ušetřené tokeny:** **${formatNumber(session?.tokensSaved ?? 0)}** tokenů`,
    `* **Původní vstup:** ${formatNumber(session?.tokensBefore ?? 0)} tokenů`,
    `* **Optimalizovaný vstup:** ${formatNumber(session?.tokensAfter ?? 0)} tokenů`,
    `* **Ušetřené náklady:** **${formatCost(session?.costSavedUsd ?? 0)}**`,
    `* **Požadavky v relaci:** ${formatNumber(session?.totalRequests ?? 0)}`,
    ``,
    `*(Celoživotní úspora proxy: ${formatNumber(metrics.tokensSaved)} tokenů · ${formatCost(metrics.costSavedUsd)} v ${formatNumber(metrics.totalRequests)} požadavcích)*`,
  );

  return lines.join("\n");
}

/**
 * Generates structured markdown report for /headroom status / savings.
 */
export function formatDetailedReport(
  metrics: HeadroomMetrics,
  config: HeadroomConfig,
): string {
  const statusIcon = metrics.online ? "🟢 Aktivní" : "🔴 Offline";
  const uptimeStr = formatUptime(metrics.uptimeSeconds);
  const versionStr = metrics.version ? `v${metrics.version}` : "neznámá";

  const lines: string[] = [
    `# ⚡ Headroom — Stav optimalizace kontextu`,
    ``,
    `* **Stav proxy:** ${statusIcon} (http://${config.host}:${config.port})`,
    `* **Verze:** ${versionStr} | **Doba běhu:** ${uptimeStr}`,
    `* **Zdroj dat:** ${metrics.source}`,
  ];

  if (metrics.session) {
    const s = metrics.session;
    lines.push(
      ``,
      `### 🎯 Úspora v aktuální relaci`,
      `* **Míra komprese relace:** **${s.savingsPct.toFixed(1)} %**`,
      `* **Ušetřené tokeny v relaci:** **${formatNumber(s.tokensSaved)}** tokenů`,
      `* **Původní vstup relace:** ${formatNumber(s.tokensBefore)} tokenů`,
      `* **Optimalizovaný vstup relace:** ${formatNumber(s.tokensAfter)} tokenů`,
      `* **Ušetřené náklady v relaci:** **${formatCost(s.costSavedUsd)}**`,
      `* **Počet požadavků v relaci:** ${formatNumber(s.totalRequests)}`,
    );
  }

  lines.push(
    ``,
    `### 🌐 Celoživotní / Globální úspora`,
    `* **Celoživotní míra komprese:** **${metrics.savingsPct.toFixed(1)} %**`,
    `* **Celoživotně ušetřené tokeny:** **${formatNumber(metrics.tokensSaved)}** tokenů`,
    `* **Celoživotní původní vstup:** ${formatNumber(metrics.tokensBefore)} tokenů`,
    `* **Celoživotní optimalizovaný vstup:** ${formatNumber(metrics.tokensAfter)} tokenů`,
    `* **Odhadované ušetřené náklady:** **${formatCost(metrics.costSavedUsd)}**`,
    `* **Celkem požadavků:** ${formatNumber(metrics.totalRequests)}`,
  );

  if (metrics.schemaTokensSaved > 0 || metrics.messageTokensSaved > 0) {
    lines.push(``, `### 🔍 Rozpis úspory tokenů`);
    if (metrics.schemaTokensSaved > 0) {
      lines.push(
        `* **Odstraněná schémata nástrojů:** ${formatNumber(metrics.schemaTokensSaved)} tokenů`,
      );
    }
    if (metrics.messageTokensSaved > 0) {
      lines.push(
        `* **Komprese historie zpráv:** ${formatNumber(metrics.messageTokensSaved)} tokenů`,
      );
    }
  }

  // Active proxy routing status
  const activeRoutes = Object.entries(config.routes)
    .filter(([, enabled]) => enabled)
    .map(([name]) => `\`${name}\``);

  if (activeRoutes.length > 0) {
    lines.push(
      ``,
      `### 🔀 Aktivní Headroom trasy`,
      `* **Směrovaní poskytovatelé:** ${activeRoutes.join(", ")}`,
    );
  }

  if (metrics.activeModel) {
    lines.push(``, `* **Aktivní model:** \`${metrics.activeModel}\``);
  }

  if (metrics.error) {
    lines.push(
      ``,
      `⚠️ **Upozornění:** Poslední dotaz vrátil: *${metrics.error}*`,
    );
  }

  return lines.join("\n");
}
