# qq-agent-presets

> 更新记录见 [CHANGELOG.md](CHANGELOG.md)；许可见 [LICENSE](LICENSE)。

qq-bridge 的 **DSH agent preset bundle**。它把 `qq-chat`（一代）与 `qq-chat-v2`（二代仿真）两个聊天预设作为
[`@deepseek-ai/dsh-agent-preset`](https://github.com/deepseek-ai/deepseek-harness) 行插入 DSH profile，
并携带两个预设**共用**的工具面守卫。

```text
qq-bridge（桥接进程）
   └─ session/create 时指定 preset: qq-chat-v2
        └─ DSH 按本 bundle 的 patch 装出一条 preset 行
             ├─ persona          ← 仿真提示词（怎么干活）
             ├─ tool-web/-ask-user/-todo
             ├─ qq-tool-restrict ← 本包：把工具面锁死
             └─ compaction
```

本包**没有运行时依赖**（不 require 任何第三方包，只用 `node:*` 与 host 注入的 `react`），
由 `dsh.bundle.patch` 清单 + 两个 `.mjs` 模块 + 一块面板（host 半 `index.js` + 浏览器半 `client.js`）组成。

## 一、包内文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.bundle.patch` 列出四个 patch 文件（面板 + 模式命名空间 + 两个 preset）；唯一的运行时依赖是 `@deepseek-ai/schemastery`（`mode.js` 的 schema 需要）。`files` 字段是 `scripts/pack-plugin.mjs` 与 `npm pack` 共用的打包白名单。`displayName` 与 `description` 是给人和插件市场卡片看的用途说明（卡片实际展示的是市场备注，见 [../README.md](../README.md#二插件管理卡片上显示的那段描述)） |
| `qq-tool-restrict.mjs` | 工具面守卫：注册期 `tools.restrict` 隐藏本地工具 + 执行期 `tools.guard` 白名单。**唯一权威实现** |
| `qq-self-key.mjs` | 会话绑定：把 QQ 会话 key 编进 sessionId、从中解回可信身份、判定跨会话调用。**唯一权威实现** |
| `presets/qq-chat.patch.yml` | 生成物：`qq-chat` 的 preset 行（`order: 10`） |
| `presets/qq-chat-v2.patch.yml` | 生成物：`qq-chat-v2` 的 preset 行（`order: 11`） |
| `qq-panel.patch.yml` | `qq-agent-presets` 自己的 loader 行（面板的 host 半靠它装进 DSH） |
| `qq-mode.patch.yml` | `qq-mode` 命名空间的 loader 行（`id: qq-mode`，`name: qq-agent-presets/mode`）—— 桥接的「模式写穿 DSH 设置」靠它 |
| `mode.js` | **模式命名空间**：导出 `Config`（`mode` + `ownerQQ`，都带 `.extra('volatile')`）。原 `qq-mode-console` 迁入 |
| `scripts/tts-sapi.ps1` | 本机 SAPI 语音合成（UTF-8 带 BOM，文本经文件传参）。面板「念一句」用它 |
| `index.js` | **面板 host 半**：33 个 `/qq-panel/api/*` path（31 条 JSON 路由 + `/sticker-file` + `/voice-file` 两个字节通道；代理桥接 + 看护探活 + 合盖保活 + 唤醒调整 + 免打扰时段 + 锁定默认模型 + 表情/会话/人格/语音，另含界面已摘掉但接口保留的 `/eyes`）。见下文 §六 |
| `client.js` | **面板浏览器半**：注册 `main{key:'qq-panel'}` + `sidebar.panellist{id:'qq-panel'}`，六节仪表盘（页头带导航 chip，跳过收起状态直达目标节） |
| `icon.svg` / `locale/*.json` | 插件清单里显示的图标与中英文标题描述 |

> `presets/*.patch.yml` 由 `../scripts/build-agent-preset-patches.mjs` 生成，**勿手改**。
> 人格正文与工具面都在 `dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml` 里改，改完重新生成。

## 二、`qq-tool-restrict.mjs`：为什么必须「两段式」

守卫做两件**不同**的事，缺一不可：

1. **注册期 `ctx.tools.restrict({ deny: [name] })`** —— 把工具从模型的工具清单（schema）里**隐藏**。
   这是铁律 L7 的落点：「仿真会话不得拥有本地执行能力」。只要工具名还出现在 schema 里，
   模型就会看到、就会去调。
2. **执行期 `ctx.tools.guard(fn)` 白名单兜底** —— 任何不在白名单里的调用一律拒绝。
   这是防止「别的 composition 把危险工具注册进全局层」这类回归的最后一道闸。

**只做第 2 条是不够的**——`guard` 只能拒绝执行，工具名照样在清单里。2026-11-04 的真实事故：
`acp_status` / `memory` 等上下文管理工具不在 restrict 名单里，于是进了 schema；
模型看到「可用」就一遍遍调，拿到的永远是「不在 QQ 桥接白名单内」——一个私聊会话里实测连调
**300+ 次 compress**，整轮卡死、一条消息都没回出来。把它们补进 `LOCAL_EXECUTION_TOOLS` 后才正常。

> **2026-11-09 修正：`compress` / `decompress` / `search_context` 已改为放行**（从 deny 名单移除，加进 `SAFE_EXACT`）。
> 原因是当一个会话里装着 `billion-context`（bili）时，它靠「模型工具面里有没有 `compress`」判断
> 这一版是否支持压缩：`surface=off` 时它只记 `nudge ARMED-SUPPRESSED`，**永不注入压缩提示**，
> 上下文于是只涨不落（实测单步 60 万 token、命中率 0%）。放行后 bili 才肯发 nudge。
> 当年的死循环是「schema 里有、执行期被拒」造成的；现在两处都放行，防滥用改由 bili 自己的
> `compress.requireNudge` 负责：没收到 nudge 的回合里模型自发调 compress 会被它回一条 error receipt。

白名单只有三类：

```js
SAFE_PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__']
SAFE_EXACT    = { ask_user_question, todo_write, compress, decompress, search_context }
```

即「QQ 相关的三个 MCP 命名空间」+「模型侧无害工具与上下文管理工具」，其余全部拒绝。

### 名单为什么这么长、还要按 DSH 版本反复对账

`LOCAL_EXECUTION_TOOLS` 里的名字是**逐个核对**过 DSH 实际注册的工具名的（每条上方注释写了来源包），
不是凭印象列举。历史教训：名单初版把 `pwsh_persistent` / `bash_persistent` / `cordis` / `goal_write` /
`goal_read` 当成工具名——这五个**根本不存在**，而 `restrict` 对未知名字会抛错、被逐条的 `try/catch`
吞掉，于是**静默失效**。为了防这类拼写假名，`scripts/test-preset-local-tools.mjs` 会把本名单与 DSH
真实工具名集合求双向差。

对账工具是 `node scripts/scan-dsh-tool-names.mjs`（可重复运行），历次结论：

| 对账轮次 | 目标 | 结果 |
| --- | --- | --- |
| 0.1.7-rc.2 | 初次逐个核对 | 清掉 5 个假名；补上 `load_workspace_dependencies`、`list_subagent_models` |
| 0.2.0-rc.2 | 重扫安装包 | 旧名全在（0 假名）；新增 13 个危险语义名，分 4 类判定后补齐 |
| 0.2.1-rc.2 | 重扫安装包 | `working_directory` 变成全局层继承；新增 terminal / session-query / plugin_market 一族 |

`OPTIONAL_BUNDLE_TOOL_NAMES`（`subagent_codex` / `subagent_claude_code`）单独分组：0.2.1 起 Codex 与
Claude Code 改为按需安装，默认不存在，`restrict` 对它们必然抛错。保留是**回归网**——用户装上组合包、
名字回到全局层时立刻被挡。测试会把这一组排除在「拼错假名」判定之外。

### 失败可观测性

`restrict` 失败在现网原本完全不可观测（DSH 的 stderr 不落日志文件）。因此守卫把失败原因写到
`<repo>/state/tool-restrict.log`（有界，只留最近 20 行，单行截断 240 字符），并在 **3 秒后重试一次**
——注入器的工具可能比 preset 的 `apply` 晚注册，重试能把这种时序问题真正修掉。测试可用
`QQ_TOOL_RESTRICT_LOG` 把日志改到临时文件，避免污染真实 `state/`。

## 三、为什么守卫用「裸说明符」引用

preset 子行里写的是：

```yaml
- id: qq-tool-restrict
  name: qq-agent-presets/qq-tool-restrict.mjs
```

**不是** `./qq-tool-restrict.mjs`。原因在 DSH 0.1.7 的机制变化：

- 0.1.5 的 preset 是 `~/.dsh/.agent-presets/<preset>/` 目录，相对名按 preset 目录解析；
- 0.1.7 起 preset 变成一条 **loader 行**，子行 `name` 按**声明它的 loader 上下文**（即 profile 目录）
  解析，`./x.mjs` 会去找 profile 根目录下的文件（不存在）；
- bundle patch 只对 `insert` 行**自己**的 `name` 做「相对 patch 文件锚定」，不会走进 preset 行的
  `config.plugins`。

所以守卫只能用「从 profile 目录可解析的裸说明符」。该包以 `link:` 依赖注册在 profile 的 `package.json`，
`node_modules` 下的 junction 由 `scripts/setup-dsh.mjs` 维护——**不写死任何绝对路径**，仓库搬家后重建链接即可。

`dsh/agent-presets/qq-chat{,-v2}/qq-tool-restrict.mjs` 是 531 字节的 re-export 壳：

```js
export * from '../../../plugins/qq-agent-presets/qq-tool-restrict.mjs'
```

保留它只为让仓库里按老路径 import/读文件的脚本（`test-audit-setup-guards.mjs` 等）继续工作，
**逻辑只有一份**，避免两处漂移后出现「一个拦一个不拦」。

## 四、`qq-self-key.mjs`：会话绑定

### 要解决的问题

DSH 的 MCP 桥（`dsh-mcp-client` 的 `syncTools` → `tools/call`）**只传 `name` + `arguments`**，
协议里没有任何「这次调用来自哪个会话」的字段。于是桥接的 MCP server 只能按**模型给的 `key`**
去解析会话令牌——模型（或被注入的群友文本）只要把 `key` 换成别的群号，就能读到那个群的会话状态。

但 DSH 的**插件侧**知道身份：工具执行记录 `exec` 上挂着 `exec.agent`，而 `exec.agent.id` 就是
当前调用所属的 DSH 会话 id。

### 做法

桥接建会话时**预分配**一个把 QQ 会话 key 编码进去的 sessionId：

```text
qqb-g-你的群号            ← group:你的群号
qqb-p-你的QQ号-<hex32>    ← private:你的QQ号（带哈希后缀时同样可解）
```

插件侧用 `decodeSelfKey(sessionId)` 解回「我是谁」，再与模型给的 `key` 比对。

> **安全前提**：模型**无法**选择或影响 sessionId——它由桥接在 `session/create` 时传入
> （`dsh-host-apiproxy`：`request.payload.sessionId ?? session-${randomUUID()}`），
> 模型既看不到也改不了。这正是本方案与「信任 `arguments.key`」的本质区别。

### 判定规则（`sessionBindingDenial(exec, args)`）

| 情形 | 结果 |
| --- | --- |
| 工具是 `qq_status`（唯一无需 key 的工具，schema 里根本没有 key） | 放行 |
| 工具**声明**了 `key`，但调用没传 | 拒绝（不能因为模型省了参数就跳过守卫） |
| `key` 归一化后 === 可信 self | 放行 |
| `key` !== self | 拒绝，**唯一例外**见下 |
| 会话解不出身份（未绑定） | 拒绝 |
| `qq_send_message` / `qq_get_message_detail` 的 `target` | 当作 `key` 的别名，同样受限 |

> `qq_list_groups` / `qq_get_group_history` **曾**在这份豁免名单里，因为旧的无令牌形态确实
> 没有 key。两者改成 v2 形态（schema 要求 `key: string`）后必须重新纳入绑定校验——
> 否则「声明了 key、少传一个就跳过守卫」，正是本模块最想堵的那个洞。

所有拒绝都返回**同一个**文案 `'该会话不可用'`（`SESSION_UNAVAILABLE`），刻意不区分「没绑定」
与「绑定了别的会话」——否则攻击者能靠文案差异枚举群号（oracle）。

### 管理员私聊的只读例外

管理员（`ownerQQ`）私聊会话要能读**任意群**的只读信息，否则「你帮我看看群里刚说什么」永远答不了。
放行只发生在**三重条件同时成立**时：

1. 当前 DSH 会话是 `ownerQQ` 的私聊会话（由 sessionId 解出）；
2. 调用的是**只读**工具，分两档：
   - `QQ_OWNER_READABLE_GROUP_TOOLS` = `qq_get_group_history` / `qq_get_group_members`，
     要求目标 key 是 `group:正整数`；
   - `QQ_OWNER_ANY_KEY_TOOLS` = `qq_list_groups`，它读的是「机器人所在的全部群」这一全局信息，
     key 只用来绑会话，填自己的私聊 key 或任意群号都成立——否则「先查有哪些群、再挑一个读历史」
     这条主链路第一步就断；
   - 发送类绝不在此列，否则管理员会话能代发到任意群；
3. 目标 key 归一化成功（非空、格式合法）。

桥接侧（`src/bridge.js` 的 `isOwnerSessionToken` + `/api/socialV2/group-*` 端点）会**再做一次**
同样的判定：插件层放「谁」，桥接层放「读」。

**`ownerQQ` 必须从磁盘读**（`ownerQQFromFile()`）。实测 `exec` 上只有 `name` / `arguments` / `agent`，
`exec.config`、`exec.ctx.config`、`exec.agent.config` 三者都不存在——只靠 `exec` 取 `ownerQQ`
永远是空串，例外永不生效，表现就是管理员私聊问「群里说了啥」永远回「该会话不可用」。
候选目录依次为 `QQ_BRIDGE_HOME` 环境变量 → `path.resolve(__dirname, '..', '..')`
（DSH 通过 junction 加载时 Node 解析到真实路径，仍落在仓库根）→ `D:\qq-bridge`。
读不到就返回 `''`，例外自动关闭（**失败关闭**，不放宽）。

## 五、改动与验证

| 改了什么 | 生效方式 |
| --- | --- |
| `qq-tool-restrict.mjs` / `qq-self-key.mjs` | **重启 DSH**（这两个模块在 DSH 进程内加载） |
| `presets/*.patch.yml` | 不要手改；改 `dsh/agent-presets/` 源文件后跑 `node scripts/build-agent-preset-patches.mjs`，再重启 DSH |
| `package.json` 的 `dsh.bundle.patch` | 重跑 `node scripts/setup-dsh.mjs <profile>`，再重启 DSH |
| `index.js` / `client.js` / `qq-panel.patch.yml` | 不用重启：`POST /dsh-unlag/reload`（头 `x-dsh-unlag: 1`）热重载；或重启 DSH |

```powershell
node scripts/test-preset-local-tools.mjs     # 守卫名单 ↔ DSH 真实工具名双向对账（防拼写假名）
node scripts/test-qq-preset-contract.mjs     # preset 行形状与 persona 一致性
node scripts/test-agent-preset-patches.mjs   # patch 生成物与守卫契约
node scripts/test-audit-setup-guards.mjs     # 安装期守卫与子包 license
node scripts/scan-dsh-tool-names.mjs         # 手动对账：从已安装的 @deepseek-ai/dsh-* 抽真实工具名
```

快速判断守卫是否真的生效：新会话的工具清单里是否还挂着本该被隐藏的名字（例如 `bash` / `read`），
以及 MCP 子进程的创建时间是否新于改动时间（`Get-Process node` 里看 `mcp-snowluma-safe.js` 那一行）；
失败原因看 `state/tool-restrict.log`。

### 改完守卫**必须重启 DSH**，热重载不生效

`qq-tool-restrict.mjs` 是 preset 的子行（`name: qq-agent-presets/qq-tool-restrict.mjs`），不是独立 bundle。
`dsh-unlag` 的热重载会把它判成 `unmanaged-plugin` 放进 `pending` 并挂起：

```
POST /dsh-unlag/reload → {"status":"restart","rebuild":"pending",
  "pending":[{"url":"file:///D:/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs",
              "reason":"unmanaged-plugin"}]}
```

判定依据是 `state/tool-restrict.log` 的 mtime —— 热重载后它**不会更新**，说明 `apply()` 根本没重跑，
`ctx.tools.restrict()` 下发的 deny 快照仍是旧的那份。2026-11-09 实测：DSH 主进程连续跑了 3 天，
`tool-restrict.log` 就停在 3 天前第一次装载的时刻，期间改了名单也不生效。

所以**改了守卫 → 重启 DSH → 用 `/api/session/reset` 让 QQ 会话重建 → 再看 `tool-restrict.log` 的 mtime 变了没**。

## 六、面板（`index.js` / `client.js`）

侧边栏出现一个「小鲸鱼」图标，点开是整页仪表盘，**六节**：**01 生命与看护（左栏「现在能不能用」+ 右栏「怎么让它一直能用」）→
02 今日花费与模型 → 03 运行模式 → 04 表情与语音（本地目录自动入库 + 每张卡可删 + 念一句 + 语音库）→ 05 会话 → 06 人格**。
页头还有一条导航 chip（`生命与看护 / 花费 / 模式 / 表情与语音 / 会话 / 人格`），点一下先撑开目标节再滚过去 ——
「不用每次上下翻找各项功能」。

> **1.9.1 起的重排（照 app 排版，能去掉的都去掉）。**
> ① `01 生命开关` 与 `02 掉线看护` 合并成 `01 生命与看护`，用 `.qqp-cols` 做左右两栏：左栏只回答
> 「现在能不能用」（大开关 + 四环链路 + 四格事实 + 白名单），右栏只回答「怎么让它一直能用」
> （自动重启 / 探活间隔 / 一键拉起 / 只回消息 / 免打扰 / 合盖保活 / 上次拉起 / 日志）。窄屏（≤900px）
> 自动塌成上下两段。
> ② `08 眼睛` 从界面上摘掉（**代码一行没删**，`EyesSection` 与 host 的 `/eyes`、`/eyes/images` 路由都还在；
> 首屏也不再预拉 `loadEyes` —— 它要按会话拉全量消息，是这批请求里最重的一个）。原来展开一次就是
> 一整屏会话列表 + 消息流，与「05 会话」信息重叠，日常用不上。想放回来：把 `client.js` 里 08 那段的
> `null` 换成 `h(EyesSection, {...})`，并把 `loadEyes('')` 加回首屏 effect。
> ③ 表情缩略图再收一档：格子 `82×44` → `62×34`，字体 10 → 9px，瓦片里的按钮从「写备注 / 删」
> 收成「改 / 删」单字 + `title` 说明，使用次数从 `用 N 次` pill 收成 `×N`。一屏能多铺三四行。
> ④ 节与节之间 18 → 14px，标题下沿 6 → 5px，正文上沿 11 → 8px。

> 1.9.0 起这一节按「能去掉的都去掉，只留可操作按钮和一句话」重排过：每节的说明压到一行、
> 页面只保留开关与状态 pill，正文里的整段教学文字搬到了本 README。同一行里不再重复说同一件事
> （例：「探活间隔」后面只留 `失败 0` / `重启 19` / `15 秒前探过` 三个 pill）。

> 1.7.0 起删掉了原「04 角色预设」与「05 工具守卫」两节：前者只是把 `presets/*.patch.yml` 里的字段
> 摊开给人看，改 preset 本来就得改 yml 再重启，看板不解决任何问题；后者是守卫名单的只读展示 +
> 一个「判定演练」输入框，而真正要判断的事（这条工具调用了没）看 `state/tool-restrict.log` 更准。
> 两节一起去掉后，面板从十一节收缩到九节，节号连续（01–09），顺带清掉了 22 条只喂这两节的 CSS
> 和 4 条历史孤儿规则。

> **1.8.0 起把「表情库」和「语音与记忆」并成了「05 表情与语音」。** 这两节原本各占一屏：前者是
> 满屏缩略图 + 四格指标 + 三行文件路径，后者是五个状态行 + 念一句表单 + 音频列表 + 记忆三行。
> 合并后：四格指标压成一行小字、文件路径压成一行、语音的五个状态行压成一行「点 + 名 + 值」横排、
> 记忆从「一节」降级成节末一行（它本来就是只读的，不值得单独一节），整个节 `defaultOpen: false`
> 默认收起。**九节 → 八节，节号连续（01–08）**；1.9.1 起再进一步收缩到六节（见本节开头的重排说明）。

### 每一节都能折叠

节标题整行可点（`role="button"` + `tabIndex=0` + `aria-expanded`，支持 Enter/Space），
再点一次收起 —— 展开状态由 `Sec` 组件自己用 `useState` 持有，所以位置固定、反复重渲染不丢。
收起后右侧摘要（`29 张表情 · 语音 12 段`、`3 个会话`）仍然显示，折起来也知道里面有什么。

`05 表情与语音` 默认就是收起的（`defaultOpen: false`），而且里面还有一层折叠：表情网格默认只露前
**6 张**，同一颗按钮在 `展开全部 29 张` ⇄ `收起` 之间来回切。26 张表情铺满屏太占地方。

同一件事的按钮只留一个：原来「从 QQ 同步」在底部单独一行、「扫一次」在中间，
现在合并成一块「收表情进来」——`从 QQ 同步` 与 `扫本地目录` 并排，说明文字也合并。

### 为什么必须有一个 host 半

浏览器**不能**直接连 `127.0.0.1:3100`，两条独立的墙都会把它拦死：

1. **令牌**：桥接控制台要求 `x-console-token`（或 `?token=`），令牌躺在 `state/console-token` 里，
   只有本机进程读得到。浏览器发不出这个头，`/api/status` 一类直接 401。
2. **Origin 校验**（`bridge.js:3885-3903`）：非 GET 请求若带 `Origin`，其 host 必须是 3100 自己，
   否则 **403「跨站请求被拒绝」**。DSH Web GUI 在 55336，跨源写操作必被拒。

所以令牌与写操作只能留在主进程：`index.js` 用 `node:http` 打回环地址，回给浏览器的是同源的
`/qq-panel/api/*`。**面板不需要用户填任何令牌。**

### 33 个 path（31 条 JSON 路由 + 2 条字节通道）

| 路由 | 干什么 |
| --- | --- |
| `GET /qq-panel/api/overview` | 一次并发读齐：`/api/status`、`/api/socialV2/activity`、`/api/dsh/model`、`/api/tokens/series?hours=24`、`/api/tokens/summary?limit=1`，外加本机探活（3100 / 3000 / QQ 进程）与电源现状（`power` 字段） |
| `GET /qq-panel/api/health` | 只回落活结论：`{bridgeAlive, oneBotAlive, qqKnown, qqRunning, qqLaunchable, detail}` |
| `GET /qq-panel/api/capabilities` | 只读现状说明：为什么还不能发语音、记忆为什么是空的（`{voice, memory, ...}`） |
| `GET/POST /qq-panel/api/power` | 合盖保活：GET 只读当前电源方案的「合盖动作 / 空闲睡眠 / 空闲休眠」三项；POST `{on: true}` 把三项都设成 0（不采取任何操作），`{on: false}` 还原成合盖就睡（合盖=睡眠 1、空闲睡眠 AC 1800s/DC 900s、空闲休眠 AC 3600s/DC 1800s），两种都写完回读确认；`on` 不是布尔值回 400 |
| `POST /qq-panel/api/life` | `{on: boolean}` → 桥接 `POST /api/socialV2/activity` `{paused: !on}` |
| `GET/POST /qq-panel/api/watchdog` | 探活开关 / 间隔 / 阈值 / 冷却，落 `D:\DSHHome\qq-panel-watchdog.json` |
| `POST /qq-panel/api/restart` | 手动一键拉起 `start-whale.ps1 -NoDsh` |
| `POST /qq-panel/api/mode` | 切运行模式（写穿 `state/mode.json` + DSH 设置） |
| `POST /qq-panel/api/wake` | 唤醒调整：`{on: true}` 切「只回消息」（关掉回复复查 / 主动开话题 / 潜水到期三类定时自动唤醒，只在收到 @/关键词/私聊/提问/拍一拍时激活）；`{on: false}` 恢复默认。写穿 `config.json` 的 `socialV2.wake.onlyOnMessage` |
| `POST /qq-panel/api/quiet` | 免打扰时段：`{enabled, start, end, muteMessages}`（任一字段可省，省掉的沿用现值），写穿 `config.json` 的 `socialV2.wake.quietHours`。时段内只压定时唤醒（`timeout` / `replyCheck` / `proactiveCheck`），`muteMessages: true` 才连消息类一起压；起止相同回 400（那等于全天静默） |
| `POST /qq-panel/api/lock-model` | 锁定默认模型：`{on: true}` 写 `config.json` 的 `dsh.lockDefaultModel`，之后桥接每个探活周期把 DSH 全局默认模型（`agent-default-model` 设置命名空间）同步成 `provider/model/reasoningEffort`；`{on: false}` 解锁，桥接不再碰 DSH 全局默认模型。`on` 不是布尔值回 400 |
| `POST /qq-panel/api/stickers` | 表情库列表（`{query, count}`），桥接不可达时降级直读 `state/stickers.json` 并标 `source:'file'` |
| `POST /qq-panel/api/stickers/note` | 给一张表情写备注 / 标签 / 用法 |
| `POST /qq-panel/api/stickers/sync` | 强制从 QQ 账号同步一次收藏表情 |
| `POST /qq-panel/api/stickers/scan` | 扫本地表情目录（`{adopt}`；**默认只清点**，`adopt:true` 才把新文件入库） |
| `GET /qq-panel/api/sticker-file?name=` | 按文件名取 `state/stickers` 下的图片字节（`cache-control: no-store`）。**返回图片而不是 JSON**，所以单独注册、不走统一 `sendJson` |
| `POST /qq-panel/api/voices` | 语音库列表（`{probe}`；`probe:true` 才 spawn ffprobe 补时长）+ 四条 TTS 路的体检（`tts` 是 SAPI、`edge` 是 Edge、`kokoro` 是本机离线、`breeze` 是 Breezeblue 云端）+ 当前音色偏好（`prefs`） |
| `POST /qq-panel/api/voices/tts` | 念一句，落成音频进语音库（`{text, engine?, voice?, rate?, volume?, name?}`）。`engine:'kokoro'` 走本机离线、`'edge'` 走微软在线语音出 mp3、`'breeze'` 走 Breezeblue 云端出 wav，否则走本机 SAPI 出 wav |
| `POST /qq-panel/api/voices/prefs` | 记住音色（`{engine, voice, rate}`），写到 `$DSH_HOME/qq-panel-voice.json` |
| `POST /qq-panel/api/voices/delete` | 删语音库里的一个音频（只认文件名） |
| `POST /qq-panel/api/voices/send` | 试发到某个会话（`{name, key, dryRun?}`）；`dryRun:true` 只校验不真发 |
| `GET /qq-panel/api/voice-file?name=` | 语音字节通道（`<audio src>` 用），同样单独注册、不走 `sendJson` |
| `GET/POST /qq-panel/api/sessions` | 读 / 整段写 `config.json` 的 `allow.private` 与 `allow.groups`，返回 `needsRestart` |
| `GET /qq-panel/api/roles` | 人格清单 + 当前人格 + 限额 |
| `POST /qq-panel/api/roles/content` | 读一份人格正文 |
| `POST /qq-panel/api/roles/save` | 新建 / 更新人格（`mode:'create'` 走 create） |
| `POST /qq-panel/api/roles/rename` `· /roles/delete` `· /roles/activate` | 改名 / 删除 / 启用 |
| `POST /qq-panel/api/eyes` | 眼睛：`{key}` 为空列会话，否则拉该会话的消息（群走 group-history、私聊走 recent） |
| `POST /qq-panel/api/eyes/images` | 取某条消息里的图片 |
| `POST /qq-panel/api/stickers/remove` | 从本地表情库移除一张（`{stickerId}`，不动 QQ 账号收藏），删完顺手 prune |
| `POST /qq-panel/api/stickers/prune` | 清掉「记录还在、图片文件已不存在」的死条目 |

**注意一个 path 只能注册一条 handler**：`ctx.webServer.register` 是按 path 精确匹配的，
`route('GET','/sessions')` 之后再 `route('POST','/sessions')`，后者会把前者顶掉（真机表现是
GET 回 405）。所以 `index.js` 里改用 `routeTable` 按 path 归并，handler 内部再按 method 派发。

### 写操作的状态码：4xx 透传，只有连不上才 502

桥接回 4xx 是在说「你这次请求有问题」（人格重名、文件不存在、名字为空），面板必须原样透传；
一律包成 502 的话界面只会显示「网关错误」，用户既不知道错在哪也没法改。`bridgeFailure()` 的规则：

- 桥接回 **4xx** → 透传该 4xx；
- 桥接**连不上**或回 5xx → 502；超时 → 504；
- 错误文案优先取桥接的 `message`，其次 `error`（桥接两种写法都用）——不要退回「HTTP 404」这种没有信息量的兜底。

### 请求体读坏了，回 4xx 而不是「当成没传」

`readJsonBody()` 有三种「读不到 body」的情形，**它们都必须和「真的没传字段」区分开**：

| 情形 | 旧行为（1.3.0 及之前） | 现在 |
| --- | --- | --- |
| 超过 64 KiB | `req.destroy()` + 当成 `{}` → 客户端只看到「连接被重置」 | **413** `请求体太大（上限 64 KiB）`，读完剩余字节再丢 |
| 不是合法 JSON | 当成 `{}` | **400** `请求体不是合法 JSON` |
| 顶层不是对象（`null` / 数组 / 字符串） | 当成 `{}` | **400** `请求体必须是一个 JSON 对象` |
| 连接中途断开 | 当成 `{}` | **400** `请求体读取中断` |

为什么非改不可：`{}` 与「畸形的 body」混为一谈时，任何校验只写 `if (body.on !== true)` 的
`setXxx` 都会把畸形输入执行成「关掉 / 清空」。真机上踩到过两次——`POST /life` 空 body 关掉了
生命开关、`POST /roles/activate` 空 body 清掉了人格。现在读坏时抛出 `BodyError`，
路由层据此回 4xx 并带可读原因，**handler 根本不会被调用**。

> 所以新增 `setXxx` 时仍然要显式校验（`typeof body?.on !== 'boolean'` → 400、
> `!hasOwnProperty(body, 'role')` → 400）。4xx 是两道闸里的外层那道，不是唯一那道。

### 降级：`life.on === null` 是「未知」，不是「关」

桥接没起来时 `/overview` 仍回 **200**，但 `life.on` 是 `null`、`bridge.reachable` 是 `false`、
`spend.available` 是 `false`，`model.source` 回退成 `config.json`。界面显示「读不到状态」并给出
「一键拉起」——**绝不在读不到的时候瞎猜成「已断开」**。只有 `POST /life` 会 502（写操作不能假装成功）。

### 看护与自动重启

每 `probeMs`（默认 15 s）探**三层**（并行，避免被单层超时拖慢）：

1. `node:net` 连 **3100**（桥接控制台）
2. `node:net` 连 **3000**（OneBot，桥接的输入源）
3. `execFile('tasklist.exe', ['/NH','/FO','CSV','/FI','IMAGENAME eq QQ.exe'])` 看 **QQ 客户端在不在**（实测 94 ms）

**只要有任何一层不通就记为失败**——早先版本「3100 活着就算 OK」，导致「QQ 掉了 / SnowLuma 死了但桥接还活着」永远不触发重启。

连续 `failThreshold` 次（默认 2）失败后才考虑拉起，还要过这几道闸：

| 闸 | 条件 | 为什么 |
| --- | --- | --- |
| 总开关 | `enabled && autoRestart` | 用户手动关掉就只记账不动手 |
| 熔断 | `streakRestarts >= maxAttempts`（默认 3） | 见下 |
| QQ 可拉起性 | `qqLaunchable === false` 时**不拉** | 找不到 `QQ.exe` 就拉不起来，别每 15 秒白跑一次 100 秒的脚本 |
| 并发 | 上一次的脚本还在跑 | 连点按钮不会叠出多个 powershell |
| 阈值 | `failures < failThreshold` | 单次抖动不惊动 |
| 冷却 + 退避 | 距上次拉起 `< cooldownMs × 2^(streak-1)`（倍数上限 8） | 见下 |

**熔断与退避（2026-11-05 真机踩出来的）。** 上一版只有固定 180 秒冷却，于是「QQ 小号没登录 →
OneBot 永远不开」这种**修不好**的故障会让看护每 3 分钟把 SnowLuma + bridge 整套杀一遍重起，
`restarts` 一路涨到 6 而 `3000` 一次都没开过。那不是修复，那是制造故障。现在：

- **退避**：第 N 次连续白拉后冷却乘 `2^(N-1)`（上限 ×8）。一次持续故障不会以固定频率反复重启服务。
- **熔断**：连续 `maxAttempts` 次（默认 3）拉起后仍不通，就**停手**，并在日志与面板上明说
  「问题多半不是掉线」。此时只有人能把它打开：点「一键拉起」、或把「自动重启」关掉再打开，都会重置计数。
- **计数只在真正恢复后清零**（`ok === true`），不看「这次拉起命令是否成功」——
  脚本 exit=0 只说明它跑完了，不说明 QQ 通了。
- 手动拉起遇到「上一次还在跑」时会**原样回话且不动计数**：那次点击什么都没发生，
  清了计数等于让「白拉 N 次」的账凭空消失（白盒测试抓到过这个语义错误）。

`qqLaunchable` 的判定顺序：`config.qqExe` → 环境变量 `QQ_PANEL_QQ` → 候选路径（`D:\QQ\QQ.exe` 等）→ 注册表 `HKLM\SOFTWARE\WOW6432Node\Tencent\QQNT` 的 `Install`。**查不到 `QQ.exe` 时面板会说「拉不起来」，而不是假装能拉。**

拉起时 UI 会显示 `正在拉起（已 N 秒）`、按钮禁用、轮询从 10 s 缩到 3 s，结束后留下「上次拉起：exit=0 / 用了 N 秒 / 结束时刻」——**不再是一句错误的「约 30 秒内恢复」（实测 18~24 秒，历史最慢 106 秒）。**

> **踩过的坑：Windows 上 `detached: true` 的 node 子进程一条命令都不会执行。**
> 实测 `spawn(ps, ['-Command','exit 3'], {detached:true, stdio:'ignore'})` 回 `exit 0`，
> 连它该写的文件都不存在；去掉 `detached` 立刻正常。原因是 DSH 的 Windows 作业对象把放掉的子进程
> 直接收走。最终实现用**普通子进程 + `stdio: ['ignore', fd, fd]` 重定向到
> `state/qq-panel-restart.log`**，`child.on('exit')` 记一行结束日志；真正需要脱离的 node 服务
> （SnowLuma / bridge）由 `start-whale.ps1` 自己用 WMI `Win32_Process.Create` 拉起。
> 脚本 5 分钟还没退（`SCRIPT_STUCK_MS`）就主动 `kill` 并记 `timedOut: true`。

### 合盖保活（机器睡着比进程掉线更隐蔽）

「进程掉线」看护能拉起，但「机器睡着了」它察觉不到——SnowLuma 收不到包、bridge 不再回话，
面板上却看着「一切正常」。笔记本出厂默认**合盖就睡**，这是「状态开着却不回」里最容易被忽略的一种。

面板在「掉线看护」节里放了一行「合盖保活」：读当前电源方案的**合盖动作 / 空闲睡眠 / 空闲休眠**
三项（AC+DC），只要有一项不是 0，就显示「合盖会睡」并给一个「设成合盖不睡」按钮。
点下去用 `powercfg` 把三项都写成 0（不采取任何操作），写完 `setactive` 生效并回读确认。
已经是「合盖与空闲都不睡」时，同一个位置换成「还原成合盖就睡」（点前弹确认框，`POST {on: false}`）——
**改系统电源设置的写操作必须双向**，只进不出等于把开关做成单向阀。

几条刻意的取舍：

- **只碰三项，不碰显示器超时**（人可能只是想关屏）、**不碰 S0/Modern Standby 固件行为**（改那个要重启、不同 BIOS 表现不一）。
- **逐条 `powercfg` 写而非直接改注册表**：powercfg 会通知系统刷新缓存；直接写 Registry 要等下次切方案才生效，人会以为「点了没反应」。
- 写完后 `-ATTRIB_HIDE` 取消「合上盖子操作」的隐藏属性，让用户能在系统电源设置里自己复核。
- **判据严格**：只有 AC 与 DC 都等于 0 才算「已关」；`null`（该方案没写过）不算，因为默认很可能就是睡眠。只 AC 关、DC 开时标「只有接电源时有效」。
- 读的是**当前活动方案**（`powercfg /getactivescheme`），不是写死高性能；机器切方案后以活动方案为准。
- **还原写的是「出厂默认意图」而不是「写入前的快照」**：这三项在上线时本来就被设成了 0，快照还原回来还是 0，等于没还原。所以还原固定写「合盖=睡眠、空闲 30 分钟睡眠、60 分钟休眠」——这几个值用户能在系统电源设置里自己微调。

> 配套脚本 `D:\DeepseekWorkSpace\quiet-lid.ps1` 是等价的一键重放（含 `#Requires -RunAsAdministrator`），
> 供命令行场景使用；面板按钮走的是同一套 `powercfg` 命令，但**不要求**管理员（实测非提权下也能写 HKLM）。

### 唤醒的三道闸：只回消息、免打扰时段、唤醒额度

机器人「状态开着却不回」和「半夜自己冒一句」，是同一套唤醒机制的两个极端。面板上给前两道闸留了开关，
第三道闸在桥接里，只能看它工作、不能拧。

**第一道：只回消息**（`POST /qq-panel/api/wake` → `socialV2.wake.onlyOnMessage`）
关掉三类**定时**唤醒——`replyCheck`（回完话 30 秒后复查有没有后续）、`proactiveCheck`（隔 30~90 分钟掷骰子主动开话题）、
`timeout`（潜水到期自动醒）。关掉后只有 `private` / `atMention` / `nameMention` / `poke` / `question` / `keyword` 这些
**有人找它**的信号能叫醒它。这是省 token 最直接的一档：空转的唤醒里绝大多数就是这三类。

**第二道：免打扰时段**（`POST /qq-panel/api/quiet` → `socialV2.wake.quietHours`）
按**北京时间**的 `{enabled, start, end, muteMessages}` 划一段「别主动开口」的窗口。默认可设 `23:00 ~ 08:00`，
等价于「白天 08:00 ~ 23:00 可以唤醒」。三个边界必须写清楚：

- **跨午夜靠 `start > end` 表达**，`23:00 ~ 08:00` 就是这个意思；判定是左闭右开，`08:00` 整已恢复。
- **`start === end` 视为「没设」**，不是「全天静默」。真按字面算它就是全天（或全天外），
  谁也叫不醒它——那是最难排查的一类死锁，所以在 `quietWindow()` 里直接返回 `null`，接口层也回 400。
- **`muteMessages` 默认 `false`**：时段内只压定时唤醒，真有私聊或 @ 照样叫醒。设 `true` 才是彻底静默
  （半夜有人真找它，它也不会应）；这个取舍没有正确答案，所以让它显式可选。

时段结束必须**自己续排**：被压掉的 `timeout` 是一次性定时器，压掉就没了。所以压唤醒时会挂一个
`quietResumeTimer`（`scheduleQuietResumeV2`，按到窗口结束的剩余毫秒算，超过 `100009ms` 分段续期），
到点重排 `setupSleepTimerV2` + `scheduleProactiveCheckV2`，否则会话会一直静默到下次有人说话。

**第三道：唤醒额度**（`maxWakePerMinute: 1` / `maxWakePerHour: 12`，只能改 `config.json`）
撞线时不丢，起一个单槽 `rateLimitRetryTimer` 最多等 60 秒重试。注意 **`timeout` / `replyCheck` /
`proactiveCheck` / `bootstrap` / `admin` 这五类定时唤醒不占额度**（2026-11-09 起），额度只留给「真人带来的唤醒」，
否则 30 秒一次的回复复查会把私聊的额度挤光，表现就是「连发三条它都不理」。

> 这三道闸都只影响**唤醒**，不影响收发：关掉之后它照样能回话发消息，只是不会自己醒。
> 全部状态都落在 `config.json` 的 `socialV2.wake` 下，改完立刻生效（桥接读的是内存里的 cfg，写盘是顺带的）。

### 为什么「一键拉起」必须连 QQ 一起管

链路是 `QQ 客户端 → SnowLuma（hook 进 QQ 进程）→ OneBot 3000 → qq-bridge`。中间任何一环缺了，
`3000` 都不会开。两个反直觉的事实：

1. **SnowLuma 不会启动 QQ**。`listHookProcesses()` 只是枚举已存在的 `QQ.exe` 再 `loadModuleManualAsync`；
   源码里没有 `startQq` / `QQPath` / `injectDll` 之类能拉起 QQ 的东西。
2. **SnowLuma 默认 `hookAutoLoad: false`**（`config/runtime.json`），此时它只被动等 hook 管道出现，
   绝不主动注入。`resolveAutoLoad()` 认环境变量 `SNOWLUMA_HOOK_AUTOLOAD`（`1/true/yes/on`），
   所以脚本用 `-envPairs @('SNOWLUMA_HOOK_AUTOLOAD=1')` 覆盖，**不去改用户的配置文件**。

因此 `start-whale.ps1` 的 §2.5 先拉 QQ（WMI `cmd /c start "" "<QQ.exe>"`），§3 再带 autoLoad 拉 SnowLuma；
QQ 已在跑时等待窗口从 40 秒放宽到 120 秒（hook 注入 + 等登录最久 60 秒）。

**登录那一步脚本替不了你**：面板会明说「登完你的小号 QQ，SnowLuma 会自己 hook 上去」，
`state/snowluma.log` 里出现 `login detected` 才算真连上。

### 花费口径

「今日」按**北京时间 00:00** 切（`todayStartMs()` 用 `+8h` 对齐再减回来）。金额、档位、缓存命中率
全部来自桥接的 `token-ledger.js` 与 `model-prices.js`，面板不自己算钱——两处口径各自维护必然漂移。
桥接读不到时整块显示 `—`，不显示 0（0 和「不知道」是两回事）。

### 04–06 这三节各自卡在哪

| 节 | 数据从哪来 | 必须知道的一件事实 |
| --- | --- | --- |
| 04 表情与语音 | 表情：桥接 `POST /api/stickers`，不可达时直读 `state/stickers.json`；本地目录走 `/stickers/scan`；删除/清理走 `/stickers/remove`、`/stickers/prune`。语音：本机目录 + `voice-core` 的格式清单 + 本机 SAPI。记忆：直读 `state/social-v2.json` 统计 | 库存文件是**进程内存里的权威副本**，见下；预览必须走面板自己的 `/sticker-file` 通道；图片被删后记录会残留在库里，靠 prune 清。**语音有两道不同的闸**，见下；记忆是**按会话**存的，换会话即空是设计如此 |
| 05 会话 | 读 `config.json` 的 `allow`，叠 `/api/socialV2/states` 的未读/唤醒数 | `allow` **没有 HTTP 写接口**，且 `loadConfig()` 只启动时读一次（`bridge.js:1478`）→ 改完必须重启桥接，界面如实标「需重启」。**群与私聊并排成左右两列**（`.qqp-cols2`，等宽 1:1），窄屏塌成上下 |
| 06 人格 | `/api/roles*` 全套 CRUD | 面板**不重写校验**：名字长度、正文上限、注入上限全由桥接判，两端两套规则最难查 |

> `08 眼睛` 那一节的接口（`/api/socialV2/states` + `recent` / `group-history` + `/api/images/message`）
> 仍然留在 host 半：它是「人借面板的视角」，用控制台令牌，**不改变 AI 自己的会话隔离**。
> 界面上去掉的是入口，不是能力。

### 语音的两道闸（别合并成一个布尔）

这是本节最容易搞混、也最容易做错的一处：

| 通道 | 接口 | 要看 `voice.enabled` 吗 |
| --- | --- | --- |
| 操作者（面板「试发」） | `POST /api/voice/send`（控制台令牌） | **不看**。有音频、目录能读就能发 |
| AI（机器人自己开口） | `POST /api/socialV2/send-voice`（agent token） | **要看**：`voice.enabled` + `tools.sendVoice` 都得 true，否则 403 |

所以面板上 `canSendNow`（能试发）和 `aiCanSend`（AI 会自己开口）是**两个独立结论**。
早先版本把它们合成一个「还不能发」，会让人以为整条链路都断了——实际上面板一直能发，
只是 AI 不许自己开口。这两个开关面板也不代劳（要改本机 `config.json`），理由：
`ffmpegPath` 被桥接 HTTP 接口明确拒绝（只能本机配置或 `FFMPEG_PATH`），
而且语音是「开口说话」的强表达，值得手动确认一次。

**ffmpeg 不是必需的**：它只在调音量/响度时才 spawn（`processAudioVolume` 在
volume≈1 且 loudness=null 时直接返回原文件）。时长探测要 **ffprobe**，缺了只是不校验时长，
`inspectAudio` 仍返回 `ok:true` 并推一条 warning，不阻断发送。

**本机 TTS 走 PowerShell 而不是 Node**：Node 没有 SAPI 绑定，`System.Speech` 只在 .NET 侧。
`scripts/tts-sapi.ps1` 用 `-File` 启动、文本经 **UTF-8 文件**传入——把中文直接塞进命令行
会被控制台代码页（本机 GBK）转成问号。脚本本身必须存成 **UTF-8 带 BOM**，否则
PowerShell 5.1 按 GBK 解析 param 块会报 `Unexpected token ')'`。

### 四条 TTS 路线：为什么既要 Kokoro 又要 Edge / SAPI / Breezeblue

本机有四条独立能出声的路，音色完全不同，面板让管理员自己选，选择记在本机：

| 引擎 | 怎么跑 | 中文音色 | 代价 |
|---|---|---|---|
| `kokoro`（默认） | 本机离线 `sherpa-onnx-node` 跑 Kokoro v1.1-zh | 8 个真实女声（小岚 / 小满 / 小禾 / 小霜 / 小榆 / 小茉 / 小舟 / 小棠） | 要 393MB 模型 + 常驻约 400~600MB 内存，首次加载约 4 秒 |
| `edge` | `@andresaya/edge-tts` 连微软在线语音 | 8 个（晓晓 / 晓伊 / 晓北 / 晓妮 / 晓臻 / 云希 / 云健 / 云扬） | **要联网**，播音腔，连发会被 429 限流 |
| `sapi` | `scripts/tts-sapi.ps1` 调 Windows `System.Speech` | 只有 `Microsoft Huihui Desktop`（慧慧） | 离线零依赖，但听着像播报 |
| `breeze` | `api.breeze.blue` 云端合成，用你在 Breezeblue 设计的克隆音色 | 1 个（`voc_d4utea6v6cm3`，年轻女声 · 明快 · 俏皮） | **要联网 + 耗 key 额度**，配置见 `config.json` 的 `socialV2.voice.breeze` |

**为什么默认 Kokoro**：Edge 的中文是播音腔（且其 SSML `express-as` 风格接口会直接回
`The service refused the request: SSML is invalid`，只能调 pitch/rate/volume，做不出「真人感」）；
SAPI 中文只有慧慧一个。Kokoro 是 100+ 小时中文真人数据训的 StyleTTS2 系，55 个女声里
按「基频起伏 + 与用户样本 Maia.wav 的谱距离」挑出 8 个最像真人的（小岚 sid=39 起伏最大，最推荐）。

**Breezeblue 是「真人克隆音色」**：它是你在 Breezeblue 上传样本克隆出来的专属音色，比
Kokoro / Edge / SAPI 都更接近目标真人。密钥 `apiKey` 与音色 `voiceId` 不写死在代码里，
而放在 `config.json` 的 `socialV2.voice.breeze` 段（`enabled` / `apiKey` / `voiceId` /
`probability` / `minChars` / `outputFormat`）。

**回复自动随机附带语音**：桥接在 AI 成功发出文字消息（`send-message` / `send-burst`）后，
会按 `probability`（默认 0.3）概率随机附带一句 Breezeblue 语音，**不固定台词**。内容分两种模式：

- `useMouth: false`（旧行为）：从本次回复里随机挑一条念出来，内容随回复走。
- `useMouth: true`（「给大肥鱼一个嘴」，推荐）：桥接起一个**独立的 DSH 会话**（存于
  `state/voice-mouth-session.json`），每次命中概率就把**刚发出的文字消息**作为上下文投给
  它，让它「顺着刚才的文字补一句语音」，带人格与身份上下文，等它生成后**把这句话**用
  Breezeblue 合成并作为语音发送——**语音和文字聊的是同一件事、同一语气，是补充/接续/呼应，
  不会各说各的**。

合成 / 发送失败只会静默记日志，不影响文字消息本身。
语音仍受 `socialV2.voice.enabled`、`socialV2.tools.sendVoice`、每分钟/每小时限流三重约束。
嘴会话复用黑话学习会话的「独立会话 + follow + ensureChatModel + prompt + 等 turn」骨架，
与主会话、黑话学习会话互不干扰。

**Kokoro 为什么必须常驻**：模型加载 3.7 秒、合成一句 1.4 秒（无缓存加速）。插件起一个
`scripts/tts-kokoro.cjs --serve` 子进程从 stdin 读 JSON 逐句合成，空闲 5 分钟 `unref()` 自收。
启动它的 `node` 必须用 `D:\nodejs\node.exe`（`resolveNodeExe()`），不能用 `process.execPath`——
DSH 里那是指向 `DeepSeek Harness.exe`（Electron），sherpa 原生模块在 Electron 运行时里抛
`External buffers are not allowed`。

**为什么 Edge 在插件里要用 `createRequire` 而不是 `import`**：插件本体是 ESM、edge-tts 是 CJS，
更要紧的是插件运行时的真实路径是 `<profile>/node_modules/qq-agent-presets`（junction 到仓库），
从那里向上找的 `node_modules` 才是装了 edge-tts 的那一份。直接在包目录 `import('@andresaya/edge-tts')`
会 `ERR_MODULE_NOT_FOUND`（实测）。所以用 `createRequire(<profile>/node_modules/qq-agent-presets/index.js)`
再 `require('@andresaya/edge-tts')`，候选 base 依次是 `$DSH_PROFILE_DIR`、`$DSH_HOME/profiles/desktop`、包自身。

**引擎不可用时不静默回落**：选了小岚却听到慧慧，人会以为是 bug。面板直接回 503
并提示「可以把引擎切回本机 SAPI」。四条路都能用时，默认走 Kokoro。

**语速量程要对齐**：面板统一 −30..+30（百分比，喂给 Edge 的 `rate:'+N%'`、Kokoro 的 `speed`），
SAPI 的 `-Rate` 只有 −10..10，所以 SAPI 分支要把面板值 `Math.round(rate/3)` 再夹紧。

### 记忆为什么是「空的」

它不是 DSH 的跨会话记忆，而是**按会话 key** 存在 `state/social-v2.json` 里的四块：
`activeTopics`（进行中的话题）/ `pendingThoughts`（想说还没说的）/ `memberImpressions`（对群友的印象）
/ `memberActivity`（最近谁在说话）。
换一个会话就是另一份，「换成新会话就是新的空壳」是设计如此。
要跨会话记住，得靠 DSH 那边的记忆模块挂到跨会话存储上，桥接这边管不到。
面板也不提供「清空」按钮：记忆是 AI 自己的账本，它手上有 `memory-remove` / `memory-clear` 工具，
面板硬删会让人分不清「它忘了」和「我删了」。

**1.10.0 起，前三块之外多了第四块 `memberActivity`，由桥接自己维护。** 理由写在
`bridge.js` 的 `recordMemberActivityV2()` 上：旧体系里「记住」这件事完全交给模型自觉调
`qq_memory_append`，实测两个会话的三块长期是空的 —— 不写就等于没记忆。现在每条群消息入库时
（`appendSocialV2Message()` 末尾）都会顺带记一笔「谁、什么时候、最后说了什么」，
即使模型一次记忆都不写，它醒来也至少能认出「这群人是谁、上次是谁在说话」。
这块只记**别人**的话（`msg.isSelf` 直接跳过），只留最后一句（截 60 字），最多 100 人。

### 记忆为什么会「一觉醒来断一截」

旧实现里 `appendMemoryV2()` 有一句「话题超过 24 小时没被提起就删掉」。而 `lastMentionAt`
只有在新消息里**包含话题前 10 个字**或**包含参与者名字**时才刷新，所以「周末去骑行」这种
一句话说完就搁下的事，第二天醒来必然消失 —— 这就是截图里小鲸鱼抱怨的
「每醒一次记忆就断一截，之前聊到哪儿全靠几行备忘」。

1.10.0 改了三处，都在这一个函数和它的邻居里：

| 改动 | 旧 | 新 | 为什么 |
| --- | --- | --- | --- |
| 话题保留期 | 24 小时 | **14 天**（`MEMORY_TOPIC_TTL_MS`） | 一晚没聊到就删，正是「断一截」的来源 |
| 话题上限 | 20 条，超了砍最早的 | **40 条**，超了按 `lastMentionAt` 排升序砍**最久没提起的** | 旧的 `splice(0, n-20)` 会砍掉「排在前面但刚刚还被反复提起」的老话题 |
| 注入条数 | 话题/印象各取 `slice(-10)` | 各取 **20** 条（`MEMORY_PROMPT_TOPICS`/`MEMORY_PROMPT_IMPRESSIONS`） | 10 条装不下一个群的日常 |
| 印象排序 | 按对象键插入顺序 | 按 `lastSeenAt` **降序** | 新认识的人原来永远排在最后、进不了那 10 条 |
| 话题标注 | 只说「N 分钟前」 | 隔天标「（隔天了，可能已经聊过）」+ 参与者名单 | 让它知道「这条是隔夜的」，别当成刚才说的 |

另外唤醒提示词里多了一段【记忆习惯】（`memoryHintLine`），直接告诉它「上面那段不会自动更新，
这轮聊出新东西就调 `qq_memory_append` 记一条，没写的等于没发生过」。

### 表情缩略图为什么要过 `/sticker-file`

桥接给 AI 表情的 `url` 是**本机绝对路径**（`D:\qq-bridge\state\stickers\ai-xxx.svg`），
浏览器会把它当相对地址拼到 origin 后面，结果必然是裂图。桥接也不提供按文件名取图的接口。
所以面板 host 半加了一条只读通道 `GET /qq-panel/api/sticker-file?name=<文件名>`：
只认 `state/stickers` 下的纯文件名（`path.basename` 校验，`..` 绕不出去），
直接吐字节 + `cache-control: no-store`（管理员随时可能替换同名文件）。
`listStickers()` 会把本地路径改写成这条通道的地址。

### 本地目录自动入库

管理员把图片直接丢进 `state/stickers`，`POST /stickers/scan` 会比对「目录里有、库里没有」的文件，
逐个调桥接的 `POST /api/stickers/add` 收进库（只补新的，不覆盖已写好的备注）。
界面默认每 12 秒扫一次，可以关掉自动、改用手动「扫一次」。

> **`adopt` 默认是 `false`（只清点，不写库）。** 这个接口是写操作的入口，
> 「什么都不传」不该等价于「把目录里所有未登记文件都收进库」——那正是
> 上文「请求体读坏了，回 4xx 而不是当成没传」要防的同一类事。
> 界面每次都显式传 `adopt`，所以自动入库的行为没变；手写 curl 的人必须显式给 `adopt:true`。
**必须经桥接入库**，理由同上：插件直接写 `stickers.json` 会被下一次同步抹掉。

**表情入库为什么必须由桥接做**：`stickerEntries` 是桥接进程内存里的权威副本，
`syncStickerLibrary()` / `applyStickerNoteV2()` 每次都会把内存**整体覆盖写回** `stickers.json`。
插件侧直接改磁盘文件，下一次同步就被抹掉（这条真踩过：写完读回来还是空库）。
所以 `bridge.js` 新增了 `addLocalStickerV2()` + `POST /api/stickers/add`（只接受
`state/stickers` 下的纯文件名，拒绝路径与 http 来源），由桥接自己更新内存并落盘。

**它能做到和做不到的事要分开说**：入库的是**本地库**（AI 挑表情时读的就是它），所以放进去的表情
AI 能自己选着发；但 QQ 账号的「收藏表情」里还看不到它——QQ 收藏只能靠 `add_custom_face` 收，
而桥接唯一调用它的入口 `collect-sticker` 要的是「某个会话里某条消息的 messageRef」，
**没有「从本地文件上传到 QQ 收藏」这条路**。返回里的 `hint` 会把这句话说给用户听。

### 删表情：只删本地库，且顺手清死记录

`POST /qq-panel/api/stickers/remove`（body `{stickerId}`）→ 桥接 `removeStickerV2()`：
按 id 从 `stickerEntries` 里摘掉并落盘，**不动 QQ 账号的收藏**——删 QQ 收藏要调
`delete_custom_face`，不可撤销，误删比误删本地记录难挽回得多。

删完插件会紧接着调一次 `/stickers/prune`。这条清的是**另一类**东西：
图片文件已经不在了、但 `stickers.json` 里记录还留着（手动删文件、或 QQ 侧撤了收藏）。
不清理它们，界面就会画出「没有预览地址」的空格子——之前真出现过 5 条。
prune 只删「url 是本机绝对路径、且文件确实不存在」的条目，`http(s):` / `data:` 一律跳过
（网络抖一下不代表表情没了）。

**别把两个数字弄混**：`remove` 报的是「删掉了几张」，`prune` 报的是「顺带清掉几条死记录」。
早先插件把 `prune.removed` 当成 `remove.removed` 返回，界面上显示「删了 0 张」但其实删成功了。

---

## 许可证与声明

本插件随 [`qq-bridge`](../) 主仓库分发，使用 [PolyForm Noncommercial License 1.0.0](LICENSE)：
**允许个人与内部使用、修改、再分发源码，但不允许任何形式的商业使用**。
完整条款见 [LICENSE](LICENSE)，第三方声明见 [NOTICE.md](NOTICE.md)。

- **角色预设（persona）**：`dsh/agent-presets/qq-chat/` 与 `dsh/agent-presets/qq-chat-v2/` 里的人设文字是
  「小鲸鱼」的角色卡，属于本项目内容，随本仓库同许可分发。
- **工具面守卫**（`qq-tool-restrict.mjs` / `qq-self-key.mjs`）：本项目的原创代码。
- **运行时依赖**：仅 `@deepseek-ai/schemastery`（其许可由 npm 自动带入）。

> 上传 GitHub 前请自查：本目录已把真实 QQ 号（机器人小号 / 管理员号 / 群号）替换为占位符，
> 避免公开后招致骚扰或进群请求。

