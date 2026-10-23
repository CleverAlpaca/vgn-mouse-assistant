'use strict'

const { app, BrowserWindow, BrowserView, ipcMain, session, Notification } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// VGN 家族（Compx/Nordic 方案）已知厂商 ID，WebHID 权限自动放行
// 0x3554 VGN/VXE 主力 · 0x373b ATK 新款 · 0x391d VGN 新方案 · 0x260d 达尔优 · 0x33e4 G-Wolves
const FAMILY_VIDS = [0x3554, 0x373b, 0x391d, 0x260d, 0x33e4]

// 官方网页驱动（嵌入使用，同时记录协议报文用于自有客户端的兼容性实现）
const WEB_DRIVER_URL = 'https://hub.vgnlab.com.cn'
// 官方页面按桌面浏览器宽度（≥1180 CSS px）设计；嵌入视口不足时按比例缩小
// 页面内容（等效加宽布局），避免其弹出子菜单与右侧面板重叠
const WEB_DRIVER_MIN_CSS_WIDTH = 1180

// 用户手动授权过的设备持久化，保证重启后免权限弹窗自动重连
const grantFile = () => path.join(app.getPath('userData'), 'granted-devices.json')
let granted = new Set()
try {
  granted = new Set(JSON.parse(fs.readFileSync(grantFile(), 'utf8')))
} catch { /* 首次运行没有文件 */ }

const saveGrants = () => {
  try { fs.writeFileSync(grantFile(), JSON.stringify([...granted], null, 2)) } catch { /* 忽略写盘失败 */ }
}

const isAllowedHid = (details) => {
  if (details.deviceType !== 'hid') return false
  // 枚举期查询不带设备标识：放行，具体设备由渲染层按协议特征（厂商集合 + 报表形状）过滤
  if (details.vendorId === undefined || details.productId === undefined) return true
  return FAMILY_VIDS.includes(details.vendorId) || granted.has(`${details.vendorId}:${details.productId}`)
}

let win = null
let webDriverView = null

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    frame: false,
    backgroundColor: '#1a1a1a',
    resizable: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  // 把应用真实版本号告知渲染层（关于页展示，避免与 package.json 漂移）
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('app-version', app.getVersion())
  })

  // 渲染层日志转发到终端，便于排查连接问题（兼容新旧事件签名）
  const forwardConsole = (...args) => {
    const msg = typeof args[2] === 'string' ? args[2] : args[0]?.message
    if (msg) console.log(`[renderer] ${msg}`)
  }
  win.webContents.on('console-message', forwardConsole)

  const pushMaxState = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:max-state', win.isMaximized())
  }
  win.on('maximize', pushMaxState)
  win.on('unmaximize', pushMaxState)
  win.on('resize', () => {
    if (webDriverView) {
      webDriverView.setBounds(webDriverBounds())
      applyWebDriverZoom()
    }
  })
}

// ---------- 内嵌官方网页驱动 ----------

function webDriverBounds() {
  if (!win) return { x: 0, y: 0, width: 0, height: 0 }
  const [w, h] = win.getContentSize()
  // 内容区：标题栏 40px + 侧栏 196px + 与内容区对齐的 20px 边距
  return { x: 220, y: 60, width: Math.max(0, w - 220 - 20), height: Math.max(0, h - 60 - 20) }
}

/** 视口宽度不足官方页面的设计宽度时整体缩小页面，保证布局按桌面版排布 */
function applyWebDriverZoom() {
  if (!webDriverView) return
  const { width } = webDriverBounds()
  const zoom = Math.max(0.55, Math.min(1, width / WEB_DRIVER_MIN_CSS_WIDTH))
  webDriverView.webContents.setZoomFactor(zoom)
}

