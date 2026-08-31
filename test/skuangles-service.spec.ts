import { describe, expect, it } from 'vitest';

import {
  asSkuanglesServiceRequest,
  isAllowedSkuanglesServiceRequest,
} from '../src/lib/skuangles-service';

describe('SKU Angles service binding entrypoint', () => {
  it('allows only the BFF routes and methods SKU Angles needs', () => {
    expect(isAllowedSkuanglesServiceRequest(
      new Request('https://frontend.invalid/api/auth/session'),
    )).toBe(true);
    expect(isAllowedSkuanglesServiceRequest(
      new Request('https://frontend.invalid/api/credits/skuangles/reserve', { method: 'POST' }),
    )).toBe(true);
    expect(isAllowedSkuanglesServiceRequest(
      new Request('https://frontend.invalid/api/auth/google'),
    )).toBe(false);
    expect(isAllowedSkuanglesServiceRequest(
      new Request('https://frontend.invalid/api/webhooks/stripe', { method: 'POST' }),
    )).toBe(false);
    expect(isAllowedSkuanglesServiceRequest(
      new Request('https://frontend.invalid/api/auth/session', { method: 'POST' }),
    )).toBe(false);
  });

  it('pins product identity to the trusted SKU Angles host', async () => {
    const request = new Request('https://attacker.example/api/auth/exchange?next=1', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-session',
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'api.kindreply.co',
      },
      body: '{"token":"handoff"}',
    });

    const trusted = await asSkuanglesServiceRequest(request);
    expect(trusted.url).toBe('https://auth.skuangles.com/api/auth/exchange?next=1');
    expect(trusted.method).toBe('POST');
    expect(trusted.headers.get('authorization')).toBe('Bearer test-session');
    expect(trusted.headers.get('x-forwarded-host')).toBe('api.kindreply.co');
    expect(await trusted.text()).toBe('{"token":"handoff"}');
  });
});
