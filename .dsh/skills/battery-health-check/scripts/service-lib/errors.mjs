/**
 * 工具集统一的错误类型。
 *
 * 带 code 是为了让插件壳能把内部故障翻译成模型可以直接转述给用户的话——
 * 「没检测到电池」和「脚本崩了」对用户是完全不同的两件事，不能都变成一句 Error。
 */
export class ToolkitError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ToolkitError'
    this.code = code
  }
}

/** 把内部错误转成一行可读文本，未知错误也不会丢失信息 */
export function toText(err) {
  if (err instanceof ToolkitError) return `[${err.code}] ${err.message}`
  return String(err?.message || err)
}
