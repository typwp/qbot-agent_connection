/**
 * ACP QQ Bridge — 安全版（阶段 3 完善）
 *
 * 架构：QQ(OneBot11/LLOneBot) → 消息适配层 → ACP(acpx) → agent → 回发 QQ
 *
 * 阶段 1：三级权限（admin 全工具 / user 受限 / guest 无工具）、会话持久化、串行队列、看门狗
 * 阶段 2：配额、提醒、人格注入、好友审批、B站检查（features.mjs）
 * 阶段 3 完善（本次）：
 *  - agent 调用超时强杀（防队列卡死）
 *  - 超长回复按 QQ 单条上限分段发送
 *  - 防刷限流（admin 不限）+ 队列上限保护
 *  - 帮助 / 额度命令；好友申请→通知 admin→「同意/拒绝 <QQ>」审批
 *  - 群消息仅响应 @bot 或命令（防刷屏），回复到群
 *  - 启动时恢复持久化提醒（修复重启丢提醒）
 *  - 会话映射文件损坏自愈
 *
 * 安全边界：
 *  - 只响应 whitelist 中的 admin/users（guest 仅纯对话，经 --allowed-tools "" 禁工具）
 *  - 敏感操作（改白名单等）走 ACP permission request → QQ 审批
 *
 * 用法：
 *   node bridge-acp.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkDailyQuota,
	getQuotaInfo,
	parseReminder,
	createReminder,
	scheduleReminder,
	restoreReminders,
	buildPrompt,
	loadLegacyContext,
	approveFriendRequest,
	rejectFriendRequest,
	loadReminders,
	cancelReminder,
	checkAndNotifyBilibili,
} from "./features.mjs";
import { dispatchCommand, loadPrefs, savePrefs } from "./modules/commands.mjs";
import { handlePoke, createHealthMonitor } from "./modules/social.mjs";
import { logChat, logTokenUsage, timeNote } from "./modules/chatlog.mjs";
import {
	shouldHandleGroup,
	loadGroupPersonas,
	buildGroupContext,
} from "./modules/group.mjs";
import { tryVision } from "./modules/vision.mjs";
import { saveSticker, stickerLibraryContext, extractStickers } from "./modules/stickers.mjs";
import { getUserPrompt, loadUserPrompts } from "./modules/persona.mjs";
import { needsThinkingIndicator, pickThinkingReply } from "./modules/thinking.mjs";
import {
	runDailySelfCheck,
	sendDailyFeedbackSummary,
	msUntilHour,
	ANNOUNCE_DIR,
} from "./modules/misc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 3457); // 端口定案 3457；须与看门狗/LLOneBot 上报/插件 bridgeUrl 一致
const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
// 白名单优先放 DATA_ROOT（通用部署），兼容旧位置 __dirname（现状迁移期）
const WHITELIST_FILE = existsSync(join(DATA_ROOT, "whitelist.json"))
	? join(DATA_ROOT, "whitelist.json")
	: join(__dirname, "whitelist.json");
const PENDING_FRIENDS_FILE = join(DATA_ROOT, "pending_friends.json");
const NOTIFY_DEFAULT_OFF_MARKER = join(DATA_ROOT, ".notify-default-off.marker");
const ACPX_CLI = join(__dirname, "node_modules", "acpx", "dist", "cli.js");
const DEFAULT_AGENT = process.env.ACP_AGENT || "claude";

// ── 重启通知默认关闭迁移（一次性）：除 admin 外所有用户 notifyOnRestart=false ──
// 之后语义：仅「/notify on」显式开启的用户 + admin 收"启动好啦！"，默认一律不通知。
function applyNotifyDefaultOff() {
	try {
		if (existsSync(NOTIFY_DEFAULT_OFF_MARKER)) return; // 只跑一次，不覆盖用户之后的自选
		const prefs = loadPrefs();
		const wl = loadWhitelist();
		const adminIds = new Set((wl.admin || []).map(String));
		const all = new Set();
		for (const k of Object.keys(prefs)) all.add(k);
		for (const k of Object.keys(sessionMap)) {
			if (!k.startsWith("group:")) all.add(k.includes(":") ? k.split(":")[1] : k);
		}
		for (const u of [...(wl.admin || []), ...(wl.users || [])]) all.add(String(u));
		let changed = 0;
		for (const u of all) {
			if (adminIds.has(u)) continue; // admin 保留
			if (prefs[u]?.notifyOnRestart !== false) {
				if (!prefs[u]) prefs[u] = {};
				prefs[u].notifyOnRestart = false;
				changed++;
			}
		}
		if (changed > 0) savePrefs(prefs);
		writeFileSync(
			NOTIFY_DEFAULT_OFF_MARKER,
			JSON.stringify({ time: new Date().toISOString(), changed }),
		);
		console.log(`[notify] 默认关闭迁移完成（${changed} 个用户改为关闭）`);
	} catch (e) {
		console.error("[notify] 迁移失败:", e.message);
	}
}

// ── 好友申请持久化（旧桥 pending_friends.json 同款：重启不丢）──
function loadPendingFriends() {
	try {
		if (existsSync(PENDING_FRIENDS_FILE))
			return JSON.parse(readFileSync(PENDING_FRIENDS_FILE, "utf8"));
	} catch {}
	return {};
}
function savePendingFriends(m) {
	try {
		writeFileSync(PENDING_FRIENDS_FILE, JSON.stringify(m, null, 2));
	} catch (e) {
		console.error("[friend] 持久化失败:", e.message);
	}
}

// ── 可调参数（环境变量覆盖）──
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 600000); // agent 无响应超时（10 分钟）
const MSG_MAX_LEN = Number(process.env.MSG_MAX_LEN || 4000); // QQ 单条消息上限（按 5000 保守留余量）
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10); // 非 admin 每分钟消息上限
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 50); // 队列上限，防内存膨胀

// ── 环境变量加载：本目录 .env → WSL 生产 .env（不用 Windows 端配置）──
function loadEnvFile(p) {
	try {
		const lines = readFileSync(p, "utf8").split("\n");
		for (const line of lines) {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
			if (m && !process.env[m[1]])
				process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
		}
	} catch {}
}
for (const p of [join(__dirname, ".env"), "/home/botuser/qq-bot/.env"]) {
	loadEnvFile(p);
}

// 注意：以下常量必须在 loadEnvFile 之后定义（依赖 process.env.ONEBOT_*）
const LLONEBOT_URL = process.env.ONEBOT_URL || "http://127.0.0.1:3001";
const LLONEBOT_TOKEN = process.env.ONEBOT_TOKEN || "";
const BOT_QQ = Number(process.env.BOT_QQ || 0);

// ── 认证：复用 .claude/settings.json（DeepSeek 中转；Windows USERPROFILE 或 WSL HOME）──
try {
	const home =
		process.env.USERPROFILE ||
		process.env.HOME ||
		(process.platform === "win32" ? "" : "/root");
	const settings = JSON.parse(
		readFileSync(join(home, ".claude", "settings.json"), "utf8"),
	);
	// 只注入认证（值来自 claude 自身配置，无害）；
	// 不注入 ANTHROPIC_MODEL——桥调用的是 WSL 的 claude CLI，
	// 模型由其 settings.json 决定（用户已配好 deepseek-v4-pro[1m]）
	if (settings.env?.ANTHROPIC_BASE_URL)
		process.env.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
	if (settings.env?.ANTHROPIC_AUTH_TOKEN)
		process.env.ANTHROPIC_AUTH_TOKEN = settings.env.ANTHROPIC_AUTH_TOKEN;
} catch {}

// Linux/WSL 下 claude-agent-sdk 需要 CLAUDE_CODE_EXECUTABLE：
// 在 Windows 安装的依赖缺 linux-x64 原生二进制，需指向系统 claude CLI
if (!process.env.CLAUDE_CODE_EXECUTABLE && process.platform === "linux") {
	for (const c of [
		"/usr/bin/claude",
		"/usr/local/bin/claude",
		"/root/.local/bin/claude",
		"/home/botuser/.local/bin/claude",
	]) {
		if (existsSync(c)) {
			process.env.CLAUDE_CODE_EXECUTABLE = c;
			break;
		}
	}
}

// ── 三级权限（bridge.js 同款）──
function loadWhitelist() {
	try {
		if (existsSync(WHITELIST_FILE))
			return JSON.parse(readFileSync(WHITELIST_FILE, "utf8"));
	} catch (e) {
		console.error("[acl] 白名单读取失败:", e.message);
	}
	return { admin: [], users: [] };
}
function getUserLevel(userId) {
	const wl = loadWhitelist();
	const id = String(userId);
	if (wl.admin?.includes(id)) return "admin";
	if (wl.users?.includes(id)) return "user";
	return "guest";
}
/** 按级别返回 acpx 工具限制参数（admin 不限制；guest 无工具；user 白名单子集） */
function toolsArgsFor(level) {
	if (level === "admin") return [];
	if (level === "guest") return ["--allowed-tools", ""];
	// user：允许读/搜索类工具，禁写文件/终端/系统
	return ["--allowed-tools", "read,search,grep,glob,bash_read", "--deny-all"];
}

