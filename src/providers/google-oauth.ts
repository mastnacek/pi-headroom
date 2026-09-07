/**
 * Google Cloud Code Assist OAuth and Antigravity wire streaming provider for pi-headroom.
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import * as http from "http";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { HeadroomConfig } from "../types.js";
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReasonString,
  retainThoughtSignature,
  type GeminiContent,
  type GeminiPart,
  type GoogleThinkingLevel,
  type ModelWire,
} from "./google-wire.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_TIMEOUT_MS = 300_000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

export type GoogleVariantId = "antigravity" | "gemini-cli";

export interface GoogleOauthCredential extends OAuthCredentials {
  variant: GoogleVariantId;
  projectId: string;
  email?: string;
}

const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

export function antigravityUserAgent(): string {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || "2.8.0";
  const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
  const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
  const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

function geminiCliUserAgent(modelId: string): string {
  const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

const ANTIGRAVITY_WIRE_PROFILES: Record<
  string,
  { modelEnum?: string; maxOutputTokens: number }
> = {
  "gemini-3.5-flash-extra-low": {
    modelEnum: "MODEL_PLACEHOLDER_M187",
    maxOutputTokens: 65_536,
  },
  "gemini-3.5-flash-low": {
    modelEnum: "MODEL_PLACEHOLDER_M20",
    maxOutputTokens: 65_536,
  },
  "gemini-3-flash-agent": {
    modelEnum: "MODEL_PLACEHOLDER_M132",
    maxOutputTokens: 65_536,
  },
  "gemini-3.1-pro-low": {
    modelEnum: "MODEL_PLACEHOLDER_M36",
    maxOutputTokens: 65_535,
  },
  "gemini-pro-agent": {
    modelEnum: "MODEL_PLACEHOLDER_M16",
    maxOutputTokens: 65_535,
  },
};

const ANTIGRAVITY_MODEL_ROUTING: Record<string, Record<string, string>> = {
  "gemini-3-flash-preview": {
    off: "gemini-3.5-flash-extra-low",
    minimal: "gemini-3.5-flash-extra-low",
    low: "gemini-3.5-flash-extra-low",
    medium: "gemini-3.5-flash-low",
    high: "gemini-3-flash-agent",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    minimal: "gemini-3.5-flash-extra-low",
    low: "gemini-3.5-flash-extra-low",
    medium: "gemini-3.5-flash-low",
    high: "gemini-3-flash-agent",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    minimal: "gemini-3.6-flash-low",
    low: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-low",
    minimal: "gemini-3.7-flash-low",
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
    high: "gemini-3.7-flash-high",
  },
  "gemini-3.1-pro-preview": {
    off: "gemini-3.1-pro-low",
    minimal: "gemini-3.1-pro-low",
    low: "gemini-3.1-pro-low",
    medium: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
  },
};

function antigravityWireModelId(
  modelId: string,
  effort: string | undefined,
): string {
  const routing = ANTIGRAVITY_MODEL_ROUTING[modelId];
  if (!routing) return modelId;
  return routing[effort ?? "off"] ?? Object.values(routing)[0]!;
}

interface VariantConfig {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  callbackPath: string;
  scopes: string[];
  label: string;
  discoverProject(
    accessToken: string,
    onProgress?: (m: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;
}

const geminiCliId = [
  "681255809395",
  "-oo8ft2oprdrnp9e3aqf6av3hmdib135j",
  ".apps.googleusercontent.com",
].join("");
const geminiCliSec = [
  "GOCSPX",
  "-4uHgMPm",
  "-1o7Sk",
  "-geV6Cu5clXFsxl",
].join("");

const geminiCliVariant: VariantConfig = {
  label: "Gemini CLI",
  clientId: geminiCliId,
  clientSecret: geminiCliSec,
  callbackPort: 8085,
  callbackPath: "/oauth2callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  async discoverProject(accessToken, onProgress, signal) {
    const envProjectId =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent":
        "GeminiCLI/0.46.0/gemini-3.1-pro-preview (linux; x64; terminal)",
      "Client-Metadata":
        "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
    };

    onProgress?.("Checking for existing Cloud Code Assist project...");
    const loadResponse = await oauthFetch(
      `${GEMINI_CLI_ENDPOINT}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          cloudaicompanionProject: envProjectId,
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
            duetProject: envProjectId,
          },
        }),
      },
      signal,
    );

    let data: GeminiCliLoadPayload;
    if (loadResponse.ok) {
      data = (await loadResponse.json()) as GeminiCliLoadPayload;
    } else {
      let errorPayload: unknown;
      try {
        errorPayload = await loadResponse.clone().json();
      } catch {
        errorPayload = undefined;
      }
      if (isVpcScAffectedUser(errorPayload)) {
        data = { currentTier: { id: "standard-tier" } };
      } else {
        const errorText = await loadResponse.text();
        throw new OAuthFlowError(
          `loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`,
          "discovery",
          loadResponse.status,
        );
      }
    }

    if (data.currentTier) {
      if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
      if (envProjectId) return envProjectId;
      throw new OAuthFlowError(
        "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable.",
        "configuration",
      );
    }

    const defaultTier = data.allowedTiers?.find((t) => t.isDefault);
    const tierId = defaultTier?.id ?? "free-tier";
    if (tierId !== "free-tier" && !envProjectId) {
      throw new OAuthFlowError(
        "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable.",
        "configuration",
      );
    }

    onProgress?.(
      "Provisioning Cloud Code Assist project (this may take a moment)...",
    );
    const onboardBody: Record<string, unknown> = {
      tierId,
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    };
    if (tierId !== "free-tier" && envProjectId) {
      onboardBody.cloudaicompanionProject = envProjectId;
      (onboardBody.metadata as Record<string, unknown>).duetProject =
        envProjectId;
    }

    const onboardResponse = await oauthFetch(
      `${GEMINI_CLI_ENDPOINT}/v1internal:onboardUser`,
      { method: "POST", headers, body: JSON.stringify(onboardBody) },
      signal,
    );
    if (!onboardResponse.ok) {
      const errorText = await onboardResponse.text();
      throw new OAuthFlowError(
        `onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
        "provisioning",
        onboardResponse.status,
      );
    }

    let lro = (await onboardResponse.json()) as LongRunningOperation;
    if (!lro.done && lro.name) {
      lro = await pollOperation(
        `${GEMINI_CLI_ENDPOINT}/v1internal`,
        lro.name,
        headers,
        signal,
        onProgress,
        24,
        5_000,
      );
    }

    const projectId = lro.response?.cloudaicompanionProject?.id;
    if (projectId) return projectId;
    if (envProjectId) return envProjectId;
    throw new OAuthFlowError(
      "Could not discover or provision a Google Cloud project. Try setting GOOGLE_CLOUD_PROJECT.",
      "validation",
    );
  },
};

const antigravityId = [
  "1071006060591",
  "-tmhssin2h21lcre235vtolojh4g403ep",
  ".apps.googleusercontent.com",
].join("");
const antigravitySec = [
  "GOCSPX",
  "-K58FWR486LdLJ1mLB8sXC4z6qDAf",
].join("");

const antigravityVariant: VariantConfig = {
  label: "Antigravity",
  clientId: antigravityId,
  clientSecret: antigravitySec,
  callbackPort: 51121,
  callbackPath: "/oauth-callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  async discoverProject(accessToken, onProgress, signal) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
    };
    const loadCodeAssist = async (): Promise<AntigravityLoadPayload> => {
      const first = (await postJson(
        `${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
        headers,
        { metadata: { ideType: "ANTIGRAVITY" } },
        signal,
      )) as AntigravityLoadPayload;
      if (first.paidTier === undefined && first.cloudaicompanionProject) {
        return (await postJson(
          `${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
          headers,
          {
            cloudaicompanionProject: first.cloudaicompanionProject,
            metadata: { ideType: "ANTIGRAVITY" },
          },
          signal,
        )) as AntigravityLoadPayload;
      }
      return first;
    };

    onProgress?.("Checking Antigravity account status...");
    const initial = await loadCodeAssist();

    const freeAllowed =
      initial.allowedTiers?.some((t) => t.id === "free-tier") === true;
    if (!freeAllowed) {
      const ineligibility = initial.ineligibleTiers?.find(
        (t) => t.tierId === "free-tier",
      );
      if (ineligibility?.reasonMessage) {
        throw new OAuthFlowError(
          `${ineligibility.reasonMessage}${ineligibility.validationUrl ? `\n${ineligibility.validationUrl}` : ""}`,
          "provisioning",
        );
      }
    }

    if (initial.currentTier === undefined) {
      onProgress?.("Provisioning the Antigravity free tier...");
      const deadline = Date.now() + 30_000;
      let operation = (await postJson(
        `${ANTIGRAVITY_ENDPOINT}/v1internal:onboardUser`,
        headers,
        { tierId: "free-tier", metadata: { ideType: "ANTIGRAVITY" } },
        signal,
      )) as {
        name?: string;
        done?: boolean;
        error?: { code?: number; message?: string };
      };

      for (;;) {
        if (operation.done === true) {
          if (operation.error) {
            const { code, message } = operation.error;
            throw new OAuthFlowError(
              `onboardUser failed: ${code ? `${code}: ` : ""}${message ?? "unknown"}`,
              "provisioning",
            );
          }
          break;
        }
        if (Date.now() >= deadline)
          throw new OAuthFlowError(
            "onboardUser timed out after 30s",
            "timeout",
          );
        await sleepUnlessAborted(1_000, signal);
        if (!operation.name) {
          throw new OAuthFlowError(
            "onboardUser returned an operation without a name",
            "provisioning",
          );
        }
        const pollResponse = await oauthFetch(
          `${ANTIGRAVITY_ENDPOINT}/v1internal/${operation.name}`,
          { method: "GET", headers },
          signal,
        );
        if (pollResponse.status !== 200) {
          throw new OAuthFlowError(
            `operation poll failed: ${pollResponse.status} ${pollResponse.statusText}`,
            "provisioning",
            pollResponse.status,
          );
        }
        operation = (await pollResponse.json()) as typeof operation;
      }
    }

    onProgress?.("Refreshing Cloud Code Assist project...");
    const refreshed = await loadCodeAssist();
    const projectId = refreshed.cloudaicompanionProject;
    if (projectId && projectId.length > 0) return projectId;
    throw new OAuthFlowError(
      "loadCodeAssist did not return a cloudaicompanionProject",
      "provisioning",
    );
  },
};

const VARIANTS: Record<GoogleVariantId, VariantConfig> = {
  antigravity: antigravityVariant,
  "gemini-cli": geminiCliVariant,
};

class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

interface GeminiCliLoadPayload {
  cloudaicompanionProject?: string;
  currentTier?: { id?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface AntigravityLoadPayload {
  currentTier?: { id?: string } | null;
  paidTier?: { id?: string } | null;
  allowedTiers?: Array<{ id?: string }>;
  ineligibleTiers?: Array<{
    tierId?: string;
    reasonMessage?: string;
    validationUrl?: string;
  }>;
  cloudaicompanionProject?: string;
}

interface LongRunningOperation {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
}

async function oauthFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal: requestSignal });
  } catch (err) {
    if (signal?.aborted)
      throw new Error(`OAuth login cancelled: ${String(signal.reason)}`);
    if (timeoutSignal.aborted) {
      throw new OAuthFlowError(
        `Timed out after ${OAUTH_REQUEST_TIMEOUT_MS}ms waiting for ${url}`,
        "timeout",
      );
    }
    throw err;
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await oauthFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    signal,
  );
  if (response.status !== 200) {
    const errorText = await response.text();
    throw new OAuthFlowError(
      `${url} failed: ${response.status} ${response.statusText}: ${errorText}`,
      "provisioning",
      response.status,
    );
  }
  return response.json();
}

async function pollOperation(
  baseUrl: string,
  operationName: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onProgress: ((m: string) => void) | undefined,
  maxAttempts: number,
  intervalMs: number,
): Promise<LongRunningOperation> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      onProgress?.(
        `Waiting for project provisioning (attempt ${attempt + 1}/${maxAttempts})...`,
      );
      await sleepUnlessAborted(intervalMs, signal);
    }
    if (signal?.aborted) throw new Error("OAuth login cancelled");
    const response = await oauthFetch(
      `${baseUrl}/${operationName}`,
      { method: "GET", headers },
      signal,
    );
    if (!response.ok) {
      throw new OAuthFlowError(
        `Failed to poll operation: ${response.status} ${response.statusText}`,
        "polling",
        response.status,
      );
    }
    const data = (await response.json()) as LongRunningOperation;
    if (data.done) return data;
  }
  throw new OAuthFlowError(
    `Project provisioning did not complete after ${maxAttempts} attempts`,
    "timeout",
  );
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("OAuth login cancelled"));
      },
      { once: true },
    );
  });
}

function isVpcScAffectedUser(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return false;
  const error = (payload as { error?: { details?: Array<{ reason?: string }> } })
    .error;
  return (
    Array.isArray(error?.details) &&
    error.details.some((d) => d?.reason === "SECURITY_POLICY_VIOLATED")
  );
}

interface CallbackHandle {
  port: number;
  redirectUri: string;
  result: Promise<{ code: string; state: string }>;
  close(): void;
}

const RESULT_PAGE = (ok: boolean, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Pi login</title></head>
<body style="font-family: system-ui, sans-serif; background: #1e1e2e; color: #cdd6f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
<div style="text-align: center;">
<div style="font-size: 42px;">${ok ? "✅" : "❌"}</div>
<h2>${ok ? "Authentication successful" : "Authentication failed"}</h2>
<p style="opacity: .7;">${detail}</p>
<p style="opacity: .5;">You can close this tab and return to the terminal.</p>
</div>
</body></html>`;

function serveCallback(
  hostname: string,
  port: number,
  callbackPath: string,
  expectedState: string,
  resolve: (r: { code: string; state: string }) => void,
  reject: (e: Error) => void,
): Promise<http.Server> {
  return new Promise((listenResolve, listenReject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${hostname}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end("Not Found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      const error = url.searchParams.get("error") ?? "";
      const errorDescription =
        url.searchParams.get("error_description") ?? error;

      if (error) {
        res
          .writeHead(500, { "Content-Type": "text/html" })
          .end(RESULT_PAGE(false, errorDescription));
        if (!expectedState || state === expectedState) {
          reject(
            new OAuthFlowError(
              `Authorization failed: ${errorDescription}`,
              "user-denied",
            ),
          );
        }
        return;
      }
      if (!code) {
        res
          .writeHead(500, { "Content-Type": "text/html" })
          .end(RESULT_PAGE(false, "Missing authorization code"));
        return;
      }
      if (expectedState && state !== expectedState) {
        res
          .writeHead(500, { "Content-Type": "text/html" })
          .end(RESULT_PAGE(false, "State mismatch"));
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(RESULT_PAGE(true, "You may now return to pi."));
      resolve({ code, state });
    });
    server.once("error", listenReject);
    server.listen(port, hostname, () => listenResolve(server));
  });
}

async function startCallbackServer(
  callbackPath: string,
  preferredPort: number,
  expectedState: string,
): Promise<CallbackHandle> {
  const {
    promise: resultPromise,
    resolve,
    reject,
  } = Promise.withResolvers<{ code: string; state: string }>();
  let primary: http.Server;
  let primaryPort: number;
  try {
    primary = await serveCallback(
      "127.0.0.1",
      preferredPort,
      callbackPath,
      expectedState,
      resolve,
      reject,
    );
    const addr = primary.address();
    primaryPort =
      addr && typeof addr === "object" ? addr.port : preferredPort;
  } catch {
    primary = await serveCallback(
      "127.0.0.1",
      0,
      callbackPath,
      expectedState,
      resolve,
      reject,
    );
    primaryPort = (primary.address() as { port: number }).port;
  }

  try {
    await serveCallback(
      "::1",
      primaryPort,
      callbackPath,
      expectedState,
      resolve,
      reject,
    );
  } catch {
    /* IPv6 loopback fallback */
  }

  return {
    port: primaryPort,
    redirectUri: `http://127.0.0.1:${primaryPort}${callbackPath}`,
    result: resultPromise,
    close() {
      primary.close();
      primary.closeAllConnections?.();
    },
  };
}

