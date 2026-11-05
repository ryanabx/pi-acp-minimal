import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * Validators for ACP v1 messages, built from the official JSON schema that
 * ships with `@agentclientprotocol/sdk` (`schema/v1/schema.json`).
 *
 * The schema's message-level definitions are unions over every method, which
 * would accept almost any payload (`{}` is a valid `LogoutResponse`), so
 * validation is per method instead: the schema tags each definition with the
 * method it belongs to (`x-method`) and the side that handles it (`x-side`).
 * Ajv rather than zod's `fromJSONSchema`, because the elicitation definitions
 * use `not`, which zod cannot express, and a conformance check must not
 * quietly skip part of the schema.
 */
const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve("@agentclientprotocol/sdk/schema/v1/schema.json");
const SCHEMA_ID = "https://agentclientprotocol.com/schema/v1.json";

type Definition = { "x-method"?: string; "x-side"?: "agent" | "client" | "protocol" };
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as { $defs: Record<string, Definition> };

const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: false });
// The schema's integer formats are Rust widths; check the ranges they promise.
const integer = (min: number, max: number) => ({
	type: "number" as const,
	validate: (n: number) => Number.isInteger(n) && n >= min && n <= max,
});
ajv.addFormat("uint16", integer(0, 0xffff));
ajv.addFormat("int32", integer(-(2 ** 31), 2 ** 31 - 1));
ajv.addFormat("uint32", integer(0, 2 ** 32 - 1));
ajv.addFormat("int64", integer(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
ajv.addFormat("uint64", integer(0, Number.MAX_SAFE_INTEGER));
ajv.addFormat("double", { type: "number", validate: (n: number) => Number.isFinite(n) });
ajv.addFormat("uri", (value: string) => {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
});
ajv.addSchema({ ...schema, $id: SCHEMA_ID });

const compiled = new Map<string, ValidateFunction>();
function validator(definition: string): ValidateFunction {
	let validate = compiled.get(definition);
	if (!validate) {
		const found = ajv.getSchema(`${SCHEMA_ID}#/$defs/${definition}`);
		if (!found) throw new Error(`ACP schema has no definition ${definition}`);
		validate = found;
		compiled.set(definition, validate);
	}
	return validate;
}

/** Which schema definition each method's payloads must match, by direction. */
interface MethodIndex {
	/** Requests the client sends, by method: their `params` definition. */
	agentRequests: Map<string, string>;
	/** Results the agent returns, by the method of the request they answer. */
	agentResponses: Map<string, string>;
	/** Requests the agent sends to the client: their `params` definition. */
	clientRequests: Map<string, string>;
	/** Results the client returns, by method. */
	clientResponses: Map<string, string>;
	/** Notifications the agent sends: their `params` definition. */
	clientNotifications: Map<string, string>;
	/** Notifications the client sends. */
	agentNotifications: Map<string, string>;
}

function buildIndex(): MethodIndex {
	const index: MethodIndex = {
		agentRequests: new Map(),
		agentResponses: new Map(),
		clientRequests: new Map(),
		clientResponses: new Map(),
		clientNotifications: new Map(),
		agentNotifications: new Map(),
	};
	for (const [name, definition] of Object.entries(schema.$defs)) {
		const method = definition["x-method"];
		const side = definition["x-side"];
		if (!method || !side) continue;
		// `x-side` is the side that handles the message.
		if (name.endsWith("Request")) {
			(side === "agent" ? index.agentRequests : index.clientRequests).set(method, name);
		} else if (name.endsWith("Response")) {
			(side === "agent" ? index.agentResponses : index.clientResponses).set(method, name);
		} else if (name.endsWith("Notification")) {
			// `$/cancel_request` is a protocol notification either side may send.
			if (side !== "client") index.agentNotifications.set(method, name);
			if (side !== "agent") index.clientNotifications.set(method, name);
		}
	}
	return index;
}

export const methods: MethodIndex = buildIndex();

/** Validate `value` against a definition; returns readable errors, empty when valid. */
export function validate(definition: string, value: unknown): string[] {
	const check = validator(definition);
	if (check(value)) return [];
	return (check.errors ?? []).slice(0, 5).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

/** Every definition that can be validated, for coverage reporting. */
export function definitionNames(): string[] {
	return Object.keys(schema.$defs);
}
