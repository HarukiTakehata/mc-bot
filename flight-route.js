// 鞘翅负责主要路程，确认落地后复用现有安全步行完成精确对接。
// 不放宽飞行的到达误差，也不把备用降落冒充目的地完成。
const MAX_WALK = 512 // 落点半径、盘旋和滑出去的距离；再远就不是"最后一段"了
async function finishFlightRoute(bot, target, result, ctx) {
  ctx.assertActive()
  if (result.ok || !result.landed || !['arrival', 'destination_no_site'].includes(result.reason)) return result
  const p = bot.entity?.position
  if (!p || ![p.x, p.y, p.z, target.x, ctx.freeY ? 0 : target.y, target.z].every(Number.isFinite)) return result
  const distance = Math.hypot(p.x - target.x, p.z - target.z)
  if (distance > MAX_WALK || !(bot.entity.onGround || bot.entity.isInWater)) return result
  const flightLandedAt = { x: p.x, y: p.y, z: p.z }
  ctx.say?.(`已落地，步行对接最后约${Math.ceil(distance)}格`)
  await ctx.walk(target)
  ctx.assertActive()
  const final = bot.entity.position
  const reached = !!(bot.entity.onGround || bot.entity.isInWater) && Math.hypot(final.x - target.x, final.z - target.z) <= 2 && (ctx.freeY || Math.abs(final.y - target.y) <= 2)
  return { ...result, ok: reached, reached, position: { x: final.x, y: final.y, z: final.z },
    flightLandedAt, finalApproach: 'walk', reason: reached ? 'hybrid_arrival' : 'approach_incomplete' }
}
module.exports = { finishFlightRoute }