export function parseCallbackInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  const [code, state] = value.split("#", 2);
  return { code, state };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function postToken(
  _variant: VariantConfig,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const response = await oauthFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    },
    signal,
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OAuthFlowError(
      `Google token endpoint failed (${response.status}): ${detail}`,
      "token-exchange",
      response.status,
    );
  }
  return (await response.json()) as TokenResponse;
}

async function getUserEmail(
  accessToken: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await oauthFetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      signal,
    );
    if (response.ok) {
      const data = (await response.json()) as { email?: string };
      return data.email;
    }
  } catch {
    /* email optional */
  }
  return undefined;
}

export async function loginGoogle(
  cb: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const selection = await cb.onSelect({
    message: "Authenticate as which Google client?",
    options: [
      {
        id: "antigravity",
        label:
          "Antigravity — newest Gemini models (daily-cloudcode-pa)",
      },
      {
        id: "gemini-cli",
        label:
          "Gemini CLI — standard Cloud Code Assist (cloudcode-pa)",
      },
    ],
  });
  if (!selection) throw new Error("Login cancelled");
  const variantId = (
    selection === "gemini-cli" ? "gemini-cli" : "antigravity"
  ) as GoogleVariantId;
  const variant = VARIANTS[variantId];

  const state = randomBytes(16).toString("hex");
  if (cb.signal?.aborted) throw new Error("Login cancelled");

  const handle = await startCallbackServer(
    variant.callbackPath,
    variant.callbackPort,
    state,
  );
  try {
    const authParams = new URLSearchParams({
      client_id: variant.clientId,
      response_type: "code",
      redirect_uri: handle.redirectUri,
      scope: variant.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    cb.onAuth({ url: `${AUTH_URL}?${authParams.toString()}` });
    cb.onProgress?.(
      handle.port === variant.callbackPort
        ? `[${variant.label}] Waiting for browser authentication...`
        : `[${variant.label}] Port ${variant.callbackPort} was busy; using ${handle.redirectUri}. Waiting for browser authentication...`,
    );

    const timeoutSignal = AbortSignal.timeout(CALLBACK_TIMEOUT_MS);
    const waitSignal = cb.signal
      ? AbortSignal.any([cb.signal, timeoutSignal])
      : timeoutSignal;

    let code: string | undefined;
    try {
      const waits: Array<Promise<{ code: string; state: string }>> = [
        handle.result,
      ];
      if (cb.onManualCodeInput) {
        const manual = (async () => {
          for (;;) {
            const input = await cb.onManualCodeInput!();
            const parsed = parseCallbackInput(input);
            if (parsed.code && (!parsed.state || parsed.state === state)) {
              return { code: parsed.code, state: parsed.state ?? "" };
            }
          }
        })();
        waits.push(manual);
      }
      code = (
        await Promise.race([
          Promise.race(waits),
          new Promise<never>((_, reject) =>
            waitSignal.addEventListener(
              "abort",
              () =>
                reject(
                  new Error(
                    `OAuth login cancelled or timed out: ${String(waitSignal.reason)}`,
                  ),
                ),
              { once: true },
            ),
          ),
        ])
      ).code;
    } catch (err) {
      if (timeoutSignal.aborted)
        throw new OAuthFlowError(
          "Timed out waiting for the browser callback (5 min).",
          "timeout",
        );
      throw err;
    }

    cb.onProgress?.(
      `[${variant.label}] Exchanging authorization code for tokens...`,
    );
    const tokenData = await postToken(
      variant,
      {
        client_id: variant.clientId,
        client_secret: variant.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: handle.redirectUri,
      },
      cb.signal,
    );
    if (!tokenData.refresh_token) {
      throw new OAuthFlowError(
        "No refresh token received — please retry the login.",
        "validation",
      );
    }

    cb.onProgress?.(`[${variant.label}] Getting user info...`);
    const email = await getUserEmail(tokenData.access_token, cb.signal);

    cb.onProgress?.(
      `[${variant.label}] Discovering Cloud Code Assist project...`,
    );
    const projectId = await variant.discoverProject(
      tokenData.access_token,
      cb.onProgress,
      cb.signal,
    );

    return {
      variant: variantId,
      refresh: tokenData.refresh_token,
      access: tokenData.access_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      projectId,
      email,
    } satisfies GoogleOauthCredential;
  } finally {
    handle.close();
  }
}

export async function refreshGoogleToken(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (signal?.aborted) throw new Error("Refresh cancelled");
  const cred = credentials as GoogleOauthCredential;
  const variantId = cred.variant ?? "antigravity";
  const variant = VARIANTS[variantId] ?? VARIANTS.antigravity;
  const data = await postToken(
    variant,
    {
      client_id: variant.clientId,
      client_secret: variant.clientSecret,
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    },
    signal,
  );
  return {
    ...credentials,
    variant: variantId,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId: cred.projectId,
    email: cred.email,
  } satisfies GoogleOauthCredential;
}

export function googleCredentialApiKey(credentials: OAuthCredentials): string {
  const cred = credentials as GoogleOauthCredential;
  return JSON.stringify({
    token: credentials.access,
    projectId: cred.projectId,
    variant: cred.variant ?? "antigravity",
  });
}

const INT63_MASK = (1n << 63n) - 1n;
function signedDecimalSessionId(value: bigint): string {
  return `-${(value & INT63_MASK).toString()}`;
}
export function deriveAntigravitySessionId(
  firstUserText: string | undefined,
): string {
  if (firstUserText && firstUserText.trim().length > 0) {
    const digest = createHash("sha256").update(firstUserText).digest();
    let value = 0n;
    for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i] ?? 0);
    return signedDecimalSessionId(value);
  }
  return signedDecimalSessionId(
    BigInt(`0x${randomBytes(8).toString("hex")}`) %
      9_000_000_000_000_000_000n,
  );
}

