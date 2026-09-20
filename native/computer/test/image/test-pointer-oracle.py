import copy
import unittest
from pointer_oracle import verify


class PointerOracleTests(unittest.TestCase):
    def fixture(self, width=512, height=504):
        ready = {'imageGeometry': {'width': 560, 'height': 552}, 'windowId': '7', 'pid': 42}
        x, y = int(152 * width / 560), int(112 * height / 552)
        point = {'x': (x + 0.5) * 560 / width - 24, 'y': 552 - (y + 0.5) * 552 / height - 320, 'down': True}
        down = {'event': 'pointer-down', 'seq': 1, 'pointerDowns': 1, 'pointerUps': 0, 'counter': 0,
                'windowId': '7', 'pid': 42, 'keyWindow': False, 'mainThread': True, 'lastPointer': point}
        up = copy.deepcopy(down)
        up.update(event='effect', seq=2, pointerUps=1, counter=1)
        up['lastPointer']['down'] = False
        action = {'outcome': 'dispatched', 'x': x, 'y': y}
        return action, ready, width, height, down, up, 1

    def test_resized_and_unscaled_images_map_to_fractional_fixture_coordinates(self):
        for width, height in [(512, 504), (1024, 1009), (560, 552)]:
            self.assertTrue(verify(*self.fixture(width, height))['pairedEvents'])

    def test_flipped_offset_focus_and_duplicate_events_are_rejected(self):
        for mutation in ('offset', 'flip', 'focus', 'duplicate', 'wrong-window', 'nan'):
            with self.subTest(mutation=mutation):
                values = self.fixture()
                up = values[5]
                if mutation == 'offset':
                    up['lastPointer']['x'] += 1
                elif mutation == 'flip':
                    up['lastPointer']['y'] = 160 - up['lastPointer']['y']
                elif mutation == 'focus':
                    up['keyWindow'] = True
                elif mutation == 'duplicate':
                    up['pointerUps'] = 2
                elif mutation == 'wrong-window':
                    up['windowId'] = '8'
                else:
                    up['lastPointer']['x'] = float('nan')
                with self.assertRaises(AssertionError):
                    verify(*values)

    def test_out_of_image_point_is_not_clamped(self):
        values = self.fixture()
        values[0]['x'] = -1
        with self.assertRaises(AssertionError):
            verify(*values)


if __name__ == '__main__':
    unittest.main(verbosity=2)
