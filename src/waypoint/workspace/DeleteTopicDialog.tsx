import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

export type DeleteTopicDialogProps = {
  topicName: string;
  deleting: boolean;
  deleteError?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Centered destructive AlertDialog rendered before leaving and removing a Topic room. */
export function DeleteTopicDialog({
  topicName,
  deleting,
  deleteError,
  onConfirm,
  onCancel,
}: DeleteTopicDialogProps) {
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
        aria-label="确认删除 Topic"
        onEscapeKeyDown={(event) => {
          if (deleting) {
            event.preventDefault();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除 Topic</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p className="m-0">
                确定要删除「{topicName}」吗？删除后无法恢复。
              </p>
              <p className="m-0">
                Waypoint 看不出这条是不是该 Bot 的 home；如果是，之后走 home
                的投递会进已离开的房间，追不回，也不会再提示；要改投就在还留着的或新建的
                Topic 里自己发一条以 /sethome 开头的消息（Waypoint 不代发
                /sethome）。
              </p>
              <p className="m-0">
                在这条 Topic
                里跟该 Bot 约定的、回到本房间的提醒仍会发进已离开的房间，追不回，/sethome
                不会把它们改投走（若要取消或重设，需在删除前或在该 Bot 的其他
                Topic 里发消息让它处理）。
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteError ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{deleteError}</AlertDescription>
          </Alert>
        ) : null}
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