// ---------------------------------------------------------------------------
// CCA Request building & streaming
// ---------------------------------------------------------------------------

interface ThinkingConfig {
  includeThoughts: boolean;
  thinkingLevel?: GoogleThinkingLevel;
  thinkingBudget?: number;
}

function isGemini3Pro(id: string): boolean {
  return /gemini-3(?:\.\d+)?-pro/.test(id.toLowerCase());
}
function isGemini3Flash(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-flash/.test(lower) ||
    lower === "gemini-flash-latest" ||
    lower === "gemini-flash-lite-latest"
  );
}

function thinkingConfigFor(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): ThinkingConfig | undefined {
  if (!model.reasoning) return undefined;

  if (!options?.reasoning) {
    if (isGemini3Pro(model.id))
      return { includeThoughts: false, thinkingLevel: "LOW" };
    if (isGemini3Flash(model.id))
      return { includeThoughts: false, thinkingLevel: "MINIMAL" };
    return { includeThoughts: false, thinkingBudget: 0 };
  }

  const effort: ThinkingLevel = options.reasoning;
  if (isGemini3Pro(model.id)) {
    return {
      includeThoughts: true,
      thinkingLevel:
        effort === "minimal" || effort === "low" ? "LOW" : "HIGH",
    };
  }
  if (isGemini3Flash(model.id)) {
    const level: GoogleThinkingLevel =
      effort === "minimal"
        ? "MINIMAL"
        : effort === "low"
          ? "LOW"
          : effort === "medium"
            ? "MEDIUM"
            : "HIGH";
    return { includeThoughts: true, thinkingLevel: level };
  }
  const budgets: Record<string, Partial<Record<ThinkingLevel, number>>> = {
    "gemini-2.5-pro": {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32_768,
    },
    "gemini-2.5-flash-lite": {
      minimal: 512,
      low: 2048,
      medium: 8192,
      high: 24_576,
    },
    "gemini-2.5-flash": {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24_576,
    },
  };
  const budget = (budgets[model.id] ?? {})[effort];
  return { includeThoughts: true, thinkingBudget: budget ?? -1 };
}

