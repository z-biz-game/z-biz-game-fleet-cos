# 战舰单数 · FLEET

战舰单数（Battleship Solitaire）：一张 n×n 海图，配一份**舰队清单**和每行、每列的**船格数**线索。
船身是笔直的轴对齐线段；任意两艘船不得相接 —— **对角也算相接**；每行每列的船格数必须等于线索，
舰队清单里每个长度都要下水一次。

这一题**只有一个解**。这个 1 由两条不共享任何代码的路线各自数出来并对账；
难度不是星级，是求解器实测的**假设栈深** `depth`。

```
4×4   舰队 1/2/3   行线索 0 3 1 2   列线索 3 0 2 1
      ┌───┬───┬───┬───┐
  0 ─ │ · │ · │ · │ · │   一行 0 格 → 整行涂水
      ├───┼───┼───┼───┤
  3 ─ │ ▲ │ · │ ▲ │ ▲ │   3 格
      ├───┼───┼───┼───┤
  1 ─ │ ▲ │ · │ · │ · │   1 格 —— 与上面两格同属那艘竖 3
      ├───┼───┼───┼───┤
  2 ─ │ ▲ │ · │ ▲ │ · │   2 格
      └───┴───┴───┴───┘
      列 3   0   2   1
      三艘船：竖 3 (0,1)-(0,3) · 横 2 (2,1)-(3,1) · 潜艇 (2,3)
```

上面就是题库里的 `harbour-01`：`solutionCount 1`、`depth 0`、`guesses 0`，
第二次计数走的是 `enumerated table, filtered` 这条路线。

## 玩法

* 空格上**按下并拖**：拖出一条直线段当船身。松手时长度必须等于船坞里还剩的某个长度，
  且不得压船、不得与别的船（含对角）相接 —— 否则整个动作不落地，记一次「拒绝」。
* **轻点**：放下船坞里最短的那艘。潜艇（长度 1）没有拖法，只能这么点。
* **点已有船身**：把那一艘捞起来。
* **Shift+点**：涂水。只有当这一格所在的**行和列都已经满足线索**时才允许涂 ——
  它不是"随便画"，是"这两条线告诉我这里不可能有船"。
* **右键 / 长按 450ms**：给一格记 `?`。规则和求解器把 `?` 当作未定，所以记号不污染任何判定；
  再点一次回到未定。
* `撤销` · `提示` · `重开` · `分享题面`。提示只跑 `deduce()`（无假设的传播），
  推不动时它明说："这一格已经推不出去了，剩下的要靠假设 —— 这道题的实测假设层数是 N"。
* 完成判定：行、列、舰队三重全对（`rules.isSolved`，和求解器在叶子上用的是同一个函数）。
  因为求解器已经证明这样的盘面至多一个，所以不存在"填满但错了"的胜利。
* 成绩存在本机浏览器（`fleet.save.v1`），清空存档要点两次。

## 屏上的数字是谁算出来的

| 屏幕上 | 谁算的 | 怎么复现 |
| --- | --- | --- |
| `唯一解 1` · 副标"两条路线实测" | `js/core/solve.js`：线索优先传播 + **船粒度**假设；`js/core/enumerate.js`：铺船时**一条线索都不读**的暴力表，事后拿题面去比对 | `node test/lots.test.mjs`（96 关每关两条路线各重算一遍） |
| `假设层数 depth` | 同一个 `solve()` 记下的假设栈最大深度。0 = 传播自己收口，一次假设都没用 | `node tools/bake.mjs --check`（从序列化的题面重算，对不上就退 1） |
| `推理枯竭 N 次` | `solve()` 里"传播推到不动点、还剩未定格"发生的次数 | 同上 |
| `船坞 1·2·3` / `下水 2/3` / `超线` | `rules.js` 的 `remainingFleet` / `clueStatus`：一次点击算一次，**从不搜索** | `node test/rules.test.mjs`、`node test/game.test.mjs` |

外部锚点（不是本仓的实现，是它对得上公开事实的地方）。把 `4×4 · 舰队 1/2/3` 的全部合法布阵
铺开、按 `(行计数向量, 列计数向量)` 归类：

* 表里有 **176** 个可区分题面；两艘等长船交换位置算同一个（表按**格集**去重，不按落子顺序）；
* `test/enumerate.test.mjs` 把这 **176** 个题面**逐个**在两条路线上跑一遍，要求解数与解格集都相同
  —— 不是抽样，是全表；
