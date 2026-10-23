// esbuild 打包入口：只导出本项目用到的协议编解码层（纯函数，无传输依赖）
export * from '@openmouse/protocol/vgn'
export {
  TEEVOLUTION_SHARED_BUTTON_OPTIONS,
  teevolutionReadKeyTable,
  teevolutionRemapButton,
  teevolutionDecodeButtonMappings,
} from '@openmouse/protocol/teevolution'
export { wePackScalarPair } from '@openmouse/protocol/endgame-gear-we'
