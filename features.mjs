/**
 * ACP 桥功能模块（阶段 2）—— 消息适配层功能，与 agent 无关，从 bridge.js 迁移
 *
 * 已迁：
 *  - 每日限额（guest/user 分级，admin 不限，日期翻篇清零）
 *  - 定时提醒（持久化 reminders.json，重启恢复重挂，支持自然语言解析）
 *  - 人格注入（admin/user 完整人格；guest 简化人格 + 权限护栏）
 *
 * 用法：import { checkDailyQuota, parseReminder, scheduleReminder, loadReminders, buildPrompt } from "./features.mjs"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;

// ── 每日限额（bridge.js L312 同款）──
const USER_DAILY_LIMIT = parseInt(process.env.USER_DAILY_LIMIT || "100", 10);
const GUEST_DAILY_LIMIT = parseInt(process.env.GUEST_DAILY_LIMIT || "30", 10);

export function checkDailyQuota(uid, level) {
	if (level === "admin") return { ok: true };
	const limit = level === "user" ? USER_DAILY_LIMIT : GUEST_DAILY_LIMIT;
	const today = new Date().toISOString().slice(0, 10);
	let q = {};
	try {
		q = JSON.parse(readFileSync(join(DATA_DIR, "daily_quota.json"), "utf8"));
	} catch {}
	if (q.date !== today) q = { date: today, counts: {} };
	const used = q.counts?.[uid] || 0;
	if (used >= limit) return { ok: false, used, limit };
	if (!q.counts) q.counts = {};
	q.counts[uid] = used + 1;
	try {
		writeFileSync(join(DATA_DIR, "daily_quota.json"), JSON.stringify(q));
	} catch {}
	return { ok: true, used: used + 1, limit };
}

/** 只读查询今日额度（不计数，用于「额度」命令） */
export function getQuotaInfo(uid, level) {
	if (level === "admin") return { ok: true, unlimited: true };
	const limit = level === "user" ? USER_DAILY_LIMIT : GUEST_DAILY_LIMIT;
	const today = new Date().toISOString().slice(0, 10);
	let q = {};
	try {
		q = JSON.parse(readFileSync(join(DATA_DIR, "daily_quota.json"), "utf8"));
	} catch {}
	if (q.date !== today) return { ok: true, used: 0, limit };
	return { ok: true, used: q.counts?.[uid] || 0, limit };
}

// ── 定时提醒（bridge.js L327 同款）──
const REMINDERS_FILE = join(DATA_DIR, "reminders.json");
export function loadReminders() {
	try {
		return JSON.parse(readFileSync(REMINDERS_FILE, "utf8"));
	} catch {
		return [];
	}
}
function saveReminders(list) {
	try {
		writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
	} catch (e) {
		console.error("[remind] 保存失败:", e.message);
	}
}
const _reminderTimers = {};

/** 取消提醒：清 timer + 删记录 */
export function cancelReminder(id) {
	const t = _reminderTimers[id];
	if (t) {
		clearTimeout(t);
		delete _reminderTimers[id];
	}
	const list = loadReminders().filter(
		(x) => x.id !== id && !x.id.startsWith(id),
	);
	saveReminders(list);
}

/** 调度一条提醒（sendFn: (msgType, targetId, text) => Promise） */
export function scheduleReminder(r, sendFn) {
	const delay = new Date(r.time).getTime() - Date.now();
	if (delay > 2147000000) {
		_reminderTimers[r.id] = setTimeout(
			() => scheduleReminder(r, sendFn),
			2073600000,
		);
		return;
	}
	_reminderTimers[r.id] = setTimeout(
		() => {
			delete _reminderTimers[r.id];
			saveReminders(loadReminders().filter((x) => x.id !== r.id));
			const late = Date.now() - new Date(r.time).getTime() > 90 * 1000;
			sendFn(
				r.msgType,
				r.targetId,
				`⏰ 提醒：${r.text}${late ? "\n（bot 之前不在线，此条为补发）" : ""}`,
			).catch(() => {});
		},
		Math.max(delay, 0),
	);
}

/** 重启后恢复所有持久化提醒 */
export function restoreReminders(sendFn) {
	for (const r of loadReminders()) {
		if (new Date(r.time).getTime() > Date.now()) scheduleReminder(r, sendFn);
	}
}

