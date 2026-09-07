import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { isProxyRunning } from "../src/providers/router.js";

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
});
