/**
 * ReverseProxyIcon — 16×16 fill glyph in the official DeepSeek Harness
 * icon language (currentColor, evenodd, no strokes).
 *
 * A solid local node bridged to a hollow remote node: the hop this plugin
 * actually is. Not a diamond, plus, phone, gear, or crosshair — those
 * already sit in the same settings panel.
 */
export function ReverseProxyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm8 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0 1.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM6.25 7.25h3.5v1.5h-3.5z"
      />
    </svg>
  )
}
