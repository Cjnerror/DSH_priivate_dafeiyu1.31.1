// qq-agent-presets —— client 半（DSH Web UI 里的「小鲸鱼」面板）
//
// 注册两处（形状照抄 dsh-roost，那是本机唯一一份能跑起来的原生面板）：
//   slots.register({name:'main', key:'qq-panel'})              → 中央整页
//   slots.register({name:'sidebar.panellist', id:'qq-panel'})  → 侧栏图标按钮
// 两个 id 相同，侧栏按钮就派发到这个 main 面板。
//
// 视觉规矩（DSH 插件文档 + 本机踩坑）：
//   · 颜色只用 --dsw-alias-* 令牌，一律带兜底；文字色是 label-primary，不是 text-primary。
//   · 根节点自己画底色 —— 滚动容器是独立合成层，不画会露出白底闪一下。
//   · 这是仪表盘，不是营销页：一屏回答「人还活着吗、花了多少、卡在哪」。
window.__ModuleLoader__.load({
  id: 'qq-agent-presets',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const inject = ['slots']
    const PANEL_ID = 'qq-panel'
    const API = '/qq-panel/api'

    // ── 请求封装 ────────────────────────────────────────────────────────
    // 状态字段一律叫 httpStatus：业务字段里已经有 status 了（桥接状态），撞名会互相覆盖。
    async function req(pathname, init) {
      let res
      try {
        res = await fetch(API + pathname, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...init,
        })
      } catch (error) {
        return { ok: false, httpStatus: 0, message: `连不上 DSH 后端：${error?.message ?? error}` }
      }
      let text = ''
      try {
        text = await res.text()
      } catch {
        text = ''
      }
      if (text.trim() === '') {
        return {
          ok: false,
          httpStatus: res.status,
          message: `插件没回内容（HTTP ${res.status}，${pathname}）—— 多半是插件没加载完，重载 DSH 再试`,
        }
      }
      try {
        const json = JSON.parse(text)
        return { httpStatus: res.status, ...json }
      } catch {
        return { ok: false, httpStatus: res.status, message: `返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` }
      }
    }

    const post = (pathname, body) =>
      req(pathname, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

    // ── 小工具 ──────────────────────────────────────────────────────────
    const MODES = [
      { id: 'reserved2', name: '二代仿真', note: 'AI 自己决定何时看、回不回（当前主力）' },
      { id: 'simulation', name: '仿真', note: 'reserved2 的旧叫法，归一成 reserved2' },
      { id: 'chat', name: '单会话', note: '一问一答，不做群聊仿真' },
      { id: 'reserved', name: '保留会话', note: '一代保留模式' },
      { id: 'closed-agent', name: '独立会话', note: '每次一个封闭会话' },
    ]

    // 顶部导航的条目。id 必须与下面各个 Sec 的 id 一一对应 ——
    // 点一下先撑开目标节再滚过去，否则滚到一个收起的节上等于没跳。
    // 「眼睛」那一节已从界面摘掉（见下面注释），这里自然也不列。
    const NAV = [
      { id: 'life', label: '生命与看护' },
      { id: 'spend', label: '花费' },
      { id: 'mode', label: '模式' },
      { id: 'media', label: '表情与语音' },
      { id: 'sessions', label: '会话' },
      { id: 'roles', label: '人格' },
    ]

    function money(symbol, value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (n === 0) return `${symbol}0`
      if (n < 0.0001) return `${symbol}${n.toExponential(2)}`
      if (n < 1) return `${symbol}${n.toFixed(4)}`
      return `${symbol}${n.toFixed(2)}`
    }

    function compact(n) {
      const v = Number(n)
      if (!Number.isFinite(v)) return '—'
      if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
      if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
      return String(Math.round(v))
    }

    function clockOf(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const d = new Date(ms + 8 * 3600 * 1000)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    }

    /** 字节数说人话：812 B / 34.5 KB / 2.1 MB。 */
    function bytesText(n) {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return '—'
      if (v < 1024) return `${Math.round(v)} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${(v / 1024 / 1024).toFixed(1)} MB`
    }

    function ago(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '从没'
      const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (sec < 60) return `${sec} 秒前`
      if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`
      return `${Math.round(sec / 3600)} 小时前`
    }

    // ── 样式 ────────────────────────────────────────────────────────────
    const CSS = `
.qqp-root{display:flex;flex-direction:column;height:100%;max-height:100vh;min-height:0;overflow:hidden;
  background:var(--dsw-alias-bg-base,#16181c);color:var(--dsw-alias-label-primary,#e7e9ee);
  --k-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));
  --k-line-soft:var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 11%,transparent));
  --k-surface:var(--dsw-alias-bg-l1,var(--dsw-alias-bg-layer-1,color-mix(in srgb,currentColor 5%,transparent)));
  --k-field:var(--dsw-alias-fill-l1,color-mix(in srgb,currentColor 7%,transparent));
  --k-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 9%,transparent));
  --k-mute:var(--dsw-alias-label-secondary,#9aa3b2);
  --k-ok:var(--dsw-alias-state-success-primary,#3fbf86);
  --k-warn:var(--dsw-alias-state-warn-primary,#e0a33a);
  --k-bad:var(--dsw-alias-state-error-primary,#e0605e);
  --k-idle:var(--dsw-alias-state-idle-primary,#8a93a4);
  --k-accent:var(--dsw-alias-brand-primary,#5b7cfa);
  font-size:13px;line-height:1.6;font-family:inherit}
.qqp-head{flex:0 0 auto;width:100%;max-width:980px;margin:0 auto;padding:14px 22px 0}
/* 标题行与导航合成一条：原来「标题 + 副标题 + 工具条」占三行，
   980px 宽下光页头就吃掉 90px，滚两下才见到第一节。 */
.qqp-title{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:600;letter-spacing:.01em}
.qqp-title svg{flex:0 0 auto;opacity:.85}
.qqp-topbar{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
/* 分段导航：app 的底部/顶部 tab 那套。六节压成一行 chip，
   点一下直接滚到那一节并展开 —— 不用上下翻找。 */
.qqp-nav{display:flex;align-items:center;gap:5px;margin:10px 0 2px;flex-wrap:wrap}
.qqp-nav-i{font-size:11.5px;padding:3px 10px;border-radius:7px;border:1px solid var(--k-line-soft);
  background:transparent;color:var(--k-mute);cursor:pointer;font-family:inherit;line-height:1.5}
.qqp-nav-i:hover{background:var(--k-hover);color:inherit}
.qqp-nav-i:focus-visible{outline:2px solid var(--k-accent);outline-offset:1px}
.qqp-scroll{flex:1 1 auto;min-height:0;width:100%;max-width:980px;margin:0 auto;
  padding:2px 22px 40px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.qqp-scroll::-webkit-scrollbar{width:10px}
.qqp-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 22%,transparent);
  border-radius:6px;background-clip:content-box;border:3px solid transparent}
.qqp-sec{margin-top:14px}
.qqp-sec-h{display:flex;align-items:center;gap:9px;padding-bottom:5px;
  border-bottom:1px solid var(--k-line);cursor:pointer;user-select:none;border-radius:5px 5px 0 0}
.qqp-sec-h:hover{background:var(--k-hover)}
.qqp-sec-h:focus-visible{outline:2px solid var(--k-accent);outline-offset:2px}
.qqp-sec.closed .qqp-sec-h{border-bottom-color:transparent}
.qqp-chev{flex:0 0 auto;width:11px;font-size:10px;color:var(--k-mute);opacity:.8;transition:transform .12s}
.qqp-sec-n{font-size:11px;font-variant-numeric:tabular-nums;color:var(--k-mute);
  min-width:18px;letter-spacing:.06em}
.qqp-sec-t{font-size:13px;font-weight:600;letter-spacing:.02em}
.qqp-sec-r{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--k-mute)}
.qqp-body{padding-top:8px}

.qqp-hero{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:10px;
  border:1px solid var(--k-line);background:var(--k-surface);flex-wrap:wrap}
.qqp-hero-main{flex:1 1 190px;min-width:0}
.qqp-hero-state{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.qqp-hero-note{color:var(--k-mute);font-size:11.5px;margin-top:4px;line-height:1.55}
.qqp-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--k-idle);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--k-idle) 22%,transparent)}
.qqp-dot.ok{background:var(--k-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--k-ok) 22%,transparent)}
.qqp-dot.bad{background:var(--k-bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--k-bad) 22%,transparent)}
.qqp-dot.warn{background:var(--k-warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--k-warn) 22%,transparent)}

.qqp-switch{position:relative;flex:0 0 auto;width:52px;height:28px;border-radius:14px;border:1px solid var(--k-line);
  background:var(--k-field);cursor:pointer;padding:0;transition:background .16s ease,border-color .16s ease}
.qqp-switch::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
  background:var(--dsw-alias-label-primary,#e7e9ee);transition:transform .16s ease;opacity:.9}
.qqp-switch[aria-checked="true"]{background:color-mix(in srgb,var(--k-ok) 78%,transparent);border-color:transparent}
.qqp-switch[aria-checked="true"]::after{transform:translateX(24px);background:#fff;opacity:1}
.qqp-switch[aria-checked="mixed"]{background:color-mix(in srgb,var(--k-idle) 45%,transparent)}
.qqp-switch[aria-checked="mixed"]::after{transform:translateX(12px);opacity:.55}
.qqp-switch:disabled{opacity:.5;cursor:not-allowed}
.qqp-switch:focus-visible{outline:2px solid var(--k-accent);outline-offset:2px}

/* 左右分栏：生命与看护合并成一节后，左边是「现在什么状态」，右边是「能改什么」。
   原来两节竖着排，光这两节就要滚一屏半 —— 左读状态、右点开关，才不用上下翻。 */
.qqp-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.92fr);gap:0 20px;align-items:start}
/* .qqp-cols2：两列等宽，给「群 / 私聊」这种同构并列的用；.qqp-cols 那个 .92fr 是为了
   让左边的状态列宽一点，这里两边内容形状一样，不需要偏心。 */
.qqp-cols2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 18px;align-items:start}
.qqp-col{min-width:0}
/* 列首的那个小标题紧贴列顶，否则每列会凭空多出 14px 的抬头空白 */
.qqp-col>.qqp-sub:first-child{margin-top:0}
.qqp-col-r{border-left:1px solid var(--k-line-soft);padding-left:18px}
/* 行内警示：白名单那条「改完要重启」只是提示，不该占掉一整行高度 */
.qqp-warn-inline{color:var(--k-warn)}
.qqp-col-l>.qqp-row:first-child,.qqp-col-r>.qqp-row:first-child{border-top:none;padding-top:0}

/* 链路体检：QQ → SnowLuma → OneBot → 桥接，按数据流顺序串成一条。
   摊成平铺格子会让人以为「都还行」—— 截图里顶部写「QQ 全部功能可用」、
   下面却两个红点，就是标题只读了暂停开关、没看链路造成的。
   竖排成 2×2 而不是一行四格：两侧分栏后横排会把每个格子挤到 110px。 */
.qqp-chain{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:10px}
.qqp-chain-i{min-width:0;padding:7px 10px;border-radius:8px;
  border:1px solid var(--k-line-soft);background:var(--dsw-alias-bg-base,#16181c)}
.qqp-chain-i.bad{border-color:color-mix(in srgb,var(--k-bad) 34%,transparent);
  background:color-mix(in srgb,var(--k-bad) 7%,transparent)}
.qqp-chain-i .k{font-size:10.5px;color:var(--k-mute);letter-spacing:.02em}
.qqp-chain-i .v{margin-top:3px;font-size:12px;display:flex;align-items:center;gap:6px;word-break:break-all}
.qqp-chain-a{display:none}

.qqp-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;
  margin-top:10px;background:var(--k-line-soft);border:1px solid var(--k-line-soft);border-radius:8px;overflow:hidden}
.qqp-fact{background:var(--dsw-alias-bg-base,#16181c);padding:7px 10px}
.qqp-fact-k{font-size:10.5px;color:var(--k-mute);letter-spacing:.02em}
.qqp-fact-v{margin-top:2px;font-size:12px;display:flex;align-items:center;gap:6px;word-break:break-all}

.qqp-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--k-line-soft)}
.qqp-row:first-child{border-top:none}
.qqp-k{color:var(--k-mute);font-size:12px;width:84px;flex:0 0 auto}
.qqp-v{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:7px;flex-wrap:wrap}

.qqp-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:7px;font-size:12px;
  border:1px solid var(--k-line);background:transparent;color:inherit;cursor:pointer;font-family:inherit;
  transition:background .12s ease}
.qqp-btn:hover:not(:disabled){background:var(--k-hover)}
.qqp-btn:disabled{opacity:.45;cursor:not-allowed}
.qqp-btn:focus-visible{outline:2px solid var(--k-accent);outline-offset:1px}
.qqp-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--k-accent));border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.qqp-btn.primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-button-primary-fill,var(--k-accent))}

.qqp-input{padding:5px 10px;border-radius:7px;border:1px solid var(--k-line);background:var(--k-field);
  color:inherit;font-size:12px;font-family:inherit;min-width:0}
.qqp-input:focus-visible{outline:2px solid var(--k-accent);outline-offset:1px;border-color:transparent}
select.qqp-input{color-scheme:dark;cursor:pointer}
select.qqp-input option{background:#1c1d22;color:#e9eaee}

.qqp-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;
  border:1px solid var(--k-line);color:var(--k-mute);white-space:nowrap}
.qqp-pill.ok{color:var(--k-ok);border-color:color-mix(in srgb,var(--k-ok) 40%,transparent);
  background:color-mix(in srgb,var(--k-ok) 10%,transparent)}
.qqp-pill.bad{color:var(--k-bad);border-color:color-mix(in srgb,var(--k-bad) 40%,transparent);
  background:color-mix(in srgb,var(--k-bad) 10%,transparent)}
.qqp-pill.warn{color:var(--k-warn);border-color:color-mix(in srgb,var(--k-warn) 40%,transparent);
  background:color-mix(in srgb,var(--k-warn) 10%,transparent)}
.qqp-pill.plain{background:var(--k-field)}

.qqp-chips{display:flex;flex-wrap:wrap;gap:6px}
.qqp-chip{font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid var(--k-line-soft);
  background:var(--k-field);color:var(--k-mute);cursor:default}
.qqp-chip.on{color:var(--k-accent);border-color:color-mix(in srgb,var(--k-accent) 46%,transparent);
  background:color-mix(in srgb,var(--k-accent) 12%,transparent);cursor:pointer}
.qqp-chip.clk{cursor:pointer}
.qqp-chip.clk:hover{background:var(--k-hover)}

