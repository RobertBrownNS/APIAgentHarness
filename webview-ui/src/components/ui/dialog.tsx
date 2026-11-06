import * as React from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = D.Root;
const DialogTrigger = D.Trigger;
const DialogClose = D.Close;

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/50" />
      <D.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none",
          className,
        )}
        {...props}
      >
        {children}
        <D.Close
          className="absolute right-2 top-2 cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-3.5" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof D.Title>) {
  return <D.Title className={cn("mb-1 text-sm font-semibold", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof D.Description>) {
  return <D.Description className={cn("mb-2 text-xs text-muted-foreground", className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription };
