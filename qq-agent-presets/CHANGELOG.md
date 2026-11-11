# 更新记录（Changelog）

本文件记录 `qq-agent-presets` 插件的版本演进与每次改动的动机。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 许可：PolyForm Noncommercial License 1.0.0（见 [LICENSE](LICENSE)）。本插件随 `qq-bridge` 主仓库分发，属同一许可。

---

## [1.3.1] — 2026-11-10

发布前的一轮完整代码复查（静态体检 + 逐文件走查 + 真机接口回归 115 项）。
修掉的都是**真的会咬人**的问题，不是风格。

### 修复

- **`readJsonBody` 曾把「读坏」与「没传」混为一谈（本版最要紧的一条）。**
  超长 body、非法 JSON、连接中断三种情况一律 `resolve({})`，于是任何对 `{}` 校验不严的
  `setXxx` 都会把「畸形输入」执行成「清空 / 关掉」——`/life {}` 误关生命开关、
  `/roles/activate {}` 误清人格，根子都在这。
  现在读坏时 `reject` 一个 `BodyError`，路由层回 **400 / 413** 并带可读原因，
  handler 根本不会被调用；「超长」也不再 `req.destroy()`（那会让客户端只看到「连接被重置」），
  改为读完剩余字节后丢弃。
- **超长请求体现在返回 413，不再把连接掐断。** 上限仍是 64 KiB。
- **`overview` 的三路桥接请求改为并行。** 原来 `status → model → series → summary` 串行，
  桥接「接了连接但不回话」时最坏要等十几秒；而面板每 10 秒刷一次，请求会一层层叠起来。
- **面板轮询加防重叠。** `load()` 用 `loadingRef` 挡住并发，桥接卡住时不再堆积请求。
- **看护循环的一次性首探定时器纳入清理。** `restartLoop()` 里的 `setTimeout(tick, 1200)`
  原来既没存也没 `unref()`，热重载一次就多留一个待触发的探活。
- **Kokoro 启动失败路径补 `clearTimeout`。** 失败后那个 30 秒超时定时器还在挂着。
- **`setSessions` 校验入参类型。** 传 `groups: {}` / `groups: 123` 时 `toStringList` 会得到空数组，
  等于「传了字段但清空白名单」；现在非数组/非字符串直接 400。
- **`requestJson` 加 32 MiB 响应上限。** 桥接正常时最大响应只有几十 KB，这道闸只为兜住
  「某个接口误返回整份日志」这类异常，不让一次请求把主进程内存拖垮。
- **「清除当前人格」加确认弹窗。** 这是不可逆的破坏性操作（清空后大肥鱼不再受角色卡约束），
  与「删人格文件」「删表情」保持同一套确认礼仪。
- 清掉 `index.js` 注释里一处被按字节截断的中文（6 个替换字符 → 「乱码」两个字）。

### 修复（第二轮：逐文件走查 + 独立审查）

上面是第一遍。第二遍换了视角重读，又挖出 14 处——多数是「某个入口没跟上同文件其它入口的规矩」。

- **Kokoro 的 `stdin` 没有 `error` 监听（最危险的一条）。** 它是常驻进程，
  在两次合成之间被外部杀掉（任务管理器、模型目录被移走）时，下一次写入会 `EPIPE`；
  没有监听器的 stream error 会抛成**未捕获异常**，把整个 DSH 主进程一起带走——
  表现是面板与正在进行的 QQ 会话同时消失，日志里只剩一个裸 `EPIPE`。
- **`runRestart` 的 `settle` 没有幂等。** spawn 失败时 `error` 与 `exit` 会同时触发，
  于是「启动脚本结束」被记两次、`running` 被置两次、耗时按已变过的 `startedAt` 重算——
  日志里的秒数是错的。
- **`/voices/send` 的类型与准入跟 `/voices/delete` 不一致。** 删有扩展名白名单、发没有
  （发一个 `README.md` 会一路送到桥接才失败）；`volume` / `loudness` 也没校验，
  对象或超大数会直塞给桥接侧的 ffmpeg 参数解析。现在按 `voice-core.js` 的口径校验：
  `volume` 是 0.1~4 的倍数或 `"3dB"` 这类字符串，`loudness` 是
  `quiet`/`normal`/`loud` 或 -40~-5 的 LUFS 数字。
- **`/watchdog` 空 body 会被当成「全默认」并回 ok:true**，同时把状态重写一遍、探活循环整个重建。
  现在要求至少给一个已知键，且布尔/数值分别校验（数值带区间）。
- **`/mode` 把空 mode 直接转给桥接。** 桥接对空串的语义是「清除」，而面板其它写接口
  对空 body 一律 400——只有这里漏了。
- **`/power` 的 catch 分支没带 `httpStatus`**，于是「powercfg 全部失败」按 200 返回，
  任何按状态码判断的调用方都会当成成功。
- **账本读不到时 `spend.today` 是 0**，界面渲染成「¥0」——与「今天真的一分没花」无法区分。
  现在给 `null`，面板显示「—」。这条是 README 自己写的原则（「0 和不知道是两回事」），
  实现却没跟上。
- **`/stickers/scan` 的 `adopt` 默认是 `true`。** 直接调这个接口传 `{}` 就会把目录里
  所有未登记文件一次性写进表情库——正是 `readJsonBody` 那节反复强调的
  「缺省输入被执行成破坏性动作」。现在默认 `false`，界面照旧显式传值。
- **`/sessions` 的临时文件名只含 pid。** 同一进程内两个并发请求会抢同一个 `.tmp-<pid>`：
  A 写完、B 覆盖、A rename 成功、B rename 拿 ENOENT；更糟的是落盘内容与校验过的内容不一致。
  现在加随机后缀。
- **`/capabilities` 读 `social-v2.json` 时不去 BOM**，与同文件的 `readJsonFile` 不一致。
  文件被编辑器加上 BOM 时它会抛错并被吞掉，面板「记忆」一行静默显示「还是空的」，
  把排查引到「桥接没存」上。
- **`/voices/prefs` 对非法 `engine`/`voice`/`rate` 静默保留旧值却回 ok:true**，
  界面弹「已切换」而实际没换——这种「成功但没生效」比报错难查得多。现在严格 400。
- **`ctx.effect` 清理里调的 `watchdog.clearTimer()` 是空操作**（`setTimer` 全文件无调用），
  却让人以为定时器都收干净了。删掉，换成说明注释。
- **语音体检的 15 秒超时只 `child.kill()` 不 `resolve`。** Windows 上 PowerShell 偶尔不响应
  `TerminateProcess`，这个 Promise 会永远 pending，把 `/capabilities` 与 `/voices` 一起挂住。
  现在超时后再等 1.5 秒自行收尾。
- **面板的 `act()` 没有 `catch`。** `okText(result)` 抛错（结果形状不对时很常见）会变成
  未处理拒绝，用户只看到按钮转完就没了。现在错误会 toast 出来，`okText` 抛错也兜住。
- **字节通道的目录穿越加固。** `/sticker-file` 与 `/voice-file` 改走 `readInsideDir()`：
  `realpathSync` 解两次符号链接 + 前缀比较（必须带分隔符）+ 必须是普通文件；
  `data:` 分支收紧为只放行 `image/`。

### 移出仓库

- 删除 `client.js.bak-trim` / `index.js.bak-trim`（界面精简时的比对备份，不应随包分发）。
- `.gitignore` 改为**插件自身**的规则（原文件是从主仓库根目录抄来的，里面的
  `/PROJECT_GUIDE.md`、`docs/audits/`、`audio/`、`/assets/project-intro.mp4`
  在本包里并不存在，属噪音）。

### 验证

- 静态：`node --check` 六个 JS 全过；四个 `.patch.yml` 用 `js-yaml` 解析通过（id 各自正确）；
  `locale/{zh,en}.json` + `package.json` `JSON.parse` 通过；UTF-8 无 BOM。
- 真机接口回归 **115/115**：6 条 GET 全 200；16 条写路由 × 6 种畸形 body（空对象 /
  字符串当布尔 / 数字当布尔 / 数组 / 原型污染 / 嵌套对象）全部 4xx 或幂等 200，**无一 5xx**；
  坏 JSON、纯文本、`null`、顶层数组均 400；80 KB body → 413；
  事后快照比对确认**生命开关 / 运行模式 / 人格 / 免打扰 / 只回消息 / 锁定模型 / 唤醒配置
  七项状态一字未变**；`({}).polluted === undefined`。
- 字节通道：`/sticker-file` 与 `/voice-file` 的 `..%2F` 穿越返回 400，
  中文文件名正常返回 200（实测 161,324 字节 `audio/wav`）。
- 路由一致性：`client.js` 里 26 个 `post()` + 4 个 `req()` 路径与 `index.js` 的 31 个
  `route()` 逐一配对，无孤儿路径。
- 仓库既有测试：`scripts/test-agent-preset-patches.mjs` 契约通过；
  `scripts/test-audit.mjs` → `57/57 scripts passed`。
- 第二轮修复后**复跑同样全过**：115/115 回归、57/57 审计。新增的 400 逐项实测：
  `/watchdog {}`、`/mode {}`、`/mode {mode:"zzz"}`、`/voices/prefs {engine:"xx"}`、
  `/voices/prefs {rate:"abc"}` 全部 400 并带可读文案；`/stickers/scan {}` 只清点不入库
  （62 个文件全 `inLibrary:true`，`adopted` 为空）。
- **一个反复踩过的坑，写下来免得再犯**：用 PowerShell 的 `node -e "..."` 处理含中文或含
  反引号的文本，会被 PowerShell 的转义规则吃掉（反引号是它的转义符、双引号里的 `$p` 会被展开），
  轻则路径拼错，重则把文件里全部中文替换掉。**改这类文件的脚本一律先写成 `.mjs` 文件再执行。**

---

## [1.3.0] — 2026-11-10

> **版本号说明**：上一版（1.13.0）刚发布就按要求改成 `1.3.0`——用户希望版本号停在
> `1.x` 的小数字上，不再往三位数的次版本累加。三处版本来源（`package.json`、插件卡片、
> `D:\DSHHome\profiles\desktop\.dsh-market\state.json`）统一为 `1.3.0`。

描述里补回「生命开关」，并把六节面板各自**真正有什么**写全；顺带修正一处与现状不符的措辞。

### 变更

- **`description` 重写（208 字符）。** 上一版说「生命与看护（自动重启、免打扰、合盖保活）」，
  漏了两个后来加的东西：面板上的**生命开关**（一键断/接 QQ 全部功能）与**唤醒调整**（只回消息）。
  同时六节里的「表情与语音 / 会话 / 人格」写得过于抽象，读者看不出里面有表情库、语音合成、
  白名单、角色卡。新描述逐节点名：生命开关与掉线看护（自动重启、唤醒调整、免打扰时段、合盖保活）、
  花费与模型（今日花费、当前模型、锁定默认模型）、运行模式、表情包与语音、会话管理、人格角色卡。
- **「工具面守卫」改为「工具守卫」。** 「工具面」是内部叫法，插件卡片上没人认得。
- `locale/zh.json` 的 `meta.description` 与 `package.json` 的 `description` 保持同一份文本；
  `locale/en.json` 同步重写英文版（485 字符）。
- `D:\DSHHome\profiles\desktop\.dsh-market\state.json` 的 `notes["qq-agent-presets"]` 同步为同一份文本
  —— 插件卡片上显示的那行描述读的是这份备注，不是 `package.json`。

### 验证

- 三个文件的描述文本逐字一致（`package.json` / `locale/zh.json` / `.dsh-market/state.json` 的 notes）。
- `package.json`、`locale/{zh,en}.json` 均为 UTF-8 无 BOM、纯 LF、`JSON.parse` 通过。
- 面板节数与描述一一对应：`01 生命与看护`、`02 花费与模型`、`03 模式`、`04 表情与语音`、
  `05 会话管理`、`06 人格`（取 `client.js` 的 `// ── NN 标题 ──` 分节注释实测；另有 `08 眼睛` 已从界面摘下，不计）。
- `node --check` 全部通过；`node scripts/test-audit.mjs` → `57/57 scripts passed`。

---

## [1.12.0] — 2026-11-10

把插件描述与面板的真实形状对齐，并作为可上传的完整包发布。

### 变更

- **`description` 重写。** 原描述 400 余字符，在说完「工具守卫只放行 QQ 桥接工具」之后还追加了
  「上下文压缩工具例外放行，见 README 二节」这类只有翻了文档才用得上的细节，再往后又逐条罗列面板
  六节各自包含什么。插件卡片与市场列表的宽度装不下这些，读者在第二行就丢了主线。新描述 184 字符，
  只回答三件事：**装了什么 preset、守卫干什么、面板有哪六节**——细节留给 README。
- `locale/zh.json` 的 `meta.description` 与 `package.json` 的 `description` 改为同一份文本
  （此前两处各写一版，措辞已经漂移）；`locale/en.json` 同步重写英文版。
- 描述不再提「preset 可视化 / 守卫可视化 / 眼睛可视化」。这三块在 1.7.0（删掉「角色预设」与
  「工具守卫」两节）与 1.9.1（「眼睛」节从界面摘下）之后都已不在界面上。**工具守卫本身仍是本包的
  核心机制**——只是它没有可看的界面，权威只有 `qq-tool-restrict.mjs` 里那份名单。

### 验证

- `package.json` / `locale/{zh,en}.json` 三个文件：UTF-8 无 BOM、纯 LF、无替换字符。
- `node --check` 对 `index.js` / `client.js` / `mode.js` / `qq-tool-restrict.mjs` / `qq-self-key.mjs` 全部通过。
- 面板实际节数与描述一致：`01 生命与看护`、`02 花费与模型`、`03 模式`、`04 表情与语音`、
  `05 会话管理`、`06 人格`（`client.js` 的 `// ── NN 标题 ──` 分节注释与之一一对应）。
- `node scripts/test-audit.mjs` → `57/57 scripts passed`；插件专项 7 个脚本全部 exit 0。

### 发布

- 新增打包脚本 `scripts/pack-plugin.mjs`，产物 `dist/qq-agent-presets-1.12.0.zip`。
  清单直接取自 `package.json` 的 `files` 字段，不手写白名单，避免以后加了文件却忘了同步脚本。
- 包内不含 `*.bak-trim`（1.7.0 的临时备份）、`node_modules/`、`state/`、`*.log`。

---

## [1.11.0] — 2026-11-10

### 新增

- **「锁定默认模型」开关。** 面板「02 今日花费」节「正在使用」行下方新增开关，
  背后是桥接的 `POST /api/dsh/lock-default-model`（写 `config.json` 的 `dsh.lockDefaultModel`）。
  开启后 `checkDsh()` 每个探活周期都会把 DSH 全局默认模型（`agent-default-model` 设置命名空间）
  同步成 `config.json` 的 `provider/model/reasoningEffort`，把 workbuddy/hy4free 之类的外部默认
  挤出去；关闭后桥接不再碰 DSH 全局默认模型，以 DSH 界面里的手动选择为准。
- 桥接新增 `syncLockedDefaultModel()` 与 `readDshGlobalDefaultModel()`：
  前者只在 `lockDefaultModel===true` 时干活、与当前配置完全一致就跳过（不 bump revision、不刷日志）；
  后者从 `settings.describe` 的 `agent-default-model` 命名空间读 provider/model（user 层优先、value 回退）。

### 变更

- `GET /api/dsh/model` 返回体新增 `lockDefaultModel`。
- 插件 host 新增 `POST /qq-panel/api/lock-model`，`overview.model` 暴露 `lockDefaultModel`。

### 注意事项

- 这是对「模型被私自改回去」的第二层治理（第一层是 1.9.x 的「复用会话尊重管理员手动选择」，
  见下方 1.9.0 段）。锁定开关只影响 **DSH 全局默认模型**，不覆盖某个会话的手动选择——
  两者是不同层级，互不打架。

---

## [1.10.0] — 2026-11-10

修「每醒一次记忆就断一截」。截图里小鲸鱼原话：

> 「就是每醒一次记忆就断一截，之前聊到哪儿全靠几行备忘」
> 「群里谁喜欢啥、上次说到哪，睡一觉起来又得重新认一遍」

它不是矫情。旧实现有三处真问题，任何一处都足以让「记忆」变成摆设。

### 修复

- **话题 24 小时没被提起就被静默删掉。** `appendMemoryV2()` 里那句
  `Date.now() - t.lastMentionAt < 24 * 60 * 60 * 1000` 直接 `filter` 掉过期条目，
  而 `lastMentionAt` 只有在新消息**包含话题前 10 个字**或**包含参与者名字**时才刷新。
  「周末要不要去骑行」这种一句话说完就搁下的事，睡一觉必然消失。
  改为 **14 天**（`MEMORY_TOPIC_TTL_MS`），并注明「刻意不再用 24 小时」。
- **超限淘汰砍错了人。** 原来 `st.activeTopics.splice(0, len - 20)` 按**插入顺序**砍最早的，
  于是一个「排在最前面但刚刚还被反复提起」的老话题会被误杀。
  改为先按 `lastMentionAt` 升序排，再砍最久没提起的；上限 20 → **40**。
- **印象按对象键顺序取前 10 条，新认识的人永远进不去。** 30 个老成员的会话里，
  今天刚进群的人写在对象末尾，`slice(-10)` 取的是「最后插入的 10 个」——
  一旦对象稳定下来就不再翻页。改为**按 `lastSeenAt` 降序**取前 20 条（`MEMORY_PROMPT_IMPRESSIONS`）。

### 新增

- **`memberActivity`：桥接自己维护的「最近谁在说话」。**
  新函数 `recordMemberActivityV2(st, msg)` 在 `appendSocialV2Message()` 落盘前调用，
  每条群消息都记一笔 `{ count, lastAt, lastText }`（只留最后一句，截 60 字，最多 100 人，
  跳过 `msg.isSelf`、跳过原型链键）。
  动机：旧体系里「记住」完全靠模型自觉调 `qq_memory_append`，实测两个会话的话题/印象**长期是空的** ——
  不写就等于没记忆。现在模型一次都不写，醒来也至少知道「这群人是谁、上次是谁在说话」。
  唤醒提示词新增第四节 **【最近谁在说话】**（按 `lastAt` 降序取前 10，
  格式 `- 名字（共 N 条，最后一次 X前）：「最后说的那句」`）。
- **唤醒提示词新增【记忆习惯】（`memoryHintLine`）。** 紧跟 `memoryLine` 之后，
  只有 `socialV2.tools.memory` 开启时注入：明说「上面那段是你自己攒下来的，不会自动更新，
  这轮聊出新东西就在收尾前用 `qq_memory_append` 记一条，没写的就等于没发生过」。
  不加这句时模型把记忆段当背景读过去，从不往回写。
- **话题行信息密度**：参与者名单 `（小明、阿强，最多 4 个）`、隔天标注
  `（隔天了，可能已经聊过）`、「多久前」改用 `describeAge()` 统一口径（`X分钟前/X小时前/X天前`），
  印象每条带「，X天前」。

### 变更

- `formatMemoryV2()` 注入条数：话题 `slice(-10)` → `slice(-20)`（`MEMORY_PROMPT_TOPICS`），
  印象 10 → 20。
- 状态结构三处同步补 `memberActivity`：新建会话 `Object.create(null)`、
  加载时过滤原型链键、落盘时兜底 `{}`。

### 面板

- `/qq-panel/api/capabilities` 的 `memory` 段新增 `memberActivity` 计数，
  `hasAny` 判定与 `categories` 都把它算进去（新类别 `最近谁在说话`）。
  `client.js:2311` 那行是把 `m.categories` 全量 `map` 拼出来的，**无需改客户端**即自动显示。
- README 补两节：「记忆为什么是空的」加了 `memberActivity` 的说明，
  新增「记忆为什么会『一觉醒来断一截』」讲清 24 小时那条线和五个对照改动。

### 验证

- 行为断言 `_mem_test.cjs`（从 `bridge.js` 源码里切出常量与三个函数、用桩跑）：
  **20 passed, 0 failed**，覆盖「30 小时前的话题还在 / 20 天前的被清 / TTL 是 14 天 /
  隔天标注 / 参与者 / 待追问 / 新认识的人能进印象且排最前 / 自己说的不记 / 计数累加 /
  只留最后一句 / `__proto__` 被挡 / 老而活跃的话题不被淘汰 / 空状态返回空串」。
- `node --check src/bridge.js`、`node --check plugins/qq-agent-presets/index.js`、`node --check client.js` 全 exit 0。
- `cmd /c "node scripts\test-audit.mjs"` → `Audit suite: 57/57 scripts passed.`，真实退出码 0。
- 热重载两次后 `/qq-panel/api/capabilities` 返回的 `memory.categories` 已含第四个类别
  （`memberActivity`），`/qq-panel/api/overview` 正常。
- 备份：`src/bridge.js.bak-mem`（改码前 789166 字节）。

### 注意

- **这两块不会立刻长出内容。** 旧数据里三个会话的记忆本来就是空的（模型从没写过），
  新代码只保证「从现在起每条群消息都会记进 `memberActivity`」「话题不再 24 小时过期」。
  要看到【最近谁在说话】有内容，得等群里有新消息进来。

---

## [1.9.1] — 2026-11-10

照 app 的排版把整块面板重排了一遍：能去掉的都去掉（**只去掉界面，代码一行没删**），
做到「不用每次上下翻找各项功能」。八节压到六节，页头加一条导航 chip。

### 变更

- **`01 生命开关` + `02 掉线看护` 合并成 `01 生命与看护`，左右两栏。**
  左栏只回答「现在能不能用」：大开关、四环链路体检、四格事实（角色 / DSH / SnowLuma 接收链路 /
  管理员 QQ）、白名单 chip。右栏只回答「怎么让它一直能用」：自动重启、探活间隔、
  一键拉起、只回消息、免打扰、合盖保活、上次拉起、脚本与事件日志。
  窄屏（`@media (max-width:900px)`）自动塌成上下两段 —— 两栏在 900px 以下没有立锥之地。
- **`08 眼睛` 从界面上摘掉。** 它要按会话拉全量消息（这批请求里最重的一个），
  展示的又是与「会话」「表情」重叠的东西，日常用不上。**代码保留**：`EyesSection` 组件、
  `loadEyes`、host 的 `/eyes` 与 `/eyes/images` 路由全在，只是不再渲染、不再预拉。
  想放回来把 08 那段的 `null` 换回 `h(EyesSection, {...})`，并把 `loadEyes('')` 加回首屏 effect。
- **节号重排**：`01 生命与看护 / 02 今日花费 / 03 运行模式 / 04 表情与语音 / 05 会话 / 06 人格`，
  连续无断号；`会话管理` 的标题也收成 `会话`。
- **页头导航 chip**：`NAV` 数组定义 6 个目标，点一下先 `setNavSignal` 把目标节撑开再
  `scrollIntoView`。滚到一个收起的节上等于没跳 —— 所以撑开必须先于滚动。
  `Sec` 新增两个可选 prop：`id`（生成 `#qqp-<id>` 锚点）与 `signal`（导航信号，
  `signal.id === id` 时 `setOpen(true)`）。
- **表情缩略图再收一档**：格子 `82×44` → `62×34`，瓦片字体 `10px → 9px`，
  备注/原图名/标签三行压成两行（`-webkit-line-clamp:2`），原图名与标签挪进 `title`；
  瓦片里的按钮从「写备注 / 删」收成「改 / 删」单字 + `title`，使用次数从 `用 N 次` pill 收成 `×N`。
- 节间距 `.qqp-sec` 18 → 14px、标题下沿 6 → 5px、正文上沿 11 → 8px。

### 修复

- 首屏不再无条件 `loadEyes('')`。原来它挂在首屏 effect 的依赖数组里，`eyesKey` 一变整页
  （表情 / 会话 / 人格 / 工坊）就跟着重拉一遍，点一下「看这个」整页闪一次 —— 那节摘掉之后
  这个副作用也一并消失。

### 验证

- `node --check plugins/qq-agent-presets/client.js` → exit 0。
- `scripts/test-audit.mjs`（重定向到文件看退出码）→ `Audit suite: 57/57 scripts passed.`
- 渲染复核（hooks 桩 + 真接口 `127.0.0.1:56947`，3 轮预热后取末轮）：
  **171 个文本节点 / 去重 145 个，`undefined` `NaN` `[object Object]` 全 0**；
  六节标题 `生命与看护 / 今日花费 / 运行模式 / 表情与语音 / 会话 / 人格` 全部命中；
  导航 chip `生命与看护 / 花费 / 模式 / 表情与语音 / 会话 / 人格` 全部渲染；「眼睛」不可见。
  实际渲染出「看护接管中 / 模式 reserved2 / 大肥鱼在线，QQ 全部功能可用 / QQ 客户端 在运行 /
  SnowLuma hook 已连上 / OneBot :3000」。
- 接口冒烟（reload 后）：`/overview` `/health` `/capabilities` `/power` `/sessions` `/roles` 全 200。

### 注意事项

- 两栏布局用的是 `.qqp-cols{grid-template-columns:minmax(0,1fr) minmax(0,.92fr)}`
  + `.qqp-col-r{border-left:1px solid var(--k-line-soft)}`。左栏比右栏略宽（`1 : .92`）——
  左栏装的是四环链路与四格事实，横向更吃地方。
- 导航 chip 只是「撑开 + 滚过去」，不切换路由：DSH 的 `main` slot 里的面板本身就没有子路由，
  加一层假 tab 反而会让人以为切走了。

---

## [1.9.0] — 2026-11-10

### 变更

- **「05 表情库」与「09 语音与记忆」合并成「05 表情与语音」**，面板从九节收缩到**八节**，节号重排为连续的 `01–08`（原 06/07/08 会话管理、人格、眼睛 → 05/06/07）。合并后该节 `defaultOpen: false`，展开时也只是一屏：表情网格在上、语音在下。
- **合并的动机是「页面占用了太多东西」**：这两节原本各自占满一屏。表情库 = 满屏缩略图 + 四格指标 + 三行文件路径 + 一段长说明；语音与记忆 = 五个状态行 + 念一句表单 + 音频列表 + 记忆三行 + 两条 note。加在一起比其余七节都重，而且它们本来就是同一类东西（都是「大肥鱼能用的媒体」）。

### 移除

- **记忆独占的一节没了**，降级成「05 表情与语音」末尾的一行 `.qqp-path`：`记忆 进行中的话题 N · 想说但还没说的 N · 对群友的印象 N · 最后写入 HH:MM`。记忆本来就是只读的（面板刻意不提供「清空」按钮——那是 AI 自己的账本），不值得占一整节。
- **四格 `.qqp-metrics`**（表情总数 / 本次匹配 / 上限 / 上次同步）压成一行 `.qqp-note`：`上限 N · 本次匹配 M · 上次同步 HH:MM`。表情总数与节标题右侧的摘要重复，直接去掉。
- **三行 `<br>` 分隔的文件路径**压成一行：`库存 <file> · 目录 <dir>`，「来源」「只读」这两个异常状态才追加（正常时不再显示「桥接实时读取」这种占位）。
- **语音的五个状态行**（音频目录 / 本机合成 / `voice.enabled` / 工具 `sendVoice` / ffmpeg）压成一行横排「点 + 名 + 值」。
- **删掉两条长说明**：表情的「从 QQ 同步把收藏拉一份…扫本地目录读…」（按钮文案本身已说明用途）、记忆的「这里没有清空按钮：记忆是 AI 自己的账本…」（改由 `m.scopeNote` 承载，只在该有内容时出现）。
- 旧 09 节里重复的 `.qqp-list` 记忆列表、`Pill`「有内容 / 还是空的」胶囊一并删除。

### 变更的样式（`client.js` 的 `CSS` 常量）

表情网格整体缩了一号，为的是合并后不把新节撑回去：

| 规则 | 原来 | 现在 |
| --- | --- | --- |
| `.qqp-grid` 列宽 | `minmax(150px,1fr)` | `minmax(108px,1fr)` |
| `.qqp-grid` | `gap:8px; margin-top:12px` | `gap:6px; margin-top:8px` |
| `.qqp-thumb` 高度 | `96px` | `60px` |
| `.qqp-tile` 圆角 | `9px` | `8px` |
| `.qqp-tile-h` | `padding:7px 9px; font-size:11.5px; gap:6px` | `padding:4px 7px; font-size:10.5px; gap:5px` |
| `.qqp-tile-b` | `padding:0 9px 9px; font-size:11px; line-height:1.6` | `padding:0 7px 7px; font-size:10.5px; line-height:1.5` |
| `.qqp-list` | `margin-top:12px; border-radius:9px` | `margin-top:8px; border-radius:8px` |
| `.qqp-li` | `padding:8px 11px; font-size:12px; gap:9px` | `padding:5px 9px; font-size:11.5px; gap:8px` |

### 实现说明

- **`voiceBlock` 提到 return 之前**：原来语音那一整块（60 行 props）内联在 JSX 里，合并后要搬进新节就等于把 60 行 props 再抄一遍——改一处漏一处。改成 `const voiceBlock = h(VoiceSection, {...})`，让「长 props 表」和「节的结构」分开。
- **`mediaSummary` 用 IIFE 一次算好**：节标题右侧要显示 `N 张表情 · 语音 M 段`，而那个数字要跟「网格里真正能看见的张数」一致（过滤 `hasPreview === false` 与空 `url`，否则会报「29 张」却只显示 26 张）。写成 `const mediaSummary = (() => {...})()` 保证与 `StickerSection` 用的是同一个判据。
- **`Sec` 的 `defaultOpen` 早就支持**（`useState(defaultOpen !== false)`），合并后直接传 `false` 即可，没有改组件。

### 新增：合盖保活可还原（原来只能开，不能关）

用户的要求是「加入可关闭和开启功能」。全页面只有一处是单向的：合盖保活。

- `POST /qq-panel/api/power` 的 `on` 从「只认 `true`」放宽成 `true | false`，传别的回 **400** `请传 on: true（合盖不睡）或 on: false（还原成合盖就睡）`。
- 新增 `restorePowerDefault()`：写 `LIDACTION=1`（合盖就睡）、`STANDBYIDLE` AC 1800s / DC 900s、`HIBERNATEIDLE` AC 3600s / DC 1800s → `setactive` → 回读。
- **还原写的是「出厂默认意图」而不是「写入前的快照」**：这三项在上线时本来就被设成了 0，快照还原回来还是 0，等于没还原。
- 面板上：已经是「合盖与空闲都不睡」时，同一个位置换成「还原成合盖就睡」，点前弹确认框（`setModal({kind:'confirm'})`）——合盖就睡会直接让 QQ 里没人应，值得一次确认。`pw.ok === false`（读不到电源设置）时两个按钮都不画。
- `setPower` 的 `ok` 按方向判定：`on:true` → `result.keepAwake === true`；`on:false` → `result.keepAwake !== true`。

### 精简：把教学文字搬去 README，页面只留按钮和一句话

同一版里按「能去掉的都去掉，只留可操作按钮和简单说明」又收了一轮：

| 位置 | 处理 |
| --- | --- |
| `.qqp-sec` / `.qqp-sec-h` / `.qqp-body` | `margin-top` 18→14px、`padding-bottom` 6→5px、`padding-top` 11→8px |
| 02 节各行贴士 | 「连续探活失败达阈值后，拉一次 start-whale.ps1 -NoDsh（不重启 DSH，否则会把自己杀掉）」→「掉线时拉一次 start-whale.ps1 -NoDsh（不动 DSH）」 |
| 状态 pill | `失败 0 次`→`失败 0`、`已重启 19 次`→`重启 19`、`上次探活 15 秒前`→`15 秒前探过` |
| 02 的红框长文案 | 合盖那条 130 字 → 「笔记本默认合盖就睡，机器一睡面板看着正常、QQ 里却没人应。」；熔断那条压成一口气能读完的一句 |
| 行标题 | 「唤醒调整」→「只回消息」、「免打扰时段」→「免打扰」 |
| 03 节脚注 | 去掉「分桶按桥接的 token 账本，空桶不画高」这半句（那是实现细节，不是读数） |
| 04 节脚注 | 去掉「切换会写 state/mode.json 并同步 DSH 设置」 |
| 06 节红框 | 100 字的「这一层写的是 config.json…不会假装已生效」压成一句「桥接只在启动时读 config.json 一次 —— 改完要点「一键拉起」才生效，面板会显示「需重启」。」 |
| 08 节说明 | 60 字 → 「借控制台令牌从外面看 QQ，不改变 AI 自己的会话隔离。」 |

顺带修掉一个真 bug：`${ago(...)}前探过` 会渲染成「**15 秒前前探过**」——`ago()` 自己带「前」，再拼一次就叠了。改成 `wd.lastProbeAt > 0 ? \`${ago(wd.lastProbeAt)}探过\` : '还没探过'`。

### 验证

- `node --check client.js` exit=0、`node --check index.js` exit=0。
- 节列表：`01 生命 | 02 看护 | 03 花费与模型 | 04 模式 | 05 表情与语音 | 06 会话管理 | 07 人格 | 08 眼睛`，`n:` 字面量 8 处连续无缺号。
- 死代码扫描（`_deadcode.cjs`）：`client.js: 定义 53 个，无人引用 0 个`。
- CSS 孤儿审计（`_css_audit2.cjs`）：**CSS 类 85 个、孤儿类 0**。
- `scripts/test-audit.mjs` **57/57 passed, exit=0**；插件专项 7 个（`test-qq-mode-plugin` / `test-preset-local-tools` / `test-qq-preset-contract` / `test-preset-prompt` / `test-installed-preset-sync` / `test-agent-preset-patches` / `test-audit-setup-guards`）全部 exit=0。
- 热重载（`POST /dsh-unlag/reload`，operationId 19 / 20）后真机：`/qq-panel/api/overview` 200、`/health` 200、`/capabilities` 200、`/presets` **404**、`/guard` **404**（1.7.0 删的两节依旧不存在）。
- **合盖还原端到端实测**：`POST /power {on:false}` → `lid:{ac:1,dc:1}`、`standbyIdle:{ac:1800,dc:900}`、`hibernateIdle:{ac:3600,dc:1800}`、`keepAwake:false`、`restored:true`；再 `{on:true}` → 三项全 0、`keepAwake:true`、`justApplied:true`；`{}` → 400。
- **面板渲染复核**（`_rc3.mjs`：hooks 桩 + 真接口 `http://127.0.0.1:56947`）：**191 个文本节点**，`undefined` / `NaN` / `[object Object]` 均为 0，渲染出「只回消息 | 定时唤醒已全停…」「免打扰 | §value=23:00 到 §value=07:00 ｜ 消息也不叫它」「合盖保活 | 合盖与空闲都不睡 | 还原成合盖就睡 | 方案 高性能」。
- 文件规模：`client.js` 2305 → **2286 行 / 121458 字节**（这一版又加了「还原成合盖就睡」的按钮与确认框，所以没有继续变小；净省 19 行）。

---

## [1.8.0] — 2026-11-10

### 新增

- **免打扰时段（quiet hours）**。`socialV2.wake.quietHours = {enabled, start, end, muteMessages}`，面板「02 掉线看护」节里一行开关 + 两个 `HH:MM` 时间框 + 保存按钮。按**北京时间**判定，`start > end` 表示跨午夜（`23:00 ~ 08:00` 即「夜里别吵，白天 08:00~23:00 可以唤醒」）。
- **压制的范围可细分**：默认只压**定时**唤醒（`timeout` / `replyCheck` / `proactiveCheck`），有人私聊、@、叫名字、拍一拍照样叫醒它；把 `muteMessages` 打开才是彻底静默（夜间有人真找它也不应）。这个取舍没有正确答案，所以做成显式开关而不是写死。
- **`scheduleQuietResumeV2` / `cancelQuietResumeV2` + `quietResumeTimer`**：被压掉的 `timeout` 是一次性定时器，压掉就没了——所以在压唤醒的同时挂一个「窗口结束」定时器（`msUntilQuietEnd` 算剩余毫秒，超过 `100009ms` 分段续期），到点重排 `setupSleepTimerV2` + `scheduleProactiveCheckV2`。**没有这一步，整个免打扰时段过后会话会一直静默到下次有人说话。**

### 变更

- **`sendWakePromptV2` 增加免打扰判定**（紧跟 `getSocialV2State` 之后、`isConversationBusyV2` 之前）：命中窗口时，定时类原因或 `muteMessages` 打开则 `scheduleQuietResumeV2` + 记日志后 return，不消耗唤醒额度。
- **`setupSleepTimerV2` 增加同一判定**：窗口内直接挂续排、不建睡眠定时器，避免「睡到一半醒来又撞免打扰」的空转。
- **没有在 `scheduleReplyCheckV2` / `scheduleProactiveCheckV2` 里加判定**——它们最终都走 `sendWakePromptV2`，那里兜住即可；且这两个函数被 `scripts/test-code-scanning-boundaries.mjs` 用字符串切片塞进 `vm` 跑，context 里没有新标识符，引用 `quietActiveAt` 会直接 `ReferenceError`。
- **`POST /api/socialV2/config` 归一化**：`quietHours` 逐字段合并（省掉的字段沿用现值），`start`/`end` 过 `normalizeClock`；**`start === end` 在 `quietWindow()` 里返回 `null`（视为没设）**，接口层回 400「起止时间不能一样 —— 那等于全天静默，谁也叫不醒它」。
- **切换后整排定时器**：条件从「只判 `onlyOnMessage`」扩成「`onlyOnMessage` 或 `quietHours` 有变化」，且**只在 `onlyOnMessage` 真的变了时才打「只回消息模式已关闭」**——此前只改免打扰也会误报这条日志。
- `README.md` §一 `index.js` 行计数由「34 个 path（32 条 JSON）」修正为「32 个 path（30 条 JSON + 2 条字节通道）」；§六 `/quiet` 行描述由「写穿 `socialV2.quiet`」修正为「写穿 `socialV2.wake.quietHours`」；新增小节「唤醒的三道闸：只回消息、免打扰时段、唤醒额度」。

### 设计说明

- **为什么按北京时间而不是机器本地时区**：桥接可能跑在改了时区的机器上，也可能跨时区远程使用；`beijingParts()`（`src/model-prices.js:157`）已有的偏移逻辑比 `new Date().getHours()` 可靠。
- **为什么 `start === end` 当「没设」而不是「全天」**：按字面算它就是全天（或全天外），界面看着开着、实际谁也叫不醒，是最难排查的一类静默死锁。宁可当成配置错误。
- **为什么面板侧要重写一份判定**（`index.js` 的 `quietActiveAt` / `isQuietNow`）：面板要在桥接挂掉时也能显示「此刻是否免打扰」，而且必须与桥接判定逐字一致（左闭右开、跨午夜、`start===end` 视为没设）。

