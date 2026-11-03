# 隔离测试脚本

这些脚本面向可丢弃的本机 Minecraft 测试世界，会修改方块、实体、背包、游戏规则和加载区块。请先自行创建隔离测试容器，并将游戏端口发布到 `127.0.0.1`；容器内需要可用的 `rcon-cli`。机器人和 RCON 必须指向同一个测试世界。

所有游戏测试都要求显式设置 `LAB_CONTAINER`。未设置或格式无效时会在启动客户端、调用 Docker 和写入证据之前报错。客户端地址固定为 `127.0.0.1`；配置中的容器名是操作者选择的测试目标，脚本不能自动判断世界是否可丢弃。

| 变量 | 说明 |
| --- | --- |
| `LAB_CONTAINER` | 必填，本机隔离测试容器的名称或 ID，无默认值 |
| `LAB_PORT` | 容器映射到本机的游戏端口，默认 `25577`，范围 `1`–`65535` |
| `LAB_VERSION` | Mineflayer 使用的游戏版本，默认 `26.1`；场景命令也必须与测试服版本兼容 |
| `LAB_RCON_CONFIG` | 可选，容器内的 `rcon-cli` 配置文件路径；不设时使用该命令自身的默认配置 |
| `LAB_EVIDENCE` | 证据根目录，默认仓库内 `logs/lab` |
| `LAB_OUT` | 兼容证据目录配置；自动交通脚本将它直接用作输出目录 |
| `FLIGHT_TEST_OUTPUT` | 飞行与陪伴 live 脚本的输出目录覆盖项 |
| `LAB_RAW` | 非空时，harness 结果附带较长的原始日志片段 |

PowerShell 示例（容器名仅为示例，需替换为已创建的测试容器）：

```powershell
$env:LAB_CONTAINER = 'mc-bot-test'
$env:LAB_PORT = '25577'
node scripts/lab/existing-features.js
node scripts/test-flight-live.js arrival
```

POSIX shell 示例：

```sh
LAB_CONTAINER=mc-bot-test LAB_PORT=25577 node scripts/lab/new-capabilities.js
```

`existing-features.js`、`new-capabilities.js`、`complex.js`、`ai-flow.js`、`real-gear.js` 和 `flight-long.js` 可在末尾添加场景名片段来筛选用例。竞技场由脚本自行搭建，坐标仅用于分隔测试区域。自然地形的生存链与长途场景使用任意测试世界采样点，仍需测试世界包含相应陆地、树木或矿物；结果会受地形影响。部分场景测试共享背包/血量或模组方块，需要安装对应测试模组。这里没有绑定特定部署的世界、种子或出生点。

`test-flight-live.js` 支持 `arrival`、`stop`、`reject`、`roundtrip`；`test-auto-travel-live.js` 支持 `--case=near` 等用例筛选，默认使用固定 AI 回放；`test-companion-live.js` 验证两个测试客户端的跟随和聊天行为。三者使用空世界；飞行与自动交通脚本会搭建跑道，陪伴脚本要求起点附近有可行走的地面。harness 与陪伴脚本从仓库目录启动机器人，会写入本地运行数据，因此应从单独的测试工作副本运行。自动交通脚本会自行创建代码副本并隔离运行数据。

`fake-deepseek.js` 和 `auto-travel-ai.js` 是测试入口加载的 AI 回放辅助模块。`intent-eval.js` 不连接游戏，使用合成玩家消息和场景，但会调用真实模型；它需要 `DEEPSEEK_API_KEY`，不需要 `LAB_CONTAINER`。自动交通入口只有显式添加 `--real-ai` 才调用真实模型，并从仓库 `.env` 读取密钥。真实模型评测可能产生 API 费用。

仅检查语法可运行 `node --check <脚本路径>`；验证配置可导入 `config.js` 的 `loadLabConfig(env)`，该函数本身不会连接游戏、执行 Docker 或写入文件。
