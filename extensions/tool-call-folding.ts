import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	sessionEntryToContextMessages,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

type ToolRecord = {
	id: string;
	name: string;
	isError?: boolean;
	resultSeen?: boolean;
};

type ToolGroup = {
	id: string;
	representativeId: string;
	tools: ToolRecord[];
	completed: boolean;
	createdAt: number;
	completedAt?: number;
	attachedAssistantTimestamp?: number;
};

type ToolFoldingState = {
	enabled: boolean;
	collapsed: boolean;
	autoCollapse: boolean;
	currentGroupId?: string;
	groups: Map<string, ToolGroup>;
	toolToGroup: Map<string, string>;
	requestRender?: () => void;
	activeAgentStartedAt?: number;
};

const STATE_KEY = Symbol.for("pi.tool-call-folding.state");
const TOOL_ORIGINAL_RENDER_KEY = Symbol.for("pi.tool-call-folding.tool.originalRender");
const TOOL_ORIGINAL_HANDLE_MOUSE_KEY = Symbol.for("pi.tool-call-folding.tool.originalHandleMouse");
const ASSISTANT_ORIGINAL_RENDER_KEY = Symbol.for("pi.tool-call-folding.assistant.originalRender");
// Ctrl+H is commonly indistinguishable from Backspace in terminals, so use Ctrl+R.
const TOGGLE_SHORTCUT = "ctrl+r";
const TOGGLE_SHORTCUT_LABEL = "Ctrl+R";

