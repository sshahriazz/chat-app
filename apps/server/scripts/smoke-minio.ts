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
import { createUploadUrl, deleteObject, headObjectSize } from "../src/lib/s3";

const KEY = `smoke/${Date.now()}.txt`;
const BODY = `smoke-test-${Date.now()}\n`;

async function main() {
  console.log("1. Minting presigned PUT URL");
  const signed = await createUploadUrl({
    userId: "smoke",
    key: KEY,
    contentType: "text/plain",
    contentLength: Buffer.byteLength(BODY, "utf8"),
  });
  console.log(`   uploadUrl: ${signed.uploadUrl.slice(0, 80)}…`);
  console.log(`   publicUrl: ${signed.publicUrl}`);

  console.log("\n2. PUT-ing bytes to the presigned URL");
  const putRes = await fetch(signed.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: BODY,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`PUT failed: ${putRes.status} ${text}`);
  }
  console.log(`   status: ${putRes.status}`);

  console.log("\n3. HEAD the object to verify stored size");
  const size = await headObjectSize(KEY);
  console.log(`   size: ${size} (expected ${BODY.length})`);
  if (size !== BODY.length) throw new Error("size mismatch");

  console.log("\n4. Public GET (anonymous — simulates the browser <img src>)");
  const getRes = await fetch(signed.publicUrl);
  const body = await getRes.text();
  console.log(`   status: ${getRes.status}`);
  console.log(`   body:   ${JSON.stringify(body)}`);
  if (getRes.status !== 200 || body !== BODY) {
    throw new Error("public GET did not return the uploaded body");
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
