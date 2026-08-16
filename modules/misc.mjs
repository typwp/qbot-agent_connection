/**
 * misc.mjs — 公告 / 反馈 / 提醒列表与取消 / 每日自检
 */
import {
	readFileSync,
	mkdirSync,
	appendFileSync,
	existsSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
export const ANNOUNCE_DIR = join(DATA_ROOT, ".announcements");
export const FEEDBACK_DIR = join(DATA_ROOT, ".feedback");

const _pendingAnnouncements = new Map(); // uid -> { content }
const _announceCache = new Map(); // uid -> list

/** 收集所有私聊用户 id（来自 sessionMap，调用方传入） */
export function getAllUserIds(sessionMap) {
	return Object.keys(sessionMap)
		.filter((k) => !k.startsWith("group:"))
		.map((k) => (k.includes(":") ? k.split(":")[1] : k));
}

function logAnnouncement(targets, content) {
	try {
		const dir = join(
			ANNOUNCE_DIR,
			new Date().toISOString().slice(0, 13).replace("T", "-"),
		);
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "announcement.jsonl"),
			JSON.stringify({ time: new Date().toISOString(), targets, content }) +
				"\n",
			"utf-8",
		);
	} catch (e) {
		console.error("[announce] 记录失败:", e.message);
	}
}

/**
 * 公告命令处理（ctx: uid, isAdmin, sessionMap, sendFn），返回回复或 null
 */
