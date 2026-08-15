/**
 * harness.mjs — DSH harness 双向通道（dsh-qq-notify 协作）
 * 决定文件写 Windows 侧（插件轮询通道，功能必需，非数据源）
 */
import { appendFileSync } from "node:fs";

const DECISIONS_FILE =
	process.env.HAR_DECISIONS_FILE || "/mnt/d/qbot-agent_connection/harness-decisions.jsonl";
const DEDUP_WINDOW_MS = 30 * 60 * 1000;
const _handledTokens = new Map(); // token -> ts

function writeDecision(rec) {
	try {
		appendFileSync(DECISIONS_FILE, JSON.stringify(rec) + "\n", "utf-8");
		return true;
	} catch (e) {
		console.error("[harness] 写决定文件失败:", e.message);
		return false;
	}
}

/**
 * 处理 /hn 命令（admin 私聊），返回回复文本或 null（未命中 /hn）
 */
export function handleHnCommand(text) {
	const m = /^\/hn(?:\s+(.+))?$/i.exec(text.trim());
	if (!m) return null;
	const raw = (m[1] || "").trim();
	const parts = raw.split(/\s+/);
	const cmd = (parts[0] || "").toLowerCase();
	const keyMap = {
		approval: "notifyApproval",
		complete: "notifyComplete",
		toolonly: "notifyOnToolOnly",
		qq: "approvalViaQq",
	};
	let rec = null;
	if (!cmd || cmd === "status" || cmd === "list") {
		rec = { type: "settings", action: "status", ts: new Date().toISOString() };
	} else if (cmd === "monitor") {
		if (parts[1] === "off" || parts[1] === "clear") {
			rec = { type: "settings", action: "monitor-clear", ts: new Date().toISOString() };
		} else if (parts[1]) {
			const name = parts.slice(2).join(" ");
			rec = {
				type: "settings",
				action: "monitor-add",
				id: parts[1],
				...(name ? { name } : {}),
				ts: new Date().toISOString(),
			};
		}
	} else if (cmd === "unmonitor" && parts[1]) {
		rec = { type: "settings", action: "monitor-remove", id: parts[1], ts: new Date().toISOString() };
	} else if (cmd === "name" && parts[1] && parts[2]) {
		rec = {
			type: "settings",
			action: "name-set",
			id: parts[1],
			name: parts.slice(2).join(" "),
			ts: new Date().toISOString(),
		};
	} else {
		const key = keyMap[cmd];
		if (key && /^(on|off|true|false|1|0)$/i.test(parts[1] || "")) {
			rec = {
				type: "settings",
				action: "set",
				key,
				value: /^(on|true|1)$/i.test(parts[1]),
				ts: new Date().toISOString(),
			};
		} else if (cmd === "timeout" && /^\d+$/.test(parts[1] || "")) {
			rec = {
				type: "settings",
				action: "set",
				key: "approvalTimeoutMs",
				value: Number(parts[1]),
				ts: new Date().toISOString(),
			};
		}
	}
	if (rec && writeDecision(rec)) {
		return `🛠 设置请求已提交（${cmd || "status"}），harness 稍后确认`;
	}
	if (!rec) {
		return "用法：\n/hn list\n/hn approval on|off\n/hn complete on|off\n/hn toolOnly on|off\n/hn qq on|off\n/hn timeout <毫秒>\n/hn monitor <会话id> [名称]\n/hn unmonitor <会话id>\n/hn monitor off\n/hn name <会话id> <名称>";
	}
	return null;
}

/**
 * 处理「同意/拒绝 dsh-xxx」审批回复（admin 私聊），返回回复文本或 null
 */
export function handleApprovalReply(text) {
	const allowMatch = /^(同意|允许|确认|yes|y|ok)\s+(dsh-[a-z0-9]+)$/i.exec(text.trim());
	const denyMatch = /^(拒绝|不同意|取消|no|n|deny)\s+(dsh-[a-z0-9]+)$/i.exec(text.trim());
	if (!allowMatch && !denyMatch) return null;
	const token = (allowMatch || denyMatch)[2];
	// 30 分钟去重
	const handledAt = _handledTokens.get(token);
	if (handledAt !== undefined && Date.now() - handledAt < DEDUP_WINDOW_MS) {
		return `ℹ️ 该请求已处理（${token}），无需重复回复`;
	}
	const outcome = allowMatch ? "allowed" : "rejected";
	if (writeDecision({ type: "approval", token, outcome, ts: new Date().toISOString() })) {
		_handledTokens.set(token, Date.now());
		if (_handledTokens.size > 500) {
			for (const [k, v] of _handledTokens) {
				if (Date.now() - v > DEDUP_WINDOW_MS) _handledTokens.delete(k);
			}
		}
		return `✅ 已${allowMatch ? "同意" : "拒绝"}（${token}），harness 已收到`;
	}
	return "⚠️ 写入 harness 决定失败，请重试";
}
