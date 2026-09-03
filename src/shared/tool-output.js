/** DSH 工具统一使用现有 ToolEnvelope，避免不同工具各自发明错误格式。 */
export const envelopeOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ],
}

export function imageEnvelopeOutput(mimeType, contentKey) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const parts = [{ type: 'text', text: JSON.stringify(value.envelope, null, 2) }]
      if (value[contentKey]) {
        parts.push({
          type: 'image',
          data: Buffer.from(value[contentKey], 'utf8').toString('base64'),
          mimeType,
        })
      }
      return parts
    },
  }
}
