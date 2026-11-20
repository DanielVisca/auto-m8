import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachmentParts, saveAttachment } from './attachments.ts'

test('pasted images keep their path in the prompt so the thread can preview them', () => {
  const png = saveAttachment({ name: 'shot.png', base64: Buffer.from('fake').toString('base64') })
  const log = saveAttachment({ name: 'out.log', text: 'a\nb' })
  const { images, note } = attachmentParts([
    { path: png.path, name: 'shot.png', kind: 'image', media_type: 'image/png' },
    { path: log.path, name: 'out.log', kind: 'file', lines: 2 },
    { path: '/etc/passwd', name: 'x', kind: 'file' },
  ])
  assert.equal(images.length, 1)
  assert.match(note, new RegExp(`<attached-images>\\n- ${png.path}\\n</attached-images>`))
  assert.match(note, /<attached-files>[\s\S]*out\.log[\s\S]*<\/attached-files>/)
  assert.doesNotMatch(note, /passwd/)
})