* 换大一号：`5×5 · 2/3/4` 的表 **752** 格、`6×6 · 2/3/4/5` 的表 **6144** 格——**这两个表大小才是测试里的期望值**。
  大表上对账按 stride 抽样：`ceil(752/5)=151` 张、`ceil(6144/100)=62` 张，测试断言的是"抽到几张、
  抽到的每张两条路线是否一致"。**本文上一版把 151/62 写成"151 题唯一（20.1%）""62 题唯一（1.0%）"**，
  那是把抽样量读成了命中量，本轮改正；整表重扫的真实唯一率（本轮在仓外跑满 752/6144 张量出来的读数，
  **没有任何闸守着它**，下次复跑没人担保）：`4×4` **80/176 = 45.5%**、`5×5` **632/752 = 84.0%**、
  `6×6` **4624/6144 = 75.3%**。抽样率之所以还敢用，是因为抽中的每张都要求两条路线**连解格集都相同**（本轮 `bad` 为空）；
* 出货端：全库 96 关的 `Σrows`、`Σcols`、`Σfleet` 与实际解格数四口都是 **944**
  —— `rules.cluesConsistent` 那道最便宜的闸门（同一堆船格三本账必须平）。本轮重算四口仍相等。

```bash
node test/enumerate.test.mjs   # 上面那几个数，期望值手写在测试里
node tools/bake.mjs --check    # 重新出题 + 复验，不写文件
```

计时不参与任何承诺，所以本文不记 `npm test` 或 `bake --check` 的秒数（本机负载不同，同一命令能差几倍）。
结构量才写进文档：本轮 `node tools/bake.mjs --check` 重新烤出的六张铺船表是
176 / 752 / 3944 / 6144 / 88872 / 248952 格，最大那张 248952，六张都没撞 60 万的表预算
（撞了会在报告行尾打 `(truncated -> clue-first route)`，本轮一行都没打）。

## 承诺表：每条承诺都有一道真会红的命令守着

右列的条数是**本轮（2026-09-29）在这台机器上跑出来的**，不是估的：`rows: N fail: M` 由
`tools/harness.mjs:40` 打印，`rows` 数的是**看得见的用例**（一条用例里可以有好几个 `ok/eq`），
所以"104 行"是 104 条能被点名的失败，不是 104 个断言表达式。

