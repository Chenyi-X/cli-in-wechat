/**
 * 临时测试脚本：测试 Claude SDK 输出的所有中间 block
 * 运行：npx tsx test-sdk.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  const prompt = '研究一下当前目录下myjob是干嘛的';
  const workDir = process.cwd();

  console.log('=== SDK 测试开始 ===');
  console.log('Prompt:', prompt);
  console.log('WorkDir:', workDir);
  console.log('');

  let messageCount = 0;
  let blockCount = 0;

  const sdkOpts = {
    maxTurns: 5,
    permissionMode: 'bypassPermissions' as const,
    cwd: workDir,
    effort: 'high',
  };

  console.log('SDK Options:', JSON.stringify(sdkOpts, null, 2));
  console.log('');
  console.log('=== 开始流式输出 ===\n');

  try {
    for await (const message of query({ prompt, options: sdkOpts })) {
      messageCount++;
      const msg = message as Record<string, unknown>;

      console.log(`--- Message #${messageCount} ---`);
      console.log('Type:', msg.type);

      if (msg.type === 'assistant') {
        const msgObj = msg as any;
        const content = msgObj.content || msgObj.message?.content;
        if (content && Array.isArray(content)) {
          console.log('Blocks:', content.length);
          for (let i = 0; i < content.length; i++) {
            const block = content[i];
            blockCount++;
            console.log(`  Block[${i}]:`, block.type);

            if (block.type === 'thinking') {
              console.log(`    thinking: "${block.thinking?.substring(0, 100)}..."`);
            } else if (block.type === 'text') {
              console.log(`    text: "${block.text?.substring(0, 100)}..."`);
            } else if (block.type === 'tool_use') {
              console.log(`    tool_name: ${block.name}`);
              console.log(`    input:`, JSON.stringify(block.input).substring(0, 200));
            }
          }
        }
      }

      if (msg.type === 'user') {
        const msgObj = msg as any;
        const content = msgObj.content || msgObj.message?.content;
        if (content && Array.isArray(content)) {
          console.log('Blocks:', content.length);
          for (let i = 0; i < content.length; i++) {
            const block = content[i];
            blockCount++;
            console.log(`  Block[${i}]:`, block.type);

            if (block.type === 'tool_result') {
              console.log(`    tool_use_id: ${block.tool_use_id}`);
              console.log(`    content type: ${typeof block.content}`);
              console.log(`    content: "${String(block.content).substring(0, 200)}..."`);
            }
          }
        }
      }

      if (msg.type === 'result') {
        console.log('Result:', (msg.result as string)?.substring(0, 200));
        console.log('Session ID:', msg.session_id);
        console.log('Is Error:', msg.is_error);
        console.log('Subtype:', msg.subtype);
        console.log('Duration:', msg.duration_ms, 'ms');
        console.log('Cost:', msg.total_cost_usd, 'USD');
      }

      console.log('');
    }

    console.log('=== 测试结束 ===');
    console.log('Total messages:', messageCount);
    console.log('Total blocks:', blockCount);

  } catch (err) {
    console.error('Error:', err);
  }
}

main();
