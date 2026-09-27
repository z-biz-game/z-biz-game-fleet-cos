# DESIGN · 战舰单数 FLEET —— 写给接手的维护者代理

本文只回答两件事：**为什么这样实现**，以及**哪条约束一破就出 bug**。
玩法与实测数字在 `README.md`；这份文件解释它们为什么长这样。

```
index.html   css/game.css
js/main.js   路由 + DOM + window.fleet 测试钩子（probe / plan / playAll / drag / tap / water …）
js/view.js   canvas 2D + 指针；只管像素与手势
js/core/     board 状态 / 六条规则 / 求解器 / 铺船计数器 / 生成器 / 存档 / rng —— 纯函数
js/data/lots.js  96 关实测题池（tools/bake.mjs 产出，test/lots.test.mjs 复算）
tools/       bake.mjs 出题+复验 · playtest.mjs 零依赖 CDP 驱动 · verify.sh 验收门 · harness.mjs
test/        8 个 node 测试文件；harness.mjs 只负责打印 rows/fail
```

---

## 1. 三层规则，以及本仓**没有**的那道闸

`js/core/*` 里没有一处 `window.` 或 `document.`（唯一提到它的是 `board.js` 第 10 行的注释）。
这件事**不是靠断言守着的**：fleet 的测试里没有源码级检查（`test/*.test.mjs` 的 import 只出现
`../js/core/*`、`../js/data/lots.js` 和 `../tools/harness.mjs`），守住它的是 `npm run unit`
这个动作本身 —— 纯 `node` 能 import 全部 core，就说明 core 不依赖浏览器。哪天有人往 core 里
塞一个 `document`，八条测试文件会当场 `ReferenceError`。

这是一层**弱**守卫，写在这里是提醒接手者：它不像 `tools/check.mjs` 那种结构审计会指名道姓地
失败。想要强守卫就自己加一条源码级断言，别默认它有。

`view.js` 不判合法性，`main.js` 不画像素，`core` 不知道有屏幕。fleet 最怕的重复实现是
"UI 自己数一遍行里的船格"：那样线索条、完成判定和求解器会各自漂移。全仓只有一处数船格
（`board.js` 的 `shipCounts`），`rules.clueStatus` 从它派生，视图通过 `game.progress()` 读回来上色。

## 2. 规则与模型

### 2.1 六条检查分开写，合起来才叫"合法"

`js/core/rules.js` 把合法性拆成六个各自导出、各自有负例的判定：
`bounds`（船跑出图）· `overlap`（两船同格）· `contact`（两船相接，含对角）·
`rowClue` · `colClue` · `fleet`（长度多重集不符）。`validate()` 按"最响的错先报"的顺序串起来：
一条根本不在图上的船，不该再去评它的线索算术。

拆开的理由是：**融合成一个 `invalid` 的校验器无法被证明在看着六件事**。`test/rules.test.mjs`
18 条断言里有 6 条负例逐条打中一个错误码，还有 `negative 3c: two hulls touching on a corner only`
和 `negative 3d: a corner touch at the left edge is not a row wrap` —— 后一条打的是
`firstContact` 里 `inside()` 必须先判：row-major 平铺的下标，`x + dx` 越出左缘会绕到上一行的
右格，那格谁都不挨着。

### 2.2 对角那半不是装饰

`board.NEIGHBOURS8` 含四个斜角，这一条决定：

* `solve.js` 里一个已知船格禁掉的是 **3×3**，不是 5×1 十字；
* `enumerate.js` 的 `ban` 位图（第 8 邻域计数）；
* `rules.firstContact` 与整份 fixture 表。

`segmentMargins()` 的注释记着这条规则被写漏一次的后果（见 §3.3）。

### 2.3 四态棋盘：`MARK` 必须和 `UNKNOWN` 区分开

