// 会话绑定（SELF_KEY）的**唯一**编解码权威实现，由 qq-tool-restrict.mjs 使用
// （一份实现，避免两处漂移后出现「一个拦一个不拦」）。
//
// 包：qq-agent-presets（版本与主包同步，见 plugins/README.md「三、版本号约定」）
// 文档：plugins/qq-agent-presets/README.md「四、qq-self-key.mjs：会话绑定」
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
//
// DSH 的 MCP 桥（dsh-mcp-client 的 syncTools → tools/call）**只传 name + arguments**，
// 协议里没有任何「这次调用来自哪个会话」的字段。于是桥接的 MCP server 只能按
// **模型给的 key** 去解析会话令牌（src/mcp-snowluma-safe.js 的 resolveAgentTokenFor(key)）——
// 模型（或被注入的群友文本）只要把 key 换成别的群号，就能读到那个群的会话状态。
//
// 但 DSH 的**插件侧**是知道身份的：工具执行记录 exec 上挂着 exec.agent，
// 而 exec.agent.id 就是当前这次调用所属的 DSH 会话 id（见 @deepseek-ai/dsh-agent 的
// `Agent.id: SessionId` 与 dsh-tools 的 `ToolExecutionInput.agent?: Agent`）。
//
// 因此桥接在建会话时**预分配**一个把 QQ 会话 key 编码进去的 sessionId；插件侧把它
// 解回来就是可信的「我是谁」，再与模型给的 key 比对即可，完全不依赖模型自律。
//
// ⚠️ 安全前提：模型**无法**选择或影响 sessionId —— 它由桥接在 session/create 时传入
//    （dsh-host-apiproxy：`request.payload.sessionId ?? session-${randomUUID()}`），
//    模型既看不到也改不了。这正是本方案与「信任 arguments.key」的本质区别。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** sessionId 前缀：`qqb-<g|p>-<id>`（qq bridge bound）。 */
const BOUND_ID_RE = /^qqb-([gp])-(\d{1,20})(?:-[a-f0-9]{32})?$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fs = { readFileSync };

/**
 * 把 QQ 会话 key 编码成桥接预分配的 DSH sessionId。
 * @param {string} key - `group:群号` 或 `private:QQ号`。
 * @returns {string} 可安全用作单一路径段的 sessionId；key 不合法时返回 ''。
 */
export function encodeSelfKey(key) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(key ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  // 与桥接的 canonicalKey 同口径：必须是正的 safe integer，否则 `group:0001` 之类
  // 会编码成与 `group:1` 不同的字符串，绕开「同一个会话」的判定。
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `qqb-${m[1] === 'group' ? 'g' : 'p'}-${id}`;
}

/**
 * 从 sessionId 解回可信的 QQ 会话 key。
 * @param {string} sessionId - 任意 sessionId（含 DSH 自己生成的 `session-…`）。
 * @returns {string} `group:群号` / `private:QQ号`；不是桥接绑定的 id 时返回 ''。
 */
