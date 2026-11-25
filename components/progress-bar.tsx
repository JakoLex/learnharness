/**
 * A thin progress bar (fork, owner 2026-11-25): the graph's import pill and
 * the shelf. `fraction` null = no numbers yet — the bar pulses without a
 * fill level instead of pretending.
 */
import { cn } from "@/lib/utils";

export function ProgressBar({ fraction, className }: { fraction: number | null; className?: string }) {
	const percent = fraction === null ? undefined : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
	return (
		<div
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
			data-testid="progress-bar"
			className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
		>
			<div
				className={cn(
					"h-full rounded-full",
					percent === undefined ? "w-full animate-pulse bg-foreground/20" : "bg-foreground/50 transition-[width] duration-500",
				)}
				style={percent === undefined ? undefined : { width: `${percent}%` }}
			/>
		</div>
	);
}
