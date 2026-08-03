import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export type DeliveryDiagnosticEvent = 'inbound' | 'request' | 'response' | 'error' | 'skipped';

export interface DeliveryDiagnosticResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  httpStatus?: number;
}

export interface DeliveryDiagnosticInput {
  event: DeliveryDiagnosticEvent;
  accountId: string;
  userId: string;
  contextToken?: string;
  inboundMessageId?: string;
  tokenChanged?: boolean;
  clientId?: string;
  itemId?: string;
  itemSequence?: number;
  bubbleSequence?: number;
  generation?: number;
  tokenVersion?: number;
  priority?: string;
  itemCount?: number;
  jsLength?: number;
  utf8Bytes?: number;
  itemListBytes?: number;
  response?: DeliveryDiagnosticResponse;
}

function hash(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export class DeliveryDiagnostics {
  private requestSequence = 0;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }

  record(input: DeliveryDiagnosticInput): void {
    const record = {
      recordedAt: new Date(this.now()).toISOString(),
      event: input.event,
      requestSequence: ++this.requestSequence,
      accountHash: hash(input.accountId),
      userHash: hash(input.userId),
      tokenHash: hash(input.contextToken),
      inboundMessageId: input.inboundMessageId,
      tokenChanged: input.tokenChanged,
      clientId: input.clientId,
      itemId: input.itemId,
      itemSequence: input.itemSequence,
      bubbleSequence: input.bubbleSequence,
      generation: input.generation,
      tokenVersion: input.tokenVersion,
      priority: input.priority,
      itemCount: input.itemCount,
      jsLength: input.jsLength,
      utf8Bytes: input.utf8Bytes,
      itemListBytes: input.itemListBytes,
      response: input.response,
    };

    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
