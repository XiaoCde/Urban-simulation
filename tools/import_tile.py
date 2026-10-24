# -*- coding: utf-8 -*-
"""在 Blender 里导入**一个** .osm 块，记录耗时 / 内存峰值 / 建筑数，并保存 .blend。

由 run_grid.py 逐块调用（每块一个干净 Blender 进程，保证测的是"这一块"的成本）。

用法（必须由 blender 执行）:
    blender.exe --background --python import_tile.py -- <tile.osm> <out.blend>
"""
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

import addon_utils
import bpy

CACHE = r"D:\Users\asus\Desktop\项目\data\blosm_cache"


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t)]


def mem_mb():
    """当前进程工作集 + 峰值（MB）。

    坑: 不要用 ctypes.windll.psapi —— 该 DLL 名在新版 Windows 上可能加载失败，
    而且必须检查返回值，否则失败时静默返回全 0（第一版就是这样，测出 peakRAM=0）。
    正确做法: kernel32!K32GetProcessMemoryInfo（Win7+ 可用），并检查返回值。
    """
    c = PROCESS_MEMORY_COUNTERS()
    c.cb = ctypes.sizeof(c)
    fn = ctypes.windll.kernel32.K32GetProcessMemoryInfo
    fn.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wt.DWORD]
    fn.restype = wt.BOOL
    ok = fn(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    if not ok:
        raise OSError("K32GetProcessMemoryInfo 失败, GetLastError=%d"
                      % ctypes.windll.kernel32.GetLastError())
    return c.WorkingSetSize / 1048576, c.PeakWorkingSetSize / 1048576


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    src, out = argv[0], argv[1]

    m0, _ = mem_mb()
    t0 = time.time()

    addon_utils.enable("blosm")
    prefs = bpy.context.preferences.addons["blosm"].preferences
    prefs.dataDir = CACHE
    prefs.assetsDir = ""

    a = bpy.context.scene.blosm
    a.dataType = "osm"
    a.osmSource = "file"
    a.osmFilepath = src
    a.mode = "3Dsimple"
    a.buildings = True
    a.singleObject = False
    a.relativeToInitialImport = True     # ★ 分块拼接的关键
    a.importForExport = False
    a.loadMissingMembers = False

    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name == "Cube":
            bpy.data.objects.remove(o, do_unlink=True)

    bpy.ops.blosm.import_data()
    t_import = time.time() - t0

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    curves = [o for o in bpy.data.objects if o.type == "CURVE"]
    zs = [o.dimensions.z for o in meshes]
    high = [z for z in zs if z > 2]
    faces = sum(len(o.data.polygons) for o in meshes)

    m1, peak = mem_mb()
    if out:
        bpy.ops.wm.save_as_mainfile(filepath=out)

    print("RESULT|%s|import=%.1fs|total=%.1fs|mesh=%d|curve=%d|buildings=%d"
          "|faces=%d|maxZ=%.1f|mem0=%.0f|mem1=%.0f|peak=%.0f|blend=%.1fMB"
          % (os.path.basename(src), t_import, time.time() - t0, len(meshes), len(curves),
             len(high), faces, max(zs) if zs else 0, m0, m1, peak,
             os.path.getsize(out) / 1048576 if out and os.path.exists(out) else 0))


main()