// ── 会话映射：用户/群 → 命名 ACP session ──
const SESSION_FILE = join(__dirname, "acp-sessions.json");
function loadSessions() {
	try {
		if (existsSync(SESSION_FILE)) {
			const m = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
			if (m && typeof m === "object" && !Array.isArray(m)) return m;
		}
	} catch {
		console.error("[session] 映射文件损坏，已重置");
	}
	return {};
}
function saveSessions(map) {
	try {
		writeFileSync(SESSION_FILE, JSON.stringify(map, null, 2));
	} catch (e) {
		console.error("[session] 保存失败:", e.message);
	}
}
const sessionMap = loadSessions();
function sessionNameFor(sessionKey) {
	if (!sessionMap[sessionKey]) {
		sessionMap[sessionKey] =
			`s-${sessionKey.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}-${Date.now().toString(36)}`;
		saveSessions(sessionMap);
	}
	return sessionMap[sessionKey];
}

// ── 消息队列（串行处理，防并发；带上限保护）──
const queue = [];
let processing = false;
function enqueue(task, busyReply) {
	if (queue.length >= MAX_QUEUE) {
		busyReply?.();
		return;
	}
	queue.push(task);
	drain();
}
async function drain() {
	if (processing || !queue.length) return;
	processing = true;
	const task = queue.shift();
	try {
		await task();
	} catch (e) {
		console.error("[queue] 任务异常:", e.message);
	}
	processing = false;
	drain();
}

// ── 防刷限流：非 admin 每分钟上限（滑动窗口，按 用户/群 记）──
const rateHits = new Map(); // key -> [timestamps]
function rateLimited(key) {
	const now = Date.now();
	const hits = (rateHits.get(key) || []).filter((t) => now - t < 60000);
	if (hits.length >= RATE_LIMIT_PER_MIN) {
		rateHits.set(key, hits);
		return true;
	}
	hits.push(now);
	rateHits.set(key, hits);
	return false;
}

// ── 看门狗：心跳 + 失败通知 ──
let lastAgentOk = Date.now();
let consecutiveFails = 0;
function agentSuccess() {
	lastAgentOk = Date.now();
	consecutiveFails = 0;
}
function agentFailure(reason) {
	consecutiveFails++;
	if (consecutiveFails === 1 || consecutiveFails % 5 === 0) {
		notifyAdmin(
			`⚠️ ACP agent 调用失败(${consecutiveFails} 次): ${reason?.slice(0, 80)}`,
		);
	}
}
const HEARTBEAT = setInterval(() => {
	const idle = (Date.now() - lastAgentOk) / 1000;
	if (idle > 300 && consecutiveFails >= 3) {
		notifyAdmin(`⚠️ agent 已 ${Math.round(idle)}s 无成功响应，可能卡死`);
		consecutiveFails = 0;
	}
}, 30000);
HEARTBEAT.unref?.();
async function notifyAdmin(msg) {
	try {
		const adminId = loadWhitelist().admin?.[0];
		if (!adminId) return;
		await sendQqText("private", adminId, msg);
	} catch {}
}

