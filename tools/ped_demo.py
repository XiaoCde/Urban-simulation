# -*- coding: utf-8 -*-
r"""Day 1.3：把 ped_sim 的仿真"画出来" —— 1 个行人在空地上按状态机走动。

分层（见 行人Demo-计划表.md 的硬规矩①②）：
    ped_fsm.py   纯函数：下一个状态是什么
    ped_sim.py   纯 python：谁在哪儿、谁挡着谁      <- 这两层都不知道 Blender 存在
    ped_demo.py  Blender：删导入垃圾、搭地面/太阳/相机、按状态摆姿势、出帧   <- 只有这一层碰 bpy

**动画时间由仿真决定，不用 scene.frame**：
    每帧我们把 action 的 F-curve 在"这个 agent 该播到的时刻"上求值，直接写进
    pose bone。这样 N 个人可以有各自的相位（否则 10 个人会像广播体操一样同步），
    而且"固定种子 -> 同一段视频"这条验收标准才站得住（Blender 只是执行者）。

用法:
    blender --background --python tools\ped_demo.py -- <输出目录> [选项]
选项:
    --people N     人数（默认 1）
    --seconds S    时长秒（默认 6）
    --fps N        帧率（默认 24）
    --size WxH     分辨率（默认 1280x720）
    --seed N       随机种子（默认 20261020）
    --mode MODE    png / video / both（默认 png；video 直接出 H.264 mp4）
    --model PATH   角色文件（.fbx / .glb；默认按 Body Block.fbx -> Soldier -> Xbot 找）
    --clips LIST   逗号分隔的动画文件（Mixamo 的角色和动画是分开下的），例如
                   --clips "data\characters\Breathing Idle.fbx,data\characters\Walking.fbx,data\characters\Running.fbx"
                   不填就从角色文件自己带的动作里找。
    --patrol 半径  巡查点在多大范围里（默认 6，0 = 只在原地来回走 4 m）
"""
import importlib.util
import json
import math
import os
import re
import sys

import bpy
from mathutils import Vector

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)                      # 项目根目录
CHARS = os.path.join(ROOT, "data", "characters")


def load_mod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


S = load_mod("ped_sim", os.path.join(TOOLS, "ped_sim.py"))
F = S.F

# ---------------------------------------------------------------- 常量
# glTF 是 Y 轴朝上、模型朝 +Z；Blender 导入时转成 Z 朝上：glTF +Z -> Blender -Y。
# 所以模型的"脸朝哪儿"在 Blender 里是 -Y。我们的 heading 定义是 XY 平面上的
# (cos h, sin h)，把 -Y 转到 (cos h, sin h) 需要绕 Z 转 h + 90°。
FACING_OFFSET = math.pi / 2.0

# 状态 -> **专属**动作名候选。
# 计划表 §二 的要求是一个状态一段动作：Idle→idle / Walk→walk / Yield→sidestep / Look→look。
# 键既可能是动作名（glTF：Walk / idle / Anim_0），也可能是文件名
# （Mixamo 把角色和动画分开下：Walking / Breathing Idle / Running）。
CLIP_CANDIDATES = {
    F.ST_IDLE:  ["Breathing Idle", "Standing Idle", "Idle", "idle", "Anim_0"],
    F.ST_WALK:  ["Walking", "Slow Walk", "Walk", "walk", "Anim_0"],
    # Yield 要的是"侧身让行"，不是站着不动。这几组关键词是给 Mixamo 搜的。
    # 【顺序即语义】Yield 是"侧身让行"。ped_sim 里写死了 `a.dodge_sgn = 1`
    # 「一律靠右让行」，而 _perp() 给的正是航向**右侧**的法线 —— 所以第一个
    # 候选必须是向右的侧步。挑成向左，人会一边往右挪、一边朝左迈腿。
    F.ST_YIELD: ["Walk Strafe Right", "Strafe Right", "Side Step", "Sidestep",
                 "Step Aside", "Step Back", "Walk Strafe Left",
                 "Walking Turn", "Turn Left", "Turn Right",
                 "Walking Backwards", "Walk Backwards"],
    F.ST_LOOK:  ["Looking Around", "Look Around", "Look", "Searching"],
}

# 状态**内部**还要分段接动作。为什么：同一个状态里位移性质不一样的片段，
# 播同一段动作必然有一半是错的。实测（out/verify_day3.log）Yield 一个状态里三段：
#   僵持 7.92 s @ 0.00 m/s / 侧移 3.17 s @ 1.00 m/s / 绕完续走 6.17 s @ 0.05 m/s
# 全播"向右侧步" → 82% 的时间在**原地**迈侧步（僵持段实测速度就是 0.00）；
# 全播"站着"     → 真正横移那 3.17 秒变成滑行。
# 所以按子相位分开接：
#   起步（Walk 头 0.62 s）  → Start Walking   （站立→迈步，比直接切进 Walking 循环少一次跳变）
#   停步（Yield 头 0.55 s） → Stop Walking    （迈步→站定，正好接上僵持段的站立）
#   横移（Yield 真在挪）    → 向右侧步，并按 横移速度/动作隐含速度 配播放速率
SUB_CANDIDATES = {
    "walk_start":  ["Start Walking", "StartWalk", "Walk Start"],
    "walk_stop":   ["Stop Walking", "StopWalk", "Walk Stop"],
    "yield_dodge": ["Walk Strafe Right", "Strafe Right", "Side Step", "Sidestep"],
    # yield_stall = Yield 里**站着僵持**的那段（实测 0.00 m/s）。它必须和
    # "侧步"分开，否则 82% 的 Yield 时间是"站着还在原地迈侧步"（这正是我在
    # §2.5 里写"僵持段接站立动作"的原因，但第一版代码漏了这一支，
    # 动作表上表现为 Yield 的帧全被算进侧步 —— 文档和代码打架，以文档为准改代码）。
    # 用户说他去找一段"站定摇头"来替掉这里的站立；文件到位后把名字加到最前面即可。
    "yield_stall": ["Shaking Head", "Head Shake", "Standing Arguing", "Deny",
                    "Breathing Idle"],
}

# 一次性动作的状态：进入时该从动作第 0 帧开始播。
# 其余（走/站）是循环动作，**相位必须连续** —— 否则每次避让完再起步，走路
# 都从循环起点重来，脚会踢一下（Day 1 就埋着的坑，画面上看是"抽一下"）。
# Yield 从这份名单里去掉了：它现在由子相位自己管（停步段/侧步段各自从头播，
# 僵持段接的是站立动作、相位要和 Idle 连续），当成一次性反而会每次重来。
RESET_ON_ENTER = (F.ST_LOOK,)

# 缺专属动作时**允许**临时顶替的来源。这是显式降级，不是静默兜底：
# 需要 --allow-placeholder 才放行，且每条日志都会标成"占位"。
FALLBACK_STATE = {
    F.ST_IDLE: None,
    F.ST_WALK: F.ST_IDLE,
    F.ST_YIELD: F.ST_IDLE,
    F.ST_LOOK: F.ST_IDLE,
}

# 走路动画一个循环对应的位移（米）。必须拿它反推行走速度，否则脚会在地上滑。
# Soldier 的 Walk 一个循环 1.03 s，成年男性两步约 1.5 m；
# Mixamo 的 Walking 一个循环 1.29 s，同样是两步 1.5 m。
STRIDE_M = {"Walk": 1.5, "walk": 1.5, "Walking": 1.5, "walking": 1.5,
            "Run": 3.0, "run": 3.0, "Running": 3.0, "running": 3.0,
            "Anim_0": 1.5}

# 角色目标身高（米）。实测：Mixamo 的 FBX 导入后世界高度是 3.34 m —— 比例是对的、
# 但整体偏大 1.86 倍。所以导入后按"量出来的高度"反向缩放到这个值，而不是靠
# global_scale 去猜 FBX 的单位（猜错了下一个角色又不对）。
TARGET_H = 1.80


def log(msg):
    print("[demo] %s" % msg)


