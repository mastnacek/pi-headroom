import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  HeadroomConfig,
  HeadroomHealthResponse,
  HeadroomMetrics,
  HeadroomSavingsEvent,
  HeadroomSessionBaseline,
  HeadroomSessionMetrics,
} from "./types.js";

export const SAVINGS_EVENTS_PATH = join(
  homedir(),
  ".headroom",
  "savings_events.jsonl",
);

interface RawCompressionStats {
  total_tokens_removed?: number;
  total_tokens_before?: number;
  tool_schema_tokens_saved?: number;
  avg_compression_pct?: number;
}

interface RawCostStats {
  total_saved_usd?: number;
  savings_usd?: number;
}

interface RawTokenStats {
  saved?: number;
  all_layers_saved?: number;
  total_before_compression?: number;
  input?: number;
}

interface RawRequestStats {
  total?: number;
}

interface RawHeadroomStats {
  summary?: {
    primary_model?: string;
    compression?: RawCompressionStats;
    cost?: RawCostStats;
  };
  cost?: RawCostStats;
  tokens?: RawTokenStats;
  requests?: RawRequestStats;
  persistent_savings?: {
    lifetime?: {
      tokens_saved?: number;
      compression_savings_usd?: number;
    };
  };
}

/**
 * Parses events from ~/.headroom/savings_events.jsonl to calculate historical savings.
 */
export function readSavingsEvents(customPath = SAVINGS_EVENTS_PATH): {
  totalRequests: number;
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  costSavedUsd: number;
  lastEvent?: HeadroomSavingsEvent;
} {
  const result = {
    totalRequests: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    costSavedUsd: 0,
    lastEvent: undefined as HeadroomSavingsEvent | undefined,
  };

  if (!existsSync(customPath)) {
    return result;
  }

  try {
    const content = readFileSync(customPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as HeadroomSavingsEvent;
        result.totalRequests++;
        result.tokensSaved += ev.saved || 0;
        result.tokensBefore += ev.before || 0;
        result.tokensAfter += ev.after || 0;
        result.costSavedUsd += ev.cost_usd || 0;
        result.lastEvent = ev;
      } catch {
        // Skip malformed line
      }
    }
  } catch {
    // Non-fatal read error
  }

  return result;
}

/**
 * Reads and aggregates savings events recorded since a given timestamp from savings_events.jsonl.
 */
export function readSavingsEventsSince(
  since: string | number,
  customPath = SAVINGS_EVENTS_PATH,
): {
  totalRequests: number;
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  costSavedUsd: number;
} {
  const result = {
    totalRequests: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    costSavedUsd: 0,
  };

  if (!existsSync(customPath)) {
    return result;
  }

  const sinceTime = new Date(since).getTime();

  try {
    const content = readFileSync(customPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as HeadroomSavingsEvent;
        const evTime = ev.ts ? new Date(ev.ts).getTime() : 0;
        if (evTime >= sinceTime) {
          result.totalRequests++;
          result.tokensSaved += ev.saved || 0;
          result.tokensBefore += ev.before || 0;
          result.tokensAfter += ev.after || 0;
          result.costSavedUsd += ev.cost_usd || 0;
        }
      } catch {
        // Skip malformed line
      }
    }
  } catch {
    // Non-fatal read error
  }

  return result;
}

/**
 * Creates a baseline snapshot from metrics at session start or reset.
 */
export function createSessionBaseline(
  metrics: HeadroomMetrics,
  nowMs = Date.now(),
): HeadroomSessionBaseline {
  return {
    startedAt: nowMs,
    startedAtIso: new Date(nowMs).toISOString(),
    tokensSaved: metrics.tokensSaved,
    tokensBefore: metrics.tokensBefore,
    tokensAfter: metrics.tokensAfter,
    costSavedUsd: metrics.costSavedUsd,
    totalRequests: metrics.totalRequests,
  };
}

/**
 * Computes session-scoped metrics by subtracting baseline from lifetime metrics,
 * with automatic fallback to disk logs if proxy restarted.
 */
export function calculateSessionMetrics(
  lifetime: HeadroomMetrics,
  baseline: HeadroomSessionBaseline,
  readEventsSinceFn: typeof readSavingsEventsSince = readSavingsEventsSince,
): HeadroomSessionMetrics {
  let saved = lifetime.tokensSaved - baseline.tokensSaved;
  let before = lifetime.tokensBefore - baseline.tokensBefore;
  let after = lifetime.tokensAfter - baseline.tokensAfter;
  let cost = lifetime.costSavedUsd - baseline.costSavedUsd;
  let reqs = lifetime.totalRequests - baseline.totalRequests;

  // Fallback to savings_events.jsonl if proxy restarted or stats were reset
  if (saved < 0 || before < 0 || reqs < 0) {
    const disk = readEventsSinceFn(baseline.startedAtIso);
    saved = disk.tokensSaved;
    before = disk.tokensBefore;
    after = disk.tokensAfter;
    cost = disk.costSavedUsd;
    reqs = disk.totalRequests;
  }

  saved = Math.max(0, saved);
  before = Math.max(0, before);
  after = Math.max(0, after);
  cost = Math.max(0, cost);
  reqs = Math.max(0, reqs);

  if (before > 0 && after === 0 && saved > 0) {
    after = Math.max(0, before - saved);
  }

  const pct = before > 0 ? Math.round((saved / before) * 1000) / 10 : 0;

  return {
    startedAt: baseline.startedAt,
    startedAtIso: baseline.startedAtIso,
    totalRequests: reqs,
    tokensSaved: saved,
    tokensBefore: before,
    tokensAfter: after,
    savingsPct: pct,
    costSavedUsd: cost,
  };
}