`board.js`：`UNKNOWN 0 · WATER 1 · SHIP 2 · MARK 3`，序列化字母 `. # ~ ?`。
`MARK`（玩家那支铅笔 `?`）在规则和求解器里**与 `UNKNOWN` 完全等价**（`isFillable()`），
所以校验器和计数器不需要在自己的每个分支里加特例；但它是**不同的整数码**，
所以 `isResolved()` 会拒绝一个还带着 `?` 的盘面 —— 不然"我猜这里有船"会被读成"这里有船"，
`placeHull()` 也不会去清掉压在船底下的那个记号（`game.js` 里那段注释就是为这件事写的）。

同理 `cluesConsistent()` 那条最便宜的闸门：`Σrows === Σcols === Σfleet`。它抓的是手改线索向量。
全库 96 关这四个量各是 **944**。

## 3. 两条路线，一条都不能省

### 3.1 为什么第二条腿必须"看不见线索"

`js/core/solve.js` 会推理：线索优先传播，推不动了就假设。它如果有洞（一条不成立的推断
悄悄砍掉第二个解），它照样会一本正经地说"唯一"—— 而"唯一"是本仓对一张图**唯一**的断言。

所以 `js/core/enumerate.js` 是这么写的：**这个文件建表时一条线索都不读**。它把整支舰队一艘
一艘摆到空盘上（只避重叠与相接），记下每个完成布局产生的 `(行计数, 列计数)`，事后拿题面去
比对。它不 import 任何东西 —— 连 `placementsFor()` 都是从棋盘尺寸现推的，没有复用 `solve.js`
的 `segmentsOf()`。**两条腿共享几何，就共享几何的 bug。**

真正的独立腿是这两条加一个恒等式：`Σrows === Σcols === Σfleet`。

### 3.2 上限语义：读准 `count`

`countByTable()` 与 `solve()` 都在数到 `limit`（默认 2）时饱和。语义必须读准：

* `count === limit` 只表示"**至少** limit 个" —— 证伪唯一性够用；
* `count < limit && !truncated` 才是"精确" —— 证明唯一性必须如此；
* `truncated` 表示撞了预算，这个数字**没有意义**。调用方一律拒绝，不允许把截断解释成"多解"，
  也不允许解释成"唯一"。`make.verifyChart()` 两个都拒；`test/solve.test.mjs` 里
  `a starved budget says truncated instead of reporting uniqueness` 钉住它。

### 3.3 踩过的坑（真事）

`solve.js` 的 `segmentMargins()` 注释记着：早期版本提交一条船时只在**轴向两端**涂水。
于是同一个合法盘面可以从**两条不同路径**到达（第二个分支敢从同一个已提交格再长出另一条船），
一个真唯一的题面被数成 `count: 2`。修法是八邻域全涂 —— 它正是"对角规则从另一边读"。
这条 bug 不在求解器的任何断言里现形，是 `test/enumerate.test.mjs` 的逐题对账抓住的：
`4×4 · 1/2/3` 的 **176** 个题面**全部**在两条路线上跑，解数与解格集都要相同。

同类的一次：`enumerate.leaf()` 里 `key = rc + ':' + cells.join(',')` —— 两条等长潜艇交换位置
是同一张图，去重按**格集**而不是按落子顺序，否则表会虚胖、命中率假高。

### 3.4 `packCount` 的进制闸门

表把 `(rows, cols)` 打成 2n 位、n+1 进制的一个数，让一次比对变成一次整数比较。
**只在 n ≤ 8 时精确**（`9^16 < 2^53`）。`test/enumerate.test.mjs` 有一条专门的碰撞测试
（`packCount is exact where the table uses it`）。把棋盘放宽到 9×9 而不改这个函数，
两条腿会同时错成同一个数 —— 那是最坏的一种"对账通过"。

## 4. 难度是量出来的

`depth` = 求解器同时挂着的**假设层数**的最大值，`guesses` = 传播枯竭的次数。
单位是**一艘船**，不是一格。`solve.js` 头注释记着为什么：按格假设会让每张图都需要"十几次假设"，
把"线索自己就能收口"和"真得搜"这两类图的差别抹平 —— 第一版对**所有** 4×4 图报 depth 6..13，
那是一个关于搜索的数，不是关于题目的数。

