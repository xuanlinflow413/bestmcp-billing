/**
 * 工具函数
 */

export function generateUUID(): string {
	return crypto.randomUUID();
}

export function now(): number {
	return Math.floor(Date.now() / 1000);
}

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

export function errorResponse(message: string, status = 400, code?: string): Response {
	return jsonResponse({ error: message, code }, status);
}

export function sha256(text: string): string {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	return crypto.subtle.digest('SHA-256', data).then((buf) => {
		return Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	});
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
	const prefix = 'bm_';
	const random = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const key = prefix + random;
	return { key, hash: '', prefix: key.slice(0, 8) };
}

export async function hashApiKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(key);
	const buf = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export function setCookie(name: string, value: string, maxAge: number, secure = true): string {
	return `${name}=${value}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

export function clearCookie(name: string): string {
	return `${name}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}
