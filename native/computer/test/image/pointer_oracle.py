"""Independent fixed-canvas oracle, not an input capability or general UI map."""
import math


def verify(action, fixture, width, height, down, up, count):
    assert action['outcome'] == 'dispatched'
    x, y = action['x'], action['y']
    assert type(x) is int and type(y) is int
    assert 0 <= x < width and 0 <= y < height
    bounds = fixture['imageGeometry']
    # AppKit fixture canvas: x=24,y=320, width=512,height=160, unflipped.
    # Derive from its independent logical frame and PNG header, not the native
    # image-to-desktop transform under test. Check OS fractional coordinates.
    expected_x = (x + 0.5) * bounds['width'] / width - 24
    expected_y = bounds['height'] - (y + 0.5) * bounds['height'] / height - 320
    assert 0 <= expected_x < 512 and 0 <= expected_y < 160
    assert (down['event'], up['event']) == ('pointer-down', 'effect')
    assert down['seq'] < up['seq']
    assert (down['pointerDowns'], down['pointerUps'], down['counter']) == (count, count - 1, count - 1)
    assert (up['pointerDowns'], up['pointerUps'], up['counter']) == (count, count, count)
    for event, pressed in [(down, True), (up, False)]:
        assert event['windowId'] == fixture['windowId'] and event['pid'] == fixture['pid']
        assert event['keyWindow'] is False and event['mainThread'] is True
        point = event['lastPointer']
        assert point['down'] is pressed
        assert math.isfinite(point['x']) and math.isfinite(point['y'])
        assert abs(point['x'] - expected_x) < 0.001
        assert abs(point['y'] - expected_y) < 0.001
    return {'expectedCanvasPoint': [expected_x, expected_y], 'pairedEvents': True, 'background': True}
