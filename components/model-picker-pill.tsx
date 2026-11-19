"use client";

import type { ComponentProps } from "react";

/** The core and controlled plugin pickers share the very same trigger renderer.
 *  Fork (phone layout, owner 2026-10-30): `className` adds classes to the
 *  button and `labelClassName` to the label, after the shared ones. */
export function ModelPickerPill({ children, className, labelClassName, ...props }: ComponentProps<"button"> & { labelClassName?: string }) {
	return <button type="button" {...props}
		className={`flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 font-ui text-xs shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted${className ? ` ${className}` : ""}`}>
		<span className={`text-card-foreground${labelClassName ? ` ${labelClassName}` : ""}`}>{children}</span>
		<span aria-hidden className="text-xs text-muted-foreground">▾</span>
	</button>;
}
