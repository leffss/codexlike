// 一次性验证脚本：在真实 Electron 主进程里用真实 safeStorage（Windows DPAPI）
// 验证 Provider Profile 的「加密落盘无明文」与「重开恢复」。
// 用法：esbuild 打包后以 electron 运行（见工单 01 Comments 的验证记录）。
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, safeStorage } from 'electron';

import { createProfileStore } from '../src/profiles/profile-store';

// 真实 safeStorage 的 async 适配（与 main.ts 装配一致）
const storage = {
  isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encryptString: (plainText) => safeStorage.encryptStringAsync(plainText),
  decryptString: async (encrypted) =>
    (await safeStorage.decryptStringAsync(encrypted)).result,
};

void app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-verify-'));
  try {
    const apiKey = 'sk-real-secret-验证专用-12345';
    const store = createProfileStore({ dir, safeStorage: storage });
    await store.create({
      name: '验证 Profile',
      baseURL: 'https://example.com/v1',
      apiKey,
      model: 'verify-model',
    });

    const raw = readFileSync(join(dir, 'provider-profiles.json'), 'utf8');
    const noPlaintext = !raw.includes(apiKey);
    const hasEncryptedField = raw.includes('encryptedApiKey');

    // 同目录重建 store 等价于重启应用
    const restored = await createProfileStore({ dir, safeStorage: storage }).list();
    const restoredOk =
      restored.length === 1 &&
      restored[0]?.apiKey === apiKey &&
      restored[0]?.name === '验证 Profile' &&
      restored[0]?.model === 'verify-model';

    console.log(
      JSON.stringify({
        encryptionAvailable: await storage.isEncryptionAvailable(),
        noPlaintext,
        hasEncryptedField,
        restoredOk,
      }),
    );
    const ok = noPlaintext && hasEncryptedField && restoredOk;
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = ok ? 0 : 1;
    app.quit();
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
    app.quit();
  }
});
