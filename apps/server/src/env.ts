function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: required("BETTER_AUTH_URL"),
  CENTRIFUGO_API_KEY: required("CENTRIFUGO_API_KEY"),
  CENTRIFUGO_TOKEN_SECRET: required("CENTRIFUGO_TOKEN_SECRET"),
  CENTRIFUGO_URL: required("CENTRIFUGO_URL"),
  PORT: process.env.PORT || "3001",

  // S3-compatible object storage for attachments. All optional — the
  // upload-url endpoint fails loudly if any are missing, so the rest of
  // the app can still boot before you configure a bucket.
  S3_ENDPOINT: optional("S3_ENDPOINT"), // blank for AWS; set for R2/MinIO/B2.
  S3_REGION: optional("S3_REGION"),
  S3_BUCKET: optional("S3_BUCKET"),
  S3_ACCESS_KEY_ID: optional("S3_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: optional("S3_SECRET_ACCESS_KEY"),
  S3_PUBLIC_URL_BASE: optional("S3_PUBLIC_URL_BASE"),

  // Web Push (VAPID). All optional — push endpoints throw with a clear
  // message if called without them set. Generate a fresh keypair with:
  //   node -e "const w=require('web-push'); console.log(w.generateVAPIDKeys())"
  VAPID_PUBLIC_KEY: optional("VAPID_PUBLIC_KEY"),
  VAPID_PRIVATE_KEY: optional("VAPID_PRIVATE_KEY"),
  VAPID_SUBJECT: optional("VAPID_SUBJECT"), // e.g. mailto:admin@example.com
};
