# deliverable — z-biz-game-fleet-cos

基线 HEAD `09be135` → 本次提交。所有数字都是本机现跑的输出，命令原样附在下面。

## 0. 一句话

并线把两侧**互斥**的存档设计按块拼在一起，拼出一个 ESM 同名顶层声明 SyntaxError —— 整局不可玩
（模块图一行都不执行，页面停在空壳）。本次按本仓自己的闸把存档实现收成一份、删掉引用已丢函数的死代码段，
另把离线壳列全、主题色对齐真底色、并线新增的 4 条引用补进部署集钉数。

## 1. 整局级缺陷：ESM 同名顶层声明 + 互斥的两套存档判据

**旧代码错在哪**

并线把两侧各写一遍的 `backend()` 都留在了 `js/core/storage.js`（旧 40 行 / 56 行两处）。
ES module 是严格模式，同一作用域里两个同名函数声明直接是 SyntaxError：
`Identifier 'backend' has already been declared` —— 整个模块图一行都不执行，页面停在空壳。

更深一层：并线还把较新侧（`e75124c`, 10-03）的 `sanitize*` 设计与较旧侧（`af84c2e`, 10-01）的
`decode*` + 审计账本**并排**留在同一个文件里，而两侧对同一份存档的判据互斥：

| | 较新侧 `sanitize*` | 较旧侧 `decode*` |
|---|---|---|
| `best` 认不到 | `0` | `null`（"还没通" ≠ "通了但 0 次"）|
| `progress`/`daily`/`stats` | 整段不认，不逐键校验 | 逐键校验，坏的那键只丢自己 |
| `unlocked` | `Number('9') > 0` → 抬高成 9 | 只认 ≥1 的数，`'9'` 不抬高 |
| 坏数据留痕 | 无 | `store.audit()` 报出丢了哪几条 |

而本仓的闸（`test/storage.test.mjs`，308 行）正是较旧侧那版，对上面每一条都有断言 ——
改前的 14 条红全部是 `audit is not defined`：`audit` 既是未声明的模块级变量（并线丢了
`let audit = {...}` 声明与全部自增语句），`read()` 里 121-135 行那段「第二段」又是**死代码**
（`parsed` 从未被赋值，`if (parsed && ...)` 恒不成立），它调用的
`decodeRecords/decodeDaily/decodeProgress/decodeStats` 四个函数已被较新侧的 `sanitize*` 顶掉。

**新代码为什么对**

- **裁决以闸为准**：闸是本仓唯一能判对错的量具；测试文件属于较旧侧，且与较新侧语义互斥，
  两侧不可能同时满足，只能选闸那一侧。
- 保留**较新侧**独有、且与闸不冲突的那部分：版本门（`export const SAVE_VERSION = 1`、
  `blank()` 带上 `v`、读档只认 `v === SAVE_VERSION`）。
- 恢复**较旧侧**被并线丢掉的那部分：`let audit = {...}` 声明、`whole()`/`stamp()`、
  `decodeRecord/decodeRecords/decodeDaily/decodeProgress/decodeStats` 与各自的记账自增。
- 删掉并线拼出来的那段死代码（`read()` 里的 `parsed` 第二段）。
- 同步删掉被顶掉的 `sanitizeRecord/sanitizeRecords/recordNum`：它们是同一件事的第二套实现
  （`best` 退成 0），与闸的判据互斥，留着只能二选一；留着 `recordNum` 还会让人以为
  `best` 认不到时会退回 0 而不是 `null`。
- `backend()` 只留一份（较新侧的名字 + 较旧侧的 localStorage 适配器写法），
  读写都走它返回的适配器，删掉 `ls === globalThis.localStorage` 的死分支
  （适配器不是全局量本身，那个比较永远为假）。

改前 → 改后（同一份坏档：`records` 里 null 与字符串各一条、缺字段/类型错/越界各一条）：

```
改前  14 条红全是 audit is not defined；模块图整段不执行（SyntaxError）
改后  rows: 12 fail: 0     （12 个测试文件全绿）
      store.audit().records === 2、.progress === 2、.daily === 2、.stats === 2
      坏记录只丢自己：'harbour-01' 的 best 原样是 4、plays 原样是 2
```

## 2. 文档锚点漂移

`DESIGN.md` 两处引用的行号对不上并线后的结果：`commitWater` 的 `js/main.js:157` → `195`，
`setGame` 的 `js/main.js:104-119` → `135-151`。D4 锚点腿逐条核过（被指的行段整段不许是空行）。

## 3. 离线壳

`sw.js` 之前只缓存 `index.html` + `manifest.webmanifest` 两件 —— 断网时界面能开、引擎与纹理全缺，
画布空着、按钮点了没反应。现在 `SHELL` 列全 25 条（界面 / 样式 / 15 个 js 模块 /
运行时真读的 `assets/textures/chart-paper.png` / 图标），install 改成逐条
`Promise.allSettled` —— 一条 404 不作废整壳（`addAll` 是全有全无的）。
这条与存档那边同一条规矩：坏一条只丢那一条。

## 4. 主题色

