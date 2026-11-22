/**
 * crowd-life.js — 全城随机市民的「真实社会状态」。
 *
 * 【用户 2026-11-07】「给他们接入真实的故事背景和这个脑子，跟那 6 个人一模一样，
 *  不用做展示面板，场景也要搭好」。
 * 【用户 2026-11-10】「全城随机加人…老人/小孩/中年不同的移动速度、心理状态、
 *  决策思考方向，有的人经验好有的人不足；去家里或去哪个地方不用做得特别细，
 *  给家设置一个阈值/上限让人直接进去就行，保证动作连贯性」。
 *
 * 这一层不建 UI，让每个路人和 7 个具名角色共用：
 *   - decision.js 的 Brain / Belief（感知 → 信念 → 候选效用打分）
 *   - person-state.js 的 PersonState（饥饿 / 淋湿 / 体力 / 伞）
 *   - day-schedule.js 的 daySegment（10 段 24h 作息）
 *   - life-scenes.js 的 3D 房间锚点（镜头剖开某栋楼时屋里才显示人）
 *   - citizen.js 的年龄 / 经验档案（步速、心理、Brain 权重、候选集）
 *
 * 【简化而不失连贯】不为几百人各建一间房：每个「家 / 岗位」只是一个
 * **容量制门牌**（DEST_CAP 人上限），人满了自动分到下一个门牌；街面上的人
 * 到 enterRadius 阈值就直接进屋（模型收起），不必走楼梯电梯。进屋过渡由
 * ped.js 沿步行网再走 6.5 m 完成，播 walk 且有真实位移，绝不原地跑 / 瞬移。
 */
import { Brain, mulberry32 } from './decision.js';
import { PersonState } from './person-state.js';
import { DAY_THINK_STEP } from './day-think.js';
import { daySegment, PLACES } from './day-schedule.js';
import { makeCitizen, candidatesFor, AGE_GROUPS, AGE_BANDS } from './citizen.js';
import { pickRole, umbrellaChance, statusOf, WORK_BY_PLACE, ROLES } from './roles.js';
import { WALK } from './motion-units.js';
import { makeHazard, summarizeHazard } from './hazard.js';
import { samplePerson } from './kernel/population.js';
import { buildPeerNetwork } from './kernel/peer-network.js';
// 【2026-11-16 阶段3】逐人楼层：用真实建筑高度派生，替代从场景 id 猜楼层。
import { floorsFromHeight, floorElevationM, assignFloor } from './kernel/floors.js';

let PEER_STATS = null;
/** 参照群体的生成统计（模式、边数、度分布、孤立者占比），只读诊断用 */
export function peerNetworkStats() { return PEER_STATS; }

const XING = ['陈', '李', '王', '张', '刘', '周', '吴', '徐', '孙', '马', '朱', '胡', '林', '何', '郭', '高'];
const MING = ['志远', '晓雯', '建国', '雅琴', '子涵', '明轩', '思琪', '浩然',
  '雨桐', '嘉豪', '若曦', '文博', '静怡', '天佑', '欣妍', '俊杰', '一诺', '致远'];

/** 每个「家 / 岗位门牌」最多挂几个人。超了就分到下一个门牌。 */
/** 每个门牌的人数上限。1000 人时自动放宽：42 个门牌 × 每门 24 人，
 *  否则 1000 人会挤在前 42 个门牌上（实测最大 24/8 超限）。
 *  用户要的是「给家设一个阈值，到上限就让人直接进去」，不是一个固定数字。 */
export let DEST_CAP = 8;
const DOOR_COUNT = 42;           // 7 类地点 × 每类 6 个门口
/** 到门口这个半径内就算「进去了」，模型直接收起，不做精细进门动画。 */
export const ENTER_RADIUS = 5.5;
/** 进屋前沿步行网还要走的距离（保证有真实位移、动作连贯）。 */
export const ENTER_DIST = 6.5;

// 职业 / 社会地位 / 场景 / 允许年龄段统一在 roles.js，避免「75 岁钢筋工」这类错配。

// 只有马克住在 565 Penn 的精细公寓。其他市民的家是**全城真实建筑门牌**，
// 不再从这 9 个房间循环分房（旧版因此把 1000 人全塞进马克家）。
const MARK_HOME_SCENES = ['sc_home_bedroom', 'sc_home_kitchen', 'sc_home_living'];
// 【2026-11-13 用户要求】「只保留一个马克这样的情形就行了，剩下的其他都不用了，
//  但是剩下的就是不要失去它的功能」。CAST 收到 1 项后：第 0 个人仍是演示人，
//  第 1..2999 人不再被具名覆写，也**不再跳过** bindResidents 的真实住宅 /
//  岗位门牌绑定 —— 他们照样有职业、年龄、圈层、目标、每 0.5~1 秒的自主判断，
//  只是不再各自占一个面板行、不再挂一套旧故事剧本。
const CAST = [
  { name: '马克·陈', role: 'FAA 职员', age: 34, ageGroup: 'adult', band: 'prime', workPlace: 'office', workScene: 'sc_office_6f', markHome: true },
];
/** 街上 / 避雨的片区锚点：让不同作息的人散到不同街段，不挤在一个站牌下。 */
const STREET_SCENES = [
  'sc_road_commute', 'sc_street_corner', 'sc_street_ride', 'sc_street_shelter',
];

