import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AccessCredential {
  accessToken: string;
  username: string;
  expiresAt: number;
}

interface PendingAuthorization {
  state: string;
  verifier: string;
  browserSessionId: string;
  expiresAt: number;
}

export interface PkceAuthorization {
  state: string;
  challenge: string;
}

export class MemoryAuthStore {
  private credential?: AccessCredential;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(
    private readonly pendingTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  begin(browserSessionId: string): PkceAuthorization {
    this.prune();
    const verifier = randomUrlSafe(64);
    const state = randomUrlSafe(32);
    this.pending.set(state, {
      state,
      verifier,
      browserSessionId,
      expiresAt: this.now() + this.pendingTtlMs,
    });
    return {
      state,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  }

  clearPending(browserSessionId: string): number {
    this.prune();
    let cleared = 0;
    for (const [state, pending] of this.pending) {
      if (safeEqual(pending.browserSessionId, browserSessionId)) {
        this.pending.delete(state);
        cleared += 1;
      }
    }
    return cleared;
  }

  consume(state: string, browserSessionId: string): { verifier: string } | undefined {
    this.prune();
    const pending = this.pending.get(state);
    if (!pending) return undefined;
    this.pending.delete(state);
    if (!safeEqual(pending.state, state) || !safeEqual(pending.browserSessionId, browserSessionId)) {
      return undefined;
    }
    return { verifier: pending.verifier };
  }

  setCredential(credential: AccessCredential): void {
    this.credential = credential;
  }

  getCredential(): AccessCredential | undefined {
    if (this.credential && this.credential.expiresAt <= this.now()) {
      this.credential = undefined;
    }
    return this.credential;
  }

  clearCredential(): AccessCredential | undefined {
    const credential = this.credential;
    this.credential = undefined;
    return credential;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