### 验证

- `node --check` 对 `src/bridge.js`、`plugins/qq-agent-presets/index.js`、`plugins/qq-agent-presets/client.js` 全部通过。
- `scripts/test-code-scanning-boundaries.mjs` 7/7 PASS（新增函数未进入任何 vm 切片，无 `ReferenceError`）。
- `scripts/test-audit.mjs` **57/57 passed, exit=0**（新增三条 R18 并入 `test-audit-regressions.mjs`，脚本总数不变）：
  - R18-1 跨午夜判定（`23:00`/`02:30`/`07:59` 在内，`08:00`/`12:00`/`22:59` 在外；`start===end` → `null`；`normalizeClock` 三种写法；`msUntilQuietEnd(02:30) === 330min`）。
  - R18-2 窗口内定时唤醒被压、`wakeTimes` 不增长、`quietResumeTimer` 已挂；消息类照常放行。
  - R18-3 `muteMessages: true` 时连 `private` 也不投递。
- 真机（`http://127.0.0.1:56947`）：`POST /qq-panel/api/quiet` 写入 `23:00 ~ 08:00` 后 `bridge.log` 出现 `控制台：免打扰时段已设为 23:00 ~ 08:00（北京，消息类仍会唤醒）`；`GET /qq-panel/api/overview` 的 `life` 带 `quietHours` 与 `quietNow`；空 body、`25:99`、`08:00~08:00`、`enabled:"yes"` 四种非法输入分别回 400。

---

## [1.7.0] — 2026-11-10

### 移除

- **面板「04 角色预设」整节删除**。它把 `presets/qq-chat.patch.yml` 与 `presets/qq-chat-v2.patch.yml` 里已经写死的东西（行数、人格字符数、小节标题、守卫说明符）摊开成两张可展开的卡。问题在于：这些字段改不了，改了也不生效——preset 的真实来源是 `dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml`，改完要走 `build-agent-preset-patches.mjs` 重新生成再重启 DSH。一块只读的镜子算不上看板，却占了最大的一块纵向空间。
- **面板「05 工具守卫」整节删除**。它由四部分组成：四个计数（本地工具 68 / 可选包 2 / `dev_*` 21 / 放行前缀 3）、一个「判定演练」输入框、拦截名单 chip 墙（默认只露 8 个，点「展开」看全 91 个）、放行规则 chip。真正需要判断的事是「某次调用到底有没有被拦」，而那件事 `state/tool-restrict.log` 记得更准（带时间、带工具名、带拒绝理由），面板这个一次性试算框反而是个更弱的近似。
- host 半对应删掉四条路由与它们独占的辅助函数：`GET /presets`（`listPresets` + `readSelfVersion` + `findRow` + `summarizeRow` + `extractSections`，含 `import('js-yaml')`）、`GET /guard`（`listGuard`），以及只给「判定演练」展示用的 `SAFE_PREFIXES` / `SAFE_EXACT` 副本（权威在 `qq-tool-restrict.mjs`，那里没导出，这里抄了一份）。共 135 行。

### 变更

- **节号重排为连续 01–09**：原 `06 运行模式 → 07 表情库 → 08 会话管理 → 09 人格 → 10 眼睛 → 11 语音与记忆`，现为 `04 运行模式 → 05 表情库 → 06 会话管理 → 07 人格 → 08 眼睛 → 09 语音与记忆`。节标题上的数字、文件里的 `// ── NN 标题 ──` 分节注释、README 里的节号引用、`07–11 这五节各自卡在哪` 的小标题与表格全部同步。
- **副标题去掉 preset 相关表述**：`生命开关 · 掉线看护 · 今日花费，以及这两代 preset 的真实形状` → `生命开关 · 掉线看护 · 今日花费`。
- **界面整体收紧**：节间距 `26px → 18px`（这是最显眼的一处，九节之间原来平均每屏都要多滚一点）；内容区左右内边距 `24px → 22px`、上边距 `6px → 2px`、下边距 `56px → 40px`；内容宽度上限 `900px → 880px`；头部内边距 `20px 24px 0 → 16px 22px 0`；副标题上边距 `5px → 4px`；顶栏上边距 `12px → 9px`；节正文上边距 `14px → 11px`；节标题下边距 `7px → 6px`；指标行上边距 `14px → 11px`、单格最小宽 `110px → 104px`、单格内边距 `9px 12px → 8px 11px`；空态内边距 `16px 2px → 12px 2px`。窄屏（≤900px）同步：头部 `16px 16px 0 → 13px 14px 0`、内容区 `4px 16px 40px → 2px 14px 32px`。
- **`README.md` 六节全部同步**：节列表改九节并补一段「为什么删这两节」的说明；`十一节 → 九节`；`34 个 path（32 条 JSON + 2 条字节）→ 32 个 path（30 条 JSON + 2 条字节）`；路由表删掉 `/presets` 与 `/guard` 两行、补上此前漏记的 `POST /quiet`；`07–11 这五节` → `05–09 这五节`；`收起后摘要（29 张、91 个、3 个会话）` 去掉已不存在的 `91 个`。
- `package.json` 的 `description` 与 `locale/{zh,en}.json` 的 `meta.description` 去掉「两个 preset、工具守卫」的可视化表述，只留真实还存在的九节。
- `displayName` 保持「QQ 小鲸鱼（角色预设 + 模式设置 + 控制面板）」不变——`角色预设` 指的是这个插件**本身**装了两代 preset，不是那块已删的卡片。

### 修复

- **按钮主色一直没生效**：「念一句」那颗按钮写的是 `className: 'qqp-btn qqp-primary'`，但 CSS 里只有 `.qqp-btn.primary`（没有 `.qqp-primary` 这条规则）。多写的前缀让它一直呈现成普通按钮的描边样式。改为 `'qqp-btn primary'`。
- **删掉无人引用的 `Row` 组件**：`function Row({ k, children })` 定义后全文件再没出现过第二次，JSX 里用的都是直接写 `className: 'qqp-row'`。

### 清理（死代码）

- CSS 删掉 **22 条**只喂已删卡片的规则：`.qqp-card`（含续行）、`.qqp-card-h`、`.qqp-card-h:hover`、`.qqp-card-t`、`.qqp-card-s`、`.qqp-card-body`、`.qqp-card.open .qqp-card-h`、`.qqp-tree` 及其 5 条子规则；另有历史孤儿 `.qqp-faces`、`.qqp-face`、`.qqp-face img`、`.qqp-face-f`、`.qqp-face-f button`、`.qqp-face-f button:hover`、`.qqp-idlist`、`.qqp-id`、`.qqp-id button`、`.qqp-id button:hover`、`.qqp-skel`。规则块 131 → 127。
- 又删 4 条经核对确无引用的规则：`.qqp-btn.danger`、`.qqp-btn.danger:hover:not(:disabled)`（全文 `className` 从未出现 `danger`）、`.qqp-li .when`、`.qqp-li .idx`（`.qqp-li` 的实际子元素只有 `who` / `what`）。
- client.js 删 6 个只为这两节存在的 state（`presets`、`guard`、`openPreset`、`judgeName`、`showGuardList` 及其 setter），`load()` 从 `Promise.all([overview, presets, guard])` 收敛成单请求 `req('/overview')`——面板首屏少两个并发请求。
- 删除 `function PresetCard(...)` 与两个纯函数 `judgeTool(name, guard)`、`encodeSelfKey(key)` 及其 `exports` 两条。`encodeSelfKey` 在 `qq-self-key.mjs` 里有同名的正式实现，浏览器半这份只给守卫节展示 `group:<群号> → qqb-g-…` 的编码效果，删掉不影响任何调用方。

