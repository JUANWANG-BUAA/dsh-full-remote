/** Real component smoke: viewports are emulated, not physical iOS/Android devices. */
import assert from 'node:assert/strict'

async function noHorizontalOverflow(dialog) {
  const overflow = await dialog.evaluate(root => [...root.querySelectorAll('*')]
    .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden]'))
    .filter(element => {
      const style = element.ownerDocument.defaultView.getComputedStyle(element)
      return !['hidden', 'clip'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 2
    }).map(element => element.tagName + '.' + element.className))
  assert.deepEqual(overflow, [], 'cockpit content must not require horizontal scrolling')
}

export async function runCockpitSmoke(browser, base) {
  const cases = [
    { width: 320, height: 568, theme: 'dark', lang: 'en' },
    { width: 390, height: 844, theme: 'light', lang: 'zh' },
    { width: 844, height: 390, theme: 'dark', lang: 'en' },
    { width: 1280, height: 900, theme: 'light', lang: 'en' },
  ]
  for (const fixture of cases) {
    const { width, height, theme, lang } = fixture
    const en = lang === 'en'
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 640, hasTouch: width < 640 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    try {
      const url = base + '/?demo=cockpit&theme=' + theme + '&lang=' + lang
      await page.goto(url)
      const launcher = page.getByRole('button', { name: en ? /Task cockpit,/ : /任务控制台，/ })
      await launcher.click()
      const dialog = page.getByRole('dialog')
      const box = await dialog.boundingBox()
      assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, 'panel outside viewport: ' + JSON.stringify({ fixture, box }))
      await noHorizontalOverflow(dialog)
      // Long unbroken session title must wrap in the detail view too.
      await page.getByRole('button', { name: /MobileConsoleIntegrationWithoutSpaces/ }).click()
      await noHorizontalOverflow(dialog)
      const custom = page.getByRole('textbox')
      await custom.fill('Retain this draft')
      await page.getByRole('button', { name: en ? 'Back to inbox' : '返回待办列表' }).click()
      await page.getByRole('button', { name: /MobileConsoleIntegrationWithoutSpaces/ }).click()
      assert.equal(await custom.inputValue(), 'Retain this draft')
      // Minimizing must not cancel the selected interaction or discard the draft.
      await page.getByRole('button', { name: en ? 'Minimize cockpit' : '收起控制台' }).click()
      await launcher.click()
      assert.equal(await custom.inputValue(), 'Retain this draft')
      await page.getByRole('button', { name: en ? 'Back to inbox' : '返回待办列表' }).click()
      await page.getByRole('button', { name: en ? /Review mobile release plan/ : /审核手机控制台发布计划/ }).click()
      await noHorizontalOverflow(dialog)
      const approve = page.getByRole('button', { name: en ? 'Approve plan' : '批准计划', exact: true })
      await approve.scrollIntoViewIfNeeded()
      const action = await approve.boundingBox()
      assert(action && action.y >= box.y && action.y + action.height <= height + 1, 'long plan action must be reachable')
      await approve.click()
      await page.getByText(en ? 'The selected item is no longer pending.' : '刚才选择的待办已不在列表中', { exact: false }).waitFor()
      assert.equal(await page.getByRole('button', { name: en ? /Review mobile release plan/ : /审核手机控制台发布计划/ }).count(), 0)
      await page.goto(url + '&connection=disconnected')
      await launcher.click()
      await page.getByRole('button', { name: en ? /Review read-only workspace inspection/ : /审核只读工作区检查/ }).click()
      const allow = page.getByRole('button', { name: en ? 'Allow once' : '允许一次', exact: true })
      assert(await allow.isDisabled(), 'disconnected approval must be disabled')
      await page.getByRole('button', { name: en ? 'Reconnect' : '重新连接' }).click()
      assert(await allow.isEnabled(), 'explicit fixture recovery restores the connected channel')
      assert.deepEqual(errors, [], 'no browser runtime errors')
      console.log('cockpit smoke passed: ' + width + 'x' + height + ' ' + theme + ' ' + lang)
    } finally { await context.close() }
  }
}
