import type { FormEvent, ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ResponsiveFormShell } from "./ResponsiveFormShell";
import type { EditPendingFields } from "./types";

export type EditTopicViewProps = {
  isModal: boolean;
  isNarrow: boolean;
  safeInset: number;
  nestedModalOpen?: boolean;
  reauthBanner?: ReactNode;
  editPendingFields: EditPendingFields;
  editNameInput: string;
  editDescriptionInput: string;
  editSubmitting: boolean;
  editError?: string;
  onGoBack: () => void;
  onSubmit: (event: FormEvent) => void;
  onEditNameInputChange: (value: string) => void;
  onEditDescriptionInputChange: (value: string) => void;
  onCloseEditForm: () => void;
};

/** Edit Topic name and description modal dialog (wide) or pushed page (narrow). */
export function EditTopicView({
  isModal,
  isNarrow,
  safeInset,
  nestedModalOpen = false,
  reauthBanner,
  editPendingFields,
  editNameInput,
  editDescriptionInput,
  editSubmitting,
  editError,
  onGoBack,
  onSubmit,
  onEditNameInputChange,
  onEditDescriptionInputChange,
  onCloseEditForm,
}: EditTopicViewProps) {
  return (
    <ResponsiveFormShell
      title="编辑 Topic"
      isModal={isModal}
      isNarrow={isNarrow}
      safeInset={safeInset}
      closeDisabled={editSubmitting}
      backDisabled={editSubmitting}
      nestedModalOpen={nestedModalOpen}
      reauthBanner={reauthBanner}
      onClose={onCloseEditForm}
      onGoBack={onGoBack}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {editPendingFields.name ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-topic-name">Topic 名字</Label>
            <Input
              id="edit-topic-name"
              name="edit-topic-name"
              value={editNameInput}
              disabled={editSubmitting}
              onChange={(event) => onEditNameInputChange(event.target.value)}
              className="h-11 bg-background select-text"
            />
          </div>
        ) : null}

        {editPendingFields.description ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-topic-description">Description（可选）</Label>
            <Textarea
              id="edit-topic-description"
              name="edit-topic-description"
              rows={3}
              value={editDescriptionInput}
              disabled={editSubmitting}
              onChange={(event) =>
                onEditDescriptionInputChange(event.target.value)
              }
              className="min-h-22 resize-none bg-background select-text"
            />
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              留空表示没有额外上下文；填写后会发给这条 Topic 绑定的 Bot，不是私密备忘。
            </p>
          </div>
        ) : null}

        {editError ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{editError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={editSubmitting}
            onClick={onCloseEditForm}
          >
            取消
          </Button>
          <Button
            type="submit"
            className="min-h-11 sm:min-h-9"
            disabled={editSubmitting}
          >
            {editSubmitting ? "正在保存…" : "保存"}
          </Button>
        </div>
      </form>
    </ResponsiveFormShell>
  );
}
