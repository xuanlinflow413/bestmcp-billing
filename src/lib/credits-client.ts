/**
 * Credits Client — Shared library for consuming and refunding credits
 * Used by KindReply and BestMCPServers Workers
 */

export interface CreditsConfig {
  billingWorkerUrl: string;
  apiKey: string;
}

export interface ConsumeResult {
  success: boolean;
  balance?: number;
  reference_id?: string;
  error?: string;
  code?: string;
}

export interface RefundResult {
  success: boolean;
  balance?: number;
  error?: string;
}

export interface CreditsBalance {
  balance: number;
  lifetime_used: number;
  lifetime_purchased: number;
}

/**
 * Check credits balance for a user
 */
export async function checkCredits(
  userId: string,
  config: CreditsConfig
): Promise<CreditsBalance | null> {
  try {
    const res = await fetch(`${config.billingWorkerUrl}/api/credits`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'X-User-ID': userId,
      },
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Unauthorized: Invalid API key');
      }
      if (res.status === 404) {
        return { balance: 0, lifetime_used: 0, lifetime_purchased: 0 };
      }
      throw new Error(`Credits API error: ${res.status}`);
    }

    return await res.json() as CreditsBalance;
  } catch (err) {
    console.error('[CreditsClient] Check failed:', err);
    return null;
  }
}

/**
 * Consume credits before AI call
 * Returns reference_id for potential refund
 */
export async function consumeCredits(
  userId: string,
  amount: number,
  product: 'kindreply' | 'bestmcp',
  feature: string,
  config: CreditsConfig,
  description?: string
): Promise<ConsumeResult> {
  try {
    const res = await fetch(`${config.billingWorkerUrl}/api/credits/consume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'X-User-ID': userId,
      },
      body: JSON.stringify({
        amount,
        product,
        feature,
        description: description || `${product}:${feature}`,
      }),
    });

    const data = await res.json() as { error?: string; balance?: number; reference_id?: string };

    if (!res.ok) {
      if (res.status === 402) {
        return {
          success: false,
          error: 'Insufficient credits',
          code: 'CREDITS_INSUFFICIENT',
        };
      }
      return {
        success: false,
        error: data.error || `Credits API error: ${res.status}`,
        code: `HTTP_${res.status}`,
      };
    }

    return {
      success: true,
      balance: data.balance,
      reference_id: data.reference_id,
    };
  } catch (err) {
    console.error('[CreditsClient] Consume failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      code: 'NETWORK_ERROR',
    };
  }
}

/**
 * Refund credits when AI call fails
 */
export async function refundCredits(
  userId: string,
  referenceId: string,
  amount: number,
  reason: string,
  config: CreditsConfig
): Promise<RefundResult> {
  try {
    const res = await fetch(`${config.billingWorkerUrl}/api/credits/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'X-User-ID': userId,
      },
      body: JSON.stringify({
        user_id: userId,
        reference_id: referenceId,
        amount,
        reason,
      }),
    });

    const data = await res.json() as { error?: string; balance?: number };

    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Refund API error: ${res.status}`,
      };
    }

    return {
      success: true,
      balance: data.balance,
    };
  } catch (err) {
    console.error('[CreditsClient] Refund failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Wrapper: Execute AI call with credits check, consume, and auto-refund on failure
 */
export async function withCredits<T>(
  userId: string,
  amount: number,
  product: 'kindreply' | 'bestmcp',
  feature: string,
  config: CreditsConfig,
  aiCall: (referenceId: string) => Promise<T>,
  description?: string
): Promise<{ success: true; data: T; balance: number } | { success: false; error: string; code: string }> {
  // 1. Check balance
  const balance = await checkCredits(userId, config);
  if (!balance || balance.balance < amount) {
    return {
      success: false,
      error: 'Insufficient credits. Please purchase more credits to continue.',
      code: 'CREDITS_INSUFFICIENT',
    };
  }

  // 2. Consume credits
  const consumeResult = await consumeCredits(userId, amount, product, feature, config, description);
  if (!consumeResult.success) {
    return {
      success: false,
      error: consumeResult.error || 'Failed to consume credits',
      code: consumeResult.code || 'CONSUME_FAILED',
    };
  }

  const referenceId = consumeResult.reference_id!;

  // 3. Execute AI call
  try {
    const result = await aiCall(referenceId);
    return {
      success: true,
      data: result,
      balance: consumeResult.balance!,
    };
  } catch (err) {
    // 4. Auto-refund on failure
    console.error(`[CreditsClient] AI call failed for ${product}:${feature}, refunding...`, err);
    await refundCredits(userId, referenceId, amount, `AI call failed: ${err instanceof Error ? err.message : 'Unknown error'}`, config);

    return {
      success: false,
      error: err instanceof Error ? err.message : 'AI call failed',
      code: 'AI_CALL_FAILED',
    };
  }
}
