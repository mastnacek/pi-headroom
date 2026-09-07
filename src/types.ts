export interface HeadroomConfig {
  /** Enable statusline footer badge display */
  enabled: boolean;
  /** Headroom proxy host (default: 127.0.0.1) */
  host: string;
  /** Headroom proxy port (default: 8787) */
  port: number;
  /** Polling interval in milliseconds (default: 10000, 0 disables background polling) */
  pollIntervalMs: number;
  /** Statusline badge display format: compact | normal | detailed */
  format: "compact" | "normal" | "detailed";
  /** Statusline metrics scope: session | lifetime (default: session) */
  scope: "session" | "lifetime";
  /** Include estimated USD savings in statusline */
  showDollars: boolean;
  /** Include token savings in statusline */
  showTokens: boolean;
  /** Show badge when proxy is offline */
  showOffline: boolean;
  /** Icon/prefix before statusline text (default: ⚡) */
  prefix: string;
  /** Provider proxy routing map (e.g. google: true, openrouter: true) */
  routes: Record<string, boolean>;
  /** Whether to register the CCR headroom_retrieve tool */
  registerRetrieveTool: boolean;
}

export interface HeadroomSessionBaseline {
  startedAt: number;
  startedAtIso: string;
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  costSavedUsd: number;
  totalRequests: number;
}

export interface HeadroomSessionMetrics {
  startedAt: number;
  startedAtIso: string;
  totalRequests: number;
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  savingsPct: number;
  costSavedUsd: number;
}

export interface HeadroomHealthResponse {
  service?: string;
  status?: string;
  ready?: boolean;
  version?: string;
  uptime_seconds?: number;
}

export interface HeadroomSavingsEvent {
  v?: number;
  ts?: string;
  before?: number;
  after?: number;
  saved?: number;
  cost_usd?: number;
  model?: string;
  client?: string;
  source?: string;
  pid?: number;
}

export interface HeadroomMetrics {
  online: boolean;
  version?: string;
  uptimeSeconds?: number;
  totalRequests: number;
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  savingsPct: number;
  costSavedUsd: number;
  schemaTokensSaved: number;
  messageTokensSaved: number;
  activeModel?: string;
  source: "http" | "events" | "offline";
  lastChecked: number;
  error?: string;
  session?: HeadroomSessionMetrics;
}