# ---------------------------------------------------------------- 参数
def parse_args(argv):
    opt = dict(outdir=None, people=1, seconds=6.0, fps=24, width=1280, height=720,
               seed=20261020, mode="png", model=None, patrol=6.0, cam=None,
               clips=None, target_h=TARGET_H, pose="manual",
               city=None, cell="27,22", z_floor=0.0, window=18.0,
               frames=None, warm=0.0, samples=32,
               allow_placeholder=False, keep_root_motion=False,
               arrive=None, yield_gap=None, yield_hold=None, yield_max=None,
               dodge=None, dodgespd=None, cone=None, no_rt=False)
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--people":
            i += 1; opt["people"] = int(argv[i])
        elif a == "--city":
            # 载入真实城市场景（out\dc_real3_clean.blend）而不是空棋盘地面
            i += 1; opt["city"] = argv[i]
        elif a == "--cell":
            i += 1; opt["cell"] = argv[i]
        elif a == "--z-floor":
            # 城市里路面/人行道带的控制点世界 Z 实测恒为 0.3（地面网格在 0.0），
            # 不抬这 0.3 m 人的脚会陷进人行道里 —— 30 cm 的穿模，一眼就看得出来。
            i += 1; opt["z_floor"] = float(argv[i])
        elif a == "--window":
            i += 1; opt["window"] = float(argv[i])
        elif a == "--frames":
            i += 1; opt["frames"] = int(argv[i])
        elif a == "--warm":
            # 先空跑这么多秒再开始记录/出帧：用来检查"走到一半"时的构图
            i += 1; opt["warm"] = float(argv[i])
        elif a == "--samples":
            i += 1; opt["samples"] = int(argv[i])
        elif a == "--arrive":
            i += 1; opt["arrive"] = float(argv[i])
        elif a == "--yield-gap":
            i += 1; opt["yield_gap"] = float(argv[i])
        elif a == "--yield-hold":
            i += 1; opt["yield_hold"] = float(argv[i])
        elif a == "--yield-max":
            i += 1; opt["yield_max"] = float(argv[i])
        elif a == "--dodge":
            i += 1; opt["dodge"] = float(argv[i])
        elif a == "--dodge-spd":
            i += 1; opt["dodgespd"] = float(argv[i])
        elif a == "--no-rt":
            # 关掉 EEVEE Next 的硬件光追（含降噪）。用途是**测渲染确定性**：
            # 实测同一条命令渲两次，解码帧最大差 25~36/255、约 36% 像素不同，
            # 需要判定噪声是不是来自 GPU 光追/降噪这条路径。
            opt["no_rt"] = True
        elif a == "--allow-placeholder":
            # 显式放行"某个状态没有专属动作、临时拿站立顶"。默认**不放行**：
            # 导师要的是"主动在动作之间切换"，静默顶替等于悄悄降级需求。
            opt["allow_placeholder"] = True
        elif a == "--keep-root-motion":
            # 诊断开关：保留动作自带的根位移漂移（默认会削掉）。
            # 用来复现"走一段就闪回一次"，以及给 check_root_motion.py 做对照。
            opt["keep_root_motion"] = True
        elif a == "--cone":
            # 正前方锥形半角（度）。默认 45°；实测 30° 更接近真人 ——
            # 只对"基本在我正前方"的人让路，不会因为斜前方有人就站住，
            # 5 秒里走路占比从 59.8% 提到 65.8%、擦身对数 8 -> 9。
            i += 1; opt["cone"] = float(argv[i])
        elif a == "--target-h":
            # 0 = 不做身高归一。用来隔离"姿势错"还是"缩放错"。
            i += 1; opt["target_h"] = float(argv[i])
        elif a == "--pose":
            # manual（默认，手工求值 F-curve）/ none（不套动作，只有 rest）
            i += 1; opt["pose"] = argv[i]
        elif a == "--seconds":
            i += 1; opt["seconds"] = float(argv[i])
        elif a == "--fps":
            i += 1; opt["fps"] = int(argv[i])
        elif a == "--size":
            i += 1; w, h = argv[i].lower().split("x"); opt["width"] = int(w); opt["height"] = int(h)
        elif a == "--seed":
            i += 1; opt["seed"] = int(argv[i])
        elif a == "--mode":
            i += 1; opt["mode"] = argv[i]
        elif a == "--model":
            i += 1; opt["model"] = argv[i]
        elif a == "--clips":
            i += 1
            opt["clips"] = [x.strip() for x in argv[i].split(",") if x.strip()]
        elif a == "--patrol":
            i += 1; opt["patrol"] = float(argv[i])
        elif a == "--cam":
            i += 1; opt["cam"] = argv[i]
        elif opt["outdir"] is None:
            opt["outdir"] = a
        i += 1
    # 【坑】--cam 默认必须是 None 再在这里定，不能直接默认 "track"。
    # 城市模式下 "track" 会把 Day 1 的跟拍机位套上来，镜头只追 P00 一个人 ——
    # 10 个人同框的验收目标直接作废（实测撞过一次：相机被改到
    # (4110.4, 3433.0, 2.05)，画面里只有 1 个人和拉近到 6 m 的距离）。
    if opt["cam"] is None:
        opt["cam"] = "static" if opt["city"] else "track"
    return opt


def find_model(explicit=None):
    if explicit:
        return explicit
    # 优先用 Mixamo 下的真人角色。Mixamo 的角色和动画共用同一套 mixamorig 骨架，
    # 换角色不需要改状态机、仿真和渲染管线。
    for n in ("Body Block.fbx", "Soldier.glb", "Xbot.glb", "CesiumMan.glb"):
        p = os.path.join(CHARS, n)
        if os.path.exists(p):
            return p
    # 兜底：data\characters 下任何 fbx / glb，但排除明显是动画的文件名
    anim = ("walk", "run", "jog", "idle", "sit", "breath", "turn", "look", "jump")
    for f in sorted(os.listdir(CHARS)):
        low = f.lower()
        if low.endswith((".fbx", ".glb")) and not any(w in low for w in anim):
            return os.path.join(CHARS, f)
    raise SystemExit("data\\characters 下找不到角色文件（.fbx / .glb）")