/** 解析自然语言提醒：「30分钟后提醒我X」「明天8点提醒我X」「8:30提醒我X」 */
export function parseReminder(raw) {
	const t = raw.trim();
	let m = t.match(
		/^(\d+(?:\.\d+)?)\s*(秒|分钟?|个?小时|时)后?\s*提醒(?:我|一下)?[，,:：\s]*(.+)$/,
	);
	if (m) {
		const n = parseFloat(m[1]);
		const unit = m[2];
		let ms = n * 1000;
		if (unit.includes("分")) ms = n * 60 * 1000;
		else if (unit.includes("小时") || unit.includes("时")) ms = n * 3600 * 1000;
		return { time: new Date(Date.now() + ms).toISOString(), text: m[3] };
	}
	m = t.match(
		/^(?:明天|明早)\s*(\d{1,2})(?:点|:)?(\d{2})?\s*提醒(?:我|一下)?[，,:：\s]*(.+)$/,
	);
	if (m) {
		const d = new Date();
		d.setDate(d.getDate() + 1);
		d.setHours(parseInt(m[1]), m[2] ? parseInt(m[2]) : 0, 0, 0);
		return { time: d.toISOString(), text: m[3] };
	}
	m = t.match(/^(\d{1,2}):(\d{2})\s*提醒(?:我|一下)?[，,:：\s]*(.+)$/);
	if (m) {
		const d = new Date();
		d.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
		if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
		return { time: d.toISOString(), text: m[3] };
	}
	return null;
}

/** 创建提醒记录并持久化 */
export function createReminder(parsed, msgType, targetId) {
	const r = {
		id: randomUUID(),
		time: parsed.time,
		text: parsed.text,
		msgType,
		targetId,
	};
	const list = loadReminders();
	list.push(r);
	saveReminders(list);
	return r;
}

// ── 人格注入（bridge.js L94/L770 同款逻辑，通用化）──
// 内联仅保留通用 default；完整人格外置到 personas/<BOT_PERSONA>.txt，
// 由 getPersona() 在运行时加载 —— 个人人格不进代码、由部署者自备。
const PERSONAS = {
	default: `你是 QQ 上的一个 AI 朋友。聊天要像真人网友一样：自然、口语化、简短、有温度；用中文。`,
};

/** 返回当前人格文本（BOT_PERSONA 指定；支持 personas/<key>.txt 外置加载） */
export function getPersona() {
	const key = process.env.BOT_PERSONA || "default";
	if (PERSONAS[key]) return PERSONAS[key];
	// 外置人格：personas/<key>.txt（部署者自备，可 gitignore）
	try {
		const p = readFileSync(join(__dirname, "personas", `${key}.txt`), "utf8").trim();
		if (p) return p;
	} catch {}
	return PERSONAS.default;
}

// ── 旧桥记忆载入（阶段 3：继承 bridge.js 的跨会话记忆；仅 user_memories.json）──
const LEGACY_MEMORY_FILE = "/home/botuser/qq-bot/user_memories.json"; // 旧桥长期记忆

/** 读取旧桥用户长期记忆（facts） */
export function loadLegacyMemory(uid) {
	try {
		const m = JSON.parse(readFileSync(LEGACY_MEMORY_FILE, "utf8"));
		return m[uid]?.facts || "";
	} catch {
		return "";
	}
}

/** 组装旧桥记忆上下文（仅长期记忆；.chat-logs 是 Windows Claude 会话库，不注入） */
export function loadLegacyContext(uid) {
	const memory = loadLegacyMemory(uid);
	if (!memory) return "";
	return `[关于你：${memory}]\n[注意] 这是跨会话记忆，可能过时；和你现在说的矛盾时，以现在为准，旧记忆作废。`;
}

/** 构建发往 agent 的 prompt（按级别注入人格 + 权限护栏） */
export function buildPrompt(text, level, extraContext) {
	const persona = getPersona();
	let guard;
	if (level === "admin") {
		guard =
			"\n[规则] 你有完整权限，但受保护文件（whitelist.json/.env/bridge 配置）除非明确要求否则不要改。";
	} else if (level === "user") {
		guard =
			"\n[规则] 你只能聊天和只读查询，不能修改/删除文件，也不能执行系统级命令。";
	} else {
		guard =
			"\n[规则] 你只能聊天，不做文件操作、不执行命令、不查隐私。";
	}
	// 身份护栏：模型自报型号是幻觉重灾区（代理不暴露真实模型名），一律挡掉
	const botName = process.env.BOT_NAME || "AI 助手";
	guard +=
		`\n[身份] 别猜也别说自己是什么模型/版本（Opus、DeepSeek、Claude、v4flash 这类都不行）。被问「你是什么模型」就自然回答：我是 ${botName}，在 QQ 上陪你聊天。`;
	// 聊天基调：保持人设，但更像真人网友/群友，别像客服
	const tone =
		"\n[聊天基调] 像真人网友/群友一样：短句、口语化、自然接话，别用客服腔、别复述规则、别频繁喊对方名字。";
	const memory = extraContext ? `\n[补充信息] ${extraContext}` : "";
	return `${persona}${tone}${guard}${memory}\n\n用户：${text}`;
}

