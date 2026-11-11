/**
 * 本机离线 TTS：Kokoro v1.1-zh（82M 参数，103 个音色，其中 55 个中文女声）。
 *
 * 为什么做成独立脚本、由插件 spawn，而不是直接在 index.js 里 require：
 *   1. `tts.generate()` 是**同步阻塞**的（一句 1~2 秒），在插件主进程里跑会把
 *      DSH 的 web server 一起冻住 —— 面板会卡、别的接口也会等。子进程天然隔离。
 *   2. sherpa-onnx-node 需要在 `D:\qq-bridge\node_modules` 里，插件本体不声明它，
 *      换机器没装也不该让整个插件加载失败。子进程里 require 失败只影响这一路。
 *
 * 调用（由 index.js 拼参数，全部经命令行传，文本走 UTF-8 文件）：
 *   node tts-kokoro.cjs --model-dir <dir> --text-file <txt> --out-file <wav> [--sid N] [--speed 1.0]
 *
 * 输出：成功打印 `ok <bytes> <sampleRate>` 并 exit 0；失败打印原因到 stderr 并 exit 1~4。
 * 中文文本一律走文件：把中文塞进命令行会被控制台代码页（GBK）转成问号，这个坑踩过。
 */
const fs = require('fs')
const path = require('path')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= process.argv.length) return fallback
  return process.argv[i + 1]
}

const modelDir = arg('model-dir', '')
const textFile = arg('text-file', '')
const outFile = arg('out-file', '')
const sid = Number(arg('sid', '3'))
const speed = Number(arg('speed', '1'))
// --serve：常驻模式，文本从 stdin 来，不需要 text-file / out-file
const serve = process.argv.includes('--serve')

if (modelDir === '' || (!serve && (textFile === '' || outFile === ''))) {
  console.error('用法：node tts-kokoro.cjs --model-dir <dir> [--text-file <txt> --out-file <wav>] [--sid N] [--speed 1.0] [--serve]')
  process.exit(1)
}

let text = ''
if (!serve) {
  try {
    text = fs.readFileSync(textFile, 'utf8').trim()
  } catch (error) {
    console.error(`读不了文本文件：${error?.message ?? error}`)
    process.exit(2)
  }
  if (text === '') {
    console.error('文本是空的')
    process.exit(2)
  }
}

// 模型文件齐全性先查一遍，报错比 onnxruntime 的崩溃信息好读
const files = {
  model: path.join(modelDir, 'model.onnx'),
  voices: path.join(modelDir, 'voices.bin'),
  tokens: path.join(modelDir, 'tokens.txt'),
  lexiconZh: path.join(modelDir, 'lexicon-zh.txt'),
  lexiconEnUs: path.join(modelDir, 'lexicon-us-en.txt'),
  lexiconEnGb: path.join(modelDir, 'lexicon-gb-en.txt'),
}
for (const [k, f] of Object.entries(files)) {
  if (!fs.existsSync(f)) {
    console.error(`缺模型文件（${k}）：${f}`)
    process.exit(3)
  }
}

let sherpa = null
try {
  sherpa = require('sherpa-onnx-node')
} catch (error) {
  console.error(`加载不了 sherpa-onnx-node：${error?.message ?? error}`)
  process.exit(4)
}

try {
  const tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: files.model,
        voices: files.voices,
        tokens: files.tokens,
        // 多本词典用逗号串起来；顺序不重要，espeak 已不再参与（v2.0 起 lang 参数被忽略）
        lexicon: [files.lexiconEnUs, files.lexiconZh, files.lexiconEnGb].join(','),
      },
      numThreads: 4,
      debug: 0,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  })
  // ── 服务模式 ────────────────────────────────────────────────────────
  // 模型加载 3.7 秒、合成一句 1.4 秒 —— 每念一句都重启进程等于白等 3.7 秒。
  // 加 `--serve` 后常驻：从 stdin 逐行读 JSON 请求、往 stdout 逐行写 JSON 结果。
  // 请求：{ "id": 1, "text": "...", "sid": 39, "speed": 1.0, "out": "D:\\...\\x.wav" }
  // 结果：{ "id": 1, "ok": true, "bytes": 241586, "sampleRate": 24000 }
  if (process.argv.includes('--serve')) {
    console.log(`ready ${tts.sampleRate} ${tts.numSpeakers}`)
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (line === '') continue
        let req = null
        try {
          req = JSON.parse(line)
        } catch (error) {
          console.log(JSON.stringify({ id: null, ok: false, error: `请求不是合法 JSON：${error?.message ?? error}` }))
          continue
        }
        try {
          const audio = tts.generate({
            text: String(req.text ?? ''),
            sid: Number.isFinite(Number(req.sid)) ? Number(req.sid) : 3,
            speed: Math.max(0.5, Math.min(2, Number(req.speed) || 1)),
          })
          if (!audio?.samples?.length) throw new Error('合成结果为空')
          sherpa.writeWave(String(req.out), audio)
          console.log(JSON.stringify({ id: req.id ?? null, ok: true, bytes: fs.statSync(String(req.out)).size, sampleRate: audio.sampleRate }))
        } catch (error) {
          console.log(JSON.stringify({ id: req.id ?? null, ok: false, error: String(error?.message ?? error) }))
        }
      }
    })
    process.stdin.on('end', () => process.exit(0))
    return
  }

  const audio = tts.generate({ text, sid, speed: Math.max(0.5, Math.min(2, speed)) })
  if (!audio || !audio.samples || audio.samples.length === 0) {
    console.error('合成结果为空')
    process.exit(5)
  }
  sherpa.writeWave(outFile, audio)
  const bytes = fs.statSync(outFile).size
  console.log(`ok ${bytes} ${audio.sampleRate}`)
} catch (error) {
  console.error(`合成失败：${error?.message ?? error}`)
  process.exit(6)
}
