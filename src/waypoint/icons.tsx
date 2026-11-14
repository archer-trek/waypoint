import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

/** Brand beacon icon for Waypoint's connect screen. */
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
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <circle cx="16" cy="16" r="8" stroke="currentColor" strokeWidth="2" strokeOpacity="0.4" />
      <circle cx="16" cy="16" r="3" fill="currentColor" />
      <path
        d="M16 2V6M16 26V30M2 16H6M26 16H30"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
