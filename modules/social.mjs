/**
 * social.mjs — 戳一戳回应 + LLOneBot 掉线检测/恢复
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
const STATUS_FILE = join(DATA_ROOT, "bot_status.json");
const POKE_COOLDOWN = 30000;

const POKE_FALLBACK = [
	"干、干什么啦！(╬￣皿￣)",
	"戳我也不会掉出实验数据的。",
	"无聊的话去看论文，别戳我。",
];

const _lastPoke = new Map(); // uid -> { reply, when }

/** 生成戳一戳回复（一次性 agent 调用，askOnce: (prompt) => Promise<string>） */
export async function generatePokeReply(uid, askOnce) {
	const prev = _lastPoke.get(uid);
	if (prev && Date.now() - prev.when < POKE_COOLDOWN) return prev.reply;
	const prompt =
		"你被戳了一下（QQ 戳一戳彩蛋），像群友被戳到一样，用一句话傲娇吐槽回应。要求：中文、15字以内、用颜文字、别用markdown、自然口语化。直接输出纯文本。";
	try {
		const r = await askOnce(prompt);
		if (r && r.length > 3 && !r.startsWith("（处理") && !r.startsWith("(agent")) {
			_lastPoke.set(uid, { reply: r, when: Date.now() });
			return r;
		}
	} catch (e) {
		console.error("[poke] 生成失败:", e.message);
	}
	// 失败：删掉占位，用保底
	_lastPoke.delete(uid);
	return POKE_FALLBACK[Math.floor(Math.random() * POKE_FALLBACK.length)];
}

/** 处理 poke 事件（冷却 + 生成 + 异步发送，不阻塞队列） */
export async function handlePoke(ev, askOnce, sendFn) {
	const pokerUid = String(ev.user_id || "");
	if (!pokerUid) return;
	const key = `poke:${pokerUid}`;
	const prev = _lastPoke.get(key);
	if (prev && Date.now() - prev.when < POKE_COOLDOWN) return; // 冷却丢弃
	_lastPoke.set(key, { reply: "...", when: Date.now() }); // 占位防并发
	const reply = await generatePokeReply(pokerUid, askOnce);
	// 占位已由 generatePokeReply 覆盖或删除；更新为最终回复
	_lastPoke.set(key, { reply, when: Date.now() });
	// 群内戳 → 回群；私聊戳 → 回戳的人
	const targetType = ev.group_id ? "group" : "private";
	const targetId = ev.group_id || pokerUid;
	sendFn(targetType, targetId, reply);
}

// ── 掉线检测与状态 ──
export function writeBotStatus(status, reason) {
	try {
		const obj = {
			status,
			reason: reason || "",
			since: status === "offline" ? new Date().toISOString() : "",
		};
		writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
	} catch (e) {
		console.error("[health] 状态写入失败:", e.message);
	}
}

export function readBotStatus() {
	try {
		return JSON.parse(readFileSync(STATUS_FILE, "utf8"));
	} catch {
		return { status: "online" };
	}
}

/** 创建健康状态机（30s 检查 + 连续发送失败计数），返回 { checkHealth, trackSuccess, trackFail } */
export function createHealthMonitor(llonebotGetApi, sendFn, logError) {
	const HEALTH_INTERVAL = Number(process.env.HEALTH_INTERVAL_MS || 30000);
	const SEND_FAIL_THRESHOLD = 3;
	let botOnline = true;
	let offlineSince = null;
	let offlineReason = "";
	let consecutiveSendFails = 0;

	function handleOffline(reason) {
		if (!botOnline) return;
		botOnline = false;
		offlineSince = new Date();
		offlineReason = reason;
		consecutiveSendFails = 0;
		logError(`[health] bot 掉线: ${reason}`);
		writeBotStatus("offline", reason);
	}

	async function handleOnline() {
		if (botOnline) return;
		botOnline = true;
		const durMs = Date.now() - (offlineSince?.getTime() || Date.now());
		const durStr =
			durMs < 60000
				? `${Math.round(durMs / 1000)}秒`
				: durMs < 3600000
					? `${Math.round(durMs / 60000)}分钟`
					: `${Math.round(durMs / 3600000)}小时`;
		const msg = `🟢 bot 已恢复上线\n掉线时长: ${durStr}\n原因: ${offlineReason || "未知"}`;
		writeBotStatus("online", "");
		offlineSince = null;
		offlineReason = "";
		// 通知 admin（旧桥缺失，新桥补全）
		try {
			const wl = JSON.parse(
				readFileSync(join(DATA_ROOT, "whitelist.json"), "utf8"),
			);
			for (const adminId of wl.admin || []) {
				sendFn("private", adminId, msg);
			}
		} catch {}
	}

	async function checkHealth() {
		try {
			const result = await llonebotGetApi("/get_friend_list");
			const data = JSON.parse(result);
			// 判伪在线：get_login_info 假死时也 OK，必须好友列表非空
			if (data.status === "ok" && Array.isArray(data.data) && data.data.length > 0) {
				consecutiveSendFails = 0;
				await handleOnline();
			} else {
				handleOffline("LLOneBot 报告状态异常: " + JSON.stringify(data).slice(0, 100));
			}
		} catch (err) {
			handleOffline("LLOneBot 无响应: " + String(err?.message || "").slice(0, 80));
		}
	}

	function trackSuccess() {
		consecutiveSendFails = 0;
		if (!botOnline) handleOnline();
	}
	function trackFail() {
		consecutiveSendFails++;
		if (consecutiveSendFails >= SEND_FAIL_THRESHOLD) {
			handleOffline(`连续 ${consecutiveSendFails} 次消息发送失败`);
		}
	}

	// 启动即启动定时检查
	const timer = setInterval(checkHealth, HEALTH_INTERVAL);
	timer.unref?.();
	setTimeout(checkHealth, 5000); // 延迟 5s 首次检查

	return { checkHealth, trackSuccess, trackFail, isOnline: () => botOnline };
}
