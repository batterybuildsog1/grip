import { handleScheduled } from "@/agent/cron";
import app from "@/app";
import { handleEmail } from "@/handlers/email";

export default {
	fetch: app.fetch,
	email: handleEmail,
	scheduled: handleScheduled,
};