| 屏上/文档里的承诺 | 哪条命令会红 | 它判什么 | 本轮读数与出处 |
| --- | --- | --- | --- |
| 每关**只有一个解**，而且这个 1 由两条不共享代码的路线各自数出来 | `node test/lots.test.mjs` | 96 行每行只拿序列化题面重跑 `solve(limit:2)` 与 `countByTable(limit:2)`：`count/depth/guesses/nodes/cells/route` 六个字段必须逐个等于印着的值，任一路 `truncated` 直接算红 | `rows: 13 fail: 0`；`route` 的期望字符串 `"enumerated table, filtered"` 写在 `js/data/lots.js` 的每一行里，由这条用例复验 |
| 4×4 的全表对账不是抽样 | `node test/enumerate.test.mjs` | `4×4 [1,2,3]` 的 176 张题面**逐张**两条路线比解数与解格集；`4×4 [1,1]` 再比 78 张（等长船那张）；`bad` 必须是空数组 | `rows: 13 fail: 0`；表大小 176/752/6144 是**手写常量**（`test/enumerate.test.mjs:141,154,161`） |
| 屏上"假设层数""推理枯竭"改不掉 | `node tools/bake.mjs --check`、`node test/lots.test.mjs` | bake 重新出题后用 `recheck()` 逐行复验 count/depth/guesses，对不上就 `RECHECK FAILED` + `exit 1`；序列化的 `lots.js` 与 freshly baked 不一致时 `--check` 分支退 1 | 本轮交回 `recheck: 96/96 reproduce count/depth/guesses on both routes` 与 `unchanged: js/data/lots.js` |
| 难度带是**量出来的**，不是形容词 | `node test/lots.test.mjs` | 每行 `band` 必须等于 `make.bandOfDepth(depth)`；`depth==0` 只许进 `pure`、`depth>0` 不许进 `pure`；另钉 `depths.harbour == 0`、`depths.battleline >= 2` | `rows: 13 fail: 0`；带子区间是源码常量 `js/core/make.js:23` 的 `BANDS`（`{min,max}`） |
| "唯一"不是常量，是三张手推图钉住的 | `node test/fixture.test.mjs` | 手推 fixture 1 = `depth 0`、fixture 2 = `depth 1`（"depth 不是装饰性常量"）、fixture 3 = `count 2` 且**不许出现在出货库里**，两条路线对这三张都要一致 | `rows: 15 fail: 0`；期望值全部手写在 `test/fixture.test.mjs` 里 |
| 校验器每条拒绝都活着、且顺序确定 | `node test/rules.test.mjs` | 出界 / 压船 / 共边 / **只共角** / 左边界共角不当成换行 / 折弯 / 行线索不符 / 列线索不符 / 舰队不符 各一条负例，加"最响的错先说话"的检查顺序，加 `canPlaceHull` 只做单步不搜索 | `rows: 18 fail: 0` |
| 第二腿真的不看线索 | `node test/enumerate.test.mjs` | 布阵表按**格集**去重（等长舰队 `arrangements == 2×entries`）、`packCount` 用手算值、预算撞了要说 `truncated` 并退化成 clue-first（不许沉默）、表缓存必须是缓存（同一对象；`clearTables()` 后重建数字不变）、枚举不许改入参 | `rows: 13 fail: 0` |
| 求解器确定、不肯半成品出货 | `node test/solve.test.mjs` | `depth <= guesses` 且两者同时为 0 ⟺ 传播自己收口；"答案是题面的函数"（两次调用逐字节相等，不读时钟不用 RNG）；预算饿死报 `truncated` 而不是报唯一；非法线索向量回 `error` 而不是开搜 | `rows: 12 fail: 0` |
| 每一关都**能用真手势下完** | `node test/game.test.mjs`、`bash tools/verify.sh` 的 `@play` / `@pointer` | node 侧 96 关逐关拿证书舰队走 `commit` 路径；浏览器侧真的发 `mousePressed/mouseMoved/mouseReleased`，拖出三段船、shift 涂水、长按记号，并断言命中盒到得了控件 | node `rows: 12 fail: 0`；本轮 `@play` 30 行、`@pointer` 45 行 |
| 现场生成有边界、会终止、拒绝半成品 | `node tools/bake.mjs --check` | 每掷一次 `makeChart(..., {maxAttempts: 1, budget: 600000})`，拒绝原因**原样打印**；`solve` 撞线记 `truncated`、`countByTable` 撞线记 `tableTruncated`，两种都直接丢弃（`js/core/make.js:124,131`） | 本轮 96 关出自 771 掷（12.5%）；六档的 `rejections` 里**没有** `truncated`/`tableTruncated` 这两个键 |
| 分数只存本机，清档要点两次 | `node test/storage.test.mjs`、`@save` / `@reloaded` | 后端缺席/方法抛错/写超额都只降级不崩；`best` 只会变小、`unlocked` 只会变大；盘上形状 = 内存形状，盘上的垃圾要能扛住；`reset` 真清盘（不只清缓存） | node `rows: 11 fail: 0`；本轮 `@save` 26 行、`@reloaded` 9 行 |
| 同一条链接在任何设备上是同一张图 | `node test/lots.test.mjs`、`@routes` | `dailyLot(date)` 必须逐日等于 `LOTS[hashSeed('daily|date') % 96]`（走混子，不走时钟）；连续 40 天的种子两两不同；`randomLot` 不许出带，24 个 token 要落到多张图上；未知档给 `null` | node `rows: 13 fail: 0`（含这三条用例）；本轮 `@routes` 22 行 |
| `js/core` 不知道有屏幕 | **没有这道闸** | 本轮 grep `js/core/*.js` 里的 `window` / `document`：三处命中全是注释（`js/core/board.js:10`、`js/core/solve.js:31`、`js/core/storage.js:1`），代码里没有一处。但**没有任何测试会因为它变红** | 见「已知边界」最后一条：这条靠人查，同组织的 kakurasu 有源码级扫描，本仓没有 |

表里点名的**8 套 node 门禁**合起来本轮是 **104 条用例、0 失败**；浏览器层 **151 行、0 失败**，
加在一起是 `bash tools/verify.sh` 交回的 `=== ALL GREEN ===`。这一层没有 `RESULT:` 汇总行——
每套自己打印一行 `rows: N fail: M`，`=== ALL GREEN ===` 只在 `tools/verify.sh` 末尾出现。
最后那行"`js/core` 不知道有屏幕"**不在**这 104 条里，因为它没有命令——它是全表唯一一格写着"没有这道闸"的承诺。

