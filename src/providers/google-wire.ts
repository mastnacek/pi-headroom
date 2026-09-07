/**
 * Google wire converters and schema normalizers (ported for pi-headroom).
 */
import type {
	Context,
	Message,
	Model,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";

export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface ModelWire {
	id: string;
	provider: string;
	api: string;
	input: ("text" | "image")[];
}

export interface GeminiPart {
	text?: string;
	thoughtSignature?: string;
	functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
	functionResponse?: {
		name?: string;
		response?: Record<string, unknown>;
		id?: string;
	};
	inlineData?: { mimeType: string; data: string };
	fileData?: { mimeType: string; fileUri: string };
}

export interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

export function isThinkingPart(part: GeminiPart): boolean {
	if (part.text === undefined || part.text === "") return false;
	const isOmpThought =
		Boolean(part.thoughtSignature) &&
		!part.functionCall &&
		!part.functionResponse &&
		!part.inlineData &&
		!part.fileData;
	return isOmpThought;
}

export function retainThoughtSignature(
	current: string | undefined,
	incoming: string | undefined,
): string | undefined {
	if (incoming && incoming.length > 0) return incoming;
	return current;
}

export function mapStopReasonString(
	reason: string | undefined,
): "stop" | "length" | "toolUse" | "error" | "aborted" {
	if (!reason) return "stop";
	const upper = reason.toUpperCase();
	if (upper === "STOP" || upper === "END_TURN") return "stop";
	if (upper === "MAX_TOKENS" || upper === "LENGTH") return "length";
	if (upper === "TOOL_USE" || upper === "FUNCTION_CALL") return "toolUse";
	if (upper === "SAFETY" || upper === "RECITATION" || upper === "BLOCKLIST")
		return "error";
	if (upper === "USER_CANCELLED" || upper === "ABORTED") return "aborted";
	return "stop";
}

const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/g;

function sanitizeSurrogates(text: string): string {
	const placeholders: string[] = [];
	const preserved = text.replace(SURROGATE_PAIR_RE, (match) => {
		placeholders.push(match);
		return `\u0000${placeholders.length - 1}\u0000`;
	});
	const sanitized = preserved.replace(LONE_SURROGATE_RE, "\uFFFD");
	return sanitized.replace(
		/\u0000(\d+)\u0000/g,
		(_, index) => placeholders[Number(index)] ?? "\uFFFD",
	);
}

type AnyContent = { type: string; [k: string]: unknown };

function isImageContent(b: AnyContent | { type: string }): boolean {
	return (
		b.type === "image" &&
		"data" in b &&
		typeof b.data === "string" &&
		"mimeType" in b &&
		typeof b.mimeType === "string"
	);
}

function downgradeUnsupportedImages(
	messages: Message[],
	model: ModelWire,
): Message[] {
	if (model.input.includes("image")) return messages;
	return messages.map((msg) => {
		if (msg.role !== "user" && msg.role !== "toolResult") return msg;
		if (typeof msg.content === "string") return msg;
		if (!Array.isArray(msg.content)) return msg;
		// SAFETY: content is array of structured content blocks
		const blocks = msg.content as unknown as AnyContent[];
		const hasImages = blocks.some(isImageContent);
		if (!hasImages) return msg;
		const next = blocks.map((b) => {
			if (isImageContent(b)) {
				return { type: "text" as const, text: `[image: ${String(b.mimeType)}]` };
			}
			return b;
		});
		// SAFETY: downgraded image blocks to text
		return { ...msg, content: next } as unknown as Message;
	});
}

export function transformMessages(
	messages: Message[],
	model: ModelWire,
	normalizeToolCallId?: (id: string) => string,
): Message[] {
	const toolCallIdMap = new Map<string, string>();
	const normalizedMessages = messages.map((msg) =>
		msg.content == null ? { ...msg, content: [] } : msg,
	);
	const imageAware = downgradeUnsupportedImages(normalizedMessages, model);

	const transformed = imageAware.map((msg) => {
		if (msg.role === "user") return msg;
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}
		if (msg.role === "assistant") {
			const assistantMsg = msg as Extract<Message, { role: "assistant" }> & {
				stopReason?: string;
			};
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;
			// SAFETY: assistant message content is array of structured blocks
			const contentBlocks = (Array.isArray(assistantMsg.content)
				? assistantMsg.content
				: []) as unknown as AnyContent[];
			const transformedContent = contentBlocks.flatMap((block) => {
				if (block.type === "thinking") {
					const thinking = block as {
						type: "thinking";
						thinking: string;
						thinkingSignature?: string;
						redacted?: boolean;
					};
					if (thinking.redacted) return isSameModel ? [block] : [];
					if (isSameModel && thinking.thinkingSignature) return [block];
					if (!thinking.thinking || thinking.thinking.trim() === "") return [];
					if (isSameModel) return [block];
					return [{ type: "text", text: thinking.thinking }];
				}
				if (block.type === "text") {
					if (isSameModel) return [block];
					return [{ type: "text", text: (block.text as string) ?? "" }];
				}
				if (block.type === "toolCall") {
					// SAFETY: block type narrowed to toolCall
					const toolCall = block as unknown as ToolCall;
					let normalized: unknown = toolCall;
					if (!isSameModel && toolCall.thoughtSignature) {
						const { thoughtSignature, ...rest } = toolCall;
						void thoughtSignature;
						normalized = rest;
					}
					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalized = { ...(normalized as ToolCall), id: normalizedId };
						}
					}
					return [normalized];
				}
				return [block];
			});
			// SAFETY: transformedContent matches assistant message content block shape
			return {
				...assistantMsg,
				content: transformedContent as unknown as typeof assistantMsg.content,
			};
		}
		return msg;
	});

	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const result: Message[] = [];

	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const call of pendingToolCalls) {
				if (!existingToolResultIds.has(call.id)) {
					result.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: "Tool execution was skipped" }],
						isError: true,
						timestamp: Date.now(),
					} as Message);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			insertSyntheticToolResults();
			const assistantMsg = msg as Extract<Message, { role: "assistant" }>;
			if (
				assistantMsg.stopReason === "error" ||
				assistantMsg.stopReason === "aborted"
			)
				continue;
			// SAFETY: rawContent is array of structured blocks
			const rawContent = (Array.isArray(assistantMsg.content)
				? assistantMsg.content
				: []) as unknown as AnyContent[];
			// SAFETY: content array is filtered to toolCall blocks
			const toolCalls = rawContent.filter(
				(b) => b.type === "toolCall",
			) as unknown as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}
			result.push(msg as Message);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(
				(msg as Extract<Message, { role: "toolResult" }>).toolCallId,
			);
			result.push(msg as Message);
		} else if (msg.role === "user") {
			insertSyntheticToolResults();
			result.push(msg as Message);
		} else {
			result.push(msg as Message);
		}
	}
	insertSyntheticToolResults();
	return result;
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(
	isSame: boolean,
	raw: string | undefined,
): string | undefined {
	if (!isSame) return undefined;
	return isValidThoughtSignature(raw) ? raw : undefined;
}

