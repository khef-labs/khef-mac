import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import rehypeStringify from 'rehype-stringify'

export { rehypeSanitize }

export const htmlSanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'img',
    'span',
    'video',
    'source',
  ],
  attributes: {
    ...(defaultSchema.attributes || {}),
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style'],
    video: ['src', 'controls', 'preload', 'poster', 'width', 'height', 'style', 'playsInline'],
    source: ['src', 'type'],
    code: ['className'],
    pre: ['className'],
    span: ['className', 'style'],
    div: ['style'],
    hr: ['style'],
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
  },
}

export const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, htmlSanitizeSchema)
  .use(rehypeHighlight)
  .use(rehypeStringify)

export async function renderMarkdown(content: string): Promise<string> {
  const file = await markdownProcessor.process(content)
  return String(file)
}