# ---------------------------------------------------------------- 场景
def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_character(path):
    pre = set(o.name for o in bpy.data.objects)     # 导入**之前**就存在的物体
    if os.path.splitext(path)[1].lower() == ".fbx":
        # Mixamo 只给 FBX。用默认参数导入即可 —— 骨骼名同样是 mixamorig:*，
        # 和免登录下的 Soldier/Xbot 那套一致，两边的动作可以互相套。
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    arm_name = None
    for o in bpy.data.objects:
        if o.type == "ARMATURE":
            arm_name = o.name
            break
    if arm_name is None:
        raise SystemExit("导入的 glb 里没有骨骼")
    # glTF 导入器会自己塞一个半径 1 m 的 Icosphere，不是模型内容，留着会撑大包围盒、
    # 也会在画面里出现一个灰球。删掉。（这是实测出来的：导入前场景为空，导入后
    # 除了 glTF 日志里那两个 mesh 之外还多出它一个。）
    # 注意：bpy.data.objects.remove() 之后，Python 里旧的对象引用会变成
    # "StructRNA of type Object has been removed"，所以下面一律用**名字**操作。
    # 【城市模式铁律】判据必须限定在"本次导入**新出现**的物体"里。
    # 原来的写法是对全场景扫"MESH + 无顶点组 + 无父级 + 无材质槽"，空场景里
    # 没问题，但在 48,381 个物体的城市里，任何符合这几条的物件都会被当垃圾删掉
    # —— 那是删用户的资产，不是清 Importer 的尾巴。
    before = [o.name for o in bpy.data.objects]
    killers = [n for n in before
               if n not in pre
               and (n.startswith("Icosphere")
                    or (bpy.data.objects[n].type == "MESH"
                        and len(bpy.data.objects[n].vertex_groups) == 0
                        and bpy.data.objects[n].parent is None
                        and len(bpy.data.objects[n].material_slots) == 0))]
    for nm in killers:
        log("删除导入垃圾物体：%s" % nm)
        bpy.data.objects.remove(bpy.data.objects[nm], do_unlink=True)
    after = [o.name for o in bpy.data.objects]
    # 【日志铁律】不要打印整套物体名单：城市场景 48,381 个物体的名字打出来是
    # 十几万字符，真正的错误信息会被淹掉（实测踩过）。只报增量。
    added = [n for n in after if n not in pre]
    log("导入增量物体 %d 个：%s%s"
        % (len(added), added[:8], " ..." if len(added) > 8 else ""))

    arm = bpy.data.objects.get(arm_name)
    if arm is None:
        raise SystemExit("清理垃圾时把骨骼也删了，检查 killers 判据")
    # 【关键坑】Blender 的 FBX 导入器会把骨骼设成 REST 显示模式。REST 模式下
    # pose.bones 的 location/rotation 照样有值、matrix_basis 也照样变，
    # 但 pose bone 的 head 和网格形变**全被忽略** —— 症状就是"动作套上去了、
    # 角色纹丝不动"。实测证据：Hips 的 basis平移=(1.797,-24.963,15.811)，
    # 而 pb.head 仍是 rest 位置 (0.018,-0.144,1.842)。
    if arm.data.pose_position != "POSE":
        log("骨骼显示模式 %s -> POSE（不改的话姿势不生效）" % arm.data.pose_position)
        arm.data.pose_position = "POSE"
    meshes = [o for o in bpy.data.objects
              if o.type == "MESH" and o.name not in pre]
    # 【城市模式铁律】meshes 必须只包含"本次新导入的"网格。
    # 原来写的是全场景 MESH —— 空场景里没问题，但在 48,381 个物体的城市里，
    # 下一步的"身高归一化"会拿 23,486 个城市网格去量高度，算出 k=1.1e-4，
    # 把人缩成 **4 cm**（实测：世界高度 0.04 m、世界缩放 0.00011）。
    body = meshes[0] if meshes else None
    log("新导入的角色网格 %d 个：%s" % (len(meshes), [o.name for o in meshes]))
    # 【铁律】o.bound_box 是**未变形**的物体局部包围盒，量出来的 3.34 m 是假的。
    # Body Block.fbx 实测：未变形包围盒 3.34 m，而套上骨骼绑定求值之后
    # 真正的 rest 高度只有 1.93 m（差 1.73 倍）。用假数字算归一化系数，
    # 就会把角色压成 1.04 m —— 这就是"套动作后塌成 0.5 m"的一半原因。
    def _eval_z():
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        zs = []
        for m in meshes:
            ev = m.evaluated_get(dg)
            try:
                me = ev.to_mesh()
            except Exception:
                continue
            mw = ev.matrix_world
            zs.extend((mw @ v.co).z for v in me.vertices)
            ev.to_mesh_clear()
        return zs

    zs = _eval_z()
    if zs:
        h0 = max(zs) - min(zs)
        log("角色世界高度（按变形后网格量）：%.2f m（z %.2f ~ %.2f）"
            % (h0, min(zs), max(zs)))
        # 【防自欺闸门】身高归一化是个除法，分母（量到的高度）一旦量错，
        # 它会**静默**把角色缩成几厘米 —— 实测踩过一次（量到 16 km 的城市几何，
        # k=1.1e-4，人变 4 cm）。所以这里对量到的值做合理性检查：
        # 不在这区间就报错停下，不许"算出一个数字就往下走"。
        if not (0.3 <= h0 <= 8.0):
            raise SystemExit(
                "量到的角色高度 %.2f m 不合理（合理区间 0.3~8 m）——"
                "多半是把场景里别的网格当成角色了，检查 import_character 的 meshes 过滤"
                % h0)
        if TARGET_H > 0 and abs(h0 - TARGET_H) > 0.02:
            k = TARGET_H / h0
            arm.scale = tuple(s * k for s in arm.scale)
            for m in meshes:
                if m.parent is None:
                    m.scale = tuple(s * k for s in m.scale)
            zs2 = _eval_z()
            if zs2:
                log("身高归一：x%.4f -> 世界高度 %.2f m（目标 %.2f m）"
                    % (k, max(zs2) - min(zs2), TARGET_H))
    # 【铁律】FBX 的 Y-up -> Z-up 转换是靠 armature **物体**上的一圈 X 旋转实现的。
    # 出帧时如果直接写 rotation_euler=(0,0,heading)，就把那圈 X 旋转抹掉，
    # 角色会**平躺着在地上滑行**（实测：整个世界高度从 1.93 m 变成 0.98 m，
    # 而且在渲染图里看到的是一具横躺的身体）。所以必须把导入时的原始旋转/位置
    # 记下来，出帧时只在其基础上叠加 heading（见 apply_frame 里的 _place）。
    arm["base_rot"] = (arm.rotation_euler.x, arm.rotation_euler.y, arm.rotation_euler.z)
    arm["base_loc"] = (arm.location.x, arm.location.y, arm.location.z)
    log("骨骼导入时 base_rot=(%.4f, %.4f, %.4f) base_loc=(%.3f, %.3f, %.3f)"
        % (arm["base_rot"][0], arm["base_rot"][1], arm["base_rot"][2],
           arm["base_loc"][0], arm["base_loc"][1], arm["base_loc"][2]))
    arm.animation_data_create()
    arm.animation_data.action = None        # 动画由我们求值，不让场景帧插手
    return arm, body, meshes


def collect_clips(arm, meshes):
    """在 armature 与 mesh 的 animation_data / NLA 以及 bpy.data.actions 里找动作。"""
    names = set()
    for o in [arm] + list(meshes):
        ad = o.animation_data
        if ad is None:
            continue
        if ad.action:
            names.add(ad.action.name)
        for tr in ad.nla_tracks:
            for st in tr.strips:
                if st.action:
                    names.add(st.action.name)
    acts = {}
    for n in names:
        a = bpy.data.actions.get(n)
        if a is not None:
            acts[n] = a
    log("找到动作：%s" % sorted(acts.keys()))
    return acts


def load_clip_files(paths, fps):
    """导入若干个「只有动画」的文件（Mixamo 把角色和动画分开下），取出里面的
    action，再把多出来的物体删掉。

    为什么要这么绕：动画文件里也带着一整套网格 —— 下载时 Skin 选成 With Skin
    的话，每个动画文件和角色一样大（实测 27 MB）。但 action 存在
    bpy.data.actions 里、不跟着物体走，所以「导进来 -> 抓到 action -> 删掉多出来
    的物体」就行。两边骨骼名都是 mixamorig:*，动作能直接套到角色的骨骼上。
    """
    out = {}
    for p in paths:
        base = os.path.basename(p)
        key = os.path.splitext(base)[0].lower()
        before_o = set(o.name for o in bpy.data.objects)
        before_a = set(a.name for a in bpy.data.actions)
        if os.path.splitext(p)[1].lower() == ".fbx":
            bpy.ops.import_scene.fbx(filepath=p)
        else:
            bpy.ops.import_scene.gltf(filepath=p)
        new_acts = [a for a in bpy.data.actions if a.name not in before_a]
        new_objs = [o.name for o in bpy.data.objects if o.name not in before_o]
        if not new_acts:
            log("!! %s 里没找到动作" % base)
        else:
            act = max(new_acts, key=lambda a: a.frame_range[1] - a.frame_range[0])
            act.use_fake_user = True          # 删掉物体后别让它被回收
            out[key] = act
            log("动画文件 %-22s -> 动作 %-30s %.2f s"
                % (base, act.name, clip_seconds(act, fps)))
        for nm in new_objs:
            if nm in bpy.data.objects:
                bpy.data.objects.remove(bpy.data.objects[nm], do_unlink=True)
    return out


def pick_clip(acts, state, cands=None):
    """按状态取**专属**动作。返回 (名字, 动作, 是否命中专属候选)。

    cands 给定时按它挑（子相位动作用，它们不对应一个状态）。

    【铁律】这里以前有一句"兜底：拿最长的一个" —— 就是它让 Yield 和 Look
    悄悄播成了和 Idle 一模一样的站立动作，把导师要的"主动在动作之间切换"
    拍成了"走走停停"。现在找不到就如实返回 False，由调用方决定报错还是显式降级。
    """
    if cands is None:
        cands = CLIP_CANDIDATES.get(state, [])
    cands = [c.lower() for c in cands]
    for c in cands:                          # 先精确匹配
        for n, a in acts.items():
            if n.lower() == c:
                return n, a, True
    for c in cands:                          # 文件名常是 "Breathing Idle" 这种，再包含匹配
        for n, a in acts.items():
            if c in n.lower():
                return n, a, True
    return None, None, False


def clip_seconds(act, fps):
    lo, hi = act.frame_range
    return max(1e-6, (hi - lo) / float(fps))


def describe_action(act):
    """描述 action 结构，并回报"重复键"数量。

    为什么必须查重复键：Blender 4.4+ 的 action 是分层 + channelbag，而
    pose_table 只按 (骨骼, 属性) 归拢 —— 同一格出现两条曲线就是**后写覆盖前写**。
    实测 Walk 是 1 layer / 1 strip / 4 channelbag；万一这 4 个 channelbag
    属于不同 slot，覆盖就会串相位。重复键 > 0 就必须报警，不能装作没事。
    """
    total = 0
    seen = set()
    dupes = 0
    for fc in iter_fcurves(act):
        total += 1
        k = (fc.data_path, fc.array_index)
        if k in seen:
            dupes += 1
        seen.add(k)
    lay = list(getattr(act, "layers", []) or [])
    n_str = sum(len(l.strips) for l in lay)
    n_cb = 0
    for l in lay:
        for s in l.strips:
            try:
                n_cb += len(list(s.channelbags))
            except Exception:
                pass
    return dict(curves=total, layers=len(lay), strips=n_str,
                channelbags=n_cb, dupes=dupes)


