/**
 * stickers.mjs — 自主表情库
 * 收到图片时自动保存，并让 DeepSeek 视觉模型打标签、判断是否值得入库；
 * 对话时把表情库注入 agent，允许它在回复中追加 [STICKER:<id>] 发表情。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeCqImgUrl, detectImageMime } from "./image-util.mjs";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
const STICKER_DIR = join(DATA_ROOT, "sticker_library");
const INDEX_FILE = join(STICKER_DIR, "index.json");
const MAX_CONTEXT_STICKERS = 30;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function loadIndex() {
	try {
		return JSON.parse(readFileSync(INDEX_FILE, "utf8"));
	} catch {
		return [];
	}
}

function saveIndex(entries) {
	try {
		writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
	} catch {}
}

function openAiBase() {
	const raw = process.env.DEEPSEEK_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com";
	return raw
		.replace(/\/anthropic\/?$/, "")
		.replace(/\/v1\/?$/, "")
		.replace(/\/?$/, "");
}

function extractImgUrl(raw) {
	const m = String(raw || "").match(/\[CQ:image[^\]]*url=([^\],]+)/);
	return m ? decodeCqImgUrl(m[1]) : null;
}

async function downloadImage(url) {
	const res = await fetch(url, {
		headers: {
			"user-agent": "Mozilla/5.0",
			referer: "https://qun.qq.com/",
		},
		signal: AbortSignal.timeout(30000),
	});
	if (!res.ok) throw new Error(`download ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) throw new Error(`bad size ${buf.length}`);
	// 按魔数识别真实格式，不信任 CDN 的 content-type
	const mime = detectImageMime(buf) || res.headers.get("content-type") || "image/jpeg";
	return { buf, mime };
}

function extForMime(mime) {
	const map = {
		"image/jpeg": ".jpg",
		"image/jpg": ".jpg",
		"image/png": ".png",
		"image/gif": ".gif",
		"image/webp": ".webp",
	};
	return map[mime.split(";")[0].toLowerCase()] || ".jpg";
}

async function askTags(dataUrl) {
	const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY || "";
	if (!apiKey) return null;
	const model = process.env.DEEPSEEK_VISION_MODEL || "deepseek-v4-flash-vision-exp";
	const res = await fetch(`${openAiBase()}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: dataUrl } },
						{
							type: "text",
							text: "这是聊天中收到的一张图片。请判断它是否适合作为表情包收藏（能表达情绪/梗/可爱/搞笑等）。只输出 JSON，不要多余文字：{\"should_save\":true或false,\"name\":\"简短中文名\",\"tags\":[\"2-4个中文情绪/梗标签\"],\"reason\":\"一句话\"}",
						},
					],
				},
			],
			stream: false,
			max_tokens: 256,
		}),
		signal: AbortSignal.timeout(60000),
	});
	if (!res.ok) throw new Error(`tags api ${res.status}`);
	const content = (await res.json())?.choices?.[0]?.message?.content || "";
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text || "").join("") : "";
	const jsonStr = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
	const parsed = JSON.parse(jsonStr);
	return {
		shouldSave: parsed.should_save !== false,
		name: String(parsed.name || "表情").slice(0, 20),
		tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 4) : [],
	};
}

/** 保存一张收到的图片到表情库；不适合则返回 null。 */
export async function saveSticker(raw, sender) {
	const imgUrl = extractImgUrl(raw);
	if (!imgUrl) return null;
	try {
		mkdirSync(STICKER_DIR, { recursive: true });
		const { buf, mime } = await downloadImage(imgUrl);
		const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
		const meta = await askTags(dataUrl);
		if (!meta || !meta.shouldSave) return null;
		const id = randomUUID().slice(0, 8);
		const file = join(STICKER_DIR, id + extForMime(mime));
		writeFileSync(file, buf);
		const entry = {
			id,
			file,
			name: meta.name,
			tags: meta.tags,
			sender: String(sender || "?"),
			ts: Date.now(),
		};
		const entries = loadIndex();
		entries.unshift(entry);
		if (entries.length > 200) entries.length = 200;
		saveIndex(entries);
		console.log(`[sticker] 已收藏 ${id} ${meta.name} tags=${meta.tags.join("/")}`);
		return entry;
	} catch (e) {
		console.log("[sticker] 收藏失败:", e.message);
		return null;
	}
}

/** 注入 agent 的表情库上下文。excludeAfter 用于排除刚收到/刚入库的图，避免把用户刚发的图原样回发。 */
export function stickerLibraryContext(excludeAfter) {
	const entries = loadIndex();
	const visible = excludeAfter ? entries.filter((e) => !(e.ts > excludeAfter)) : entries;
	if (!visible.length) return "";
	const list = visible.slice(0, MAX_CONTEXT_STICKERS)
		.map((e) => `${e.id}(${e.name}/${e.tags.join("、")})`)
		.join(" ");
	return `[表情库] 可用表情：${list}\n如果当前语境适合发一张表情，在回复末尾追加 [STICKER:<id>]（id 必须是上面列出的），不要编造不存在的 id；不要把用户刚发的图原样回发，也不要在对方没在聊表情时硬发；不需要就别加。`;
}

function stickerCq(id) {
	const entries = loadIndex();
	const entry = entries.find((e) => e.id === id);
	if (!entry || !existsSync(entry.file)) return "";
	try {
		const buf = readFileSync(entry.file);
		return `[CQ:image,file=base64://${buf.toString("base64")}]`;
	} catch {
		return "";
	}
}

/** 从 agent 回复中提取表情 token：返回纯文本 + 独立 CQ 图片消息列表。 */
export function extractStickers(text) {
	const ids = [];
	const cleaned = String(text || "").replace(
		/\[STICKER:([a-zA-Z0-9_-]+)\]/g,
		(m, id) => {
			ids.push(id);
			return "";
		},
	);
	const stickers = ids.map(stickerCq).filter(Boolean);
	return { text: cleaned.trim(), stickers };
}
