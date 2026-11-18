import { createHash } from "node:crypto";

import type { SafeStorageLike } from "../profiles/profile-store";
import {
  createWindowsDpapiProtector,
  MAX_PLAIN_BYTES,
  MAX_PROTECTED_BYTES,
} from "./windows-dpapi";
import type { ByteProtector } from "./windows-dpapi";

export interface CredentialStorageOptions {
  legacy: SafeStorageLike;
  platform?: NodeJS.Platform;
  protector?: ByteProtector;
}

// 0x89 + CLCREDS 为保留 family；随后是 version、provider、uint32 LE payload 长度。
const FAMILY = Buffer.from("89434c4352454453", "hex");
const HEADER_BYTES = 14;

function unavailable(): Error {
  return new Error("系统凭据加密存储不可用或数据损坏，已拒绝处理凭据");
}

function isEnvelope(encrypted: Buffer): boolean {
  // 首字节保留给新 family；其余 family 完整时也识别被损坏的首字节。
  return (
    encrypted[0] === FAMILY[0] ||
    encrypted.subarray(1, FAMILY.length).equals(FAMILY.subarray(1))
  );
}

function payloadOf(encrypted: Buffer): Buffer {
  if (
    encrypted.length <= HEADER_BYTES ||
    !encrypted.subarray(0, FAMILY.length).equals(FAMILY) ||
    encrypted[8] !== 1 ||
    encrypted[9] !== 1 ||
    encrypted.readUInt32LE(10) !== encrypted.length - HEADER_BYTES
  ) {
    throw unavailable();
  }
  return encrypted.subarray(HEADER_BYTES);
}

function envelope(payload: Buffer): Buffer {
  if (payload.length === 0 || payload.length > MAX_PROTECTED_BYTES)
    throw unavailable();
  const header = Buffer.alloc(HEADER_BYTES);
  FAMILY.copy(header);
  header[8] = 1;
  header[9] = 1; // DPAPI CurrentUser
  header.writeUInt32LE(payload.length, 10);
  return Buffer.concat([header, payload]);
}

export function createCredentialStorage(
  options: CredentialStorageOptions
): SafeStorageLike {
  if ((options.platform ?? process.platform) !== "win32") {
    return {
      isEncryptionAvailable: () => options.legacy.isEncryptionAvailable(),
      encryptString: (plain) => options.legacy.encryptString(plain),
      decryptString: async (encrypted) => {
        if (isEnvelope(encrypted)) throw unavailable();
        return options.legacy.decryptString(encrypted);
      },
    };
  }
  const protector = options.protector ?? createWindowsDpapiProtector();
  let available = false;
  let probing: Promise<boolean> | undefined;
  const cache = new Map<string, string>();
  let cacheBytes = 0;
  const inflight = new Map<string, Promise<string>>();
  let running = 0;
  const queue: Array<() => void> = [];

  function run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = async (): Promise<void> => {
        running++;
        try {
          resolve(await operation());
        } catch {
          reject(unavailable());
        } finally {
          running--;
          queue.shift()?.();
        }
      };
      if (running < 2) {
        void start();
      } else if (queue.length < 32) {
        queue.push(() => {
          void start();
        });
      } else {
        reject(unavailable());
      }
    });
  }

  function remember(key: string, plain: string): void {
    // JS 字符串按 UTF-16 保守计费，digest 也在预算内；不长期保存密文副本。
    const bytes = (key.length + plain.length) * 2;
    if (bytes > 1024 * 1024) return;
    cache.set(key, plain);
    cacheBytes += bytes;
    while (cache.size > 128 || cacheBytes > 1024 * 1024) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      cache.delete(oldest[0]);
      cacheBytes -= (oldest[0].length + oldest[1].length) * 2;
    }
  }

  async function decrypt(encrypted: Buffer): Promise<string> {
    try {
      const plain = await protector.unprotect(payloadOf(encrypted));
      if (plain.length > MAX_PLAIN_BYTES) throw unavailable();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        plain
      );
    } catch {
      throw unavailable();
    }
  }

  async function probe(): Promise<boolean> {
    try {
      const plain = Buffer.from("CodexLike DPAPI availability probe", "utf8");
      const encrypted = await run(() => protector.protect(plain));
      available = (await run(() => protector.unprotect(encrypted))).equals(
        plain
      );
      return available;
    } catch {
      return false;
    } finally {
      probing = undefined;
    }
  }

  return {
    isEncryptionAvailable: async () => {
      if (available) return true;
      probing ??= probe();
      return probing;
    },
    encryptString: async (plain) => {
      try {
        if (Buffer.byteLength(plain, "utf8") > MAX_PLAIN_BYTES)
          throw unavailable();
        return envelope(
          await run(() => protector.protect(Buffer.from(plain, "utf8")))
        );
      } catch {
        throw unavailable();
      }
    },
    decryptString: async (encrypted) => {
      if (
        encrypted.length === 0 ||
        encrypted.length > MAX_PROTECTED_BYTES + HEADER_BYTES
      )
        throw unavailable();
      if (!isEnvelope(encrypted)) {
        try {
          return await options.legacy.decryptString(encrypted);
        } catch {
          throw unavailable();
        }
      }
      payloadOf(encrypted);
      const key = createHash("sha256").update(encrypted).digest("hex");
      const cached = cache.get(key);
      if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const snapshot = Buffer.from(encrypted);
      const operation = run(() => decrypt(snapshot))
        .then((plain) => {
          remember(key, plain);
          return plain;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, operation);
      return operation;
    },
  };
}
