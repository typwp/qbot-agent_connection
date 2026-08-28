/**
 * commands.mjs — 命令分发器（批次 1+2：harness / 记忆 / tokenusage / 重启 / 订阅 / 思考提示 / 群聊 / 公告 / 反馈 / 提醒管理）
 * ctx: { raw, uid, level, isPrivate, targetType, targetId, groupId, msgType, userNick, wl, sessionMap, sendFn, apiFn, reminders, cancelReminder }
 * 返回 { reply }（发回复）或 { action: "restart" }（主桥执行）或 null（不处理）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { handleHnCommand, handleApprovalReply } from "./harness.mjs";
import { handleMemoryCommand, runMemoryExtraction, compressContextMemories } from "./memory.mjs";
import { getTokenStats } from "./chatlog.mjs";
import {
	loadGroupPersonas,
	saveGroupPersonas,
	getGroupRole,
	buildGroupContext,
} from "./group.mjs";
import {
	handleAnnounceCommand,
	handleFeedback,
	handleReminderCommand,
} from "./misc.mjs";
import { handlePersonaCommand } from "./persona.mjs";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
const PREFS_FILE = join(DATA_ROOT, "prefs.json");
const BILI_SUBS = join(DATA_ROOT, "bilibili_subs.json");
const BILI_SCRIPT = join(DATA_ROOT, "bilibili-check.js");

export function loadPrefs() {
	try {
		return JSON.parse(readFileSync(PREFS_FILE, "utf8"));
	} catch {
		return {};
	}
}
export function savePrefs(p) {
	try {
		writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2));
	} catch (e) {
		console.error("[prefs] 保存失败:", e.message);
	}
}

/** 跑 bilibili-check.js 子进程（subs/unsub/list），返回 Promise<string> */
function runBili(args, timeoutMs) {
	return new Promise((resolve) => {
		try {
			const child = spawn(process.execPath, [BILI_SCRIPT, ...args], {
				timeout: timeoutMs || 20000,
			});
			let out = "";
			child.stdout.on("data", (d) => (out += d.toString()));
			child.stderr.on("data", (d) => (out += d.toString()));
			child.on("close", (code) =>
				resolve(code === 0 ? out.trim() : `操作失败: ${out.slice(0, 100)}`),
			);
			child.on("error", (e) => resolve(`脚本启动失败: ${e.message}`));
		} catch (e) {
			resolve(`脚本调用异常: ${e.message}`);
		}
	});
}

/**
 * 分发命令。返回处理结果对象或 null。
 */
