const SKUANGLES_SERVICE_ROUTES = new Map<string, ReadonlySet<string>>([
  ['/api/auth/session', new Set(['GET'])],
  ['/api/auth/exchange', new Set(['POST'])],
  ['/api/auth/logout', new Set(['POST'])],
  ['/api/billing/plans', new Set(['GET'])],
  ['/api/billing/checkout', new Set(['POST'])],
  ['/api/credits/skuangles/reserve', new Set(['POST'])],
  ['/api/credits/skuangles/complete', new Set(['POST'])],
  ['/api/credits/skuangles/refund', new Set(['POST'])],
]);

export function isAllowedSkuanglesServiceRequest(request: Request) {
  const url = new URL(request.url);
  return SKUANGLES_SERVICE_ROUTES.get(url.pathname)?.has(request.method) === true;
}

export async function asSkuanglesServiceRequest(request: Request) {
  const url = new URL(request.url);
  url.protocol = 'https:';
  url.host = 'auth.skuangles.com';

  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer(),
    redirect: 'manual',
  });
}