function mergeStats(
  stats: RawHeadroomStats | null,
  disk: ReturnType<typeof readSavingsEvents>,
): {
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  costSavedUsd: number;
  schemaTokensSaved: number;
  messageTokensSaved: number;
  totalRequests: number;
  activeModel?: string;
} {
  let tokensSaved = disk.tokensSaved;
  let tokensBefore = disk.tokensBefore;
  let tokensAfter = disk.tokensAfter;
  let costSavedUsd = disk.costSavedUsd;
  let schemaTokensSaved = 0;
  let messageTokensSaved = 0;
  let totalRequests = disk.totalRequests;
  let activeModel = disk.lastEvent?.model;

  if (stats) {
    const comp = stats.summary?.compression;
    const cost = stats.cost || stats.summary?.cost;
    const tok = stats.tokens;
    const req = stats.requests;

    const httpSaved =
      comp?.total_tokens_removed || tok?.saved || tok?.all_layers_saved || 0;
    const httpBefore =
      comp?.total_tokens_before ||
      tok?.total_before_compression ||
      tok?.input ||
      0;
    const lifetimeSaved = stats.persistent_savings?.lifetime?.tokens_saved || 0;

    schemaTokensSaved = comp?.tool_schema_tokens_saved || 0;
    messageTokensSaved = comp?.total_tokens_removed || 0;

    if (httpSaved > 0 || lifetimeSaved > 0) {
      tokensSaved = Math.max(tokensSaved, httpSaved, lifetimeSaved);
    }
    if (httpBefore > 0) {
      tokensBefore = Math.max(tokensBefore, httpBefore);
    }

    const httpCost = cost?.total_saved_usd || cost?.savings_usd || 0;
    if (httpCost > 0) {
      costSavedUsd = Math.max(costSavedUsd, httpCost);
    }
    if (req?.total) {
      totalRequests = Math.max(totalRequests, req.total);
    }
    if (
      stats.summary?.primary_model &&
      stats.summary.primary_model !== "passthrough:models"
    ) {
      activeModel = stats.summary.primary_model;
    }
  }

  if (tokensBefore > 0 && tokensAfter === 0 && tokensSaved > 0) {
    tokensAfter = Math.max(0, tokensBefore - tokensSaved);
  }

  return {
    tokensSaved,
    tokensBefore,
    tokensAfter,
    costSavedUsd,
    schemaTokensSaved,
    messageTokensSaved,
    totalRequests,
    activeModel,
  };
}

/**
 * Queries the Headroom proxy for real-time health and statistics.
 */
export async function getHeadroomMetrics(
  config: HeadroomConfig,
  fetchFn: typeof fetch = fetch,
  readDiskFn: typeof readSavingsEvents = readSavingsEvents,
): Promise<HeadroomMetrics> {
  const base = `http://${config.host}:${config.port}`;
  const now = Date.now();

  try {
    const healthRes = await fetchFn(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
    });

    if (!healthRes.ok) {
      throw new Error(`Health check returned HTTP ${healthRes.status}`);
    }

    const health = (await healthRes.json()) as HeadroomHealthResponse;

    let stats: RawHeadroomStats | null = null;
    try {
      const statsRes = await fetchFn(`${base}/stats`, {
        signal: AbortSignal.timeout(2000),
      });
      if (statsRes.ok) {
        stats = (await statsRes.json()) as RawHeadroomStats;
      }
    } catch {
      // Non-fatal
    }

    const disk = readDiskFn();
    const merged = mergeStats(stats, disk);

    const savingsPct =
      merged.tokensBefore > 0
        ? Math.round((merged.tokensSaved / merged.tokensBefore) * 1000) / 10
        : 0;

    return {
      online: true,
      version: health.version,
      uptimeSeconds: health.uptime_seconds,
      totalRequests: merged.totalRequests,
      tokensSaved: merged.tokensSaved,
      tokensBefore: merged.tokensBefore,
      tokensAfter: merged.tokensAfter,
      savingsPct,
      costSavedUsd: merged.costSavedUsd,
      schemaTokensSaved: merged.schemaTokensSaved,
      messageTokensSaved: merged.messageTokensSaved,
      activeModel: merged.activeModel,
      source: stats ? "http" : "events",
      lastChecked: now,
    };
  } catch (err: unknown) {
    const disk = readDiskFn();
    const savingsPct =
      disk.tokensBefore > 0
        ? Math.round((disk.tokensSaved / disk.tokensBefore) * 1000) / 10
        : 0;

    const errorMessage = err instanceof Error ? err.message : String(err);

    return {
      online: false,
      totalRequests: disk.totalRequests,
      tokensSaved: disk.tokensSaved,
      tokensBefore: disk.tokensBefore,
      tokensAfter: disk.tokensAfter,
      savingsPct,
      costSavedUsd: disk.costSavedUsd,
      schemaTokensSaved: 0,
      messageTokensSaved: 0,
      activeModel: disk.lastEvent?.model,
      source: disk.totalRequests > 0 ? "events" : "offline",
      lastChecked: now,
      error: errorMessage,
    };
  }
}