export async function dispatchCommand(ctx) {
	const raw = String(ctx.raw || "").trim();
	if (!raw) return null;

	// 0. /notify 重启通知设置（提前拦截，群聊也生效；旧桥 L1189 同款）
	if (/^\/notify\b/i.test(raw)) {
		const nOn = /^\/notify\s+(?:on|1|开启|启用|打开)$/i.test(raw);
		const nOff = /^\/notify\s+(?:off|0|关闭|禁用|关掉)$/i.test(raw);
		const nHelp = /^\/notify\s*$/i.test(raw) || /^\/notify\s+help$/i.test(raw);
		if (nHelp || nOn || nOff) {
			const p = loadPrefs();
			if (nHelp) {
				return {
					reply:
						"📟 重启通知设置\n\n▸ /notify on — 开启重启通知\n▸ /notify off — 关闭重启通知\n▸ /notify — 查看当前状态\n\n当前：已" +
						(p[ctx.uid]?.notifyOnRestart === true ? "开启" : "关闭"),
				};
			}
			if (!p[ctx.uid]) p[ctx.uid] = {};
			p[ctx.uid].notifyOnRestart = nOn ? true : false;
			savePrefs(p);
			return {
				reply: nOn
					? "已开启重启通知，下次 bridge 重启时会通知你~"
					: "已关闭重启通知，下次重启不会打扰你啦",
			};
		}
	}

	// 1. harness 审批拦截（admin 私聊，「同意/拒绝 dsh-xxx」）—— 最高优先
	if (ctx.isPrivate && ctx.level === "admin") {
		const approvalReply = handleApprovalReply(raw);
		if (approvalReply) return { reply: approvalReply };
	}

	// 2. /hn 命令（admin 私聊）
	if (ctx.isPrivate && ctx.level === "admin" && /^\/hn(?:\s|$)/i.test(raw)) {
		const r = handleHnCommand(raw);
		if (r) return { reply: r };
	}

	// 3. 记忆命令（私聊）
	if (ctx.isPrivate) {
		const memReply = handleMemoryCommand(raw, ctx.uid);
		if (memReply) return { reply: memReply };
	}

	// 4. /tokenusage（私聊；群聊提示仅限私聊）
	if (/^\/tokenusage$/i.test(raw)) {
		if (!ctx.isPrivate)
			return {
				reply: "这个命令仅限私聊使用——账单数据不适合在群里展示 (〃∀〃)",
			};
		const isAdmin = ctx.level === "admin";
		const s = getTokenStats(ctx.uid, isAdmin);
		return {
			reply: `💰 Token 用量${isAdmin ? "（全体用户）" : "（仅你自己）"}\n\n今日: ¥${s.today.toFixed(4)}\n本月: ¥${s.month.toFixed(4)}`,
		};
	}

	// 5. 重启 bridge（admin；自启新进程读最新代码，看门狗兜底）
	if (/^(?:\/?重启|\/restart)$/i.test(raw)) {
		if (ctx.level === "admin") {
			return { reply: "正在重启…", action: "restart" };
		}
		return null;
	}

	// 6. 订阅列表（群聊查群订阅；兼容「我的订阅」「B站订阅列表」等说法）
	if (
		/^(?:\/?(?:我的)?(?:B站|b站|bili)?订阅列表|\/?我的订阅|\/?listbili)$/i.test(
			raw,
		)
	) {
		try {
			const subsData = JSON.parse(readFileSync(BILI_SUBS, "utf8"));
			const subsKey =
				ctx.msgType === "group" ? `group:${ctx.groupId}` : String(ctx.uid);
			const userSubs = subsData[subsKey] || [];
			if (userSubs.length === 0) return { reply: "你还没有订阅任何 UP 主" };
			const labels = { dynamic: "动态", live: "直播", video: "视频" };
			let reply = `订阅列表（共 ${userSubs.length} 个）:\n`;
			userSubs.forEach((s, i) => {
				reply += `${i + 1}. ${s.name} (UID: ${s.uid})  [${s.types.map((t) => labels[t] || t).join(", ")}]\n`;
			});
			return { reply };
		} catch (e) {
			return { reply: `查询失败: ${e.message}` };
		}
	}

	// 7. 订阅B站（群聊需群主/管理员或白名单 admin）
	const biliSubMatch =
		raw.match(
			/^(?:\/?订阅B站|\/?b站订阅|\/?bili订阅)\s*(\d+)(?:\s+(dynamic|live|video|全部))*$/i,
		) || raw.match(/^\/?subbili\s*(\d+)(?:\s+(dynamic|live|video|全部))*$/i);
	if (biliSubMatch) {
		const biliUid = biliSubMatch[1];
		const types =
			(biliSubMatch[2] || "全部") === "全部"
				? ["dynamic", "live", "video"]
				: biliSubMatch.slice(2).filter(Boolean);
		// 群聊权限双层兜底（旧桥 L1497 同款）：OneBot 查群角色 OR whitelist admin
		if (ctx.msgType === "group" && ctx.level !== "admin") {
			let allowed = false;
			if (ctx.apiFn) {
				try {
					const role = await getGroupRole(String(ctx.groupId), ctx.uid, ctx.apiFn);
					allowed = role === "owner" || role === "admin";
				} catch {}
			}
			if (!allowed) return { reply: "仅群主和管理员可以操作群订阅～" };
		}
		const subsKey =
			ctx.msgType === "group" ? `group:${ctx.groupId}` : String(ctx.uid);
		const out = await runBili(["subs", BILI_SUBS, subsKey, biliUid, ...types]);
		return { reply: out };
	}

	// 8. 取消订阅B站
	const biliUnsubMatch =
		raw.match(/^(?:\/?取消订阅|\/?退订)B站\s*(\d+)/i) ||
		raw.match(/^\/?unsubbili\s*(\d+)/i);
	if (biliUnsubMatch) {
		if (ctx.msgType === "group" && ctx.level !== "admin") {
			let allowed = false;
			if (ctx.apiFn) {
				try {
					const role = await getGroupRole(String(ctx.groupId), ctx.uid, ctx.apiFn);
					allowed = role === "owner" || role === "admin";
				} catch {}
			}
			if (!allowed) return { reply: "仅群主和管理员可以操作群订阅～" };
		}
		const subsKey =
			ctx.msgType === "group" ? `group:${ctx.groupId}` : String(ctx.uid);
		const out = await runBili(["unsub", BILI_SUBS, subsKey, biliUnsubMatch[1]]);
		return { reply: out };
	}

	// 9. 思考提示设置（开启/关闭/添加/删除/模式）
	const offCmd = raw.match(/^(关闭|禁用|关掉)(思考提示|思考中|让我想想)/i);
	const onCmd = raw.match(/^(开启|启用|打开)(思考提示|思考中|让我想想)/i);
	if (offCmd || onCmd) {
		const p = loadPrefs();
		if (!p[ctx.uid]) p[ctx.uid] = {};
		p[ctx.uid].thinkingEnabled = offCmd ? false : true;
		savePrefs(p);
		return {
			reply: offCmd
				? "已关闭思考提示，之后我就不发思考中提醒啦"
				: "已开启思考提示~",
		};
	}
	const addCmd = raw.match(/^(添加|新增|增加)思考提示[：:]?\s*(.+)/i);
	if (addCmd) {
		const tip = addCmd[2].trim();
		const p = loadPrefs();
		if (!p[ctx.uid]) p[ctx.uid] = {};
		if (!p[ctx.uid].customReplies) p[ctx.uid].customReplies = [];
		p[ctx.uid].customReplies.push(tip);
		p[ctx.uid].customMode = p[ctx.uid].customMode || "append";
		savePrefs(p);
		return { reply: `已添加思考提示：「${tip}」` };
	}
	const delCmd = raw.match(/^删除思考提示[：:]?\s*(.+)/i);
	if (delCmd) {
		const tip = delCmd[1].trim();
		const p = loadPrefs();
		const list = p[ctx.uid]?.customReplies || [];
		const idx = list.indexOf(tip);
		if (idx === -1)
			return {
				reply: `没找到「${tip}」，当前自定义提示词：${list.join("、") || "无"}`,
			};
		list.splice(idx, 1);
		savePrefs(p);
		return { reply: `已删除思考提示：「${tip}」` };
	}
	const modeCmd = raw.match(/^(?:思考提示)?(覆盖|追加)模式/i);
	if (modeCmd) {
		const mode = modeCmd[1] === "覆盖" ? "override" : "append";
		const p = loadPrefs();
		if (!p[ctx.uid]) p[ctx.uid] = {};
		p[ctx.uid].customMode = mode;
		savePrefs(p);
		return { reply: `已切换为${modeCmd[1]}模式` };
	}

	// 10. 查看当前设置
	if (/^(查看)?(我的)?(设置|配置|当前设置)$/i.test(raw)) {
		const p = loadPrefs()[ctx.uid] || {};
		let r = "📋 你的当前设置\n\n";
		r += `思考提示：${p.thinkingEnabled === false ? "❌ 关闭" : "✅ 开启"}\n`;
		r += `自定义提示词模式：${p.customMode === "override" ? "覆盖" : "追加"}\n`;
		r += `自定义提示词：${p.customReplies?.length ? p.customReplies.join("、") : "无"}\n`;
		r += `重启通知：${p.notifyOnRestart === true ? "✅ 开启" : "❌ 关闭（默认）"}`;
		return { reply: r };
	}

	// ── 批次 2：群聊命令（仅群消息）──
	if (!ctx.isPrivate) {
		const gid = String(ctx.groupId);

		// 群聊禁用仅私聊命令
		const privateOnly =
			/^(存档|读档|存档列表|人格列表|人格卡|我的存档|输出存档|列出存档|查看存档|所有人格卡|全部人格卡|人格|重置|新对话|重新开始|设置|配置|查看设置|我的设置|覆盖模式|追加模式|\/prompt|\/personality|\/new|\/reset|\/thinking|\/think|\/思考提示|同意好友|拒绝好友|\/restart|\/tokenusage|\/?重启|发(?:送)?公告|记住|忘记(?:全部|提醒)?|我的记忆|提醒列表|取消提醒|提醒|\/reminders?)/i.test(
				raw,
			) ||
			/^(开启|关闭|启用|禁用|添加|新增|增加|删除)\s*(思考提示|思考中)/i.test(
				raw,
			);
		if (privateOnly) {
			return {
				reply: "这个命令仅限私聊使用，在群里 @我 让我私聊帮你操作吧～ (￣▽￣)",
			};
		}

		// 群聊重置（群主/管理/admin）
		if (/^\/?(?:重置群聊对话|清空群聊记忆|重置群聊|\/resetgroup)$/.test(raw)) {
			let allowed = ctx.level === "admin";
			if (!allowed && ctx.apiFn) {
				try {
					const role = await getGroupRole(gid, ctx.uid, ctx.apiFn);
					allowed = role === "owner" || role === "admin";
				} catch {}
			}
			if (!allowed) return { reply: "仅群主和管理员可以重置群聊对话～" };
			ctx.deleteSession?.(`group:${gid}`);
			return { reply: "好的，群聊对话已清空～像刚开始聊天一样重新来！" };
		}

		// 群人格（群主/管理/admin）
		const gpSet = raw.match(/^\/?群人格\s+(.+)/);
		const gpList = /^\/?群人格$/.test(raw.trim());
		const gpClear = /^\/?群人格清除$/.test(raw);
		if (gpSet || gpList || gpClear) {
			let allowed = ctx.level === "admin";
			if (!allowed && ctx.apiFn) {
				try {
					const role = await getGroupRole(gid, ctx.uid, ctx.apiFn);
					allowed = role === "owner" || role === "admin";
				} catch {}
			}
			if (!allowed) return { reply: "仅群主和管理员可以设置群人格～" };
			const gps = loadGroupPersonas();
			if (gpClear) {
				delete gps[gid];
				saveGroupPersonas(gps);
				return { reply: "群人格已清除" };
			}
			if (gpList || (!gpSet && !gpClear)) {
				const cur = gps[gid];
				return {
					reply: cur
						? `当前群人格:\n${cur}`
						: "本群未设置群人格\n用法: /群人格 <描述文本>  — 自由设定群内说话风格",
				};
			}
			const prompt = gpSet[1].trim();
			if (prompt.length < 2) return { reply: "描述太短了，写详细一点吧～" };
			gps[gid] = prompt;
			saveGroupPersonas(gps);
			return { reply: "群人格已更新" };
		}

		// 群聊总结（群主/管理/admin + 计额度）
		const sumMatch = raw
			.trim()
			.match(/^\/?(?:总结群聊|群聊总结)(?:\s+(\d+))?$/);
		if (sumMatch) {
			let allowed = ctx.level === "admin";
			if (!allowed && ctx.apiFn) {
				try {
					const role = await getGroupRole(gid, ctx.uid, ctx.apiFn);
					allowed = role === "owner" || role === "admin";
				} catch {}
			}
			if (!allowed) return { reply: "仅群主和管理员可以使用此命令～" };
			if (ctx.checkQuota && !ctx.checkQuota(ctx.uid, ctx.level).ok)
				return { reply: "今日对话额度已用完，明天再来吧～" };
			const n = Math.min(parseInt(sumMatch[1] || "50", 10), 100);
			const msgs = await buildGroupContext(
				`总结群聊 ${n}`,
				gid,
				ctx.apiFn,
			).catch(() => "");
			const rawMsgs =
				msgs ||
				(await (
					await import("./group.mjs")
				).getGroupContext(gid, n, ctx.apiFn));
			if (rawMsgs.length < 3) return { reply: "最近群里没什么可总结的消息～" };
			ctx.sendFn?.(
				ctx.targetType,
				ctx.targetId,
				`正在爬楼总结最近 ${rawMsgs.length} 条消息……`,
			);
			const summary = await ctx.askOnce(
				"请总结以下QQ群聊记录：主要话题（分点）、谁说了关键内容、结论或待办（如有）。200字以内，中文，直接输出。\n\n" +
					rawMsgs.join("\n"),
			);
			return { reply: "📜 群聊总结\n\n" + summary };
		}
	}

	// ── 批次 2：公告 / 反馈 / 提醒管理 ──
	const announceResult = await handleAnnounceCommand(raw, {
		uid: ctx.uid,
		isAdmin: ctx.level === "admin",
		sessionMap: ctx.sessionMap || {},
		sendFn: ctx.sendFn,
		wl: ctx.wl,
	});
	if (announceResult) return announceResult;

	const feedbackResult = handleFeedback(raw, ctx.uid);
	if (feedbackResult) return feedbackResult;

	if (ctx.reminders && ctx.cancelReminder) {
		const remResult = handleReminderCommand(
			raw,
			ctx.uid,
			ctx.reminders,
			ctx.cancelReminder,
		);
		if (remResult) return remResult;
	}

	// ── 批次 3：/new 重置对话（私聊；重置前先把值得记住的提取进长期记忆）──
	const newMatch = raw.trim().match(/^\/(?:new|reset|重新开始|新对话)(!|！)?$/);
	if (newMatch) {
		const skip = !!newMatch[1]; // /new! = 干净重开，不写长期记忆
		if (ctx.isPrivate && !skip && ctx.askSession) {
			ctx.sendFn?.(ctx.targetType, ctx.targetId, "稍等，先把值得记住的事存进长期记忆……").catch(() => {});
			// 优先会话内提取；失败则回退读日志压缩（旧桥 compressContextMemories 同款兜底）
			const ok = await runMemoryExtraction(ctx.uid, ctx.askSession).catch(() => null);
			if (!ok && ctx.askOnce) {
				await compressContextMemories(ctx.uid, ctx.askOnce).catch(() => null);
			}
		}
		ctx.deleteSession?.(ctx.sessionKey);
		return {
			reply: skip
				? "好的，干净重开（本次没有写入长期记忆）～"
				: "好的，已经清空对话历史啦～你的自定义人设还在，我们重新开始聊吧！",
		};
	}

	// ── 批次 3：对话总结（基于当前会话历史）──
	if (/^(?:帮我总结一下|prompt-summarize|总结对话|总结一下)$/i.test(raw.trim())) {
		const quota = ctx.checkQuota
			? ctx.checkQuota(ctx.uid, ctx.level)
			: { ok: true };
		if (!quota.ok)
			return { reply: `今日对话额度已用完（${quota.limit} 次），明天再来吧～` };
		ctx.sendFn?.(ctx.targetType, ctx.targetId, "让我回顾一下我们的对话……").catch(() => {});
		const summary = ctx.askSession
			? await ctx
					.askSession(
						"请根据当前对话历史，总结我们聊了什么。输出简洁的结构化摘要，包含：主要话题、关键决策（如有）、待办事项（如有）。",
					)
					.catch(() => "(总结失败)")
			: "(当前会话不可用)";
		return { reply: "📋 对话总结\n\n" + summary };
	}

	// ── 批次 3：人设存读档（存档/读档/列表/prompt-save/load/list/delete//prompt/personality）──
	const personaResult = await handlePersonaCommand(raw, ctx);
	if (personaResult) return personaResult;

	return null;
}
