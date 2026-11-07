import { EFFORTS, isLocalModel, localModelId, MODELS, type Effort } from "@shared/protocol";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Claude models, then local Unsloth models ("local:<id>"). */
export function modelOptions(current?: string, localModels: readonly string[] = []): string[] {
  const models: string[] = [...MODELS, ...localModels];
  if (current && !models.includes(current)) models.unshift(current);
  return models;
}

/** How a model reads in the UI: local ones show their Unsloth id with a "local" tag. */
export function modelLabel(model: string): string {
  return isLocalModel(model) ? `${localModelId(model)} · local` : model;
}

export function ModelSelect({
  value,
  onChange,
  disabled,
  className,
  localModels,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  localModels?: readonly string[];
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className} aria-label="Model">
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        {modelOptions(value, localModels).map((m) => (
          <SelectItem key={m} value={m}>
            {modelLabel(m)}
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