// ── 好友审批（bridge.js L957 同款，OneBot set_friend_add_request）──
export function approveFriendRequest(flag) {
	return setFriendRequest(flag, true);
}
export function rejectFriendRequest(flag) {
	return setFriendRequest(flag, false);
}
async function setFriendRequest(flag, approve) {
	const url = process.env.ONEBOT_URL || "http://127.0.0.1:3001";
	const token = process.env.ONEBOT_TOKEN || "";
	const res = await fetch(`${url}/set_friend_add_request`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ flag, approve }),
	});
	return res.json();
}

// ── B站订阅检查（bridge.js L2653 同款，调 bilibili-check.js 子进程）──
let _biliCheckRunning = false;
export async function checkBilibili() {
	if (_biliCheckRunning) return { ok: false, busy: true }; // 上一轮还在跑：跳过，勿返回 undefined
	_biliCheckRunning = true;
	const dataRoot = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
	const script = process.env.BILI_SCRIPT || join(dataRoot, "bilibili-check.js");
	const subsFile = process.env.BILI_SUBS || join(dataRoot, "bilibili_subs.json");
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(process.execPath, [script, "check", subsFile], {
				cwd: __dirname,
			});
		} catch (e) {
			// spawn 同步 throw（EPERM/ENOENT/路径非法）→ 转成失败结果，绝不能变成 unhandledRejection
			_biliCheckRunning = false;
			console.log("[bilibili] 启动检查进程失败:", e.message);
			resolve({ ok: false, error: e.message });
			return;
		}
		const killTimer = setTimeout(() => child.kill("SIGKILL"), 300000);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("close", (code) => {
			clearTimeout(killTimer);
			_biliCheckRunning = false;
			if (code !== 0 || !stdout.trim()) {
				resolve({ ok: false, code, stderr: stderr.trim().slice(0, 100) });
				return;
			}
			resolve({ ok: true, output: stdout });
		});
		child.on("error", (e) => {
			clearTimeout(killTimer);
			_biliCheckRunning = false;
			resolve({ ok: false, error: e.message });
		});
	});
}

// ── B站定时检查 + 通知（bridge.js L2655 同款，桥启动后每 5 分钟调用）──
let _biliCookieAlertTime = 0;
const BILI_TYPE_LABELS = { dynamic: "更新了动态", live: "开播啦", live_end: "下播了", video: "发布了新视频" };
export async function checkAndNotifyBilibili(sendFn, adminId) {
	let r;
	try {
		r = await checkBilibili();
	} catch (e) {
		console.log("[bilibili] 检查异常:", e.message);
		return;
	}
	if (!r.ok) {
		if (r.stderr) console.log("[bilibili] 检查失败:", r.stderr.slice(0, 100));
		return;
	}
	const out = r.output;
	if (out.includes("COOKIE_EXPIRED")) {
		console.log("[bilibili] Cookie 已过期，通知管理员");
		if (adminId && Date.now() - _biliCookieAlertTime > 3600000) {
			_biliCookieAlertTime = Date.now();
			sendFn("private", adminId, "🍪 B站 Cookie 已过期，请重新获取后发给我更新\n获取方式：浏览器 F12 → Application → Cookies → 复制 SESSDATA、bili_jct、DedeUserID").catch(() => {});
		}
	}
	try {
		const updates = JSON.parse(out.replace("COOKIE_EXPIRED\n", "").trim());
		if (!Array.isArray(updates) || updates.length === 0) {
			console.log("[bilibili] 检查完成——无更新");
			return;
		}
		console.log(`[bilibili] 检测到 ${updates.length} 条更新`);
		for (const u of updates) {
			const label = BILI_TYPE_LABELS[u.type] || u.type;
			let msg = `🔔 ${u.name} ${label}\n${u.title}\n`;
			if (u.url) msg += u.url;
			const targets =
				u.targets && u.targets.length > 0
					? u.targets
					: /^group:/.test(u.qq)
						? [{ type: "group", id: u.qq.split(":")[1] }]
						: [{ type: "private", id: u.qq }];
			for (const t of targets) {
				await sendFn(t.type, t.id, msg).catch(() => {});
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	} catch (e) {
		console.log("[bilibili] 解析检查结果失败:", e.message);
	}
}
