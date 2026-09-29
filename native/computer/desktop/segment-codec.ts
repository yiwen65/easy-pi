import type * as CuaSdk from "@trycua/cua-driver";
import type { ComputerSegmentInput } from "./segment-contracts.ts";

type Request = ComputerSegmentInput["request"];
type Address = Extract<Request["actions"][number], { op: "focus" }>["target"];
type Point = Extract<Request["actions"][number], { op: "pointer_move" }>["point"];

/** Genuine generated constructors, resolved by the existing lazy native entry. */
export type ComputerSegmentApi = Pick<
	typeof CuaSdk,
	| "ComputerElementAddress"
	| "ComputerInput"
	| "ComputerLocator"
	| "ComputerModifier"
	| "ComputerMouseButton"
	| "ComputerPoint"
	| "ComputerPostcondition"
	| "ComputerScrollUnit"
	| "ComputerSegment"
	| "ComputerWindowAction"
>;

/** Encode an already parsed model request; no SDK load, dispatch or extra FFI call. */
export function encodeComputerSegment(
	api: ComputerSegmentApi,
	request: Request,
	intentRef: string,
): CuaSdk.ComputerSegment {
	const address = (target: Address): CuaSdk.ComputerElementAddress =>
		"ref" in target
			? new api.ComputerElementAddress.Reference({ reference: target.ref })
			: new api.ComputerElementAddress.Locator({ locator: api.ComputerLocator.create(target.selector) });
	const point = (value: Point): CuaSdk.ComputerPoint =>
		api.ComputerPoint.create({ imageRef: value.ref, x: value.x, y: value.y });
	const buttons = {
		left: api.ComputerMouseButton.Left,
		right: api.ComputerMouseButton.Right,
		middle: api.ComputerMouseButton.Middle,
	};
	const modifiers = {
		command: api.ComputerModifier.Command,
		control: api.ComputerModifier.Control,
		option: api.ComputerModifier.Option,
		shift: api.ComputerModifier.Shift,
		fn: api.ComputerModifier.Function,
	};
	const actions = request.actions.map((step): CuaSdk.ComputerInput => {
		switch (step.op) {
			case "focus":
				return new api.ComputerInput.Focus({ target: address(step.target) });
			case "fill":
				return new api.ComputerInput.Fill({ target: address(step.target), text: step.text });
			case "type_text":
				return new api.ComputerInput.TypeText({ text: step.text });
			case "key":
				return new api.ComputerInput.Key({
					key: step.key,
					modifiers: (step.modifiers ?? []).map((key) => modifiers[key]),
				});
			case "key_down":
				return new api.ComputerInput.KeyDown({ key: step.key });
			case "key_up":
				return new api.ComputerInput.KeyUp({ key: step.key });
			case "pointer_move":
				return new api.ComputerInput.PointerMove({ point: point(step.point) });
			case "button_down":
				return new api.ComputerInput.ButtonDown({ button: buttons[step.button] });
			case "button_up":
				return new api.ComputerInput.ButtonUp({ button: buttons[step.button] });
			case "click":
				if ("target" in step) return new api.ComputerInput.ClickTarget({ reference: step.target.ref });
				return new api.ComputerInput.Click({
					point: point(step.point),
					button: buttons[step.button ?? "left"],
					count: step.count ?? 1,
				});
			case "scroll":
				return new api.ComputerInput.Scroll({
					point: point(step.point),
					deltaX: step.deltaX,
					deltaY: step.deltaY,
					unit: step.unit === "pixel" ? api.ComputerScrollUnit.Pixel : api.ComputerScrollUnit.Line,
				});
			case "drag":
				return new api.ComputerInput.Drag({
					from: point(step.from),
					to: point(step.to),
					durationMs: step.durationMs ?? 200,
				});
			case "window": {
				const commands = {
					activate: () => new api.ComputerWindowAction.Activate(),
					minimize: () => new api.ComputerWindowAction.Minimize(),
					restore: () => new api.ComputerWindowAction.Restore(),
					close: () => new api.ComputerWindowAction.Close(),
				};
				const action =
					step.action === "set_bounds"
						? new api.ComputerWindowAction.SetBounds({
								x: step.x,
								y: step.y,
								width: step.width,
								height: step.height,
							})
						: commands[step.action]();
				return new api.ComputerInput.Window({ action });
			}
			default: {
				// Keep additions exhaustive at compile time without echoing input.
				const unhandled: never = step;
				throw new Error(`Invalid computer action type: ${typeof unhandled}`);
			}
		}
	});
	const expected = request.expected;
	let postcondition: CuaSdk.ComputerPostcondition;
	switch (expected.kind) {
		case "value":
			postcondition = new api.ComputerPostcondition.Value({
				target: address(expected.target),
				value: expected.value,
			});
			break;
		case "present":
			postcondition = new api.ComputerPostcondition.Present({
				locator: api.ComputerLocator.create(expected.selector),
				present: expected.present,
			});
			break;
		case "window_focused":
			postcondition = new api.ComputerPostcondition.WindowFocused();
			break;
		case "window_bounds":
			postcondition = new api.ComputerPostcondition.WindowBounds({
				x: expected.x,
				y: expected.y,
				width: expected.width,
				height: expected.height,
			});
			break;
		case "visual":
			postcondition = new api.ComputerPostcondition.Visual({ description: expected.description });
			break;
	}
	return api.ComputerSegment.create({
		observationRef: request.ref,
		intentRef,
		actions,
		postcondition,
		maxDurationMs: 30_000,
	});
}
