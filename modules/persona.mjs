/**
 * persona.mjs — 人设存读档（pm.js）+ 自定义提示词（user_prompts.json）
 *
 * 数据文件（全在 WSL 侧 QQBOT_DIR，默认 /home/botuser/qq-bot）：
 *   - scripts/pm.js            存读档脚本（旧桥既有，复用不重写）
 *   - prompt-profiles/<uid>/   存档目录（persona.md + context.md）
 *   - user_prompts.json        /prompt set/save/load/clear 自定义提示词
 *
 * 命令：存档 / 读档 / 存档列表（自然语言）；prompt-save/load/list/delete；
 *       /prompt(set|save|load|clear|view) 与 /personality 别名
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getPersona } from "../features.mjs";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
const USER_PROMPTS_FILE = join(DATA_ROOT, "user_prompts.json");
const LOG_DIR = join(DATA_ROOT, ".chat-logs");
// pm.js / prompt-profiles 挂 CLAUDE_CWD 下（.env 配置：/mnt/d/Claude）。
// 懒解析：.env 由桥在启动时加载，模块加载阶段读不到，故在调用时再拼路径。
function claudeCwd() {
	return process.env.CLAUDE_CWD || DATA_ROOT;
}

// 与旧桥 L112 同款：防人设漂移的身份提示（存档 payload 复用；人格名称走 BOT_NAME）
const identityHint =
	`[身份: 你是${process.env.BOT_NAME || "AI 助手"}，QQ 机器人后端。保持设定的人格与语气，善用颜文字。你不是群吉祥物、Q群管家或自动回复机。]\n[格式: QQ 不支持 Markdown。禁止使用 **、__、## 等 Markdown 语法。加粗用【】或换行强调替代。表情用颜文字(￣▽￣)而非emoji短代码。]`;

// ── user_prompts.json（/prompt set/save/load/clear）──
export function loadUserPrompts() {
	try {
		return JSON.parse(readFileSync(USER_PROMPTS_FILE, "utf8"));
	} catch {
		return {};
	}
}
export function saveUserPrompts(d) {
	try {
		writeFileSync(USER_PROMPTS_FILE, JSON.stringify(d, null, 2));
	} catch (e) {
		console.error("[prompt] 保存失败:", e.message);
	}
}
export function getUserPrompt(uid) {
	return loadUserPrompts()[uid]?.current || "";
}

// ── 执行 pm.js 存档管理脚本（按用户隔离；stdin 传 payload）──
export function execPmScript(args, userId, stdinData) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(process.execPath, [join(claudeCwd(), "scripts", "pm.js"), userId || "default", ...args], {
				timeout: 10000,
			});
		} catch (e) {
			resolve(`错误: 无法执行存档脚本 (${e.message})`);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("close", (code) => {
			resolve(code === 0 ? stdout.trim() : `错误: ${stderr.trim() || "执行失败"}`);
		});
		child.on("error", () => resolve("错误: 无法执行存档脚本"));
		if (stdinData) child.stdin.write(stdinData);
		child.stdin.end();
	});
}

// ── 构造存档 payload：persona + 身份提示 + 用户自定义设定 +（可选）最近对话上下文 ──
export function buildSavePayload(userId, withContext) {
	const personaBase = getPersona() || "";
	const userPrompt = getUserPrompt(userId) || "";
	const parts = [personaBase, identityHint];
	if (userPrompt) parts.push(`[用户自定义设定: ${userPrompt}]`);
	const personaText = parts.join("\n\n");
	if (!withContext) return personaText;
	// 读取该用户最近对话记录作为 context（.chat-logs/UTC小时/<uid>.jsonl）
	let ctx = "";
	try {
		if (existsSync(LOG_DIR)) {
			const dirs = readdirSync(LOG_DIR)
				.filter((d) => /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(d))
				.sort()
				.reverse();
			const recent = [];
			for (const d of dirs) {
				const f = join(LOG_DIR, d, `${userId}.jsonl`);
				if (!existsSync(f)) continue;
				const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
				for (const l of lines) {
					try {
						const o = JSON.parse(l);
						recent.push(`${o.dir === "in" ? "用户" : "助手"}: ${(o.text || "").slice(0, 200)}`);
					} catch {}
				}
				if (recent.length >= 30) break;
			}
			ctx = recent.slice(-30).join("\n");
		}
	} catch (e) {
		console.error("[pm] 读取对话上下文失败:", e.message);
	}
	return personaText + "\n---CONTEXT---\n" + ctx;
}

// ── 待确认上下文存档：uid -> { name }；待选存档名：uid -> { time } ──
const pendingProfileSave = new Map();
const pendingProfileLoad = new Map();

/**
 * 人设命令分发（私聊）。返回 { reply } 或 null。
 * ctx: { raw, uid, isPrivate, askOnce, askSession, deleteSession, sessionKey }
 */