### 上面那些"会红"是怎么验出来的

把整仓拷到仓库外的临时目录（`_tmp-fleet-copy/repo`，副本用完即删，真仓一行没改），
每次只破坏一个字段，然后跑两条门禁看谁说话。本轮八刀：

| 破坏 | `node test/lots.test.mjs` | `node tools/bake.mjs --check` |
| --- | --- | --- |
| `harbour-01` 的 `depth` 0 → 3 | `fail: 2`：`every printed solutionCount is recomputed…` + `the band a lot ships in is its measured depth…` | rc=1 `differs from a fresh bake` |
| `harbour-05` 的 `solutionCount` 1 → 2 | `fail: 2`：count 那条 + `the second, clue-free route reproduces the same count and the same chart` | 同上 |
| `patrol-02` 把一格船挪到解外 | `fail: 2`：`every printed cell list is the unique solution…` + 第二腿那条 | 同上 |
| `convoy-04` 的行线索 +1 | `fail: 4`：count / cells / 第二腿 / band 四条一起红 | 同上 |
| `sortie-01` 的 `band` 改成 `pure` | `fail: 1`：只有 `the band a lot ships in is its measured depth, not a typed label` | 同上 |
| `blockade-01` 的 `route` 改成 `clue-first enumeration` | `fail: 1`：第二腿那条 | 同上 |
| `battleline-03` 的 `nodes` 改小成 1 | `fail: 1`：count 那条（`nodes` 在它里面一起比） | 同上 |
| `harbour-09` 的 `id` 改成 `harbour-08`（撞车） | `fail: 1`：`the pool is the size the bake says it is, and the seed is stamped` | 同上 |

八刀全红，且**每一刀红的都是表里点名它的那条用例**——`band` 改标签只有 band 那条红，
`route` 说谎只有第二腿那条红，说明这些用例各管各的、没有互相兜底。反过来说一个**不红**的情形：
只把 `cells` 数组里前两个元素**换个顺序**，`test/lots.test.mjs` 交回 `fail: 0`，因为那条用例比的是
排序后的格集（`asText`），顺序不是承诺。这一条记在这里，是为了说清"红"判的是什么语义。

---

## 怎么跑：`package.json` 的 9 条 scripts 逐条核对

脚本清单就是 `package.json` 里 `scripts` 的原文，9 条都在，没有虚构。"本轮"指 2026-09-29 这一轮文档核对。

| script | 实际执行的命令 | 本轮跑过吗 | 本轮读数 |
| --- | --- | --- | --- |
| `start` | `node server.cjs 5193` | 没有单独手起 | `verify.sh` 内部起的就是这一条（同一个 `server.cjs`，`WEB_PORT` 默认 5193），收尾把它 SIGTERM 掉；`server.cjs:48` 的默认端口也是 5193 |
| `serve` | `node server.cjs 5193` | 与 `start` 同一个字符串 | 同上 |
| `dev` | `node server.cjs 5194` | 否 | 与上面同一条路径，只是把端口写死成 5194 |
| `check` | `for f in js/*.js js/*/*.js server.cjs electron/main.cjs tools/*.mjs test/*.mjs; do node --check …; done && node tools/playtest.mjs selftest && echo OK` | **是**（随 `npm test`） | 打印 `OK`；同一 glob 实测展开 **25 个文件**；`selftest` 交回 `RESULT {"cmd":"selftest","pass":true,"rows":5,"fail":[]}` —— 那 5 行是**五个场景函数字符串在 node 里能不能 parse**，`@pointer` 不在其中（它由驱动侧真发鼠标事件，不是页内函数字符串） |
| `unit` | `for f in test/*.test.mjs; do node "$f" \|\| exit 1; done` | **是**（随 `npm test`，也逐个跑过） | 8 套全绿：board 10 / enumerate 13 / fixture 15 / game 12 / lots 13 / rules 18 / solve 12 / storage 11，**合计 104 条用例、0 失败** |
| `test` | `npm run check && npm run unit` | **是** | 交回上面那 8 行 `rows: N fail: 0`；包装层把 rc 写进日志（`GATE_RC=0`），不是靠管道猜 |
| `bake` | `node tools/bake.mjs` | 只跑了 `--check` 形态 | `--check` 不写盘：本轮打印 `recheck: 96/96 …` 后是 `unchanged: js/data/lots.js`，`git status` 干净。去掉 `--check` 会**改写题库源文件**，文档轮不动已发货的题库，所以没跑 |
| `electron` | `electron .` | **否** | `dependencies`/`devDependencies` 都是 `{}`，仓里没有 `node_modules`，`electron` 也不在这台机器的 PATH；`electron/main.cjs` 只是那份 34 行的壳 |
| `verify` | `bash tools/verify.sh` | **是** | node 104 行 + 浏览器 151 行全绿，`=== ALL GREEN ===`，见下一节 |
| `deploy-set` | `node tools/deploy-set.mjs` | 绿：对拷出来的产物提要求（见「上线的到底是哪一批文件」一节） |
| `deploy-set:selftest` | `node tools/deploy-set-selftest.mjs` | 绿：9 刀逐类打红且点名 + 1 条阴性对照 |

