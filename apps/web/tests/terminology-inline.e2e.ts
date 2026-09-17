// Web e2e: inline terminology annotations on a touch-first viewport.
// One seeded settled turn carries two glossary hits — a project-layer ASCII term and a global-layer Chinese one.
// The touch scenario proves the assembled feature end to end.
// The annotated trigger is a button in the accessibility tree.
// A tap opens its tooltip and moving away keeps it open (click mode).
// The tooltip carries plain text only, the dotted underline reads without hover, and Escape dismisses.
// The overlay enables the row without an explain route, so no model is ever called; the manual-lookup path stays out of this scenario.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/terminology-inline', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/terminology-inline/ui.expected.md', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./terminology-inline.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'terminology-inline-web-e2e'
const DONE = 'TERMINOLOGY_FIXTURE_DONE'

const PROJECT_TERM = 'Transformer'
const PROJECT_EXPLANATION = 'Project glossary: attention-based network architecture.'
const GLOBAL_TERM = '模型'
const GLOBAL_EXPLANATION = 'Global glossary: a trained network ready for inference.'

/** One-part text content for a built message. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** The settled fixture turn: both terms appear once, inside assistant prose. */
function fixture(): string {
  const session = Session.create(SessionId('terminology-inline-source'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: text('Summarize the annotated vocabulary of this document.'),
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: text([
        'The Transformer layer reads each token once.',
        '',
        `本节用一句话说明 ${GLOBAL_TERM} 的作用。`,
        '',
        DONE,
      ].join('\n')),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: inline terminology annotations (touch)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // Both glossary layers are fed through their production stores before
    // any browser exists: the project layer is the seeded session workspace's
    // `.dsh/terminology.yml`, and the global layer is a real settings write
    // through the mounted file-backed settings service.
    const projectDir = `${scaffold.workspaceCwd}/.dsh`
    await mkdir(projectDir, { recursive: true })
    await writeFile(`${projectDir}/terminology.yml`, [
      'terms:',
      `  - term: ${JSON.stringify(PROJECT_TERM)}`,
      `    explanation: ${JSON.stringify(PROJECT_EXPLANATION)}`,
      '',
    ].join('\n'))
    await scaffold.ctx.settings.mutate('terminology', [{
      op: 'set',
      path: ['terms'],
      value: [{ term: GLOBAL_TERM, explanation: GLOBAL_EXPLANATION }],
    }])
    await seedSession(scaffold, fixture(), SEED_ID)
    browser = await chromium.launch()
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('opens the annotated term through a tap and keeps the touch contract', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-terminology-inline'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // Both layers annotate: one button per term, and the trigger role is a
    // button in the accessibility tree regardless of any hover styling.
    const projectButton = page.getByRole('button', { name: /Transformer/ })
    await expect.poll(() => projectButton.count(), { timeout: 10_000 }).toBe(1)
    expect(await page.getByRole('button', { name: new RegExp(GLOBAL_TERM) }).count()).toBe(1)

    // The non-hover affordance (WCAG 1.4.13): the dotted underline is the
    // resting computed style, read without ever moving the pointer here.
    const styleOf = async (property: string): Promise<string> =>
      projectButton.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property)
    expect(await styleOf('text-decoration-line')).toBe('underline')
    expect(await styleOf('text-decoration-style')).toBe('dotted')

    // Touch opens: a tap (no hover) raises the tooltip with the project-layer
    // explanation.
    await projectButton.tap()
    const tooltip = page.getByRole('tooltip')
    await tooltip.waitFor({ state: 'visible', timeout: 5_000 })
    const tipText = await tooltip.textContent()
    expect(tipText?.trim() ?? '').toBe(PROJECT_EXPLANATION)
    // The explanation is plain text: no buttons hide inside the tooltip.
    expect(await tooltip.getByRole('button').count()).toBe(0)

    // The bubble must size to its content. It is an absolutely positioned child
    // of an inline box, so an automatic width shrink-wraps against the trigger's
    // own width instead of the viewport; a sentence then renders one word per
    // line in a column as tall as the answer. Count real line boxes.
    const tipLines = await tooltip.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getClientRects().length
    })
    expect(tipLines).toBeLessThanOrEqual(3)

    // Click mode: pointer travel away from the trigger leaves it open.
    const box = await projectButton.boundingBox()
    if (box === null) throw new Error('annotated term has no bounding box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.move(10, 10)
    expect(await tooltip.isVisible()).toBe(true)

    // Dismissible: Escape closes it.
    await projectButton.press('Escape')
    await tooltip.waitFor({ state: 'hidden', timeout: 5_000 })

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 120_000)
})
