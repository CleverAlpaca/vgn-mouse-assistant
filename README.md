# VGN 鼠标助手

苹果风格（macOS 系统设置风）的 VGN/ATK/VXE 系无线鼠标 Windows 桌面工具。

## 功能

| 功能 | 支持情况 |
|---|---|
| 实时电量监控 | ✅ 原生实现（Compx/Nordic 族，含 8K 新固件如蜻蜓 3 Pro Max） |
| 低电量系统通知 | ✅ 阈值可调（10%/20%/30%），带迟滞防重复 |
| 断线自动重连 | ✅ 插拔/休眠自动恢复 |
| DPI / 回报率 / 传感器 / 按键映射 / DPI 灯 | ✅ 原生实现（17 字节 report-8 老固件：VGN F1/F2、VXE R1、ATK 系等） |
| 8K 新固件参数设置 | ✅ 内嵌官方网页驱动（hub.vgnlab.com.cn），功能与官方一致 |
| 界面 | macOS 风格：红绿灯窗控、侧栏导航、毛玻璃、iOS 控件、深浅色跟随系统 |

## 运行

```bash
npm install        # 首次
npm run bundle     # 生成协议层 bundle（依赖变更后需重跑）
npm start          # 启动
```

## 打包

```bash
npm run dist       # 产出 NSIS 安装包 + 便携版（dist/ 目录）
```

## 技术说明

- **架构**：Electron + WebHID（渲染层直连 HID，零原生编译依赖）
- **老固件（report-8 / 17 字节）**：协议编解码复用开源的
  [OpenMouse mouse-protocol](https://github.com/OpenMouse-Project/mouse-protocol)（AGPL-3.0）；
  电量协议参考 [Fan4Metal/mouse_tray](https://github.com/Fan4Metal/mouse_tray) 的 Nordic 52840 逆向文档
- **8K 新固件（feature-64）**：报文格式通过嗅探官方网页驱动实测得到——
  64 字节 feature report（ID 0），帧头 = `(0xFF - 载荷和) & 0xFF`，命令置于 byte7；
  状态查询命令 `0x08`，响应 byte2 为电量百分比。配置读写（DPI 等）尚未覆盖，
  由内嵌官方网页驱动兜底；官方驱动运行于本应用内时其 HID 报文会被记录到
  `%APPDATA%/vgn-mouse-assistant/v8k-capture.log`，作为后续自有实现的协议样本库
- **许可**：本应用个人使用；如需再分发，须遵守 OpenMouse 协议库的 AGPL-3.0 开源义务

## 目录

```
src/main.js               主进程：窗口 / WebHID 权限 / 内嵌官方驱动 / 通知
src/preload.js            安全桥
src/renderer/mac.css      苹果风设计系统
src/renderer/js/compx.js  HID 协议客户端（report8 + feature64 双传输）
src/renderer/js/device.js 设备发现 / 连接 / 热插拔
src/renderer/js/battery.js 电量轮询 / 低电量迟滞
```
