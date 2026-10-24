# -*- coding: utf-8 -*-
import addon_utils, bpy, xml.etree.ElementTree as ET

OSM = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_250m_full.osm"
OUT = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_full.blend"

root = ET.parse(OSM).getroot()
lats = [float(n.get("lat")) for n in root if n.tag == "node"]
lons = [float(n.get("lon")) for n in root if n.tag == "node"]
print("范围: 南%.5f 西%.5f 北%.5f 东%.5f" % (min(lats), min(lons), max(lats), max(lons)))
print("尺寸: 南北 %.0f m  x  东西 %.0f m"
      % ((max(lats)-min(lats))*111000, (max(lons)-min(lons))*111000*0.756))

for o in list(bpy.data.objects):
    if o.type == "MESH" and o.name == "Cube":
        bpy.data.objects.remove(o, do_unlink=True)

addon_utils.enable("blosm")
prefs = bpy.context.preferences.addons["blosm"].preferences
prefs.dataDir = r"D:\Users\asus\Desktop\项目\data\blosm_cache"
prefs.assetsDir = ""

a = bpy.context.scene.blosm
a.dataType = "osm"; a.osmSource = "file"; a.osmFilepath = OSM
a.mode = "3Dsimple"; a.buildings = True; a.singleObject = False
a.relativeToInitialImport = False; a.importForExport = False
a.loadMissingMembers = False

print(bpy.ops.blosm.import_data())
print("=" * 90)
for o in sorted(bpy.data.objects, key=lambda x: (x.type, x.name)):
    if o.type == "MESH":
        zs = sorted(v.co.z for v in o.data.vertices)
        print("  %-44s Z=%7.2f  X=%7.1f Y=%7.1f  面=%d" % (o.name[:44], o.dimensions.z, o.dimensions.x, o.dimensions.y, len(o.data.polygons)))
    else:
        print("  [%s] %s" % (o.type, o.name))
print("mesh 物体总数:", len([o for o in bpy.data.objects if o.type == "MESH"]))
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("已保存:", OUT)
