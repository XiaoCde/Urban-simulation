/**
 * 城市仿真时钟 —— 全城唯一的时间源。
 *
 * 【24 小时统一口径】minute 是「一天中的分钟」：0 = 00:00，1440 = 24:00。
 * 降雨窗口默认 1020–1140（17:00–19:00），由工况 manifest 的
 * rain_start_min / rain_end_min 给出。人、水、车、雨、退水全部读这一个数。
 *
 *   configure({start,end})  换工况时把量程对齐到它的时间轴
 *   advance(realDt)        返回本帧仿真秒，交给所有 story / PED.update
 *   seek(m)                跳时刻，通知所有订阅者重放到这一刻
 *
 * 旧口径「52 = 17:52 的降雨后分钟」已废弃。角色故事内部仍用相对分钟，
 * 但对外一律加 STORY_OFFSET（= 降雨窗口起点）换算成一天分钟。
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 故事脚本的 0 点：相对分钟 52（原 17:52）对应一天分钟 1072。 */
export const STORY_OFFSET = 1020;

/** 一天分钟 → HH:MM */
export function dayClockText(minute) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  const h = Math.floor(m / 60), mm = Math.floor(m % 60);
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** 一天分钟 → 故事脚本的相对分钟 */
export const toStoryMin = (m) => Number(m) - STORY_OFFSET;
/** 故事脚本相对分钟 → 一天分钟 */
export const toDayMin = (m) => Number(m) + STORY_OFFSET;

export class CityClock {
  constructor({ start = 0, end = 1440, speed = 6, playing = true } = {}) {
    this.start = start;
    this.end = end;
    this.minute = start;
    this.speed = speed;
    this.playing = playing;
    this.hooks = [];
    this.lastSimSec = 0;
    this.rainStart = 1020;
    this.rainEnd = 1140;
  }

  /** 换工况 / 读入 manifest 后调用。量程、降雨窗口都由工况决定。 */
  configure({ start, end, rainStart, rainEnd } = {}) {
    if (Number.isFinite(start)) this.start = start;
    if (Number.isFinite(end)) this.end = end;
    if (Number.isFinite(rainStart)) this.rainStart = rainStart;
    if (Number.isFinite(rainEnd)) this.rainEnd = rainEnd;
    this.minute = clamp(this.minute, this.start, this.end);
    for (const fn of this.hooks) {
      try { fn(this.minute); } catch (e) { console.warn('[clock] configure hook 失败', e); }
    }
  }

  /** 此刻是否在降雨窗口内（人、车、雨、退水都读这个）。 */
  get raining() { return this.minute >= this.rainStart && this.minute < this.rainEnd; }
  get dayText() { return dayClockText(this.minute); }

  /**
   * 每帧开始：只算本帧的仿真预算，**不推进时间**，交给主循环按子步回放。
   *
   * 【2026-11-11 统一时间层】旧版 advance() 一次把 minute 推到帧末，高倍率
   * 下一帧就是 2~4 仿真秒：行人一帧跨几米（触发瞬移保护）、0.5 s 一次的判断
   * 被整段跳过、积水与人不在同一时刻。现在拆成 ≤0.2 仿真秒的子步，倍率只
   * 改变每帧子步数，所有规则、判断频率、水深采样都按仿真秒走。
   *
   * @param {boolean} coarse 仅离线 24h 连续验收（skipRender）用：单步放宽到
   *   0.4 仿真秒，把 43 万子步减到 21 万。实时播放永远是 false / 0.2 秒。
   *   所有系统仍共用同一个 h，时间层完全一致，只是离线采样更稀。
   * @returns {{simSec:number,startMinute:number,steps:number,h:number}}
   */
  beginFrame(realDt, coarse = false) {
    if (!this.playing) {
      this.lastSimSec = 0;
      return { simSec: 0, startMinute: this.minute, steps: 0, h: 0 };
    }
    let simSec = Math.min(0.1, Math.max(0, realDt)) * this.speed;
    const MAX_H = coarse ? 0.4 : 0.2;
    // 倍率再高也不能把单步拉长，否则 5 仿真秒一步会漏掉到达/水深/转弯。
    // 超高倍率限制总仿真预算（相当于降频回放），而不是破坏时间粒度。
    const want = Math.ceil(simSec / MAX_H);
    const MAX_STEPS = 60;
    const steps = Math.max(1, Math.min(MAX_STEPS, want));
    const h = Math.min(MAX_H, simSec / steps);
    simSec = steps * h;
    this.lastSimSec = simSec;
    return { simSec, startMinute: this.minute, steps, h };
  }

  /** 子步：把全城唯一的时间源推进到某个中间分钟（所有系统下一子步就读它）。 */
  stepTo(m) { this.minute = Math.min(this.end, Math.max(this.start, Number(m) || this.start)); }

  /** 帧末：只在 24:00 收尾时停表。 */
  endFrame() { if (this.minute >= this.end) this.playing = false; }

  /** 兼容旧调用：不分子步、一次推到帧末。主循环一律用 beginFrame。 */
  advance(realDt) {
    const f = this.beginFrame(realDt);
    if (f.simSec > 0) this.stepTo(f.startMinute + f.simSec / 60);
    this.endFrame();
    return f.simSec;
  }

  /** 跳到任意时刻。订阅者负责把自己的状态重放到这一刻。 */
  seek(m) {
    this.minute = clamp(Number(m) || this.start, this.start, this.end);
    for (const fn of this.hooks) {
      try { fn(this.minute); } catch (e) { console.warn('[clock] seek hook 失败', e); }
    }
  }

  onSeek(fn) { this.hooks.push(fn); }
  setSpeed(v) { this.speed = Math.max(0.25, Number(v) || 1); }
  setPlaying(v) { this.playing = !!v; }
  togglePlay() { this.playing = !this.playing; return this.playing; }

  get simMin() { return this.minute; }
  get finished() { return this.minute >= this.end; }
}

/** 全局单例：城市只有一场雨、一个现在。 */
export const CLOCK = new CityClock();
