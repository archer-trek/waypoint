import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DeleteMessageDialogProps = {
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Centered destructive AlertDialog rendered before permanently deleting a confirmed message. */
export function DeleteMessageDialog({
  deleting,
  onConfirm,
  onCancel,
}: DeleteMessageDialogProps) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) {
          onCancel();
        }
      }}
    >
      <AlertDialogContent
        aria-label="确认删除消息"
        onEscapeKeyDown={(event) => {
          if (deleting) {
            event.preventDefault();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除这条消息？</AlertDialogTitle>
          <AlertDialogDescription>
            所有设备上的当前 Topic 都会永久移除这条消息，且不能恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={deleting}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              buttonVariants({ variant: "destructive" }),
              "min-h-11 sm:min-h-9",
            )}
            disabled={deleting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {deleting ? "正在删除…" : "确认删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
