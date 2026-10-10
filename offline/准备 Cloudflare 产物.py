# -*- coding: utf-8 -*-
"""
准备「可直接上传到 Cloudflare Pages」的产物目录。

为什么需要它：
  Cloudflare Pages 的单文件硬上限是 25 MiB，而 public/ffmpeg/ffmpeg-core.wasm
  有 31.2 MB，直传会被拒。这个脚本把 dist/ 复制成 dist-cf/ 并剔除整个 ffmpeg/ 目录。

剔除之后 FFmpeg 引擎还能用吗：能。
  utils/ffmpegRenderer.ts 会依次探测本地 /ffmpeg/ffmpeg-core.{js,wasm,worker.js}，
  全部探测失败才回落到 unpkg CDN。所以托管版首次用 FFmpeg 引擎时会从 CDN 拉一次
  （之后走浏览器缓存），其余功能不受影响。

用法：
    python offline/准备 Cloudflare 产物.py
然后：
    npx wrangler pages deploy dist-cf --project-name=dokidoki
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'dist')
DST = os.path.join(ROOT, 'dist-cf')
LIMIT = 25 * 1024 * 1024  # Cloudflare Pages 单文件上限 25 MiB


def main():
    if not os.path.isdir(SRC):
        sys.exit('找不到 dist/，先跑 npm run build')

    if os.path.isdir(DST):
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST)

    # 剔除整个 ffmpeg/ 目录：wasm 超限，而且探测是「三个都成功才算成功」，
    # 只留小文件没有意义
    ff = os.path.join(DST, 'ffmpeg')
    removed = []
    if os.path.isdir(ff):
        for f in sorted(os.listdir(ff)):
            p = os.path.join(ff, f)
            removed.append((f, os.path.getsize(p)))
            os.remove(p)
        os.rmdir(ff)

    print('已剔除 ffmpeg/：')
    for f, s in removed:
        print(f'   {f:<24} {s/1048576:6.2f} MB')
    print('   （FFmpeg 引擎将回落到 unpkg CDN）\n')

    biggest, biggest_path, total, count, over = 0, '', 0, 0, []
    for root, _dirs, files in os.walk(DST):
        for f in files:
            p = os.path.join(root, f)
            s = os.path.getsize(p)
            total += s
            count += 1
            if s > biggest:
                biggest, biggest_path = s, os.path.relpath(p, DST)
            if s > LIMIT:
                over.append((os.path.relpath(p, DST), s))

    print(f'dist-cf：{count} 个文件，共 {total/1048576:.1f} MB')
    print(f'最大单文件：{biggest/1048576:.2f} MB  ({biggest_path})')
    if over:
        print('\n仍有超 25 MiB 的文件，Cloudflare 会拒绝：')
        for p, s in over:
            print(f'   {p}  {s/1048576:.2f} MB')
        sys.exit(1)
    print('全部文件都在 25 MiB 以内 ✅')
    print(f'\n下一步：npx wrangler pages deploy "{DST}" --project-name=dokidoki')


if __name__ == '__main__':
    main()
