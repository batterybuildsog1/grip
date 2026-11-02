/** Configured trip companies plus Personal. Unset = no business companies. */
import { z } from "zod";
import { MileageError } from "./auth";
import { idSchema } from "./policy";
import type { Category } from "./store";

const companySchema = z
	.object({
		id: idSchema.refine((id) => id !== "personal", "personal is reserved"),
		name: z.string().trim().min(1).max(100),
		treatment: z.enum(["business", "reimbursement"]),
	})
	.strict();
const listSchema = z
	.array(companySchema)
	.max(10)
	.refine((list) => new Set(list.map((c) => c.id)).size === list.length, "Company ids repeat");

const DEFAULT_COMPANIES: z.infer<typeof listSchema> = [];
const PERSONAL: Category = {
	id: "personal",
	name: "Personal",
	treatment: "personal",
	entity_id: "personal",
};

const toCategories = (list: z.infer<typeof listSchema>): Category[] => [
	...list.map((c) => ({ id: c.id, name: c.name, treatment: c.treatment, entity_id: c.id })),
	PERSONAL,
];

const cache = new Map<string, Category[]>();

/** Configured companies (in order) plus Personal. Throws 503 when the variable is invalid. */
export function builtinCategories(env: Pick<CloudflareBindings, "MILEAGE_COMPANIES_JSON">) {
	const raw = env.MILEAGE_COMPANIES_JSON?.trim();
	if (!raw) return toCategories(DEFAULT_COMPANIES);
	const known = cache.get(raw);
	if (known) return known;
	let parsed: z.infer<typeof listSchema> | null = null;
	try {
		const result = listSchema.safeParse(JSON.parse(raw));
		parsed = result.success ? result.data : null;
	} catch {
		parsed = null;
	}
	if (!parsed)
		throw new MileageError("MILEAGE_UNAVAILABLE", "MILEAGE_COMPANIES_JSON is invalid", 503);
	const categories = toCategories(parsed);
	cache.set(raw, categories);
	return categories;
}

/** The unset default, for code that runs without an env (Calendar adapter tests). */
export const defaultBuiltinCategories = () => toCategories(DEFAULT_COMPANIES);

/** Built-in companies only (no Personal): the export types and the text that names them. */
export const builtinCompanies = (builtins: Category[]) =>
	builtins.filter((c) => c.treatment === "business" || c.treatment === "reimbursement");
