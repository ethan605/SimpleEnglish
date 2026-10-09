import { parseDocument } from 'yaml';

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function readSkill(markdown, skillPath) {
  if (typeof markdown !== 'string') {
    throw new TypeError('Skill content must be a string');
  }

  const frontmatter = FRONTMATTER.exec(markdown);
  if (!frontmatter) {
    throw new Error('Skill markdown must start with YAML frontmatter');
  }

  const document = parseDocument(frontmatter[1]);
  if (document.errors.length > 0) {
    throw new Error(`Invalid skill YAML frontmatter: ${document.errors.map((error) => error.message).join('; ')}`);
  }

  const metadata = document.toJS();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Skill YAML frontmatter must be a mapping');
  }
  if (metadata.name !== 'simple-english') {
    throw new Error('Skill frontmatter name must be "simple-english"');
  }
  if (typeof metadata.description !== 'string' || metadata.description.trim() === '') {
    throw new Error('Skill frontmatter must have a non-empty description');
  }

  return {
    id: 'simple-english',
    name: metadata.name,
    description: metadata.description,
    path: skillPath,
    content: markdown.slice(frontmatter[0].length),
  };
}
