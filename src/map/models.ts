import type { PiModel } from "../pi/rpc-types.js";

/**
 * ACP config values must be unique across providers, but pi identifies a model
 * by the `(provider, id)` pair, so the ACP value is the joined form.
 */
export function toAcpModelId(model: PiModel): string {
	return `${model.provider}/${model.id}`;
}

/** Split an ACP model value back into pi's `(provider, modelId)` pair. */
export function fromAcpModelId(modelId: string): { provider: string; modelId: string } {
	const separator = modelId.indexOf("/");
	if (separator === -1) throw new Error(`Model id must be "<provider>/<model>", got "${modelId}"`);
	return { provider: modelId.slice(0, separator), modelId: modelId.slice(separator + 1) };
}

/** Short human-readable summary shown next to a model in the picker. */
export function describeModel(model: PiModel): string {
	const details: string[] = [model.provider];
	if (model.contextWindow) details.push(`${Math.round(model.contextWindow / 1000)}k context`);
	if (model.reasoning) details.push("reasoning");
	return details.join(" · ");
}
