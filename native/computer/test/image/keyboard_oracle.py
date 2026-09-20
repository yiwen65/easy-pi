"""Independent AppKit key event oracle; native receipts cannot prove delivery."""
def verify(events, codes, allow_scenario_focus=False):
    ready=next(e for e in events if e['event']=='ready')
    selected=[e for e in events if e['seq']>ready['seq']]
    assert not ready['appActive']
    assert all(e['pointerDowns']==e['pointerUps']==0 for e in selected)
    if not allow_scenario_focus:
        # The explicit parent done/quit closes the fixture's own key window.
        # Only that teardown may resign it; all effects remain counted below.
        active=[e for e in selected if e['event']!='closed' and e.get('state')!='done']
        assert all(not e['appActive'] and e['keyWindow']==ready['keyWindow'] for e in active)
        assert not any(e['event'] in ('focus-gained','focus-lost','activated') for e in active)
    pairs=[e for e in selected if e['event'] in ('key-down','effect')]
    assert len(pairs)==2*len(codes)
    for index,code in enumerate(codes):
        for offset,down in enumerate((True,False)):
            row=pairs[2*index+offset];key=row['lastKey']
            assert row['event']==('key-down' if down else 'effect')
            assert key['code']==code and key['down'] is down and key['isRepeat'] is False
            assert key['windowId']==ready['windowId'] and key['modifiers']==0
            assert row['keyDowns']==index+1 and row['keyUps']==index+(not down)
            assert row['counter']==index+(not down)
    closed=[e for e in selected if e['event']=='closed']
    assert len(closed)==1 and closed[0]['keyDowns']==closed[0]['keyUps']==closed[0]['counter']==len(codes)
    return {'keyPairs':len(codes),'keyCodes':codes,'targetWindow':ready['windowId'],'noPointerFallback':True,'background':not allow_scenario_focus}
