"""Independent bounded PNG RGBA8 decoder: PNG rows are top-to-bottom.
No CoreGraphics draw transform is shared with the native capture implementation.
"""
from pathlib import Path
import struct
import zlib

MAX_BYTES=8*1024*1024
MAX_PIXELS=4*1024*1024
SIGNATURE=b'\x89PNG\r\n\x1a\n'

def decode(path):
    with Path(path).open('rb') as stream:
        data=stream.read(MAX_BYTES+1)
    assert len(data)<=MAX_BYTES and data.startswith(SIGNATURE),'invalid PNG boundary'
    offset=8;header=None;compressed=bytearray();ended=False;chunks=0
    while offset<len(data):
        assert not ended and offset+12<=len(data),'truncated/trailing PNG'
        size=struct.unpack_from('>I',data,offset)[0]
        kind=data[offset+4:offset+8];end=offset+12+size
        assert end<=len(data),'truncated PNG chunk'
        payload=data[offset+8:end-4]
        assert zlib.crc32(kind+payload)&0xffffffff==struct.unpack_from('>I',data,end-4)[0],'PNG CRC mismatch'
        chunks+=1;assert chunks<=256,'too many PNG chunks'
        if kind==b'IHDR':
            assert header is None and chunks==1 and size==13,'invalid IHDR'
            header=struct.unpack('>IIBBBBB',payload)
            width,height,depth,color,compression,filtering,interlace=header
            assert 0<width<=2048 and 0<height<=2048 and width*height<=MAX_PIXELS
            assert (depth,color,compression,filtering,interlace)==(8,6,0,0,0),'only noninterlaced RGBA8 is qualified'
        elif kind==b'IDAT':
            assert header is not None
            compressed.extend(payload)
        elif kind==b'IEND':
            assert size==0 and header is not None and compressed
            ended=True
        else:
            assert kind[0]&32,'unsupported critical PNG chunk'
        offset=end
    assert ended and header is not None,'missing PNG end/header'
    width,height=header[:2];stride=width*4;expected=height*(stride+1)
    decoder=zlib.decompressobj()
    scan=decoder.decompress(compressed,expected+1)
    assert len(scan)==expected and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,'invalid bounded PNG stream'
    pixels=bytearray(width*height*4);previous=bytearray(stride)
    for y in range(height):
        start=y*(stride+1);kind=scan[start];assert kind<=4,'invalid PNG filter'
        row=bytearray(scan[start+1:start+1+stride])
        for x in range(stride):
            left=row[x-4] if x>=4 else 0
            up=previous[x];upper_left=previous[x-4] if x>=4 else 0
            if kind==0:predictor=0
            elif kind==1:predictor=left
            elif kind==2:predictor=up
            elif kind==3:predictor=(left+up)//2
            else:
                p=left+up-upper_left
                distances=(abs(p-left),abs(p-up),abs(p-upper_left))
                predictor=(left,up,upper_left)[distances.index(min(distances))]
            row[x]=(row[x]+predictor)&255
        pixels[y*stride:(y+1)*stride]=row
        previous=row
    return width,height,pixels

def verify(path,geometry,fixture):
    width,height,pixels=decode(path)
    assert (width,height)==(geometry['outputWidth'],geometry['outputHeight'])
    native=fixture['imageGeometry']
    for field,source in [('desktopX','x'),('desktopY','y'),('windowWidth','width'),('windowHeight','height')]:
        assert abs(geometry[field]-native[source])<0.01,(field,geometry[field],native[source])
    assert geometry['sourceWidth']==round(native['width']*native['scale'])
    assert geometry['sourceHeight']==round(native['height']*native['scale'])
    samples=[]
    for probe in fixture['pixelProbes']:
        sx=(probe['x']-geometry['desktopX'])*geometry['sourceWidth']/geometry['windowWidth']
        sy=(probe['y']-geometry['desktopY'])*geometry['sourceHeight']/geometry['windowHeight']
        output_x=(sx-geometry['cropX'])*width/geometry['cropWidth']
        output_y=(sy-geometry['cropY'])*height/geometry['cropHeight']
        assert 0<=output_x<width and 0<=output_y<height,'probe outside captured pixels'
        x=int(output_x);y=int(output_y)
        red,green,blue,alpha=pixels[(y*width+x)*4:(y*width+x)*4+4]
        expected={'red':(True,False,False),'green':(False,True,False),'blue':(False,False,True),'yellow':(True,True,False)}[probe['color']]
        assert alpha>=250 and all(value>=180 if high else value<=100 for value,high in zip((red,green,blue),expected)),(probe['color'],x,y,(red,green,blue,alpha))
        samples.append({'color':probe['color'],'pixel':[x,y],'rgba':[red,green,blue,alpha]})
    return {'width':width,'height':height,'samples':samples,'decoder':'independent PNG RGBA8 scanlines','topLeftOrientationVerified':True}
