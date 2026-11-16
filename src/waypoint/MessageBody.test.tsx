import { render, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MessageBody } from "./MessageBody";
import { sanitizeColorLiteral, sanitizeInlineStyle } from "./markdown-color";

describe("markdown-color CSS sanitization", () => {
  test("preserves allowed color, background-color, and text-decoration while stripping unsafe CSS", () => {
    expect(
      sanitizeInlineStyle(
        "color: red; position: fixed; top: 0; background-color: #fef3c7; font-size: 99px; text-decoration: underline wavy",
      ),
    ).toBe("color: red; background-color: #fef3c7; text-decoration: underline wavy");

    expect(sanitizeInlineStyle("color: rgb(255, 0, 128); background-color: hsla(210deg, 80%, 50%, 0.2)")).toBe(
      "color: rgb(255, 0, 128); background-color: hsla(210deg, 80%, 50%, 0.2)",
    );

    expect(sanitizeInlineStyle("color: rgb(9 105 218 / 80%)")).toBe("color: rgb(9 105 218 / 80%)");
  });

  test("rejects CSS injection vectors such as url(), var(), expression(), comments, and backslashes", () => {
    expect(sanitizeInlineStyle("background-color: url(https://evil.example/x.png)")).toBeUndefined();
    expect(sanitizeInlineStyle("color: var(--destructive)")).toBeUndefined();
    expect(sanitizeInlineStyle("color: expression(alert(1))")).toBeUndefined();
    expect(sanitizeInlineStyle("color: red /* comment */")).toBeUndefined();
    expect(sanitizeInlineStyle("c\\olor: red")).toBeUndefined();
    expect(sanitizeInlineStyle("color: red !important")).toBeUndefined();
    expect(sanitizeColorLiteral("javascript:alert(1)")).toBeUndefined();
  });
});

