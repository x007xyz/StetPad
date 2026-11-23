import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import Italic from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import Underline from '@tiptap/extension-underline'
import { Dropcursor, Gapcursor, Placeholder } from '@tiptap/extensions'
import type * as Y from 'yjs'
import { BlockId, BlockKeys, BulletItem, Callout, CodeBlock, Divider, Drawio, Image, OrderedItem, Quote, Table, TaskItem, Video } from './schema'
import { FileBlock } from './file'
import { LinkCard } from './linkcard'
import { InlineMath } from './inlineMath'
import { Footnote, type FootnoteOptions } from './footnotes'
import { Tracked } from './tracked'

export interface EditorExtensionOptions {
  ydoc: Y.Doc
  docId: string
  user: () => { author: string; tracking: boolean }
  placeholder: string
  onError?: (text: string) => void
  caret?: Parameters<typeof CollaborationCaret.configure>[0]
  footnote?: Partial<FootnoteOptions>
}

export function editorExtensions({ ydoc, docId, user, placeholder, caret, footnote, onError }: EditorExtensionOptions) {
  return [
    Document, Text, Paragraph,
    Heading.configure({ levels: [1, 2, 3] }),
    BulletItem, OrderedItem, TaskItem, Quote, Callout, CodeBlock, Divider, Image.configure({ docId, onError }), Video.configure({ docId, onError }), Drawio.configure({ docId }), Table, FileBlock, LinkCard,
    Bold, Italic, Underline, Strike, Code, Highlight, InlineMath,
    Link.configure({ openOnClick: false, autolink: true }),
    Footnote.configure(footnote),
    Dropcursor, Gapcursor,
    Placeholder.configure({ placeholder }),
    Collaboration.configure({ document: ydoc, field: 'content' }),
    ...(caret ? [CollaborationCaret.configure(caret)] : []),
    BlockId, BlockKeys,
    Tracked.configure({ doc: ydoc, user }),
  ]
}
