/**
 * chatlog.mjs — 会话日志 / token 账本 / 当前时间注入
 * 数据全部落在 WSL 侧（不再用旧桥的 /mnt/d/qbot-agent_connection/.chat-logs）
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
export const CHAT_LOG_DIR = process.env.CHAT_LOG_DIR || join(DATA_ROOT, ".chat-logs");

/** 追加一行聊天记录（dir: in|out），目录按 UTC 小时命名（与旧桥一致） */
export function logChat(userId, nickname, dir, text) {
	try {
		const hourDir = new Date().toISOString().slice(0, 13).replace("T", "-");
		const dirPath = join(CHAT_LOG_DIR, hourDir);
		mkdirSync(dirPath, { recursive: true });
		const line =
			JSON.stringify({
				time: new Date().toISOString(),
				dir,
				nick: nickname || "",
				text: String(text).slice(0, dir === "out" ? 500 : 2000),
			}) + "\n";
		appendFileSync(join(dirPath, `${userId}.jsonl`), line, "utf-8");
	} catch (e) {
		console.error("[chatlog] 写入失败:", e.message);
	}
}

/** 追加 token 用量记录（DeepSeek 代理费率） */
export function logTokenUsage(userId, usage, inputLength, outputLength) {
	try {
		const inPrice = parseFloat(process.env.DEEPSEEK_INPUT_PRICE) || 1;
		const outPrice = parseFloat(process.env.DEEPSEEK_OUTPUT_PRICE) || 2;
		const inputTokens = usage?.input_tokens || Math.round((inputLength || 0) / 4);
		const outputTokens = usage?.output_tokens || Math.round((outputLength || 0) / 4);
		const costCny =
			(inputTokens / 1e6) * inPrice + (outputTokens / 1e6) * outPrice;
		const record = {
			time: new Date().toISOString(),
			user_id: userId,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cost_cny: Math.round(costCny * 10000) / 10000,
			source: usage ? "api" : "estimate",
		};
		appendFileSync(
			join(CHAT_LOG_DIR, "token-usage.jsonl"),
			JSON.stringify(record) + "\n",
			"utf-8",
		);
	} catch (e) {
		console.error("[chatlog] token 账本写入失败:", e.message);
	}
}

/** 统计某用户今日/本月 token 费用（/tokenusage 命令用） */
export function getTokenStats(uid, isAdmin) {
	try {
		const f = join(CHAT_LOG_DIR, "token-usage.jsonl");
		if (!existsSync(f)) return { today: 0, month: 0 };
		const now = new Date();
		const todayKey = now.toISOString().slice(0, 10);
		const monthKey = now.toISOString().slice(0, 7);
		let today = 0;
		let month = 0;
		for (const line of readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(line);
				if (!isAdmin && r.user_id !== uid) continue;
				const t = r.time?.slice(0, 10) || "";
				if (t === todayKey) today += r.cost_cny || 0;
				if (t.startsWith(monthKey)) month += r.cost_cny || 0;
			} catch {}
		}
		return {
			today: Math.round(today * 10000) / 10000,
			month: Math.round(month * 10000) / 10000,
		};
	} catch {
		return { today: 0, month: 0 };
	}
}

/** 当前时间注入（北京时间，模型无时钟） */
export function timeNote(text) {
	const now = new Date();
	const p2 = (x) => String(x).padStart(2, "0");
	const parts = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
		hour12: false,
	}).formatToParts(now);
	const get = (t) => parts.find((p) => p.type === t)?.value || "";
	let note = `[当前时间: ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("weekday")}]`;
	if (/提醒/.test(text || "")) {
		note +=
			"\n[规则: 定时提醒由系统层处理，仅识别「X分钟后提醒我Y」「明天8点提醒我Y」等格式。你自身无法设置任何提醒，不要口头答应；用户想设提醒时请引导使用上述格式]";
	}
	return note;
}