export function convertMessages(
	model: ModelWire,
	context: Context,
): GeminiContent[] {
	const transformed = transformMessages(context.messages, model);
	const contents: GeminiContent[] = [];
	let lastRole: "user" | "model" | null = null;
	const isSameProviderAndModel = (msg: Message) =>
		msg.role === "assistant" &&
		msg.provider === model.provider &&
		msg.api === model.api &&
		msg.model === model.id;

	for (const message of transformed) {
		if (message.role === "user") {
			const parts: GeminiPart[] = [];
			if (typeof message.content === "string") {
				if (message.content.length > 0)
					parts.push({ text: sanitizeSurrogates(message.content) });
			} else if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text" && block.text)
						parts.push({ text: sanitizeSurrogates(block.text) });
					else if (block.type === "image")
						parts.push({
							inlineData: { mimeType: block.mimeType, data: block.data },
						});
				}
			}
			if (parts.length === 0) continue;
			if (lastRole === "user") {
				contents.at(-1)?.parts.push(...parts);
			} else {
				contents.push({ role: "user", parts });
				lastRole = "user";
			}
		} else if (message.role === "assistant") {
			const isSame = isSameProviderAndModel(message);
			const parts: GeminiPart[] = [];
			const blocks = Array.isArray(message.content) ? message.content : [];
			const needsId = blocks.filter((b) => b.type === "toolCall").length > 1;

			for (const block of blocks) {
				if (block.type === "text") {
					if (!block.text) continue;
					const thoughtSignature = resolveThoughtSignature(
						isSame,
						block.textSignature,
					);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					const thinking = block as { thinking: string; thinkingSignature?: string };
					const thoughtSignature = resolveThoughtSignature(
						isSame,
						thinking.thinkingSignature,
					);
					if (isSame && thoughtSignature) {
						parts.push({
							text: sanitizeSurrogates(thinking.thinking || ""),
							thoughtSignature,
						});
					} else {
						if (!thinking.thinking || thinking.thinking.trim() === "") continue;
						parts.push({ text: sanitizeSurrogates(thinking.thinking) });
					}
				} else if (block.type === "toolCall") {
					// SAFETY: block type narrowed to toolCall
					const toolCall = block as unknown as ToolCall;
					const thoughtSignature = resolveThoughtSignature(
						isSameProviderAndModel(message),
						toolCall.thoughtSignature,
					);
					parts.push({
						functionCall: {
							name: toolCall.name,
							args: toolCall.arguments ?? {},
							...(needsId && { id: toolCall.id }),
						},
						...(thoughtSignature && { thoughtSignature }),
					});
				}
			}
			if (parts.length === 0) continue;
			contents.push({ role: "model", parts });
			lastRole = "model";
		} else if (message.role === "toolResult") {
			const parts: GeminiPart[] = [];
			const textParts: string[] = [];
			const images: Array<{ mimeType: string; data: string }> = [];

			if (typeof message.content === "string") {
				textParts.push(message.content);
			} else if (Array.isArray(message.content)) {
				for (const c of message.content) {
					if (c.type === "text") textParts.push(c.text);
					else if (c.type === "image")
						images.push({ mimeType: c.mimeType, data: c.data });
				}
			}

			const responseText = textParts.join("\n");
			const responseObj: Record<string, unknown> = {
				output: message.isError ? `Error: ${responseText}` : responseText,
			};
			if (images.length > 0) {
				responseObj.images = images.map((image) => `[Image: ${image.mimeType}]`);
			}

			parts.push({
				functionResponse: {
					name: message.toolName,
					response: responseObj,
					id: message.toolCallId,
				},
			});

			for (const img of images) {
				parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
			}

			if (lastRole === "user") {
				contents.at(-1)?.parts.push(...parts);
			} else {
				contents.push({ role: "user", parts });
				lastRole = "user";
			}
		}
	}

	return contents;
}

