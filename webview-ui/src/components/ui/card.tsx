import * as React from "react";
import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground", className)} {...props} />;
}
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2 px-2.5 py-1.5", className)} {...props} />;
}
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-2.5 pb-2", className)} {...props} />;
}

export { Card, CardHeader, CardContent };
