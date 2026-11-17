/**
 * collision.js —— 统一实体碰撞层。
 *
 * 背景 / 用户原话：「你有没有把所有都设计成实体，有碰撞体积」。
 *
 * 旧版只有 BIDX 这一层「粗粒度建筑包围盒」，它只做三件事：行人出生点筛选、
 * 跟拍机位避墙、相机判「有没有进楼」。除此之外：
 *   - 27 个生活场景里的 690 个家具（床 / 吧台 / 课桌 / 储物柜…）完全没体积，
 *     人和镜头都能直接穿过去；
 *   - 路灯、信号灯、停放的车、行道树也没有；
 *   - 行人走到终点后是靠路径约束，一旦路径贴着家具就会「穿桌子站」。
 *
 * 本模块把「世界里所有实心东西」收进一张空间哈希表：
 *   addBox / addCircle 注册，blockedCircle / resolve 查询，
 * 查询带 y 区间（楼板 / 天花板不会误判），带半径（人按 0.34 m 算）。
 *
 * 设计取舍：
 *   - 只做「静态实体」。车与车之间的动态避让在 traffic.js 里单独处理，
 *     因为每帧把 96 辆车塞进哈希表反而更慢。
 *   - 不做物理求解，只做「查询 + 推出最近空位」，够用且确定性强（可复现）。
 */

const CELL = 8;                       // 哈希格边长（米）：道具尺度 1–5 m，8 m 一格合适

export function createCollision({ cell = CELL } = {}) {
  const buckets = new Map();
  const items = [];                   // {minx,maxx,minz,maxz,y0,y1,r,tag}
  let stamp = 0;

  const hash = (gx, gz) => (gx * 73856093) ^ (gz * 19349663);

  function insert(it) {
    it.id = items.length;
    items.push(it);
    for (let gx = Math.floor(it.minx / cell); gx <= Math.floor(it.maxx / cell); gx++) {
      for (let gz = Math.floor(it.minz / cell); gz <= Math.floor(it.maxz / cell); gz++) {
        const k = hash(gx, gz);
        let arr = buckets.get(k);
        if (!arr) buckets.set(k, arr = []);
        arr.push(it);
      }
    }
    return it;
  }

  /** 轴对齐盒：中心 (x,z)，半宽 hw、半深 hd，竖直区间 [y0,y1]。 */
  function addBox(x, z, hw, hd, y0, y1, tag = 'prop') {
    if (!(hw > 0) || !(hd > 0)) return null;
    if (!(y1 > y0)) return null;
    return insert({
      minx: x - hw, maxx: x + hw, minz: z - hd, maxz: z + hd,
      y0, y1, r: Math.hypot(hw, hd), tag,
    });
  }

  /** 圆（树 / 灯杆 / 垃圾桶这类细长物）。 */
  function addCircle(x, z, r, y0, y1, tag = 'prop') {
    if (!(r > 0)) return null;
    return addBox(x, z, r, r, y0, y1, tag);
  }

  /** 直接吃 three 的 Box3（世界坐标）。扁平的（楼板/地毯/划线）自动跳过。 */
  function addBox3(box, tag = 'prop', { minH = 0.22 } = {}) {
    const h = box.max.y - box.min.y;
    if (h < minH) return null;
    const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
    if (w < 0.05 || d < 0.05) return null;
    return insert({
      minx: box.min.x, maxx: box.max.x, minz: box.min.z, maxz: box.max.z,
      y0: box.min.y, y1: box.max.y, r: Math.hypot(w, d) * 0.5, tag,
    });
  }

  /** 标记某个已登记实体为「已删除」。
   *  压路的低模楼会从渲染管线里整栋剔除，但它们在 BIDX/COLLIDE 里还留着
   *  包围盒 —— 于是相机被看不见的墙挡、车沿路走却撞上幽灵。渲染层没有
   *  实体了，碰撞层也必须同步注销，而不是只把统计数字改好看了事。 */
  function drop(id) {
    const it = items[id];
    if (it) it.dead = true;
  }

  /**
   * 某个圆柱体（人）在这个点会不会撞上东西。
   * @param {number} x,z 位置；r 半径；y0/y1 身体的竖直区间
   * @param {object} opt { ignoreTags:Set, pad } —— 例如室内人物忽略 'building'
   */
  function blockedCircle(x, z, r, y0, y1, opt = {}) {
    const pad = opt.pad || 0;
    const ignore = opt.ignoreTags || null;
    const gx0 = Math.floor((x - r - pad) / cell), gx1 = Math.floor((x + r + pad) / cell);
    const gz0 = Math.floor((z - r - pad) / cell), gz1 = Math.floor((z + r + pad) / cell);
    stamp++;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const arr = buckets.get(hash(gx, gz));
        if (!arr) continue;
        for (const it of arr) {
          if (it.dead || it.seen === stamp) continue;
          it.seen = stamp;
          if (ignore && ignore.has(it.tag)) continue;
          if (it.y1 <= y0 || it.y0 >= y1) continue;         // 竖直不重叠
          // 圆 vs AABB：最近点距离
          const cx = Math.max(it.minx, Math.min(x, it.maxx));
          const cz = Math.max(it.minz, Math.min(z, it.maxz));
          const dx = x - cx, dz = z - cz;
          const rr = r + pad;
          if (dx * dx + dz * dz < rr * rr) return it;
        }
      }
    }
    return null;
  }

  /** 单点测试（相机 / 出生点用）。 */
  function blocked(x, y, z, opt = {}) {
    return !!blockedCircle(x, z, opt.r || 0.12, y, y + 0.2, opt);
  }

  /**
   * 把人/物推出障碍：绕着当前位置做 16 方向 × 3 圈的螺旋搜索，
   * 找到最近的空位。找不到就返回原点（调用方自己决定要不要放弃）。
   */
  function resolve(x, z, r, y0, y1, opt = {}) {
    if (!blockedCircle(x, z, r, y0, y1, opt)) return { x, z, moved: 0 };
    const step = Math.max(0.35, r + 0.25);
    for (let ring = 1; ring <= 6; ring++) {
      const rad = step * ring;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(a) * rad, nz = z + Math.sin(a) * rad;
        if (!blockedCircle(nx, nz, r, y0, y1, opt)) {
          return { x: nx, z: nz, moved: Math.hypot(nx - x, nz - z) };
        }
      }
    }
    return { x, z, moved: 0, stuck: true };
  }

  /**
   * 沿「想走的方向」滑动：撞墙不硬停，而是贴着障碍的切线蹭过去。
   * 返回真正能走到的点（可能等于原点）。
   */
  function slide(x, z, dx, dz, r, y0, y1, opt = {}) {
    const nx = x + dx, nz = z + dz;
    if (!blockedCircle(nx, nz, r, y0, y1, opt)) return { x: nx, z: nz, hit: null };
    // 先试只走 x，再试只走 z
    if (!blockedCircle(x + dx, z, r, y0, y1, opt)) return { x: x + dx, z, hit: 'x' };
    if (!blockedCircle(x, z + dz, r, y0, y1, opt)) return { x, z: z + dz, hit: 'z' };
    return { x, z, hit: 'full' };
  }

  function stats() {
    const byTag = {};
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const it of items) {
      if (it.dead) continue;
      byTag[it.tag] = (byTag[it.tag] || 0) + 1;
      if (it.minx < minx) minx = it.minx;
      if (it.maxx > maxx) maxx = it.maxx;
      if (it.minz < minz) minz = it.minz;
      if (it.maxz > maxz) maxz = it.maxz;
    }
    return { boxes: items.length, cells: buckets.size, byTag, bounds: [minx, maxx, minz, maxz] };
  }

  return {
    addBox, addCircle, addBox3, drop, blocked, blockedCircle, resolve, slide, stats,
    get items() { return items; },
  };
}

