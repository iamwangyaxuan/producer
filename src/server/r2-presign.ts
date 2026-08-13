import { AwsClient } from "aws4fetch";
import { env } from "cloudflare:workers";

/**
 * How long a minted upload URL stays usable. Generous enough to survive a
 * slow connection's preflight and retry, short enough that a leaked URL is a
 * fifteen-minute problem for one object key, not a standing door.
 */
const UPLOAD_URL_TTL_SECONDS = 900;

/**
 * A presigned PUT for one object key, addressed to R2's S3 endpoint. The
 * browser uploads straight to the bucket with this URL — the bytes never pass
 * through the Worker, which is what frees uploads from request-body limits.
 *
 * Content-Type is part of the signature, so the client must send the header
 * exactly as declared when the asset row was created; a URL minted for one
 * mime type cannot smuggle another. Size is deliberately not trusted from the
 * transfer at all — the completion step measures the object with `head()` and
 * that measurement is what the row records.
 */
export async function presignUploadUrl(objectKey: string, contentType: string): Promise<string> {
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

  // `allHeaders` is what actually pins Content-Type: with `signQuery` alone,
  // aws4fetch signs only `host` and the declared type would be decorative.
  const signed = await client.sign(
    new Request(url, { method: "PUT", headers: { "Content-Type": contentType } }),
    { aws: { signQuery: true, allHeaders: true } }
  );

  return signed.url;
}