### 验证

- `node --check` 对两个文件通过；`acorn` AST 复核删节后无悬挂引用。
- **死代码扫描**：client.js 定义 51 个函数/常量，无人引用 **0**；index.js 定义 139 个，无人引用 **0**。
- **CSS 审计**：花括号配平、空规则 0 条、JSX 用了但 CSS 未定义的类 0 个。剩余 3 处「同名选择器出现两次」都在 `@media (max-width:900px)` 里，是响应式覆盖，属正常写法。`closed` / `empty` / `on` / `peak` / `self` 看着像孤儿，实际由模板字符串拼出（如 `qqp-sec${open ? '' : ' closed'}`），不能删。
- **残留扫描**：`角色预设`、`工具守卫`、`PresetCard`、`judgeTool`、`encodeSelfKey`、`qqp-card`、`qqp-tree`、`qqp-primary`、`qqp-skel`、`qqp-idlist`、`qqp-face` 全部 **0 命中**。
- **接口**：`GET /qq-panel/api/presets` → **404**、`GET /qq-panel/api/guard` → **404**、`GET /qq-panel/api/overview` → **200**、`/health` → 200、`/capabilities` → 200。
- **回归**：`cmd /c "node scripts\test-audit.mjs"` → `Audit suite: 57/57 scripts passed`，真实退出码 **0**。

### 注意事项

- **热重载后偶发 `xxx is not defined` 不是代码问题**。这次改完走 `POST /dsh-unlag/reload`（头 `x-dsh-unlag`）后，`/qq-panel/api/overview` 一度 500 并报 `ReferenceError: normalizeQuiet is not defined`，而 acorn 复核该函数祖先链是 `Program`（顶层）、文件里也没有任何删节残留。**再触发一次 reload 即恢复**——旧模块实例还攥着上一版的作用域，第二次 reload 才完全换掉。
- 删掉的 `GET /presets` 与 `GET /guard` 是面板私有路由（`/qq-panel/api/*`），不是桥接接口，外部脚本没有调用方（已用全仓 grep 确认）。想回退看旧样式，备份在 `client.js.bak-trim` / `index.js.bak-trim`。

---

## [1.6.0] — 2026-11-10

### 新增

- **唤醒调整（面板「掉线看护」节）**：新增「只回消息」开关。打开后关掉三类定时自动唤醒——回复复查（replyCheck，默认 30 秒一次）、主动开话题（proactiveCheck）、潜水到期自动醒（timeout），只在收到 @/关键词/私聊/提问/拍一拍时激活。这是「待机降到最低损耗」最直接的落点：不主动开话题、不隔 30 秒回查、不到点自己醒。
- host 侧新增 `POST /qq-panel/api/wake`（body `{on: boolean}`），写穿 `config.json` 的 `socialV2.wake.onlyOnMessage`；`GET /overview` 返回体新增 `life.onlyOnMessage` 字段。

### 变更

- `bridge.js` 的 `cfg.socialV2.wake` 默认值新增 `onlyOnMessage: false`（只回消息默认关）；`POST /api/socialV2/config` 归一化认这个布尔字段。

### 设计说明

- 「只回消息」的实现放在 `bridge.js` 而非面板侧：三个入口函数 `scheduleReplyCheckV2` / `scheduleProactiveCheckV2` / `setupSleepTimerV2` 各自在入口处判 `cfg.socialV2?.wake?.onlyOnMessage === true` 就直接 return，不排定时器。这样**收到消息的唤醒路径（`evaluateWakeTriggerV2` → `scheduleWakeV2`）完全不受影响**——只回消息 ≠ 不醒，是把「主动醒」关掉、把「被动醒」留着。
- 面板开关的 `on: true` 语义是「只回消息」（更省），`on: false` 是「恢复默认定时唤醒」。布尔语义与 `/life`（true=恢复）不同，UI 文案上已用「只回消息」而非「开/关」避免歧义。

---

## [1.5.0] — 2026-11-09

### 变更

- **工具守卫放行 `compress` / `decompress` / `search_context`**：这三项从 `LOCAL_EXECUTION_TOOLS`（会被 `tools.restrict` 从 schema 隐藏）移除，改挂进 `SAFE_EXACT`（执行期放行）。守卫其余部分不变：QQ 三个 MCP 命名空间仍放行，本地执行类工具仍全部拒绝。
- `SAFE_EXACT` 现为 `{ ask_user_question, todo_write, compress, decompress, search_context }`。

### 修复

- **上下文永不压缩导致单步 60 万 token**：装了 `billion-context` 时，它用「模型工具面里有没有 `compress`」判断这一版是否支持压缩。守卫把 `compress` 从 schema 藏掉后，bili 判 `surface=off`、只记 `nudge ARMED-SUPPRESSED`、**从不注入压缩提示**，于是上下文只涨不落。实测一个 QQ 私聊会话：`usage=67%`、`pendingT1=58.9 万`（阈值 5 万），压缩一次都没触发，每步输入稳定在 57–60 万 token。

### 设计说明

- 2026-11-04 那次「连调 300+ 次 compress 整轮卡死」的成因是**「schema 里有、执行期被拒」**：模型看到工具可用 → 调 → 拿到「不在白名单内」→ 再调。现在两处都放行，模型调用会真的成功。
- 防滥用改交给 bili 的 `compress.requireNudge`：没收到压缩 nudge 的回合里，模型自发调 `compress` 会被 bili 回一条 error receipt（bili 自己的溢出兜底折叠豁免）。建议在 `billion-context.json` 里保持 `compress.requireNudge: true`。

### 注意事项

- **改守卫必须完整重启 DSH，`dsh-unlag` 热重载不生效。** 该模块是 preset 的子行而非独立 bundle，热重载会把它判成 `unmanaged-plugin` 塞进 `pending` 并挂起；`state/tool-restrict.log` 的 mtime 不会变，就是 `apply()` 没重跑的证据。重启后还要用 `POST /api/session/reset` 让 QQ 会话重建，新会话的工具面才是新的。
- 放行 `compress` 后，若某个 composition 没有装 bili（无 nudge 源），模型可能自发调用压缩——这是可接受的（压缩本身无害），但会偏离「仿真会话不得拥有本地执行能力」的初衷；此时应改用 `compress.requireRecommendation` 或把守卫改回 deny。

---

## [1.4.0] — 2026-11-09

### 新增

- **合盖保活（面板「掉线看护」节）**：新增「合盖保活」一行 + 一键按钮。笔记本出厂默认合盖就睡，机器一睡 SnowLuma 收不到包、bridge 也不再回话——面板上看着「一切正常」，QQ 里却没人应。现在能读当前电源方案的「合盖动作 / 空闲睡眠 / 空闲休眠」三项，并一键把三项都设成「不采取任何操作」（AC+DC），写完后立刻回读确认。
- host 侧新增两条路由：`GET /qq-panel/api/power`（只读现状）与 `POST /qq-panel/api/power`（body `{on: true}` 才写，空 body 回 400）。`GET /overview` 返回体新增 `power` 字段（`keepAwake` / `scheme` / `lid` / `standbyIdle` / `hibernateIdle` / `acOnlyPartially`）。

### 设计说明

- 只碰三项：合盖动作、空闲睡眠、空闲休眠。**不碰显示器超时**（人可能只是想关屏），**不碰 S0/Modern Standby 固件行为**（改那个要重启、不同 BIOS 表现不一，风险远大于收益）。
- 逐条用 `powercfg` 写而非直接改注册表：powercfg 会顺带通知系统刷新缓存；直接写 Registry 要到下次切换方案才生效。
- 写入后用 `powercfg -attributes SUB_BUTTONS LIDACTION -ATTRIB_HIDE` 取消该项的隐藏属性，让用户能在系统电源设置里自己复核（否则默认隐藏，会以为插件写了看不见的东西）。
- 判据严格：只有 AC 与 DC 都明确等于 0 才算「已关掉」；`null`（该方案没写过）不算，因为默认很可能就是睡眠。只 AC 关掉、DC 还开着时标 `acOnlyPartially` 提示「只有接电源时有效」。

