# 上游比较与本轮采用范围

先比较现有功能和源码，再做项目适配；README 声明不视为特定版本或服务器环境的实测证据。

| 项目与固定源码 | 本轮采用 | 未迁入及理由 |
|---|---|---|
| [EAFE 11.0.4 / phases](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/flight/phases.js)、[rockets](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/core/rockets.js)、[landing](https://github.com/eksses/EAFE/blob/33497801cee99f5e1129ae6b2f210738657c850a/src/flight/landing.js) | 原生鞘翅分阶段、姿态/角度、烟花冷却与速度门、无烟花降落思路；具体函数见NOTICE | 不整体安装：其状态getter、分散interval/retry、未知方块当空气、异步装备后直接发射不符合本项目取消/共享资源边界。适配为单一受控循环，并补巡航高度反馈与跑道三态校验。 |
| [mineflayer-elytrafly / ElytraFly.ts blob](https://api.github.com/repos/amoraschi/mineflayer-elytrafly/git/blobs/fb027d703fa2c9f8a6df48dd8da93998360dfc44) | 比较API与停止设计 | 直接改实体velocity，不用于原生生存赶路，没有复制代码。 |
| [Mineflayer-McEfly / index.js blob](https://api.github.com/repos/AhanafSharier/Mineflayer-McEfly/git/blobs/d2bbf3980709d24a18c66aea6defeb7590423b2d) | 比较起飞、地形检查、降落与耗材状态 | 多处直接改velocity，不安装或复制控制代码。 |
| [Mindcraft modes](https://github.com/mindcraft-bots/mindcraft/blob/e1c1fc3ffa481506c2445fc639e16dba504b5920/src/agent/modes.js)、[world](https://github.com/mindcraft-bots/mindcraft/blob/e1c1fc3ffa481506c2445fc639e16dba504b5920/src/agent/library/world.js) | 捡物前等待/可达性/失败冷却、可选elbow_room让位的行为条件；保留现有modes架构 | 不默认迁入自动放火把/猎食。它们会消耗共享资源，且上游火把判定不是真实亮度保证。 |
| [Mindcraft CE package](https://github.com/mindcraft-ce/mindcraft-ce/blob/8217d7bf496c1d9ad096ea0f029fe329ba1701b4/package.json)、[settings](https://github.com/mindcraft-ce/mindcraft-ce/blob/8217d7bf496c1d9ad096ea0f029fe329ba1701b4/settings.js) | 同代Mineflayer/Pathfinder/CollectBlock可比较；保留固定动作和默认禁用不安全代码的边界 | modes文本与上述Mindcraft相同，不重复算能力；不复制无限命令/超时参数，不迁入动态写代码执行。上游README版本声明不能替代26.1适配验证。 |
| [Mineflayer StateMachine FollowEntity](https://github.com/PrismarineJS/mineflayer-statemachine/blob/30193e6d7fec2754a3de72876abeeaf6931cd23d/src/behaviors/behaviorFollowEntity.ts) | 跟随实体对象替换后重新绑定GoalFollow，保留本项目唯一任务/寻路链 | 不安装第二套状态机或调度器；只借生命周期条件，没有直接复制TS实现。 |
| [Voyager status](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/env/mineflayer/lib/observation/status.js)、[critic](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/agents/critic.py) | 装备/健康/氧气/容量观察，动作后读回的验收思路；新scan/advice使用本地规则 | 不迁入动态技能代码、自动课程或额外LLM critic，不将库存变化一概归因本bot。 |
| [AltoClef Follow](https://github.com/gaucho-matrero/altoclef/blob/af22e3bc2f03dde45da703f5f7535baae18ea486/src/main/java/adris/altoclef/tasks/movement/FollowPlayerTask.java)、[progress checker](https://github.com/gaucho-matrero/altoclef/blob/af22e3bc2f03dde45da703f5f7535baae18ea486/src/main/java/adris/altoclef/util/progresscheck/ProgressCheckerRetry.java) | 目标丢失后的限时恢复、暂停与进展分开、有界重试的设计 | Java客户端代码与本项目接口不同，只借概念，不复制源码；不盲走向已卸载位置。 |
| [Baritone FollowProcess](https://github.com/cabaletta/baritone/blob/c55a9c5d9a333c9f0336179a96c13a178fcbc2d4/src/main/java/baritone/process/FollowProcess.java) | 跟随距离与每次更新重验证目标的思路，手动跟随距离2–8格 | 不迁移Java客户端/路径引擎，不引入竞争寻路，跟随偏移后置。 |

## 第二批（1.3.0）借鉴

| 项目 | 采用 | 未采用及理由 |
|---|---|---|
| [AltoClef](https://github.com/gaucho-matrero/altoclef) `@get` | 物品获取规划（挖/烧/合成递归、缺工具先做工具），在 planner.js 用虚拟背包推演、回溯配方 | 不迁 Java 任务链；不做 `give`、不拆非天然方块 |
| [Baritone](https://github.com/cabaletta/baritone) farm / tunnel / explore | 收割补种、1x2 隧道、探索的行为定义 | 不引入第二套寻路；隧道遇液体/悬空直接停 |
| [Mindcraft](https://github.com/mindcraft-bots/mindcraft) actions / modes | digDown 的停止条件、placeHere、useOn（剪毛/挤奶/喂食）、self_preservation 的掉落方块躲避 | 不默认开 torch_placing/hunting（消耗共享资源）；searchWiki 因中文 wiki 有反机器人验证不接入 |
| [Voyager](https://github.com/MineDojo/Voyager) exploreUntil / critic | 探索直到看见目标；动作后背包变化反馈、check 本地核对 | 不迁动态代码生成 |
| [Odyssey](https://github.com/zju-vipa/Odyssey) 技能库 | 钓鱼、畜牧等组合技能清单 | 不迁 LLaMA 规划器 |
| mineflayer examples guard / farmer | 保护玩家、作物成熟判定 | — |

## 第三批（1.4.0）借鉴：建筑、红石、跑酷

| 项目 | 采用 | 未采用及理由 |
|---|---|---|
| [mineflayer-builder](https://github.com/PrismarineJS/mineflayer-builder)（MIT）、[mineflayer-schem](https://unpkg.com/mineflayer-schem@1.5.2/README.md)（MIT） | 按朝向/点击面放方块的思路、失败重试、进度汇报、`.schem` 输入 | 未安装：前者标注开发中；后者未在 26.1 验证，且自动拿箱子物品会消耗玩家资源。朝向表区分观察者与活塞的相反方向 |
| [Azalea parkour](https://docs.rs/crate/azalea/latest/source/src/pathfinder/moves/parkour.rs) | 1~3 格沟与上下跳的移动表、净空检查、滞空调整思路，在 parkour.js 重写 | Rust 实现不可直接用；没有复制代码 |
| [mineflayer-pathfinder physics](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/physics.js)（MIT） | 用 prismarine-physics 预演起跳 | 自带跑酷移动不查沟下危险，已加过滤；不替换寻路 |
| [@nxg-org/mineflayer-pathfinder](https://npmjs.com/package/@nxg-org/mineflayer-pathfinder) | 比较 | 作者标注开发中且不建议生产使用，未安装 |
| 红石 | 未找到成熟的 mineflayer 红石项目；按原版机制自行实现，所有电路在实验服上功能自检 | — |

## 本机兼容补丁和验证边界

本机 Mineflayer 4.39.0 原生 `elytraFly()` 在26.1上发出旧动作编号8，实际26.1协议表使用 `start_fall_flying`（编号6）。`protocol-compat.js`只对已核对的26.1/26.1.2启用字符串动作能力并适配旧名字；也使原生疾跑发出正确字符串动作。不修改node_modules或全局minecraft-data。测试调用实际安装的physics插件复现旧输出并验证新输出。

26.1物品网络数据是组件补丁，Prismarine Item只把覆盖项放入componentMap。原版Flight1无爆炸烟花可以是完整空补丁；独立服务端的条件命令确认默认值，未知版本、移除和畸形覆盖仍拒绝。真实数据与控制回归分别保留；替身测试不证明飞行动力学。

飞行的最后一段精确对接复用已经安装的Mineflayer Pathfinder：只在因到达而正常落地、距目标不超过32格且高度相近时执行，使用禁挖掘/禁搭方块的安全移动。停止、备用降落或未确认着地不启动这一段。所有外部项目代码都经过本地接口/权限/生命周期检查，没有替换现有Fabric兼容层。
