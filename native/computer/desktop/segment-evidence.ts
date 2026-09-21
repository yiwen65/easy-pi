import type { DesktopGrant } from "./projection.ts";
import type { ComputerSegmentInput } from "./segment-contracts.ts";

type Request = ComputerSegmentInput["request"];
type Target = Extract<Request["actions"][number], { op: "focus" }>["target"];
type Point = Extract<Request["actions"][number], { op: "pointer_move" }>["point"];

export function validateSegmentEvidence(
	request: Request,
	view: DesktopGrant | undefined,
): asserts view is Exclude<DesktopGrant, { kind: "windows" }> {
	if (!view || view.kind === "windows" || view.ref !== request.ref) throw new Error("stale_observation");
	const reference = (ref: string) => {
		if (view.kind !== "semantic" || !view.refs.has(ref)) throw new Error("stale_element_reference");
	};
	const target = (value: Target) => {
		if ("ref" in value) reference(value.ref);
		else if (value.selector.within !== undefined) reference(value.selector.within);
	};
	const point = (value: Point) => {
		if (view.kind !== "image" || value.ref !== view.ref) throw new Error("stale_image");
		if (value.x >= view.width || value.y >= view.height) throw new Error("image_coordinates_out_of_bounds");
	};
	for (const step of request.actions) {
		if ("target" in step) target(step.target);
		if ("point" in step) point(step.point);
		if (step.op === "drag") {
			point(step.from);
			point(step.to);
		}
	}
	if (request.expected.kind === "value") target(request.expected.target);
	if (request.expected.kind === "present" && request.expected.selector.within !== undefined)
		reference(request.expected.selector.within);
}
