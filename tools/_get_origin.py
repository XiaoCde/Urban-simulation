import bpy
bpy.ops.wm.open_mainfile(filepath=r"out\dc_real3_clean.blend")
sc=bpy.context.scene
for k in ("lat","lon","heading","zoom"):
    print("[scene]",k,"=",sc.get(k))
print("[unit] scale_length", sc.unit_settings.scale_length)
print("[objects]", len(bpy.data.objects))
