/**
 * day-motion.js —— 24 小时「人真的在动」的统一位置求解器。
 *
 * 【为什么要有这一层】2026-11-07 用户反馈：
 *   「人物连动都不动」「大半夜的马克在外面，不在家里边」
 *   「出去买早餐就在原地跑呀跑呀跑」
 * 根因是旧实现把 day_full.json 的 22 段剧本只接到了 HUD 文字，人物走位用的是
 * day-schedule.js 那张 10 段的粗表：每段只有一个固定锚点，渲染层每帧
 * `position.set(锚点)` 把人钉死，clip 却是 `walk` 循环 —— 于是原地踏步；
 * 而 mark.js 的 applyDay() 还漏了 `inBuilding`，半夜把人摆在公寓楼外人行道上。
 *
 * 【这一层的做法】把每个人的 22 段编译成一条 0–1440 连续的 3D 轨迹，
 * 位置、朝向、动作、室内外都是**时刻的纯函数** `at(key, minute)`：
 *   ① 室内段：锚点落在 life-scenes 建好的真实房间（9F 主卧 / 厨房 / 6F 工位…），
 *      段内前一小段时间在房间里走动，之后坐/睡 —— 站定就绝不播 walk/run。
 *   ② 换地点段：从上一处的楼门口沿 roadnet 求最短路，走到下一处楼门口再进屋，
 *      按 `u=(m-a)/(b-a)` 沿弧长插值。走完整段才停，不会提前跑完再原地跑。
 *   ③ 动画 clip 由「这一刻有没有位移」决定，不再由段标签硬套。
 *   ④ 纯函数 ⇒ 拖时间轴任意时刻立刻就位，播放时连续移动，暂停时姿势定格。
 *
 * 17:52–18:35（1072–1115）仍返回 crisis:true，让 story + Brain 接管。
 */
import { buildStreetGraph, routeOnGraph, sanitizePolyline } from './street-route.js';
import { inCrisis } from './day-schedule.js';
import { WALK } from './motion-units.js';

const DATA_URL = '/assets/story/day_full.json';

/**
 * 【2026-11-07 第二轮】动作必须跟场景对得上。
 * 旧版按段标签硬套：医生做手术播 `sit`、老师上课播 `sit`、打电话播
 * `look`（抬手张望），而且**所有**静止段都会「起身在屋里踱 3.2 m」——
 * 于是手术室、教室、吧台、餐桌旁的人都在莫名其妙地走来走去。
 *
 * 模型只有 18 段 clip（back/crawl/crouch/door/idle/idle2/look/run/
 * run_stop/side_l/side_r/sit/stairs_down/stairs_up/start/stop/turn180/walk），
 * 没有「躺 / 吃 / 做手术 / 讲课」。所以按语义把每段归到一类，再挑最接近的
 * 循环姿势；`look` 基本弃用（它正是此前被吐槽的挥手/张望怪动作）。
 */
const CLIP_KIND = {
  sleep: 'sleep', sit: 'home', eat: 'meal', work: 'desk', read: 'desk',
  news: 'desk', operate: 'medical', teach: 'teach', serve: 'serve',
  drive: 'drive', ride: 'ride', idle: 'wait', pack: 'wait', wait: 'wait',
  close: 'wait', shelter: 'wait', lift: 'wait', decide: 'wait',
  phone: 'talk', talk: 'talk', handover: 'talk',
  carry: 'manual', climb: 'manual', walk: 'manual',
  evacuate: 'evacuate', run: 'evacuate',
};
/** 每类该摆的循环姿势：坐着办公/吃饭/坐车用 sit，站着工作一律 idle。 */
const POSE_BY_KIND = {
  sleep: 'sit',   drive: 'sit', ride: 'idle', meal: 'sit', desk: 'sit',
  medical: 'idle', teach: 'idle', serve: 'idle', talk: 'idle',
  wait: 'idle', home: 'sit', manual: 'idle', evacuate: 'idle',
  // 赶路段站定（最后 8%）只能站着等，绝不能 sit —— 否则人坐在马路中央。
  travel: 'idle',
};
/** 只有这几类允许「间歇起身走两步」；上班/吃饭/上课/手术/服务/通话/睡觉/赶路一律不许。 */
const ALLOW_DRIFT = new Set(['home', 'manual', 'wait', 'evacuate']);

