import { RequestError } from "@agentclientprotocol/sdk";

/**
 * JSON-RPC error constructors that put the human-readable text in `message`.
 *
 * The library's `RequestError` statics use fixed messages ("Internal error")
 * and stuff the detail into `data`, which most ACP clients do not surface.
 */
const CODES = {
	invalidRequest: -32600,
	invalidParams: -32602,
	internalError: -32603,
	authRequired: -32000,
	resourceNotFound: -32002,
} as const;

export function invalidRequest(message: string): RequestError {
	return new RequestError(CODES.invalidRequest, message);
}

export function invalidParams(message: string): RequestError {
	return new RequestError(CODES.invalidParams, message);
}

export function internalError(message: string, data?: unknown): RequestError {
	return new RequestError(CODES.internalError, message, data);
}

export function authRequired(message: string): RequestError {
	return new RequestError(CODES.authRequired, message);
}

export function resourceNotFound(message: string): RequestError {
	return new RequestError(CODES.resourceNotFound, message);
}
