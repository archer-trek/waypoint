export type DeleteTopicDialogProps = {
  topicName: string;
  deleting: boolean;
  deleteError?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Destructive confirmation prompt before leaving and removing a Topic room. */
export function DeleteTopicDialog({
  topicName,
  deleting,
  deleteError,
  onConfirm,
  onCancel,
}: DeleteTopicDialogProps) {
  return (
    <div
      role="alertdialog"
      aria-label="确认删除 Topic"
      className="waypoint-agents-form waypoint-delete-dialog"
    >
      <h4>确认删除 Topic</h4>
      <p>确定要删除「{topicName}」吗？删除后无法恢复。</p>
      <p>
        Waypoint 看不出这条是不是该 Bot 的 home；如果是，之后走 home
        的投递会进已离开的房间，追不回，也不会再提示；要改投就在还留着的或新建的
        Topic 里自己发一条以 /sethome 开头的消息（Waypoint 不代发 /sethome）。
      </p>
      <p>
        在这条 Topic 里跟该 Bot 约定的、回到本房间的提醒仍会发进已离开的房间，追不回，/sethome
        不会把它们改投走（若要取消或重设，需在删除前或在该 Bot 的其他 Topic
        里发消息让它处理）。
      </p>
      {deleteError ? <p role="alert">{deleteError}</p> : null}
      <div className="waypoint-form-actions">
        <button type="button" disabled={deleting} onClick={onConfirm}>
          {deleting ? "正在删除…" : "确认删除"}
        </button>
        <button type="button" disabled={deleting} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
