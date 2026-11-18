# @ai37/docx

Детерминированный рендер markdown в DOCX для агентов AI37. Пакет не вызывает LLM и не хранит
переданный текст.

```ts
import { renderMarkdownToDocx } from "@ai37/docx";

const bytes = await renderMarkdownToDocx("# Приказ\n\nТекст документа");
```

Поддерживаются заголовки, абзацы, выделение, inline code, списки, таблицы, горизонтальные линии и
блоки кода. Ссылки и неподдержанная разметка деградируют в видимый текст.

Язык документа задаёт `locale` — тег BCP-47, любая локаль из `SUPPORTED_LOCALES` `@ai37/agent-sdk`
или тег с регионом. Он попадает в язык текста по умолчанию (`w:lang`) и в описание файла:

```ts
const bytes = await renderMarkdownToDocx(markdown, { title: "Informe", locale: "es" });
```