export function decodeSelfKey(sessionId) {
  const m = BOUND_ID_RE.exec(String(sessionId ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `${m[1] === 'g' ? 'group' : 'private'}:${id}`;
}

/**
 * 统一「会话不可用」文案。
 *
 * 所有「非当前会话」的拒绝都必须**不可区分**，否则攻击者能从文案差异里反推
 * 「这个群有没有会话状态」（群号枚举 oracle）。因此这里刻意不说明是「没绑定」
 * 还是「绑定了别的会话」。
 */
export const SESSION_UNAVAILABLE = '该会话不可用';

/**
 * 从一次工具执行记录里读出可信会话 key。
 *
 * 取 exec.agent.id（DSH 里 Agent.id 就是 SessionId），退回 exec.agent.session.id
 * 以兼容可能的结构变化。
 * @param {{agent?: {id?: string, session?: {id?: string}}}} exec - DSH 的工具执行记录。
 * @returns {string} 可信 key；无 agent / 未绑定 / id 不可解时返回 ''。
 */
export function trustedSelfKeyOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id;
  return decodeSelfKey(id);
}

/** 归一化 QQ 会话 key（与桥接 canonicalV2Key 同口径：去掉前导零、校验正整数）。 */
export function canonicalKeyOf(value) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(value ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `${m[1]}:${id}`;
}

// 只有这些工具无需 key —— 它们的 schema 里**根本没有** key 参数，绑不出身份也无从越权。
//
// 注意：qq_list_groups / qq_get_group_history 曾经在这里（旧的无令牌形态确实没有 key），
// 但两者已改成 v2 形态（schema 要求 `key: string`），必须重新纳入绑定校验：
// 留着豁免等于「声明了 key、少传一个就跳过守卫」，正是本模块最想堵的那种洞。
const QQ_TOOLS_WITHOUT_SESSION_KEY = new Set(['qq_status']);

// ── 管理员私聊的「只读统览」例外 ─────────────────────────────────────────────
// 管理员（ownerQQ）的私聊会话需要能读**任意群**的只读信息（群列表/群历史/群成员），
// 否则「你帮我看看群里刚说什么」这类请求在私聊里永远答不了。
//
// 放行只发生在三重条件同时成立时，缺一不可：
//   ① 当前 DSH 会话是 ownerQQ 的私聊会话（可信 sessionId 解出来的 self）；
//   ② 调用的是**只读**工具（发送类工具绝不在此列 —— 否则管理员会话能代发到任意群）；
//   ③ 目标 key 是 `group:正整数`。
// 桥接侧（src/bridge.js 的 isOwnerSessionToken + /api/socialV2/group-*）会再做一次
// 同样的判定，两道闸口径一致：插件层放「谁」，桥接层放「读」。
const QQ_OWNER_READABLE_GROUP_TOOLS = new Set([
  'qq_get_group_history',
  'qq_get_group_members'
]);

// `qq_list_groups` 单独一档：它读的是「机器人所在的全部群」，不是某个群的内容，
// key 只是拿来绑会话的。管理员私聊里填自己的 key 或某个群号都应该成立 ——
// 否则「先 `qq_list_groups` 看看有哪些群，再挑一个读历史」这条主链路第一步就断。
const QQ_OWNER_ANY_KEY_TOOLS = new Set(['qq_list_groups']);

/**
 * 从磁盘读桥接 config.json 里的 ownerQQ。
 *
 * 为什么必须兜底读文件：exec 上没有 config —— 实测 exec 只有 `name` / `arguments` /
 * `agent`（agent.id 是 sessionId），`exec.config`、`exec.ctx.config`、`exec.agent.config`
 * 三者都不存在，所以只靠 exec 取 ownerQQ 永远是空串，例外永不生效
 * （表现就是管理员私聊问「群里说了啥」永远回「该会话不可用」）。
 *
 * 插件与桥接在同一个仓库里（本文件在 <repo>/plugins/qq-agent-presets/），
 * 因此用 __dirname 往上两级定位；DSH 通过 junction 加载时 Node 默认解析到真实路径，
 * 仍然落在 <repo>。另外留 QQ_BRIDGE_HOME 环境变量与两个常见安装位置做兜底。
 * 读不到就返回 ''，例外自动关闭（失败关闭，不放宽）。
 */
function ownerQQFromFile() {
  const candidates = [];
  const fromEnv = String(process.env.QQ_BRIDGE_HOME ?? '').trim();
  if (fromEnv) candidates.push(fromEnv);
  try {
    candidates.push(path.resolve(__dirname, '..', '..'));
  } catch {
    /* import.meta.url 不可用时忽略 */
  }
  candidates.push('D:\\qq-bridge');
  for (const dir of candidates) {
    try {
      const text = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
      const cfg = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      const s = String(cfg?.ownerQQ ?? '').trim();
      if (/^\d{1,20}$/.test(s)) return s;
    } catch {
      /* 换下一个候选 */
    }
  }
  return '';
}

let cachedOwnerQQ = '';

/** ownerQQ：桥接配置里的管理员 QQ 号（读不到配置就当没开这个例外）。 */
function ownerQQFromExec(exec) {
  const candidates = [exec?.config?.ownerQQ, exec?.ctx?.config?.ownerQQ, exec?.agent?.config?.ownerQQ];
  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (/^\d{1,20}$/.test(s)) return s;
  }
  if (!cachedOwnerQQ) cachedOwnerQQ = ownerQQFromFile();
  return cachedOwnerQQ;
}

