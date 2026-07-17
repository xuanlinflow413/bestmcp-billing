import { Hono } from 'hono';
import { DbClient } from '../lib/db';
import { getSessionToken, verifySession } from '../lib/auth';
import { errorResponse } from '../lib/utils';
import type { AppContext } from '../types';
import { getProductConfigForRequest, usesProductCreditsV2 } from '../lib/product-config';

const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MODEL_TIMEOUT_MS = 60_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const imageRoutes = new Hono<AppContext>();

function imageDimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  if (type === 'image/png' && bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === 'image/webp' && bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === 'VP8X') return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
  }
  if (type === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: (bytes[offset + 5] << 8) + bytes[offset + 6], width: (bytes[offset + 7] << 8) + bytes[offset + 8] };
      }
      offset += length + 2;
    }
  }
  return null;
}

export function detectImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.byteLength < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

async function currentUser(c: any): Promise<string | null> {
  const token = getSessionToken(c.req.raw);
  if (!token) return null;
  const payload = await verifySession(token, c.env.KV_SESSIONS, c.env.JWT_SECRET);
  return payload?.userId || null;
}

imageRoutes.post('/edit', async (c) => {
  const productConfig = getProductConfigForRequest(c.req.url, c.req.header('X-Forwarded-Host'));
  if (!productConfig || productConfig.productId !== 'prod_editimages') return errorResponse('Unknown product host', 404, 'PRODUCT_HOST_UNKNOWN');
  if (!usesProductCreditsV2(productConfig.productId, c.env)) return errorResponse('Credits are temporarily unavailable', 503, 'PRODUCT_CREDITS_DISABLED');
  const userId = await currentUser(c);
  if (!userId) return errorResponse('Authentication required', 401);
  if (!c.env.AI) return errorResponse('AI image editing is unavailable', 503, 'AI_UNAVAILABLE');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return errorResponse('Multipart form required', 415);
  const form = await c.req.formData().catch(() => null);
  if (!form) return errorResponse('Invalid multipart form', 400);
  const image = form.get('image');
  const operation = form.get('operation');
  const instruction = typeof form.get('instruction') === 'string' ? String(form.get('instruction')).trim() : '';
  const idempotencyKey = typeof form.get('idempotencyKey') === 'string' ? String(form.get('idempotencyKey')).trim() : '';
  if (!(image instanceof File) || !ALLOWED_IMAGE_TYPES.has(image.type) || image.size < 1 || image.size > MAX_IMAGE_BYTES) {
    return errorResponse('Use a JPEG, PNG, or WebP image up to 8 MB', 400, 'IMAGE_INVALID');
  }
  const dimensions = imageDimensions(new Uint8Array(await image.arrayBuffer()), image.type);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
    return errorResponse('Use a valid image no larger than 4096 by 4096 pixels', 400, 'IMAGE_DIMENSIONS_INVALID');
  }
  if (operation !== 'replace_text') return errorResponse('Unsupported edit operation', 400, 'OPERATION_INVALID');
  if (instruction.length < 3 || instruction.length > 500) return errorResponse('Instruction must be 3 to 500 characters', 400, 'INSTRUCTION_INVALID');
  if (!/^[A-Za-z0-9_-]{16,120}$/.test(idempotencyKey)) return errorResponse('Valid idempotencyKey required', 400, 'IDEMPOTENCY_KEY_INVALID');

  const db = new DbClient(c.env.DB);
  await db.ensureProductCredits(userId, productConfig.productId, 2);
  const existing = await db.getProductCreditReservation(userId, productConfig.productId, idempotencyKey);
  if (existing) return errorResponse('This edit request was already submitted', 409, 'DUPLICATE_REQUEST');
  const referenceId = crypto.randomUUID();
  const reserved = await db.reserveProductCredit(userId, productConfig.productId, idempotencyKey, referenceId);
  if (!reserved.success) return errorResponse('Insufficient credits', 402, 'CREDITS_INSUFFICIENT');

  try {
    const modelForm = new FormData();
    modelForm.append('prompt', `Edit the supplied product image. Preserve the product, camera angle, composition, dimensions, and all details not mentioned. Requested edit: ${instruction}`);
    modelForm.append('input_image', image, 'product-image');
    const serialized = new Response(modelForm);
    const modelCall = c.env.AI.run(MODEL, {
      multipart: { body: serialized.body!, contentType: serialized.headers.get('content-type')! },
    } as any);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Workers AI timed out')), MODEL_TIMEOUT_MS);
    });
    const result = await Promise.race([modelCall, timeout]).finally(() => timer && clearTimeout(timer));
    if (!result || typeof result !== 'object' || !('image' in result) || typeof result.image !== 'string' || !result.image) {
      throw new Error('Workers AI returned an invalid response');
    }
    const output = Uint8Array.from(atob(result.image), (character) => character.charCodeAt(0));
    const outputType = detectImageType(output);
    if (!outputType) throw new Error('Workers AI returned an invalid image');
    if (!await db.completeProductCreditReservation(userId, productConfig.productId, referenceId)) throw new Error('Credit reservation could not be completed');
    const headers = new Headers();
    headers.set('content-type', outputType);
    headers.set('cache-control', 'private, no-store');
    headers.set('x-editimages-credit-cost', '1');
    headers.delete('content-disposition');
    return new Response(output, { status: 200, headers });
  } catch {
    await db.refundProductCreditReservation(userId, productConfig.productId, referenceId);
    return errorResponse('AI image editing failed; the reserved credit was refunded', 502, 'AI_EDIT_FAILED');
  }
});

export { imageRoutes };