const UNSUPPORTED_FIELDS = new Set([
	"$schema",
	"additionalProperties",
	"patternProperties",
	"unevaluatedProperties",
	"minProperties",
	"maxProperties",
	"propertyNames",
	"minItems",
	"maxItems",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"contentEncoding",
	"contentMediaType",
	"contentSchema",
	"deprecated",
	"readOnly",
	"writeOnly",
	"examples",
	"allOf",
	"not",
]);

function isNullSchema(node: Record<string, unknown>): boolean {
	if (node.type === "null") return true;
	if (
		Array.isArray(node.enum) &&
		node.enum.length === 1 &&
		node.enum[0] === null
	)
		return true;
	return false;
}

function stringifyEnumValues(values: unknown[]): unknown[] {
	return values.map((v) =>
		v === null
			? "null"
			: typeof v === "string"
				? v
				: typeof v === "number" || typeof v === "boolean"
					? String(v)
					: String(v),
	);
}

export type NormalizedSchemaNode =
	| Record<string, unknown>
	| unknown[]
	| string
	| number
	| boolean
	| null;

function dereference(
	value: unknown,
	defs: Map<string, unknown>,
	seen: Set<unknown>,
	depth: number,
): NormalizedSchemaNode {
	if (depth > 32) return {};
	if (Array.isArray(value))
		return value.map((v) => dereference(v, defs, seen, depth + 1));
	if (typeof value !== "object" || value === null) {
		// SAFETY: non-object primitive value
		return value as NormalizedSchemaNode;
	}
	if (seen.has(value)) return {};
	seen.add(value);
	const record = value as Record<string, unknown>;
	const ref = record.$ref;
	if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
		const target = defs.get(ref.slice("#/$defs/".length));
		return target === undefined ? {} : dereference(target, defs, seen, depth + 1);
	}
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(record)) {
		if (key === "$defs" || key === "definitions") continue;
		out[key] = dereference(v, defs, seen, depth + 1);
	}
	return out;
}

