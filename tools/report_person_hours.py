#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「人·时」从已有的工况 JSON 里算出来（2026-11-20）

为什么要有这个脚本：p40 全天跑了 22,230,952 次判断，死亡 1 人。0/1/9/23 这种数列
是 n=1000 的伯努利抽样，不能当门槛用。能稳着比的是**连续量**：
被困人·时、涉水人·时、避险人·时。这些量从 hourly 快照直接矩形求和就能得，
不需要动内核、不需要重跑。

口径必须写在报告里：是「24 个整点快照 × 1 小时」的矩形和，**不是逐秒积分**。
真实值会比它高一点（进出不会正好卡在整点），所以它偏保守、但同口径可比。

用法：
    py tools/report_person_hours.py web/out/sweep_v2
    py tools/report_person_hours.py web/out/sweep_v2/u_p40_s0.json
"""
import glob
import json
import os
import sys


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def person_hours(doc):
    """把 hourly 快照矩形求和成人·时。返回 None 表示这份没有 hourly。"""
    h = doc.get('hourly') or []
    if not h:
        return None
    out = {'samples': len(h)}
    for k in ('stranded', 'injured', 'wading', 'evacuated', 'exposed'):
        vals = [float(x.get(k) or 0) for x in h]
        out[k] = round(sum(vals), 1)
        out[k + '_peak'] = round(max(vals), 1) if vals else 0.0
    return out


def incidents(doc):
    """死伤只从 final.sim.incidents 读（口径硬规定：不许用 hourly 末格顶替）。"""
    sim = (doc.get('final') or {}).get('sim') or {}
    inc = sim.get('incidents') or {}
    live = sim.get('live') or {}
    return {
        'dead': inc.get('dead', 0),
        'everStranded': inc.get('everStranded', 0),
        'everInjured': inc.get('everInjured', 0),
        'evacuated': inc.get('evacuated', 0),
        'exposed': inc.get('exposed', 0),
        'judged': live.get('judged', 0),
    }


def main(argv):
    targets = []
    for a in argv[1:]:
        if os.path.isdir(a):
            targets += sorted(p for p in glob.glob(os.path.join(a, '*.json'))
                              if not p.endswith('.partial.json'))
        else:
            targets.append(a)
    if not targets:
        print('用法: py tools/report_person_hours.py <目录或 JSON...>')
        return 2

    print('工况 | 死 | 累计被困 | 被困人·时 | 峰值被困 | 涉水人·时 | 避险人·时 | 判断数')
    print('---|---|---|---|---|---|---|---')
    for p in targets:
        name = os.path.basename(p)
        if name.startswith('_'):
            continue
        try:
            doc = load(p)
        except Exception as e:  # noqa: BLE001
            print(f'{name} | 读取失败 {e}')
            continue
        ph = person_hours(doc)
        inc = incidents(doc)
        if ph is None:
            print(f'{name} | {inc["dead"]} | {inc["everStranded"]} | – | – | – | – | {inc["judged"]}')
            continue
        print(f'{name} | {inc["dead"]} | {inc["everStranded"]} | {ph["stranded"]} | '
              f'{ph["stranded_peak"]:.0f} | {ph["wading"]} | {ph["evacuated"]} | {inc["judged"]}')

    print('\n注：人·时 = 24 个整点快照 × 1 小时的矩形和，不是逐秒积分；同口径可比，绝对值偏保守。')
    print('死亡列是单次抽样（n=1000），与期望死亡差一个量级时才有信息量。')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))