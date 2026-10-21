# SPDX-License-Identifier: GPL-2.0-or-later
"""Narrow, executable exceptions for the pinned Micromod intersection.

Each exception constrains the differing values as well as the affected column.
A descriptive classification string alone never authorizes a difference.
"""
def compare(test, trace, reference):
    assert len(trace) == len(reference) == test['ticks']
    differences = []
    for i, (n, r) in enumerate(zip(trace, reference)):
        got, want = n[:6] + [n[7]], r[:7]
        allowed = set()
        name = test['name']
        if name == 'F00-pause' and i >= 6:
            assert n[:5] == [0, 1, 0, 6, 125]
            assert r[:5] == [0, i // 6, i % 6, 6, 125]
            allowed = {1, 2}
        elif name == '1FF-clamp' and i >= 7:
            assert n[5] == 1 and r[5] == 0
            allowed = {5}
        elif name == '2FF-clamp' and i >= 7:
            assert n[5] == 4095 and r[5] == 4090 + 255 * min(i - 6, 5)
            allowed = {5}
        elif name == 'E31-porta' and i >= 6:
            assert n[5] == [428,428,404,404,404,404][i-6] if i < 12 else n[5] == 400
            assert r[5] == [428,421,414,407,400,400][i-6] if i < 12 else r[5] == 400
            allowed = {5}
        elif name == 'E57' and i >= 6:
            assert n[5] == 407 and r[5] == 431
            allowed = {5}
        elif name in ('531','631','AFF-priority','531-combined','631-combined') and i >= test['at']:
            t = min(i - test['at'], 5)
            assert n[7] == 32 + 3*t and r[6] == 32 + 2*t
            allowed = {6}
            if name == '631-combined' and i < test['at']+6:
                assert n[5] == [428,432,433,433,433,433][t]
                assert 428 <= r[5] <= 434
                allowed.add(5)
        if name in ('423','723','631-combined') and 6 <= i < 12:
            field, col, nv, rv = (5,5,[428,428,429,430,431,432],[428,429,430,431,432,432]) if name != '723' else (7,6,[32,32,34,36,38,40],[32,34,36,38,40,41])
            assert n[field] == nv[i-6] and r[col] == rv[i-6]
            allowed.add(col)
        if name.startswith(('V-PHASE-', 'T-PHASE-')) and 6 <= i < 12:
            field,col,nv,rv = (5,5,[428,428,429,430,431,432],[428,429,430,431,432,432]) if name.startswith('V-') else (7,6,[32,32,34,36,38,40],[32,34,36,38,40,41])
            assert n[field] == nv[i-6] and r[col] == rv[i-6]
            allowed.add(col)
        if name.startswith(('V-WAVE-', 'T-WAVE-')) and 6 <= i < 12:

            # Waveform origin/rounding differs. All timing, position and other
            # channel fields must still agree; native vectors are checked first.
            vibrato = name.startswith('V-')
            col, field, low, high = (5,5,423,433) if vibrato else (6,7,20,44)
            # Reference signed right shift floors negative modulation; native C
            # division truncates toward zero (one period unit at the boundary).
            assert low <= n[field] <= high and low-int(vibrato) <= r[col] <= high,(name,i,n[field],r[col])
            allowed.add(col)
        changed = {j for j,(x,y) in enumerate(zip(got,want)) if x != y}
        assert changed <= allowed, (name, i, 'unclassified reference difference', got, want, allowed)
        if changed:
            assert test['classification'], (name, 'missing explanation')
            differences.append(dict(tick=i,native=got,reference=want))
    return differences


def check_rejection(test, trace, reference):
    """Each accepted profile must reject an unrelated tempo mutation."""
    altered = [row[:] for row in trace]
    altered[-1][4] += 1
    try:
        compare(test, altered, reference)
    except AssertionError:
        return
    raise AssertionError((test['name'], 'classification accepted tempo corruption'))
