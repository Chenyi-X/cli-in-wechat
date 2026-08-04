export type SendStatus =
  | 'sent'
  | 'queued'
  | 'waiting-for-token'
  | 'suppressed'
  | 'rate-limited'
  | 'ambiguous'
  | 'permanent-failure';

export interface ApiErrorDetails {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  httpStatus?: number;
}

export interface SendResult {
  status: SendStatus;
  itemId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  attemptedBytes: number;
  error?: ApiErrorDetails;
}

export interface ClassifiedApiFailure {
  status: 'rate-limited' | 'ambiguous' | 'permanent-failure';
  ambiguous: boolean;
  error: ApiErrorDetails;
}

/** Classify an application response without inferring meaning from errmsg text. */
export function classifyApiFailure(error: ApiErrorDetails): ClassifiedApiFailure | null {
  if (error.ret === undefined || error.ret === 0) return null;
  if (error.ret === -2) {
    const rateLimited = /rate\s*limited/i.test(error.errmsg || '');
    return {
      status: rateLimited ? 'rate-limited' : 'ambiguous',
      ambiguous: true,
      error,
    };
  }
  return {
    status: 'permanent-failure',
    ambiguous: false,
    error,
  };
}
