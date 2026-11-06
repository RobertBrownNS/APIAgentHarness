import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex w-full resize-none rounded-md border bg-input px-2 py-1.5 text-[length:inherit] text-[var(--vscode-input-foreground,inherit)] placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
