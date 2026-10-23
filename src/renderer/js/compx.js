// Compx / Nordic HID 客户端 —— VGN / ATK / VXE 系无线鼠标通用
//
// 两种传输（同族协议、不同固件代际）：
//   report8    —— 老款 Nordic 52840：17 字节报文，report ID 0x08，输入/输出报表，
//                 全 17 字节求和 mod 256 === 0x55（VGN F2 / VXE R1 / ATK 系）
//   feature64  —— 新款 Nordic 54L15：64 字节 feature report（ID 0），usage page 0xFFFF，
//                 命令族 0x72（ATK Zero 同源；VGN 蜻蜓 3 Pro Max 实测为此形态）
//
// 编解码复用 @openmouse/protocol（AGPL-3.0）；协议事实参考：
//   OpenMouse VgnF2HidClient · Fan4Metal/mouse_tray nordic52.py / nordic54.py
import {
  VGN_COMMAND,
  VGN_ADDRESS,
  vgnBuildSimplePayload,
  vgnBuildReadPayload,
  vgnBuildWritePayload,
  vgnBuildWriteScalarPayload,
  vgnParseReadResponse,
  vgnParseBattery,
  vgnDecodeProfile,
  vgnDecodeDpi,
  vgnEncodeDpi,
  vgnEncodePollingRate,
  vgnReportChecksumIsValid,
  TEEVOLUTION_SHARED_BUTTON_OPTIONS,
  teevolutionReadKeyTable,
  teevolutionRemapButton,
  teevolutionDecodeButtonMappings,
  wePackScalarPair,
} from './vendor/openmouse.js'

const REPORT_ID = 8
const PAYLOAD_LENGTH = 16
const RESPONSE_TIMEOUT_MS = 800
const FEATURE_DELAY_MS = 80

// VGN 8K 新固件（蜻蜓 3 Pro Max 实测，嗅探官方网页驱动所得）：
// 64 字节 feature report（ID 0）；帧头 = (0xFF - 载荷和) & 0xFF，命令置于 byte7；
// 状态查询命令 0x08，响应为设备维护的实时状态块，byte2 = 电量百分比
const V8K_STATUS_CMD = 0x08

// DPI 指示灯行（ATK R1 系同源固件），0=关 1=常亮 2=呼吸
const LIGHTING_ROW = 0x004c
const LIGHTING_LENGTH = 8
const LIGHTING_BRIGHTNESS = [0x10, 0x80, 0xff]
const LIGHTING_SPEED = [1, 3, 5]

// VGN 集团（Compx 方案）及同硅片贴牌的已知厂商 ID
export const COMPX_FAMILY_VIDS = [0x3554, 0x373b, 0x391d, 0x260d, 0x33e4]

export const SUPPORTED_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000]

const reportLength = (report) =>
  report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0) / 8

function* walkCollections(collections) {
  for (const c of collections) {
    yield c
    if (c.children) yield* walkCollections(c.children)
  }
}

export class CompxHidClient {
  constructor(device) {
    this.device = device
    this.transport = CompxHidClient.transportOf(device) // 'report8' | 'feature64'
    this.waiter = null
    this.onInputReport = this.onInputReport.bind(this)
    this.linkIndex = 1 // feature64：1=接收器链路，0=有线链路
  }

  /** 识别传输形态：老款 in/out report 8×16 字节，或新款 feature report 0×64 字节 */
  static transportOf(device) {
    if (!COMPX_FAMILY_VIDS.includes(device.vendorId)) return null
    for (const c of walkCollections(device.collections || [])) {
      const hasIn = c.inputReports.some((r) => r.reportId === REPORT_ID && reportLength(r) === PAYLOAD_LENGTH)
      const hasOut = c.outputReports.some((r) => r.reportId === REPORT_ID && reportLength(r) === PAYLOAD_LENGTH)
      if (hasIn && hasOut) return 'report8'
      if (c.featureReports.some((r) => reportLength(r) === 64)) return 'feature64'
    }
    return null
  }

  static isSupported(device) {
    return CompxHidClient.transportOf(device) !== null
  }

  get id() {
    return `${this.device.vendorId.toString(16)}:${this.device.productId.toString(16)}`
  }

  async open() {
    if (!this.device.opened) await this.device.open()
    this.device.removeEventListener('inputreport', this.onInputReport)
    this.device.addEventListener('inputreport', this.onInputReport)
  }

  async close() {
    this.failWaiter(new Error('设备已关闭'))
    this.device.removeEventListener('inputreport', this.onInputReport)
    if (this.device.opened) {
      try {
        await this.device.close()
      } catch { /* 拔出后 close 可能报错，忽略 */ }
    }
  }