/**
 * 管理员私聊会话 + 只读群工具 + 目标 key ⇒ 放行。返回 true 表示命中例外。
 *
 * 两档：
 *   · `QQ_OWNER_READABLE_GROUP_TOOLS`（历史/成员）要求 key 是 `group:正整数`；
 *   · `QQ_OWNER_ANY_KEY_TOOLS`（群列表）读的是全局信息，key 只用来绑会话，
 *     填私聊自己或任意群都成立。
 * 共同前提：调用方确实是 ownerQQ 的私聊会话（由可信 sessionId 解出），且 ownerQQ 读得到。
 *
 * @param {string} name - 不带 mcp__snowluma__ 前缀的工具名。
 * @param {string} self - 可信会话 key（来自 sessionId）。
 * @param {string} canonical - 本次调用的目标 key。
 * @param {object} exec - DSH 工具执行记录。
 */
function ownerReadException(name, self, canonical, exec) {
  const groupOnly = QQ_OWNER_READABLE_GROUP_TOOLS.has(name);
  const anyKey = QQ_OWNER_ANY_KEY_TOOLS.has(name);
  if (!groupOnly && !anyKey) return false;
  if (groupOnly && !/^group:\d{1,20}$/.test(canonical)) return false;
  const owner = ownerQQFromExec(exec);
  if (!owner) return false;
  return self === `private:${owner}`;
}
const QQ_LEGACY_SEND_TARGETS = {
  qq_send_group_message: ['group', 'groupId'], qq_reply: ['group', 'groupId'],
  qq_send_private_message: ['private', 'userId'], qq_send_burst: ['group', 'groupId']
};
const QQ_TARGET_ALIAS_TOOLS = new Set(['qq_send_message', 'qq_get_message_detail']);

/**
 * 执行期会话绑定判定：这次工具调用是否指向**当前会话**。
 *
 * 按 QQ 工具声明判定是否必须携带 key，不能因为运行时 arguments 缺 key 就跳过。
 * qq_send_message / qq_get_message_detail 的 target 是 key 的显式别名，同样受限。
 * 返回空串表示放行；否则返回统一文案。
 *
 * **未绑定的会话一律拒绝**：如果这里放行，攻击者只要让调用落在一个解不出身份的会话里
 * （例如旧版本留下的 session-… 映射）就能恢复跨会话读取。升级时桥接会把这些旧映射
 * 一次性退役重建，所以正常部署不会走到「未绑定」这条分支。
 *
 * @param {object} exec - DSH 的工具执行记录（含 agent）。
 * @param {object} args - 本次调用的参数（含 key）。
 * @returns {string} 拒绝理由；空串表示放行。
 */
export function sessionBindingDenial(exec, args) {
  const name = /^mcp__snowluma__(.+)$/.exec(String(exec?.name ?? ''))?.[1] ?? '';
  const requiresKey = name !== '' && !QQ_TOOLS_WITHOUT_SESSION_KEY.has(name);
  const input = args && typeof args === 'object' ? args : {};
  const hasKey = Object.prototype.hasOwnProperty.call(input, 'key');
  const hasTarget = QQ_TARGET_ALIAS_TOOLS.has(name) && Object.prototype.hasOwnProperty.call(input, 'target');
  const legacyTarget = Object.prototype.hasOwnProperty.call(QQ_LEGACY_SEND_TARGETS, name) ? QQ_LEGACY_SEND_TARGETS[name] : null;
  if (legacyTarget) {
    const [kind, field] = legacyTarget;
    const canonical = canonicalKeyOf(`${kind}:${String(input[field] ?? '').trim()}`);
    const self = trustedSelfKeyOf(exec);
    if (!self || !canonical || canonical !== self) return SESSION_UNAVAILABLE;
    if (hasKey && canonicalKeyOf(input.key) !== canonical) return SESSION_UNAVAILABLE;
    if (Object.prototype.hasOwnProperty.call(input, 'target') && canonicalKeyOf(input.target) !== canonical) return SESSION_UNAVAILABLE;
    return '';
  }
  if (!hasKey && !hasTarget) return requiresKey ? SESSION_UNAVAILABLE : '';
  const self = trustedSelfKeyOf(exec);
  const canonical = canonicalKeyOf(hasKey ? input.key : input.target);
  if (hasKey && hasTarget && canonical !== canonicalKeyOf(input.target)) return SESSION_UNAVAILABLE;
  if (!self || !canonical) return SESSION_UNAVAILABLE;
  if (canonical !== self) {
    // 唯一的跨会话例外：管理员私聊会话只读群信息（见 ownerReadException 注释）。
    if (ownerReadException(name, self, canonical, exec)) return '';
    return SESSION_UNAVAILABLE;
  }
  return '';
}
