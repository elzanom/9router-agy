#!/usr/bin/env node
/**
 * Batch register multiple accounts to 9router Antigravity
 */
const { spawn } = require('child_process');
const path = require('path');

const accounts = require('./batch-accounts.json');
const botPath = path.join(__dirname, 'bot.js');

let success = 0;
let failed = 0;

async function processOne(account, index) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${index + 1}/${accounts.length}] ${account.email}`);
  console.log(`${'='.repeat(60)}`);
  
  return new Promise((resolve) => {
    const proc = spawn('node', [botPath, 'browser', account.email, account.password], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    
    let output = '';
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });
    
    proc.on('close', (code) => {
      if (output.includes('✅ Sukses! Akun terdaftar.')) {
        success++;
        resolve(true);
      } else {
        failed++;
        console.log(`[${account.email}] ❌ GAGAL (exit code: ${code})`);
        resolve(false);
      }
    });
    
    proc.on('error', (err) => {
      failed++;
      console.log(`[${account.email}] ❌ ERROR: ${err.message}`);
      resolve(false);
    });
  });
}

(async () => {
  console.log(`\nMemproses ${accounts.length} akun...\n`);
  
  for (let i = 0; i < accounts.length; i++) {
    const ok = await processOne(accounts[i], i);
    // Small delay between accounts to avoid rate limits
    if (i < accounts.length - 1) {
      console.log('\nMenunggu 5 detik sebelum akun berikutnya...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SELESAI! ${success} sukses, ${failed} gagal dari ${accounts.length} akun`);
  console.log(`${'='.repeat(60)}`);
  
  // Show final summary
  const inspect = spawn('node', [botPath, 'inspect'], { cwd: __dirname, stdio: 'inherit' });
  await new Promise(r => inspect.on('close', r));
})();
