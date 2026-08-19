import MarkdownIt from "markdown-it";
import {
  Document,
  Packer,
  PageOrientation,
  convertMillimetersToTwip,
} from "docx";
import { blockChildren } from "./blocks.js";

export interface RenderMarkdownToDocxOptions {
  title?: string;
  locale?: "ru-RU";
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

/** Рендерит markdown в DOCX полностью локально, без сети и внешнего состояния. */
export async function renderMarkdownToDocx(
  source: string,
  options: RenderMarkdownToDocxOptions = {},
): Promise<Buffer> {
  const document = new Document({
    creator: "AI37",
    title: options.title,
    description:
      "Документ сформирован локальным детерминированным рендерером AI37",
    numbering: {
      config: [
        {
          reference: "ai37-numbering",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: "decimal",
            text: `%${level + 1}.`,
            alignment: "start",
            style: {
              paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.PORTRAIT },
            margin: {
              top: convertMillimetersToTwip(20),
              right: convertMillimetersToTwip(15),
              bottom: convertMillimetersToTwip(20),
              left: convertMillimetersToTwip(30),
            },
          },
        },
        children: blockChildren(markdown.parse(source, {})),
      },
    ],
  });
  return Packer.toBuffer(document);
}
