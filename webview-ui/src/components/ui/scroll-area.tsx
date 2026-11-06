import * as React from "react";
import { ScrollArea as S } from "radix-ui";
import { cn } from "@/lib/utils";

function ScrollArea({
  className,
  children,
  viewportRef,
  onViewportScroll,
  ...props
}: React.ComponentProps<typeof S.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  return (
    <S.Root className={cn("relative overflow-hidden", className)} {...props}>
      <S.Viewport
        ref={viewportRef}
        onScroll={onViewportScroll}
        className="size-full rounded-[inherit] [&>div]:!block"
      >
        {children}
      </S.Viewport>
      <ScrollBar />
      <S.Corner />
    </S.Root>
  );
}

function ScrollBar({ className, orientation = "vertical", ...props }: React.ComponentProps<typeof S.ScrollAreaScrollbar>) {
  return (
    <S.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-px transition-colors",
        orientation === "vertical" ? "h-full w-2 border-l border-l-transparent" : "h-2 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      <S.ScrollAreaThumb className="relative flex-1 rounded-full bg-[var(--vscode-scrollbarSlider-background,rgba(128,128,128,0.4))] hover:bg-[var(--vscode-scrollbarSlider-hoverBackground,rgba(128,128,128,0.6))]" />
    </S.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