`manifest.webmanifest` 的 `theme_color`/`background_color` 是 `#0a0a12`，
而 `css/game.css:6` 的 `--bg` 是 `#0f1319` —— 安装后的标题栏和画布底色对不上。改成 `#0f1319`。

## 5. 部署集钉数

并线给这个仓新引入了 4 条页面引用，`tools/deploy-set.mjs` 的
`EXPECT_CHECKS(30)`/`EXPECT_ROWS(49)` 钉数没跟着走 ⇒ R12/R13 两条红。
逐条核过这 4 条新增引用都是真实存在、非 0 字节的文件（`DEPLOY_SET_DUMP=1` 的出处表可逐条对）：

```
新增  ref  css/game.css  ../assets/sprites/hull-plate.png  @css  => assets/sprites/hull-plate.png
新增  ref  js/main.js     ./audio.js                        @js   => js/audio.js
新增  ref  js/main.js     ./pwa.js                          @js   => js/pwa.js
新增  ref  js/pwa.js      ./                                       => index.html
丢失  （无）
```

所以把钉数改成 34 / 53 —— 闸自己的口径就是「改了页面就把 EXPECT_CHECKS 一起改，别让它默默变少」。

## 6. 真实文件清单

```
DESIGN.md              2 行改（锚点行号）
js/core/storage.js     72 增 45 删（存档实现收成一份）
manifest.webmanifest   2 行改（主题色）
sw.js                  37 增 3 删（SHELL 清单 + 逐条隔离）
tools/deploy-set.mjs   2 行改（钉数 30→34 / 49→53）
deliverable.md         本文件（审计报告里本仓的 `missing:deliverable.md` 欠账）
```

删行审计（`git diff --numstat`）：共 54 删行，逐类 ——
`recordNum` 4（被顶掉的第二套归一）、`sanitizeRecords` 3、`sanitizeRecord` 2（同一件事的第二套实现）、
`PRECACHE` 2（换成 `SHELL`）、`defaultBackend` 1 + 重复的 `backend()` 4（同名顶层声明，只留一份）。
`decode*`/`whole`/`stamp`/`audit` 只在**增**侧 —— 审计账本是被恢复的，不是被删的。
玩法数据零删行：`js/data/lots.js` 未改，96 关题面原样。

## 7. 验收结论（本机现跑）

```
$ node z-biz-game-lead/003_辅助能力/polish/script/cos_load_sweep.js z-biz-game-fleet-cos
z-biz-game-fleet-cos                     | LOADED          ← 改前是 LOAD-ERROR
$ python3 z-biz-game-lead/003_辅助能力/polish/script/scan_cos_static.py . z-biz-game-fleet-cos
汇总: {}
$ npm test --silent
rows: 9 fail: 0    rows: 10 fail: 0   rows: 15 fail: 0   rows: 13 fail: 0
rows: 15 fail: 0   rows: 12 fail: 0   rows: 13 fail: 0   rows: 11 fail: 0
rows: 18 fail: 0   rows: 12 fail: 0   rows: 14 fail: 0   rows: 14 fail: 0
$ node tools/deploy-set.mjs
部署集：34 条引用（含 3 张位图尺寸核对），失败 0 项
rows: 53 fail: 0
$ node tools/deploy-set-selftest.mjs
DS_SELFTEST rc=0（0=每一刀都按预期发力、阴性对照按预期不发力）
DS_SELFTEST_BASELINE 部署集：34 条引用（含 3 张位图尺寸核对），失败 0 项 rows=53
$ bash tools/verify.sh
=== @boot === rows: 19 fail: []      === @play === rows: 30 fail: []
=== @routes === rows: 22 fail: []     === @save === rows: 26 fail: []
=== @reloaded === rows: 9 fail: []    === @pointer === rows: 45 fail: []
=== browser rows: 151 ===
=== console ===
(none)
=== chrome exited, temp profile gone ===
=== ALL GREEN ===
```

`verify.sh` 是本仓自己的整闸：node 套件 + 部署集闸 + 部署集自测 + 真实浏览器（headless Chrome over CDP）
六个场景 151 行断言 + console 干净 + 跑完没有残留 Chrome。**ALL GREEN / rc=0**。

## 8. 未实现 / 需人接手

- **`cos_frame_probe.js` 对本仓不适用**：探针把 `<script src>` 当 classic script 在 vm 里跑，
  而本仓入口是 `<script type="module" src="js/main.js">`（`index.html:102`）⇒ 探针报
  `Cannot use import statement outside a module`，三个频率档全 ERR。这是探针的适用边界，不是本仓的缺陷。
  等价的帧率保证由本仓自己的闸承担：`test/view.test.mjs` 的
  「同一 sim 步号下 30/60/120Hz 逐字段全等：抖动、时钟、高亮都不看墙钟」在闸里跑通。
- `assets/og/fleet-og-cover.png` 盘上有、页面没引用（`og:image` 指的是 `icons/icon-512.png`，
  部署集 R7 已通过）。没接线也没删 —— 接线属于另一次改动。
- 审计报告（`z-biz-game-lead/001_项目认知/003_审计报告.md`）里本仓挂着 `missing:deliverable.md`，
  本文件补上；其余两条（`missing:LICENSE`、`missing:.github/workflows`）本仓不挂。
