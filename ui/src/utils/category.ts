import type { EmailCategory } from "../types";

export const CATEGORY_ORDER = [
	"personal",
	"billing",
	"agents",
	"notifications",
	"newsletters",
	"marketing",
	"spam",
	"home_alerts",
	"tax_documents",
] as const satisfies readonly EmailCategory[];