def root_bone_of(arm):
    """armature 的根骨骼（没有父级的那个）。Mixamo 里叫 mixamorig:Hips。"""
    for b in arm.data.bones:
        if b.parent is None:
            return b.name
    return None


def strip_root_drift(arm, act, tbl):
    """把动作里**根骨骼的位移漂移**削掉，让它变成严格的原地循环。

    返回 (fix, info)：
        fix  = [(bone, prop, idx, t0, t1, drift)]，交给 apply_pose 逐帧扣掉
        info = [(bone, idx, drift)]，只用来打日志

    【这是"走一段就闪回一次"的根因修复】
        Mixamo 下载时没勾 In Place，Walking 的髋部在一个循环里会真实前移
        约一个步幅。apply_pose 每帧照抄这条曲线，而播放时 t_sec 要 % 循环长度
        —— 每到循环末尾髋部就跳回起点，人看起来"走一段就闪回一次"。
        仿真层单帧位移上限只有 4.8 cm，米级的回跳不可能来自摆位，只能来自这里。

    做法不是删曲线（删了 pose bone 会残留上一帧的值），而是**去掉线性漂移**：
        v'(t) = v(t) - drift * (t - t0) / (t1 - t0)
    这样 v'(t0) == v'(t1)，循环首尾严丝合缝；周期性的摆动与上下起伏全部保留。
    """
    bone = root_bone_of(arm)
    if bone is None:
        return [], []
    t0, t1 = act.frame_range
    fix, info = [], []
    for (bn, prop), idxs in tbl.items():
        if bn != bone or prop != "location":
            continue
        for idx, fc in sorted(idxs.items()):
            drift = fc.evaluate(t1) - fc.evaluate(t0)
            if abs(drift) < 1e-6:
                continue
            fix.append((bn, prop, idx, t0, t1, drift))
            info.append((bn, idx, drift))
    return fix, info


def iter_fcurves(act):
    """把 action 里的 F-curve 全捞出来。

    Blender 4.4 起 Action 改成了「分层 + slot」结构，**`Action.fcurves` 没有了**，
    曲线藏在 `action.layers[i].strips[j].channelbags[k].fcurves` 里。
    这里两套 API 都兼容（实测 Blender 5.2 上 Walk 有 1 个 layer、1 个 KEYFRAME strip、
    4 个 channelbag，每个 channelbag 490 条曲线，首条是 pose.bones["mixamorig:Hips"].location）。
    """
    fcs = getattr(act, "fcurves", None)
    if fcs is not None:
        return list(fcs)
    out = []
    for lay in getattr(act, "layers", []):
        for st in lay.strips:
            try:
                cbs = list(st.channelbags)
            except Exception:
                cbs = []
            for cb in cbs:
                out.extend(cb.fcurves)
    return out


def pose_table(act):
    """把 action 的 F-curve 按 (骨骼, 属性) 归拢，之后按时间求值。"""
    tbl = {}
    for fc in iter_fcurves(act):
        m = re.match(r'pose\.bones\["([^"]+)"\]\.(\w+)', fc.data_path)
        if not m:
            continue
        key = (m.group(1), m.group(2))
        tbl.setdefault(key, {})[fc.array_index] = fc
    return tbl


def apply_pose(arm, tbl, t_frames, fps, root_fix=None):
    """把 action 在 t_frames 帧处的姿势写进 pose bone。

    root_fix：由 strip_root_drift() 算出的根骨骼线性漂移，逐帧按线性比例扣掉。
    注意**必须在写完所有曲线之后**再扣（否则会被后面的 setattr 覆盖回去）。
    """
    for (bone, prop), idxs in tbl.items():
        pb = arm.pose.bones.get(bone)
        if pb is None:
            continue
        if prop.startswith("rotation_") and pb.rotation_mode != "QUATERNION" and \
                prop == "rotation_quaternion":
            pb.rotation_mode = "QUATERNION"
        cur = getattr(pb, prop, None)
        if cur is None:
            continue
        try:
            n = len(cur)
        except TypeError:
            continue
        vals = list(cur)
        for i in range(n):
            fc = idxs.get(i)
            if fc is not None:
                vals[i] = fc.evaluate(t_frames)
        setattr(pb, prop, vals)
    for (bone, prop, idx, t0, t1, drift) in (root_fix or ()):
        pb = arm.pose.bones.get(bone)
        if pb is None:
            continue
        cur = getattr(pb, prop, None)
        if cur is None:
            continue
        vals = list(cur)
        if not (0 <= idx < len(vals)):
            continue
        span = (t1 - t0) or 1.0
        vals[idx] = vals[idx] - drift * ((t_frames - t0) / span)
        setattr(pb, prop, vals)


def build_ground(scene, size=600.0):
    """空地。用淡棋盘格而不是纯色 —— 走路有没有位移，一眼就能看出来。"""
    me = bpy.data.meshes.new("ground")
    s = size * 0.5
    me.from_pydata([(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0)],
                   [], [(0, 1, 2, 3)])
    me.update()
    o = bpy.data.objects.new("ground", me)
    scene.collection.objects.link(o)
    m = bpy.data.materials.new("ground_mat")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    ck = nt.nodes.new("ShaderNodeTexChecker")
    ck.inputs["Color1"].default_value = (0.32, 0.33, 0.34, 1.0)
    ck.inputs["Color2"].default_value = (0.40, 0.41, 0.42, 1.0)
    ck.inputs["Scale"].default_value = 300.0       # 一格约 2 m（平面 600 m）
    nt.links.new(ck.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.92
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    me.materials.append(m)
    return o


def setup_light_world(scene):
    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("sun", type="SUN")
    ld.energy = 2.6
    ld.angle = math.radians(2.0)
    ld.color = (1.0, 0.94, 0.84)
    sun = bpy.data.objects.new("sun", ld)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(48), 0.0, math.radians(35))

    w = bpy.data.worlds.new("w")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = None
    for n in nt.nodes:
        if n.type == "BACKGROUND":
            bg = n
            break
    if bg is None:
        bg = nt.nodes.new("ShaderNodeBackground")
        o = None
        for n in nt.nodes:
            if n.type == "OUTPUT_WORLD":
                o = n
                break
        if o is not None:
            nt.links.new(bg.outputs["Background"], o.inputs["Surface"])
    bg.inputs[0].default_value = (0.46, 0.58, 0.80, 1.0)
    bg.inputs[1].default_value = 0.50


def setup_render(scene, opt, video=False):
    r = scene.render
    log("setup_render 收到的分辨率参数：width=%s height=%s（video=%s）"
        % (opt.get("width"), opt.get("height"), video))
    r.resolution_x = opt["width"]
    r.resolution_y = opt["height"]
    r.resolution_percentage = 100
    r.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    if video:
        # 【坑】Blender 4.5+ 把视频格式藏在 image_settings.media_type 后面：
        # media_type 还是 IMAGE（默认）时，file_format 的枚举里**根本没有 FFMPEG**，
        # 直接赋值会报 `enum "FFMPEG" not found in ('AVIF', 'JPEG', ...)`。
        # 实测：先设 media_type="VIDEO"，file_format 才会多出 OPEN_EXR_MULTILAYER
        # 和 FFMPEG 两项。这是 4.5 新增的媒体类型门控。
        if hasattr(r.image_settings, "media_type"):
            r.image_settings.media_type = "VIDEO"
        r.image_settings.file_format = "FFMPEG"
        r.ffmpeg.format = "MPEG4"
        r.ffmpeg.codec = "H264"
        r.ffmpeg.constant_rate_factor = "HIGH"
        r.ffmpeg.ffmpeg_preset = "GOOD"
    else:
        if hasattr(r.image_settings, "media_type"):
            r.image_settings.media_type = "IMAGE"
        r.image_settings.file_format = "PNG"
        r.image_settings.color_mode = "RGB"
    # EEVEE 采样数。实测城市街面 32 采样 17.9 s/帧（稳态），默认 64 会几乎翻倍，
    # 而街面构图看不出差别 —— 这个数必须能调，否则 120 帧的账算不过来。
    ee = getattr(scene, "eevee", None)
    if ee is not None and hasattr(ee, "taa_render_samples"):
        ee.taa_render_samples = opt.get("samples", 32)
    if opt.get("no_rt") and ee is not None:
        for attr in ("use_raytracing", "use_ray_tracing"):
            if hasattr(ee, attr):
                setattr(ee, attr, False)
                log("已关闭 EEVEE 光追：scene.eevee.%s=False" % attr)
                break
        else:
            log("!! 这个 Blender 版本的 eevee 没有 use_raytracing 属性，--no-rt 无效")


