import * as THREE from 'three';
import { PersonStory } from './person-story.js';
import { Brain } from './decision.js';
import { PersonState, UMBRELLA } from './person-state.js';
import { OFFICE } from './office-building.js';
import { CAFE, CLINIC, SCHOOL, SITE } from './district-buildings.js';
import { STORY_OFFSET } from './clock.js';

export const STATE_CN = {
  working: '在手头的事情上', notice: '注意到预警', window: '在窗边看雨', calling: '打电话',
  handover: '交接工作', packing: '收拾东西', preparing: '准备离开', indoor: '在楼梯间',
  outdoor: '在室外', boarding: '上车', driving: '开车', carblocked: '被淹水挡住', parking: '停车',
  observing: '停下观察', escape: '撤离', blocked: '被深水挡住', detour: '绕行', wading: '涉水',
  arrive: '抵达', elevator: '乘电梯', home: '到家', safe: '安全', sheltered: '就地避险',
  operating: '在做手术', informed: '得知外面在淹水', continuing: '继续手术', power: '停电切备用电源',
  closing: '收尾缝合', instructing: '让团队先走', returning: '退回楼上', radio: '听到工头喊话',
  climbing: '从基坑撤出', texting: '收到老板短信', locking: '锁门', walking: '走回家',
  riding: '骑车送单', sheltering: '跑进楼里', class: '在上课', lining: '排队清点',
  evacuating: '跟着队伍上楼',
  waiting: '等待家长', idle: '在等单',
};

/**
 * 从旧多人 demo 原样抽出来的 6 条故事线（老板 / 医生 / 工人 / 店员 / 骑手 / 女孩）。
 * 代码不手抄，避免改错脚本；唯一改动是把依赖改成由 ctx 注入，好让主场景
 * 用自己建的精细楼和城市时钟的 depthAt 来跑。
 */
