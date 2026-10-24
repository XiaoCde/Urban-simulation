# -*- coding: utf-8 -*-
r"""从 hf-mirror 下载本机 ControlNet 出图需要的两组权重。

为什么这么下（都是实测踩出来的）：
  * huggingface.co 直连 20 秒超时返回 0 字节 —— 走 hf-mirror.com（HTTP 200，4 线程约 1.4 MB/s）。
  * SD1.5 官方仓库整个 45 GB（含所有 .bin / .ckpt / 全精度变体），我们只要 fp16 的
    unet + text_encoder + vae + 各种 config/tokenizer，合计约 2.1 GB。
  * ControlNet 同理只要 diffusion_pytorch_model.fp16.safetensors（689 MB），
    不要 1.38 GB 的全精度版。

用法:
    D:\citysim\venv\Scripts\python.exe tools\download_models.py [--dry-run]
"""
import argparse
import os
import sys
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HOME", r"D:\citysim\cache\hf")
# hf-mirror 不提供 Xet 加速后端，强制走经典 HTTP 下载器
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODELS_ROOT = r"D:\citysim\models"

# SD1.5：只要 fp16 组件，不要 safety_checker（用 --safety_checker=None 跳过）
SD15_REPO = "stable-diffusion-v1-5/stable-diffusion-v1-5"
SD15_ALLOW = [
    "model_index.json",
    "*.txt",
    "feature_extractor/*",
    "scheduler/*",
    "tokenizer/*",
    "text_encoder/config.json",
    "text_encoder/model.fp16.safetensors",
    "unet/config.json",
    "unet/diffusion_pytorch_model.fp16.safetensors",
    "vae/config.json",
    "vae/diffusion_pytorch_model.fp16.safetensors",
]

# ControlNet：吃深度图的那一半
CN_REPO = "lllyasviel/control_v11f1p_sd15_depth"
CN_ALLOW = [
    "config.json",
    "diffusion_pytorch_model.fp16.safetensors",
]


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return "%.1f %s" % (n, u)
        n /= 1024.0
    return "%.1f TB" % n


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def show_candidates(repo, allow):
    from huggingface_hub import HfApi
    api = HfApi()
    info = api.model_info(repo, files_metadata=True)
    print("  仓库 %s 共 %d 个文件" % (repo, len(info.siblings)))
    total = 0
    import fnmatch
    picked = []
    for s in info.siblings:
        name = s.rfilename
        if any(fnmatch.fnmatch(name, p) for p in allow):
            size = s.size or 0
            total += size
            picked.append((name, size))
    for name, size in sorted(picked, key=lambda x: -x[1]):
        print("    %-60s %s" % (name, human(size)))
    print("  本次要下：%d 个文件，合计 %s" % (len(picked), human(total)))
    return total


def download(repo, allow, target):
    from huggingface_hub import snapshot_download
    print("  下载 %s -> %s" % (repo, target))
    t0 = time.time()
    snapshot_download(
        repo_id=repo,
        local_dir=target,
        allow_patterns=allow,
        max_workers=8,
    )
    dt = time.time() - t0
    size = dir_size(target)
    print("  完成：%s，耗时 %.0f 秒（平均 %.0f KB/s）" % (human(size), dt, size / 1024.0 / max(dt, 1)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只列出要下什么，不真下")
    args = ap.parse_args()

    print("HF_ENDPOINT = %s" % os.environ["HF_ENDPOINT"])

    jobs = [
        (SD15_REPO, SD15_ALLOW, os.path.join(MODELS_ROOT, "sd15")),
        (CN_REPO, CN_ALLOW, os.path.join(MODELS_ROOT, "controlnet_depth")),
    ]

    total = 0
    for repo, allow, target in jobs:
        print("")
        print("=== %s ===" % repo)
        total += show_candidates(repo, allow)

    print("")
    print("总计需要下载：%s" % human(total))

    if args.dry_run:
        print("（--dry-run，未实际下载）")
        return 0

    for repo, allow, target in jobs:
        print("")
        print("=== 开始下载 %s ===" % repo)
        download(repo, allow, target)

    print("")
    print("=== 全部完成 ===")
    for repo, allow, target in jobs:
        print("  %s : %s" % (target, human(dir_size(target))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
