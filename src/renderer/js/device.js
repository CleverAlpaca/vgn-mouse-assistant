// 设备生命周期管理：发现、连接、热插拔、自动重连
import { CompxHidClient } from './compx.js'

const RETRY_INTERVAL_MS = 3000

export class DeviceManager {
  constructor() {
    this.client = null
    this.state = 'disconnected' // disconnected | connecting | connected
    this.listeners = new Set()
    this.retryTimer = null
    this.connecting = false
  }

  /** 状态或客户端变化时回调：({state, client}) */
  onChange(cb) {
    this.listeners.add(cb)
    cb({ state: this.state, client: this.client })
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    for (const cb of this.listeners) cb({ state: this.state, client: this.client })
  }

  /** 启动：立即尝试连接 + 周期重试兜底（WebHID 设备事件不一定及时） */
  async start() {
    await this.ensureConnection()
    this.retryTimer = setInterval(() => {
      if (this.state !== 'connected') this.ensureConnection()
    }, RETRY_INTERVAL_MS)

    navigator.hid.addEventListener('connect', () => this.ensureConnection())
    navigator.hid.addEventListener('disconnect', (e) => {
      if (this.client && e.device === this.client.device) this.teardown('disconnected')
    })
    window.desktop?.onHidChanged(() => {
      setTimeout(() => this.ensureConnection(), 400)
    })
  }

  stop() {
    clearInterval(this.retryTimer)
    this.teardown('disconnected')
  }

  async ensureConnection() {
    if (this.connecting || this.state === 'connected') return
    this.connecting = true
    try {
      const devices = await navigator.hid.getDevices()
      const target = devices.find((d) => CompxHidClient.isSupported(d))
      console.log(`[device] WebHID 设备 ${devices.length} 个，匹配 ${target ? `${target.productName} (${target.vendorId.toString(16)}:${target.productId.toString(16)})` : '无'}`)
      if (!target) {
        this.setState('disconnected')
        return
      }
      this.setState('connecting')
      const client = new CompxHidClient(target)
      try {
        await client.open()
        // 探活：设备应答即连接成功（鼠标本体休眠不算失败）
        await client.probe()
        this.client = client
        this.setState('connected')
      } catch {
        // 连接失败务必关掉，避免在设备上累积监听器
        await client.close().catch(() => {})
        this.setState('disconnected')
      }
    } finally {
      this.connecting = false
    }
  }

  /** 用户手动授权新设备（首次接入时点一次，授权会持久化到主进程） */
  async requestAndConnect() {
    const devices = await navigator.hid.requestDevice({ filters: [{}] }).catch(() => [])
    if (devices.length) await this.ensureConnection()
    return this.state === 'connected'
  }

  async teardown(state) {
    const client = this.client
    this.client = null
    this.setState(state)
    if (client) await client.close().catch(() => {})
  }
}