零依赖、零打包器、零图片素材：`dependencies` 与 `devDependencies` 都是 `{}`，画面全部由
canvas 2D 程序绘制。ES module 需要 origin，所以双击 `index.html` 不是支持的玩法。

路由：`#/c/<n>` 战役 · `#/lot/<id>` 分享某一关 · `#/daily` 当日题 · `#/random/<tier>/<token>`。
`#/daily` 用 `hashSeed('daily|YYYY-MM-DD')` 落在**题库下标**上，`#/random` 也是从题库里按种子挑
—— 点击路径上**没有任何生成**：一个题面要出货，得先让两条路线都说 1，这在构建期是毫秒级，
放在手指下面是不能接受的卡顿。`#/random/<tier>` 不带 token 时会立刻 `location.replace` 补一个
token，免得同一链接每次打开是不同题。

## 门禁清单：本轮（2026-09-29）逐条复跑

```bash
npm test                     # check（25 个文件 parse + 5 个场景函数 parse）+ 8 套 node 用例
node tools/bake.mjs --check  # 重新出题并复验，只读
bash tools/verify.sh         # 上一条 + 真起 headless Chrome、真发鼠标事件的 6 套浏览器用例
```

本轮读数（都是这台机器上一次性跑完的，日志留在工作区根的 `_tmp-fleet-*.log`，判据按日志行而不是管道退出码）：

* node：`rows: 10 fail: 0`、`13`、`15`、`12`、`13`、`18`、`12`、`11` —— **104 条用例，0 失败**；
* 浏览器：`@boot 19 / @play 30 / @routes 22 / @save 26 / @reloaded 9 / @pointer 45` —— **151 行，0 失败**，
  汇总行 `=== browser rows: 151 ===`；`=== console ===` 段是 `(none)`；收尾 `=== chrome exited, temp profile gone ===`
  之后才有 `=== ALL GREEN ===`；
* bake：`recheck: 96/96 reproduce count/depth/guesses on both routes` + `unchanged: js/data/lots.js`。

151 行由 **149 个 `rec(` 调用点**产生（`grep -o 'rec(' tools/playtest.mjs | wc -l` 本轮 = 149；
六个套件里那六行 `const rec = …` 是定义，不算调用点，所以两个数不是一回事）。
对不上是两件事互相抵：`@routes` 里那句 `for (const band of Object.keys(g.pool.byTier))`
把 1 个调用点摊成 6 行（17 → 22，+5）；`@pointer` 有 48 个调用点却只交回 45 行——
2 个只在失败时说话（`tools/playtest.mjs:489,493`），1 对互斥
（`tools/playtest.mjs:527` 量不到边距格才红，`:535` 是量到才说话）。**条数会自己变的套件不能当闸**——
这里每条都是固定断言，摊开的倍数由 `TIERS_META` 的 6 个档决定，档数变了测试会先红。

---

## 已知边界（诚实清单）

