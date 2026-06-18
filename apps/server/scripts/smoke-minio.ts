/**
 * End-to-end smoke test of the attachment flow against MinIO.
 * Uses the server's own `createUploadUrl` so we catch any config drift
 * between the prod code path and the infra.
 *
 *   - mints a presigned PUT URL
 *   - uploads bytes via that URL (exactly what the browser would do)
 *   - HEADs the object to confirm S3 stored it
 *   - fetches it back via the public URL base
 *   - deletes it
 *
 * Run: `npx tsx scripts/smoke-minio.ts`
 */
import "dotenv/config";
import {
  createUploadUrl,
  createDownloadUrl,
  deleteObject,
  headObjectSize,
} from "../src/lib/s3";

const KEY = `smoke/${Date.now()}.txt`;
const BODY = `smoke-test-${Date.now()}\n`;

async function main() {
  console.log("1. Minting presigned POST policy");
  const signed = await createUploadUrl({
    userId: "smoke",
    key: KEY,
    contentType: "text/plain",
    contentLength: Buffer.byteLength(BODY, "utf8"),
  });
  console.log(`   url:       ${signed.url}`);
  console.log(`   fields:    ${Object.keys(signed.fields).join(", ")}`);
  console.log(`   publicUrl: ${signed.publicUrl}`);

  console.log("\n2. POST-ing bytes via multipart form (presigned POST)");
  const form = new FormData();
  for (const [k, v] of Object.entries(signed.fields)) form.append(k, v);
  form.append("file", new Blob([BODY], { type: "text/plain" }));
  const postRes = await fetch(signed.url, { method: "POST", body: form });
  if (!postRes.ok) {
    const text = await postRes.text();
    throw new Error(`POST failed: ${postRes.status} ${text}`);
  }
  console.log(`   status: ${postRes.status}`);

  console.log("\n3. HEAD the object to verify stored size");
  const size = await headObjectSize(KEY);
  console.log(`   size: ${size} (expected ${BODY.length})`);
  if (size !== BODY.length) throw new Error("size mismatch");

  console.log("\n4. Signed GET (bucket is private — anonymous read is denied)");
  const { url: downloadUrl } = await createDownloadUrl({
    key: KEY,
    filename: "smoke.txt",
    contentType: "text/plain",
  });
  const getRes = await fetch(downloadUrl);
  const body = await getRes.text();
  console.log(`   status: ${getRes.status}`);
  console.log(`   body:   ${JSON.stringify(body)}`);
  if (getRes.status !== 200 || body !== BODY) {
    throw new Error("signed GET did not return the uploaded body");
  }

  console.log("\n5. Cleanup");
  await deleteObject(KEY);
  console.log("   done");

  console.log("\n✅ All steps passed.");
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err);
  process.exit(1);
});
