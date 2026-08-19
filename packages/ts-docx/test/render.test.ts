import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { renderMarkdownToDocx } from "../src/index.js";

function zipEntry(buffer: Buffer, name: string): string {
  const entry = unzipSync(buffer)[name];
  expect(entry).toBeDefined();
  return strFromU8(entry);
}

describe("renderMarkdownToDocx", () => {
  it("создаёт непустой DOCX с ZIP-сигнатурой", async () => {
    const result = await renderMarkdownToDocx("# Приказ\n\nТекст документа");

    expect(result.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(result.length).toBeGreaterThan(1000);
  });

  it("поддерживает кириллицу, списки и таблицы без ошибки", async () => {
    const result = await renderMarkdownToDocx(
      "# Политика\n\n**Оператор** обрабатывает данные.\n\n1. Первый пункт\n2. Второй пункт\n\n| Поле | Значение |\n|---|---|\n| ИНН | 7707083893 |",
      { title: "Политика обработки персональных данных" },
    );

    const xml = zipEntry(result, "word/document.xml");
    expect(xml).toContain("Политика");
    expect(xml).toContain("Оператор");
    expect(xml).toContain("7707083893");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:numPr>");
    expect(zipEntry(result, "word/numbering.xml")).toContain("%1.");
  });

  it("не исполняет и не встраивает HTML из markdown", async () => {
    const result = await renderMarkdownToDocx(
      "<script>alert(1)</script>\n\nБезопасный текст",
    );

    const xml = zipEntry(result, "word/document.xml");
    expect(xml).toContain("Безопасный текст");
    expect(xml).not.toContain("<script>");
  });

  it("рендерит вложенный список, переносы, код и разделитель", async () => {
    const result = await renderMarkdownToDocx(
      "- Пункт *курсивом*\n  - Вложенный `код`  \n    новая строка\n\n---\n\n```text\nслужебный блок\n```",
    );
    const xml = zipEntry(result, "word/document.xml");

    expect(xml).toContain("Пункт ");
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("Courier New");
    expect(xml).toContain("служебный блок");
    expect(xml).toContain("<w:pBdr>");
    expect(xml).toContain("<w:br/>");
  });

  it("пустой markdown остаётся валидным DOCX", async () => {
    const result = await renderMarkdownToDocx("");

    expect(zipEntry(result, "word/document.xml")).toContain("<w:body>");
  });
});
