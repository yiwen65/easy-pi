"""Control-region guard tests. These synthetic pixels do not qualify AppKit."""
import unittest
from unittest.mock import patch
from control_oracle import verify

GEOMETRY = {
    'windowWidth': 560, 'windowHeight': 552,
    'sourceWidth': 1120, 'sourceHeight': 1104,
    'cropX': 0, 'cropY': 0, 'cropWidth': 1120, 'cropHeight': 1104,
}

class ControlContrastTests(unittest.TestCase):
    def image(self, missing=None):
        pixels = bytearray([255, 255, 255, 255]) * (560 * 552)
        # Three disjoint stand-ins inside the known Stop/state/counter regions.
        # No OCR claim: the guard detects blank/invisible areas, not wording.
        for name, x, y in [('stop', 400, 452), ('state', 40, 296), ('counter', 40, 402)]:
            if name == missing:
                continue
            for py in range(y, y + 8):
                for px in range(x, x + 20):
                    start = (py * 560 + px) * 4
                    pixels[start:start + 4] = bytes([24, 24, 24, 255])
        return 560, 552, pixels

    def test_visible_control_interiors_are_accepted(self):
        with patch('control_oracle.decode', return_value=self.image()):
            self.assertEqual(set(verify('unused', GEOMETRY)), {'stop', 'state', 'counter'})

    def test_each_blank_control_is_refused(self):
        for name in ('stop', 'state', 'counter'):
            with self.subTest(region=name):
                with patch('control_oracle.decode', return_value=self.image(name)):
                    with self.assertRaises(AssertionError):
                        verify('unused', GEOMETRY)

    def test_crop_cannot_silently_reinterpret_fixture_regions(self):
        with patch('control_oracle.decode', return_value=self.image()):
            with self.assertRaises(AssertionError):
                verify('unused', {**GEOMETRY, 'cropX': 1})

if __name__ == '__main__':
    unittest.main(verbosity=2)