* 台架的浏览器段是**真起 Chrome、真发鼠标事件**跑的：本轮 `bash tools/verify.sh`（web `:5193` /
  devtools `:9353`）交回 `=== ALL GREEN ===`，node 104 行 + 浏览器 151 行、控制台 `(none)`、
  收尾要求本次的 Chrome 已退出、临时 profile 已删。
  **这条闸挡不住"别的会话留着的那台 Chrome"**：`tools/verify.sh:44-51` 只预检自己的 `:9353`
  （被占退 5）和 `:5193`（被占退 6），不做全机孤儿检查。本轮这台机器上就有一台别的仓的
  headless Chrome 在听 `:9373`（profile `/tmp/sky-chrome-profile`），它既不挡本仓的门，也不替本仓作证——
  本仓的 151 行是在自己的端口、自己的临时 profile 上跑出来的，跑完由 `:183-197` 收尾断言确认
  只有**自己那台**退干净了。浏览器段没有任何墙钟断言（`grep Date.now tools/playtest.mjs` 本轮只命中两处，
  都在 `waitShell` 的等 shell 超时里，`:231,238`），所以机器同时忙别的事不会把绿的跑成红的，反之亦然。
  2026-09-27 这份 README 写的是"现在是红的，96 行里 11 条失败"；那 11 条连同后来在指针套件里挖出的
  两条（CDP 的 release 必须报 `button:'left'`；松手在棋盘外会把长按计时器留在起手那一格）
  逐条写在 `DESIGN.md` §7.2，七条根因全在台架与视图侧，`js/core` 一行没改。

* `depth` 是**这台求解器**的性质，不是题目的客观难度。它依赖 `propagate()` 的规则强度：
  加一条更强的传播规则，同一个题面的 `depth` 可能变小。所以题库里 `harbour`/`patrol` 全是
  `depth 0`、`convoy`/`blockade` 全是 `depth 1`、`sortie` 落在 3..9、`battleline` 落在 2..11
  —— 这些数字可比，是因为它们都出自同一个 `solve()`，不是因为它们是"客观几层"。
* 没有做过**线索极小化**：题面是从一个随机布阵读出来的，bake 只证明"这组线索唯一"，
  不证明"每条线索都必要"。所以"抹掉任一条线索后解数 ≥2"这句话本仓**不能**说，也没人说。
* `enumerate.js` 的计数打包 `packCount` 用的是 n+1 进制、2n 位，**只在 n ≤ 8 时精确**
  （9^16 < 2^53）。`test/enumerate.test.mjs` 有一条专门的碰撞测试钉住它；把棋盘放到 9×9
  以上而不改这个函数，两条路线会"同时错成一样的数"。
* 铺船表有预算（默认 40 万格、bake 用 60 万）。撞预算就 `truncated`，此时第二腿退化成
  "边铺边比线索"的 clue-first 走法 —— 仍然独立，但**内存形状不同**，出货行里的 `route` 字段
  会写清是哪条。当前 96 关全部是 `enumerated table, filtered`。
* 没有成就、排行榜、签到、内购、云存档；分享的只有题面本身（`#/lot/<id>`）。
* 求解器预算撞线时回答 `truncated` 而不是"没有第二个解"；生成器一律**拒绝**这种题面
  （`js/core/make.js:124` 记 `reason:'truncated'`、`:131` 记 `'tableTruncated'`），
  所以屏幕上的 1 不可能来自一次没跑完的搜索。上一版说"本仓没有统计被夹掉了多少"，**这句不准**：
  bake 每一档都把 `rejections` 按原因原样打印，`truncated`/`tableTruncated` 就是其中的键。
  本轮的六档打印里这两个键一次都没出现（即 0 次被夹掉），出现的只有
  `notUnique`/`tooEasy`/`tooHard`/`deadEnd`/`duplicate`。仍然要说清的是：
  统计只活在**那一次 bake 的标准输出**里，仓里没有累计计数器，也不留跨次快照——
  所以"这批题面历史上被预算夹掉过多少"没人答得出。
* 大表上的对账是**抽样的**：4×4 是 176 张全表，5×5 抽 `ceil(752/5)=151` 张、6×6 抽
  `ceil(6144/100)=62` 张。这两号上"未抽到的那张会不会两条路线给出不同的数"没有证明，
  只有出货的 96 关是**逐关**两条路线都重跑过的（`test/lots.test.mjs`）。
* `js/core` 不知道有屏幕——**这条没有闸**。本轮 grep `js/core/*.js` 里的 `window`/`document`，
  三处命中全是注释（`js/core/board.js:10`、`js/core/solve.js:31`、`js/core/storage.js:1`），代码里零命中；
  但把 `document.getElementById` 写进 `js/core/rules.js` 不会让任何一条测试变红。
  同组织的 kakurasu 有源码级扫描那条用例，本仓没有，所以这里只登记为"人查过的现状"，不登记为承诺。
