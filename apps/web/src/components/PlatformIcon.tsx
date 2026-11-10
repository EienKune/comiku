export type Platform = "x" | "pixiv";

export function PlatformIcon({
  platform,
  size = 18,
}: {
  platform: Platform;
  size?: number;
}) {
  return platform === "x" ? (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.9 2h3.1l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.4l8.2-9.4L2 2h6.5l4.5 6.8L18.9 2Zm-1.1 18h1.7L7.5 4H5.7l12.1 16Z"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 3h7a7 7 0 0 1 0 14H9v5H5V3Zm4 4v6h3a3 3 0 0 0 0-6H9Z"
      />
    </svg>
  );
}