export async function handleAnnounceCommand(raw, ctx) {
	const announceCmd = raw.match(/^(?:发|发布|发送)公告[：:]?\s*(.+)/);
	if (announceCmd) {
		if (!ctx.isAdmin) return { reply: "你没有权限执行此操作" };
		const content = announceCmd[1].trim();
		const others = getAllUserIds(ctx.sessionMap).filter((u) => u !== ctx.uid);
		_pendingAnnouncements.set(ctx.uid, { content, time: Date.now() });
		return {
			reply: `📋 公告草稿\n\n${content}\n\n——\n即将发送给 ${others.length} 位用户\n\n回复「确认」或「发」执行发送\n回复「取消」取消此次发送（草稿 10 分钟有效）`,
		};
	}
	if (_pendingAnnouncements.has(ctx.uid)) {
		const pending = _pendingAnnouncements.get(ctx.uid);
		// 草稿 10 分钟超时：确认消息给作废提醒，其余消息静默作废放行（防过期误群发）
		if (Date.now() - pending.time > 10 * 60 * 1000) {
			_pendingAnnouncements.delete(ctx.uid);
			if (/^(确认|发(送)?|确定)$/i.test(raw)) {
				return {
					reply: "⏰ 公告草稿已超时（10 分钟），已作废。请重新发送「发公告 <内容>」。",
				};
			}
		} else if (/^(确认|发(送)?|确定)$/i.test(raw)) {
			const { content } = _pendingAnnouncements.get(ctx.uid);
			_pendingAnnouncements.delete(ctx.uid);
			const footer =
				"\n\n💡 想看历史公告？发「公告」即可查看\n💡 有建议或问题？发「反馈 + 内容」告诉我\n💡 不知道命令怎么用？发「/help」查看所有可用命令";
			const fullMsg = content + footer;
			const adminId = ctx.wl?.admin?.[0];
			const allUsers = getAllUserIds(ctx.sessionMap).filter(
				(u) => u !== adminId,
			);
			logAnnouncement(allUsers, fullMsg);
			let sent = 0;
			for (const u of allUsers) {
				try {
					await ctx.sendFn("private", u, fullMsg);
					sent++;
				} catch {}
			}
			return {
				reply: `✅ 公告已发送，成功送达 ${sent}/${allUsers.length} 位用户`,
			};
		}
		if (/^(取消|算了|不发)$/i.test(raw)) {
			_pendingAnnouncements.delete(ctx.uid);
			return { reply: "已取消发送公告" };
		}
	}
	// 查询公告
	if (
		/^(?:\/announcements?)?\s*公告/.test(raw) ||
		/^\/announcements?$/.test(raw)
	) {
		try {
			if (!existsSync(ANNOUNCE_DIR)) return { reply: "暂无历史公告" };
			const allFiles = readdirSync(ANNOUNCE_DIR)
				.filter((f) => f.endsWith(".jsonl"))
				.sort()
				.reverse();
			let matchedFiles;
			const todayMatch = /今天/.test(raw);
			const recentMatch = raw.match(/最近\s*(\d+)\s*小?时?/);
			const dateMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
			const detailMatch = raw.match(/[#编号]\d+/);
			if (detailMatch) {
				const idx =
					parseInt(
						raw.match(/#(\d+)/)?.[1] || raw.match(/编号(\d+)/)?.[1],
						10,
					) - 1;
				const list = _announceCache.get(ctx.uid);
				if (!list || idx < 0 || idx >= list.length)
					return { reply: "编号无效，请先查询公告获取编号" };
				const r = list[idx];
				const bj = new Date(new Date(r.time).getTime() + 8 * 3600000);
				return {
					reply: `【${bj.toISOString().slice(0, 16).replace("T", " ")}】\n${r.content}`,
				};
			} else if (dateMatch) {
				matchedFiles = allFiles.filter((f) => f.startsWith(dateMatch[1]));
			} else if (recentMatch) {
				const hours = parseInt(recentMatch[1], 10);
				const cutoff = new Date(Date.now() - hours * 3600000)
					.toISOString()
					.slice(0, 13)
					.replace("T", "-");
				matchedFiles = allFiles.filter((f) => f >= cutoff);
			} else if (todayMatch) {
				const todayPrefix = new Date().toISOString().slice(0, 10);
				matchedFiles = allFiles.filter((f) => f.startsWith(todayPrefix));
			} else {
				matchedFiles = allFiles;
			}
			if (!matchedFiles || matchedFiles.length === 0)
				return { reply: "该范围内暂无公告" };
			const list = [];
			for (const f of matchedFiles) {
				for (const line of readFileSync(join(ANNOUNCE_DIR, f), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)) {
					try {
						list.push(JSON.parse(line));
					} catch {}
				}
			}
			if (list.length === 0) return { reply: "该范围内暂无公告" };
			_announceCache.set(ctx.uid, list);
			let result = `📋 公告（共 ${list.length} 条）\n\n`;
			for (let i = 0; i < list.length; i++) {
				const bj = new Date(new Date(list[i].time).getTime() + 8 * 3600000);
				const timeStr = bj.toISOString().slice(0, 16).replace("T", " ");
				const full = list[i].content.replace(/\n/g, " ");
				const preview = full.length > 40 ? full.slice(0, 40) + "…" : full;
				result += `#${i + 1} ${timeStr} — ${preview}\n`;
			}
			result += "\n发送「公告 #编号」查看完整内容";
			return { reply: result };
		} catch {
			return { reply: "读取公告失败" };
		}
	}
	return null;
}

/** 反馈命令：记录到 .feedback/YYYY-MM-DD.jsonl */
export function handleFeedback(raw, uid) {
	const m =
		raw.match(/^\/?feedback[：:]?\s*(.+)/i) || raw.match(/^反馈[：:]?\s*(.+)/);
	if (!m) return null;
	try {
		const dir = FEEDBACK_DIR;
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
		appendFileSync(
			file,
			JSON.stringify({
				time: new Date().toISOString(),
				user_id: uid,
				text: m[1].trim(),
			}) + "\n",
			"utf-8",
		);
		return { reply: "📨 反馈已收到，谢谢～" };
	} catch (e) {
		return { reply: `反馈记录失败: ${e.message}` };
	}
}

/** 提醒列表 / 取消提醒（reminders 由 features.mjs 管理） */
export function handleReminderCommand(raw, uid, reminders, cancelFn) {
	const t = raw.trim();
	if (/^(提醒列表|\/reminders?)$/i.test(t)) {
		const mine = reminders.filter(
			(r) => String(r.targetId) === String(uid) && r.msgType === "private",
		);
		if (mine.length === 0) return { reply: "你还没有设定任何提醒" };
		let r = `⏰ 我的提醒（${mine.length} 个）:\n`;
		mine.forEach((x, i) => {
			const when = new Date(x.time).toLocaleString("zh-CN", { hour12: false });
			r += `${i + 1}. [${x.id.slice(0, 8)}] ${when} — ${x.text}\n`;
		});
		r += "\n发送「取消提醒 #id」删除";
		return { reply: r };
	}
	const cancel = t.match(/^取消提醒\s*#?([0-9a-fA-F-]+)/);
	if (cancel) {
		const id = cancel[1];
		const found = reminders.find((x) => x.id.startsWith(id));
		if (!found) return { reply: `没有找到提醒 ${id}` };
		cancelFn(id);
		return { reply: `已取消提醒「${found.text}」` };
	}
	return null;
}

/** 每日自检：检查数据文件完整性 + pm.js 语法 + 存档目录 + token 账本 */
export function runSelfCheck() {
	const issues = [];
	const oks = [];
	// pm.js / prompt-profiles 挂 CLAUDE_CWD 下（.env 配置，例如 /mnt/d/Claude）；懒解析（.env 启动时才加载）
	const claudeCwd = process.env.CLAUDE_CWD || DATA_ROOT;
	// 1. pm.js 语法
	const pmPath = join(claudeCwd, "scripts", "pm.js");
	if (existsSync(pmPath)) {
		try {
			const r = spawnSync(process.execPath, ["-c", pmPath], { encoding: "utf-8" });
			if (r.status === 0) oks.push("pm.js 语法正常");
			else issues.push("pm.js 语法错误: " + String(r.stderr || "").slice(0, 120));
		} catch (e) {
			issues.push("pm.js 语法检查失败: " + e.message);
		}
	} else {
		issues.push("scripts/pm.js 缺失");
	}
	// 2. prompt-profiles 结构（残留/异常目录）
	const profilesRoot = join(claudeCwd, "prompt-profiles");
	try {
		const stray = [];
		const dirs = readdirSync(profilesRoot).filter((d) => {
			try {
				return statSync(join(profilesRoot, d)).isDirectory();
			} catch {
				return false;
			}
		});
		dirs.forEach((d) => {
			if (!/^\d{6,}$/.test(d) && !existsSync(join(profilesRoot, d, "persona.md"))) stray.push(d);
		});
		if (stray.length) issues.push("prompt-profiles 残留目录: " + stray.join(","));
		else oks.push("prompt-profiles 结构正常");
	} catch (e) {
		issues.push("prompt-profiles 读取失败: " + e.message);
	}
	// 3. 记忆/状态 JSON 解析
	const checks = [
		["user_memories.json", join(DATA_ROOT, "user_memories.json")],
		["daily_quota.json", join(DATA_ROOT, "daily_quota.json")],
		["reminders.json", join(DATA_ROOT, "reminders.json")],
		["user_prompts.json", join(DATA_ROOT, "user_prompts.json")],
		["prefs.json", join(DATA_ROOT, "prefs.json")],
		["sessions.json", join(DATA_ROOT, "sessions.json")],
	];
	for (const [name, p] of checks) {
		if (!existsSync(p)) {
			issues.push(`${name} 缺失`);
			continue;
		}
		try {
			JSON.parse(readFileSync(p, "utf8"));
			oks.push(`${name} 正常`);
		} catch {
			issues.push(`JSON 不可解析: ${name}`);
		}
	}
	// 4. token 账本
	try {
		const tl = join(DATA_ROOT, ".chat-logs", "token-usage.jsonl");
		if (existsSync(tl) && statSync(tl).size > 0) oks.push("token 账本正常");
		else issues.push("token 账本缺失或为空");
	} catch (e) {
		issues.push("token 账本异常: " + e.message);
	}
	return { issues, oks };
}

/** 每日自检并通知管理员（sendFn 注入发送函数） */
export async function runDailySelfCheck(sendFn, adminId) {
	try {
		const r = runSelfCheck();
		if (!adminId) {
			console.log("[selfcheck] 无管理员，跳过通知");
			return;
		}
		const head = "🧰 每日自检 " + new Date().toLocaleString("zh-CN", { hour12: false }).slice(0, 16);
		const body = r.issues.length
			? "⚠️ 发现 " + r.issues.length + " 个问题:\n" + r.issues.map((i) => "▸ " + i).join("\n")
			: "✅ 全部正常";
		await sendFn("private", adminId, head + "\n" + body).catch(() => {});
		console.log("[selfcheck] 自检完成: " + (r.issues.length ? "发现 " + r.issues.length + " 个问题" : "全部正常"));
	} catch (e) {
		console.log("[selfcheck] 自检异常: " + e.message);
	}
}

/** 每日反馈汇总：把当天 .feedback/YYYY-MM-DD.jsonl 发给管理员（每天 9:00） */
export async function sendDailyFeedbackSummary(sendFn, adminId) {
	const today = new Date().toISOString().slice(0, 10);
	const file = join(FEEDBACK_DIR, `${today}.jsonl`);
	if (!existsSync(file)) return;
	try {
		const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
		if (lines.length === 0 || !adminId) return;
		let msg = `📋 ${today} 用户反馈汇总（共 ${lines.length} 条）\n\n`;
		for (const line of lines) {
			try {
				const r = JSON.parse(line);
				msg += `【${r.nick || r.user_id}】${r.text}\n`;
			} catch {}
		}
		await sendFn("private", adminId, msg).catch(() => {});
		console.log(`[feedback] 已发送 ${today} 的日汇总`);
	} catch (e) {
		console.error("[feedback] 汇总失败:", e.message);
	}
}

/** 计算下一次本地时间 HH:00 的毫秒延迟（若已过则明天） */
export function msUntilHour(hour) {
	const now = new Date();
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
	if (now >= next) next.setDate(next.getDate() + 1);
	return next - now;
}
