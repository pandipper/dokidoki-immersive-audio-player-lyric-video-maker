# -*- coding: utf-8 -*-
"""
打包「dokidoki 离线版」发布包。

用法（在项目根目录执行）：
    python offline/打包离线版.py

做的事情：
    1. npm run build                → 生成 dist/
    2. dist/ 拷进系统临时目录的 app/（不在项目里建 _stage，避免反复删目录）
    3. 把 offline/ 下的脚本按中文 Windows 规范转换编码：
         .cmd / .txt → GBK（无 BOM）+ CRLF
         .ps1        → UTF-8（带 BOM）
    4. 打 zip → offline/dokidoki-offline.zip（UTF-8 文件名）

注意：编码这一步不能省。PowerShell 5.1 会按 GBK 解码无 BOM 的 .ps1，
      中文会当场把字符串引号吃掉，脚本直接语法报错；cmd.exe 同理。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ZIP = os.path.join(HERE, 'dokidoki-offline.zip')
TOP = 'dokidoki-offline'
SCRIPTS = ['server.ps1', '启动 dokidoki.cmd', '使用说明.txt']


def run(cmd, cwd):
    print('>', ' '.join(cmd))
    r = subprocess.run(cmd, cwd=cwd, shell=(os.name == 'nt'))
    if r.returncode != 0:
        sys.exit(f'命令失败：{cmd}')


def to_gbk_crlf(path):
    with open(path, 'rb') as f:
        raw = f.read()
    if raw[:3] == b'\xef\xbb\xbf':
        raw = raw[3:]
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('gbk')
    out = text.replace('\r\n', '\n').replace('\n', '\r\n').encode('gbk')
    with open(path, 'wb') as f:
        f.write(out)


def to_utf8_bom(path):
    with open(path, 'rb') as f:
        raw = f.read()
    if raw[:3] == b'\xef\xbb\xbf':
        raw = raw[3:]
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('gbk')
    text = text.replace('\r\n', '\n')
    with open(path, 'wb') as f:
        f.write(b'\xef\xbb\xbf' + text.encode('utf-8'))


def verify(path):
    with open(path, 'rb') as f:
        raw = f.read()
    crlf = raw.count(b'\r\n')
    lone = raw.count(b'\n') - crlf
    bom = raw[:3] == b'\xef\xbb\xbf'
    return crlf, lone, bom


def main():
    # 1) 构建
    run(['npm', 'run', 'build'], ROOT)

    dist = os.path.join(ROOT, 'dist')
    if not os.path.isdir(dist):
        sys.exit('找不到 dist/，构建可能失败了')

    # 2) 暂存到系统临时目录（每次都是全新目录，无需先删旧的）
    stage = tempfile.mkdtemp(prefix='dokidoki-stage-')
    print(f'\n暂存目录：{stage}')
    try:
        app = os.path.join(stage, 'app')
        os.makedirs(app)
        for item in os.listdir(dist):
            s = os.path.join(dist, item)
            d = os.path.join(app, item)
            if os.path.isdir(s):
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)

        # 3) 脚本就位 + 编码转换
        for name in SCRIPTS:
            shutil.copy2(os.path.join(HERE, name), os.path.join(stage, name))

        to_utf8_bom(os.path.join(stage, 'server.ps1'))
        to_gbk_crlf(os.path.join(stage, '启动 dokidoki.cmd'))
        to_gbk_crlf(os.path.join(stage, '使用说明.txt'))

        print('\n编码校验：')
        for name in SCRIPTS:
            crlf, lone, bom = verify(os.path.join(stage, name))
            print(f'  {name:<22} CRLF={crlf} 裸LF={lone} BOM={bom}')
            if name.endswith(('.cmd', '.txt')) and (lone or bom):
                sys.exit('  ↑ .cmd/.txt 必须是 GBK + CRLF 且无 BOM')
            if name.endswith('.ps1') and not bom:
                sys.exit('  ↑ .ps1 必须是 UTF-8 带 BOM')

        # 4) 打包
        if os.path.exists(ZIP):
            os.remove(ZIP)
        count = 0
        with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for root, _dirs, files in os.walk(stage):
                for f in files:
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, stage).replace('\\', '/')
                    z.write(full, f'{TOP}/{rel}')
                    count += 1

        size = os.path.getsize(ZIP) / 1048576
        print(f'\n完成：{count} 个文件，zip {size:.1f} MB')
        print(f'输出：{ZIP}')
    finally:
        # 临时目录在 %TEMP% 下，尽力清理；失败也不影响产物
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
