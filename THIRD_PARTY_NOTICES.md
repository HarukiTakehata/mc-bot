# Third-party notices

## EAFE (Elytra Autonomous Flight Engine)

`flight.js` and `flight-guidance.js` adapt parts of EAFE by **eksses
<shamirbhuiyan2@gmail.com>**, from commit
`33497801cee99f5e1129ae6b2f210738657c850a` (package version 11.0.4).
The pinned [`package.json`](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/package.json)
declares the license as MIT. That revision does not supply a separate LICENSE
file; the author attribution above is retained, without inventing an upstream
copyright year or claiming a supplied license text.

Adapted functions, constants and control flow:

- [`src/utils.js`](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/utils.js):
  `angleDiff` is adapted into `signedAngle`, `angleDiff` and `turnToward`.
  The `isAir` / `isSafeSolidBlock` concepts inform `isAir` / `safeGround`, with
  deliberately different unknown-block and full-solid vanilla allowlist rules.
- [`src/flight/phases.js`](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/flight/phases.js):
  `executeTakeoff`, `startClimb`, `startCruise` inform this module's
  `takeoff` / `cruise` flow: preflight → jump → native gliding → climb → cruise
  → landing; climb pitches `0.45` / `0.65`, post-boost pitch `0.15`, cruise
  pitch `-0.04`, and approach pitch `-0.12` are adapted.
- [`src/core/rockets.js`](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/core/rockets.js):
  `fireRocketDirect` / `smartFireRocket` inform `boost`: confirmed flight,
  angular alignment gate `0.26` radians, cooldown (default `3000` ms), and
  a low-speed boost gate. Hand equip is awaited and actual 26.1 fireworks
  components and server/inventory acknowledgement are checked before reuse.
- [`src/flight/landing.js`](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/flight/landing.js):
  `startLanding` informs `landingGuidance` and `land`: no-rocket descent,
  altitude-sensitive pitches `-0.15`, `-0.08`, `-0.03`, low-altitude upward
  braking pitch `0.40`, native glide recovery, and final ground verification.
  Its small-radius spiral is replaced with bounded native turning.

This is a focused adaptation, not installation or vendoring of the EAFE plugin.
Its interval scheduler, state getter, automatic equipment changes, retry/wander
machinery, null-as-air behavior, and unconfirmed launch boosts are not used.
Cancellation, session ownership, landing time limits/passive observation,
26.1 component validation, inventory acknowledgements, conservative terrain
checks, and integration tests are local implementations. The controller never
assigns entity position/velocity or disables Mineflayer physics.

`cruiseGuidance` adds local continuous altitude/vertical-speed feedback around
the EAFE pitch baseline. An altitude deficit can request a native recovery
rocket even at high horizontal speed, subject to the same cooldown, budget,
alignment, equip, acknowledgement and collision checks. `landingSurvey` adds
local safe/unknown/unsafe runway classification: a loaded center cell alone
does not verify the complete runway. Unknown distant runways remain unverified;
unknown runways at approach distance require fallback landing.

### Local 26.1 default-component compatibility

The local compatibility code in `validRocket(item, version)` accounts for a Slot
component patch omitting values equal to the native item defaults. The installed
`prismarine-item` 1.18.0 `index.js`, `Item.fromNotch` (lines 149–164), copies
`networkItem.components` and `networkItem.removeComponents` and builds its map
only from the supplied overrides. The installed `minecraft-data` 26.1
`protocol.json`, types `Slot`, `SlotComponentType` and `SlotComponent`, represents
added and removed components separately; the fireworks component maps to type 69
and a removal has shape `{ type: 'fireworks' }`.

An empty, structurally valid patch is interpreted as the verified vanilla
Flight 1/no-explosion default only for exact versions `26.1` and `26.1.2`.
Explicit fireworks overrides must still contain `flightDuration: 1` and an
empty `explosions` array. Removed fireworks, missing patch structure, duplicate
or inconsistent overrides, legacy-NBT-only representations and unknown versions
are rejected. Version context is used for inventory counting, item selection
and the final held-item check. This compatibility logic is local, not EAFE code.

The coordinator verified the default against an independent local Fabric 26.1.2
server on 2026-10-30 using the same unmodified stack. `data get entity FlyLabBot
Inventory` reported a 32-count `minecraft:firework_rocket` stack without an
explicit components field. The native predicate `execute if items entity
FlyLabBot hotbar.* minecraft:firework_rocket[minecraft:fireworks={flight_duration:1,explosions:[]}]`
passed with count 32; the corresponding predicate with `flight_duration:3`
failed. Mineflayer represented that same stack as `components: []`, an empty
`componentMap`, `removedComponents: []`, and `nbt: null`. This server result,
together with the local Slot and `fromNotch` definitions, is the evidence for
the narrowly versioned fallback above.

## Compared but not incorporated

The flight implementations below were examined for compatibility. Their direct
velocity control was not incorporated; no code is copied from them:

- [amoraschi/mineflayer-elytrafly](https://github.com/amoraschi/mineflayer-elytrafly),
  `src/ElytraFly.ts`.
- [AhanafSharier/Mineflayer-McEfly](https://github.com/AhanafSharier/Mineflayer-McEfly),
  `index.js`.

## 1.4.0 参考说明

build.js、blueprint.js、parkour.js、redstone.js 为本项目编写，未复制上游源码；设计参考及许可见 UPSTREAM_REFERENCES.md。运行时使用已随 Mineflayer 安装的 prismarine-physics、prismarine-nbt、vec3（MIT）。
