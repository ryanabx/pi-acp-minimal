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
	requestCancelled: -32800,
} as const;

export function invalidRequest(message: string): RequestError {
	return new RequestError(CODES.invalidRequest, message);
}

export function invalidParams(message: string, data?: unknown): RequestError {
	return new RequestError(CODES.invalidParams, message, data);
}

export function internalError(message: string, data?: unknown): RequestError {
	return new RequestError(CODES.internalError, message, data);
}

export function authRequired(message: string): RequestError {
	return new RequestError(CODES.authRequired, message);
}

export function resourceNotFound(message: string, data?: unknown): RequestError {
	return new RequestError(CODES.resourceNotFound, message, data);
}

export function requestCancelled(message: string): RequestError {
	return new RequestError(CODES.requestCancelled, message);
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
