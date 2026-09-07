import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSessionMetrics,
  createSessionBaseline,
  getHeadroomMetrics,
} from "../src/telemetry.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { HeadroomMetrics, HeadroomSessionBaseline } from "../src/types.js";

describe("api metrics extraction", () => {
  it("extracts metrics from mock HTTP responses", async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.endsWith("/health")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "healthy",
            version: "0.37.0",
            uptime_seconds: 120,
          }),
        } as Response;
      }
      if (u.endsWith("/stats")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            summary: {
              compression: {
                total_tokens_removed: 2000,
                total_tokens_before: 10000,
                tool_schema_tokens_saved: 1500,
              },
              cost: {
                total_saved_usd: 0.05,
              },
            },
            requests: { total: 4 },
          }),
        } as Response;
      }
      throw new Error(`Unexpected url ${u}`);
    }) as typeof fetch;

    const mockDiskEmpty = () => ({
      totalRequests: 0,
      tokensSaved: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      costSavedUsd: 0,
    });

    const metrics = await getHeadroomMetrics(
      DEFAULT_CONFIG,
      mockFetch,
      mockDiskEmpty,
    );
    assert.equal(metrics.online, true);
    assert.equal(metrics.version, "0.37.0");
    assert.equal(metrics.uptimeSeconds, 120);
    assert.equal(metrics.tokensSaved, 2000);
    assert.equal(metrics.tokensBefore, 10000);
    assert.equal(metrics.savingsPct, 20.0);
    assert.equal(metrics.costSavedUsd, 0.05);
    assert.equal(metrics.schemaTokensSaved, 1500);
    assert.equal(metrics.source, "http");
  });

  it("handles offline gracefully", async () => {
    const mockFailingFetch = (async () => {
      throw new Error("Connection refused");
    }) as typeof fetch;

    const mockDiskEmpty = () => ({
      totalRequests: 0,
      tokensSaved: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      costSavedUsd: 0,
    });

    const metrics = await getHeadroomMetrics(
      DEFAULT_CONFIG,
      mockFailingFetch,
      mockDiskEmpty,
    );
    assert.equal(metrics.online, false);
    assert.match(metrics.error || "", /Connection refused/);
  });

  it("computes session delta metrics accurately from baseline", () => {
    const initialMetrics: HeadroomMetrics = {
      online: true,
      totalRequests: 10,
      tokensSaved: 5000,
      tokensBefore: 20000,
      tokensAfter: 15000,
      savingsPct: 25.0,
      costSavedUsd: 0.05,
      schemaTokensSaved: 0,
      messageTokensSaved: 0,
      source: "http",
      lastChecked: Date.now(),
    };

    const baseline = createSessionBaseline(initialMetrics, 1700000000000);
    assert.equal(baseline.tokensSaved, 5000);
    assert.equal(baseline.tokensBefore, 20000);
    assert.equal(baseline.totalRequests, 10);

    const laterMetrics: HeadroomMetrics = {
      ...initialMetrics,
      totalRequests: 14,
      tokensSaved: 8000,
      tokensBefore: 26000,
      tokensAfter: 18000,
      savingsPct: 30.8,
      costSavedUsd: 0.08,
    };

    const session = calculateSessionMetrics(laterMetrics, baseline);
    assert.equal(session.totalRequests, 4);
    assert.equal(session.tokensSaved, 3000);
    assert.equal(session.tokensBefore, 6000);
    assert.equal(session.tokensAfter, 3000);
    assert.equal(session.savingsPct, 50.0);
    assert.equal(Math.round(session.costSavedUsd * 100) / 100, 0.03);
  });

  it("falls back to disk events if proxy restarted during session", () => {
    const baseline: HeadroomSessionBaseline = {
      startedAt: 1700000000000,
      startedAtIso: "2026-09-07T10:00:00.000Z",
      tokensSaved: 10000,
      tokensBefore: 40000,
      tokensAfter: 30000,
      costSavedUsd: 0.1,
      totalRequests: 20,
    };

    const resetMetrics: HeadroomMetrics = {
      online: true,
      totalRequests: 2,
      tokensSaved: 1500,
      tokensBefore: 5000,
      tokensAfter: 3500,
      savingsPct: 30.0,
      costSavedUsd: 0.02,
      schemaTokensSaved: 0,
      messageTokensSaved: 0,
      source: "http",
      lastChecked: Date.now(),
    };

    const mockDiskEventsSince = (_since: string | number) => ({
      totalRequests: 3,
      tokensSaved: 2500,
      tokensBefore: 7000,
      tokensAfter: 4500,
      costSavedUsd: 0.03,
    });

    const session = calculateSessionMetrics(
      resetMetrics,
      baseline,
      mockDiskEventsSince,
    );
    assert.equal(session.totalRequests, 3);
    assert.equal(session.tokensSaved, 2500);
    assert.equal(session.tokensBefore, 7000);
    assert.equal(session.tokensAfter, 4500);
    assert.equal(session.savingsPct, 35.7);
    assert.equal(session.costSavedUsd, 0.03);
  });
});
