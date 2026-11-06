import { useState } from "react";
import { Plus } from "lucide-react";
import type { TeamTask } from "@shared/protocol";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function NewTaskDialog({ tasks }: { tasks: TeamTask[] }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [blocked, setBlocked] = useState("");

  const ids = blocked
    .split(/[\s,]+/)
    .map((s) => s.replace(/^#/, ""))
    .filter(Boolean);
  const unknown = ids.filter((id) => !tasks.some((t) => t.id === id));
  const valid = subject.trim().length > 0 && unknown.length === 0;

  const reset = () => {
    setSubject("");
    setDescription("");
    setBlocked("");
  };

  const submit = () => {
    if (!valid) return;
    post({
      type: "createTask",
      subject: subject.trim(),
      description: description.trim(),
      blockedBy: ids.length ? ids : undefined,
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
        <Button variant="secondary" size="sm">
          <Plus /> New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>Agents see it in the shared task list and can claim it.</DialogDescription>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="nt-subject">Subject</Label>
            <Input id="nt-subject" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nt-desc">Description</Label>
            <Textarea id="nt-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nt-blocked">Blocked by (task ids, optional)</Label>
            <Input id="nt-blocked" value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="e.g. 1, 2" />
            {unknown.length > 0 && (
              <div className="text-[11px] text-destructive">Unknown task id: {unknown.join(", ")}</div>
            )}
          </div>
          <div className="flex justify-end gap-1.5 pt-1">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!valid}>
              Create task
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
