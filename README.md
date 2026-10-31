# QQ 群聊 DeepSeek 机器人 · v0.12.0 试运行

使用 QQ 官方机器人接口，把 DeepSeek 接入群聊和独立私聊。Windows 本地优先采用 WebSocket 长连接，无需公网回调。这个版本是首个公开试运行源码，已经过本地测试，仍需在自己的 QQ 权限、网络和使用场景下验证，尚不作为生产稳定版承诺。

支持群聊 @ 回复、C2C 私聊、识图、静态表情、公开资料搜索、群内身份区分、长期问答记忆，以及可选的群聊旁听和冷群发言。运行环境为 Node.js 22.9+，建议 Node.js 24；仅使用 Node 内置模块，没有第三方运行依赖。

## 1. 先试离线演示

在项目目录打开 PowerShell：

```powershell
node --version
npm.cmd ci --ignore-scripts --offline
npm.cmd test
npm.cmd run demo
```

保持窗口运行，在另一个 PowerShell 中进入同一目录，再运行：

```powershell
npm.cmd run simulate
```

演示使用模拟 AI 和模拟 QQ，验证本机签名事件、权限与回复流程，不需要密钥，不访问 QQ/DeepSeek，不扣 API 额度。按 `Ctrl+C` 停止。Windows 使用 `npm.cmd` 可避开 `npm.ps1` 执行策略问题。

