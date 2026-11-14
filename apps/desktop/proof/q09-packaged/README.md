# q09 打包版 T8a/T8 验收

需求文档 §8.1 已定 1、验收文档 AC-28 / AC-56:联系人交活后任务进 **T8a_Delivered(待确认)**,沉默不算通过;提出者本人普通回复「通过」才进 **T8_Accepted**。没有跨厂商审查人时,本人通过如实记为 `reviewGate=waived-by-user`。

旧打包版真实闭环(`../native-files/packaged/accept-loop-final.mjs`,46abb343 / 52412af1)只断言 Compute done 与文件精确内容,两件任务都停在 `T5_InReview`、`reviewGate=none`——这是缺陷,也是本目录要判红的对象。旧 runner 是已归档证据的一部分,不改。

## 文件

| 文件 | 作用 |
| --- | --- |
| `accept-t8.mjs` | 新 runner。从旧 runner 复制扩展:私聊、群聊各派一件活,交付后断言库里 T8a + 界面「等你确认」+ sqlite backup 快照;沉默 ≥30 秒仍 T8a;本人回复「通过」后断言 T8_Accepted / badge=accepted / reviewGate=waived-by-user + 界面「你已验收」;收尾拷 `final.db` 交给 `check-t8a.py` 复核,写 `result.json`。 |
| `check-t8a.py` | 只读核对(`python3 -I`,库以 `mode=ro&immutable=1` 打开,前后 sha256 不变)。 |
| `install-copy.sh` | dmg 只读挂载 → ditto 出 `g-group.app` 到新目录(不碰 `/Applications`)→ 卸载;打印二进制路径与 `app.asar` sha256。 |

## 用法

```bash
# 1. 从栈顶提交打包(apps/desktop 下)
cd apps/desktop && nice node scripts/pack-mac.mjs        # 出 release/g-group-<ver>-arm64.dmg、-mac.zip、latest-mac.yml
# 2. 装一份副本(目录必须是新的)
bash apps/desktop/proof/q09-packaged/install-copy.sh <绝对路径 dmg> <新的绝对安装目录>
# 3. 真实模型实跑(证据目录必须是新的;网关与令牌只从 ~/.claude/settings.json 读,不打印、不落盘、不进截图)
GG_ACCEPT_BIN=<安装目录>/g-group.app/Contents/MacOS/g-group GG_ACCEPT_MODEL=workbuddy-ai/deepseek-v4.1-flash-sg \
  node apps/desktop/proof/q09-packaged/accept-t8.mjs <新的绝对证据目录>
# 4. 独立复核(runner 收尾已自动跑一次,输出 check-t8a.json)
python3 -I apps/desktop/proof/q09-packaged/check-t8a.py \
  --snapshot <证据>/t8a-snapshot-dm.db=<私聊任务号> --snapshot <证据>/t8a-snapshot-group.db=<群任务号> --final <证据>/final.db
```

替身调定位(不算验收证据):在 `apps/desktop` 构建好 `dist/` 与 `dist-electron/` 后
`GG_ACCEPT_FAKE=1 GG_ACCEPT_KEEP_GOING=1 node apps/desktop/proof/q09-packaged/accept-t8.mjs <新目录>`。
替身脑子(`packages/server/src/fakes.ts` 的 `scriptedMind`)不会把「通过」转成验收结论,所以替身下 T8 那几条必红;替身 Compute 不写文件,文件断言记跳过。

## runner 的具名断言(每件:`dm` / `group`)

