// 电量轮询：连接期间周期查询，连续失败判定离线/休眠
export class BatteryMonitor {
  constructor(client, intervalMs = 5000) {
    this.client = client
    this.intervalMs = intervalMs
    this.timer = null
    this.failures = 0
    this.last = null
  }

  start(onUpdate) {
    this.stop()
    const tick = async () => {
      try {
        const battery = await this.client.readBattery()
        if (!battery) throw new Error('无电量数据')
        this.failures = 0
        this.last = battery
        onUpdate({ online: true, ...battery })
      } catch {
        this.failures += 1
        // 连续失败视为休眠/离线，但保留最后读数；鼠标动一下会自动恢复
        onUpdate({ online: this.failures < 2, asleep: true, ...this.last, percent: this.last?.percent ?? null })
      }
    }
    tick()
    this.timer = setInterval(tick, this.intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** 低电量提醒的迟滞逻辑：低于阈值触发一次，回升到阈值+10% 后重新武装 */
export class LowBatteryGuard {
  constructor(getThreshold) {
    this.getThreshold = getThreshold
    this.armed = true
  }

  /** 返回 true 表示应当弹通知 */
  feed(percent) {
    if (percent === null || percent === undefined) return false
    const threshold = this.getThreshold()
    if (this.armed && percent <= threshold && percent > 0) {
      this.armed = false
      return true
    }
    if (!this.armed && percent >= threshold + 10) this.armed = true
    return false
  }
}