function normalizeNode(value: unknown): NormalizedSchemaNode {
	if (typeof value === "boolean") return {};
	if (typeof value !== "object" || value === null) {
		// SAFETY: non-object primitive value
		return value as NormalizedSchemaNode;
	}
	if (Array.isArray(value)) return value.map(normalizeNode);

	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	for (const [key, raw] of Object.entries(record)) {
		if (UNSUPPORTED_FIELDS.has(key)) continue;

		if (key === "type") {
			if (Array.isArray(raw)) {
				const nonNull = raw.filter((t) => t !== "null");
				out.type =
					nonNull.length === 1
						? nonNull[0]
						: nonNull.length > 1
							? nonNull[0]
							: "string";
			} else {
				out.type = raw;
			}
			continue;
		}
		if (key === "enum") {
			if (Array.isArray(raw)) out.enum = stringifyEnumValues(raw);
			continue;
		}
		if (key === "anyOf" || key === "oneOf") {
			const branches = Array.isArray(raw) ? raw.map(normalizeNode) : [];
			const nonNull = branches.filter(
				(b) =>
					!(
						typeof b === "object" &&
						b !== null &&
						isNullSchema(b as Record<string, unknown>)
					),
			);
			if (nonNull.length === 0) out.type = "null";
			else out[key] = nonNull;
			continue;
		}
		if (key === "const") {
			out.enum = stringifyEnumValues([raw]);
			continue;
		}
		if (key === "properties" && typeof raw === "object" && raw !== null) {
			const props: Record<string, unknown> = {};
			for (const [name, schema] of Object.entries(
				raw as Record<string, unknown>,
			)) {
				props[name] = normalizeNode(schema);
			}
			out.properties = props;
			continue;
		}
		if (key === "items") {
			out.items = normalizeNode(raw);
			continue;
		}
		out[key] = raw;
	}

	if (out.enum !== undefined && out.type === undefined) out.type = "string";
	return out;
}

export function normalizeSchemaForWire(value: unknown): NormalizedSchemaNode {
	const root =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const defs = new Map<string, unknown>();
	for (const defKey of ["$defs", "definitions"]) {
		const defContainer = root[defKey];
		if (typeof defContainer === "object" && defContainer !== null) {
			for (const [name, schema] of Object.entries(
				defContainer as Record<string, unknown>,
			)) {
				defs.set(name, schema);
			}
		}
	}
	const dereferenced = dereference(value, defs, new Set(), 0);
	return normalizeNode(dereferenced);
}

export interface FunctionDeclaration {
	name: string;
	description: string;
	parametersJsonSchema: unknown;
}

export function convertTools(
	tools: Tool[],
): { functionDeclarations: FunctionDeclaration[] }[] {
	if (tools.length === 0) return [];
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description || "",
				parametersJsonSchema: normalizeSchemaForWire(tool.parameters),
			})),
		},
	];
}