// ── OneBot 发送（私聊/群通用 + 超长分段）──
async function postOneBot(url, body) {
	const res = await fetch(`${LLONEBOT_URL}${url}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${LLONEBOT_TOKEN}`,
		},
		body: JSON.stringify(body),
	});
	return res.json().catch(() => ({}));
}
async function sendQqText(msgType, targetId, text) {
	try {
		const url = msgType === "group" ? "/send_group_msg" : "/send_private_msg";
		const base =
			msgType === "group"
				? { group_id: Number(targetId) }
				: { user_id: Number(targetId) };
		const s = String(text ?? "");
		const sendOne = async (seg, idx) => {
			const j = await postOneBot(url, { ...base, message: seg });
			// LLOneBot 成功 retcode=0；失败也常返回 HTTP200+retcode=200+status=failed
			const ok = j.retcode === 0 || j.status === "ok";
			console.log(
				`[qq→] ${msgType}:${targetId}${idx ? ` [seg${idx}]` : ""} "${seg.slice(0, 40)}" retcode=${j.retcode} status=${j.status} ok=${ok}`,
			);
			return ok;
		};
		if (s.length <= MSG_MAX_LEN) return await sendOne(s, 0);
		let okAll = true;
		let idx = 0;
		for (let i = 0; i < s.length; i += MSG_MAX_LEN) {
			idx++;
			okAll = (await sendOne(s.slice(i, i + MSG_MAX_LEN), idx)) && okAll;
		}
		return okAll;
	} catch (e) {
		console.error("[qq→] 发送失败:", e.message);
		return false;
	}
}
/** 单独发送一张表情图片（base64 很长，不能走 sendQqText 的 4000 字分片）。 */
async function sendSticker(msgType, targetId, cq) {
	try {
		const url = msgType === "group" ? "/send_group_msg" : "/send_private_msg";
		const base =
			msgType === "group"
				? { group_id: Number(targetId) }
				: { user_id: Number(targetId) };
		const j = await postOneBot(url, { ...base, message: cq });
		console.log(`[qq→] ${msgType}:${targetId} [sticker] retcode=${j.retcode} status=${j.status}`);
		return j.retcode === 0 || j.status === "ok";
	} catch (e) {
		console.error("[qq→] 表情发送失败:", e.message);
		return false;
	}
}

// 确保 acpx 持久会话存在（acpx 0.13 对不存在的 session 直接 exit 4 = NO_SESSION）。
function ensureAcpxSession(sessionName) {
	return new Promise((resolve) => {
		const args = [ACPX_CLI, DEFAULT_AGENT, "sessions", "ensure", "--name", sessionName];
		let child;
		try {
			child = spawn(process.execPath, args, {
				cwd: __dirname,
				env: { ...process.env, FORCE_COLOR: "0" },
			});
		} catch {
			resolve(false);
			return;
		}
		let stderr = "";
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", () => resolve(false));
		child.on("close", (code) => {
			if (code !== 0) console.error(`[acp] 会话 ensure 失败(${sessionName}): ${stderr.slice(0, 200)}`);
			resolve(code === 0);
		});
	});
}

// ── 调 acpx 驱动 agent（带会话 + 权限参数 + 超时强杀）──
async function askAgent(prompt, sessionKey, level) {
	const sessionName = sessionNameFor(sessionKey);
	const ensured = await ensureAcpxSession(sessionName);
	if (!ensured) return "(agent 会话创建失败，请稍后重试)";
	return new Promise((resolve) => {
		const tools = toolsArgsFor(level);
		// --allowed-tools / --deny-all 是 acpx 全局选项，必须放在 agent 子命令（claude）之前。
		const args = [
			ACPX_CLI,
			"--format",
			"json",
			...tools,
			DEFAULT_AGENT,
			"-s",
			sessionName,
			// 必须用 prompt（持久会话）而不是 exec（一次性、不保存会话），否则 bot 没有记忆。
			"prompt",
			prompt,
		];
		console.log(
			`[acp] ${sessionKey}(${level}) → ${DEFAULT_AGENT}: "${prompt.slice(0, 40)}..."`,
		);
		// spawn 可能同步 throw（如 EPERM/ENOENT），必须捕获，否则队列任务崩掉
		let child;
		try {
			child = spawn(process.execPath, args, {
				cwd: __dirname,
				env: { ...process.env, FORCE_COLOR: "0" },
			});
		} catch (e) {
			agentFailure(e.message);
			console.error(`[acp] ${sessionKey} 启动失败:`, e.message);
			resolve(`(agent 启动失败: ${e.message})`);
			return;
		}
		let buf = "";
		let reply = "";
		let errText = "";
		let killed = false;
		// 超时保护：agent 卡死时强杀，避免队列永久阻塞
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
			console.error(
				`[acp] ${sessionKey} 超时 ${AGENT_TIMEOUT_MS / 1000}s，已 SIGKILL`,
			);
		}, AGENT_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on("data", (d) => {
			buf += d;
			let idx;
			while ((idx = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					const upd = msg.params?.update?.sessionUpdate;
					// 只收集最终消息，不收集 agent 内部思考（agent_thought_chunk）
					if (upd === "agent_message_chunk") {
						reply += msg.params?.update?.content?.text ?? "";
					}
				} catch {}
			}
		});
		child.stderr.on("data", (d) => {
			errText += d;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const text = reply.trim();
			if (!text) {
				try {
					appendFileSync(
						join(__dirname, "bridge-debug.log"),
						`${new Date().toISOString()} agent-exit code=${code} killed=${killed} err=${JSON.stringify(errText.slice(-500))}\n`,
					);
				} catch {}
			}
			if (text) agentSuccess();
			else agentFailure(errText || `exit ${code}${killed ? " (timeout)" : ""}`);
			console.log(
				`[acp] ← ${sessionKey}: "${text.slice(0, 60).replace(/\n/g, " ")}" (exit ${code}${killed ? ", killed" : ""})`,
			);
			if (text) {
				resolve(text);
				return;
			}
			let failReason = "(agent 无输出";
			if (killed) failReason += "，已超时终止";
			else if (code) failReason += `, exit ${code}`;
			resolve(failReason + ")");
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			try {
				appendFileSync(
					join(__dirname, "bridge-debug.log"),
					`${new Date().toISOString()} agent-spawn-error ${e.message}\n`,
				);
			} catch {}
			agentFailure(e.message);
			resolve(`(agent 启动失败: ${e.message})`);
		});
	});
}