## 2. 准备官方 QQ 机器人与配置

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，检查服务范围，把机器人加入获准的测试群。普通 QQ 群号不能直接接入；个人 QQ 账号也不会变成机器人。
2. 在事件接入方式中选择 **WebSocket**。群聊使用 `GROUP_AT_MESSAGE_CREATE`；启用旁听或冷群功能时，还需全量 `GROUP_MESSAGE_CREATE` 并在 QQ 里开启“接收所有消息”。私聊需 `C2C_MESSAGE_CREATE` 及对应私聊服务范围。
3. 在 [DeepSeek 控制台](https://platform.deepseek.com/) 创建自己的 API Key，在本机编辑器中填写以下配置。不要把密码、密钥或完整请求头发到聊天、截图、Issue 或提交记录中。

```powershell
Copy-Item .env.example .env
notepad .env
```

只在第一次创建 `.env` 时复制；已有文件请直接编辑，避免覆盖。

| 必填变量 | 内容 |
| --- | --- |
| `QQ_APP_ID` | QQ 机器人的 AppID |
| `QQ_APP_SECRET` | QQ 机器人的 AppSecret |
| `DEEPSEEK_API_KEY` | 自己的 DeepSeek API Key |
| `ALLOWED_GROUP_IDS` | 获准群的 `group_openid`，多项用英文逗号分隔 |

保持 `QQ_TRANSPORT=websocket`。首次不知道群 OpenID 时，可暂留空群白名单，启动后在测试群真正 @ 机器人发送 `/ping`，从本机 `group_denied` 日志取得群标识，填入后重启。空白名单默认拒绝所有群，普通群号不能代替 OpenID。`ALLOWED_USER_IDS` 可进一步限制群成员；`ALLOW_ALL_GROUPS` 默认关闭。

QQ 服务范围、测试名单及主动发言权限取决于平台与群设置，代码无法绕过限制。全量接收模式下，程序也会识别 `GROUP_MESSAGE_CREATE` 中真正 @ 本机器人的消息，普通文字“@大肥鱼”不等于平台提及。[官方接入指南](https://bot.q.qq.com/wiki/) · [群消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)

## 3. 选择功能并启动

`.env.example` 是安全起点，私聊、群聊旁听、语气学习、联网搜索、热梗更新和冷群发言等多项功能默认关闭；复制文件不代表已启用全部能力。按需要修改：

| 功能 | 配置 |
| --- | --- |
| 群里正常对话只回应 @，关闭开机招呼 | `GROUP_AT_ONLY=true`，`STARTUP_GREETING_ENABLED=false` |
| 私聊 | `DM_ENABLED=true`，并填写 `ALLOWED_DM_USER_IDS`；或明确设置 `DM_ALLOW_ALL_USERS=true` |
| 成员称呼与群身份档案 | `COMMUNITY_ENABLED=true` |
| 学习群内语气 / 有限旁听 | `STYLE_ENABLED=true` / `GROUP_CHAT_ENABLED=true` |
| 公开资料搜索 / 定期热梗整理 | `WEB_SEARCH_ENABLED=true` / `TRENDS_ENABLED=true` |
| 五小时冷群例外 | `IDLE_CHAT_ENABLED=true`，`IDLE_FORCE_AFTER_HOURS=5` |

私聊名单使用 `user_openid`，不能用群成员 OpenID 代替；未允许所有用户且名单为空时拒绝私聊。平台服务范围仍然生效。配置修改后需重启；系统环境变量优先于 `.env`。

```powershell
npm.cmd run check-config
npm.cmd start
```

`check-config` 检查配置格式，不验证余额或实际权限。先发送 `@机器人 /ping`，收到 `pong` 后再问一个普通问题，分别确认消息链路和模型调用。

日常 Windows 操作可双击项目目录中的文件：

| 文件 | 操作 |
| --- | --- |
| `启动大肥鱼.cmd` | 在后台启动，检测重复运行 |
| `关闭大肥鱼.cmd` | 请求正常停止并保存状态 |
| `查看大肥鱼状态.cmd` | 检查本地服务与连接状态 |
| `开启开机自启.cmd` | 添加当前 Windows 用户登录后的启动项 |
| `取消开机自启.cmd` | 移除该启动项 |

后台启动后可关闭启动窗口。电脑关机、休眠、断网时机器人不可用；开机自启需要先登录 Windows，并不提供全天云托管。不要同时运行后台启动器和另一个 `npm.cmd start` 进程。

## 4. 记忆、身份和群聊旁听

同群 @ 问答默认共享长期记忆，较早内容自动压成摘要，重启后可恢复；不同群与独立私聊隔离。摘要有损，不能保证永久保留每个细节。压缩会增加少量模型调用，正常回答也会携带选中的历史。

成员使用持久化匿名标签区分，群主与管理员角色以 QQ 事件为准，不根据昵称或自称授予权限。可用“设置称呼”保存常用名；要配置自己的社团背景，可使用 `scripts/configure-community.js`，其输入为含 `school`、`club`、`groupDescription`、`ownerBackground` 的本机 JSON 文件。

旁听仅在 `GROUP_CHAT_ENABLED=true` 时记录在线期间新收到的普通群文字，默认每群最多 **120 条、3 万字、7 天**，每条最多 400 字。它不会拉取离线前或加入前的 QQ 历史，也不会读取普通消息里的图片、语音或文件。启用前请让群友了解记录用途。

普通消息只做本地记录、身份和语气统计，不因此调用模型、摘要或搜索。被 @ 后，最多选取 12 条近期相关资料与 3 条短例句，总预算 2200 字，随当次回答提供；这是参考与模仿，不是重新训练模型。定期热梗整理另按其开关与限额运行。

`PRIVATE_NAMES` 可在本机指定不希望复述的姓名，逗号分隔；`OWNER_DISPLAY_NAME` 指定替代称呼。程序在模型文字请求、摘要和外发文字中替换这些指定姓名，保留其他群友的身份区分。它不是对所有人的全面匿名化，也不识别图片里的字或保证拦截所有同音、拆字变体；旧磁盘资料不会因此自动删除。

## 5. 五小时冷群发言

同时启用 `IDLE_CHAT_ENABLED=true` 与 `IDLE_FORCE_AFTER_HOURS=5` 后，连续完整在线观察 **5 小时无人发言**，会在下一次每分钟检查时尝试发一条；同一连续冷场只发一次，真人新消息会重新计时。这是只 @ 回复规则的明确例外，开机招呼仍关闭。

此模式全天生效，不抽概率，不受旧随机模式的时段、日额度与冷却限制。它仍要求 QQ 允许主动发言、确认完整接收群消息；管理员暂停、发送失败或存储损坏会阻止发送。READY/RESUMED 后只读核对群权限，断线、休眠、重启或时钟异常后重新观察，不把未知离线时段算成群冷。

`IDLE_FORCE_AFTER_HOURS=0` 保留旧随机模式；在 `GROUP_AT_ONLY=true` 下，旧随机模式与开机招呼均被禁止。冷群功能只作用于显式群白名单，不随 `ALLOW_ALL_GROUPS` 扩散。

话题包含校园日常、B 站、科技生活和二次元。若另开 `IDLE_NEWS_ENABLED=true` 与 `WEB_SEARCH_ENABLED=true`，公共近况检索所有群共享，每 12 小时最多一次；没有合适来源就退回本地闲聊，不编造新闻。联网等待期间有人发言会取消当次发送。五小时自然冷场尚未完成实群等待验证，详情见 [试运行说明](RELEASE_NOTES.md)。

## 6. 主要用法

群聊命令均需从 QQ 的 @ 列表选中机器人，后接以下内容；私聊无需 @。部分命令需先开启对应功能。

| 消息内容 | 作用 |
| --- | --- |
| `/ping`、`/help` | 在线检查、查看用法 |
| 普通问题；问题与图片同一条发送 | 聊天、识图；识图默认每次最多 3 张、每张 4 MB |
| `记忆状态`、`清空记忆` | 查看或清空当前会话；共享模式下清空本群 @ 问答记忆 |
| `设置称呼 名字`、`我是谁` | 保存常用称呼、查看当前群身份 |
| `群聊记录状态`、`清空群聊记录` | 查看旁听范围；清空限群主/管理员，不删除 @ 问答记忆 |
| `语气状态`、`重置语气` | 查看或清空统计；群内重置限群主/管理员 |
| `表情列表`、`表情 名称`、`表情来源` | 查看、调用本群静态表情与登记来源；名称留空随机选 |
| `存表情 名称` ＋同一条 PNG/JPG | 群主/管理员保存表情；私聊保存到自己的独立库 |
| `搜图 关键词`、`发图 HTTPS图片直链` | 搜索或发送公开图片，网页地址不能代替图片直链 |
| `媒体自检` | 检查 emoji 和当前库中的图片是否能显示 |
| `查资料 公开问题` | 查询公开资料并附实际来源；搜索接口另计费 |
| `热梗列表`、`热梗状态`、`更新热梗` | 查看或按统一限额更新词库，默认每 6 小时最多一次 |
| `冷群聊天 状态／开／关` | 查看规则；开关限群主/管理员，私聊不能控制群 |

表情发送支持静态 PNG/JPG；轻松回答可偶尔从当前聊天的库中选一张，也可不配图。公开源码**不附实际表情图片**，新克隆的表情库为空，需要自己保存素材。试运行机器上曾单独导入的 8 张 [Anki-tan emoji](https://shigeyukey.github.io/shige-addons-wiki/Anki-tan.html) 不会自动下载；作者 Shigeyuki 以 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 提供，使用时保留署名与许可。其他搜图结果须自行确认来源及使用范围。

## 7. 状态、数据与部署范围

```powershell
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

`ok=true` 只说明本地 HTTP 服务在运行；还应检查 `gateway.state=ready`，并实际测试 `/ping` 与模型问答。`mode=mock` 是演示，`mode=live` 才是真实接入。日志位于 `logs/`，记录连接、错误码及耗时，默认不记录聊天正文或密钥；首次授权群的拒绝日志会包含群 OpenID，不要原样公开。

`.env`、`data/`、`logs/` 均不进入公开包。记忆、身份随机盐、群聊旁听和表情保存在本机 `data/`；备份和迁移应先停服务，再妥善保存配置与完整数据目录，避免多个进程共写。API、搜索与摘要按实际调用计费，限流不等于费用硬上限。

旧 Webhook 模式仍可设置 `QQ_TRANSPORT=webhook`，将自己控制的 HTTPS 入口转到 `POST /qq/webhook`，保留原始正文和签名头，按 [QQ 官方 Webhook 文档](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html) 配置并验证。WebSocket 模式不使用该回调。Linux 服务与反向代理模板见 [deploy/README.md](deploy/README.md)，尚未在云端或 Linux 实机部署验证。

公开源码不依赖 OneBot。第三方个人 QQ 协议方案另有封号、协议失效和凭证暴露风险，不属于本项目已验证的官方接入路径。更多模型配置见 [DeepSeek 官方文档](https://api-docs.deepseek.com/)。

测试与尚未完成的验证边界见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。
