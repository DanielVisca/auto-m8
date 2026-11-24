import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, settings } from './settings.ts'
import { slackAppLink, slackTeams } from './slack.ts'

test('Slack workspaces come from the slack.teams setting, empty by default', () => {
  assert.deepEqual(defaults.slack.teams, [])
  assert.deepEqual(slackTeams([]), { byWorkspace: {}, any: undefined })
  assert.deepEqual(slackTeams(['acme:T0123ABCD', 'Other = T999', 'junk', 42, 'T0DEFAULT']), { byWorkspace: { acme: 'T0123ABCD', other: 'T999' }, any: 'T0DEFAULT' })
  assert.deepEqual(slackTeams(undefined), { byWorkspace: {}, any: undefined })
})

test('a workspace archive link opens in the Slack app only when its team is known', () => {
  const saved = settings.slack
  const env = process.env.PERCH_SLACK_TEAM_ID
  delete process.env.PERCH_SLACK_TEAM_ID
  try {
    assert.equal(slackAppLink('https://app.slack.com/client/T111/C222'), 'slack://channel?team=T111&id=C222')
    settings.slack = { teams: [] }
    assert.equal(slackAppLink('https://acme.slack.com/archives/C222/p1794441283123456'), null)
    settings.slack = { teams: ['acme:T0123ABCD'] }
    assert.equal(slackAppLink('https://acme.slack.com/archives/C222/p1794441283123456'), 'slack://channel?team=T0123ABCD&id=C222')
    assert.equal(slackAppLink('https://other.slack.com/archives/C222'), null)
  } finally {
    settings.slack = saved
    if (env !== undefined) process.env.PERCH_SLACK_TEAM_ID = env
  }
})
