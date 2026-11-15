# PR #96 第 1 轮补测证据

- 共同校准红 `b9ef0fd68607cacb1c0975b5c43e3750b7a3feb1`：先前修复前的三个实现文件配合同一份测试，原 4 条和新增 5 条分别按名业务断言失败，退出 1，见 `calibration-red.tap`。这是针对既有实现的**事后变异校准**，不冒称真实先红。
- 绿 `0f71e48cda9af49f005285851b49c0b8c172f1bf`：三个文件与审查头 `693c32f6` 逐字节相同，原有和新增测试 9/9 通过，无跳过，退出 0，见 `calibration-green.tap`。
- 审查单点故障 C96-01～05 在绿提交的隔离 worktree 一次一个注入，各被对应具名断言杀死；每次按 SHA-256 对比恢复，前后原样对照均 9/9。五份 `C96-*.tap`、`before-control.tap`、`after-control.tap` 与 `results.json` 是原始结果；`runner.log` 是该次运行输出。
- 可重跑：在安装依赖的工作树运行 `node packages/server/proof/g6-config-r1-mutations.mjs /tmp/<证据目录>`。脚本只修改自建隔离 worktree，完成后清除自己的副本。若依赖、进程、断言或还原失败则非零退出。
- `initial-seatbelt-failure.tap` 保留最初直接跑 loopback 的失败：仓库 seatbelt 禁网，监听 127.0.0.1 报 EPERM。没有改门禁或跳过断言；C96-R1-05 改用独立临时 Git 仓、进程内传输夹具，执行原真实 runner CLI→真实 driver 子进程→真实宿主及请求构造；`seatbelt-single-file.tap` 显示仓库 `runNodeTests` 实跑 5/5、退出 0。
- 真实 TCP loopback 由 `packages/server/proof/g6/fixtures/runtime-config-r1-http.mjs` 单独实跑，`real-loopback.tap` 为 1/1、退出 0；真实 HTTP、真实子进程和宿主，响应器只是本地规则替身，不消耗真实模型，也不证明模型效果。旧 `initial-calibration-{red,green}.tap` 留存第一次验收日志。全量回归、完整门禁、跨厂商复审尚未完成，PR 保持 draft、未合并。