// ── 一次性 agent 调用（不挂会话，用于戳一戳/记忆提取等）──
function askAgentOnce(prompt) {
	return new Promise((resolve) => {
		const args = [ACPX_CLI, "--format", "json", DEFAULT_AGENT, "exec", prompt];
		let child;
		try {
			child = spawn(process.execPath, args, {
				cwd: __dirname,
				env: { ...process.env, FORCE_COLOR: "0" },
			});
		} catch (e) {
			resolve(`(agent 启动失败: ${e.message})`);
			return;
		}
		let buf = "";
		let reply = "";
		let errText = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
		timer.unref?.();
		child.stdout.on("data", (d) => {
			buf += d;
			let idx;
			while ((idx = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					const upd = msg.params?.update?.sessionUpdate;
					if (upd === "agent_message_chunk") {
						reply += msg.params?.update?.content?.text ?? "";
					}
				} catch {}
			}
		});
		child.stderr.on("data", (d) => {
			errText += d;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const text = reply.trim();
			if (text) agentSuccess();
			else
				console.error(`[acp-once] 无输出 exit=${code}:`, errText.slice(0, 120));
			resolve(text || `(agent 无输出${code ? `, exit ${code}` : ""})`);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve(`(agent 启动失败: ${e.message})`);
		});
	});
}

// ── LLOneBot API 轻量调用（健康检查 + 群角色/群上下文用，支持 body）──
async function llonebotGetApi(path, body = {}) {
	const res = await fetch(`${LLONEBOT_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${LLONEBOT_TOKEN}`,
		},
		body: JSON.stringify(body),
	});
	return res.text();
}

// ── 消息处理入口 ──
const pendingFriendRequests = new Map(); // userId -> OneBot flag
const pendingEmptyAt = new Map(); // "group:uid" -> 过期时间；空@后等该发送者下一条消息
const PENDING_EMPTY_AT_TTL = 5 * 60 * 1000; // 空@等待下一条消息的最长时间
let _bridgeJustRestarted = true; // 重启标记：admin 首条消息告知 AI

