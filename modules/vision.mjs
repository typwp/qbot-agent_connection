/**
 * vision.mjs — URL 图片识图（旧桥 tryVision 同款）
 * 匹配 [CQ:image,url=...] → 调 QQBOT_DIR/vision.js 子进程 → 返回中文描述
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const DATA_ROOT = process.env.QQBOT_DIR || "/home/botuser/qq-bot";
// vision.js 挂 CLAUDE_CWD 下（.env 配置，例如 /mnt/d/Claude）。懒解析：.env 由桥启动时加载。
function claudeCwd() {
	return process.env.CLAUDE_CWD || DATA_ROOT;
}

/**
 * 识别消息中的 CQ 图片。成功返回描述文本，无图/失败返回 null。
 */
export function tryVision(raw) {
	const imgMatch = String(raw || "").match(/\[CQ:image[^\]]*url=([^\],]+)/);
	if (!imgMatch) return null;

	const imgUrl = imgMatch[1];
	console.log(`[vision] 识图: ${imgUrl.slice(0, 80)}...`);

	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(process.execPath, [join(claudeCwd(), "vision.js"), "--url", imgUrl, "用中文描述这张图片"], {
				timeout: 120000,
			});
		} catch (e) {
			console.log("[vision] 启动失败:", e.message);
			resolve(null);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("close", (code) => {
			if (code === 0 && stdout.trim()) {
				resolve(stdout.trim());
			} else {
				console.log("[vision] 识图失败:", stderr.slice(0, 200));
				resolve(null);
			}
		});
		child.on("error", () => resolve(null));
	});
}
