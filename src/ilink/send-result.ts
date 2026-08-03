export type SendStatus =
  | 'sent'
  | 'queued'
  | 'waiting-for-token'
  | 'suppressed'
  | 'rate-limited'
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
  status: 'rate-limited' | 'permanent-failure';
  ambiguous: boolean;
  error: ApiErrorDetails;
}

/** Classify an application response without inferring meaning from errmsg text. */
export function classifyApiFailure(error: ApiErrorDetails): ClassifiedApiFailure | null {
  if (error.ret === undefined || error.ret === 0) return null;
  return {
    status: error.ret === -2 ? 'rate-limited' : 'permanent-failure',
    ambiguous: error.ret === -2,
    error,
  };
}
