import * as React from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = S.Root;
const SelectValue = S.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof S.Trigger>) {
  return (
    <S.Trigger
      className={cn(
        "flex h-6 min-w-0 items-center justify-between gap-1 rounded-md border bg-input px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 cursor-pointer [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <S.Icon asChild>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </S.Icon>
    </S.Trigger>
  );
}

function SelectContent({ className, children, ...props }: React.ComponentProps<typeof S.Content>) {
  return (
    <S.Portal>
      <S.Content
        position="popper"
        sideOffset={2}
        className={cn(
          "z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      >
        <S.Viewport className="p-1">{children}</S.Viewport>
      </S.Content>
    </S.Portal>
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof S.Item>) {
  return (
    <S.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-sm py-1 pl-6 pr-2 text-xs outline-none data-[highlighted]:bg-accent",
        className,
      )}
      {...props}
    >
      <span className="absolute left-1.5 flex size-3 items-center justify-center">
        <S.ItemIndicator>
          <Check className="size-3" />
        </S.ItemIndicator>
      </span>
      <S.ItemText>{children}</S.ItemText>
    </S.Item>
  );
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
