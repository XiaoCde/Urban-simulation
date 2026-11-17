/**
 * story-engine.js —— 把《全天故事-24h》接到城市时钟上。
 *
 * `docs/全天故事-24h.md` 是给人读的剧本，`assets/story/day_full.json` 是同一份
 * 故事的结构化数据（7 人 × 22 段轨迹、28 个生活场景、21 个幕点）。这一层只做
 * 一件事：**给定时钟分钟，返回「此刻全员在干嘛」**，供 HUD 和场景层消费。
 *
 * 之前这份 JSON 没有任何 loader，故事写了等于没写 —— 用户看不到 24 小时推进。
 */
const URL_DEFAULT = '/assets/story/day_full.json';

const pad = (n) => String(n).padStart(2, '0');
export function clockText(minute) {
  const m = Math.max(0, Math.min(1440, Math.floor(minute)));
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

/**
 * @param {{url?:string}} opt
 * @returns 故事对象；load 失败时返回一个安全的空壳（页面不受影响）
 */
export async function createStory(opt = {}) {
  let data = null;
  try {
    const res = await fetch(opt.url || URL_DEFAULT, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.warn('[story] 剧本载入失败，HUD 不显示 24h 故事：', e && e.message);
    return {
      ok: false, data: null,
      at: () => ({ ok: false, minute: 0, cast: {}, beat: null, lines: [], activeScenes: [] }),
      get scenes() { return []; },
    };
  }

  const beats = (data.beats || []).slice().sort((a, b) => a.at - b.at);
  const scenes = data.scenes || [];
  const timelines = data.timeline || {};
  const castMeta = data.cast || {};

  /** 该场景是否在这一分钟被用到（scenes[].minute_ranges 是 [[a,b], ...]）。 */
  function sceneActiveAt(sc, m) {
    const rs = sc.minute_ranges;
    if (!Array.isArray(rs) || !rs.length) return false;
    return rs.some((r) => m >= (r[0] || 0) && m < (r[1] ?? 1440));
  }

  /** 按一天分钟取这一刻的完整故事切片。 */
  function at(minute) {
    let m = Number(minute) || 0;
    m = ((m % 1440) + 1440) % 1440;
    const cast = {};
    for (const [key, segs] of Object.entries(timelines)) {
      if (!Array.isArray(segs) || !segs.length) continue;
      cast[key] = segs.find((s) => m >= s.a && m < s.b)
        || segs[segs.length - 1];
    }
    let beat = null;
    for (let i = beats.length - 1; i >= 0; i--) {
      if (beats[i].at <= m) { beat = beats[i]; break; }
    }
    // 剧本第一个幕点在 02:50，00:00–02:50 是「没有事件的深夜」。
    // 直接回退到 beats[0] 会让 00:00 的面板显示 02:50 的标题（实测），
    // 所以补一个 0 点的合成幕，时间轴上才不会倒着跳。
    if (!beat) {
      beat = {
        at: 0, title: '00:00 深夜 · 各自在家听雨',
        environment: '毛毛雨 2–3 mm/h，钠灯橙光，路面只有一层水膜；街上只有夜班行人。',
        lines: [], involved: [],
      };
    }
    const nextBeat = beats.find((b) => b.at > m) || null;
    const activeScenes = scenes.filter((s) => sceneActiveAt(s, m));
    const lines = (beat && beat.lines) || [];
    return {
      ok: true, minute: m, clock: clockText(m),
      cast, beat, nextBeat, lines, activeScenes,
      act: beat ? beat.title : '',
      environment: beat ? beat.environment : '',
      involved: beat ? (beat.involved || []) : [],
    };
  }

  /** 某人的完整 22 段轨迹（给"人物档案"面板用）。 */
  const trajectory = (key) => timelines[key] || [];

  /** 当前这一刻每个人所在场景的 id 列表（给生活场景高亮用）。 */
  function activeSceneIds(minute) {
    return at(minute).activeScenes.map((s) => s.id);
  }

  console.info(`[story] 全天剧本已载入 · ${Object.keys(timelines).length} 人`
    + ` / ${scenes.length} 场景 / ${beats.length} 幕点`);

  return {
    ok: true, data, at, trajectory, activeSceneIds, clockText,
    get scenes() { return scenes; },
    get beats() { return beats; },
    get cast() { return castMeta; },
    get places() { return data.places || {}; },
    get meta() { return data.meta || {}; },
  };
}
