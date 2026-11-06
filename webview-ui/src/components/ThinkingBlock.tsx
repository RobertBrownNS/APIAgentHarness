import { Brain } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

/** Reasoning: a collapsed Trace line. */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={streaming ? "running" : undefined}>
            <TraceIcon>
              <Brain />
            </TraceIcon>
            <TraceTitle>{streaming ? "Thinking" : "Thought"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="max-h-60 overflow-y-auto whitespace-pre-wrap text-xs italic">{text}</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