* bake 报告里的 `med`/`max` 两列是求解器与计数器的毫秒数，**读数不是承诺**：本文不抄这俩数，
  它们随机器负载漂移，下一次复跑一定不同。同一行里的 `drew/laid/uniq/rate/table` 是整数，
  本轮复跑逐位相同（771 掷 / 96 关 / 12.5% / 六张表大小），因为生成器只吃 `BAKE_SEED` 不吃时钟。
* 种子混子 `hashSeed` 是 FNV-1a 派生的两轮版，**输出不是教科书向量**：
  `test/lots.test.mjs:151` 钉的就是"它不等于 textbook FNV-1a 的 3826002220"这个否定事实。

---

## 目录（本轮实测：`check` 那条 glob 展开 25 个文件）

```
index.html (63 行) · css/game.css (115 行)
js/main.js            路由与控件的唯一入口（提示、清档、分享都在这里）
js/view.js            canvas 2D 绘制 + 手势状态机（LONG_PRESS = 450，js/view.js:26）
js/core/board.js      四态格子（未定 / 船 / 水 / `?`）与 serialize/parse
js/core/rules.js      九条拒绝 + clueStatus/remainingFleet/isSolved，一次点击算一次，从不搜索
js/core/solve.js      线索优先传播 + 船粒度假设；`depth`/`guesses`/`nodes` 都在这里量出来
js/core/enumerate.js  第二腿：一条线索都不读的铺船表，按格集去重，事后拿题面过滤
js/core/game.js       点击路径（commit/undo/markWater/cycleMark），完成判定复用 rules.isSolved
js/core/make.js       生成器：seeded 布阵 → 读线索 → 两条路线 → bandOfDepth 贴带
js/core/library.js    题库侧的解析层：campaign / dailyLot / randomLot / puzzleOf
js/core/rng.js        hashSeed（FNV-1a 派生）+ mulberry32
js/core/storage.js    单键 fleet.save.v1（js/core/storage.js:12），后端缺席/抛错都降级
js/data/lots.js       96 行烘焙产物，每行一个 JSON：题面 + 两条路线的实测证据
tools/harness.mjs     42 行，其中 :40 打印 `rows: N fail: M`
tools/playtest.mjs    CDP 驱动 + 六个浏览器套件（五个页内函数字符串 + @pointer 真发鼠标事件）
tools/bake.mjs        出题、复验、渲染 lots.js；--check 只读
test/*.test.mjs       上表那 8 套 node 门禁
server.cjs · electron/main.cjs · .github/workflows/{ci,pages}.yml
```

设计说明在 `DESIGN.md`（规则来源与"为什么按船假设"在它的前三节，浏览器那 11 条红的根因在 §7.2），
tools/assemble-site.sh  部署产物的唯一清单（pages.yml 与本地闸调同一支）
tools/deploy-set.mjs  部署集闸：检查即将上传的那份产物
tools/deploy-set-selftest.mjs  部署集闸的阴性自证（每一类断言当场打红一次）
交付清单在 `deliverable.md`。

## 端口与 URL 形态

| 场景 | 地址 | 出处 |
| --- | --- | --- |
| 本机起服务 | `http://127.0.0.1:5193/`（`start`/`serve`），`5194`（`dev`） | `package.json` scripts、`server.cjs:48,59` 的默认值 |
| 浏览器门禁 | `WEB_PORT` 默认 5193、`CDP_PORT` 默认 9353；被占分别退 6 / 5 | `tools/verify.sh:21-22,44-51` |
| 线上站点 | `https://z-biz-game.github.io/z-biz-game-fleet-cos/`（本轮 `curl` 回 200） | 远端名从 `git remote get-url origin` 取：`z-biz-game/z-biz-game-fleet-cos.git` |
| CI | 两条 job：`unit`（Syntax + Suites）、`browser`（`SKIP_UNIT=1`、`WD_TIMEOUT=240` 跑 `verify.sh`），node 22 | `.github/workflows/ci.yml` |

页内模块都用相对路径 import，所以 Pages 的 `/<repo>/` 前缀不需要任何特殊处理；
反过来说，双击 `index.html` 走 `file://` 时 ES module 会被 origin 规则拒掉，这不是支持的玩法。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`30`）与这一次跑的断言条数（`48`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`30`、断言仍然 `48`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；把它们接进本仓
那条浏览器 one-shot（`tools/verify.sh`）还欠着——那道脚本的腿名单与条数钉是每个仓自己的形状。

