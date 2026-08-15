#!/bin/bash
# QQ Bot 看门狗 v4（2026-08-16）
# 由 Windows 计划任务 QQBot-AutoStart 在登录时启动（前台阻塞 wsl 会话持有）
# 相对 v3 的改动（仅两处，其余逻辑逐字节保留）：
#   - 第 4 步端口检查：3456 → 3457（阶段 3 正式完成，LLOneBot 上报已切 ACP 桥）
#   - bridge 拉起命令：start-bot.sh(旧 bridge.js) → ACP 桥前台阻塞拉起
#     （bash -c '... exec node bridge-acp.mjs'，exec 让 node 接管 bash 成为会话直接子进程；
#       吸取 nohup 教训：nohup & 在 wsl 会话结束 10-18s 内被清理）
# v3 保留逻辑：Docker llonebot → get_friend_list 真实可用 → 好友列表非空（伪在线）→ bridge 端口
#   伪在线/API 异常：连续 3 次 + 容器启动 5 分钟宽限期（防扫码同步期误杀）
# 日志：/root/start-bot.log

echo "[watchdog] 启动 $(date)" >> /root/start-bot.log

# LLOneBot access_token：从 qq-bot .env 读取（勿硬编码密钥入库）
if [ -f /home/botuser/qq-bot/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /home/botuser/qq-bot/.env
  set +a
fi
TOKEN="${ONEBOT_TOKEN:-}"
FAKE_COUNT=0
API_FAIL_COUNT=0

# 容器已启动秒数（容器未运行返回 0）
container_uptime() {
  local started start_ts
  started=$(docker inspect -f '{{.State.StartedAt}}' llonebot 2>/dev/null)
  [ -z "$started" ] && { echo 0; return; }
  start_ts=$(date -d "$started" +%s 2>/dev/null || echo "$(date +%s)")
  echo $(( $(date +%s) - start_ts ))
}

while true; do
  UP=$(container_uptime)
  GRACE=$(( UP < 300 ))  # 容器启动 5 分钟内为宽限期，不触发重启

  # 1. Docker 容器在不在？
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx llonebot; then
    echo "[watchdog] Docker llonebot 容器不在运行，尝试启动 $(date)" >> /root/start-bot.log
    docker start llonebot >> /root/start-bot.log 2>&1
    sleep 30
    continue
  fi

  # 2. OneBot API 是否真实可用？（get_friend_list 而非 get_login_info，后者伪在线也能返回 OK）
  FRIENDS=$(curl -s -m 10 -X POST http://127.0.0.1:3001/get_friend_list \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  if ! echo "$FRIENDS" | grep -q '"status":"ok"'; then
    API_FAIL_COUNT=$((API_FAIL_COUNT+1))
    if [ "$GRACE" = "1" ] || [ "$API_FAIL_COUNT" -lt 3 ]; then
      echo "[watchdog] OneBot API 异常(${API_FAIL_COUNT}/3, up=${UP}s): ${FRIENDS:0:80}" >> /root/start-bot.log
    else
      echo "[watchdog] OneBot API 持续异常（连续3次），重启 Docker $(date)" >> /root/start-bot.log
      docker restart llonebot >> /root/start-bot.log 2>&1
      API_FAIL_COUNT=0
    fi
    sleep 60
    continue
  fi
  API_FAIL_COUNT=0

  # 3. 伪在线检测（登录 OK 但好友列表空 = NT 层故障）——连续 3 次 + 宽限期保护
  FRIEND_COUNT=$(echo "$FRIENDS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  if [ "$FRIEND_COUNT" = "0" ]; then
    FAKE_COUNT=$((FAKE_COUNT+1))
    if [ "$GRACE" = "1" ] || [ "$FAKE_COUNT" -lt 3 ]; then
      echo "[watchdog] 好友列表空(${FAKE_COUNT}/3, up=${UP}s)——数据同步中或伪在线，暂不重启" >> /root/start-bot.log
    else
      echo "[watchdog] 伪在线确认（连续3次好友空），重启 Docker $(date)" >> /root/start-bot.log
      docker restart llonebot >> /root/start-bot.log 2>&1
      FAKE_COUNT=0
    fi
    sleep 60
    continue
  fi
  FAKE_COUNT=0

  # 4. Bridge 端口在不在？（v4：ACP 桥 3457）
  if ! ss -tln | grep -q ':3457 '; then
    echo "[watchdog] bridge 不在线，尝试拉起 ACP 桥 $(date)" >> /root/start-bot.log
    # ACP 桥前台阻塞拉起（exec 让 node 接管 bash；后台 & 挂到本看门狗 wsl 会话下常驻）
    # 桥日志单独落 bridge-acp.log（Windows 可见），看门狗自身诊断留 start-bot.log
    bash -c 'cd /mnt/d/For\ Harness/poc-acp-qq && exec node bridge-acp.mjs' >> "/mnt/d/For Harness/poc-acp-qq/bridge-acp.log" 2>&1 &
  fi

  sleep 60
done
