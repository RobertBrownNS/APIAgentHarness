import { useState } from "react";
import { UserPlus } from "lucide-react";
import { LEAD, type Effort } from "@shared/protocol";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EffortSelect, modelOptions } from "@/components/ModelEffortSelects";

const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const RESERVED = [LEAD, "user", "all"];
const DEFAULT_MODEL = "__default";

function validateName(name: string, existing: string[]): string | undefined {
  if (!NAME_RE.test(name)) return "2-24 characters: lowercase letters, digits, hyphens; start with a letter.";
  if (RESERVED.includes(name)) return `"${name}" is reserved.`;
  if (existing.includes(name)) return "That name is already taken.";
  return undefined;
}

export function AddTeammateDialog({
  existing,
  disabled,
  disabledReason,
  defaultModel,
}: {
  existing: string[];
  disabled: boolean;
  disabledReason?: string;
  defaultModel: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<Effort>("medium");
  const [touched, setTouched] = useState(false);

  const nameError = validateName(name, existing);
  const valid = !nameError && role.trim().length > 0;

  const reset = () => {
    setName("");
    setRole("");
    setModel(DEFAULT_MODEL);
    setEffort("medium");
    setTouched(false);
  };

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    post({
      type: "addTeammate",
      name,
      role: role.trim(),
      model: model === DEFAULT_MODEL ? undefined : model,
      effort,
    });
    setOpen(false);
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" className="w-full" disabled={disabled} title={disabledReason}>
          <UserPlus /> Add teammate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Add teammate</DialogTitle>
        <DialogDescription>The teammate starts idle. Give it work by messaging it or assigning it a task.</DialogDescription>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="tm-name">Name</Label>
            <Input
              id="tm-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="e.g. tester"
              maxLength={24}
            />
            {(touched || name) && nameError && <div className="text-[11px] text-destructive">{nameError}</div>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="tm-role">Role</Label>
            <Input id="tm-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="One line, e.g. Writes unit tests" />
            {touched && !role.trim() && <div className="text-[11px] text-destructive">Role is required.</div>}
          </div>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label>Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full" aria-label="Model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_MODEL}>Default{defaultModel ? ` (${defaultModel})` : ""}</SelectItem>
                  {modelOptions().map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-24 space-y-1">
              <Label>Effort</Label>
              <EffortSelect className="w-full" value={effort} onChange={setEffort} />
            </div>
          </div>
          <div className="flex justify-end gap-1.5 pt-1">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm">
              Add teammate
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
