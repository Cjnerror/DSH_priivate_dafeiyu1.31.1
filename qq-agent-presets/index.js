// qq-agent-presets —— host 半（主进程侧）
//
// 这个文件只做两件事，界面一概不在这里：
//   1) 代理：DSH 页面（127.0.0.1:55336 之类的随机端口）要读写 QQ 桥接控制台（127.0.0.1:3100），
//      浏览器会先撞上两道墙 ——
//        · 令牌：控制台要求 `x-console-token`（或 ?token=），没带就是 401；
//        · Origin：非 GET 请求带 Origin 且 host 不是 3100 自己，直接 403「跨站请求被拒绝」。
//      所以令牌只能留在主进程里，由这里代跑一次本机 HTTP 请求。顺带把「后端没起来」
//      变成一条能读的 JSON，而不是浏览器的 net::ERR_CONNECTION_REFUSED。
//   2) 看护：定时探活 3100 / 3000，掉线时按 start-whale.ps1 把缺的那块拉起来。
//
// 立场的延续（和 dsh-roost 一样）：这是仪表盘，不是营销页。每个回调体自己 try/catch ——
// 一条路由注册失败不该拖死整个插件，而这个「包」里还装着两个 preset，拖死了连聊天角色都没了。
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'

export const name = 'qq-agent-presets'
export const inject = ['webServer']

/** 本包目录（index.js 所在目录）。preset 文件与 package.json 永远跟着它走，不靠猜桥接路径。 */
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

const API = '/qq-panel/api'
const DEFAULT_BRIDGE_HOME = 'D:\\qq-bridge'
const DEFAULT_RESTART_SCRIPT = 'D:\\DeepseekWorkSpace\\start-whale.ps1'
const ONE_BOT_PORT = 3000

// ── 桥接目录与凭证 ────────────────────────────────────────────────────────
function looksLikeBridge(dir) {
  try {
    return fs.existsSync(path.join(dir, 'src', 'bridge.js'))
  } catch {
    return false
  }
}

/** 找到 qq-bridge 仓库目录：环境变量 → 插件配置 → 默认值 → 常见相邻位置。 */
function resolveBridgeHome(config) {
  const candidates = []
  if (typeof process.env.QQ_BRIDGE_HOME === 'string' && process.env.QQ_BRIDGE_HOME.trim() !== '') {
    candidates.push(process.env.QQ_BRIDGE_HOME.trim())
  }
  if (config && typeof config.bridgeHome === 'string' && config.bridgeHome.trim() !== '') {
    candidates.push(config.bridgeHome.trim())
  }
  candidates.push(DEFAULT_BRIDGE_HOME)
  candidates.push(path.resolve(process.cwd(), '..', 'qq-bridge'))
  for (const dir of candidates) if (looksLikeBridge(dir)) return path.resolve(dir)
  return path.resolve(DEFAULT_BRIDGE_HOME)
}

function readConsoleToken(home) {
  try {
    const text = fs.readFileSync(path.join(home, 'state', 'console-token'), 'utf8').trim()
    return text === '' ? '' : text
  } catch {
    return ''
  }
}

function readJsonFile(file) {
  try {
    // config.json 曾被 PowerShell 以 UTF-8 BOM 写过（开头 EF BB BF），JSON.parse 会抛
    // `Unexpected token '\uFEFF'`。strip 掉 BOM 再解析，避免把「带 BOM 的正常文件」误判成读不到。
    let text = fs.readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 直接读 config.json（后端没起来时，界面仍要能显示模型、端口、管理员号）。 */
function readBridgeConfig(home) {
  const cfg = readJsonFile(path.join(home, 'config.json'))
  return cfg !== null && typeof cfg === 'object' ? cfg : null
}

function readModeFile(home) {
  const raw = readJsonFile(path.join(home, 'state', 'mode.json'))
  return typeof raw?.mode === 'string' ? raw.mode : null
}

// ── 本机 HTTP 小工具（不引依赖）────────────────────────────────────────────
function requestJson({ port, token, method = 'GET', pathname, body, timeoutMs = 4000, headers = {} }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const finalHeaders = { accept: 'application/json', ...headers }
    if (token !== '') finalHeaders['x-console-token'] = token
    if (payload !== null) {
      finalHeaders['content-type'] = 'application/json'
      finalHeaders['content-length'] = String(payload.length)
    }
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: finalHeaders, timeout: timeoutMs },
      (res) => {
        const chunks = []
        let received = 0
        res.on('data', (chunk) => {
          received += chunk.length
          // 桥接正常时最大响应只有几十 KB。设上限只为兜住异常情况（例如某个接口
          // 误返回了整份历史日志），不让一次请求把主进程内存拖垮。
          if (received > 32 * 1024 * 1024) {
            res.destroy()
            done({ ok: false, httpStatus: res.statusCode ?? 0, json: null, text: '', error: '响应过大' })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text === '' ? null : JSON.parse(text)
          } catch {
            json = null
          }
          done({ ok: res.statusCode >= 200 && res.statusCode < 300, httpStatus: res.statusCode ?? 0, json, text })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
      done({ ok: false, httpStatus: 0, json: null, text: '', error: '本机请求超时' })
    })
    req.on('error', (error) => done({ ok: false, httpStatus: 0, json: null, text: '', error: error?.code ?? String(error) }))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** TCP 探活：只问「这个端口在听吗」，不发字节。 */
function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', () => {
      socket.destroy()
      done(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * QQ 客户端装在哪儿 —— 「一键拉起」能不能真的把 QQ 也拉起来，取决于这个。
 *
 * 为什么要在面板里算这个：start-whale.ps1 现在自己会拉起 QQ（不然链条永远断在最外层），
 * 但脚本找不到 QQ.exe 时它也只能干瞪眼。面板先算出来，就能提前说清
 * 「点下去会发生什么」，而不是让人点完才发现没用。
 *
 * 顺序：config.qqExe → QQ_PANEL_QQ → 常见安装路径 → 注册表 Tencent\QQNT\Install。
 * 注册表用 reg.exe 查（约 20ms），不启 powershell，也不会被执行策略拦。
 */
const QQ_EXE_CANDIDATES = [
  'D:\\QQ\\QQ.exe',
  'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
  'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
  'C:\\Program Files\\Tencent\\QQ\\QQ.exe',
]

function resolveQQExe(config) {
  const configured = config && typeof config.qqExe === 'string' ? config.qqExe.trim() : ''
  if (configured !== '') return fs.existsSync(configured) ? configured : ''
  const envPath = typeof process.env.QQ_PANEL_QQ === 'string' ? process.env.QQ_PANEL_QQ.trim() : ''
  if (envPath !== '') return fs.existsSync(envPath) ? envPath : ''
  for (const file of QQ_EXE_CANDIDATES) if (fs.existsSync(file)) return file
  return ''
}

/** 走注册表兜底找 QQ（异步，只在候选路径都没命中时调一次）。 */
function resolveQQExeFromRegistry(timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT', '/v', 'Install'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve('')
          return
        }
        const hit = /Install\s+REG_SZ\s+(.+)/i.exec(String(stdout ?? ''))
        if (hit === null) {
          resolve('')
          return
        }
        const exe = path.join(hit[1].trim(), 'QQ.exe')
        resolve(fs.existsSync(exe) ? exe : '')
      },
    )
  })
}

/**
 * QQ 客户端是否在跑。
 *
 * 为什么单独查这个：SnowLuma 是「hook 进 QQ 进程」的，QQ 没登录它就 hook 不上，
 * OneBot 3000 也就永远不开。这时候面板如果只说「:3000 无响应」，人会以为是面板/桥接坏了——
 * 实际上整条链路是断在最外面的 QQ 上，点一百次「一键拉起」也不会有用。
 *
 * 用 tasklist.exe（实测 94ms），不用 Get-Process：不需要启 powershell，也不会被
 * -NoProfile / 执行策略之类的东西干扰。
 */
function probeQQClient(timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq QQ.exe'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          // 查不到就当「不知道」，不要谎报成「QQ 没开」。
          resolve({ known: false, running: null, error: error.code ?? String(error) })
          return
        }
        const text = String(stdout ?? '')
        resolve({ known: true, running: /QQ\.exe/i.test(text), error: null })
      },
    )
  })
}

// ── 电源：合盖保活 ────────────────────────────────────────────────────────
//
// 为什么插件要管这个：qq-bridge / SnowLuma / DSH 全是前台常驻进程，机器一睡它们就整段
// 冻住 —— 而笔记本最常见的「人走了」就是合上盖子。Windows 出厂默认合盖进睡眠，
// 于是 QQ 里那条消息要等到掀开盖子才有人看。用户看到的表症是「状态明明开着却不回」，
// 病根却在电源策略上，跟唤醒限频是两码事。
//
// 只碰三项，且只写 0（不采取任何操作）：
//   · SUB_BUTTONS LIDACTION        合盖动作
//   · SUB_SLEEP   STANDBYIDLE      空闲多久进睡眠
//   · SUB_SLEEP   HIBERNATEIDLE    空闲多久进休眠
// 不碰显示器超时（人可能只是想关屏），也不碰 S0/Modern Standby 的固件行为 ——
// 改那个要重启、且不同 BIOS 表现不一，风险远大于收益。
const POWER_SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347'
const POWER_SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20'
const POWER_LIDACTION = '5ca83367-6e45-459f-a27b-476b1d01c936'
const POWER_STANDBYIDLE = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da'
const POWER_HIBERNATEIDLE = '9d7815a6-7ee4-497e-8888-515a05f02364'
const POWER_SCHEME_ROOT = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes'

/**
 * 解 Windows 命令行工具的输出。
 *
 * powercfg / reg 的输出编码跟着父进程的控制台代码页走：中文系统上是 GBK(936)，
 * 但也见过直接吐 UTF-8 的。固定按任何一种解都会把另一种解成乱码。
 * 所以先按 UTF-8 严格解 —— 解不动（抛错）就说明是 GBK，退回 GBK 解。
 * 只影响展示用的方案名，解不出来也只是名字难看，不影响判断。
 */
function decodeConsole(buffer) {
  if (buffer.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      return buffer.toString('latin1')
    }
  }
}

/** 跑一个外部命令，拿回 {ok, stdout, code}；出错不抛，因为这些都是「诊断用」的调用。 */
function execCapture(file, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'buffer' }, (error, stdout) => {
      resolve({
        ok: error === null,
        code: error?.code ?? 0,
        stdout: decodeConsole(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8')),
      })
    })
  })
}

/** 当前活动电源方案的 GUID 与名字（powercfg /getactivescheme）。 */
async function activePowerScheme() {
  const res = await execCapture('powercfg.exe', ['/getactivescheme'])
  if (!res.ok) return { guid: '', name: '' }
  const text = res.stdout.trim()
  const guid = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(text)
  const name = /\(([^()]+)\)\s*$/.exec(text)
  return {
    guid: guid === null ? '' : guid[1].toLowerCase(),
    name: name === null ? '' : name[1].trim(),
  }
}