interface CcaRequest {
  project: string;
  model: string;
  request: {
    contents: GeminiContent[];
    sessionId?: string;
    systemInstruction?: { role?: string; parts: { text: string }[] };
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      thinkingConfig?: ThinkingConfig;
    };
    tools?: { functionDeclarations: unknown[] }[];
    toolConfig?: { functionCallingConfig: { mode: string } };
    labels?: Record<string, string>;
  };
  requestType?: string;
  userAgent?: string;
  requestId?: string;
}

const antigravitySession = {
  agentId: undefined as string | undefined,
  trajectoryId: undefined as string | undefined,
  sessionId: undefined as string | undefined,
  stepIndex: undefined as number | undefined,
  lastExecutionId: undefined as string | undefined,
};

function firstUserText(context: Context): string | undefined {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const firstText = message.content.find((item) => item.type === "text");
      return firstText && "text" in firstText ? firstText.text : undefined;
    }
    return undefined;
  }
  return undefined;
}

function buildCcaRequest(
  model: Model<Api>,
  context: Context,
  projectId: string,
  options: SimpleStreamOptions | undefined,
  isAntigravity: boolean,
): CcaRequest {
  const wireModel: ModelWire = {
    id: model.id,
    provider: model.provider,
    api: model.api,
    input: model.input,
  };
  const contents = convertMessages(wireModel, context);
  const generationConfig: CcaRequest["request"]["generationConfig"] = {};
  if (options?.temperature !== undefined)
    generationConfig.temperature = options.temperature;
  if (options?.maxTokens !== undefined)
    generationConfig.maxOutputTokens = options.maxTokens;

  const thinking = thinkingConfigFor(model, options);
  if (thinking) generationConfig.thinkingConfig = thinking;

  const request: CcaRequest["request"] = { contents };
  if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
    request.systemInstruction = {
      ...(isAntigravity ? { role: "user" } : {}),
      parts: [{ text: context.systemPrompt }],
    };
  }
  if (context.tools && context.tools.length > 0) {
    request.tools = convertTools(context.tools);
    if (isAntigravity) {
      request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
    }
  }
  if (Object.keys(generationConfig).length > 0)
    request.generationConfig = generationConfig;

  if (!isAntigravity) return { project: projectId, model: model.id, request };

  const wireModelId = antigravityWireModelId(model.id, options?.reasoning);
  const profile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];
  if (profile) generationConfig.maxOutputTokens = profile.maxOutputTokens;

  const state = antigravitySession;
  state.agentId ??= randomUUID();
  state.trajectoryId ??= randomUUID();
  state.sessionId ??= deriveAntigravitySessionId(firstUserText(context));
  state.stepIndex = (state.stepIndex ?? 1) + 1;
  const requestId = `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`;
  const labels: Record<string, string> = {};
  if (state.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
  labels.last_step_index = String((state.stepIndex ?? 2) - 1);
  if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
  labels.trajectory_id = state.trajectoryId;

  request.labels = labels;
  request.sessionId = state.sessionId;
  return {
    project: projectId,
    requestId,
    request,
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
  };
}