function showWebDriver() {
  if (!win) return
  if (!webDriverView) {
    webDriverView = new BrowserView({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    win.addBrowserView(webDriverView)
    webDriverView.setBounds(webDriverBounds())
    applyWebDriverZoom()
    webDriverView.webContents.on('did-finish-load', () => injectHidLogger(webDriverView.webContents))
    // 官方驱动内的 HID 报文同时落盘，作为后续协议兼容实现的样本库
    webDriverView.webContents.on('console-message', (...args) => {
      const message = typeof args[2] === 'string' ? args[2] : args[0]?.message
      if (!message || !message.startsWith('[hidlog]')) return
      console.log(`[webdrv] ${message.slice(8)}`)
      try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'v8k-capture.log'), `${new Date().toISOString()} ${message.slice(8)}\n`)
      } catch { /* 忽略写盘失败 */ }
    })
    webDriverView.webContents.loadURL(WEB_DRIVER_URL).catch(() => {})
  } else {
    win.addBrowserView(webDriverView)
    webDriverView.setBounds(webDriverBounds())
    applyWebDriverZoom()
  }
}

function hideWebDriver() {
  if (webDriverView && win) win.removeBrowserView(webDriverView)
}

/** 注入 HID 收发探针：包裹 WebHID 接口，记录官方驱动的全部报文（用于协议兼容性实现） */
function injectHidLogger(webContents) {
  const code = `(async () => {
    if (window.__hidLogged) return
    window.__hidLogged = true
    const toArr = (d) => {
      try {
        if (d instanceof DataView) return Array.from(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
        if (d.buffer) return Array.from(new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)))
        return Array.from(d)
      } catch { return [] }
    }
    const wrap = (device) => {
      const tag = device.vendorId.toString(16) + ':' + device.productId.toString(16)
      const log = (dir, id, data) => console.log('[hidlog] ' + tag + ' ' + dir + ' id' + id + ' ' + toArr(data).join(','))
      const f = device.sendFeatureReport.bind(device)
      device.sendFeatureReport = async (id, data) => { log('FEAT-OUT', id, data); return f(id, data) }
      const s = device.sendReport.bind(device)
      device.sendReport = async (id, data) => { log('OUT', id, data); return s(id, data) }
      const r = device.receiveFeatureReport.bind(device)
      device.receiveFeatureReport = async (id) => { const v = await r(id); log('FEAT-IN', id, v); return v }
      const a = device.addEventListener.bind(device)
      device.addEventListener = (type, cb, opts) => {
        if (type === 'inputreport' && !cb.__wrapped) {
          const w = (e) => { log('IN', e.reportId, e.data); cb(e) }
          w.__wrapped = true
          return a(type, w, opts)
        }
        return a(type, cb, opts)
      }
      return device
    }
    const g = navigator.hid.getDevices.bind(navigator.hid)
    navigator.hid.getDevices = async () => (await g()).map(wrap)
    const q = navigator.hid.requestDevice.bind(navigator.hid)
    navigator.hid.requestDevice = async (o) => (await q(o)).map(wrap)
  })()`
  webContents.executeJavaScript(code).catch(() => {})
}

// ---------- IPC ----------

ipcMain.handle('win:get-max-state', () => (win ? win.isMaximized() : false))
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:toggle-maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
ipcMain.on('win:close', () => win?.close())
ipcMain.on('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
})
ipcMain.on('webdrv:show', () => showWebDriver())
ipcMain.on('webdrv:hide', () => hideWebDriver())

// ---------- 启动 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    const ses = session.defaultSession

    // WebHID 权限：家族 VID 与已授权设备直接放行，getDevices() 即可枚举打开
    ses.setDevicePermissionHandler((details) => isAllowedHid(details))

    // 渲染层 requestDevice() 触发选择器：优先家族设备，否则取列表第一个
    app.on('select-hid-device', (event, details, callback) => {
      const list = details.deviceList || []
      const hit = list.find(
        (d) => d.vendorId !== undefined && (FAMILY_VIDS.includes(d.vendorId) || granted.has(`${d.vendorId}:${d.productId}`)),
      ) || list[0]
      if (hit) {
        granted.add(`${hit.vendorId}:${hit.productId}`)
        saveGrants()
        callback(hit.deviceId)
      } else {
        callback()
      }
    })

    // 设备插拔通知渲染层（渲染层另有轮询兜底）
    ses.on('hid-device-added', (_e, d) => {
      win?.webContents.send('hid:changed', { type: 'added', vendorId: d.vendorId, productId: d.productId })
    })
    ses.on('hid-device-removed', (_e, d) => {
      win?.webContents.send('hid:changed', { type: 'removed', vendorId: d.vendorId, productId: d.productId })
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
}
