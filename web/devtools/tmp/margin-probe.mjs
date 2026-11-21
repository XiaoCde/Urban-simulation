// 一次性探针：单人在深水/静水里 tick 两小时，看 deepMargin 与死亡判定怎么走。
// 目的：复现「outdoorMargin.max = 36.7 > 1 却没判死」这个矛盾。
// 不进正式结果，跑完就能删。
import { createIncidents } from '../../src/incidents.js';

const mk = (depth, speed, label) => {
  const INC = createIncidents({ peds: [{}], crowd: null, clock: { minute: 1200 } });
  const log = [];
  for (let t = 0; t <= 7200; t += 1) {
    INC.tick(0, 1, {
      depth, speed, indoor: false, sheltered: false, inVehicle: false,
      stamina: 70, rainMMH: 0, umbrella: 'closed', x: 0, z: 0,
      minute: 1200 + t / 60, band: 'prime',
    });
    const r = INC.row(0);
    if (t % 600 === 0 || r.status === 'dead') {
      log.push({ t, status: r.status, deepSec: +r.deepSec.toFixed(1),
        margin: +r.deepMargin.toFixed(2), endurance: +r.enduranceSec.toFixed(0) });
      if (r.status === 'dead') break;
    }
  }
  const st = INC.stats();
  console.log(label, 'depth', depth, 'speed', speed,
    '→', log.map((x) => `${x.t}s ${x.status} m=${x.margin} e=${x.endurance}`).join(' | '));
  console.log('   deaths', st.dead, JSON.stringify(st.deathsByCause),
    'margin', JSON.stringify(st.outdoorMargin));
};
mk(1.6, 0, '静水1.6m');