def place_camera(scene, cx, cy, span, height):
    cd = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    dist = max(span * 2.2, 8.0)
    loc = Vector((cx + dist * 0.55, cy - dist * 0.95, height * 2.6))
    tgt = Vector((cx, cy, height * 0.45))
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
    cd.lens = 42.0
    cd.sensor_width = 36.0
    cd.clip_start = 0.1
    cd.clip_end = 5000.0
    return cam


def place_camera_at(scene, loc, tgt, lens):
    """按给定的世界坐标架一台相机（城市街面机位用，位置由 ped_nav 的走廊几何算出来）。"""
    cd = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    p = Vector(loc)
    t = Vector(tgt)
    cam.location = p
    cam.rotation_euler = (t - p).to_track_quat("-Z", "Y").to_euler()
    cd.lens = lens
    cd.sensor_width = 36.0
    cd.clip_start = 0.05
    cd.clip_end = 8000.0
    return cam


def track_camera(cam, x, y, heading, side=3.8, back=4.2, height=2.05):
    """单人展示用的跟随镜头：站在行人右后侧、2 m 高，视线落在胸口。

    为什么必须跟拍：静态机位要框住整条 12 m 的行走路线时，人在画面里只占
    5%（实测就是这个结果），观众根本看不清走姿和状态切换。

    side/back 的比例决定观感：纯侧面看得清步态但人在画面里横穿；纯后面看不到
    步态。现在的 3.8:4.2 是两者折中（实测能同时看清步态和行进方向）。
    target 抬到 1.30 m 是为了把俯角压下来，否则上半幅全是空地。

    传 x/y/heading 而不是传 agent，是因为出帧时要用**预先算好的轨迹**，
    不能用 world 里已经走到最后一帧的 agent。
    """
    h = heading
    fx, fy = math.cos(h), math.sin(h)
    px, py = fy, -fx                       # 右手法向 = "保持右侧"
    loc = Vector((x + px * side - fx * back, y + py * side - fy * back, height))
    tgt = Vector((x + fx * 2.2, y + fy * 2.2, 1.30))
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 48.0


# ---------------------------------------------------------------- 复制出 N 个人
def make_instances(scene, arm, char_meshes, n):
    """复制出 N 个人。

    为什么必须复制**全部**角色网格，而不是只复制主身体：
        这个 Mixamo 角色是 7 个网格（Body / Bottoms / Eyes / Eyelashes /
        Hair / Shoes / Tops）。只复制第 1 个的话，另外 6 个仍然挂在原始骨骼上，
        于是 10 个人里 9 个**没有头发、没有眼睛、没有鞋** —— 10 人片子里一眼可见。
        所以按"每个实例复制整份网格列表"来做。

    仍然共享 mesh DATA（b.data = src.data），只复制物体壳子：
        场景已经 48,381 个物体，真复制网格数据会翻倍占内存，而 10 个人本来就
        共用同一份身体网格。
    """
    out = []
    for i in range(n):
        if i == 0:
            a = arm
        else:
            a = arm.copy()                       # 共享 armature DATA（省内存）
            a.animation_data_clear()
            a.animation_data_create()
            a.animation_data.action = None
            scene.collection.objects.link(a)
        pairs = []
        for src in char_meshes:
            if i == 0:
                b = src
            else:
                b = src.copy()
                b.data = src.data                # 共享网格数据，不真复制
                scene.collection.objects.link(b)
                b.parent = a
                b.parent_type = src.parent_type
                b.matrix_parent_inverse = src.matrix_parent_inverse.copy()
            # 每个实例的骨骼修改器指向**自己**的骨骼，否则 10 个人会全部
            # 跟着第 1 个人的姿势动（这是同类 bug 里最隐蔽的一种）。
            for md in b.modifiers:
                if md.type == "ARMATURE":
                    md.object = a
            pairs.append(b)
        a.location = (0.0, 0.0, 0.0)
        a.rotation_euler = (0.0, 0.0, 0.0)
        out.append((a, pairs))
    return out


