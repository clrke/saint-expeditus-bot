import fs from 'node:fs/promises';
import path from 'node:path';

const MEMORY_FILES = ['residents.md', 'issues.md', 'decisions.md'] as const;
type MemoryFile = (typeof MEMORY_FILES)[number];

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
  memoryDir: string,
): Promise<string> {
  const file = input.file as string;

  if (!MEMORY_FILES.includes(file as MemoryFile)) {
    return `Error: invalid file "${file}". Must be one of: ${MEMORY_FILES.join(', ')}`;
  }

  const filePath = path.join(memoryDir, file);

  if (name === 'read_memory') {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return '(empty — no information stored yet)';
    }
  }

  if (name === 'write_memory') {
    const content = input.content as string;
    if (content.length > 50_000) {
      return 'Error: content too large (>50KB). Summarize before writing.';
    }
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return 'Memory updated successfully.';
  }

  return `Unknown tool: ${name}`;
}
