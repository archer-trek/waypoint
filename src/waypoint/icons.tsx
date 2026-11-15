import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

/** Brand W-route + waypoint node icon for Waypoint. */
export function WaypointBrandIcon({ size = 32, className, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...props}
    >
      <path
        d="M5 11.5L10 22.5L15 13L20 22.5L23.7 14.3"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="25.7" cy="9.6" r="2.7" fill="currentColor" />
    </svg>
  );
}
