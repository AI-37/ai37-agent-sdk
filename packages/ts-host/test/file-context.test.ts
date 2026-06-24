import { describe, it, expect } from 'vitest'
import {
  contextFilePath,
  renderContextFilesManifest,
} from '../src/store-backend/file-context'
import type { ContextFile } from '../src/types'

describe('contextFilePath', () => {
  it('маппит project-attachment ref в путь project-attachments', () => {
    expect(contextFilePath('project-attachment:f_abc')).toBe('/project-attachments/f_abc')
  })
  it('маппит chat-attachment ref в путь chat-attachments', () => {
    expect(contextFilePath('chat-attachment:f_xyz')).toBe('/chat-attachments/f_xyz')
  })
  it('возвращает null для не-файлового ref (project:/неизвестный)', () => {
    expect(contextFilePath('project:proj_1')).toBeNull()
    expect(contextFilePath('whatever:1')).toBeNull()
  })
})

describe('renderContextFilesManifest', () => {
  const files: ContextFile[] = [
    {
      ref: 'project-attachment:f1',
      name: 'Ленина 48 данные дома.pdf',
      summary: 'исходные данные жилого дома',
      scope: 'project',
      isLarge: true,
    },
    { ref: 'chat-attachment:f2', name: 'план.docx', scope: 'chat' },
  ]

  it('пустой список → пустая строка (блок не добавляем)', () => {
    expect(renderContextFilesManifest([])).toBe('')
    expect(renderContextFilesManifest(undefined)).toBe('')
  })

  it('рендерит имя, путь, summary и флаг большого файла', () => {
    const md = renderContextFilesManifest(files)
    expect(md).toContain('## Приложенные к диалогу файлы')
    // имя + путь для read
    expect(md).toContain('**Ленина 48 данные дома.pdf**')
    expect(md).toContain('`/project-attachments/f1`')
    expect(md).toContain('исходные данные жилого дома')
    expect(md).toContain('большой')
    // второй файл без summary/флага
    expect(md).toContain('**план.docx**')
    expect(md).toContain('`/chat-attachments/f2`')
  })

  it('не содержит тел файлов — только метаданные', () => {
    const md = renderContextFilesManifest(files)
    // путь для чтения присутствует, но не содержимое (тело тянет агент тулом read)
    expect(md.split('\n').length).toBeLessThan(8)
  })
})
