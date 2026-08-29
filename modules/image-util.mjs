/**
 * image-util.mjs — 图片格式探测与 URL 解码
 */
export function decodeCqImgUrl(raw) {
	return String(raw || "")
		.replace(/&amp;/g, "&")
		.replace(/&#38;/g, "&");
}

/** 按文件魔数识别真实图片 MIME，不信任 CDN 的 content-type。 */
export function detectImageMime(buf) {
	if (!buf || buf.length < 12) return null;
	// GIF
	if (
		buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && // "GIF"
		(buf[3] === 0x38) && // "8"
		(buf[4] === 0x37 || buf[4] === 0x39) // "7a" / "9a"
	) return "image/gif";
	// JPEG: FF D8 FF
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
		buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
	) return "image/png";
	// WebP: RIFF .... WEBP
	if (
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
		buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
	) return "image/webp";
	return null;
}
