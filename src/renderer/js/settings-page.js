// 参数设置页：控件构建与 CompxHidClient 绑定（DPI / 回报率 / 传感器 / 按键 / DPI 指示灯）
const LOD_ZH = { Low: '低', Medium: '中', High: '高' }
const BUTTON_ZH = {
  Left: '左键',
  Right: '右键',
  Middle: '中键（滚轮按下）',
  Back: '侧键 · 后',
  Forward: '侧键 · 前',
  Bottom: '底部键',
}
const ACTION_ZH = {
  'Left Click': '左键点击',
  'Right Click': '右键点击',
  'Middle Click': '中键点击',
  Backward: '后退',
  Forward: '前进',
  'DPI Loop': 'DPI 循环切换',
  'DPI+': 'DPI 升档',
  'DPI-': 'DPI 降档',
  'Scroll Left': '滚轮左倾',
  'Scroll Right': '滚轮右倾',
  Disable: '禁用',
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

export function renderSettings({ container, status, client, toast, onApplied, onOpenWebDriver }) {
  container.innerHTML = ''
  let busy = false

  const run = async (fn, okMsg) => {
    if (busy) return
    busy = true
    try {
      await fn()
      toast(okMsg, 'ok')
      onApplied()
    } catch (err) {
      toast(err?.message || '操作失败', 'err')
    } finally {
      busy = false
    }
  }

  const card = (title, hint) => {
    const c = el('div', 'card')
    if (title) c.appendChild(el('div', 'card-title', hint ? `${title} · ${hint}` : title))
    container.appendChild(c)
    return c
  }

  // 8K 新固件（feature-64 传输）：自有配置读写协议尚未覆盖，引导到官方驱动页。
  // 注意须放在上面的辅助函数定义之后（TDZ），这也是 v0.1.0 曾把电量面板覆盖成空状态的根因。
  if (!status.profile) {
    const c = card('参数设置')
    const r = el('div', 'row')
    r.appendChild(el('div', 'row-label', '本鼠标为 VGN 8K 新固件'))
    const btn = el('button', 'btn btn-primary', '打开官方驱动设置')
    btn.addEventListener('click', () => onOpenWebDriver?.())
    r.appendChild(btn)
    c.appendChild(r)
    const hint = el('div', 'about-text')
    hint.textContent = '电量监控已原生支持。DPI、回报率、灯效、按键映射等完整设置请使用内置的官方网页驱动完成（侧栏「官方驱动」），与官方客户端功能完全一致。'
    c.appendChild(hint)
    return
  }

  const row = (parent, label, control, hint) => {
    const r = el('div', 'row')
    const lab = el('div', 'row-label', label)
    if (hint) lab.appendChild(el('div', 'row-hint', hint))
    r.appendChild(lab)
    r.appendChild(control)
    parent.appendChild(r)
    return r
  }

  const makeSwitch = (value, onChange) => {
    const wrap = el('label', 'switch')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = !!value
    input.addEventListener('change', () => onChange(input.checked))
    wrap.appendChild(input)
    wrap.appendChild(el('i'))
    return wrap
  }

  const makeSegmented = (options, value, onChange) => {
    const seg = el('div', 'segmented wide')
    for (const opt of options) {
      const btn = el('button', opt.value === value ? 'active' : '', opt.label)
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'))
        btn.classList.add('active')
        onChange(opt.value)
      })
      seg.appendChild(btn)
    }
    return seg
  }

  const setSliderFill = (input) => {
    const p = ((input.value - input.min) / (input.max - input.min)) * 100
    input.style.background = `linear-gradient(to right, var(--accent) ${p}%, var(--track) ${p}%)`
  }

  /** 滑动过程实时显示数值，松手（change）才写入设备 */
  const makeSlider = ({ min, max, step, value, format, onCommit }) => {
    const group = el('div', 'slider-group')
    const input = document.createElement('input')
    input.type = 'range'
    input.min = min
    input.max = max
    input.step = step
    input.value = value ?? min
    const val = el('span', 'slider-value', format(input.value))
    setSliderFill(input)
    input.addEventListener('input', () => {
      val.textContent = format(input.value)
      setSliderFill(input)
    })
    input.addEventListener('change', () => onCommit(Number(input.value)))
    group.appendChild(input)
    group.appendChild(val)
    return { group, input, set(v) { input.value = v; val.textContent = format(v); setSliderFill(input) } }
  }

  const makeSelect = (options, value, onChange) => {
    const sel = document.createElement('select')
    for (const opt of options) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.label
      sel.appendChild(o)
    }
    sel.value = value
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  // ---------- 灵敏度（DPI）----------
  if (status.dpiStageCount) {
    const c = card('灵敏度（DPI）')
    const stages = status.dpiStages.length
      ? status.dpiStages
      : Array.from({ length: status.dpiStageCount }, (_, i) => (i === status.activeDpiStage ? status.dpi : 800))

    let selected = status.activeDpiStage ?? 0
    const stageSeg = makeSegmented(
      stages.map((_, i) => ({ value: i, label: `第 ${i + 1} 档` })),
      selected,
      (v) => run(() => client.setActiveDpiStage(v), `已切换到第 ${v + 1} 档`).then(() => {
        selected = v
        slider.set(stages[v])
      }),
    )
    row(c, '当前档位', stageSeg)

    const slider = makeSlider({
      min: 50,
      max: 26000,
      step: 50,
      value: stages[selected],
      format: (v) => `${Number(v).toLocaleString()} DPI`,
      onCommit: (v) =>
        run(() => client.setDpiStageValue(selected, v), `第 ${selected + 1} 档 DPI 已设为 ${v.toLocaleString()}`),
    })
    row(c, `第 ${selected + 1} 档 DPI`, slider.group, '松手后写入鼠标')
    // 切换档位时同步滑条标签
    stageSeg.querySelectorAll('button').forEach((b, i) => {
      b.addEventListener('click', () => {
        slider.set(stages[i])
        const lab = slider.group.closest('.row').querySelector('.row-label')
        lab.firstChild.textContent = `第 ${i + 1} 档 DPI `
      })
    })
  }

  // ---------- 回报率 ----------
  if (status.pollingRateHz) {
    const c = card('回报率')
    row(
      c,
      '轮询频率',
      makeSegmented(
        status.supportedPollingRates.map((r) => ({ value: r, label: `${r} Hz` })),
        status.pollingRateHz,
        (v) => run(() => client.setPollingRate(v), `回报率已设为 ${v} Hz`),
      ),
      '数值越高指针越跟手，功耗也越高',
    )
  }

  // ---------- 传感器与响应 ----------
  if (status.profile) {
    const c = card('传感器与响应')
    if (status.liftOffDistance) {
      row(
        c,
        '静默高度（LOD）',
        makeSegmented(
          ['Low', 'Medium', 'High'].map((v) => ({ value: v, label: LOD_ZH[v] })),
          status.liftOffDistance,
          (v) => run(() => client.setLiftOffDistance(v), `静默高度已设为${LOD_ZH[v]}`),
        ),
      )
    }
    if (status.motionSync !== null && status.motionSync !== undefined) {
      row(c, 'Motion Sync', makeSwitch(status.motionSync, (v) => run(() => client.setMotionSync(v), `Motion Sync 已${v ? '开启' : '关闭'}`)), '开启后轨迹更平滑，延迟略增')
    }
    if (status.angleSnapping !== null && status.angleSnapping !== undefined) {
      row(c, '角度修正', makeSwitch(status.angleSnapping, (v) => run(() => client.setAngleSnapping(v), `角度修正已${v ? '开启' : '关闭'}`)), '直线更直，不适合精确瞄准')
    }
    if (status.rippleControl !== null && status.rippleControl !== undefined) {
      row(c, '波纹控制', makeSwitch(status.rippleControl, (v) => run(() => client.setRippleControl(v), `波纹控制已${v ? '开启' : '关闭'}`)))
    }
    if (status.performanceMode !== null && status.performanceMode !== undefined) {
      row(c, '性能模式', makeSwitch(status.performanceMode, (v) => run(() => client.setPerformanceMode(v), `性能模式已${v ? '开启' : '关闭'}`)), '关闭可延长续航')
    }
    if (status.debounceMs !== null && status.debounceMs !== undefined) {
      row(
        c,
        '防抖时间',
        makeSlider({
          min: 0,
          max: 30,
          step: 1,
          value: status.debounceMs,
          format: (v) => `${v} ms`,
          onCommit: (v) => run(() => client.setDebounceTime(v), `防抖时间已设为 ${v} ms`),
        }).group,
      )
    }
    if (status.sleepTimeoutMin) {
      row(
        c,
        '自动休眠',
        makeSelect(
          [1, 3, 6, 12, 30, 60, 180].map((m) => ({
            value: m,
            label: m >= 60 ? `${m / 60} 小时` : `${m} 分钟`,
          })),
          String(status.sleepTimeoutMin),
          (v) => run(() => client.setSleepTimeout(Number(v)), '休眠时间已更新'),
        ),
        '闲置多久后休眠以省电',
      )
    }
  }

  // ---------- 按键映射 ----------
  if (status.buttonMappings) {
    const c = card('按键映射')
    const options = status.buttonOptions || []
    for (const [button, action] of Object.entries(status.buttonMappings)) {
      row(
        c,
        BUTTON_ZH[button] || button,
        makeSelect(
          options.map((a) => ({ value: a, label: ACTION_ZH[a] || a })),
          action,
          (v) => run(() => client.setButtonMapping(button, v), `${BUTTON_ZH[button] || button}已设为「${ACTION_ZH[v] || v}」`),
        ),
      )
    }
  }

  // ---------- DPI 指示灯（实验性）----------
  {
    const c = card('DPI 指示灯', status.lightingRow ? '实验性' : '未确认支持')
    if (!status.lightingRow) {
      const r = el('div', 'row')
      r.appendChild(el('div', 'row-label', '该型号固件未响应灯效指令'))
      r.appendChild(el('div', 'row-value', '暂不可用'))
      c.appendChild(r)
    } else {
      let mode = 1
      let brightness = 1
      let speed = 1
      row(c, '模式', makeSegmented(
        [{ value: 0, label: '关闭' }, { value: 1, label: '常亮' }, { value: 2, label: '呼吸' }],
        mode, (v) => { mode = v },
      ))
      row(c, '亮度', makeSegmented(
        [{ value: 0, label: '低' }, { value: 1, label: '中' }, { value: 2, label: '高' }],
        brightness, (v) => { brightness = v },
      ))
      row(c, '速度', makeSegmented(
        [{ value: 0, label: '慢' }, { value: 1, label: '中' }, { value: 2, label: '快' }],
        speed, (v) => { speed = v },
      ))
      const btnRow = el('div', 'row-buttons')
      const apply = el('button', 'btn btn-primary', '应用到鼠标')
      apply.addEventListener('click', () =>
        run(() => client.setDpiLighting(mode, brightness, speed), '灯效已更新'),
      )
      btnRow.appendChild(apply)
      c.appendChild(btnRow)
    }
  }
}
