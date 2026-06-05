const fs = require('fs');
const path = './src/services/message-handler.service.ts';
let content = fs.readFileSync(path, 'utf8');

const replacement = `    // Route extract_meeting and supplement to V2 queue
    console.log(\`[Router] Routing \${route.intent} to V2 Background Worker for user=\${userId}\`);
    const { createProcessingJob } = await import('../repositories/processing-jobs.repo');
    const { createSourceBatch } = await import('../repositories/source-batches.repo');
    const batchId = await createSourceBatch(userId, text || 'voice_or_file_placeholder');
    
    await createProcessingJob(userId, 'EXTRACT_MEETING', {
      chatId,
      text,
      voice: null, 
      batchId,
      thinkingMessageId
    });
    return;
  } finally {
    stopProgressUpdates();
  }
}
`;

content = content.replace(/if \(route\.intent === 'supplement'\) \{[\s\S]*\} finally \{\s*stopProgressUpdates\(\);\s*\}\s*\}/, replacement);

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed processTelegramUpdate to use V2 queue');