export async function handlePersonaCommand(raw, ctx) {
	const t = String(raw || "").trim();
	if (!t || !ctx.isPrivate) return null;

	// 0. 待选存档名拦截：上一条「读档」列出存档后，用户直接回复存档名
	if (pendingProfileLoad.has(ctx.uid)) {
		const pend = pendingProfileLoad.get(ctx.uid);
		if (Date.now() - pend.time > 60000) {
			pendingProfileLoad.delete(ctx.uid);
			// 超时提醒：仅当本条像存档名（单 token）才提示，避免打扰正常聊天
			if (!/^[/#]/.test(t) && !/\s/.test(t) && t.length <= 30) {
				return {
					reply: "⏰ 刚才的读档选择已超时（60 秒）。需要读档请重新发送「读档」或「读档 <名称>」。",
				};
			}
		} else if (/^[/#]/.test(t) || /\s/.test(t) || t.length > 30) {
			// 命令或不像存档名（含空格/超长）：放行给后续命令/对话
		} else {
			pendingProfileLoad.delete(ctx.uid);
			const r = await execPmScript(["load", t], ctx.uid);
			// 存档不存在（错误开头）→ 放行给对话，避免拦截正常聊天
			if (!/^错误/.test(r)) {
				return { reply: `📦 已读档\n${r}` };
			}
		}
	}

	// 1. 待确认上下文存档（用户刚发起存档，正在确认是否带上下文；120 秒超时）
	if (pendingProfileSave.has(ctx.uid)) {
		const pending = pendingProfileSave.get(ctx.uid);
		if (Date.now() - pending.time > 120000) {
			pendingProfileSave.delete(ctx.uid);
			if (/^(y|yes|确认|是|要)$/i.test(t)) {
				return {
					reply: `⏰ 存档「${pending.name}」的确认已超时（120 秒）。需要存档请重新发送「存档 ${pending.name}」。`,
				};
			}
			// 非确认回复：放行给后续逻辑
		} else {
			pendingProfileSave.delete(ctx.uid);
			const withCtx = /^(y|yes|确认|是|要)$/i.test(t);
			const payload = buildSavePayload(ctx.uid, withCtx);
			const r = await execPmScript(
				["save", pending.name, ...(withCtx ? ["--context"] : [])],
				ctx.uid,
				payload,
			);
			return {
				reply: (withCtx ? "📦 已存档（含上下文）\n" : "📦 已存档（仅人设）\n") + r,
			};
		}
	}

	// 2. 自然语言：存档 / 读档 / 列表 / 删除（容忍前导 / 或 #，如「/存档列表」「/读档」）
	const NL_SAVE =
		/^[/#]?(?:存档|保存人设|保存当前人设|保存人格|保存设定|存一下|save profile)(?:\s+(.+))?$/i;
	const NL_LOAD =
		/^[/#]?(?:读档|读取存档|载入存档|恢复人设|加载人设|加载人格|切换人格|load profile)(?:\s+(.+))?$/i;
	const NL_LIST =
		/^[/#]?(?:存档列表|我的存档列表|查看存档列表|看看我的存档|存档都有啥|有什么存档|list profiles|人格卡|我的存档|输出存档|列出存档|查看存档|所有人格卡|全部人格卡|人格列表)$/i;
	const NL_DELETE = /^[/#]?(?:删除存档|删存档|取消存档)\s+(.+)$/i;

	const nlSave = t.match(NL_SAVE);
	if (nlSave) {
		const name = nlSave[1] || `存档_${Date.now()}`;
		pendingProfileSave.set(ctx.uid, { name, time: Date.now() });
		return {
			reply: `📦 存档名称: ${name}\n是否同时保存对话上下文？回复 y 确认，回复其他则仅保存人设。`,
		};
	}
	const nlLoad = t.match(NL_LOAD);
	if (nlLoad) {
		const name = nlLoad[1];
		if (!name) {
			pendingProfileLoad.set(ctx.uid, { time: Date.now() });
			const r = await execPmScript(["list"], ctx.uid);
			return {
				reply: `📦 请选择要读档的名称:\n${r}\n用法: 读档 <名称>（60 秒内直接回复存档名即可）`,
			};
		}
		pendingProfileLoad.delete(ctx.uid);
		const r = await execPmScript(["load", name], ctx.uid);
		return { reply: `📦 已读档\n${r}` };
	}
	if (NL_LIST.test(t)) {
		const r = await execPmScript(["list"], ctx.uid);
		return { reply: r };
	}
	const nlDelete = t.match(NL_DELETE);
	if (nlDelete) {
		const r = await execPmScript(["delete", nlDelete[1].trim()], ctx.uid);
		return { reply: `🗑️ 删除存档\n${r}` };
	}

	// 3. Prompt Manager 命令 prompt-save/load/list/delete（容忍前导 /）
	const pmMatch = t.match(/^[/#]?(?:调用\s+|执行\s+)?prompt-(save|load|list|delete)(?:\s+(\S+))?(?:\s+--context)?(?:\s+.*)?$/);
	if (pmMatch) {
		const action = pmMatch[1];
		const name = pmMatch[2];
		const hasContext = /\s+--context\b/.test(t);
		let result;
		switch (action) {
			case "list":
				result = await execPmScript(["list"], ctx.uid);
				break;
			case "save":
				if (!name) return { reply: "用法: prompt-save <名称> [--context]" };
				result = await execPmScript(
					["save", name, ...(hasContext ? ["--context"] : [])],
					ctx.uid,
					buildSavePayload(ctx.uid, hasContext),
				);
				break;
			case "load":
				if (!name) return { reply: "用法: prompt-load <名称> [--context]" };
				result = await execPmScript(["load", name, ...(hasContext ? ["--context"] : [])], ctx.uid);
				break;
			case "delete":
				if (!name) return { reply: "用法: prompt-delete <名称>" };
				result = await execPmScript(["delete", name], ctx.uid);
				break;
		}
		return { reply: "📦 Prompt Manager\n" + result };
	}

	// 4. /prompt set/save/load/clear/view + /personality 别名（user_prompts.json）
	const data = loadUserPrompts();
	if (!data[ctx.uid]) data[ctx.uid] = { current: "", presets: [], thinking_replies: [] };
	const p = data[ctx.uid];

	// 4a. /prompt help
	if (/^\/(?:prompt|personality)\s+help$/.test(t)) {
		return {
			reply:
				"📝 /personality 自定义人设提示词\n\n" +
				"/personality set <内容> — 设置回答风格\n" +
				"/personality summarize — 根据对话自动总结人设\n" +
				"/personality view — 查看当前人设\n" +
				"/personality save <1|2|3> — 存入预设\n" +
				"/personality load <1|2|3> — 加载预设\n" +
				"/personality clear — 清除人设\n" +
				"/personality list — 查看所有预设\n\n" +
				"设置后我会在对话中遵循你的设定来回应~",
		};
	}

	// 4b. /prompt summarize — 根据当前对话自动总结并保存人设（计额度）
	if (/^\/(?:prompt|personality)\s+summarize$/.test(t)) {
		const quota = ctx.checkQuota
			? ctx.checkQuota(ctx.uid, ctx.level)
			: { ok: true };
		if (!quota.ok)
			return { reply: `今日对话额度已用完（${quota.limit} 次），明天再来吧～` };
		ctx.sendFn?.(ctx.targetType, ctx.targetId, "让我回顾一下我们的对话，总结你对我的期望……").catch(() => {});
		const rawSummary = ctx.askSession
			? await ctx
					.askSession(
						"请根据当前对话历史，总结我对你的行为风格、语气、回答方式等方面的期望和设定。\n" +
							"输出一段简洁的人设描述，要求：\n" +
							"1. 从第一人称角度写（'我'）\n" +
							"2. 突出核心特征\n" +
							"3. 50字以内\n" +
							"4. 直接输出描述，不要多余的解释",
					)
					.catch(() => "")
			: "";
		const summary = String(rawSummary || "").trim().replace(/^["']|["']$/g, "");
		if (summary && summary.length > 5) {
			p.current = summary;
			saveUserPrompts(data);
			return { reply: `已根据对话总结并保存人设：\n「${summary}」` };
		}
		return {
			reply: "没总结出有效的人设描述，你可以先用 /personality set 手动设置试试",
		};
	}

	const setCmd = t.match(/^\/(?:prompt|personality)\s+set\s+(.+)/);
	if (setCmd) {
		p.current = setCmd[1].trim();
		saveUserPrompts(data);
		return { reply: `已设置自定义提示词。你可以在对话中体验效果~\n当前：${p.current}` };
	}
	const saveCmd = t.match(/^\/(?:prompt|personality)\s+save\s+([123])/);
	if (saveCmd) {
		const slot = parseInt(saveCmd[1], 10) - 1;
		if (!p.current) return { reply: "当前没有提示词可保存，先用 /prompt set 设置内容" };
		p.presets[slot] = p.current;
		saveUserPrompts(data);
		return { reply: `已保存到预设 ${saveCmd[1]}：「${p.current}」` };
	}
	const loadCmd = t.match(/^\/(?:prompt|personality)\s+load\s+([123])/);
	if (loadCmd) {
		const slot = parseInt(loadCmd[1], 10) - 1;
		if (!p.presets[slot]) {
			p.current = "";
			saveUserPrompts(data);
			ctx.deleteSession?.(ctx.sessionKey);
			return { reply: `预设 ${loadCmd[1]} 是空的，已切换回默认人格并重置对话～` };
		}
		p.current = p.presets[slot];
		saveUserPrompts(data);
		return { reply: `已加载预设 ${loadCmd[1]}：「${p.current}」` };
	}
	if (/^\/(?:prompt|personality)(\s+(list|view))?$/.test(t)) {
		let r = "📝 自定义提示词\n\n";
		r += `当前：${p.current || "未设置"}\n\n`;
		r += "预设槽位：\n";
		for (let i = 0; i < 3; i++) {
			r += `  ${i + 1}. ${p.presets[i] || "空"}${p.presets[i] ? `（/prompt load ${i + 1} 切换）` : ""}\n`;
		}
		if (p.thinking_replies?.length) r += `\n🧠 人设思考提示：${p.thinking_replies.length} 条已启用\n`;
		r += "\n命令：\n  /prompt set <内容> — 设置\n  /prompt save <1|2|3> — 存入预设\n  /prompt load <1|2|3> — 加载预设\n  /prompt clear — 清除\n  （/personality 是 /prompt 的别名）";
		return { reply: r };
	}
	if (/^\/(?:prompt|personality)\s+clear$/.test(t)) {
		p.current = "";
		p.thinking_replies = [];
		saveUserPrompts(data);
		ctx.deleteSession?.(ctx.sessionKey);
		return { reply: "已清除自定义人格，切换回默认人格并重置对话～" };
	}

	return null;
}
