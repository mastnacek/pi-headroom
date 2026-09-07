import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HeadroomConfig } from "./types.js";

/**
 * Registers the headroom_retrieve agent tool for CCR (Cache-Compress-Retrieve) support.
 */
export function registerRetrieveTool(
  pi: ExtensionAPI,
  getConfig: () => HeadroomConfig,
): void {
  pi.registerTool({
    name: "headroom_retrieve",
    label: "Headroom Retrieve",
    description:
      "Retrieve original uncompressed content that was compressed by Headroom. " +
      "Use when you need full verbatim detail about something that was summarized or compressed.",
    promptSnippet: "Retrieve compressed context detail from Headroom cache",
    parameters: Type.Object({
      hash: Type.String({
        description: "Hash identifier for the compressed content to retrieve",
      }),
      query: Type.Optional(
        Type.String({
          description: "Optional search query to filter retrieved content",
        }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: { hash: string; query?: string },
      signal?: AbortSignal,
    ) {
      const config = getConfig();
      const retrieveUrl = `http://${config.host}:${config.port}/v1/retrieve/tool_call`;

      try {
        const body = {
          tool_call: {
            id: toolCallId,
            name: "headroom_retrieve",
            input: {
              hash: params.hash,
              query: params.query || null,
            },
          },
        };

        const timeoutSignal = AbortSignal.timeout(10_000);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;

        const response = await fetch(retrieveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: requestSignal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              {
                type: "text",
                text: `Retrieval failed (${response.status}): ${errorText}`,
              },
            ],
            details: { status: response.status, error: errorText } as Record<
              string,
              unknown
            >,
            isError: true,
          };
        }

        const data = (await response.json()) as {
          tool_result?: { content?: unknown };
        };

        if (data.tool_result) {
          const rawContent = data.tool_result.content;
          const content = Array.isArray(rawContent)
            ? rawContent
            : [
                {
                  type: "text",
                  text:
                    typeof rawContent === "string"
                      ? rawContent
                      : JSON.stringify(rawContent),
                },
              ];
          return {
            content,
            details: data as Record<string, unknown>,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: typeof data === "string" ? data : JSON.stringify(data),
            },
          ],
          details: data as Record<string, unknown>,
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Retrieval error: ${msg}`,
            },
          ],
          details: { error: msg } as Record<string, unknown>,
          isError: true,
        };
      }
    },
  });
}
