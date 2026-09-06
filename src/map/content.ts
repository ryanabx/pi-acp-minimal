import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { PiContent, PiImageContent, PiMessage } from "../pi/rpc-types.js";

/** A pi `prompt` payload assembled from ACP content blocks. */
export interface PiPromptPayload {
	message: string;
	images: PiImageContent[];
}

/**
 * Flatten ACP prompt content into pi's `{ message, images }` shape.
 *
 * pi's RPC surface takes a single text message plus a list of images, so
 * resource links and embedded resources are inlined into the text: links become
 * `@path` mentions (which pi's own context loading understands) and embedded
 * text resources become fenced blocks so their contents survive the round trip.
 */
export function toPiPrompt(blocks: ContentBlock[]): PiPromptPayload {
	const parts: string[] = [];
	const images: PiImageContent[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				parts.push(block.text);
				break;
			case "image":
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				parts.push(`@${uriToPath(block.uri)}`);
				break;
			case "resource": {
				const resource = block.resource;
				if ("text" in resource) {
					const label = uriToPath(resource.uri);
					parts.push(`<context path="${label}">\n${resource.text}\n</context>`);
				} else {
					parts.push(`@${uriToPath(resource.uri)}`);
				}
				break;
			}
			case "audio":
				// Not advertised in promptCapabilities; mention it rather than dropping it silently.
				parts.push("[unsupported audio attachment omitted]");
				break;
		}
	}

	return { message: parts.join("\n\n").trim(), images };
}

/** Strip a `file://` scheme so paths read naturally in prompts and tool titles. */
export function uriToPath(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	try {
		return decodeURIComponent(new URL(uri).pathname);
	} catch {
		return uri.slice("file://".length);
	}
}

/** Convert pi message content into ACP content blocks. */
export function toAcpContentBlocks(content: string | PiContent[] | undefined): ContentBlock[] {
	if (content === undefined) return [];
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];

	const blocks: ContentBlock[] = [];
	for (const part of content) {
		if (part.type === "text") {
			if (part.text) blocks.push({ type: "text", text: part.text });
		} else {
			blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return blocks;
}

/** Concatenate the text of pi content parts, ignoring images. */
export function contentToText(content: string | PiContent[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is Extract<PiContent, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** Extract the assistant text of a pi message, ignoring thinking and tool calls. */
export function assistantText(message: PiMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}
