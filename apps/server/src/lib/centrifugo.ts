import jwt from "jsonwebtoken";
import { env } from "../env";

const apiUrl = env.CENTRIFUGO_URL + "/api";

interface ApiOptions {
  retries?: number;
}

async function apiCall(
  endpoint: string,
  payload: unknown,
  opts: ApiOptions = {},
): Promise<unknown> {
  const retries = opts.retries ?? 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${apiUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": env.CENTRIFUGO_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Centrifugo ${endpoint} ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        // 100ms, 200ms, 400ms...
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastErr;
}

export interface PublishOptions {
  idempotencyKey?: string;
}

export function publish(
  channel: string,
  data: unknown,
  opts: PublishOptions = {},
) {
  return apiCall(
    "publish",
    {
      channel,
      data,
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    },
    { retries: 2 },
  );
}

export function broadcast(
  channels: string[],
  data: unknown,
  opts: PublishOptions = {},
) {
  if (channels.length === 0) return Promise.resolve(null);
  return apiCall(
    "broadcast",
    {
      channels,
      data,
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    },
    { retries: 2 },
  );
}

export function presence(channel: string) {
  return apiCall("presence", { channel });
}

export function userChannel(userId: string) {
  return `user:${userId}`;
}

export function generateConnectionToken(
  userId: string,
  info?: Record<string, unknown>,
) {
  const payload: Record<string, unknown> = {
    sub: userId,
    subs: {
      [userChannel(userId)]: {},
    },
  };

  if (info) {
    payload.info = info;
  }

  return jwt.sign(payload, env.CENTRIFUGO_TOKEN_SECRET, { expiresIn: "10m" });
}

export function generateSubscriptionToken(userId: string, channel: string) {
  return jwt.sign(
    { sub: userId, channel },
    env.CENTRIFUGO_TOKEN_SECRET,
    { expiresIn: "10m" },
  );
}
