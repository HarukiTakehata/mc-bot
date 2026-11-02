const { test } = require('node:test')
const assert = require('node:assert/strict')
const { finishFlightRoute } = require('../flight-route')
const target = { x: 300, y: 64, z: 0 }
function make() {
  const bot = { entity: { position: { x: 314, y: 64, z: 9 }, onGround: true } }
  const result = { ok: false, reached: false, landed: true, reason: 'arrival', position: { ...bot.entity.position }, rocketsUsed: 2 }
  return { bot, result }
}
test('落地误差保留真实飞行落点，再由原有步行和读回完成精确到达', async () => {
  const { bot, result } = make()
  let walked = 0
  const outcome = await finishFlightRoute(bot, target, result, { assertActive() {}, async walk(p) { walked++; bot.entity.position = { ...p } } })
  assert.equal(walked, 1)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.finalApproach, 'walk')
  assert.deepEqual(outcome.flightLandedAt, { x: 314, y: 64, z: 9 })
  assert.deepEqual(outcome.position, target)
})
test('落点在水里（目标在水边）也算到达', async () => {
  const { bot, result } = make()
  bot.entity.onGround = false
  bot.entity.isInWater = true
  const outcome = await finishFlightRoute(bot, target, result, { assertActive() {}, async walk(p) { bot.entity.position = { ...p } } })
  assert.equal(outcome.ok, true)
})
test('取消、备用降落、未着地、距离过大不会继续步行；步行未到也不能成功', async () => {
  let walked = 0
  const ctx = { assertActive() {}, async walk() { walked++ } }
  for (const change of ['stop', 'air', 'far']) {
    const { bot, result } = make()
    if (change === 'stop') result.reason = 'stop'
    if (change === 'air') bot.entity.onGround = false
    if (change === 'far') bot.entity.position.x = 900
    assert.equal((await finishFlightRoute(bot, target, result, ctx)).ok, false)
  }
  assert.equal(walked, 0)
  const { bot, result } = make()
  await assert.rejects(finishFlightRoute(bot, target, result, { assertActive() { throw new Error('cancelled') }, walk: ctx.walk }), /cancelled/)
  assert.equal(walked, 0)
  const partial = await finishFlightRoute(bot, target, result, ctx)
  assert.equal(partial.ok, false)
  assert.equal(partial.reason, 'approach_incomplete')
})
