"""Independent NSScrollView event + content-offset evidence, not dispatch proof."""
import math


def verify(action, before, after, width, height):
    assert action['outcome'] == 'dispatched'
    assert after['pid'] == before['pid'] and after['windowId'] == before['windowId']
    assert before['counter'] == before['wheelCount'] == 0
    assert after['counter'] == after['wheelCount'] == 1
    assert after['pointerDowns'] == after['pointerUps'] == 0
    assert after['mainThread'] and not after['keyWindow']
    assert 0 < before['scrollX'] < 512 and 0 < before['scrollY'] < 320
    x, y = action['x'], action['y']
    assert type(x) is int and type(y) is int and 0 <= x < width and 0 <= y < height
    bounds = before['imageGeometry']
    expected = [(x + 0.5) * bounds['width'] / width - 24,
                bounds['height'] - (y + 0.5) * bounds['height'] / height - 320]
    flipped, view_height = before['wheelViewFlipped'], before['wheelViewHeight']
    assert type(flipped) is bool and math.isfinite(view_height) and view_height > 0
    assert after['wheelViewFlipped'] == flipped and after['wheelViewHeight'] == view_height
    if flipped:
        expected[1] = view_height - expected[1]
    wheel = after['lastWheel']
    assert wheel['precise'] is False
    assert all(math.isfinite(wheel[key]) for key in ('x', 'y', 'deltaX', 'deltaY'))
    assert abs(wheel['x'] - expected[0]) < 0.001 and abs(wheel['y'] - expected[1]) < 0.001
    dx, dy = after['scrollX'] - before['scrollX'], after['scrollY'] - before['scrollY']
    assert math.isfinite(dx) and math.isfinite(dy)
    direction = action['direction']
    if direction in ('up', 'down'):
        sign = 1 if direction == 'up' else -1
        assert abs(dx) < 0.001 and wheel['deltaX'] == 0
        assert dy * sign > 0 and wheel['deltaY'] * sign > 0
    else:
        assert direction in ('left', 'right')
        sign = 1 if direction == 'right' else -1
        assert abs(dy) < 0.001 and wheel['deltaY'] == 0
        assert dx * sign > 0 and wheel['deltaX'] * sign < 0
    return {'expectedViewportPoint': expected, 'offsetChange': [dx, dy],
            'wheelEvents': 1, 'realScrollViewMoved': True, 'background': True}