/** 10 段作息：和 day-schedule.js 的 daySegment 一一对应。where / indoor / clip 严格同源。 */
const SEG = {
  night:    { where: 'home',    clip: 'sit',  act: '在家休息',    stress: 0.03, mood: '平静', factor: 0.0,  indoor: true },
  morning:  { where: 'road',    clip: 'walk', act: '早高峰通勤',  stress: 0.08, mood: '平静', factor: 1.0,  indoor: false },
  am:       { where: 'work',    clip: 'sit',  act: '上班 / 上课', stress: 0.10, mood: '专注', factor: 0.0,  indoor: true },
  lunch:    { where: 'road',    clip: 'walk', act: '出去吃饭',    stress: 0.05, mood: '放松', factor: 0.85, indoor: false },
  pm:       { where: 'work',    clip: 'sit',  act: '上班 / 上课', stress: 0.09, mood: '专注', factor: 0.0,  indoor: true },
  preRain:  { where: 'road',    clip: 'walk', act: '起雨收东西',  stress: 0.24, mood: '警觉', factor: 0.9,  indoor: false },
  crisis:   { where: 'shelter', clip: 'run',  act: '暴雨避险',    stress: 0.62, mood: '紧张', factor: 1.3,  indoor: false },
  postRain: { where: 'shelter', clip: 'run',  act: '找高处避雨',  stress: 0.58, mood: '焦虑', factor: 1.2,  indoor: false },
  return:   { where: 'road',    clip: 'walk', act: '绕开积水回家', stress: 0.45, mood: '紧张', factor: 0.85, indoor: false },
  evening:  { where: 'home',    clip: 'sit',  act: '在家休息',    stress: 0.18, mood: '疲惫', factor: 0.0,  indoor: true },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 8 档作息相位，均匀覆盖 24h。同一个人固定一档，可复现。
 *  每个片区按人序轮转这 8 档 —— 保证「全城有人」的同时「每个街区也有人」，
 *  不会出现镜头所在片区恰好全员上班、街上空无一人的情况。 */
const SHIFT_OFFSETS = [0, 180, 360, 540, 720, 900, 1080, 1260];
function parsePlace(P) {
  if (!P) return { x: 0, z: 0, w: 20, d: 20 };
  if (Array.isArray(P)) return { x: P[0], z: P[1], w: P[3] || 20, d: P[4] || 20 };
  return { x: P.x ?? P.cx ?? 0, z: P.z ?? P.cz ?? 0, w: P.w ?? 20, d: P.d ?? 20 };
}

/**
 * 容量制门牌池：每个地点按 golden angle 外推 6 个门口，每门 DEST_CAP 人。
 * 这只是「家 / 岗位」的抽象归属，不新建任何 3D 房间 —— 用户明确说不用做细。
 */
function buildDoors(places) {
  const keys = ['home', 'office', 'cafe', 'clinic', 'school', 'site', 'street'];
  const out = { home: [], byPlace: {} };
  for (const k of keys) {
    const P = parsePlace(places[k]);
    out.byPlace[k] = [];
    for (let j = 0; j < 6; j++) {
      const ang = (j * 2.399963 + (k.length * 0.7)) % (Math.PI * 2);
      const pad = 6 + (j % 3) * 3;
      const x = P.x + Math.cos(ang) * ((P.w || 20) / 2 + pad);
      const z = P.z + Math.sin(ang) * ((P.d || 20) / 2 + pad);
      const home = { id: `home_${k}_${j}`, place: 'home', x, z, cap: DEST_CAP };
      const work = { id: `work_${k}_${j}`, place: k, x, z, cap: DEST_CAP };
      out.home.push(home);
      out.byPlace[k].push(work);
    }
  }
  return out;
}

export function createCrowdLife({
  count = 240, seed = 20261110, minute = () => 0,
  depthAt = () => 0, places = PLACES,
} = {}) {
  DEST_CAP = Math.max(8, Math.ceil(count / DOOR_COUNT));
  const persons = [];
  const DOORS = buildDoors(places);
  let anchors = {};
  // 【2026-11-10 闭环】ped.js 建好真实 walknet 后注入 route-brain 寻路器与
  // 全员实时位置表。没有它时退化为纯记录（老行为），不影响其它模块。
  let planner = null;
  let posSource = null;
  let liveOverride = null;   // 实时目标对社会状态的接管口（ped.js 注入）
  const ALL_DOORS = [...DOORS.home,
    ...Object.values(DOORS.byPlace).reduce((a, b) => a.concat(b), [])];

  /** 找一个「身边看得见、经验比自己好」的具体的人，供 follow 候选真的跟着走。 */
  function findLeader(i, pos) {
    const arr = posSource ? posSource() : null;
    if (!arr) return null;
    let best = null, bd = Infinity;
    for (const o of arr) {
      if (!o || o.i === i || !o.obj || !o.obj.position || !o.obj.visible) continue;
      const pr = persons[o.i];
      if (!pr || !pr.citizen.veteran) continue;
      const d = Math.hypot(o.obj.position.x - pos.x, o.obj.position.z - pos.z);
      if (d > 6 && d < 70 && d < bd) {
        bd = d;
        best = { i: o.i, x: o.obj.position.x, z: o.obj.position.z };
      }
    }
    return best;
  }

  for (let i = 0; i < count; i++) {
    const rand = mulberry32(seed + i * 977);
    // 【2026-11-15 真实人群】一次抽一条真实 ACS 个体记录，
    // 年龄 / 性别 / 职业 / 通勤 / 户内未成年 / 户车数全部来自同一个人，
    // 联合分布天然成立。旧版是各模块各按自设权重抽一次，人被拼碎了。
    const real = samplePerson(i, seed);
    const citizen = makeCitizen(i, seed, real);
    const ageKey = citizen.ageGroup;
    // 职业不再是「按年龄带 + 自设权重抽」，直接读这条真实记录的 SOC 大类。
    const job = pickRole(real);
    const status = statusOf(job.role);
    const name = XING[Math.floor(rand() * XING.length)] + MING[Math.floor(rand() * MING.length)];
    // 【伞只算一次】旧版 p.hasUmbrella 与 phys.hasUmbrella 各 rand() 一次，
    // 1000 人里 469 人自相矛盾（HUD 说有伞、生理层当没伞淋雨）。
    const hasUmb = rand() < umbrellaChance(job.role, citizen.ageBand);
    // 【灾害履历】与老练度不同的独立维度：有没有亲历过内涝、有没有受训。
    // 用独立随机流，绝不消耗上面那条 rand()（否则门牌/伞/班次全部漂移）。
    const hazard = makeHazard(i, {
      band: citizen.ageBand, status, place: job.place, role: job.role,
    });
    citizen.hazard = hazard;

    // 容量制分配：第 n 个人进第 floor(n/cap) 个门牌，天然保证不超上限。
    // 岗位门牌 / 场景都落在本人 job.place 那一片，不与身份错配。
    const slot = Math.floor(i / DEST_CAP);
    const pool = DOORS.byPlace[job.place] || DOORS.byPlace.home;
    const workPool = WORK_BY_PLACE[job.place] || WORK_BY_PLACE.home;
    const homeDoor = DOORS.home[slot % DOORS.home.length];
    const workDoor = pool[slot % pool.length];
    const streetDoor = pool[(i * 5 + 3) % pool.length];
    const placeIdx = i % DEST_CAP;

    // 班次先按 i 轮转；ped.js 建好片区后 setClusters() 会按「片区内的序号」
    // 再轮转一次，让每个片区都覆盖 8 档作息。±35 分钟抖动避免整条街同时切换。
    const phaseJitter = Math.round((rand() - 0.5) * 70);
    const shift = SHIFT_OFFSETS[i % SHIFT_OFFSETS.length];
    const phase = shift + phaseJitter;
    // 决策错峰：不在同一分钟让几百个 Brain 一起扫感知栅格。
    const thinkSlot = i % DAY_THINK_STEP;

    persons.push({
      i, key: `crowd_${i}`, name, role: job.role, status,
      real,                       // 真实 ACS 记录，供圈层 / 目标 / 判断内核读取
      socCode: job.socCode,
      hazard,
      ageBand: citizen.ageBand, ageBandLabel: citizen.ageBandLabel,
      profileKey: citizen.profile.key,
      citizen, phase, phaseJitter, cluster: 0, thinkSlot, placeIdx,
      homeDoor, workDoor, streetDoor,
      homeScene: `residence_unassigned_${i}`,
      interiorVisible: false,       // 普通住宅是真实门牌，但不借用马克的室内模型
      homeBuilding: null,
      workScene: workPool[slot % workPool.length],
      streetScene: STREET_SCENES[i % STREET_SCENES.length],
      outdoorScene: job.outdoorScene
        || ({ site: 'sc_site_pit', street: 'sc_street_ride' }[job.place] || 'sc_road_commute'),
      workPlace: job.place,
      outdoor: !!job.outdoor, nightShift: !!job.night,
      hasUmbrella: hasUmb,
      brain: new Brain({ profile: citizen.profile, depthAt, seed: seed + i * 31 }),
      phys: new PersonState({
        key: `crowd_${i}`, profile: citizen.profile,
        hasUmbrella: hasUmb,
        hunger: 8 + Math.floor(rand() * 28),
        wetness: rand() * 0.12,
        stamina: Math.round(82 * citizen.staminaBase + rand() * 16 * citizen.staminaBase),
      }),
      lastDecide: -999,
      workInteriorVisible: ['cafe', 'clinic', 'school', 'site'].includes(job.place),
    });
  }

  // 【2026-11-18 从众支路：合成自我中心网络】
  // ACS microsample 没有户号（SERIALNO），无法把具体的人还原成真实同户。
  // 这里按每人的真实户规模（ACS 记录的 householdSize）连续组户，同户互为
  // 同伴，上限 5 人（Borowski 2023 对自我中心网络的定义）。
  // 这是合成网络：户规模分布来自 ACS 真实记录，但「谁和谁一户」是合成的，
  // 不是真实社会网络调查数据；拿到真实网络后应替换这里。
  // 目的：让 kernel/cohort.js 的 peersStay 不再恒 0，而是由同伴的实时避险
  // 状态算出来（见 live-agent.js 的 peersStayOf）。
  (function buildHouseholds() {
    let k = 0;
    while (k < persons.length) {
      const hs = Math.max(1, Math.min(5, Number(persons[k].real && persons[k].real.householdSize) || 1));
      const grp = [];
      for (let m = 0; m < hs && k < persons.length; m++, k++) grp.push(k);
      for (const a of grp) {
        // peers = 参照群体（同户 + 后配邻居，见下方 buildNeighbourPeers）；
        // household = 同户成员（不含自己），门 5 的照护责任只认这个集合里的
        // 未成年成员 —— 邻居家孩子不算自己的孩子。合成性同上：ACS 无户号，
        // 「谁和谁一户」是按户规模连续组出来的。
        persons[a].peers = grp.filter((b) => b !== a);
        persons[a].household = grp.filter((b) => b !== a);
      }
    }
  })();

  // 前 7 个行人与具名角色一一对应，共享同一目标、位置与判断，不再另跑剧本。
  // 【2026-11-15】具名演示角色是**手写的展示人物，不属于 ACS 抽样人群**。
  // 旧名册会覆盖年龄和职业，若不标明，决策内核会拿真实记录的年龄去判断一个
  // 名册年龄的人（冒烟里出现过「显示 34 岁、真实记录 14 岁」）。
  // 这里显式标记为演示角色，并在统计里排除，避免把 7 个编写出来的人混进
  // 「人群与真实分布一致」的结论。
  for (let i = 0; i < Math.min(CAST.length, persons.length); i++) {
    const p = persons[i], c = CAST[i];
    p.name = c.name; p.role = c.role; p.key = i === 0 ? 'mark' : `cast_${i}`;
    p.isCast = true;
    // 具名角色年龄必须和身份一致：旧名册里出现过“81 岁的小学三年级”，
    // 步速、心理、候选集全都跟错。这里把年龄与对应基线一起改掉。
    const cz = p.citizen;
    cz.age = c.age; cz.ageGroup = c.ageGroup;
    cz.ageBand = c.band;
    cz.ageBandLabel = (AGE_BANDS.find((B) => B.id === c.band) || {}).label || '';
    p.ageBand = c.band; p.ageBandLabel = cz.ageBandLabel;
    p.status = statusOf(c.role);
    // 年龄以名册为准同步到真实记录字段，让判断内核、伤亡判定、显示层
    // 读到同一个岁数；同时打上标记，不冒充真实抽样记录。
    p.real = { ...p.real, age: c.age, isCast: true,
      note: '具名演示角色，手写名册覆盖，不属于 ACS 抽样人群' };
    cz.speedAbs = c.ageGroup === 'child' ? WALK.BASE * 0.76 : WALK.BASE;
    cz.thinking = c.ageGroup === 'child' ? '年纪小·找大人·容易受惊'
      : `成年·${cz.veteran ? '经验老到·会绕行' : '经验一般·按习惯走'}`;
    p.workPlace = c.workPlace; p.workScene = c.workScene;
    p.outdoor = !!c.outdoor; p.nightShift = false;
    p.workDoor = (DOORS.byPlace[c.workPlace] || DOORS.byPlace.office)[0];
    p.streetDoor = (DOORS.byPlace[c.workPlace] || DOORS.byPlace.street)[0];
    p.workInteriorVisible = true;
    if (c.markHome) {
      p.homeScene = MARK_HOME_SCENES[0];
      p.interiorVisible = true; p.homeBuilding = '565Penn';
      // 马克是唯一保留 3D 伞模型的角色，生理层必须与展示层一致。
      p.hasUmbrella = true; p.phys.hasUmbrella = true;
    }
  }

  /** ped.js 建好片区后回填：让每个片区内部也轮转 8 档作息。 */
  function setClusters(arr) {
    if (!arr) return;
    const rank = {};
    for (let i = 0; i < persons.length; i++) {
      const c = Number(arr[i]) || 0;
      const r = rank[c] || 0; rank[c] = r + 1;
      persons[i].cluster = c;
      persons[i].phase = SHIFT_OFFSETS[r % SHIFT_OFFSETS.length] + persons[i].phaseJitter;
    }
  }

  /**
   * 把每名市民绑定到全城真实建筑门牌。peds 的出生片区决定候选住宅，
   * SOLIDS 决定那栋可见建筑在哪里；同一住宅门牌容量有限，不能全塞进剧情楼。
   * 这是固定社会关系，不是每帧随机：家、岗位、常去餐馆在一天内都不变。
   */
  function bindResidents(peds, solids) {
    if (!Array.isArray(peds)) return;
    const rects = solids && Array.isArray(solids.rects) ? solids.rects : [];
    const load = new Map();
    const workLoad = new Map();
    // 【3000 人自适应容量】旧版写死每栋 6 人 → 433 栋只能装 2598 人，
    // 超出的几百人全被丢到「街上门牌」。现在按真实建筑数与总人数算，
    // 并留 1.6 倍余量；一栋楼仍按 3 人一个门牌细分，不会叠成一个点。
    const capHome = Math.max(4, Math.ceil((count / Math.max(1, rects.length)) * 1.6));
    const capWork = Math.max(10, Math.ceil((count / Math.max(1, rects.length)) * 3.2));
    // 【2026-11-21】工作场所按建筑 function 匹配（building.json 的 function 字段：
    // office 195 / government 26 / university 72 / school 29 / hospital 4 /
    // retail 62 / commercial 45 栋）。岗位类别与建筑职能对齐，不把办公的人
    // 塞进住宅楼；匹配不到时退回办公/商业楼。
    const WORK_FN = {
      office: /^(office|government|public|civic|commercial|hotel)$|office/,
      school: /^(university|school|dormitory)$/,
      clinic: /^(hospital|pharmacy)$/,
      cafe: /^(retail|commercial|kiosk|hotel)$/,
    };
    const doorNear = (r, x, z, jig) => {
      const pad = 2.2;
      const xa = Math.max(r.minx, Math.min(r.maxx, x));
      const za = Math.max(r.minz, Math.min(r.maxz, z));
      const cand = [
        { x: r.minx - pad, z: za }, { x: r.maxx + pad, z: za },
        { x: xa, z: r.minz - pad }, { x: xa, z: r.maxz + pad },
      ];
      cand.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
      const d = cand[Math.min(cand.length - 1, jig % cand.length)];
      // 同一侧门口也按人序沿墙错开，不在墙上叠成一个点。
      const t = ((jig * 0.6180339) % 1 - 0.5) * 5;
      return Math.abs(d.x - r.minx) < 0.01 || Math.abs(d.x - r.maxx) < 0.01
        ? { x: d.x, z: d.z + t } : { x: d.x + t, z: d.z };
    };
    // 【全城片区配额】旧版给每个人挑「离出生点最近的一栋楼」，而出生点
    // 集中在两个 focus，实测 3000 人只占 52/103 个 500m 网格、城市最外圈
    // 一个居民都没有。现在把真实建筑按 500m 网格分组，按人序轮转分配，
    // 每个有楼的片区都住着人；片区内仍按容量 + 就近选具体楼。
    const ZONE = 500;
    const zones = new Map();
    for (const r of rects) {
      const cx = (r.minx + r.maxx) / 2, cz = (r.minz + r.maxz) / 2;
      const k = Math.floor(cx / ZONE) + ',' + Math.floor(cz / ZONE);
      if (!zones.has(k)) zones.set(k, []);
      zones.get(k).push(r);
    }
    const zoneList = [...zones.values()];
    for (const ped of peds) {
      const p = persons[ped.i];
      if (!p) continue;
      if (p.key === 'mark') {
        ped.homeXZ = { x: p.homeDoor.x, z: p.homeDoor.z };
        if (now() < 360) ped.obj.position.x = p.homeDoor.x, ped.obj.position.z = p.homeDoor.z;
        continue;
      }
      const sx = ped.homeXZ ? ped.homeXZ.x : ped.obj.position.x;
      const sz = ped.homeXZ ? ped.homeXZ.z : ped.obj.position.z;
      const chooseFrom = (pool) => {
        let best = null, bd = Infinity;
        for (const r of pool) {
          if ((load.get(r.id) || 0) >= capHome) continue;
          const cx = (r.minx + r.maxx) / 2, cz = (r.minz + r.maxz) / 2;
          const d = Math.hypot(cx - sx, cz - sz);
          // 同一片区的人按 hash 轻微扰动选楼，避免整条街第一栋被塞满。
          const jitter = d * (0.94 + ((ped.i * 0.6180339) % 1) * 0.12);
          if (jitter < bd) { bd = jitter; best = r; }
        }
        return best;
      };
      // 先在本人的配额片区里选楼；这个片区的楼都住满了才退回全城兜底。
      const zone = zoneList.length
        ? zoneList[(ped.i * 7919 + 3) % zoneList.length] : rects;
      let best = chooseFrom(zone) || chooseFrom(rects);
      if (best) {
        const n = load.get(best.id) || 0; load.set(best.id, n + 1);
        const d = doorNear(best, sx, sz, ped.i);
        p.homeBuilding = best.id;
        p.homeDoor = { id: `residence_${best.id}_${Math.floor(n / 3)}`,
          place: 'home', x: d.x, z: d.z, cap: 3 };
        p.homeScene = `residence_${best.id}`;
        ped.homeXZ = { x: d.x, z: d.z };
        // 【阶段3】用这栋真实建筑的高度派生层数与本人楼层（不是从 id 猜）。
        // best.h 是 building.json 的 height_m；层高与容量口径见 kernel/floors.js。
        // 【第六轮】层数改由 assignFloor 按**住宅层高 2.7 m**（Choi 2002）派生，
        // 同时把层高本身传下去——淹到第几层要按这栋楼真实的层高算。
        // 【修 2026-11-17】优先用真实占地面积；没有时才退回外接矩形，
        // 并在注释里保留「回退会高估容量」的标记，不能当实测报。
        const areaFallback = (best.maxx - best.minx) * (best.maxz - best.minz);
        const areaTrue = Number(best.area_m2);
        const areaUsed = Number.isFinite(areaTrue) && areaTrue > 0 ? areaTrue : areaFallback;
        const fa = assignFloor({ id: best.id, height_m: best.h, function: 'residential',
          area_m2: areaUsed }, n);
        p.homeAreaSource = Number.isFinite(areaTrue) && areaTrue > 0 ? 'real' : 'bbox';
        p.homeFloors = fa.totalFloors;
        p.homeFloorHeightM = fa.floorHeightM;
        p.homeFloor = fa.floor;
        p.homeFloorY = fa.indoor ? fa.elevationM : 0;
        p.homeIndoor = fa.indoor;   // 容量放不下的人判室外，不会被硬塞进楼里
        // 【逐栋首层高 2026-11-20】这栋楼自己的首层高（FEMA 分位数校正值，
        // 缺表时回退全城统一 1.5 ft）。楼层淹没判定必须用它，不能用全城常量。
        p.homeFoundationM = fa.foundationM;
        p.homeFoundationSource = fa.foundationSource;
      } else {
        p.homeBuilding = `street_${ped.i}`;
        p.homeDoor = { id: `residence_${ped.i}`, place: 'home', x: sx, z: sz, cap: 3 };
        p.homeScene = `residence_${ped.i}`;
      }
      p.interiorVisible = false;
      // 【2026-11-21 遗漏方向：工作场所没有楼层】v2 只给住宅跑 assignFloor，
      // 白天在单位的人被当成「无楼层」，incidents 于是拿室外水深判室内死亡，
      // 方向性高估（docs/8工况v2结果 §五 的遗留「工作场所楼层不判」）。
      // 这里按 SOC→place 给上班的人挑一栋**真实建筑**，用该栋自己的
      // function 与高度派生层数（层高见 kernel/floors.js 的 floorHeightFor）。
      // 露天岗位（site/street）不挑楼，维持室外语义。
      if (p.workPlace && !['site', 'street', 'home', null].includes(p.workPlace)) {
        const want = WORK_FN[p.workPlace] || null;
        if (want) {
          const pool = rects.filter((r) => want.test(String(r.fn || '')));
          const pick = pool.length ? pool : rects.filter((r) => /office|commercial|retail/.test(String(r.fn || '')));
          let wbest = null, wd = Infinity;
          for (const r of pick) {
            if ((workLoad.get(r.id) || 0) >= capWork) continue;
            const cx = (r.minx + r.maxx) / 2, cz = (r.minz + r.maxz) / 2;
            const d = Math.hypot(cx - sx, cz - sz);
            const jitter = d * (0.94 + ((ped.i * 0.6180339) % 1) * 0.12);
            if (jitter < wd) { wd = jitter; wbest = r; }
          }
          if (wbest) {
            const n = workLoad.get(wbest.id) || 0; workLoad.set(wbest.id, n + 1);
            const d = doorNear(wbest, sx, sz, ped.i);
            p.workBuilding = wbest.id;
            p.workDoor = { id: `work_${wbest.id}_${Math.floor(n / 3)}`,
              place: p.workPlace, x: d.x, z: d.z, cap: 3 };
            const areaFallbackW = (wbest.maxx - wbest.minx) * (wbest.maxz - wbest.minz);
            const areaTrueW = Number(wbest.area_m2);
            const areaUsedW = Number.isFinite(areaTrueW) && areaTrueW > 0 ? areaTrueW : areaFallbackW;
            const faW = assignFloor({ id: wbest.id, height_m: wbest.h,
              function: String(wbest.fn || 'office'), area_m2: areaUsedW }, n);
            p.workFloors = faW.totalFloors;
            p.workFloorHeightM = faW.floorHeightM;
            p.workFloor = faW.floor;
            p.workFloorY = faW.indoor ? faW.elevationM : 0;
            p.workIndoor = faW.indoor;
            p.workFoundationM = faW.foundationM;
            p.workFoundationSource = faW.foundationSource;
          }
        }
      }

      if (now() < 360 && !p.nightShift) {
        ped.obj.position.x = p.homeDoor.x; ped.obj.position.z = p.homeDoor.z;
      }
    }

    // 【2026-11-22 参照群体改由**发表方法**生成，不再是我们自己定的 120 m / 3 邻居】
    //
    // 旧规则（2026-11-19 版）确实修掉了一个真失真：独居者（ACS 户规模=1，DC 三成）
    // 此前 peersStay 恒 0，被 Borowski 的问卷口径读成「同伴全走光了」，凭空多出撤离压力。
    // 但它把「住得近」当成了「认识」，而且 120 m / 3 人这两个数没有任何文献可引。
    //
    // 现在：Kleinberg 小世界（短程半径 d_sr + q 条幂律长程边）+ 三类真实接触，
    // 见 kernel/peer-network.js 文件头的出处（Kuhlman 2020 AAMAS §2.2/Table 1、
    // Borowski 2023 QA9 的「至多 5 人」上限、ACS 户结构、SOC→场所的工作边）。
    // 规模上限 5 人是问卷设计上限，不是我们挑的；d_sr 与 q 是区间内取值，已在
    // 敏感性里扫（60/120/240 m × q=0/1/2）。
    {
      const { peers, stats } = buildPeerNetwork(persons, { seed: 20261122 });
      for (let i = 0; i < persons.length; i++) {
        if (Array.isArray(peers[i])) persons[i].peers = peers[i];
      }
      PEER_STATS = stats;   // 只给诊断/测试读，不进任何决策
    }

    // ---- 岗位 / 常去餐馆 / 街头锚点：全城网格索引，O(n) 而不是 O(n²)
    // 旧版只有 42 个固定门牌，实测 work_school_0 挂了 48 人；非 office 职业
    // 还全被摆进同一个剧情房间锚点（10:00 一格 62 人）。现在每个人的
    // 岗位、餐馆、室外工作点都是「离家 180~600 m 的一栋真实建筑」，并带
    // 容量上限 + 确定性分散，3000 人也不会故意扎堆。
    const CELL = 180;
    const hkey = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
    const hb = new Map();
    for (const q of persons) {
      if (!q || !q.homeDoor) continue;
      const k = hkey(q.homeDoor.x, q.homeDoor.z);
      let a = hb.get(k); if (!a) hb.set(k, a = []);
      a.push(q);
    }
    const hash = (i) => ((i * 2654435761) >>> 0) / 4294967296;
    for (const ped of peds) {
      const p = persons[ped.i];
      if (!p || CAST[ped.i]) continue;      // 具名角色保留真实剧情场景
      const hx = p.homeDoor.x, hz = p.homeDoor.z;
      const c0x = Math.floor(hx / CELL), c0z = Math.floor(hz / CELL);
      let pool = [];
      for (let ring = 1; ring <= 5 && pool.length < 12; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const a = hb.get((c0x + dx) + ',' + (c0z + dz));
            if (!a) continue;
            for (const q of a) {
              if (q === p || !q.homeBuilding) continue;
              const d = Math.hypot(q.homeDoor.x - hx, q.homeDoor.z - hz);
              if (d < 180) continue;
              if ((workLoad.get(q.homeBuilding) || 0) >= capWork) continue;
              pool.push([d, q]);
            }
          }
        }
      }
      pool.sort((a, b) => a[0] - b[0]);
      const near = pool.slice(0, Math.min(14, pool.length));
      const donorQ = near.length ? near[Math.floor(hash(ped.i) * near.length)][1]
        : persons[(ped.i + 1) % persons.length];
      const key = donorQ.homeBuilding || donorQ.i;
      workLoad.set(key, (workLoad.get(key) || 0) + 1);
      const local = { ...donorQ.homeDoor, cap: capWork };
      p.mealDoor = { ...local, id: `meal_${key}`, place: 'street' };
      p.streetDoor = { ...local, id: `street_${key}`, place: 'street' };
      // 【2026-11-21】已经在上面挑到真实办公楼的人（p.workBuilding 已设）不再
      // 被池化门牌覆盖 —— 覆盖会让刚写好的 workFloors/workFloorY 与门牌对不上，
      // 楼层保护又退回「无楼层」。只有露天岗位或没挑到楼的人走池化门牌。
      if (!p.workBuilding) {
        p.workDoor = { ...local, id: `work_${p.status}_${key}`, place: p.workPlace };
      }
      // 虚拟岗位场景 = 不进任何剧情楼的 3D 房间锚点；室内人按自己的门牌散开。
      p.workScene = `work_${key}`;
      p.outdoorScene = `outdoor_${key}`;
      p.workInteriorVisible = false;
    }
  }

  function setAnchors(mapOrGroup) {
    if (!mapOrGroup) return;
    if (mapOrGroup.children) {
      const m = {};
      for (const o of mapOrGroup.children) {
        if (o && o.name && o.position) m[o.name] = { x: o.position.x, y: o.position.y, z: o.position.z };
      }
      anchors = m;
    } else anchors = { ...mapOrGroup };
  }

  /** 场景锚点内按 golden angle 散开；一个门牌最多 8 人，半径不到 4 m，不重叠。 */
  function spotOf(sceneId, p, placeKey, outdoor = false) {
    const a = anchors[sceneId];
    const idx = p.placeIdx;
    // 【阶段3】内核只给「相对地面的楼层高度」floorRelY（0.3 / 3.6 / 6.9… m），
    // 不碰绝对高程。显示层（ped.js）摆位时再叠加真实地形高程，保持内核/显示边界。
    // 建筑容量放不下的人 homeIndoor=false，走室外门口逻辑，不会被硬塞楼里。
    // 【2026-11-21】工作场所也有真实楼层了（办公楼 3.8 m 层高，Choi 2002 /
    // Jedwab 2022 JUE 132:103507 外推到 DC 2–4 层是限制）。露天岗位仍无楼层。
    const homeFloorOn = !outdoor && placeKey === 'home' && p.homeIndoor === true
      && Number.isFinite(p.homeFloorY);
    const workFloorOn = !outdoor && placeKey === 'work' && p.workIndoor === true
      && Number.isFinite(p.workFloorY);
    const floorRelY = homeFloorOn ? p.homeFloorY : (workFloorOn ? p.workFloorY : null);
    const floorNum = (placeKey === 'home') ? (p.homeFloor || 0)
      : (placeKey === 'work' ? (p.workFloor || 0) : 0);
    if (a) {
      const ang = (idx * 2.399963 + p.i * 0.137) % (Math.PI * 2);
      const r = outdoor ? 5 + idx * 1.8 : 0.8 + idx * 0.42;
      return { x: a.x + Math.cos(ang) * r, y: a.y,
        z: a.z + Math.sin(ang) * r, floor: floorNum, floorRelY };
    }
    const door = outdoor ? p.streetDoor : (placeKey === 'home' ? p.homeDoor : p.workDoor);
    const ang = (idx * 2.399963) % (Math.PI * 2);
    const r = 1 + idx * 0.55;
    return { x: door.x + Math.cos(ang) * r, y: 0,
      z: door.z + Math.sin(ang) * r, floor: floorNum, floorRelY };
  }

  const now = () => Number(minute()) || 0;

  /** 第 i 个人此刻的完整状态（与具名角色 HUD 同构，但不进任何面板）。 */
  function at(i, m) {
    const p = persons[i];
    if (!p) return null;
    const dm = ((m === undefined ? now() : Number(m)) % 1440 + 1440) % 1440;
    // 暴雨是全局事件，不能因作息相位错开；其余时段按个人相位错峰。
    const globalStorm = dm >= 1072 && dm < 1140;
    const dmEff = globalStorm ? dm : (dm + p.phase + 1440) % 1440;
    const seg = daySegment(dmEff);
    const s = SEG[seg.id] || SEG.am;
    const c = p.citizen;
    const ph = p.phys;
    const hungry = ph.hunger > 58, wet = ph.wetness > 0.45;

    let where = s.where, indoor = !!s.indoor, clip = s.clip;
    if (seg.id === 'night' && p.nightShift) { where = 'corner'; indoor = false; clip = 'walk'; }
    else if ((seg.id === 'am' || seg.id === 'pm') && p.nightShift) {
      where = 'home'; indoor = true; clip = 'sit';
    } else if ((seg.id === 'am' || seg.id === 'pm' || seg.id === 'lunch' || seg.id === 'preRain')
      && p.outdoor) { where = 'work'; indoor = false; clip = 'walk'; }
    if (indoor && clip !== 'sit') clip = 'sit';
    if (!indoor && clip === 'sit') clip = 'walk';

    const place = where === 'home' ? 'home'
      : (where === 'work' ? p.workPlace : 'street');
    const sceneId = where === 'home' ? p.homeScene
      : where === 'work' ? (indoor ? p.workScene : p.outdoorScene)
        : where === 'shelter' ? 'sc_street_shelter'
          : where === 'corner' ? 'sc_street_corner' : p.streetScene;
    const pos = spotOf(sceneId, p, place, !indoor);
    const dest = where === 'home' ? p.homeDoor : (where === 'work' ? p.workDoor : p.streetDoor);

    // 心理状态：年龄放大应激，经验压住应激；淋湿 / 饥饿 / 被困继续叠加。
    let stress = s.stress * c.stressGain * (1.22 - 0.46 * c.experience)
      + (hungry ? 0.08 : 0) + (wet ? 0.12 : 0)
      + Math.min(0.18, ph.trappedMin * 0.01);
    let mood = s.mood;
    if (hungry && stress < 0.3) mood = '有点饿';
    if (wet && stress < 0.5) mood = '淋透了';
    if (stress > 0.55) mood = c.ageGroup === 'child' ? '害怕' : '焦虑';
    if (!wet && stress > 0.42 && c.veteran) mood = '镇定但警觉';
    stress = clamp(stress, 0, 1);

    // 步速：年龄 + 经验 + 体力 + 淋湿。绝对值 m/s，ped.js 直接采用。
    const staminaFrac = clamp((ph.stamina ?? 80) / 100, 0.25, 1);
    const weather = (wet ? 0.82 : 1) * (s.factor > 0 && globalStorm ? 0.9 : 1);
    const speedAbs = indoor ? 0 : +(c.speedAbs * (0.72 + 0.28 * staminaFrac)
      * weather * (0.55 + 0.45 * (s.factor || 1))).toFixed(3);

    const stormNow = seg.id === 'crisis' || seg.id === 'postRain';
    const out = {
      key: p.key, i, name: p.name, role: p.role, profileKey: p.profileKey,
      minute: dm, minuteEff: dmEff, segment: seg.id, label: seg.label,
      activity: s.act, where, place, sceneId,
      streetSceneId: p.streetScene,   // 实时目标接管时用它换回真实的街段场景
      interiorVisible: where === 'work' ? p.workInteriorVisible : p.interiorVisible,
      homeBuilding: p.homeBuilding,
      // 【阶段3】这栋楼的真实总层数（由建筑高度派生），供楼层淹没判定用。
      // 【2026-11-21】楼层三件套按人此刻所在的那栋楼取：在家取住宅楼、
      // 在单位取那栋办公楼；露天/路上为 0（incidents 据此走地面暴露）。
      totalFloors: (where === 'work' ? (p.workFloors || 0) : (p.homeFloors || 0)),
      floorHeightM: (where === 'work' ? (p.workFloorHeightM || 0) : (p.homeFloorHeightM || 0)),
      // 【逐栋首层高 2026-11-20】这栋楼的首层高（FEMA 分位数校正值）。
      // 楼层淹没判定按它算，不能用全城统一的 0.457。
      foundationM: (where === 'work' ? (p.workFoundationM || 0) : (p.homeFoundationM || 0)),
      x: pos.x, y: pos.y, z: pos.z,
      dest: { id: dest.id, x: dest.x, z: dest.z, cap: dest.cap || DEST_CAP },
      doors: {
        home: p.homeDoor, work: p.workDoor,
        meal: p.mealDoor || p.streetDoor, street: p.streetDoor,
      },
      spots: {
        home: spotOf(p.homeScene, p, 'home', false),
        work: spotOf(p.workScene, p, p.workPlace, false),
      },
      doorLoad: p.placeIdx + 1, placeIdx: p.placeIdx,
      enterRadius: ENTER_RADIUS, enterDist: ENTER_DIST,
      indoor, clip,
      speedAbs, speedFactor: indoor ? 0 : clamp(speedAbs / WALK.BASE, 0.15, 1.6),
      mood, stress, thinking: c.thinking,
      ageGroup: c.ageGroup, ageBand: p.ageBand, ageBandLabel: p.ageBandLabel,
      status: p.status, age: c.age, experience: c.experience,
      veteran: c.veteran, rookie: c.rookie, citizen: c,
      hazard: p.hazard || c.hazard || null,
      lazy: c.profile.patience > 0.6,
      wade: c.profile.wadeLimit, hasUmbrella: p.hasUmbrella,
      // 决策错峰：每帧最多 count/25 人日常决策，暴雨窗口每 3 分钟一批。
      wantDecision: stormNow ? (Math.floor(dm) % 3 === i % 3)
        : (Math.floor(dm) % DAY_THINK_STEP === p.thinkSlot),
      decisions: p.brain.decisions.slice(-2),
      phys: ph.snapshot(),
    };
    // 【实时目标接管 2026-11-11】还在赶目标的人必须在街上走。
    // 覆盖必须在 at() 内部做：验收脚本、HUD、行人层读的是同一份状态，
    // 否则会出现「社会层说在室内、行人层却在走」的室内走跑。
    if (liveOverride) liveOverride(i, dm, out);
    return out;
  }

  /** 真的用 Brain 感知 + 效用打分，并为**每个候选**算出一条真实 walknet 折线。
   *  选中的那条随 record.route 交给 ped.js 逐帧执行 —— 决策不再是意淫。 */
  function decide(i, m, pos) {
    const p = persons[i];
    if (!p) return null;
    const dm = Number(m) || now();
    if (dm - p.lastDecide < 3) return null;
    p.lastDecide = dm;
    p.brain.perceive({ x: pos.x, y: pos.y || 0, z: pos.z }, dm);
    const q = at(i, dm);
    // 【2026-11-12】q.segment 现在由实时目标层写成 live_*，不能再拿它判断
    // 暴雨；全局暴雨窗口按仿真分钟判定，否则旧 Brain 在暴雨里仍只会产出
    // 日常候选，高地逃生目标消失。
    const storm = (dm >= 1072 && dm < 1140)
      || !!q && (q.segment === 'crisis' || q.segment === 'postRain');
    const cands = candidatesFor(q || {}, pos, storm);

    const ctx = {
      exp: p.citizen.experience, wade: q ? q.wade : p.citizen.profile.wadeLimit,
      speed: q ? q.speedAbs : p.citizen.speedAbs, minute: dm,
      dest: q ? q.dest : null, doors: ALL_DOORS,
      leaderPos: findLeader(i, pos), maxDest: 240,
    };
    // 同一个目标在一次决策里只规划一次（多个候选可能指向同一个门牌）。
    const cache = new Map();
    for (const c of cands) {
      if (!planner) break;
      const kind = c.goal || 'steady';
      const key = `${kind}|${kind === 'follow' ? (ctx.leaderPos ? ctx.leaderPos.i : -1) : ''}`;
      let R = cache.get(key);
      if (!R) { R = planner.plan(kind, pos, ctx); cache.set(key, R); }
      c.route = R;
      c.goalKind = kind;
      if (R && R.pts && R.pts.length > 1) {
        // Brain.estimateRoute 吃的就是这条真实折线：路径上的水深、已知/未知
        // 全部来自这个人刚刚 perceive() 到的世界，而不是凭空画的几个点。
        c.path = R.pts.map(([x, z]) => ({ p: { x, z } }));
        c.distance = R.dist;
        c.speed = R.speed || c.speed;
        c.lookAhead = p.citizen.profile.sightM;
      } else {
        c.path = [];
        c.distance = 0;
      }
    }
    const out = p.brain.decide({
      candidates: cands, from: pos, tMin: dm,
      situation: storm ? '暴雨里怎么走' : ((q && (q.activity || q.label)) || '接下来做什么'),
    });
    const rec = out.record;
    const chosen = out.chosen;
    // 执行信息随记录一起走：ped.js 拿它启动 mode='route'。
    rec.route = chosen && chosen.route ? chosen.route : null;
    rec.goalKind = chosen ? (chosen.goal || 'steady') : null;
    if (rec.route && rec.route.goal) rec.goalId = rec.route.goal.id;
    return rec;
  }

  /** ped.js 装配完真实路网后回填寻路器 + 全员实时坐标。 */
  function setRouting(pl, positions) {
    planner = pl || null;
    posSource = typeof positions === 'function' ? positions : null;
  }

  /** 实时目标层注入：at() 返回前调用，统一覆盖「这个人此刻在街上还是屋里」。 */
  function setLiveOverride(fn) { liveOverride = typeof fn === 'function' ? fn : null; }

  function tick(i, m, env) {
    const p = persons[i];
    if (p) p.phys.tick(Number(m) || now(), env);
  }

  function stats() {
    const byJob = {}, byAge = {}, byBand = {}, byStatus = {};
    let expSum = 0, veteran = 0, rookie = 0, umbrellaOwn = 0;
    const doorLoad = {};
    const homeBuildings = new Set();
    for (const p of persons) {
      byJob[p.role] = (byJob[p.role] || 0) + 1;
      byAge[p.citizen.ageGroup] = (byAge[p.citizen.ageGroup] || 0) + 1;
      byBand[p.ageBand] = (byBand[p.ageBand] || 0) + 1;
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      if (p.hasUmbrella) umbrellaOwn++;
      expSum += p.citizen.experience;
      if (p.citizen.veteran) veteran++;
      if (p.citizen.rookie) rookie++;
      doorLoad[p.homeDoor.id] = (doorLoad[p.homeDoor.id] || 0) + 1;
      if (p.homeBuilding) homeBuildings.add(p.homeBuilding);
    }
    const loads = Object.values(doorLoad);
    return {
      count: persons.length, byJob, byAge, byBand, byStatus, umbrellaOwn,
      ageLabels: Object.fromEntries(Object.entries(AGE_GROUPS).map(([k, v]) => [k, v.label])),
      bandLabels: Object.fromEntries(AGE_BANDS.map((B) => [B.id, B.label])),
      roleCount: ROLES.length,
      expAvg: +(expSum / Math.max(1, persons.length)).toFixed(3), veteran, rookie,
      hazard: summarizeHazard(persons),
      doors: homeBuildings.size || DOORS.home.length, destCap: DEST_CAP,
      homeBuildings: homeBuildings.size,
      maxDoorLoad: loads.length ? Math.max(...loads) : 0,
      anchors: Object.keys(anchors).length,
      decisions: persons.reduce((n, p) => n + p.brain.decisions.length, 0),
    };
  }

  function debug(m) {
    return persons.map((p) => {
      const q = at(p.i, m);
      const last = p.brain.decisions[p.brain.decisions.length - 1];
      return {
        i: p.i, name: q.name, role: q.role, seg: q.segment,
        place: q.place, scene: q.sceneId, indoor: q.indoor, clip: q.clip,
        age: q.age, ageGroup: q.ageGroup, experience: q.experience,
        hazard: q.hazard ? { score: q.hazard.score, tier: q.hazard.tier,
          runs: q.hazard.runs, trained: q.hazard.trained, label: q.hazard.label } : null,
        speedAbs: q.speedAbs, thinking: q.thinking,
        mood: q.mood, stress: +q.stress.toFixed(3),
        door: q.dest.id, placeIdx: q.placeIdx,
        decision: last ? last.chosen : null,
        decisionN: p.brain.decisions.length,
        sightM: q.citizen.profile.sightM,
        noise: q.citizen.profile.noise,
      };
    });
  }

  return { persons, at, decide, tick, setAnchors, setClusters, setRouting, bindResidents,
    setLiveOverride, stats, debug, now, DOORS };
}
