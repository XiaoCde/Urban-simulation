# -*- coding: utf-8 -*-
r"""用本机 ControlNet 把我们的条件图渲染成照片级图像。

为什么这么做：
    我们的城市几何是对的（DCGIS 真数据），但表面长相很假（外墙没窗户、颜色非实测）。
    ControlNet 吃我们导出的深度图，几何被深度图锁死，它只能在"表面长什么样"上自由发挥，
    于是得到"几何是我们的、长相像真照片"的图 —— 这正是导师要的"看不出是仿真生成的"。

硬件前提：RTX 5060 Laptop 8 GB，所以用 SD1.5 fp16（不是 SDXL），分辨率 768x480。

用法:
    D:\citysim\venv\Scripts\python.exe tools\run_controlnet.py ^
        --cond out\conditions\cond_mall_depth.png ^
        --prompt "..." --out out\gen_mall.png
"""
import argparse
import os
import sys
import time

WS = r"D:\Users\asus\Desktop\项目"
MODELS = r"D:\citysim\models"

# 模型现在分两处放，是有原因的：
#   SD1.5（2.0 GB）在 D:\citysim\models\sd15 —— 只需读，加载不受沙箱影响。
#   ControlNet（689 MB）后半段是在工作区里续传完的 —— 因为沙箱把写权限收到
#   "只允许写工作区"，D:\citysim 已经写不进去了。所以优先找工作区里的副本。
SD15 = os.path.join(MODELS, "sd15")
CN_DEPTH = os.path.join(WS, "models", "controlnet_depth")
if not os.path.isdir(CN_DEPTH):
    CN_DEPTH = os.path.join(MODELS, "controlnet_depth")

# HF 缓存也放到工作区，避免写 D:\citysim 被沙箱拒绝
os.environ.setdefault("HF_HOME", os.path.join(WS, "models", ".hf"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cond", required=True, help="条件图（深度图）路径")
    ap.add_argument("--out", required=True, help="输出图片路径")
    ap.add_argument("--prompt", default=(
        "professional aerial photograph of Washington DC national mall, "
        "washington monument obelisk, lincoln memorial, reflecting pool, "
        "US capitol building, green lawns, mature trees, sunny clear day, "
        "realistic photo, sharp focus, high detail, drone photography"
    ))
    ap.add_argument("--negative", default=(
        "cartoon, painting, illustration, drawing, 3d render, low quality, "
        "blurry, jpeg artifacts, text, watermark, signature, dull colors"
    ))
    ap.add_argument("--steps", type=int, default=28)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--control-scale", type=float, default=1.0)
    ap.add_argument("--guidance", type=float, default=7.5)
    ap.add_argument("--width", type=int, default=768)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--all-shots", action="store_true",
                    help="对 out\\conditions 下所有 *_depth.png 各出一张")
    ap.add_argument("--sd15", default=SD15, help="SD1.5 权重目录")
    ap.add_argument("--controlnet", default=CN_DEPTH, help="ControlNet 权重目录")
    args = ap.parse_args()

    t0 = time.time()
    import torch
    from PIL import Image
    from diffusers import ControlNetModel, StableDiffusionControlNetPipeline

    print("torch %s | cuda %s | %s" % (
        torch.__version__, torch.cuda.is_available(),
        torch.cuda.get_device_name(0) if torch.cuda.is_available() else "N/A"))
    if not torch.cuda.is_available():
        print("警告：CUDA 不可用，速度会非常慢")

    print("加载 ControlNet (depth) ... %s" % args.controlnet)
    cn = ControlNetModel.from_pretrained(
        args.controlnet, torch_dtype=torch.float16, variant="fp16", local_files_only=True)
    print("加载 SD1.5 ... %s" % args.sd15)
    pipe = StableDiffusionControlNetPipeline.from_pretrained(
        args.sd15, controlnet=cn, torch_dtype=torch.float16, variant="fp16",
        safety_checker=None, requires_safety_checker=False, local_files_only=True,
    )
    pipe.set_progress_bar_config(disable=False)
    pipe.enable_attention_slicing()
    try:
        pipe.enable_vae_slicing()
    except Exception:
        pass
    if torch.cuda.is_available():
        pipe.to("cuda")
    print("模型加载完成，用时 %.0f 秒" % (time.time() - t0))

    jobs = []
    if args.all_shots:
        d = os.path.dirname(os.path.abspath(args.cond))
        for f in sorted(os.listdir(d)):
            if f.endswith("_depth.png"):
                jobs.append((os.path.join(d, f), os.path.join(d, "..", "gen_" + f.replace("_depth", ""))))
    else:
        jobs.append((args.cond, args.out))

    for cond_path, out_path in jobs:
        print("")
        print("=== 条件图 %s ===" % cond_path)
        img = Image.open(cond_path).convert("RGB").resize((args.width, args.height), Image.LANCZOS)
        gen = torch.Generator(device="cpu").manual_seed(args.seed)
        t1 = time.time()
        result = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative,
            image=img,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            controlnet_conditioning_scale=args.control_scale,
            generator=gen,
            width=args.width,
            height=args.height,
        ).images[0]
        out_path = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        result.save(out_path)
        print("  出图 %.1f 秒 -> %s" % (time.time() - t1, out_path))

    print("")
    print("全部完成，总用时 %.0f 秒" % (time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