function activityKind(seg, travel = false) {
  const s = `${seg.spot || ''} ${seg.activity || ''} ${seg.note || ''}`;
  const has = (...ws) => ws.some((w) => s.includes(w));
  // 【2026-11-08 全天时间轴审计】赶路段必须单独归一类。
  // 旧版把「起夜倒水」「去诊所缝合」「放学进店」「步行返家」按场景词判成
  // desk / medical / teach / meal，于是这些段被当作"该坐着"的静止段：审计
  // 里 173 条「desk 播 walk」就是这么来的（其实人在走路是对的，是 kind 错了）。
  // 更糟的是段末站定会播 sit，出现「在马路中央坐着」。
  if (seg.clip === 'drive') return 'drive';          // 车里仍然要 sit
  if (seg.clip === 'evacuate') return 'evacuate';    // 撤离保持语义标签
  if (travel) return 'travel';
  // 明确动作优先
  // 起夜 / 去厨房这类段虽然标着 sleep，但 spot 带「→」是赶路段：
  // 不能归成「睡觉」，否则会出现「睡觉却在走」的矛盾标注。
  if (!travel && (seg.clip === 'sleep'
    || ((seg.a || 0) < 360 && (seg.clip === 'sit' || seg.clip === 'sleep')))) return 'sleep';
  if (seg.clip === 'drive') return 'drive';
  if (seg.clip === 'ride') return 'ride';
  if (seg.clip === 'evacuate') return 'evacuate';
  if (seg.clip === 'eat') return 'meal';
  if (seg.clip === 'operate') return 'medical';
  if (seg.clip === 'teach') return 'teach';
  if (seg.clip === 'serve') return 'serve';
  if (seg.clip === 'phone' || seg.clip === 'talk' || seg.clip === 'handover') return 'talk';
  // 中文剧本里有些段 clip 是泛化的 idle/wait，先用场景词兜底
  if (has('手术', '处置室', '分诊', '缝合')) return 'medical';
  if (has('教室', '上课', '讲课', '音乐课')) return 'teach';
  if (has('吧台', '做咖啡', '收银', '端餐')) return 'serve';
  if (has('早餐', '午餐', '晚餐', '吃饭', '餐桌')) return 'meal';
  if (has('工位', '报告', '数据', '会议室', '合同', '材料')) return 'desk';
  // 【地点兜底】钢筋工在工地、骑手在街面、医生在诊所……泛化 clip 不能
  // 一律显示「等候」。赶路段不算（赶路就是走路，由 travel 分支负责）。
  if (!travel) {
    const byPlace = {
      site: 'manual', street: 'manual', clinic: 'medical', school: 'teach',
      cafe: 'serve', office: 'desk', home: 'home',
    };
    if (byPlace[seg.place]) return byPlace[seg.place];
  }
  return CLIP_KIND[seg.clip] || 'wait';
}
/** 段标签里表示「这一段在赶路」的词。 */
const TRAVEL_CLIP = new Set([
  'drive', 'walk', 'ride', 'lift', 'climb', 'evacuate', 'carry', 'run',
]);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
};

/** spot 文本 → life-scenes 的场景 id。锚点由 setAnchors() 注入，这里只挑 id。
 *  【2026-11-08 修正】旧版把「9F 电梯厅」指到一层大堂、把「1F 处置室」
 *  指到分诊台、把「校车站 / 门口」指到吧台 —— 人明明在 9F 却站在一楼，
 *  明明在街上却被标成咖啡馆里。审计里 62 条楼层错位、10 条室内外错配
 *  全部来自这里。现在按「楼层 + 房间词」精确匹配，并保证场景归属 == place。 */
function sceneIdFor(place, spot, activity = '') {
  const s = `${spot || ''} ${activity || ''}`;
  const has = (...ws) => ws.some((w) => s.includes(w));
  if (place === 'home') {
    if (has('厨房', '餐桌', '早餐', '晚餐', '冰箱', '烧水', '倒水')) return 'sc_home_kitchen';
    if (has('9F') && has('电梯', '走廊', '门厅')) return 'sc_home_hall9f';
    // 7 个人各在各的卧室，不再全挤进同一张双人床
    if (has('书房', '三居', '合同', '会议材料')) return 'sc_home_study9f';
    if (has('儿童房', '雨靴', '卡通')) return 'sc_home_kids9f';
    if (has('合租', '工靴', '室友')) return 'sc_home_shared9f';
    if (has('一居', '最小间', '朝北开间', '开间')) return 'sc_home_studio9f';
    if (has('客厅', '新闻', '电视')) return 'sc_home_living';
    if (has('大堂', '电梯', '北门', '车库', '门厅', '信箱')) return 'sc_home_lobby';
    return 'sc_home_bedroom';
  }
  if (place === 'office') {
    if (has('1F 大堂', '一层大堂') || (has('大堂') && !has('6F'))) return 'sc_office_lobby';
    if (has('3F', '会议室')) return 'sc_office_meeting3f';
    if (has('楼梯')) return 'sc_office_stairs';
    return 'sc_office_6f';
  }
  if (place === 'cafe') {
    if (has('熟路', '小路', 'cafe_to_market')) return 'sc_route_cafe_market';
    if (has('后门', '东门', '门口', '校车站', '后巷')) return 'sc_cafe_backdoor';
    if (has('客区', '靠窗', '高脚凳', '圆桌')) return 'sc_cafe_tables';
    return 'sc_cafe_counter';
  }
  if (place === 'clinic') {
    if (has('处置', '缝合', '清创')) return 'sc_clinic_treatment';
    if (has('恢复')) return 'sc_clinic_recovery';
    if (has('分诊', '门口', '1F 大厅')) return 'sc_clinic_lobby1f';
    return 'sc_clinic_or2f';
  }
  if (place === 'school') {
    if (has('5F', '音乐', '合唱')) return 'sc_school_music5f';
    if (has('校门', '校车', '放学排队')) return 'sc_school_gate';
    if (has('走廊', '储物柜') && !has('3F')) return 'sc_school_corridor';
    return 'sc_school_class3f';
  }
  if (place === 'site') {
    if (has('集装箱', '材料棚', '办公室')) return 'sc_site_container';
    if (has('棚')) return 'sc_site_shed';
    return 'sc_site_pit';
  }
  if (place === 'street') {
    if (has('候车', '避雨', '公交亭')) return 'sc_street_shelter';
    if (has('跑单', 'wander', '骑', '电动车')) return 'sc_street_ride';
    if (has('绕行', '高地', '通勤', '沿街')) return 'sc_road_commute';
    return 'sc_street_corner';
  }
  return null;
}

/** 场景 id → 真实楼层（与 life-scenes.js 的 floorFromId 完全一致）。
 *  有 3D 锚点时楼层必须听锚点的，否则「站在一层大堂却标 9F」。 */
function floorFromSceneId(id) {
  const m = String(id || '').match(/(\d+)f/);
  if (m) return clamp(parseInt(m[1], 10), 1, 12);
  if (/bedroom|kitchen|living/.test(id || '')) return 9;
  return 1;
}

