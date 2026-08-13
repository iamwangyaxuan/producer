import { AwsClient } from "aws4fetch";
import { env } from "cloudflare:workers";

/**
 * How long a minted upload URL stays usable. Long enough for a slow
 * connection to finish one file, short enough that the window in which the
 * URL is a bearer write for its key stays small — it remains valid after the
 * upload completes, so this is the exposure that matters, and it is why the
 * serving route pins the object's ETag as well.
 */
const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * A presigned PUT for one object key, addressed to R2's S3 endpoint. The
 * browser uploads straight to the bucket with this URL — the bytes never pass
 * through the Worker, which is what frees uploads from request-body limits.
 *
 * Both the type and the size are part of the signature. Content-Type stops a
 * URL minted for one kind smuggling another; Content-Length is what makes the
 * size limit real, because a presigned PUT is otherwise an unbounded write —
 * a client could declare one byte, be allowed, and then send gigabytes. The
 * browser sets Content-Length itself from the body it is given, so a body of
 * any other length simply fails the signature at R2 and never reaches the
 * bucket. The completion step still re-measures with `head()`: the signature
 * governs what may be written, the measurement is what the row records.
 */
export async function presignUploadUrl(
  objectKey: string,
  contentType: string,
  sizeBytes: number
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });

  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${objectKey}`
  );
  url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_TTL_SECONDS));

  // `allHeaders` is what actually pins these: with `signQuery` alone,
  // aws4fetch signs only `host` and both declarations would be decorative.
  const signed = await client.sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(sizeBytes) }
    }),
    { aws: { signQuery: true, allHeaders: true } }
  );

  return signed.url;
}
