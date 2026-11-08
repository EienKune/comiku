/** A policy rejection cannot recover merely by repeating the same request. */
export const MEDIA_POLICY_REASONS = [
  "media_size_limit",
  "media_type_unsupported",
  "media_empty",
  "media_url_not_allowed",
];
export function isMediaPolicyRejection(reason: string | undefined) {
  // A CDN can transiently return an empty body or an HTTP-200 error page.
  return reason === "media_size_limit" || reason === "media_url_not_allowed";
}