# ---------------------------------------------------------------- 主流程
def main(opt):
    outdir = os.path.abspath(opt["outdir"])
    os.makedirs(outdir, exist_ok=True)
    fps = opt["fps"]
    model = find_model(opt["model"])
    log("角色 = %s" % model)

    # 【顺序铁律】open_mainfile 会把整个场景换掉，必须在 import_character **之前**。
    # 反过来做的话，人的骨骼会被开文件冲掉，然后在 Set 那里报 "无此物体"。
    if opt["city"]:
        city = os.path.abspath(opt["city"])
        if not os.path.exists(city):
            raise SystemExit("找不到城市文件：%s" % city)
        bpy.ops.wm.open_mainfile(filepath=city)
        scene = bpy.context.scene
        log("已载入城市：%s（物体 %d）" % (city, len(bpy.data.objects)))
    else:
        clean_scene()
        scene = bpy.context.scene
    global TARGET_H
    TARGET_H = opt["target_h"]
    arm, body, meshes = import_character(model)
    if opt["clips"]:
        acts = load_clip_files(opt["clips"], fps)
    else:
        acts = collect_clips(arm, meshes)

    # ---- 接线：一个状态一段**专属**动作 ----
    clip_of = {}
    missing = []
    logged = set()
    for st in F.ALL_STATES:
        n, a, exact = pick_clip(acts, st)
        # 【顺序铁律】必须先试降级、再判"一点动作都没有"。
        # 之前把 `if a is None: raise` 写在降级之前，于是 Yield/Look 这种
        # 本来该走"占位降级"的状态直接报"一个动作都没找到" —— 结果是
        # --allow-placeholder 这条路径从来没被执行过，闸门的负测试也就成了假阳性。
        if not exact:
            fb = FALLBACK_STATE.get(st)
            fn, fa, _fe = pick_clip(acts, fb) if fb is not None else (None, None, False)
            if fa is None:
                raise SystemExit(
                    "状态 %s 没有专属动作，也没有可降级的动作；--clips 传对了吗？" % st)
            n, a = fn, fa
            missing.append(st)
        if a is None:
            raise SystemExit("状态 %s 取不到任何动作；--clips 传对了吗？" % st)
        tbl = pose_table(a)
        secs = clip_seconds(a, fps)
        rootfix = []
        drift_m = 0.0
        if not opt["keep_root_motion"]:
            rootfix, info = strip_root_drift(arm, a, tbl)
            # 位移曲线是骨骼局部量，乘上 armature 物体缩放才是世界米（旋转不改变长度）
            drift_m = math.sqrt(sum((v * arm.scale[0]) ** 2 for _b, _i, v in info))
            if a.name not in logged:          # 同一个 action 被多个状态引用时只报一次
                logged.add(a.name)
                d = describe_action(a)
                log("动作 %-16s 曲线 %4d  layer %d  strip %d  channelbag %d  重复键 %d"
                    % (a.name, d["curves"], d["layers"], d["strips"],
                       d["channelbags"], d["dupes"]))
                if d["dupes"]:
                    log("  !! 该动作有 %d 条重复键，(骨骼,属性) 归拢会丢曲线 ——"
                        " 检查 channelbag 是不是跨 slot" % d["dupes"])
                if info:
                    big = [(bn, idx, dr) for bn, idx, dr in info
                           if abs(dr) * arm.scale[0] >= 0.001]
                    for bn, idx, drift in big:
                        log("  根骨骼 %s.location[%d] 一个循环漂移 %.1f cm"
                            "（世界 %.3f m）-> 已削成原地循环"
                            % (bn, idx, drift, abs(drift) * arm.scale[0]))
                    if not big:
                        log("  根骨骼位移漂移：只有亚毫米级抖动，视为原地循环")
                else:
                    log("  根骨骼位移漂移：无（该动作本来就是原地循环）")
        clip_of[st] = (n, a, tbl, secs, rootfix, drift_m)
    for st in F.ALL_STATES:
        n, a, _t, d, _rf, _dm = clip_of[st]
        mark = ("   <<< 占位：无专属动作，临时用 %s 顶（候选 %s）"
                % (n, CLIP_CANDIDATES[st][:3])) if st in missing else ""
        log("状态 %-6s -> 动作 %-16s 时长 %6.2f s%s" % (st, n, d, mark))
    log("[动作覆盖] %d 个状态：专属动作 %d 个，占位 %s"
        % (len(F.ALL_STATES), len(F.ALL_STATES) - len(missing),
           [s for s in missing] if missing else "无"))
    if missing and not opt["allow_placeholder"]:
        raise SystemExit(
            "缺少 %s 的专属动作，**拒绝出片**。\n"
            "  理由：导师明确要的是「主动地在一些动作之间切换」，一个状态一段动作\n"
            "  是计划表 §二 的硬要求；拿站立动作冒充 Yield/Look，交出去的片子会在\n"
            "  画面上变成「走走停停」，等于把这条要求只兑现了一半。\n"
            "  确实要出「验证片」就显式加 --allow-placeholder"
            "（命令里留痕，日志里把该状态标成占位）。"
            % [str(s) for s in missing])

    # 行走速度**必须**和动作自带的根位移对上，否则脚在地上滑。
    # 【口径纠正】以前是查 STRIDE_M 表（作者按"两步 1.5 m"估的）。实测走路动作
    # 自带根位移 **1.960 m/循环 ÷ 1.29 s = 1.52 m/s**，表里写 1.5 m 是低估了 24%。
    # 现在优先用动作自己反推；削掉根运动之后，只有按这个速度推进脚才不打滑。
    wkname, _wka, _t, wkd, _wrf, wkdrift = clip_of[F.ST_WALK]
    if wkdrift > 0.05:
        walk_speed = wkdrift / wkd
        log("行走速度 = %.3f m/s ← 由 Walk 动作自带根位移反推（%.3f m/循环 ÷ %.2f s）；"
            "查表猜的是 %.2f m/s"
            % (walk_speed, wkdrift, wkd, STRIDE_M.get(wkname, 1.5) / wkd))
    else:
        walk_speed = STRIDE_M.get(wkname, 1.5) / wkd
        log("行走速度 = %.3f m/s（动作无根位移，按步幅表 %s 反推）"
            % (walk_speed, STRIDE_M.get(wkname, 1.5)))

    if not opt["city"]:
        build_ground(scene)
        setup_light_world(scene)
    else:
        # 城市场景自带地面网格、太阳光和世界背景（实测那套的光照已经能用，
        # 探针渲出来的街面图就是这么来的）。**不要**在这里再铺一层棋盘地面，
        # 也不要把城市的灯光删掉重设 —— 那样会把已经调好的贴图观感推翻。
        log("沿用城市场景自带的灯光/世界/地面")
    # 【坑】这一行以前只在出视频的分支里调用，于是 --mode png 时：
    #   分辨率用的是 Blender 出厂默认的 1920x1080（--size 被完全忽略），
    #   色彩管理也是默认的 AgX 而不是 Standard。渲染设置在出帧**之前**就得落实。
    setup_render(scene, opt)

    # ---- 建仿真：两条路，城市模式走真路网，空地模式（Day 1 的老路径）走巡查点
    cfg = F.Config()
    if opt["arrive"] is not None:
        cfg.arrive_m = opt["arrive"]
    if opt["yield_gap"] is not None:
        cfg.yield_gap_m = opt["yield_gap"]
    if opt["yield_hold"] is not None:
        cfg.yield_hold_s = opt["yield_hold"]
    world = S.World(cfg=cfg, seed=opt["seed"], walk_speed=walk_speed,
                    yield_max_s=(opt["yield_max"] if opt["yield_max"] is not None else 4.0),
                    dodge_m=(opt["dodge"] if opt["dodge"] is not None else 0.9),
                    dodge_speed=(opt["dodgespd"] if opt["dodgespd"] is not None else 0.8),
                    gap_half_angle=(opt["cone"] if opt["cone"] is not None else 45.0))
    n = opt["people"]

    # ---- 子相位动作接线（理由见 SUB_CANDIDATES 上方注释）----
    # clip_list 是"这一帧该播哪段动作"的唯一来源：前 4 项按 F.ALL_STATES 的顺序
    # 对应 4 个状态，后面追加子相位动作。trace 里存的是**下标**而不是状态名，
    # 所以"同一个状态播不同动作"完全不需要动状态机 —— ped_fsm.py 一行没改。
    clip_list = [clip_of[st] for st in F.ALL_STATES]
    SI = {st: i for i, st in enumerate(F.ALL_STATES)}
    SUB = {}
    for _key in sorted(SUB_CANDIDATES):
        _n2, _a2, _e2 = pick_clip(acts, _key, SUB_CANDIDATES[_key])
        if _a2 is None:
            log("子相位 %-11s 没有对应动作（候选 %s）-> 该子相位退回主动作"
                % (_key, SUB_CANDIDATES[_key][:3]))
            continue
        _tbl2 = pose_table(_a2)
        _secs2 = clip_seconds(_a2, fps)
        _rf2, _info2 = ([], [])
        _drift2 = 0.0
        if not opt["keep_root_motion"]:
            _rf2, _info2 = strip_root_drift(arm, _a2, _tbl2)
            _drift2 = math.sqrt(sum((v * arm.scale[0]) ** 2 for _b, _i, v in _info2))
        clip_list.append((_n2, _a2, _tbl2, _secs2, _rf2, _drift2))
        SUB[_key] = len(clip_list) - 1
        log("子相位 %-11s -> 动作 %-16s 时长 %6.2f s  自带位移 %.3f m"
            % (_key, _n2, _secs2, _drift2))
    # 让行侧步的播放速率 = 仿真横移速度 ÷ 动作隐含速度。
    # 不配速率就是"人在横移、脚在原地迈"：实测仿真横移 1.000 m/s，
    # 而 Walk Strafe Right 隐含 0.957 m / 1.83 s = 0.523 m/s，差 1.91 倍。
    dodge_rate = 1.0
    if "yield_dodge" in SUB:
        _cse, _cmod, _ct, _csec, _crf, _cdrift = clip_list[SUB["yield_dodge"]]
        if _cdrift > 0.05 and _csec > 0.0:
            dodge_rate = world.dodge_speed / (_cdrift / _csec)
            log("让行侧步播放速率 = %.2f×（仿真横移 %.3f m/s ÷ 动作隐含 %.3f m/s）"
                % (dodge_rate, world.dodge_speed, _cdrift / _csec))

    if opt["city"]:
        NAV = load_mod("ped_nav", os.path.join(TOOLS, "ped_nav.py"))
        planner, center = NAV.build_planner(opt["cell"], seed=opt["seed"],
                                           margin=max(260.0, opt["window"] * 2.0))
        total, seq, _c = planner.find_corridor(opt["cell"])
        log("主走廊 %.1f m / %d 节点；行动窗口 %.0f m 对齐到格中心 (%.0f, %.0f)"
            % (total, len(seq), opt["window"], center[0], center[1]))
        # 【路口模式】10 个人撒在路口的 2~3 条臂上，一部分走进来、一部分穿过去。
        # 走廊模式（corridor_routes）保留着，但默认不用它 —— 它把 10 个人排在
        # **同一条人行道**上，无论怎么抖，画面里还是一列人（用户看片后的反馈：
        # "人可以从 2 个或 3 个方向过来"）。
        routes = planner.intersection_routes(n, near_xy=center,
                                            dwell=NAV.DWELL_AGENTS)
        if len(routes) < n:
            raise SystemExit("只排出 %d 条路线（要 %d 条）" % (len(routes), n))
        for i, (wp, why) in enumerate(routes[:n]):
            a = world.add("P%02d" % i, wp[0][0], wp[0][1], patrol=None)
            world.set_route(a, wp)
            # 靠近地标 = 允许状态机在 Idle 里切进 Look。观望点的人才置真。
            a.landmark = i in planner.dwell
            log("P%02d 起点 (%.1f, %.1f)  %d 个航点  %s%s"
                % (i, wp[0][0], wp[0][1], len(wp), why,
                   "  [观望点 靠近地标]" if a.landmark else ""))
        # 到达终点后：观望点的人原地站着（走 Idle->Look），其余人沿路网继续走
        world.on_arrive = planner.arrival_handler(planner.dwell)
        # 【机位推迟到轨迹算完之后再定】理由：视线目标要用**人实际走到的位置**，
        # 而不是"排人的位置"。行动窗口的中点是排人的锚点，人走完 5 秒会整体偏开，
        # 实测画面里人群偏到右侧。所以这里只记下参数，等 trace 算完取质心再架相机。
        back = opt["window"] * 0.5 + 12.0
        cam = None
    else:
        r = opt["patrol"]
        if r <= 0.0:
            r = 2.0
        pt = [(2.0 * r * math.cos(2 * math.pi * i / 8.0),
               2.0 * r * math.sin(2 * math.pi * i / 8.0)) for i in range(8)]
        for i in range(n):
            ang = 2.0 * math.pi * i / max(1, n)
            x0 = r * math.cos(ang)
            y0 = r * math.sin(ang)
            a = world.add("P%02d" % i, x0, y0,
                          patrol=[(p[0] * 0.5, p[1] * 0.5) for p in pt])
            world.set_goal(a, pt[(i + 4) % 8][0] * 0.5, pt[(i + 4) % 8][1] * 0.5)
        log("建了 %d 个人，巡查半径 %.1f m" % (n, r))

        # 相机按所有人的活动范围框一下
        xs = [a.x for a in world.agents] + [p[0] * 0.5 for p in pt]
        ys = [a.y for a in world.agents] + [p[1] * 0.5 for p in pt]
        span = max(max(xs) - min(xs), max(ys) - min(ys), 4.0)
        cam = place_camera(scene, (max(xs) + min(xs)) * 0.5, (max(ys) + min(ys)) * 0.5,
                           span, 1.75)
        log("相机 loc=(%.1f, %.1f, %.1f)" % tuple(cam.location))

    inst = make_instances(scene, arm, meshes, n)
    for i, (a, bl) in enumerate(inst):
        log("实例 %d -> %s（含网格 %d 个）" % (i, a.name, len(bl)))

    # 每个人的动画相位错开，否则 10 个人像广播体操。
    # 相位是 aid_i * 0.37 取模，纯确定性，不碰随机数。
    phase0 = {ag.aid: (ag.aid_i * 0.37) for ag in world.agents}
    # 「这个状态已经播了多久」。**只在一次性动作上归零**（RESET_ON_ENTER = Yield/Look）：
    # 走/站这类循环动作的相位必须连续。以前是无条件归零，于是每次避让完再起步，
    # 走路循环都从第 0 帧重来，脚会踢一下 —— 画面上看就是"抽一下"。
    clip_clock = {ag.aid: 0.0 for ag in world.agents}
    last_state = {ag.aid: ag.state for ag in world.agents}
    # 子相位要用的两个钟（都按人独立）：
    #   t_in_state —— 进入**当前状态**多久了。起步/停步段按它切进切出。
    #   dodge_clock —— 本次横移开始后侧步动作播了多久（按 dodge_rate 走）。
    t_in_state = {ag.aid: 0.0 for ag in world.agents}
    dodge_clock = {ag.aid: 0.0 for ag in world.agents}
    was_dodge = {ag.aid: False for ag in world.agents}

    dt = 1.0 / fps
    frames = opt["frames"] if opt["frames"] else int(round(opt["seconds"] * fps))
    log("开始出帧：%d 帧 @ %d fps = %.2f s（预跑 %.2f s）"
        % (frames, fps, frames / float(fps), opt["warm"]))
    # --warm：先空跑一段再开始记录。用来检查"走到一半"时的构图，
    # 也用来验证状态机进 Yield 之后的样子（不用渲 120 帧才发现构图不对）。
    for _ in range(int(round(opt["warm"] * fps))):
        world.step(dt)

    # ===== 先把整条仿真轨迹算完，再交给渲染 =====
    # 为什么不能边仿真边渲染：
    #   出视频用 bpy.ops.render.render(animation=True)，它只按 scene.frame 走帧，
    #   **不会**回头再跑一次我们的仿真。所以必须把"第 fi 帧每个人在哪、朝哪、
    #   播哪段动作的第几秒"预先存成 trace，再用 frame_change_pre 处理器按帧号回放。
    #   这样 PNG 逐帧渲染和 animation=True 出视频走的是同一条代码路径，不会两套行为。
    # 子相位段的长度（秒）。取值依据：起步/停步都是"过渡动作的头一小段"，
    # 0.6 s 左右刚好走过"从静止到迈出第一步"（Start Walking 全长 3.67 s，
    # 后面那两秒是持续加速，走起来就该交给 Walking 循环了）。
    START_WALK_S = 0.62
    STOP_WALK_S = 0.55
    trace = []
    use_tally = {}
    for fi in range(frames):
        world.step(dt)
        snap = []
        for ag in world.agents:
            st = ag.state
            if last_state[ag.aid] != st:
                if st in RESET_ON_ENTER:      # 只有一次性动作才从头播
                    clip_clock[ag.aid] = 0.0
                last_state[ag.aid] = st
                t_in_state[ag.aid] = 0.0
            ci = SI[st]
            ts = t_in_state[ag.aid]
            if st == F.ST_WALK and "walk_start" in SUB and ts < START_WALK_S:
                ci = SUB["walk_start"]        # 起步段：站立 -> 迈步，从头播
                t_sec = ts
            elif (st == F.ST_YIELD and ag.dodge_sgn != 0
                  and ag.dodge_done < world.dodge_m):
                if not was_dodge[ag.aid]:
                    dodge_clock[ag.aid] = 0.0     # 刚开始横移 -> 侧步从头播
                    was_dodge[ag.aid] = True
                if "yield_dodge" in SUB:
                    ci = SUB["yield_dodge"]
                    t_sec = dodge_clock[ag.aid] % clip_list[ci][3]
                    dodge_clock[ag.aid] += dt * dodge_rate
                else:
                    t_sec = (clip_clock[ag.aid] + phase0[ag.aid]) % clip_list[ci][3]
            elif st == F.ST_YIELD and "walk_stop" in SUB and ts < STOP_WALK_S:
                ci = SUB["walk_stop"]         # 停步段：迈步 -> 站定，从头播
                t_sec = ts
            elif st == F.ST_YIELD and "yield_stall" in SUB:
                # 僵持段（以及绕完续走那段）：实测位移 0.00~0.01 m/s，就是站着。
                # 这一段绝对不能播侧步 —— 否则人站着不动却在原地迈腿。
                was_dodge[ag.aid] = False
                ci = SUB["yield_stall"]
                t_sec = (clip_clock[ag.aid] + phase0[ag.aid]) % clip_list[ci][3]
            else:
                was_dodge[ag.aid] = False
                # 循环播放：把时间折回 clip 长度内
                t_sec = (clip_clock[ag.aid] + phase0[ag.aid]) % clip_list[ci][3]
            nm = clip_list[ci][0]
            use_tally[(st, nm)] = use_tally.get((st, nm), 0) + 1
            snap.append((ag.aid, ag.x, ag.y, ag.heading, st, t_sec, ci))
            clip_clock[ag.aid] += dt
            t_in_state[ag.aid] += dt
        trace.append(snap)
    # 动作使用次数：从**这一帧该播哪段动作**直接数出来，写进渲染日志。
    # 为什么必须数：接线表里"接上了"和"真的播到了"是两件事 —— 子相位段如果
    # 时间窗写错（比如起步段比状态还长），表上看着接好了，画面上一次都不出现。
    _tot = float(sum(use_tally.values())) or 1.0
    log("动作使用：%d 种 / %d 状态 × 动作组合" % (
        len(set(k[1] for k in use_tally)), len(use_tally)))
    for (st, nm), c in sorted(use_tally.items()):
        log("   %-6s %-18s %6d 帧 %5.1f%%" % (st, nm, c, 100.0 * c / _tot))

    # ---- 城市机位：用整段仿真的质心做视线目标（不需要新素材就能改进构图）----
    if opt["city"]:
        xs = [s[1] for snap in trace for s in snap]
        ys = [s[2] for snap in trace for s in snap]
        aim = (sum(xs) / len(xs), sum(ys) / len(ys))
        loc, tgt, lens = planner.camera_hint(back=back, side=None, height=1.65,
                                             lens=32.0, aim_xy=aim,
                                             anchor_arc=2.0 * back)
        cam = place_camera_at(scene, loc, tgt, lens)
        _sgn, _dist = getattr(planner, "street_measured", (None, 0.0))
        log("城市机位 loc=(%.1f, %.1f, %.1f) 看向 (%.1f, %.1f, %.1f) 焦距 %.0f；"
            "视线对准 %d 帧 × %d 人的质心 (%.1f, %.1f)；"
            "人行道到马路中心线 %.1f m（侧向符号 %s）"
            % (loc[0], loc[1], loc[2], tgt[0], tgt[1], tgt[2], lens,
               len(trace), n, aim[0], aim[1], _dist, _sgn))

    csv = open(os.path.join(outdir, "states.csv"), "w", encoding="utf-8")
    # clip 这一列是给验收用的：把"这段动作真的播到了"变成**交付物里能数出来的数**，
    # 而不是靠渲染日志自证。位置/状态列保持原样，老脚本按列名读就不会碎。
    csv.write("t,frame,aid,state,clip,x,y,heading\n")
    for fi, snap in enumerate(trace):
        for aid, x, y, hd, st, _t, ci in snap:
            csv.write("%.3f,%d,%s,%s,%s,%.3f,%.3f,%.3f\n"
                      % (fi * dt, fi + 1, aid, st, clip_list[ci][0], x, y, hd))
    csv.close()
    log("轨迹算完：%d 帧，状态日志 -> states.csv" % len(trace))

    # 【关键】把本次出片的**全部仿真参数**写进产物目录。
    # 为什么必须写：验收方（verify_ped_nav.py）如果不拿到这些数，就只能猜 ——
    # 实测踩过：验收脚本把步速写成常数 1.16，而出片用的是 1.5/1.29=1.16129…，
    # 0.1% 的差在 4.5 m 后就让 917/1200 行对不上，且看起来像"两套行为"。
    # 交付物自带参数，验收才不会退化成猜谜。
    meta = dict(
        src_city=opt["city"], model=os.path.abspath(model), cell=opt["cell"],
        seed=opt["seed"], people=n, frames=frames, fps=fps,
        seconds=frames / float(fps), width=opt["width"], height=opt["height"],
        mode=opt["mode"], samples=opt["samples"], z_floor=opt["z_floor"],
        # no_rt 必须记进来：它决定这份产物能不能被"逐帧复现"（见交接单 §2.4 复现性口径）。
        # 给 Day 3 用；Day-2 那一轮的 params.json 是加这个字段之前生成的。
        no_rt=bool(opt.get("no_rt")),
        walk_speed=walk_speed,
        sim=dict(arrive_m=cfg.arrive_m, yield_gap_m=cfg.yield_gap_m,
                 yield_hold_s=cfg.yield_hold_s, idle_decide_s=cfg.idle_decide_s,
                 yield_max_s=world.yield_max_s, dodge_m=world.dodge_m,
                 dodge_speed=world.dodge_speed,
                 gap_half_angle=world.gap_half_angle,
                 gap_radius=world.gap_radius),
    )
    if opt["city"]:
        meta["window"] = opt["window"]
        meta["corridor_total_m"] = round(total, 3)
        meta["camera"] = dict(loc=[round(v, 4) for v in loc],
                              tgt=[round(v, 4) for v in tgt], lens=lens)
        meta["routes"] = [dict(start=[round(wp[0][0], 4), round(wp[0][1], 4)],
                               n_waypoints=len(wp)) for wp, _wy in routes[:n]]
    with open(os.path.join(outdir, "params.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1, sort_keys=True)
    log("出片参数 -> params.json（验收脚本读它，不再猜常数）")

    def apply_frame(fi):
        if fi < 0 or fi >= len(trace):
            return
        def _place(ar, x, y, hd):
            """摆一个人：位置 + 朝向。

            【铁律】FBX 的 Y-up -> Z-up 转换是靠 armature **物体**上的一圈 X 旋转做的。
            出帧时若直接写 rotation_euler=(0,0,heading)，就把那圈 X 旋转抹掉了，
            角色会**平躺着滑行**（实测世界高度从 1.93 m 变 0.98 m，肉眼像"塌陷"）。
            所以只允许在导入时的原始旋转基础上叠加 heading。
            """
            br = tuple(ar["base_rot"]) if "base_rot" in ar.keys() else (0.0, 0.0, 0.0)
            bl = tuple(ar["base_loc"]) if "base_loc" in ar.keys() else (0.0, 0.0, 0.0)
            # 城市模式必须抬 z_floor：路面/人行道带的控制点世界 Z 实测恒为 0.3
            # （地面网格在 0.0），不抬的话人的脚会陷进人行道 30 cm —— 穿模一眼可见。
            ar.location = (x + bl[0], y + bl[1], bl[2] + opt["z_floor"])
            ar.rotation_euler = (br[0], br[1], br[2] + hd + FACING_OFFSET)

        for k, (_aid, x, y, hd, st, t_sec, ci) in enumerate(trace[fi]):
            ar = inst[k][0]
            _place(ar, x, y, hd)
            if opt["pose"] == "none":
                # 诊断用：不套任何动作，只看 rest 姿势下骨皮形变有没有问题
                continue
            if opt["pose"] == "native":
                # 诊断用：把动作直接挂到骨骼上，姿势交给 Blender 自己的动画系统求值
                # （场景帧就是 clip 帧）。用来判定"手工写 pose bone"是不是错的。
                if getattr(ar.animation_data, "action", None) is None:
                    ar.animation_data_create()
                    ar.animation_data.action = clip_list[ci][1]
                    log("[demo] native 模式：%s 挂上动作 %s（帧 %s）"
                        % (ar.name, clip_list[ci][1].name,
                           tuple(round(v, 1) for v in clip_list[ci][1].frame_range)))
                continue
            _n, act, tbl, _d, rootfix, _dm = clip_list[ci]
            apply_pose(ar, tbl, act.frame_range[0] + t_sec * fps, fps, rootfix)
        if opt["cam"] == "track" and trace[fi]:
            _aid0, x0, y0, hd0, _s0, _t0, _c0 = trace[fi][0]
            track_camera(cam, x0, y0, hd0)

    def on_frame_change(scene, depsgraph=None):
        apply_frame(scene.frame_current - 1)

    bpy.app.handlers.frame_change_pre.append(on_frame_change)

    for fi in range(frames):
        # frame_set 会触发上面的 handler -> apply_frame(fi)，所以这里只负责出图
        scene.frame_set(fi + 1)
        if fi == 0:
            # 诊断：**变形后**的角色世界高度。注意 o.bound_box 只反映 rest 网格，
            # 量不出骨骼变形后的实际大小，必须走 evaluated depsgraph。
            # 只统计有顶点组的网格（把 600 m 的地面排除掉）。
            dg = bpy.context.evaluated_depsgraph_get()
            zs = []
            for o in bpy.data.objects:
                if o.type != "MESH" or len(o.vertex_groups) == 0:
                    continue
                ev = o.evaluated_get(dg)
                try:
                    me = ev.to_mesh()
                except Exception:
                    continue
                mw = ev.matrix_world
                for v in me.vertices:
                    zs.append((mw @ v.co).z)
                ev.to_mesh_clear()
            if zs:
                log("[diag] 第1帧变形后角色：世界高度 %.2f m（z %.2f ~ %.2f）"
                    % (max(zs) - min(zs), min(zs), max(zs)))
            # 逐网格分解：塌陷到底是哪一个网格、哪个缩放的问题，一眼看出来
            for o in list(bpy.data.objects):
                if o.type != "MESH" or len(o.vertex_groups) == 0:
                    continue
                ev = o.evaluated_get(dg)
                try:
                    me = ev.to_mesh()
                except Exception:
                    continue
                mw = ev.matrix_world
                mzs = [(mw @ v.co).z for v in me.vertices]
                # 未加权顶点数：骨皮形变里，权重和接近 0 的顶点会被拉到骨骼原点，
                # 整块网格就会塌成一个贴着地面的大约 0.5 m 的小团 —— 这正是实测症状。
                bad = 0
                for v in o.data.vertices:
                    if sum(g.weight for g in v.groups) < 0.35:
                        bad += 1
                if mzs:
                    log("[diag]   网格 %-10s z %6.2f ~ %6.2f  世界缩放 %s  顶点 %d  未加权 %d"
                        % (o.name, min(mzs), max(mzs),
                           tuple(round(v, 5) for v in mw.to_scale()), len(mzs), bad))
                ev.to_mesh_clear()
            log("[diag] 每种材质槽/顶点组的抽样：%s"
                % [(o.name, [g.name for g in o.vertex_groups[:3]], len(o.vertex_groups))
                   for o in bpy.data.objects
                   if o.type == "MESH" and len(o.vertex_groups)][:4])
            log("[diag] 骨骼 pose_position=%s  骨骼缩放=%s"
                % (arm.data.pose_position, tuple(round(v, 5) for v in arm.scale)))
            log("[diag] 第1帧 相机 loc=(%.2f, %.2f, %.2f)  出图 %dx%d"
                % (cam.location.x, cam.location.y, cam.location.z,
                   scene.render.resolution_x, scene.render.resolution_y))
        if opt["mode"] in ("png", "both"):
            scene.render.filepath = os.path.join(outdir, "frames", "f%04d.png" % (fi + 1))
            bpy.ops.render.render(write_still=True)
        if fi % fps == 0:
            log("  %d/%d 帧" % (fi + 1, frames))

    if opt["mode"] in ("video", "both"):
        setup_render(scene, opt, video=True)
        scene.frame_start = 1
        scene.frame_end = frames
        scene.render.filepath = os.path.join(outdir, "demo")
        log("开始出视频 ...")
        bpy.ops.render.render(animation=True)
        got = [f for f in os.listdir(outdir) if f.lower().endswith(".mp4")]
        log("视频文件：%s" % got)

    log("统计：%s" % world.stats())
    log("完成 -> %s" % outdir)


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    o = parse_args(argv)
    if o["outdir"] is None:
        print(__doc__)
        sys.exit(1)
    main(o)
