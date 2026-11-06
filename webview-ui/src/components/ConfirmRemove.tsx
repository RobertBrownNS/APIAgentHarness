import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export function ConfirmRemove({
  open,
  onOpenChange,
  name,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  name: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Remove {name}?</DialogTitle>
        <DialogDescription>
          Its current turn is stopped, its pending approvals are rejected and its unfinished tasks are released. Its
          transcript stays visible.
        </DialogDescription>
        <div className="flex justify-end gap-1.5">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              post({ type: "removeTeammate", name });
              onOpenChange(false);
            }}
          >
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