/** 读某个电源设置项下面的 AC/DC 两个 DWORD。读不到返回 null（区分「没设置」与「设成 0」）。 */
async function readPowerValue(keyPath, acName = 'ACSettingIndex', dcName = 'DCSettingIndex') {
  const readOne = async (name) => {
    const res = await execCapture('reg.exe', ['query', keyPath, '/v', name])
    if (!res.ok) return null
    const hit = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`, 'i').exec(res.stdout)
    return hit === null ? null : parseInt(hit[1], 16)
  }
  const [ac, dc] = await Promise.all([readOne(acName), readOne(dcName)])
  return { ac, dc }
}

/**
 * 读当前电源方案里的「合盖 / 空闲睡眠 / 空闲休眠」。
 * 6 次 reg 查询并行，实测 ~150ms。
 */
async function readPowerKeepAwake() {
  const scheme = await activePowerScheme()
  if (scheme.guid === '') {
    return { ok: false, message: '读不到当前电源方案（powercfg 没返回 GUID）', scheme, at: Date.now() }
  }
  const base = `${POWER_SCHEME_ROOT}\\${scheme.guid}`
  const [lid, standby, hibernate] = await Promise.all([
    readPowerValue(`${base}\\${POWER_SUB_BUTTONS}\\${POWER_LIDACTION}`),
    readPowerValue(`${base}\\${POWER_SUB_SLEEP}\\${POWER_STANDBYIDLE}`),
    readPowerValue(`${base}\\${POWER_SUB_SLEEP}\\${POWER_HIBERNATEIDLE}`),
  ])
  // 值语义：0=不采取任何操作，1=睡眠，2=休眠，3=关机。null=这一项在该方案里没写过（跟随默认）。
  // 只有 AC 与 DC 都明确等于 0 才算「已关掉」；null 不算，因为默认很可能就是睡眠。
  const zero = (pair) => pair !== undefined && pair.ac === 0 && pair.dc === 0
  const lidOff = zero(lid)
  const standbyOff = zero(standby)
  const hibernateOff = zero(hibernate)
  const acOnly = (lid.ac === 0 && standby.ac === 0 && (lid.dc !== 0 || standby.dc !== 0))
  return {
    ok: true,
    scheme,
    lid: { ...lid, off: lidOff },
    standbyIdle: { ...standby, off: standbyOff },
    hibernateIdle: { ...hibernate, off: hibernateOff },
    // 合盖不睡 + 空闲不睡 = 机器会一直醒着。休眠单独算：它只在空闲时可能触发，
    // 而空闲睡眠先关掉之后，休眠那条路也基本走不到，但仍要求一并关掉才报「完全」。
    keepAwake: lidOff && standbyOff && hibernateOff,
    acOnlyPartially: acOnly,
    at: Date.now(),
  }
}

/**
 * 把三项都写成 0（AC+DC），再 setactive 生效。
 *
 * 为什么逐条 set 而不是直接改注册表：powercfg 会顺带通知系统刷新缓存；直接写
 * Registry 要到下次切换方案才生效，人会觉得「点了没反应」。
 * 为什么不用 -ATTRIB_HIDE 之外的额外参数：这项默认是隐藏的，不取消隐藏的话用户
 * 在系统设置里根本找不到，会以为是插件写了个看不见的东西。
 */
async function applyPowerKeepAwake() {
  const scheme = await activePowerScheme()
  const target = scheme.guid === '' ? 'SCHEME_CURRENT' : scheme.guid
  const writes = [
    ['/setacvalueindex', target, 'SUB_BUTTONS', 'LIDACTION', '0'],
    ['/setdcvalueindex', target, 'SUB_BUTTONS', 'LIDACTION', '0'],
    ['/setacvalueindex', target, 'SUB_SLEEP', 'STANDBYIDLE', '0'],
    ['/setdcvalueindex', target, 'SUB_SLEEP', 'STANDBYIDLE', '0'],
    ['/setacvalueindex', target, 'SUB_SLEEP', 'HIBERNATEIDLE', '0'],
    ['/setdcvalueindex', target, 'SUB_SLEEP', 'HIBERNATEIDLE', '0'],
  ]
  const failed = []
  for (const args of writes) {
    const res = await execCapture('powercfg.exe', args)
    if (!res.ok) failed.push(args[1] + ' ' + args[3])
  }
  await execCapture('powercfg.exe', ['/setactive', 'SCHEME_CURRENT'])
  // 取消隐藏：让「合上盖子操作」在系统电源设置里可见，用户能自己复核。
  await execCapture('powercfg.exe', ['-attributes', 'SUB_BUTTONS', POWER_LIDACTION, '-ATTRIB_HIDE'])
  const after = await readPowerKeepAwake()
  if (failed.length > 0) {
    return {
      ...after,
      ok: false,
      message: `有 ${failed.length} 项没写成功（${failed.join('、')}）—— 多半需要管理员权限，用管理员身份重开 DSH 再试`,
    }
  }
  return {
    ...after,
    justApplied: true,
    message: after.keepAwake === true ? '已设成合盖与空闲都不睡' : '写完了但读回来还没生效，点刷新看看',
  }
}

/**
 * 反向：把「合盖不睡 + 空闲不睡」还原成「合盖就睡」。
 *
 * 为什么不做「恢复成写入前的原值」：这个功能上线时三项**已经是 0**（此前手工设过），
 * 那一刻的快照还原回来还是 0，等于没还原。所以这里直接落一套明确的默认姿势：
 * 合盖睡眠、空闲 30 分钟睡眠、空闲 60 分钟休眠 —— 都是 Windows 常见默认值，
 * 用户嫌不对再去系统电源设置里调。判据是「合盖动作回到 1（睡眠）」，其余两项只作陪衬。
 */
async function restorePowerDefault() {
  const scheme = await activePowerScheme()
  const target = scheme.guid === '' ? 'SCHEME_CURRENT' : scheme.guid
  // 值语义：合盖 1=睡眠；空闲睡眠/休眠的单位是**秒**（0=永不）。
  const writes = [
    ['/setacvalueindex', target, 'SUB_BUTTONS', 'LIDACTION', '1'],
    ['/setdcvalueindex', target, 'SUB_BUTTONS', 'LIDACTION', '1'],
    ['/setacvalueindex', target, 'SUB_SLEEP', 'STANDBYIDLE', '1800'],
    ['/setdcvalueindex', target, 'SUB_SLEEP', 'STANDBYIDLE', '900'],
    ['/setacvalueindex', target, 'SUB_SLEEP', 'HIBERNATEIDLE', '3600'],
    ['/setdcvalueindex', target, 'SUB_SLEEP', 'HIBERNATEIDLE', '1800'],
  ]
  const failed = []
  for (const args of writes) {
    const res = await execCapture('powercfg.exe', args)
    if (!res.ok) failed.push(args[1] + ' ' + args[3])
  }
  await execCapture('powercfg.exe', ['/setactive', 'SCHEME_CURRENT'])
  const after = await readPowerKeepAwake()
  if (failed.length > 0) {
    return {
      ...after,
      ok: false,
      message: `有 ${failed.length} 项没写成功（${failed.join('、')}）—— 多半需要管理员权限，用管理员身份重开 DSH 再试`,
    }
  }
  return {
    ...after,
    restored: true,
    message:
      after.lid?.ac === 1
        ? '已还原：合盖就睡，空闲 30 分钟睡眠、60 分钟休眠（可在系统电源设置里微调）'
        : '写完了但读回来合盖动作不是「睡眠」，可能被组策略或厂商电源软件覆盖了',
  }
}

// ── 时间（北京，无夏令时）────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000
const CN_OFFSET_MS = 8 * 60 * 60 * 1000
function todayStartMs(at = Date.now()) {
  return Math.floor((at + CN_OFFSET_MS) / DAY_MS) * DAY_MS - CN_OFFSET_MS
}
function fmtClock(at) {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const d = new Date(at + CN_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

// ── 免打扰时段 ───────────────────────────────────────────────────────────
//
// 权威实现在 bridge 的 `quietWindow()` / `quietActiveAt()`（src/bridge.js）。
// 这里只是面板侧的一份等价复刻：要在面板上显示「现在是不是在免打扰里」，
// 而 bridge 的 /api/status 不带这个字段，为它单独加一路请求不值当。
// 两边的判定必须一致：本地时间按北京时间，start > end 表示跨午夜，
// start === end 视为「没设」（否则会变成全天静默，谁都醒不来）。
const QUIET_DEFAULT_START = '23:00'
const QUIET_DEFAULT_END = '08:00'

function splitClock(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return null
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(raw)
  if (m === null) return null
  let hour
  let minute
  if (m[2] === undefined && raw.length >= 3) {
    // "2300" 这种紧凑写法
    hour = Number(raw.slice(0, raw.length - 2))
    minute = Number(raw.slice(raw.length - 2))
  } else {
    hour = Number(m[1])
    minute = m[2] === undefined ? 0 : Number(m[2])
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return [hour, minute]
}

function padClock(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function normalizeClock(value, fallback) {
  const parsed = splitClock(value) ?? splitClock(fallback) ?? splitClock(QUIET_DEFAULT_START)
  return padClock(parsed[0], parsed[1])
}

function normalizeQuiet(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: source.enabled === true,
    start: normalizeClock(source.start, QUIET_DEFAULT_START),
    end: normalizeClock(source.end, QUIET_DEFAULT_END),
    muteMessages: source.muteMessages === true,
  }
}

/** 现在分钟数（北京时间）。 */
function nowMinutesCN(at = Date.now()) {
  const d = new Date(at + CN_OFFSET_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function quietActiveAt(raw) {
  const quiet = normalizeQuiet(raw)
  if (!quiet.enabled) return null
  const start = splitClock(quiet.start)
  const end = splitClock(quiet.end)
  if (start === null || end === null) return null
  const startMin = start[0] * 60 + start[1]
  const endMin = end[0] * 60 + end[1]
  if (startMin === endMin) return null
  const now = nowMinutesCN()
  const hit = startMin > endMin
    ? now >= startMin || now < endMin
    : now >= startMin && now < endMin
  return hit ? quiet : null
}

function isQuietNow(raw) {
  return quietActiveAt(raw) !== null
}

// ── 看护 ─────────────────────────────────────────────────────────────────
function createWatchdog({ dshHome, log }) {
  const stateFile = path.join(dshHome, 'qq-panel-watchdog.json')
  const persisted = readJsonFile(stateFile) ?? {}
  const state = {
    enabled: persisted.enabled !== false,
    autoRestart: persisted.autoRestart !== false,
    probeMs: clampInt(persisted.probeMs, 5000, 300000, 15000),
    failThreshold: clampInt(persisted.failThreshold, 1, 20, 2),
    cooldownMs: clampInt(persisted.cooldownMs, 30000, 3600000, 180000),
    lastProbeAt: 0,
    lastOkAt: typeof persisted.lastOkAt === 'number' ? persisted.lastOkAt : 0,
    ok: null,
    failures: 0,
    restarts: clampInt(persisted.restarts, 0, 100000, 0),
    lastRestartAt: typeof persisted.lastRestartAt === 'number' ? persisted.lastRestartAt : 0,
    lastError: '',
    // 自上一次「健康」以来已经白拉了几次。用来做退避与熔断：
    // QQ 小号没登录时 OneBot 永远不开，不设上限的话看护会每 3 分钟把 SnowLuma 与
    // bridge 整套杀一遍 —— 那不是在修，那是在制造故障（2026-11-05 实测踩到：
    // restarts 一路涨到 6，而 3000 始终没开）。
    streakRestarts: clampInt(persisted.streakRestarts, 0, 1000, 0),
    // 连续白拉到这个次数就停手，等人来看。
    maxAttempts: clampInt(persisted.maxAttempts, 1, 20, 3),
    // 最近一次探活的细节，界面要能说清「断在哪一环」，而不是只给一个红点。
    // qqLaunchable：QQ 没开时，启动脚本到底能不能把它拉起来（找不到 QQ.exe 就别白跑一趟）。
    health: { bridgeAlive: null, oneBotAlive: null, qqKnown: false, qqRunning: null, qqLaunchable: null },
    // 重启跑的进度。running 为 true 时界面显示「正在拉起（已 37 秒）」，而不是干等。
    run: { running: false, startedAt: 0, finishedAt: 0, exitCode: null, trigger: '', timedOut: false },
    log: Array.isArray(persisted.log) ? persisted.log.slice(-40) : [],
  }
  let timer = null
  let child = null
  let stuckTimer = null
  // 「上次把 lastOkAt 写盘」的时刻，用来限频：默认探活 15 秒一次，每次都写盘没必要。
  let lastOkSavedAt = 0
  const OK_SAVE_INTERVAL_MS = 60 * 1000

  // 同步写（文件只有几百字节）。之前用 400ms 防抖，结果是「改完设置马上刷新页面看不到」——
  // 开关是给人看的，别让它慢半拍。
  const save = () => {
    try {
      fs.mkdirSync(dshHome, { recursive: true })
      fs.writeFileSync(
        stateFile,
        JSON.stringify(
          {
            enabled: state.enabled,
            autoRestart: state.autoRestart,
            probeMs: state.probeMs,
            failThreshold: state.failThreshold,
            cooldownMs: state.cooldownMs,
            restarts: state.restarts,
            streakRestarts: state.streakRestarts,
            maxAttempts: state.maxAttempts,
            lastRestartAt: state.lastRestartAt,
            // lastOkAt 必须落盘：冷却判断要用它区分「拉起之后从没好过」（继续冷却）
            // 与「好过又坏了」（新事故，立刻重来）。不持久化的话，热重载一次这个
            // 区分就没了，冷却会把新事故按老账算 —— 正是 2026-11-05 真机「白等 147 秒」的成因。
            lastOkAt: state.lastOkAt,
            log: state.log,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch (error) {
      log(`看护状态写盘失败：${error?.message ?? error}`)
    }
  }

  const pushLog = (text) => {
    state.log.push({ t: Date.now(), text })
    if (state.log.length > 60) state.log.splice(0, state.log.length - 60)
  }

  return {
    state,
    pushLog,
    save,
    /** 记下这次跑起来的子进程，供「是不是卡住了」与卸载时清理用。 */
    attachChild(handle, stuckMs) {
      child = handle
      if (stuckTimer !== null) clearTimeout(stuckTimer)
      if (stuckMs > 0) {
        stuckTimer = setTimeout(() => {
          if (state.run.running && child !== null) {
            state.run.timedOut = true
            pushLog(`启动脚本跑了 ${Math.round(stuckMs / 1000)} 秒还没结束，主动结束它`)
            log(`启动脚本超时（${stuckMs}ms），kill`)
            try {
              child.kill()
            } catch {
              /* 已经没了 */
            }
          }
        }, stuckMs)
        if (typeof stuckTimer.unref === 'function') stuckTimer.unref()
      }
    },
    clearChild() {
      child = null
      if (stuckTimer !== null) {
        clearTimeout(stuckTimer)
        stuckTimer = null
      }
    },
    setTimer(fn) {
      timer = fn
    },
    clearTimer() {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
    /**
     * 记一次探活结果；返回是否需要触发重启。
     *
     * ok 的判据是「整条链都通」：桥接在、OneBot 在。只判桥接会让
     * 「QQ 掉了 / SnowLuma 死了但 bridge 还活着」永远不触发重启 ——
     * 这正是上一版最要命的 bug。
     */
    record(health, detail) {
      state.lastProbeAt = Date.now()
      state.health = health
      const ok = health.bridgeAlive === true && health.oneBotAlive === true
      state.ok = ok
      if (ok) {
        state.lastOkAt = state.lastProbeAt
        state.failures = 0
        state.lastError = ''
        // 真的好了才清空「连续白拉」计数；只是短暂失败不清。
        let dirty = false
        if (state.streakRestarts !== 0) {
          state.streakRestarts = 0
          dirty = true
        }
        // lastOkAt 也要落盘，但不必每次探活都写（默认 15 秒一次太频繁）。
        // 它是冷却判断里「好过没有」的唯一证据：只留在内存里的话，
        // 热重载一次就归零，新事故又会被旧冷却挡住。
        if (state.lastProbeAt - lastOkSavedAt >= OK_SAVE_INTERVAL_MS) {
          lastOkSavedAt = state.lastProbeAt
          dirty = true
        }
        if (dirty) save()
        return { restart: false, blocked: '' }
      }
      state.failures += 1
      state.lastError = detail
      if (!state.enabled || !state.autoRestart) return { restart: false, blocked: '' }
      // 熔断：拉了 maxAttempts 次还没好，就停手等人看。
      // 这一段是 2026-11-05 真机踩出来的：QQ 开着但小号没登录时 OneBot 永远不开，
      // 看护会每 cooldown 一次把 SnowLuma + bridge 全部杀掉重起，restarts 一路涨到 6，
      // 而 3000 一次都没开过。自动重启的意义是「救一次意外」，不是「无限重启掩盖故障」。
      if (state.streakRestarts >= state.maxAttempts) {
        return {
          restart: false,
          blocked: `已经连续拉起 ${state.streakRestarts} 次都没好，暂停自动拉起 —— 问题多半不是「掉线」（常见：QQ 小号没登录、token 失效）。修好后点「一键拉起」或把自动重启关掉再打开，计数会重置。`,
        }
      }
      // QQ 没开的时候重启 SnowLuma 救不了任何东西：它 hook 不进一个不存在的进程。
      // 但 2026-11-05 补了一层：start-whale.ps1 现在自己会拉起 QQ，所以只要能找到
      // QQ.exe，这一轮就**值得**拉一次（拉完 QQ 起来，SnowLuma 才有得 hook）。
      // 找不到 QQ.exe 才真的没戏，把话说清楚。
      if (health.qqKnown === true && health.qqRunning === false) {
        if (health.qqLaunchable === false) {
          return { restart: false, blocked: 'QQ 客户端没在运行，而且找不到 QQ.exe —— SnowLuma hook 不上，重启也起不来。先手动打开 QQ 并登录小号。' }
        }
        if (state.failures < state.failThreshold) return { restart: false, blocked: '' }
        // 与下面那段同理：拉起之后如果好过（lastOkAt 更晚），那就是新事故，不该被旧冷却挡住。
        const since = state.lastOkAt > state.lastRestartAt ? 0 : state.lastRestartAt
        if (Date.now() - since < state.cooldownMs) {
          const left = Math.ceil((state.cooldownMs - (Date.now() - since)) / 1000)
          return { restart: false, blocked: `冷却中，还有 ${left} 秒才允许下一次拉起` }
        }
        return { restart: true, blocked: '' }
      }
      if (state.run.running) return { restart: false, blocked: '上一次拉起还没结束，等它跑完' }
      if (state.failures < state.failThreshold) return { restart: false, blocked: '' }
      // 冷却的起点是「上一次拉起」，但有个前提：那次拉起之后系统又坏掉了。
      //
      // 2026-11-05 真机踩到：手动「一键拉起」成功后 20 秒 bridge 意外死亡，
      // 看护因为「距 lastRestartAt 不足 cooldownMs」硬等了 147 秒才动手 ——
      // 中间系统明确 ok 过，那是新事故，不该算在旧冷却的账上。
      // 判据：lastOkAt 比 lastRestartAt 晚 ⇒ 拉起之后确实好过 ⇒ 重新开始计时。
      const recoveredSinceRestart = state.lastOkAt > state.lastRestartAt
      const cooldownFrom = recoveredSinceRestart ? 0 : state.lastRestartAt
      // 退避：第 N 次白拉之后，冷却时间按 2^(N-1) 放大（上限 8 倍）。
      // 冷却固定 3 分钟时，一次持续故障会以每分钟 ~0.3 次的频率反复重启服务，
      // 日志被刷满、QQ 反复掉线，比不动更糟。
      // streakRestarts 为 0 时没有「白拉」过，不该提退避（否则文案是「第 0 次之后退避 ×1」）。
      const factor = state.streakRestarts > 0 ? Math.min(8, Math.pow(2, state.streakRestarts - 1)) : 1
      const wait = state.cooldownMs * factor
      if (Date.now() - cooldownFrom < wait) {
        const left = Math.ceil((wait - (Date.now() - cooldownFrom)) / 1000)
        return {
          restart: false,
          blocked:
            state.streakRestarts > 0
              ? `冷却中，还有 ${left} 秒才允许下一次拉起（已连续白拉 ${state.streakRestarts} 次，退避 ×${factor}）`
              : `冷却中，还有 ${left} 秒才允许下一次拉起`,
        }
      }
      return { restart: true, blocked: '' }
    },
    noteRestart(text) {
      state.restarts += 1
      state.streakRestarts += 1
      state.lastRestartAt = Date.now()
      pushLog(text)
      save()
    },
    /** 用户手动点「一键拉起」：人工介入意味着「重新给一次机会」，把熔断计数清掉。 */
    resetStreak() {
      if (state.streakRestarts === 0) return
      state.streakRestarts = 0
      pushLog('手动拉起：重置自动拉起计数')
      save()
    },
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 把配置里可能是数组 / 逗号串 / 单值的号码列表统一成去重后的字符串数组。 */
function toStringList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/) : []
  const out = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

/** 找一个能跑的 PowerShell：优先 pwsh 7，其次系统自带的 5.1。 */
function resolvePowerShell(config) {
  const configured = config && typeof config.powershell === 'string' ? config.powershell.trim() : ''
  if (configured !== '') return configured
  if (typeof process.env.QQ_PANEL_PWSH === 'string' && process.env.QQ_PANEL_PWSH.trim() !== '') {
    return process.env.QQ_PANEL_PWSH.trim()
  }
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const file of candidates) if (fs.existsSync(file)) return file
  return 'powershell.exe'
}

// ── 插件主体 ──────────────────────────────────────────────────────────────
export function apply(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const bridgeHome = resolveBridgeHome(config)
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const logFile = path.join(bridgeHome, 'state', 'qq-panel.log')
  const log = (text) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    } catch {
      /* 日志写不进去不该影响功能 */
    }
  }

  log(`装载：bridgeHome=${bridgeHome} dshHome=${dshHome}`)

  const cfg = () => readBridgeConfig(bridgeHome)
  const consolePort = () => {
    const port = Number(cfg()?.consolePort)
    return Number.isFinite(port) && port > 0 ? port : 3100
  }
  const token = () => readConsoleToken(bridgeHome)
  const callBridge = (method, pathname, body, timeoutMs) =>
    requestJson({ port: consolePort(), token: token(), method, pathname, body, timeoutMs })

  /** 现在文件里的免打扰配置（没配过就返回默认形状，方便面板直接拿去合并）。 */
  const ensureConfigQuiet = () => normalizeQuiet(cfg()?.socialV2?.wake?.quietHours)

  /** 给人看的一句话状态。 */
  function quietMessage(quiet) {
    if (!quiet.enabled) return '已关闭：任何时间都会照常唤醒'
    const tail = quiet.muteMessages ? '，这段时间消息也不叫它' : '，但有人 @ 它或私聊还是会回'
    return `已设置：${quiet.start} ~ ${quiet.end} 不主动醒${tail}`
  }

  const watchdog = createWatchdog({ dshHome, log })

  // 电源现状的短缓存：overview 每次刷新都会用到它，但 reg 查询要跑 6 次子进程（~150ms）。
  // 缓存 20 秒足够——电源策略不会在两次刷新之间偷偷变。
  let powerCache = { at: 0, value: null }
  const POWER_CACHE_MS = 20000
  async function powerSnapshot(force = false) {
    if (!force && powerCache.value !== null && Date.now() - powerCache.at < POWER_CACHE_MS) {
      return powerCache.value
    }
    try {
      const fresh = await readPowerKeepAwake()
      powerCache = { at: Date.now(), value: fresh }
      return fresh
    } catch (error) {
      log(`读电源设置出错：${error?.message ?? error}`)
      const failed = { ok: false, message: `读电源设置出错：${error?.message ?? error}`, at: Date.now() }
      powerCache = { at: Date.now(), value: failed }
      return failed
    }
  }

  const restartScript = () => {
    const configured = config && typeof config.restartScript === 'string' ? config.restartScript.trim() : ''
    if (configured !== '') return configured
    if (typeof process.env.QQ_PANEL_RESTART === 'string' && process.env.QQ_PANEL_RESTART.trim() !== '') {
      return process.env.QQ_PANEL_RESTART.trim()
    }
    return DEFAULT_RESTART_SCRIPT
  }

  /**
   * 把 qq-bridge / SnowLuma 拉起来。
   *
   * 为什么不在这里直接 spawn node：
   *   start-whale.ps1 用 WMI（Win32_Process.Create）脱钩启动，进程挂在 WMI 下而不是当前作业树里；
   *   DSH 重启或被关掉时不会顺手把它们收走。脚本本身是幂等的（缺什么起什么），
   *   所以「自动重启」和「手动一键重启」可以是同一条命令。
   * 加 -NoDsh：绝不从插件里重启 DSH —— 那会把正在跑这个插件的自己杀掉。
   *
   * 为什么**不用** detached:true（2026-11-04 实测踩坑）：
   *   Windows 上 spawn 带 detached 时，子进程会被立刻放掉、一条命令都不执行
   *   （连 `exit 3` 都返回 exitCode 0，Out-File 根本没写）。改成普通子进程 +
   *   stdout/stderr 重定向到日志文件：DSH 本来就常驻，启动器活到脚本跑完就行；
   *   真正需要脱离 DSH 的那几个 node 服务由脚本自己用 WMI 拉起，不受影响。
   *
   * 耗时：脚本在「SnowLuma 要起 + bridge 要起」时实测 100 秒左右（SnowLuma 段等
   * OneBot 开门最久 40 秒，bridge 段等控制台最久 30 秒）。所以文案写「1~2 分钟」，
   * 并且 run 状态里带真实开始时间，界面能显示「已跑 37 秒」。
   */
  const SCRIPT_STUCK_MS = 5 * 60 * 1000

  function runRestart(reason) {
    if (watchdog.state.run.running) {
      const spent = Math.round((Date.now() - watchdog.state.run.startedAt) / 1000)
      return {
        ok: true,
        running: true,
        message: `上一次拉起还在跑（已 ${spent} 秒），等它结束`,
      }
    }
    const script = restartScript()
    if (!fs.existsSync(script)) {
      const message = `找不到启动脚本：${script}`
      log(`重启失败：${message}`)
      return { ok: false, message }
    }
    const exe = resolvePowerShell(config)
    const outFile = path.join(path.dirname(logFile), 'qq-panel-restart.log')
    try {
      let fd = 'ignore'
      try {
        fd = fs.openSync(outFile, 'a')
      } catch {
        /* 打不开日志就退回 ignore，不能因为日志路径不可写就不重启 */
      }
      const child = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoDsh'], {
        cwd: path.dirname(script),
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      })
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd)
        } catch {
          /* 句柄已交给子进程，关不掉也不影响 */
        }
      }
      const run = watchdog.state.run
      run.running = true
      run.startedAt = Date.now()
      run.finishedAt = 0
      run.exitCode = null
      run.trigger = reason
      run.timedOut = false
      watchdog.attachChild(child, SCRIPT_STUCK_MS)

      // error 与 exit 会**同时**触发（spawn 失败时两个都来），没有幂等保护就会把
      // run.running 置两次 false、推两条「启动脚本结束」、多存两次盘，而且第二次的
      // 耗时是按已经变过的 startedAt 重算的 —— 日志里的秒数是错的。
      let settleDone = false
      const settle = (code, prefix) => {
        if (settleDone) return
        settleDone = true
        const now = Date.now()
        const spent = Math.round((now - run.startedAt) / 1000)
        run.running = false
        run.finishedAt = now
        run.exitCode = code
        watchdog.clearChild()
        const tail = watchdog.state.run.timedOut ? '（超时被结束）' : ''
        watchdog.pushLog(`启动脚本结束${tail}（${prefix}，${spent} 秒）`)
        watchdog.save()
      }
      child.on('error', (error) => {
        log(`重启进程启动出错：${error?.message ?? error}`)
        settle(null, '启动出错')
      })
      child.on('exit', (code, signal) => {
        log(`启动脚本结束（exit=${code}${signal ? ` signal=${signal}` : ''}）`)
        settle(code, code === 0 ? 'exit=0' : `exit=${code}`)
      })
      watchdog.noteRestart(`触发重启（${reason}）：${path.basename(script)} -NoDsh`)
      log(`触发重启（${reason}）：${exe} -File ${script} -NoDsh（输出见 ${outFile}）`)
      return { ok: true, running: true, message: `正在拉起（${reason}），一般 1~2 分钟；进度会实时显示` }
    } catch (error) {
      const message = error?.message ?? String(error)
      log(`重启抛错：${message}`)
      return { ok: false, message }
    }
  }

  /**
   * 一次完整探活：桥接 / OneBot / QQ 客户端三处都看，然后交给看护判断。
   * 三段探活并行，界面刷新不会被串行的超时拖成好几秒。
   */
  async function probe() {
    const port = consolePort()
    const [bridgeAlive, oneBotAlive, qq] = await Promise.all([
      probePort(port),
      probePort(ONE_BOT_PORT),
      probeQQClient(),
    ])
    // QQ 没在跑时，先确认启动脚本能不能把它拉起来（找不到 QQ.exe 就别让看护白跑）。
    let qqLaunchable = null
    if (qq.running !== true) {
      const configured = resolveQQExe(config)
      qqLaunchable = configured !== '' || (await resolveQQExeFromRegistry()) !== ''
    }
    const health = { bridgeAlive, oneBotAlive, qqKnown: qq.known, qqRunning: qq.running, qqLaunchable }
    const detail = !bridgeAlive
      ? `桥接控制台 ${port} 无响应`
      : !oneBotAlive
        ? qq.running === false
          ? 'QQ 客户端没在运行（SnowLuma hook 不上，OneBot 3000 不会开）'
          : `OneBot ${ONE_BOT_PORT} 无响应（SnowLuma 没连上？）`
        : ''
    const verdict = watchdog.record(health, detail)
    if (verdict.blocked !== '' && verdict.restart === false && detail !== '') {
      // 只记一次判断结论，别每次探活都往日志里灌同一句话。
      const last = watchdog.state.log[watchdog.state.log.length - 1]
      if (last === undefined || last.text !== verdict.blocked) {
        watchdog.pushLog(verdict.blocked)
        // pushLog 只动内存，这里必须显式落盘：熔断/冷却这类「为什么没动手」的结论
        // 是热重载后最该留下的证据，丢了人会以为看护根本没在工作（2026-11-05 白盒抓到）。
        watchdog.save()
      }
    }
    if (verdict.restart) {
      runRestart(`看护发现掉线（连续 ${watchdog.state.failures} 次：${detail}）`)
    }
    return { ...health, detail }
  }

  // ── HTTP 路由 ──────────────────────────────────────────────────────────
  const disposers = []
  // 一个路径可能既要读又要写（/sessions）。webServer.register 是「一个 path 一条
  // handler」，同一个 path 注册两次会让后注册的把前面的顶掉 —— 真机上表现为 GET 突然回
  // 405「该接口只接受 POST」。所以按 path 归并：一个 path 只注册一次，内部再按 method 派发。
  const routeTable = new Map()
  const route = (method, suffix, handler) => {
    const routePath = `${API}${suffix}`
    let entry = routeTable.get(routePath)
    if (entry === undefined) {
      entry = { methods: new Map() }
      routeTable.set(routePath, entry)
      const dispose = webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          const slot = routeTable.get(routePath)
          const verb = (req.method ?? 'GET').toUpperCase()
          const fn = slot?.methods.get(verb)
          if (typeof fn !== 'function') {
            const allowed = slot === undefined ? 'POST' : [...slot.methods.keys()].join('/')
            sendJson(res, { ok: false, message: `该接口只接受 ${allowed}` }, 405)
            return
          }
          try {
            const body = verb === 'GET' ? undefined : await readJsonBody(req)
            const result = await fn(body)
            sendJson(res, result, result?.httpStatus ?? 200)
          } catch (error) {
            // 读坏的请求体是**客户端**的问题，回 4xx（带可读原因），不按 500 处理，
            // 更不能让形状不确定的 body 落到 handler 里被当成「没传字段」。
            if (error instanceof BodyError) {
              sendJson(res, { ok: false, message: error.message }, error.httpStatus)
              return
            }
            log(`路由 ${routePath} 出错：${error?.stack ?? error}`)
            sendJson(res, { ok: false, message: `面板接口出错：${error?.message ?? error}` }, 500)
          }
        },
      })
      disposers.push(dispose)
    }
    entry.methods.set(method, handler)
  }

  route('GET', '/overview', overview)
  route('GET', '/health', healthNow)
  route('POST', '/life', setLife)
  route('POST', '/watchdog', setWatchdog)
  route('POST', '/restart', restartNow)
  route('POST', '/mode', setMode)
  route('POST', '/wake', setWake)
  route('POST', '/quiet', setQuiet)
  route('POST', '/lock-model', setLockModel)
  // 表情库
  //
  // 带参数的接口一律用 POST：路由封装里 GET 不读 body，也没把 query 传进 handler，
  // 用 GET 会变成「界面传了 query、后端永远拿到空」这种静默错误。
  route('POST', '/stickers', listStickers)
  route('POST', '/stickers/note', setStickerNote)
  route('POST', '/stickers/sync', syncStickers)
  route('POST', '/stickers/scan', scanStickerDir)
  route('POST', '/stickers/prune', pruneStickers)
  route('POST', '/stickers/remove', removeSticker)
  // 语音库：列库、念一句、删、试发
  route('POST', '/voices', listVoices)
  route('POST', '/voices/tts', synthesizeVoice)
  route('POST', '/voices/delete', deleteVoice)
  route('POST', '/voices/send', sendVoiceNow)
  route('POST', '/voices/prefs', setVoicePrefs)
  // 语音与记忆的现状说明：只读，回答「为什么还不能发语音」「记忆为什么是空的」
  route('GET', '/capabilities', getCapabilities)
  // 合盖保活：笔记本合上盖子后机器还在睡，前面几个开关开得再对也没人回消息。
  route('GET', '/power', getPower)
  route('POST', '/power', setPower)
  // 会话管理
  route('GET', '/sessions', getSessions)
  route('POST', '/sessions', setSessions)
  // 角色（人格）管理
  route('GET', '/roles', getRoles)
  route('POST', '/roles/content', getRoleContent)
  route('POST', '/roles/save', saveRole)
  route('POST', '/roles/rename', renameRole)
  route('POST', '/roles/delete', deleteRole)
  route('POST', '/roles/activate', activateRole)
  // 眼睛
  route('POST', '/eyes', getEyes)
  route('POST', '/eyes/images', getMessageImages)

  // 表情原图通道：返回的是**图片字节**而不是 JSON，所以不能走上面的 route()（那里统一
  // sendJson）。桥接给 AI 表情的 url 是本机绝对路径，浏览器加载不了，必须由这里转发。
  {
    const filePath = `${API}/sticker-file`
    const dispose = webServer.register({
      kind: 'exact',
      path: filePath,
      handler: async (req, res) => {
        try {
          if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
            sendJson(res, { ok: false, message: '该接口只接受 GET' }, 405)
            return
          }
          const url = new URL(req.url ?? filePath, 'http://127.0.0.1')
          sendStickerFile(req, res, url)
        } catch (error) {
          log(`原图通道出错：${error?.stack ?? error}`)
          sendJson(res, { ok: false, message: `取图失败：${error?.message ?? error}` }, 500)
        }
      },
    })
    disposers.push(dispose)
  }

  // 语音字节通道：与 /sticker-file 同构，同样不能走 route()（它吐的是音频字节）。
  {
    const filePath = `${API}/voice-file`
    const dispose = webServer.register({
      kind: 'exact',
      path: filePath,
      handler: async (req, res) => {
        try {
          if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
            sendJson(res, { ok: false, message: '该接口只接受 GET' }, 405)
            return
          }
          const url = new URL(req.url ?? filePath, 'http://127.0.0.1')
          sendVoiceFile(req, res, url)
        } catch (error) {
          log(`语音通道出错：${error?.stack ?? error}`)
          sendJson(res, { ok: false, message: `取音频失败：${error?.message ?? error}` }, 500)
        }
      },
    })
    disposers.push(dispose)
  }

  // ── 各接口实现 ─────────────────────────────────────────────────────────
  async function overview() {
    const port = consolePort()
    const conf = cfg()
    const statusRes = await callBridge('GET', '/api/status', undefined, 3000)
    const pausedRes = statusRes.ok ? null : await callBridge('GET', '/api/socialV2/activity', undefined, 2500)

    const status = statusRes.json ?? null
    const paused = typeof status?.socialV2Paused === 'boolean'
      ? status.socialV2Paused
      : typeof pausedRes?.json?.paused === 'boolean'
        ? pausedRes.json.paused
        : null

    // 这三路互不依赖，必须并行。串行时最坏情况是 3000+5000+5000=13 秒；
    // 桥接「接了连接但不回话」时每个都会等满超时，而面板每 10 秒刷一次，
    // 请求会一层层叠起来（每个请求都在等，谁也没超时）。
    const [modelRes, seriesRes, summaryRes] = statusRes.ok
      ? await Promise.all([
          callBridge('GET', '/api/dsh/model', undefined, 3000),
          callBridge('GET', '/api/tokens/series?hours=24&maxBuckets=48', undefined, 5000),
          callBridge('GET', '/api/tokens/summary?limit=1', undefined, 5000),
        ])
      : [null, null, null]

    const [oneBotAlive, qq] = await Promise.all([probePort(ONE_BOT_PORT), probeQQClient()])
    const bridgeAlive = statusRes.ok || (await probePort(port))
    // 电源状态与桥接状态无关：桥接死了也得能告诉人「你现在合盖会睡」。
    const power = await powerSnapshot()

    // QQ 装在哪 —— 只在「QQ 没在跑」时才算（在跑就不用拉），候选路径没命中才查注册表。
    let qqExe = ''
    if (qq.running !== true) {
      qqExe = resolveQQExe(config)
      if (qqExe === '') qqExe = await resolveQQExeFromRegistry()
    }

    // 今日花费：把 24 小时分桶里落在「今天（北京）」的那几段加起来。
    const dayStart = todayStartMs()
    const buckets = Array.isArray(seriesRes?.json?.buckets) ? seriesRes.json.buckets : []
    let todayCost = 0
    let todayTokens = 0
    let todayTurns = 0
    const timeline = []
    for (const row of buckets) {
      const t = Number(row?.t)
      const cost = Number(row?.cost) || 0
      timeline.push({ t: Number.isFinite(t) ? t : 0, cost, tier: row?.tier ?? null })
      if (!Number.isFinite(t) || t < dayStart) continue
      todayCost += cost
      todayTokens += Number(row?.tokens) || 0
      todayTurns += Number(row?.turns) || 0
    }
    const totals = summaryRes?.json?.totals ?? null
    const model = modelRes?.json?.model !== undefined || modelRes?.json?.provider !== undefined
      ? {
          provider: modelRes.json.provider ?? null,
          model: modelRes.json.model ?? null,
          reasoningEffort: modelRes.json.reasoningEffort ?? null,
          label: modelRes.json.labels?.[modelRes.json.model] ?? null,
          source: 'bridge',
          lockDefaultModel: modelRes.json.lockDefaultModel === true,
        }
      : {
          provider: conf?.dsh?.provider ?? null,
          model: conf?.dsh?.model ?? null,
          reasoningEffort: conf?.dsh?.reasoningEffort ?? null,
          label: null,
          source: 'config.json',
          lockDefaultModel: conf?.dsh?.lockDefaultModel === true,
        }

    return {
      ok: true,
      at: Date.now(),
      clock: fmtClock(Date.now()),
      bridge: {
        reachable: bridgeAlive,
        consolePort: port,
        bridgeHome,
        httpStatus: statusRes.httpStatus,
        message: statusRes.ok ? '' : describeBridgeFailure(statusRes),
      },
      oneBot: { reachable: oneBotAlive, port: ONE_BOT_PORT },
      qq: { known: qq.known, running: qq.running, error: qq.error, exe: qqExe },
      life: {
        // 生命开关的开态 = 「没有暂停」。拿不到状态（后端全哑）时返回 null，界面显示「未知」而不是瞎猜。
        on: paused === null ? null : !paused,
        paused,
        mode: status?.mode ?? readModeFile(bridgeHome),
        role: status?.role ?? null,
        dshReady: status?.dshReady ?? null,
        snowluma: status?.snowluma ?? null,
        ownerQQ: status?.ownerQQ ?? conf?.ownerQQ ?? null,
        allowGroups: Array.isArray(status?.allowGroups) ? status.allowGroups : (conf?.allow?.groups ?? []),
        allowPrivate: Array.isArray(status?.allowPrivate) ? status.allowPrivate : (conf?.allow?.private ?? []),
        // 唤醒模式：只在收到消息时激活（true）还是也定时自动醒（false）。直接读 config.json ——
        // bridge 的 /api/socialV2/config 会把 onlyOnMessage 写回文件，所以这里读文件即读到运行值。
        onlyOnMessage: conf?.socialV2?.wake?.onlyOnMessage === true,
        // 免打扰时段：这段时间内不主动醒（定时唤醒全压住；muteMessages 才连消息类一起压）。
        quietHours: normalizeQuiet(conf?.socialV2?.wake?.quietHours),
        // 此刻是否正处在免打扰时段里 —— 面板要能直接告诉人「现在为什么它不吭声」。
        quietNow: isQuietNow(conf?.socialV2?.wake?.quietHours),
      },
      model,
      spend: {
        currency: seriesRes?.json?.currency ?? summaryRes?.json?.currency ?? 'CNY',
        symbol: seriesRes?.json?.symbol ?? summaryRes?.json?.symbol ?? '¥',
        available: seriesRes?.ok === true,
        // 账本读不到时给 null 而不是 0：0 会被渲染成「¥0」，与
        // 「今天真的一分没花」无法区分（README §六「0 和不知道是两回事」）。
        today: seriesRes?.ok === true ? { cost: todayCost, tokens: todayTokens, turns: todayTurns } : null,
        nowTier: seriesRes?.json?.buckets?.length ? seriesRes.json.buckets[seriesRes.json.buckets.length - 1]?.tier ?? null : null,
        lifetime: totals
          ? { cost: Number(totals.cost) || 0, tokens: Number(totals.totalTokens) || 0, turns: Number(totals.turns) || 0, cacheHitRate: Number(totals.cacheHitRate) || 0 }
          : null,
        timeline,
        generatedAt: seriesRes?.json?.generatedAt ?? null,
      },
      watchdog: {
        enabled: watchdog.state.enabled,
        autoRestart: watchdog.state.autoRestart,
        probeMs: watchdog.state.probeMs,
        failThreshold: watchdog.state.failThreshold,
        cooldownMs: watchdog.state.cooldownMs,
        ok: watchdog.state.ok,
        failures: watchdog.state.failures,
        restarts: watchdog.state.restarts,
        // 连续白拉次数与上限：界面拿它显示「已连续拉起 2/3 次，再失败就暂停」。
        streakRestarts: watchdog.state.streakRestarts,
        maxAttempts: watchdog.state.maxAttempts,
        lastProbeAt: watchdog.state.lastProbeAt,
        lastOkAt: watchdog.state.lastOkAt,
        lastRestartAt: watchdog.state.lastRestartAt,
        lastError: watchdog.state.lastError,
        health: watchdog.state.health,
        run: {
          running: watchdog.state.run.running,
          startedAt: watchdog.state.run.startedAt,
          finishedAt: watchdog.state.run.finishedAt,
          exitCode: watchdog.state.run.exitCode,
          trigger: watchdog.state.run.trigger,
          timedOut: watchdog.state.run.timedOut,
          // 已经跑了多少秒 —— 界面拿它显示「正在拉起（已 37 秒）」，不用自己推算。
          elapsedSec: watchdog.state.run.running
            ? Math.round((Date.now() - watchdog.state.run.startedAt) / 1000)
            : watchdog.state.run.startedAt > 0
              ? Math.round((watchdog.state.run.finishedAt - watchdog.state.run.startedAt) / 1000)
              : 0,
        },
        // 上一次探活「为什么不算通」的核心原因，界面直接用它写红点文案。
        reason: watchdog.state.ok === true
          ? ''
          : bridgeAlive === false
            ? 'bridge'
            : oneBotAlive === false
              ? qq.running === false
                ? 'qq'
                : 'onebot'
              : '',
        restartScript: restartScript(),
        log: watchdog.state.log.slice(-12),
      },
      // 合盖保活。keepAwake 为 true 才是「合上盖子机器也不睡」；
      // power.ok 为 false（读不到/非 Windows）时界面显示「读不到」，不要谎报成「已关」。
      power: {
        ok: power.ok !== false,
        keepAwake: power.keepAwake === true,
        acOnlyPartially: power.acOnlyPartially === true,
        scheme: power.scheme ?? { guid: '', name: '' },
        lid: power.lid ?? null,
        standbyIdle: power.standbyIdle ?? null,
        hibernateIdle: power.hibernateIdle ?? null,
        message: power.message ?? '',
      },
    }
  }

  function describeBridgeFailure(result) {
    if (result?.error === 'ECONNREFUSED') return '桥接没在运行（端口没人监听），点「一键拉起」'
    if (result?.error === 'timeout') return '桥接连上了但没回话（可能卡住了）'
    if (result?.httpStatus === 401) return '控制台令牌对不上：核对 state/console-token'
    if (result?.httpStatus === 403) return '被桥接挡了（Host / Origin 校验），看 state/bridge.log'
    if (result?.error) return `连不上：${result.error}`
    return `桥接返回 HTTP ${result?.httpStatus ?? '?'}`
  }

  /**
   * 桥接失败 → 面板状态码。
   *
   * 关键：**4xx 是桥接在说「你这次请求有问题」，必须原样透传**；502 的语义是
   * 「这个服务自己连不上后端」。早先一律回 502，结果删一个不存在的角色、填错一个
   * 名字，界面收到的都是「网关错误」，既不能定位也不能提示用户改哪。
   * 只有连不上（error）或桥接自己 5xx 才归 502 / 504。
   */
  function bridgeFailure(result, prefix = '桥接拒绝') {
    // 桥接的错误字段不统一：有的用 message，有的用 error（`{"ok":false,"error":"人格「X」不存在"}`）。
    // 两个都看，实在没有才退回按状态码猜 —— 用户要的是「为什么失败」，不是「HTTP 404」。
    const raw = result?.json?.message ?? result?.json?.error
    const text = raw === undefined || raw === null || String(raw).trim() === '' ? describeBridgeFailure(result) : String(raw)
    const up = Number(result?.httpStatus) || 0
    const httpStatus = up >= 400 && up < 500 ? up : result?.error === 'timeout' ? 504 : 502
    return { ok: false, httpStatus, message: `${prefix}：${text}`, detail: result?.json ?? null }
  }

  async function setLife(body) {
    // on 缺失/非布尔时拒绝，而不是当「关」处理 —— 空 body 误关开关是 fail-open 到
    // 「断开 QQ」的危险方向（黑盒测试 2026-11-06 抓到）。
    if (typeof body?.on !== 'boolean') {
      return { ok: false, httpStatus: 400, message: 'on 必须是布尔值（true 恢复 / false 断开）' }
    }
    const on = body.on === true
    const result = await callBridge('POST', '/api/socialV2/activity', { paused: !on }, 6000)
    if (!result.ok) {
      return bridgeFailure(result)
    }
    watchdog.pushLog(on ? '生命开关：打开（恢复 QQ 全部功能）' : '生命开关：关闭（断开 QQ 全部功能）')
    watchdog.save()
    log(`生命开关 → ${on ? '开' : '关'}`)
    return { ok: true, on, paused: result.json?.paused ?? !on, message: on ? '已恢复' : '已断开' }
  }

  async function setWatchdog(body) {
    const has = (k) => body !== null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, k)
    const BOOL_KEYS = ['enabled', 'autoRestart']
    const NUM_KEYS = { probeMs: [5000, 300000], failThreshold: [1, 20], cooldownMs: [30000, 3600000], maxAttempts: [1, 20] }
    // 空 body / 全是不认识的键要 400：否则一次空请求就会把看护状态重写一遍、
    // 把探活循环整个重建（旧 loopTimer 被清、1200ms 首探重新排），而且回 ok:true —
    // 与 /life、/wake、/power、/lock-model、/quiet 的「空 body 一律 400」也不一致。
    if (![...BOOL_KEYS, ...Object.keys(NUM_KEYS)].some(has)) {
      return {
        ok: false,
        httpStatus: 400,
        message: `至少要传一个看护参数（${[...BOOL_KEYS, ...Object.keys(NUM_KEYS)].join(' / ')}）`,
      }
    }
    for (const k of BOOL_KEYS) {
      if (!has(k)) continue
      if (typeof body[k] !== 'boolean') return { ok: false, httpStatus: 400, message: `${k} 必须是布尔值` }
      watchdog.state[k] = body[k]
    }
    for (const [k, range] of Object.entries(NUM_KEYS)) {
      if (!has(k)) continue
      const n = Number(body[k])
      if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
        return { ok: false, httpStatus: 400, message: `${k} 必须是 ${range[0]}~${range[1]} 之间的数字` }
      }
      watchdog.state[k] = Math.round(n)
    }
    // 关掉看护时把失败计数清零：再打开时应该从干净状态开始数，而不是带着上次的旧账。
    // 自动重启被人为重新打开时，也把「连续白拉」计数清掉 —— 用户是在说「再试一次」。
    if (body?.enabled === false) watchdog.state.failures = 0
    if (body?.autoRestart === true && watchdog.state.streakRestarts > 0) {
      watchdog.pushLog('重新打开自动重启：重置连续拉起计数')
      watchdog.state.streakRestarts = 0
    }
    watchdog.save()
    restartLoop()
    return {
      ok: true,
      enabled: watchdog.state.enabled,
      autoRestart: watchdog.state.autoRestart,
      probeMs: watchdog.state.probeMs,
      failThreshold: watchdog.state.failThreshold,
      cooldownMs: watchdog.state.cooldownMs,
      maxAttempts: watchdog.state.maxAttempts,
      streakRestarts: watchdog.state.streakRestarts,
    }
  }

  async function restartNow() {
    // 上一次还在跑：直接回话，**不清熔断计数** —— 这次点击什么都没发生，
    // 清了计数会让「连续白拉 N 次」的账凭空消失（白盒测试 2026-11-05 抓到）。
    if (watchdog.state.run.running) {
      const spent = Math.round((Date.now() - watchdog.state.run.startedAt) / 1000)
      return { ok: true, running: true, message: `上一次拉起还在跑（已 ${spent} 秒），等它结束`, httpStatus: 200 }
    }
    // 手动拉起 = 人工介入，把熔断计数清掉再拉（否则熔断后按钮会变成「点了也没用」）。
    watchdog.resetStreak()
    const result = await runRestart('手动一键拉起')
    return { ...result, httpStatus: result.ok ? 200 : 500 }
  }

  /** 探一下当前状态但不落盘：面板的「刷新」与看护共用同一套判据。 */
  async function healthNow() {
    const snapshot = await probe()
    return { ok: true, ...snapshot, at: Date.now(), clock: fmtClock(Date.now()) }
  }

  /** 合盖保活的现状：只读，不改任何东西（面板一打开就调）。 */
  async function getPower() {
    const state = await powerSnapshot(true)
    return { ok: state.ok !== false, ...state, clock: fmtClock(Date.now()) }
  }

  /**
   * 合盖保活的开关：`{on: true}` 设成合盖不睡，`{on: false}` 还原成合盖就睡。
   *
   * 为什么必须能关：这是个会改系统电源方案的写操作，不能只进不出 ——
   * 用户临时想让机器合盖就睡（省电、放包里），没有反向按钮就只能去系统设置里翻。
   * 空 body 仍然一律 400（2026-11-05 白盒：`/life` 与 `/roles/activate` 就栽在空 body 上）。
   */
  async function setPower(body) {
    if (body?.on !== true && body?.on !== false) {
      return { ok: false, httpStatus: 400, message: '请传 on: true（合盖不睡）或 on: false（还原成合盖就睡）' }
    }
    try {
      const result = body.on === true ? await applyPowerKeepAwake() : await restorePowerDefault()
      // 写完立刻刷缓存，否则用户点完刷新还会看到 20 秒前的旧值。
      powerCache = { at: Date.now(), value: result }
      log(
        body.on === true
          ? `合盖保活：${result.keepAwake === true ? '已生效' : '已尝试写入，读回未完全生效'}`
          : `合盖保活：已还原成合盖就睡${result.lid?.ac === 1 && result.lid?.dc === 1 ? '' : '（读回值不是 1，可能被组策略覆盖）'}`,
      )
      return { ok: body.on === true ? result.keepAwake === true : result.keepAwake !== true, ...result, clock: fmtClock(Date.now()) }
    } catch (error) {
      log(`写电源设置出错：${error?.stack ?? error}`)
      // 必须带 httpStatus：不带的话 sendJson 按 200 回，任何按状态码判断的调用方
      // 都会把「powercfg 全失败」当成成功（README §六「写操作不能假装成功」）。
      return { ok: false, httpStatus: 500, message: `写电源设置出错：${error?.message ?? error}` }
    }
  }

  async function setMode(body) {
    const mode = typeof body?.mode === 'string' ? body.mode.trim() : ''
    // 空 body / 拼错的名字在这里就挡掉。桥接收到空 mode 会当成「清除」写进
    // state/mode.json，而面板其他写接口对空 body 都是 400 —— 只有这里放过去，
    // 出问题时人会去查桥接，其实错在面板没拦。
    const MODE_IDS = ['chat', 'closed-agent', 'reserved', 'reserved2', 'simulation']
    if (!MODE_IDS.includes(mode)) {
      return { ok: false, httpStatus: 400, message: `mode 必须是 ${MODE_IDS.join(' / ')} 之一` }
    }
    const result = await callBridge('POST', '/api/mode', { mode }, 6000)
    if (!result.ok) {
      return bridgeFailure(result)
    }
    return { ok: true, mode: result.json?.mode ?? mode, dshSynced: result.json?.dshSynced !== false }
  }

  /** 唤醒调整：只回消息（关掉定时自动唤醒），或恢复默认（重新挂上定时唤醒）。 */
  async function setWake(body) {
    // 只有 on 显式传 true/false 才动，防空 body 误改（与 /life 同一教训）。
    if (typeof body?.on !== 'boolean') {
      return { ok: false, httpStatus: 400, message: 'on 必须是布尔值（true 只回消息 / false 恢复定时唤醒）' }
    }
    const onlyOnMessage = body.on === true
    const result = await callBridge('POST', '/api/socialV2/config', { wake: { onlyOnMessage } }, 6000)
    if (!result.ok) {
      return bridgeFailure(result)
    }
    const applied = result.json?.config?.wake?.onlyOnMessage === true
    log(`唤醒调整 → ${applied ? '只回消息' : '恢复定时唤醒'}`)
    return {
      ok: true,
      onlyOnMessage: applied,
      message: applied ? '已切换：只在收到消息时激活，定时自动唤醒已停' : '已恢复：定时自动唤醒（回复复查 / 主动开话题 / 潜水到期）重新挂上',
    }
  }

  /**
   * 免打扰时段。可以只改一部分字段（比如只拨时间不动开关），没传的沿用现有值。
   * 校验在 bridge 侧也做了一遍（`normalizeClock`），这里先挡一道是为了给出人话错误。
   */
  async function setQuiet(body) {
    const has = (k) => body !== null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, k)
    if (!has('enabled') && !has('start') && !has('end') && !has('muteMessages')) {
      return { ok: false, httpStatus: 400, message: '至少要传 enabled / start / end / muteMessages 其中一个' }
    }
    const current = ensureConfigQuiet()
    const patch = {}
    if (has('enabled')) {
      if (typeof body.enabled !== 'boolean') {
        return { ok: false, httpStatus: 400, message: 'enabled 必须是布尔值' }
      }
      patch.enabled = body.enabled
    }
    if (has('muteMessages')) {
      if (typeof body.muteMessages !== 'boolean') {
        return { ok: false, httpStatus: 400, message: 'muteMessages 必须是布尔值' }
      }
      patch.muteMessages = body.muteMessages
    }
    for (const field of ['start', 'end']) {
      if (!has(field)) continue
      const parsed = splitClock(body[field])
      if (parsed === null) {
        return { ok: false, httpStatus: 400, message: `${field} 要写成 HH:MM（例：23:00）` }
      }
      patch[field] = padClock(parsed[0], parsed[1])
    }
    const next = { ...current, ...patch }
    if (next.enabled && next.start === next.end) {
      return { ok: false, httpStatus: 400, message: '起止时间不能一样 —— 那等于全天静默，谁也叫不醒它' }
    }
    const result = await callBridge('POST', '/api/socialV2/config', { wake: { quietHours: next } }, 8000)
    if (!result.ok) {
      return bridgeFailure(result)
    }
    const applied = normalizeQuiet(result.json?.config?.wake?.quietHours)
    log(`免打扰时段 → ${applied.enabled ? `${applied.start}~${applied.end}` : '关闭'}${applied.muteMessages ? '（消息也不醒）' : ''}`)
    return {
      ok: true,
      quietHours: applied,
      quietNow: isQuietNow(applied),
      message: quietMessage(applied),
    }
  }

  /** 锁定默认模型：把 DSH 全局默认模型周期同步成 config.json 的 provider/model。 */
  async function setLockModel(body) {
    if (typeof body?.on !== 'boolean') {
      return { ok: false, httpStatus: 400, message: 'on 必须是布尔值（true 锁定 / false 解锁）' }
    }
    const lockDefaultModel = body.on === true
    const result = await callBridge('POST', '/api/dsh/lock-default-model', { lockDefaultModel }, 6000)
    if (!result.ok) {
      return bridgeFailure(result)
    }
    log(`锁定默认模型 → ${lockDefaultModel ? '开启' : '关闭'}`)
    return {
      ok: true,
      lockDefaultModel,
      message: lockDefaultModel
        ? '已锁定：桥接会周期把 DSH 全局默认模型同步成配置的模型'
        : '已解锁：DSH 全局默认模型不再被桥接改动',
    }
  }

  // ── 表情库 ─────────────────────────────────────────────────────────────
  //
  // 表情库的真身在 `state/stickers.json`；这个文件由 bridge 自己维护（QQ 收藏同步
  // 会覆盖它），所以插件**不直接写**它，只做三件事：读、转成要给 AI 看的备注、
  // 以及把「AI 生成的图」交给 bridge 的备注接口入库。
  //
  // 为什么显示文件路径：用户明确要求「显示文件存放位置，方便后续管理」。
  // 路径算出来比写死好 —— bridgeHome 是可配置的，写死会在换机器时撒谎。
  const stickerFile = () => path.join(bridgeHome, 'state', 'stickers.json')
  const stickerDir = () => path.join(bridgeHome, 'state')
  const stickerImageDir = () => path.join(bridgeHome, 'state', 'stickers')

  /**
   * 只允许读「目录里真实存在的那个文件」——basename 挡得住 `../`，挡不住**符号链接**：
   * 有人在 state/stickers 里放一个指向 C:\Windows\... 的 mklink，basename 检查照样通过。
   * 本地单机威胁不大，但一条 http 通道不该顺着链接读任意文件，所以再 realpath 一次、
   * 确认落点仍在目录内。realpath 失败（文件不存在 / 断链）一律当读不到。
   */
  function readInsideDir(dir, name) {
    let real = ''
    let root = ''
    try {
      root = fs.realpathSync(dir)
      real = fs.realpathSync(path.join(dir, name))
    } catch {
      return null
    }
    // 前缀比较必须带分隔符，否则 /a/stickers 会误配 /a/stickers-x。
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (!real.startsWith(prefix)) return null
    try {
      if (!fs.statSync(real).isFile()) return null
      return fs.readFileSync(real)
    } catch {
      return null
    }
  }

  const STICKER_MIME = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }

  /**
   * 语音能力体检 —— 面板要如实说清「哪些能用、哪些不能」，而不是一句「不可用」。
   *
   * 两条通道必须分开看（这是本机最容易搞混的一点）：
   *
   * - **操作者通道** `POST /api/voice/send`（控制台令牌）：**不看 `voice.enabled`**。
   *   有音频、目录能读，就能发。面板的「试发」走这条。
   * - **AI 通道** `POST /api/socialV2/send-voice`（agent token）：要求
   *   `voice.enabled === true` **且** `tools.sendVoice === true`，否则 403。
   *
   * 所以「面板能试发」和「AI 会主动开口」是两个独立结论，不能合并成一个布尔。
   *
   * ffmpeg 只在调音量/响度时才需要（voice-core 的 `processAudioVolume` 在
   * volume≈1 且 loudness=null 时直接返回原文件），原样发不需要它。
   * 时长探测要 ffprobe，缺了只是不校验时长，也不阻断。
   */
  async function getVoice() {
    const conf = cfg()
    const vc = conf?.socialV2?.voice ?? {}
    const tools = conf?.socialV2?.tools ?? {}
    const audioDir = voiceDir()
    let audioExists = false
    let audioCount = 0
    try {
      audioExists = fs.statSync(audioDir).isDirectory()
      if (audioExists) {
        audioCount = fs.readdirSync(audioDir).filter((n) => isVoiceFile(n) && !n.startsWith('_')).length
      }
    } catch {
      audioExists = false
    }
    const ffmpegPath = String(process.env.FFMPEG_PATH ?? vc.ffmpegPath ?? '').trim()
    const ffmpegFound = ffmpegPath !== '' && fs.existsSync(ffmpegPath)
    const enabled = vc.enabled === true
    const toolOn = tools.sendVoice === true
    const tts = await ttsAvailability()

    // 有音频（或能靠本机 TTS 现攒一段）就有东西可发
    const canProduce = audioCount > 0 || (tts.available && tts.voices.length > 0)
    // 操作者通道：不需要 enabled
    const canSendNow = audioExists && canProduce
    // AI 通道：两个开关都得开
    const aiCanSend = enabled && toolOn && canSendNow

    const blockers = []
    if (!audioExists) blockers.push(`音频目录不存在：${audioDir}`)
    else if (audioCount === 0 && !(tts.available && tts.voices.length > 0)) {
      blockers.push(`音频目录里没有音频，也没法用本机语音合成：${audioDir}`)
    }
    if (!enabled) blockers.push('socialV2.voice.enabled 是 false（只挡 AI，不挡面板试发）')
    if (!toolOn) blockers.push('工具开关 sendVoice 是 false（只挡 AI，不挡面板试发）')
    if (!ffmpegFound) blockers.push('没有 ffmpeg（只在调音量/响度时需要，原样发不用）')

    return {
      ok: true,
      enabled,
      toolOn,
      audioDir,
      audioExists,
      audioCount,
      ffmpegPath,
      ffmpegFound,
      tts,
      /** 面板「试发」能不能用（操作者通道，不看 enabled） */
      canSendNow,
      /** AI 能不能自己开口（要两个开关都开） */
      aiCanSend,
      maxSeconds: vc.maxSeconds ?? null,
      maxBytes: vc.maxBytes ?? null,
      maxPerMinute: vc.maxPerMinute ?? null,
      maxPerHour: vc.maxPerHour ?? null,
      loudness: vc.loudness ?? null,
      defaultVolume: vc.defaultVolume ?? null,
      blockers,
      hint: aiCanSend
        ? 'AI 能自己发语音了。'
        : canSendNow
          ? '面板可以直接试发；要让 AI 自己开口，得把 voice.enabled 和 tools.sendVoice 都打开（改本机 config.json，面板不代劳）。'
          : '还不能发：先放一段音频进语音目录，或者用下面「念一句」现攒一段。',
    }
  }

  /**
   * 语音库所在目录（本机绝对路径）。voice.dir 是相对路径时按 bridgeHome 解析；
   * 绝对路径原样用 —— 与桥接 voiceCfg() 的口径一致。
   */
  const voiceDir = () => {
    const dir = String(cfg()?.socialV2?.voice?.dir ?? 'audio').trim() || 'audio'
    return path.isAbsolute(dir) ? dir : path.join(bridgeHome, dir)
  }

  /** 语音库能放哪些格式 —— 与 voice-core.js 的 AUDIO_EXTS 保持同一份清单。 */
  const VOICE_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac', '.amr', '.silk', '.slk', '.wma', '.spx']
  const isVoiceFile = (name) => VOICE_EXTS.includes(path.extname(String(name)).toLowerCase())

  /**
   * ── 音色（TTS 引擎）─────────────────────────────────────────────────────
   *
   * 本机有两条能出声的路，音色完全不同：
   *
   * - `sapi`：Windows 自带的 System.Speech。离线、稳、零依赖，但中文只有一个
   *   `Microsoft Huihui Desktop`（慧慧），声音偏"播报"，念故事书那种腔。
   * - `edge`：微软 Edge 的在线神经网络语音（@andresaya/edge-tts）。免费无须 key，
   *   中文有 14 个音色，其中晓晓/晓伊/晓北/晓妮明显更自然。**需要联网**。
   * - `breeze`：Breezeblue 云端音色克隆（用户自己在 breeze.blue 设计的音色）。
   *   要 key 与 voiceId，都放在 config.json 的 `socialV2.voice.breeze`，代码不写死密钥。
   *
   * 面板让管理员自己选，并把选择记在本机 —— 换音色不该靠改代码。
   */
  const VOICE_PREFS_FILE = () => path.join(dshHome, 'qq-panel-voice.json')

  /** Edge TTS 的候选音色：只列中文，按"适合小鲸鱼这个角色"排好序。 */
  const EDGE_VOICES = [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', note: '温暖自然，最通用（默认）', gender: '女' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊', note: '甜一点、年轻，适合撒娇', gender: '女' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', note: '东北腔，爽利，接梗快', gender: '女' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', note: '陕西腔，有股憨劲儿', gender: '女' },
    { id: 'zh-TW-HsiaoChenNeural', name: '晓臻', note: '台湾腔，软糯', gender: '女' },
    { id: 'zh-CN-YunxiNeural', name: '云希', note: '年轻男声，清亮', gender: '男' },
    { id: 'zh-CN-YunjianNeural', name: '云健', note: '男声，低沉有力', gender: '男' },
    { id: 'zh-CN-YunyangNeural', name: '云扬', note: '男声，播音腔', gender: '男' },
  ]

  /**
   * 找一个真正的 node 可执行文件。
   *
   * **不能用 `process.execPath`**：插件跑在 DSH 的 Electron 主进程里，那个值是
   * `DeepSeek Harness.exe`。用它去跑 `tts-kokoro.cjs` 时 sherpa-onnx 的原生模块
   * 会加载成另一套堆布局，合成直接抛 `External buffers are not allowed`
   * （2026-11-05 真机踩到的，直连 node 跑同一脚本完全正常）。
   */
  function resolveNodeExe(config) {
    const configured = String(config?.nodeExe ?? '').trim()
    if (configured !== '' && fs.existsSync(configured)) return configured
    const envNode = String(process.env.QQ_PANEL_NODE ?? '').trim()
    if (envNode !== '' && fs.existsSync(envNode)) return envNode
    for (const candidate of ['D:\\nodejs\\node.exe', path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')]) {
      if (fs.existsSync(candidate)) return candidate
    }
    // 兜底：让子进程自己去 PATH 里找；找不到会在 spawn 时明确报 ENOENT
    return 'node'
  }

  /**
   * 本机离线 TTS：Kokoro v1.1-zh。
   *
   * 为什么要它（用户原话「不要有AI味，要很真实的音色，不要男性音色」）：
   * Edge 的晓晓/晓伊虽然自然，但仍是"播音腔"的合成味，而且同一句话每次念出来
   * 完全一样。Kokoro 是 82M 的 StyleTTS2 系模型，103 个音色里有 55 个中文女声，
   * 声线颗粒感更接近真人录音，也没有联网和限流问题。
   *
   * 这里的 sid 是 voices.bin 里的下标。数值取自实测（见 README「挑音色」一节）：
   * 把每个音色的基频中位/起伏跨度、以及谱质心与 Maia.wav（管理员给的真人样本）的
   * 距离算出来，取最接近的一批。**全是女声**，用户明确不要男声。
   */
  const KOKORO_VOICES = [
    { id: 'kokoro:39', name: '小岚', note: 'F0 282Hz，起伏最大，最像真人说话（推荐）' },
    { id: 'kokoro:11', name: '小满', note: 'F0 289Hz，语调活，笑起来很明显' },
    { id: 'kokoro:36', name: '小禾', note: 'F0 258Hz，偏软，不咄咄逼人' },
    { id: 'kokoro:53', name: '小霜', note: 'F0 216Hz，低一点，安静时的声音' },
    { id: 'kokoro:42', name: '小榆', note: 'F0 245Hz，温和，念长句舒服' },
    { id: 'kokoro:20', name: '小茉', note: 'F0 240Hz，清亮，接梗快' },
    { id: 'kokoro:3', name: '小舟', note: 'F0 258Hz，标准的年轻女声' },
    { id: 'kokoro:55', name: '小棠', note: 'F0 264Hz，嗓门略压着，像在耳边说' },
  ]

  /**
   * Breezeblue 云端音色克隆。
   *
   * 用户在 breeze.blue 自己设计的音色（voc_d4utea6v6cm3），比本机任何合成音都更贴近
   * 想要的声线。它走云端 HTTPS POST，返回 wav 二进制；key 与 voiceId 都放 config.json
   * 的 `socialV2.voice.breeze`，代码里不写死密钥（要上传 GitHub，密钥不能进仓库）。
   */
  const BREEZE_BASE_URL = 'https://api.breeze.blue'
  const BREEZE_OUTPUT_FORMAT = 'wav_24000'

  /** 读 config.json 里 socialV2.voice.breeze 段（apiKey/voiceId/enabled）。 */
  function breezeCfg() {
    const b = cfg()?.socialV2?.voice?.breeze ?? {}
    return {
      enabled: b.enabled !== false,
      apiKey: String(b.apiKey ?? '').trim(),
      voiceId: String(b.voiceId ?? '').trim(),
      probability: Number.isFinite(Number(b.probability)) ? Math.max(0, Math.min(1, Number(b.probability))) : 0.3,
      minChars: Number.isFinite(Number(b.minChars)) && Number(b.minChars) > 0 ? Math.round(Number(b.minChars)) : 8,
      outputFormat: String(b.outputFormat ?? BREEZE_OUTPUT_FORMAT).trim() || BREEZE_OUTPUT_FORMAT,
    }
  }

  /** Breezeblue 可用性：enabled + apiKey + voiceId 齐了才算可用。带 60 秒缓存。 */
  let breezeCache = null
  function breezeAvailability() {
    if (breezeCache !== null && Date.now() - breezeCache.at < 60000) return breezeCache.value
    const b = breezeCfg()
    let reason = ''
    if (!b.enabled) reason = 'Breezeblue 语音未启用（config.json 里 socialV2.voice.breeze.enabled 不是 true）'
    else if (b.apiKey === '') reason = '没配 Breezeblue API key（socialV2.voice.breeze.apiKey 为空）'
    else if (b.voiceId === '') reason = '没配 Breezeblue 音色 ID（socialV2.voice.breeze.voiceId 为空）'
    const value = { available: reason === '', reason, voiceId: b.voiceId, probability: b.probability, minChars: b.minChars, engine: 'breeze' }
    breezeCache = { at: Date.now(), value }
    return value
  }

  /**
   * 用 Breezeblue 云端音色克隆念一段文字，落成 wav 放进语音库。
   *
   * 与 Edge/SAPI 的差别：这是用户自己的克隆音色，最接近想要的声线；但要联网、且
   * 每次调用都消耗 key 的额度。合成走 node 内置 https（POST + xi-api-key 头），
   * 不依赖 safeFetchBuffer（那个只支持 GET）。
   */
  async function synthesizeWithBreeze(text, voiceId) {
    const b = breezeCfg()
    const voice = typeof voiceId === 'string' && voiceId.trim() !== '' ? voiceId.trim() : b.voiceId
    if (b.apiKey === '') return { ok: false, httpStatus: 503, message: '没配 Breezeblue API key（socialV2.voice.breeze.apiKey 为空）' }
    if (voice === '') return { ok: false, httpStatus: 503, message: '没配 Breezeblue 音色 ID（socialV2.voice.breeze.voiceId 为空）' }

    const dir = voiceDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `建不了语音目录 ${dir}：${error?.message ?? error}` }
    }

    const url = `${BREEZE_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(b.outputFormat)}`
    const audio = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'xi-api-key': b.apiKey,
          accept: 'audio/wav,audio/*,*/*;q=0.8',
        },
        timeout: 30000,
      }, (res) => {
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            let detail = ''
            try { detail = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.detail ?? Buffer.concat(chunks).toString('utf8').slice(0, 200) } catch { detail = Buffer.concat(chunks).toString('utf8').slice(0, 200) }
            reject(new Error(`Breezeblue 返回 ${status}${detail ? `：${detail}` : ''}`))
          })
          res.resume()
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('timeout', () => req.destroy(new Error('Breezeblue 合成超时（30 秒）')))
      req.on('error', (error) => reject(error))
      req.write(JSON.stringify({ text }))
      req.end()
    })

    if (!audio || audio.length < 1024) {
      return { ok: false, httpStatus: 502, message: 'Breezeblue 语音合成没拿到音频' }
    }

    const safe = (String(text ?? '').trim()).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 24)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const fileName = `tts-breeze-${stamp}${safe ? `-${safe}` : ''}.wav`
    const outPath = path.join(dir, fileName)
    try {
      fs.writeFileSync(outPath, audio)
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `写不进语音目录：${error?.message ?? error}` }
    }
    const bytes = fs.statSync(outPath).size
    log(`Breezeblue 语音合成：${fileName}（${bytes} 字节，音色 ${voice}）`)
    watchdog.pushLog(`语音合成：${fileName}`)
    watchdog.save()
    return {
      ok: true,
      name: fileName,
      dir,
      bytes,
      voice,
      voiceName: 'Breezeblue 克隆音色',
      engine: 'breeze',
      chars: text.length,
      url: `${API}/voice-file?name=${encodeURIComponent(fileName)}`,
      message: `念好了：${fileName}（Breezeblue 克隆音色）`,
    }
  }

  /** Kokoro 模型目录：优先 config.json 里的配置，其次约定位置。 */
  const kokoroModelDir = () => {
    const cfgDir = String(config?.tts?.kokoroModelDir ?? '').trim()
    if (cfgDir !== '') return path.isAbsolute(cfgDir) ? cfgDir : path.join(bridgeHome, cfgDir)
    return path.join(bridgeHome, 'tts-models', 'kokoro')
  }

  /** Kokoro 可用性：脚本在、模型文件齐、sherpa-onnx-node 能 require。**不加载模型**（那是 3.7 秒）。 */
  let kokoroCache = null
  async function kokoroAvailability() {
    if (kokoroCache !== null && Date.now() - kokoroCache.at < 60000) return kokoroCache.value
    const dir = kokoroModelDir()
    const script = path.join(PKG_DIR, 'scripts', 'tts-kokoro.cjs')
    const need = ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt']
    const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)))
    let reason = ''
    if (!fs.existsSync(script)) reason = `缺启动脚本：${script}`
    else if (missing.length > 0) reason = `模型不全（缺 ${missing.join('、')}）：${dir}`
    else if (!fs.existsSync(path.join(bridgeHome, 'node_modules', 'sherpa-onnx-node'))) {
      reason = `没装 sherpa-onnx-node（在 ${path.join(bridgeHome, 'node_modules')} 下找不到）`
    }
    const value = { available: reason === '', reason, dir, voices: KOKORO_VOICES, engine: 'kokoro' }
    kokoroCache = { at: Date.now(), value }
    return value
  }

  /**
   * Kokoro 常驻子进程。
   *
   * 为什么要常驻：模型加载 3.7 秒、合成一句 1.4 秒。每句话都重启进程等于白等 3.7 秒。
   * 这里起一次 `--serve` 让它自己读 stdin 的 JSON 行；空闲 5 分钟自动收掉（省内存）。
   * 用子进程而不是在插件里直接 require 的另一个理由：`tts.generate()` 是同步阻塞的，
   * 在主进程里跑会把 DSH 的 web server 一起冻住。
   */
  const kokoroQueue = new Map()
  let kokoroChild = null
  let kokoroSeq = 0
  let kokoroIdleTimer = null
  let kokoroStdoutBuf = ''
  let kokoroLastError = ''

  function kokoroKill() {
    if (kokoroIdleTimer !== null) {
      clearTimeout(kokoroIdleTimer)
      kokoroIdleTimer = null
    }
    if (kokoroChild !== null) {
      try {
        kokoroChild.stdin.end()
      } catch {
        /* 已经关了 */
      }
      try {
        kokoroChild.kill()
      } catch {
        /* 已经退出了 */
      }
      kokoroChild = null
    }
    kokoroStdoutBuf = ''
    for (const [, entry] of kokoroQueue) entry.reject(new Error('Kokoro 进程被收掉了'))
    kokoroQueue.clear()
  }

  function kokoroTouch() {
    if (kokoroIdleTimer !== null) clearTimeout(kokoroIdleTimer)
    // 5 分钟没人念就收掉：模型常驻大概占 400~600MB，不值得一直挂着。
    kokoroIdleTimer = setTimeout(() => kokoroKill(), 5 * 60 * 1000)
    if (typeof kokoroIdleTimer.unref === 'function') kokoroIdleTimer.unref()
  }

  async function kokoroStart() {
    if (kokoroChild !== null) return kokoroChild
    const dir = kokoroModelDir()
    const script = path.join(PKG_DIR, 'scripts', 'tts-kokoro.cjs')
    const ready = await new Promise((resolve, reject) => {
      const child = spawn(resolveNodeExe(config), [script, '--serve', '--model-dir', dir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: bridgeHome,
      })
      // stdin 必须有人接 error。Kokoro 是常驻进程，在两次合成之间被外部杀掉（任务管理器、
      // 模型目录被移走、5 分钟空闲回收抢在本次请求前）时，下一次 write 会 EPIPE ——
      // 没有监听器的 stream error 会抛成**未捕获异常**，把整个 DSH host 一起带走
      // （表现：面板和正在跑的 QQ 会话同时消失，日志里只剩一个裸 EPIPE）。
      child.stdin.on('error', (error) => {
        kokoroLastError = `Kokoro stdin：${error?.message ?? error}`
      })
      let buf = ''
      let settled = false
      const fail = (message) => {
        if (settled) return
        settled = true
        // 失败路径也要把超时定时器收掉：否则它会继续挂着 30 秒才触发一次
        // 什么都不做的回调（settled 挡住了副作用，但白占一个待触发的 timer）。
        clearTimeout(timer)
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        reject(new Error(message))
      }
      const timer = setTimeout(() => fail('Kokoro 启动超时（30 秒内没准备好，模型可能太大或坏了）'), 30000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buf += chunk
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
          if (line === '') continue
          if (!settled && line.startsWith('ready')) {
            settled = true
            clearTimeout(timer)
            kokoroChild = child
            kokoroStdoutBuf = ''
            child.stdout.on('data', (more) => kokoroOnStdout(more))
            child.on('exit', () => {
              kokoroChild = null
              kokoroLastError = 'Kokoro 进程意外退出'
            })
            kokoroTouch()
            resolve(child)
            return
          }
          if (!settled && line !== '') fail(`Kokoro 没准备好：${line.slice(0, 200)}`)
        }
      })
      child.stderr.setEncoding('utf8')
      let err = ''
      child.stderr.on('data', (chunk) => {
        err += chunk
        if (err.length > 4000) err = err.slice(-4000)
      })
      child.on('error', (error) => fail(`起不了 Kokoro 进程：${error?.message ?? error}`))
      child.on('exit', (code) => {
        if (!settled) fail(`Kokoro 退出了（exit=${code}）${err ? `：${err.trim().split('\n').pop()}` : ''}`)
      })
    })
    return ready
  }

  function kokoroOnStdout(chunk) {
    kokoroStdoutBuf += chunk
    let nl = kokoroStdoutBuf.indexOf('\n')
    while (nl >= 0) {
      const line = kokoroStdoutBuf.slice(0, nl).trim()
      kokoroStdoutBuf = kokoroStdoutBuf.slice(nl + 1)
      nl = kokoroStdoutBuf.indexOf('\n')
      if (line === '') continue
      let msg = null
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const entry = kokoroQueue.get(msg?.id)
      if (entry === undefined) continue
      kokoroQueue.delete(msg.id)
      if (msg.ok === true) entry.resolve(msg)
      else entry.reject(new Error(String(msg.error ?? '合成失败')))
    }
  }

  /** 用常驻 Kokoro 进程念一句，落成 wav。 */
  async function synthesizeWithKokoro(text, voiceId, speed, nameHint) {
    const avail = await kokoroAvailability()
    if (!avail.available) return { ok: false, httpStatus: 503, message: `本机 Kokoro 用不了：${avail.reason}` }

    const sid = Number(String(voiceId ?? '').replace(/^kokoro:/, ''))
    const meta = KOKORO_VOICES.find((v) => v.id === voiceId) ?? KOKORO_VOICES[0]
    const useSid = Number.isFinite(sid) ? sid : 39

    const dir = voiceDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `建不了语音目录 ${dir}：${error?.message ?? error}` }
    }

    // 文件名优先用调用方给的名字，其次音色名 —— **不要拿正文当名字**：
    // 一句话 30 个字会变成一个 100+ 字符的文件名，语音库里根本没法看（真机踩到）。
    const hint = String(nameHint ?? '').trim()
    const label = (hint !== '' ? hint : (String(text ?? '').length <= 12 ? String(text) : meta.name))
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .trim()
      .slice(0, 20)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const fileName = `tts-k${meta.id.replace(/^kokoro:/, '')}-${stamp}${label ? `-${label}` : ''}.wav`
    const outPath = path.join(dir, fileName)

    try {
      const child = await kokoroStart()
      const msg = await new Promise((resolve, reject) => {
        const id = ++kokoroSeq
        kokoroQueue.set(id, { resolve, reject })
        const timer = setTimeout(() => {
          if (kokoroQueue.delete(id)) reject(new Error('合成超时（30 秒）'))
        }, 30000)
        if (typeof timer.unref === 'function') timer.unref()
        const wrapped = { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } }
        kokoroQueue.set(id, wrapped)
        // 文本经 stdin 传：不走命令行（中文会被代码页转坏），也不落临时文件（省一次读写）
        child.stdin.write(`${JSON.stringify({ id, text: String(text ?? ''), sid: useSid, speed: Math.max(0.5, Math.min(2, 1 + speed / 100)), out: outPath })}\n`)
      })
      kokoroTouch()
      const bytes = Number(msg.bytes) || 0
      if (bytes <= 44) {
        try {
          fs.unlinkSync(outPath)
        } catch {
          /* 没产出就没有可删的 */
        }
        return { ok: false, httpStatus: 502, message: 'Kokoro 合成产出空文件' }
      }
      log(`Kokoro 语音合成：${fileName}（${bytes} 字节，${meta.name}）`)
      watchdog.pushLog(`语音合成：${fileName}`)
      watchdog.save()
      return {
        ok: true,
        name: fileName,
        dir,
        bytes,
        voice: meta.id,
        voiceName: meta.name,
        engine: 'kokoro',
        chars: String(text ?? '').length,
        url: `${API}/voice-file?name=${encodeURIComponent(fileName)}`,
        message: `念好了：${fileName}（${meta.name}）`,
      }
    } catch (error) {
      kokoroLastError = String(error?.message ?? error)
      return { ok: false, httpStatus: 502, message: `Kokoro 语音合成失败：${kokoroLastError}` }
    }
  }

  /**
   * 懒加载 @andresaya/edge-tts。   *
   * 为什么用 `createRequire` 从 profile 目录解析：插件本体是 ESM，而 edge-tts 是 CJS；
   * 更要紧的是插件跑起来时的真实路径是 `D:\DSHHome\profiles\desktop\node_modules\qq-agent-presets`
   * （junction），从那里向上找到的 node_modules 才是装了 edge-tts 的那一份。
   * 直接在包目录里 `import('@andresaya/edge-tts')` 会 ERR_MODULE_NOT_FOUND —— 实测过。
   */
  let edgeTtsModule = null
  let edgeTtsError = ''
  async function loadEdgeTts() {
    if (edgeTtsModule !== null) return edgeTtsModule
    if (edgeTtsError !== '') return null
    const bases = []
    const profileDir = String(process.env.DSH_PROFILE_DIR ?? '').trim()
    if (profileDir !== '') bases.push(path.join(profileDir, 'node_modules', 'qq-agent-presets', 'index.js'))
    bases.push(path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'qq-agent-presets', 'index.js'))
    bases.push(path.join(PKG_DIR, 'index.js'))
    for (const base of bases) {
      try {
        const require = createRequire(base)
        const mod = require('@andresaya/edge-tts')
        const Ctor = mod?.EdgeTTS ?? mod?.default?.EdgeTTS
        if (typeof Ctor === 'function') {
          edgeTtsModule = Ctor
          return edgeTtsModule
        }
      } catch {
        /* 换下一个候选 */
      }
    }
    edgeTtsError = '本机没装 @andresaya/edge-tts（或在 profile 里解析不到）'
    return null
  }

  /** Edge TTS 体检：能不能用、有哪些音色。带 5 分钟缓存，别每次都去连网。 */
  let edgeCache = null
  async function edgeTtsAvailability() {
    if (edgeCache !== null && Date.now() - edgeCache.at < 300000) return edgeCache.value
    const Ctor = await loadEdgeTts()
    let value
    if (Ctor === null) {
      value = { available: false, reason: edgeTtsError, voices: EDGE_VOICES }
    } else {
      value = {
        available: true,
        reason: '',
        // 候选表写死，不依赖一次网络往返 —— 界面打开时不该卡在列音色上。
        voices: EDGE_VOICES,
        // 真连一次，确认服务没抽风（失败只降级，不阻断 SAPI）
        online: null,
      }
    }
    edgeCache = { at: Date.now(), value }
    return value
  }

  /** 读本机记下的音色偏好。文件坏了就当没设过，不因此让整节报错。 */
  function readVoicePrefs() {
    // 默认走 Kokoro 小岚：本机离线、没有合成味、不限流。Edge 需要联网且是播音腔，
    // SAPI 只有慧慧一个播报腔的声音 —— 都留作备选，但不再当默认。
    const fallback = { engine: 'kokoro', voice: 'kokoro:39', rate: 0 }
    const engines = ['kokoro', 'edge', 'sapi', 'breeze']
    try {
      const raw = JSON.parse(fs.readFileSync(VOICE_PREFS_FILE(), 'utf8'))
      const engine = engines.includes(raw?.engine) ? raw.engine : fallback.engine
      const voice = typeof raw?.voice === 'string' && raw.voice !== '' ? raw.voice : fallback.voice
      const rate = Number.isFinite(Number(raw?.rate)) ? Math.max(-30, Math.min(30, Math.round(Number(raw.rate)))) : 0
      return { engine, voice, rate }
    } catch {
      return fallback
    }
  }

  function saveVoicePrefs(body) {
    const prev = readVoicePrefs()
    const engines = ['kokoro', 'edge', 'sapi', 'breeze']
    // 显式传了字段就严格校验。旧实现是把非法值静默退回旧值 + 回 ok:true，
    // 界面于是弹「已切换」而实际没换 —— 这种「成功但没生效」比报错难查得多。
    if (body?.engine !== undefined && !engines.includes(body.engine)) {
      return { ok: false, httpStatus: 400, message: `engine 必须是 ${engines.join(' / ')} 之一` }
    }
    if (body?.voice !== undefined && (typeof body.voice !== 'string' || body.voice.trim() === '')) {
      return { ok: false, httpStatus: 400, message: 'voice 必须是非空字符串' }
    }
    if (body?.rate !== undefined && !Number.isFinite(Number(body.rate))) {
      return { ok: false, httpStatus: 400, message: 'rate 必须是数字（-30~30）' }
    }
    const engine = engines.includes(body?.engine) ? body.engine : prev.engine
    const voice = typeof body?.voice === 'string' && body.voice.trim() !== '' ? body.voice.trim() : prev.voice
    const rate = body?.rate !== undefined && Number.isFinite(Number(body.rate))
      ? Math.max(-30, Math.min(30, Math.round(Number(body.rate))))
      : prev.rate
    const next = { engine, voice, rate }
    try {
      fs.mkdirSync(path.dirname(VOICE_PREFS_FILE()), { recursive: true })
      fs.writeFileSync(VOICE_PREFS_FILE(), JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `存不下音色偏好：${error?.message ?? error}` }
    }
    return { ok: true, prefs: next }
  }

  /**
   * 用 Edge TTS 念一段，落成 mp3。
   *
   * 与 SAPI 那一路的取舍：
   * - SAPI 离线、零依赖，但只有一个播报腔的中文音色；
   * - Edge 需要联网，但音色多、自然得多。
   * 两条都留着，默认走 Edge（好听优先），断网时面板会说清为什么退回 SAPI。
   */
  async function synthesizeWithEdge(text, voiceId, rate, nameHint) {
    const Ctor = await loadEdgeTts()
    if (Ctor === null) return { ok: false, httpStatus: 503, message: edgeTtsError }
    const voice = EDGE_VOICES.some((v) => v.id === voiceId) ? voiceId : EDGE_VOICES[0].id
    const dir = voiceDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `建不了语音目录 ${dir}：${error?.message ?? error}` }
    }

    let audio = null
    try {
      const tts = new Ctor()
      const opts = {}
      if (rate !== 0) opts.rate = `${rate > 0 ? '+' : ''}${rate}%`
      const r = await tts.generate(text, voice, opts)
      audio = r?.audio ?? null
    } catch (error) {
      const msg = String(error?.message ?? error)
      const hint = /429/i.test(msg)
        ? '（微软限流，等十几秒再试；连续念太多会被临时挡）'
        : /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network/i.test(msg)
          ? '（连不上微软的语音服务，检查网络或代理）'
          : ''
      return { ok: false, httpStatus: 502, message: `Edge 语音合成失败：${msg}${hint}` }
    }
    if (audio === null || audio.length < 1024) {
      return { ok: false, httpStatus: 502, message: 'Edge 语音合成没拿到音频' }
    }

    const safe = (String(nameHint ?? '').trim() || text).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 24)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const prefix = voice.replace(/^zh-[A-Za-z-]*-/, '').replace(/Neural$/, '').toLowerCase()
    const fileName = `tts-${prefix}-${stamp}${safe ? `-${safe}` : ''}.mp3`
    const outPath = path.join(dir, fileName)
    try {
      fs.writeFileSync(outPath, Buffer.from(audio))
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `写不进语音目录：${error?.message ?? error}` }
    }
    const bytes = fs.statSync(outPath).size
    log(`Edge 语音合成：${fileName}（${bytes} 字节，音色 ${voice}）`)
    watchdog.pushLog(`语音合成：${fileName}`)
    watchdog.save()
    const label = EDGE_VOICES.find((v) => v.id === voice)?.name ?? voice
    return {
      ok: true,
      name: fileName,
      dir,
      bytes,
      voice,
      voiceName: label,
      engine: 'edge',
      chars: text.length,
      url: `${API}/voice-file?name=${encodeURIComponent(fileName)}`,
      message: `念好了：${fileName}（${label}）`,
    }
  }

  /**
   * 列语音库 + 体检。这是「语音」那一节的唯一数据源。
   *
   * 与 bridge 的 `/api/socialV2/voices` 的区别：那个接口带 probe 时要逐个 spawn ffprobe，
   * 库里东西一多会很慢；这里只做 stat（字节数 + 修改时间），并把「能不能发」的判断交给
   * getVoice() 那一份统一口径，避免两处规则漂移。
   */
  async function listVoices(body) {
    const dir = voiceDir()
    const wantProbe = body?.probe === true
    let exists = false
    let names = []
    try {
      exists = fs.statSync(dir).isDirectory()
      if (exists) names = fs.readdirSync(dir).filter((n) => isVoiceFile(n) && !n.startsWith('_'))
    } catch {
      exists = false
    }
    names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    const files = names.map((name) => {
      const full = path.join(dir, name)
      let bytes = 0
      let at = 0
      try {
        const st = fs.statSync(full)
        bytes = st.size
        at = st.mtimeMs
      } catch {
        /* 读不到就当 0 */
      }
      return { name, bytes, at, url: `${API}/voice-file?name=${encodeURIComponent(name)}` }
    })

    // 可选：真正探一次时长（要 spawn ffprobe，慢，默认不做）
    let probed = null
    if (wantProbe && files.length > 0) {
      const r = await callBridge('GET', '/api/socialV2/voices', undefined, 30000)
      if (r.ok && r.json?.voices) {
        probed = r.json.voices.map((v) => ({ name: v.name, ok: v.ok, detail: v.detail, seconds: v.seconds, error: v.error }))
      }
    }

    const limits = cfg()?.socialV2?.voice ?? {}
    return {
      ok: true,
      dir,
      exists,
      count: files.length,
      files,
      probed,
      limits: {
        maxSeconds: limits.maxSeconds ?? null,
        maxBytes: limits.maxBytes ?? null,
        maxPerMinute: limits.maxPerMinute ?? null,
        maxPerHour: limits.maxPerHour ?? null,
      },
      tts: await ttsAvailability(),
      // 四路 TTS 的体检 + 当前选的音色。界面靠它决定「念一句」用哪个引擎。
      kokoro: await kokoroAvailability(),
      edge: await edgeTtsAvailability(),
      breeze: breezeAvailability(),
      prefs: readVoicePrefs(),
    }
  }

  /**
   * 本机 TTS 体检：有没有能说话的中文语音。
   *
   * 只查 System.Speech 的已安装语音（不走网络）。这一步决定了面板上「念一句」按钮
   * 是能点还是灰的 —— 给一个点了没反应的按钮比不给更糟。
   */
  let ttsCache = null
  async function ttsAvailability() {
    if (ttsCache !== null && Date.now() - ttsCache.at < 60000) return ttsCache.value
    const value = await new Promise((resolve) => {
      const exe = resolvePowerShell(config)
      const script = [
        'try {',
        '  Add-Type -AssemblyName System.Speech',
        '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        '  $v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -like "zh*" } | Select-Object -First 3',
        '  $s.Dispose()',
        '  if ($v) { $v | ForEach-Object { "$($_.Name)|$($_.Culture.Name)|$($_.Gender)" } } else { "none" }',
        '} catch { "error:" + $_.Exception.Message }',
      ].join('; ')
      const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        // close 迟迟不来时（Windows 上 PowerShell/SAPI 偶尔不响应 TerminateProcess），
        // 这个 Promise 会永远 pending，把 /capabilities 与 /voices 一起挂住。
        // 再等 1.5 秒就自己收尾（resolve 是幂等的，close 后来也到就无所谓）。
        setTimeout(() => resolve({ available: false, voices: [], reason: '语音体检超时（PowerShell 没响应）' }), 1500)
      }, 15000)
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { out += String(d) })
      child.on('error', () => { clearTimeout(timer); resolve({ available: false, voices: [], reason: '跑不起来 PowerShell' }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        const text = out.trim()
        if (code !== 0 || text.startsWith('error:') || text === '') {
          resolve({ available: false, voices: [], reason: text.replace(/^error:/, '') || '查询超时' })
          return
        }
        if (text === 'none') {
          resolve({ available: true, voices: [], reason: '本机没有中文语音包（英文语音说中文会念成拼音）' })
          return
        }
        const voices = text.split(/\r?\n/).map((line) => {
          const [name, culture, gender] = line.split('|')
          return { name: name ?? '', culture: culture ?? '', gender: gender ?? '' }
        }).filter((v) => v.name !== '')
        resolve({ available: true, voices, reason: '' })
      })
    })
    ttsCache = { at: Date.now(), value }
    return value
  }

  /**
   * 用本机 SAPI 念一段文字，落成 wav 放进语音库。
   *
   * 为什么走 PowerShell 脚本而不是在 Node 里直接调 SAPI：Node 没有 TTS 绑定，
   * 而 System.Speech 只有 .NET 侧才有。脚本 `scripts/tts-sapi.ps1` 用 -File 启动、
   * 文本经 **UTF-8 文件**传入 —— 直接把中文塞进命令行会被控制台代码页（本机 GBK）
   * 转成问号（这个坑在别处已经踩过一次）。
   */
  async function synthesizeVoice(body) {
    const text = String(body?.text ?? '').trim()
    if (text === '') return { ok: false, httpStatus: 400, message: 'text 不能为空' }
    if (text.length > 2000) return { ok: false, httpStatus: 400, message: `文字太长（${text.length} 字），上限 2000` }

    const prefs = readVoicePrefs()
    const engines = ['kokoro', 'edge', 'sapi', 'breeze']
    const engine = engines.includes(body?.engine) ? body.engine : prefs.engine
    const rate = body?.rate !== undefined && Number.isFinite(Number(body.rate))
      ? Math.max(-30, Math.min(30, Math.round(Number(body.rate))))
      : prefs.rate

    // Kokoro 优先：本机离线、没有合成味。失败时如实说清原因，不静默换引擎 ——
    // 管理员选了小岚却听到晓晓，会以为是 bug。
    if (engine === 'kokoro') {
      const avail = await kokoroAvailability()
      if (!avail.available) {
        return { ok: false, httpStatus: 503, message: `Kokoro 语音用不了：${avail.reason}。可以把引擎切到 Edge（要联网）或本机 SAPI（只有慧慧）。` }
      }
      const voice = body?.voice !== undefined && String(body.voice).trim() !== '' ? String(body.voice).trim() : prefs.voice
      return synthesizeWithKokoro(text, voice, rate, body?.name)
    }

    // Edge：好听得多，但要联网。同样不静默回落。
    if (engine === 'edge') {
      const edge = await edgeTtsAvailability()
      if (edge.available) {
        const voice = body?.voice !== undefined && String(body.voice).trim() !== ''
          ? String(body.voice).trim()
          : prefs.voice
        return synthesizeWithEdge(text, voice, rate, body?.name)
      }
      return {
        ok: false,
        httpStatus: 503,
        message: `Edge 语音用不了：${edge.reason}。可以在上面把引擎切回本机 SAPI（只有慧慧一个声音）。`,
      }
    }

    // Breezeblue：用户自己的克隆音色，最贴想要的声线；但要联网 + 耗 key 额度。不静默回落。
    if (engine === 'breeze') {
      const b = breezeAvailability()
      if (!b.available) {
        return { ok: false, httpStatus: 503, message: `Breezeblue 语音用不了：${b.reason}` }
      }
      const voice = body?.voice !== undefined && String(body.voice).trim() !== '' ? String(body.voice).trim() : b.voiceId
      return synthesizeWithBreeze(text, voice)
    }

    const tts = await ttsAvailability()
    if (!tts.available) return { ok: false, httpStatus: 503, message: `本机跑不了语音合成：${tts.reason}` }
    if (tts.voices.length === 0) return { ok: false, httpStatus: 503, message: tts.reason || '本机没有可用的中文语音' }

    const wanted = String(body?.voice ?? '').trim()
    const voice = tts.voices.some((v) => v.name === wanted) ? wanted : tts.voices[0].name

    const dir = voiceDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `建不了语音目录 ${dir}：${error?.message ?? error}` }
    }

    // 文件名带时间戳，重复念同一句不会互相覆盖；只保留安全字符。
    const safe = (String(body?.name ?? '').trim() || text).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 24)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const fileName = `tts-${stamp}${safe ? `-${safe}` : ''}.wav`
    const outPath = path.join(dir, fileName)
    const textFile = path.join(dir, `_tts-${stamp}.txt`)

    try {
      fs.writeFileSync(textFile, text, 'utf8')
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `写不了临时文本：${error?.message ?? error}` }
    }

    const scriptPath = path.join(PKG_DIR, 'scripts', 'tts-sapi.ps1')
    if (!fs.existsSync(scriptPath)) {
      try { fs.unlinkSync(textFile) } catch { /* 清不掉就算了 */ }
      return { ok: false, httpStatus: 500, message: `缺语音合成脚本：${scriptPath}` }
    }

    const run = await new Promise((resolve) => {
      const exe = resolvePowerShell(config)
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TextFile', textFile, '-OutFile', outPath]
      if (voice) args.push('-Voice', voice)
      // SAPI 的 -Rate 量程是 -10..10，而面板统一用 -30..30（与 Edge 的百分比对齐），
      // 所以这里折一半再夹紧 —— 不折算的话面板拉到 +10 就会把 SAPI 顶到极限。
      const sapiRate = Math.max(-10, Math.min(10, Math.round(rate / 3)))
      if (sapiRate !== 0) args.push('-Rate', String(sapiRate))
      if (body?.volume !== undefined) args.push('-Volume', String(Math.max(0, Math.min(100, Number(body.volume) || 100))))
      const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
      }, 60000)
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { out += String(d) })
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, error: `启动失败：${error?.message ?? error}`, out }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
    })

    try { fs.unlinkSync(textFile) } catch { /* 临时文本没清掉不影响结果 */ }

    if (run.code !== 0) {
      try { fs.unlinkSync(outPath) } catch { /* 没产出就没有可删的 */ }
      const detail = String(run.out ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' / ')
      return { ok: false, httpStatus: 500, message: `语音合成失败（exit=${run.code}）${detail ? `：${detail}` : ''}` }
    }

    let bytes = 0
    try { bytes = fs.statSync(outPath).size } catch { bytes = 0 }
    if (bytes <= 44) {
      try { fs.unlinkSync(outPath) } catch { /* ignore */ }
      return { ok: false, httpStatus: 500, message: '语音合成产出空文件' }
    }

    log(`语音合成：${fileName}（${bytes} 字节，语音 ${voice}）`)
    watchdog.pushLog(`语音合成：${fileName}`)
    watchdog.save()
    return {
      ok: true,
      name: fileName,
      dir,
      bytes,
      voice,
      chars: text.length,
      url: `${API}/voice-file?name=${encodeURIComponent(fileName)}`,
      message: `念好了：${fileName}`,
    }
  }

  /** 记住「用哪个音色」—— 存本机文件，换音色不靠改代码。 */
  async function setVoicePrefs(body) {
    const r = saveVoicePrefs(body ?? {})
    if (r.ok === false) return r
    log(`音色偏好：engine=${r.prefs.engine} voice=${r.prefs.voice} rate=${r.prefs.rate}`)
    const label = r.prefs.engine === 'kokoro'
      ? `Kokoro 音色：${KOKORO_VOICES.find((v) => v.id === r.prefs.voice)?.name ?? r.prefs.voice}`
      : r.prefs.engine === 'edge'
        ? `Edge 音色：${EDGE_VOICES.find((v) => v.id === r.prefs.voice)?.name ?? r.prefs.voice}`
        : r.prefs.engine === 'breeze'
          ? 'Breezeblue 克隆音色'
          : '本机 SAPI（慧慧）'
    return {
      ok: true,
      prefs: r.prefs,
      kokoro: await kokoroAvailability(),
      edge: await edgeTtsAvailability(),
      breeze: breezeAvailability(),
      tts: await ttsAvailability(),
      message: r.prefs.engine === 'sapi' ? '已切到本机 SAPI（慧慧）' : `已切到 ${label}`,
    }
  }

  /** 删掉语音库里的一个音频（只接受文件名，挡目录穿越）。 */
  async function deleteVoice(body) {
    const name = String(body?.name ?? '').trim()
    if (name === '') return { ok: false, httpStatus: 400, message: 'name 不能为空' }
    const base = path.basename(name)
    if (base !== name) return { ok: false, httpStatus: 400, message: '只接受文件名，不接受路径' }
    if (!isVoiceFile(base)) return { ok: false, httpStatus: 400, message: `不是音频文件：${base}` }
    const file = path.join(voiceDir(), base)
    try {
      fs.unlinkSync(file)
    } catch (error) {
      return { ok: false, httpStatus: 404, message: `删不掉 ${base}：${error?.message ?? error}` }
    }
    log(`删除语音：${base}`)
    return { ok: true, name: base }
  }

  /** 把语音库里的某个音频发到指定会话（操作者通道，试听用）。 */
  async function sendVoiceNow(body) {
    const name = String(body?.name ?? '').trim()
    const key = String(body?.key ?? '').trim()
    if (name === '') return { ok: false, httpStatus: 400, message: 'name 不能为空' }
    if (key === '') return { ok: false, httpStatus: 400, message: 'key 不能为空（group:群号 或 private:QQ号）' }
    const base = path.basename(name)
    if (base !== name) return { ok: false, httpStatus: 400, message: '只接受文件名，不接受路径' }
    // 删（deleteVoice）有扩展名白名单，发却没有 —— 两边准入必须一致，
    // 否则「发一个 README.md」会一路送到桥接才失败，报错还离现场很远。
    if (!isVoiceFile(base)) return { ok: false, httpStatus: 400, message: `不是音频文件：${base}` }
    const payload = { target: key, file: path.join(voiceDir(), base) }
    // volume / loudness 是桥接侧 ffmpeg 的参数入口，不校验类型就会把对象、超大数
    // 一路送过去（桥接的 resolveAudioProcessing 会抛，但错误在远端、文案也不好读）。
    // 桥接口径：volume 是 0.1~4 的倍数，或 "3dB" 这种分贝字符串；loudness 是
    // quiet / normal / loud，或 -40~-5 的 LUFS 数字（见 voice-core.js）。
    if (body?.volume !== undefined) {
      const raw = body.volume
      const asNumber = typeof raw === 'number' ? raw : Number.NaN
      const asText = typeof raw === 'string' ? raw.trim() : ''
      const dbOk = /^[+-]?\d+(?:\.\d+)?\s*(?:db)?$/i.test(asText)
      if (!(Number.isFinite(asNumber) && asNumber >= 0.1 && asNumber <= 4) && !dbOk) {
        return { ok: false, httpStatus: 400, message: 'volume 必须是 0.1~4 的倍数，或 "3dB" 这样的分贝字符串' }
      }
      payload.volume = raw
    }
    if (body?.loudness !== undefined) {
      const raw = body.loudness
      const asKey = typeof raw === 'string' ? raw.trim() : ''
      const asNumber = typeof raw === 'number' ? raw : Number.NaN
      const keyOk = ['quiet', 'normal', 'loud'].includes(asKey)
      const numOk = Number.isFinite(asNumber) && asNumber >= -40 && asNumber <= -5
      if (!keyOk && !numOk) {
        return { ok: false, httpStatus: 400, message: 'loudness 必须是 quiet / normal / loud，或 -40~-5 的 LUFS 数字' }
      }
      payload.loudness = raw
    }
    // dryRun：桥接只做格式/时长/白名单校验并把结果回给我们，一条都不真发。
    // 界面上「先验一下」用它 —— 改错了参数不该先往群里扔一条语音才知道。
    if (body?.dryRun === true) payload.dryRun = true
    const r = await callBridge('POST', '/api/voice/send', payload, 90000)
    if (!r.ok) {
      const up = Number(r.httpStatus) || 0
      const bj = r.json ?? {}
      return {
        ok: false,
        httpStatus: up >= 400 ? up : 502,
        message: String(bj.error ?? bj.message ?? r.error ?? '桥接没回话'),
      }
    }
    if (body?.dryRun === true) {
      const info = r.json ?? {}
      return {
        ok: true,
        dryRun: true,
        name: base,
        key,
        bytes: info.bytes,
        duration: info.duration,
        codec: info.codec,
        detail: info.detail,
        warnings: info.warnings ?? [],
        message: `检查通过：${info.detail ?? `${info.bytes} 字节`}（没有真的发出）`,
      }
    }
    return { ok: true, name: base, key, result: r.json ?? null, message: `已发出：${base}` }
  }

  /**
   * 语音与记忆的现状说明 —— 用户看到截图里小鲸鱼说「记忆是空的」「语音那栏还是关着的」，
   * 想知道到底为什么、缺什么。这一节只回答这两个问题，不提供任何开关。
   *
   * 记忆的关键事实：它不是 DSH 的跨会话记忆，而是**按会话 key** 存在
   * `state/social-v2.json` 里的三块（进行中的话题 / 想说还没说的 / 对群友的印象）。
   * 换一个会话就是另一份，所以「换成新会话就是新的空壳」是设计如此，不是坏了。
   */
  async function getCapabilities() {
    const voice = await getVoice()
    const conf = cfg()
    const memoryOn = conf?.socialV2?.tools?.memory === true
    const socialV2File = path.join(bridgeHome, 'state', 'social-v2.json')
    let sessions = 0
    let topics = 0
    let thoughts = 0
    let impressions = 0
    let activity = 0
    let fileAt = null
    try {
      const st = fs.statSync(socialV2File)
      fileAt = st.mtimeMs
      // 必须和 readJsonFile 一样先剥 BOM：编辑器给 social-v2.json 加上 BOM 时，
      // 这里会抛错并被下面的 catch 吞掉，面板的「记忆」一行静默变成「还是空的」，
  // 把排查引到「桥接没存」上（实际文件里是有内容的）。
      const raw = JSON.parse(fs.readFileSync(socialV2File, 'utf8').replace(/^\uFEFF/, ''))
      const convs = raw?.conversations && typeof raw.conversations === 'object' ? raw.conversations : {}
      for (const key of Object.keys(convs)) {
        const st1 = convs[key]
        if (!st1 || typeof st1 !== 'object') continue
        const t = Array.isArray(st1.activeTopics) ? st1.activeTopics.length : 0
        const p = Array.isArray(st1.pendingThoughts) ? st1.pendingThoughts.length : 0
        const m = st1.memberImpressions && typeof st1.memberImpressions === 'object' ? Object.keys(st1.memberImpressions).length : 0
        // memberActivity 是桥接自动维护的（模型不写记忆也有），算进「有记忆」的证据里。
        const a = st1.memberActivity && typeof st1.memberActivity === 'object' ? Object.keys(st1.memberActivity).length : 0
        if (t + p + m + a > 0) sessions += 1
        topics += t
        thoughts += p
        impressions += m
        activity += a
      }
    } catch {
      /* 文件不存在或坏了：按 0 报，界面会显示「还没写过」 */
    }
    return {
      ok: true,
      voice,
      memory: {
        enabled: memoryOn,
        file: socialV2File,
        fileAt,
        // 「有记忆」的最小证据：文件里真的有非空条目。空文件 ≠ 有记忆。
        hasAny: topics + thoughts + impressions + activity > 0,
        sessions,
        activeTopics: topics,
        pendingThoughts: thoughts,
        memberImpressions: impressions,
        memberActivity: activity,
        scope: 'per-session',
        scopeNote:
          '按会话 key 存在 state/social-v2.json 里，不是 DSH 的跨会话记忆。换一个会话（或新建会话）就是另一份，' +
          '所以「换成新会话就是新的空壳」是设计如此。要跨会话记住，得靠 DSH 那边的记忆模块挂到跨会话存储上，' +
          '桥接这边管不到。',
        categories: [
          { id: 'activeTopic', name: '进行中的话题', count: topics },
          { id: 'pendingThought', name: '想说但还没说的', count: thoughts },
          { id: 'memberImpression', name: '对群友的印象', count: impressions },
          { id: 'memberActivity', name: '最近谁在说话', count: activity },
        ],
      },
    }
  }

  /**
   * 把桥接给的 `url` 换成浏览器真能加载的地址。
   *
   * 为什么必须有这一步（2026-11-05 真机抓到的裂图）：AI 入库的表情在桥接里存的是
   * `url: D:\qq-bridge\state\stickers\ai-xxx.svg` —— 一个**本机绝对路径**。浏览器把
   * `D:\...` 当相对地址拼到页面 origin 后面，`<img src>` 必然裂图（截图上就是那个破图标）。
   * 面板自己开一条只读通道 `GET /sticker-file?name=` 按文件名把字节发出去，顺带挡掉
   * 目录穿越（只认 basename、只认 state/stickers 下真实存在的文件）。
   *
   * QQ 侧同步来的表情是 http(s) 地址，原样保留；认不出的（空、相对路径、不存在的文件）
   * 返回空串，让界面显示「没有预览地址」而不是一个破图标。
   */
  function stickerUrl(raw) {
    const text = String(raw ?? '').trim()
    if (text === '') return ''
    if (/^https?:\/\//i.test(text)) return text
    // data: 只放行图片。理论上 <img src="data:text/html,..."> 不会执行脚本，
    // 但给一个只读通道留任意 data URI 是没必要的口子 —— 桥接也从不产生非图片的。
    if (/^data:image\//i.test(text)) return text
    if (!/^[a-zA-Z]:[\\/]/.test(text) && !text.startsWith('/') && !text.startsWith('\\\\')) return ''
    const name = path.basename(text)
    if (!Object.hasOwn(STICKER_MIME, path.extname(name).toLowerCase())) return ''
    try {
      if (!fs.statSync(path.join(stickerImageDir(), name)).isFile()) return ''
    } catch {
      return ''
    }
    return `${API}/sticker-file?name=${encodeURIComponent(name)}`
  }

  function decorateStickers(list) {
    return (Array.isArray(list) ? list : []).map((s) => {
      const url = stickerUrl(s?.url)
      return {
        ...s,
        url,
        // 图片文件已经不在 state/stickers 里（被删了 / 从 QQ 侧撤了）时 url 会是空串。
        // 界面靠这个标记把这些「只剩一条记录、图已经没了」的项挑出去 ——
        // 不给它们画「没有预览地址」的占位格子，那既占地方又没用。
        hasPreview: url !== '',
      }
    })
  }

  /** 读表情库。优先走后端接口（能拿到 QQ 侧最新同步结果），失败则直接读盘。 */
  async function listStickers(body) {
    const query = String(body?.query ?? '').trim()
    const count = clampInt(body?.count, 1, 500, 100)
    const qs = new URLSearchParams()
    if (query !== '') qs.set('query', query)
    qs.set('count', String(count))
    const res = await callBridge('GET', `/api/stickers?${qs.toString()}`, undefined, 6000)
    if (res.ok && res.json?.ok) {
      return {
        ok: true,
        source: 'bridge',
        file: stickerFile(),
        dir: stickerDir(),
        writable: res.json.writable !== false,
        total: Number(res.json.total) || 0,
        matched: Number(res.json.matched) || 0,
        truncated: res.json.truncated === true,
        syncedAt: res.json.syncedAt ?? null,
        fromCache: res.json.fromCache === true,
        stickers: decorateStickers(res.json.stickers),
      }
    }
    // 后端不可达：直接读盘，界面至少能看见「有多少张、文件在哪」。
    const entries = readStickerEntries()
    const needle = query.toLowerCase()
    const matched = needle === ''
      ? entries
      : entries.filter((e) => `${e.desc} ${e.localNote} ${e.tags.join(' ')}`.toLowerCase().includes(needle))
    return {
      ok: true,
      source: 'file',
      file: stickerFile(),
      dir: stickerDir(),
      writable: entries !== null,
      total: entries.length,
      matched: matched.length,
      truncated: matched.length > count,
      syncedAt: null,
      fromCache: true,
      stickers: decorateStickers(matched.slice(0, count)),
      message: res.ok ? '桥接回了意外结果，改读本地文件' : `桥接不可达，读的是本地文件（${describeBridgeFailure(res)}）`,
    }
  }

  /** 直接读 stickers.json；文件不存在或坏了返回空数组（不返回 null 让调用方少一层判断）。 */  function readStickerEntries() {
    const raw = readJsonFile(stickerFile())
    if (Array.isArray(raw)) return raw
    if (Array.isArray(raw?.stickers)) return raw.stickers
    if (raw !== null && typeof raw === 'object') {
      const values = Object.values(raw).filter((v) => v !== null && typeof v === 'object' && typeof v.id === 'string')
      return values
    }
    return []
  }

  /** 给某个表情写备注/标签/用法 —— 这是 AI 看图后唯一能留下的东西。 */
  async function setStickerNote(body) {
    const stickerId = String(body?.stickerId ?? '').trim()
    if (stickerId === '') return { ok: false, httpStatus: 400, message: 'stickerId 不能为空' }
    const payload = { stickerId }
    if (body?.note !== undefined) payload.note = String(body.note).slice(0, 200)
    if (body?.tags !== undefined) {
      payload.tags = Array.isArray(body.tags)
        ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
        : String(body.tags).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 20)
    }
    if (body?.usage !== undefined) payload.usage = String(body.usage).slice(0, 200)
    const res = await callBridge('POST', '/api/stickers/note', payload, 8000)
    if (!res.ok) return bridgeFailure(res)
    return { ok: true, sticker: res.json?.sticker ?? null }
  }

  /** 强制从 QQ 侧同步一次收藏表情（写操作，只有用户点按钮时才做）。 */
  async function syncStickers() {
    const res = await callBridge('POST', '/api/stickers/sync', {}, 20000)
    if (!res.ok) return bridgeFailure(res, '同步失败')
    return { ok: true, total: Number(res.json?.total) || 0, syncedAt: res.json?.syncedAt ?? null }
  }

  /**
   * 清掉「记录还在、图片已经没了」的死条目。
   *
   * 必须由桥接改（内存副本是权威），面板只负责发号施令 —— 外部直接删 stickers.json
   * 里的行，下一次同步就整体覆盖回来。
   */
  async function pruneStickers() {
    const r = await callBridge('POST', '/api/stickers/prune', {}, 10000)
    if (!r.ok) return bridgeFailure(r, '清理失败')
    return { ok: true, removed: Number(r.json?.removed) || 0, total: Number(r.json?.total) || 0 }
  }

  /**
   * 从本地表情库移除一张。
   *
   * 「只从本地库移除，不动 QQ 账号收藏」是刻意的：桥接有 modify_custom_face 但那是改
   * 备注，删 QQ 收藏得调 delete_custom_face，而误删收藏比误删本地记录难挽回得多。
   * 删完顺手清一次死条目 —— 一次操作把该收拾的都收拾了，界面不用再挂占位。
   */
  async function removeSticker(body) {
    const stickerId = String(body?.stickerId ?? '').trim()
    if (stickerId === '') return { ok: false, httpStatus: 400, message: 'stickerId 不能为空' }
    const r = await callBridge('POST', '/api/stickers/remove', { stickerId }, 10000)
    if (!r.ok) return bridgeFailure(r, '删除失败')
    // 注意别把 prune 的数字当成「删了几张」：删掉的那一张由 remove 自己报，
    // prune 报的是「顺带清掉多少条图片已不在的死记录」。两者混用会让界面显示
    // 「removed:0」但其实真的删成功了（这个坑踩过一次）。
    const removed = Number(r.json?.removed) || 0
    const pruned = await pruneStickers()
    return {
      ok: true,
      stickerId,
      removed,
      pruned: pruned.removed ?? 0,
      total: pruned.total ?? (Number(r.json?.total) || 0),
    }
  }

  /**
   * 扫描本地表情目录（`state/stickers`），并**把新出现的文件收进库**。
   *
   * 这是用户要的「自动刷新读取本地表情包存储文件」：管理员直接把图片丢进目录，
   * 面板发现新文件就调桥接的 `POST /api/stickers/add` 入库；下一次刷新 AI 就能挑到它。
   *
   * 为什么必须经桥接入库（而不是面板自己写 stickers.json）：桥接把表情库存成进程内存
   * 里的 `stickerEntries`，任何一次 sync / 写备注都会把内存整体覆盖回盘 —— 外部进程
   * 写的条目下一次同步就被抹掉（这条踩过）。
   *
   * 只认「桥接没见过的文件名」：已在库里的不动（避免把用户手写的备注覆盖掉）。
   */
  async function scanStickerDir(body) {
    // 默认**不入库**：直接调这个接口传 {} 时如果默认 true，就会把目录里所有
    // 未登记文件一次性写进表情库 —— 正是 readJsonBody 那节反复强调的
    // 「缺省输入被执行成破坏性动作」。界面始终显式传 adopt（client 的 loadScan）。
    const adopt = body?.adopt === true
    const dir = stickerImageDir()
    let names = []
    try {
      names = fs.readdirSync(dir).filter((n) => Object.hasOwn(STICKER_MIME, path.extname(n).toLowerCase()))
    } catch (error) {
      return {
        ok: true,
        dir,
        total: 0,
        files: [],
        adopted: [],
        skipped: [],
        message: `读不到目录：${error?.message ?? error}`,
      }
    }

    // 已在库里的文件名（库里存的是绝对路径，取 basename 比对）。
    const known = new Set()
    for (const entry of readStickerEntries()) {
      const p = String(entry?.url ?? entry?.file ?? '')
      if (p !== '') known.add(path.basename(p))
    }

    const files = []
    for (const name of names) {
      const file = path.join(dir, name)
      let stat = null
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      files.push({ name, bytes: stat.size, at: stat.mtimeMs, inLibrary: known.has(name) })
    }
    files.sort((a, b) => b.at - a.at)

    const fresh = files.filter((f) => !f.inLibrary)
    const adopted = []
    const skipped = []
    if (adopt && fresh.length > 0) {
      for (const f of fresh) {
        // 文件名形如 ai-<情绪>-<hex>[-<配字>].svg 时，把「配字」当备注名；
        // 其它（管理员自己丢进来的图）用文件名本身。
        const parsed = /^ai-([a-z]+)-[0-9a-f]+(?:-(.+))?\.svg$/i.exec(f.name)
        const caption = parsed && parsed[2] ? parsed[2] : ''
        const desc = caption !== '' ? caption : path.basename(f.name, path.extname(f.name))
        const res = await callBridge('POST', '/api/stickers/add', {
          file: f.name,
          desc,
          note: desc,
          tags: ['local'],
        }, 10000)
        if (res.ok && res.json?.ok !== false) {
          adopted.push(f.name)
          f.inLibrary = true
          log(`自动入库：${f.name}（${res.json?.replaced ? '更新' : '新增'}）`)
        } else {
          skipped.push({ name: f.name, reason: res.json?.error ?? describeBridgeFailure(res) })
        }
      }
      if (adopted.length > 0) {
        watchdog.pushLog(`本地目录新增 ${adopted.length} 张，已入库`)
        watchdog.save()
      }
    }

    return {
      ok: true,
      dir,
      total: files.length,
      files,
      adopted,
      skipped,
      adoptedTotal: adopted.length,
      // 目录里有、库里没有的：adopt=false 时不入库，只报个数让界面提示。
      pending: files.filter((f) => !f.inLibrary).length,
      scanAt: Date.now(),
    }
  }

  /**
   * 把 `state/stickers` 下的某个文件按原始字节发出去（只读、只认纯文件名）。
   *
   * 存在的唯一理由：桥接给 AI 表情的 `url` 是本机绝对路径，浏览器加载不了。
   * 安全边界与 `addLocalStickerV2` 一致 —— 只认 basename、只认该目录下的真实文件，
   * 因此不可能被 `..%2f` 之类绕出去。
   */
  function sendStickerFile(req, res, url) {
    const raw = String(url.searchParams.get('name') ?? '').trim()
    const name = path.basename(raw)
    const ext = path.extname(name).toLowerCase()
    const mime = STICKER_MIME[ext]
    if (name !== raw || raw === '' || mime === undefined) {
      sendJson(res, { ok: false, message: '只接受 state/stickers 下的图片文件名' }, 400)
      return
    }
    const data = readInsideDir(stickerImageDir(), name)
    if (data === null) {
      sendJson(res, { ok: false, message: `找不到图片：${name}` }, 404)
      return
    }
    try {
      res.statusCode = 200
      res.setHeader('content-type', mime)
      // no-store：管理员随时可能替换同名文件，缓存住会一直看到旧图。
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-length', String(data.length))
      res.end(data)
    } catch {
      /* 连接可能已经断了 */
    }
  }

  /**
   * 语音字节通道 —— 同名 no-cache 的 /sticker-file 的音频版。
   *
   * 为什么必须有它：语音库在 `D:\qq-bridge\audio`，浏览器拿不到本机路径；
   * 界面上的 `<audio src>` 必须指回面板自己。只认 basename + 白名单扩展名，
   * 目录穿越在这里被挡掉（`..%2Fconfig.json` → 400）。
   */
  function sendVoiceFile(req, res, url) {
    const raw = String(url.searchParams.get('name') ?? '').trim()
    const name = path.basename(raw)
    if (name !== raw || raw === '' || !isVoiceFile(name)) {
      sendJson(res, { ok: false, message: '只接受语音库里的音频文件名' }, 400)
      return
    }
    const data = readInsideDir(voiceDir(), name)
    if (data === null) {
      sendJson(res, { ok: false, message: `找不到音频：${name}` }, 404)
      return
    }
    const ext = path.extname(name).toLowerCase()
    const mime = ext === '.wav' ? 'audio/wav'
      : ext === '.mp3' ? 'audio/mpeg'
        : ext === '.ogg' || ext === '.oga' || ext === '.opus' ? 'audio/ogg'
          : ext === '.m4a' || ext === '.aac' ? 'audio/mp4'
            : ext === '.flac' ? 'audio/flac'
              : 'application/octet-stream'
    try {
      res.statusCode = 200
      res.setHeader('content-type', mime)
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-length', String(data.length))
      // 界面上要拖进度条试听，浏览器对 audio 有 range 请求；这里不做分段，
      // 但明确宣告接受 range 会让播放器等分段响应。老实用 no-store + 完整响应。
      res.end(data)
    } catch {
      /* 连接可能已经断了 */
    }
  }

  // ── 会话管理（白名单）────────────────────────────────────────────────────
  //
  // 关键事实：bridge 的 `allow.private` / `allow.groups` **没有 HTTP 写接口**，
  // 只在 `loadConfig()`（bridge.js:1478）里读一次，之后没有热加载。
  // 所以这里直接改 `config.json`，并如实告诉用户「要重启桥接才生效」——
  // 与其编一个假的「已生效」，不如把这一层代价摆在界面上。
  async function getSessions() {
    const conf = cfg() ?? {}
    const allow = conf.allow ?? {}
    const groups = toStringList(allow.groups)
    const privateList = toStringList(allow.private)
    const ownerQQ = String(conf.ownerQQ ?? '').trim()
    // 会话状态（未读、唤醒次数）只有后端知道；拿不到就给空数组，界面自己降级。
    const statesRes = await callBridge('GET', '/api/socialV2/states', undefined, 5000)
    const live = new Map()
    if (statesRes.ok && Array.isArray(statesRes.json?.conversations)) {
      for (const row of statesRes.json.conversations) {
        if (row !== null && typeof row.key === 'string') live.set(row.key, row)
      }
    }
    const decorate = (key, id, kind) => {
      const row = live.get(key) ?? null
      return {
        key,
        kind,
        id,
        unread: Number(row?.unreadCount) || 0,
        recentCount: Number(row?.recentCount) || 0,
        wakeCount: Number(row?.wakeConfig?.wakeCount) || 0,
        lastWakeReason: row?.lastWakeReason ?? null,
        wakeMode: row?.wakeConfig?.mode ?? null,
        hasState: row !== null,
      }
    }
    return {
      ok: true,
      file: path.join(bridgeHome, 'config.json'),
      needsRestart: false,
      ownerQQ,
      groups: groups.map((id) => decorate(`group:${id}`, id, 'group')),
      private: privateList.map((id) => decorate(`private:${id}`, id, 'private')),
      knownSessions: [...live.keys()],
    }
  }

  /**
   * 改白名单。整段覆盖而不是增量 add/remove：
   * 界面把完整的群/好友列表提交上来，这里只做校验和去重，
   * 增量操作在「多端同时改」时会把别处的改动悄悄抹掉。
   */
  async function setSessions(body) {
    // groups/private 缺省时退回 config.json 现有值，而不是清空白名单 —— 空 body
    // 直接写会把你辛辛苦苦配的群/私聊白名单全抹掉（黑盒测试 2026-11-06 抓到）。
    // 类型也要卡住：传 `groups: {}` / `groups: 123` 时 toStringList 会得到空数组，
    // 那等于「传了字段但清空」，同样不该发生。
    for (const field of ['groups', 'private']) {
      const v = body?.[field]
      if (v !== undefined && !Array.isArray(v) && typeof v !== 'string') {
        return { ok: false, httpStatus: 400, message: `${field} 必须是数组或逗号分隔的字符串` }
      }
    }
    const conf = readBridgeConfig(bridgeHome)
    if (conf === null) return { ok: false, httpStatus: 500, message: `读不到 ${path.join(bridgeHome, 'config.json')}` }
    const existingGroups = toStringList(conf?.allow?.groups)
    const existingPrivate = toStringList(conf?.allow?.private)
    const hasGroups = body?.groups !== undefined
    const hasPrivate = body?.private !== undefined
    const groups = hasGroups ? toStringList(body.groups) : existingGroups
    const privateList = hasPrivate ? toStringList(body.private) : existingPrivate
    for (const id of [...groups, ...privateList]) {
      if (!/^\d{5,20}$/.test(id)) return { ok: false, httpStatus: 400, message: `QQ 号/群号不合法：${id}（应为 5~20 位数字）` }
    }
    const file = path.join(bridgeHome, 'config.json')
    const next = { ...conf, allow: { ...(conf.allow ?? {}), groups, private: privateList } }
    try {
      const text = `${JSON.stringify(next, null, 2)}\n`
      // 先写临时文件再 rename：中途失败不会留下半个 config.json（bridge 起不来）。
      // 临时名必须含随机段：同一进程里两个并发 /sessions 请求用同一个 tmp 时，
      // A 写完、B 覆盖、A rename 成功、B rename 拿 ENOENT —— 或者更糟：
      // 落盘的是「A 校验通过、B 的内容」。
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `写 ${file} 失败：${error?.message ?? error}` }
    }
    log(`会话白名单已更新：群 ${groups.length} 个、私聊 ${privateList.length} 个（需重启桥接生效）`)
    return {
      ok: true,
      needsRestart: true,
      message: '已写入 config.json。桥接只在启动时读它，点「一键拉起」重启后生效。',
      groups,
      private: privateList,
    }
  }

  // ── 角色（人格）管理 ─────────────────────────────────────────────────────
  //
  // 这层几乎是纯转发：bridge 已经有完整 CRUD(/api/roles/create|update|rename|delete|content)。
  // 不在插件里重写一遍校验，是为了让「面板写的」和「控制台写的」走同一套规则 ——
  // 两份校验一旦分叉，症状是「控制台能保存、面板报错」，最难查。
  async function getRoles() {
    const res = await callBridge('GET', '/api/roles', undefined, 6000)
    if (!res.ok) {
      return { ok: false, httpStatus: 200, bridgeDown: true, message: `桥接不可达：${describeBridgeFailure(res)}`, roles: [], summaries: [], current: null, limits: null }
    }
    const json = res.json ?? {}
    return {
      ok: true,
      file: path.join(bridgeHome, 'roles'),
      roles: Array.isArray(json.roles) ? json.roles : [],
      summaries: Array.isArray(json.summaries) ? json.summaries : [],
      current: json.current ?? null,
      limits: json.limits ?? null,
    }
  }

  // 注意：路由把整个 body 传进来，不是单个字段 —— 早先写成 getRoleContent(name) 时，
  // String(name) 得到的是 "[object Object]"，桥接就会去找一份叫这个名字的人格。
  async function getRoleContent(body) {
    const role = String(body?.name ?? '').trim()
    if (role === '') return { ok: false, httpStatus: 400, message: 'name 不能为空' }
    const res = await callBridge('GET', `/api/roles/content?name=${encodeURIComponent(role)}`, undefined, 8000)
    if (!res.ok) return bridgeFailure(res)
    return { ok: true, ...(res.json ?? {}) }
  }

  async function saveRole(body) {
    const name = String(body?.name ?? '').trim()
    const content = typeof body?.content === 'string' ? body.content : ''
    const mode = String(body?.mode ?? 'update')
    if (name === '') return { ok: false, httpStatus: 400, message: '名字不能为空' }
    if (content.trim() === '') return { ok: false, httpStatus: 400, message: '正文不能为空' }
    const pathname = mode === 'create' ? '/api/roles/create' : '/api/roles/update'
    const res = await callBridge('POST', pathname, { name, content }, 12000)
    if (!res.ok) return bridgeFailure(res)
    return { ok: true, role: res.json?.role ?? name, chars: res.json?.chars ?? content.length, warnings: res.json?.warnings ?? [], created: mode === 'create' }
  }

  async function renameRole(body) {
    const from = String(body?.from ?? '').trim()
    const to = String(body?.to ?? '').trim()
    if (from === '' || to === '') return { ok: false, httpStatus: 400, message: 'from / to 都不能为空' }
    const res = await callBridge('POST', '/api/roles/rename', { from, to }, 10000)
    if (!res.ok) return bridgeFailure(res)
    return { ok: true, ...(res.json ?? {}) }
  }

  async function deleteRole(body) {
    const name = String(body?.name ?? '').trim()
    if (name === '') return { ok: false, httpStatus: 400, message: 'name 不能为空' }
    const res = await callBridge('POST', '/api/roles/delete', { name }, 10000)
    if (!res.ok) return bridgeFailure(res)
    return { ok: true, ...(res.json ?? {}) }
  }

  async function activateRole(body) {
    // 区分「没传 role 字段」（拒绝）与「显式 role:null」（清除人格）—— 空 body
    // 不该静默清掉当前人格（黑盒测试 2026-11-06 抓到）。client 的「清除当前人格」
    // 按钮发 {role:null}，这里只认显式 null。
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'role')) {
      return { ok: false, httpStatus: 400, message: 'role 字段必须显式给出（字符串=启用 / null=清除当前人格）' }
    }
    const role = body.role === null ? '' : String(body.role ?? '').trim()
    const res = await callBridge('POST', '/api/role', role === '' ? {} : { role }, 8000)
    if (!res.ok) return bridgeFailure(res)
    return { ok: true, role: res.json?.role ?? (role === '' ? null : role) }
  }

  // ── 眼睛：看 QQ 里的一切 ─────────────────────────────────────────────────
  //
  // 「能看到一切」在实现上是四件事：知道有哪些会话（states）、读某个会话的最近
  // 消息（recent）、翻群历史（group-history）、以及取消息里的图（images/message）。
  // 前三个是文本，最后一个是真正的「眼睛」—— 图片要能落到界面上让人点开看。
  //
  // 注意：这些接口在 bridge 侧对 agent token 有模式与白名单限制，但控制台令牌
  // （我们用的这个）是管理端，读得到；所以「眼睛」本质上是「人借面板的视角看」，
  // 不是让 AI 绕开自己的会话隔离。这一点在界面上要写清楚。
  async function getEyes(body) {
    const key = String(body?.key ?? '').trim()
    const limit = clampInt(body?.limit, 1, 100, 30)
    const offset = clampInt(body?.offset, 0, 10000, 0)
    const statesRes = await callBridge('GET', '/api/socialV2/states', undefined, 6000)
    const conversations = statesRes.ok && Array.isArray(statesRes.json?.conversations)
      ? statesRes.json.conversations.map((row) => ({
          key: row.key,
          unread: Number(row.unreadCount) || 0,
          recentCount: Number(row.recentCount) || 0,
          wakeCount: Number(row.wakeConfig?.wakeCount) || 0,
          wakeMode: row.wakeConfig?.mode ?? null,
          lastWakeReason: row.lastWakeReason ?? null,
          lastAiReplyAt: Number(row.lastAiReplyAt) || 0,
          confirmedBy: row.wakeConfig?.confirmedBy ?? null,
        }))
      : []
    let messages = []
    let messageError = null
    if (key !== '') {
      // 群消息优先翻完整历史（group-history 能回到更早），私聊只能看内存里的 recent。
      const isGroup = key.startsWith('group:')
      if (isGroup) {
        const res = await callBridge('GET', `/api/socialV2/group-history?key=${encodeURIComponent(key)}&count=${limit}`, undefined, 12000)
        if (res.ok && res.json?.ok) {
          messages = normalizeEyesMessages(res.json.messages ?? res.json.list ?? [], key)
        } else {
          messageError = describeBridgeFailure(res)
        }
      }
      if (messages.length === 0) {
        const res = await callBridge('GET', `/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit}&offset=${offset}`, undefined, 8000)
        if (res.ok && res.json?.ok) {
          messages = normalizeEyesMessages(res.json.messages ?? [], key)
        } else if (messageError === null) {
          messageError = describeBridgeFailure(res)
        }
      }
    }
    return {
      ok: true,
      bridgeDown: !statesRes.ok,
      message: statesRes.ok ? '' : `桥接不可达：${describeBridgeFailure(statesRes)}`,
      conversations,
      key,
      messages,
      messageError,
      limits: { limit, offset },
    }
  }

  /**
   * 统一不同接口返回的消息形状。
   * group-history / recent 两个接口的字段并不完全一样（history 带 messageId/userId），
   * 界面只想拿到一套字段，所以在边界上一次性抹平。
   */
  function normalizeEyesMessages(rows, key) {
    if (!Array.isArray(rows)) return []
    return rows.map((row, index) => {
      const images = Array.isArray(row?.images) ? row.images : []
      const hasImage = images.length > 0 || row?.hasMedia === true || row?.hasImage === true
      return {
        index,
        key,
        messageId: row?.messageId ?? row?.id ?? row?.seq ?? null,
        sender: String(row?.sender ?? row?.nickname ?? row?.card ?? row?.userId ?? ''),
        text: String(row?.text ?? row?.plain ?? ''),
        time: Number(row?.time ?? row?.t) || 0,
        isSelf: row?.isSelf === true,
        isOwner: row?.isOwner === true,
        hasImage,
        imageCount: images.length,
        images: images.slice(0, 4).map((img) => ({
          url: String(img?.url ?? img?.file ?? ''),
          summary: String(img?.summary ?? img?.subType ?? ''),
        })),
      }
    })
  }

  /** 取某条消息里的图 —— 返回 base64 data URL，界面可以直接 <img src> 显示。 */
  async function getMessageImages(body) {
    const key = String(body?.key ?? '').trim()
    const messageId = String(body?.messageId ?? '').trim()
    if (key === '' || messageId === '') return { ok: false, httpStatus: 400, message: 'key 与 messageId 都不能为空' }
    const res = await callBridge(
      'GET',
      `/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(messageId)}`,
      undefined,
      20000,
    )
    if (!res.ok) return bridgeFailure(res, '取图失败')
    return { ok: true, ...(res.json ?? {}) }
  }

  // ── 看护循环 ───────────────────────────────────────────────────────────
  let loopTimer = null
  let firstTickTimer = null
  let probing = false
  function restartLoop() {
    if (loopTimer !== null) clearInterval(loopTimer)
    if (firstTickTimer !== null) clearTimeout(firstTickTimer)
    const tick = async () => {
      if (probing) return
      probing = true
      try {
        await probe()
      } catch (error) {
        log(`探活抛错：${error?.message ?? error}`)
      } finally {
        probing = false
      }
    }
    loopTimer = setInterval(tick, watchdog.state.probeMs)
    if (typeof loopTimer.unref === 'function') loopTimer.unref()
    // 装载后先探一次，界面一打开就有真实状态，不用等一个周期。
    // 这个一次性定时器也要存下来并在卸载时清掉：热重载会反复执行 apply，
    // 不清的话每重载一次就多留下一个待触发的探活。
    firstTickTimer = setTimeout(tick, 1200)
    if (typeof firstTickTimer.unref === 'function') firstTickTimer.unref()
  }

  ctx.effect(() => {
    restartLoop()
    return () => {
      if (loopTimer !== null) clearInterval(loopTimer)
      loopTimer = null
      if (firstTickTimer !== null) clearTimeout(firstTickTimer)
      firstTickTimer = null
      // 这里曾经调 watchdog.clearTimer()，但 clearTimer 清的是 setTimer() 设的句柄，
      // 而全文件没有任何地方调 setTimer —— 那行是空操作，却让人以为「定时器都收干净了」。
      // 真正要清的 loopTimer / firstTickTimer 就在上面两行，别再加回来。
      // Kokoro 常驻进程必须收掉：它占 400~600MB，热重载几次就会堆出好几个。
      // 这里的 kill 是安全的 —— 它只在两次合成之间空闲，不像启动脚本那样有半途状态。
      kokoroKill()
      // 特意**不**杀正在跑的启动脚本：dsh-unlag 热重载会卸载这个模块，
      // 若此时脚本正跑到一半被砍掉，SnowLuma / bridge 会停在半启动状态，
      // 比让它跑完更糟。脚本自己用 WMI 拉起服务，跟这个模块的生死无关；
      // 运行状态（run）不持久化，重载后面板会显示「没在跑」，这是可接受的偏差。
      if (watchdog.state.run.running) log('插件卸载：启动脚本仍在跑，让它自己跑完')
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 卸载期的失败不必吵 */
        }
      }
    }
  })
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────
function sendJson(res, obj, status = 200) {
  try {
    const text = JSON.stringify(obj ?? { ok: false })
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(text)
  } catch {
    try {
      res.statusCode = 500
      res.end('{"ok":false}')
    } catch {
      /* 连接可能已经断了 */
    }
  }
}

/**
 * 读请求体。**正常的空 body 与「读坏了」必须区分开**。
 *
 * 早先这里把三种情况统统 resolve 成 `{}`：超长、JSON 畸形、连接出错。后果是读坏的
 * body 与「真的没传字段」长得一模一样，于是任何对 `{}` 校验不严的 `setXxx` 都会把
 * 「畸形输入」执行成「清空 / 关掉」。2026-11-06 的 `/life {}` 误关生命开关、
 * `/roles/activate {}` 误清人格，都是这条链的产物。
 *
 * 现在读坏时 reject 一个 `BodyError`，路由层据此回 400 / 413，handler 根本不会被调用。
 * 超长时也不再 `req.destroy()`——那会让客户端只看到「连接被重置」，拿不到可读原因；
 * 改成把剩余字节读完再丢（上限只有 64 KiB，读完的代价可以忽略）。
 */
class BodyError extends Error {
  constructor(code, message, httpStatus) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new BodyError('too-large', '请求体太大（上限 64 KiB）', 413))
        return
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        reject(new BodyError('bad-json', '请求体不是合法 JSON', 400))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new BodyError('not-object', '请求体必须是一个 JSON 对象', 400))
        return
      }
      resolve(parsed)
    })
    req.on('error', () => reject(new BodyError('aborted', '请求体读取中断', 400)))
  })
}