/** spot 里的「9F / 6F / 3F」→ 楼层（只在没有锚点时兜底用）。 */
function floorFromSpot(spot, place) {
  const m = String(spot || '').match(/(\d+)\s*[Ff层]/);
  if (m) return clamp(parseInt(m[1], 10), 1, 12);
  return ({ home: 9, office: 6, clinic: 2, school: 3, cafe: 1 })[place] || 1;
}

/**
 * @param {{data?:object, roadnet?:object, groundAt?:function, lifeGroup?:object}} opt
 */
export async function createDayMotion(opt = {}) {
  let data = opt.data || null;
  if (!data) {
    try {
      const r = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      console.warn('[day-motion] 剧本载入失败，回退到静态日程：', e && e.message);
      return null;
    }
  }
  const places = data.places || {};
  const timelines = data.timeline || {};
  const keys = Object.keys(timelines);
  const groundAt = typeof opt.groundAt === 'function' ? opt.groundAt : () => 0;
  const G = opt.roadnet ? buildStreetGraph(opt.roadnet) : null;
  // 统一碰撞层（main.js 传进来）：锚点落在家具里会被推出来，漂移也不会穿床穿桌
  const collide = opt.collide || null;
  const IGN_B = new Set(['building']);   // 室内人物忽略楼体，只躲家具
  const solids = opt.solids || null;     // 权威「可见建筑实体」表（幽灵楼已注销）

  // 【车不是人】2026-11-08 用户：「马克的车会直接穿过楼，连着穿过了两个楼」。
  // 根因：drive 段把车摆到人的完整换楼路径上 —— 车从 9F 厨房开出来、在
  // 电梯井里垂直降落、再开进 FAA 6F。这里建立纯地面障碍层，供路网避行和
  // 车轨迹清扫使用；5 栋剧情楼（精细模型）也补进障碍，避免车贴着楼边蹭墙。
  const CAR_PAD = 2.4;                   // 车半宽 + 余量
  const placeSolids = [];
  for (const k of ['home', 'office', 'cafe', 'clinic', 'school']) {
    const P = places[k];
    if (P && P.w > 0 && P.d > 0) placeSolids.push({
      id: `place:${k}`, minx: P.x - P.w / 2, maxx: P.x + P.w / 2,
      minz: P.z - P.d / 2, maxz: P.z + P.d / 2, h: 80,
    });
  }
  const hitSolid = (x, z, pad = 0) => {
    const r = solids && solids.hit(x, z, pad);
    if (r) return r;
    for (const q of placeSolids) {
      if (x > q.minx - pad && x < q.maxx + pad && z > q.minz - pad && z < q.maxz + pad) return q;
    }
    return null;
  };
  /** 把点推出最近实体的边界外 pad 米；多轮处理相邻楼连在一起的情况。 */
  /** 把点推出最近实体的边界外 pad 米；多轮处理相邻楼连在一起的情况。
   *  hint ≠ 0 时固定沿 ±z 侧推出：sanitizePolyline 会在整条折线里记住第一次
   *  推出的方向，避免「最近边」在楼的两侧交替选择、生成前后横跳的锯齿折线
   *  （小女孩 15:00–15:16 一直在墙边来回蹭的实测根因）。 */
  const snapOutSolid = (x, z, pad = CAR_PAD, hint = 0) => {
    const z0 = z;
    for (let pass = 0; pass < 5; pass++) {
      const r = hitSolid(x, z, pad);
      if (!r) break;
      if (hint !== 0) {
        const nz = hint > 0 ? r.maxz + pad + 0.05 : r.minz - pad - 0.05;
        // 别沿同一个方向一路推出街区（实测会推到 z=-630 再折返 100 m）
        if (Math.abs(nz - z0) > 14) break;
        z = nz;
        continue;
      }
      const dl = x - (r.minx - pad), dr = (r.maxx + pad) - x;
      const db = z - (r.minz - pad), df = (r.maxz + pad) - z;
      const m = Math.min(dl, dr, db, df);
      if (m === dl) x = r.minx - pad - 0.05;
      else if (m === dr) x = r.maxx + pad + 0.05;
      else if (m === db) z = r.minz - pad - 0.05;
      else z = r.maxz + pad + 0.05;
    }
    return { x, z, clear: !hitSolid(x, z, pad) };
  };
  const blockedForCar = (x, z) => !!hitSolid(x, z, CAR_PAD);
  let anchors = {};         // { sceneId: {x,y,z} } —— life-scenes 的真实房间坐标
  let compiled = {};        // { key: [seg…] }
  let stats = { keys: keys.length, segments: 0, routed: 0, local: 0, metres: 0, anchors: 0 };

  /** 从 life-scenes 的 group 里把每个场景的锚点读出来。 */
  function setAnchors(mapOrGroup) {
    if (!mapOrGroup) return;
    if (mapOrGroup.children) {
      const map = {};
      for (const o of mapOrGroup.children) {
        if (o && o.name && o.position) map[o.name] = { x: o.position.x, y: o.position.y, z: o.position.z };
      }
      anchors = map;
    } else anchors = { ...mapOrGroup };
    stats.anchors = Object.keys(anchors).length;
    rebuild();
  }

  /** 楼门口：从 footprint 中心沿锚点方向射到边界外 7 m，落在人行道/街边。 */
  function doorOf(a, placeKey) {
    const P = places[placeKey];
    if (!P) return { x: a.x, y: groundAt(a.x, a.z), z: a.z };
    const hw = (P.w || 20) / 2 + 7, hd = (P.d || 20) / 2 + 7;
    let dx = a.x - P.x, dz = a.z - P.z;
    if (Math.abs(dx) + Math.abs(dz) < 1e-6) { dx = 0; dz = 1; }
    const tx = Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity;
    const tz = Math.abs(dz) > 1e-6 ? hd / Math.abs(dz) : Infinity;
    const t = Math.min(tx, tz);
    const x = P.x + dx * t, z = P.z + dz * t;
    return { x, y: groundAt(x, z), z };
  }

  /** 楼内电梯井：footprint 内、朝门口方向的 45% 处。上下楼在这里垂直过渡，
   *  而不是从房间窗口拉一条斜线穿过半座城。 */
  function liftOf(a, placeKey, levelY) {
    const P = places[placeKey];
    if (!P) return { x: a.x, y: levelY, z: a.z };
    const d = doorOf(a, placeKey);
    return {
      x: P.x + (d.x - P.x) * 0.45,
      y: levelY,
      z: P.z + (d.z - P.z) * 0.45,
    };
  }

  /** 该段结束时的房间锚点。 */
  function anchorFor(key, seg, keyIndex) {
    const placeKey = seg.place || 'home';
    const sceneId = sceneIdFor(placeKey, seg.spot, seg.activity);
    const P = places[placeKey] || { x: 0, z: 0, w: 20, d: 20 };
    const A = sceneId && anchors[sceneId];
    // 【楼层听锚点的】life-scenes 用 floorFromId 把房间摆在真实楼板上；
    // 这里再用 spot 里第一个「9F」去标楼层，就会和 y 差好几层。
    const floor = A ? floorFromSceneId(sceneId) : floorFromSpot(seg.spot, placeKey);
    let x, y, z;
    if (A) { x = A.x; y = A.y; z = A.z; }
    else {
      // 没有 life-scenes 锚点时也不能把人堆在中心：按 spot 哈希散到 footprint 内
      const h1 = hash(`${placeKey}|${seg.spot || ''}`);
      const h2 = hash(`${seg.spot || ''}|${placeKey}`);
      x = P.x + (h1 * 2 - 1) * (P.w || 20) * 0.28;
      z = P.z + (h2 * 2 - 1) * (P.d || 20) * 0.28;
      const base = groundAt(P.x, P.z);
      // 兜底也要用该栋楼的真实层高（办公楼 5 m、学校 5 m、诊所 4 m、公寓 3.55）
      const fit = (opt.placeFit && opt.placeFit[placeKey])
        || ({ home: { floorH: 3.55 }, office: { floorH: 5 }, clinic: { floorH: 4 },
              school: { floorH: 5 }, cafe: { floorH: 3.3 } }[placeKey]) || null;
      const fh = (fit && fit.floorH) || 3.6;
      y = seg.indoor ? base + (floor - 1) * fh : groundAt(x, z);
    }
    // 【2026-11-07 修正】旧版从场景锚点出发再按 footprint 铺 4 列网格，
    // 一个人在卧室会被推到 ±6.5 m 之外——直接穿墙/站到别的房间/站到楼外，
    // 正是用户说的「场景离谱」。现在只在锚点周围 0.5–1.1 m 的一圈里错开，
    // 保证「谁睡哪张床、谁站哪个吧台位」是准的，7 个人也不会叠在一个点。
    if (A) {
      const ang = (keyIndex * 2.399963 + hash(`${key}|${seg.spot}`) * 6.283) % 6.283;
      // 同一间房有多个人时按黄金角散到 1.5–3.4 m 的一圈：旧版只有
      // 0.5–1.06 m，0 点 7 个人全叠在一张床边站成一堆（实拍确认）。
      // 最后仍有碰撞推出兜底，人不会被塞进床/桌子里。
      const asleep = seg.clip === 'sleep'
        || (seg.a < 360 && (seg.clip === 'sit' || seg.clip === 'sleep'));
      // 睡觉的人要贴着床 / 书桌，不能因为避让被散到房间中央站着。
      const r = asleep
        ? 0.75 + (keyIndex % 3) * 0.42 + hash(`${key}|room`) * 0.25
        : 1.5 + (keyIndex % 4) * 0.55 + hash(`${key}|room`) * 0.4;
      x += Math.cos(ang) * r;
      z += Math.sin(ang) * r;
    } else {
      const cols = 4, col = keyIndex % cols, row = Math.floor(keyIndex / cols);
      const sx = Math.min(6.5, (P.w || 20) / 7);
      const sz = Math.min(3.2, (P.d || 20) / 7);
      x += (col - (cols - 1) / 2) * sx;
      z += (row - 0.5) * sz;
    }
    // 【人必须在楼里】房间锚点 + 错开之后若被推出 footprint，跟拍机位会
    // 跟着出楼，cameraInsideBuilding 判定失败 → 整栋楼不剖切 → 镜头前
    // 只剩一堵外墙（12:40 咖啡馆实拍）。留 1.2 m 边距钳回楼内。
    const pad = 1.2, hw = (P.w || 20) / 2 - pad, hd = (P.d || 20) / 2 - pad;
    x = clamp(x, P.x - Math.max(0.5, hw), P.x + Math.max(0.5, hw));
    z = clamp(z, P.z - Math.max(0.5, hd), P.z + Math.max(0.5, hd));
    if (!seg.indoor) y = groundAt(x, z);
    // 【实体碰撞】锚点常常正好落在床 / 吧台 / 课桌的中心（life-scenes 的
    // 场景原点就是家具中心），以前人就直接站在桌子里。这里按 0.34 m 的
    // 身体半径把锚点推到家具有空的地方；室内忽略 'building'（人本来就该在楼里）。
    if (collide) {
      const yy = seg.indoor ? y : groundAt(x, z);
      const ig = seg.indoor ? new Set(['building']) : null;
      const res = collide.resolve(x, z, 0.34, yy + 0.05, yy + 1.75, { ignoreTags: ig });
      if (!res.stuck) { x = res.x; z = res.z; }
    }
    // 在车里 / 街上的人不该被标成 6F、9F
    return {
      x, y, z, floor: seg.indoor ? floor : 1,
      place: placeKey, sceneId, indoor: !!seg.indoor,
    };
  }

  /** 3D 折线：每段 [x,y,z] + 该段的「所处场景」meta，并预计算累积弧长。
   *  【2026-11-08】meta 让赶路段能随路程切换室内外：楼内=卧室/工位，
   *  街上=通勤路段。旧版整段只有一个 indoor 标记，导致「从家走到咖啡馆」
   *  这 30 分钟里人在半空、还被算成在咖啡馆屋里（剖切 / 亮灯全错）。 */
  function makePath(raw) {
    const pts = [], metas = [];
    let carStartIdx = 0, carEndIdx = 0, hasCar = false;
    for (const p of raw) {
      const q = [p.x, p.y, p.z];
      const last = pts[pts.length - 1];
      // 必须用 3D 距离：电梯井里 x/z 不变、只有 y 变，按水平距离判重会把
      // 整段垂直运动丢掉，于是 9F 到地面变成一条斜穿全城的"飞行线"。
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) < 0.35) {
        // 同位置但语义不同的点（房间锚点恰好就是电梯井口）：不能把后一个
        // 点的 meta 丢掉，否则接下来的垂直下降段会被标成「还在房间里」，
        // 楼层校验会误报「5F 的人 y 只有 17 m」。
        if (p.meta) metas[metas.length - 1] = p.meta;
        const idx = pts.length - 1;
        if (p.car === 'start') { carStartIdx = idx; hasCar = true; }
        if (p.car === 'end') { carEndIdx = idx; hasCar = true; }
        continue;
      }
      pts.push(q);
      metas.push(p.meta || null);
      const idx = pts.length - 1;
      if (p.car === 'start') { carStartIdx = idx; hasCar = true; }
      if (p.car === 'end') { carEndIdx = idx; hasCar = true; }
    }
    if (pts.length < 2) {
      pts.push([pts[0][0], pts[0][1], pts[0][2] + 0.6]);
      metas.push(metas[0] || null);
    }
    const cum = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      cum.push(total);
    }
    // 【车只走街面那一段】car:'start' / car:'end' 由换楼路径标在「出门」和
    // 「到门口」两个点上。人继续走电梯上楼，车在这段弧长区间里沿 carPath 走，
    // 段首停在出发楼车库口、段尾停在目标楼车库口，绝不跟人进楼。
    let carStart = hasCar ? cum[carStartIdx] : 0;
    let carEnd = hasCar ? cum[carEndIdx] : total;
    if (carEnd - carStart < 0.6) carEnd = Math.min(total, carStart + 0.6);
    return { pts, cum, total, metas, carStart, carEnd, hasCar };
  }

  /** 沿弧长取点 + 切线朝向 + 这段路所在的场景。 */
  function sample(path, dist) {
    const { pts, cum, total, metas } = path;
    const d = clamp(dist, 0, total);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = pts[i - 1], b = pts[i];
    const seg = Math.max(1e-6, cum[i] - cum[i - 1]);
    const k = clamp((d - cum[i - 1]) / seg, 0, 1);
    return {
      x: a[0] + (b[0] - a[0]) * k,
      y: a[1] + (b[1] - a[1]) * k,
      z: a[2] + (b[2] - a[2]) * k,
      dx: b[0] - a[0], dz: b[2] - a[2],
      meta: metas[i - 1] || null,
    };
  }

  function rebuild() {
    compiled = {};
    stats = { keys: keys.length, segments: 0, routed: 0, local: 0, metres: 0, anchors: Object.keys(anchors).length };
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki];
      const raw = (timelines[key] || []).slice().sort((a, b) => a.a - b.a);
      const out = [];
      let prev = null;
      for (const seg of raw) {
        const cur = anchorFor(key, seg, ki);
        const a = Number(seg.a) || 0, b = Number(seg.b) || a + 1;
        const from = prev ? prev.anchor : cur;
        const samePlace = prev && prev.anchor.place === cur.place;
        // 【第一段不是「换楼」】没有 prev 时 !samePlace 恒为 true，会把 0 点
        // 睡觉误判成赶路（验收实测 7 个睡着的人集体在卧室播 walk）。
        const travel = !prev ? false
          : (TRAVEL_CLIP.has(seg.clip) || (seg.spot || '').includes('→') || !samePlace);
        const metaOf = (v) => ({
          indoor: !!v.indoor, place: v.place, sceneId: v.sceneId, floor: v.floor,
          placeName: (places[v.place] || {}).name || v.place,
        });
        const prevMeta = prev ? metaOf(prev.anchor) : metaOf(cur);
        const curMeta = metaOf(cur);
        const roadMeta = {
          indoor: false, place: 'street', sceneId: 'sc_road_commute', floor: 1,
          placeName: (places.street || {}).name || '通勤路上',
        };
        let path;
        let carPath = null;              // 纯地面车轨迹，与人轨迹分离
        if (!prev) {
          // 第一段：就在房间里小幅活动
          const m = {
            x: (from.x + cur.x) / 2 + 1.2, y: (from.y + cur.y) / 2,
            z: (from.z + cur.z) / 2 - 0.9,
          };
          path = makePath([
            { ...from, meta: curMeta }, { ...m, meta: curMeta }, { ...cur, meta: curMeta },
          ]);
          stats.local++;
        } else if (!samePlace) {
          // 换楼：楼内走到电梯 → 垂直降到地面 → 出楼门沿街网 → 进目标楼
          //        → 垂直升到目标层 → 走到房间。
          // 【人/车分流】人走上面整条线；车只走 start→end 之间的地面街网折线。
          // 旧版把车直接摆到 q.x/q.y/q.z，于是车从 9F 厨房开出来、在电梯井
          // 里垂直降落、最后开进 FAA 6F —— 用户原话「连着穿过了两个楼」。
          const A = doorOf(from, prev.anchor.place);
          const B = doorOf(cur, cur.place);
          const liftA = liftOf(from, prev.anchor.place, from.y);
          const liftAg = { x: liftA.x, y: groundAt(liftA.x, liftA.z), z: liftA.z };
          const liftB = liftOf(cur, cur.place, 0);
          const liftBg = { x: liftB.x, y: groundAt(liftB.x, liftB.z), z: liftB.z };
          const liftBt = { x: liftB.x, y: cur.y, z: liftB.z };
          // 【避障寻路】路网是棋盘、楼是真实轮廓，两套几何天生打架：FAA 办公楼
          // 与 565 Penn 公寓的实体就横跨在路中线上。先让 Dijkstra 给压楼边加
          // 14 倍代价绕行，再对整条折线（含首尾最后一公里）做逐段清扫，
          // 把任何落在实体内的点推到楼外，保证车沿折线插值也不进楼。
          const roadRaw = G
            ? routeOnGraph(G, A.x, A.z, B.x, B.z, 3000,
              { blocked: blockedForCar, blockPenalty: 14 })
            : [[A.x, A.z], [B.x, B.z]];
          const street = sanitizePolyline(roadRaw, {
            blocked: blockedForCar, snapOut: snapOutSolid,
            pad: CAR_PAD, pushPad: CAR_PAD + 0.5, step: 3,
          });
          if (street.length < 2) street.push([B.x, B.z]);
          const rawPts = [
            { x: from.x, y: from.y, z: from.z, meta: prevMeta },
            { x: liftA.x, y: from.y, z: liftA.z, meta: { ...prevMeta, inTransit: true } },
            { x: liftAg.x, y: liftAg.y, z: liftAg.z, meta: roadMeta },
          ];
          street.forEach(([x, z], i) => rawPts.push({
            x, y: groundAt(x, z), z, meta: roadMeta,
            ...(i === 0 ? { car: 'start' } : {}),
            ...(i === street.length - 1 ? { car: 'end' } : {}),
          }));
          rawPts.push(
            { x: liftBg.x, y: liftBg.y, z: liftBg.z, meta: { ...curMeta, inTransit: true } },
            { x: liftBt.x, y: liftBt.y, z: liftBt.z, meta: curMeta },
            { x: cur.x, y: cur.y, z: cur.z, meta: curMeta },
          );
          path = makePath(rawPts);
          // 车只沿街面那一截走：贴地、不进楼、不坐电梯
          const carPts = street.map(([x, z]) => ({ x, y: groundAt(x, z), z }));
          if (carPts.length < 2) {
            carPts.push({ x: carPts[0].x, y: carPts[0].y, z: carPts[0].z + 0.6 });
          }
          carPath = makePath(carPts);
          stats.routed++;
        } else {
          // 同楼内换房间（主卧→厨房、9F→走廊）：室内短折线
          const mid = {
            x: (from.x + cur.x) / 2 + (hash(`${key}|${seg.a}`) - 0.5) * 2.4,
            y: (from.y + cur.y) / 2,
            z: (from.z + cur.z) / 2 + (hash(`${seg.a}|${key}`) - 0.5) * 2.4,
          };
          path = makePath([
            { ...from, meta: prevMeta }, { ...mid, meta: curMeta }, { ...cur, meta: curMeta },
          ]);
          stats.local++;
        }
        const spanSec = Math.max(1, (b - a) * 60);
        const asleep = seg.clip === 'sleep'
          || (a < 360 && (seg.clip === 'sit' || seg.clip === 'sleep'));
        // 【睡觉不能播 walk】0 点段原样复用「前 22% 走进屋」会让 7 个睡着
        // 的人集体在卧室里迈腿（验收实测）。睡觉段直接落在床上，只留翻身。
        // 其余停留段前 22% 走进屋、之后坐下；赶路段几乎整段在走。
        // 【赶路段也不能把路程摊薄】旧版 travel 一律 moveFrac=0.92，
        // 于是「9F 主卧 → 走廊」这条 10 m 的路被摊到 120 分钟段里，实测
        // 0.085 m/min，腿却按 1.25 m/s 播 walk —— 用户说的「原地跑步」。
        // 现在所有段都按 1.25 m/s 的真实步速算出该走多久，走完就静止：
        // 长通勤走满大半个段，室内短折线几秒走完，绝不慢速滑行。
        const walkSec = path.total / WALK.BASE;
        const moveFrac = asleep && !travel ? 0
          : travel ? Math.min(0.92, walkSec / spanSec)
            : Math.min(0.20, walkSec / spanSec);
        const speed = moveFrac > 0 ? path.total / (spanSec * moveFrac) : 0;
        const kind = activityKind(seg, travel);
        const stillClip = POSE_BY_KIND[kind] || 'idle';
        const driftOK = ALLOW_DRIFT.has(kind);
        // 【只有真开车才收进车里】骑手的 `ride` 是电动车跑单，主场景里没有
        // 他的车模型；旧版把 ride 也算 inVehicle，于是 300 分钟里人显示在
        // 街边却 `moving=false` 原地坐着 —— 又一种莫名其妙。现在骑手照常
        // 沿街网走，只有 mark / boss 的 drive 段才隐藏人、把车摆到轨迹上。
        const inVehicle = seg.clip === 'drive';
        out.push({
          a, b, path, moveFrac, speed, stillClip, inVehicle, travel, asleep,
          kind, driftOK,
          carPath: inVehicle ? carPath : null,
          carStart: path.carStart, carEnd: path.carEnd,
          clip: seg.clip, activity: seg.activity, note: seg.note,
          mood: seg.mood, stress: seg.stress, spot: seg.spot,
          place: cur.place, floor: cur.floor, sceneId: cur.sceneId,
          indoor: cur.indoor, anchor: cur, phys: seg.phys || null,
        });
        stats.segments++;
        stats.metres += path.total;
        prev = out[out.length - 1];
      }
      compiled[key] = out;
    }
    console.info(`[day-motion] ${stats.keys} 人 / ${stats.segments} 段 / 路网行程 ${stats.routed}`
      + ` / 室内移动 ${stats.local} / 总里程 ${Math.round(stats.metres)} m / 房间锚点 ${stats.anchors}`);
  }

  function at(key, minute) {
    const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
    if (inCrisis(m)) {
      return { key, minute: m, crisis: true, place: null, indoor: false, inVehicle: false };
    }
    const segs = compiled[key];
    if (!segs || !segs.length) return null;
    let seg = segs[segs.length - 1];
    for (const s of segs) { if (m >= s.a && m < s.b) { seg = s; break; } }
    const u = clamp((m - seg.a) / Math.max(1, seg.b - seg.a), 0, 1);
    const s = seg.moveFrac > 0 ? clamp(u / seg.moveFrac, 0, 1) : 1;
    const p = sample(seg.path, s * seg.path.total);
    // 【车的独立位置】人在下楼 / 上楼时车停在车库口，只有街面那一截才沿
    // carPath 走。渲染层一律读 q.car 摆车，绝不再用 q.x/q.y/q.z —— 后者
    // 含 9F 房间与电梯井，车照着走就会开进楼里、甚至从半空降下来。
    let car = null;
    if (seg.inVehicle && seg.carPath) {
      const d = s * seg.path.total;
      const cu = clamp((d - seg.carStart) / Math.max(0.6, seg.carEnd - seg.carStart), 0, 1);
      const cp = sample(seg.carPath, cu * seg.carPath.total);
      car = {
        active: true, x: cp.x, y: groundAt(cp.x, cp.z), z: cp.z,
        heading: Math.atan2(cp.dx || 0.001, cp.dz || 0.001),
        moving: cu > 0.0005 && cu < 0.9995, progress: cu,
      };
    }
    // 【赶路段：场景随路程切换】在楼里就是那个房间，出了门就是通勤路段，
    // 到了下一栋楼就是目标房间。旧版整段用终点房间的 indoor/场景，于是
    // 「从 9F 去咖啡馆」这半小时里人被算成一直坐在咖啡馆屋里：不淋雨、
    // 楼被剖开、室内灯白亮，而人其实在街上（全天审计 40+ 条错配）。
    const meta = seg.travel && p.meta ? p.meta : null;
    const place = meta ? meta.place : seg.place;
    const sceneId = meta ? meta.sceneId : seg.sceneId;
    const floor = meta ? meta.floor : seg.floor;
    const indoor = meta ? meta.indoor : seg.indoor;
    const placeName = meta ? meta.placeName
      : ((places[place] || {}).name || place);
    // 【y 锁在楼板上】停留段若沿路径插值 y，人会在 6F / 1F 之间斜穿楼板
    // （实测同一层工位 8:20 在 17.9 m、15:00 在 25.1 m）。只有真正进出楼
    // 的 travel 段才做垂直过渡（电梯 / 楼梯），且垂直段已被拆进路径。
    let x = p.x, y = seg.travel ? p.y : seg.anchor.y, z = p.z;
    // 模型没有躺卧 clip，睡觉用 sit 近似。把人抬到床面高度，否则会出现
    // 「半夜悬空坐在地板中央」——0 点实拍里最扎眼的一处。
    if (seg.asleep && indoor && !seg.travel) y += 0.46;
    let moving = seg.moveFrac > 0 && u < seg.moveFrac - 0.002
      && seg.path.total > 0.5 && !seg.inVehicle;
    let heading = Math.atan2(p.dx || 0.001, p.dz || 0.001);
    let clip = moving ? (seg.speed > 2.2 ? 'run' : 'walk') : seg.stillClip;
    let speed = moving ? seg.speed : (seg.inVehicle ? seg.speed : 0);
    let drifting = false;   // true = 这个位移来自「起身踱步」，不是赶路

    // 【站定之后也要活着，但绝不原地跑】旧版用整段的正弦把 3.2 m 摊到
    // 几十分钟（0.001 m/帧），却在 |sin|>0.62 的 40% 时间里播 walk ——
    // 这正是用户看到的「说在走动、人却原地跑步」。现在每 ~14 分钟只安排
    // 一次 4.8 秒的真实往返（1.33 m/s），窗口外完全静止并保持姿势。
    // m 是浮点分钟：播放时连续推进会经过窗口，拖时间轴落在整分钟则静止。
    if (!moving && !seg.inVehicle && !seg.travel) {
      const span = Math.max(1, seg.b - seg.a);
      const asleep = seg.asleep;
      const driftOK = !!seg.driftOK && !asleep;
      const stayMin = Math.max(0.1, span * (1 - seg.moveFrac));
      const localMin = clamp(m - seg.a - span * seg.moveFrac, 0, stayMin);
      const cycles = Math.max(1, Math.round(stayMin / 14));
      const cycleMin = stayMin / cycles;
      const tIn = localMin % cycleMin;
      const WALK_SEC = 4.8;
      const sec = tIn * 60;
      const walking = driftOK && sec < WALK_SEC;
      const leg = sec <= WALK_SEC / 2 ? sec / (WALK_SEC / 2)
        : Math.max(0, (WALK_SEC - sec) / (WALK_SEC / 2));
      const amp = walking ? 3.2 * leg
        : (asleep ? 0.06 * Math.sin(localMin * Math.PI / 7) : 0);
      const ang = hash(`${key}|${seg.a}|drift`) * Math.PI * 2;
      const dxo = Math.cos(ang) * amp, dzo = Math.sin(ang) * amp;
      if (walking) { moving = true; clip = 'walk'; speed = 1.33; drifting = true; }
      if (collide && amp > 0.05) {
        const ig = indoor ? new Set(['building']) : null;
        const hit = collide.blockedCircle(x + dxo, z + dzo, 0.3,
          y + 0.05, y + 1.75, { ignoreTags: ig });
        if (hit) { moving = false; drifting = false; clip = seg.stillClip; }
        else { x += dxo; z += dzo; }
      } else {
        x += dxo; z += dzo;
      }
      if (moving) heading = Math.atan2(Math.cos(ang), Math.sin(ang));
    }
    // 【最后一道保险】不论前面怎么算（锚点、沿路插值、漂移），出门前再测一次：
    // 站在家具/墙里就推出去。这一步保证「任意时刻任何人都不穿模」。
    if (collide) {
      const ig = indoor ? IGN_B : null;
      if (collide.blockedCircle(x, z, 0.32, y + 0.1, y + 1.7, { ignoreTags: ig })) {
        const rr = collide.resolve(x, z, 0.34, y + 0.05, y + 1.8, { ignoreTags: ig });
        if (!rr.stuck) { x = rr.x; z = rr.z; }
      }
    }
    // 【坐姿落地校正】Mixamo 的 sit clip 仍带约 0.26 m 的骨盆抬升，直接用
    // 脚底高度摆人会出现「悬空坐在半空」（12:40 咖啡馆实拍）。放在最后，
    // 用最终 clip 判定：间歇起身踱步改成 walk 之后不会再把人按进地板。
    // 模型 / 跟拍机位 / 室内灯 / 碰撞都读同一个 y，统一在这里扣掉。
    if (clip === 'sit') y -= 0.26;
    return {
      key, minute: m, crisis: false, segIndex: segs.indexOf(seg),
      a: seg.a, b: seg.b, progress: u,
      x, y, z, heading,
      clip, moving, speed,
      // 停留段开头那几秒「走到餐桌 / 走到工位」是 approach，不是「吃饭时
      // 莫名其妙在走」；分开标注后，全天审计与 HUD 都不会读错动作语义。
      kind: (moving && !seg.travel && !drifting) ? 'approach' : seg.kind,
      drifting, travel: !!seg.travel,
      inTransit: !!(meta && meta.inTransit),
      inVehicle: seg.inVehicle, indoor,
      floor, place, placeName,
      sceneId, spot: seg.spot, activity: seg.activity,
      note: seg.note, mood: seg.mood, stress: seg.stress,
      label: seg.activity || seg.spot, clipLabel: seg.clip, phys: seg.phys,
      car,
    };
  }

  /** 全天任意时刻马克的车在哪：开车段沿车轨迹走，其余时段停在最近一次
   *  行程的终点（上班停公司）或首次行程的起点（清晨停家车库口）。
   *  这样车不会在段与段之间瞬移回 demo 的停车位。 */
  function carAt(minute, key = 'mark') {
    const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
    const segs = compiled[key] || [];
    for (const s of segs) {
      if (!s.inVehicle || !s.carPath || m < s.a || m >= s.b) continue;
      const q = at(key, m);
      if (q && q.car) return q.car;
    }
    let last = null, first = null;
    for (const s of segs) {
      if (!s.inVehicle || !s.carPath) continue;
      if (!first) first = s;
      if (s.b <= m) last = s;
    }
    const pick = last || first;
    if (!pick) return null;
    const cp = sample(pick.carPath, last ? pick.carPath.total : 0);
    return {
      active: true, parked: true, moving: false, progress: last ? 1 : 0,
      x: cp.x, y: groundAt(cp.x, cp.z), z: cp.z,
      heading: Math.atan2(cp.dx || 0.001, cp.dz || 0.001),
    };
  }

  const atAll = (minute) => {
    const o = {};
    for (const k of keys) o[k] = at(k, minute);
    return o;
  };

  /** 此刻有哪些室内楼层有人在（给 main.js 的自动剖切用）。 */
  function occupiedIndoors(minute) {
    const out = {};
    for (const k of keys) {
      const q = at(k, minute);
      if (!q || q.crisis || !q.indoor) continue;
      const cell = out[q.place] || (out[q.place] = { floors: new Set(), who: [] });
      cell.floors.add(q.floor);
      cell.who.push(k);
    }
    for (const v of Object.values(out)) v.floors = [...v.floors];
    return out;
  }

  rebuild();
  return {
    ok: true, keys, at, atAll, carAt, setAnchors, occupiedIndoors,
    stats: () => ({ ...stats }),
    /** 无头验收：车轨迹是否干净（0 个点落在可见建筑实体内）。 */
    carDebug: (minute) => ({ minute, car: carAt(minute), solid: carAt(minute)
      ? hitSolid(carAt(minute).x, carAt(minute).z, 0) : null }),
    /** 无头验收：一行看清 7 人此刻在哪、在不在动。 */
    debug: (minute) => atAll(minute),
  };
}
