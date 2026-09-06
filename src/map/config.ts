import type {
	SessionConfigOption,
	SessionConfigSelectGroup,
	SessionConfigSelectOption,
	SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import type { PiModel, PiThinkingLevel } from "../pi/rpc-types.js";
import { describeModel, toAcpModelId } from "./models.js";

/**
 * pi's per-session settings, expressed as ACP session config options.
 *
 * ACP replaced the old `session/set_model` surface with a generic config-option
 * list, and its `model` and `thought_level` categories line up exactly with the
 * two knobs pi exposes per session.
 */
export const MODEL_CONFIG_ID = "model";
export const THINKING_CONFIG_ID = "thinking";

const THINKING_LEVELS: Record<PiThinkingLevel, string> = {
	off: "No extended reasoning",
	minimal: "Smallest reasoning budget",
	low: "Short reasoning budget",
	medium: "Balanced reasoning budget",
	high: "Large reasoning budget",
	xhigh: "Very large reasoning budget",
	max: "Maximum reasoning budget",
};

export function isThinkingLevel(value: string): value is PiThinkingLevel {
	return value in THINKING_LEVELS;
}

/** Group models by provider once more than one provider is configured. */
function modelSelectOptions(models: PiModel[]): SessionConfigSelectOptions {
	const byProvider = new Map<string, SessionConfigSelectOption[]>();
	for (const model of models) {
		const option: SessionConfigSelectOption = {
			value: toAcpModelId(model),
			name: model.name ?? model.id,
			description: describeModel(model),
		};
		const existing = byProvider.get(model.provider);
		if (existing) existing.push(option);
		else byProvider.set(model.provider, [option]);
	}

	if (byProvider.size < 2) return models.map((model) => flatOption(model));

	const groups: SessionConfigSelectGroup[] = [];
	for (const [provider, options] of byProvider) {
		groups.push({ group: provider, name: provider, options });
	}
	return groups;
}

function flatOption(model: PiModel): SessionConfigSelectOption {
	return { value: toAcpModelId(model), name: model.name ?? model.id, description: describeModel(model) };
}

export function modelConfigOption(models: PiModel[], currentModelId: string | undefined): SessionConfigOption | null {
	if (models.length === 0 || !currentModelId) return null;
	return {
		id: MODEL_CONFIG_ID,
		name: "Model",
		category: "model",
		type: "select",
		currentValue: currentModelId,
		options: modelSelectOptions(models),
	};
}

/**
 * The thinking control, or `null` when there is nothing to choose.
 *
 * `levels` is pi's answer to `get_available_thinking_levels`, empty when it
 * could not give one. Anything short of two levels means pi is offering no
 * choice for the current model, so no control is shown.
 */
export function thinkingConfigOption(
	levels: PiThinkingLevel[],
	current: PiThinkingLevel,
): SessionConfigOption | null {
	if (levels.length < 2) return null;
	return {
		id: THINKING_CONFIG_ID,
		name: "Thinking",
		description: "Reasoning effort",
		category: "thought_level",
		type: "select",
		currentValue: current,
		options: levels.map((level) => ({ value: level, name: level, description: THINKING_LEVELS[level] })),
	};
}

export function buildConfigOptions(input: {
	models: PiModel[];
	currentModelId: string | undefined;
	/** pi's supported levels; empty when they could not be determined. */
	thinkingLevels: PiThinkingLevel[];
	thinkingLevel: PiThinkingLevel;
}): SessionConfigOption[] {
	const options: SessionConfigOption[] = [];
	const model = modelConfigOption(input.models, input.currentModelId);
	if (model) options.push(model);
	const thinking = thinkingConfigOption(input.thinkingLevels, input.thinkingLevel);
	if (thinking) options.push(thinking);
	return options;
}
