// 应用入口：窗口控制 · 路由 · 设备生命周期 · 电量展示与通知
import { DeviceManager } from './device.js'
import { BatteryMonitor, LowBatteryGuard } from './battery.js'
import { renderSettings } from './settings-page.js'

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

const desktop = window.desktop

/* ---------- 本地偏好 ---------- */
const prefs = {
  alertEnabled: localStorage.getItem('alertEnabled') !== '0',
  alertThreshold: Number(localStorage.getItem('alertThreshold') || 20),
}
const savePrefs = () => {
  localStorage.setItem('alertEnabled', prefs.alertEnabled ? '1' : '0')
  localStorage.setItem('alertThreshold', String(prefs.alertThreshold))
}

/* ---------- Toast ---------- */
let toastTimer = null
function toast(msg, kind = '') {
  const t = $('#toast')
  t.textContent = msg
  t.className = kind
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    t.hidden = true
  }, 2600)
}

/* ---------- 窗口控制 ---------- */
$('#btnClose').addEventListener('click', () => desktop.close())
$('#btnMin').addEventListener('click', () => desktop.minimize())
$('#btnMax').addEventListener('click', () => desktop.toggleMaximize())
desktop.getMaxState().then((m) => document.body.classList.toggle('maximized', m))
desktop.onMaxState((m) => document.body.classList.toggle('maximized', m))

// 关于页版本号以应用真实版本为准
desktop.onVersion((v) => {
  const el = $('#aboutVersion')
  if (el) el.textContent = `版本 ${v}`
})

/* ---------- 页面路由 ---------- */
for (const btn of $$('.nav-item')) {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn))
    for (const key of ['battery', 'settings', 'webdrv', 'about']) {
      $(`#page-${key}`).hidden = btn.dataset.page !== key
    }
    // 官方驱动页由主进程 BrowserView 覆盖显示。
    // 官方驱动的设置握手是多步 feature 事务，与我们的电量轮询共用通道会互相破坏，
    // 因此官方页激活期间暂停原生轮询，离开后恢复。
    if (btn.dataset.page === 'webdrv') {
      desktop.showWebDriver()
      monitor?.stop()
      monitor = null
    } else {
      desktop.hideWebDriver()
      if (dm.client && !monitor) {
        monitor = new BatteryMonitor(dm.client)
        monitor.start(onBattery)
      }
    }
  })
}

/* ---------- 低电量提醒设置 ---------- */
const alertSwitch = $('#alertEnabled')
alertSwitch.checked = prefs.alertEnabled
alertSwitch.addEventListener('change', () => {
  prefs.alertEnabled = alertSwitch.checked
  savePrefs()
})
for (const b of $$('#alertThreshold button')) {
  b.classList.toggle('active', Number(b.dataset.v) === prefs.alertThreshold)
  b.addEventListener('click', () => {
    prefs.alertThreshold = Number(b.dataset.v)
    savePrefs()
    $$('#alertThreshold button').forEach((x) => x.classList.toggle('active', x === b))
  })
}

/* ---------- 设备生命周期 ---------- */
const dm = new DeviceManager()
let monitor = null
let guard = new LowBatteryGuard(() => prefs.alertThreshold)
let currentStatus = null

dm.onChange(({ state, client }) => {
  const foot = $('#sidebarStatus')
  foot.classList.toggle('online', state === 'connected')
  foot.lastElementChild.textContent =
    state === 'connected' ? '已连接' : state === 'connecting' ? '连接中…' : '未连接'

  if (state === 'connected' && client) {
    client
      .readStatus()
      .then((status) => {
        console.log(`[app] 已连接 ${status.name} · 电量 ${status.batteryPercent}% · DPI ${status.dpi} · ${status.pollingRateHz}Hz`)
        currentStatus = status
        renderDashboard(status)
        renderSettingsPage()
        monitor?.stop()
        monitor = new BatteryMonitor(client)
        monitor.start(onBattery)
      })
      .catch((err) => {
        // 配置读取失败不应摧毁电量面板：电量监控不依赖配置，照常启动
        console.log(`[app] readStatus 失败: ${err.message}`)
        toast(`读取鼠标配置失败：${err.message}`, 'err')
        monitor?.stop()
        monitor = new BatteryMonitor(client)
        monitor.start(onBattery)
        renderSettings({
          container: $('#settingsCards'),
          status: { profile: null },
          client,
          toast,
          onApplied: () => {},
          onOpenWebDriver: () => document.querySelector('.nav-item[data-page="webdrv"]')?.click(),
        })
        $('#settingsSub').textContent = `${client.device.productName || '鼠标'} · 已连接`
      })
    return
  }

  monitor?.stop()
  monitor = null
  guard = new LowBatteryGuard(() => prefs.alertThreshold)
  renderEmpty(state === 'connecting' ? '正在连接鼠标…' : '未检测到鼠标')
})