.qqp-big{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.qqp-big-num{font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em;line-height:1.1}
.qqp-big-unit{font-size:12px;color:var(--k-mute);padding-bottom:5px}

.qqp-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:1px;margin-top:11px;
  background:var(--k-line-soft);border:1px solid var(--k-line-soft);border-radius:8px;overflow:hidden}
.qqp-metric{background:var(--dsw-alias-bg-base,#16181c);padding:8px 11px}
.qqp-metric-k{font-size:11px;color:var(--k-mute)}
.qqp-metric-v{margin-top:2px;font-size:15px;font-variant-numeric:tabular-nums}

.qqp-spark{display:flex;align-items:flex-end;gap:2px;height:44px;margin-top:14px;
  padding:0 1px;border-bottom:1px solid var(--k-line-soft)}
.qqp-spark i{flex:1 1 0;min-width:2px;border-radius:1px 1px 0 0;background:var(--k-accent);opacity:.55;min-height:1px}
.qqp-spark i.peak{background:var(--k-warn);opacity:.7}
.qqp-spark i.empty{background:color-mix(in srgb,currentColor 12%,transparent);opacity:1}
.qqp-spark-x{display:flex;justify-content:space-between;color:var(--k-mute);font-size:10px;margin-top:5px}

.qqp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all}

.qqp-log{max-height:132px;overflow-y:auto;font-size:11.5px;scrollbar-width:thin}
.qqp-log div{padding:3px 0;border-top:1px solid var(--k-line-soft);color:var(--k-mute);display:flex;gap:8px}
.qqp-log div:first-child{border-top:none}
.qqp-log time{flex:0 0 auto;font-variant-numeric:tabular-nums;opacity:.75}

.qqp-empty{padding:12px 2px;color:var(--k-mute);font-size:12px}
/* .qqp-sub：节内分组的小标题（「QQ 群（1）」「私聊（1）」）。1.9.0 清孤儿规则时被误删 ——
   它当时确实只剩一处用法，但那处还在用；归零的判据应该是「JSX 里还有没有引用」，
   不是「用法是不是只剩一个」。 */
.qqp-sub{color:var(--k-mute);font-size:12px;margin-top:14px;margin-bottom:2px}
.qqp-note{font-size:11px;color:var(--k-mute);margin-top:8px;line-height:1.65}
.qqp-warnbox{padding:9px 12px;border-radius:8px;font-size:12px;margin-top:12px;
  border:1px solid color-mix(in srgb,var(--k-warn) 40%,transparent);
  background:color-mix(in srgb,var(--k-warn) 10%,transparent);color:var(--k-warn)}
.qqp-badbox{padding:9px 12px;border-radius:8px;font-size:12px;margin-top:12px;
  border:1px solid color-mix(in srgb,var(--k-bad) 40%,transparent);
  background:color-mix(in srgb,var(--k-bad) 10%,transparent);color:var(--k-bad)}
.qqp-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;
  padding:8px 16px;border-radius:8px;font-size:12px;border:1px solid var(--k-line);max-width:80vw;
  background:var(--dsw-alias-toast-bg,var(--k-surface));color:var(--dsw-alias-toast-label,inherit);
  box-shadow:0 8px 24px rgba(0,0,0,.28)}
@keyframes qqp-pulse{0%,100%{opacity:.45}50%{opacity:.9}}

/* ── 表情库 / 会话 / 人格 / 眼睛 / 工坊 共用 ───────────────────────── */
.qqp-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;
  color:var(--k-mute);word-break:break-all;line-height:1.6}
.qqp-path b{color:inherit;font-weight:600}
/* 缩略图收到最小一档：一格从 82×44 再压到 62×34，一屏能多铺三四行。
   表情库是「挑一张」的场景，不是看图 —— 要看细节点开 lightbox。 */
.qqp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:4px;margin-top:7px}
.qqp-tile{border:1px solid var(--k-line-soft);border-radius:6px;background:var(--k-surface);overflow:hidden}
.qqp-tile-h{display:flex;align-items:center;gap:3px;padding:2px 4px;font-size:9px;line-height:1.3}
.qqp-tile-b{padding:0 4px 4px;font-size:9px;color:var(--k-mute);line-height:1.35;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.qqp-thumb{display:block;width:100%;height:34px;object-fit:contain;background:
  repeating-conic-gradient(var(--k-field) 0% 25%, var(--k-surface) 0% 50%) 50%/12px 12px}
.qqp-list{display:flex;flex-direction:column;gap:0;margin-top:8px;
  border:1px solid var(--k-line-soft);border-radius:8px;overflow:hidden}
.qqp-li{display:flex;align-items:center;gap:8px;padding:5px 9px;border-top:1px solid var(--k-line-soft);
  font-size:11.5px;background:var(--k-surface);color:inherit}
.qqp-li:first-child{border-top:none}
.qqp-li.on{background:color-mix(in srgb,var(--k-accent) 10%,transparent)}
.qqp-li .who{flex:0 0 auto;color:inherit;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qqp-li .what{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--k-mute)}
.qqp-msg{border-top:1px solid var(--k-line-soft);padding:9px 11px;font-size:12px;background:var(--k-surface);color:inherit}
.qqp-msg:first-child{border-top:none}
.qqp-msg.self{background:color-mix(in srgb,var(--k-accent) 7%,transparent)}
.qqp-msg-h{display:flex;align-items:center;gap:7px;margin-bottom:4px;font-size:11px;color:var(--k-mute)}
.qqp-msg-b{line-height:1.62;word-break:break-word}
.qqp-msg-imgs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.qqp-msg-imgs img{max-width:132px;max-height:132px;border-radius:7px;border:1px solid var(--k-line-soft);cursor:zoom-in}
.qqp-editor{width:100%;min-height:180px;resize:vertical;padding:9px 11px;border-radius:8px;
  border:1px solid var(--k-line-soft);background:var(--k-field);color:inherit;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.62}
.qqp-editor:focus{outline:1px solid var(--k-accent);outline-offset:-1px;border-color:transparent}
.qqp-num{font-variant-numeric:tabular-nums}
.qqp-lightbox{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.72);
  display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px}
.qqp-lightbox img{max-width:92vw;max-height:88vh;border-radius:10px}
/* 小标题：用于「本地目录」「自己画一张」这类节内分组 —— 比一级节的序号+细线更轻。
   注意别叫 .qqp-sub：那个名字已经被页头副标题与「QQ 群（1）」这类灰字用掉了，
   同名会让它们凭空多出一条分隔线。 */
.qqp-group{margin-top:16px;padding-top:14px;border-top:1px solid var(--k-line-soft)}
.qqp-group-h{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:inherit}
.qqp-modal{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;padding:24px}
.qqp-modal-box{width:100%;max-width:440px;border-radius:12px;padding:16px 18px;
  border:1px solid var(--k-line);background:var(--dsw-alias-bg-overlay,var(--k-surface));
  color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 48px rgba(0,0,0,.45)}
.qqp-modal-h{font-size:13.5px;font-weight:600}
.qqp-modal-f{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}

@media (max-width:900px){
  .qqp-head{padding:13px 14px 0}
  .qqp-scroll{padding:2px 14px 32px}
  .qqp-k{width:72px}
  /* 窄屏没有左右分栏的余地：竖着排，靠左侧那条分隔线也去掉。 */
  .qqp-cols{grid-template-columns:1fr}
  .qqp-cols2{grid-template-columns:1fr;gap:0}
  .qqp-col-r{border-left:none;padding-left:0;margin-top:12px}
  .qqp-cols2>.qqp-col+.qqp-col{margin-top:14px}
  .qqp-topbar{width:100%;justify-content:flex-start;margin-left:0;margin-top:8px}
}
`

    function useStyle() {
      useEffect(() => {
        const id = 'qqp-style'
        if (document.getElementById(id) !== null) return undefined
        const el = document.createElement('style')
        el.id = id
        el.textContent = CSS
        document.head.appendChild(el)
        return () => {
          const found = document.getElementById(id)
          if (found !== null) found.remove()
        }
      }, [])
    }

    // ── 零件 ────────────────────────────────────────────────────────────
    function Pill({ tone, children }) {
      return h('span', { className: `qqp-pill${tone ? ` ${tone}` : ''}` }, children)
    }

    /**
     * 一节：序号 + 标题 + 右侧摘要 + 正文。
     *
     * 标题整行可点，再点一次收起 —— 用户的要求是「每个能展开的都做成可重复点击的展开/收起」。
     * 收起后右侧的摘要仍然显示（`0 个」「26 张」这类计数），所以折起来也知道里面有什么。
     * 展开状态由组件自己持有：同一位置反复重渲染不会丢，也不需要把 11 个 bool 都提到页面上。
     *
     * `signal` 是顶部导航的定位信号：点导航 chip 时先把目标节撑开再滚过去 ——
     * 滚到一个收起的节上，人只会看到一行标题，等于没跳。
     */
    function Sec({ n, id, title, right, children, defaultOpen, signal }) {
      const [open, setOpen] = useState(defaultOpen !== false)
      const toggle = () => setOpen((v) => !v)
      useEffect(() => {
        if (signal === null || signal === undefined || signal.id !== id) return
        setOpen(true)
      }, [signal, id])
      return h(
        'section',
        { className: `qqp-sec${open ? '' : ' closed'}`, id: id === undefined ? undefined : `qqp-${id}` },
        h(
          'div',
          {
            className: 'qqp-sec-h',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? 'true' : 'false',
            title: open ? '点一下收起' : '点一下展开',
            onClick: toggle,
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggle()
              }
            },
          },
          h('span', { className: 'qqp-chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          h('span', { className: 'qqp-sec-n' }, n),
          h('span', { className: 'qqp-sec-t' }, title),
          right === undefined ? null : h('div', { className: 'qqp-sec-r' }, right),
        ),
        open ? h('div', { className: 'qqp-body' }, children) : null,
      )
    }

    function Fact({ k, v, tone }) {
      return h(
        'div',
        { className: 'qqp-fact' },
        h('div', { className: 'qqp-fact-k' }, k),
        h('div', { className: 'qqp-fact-v' }, tone === undefined ? null : h('span', { className: `qqp-dot ${tone}` }), v),
      )
    }

    function Switch({ checked, onChange, disabled, label }) {
      const state = checked === null || checked === undefined ? 'mixed' : checked ? 'true' : 'false'
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'qqp-switch',
        'aria-checked': state,
        'aria-label': label,
        disabled: disabled === true,
        onClick: () => {
          if (disabled === true) return
          onChange(checked !== true)
        },
      })
    }

    /**
     * 插件内模态。
     *
     * 为什么不用 window.prompt / window.confirm：DSH 跑在 Electron 里，这两个 API
     * 默认被禁用 —— prompt 直接返回 null（点了「写备注」像没反应），confirm 恒真，
     * 删人格这类不可撤销的操作就失去了二次确认。dsh-roost 也是自己画模态的。
     *
     * 两种形态：
     *   {kind:'note', title, hint, value, sticker}  → 输入框 + 保存/取消
     *   {kind:'confirm', title, hint, okText, onOk} → 两按钮
     */
    function Modal({ modal, busy, onClose, onSubmit }) {
      const [value, setValue] = useState(modal.kind === 'note' ? modal.value ?? '' : '')
      const isNote = modal.kind === 'note'
      const inputRef = useRef(null)
      useEffect(() => {
        // 打开即聚焦，Enter 提交 —— 写备注是「想到一句话就想立刻存下来」的动作，
        // 不该逼人去找鼠标。
        if (isNote && inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
        const onKey = (e) => {
          if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [isNote, onClose])
      return h(
        'div',
        { className: 'qqp-modal', onClick: onClose },
        h(
          'div',
          {
            className: 'qqp-modal-box',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': modal.title ?? '对话框',
            onClick: (e) => e.stopPropagation(),
          },
          h('div', { className: 'qqp-modal-h' }, modal.title ?? ''),
          modal.hint ? h('div', { className: 'qqp-note', style: { marginTop: 6, whiteSpace: 'pre-wrap' } }, modal.hint) : null,
          isNote
            ? h('textarea', {
                ref: inputRef,
                className: 'qqp-input',
                style: { width: '100%', minHeight: 84, marginTop: 10, resize: 'vertical' },
                maxLength: 200,
                placeholder: '它长什么样、什么时候用（最多 200 字）',
                value,
                onChange: (e) => setValue(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    onSubmit(value)
                  }
                },
              })
            : null,
          h(
            'div',
            { className: 'qqp-modal-f' },
            h('button', { className: 'qqp-btn', onClick: onClose }, '取消'),
            h(
              'button',
              {
                className: 'qqp-btn primary',
                disabled: busy !== '',
                onClick: () => onSubmit(value),
              },
              isNote ? '保存' : modal.okText ?? '确定',
            ),
          ),
        ),
      )
    }

    // ── 页面 ────────────────────────────────────────────────────────────
    function PanelPage() {
      useStyle()
      const [ov, setOv] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [toastMsg, setToastMsg] = useState('')
      // ── 新增五块的本地状态 ──
      const [stickers, setStickers] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [roles, setRoles] = useState(null)
      const [roleDraft, setRoleDraft] = useState(null)
      const [eyes, setEyes] = useState(null)
      const [eyesKey, setEyesKey] = useState('')
      const [zoomed, setZoomed] = useState('')
      // 语音与记忆的现状（只读）：用户看截图后问「语音那栏还是关着的」「记忆是空的」，
      // 这一节回答为什么、缺什么。
      const [caps, setCaps] = useState(null)
      // 语音库本身（可操作）：列音频、念一句、删、试发。
      // 与 caps.voice 的分工：caps.voice 说「开关状态 / 能不能发」，voices 说「库里有什么」。
      const [voices, setVoices] = useState(null)
      const [ttsText, setTtsText] = useState('')
      const [voiceKey, setVoiceKey] = useState('')
      const [voiceTries, setVoiceTries] = useState({})
      // 音色选择：引擎（edge/sapi）、具体音色、语速。初始值等 /voices 回来再对齐，
      // 所以先用 null/空串表示"还没读到"，渲染时回落到 voices.prefs（否则会把
      // 上次存下的语速显示成 0，看起来像没记住）。
      const [ttsEngine, setTtsEngine] = useState('')
      const [ttsVoice, setTtsVoice] = useState('')
      const [ttsRate, setTtsRate] = useState(null)
      // 免打扰时段：两个时间输入框是「草稿」，只有在点保存时才写进 bridge。
      // 空串表示"还没动过"，渲染时回落到 overview 里的真实值。
      const [quietStart, setQuietStart] = useState('')
      const [quietEnd, setQuietEnd] = useState('')
      // 表情库/工坊合并后共用的两样东西：
      //   · dirScan —— 本地目录扫描结果（管理员往 state/stickers 里丢图 → 自动入库）
      //   · autoScan —— 是否自动刷；关掉后只手动点「扫一次」
      const [dirScan, setDirScan] = useState(null)
      const [autoScan, setAutoScan] = useState(true)
      // 插件内模态：Electron 里 window.prompt / window.confirm 不弹框（前者直接返回
      // null），所以「写备注」「删人格」这类需要二次输入/确认的交互必须自己画。
      const [modal, setModal] = useState(null)
      // 顶部导航的定位信号：{id, at}。at 让「连点同一个 chip」也能重新滚一次。
      const [navSignal, setNavSignal] = useState(null)
      const toastTimer = useRef(null)

      const toast = useCallback((text) => {
        setToastMsg(text)
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToastMsg(''), 3800)
      }, [])

      useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      }, [])

      // overview 的轮询要防重叠：桥接卡住（接了连接不回话）时一个请求能占满
