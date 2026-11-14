import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
