import { Node, type NodeViewRenderer } from '@tiptap/core'
import { post } from '../api'

/**
 * A link card: the title, description and picture of a web page, as a horizontal
 * card that links to it. The picture is stored on the server (`/files/<id>`), so
 * the card does not depend on the page's own server.
 */

export interface LinkCardAttrs {
  url: string
  title: string
  description: string
  /** `/files/<id>` or '' */
  image: string
  site: string
}

const FILE_SRC = /^\/files\/[\w-]+$/
const WEB_URL = /^https?:\/\//i

/** Asks the server for the preview of a page. Rejects with the server's message. */
export function unfurlLink(docId: string, url: string): Promise<LinkCardAttrs> {
  return post<LinkCardAttrs>(`/docs/${docId}/unfurl`, { url })
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The card's markup and state, shared by the node view and the copy/paste form. */
function card(attrs: Record<string, unknown>): { url: string; title: string; description: string; site: string; image: string } {
  const url = str(attrs.url)
  return {
    url: WEB_URL.test(url) ? url : '',
    title: str(attrs.title) || url,
    description: str(attrs.description),
    site: str(attrs.site),
    image: FILE_SRC.test(str(attrs.image)) ? str(attrs.image) : '',
  }
}

/** A card as one link element; the picture sits on the right when there is one. */
export const linkCardNodeView: NodeViewRenderer = ({ node }) => {
  let current = node
  const dom = document.createElement('div')
  dom.className = 'blk link-card-wrap'
  const link = document.createElement('a')
  link.className = 'link-card'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  const body = document.createElement('span')
  body.className = 'link-card-body'
  const title = document.createElement('strong')
  const desc = document.createElement('span')
  desc.className = 'link-card-desc'
  const site = document.createElement('small')
  body.append(title, desc, site)
  const pic = document.createElement('img')
  pic.alt = ''
  pic.draggable = false
  link.append(body, pic)
  dom.append(link)

  const paint = (): void => {
    const c = card(current.attrs)
    const blockId = current.attrs.blockId as string | null | undefined
    if (blockId) dom.setAttribute('data-block-id', String(blockId))
    else dom.removeAttribute('data-block-id')
    if (c.url) link.href = c.url
    else link.removeAttribute('href')
    title.textContent = c.title
    desc.textContent = c.description
    desc.hidden = !c.description
    site.textContent = c.site
    site.hidden = !c.site
    if (c.image) pic.setAttribute('src', c.image)
    else pic.removeAttribute('src')
    pic.hidden = !c.image
  }
  paint()
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false
      current = next
      paint()
      return true
    },
    selectNode() {
      dom.classList.add('selected')
    },
    deselectNode() {
      dom.classList.remove('selected')
    },
    // A click on the card follows the link; the block is selected from its handle or the keyboard.
    stopEvent: (e) => (e.target as HTMLElement | null)?.closest?.('a') != null,
    ignoreMutation: () => true,
  }
}

export const LinkCard = Node.create({
  name: 'linkCard',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    url: { default: '' },
    title: { default: '' },
    description: { default: '' },
    image: { default: '' },
    site: { default: '' },
  }),
  parseHTML: () => [
    {
      tag: 'a.link-card[data-url]',
      getAttrs: (el: HTMLElement) => {
        const url = el.getAttribute('data-url') ?? ''
        if (!WEB_URL.test(url)) return false
        return {
          url,
          title: el.querySelector('strong')?.textContent?.trim() ?? '',
          description: el.querySelector('.link-card-desc')?.textContent?.trim() ?? '',
          site: el.querySelector('small')?.textContent?.trim() ?? '',
          image: el.getAttribute('data-image') ?? '',
        }
      },
    },
  ],
  renderHTML({ node }) {
    const c = card(node.attrs)
    const attrs: Record<string, string> = { class: 'blk link-card', 'data-url': c.url, 'data-image': c.image }
    if (c.url) {
      attrs.href = c.url
      attrs.target = '_blank'
      attrs.rel = 'noopener noreferrer'
    }
    const body = ['span', { class: 'link-card-body' }, ['strong', {}, c.title], ['span', { class: 'link-card-desc' }, c.description], ['small', {}, c.site]]
    return c.image ? ['a', attrs, body, ['img', { src: c.image, alt: '' }]] : ['a', attrs, body]
  },
  addNodeView() {
    return linkCardNodeView
  },
})