export function buildCast(ctx) {
  const {
    office, clinic, school, cafe, site, districtRoutes,
    depthAt, groundAt, STATE_CN, PROFILES, clockMinute,
  } = ctx;
  const START_MIN = 52;
  const stories = {};
  /* ---- 老板：六层玻璃办公室 → 一层大堂 → 退回三层 ---- */
  const ir = office.indoorRoute;
  const iCorridor = Math.max(0, ir.findIndex((w) => w.label === '进入6F走廊'));
  const iLobby = ir.findIndex((w) => w.floor === 1);
  const y6 = OFFICE.baseY + 5 * OFFICE.floorH;
  const y3 = OFFICE.baseY + 2 * OFFICE.floorH;
  const bossDown = [
    { p: [OFFICE.cx - 58.0, y6, OFFICE.cz - 10.2], kind: 'walk', floor: 6, label: '办公室' },
    { p: [OFFICE.cx - 55.6, y6, OFFICE.cz - 9.8], kind: 'walk', floor: 6, label: '走出玻璃门' },
    { p: [OFFICE.cx - 55.6, y6, OFFICE.cz], kind: 'walk', floor: 6, label: '进入6F走廊' },
    { p: [OFFICE.cx - 44.0, y6, OFFICE.cz], kind: 'walk', floor: 6, label: '沿走廊向东' },
    ...ir.slice(iCorridor, iLobby + 4).map((w) => ({
      p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label,
    })),
  ];
  const bossBackCore = ir.slice(iCorridor, iLobby + 4).reverse();
  let cut3 = bossBackCore.length - 1;
  for (let i = 0; i < bossBackCore.length; i += 1) {
    if (bossBackCore[i].floor <= 3) { cut3 = i; break; }
  }
  const bossBack = [
    ...bossBackCore.slice(0, cut3 + 1).map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label })),
    { p: [OFFICE.cx - 22.0, y3, OFFICE.cz], kind: 'walk', floor: 3, label: '三层走廊' },
    { p: [OFFICE.cx - 22.0, y3, OFFICE.cz + 7.5], kind: 'walk', floor: 3, label: '三层会议室' },
  ];

  const boss = new PersonStory({
    id: 'BOSS-001', name: '罗伯特·惠特克', age: 58, occupation: '公司合伙人',
    tag: '最后离开', intro: '季度会议刚散，手机静音；他要等团队走完才肯走。',
    start: new THREE.Vector3(OFFICE.cx - 58.0, y6, OFFICE.cz - 10.2),
    floor: 6, heading: 0, baseY: OFFICE.baseY, floorH: OFFICE.floorH,
    routes: { bossDown, bossBack },
    depthAt, states: STATE_CN,
    script: [
      { at: 52.3, state: 'working', reason: '季度会议刚散，他在整理明天要交的材料', hold: 1.4 },
      {
        at: 53.8, state: 'calling', hold: 1.3,
        info: ['秘书电话', '大楼物业通知：地下车库开始进水，建议尽快离开'],
        reason: '他的手机在会议里一直静音，这是今天第一条预警',
        event: ['information', '比马克晚 4 分钟知道', '他的手机静音；同一栋楼里，信息到达时间也不一样'],
      },
      {
        at: 55.3, state: 'instructing', hold: 1.5,
        reason: '他让还在加班的五个人立刻走，自己留下收尾',
        event: ['decision', '让团队先走', '五名员工先下楼；他回办公室取硬盘和纸质合同'],
      },
      { at: 57.1, state: 'packing', hold: 1.1, reason: '保险柜里有客户资料，他不想把这些留在这里' },
      { at: 58.5, state: 'indoor', path: 'bossDown', speed: 'walk', reason: '电梯停了，他从六层走楼梯下去' },
      {
        at: 0, state: 'observing', hold: 2.0,
        reason: '一层大堂门口的水已经漫进来，踩下去到脚踝',
        event: ['observation', '一层大堂进水', '门口约 0.1 m，外面街上更深；他没有雨具，车在地下车库'],
      },
      { at: 0, state: 'returning', path: 'bossBack', speed: 'walk', reason: '他判断硬走出去更危险，退回楼上等救援' },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '退到三层会议室，和物业一起等消防上来' },
    ],
  });

  /* ---- 医生：二层手术室 ---- */
  const clinicDoorIdx = Math.max(0, clinic.route.findIndex((w) => w.label === '走到门口看水情'));
  const clinicDown = clinic.route.slice(0, clinicDoorIdx + 1).map((w) => ({
    p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label,
  }));
  const clinicBack = clinic.route.slice(clinicDoorIdx + 1).map((w) => ({
    p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label,
  }));

  const doctor = new PersonStory({
    id: 'DOCTOR-001', name: '大卫·帕特尔', age: 41, occupation: '外科医生',
    tag: '手术进行中', intro: '一台急性阑尾切除正在做，病人已经开腹。',
    start: clinic.start.clone(), floor: 2, heading: 0,
    baseY: CLINIC.baseY, floorH: CLINIC.floorH,
    routes: { clinicDown, clinicBack }, depthAt, states: STATE_CN,
    script: [
      { at: 52.2, state: 'operating', reason: '一台急性阑尾切除正在进行，病人已经开腹', hold: 1.9 },
      {
        at: 54.1, state: 'informed', hold: 1.2,
        info: ['医院广播', '暴雨红色预警：一楼大厅开始进水，非必要人员不要外出'],
        reason: '护士在手术室门口转达，他手上的动作没有停',
      },
      {
        at: 55.4, state: 'continuing', hold: 2.4,
        reason: '手术做到一半，转运病人的风险比继续做完更高；他决定不中断',
        event: ['decision', '决定不中断手术', '他让护士把一楼的文件和药品搬到二楼，自己继续'],
      },
      {
        at: 61.0, state: 'power', hold: 1.6,
        info: ['护士报告', '市电中断，备用电源只够照明和监护仪，电梯停运'],
        reason: '无影灯闪了一下，他让护士用手电补光',
      },
      { at: 63.0, state: 'closing', hold: 1.6, reason: '手术完成，开始缝合' },
      { at: 64.8, state: 'indoor', path: 'clinicDown', speed: 'walk', reason: '他想亲眼看一眼楼下的水，判断要不要把病人往楼上转' },
      {
        at: 0, state: 'observing', hold: 2.2,
        reason: '一层门口的水已经进到分诊台，外面街道更深',
        event: ['observation', '一层进水', '门口约 0.15 m；他判断二层暂时安全，决定不动病人'],
      },
      { at: 0, state: 'returning', path: 'clinicBack', speed: 'walk', reason: '病人还在二层恢复区，他必须回去' },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '留在二层恢复区守着病人，等救援队上来' },
    ],
  });

  /* ---- 钢筋工：工地围护区 ---- */
  const worker = new PersonStory({
    id: 'WORKER-001', name: '路易斯·拉米雷斯', age: 45, occupation: '钢筋工',
    tag: '最早知道', intro: '三层底板钢筋今天必须绑完，泵已经停了。',
    start: site.start.clone(), floor: 1, heading: 0,
    baseY: SITE.baseY, floorH: 4,
    routes: { siteOut: site.route.map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label })) },
    // 基坑是模型 6 m 网格之外的低点：这一处用局部汇水，水面按时间上升
    // 【时间基准】clockMinute() 是「一天分钟」（1020 = 17:00），不是故事相对分钟。
    // 旧版写 (clockMinute() - 53)/14，白天任何时刻算出来都 >1，被 clamp 到 1，
    // 于是基坑从 17:00 第一秒就是满的 1.11 m —— 钢筋工永远不会「看着水涨上来」。
    depthAt: (x, z, t) => {
      const inside = Math.abs(x - SITE.cx) < SITE.width / 2 && Math.abs(z - SITE.cz) < SITE.depth / 2;
      if (inside) {
        const sm = (t === undefined || t === null)
          ? (clockMinute() - STORY_OFFSET) : t;         // 统一成故事相对分钟
        const k = Math.max(0, Math.min(1, (sm - 53) / 14));
        return 0.06 + k * 1.05;
      }
      return depthAt(x, z, t);
    },
    states: STATE_CN,
    script: [
      { at: 52.0, state: 'working', reason: '三层底板钢筋今天必须绑完，雨已经下了一阵', hold: 1.3 },
      {
        at: 53.3, state: 'radio', hold: 0.9,
        info: ['工头对讲机', '所有人立刻撤出基坑：泵停了，水开始往里灌'],
        reason: '他比气象预警更早从工头那里知道',
        event: ['information', '最早收到撤离指令', '灾害现场的第一个信使往往是班组长，不是手机推送'],
      },
      { at: 54.3, state: 'packing', hold: 1.2, reason: '把电动工具收进箱子，不能泡水' },
      { at: 55.6, state: 'climbing', path: 'siteOut', speed: 'walk', reason: '沿坡道走出围护区，坑底已经开始积水' },
      {
        at: 0, state: 'calling', hold: 1.9,
        reason: '给妻子打电话报平安',
        info: ['家人电话', '妻子在城北，家里没停电，让他别骑车回家'],
        event: ['observation', '基坑积水', '围护区内的水十几分钟就涨到膝盖，泵停了排不出去'],
      },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '进集装箱办公室避雨，等工地统一撤离' },
    ],
  });

  /* ---- 咖啡店员 ---- */
  const cafeIn = cafe.route.map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label }));
  const woman = new PersonStory({
    id: 'WOMAN-001', name: '艾米·陈', age: 29, occupation: 'Pavilion 咖啡馆店员',
    tag: '最早知道', intro: '下午的客人走光了，她在收吧台。',
    start: cafe.start.clone(), floor: 1, heading: 0,
    baseY: CAFE.baseY, floorH: CAFE.floorH,
    routes: { cafeIn, cafe_to_market: districtRoutes.cafe_to_market },
    depthAt, states: STATE_CN, walk: 1.4, run: 2.6,
    script: [
      { at: 52.0, state: 'working', reason: '下午的客人走光了，她在收吧台', hold: 1.3 },
      {
        at: 53.5, state: 'texting', hold: 1.0,
        info: ['老板短信', '雨太大，提前关店，别走地下通道'],
        reason: '她是最早收到消息的人之一',
        event: ['information', '最早收到预警', '老板直接发短信；她比马克早 20 秒，比老板本人早 20 分钟'],
      },
      { at: 54.7, state: 'closing', path: 'cafeIn', speed: 'walk', reason: '关咖啡机、清收银、把后门插上' },
      { at: 0, state: 'locking', hold: 1.1, reason: '锁前门' },
      { at: 0, state: 'walking', path: 'cafe_to_market', speed: 'run', reason: '家在北边 400 米，她走熟悉的路' },
      {
        at: 0, state: 'home', finish: true, outcome: 'safe',
        summary: '到家。她这条路线上没有积水——同样的雨，暴露完全不同',
      },
    ],
  });

  /* ---- 外卖骑手 ---- */
  const rider = new PersonStory({
    id: 'RIDER-001', name: '泰瑞尔·杰克逊', age: 24, occupation: '外卖骑手',
    tag: '几乎收不到预警', intro: '耳机里放着音乐，手机导航静音。',
    // 【起点必须在楼外】旧版 CAFE.cx+4.6 / cz+16.0 落在咖啡馆 bbox
    // (x 2266.9~2279.8, z -121.3~-83.3) 里 —— 一个「在街边等单」的骑手
    // 被生成在屋子内部。挪到东侧门外 4 m 的人行道上，且避开楼体。
    start: new THREE.Vector3(CAFE.cx + CAFE.width / 2 + 4.0, CAFE.baseY, CAFE.cz + 13.0),
    floor: 1, heading: Math.PI,
    baseY: CAFE.baseY, floorH: CAFE.floorH,
    routes: {
      rider_ride: districtRoutes.rider_ride,
      rider_shelter: districtRoutes.rider_shelter,
    },
    depthAt, states: STATE_CN, ride: 6.4,
    script: [
      { at: 52.0, state: 'idle', reason: '耳机里放着音乐，手机导航静音；系统还没派单', hold: 6.3 },
      {
        at: 58.4, state: 'notice', hold: 1.3,
        info: ['自己看到', '街对面的人开始往高处跑，有人推着自行车'],
        reason: '他摘下一只耳机，才发觉雨已经大到听不清导航',
        event: ['information', '最后知道的一批人', '没有收到任何官方预警；信息来自看见别人跑'],
      },
      {
        at: 59.9, state: 'riding', path: 'rider_ride', speed: 'ride',
        alt: 'rider_shelter', blockHold: 1.6,
        reason: '这单在南边，他想着冲过去还能赶上',
        blockNote: '他把电动车停在路边，水已经过膝，不敢再往前',
      },
      {
        at: 0, state: 'blocked', hold: 1.4, alt: 'rider_shelter',
        altTitle: '弃车，绕回办公楼',
        altReason: '他把车锁在路牌上，沿着水的边缘往北绕，去办公楼一层',
        reason: '前面的路口已经是一片水，看不到路缘',
      },
      {
        at: 0, state: 'sheltering', path: 'rider_shelter', speed: 'run',
        tail: [[2544.4, 7.19, 372.0, '走上办公楼台阶'], [2538.0, 7.19, 366.0, '进入大堂'], [2522.0, 7.19, 358.0, '在大堂避雨']],
        reason: '办公楼一层大堂开着门，里面已经站了几个躲雨的人',
      },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '把车丢在路边，在办公楼大堂等雨停' },
    ],
  });

  /* ---- 小女孩 ---- */
  const schoolUp = school.route.map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label }));
  const girl = new PersonStory({
    id: 'GIRL-001', name: '索菲亚·马丁内斯', age: 9, occupation: '小学三年级',
    tag: '没有手机', intro: '最后一节课，窗外雨很大，老师还在讲生词。',
    start: school.start.clone(), floor: 3, heading: 0,
    baseY: SCHOOL.baseY, floorH: SCHOOL.floorH,
    routes: { schoolUp }, depthAt, walk: 1.1,
    states: { ...STATE_CN, climbing: '跟着队伍上楼' },
    script: [
      { at: 52.0, state: 'class', reason: '最后一节课，窗外雨很大，老师还在讲生词', hold: 2.1 },
      {
        at: 54.1, state: 'notice', hold: 1.1,
        info: ['班主任', '全校往四层以上转移，一楼二楼不要留人'],
        reason: '她没有手机，所有信息都来自老师',
        event: ['information', '信息来自老师', '9 岁的孩子没有自己的手机，也没有判断天气的能力'],
      },
      {
        at: 55.4, state: 'lining', hold: 2.0,
        reason: '老师让全班在走廊排队，两个人一排',
        event: ['state', '全班排队', '26 名学生，老师清点两遍才出发'],
      },
      { at: 57.6, state: 'evacuating', path: 'schoolUp', speed: 'stair', reason: '跟着队伍从三层走到五层音乐教室' },
      {
        at: 0, state: 'calling', hold: 2.1,
        reason: '借老师的手机给妈妈打电话',
        info: ['妈妈电话', '妈妈被堵在高架上，一时来不了，让她听老师的话'],
      },
      { at: 0, state: 'waiting', finish: true, outcome: 'sheltered', summary: '和全班留在五层音乐教室，等家长来接' },
    ],
  });

  // ---- 给 6 个人装上同一套 Brain，但用各自的心理档案 ----
  // PersonStory 构造时默认用 mark 档案；这里按 key 换成本人权重，
  // 并重建 Brain（seed 各不相同，保证同一场雨里六个人判断不一样、可复现）。
  // 【速度按人设】旧版六个人一个速度（run 2.9 m/s，等于快走），跑起来完全不像逃命。
  const SPEED = {
    boss: { walk: 1.26, run: 3.9 },     // 58 岁 + 西装皮鞋，跑不快
    doctor: { walk: 1.42, run: 4.7 },
    worker: { walk: 1.30, run: 4.9 },   // 常年体力活，冲刺最快
    woman: { walk: 1.36, run: 4.5 },
    rider: { walk: 1.46, run: 5.1 },    // 年轻、天天骑行
    girl: { walk: 1.14, run: 3.9 },     // 十岁，步幅只有大人一半
  };
  const HUNGER0 = { boss: 38, doctor: 20, worker: 46, woman: 24, rider: 52, girl: 30 };
  for (const [i, [key, st]] of [['boss', boss], ['doctor', doctor], ['worker', worker],
    ['woman', woman], ['rider', rider], ['girl', girl]].entries()) {
    st.tMin = START_MIN;
    st.key = key;
    st.profile = (PROFILES && PROFILES[key]) || st.profile;
    const sp = SPEED[key] || {};
    if (sp.walk) st.walk = sp.walk;
    if (sp.run) st.run = sp.run;
    // 生理状态：谁备伞、初始饥饿、降雨判定
    st.hasUmbrella = !!UMBRELLA[key];
    st.hunger0 = HUNGER0[key] ?? 18;
    st.phys = new PersonState({
      key, profile: st.profile, hasUmbrella: st.hasUmbrella, hunger: st.hunger0,
    });
    if (clockMinute) {
      // 降雨窗口从城市时钟读（统一口径：17:00–19:00）
      st.raining = () => {
        const m = clockMinute();
        return m >= 1020 && m < 1140;
      };
    }
    st.brain = new Brain({
      profile: st.profile,
      depthAt: (x, z, t) => st.depthAt(x, z, t),
      seed: 900 + i * 173,
    });
    st.wadeLimit = st.profile.wadeLimit;
    if (groundAt) st.groundAt = groundAt;
    stories[key] = st;
  }

  return stories;
}
