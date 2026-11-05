/**
 * pi protocol conformance: src/pi/rpc-types.ts against pi's published types.
 *
 * The adapter mirrors pi's RPC protocol by hand so it stays a plain JSONL
 * client with no dependency on pi. This file, compiled by
 * `npm run check:pi-protocol`, proves the mirror matches the pi version pinned
 * in ./package.json, in both directions:
 *
 * - everything pi sends (events, responses, extension dialogs, session
 *   state) must be assignable to the mirror, or the adapter could mishandle
 *   a record pi really produces;
 * - everything the adapter sends (commands, dialog answers) must be
 *   assignable to pi's types, or pi could reject it.
 *
 * Assignability alone lets extra properties through, so field sets are also
 * compared: the adapter may only send fields pi defines, and the mirror's
 * events may only declare fields pi has, so the adapter cannot come to rely
 * on one that never arrives.
 *
 * A failure names the mismatched type. Nothing here runs: tsc only reads pi's
 * declaration files.
 */
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import type * as Mirror from "../../src/pi/rpc-types.js";

/** Compiles only when `Actual` is assignable to `Expected`. */
type Assignable<Actual extends Expected, Expected> = Actual;

/** Every property name of any member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** `"none"`, or the first argument's offending entries (shown in the compile error). */
type NoneOf<Offending> = [Offending] extends [never] ? "none" : Offending;

/**
 * Fields of each `Mine` variant (matched to pi's by `type`) that pi's variant
 * of that type does not have, as `"type.field"`.
 */
type ExtraFields<Mine extends { type: string }, Theirs extends { type: string }> = Mine extends unknown
	? [Extract<Theirs, { type: Mine["type"] }>] extends [never]
		? never
		: `${Mine["type"]}.${Extract<Exclude<keyof Mine, KeysOfUnion<Extract<Theirs, { type: Mine["type"] }>>>, string>}`
	: never;

// ---- pi -> adapter ----------------------------------------------------------

// Every event on the wire, including message_update in its delta-only wire form.
export type Events = Assignable<JsonAgentSessionEvent, Mirror.PiRpcEvent>;
export type ExtensionDialogs = Assignable<RpcExtensionUIRequest, Mirror.PiExtensionUiRequest>;
// Events pi does not model (the RPC-only `extension_error` and `bash_execution_update`) are skipped.
export const eventFields: NoneOf<ExtraFields<Mirror.PiRpcEvent, JsonAgentSessionEvent>> = "none";
export const dialogFields: NoneOf<
	Mirror.PiExtensionUiRequest extends infer Dialog
		? Dialog extends { method: string }
			? `${Dialog["method"]}.${Extract<Exclude<keyof Dialog, KeysOfUnion<Extract<RpcExtensionUIRequest, { method: Dialog["method"] }>>>, string>}`
			: never
		: never
> = "none";
export type SessionState = Assignable<RpcSessionState, Mirror.PiSessionState>;

/** pi's success payload for a command, `undefined` when it sends none. */
type ResponseData<Command> =
	Extract<RpcResponse, { command: Command; success: true }> extends infer Response
		? Response extends { data: infer Data }
			? Data
			: undefined
		: never;

/** Every command the mirror knows whose real payload does not fit the mirror's. */
type MismatchedResponses = {
	[Command in keyof Mirror.PiRpcResponseData]: [ResponseData<Command>] extends [Mirror.PiRpcResponseData[Command]]
		? never
		: Command;
}[keyof Mirror.PiRpcResponseData];
export const responses: [MismatchedResponses] extends [never] ? "all match" : MismatchedResponses = "all match";

/** Mirror commands pi does not have: their responses would never arrive. */
type UnknownCommands = Exclude<keyof Mirror.PiRpcResponseData, RpcCommand["type"]>;
export const commandsExist: [UnknownCommands] extends [never] ? "all exist" : UnknownCommands = "all exist";

// ---- adapter -> pi ----------------------------------------------------------

export type Commands = Assignable<Mirror.PiRpcCommand, RpcCommand>;
export type DialogAnswers = Assignable<Mirror.PiExtensionUiResponse, RpcExtensionUIResponse>;
export const commandFields: NoneOf<ExtraFields<Mirror.PiRpcCommand, RpcCommand>> = "none";
export const dialogAnswerFields: NoneOf<
	Extract<Exclude<KeysOfUnion<Mirror.PiExtensionUiResponse>, KeysOfUnion<RpcExtensionUIResponse>>, string>
> = "none";
