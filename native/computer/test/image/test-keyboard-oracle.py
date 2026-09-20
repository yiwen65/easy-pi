import copy, unittest
from keyboard_oracle import verify

def events():
    base={'event':'ready','seq':1,'windowId':'7','keyWindow':True,'appActive':False,'pointerDowns':0,'pointerUps':0,'keyDowns':0,'keyUps':0,'counter':0,'state':'busy'}
    rows=[base]
    for index,code in enumerate((48,36)):
        for down in (True,False):
            row=dict(base,event='key-down' if down else 'effect',seq=len(rows)+1,keyDowns=index+1,keyUps=index+(not down),counter=index+(not down))
            row['lastKey']={'code':code,'down':down,'isRepeat':False,'windowId':'7','modifiers':0}
            rows.append(row)
    rows.append(dict(base,event='focus-lost',seq=6,keyWindow=False,state='done',keyDowns=2,keyUps=2,counter=2))
    rows.append(dict(base,event='closed',seq=7,keyWindow=False,state='done',keyDowns=2,keyUps=2,counter=2))
    return rows

class OracleTests(unittest.TestCase):
    def test_exact_pairs_and_natural_close(self):
        self.assertEqual(verify(events(),[48,36])['keyPairs'],2)
    def test_each_key_payload_and_pair_count_is_checked(self):
        for field,value in [('code',0),('down',False),('isRepeat',True),('windowId','8'),('modifiers',1)]:
            rows=events();rows[1]['lastKey'][field]=value
            with self.assertRaises(AssertionError):verify(rows,[48,36])
        rows=events();rows.insert(4,copy.deepcopy(rows[1]))
        with self.assertRaises(AssertionError):verify(rows,[48,36])
    def test_focus_pointer_and_late_input_refuse(self):
        for field,value in [('keyWindow',False),('appActive',True),('pointerDowns',1),('counter',10)]:
            rows=events();rows[1][field]=value
            with self.assertRaises(AssertionError):verify(rows,[48,36])
        rows=events();rows[-1]['keyDowns']=3
        with self.assertRaises(AssertionError):verify(rows,[48,36])
if __name__=='__main__':unittest.main(verbosity=2)
