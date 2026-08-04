export const LEGACY_BODY_BYTES = 2_000;
export const MIGRATED_BODY_BYTES = 1_944;
export const INBOUND_WINDOW_ITEMS = 10;

const CREATED_AT = 1_785_825_600_000;
const EXPIRES_AT = 4_102_444_800_000;
const FULL_LEGACY_TEXTS = Array.from(
  { length: 12 },
  (_, index) => String.fromCharCode(65 + index).repeat(LEGACY_BODY_BYTES),
);
FULL_LEGACY_TEXTS[10] = `${'汉'.repeat(666)}ab`;
const LEGACY_TEXTS = [...FULL_LEGACY_TEXTS, 'M'.repeat(144)];

export const legacyFullChunkText = LEGACY_TEXTS.join('');

export interface OutboxFixtureSnapshot {
  schemaVersion: number;
  revision?: number;
  nextSequence: number;
  items: Array<Record<string, unknown>>;
}

function legacyItem(index: number, text: string, schemaVersion: 1 | 2): Record<string, unknown> {
  return {
    schemaVersion,
    itemId: `legacy-${index}`,
    clientId: `legacy-client-${index}`,
    sequence: index,
    kind: 'text',
    accountId: 'account-a',
    userId: 'user-a',
    generation: 42,
    tokenVersion: 7,
    priority: 'final',
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    state: 'pending',
  };
}

export function schemaOneLegacyFullChunkFixture(): OutboxFixtureSnapshot {
  return {
    schemaVersion: 1,
    nextSequence: 14,
    items: LEGACY_TEXTS.map((text, index) => legacyItem(index + 1, text, 1)),
  };
}

export function schemaTwoFailureFixture(): OutboxFixtureSnapshot {
  return {
    schemaVersion: 2,
    revision: 2,
    nextSequence: 15,
    items: [
      ...LEGACY_TEXTS.map((text, index) => legacyItem(index + 1, text, 2)),
      {
        schemaVersion: 2,
        itemId: 'confirmation-14',
        clientId: 'confirmation-client-14',
        sequence: 14,
        kind: 'text',
        accountId: 'account-a',
        userId: 'user-a',
        generation: 49,
        tokenVersion: 8,
        priority: 'final',
        text: '新会话',
        bytes: Buffer.byteLength('新会话', 'utf8'),
        createdAt: CREATED_AT + 100,
        expiresAt: EXPIRES_AT,
        state: 'pending',
      },
    ],
  };
}
