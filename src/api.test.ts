import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, getOpeningExplorer, isApiError } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API errors', () => {
  it('preserves status, JSON error code, and the raw Retry-After header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'opening_data_rate_limited',
        message: 'Opening data is rate limited.',
      },
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '37',
      },
    })));

    const request = getOpeningExplorer('start', {
      ratings: [2000],
      speeds: ['rapid'],
    });

    await expect(request).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Opening data is rate limited.',
      status: 503,
      code: 'opening_data_rate_limited',
      retryAfter: '37',
    });

    try {
      await request;
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      if (isApiError(error)) expect(error.status).toBe(503);
    }
  });

  it('uses a stable fallback message for malformed error responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', {
      status: 502,
    })));

    await expect(getOpeningExplorer('start', {
      ratings: [2000],
      speeds: ['rapid'],
    })).rejects.toEqual(new ApiError('요청 실패 (502)', { status: 502 }));

    expect(isApiError(new Error('plain error'))).toBe(false);
  });
});
