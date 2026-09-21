// Existing form-profile encoding/projection retained while the segment candidate is qualified.
import type * as CuaSdk from "@trycua/cua-driver";
import type { Address, ExecuteRequest, Selector } from "../controlled/contracts.ts";
import type { ComputerPlanApi, ControlledComputerDetails } from "../controlled/tool.ts";

const publicCodes = new Set([
	"invalid_plan",
	"unsupported_platform",
	"unsupported_route",
	"permission_denied",
	"session_revoked",
	"desktop_busy",
	"desktop_quarantined",
	"native_unavailable",
	"native_fault",
	"stale_observation",
	"target_ambiguous",
	"target_missing",
	"target_disabled",
	"target_unproven",
	"action_unavailable",
	"unexpected_modal_surface",
	"condition_unsatisfied",
	"condition_unknown",
	"deadline_expired",
	"cancelled_before_dispatch",
	"cancelled",
	"outcome_unknown",
	"native_action_unconfirmed",
	"quarantined",
	"browser_not_prepared",
	"browser_preparation_already_claimed",
	"browser_binding_stale",
	"browser_subframe_unsupported",
	"browser_observation_bounds",
	"browser_observation_unproved",
	"browser_node_stale",
	"browser_node_unproved",
	"browser_frame_unproved",
	"browser_frame_changed",
	"browser_target_ambiguous",
	"browser_input_unavailable",
	"browser_input_unconfirmed",
	"browser_navigation_pending",
	"browser_navigation_unconfirmed",
	"browser_url_invalid",
]);
const code = (value: string) => (publicCodes.has(value) ? value : "native_fault");
export const selectorKey = (value: Selector) => JSON.stringify([value.role, value.label]);

function enumName(values: { [index: number]: string }, value: number): string {
	const name = values[value];
	if (!name) throw new Error("Invalid native result category");
	return name.replace(/[A-Z]/g, (letter, index: number) => `${index ? "_" : ""}${letter.toLowerCase()}`);
}

export function encodePlan(api: ComputerPlanApi, request: ExecuteRequest): CuaSdk.ComputerPlan {
	const address = (target: Address) =>
		"ref" in target
			? new api.ComputerAddress.Ref({ token: target.ref })
			: new api.ComputerAddress.Selector({ selector: target.selector });
	return {
		snapshotId: request.ref,
		steps: request.steps.map((step) => {
			if (step.op === "fill") return new api.ComputerStep.Fill({ target: address(step.target), text: step.text });
			if (step.op === "press")
				return new api.ComputerStep.Press({ target: address(step.target), expect: step.expect, value: step.value });
			return new api.ComputerStep.AssertValue({ selector: step.selector, value: step.value });
		}),
	};
}

export function projectPlan(
	api: ComputerPlanApi,
	plan: CuaSdk.ComputerPlanResult,
	requested: number,
): ControlledComputerDetails {
	if (
		plan.steps.length > requested ||
		plan.completedSteps > requested ||
		(plan.status === api.ComputerPlanStatus.Completed && plan.completedSteps !== requested)
	) {
		throw new Error("Invalid native plan summary");
	}
	const status =
		plan.status === api.ComputerPlanStatus.Completed
			? "completed"
			: plan.status === api.ComputerPlanStatus.Paused
				? "paused"
				: plan.status === api.ComputerPlanStatus.Cancelled
					? "cancelled"
					: "outcome_unknown";
	return {
		status,
		completedSteps: plan.completedSteps,
		...(plan.firstUnfinishedStep !== undefined ? { firstUnfinishedStep: plan.firstUnfinishedStep } : {}),
		...(plan.lastSnapshotId ? { lastSnapshotId: plan.lastSnapshotId } : {}),
		elapsedMs: plan.elapsedMs.toString(),
		steps: plan.steps.map((step) => ({
			index: step.index,
			dispatch: enumName(api.ComputerDispatch, step.dispatch),
			condition: enumName(api.ComputerCondition, step.condition),
			...(step.code ? { code: code(step.code) } : {}),
			elapsedMs: step.elapsedMs.toString(),
			...(step.action
				? {
						action: {
							effect: enumName(api.ActionEffect, step.action.effect),
							route: enumName(api.ActionRoute, step.action.route),
							...(step.action.delivery
								? {
										delivery: {
											mode: enumName(api.ActionDeliveryMode, step.action.delivery.mode),
											...(step.action.delivery.deliveredCount !== undefined
												? { deliveredCount: step.action.delivery.deliveredCount }
												: {}),
										},
									}
								: {}),
							...(step.action.evidence
								? { evidence: step.action.evidence.map((item) => enumName(api.ActionEvidenceKind, item.kind)) }
								: {}),
							...(step.action.escalation
								? {
										escalation: {
											target: enumName(api.ActionEscalationTarget, step.action.escalation.target),
											reason: enumName(api.ActionEscalationReason, step.action.escalation.reason),
										},
									}
								: {}),
						},
					}
				: {}),
		})),
	};
}
