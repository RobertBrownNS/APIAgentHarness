import * as React from "react";
import { Label as L } from "radix-ui";
import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof L.Root>) {
  return <L.Root className={cn("text-xs font-medium", className)} {...props} />;
}

export { Label };
