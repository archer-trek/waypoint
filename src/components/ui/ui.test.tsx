import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Copy } from "lucide-react";
import {
  ActionSheet,
  ActionSheetCancel,
  ActionSheetCard,
  ActionSheetContent,
  ActionSheetItem,
} from "@/components/ui/action-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

describe("shadcn/ui primitives", () => {
  test("Button renders variants and supports asChild", () => {
    render(
      <>
        <Button variant="destructive" size="sm">
          Delete
        </Button>
        <Button asChild>
          <a href="#home">Home</a>
        </Button>
      </>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn).toHaveClass("bg-destructive");
    expect(screen.getByRole("link", { name: "Home" })).toHaveClass("inline-flex");
  });

  test("Input, Textarea, Label, Badge, and Alert render cleanly", () => {
    render(
      <div>
        <Label htmlFor="topic-name">Topic</Label>
        <Input id="topic-name" placeholder="Name" />
        <Textarea aria-label="Description" />
        <Badge variant="secondary">Pinned</Badge>
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Something failed</AlertDescription>
        </Alert>
      </div>,
    );
    expect(screen.getByLabelText("Topic")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByText("Pinned")).toHaveClass("bg-secondary");
    expect(screen.getByRole("alert")).toHaveTextContent("Something failed");
  });

  test("Dialog renders accessible content when open", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Manage device settings</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  test("AlertDialog renders accessible content when open", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Delete</AlertDialogTitle>
            <AlertDialogDescription>Cannot be undone</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(screen.getByRole("alertdialog", { name: "Confirm Delete" })).toBeInTheDocument();
  });

  test("Select renders combobox trigger with selected value", () => {
    render(
      <Select defaultValue="bot-1">
        <SelectTrigger aria-label="Choose Bot">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="bot-1">Bot 1</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "Choose Bot" })).toHaveTextContent("Bot 1");
  });

  test("DropdownMenu renders trigger and open items", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <Button type="button">Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Edit</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
  });

  test("ActionSheet provides accessible DialogTitle, 44px grabber hit zone, left-aligned icon items, and drag without transition lag", () => {
    const onDismiss = vi.fn();
    render(
      <ActionSheet open>
        <ActionSheetContent title="消息操作" onDismiss={onDismiss}>
          <ActionSheetCard>
            <ActionSheetItem icon={<Copy className="size-4" aria-hidden="true" />}>
              复制纯文本
            </ActionSheetItem>
          </ActionSheetCard>
          <ActionSheetCard>
            <ActionSheetCancel>取消</ActionSheetCancel>
          </ActionSheetCard>
        </ActionSheetContent>
      </ActionSheet>,
    );

    const dialog = screen.getByRole("dialog", { name: "消息操作" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass("transition-transform");

    const grabberZone = dialog.querySelector('[data-slot="action-sheet-grabber-zone"]') as HTMLElement;
    expect(grabberZone).toHaveClass("h-11");

    const item = screen.getByRole("menuitem", { name: "复制纯文本" });
    expect(item).toHaveClass("justify-start", "text-left");

    // Dragging removes transition-transform to avoid drag lag and tracks delta via ref for fast release
    fireEvent.touchStart(grabberZone, { touches: [{ clientX: 0, clientY: 100 }], changedTouches: [{ clientX: 0, clientY: 100 }] });
    fireEvent.touchMove(grabberZone, { touches: [{ clientX: 0, clientY: 180 }], changedTouches: [{ clientX: 0, clientY: 180 }] });
    expect(dialog).not.toHaveClass("transition-transform");
    expect(dialog.style.transform).toBe("translate3d(0px, 80px, 0px)");

    fireEvent.touchEnd(grabberZone);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveClass("transition-transform");
  });

});