interface CcaResponseChunk {
  response?: {
    candidates?: Array<{
      content?: { role: string; parts?: GeminiPart[] };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    responseId?: string;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  error?: { code?: number; message?: string; status?: string };
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data: ")) yield line.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function isPlanningLeakPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  const afterBrace = trimmed.slice(1).trimStart();
  if (afterBrace === "") return trimmed.length <= 100;
  if (afterBrace[0] !== '"') return false;
  const nextQuote = afterBrace.indexOf('"', 1);
  if (nextQuote === -1) {
    const keyPrefix = afterBrace.slice(1);
    return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
  }
  const key = afterBrace.slice(1, nextQuote);
  if (key !== "thought") return false;
  const afterKey = afterBrace.slice(nextQuote + 1).trimStart();
  if (afterKey === "") return trimmed.length <= 100;
  return afterKey[0] === ":";
}

function splitLeadingJsonObject(
  text: string,
  ignoreQuotes: boolean,
): { jsonText: string; rest: string } | undefined {
  const prefixLength = text.length - text.trimStart().length;
  const trimmed = text.slice(prefixLength);
  if (!trimmed.startsWith("{")) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && !ignoreQuotes) {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0)
        return {
          jsonText: trimmed.slice(0, i + 1),
          rest: trimmed.slice(i + 1),
        };
    }
  }
  return undefined;
}

