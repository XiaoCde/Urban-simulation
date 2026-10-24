/**
 * 地标建筑专用建模 —— 不再用 buildings.json 里那个「4 点矩形拉伸出来的素盒子」。
 *
 * 为什么必须有这个文件：
 *   `buildings_footprints.json` 每条轮廓都只有 **1 个 ring、4 个点**（见 b14 的实测），
 *   所以国会大厦这类体量在场景里就是一块 87 m 高的方板 —— 没有南北两翼、没有柱廊、
 *   没有鼓座，穹顶只是顶着的一块灰片，远看还行，一进画幅就露馅。
 *
 * 尺寸按公开实测值折算到米并用米制建模（局部原点 = 建筑中心，y=0 = 室外地面）：
 *   全长 N-S 751 ft ≈ 229 m；主体 E-W 约 350 ft ≈ 107 m；
 *   到自由神像顶 288 ft ≈ 88 m；穹顶直径约 30 m。
 *
 * 【教训】上一版把主体做成 62 m 宽（E-W），穹顶 31 m 直径看着就"过小"，
 *   而且山花那段先建 mesh 再换 geometry，留下一个悬空白板。
 *   这一版主体加宽到 92 m，山花用一个手写的三棱柱，尺寸与柱廊严格对齐。
 */

import * as THREE from 'three';

