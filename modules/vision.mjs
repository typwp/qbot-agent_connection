/**
 * vision.mjs — 内置 DeepSeek-V4-Flash-Vision-Exp 识图
 * 匹配 [CQ:image,url=...] → 直连 DeepSeek OpenAI 兼容接口，返回中文描述。
 * 复用桥已有的 DeepSeek 认证（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）。
 */

/** 从 ANTHROPIC_BASE_URL 推导 OpenAI 兼容 base（/anthropic、/v1 尾巴都剥掉） */
function openAiBase() {
	const raw = process.env.DEEPSEEK_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com";
	return raw
		.replace(/\/anthropic\/?$/, "")
		.replace(/\/v1\/?$/, "")
		.replace(/\/?$/, "");
}

/**
 * 识别消息中的 CQ 图片。成功返回描述文本，无图/失败返回 null。
 */
export async function tryVision(raw) {
	const imgMatch = String(raw || "").match(/\[CQ:image[^\]]*url=([^\],]+)/);
	if (!imgMatch) return null;

	const imgUrl = imgMatch[1];
	const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY || "";
	if (!apiKey) {
		console.log("[vision] 缺少 DeepSeek API Key（ANTHROPIC_AUTH_TOKEN/DEEPSEEK_API_KEY）");
		return null;
	}
	const model = process.env.VISION_MODEL || "deepseek-v4-flash-vision-exp";
	const url = `${openAiBase()}/v1/chat/completions`;

	console.log(`[vision] 识图(${model}): ${imgUrl.slice(0, 80)}...`);

	try {
		const res = await fetch(url, {
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
							{ type: "image_url", image_url: { url: imgUrl } },
							{ type: "text", text: "用中文描述这张图片" },
						],
					},
				],
				stream: false,
				max_tokens: 1024,
			}),
			signal: AbortSignal.timeout(120000),
		});
		if (!res.ok) {
			console.log(`[vision] API ${res.status}: ${(await res.text()).slice(0, 200)}`);
			return null;
		}
		const data = await res.json();
		const content = data?.choices?.[0]?.message?.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text || "").join("") : "";
		return text.trim() || null;
	} catch (e) {
		console.log("[vision] 识图失败:", e.message);
		return null;
	}
}