function isPlanningLeakObject(
  parsed: unknown,
  toolNames: Set<string>,
): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  const hasThought = typeof record.thought === "string";
  const isOmpTool =
    typeof record.call === "string" && toolNames.has(record.call);
  const hasToolSignature =
    "_i" in record ||
    "paths" in record ||
    "command" in record ||
    ("path" in record && "content" in record);
  return hasThought || isOmpTool || hasToolSignature;
}

type BufferedPlanning =
  | { kind: "incomplete" }
  | { kind: "plain"; visibleText: string }
  | { kind: "leak"; visibleText: string };

function consumePlanningBuffer(
  text: string,
  toolNames: Set<string>,
  isFinal = false,
): BufferedPlanning {
  if (!isPlanningLeakPrefix(text)) return { kind: "plain", visibleText: text };

  const leading =
    splitLeadingJsonObject(text, false) ??
    splitLeadingJsonObject(text, true);

  if (!leading) {
    if (isFinal) {
      const trimmed = text.trim();
      const hasThoughtKey = trimmed.includes('"thought"');
      const hasToolKey = [...toolNames].some((name) =>
        trimmed.includes(`"${name}"`),
      );
      const hasToolSignature =
        trimmed.includes('"_i"') ||
        trimmed.includes('"paths"') ||
        trimmed.includes('"command"') ||
        (trimmed.includes('"path"') && trimmed.includes('"content"'));
      if (hasThoughtKey || hasToolKey || hasToolSignature)
        return { kind: "leak", visibleText: "" };
      return { kind: "plain", visibleText: text };
    }
    return { kind: "incomplete" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(leading.jsonText);
  } catch {
    const hasThoughtKey = leading.jsonText.includes('"thought"');
    const hasToolKey = [...toolNames].some((name) =>
      leading.jsonText.includes(`"${name}"`),
    );
    const isLeak = hasThoughtKey || hasToolKey;
    return isLeak
      ? { kind: "leak", visibleText: leading.rest }
      : { kind: "plain", visibleText: text };
  }

  return isPlanningLeakObject(parsed, toolNames)
    ? { kind: "leak", visibleText: leading.rest }
    : { kind: "plain", visibleText: text };
}

interface ParsedCredential {
  token: string;
  projectId: string;
  variant: GoogleVariantId;
}

function parseStoredCredential(apiKey: string | undefined): ParsedCredential {
  if (!apiKey) {
    throw new Error(
      "google provider is set up for Google OAuth (Cloud Code Assist). Run /login google to authenticate.",
    );
  }
  try {
    const parsed = JSON.parse(apiKey) as {
      token?: string;
      projectId?: string;
      variant?: string;
    };
    if (parsed.token && parsed.projectId) {
      return {
        token: parsed.token,
        projectId: parsed.projectId,
        variant:
          parsed.variant === "gemini-cli" ? "gemini-cli" : "antigravity",
      };
    }
  } catch {
    /* fallback to raw token */
  }
  return { token: apiKey, projectId: "", variant: "antigravity" };
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetriableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = `${error.name} ${error.message}`.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Request was aborted"));
      },
      { once: true },
    );
  });
}

async function doFetchWithRetry(
  url: string,
  init: RequestInit,
  options?: SimpleStreamOptions,
): Promise<Response> {
  const fetchImpl = options?.fetch ?? fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0)
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), options?.signal);
    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetchImpl(url, { ...init, signal });
      if (
        !response.ok &&
        isRetriableStatus(response.status) &&
        attempt < MAX_RETRIES
      ) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (options?.signal?.aborted) throw err;
      if (!isRetriableTransportError(err)) throw err;
    }
  }
  throw lastError;
}

