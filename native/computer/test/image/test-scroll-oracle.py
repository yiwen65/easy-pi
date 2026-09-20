import copy
import unittest
from scroll_oracle import verify


class ScrollOracleTests(unittest.TestCase):
    def fixture(self, direction):
        before = {'pid': 42, 'windowId': '7', 'imageGeometry': {'width': 560, 'height': 552},
                  'counter': 0, 'wheelCount': 0, 'scrollX': 256, 'scrollY': 160,
                  'wheelViewFlipped': False, 'wheelViewHeight': 160}
        after = copy.deepcopy(before)
        dx, dy = {'up': (0, 10), 'down': (0, -10), 'left': (-10, 0), 'right': (10, 0)}[direction]
        after.update(counter=1, wheelCount=1, pointerDowns=0, pointerUps=0,
                     keyWindow=False, mainThread=True, scrollX=256 + dx, scrollY=160 + dy,
                     lastWheel={'x': 128.5, 'y': 119.5, 'deltaX': -dx / 10, 'deltaY': dy / 10, 'precise': False})
        action = {'outcome': 'dispatched', 'x': 152, 'y': 112, 'direction': direction}
        return action, before, after, 560, 552

    def test_four_directions_require_both_event_and_real_offset_change(self):
        for direction in ('up', 'down', 'left', 'right'):
            self.assertTrue(verify(*self.fixture(direction))['realScrollViewMoved'])

    def test_flipped_scroll_view_uses_its_reported_coordinate_frame(self):
        values = self.fixture('down')
        values[1].update(wheelViewFlipped=True, wheelViewHeight=160)
        values[2].update(wheelViewFlipped=True, wheelViewHeight=160)
        values[2]['lastWheel']['y'] = 160 - values[2]['lastWheel']['y']
        self.assertTrue(verify(*values)['realScrollViewMoved'])

    def test_noop_reversed_duplicate_click_and_wrong_axis_are_refused(self):
        for mutation in ('noop', 'reverse', 'duplicate', 'click', 'wrong-axis', 'focus'):
            with self.subTest(mutation=mutation):
                values = self.fixture('down')
                after = values[2]
                if mutation == 'noop':
                    after['scrollY'] = 160
                elif mutation == 'reverse':
                    after['scrollY'] = 170
                elif mutation == 'duplicate':
                    after['wheelCount'] = 2
                elif mutation == 'click':
                    after['pointerDowns'] = 1
                elif mutation == 'wrong-axis':
                    after['lastWheel']['deltaX'] = 1
                else:
                    after['keyWindow'] = True
                with self.assertRaises(AssertionError):
                    verify(*values)


if __name__ == '__main__':
    unittest.main(verbosity=2)
