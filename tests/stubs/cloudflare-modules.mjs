// Lets node load Worker modules that import `cloudflare:*` built-ins (the unit suite runs under
// tsx, not workerd). `cloudflare:workers` env is empty here: tests pass env explicitly.
import { register } from "node:module";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(specifier, context, next) {
	if (specifier === "cloudflare:workers") {
		return { url: "data:text/javascript,export const env = {};", shortCircuit: true };
	}
	return next(specifier, context);
}`),
);