async function isHeadroomProxyRunning(
  host: string,
  port: number,
): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveStreamingEndpoints(
  config: HeadroomConfig,
  isAntigravity: boolean,
): Promise<string[]> {
  const baseGoogleEndpoints = isAntigravity
    ? ANTIGRAVITY_ENDPOINTS
    : [GEMINI_CLI_ENDPOINT];

  if (config.routes.google !== false) {
    const proxyAlive = await isHeadroomProxyRunning(config.host, config.port);
    if (proxyAlive) {
      return [`http://${config.host}:${config.port}`, ...baseGoogleEndpoints];
    }
  }

  return baseGoogleEndpoints;
}

let toolCallCounter = 0;

export function streamGoogleCca(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: HeadroomConfig,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = performance.now();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      const credential = parseStoredCredential(options?.apiKey);
      const isAntigravity = credential.variant === "antigravity";
      const endpoints = await resolveStreamingEndpoints(config, isAntigravity);
      const body = JSON.stringify(
        buildCcaRequest(
          model,
          context,
          credential.projectId,
          options,
          isAntigravity,
        ),
      );
      const headers = {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(isAntigravity
          ? { "User-Agent": antigravityUserAgent() }
          : {
              "User-Agent": geminiCliUserAgent(model.id),
              "Client-Metadata":
                "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
            }),
        ...(options?.headers ?? {}),
      };

      const toolNames = new Set(context.tools?.map((t) => t.name) ?? []);
      const isLeakModel = model.id.includes("flash");
      let started = false;
      let firstTokenTime: number | undefined;
      const ensureStarted = () => {
        if (!started) {
          if (!firstTokenTime) firstTokenTime = performance.now();
          stream.push({ type: "start", partial: output });
          started = true;
        }
      };
      const resetOutput = () => {
        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        output.stopReason = "pending";
        output.errorMessage = undefined;
      };

      const consumeResponse = async (response: Response): Promise<boolean> => {
        if (!response.body)
          throw new Error("Cloud Code Assist: empty response body");

        let currentBlock:
          | { type: "text"; text: string; textSignature?: string }
          | { type: "thinking"; thinking: string; thinkingSignature?: string }
          | null = null;
        const blocks = output.content;
        const blockIndex = () => blocks.length - 1;

        let isBuffering = false;
        let textBuffer = "";
        let bufferedSignature: string | undefined;
        let sawContent = false;
        let lastResponseId: string | undefined;

        const endCurrentBlock = () => {
          if (!currentBlock) return;
          if (currentBlock.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: blockIndex(),
              content: currentBlock.text,
              partial: output,
            });
          } else {
            stream.push({
              type: "thinking_end",
              contentIndex: blockIndex(),
              content: currentBlock.thinking,
              partial: output,
            });
          }
          currentBlock = null;
        };
        const startTextBlock = () => {
          if (currentBlock?.type !== "text") {
            endCurrentBlock();
            currentBlock = { type: "text", text: "" };
            blocks.push(currentBlock);
            ensureStarted();
            stream.push({
              type: "text_start",
              contentIndex: blockIndex(),
              partial: output,
            });
          }
          return currentBlock;
        };
        const startThinkingBlock = () => {
          if (currentBlock?.type !== "thinking") {
            endCurrentBlock();
            currentBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: undefined,
            };
            blocks.push(currentBlock);
            ensureStarted();
            stream.push({
              type: "thinking_start",
              contentIndex: blockIndex(),
              partial: output,
            });
          }
          return currentBlock;
        };
        const emitText = (delta: string, signature?: string) => {
          if (!delta) return;
          const block = startTextBlock();
          block.text += delta;
          block.textSignature = retainThoughtSignature(
            block.textSignature,
            signature,
          );
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta,
            partial: output,
          });
        };
        const flushLeakBuffer = () => {
          if (!isBuffering) return;
          const buffered = consumePlanningBuffer(textBuffer, toolNames, true);
          if (buffered.kind !== "incomplete")
            emitText(buffered.visibleText, bufferedSignature);
          isBuffering = false;
          textBuffer = "";
          bufferedSignature = undefined;
        };

        for await (const data of readSseData(response.body)) {
          let chunk: CcaResponseChunk;
          try {
            chunk = JSON.parse(data) as CcaResponseChunk;
          } catch {
            continue;
          }

          if (chunk.error) {
            const detail =
              chunk.error.message || chunk.error.status || "unknown error";
            throw new Error(`Cloud Code Assist stream error: ${detail}`);
          }
          const responseData = chunk.response;
          if (!responseData) continue;
          if (responseData.responseId) lastResponseId = responseData.responseId;

          if (
            !responseData.candidates?.length &&
            responseData.promptFeedback?.blockReason
          ) {
            const detail = responseData.promptFeedback.blockReasonMessage;
            throw new Error(
              `Request blocked by Google (${responseData.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
            );
          }

          const candidate = responseData.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text !== undefined && part.text !== "") {
                sawContent = true;
                if (isThinkingPart(part)) {
                  flushLeakBuffer();
                  const block = startThinkingBlock();
                  block.thinking += part.text;
                  block.thinkingSignature = retainThoughtSignature(
                    block.thinkingSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: blockIndex(),
                    delta: part.text,
                    partial: output,
                  });
                } else if (
                  isLeakModel &&
                  (isBuffering || part.text.trimStart().startsWith("{"))
                ) {
                  isBuffering = true;
                  textBuffer += part.text;
                  bufferedSignature = retainThoughtSignature(
                    bufferedSignature,
                    part.thoughtSignature,
                  );
                  const buffered = consumePlanningBuffer(textBuffer, toolNames);
                  if (buffered.kind !== "incomplete") {
                    isBuffering = false;
                    textBuffer = "";
                    const signature = bufferedSignature;
                    bufferedSignature = undefined;
                    emitText(buffered.visibleText, signature);
                  }
                } else {
                  emitText(part.text, part.thoughtSignature);
                }
              } else if (
                part.text === "" &&
                part.thoughtSignature &&
                !part.functionCall
              ) {
                if (currentBlock?.type === "thinking") {
                  currentBlock.thinkingSignature = retainThoughtSignature(
                    currentBlock.thinkingSignature,
                    part.thoughtSignature,
                  );
                } else if (currentBlock?.type === "text") {
                  currentBlock.textSignature = retainThoughtSignature(
                    currentBlock.textSignature,
                    part.thoughtSignature,
                  );
                }
              }

              if (part.functionCall) {
                flushLeakBuffer();
                endCurrentBlock();
                sawContent = true;
                const providedId = part.functionCall.id;
                const needsNewId =
                  !providedId ||
                  output.content.some(
                    (b) => b.type === "toolCall" && b.id === providedId,
                  );
                const toolCallId = needsNewId
                  ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                  : providedId;
                const toolCall = {
                  type: "toolCall" as const,
                  id: toolCallId,
                  name: part.functionCall.name || "",
                  arguments: part.functionCall.args ?? {},
                  ...(part.thoughtSignature && {
                    thoughtSignature: part.thoughtSignature,
                  }),
                };
                blocks.push(toolCall);
                ensureStarted();
                stream.push({
                  type: "toolcall_start",
                  contentIndex: blockIndex(),
                  partial: output,
                });
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex(),
                  delta: JSON.stringify(toolCall.arguments),
                  partial: output,
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: blockIndex(),
                  toolCall,
                  partial: output,
                });
              }
            }
          }

          if (candidate?.finishReason) {
            output.rawStopReason = candidate.finishReason;
            output.stopReason = mapStopReasonString(candidate.finishReason);
            if (
              output.content.some((b) => b.type === "toolCall") &&
              output.stopReason === "stop"
            ) {
              output.stopReason = "toolUse";
            }
          }

          if (responseData.usageMetadata) {
            const u = responseData.usageMetadata;
            const promptTokens = u.promptTokenCount || 0;
            const cacheRead = u.cachedContentTokenCount || 0;
            const thinking = u.thoughtsTokenCount || 0;
            output.usage = {
              input: promptTokens - cacheRead,
              output: (u.candidatesTokenCount || 0) + thinking,
              cacheRead,
              cacheWrite: 0,
              totalTokens: u.totalTokenCount || 0,
              ...(thinking > 0 ? { reasoning: thinking } : {}),
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            calculateCost(model, output.usage);
          }
        }

        flushLeakBuffer();
        endCurrentBlock();
        if (isAntigravity) {
          antigravitySession.lastExecutionId = lastResponseId;
        }
        return sawContent;
      };

      const MAX_EMPTY_RETRIES = 3;
      let succeeded = false;
      for (
        let endpointIndex = 0;
        endpointIndex < endpoints.length && !succeeded;
        endpointIndex++
      ) {
        const endpoint = endpoints[endpointIndex]!;
        const isLastEndpoint = endpointIndex === endpoints.length - 1;
        for (let attempt = 0; ; attempt++) {
          if (options?.signal?.aborted) throw new Error("Request was aborted");

          let response: Response;
          try {
            response = await doFetchWithRetry(
              `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
              { method: "POST", headers, body },
              options,
            );
          } catch (err) {
            if (options?.signal?.aborted) throw new Error("Request was aborted");
            if (!isLastEndpoint && isRetriableTransportError(err)) break;
            throw err;
          }

          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            if (isRetriableStatus(response.status) && attempt < MAX_EMPTY_RETRIES) {
              await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
              resetOutput();
              continue;
            }
            if (!isLastEndpoint && isRetriableStatus(response.status)) break;
            throw new Error(
              `Cloud Code Assist API error (${response.status}): ${errorText}`,
            );
          }

          let meaningful = false;
          try {
            meaningful = await consumeResponse(response);
          } catch (err) {
            if (options?.signal?.aborted) throw new Error("Request was aborted");
            if (isRetriableTransportError(err) && attempt < MAX_EMPTY_RETRIES) {
              await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
              resetOutput();
              continue;
            }
            throw err;
          }

          if (output.stopReason !== "pending" || meaningful) {
            succeeded = true;
            break;
          }
          if (attempt >= MAX_EMPTY_RETRIES) break;
          resetOutput();
        }
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "pending") {
        throw new Error(
          "Cloud Code Assist stream ended without a finish reason (connection dropped or empty response)",
        );
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(
          output.errorMessage ||
            `Generation failed with finish reason: ${output.rawStopReason}`,
        );
      }
      if (output.content.length === 0) {
        throw new Error("Cloud Code Assist API returned an empty response");
      }

      // SAFETY: attach extra performance timing metadata to output object
      (output as unknown as Record<string, unknown>).duration =
        performance.now() - startTime;
      if (firstTokenTime) {
        // SAFETY: attach ttft timing metadata to output object
        (output as unknown as Record<string, unknown>).ttft =
          firstTokenTime - startTime;
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      // SAFETY: attach extra performance timing metadata to output object
      (output as unknown as Record<string, unknown>).duration =
        performance.now() - startTime;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
