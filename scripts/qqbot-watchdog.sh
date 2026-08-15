#!/bin/bash
# QQ Bot 鐪嬮棬鐙?v4锛?026-08-16锛?# 鐢?Windows 璁″垝浠诲姟 QQBot-AutoStart 鍦ㄧ櫥褰曟椂鍚姩锛堝墠鍙伴樆濉?wsl 浼氳瘽鎸佹湁锛?# 鐩稿 v3 鐨勬敼鍔紙浠呬袱澶勶紝鍏朵綑閫昏緫閫愬瓧鑺備繚鐣欙級锛?#   - 绗?4 姝ョ鍙ｆ鏌ワ細3456 鈫?3457锛堥樁娈?3 姝ｅ紡瀹屾垚锛孡LOneBot 涓婃姤宸插垏 ACP 妗ワ級
#   - bridge 鎷夎捣鍛戒护锛歴tart-bot.sh(鏃?bridge.js) 鈫?ACP 妗ュ墠鍙伴樆濉炴媺璧?#     锛坆ash -c '... exec node bridge-acp.mjs'锛宔xec 璁?node 鎺ョ bash 鎴愪负浼氳瘽鐩存帴瀛愯繘绋嬶紱
#       鍚稿彇 nohup 鏁欒锛歯ohup & 鍦?wsl 浼氳瘽缁撴潫 10-18s 鍐呰娓呯悊锛?# v3 淇濈暀閫昏緫锛欴ocker llonebot 鈫?get_friend_list 鐪熷疄鍙敤 鈫?濂藉弸鍒楄〃闈炵┖锛堜吉鍦ㄧ嚎锛夆啋 bridge 绔彛
#   浼湪绾?API 寮傚父锛氳繛缁?3 娆?+ 瀹瑰櫒鍚姩 5 鍒嗛挓瀹介檺鏈燂紙闃叉壂鐮佸悓姝ユ湡璇潃锛?# 鏃ュ織锛?root/start-bot.log

echo "[watchdog] 鍚姩 $(date)" >> /root/start-bot.log

# LLOneBot access_token锛氫粠 qq-bot .env 璇诲彇锛堝嬁纭紪鐮佸瘑閽ュ叆搴擄級
if [ -f /home/botuser/qq-bot/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /home/botuser/qq-bot/.env
  set +a
fi
TOKEN="${ONEBOT_TOKEN:-}"
FAKE_COUNT=0
API_FAIL_COUNT=0

# 瀹瑰櫒宸插惎鍔ㄧ鏁帮紙瀹瑰櫒鏈繍琛岃繑鍥?0锛?container_uptime() {
  local started start_ts
  started=$(docker inspect -f '{{.State.StartedAt}}' llonebot 2>/dev/null)
  [ -z "$started" ] && { echo 0; return; }
  start_ts=$(date -d "$started" +%s 2>/dev/null || echo "$(date +%s)")
  echo $(( $(date +%s) - start_ts ))
}

while true; do
  UP=$(container_uptime)
  GRACE=$(( UP < 300 ))  # 瀹瑰櫒鍚姩 5 鍒嗛挓鍐呬负瀹介檺鏈燂紝涓嶈Е鍙戦噸鍚?
  # 1. Docker 瀹瑰櫒鍦ㄤ笉鍦紵
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx llonebot; then
    echo "[watchdog] Docker llonebot 瀹瑰櫒涓嶅湪杩愯锛屽皾璇曞惎鍔?$(date)" >> /root/start-bot.log
    docker start llonebot >> /root/start-bot.log 2>&1
    sleep 30
    continue
  fi

  # 2. OneBot API 鏄惁鐪熷疄鍙敤锛燂紙get_friend_list 鑰岄潪 get_login_info锛屽悗鑰呬吉鍦ㄧ嚎涔熻兘杩斿洖 OK锛?  FRIENDS=$(curl -s -m 10 -X POST http://127.0.0.1:3001/get_friend_list \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  if ! echo "$FRIENDS" | grep -q '"status":"ok"'; then
    API_FAIL_COUNT=$((API_FAIL_COUNT+1))
    if [ "$GRACE" = "1" ] || [ "$API_FAIL_COUNT" -lt 3 ]; then
      echo "[watchdog] OneBot API 寮傚父(${API_FAIL_COUNT}/3, up=${UP}s): ${FRIENDS:0:80}" >> /root/start-bot.log
    else
      echo "[watchdog] OneBot API 鎸佺画寮傚父锛堣繛缁?娆★級锛岄噸鍚?Docker $(date)" >> /root/start-bot.log
      docker restart llonebot >> /root/start-bot.log 2>&1
      API_FAIL_COUNT=0
    fi
    sleep 60
    continue
  fi
  API_FAIL_COUNT=0

  # 3. 浼湪绾挎娴嬶紙鐧诲綍 OK 浣嗗ソ鍙嬪垪琛ㄧ┖ = NT 灞傛晠闅滐級鈥斺€旇繛缁?3 娆?+ 瀹介檺鏈熶繚鎶?  FRIEND_COUNT=$(echo "$FRIENDS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  if [ "$FRIEND_COUNT" = "0" ]; then
    FAKE_COUNT=$((FAKE_COUNT+1))
    if [ "$GRACE" = "1" ] || [ "$FAKE_COUNT" -lt 3 ]; then
      echo "[watchdog] 濂藉弸鍒楄〃绌?${FAKE_COUNT}/3, up=${UP}s)鈥斺€旀暟鎹悓姝ヤ腑鎴栦吉鍦ㄧ嚎锛屾殏涓嶉噸鍚? >> /root/start-bot.log
    else
      echo "[watchdog] 浼湪绾跨‘璁わ紙杩炵画3娆″ソ鍙嬬┖锛夛紝閲嶅惎 Docker $(date)" >> /root/start-bot.log
      docker restart llonebot >> /root/start-bot.log 2>&1
      FAKE_COUNT=0
    fi
    sleep 60
    continue
  fi
  FAKE_COUNT=0

  # 4. Bridge 绔彛鍦ㄤ笉鍦紵锛坴4锛欰CP 妗?3457锛?  if ! ss -tln | grep -q ':3457 '; then
    echo "[watchdog] bridge 涓嶅湪绾匡紝灏濊瘯鎷夎捣 ACP 妗?$(date)" >> /root/start-bot.log
    # ACP 妗ュ墠鍙伴樆濉炴媺璧凤紙exec 璁?node 鎺ョ bash锛涘悗鍙?& 鎸傚埌鏈湅闂ㄧ嫍 wsl 浼氳瘽涓嬪父椹伙級
    # 妗ユ棩蹇楀崟鐙惤 bridge-acp.log锛圵indows 鍙锛夛紝鐪嬮棬鐙楄嚜韬瘖鏂暀 start-bot.log
    bash -c 'cd /mnt/d/qbot-agent_connection && exec node bridge-acp.mjs' >> "/mnt/d/qbot-agent_connection/bridge-acp.log" 2>&1 &
  fi

  sleep 60
done
