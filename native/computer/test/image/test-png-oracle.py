from pathlib import Path
import struct,tempfile,unittest,zlib
from png_oracle import decode,verify,SIGNATURE

COLORS=bytes([255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,255])

def chunk(kind,payload):
    return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload)&0xffffffff)

def png(pixels=COLORS,kind=0):
    stride=8;previous=bytes(stride);scan=bytearray()
    for y in range(2):
        row=pixels[y*stride:(y+1)*stride];encoded=bytearray([kind])
        for x,value in enumerate(row):
            left=row[x-4] if x>=4 else 0;up=previous[x];corner=previous[x-4] if x>=4 else 0
            if kind==0:predictor=0
            elif kind==1:predictor=left
            elif kind==2:predictor=up
            elif kind==3:predictor=(left+up)//2
            else:
                p=left+up-corner;distances=[abs(p-left),abs(p-up),abs(p-corner)]
                predictor=[left,up,corner][distances.index(min(distances))]
            encoded.append((value-predictor)&255)
        scan.extend(encoded);previous=row
    return SIGNATURE+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(scan))+chunk(b'IEND',b'')

class OracleTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.path=Path(self.directory.name)/'private.png'

    def test_all_png_filters_recover_top_to_bottom_rows(self):
        for kind in range(5):
            with self.subTest(filter=kind):
                self.path.write_bytes(png(kind=kind))
                width,height,pixels=decode(self.path)
                self.assertEqual((width,height,pixels),(2,2,COLORS))

    def test_crc_truncation_and_trailing_data_are_refused(self):
        for invalid in [png()[:-1],png()+b'extra',png()[:20]+bytes([png()[20]^1])+png()[21:]]:
            self.path.write_bytes(invalid)
            with self.assertRaises(AssertionError):decode(self.path)

    def test_visual_oracle_detects_vertical_flip_not_shared_with_native_drawing(self):
        geometry={'desktopX':-2,'desktopY':-4,'windowWidth':2,'windowHeight':2,'sourceWidth':2,'sourceHeight':2,'cropX':0,'cropY':0,'cropWidth':2,'cropHeight':2,'outputWidth':2,'outputHeight':2}
        fixture={'imageGeometry':{'x':-2,'y':-4,'width':2,'height':2,'scale':1},'pixelProbes':[{'x':-1.5,'y':-3.5,'color':'red'},{'x':-.5,'y':-3.5,'color':'green'},{'x':-1.5,'y':-2.5,'color':'blue'},{'x':-.5,'y':-2.5,'color':'yellow'}]}
        self.path.write_bytes(png())
        self.assertTrue(verify(self.path,geometry,fixture)['topLeftOrientationVerified'])
        self.path.write_bytes(png(COLORS[8:]+COLORS[:8]))
        with self.assertRaises(AssertionError):verify(self.path,geometry,fixture)
        self.path.write_bytes(png())
        fixture['pixelProbes'][0]['x']=-2.1
        with self.assertRaises(AssertionError):verify(self.path,geometry,fixture)

if __name__=='__main__':unittest.main(verbosity=2)