  onInputReport(event) {
    if (event.reportId !== REPORT_ID) return
    const response = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    )
    const waiter = this.waiter
    if (!waiter || response[0] !== waiter.command) return
    clearTimeout(waiter.timer)
    this.waiter = null
    waiter.resolve(response)
  }

  /**
   * 统一收发。入参/返回均为「不含 report ID 的载荷」：
   *   report8   —— 16 字节（对应 hidapi 17 字节报文的 1..16）
   *   feature64 —— 最长 64 字节（nordic54 报文的 1..63 置于 feature 载荷 0..62）
   */
  async exchange(payload, { expectEcho = null, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
    await this.open()
    if (this.transport === 'feature64') return this.exchangeFeature(payload, timeoutMs)
    return this.exchangeReport8(payload, expectEcho, timeoutMs)
  }

  exchangeReport8(payload, expectEcho, timeoutMs) {
    this.failWaiter(new Error('被新请求顶替'))
    const command = expectEcho ?? payload[0]
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === resolve) this.waiter = null
        reject(new Error(`命令 0x${command.toString(16)} 响应超时`))
      }, timeoutMs)
      this.waiter = { command, resolve, reject, timer }
    })
    try {
      this.device.sendReport(REPORT_ID, new Uint8Array(payload).buffer)
    } catch (error) {
      this.failWaiter(error instanceof Error ? error : new Error(String(error)))
    }
    return response
  }

  async exchangeFeature(payload, _timeoutMs) {
    const body = new Uint8Array(64)
    body.set(payload.slice(0, 64))
    await this.device.sendFeatureReport(0, body)
    await new Promise((r) => setTimeout(r, FEATURE_DELAY_MS))
    const view = await this.device.receiveFeatureReport(0)
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }

  failWaiter(error) {
    const waiter = this.waiter
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.waiter = null
    waiter.reject(error)
  }

  /** 连接探活：设备应答任意命令即认为在线（不要求鼠标本体醒着） */
  async probe() {
    if (this.transport === 'feature64') {
      const res = await this.exchangeFeature(v8kFrame([V8K_STATUS_CMD]))
      return !!res && res.length >= 10
    }
    await this.exchangeReport8(vgnBuildSimplePayload(VGN_COMMAND.battery), VGN_COMMAND.battery, 600)
    return true
  }

  // ---------- 电量 ----------

  /** 返回 {percent, charging, voltageMv} 或 null（休眠/无数据） */
  async readBattery() {
    if (this.transport === 'feature64') {
      const res = await this.exchangeFeature(v8kFrame([V8K_STATUS_CMD])).catch(() => null)
      if (!res || res.length < 10) return null
      const percent = res[2]
      if (percent > 100) return null
      // 响应 byte3/byte4 为充电/链路相关标志，充电语义待充电实测校准；
      // 当前按官方驱动表现：byte3=1 恒定，byte4 波动视为链路状态
      return { percent, charging: false, voltageMv: null, raw: Array.from(res.slice(0, 12)) }
    }
    const response = await this.exchangeReport8(
      vgnBuildSimplePayload(VGN_COMMAND.battery),
      VGN_COMMAND.battery,
      RESPONSE_TIMEOUT_MS,
    )
    return vgnParseBattery(response)
  }

  // ---------- 配置区读写（report8 固件代际） ----------

  async read(address, length) {
    const response = await this.exchangeReport8(
      vgnBuildReadPayload(address, length),
      VGN_COMMAND.read,
      RESPONSE_TIMEOUT_MS,
    )
    const data = vgnParseReadResponse(response, address, length)
    if (!data) throw new Error(`地址 0x${address.toString(16)} 读取失败`)
    return data
  }

  async write(address, data) {
    const response = await this.exchangeReport8(
      vgnBuildWritePayload(address, data),
      VGN_COMMAND.write,
      RESPONSE_TIMEOUT_MS,
    )
    if (!vgnReportChecksumIsValid(response) || response[0] !== VGN_COMMAND.write || response[1] !== 0) {
      throw new Error(`地址 0x${address.toString(16)} 写入失败`)
    }
  }

  async writeScalar(address, value) {
    const response = await this.exchangeReport8(
      vgnBuildWriteScalarPayload(address, value),
      VGN_COMMAND.write,
      RESPONSE_TIMEOUT_MS,
    )
    if (!vgnReportChecksumIsValid(response) || response[0] !== VGN_COMMAND.write || response[1] !== 0) {
      throw new Error(`地址 0x${address.toString(16)} 写入失败`)
    }
    const confirmed = await this.read(address, 2)
    if (confirmed[0] !== value || ((confirmed[0] + confirmed[1]) & 0xff) !== 0x55) {
      throw new Error(`地址 0x${address.toString(16)} 的值未被保留`)
    }
  }

  async readPaced(address, length) {
    const data = await this.read(address, length)
    await new Promise((r) => setTimeout(r, 10))
    return data
  }

  /** 读全量配置区：[0x00,0x2c) 系统区 + [0xa8,0xb7) 高级区 */
  async readProfile() {
    const profile = new Uint8Array(0xb7)
    for (const [start, end] of [[0, 0x2c], [0xa8, 0xb7]]) {
      for (let address = start; address < end; address += 10) {
        const length = Math.min(10, end - address)
        profile.set(await this.readPaced(address, length), address)
      }
    }
    return profile
  }

  async readFirmware() {
    const response = await this.exchangeReport8(
      vgnBuildSimplePayload(VGN_COMMAND.firmware),
      VGN_COMMAND.firmware,
      RESPONSE_TIMEOUT_MS,
    )
    if (!vgnReportChecksumIsValid(response) || response[0] !== VGN_COMMAND.firmware || response[1] !== 0) {
      return null
    }
    return `v${response[5] ?? 0}.${(response[6] ?? 0).toString(16).padStart(2, '0')}`
  }

  /** 汇总状态。逐块容错：某块读不到时其余照常返回。 */
  async readStatus() {
    await this.open()
    const battery = await this.readBattery().catch(() => null)

    if (this.transport === 'feature64') {
      return {
        id: this.id,
        name: this.device.productName || 'VGN 无线鼠标',
        vid: this.device.vendorId,
        pid: this.device.productId,
        wireless: this.linkIndex === 1,
        batteryPercent: battery?.percent ?? null,
        batteryVoltageMv: battery?.voltageMv ?? null,
        batteryState: battery
          ? battery.charging
            ? battery.percent >= 99 ? 'Full' : 'Charging'
            : 'Discharging'
          : 'Unknown',
        firmware: null,
        profile: null,
        dpi: null,
        dpiStages: [],
        activeDpiStage: null,
        dpiStageCount: null,
        pollingRateHz: null,
        supportedPollingRates: SUPPORTED_POLLING_RATES,
        liftOffDistance: null,
        motionSync: null,
        angleSnapping: null,
        rippleControl: null,
        performanceMode: null,
        debounceMs: null,
        sleepTimeoutMin: null,
        buttonMappings: null,
        buttonOptions: null,
        lightingRow: null,
      }
    }

    const firmware = await this.readFirmware().catch(() => null)
    const profileBlob = await this.readProfile().catch(() => null)
    const profile = profileBlob ? vgnDecodeProfile(profileBlob) : null

    const dpiStages = []
    if (profileBlob) {
      for (let i = 0; i < (profile?.dpiStageCount ?? 0); i++) {
        const off = VGN_ADDRESS.dpiStages + i * 4
        dpiStages.push(vgnDecodeDpi(profileBlob.subarray(off, off + 4)) ?? 800)
      }
    }

    const keys = profileBlob
      ? await teevolutionReadKeyTable((address, length) => this.readPaced(address, length)).catch(() => null)
      : null

    const lightingRow = await this.read(LIGHTING_ROW, LIGHTING_LENGTH).catch(() => null)

    const wired = battery?.charging ?? false
    return {
      id: this.id,
      name: this.device.productName || 'VGN 无线鼠标',
      vid: this.device.vendorId,
      pid: this.device.productId,
      wireless: !wired,
      batteryPercent: battery?.percent ?? null,
      batteryVoltageMv: battery?.voltageMv ?? null,
      batteryState: battery
        ? battery.charging ? (battery.percent >= 99 ? 'Full' : 'Charging') : 'Discharging'
        : 'Unknown',
      firmware,
      profile,
      dpi: profile?.dpi ?? null,
      dpiStages,
      activeDpiStage: profile?.activeDpiStage ?? null,
      dpiStageCount: profile?.dpiStageCount ?? null,
      pollingRateHz: profile?.pollingRateHz ?? null,
      supportedPollingRates: SUPPORTED_POLLING_RATES,
      liftOffDistance: profile?.liftOffDistance ?? null,
      motionSync: profile?.motionSync ?? null,
      angleSnapping: profile?.angleSnapping ?? null,
      rippleControl: profile?.rippleControl ?? null,
      performanceMode: profile?.performanceMode ?? null,
      debounceMs: profile?.debounceMs ?? null,
      sleepTimeoutMin: profile ? profileToSleepMinutes(profile.sleepTimeout) : null,
      buttonMappings: keys ? teevolutionDecodeButtonMappings(keys, 0) : null,
      buttonOptions: keys ? TEEVOLUTION_SHARED_BUTTON_OPTIONS : null,
      lightingRow,
    }
  }

  // ---------- 设置类 API（写入后读回校验，失败抛错） ----------

  async setDpi(dpi) {
    const profile = vgnDecodeProfile(await this.readProfile())
    await this.write(VGN_ADDRESS.dpiStages + profile.activeDpiStage * 4, [...vgnEncodeDpi(dpi)])
    const confirmed = vgnDecodeProfile(await this.readProfile()).dpi
    if (confirmed !== dpi) throw new Error(`DPI 未生效（仍为 ${confirmed ?? '未知'}）`)
    return confirmed
  }

  async setDpiStageValue(stageIndex, dpi) {
    await this.write(VGN_ADDRESS.dpiStages + stageIndex * 4, [...vgnEncodeDpi(dpi)])
    const profileBlob = await this.readProfile()
    const off = VGN_ADDRESS.dpiStages + stageIndex * 4
    const confirmed = vgnDecodeDpi(profileBlob.subarray(off, off + 4))
    if (confirmed !== dpi) throw new Error(`DPI 未生效（仍为 ${confirmed ?? '未知'}）`)
    return confirmed
  }

  async setActiveDpiStage(index) {
    await this.writeScalar(VGN_ADDRESS.activeDpiStage, index)
    return index
  }

  async setPollingRate(rate) {
    await this.writeScalar(VGN_ADDRESS.pollingRate, vgnEncodePollingRate(rate))
    const confirmed = vgnDecodeProfile(await this.readProfile()).pollingRateHz
    if (confirmed !== rate) throw new Error(`回报率未生效（仍为 ${confirmed ?? '未知'} Hz）`)
    return confirmed
  }

  async setLiftOffDistance(value) {
    const raw = value === 'Low' ? 3 : value === 'Medium' ? 1 : 2
    await this.writeScalar(VGN_ADDRESS.lod, raw)
    const confirmed = vgnDecodeProfile(await this.readProfile()).liftOffDistance
    if (confirmed !== value) throw new Error('静默高度未生效')
    return confirmed
  }

  async setMotionSync(enabled) {
    await this.writeScalar(VGN_ADDRESS.motionSync, enabled ? 1 : 0)
    return enabled
  }

  async setAngleSnapping(enabled) {
    await this.writeScalar(VGN_ADDRESS.angleSnapping, enabled ? 1 : 0)
    return enabled
  }

  async setRippleControl(enabled) {
    await this.writeScalar(VGN_ADDRESS.rippleControl, enabled ? 1 : 0)
    return enabled
  }

  async setPerformanceMode(enabled) {
    await this.writeScalar(VGN_ADDRESS.performanceMode, enabled ? 1 : 0)
    return enabled
  }

  async setDebounceTime(value) {
    if (!Number.isInteger(value) || value < 0 || value > 30) throw new Error('防抖时间需为 0–30 ms')
    await this.writeScalar(VGN_ADDRESS.debounce, value)
    return value
  }

  async setSleepTimeout(minutes) {
    if (![1, 3, 6, 12, 30, 60, 180].includes(minutes)) throw new Error('不支持的睡眠超时档位')
    await this.writeScalar(VGN_ADDRESS.sleep, minutes)
    return minutes
  }

  async setButtonMapping(button, action) {
    await teevolutionRemapButton(
      (address, length) => this.readPaced(address, length),
      (address, data) => this.write(address, [...data]),
      button,
      action,
      { actions: TEEVOLUTION_SHARED_BUTTON_OPTIONS },
    )
  }

  // ---------- 实验性 DPI 指示灯（ATK R1 同源编码，读写均校验） ----------

  async setDpiLighting(mode, brightness, speed) {
    const block = Array.from(await this.read(LIGHTING_ROW, LIGHTING_LENGTH))
    const effect = mode === 0 ? [0, 0] : wePackScalarPair(mode === 2 ? 2 : 1)
    const bright = mode === 0 ? [0, 0] : wePackScalarPair(LIGHTING_BRIGHTNESS[brightness])
    block.splice(0, 2, ...effect)
    block.splice(2, 2, ...bright)
    block.splice(4, 2, ...wePackScalarPair(LIGHTING_SPEED[speed]))
    await this.write(LIGHTING_ROW, block)
    const after = Array.from(await this.read(LIGHTING_ROW, LIGHTING_LENGTH))
    if (after[0] !== block[0] || after[2] !== block[2]) throw new Error('灯效写入未生效')
    return { mode, brightness, speed }
  }
}

/** VGN 8K 固件帧：64 字节 feature 载荷，命令自 byte7 起，帧头 = (0xFF - 载荷和) */
function v8kFrame(cmdBytes) {
  const body = new Uint8Array(64)
  let sum = 0
  for (let i = 0; i < cmdBytes.length && 7 + i < 64; i++) {
    body[7 + i] = cmdBytes[i]
    sum = (sum + cmdBytes[i]) & 0xff
  }
  body[0] = (0xff - sum) & 0xff
  return body
}

/** vgnDecodeProfile 的睡眠值单位是 0.1 分钟，换算成分钟 */
function profileToSleepMinutes(raw) {
  if (!raw) return null
  return raw / 10
}