/* ------------------------------------------------------------------ *
 * 从 three 场景图自动收实体：道具 / 车 / 灯杆 / 树，一个都不用手写坐标。
 * ------------------------------------------------------------------ */
/**
 * @param {THREE.Object3D} root 要扫描的 group
 * @param {object} collide createCollision() 的返回值
 * @param {object} opt { tag, minH, skip } —— skip(mesh) 返回 true 则跳过
 */
export function collectSolids(root, collide, {
  tag = 'prop', minH = 0.22, skip = null, THREE = null, instFallback = null,
} = {}) {
  if (!root || !collide || !THREE) return 0;
  const box = new THREE.Box3();
  let n = 0;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (skip && skip(o)) return;
    if (o.userData && o.userData.noCollide) return;
    if (o.isInstancedMesh) {
      // 实例化网格：逐实例取位置 + 尺度，按包住它的球注册
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const geoBox = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        m.decompose(p, q, s);
        let h = (geoBox.max.y - geoBox.min.y) * Math.abs(s.y);
        let w = (geoBox.max.x - geoBox.min.x) * Math.abs(s.x);
        let d = (geoBox.max.z - geoBox.min.z) * Math.abs(s.z);
        let y0 = p.y + geoBox.min.y * s.y;
        // 有些 InstancedMesh 的几何是「单位体 + 逐实例缩放」，几何包围盒本身接近 0，
        // 算出来 h≈0 会被当成地面跳过（停车场 50 辆车就是这样漏掉的）。
        // 给一个兜底尺寸：按一辆车的体量（半径 0.85 m、高 1.4 m）登记。
        if (!(h >= minH) && instFallback) {
          h = instFallback.h; w = instFallback.r * 2; d = instFallback.r * 2; y0 = p.y;
        }
        if (!(h >= minH) || !isFinite(h)) continue;
        collide.addBox(p.x, p.z, Math.max(0.12, w * 0.5), Math.max(0.12, d * 0.5),
          y0, y0 + h, tag);
        n++;
      }
      return;
    }
    box.setFromObject(o);
    if (collide.addBox3(box, tag, { minH })) n++;
  });
  return n;
}
