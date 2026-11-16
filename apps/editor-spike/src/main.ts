import * as crdt from '@stetpad/crdt'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import * as Y from 'yjs'
import { BlockId } from './block-id'
import { Tracked } from './tracked'

/**
 * Three replicas in one page: a "server" document and two editors. Updates are
 * relayed through the server, which is the only replica that compacts. Each
 * editor can be taken offline to create real concurrency.
 */
const server = new Y.Doc()
crdt.insertBlock(server, 0, 'b1', 'The quick brown fox jumps over the lazy dog.')
crdt.insertBlock(server, 1, 'b2', '我们今天去公园散步，天气很好。')

let compacting = false
server.on('update', () => {
  if (compacting) return
  queueMicrotask(() => {
    compacting = true
    try {
      crdt.compact(server)
    } finally {
      compacting = false
    }
  })
})

interface Peer {
  name: string
  doc: Y.Doc
  editor: Editor
  online: boolean
  tracking: boolean
}

function createPeer(name: string, mount: HTMLElement): Peer {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'relay')
  const peer = { name, doc, online: true, tracking: false } as Peer

  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (peer.online && origin !== 'relay') Y.applyUpdate(server, u, peer)
  })
  server.on('update', (u: Uint8Array, origin: unknown) => {
    if (peer.online && origin !== peer) Y.applyUpdate(doc, u, 'relay')
  })

  mount.innerHTML = `
    <h2>${name}</h2>
    <div class="bar">
      <label><input type="checkbox" data-k="tracking" /> 修订模式</label>
      <label><input type="checkbox" data-k="online" checked /> 在线</label>
      <select data-k="view">
        <option value="inline">行内修订</option>
        <option value="revised">只看修改稿</option>
        <option value="original">只看原文</option>
      </select>
      <span data-k="status" class="muted"></span>
    </div>
    <div data-k="editor" data-view="inline"></div>
    <ul class="changes" data-k="changes"></ul>`
  const $ = <T extends HTMLElement>(k: string): T => mount.querySelector<T>(`[data-k="${k}"]`)!

  peer.editor = new Editor({
    element: $('editor'),
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        hardBreak: false,
        trailingNode: false,
        link: false,
      }),
      Collaboration.configure({ document: doc, field: 'content' }),
      BlockId,
      Tracked.configure({ doc, user: () => ({ author: name, tracking: peer.tracking }) }),
    ],
  })

  $<HTMLInputElement>('tracking').onchange = (e) => (peer.tracking = (e.target as HTMLInputElement).checked)
  $<HTMLSelectElement>('view').onchange = (e) =>
    $('editor').setAttribute('data-view', (e.target as HTMLSelectElement).value)
  $<HTMLInputElement>('online').onchange = (e) => {
    peer.online = (e.target as HTMLInputElement).checked
    $('status').textContent = peer.online ? '' : '离线'
    $('status').className = peer.online ? 'muted' : 'offline'
    if (peer.online) {
      Y.applyUpdate(server, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(server)), peer)
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)), 'relay')
    }
  }

  const renderChanges = (): void => {
    const list = $('changes')
    list.innerHTML = ''
    for (const c of crdt.listChanges(doc)) {
      const li = document.createElement('li')
      const what = document.createElement('span')
      what.className = 'what'
      if (c.deleted) what.appendChild(Object.assign(document.createElement('del'), { textContent: c.deleted }))
      if (c.deleted && c.inserted) what.append(' → ')
      if (c.inserted) what.appendChild(Object.assign(document.createElement('ins'), { textContent: c.inserted }))
      const who = Object.assign(document.createElement('span'), { className: 'who', textContent: c.author })
      const yes = Object.assign(document.createElement('button'), { textContent: '接受' })
      const no = Object.assign(document.createElement('button'), { textContent: '拒绝' })
      yes.onclick = () => crdt.decide(doc, c.id, 'accept')
      no.onclick = () => crdt.decide(doc, c.id, 'reject')
      li.append(what, who, yes, no)
      list.appendChild(li)
    }
  }
  doc.on('afterTransaction', () => queueMicrotask(renderChanges))
  renderChanges()
  return peer
}

const ann = createPeer('Ann', document.getElementById('ann')!)
const bob = createPeer('Bob', document.getElementById('bob')!)

// --- simulated agent, working on the server document ---
let baseline: crdt.Baseline | null = null
const aiText = document.getElementById('ai-text') as HTMLTextAreaElement
document.getElementById('ai-read')!.onclick = () => {
  const { $from } = ann.editor.state.selection
  const blockId = $from.node(1)?.attrs.blockId as string | undefined
  baseline = blockId ? crdt.readBlock(server, blockId) : null
  document.getElementById('ai-base')!.textContent = baseline ? `已读取 ${baseline.blockId}` : '没有找到段落'
  aiText.value = baseline?.text ?? ''
}
document.getElementById('ai-propose')!.onclick = () => {
  if (!baseline) return
  const r = crdt.proposeReplace(server, baseline, aiText.value, { author: 'AI', runId: 'run-' + Date.now() })
  document.getElementById('ai-result')!.textContent =
    `应用 ${r.applied.length} 处，未应用 ${r.failed.length} 处` +
    (r.failed.length ? `（${r.failed.map((f) => f.reason).join('；')}）` : '')
}

// For driving the page from tests and the console.
Object.assign(window, { spike: { server, ann, bob, crdt, Y } })