- `<k>.delivered_message`:Compute done,交付消息挂着本任务的 trail、正文提到文件名与完成说明(沿用旧 runner)
- `<k>.file_exact`:产出文件精确内容(替身跳过)
- `<k>.db_state_T8a_Delivered` / `<k>.db_reviewGate_none` / `<k>.db_badge_none` / `<k>.db_deliveredSeq_set`(且等于界面交付消息的 seq)/ `<k>.db_no_reviewer`(gg_reviews 无记录)
- `<k>.ui_pending_confirm`:Compute 那一行「等你确认」;群里另要顶部清单胶囊「待验收」
- `<k>.silence_still_T8a` / `<k>.silence_ui_still_pending`:交付后不说话 ≥30 秒再读,仍 T8a、badge=none
- `<k>.user_pass_sent`:「通过」由后端确认落库,seq 在交付之后(私聊直接发;群里点交付消息的「回复」,输入框带上 `@小克 ` 再补「通过」)
- `<k>.db_state_T8_Accepted` / `<k>.db_badge_accepted` / `<k>.db_reviewGate_waived_by_user` / `<k>.ui_accepted`(「你已验收」;群里清单 1/1、不再有待验收)
- `group.pass_replies_to_delivery`:群里「通过」的 `reply_to` 就是交付消息
- `checker.check_t8a_py`、`page.no_runtime_errors`、`setup.token_input_masked`、`secrets.token_absent_from_evidence`

截图:`私聊-交付待确认`、`私聊-本人通过-已验收`、`群-交付待确认`、`群-本人通过-已验收` 等,编号顺序同步骤。失败非零退出,截图、`steps.log`、`userdata/`、`result.json` 全留(只删含令牌的 `userdata/gg-config.json`)。

## 红半边

证据目录 `deliverables/g-group-closed-loop/t8a-claude-20261113/`(不入库):

1. **旧真实打包版库判红**(`old-db-red/`):`check-t8a.py --snapshot` 只读核对 `accept-packaged-46abb343/userdata/gg-data/gg.db`(sha256 `acd72b66…e724`)与 `accept-packaged-52412af1-r2/userdata/gg-data/gg.db`(sha256 `f4f0f934…e781`),退出码 1,4 条红全是 `snapshot.state_T8a_Delivered`:`t-mwdb3u8w-3`(私聊)、`t-mwdb4y6i-h`(群)两库各两件都停在 `T5_InReview`、`reviewGate=none`、`badge=none`、`deliveredSeq=4`、无审查记录。读前读后库的 sha256 与目录清单不变。
2. **替身判红**(`fake-bbb245b2-dev/`,bbb245b2 开发版 Electron + `GG_MIND=fake GG_COMPUTE=fake`,`KEEP_GOING`):整串界面定位走通——私聊派活 → Compute done → 交付消息(trail)→ 「等你确认」→ 沉默 30 秒 → 私聊发「通过」落库;群里建群拉人 → @小克 派活 → 交付 → 清单「待验收」→ 回复交付消息「@小克 通过」(库里 `reply_to` = 交付 seq)。库里两件交付后等满 20 秒仍 `T5_InReview`,`db_state_T8a_Delivered`、`silence_still_T8a` 红;T8 几条红(修复前 + 替身脑子不出验收结论,两种原因在替身下分不开);`check-t8a.py` 对两份快照与 `final.db` 同样判红;页面错误 0。界面在 T5 与 T8a 都写「等你确认」,只有库能分辨——所以状态断言以库为准。
3. **判据对照**(`checker-controls.txt`):把旧库拷到 `/private/tmp` 改成 T8a / T8(waived-by-user)/ T8(gate 仍 none)后,`check-t8a.py` 分别判绿 / 绿 / 红,证明它不是恒红。

## 限制

- 替身下到不了 T8:`scriptedMind` 只把「帮我/请…」当派活,「通过」只回「收到:通过」,不出 verdict。`你已验收` / 清单 `1/1` 两处界面定位只按源码(`src/api/wire/tasks.ts` 的 `T8_Accepted → 做完了，你已验收`、`TopStrip` 的 `清单 {done}/{total}`)写定,真实实跑才第一次走到。
- `reviewGate=waived-by-user` 按调度要求断言;bbb245b2 的 T5 豁免路径在说话模型与生产模型同厂商时记 `waived-by-user`,厂商不同会记成 `compliant`。修复后 T8a → T8 是否把 gate 改成 `waived-by-user` 由修复决定;若保持 `none`,`db_reviewGate_waived_by_user` 与 `check-t8a.py` 的 `final.reviewGate_waived_by_user` 会如实判红。