describe("MessageBody inline colors and GFM callouts (#103)", () => {
  test("renders safe inline colored spans and <font color> with nested Markdown in Agent mode", () => {
    const body = [
      '前置 <span style="color: crimson; background-color: #fef3c7; text-decoration: underline">**加粗** `code`</span> 后续',
      "",
      '外层 <span style="color: blue">蓝字 <span style="color: green">绿字</span> 蓝字</span>',
      "",
      '<font color="#e11d48"><b>[FAIL]</b></font> 这是 <font color="#e11d48"> 渲染的红色',
      "",
      '<i>斜体</i> <u>下划线</u> <s>删除</s> <mark>高亮</mark><br/>换行',
    ].join("\n");

    const { container } = render(<MessageBody body={body} richColor />);

    const styledSpans = Array.from(container.querySelectorAll("span[style]")) as HTMLElement[];
    expect(styledSpans).toHaveLength(4);

    const first = styledSpans[0]!;
    expect(first.style.color).toBe("crimson");
    expect(first.style.backgroundColor).toBeTruthy();
    expect(first.style.textDecoration).toContain("underline");
    expect(first.querySelector('[data-streamdown="strong"]')?.textContent).toBe("加粗");
    expect(first.querySelector("code")?.textContent).toBe("code");

    expect(styledSpans[1]?.style.color).toBe("blue");
    expect(styledSpans[2]?.style.color).toBe("green");
    expect(styledSpans[3]?.style.color).toBeTruthy();
    expect(styledSpans[3]?.querySelector("b")?.textContent).toBe("[FAIL]");
    expect(container.textContent).toContain('这是 <font color="#e11d48"> 渲染的红色');
    expect(container.querySelector("i")?.textContent).toBe("斜体");
    expect(container.querySelector("u")?.textContent).toBe("下划线");
    expect(container.querySelector("s")?.textContent).toBe("删除");
    expect(container.querySelector("mark")?.textContent).toBe("高亮");
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.querySelector("font")).toBeNull();
  });

  test("strips unsafe attributes and CSS declarations while keeping non-whitelisted HTML literal", () => {
    const body = [
      '<span style="color: red; position: fixed" onclick="window.__xss103=true">混合清洗</span>',
      "",
      '<span style="position: fixed; z-index: 9999">纯危险样式</span>',
      "",
      '<span style="color: red">未闭合 <span style="color: blue">已闭合</span>',
      "",
      '<b onclick="window.__xss103=true">去属性粗体</b> <div onclick="window.__xss103=true">字面容器</div> <img src=x onerror=window.__xss103=true> <script>window.__xss103=true</script>',
    ].join("\n");

    const { container } = render(<MessageBody body={body} richColor />);

    expect((window as { __xss103?: boolean }).__xss103).toBeUndefined();
    expect(container.querySelector("[onclick]")).toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("去属性粗体");
    expect(container.querySelector(".waypoint-md-p > div")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();

    const styledSpans = Array.from(container.querySelectorAll("span[style]")) as HTMLElement[];
    expect(styledSpans.map((el) => el.textContent)).toEqual(["混合清洗", "已闭合"]);
    expect(styledSpans[0]!.style.color).toBe("red");
    expect(styledSpans[0]!.style.position).toBe("");

    expect(container.textContent).toContain("纯危险样式");
    expect(container.textContent).toContain('<span style="color: red">未闭合 ');
    expect(container.textContent).toContain('<div onclick="window.__xss103=true">字面容器</div>');
    expect(container.textContent).toContain("<script>window.__xss103=true</script>");
  });

  test("renders all 5 GFM callout types with English titles, nested content, and plain blockquote fallback", () => {
    const body = [
      "> [!NOTE]",
      "> 第一条提示，含 <span style=\"color: red\">红字</span>",
      "",
      "> [!tip]",
      "> - 技巧条目",
      "",
      "> [!IMPORTANT]",
      "> 关键事项",
      "",
      "> [!WARNING]",
      "> 注意警告",
      "",
      "> [!CAUTION]",
      "> 危险操作",
      "",
      "> [!NOTE]",
      "",
      "> [!UNKNOWN]",
      "> 未知类型保持普通引用",
      "",
      "> [!NOTE] 带附加文字的首行",
      "> 应回退为普通引用",
    ].join("\n");

    const { container } = render(<MessageBody body={body} richColor />);

    const callouts = Array.from(container.querySelectorAll(".waypoint-callout")) as HTMLElement[];
    expect(callouts).toHaveLength(6);

    expect(callouts.map((el) => el.getAttribute("data-callout"))).toEqual([
      "note",
      "tip",
      "important",
      "warning",
      "caution",
      "note",
    ]);
    expect(callouts.slice(0, 5).map((el) => el.querySelector(".waypoint-callout-title")?.textContent)).toEqual([
      "Note",
      "Tip",
      "Important",
      "Warning",
      "Caution",
    ]);

    // Nested inline color span inside NOTE callout
    const noteColorSpan = callouts[0]!.querySelector("span[style]") as HTMLElement;
    expect(noteColorSpan).not.toBeNull();
    expect(noteColorSpan.style.color).toBe("red");

    // Nested list inside TIP callout
    expect(within(callouts[1]!).getByText("技巧条目")).toBeInTheDocument();

    // Empty body NOTE callout has no body wrapper
    expect(callouts[5]!.querySelector(".waypoint-callout-body")).toBeNull();

    // Unknown marker and same-line extra text fall back to normal blockquotes
    const plainQuotes = Array.from(
      container.querySelectorAll('[data-streamdown="blockquote"]'),
    ) as HTMLElement[];
    expect(plainQuotes).toHaveLength(2);
    expect(plainQuotes[0]!.textContent).toContain("未知类型保持普通引用");
    expect(plainQuotes[1]!.textContent).toContain("应回退为普通引用");
  });

  test("keeps Owner/default mode (richColor=false) free of colored HTML and callout cards", () => {
    const body = [
      '<span style="color: red">红色</span> <font color="blue">蓝色</font>',
      "",
      "> [!NOTE]",
      "> 普通引用",
    ].join("\n");

    const { container } = render(<MessageBody body={body} />);

    expect(container.querySelector("span[style]")).toBeNull();
    expect(container.querySelector("font")).toBeNull();
    expect(container.querySelector(".waypoint-callout")).toBeNull();
    expect(container.querySelector('[data-streamdown="blockquote"]')).not.toBeNull();
    expect(container.textContent).toContain('<span style="color: red">红色</span>');
    expect(container.textContent).toContain('<font color="blue">蓝色</font>');
  });
});
