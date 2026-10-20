const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { chromium } = require('playwright')

// 使用真实浏览器验证双击本地页面时的 Worker 和协议输出。
;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href)
    const result = await page.evaluate(async () => {
      const workersUsed = new Set()
      for (const item of qrWorkers) {
        const postMessage = item.worker.postMessage.bind(item.worker)
        item.worker.postMessage = (...args) => {
          workersUsed.add(item)
          return postMessage(...args)
        }
      }
      const jobs = Array.from({ length: 8 }, (_, index) =>
        workerCall('renderQr', {
          payloadBuffer: new TextEncoder().encode(`parallel-${index}`).buffer,
          finalSize: 256,
          errorLevel: 'Q',
        }),
      )
      const images = await Promise.allSettled(jobs)
      return {
        mode: getWorkerModeText(),
        workersUsed: workersUsed.size,
        images: images.map((item) => (item.status === 'fulfilled' ? item.value.kind : item.reason.message)),
      }
    })
    console.log(result)
    assert.equal(result.images.filter((kind) => kind === 'png').length, 8, '本地打开必须能由 Worker 生成全部图片')
    assert.ok(result.workersUsed >= 2, '生成任务必须分配到多个实际 Worker')
    console.log('PASS: local-file parallel QR rendering')
    const generated = await page.evaluate(async () => {
      let builds = 0
      let renders = 0
      const renderWorkers = new Set()
      for (const item of qrWorkers) {
        const postMessage = item.worker.postMessage.bind(item.worker)
        item.worker.postMessage = (message, ...args) => {
          if (message.type === 'buildTransmission') builds += 1
          if (message.type === 'renderQr') {
            renders += 1
            renderWorkers.add(item)
          }
          return postMessage(message, ...args)
        }
      }
      buildTransmissionPayload = () => {
        throw new Error('主线程不应执行压缩')
      }
      state.inputMode = 'file'
      state.qrSize = '1024'
      state.fileBytes = Uint8Array.from({ length: 16384 }, (_, i) => (i * 73 + 41) & 255)
      state.fileMeta = {
        name: 'parallel.zip',
        type: 'application/zip',
        size: 16384,
      }
      await estimateCurrentPayloadStats()
      await generateQR()
      const recovered = []
      const sequences = []
      for (const item of state.qrImages) {
        const image = new Image()
        image.src = item.dataUrl
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(image, 0, 0)
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const decoded = jsQR(pixels.data, pixels.width, pixels.height)
        if (!decoded) throw new Error('生成图片无法识别')
        const frame = parseV5Frame(Uint8Array.from(decoded.binaryData))
        sequences.push(frame.current)
        if (frame.flags === 2) recovered.push(...frame.payload)
      }
      return {
        builds,
        renders,
        workers: renderWorkers.size,
        sequences,
        recovered,
      }
    })
    assert.equal(generated.builds, 1, '统计和生成必须复用同一份后台预处理结果')
    assert.equal(generated.renders, 12)
    assert.ok(generated.workers >= 2)
    assert.deepEqual(
      generated.sequences,
      Array.from({ length: 12 }, (_, i) => i + 1),
    )
    assert.deepEqual(
      generated.recovered,
      Array.from({ length: 16384 }, (_, i) => (i * 73 + 41) & 255),
    )
    console.log('PASS: background preprocessing, cache reuse and byte-exact QR round trip')
    const snapshot = await browser.newPage()
    await snapshot.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href)
    const snapshotResult = await snapshot.evaluate(async () => {
      const originalWorkerCall = workerCall
      let rejectBuild
      workerCall = (type, ...args) =>
        type === 'buildTransmission'
          ? new Promise((resolve, reject) => {
              rejectBuild = reject
            })
          : originalWorkerCall(type, ...args)
      state.inputMode = 'file'
      state.fileMeta = { name: 'original.zip', type: 'application/zip', size: 3 }
      state.forceCompress = false
      const prepared = prepareQrTransmission('file', new Uint8Array([7, 8, 9]), 'Q')
      state.fileMeta = { name: 'replacement.txt', type: 'text/plain', size: 99 }
      state.forceCompress = true
      rejectBuild(new Error('worker crashed'))
      const result = await prepared
      const meta = JSON.parse(new TextDecoder().decode(parseV5Frame(result.segments[0]).payload))
      workerCall = originalWorkerCall
      return meta
    })
    assert.equal(snapshotResult.name, 'original.zip', '异步失败回退必须保留原始文件名')
    assert.equal(snapshotResult.forceCompress, false)
    assert.equal(snapshotResult.compression, 'none')
    assert.equal(snapshotResult.size, 3)
    console.log('PASS: preprocessing fallback preserves original input settings')

    const cancelled = await browser.newPage()
    await cancelled.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href)
    const cancelledResult = await cancelled.evaluate(async () => {
      state.inputMode = 'text'
      document.getElementById('qrTextInput').value = 'cancel preprocessing'
      const pending = generateQR()
      clearQRGenerator()
      await pending
      return { disabled: document.getElementById('generateBtn').disabled, images: state.qrImages.length, busy: state.isGenerating }
    })
    assert.equal(cancelledResult.disabled, false, '预处理期间清空后必须能重新生成')
    assert.equal(cancelledResult.images, 0)
    assert.equal(cancelledResult.busy, false)
    console.log('PASS: clear during preprocessing restores generator')
    const staleStats = await cancelled.evaluate(async () => {
      state.inputMode = 'file'
      state.fileBytes = new Uint8Array(4096)
      state.fileMeta = { name: 'previous.zip', type: 'application/zip', size: 4096 }
      const pending = estimateCurrentPayloadStats()
      handleQRFile(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-large.zip'))
      await pending
      return document.getElementById('rawLength').textContent
    })
    assert.equal(staleStats, '0', '超限文件必须使之前的后台统计失效')
    console.log('PASS: oversized input invalidates pending statistics')

    const fallback = await browser.newPage()
    await fallback.addInitScript(() => {
      window.workerStarts = 0
      window.Worker = class {
        constructor() {
          window.workerStarts += 1
          throw new Error('Worker disabled')
        }
      }
    })
    await fallback.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href)
    const fallbackResult = await fallback.evaluate(async () => {
      state.inputMode = 'text'
      document.getElementById('qrTextInput').value = 'offline fallback'
      await generateQR()
      getWorkerModeText()
      getWorkerModeText()
      return { count: state.qrImages.length, starts: window.workerStarts, mode: getWorkerModeText() }
    })
    assert.equal(fallbackResult.count, 2)
    assert.equal(fallbackResult.starts, 1, '禁用 Worker 时不能逐帧反复启动失败')
    assert.equal(fallbackResult.mode, '单线程')
    console.log('PASS: disabled-Worker fallback without repeated startup')

    const root = path.resolve(__dirname, '..')
    const server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
        response.writeHead(404).end()
        return
      }
      response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8')
      response.end(fs.readFileSync(file))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const online = await browser.newPage()
      await online.goto(`http://127.0.0.1:${server.address().port}/index.html`)
      const onlineResult = await online.evaluate(async () => {
        const result = await workerCall('renderQr', {
          payloadBuffer: new TextEncoder().encode('http worker').buffer,
          finalSize: 256,
          errorLevel: 'Q',
        })
        const payloadBuffer = new Uint8Array([1, 2, 3]).buffer
        let cloneFailed = false
        try {
          await workerCall('renderQr', { payloadBuffer, finalSize: 256, errorLevel: 'Q', invalid: () => {} })
        } catch (error) {
          cloneFailed = error.name === 'DataCloneError'
        }
        return { kind: result.kind, cloneFailed, pending: qrWorkerPending.size, load: qrWorkers.reduce((sum, item) => sum + item.pendingCount, 0) }
      })
      assert.equal(onlineResult.kind, 'png')
      assert.equal(onlineResult.cloneFailed, true)
      assert.equal(onlineResult.pending, 0)
      assert.equal(onlineResult.load, 0)
      console.log('PASS: HTTP Worker and postMessage failure cleanup')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