### 注意事项

- 改电源设置经 `powercfg` 写 HKLM，一般不需管理员权限；若当前方案被组策略锁死，写失败时面板会提示「多半需要管理员权限，用管理员身份重开 DSH 再试」。
- `D:\DeepseekWorkSpace\quiet-lid.ps1` 是等价的一键脚本（含 `#Requires -RunAsAdministrator`），供命令行重放。

---

## [1.3.0] — 2026-11-06

### 新增

- **Breezeblue 云端音色（第四引擎）**：新增 `breeze` 引擎，用你在 Breezeblue 设计的克隆音色 `voc_d4utea6v6cm3` 云端合成（`wav_24000`）。配置落在 `config.json` 的 `socialV2.voice.breeze`（`enabled` / `apiKey` / `voiceId` / `probability` / `minChars` / `outputFormat` / `useMouth`），代码不写死密钥。
- **回复自动随机附带语音**：桥接在 AI 成功发出文字消息（`send-message` / `send-burst`）后，按 `probability` 概率随机附带一句 Breezeblue 语音，不固定台词。合成/发送失败静默记日志，不影响文字发送。
- **给大肥鱼一个「嘴」**（`useMouth: true`）：语音内容不再从本次回复文本里挑，而是桥接起一个独立的 DSH 会话（存于 `state/voice-mouth-session.json`），命中概率时把**刚发出的文字消息**作为上下文投给它，让它「顺着刚才的文字补一句语音」（带人格与身份上下文），等它生成后把这句话用 Breezeblue 合成发送——**语音和文字聊的是同一件事、同一语气，是补充/接续/呼应，不会各说各的**。
- 面板「语音」节新增引擎下拉「Breezeblue 云端」与音色显示、状态说明；`GET /voices` 返回体新增 `breeze` 体检字段。

### 修复

- 无（本版为纯功能新增，未改动既有行为）。

### 注意事项

- Breezeblue 合成要走公网并消耗 key 额度；概率建议保持较低（默认 0.3）。
- 「嘴」会话复用黑话学习会话的「独立会话 + follow + ensureChatModel + prompt + 等 turn」骨架，与主会话、黑话学习会话互不干扰；会话状态在 `state/voice-mouth-session.json`，删除该文件即下次重建。
- 语音仍受 `socialV2.voice.enabled`、`tools.sendVoice`、每分钟/每小时限流三重约束，`maybeAttachVoiceV2` 会在入口兜底判断，不绕过既有闸门。

---

## [1.2.0] — 2026-11-05

本版是「从两个 preset 到一整块控制面板」的大版本：把原来独立的 `qq-mode-console` 并入本包，并补齐面板的七个功能节。

### 新增

- **并入 `qq-mode-console`**：原独立 settings 命名空间插件迁入本包的 `mode.js`（入口 `qq-agent-presets/mode`，由 `qq-mode.patch.yml` 的 `id: qq-mode` loader entry 装载）。功能不变，`package.json` 的 `exports` 增加 `"./mode"`，`dsh.bundle.patch` 增加 `qq-mode.patch.yml`。
- **面板五节新功能**（`client.js` + `index.js` 对半扩展）：
  - **07 表情库**：列表 / 写备注 / 强制同步 / 本地目录自动入库 / 删除 / 清理死记录，预览走 `/sticker-file` 字节通道。
  - **08 会话管理**：读写 `config.json` 的 `allow.groups` / `allow.private` 白名单，如实标「改完要重启桥接」。
  - **09 人格**：`roles` 全套 CRUD（新建 / 重命名 / 删除 / 启用 / 读正文），校验交给桥接，面板不重复实现。
  - **10 眼睛**：借面板视角看某个会话最近消息（群走 group-history、私聊走 recent）与消息图片。
  - **11 语音与记忆**：语音库管理 + 现状说明（为什么 AI 还不能开口、记忆为什么是空的）。
- **三条 TTS 路线**（语音节核心）：`kokoro`（默认，本机离线 Kokoro v1.1-zh，8 个真实女声）、`edge`（微软在线语音，8 个中文播音腔）、`sapi`（本机 Windows System.Speech）。引擎与音色偏好落在 `$DSH_HOME/qq-panel-voice.json`。
  - 新增 `scripts/tts-kokoro.cjs`（`--serve` 常驻子进程，stdin 逐句合成）与 `scripts/tts-sapi.ps1`（UTF-8 带 BOM，文本经文件传参）。

### 修复

- **表情本地路径发送失败**：本地表情的 `url` 是本机绝对路径，被 `safeFetchBuffer` 拦（只允许 http/https）。改为 http(s) 走网络、本地路径 `fs.readFileSync` + `path.relative` 限死在表情库目录内。
- **看护熔断与退避**：上一版固定 180 秒冷却，遇到「QQ 小号没登录 → OneBot 永远不开」这类修不好的故障会每 3 分钟整套杀一遍重起。改为连续 `maxAttempts`（默认 3）次白拉后熔断停手，冷却乘 `2^(N-1)` 退避（上限 ×8）。
- **一键拉起不再说假话**：实测 18~24 秒（最慢 106 秒），UI 改为实时轮询 + 显示「已 N 秒 / exit=N / 结束时刻」。

### 依赖

- 运行时依赖仅 `@deepseek-ai/schemastery ^3.18.1`（`mode.js` 的 schema 需要）；其余只用 `node:*` 与 host 注入的 `react`。

---

## [1.1.0] — 2026-11-04

把本包从「纯 preset bundle」升级为「bundle + host 半 + 浏览器半」，加一块 DSH 侧栏「小鲸鱼」面板。

### 新增

- **host 半 `index.js`**：`/qq-panel/api/*` 路由，代理桥接控制台（令牌与 Origin 校验留在主进程）、看护探活（3100 / 3000 / QQ 进程三层）、掉线自动拉起 `start-whale.ps1 -NoDsh`。
- **浏览器半 `client.js`**：注册 `main{key:'qq-panel'}` + `sidebar.panellist{id:'qq-panel', order:30, label:()=>'小鲸鱼'}`，六节仪表盘。
- **面板六节**：
  - 01 生命开关（关 = 断 QQ 全部功能，开 = 恢复）
  - 02 掉线看护 + 自动重启
  - 03 今日 token 花费 + 当前模型
  - 04 角色预设（两个 preset 的形状可视化）
  - 05 工具守卫（三份名单 + 判定演练）
  - 06 运行模式切换

### 修复

- **Windows `detached:true` spawn 不执行**：DSH 的 Windows 作业对象把放掉的子进程直接收走，改成普通子进程 + stdio 重定向到日志文件。
- **`life.on === null` 是「未知」不是「关」**：桥接没起来时 `/overview` 仍回 200，但生命开关显示「读不到状态」而不是瞎猜成「已断开」。

---

## [1.0.1] — 2026-11-03

### 修复

- 版本号从 `1.00.1`（前导零、非合法 semver，`node-semver` 解析为 null）改为 `1.0.1`。

## [1.0.0] — 2026-11-03

### 新增

- 首个版本：`qq-chat`（一代）与 `qq-chat-v2`（二代仿真）两个 agent preset 的 bundle patch。
- 工具面守卫 `qq-tool-restrict.mjs`（注册期 `tools.restrict` 隐藏 + 执行期 `tools.guard` 白名单）。
- 会话绑定 `qq-self-key.mjs`（把 QQ 会话 key 编进 sessionId、解回可信身份、判定跨会话调用）。
