# 歌荒拯救者

> 让 AI agent 直接读你的 QQ 音乐歌单、按你最近的口味推新歌，写回一个新歌单；你说「第 3 首好听」，它就记住。

不是又一个「猜你喜欢」的推荐算法。这是一个**可被 agent 驱动的歌单工具**：把「读歌单 → 推断口味 → 找歌 → 建歌单 → 收反馈 → 下一轮」这条链路做成脚本，agent 负责策展和判断，脚本负责搬运。

## 它解决什么问题

- 你的歌单攒了十年、上千首，越加越慢，最后只在熟悉的几十首里打转。
- 平台推荐看着热闹，但它是按「大盘」推的，不是按**你最近三个月**在听什么推的。
- 想「拓宽审美」，需要有人告诉你**下一步该跨哪一步**——跳太远听不进去，跳太近没意义。

歌荒拯救者把这件事拆成两桶：`A 兴趣延伸`（贴着最近添加，命中率优先）+ `B 拓宽审美`（每 2–3 首换一块新地盘，让你能对**一个方向**下判断）。

## 工作原理

```
┌─────────────────────────────┐
│ Edge（专用 user-data-dir）  │  登录态只存在本机磁盘
│   ↑ CDP 127.0.0.1:9222      │
├─────────────────────────────┤
│ Node 脚本（零依赖）          │  cdp.mjs 直连，无需 puppeteer/playwright
│   ↑ 页面上下文里的 fetch     │  自动带 Cookie 调 u.y.qq.com 明文接口（读）
│   ↑ 真实点击网页             │  写操作被加密，所以走 UI：搜索→添加到歌单
└─────────────────────────────┘
```

两个关键约束，决定了这个项目长这样：

1. **读**：QQ 音乐网页版的老接口 `u.y.qq.com/cgi-bin/musicu.fcg` 仍接受明文 JSON，所以在页面里 `fetch` 就能拿到歌单、歌曲、搜索结果的 `songmid`。
2. **写**：新建歌单 / 加歌的接口已经加密 + 签名，无法重放。所以写入退回到「模拟点击」——自动化驱动搜索结果行的「添加到歌单」，逐首加。慢，但稳，而且能断点续传。

## 快速开始

前置：Windows + Edge + Node 18+（用系统自带的 `node` 即可，脚本零依赖）+ 一个已登录 QQ 音乐的浏览器会话。

```powershell
git clone https://github.com/<you>/gehuang-savior
cd gehuang-savior

# 1. 用专用配置启动 Edge（会开一个新窗口，登录一次以后就不用再登）
.\open-browser.cmd

# 2. 拉取账号下所有歌单（自动发现，不需要填 ID）
node tools\qqmusic\fetch-all.mjs

# 3. 口味快照
node tools\qqmusic\build-profile.mjs
```

然后按 [SKILL.md](.dsh/skills/qqmusic-taste-loop/SKILL.md) 里的五步做一轮推荐。

## 五步

| 步骤 | 命令 | 干什么 |
|------|------|--------|
| 1 拉歌单 | `fetch-all.mjs` | 自动发现「创建/收藏」两栏，逐页拉全量歌曲 |
| 2 口味快照 | `build-profile.mjs` | 取主歌单最近 120 首，算歌手/语言分布 |
| 3 校验候选 | `music.mjs verify <candidates.json>` | 搜歌、锁 `songmid`、**剔重**（库里已有的一律不要） |
| 4 写进账号 | `music.mjs push <round.json>` | 自动建歌单 + 逐首添加，可重跑续传 |
| 5 出文档 | `music.mjs render <round.json>` | 生成带推荐理由的 Markdown 清单 |

其他命令：

```powershell
node tools\qqmusic\music.mjs reserve <backlog.json>   # 校验储备池（不绑定轮次）
node tools\qqmusic\music.mjs infer                    # 检测：推荐过的歌有没有被用户自己加进主歌单 → 记为采纳
node tools\qqmusic\music.mjs diff                     # 主歌单增量：用户又加了什么
node tools\qqmusic\music.mjs doctor                   # 体检：浏览器在不在、数据新不新、反馈几条
node tools\qqmusic\music.mjs set <round.json> A3 "歌名|歌手|专辑" "新理由"   # 换歌
node tools\qqmusic\music.mjs feedback 1 B4 like "city pop 这首最对味"        # 记反馈
```

## 反馈闭环

`music/feedback.jsonl` 一行一条，三种来源：

1. 用户口头反馈（`like` / `skip` + 原因）
2. **行为推断**：推荐过的歌出现在主歌单里 → `adopted`（`music.mjs infer`）
3. 直接删掉推荐歌单里的歌 → 视为弱负面信号

下一轮按 `territory`（地盘）和歌手加权：中的加深一层，全灭的换更轻的入口再试一次——**降权但不永久封杀**，因为「不喜欢这首」不等于「不喜欢这个方向」。

## 目录

```
.
├── open-browser.cmd            # 用专用配置启动 Edge + CDP 端口
├── .dsh/skills/qqmusic-taste-loop/SKILL.md   # 给 agent 的操作手册（五步 + 硬规则 + 坑）
├── tools/qqmusic/
│   ├── cdp.mjs                 # 最小 CDP 客户端（Node 内置 WebSocket，零依赖）
│   ├── qqm.mjs                 # 浏览器侧命令：status/open/login/shot/eval/frames
│   ├── music.mjs               # 推荐闭环 CLI
│   ├── fetch-all.mjs           # 拉全量歌单
│   ├── build-profile.mjs       # 口味快照
│   ├── search.mjs              # 搜歌
│   ├── libcheck.mjs            # 离线查重
│   └── api.mjs                 # 在已登录页面里调接口
└── music/                      # 数据（默认 gitignore，只有模板入库）
    ├── README.md               # 工作流说明
    ├── profile.json            # 口味快照
    ├── backlog.json            # 储备池
    ├── feedback.jsonl          # 反馈日志
    └── rounds/                 # 每轮正式清单
```

## 隐私

- 登录态只写在本机 `.browser-profile/`（已 gitignore），不经过任何服务器；删目录即退出登录。
- CDP 端口只监听 `127.0.0.1`，但**本机任何程序**都能连上去操作这个浏览器配置——不用时把窗口关掉。
- 仓库里不含任何账号数据：没有 uin、没有歌单 ID、没有听歌记录。`fetch-all` 是自动发现歌单的，不需要预先填。
- `music/` 下的数据默认全部 gitignore，避免把个人口味推到公开仓库。

## 已知限制

- 只验证过 **Windows + Edge**。Chromium 内核的其它浏览器理论上改个路径就行。
- 网页端有版权/会员限制：部分专辑版搜不到（只剩现场版），`verify` 会把它们标成「未找到」，需要换歌。
- 逐首点击添加，20 首歌约 1–2 分钟；失败会记录并支持重跑续传。
- 匹配靠歌名 + 歌手字符串，同名不同版本较多时可能选错；`verify` 的 `qq` 字段会打印实际锁定的版本，可人工复核。

## License

MIT