/** 按空行/句末标点拆分为多条消息：保持短句、自然分段（旧桥 splitMessage 加强版） */
function splitMessage(text) {
	const s = String(text ?? "").trim();
	if (!s) return [];
	const CHUNK_MAX = 160; // 超过这个长度就拆成多条，更像真人聊天
	const paragraphs = s.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
	const chunks = [];
	const push = (part) => {
		const t = String(part).trim();
		if (t) chunks.push(t);
	};
	for (const p of paragraphs) {
		if (p.length <= CHUNK_MAX) {
			push(p);
			continue;
		}
		// 先按句末标点切，避免把一句话硬拆成两半
		let buf = "";
		for (const piece of p.split(/(?<=[。！？!?；;])/)) {
			if ((buf + piece).length <= CHUNK_MAX) {
				buf += piece;
				continue;
			}
			if (buf) {
				push(buf);
				buf = "";
			}
			// 单个句子仍超长时，再按逗号/顿号兜底切
			if (piece.length > CHUNK_MAX) {
				for (const cp of piece.split(/(?<=[，,、])/)) {
					if ((buf + cp).length <= CHUNK_MAX) {
						buf += cp;
					} else {
						if (buf) push(buf);
						buf = cp;
					}
				}
			} else {
				buf = piece;
			}
		}
		if (buf) push(buf);
	}
	return chunks.length > 0 ? chunks : [s];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleMessage(msg) {
	if (msg.message_type !== "private" && msg.message_type !== "group") return;
	let raw = String(msg.raw_message ?? "").trim();
	const isPrivate = msg.message_type === "private";
	let groupExtra = ""; // 群聊身份/上下文提示
	let stickerCutoff = 0; // 收到图片后记录时间，禁止本轮把刚入库的图当表情回发

	// 群消息调试：写入 Windows 可见的 debug 日志，排查 @/命令识别
	if (!isPrivate) {
		try {
			appendFileSync(
				join(__dirname, "bridge-debug.log"),
				`${new Date().toISOString()} group raw=${JSON.stringify(raw)} self=${msg.self_id} bot=${BOT_QQ}\n`,
			);
		} catch {}
	}

	// 群消息：完整过滤（@/名字唤醒/命令/引用 + 过滤机器人/自动欢迎）
	if (!isPrivate) {
		const senderId = String(msg.user_id ?? "");
		const pendingKey = `group:${msg.group_id}:${senderId}`;
		const pendingExpiry = pendingEmptyAt.get(pendingKey);
		if (pendingExpiry && Date.now() > pendingExpiry) pendingEmptyAt.delete(pendingKey);
		const g = shouldHandleGroup(
			raw,
			senderId,
			String(msg.self_id || BOT_QQ),
			BOT_QQ,
		);
		if (!g) {
			// 该发送者刚发过空@：他/她的下一条消息即使没带@也回应
			if (!pendingEmptyAt.has(pendingKey)) return;
			pendingEmptyAt.delete(pendingKey);
			console.log(`[group] 空@后的下一条消息，${senderId} 触发回复`);
		} else {
			raw = g.cleaned;
			// 空@：暂不回复，等该发送者下一条消息
			if (!raw && g.isAtBot) {
				pendingEmptyAt.set(pendingKey, Date.now() + PENDING_EMPTY_AT_TTL);
				console.log(`[group] 收到空@，暂不回复，等待 ${senderId} 下一条消息`);
				return;
			}
			pendingEmptyAt.delete(pendingKey);
		}
		// 群聊身份提示 + 群人格 + 自适应上下文
		const gp = loadGroupPersonas()[String(msg.group_id)];
		const gpNote = gp ? `\n[群人格设定: ${gp}]` : "";
		let groupCtx = "";
		if (!/^[/#]/.test(raw.trim())) {
			groupCtx = await buildGroupContext(raw, msg.group_id, llonebotGetApi);
		}
		groupExtra = `[群聊] 发送者: ${msg.sender?.nickname || msg.user_id}。就像群友聊天一样，自然接话，两三句说完；内容多就分几段发，别一次性甩一大段。别太正经，也别一直喊名字刷存在感。${gpNote}${groupCtx}`;
	} else {
		groupExtra = `[私聊] 对方昵称: ${msg.sender?.nickname || msg.user_id}。像朋友私聊一样，轻松自然，短句为主，能一句话就不说两句；内容多就分几段发，别长篇大论，也别频繁喊对方名字。`;
	}
	// 识图预处理（旧桥 L2112 同款）：图片消息转文字描述，访客无工具也能聊图
	if (/\[CQ:image/.test(raw)) {
		// 自主表情库：后台让模型判断是否值得收藏（不阻塞回复）
		// 先记下当前时间，稍后注入表情库时排除刚收到的这张图，避免原样回发
		stickerCutoff = Date.now();
		saveSticker(raw, String(msg.user_id ?? msg.group_id ?? "?")).catch(() => {});
		const visionResult = await tryVision(raw);
		raw =
			(raw ? raw + "\n\n" : "") +
			(visionResult
				? `[用户发了一张图片，识图结果：${visionResult}]`
				: "[用户发了一张图片，但识图失败了]");
		raw = raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
	}
	if (!raw || raw.startsWith("[CQ:")) return; // 忽略其他 CQ 码纯消息

	const uid = msg.user_id ? String(msg.user_id) : String(msg.group_id);
	const level = getUserLevel(uid);
	const sessionKey = isPrivate
		? `private:${msg.user_id}`
		: `group:${msg.group_id}`;
	const targetType = isPrivate ? "private" : "group";
	const targetId = isPrivate ? msg.user_id : msg.group_id;

	// 防刷限流（admin 不限）
	if (level !== "admin" && rateLimited(uid)) {
		await sendQqText(targetType, targetId, "⏳ 你发消息太快啦，休息一下再试～");
		return;
	}

	// 管理员好友审批回复：「同意 <QQ>」/「拒绝 <QQ>」（亦支持旧桥「同意好友 <QQ>」形式）
	if (isPrivate && level === "admin") {
		const fm =
			raw.match(/^(同意|拒绝)\s*(\d+)$/) ||
			raw.match(/^(同意好友|拒绝好友)\s+(\d+)$/);
		if (fm) {
			const targetQQ = fm[2];
			// 双源查 flag：内存（实时事件）+ pending_friends.json（持久化，重启不丢）
			let flag = pendingFriendRequests.get(targetQQ);
			if (!flag) {
				const pf = loadPendingFriends();
				flag = pf[targetQQ]?.flag;
			}
			if (!flag) {
				await sendQqText("private", targetId, `没有找到 ${targetQQ} 的待处理好友申请`);
				return;
			}
			const approve = /^同意/.test(fm[1]);
			try {
				await (approve
					? approveFriendRequest(flag)
					: rejectFriendRequest(flag));
			} catch (e) {
				console.error("[friend] 处理失败:", e.message);
				await sendQqText("private", targetId, `处理失败：${e.message}`);
				return;
			}
			pendingFriendRequests.delete(targetQQ);
			const pf = loadPendingFriends();
			delete pf[targetQQ];
			savePendingFriends(pf);
			if (approve) {
				// 新好友默认关闭重启通知和思考提示（旧桥 L1433 同款）+ 欢迎消息
				const p = loadPrefs();
				if (!p[targetQQ]) p[targetQQ] = {};
				p[targetQQ].notifyOnRestart = false;
				p[targetQQ].thinkingEnabled = false;
				p[targetQQ].welcomed = true;
				savePrefs(p);
				const welcome = [
					`👋 你好～我是 ${process.env.BOT_NAME || "AI 助手"}，有什么想聊的随时找我～`,
					"",
					"💡 一些提示：",
					"▸ 重启通知已默认关闭，如需开启发「/notify on」",
					"▸ 订阅 B站 UP主：发「b站订阅 UID」",
					"▸ 查看 B站订阅：发「我的订阅」",
					"▸ 设置回答风格：发「/personality set 你的设定」",
					"▸ 说「记住 XX」我会跨会话记住；「30分钟后提醒我XX」定时提醒",
					"▸ 查看全部命令：发「帮助」或「/help」",
					"",
					"有什么想聊的随时找我～ (￣▽￣)",
				].join("\n");
				sendQqText("private", targetQQ, welcome).catch(() => {});
			}
			await sendQqText(
				"private",
				targetId,
				approve ? `✅ 已同意好友申请：${targetQQ}` : `已拒绝好友申请：${targetQQ}`,
			);
			return;
		}
	}

	// 命令分发（harness 审批//hn/记忆/tokenusage/重启/订阅/思考提示/设置）
	const cmdResult = await dispatchCommand({
		raw,
		uid,
		level,
		isPrivate,
		targetType,
		targetId,
		groupId: msg.group_id,
		msgType: msg.message_type,
		userNick: msg.sender?.nickname || "",
		wl: loadWhitelist(),
		sessionMap,
		sendFn: sendQqText,
		apiFn: llonebotGetApi,
		reminders: loadReminders(),
		cancelReminder,
		checkQuota: checkDailyQuota,
		askOnce: askAgentOnce,
		askSession: (p) => askAgent(p, sessionKey, level),
		sessionKey,
		deleteSession: (key) => {
			delete sessionMap[key];
			saveSessions(sessionMap);
		},
	});
	if (cmdResult) {
		await sendQqText(targetType, targetId, cmdResult.reply);
		if (cmdResult.action === "restart") {
			doRestart(); // 延迟自启新进程后退出（看门狗兜底）
		}
		return;
	}

	// 帮助
	if (/^(帮助|help|菜单|命令|commands)$/i.test(raw)) {
		let r = "可用命令（加 / 前缀也可）\n\n";
		r += "📺 B站订阅\n";
		r += "  订阅B站 <UID> — 订阅 UP 主（别名: b站订阅 / subbili）\n";
		r += "  订阅列表 / 我的订阅 — 查看已订阅\n";
		r += "  取消订阅B站 <UID> — 退订\n\n";
		r += "🎭 人格\n";
		r += "  群人格 <描述> — 群主设置群专属人格\n";
		r += "  总结群聊 [条数] — 总结最近群消息\n";
		r += "  存档 / 读档 / 存档列表 — 个人人格管理\n";
		r += "  /personality set <内容> — 自定义回答风格\n\n";
		r += "⚙️ 设置\n";
		r += "  /notify on/off — 重启通知\n";
		r += "  /tokenusage — 查看用量\n";
		r += "  开启/关闭 思考提示\n\n";
		r += "🧠 记忆与提醒\n";
		r += "  记住 <内容> — 写入长期记忆（跨会话不忘）\n";
		r += "  我的记忆 / 忘记 <关键词> / 忘记全部\n";
		r += "  30分钟后提醒我<事> / 明天8点提醒我<事>\n";
		r += "  提醒列表 / 取消提醒 #编号\n\n";
		r += "📋 其他\n";
		r += "  发图 — 自动识图\n";
		r += "  反馈 <内容> — 建议/问题\n";
		r += "  公告 — 历史公告\n";
		r += "  群里 @我 就能唤醒我（配了 WAKE_WORDS 时喊名字也行），不用其他操作\n";
		r += "  /new — 新对话（自动把要点存进长期记忆）\n";
		r += "  /new! — 干净重开，不写长期记忆\n";
		if (level === "admin" && isPrivate) {
			r += "\n🔐 管理员（仅私聊可见）\n";
			r += "  /重启 — 重启 bridge\n";
			r += "  同意好友 <QQ> / 拒绝好友 <QQ> — 处理好友申请\n";
			r += "  发公告 <内容> — 群发公告\n";
		}
		await sendQqText(targetType, targetId, r);
		return;
	}

	// 额度查询（不计数）
	if (/^(额度|配额|quota)$/i.test(raw)) {
		if (level === "admin") {
			await sendQqText(targetType, targetId, "你是管理员，不限额。");
		} else {
			const info = getQuotaInfo(uid, level);
			await sendQqText(
				targetType,
				targetId,
				`📊 今日额度：${info.used}/${info.limit}`,
			);
		}
		return;
	}

	// 定时提醒（仅 admin/user）
	if (level !== "guest" && /提醒/.test(raw)) {
		const parsed = parseReminder(raw);
		if (parsed) {
			const r = createReminder(parsed, targetType, targetId);
			scheduleReminder(r, (mt, tid, text) => sendQqText(mt, tid, text));
			const when = new Date(r.time).toLocaleString("zh-CN", { hour12: false });
			await sendQqText(
				targetType,
				targetId,
				`⏰ 已设定提醒：${r.text}\n时间：${when}`,
			);
			return;
		}
	}

	// 每日限额（admin 不限）
	const quota = checkDailyQuota(uid, level);
	if (!quota.ok) {
		await sendQqText(
			targetType,
			targetId,
			`🚫 今日对话次数已达上限（${quota.used}/${quota.limit}），明天再来吧～`,
		);
		return;
	}

	// 新用户首条消息欢迎（保底：当好友审批通知没触发时，旧桥 L2088 同款）
	if (isPrivate && level !== "admin") {
		const prefsNow = loadPrefs();
		if (!prefsNow[uid]?.welcomed) {
			if (!prefsNow[uid]) prefsNow[uid] = {};
			prefsNow[uid].notifyOnRestart = false;
			prefsNow[uid].thinkingEnabled = false;
			prefsNow[uid].welcomed = true;
			savePrefs(prefsNow);
			const welcome = [
				`👋 你好～我是 ${process.env.BOT_NAME || "AI 助手"}，有什么想聊的随时找我～`,
				"",
				"💡 一些提示：",
				"▸ 重启通知已默认关闭，如需开启发「/notify on」",
				"▸ 订阅 B站 UP主：发「b站订阅 UID」",
				"▸ 查看 B站订阅：发「我的订阅」",
				"▸ 设置回答风格：发「/personality set 你的设定」",
				"▸ 说「记住 XX」我会跨会话记住；「30分钟后提醒我XX」定时提醒",
				"▸ 查看全部命令：发「帮助」或「/help」",
				"",
				"有什么想聊的随时找我～ (￣▽￣)",
			].join("\n");
			await sendQqText(targetType, targetId, welcome);
			return;
		}
	}

	// 思考中提示（旧桥 L2082 同款：仅当用户开启 + 消息判定为需要长思考）
	const prefsNow = loadPrefs()[uid] || {};
	if (prefsNow.thinkingEnabled === true && needsThinkingIndicator(raw)) {
		const personaReplies = loadUserPrompts()[uid]?.thinking_replies || [];
		const thinkingMsg = pickThinkingReply(
			raw,
			prefsNow.customReplies,
			prefsNow.customMode,
			personaReplies,
		);
		if (thinkingMsg) await sendQqText(targetType, targetId, thinkingMsg).catch(() => {});
	}

	// 人格注入（按级别）+ 旧桥记忆 + 时间注入 + 调 agent
	const legacy = loadLegacyContext(uid);
	const timeNoteText = timeNote(raw);
	// 重启标记：bridge 刚重启后 admin 第一条消息告知 AI
	let rawForAgent = raw;
	if (_bridgeJustRestarted && level === "admin") {
		_bridgeJustRestarted = false;
		rawForAgent = "[通知: bridge 刚刚重启完成]\n\n" + raw;
	}
	// 注入上下文：用户自定义设定 + 时间/提醒规则 + 旧桥记忆 + 群聊(或私聊)身份提示
	const userPrompt = getUserPrompt(uid);
	const extra = [
		userPrompt ? `[用户自定义设定: ${userPrompt}]` : "",
		timeNoteText,
		legacy,
		groupExtra,
		stickerLibraryContext(stickerCutoff),
	]
		.filter(Boolean)
		.join("\n");
	const prompt = buildPrompt(rawForAgent, level, extra);
	logChat(uid, msg.sender?.nickname || "?", "in", raw);
	const reply = await askAgent(prompt, sessionKey, level);
	logChat(uid, msg.sender?.nickname || "?", "out", reply);
	logTokenUsage(uid, null, raw.length, reply.length);
	// 摘出 [STICKER:id]，文字和表情分开发送（表情 base64 很长不能分片）
	const { text: replyText, stickers } = extractStickers(reply);
	// 分条发送（旧桥 L2228 同款）：按空行分段，每段一条消息，段间 800ms；群聊首条带引用防串话
	const chunks = splitMessage(replyText);
	for (let i = 0; i < chunks.length; i++) {
		const prefix =
			i === 0 && !isPrivate && msg.message_id
				? `[CQ:reply,id=${msg.message_id}]`
				: "";
		await sendQqText(targetType, targetId, prefix + chunks[i]);
		if (chunks.length > 1 && i < chunks.length - 1) await sleep(800);
	}
	for (const cq of stickers) {
		await sleep(300);
		await sendSticker(targetType, targetId, cq);
	}
}

// ── 事件处理（好友申请等）──
async function handleEvent(ev) {
	if (ev.post_type !== "request" || ev.request_type !== "friend") return;
	const userId = String(ev.user_id ?? "");
	if (!userId) return;
	pendingFriendRequests.set(userId, String(ev.flag ?? ""));
	// 持久化到 pending_friends.json（重启不丢，支持「同意好友 <QQ>」文件形式审批）
	const pf = loadPendingFriends();
	pf[userId] = { flag: String(ev.flag ?? ""), time: Date.now() };
	savePendingFriends(pf);
	const adminId = loadWhitelist().admin?.[0];
	if (!adminId) return;
	const comment = ev.comment ? `（备注：${ev.comment}）` : "";
	await sendQqText(
		"private",
		adminId,
		`👋 好友申请：QQ ${userId}${comment}\n回复「同意 ${userId}」或「拒绝 ${userId}」处理`,
	);
}

// ── HTTP 服务：OneBot 上报 + harness 插件接口（/send /health /restart /announce）──
function jsonRes(res, obj, code = 200) {
	res.writeHead(code, { "Content-Type": "application/json" });
	res.end(JSON.stringify(obj));
}
async function readBody(req) {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body;
}
/** 重启：拉起新进程后退出（QQ /重启 与 HTTP /restart 共用） */
function doRestart() {
	setTimeout(() => {
		try {
			const child = spawn(process.execPath, [process.argv[1]], {
				cwd: __dirname,
				detached: true,
				stdio: "ignore",
				env: { ...process.env },
			});
			child.unref();
		} catch (e) {
			console.error("[restart] 自启失败:", e.message);
		}
		process.exit(0);
	}, 1500);
}
/** 通知可收重启消息的用户（admin 必收 + 显式开启者） */
async function notifyRestartUsers(msg) {
	try {
		const prefs = loadPrefs();
		const wl = loadWhitelist();
		const adminSet = new Set((wl.admin || []).map(String));
		const uids = new Set();
		for (const k of Object.keys(sessionMap)) {
			if (!k.startsWith("group:")) uids.add(k.includes(":") ? k.split(":")[1] : k);
		}
		for (const u of [...(wl.admin || []), ...(wl.users || [])]) uids.add(String(u));
		for (const u of uids) {
			if (!adminSet.has(u) && prefs[u]?.notifyOnRestart !== true) continue;
			sendQqText("private", u, msg).catch(() => {});
		}
	} catch {}
}
/** HTTP 公告落档（与 misc.mjs 同目录结构） */
function logAnnouncementHttp(recipients, content) {
	try {
		const dir = join(
			ANNOUNCE_DIR,
			new Date().toISOString().slice(0, 13).replace("T", "-"),
		);
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "announcement.jsonl"),
			JSON.stringify({ time: new Date().toISOString(), targets: recipients, content }) + "\n",
			"utf-8",
		);
	} catch (e) {
		console.error("[announce] 记录失败:", e.message);
	}
}

const server = createServer(async (req, res) => {
	const url = (req.url || "").split("?")[0];
	try {
		// OneBot11 上报（LLOneBot 消息 + 请求事件同端点）
		if (req.method === "POST" && url === "/message") {
			const ev = JSON.parse(await readBody(req));
			if (ev.post_type === "request") {
				enqueue(() => handleEvent(ev));
			} else if (
				ev.post_type === "notice" &&
				ev.notice_type === "notify" &&
				ev.sub_type === "poke"
			) {
				if (String(ev.target_id) === String(BOT_QQ)) {
					enqueue(() =>
						handlePoke(ev, askAgentOnce, (t, id, text) =>
							sendQqText(t, id, text),
						),
					);
				}
			} else if (ev.post_type === "message" && Number(ev.user_id) !== BOT_QQ) {
				enqueue(
					() => handleMessage(ev),
					() => {
						if (ev.user_id)
							sendQqText("private", ev.user_id, "⏳ 消息太多啦，稍后再试～");
					},
				);
			}
			return jsonRes(res, { ok: true });
		}

		// harness 插件主动发 QQ（dsh-qq-notify 的 bridgeUrl → POST {user_id, message}）
		if (req.method === "POST" && url === "/send") {
			const { user_id, group_id, message } = JSON.parse(await readBody(req));
			if (!message) return jsonRes(res, { status: "error", error: "缺少 message" });
			const type = group_id ? "group" : "private";
			const targetId = group_id || user_id;
			if (!targetId)
				return jsonRes(res, { status: "error", error: "缺少 user_id 或 group_id" });
			const ok = await sendQqText(type, targetId, message);
			return jsonRes(res, ok ? { status: "sent" } : { status: "error", error: "发送失败" });
		}

		// 健康检查
		if (req.method === "GET" && url === "/health") {
			return jsonRes(res, {
				status: "ok",
				queueLength: queue.length,
				processing,
				sessions: Object.keys(sessionMap).length,
				uptime: process.uptime(),
			});
		}

		// 重启（HTTP 通道：通知订阅用户 + 拉起新进程）
		if (req.method === "POST" && url === "/restart") {
			jsonRes(res, { status: "restarting" });
			notifyRestartUsers("bot 即将重启，稍后回来~");
			doRestart();
			return;
		}

		// 公告（HTTP 通道：不经确认，自动加 footer；旧桥 L2593 同款）
		if (req.method === "POST" && url === "/announce") {
			let { user_ids, group_ids, message, send_all } = JSON.parse(await readBody(req));
			if (!message) return jsonRes(res, { status: "error", error: "缺少 message" });
			const footer =
				"\n\n💡 想看历史公告？发「公告」即可查看\n💡 有建议或问题？发「反馈 + 内容」告诉我\n💡 不知道命令怎么用？发「/help」查看所有可用命令";
			const fullMsg = message + footer;
			const targets = [];
			if (send_all) {
				const wl = loadWhitelist();
				const adminId = wl.admin?.[0];
				user_ids = Object.keys(sessionMap)
					.filter((k) => !k.startsWith("group:"))
					.map((k) => (k.includes(":") ? k.split(":")[1] : k))
					.filter((u) => u !== adminId);
			}
			if (Array.isArray(user_ids))
				for (const uid of user_ids) targets.push(() => sendQqText("private", uid, fullMsg));
			if (Array.isArray(group_ids))
				for (const gid of group_ids) targets.push(() => sendQqText("group", gid, fullMsg));
			if (targets.length === 0)
				return jsonRes(res, { status: "error", error: "缺少 user_ids 或 group_ids" });
			const allRecipients = [...(user_ids || []), ...(group_ids || []).map((g) => `group:${g}`)];
			logAnnouncementHttp(allRecipients, fullMsg);
			await Promise.all(targets.map((t) => t().catch(() => {})));
			return jsonRes(res, { status: "sent", recipients: allRecipients.length });
		}

		res.writeHead(404).end("not found");
	} catch (e) {
		jsonRes(res, { ok: false, error: e.message }, 500);
	}
});

// ── 崩溃诊断探针：任何未捕获异常/拒绝都打出原因，不静默消失 ──
process.on("unhandledRejection", (e) => {
	console.error("[FATAL] unhandledRejection:", e?.stack || e);
	setTimeout(() => process.exit(1), 100);
});
process.on("uncaughtException", (e) => {
	console.error("[FATAL] uncaughtException:", e?.stack || e);
	setTimeout(() => process.exit(1), 100);
});
process.on("exit", (code) => {
	console.log(`[bridge-acp] 进程退出 code=${code}`);
});

// ── 优雅退出 ──
process.on("SIGINT", () => {
	console.log("\n[bridge-acp] 退出");
	process.exit(0);
});
process.on("SIGTERM", () => {
	console.log("[bridge-acp] 终止");
	process.exit(0);
});

server.listen(PORT, () => {
	console.log(`✅ ACP 安全版桥启动: :${PORT}`);
	console.log(`   agent=${DEFAULT_AGENT}  LLOneBot=${LLONEBOT_URL}`);
	const wl = loadWhitelist();
	console.log(
		`   权限: admin=${wl.admin?.join(",") || "(无)"}  users=${wl.users?.join(",") || "(无)"}  guest=纯对话`,
	);
	console.log(`   会话: ${Object.keys(sessionMap).length} 个已持久化`);
	console.log(
		`   防护: agent超时${AGENT_TIMEOUT_MS / 1000}s / 限流${RATE_LIMIT_PER_MIN}条·分 / 队列≤${MAX_QUEUE} / 单条≤${MSG_MAX_LEN}字`,
	);
	// 恢复持久化提醒（修复重启丢提醒）
	restoreReminders((mt, tid, text) => sendQqText(mt, tid, text));
	console.log(`   提醒: 已重挂持久化提醒`);
	// LLOneBot 健康检查（30s 心跳 + 掉线通知 admin）
	createHealthMonitor(
		llonebotGetApi,
		(t, id, text) => sendQqText(t, id, text),
		(m) => console.error(m),
	);
	console.log(`   健康检查: 30s 心跳已启动`);

	// 重启通知：默认关闭迁移 + 通知订阅用户「启动好啦！」（旧桥 L2810 同款）
	// 语义：admin 必收；普通用户仅 /notify on 显式开启者收；群聊永不通知
	applyNotifyDefaultOff();
	try {
		const prefsAtStartup = loadPrefs();
		const adminSet = new Set((wl.admin || []).map(String));
		const notifyUids = new Set();
		for (const k of Object.keys(sessionMap)) {
			if (!k.startsWith("group:")) notifyUids.add(k.includes(":") ? k.split(":")[1] : k);
		}
		for (const u of [...(wl.admin || []), ...(wl.users || [])]) notifyUids.add(String(u));
		let notified = 0;
		for (const u of notifyUids) {
			const isAdmin = adminSet.has(u);
			if (!isAdmin && prefsAtStartup[u]?.notifyOnRestart !== true) continue;
			sendQqText("private", u, "启动好啦！").catch(() => {});
			notified++;
		}
		console.log(`[notify] 启动通知已发 ${notified} 人（admin 必收，其余仅显式开启者）`);
	} catch (e) {
		console.error("[startup] 通知失败:", e.message);
	}

	// ── 批次 3 定时任务 ──
	const adminId = wl.admin?.[0];
	// 每日自检：启动 15s 先跑一次 + 每天 04:00
	setTimeout(() => runDailySelfCheck(sendQqText, adminId), 15000);
	setTimeout(() => {
		runDailySelfCheck(sendQqText, adminId);
		setInterval(() => runDailySelfCheck(sendQqText, adminId), 24 * 60 * 60 * 1000);
	}, msUntilHour(4));
	console.log(`   自检: 启动 15s 一次 + 每日 04:00`);
	// 每日反馈汇总（9:00 发管理员）
	setTimeout(() => {
		sendDailyFeedbackSummary(sendQqText, adminId);
		setInterval(() => sendDailyFeedbackSummary(sendQqText, adminId), 24 * 60 * 60 * 1000);
	}, msUntilHour(9));
	console.log(`   反馈汇总: 每日 09:00`);
	// B站订阅检查（每 5 分钟 + 启动即查）
	checkAndNotifyBilibili(sendQqText, adminId);
	setInterval(() => checkAndNotifyBilibili(sendQqText, adminId), 5 * 60 * 1000);
	console.log(`   B站订阅: 5 分钟轮询`);
});
