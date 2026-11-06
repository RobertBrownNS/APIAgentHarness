import { AlertCircle, Info } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { cn } from "@/lib/utils";

export function Notice({ level, text }: { level: "info" | "error"; text: string }) {
  return (
    <Marker className={cn("text-xs", level === "error" && "text-destructive")}>
      <MarkerIcon>{level === "error" ? <AlertCircle /> : <Info />}</MarkerIcon>
      <MarkerContent className="whitespace-pre-wrap">{text}</MarkerContent>
    </Marker>
  );
}
