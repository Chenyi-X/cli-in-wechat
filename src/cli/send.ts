import { loadCredentials } from '../config.js';
import { ILinkClient } from '../ilink/client.js';

export async function sendCommand(args: string[]): Promise<void> {
  // ─── Parse arguments ─────────────────────────────────
  let targetUser: string | null = null;
  const messageParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-u' || args[i] === '--user') {
      if (i + 1 >= args.length) {
        console.error('错误: -u 需要指定用户 ID');
        process.exit(1);
      }
      targetUser = args[++i];
    } else {
      messageParts.push(args[i]);
    }
  }

  // ─── Get message text ────────────────────────────────
  let message = messageParts.join(' ');

  if (!message) {
    if (process.stdin.isTTY === false) {
      message = await readStdin();
    }
  }

  if (!message) {
    printUsage();
    process.exit(1);
  }

  // ─── Load credentials ────────────────────────────────
  const credentials = loadCredentials();
  if (!credentials) {
    console.error('错误: 未登录。请先运行 `npm run dev` 扫码登录。');
    process.exit(1);
  }

  // ─── Determine target user ───────────────────────────
  const userId = targetUser || credentials.ilinkUserId;

  // ─── Send message ────────────────────────────────────
  try {
    const client = new ILinkClient(credentials);
    const results = await client.sendText(userId, message);
    const failures = results.filter((result) => result.status !== 'sent');
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`发送未完成: ${failure.status}: ${failure.error?.errmsg || '结果已进入持久化队列或终态记录'}`);
      }
      process.exit(1);
    }
    console.log('已发送');
  } catch (err) {
    console.error(`发送失败: ${(err as Error).message}`);
    process.exit(1);
  }
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}
function printUsage(): void {
  console.log(`用法: wcli send [选项] <消息>

选项:
  -u, --user <userId>    指定目标用户 ID（默认发给自己）

示例:
  wcli send "hello"                    发送消息给自己
  wcli send "hello" -u wx_xxxxxx       发送给指定用户
  echo "hello" | wcli send             从标准输入读取消息`);
}
