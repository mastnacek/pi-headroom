import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import {
  isProxyRunning,
  registerProviderRoutes,
} from "../src/providers/router.js";

/** Minimal ExtensionAPI double that records provider registrations. */
function fakePi() {
  const calls: Array<{ id: string; config: Record<string, unknown> }> = [];
  const pi = {
    registerProvider: (id: string, config: Record<string, unknown>) => {
      calls.push({ id, config });
    },
  } as unknown as Parameters<typeof registerProviderRoutes>[0];
  return { pi, calls };
}

describe("provider router and configuration", () => {
  it("defaults to routing google, openrouter, and opencode-go", () => {
    assert.equal(DEFAULT_CONFIG.routes.google, true);
    assert.equal(DEFAULT_CONFIG.routes.openrouter, true);
    assert.equal(DEFAULT_CONFIG.routes["opencode-go"], true);
    assert.equal(DEFAULT_CONFIG.routes.openai, false);
    assert.equal(DEFAULT_CONFIG.routes.anthropic, false);
  });

  it("loads default config when no custom file is present", () => {
    const config = loadConfig("/non/existent/path");
    assert.equal(config.port, 8787);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.scope, "session");
  });

  it("handles isProxyRunning failure gracefully", async () => {
    const alive = await isProxyRunning("127.0.0.1", 65530);
    assert.equal(typeof alive, "boolean");
  });

  it("registers no provider routes while Headroom is disabled", () => {
    const { pi, calls } = fakePi();
    registerProviderRoutes(pi, () => ({ ...DEFAULT_CONFIG, enabled: false }));
    assert.deepEqual(calls, []);
  });

  it("routes OpenRouter through the local proxy when enabled", () => {
    const { pi, calls } = fakePi();
    registerProviderRoutes(pi, () => ({ ...DEFAULT_CONFIG, enabled: true }));
    const openrouter = calls.find((call) => call.id === "openrouter");
    assert.ok(openrouter, "openrouter override should be registered");
    assert.equal(
      openrouter.config.baseUrl,
      `http://${DEFAULT_CONFIG.host}:${DEFAULT_CONFIG.port}/v1`,
    );
  });
});
