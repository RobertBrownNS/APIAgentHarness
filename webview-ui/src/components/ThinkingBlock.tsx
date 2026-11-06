import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="text-muted-foreground">
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs italic hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        Thinking{streaming ? "…" : ""}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-l-2 pl-2 text-xs italic">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
