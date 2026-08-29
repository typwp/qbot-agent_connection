/**
 * group.mjs — 群聊：消息过滤 / 自适应上下文 / 会话重置 / 群人格 / 总结
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
const GROUP_PERSONA_FILE = join(DATA_ROOT, "group_personas.json");

export function loadGroupPersonas() {
	try {
		return JSON.parse(readFileSync(GROUP_PERSONA_FILE, "utf8"));
	} catch {
		return {};
	}
}
export function saveGroupPersonas(data) {
	try {
		writeFileSync(GROUP_PERSONA_FILE, JSON.stringify(data, null, 2));
	} catch (e) {
		console.error("[group] 群人格保存失败:", e.message);
	}
}

/** 拉群最近消息（get_group_msg_history），返回 ["昵称: 内容", ...] */
export async function getGroupContext(groupId, count, apiFn) {
	try {
		const text = await apiFn("/get_group_msg_history", {
			group_id: Number(groupId),
			count,
		});
		const data = JSON.parse(text);
		const msgs = data?.data?.messages || [];
		return msgs
			.slice(-count)
			.map(
				(m) =>
					`${m.sender?.nickname || "?"}: ${m.raw_message || m.message || ""}`,
			)
			.filter((l) => l.split(": ")[1]?.length > 0);
	} catch {
		return [];
	}
}

/** 查群成员角色（get_group_member_info），返回 owner|admin|member|"" */
export async function getGroupRole(groupId, userId, apiFn) {
	try {
		const text = await apiFn("/get_group_member_info", {
			group_id: Number(groupId),
			user_id: Number(userId),
		});
		const data = JSON.parse(text);
		return data?.data?.role || "";
	} catch {
		return "";
	}
}

/** 群消息过滤：返回 { handle, cleaned, triggered } 或 null（应丢弃） */
export function shouldHandleGroup(raw, uid, selfId, botQq) {
	// CQ at 码可能带 ,name=… 等附加参数，必须允许 [CQ:at,qq=xxx,...]
	const atRegex = new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`);
	let isAtBot = atRegex.test(raw);
	if (!isAtBot && botQq && String(selfId) !== String(botQq)) {
		isAtBot = new RegExp(`\\[CQ:at,qq=${botQq}(?:,[^\\]]*)?\\]`).test(raw);
	}
	// 名字唤醒（WAKE_WORDS 环境变量指定正则，如「bot名|昵称」；默认关闭）
	const wakeWords = process.env.WAKE_WORDS || "";
	const isNameCall = wakeWords ? new RegExp(wakeWords, "i").test(raw) : false;
	// 引用消息不再单独作为触发条件：只有 @bot / 命令 / 名字唤醒才响应，
	// 避免“引用其他人的消息”也会让 bot 接话。
	const isCommand =
		/^[/#]/.test(raw.trim()) ||
		/^(订阅|退订|(?:我的)?订阅列表|存档|读档|群?人格|重启|反馈|公告|帮助|help|b站|B站|bili)/i.test(
			raw.trim(),
		);

	// 过滤其他机器人 + 自动欢迎语
	const KNOWN_BOTS = ["2854196310", "2854196312", "2854196315"];
	if (
		KNOWN_BOTS.includes(uid) ||
		/欢迎新成员|欢迎新人|我是机器人|欢迎加入/.test(raw)
	) {
		return null;
	}
	if (!isAtBot && !isCommand && !isNameCall) return null;

	const cleaned = raw
		.replace(atRegex, "")
		.replace(/\[CQ:reply[^\]]*\]/g, "")
		.replace(/^[,\s]*/, "")
		.trim();
	return { handle: true, cleaned, isAtBot, isNameCall, isCommand };
}

/** 自适应群聊上下文（关键词相关度筛选，最多 8 条 + 最近 3 条） */
export async function buildGroupContext(raw, targetId, apiFn) {
	try {
		const rawMsgs = await getGroupContext(targetId, 30, apiFn);
		if (rawMsgs.length <= 1) return "";
		const STOP = new Set([
			"你觉得",
			"我觉得",
			"哪个",
			"什么",
			"怎么",
			"怎么样",
			"如何",
			"能不能",
			"有没有",
			"是不是",
			"可不可以",
			"有没有人",
			"大家",
			"有人",
			"告诉我",
			"知道",
			"请问",
			"帮忙",
			"帮我",
			"各位",
			"话说",
			"所以",
			"因为",
			"但是",
			"如果",
			"然后",
			"那个",
			"这个",
			"还是",
			"东西",
			"觉得",
			"可能",
			"应该",
			"可以",
			"就是",
			"不过",
			"不会",
			"其实",
			"反正",
			"来说",
		]);
		const kw = [
			...new Set(
				(raw.match(/[\u4e00-\u9fa5]{2,}/g) || []).filter(
					(w) => w.length >= 2 && !STOP.has(w),
				),
			),
		].slice(0, 10);
		const scored = rawMsgs.map((m) => {
			if (kw.length === 0) return { m, score: 0 };
			const hits = kw.filter((w) => m.includes(w)).length;
			return { m, score: hits / kw.length };
		});
		const top = scored
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8);
		const tail = scored.slice(-3).filter((s) => !top.includes(s));
		const selected = [...new Set([...top, ...tail])].sort(
			(a, b) => scored.indexOf(a) - scored.indexOf(b),
		);
		if (selected.length <= 1) return "";
		const nRelated = selected.filter((s) => s.score > 0).length;
		return (
			"\n\n[群聊上下文：最近" +
			rawMsgs.length +
			"条中 " +
			selected.length +
			" 条相关（含" +
			nRelated +
			"条话题匹配 + 最近3条）]\n" +
			selected.map((s) => s.m).join("\n")
		);
	} catch {
		return "";
	}
}
