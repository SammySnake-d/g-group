#!/usr/bin/python3
# 隔离副本的 npm workspace 依赖准备。只改 -w 指定的 gate 临时目录,不改源码/门禁/原依赖。
# 原门禁将顶层 node_modules 链到原仓依赖;其中 workspace 链会跳出 Docker 挂载。
# 外部依赖仍指向已挂载的原 node_modules,workspace 必须指向当前红/绿/变异副本。
import json,os,pathlib,sys
args=sys.argv[1:]
if args and args[0]=='run' and '-w' in args:
    work=pathlib.Path(args[args.index('-w')+1])
    pkg=work/'package.json'; nm=work/'node_modules'
    if work.name.startswith(('gate-run-','gate-snap-','gate-xform-')) and pkg.is_file() and nm.is_symlink():
        manifest=json.loads(pkg.read_text())
        if manifest.get('workspaces')==['packages/*']:
            original=nm.resolve(strict=True)
            packages={json.loads(p.read_text())['name']:p.parent for p in (work/'packages').glob('*/package.json')}
            nm.unlink();nm.mkdir()
            for entry in original.iterdir():
                if entry.name=='@g-group': continue
                (nm/entry.name).symlink_to(entry)
            for name,directory in packages.items():
                link=nm/name;link.parent.mkdir(parents=True,exist_ok=True)
                link.symlink_to(directory)
os.execv('/usr/bin/docker',['docker',*args])