dm.start()

/* ---------- 电量页渲染 ---------- */
const BATTERY_INNER_W = 208

function renderEmpty(msg) {
  currentStatus = null
  $('#heroPercent').textContent = '--'
  $('#heroState').textContent = msg
  $('#heroMeta').textContent = '请插入 2.4G 接收器，或用 USB 线连接鼠标'
  const fill = $('#batteryFill')
  fill.style.width = '0px'
  fill.setAttribute('class', 'battery-fill')
  $('#batteryText').textContent = '--'
  for (const id of ['infoName', 'infoConn', 'infoVoltage', 'infoFirmware', 'infoVid', 'infoDpi']) {
    $(`#${id}`).textContent = '--'
  }
  $('#settingsCards').innerHTML = `<div class="settings-empty"><div class="spinner"></div>${msg}</div>`
  $('#settingsSub').textContent = '--'
  $('#btnConnect').hidden = false
}

$('#btnConnect').addEventListener('click', async () => {
  const btn = $('#btnConnect')
  btn.disabled = true
  btn.textContent = '连接中…'
  const ok = await dm.requestAndConnect()
  btn.disabled = false
  btn.textContent = '连接设备'
  if (!ok) toast('未选择或未能连接设备', 'err')
})

function renderDashboard(status) {
  $('#infoName').textContent = status.name
  $('#infoConn').textContent = status.wireless ? '2.4G 无线（接收器）' : '有线连接'
  $('#infoVoltage').textContent = status.batteryVoltageMv
    ? `${(status.batteryVoltageMv / 1000).toFixed(2)} V`
    : '--'
  $('#infoFirmware').textContent = status.firmware || '--'
  $('#infoVid').textContent = `${status.vid.toString(16).padStart(4, '0')} / ${status.pid.toString(16).padStart(4, '0')}`
  $('#infoDpi').textContent = status.dpi
    ? `${status.dpi.toLocaleString()} DPI · ${status.pollingRateHz || '--'} Hz`
    : '--'
  $('#settingsSub').textContent = `${status.name} · 已连接`
  $('#btnConnect').hidden = true
  setBatteryDisplay({
    percent: status.batteryPercent,
    charging: status.batteryState === 'Charging' || status.batteryState === 'Full',
    voltageMv: status.batteryVoltageMv,
    online: true,
  })
}

function setBatteryDisplay({ percent, charging, voltageMv, online }) {
  const fill = $('#batteryFill')
  if (percent === null || percent === undefined) {
    fill.style.width = '0px'
    fill.setAttribute('class', 'battery-fill')
    $('#batteryText').textContent = '--'
    $('#heroPercent').textContent = '--'
    $('#heroState').textContent = online ? '电量未知' : '未检测到鼠标'
    $('#heroMeta').textContent = online ? '' : '请插入 2.4G 接收器，或用 USB 线连接鼠标'
    return
  }

  fill.style.width = `${Math.max(4, (BATTERY_INNER_W * percent) / 100)}px`
  fill.setAttribute('class', `battery-fill ${percent <= 20 ? 'lvl-red' : percent <= 50 ? 'lvl-yellow' : 'lvl-green'}`)
  $('#batteryText').textContent = percent
  $('#heroPercent').textContent = percent

  const state = !online
    ? '休眠中 · 动一下鼠标唤醒'
    : charging && percent >= 99
      ? '已充满'
      : charging
        ? '充电中'
        : '2.4G 无线连接'
  $('#heroState').textContent = state
  $('#heroMeta').textContent = voltageMv ? `${(voltageMv / 1000).toFixed(2)} V` : ''
}

function onBattery(b) {
  setBatteryDisplay(b)
  if (b.percent !== null && b.percent !== undefined && prefs.alertEnabled && guard.feed(b.percent)) {
    desktop.notify('鼠标电量低', `当前电量 ${b.percent}%，已低于 ${prefs.alertThreshold}% 提醒阈值，请及时充电。`)
  }
}

/* ---------- 参数设置页渲染 ---------- */
function renderSettingsPage() {
  if (!currentStatus || !dm.client) return
  renderSettings({
    container: $('#settingsCards'),
    status: currentStatus,
    client: dm.client,
    toast,
    onApplied: () => {
      // 每次设置生效后刷新仪表盘上的 DPI / 回报率
      dm.client
        .readStatus()
        .then((s) => {
          currentStatus = s
          renderDashboard(s)
        })
        .catch(() => {})
    },
    onOpenWebDriver: () => document.querySelector('.nav-item[data-page="webdrv"]')?.click(),
  })
}
