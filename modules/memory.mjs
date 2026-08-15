/**
 * memory.mjs — 长期记忆（user_memories.json）+ 记忆命令
 * 数据文件：/home/botuser/qq-bot/user_memories.json（WSL 侧）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
const MEMORY_FILE = join(DATA_ROOT, "user_memories.json");
const LOG_DIR = join(DATA_ROOT, ".chat-logs");
export const MEMORY_MAX = 1000; // 字符硬上限

function loadMemories() {
	try {
		return JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
	} catch {
		return {};
	}
}
function saveMemories(m) {
	try {
		writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2));
	} catch (e) {
		console.error("[memory] 保存失败:", e.message);
	}
}

export function getUserMemory(uid) {
	return loadMemories()[uid]?.facts || "";
}

export function setUserMemory(uid, facts) {
	const m = loadMemories();
	m[uid] = {
		facts: String(facts).slice(0, MEMORY_MAX),
		updated: new Date().toISOString(),
	};
	saveMemories(m);
}

/** 处理记忆相关命令（记住 XX / 我的记忆 / 忘记全部 / 忘记 <词>），返回回复文本或 null（未命中） */
export function handleMemoryCommand(raw, uid) {
	const t = raw.trim();
	if (/^(记住|记一下|记着)\s+/.test(t)) {
		const text = t.replace(/^(记住|记一下|记着)\s+/, "").trim();
		if (!text) return "要记住什么呢？";
		const old = getUserMemory(uid);
		setUserMemory(uid, (old ? old + "；" : "") + text);
		return "📝 记住了。";
	}
	if (/^(我的记忆|查看记忆|记忆)$/.test(t)) {
		const mem = getUserMemory(uid);
		return mem ? `🧠 我的长期记忆：\n${mem}` : "还没有关于你的长期记忆～";
	}
	if (/^忘记全部$/.test(t)) {
		const m = loadMemories();
		delete m[uid];
		saveMemories(m);
		return "🗑️ 已清空关于你的长期记忆。";
	}
	if (/^忘记\s+/.test(t)) {
		const kw = t.replace(/^忘记\s+/, "").trim();
		if (!kw) return "忘记什么？";
		const old = getUserMemory(uid);
		if (!old) return "没有可删除的记忆。";
		const parts = old.split(/[；;。\n]/).filter(Boolean);
		const kept = parts.filter((p) => !p.includes(kw));
		if (kept.length === parts.length) return `没有找到包含「${kw}」的记忆。`;
		if (kept.length === 0) {
			const m = loadMemories();
			delete m[uid];
			saveMemories(m);
		} else {
			setUserMemory(uid, kept.join("；"));
		}
		return `🗑️ 已删除包含「${kw}」的记忆。`;
	}
	return null;
}

/** 提取记忆的 prompt 模板（extractMemory 用） */
export function buildExtractPrompt(oldMemory) {
	return (
		"[系统任务] 请根据我们的对话历史，压缩出「关键记忆」，只保留三类：\n" +
		"①【未结束的话题】还没聊完、下次可能要接着聊的事；②【对用户的认知】关于用户身份、性格、偏好、习惯的稳定认识；③【用户要求记住的事项】用户明确说过要记住、约定或待办。" +
		(oldMemory
			? "\n已有记忆（可能过时或错误，仅当本次对话再次印证才保留，被用户纠正过的必须删除）：" + oldMemory
			: "") +
		"\n★排除：测试性/一次性内容（如测试提醒、试功能）、关于bot系统本身的讨论、玩笑与假设、单次话题。只保留对未来对话有用的，不确定的宁可不记。" +
		"\n要求：第三人称、150字以内、直接输出纯文本，按【未结束话题】【对用户的认知】【用户要求记住】三段组织，某块没内容就写「无」，全无可提取的只输出：无"
	);
}

/** 校验提取结果并落库（返回是否成功） */
export function saveExtractedMemory(uid, t) {
	if (!t) return false;
	const s = String(t).trim();
	if (
		s &&
		s !== "无" &&
		s.length > 3 &&
		!s.startsWith("(无回复)") &&
		!s.startsWith("（处理失败")
	) {
		setUserMemory(uid, s);
		return true;
	}
	return false;
}

/**
 * 会话内记忆提取（旧桥 extractMemory 同款）：askFn 指带当前会话的 agent 调用，
 * 让 agent 基于对话历史提炼关键记忆。用于 /new 重置前（旧桥 L253/L1987 同款）。
 */
export async function runMemoryExtraction(uid, askFn) {
	try {
		const old = getUserMemory(uid);
		const r = await askFn(buildExtractPrompt(old));
		const t = String(r || "").trim();
		if (saveExtractedMemory(uid, t)) return t;
	} catch (e) {
		console.log("[memory] 提取失败:", e.message);
	}
	return null;
}

/**
 * 日志回退压缩（旧桥 compressContextMemories 同款）：不依赖内存会话，
 * 直接读 .chat-logs 最近 50 条 → 一次性 agent 调用 → 落库。
 * 用于会话已不可用/超限时也能保住记忆（/new 的兜底路径）。
 */
export async function compressContextMemories(uid, askOnce) {
	try {
		let recent = [];
		try {
			if (!existsSync(LOG_DIR)) return null;
			const dirs = readdirSync(LOG_DIR)
				.filter((d) => /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(d))
				.sort()
				.reverse();
			for (const d of dirs) {
				const f = join(LOG_DIR, d, `${uid}.jsonl`);
				if (!existsSync(f)) continue;
				const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
				for (const l of lines) {
					try {
						const o = JSON.parse(l);
						recent.push(`${o.dir === "in" ? "用户" : "助手"}: ${(o.text || "").slice(0, 150)}`);
					} catch {}
				}
				if (recent.length >= 50) break;
			}
		} catch (e) {
			console.error("[memory] 读日志失败:", e.message);
		}
		if (recent.length < 2) return null;
		const transcript = recent.slice(-50).join("\n");
		const old = getUserMemory(uid);
		const r = await askOnce(
			"[系统任务] 阅读下面这段对话记录，压缩出「关键记忆」，只保留三类：\n" +
				"①【未结束的话题】还没聊完、下次可能要接着聊的事；\n" +
				"②【对用户的认知】关于用户身份、性格、偏好、习惯的稳定认识；\n" +
				"③【用户要求记住的事项】用户明确说过要记住、约定或待办。\n" +
				(old ? "已有长期记忆（过时或与对话冲突的丢弃）：" + old + "\n" : "") +
				"要求：第三人称、整体150字以内、直接输出纯文本，按【未结束话题】【对用户的认知】【用户要求记住】三段组织，某块没内容就写「无」，全无可提取的只输出：无。\n\n对话记录：\n" +
				transcript,
		);
		const t = String(r || "").trim();
		if (saveExtractedMemory(uid, t)) return t;
	} catch (e) {
		console.log("[memory] 压缩失败:", e.message);
	}
	return null;
}
