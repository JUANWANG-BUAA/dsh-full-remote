/**
 * Optional visual promotion of the sidebar action into its own row.
 *
 * The `sidebar.footer.action` slot renders every footer control into one
 * nowrap flex row. To give the proxy entry a full-width row directly above
 * the other actions (matching the visual weight of the official Settings
 * control), we look for the standard DeepSeek Harness sidebar foot layout — a column
 * flex container whose child is the actions row — and insert a holder row
 * into it. Every unknown layout degrades to the slot's native inline
 * button; nothing else in the host DOM is touched.
 */

const MAX_ANCESTOR_DEPTH = 6
export const HOLDER_ATTRIBUTE = 'data-dsh-reverse-proxy-action-row'

/**
 * Walk up from the slot anchor until a column-flex ancestor is found. The
 * DeepSeek Harness sidebar foot area is a column flex container holding the actions row
 * (and the Settings control) as children; other hosts return null and the
 * action stays inline.
 */
export function findSidebarFootArea(anchor: HTMLElement | null): HTMLElement | null {
  let cursor: HTMLElement | null = anchor
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && cursor !== null; depth++) {
    const parent = cursor.parentElement
    const grandparent = parent?.parentElement ?? null
    if (parent !== null && grandparent !== null && getComputedStyle(grandparent).flexDirection === 'column') {
      return grandparent
    }
    cursor = parent
  }
  return null
}

/** Insert a full-width holder row as the first child of the foot area. */
export function insertSidebarActionRow(foot: HTMLElement): HTMLDivElement {
  const node = document.createElement('div')
  node.setAttribute(HOLDER_ATTRIBUTE, '1')
  foot.insertBefore(node, foot.firstElementChild)
  return node
}
