import { Hono } from "hono";
import type { AppVariables } from "@/types";
import { verifyAttachmentDownloadToken } from "@/utils/attachment-links";
import { attachmentResponseHeaders } from "@/utils/attachments";
import { ERR } from "@/utils/http";

const publicRoutes = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

publicRoutes.get("/api/public/attachments/:token", async (c) => {
	if (!c.env.ATTACHMENTS) {
		return c.json(ERR("ATTACHMENTS_DISABLED", "Attachment storage is not configured"), 503);
	}

	const verified = await verifyAttachmentDownloadToken(c.env, c.req.param("token"));
	if (!verified.ok) {
		const status = verified.reason === "expired" ? 410 : 404;
		return c.json(ERR("ATTACHMENT_LINK_INVALID", "This attachment link is unavailable"), status);
	}

	const object = await c.env.ATTACHMENTS.get(verified.payload.key);
	if (!object) {
		return c.json(ERR("ATTACHMENT_MISSING", "Attachment payload not found"), 404);
	}

	const headers = attachmentResponseHeaders({
		mimeType: verified.payload.mime_type,
		filename: verified.payload.filename,
	});
	if (Number.isFinite(verified.payload.size) && verified.payload.size > 0) {
		headers.set("Content-Length", String(verified.payload.size));
	}

	return new Response(object.body, { status: 200, headers });
});

export default publicRoutes;
