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

/** What a provider says when it rejects the credentials pi sent. */
const AUTH_FAILURE =
	/\b401\b|\bunauthorized\b|\bauthentication\b|(?:invalid|missing|expired)[ _-]*(?:api[ _-]*)?(?:key|token)/i;

/**
 * The error for a turn pi ended in its `error` state.
 *
 * pi reports a provider failure as text only. A rejected credential is told
 * apart from the rest so a client can react to it: it gets ACP's
 * `auth_required` code, with pi's message unchanged.
 */
export function providerError(message: string): RequestError {
	return AUTH_FAILURE.test(message) ? authRequired(message) : internalError(message);
}
