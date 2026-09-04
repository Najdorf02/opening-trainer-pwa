import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('server origin configuration', () => {
  it('uses the actual loopback listener and configured port by default', () => {
    const config = loadConfig({ PORT: '6123' }, 'C:\\opening-trainer');

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 6123,
      origin: 'http://127.0.0.1:6123',
    });
  });

  it('allows localhost as the canonical name when its port matches', () => {
    const config = loadConfig({
      PORT: '6123',
      OPENING_TRAINER_ORIGIN: 'http://localhost:6123',
    }, 'C:\\opening-trainer');

    expect(config.origin).toBe('http://localhost:6123');
  });

  it.each([
    ['http://127.0.0.1:7000', 'mismatched port'],
    ['https://127.0.0.1:6123', 'TLS origin for a plain HTTP listener'],
    ['http://[::1]:6123', 'IPv6 origin for the IPv4 listener'],
    ['http://example.test:6123', 'non-loopback host'],
  ])('rejects %s (%s)', (origin) => {
    expect(() => loadConfig({
      PORT: '6123',
      OPENING_TRAINER_ORIGIN: origin,
    }, 'C:\\opening-trainer')).toThrow(/OPENING_TRAINER_ORIGIN/u);
  });
});
