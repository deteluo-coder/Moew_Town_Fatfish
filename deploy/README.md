# 以后迁移到全天在线的设备

当前继续在 Windows 本地使用，不需要购买服务器或操作本目录。

全天运行的关键是有人持续运行这个程序，而不是 QQ 或 DeepSeek 的开关。可以使用云服务器，或一直开机联网的家用电脑/NAS。程序调用远程模型，不需要显卡；对一个低流量群，可先评估 2 核、2 GB 内存的 Linux 小服务器，后续按实际用量调整。服务器、域名与 API 用量分别计费，不承诺零费用或绝不掉线。

附带 Linux 的 `qq-deepseek-bot.service` 和 `Caddyfile.example`，用于管理员手动部署。模板需要根据服务器路径和域名调整；本机没有 systemd/Caddy 环境，未作云端实机验证。

1. 准备持续在线的 Linux 设备与固定 HTTPS 入口，安装 Node.js 24 与 Caddy；若使用其他反向代理，也应保留请求原始字节和签名头。域名与公网端口需满足平台和服务商的要求。
2. 上传源码到 `/opt/qq-deepseek-bot`，在服务器本地安全填写 `.env`，不将密钥提交 GitHub。服务监听 `127.0.0.1:3000`，只将 HTTPS 回调暴露到公网。
3. 创建服务专用用户 `qqbot`。源码只读，`data/` 及其中的文件需由 `qqbot` 可读写，`.env` 仅向服务用户开放读取。模板假设 Node 位于 `/usr/bin/node`；用 `command -v node` 核对后调整。
4. 迁移前暂停 Windows 机器人，等待正在处理的任务结束，再安全复制完整 `data/`（包括记忆随机盐与表情包）。不要将带有真实群记录的 `data/` 放入公开仓库或公开下载包。迁移后保持同一 AppID 和 `CONTEXT_SCOPE`。
5. 将服务文件安装到 `/etc/systemd/system/qq-deepseek-bot.service`，以管理员身份执行 `systemctl daemon-reload`、`systemctl enable --now qq-deepseek-bot`，用 `systemctl status qq-deepseek-bot` 和 `journalctl -u qq-deepseek-bot` 检查。配置会开机启动，并在异常退出后重启。
6. 将 Caddy 模板域名替换为自己的域名。DNS 指向设备，开放所需端口并启用 HTTPS 后，将 QQ 回调修改为 `https://你的域名/qq/webhook`，继续订阅 `GROUP_AT_MESSAGE_CREATE`。如设置了 QQ 出口 IP 白名单，应更新为新设备出口 IP。
7. 群内依次检查 `/ping`、普通提问、识图和记忆恢复，确认正常后再停止旧隧道。不要让两台设备同时处理同一机器人，或多个进程共同写一个记忆目录。

不要只依赖服务器单盘；定期安全备份完整 `data/` 与配置。服务自动重启不能补回已 ACK 但尚未完成的任务。异常时仍可能短时不可用。

参考：[QQ 官方接入说明](https://bot.q.qq.com/wiki/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[systemd 服务配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)。
> 当前仓库版本为v0.12.0试运行版，以下云端配置是参考模板，尚未完成真实服务器验收。优先采用QQ官方WebSocket时，仅需设备可以访问外网，无需公网回调地址，也无需Caddy。只有选择旧Webhook方式时才需要下文的域名、HTTPS与回调步骤。

