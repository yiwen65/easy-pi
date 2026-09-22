import type * as CuaSdk from "@trycua/cua-driver";
import type { ComputerPlanApi } from "../controlled/tool.ts";

export type SegmentResultApi = ComputerPlanApi & Pick<typeof CuaSdk, "ComputerSegmentStatus">;
function category(values: { [index: number]: string }, value: number): string {
	const name = Number.isInteger(value) ? values[value] : undefined;
	if (typeof name !== "string") throw new Error("Invalid native category");
	return name.replace(/[A-Z]/g, (letter, index: number) => `${index ? "_" : ""}${letter.toLowerCase()}`);
}
const codes = new Set([
	"recovery_exhausted",
	"intent_outcome_unknown",
	"condition_already_satisfied",
	"unresolved_intent_limit",
	"stale_session_observation",
	"stale_image_observation",
	"stale_image_geometry",
	"image_reference_required",
	"controlled_target_stale",
	"target_scope_incomplete",
	"target_absent",
	"target_not_editable",
	"target_geometry_unknown",
	"foreground_activation_unknown",
	"foreground_focus_unproved",
	"foreground_target_changed",
	"drag_foreground_prepared",
	"invalid_cross_window_drag",
	"invalid_drag_destination",
	"invalid_drag_geometry",
	"drag_target_occluded",
	"pointer_hit_unknown",
	"pointer_hit_unavailable",
	"invalid_pointer_position",
	"input_monitoring_permission_denied",
	"input_observer_unavailable",
	"foreground_input_conflict",
	"physical_input_held_at_target",
	"local_input_policy_unproved",
	"event_clock_unavailable",
	"event_source_unavailable",
	"event_allocation_failed",
	"keyboard_target_changed",
	"semantic_delivery_unknown",
	"focus_effect_unknown",
	"focus_not_supported",
	"focus_capability_unknown",
	"segment_boundary_required",
	"window_action_unknown",
	"window_bounds_partial",
	"window_bounds_unconfirmed",
	"window_close_unavailable",
	"route_change_with_held_input",
	"window_change_with_held_input",
	"input_already_held",
	"input_not_owned",
	"unreleased_input",
	"accessibility_permission_denied",
	"accessibility_readiness_unknown",
	"pointer_route_unavailable",
	"invalid_segment",
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
]);

export function segmentCode(value: string): string {
	return codes.has(value) ? value : "native_fault";
}

/** Generated values are projected locally. Never invoke the FFI validator on the result hot path. */
export function projectSegment(
	api: SegmentResultApi,
	value: CuaSdk.ComputerSegmentResult,
	requested: number,
	visual: boolean,
) {
	const status = category(api.ComputerSegmentStatus, value.status);
	const condition = category(api.ComputerCondition, value.condition);
	if (
		!Array.isArray(value.actions) ||
		value.actions.length > requested ||
		!Number.isInteger(value.recoveryAttempts) ||
		value.recoveryAttempts < 0 ||
		value.recoveryAttempts > 2 ||
		typeof value.elapsedMs !== "bigint" ||
		value.elapsedMs < 0n ||
		(value.firstUnfinishedAction !== undefined &&
			(!Number.isInteger(value.firstUnfinishedAction) ||
				value.firstUnfinishedAction < 0 ||
				value.firstUnfinishedAction >= requested ||
				value.firstUnfinishedAction > value.actions.length))
	)
		throw new Error("Invalid native segment summary");
	if (status === "confirmed" && (visual || condition !== "satisfied")) throw new Error("Invalid native confirmation");
	if ((status === "needs_observation" || status === "outcome_unknown") && condition !== "unknown")
		throw new Error("Invalid native condition");
	let unfinished: number | undefined;
	const actions = value.actions.map((row, index) => {
		if (row.index !== index || unfinished !== undefined) throw new Error("Invalid native attempted prefix");
		const dispatch = category(api.ComputerDispatch, row.dispatch);
		const action = row.action;
		if (dispatch === "not_dispatched" && action && action.effect !== api.ActionEffect.Refused)
			throw new Error("Invalid native delivery");
		if (
			dispatch === "dispatched" &&
			(!action?.delivery ||
				action.delivery.mode === api.ActionDeliveryMode.Unknown ||
				action.delivery.deliveredCount === 0 ||
				action.effect === api.ActionEffect.Refused)
		)
			throw new Error("Invalid native delivery");
		if (dispatch !== "dispatched" || action?.effect === api.ActionEffect.Partial) unfinished = index;
		if (
			action?.delivery?.deliveredCount !== undefined &&
			(!Number.isSafeInteger(action.delivery.deliveredCount) || action.delivery.deliveredCount < 0)
		)
			throw new Error("Invalid native delivery count");
		return {
			index,
			dispatch,
			...(row.code ? { code: segmentCode(row.code) } : {}),
			...(action
				? {
						action: {
							effect: category(api.ActionEffect, action.effect),
							route: category(api.ActionRoute, action.route),
							...(action.delivery
								? {
										delivery: {
											mode: category(api.ActionDeliveryMode, action.delivery.mode),
											...(action.delivery.deliveredCount !== undefined
												? { deliveredCount: action.delivery.deliveredCount }
												: {}),
										},
									}
								: {}),
							...(action.evidence
								? { evidence: action.evidence.map((item) => category(api.ActionEvidenceKind, item.kind)) }
								: {}),
							...(action.escalation
								? {
										escalation: {
											target: category(api.ActionEscalationTarget, action.escalation.target),
											reason: category(api.ActionEscalationReason, action.escalation.reason),
										},
									}
								: {}),
						},
					}
				: {}),
		};
	});
	if (unfinished === undefined && actions.length < requested) unfinished = actions.length;
	if (value.firstUnfinishedAction !== unfinished) throw new Error("Invalid native unfinished index");
	return {
		status,
		actions,
		attemptedActions: actions.length,
		...(value.firstUnfinishedAction !== undefined ? { firstUnfinishedAction: value.firstUnfinishedAction } : {}),
		condition,
		recoveryAttempts: value.recoveryAttempts,
		elapsedMs: value.elapsedMs.toString(),
	};
}
