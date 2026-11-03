---
name: qqmusic-taste-loop
description: 给用户的 QQ 音乐歌单做「推荐 → 试听反馈 → 下一轮」的迭代循环。当用户要你推荐歌、要看自己的歌单、要给上一轮推荐打分/反馈、或要往歌单里加歌时使用。
whenToUse: 用户在谈音乐推荐、歌单、听歌口味、上一轮推荐好听不好听，或者要读/写他的 QQ 音乐账号数据时。
---

# QQ 音乐口味循环

这套流程**已经脚本化了，不要重新发明**：`tools/qqmusic/` 是工具链，`music/` 是数据（口味档案、候选、轮次、反馈日志）。

先读 `music/README.md` 了解数据流，再看这里的环境事实和坑。

## 环境事实（每次都要先确认）

- **浏览器必须先起来**：专用配置在 `.browser-profile/`，CDP 端口 9222。
  双击 `open-browser.cmd`，或手动 `msedge.exe --remote-debugging-port=9222 --user-data-dir=<repo>\.browser-profile`。
  自检：`node tools/qqmusic/qqm.mjs status`，返回 `ok: true` 才继续；否则 `music.mjs doctor` 看状态。
- 登录态持久化在配置目录里，通常一次登录长期有效。
- **Chromium 起不来的场景**：某些 agent 沙箱禁止创建命名管道（Mojo IPC 需要），浏览器必须在沙箱外启动。
- Node 18+ 即可，脚本零依赖（CDP 走 Node 内置 `WebSocket`，不装 puppeteer/playwright）。
- 主歌单名默认「新建歌单2」，可用 `QM_MAIN_PLAYLIST` 环境变量覆盖。

## 一轮的五步

```powershell
node tools\qqmusic\fetch-all.mjs                                  # 1 拉歌单（顺序 = 最新添加在前）
node tools\qqmusic\build-profile.mjs                              # 2 口味快照 music/profile.json
# 3 手写候选 → music/candidates/round-NN.json（A 兴趣延伸 / B 拓宽，各 10 首，每首带 why + ref）
node tools\qqmusic\music.mjs verify "music/candidates/round-NN.json"   # 4 搜歌、锁 mid、撞库剔除
node tools\qqmusic\music.mjs render "music/rounds/round-NN.json"       #    出人看的 md
node tools\qqmusic\music.mjs push   "music/rounds/round-NN.json"       # 5 自动建歌单 + 逐首添加
```

单首替换（网页端搜不到、或换方向）：`music.mjs set <roundFile> <id> "歌名|歌手|专辑" "新理由"`，再 `push` 一次。

**先看储备池再搜歌**：`music/backlog.json` 里是校验过、且不在库里的候选（按地盘分组，`status: reserve` 可用）。
先 `music.mjs reserve music/candidates/backlog.json` 刷新，再从里面挑；新地盘想加货就往
`music/candidates/backlog.json` 追加后重跑 `reserve`。`music/roadmap.md` 记着哪些地盘开过、哪些还没。

## 硬规则

- 每轮固定 **20 首：A 10 / B 10**；B 组每 2–3 首构成一块新「地盘」，方便用户整体判断。
- 推荐前必须过 `verify`：**已在库里的歌不许再推**，`alreadyInLibrary` 为 true 就换。
- 候选理由要具体到用户库里的某首歌（`ref` 字段），不要写「经典好听」这种空话。
- 反馈写 `music/feedback.jsonl`；`music.mjs infer` 还能把「用户自己把推荐加进主歌单」识别为 `adopted`，别忘了跑。

## 已知的坑

- 版权差异：部分专辑版在网页端搜不到（只有现场版/翻唱），搜索页第一屏找不到原版就换歌，别硬加。
- 写入只能走 UI：行内 `a.list_menu__add` → `.mod_operate_menu a.operate_menu__link`（按歌单名点）。
- 读接口用 `u.y.qq.com/cgi-bin/musicu.fcg`（明文 JSON 可用）；写接口已加密，不要试图重放。
- PowerShell 传参会吞双引号：复杂 JS 写成文件喂给 `qqm.mjs eval-file <file>`，接口参数用 `key=value` 而不是 JSON。
- 沙箱里 `curl` / `Invoke-WebRequest` 的 TLS 可能失败（schannel 无凭证），但 Node 的 https 正常——测网络用 node。
- 添加是逐首点击，偶尔失败；`push` 可重跑，已加过的会跳过。

## 交付习惯

- 每轮给用户：歌单名、A/B 分组表（含理由）、以及「哪几首最容易入口」的提示。
- 告诉用户可以直接用自然语言给反馈（「第 3 首好听」「第 7 首太吵」），不需要格式。