可复现性优先于速度：`pickGuess()` 固定按"分支最少 → 候选最少"选格，`candidatesAt()` 固定按
长度降序、起始格升序展开，不读时钟、不用 RNG、不在猜测点缓存候选（缓存跨传播轮次是这文件
不许有的那类 bug）。`test/solve.test.mjs` 断言 `the answer is a function of the puzzle alone`。

0 不能是常量：`test/fixture.test.mjs` 手推了三个 fixture，把 `depth 0`、`depth 1`、
`count 2` 各钉一张图（`depth is not a decorative constant`）。

贴标签的唯一入口是 `make.bandOfDepth(depth)` —— `BANDS` 是 `{min,max}` 区间，
`bake.recheck()` 和 `test/lots.test.mjs` 都要求**出货行的 band 必须等于 `bandOfDepth(depth)`**。
所以一行不可能在 depth 3 上被盖成"纯推理"。

实测分布（本机 2026-09-27，`node tools/bake.mjs --check`）：

```
harbour  4×4 1+2+3    depth 0×16     159 掷 / 122 落子 / 16 收   13.1%   表 176
patrol   5×5 2+3+4    depth 0×16      63 /  51 / 16             31.4%   表 752
convoy   5×5 1+2+3    depth 1×16     293 / 293 / 16              5.5%   表 3944
blockade 6×6 2+3+4+5  depth 1×16     177 / 122 / 16             13.1%   表 6144
sortie   6×6 1+2+3+4  depth 3..9     32 /  31 / 16             51.6%   表 88872
battleline 7×7 2+3+4+5 depth 2..11    47 /  47 / 16             34.0%   表 248952
totals: 96 lots from 771 draws, 96 unique charts accepted (12.5%)
```

`convoy` 的 5.5% 不是命中率差，是带子窄：那一档要求 depth **恰好** 1，同一批掷子里
`tooEasy` 55 次、`tooHard` 84 次，被拒的是"太简单"和"太难"两头。bake 把拒绝原因原样打印，
所以这一格是可查的，不是猜的。

`harbour` 和 `patrol` 全 0 也是事实：这两档的题目是"传播自己收口"，它们之间**没有** measured
差别 —— 榜上的排序靠 tier 顺序，不靠一个被抹平的 depth。这一点 `README.md` 的诚实清单里也有。

## 5. 生成器与点击路径

`make.makeChart(tier, seed)`： seeded RNG 摆一支合法舰队（**拒绝采样**，最长船先放，
所以永远产不出非法海军；每次拒绝都记进一个计数器，不做"悄悄修复"）→ 读出 `(行,列)` 线索 →
`verifyChart()` 两条腿 + 三本账 → band 过滤。`maxAttempts` 夹住它。

点击路径上**没有任何搜索**：

* 战役 / 每日 / 随机：都从 `js/data/lots.js` 的 96 关里挑，`library.randomLot` 是
  `hashSeed % list.length` 的下标选择，不是生成。
* 提示：`solve.deduce()` —— 一次传播到不动点，无假设、无搜索，所以提示不会剧透；
  它写的每个格子都和那个被证明唯一的解一致（`test/solve.test.mjs` 两条断言）。
* 唯一被允许在浏览器里搜索的地方是 `window.fleet.probe()`，手势路径不调用它；
  `@boot` 用它证明"屏幕上的 1 是浏览器自己算出来的"。

## 6. bake 的复验链

`tools/bake.mjs`：`[1] 建表`（每档一张 `tableFor(n, fleet, {budget: 600000})`，
`clearTables()` 逐档重置，避免六档共 24 万格常驻）→ `[2] 掷题`（每档收到 16 关为止，
重复题面直接拒 —— 一个悄悄缩水的池子比一个明说的池子坏）→ `[3] recheck` → `[4] 写文件`。

`recheck()` 独立于生成路径，**从序列化后的题面重跑**：`solve()` 必须给出打印的 `count`、
`depth`、`guesses`；`bandOfDepth(depth)` 必须等于打印的 band；`verifyChart()` 必须两腿都过
（含"两腿给出同一格集"）。任何一条不成立 → `process.exit(1)`，文件不写。

