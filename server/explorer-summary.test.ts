import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstParagraph, leadingDoc } from './explorer-summary.ts'

test('firstParagraph skips headings, front matter, badges and lists', () => {
  assert.equal(firstParagraph('---\nx: 1\n---\n# Dashboards development guide\n\n![badge](x)\n\n- a list\n\nThis product owns dashboards, dashboard tiles, templates, and widget tiles.\nMore.\n'), 'This product owns dashboards, dashboard tiles, templates, and widget tiles. More.')
})
test('leadingDoc reads a Python docstring or a leading block comment', () => {
  assert.equal(leadingDoc('# comment\n"""Alert checks: evaluate insight thresholds and notify."""\nimport x'), 'Alert checks: evaluate insight thresholds and notify.')
  assert.equal(leadingDoc('/**\n * Renders the dashboard grid and handles tile layout.\n */\nexport {}'), 'Renders the dashboard grid and handles tile layout.')
  assert.equal(leadingDoc('import x from "y"'), '')
})