/** 三角形棱柱：底边在 z 方向宽 w、顶点高 h、沿 x 方向厚 t（用于山花）。 */
function triPrism(w, h, t) {
  const hz = w / 2;
  // 截面点在 (y,z)：左下、右下、顶点
  const P = [[0, -hz], [0, hz], [h, 0]];
  const pos = [];
  const push = (x, y, z) => pos.push(x, y, z);
  // 两个三角面
  push(0, P[0][0], P[0][1]); push(0, P[2][0], P[2][1]); push(0, P[1][0], P[1][1]);
  push(t, P[0][0], P[0][1]); push(t, P[1][0], P[1][1]); push(t, P[2][0], P[2][1]);
  // 三个侧面
  const quad = (a, b) => {
    push(0, P[a][0], P[a][1]); push(t, P[a][0], P[a][1]); push(t, P[b][0], P[b][1]);
    push(0, P[a][0], P[a][1]); push(t, P[b][0], P[b][1]); push(0, P[b][0], P[b][1]);
  };
  quad(0, 1); quad(1, 2); quad(2, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** 国会大厦：中央主体 + 南北两翼 + 东侧柱廊 + 鼓座 + 穹顶 + 采光亭 + 自由神像 */
export function buildCapitol(mats) {
  const g = new THREE.Group();
  g.name = 'Capitol';

  const stone = mats.stone || mats.trim;
  const trim = mats.trim || mats.stone;
  const column = mats.column || mats.trim;
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0xf1ede4, roughness: 0.52, metalness: 0.05,
  });
  const glass = mats.glass;

  const box = (w, h, d, x, y, z, mat, name) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    if (name) m.name = name;
    g.add(m);
    return m;
  };

  // ---- 关键标高（米）
  const H_MAIN = 31;      // 主体檐口
  const H_WING = 25;      // 两翼檐口
  const W_MAIN = 92;      // 主体东西宽（真实约 107 m，含两侧平台）
  const D_MAIN = 76;      // 主体南北深
  const W_WING = 46;      // 翼楼东西宽
  const D_WING = 74;      // 翼楼南北深
  const WING_Z = 76;      // 翼楼中心 |z|（两翼合起来全长 ≈ 229 m）

  // 中央主体
  box(W_MAIN, H_MAIN, D_MAIN, 0, 0, 0, stone, 'cap_main');
  box(W_MAIN + 3.2, 1.9, D_MAIN + 3.2, 0, H_MAIN - 1.9, 0, trim, 'cap_cornice');

  // 南北两翼 + 连接体 + 翼端门厅
  for (const s of [-1, 1]) {
    box(W_WING, H_WING, D_WING, 0, 0, s * WING_Z, stone, 'cap_wing');
    box(W_WING + 2.8, 1.6, D_WING + 2.8, 0, H_WING - 1.6, s * WING_Z, trim, 'cap_wing_cornice');
    box(W_WING - 6, 21, 12, 0, 0, s * (WING_Z + D_WING / 2 + 6), stone, 'cap_wing_end');
    // 主体与翼楼之间的连接体（退台，矮 6 m）
    box(W_WING + 8, H_MAIN - 6, 22, 0, 0, s * (D_MAIN / 2 + 8), stone, 'cap_link');
  }

  // ---- 东侧主入口柱廊（面向 x+）
  // 【比例】真实东立面 10 柱、总宽约 46 m。这里用 10 柱 / 4.6 m 柱距，
  //   柱高 17 m，落在 3 级台基上，上面接山花。
  const POR_Z = 52, POR_N = 10, POR_SPAN = 5.0, POR_X = W_MAIN / 2 + 5.5;
  const colH = 17, colR = 0.95;
  {
    const colGeo = new THREE.CylinderGeometry(colR * 0.9, colR, colH, 10, 1);
    const capGeo = new THREE.BoxGeometry(colR * 2.9, 1.0, colR * 2.9);
    const baseGeo = new THREE.BoxGeometry(colR * 2.8, 0.85, colR * 2.8);
    for (let i = 0; i < POR_N; i++) {
      const z = (i - (POR_N - 1) / 2) * POR_SPAN;
      const c = new THREE.Mesh(colGeo, column);
      c.position.set(POR_X, 2.6 + colH / 2, z);
      c.castShadow = true; c.receiveShadow = true;
      g.add(c);
      const cp = new THREE.Mesh(capGeo, trim); cp.position.set(POR_X, 2.6 + colH + 0.5, z); g.add(cp);
      const bp = new THREE.Mesh(baseGeo, trim); bp.position.set(POR_X, 2.6 - 0.42, z); g.add(bp);
    }
    // 台基：4 级，逐级内收
    for (let i = 0; i < 4; i++) {
      const w = 12 - i * 1.6;
      box(w, 0.65, POR_Z + 4 - i * 1.2, POR_X - 3.0 + i * 0.8, i * 0.65, 0, trim, 'cap_steps');
    }
    // 檐部
    box(6.2, 2.8, POR_Z + 3, POR_X - 1.0, 2.6 + colH, 0, trim, 'cap_entablature');
    // 山花（三棱柱）：底边沿 z，厚 6.2，立在高 2.6+colH+2.8 的檐部上
    const ped = new THREE.Mesh(triPrism(POR_Z + 3, 7.2, 6.2), trim);
    ped.position.set(POR_X - 1.0 - 3.1, 2.6 + colH + 2.8, 0);
    ped.castShadow = true; ped.receiveShadow = true;
    ped.name = 'cap_pediment';
    g.add(ped);
  }

  // ---- 西侧（国家广场侧）台阶 + 平台
  for (let i = 0; i < 4; i++) {
    box(10 - i * 1.4, 0.6, 52 - i * 1.6, -(W_MAIN / 2 + 4.0) + i * 0.9, i * 0.6, 0, trim, 'cap_west_steps');
  }

  // ---- 鼓座 + 环形柱廊
  const DR_Y0 = H_MAIN, DR_Y1 = 45, DR_R = 15.2;
  {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(DR_R, DR_R, DR_Y1 - DR_Y0, 32, 1), stone);
    drum.position.set(0, (DR_Y0 + DR_Y1) / 2, 0);
    drum.castShadow = true; drum.receiveShadow = true;
    g.add(drum);

    // 外圈 24 根柱（真实鼓座柱廊只有一层，高约 8.5 m）
    const n = 24, r = DR_R + 2.0, h = 8.6;
    const cg = new THREE.CylinderGeometry(0.58, 0.64, h, 8, 1);
    const inst = new THREE.InstancedMesh(cg, column, n);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      m4.makeTranslation(Math.cos(a) * r, DR_Y0 + 2.2 + h / 2, Math.sin(a) * r);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.name = 'cap_drum_colonnade';
    g.add(inst);

    // 柱廊上下的环梁
    const ringTop = new THREE.Mesh(new THREE.CylinderGeometry(DR_R + 3.0, DR_R + 3.0, 1.7, 32, 1), trim);
    ringTop.position.set(0, DR_Y1 - 0.9, 0); ringTop.castShadow = true; g.add(ringTop);
    const ringBot = new THREE.Mesh(new THREE.CylinderGeometry(DR_R + 1.2, DR_R + 2.8, 2.0, 32, 1), trim);
    ringBot.position.set(0, DR_Y0 + 1.0, 0); g.add(ringBot);
  }

  // ---- 穹顶：半球 + 12 条外凸肋
  {
    const domeH = 21, domeR = DR_R + 0.9;
    const sg = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const dome = new THREE.Mesh(sg, domeMat);
    dome.scale.set(domeR, domeH, domeR);
    dome.position.set(0, DR_Y1, 0);
    dome.castShadow = true; dome.receiveShadow = true;
    dome.name = 'cap_dome';
    g.add(dome);

    // 肋：沿经线摆一串小盒子，半径略大于球面（1.012 倍）才不会陷进去
    const ribGeo = new THREE.BoxGeometry(0.7, 1, 1.05);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      for (let k = 1; k <= 6; k++) {
        const t = k / 7;
        const rr = Math.cos(t * Math.PI / 2) * domeR * 1.005;
        const yy = DR_Y1 + Math.sin(t * Math.PI / 2) * domeH * 1.005;
        const seg = new THREE.Mesh(ribGeo, trim);
        seg.position.set(Math.cos(a) * rr, yy, Math.sin(a) * rr);
        seg.rotation.y = -a;
        seg.scale.set(1, 1.6, 1);
        g.add(seg);
      }
    }
  }

  // ---- 采光亭 + 自由神像
  {
    const y0 = DR_Y1 + 21;
    const lan = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 5.2, 5.4, 16, 1), stone);
    lan.position.set(0, y0 + 2.7, 0); lan.castShadow = true; g.add(lan);
    // 采光亭柱
    const n = 12, r = 5.0;
    const cg2 = new THREE.CylinderGeometry(0.4, 0.44, 4.6, 6, 1);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = new THREE.Mesh(cg2, column);
      c.position.set(Math.cos(a) * r, y0 + 3.0, Math.sin(a) * r);
      g.add(c);
    }
    const cap2 = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 5.8, 1.1, 16, 1), trim);
    cap2.position.set(0, y0 + 5.6, 0); g.add(cap2);
    const lanDome = new THREE.Mesh(new THREE.SphereGeometry(4.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    lanDome.position.set(0, y0 + 6.1, 0); lanDome.scale.set(1, 0.8, 1); g.add(lanDome);
    const finial = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3.0, 8), trim);
    finial.position.set(0, y0 + 10.0, 0); g.add(finial);
    // 自由神像（5.2 m，只做剪影）
    const statue = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.35, 5.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x93a09a, roughness: 0.55, metalness: 0.3 }),
    );
    statue.position.set(0, y0 + 13.6, 0); statue.castShadow = true; g.add(statue);
  }

  // ---- 窗洞：主体四面 + 两翼外侧，读起来是成排的拱窗
  if (glass) {
    const winGeo = new THREE.BoxGeometry(0.4, 4.6, 1.6);
    const winGeoZ = new THREE.BoxGeometry(1.6, 4.6, 0.4);
    // 主体东西两面
    for (const y of [9.5, 17.5, 24.5]) {
      for (const side of [-1, 1]) {
        for (let i = 0; i < 15; i++) {
          const z = (i - 7) * 4.6;
          if (Math.abs(z) > D_MAIN / 2 - 2) continue;
          const w = new THREE.Mesh(winGeo, glass);
          w.position.set(side * (W_MAIN / 2 + 0.08), y, z);
          g.add(w);
        }
        // 主体南北两面
        for (let i = 0; i < 20; i++) {
          const x = (i - 9.5) * 4.6;
          if (Math.abs(x) > W_MAIN / 2 - 2) continue;
          const w = new THREE.Mesh(winGeoZ, glass);
          w.position.set(x, y, side * (D_MAIN / 2 + 0.08));
          g.add(w);
        }
      }
    }
    // 两翼外侧（南北尽端之外的东/西面 + 尽端），层高比主体低一档
    for (const s of [-1, 1]) {
      for (const y of [8.5, 15.5, 21.5]) {
        for (const side of [-1, 1]) {
          for (let i = 0; i < 14; i++) {
            const z = s * WING_Z + (i - 6.5) * 4.8;
            if (Math.abs(z - s * WING_Z) > D_WING / 2 - 2) continue;
            const w = new THREE.Mesh(winGeo, glass);
            w.position.set(side * (W_WING / 2 + 0.08), y, z);
            g.add(w);
          }
        }
        // 翼端
        for (let i = 0; i < 6; i++) {
          const x = (i - 2.5) * 4.4;
          if (Math.abs(x) > W_WING / 2 - 4) continue;
          const w = new THREE.Mesh(winGeoZ, glass);
          w.position.set(x, y, s * (WING_Z + D_WING / 2 + 0.08));
          g.add(w);
        }
      }
    }
  }

  g.userData.footprint = { w: W_MAIN, d: 229 };
  g.userData.topY = DR_Y1 + 21 + 16;
  return g;
}