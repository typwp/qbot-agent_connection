/**
 * thinking.mjs — 思考中提示运行时（旧桥 L2082/L2277 同款）
 * 仅当用户开启了 thinkingEnabled 且消息判定为"需要长思考"时，调用 agent 前发一条提示语。
 */
// ── 判断是否需要发送思考中提醒（避免秒回场景也发）──
export function needsThinkingIndicator(msg) {
	const trimmed = String(msg || "").trim();
	if (!trimmed) return false;

	// 命令类（/开头）→ 不需要
	if (/^\/[a-z]/i.test(trimmed)) return false;

	// 问候/简单应答 → 不需要
	if (
		/^(你?好|hi|hello|hey|早[上安]?|晚安|哈哈?|嗯[嗯]?|哦[哦]?|啊[啊]?|喔|噢|好[的吧嗯]?|是[的嘛吗]?|对[的吧]?|行[的吧]?|ok|okay|好的|知道[了]?|明白[了]?|谢谢|感谢|[88拜拜再见]|bye|在吗|在不在|没[什么事]|没事|算了|不管了|就这样[吧]?|收到|了解|はい|うん|そう|なるほど|わかった|りょ[かい]?|おは[よう]?|こんにち[は]?|おやすみ|よし|オッケー)$/i.test(
			trimmed,
		)
	)
		return false;
	// 纯标点/纯表情
	if (/^[.。，,！!？?…\-=~～\s]+$/.test(trimmed)) return false;

	// 强复杂关键词（任何长度，优先匹配）
	const strongKw = /(代码|写个|实现|bug|报错|error|修复|重构|方案|需求|建议|汇总|搜索|爬虫)/i;
	if (strongKw.test(trimmed)) return true;

	// 社会闲聊话题 → 不需要
	const socialQ = /(天气|温度|下雨|晴天|吃饭|早上好|下午好|晚上好|在干嘛|在忙|最近怎么样|去哪)/i;
	if (socialQ.test(trimmed)) return false;

	// 极短消息(≤2字) → 不需要
	if (trimmed.length <= 2) return false;

	// 3-4字：含温和关键词才触发
	const shortKw = /(查|写|改|做|搞|加|删|找|图|谁|情况)/i;
	if (trimmed.length <= 4) return shortKw.test(trimmed);

	// 5-8字：含操作类关键词触发
	const mildKw = /(怎么|如何|什么|为啥|为什么|能不能|帮我|修复|重构|写|做|搞|加|查|找|删|保存|写入|创建|删除|移动|图片|照片|截图|最近|汇总|搜索|情况)/i;
	if (trimmed.length <= 8) return mildKw.test(trimmed);

	// 长消息(>8字) → 需要
	return true;
}

// ── "让我想想" 智能适配 ──
export function pickThinkingReply(userMessage, customReplies, customMode, personaReplies) {
	const msg = userMessage || "";
	const scenarios = [
		// 代码/技术相关
		{
			match: /(代码|写个|实现|怎么|如何|什么|为啥|为什么|能不能|帮我|bug|报错|error|修复|改|重构)/i,
			replies: ["让我看看代码……", "这个问题从逻辑上分析一下……", "嗯，这个技术问题有点意思……"],
		},
		// 图片
		{
			match: /图片|图|照片|截图|画|表情|meme|screen/i,
			replies: ["让我看看你发了什么……", "图像识别需要一点时间……", "嗯我先看看这张图……"],
		},
		// 查信息/阅读
		{
			match: /查|看(看|一下)?|找|搜索|最近|谁|什么情况|汇总/i,
			replies: ["查一下看看……", "翻翻记录……", "稍等，我搜索一下……"],
		},
		// 复杂需求/多步骤
		{
			match: /加(一?个|个)?功能|搞一?个|做一?个|想(要|做|搞)|需求|建议|方案/i,
			replies: ["这个想法有点意思，让我理理思路……", "这个需要拆解一下，稍等……", "嗯，我考虑一下怎么做……"],
		},
		// 文件操作
		{
			match: /文件|保存|写入|写到|创建|删除|移动/i,
			replies: ["先确认下文件结构……", "让我检查一下……", "好，操作一下……"],
		},
	];

	for (const s of scenarios) {
		if (s.match.test(msg)) {
			return s.replies[Math.floor(Math.random() * s.replies.length)];
		}
	}
	// 默认随机（支持自定义追加或覆盖 + 人设联动）
	if (customMode === "override" && customReplies?.length) {
		return customReplies[Math.floor(Math.random() * customReplies.length)];
	}
	const defaults = [];
	if (personaReplies?.length) defaults.push(...personaReplies);
	if (customReplies?.length) defaults.push(...customReplies);
	if (!defaults.length) defaults.push(...defaultsFallback());
	return defaults[Math.floor(Math.random() * defaults.length)];
}

export function defaultsFallback() {
	return ["让我想想……", "嗯我思考一下……", "这个问题值得分析……", "稍等，让我理清思路……"];
}