// 好几秒，而这里每 10 秒（拉起中 3 秒）就再来一次。不挡住的话请求会一层层
// 叠起来，界面反而更慢、日志里全是并发请求。
      const loadingRef = useRef(false)
      const load = useCallback(async () => {
        if (loadingRef.current) return
        loadingRef.current = true
        try {
          const o = await req('/overview')
          if (o.ok === false && o.httpStatus === 0) {
            setErr(o.message ?? '面板接口没响应')
            return
          }
          setErr('')
          setOv(o)
        } finally {
          loadingRef.current = false
        }
      }, [])

      // 新增的五块各自按需加载：不和 overview 挤在一起。
      // overview 每 10 秒刷一次，表情库/会话/人格这些没必跟着刷 —— 既浪费又会让
      // 正在编辑的文本框被覆盖（那是最烦的一种「代码有问题」）。
      const loadStickers = useCallback(async (query) => {
        const r = await post('/stickers', { query: query ?? '', count: 100 })
        if (r.ok !== false) setStickers(r)
        return r
      }, [])

      const loadSessions = useCallback(async () => {
        const r = await req('/sessions')
        if (r.ok !== false) setSessions(r)
        return r
      }, [])

      const loadRoles = useCallback(async () => {
        const r = await req('/roles')
        if (r.ok !== false) setRoles(r)
        return r
      }, [])

      // 注意：这里刻意不依赖 `eyesKey`，key 一律由调用方显式传。
      // 否则 eyesKey 一变，`loadEyes` 就是新函数，下面那个首屏 useEffect 的依赖数组
      // 跟着变 → 表情库/会话/人格/工坊全部重新拉一遍（点一下「看这个」就整页闪一次）。
      const loadEyes = useCallback(async (key) => {
        const r = await post('/eyes', { key: key ?? '', limit: 40 })
        if (r.ok !== false) setEyes(r)
        return r
      }, [])

      // 清死条目：图片文件已经不存在的记录直接从桥接库里删掉。
      // 「删表情」「扫目录」「同步」之后都顺手调一次 —— 界面不留「没有预览地址」占位。
      const pruneStickers = useCallback(async () => {
        const r = await post('/stickers/prune', {})
        return r
      }, [])

      // 扫本地表情目录：发现「目录里有、库里没有」的文件就顺手入库。
      // 这是「管理员把图片丢进文件夹 → 面板自动读到」的实现；adopt=false 时只清点不入库。
      const loadScan = useCallback(async (adopt) => {
        const r = await post('/stickers/scan', { adopt: adopt !== false })
        if (r.ok !== false) setDirScan(r)
        return r
      }, [])

      const loadCaps = useCallback(async () => {
        const r = await req('/capabilities')
        if (r.ok !== false) setCaps(r)
        return r
      }, [])

      // 语音库：列目录 + TTS 体检都在这一个接口里（tts 字段）。念一句/删/试发都是写操作。
      const loadVoices = useCallback(async (probe) => {
        const r = await post('/voices', { probe: probe === true })
        if (r.ok !== false) setVoices(r)
        return r
      }, [])

      // 试发目标：默认挑第一个已知会话，避免每次都手填 key。
      const voiceKeys = [
        ...((ov?.life?.allowGroups ?? []).map((g) => `group:${g}`)),
        ...((ov?.life?.allowPrivate ?? []).map((p) => `private:${p}`)),
      ]

      // 四块数据在首屏之后依次拉一次，谁先回谁先显示。
      //
      // 「眼睛」那一节已经从界面上摘掉（见 08 那段的注释），所以这里**不再**预拉 `loadEyes`：
      // 它要按会话拉全量消息，是这批请求里最重的一个，拉了却没人看纯属浪费。
      // 日后把那一节放回来时，记得把 `loadEyes('')` 与它的依赖也加回去。
      useEffect(() => {
        loadStickers()
        loadSessions()
        loadRoles()
        loadScan(true)
        loadCaps()
        loadVoices(false)
      }, [loadStickers, loadSessions, loadRoles, loadScan, loadCaps, loadVoices])

      // 本地目录自动刷新：管理员把图片丢进 state/stickers 就自动收进库。
      // 12 秒一轮 —— 比 readdir 本身贵的是逐张入库调用，只在真有新文件时才发生，
      // 空转一次只有一次 readdir + 一次 stickers.json 解析，可以接受。
      // 关掉 autoScan 就只剩「扫一次」按钮。
      useEffect(() => {
        if (autoScan !== true) return undefined
        const timer = setInterval(() => {
          loadScan(true).then((r) => {
            if (r?.adoptedTotal > 0) {
              toast(`目录里多了 ${r.adoptedTotal} 张，已自动入库`)
              loadStickers()
            }
          })
        }, 12000)
        return () => clearInterval(timer)
      }, [autoScan, loadScan, loadStickers, toast])

      // 拉起过程中要盯得紧一点：脚本一般跑 1~2 分钟，10 秒一刷会让人以为卡住了。
      const running = ov?.watchdog?.run?.running === true
      useEffect(() => {
        load()
        const timer = setInterval(load, running ? 3000 : 10000)
        return () => clearInterval(timer)
      }, [load, running])

      const act = useCallback(
        async (key, fn, okText) => {
          setBusy(key)
          try {
            const result = await fn()
            if (result?.ok === false) {
              toast(result.message ?? '操作失败')
            } else if (okText) {
              // okText 常写成 (r) => r.xxx：结果形状不对时会抛 TypeError。调用处是
              // act(...).then(...) 且没有 .catch，抛出去就成了未处理拒绝 ——
              // 用户只看到按钮转完就没了，控制台里一行红字。
              try {
                toast(typeof okText === 'function' ? okText(result) : okText)
              } catch {
                toast('操作完成')
              }
            }
            await load()
          } catch (error) {
            // 轮询重建 / 接口抛错不该静默：至少让人看见一句为什么。
            toast(error?.message ?? '操作失败')
          } finally {
            setBusy('')
          }
        },
        [load, toast],
      )

      // 模态提交：备注保存 / 确认执行。两条路都要把模态关掉，否则弹层会一直挡着。
      const submitModal = useCallback(
        async (value, tag) => {
          const current = tag ?? modal
          if (current === null) return
          setModal(null)
          if (current.kind === 'note') {
            const s = current.sticker
            await act(
              `note-${s.id}`,
              () => post('/stickers/note', { stickerId: s.id, note: String(value ?? '').slice(0, 200) }),
              '备注已保存',
            ).then(() => loadStickers())
            return
          }
          if (typeof current.onOk === 'function') await current.onOk()
        },
        [act, loadStickers, modal],
      )

      const bridgeOk = ov?.bridge?.reachable === true
      const lifeOn = ov?.life?.on ?? null
      const qq = ov?.qq
      const qqUp = qq?.running === true
      const oneBotUp = ov?.oneBot?.reachable === true
      const snow = ov?.life?.snowluma
      // SnowLuma 只有在 QQ 活着时才谈得上「连没连上」：它是 hook 进 QQ 进程的，
      // QQ 不在的时候这一环既不算好也不算坏，只能说「等 QQ 起来」。
      const snowUp = qqUp && (snow?.connected === true || snow?.good === true)
      const snowBad = qqUp && (snow?.connected === false || snow?.good === false)

      // 链路体检：按数据流从「身体」排到「大脑」——QQ → SnowLuma → OneBot → 桥接。
      // 断在哪儿就说哪儿，不要笼统一句「不可用」：截图里顶部写「QQ 全部功能可用」、
      // 下面两格却是红点，正是因为标题只读了暂停开关、根本没看这条链。
      //
      // cascade 表示「这一环是被上游拖垮的」，不是独立要修的东西：
      //   QQ 死 → SnowLuma hook 不上 → OneBot 不开，这三环是串起来的；
      //   桥接却是独立进程（它只依赖 DSH），OneBot 死了它照样活 —— 反过来也一样。
      //   把它们一律当成串行，就会写出「桥接跟着断」这种假因果。
      const chain = [
        {
          key: 'qq',
          name: 'QQ 客户端',
          cascade: false,
          ok: qqUp ? true : qq?.running === false ? false : null,
          v: qqUp ? '在运行' : qq?.running === false ? '没开' : qq?.known === false ? '查不到' : '—',
        },
        {
          key: 'snowluma',
          name: 'SnowLuma',
          cascade: true,
          ok: qqUp === false ? null : snowUp ? true : snowBad ? false : null,
          v: qqUp === false ? '等 QQ 起来' : snowUp ? 'hook 已连上' : snowBad ? 'hook 没连上' : '—',
        },
        {
          key: 'onebot',
          name: `OneBot :${ov?.oneBot?.port ?? 3000}`,
          cascade: true,
          ok: oneBotUp,
          v: oneBotUp ? '在听' : '无响应',
        },
        {
          key: 'bridge',
          name: `桥接 :${ov?.bridge?.consolePort ?? 3100}`,
          cascade: false,
          ok: bridgeOk,
          v: bridgeOk ? '在听' : '无响应',
        },
      ]
      const chainOk = chain.every((c) => c.ok === true)
      const badNodes = chain.filter((c) => c.ok === false)

      // 先修哪一个？跟显示顺序不一样：
      // 桥接是整个面板的数据来源，它一死，别处的状态本来就是猜的 —— 所以它排第一。
      // 桥接活着时，才按数据流从外往里修。
      const firstBad = (bridgeOk ? null : chain.find((c) => c.key === 'bridge')) ?? badNodes[0] ?? null
      const firstBadIdx = firstBad === null ? -1 : chain.indexOf(firstBad)
      // 级联：排在第一断点下游、而且本来就会因为上游死而死的那几环。
      const cascaded =
        firstBadIdx < 0
          ? []
          : chain.slice(firstBadIdx + 1).filter((c) => c.ok === false && c.cascade === true)
      // 其它的断环是独立的第二个故障（比如桥接和 OneBot 各死各的），要单独提一句，
      // 不能混进「跟着断」里 —— 那会让人以为修好一处就全好了。
      const independent = badNodes.filter((c) => c !== firstBad && cascaded.indexOf(c) < 0)

      // 「为什么说不了话」——每一环给一句能照做的话，比一个红点有用。
      // 措辞不能假设旁边的环是好的：桥接没起来时，SnowLuma 的死活根本无从得知。
      const BREAK_NOTE = {
        qq: '「一键拉起」会自己打开 QQ，但登录这一步替不了你：登进你的小号 QQ，SnowLuma 才能 hook 上去。',
        snowluma: 'QQ 在跑，SnowLuma 却没连上。点「一键拉起」会用 SNOWLUMA_HOOK_AUTOLOAD=1 重起它；还不行就退出 QQ 重登一次。',
        onebot: 'OneBot 3000 没开门 —— SnowLuma 没在跑，或者小号还没登录完。点「一键拉起」；登录后它会自己 hook 上去，等十几秒。',
        bridge: '桥接没在运行，面板读不到任何运行状态（开关是开是关都不知道）。点下面的「一键拉起」。',
      }

      // 生命开关只是「闸」，链路才是「管」。两者分开说，才不会说假话。
      // 注意分工：这里只讲「开关」和「链路」是两件事，具体怎么修交给下面的黄框，
      // 否则同一句话会在一屏里出现两次。
      const lifeState =
        lifeOn === false
          ? { tone: 'bad', head: '大肥鱼已断线', note: '关闭状态下：发不出任何消息、也发不了拍一拍、唤醒调度全部停摆（桥接回 403「AI 已暂停」）。打开即恢复。' }
          : lifeOn === true && chainOk
            ? { tone: 'ok', head: '大肥鱼在线，QQ 全部功能可用', note: '收发消息、拍一拍、主动开话题、沉睡前观察都在跑。关掉它等于把嘴和耳朵一起摘掉。' }
            : lifeOn === true
              ? {
                  tone: 'warn',
                  head: `开关是开的，但「${firstBad?.name ?? '链路'}」断了`,
                  note: '开关守着的是「闸」，链路说的是「管」—— 闸开着，管断了，照样一句话发不出去。',
                }
              : { tone: 'warn', head: '读不到状态', note: '桥接没在运行，所以读不到暂停状态 —— 开关现在是开是关，没人能告诉你。' }

      const wd = ov?.watchdog
      const run = wd?.run ?? { running: false, elapsedSec: 0, startedAt: 0, finishedAt: 0, exitCode: null, timedOut: false }
      const spend = ov?.spend
      const symbol = spend?.symbol ?? '¥'
      // 合盖保活：undefined = 还没读回来（别急着说「会睡」），ok:false = 读不到。
      const pw = ov?.power
      // 免打扰时段：草稿优先，没动过就用 overview 里的真实值。
      const quietCfg = ov?.life?.quietHours ?? { enabled: false, start: '23:00', end: '08:00', muteMessages: false }
      const quietStartValue = quietStart !== '' ? quietStart : quietCfg.start
      const quietEndValue = quietEnd !== '' ? quietEnd : quietCfg.end
      const quietDirty = quietStartValue !== quietCfg.start || quietEndValue !== quietCfg.end
      const quietNote = quietCfg.enabled
        ? `北京时间的 ${quietCfg.start} ~ ${quietCfg.end} 之间不主动醒；其余时间（${quietCfg.end} ~ ${quietCfg.start}）定时唤醒照常。${
            quietCfg.muteMessages ? '这段时间连私聊、@ 也不叫它。' : '期间有人私聊、@ 它、点名提问仍会叫醒。'
          }`
        : '设一对时间（例：23:00 ~ 08:00）就能在夜里彻底安静 —— 等价于「08:00 ~ 23:00 可以唤醒」。跨午夜也认。'

      // ── 第 05 节「表情与语音」的两个零件 ──────────────────────────────
      // 原本「表情库」和「语音与记忆」是两节，各占一屏：表情那节满屏缩略图，语音那节
      // 五个状态行 + 念一句表单 + 音频列表 + 记忆三行。加起来就是「页面占了太多东西」。
      // 现在并成一节、默认收起，展开后也全部压扁（见 CSS 里的 .qqp-grid/.qqp-li）。
      //
      // 语音那块先在这里构造好再塞进 JSX：直接内联等于把下面这张 60 行的 props 表
      // 搬进结构里，改一处漏一处。
      const voiceBlock = h(VoiceSection, {
        caps,
        voices,
        busy,
        ttsText,
        onTtsText: setTtsText,
        voiceKey,
        onVoiceKey: setVoiceKey,
        voiceKeys,
        voiceTries,
        // 音色：预置值来自后端偏好（voices.prefs），本地改动先落 state 再存回后端。
        // 空串表示"还没读到"，渲染时回落到 voices.prefs。
        engine: ttsEngine !== '' ? ttsEngine : (voices?.prefs?.engine ?? 'kokoro'),
        voice: ttsVoice !== '' ? ttsVoice : (voices?.prefs?.voice ?? ''),
        rate: ttsRate !== null ? ttsRate : (voices?.prefs?.rate ?? 0),
        onEngine: (v) => {
          setTtsEngine(v)
          post('/voices/prefs', { engine: v }).then((r) => {
            if (r.ok !== false) {
              setVoices((prev) => (prev === null ? prev : { ...prev, prefs: r.prefs }))
              toast(r.message ?? '已切换')
            } else {
              toast(r.message ?? '切换失败')
            }
          })
        },
        onVoice: (v) => {
          setTtsVoice(v)
          post('/voices/prefs', { voice: v }).then((r) => {
            if (r.ok !== false) {
              setVoices((prev) => (prev === null ? prev : { ...prev, prefs: r.prefs }))
              toast(r.message ?? '已切换')
            } else {
              toast(r.message ?? '切换失败')
            }
          })
        },
        onRate: setTtsRate,
        // 试听一句：用当前选的引擎/音色/语速念，不消耗偏好（只是听）。
        onPreviewVoice: () => {
          const text = ttsText.trim() !== '' ? ttsText.trim() : '主人，我是大肥鱼。'
          act('preview', () => post('/voices/tts', {
            text,
            engine: ttsEngine !== '' ? ttsEngine : (voices?.prefs?.engine ?? 'kokoro'),
            voice: ttsVoice !== '' ? ttsVoice : (voices?.prefs?.voice ?? ''),
            rate: ttsRate !== null ? ttsRate : (voices?.prefs?.rate ?? 0),
            name: '试听',
          }), (r) => r.message ?? '念好了').then(() => {
            loadVoices(false)
          })
        },
        onSpeak: () =>
          act('tts', () => post('/voices/tts', {
            text: ttsText,
            engine: ttsEngine !== '' ? ttsEngine : (voices?.prefs?.engine ?? 'kokoro'),
            voice: ttsVoice !== '' ? ttsVoice : (voices?.prefs?.voice ?? ''),
            rate: ttsRate !== null ? ttsRate : (voices?.prefs?.rate ?? 0),
          }), (r) => `念好了：${r.name}`).then(() => {
            setTtsText('')
            loadVoices(false)
            loadCaps()
          }),
        onDeleteVoice: (name) =>
          act(`del-${name}`, () => post('/voices/delete', { name }), `已删除 ${name}`).then(() => {
            loadVoices(false)
            loadCaps()
          }),
        onPlay: (name) => {
          setVoiceTries((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }))
        },
        // 先验一次：桥接 dryRun 只做白名单/时长/格式校验，不真发。
        onCheck: (name) =>
          act(`chk-${name}`, () => post('/voices/send', { name, key: voiceKey, dryRun: true }), (r) => r.message ?? '检查通过'),
        // 真发：这一步会在 QQ 里产生一条真实语音。
        onSend: (name) => {
          setModal({
            kind: 'confirm',
            title: `发一条语音到 ${voiceKey}？`,
            hint: '这会真的在 QQ 里发出去。不确定就先点「先验一下」。',
            okText: '发',
            onOk: () =>
              act(`send-${name}`, () => post('/voices/send', { name, key: voiceKey }), (r) => r.message ?? `已发出：${name}`),
          })
        },
        onRefresh: () => {
          loadVoices(false)
          loadCaps()
        },
      })

      // 第 05 节右侧的摘要：收起时也要看得见「几张表情、几段语音」。
      // 只数「能看见的」—— 记录还在、图已删掉的不该算进「26 张」。
      const mediaSummary = (() => {
        if (stickers === null && voices === null) return ''
        const live = (stickers?.stickers ?? []).filter((s) => s.hasPreview !== false && s.url !== '').length
        const parts = []
        if (stickers !== null) parts.push(live > 0 ? `${live} 张表情` : '表情空')
        if (voices !== null) parts.push(voices.count > 0 ? `语音 ${voices.count} 段` : '语音空')
        return parts.join(' · ')
      })()

      return h(
        'div',
        { className: 'qqp-root' },
        h(
          'header',
          { className: 'qqp-head' },
          // 标题与工具条同一条：原来「标题 / 副标题 / 工具条」各占一行，
          // 光页头就 90px，滚两下才见到第一节。
          h(
            'div',
            { className: 'qqp-title' },
            h(WhaleIcon, { size: 18 }),
            h('span', null, '小鲸鱼'),
            // 标题上的 pill 也要看链路：截图里正是这里说「活着」、下面却两个红点。
            lifeOn === false
              ? Pill({ tone: 'bad' }, '已断线')
              : chainOk
                ? Pill({ tone: 'ok' }, '四环全通')
                : firstBad !== null
                  ? Pill({ tone: 'bad' }, `断在${firstBad.name}`)
                  : Pill({ tone: 'warn' }, '状态未知'),
            h(
              'div',
              { className: 'qqp-topbar' },
              h('button', { type: 'button', className: 'qqp-btn', onClick: load }, '刷新'),
              h('span', { className: 'qqp-pill plain' }, ov === null ? '读表中' : `${clockOf(ov.at)} 更新`),
              bridgeOk ? null : h('span', { className: 'qqp-pill bad' }, '桥接不可达'),
              err === '' ? null : h('span', { className: 'qqp-pill bad' }, err),
            ),
          ),
          // 顶部导航：点一下滚到那一节并把它撑开。
          // 「不用每次上下翻找各项功能」——页头一条 tab，比让人滚着找强。
          h(
            'nav',
            { className: 'qqp-nav', 'aria-label': '面板导航' },
            ...NAV.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'qqp-nav-i',
                  onClick: () => {
                    setNavSignal({ id: item.id, at: Date.now() })
                    if (typeof document === 'undefined') return
                    const el = document.getElementById(`qqp-${item.id}`)
                    if (el !== null && typeof el.scrollIntoView === 'function') {
                      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
                    }
                  },
                },
                item.label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'qqp-scroll' },
          // ── 01 生命与看护 ──
          // 原来「生命开关」和「掉线看护」是两节竖着排，光这两节就要滚一屏半。
          // 合并成左右两栏：左边只回答「现在能不能用」，右边只回答「怎么让它一直能用」。
          h(
            Sec,
            {
              n: '01',
              id: 'life',
              title: '生命与看护',
              signal: navSignal,
              right: h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 7 } },
                wd === undefined ? null : h(Pill, { tone: wd.enabled && wd.autoRestart ? 'ok' : 'plain' }, wd.enabled ? (wd.autoRestart ? '看护接管中' : '只监控') : '看护已关'),
                ov === null ? null : h('span', null, `模式 ${ov.life?.mode ?? '未知'}`),
              ),
            },
            h(
              'div',
              { className: 'qqp-cols' },
              // ── 左：现在能不能用 ──
              h(
                'div',
                { className: 'qqp-col-l' },
                h(
                  'div',
                  { className: 'qqp-hero' },
                  h('span', { className: `qqp-dot ${lifeState.tone}` }),
                  h(
                    'div',
                    { className: 'qqp-hero-main' },
                    h('div', { className: 'qqp-hero-state' }, lifeState.head),
                    h('div', { className: 'qqp-hero-note' }, lifeState.note),
                  ),
                  h(Switch, {
                    checked: lifeOn,
                    label: '生命开关',
                    disabled: busy !== '' || lifeOn === null,
                    onChange: (next) => act('life', () => post('/life', { on: next }), next ? '已恢复：QQ 全部功能可用' : '已断开：AI 停手'),
                  }),
                ),
                // 链路体检：四环按数据流串起来，断在哪一环一眼就看得到。
                // 说「开关开着」和说「能用」是两件事 —— 这一排就是「能不能用」。
                h(
                  'div',
                  { className: 'qqp-chain' },
                  ...chain.flatMap((node, i) => {
                    const cell = h(
                      'div',
                      { className: `qqp-chain-i${node.ok === false ? ' bad' : ''}`, key: node.key },
                      h('div', { className: 'k' }, node.name),
                      h(
                        'div',
                        { className: 'v' },
                        h('span', { className: `qqp-dot ${node.ok === true ? 'ok' : node.ok === false ? 'bad' : 'warn'}` }),
                        node.v,
                      ),
                    )
                    return i === 0 ? [cell] : [h('span', { className: 'qqp-chain-a', key: `a${node.key}` }, '→'), cell]
                  }),
                ),
                // 断点提示：只说「最外层」那一环，级联断的顺便交代一句。
                // 链路是有先后顺序的 —— QQ 没开的时候 OneBot 必然也不通，把它俩并列成
                // 「2 环没通」会让人以为有两件事要做，其实只要把最外层修好，下游自己会活。
                badNodes.length === 0
                  ? h('div', { className: 'qqp-note' }, chainOk ? '四环全通。' : '有几环还读不到状态（多半是桥接没起来，看下面）。')
                  : h(
                      'div',
                      { className: 'qqp-warnbox' },
                      `断在「${firstBad.name}」：${BREAK_NOTE[firstBad.key]}`,
                      cascaded.length === 0
                        ? null
                        : ` 下游的 ${cascaded.map((n) => n.name).join('、')} 跟着断 —— 上面这一环修好，${cascaded.length === 1 ? '它' : '它们'}多半会自己恢复。`,
                      independent.length === 0
                        ? null
                        : ` 另外 ${independent.map((n) => n.name).join('、')} 也没通，那是另一处问题，得单独修。`,
                    ),
                h(
                  'div',
                  { className: 'qqp-facts' },
                  h(Fact, { k: '角色', v: ov?.life?.role ?? '—' }),
                  h(Fact, {
                    k: 'DSH',
                    tone: ov?.life?.dshReady === true ? 'ok' : ov?.life?.dshReady === false ? 'bad' : undefined,
                    v: ov?.life?.dshReady === true ? '就绪' : ov?.life?.dshReady === false ? '未就绪' : '—',
                  }),
                  h(Fact, {
                    k: 'SnowLuma 接收链路',
                    tone:
                      qqUp === false
                        ? undefined
                        : snow?.connected === false
                          ? 'bad'
                          : snow?.good === true
                            ? 'ok'
                            : snow?.good === false
                              ? 'bad'
                              : undefined,
                    v:
                      qqUp === false
                        ? '— （QQ 没开）'
                        : snow?.connected === false
                          ? '未连接（SnowLuma 没连上桥接）'
                          : snow?.good === true
                            ? '正常'
                            : snow?.hint ?? (snow ? '异常' : '—'),
                  }),
                  h(Fact, { k: '管理员 QQ', v: ov?.life?.ownerQQ ?? '—' }),
                ),
                h(
                  'div',
                  { className: 'qqp-chips', style: { marginTop: 12 } },
                  ...((ov?.life?.allowGroups ?? []).length === 0
                    ? [h('span', { className: 'qqp-chip' }, '没有群在白名单里')]
                    : (ov.life.allowGroups ?? []).map((g) =>
                        h('span', { className: 'qqp-chip', key: `g${g}`, title: '群白名单' }, `群 ${g}`),
                      )),
                  ...((ov?.life?.allowPrivate ?? []).map((p) => h('span', { className: 'qqp-chip', key: `p${p}`, title: '私聊白名单' }, `私聊 ${p}`))),
                ),
                    // 左栏到此为止；右栏只放「怎么让它一直能用」。
                  ),
                  // ── 右：看护 ──
                  h(
                    'div',
                    { className: 'qqp-col-r' },
                h(
                  'div',
                  { className: 'qqp-row', style: { borderTop: 'none' } },
                  h('div', { className: 'qqp-k' }, '自动重启'),
                  h(
                    'div',
                    { className: 'qqp-v' },
                    h(Switch, {
                      checked: wd?.autoRestart ?? false,
                      label: '掉线自动重启',
                      disabled: busy !== '' || wd === undefined,
                      onChange: (next) =>
                        act('wd', () => post('/watchdog', { enabled: next, autoRestart: next }), next ? '看护已接管：掉线自动拉起' : '看护已停止'),
                    }),
                    h('span', { className: 'qqp-note', style: { marginTop: 0 } }, '掉线时拉一次 start-whale.ps1 -NoDsh（不动 DSH）'),
                  ),
                ),
                h(
                  'div',
                  { className: 'qqp-row' },
                  h('div', { className: 'qqp-k' }, '探活间隔'),
                  h(
                    'div',
                    { className: 'qqp-v' },
                    h(
                      'select',
                      {
                        className: 'qqp-input',
                        value: String(wd?.probeMs ?? 15000),
                        disabled: busy !== '' || wd === undefined,
                        onChange: (e) => act('wd', () => post('/watchdog', { probeMs: Number(e.target.value) }), '探活间隔已改'),
                      },
                      ...[5000, 10000, 15000, 30000, 60000].map((ms) => h('option', { key: ms, value: String(ms) }, `${ms / 1000} 秒`)),
                    ),
                    h('span', { className: 'qqp-pill plain' }, `失败 ${wd?.failures ?? 0}`),
                    h('span', { className: 'qqp-pill plain' }, `重启 ${wd?.restarts ?? 0}`),
                    // ago() 自己带「前」，这里再拼「前」会变成「15 秒前前探过」
                    h('span', { className: 'qqp-pill plain' }, wd?.lastProbeAt > 0 ? `${ago(wd.lastProbeAt)}探过` : '还没探过'),
                    // 「探的是哪一环」比「探了几次」有用：链路四环里，看护只盯最后两环。
                    (wd?.health?.bridgeAlive === false || wd?.health?.oneBotAlive === false) && wd?.ok !== true
                      ? h(
                          'span',
                          { className: 'qqp-pill bad' },
                          wd.health.bridgeAlive === false
                            ? `桥接 :${ov?.bridge?.consolePort ?? 3100} 不通`
                            : `OneBot :${ov?.oneBot?.port ?? 3000} 不通`,
                        )
                      : null,
                    (wd?.streakRestarts ?? 0) > 0
                      ? h(
                          'span',
                          { className: `qqp-pill ${(wd?.streakRestarts ?? 0) >= (wd?.maxAttempts ?? 3) ? 'bad' : 'warn'}` },
                          (wd?.streakRestarts ?? 0) >= (wd?.maxAttempts ?? 3)
                            ? `连拉 ${wd.streakRestarts} 次没好，已暂停`
                            : `连拉 ${wd.streakRestarts}/${wd.maxAttempts ?? 3}`,
                        )
                      : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'qqp-row' },
                  h('div', { className: 'qqp-k' }, '手动'),
                  h(
                    'div',
                    { className: 'qqp-v' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'qqp-btn primary',
                        disabled: busy !== '' || run.running,
                        onClick: () => act('restart', () => post('/restart', {}), (r) => r.message ?? '已触发'),
                      },
                      run.running ? `正在拉起（已 ${run.elapsedSec ?? 0} 秒）` : busy === 'restart' ? '正在拉起…' : '一键拉起',
                    ),
                    run.running
                      ? h('span', { className: 'qqp-pill warn' }, '脚本在跑，别关面板')
                      : h('span', { className: 'qqp-note', style: { marginTop: 0 } }, '缺什么起什么，1~2 分钟'),
                  ),
                ),
                // 唤醒调整：省 token 的待机姿势 —— 关掉「定时自动醒」，只在收到消息时激活。
                h(
                  'div',
                  { className: 'qqp-row' },
                  h('div', { className: 'qqp-k' }, '只回消息'),
                  h(
                    'div',
                    { className: 'qqp-v' },
                    h(Switch, {
                      checked: ov?.life?.onlyOnMessage === true,
                      label: '只回消息',
                      disabled: busy !== '' || ov === null,
                      onChange: (next) =>
                        act('wake', () => post('/wake', { on: next }), (r) => r.message ?? (next ? '已切到只回消息' : '已恢复定时唤醒')),
                    }),
                    h(
                      'span',
                      { className: 'qqp-note', style: { marginTop: 0 } },
                      ov?.life?.onlyOnMessage === true
                        ? '定时唤醒已全停：只有 @ / 关键词 / 私聊 / 提问 / 拍一拍会叫醒它'
                        : '保留回复复查、主动开话题、潜水到期三类定时唤醒',
                    ),
                  ),
                ),
                // 免打扰时段：把「只回消息」再细一层 —— 白天照常醒，夜里那段时间彻底安静。
                h(
                  'div',
                  { className: 'qqp-row' },
                  h('div', { className: 'qqp-k' }, '免打扰'),
                  h(
                    'div',
                    { className: 'qqp-v', style: { flexWrap: 'wrap', gap: '8px' } },
                    h(Switch, {
                      checked: quietCfg.enabled,
                      label: '启用免打扰时段',
                      disabled: busy !== '' || ov === null,
                      onChange: (next) =>
                        act('quiet', () => post('/quiet', { enabled: next }), (r) => r.message ?? (next ? '免打扰已开' : '免打扰已关')),
                    }),
                    quietCfg.enabled
                      ? h(
                          'span',
                          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                          h('input', {
                            className: 'qqp-input',
                            type: 'time',
                            value: quietStartValue,
                            disabled: busy !== '',
                            onChange: (e) => setQuietStart(e.target.value),
                            style: { width: '104px' },
                          }),
                          h('span', { className: 'qqp-note', style: { marginTop: 0 } }, '到'),
                          h('input', {
                            className: 'qqp-input',
                            type: 'time',
                            value: quietEndValue,
                            disabled: busy !== '',
                            onChange: (e) => setQuietEnd(e.target.value),
                            style: { width: '104px' },
                          }),
                          quietDirty
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'qqp-btn primary',
                                  disabled: busy !== '',
                                  onClick: () =>
                                    act(
                                      'quiet',
                                      () => post('/quiet', { start: quietStartValue, end: quietEndValue }),
                                      (r) => r.message ?? '免打扰时段已更新',
                                    ),
                                },
                                busy === 'quiet' ? '保存中…' : '保存',
                              )
                            : null,
                        )
                      : null,
                    quietCfg.enabled ? h('span', { className: 'qqp-note', style: { marginTop: 0 } }, '｜') : null,
                    quietCfg.enabled
                      ? h('span', { className: 'qqp-note', style: { marginTop: 0 } }, '消息也不叫它')
                      : null,
                    quietCfg.enabled
                      ? h(Switch, {
                          checked: quietCfg.muteMessages === true,
                          label: '免打扰时段里连消息也不叫它',
                          disabled: busy !== '' || ov === null,
                          onChange: (next) =>
                            act('quiet', () => post('/quiet', { muteMessages: next }), (r) => r.message ?? (next ? '这段时间连消息也不醒' : '消息照常叫醒')),
                        })
                      : null,
                    quietCfg.enabled && ov?.life?.quietNow === true
                      ? h('span', { className: 'qqp-pill warn' }, '此刻静默中')
                      : null,
                    h(
                      'span',
                      { className: 'qqp-note', style: { marginTop: 0, flexBasis: '100%' } },
                      quietNote,
                    ),
                  ),
                ),

                // 合盖保活：以上所有开关都开着、服务也都在跑，人一合上盖子机器照样睡过去。
                h(
                  'div',
                  { className: 'qqp-row' },
                  h('div', { className: 'qqp-k' }, '合盖保活'),
                  h(
                    'div',
                    { className: 'qqp-v' },
                    pw?.ok === false
                      ? h('span', { className: 'qqp-pill plain' }, '读不到电源设置')
                      : pw?.keepAwake === true
                        ? h('span', { className: 'qqp-pill ok' }, '合盖与空闲都不睡')
                        : h('span', { className: 'qqp-pill bad' }, '合盖会睡'),
                    // 两个方向都给按钮：这是个改系统电源设置的写操作，只进不出等于把开关做成单向阀。
                    pw?.ok === false || pw === undefined
                      ? null
                      : pw.keepAwake === true
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'qqp-btn',
                              disabled: busy !== '',
                              onClick: () => {
                                setModal({
                                  kind: 'confirm',
                                  title: '还原成「合盖就睡」？',
                                  hint: '这会把合盖动作改回睡眠，空闲 30 分钟睡眠、60 分钟休眠。合盖后 QQ 里就没人应了，确定要还原吗？',
                                  okText: '还原',
                                  onOk: () =>
                                    act('power', () => post('/power', { on: false }), (r) => r.message ?? '已还原成合盖就睡'),
                                })
                              },
                            },
                            busy === 'power' ? '正在写…' : '还原成合盖就睡',
                          )
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'qqp-btn',
                              disabled: busy !== '',
                              onClick: () =>
                                act('power', () => post('/power', { on: true }), (r) =>
                                  r.keepAwake === true ? '已设成合盖与空闲都不睡' : r.message ?? '写完了但没读到生效',
                                ),
                            },
                            busy === 'power' ? '正在写…' : '设成合盖不睡',
                          ),
                    pw?.scheme?.name ? h('span', { className: 'qqp-pill plain' }, `方案 ${pw.scheme.name}`) : null,
                    // 只有 AC 关掉、DC 还开着时，拔电源合盖照样会睡 —— 这半句话比一个红点有用。
                    pw?.acOnlyPartially === true ? h('span', { className: 'qqp-pill warn' }, '只有接电源时有效') : null,
                  ),
                ),
                pw?.ok !== false && pw?.keepAwake !== true
                  ? h('div', { className: 'qqp-warnbox' }, '笔记本默认合盖就睡，机器一睡面板看着正常、QQ 里却没人应。')
                  : null,
                pw?.ok === false && pw?.message ? h('div', { className: 'qqp-badbox' }, `读电源设置失败：${pw.message}`) : null,
                // 上一次拉起的结局。成功就要立刻看得见，失败更要说清是超时还是非零退出。
                run.finishedAt > 0 && run.running === false
                  ? h(
                      'div',
                      { className: 'qqp-row' },
                      h('div', { className: 'qqp-k' }, '上次拉起'),
                      h(
                        'div',
                        { className: 'qqp-v' },
                        h(
                          'span',
                          { className: `qqp-pill ${run.exitCode === 0 && run.timedOut !== true ? 'ok' : 'bad'}` },
                          run.timedOut === true ? '超时被结束' : run.exitCode === 0 ? 'exit=0' : `exit=${run.exitCode ?? '?'}`,
                        ),
                        h('span', { className: 'qqp-pill plain' }, `${run.elapsedSec ?? 0} 秒`),
                        h('span', { className: 'qqp-pill plain' }, clockOf(run.finishedAt)),
                      ),
                    )
                  : null,
                // 「为什么还不起作用」——比红点有用得多。
                (wd?.streakRestarts ?? 0) >= (wd?.maxAttempts ?? 3)
                  ? h(
                      'div',
                      { className: 'qqp-warnbox' },
                      `连续拉起 ${wd.streakRestarts} 次都没好，自动拉起已暂停 —— 多半不是掉线，而是 QQ 小号没登录或控制台令牌失效。修好后点「一键拉起」，或把「自动重启」关开一次重置计数。`,
                    )
                  : wd?.reason === 'qq'
                    ? h(
                        'div',
                        { className: 'qqp-warnbox' },
                        ov?.qq?.exe
                          ? 'QQ 客户端没在运行。点「一键拉起」会先打开 QQ 再起 SnowLuma —— 但登录那一步脚本替不了你。'
                          : 'QQ 客户端没在运行，这台机器上也没找到 QQ.exe。SnowLuma 是 hook 进 QQ 进程的，宿主不在它 hook 不上。',
                      )
                    : null,
                wd?.lastError ? h('div', { className: 'qqp-badbox' }, `最近一次失败：${wd.lastError}`) : null,
                (wd?.log ?? []).length === 0
                  ? null
                  : h(
                      'div',
                      { className: 'qqp-log', style: { marginTop: 10 } },
                      ...[...wd.log].reverse().map((entry, i) => h('div', { key: String(i) }, h('time', null, clockOf(entry.t)), h('span', null, entry.text))),
                    ),
                h('div', { className: 'qqp-note', title: wd?.restartScript ?? '' }, `脚本：${wd?.restartScript ?? '—'}`),
                ),
              ),
            ),

          // ── 02 花费与模型 ──
          h(
            Sec,
            { n: '02', id: 'spend', title: '今日花费', right: h('span', null, spend?.available === true ? '来自桥接用量账本' : '账本不可读') },
            h(
              'div',
              { className: 'qqp-big' },
              h('span', { className: 'qqp-big-num' }, money(symbol, spend?.today?.cost)),
              h('span', { className: 'qqp-big-unit' }, '今天 00:00 起（北京时间）'),
            ),
            h(
              'div',
              { className: 'qqp-metrics' },
              h('div', { className: 'qqp-metric' }, h('div', { className: 'qqp-metric-k' }, 'token'), h('div', { className: 'qqp-metric-v' }, compact(spend?.today?.tokens))),
              h('div', { className: 'qqp-metric' }, h('div', { className: 'qqp-metric-k' }, '轮次'), h('div', { className: 'qqp-metric-v' }, spend?.today?.turns === undefined || spend?.today?.turns === null ? '—' : (spend.today.turns || '0'))),
              h('div', { className: 'qqp-metric' }, h('div', { className: 'qqp-metric-k' }, '当前档位'), h('div', { className: 'qqp-metric-v' }, spend?.nowTier === 'peak' ? '高峰 ×2' : spend?.nowTier === 'off' ? '低谷' : '—')),
              h('div', { className: 'qqp-metric' }, h('div', { className: 'qqp-metric-k' }, '累计花费'), h('div', { className: 'qqp-metric-v' }, money(symbol, spend?.lifetime?.cost))),
              h('div', { className: 'qqp-metric' }, h('div', { className: 'qqp-metric-k' }, '缓存命中'), h('div', { className: 'qqp-metric-v' }, spend?.lifetime ? `${Math.round((spend.lifetime.cacheHitRate ?? 0) * 100)}%` : '—')),
            ),
            h(
              'div',
              { className: 'qqp-row', style: { marginTop: 14 } },
              h('div', { className: 'qqp-k' }, '正在使用'),
              h(
                'div',
                { className: 'qqp-v' },
                h('span', { style: { fontWeight: 600 } }, ov?.model?.label ?? ov?.model?.model ?? '—'),
                ov?.model?.label && ov?.model?.model ? h('span', { className: 'qqp-pill plain' }, ov.model.model) : null,
                ov?.model?.provider ? h('span', { className: 'qqp-pill plain' }, ov.model.provider) : null,
                ov?.model?.reasoningEffort ? h('span', { className: 'qqp-pill plain' }, `思考 ${ov.model.reasoningEffort}`) : null,
                ov?.model?.source === 'config.json' ? h('span', { className: 'qqp-pill warn' }, '读的 config.json（桥接没回）') : null,
              ),
            ),
            h(
              'div',
              { className: 'qqp-row', style: { marginTop: 10 } },
              h('div', { className: 'qqp-k' }, '锁定默认模型'),
              h(
                'div',
                { className: 'qqp-v' },
                h(Switch, {
                  checked: ov?.model?.lockDefaultModel === true,
                  label: '锁定默认模型',
                  disabled: busy !== '' || ov === null,
                  onChange: (next) =>
                    act('lock-model', () => post('/lock-model', { on: next }), (r) => r.message ?? (next ? '已锁定默认模型' : '已解锁默认模型')),
                }),
                h(
                  'span',
                  { className: 'qqp-note', style: { marginTop: 0 } },
                  ov?.model?.lockDefaultModel === true
                    ? `桥接会周期把 DSH 全局默认模型同步成 ${ov?.model?.model ?? '配置模型'}`
                    : '桥接不碰 DSH 全局默认模型，以 DSH 界面里的手动选择为准',
                ),
              ),
            ),
            (spend?.timeline ?? []).length === 0
              ? null
              : (() => {
                  const rows = spend.timeline
                  const max = Math.max(...rows.map((r) => Number(r.cost) || 0), 0.000001)
                  return h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'qqp-spark' },
                      ...rows.map((r, i) =>
                        h('i', {
                          key: String(i),
                          className: (Number(r.cost) || 0) === 0 ? 'empty' : r.tier === 'peak' ? 'peak' : '',
                          style: { height: `${Math.max(1, Math.round(((Number(r.cost) || 0) / max) * 100))}%` },
                          title: `${clockOf(r.t)} · ${money(symbol, r.cost)}`,
                        }),
                      ),
                    ),
                    h('div', { className: 'qqp-spark-x' }, h('span', null, '24 小时前'), h('span', null, '现在')),
                  )
                })(),
            h('div', { className: 'qqp-note' }, '峰值时段（工作日 09–12、14–18）单价翻倍。'),
          ),

          // ── 03 模式 ──
          h(
            Sec,
            { n: '03', id: 'mode', title: '运行模式', signal: navSignal, right: h('span', null, `当前 ${MODES.find((m) => m.id === ov?.life?.mode)?.name ?? ov?.life?.mode ?? '未知'}`) },
            h(
              'div',
              { className: 'qqp-chips' },
              ...MODES.map((m) =>
                h(
                  'span',
                  {
                    key: m.id,
                    className: `qqp-chip clk${ov?.life?.mode === m.id ? ' on' : ''}`,
                    title: m.note,
                    onClick: () =>
                      act('mode', () => post('/mode', { mode: m.id }), (r) => `模式已切到 ${r.mode}${r.dshSynced === false ? '（DSH 设置没同步上）' : ''}`),
                  },
                  m.name,
                ),
              ),
            ),
            h('div', { className: 'qqp-note' }, '离开二代仿真会清掉所有唤醒定时器。'),
          ),

          // ── 04 表情与语音 ──
          // 两节并一节：原本「表情库」和「语音与记忆」各占一屏（满屏缩略图 + 五个状态行 +
          // 念一句表单 + 音频列表 + 记忆三行），加起来太重。合并后默认收起，展开也只有
          // 两栏紧凑网格；记忆挪到这一节末尾的三行小字（它本来就是只读的，不值得单独一节）。
          h(
            Sec,
            {
              n: '04',
              id: 'media',
              title: '表情与语音',
              defaultOpen: false,
              signal: navSignal,
              right: mediaSummary === '' ? null : h('span', null, mediaSummary),
            },
            stickers === null
              ? h('div', { className: 'qqp-empty' }, '读表中…')
              : h(StickerSection, {
                  data: stickers,
                  busy,
                  dirScan,
                  autoScan,
                  onAutoScan: setAutoScan,
                  onScan: () =>
                    act('scan', () => loadScan(true), (r) =>
                      r.adoptedTotal > 0 ? `收进 ${r.adoptedTotal} 张新图` : '目录里没有新图',
                    ).then(() => {
                      loadStickers()
                      // 扫完顺手清一次死条目：图片被删掉的那些记录不该继续占着位置。
                      pruneStickers()
                    }),
                  onZoom: setZoomed,
                  onSync: () => act('sync', () => post('/stickers/sync', {}), (r) => `已同步 ${r.total ?? 0} 张`).then(() => {
                    loadStickers()
                    pruneStickers()
                  }),
                  // 备注直接在面板里写：这是「AI 看图之后留下的唯一线索」，
                  // 让人能改比让 AI 自己写更有用（AI 写错了人得能修）。
                  // 注意用插件内模态而不是 window.prompt —— Electron 里后者不弹框。
                  onNote: (s) =>
                    setModal({
                      kind: 'note',
                      title: '给这张表情写一句备注',
                      hint: '它长什么样、什么时候用。AI 挑表情时就靠这句话判断合不合适。',
                      value: s.localNote || s.desc || '',
                      sticker: s,
                    }),
                  // 删掉一张表情：删完立刻清死条目，界面跟着刷新。
                  onRemove: (s) =>
                    setModal({
                      kind: 'confirm',
                      title: '删掉这张表情？',
                      hint: `${s.localNote || s.desc || s.id}\n只从本地表情库移除，不动 QQ 账号里的收藏。`,
                      okText: '删掉',
                      onOk: () =>
                        act(`rm-${s.id}`, async () => {
                          await post('/stickers/remove', { stickerId: s.id })
                          return pruneStickers()
                        }, '已删除').then(() => loadStickers()),
                    }),
                }),
            // 语音那块：caps/voices 都还没回来就先不画，避免闪一行「读表中」。
            caps === null && voices === null ? null : voiceBlock,
          ),

          // ── 05 会话管理 ──
          h(
            Sec,
            {
              n: '05',
              id: 'sessions',
              title: '会话',
              signal: navSignal,
              right:
                sessions === null
                  ? null
                  : h('span', null, `群 ${(sessions.groups ?? []).length} · 私聊 ${(sessions.private ?? []).length}`),
            },
            sessions === null
              ? h('div', { className: 'qqp-empty' }, '读表中…')
              : h(SessionSection, {
                  data: sessions,
                  busy,
                  onZoom: setZoomed,
                  onAdd: () => loadSessions(),
                  onSave: (payload) =>
                    act('sess', () => post('/sessions', payload), (r) => r.message ?? '已保存').then((r) => loadSessions()),
                }),
          ),

          // ── 06 人格 ──
          h(
            Sec,
            {
              n: '06',
              id: 'roles',
              title: '人格',
              signal: navSignal,
              right:
                roles === null
                  ? null
                  : h('span', null, `${(roles.roles ?? []).length} 份${roles.current ? ` · 当前 ${roles.current}` : ''}`),
            },
            roles === null
              ? h('div', { className: 'qqp-empty' }, '读表中…')
              : h(RoleSection, {
                  data: roles,
                  busy,
                  draft: roleDraft,
                  onNew: () => setRoleDraft({ name: '', original: '', content: '', isNew: true, warnings: [] }),
                  onPick: (name) =>
                    act('role-load', async () => {
                      const r = await post('/roles/content', { name })
                      if (r.ok === false) return r
                      setRoleDraft({ name, original: name, content: r.content ?? '', isNew: false, warnings: r.warnings ?? [] })
                      return { ok: true }
                    }),
                  onChange: (next) => setRoleDraft(next),
                  onSave: () =>
                    act(
                      'role-save',
                      async () => {
                        const r = await post('/roles/save', {
                          name: roleDraft.name,
                          content: roleDraft.content,
                          mode: roleDraft.isNew ? 'create' : 'update',
                        })
                        if (r.ok === false) return r
                        setRoleDraft({ ...roleDraft, original: roleDraft.name, isNew: false })
                        return r
                      },
                      (r) => (r.created ? `已创建「${r.role}」` : `已保存「${r.role}」（${r.chars} 字）`),
                    ).then(() => loadRoles()),
                  onRename: (from, to) =>
                    act('role-save', () => post('/roles/rename', { from, to }), (r) => `已改名为「${r.role}」`).then(() => loadRoles()),
                  onDelete: (name) =>
                    setModal({
                      kind: 'confirm',
                      title: `删除人格「${name}」？`,
                      hint: 'roles 目录下的文件会被直接删掉，不能撤销。',
                      okText: '删掉',
                      onOk: () =>
                        act('role-save', () => post('/roles/delete', { name }), `已删除「${name}」`).then(() => {
                          if (roleDraft?.original === name) setRoleDraft(null)
                          loadRoles()
                        }),
                    }),
                  onActivate: (name) => {
                    // 「清除当前人格」是破坏性的：清空后大肥鱼没有任何角色卡约束。
                    // 启用人格不确认（可再切回来），清除要确认。
                    if (name === '') {
                      setModal({
                        kind: 'confirm',
                        title: '清除当前人格？',
                        hint: '清空后桥接的 role 会变成空，大肥鱼不再有角色卡约束（文件不会删，随时可以再启用）。',
                        okText: '清除',
                        onOk: () =>
                          act('role-save', () => post('/roles/activate', { role: null }), '已清除当前人格').then(() => loadRoles()),
                      })
                      return
                    }
                    act('role-save', () => post('/roles/activate', { role: name }), `已启用「${name}」`).then(() => loadRoles())
                  },
                }),
          ),

          // ── 08 眼睛（界面上已摘掉）──
          // 这一节原本完整实现在下面（EyesSection），现在不渲染：它靠控制台令牌从外面看 QQ，
          // 与「会话」「表情」两节信息重叠，打开还要拉全量消息，日常用不上。
          // 想临时用回来：把这一行 `null` 换成 `h(EyesSection, {...})` 即可（host 的 /eyes 路由一直在）。
          null,


          toastMsg === '' ? null : h('div', { className: 'qqp-toast' }, toastMsg),
          zoomed === ''
            ? null
            : h(
                'div',
                { className: 'qqp-lightbox', onClick: () => setZoomed('') },
                h('img', { src: zoomed, alt: '放大查看', onClick: (e) => e.stopPropagation() }),
              ),
          modal === null ? null : h(Modal, { modal, busy, onClose: () => setModal(null), onSubmit: submitModal }),
        ),
      )
    }

    // ── 表情库 + 表情工坊（原来分两节，信息大量重复，合并成一节）──────────
    function StickerSection(props) {
      const {
        data, busy, dirScan, autoScan,
        onSync, onNote, onZoom, onScan, onAutoScan, onRemove,
      } = props
      const items = data?.stickers ?? []
      // 列表里可能有「记录还在、图已经没了」的条目（图片文件被删掉、或 QQ 侧撤了收藏）。
      // host 半会给这类条目 hasPreview:false 且 url 为空 —— 这里直接把它们藏起来，
      // 不要画成一个「没有预览地址」的空格子。
      const visible = items.filter((s) => s.hasPreview !== false && s.url !== '')
      const nowhere = visible.length === 0
      // 表情网格是可折叠的：26 张表情铺满屏太占地方，默认只露出前 SHOW_INITIAL 张。
      // 「展开全部 / 收起」是同一个按钮来回切 —— 用户要求「不要一直展开表情包，显得占空间」。
      const [gridOpen, setGridOpen] = useState(false)
      const SHOW_INITIAL = 6
      const shown = gridOpen ? visible : visible.slice(0, SHOW_INITIAL)
      const hidden = Math.max(0, visible.length - shown.length)
      return h(
        'div',
        null,
        // 文件位置压成一行：三行 br 分隔在合并后的紧凑节里太占地方，
        // 「来源」「只读」这两种异常状态才追加说明 —— 正常时不必占位。
        h(
          'div',
          { className: 'qqp-path' },
          h('b', null, '库存 '),
          data?.file ?? 'state/stickers.json',
          ' · ',
          h('b', null, '目录 '),
          data?.dir ? `${data.dir}\\stickers` : 'state/stickers',
          data?.source === 'file' ? ' · 本地文件（桥接没回话）' : '',
          data?.writable === false ? ' · 只读' : '',
        ),
        // 四格指标压成一行小字：表情总数与节标题右侧的摘要重复，这里只留会变的那几个。
        h(
          'div',
          { className: 'qqp-note', style: { marginTop: 6 } },
          `上限 ${data?.maxCount ?? '—'} · 本次匹配 ${data?.matched ?? '—'}` +
            (data?.syncedAt ? ` · 上次同步 ${clockOf(data.syncedAt)}` : ''),
        ),
        data?.message ? h('div', { className: 'qqp-warnbox' }, data.message) : null,

        // ── 收表情进来：两个来源本来散在两处（QQ 收藏在底部、本地目录在中间），
        // 但它们是同一件事「把外面的表情收进库」，所以并成一块，按钮也排在一行里。
        h(
          'div',
          { className: 'qqp-group' },
          h(
            'div',
            { className: 'qqp-group-h' },
            h('span', null, '收表情进来'),
            h('span', { className: 'qqp-sec-r', style: { marginLeft: 'auto' } },
              h('span', { style: { fontSize: 11 } }, '自动读目录'),
              h(Switch, { checked: autoScan === true, onChange: onAutoScan, label: '自动读取本地目录' })),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
            h('button', { className: 'qqp-btn', disabled: busy === 'sync', onClick: onSync }, busy === 'sync' ? '同步中…' : '从 QQ 同步'),
            h('button', { className: 'qqp-btn', disabled: busy === 'scan', onClick: onScan }, busy === 'scan' ? '扫描中…' : '扫本地目录'),
            dirScan === null
              ? null
              : h('span', { className: 'qqp-note', style: { marginTop: 0 } },
                  `目录 ${dirScan.total ?? 0} 个文件 · 待入库 ${dirScan.pending ?? 0}` +
                    (dirScan.adoptedTotal > 0 ? ` · 刚收了 ${dirScan.adoptedTotal} 张` : '') +
                    (dirScan.scanAt ? ` · ${clockOf(dirScan.scanAt)}` : '')),
          ),
          (dirScan?.skipped ?? []).length > 0
            ? h('div', { className: 'qqp-warnbox', style: { marginTop: 8 } },
                `有 ${dirScan.skipped.length} 个文件没收：` + dirScan.skipped.slice(0, 3).map((x) => `${x.name}（${x.reason}）`).join('；'))
            : null,
        ),

        nowhere
          ? h('div', { className: 'qqp-empty' }, '表情库是空的。去 QQ 里收藏几张表情点「从 QQ 同步」；往目录里丢图；或者在下面自己画一张。')
          : h(
              'div',
              { className: 'qqp-grid' },
              ...shown.map((s) =>
                h(
                  'div',
                  { key: s.id, className: 'qqp-tile' },
                  h('img', { className: 'qqp-thumb', src: s.url, alt: s.desc || s.id, loading: 'lazy', onClick: () => onZoom(s.url) }),
                  h(
                    'div',
                    { className: 'qqp-tile-h' },
                    h('span', { className: 'qqp-mono', style: { fontSize: 9, opacity: 0.6 } }, `#${s.id}`),
                  ),
                  h(
                    'div',
                    { className: 'qqp-tile-b' },
                    // QQ 自带的名字（desc）和人写的备注（localNote）是两回事：前者往往只是
                    // 「[表情]」这类占位，后者才是 AI 判断合不合用的线索。原来写成
                    // `s.desc || s.localNote` 等于「有 desc 就永远看不到备注」，得分开显示。
                    // 格子缩到 62px 之后只留一行备注（原图名塞进 title，鼠标停上去能看），
                    // 标签也只在 title 里露 —— 挤在 9px 的方格里全是噪点。
                    s.localNote
                      ? h('div', { title: s.desc ? `原图名：${s.desc}` : '' }, s.localNote)
                      : s.desc
                        ? h('div', { title: s.desc }, s.desc)
                        : h('div', { style: { opacity: 0.6 } }, '（未写备注）'),
                    // 一行放得下：次数 + 改备注 + 删。按钮缩成单字，靠 title 说明。
                    h(
                      'div',
                      { style: { marginTop: 3, display: 'flex', gap: 3, alignItems: 'center' } },
                      h('span', { className: 'qqp-mono', style: { fontSize: 9, opacity: 0.55 }, title: `已用 ${s.useCount ?? 0} 次` }, `×${s.useCount ?? 0}`),
                      h(
                        'button',
                        {
                          className: 'qqp-chip clk',
                          style: { marginLeft: 'auto', padding: '0 4px', fontSize: 9, lineHeight: '15px' },
                          title: '写备注（AI 挑表情时就靠这句话）',
                          disabled: busy === `note-${s.id}`,
                          onClick: () => onNote(s),
                        },
                        busy === `note-${s.id}` ? '…' : '改',
                      ),
                      h(
                        'button',
                        {
                          className: 'qqp-chip clk',
                          style: { padding: '0 4px', fontSize: 9, lineHeight: '15px' },
                          title: '从本地表情库删掉（不动 QQ 收藏）',
                          disabled: busy === `rm-${s.id}`,
                          onClick: () => onRemove(s),
                        },
                        '删',
                      ),
                    ),
                  ),
                ),
              ),
            ),
        // 表情网格的折叠：同一个按钮来回切（展开全部 ⇄ 收起）。
        // 表情多了铺满屏太占地方，所以默认只露前 SHOW_INITIAL 张。
        nowhere || visible.length <= SHOW_INITIAL
          ? null
          : h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
              h(
                'button',
                {
                  className: 'qqp-btn',
                  'aria-expanded': gridOpen ? 'true' : 'false',
                  onClick: () => setGridOpen((v) => !v),
                },
                gridOpen ? '收起' : `展开全部 ${visible.length} 张`,
              ),
              h('span', { className: 'qqp-note', style: { marginTop: 0 } },
                gridOpen ? `全部 ${visible.length} 张都在这` : `只露了前 ${shown.length} 张，还有 ${hidden} 张`),
            ),
        h('div', { className: 'qqp-note' }, '备注是 AI 看图后留下的唯一线索：下次它要发这张表情时，靠这段字判断合不合适。写得越具体越好用。'),
      )
    }

    // ── 会话管理 ────────────────────────────────────────────────────────
    function SessionSection({ data, busy, onSave, onAdd, onZoom }) {
      const [draftGroup, setDraftGroup] = useState('')
      const [draftPrivate, setDraftPrivate] = useState('')
      const groups = data?.groups ?? []
      const privateList = data?.private ?? []
      const addTo = (list, id, kind) => {
        const text = String(id ?? '').trim()
        if (!/^\d{5,20}$/.test(text)) return
        if (list.some((x) => x.id === text)) return
        onSave({ groups: [...(kind === 'group' ? [...groups.map((g) => g.id), text] : groups.map((g) => g.id))], private: [...(kind === 'private' ? [...privateList.map((p) => p.id), text] : privateList.map((p) => p.id))] })
      }
      const remove = (id, kind) =>
        onSave({
          groups: kind === 'group' ? groups.map((g) => g.id).filter((x) => x !== id) : groups.map((g) => g.id),
          private: kind === 'private' ? privateList.map((p) => p.id).filter((x) => x !== id) : privateList.map((p) => p.id),
        })
      const row = (item) =>
        h(
          'div',
          { key: item.key, className: `qqp-li${item.hasState ? ' on' : ''}` },
          h('span', { className: `qqp-dot ${item.hasState ? 'ok' : 'idle'}` }),
          h('span', { className: 'who qqp-mono' }, item.key),
          h(
            'span',
            { className: 'what' },
            item.hasState
              ? `未读 ${item.unread} · 近期 ${item.recentCount} 条 · 唤醒 ${item.wakeCount} 次${item.lastWakeReason ? ` · 最近因 ${item.lastWakeReason}` : ''}`
              : '还没产生过会话状态（还没收发过消息）',
          ),
          h('button', { className: 'qqp-chip clk', onClick: () => remove(item.id, item.kind) }, '移除'),
        )
      // 群与私聊并排成左右两列：两边是同构的四件套（标题 / 列表 / 新增行），
      // 竖着排会白占一倍高度，而它们本来可以同时看见。
      const column = (label, list, draft, setDraft, kind, placeholder, emptyText) =>
        h(
          'div',
          { className: 'qqp-col' },
          h('div', { className: 'qqp-sub' }, `${label}（${list.length}）`),
          list.length === 0
            ? h('div', { className: 'qqp-empty' }, emptyText)
            : h('div', { className: 'qqp-list' }, ...list.map(row)),
          h(
            'div',
            { className: 'qqp-row', style: { borderTop: 'none', paddingTop: 0, marginTop: 8 } },
            h(
              'div',
              { className: 'qqp-v' },
              h('input', { className: 'qqp-input', style: { flex: '1 1 90px' }, value: draft, placeholder, onChange: (e) => setDraft(e.target.value) }),
              h('button', { className: 'qqp-btn', disabled: busy === 'sess' || !/^\d{5,20}$/.test(draft.trim()), onClick: () => { addTo(list, draft, kind); setDraft('') } }, '加入'),
            ),
          ),
        )
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'qqp-path' },
          h('b', null, '白名单文件 '),
          data?.file ?? 'config.json',
          ' → allow.groups / allow.private · ',
          // 原来是一条整宽的 warnbox（12px 字号、上下 9px 内边距），改成行内小字：
          // 这条提醒每次进面板都要看一遍，但它不该占掉一整行的高度。
          h('span', { className: 'qqp-warn-inline' }, '改完要点「一键拉起」才生效'),
        ),
        h(
          'div',
          { className: 'qqp-cols2', style: { marginTop: 10 } },
          column('QQ 群', groups, draftGroup, setDraftGroup, 'group', '群号，比如 123456789', '还没加任何群。'),
          column('私聊', privateList, draftPrivate, setDraftPrivate, 'private', 'QQ 号', '还没加任何私聊。'),
        ),
        h('div', { className: 'qqp-note' }, '管理员 QQ 不受白名单约束，是单独一项（overview 里的 ownerQQ）。'),
      )
    }

    // ── 人格管理 ────────────────────────────────────────────────────────
    function RoleSection({ data, busy, draft, onPick, onChange, onSave, onRename, onDelete, onActivate, onNew }) {
      const roles = data?.summaries ?? []
      const lim = data?.limits ?? {}
      const content = draft?.content ?? ''
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'qqp-path' },
          h('b', null, '人格目录 '),
          data?.file ?? 'roles',
          h('br'),
          h('b', null, '命名上限 '),
          `${lim.nameMax ?? '?'} 字`,
          h('b', null, ' · 正文上限 '),
          `${lim.contentMaxBytes ?? '?'} 字节`,
          h('b', null, ' · 注入上限 '),
          `${lim.injectMaxChars ?? '?'} 字`,
        ),
        data?.bridgeDown ? h('div', { className: 'qqp-warnbox' }, data.message ?? '桥接不可达，读不到人格列表。') : null,
        h(
          'div',
          { className: 'qqp-list' },
          ...roles.map((r) =>
            h(
              'div',
              { key: r.name, className: `qqp-li${data?.current === r.name ? ' on' : ''}${draft?.name === r.name ? ' on' : ''}` },
              h('span', { className: `qqp-dot ${data?.current === r.name ? 'ok' : 'idle'}` }),
              h('span', { className: 'who' }, r.name),
              h('span', { className: 'what qqp-num' }, `${r.chars ?? 0} 字` + ((r.warnings ?? []).length > 0 ? ` · ${r.warnings.length} 条提醒` : '')),
              data?.current === r.name ? h(Pill, { tone: 'ok' }, '启用中') : null,
              h('button', { className: 'qqp-chip clk', onClick: () => onPick(r.name) }, '编辑'),
              h('button', { className: 'qqp-chip clk', onClick: () => onActivate(r.name) }, '启用'),
              h('button', { className: 'qqp-chip clk', onClick: () => onDelete(r.name) }, '删除'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'qqp-row' },
          h('div', { className: 'qqp-k' }, '人格'),
          h(
            'div',
            { className: 'qqp-v' },
            h('button', { className: 'qqp-btn', onClick: onNew }, '新建一份'),
            h('button', { className: 'qqp-btn', onClick: () => onActivate('') }, '清除当前人格'),
          ),
        ),
        draft === null
          ? h('div', { className: 'qqp-empty' }, '点上面任何一行的「编辑」载入正文。')
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'qqp-row' },
                h('div', { className: 'qqp-k' }, '名字'),
                h(
                  'div',
                  { className: 'qqp-v' },
                  h('input', { className: 'qqp-input', style: { flex: '1 1 180px' }, value: draft.name, placeholder: '比如 小鲸鱼', onChange: (e) => onChange({ ...draft, name: e.target.value }) }),
                  draft.isNew ? h(Pill, { tone: 'warn' }, '新建') : h('button', { className: 'qqp-chip clk', disabled: draft.name === draft.original, onClick: () => onRename(draft.original, draft.name) }, '改名'),
                  h(Pill, { tone: 'plain' }, `${content.length} 字`),
                ),
              ),
              h('textarea', {
                className: 'qqp-editor',
                value: content,
                placeholder: '人格正文。Markdown 与【小节标题】都支持 —— 桥接按小节决定注入哪些。',
                onChange: (e) => onChange({ ...draft, content: e.target.value }),
              }),
              (draft.warnings ?? []).length > 0
                ? h('div', { className: 'qqp-warnbox' }, ...draft.warnings.map((w, i) => h('div', { key: i }, w)))
                : null,
              h(
                'div',
                { className: 'qqp-row' },
                h('div', { className: 'qqp-k' }, '保存'),
                h(
                  'div',
                  { className: 'qqp-v' },
                  h('button', { className: 'qqp-btn primary', disabled: busy === 'role-save', onClick: onSave }, busy === 'role-save' ? '保存中…' : draft.isNew ? '创建' : '保存正文'),
                  h('span', { className: 'qqp-note', style: { marginTop: 0 } }, '保存后立刻生效：下一轮对话就会用新人格，不用重启。'),
                ),
              ),
            ),
      )
    }

    // ── 眼睛 ────────────────────────────────────────────────────────────
    function EyesSection({ data, busy, chosen, onChoose, onLoad, onImage }) {
      const convs = data?.conversations ?? []
      const msgs = data?.messages ?? []
      return h(
        'div',
        null,
        h('div', { className: 'qqp-note', style: { marginTop: 0 } }, '借控制台令牌从外面看 QQ，不改变 AI 自己的会话隔离。'),
        data?.bridgeDown ? h('div', { className: 'qqp-warnbox' }, data.message ?? '桥接不可达，读不到会话。') : null,
        h(
          'div',
          { className: 'qqp-list' },
          ...convs.map((c) =>
            h(
              'div',
              { key: c.key, className: `qqp-li${chosen === c.key ? ' on' : ''}` },
              h('span', { className: `qqp-dot ${c.unread > 0 ? 'warn' : 'ok'}` }),
              h('span', { className: 'who qqp-mono' }, c.key),
              h('span', { className: 'what' }, `未读 ${c.unread} · 内存里 ${c.recentCount} 条 · 唤醒 ${c.wakeCount} 次 · ${c.wakeMode ?? '?'}`),
              h('button', { className: 'qqp-chip clk', 'aria-expanded': chosen === c.key ? 'true' : 'false', onClick: () => onChoose(c.key) }, chosen === c.key ? '收起' : '看这个'),
            ),
          ),
        ),
        convs.length === 0 ? h('div', { className: 'qqp-empty' }, '桥接还没记录任何会话。') : null,
        chosen === ''
          ? h('div', { className: 'qqp-empty' }, '选一个会话，把它的消息摊开看。')
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'qqp-row' },
                h('div', { className: 'qqp-k' }, '正在看'),
                h(
                  'div',
                  { className: 'qqp-v' },
                  h('span', { className: 'qqp-mono' }, chosen),
                  h(Pill, { tone: 'plain' }, `${msgs.length} 条`),
                  h('button', { className: 'qqp-btn', disabled: busy === 'eyes', onClick: onLoad }, busy === 'eyes' ? '读取中…' : '刷新'),
                ),
              ),
              data?.messageError ? h('div', { className: 'qqp-warnbox' }, `读消息失败：${data.messageError}`) : null,
              msgs.length === 0
                ? h('div', { className: 'qqp-empty' }, '这个会话没有消息（或桥接只保留了最近的若干条）。')
                : h(
                    'div',
                    { className: 'qqp-list' },
                    ...msgs.map((m) =>
                      h(
                        'div',
                        { key: `${m.index}-${m.messageId ?? ''}`, className: `qqp-msg${m.isSelf ? ' self' : ''}` },
                        h(
                          'div',
                          { className: 'qqp-msg-h' },
                          h('span', { style: { color: 'inherit', fontWeight: 600 } }, m.sender || '(无名)'),
                          m.isSelf ? h(Pill, { tone: 'ok' }, '我') : null,
                          m.isOwner ? h(Pill, { tone: 'warn' }, '主人') : null,
                          h('span', { className: 'qqp-num', style: { marginLeft: 'auto' } }, m.time ? clockOf(m.time) : '—'),
                        ),
                        m.text ? h('div', { className: 'qqp-msg-b' }, m.text) : null,
                        m.hasImage
                          ? h(
                              'div',
                              { className: 'qqp-msg-imgs' },
                              ...(m.images ?? []).map((img, i) =>
                                img.url && /^https?:/i.test(img.url)
                                  ? h('img', { key: i, src: img.url, alt: img.summary || '图', loading: 'lazy', onClick: () => onImage(img.url) })
                                  : h(
                                      'button',
                                      { key: i, className: 'qqp-chip clk', disabled: busy === `img-${m.messageId}`, onClick: () => onImage(m) },
                                      busy === `img-${m.messageId}` ? '取图中…' : `看这张图${img.summary ? ` · ${img.summary}` : ''}`,
                                    ),
                              ),
                              (m.images ?? []).length === 0 && m.messageId !== null
                                ? h('button', { className: 'qqp-chip clk', disabled: busy === `img-${m.messageId}`, onClick: () => onImage(m) }, busy === `img-${m.messageId}` ? '取图中…' : '有图，点开看')
                                : null,
                            )
                          : null,
                      ),
                    ),
                  ),
            ),
      )
    }

    // ── 语音与记忆（只读说明）───────────────────────────────────────────
    //
    // 这一节存在的理由：截图里小鲸鱼说「记忆是有的，但现在是空的」「语音那栏还是关着的，
    // 想开口也没东西可放」。人看了会以为坏了。实际两条都是设计如此：
    //   · 语音：开关默认关、目录不存在、ffmpeg 没装 —— 逐条说清缺什么，别给个点了没反应的按钮。
    //   · 记忆：按会话 key 存，换会话就是另一份 —— 这是作用域，不是故障。
    /**
     * 11 语音与记忆。
     *
     * 语音这一半是**可操作**的：列语音库、用本机 TTS 念一句、试听、删、试着发一条。
     * 记忆那一半仍是**只读**（写入权在 AI 手里）。
     *
     * 为什么有能力体检还留着：操作者通道（面板试发）和 AI 通道（AI 自己开口）是两回事。
     *  `voice.enabled` / `tools.sendVoice` 只挡后者 —— 面板即使两个开关都关着也能试发，
     * 这一点原来那版说成「还不能发」是错的，会让人以为整条链路都通不了。
     */
    function VoiceSection({
      caps, voices, busy, ttsText, onTtsText, voiceKey, onVoiceKey, voiceKeys, voiceTries,
      engine, voice, rate, onEngine, onVoice, onRate, onPreviewVoice,
      onSpeak, onDeleteVoice, onPlay, onCheck, onSend, onRefresh,
    }) {
      const v = caps?.voice ?? {}
      const m = caps?.memory ?? {}
      const tts = v.tts ?? {}
      const edge = voices?.edge ?? {}
      const kokoro = voices?.kokoro ?? {}
      const breeze = voices?.breeze ?? {}
      const kokoroVoices = kokoro.voices ?? []
      const edgeVoices = edge.voices ?? []
      const sapiVoices = tts.voices ?? []
      const kokoroOk = kokoro.available === true && kokoroVoices.length > 0
      const edgeOk = edge.available === true && edgeVoices.length > 0
      const sapiOk = tts.available === true && sapiVoices.length > 0
      const breezeOk = breeze.available === true
      const voiceOk = engine === 'kokoro' ? kokoroOk : engine === 'edge' ? edgeOk : engine === 'breeze' ? breezeOk : sapiOk
      const voiceList = engine === 'kokoro' ? kokoroVoices : engine === 'edge' ? edgeVoices : sapiVoices
      const engineName = engine === 'kokoro' ? 'Kokoro 本机离线' : engine === 'edge' ? 'Edge 在线' : engine === 'breeze' ? 'Breezeblue 云端' : '本机 SAPI'
      const voiceName = (voiceList.find((x) => x.id === voice) ?? {}).name ?? ''
      const files = voices?.files ?? []
      const canTry = v.canSendNow === true
      const dot = (flag) => h('span', { className: `qqp-dot ${flag ? 'ok' : 'bad'}` })
      // 现状压成一行：原来五条列表（音频目录 / 本机合成 / voice.enabled / sendVoice / ffmpeg）
      // 各占一行，一屏很快就没了。改成「点 + 名 + 值」的横排，该看的字一个不少。
      const fact = (label, value, ok) =>
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
          dot(ok),
          h('span', { style: { color: 'var(--k-mute)' } }, label),
          h('span', { className: 'qqp-mono' }, value))
      return h(
        'div',
        null,
        // ── 语音：现状 ──
        h('div', { className: 'qqp-group-h', style: { marginBottom: 8 } },
          h('span', null, '语音'),
          h(Pill, { tone: canTry ? 'ok' : 'warn' }, canTry ? '可以试发' : '还没有可发的音频'),
          v.aiCanSend === true ? h(Pill, { tone: 'ok' }, 'AI 能自己开口') : h(Pill, { tone: 'plain' }, 'AI 还不会自己开口')),
        h(
          'div',
          { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, marginBottom: 6 } },
          fact('音频', v.audioExists ? `${v.audioCount ?? 0} 个` : '缺', v.audioExists && (v.audioCount > 0 || sapiVoices.length > 0)),
          fact('本机合成', tts.available === false ? (tts.reason || '跑不起来') : `${sapiVoices.length} 音色`, sapiOk),
          fact('AI 开口', v.enabled === true && v.toolOn === true ? '开' : '关', v.enabled === true && v.toolOn === true),
          fact('ffmpeg', v.ffmpegFound === true ? '有' : '没装', v.ffmpegFound === true),
          h('span', { className: 'qqp-mono', style: { opacity: 0.6 } }, v.audioDir ?? 'audio'),
        ),
        (v.hint ?? '') !== '' || (v.blockers ?? []).length > 0
          ? h('div', { className: 'qqp-note', style: { marginTop: 6, opacity: 0.85 } },
            v.hint ?? '',
            (v.blockers ?? []).length > 0 ? `　缺：${v.blockers.join('；')}` : '')
          : null,

        // ── 语音：念一句（含音色选择）──
        h('div', { className: 'qqp-group', style: { marginTop: 14 } },
          h('div', { className: 'qqp-group-h', style: { marginBottom: 8 } },
            h('span', null, '念一句'),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--k-mute)' } },
              engineName + (voiceName ? ` · ${voiceName}` : ''))),
          // 引擎 + 音色 + 语速 三件套。换音色会立刻存到本机，下次开面板还是它。
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
            h('select', {
              className: 'qqp-input',
              style: { width: 'auto', minWidth: 128 },
              value: engine,
              onChange: (e) => onEngine(e.target.value),
            },
              h('option', { value: 'kokoro' }, `Kokoro 离线${kokoroOk ? '' : '（不可用）'}`),
              h('option', { value: 'edge' }, `Edge 在线${edgeOk ? '' : '（不可用）'}`),
              h('option', { value: 'breeze' }, `Breezeblue 云端${breezeOk ? '' : '（未配）'}`),
              h('option', { value: 'sapi' }, '本机 SAPI'),
            ),
            (engine === 'kokoro' || engine === 'edge')
              ? h('select', {
                className: 'qqp-input',
                style: { width: 'auto', minWidth: 210 },
                value: voice,
                onChange: (e) => onVoice(e.target.value),
              },
                ...voiceList.map((x) => h('option', { key: x.id, value: x.id }, `${x.name}（${x.gender}）${x.note ?? ''}`)))
              : engine === 'breeze'
                ? h('span', { style: { fontSize: 12, color: 'var(--k-mute)' } },
                  `音色：你设计的克隆音色（${breeze.voiceId ?? '未配'}）`)
                : h('span', { style: { fontSize: 12, color: 'var(--k-mute)' } },
                  `音色：${(sapiVoices.map((x) => x.name).join(' / ')) || '无'}`),
            h('span', { style: { fontSize: 12, color: 'var(--k-mute)' } }, '语速'),
            h('input', {
              className: 'qqp-input',
              type: 'range',
              min: -30,
              max: 30,
              step: 2,
              value: rate,
              style: { width: 110, accentColor: 'var(--k-accent)' },
              onChange: (e) => onRate(Number(e.target.value)),
            }),
            h('span', { className: 'qqp-mono', style: { fontSize: 11, width: 42 } }, `${rate > 0 ? '+' : ''}${rate}%`),
            h('button', {
              className: 'qqp-chip clk',
              disabled: busy === 'preview' || !voiceOk,
              onClick: onPreviewVoice,
            }, busy === 'preview' ? '念着…' : '试听'),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
            h('textarea', {
              className: 'qqp-input',
              style: { flex: '1 1 auto', minHeight: 58, resize: 'vertical', fontFamily: 'inherit' },
              value: ttsText,
              maxLength: 2000,
              placeholder: '想让它说什么（最多 2000 字）',
              onChange: (e) => onTtsText(e.target.value),
            }),
            h('button', {
              className: 'qqp-btn primary',
              disabled: busy === 'tts' || ttsText.trim() === '' || !voiceOk,
              onClick: onSpeak,
            }, busy === 'tts' ? '念着…' : '念一句'),
          ),
          h('div', { className: 'qqp-note', style: { marginTop: 6, opacity: 0.75 } },
            engine === 'kokoro'
              ? kokoroOk
                ? 'Kokoro 在本机离线合成，真实女声、不用联网。第一次念要加载模型（约 4 秒），之后常驻秒回。'
                : `Kokoro 用不了：${kokoro.reason || '模型或 sherpa-onnx-node 没装齐'}`
              : engine === 'edge'
                ? edgeOk
                  ? 'Edge 语音要联网，音色是播音腔。音色选了就记住；念出来落在语音库里，可直接试发。'
                  : `Edge 用不了：${edge.reason || '本机没装 @andresaya/edge-tts'}　可以切到「Kokoro 离线」。`
                : engine === 'breeze'
                  ? breezeOk
                    ? 'Breezeblue 用你设计的克隆音色云端合成（要联网 + 耗 key 额度）。给大肥鱼开了「嘴」：回复文字时按概率让独立会话顺着刚才的文字补一句语音，再用这个音色合成发出去。'
                    : `Breezeblue 没配好：${breeze.reason || '检查 config.json 的 socialV2.voice.breeze'}`
                  : sapiOk
                    ? 'SAPI 离线可用，但中文只有慧慧一个声音，听着像播报。想真实点切 Kokoro。'
                    : `SAPI 用不了：${tts.reason || '本机没有中文语音包'}`,
            ttsText.length > 0
              ? h('span', null, `　·　${ttsText.length} 字，大约 ${Math.max(1, Math.round(ttsText.length / 4))} 秒`)
              : null),
        ),

        // ── 语音：库 ──
        h('div', { className: 'qqp-group', style: { marginTop: 14 } },
          h('div', { className: 'qqp-group-h', style: { marginBottom: 8 } },
            h('span', null, '语音库'),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--k-mute)' } },
              voices === null ? '读表中…' : `${files.length} 段`),
            h('button', { className: 'qqp-chip clk', style: { marginLeft: 8 }, onClick: onRefresh }, '刷新')),
          files.length === 0
            ? h('div', { className: 'qqp-empty' },
              '空的。上面「念一句」现攒一段，或把音频丢进 ',
              h('span', { className: 'qqp-mono' }, voices?.dir ?? v.audioDir ?? 'audio'),
              ' 再点刷新。')
            : h('div', { className: 'qqp-list' },
              ...files.map((f) => {
                const url = `${f.url}${voiceTries[f.name] ? `&t=${voiceTries[f.name]}` : ''}`
                return h('div', { key: f.name, className: 'qqp-li', style: { flexWrap: 'wrap', gap: 8 } },
                  h('span', { className: 'who qqp-mono', style: { flex: '0 0 auto' } }, f.name),
                  h('span', { className: 'what' }, bytesText(f.bytes)),
                  h('audio', {
                    controls: true,
                    preload: 'none',
                    src: url,
                    style: { height: 28, flex: '1 1 220px', minWidth: 160 },
                  }),
                  h('button', {
                    className: 'qqp-chip clk',
                    disabled: busy === `chk-${f.name}` || voiceKey === '',
                    title: voiceKey === '' ? '先在下面选一个要发到哪' : `只校验能不能发到 ${voiceKey}，不真发`,
                    onClick: () => onCheck(f.name),
                  }, busy === `chk-${f.name}` ? '验着…' : '先验一下'),
                  h('button', {
                    className: 'qqp-chip clk',
                    disabled: busy === `send-${f.name}` || voiceKey === '',
                    title: voiceKey === '' ? '先在下面选一个要发到哪' : `发到 ${voiceKey}`,
                    onClick: () => onSend(f.name),
                  }, busy === `send-${f.name}` ? '发送中' : '发一条'),
                  h('button', {
                    className: 'qqp-chip clk',
                    disabled: busy === `del-${f.name}`,
                    onClick: () => onDeleteVoice(f.name),
                  }, '删'),
                )
              })),
          files.length === 0
            ? null
            : h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 12, color: 'var(--k-mute)' } }, '发到'),
              voiceKeys.length === 0
                ? h('span', { style: { fontSize: 12, color: 'var(--k-bad)' } }, '还没有可用会话')
                : h('select', {
                  className: 'qqp-input',
                  style: { width: 'auto', minWidth: 200 },
                  value: voiceKey,
                  onChange: (e) => onVoiceKey(e.target.value),
                },
                  h('option', { value: '' }, '选一个会话…'),
                  ...voiceKeys.map((k) => h('option', { key: k, value: k }, k)),
                ),
              h('span', { className: 'qqp-note', style: { marginTop: 0, opacity: 0.7, flex: '1 1 260px' } },
                '「发一条」走控制台通道，不看 voice.enabled —— 开关都关着也能试。真发到 QQ 里会有真实消息。'),
            ),
        ),

        // ── 记忆（只读，压成一行小字；完整说明挂在 title 上，鼠标悬停才展开）──
        h('div', { className: 'qqp-path', style: { marginTop: 14 }, title: m.scopeNote ?? '' },
          h('b', null, '记忆 '),
          (m.categories ?? []).map((c) => `${c.name} ${c.count}`).join(' · ') || '还是空的',
          m.fileAt ? h('span', null, ` · 最后写入 ${clockOf(m.fileAt)}`) : null),
      )
    }

    function WhaleIcon({ size }) {
      return h(
        'svg',
        { width: size ?? 16, height: size ?? 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 13c0-3.9 3.1-7 7-7h2.5c1.9 0 3.5 1.6 3.5 3.5V11' }),
        h('path', { d: 'M3 13c0 3.9 3.1 7 7 7h3c4.4 0 8-3.3 8-7.5V9' }),
        h('path', { d: 'M18.5 9c1.4 0 2.5-1.1 2.5-2.5V5' }),
        h('path', { d: 'M21 6.5c-.7-.9-1.7-1.5-3-1.5' }),
        h('circle', { cx: 16.5, cy: 12.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      )
    }

    // ── 注册 ────────────────────────────────────────────────────────────
    function SidebarIcon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 13c0-3.6 3-6.5 6.6-6.5h2.2c1.8 0 3.2 1.4 3.2 3.2V11' }),
        h('path', { d: 'M4 13c0 3.6 3 6.5 6.6 6.5h2.8c4.1 0 7.6-3.1 7.6-7V9.2' }),
        h('path', { d: 'M18.6 9.2c1.3 0 2.4-1.1 2.4-2.4V5.4' }),
        h('circle', { cx: 16.2, cy: 12.4, r: 0.85, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, PanelPage))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '小鲸鱼' }, SidebarIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // 纯函数导出，方便脱离 UI 单独断言
    exports.PanelPage = PanelPage
    exports.money = money
    exports.compact = compact
    exports.MODES = MODES
    exports.PANEL_ID = PANEL_ID

    return module.exports
  },
})
