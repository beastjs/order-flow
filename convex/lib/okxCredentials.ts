import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { env, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { OkxAccount, OkxCredentials } from "./okxTradeCore";

export const ACTIVE_LIVE_STATUSES = ["opening", "open", "closing"] as const;

export async function connectionForUser(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("okxConnections").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
}

export function personalTradingEnabled() {
  return /^[a-f0-9]{64}$/i.test(env.OKX_USER_KEY_ENCRYPTION_KEY ?? "");
}

async function encryptionKey() {
  if (!personalTradingEnabled()) throw new ConvexError("Trading with your own OKX account is unavailable.");
  const hex = env.OKX_USER_KEY_ENCRYPTION_KEY!;
  const rawKey = Uint8Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

type ConnectionIdentity = Pick<Doc<"okxConnections">, "userId" | "mode" | "accountUid">;

function encryptionContext(connection: ConnectionIdentity) {
  return new TextEncoder().encode(JSON.stringify([connection.userId, connection.mode, connection.accountUid]));
}

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));

export async function encryptCredentials(connection: ConnectionIdentity, credentials: OkxCredentials) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encryptionContext(connection) },
    await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

export async function personalAccount(connection: Doc<"okxConnections">): Promise<OkxAccount> {
  const key = await encryptionKey();
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(connection.iv), additionalData: encryptionContext(connection) },
      key,
      bytes(connection.ciphertext),
    );
    const credentials = JSON.parse(new TextDecoder().decode(decrypted)) as OkxCredentials;
    return { mode: connection.mode, credentials, personal: true };
  } catch {
    throw new ConvexError("Your OKX credentials could not be read. Reconnect your key in My OKX settings.");
  }
}
