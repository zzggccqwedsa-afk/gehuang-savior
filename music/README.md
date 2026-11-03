# 音乐推荐闭环工作区（模板）

这份说明描述数据怎么流、每轮怎么走。实际数据（`profile.json` / `backlog.json` / `feedback.jsonl` / `rounds/`）默认不入库。

## 目录

```
music/
├── README.md             ← 这份
├── roadmap.md            ← 地盘地图：开过哪些方向、储备还剩什么
├── profile.json          ← 口味快照（账号、歌单规模、近 N 首歌手分布、语言比例）
├── backlog.json          ← 储备池：校验过、且不在库里的候选（按地盘分）
├── feedback.jsonl        ← 每一首的听感反馈（一行一条，只追加）
├── candidates/
│   └── round-01.json     ← 手工策展的候选（含推荐理由）
└── rounds/
    ├── round-01.json     ← 校验后的正式清单（带 songmid、上架状态）
    └── round-01.md       ← 给人读的版本
```

## 一轮的完整流程

1. **拉数据**：`node tools/qqmusic/fetch-all.mjs`
   自动发现「我创建的歌单 / 收藏的歌单」，逐页拉全量。
2. **算口味**：`node tools/qqmusic/build-profile.mjs`
   取主歌单最近 120 首（= 最新添加）做窗口，算歌手/语言分布。
3. **策展**：写 `candidates/round-NN.json`，分两桶
   - `A` = 兴趣延伸（贴着最近的歌，命中率优先）
   - `B` = 拓宽审美（每 2–3 首换一块新地盘，可整体判断）
   每条要有 `why`（为什么是它）和 `ref`（对应库里哪首歌）。
4. **校验**：`music.mjs verify music/candidates/round-NN.json`
   搜歌、锁 `songmid`、剔除**库里已有**的歌；找不到或只有现场版的会被标出来，换歌后重跑。
5. **写入**：`music.mjs push music/rounds/round-NN.json`
   自动建歌单 + 逐首搜索添加；已加过的跳过，可反复重跑续传。
6. **出文档**：`music.mjs render music/rounds/round-NN.json`

**储备池**（不绑定轮次，随时补货）：

```powershell
node tools\qqmusic\music.mjs reserve music\candidates\backlog.json   # 校验后写入 music/backlog.json
```

## 反馈怎么记

```json
{"at":"2026-11-03T12:40:00Z","round":1,"songId":"B4","verdict":"like","note":"city pop 这首最对味"}
```

三种来源：口头反馈（`like`/`skip`）、行为推断（`music.mjs infer` → `adopted`）、删除行为（弱负面）。

## 反馈怎么影响下一轮

| 反馈 | 下一轮动作 |
|------|-----------|
| 某歌手 like | 该歌手其他作品 / 同制作人 / 同年代邻近作品加权 |
| 某地盘整体 like | 这块地盘加量，从入门曲往深里走 1–2 层 |
| 某地盘整体 skip | 降权，但**不永久封杀**（换更轻的入口再试一次） |
| 单首 skip + 具体原因 | 作为负面约束，影响同类曲目排序 |
| 没有反馈 | 沿用上一轮权重，不重复推荐已推过的歌 |

## 硬规则

- 每轮固定 20 首（A 10 / B 10）。
- 已在 `rounds/*.json` 出现过的歌不再推荐；`verify` 会强制剔除库内已有的歌。