所以印在产物上的数字不可能手工改对：`test/lots.test.mjs` 读同一份 `LOTS`，再跑一遍同样的判断。
`--check` 只是"跑到第 4 步不写"，用它可以在不改文件的前提下拿到全部数字。

## 7. 视图与台架的坑

### 7.1 像素层

* **devicePixelRatio**：`canvas.width = round(cssW * dpr)`（dpr 夹在 1..3）之后
  `setTransform(dpr,0,0,dpr,0,0)`。少了这一步 Retina 上线条糊、命中测试偏一半。
* **`getContext('2d', { willReadFrequently: true })`**：台架要 `getImageData` 读回位图指纹
  （`pixelsHash()` / `painted()`，步长 97 个像素，够密，能把 4×4 那 16 格的轮廓都采到）。
  不加这个 flag，Chrome 每次读回打一条 rendering 警告，"控制台必须干净"就会假红。
* **ResizeObserver**：`window.resize` 不覆盖面板文字回流、手机转屏、devtools 分屏 ——
  这些都改画布盒而不改窗口。命中测试把 client 像素映射回**上次量到的**几何，量晚了就点错格。
* **`pointAt()` 的返回值有两种坐标**：`{x, y}` 是 **client 像素**（和 `cellPoint()` 同一口径），
  `{cell: [x, y]}` 才是棋盘格。这层"内建 pointAt 收 canvas 局部坐标、外建收 client 坐标"的
  区分在 `js/view.js:501-511` 的注释里写得很细，注释里那句"answered two squares low and one to
  the right"就是它修掉的 bug —— 也正是下面第 1 条红的地基。
* 长按阈值 `LONG_PRESS = 450`（ms）与拖拽起手共用一个 `pointerdown`：超过它就不是拖船，是记号。

### 7.2 台架：2026-09-27 红的那 11 行，后来是怎么绿的（2026-09-28）

本机 `bash tools/verify.sh`（web `:5193`、devtools `:9353`）现在 `exit 0`：node 8 套 **104** 行、
浏览器 6 套 **151** 行（`@boot` 19 / `@play` 30 / `@routes` 22 / `@save` 26 / `@reloaded` 9 /
`@pointer` 45），控制台干净，收尾"Chrome 退出 + 临时 profile 已删"那条也过。
`js/core` 一条没改 —— 七条根因**全在台架与视图的坐标/事件契约上**，逐条如下（引用一律按断言名，
不按行号：行号会因为加一行注释而集体漂移，断言名不会）。

1. **`@boot` 的坐标口径**。断言 `the geometry maps a square to a point and back` 原先取 `back.x`
   当列号，而 `js/view.js:501-511` 的返回对象里 `x/y` 是 **client 像素**，棋盘格在 `cell` 字段。
   现在它同时验两头：`back.cell === [1,2]`（格号对）**且** `back.x/y === cellPoint(1,2)` 的像素
   （往返闭合）。只断格号会放过"像素是隔壁格的"那一类错，所以两条都要。
2. **`@play` 的参数顺序**。`water` 的签名是 `water(x, y)`（`js/main.js:157` 的 `commitWater`），
   台架把第一个参数当行读。`water is accepted where both lines read zero` 现在断
   `g.water(1, 0) === true && g.board()[1] === '~'` —— 下标 1 是第 0 行第 1 列，笔迹和坐标对得上。
3. **`playAll()` 踩在上一段的残局上**（@play 那 9 连红的直接原因）。裸 `load()` 不是新题面：
   `js/main.js:104-119` 的 `setGame()` 会 `store.loadProgress()` 把本机草稿复水回来，于是 `plan()`
   的三笔全撞船 → 实测 `{laid: 0, watered: 7}`。修法是 `load()` 之后紧跟 `reset()`
   （`the printed navy plays out through the gestures` 那一行），并且另起一条
   `@play` 断言把"撤销要一格一格走"挪到一张**还没解完**的图上 —— 图一旦 solved，`撤销` 按钮就是
   disabled 的，`undoOnce()` 只会点到一件灰掉的事。