function getState(): ToolFoldingState {
	const globalStore = globalThis as typeof globalThis & { [STATE_KEY]?: ToolFoldingState };
	if (!globalStore[STATE_KEY]) {
		globalStore[STATE_KEY] = {
			enabled: true,
			collapsed: true,
			autoCollapse: true,
			groups: new Map(),
			toolToGroup: new Map(),
		};
	}
	return globalStore[STATE_KEY];
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

function yellow(text: string): string {
	return `\x1b[33m${text}\x1b[39m`;
}

function styleDim(text: string): string {
	return dim(text);
}

function styleWarning(text: string): string {
	return yellow(text);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : pluralForm}`;
}

function summarizeTools(group: ToolGroup): string {
	const counts = new Map<string, number>();
	for (const tool of group.tools) {
		counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([name, count]) => (count === 1 ? name : `${name} ×${count}`))
		.join(", ");
}

function completedGroupCount(): number {
	return Array.from(getState().groups.values()).filter((group) => group.completed).length;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function renderCollapsedSummary(group: ToolGroup, width: number, indent = ""): string[] {
	if (width <= 0) return [];
	const failed = group.tools.filter((tool) => tool.isError).length;
	const count = group.tools.length;
	const duration = formatDuration((group.completedAt ?? Date.now()) - group.createdAt);
	const details = [
		`${plural(count, "tool call")}`,
		summarizeTools(group),
		failed > 0 ? plural(failed, "failed tool") : undefined,
	].filter(Boolean).join(" · ");
	const text = `Worked for ${duration}${details ? ` · ${details}` : ""}  ${TOGGLE_SHORTCUT_LABEL} ›`;
	const styled = failed > 0 ? styleWarning(text) : styleDim(text);
	const contentWidth = Math.max(1, width - indent.length);
	const separator = styleDim("─".repeat(contentWidth));
	return [
		"",
		indent + truncateToWidth(styled, contentWidth, "…"),
		indent + separator,
	];
}

function getCompletedGroupForTool(toolCallId: unknown): ToolGroup | undefined {
	if (typeof toolCallId !== "string") return undefined;
	const state = getState();
	if (!state.enabled || !state.collapsed) return undefined;
	const groupId = state.toolToGroup.get(toolCallId);
	if (!groupId) return undefined;
	const group = state.groups.get(groupId);
	if (!group || !group.completed) return undefined;
	return group;
}

function getRepresentativeGroup(toolCallId: unknown): ToolGroup | undefined {
	const group = getCompletedGroupForTool(toolCallId);
	if (group?.attachedAssistantTimestamp !== undefined) return undefined;
	return group?.representativeId === toolCallId ? group : undefined;
}

function getAttachedGroupForAssistant(component: any): ToolGroup | undefined {
	const state = getState();
	if (!state.enabled || !state.collapsed) return undefined;
	const message = component?.lastMessage;
	const timestamp = Number(message?.timestamp);
	if (!Number.isFinite(timestamp)) return undefined;
	for (const group of state.groups.values()) {
		if (group.completed && group.attachedAssistantTimestamp === timestamp) {
			return group;
		}
	}
	return undefined;
}

function shouldHideTool(toolCallId: unknown): boolean {
	return Boolean(getCompletedGroupForTool(toolCallId));
}

function assistantMessageToolCallIds(component: any): string[] {
	const message = component?.lastMessage;
	if (!message || !Array.isArray(message.content)) return [];
	return message.content
		.filter((content: any) => content?.type === "toolCall" && typeof content.id === "string")
		.map((content: any) => content.id as string);
}

function shouldHideAssistantMessage(component: any): boolean {
	const ids = assistantMessageToolCallIds(component);
	if (ids.length === 0) return false;
	return ids.every((id) => Boolean(getCompletedGroupForTool(id)));
}

function installRenderingPatches(): void {
	const toolProto = ToolExecutionComponent.prototype as any;
	if (!toolProto[TOOL_ORIGINAL_RENDER_KEY]) {
		toolProto[TOOL_ORIGINAL_RENDER_KEY] = toolProto.render;
	}
	// Always replace the wrapper on reload so labels/behavior from this file take effect.
	toolProto.render = function patchedToolExecutionRender(width: number): string[] {
		const representativeGroup = getRepresentativeGroup(this.toolCallId);
		if (representativeGroup) {
			return renderCollapsedSummary(representativeGroup, width);
		}
		if (shouldHideTool(this.toolCallId)) {
			return [];
		}
		return toolProto[TOOL_ORIGINAL_RENDER_KEY].call(this, width);
	};

	if (!toolProto[TOOL_ORIGINAL_HANDLE_MOUSE_KEY]) {
		toolProto[TOOL_ORIGINAL_HANDLE_MOUSE_KEY] = toolProto.handleMouse;
	}
	toolProto.handleMouse = function patchedToolExecutionHandleMouse(event: TuiMouseEvent) {
		const representativeGroup = getRepresentativeGroup(this.toolCallId);
		if (representativeGroup && event.type === "click" && event.button === "left") {
			const state = getState();
			state.collapsed = false;
			state.requestRender?.();
			return { handled: true };
		}
		if (shouldHideTool(this.toolCallId)) {
			return { handled: true };
		}
		return toolProto[TOOL_ORIGINAL_HANDLE_MOUSE_KEY].call(this, event);
	};

	const assistantProto = AssistantMessageComponent.prototype as any;
	if (!assistantProto[ASSISTANT_ORIGINAL_RENDER_KEY]) {
		assistantProto[ASSISTANT_ORIGINAL_RENDER_KEY] = assistantProto.render;
	}
	assistantProto.render = function patchedAssistantMessageRender(width: number): string[] {
		if (shouldHideAssistantMessage(this)) {
			return [];
		}
		const originalLines = assistantProto[ASSISTANT_ORIGINAL_RENDER_KEY].call(this, width);
		const group = getAttachedGroupForAssistant(this);
		if (!group) return originalLines;
		const outputPad = typeof this.outputPad === "number" ? Math.max(0, Math.floor(this.outputPad)) : 1;
		const indent = " ".repeat(outputPad);
		const bodyLines = [...originalLines];
		while (bodyLines[0] === "") bodyLines.shift();
		return [...renderCollapsedSummary(group, width, indent), ...bodyLines];
	};
}

function createGroup(): ToolGroup {
	const state = getState();
	const now = Date.now();
	const id = `agent-${now}-${Math.random().toString(36).slice(2, 8)}`;
	const group: ToolGroup = {
		id,
		representativeId: "",
		tools: [],
		completed: false,
		createdAt: state.activeAgentStartedAt ?? now,
	};
	state.groups.set(id, group);
	state.currentGroupId = id;
	return group;
}

function getCurrentGroup(): ToolGroup {
	const state = getState();
	const existing = state.currentGroupId ? state.groups.get(state.currentGroupId) : undefined;
	if (existing && !existing.completed) return existing;
	return createGroup();
}

function addToolToGroup(group: ToolGroup, toolCallId: string, toolName: string): void {
	const state = getState();
	const existingGroupId = state.toolToGroup.get(toolCallId);
	if (existingGroupId) {
		const existingGroup = state.groups.get(existingGroupId);
		const existingTool = existingGroup?.tools.find((item) => item.id === toolCallId);
		if (existingTool) existingTool.name = toolName || existingTool.name;
		return;
	}
	if (!group.representativeId) group.representativeId = toolCallId;
	group.tools.push({ id: toolCallId, name: toolName || "tool" });
	state.toolToGroup.set(toolCallId, group.id);
}

function updateToolResult(toolCallId: string, isError: boolean): void {
	const state = getState();
	const groupId = state.toolToGroup.get(toolCallId);
	if (!groupId) return;
	const group = state.groups.get(groupId);
	const tool = group?.tools.find((item) => item.id === toolCallId);
	if (!tool) return;
	tool.resultSeen = true;
	tool.isError = isError;
}

function completeCurrentAgentGroup(): void {
	const state = getState();
	const group = state.currentGroupId ? state.groups.get(state.currentGroupId) : undefined;
	if (!group || group.tools.length === 0) {
		state.currentGroupId = undefined;
		return;
	}
	group.completed = true;
	group.completedAt = Date.now();
	state.currentGroupId = undefined;
	if (state.autoCollapse) {
		state.enabled = true;
		state.collapsed = true;
	}
}

function completeHistoryGroup(group: ToolGroup | undefined): void {
	if (!group) return;
	group.completed = group.tools.length > 0 && group.tools.every((tool) => tool.resultSeen);
}

function rebuildGroupsFromSession(ctx: ExtensionContext): void {
	const state = getState();
	state.groups.clear();
	state.toolToGroup.clear();
	state.currentGroupId = undefined;

	let groupIndex = 0;
	let currentGroup: ToolGroup | undefined;

	const newHistoryGroup = (): ToolGroup => {
		const group: ToolGroup = {
			id: `history-${groupIndex++}`,
			representativeId: "",
			tools: [],
			completed: false,
			createdAt: Date.now(),
		};
		state.groups.set(group.id, group);
		currentGroup = group;
		return group;
	};

	for (const entry of ctx.sessionManager.buildContextEntries() as any[]) {
		if (entry?.type === "custom") continue;
		let messages: any[] = [];
		try {
			messages = sessionEntryToContextMessages(entry as any) as any[];
		} catch {
			continue;
		}
		for (const message of messages) {
			if (message?.role === "user") {
				completeHistoryGroup(currentGroup);
				currentGroup = undefined;
				continue;
			}

			if (message?.role === "assistant" && Array.isArray(message.content)) {
				const toolCalls = message.content.filter((content: any) => content?.type === "toolCall");
				if (toolCalls.length === 0) {
					// A non-tool assistant message is usually the final response for the user request.
					if (currentGroup && message.content.some((content: any) => content?.type === "text" && String(content.text ?? "").trim())) {
						currentGroup.attachedAssistantTimestamp = Number(message.timestamp);
					}
					completeHistoryGroup(currentGroup);
					currentGroup = undefined;
					continue;
				}

				const group = currentGroup ?? newHistoryGroup();
				group.createdAt = Math.min(group.createdAt, Number(message.timestamp) || group.createdAt);
				for (const call of toolCalls) {
					if (typeof call.id !== "string") continue;
					addToolToGroup(group, call.id, String(call.name ?? "tool"));
				}
				continue;
			}

			if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
				const groupId = state.toolToGroup.get(message.toolCallId);
				const group = groupId ? state.groups.get(groupId) : undefined;
				if (!group) continue;
				const tool = group.tools.find((item) => item.id === message.toolCallId);
				if (tool) {
					tool.name = String(message.toolName ?? tool.name);
					tool.isError = message.isError === true;
					tool.resultSeen = true;
					const timestamp = Number(message.timestamp);
					if (Number.isFinite(timestamp)) {
						group.completedAt = Math.max(group.completedAt ?? timestamp, timestamp);
					}
				}
			}
		}
	}
	completeHistoryGroup(currentGroup);
}

function updateFooterStatus(ctx: ExtensionContext): void {
	const state = getState();
	if (!state.enabled) {
		ctx.ui.setStatus("tool-folding", undefined);
		return;
	}
	ctx.ui.setStatus(
		"tool-folding",
		ctx.ui.theme.fg(
			"dim",
			state.collapsed ? `tools folded (${completedGroupCount()})` : `tools shown (${completedGroupCount()})`,
		),
	);
}

function toggleGroupFolding(ctx: ExtensionContext): void {
	const state = getState();
	if (completedGroupCount() === 0) {
		updateFooterStatus(ctx);
		return;
	}
	state.enabled = true;
	state.collapsed = !state.collapsed;
	// Do not call ctx.ui.setToolsExpanded() here. Ctrl+O keeps its original Pi
	// behavior for inner tool details; this shortcut only toggles the outer group fold.
	updateFooterStatus(ctx);
}

export default function toolCallFolding(pi: ExtensionAPI) {
	installRenderingPatches();

	pi.on("session_start", (_event, ctx) => {
		const state = getState();
		state.enabled = true;
		state.collapsed = true;
		state.autoCollapse = true;
		state.requestRender = () => updateFooterStatus(ctx);
		rebuildGroupsFromSession(ctx);
		updateFooterStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("tool-folding", undefined);
		const state = getState();
		state.requestRender = undefined;
		state.currentGroupId = undefined;
	});

	pi.on("agent_start", () => {
		const state = getState();
		state.currentGroupId = undefined;
		state.activeAgentStartedAt = Date.now();
	});

	pi.on("tool_execution_start", (event) => {
		const group = getCurrentGroup();
		addToolToGroup(group, event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", (event) => {
		updateToolResult(event.toolCallId, event.isError === true);
	});

	pi.on("message_end", (event) => {
		const state = getState();
		const group = state.currentGroupId ? state.groups.get(state.currentGroupId) : undefined;
		const message = event.message as any;
		if (!group || message?.role !== "assistant" || !Array.isArray(message.content)) return;
		const hasToolCalls = message.content.some((content: any) => content?.type === "toolCall");
		const hasText = message.content.some((content: any) => content?.type === "text" && String(content.text ?? "").trim());
		if (!hasToolCalls && hasText && Number.isFinite(Number(message.timestamp))) {
			group.attachedAssistantTimestamp = Number(message.timestamp);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		completeCurrentAgentGroup();
		const state = getState();
		state.activeAgentStartedAt = undefined;
		updateFooterStatus(ctx);
	});

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Toggle folded tool/thinking groups",
		handler: (ctx) => {
			toggleGroupFolding(ctx);
		},
	});

	pi.registerCommand("tool-folding", {
		description: "Toggle tool-call group folding: /tool-folding [toggle|show|hide|details|on|off|status]",
		handler: async (args, ctx) => {
			const state = getState();
			const action = args.trim().toLowerCase() || "toggle";
			switch (action) {
				case "cycle":
				case "toggle":
					toggleGroupFolding(ctx);
					break;
				case "show":
				case "expand":
					state.enabled = true;
					state.collapsed = false;
					ctx.ui.setToolsExpanded(false);
					break;
				case "details":
					state.enabled = true;
					state.collapsed = false;
					ctx.ui.setToolsExpanded(true);
					break;
				case "hide":
				case "collapse":
					state.enabled = true;
					state.collapsed = true;
					ctx.ui.setToolsExpanded(false);
					break;
				case "on":
				case "enable":
					state.enabled = true;
					state.autoCollapse = true;
					state.collapsed = true;
					ctx.ui.setToolsExpanded(false);
					break;
				case "off":
				case "disable":
					state.enabled = false;
					state.autoCollapse = false;
					break;
				case "status":
					break;
				default:
					ctx.ui.notify("Usage: /tool-folding [cycle|show|details|hide|on|off|status]", "warning");
					return;
			}
			updateFooterStatus(ctx);
			ctx.ui.notify(
				state.enabled
					? `Tool/thinking groups ${state.collapsed ? "folded" : ctx.ui.getToolsExpanded() ? "shown with details" : "shown compact"}; ${completedGroupCount()} completed group(s).`
					: "Tool/thinking group folding disabled.",
				"info",
			);
		},
	});
}
