import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { OfficeStory } from './src/office-story.js';
import { PROFILES } from './src/decision.js';

const routes = JSON.parse(readFileSync('assets/ped/home_route.json', 'utf8'));
const m = JSON.parse(readFileSync('assets/flood/manifest.json', 'utf8'));
const frames = m.frames.map((f) => ({ t: f.t_min, data: readFileSync(`assets/flood/${f.file}`) }));
const ts = frames.map((f) => f.t);
function depthAt(x, z, tMin) {
  let best = 0; let bd = Infinity;
  for (let i = 0; i < ts.length; i += 1) { const d = Math.abs(ts[i] - tMin); if (d < bd) { bd = d; best = i; } }
  const c = Math.floor((x - m.x0) / m.step_m);
  const r = Math.floor((z - m.z0) / m.step_m);
  if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return 0;
  return frames[best].data[r * m.cols + c] / 255 * m.scale;
}

function makeStory(profile, seed = 33) {
  const office = {
    start: new THREE.Vector3(2463.64, 32.19, 345.69),
    exit: new THREE.Vector3(2544.37, 6.81, 369.79),
    indoorRoute: Array.from({ length: 42 }, (_, i) => ({
      p: new THREE.Vector3(2463.6 + i * 2.0, 32.19 - Math.min(25.0, i * 0.62), 345.69 + (i > 30 ? (i - 30) * 2.4 : 0)),
      kind: i > 6 && i < 34 ? 'stairs' : 'walk',
      label: i > 6 && i < 34 ? '楼梯' : '走',
      floor: Math.max(1, 7 - Math.floor(i / 6)),
    })),
    cx: 2501.37, cz: 354.69, baseY: 7.19, floorH: 5, floors: 6, width: 131.86, depth: 30.1, height: 31.13,
  };
  const home = {
    baseY: 6.75, floorH: 3.55, homeFloor: 9, entryX: 2610, cz: -331.65,
    width: 81.96, depth: 27.5,
    route: [
      { p: new THREE.Vector3(2610, 6.75, -346.2), kind: 'walk', floor: 1, label: '进楼' },
      { p: new THREE.Vector3(2656, 6.75, -331.6), kind: 'walk', floor: 1, label: '电梯' },
      { p: new THREE.Vector3(2656, 35.15, -331.6), kind: 'lift', floor: 9, label: '9F' },
      { p: new THREE.Vector3(2624, 35.15, -323), kind: 'walk', floor: 9, label: '到家' },
    ],
  };
  return new OfficeStory({ office, home, routes, depthAt, groundAt: () => 6.6, seed, profile });
}

for (const key of ['mark', 'markCautious', 'markBold']) {
  const story = makeStory(PROFILES[key]);
  const t0 = Date.now();
  story.step(60 * 78);
  console.log(`\n=== ${key}  ${Date.now() - t0} ms`);
  console.log('结局', story.state, '完成', story.finished, '位置', story.position.toArray().map((v) => +v.toFixed(0)));
  for (const e of story.events.filter((x) => x.type === 'decision')) {
    console.log(`  ${e.t.toFixed(1)} ${e.title}  ::  ${e.detail.slice(0, 120)}`);
  }
  const last = story.events.filter((x) => x.type === 'outcome');
  console.log('  outcome:', last.map((x) => `${x.t.toFixed(1)} ${x.title}`).join(' | ') || '—');
}
