'use strict'

const guidance = require('./flight-guidance')

class LandingRequested extends Error {}
class DisposedFlight extends Error {}
// 实测巡航速度和烟花效率（实验服长途），只用来做预检估算
const CRUISE_BLOCKS_PER_SECOND = 25
const BLOCKS_PER_ROCKET = 100

function createFlight(bot, ctx) {
  if (typeof ctx?.assertActive !== 'function' || typeof ctx?.delay !== 'function' ||
      typeof ctx?.safetyLook !== 'function' || typeof ctx?.safetyGlide !== 'function' ||
      typeof ctx?.safetyDelay !== 'function') throw new Error('飞行需要可取消runtime和限定降落接口')
  const config = guidance.options(ctx.flightOptions)
  const now = ctx.now || Date.now
  let current = null, serial = 0, destroyed = false, lastStatus = { phase: 'IDLE' }

  function live(session) {
    if (destroyed || session.disposed || current !== session) throw new DisposedFlight()
  }
  function normal(session) {
    live(session)
    if (session.landReason) throw new LandingRequested(session.landReason)
    ctx.assertActive()
  }
  function phase(session, name) {
    live(session)
    session.phase = name
    ctx.log?.('[flight]', session.id, name, session.landReason || '')
  }
  function status() {
    if (!current) return { ...lastStatus }
    const s = current
    return { id: s.id, phase: s.phase, landing: s.phase === 'LANDING', reason: s.landReason,
      target: { ...s.target }, position: guidance.copyPosition(bot.entity?.position),
      rocketsUsed: s.rocketsUsed, elapsedMs: Math.max(0, now() - s.started),
      landingTimedOut: s.landingTimedOut, destinationState: s.destinationState, active: true }
  }
  function requestLand(reason = 'stop_requested') {
    if (!current || current.disposed) return false
    if (!current.landReason) current.landReason = String(reason).slice(0, 160)
    return true
  }
  function dispose(reason = 'disposed') {
    if (destroyed) return
    destroyed = true
    if (current) {
      current.disposed = true
      current.landReason = String(reason).slice(0, 160)
      current.wake?.()
      lastStatus = { ...status(), phase: 'DISPOSED', active: false, reason: current.landReason }
      current = null
    } else lastStatus = { phase: 'DISPOSED', active: false, reason: String(reason).slice(0, 160) }
  }
  async function wait(session, safety = false) {
    live(session)
    const delay = safety ? ctx.safetyDelay : ctx.delay
    await Promise.race([delay(config.tickMs), session.disposedPromise])
    live(session)
    if (!safety) normal(session)
  }
  async function look(session, yaw, pitch, safety = false) {
    if (safety) {
      live(session)
      if (session.phase !== 'LANDING') return
      await ctx.safetyLook(yaw, pitch)
      live(session)
    } else {
      normal(session)
      await bot.look(yaw, pitch, true)
      normal(session)
    }
  }
  function stableGround(session) {
    // 落进水里也算停下了（海上没有能落的地方时就是这样），之后游/走上岸
    if ((bot.entity?.onGround || bot.entity?.isInWater) && guidance.speed(bot) <= (bot.entity?.isInWater ? 0.3 : config.stableSpeed)) session.stable++
    else session.stable = 0
    return session.stable >= config.stableTicks
  }
  function result(session, landed, reason) {
    const position = guidance.copyPosition(bot.entity?.position)
    const site = landed && position ? guidance.landingSite(bot, position, bot.entity.yaw || 0, config) : null
    // y 只是落点提示：地面实际高度由落地时读到的为准
    const reached = !!(landed && site && guidance.horizontalDistance(position, session.target) <= config.arrivalRadius &&
      (session.freeY || !!session.destination || Math.abs(position.y - session.target.y) <= 3))
    return { ok: reached && reason === 'arrival', reached, landed, reason, position,
      rocketsUsed: session.rocketsUsed, durationMs: Math.max(0, now() - session.started) }
  }
  // 备降点：路上有就更新，没有不算失败（海面、林子上空本来就没有，降落时再就近找）
  function survey(session) {
    live(session)
    const p = bot.entity.position
    const yaw = guidance.yawTo(p, session.target)
    const here = guidance.landingSite(bot, p, yaw, config)
    if (here) session.fallback = here
    // 目的地进了加载范围才找落点，每秒找一次；A loaded center is not proof that the runway perimeter is loaded.
    const distance = guidance.horizontalDistance(p, session.target)
    if (distance <= 256 && now() - session.lastDestinationSearch >= 1000 && !(session.destination && guidance.landingSite(bot, session.destination, yaw, config))) {
      session.lastDestinationSearch = now()
      const found = guidance.findLandingNear(bot, session.target, yaw, config)
      session.destinationState = found.status
      session.destination = found.site
    }
    return { yaw }
  }
  function preflight(session) {
    normal(session)
    const target = session.target, p = bot.entity?.position
    session.freeY = target.y == null
    const assessed = assess(target)
    if (!assessed.ok) throw Object.assign(new Error(`飞行预检失败: ${assessed.code}；${assessed.message}`), { code: assessed.code })
    if (session.freeY) target.y = p.y
    survey(session) // 目标还未加载并不妨碍长途飞行；实际航程中继续找落点。
    session.launchYaw = assessed.launch.yaw
    session.baseCruiseY = Math.max(p.y, session.freeY ? -Infinity : target.y) + config.climbHeight
    session.cruiseY = session.baseCruiseY
  }
  function remaining(item) {
    if (item?.name !== 'elytra' || !Number.isFinite(item.maxDurability) || !Number.isFinite(item.durabilityUsed) ||
        item.durabilityUsed < 0 || item.durabilityUsed > item.maxDurability) return 0
    return Math.max(0, item.maxDurability - item.durabilityUsed)
  }
  // Read-only planning shares every launch/resource rule with real preflight.
  // Inventory APIs can include equipment, so count each physical item once.
  function assess(target, { candidateElytra } = {}) {
    const p = bot.entity?.position, slot = bot.getEquipmentDestSlot?.('torso') ?? 6
    const worn = bot.inventory?.slots?.[slot]
    const items = [...(bot.inventory?.slots || []), ...guidance.inventoryItems(bot)].filter(Boolean)
    const unique = [], seenObjects = new Set(), seenSlots = new Set()
    for (const item of items) {
      if (seenObjects.has(item) || (Number.isInteger(item.slot) && item.slot >= 0 && seenSlots.has(item.slot))) continue
      seenObjects.add(item)
      if (Number.isInteger(item.slot) && item.slot >= 0) seenSlots.add(item.slot)
      unique.push(item)
    }
    const y = target?.y == null ? p?.y : target.y
    const valid = !!p && [p.x, p.y, p.z, target?.x, y, target?.z].every(Number.isFinite)
    const distance = valid ? guidance.horizontalDistance(p, target) : null
    const requiredRockets = valid ? Math.ceil(distance / BLOCKS_PER_ROCKET) + 4 : null
    const requiredDurability = valid ? Math.ceil(distance / CRUISE_BLOCKS_PER_SECOND) + 60 + config.durabilityReserve : null
    const value = { ok: false, code: 'invalid_target', distance, requiredRockets,
      availableRockets: guidance.rocketCount(bot), requiredDurability,
      availableDurability: unique.reduce((sum, item) => sum + remaining(item), 0),
      launch: { ok: false, code: 'not_checked', yaw: null } }
    const fail = (code, message) => ({ ...value, code, message })
    if (destroyed) return fail('disposed', '飞行模块已销毁，请等待重生或重连')
    if (current && current.phase !== 'PREFLIGHT') return fail('flight_active', '仍在飞行或等待确认落地')
    if (!valid) return fail('invalid_target', '飞行目标必须是有限坐标')
    if (Math.abs(target.x) > 29_999_984 || Math.abs(target.z) > 29_999_984 || y < -64 || y >= 320) return fail('target_out_of_world', '飞行目标超出世界范围')
    if (distance < 12) return fail('too_close', '目标太近（不到12格），走过去就行')
    // Check the real environment without substituting equipment or changing the
    // inventory. A hypothetical candidate is checked independently below.
    const failure = guidance.environmentFailure(bot, config, -Infinity)
    if (failure) return fail(failure, `飞行环境不满足条件: ${failure}`)
    if (candidateElytra && worn && worn.name !== 'elytra') return fail('torso_occupied', '胸槽已有胸甲，自动交通保留现有装备')
    if (candidateElytra && !unique.includes(candidateElytra)) return fail('candidate_unavailable', '候选鞘翅已不在背包')
    const launchWings = candidateElytra || worn
    if (remaining(launchWings) < config.durabilityReserve + 90) return fail('elytra_missing_or_low_durability', '起飞鞘翅耐久不足或缺少可核验鞘翅')
    if (value.availableDurability < requiredDurability) return fail('durability_insufficient', `鞘翅耐久不够：这趟约需 ${requiredDurability}，现有 ${value.availableDurability}（可带备用鞘翅接力）`)
    if (!bot.entity.onGround) return fail('not_on_ground', '需要从稳定地面起飞')
    if (guidance.speed(bot) > config.stableSpeed) return fail('not_stationary', '起飞前需要停稳')
    if (requiredRockets > config.maxRockets || value.availableRockets < requiredRockets) return fail('rockets_insufficient', `这趟约需 ${requiredRockets} 枚无爆炸、Flight 1的烟花，现有 ${value.availableRockets} 枚`)
    const yaw = guidance.launchYaw(bot, p, guidance.yawTo(p, target), config)
    value.launch = { ok: yaw !== null, code: yaw === null ? 'launch_blocked' : 'ready', yaw }
    if (yaw === null) return fail('launch_blocked', '起飞身体/翼宽走廊未加载或存在障碍')
    return { ...value, ok: true, code: 'ready' }
  }
  async function boost(session, yaw) {
    normal(session)
    if (!bot.entity.elytraFlying || session.rocketsUsed >= config.maxRockets || now() - session.lastBoost < config.boostCooldownMs) return false
    if (guidance.angleDiff(bot.entity.yaw, yaw) > 0.26) return false
    const rocket = guidance.inventoryItems(bot).find(item => guidance.validRocket(item, bot.version))
    if (!rocket) { requestLand('rockets_unavailable'); return false }
    await bot.equip(rocket, 'hand')
    normal(session)
    // Equip is awaited; validate what actually reached the hand, not the old
    // inventory item reference. No unknown NBT fallback or offhand activation.
    if (!guidance.validRocket(bot.heldItem, bot.version)) { requestLand('held_rocket_unverified'); return false }
    if (!bot.entity.elytraFlying || guidance.environmentFailure(bot, config)) { requestLand('flight_changed_before_boost'); return false }
    // 前面没看清（未加载或有障碍）就先不加速，由巡航循环决定绕圈、拉升还是降落
    if (!guidance.scanCorridor(bot, bot.entity.position, yaw, Math.max(0, bot.entity.pitch || 0), config).clear) return false
    const before = guidance.rocketCount(bot)
    let acknowledged = false
    const onUse = () => { if (!destroyed && current === session && !session.disposed) acknowledged = true }
    bot.on('usedFirework', onUse)
    try {
      normal(session)
      session.rocketsUsed++ // Count attempts too: a missing receipt must not allow retries.
      session.lastBoost = now()
      bot.activateItem(false)
      const deadline = now() + config.rocketAckMs
      while (!acknowledged && guidance.rocketCount(bot) >= before && now() < deadline) await wait(session)
      normal(session)
      if (!acknowledged && guidance.rocketCount(bot) >= before) { requestLand('rocket_unconfirmed'); return false }
      return true
    } finally { bot.removeListener('usedFirework', onUse) }
  }
  // 空中换备用鞘翅：等落地再换可能正好落在海里，起不来（实测）。换的时候掉出滑翔就立刻重开
  async function swapElytra(session) {
    normal(session)
    const torso = bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6]
    if (session.protectTorso && torso && torso.name !== 'elytra') { requestLand('torso_changed'); return }
    const spare = guidance.spareElytras(bot).sort((a, b) => (a.durabilityUsed || 0) - (b.durabilityUsed || 0))[0]
    if (!spare || spare.maxDurability - (spare.durabilityUsed || 0) <= guidance.elytraRemaining(bot)) return
    normal(session)
    await bot.equip(spare, 'torso')
    normal(session)
    if (session.protectTorso && bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6]?.name !== 'elytra') {
      requestLand('torso_changed'); return
    }
    ctx.progress?.('换上备用鞘翅')
    if (!bot.entity.elytraFlying && !bot.entity.onGround) await bot.elytraFly()
    normal(session)
  }
  async function takeoff(session) {
    phase(session, 'TAKEOFF')
    normal(session)
    for (const key of ['sprint', 'forward', 'back', 'left', 'right', 'sneak']) bot.setControlState(key, false)
    await look(session, session.launchYaw, 0.45)
    normal(session)
    bot.setControlState('jump', true)
    session.jumping = true
    const deadline = now() + config.takeoffMs
    let leftGround = false
    while (now() < deadline) {
      await wait(session)
      if (!bot.entity.onGround) leftGround = true
      // Vanilla accepts START_FALL_FLYING after leaving the ground and falling.
      if (leftGround && !bot.entity.onGround && bot.entity.velocity.y < 0) break
    }
    normal(session)
    bot.setControlState('jump', false)
    session.jumping = false
    if (!leftGround || bot.entity.onGround || bot.entity.velocity.y >= 0) throw new Error('takeoff_failed')
    await bot.elytraFly()
    normal(session)
    const confirmDeadline = now() + config.confirmMs
    while (!bot.entity.elytraFlying && !bot.entity.onGround && now() < confirmDeadline) await wait(session)
    normal(session)
    if (!bot.entity.elytraFlying || bot.entity.onGround) throw new Error('takeoff_unconfirmed')
    phase(session, 'CLIMB')
    await boost(session, session.launchYaw)
  }
  async function cruise(session) {
    let holdSince = null, lastCeiling = -Infinity, lastProgress = now()
    while (!session.landReason) {
      normal(session)
      if (now() - session.started >= config.maxFlightMs) { requestLand('flight_timeout'); break }
      const p = bot.entity.position
      // 落下来也要时间：离地越高，留的鞘翅耐久越多
      const groundY = session.destination?.y ?? session.fallback?.y ?? session.baseCruiseY - config.climbHeight
      const reserve = config.durabilityReserve + 30 + Math.ceil(Math.max(0, p.y - groundY) / 3)
      if (guidance.elytraRemaining(bot) < reserve + 20) await swapElytra(session)
      const failure = guidance.environmentFailure(bot, config, reserve, true)
      if (failure) { requestLand(failure); break }
      if (bot.entity.onGround || !bot.entity.elytraFlying) { requestLand('flight_lost'); break }
      const scanned = survey(session)
      const distance = guidance.horizontalDistance(p, session.target)
      const altitude = p.y - groundY
      if (now() - lastProgress >= 30_000) {
        lastProgress = now()
        ctx.progress?.(`飞行中：还有约 ${Math.round(distance)} 格，高度 ${Math.round(p.y)}，已用 ${session.rocketsUsed} 枚烟花`)
      }
      const approachDistance = Math.max(24, guidance.horizontalSpeed(bot) * 20 * 1.5 + Math.max(0, altitude) * 1.2)
      // 下滑线被挡（山、墙在落点前面）就别现在降：没烟花可补，半路只能失速掉下去（实测：墙前 19 格落地，再也走不过去）
      const descent = session.destination && distance <= approachDistance
      if (descent && guidance.descentClear(bot, p, session.destination, config)) { requestLand('arrival'); break }
      // 附近全加载了也没有能落的地方（大海、密林）：就地降下去，水面和树冠摔不死，到了再走
      if (!session.destination && session.destinationState === 'none' && distance <= approachDistance + 12) { requestLand('destination_no_site'); break }
      if (now() - lastCeiling >= 500) {
        lastCeiling = now()
        session.cruiseY = Math.max(session.baseCruiseY, guidance.terrainCeiling(bot, p, scanned.yaw) + config.terrainMargin)
      }
      if (session.phase === 'CLIMB' && p.y >= session.cruiseY) phase(session, 'CRUISE')
      const steering = guidance.cruiseGuidance(bot, session.cruiseY, now() - session.lastBoost, session.phase === 'CLIMB')
      let pitch = steering.pitch
      // 下压前先看前面：实测墙顶刚过巡航高度时，这一压正好压进墙里
      if (distance < Math.max(100, altitude * 3) && altitude > 30 && !steering.needsAltitudeBoost && guidance.scanCorridor(bot, p, scanned.yaw, -0.2, config).clear) pitch = -0.2
      const waitingForDestination = !descent && !session.destination && distance <= approachDistance + 12
      let yaw = guidance.turnToward(bot.entity.yaw || 0, waitingForDestination ? (bot.entity.yaw || 0) + config.maxYawStep : scanned.yaw, config.maxYawStep)
      let corridor = guidance.scanCorridor(bot, p, yaw, pitch, config)
      if (!corridor.clear && !corridor.unknown) {
        // 前面有东西：够远就拉起来越过去，太近才降落。巡航高度记下来，别拉完又压回去
        const pull = 0.65
        const pullCorridor = guidance.scanCorridor(bot, p, yaw, pull, config)
        if (corridor.distance < guidance.horizontalSpeed(bot) * 20 + 8 || (!pullCorridor.clear && !pullCorridor.unknown)) {
          ctx.log?.('[flight] corridor', JSON.stringify({ ...corridor, position: guidance.copyPosition(p), yaw, pitch, speed: guidance.horizontalSpeed(bot) }))
          requestLand('corridor_unsafe'); break
        }
        pitch = pull
        session.cruiseY = Math.max(session.cruiseY, p.y + config.terrainMargin)
        corridor = pullCorridor
      }
      // 前方区块还没发过来（新世界生成跟不上鞘翅）：原地绕圈等它，不算障碍；一直不来才降落
      if (!corridor.clear || waitingForDestination) {
        holdSince ??= now()
        if (now() - holdSince >= config.chunkWaitMs) { requestLand('chunks_not_loading'); break }
        yaw = guidance.turnToward(bot.entity.yaw || 0, (bot.entity.yaw || 0) + config.maxYawStep, config.maxYawStep)
      } else holdSince = null
      await look(session, yaw, pitch)
      // 快到了一般不再加速；但下滑线被挡时要靠烟花翻过去（实测：不补就在墙前失速）
      if ((guidance.speed(bot) < 0.8 || steering.needsAltitudeBoost) && now() - session.lastBoost >= config.boostCooldownMs && (distance > approachDistance + 12 || descent)) {
        if (session.rocketsUsed >= config.maxRockets) { requestLand('rocket_budget_exhausted'); break }
        await boost(session, holdSince ? yaw : scanned.yaw)
      }
      if (!session.landReason) await wait(session)
    }
  }
  async function land(session) {
    live(session)
    phase(session, 'LANDING')
    const started = now()
    session.stable = 0
    // The controller releases jump while still in the original task scope.
    // After cancellation root's stop routine clears controls; safety interfaces
    // intentionally cannot perform unrelated movement or inventory operations.
    if (session.jumping) {
      try { ctx.assertActive(); bot.setControlState('jump', false) } catch {}
      session.jumping = false
    }
    let lastGlide = -Infinity
    while (true) {
      live(session)
      if (stableGround(session)) return result(session, true, session.landingTimedOut ? 'landing_timeout' : session.landReason || 'flight_failed')
      if (!session.landingTimedOut && now() - started >= config.maxLandingMs) {
        session.landingTimedOut = true
        phase(session, 'UNCONFIRMED_AIRBORNE')
      }
      if (!session.landingTimedOut && !bot.entity.onGround) {
        // Re-read a candidate rather than trusting a stale preflight snapshot.
        const p = bot.entity.position
        const goal = session.landReason === 'arrival' && session.destination ? session.destination : session.fallback
        const target = goal && guidance.landingSite(bot, goal, guidance.yawTo(p, goal), config)
        const nearby = guidance.landingSite(bot, p, bot.entity.yaw || 0, config)
        let site = target || nearby
        if (!site && now() - session.lastSiteSearch >= 1000) {
          session.lastSiteSearch = now()
          session.landingCandidate = guidance.findLandingNear(bot, p, bot.entity.yaw || 0, config, 32).site
        }
        site ||= session.landingCandidate && guidance.landingSite(bot, session.landingCandidate, guidance.yawTo(p, session.landingCandidate), config)
        if (!site) {
          const rough = guidance.roughLanding(bot, session.target, config)
          const ahead = guidance.scanCorridor(bot, p, rough.yaw, rough.pitch, config, Math.max(12, guidance.horizontalSpeed(bot) * 30))
          // 前面挡着就当场拉起：宁可失速落在树上，也别带速撞上去
          await look(session, ahead.clear ? rough.yaw : (bot.entity.yaw || 0) + config.maxYawStep, ahead.clear ? rough.pitch : 0.7, true)
        } else {
          const steering = guidance.landingGuidance(bot, site, config)
          // Looking along an obstructed trajectory would turn a safe fallback
          // into a collision. Braking pitch retains the current heading instead.
          const landingScan = Math.max(6, guidance.horizontalSpeed(bot) * 20 + 4)
          if (guidance.scanCorridor(bot, p, steering.yaw, steering.pitch, config, landingScan, site.y).clear) {
            await look(session, steering.yaw, steering.pitch, true)
          } else if (guidance.scanCorridor(bot, p, bot.entity.yaw || 0, 0.40, config, landingScan, site.y).clear) {
            await look(session, bot.entity.yaw || 0, 0.40, true)
          } else await look(session, (bot.entity.yaw || 0) + config.maxYawStep, 0.7, true) // 两条路都挡着：边拉起边转开，别带着烟花的速度撞上去（实测掉 12 血）
        }
        if (!bot.entity.elytraFlying && now() - lastGlide >= 1000 && guidance.elytraRemaining(bot) > 1 && !bot.entity.isInWater && !bot.entity.isInLava) {
          live(session)
          lastGlide = now()
          try { await ctx.safetyGlide(); live(session) } catch (error) { if (error instanceof DisposedFlight) throw error }
        }
      }
      await wait(session, true)
    }
  }
  async function fly(target, { protectTorso = false } = {}) {
    if (destroyed) throw new Error('飞行模块已销毁，请等待重生或重连')
    if (current) throw new Error('仍在飞行或等待确认落地')
    const session = { id: ++serial, target: { x: target?.x, y: target?.y, z: target?.z },
      started: now(), phase: 'PREFLIGHT', landReason: null, rocketsUsed: 0, lastBoost: -Infinity,
      fallback: null, destination: null, destinationState: 'unknown', stable: 0, disposed: false, landingTimedOut: false,
      freeY: false, protectTorso: protectTorso === true, lastDestinationSearch: -Infinity, lastSiteSearch: -Infinity, landingCandidate: null }
    session.disposedPromise = new Promise(resolve => { session.wake = resolve })
    current = session
    let launched = false
    try {
      preflight(session)
      launched = true // Every await from here must finish through the landing path.
      try {
        await takeoff(session)
        if (!session.landReason) await cruise(session)
      } catch (error) {
        live(session)
        requestLand(error instanceof LandingRequested ? session.landReason : error.name === 'CancelledError' ? 'cancelled' : String(error.message || 'flight_failed'))
      }
      return await land(session)
    } catch (error) {
      if (destroyed || session.disposed || error instanceof DisposedFlight) return result(session, false, session.landReason || 'disposed')
      if (!launched) throw error
      // A safety helper can fail (disconnect, guard, etc.). Keep ownership and
      // observe passively; never free the task lock while still airborne.
      session.landReason ||= String(error.message || 'landing_failed')
      session.landingTimedOut = true
      phase(session, 'UNCONFIRMED_AIRBORNE')
      while (true) {
        try {
          live(session)
          if (stableGround(session)) return result(session, true, session.landReason)
          try { await wait(session, true) } catch (delayError) {
            if (destroyed || session.disposed || delayError instanceof DisposedFlight) throw delayError
            // A faulty injected delay must not release ownership in midair.
            // This fallback only waits; it grants no cancelled bot capability.
            await new Promise(resolve => setTimeout(resolve, config.tickMs))
          }
        } catch (failure) {
          if (destroyed || session.disposed || failure instanceof DisposedFlight) return result(session, false, session.landReason || 'disposed')
          throw failure
        }
      }
    } finally {
      if (current === session) {
        lastStatus = { ...status(), phase: launched ? 'IDLE' : 'FAILED', active: false }
        current = null
      }
      session.wake = null
    }
  }
  // 脚下不能起飞（林子、坡、屋里）时，找一块近处能起飞的平地，走过去再飞
  function launchSite(target, radius = 40) {
    const p = bot.entity.position
    const yaw = guidance.yawTo(p, target)
    const open = (site) => guidance.openLaunch(bot, site, guidance.yawTo(site, target), config)
    if (bot.entity.onGround && !bot.entity.isInWater && open(p)) return { here: true }
    return { site: guidance.findLandingNear(bot, p, yaw, config, radius, open).site }
  }
  return { fly, assess, requestLand, active: () => !!current, status, dispose, launchSite }
}

module.exports = { createFlight }
