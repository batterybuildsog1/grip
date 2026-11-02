export const onRequest: PagesFunction = async (context) => {
	const response = await context.env.ASSETS.fetch(context.request);
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
	headers.set("CDN-Cache-Control", "no-cache");
	headers.set("X-Content-Type-Options", "nosniff");

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};
