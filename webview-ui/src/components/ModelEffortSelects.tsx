import { EFFORTS, MODELS, type Effort } from "@shared/protocol";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function modelOptions(current?: string): string[] {
  const models: string[] = [...MODELS];
  if (current && !models.includes(current)) models.unshift(current);
  return models;
}

export function ModelSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className} aria-label="Model">
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        {modelOptions(value).map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function EffortSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: Effort;
  onChange: (v: Effort) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Effort)} disabled={disabled}>
      <SelectTrigger className={className} aria-label="Effort">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EFFORTS.map((e) => (
          <SelectItem key={e} value={e}>
            {e}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
