# ACP QQ Bridge

把 QQ（OneBot11/LLOneBot）接到 **ACP agent**（如 Claude Code CLI）的桥接器。QQ 消息 → LLOneBot → 本桥 → ACP → agent（经 claude CLI 可对接任意 Anthropic 兼容后端）→ 回发 QQ。

零第三方运行时依赖（仅 Node.js 20+；ACP 侧复用既有生态的 `acpx` + `claude` CLI）。

## 架构

```
QQ ←→ LLOneBot(OneBot11, :3001) ──http-post──▶ 本桥(:3457 /message)
                                              │
                                   ACP(acpx) → claude CLI → 任意 Anthropic 兼容后端
                                              │
         DSH harness 插件(dsh-qq-notify) ──POST /send──▶ 主动发 QQ
                          ▲  ◀── decisions.jsonl 轮询（审批/设置）
```

## 特性

- 三级权限：`admin`（全工具）/ `user`（只读工具）/ `guest`（纯对话）
- 会话持久化（acp-sessions.json）、串行队列、限流、agent 超时强杀
- 超长回复分段、空行自然分段发送、群聊首条引用防串话
- 定时提醒、每日限额、跨会话长期记忆、B站订阅轮询
- 群聊：@/名字唤醒、群人格、群聊总结、群聊重置、自适应上下文
- 人设：存档/读档（pm.js）、/prompt 自定义人格、对话总结
- 思考中提示（场景自适应）、URL 识图、公告、反馈日汇总、每日自检
- HTTP 接口：`/message`（LLOneBot 上报）、`/send`（插件主动发）、`/health`、`/restart`、`/announce`
- 看门狗脚本（容器/API/伪在线/桥进程四层守护）

## 目录结构

```
bridge-acp.mjs        主桥（队列/ACL/会话/HTTP/定时）
features.mjs          人格加载/记忆/限额/提醒/B站/好友审批
modules/
  commands.mjs        命令分发器（全部 QQ 命令）
  harness.mjs         DSH harness 审批 + /hn（decisions.jsonl 通道）
  memory.mjs          长期记忆 + 重置前记忆提取
  chatlog.mjs         会话日志 + token 账本（DeepSeek 费率）
  social.mjs          戳一戳 + LLOneBot 健康检查
  group.mjs           群过滤/群人格/群上下文/群角色
  misc.mjs            公告/反馈/提醒管理/每日自检
  persona.mjs         存档读档(pm.js) + /prompt + 对话总结
  vision.mjs          URL 识图
  thinking.mjs        思考中提示
personas/             外置人格（personas/<BOT_PERSONA>.txt）
```

## 前置依赖

1. **Node.js 20+**（运行桥；桥所在机器）
2. **LLOneBot**（QQ 协议端，OneBot11，HTTP 上报指向桥的 `/message`）
3. **acpx + claude CLI**（ACP 侧）：`npm i acpx`；`claude` 的 `~/.claude/settings.json` 配置好
   `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN`（可对接 DeepSeek 等中转），模型由
   settings.json 决定（桥不注入 MODEL）。
   - Linux/WSL 下 claude-agent-sdk 需要 `CLAUDE_CODE_EXECUTABLE=/usr/bin/claude`
     （Windows 安装的依赖缺 linux-x64 原生二进制）。

## 安装与配置

```bash
git clone <本仓库> qq-bot && cd qq-bot
cp .env.example .env        # 填 BOT_QQ / ONEBOT_URL / ONEBOT_TOKEN / BOT_PERSONA / QQBOT_DIR
cp whitelist.example.json whitelist.json   # 填 admin/users 的 QQ
mkdir -p data               # QQBOT_DIR（数据根）
# 可选：外置人格（personas/<名称>.txt，设 BOT_PERSONA=<名称>；不设置则用内置 default）
# 例：echo "你是 XX——一段人格描述" > personas/my-persona.txt  && echo 'BOT_PERSONA=my-persona' >> .env
```

LLOneBot 侧：OneBot11 配置里加一条 http-post 上报，URL 填 `http://<桥所在主机>:3457/message`（容器部署用 Docker 网关，如 `172.17.0.1:3457`）。

## 启动（⚠️ 重要：WSL 下不要用 nohup）

**WSL 里 `nohup node xxx &` 的进程会在 wsl 会话结束后 10~18 秒内被静默清理**（无报错）。必须前台阻塞：

```bash
# 前台阻塞（wsl.exe 持有会话句柄，进程常驻）
wsl -d <发行版> -u root -- bash -c 'cd /path/to/qq-bot && exec node bridge-acp.mjs'
```

或交给看门狗（推荐）：`scripts/qqbot-watchdog.sh` 四层守护（容器→API→伪在线→桥端口），
桥掉线时用 `exec node` 前台方式拉起。Windows 侧可用计划任务登录触发：
`wsl -d <发行版> -u root -- bash /path/to/qqbot-watchdog.sh`。

启动后日志应包含：监听端口、权限、会话数、自检/B站轮询/反馈汇总定时。

## 与 DSH（DeepSeek Harness）插件连接

配套插件仓库 [dsh-pluginsANDskills-by-Ty](https://github.com/typwp/dsh-pluginsANDskills-by-Ty)，其中 `packages/dsh-qq-notify`（可选）：

- **Harness → QQ**：插件配置 `bridgeUrl: http://127.0.0.1:3457/send`，`targetQq: <你的QQ>`，
  通知/审批消息经 `/send` 主动发到 QQ。
- **QQ → Harness**：`decisionsFilePath` 指向桥写入的 `harness-decisions.jsonl`，插件每秒轮询，
  实现「回复 同意/拒绝 dsh-xxx」远程审批 + `/hn` 会话命令。
- WSL2 的 localhost 转发使 Windows 侧 harness 可直接访问 `127.0.0.1:3457`。

## 常用命令（QQ 内）

```
帮助 / 额度 / 提醒我… / 提醒列表 / 取消提醒 #id
记住… / 我的记忆 / 忘记全部
订阅B站 <UID> / 订阅列表 / 取消订阅B站 <UID>
存档 / 读档 / 存档列表 / /personality set <内容> / /prompt summarize
/new（重置前自动提取记忆） /new!（干净重开）
/notify on|off（重启通知） /tokenusage /重启（admin）
群聊：@我 / 喊机器人的名字（personas 人格里设定的称呼）/ /群人格 / 总结群聊 [条数] / /resetgroup
```

## 安全说明

- `/send`、`/announce` 等 HTTP 接口默认无鉴权（与旧桥一致，供内网/本机使用）；公网部署请加反向代理鉴权。
- `whitelist.json`、`.env`、`pending_friends.json` 含敏感信息，已在 `.gitignore` 排除，切勿入库。
- guest 用户通过 acpx `--allowed-tools ""` 完全禁用工具；user 仅只读工具。
