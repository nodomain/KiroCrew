/**
 * Screenshot harness for the SQUARE ATTACHMENT TILES in the chat composer.
 *
 * Stages four REAL product screenshots (portrait phone shots, an extreme
 * panorama, a square-ish crop — read from temp-screenshots/ fixtures) on the
 * composer via a native paste, against the REAL built SPA (website/dist),
 * gateway-free. The aspect spread is the point: the old strip sized each chip
 * from the image's intrinsic ratio, so one row mixed 30px slivers with 246px
 * panoramas; the fix renders every image chip as a fixed 64x64 tile.
 *
 * ASSERTS as well as photographs: exits non-zero unless four chips render and
 * every thumbnail's rendered box is 64x64 (+-1px). Capturing a PRE-FIX build,
 * where chips legitimately vary, is the only case that needs
 * TILE_ALLOW_NONSQUARE=1.
 *
 * Usage: node scripts/capture-attach-square-tiles.mjs [outDir]
 *   TILE_LABEL=before TILE_ALLOW_NONSQUARE=1  -> capture the pre-fix build
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/attach-square-tiles'
const SLOT = 'chat-tiles'

mkdirSync(OUT, { recursive: true })

/** Real product screenshots with a deliberate aspect spread: two portrait
 *  (0.46 and 0.23), one extreme panorama (5.96), one near-square (0.89). */
const FIXTURES = [
  { name: 'phone-portrait.png', file: '../temp-screenshots/appstore-card-narrow/after-390px.png' },
  { name: 'tall-nav.png', file: '../temp-screenshots/agents-tab-label/after-crews-nav.png' },
  { name: 'panorama-card.png', file: '../temp-screenshots/above-composer-order/01-folder-card-with-options-dark.png' },
  { name: 'square-controls.png', file: '../temp-screenshots/action-row-button-height/control-row-before-after-320.png' },
]

const UPLOAD_DIR = '/home/user/.kiro/crew/uploads'
const uploadPaths = FIXTURES.map(f => `${UPLOAD_DIR}/${f.name}`)

const slots = [{
  key: SLOT,
  title: 'Attachment tile demo',
  running: false,
  last_message: 'Send the screenshots over and I will take a look.',
  messages: 2,
  agent: 'kirocrew',
  memory_mode: 'persistent',
  project: '',
  folder_id: '',
  modified: Math.floor(Date.now() / 1000),
  source_links: [],
  source_links_total: 0,
}]

const detail = {
  running: false,
  has_more: false,
  total: 2,
  queue: [],
  project: '',
  messages: [
    { role: 'user', ts: Date.now() / 1000 - 90, content: 'I have a few screenshots of the layout problem.' },
    { role: 'assistant', ts: Date.now() / 1000 - 60, content: 'Send the screenshots over and I will take a look.' },
  ],
}

/** Paste N image Files on the composer textarea in one native ClipboardEvent —
 *  the shape a real multi-screenshot clipboard produces. The bytes are the real
 *  fixture PNGs so the client-side resize path decodes them for real. */
async function pasteImages(page, files) {
  await page.evaluate(async payload => {
    const ta = document.querySelector('textarea[data-composer-typo]')
    if (!ta) throw new Error('composer textarea not found')
    ta.focus()
    const dt = new DataTransfer()
    for (const { name, b64 } of payload) {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      dt.items.add(new File([bytes], name, { type: 'image/png' }))
    }
    ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
  }, files)
}

async function shoot(page, label, width) {
  await page.setViewportSize({ width, height: 900 })
  await page.waitForTimeout(400)
  const strip = page.locator('[data-image-scope]').first()
  await strip.screenshot({ path: `${OUT}/${label}-${width}.png` })
  const metrics = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('[data-image-scope] img')]
    return imgs.map(i => {
      const r = i.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), fit: getComputedStyle(i).objectFit }
    })
  })
  console.log(`  ${label} @${width}px:`, JSON.stringify(metrics))
  return metrics
}

async function main() {
  const { srv, base } = await serveDist()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  logPageProblems(page)

  const payload = FIXTURES.map(f => ({ name: f.name, b64: readFileSync(f.file).toString('base64') }))

  const stubExtra = async (path, route) => {
    if (path === '/api/upload/file') { await json(route, { paths: uploadPaths }); return true }
    if (path === '/api/file-raw') {
      const url = decodeURIComponent(route.request().url())
      const fix = FIXTURES.find(f => url.includes(f.name)) || FIXTURES[0]
      await route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(fix.file) })
      return true
    }
    if (path.startsWith('/api/chat/slot/')) { await json(route, detail); return true }
    return false
  }
  await stubDashboardApi(page, { slots, extra: stubExtra })

  await page.goto(`${base}/chat/${SLOT}`)
  await page.waitForSelector('textarea[data-composer-typo]')
  await page.waitForTimeout(500)

  await pasteImages(page, payload)
  await page.waitForSelector(`img[alt*="${FIXTURES[0].name}"]`, { timeout: 15000 })
  await page.waitForTimeout(600)

  const label = process.env.TILE_LABEL || 'after'
  const m390 = await shoot(page, label, 390)
  const m1280 = await shoot(page, label, 1280)

  if (m390.length !== 4) throw new Error(`expected 4 chips, saw ${m390.length}`)
  if (m1280.length !== 4) throw new Error(`expected 4 chips at 1280px, saw ${m1280.length}`)
  // The fixed-square claim is the point of the fix, so it is checked by
  // DEFAULT. Only a capture of the pre-fix build, where chip width follows the
  // intrinsic ratio, opts out.
  if (!process.env.TILE_ALLOW_NONSQUARE) {
    const bad = [...m390, ...m1280].filter(c => Math.abs(c.w - 64) > 1 || Math.abs(c.h - 64) > 1 || c.fit !== 'cover')
    if (bad.length) throw new Error(`every tile must be 64x64 object-cover, saw ${JSON.stringify(bad)}`)
  }
  console.log(`${label} OK: 4 chips staged`)

  await browser.close()
  srv.close()
}

main().catch(err => { console.error(err); process.exit(1) })