4. **`@reloaded` 在 parse 期就死**：模板字面量里一个未闭合字符串。修的时候没有只补引号，而是加了
   一道 `node tools/playtest.mjs selftest`（`tools/verify.sh` 的第一步，排在端口预检**之前**）：
   把每段场景体喂一遍 `new Function()`，有一段解析不过就 `exit 1` 且不启动 Chrome。一个未转义的
   引号在浏览器里伪装成"页面没起来"，而在 node 里就是一行 SyntaxError。
5. **`@pointer` NO RESULT**：驱动把轴字母裸插进 `window.fleet.linePoints(0,1,3,h)`，页面里
   `ReferenceError: h is not defined`。现在 `axis` 走 `JSON.stringify` 再注入。
6. **CDP 的 release 必须报 `button: 'left'`**。`Input.dispatchMouseEvent` 的 `mouseReleased` 带
   `button:'none'`（照抄了"没有按键按下"的字面意思）时，页面**收不到 pointerup**：`up()` 永远不跑，
   拖船不落地。症状是"鼠标点了没反应"，看起来像断言写错，实际是事件根本没送到 —— 台架第一版整个
   指针套件红在这条上。
7. **松手在棋盘外不是"手势丢了"，是"手势被记错了地方"**（这一条是产品 bug，不是台架 bug）。
   canvas 没有 pointer capture 时只会收到落在自己盒内的 `pointerup`；拖出海图再松手，`press` 一直
   armed，450 ms 后长按计时器在**起手那一格**画了个 `?`。修在 `js/view.js:146-150`
   （`setPointerCapture`），守着它的是 `@pointer` 的
   `a drag released outside the chart is answered, not left to rot`。加这条断言时先跑了一次负控：
   只把 capture 那行注掉，红的就是这一行，别的 42 行照旧绿。

台架本身另外几条硬规矩（本仓已按这些实现，改的人别退回去）：导航之后轮询
`window.fleet.state.id` 而不是 `sleep()`；结果 JSON 用花括号计数从 console 里截，
不要 `JSON.parse(整行)`；Chrome 用 `mktemp -d` 独立 profile，`/json/version` 和 web 根目录
都就绪才开始，`trap cleanup EXIT` 里 `wait` 每个后台 PID；开头查端口，占了就退 5/6
（否则会把别人 Chrome 的 tab 当成自己的，然后把"0 browser asserts"当成通过）；
**点任何控件之前先量它自己的命中盒**（`@pointer` 开头那条
`every control the mouse is about to press is on screen and hit-testable`：盒在视口内、
按钮最小边 ≥ 24 px、`elementFromPoint` 在自己的中心点命中自己），因为 `el.click()` 在
元素被挤出屏幕、被别的区块盖住时照样派发 —— 兄弟仓 hitori 就红过 13 行"点了没反应"，
而真正的 bug 是一条 `display: grid` 把控件顶到了折叠线以下。这条断言的负控实测过：
给 `.controls` 加一句 `margin-top: 1400px`，只有这一行红（打出来的 detail 直接点名
`undo / hint` 的 `inView: false`），其余 44 行照旧绿；
`@reloaded` 必须排在 `@save` 之后且在自己的驱动进程里跑 —— 它读的是 `@save` 留在磁盘上的草稿；
收尾"没留 Chrome"那条要排在 kill **之后**并按本次的 `--user-data-dir` 判定，否则一次干净运行也
永远报"LEFTOVER"，把真红埋在进程列表底下。

## 8. 刻意不做

线索极小化（只证唯一，不证每条线索必要）· 8×8 及以上（`packCount` 的 n ≤ 8 闸门 +
表大小爆炸）· 点击时生成或全枚举 · 成就 / 排行榜 / 签到 / 内购 / 云存档 / 分享战绩 ·
打包器与任何图片/音频/字体资产 · npm 依赖。

`tools/bake.mjs` 里 band 标签那段复验断言（同一个判断、同一条报错文案）以前**逐字重复了两遍**，
是赘肉不是 bug。2026-09-28 删掉了一份，现在只剩 `recheck()` 里的那一条；删完重跑
`node tools/bake.mjs --check`，96 关的复验数字一个没变。
