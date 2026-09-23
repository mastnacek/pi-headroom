import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HeadroomConfig } from "../types.js";
import {
  googleCredentialApiKey,
  loginGoogle,
  refreshGoogleToken,
  streamGoogleCca,
} from "./google-oauth.js";

/**
 * Checks if the Headroom compression proxy is responding on the configured host & port.
 */
export async function isProxyRunning(
  host: string,
  port: number,
): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Registers all supported provider proxies (Google OAuth, OpenRouter, etc.) into Pi.
 *
 * `enabled: false` is the master switch: when the Headroom integration is off we
 * must not hijack provider base URLs. Re-pointing OpenRouter/Google at a proxy
 * that is not running turns every request into an opaque `Connection error.`
 * even though the upstream provider is healthy.
 */
export function registerProviderRoutes(
  pi: ExtensionAPI,
  getConfig: () => HeadroomConfig,
): void {
  const config = getConfig();
  if (!config.enabled) return;
  const proxyBaseUrl = `http://${config.host}:${config.port}/v1`;

  // 1. Google OAuth Provider (Antigravity & Gemini CLI via Cloud Code Assist wire)
  pi.registerProvider("google", {
    name: "Google (Headroom + Cloud Code Assist OAuth)",
    api: "google-generative-ai",
    streamSimple: (model, context, options) =>
      streamGoogleCca(model, context, options, getConfig()),
    oauth: {
      name: "Google (Cloud Code Assist)",
      login: loginGoogle,
      refreshToken: refreshGoogleToken,
      getApiKey: googleCredentialApiKey,
    },
  });

  // 2. OpenRouter Provider Proxy Override
  if (config.routes.openrouter !== false) {
    pi.registerProvider("openrouter", {
      baseUrl: proxyBaseUrl,
      headers: {
        "x-headroom-base-url": "https://openrouter.ai/api/v1",
      },
    });
  }

  // 3. Opencode-Go Provider Proxy Override
  if (config.routes["opencode-go"] !== false) {
    pi.registerProvider("opencode-go", {
      baseUrl: proxyBaseUrl,
    });
  }

  // 4. OpenAI Provider Proxy Override (Opt-in)
  if (config.routes.openai) {
    pi.registerProvider("openai", {
      baseUrl: proxyBaseUrl,
    });
  }

  // 5. Anthropic Provider Proxy Override (Opt-in)
  if (config.routes.anthropic) {
    pi.registerProvider("anthropic", {
      baseUrl: proxyBaseUrl,
    });
  }

  // 6. Moonshot AI Provider Proxy Override (Opt-in)
  if (config.routes.moonshotai) {
    pi.registerProvider("moonshotai", {
      baseUrl: proxyBaseUrl,
      headers: {
        "x-headroom-base-url": "https://api.moonshot.cn/v1",
      },
    });
  }
}
