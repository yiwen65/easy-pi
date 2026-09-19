"""Contrast in known fixture control interiors; not OCR or input authority."""
from png_oracle import decode

def verify(path, geometry):
    width,height,pixels=decode(path)
    assert geometry['cropX']==geometry['cropY']==0
    assert geometry['cropWidth']==geometry['sourceWidth']
    assert geometry['cropHeight']==geometry['sourceHeight']
    # Fixture source uses bottom-left content points; content starts at window
    # bottom for this titled window. Interior excludes rounded button edges.
    regions={'stop':(368,81,148,30),'state':(28,242,450,24),'counter':(28,136,450,24)}
    result={}
    for name,(x,y,w,h) in regions.items():
        left=int(x*width/geometry['windowWidth'])
        right=int((x+w)*width/geometry['windowWidth'])
        top=int((geometry['windowHeight']-y-h)*height/geometry['windowHeight'])
        bottom=int((geometry['windowHeight']-y)*height/geometry['windowHeight'])
        assert 0<=left<right<=width and 0<=top<bottom<=height
        shades=[]
        for py in range(top,bottom):
            for px in range(left,right):
                r,g,b,a=pixels[(py*width+px)*4:(py*width+px)*4+4]
                assert a>=250
                shades.append((r+g+b)/3)
        dark=sum(v<120 for v in shades)
        light=sum(v>180 for v in shades)
        assert dark>=10 and light>=10 and max(shades)-min(shades)>80,(name,dark,light,min(shades),max(shades))
        result[name]={'darkPixels':dark,'lightPixels':light,'range':[min(shades),max(shades)]}
    return result
