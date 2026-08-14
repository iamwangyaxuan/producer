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
 * How long a minted download link stays readable.
 *
 * Short, because of who holds it: these go to model providers, never to a
 * browser and never into any document. Nothing re-checks membership while the
 * signature lives, so this is the window in which a revoked member's file is
 * still fetchable by whoever already has the link — and the window in which a
 * URL that reached a vendor's logs is still worth something. Ten minutes
 * covers a provider that queues a request briefly before pulling the inputs.
 */
const DOWNLOAD_URL_TTL_SECONDS = 600;

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

export interface DownloadUrlOptions {
  objectKey: string;
  /**
   * What the response must claim to be — already vetted by `servableMime`, or
   * `application/octet-stream` for a type this app will not render.
   */
  contentType: string;
  /** `inline`, or an `attachment` with the filename the row records. */
  contentDisposition: string;
}

/**
 * A presigned GET for one object, addressed to R2's S3 endpoint. This is how
 * bytes reach both consumers: the media elements on the canvas, and the model
 * provider, which has no session and could not use a cookie-authorized route
 * at all.
 *
 * The response headers are pinned rather than left to the object's own stored
 * metadata. R2 would otherwise answer with whatever `Content-Type` was written
 * at upload time, which is a claim made by whoever produced the file — the same
 * claim the serving route refuses to trust. Signing `response-content-type` and
 * `response-content-disposition` moves this app's allowlist verdict onto a
 * response it does not serve: a type outside the list comes back as an opaque
 * download, exactly as it would have from the Worker.
 *
 * Both live inside the signature, so they are not a suggestion — R2 answers 403
 * to a URL whose query was edited after minting, which is what stops a holder
 * from re-labelling someone's upload as `text/html` on the way out.
 *
 * Unlike the PUT above this needs no `allHeaders`: a GET fixes no request
 * headers, and the parameters that matter are in the query, which `signQuery`
 * already covers.
 */
export async function presignDownloadUrl(options: DownloadUrlOptions): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });

  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${options.objectKey}`
  );
  url.searchParams.set("X-Amz-Expires", String(DOWNLOAD_URL_TTL_SECONDS));
  url.searchParams.set("response-content-type", options.contentType);
  url.searchParams.set("response-content-disposition", options.contentDisposition);

  const signed = await client.sign(new Request(url, { method: "GET" }), {
    aws: { signQuery: true }
  });

  return signed.url;
}
